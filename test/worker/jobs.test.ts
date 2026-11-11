/**
 * The durable queue (Phase 28b Task 3): `jobs` and `instances`, the claim, the
 * busy guard, and the host key.
 *
 * Every job here is PINNED to an instance id made up for the test, and every
 * claim names that pin: a claim takes only jobs pinned exactly as it asks, so
 * no runner of another file — the in-process services claim only their own
 * pins, and nothing in this file claims the unpinned pool — can take one of
 * these jobs, and nothing here can take theirs.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, instances, jobs } from "../../src/db/schema.js";
import { ServiceError } from "../../src/api/errors.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { EXTRACTION_VERSION } from "../../src/crawl/versions.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import {
  claimNextJob,
  enqueueJob,
  finishJob,
  withPinnedJob,
} from "../../src/worker/jobs.js";
import { heartbeat, registerInstance } from "../../src/worker/instance.js";
import { DEFAULT_TIMING, timingWith } from "../../src/worker/timing.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
const createdCrawls: string[] = [];
const createdInstances: string[] = [];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  if (createdInstances.length > 0) await db.delete(instances).where(inArray(instances.id, createdInstances));
  await closeDb(db);
});

async function seedCrawl(status = "queued"): Promise<string> {
  const id = `crawl_jobs_${randomUUID()}`;
  const siteUrl = "https://jobs-test.example/";
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl,
    hostKey: hostKeyOf(siteUrl),
    config: { siteUrl },
    rulesetVersion: RULESET_VERSION,
    status,
  });
  createdCrawls.push(id);
  return id;
}

/** A pin no live process holds: the test's own runner. */
const pin = (): string => `test-pin-${randomUUID()}`;

async function jobRow(id: string): Promise<typeof jobs.$inferSelect> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
}

async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ServiceError)) {
    throw new Error(`expected a ServiceError, got ${outcome === null ? "success" : String(outcome)}`);
  }
  return outcome;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("enqueueJob", () => {
  it("writes a queued job stamped with the running code's ruleset and extraction versions", async () => {
    const crawlId = await seedCrawl();
    const pinnedTo = pin();
    const id = await db.transaction((tx) => enqueueJob(tx, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo }));
    const row = await jobRow(id);
    expect(row).toMatchObject({
      tenantId: "local",
      crawlId,
      kind: "crawl",
      status: "queued",
      pinnedTo,
      claimedBy: null,
      claimedAt: null,
      finishedAt: null,
      error: null,
      rulesetVersion: RULESET_VERSION,
      extractionVersion: EXTRACTION_VERSION,
    });
  });

  it("refuses a second live job for one crawl with the sentence the old in-process guard gave", async () => {
    const crawlId = await seedCrawl();
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: pin() });
    const second = await refusal(enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: pin() }));
    expect(second.code).toBe("CONFLICT");
    expect(second.message).toContain(`crawl ${crawlId} is already held by this server`);
    const live = await db.select().from(jobs).where(eq(jobs.crawlId, crawlId));
    expect(live).toHaveLength(1);
  });

  it("refuses a crawl job while a rules job runs, as crawl_resume always was", async () => {
    const crawlId = await seedCrawl("finished");
    const instanceId = pin();
    const hold = deferred();
    const entered = deferred();
    const running = withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "rules", instanceId }, async () => {
      entered.resolve();
      await hold.promise;
      return "judged";
    });
    await entered.promise;
    try {
      const err = await refusal(enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl" }));
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toBe(
        `crawl_resume is refused for crawl ${crawlId}: rules are running on this server, and ` +
          "neither can be interrupted. Wait for it to answer, then ask again",
      );
    } finally {
      hold.resolve();
    }
    expect(await running).toBe("judged");
  });
});

describe("claimNextJob", () => {
  it("gives one job to exactly one of two racing claims", async () => {
    const crawlId = await seedCrawl();
    const pinnedTo = pin();
    const id = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo });
    const claims = await Promise.all(
      ["runner-a", "runner-b", "runner-c", "runner-d"].map((instanceId) =>
        claimNextJob(db, { instanceId, kinds: ["crawl"], pinnedTo }),
      ),
    );
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ id, crawlId, kind: "crawl", tenant: "local", pinnedTo });
    const row = await jobRow(id);
    expect(row.status).toBe("running");
    expect(row.claimedBy).toBe(won[0]!.claimedBy);
    expect(row.claimedAt).not.toBeNull();
    expect(row.heartbeatAt).not.toBeNull();
  });

  it("never claims a job another ruleset or extraction version enqueued", async () => {
    const pinnedTo = pin();
    const stale: string[] = [];
    for (const versions of [
      { rulesetVersion: "0.0.0-older", extractionVersion: EXTRACTION_VERSION },
      { rulesetVersion: RULESET_VERSION, extractionVersion: EXTRACTION_VERSION - 1 },
    ]) {
      const crawlId = await seedCrawl();
      const id = `job_${randomUUID()}`;
      await db.insert(jobs).values({
        id,
        tenantId: LOCAL_TENANT,
        crawlId,
        kind: "crawl",
        status: "queued",
        pinnedTo,
        ...versions,
      });
      stale.push(id);
    }
    expect(await claimNextJob(db, { instanceId: "runner-v", kinds: ["crawl"], pinnedTo })).toBeNull();
    for (const id of stale) expect((await jobRow(id)).status).toBe("queued");
  });

  it("claims only the kinds it asks for, only jobs pinned as it asks, and in queued_at order", async () => {
    const pinnedTo = pin();
    const rulesCrawl = await seedCrawl("finished");
    const rulesJob = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: rulesCrawl, kind: "rules", pinnedTo });
    const elsewhere = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "crawl", pinnedTo: pin() });
    const first = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "crawl", pinnedTo });
    const second = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "crawl", pinnedTo });

    const a = await claimNextJob(db, { instanceId: "runner-o", kinds: ["crawl"], pinnedTo });
    const b = await claimNextJob(db, { instanceId: "runner-o", kinds: ["crawl"], pinnedTo });
    const c = await claimNextJob(db, { instanceId: "runner-o", kinds: ["crawl"], pinnedTo });
    expect([a?.id, b?.id, c]).toEqual([first, second, null]);
    expect((await jobRow(rulesJob)).status).toBe("queued");
    expect((await jobRow(elsewhere)).status).toBe("queued");
  });
});

describe("finishJob", () => {
  it("settles a running job once; a settled job is left as it stands; an unknown one throws", async () => {
    const pinnedTo = pin();
    const id = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "crawl", pinnedTo });
    await claimNextJob(db, { instanceId: "runner-f", kinds: ["crawl"], pinnedTo });
    await finishJob(db, id, "failed", "robots.txt unreachable");
    const failed = await jobRow(id);
    expect(failed).toMatchObject({ status: "failed", error: "robots.txt unreachable" });
    expect(failed.finishedAt).not.toBeNull();

    await finishJob(db, id, "done");
    expect(await jobRow(id)).toMatchObject({ status: "failed", error: "robots.txt unreachable" });

    await expect(finishJob(db, `job_${randomUUID()}`, "done")).rejects.toThrow(/no job/);
  });
});

describe("withPinnedJob", () => {
  it("holds a running job pinned to the instance while it runs, then marks it done", async () => {
    const crawlId = await seedCrawl("finished");
    const instanceId = pin();
    let during: typeof jobs.$inferSelect | undefined;
    const result = await withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "render", instanceId }, async () => {
      [during] = await db.select().from(jobs).where(eq(jobs.crawlId, crawlId));
      return 7;
    });
    expect(result).toBe(7);
    expect(during).toMatchObject({ kind: "render", status: "running", pinnedTo: instanceId, claimedBy: instanceId });
    expect(await jobRow(during!.id)).toMatchObject({ status: "done", error: null });
  });

  it("marks the job failed with the error's first line, and rethrows it", async () => {
    const crawlId = await seedCrawl("finished");
    const boom = new Error("the run fell over\n    at somewhere (stack.ts:1)");
    await expect(
      withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "rules", instanceId: pin() }, () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    const [row] = await db.select().from(jobs).where(eq(jobs.crawlId, crawlId));
    expect(row).toMatchObject({ status: "failed", error: "the run fell over" });
  });

  it("refuses a second rules run with the 409 sentence crawl_rules always gave, and runs nothing", async () => {
    const crawlId = await seedCrawl("finished");
    const hold = deferred();
    const entered = deferred();
    const first = withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "rules", instanceId: pin() }, async () => {
      entered.resolve();
      await hold.promise;
    });
    await entered.promise;
    let ran = false;
    try {
      const err = await refusal(
        withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "rules", instanceId: pin() }, async () => {
          ran = true;
        }),
      );
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toBe(
        `crawl ${crawlId} is already being judged by this server: a rules run rewrites ` +
          `the crawl's issues, so two runs would leave the table holding half of each. ` +
          `Wait for the run in flight and read its summary, or ask again when it ends`,
      );
      const second = await refusal(
        withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "render", instanceId: pin() }, async () => {
          ran = true;
        }),
      );
      expect(second.message).toBe(
        `crawl_render is refused for crawl ${crawlId}: rules are running on this server, and ` +
          "neither can be interrupted. Wait for it to answer, then ask again",
      );
    } finally {
      hold.resolve();
    }
    await first;
    expect(ran).toBe(false);
  });
});

describe("instances", () => {
  it("registers a process and heartbeats it and its running jobs", async () => {
    const instanceId = await registerInstance(db, "worker");
    createdInstances.push(instanceId);
    const [row] = await db.select().from(instances).where(eq(instances.id, instanceId));
    expect(row).toMatchObject({ role: "worker", pid: process.pid });
    expect(row!.hostname.length).toBeGreaterThan(0);
    expect(row!.version.length).toBeGreaterThan(0);

    const pinnedTo = pin();
    const id = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "crawl", pinnedTo });
    await claimNextJob(db, { instanceId, kinds: ["crawl"], pinnedTo });
    await db.execute(sql`update instances set heartbeat_at = now() - interval '1 hour' where id = ${instanceId}`);
    await db.execute(sql`update jobs set heartbeat_at = now() - interval '1 hour' where id = ${id}`);

    await heartbeat(db, instanceId, [id]);
    const [after] = await db.select().from(instances).where(eq(instances.id, instanceId));
    const job = await jobRow(id);
    expect(Date.now() - after!.heartbeatAt.getTime()).toBeLessThan(60_000);
    expect(Date.now() - job.heartbeatAt!.getTime()).toBeLessThan(60_000);
    await finishJob(db, id, "done");
  });

  it("refuses to heartbeat an instance whose row is gone", async () => {
    await expect(heartbeat(db, `instance_${randomUUID()}`, [])).rejects.toThrow(/no instance/);
  });
});

describe("timing", () => {
  it("defaults to 10 s heartbeats, dead after 60 s, a 30 s reaper and a day's retention", () => {
    expect(DEFAULT_TIMING).toMatchObject({
      heartbeat: 10_000,
      deadAfter: 60_000,
      reapEvery: 30_000,
      instanceRetention: 86_400_000,
    });
    expect(timingWith({ heartbeat: 50, deadAfter: 300, reapEvery: 100 })).toMatchObject({
      heartbeat: 50,
      deadAfter: 300,
      reapEvery: 100,
    });
    expect(() => timingWith({ heartbeat: 0 })).toThrow(/timing.heartbeat/);
    expect(() => timingWith({ heartbeat: 500, deadAfter: 400 })).toThrow(/timing.deadAfter/);
  });
});

describe("crawls.host_key", () => {
  it("is the seed host lower-cased without a leading www., in code and in migration 0040's backfill alike", async () => {
    const cases: [string, string][] = [
      ["https://WWW.Example.COM/shop", "example.com"],
      ["http://www.a.test:8080/", "a.test"],
      ["https://shop.example.com/", "shop.example.com"],
      ["http://127.0.0.1:5555/", "127.0.0.1"],
      ["http://[::1]:8080/x", "[::1]"],
      ["https://user:pw@www.b.test/", "b.test"],
      ["https://wwwx.c.test/", "wwwx.c.test"],
    ];
    const file = readFileSync(new URL("../../drizzle/0040_jobs_instances.sql", import.meta.url), "utf8");
    const match = /SET "host_key" = ([\s\S]*?) WHERE "host_key" IS NULL/.exec(file);
    if (match === null) throw new Error("migration 0040 no longer backfills host_key the way this test reads it");
    const expression = match[1]!.replaceAll('"site_url"', "v.site_url");
    for (const [url, key] of cases) {
      expect(hostKeyOf(url), url).toBe(key);
      const result = await db.execute(
        sql`select ${sql.raw(expression)} as k from (select ${url}::text as site_url) v`,
      );
      expect((result.rows[0] as { k: string }).k, `backfill of ${url}`).toBe(key);
    }
  });
});

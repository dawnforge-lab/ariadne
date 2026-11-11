/**
 * The durable queue (Phase 28b Task 3): `jobs` and `instances`, the claim, the
 * busy guard, and the host key.
 *
 * Every job here is PINNED to an instance id made up for the test, and every
 * claim names that pin: a claim takes only jobs pinned exactly as it asks, so
 * no runner of another file — the in-process services claim only their own
 * pins, and nothing in this file claims the unpinned pool — can take one of
 * these jobs, and nothing here can take theirs. (The unpinned pool's own
 * fairness, the per-tenant cap, is tested in test/worker/runner.test.ts, the
 * one file that claims it.)
 *
 * Task 4a: fair claims — one running crawl or render job per host, pinned or
 * not; a tenant-scoped queue position; `HOST_BUSY` for a synchronous render.
 * So every seeded crawl has a HOST OF ITS OWN unless a test names one: two of
 * this file's crawls on one host would wait on each other — and on any other
 * file's crawl of that host.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, instances, jobs } from "../../src/db/schema.js";
import { ServiceError } from "../../src/api/errors.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { EXTRACTION_VERSION } from "../../src/crawl/versions.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { LOCAL_TENANT, parseTenant, type TenantId } from "../../src/tenant.js";
import {
  claimNextJob,
  enqueueJob,
  finishJob,
  JobBusyError,
  liveJobOf,
  queuePositionOf,
  withPinnedJob,
  type ClaimedJob,
} from "../../src/worker/jobs.js";
import { JobRunner, parseTenantMaxRunning } from "../../src/worker/runner.js";
import { heartbeat, registerInstance, stopInstance } from "../../src/worker/instance.js";
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

async function seedCrawl(
  status = "queued",
  siteUrl = `https://jobs-${randomUUID()}.example/`,
  tenant: TenantId = LOCAL_TENANT,
): Promise<string> {
  const id = `crawl_jobs_${randomUUID()}`;
  await db.insert(crawls).values({
    tenantId: tenant,
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
  // [site URL, host key]: the host lower-cased without a leading `www.`, plus
  // the port when the URL names one that is not its scheme's default (R8).
  const cases: [string, string][] = [
    ["https://WWW.Example.COM/shop", "example.com"],
    ["http://www.a.test:8080/", "a.test:8080"],
    ["https://shop.example.com/", "shop.example.com"],
    ["http://127.0.0.1:5555/", "127.0.0.1:5555"],
    ["http://[::1]:8080/x", "[::1]:8080"],
    ["http://[::1]/x", "[::1]"],
    ["https://user:pw@www.b.test/", "b.test"],
    ["https://user:pw@www.b.test:8443/", "b.test:8443"],
    ["https://wwwx.c.test/", "wwwx.c.test"],
    // A scheme's default port, named or not, is no port.
    ["https://x.com:443/", "x.com"],
    ["http://x.com:80/", "x.com"],
    ["HTTP://X.COM:80/", "x.com"],
    ["http://x.com:0080/", "x.com"],
    ["http://x.com:/", "x.com"],
    // The other scheme's default is a port like any other.
    ["http://x.com:443/", "x.com:443"],
    ["https://x.com:80/", "x.com:80"],
    ["https://x.com:08443?q=1", "x.com:8443"],
    ["https://x.com:8443#top", "x.com:8443"],
    // A trailing dot is kept, in code and in SQL alike (`hostKeyOf` does not
    // strip it, and neither does the frontier's same-origin test).
    ["https://example.com./", "example.com."],
    ["https://example.com.:8443/", "example.com.:8443"],
  ];

  it("is the seed host lower-cased without a leading www., plus a non-default port (R8)", () => {
    for (const [url, key] of cases) expect(hostKeyOf(url), url).toBe(key);
  });

  it("is what migration 0040's backfill then 0042's port suffix compute in SQL, case for case", async () => {
    const m40 = readFileSync(new URL("../../drizzle/0040_jobs_instances.sql", import.meta.url), "utf8");
    const backfill = /SET "host_key" = ([\s\S]*?) WHERE "host_key" IS NULL/.exec(m40);
    if (backfill === null) throw new Error("migration 0040 no longer backfills host_key the way this test reads it");
    const m42 = readFileSync(new URL("../../drizzle/0042_host_key_port.sql", import.meta.url), "utf8");
    const port = /SELECT "id", ([\s\S]*?) AS "port_suffix" FROM "crawls"/.exec(m42);
    if (port === null) throw new Error("migration 0042 no longer computes the port suffix the way this test reads it");
    const key40 = backfill[1]!.replaceAll('"site_url"', "v.site_url");
    const suffix42 = port[1]!.replaceAll('"site_url"', "v.site_url");
    for (const [url, key] of cases) {
      // A row older than R8 carries the port-less key (0040's backfill, or the
      // `hostKeyOf` of its day); 0042 appends the port where the URL names one.
      const result = await db.execute(sql`
        select w.k || coalesce(w.s, '') as k
          from (select ${sql.raw(key40)} as k, ${sql.raw(suffix42)} as s
                  from (select ${url}::text as site_url) v) w`);
      expect((result.rows[0] as { k: string }).k, `0040 + 0042 over ${url}`).toBe(key);
    }
  });
});

describe("liveness decides held (Ruling R10)", () => {
  const deadAfter = 60_000;

  async function instanceAt(ageMs: number): Promise<string> {
    const id = await registerInstance(db, "all");
    createdInstances.push(id);
    await db.execute(
      sql`update instances set heartbeat_at = now() - (${ageMs}::int * interval '1 millisecond') where id = ${id}`,
    );
    return id;
  }

  it("counts a queued job as held only while the instance it is pinned to is live", async () => {
    const fresh = await instanceAt(0);
    const crawlId = await seedCrawl();
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: fresh });
    expect(await queuePositionOf(db, crawlId, deadAfter)).toBe(1);
    expect((await liveJobOf(db, crawlId, deadAfter))?.live).toBe(true);

    // Stopped (a graceful shutdown): not live from that moment.
    await stopInstance(db, fresh);
    expect(await queuePositionOf(db, crawlId, deadAfter)).toBeNull();
    expect(await liveJobOf(db, crawlId, deadAfter)).toMatchObject({ status: "queued", pinnedTo: fresh, live: false });
    await expect(heartbeat(db, fresh, [])).rejects.toThrow(/still running/);
  });

  it("calls an instance silent for longer than deadAfter dead, one inside it live, and a heartbeat revives it", async () => {
    const silent = await instanceAt(deadAfter + 5_000);
    const crawlId = await seedCrawl();
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: silent });
    expect(await queuePositionOf(db, crawlId, deadAfter)).toBeNull();

    const recent = await instanceAt(deadAfter - 10_000);
    const other = await seedCrawl();
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: other, kind: "crawl", pinnedTo: recent });
    expect(await queuePositionOf(db, other, deadAfter)).toBe(1);

    await heartbeat(db, silent, []);
    expect(await queuePositionOf(db, crawlId, deadAfter)).toBe(1);
  });

  it("holds a running job by the instance that claimed it", async () => {
    const claimer = await instanceAt(0);
    const pinnedTo = pin();
    const crawlId = await seedCrawl();
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo });
    await claimNextJob(db, { instanceId: claimer, kinds: ["crawl"], pinnedTo });
    expect(await queuePositionOf(db, crawlId, deadAfter)).toBe(0);
    await stopInstance(db, claimer);
    expect(await queuePositionOf(db, crawlId, deadAfter)).toBeNull();
    expect((await liveJobOf(db, crawlId, deadAfter))?.live).toBe(false);
  });
});

describe("fair claims (28b T4a)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function until<T>(what: string, read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${JSON.stringify(value)})`);
      await sleep(10);
    }
  }

  /** A pinned runner over fake crawl work that ends when the test says. */
  function heldRunner(pinnedTo: string, release: Map<string, () => void>): JobRunner {
    return new JobRunner(db, {
      instanceId: `${pinnedTo}-runner-${randomUUID()}`,
      kinds: ["crawl"],
      pinnedTo,
      concurrency: 1,
      heartbeat: false,
      log: () => {},
      timing: { claimPoll: 20 },
      execute: (job: ClaimedJob, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          release.set(job.id, resolve);
          signal.addEventListener("abort", () => resolve());
        }),
    });
  }

  const sorted = (ids: readonly string[]): string[] => [...ids].sort();

  it("two crawls of one host never run at once: with a.test twice and b.test once queued, two runners run a.test's first and b.test, and a.test's second waits for the first to finish", async () => {
    const pinnedTo = pin();
    const a = `https://a-${randomUUID()}.test/`;
    const b = `https://b-${randomUUID()}.test/`;
    const a1 = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", a), kind: "crawl", pinnedTo });
    const a2 = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", a), kind: "crawl", pinnedTo });
    const b1 = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", b), kind: "crawl", pinnedTo });
    const release = new Map<string, () => void>();
    const runners = [heldRunner(pinnedTo, release), heldRunner(pinnedTo, release)];
    const running = (): string[] => sorted(runners.flatMap((r) => r.runningJobIds()));
    for (const runner of runners) runner.start();
    try {
      await until("a.test's first and b.test running", running, (ids) => ids.join() === sorted([a1, b1]).join());
      // Many claim polls later, a.test's second still waits: its host is busy.
      await sleep(200);
      expect(running()).toEqual(sorted([a1, b1]));
      expect((await jobRow(a2)).status).toBe("queued");

      release.get(a1)!();
      await until("a.test's second running", running, (ids) => ids.join() === sorted([a2, b1]).join());
      expect((await jobRow(a1)).status).toBe("done");
    } finally {
      await Promise.all(runners.map((r) => r.stop()));
    }
  });

  it("racing claims over queued crawls of one host start exactly one of them", async () => {
    for (let round = 0; round < 5; round += 1) {
      const pinnedTo = pin();
      const site = `https://race-${randomUUID()}.test/`;
      for (let i = 0; i < 3; i += 1) {
        await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", site), kind: "crawl", pinnedTo });
      }
      const claims = await Promise.all(
        Array.from({ length: 6 }, (_, i) => claimNextJob(db, { instanceId: `racer-${i}`, kinds: ["crawl"], pinnedTo })),
      );
      expect(claims.filter((c) => c !== null), `round ${round}`).toHaveLength(1);
    }
  });

  it("two crawls of 127.0.0.1 on two ports run at once; two of one 127.0.0.1:port take turns (R8)", async () => {
    // Two ports nobody else can be serving while this test holds them.
    const servers: Server[] = [createServer(), createServer()];
    const ports: number[] = [];
    for (const server of servers) {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("bound oddly");
      ports.push(address.port);
    }
    // Settled before the ports are let go: a job left running would hold
    // 127.0.0.1:<port> for any other file's fixture server that binds it next.
    const claimed: string[] = [];
    try {
      const pinnedTo = pin();
      const one = `http://127.0.0.1:${ports[0]}/`;
      const two = `http://127.0.0.1:${ports[1]}/`;
      const one1 = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", one), kind: "crawl", pinnedTo });
      const one2 = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", one), kind: "crawl", pinnedTo });
      const two1 = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", two), kind: "crawl", pinnedTo });
      const claim = async (): Promise<ClaimedJob | null> => {
        const job = await claimNextJob(db, { instanceId: "runner-ports", kinds: ["crawl"], pinnedTo });
        if (job !== null) claimed.push(job.id);
        return job;
      };
      expect((await claim())?.id).toBe(one1);
      expect((await claim())?.id).toBe(two1);
      expect(await claim()).toBeNull();
      await finishJob(db, one1, "done");
      expect((await claim())?.id).toBe(one2);
    } finally {
      for (const id of claimed) await finishJob(db, id, "done");
      for (const server of servers) await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a render pass holds its host: a crawl of that host is not claimed until it ends, and a rules job of that host is", async () => {
    const site = `https://render-held-${randomUUID()}.test/`;
    const pinnedTo = pin();
    const hold = deferred();
    const entered = deferred();
    const rendering = withPinnedJob(
      db,
      { tenant: LOCAL_TENANT, crawlId: await seedCrawl("finished", site), kind: "render", instanceId: pin() },
      async () => {
        entered.resolve();
        await hold.promise;
      },
    );
    await entered.promise;
    try {
      const crawlJob = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("queued", site), kind: "crawl", pinnedTo });
      // Rules fetch nothing: a busy host does not hold them.
      const rulesJob = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl("finished", site), kind: "rules", pinnedTo });
      expect((await claimNextJob(db, { instanceId: "runner-r", kinds: ["crawl", "rules"], pinnedTo }))?.id).toBe(rulesJob);
      expect(await claimNextJob(db, { instanceId: "runner-r", kinds: ["crawl", "rules"], pinnedTo })).toBeNull();
      hold.resolve();
      await rendering;
      expect((await claimNextJob(db, { instanceId: "runner-r", kinds: ["crawl"], pinnedTo }))?.id).toBe(crawlJob);
    } finally {
      hold.resolve();
    }
  });

  it("refuses a render HOST_BUSY while another crawl of its host runs — any tenant's — naming the host key and nothing of that crawl", async () => {
    const host = `busy-${randomUUID()}.test`;
    const site = `http://${host}:8080/`;
    const other = parseTenant(`t-other-${randomUUID().slice(0, 8)}`);
    const pinnedTo = pin();
    const theirs = await seedCrawl("running", site, other);
    await enqueueJob(db, { tenant: other, crawlId: theirs, kind: "crawl", pinnedTo });
    expect((await claimNextJob(db, { instanceId: "runner-h", kinds: ["crawl"], pinnedTo }))?.crawlId).toBe(theirs);

    const mine = await seedCrawl("finished", site);
    let ran = false;
    const err = await refusal(
      withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId: mine, kind: "render", instanceId: pin() }, async () => {
        ran = true;
      }),
    );
    expect(err.code).toBe("HOST_BUSY");
    expect(err.message).toBe(
      `crawl_render is refused for crawl ${mine}: ${host}:8080 is being crawled or rendered by ` +
        "another job, and two at once would together break the site's politeness limits. " +
        "Wait for it to end, then ask again",
    );
    expect(err.message).not.toContain(theirs);
    expect(err.message).not.toContain(other);
    expect(ran).toBe(false);
    expect(await db.select().from(jobs).where(eq(jobs.crawlId, mine))).toEqual([]);

    // A rules run fetches nothing: the busy host does not refuse it.
    expect(
      await withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId: mine, kind: "rules", instanceId: pin() }, async () => "judged"),
    ).toBe("judged");
  });

  it("a render of a crawl whose OWN crawl job runs is the busy guard's refusal, not HOST_BUSY", async () => {
    const pinnedTo = pin();
    const crawlId = await seedCrawl("running");
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo });
    await claimNextJob(db, { instanceId: "runner-own", kinds: ["crawl"], pinnedTo });
    const err = await refusal(
      withPinnedJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "render", instanceId: pin() }, async () => {}),
    );
    expect(err).toBeInstanceOf(JobBusyError);
    expect(err.code).toBe("CONFLICT");
  });

  it("a queue position counts only the caller's tenant's crawls ahead (R12)", async () => {
    const live = await registerInstance(db, "all");
    createdInstances.push(live);
    const t1 = parseTenant(`t1-${randomUUID().slice(0, 8)}`);
    const t2 = parseTenant(`t2-${randomUUID().slice(0, 8)}`);
    const queue: string[] = [];
    for (const tenant of [t1, t2, t2, t1]) {
      const crawlId = await seedCrawl("queued", undefined, tenant);
      await enqueueJob(db, { tenant, crawlId, kind: "crawl", pinnedTo: live });
      queue.push(crawlId);
    }
    const positions = await Promise.all(queue.map((crawlId) => queuePositionOf(db, crawlId, 60_000)));
    // t1's second job is second in t1's queue, not fourth in everybody's.
    expect(positions).toEqual([1, 1, 2, 2]);
    await stopInstance(db, live);
  });

  it("the tenant cap is the unpinned pool's: pinned claims of one tenant run side by side, and a pinned runner refuses a cap", async () => {
    const pinnedTo = pin();
    const first = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "crawl", pinnedTo });
    const second = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "crawl", pinnedTo });
    expect((await claimNextJob(db, { instanceId: "runner-p", kinds: ["crawl"], pinnedTo }))?.id).toBe(first);
    expect((await claimNextJob(db, { instanceId: "runner-p", kinds: ["crawl"], pinnedTo }))?.id).toBe(second);
    expect(
      () =>
        new JobRunner(db, {
          instanceId: pinnedTo,
          kinds: ["crawl"],
          pinnedTo,
          concurrency: 1,
          maxRunningPerTenant: 1,
          execute: async () => {},
        }),
    ).toThrow(/maxRunningPerTenant applies only to the unpinned pool/);
    expect(
      () => new JobRunner(db, { instanceId: pinnedTo, kinds: ["crawl"], pinnedTo: null, concurrency: 1, execute: async () => {} }),
    ).toThrow(/maxRunningPerTenant/);
    // Refused before any statement: an unpinned claim says how many a tenant may run.
    await expect(claimNextJob(db, { instanceId: "runner-p", kinds: ["crawl"], pinnedTo: null })).rejects.toThrow(
      /maxRunningPerTenant/,
    );
  });

  it("ARIADNE_TENANT_MAX_RUNNING is a positive whole number, 1 when unset", () => {
    expect(parseTenantMaxRunning(undefined)).toBe(1);
    expect(parseTenantMaxRunning("1")).toBe(1);
    expect(parseTenantMaxRunning("4")).toBe(4);
    for (const bad of ["", "0", "-1", "1.5", "two", " 2", "2 ", "1e3", "01"]) {
      expect(() => parseTenantMaxRunning(bad), JSON.stringify(bad)).toThrow(/ARIADNE_TENANT_MAX_RUNNING/);
    }
  });
});

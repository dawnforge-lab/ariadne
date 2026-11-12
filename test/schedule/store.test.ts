/**
 * Phase 28c Task 3: the schedules store (src/schedule/store.ts), the shared
 * crawl insert (`insertCrawl`, src/crawl/insert-crawl.ts) and what migrations
 * 0047/0048 add around them.
 *
 *  - Every store function is tenant-filtered in SQL: another tenant's schedule
 *    is missing, to read, list, update and delete alike.
 *  - `insertCrawl` writes the crawl row, its credentials, `list_urls` and the
 *    crawl job in the caller's transaction, and — for a fired crawl — the
 *    `schedule_id` and `schedule_chain` the scheduler gives it.
 *  - The event triggers fill `schedule_id` from `crawls.schedule_id`, on the
 *    crawl's events and its jobs' (Ruling P3).
 *  - Deleting a schedule deletes its own fire and skip events and its
 *    credentials, and keeps its fired crawls and their history with
 *    `schedule_id` nulled (Ruling P2).
 *
 * Every crawl job here is pinned to an instance id no process registers, so no
 * runner of another suite claims it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawlEvents, crawls, jobs, listUrls, scheduleCredentials, schedules } from "../../src/db/schema.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import type { CrawlCredentials } from "../../src/crawl/credentials.js";
import { insertCrawl, type StoredConfig } from "../../src/crawl/insert-crawl.js";
import { storableConfig } from "../../src/crawl/loop.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import type { JudgementBlock } from "../../src/rules/judgement.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { recordEvent } from "../../src/events/events.js";
import { enqueueJob, finishJob } from "../../src/worker/jobs.js";
import {
  deleteSchedule,
  getSchedule,
  insertSchedule,
  listSchedules,
  newScheduleId,
  updateSchedule,
  type NewSchedule,
} from "../../src/schedule/store.js";
import { LOCAL_TENANT, parseTenant, type TenantId } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let vault: CredentialVault;
const createdSchedules: string[] = [];
const createdCrawls: string[] = [];
/** An instance id no process registers: a job pinned to it is never claimed. */
const PIN = `test-schedule-store-${randomUUID()}`;
const CREDS: CrawlCredentials = { requestHeaders: { "X-Store-Key": "store-S3CRET" } };

function configFor(siteUrl: string): StoredConfig {
  return storableConfig({
    siteUrl,
    maxPages: 10,
    maxDepth: 3,
    userAgent: "AriadneBot-store-test",
    perHostDelayMs: 0,
    maxConcurrency: 1,
  });
}

function scheduleOf(tenant: TenantId, fields: Partial<NewSchedule> = {}): NewSchedule {
  const siteUrl = `https://schedule-${randomUUID()}.example/`;
  return {
    id: newScheduleId(),
    tenant,
    siteUrl,
    crawl: { config: configFor(siteUrl), judgement: null, listed: null },
    render: null,
    cron: "0 3 * * *",
    timezone: "UTC",
    enabled: true,
    nextRunAt: new Date("2026-11-13T03:00:00Z"),
    ...fields,
  };
}

async function seed(tenant: TenantId, fields: Partial<NewSchedule> = {}): Promise<string> {
  const s = scheduleOf(tenant, fields);
  await db.transaction(async (tx) => insertSchedule(tx, s));
  createdSchedules.push(s.id);
  return s.id;
}

/** The constraint a refused statement names (drizzle wraps the driver's error as its `cause`). */
async function refusedBy(statement: PromiseLike<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    const pgError = (error as { cause?: { constraint?: unknown } }).cause ?? (error as { constraint?: unknown });
    const constraint = (pgError as { constraint?: unknown }).constraint;
    if (typeof constraint !== "string") throw error;
    return constraint;
  }
  throw new Error("the statement was not refused");
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
}, 60_000);

afterAll(async () => {
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  if (createdSchedules.length > 0) {
    await db.delete(crawlEvents).where(inArray(crawlEvents.scheduleId, createdSchedules));
    await db.delete(schedules).where(inArray(schedules.id, createdSchedules));
  }
  await closeDb(db);
}, 60_000);

describe("the store", () => {
  it("getSchedule and listSchedules read the crawl config only, never the judgement or a list crawl's URLs (final review M2); the full config stays stored", async () => {
    const listed = Array.from({ length: 500 }, (_, i) => `https://view.example/p/${i}`);
    const s = scheduleOf(LOCAL_TENANT, {
      crawl: { config: configFor("https://view.example/"), judgement: { rules: { "title.missing": { disabled: true } } }, listed },
      siteUrl: "https://view.example/",
    });
    const inserted = await db.transaction(async (tx) => insertSchedule(tx, s));
    createdSchedules.push(s.id);
    const got = await getSchedule(db, LOCAL_TENANT, s.id);
    const page = await listSchedules(db, LOCAL_TENANT, { limit: 200 });
    const updated = await db.transaction(async (tx) => updateSchedule(tx, LOCAL_TENANT, s.id, { cron: "0 6 * * *" }));
    for (const view of [inserted, got, page.items.find((r) => r.id === s.id), updated]) {
      expect(view).toBeDefined();
      expect(Object.keys(view!)).not.toContain("config");
      expect(view!.crawlConfig).toEqual(s.crawl.config);
      expect(JSON.stringify(view)).not.toContain("view.example/p/");
    }
    const [raw] = await db.select({ config: schedules.config }).from(schedules).where(eq(schedules.id, s.id));
    expect(raw?.config).toEqual(s.crawl);
  });

  it("insertSchedule and getSchedule round-trip every column", async () => {
    const s = scheduleOf(LOCAL_TENANT, {
      crawl: {
        config: { ...configFor("https://round.example/"), listDuplicates: 2 },
        judgement: { rules: { "title.missing": { disabled: true } } },
        listed: ["https://round.example/a", "https://round.example/b"],
      },
      siteUrl: "https://round.example/",
      render: { urls: ["https://round.example/a"] },
      cron: "30 1 * * *",
      timezone: "Europe/London",
    });
    const inserted = await db.transaction(async (tx) => insertSchedule(tx, s));
    createdSchedules.push(s.id);
    expect(s.id).toMatch(/^sched_[0-9a-f-]{36}$/);
    const row = await getSchedule(db, LOCAL_TENANT, s.id);
    expect(row).toEqual(inserted);
    expect(row).toMatchObject({
      id: s.id,
      tenantId: LOCAL_TENANT,
      siteUrl: "https://round.example/",
      crawlConfig: s.crawl.config,
      render: { urls: ["https://round.example/a"] },
      cron: "30 1 * * *",
      timezone: "Europe/London",
      enabled: true,
      nextRunAt: s.nextRunAt,
      lastCrawlId: null,
      credentialGeneration: 0,
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it("an enabled schedule has a next run and a disabled one has none: the database refuses either mismatch", async () => {
    const enabledWithout = scheduleOf(LOCAL_TENANT, { enabled: true, nextRunAt: null });
    expect(await refusedBy(db.transaction(async (tx) => insertSchedule(tx, enabledWithout)))).toBe(
      "schedules_next_run_while_enabled",
    );
    const disabledWith = scheduleOf(LOCAL_TENANT, { enabled: false, nextRunAt: new Date() });
    expect(await refusedBy(db.transaction(async (tx) => insertSchedule(tx, disabledWith)))).toBe(
      "schedules_next_run_while_enabled",
    );
    expect(await getSchedule(db, LOCAL_TENANT, enabledWithout.id)).toBeNull();
  });

  it("tenant B's getSchedule on tenant A's id is null, and B can neither list, update nor delete it", async () => {
    const a = parseTenant(`store-a-${randomUUID().slice(0, 8)}`);
    const b = parseTenant(`store-b-${randomUUID().slice(0, 8)}`);
    const id = await seed(a);

    expect(await getSchedule(db, b, id)).toBeNull();
    expect(await getSchedule(db, a, id)).not.toBeNull();
    expect((await listSchedules(db, b, {})).items).toEqual([]);
    expect((await listSchedules(db, a, {})).items.map((r) => r.id)).toEqual([id]);

    const before = await getSchedule(db, a, id);
    expect(await db.transaction(async (tx) => updateSchedule(tx, b, id, { enabled: false, nextRunAt: null }))).toBeNull();
    expect(await db.transaction(async (tx) => deleteSchedule(tx, b, id))).toBe(false);
    expect(await getSchedule(db, a, id)).toEqual(before);
  });

  it("updateSchedule changes what it is given, stamps updated_at, and answers the row", async () => {
    const id = await seed(LOCAL_TENANT);
    const before = await getSchedule(db, LOCAL_TENANT, id);
    const after = await db.transaction(async (tx) =>
      updateSchedule(tx, LOCAL_TENANT, id, { cron: "0 4 * * *", enabled: false, nextRunAt: null }),
    );
    expect(after).toMatchObject({ id, cron: "0 4 * * *", enabled: false, nextRunAt: null, timezone: "UTC" });
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    expect(after!.createdAt).toEqual(before!.createdAt);
    expect(await getSchedule(db, LOCAL_TENANT, id)).toEqual(after);
    // A missing schedule is null, as a foreign one is.
    expect(await db.transaction(async (tx) => updateSchedule(tx, LOCAL_TENANT, newScheduleId(), { cron: "0 5 * * *" }))).toBeNull();
  });

  it("listSchedules pages newest first, a cursor at a time", async () => {
    const tenant = parseTenant(`store-list-${randomUUID().slice(0, 8)}`);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seed(tenant));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const page = await listSchedules(db, tenant, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((r) => r.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...ids].reverse());
    await expect(listSchedules(db, tenant, { cursor: "not-a-cursor" })).rejects.toThrow(/cursor/);
  });

  it("deleteSchedule takes its credentials and its own fire and skip events, and nulls its fired crawls' links", async () => {
    const id = await seed(LOCAL_TENANT);
    await db.transaction(async (tx) => vault.writeSchedule(tx, LOCAL_TENANT, id, CREDS));
    const crawlId = `crawl_${randomUUID()}`;
    const siteUrl = `https://fired-${randomUUID()}.example/`;
    await db.transaction(async (tx) => {
      await insertCrawl(tx, vault, {
        tenant: LOCAL_TENANT,
        crawlId,
        config: configFor(siteUrl),
        judgement: null,
        listed: null,
        pinnedTo: PIN,
        scheduleId: id,
        chain: { render: null },
      });
      await recordEvent(tx, { tenant: LOCAL_TENANT, crawlId: null, scheduleId: id, kind: "schedule_fired", detail: { crawlId } });
      await updateSchedule(tx, LOCAL_TENANT, id, { lastCrawlId: crawlId });
    });
    createdCrawls.push(crawlId);
    expect((await getSchedule(db, LOCAL_TENANT, id))?.lastCrawlId).toBe(crawlId);

    expect(await db.transaction(async (tx) => deleteSchedule(tx, LOCAL_TENANT, id))).toBe(true);
    expect(await getSchedule(db, LOCAL_TENANT, id)).toBeNull();
    expect(await db.select().from(scheduleCredentials).where(eq(scheduleCredentials.scheduleId, id))).toEqual([]);
    // The fire event (crawl_id null) went; the crawl's own lifecycle event stayed, its schedule_id nulled.
    expect(await db.select().from(crawlEvents).where(eq(crawlEvents.scheduleId, id))).toEqual([]);
    const lifecycle = await db.select().from(crawlEvents).where(eq(crawlEvents.crawlId, crawlId));
    expect(lifecycle.map((e) => [e.kind, e.scheduleId])).toEqual([["queued", null]]);
    const [crawl] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(crawl?.scheduleId).toBeNull();
    expect(crawl?.scheduleChain).toEqual({ render: null });
    // A second delete finds nothing.
    expect(await db.transaction(async (tx) => deleteSchedule(tx, LOCAL_TENANT, id))).toBe(false);
  });

  it("a crawl deleted under a schedule leaves the schedule, with last_crawl_id null", async () => {
    const id = await seed(LOCAL_TENANT);
    const crawlId = `crawl_${randomUUID()}`;
    await db.transaction(async (tx) => {
      await insertCrawl(tx, vault, {
        tenant: LOCAL_TENANT,
        crawlId,
        config: configFor(`https://gone-${randomUUID()}.example/`),
        judgement: null,
        listed: null,
        pinnedTo: PIN,
        scheduleId: id,
        chain: { render: null },
      });
      await updateSchedule(tx, LOCAL_TENANT, id, { lastCrawlId: crawlId });
    });
    await db.delete(crawls).where(eq(crawls.id, crawlId));
    const row = await getSchedule(db, LOCAL_TENANT, id);
    expect(row?.lastCrawlId).toBeNull();
  });
});

describe("insertCrawl", () => {
  it("writes the crawl row, its credentials, list_urls and the crawl job, with the schedule and chain read back", async () => {
    const scheduleId = await seed(LOCAL_TENANT);
    const crawlId = `crawl_${randomUUID()}`;
    const siteUrl = `https://insert-${randomUUID()}.example/`;
    const listed = Array.from({ length: 1203 }, (_, i) => `${siteUrl}p/${i}`);
    const config: StoredConfig = { ...configFor(siteUrl), listDuplicates: 1 };
    const judgement: JudgementBlock = { thresholds: { TITLE_MAX: 70 } };
    await db.transaction(async (tx) =>
      insertCrawl(tx, vault, {
        tenant: LOCAL_TENANT,
        crawlId,
        config,
        judgement,
        credentials: CREDS,
        listed,
        pinnedTo: PIN,
        scheduleId,
        chain: { render: { urls: [`${siteUrl}p/1`] } },
      }),
    );
    createdCrawls.push(crawlId);

    const [crawl] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(crawl).toMatchObject({
      tenantId: LOCAL_TENANT,
      siteUrl,
      hostKey: hostKeyOf(siteUrl),
      config,
      judgement,
      rulesetVersion: RULESET_VERSION,
      status: "queued",
      scheduleId,
      scheduleChain: { render: { urls: [`${siteUrl}p/1`] } },
      credentialGeneration: 1,
    });
    expect(await vault.read(crawlId)).toEqual({ kind: "ok", credentials: CREDS, generation: 1 });
    const urls = await db.select().from(listUrls).where(eq(listUrls.crawlId, crawlId)).orderBy(asc(listUrls.position));
    expect(urls.map((u) => u.url)).toEqual(listed);
    expect(urls.map((u) => u.position)).toEqual(listed.map((_, i) => i));
    const crawlJobs = await db.select().from(jobs).where(eq(jobs.crawlId, crawlId));
    expect(crawlJobs).toHaveLength(1);
    expect(crawlJobs[0]).toMatchObject({ tenantId: LOCAL_TENANT, kind: "crawl", status: "queued", pinnedTo: PIN });
  });

  it("a crawl that no schedule fired has neither schedule_id nor schedule_chain, nor credentials when none are given", async () => {
    const crawlId = `crawl_${randomUUID()}`;
    await db.transaction(async (tx) =>
      insertCrawl(tx, vault, {
        tenant: LOCAL_TENANT,
        crawlId,
        config: configFor(`https://plain-${randomUUID()}.example/`),
        judgement: null,
        listed: null,
        pinnedTo: PIN,
      }),
    );
    createdCrawls.push(crawlId);
    const [crawl] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(crawl).toMatchObject({ scheduleId: null, scheduleChain: null, judgement: null, credentialGeneration: 0 });
    expect(await vault.read(crawlId)).toEqual({ kind: "none" });
    expect(await db.select().from(listUrls).where(eq(listUrls.crawlId, crawlId))).toEqual([]);
  });

  it("refuses a schedule without a chain, or a chain without a schedule, writing nothing", async () => {
    const scheduleId = await seed(LOCAL_TENANT);
    for (const extra of [{ scheduleId }, { chain: { render: null } }]) {
      const crawlId = `crawl_${randomUUID()}`;
      await expect(
        db.transaction(async (tx) =>
          insertCrawl(tx, vault, {
            tenant: LOCAL_TENANT,
            crawlId,
            config: configFor(`https://refused-${randomUUID()}.example/`),
            judgement: null,
            listed: null,
            pinnedTo: PIN,
            ...extra,
          }),
        ),
      ).rejects.toThrow(/scheduleId and chain/);
      expect(await db.select().from(crawls).where(eq(crawls.id, crawlId))).toEqual([]);
    }
  });

  it("the database refuses a crawl with a schedule_id and no schedule_chain", async () => {
    const scheduleId = await seed(LOCAL_TENANT);
    const siteUrl = `https://check-${randomUUID()}.example/`;
    const refused = refusedBy(
      db.insert(crawls).values({
        id: `crawl_${randomUUID()}`,
        tenantId: LOCAL_TENANT,
        siteUrl,
        hostKey: hostKeyOf(siteUrl),
        config: configFor(siteUrl),
        rulesetVersion: RULESET_VERSION,
        scheduleId,
      }),
    );
    expect(await refused).toBe("crawls_schedule_has_chain");
  });
});

describe("the event triggers fill schedule_id (Ruling P3)", () => {
  it("a fired crawl's own events and its jobs' carry its schedule_id; an unscheduled crawl's carry null", async () => {
    const scheduleId = await seed(LOCAL_TENANT);
    const fired = `crawl_${randomUUID()}`;
    const plain = `crawl_${randomUUID()}`;
    await db.transaction(async (tx) => {
      await insertCrawl(tx, vault, {
        tenant: LOCAL_TENANT,
        crawlId: fired,
        config: configFor(`https://trig-${randomUUID()}.example/`),
        judgement: null,
        listed: null,
        pinnedTo: PIN,
        scheduleId,
        chain: { render: null },
      });
      await insertCrawl(tx, vault, {
        tenant: LOCAL_TENANT,
        crawlId: plain,
        config: configFor(`https://trig-${randomUUID()}.example/`),
        judgement: null,
        listed: null,
        pinnedTo: PIN,
      });
    });
    createdCrawls.push(fired, plain);
    // Settle each crawl and its crawl job, then queue a rules job: a job event.
    for (const id of [fired, plain]) {
      await db.update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.crawlId, id));
      await db.update(crawls).set({ status: "finished", finishedAt: new Date(), pagesCrawled: 0 }).where(eq(crawls.id, id));
      await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: id, kind: "rules", pinnedTo: PIN });
    }
    const eventsOf = async (crawlId: string) =>
      (await db.select().from(crawlEvents).where(eq(crawlEvents.crawlId, crawlId)).orderBy(asc(crawlEvents.id))).map(
        (e) => [e.kind, e.scheduleId],
      );
    expect(await eventsOf(fired)).toEqual([
      ["queued", scheduleId],
      ["finished", scheduleId],
      ["rules_queued", scheduleId],
    ]);
    expect(await eventsOf(plain)).toEqual([
      ["queued", null],
      ["finished", null],
      ["rules_queued", null],
    ]);
    // No event of either crawl lacks a crawl id.
    expect(
      await db.select().from(crawlEvents).where(and(eq(crawlEvents.scheduleId, scheduleId), isNull(crawlEvents.crawlId))),
    ).toEqual([]);
  });
});

describe("a write racing deleteSchedule (Review Focus 4: no foreign-key error, no orphan job)", () => {
  /** A fired crawl, finished, its crawl job done: ready for a rules job. */
  async function finishedFiredCrawl(scheduleId: string): Promise<string> {
    const crawlId = `crawl_${randomUUID()}`;
    await db.transaction(async (tx) =>
      insertCrawl(tx, vault, {
        tenant: LOCAL_TENANT,
        crawlId,
        config: configFor(`https://race-${randomUUID()}.example/`),
        judgement: null,
        listed: null,
        pinnedTo: PIN,
        scheduleId,
        chain: { render: null },
      }),
    );
    createdCrawls.push(crawlId);
    await db.update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.crawlId, crawlId));
    await db
      .update(crawls)
      .set({ status: "finished", finishedAt: new Date(), pagesCrawled: 0 })
      .where(eq(crawls.id, crawlId));
    return crawlId;
  }

  /**
   * `deleteSchedule` run to its last statement and held open on its own
   * connection: the schedule row is deleted, not committed. `commit` lets it go.
   */
  async function deleteHeldOpen(scheduleId: string): Promise<{ commit: () => Promise<void> }> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let deleted!: () => void;
    const ready = new Promise<void>((resolve) => (deleted = resolve));
    const done = db.transaction(async (tx) => {
      expect(await deleteSchedule(tx, LOCAL_TENANT, scheduleId)).toBe(true);
      deleted();
      await gate;
    });
    await Promise.race([ready, done]);
    return {
      commit: async () => {
        open();
        await done;
      },
    };
  }

  /** `write`, on another connection, started while the delete is held open: it waits, then succeeds. */
  async function racing(scheduleId: string, write: () => PromiseLike<unknown>): Promise<void> {
    const held = await deleteHeldOpen(scheduleId);
    let settled = false;
    const racer = Promise.resolve(write()).then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    void racer.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 300));
    // It waits on the delete's uncommitted locks: the race is real.
    expect(settled).toBe(false);
    await held.commit();
    const { error } = await racer;
    expect(error).toBeNull();
  }

  async function eventsOf(crawlId: string): Promise<[string, string | null][]> {
    const rows = await db.select().from(crawlEvents).where(eq(crawlEvents.crawlId, crawlId)).orderBy(asc(crawlEvents.id));
    return rows.map((e) => [e.kind, e.scheduleId]);
  }

  it("a job settle: the job settles, and its event carries schedule_id null", async () => {
    const scheduleId = await seed(LOCAL_TENANT);
    const crawlId = await finishedFiredCrawl(scheduleId);
    const jobId = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "rules", pinnedTo: PIN });
    await db.update(jobs).set({ status: "running", claimedBy: PIN, claimedAt: new Date() }).where(eq(jobs.id, jobId));

    await racing(scheduleId, () => finishJob(db, jobId, "done"));

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job?.status).toBe("done");
    expect(await eventsOf(crawlId)).toEqual([
      ["queued", null],
      ["finished", null],
      ["rules_queued", null],
      ["rules_started", null],
      ["rules_finished", null],
    ]);
    expect(await getSchedule(db, LOCAL_TENANT, scheduleId)).toBeNull();
  });

  it("a job insert: the job is queued, and its event carries schedule_id null", async () => {
    const scheduleId = await seed(LOCAL_TENANT);
    const crawlId = await finishedFiredCrawl(scheduleId);

    await racing(scheduleId, () => enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "rules", pinnedTo: PIN }));

    const rulesJobs = await db.select().from(jobs).where(and(eq(jobs.crawlId, crawlId), eq(jobs.kind, "rules")));
    expect(rulesJobs.map((j) => j.status)).toEqual(["queued"]);
    expect(await eventsOf(crawlId)).toEqual([
      ["queued", null],
      ["finished", null],
      ["rules_queued", null],
    ]);
  });

  it("a crawl status write: it waits for the delete's crawl lock and writes its event with schedule_id null", async () => {
    const scheduleId = await seed(LOCAL_TENANT);
    const crawlId = await finishedFiredCrawl(scheduleId);

    await racing(scheduleId, () =>
      db.update(crawls).set({ status: "failed", failureReason: "race" }).where(eq(crawls.id, crawlId)),
    );

    expect(await eventsOf(crawlId)).toEqual([
      ["queued", null],
      ["finished", null],
      ["failed", null],
    ]);
  });
});

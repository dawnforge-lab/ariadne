/**
 * Phase 28c Task 5: the scheduler — `fireDue` (src/schedule/fire.ts) and the
 * `Scheduler` that runs it under one leader (src/schedule/scheduler.ts).
 *
 *  - A due schedule fires once: a crawl with its `schedule_id` and
 *    `schedule_chain`, a `schedule_fired{crawlId}` event, `next_run_at` past
 *    now. Missed slots fire once. A DST day fires once.
 *  - The skip rules, in order: `overlap`, `not-allowed`,
 *    `credentials_unreadable` — an event, no crawl, the slot advanced.
 *  - SKIP LOCKED: two concurrent `fireDue`s fire a slot once.
 *  - One leader by advisory lock; a killed leader's lock passes to another
 *    candidate, and no slot fires twice (Review Focus 3).
 *  - A schedule deleted while a fire is in flight (the Task 3 carry): the
 *    delete waits for the fire, and a status write on the fired crawl does not
 *    deadlock against it.
 *
 * ISOLATION. Every test confines `fireDue` to tenants of its own
 * (`onlyTenants`) and every `Scheduler` to a lock key of its own (`lockKey`):
 * the code-only seams (call C3). The file also holds the production key,
 * `SCHEDULER_LOCK`, for its whole length, so an entry point another suite
 * spawns (they turn the scheduler on) never leads while these schedules are
 * due. Every fired crawl's job is pinned to an instance id no process
 * registers, so no runner of another suite claims it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import pg from "pg";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawlEvents, crawls, instances, jobs, schedules } from "../../src/db/schema.js";
import { CredentialVault, type CredentialRead } from "../../src/crawl/credential-vault.js";
import { shapeOf, type CrawlCredentials } from "../../src/crawl/credentials.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import type { StoredConfig } from "../../src/crawl/insert-crawl.js";
import { storableConfig } from "../../src/crawl/loop.js";
import { recordEvent } from "../../src/events/events.js";
import { nextSlot } from "../../src/schedule/cron.js";
import { fireDue, type FireDeps } from "../../src/schedule/fire.js";
import { SCHEDULER_LOCK, Scheduler } from "../../src/schedule/scheduler.js";
import { deleteSchedule, getSchedule, insertSchedule, newScheduleId, type NewSchedule } from "../../src/schedule/store.js";
import { ApiService } from "../../src/api/service.js";
import { deleteCrawlRows } from "../../src/api/crawl-delete.js";
import { claimNextJob, enqueueJob } from "../../src/worker/jobs.js";
import { registerInstance, stopInstance } from "../../src/worker/instance.js";
import { startWorker } from "../../src/worker/main.js";
import { timingWith } from "../../src/worker/timing.js";
import { parseTenant, type TenantId } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS, otherKey } from "../helpers/credential-keys.js";
import { acquirePoolLock } from "../helpers/pool-lock.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let vault: CredentialVault;
/** Holds `SCHEDULER_LOCK` for the file (module header). */
let productionKeyHolder: pg.Client;
const RUN = randomUUID().slice(0, 8);
const tenants: TenantId[] = [];
/** An instance id no process registers: a job pinned to it is never claimed. */
const PIN = `test-scheduler-${randomUUID()}`;
const CREDS: CrawlCredentials = { requestHeaders: { "X-Sched-Key": "sched-S3CRET" } };
/** A key of its own per `Scheduler` test, clear of the production key and of each other. */
let nextKey = 2_028_100_000 + Math.floor(Math.random() * 1_000_000) * 10;
const lockKey = (): number => (nextKey += 1);

function tenant(): TenantId {
  const t = parseTenant(`sched-t5-${RUN}-${tenants.length}`);
  tenants.push(t);
  return t;
}

function configFor(siteUrl: string, extra: Record<string, unknown> = {}): StoredConfig {
  return storableConfig({
    siteUrl,
    maxPages: 10,
    maxDepth: 3,
    userAgent: "AriadneBot-scheduler-test",
    perHostDelayMs: 0,
    maxConcurrency: 1,
    ...extra,
  });
}

function hostOf(siteUrl: string): string {
  return new URL(siteUrl).hostname;
}

async function seed(t: TenantId, fields: Partial<NewSchedule> = {}, creds?: CrawlCredentials): Promise<NewSchedule> {
  const siteUrl = fields.siteUrl ?? `https://sched-${randomUUID()}.example/`;
  const s: NewSchedule = {
    id: newScheduleId(),
    tenant: t,
    siteUrl,
    crawl: {
      config: configFor(siteUrl, creds === undefined ? {} : { credentialShape: shapeOf(creds)! }),
      judgement: null,
      listed: null,
    },
    render: null,
    cron: "0 * * * *",
    timezone: "UTC",
    enabled: true,
    nextRunAt: new Date("2026-11-12T10:00:00Z"),
    ...fields,
  };
  await db.transaction(async (tx) => {
    await insertSchedule(tx, s);
    if (creds !== undefined) await vault.writeSchedule(tx, t, s.id, creds);
  });
  return s;
}

function deps(t: TenantId | TenantId[], extra: Partial<FireDeps> = {}): FireDeps {
  return {
    vault,
    hostAllowed: () => true,
    pin: PIN,
    log: () => undefined,
    onlyTenants: Array.isArray(t) ? t : [t],
    ...extra,
  };
}

async function eventsOfSchedule(id: string): Promise<{ kind: string; crawlId: string | null; detail: unknown }[]> {
  const rows = await db.select().from(crawlEvents).where(eq(crawlEvents.scheduleId, id)).orderBy(asc(crawlEvents.id));
  return rows.filter((r) => r.crawlId === null).map((r) => ({ kind: r.kind, crawlId: r.crawlId, detail: r.detail }));
}

async function crawlsOf(scheduleId: string): Promise<(typeof crawls.$inferSelect)[]> {
  return db.select().from(crawls).where(eq(crawls.scheduleId, scheduleId)).orderBy(asc(crawls.startedAt), asc(crawls.id));
}

async function row(id: string): Promise<typeof schedules.$inferSelect> {
  const [found] = await db.select().from(schedules).where(eq(schedules.id, id));
  if (found === undefined) throw new Error(`no schedule ${id}`);
  return found;
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Whether a backend running a statement that starts with `prefix` is waiting on a lock. */
async function blockedOn(prefix: string): Promise<boolean> {
  const r = await db.$pool.query<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike $1 and pid <> pg_backend_pid()`,
    [`${prefix}%`],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/** `deleteSchedule`'s statements, as drizzle writes them: its schedule lock and its crawl locks. */
const SCHEDULE_LOCK_SQL = 'select "id" from "schedules"';
const CRAWLS_LOCK_SQL = 'select "id" from "crawls"';

/**
 * A TCP proxy to the database whose current connections can be FROZEN — no
 * byte passes either way, and neither end is told — as a network partition
 * leaves a half-open connection. A frozen connection's server side lives on
 * until `cutFrozen()` closes it.
 */
async function freezableProxy(): Promise<{
  url: string;
  connections: () => number;
  freeze: () => void;
  cutFrozen: () => void;
  close: () => Promise<void>;
}> {
  const target = new URL(databaseUrl());
  const pairs: { client: net.Socket; upstream: net.Socket; frozen: boolean }[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || "5432"), target.hostname);
    const pair = { client, upstream, frozen: false };
    pairs.push(pair);
    client.on("data", (d) => {
      if (!pair.frozen) upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (!pair.frozen) client.write(d);
    });
    // A frozen pair's other end is never told: that is the partition.
    const closeOther = (other: net.Socket) => () => {
      if (!pair.frozen) other.destroy();
    };
    client.on("close", closeOther(upstream));
    upstream.on("close", closeOther(client));
    client.on("error", () => client.destroy());
    upstream.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(databaseUrl());
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url: url.toString(),
    connections: () => pairs.length,
    freeze: () => pairs.forEach((p) => (p.frozen = true)),
    cutFrozen: () =>
      pairs
        .filter((p) => p.frozen)
        .forEach((p) => {
          p.client.destroy();
          p.upstream.destroy();
        }),
    close: async () => {
      pairs.forEach((p) => {
        p.client.destroy();
        p.upstream.destroy();
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
  productionKeyHolder = new pg.Client({ connectionString: databaseUrl(), application_name: `scheduler-test-holder-${RUN}` });
  await productionKeyHolder.connect();
  await productionKeyHolder.query("select pg_advisory_lock($1::bigint)", [SCHEDULER_LOCK]);
}, 60_000);

afterAll(async () => {
  if (tenants.length > 0) {
    await db.delete(crawls).where(inArray(crawls.tenantId, tenants));
    await db.delete(crawlEvents).where(inArray(crawlEvents.tenantId, tenants));
    await db.delete(schedules).where(inArray(schedules.tenantId, tenants));
  }
  await productionKeyHolder.query("select pg_advisory_unlock($1::bigint)", [SCHEDULER_LOCK]);
  await productionKeyHolder.end();
  await closeFetchAgents();
  await closeDb(db);
}, 60_000);

const NOW = new Date("2026-11-12T10:00:30Z");

describe("fireDue", () => {
  it("(b) a due schedule fires once: a crawl with schedule_id and schedule_chain, schedule_fired{crawlId}, next_run_at past now", async () => {
    const t = tenant();
    const s = await seed(t, { render: { urls: ["https://x.example/a"] } }, CREDS);

    expect(await fireDue(db, deps(t), NOW)).toEqual({ fired: 1, skipped: 0 });

    const fired = await crawlsOf(s.id);
    expect(fired).toHaveLength(1);
    const crawl = fired[0]!;
    expect(crawl).toMatchObject({
      tenantId: t,
      siteUrl: s.siteUrl,
      status: "queued",
      scheduleId: s.id,
      scheduleChain: { render: { urls: ["https://x.example/a"] } },
    });
    // Its job, pinned as the deps say (C4).
    const crawlJobs = await db.select().from(jobs).where(eq(jobs.crawlId, crawl.id));
    expect(crawlJobs.map((j) => [j.kind, j.status, j.pinnedTo])).toEqual([["crawl", "queued", PIN]]);
    // The credentials, re-encrypted under the crawl.
    const read: CredentialRead = await vault.read(crawl.id);
    expect(read).toMatchObject({ kind: "ok", credentials: CREDS });
    // The event: crawl_id null, the crawl named in detail (C9).
    expect(await eventsOfSchedule(s.id)).toEqual([{ kind: "schedule_fired", crawlId: null, detail: { crawlId: crawl.id } }]);
    const after = await row(s.id);
    expect(after.nextRunAt?.toISOString()).toBe("2026-11-12T11:00:00.000Z");
    expect(after.lastCrawlId).toBe(crawl.id);
    expect(after.enabled).toBe(true);
    // Nothing due now: a second call fires nothing.
    expect(await fireDue(db, deps(t), NOW)).toEqual({ fired: 0, skipped: 0 });
  });

  it("(c) missed slots: next_run_at three slots in the past gives one fire", async () => {
    const t = tenant();
    const s = await seed(t, { nextRunAt: new Date("2026-11-12T07:00:00Z") });
    expect(await fireDue(db, deps(t), NOW)).toEqual({ fired: 1, skipped: 0 });
    expect(await crawlsOf(s.id)).toHaveLength(1);
    expect((await row(s.id)).nextRunAt?.toISOString()).toBe("2026-11-12T11:00:00.000Z");
    expect(await fireDue(db, deps(t), NOW)).toEqual({ fired: 0, skipped: 0 });
  });

  it("(d) overlap: the last fired crawl is paused (request), so the next slot is skipped, naming it, and no crawl", async () => {
    const t = tenant();
    const s = await seed(t);
    await fireDue(db, deps(t), NOW);
    const [first] = await crawlsOf(s.id);
    await db.update(jobs).set({ status: "abandoned", finishedAt: new Date() }).where(eq(jobs.crawlId, first!.id));
    await db.update(crawls).set({ status: "paused", pauseReason: "request" }).where(eq(crawls.id, first!.id));

    const later = new Date("2026-11-12T11:00:10Z");
    expect(await fireDue(db, deps(t), later)).toEqual({ fired: 0, skipped: 1 });
    expect(await crawlsOf(s.id)).toHaveLength(1);
    const events = await eventsOfSchedule(s.id);
    expect(events.at(-1)).toEqual({
      kind: "schedule_skipped",
      crawlId: null,
      detail: { reason: "overlap", crawlId: first!.id },
    });
    const after = await row(s.id);
    expect(after.nextRunAt?.toISOString()).toBe("2026-11-12T12:00:00.000Z");
    expect(after.lastCrawlId).toBe(first!.id);
  });

  it("overlap also holds while a finished fired crawl has a queued or running job on it (a chain link)", async () => {
    const t = tenant();
    const s = await seed(t);
    await fireDue(db, deps(t), NOW);
    const [first] = await crawlsOf(s.id);
    await db.update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.crawlId, first!.id));
    await db.update(crawls).set({ status: "finished", finishedAt: new Date(), pagesCrawled: 0 }).where(eq(crawls.id, first!.id));
    await enqueueJob(db, { tenant: t, crawlId: first!.id, kind: "rules", pinnedTo: PIN });
    expect(await fireDue(db, deps(t), new Date("2026-11-12T11:00:10Z"))).toEqual({ fired: 0, skipped: 1 });
    expect((await eventsOfSchedule(s.id)).at(-1)?.detail).toEqual({ reason: "overlap", crawlId: first!.id });
  });

  it("(e) not-allowed: hostAllowed false skips the slot, logs the host, and fires nothing", async () => {
    const t = tenant();
    const s = await seed(t);
    const lines: string[] = [];
    const result = await fireDue(db, deps(t, { hostAllowed: () => false, log: (l) => lines.push(l) }), NOW);
    expect(result).toEqual({ fired: 0, skipped: 1 });
    expect(await crawlsOf(s.id)).toHaveLength(0);
    expect(await eventsOfSchedule(s.id)).toEqual([
      { kind: "schedule_skipped", crawlId: null, detail: { reason: "not-allowed" } },
    ]);
    expect(lines.join("\n")).toContain(s.id);
    expect(lines.join("\n")).toContain(hostOf(s.siteUrl));
    expect((await row(s.id)).nextRunAt?.toISOString()).toBe("2026-11-12T11:00:00.000Z");
  });

  it("(f) credentials_unreadable: a schedule written under an unknown key is skipped, and nothing fires", async () => {
    const t = tenant();
    const s = await seed(t);
    // Its credentials, written by a process holding another key.
    const foreign = new CredentialVault(db, { current: otherKey("foreign-k9", 7) });
    await db.transaction(async (tx) => {
      await tx
        .update(schedules)
        .set({ config: { ...s.crawl, config: configFor(s.siteUrl, { credentialShape: shapeOf(CREDS)! }) } })
        .where(eq(schedules.id, s.id));
      await foreign.writeSchedule(tx, t, s.id, CREDS);
    });
    const lines: string[] = [];
    expect(await fireDue(db, deps(t, { log: (l) => lines.push(l) }), NOW)).toEqual({ fired: 0, skipped: 1 });
    expect(await crawlsOf(s.id)).toHaveLength(0);
    expect(await eventsOfSchedule(s.id)).toEqual([
      { kind: "schedule_skipped", crawlId: null, detail: { reason: "credentials_unreadable" } },
    ]);
    expect(lines.join("\n")).toContain("unknown-key");
    expect(lines.join("\n")).not.toContain("sched-S3CRET");
  });

  it("the skip rules apply in order: an overlapping schedule on a host not allowed is an overlap", async () => {
    const t = tenant();
    const s = await seed(t);
    await fireDue(db, deps(t), NOW);
    const [first] = await crawlsOf(s.id);
    expect(await fireDue(db, deps(t, { hostAllowed: () => false }), new Date("2026-11-12T11:00:10Z"))).toEqual({
      fired: 0,
      skipped: 1,
    });
    expect((await eventsOfSchedule(s.id)).at(-1)?.detail).toEqual({ reason: "overlap", crawlId: first!.id });
  });

  it("(h) a fired crawl queued behind another tenant's running crawl of the same host stays queued; the next slot is an overlap", async () => {
    const t = tenant();
    const other = tenant();
    const site = `https://shared-${randomUUID()}.example/`;
    const holder = await registerInstance(db, "worker");
    // A pin of this test's own: the claim below must see only this test's jobs.
    const pin = `test-scheduler-h-${randomUUID()}`;
    try {
      // The other tenant's crawl of the same host, running under a live instance.
      const otherSchedule = await seed(other, { siteUrl: site });
      await fireDue(db, deps(other, { pin: holder }), NOW);
      const [running] = await crawlsOf(otherSchedule.id);
      const claimedOther = await claimNextJob(db, { instanceId: holder, kinds: ["crawl"], pinnedTo: holder });
      expect(claimedOther?.crawlId).toBe(running!.id);
      await db.update(crawls).set({ status: "running", startedAt: new Date() }).where(eq(crawls.id, running!.id));

      const s = await seed(t, { siteUrl: site });
      expect(await fireDue(db, deps(t, { pin }), NOW)).toEqual({ fired: 1, skipped: 0 });
      const [fired] = await crawlsOf(s.id);
      // Host exclusivity (28b): its job is not claimable while the host is busy.
      expect(await claimNextJob(db, { instanceId: pin, kinds: ["crawl"], pinnedTo: pin })).toBeNull();
      expect((await crawlsOf(s.id))[0]?.status).toBe("queued");

      expect(await fireDue(db, deps(t, { pin }), new Date("2026-11-12T11:00:10Z"))).toEqual({ fired: 0, skipped: 1 });
      expect(await crawlsOf(s.id)).toHaveLength(1);
      expect((await eventsOfSchedule(s.id)).at(-1)?.detail).toEqual({ reason: "overlap", crawlId: fired!.id });
    } finally {
      await stopInstance(db, holder);
      await db.delete(crawls).where(inArray(crawls.tenantId, [other]));
      await db.delete(instances).where(eq(instances.id, holder));
    }
  });

  it("(i) two concurrent fireDue calls on one due schedule fire it once (SKIP LOCKED)", async () => {
    const t = tenant();
    const s = await seed(t);
    const [a, b] = await Promise.all([fireDue(db, deps(t), NOW), fireDue(db, deps(t), NOW)]);
    expect(a.fired + b.fired).toBe(1);
    expect(a.skipped + b.skipped).toBe(0);
    expect(await crawlsOf(s.id)).toHaveLength(1);
    expect((await eventsOfSchedule(s.id)).map((e) => e.kind)).toEqual(["schedule_fired"]);
  });

  it("(j) a DST day fires once: 30 1 * * * in Europe/London on 2026-03-29 and 2026-10-25", async () => {
    for (const day of ["2026-03-29", "2026-10-25"]) {
      const t = tenant();
      const slot = nextSlot("30 1 * * *", "Europe/London", new Date(`${day}T00:00:00Z`));
      const s = await seed(t, { cron: "30 1 * * *", timezone: "Europe/London", nextRunAt: slot });
      // Every half hour across the day.
      let fired = 0;
      for (let at = slot.getTime(); at < new Date(`${day}T23:59:00Z`).getTime(); at += 30 * 60 * 1000) {
        fired += (await fireDue(db, deps(t), new Date(at))).fired;
        const next = (await row(s.id)).nextRunAt;
        expect(next!.getTime()).toBeGreaterThan(at);
      }
      expect(fired, day).toBe(1);
      expect((await row(s.id)).nextRunAt!.toISOString().slice(0, 10), day).not.toBe(day);
    }
  });

  it("a schedule with no slot left is fired, then disabled — enabled false, next_run_at null — and the log says so", async () => {
    const t = tenant();
    // February 29th: due on 2028-02-29, and the next is 2032, past the horizon.
    const s = await seed(t, { cron: "0 0 29 2 *", nextRunAt: new Date("2028-02-29T00:00:00Z") });
    const lines: string[] = [];
    expect(await fireDue(db, deps(t, { log: (l) => lines.push(l) }), new Date("2028-02-29T00:00:05Z"))).toEqual({
      fired: 1,
      skipped: 0,
    });
    const after = await row(s.id);
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastCrawlId).toBe((await crawlsOf(s.id))[0]?.id);
    expect(lines.join("\n")).toMatch(new RegExp(`${s.id}.*disabled`, "i"));
  });

  it("a schedule whose fire throws fails loudly, naming it, and the other due schedules still fire", async () => {
    const t = tenant();
    // A stored config this engine never writes (a siteUrl that is no URL): a defect, not a skip.
    const bad = await seed(t, { nextRunAt: new Date("2026-11-12T09:00:00Z") });
    await db
      .update(schedules)
      .set({ config: { ...bad.crawl, config: { ...bad.crawl.config, siteUrl: "not a url" } } })
      .where(eq(schedules.id, bad.id));
    const good = await seed(t);
    const error = await fireDue(db, deps(t), NOW).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain(bad.id);
    expect(await crawlsOf(good.id)).toHaveLength(1);
    expect(await crawlsOf(bad.id)).toHaveLength(0);
    // Untouched, so the next tick tries it again.
    expect((await row(bad.id)).nextRunAt?.toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });

  it("refuses a schedule whose config names credentials it has no stored copy of (written together: a defect)", async () => {
    const t = tenant();
    const s = await seed(t);
    await db
      .update(schedules)
      .set({ config: { ...s.crawl, config: configFor(s.siteUrl, { credentialShape: shapeOf(CREDS)! }) } })
      .where(eq(schedules.id, s.id));
    await expect(fireDue(db, deps(t), NOW)).rejects.toThrow(s.id);
    expect(await crawlsOf(s.id)).toHaveLength(0);
  });
});

describe("Scheduler", () => {
  function scheduler(t: TenantId, key: number, lines: string[] = [], every = 30_000): Scheduler {
    return new Scheduler(databaseUrl(), db, {
      ...deps(t, { log: (l) => lines.push(l) }),
      instanceId: `t-${randomUUID()}`,
      timing: timingWith({ scheduleEvery: every }),
      lockKey: key,
    });
  }

  async function pidOf(instanceId: string): Promise<number | null> {
    const r = await db.$pool.query<{ pid: number }>("select pid from pg_stat_activity where application_name = $1", [
      `ariadne-scheduler:${instanceId}`,
    ]);
    return r.rows[0]?.pid ?? null;
  }

  async function lockFree(key: number): Promise<boolean> {
    const c = new pg.Client({ connectionString: databaseUrl() });
    await c.connect();
    try {
      const r = await c.query<{ locked: boolean }>("select pg_try_advisory_lock($1::bigint) as locked", [key]);
      if (r.rows[0]?.locked === true) await c.query("select pg_advisory_unlock($1::bigint)", [key]);
      return r.rows[0]?.locked === true;
    } finally {
      await c.end();
    }
  }

  it("(a) two Schedulers on one key: exactly one leads; stop() releases the lock", async () => {
    const t = tenant();
    const key = lockKey();
    const a = scheduler(t, key);
    const b = scheduler(t, key);
    try {
      await a.tickOnce();
      await b.tickOnce();
      await a.tickOnce();
      expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
      expect(await lockFree(key)).toBe(false);
    } finally {
      await a.stop();
      await b.stop();
    }
    expect(a.isLeader()).toBe(false);
    expect(await lockFree(key)).toBe(true);
  });

  it("the leader fires due schedules at its tick; a candidate fires nothing", async () => {
    const t = tenant();
    const key = lockKey();
    const holder = new pg.Client({ connectionString: databaseUrl() });
    await holder.connect();
    await holder.query("select pg_advisory_lock($1::bigint)", [key]);
    const s = await seed(t);
    const sched = scheduler(t, key);
    try {
      await sched.tickOnce(NOW);
      expect(sched.isLeader()).toBe(false);
      expect(await crawlsOf(s.id)).toHaveLength(0);
      await holder.query("select pg_advisory_unlock($1::bigint)", [key]);
      await sched.tickOnce(NOW);
      expect(sched.isLeader()).toBe(true);
      expect(await crawlsOf(s.id)).toHaveLength(1);
    } finally {
      await sched.stop();
      await holder.end();
    }
  });

  it("a failed fireDue is logged and retried at the next tick; the tick itself does not throw", async () => {
    const t = tenant();
    const bad = await seed(t);
    await db
      .update(schedules)
      .set({ config: { ...bad.crawl, config: { ...bad.crawl.config, siteUrl: "not a url" } } })
      .where(eq(schedules.id, bad.id));
    const lines: string[] = [];
    const sched = scheduler(t, lockKey(), lines);
    try {
      await sched.tickOnce(NOW);
      await sched.tickOnce(NOW);
      expect(sched.isLeader()).toBe(true);
      const failures = lines.filter((l) => l.includes(bad.id) && l.includes("retrying at the next tick"));
      expect(failures).toHaveLength(2);
    } finally {
      await sched.stop();
      await db.delete(schedules).where(eq(schedules.id, bad.id));
    }
  });

  it("(g) the leader's connection killed: it logs the loss, another leads within 2 × scheduleEvery, and the slot fires once", async () => {
    const t = tenant();
    const key = lockKey();
    const every = 2_000;
    const linesA: string[] = [];
    const linesB: string[] = [];
    const a = scheduler(t, key, linesA, every);
    const b = scheduler(t, key, linesB, every);
    const ids = new Map<Scheduler, string[]>([
      [a, linesA],
      [b, linesB],
    ]);
    try {
      a.start();
      b.start();
      await until("one leader", () => a.isLeader() !== b.isLeader(), 3 * every);
      const [leader, other] = a.isLeader() ? [a, b] : [b, a];
      // The slot, a little after the kill, on a cron whose next slot is a year away.
      const slot = new Date(Date.now() + 3 * every);
      const s = await seed(t, { cron: "0 0 1 1 *", nextRunAt: slot });

      const pid = await pidOf(leader.instanceId);
      expect(pid).not.toBeNull();
      const killedAt = Date.now();
      await db.$pool.query("select pg_terminate_backend($1)", [pid]);
      await until("the other leads", () => other.isLeader(), 4 * every);
      expect(Date.now() - killedAt).toBeLessThanOrEqual(2 * every);
      await until("the loss is logged", () => ids.get(leader)!.some((l) => l.includes("scheduler: lost the leader lock — ")));
      expect(leader.isLeader()).toBe(false);

      await until("the slot fires", async () => (await crawlsOf(s.id)).length > 0, 8 * every);
      // Two more ticks past it: still once.
      await new Promise((r) => setTimeout(r, 2 * every + 100));
      expect(await crawlsOf(s.id)).toHaveLength(1);
      expect((await eventsOfSchedule(s.id)).map((e) => e.kind)).toEqual(["schedule_fired"]);
      expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
      expect(other.isLeader()).toBe(true);
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 90_000);

  it("the leader's session carries server-side TCP keepalives (idle 30 s, interval 10 s, count 3), so a partitioned leader's lock is freed in about a minute", async () => {
    const t = tenant();
    const sched = scheduler(t, lockKey());
    try {
      await sched.tickOnce(NOW);
      expect(sched.isLeader()).toBe(true);
      // The scheduler's own session, read on its own connection: the options reached the server.
      const session = (sched as unknown as { client: pg.Client }).client;
      const read = async (name: string): Promise<string> =>
        (await session.query<Record<string, string>>(`show ${name}`)).rows[0]![name]!;
      expect([
        await read("tcp_keepalives_idle"),
        await read("tcp_keepalives_interval"),
        await read("tcp_keepalives_count"),
      ]).toEqual(["30", "10", "3"]);
    } finally {
      await sched.stop();
    }
  });

  it("a candidate whose try fails logs the holder's application_name, once per change of holder", async () => {
    const t = tenant();
    const key = lockKey();
    const holderName = (n: number): string => `test-holder-${RUN}-${n}`;
    const hold = async (n: number): Promise<pg.Client> => {
      const c = new pg.Client({ connectionString: databaseUrl(), application_name: holderName(n) });
      await c.connect();
      await c.query("select pg_advisory_lock($1::bigint)", [key]);
      return c;
    };
    const lines: string[] = [];
    const sched = scheduler(t, key, lines);
    let holder = await hold(1);
    try {
      await sched.tickOnce(NOW);
      await sched.tickOnce(NOW);
      expect(sched.isLeader()).toBe(false);
      const named = (n: number): string[] => lines.filter((l) => l.includes(`'${holderName(n)}'`));
      expect(named(1)).toHaveLength(1);
      expect(named(1)[0]).toMatch(/does not lead: the leader lock is held by the session '/);

      await holder.end();
      holder = await hold(2);
      await sched.tickOnce(NOW);
      await sched.tickOnce(NOW);
      expect(named(1)).toHaveLength(1);
      expect(named(2)).toHaveLength(1);
    } finally {
      await sched.stop();
      await holder.end();
    }
  });
});

describe("a schedule deleted while a fire is in flight (the Task 3 carry: deleteSchedule vs a fresh fired crawl)", () => {
  /** A vault whose `readSchedule` waits at a gate: the fire holds its schedule there, mid-transaction. */
  class GatedVault extends CredentialVault {
    reached!: () => void;
    readonly atGate = new Promise<void>((r) => (this.reached = r));
    release!: () => void;
    private readonly gate = new Promise<void>((r) => (this.release = r));
    override async readSchedule(scheduleId: string, executor?: Parameters<CredentialVault["readSchedule"]>[1]): Promise<CredentialRead> {
      this.reached();
      await this.gate;
      return super.readSchedule(scheduleId, executor);
    }
  }

  it("the delete waits for the fire, takes the fired crawl with it, and a status write on that crawl neither deadlocks nor fails", async () => {
    const t = tenant();
    const s = await seed(t);
    // A fire/skip event of the schedule's, committed, which a third session
    // holds: the delete stops on it once it holds what it locks.
    await recordEvent(db, { tenant: t, crawlId: null, scheduleId: s.id, kind: "schedule_skipped", detail: { reason: "not-allowed" } });
    const [held] = await db.select().from(crawlEvents).where(eq(crawlEvents.scheduleId, s.id));
    const eventHolder = new pg.Client({ connectionString: databaseUrl() });
    const statusWriter = new pg.Client({ connectionString: databaseUrl() });
    await eventHolder.connect();
    await statusWriter.connect();
    try {
      await eventHolder.query("begin");
      await eventHolder.query("select id from crawl_events where id = $1 for update", [held!.id]);

      const gated = new GatedVault(db, TEST_CREDENTIAL_KEYS);
      const firing = fireDue(db, deps(t, { vault: gated }), NOW);
      await gated.atGate;
      // The fire holds the schedule; the delete starts and waits on it.
      const deleting = deleteSchedule(db, t, s.id).then(
        (deleted) => ({ deleted, error: null as unknown }),
        (error: unknown) => ({ deleted: false, error }),
      );
      await until("the delete to wait on the fire's schedule lock", () => blockedOn(SCHEDULE_LOCK_SQL));
      gated.release();
      expect(await firing).toEqual({ fired: 1, skipped: 0 });
      const [fired] = await crawlsOf(s.id);
      // The delete now holds what it locks and waits on the held event.
      await until("the delete to reach the events", () => blockedOn('delete from "crawl_events"'));

      // A status write on the fired crawl, as a runner's would be.
      await statusWriter.query("begin");
      const writing = statusWriter
        .query("update crawls set status = 'failed', failure_reason = 'race' where id = $1", [fired!.id])
        .then(
          () => ({ error: null as unknown }),
          (error: unknown) => ({ error }),
        );
      await until("the status write to wait", () => blockedOn("update crawls set status"));

      await eventHolder.query("commit");
      const deleted = await deleting;
      const written = await writing;
      expect(written.error, String((written.error as Error | null)?.message)).toBeNull();
      await statusWriter.query("commit");
      expect(deleted.error, String((deleted.error as Error | null)?.message)).toBeNull();
      expect(deleted.deleted).toBe(true);

      expect(await getSchedule(db, t, s.id)).toBeNull();
      const [after] = await db.select().from(crawls).where(eq(crawls.id, fired!.id));
      expect(after).toMatchObject({ status: "failed", scheduleId: null });
      const failedEvents = await db
        .select()
        .from(crawlEvents)
        .where(and(eq(crawlEvents.crawlId, fired!.id), eq(crawlEvents.kind, "failed")));
      expect(failedEvents.map((e) => e.scheduleId)).toEqual([null]);
    } finally {
      await eventHolder.query("rollback").catch(() => undefined);
      await statusWriter.query("rollback").catch(() => undefined);
      await eventHolder.end();
      await statusWriter.end();
    }
  }, 30_000);

  /**
   * `crawl_delete`'s transaction as the service runs it: the crawl `FOR
   * UPDATE`, held until `release`, then its rows (`deleteCrawlRows`) — whose
   * crawls delete sets the schedule's `last_crawl_id` null, taking the
   * schedule row.
   */
  function crawlDeleteHeld(crawlId: string): {
    holding: Promise<void>;
    release: () => void;
    done: Promise<{ error: unknown }>;
  } {
    let holds!: () => void;
    const holding = new Promise<void>((r) => (holds = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = db
      .transaction(async (tx) => {
        await tx.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, crawlId)).for("update");
        holds();
        await gate;
        await deleteCrawlRows(tx, crawlId);
      })
      .then(
        () => ({ error: null as unknown }),
        (error: unknown) => ({ error }),
      );
    return { holding, release, done };
  }

  it("crawl_delete of the schedule's last fired crawl racing schedule_delete: both commit, no deadlock", async () => {
    const t = tenant();
    const s = await seed(t);
    await fireDue(db, deps(t), NOW);
    const [fired] = await crawlsOf(s.id);
    await db.update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.crawlId, fired!.id));
    await db
      .update(crawls)
      .set({ status: "finished", finishedAt: new Date(), pagesCrawled: 0 })
      .where(eq(crawls.id, fired!.id));
    expect((await row(s.id)).lastCrawlId).toBe(fired!.id);

    const crawlDelete = crawlDeleteHeld(fired!.id);
    await crawlDelete.holding;
    const deleting = deleteSchedule(db, t, s.id).then(
      (deleted) => ({ deleted, error: null as unknown }),
      (error: unknown) => ({ deleted: false, error }),
    );
    await until("the schedule delete to wait on the crawl", () => blockedOn(CRAWLS_LOCK_SQL));
    crawlDelete.release();
    const crawlDeleted = await crawlDelete.done;
    const scheduleDeleted = await deleting;
    expect(crawlDeleted.error, String((crawlDeleted.error as Error | null)?.message)).toBeNull();
    expect(scheduleDeleted.error, String((scheduleDeleted.error as Error | null)?.message)).toBeNull();
    expect(scheduleDeleted.deleted).toBe(true);
    expect(await getSchedule(db, t, s.id)).toBeNull();
    expect(await db.select().from(crawls).where(eq(crawls.id, fired!.id))).toEqual([]);
  }, 30_000);

  it("a crawl fired during the delete and taken by a crawl_delete first: the delete starts again behind it, both commit", async () => {
    const t = tenant();
    const s = await seed(t);
    // A KEY SHARE holder on the schedule keeps the delete waiting in its
    // schedule lock after the fire commits — the window a writer can take the
    // fresh crawl in.
    const keyShare = new pg.Client({ connectionString: databaseUrl() });
    await keyShare.connect();
    try {
      await keyShare.query("begin");
      await keyShare.query("select id from schedules where id = $1 for key share", [s.id]);
      const gated = new GatedVault(db, TEST_CREDENTIAL_KEYS);
      const firing = fireDue(db, deps(t, { vault: gated }), NOW);
      await gated.atGate;
      const deleting = deleteSchedule(db, t, s.id).then(
        (deleted) => ({ deleted, error: null as unknown }),
        (error: unknown) => ({ deleted: false, error }),
      );
      await until("the delete to wait on the schedule", () => blockedOn(SCHEDULE_LOCK_SQL));
      gated.release();
      expect(await firing).toEqual({ fired: 1, skipped: 0 });
      const [fired] = await crawlsOf(s.id);

      // crawl_delete takes the fresh crawl, while the delete still waits.
      const crawlDelete = crawlDeleteHeld(fired!.id);
      await crawlDelete.holding;
      await keyShare.query("commit");
      // The delete took the schedule, found the fresh crawl held, rolled back,
      // and now waits on that crawl in order (only a second attempt waits here).
      await until("the delete's second attempt to wait on the crawl", () => blockedOn(CRAWLS_LOCK_SQL));
      crawlDelete.release();
      const crawlDeleted = await crawlDelete.done;
      const scheduleDeleted = await deleting;
      expect(crawlDeleted.error, String((crawlDeleted.error as Error | null)?.message)).toBeNull();
      expect(scheduleDeleted.error, String((scheduleDeleted.error as Error | null)?.message)).toBeNull();
      expect(scheduleDeleted.deleted).toBe(true);
      expect(await getSchedule(db, t, s.id)).toBeNull();
      expect(await db.select().from(crawls).where(eq(crawls.id, fired!.id))).toEqual([]);
    } finally {
      await keyShare.query("rollback").catch(() => undefined);
      await keyShare.end();
    }
  }, 30_000);
});

describe("where it runs", () => {
  it("the candidates are api:serve and worker:serve; the stdio MCP entry builds its service without a scheduler", () => {
    const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    expect(source("src/api/serve.ts")).toMatch(/^\s*scheduler: true,$/m);
    expect(source("src/worker/serve.ts")).toMatch(/^\s*scheduler: true,$/m);
    expect(source("src/api/mcp-serve.ts")).not.toMatch(/scheduler/);
    // api:serve stops it before anything else.
    expect(source("src/api/serve.ts")).toMatch(/api\.service\s*\.stopScheduler\(\)[\s\S]*reaper\.stop\(\)[\s\S]*api\.close\(\)/);
  });

  it("a half-open leader connection: the query times out, the loss is logged, a fresh connection tries again, and stop() returns", async () => {
    const t = tenant();
    const proxy = await freezableProxy();
    const lines: string[] = [];
    const sched = new Scheduler(proxy.url, db, {
      ...deps(t, { log: (l) => lines.push(l) }),
      instanceId: `t-${randomUUID()}`,
      timing: timingWith({ scheduleEvery: 30_000 }),
      lockKey: lockKey(),
      queryTimeoutMs: 500,
    });
    try {
      await sched.tickOnce();
      expect(sched.isLeader()).toBe(true);

      // The network goes quiet; the server's session lives on, holding the lock.
      proxy.freeze();
      const started = Date.now();
      await sched.tickOnce();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(sched.isLeader()).toBe(false);
      expect(lines.some((l) => l.startsWith("scheduler: lost the leader lock — Query read timeout"))).toBe(true);

      // One tick's pause, then a try on a fresh connection: the zombie session still holds the lock.
      await sched.tickOnce();
      expect(proxy.connections()).toBe(1);
      await sched.tickOnce();
      expect(proxy.connections()).toBe(2);
      expect(sched.isLeader()).toBe(false);

      // The partition ends the zombie session; the lock is free, and the next try leads.
      proxy.cutFrozen();
      await until("it leads again", async () => {
        await sched.tickOnce();
        return sched.isLeader();
      });

      // stop() on a half-open leader returns, with the timeout, rather than hang.
      proxy.freeze();
      const stopping = Date.now();
      await expect(sched.stop()).rejects.toThrow(/Query read timeout/);
      expect(Date.now() - stopping).toBeLessThan(5_000);
    } finally {
      await sched.stop().catch(() => undefined);
      proxy.cutFrozen();
      await proxy.close();
    }
  }, 30_000);

  it("an ApiService with `scheduler` fires a due schedule pinned to its own instance (C4), and close() stops the scheduler first", async () => {
    const t = tenant();
    const key = lockKey();
    const service = new ApiService(db, {
      credentialKeys: TEST_CREDENTIAL_KEYS,
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      timing: { scheduleEvery: 100 },
      log: () => undefined,
      scheduler: { lockKey: key, onlyTenants: [t] },
    });
    let closed = false;
    try {
      const instanceId = await service.instanceId();
      const made = await service.createSchedule(t, {
        crawl: { siteUrl: "http://127.0.0.1:9/", maxPages: 1 },
        cron: "0 0 1 1 *",
        timezone: "UTC",
      });
      await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1_000) }).where(eq(schedules.id, made.scheduleId));
      await until("the fire", async () => (await crawlsOf(made.scheduleId)).length > 0);
      const [fired] = await crawlsOf(made.scheduleId);
      const crawlJobs = await db.select().from(jobs).where(and(eq(jobs.crawlId, fired!.id), eq(jobs.kind, "crawl")));
      expect(crawlJobs.map((j) => j.pinnedTo)).toEqual([instanceId]);
      expect(await pidCount(`ariadne-scheduler:${instanceId}`)).toBe(1);
      await service.close();
      closed = true;
      expect(await pidCount(`ariadne-scheduler:${instanceId}`)).toBe(0);
    } finally {
      if (!closed) await service.close();
    }
  }, 30_000);

  it("a worker with `scheduler` leads and applies its own allowlist: an empty one skips the slot not-allowed", async () => {
    const pool = await acquirePoolLock(databaseUrl());
    const t = tenant();
    const s = await seed(t);
    const worker = await startWorker({
      db,
      credentialKeys: TEST_CREDENTIAL_KEYS,
      concurrency: 1,
      maxRunningPerTenant: 1,
      httpPort: 0,
      httpHost: "127.0.0.1",
      metricsToken: null,
      allowedDomains: [],
      timing: { scheduleEvery: 100 },
      log: () => undefined,
      reaperOnlyInstances: (id) => [id],
      scheduler: { lockKey: lockKey(), onlyTenants: [t] },
    });
    try {
      await until("the skip", async () => (await eventsOfSchedule(s.id)).length > 0);
      expect(await eventsOfSchedule(s.id)).toEqual([
        { kind: "schedule_skipped", crawlId: null, detail: { reason: "not-allowed" } },
      ]);
      expect(await pidCount(`ariadne-scheduler:${worker.instanceId}`)).toBe(1);
    } finally {
      await worker.stop();
      await pool.release();
    }
    expect(await pidCount(`ariadne-scheduler:${worker.instanceId}`)).toBe(0);
  }, 30_000);
});

async function pidCount(applicationName: string): Promise<number> {
  const r = await db.$pool.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where application_name = $1",
    [applicationName],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * The reaper and liveness (Phase 28b Task 4b): `reapOnce` over dead
 * instances' jobs, the credential retention sweep it runs, dead instance rows,
 * and "held" meaning "held by a live instance" in the busy guards, the claim's
 * host exclusivity, and a runner that has lost its job.
 *
 * EVERY `reapOnce` HERE IS CONFINED (`onlyInstances`, TEST ONLY) to the
 * instances the test registered, with tight timings: the suite's files share
 * one database, and an unconfined reaper on a 300 ms clock would pause, abandon
 * and delete other suites' rows. Nothing here leaves a QUEUED UNPINNED job
 * either — the unpinned pool is test/worker/runner.test.ts's alone, and the
 * auto-resume tests (which enqueue unpinned jobs) live there.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawlCredentials, crawls, frontier, instances, jobs, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { ClaimLostError, JobLostError, resumeCrawl, storableConfig, type CrawlConfig } from "../../src/crawl/loop.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { EXTRACTION_VERSION } from "../../src/crawl/versions.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { ApiService } from "../../src/api/service.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { claimNextJob, enqueueJob, withPinnedJob, type ClaimedJob } from "../../src/worker/jobs.js";
import { registerInstance } from "../../src/worker/instance.js";
import { JobRunner } from "../../src/worker/runner.js";
import { crawlJobExecutor } from "../../src/worker/crawl-job.js";
import { reapOnce, type ReapSummary } from "../../src/worker/reaper.js";
import { timingWith } from "../../src/worker/timing.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The brief's clock: heartbeat 50 ms, dead after 300 ms, a reaper every 100 ms. */
const TIGHT = timingWith({ heartbeat: 50, deadAfter: 300, reapEvery: 100, claimPoll: 50 });
const DAY = 24 * 60 * 60 * 1000;

let db: Db;
let vault: CredentialVault;
let siteServer: Server;
let site: string;
let exportDir: string;
let renderDir: string;
const createdCrawls: string[] = [];
const createdInstances: string[] = [];
const services: ApiService[] = [];

async function until<T>(what: string, read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${JSON.stringify(value)})`);
    await sleep(20);
  }
}

/** An instance whose last heartbeat is `ageMs` old, on the database's clock. */
async function instanceAt(ageMs: number, on: Pick<Db, "execute"> = db): Promise<string> {
  const id = await registerInstance(db, "worker");
  createdInstances.push(id);
  await on.execute(
    sql`update instances set heartbeat_at = now() - (${ageMs}::int * interval '1 millisecond') where id = ${id}`,
  );
  return id;
}

const HOUR = 60 * 60 * 1000;
const dead = (): Promise<string> => instanceAt(HOUR);

/** A config the loop accepts, for a crawl of the slow site (or `siteUrl`). */
function crawlConfig(siteUrl = `${site}/`, maxPages = 400): CrawlConfig {
  return {
    siteUrl,
    maxPages,
    maxDepth: 10,
    userAgent: "AriadneBot-reaper-test",
    perHostDelayMs: 0,
    maxConcurrency: 1,
    probeHosts: false,
    allowPrivate: true,
  };
}

/** A crawl row, on a host of its own unless `siteUrl` names one. */
async function seedCrawl(
  fields: Partial<typeof crawls.$inferInsert> & { status: string },
  siteUrl = `https://reaper-${randomUUID()}.example/`,
): Promise<string> {
  const id = `crawl_reaper_${randomUUID()}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl,
    hostKey: hostKeyOf(siteUrl),
    config: storableConfig(crawlConfig(siteUrl)),
    rulesetVersion: RULESET_VERSION,
    ...fields,
  });
  createdCrawls.push(id);
  return id;
}

/** A job row as a runner of `instanceId` would hold it. */
async function seedJob(
  crawlId: string,
  fields: Partial<typeof jobs.$inferInsert> & { kind: string; status: string },
): Promise<string> {
  const id = `job_${randomUUID()}`;
  await db.insert(jobs).values({
    id,
    tenantId: LOCAL_TENANT,
    crawlId,
    rulesetVersion: RULESET_VERSION,
    extractionVersion: EXTRACTION_VERSION,
    ...(fields.status === "running" ? { claimedAt: new Date(), heartbeatAt: new Date() } : {}),
    ...fields,
  });
  return id;
}

async function crawlRow(id: string): Promise<typeof crawls.$inferSelect> {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl ${id}`);
  return row;
}

async function jobRow(id: string): Promise<typeof jobs.$inferSelect> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
}

async function jobsOf(crawlId: string): Promise<(typeof jobs.$inferSelect)[]> {
  return db.select().from(jobs).where(eq(jobs.crawlId, crawlId)).orderBy(jobs.queuedAt, jobs.id);
}

function reap(only: readonly string[], extra: { retentionDays?: number; timing?: typeof TIGHT } = {}, on: Pick<Db, "transaction" | "execute" | "select" | "update" | "insert" | "delete"> = db): Promise<ReapSummary> {
  return reapOnce(on as Db, {
    now: new Date(),
    timing: extra.timing ?? TIGHT,
    vault,
    // A century: no credential row anywhere is that old, so a tick here sweeps
    // nothing of another suite's (the sweep test names its own retention).
    retentionDays: extra.retentionDays ?? 36_500,
    onlyInstances: only,
  });
}

const NOTHING: ReapSummary = {
  abandonedJobs: 0,
  pausedCrawls: 0,
  cancelledCrawls: 0,
  requeuedCrawls: 0,
  credentialsSwept: 0,
  instancesDeleted: 0,
};

function serviceConfig(log: string[], extra: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    credentialKeys: TEST_CREDENTIAL_KEYS,
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: (line) => log.push(line),
    ...extra,
  };
}

function newService(log: string[] = [], extra: Partial<ServiceConfig> = {}): ApiService {
  const service = new ApiService(db, serviceConfig(log, extra));
  services.push(service);
  return service;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-reaper-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-reaper-render-"));
  // An endless tree of slow pages: a crawl of it is still running whenever a
  // test needs it to be.
  siteServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const m = /^\/p\/(\d+)$/.exec(path);
    if (path !== "/" && m === null) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const n = m === null ? 0 : Number(m[1]);
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p/${n * 10 + i + 1}">p</a>`).join("");
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><head><title>Page ${n}</title></head><body>${links}</body></html>`);
    }, 100);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  for (const service of services) await service.close();
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  // Settled first, so nothing of this file holds a host or a crawl while the
  // rows go (a crawl's jobs cascade with it).
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  if (createdInstances.length > 0) await db.delete(instances).where(inArray(instances.id, createdInstances));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
}, 60_000);

describe("reapOnce: a dead instance's jobs", () => {
  it("abandons a running crawl job whose instance stopped heartbeating, pauses its crawl worker_lost and releases its leases with the attempt refunded", async () => {
    const d = await dead();
    const crawlId = await seedCrawl({ status: "running", pagesCrawled: 0 });
    // A pinned job: an in-process crawl, so this test enqueues nothing unpinned.
    const job = await seedJob(crawlId, { kind: "crawl", status: "running", pinnedTo: d, claimedBy: d });
    const leasedUntil = new Date(Date.now() + HOUR);
    await db.insert(frontier).values([
      { crawlId, url: "https://x.example/done", depth: 0, discoveredVia: "seed", state: "done", attempts: 1 },
      { crawlId, url: "https://x.example/leased", depth: 1, discoveredVia: "link", state: "leased", attempts: 1, leaseId: "w-dead", leasedUntil },
      { crawlId, url: "https://x.example/pending", depth: 1, discoveredVia: "link", state: "pending", attempts: 0 },
    ]);

    const summary = await reap([d]);
    expect(summary).toEqual({ ...NOTHING, abandonedJobs: 1, pausedCrawls: 1 });
    expect(await jobRow(job)).toMatchObject({ status: "abandoned", error: null });
    expect((await jobRow(job)).finishedAt).not.toBeNull();
    const row = await crawlRow(crawlId);
    expect(row).toMatchObject({ status: "paused", pauseReason: "worker_lost", controlRequest: null, failureReason: null });
    expect(row.finishedAt).not.toBeNull();
    // The frontier's own crawled count, as the loop's close writes it.
    expect(row.pagesCrawled).toBe(1);
    const rows = await db.select().from(frontier).where(eq(frontier.crawlId, crawlId)).orderBy(frontier.url);
    expect(rows.map((r) => [r.url, r.state, r.attempts, r.leaseId])).toEqual([
      ["https://x.example/done", "done", 1, null],
      ["https://x.example/leased", "pending", 0, null],
      ["https://x.example/pending", "pending", 0, null],
    ]);
    // A pinned (in-process) crawl is not requeued: it waits for an agent's resume.
    expect(await jobsOf(crawlId)).toHaveLength(1);
  });

  it("a stopped instance is dead at once, whatever its last heartbeat", async () => {
    const s = await instanceAt(0);
    await db.update(instances).set({ stoppedAt: new Date() }).where(eq(instances.id, s));
    const crawlId = await seedCrawl({ status: "running" });
    const job = await seedJob(crawlId, { kind: "crawl", status: "running", pinnedTo: s, claimedBy: s });
    expect(await reap([s])).toEqual({ ...NOTHING, abandonedJobs: 1, pausedCrawls: 1 });
    expect((await jobRow(job)).status).toBe("abandoned");
    expect(await crawlRow(crawlId)).toMatchObject({ status: "paused", pauseReason: "worker_lost" });
  });

  it("an agent's request pending on the dead run is answered, not lost: a pause closes `request`, a cancel `cancelled`", async () => {
    const d = await dead();
    const paused = await seedCrawl({ status: "running", controlRequest: "pause" });
    const cancelled = await seedCrawl({ status: "running", controlRequest: "cancel" });
    for (const crawlId of [paused, cancelled]) {
      await seedJob(crawlId, { kind: "crawl", status: "running", pinnedTo: d, claimedBy: d });
    }
    await db.transaction(async (tx) => {
      await vault.write(tx, LOCAL_TENANT, cancelled, { requestHeaders: { "X-Reaper": "v-S3CRET" } });
    });
    expect(await reap([d])).toEqual({ ...NOTHING, abandonedJobs: 2, pausedCrawls: 1, cancelledCrawls: 1 });
    expect(await crawlRow(paused)).toMatchObject({ status: "paused", pauseReason: "request", controlRequest: null });
    const c = await crawlRow(cancelled);
    expect(c).toMatchObject({ status: "cancelled", pauseReason: null, controlRequest: null });
    expect(c.cancelledAt).not.toBeNull();
    // A cancelled crawl never runs again, so its credentials go with it.
    expect(await db.select().from(crawlCredentials).where(eq(crawlCredentials.crawlId, cancelled))).toEqual([]);
  });

  it("a crawl claimed but not yet started by a dead instance (still `queued`) is paused worker_lost too, never left queued with no job", async () => {
    const d = await dead();
    const crawlId = await seedCrawl({ status: "queued" });
    const job = await seedJob(crawlId, { kind: "crawl", status: "running", pinnedTo: d, claimedBy: d });
    expect(await reap([d])).toEqual({ ...NOTHING, abandonedJobs: 1, pausedCrawls: 1 });
    expect((await jobRow(job)).status).toBe("abandoned");
    expect(await crawlRow(crawlId)).toMatchObject({ status: "paused", pauseReason: "worker_lost" });
  });

  it("abandons a dead instance's pinned render and rules jobs (the one-live-job index would stick) and leaves their crawls as they were", async () => {
    const d = await dead();
    const rendered = await seedCrawl({ status: "finished" });
    const judged = await seedCrawl({ status: "paused", pauseReason: "request" });
    const r1 = await seedJob(rendered, { kind: "render", status: "running", pinnedTo: d, claimedBy: d });
    const r2 = await seedJob(judged, { kind: "rules", status: "running", pinnedTo: d, claimedBy: d });
    const before = [await crawlRow(rendered), await crawlRow(judged)];
    expect(await reap([d])).toEqual({ ...NOTHING, abandonedJobs: 2 });
    expect([(await jobRow(r1)).status, (await jobRow(r2)).status]).toEqual(["abandoned", "abandoned"]);
    expect([await crawlRow(rendered), await crawlRow(judged)]).toEqual(before);
  });

  it("leaves a queued job pinned to a dead instance alone, under its queued crawl: crawl_resume adopts it", async () => {
    const d = await dead();
    const crawlId = await seedCrawl({ status: "queued" });
    const job = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: d });
    expect(await reap([d])).toEqual(NOTHING);
    expect((await jobRow(job)).status).toBe("queued");
    expect((await crawlRow(crawlId)).status).toBe("queued");
  });

  it("touches only the instances it is confined to (onlyInstances, TEST ONLY)", async () => {
    const mine = await dead();
    const theirs = await dead();
    const crawlId = await seedCrawl({ status: "running" });
    const job = await seedJob(crawlId, { kind: "crawl", status: "running", pinnedTo: theirs, claimedBy: theirs });
    expect(await reap([mine])).toEqual(NOTHING);
    expect((await jobRow(job)).status).toBe("running");
    expect((await crawlRow(crawlId)).status).toBe("running");
    await reap([theirs]);
    expect((await jobRow(job)).status).toBe("abandoned");
  });

  it("a job whose instance heartbeat is deadAfter − 10 ms old is untouched; one deadAfter + 10 ms old is reaped (the database's clock)", async () => {
    // One transaction, so `now()` is ONE instant for the stamp and for every
    // statement the reaper runs (its own transactions become savepoints): the
    // boundary is tested exactly, not raced against the time between them.
    for (const [ageMs, reaped] of [
      [TIGHT.deadAfter - 10, false],
      [TIGHT.deadAfter + 10, true],
    ] as const) {
      const outcome = await db
        .transaction(async (tx) => {
          const i = await registerInstance(db, "worker");
          createdInstances.push(i);
          await tx.execute(
            sql`update instances set heartbeat_at = now() - (${ageMs}::int * interval '1 millisecond') where id = ${i}`,
          );
          const crawlId = `crawl_reaper_${randomUUID()}`;
          const siteUrl = `https://reaper-${randomUUID()}.example/`;
          await tx.insert(crawls).values({
            tenantId: LOCAL_TENANT,
            id: crawlId,
            siteUrl,
            hostKey: hostKeyOf(siteUrl),
            config: storableConfig(crawlConfig(siteUrl)),
            rulesetVersion: RULESET_VERSION,
            status: "running",
          });
          const jobId = `job_${randomUUID()}`;
          await tx.insert(jobs).values({
            id: jobId,
            tenantId: LOCAL_TENANT,
            crawlId,
            kind: "crawl",
            status: "running",
            pinnedTo: i,
            claimedBy: i,
            rulesetVersion: RULESET_VERSION,
            extractionVersion: EXTRACTION_VERSION,
          });
          const summary = await reap([i], {}, tx);
          const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
          const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, crawlId));
          // Rolled back: the rows existed for this question only.
          throw Object.assign(new Error("rollback"), { result: { summary, job: job!.status, crawl: crawl!.status } });
        })
        .then(
          () => {
            throw new Error("the transaction was meant to roll back");
          },
          (error: { result?: { summary: ReapSummary; job: string; crawl: string } }) => {
            if (error.result === undefined) throw error;
            return error.result;
          },
        );
      expect(outcome, `heartbeat ${ageMs} ms old`).toEqual(
        reaped
          ? { summary: { ...NOTHING, abandonedJobs: 1, pausedCrawls: 1 }, job: "abandoned", crawl: "paused" }
          : { summary: NOTHING, job: "running", crawl: "running" },
      );
    }
  });

  it("two reapers in parallel over one dead job reap it once", async () => {
    for (let round = 0; round < 5; round += 1) {
      const d = await dead();
      const crawlId = await seedCrawl({ status: "running" });
      await seedJob(crawlId, { kind: "crawl", status: "running", pinnedTo: d, claimedBy: d });
      const [a, b] = await Promise.all([reap([d]), reap([d])]);
      expect(a!.abandonedJobs + b!.abandonedJobs, `round ${round}`).toBe(1);
      expect(a!.pausedCrawls + b!.pausedCrawls, `round ${round}`).toBe(1);
      expect(await crawlRow(crawlId)).toMatchObject({ status: "paused", pauseReason: "worker_lost" });
    }
  });
});

describe("reapOnce: housekeeping", () => {
  it("runs the credential retention sweep: a crawl finished 31 days ago loses its stored credentials, one finished 29 days ago keeps them", async () => {
    const now = new Date();
    const old = await seedCrawl({ status: "finished", finishedAt: new Date(now.getTime() - 31 * DAY) });
    const recent = await seedCrawl({ status: "finished", finishedAt: new Date(now.getTime() - 29 * DAY) });
    for (const crawlId of [old, recent]) {
      await db.transaction(async (tx) => {
        await vault.write(tx, LOCAL_TENANT, crawlId, { requestHeaders: { "X-Sweep": "v-S3CRET" } });
      });
    }
    // The tick must CALL the sweep — another suite's sweep could remove the
    // 31-day row too, so the row alone does not prove the reaper ran it.
    const calls: [Date, number][] = [];
    let swept = -1;
    const spy = Object.create(vault) as CredentialVault;
    spy.sweepExpired = async (at: Date, days: number) => {
      calls.push([at, days]);
      swept = await vault.sweepExpired(at, days);
      return swept;
    };
    const i = await instanceAt(0);
    const summary = await reapOnce(db, { now, timing: TIGHT, vault: spy, retentionDays: 30, onlyInstances: [i] });
    expect(calls).toEqual([[now, 30]]);
    expect(summary.credentialsSwept).toBe(swept);
    const left = await db
      .select({ crawlId: crawlCredentials.crawlId })
      .from(crawlCredentials)
      .where(inArray(crawlCredentials.crawlId, [old, recent]));
    expect(left.map((r) => r.crawlId)).toEqual([recent]);
  });

  it("deletes a dead instance's row once it is older than instanceRetention and holds no queued or running job", async () => {
    const timing = timingWith({ ...TIGHT, instanceRetention: 60_000 });
    const old = await instanceAt(2 * 60_000);
    const holding = await instanceAt(2 * 60_000);
    const recent = await instanceAt(30_000);
    const live = await instanceAt(0);
    // A queued job pinned to `holding`: crawl_resume's to adopt, so its row stays.
    const crawlId = await seedCrawl({ status: "queued" });
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: holding });
    const summary = await reap([old, holding, recent, live], { timing });
    expect(summary).toEqual({ ...NOTHING, instancesDeleted: 1 });
    const left = await db.select({ id: instances.id }).from(instances).where(inArray(instances.id, [old, holding, recent, live]));
    expect(left.map((r) => r.id).sort()).toEqual([holding, recent, live].sort());
  });
});

describe("held means held by a live instance", () => {
  it("a render job of a dead instance does not block crawl_cancel — before any reaper runs — and a live one still does", async () => {
    const service = newService();
    const crawlId = await seedCrawl({ status: "paused", pauseReason: "request" }, `${site}/`);
    const d = await dead();
    const deadJob = await seedJob(crawlId, { kind: "render", status: "running", pinnedTo: d, claimedBy: d });
    const answer = await service.cancelCrawl(LOCAL_TENANT, crawlId);
    expect(answer).toMatchObject({ status: "cancelled", immediate: true });
    // Not the cancel's to settle: the row is the reaper's (or an adopter's).
    expect((await jobRow(deadJob)).status).toBe("running");

    const other = await seedCrawl({ status: "paused", pauseReason: "request" }, `${site}/`);
    const liveId = await service.instanceId();
    const liveJob = await seedJob(other, { kind: "render", status: "running", pinnedTo: liveId, claimedBy: liveId });
    try {
      await expect(service.cancelCrawl(LOCAL_TENANT, other)).rejects.toThrow(/a render pass is running/);
    } finally {
      await db.update(jobs).set({ status: "abandoned" }).where(eq(jobs.id, liveJob));
    }
  });

  it("a rules job of a dead instance does not refuse a new crawl_rules: the new run adopts the crawl", async () => {
    const crawlId = await seedCrawl({ status: "finished" });
    const d = await dead();
    const deadJob = await seedJob(crawlId, { kind: "rules", status: "running", pinnedTo: d, claimedBy: d });
    const live = await instanceAt(0);
    const result = await withPinnedJob(
      db,
      { tenant: LOCAL_TENANT, crawlId, kind: "rules", instanceId: live, deadAfterMs: TIGHT.deadAfter },
      async () => "judged",
    );
    expect(result).toBe("judged");
    expect((await jobRow(deadJob)).status).toBe("abandoned");
    expect((await jobsOf(crawlId)).map((j) => j.status)).toEqual(["abandoned", "done"]);
  });

  it("a crawl job held by a dead instance does not hold its host: another crawl of that host is claimed", async () => {
    const host = `https://dead-host-${randomUUID()}.example/`;
    const d = await dead();
    const theirs = await seedCrawl({ status: "running" }, host);
    await seedJob(theirs, { kind: "crawl", status: "running", pinnedTo: d, claimedBy: d });

    const pinnedTo = `test-pin-${randomUUID()}`;
    const mine = await seedCrawl({ status: "queued" }, host);
    const queued = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: mine, kind: "crawl", pinnedTo });
    const live = await instanceAt(0);
    const claimed = await claimNextJob(db, { instanceId: live, kinds: ["crawl"], pinnedTo, deadAfterMs: TIGHT.deadAfter });
    expect(claimed?.id).toBe(queued);
    // And a LIVE holder still holds it: the claim of a third waits.
    const third = await seedCrawl({ status: "queued" }, host);
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: third, kind: "crawl", pinnedTo });
    expect(await claimNextJob(db, { instanceId: live, kinds: ["crawl"], pinnedTo, deadAfterMs: TIGHT.deadAfter })).toBeNull();
    await db.update(jobs).set({ status: "abandoned" }).where(inArray(jobs.crawlId, [mine, third]));
  });
});

describe("a runner that lost its job", () => {
  async function queuedSiteCrawl(): Promise<string> {
    return seedCrawl({ status: "queued" }, `${site}/`);
  }

  function crawlRunner(instanceId: string, log: string[]): JobRunner {
    return new JobRunner(db, {
      instanceId,
      kinds: ["crawl"],
      pinnedTo: instanceId,
      concurrency: 1,
      log: (line) => log.push(line),
      execute: crawlJobExecutor({
        db,
        vault,
        processTrust: { allowPrivate: true },
        log: (line) => log.push(line),
        logPrefix: "worker",
      }),
      timing: TIGHT,
    });
  }

  async function pagesOf(crawlId: string): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.crawlId, crawlId));
    return row?.n ?? 0;
  }

  it("aborts a job whose row was abandoned under it: the crawl stops and the job stays abandoned", async () => {
    const i = await instanceAt(0);
    const crawlId = await queuedSiteCrawl();
    const job = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: i });
    const log: string[] = [];
    const runner = crawlRunner(i, log);
    runner.start();
    try {
      await until("the crawl running with a page", async () => [(await crawlRow(crawlId)).status, await pagesOf(crawlId)] as const, ([s, n]) => s === "running" && n > 0);
      // Somebody else settled it: a reaper that read this runner as dead.
      await db.update(jobs).set({ status: "abandoned", finishedAt: new Date() }).where(eq(jobs.id, job));
      await until("the runner let it go", () => runner.runningJobIds().length, (n) => n === 0, 10_000);
      // Nobody else holds it, so the run's own close stands: a stop.
      expect(await crawlRow(crawlId)).toMatchObject({ status: "paused", pauseReason: "shutdown" });
      expect((await jobRow(job)).status).toBe("abandoned");
      expect(log.some((l) => l.includes(job) && l.includes("no longer"))).toBe(true);
    } finally {
      await runner.stop();
    }
  }, 60_000);

  it("a run whose crawl another holder has since taken writes nothing at its close", async () => {
    const i = await instanceAt(0);
    const crawlId = await queuedSiteCrawl();
    const job = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: i });
    const log: string[] = [];
    const runner = crawlRunner(i, log);
    runner.start();
    const adopter = `test-pin-${randomUUID()}`;
    try {
      await until("the crawl running with a page", async () => [(await crawlRow(crawlId)).status, await pagesOf(crawlId)] as const, ([s, n]) => s === "running" && n > 0);
      // Adopted as crawl_resume adopts an orphan: its job abandoned, the crawl
      // queued again with a fresh job (here pinned where no runner claims it).
      await db.transaction(async (tx) => {
        await tx.update(jobs).set({ status: "abandoned", finishedAt: new Date() }).where(eq(jobs.id, job));
        await tx.update(crawls).set({ status: "queued" }).where(eq(crawls.id, crawlId));
        await enqueueJob(tx, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: adopter });
      });
      const queuedRow = await crawlRow(crawlId);
      await until("the runner let it go", () => runner.runningJobIds().length, (n) => n === 0, 10_000);
      const after = await crawlRow(crawlId);
      expect(after.status).toBe("queued");
      expect(after.pauseReason).toBeNull();
      expect(after.finishedAt).toEqual(queuedRow.finishedAt);
      expect((await jobsOf(crawlId)).map((j) => [j.status, j.pinnedTo])).toEqual([
        ["abandoned", i],
        ["queued", adopter],
      ]);
      expect(log.some((l) => l.includes(crawlId) && l.includes("taken"))).toBe(true);
    } finally {
      await runner.stop();
      await db.update(jobs).set({ status: "abandoned" }).where(and(eq(jobs.crawlId, crawlId), eq(jobs.status, "queued")));
    }
  }, 60_000);

  it("a job abandoned between its claim and the crawl's start never starts the crawl", async () => {
    const i = await instanceAt(0);
    const crawlId = await queuedSiteCrawl();
    await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo: i });
    const claimed = (await claimNextJob(db, { instanceId: i, kinds: ["crawl"], pinnedTo: i, deadAfterMs: TIGHT.deadAfter })) as ClaimedJob;
    expect(claimed.crawlId).toBe(crawlId);
    await db.update(jobs).set({ status: "abandoned", finishedAt: new Date() }).where(eq(jobs.id, claimed.id));

    // The loop's own claim: conditioned on the job, it loses cleanly.
    const lost = await resumeCrawl(db, crawlId, {
      expectStatus: "queued",
      config: crawlConfig(),
      owner: { jobId: claimed.id, instanceId: i },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(lost).toBeInstanceOf(JobLostError);
    expect(lost).toBeInstanceOf(ClaimLostError);

    // And the runner's path: logged, nothing written.
    const log: string[] = [];
    await crawlJobExecutor({ db, vault, processTrust: { allowPrivate: true }, log: (l) => log.push(l) })(
      claimed,
      new AbortController().signal,
    );
    expect(log.some((l) => l.includes(crawlId) && l.includes("not started"))).toBe(true);
    const row = await crawlRow(crawlId);
    expect(row.status).toBe("queued");
    expect(row.discovery).toBeNull();
    expect((await jobRow(claimed.id)).status).toBe("abandoned");
    const [{ n } = { n: -1 }] = await db.select({ n: sql<number>`count(*)::int` }).from(frontier).where(eq(frontier.crawlId, crawlId));
    expect(n).toBe(0);
  });
});

describe("crawl_resume and auto_resume_count", () => {
  it("crawl_resume resets the count to 0", async () => {
    const service = newService();
    const crawlId = await seedCrawl({ status: "paused", pauseReason: "worker_lost", autoResumeCount: 2 }, `${site}/`);
    await service.resumeCrawl(LOCAL_TENANT, crawlId);
    expect((await crawlRow(crawlId)).autoResumeCount).toBe(0);
    await until("the resumed crawl running", () => crawlRow(crawlId), (row) => row.status === "running");
    await service.cancelCrawl(LOCAL_TENANT, crawlId);
    await until("the crawl closed", () => crawlRow(crawlId), (row) => row.status === "cancelled");
  }, 60_000);
});

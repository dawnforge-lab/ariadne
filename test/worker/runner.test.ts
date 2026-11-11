/**
 * The runner and the service over the durable queue (Phase 28b Task 3).
 *
 *  - `JobRunner` over fake work: concurrency, settling, stop.
 *  - The in-process service: queue positions from SQL, `crawl_status.job`,
 *    and `close()` — the running crawl pauses `shutdown`, the queued one stays
 *    queued.
 *  - Review Focus 3: a pause or cancel of a queued crawl nobody has claimed
 *    abandons its job in the same step; one a runner claimed at that instant
 *    is lost by the runner (`ClaimLostError`), which writes nothing.
 *  - Restart: a crawl accepted by server A and never claimed is run to the
 *    end by runner B after A is gone. Before 28b it was stranded.
 *  - Reaping and auto-resume (28b T4b): a dead worker's crawl is requeued and
 *    finished by another runner; the three-times cap; which pauses resume by
 *    themselves. Here because a requeue enqueues an UNPINNED job, and the pool
 *    is this file's (below). The rest of the reaper is test/worker/reaper.test.ts.
 *
 * THE UNPINNED POOL IS THIS FILE'S ALONE. The in-process services of every
 * other suite pin the crawl jobs they accept to themselves and claim only
 * those, so the only runner anywhere in the suite that claims unpinned jobs is
 * runner B below, and the only unpinned jobs are the ones this file's
 * `workers`-mode services enqueue. Tests run in order within a file. The
 * pool's fairness tests (28b T4a: the per-tenant cap, positions of another
 * engine version's jobs) claim it too, and clear it of claimable leftovers an
 * interrupted earlier run may have left first (`clearPool`).
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, instances, jobs, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { ClaimLostError, resumeCrawl } from "../../src/crawl/loop.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { EXTRACTION_VERSION } from "../../src/crawl/versions.js";
import { ApiService } from "../../src/api/service.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { LOCAL_TENANT, parseTenant, type TenantId } from "../../src/tenant.js";
import { createApiServer } from "../../src/api/http.js";
import { claimNextJob, enqueueJob, queuePositionOf, type ClaimedJob } from "../../src/worker/jobs.js";
import { registerInstance } from "../../src/worker/instance.js";
import { JobRunner, parseTenantMaxRunning } from "../../src/worker/runner.js";
import { crawlJobExecutor } from "../../src/worker/crawl-job.js";
import { reapOnce, type ReapSummary } from "../../src/worker/reaper.js";
import { timingWith } from "../../src/worker/timing.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

const PAGE_DELAY_MS = 100;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let db: Db;
let siteServer: Server;
let site: string;
let exportDir: string;
let renderDir: string;
const createdCrawls: string[] = [];
const createdInstances: string[] = [];
const services: ApiService[] = [];

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

function newService(log: string[], extra: Partial<ServiceConfig> = {}): ApiService {
  const service = new ApiService(db, serviceConfig(log, extra));
  services.push(service);
  return service;
}

async function start(service: ApiService, maxPages = 400): Promise<{ crawlId: string; queuePosition: number }> {
  const accepted = await service.startCrawl(LOCAL_TENANT, {
    siteUrl: `${site}/`,
    maxPages,
    maxConcurrency: 1,
  });
  createdCrawls.push(accepted.crawlId);
  return { crawlId: accepted.crawlId, queuePosition: accepted.queuePosition };
}

async function crawlRow(id: string): Promise<typeof crawls.$inferSelect> {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl ${id}`);
  return row;
}

async function jobsOf(crawlId: string): Promise<(typeof jobs.$inferSelect)[]> {
  return db.select().from(jobs).where(eq(jobs.crawlId, crawlId)).orderBy(jobs.queuedAt);
}

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${JSON.stringify(value)})`);
    await sleep(25);
  }
}

/** A crawl row on a host of its own unless `siteUrl` names one (host exclusivity, 28b T4a). */
async function seedCrawl(
  status = "finished",
  siteUrl = `https://runner-${randomUUID()}.example/`,
  tenant: TenantId = LOCAL_TENANT,
): Promise<string> {
  const id = `crawl_runner_${randomUUID()}`;
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

/**
 * The unpinned pool is this file's alone, but an interrupted earlier run can
 * leave claimable jobs in it, and a claim takes the oldest first. Settled
 * before a test that claims the pool reads it. (Jobs of another engine
 * version are nobody's claim here, and are left.)
 */
async function clearPool(): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "abandoned", finishedAt: new Date() })
    .where(
      and(
        eq(jobs.status, "queued"),
        isNull(jobs.pinnedTo),
        eq(jobs.rulesetVersion, RULESET_VERSION),
        eq(jobs.extractionVersion, EXTRACTION_VERSION),
      ),
    );
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-runner-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-runner-render-"));
  // An endless tree of slow pages (test/api/lifecycle.test.ts's site): a crawl
  // of it at concurrency 1 is still running whenever a test needs it to be.
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
    }, PAGE_DELAY_MS);
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
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  if (createdInstances.length > 0) await db.delete(instances).where(inArray(instances.id, createdInstances));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
}, 60_000);

describe("JobRunner", () => {
  it("runs up to its concurrency, settles each job by how its work ended, and leaves the rest queued on stop", async () => {
    const pinnedTo = `test-pin-${randomUUID()}`;
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "rules", pinnedTo }));
    }
    const started: string[] = [];
    const release = new Map<string, (outcome: "ok" | "throw") => void>();
    const aborted: string[] = [];
    const runner = new JobRunner(db, {
      instanceId: pinnedTo,
      kinds: ["rules"],
      pinnedTo,
      concurrency: 2,
      log: () => {},
      execute: (job: ClaimedJob, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          started.push(job.id);
          signal.addEventListener("abort", () => {
            aborted.push(job.id);
            resolve();
          });
          release.set(job.id, (outcome) => (outcome === "ok" ? resolve() : reject(new Error("work failed"))));
        }),
      timing: { claimPoll: 20 },
    });
    runner.start();
    await until("two jobs running", async () => runner.runningJobIds().length, (n) => n === 2);
    expect(new Set(runner.runningJobIds())).toEqual(new Set(ids.slice(0, 2)));
    expect(started).toEqual(ids.slice(0, 2));

    release.get(ids[0]!)!("ok");
    release.get(ids[1]!)!("throw");
    await until("the next two running", async () => [...runner.runningJobIds()].sort().join(), (s) => s === [...ids.slice(2)].sort().join());
    const settled = await db.select().from(jobs).where(inArray(jobs.id, ids.slice(0, 2)));
    const byId = new Map(settled.map((j) => [j.id, j]));
    expect(byId.get(ids[0]!)).toMatchObject({ status: "done", error: null });
    expect(byId.get(ids[1]!)).toMatchObject({ status: "failed", error: "work failed" });

    // A fifth job waits: the runner is full.
    const fifth = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId: await seedCrawl(), kind: "rules", pinnedTo });
    await runner.stop();
    expect(new Set(aborted)).toEqual(new Set(ids.slice(2)));
    expect(runner.runningJobIds()).toEqual([]);
    const after = await db.select().from(jobs).where(inArray(jobs.id, [...ids.slice(2), fifth]));
    const status = new Map(after.map((j) => [j.id, j.status]));
    // Work that ended because the runner stopped is abandoned, not done.
    expect(status.get(ids[2]!)).toBe("abandoned");
    expect(status.get(ids[3]!)).toBe("abandoned");
    expect(status.get(fifth)).toBe("queued");
    // A stopped runner claims nothing more.
    await sleep(100);
    expect((await db.select().from(jobs).where(eq(jobs.id, fifth)))[0]?.status).toBe("queued");
  });
});

describe("the in-process service over the queue", () => {
  it("answers queue positions 0, 1, 2, 3 from the database, and crawl_status carries the job", async () => {
    const log: string[] = [];
    const service = newService(log);
    const accepted = [];
    for (let i = 0; i < 4; i += 1) accepted.push(await start(service));
    expect(accepted.map((a) => a.queuePosition)).toEqual([0, 1, 2, 3]);
    const [a, b, c, d] = accepted.map((x) => x.crawlId) as [string, string, string, string];

    const positions = await Promise.all([a, b, c, d].map((id) => service.queuePosition(id)));
    expect(positions).toEqual([0, 1, 2, 3]);

    const instanceId = await service.instanceId();
    await until("the first crawl running", () => service.getCrawl(LOCAL_TENANT, a), (x) => x.status === "running");
    const running = await service.getCrawl(LOCAL_TENANT, a);
    expect(running.job).toEqual({ kind: "crawl", status: "running", claimedBy: instanceId });
    const waiting = await service.getCrawl(LOCAL_TENANT, c);
    expect(waiting.status).toBe("queued");
    expect(waiting.queuePosition).toBe(2);
    expect(waiting.job).toEqual({ kind: "crawl", status: "queued" });

    // The crawl jobs this service accepted are pinned to it.
    for (const id of [a, b, c, d]) expect((await jobsOf(id))[0]?.pinnedTo).toBe(instanceId);

    // Cleared: the three queued cancel at once, the running one on request.
    for (const id of [d, c, b]) expect((await service.cancelCrawl(LOCAL_TENANT, id)).immediate).toBe(true);
    for (const id of [b, c, d]) expect((await jobsOf(id)).map((j) => j.status)).toEqual(["abandoned"]);
    await service.cancelCrawl(LOCAL_TENANT, a);
    await until("the first crawl closed", () => crawlRow(a), (row) => row.status === "cancelled");
    // The job settles in the close's own transaction: no window in which the
    // crawl reads closed and its job still holds it.
    expect((await jobsOf(a)).map((j) => j.status)).toEqual(["done"]);
    const closed = await service.getCrawl(LOCAL_TENANT, a);
    expect(closed.job).toEqual({ kind: "crawl", status: "done", claimedBy: instanceId });
    expect(closed.queuePosition).toBeNull();
  });

  it("close(): the running crawl pauses `shutdown` and its job is abandoned; the queued one stays queued, and the log says so", async () => {
    const log: string[] = [];
    const service = newService(log);
    const x = await start(service);
    const y = await start(service);
    expect([x.queuePosition, y.queuePosition]).toEqual([0, 1]);
    await until("x running", () => crawlRow(x.crawlId), (row) => row.status === "running");
    const instanceId = await service.instanceId();

    await service.close();

    expect(await crawlRow(x.crawlId)).toMatchObject({ status: "paused", pauseReason: "shutdown" });
    expect((await jobsOf(x.crawlId)).map((j) => j.status)).toEqual(["abandoned"]);
    expect((await crawlRow(y.crawlId)).status).toBe("queued");
    expect(await jobsOf(y.crawlId)).toMatchObject([{ status: "queued", pinnedTo: instanceId, claimedBy: null }]);
    expect(log.some((line) => line.includes(y.crawlId) && line.includes("stay queued"))).toBe(true);
    await expect(start(service)).rejects.toThrow(/shutting down/);
  });
});

describe("pause and cancel of a queued crawl (Review Focus 3)", () => {
  async function queuedUnclaimed(service: ApiService): Promise<string> {
    const { crawlId } = await start(service, 3);
    expect(await jobsOf(crawlId)).toMatchObject([{ status: "queued", pinnedTo: null }]);
    return crawlId;
  }

  it.each(["pause", "cancel"] as const)("%s of an unclaimed crawl abandons its job with the status change", async (op) => {
    const service = newService([], { crawlRunner: "workers" });
    const id = await queuedUnclaimed(service);
    const answer = op === "pause" ? await service.pauseCrawl(LOCAL_TENANT, id) : await service.cancelCrawl(LOCAL_TENANT, id);
    expect(answer.immediate).toBe(true);
    expect((await crawlRow(id)).status).toBe(op === "pause" ? "paused" : "cancelled");
    expect((await jobsOf(id)).map((j) => j.status)).toEqual(["abandoned"]);
    expect(await service.queuePosition(id)).toBeNull();
  });

  it.each(["pause", "cancel"] as const)(
    "%s racing a runner's claim: the runner loses with ClaimLostError and writes nothing",
    async (op) => {
      const service = newService([], { crawlRunner: "workers" });
      const id = await queuedUnclaimed(service);
      // The runner of this test claims it — under a pin of its own, so no
      // other runner can take this job first.
      const pinnedTo = `test-pin-${randomUUID()}`;
      await db.update(jobs).set({ pinnedTo }).where(eq(jobs.crawlId, id));
      const claimed = await claimNextJob(db, { instanceId: pinnedTo, kinds: ["crawl"], pinnedTo });
      expect(claimed?.crawlId).toBe(id);

      // The agent's call lands between the claim and the loop's own claim.
      const answer = op === "pause" ? await service.pauseCrawl(LOCAL_TENANT, id) : await service.cancelCrawl(LOCAL_TENANT, id);
      expect(answer.immediate).toBe(true);
      const decided = await crawlRow(id);
      expect(decided.status).toBe(op === "pause" ? "paused" : "cancelled");
      // A claimed job is not the pause's to settle: its runner holds it.
      expect((await jobsOf(id)).map((j) => j.status)).toEqual(["running"]);

      // The loop's compare-and-swap is what the runner then meets.
      await expect(resumeCrawl(db, id, { expectStatus: "queued" })).rejects.toBeInstanceOf(ClaimLostError);

      const runnerLog: string[] = [];
      const execute = crawlJobExecutor({
        db,
        vault: new CredentialVault(db, TEST_CREDENTIAL_KEYS),
        processTrust: { allowPrivate: true },
        log: (line) => runnerLog.push(line),
      });
      await execute(claimed!, new AbortController().signal);

      expect(runnerLog.some((l) => l.includes(id) && l.includes("not started"))).toBe(true);
      expect((await jobsOf(id)).map((j) => j.status)).toEqual(["abandoned"]);
      // Nothing written: the row is as the agent's call left it, and the crawl never began.
      const after = await crawlRow(id);
      expect(after).toEqual(decided);
      expect(after.discovery).toBeNull();
      const [{ n: frontierRows } = { n: -1 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(frontier)
        .where(eq(frontier.crawlId, id));
      const [{ n: pageRows } = { n: -1 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.crawlId, id));
      expect([frontierRows, pageRows]).toEqual([0, 0]);
    },
  );
});

describe("restart", () => {
  it("a crawl accepted by server A and never claimed is run to the end by runner B after A is gone", async () => {
    const aLog: string[] = [];
    const a = newService(aLog, { crawlRunner: "workers" });
    const { crawlId, queuePosition } = await start(a, 3);
    expect(queuePosition).toBeGreaterThanOrEqual(1);
    await a.close();
    expect((await crawlRow(crawlId)).status).toBe("queued");
    expect(await jobsOf(crawlId)).toMatchObject([{ status: "queued", pinnedTo: null, claimedBy: null }]);

    const instanceId = await registerInstance(db, "worker");
    createdInstances.push(instanceId);
    // ISOLATED: a runner over the whole unpinned pool takes it oldest-first,
    // so a job some interrupted earlier run left there would be claimed before
    // this one. The test hands this job, and only it, to runner B by pinning
    // it to B — the claim, the run and the settle are the pool's own.
    const moved = await db
      .update(jobs)
      .set({ pinnedTo: instanceId })
      .where(eq(jobs.crawlId, crawlId))
      .returning({ id: jobs.id });
    expect(moved).toHaveLength(1);
    const bLog: string[] = [];
    const runner = new JobRunner(db, {
      instanceId,
      kinds: ["crawl"],
      pinnedTo: instanceId,
      concurrency: 1,
      log: (line) => bLog.push(line),
      execute: crawlJobExecutor({
        db,
        vault: new CredentialVault(db, TEST_CREDENTIAL_KEYS),
        processTrust: { allowPrivate: true },
        log: (line) => bLog.push(line),
      }),
      timing: { claimPoll: 50 },
    });
    runner.start();
    try {
      const done = await until(
        "B finished the crawl A accepted",
        () => crawlRow(crawlId),
        (row) => row.status !== "queued" && row.status !== "running",
        90_000,
      );
      expect(done.status).toBe("finished");
      expect(done.pagesCrawled).toBe(3);
      expect(await jobsOf(crawlId)).toMatchObject([{ status: "done", claimedBy: instanceId, pinnedTo: instanceId }]);
    } finally {
      await runner.stop();
    }
  }, 120_000);
});

describe("liveness decides held (Ruling R10)", () => {
  it("a closed in-process server's queued crawls are nobody's: position null, crawl_mark_failed retires one, crawl_resume elsewhere adopts and finishes one", async () => {
    const a = newService([]);
    const x = await start(a);
    const y = await start(a, 3);
    const z = await start(a, 3);
    expect([x.queuePosition, y.queuePosition, z.queuePosition]).toEqual([0, 1, 2]);
    await until("x running", () => crawlRow(x.crawlId), (row) => row.status === "running");
    const aInstance = await a.instanceId();
    await a.close();
    // Never claimed: queued, pinned to A, which is stopped.
    for (const id of [y.crawlId, z.crawlId]) {
      expect(await jobsOf(id)).toMatchObject([{ status: "queued", pinnedTo: aInstance, claimedBy: null }]);
    }

    const bLog: string[] = [];
    const b = newService(bLog);
    expect(await b.queuePosition(y.crawlId)).toBeNull();
    const zStatus = await b.getCrawl(LOCAL_TENANT, z.crawlId);
    expect(zStatus).toMatchObject({ status: "queued", queuePosition: null, job: { kind: "crawl", status: "queued" } });

    // crawl_mark_failed: not "held by this server" — nobody holds it.
    const failed = await b.markCrawlFailed(LOCAL_TENANT, y.crawlId);
    expect(failed.status).toBe("failed");
    expect((await jobsOf(y.crawlId)).map((j) => j.status)).toEqual(["abandoned"]);

    // The usual restart is a deploy: the orphan was enqueued by code with
    // another ruleset (and B's runner claims only its own versions). Stamped
    // here on the row, as an older process would have written it.
    const [orphan] = await jobsOf(z.crawlId);
    await db.update(jobs).set({ rulesetVersion: "0.0.0-before-the-deploy" }).where(eq(jobs.id, orphan!.id));

    // crawl_resume: B adopts the crawl — the orphan job abandoned, a fresh one
    // with THIS code's versions queued for B — and runs it.
    const resumed = await b.resumeCrawl(LOCAL_TENANT, z.crawlId);
    expect(resumed).toMatchObject({ crawlId: z.crawlId, status: "queued" });
    const bInstance = await b.instanceId();
    const adopted = await jobsOf(z.crawlId);
    expect(adopted).toHaveLength(2);
    expect(adopted[0]).toMatchObject({ id: orphan!.id, status: "abandoned", pinnedTo: aInstance, claimedBy: null });
    expect(adopted[1]).toMatchObject({
      pinnedTo: bInstance,
      rulesetVersion: RULESET_VERSION,
      extractionVersion: EXTRACTION_VERSION,
    });
    expect(bLog.some((l) => l.includes(z.crawlId) && l.includes("adopted"))).toBe(true);
    const done = await until(
      "B finished the adopted crawl",
      () => crawlRow(z.crawlId),
      (row) => row.status !== "queued" && row.status !== "running",
    );
    expect(done).toMatchObject({ status: "finished", pagesCrawled: 3 });
    expect(await jobsOf(z.crawlId)).toMatchObject([
      { id: orphan!.id, status: "abandoned" },
      { id: adopted[1]!.id, status: "done", claimedBy: bInstance, pinnedTo: bInstance },
    ]);
  }, 90_000);

  it("a live server's queued crawl is still held: another server's crawl_mark_failed and crawl_resume refuse", async () => {
    const s = newService([]);
    const x = await start(s);
    const y = await start(s, 3);
    expect(y.queuePosition).toBe(1);
    const t = newService([]);
    expect(await t.queuePosition(y.crawlId)).toBe(1);
    await expect(t.markCrawlFailed(LOCAL_TENANT, y.crawlId)).rejects.toThrow(/held by this server/);
    await expect(t.resumeCrawl(LOCAL_TENANT, y.crawlId)).rejects.toThrow(/already held by this server/);
    expect(await jobsOf(y.crawlId)).toMatchObject([{ status: "queued", pinnedTo: await s.instanceId() }]);
    await s.cancelCrawl(LOCAL_TENANT, y.crawlId);
    await s.cancelCrawl(LOCAL_TENANT, x.crawlId);
    await until("x closed", () => crawlRow(x.crawlId), (row) => row.status === "cancelled");
  }, 60_000);

  it("a runner heartbeats its instance every timing.heartbeat", async () => {
    const id = await registerInstance(db, "worker");
    createdInstances.push(id);
    await db.execute(sql`update instances set heartbeat_at = now() - interval '1 hour' where id = ${id}`);
    const runner = new JobRunner(db, {
      instanceId: id,
      kinds: ["rules"],
      pinnedTo: `test-pin-${randomUUID()}`,
      concurrency: 1,
      execute: async () => {},
      log: () => {},
      timing: { heartbeat: 50, deadAfter: 300, claimPoll: 1_000 },
    });
    runner.start();
    try {
      await until(
        "a heartbeat",
        async () => {
          const [row] = await db
            .select({ age: sql<number>`extract(epoch from now() - heartbeat_at)::float` })
            .from(instances)
            .where(eq(instances.id, id));
          return row?.age ?? Number.POSITIVE_INFINITY;
        },
        (age) => age < 5,
        10_000,
      );
    } finally {
      await runner.stop();
    }
  });

  it("a service that has begun closing starts no runner for a job enqueued as it closed", async () => {
    const log: string[] = [];
    const service = newService(log);
    await service.close();
    await (service as unknown as { afterEnqueue(): Promise<void> }).afterEnqueue();
    expect(log.some((l) => l.includes("no runner is started"))).toBe(true);
    expect((service as unknown as { runner: unknown }).runner).toBeNull();
  });
});

describe("fair claims over the unpinned pool, and HOST_BUSY (28b T4a)", () => {
  const short = (): string => randomUUID().slice(0, 8);

  async function queueUnpinned(tenant: TenantId): Promise<string> {
    return enqueueJob(db, { tenant, crawlId: await seedCrawl("queued", undefined, tenant), kind: "crawl" });
  }

  const sorted = (ids: readonly string[]): string[] => [...ids].sort();

  it("with ARIADNE_TENANT_MAX_RUNNING = 1, tenant t1's second crawl waits while t2's runs", async () => {
    await clearPool();
    const t1 = parseTenant(`t1-${short()}`);
    const t2 = parseTenant(`t2-${short()}`);
    const t1a = await queueUnpinned(t1);
    const t1b = await queueUnpinned(t1);
    const t2a = await queueUnpinned(t2);
    const instanceId = await registerInstance(db, "worker");
    createdInstances.push(instanceId);
    const release = new Map<string, () => void>();
    const runner = new JobRunner(db, {
      instanceId,
      kinds: ["crawl"],
      pinnedTo: null,
      concurrency: 3,
      maxRunningPerTenant: parseTenantMaxRunning("1"),
      log: () => {},
      timing: { claimPoll: 20 },
      execute: (job: ClaimedJob, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          release.set(job.id, resolve);
          signal.addEventListener("abort", () => resolve());
        }),
    });
    const running = async (): Promise<string[]> => sorted(runner.runningJobIds());
    runner.start();
    try {
      await until("t1's first and t2's running", running, (ids) => ids.join() === sorted([t1a, t2a]).join(), 10_000);
      // The runner has room for a third, and many claim polls pass: t1 is at its cap.
      await sleep(200);
      expect(await running()).toEqual(sorted([t1a, t2a]));
      expect((await db.select().from(jobs).where(eq(jobs.id, t1b)))[0]?.status).toBe("queued");

      release.get(t1a)!();
      await until("t1's second running", running, (ids) => ids.join() === sorted([t1b, t2a]).join(), 10_000);
    } finally {
      await runner.stop();
    }
  });

  it("a cap of 2 runs two of a tenant's crawls; a tenant's pinned (in-process) running crawls do not count against it", async () => {
    await clearPool();
    const t = parseTenant(`tc-${short()}`);
    // A pinned crawl of t running: an in-process service's, not the pool's.
    const pinnedTo = `test-pin-${randomUUID()}`;
    const pinned = await enqueueJob(db, { tenant: t, crawlId: await seedCrawl("queued", undefined, t), kind: "crawl", pinnedTo });
    expect((await claimNextJob(db, { instanceId: pinnedTo, kinds: ["crawl"], pinnedTo }))?.id).toBe(pinned);

    const x = await queueUnpinned(t);
    const y = await queueUnpinned(t);
    const z = await queueUnpinned(t);
    // A live claimer: a dead process's running jobs count against no cap (28b T4b).
    const poolRunner = await registerInstance(db, "worker");
    createdInstances.push(poolRunner);
    const claim = (max: number): Promise<ClaimedJob | null> =>
      claimNextJob(db, { instanceId: poolRunner, kinds: ["crawl"], pinnedTo: null, maxRunningPerTenant: max });
    expect((await claim(1))?.id).toBe(x);
    expect(await claim(1)).toBeNull();
    expect((await claim(2))?.id).toBe(y);
    expect(await claim(2)).toBeNull();
    await db.update(jobs).set({ status: "abandoned" }).where(inArray(jobs.id, [pinned, x, y, z]));
  });

  it("a queued unpinned crawl job of another engine version is not positioned, and is not ahead of this version's", async () => {
    await clearPool();
    const t = parseTenant(`tv-${short()}`);
    const older = await seedCrawl("queued", undefined, t);
    await db.insert(jobs).values({
      id: `job_${randomUUID()}`,
      tenantId: t,
      crawlId: older,
      kind: "crawl",
      status: "queued",
      rulesetVersion: "0.0.0-another-deploy",
      extractionVersion: EXTRACTION_VERSION,
    });
    const current = await seedCrawl("queued", undefined, t);
    await enqueueJob(db, { tenant: t, crawlId: current, kind: "crawl" });
    // No runner of this code will take it: "waiting" would read as forever.
    expect(await queuePositionOf(db, older, 60_000)).toBeNull();
    expect(await queuePositionOf(db, current, 60_000)).toBe(1);
    // Not positioned is nobody's, as the crawl_status description tells the
    // agent: crawl_mark_failed retires it, and still refuses this version's.
    const service = newService([], { crawlRunner: "workers" });
    await expect(service.markCrawlFailed(t, current)).rejects.toThrow(/held by this server/);
    expect((await service.markCrawlFailed(t, older)).status).toBe("failed");
    expect((await jobsOf(older)).map((j) => j.status)).toEqual(["abandoned"]);
    await db.update(jobs).set({ status: "abandoned" }).where(inArray(jobs.crawlId, [older, current]));
  });

  it.each(["crawl_resume", "crawl_mark_failed"] as const)(
    "%s of an old deploy's orphan job refuses, and changes nothing, when a live runner claims that job between the call's read and its write",
    async (operation) => {
      await clearPool();
      // The window, held open by the TEST ONLY seam: after the reads called
      // the job an orphan, before the transaction that settles it. The "old
      // runner" claims it there, as the claim statement would.
      const window = { crawlId: "", jobId: "" };
      const oldRunner = `old-deploy-runner-${short()}`;
      const service = newService([], {
        crawlRunner: "workers",
        beforeOrphanSettle: async (op, crawlId) => {
          if (op !== operation || crawlId !== window.crawlId) return;
          await db
            .update(jobs)
            .set({ status: "running", claimedBy: oldRunner, claimedAt: new Date(), heartbeatAt: new Date() })
            .where(and(eq(jobs.id, window.jobId), eq(jobs.status, "queued")));
        },
      });
      const { crawlId } = await start(service, 3);
      const [job] = await jobsOf(crawlId);
      // Enqueued by the deploy before this one: nobody's to this code.
      await db.update(jobs).set({ rulesetVersion: "0.0.0-old-deploy" }).where(eq(jobs.id, job!.id));
      expect(await service.queuePosition(crawlId)).toBeNull();
      const before = await crawlRow(crawlId);
      Object.assign(window, { crawlId, jobId: job!.id });

      const refusal = await (operation === "crawl_resume"
        ? service.resumeCrawl(LOCAL_TENANT, crawlId)
        : service.markCrawlFailed(LOCAL_TENANT, crawlId)
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as { code?: unknown }).code).toBe("CONFLICT");
      expect((refusal as Error).message).toBe(
        `${operation} is refused for crawl ${crawlId}: its crawl job changed while this call ` +
          "was being checked — a live engine process claimed it, or another call settled it " +
          "first. Nothing was changed; read crawl_status and try again",
      );
      // The claimed job still runs, the one job of the crawl, and the crawl
      // row is as it was: the old runner's own queued → running wins.
      expect(await jobsOf(crawlId)).toMatchObject([{ id: job!.id, status: "running", claimedBy: oldRunner }]);
      expect(await crawlRow(crawlId)).toEqual(before);
      await db.update(jobs).set({ status: "abandoned" }).where(eq(jobs.id, job!.id));
    },
  );

  it("crawl_render on a crawl whose host has a running crawl job answers 409 HOST_BUSY, naming the host and not the crawl", async () => {
    const token = `test-token-runner-${randomUUID()}`;
    const log: string[] = [];
    const api = createApiServer({ db, config: { ...serviceConfig(log), token } });
    const base = `http://127.0.0.1:${(await api.listen(0)).port}`;
    const call = async (method: string, path: string, tenant: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "x-ariadne-tenant": tenant,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, text, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
    };
    try {
      const started = await call("POST", "/crawls", "local", { siteUrl: `${site}/`, maxPages: 400, maxConcurrency: 1 });
      expect(started.status, started.text).toBe(202);
      const running = String(started.body["crawlId"]);
      createdCrawls.push(running);
      await until("the crawl running", () => crawlRow(running), (row) => row.status === "running");

      // Another tenant's finished crawl of the same site.
      const other = parseTenant(`th-${short()}`);
      const finished = await seedCrawl("finished", `${site}/`, other);
      const refused = await call("POST", `/crawls/${finished}/render`, other);
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body["code"]).toBe("HOST_BUSY");
      const error = String(refused.body["error"]);
      expect(error).toContain(finished);
      expect(error).toContain(hostKeyOf(site));
      expect(error).not.toContain(running);
      expect(error).not.toContain("local");
      expect(await jobsOf(finished)).toEqual([]);

      expect((await call("POST", `/crawls/${running}/cancel`, "local")).status).toBe(202);
      await until("the crawl closed", () => crawlRow(running), (row) => row.status === "cancelled");
    } finally {
      await api.close();
    }
  }, 60_000);
});

describe("reaping and auto-resume over the pool (28b T4b)", () => {
  /** The brief's clock: heartbeat 50 ms, dead after 300 ms, a reaper every 100 ms. */
  const TIGHT = timingWith({ heartbeat: 50, deadAfter: 300, reapEvery: 100, claimPoll: 50 });

  /** A reaper tick confined to `only` (TEST ONLY): another suite's rows are never its. */
  function reap(only: readonly string[]): Promise<ReapSummary> {
    return reapOnce(db, {
      now: new Date(),
      timing: TIGHT,
      vault: new CredentialVault(db, TEST_CREDENTIAL_KEYS),
      // A century: this tick sweeps no other suite's credentials.
      retentionDays: 36_500,
      onlyInstances: only,
    });
  }

  async function deadInstance(): Promise<string> {
    const id = await registerInstance(db, "worker");
    createdInstances.push(id);
    await db.execute(sql`update instances set heartbeat_at = now() - interval '1 hour' where id = ${id}`);
    return id;
  }

  async function seedJob(crawlId: string, fields: Partial<typeof jobs.$inferInsert> & { status: string }): Promise<string> {
    const id = `job_${randomUUID()}`;
    await db.insert(jobs).values({
      id,
      tenantId: LOCAL_TENANT,
      crawlId,
      kind: "crawl",
      rulesetVersion: RULESET_VERSION,
      extractionVersion: EXTRACTION_VERSION,
      ...fields,
    });
    return id;
  }

  function poolRunner(instanceId: string): JobRunner {
    return new JobRunner(db, {
      instanceId,
      kinds: ["crawl"],
      pinnedTo: null,
      maxRunningPerTenant: 1,
      concurrency: 1,
      log: () => {},
      execute: crawlJobExecutor({
        db,
        vault: new CredentialVault(db, TEST_CREDENTIAL_KEYS),
        processTrust: { allowPrivate: true },
        log: () => {},
        logPrefix: "worker",
      }),
      timing: TIGHT,
    });
  }

  it("a job whose instance stopped heartbeating is abandoned; its crawl goes paused (worker_lost) and is requeued in the same tick; another runner finishes it with no duplicate pages", async () => {
    await clearPool();
    const service = newService([], { crawlRunner: "workers" });
    const maxPages = 12;
    const { crawlId } = await start(service, maxPages);
    const x = await registerInstance(db, "worker");
    createdInstances.push(x);
    const xRunner = poolRunner(x);
    xRunner.start();
    const pageCount = async (): Promise<number> => {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.crawlId, crawlId));
      return row?.n ?? 0;
    };
    await until(
      "X crawling, three pages in",
      async () => [(await crawlRow(crawlId)).status, await pageCount()] as const,
      ([s, n]) => s === "running" && n >= 3,
    );
    const [job] = await jobsOf(crawlId);

    // X DIES. A process cannot be killed inside a test, so X's loop is stopped
    // and its rows put back exactly as a kill leaves them: the crawl running,
    // its job running under X, URLs leased to X's workers, X's heartbeat stale.
    await xRunner.stop();
    const pending = await db
      .select({ url: frontier.url, attempts: frontier.attempts })
      .from(frontier)
      .where(and(eq(frontier.crawlId, crawlId), eq(frontier.state, "pending")))
      .orderBy(frontier.url)
      .limit(2);
    expect(pending).toHaveLength(2);
    await db.transaction(async (tx) => {
      await tx.update(crawls).set({ status: "running", pauseReason: null, finishedAt: null }).where(eq(crawls.id, crawlId));
      await tx.update(jobs).set({ status: "running", finishedAt: null }).where(eq(jobs.id, job!.id));
      await tx
        .update(frontier)
        .set({
          state: "leased",
          leaseId: "x-killed-worker",
          leasedUntil: new Date(Date.now() + 60 * 60 * 1000),
          attempts: sql`${frontier.attempts} + 1`,
        })
        .where(and(eq(frontier.crawlId, crawlId), inArray(frontier.url, pending.map((p) => p.url))));
      await tx.execute(sql`update instances set heartbeat_at = now() - interval '1 hour' where id = ${x}`);
    });

    const summary = await reap([x]);
    expect(summary).toEqual({
      abandonedJobs: 1,
      pausedCrawls: 1,
      cancelledCrawls: 0,
      requeuedCrawls: 1,
      credentialsSwept: 0,
      instancesDeleted: 0,
    });
    expect(await crawlRow(crawlId)).toMatchObject({ status: "queued", pauseReason: null, autoResumeCount: 1, finishedAt: null });
    const afterReap = await jobsOf(crawlId);
    expect(afterReap.map((j) => [j.status, j.pinnedTo, j.claimedBy])).toEqual([
      ["abandoned", null, x],
      ["queued", null, null],
    ]);
    expect(afterReap[1]).toMatchObject({ rulesetVersion: RULESET_VERSION, extractionVersion: EXTRACTION_VERSION });
    // X's leases are back, their attempts refunded: a killed fetch was never tried.
    const released = await db
      .select({ url: frontier.url, state: frontier.state, attempts: frontier.attempts, leaseId: frontier.leaseId })
      .from(frontier)
      .where(and(eq(frontier.crawlId, crawlId), inArray(frontier.url, pending.map((p) => p.url))))
      .orderBy(frontier.url);
    expect(released).toEqual(pending.map((p) => ({ url: p.url, state: "pending", attempts: p.attempts, leaseId: null })));

    const y = await registerInstance(db, "worker");
    createdInstances.push(y);
    const yRunner = poolRunner(y);
    yRunner.start();
    try {
      const done = await until(
        "Y finished the crawl X lost",
        () => crawlRow(crawlId),
        (row) => row.status !== "queued" && row.status !== "running",
        90_000,
      );
      expect(done).toMatchObject({ status: "finished", pagesCrawled: maxPages });
      const duplicates = await db.execute(
        sql`select url, count(*)::int as n from pages where crawl_id = ${crawlId} group by url having count(*) > 1`,
      );
      expect(duplicates.rows).toEqual([]);
      expect(await pageCount()).toBe(maxPages);
      expect((await jobsOf(crawlId)).map((j) => [j.status, j.claimedBy])).toEqual([
        ["abandoned", x],
        ["done", y],
      ]);
    } finally {
      await yRunner.stop();
    }
  }, 120_000);

  it("a crawl reaped worker_lost a fourth time stays paused, with auto_resume_count = 3", async () => {
    await clearPool();
    const d = await deadInstance();
    const crawlId = await seedCrawl("running");
    await seedJob(crawlId, { status: "running", claimedBy: d, claimedAt: new Date(), heartbeatAt: new Date() });
    for (let round = 1; round <= 3; round += 1) {
      expect(await reap([d]), `round ${round}`).toMatchObject({ abandonedJobs: 1, pausedCrawls: 1, requeuedCrawls: 1 });
      expect(await crawlRow(crawlId), `round ${round}`).toMatchObject({ status: "queued", autoResumeCount: round });
      // Claimed by the dead worker again, and started: the crawl that kills its worker every time.
      const claimed = await db
        .update(jobs)
        .set({ status: "running", claimedBy: d, claimedAt: new Date(), heartbeatAt: new Date() })
        .where(and(eq(jobs.crawlId, crawlId), eq(jobs.status, "queued"), isNull(jobs.pinnedTo)))
        .returning({ id: jobs.id });
      expect(claimed, `round ${round}`).toHaveLength(1);
      await db.update(crawls).set({ status: "running" }).where(eq(crawls.id, crawlId));
    }
    expect(await reap([d])).toMatchObject({ abandonedJobs: 1, pausedCrawls: 1, requeuedCrawls: 0 });
    expect(await crawlRow(crawlId)).toMatchObject({ status: "paused", pauseReason: "worker_lost", autoResumeCount: 3 });
    expect((await jobsOf(crawlId)).map((j) => j.status)).toEqual(["abandoned", "abandoned", "abandoned", "abandoned"]);
    // And a later tick leaves it there.
    expect(await reap([d])).toMatchObject({ requeuedCrawls: 0 });
    expect((await crawlRow(crawlId)).status).toBe("paused");
  });

  it("requeues a worker-pool crawl paused shutdown or worker_lost; never one paused request or credentials_unreadable, nor an in-process (pinned) crawl paused shutdown", async () => {
    await clearPool();
    const i = await deadInstance();
    const cases = [
      ["shutdown", null, true],
      ["worker_lost", null, true],
      ["request", null, false],
      ["credentials_unreadable", null, false],
      ["shutdown", i, false],
    ] as const;
    const seeded: string[] = [];
    for (const [reason, pinnedTo] of cases) {
      const crawlId = `crawl_runner_${randomUUID()}`;
      const siteUrl = `https://runner-${randomUUID()}.example/`;
      await db.insert(crawls).values({
        tenantId: LOCAL_TENANT,
        id: crawlId,
        siteUrl,
        hostKey: hostKeyOf(siteUrl),
        config: { siteUrl },
        rulesetVersion: RULESET_VERSION,
        status: "paused",
        pauseReason: reason,
        finishedAt: new Date(),
        rulesRunAt: new Date(),
        rulesJudgedWith: { rulesetVersion: RULESET_VERSION },
      });
      createdCrawls.push(crawlId);
      // Its last crawl job: claimed by `i`, settled when the crawl paused.
      await seedJob(crawlId, { status: "abandoned", pinnedTo, claimedBy: i, finishedAt: new Date() });
      seeded.push(crawlId);
    }
    try {
      expect(await reap([i])).toMatchObject({ abandonedJobs: 0, pausedCrawls: 0, requeuedCrawls: 2 });
      for (const [index, [reason, pinnedTo, requeued]] of cases.entries()) {
        const crawlId = seeded[index]!;
        const label = `${reason}${pinnedTo === null ? "" : " (pinned)"}`;
        const row = await crawlRow(crawlId);
        const live = (await jobsOf(crawlId)).filter((j) => j.status === "queued");
        if (requeued) {
          // The same state change as crawl_resume, done by the engine.
          expect(row, label).toMatchObject({
            status: "queued",
            pauseReason: null,
            finishedAt: null,
            rulesRunAt: null,
            rulesJudgedWith: null,
            autoResumeCount: 1,
          });
          expect(live.map((j) => [j.kind, j.pinnedTo]), label).toEqual([["crawl", null]]);
        } else {
          expect(row, label).toMatchObject({ status: "paused", pauseReason: reason, autoResumeCount: 0 });
          expect(live, label).toEqual([]);
        }
      }
    } finally {
      await db.update(jobs).set({ status: "abandoned" }).where(and(inArray(jobs.crawlId, seeded), eq(jobs.status, "queued")));
    }
  });

  it("a runner built with a reaper reaps every reapEvery, and one without never does", async () => {
    const d = await deadInstance();
    const crawlId = await seedCrawl("running");
    // Pinned: an in-process crawl, so the tick pauses it and requeues nothing.
    const job = await seedJob(crawlId, { status: "running", pinnedTo: d, claimedBy: d, claimedAt: new Date(), heartbeatAt: new Date() });
    const plainId = await registerInstance(db, "worker");
    createdInstances.push(plainId);
    const reaperId = await registerInstance(db, "worker");
    createdInstances.push(reaperId);
    const make = (instanceId: string, reaper: boolean): JobRunner =>
      new JobRunner(db, {
        instanceId,
        kinds: ["rules"],
        pinnedTo: instanceId,
        concurrency: 1,
        execute: async () => {},
        log: () => {},
        timing: TIGHT,
        ...(reaper
          ? { reaper: { vault: new CredentialVault(db, TEST_CREDENTIAL_KEYS), retentionDays: 36_500, onlyInstances: [d] } }
          : {}),
      });
    const plain = make(plainId, false);
    plain.start();
    try {
      await sleep(5 * TIGHT.reapEvery);
      expect((await jobsOf(crawlId)).map((j) => j.status)).toEqual(["running"]);
    } finally {
      await plain.stop();
    }
    const reaping = make(reaperId, true);
    reaping.start();
    try {
      await until("the reaper's tick", async () => (await jobsOf(crawlId))[0]?.status, (s) => s === "abandoned", 10_000);
      expect(await crawlRow(crawlId)).toMatchObject({ status: "paused", pauseReason: "worker_lost" });
      expect((await db.select().from(jobs).where(eq(jobs.id, job)))[0]?.status).toBe("abandoned");
    } finally {
      await reaping.stop();
    }
  });
});

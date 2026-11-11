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
 *
 * THE UNPINNED POOL IS THIS FILE'S ALONE. The in-process services of every
 * other suite pin the crawl jobs they accept to themselves and claim only
 * those, so the only runner anywhere in the suite that claims unpinned jobs is
 * runner B below, and the only unpinned jobs are the ones this file's
 * `workers`-mode services enqueue. Tests run in order within a file.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, instances, jobs, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { ClaimLostError, resumeCrawl } from "../../src/crawl/loop.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { ApiService } from "../../src/api/service.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { claimNextJob, enqueueJob, type ClaimedJob } from "../../src/worker/jobs.js";
import { registerInstance } from "../../src/worker/instance.js";
import { JobRunner } from "../../src/worker/runner.js";
import { crawlJobExecutor } from "../../src/worker/crawl-job.js";
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

async function seedCrawl(status = "finished"): Promise<string> {
  const id = `crawl_runner_${randomUUID()}`;
  const siteUrl = "https://runner-test.example/";
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
    const bLog: string[] = [];
    const runner = new JobRunner(db, {
      instanceId,
      kinds: ["crawl"],
      pinnedTo: null,
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
      expect(await jobsOf(crawlId)).toMatchObject([{ status: "done", claimedBy: instanceId, pinnedTo: null }]);
    } finally {
      await runner.stop();
    }
  }, 120_000);
});

/**
 * The worker role (Phase 28b Task 5): `startWorker`, `worker:serve`, the trusted
 * test child, graceful SIGTERM, the allowlist re-check where a crawl runs, and
 * the in-process credential sweep.
 *
 * REAL CHILD PROCESSES of `scripts/run-worker-trusted.ts` (and of
 * `src/worker/serve.ts` where the entry point itself is the thing under test),
 * against loopback fixture servers. Every child is killed and every row it made
 * is deleted in `afterAll`.
 *
 * THE UNPINNED POOL IS ONE FILE'S AT A TIME. A worker claims every unpinned
 * crawl job of this engine version, so this file holds the pool lock
 * (test/helpers/pool-lock.ts) for its whole run, as test/worker/runner.test.ts
 * does. The children's reapers are confined (`reaperOnlyInstances`) to the
 * children of ONE test: the suite's files share a database and an unconfined
 * reaper on a 300 ms clock would pause and delete other suites' rows. The
 * confinement is a file the test rewrites (`TRUSTED_WORKER_PEERS_FILE`), because
 * an instance id exists only once its process has registered.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, instances, jobs } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { ApiService } from "../../src/api/service.js";
import { crawlAllowlistRefusal } from "../../src/worker/crawl-job.js";
import { LOCAL_TENANT, parseTenant, type TenantId } from "../../src/tenant.js";
import { reapOnce } from "../../src/worker/reaper.js";
import { timingWith } from "../../src/worker/timing.js";
import { startWorker } from "../../src/worker/main.js";
import { TEST_CREDENTIAL_KEYS, TEST_CREDENTIAL_KEY_ENV } from "../helpers/credential-keys.js";
import { acquirePoolLock, type PoolLock } from "../helpers/pool-lock.js";

const ROOT = join(import.meta.dirname, "..", "..");

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const short = (): string => randomUUID().slice(0, 8);

/** The children's clock: a beat every 100 ms, dead after 1.5 s, a reaper every 300 ms. */
const CHILD_TIMING = { heartbeat: 100, deadAfter: 1_500, reapEvery: 300, claimPoll: 50 };
const API_HOSTS = ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5", "127.0.0.6"];

let db: Db;
let poolLock: PoolLock;
let scratch: string;
let peersFile: string;
let service: ApiService;
const createdCrawls: string[] = [];
const createdInstances: string[] = [];
const children: Child[] = [];
const fixtures: Fixture[] = [];

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${JSON.stringify(value)})`);
    await sleep(25);
  }
}

// ------------------------------------------------------------------ fixtures

interface Fixture {
  base: string;
  /** Every request the site has answered, `robots.txt` included. */
  requests(): number;
  close(): Promise<void>;
}

/**
 * A site on loopback address `host`. `endless`: every page links ten more, each
 * answered after `delayMs` (a crawl of it is running whenever a test needs it
 * to be). Otherwise a root of four leaf pages.
 */
async function fixture(host: string, opts: { delayMs: number; endless: boolean }): Promise<Fixture> {
  let served = 0;
  const server: Server = createServer((req, res) => {
    served += 1;
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
    const links = opts.endless
      ? Array.from({ length: 10 }, (_, i) => `<a href="/p/${n * 10 + i + 1}">p</a>`).join("")
      : n === 0
        ? Array.from({ length: 4 }, (_, i) => `<a href="/p/${i + 1}">p</a>`).join("")
        : "";
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><head><title>Page ${n}</title></head><body>${links}</body></html>`);
    }, opts.delayMs);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture bound oddly");
  const made: Fixture = {
    base: `http://${host}:${address.port}`,
    requests: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  fixtures.push(made);
  return made;
}

// ------------------------------------------------------------------ children

interface Child {
  proc: ChildProcess;
  instanceId: string;
  port: number;
  /** Resolves with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
  stderr: string[];
}

function track(proc: ChildProcess): { stdout: string[]; stderr: string[]; exited: Promise<number | null> } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  return { stdout, stderr, exited };
}

/** `node --import tsx <script>`: the signal reaches node itself, no wrapper in between. */
function launch(script: string, env: Record<string, string | undefined>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A trusted test worker on the CHILD_TIMING clock, ready (registered, listening). */
async function spawnTrusted(extra: Record<string, string> = {}): Promise<Child> {
  const proc = launch("scripts/run-worker-trusted.ts", {
    DATABASE_URL: databaseUrl(),
    ARIADNE_CREDENTIALS_KEY: TEST_CREDENTIAL_KEY_ENV,
    TRUSTED_WORKER_TIMING: JSON.stringify(CHILD_TIMING),
    TRUSTED_WORKER_PEERS_FILE: peersFile,
    ...extra,
  });
  const { stdout, stderr, exited } = track(proc);
  const ready = await new Promise<{ instanceId: string; port: number }>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`worker not ready in 60 s\n${stderr.join("")}`)), 60_000);
    const poll = setInterval(() => {
      const line = stdout.join("").split("\n").find((l) => l.startsWith("READY "));
      if (line === undefined) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(JSON.parse(line.slice("READY ".length)) as { instanceId: string; port: number });
    }, 20);
    void exited.then((code) => {
      clearInterval(poll);
      clearTimeout(deadline);
      reject(new Error(`worker exited ${String(code)} before it was ready\n${stderr.join("")}`));
    });
  });
  createdInstances.push(ready.instanceId);
  const child: Child = { proc, instanceId: ready.instanceId, port: ready.port, exited, stderr };
  children.push(child);
  return child;
}

/** The reaper confinement of the next children: exactly these (plus each child's own id). */
async function setPeers(ids: readonly string[]): Promise<void> {
  await writeFile(peersFile, JSON.stringify(ids));
}

/** Two workers confined to each other. */
async function spawnPair(): Promise<[Child, Child]> {
  await setPeers([]);
  const a = await spawnTrusted();
  const b = await spawnTrusted();
  await setPeers([a.instanceId, b.instanceId]);
  return [a, b];
}

function byId(pair: readonly Child[], instanceId: string | null): Child {
  const found = pair.find((c) => c.instanceId === instanceId);
  if (found === undefined) throw new Error(`no child holds instance ${String(instanceId)}`);
  return found;
}

async function stopChild(child: Child): Promise<number | null> {
  child.proc.kill("SIGTERM");
  return await Promise.race([
    child.exited,
    sleep(60_000).then(() => {
      throw new Error(`worker ${child.instanceId} did not exit within 60 s of SIGTERM`);
    }),
  ]);
}

// ------------------------------------------------------------------ rows

const tenantFor = (label: string): TenantId => parseTenant(`${label}-${short()}`);

async function crawlRow(id: string): Promise<typeof crawls.$inferSelect> {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl ${id}`);
  return row;
}

async function jobsOf(crawlId: string): Promise<(typeof jobs.$inferSelect)[]> {
  return db.select().from(jobs).where(eq(jobs.crawlId, crawlId)).orderBy(jobs.queuedAt);
}

async function start(tenant: TenantId, body: Record<string, unknown>): Promise<string> {
  const accepted = await service.startCrawl(tenant, { maxPages: 400, maxConcurrency: 1, ...body });
  createdCrawls.push(accepted.crawlId);
  return accepted.crawlId;
}

/** Make the pool empty of this test's crawls before the next test spawns workers. */
async function clearTest(crawlIds: readonly string[]): Promise<void> {
  if (crawlIds.length > 0) await db.delete(crawls).where(inArray(crawls.id, crawlIds));
}

beforeAll(async () => {
  poolLock = await acquirePoolLock(databaseUrl());
  db = createDb(databaseUrl());
  await runMigrations(db);
  scratch = await mkdtemp(join(tmpdir(), "ariadne-serve-"));
  peersFile = join(scratch, "peers.json");
  await setPeers([]);
  service = new ApiService(db, {
    credentialKeys: TEST_CREDENTIAL_KEYS,
    allowedDomains: API_HOSTS,
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    crawlRunner: "workers",
    exportDir: join(scratch, "exports"),
    renderDir: join(scratch, "renders"),
    log: () => {},
  });
}, 900_000);

/**
 * No worker outlives its test: a leftover would claim the next test's jobs (the
 * pool is every worker's), and its own reaper would keep ticking.
 */
afterEach(async () => {
  const live = children.filter((c) => c.proc.exitCode === null && c.proc.signalCode === null);
  for (const child of live) child.proc.kill("SIGTERM");
  await Promise.all(live.map((c) => c.exited));
  await setPeers([]);
}, 120_000);

afterAll(async () => {
  for (const child of children) child.proc.kill("SIGKILL");
  await Promise.all(children.map((c) => c.exited));
  await service.close();
  await closeFetchAgents();
  for (const f of fixtures) await f.close();
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  if (createdInstances.length > 0) await db.delete(instances).where(inArray(instances.id, createdInstances));
  await closeDb(db);
  await poolLock.release();
  await rm(scratch, { recursive: true, force: true });
}, 120_000);

// ------------------------------------------------------------------ the pool

describe("two workers over the pool", () => {
  it("finish four crawls of four loopback hosts across four tenants, one claimer per job, split across both", async () => {
    // Each crawl takes over a second (5 pages x 300 ms, one at a time), so a worker
    // busy with one leaves the rest to the other even when the host is loaded.
    const [a, b] = await spawnPair();
    const sites = await Promise.all(
      ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4"].map((host) => fixture(host, { delayMs: 300, endless: false })),
    );
    const ids: string[] = [];
    for (const [i, site] of sites.entries()) ids.push(await start(tenantFor(`pool${i}`), { siteUrl: `${site.base}/`, maxPages: 5 }));

    await until(
      "all four crawls finished",
      async () => await Promise.all(ids.map(async (id) => (await crawlRow(id)).status)),
      (statuses) => statuses.every((s) => s === "finished"),
    );
    const rows = await Promise.all(ids.map(jobsOf));
    for (const list of rows) {
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ status: "done", pinnedTo: null });
      expect([a.instanceId, b.instanceId]).toContain(list[0]?.claimedBy);
    }
    const claimers = new Set(rows.map((list) => list[0]?.claimedBy));
    expect(claimers).toEqual(new Set([a.instanceId, b.instanceId]));
    for (const site of sites) expect(site.requests()).toBeGreaterThan(0);
    await clearTest(ids);
  });

  it("each worker serves a liveness /healthz and 404s everything else", async () => {
    const [a] = await spawnPair();
    const ok = await fetch(`http://127.0.0.1:${a.port}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "ok" });
    expect((await fetch(`http://127.0.0.1:${a.port}/nope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${a.port}/healthz`, { method: "POST" })).status).toBe(404);
  });
});

describe("graceful SIGTERM", () => {
  it("a worker alone closes its running crawl paused (shutdown), abandons its job, stops its instance and exits 0", async () => {
    const site = await fixture("127.0.0.1", { delayMs: 100, endless: true });
    await setPeers([]);
    const a = await spawnTrusted();
    await setPeers([a.instanceId]);
    const id = await start(tenantFor("term1"), { siteUrl: `${site.base}/` });
    await until("the crawl running on the worker", async () => (await jobsOf(id))[0], (j) => j?.status === "running" && j.claimedBy === a.instanceId);
    // The crawl is fetching (the row's page count is written at its close, so the site is the witness).
    await until("some pages fetched", async () => site.requests(), (n) => n >= 4);

    expect(await stopChild(a)).toBe(0);

    const row = await crawlRow(id);
    expect(row).toMatchObject({ status: "paused", pauseReason: "shutdown" });
    expect((await jobsOf(id)).map((j) => j.status)).toEqual(["abandoned"]);
    const [instance] = await db.select().from(instances).where(eq(instances.id, a.instanceId));
    expect(instance?.stoppedAt).not.toBeNull();
    await clearTest([id]);
    await site.close();
  });

  it("the holder's SIGTERM leaves its crawl to the other worker: running again within a reaper tick, no auto-resume spent", async () => {
    const site = await fixture("127.0.0.1", { delayMs: 100, endless: true });
    const pair = await spawnPair();
    const id = await start(tenantFor("term2"), { siteUrl: `${site.base}/` });
    const first = await until("the crawl running on a worker", async () => (await jobsOf(id))[0], (j) => j?.status === "running");
    const holder = byId(pair, first?.claimedBy ?? null);
    const other = pair.find((c) => c !== holder);
    if (other === undefined) throw new Error("no other worker");

    expect(await stopChild(holder)).toBe(0);

    const second = await until(
      "the crawl running again on the other worker",
      async () => (await jobsOf(id))[1],
      (j) => j?.status === "running",
    );
    expect(second?.claimedBy).toBe(other.instanceId);
    const list = await jobsOf(id);
    expect(list.map((j) => j.status)).toEqual(["abandoned", "running"]);
    // The job is claimed an instant before its loop moves the crawl queued -> running.
    const row = await until("the crawl running again", async () => await crawlRow(id), (r) => r.status === "running");
    // `shutdown` is a deploy: it never spends the three-in-a-row cap (R17).
    expect(row.autoResumeCount).toBe(0);
    await service.cancelCrawl(LOCAL_TENANT, id).catch(() => undefined);
    await clearTest([id]);
    await site.close();
  });
});

describe("a shutdown that cannot finish", () => {
  it("a second SIGTERM exits 1 at once while the first is blocked closing the crawl", async () => {
    const site = await fixture("127.0.0.1", { delayMs: 100, endless: true });
    await setPeers([]);
    const a = await spawnTrusted();
    await setPeers([a.instanceId]);
    const id = await start(tenantFor("term3"), { siteUrl: `${site.base}/` });
    await until("the crawl running", async () => (await crawlRow(id)).status, (st) => st === "running");
    await until("some pages fetched", async () => site.requests(), (n) => n >= 4);

    // Hold the crawl row: the loop's close needs it, so the first SIGTERM blocks.
    const blocker = new pg.Client({ connectionString: databaseUrl() });
    await blocker.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from crawls where id = $1 for update", [id]);
      a.proc.kill("SIGTERM");
      const early = await Promise.race([a.exited, sleep(1_500).then(() => "blocked" as const)]);
      expect(early).toBe("blocked");
      a.proc.kill("SIGTERM");
      const code = await Promise.race([
        a.exited,
        sleep(10_000).then(() => {
          throw new Error("the second SIGTERM did not end the worker within 10 s");
        }),
      ]);
      expect(code).toBe(1);
      expect(a.stderr.join("")).toMatch(/again while closing/);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      await blocker.end();
    }
    await clearTest([id]);
    await site.close();
  });
});

// ------------------------------------------------------------------ boot

interface Ran {
  code: number | null;
  stderr: string;
}

async function runToExit(script: string, env: Record<string, string | undefined>): Promise<Ran> {
  const proc = launch(script, env);
  const { stderr, exited } = track(proc);
  const code = await Promise.race([
    exited,
    sleep(60_000).then(() => {
      proc.kill("SIGKILL");
      throw new Error(`${script} did not exit within 60 s\n${stderr.join("")}`);
    }),
  ]);
  return { code, stderr: stderr.join("") };
}

function workerEnv(): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(),
    ARIADNE_CREDENTIALS_KEY: TEST_CREDENTIAL_KEY_ENV,
    ARIADNE_WORKER_HTTP_PORT: "0",
    ARIADNE_ALLOWED_DOMAINS: "127.0.0.1",
  };
}

describe("api:serve boot", () => {
  it("registers its `api` instance row at boot (before any render or rules job), and stops it on SIGTERM", async () => {
    const proc = launch("src/api/serve.ts", {
      DATABASE_URL: databaseUrl(),
      ARIADNE_CREDENTIALS_KEY: TEST_CREDENTIAL_KEY_ENV,
      ARIADNE_API_TOKEN: `api-token-${short()}-${short()}`,
      ARIADNE_API_PORT: "0",
      ARIADNE_ALLOWED_DOMAINS: "127.0.0.1",
    });
    const { stderr, exited } = track(proc);
    const line = await until("the api's listening line", async () => stderr.join(""), (s) => /listening on/.test(s));
    const instanceId = /instance_[0-9a-f-]+/.exec(line)?.[0];
    expect(instanceId).toBeDefined();
    createdInstances.push(instanceId as string);
    const [row] = await db.select().from(instances).where(eq(instances.id, instanceId as string));
    expect(row?.role).toBe("api");
    expect(row?.stoppedAt).toBeNull();
    proc.kill("SIGTERM");
    expect(await exited).toBe(0);
    const [after] = await db.select().from(instances).where(eq(instances.id, instanceId as string));
    expect(after?.stoppedAt).not.toBeNull();
  });
});

describe("worker:serve boot", () => {
  it.each(["ARIADNE_WORKER_HTTP_PORT", "ARIADNE_CREDENTIALS_KEY", "ARIADNE_ALLOWED_DOMAINS", "DATABASE_URL"])(
    "refuses to boot without %s, naming it",
    async (name) => {
      const env: Record<string, string | undefined> = { ...workerEnv() };
      delete env[name];
      const ran = await runToExit("src/worker/serve.ts", env);
      expect(ran.code).not.toBe(0);
      expect(ran.code).not.toBeNull();
      expect(ran.stderr).toContain(name);
    },
  );

  it.each([
    ["ARIADNE_WORKER_HTTP_PORT", "eighty"],
    ["ARIADNE_WORKER_CONCURRENCY", "0"],
    ["ARIADNE_TENANT_MAX_RUNNING", "04"],
  ])("refuses a malformed %s=%s, naming it", async (name, value) => {
    const ran = await runToExit("src/worker/serve.ts", { ...workerEnv(), [name]: value });
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain(name);
  });

  it("boots with an EMPTY ARIADNE_ALLOWED_DOMAINS (refuse every crawl), and exits 0 on SIGTERM", async () => {
    const proc = launch("src/worker/serve.ts", { ...workerEnv(), ARIADNE_ALLOWED_DOMAINS: "" });
    const { stderr, exited } = track(proc);
    const line = await until("the worker's listening and EMPTY lines", async () => stderr.join(""), (s) => /listening on/.test(s) && /EMPTY/.test(s));
    const instanceId = /instance_[0-9a-f-]+/.exec(line)?.[0];
    if (instanceId !== undefined) createdInstances.push(instanceId);
    proc.kill("SIGTERM");
    expect(await exited).toBe(0);
  });

  it("never reads a process-trust variable: loopback crawls are refused whatever the environment says", async () => {
    const site = await fixture("127.0.0.1", { delayMs: 0, endless: false });
    const proc = launch("src/worker/serve.ts", {
      ...workerEnv(),
      ALLOW_PRIVATE: "1",
      ARIADNE_ALLOW_PRIVATE: "1",
      ARIADNE_WORKER_ALLOW_PRIVATE: "true",
      allowPrivate: "1",
      CRAWL_ALLOW_PRIVATE: "yes",
      ARIADNE_RECHECK_MIN_GAP_MS: "0",
      recheckMinGapMs: "0",
    });
    const { stderr, exited } = track(proc);
    const line = await until("the worker's listening line", async () => stderr.join(""), (s) => /listening on/.test(s));
    const instanceId = /instance_[0-9a-f-]+/.exec(line)?.[0];
    if (instanceId !== undefined) createdInstances.push(instanceId);
    const id = await start(tenantFor("trust"), { siteUrl: `${site.base}/`, maxPages: 5 });
    const row = await until("the crawl settled", async () => await crawlRow(id), (r) => r.status !== "queued" && r.status !== "running");
    // The URL policy refused the loopback seed: nothing finished, nothing fetched.
    expect(row.status).not.toBe("finished");
    expect(row.pagesCrawled).toBe(0);
    expect(site.requests()).toBe(0);
    proc.kill("SIGTERM");
    expect(await exited).toBe(0);
    await clearTest([id]);
  });

  it("serve.ts reads exactly its documented variables, and no process-trust one", () => {
    const source = readFileSync(join(ROOT, "src/worker/serve.ts"), "utf8");
    const named = new Set([...source.matchAll(/env\[\s*"([A-Za-z0-9_]+)"\s*\]/g)].map((m) => m[1]));
    expect(named).toEqual(
      new Set([
        "DATABASE_URL",
        "ARIADNE_WORKER_HTTP_PORT",
        "ARIADNE_WORKER_CONCURRENCY",
        "ARIADNE_TENANT_MAX_RUNNING",
        "ARIADNE_METRICS_TOKEN",
        "ARIADNE_ALLOWED_DOMAINS",
      ]),
    );
    // The vault's own readers take the whole environment; nothing else does.
    const wholeEnv = [...source.matchAll(/\(process\.env\)/g)];
    expect(wholeEnv.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/processTrust|allowPrivate|recheckMinGapMs/i);
    expect(source).not.toMatch(/process\.env\.[A-Za-z_]/);
    expect(source).not.toMatch(/process\.env\[/);
  });

  it("the trusted child holds its process trust in code, not in the environment", () => {
    const source = readFileSync(join(ROOT, "scripts/run-worker-trusted.ts"), "utf8");
    expect(source).toMatch(/processTrust:\s*\{\s*allowPrivate:\s*true/);
    expect(source).not.toMatch(/env\[\s*"[A-Z_]*(PRIVATE|RECHECK)[A-Z_]*"\s*\]/);
  });
});

// ------------------------------------------------------------------ allowlist at claim

describe("the allowlist where the crawl runs", () => {
  it("a queued pool crawl on a host outside the worker's allowlist closes paused (not_allowed), settles its job, fetches nothing, and no reaper tick requeues it", async () => {
    await setPeers([]);
    const a = await spawnTrusted();
    await setPeers([a.instanceId]);
    const site = await fixture("127.0.0.6", { delayMs: 0, endless: false });
    const id = await start(tenantFor("deny"), { siteUrl: `${site.base}/`, maxPages: 5 });

    const row = await until("the crawl paused", async () => await crawlRow(id), (r) => r.status === "paused");
    expect(row.pauseReason).toBe("not_allowed");
    expect(row.finishedAt).not.toBeNull();
    expect(site.requests()).toBe(0);
    expect(row.pagesCrawled).toBe(0);
    const list = await jobsOf(id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "done", claimedBy: a.instanceId });

    // Confined tick of mine, then three of the worker's own: still paused, still one job.
    const summary = await reapOnce(db, {
      now: new Date(),
      timing: timingWith(CHILD_TIMING),
      vault: new CredentialVault(db, TEST_CREDENTIAL_KEYS),
      retentionDays: 30,
      onlyInstances: [a.instanceId],
    });
    expect(summary.requeuedCrawls).toBe(0);
    await sleep(3 * CHILD_TIMING.reapEvery + 200);
    expect(await crawlRow(id)).toMatchObject({ status: "paused", pauseReason: "not_allowed" });
    expect(await jobsOf(id)).toHaveLength(1);
    expect(site.requests()).toBe(0);
    await clearTest([id]);
  });

  it("the same for a legacyHosts entry the worker does not allow", async () => {
    await setPeers([]);
    const a = await spawnTrusted();
    await setPeers([a.instanceId]);
    const site = await fixture("127.0.0.1", { delayMs: 0, endless: false });
    const id = await start(tenantFor("legacy"), { siteUrl: `${site.base}/`, maxPages: 5, legacyHosts: ["127.0.0.5"] });

    const row = await until("the crawl paused", async () => await crawlRow(id), (r) => r.status === "paused");
    expect(row.pauseReason).toBe("not_allowed");
    expect(site.requests()).toBe(0);
    expect((await jobsOf(id)).map((j) => j.status)).toEqual(["done"]);
    await clearTest([id]);
  });

  it("the same for a sitemapUrls entry the worker does not allow", async () => {
    await setPeers([]);
    const a = await spawnTrusted();
    await setPeers([a.instanceId]);
    const site = await fixture("127.0.0.1", { delayMs: 0, endless: false });
    const id = await start(tenantFor("sitemap"), {
      siteUrl: `${site.base}/`,
      maxPages: 5,
      sitemapUrls: ["http://127.0.0.5:9/sitemap.xml"],
    });

    const row = await until("the crawl paused", async () => await crawlRow(id), (r) => r.status === "paused");
    expect(row.pauseReason).toBe("not_allowed");
    expect(site.requests()).toBe(0);
    await clearTest([id]);
  });

  it("crawlAllowlistRefusal: the site's own spellings ride on the site's entry; added hosts need their own; nothing allowed refuses all", () => {
    const allowed = (list: readonly string[]) => (host: string) => list.includes(host);
    const config = { siteUrl: "https://example.com/" };
    expect(crawlAllowlistRefusal(config, allowed(["example.com"]))).toBeNull();
    // www is the same site's family: the entry for the apex authorises it.
    expect(crawlAllowlistRefusal({ siteUrl: "https://www.example.com/" }, allowed(["www.example.com"]))).toBeNull();
    expect(crawlAllowlistRefusal(config, allowed([]))).toMatch(/siteUrl.*example\.com/);
    expect(crawlAllowlistRefusal({ ...config, legacyHosts: ["old.example.org"] }, allowed(["example.com"]))).toMatch(
      /legacyHosts.*old\.example\.org/,
    );
    expect(crawlAllowlistRefusal({ ...config, legacyHosts: ["old.example.org"] }, allowed(["example.com", "old.example.org"]))).toBeNull();
    expect(
      crawlAllowlistRefusal({ ...config, sitemapUrls: ["https://cdn.example.net/s.xml"] }, allowed(["example.com"])),
    ).toMatch(/sitemapUrls.*cdn\.example\.net/);
    // A sitemap on the site's own host needs nothing more.
    expect(crawlAllowlistRefusal({ ...config, sitemapUrls: ["https://example.com/s.xml"] }, allowed(["example.com"]))).toBeNull();
  });
});

// ------------------------------------------------------------------ startWorker in-process

describe("startWorker", () => {
  it("refuses a runner it cannot build, loudly, before it registers anything", async () => {
    const mine = () =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(instances)
        .where(sql`${instances.pid} = ${process.pid} and ${instances.role} = 'worker'`);
    const before = await mine();
    await expect(
      startWorker({
        db,
        credentialKeys: TEST_CREDENTIAL_KEYS,
        concurrency: 0,
        maxRunningPerTenant: 1,
        httpPort: 0,
        metricsToken: null,
        allowedDomains: [],
      }),
    ).rejects.toThrow(/concurrency/);
    expect((await mine())[0]?.n).toBe(before[0]?.n);
  });
});

// ------------------------------------------------------------------ the in-process sweep

describe("the in-process credential sweep (R15)", () => {
  it("an in-process service with a short clock sweeps an expired row on its own timer, and runs no reaper", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const day = 24 * 60 * 60 * 1000;
    const seed = async (status: string, ageDays: number): Promise<string> => {
      const id = `crawl_sweep_${randomUUID()}`;
      await db.insert(crawls).values({
        id,
        tenantId: LOCAL_TENANT,
        siteUrl: "https://sweep.test/",
        hostKey: hostKeyOf("https://sweep.test/"),
        config: { siteUrl: "https://sweep.test/" },
        rulesetVersion: RULESET_VERSION,
        status,
        ...(status === "paused" ? { pauseReason: "request" } : {}),
        finishedAt: new Date(Date.now() - ageDays * day),
      });
      createdCrawls.push(id);
      await db.transaction(async (tx) => {
        await vault.write(tx, LOCAL_TENANT, id, { requestHeaders: { "X-Sweep": "value" } });
      });
      return id;
    };
    const expired = await seed("finished", 400);
    const recent = await seed("finished", 1);
    // A paused crawl is never expired, however old: it is waiting to be resumed.
    const paused = await seed("paused", 400);
    // A system-paused crawl nobody has requeued: a reaper in this service would requeue it.
    const orphan = await seed("paused", 0);
    await db.update(crawls).set({ pauseReason: "shutdown" }).where(eq(crawls.id, orphan));

    const log: string[] = [];
    const swept = new ApiService(db, {
      credentialKeys: TEST_CREDENTIAL_KEYS,
      allowedDomains: [],
      crawlDefaults: { allowPrivate: true },
      exportDir: join(scratch, "exports"),
      renderDir: join(scratch, "renders"),
      timing: { heartbeat: 20, deadAfter: 100, reapEvery: 50, claimPoll: 20 },
      log: (line) => log.push(line),
    });
    try {
      const row = async (id: string) => (await vault.read(id)).kind;
      await until("the expired row swept", async () => await row(expired), (k) => k === "none", 15_000);
      expect(await row(recent)).toBe("ok");
      expect(await row(paused)).toBe("ok");
      await sleep(250);
      // No reaper: the system-paused crawl is as it was, and nothing was said of one.
      expect(await crawlRow(orphan)).toMatchObject({ status: "paused", pauseReason: "shutdown" });
      expect(log.filter((l) => /reaper|abandon|requeue/i.test(l))).toEqual([]);
    } finally {
      await swept.close();
    }
  });
});

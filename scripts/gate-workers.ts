/**
 * The Phase 28b gate, clauses 1 to 5: crawl jobs on worker PROCESSES.
 *
 *   DATABASE_URL=postgresql://…/ariadne_gate28b node --import tsx scripts/gate-workers.ts
 *
 * It runs the API service in this process (`crawlRunner: "workers"`, so it
 * accepts crawls and runs none) beside two real `scripts/run-worker-trusted.ts`
 * children, against loopback fixture hosts it serves itself, and proves:
 *
 *  1. Four tenants x one crawl of four fixture hosts are each claimed exactly
 *     once (the `jobs` rows are the events) and run two at a time.
 *  2. A fifth crawl of a host that is already running waits until it is free,
 *     with a worker idle the whole time.
 *  3. `kill -9` of the worker holding a crawl: within 90 s the crawl is
 *     `paused` (`worker_lost`) with its leases released, and a resume finishes
 *     on another worker with no duplicate `pages` rows. The automatic requeue
 *     (the common path) is run too.
 *  4. A credentialed crawl whose worker is `kill -9`'d finishes on another
 *     worker with its values intact; a secret scan of every table, both
 *     workers' logs, the API's log and responses and every `/metrics` finds no
 *     plaintext; a row under an unknown key id and a row with a flipped tag
 *     byte each pause `credentials_unreadable` and answer 409
 *     `CREDENTIALS_REQUIRED` on resume.
 *  5. The live `/healthz`, `/readyz` and `/metrics` of the API and each worker
 *     answer as specified (the one-migration-behind 503 and the label test are
 *     `test/ops/*`, recorded in docs/gates/phase-28b.md).
 *
 * Why worker PROCESSES and not `docker compose` for the crawling: the fixture
 * is on loopback, which the URL policy refuses unless `allowPrivate` is set,
 * and `allowPrivate` is a code-level argument no environment can carry
 * (`scripts/run-worker-trusted.ts` holds it in code). `scripts/compose-smoke.sh`
 * proves the images boot, migrate, report ready and register.
 *
 * The clock is the production one (heartbeat 10 s, dead after 60 s, reaper
 * every 30 s), because clause 3's 90 s bound is a statement about it.
 *
 * SAFETY. It refuses the database named `ariadne` (the dev database) and any
 * database that already has a queued or running job, since the workers it
 * starts would claim them. It leaves its rows in place; the database is
 * `ariadne_gate28b`'s to keep. Every child is killed on any exit.
 *
 * It prints progress, then one JSON summary, and exits non-zero if any clause
 * failed. A failure is recorded as it is; no threshold is tuned here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../src/db/client.js";
import { createApiServer, type ApiServer } from "../src/api/http.js";
import { CredentialVault, type CredentialKeys } from "../src/crawl/credential-vault.js";
import { closeFetchAgents } from "../src/crawl/http.js";

const ROOT = join(import.meta.dirname, "..");
const RUN = randomBytes(3).toString("hex");
const API_TOKEN = `gate-api-${randomBytes(12).toString("hex")}`;
const METRICS_TOKEN = `gate-metrics-${randomBytes(12).toString("hex")}`;
const KEY_ID = `gate-${RUN}`;
const KEY_BYTES = randomBytes(32);
const KEY_ENV = `${KEY_ID}:${KEY_BYTES.toString("base64")}`;
const KEYS: CredentialKeys = { current: { id: KEY_ID, key: KEY_BYTES } };

/** The credential values the gate sends; none may appear anywhere afterwards. */
const SECRET_USER = `gate-user-${randomBytes(6).toString("hex")}`;
const SECRET_PASSWORD = `gate-pw-${randomBytes(6).toString("hex")}`;
const SECRET_COOKIE = `gate-cookie-${randomBytes(6).toString("hex")}`;
const SECRET_HEADER = `gate-header-${randomBytes(6).toString("hex")}`;
const SECRET_BASIC = Buffer.from(`${SECRET_USER}:${SECRET_PASSWORD}`, "utf8").toString("base64");
const SECRETS = [SECRET_USER, SECRET_PASSWORD, SECRET_COOKIE, SECRET_HEADER, SECRET_BASIC];
const CREDENTIALS = {
  requestHeaders: { "x-fixture-key": SECRET_HEADER },
  httpAuth: { username: SECRET_USER, password: SECRET_PASSWORD },
  cookies: [{ name: "session", value: SECRET_COOKIE }],
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  return url;
}

// ------------------------------------------------------------------ fixture hosts

interface HostStats {
  requests: number;
  inFlight: number;
  maxInFlight: number;
  /** Gated hosts only: requests answered 401, and pages served to a request that carried all three credentials. */
  unauthorized: number;
  gatedOk: number;
}

interface FixtureHost {
  base: string;
  hostKey: string;
  stats: HostStats;
  close(): Promise<void>;
}

/**
 * A finite, slow tree of `size` pages on `ip`: page n links to pages 3n+1..3n+3
 * below `size`, so a crawl of it ends by exhausting the site. `gated` makes
 * every page answer 401 unless the request carries all three credentials
 * (robots.txt stays open).
 */
async function startHost(ip: string, size: number, delayMs: number, gated: boolean): Promise<FixtureHost> {
  const stats: HostStats = { requests: 0, inFlight: 0, maxInFlight: 0, unauthorized: 0, gatedOk: 0 };
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    stats.requests += 1;
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\nCrawl-delay: 0\n");
      return;
    }
    const match = path === "/" ? ["", "0"] : /^\/t\/(\d+)$/.exec(path);
    const n = match === null ? -1 : Number(match[1]);
    if (n < 0 || n >= size) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (gated) {
      const cookie = String(req.headers["cookie"] ?? "");
      const ok =
        req.headers["authorization"] === `Basic ${SECRET_BASIC}` &&
        req.headers["x-fixture-key"] === SECRET_HEADER &&
        cookie.split(";").some((c) => c.trim() === `session=${SECRET_COOKIE}`);
      if (!ok) {
        stats.unauthorized += 1;
        res.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Basic realm="gate"' });
        res.end("credentials required");
        return;
      }
      stats.gatedOk += 1;
    }
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        stats.inFlight -= 1;
      }
    };
    res.on("close", settle);
    setTimeout(() => {
      const links = [1, 2, 3]
        .map((k) => 3 * n + k)
        .filter((m) => m < size)
        .map((m) => `<a href="/t/${m}">page ${m}</a>`)
        .join(" ");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><title>Gate page ${n} of ${ip}</title>` +
          `<meta name="description" content="A gate fixture page, number ${n}, with enough words to be a description."></head>` +
          `<body><h1>Gate page ${n}</h1><p>${links}</p></body></html>`,
      );
      settle();
    }, delayMs);
  };
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, ip, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture host bound oddly");
  const hostKey = `${ip}:${address.port}`;
  return {
    base: `http://${hostKey}`,
    hostKey,
    stats,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// ------------------------------------------------------------------ worker children

interface Worker {
  proc: ChildProcess;
  pid: number;
  instanceId: string;
  port: number;
  stdout: string[];
  stderr: string[];
  exited: Promise<number | null>;
  dead: boolean;
}

const workers: Worker[] = [];
let peersFile = "";

async function writePeers(extra: readonly string[]): Promise<void> {
  await writeFile(peersFile, JSON.stringify([...workers.map((w) => w.instanceId), ...extra]));
}

async function spawnWorker(apiInstance: string): Promise<Worker> {
  const proc = spawn(process.execPath, ["--import", "tsx", "scripts/run-worker-trusted.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env["PATH"],
      DATABASE_URL: databaseUrl(),
      ARIADNE_CREDENTIALS_KEY: KEY_ENV,
      TRUSTED_WORKER_METRICS_TOKEN: METRICS_TOKEN,
      TRUSTED_WORKER_PEERS_FILE: peersFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  proc.stdout?.setEncoding("utf8").on("data", (c: string) => stdout.push(c));
  proc.stderr?.setEncoding("utf8").on("data", (c: string) => stderr.push(c));
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  const pid = proc.pid;
  if (pid === undefined) throw new Error("worker child has no pid");
  const ready = await new Promise<{ instanceId: string; port: number }>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`worker not ready in 90 s\n${stderr.join("")}`)), 90_000);
    const poll = setInterval(() => {
      const line = stdout.join("").split("\n").find((l) => l.startsWith("READY "));
      if (line === undefined) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(JSON.parse(line.slice("READY ".length)) as { instanceId: string; port: number });
    }, 25);
    void exited.then((code) => {
      clearInterval(poll);
      clearTimeout(deadline);
      reject(new Error(`worker exited ${String(code)} before it was ready\n${stderr.join("")}`));
    });
  });
  const worker: Worker = { proc, pid, instanceId: ready.instanceId, port: ready.port, stdout, stderr, exited, dead: false };
  void exited.then(() => { worker.dead = true; });
  workers.push(worker);
  await writePeers([apiInstance]);
  return worker;
}

const live = (): Worker[] => workers.filter((w) => !w.dead);

function killAll(signal: NodeJS.Signals): void {
  for (const w of workers) if (!w.dead) { try { w.proc.kill(signal); } catch { /* already gone */ } }
}

// ------------------------------------------------------------------ the API and its client

let db: Db;
let api: ApiServer;
let apiBase = "";
const apiLog: string[] = [];
/** Every response text the gate's API client ever read: part of the secret scan. */
const apiTexts: string[] = [];

interface Res {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, tenant: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${API_TOKEN}`, "x-ariadne-tenant": tenant };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${apiBase}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  apiTexts.push(text);
  return { status: res.status, text, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const tenantFor = (label: string): string => `g28b-${RUN}-${label}`;

async function startCrawl(tenant: string, body: Record<string, unknown>): Promise<string> {
  const res = await call("POST", "/crawls", tenant, { maxConcurrency: 1, ...body });
  if (res.status !== 202) throw new Error(`POST /crawls: ${res.status} ${res.text}`);
  return String(res.body["crawlId"]);
}

async function detail(tenant: string, id: string): Promise<Record<string, unknown>> {
  const res = await call("GET", `/crawls/${id}`, tenant);
  if (res.status !== 200) throw new Error(`GET /crawls/${id}: ${res.status} ${res.text}`);
  return res.body;
}

async function waitFor<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms: ${what} (last: ${JSON.stringify(value).slice(0, 400)})`);
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------------ rows

interface CrawlRow { status: string; pause_reason: string | null; auto_resume_count: number; pages_crawled: number }

async function crawlRow(id: string): Promise<CrawlRow> {
  const r = await db.execute(sql`select status, pause_reason, auto_resume_count, pages_crawled from crawls where id = ${id}`);
  const row = r.rows[0] as CrawlRow | undefined;
  if (row === undefined) throw new Error(`no crawl ${id}`);
  return row;
}

interface JobRow { id: string; status: string; claimed_by: string | null; claimed_at: Date | null; finished_at: Date | null; queued_at: Date; kind: string }

async function jobsOf(id: string): Promise<JobRow[]> {
  const r = await db.execute(
    sql`select id, status, claimed_by, claimed_at, finished_at, queued_at, kind from jobs where crawl_id = ${id} order by queued_at, id`,
  );
  return r.rows as unknown as JobRow[];
}

async function pageCounts(id: string): Promise<{ rows: number; distinct: number; notOk: number }> {
  const r = await db.execute(
    sql`select count(*)::int as rows, count(distinct url)::int as distinct,
               count(*) filter (where status_code is distinct from 200 or fetch_class <> 'ok')::int as not_ok
        from pages where crawl_id = ${id}`,
  );
  const row = r.rows[0] as { rows: number; distinct: number; not_ok: number };
  return { rows: row.rows, distinct: row.distinct, notOk: row.not_ok };
}

async function frontierLeased(id: string): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from frontier where crawl_id = ${id} and state = 'leased'`);
  return Number((r.rows[0] as { n: number }).n);
}

const iso = (d: Date | null): string | null => (d === null ? null : new Date(d).toISOString());

// ------------------------------------------------------------------ clauses

interface Clause { pass: boolean; evidence: Record<string, unknown> }
const clauses: Record<string, Clause> = {};

function check(failures: string[], ok: boolean, message: string): void {
  if (!ok) failures.push(message);
}

async function record(name: string, run: (failures: string[]) => Promise<Record<string, unknown>>): Promise<void> {
  const failures: string[] = [];
  let evidence: Record<string, unknown> = {};
  try {
    evidence = await run(failures);
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A clause body keeps its own failure list and returns it as `failures` in its evidence: a
  // non-empty one fails the clause as surely as a throw does.
  const own = evidence["failures"];
  if (Array.isArray(own)) failures.push(...(own as string[]));
  clauses[name] = { pass: failures.length === 0, evidence: { ...evidence, ...(failures.length > 0 ? { failures } : {}) } };
  say(`clause ${name}: ${failures.length === 0 ? "PASS" : `FAIL — ${failures.join(" | ")}`}`);
}

/** Clause 2 first: a fifth crawl of an already-running host. One worker is idle throughout. */
async function clause2(): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const host = await startHost("127.0.0.1", 120, 150, false);
  try {
    const t1 = tenantFor("c2-first");
    const t5 = tenantFor("c2-fifth");
    const first = await startCrawl(t1, { siteUrl: `${host.base}/`, maxPages: 120 });
    await waitFor("first crawl running and fetching", async () => ({ job: (await jobsOf(first))[0]?.status, r: host.stats.requests }), (v) => v.job === "running" && v.r >= 6, 60_000);
    const fifth = await startCrawl(t5, { siteUrl: `${host.base}/`, maxPages: 10 });
    say("clause 2: fifth crawl of the running host submitted; watching it wait with a worker idle");

    let samples = 0;
    let fifthQueuedSamples = 0;
    let firstRunningSamples = 0;
    let idleWorkerSamples = 0;
    const liveIds = live().map((w) => w.instanceId);
    const t0 = Date.now();
    for (;;) {
      const [fj, tj] = [(await jobsOf(first))[0], (await jobsOf(fifth))[0]];
      if (fj === undefined || tj === undefined) throw new Error("a job row is missing");
      if (fj.status !== "running") break;
      samples += 1;
      firstRunningSamples += 1;
      if (tj.status === "queued") fifthQueuedSamples += 1;
      const busy = await db.execute(
        sql`select count(distinct claimed_by)::int as n from jobs where status = 'running' and claimed_by in (${sql.join(liveIds.map((i) => sql`${i}`), sql`, `)})`,
      );
      if (Number((busy.rows[0] as { n: number }).n) < liveIds.length) idleWorkerSamples += 1;
      await sleep(100);
      if (Date.now() - t0 > 120_000) throw new Error("first crawl did not finish in 120 s");
    }
    const waitedMs = Date.now() - t0;
    const fifthDone = await waitFor("fifth crawl finished", () => crawlRow(fifth), (r) => r.status === "finished", 60_000);
    const [fj] = await jobsOf(first);
    const [tj] = await jobsOf(fifth);
    check(failures, fifthQueuedSamples === firstRunningSamples && samples >= 10, `the fifth crawl was queued in ${fifthQueuedSamples} of ${firstRunningSamples} samples while the first ran (need all, at least 10)`);
    check(failures, idleWorkerSamples === samples, `a worker was idle in ${idleWorkerSamples} of ${samples} samples (need all: the wait must be host exclusivity, not a missing worker)`);
    check(failures, tj !== undefined && fj !== undefined && tj.claimed_at !== null && fj.finished_at !== null && new Date(tj.claimed_at) >= new Date(fj.finished_at), "the fifth crawl was claimed before the first crawl's job finished");
    check(failures, host.stats.maxInFlight === 1, `the host saw ${host.stats.maxInFlight} requests in flight at once (need 1)`);
    check(failures, fifthDone.status === "finished" && fifthDone.pages_crawled === 10, `fifth crawl ended ${fifthDone.status} with ${fifthDone.pages_crawled} pages (want finished, 10)`);
    return {
      host: host.hostKey,
      samplesWhileFirstRan: samples,
      fifthQueuedSamples,
      idleWorkerSamples,
      waitedMs,
      firstJob: { claimedBy: fj?.claimed_by, claimedAt: iso(fj?.claimed_at ?? null), finishedAt: iso(fj?.finished_at ?? null) },
      fifthJob: { claimedBy: tj?.claimed_by, claimedAt: iso(tj?.claimed_at ?? null), finishedAt: iso(tj?.finished_at ?? null) },
      maxInFlightOnHost: host.stats.maxInFlight,
      failures,
    };
  } finally {
    await host.close();
  }
}

/** Clause 1: four tenants x one crawl of four hosts, two at a time. */
async function clause1(): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const hosts = await Promise.all([1, 2, 3, 4].map((n) => startHost(`127.0.0.${n}`, 40, 150, false)));
  try {
    const crawlIds: { tenant: string; id: string; host: string }[] = [];
    for (const [i, host] of hosts.entries()) {
      const tenant = tenantFor(`c1-t${i + 1}`);
      crawlIds.push({ tenant, id: await startCrawl(tenant, { siteUrl: `${host.base}/`, maxPages: 40 }), host: host.hostKey });
    }
    say("clause 1: four crawls submitted");
    let maxRunning = 0;
    const ids = crawlIds.map((c) => c.id);
    const inList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
    await waitFor(
      "all four crawls finished",
      async () => {
        const running = await db.execute(sql`select count(*)::int as n from jobs where kind = 'crawl' and status = 'running' and crawl_id in (${inList})`);
        maxRunning = Math.max(maxRunning, Number((running.rows[0] as { n: number }).n));
        const done = await db.execute(sql`select count(*)::int as n from crawls where status = 'finished' and id in (${inList})`);
        return Number((done.rows[0] as { n: number }).n);
      },
      (n) => n === 4,
      180_000,
      50,
    );
    const per: Record<string, unknown>[] = [];
    const intervals: { start: number; end: number }[] = [];
    const claimers = new Set<string>();
    for (const c of crawlIds) {
      const j = await jobsOf(c.id);
      const counts = await pageCounts(c.id);
      const only = j[0];
      check(failures, j.length === 1 && only !== undefined && only.status === "done" && only.kind === "crawl", `crawl ${c.id}: ${j.length} job row(s), first ${only?.status} (want exactly one, done)`);
      check(failures, counts.rows === 40 && counts.distinct === 40, `crawl ${c.id}: ${counts.rows} pages rows, ${counts.distinct} distinct (want 40)`);
      if (only?.claimed_at && only.finished_at) {
        intervals.push({ start: new Date(only.claimed_at).getTime(), end: new Date(only.finished_at).getTime() });
        claimers.add(String(only.claimed_by));
      }
      per.push({ tenant: c.tenant, host: c.host, jobs: j.length, claimedBy: only?.claimed_by, claimedAt: iso(only?.claimed_at ?? null), finishedAt: iso(only?.finished_at ?? null), pages: counts.rows });
    }
    // The overlap of the claimed..finished intervals, from the rows alone.
    let maxOverlap = 0;
    for (const a of intervals) {
      maxOverlap = Math.max(maxOverlap, intervals.filter((b) => b.start <= a.start && a.start < b.end).length);
    }
    check(failures, maxRunning === 2, `sampled at most ${maxRunning} crawl jobs running at once (want exactly 2)`);
    check(failures, maxOverlap === 2, `the claimed-to-finished intervals overlap ${maxOverlap} at most (want exactly 2)`);
    check(failures, claimers.size === 2, `${claimers.size} worker(s) claimed the four jobs (want both)`);
    for (const h of hosts) check(failures, h.stats.maxInFlight === 1, `host ${h.hostKey} saw ${h.stats.maxInFlight} in flight`);
    return { crawls: per, sampledMaxRunning: maxRunning, intervalMaxOverlap: maxOverlap, workersThatClaimed: [...claimers], failures };
  } finally {
    await Promise.all(hosts.map((h) => h.close()));
  }
}

/** Kill the worker holding `crawlId`'s running job with SIGKILL; answers who, and when. */
async function killHolder(tenant: string, crawlId: string): Promise<{ victim: Worker; killedAt: number }> {
  const d = await waitFor("crawl running on a worker", async () => detail(tenant, crawlId), (b) => {
    const job = b["job"] as { status?: string; claimedBy?: string } | null;
    return b["status"] === "running" && job?.status === "running" && job.claimedBy !== undefined;
  }, 60_000);
  const holder = (d["job"] as { claimedBy: string }).claimedBy;
  const victim = workers.find((w) => w.instanceId === holder && !w.dead);
  if (victim === undefined) throw new Error(`the holder ${holder} is not a live child of this gate`);
  const killedAt = Date.now();
  victim.proc.kill("SIGKILL");
  await victim.exited;
  say(`kill -9 sent to worker ${victim.instanceId} (pid ${victim.pid}) holding ${crawlId}`);
  return { victim, killedAt };
}

/** Clause 3: kill -9 mid-crawl. 3b (cap spent, so paused stays paused, then an agent resume), 3a (the automatic requeue). */
async function clause3(apiInstance: string): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const evidence: Record<string, unknown> = {};

  // 3b: paused (worker_lost) stays paused, leases released, resume finishes elsewhere.
  {
    const host = await startHost("127.0.0.2", 150, 150, false);
    try {
      const tenant = tenantFor("c3b");
      const id = await startCrawl(tenant, { siteUrl: `${host.base}/`, maxPages: 150 });
      await waitFor("fetching", async () => host.stats.requests, (n) => n >= 10, 60_000);
      // The automatic requeue is clause 3a below. Here the cap is spent first,
      // exactly as three earlier worker_lost requeues would leave it, so the
      // crawl's `paused (worker_lost)` is a state the gate can hold and read.
      await db.execute(sql`update crawls set auto_resume_count = 3 where id = ${id}`);
      const { victim, killedAt } = await killHolder(tenant, id);
      const paused = await waitFor("paused worker_lost", () => crawlRow(id), (r) => r.status === "paused", 150_000, 250);
      const pausedAfterMs = Date.now() - killedAt;
      const view = await detail(tenant, id);
      const leasedRows = await frontierLeased(id);
      check(failures, paused.pause_reason === "worker_lost", `3b: paused for '${paused.pause_reason}' (want worker_lost)`);
      check(failures, pausedAfterMs <= 90_000, `3b: paused ${pausedAfterMs} ms after the kill (want <= 90000)`);
      check(failures, view["liveLeases"] === 0 && leasedRows === 0, `3b: ${String(view["liveLeases"])} live leases, ${leasedRows} leased frontier rows (want 0)`);
      const requeuedHold = await sleep(3_000).then(() => crawlRow(id));
      check(failures, requeuedHold.status === "paused", `3b: the paused crawl moved to '${requeuedHold.status}' by itself (cap was spent; want it to stay paused)`);
      // The replacement keeps two workers up; then the agent's resume.
      await spawnWorker(apiInstance);
      const resumed = await call("POST", `/crawls/${id}/resume`, tenant);
      check(failures, resumed.status === 202, `3b: resume answered ${resumed.status} ${resumed.text}`);
      const done = await waitFor("finished", () => crawlRow(id), (r) => r.status === "finished" || r.status === "failed", 240_000, 250);
      const jobs = await jobsOf(id);
      const counts = await pageCounts(id);
      const lastJob = jobs[jobs.length - 1];
      check(failures, done.status === "finished", `3b: ended ${done.status}`);
      check(failures, counts.rows === 150 && counts.distinct === 150, `3b: ${counts.rows} pages rows, ${counts.distinct} distinct (want 150, no duplicates)`);
      check(failures, lastJob?.status === "done" && lastJob.claimed_by !== victim.instanceId && live().some((w) => w.instanceId === lastJob.claimed_by), `3b: the last job is ${lastJob?.status} on ${lastJob?.claimed_by} (want done, on a live worker other than the victim)`);
      evidence["3b_paused_worker_lost"] = {
        victim: victim.instanceId,
        pausedAfterMs,
        pauseReason: paused.pause_reason,
        liveLeases: view["liveLeases"],
        leasedFrontierRows: leasedRows,
        jobs: jobs.map((j) => ({ status: j.status, claimedBy: j.claimed_by })),
        pagesRows: counts.rows,
        distinctUrls: counts.distinct,
        finishedOn: lastJob?.claimed_by,
        resumeStatus: resumed.status,
      };
    } finally {
      await host.close();
    }
  }

  // 3a: the automatic requeue, as it runs without an agent.
  {
    const host = await startHost("127.0.0.3", 150, 150, false);
    try {
      const tenant = tenantFor("c3a");
      const id = await startCrawl(tenant, { siteUrl: `${host.base}/`, maxPages: 150 });
      await waitFor("fetching", async () => host.stats.requests, (n) => n >= 10, 60_000);
      const { victim, killedAt } = await killHolder(tenant, id);
      let sawPaused: { afterMs: number; reason: string | null; liveLeases: number } | null = null;
      const done = await waitFor("finished", async () => {
        const r = await crawlRow(id);
        if (sawPaused === null && r.status === "paused") {
          sawPaused = { afterMs: Date.now() - killedAt, reason: r.pause_reason, liveLeases: await frontierLeased(id) };
        }
        return r;
      }, (r) => r.status === "finished" || r.status === "failed", 330_000, 50);
      await spawnWorker(apiInstance);
      const jobs = await jobsOf(id);
      const counts = await pageCounts(id);
      const first = jobs[0];
      const lastJob = jobs[jobs.length - 1];
      check(failures, done.status === "finished", `3a: ended ${done.status}`);
      check(failures, done.auto_resume_count === 1, `3a: auto_resume_count ${done.auto_resume_count} (want 1)`);
      check(failures, jobs.length === 2 && first?.status === "abandoned" && first.claimed_by === victim.instanceId, `3a: jobs ${JSON.stringify(jobs.map((j) => [j.status, j.claimed_by]))} (want the victim's job abandoned, then a second)`);
      check(failures, lastJob?.status === "done" && lastJob.claimed_by !== victim.instanceId, `3a: the last job is ${lastJob?.status} on ${lastJob?.claimed_by}`);
      check(failures, counts.rows === 150 && counts.distinct === 150, `3a: ${counts.rows} pages rows, ${counts.distinct} distinct (want 150)`);
      evidence["3a_automatic_requeue"] = {
        victim: victim.instanceId,
        jobs: jobs.map((j) => ({ status: j.status, claimedBy: j.claimed_by })),
        autoResumeCount: done.auto_resume_count,
        pausedWorkerLostSeen: sawPaused,
        pagesRows: counts.rows,
        distinctUrls: counts.distinct,
        finishedAfterKillMs: Date.now() - killedAt,
      };
    } finally {
      await host.close();
    }
  }
  return { ...evidence, failures };
}

/** Clause 4, first half: a credentialed crawl killed and finished elsewhere. Second half is `clause4Unreadable`. */
async function clause4Credentialed(apiInstance: string): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const host = await startHost("127.0.0.4", 150, 150, true);
  try {
    const tenant = tenantFor("c4");
    const id = await startCrawl(tenant, { siteUrl: `${host.base}/`, maxPages: 150, ...CREDENTIALS });
    await waitFor("fetching with credentials", async () => host.stats.gatedOk, (n) => n >= 10, 60_000);
    const { victim, killedAt } = await killHolder(tenant, id);
    const done = await waitFor("finished", () => crawlRow(id), (r) => r.status === "finished" || r.status === "failed", 330_000, 100);
    await spawnWorker(apiInstance);
    const jobs = await jobsOf(id);
    const counts = await pageCounts(id);
    const lastJob = jobs[jobs.length - 1];
    const read = await new CredentialVault(db, KEYS).read(id);
    const intact =
      read.kind === "ok" &&
      JSON.stringify(read.credentials) === JSON.stringify({ requestHeaders: CREDENTIALS.requestHeaders, httpAuth: CREDENTIALS.httpAuth, cookies: CREDENTIALS.cookies });
    check(failures, done.status === "finished", `4: ended ${done.status}`);
    check(failures, jobs.length === 2 && jobs[0]?.status === "abandoned" && jobs[0].claimed_by === victim.instanceId, `4: jobs ${JSON.stringify(jobs.map((j) => [j.status, j.claimed_by]))}`);
    check(failures, lastJob?.status === "done" && lastJob.claimed_by !== victim.instanceId, `4: finished on ${lastJob?.claimed_by}`);
    check(failures, counts.rows === 150 && counts.distinct === 150 && counts.notOk === 0, `4: ${counts.rows} pages rows (${counts.distinct} distinct, ${counts.notOk} not 200/ok) (want 150, 150, 0)`);
    check(failures, host.stats.unauthorized === 0, `4: the gated host answered ${host.stats.unauthorized} 401(s): a request went out without a credential`);
    check(failures, intact, "4: the stored copy does not decrypt to the values that were sent");
    return {
      victim: victim.instanceId,
      jobs: jobs.map((j) => ({ status: j.status, claimedBy: j.claimed_by })),
      pagesRows: counts.rows,
      pagesNot200Ok: counts.notOk,
      gatedHostServed: host.stats.gatedOk,
      gatedHost401s: host.stats.unauthorized,
      storedCopyDecryptsToSentValues: intact,
      finishedAfterKillMs: Date.now() - killedAt,
      failures,
    };
  } finally {
    await host.close();
  }
}

/** Clause 4, second half: an unknown key id and a flipped tag byte. */
async function clause4Unreadable(): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const blockerHost = await startHost("127.0.0.1", 400, 150, false);
  const gatedHost = await startHost("127.0.0.2", 20, 50, true);
  try {
    const tenant = tenantFor("c4u");
    const blocker = await startCrawl(tenant, { siteUrl: `${blockerHost.base}/`, maxPages: 400 });
    await waitFor("blocker running", async () => blockerHost.stats.requests, (n) => n >= 3, 60_000);
    // One running crawl per tenant: both credentialed crawls queue behind it.
    const unknownKey = await startCrawl(tenant, { siteUrl: `${gatedHost.base}/`, maxPages: 20, ...CREDENTIALS });
    const flippedTag = await startCrawl(tenant, { siteUrl: `${gatedHost.base}/`, maxPages: 20, ...CREDENTIALS });
    await sleep(2_500);
    for (const id of [unknownKey, flippedTag]) {
      const j = (await jobsOf(id))[0];
      check(failures, j?.status === "queued", `crawl ${id} is ${j?.status} behind the tenant's running crawl (want queued)`);
    }
    await db.execute(sql`update crawl_credentials set key_id = 'gate-rotated-away' where crawl_id = ${unknownKey}`);
    const row = await db.execute(sql`select ciphertext from crawl_credentials where crawl_id = ${flippedTag}`);
    const cipher = Buffer.from((row.rows[0] as { ciphertext: Buffer }).ciphertext);
    // The last byte is the final byte of the 16-byte GCM tag.
    cipher[cipher.length - 1] = (cipher[cipher.length - 1] ?? 0) ^ 0x01;
    await db.execute(sql`update crawl_credentials set ciphertext = ${cipher} where crawl_id = ${flippedTag}`);

    const pauseBlocker = await call("POST", `/crawls/${blocker}/pause`, tenant);
    check(failures, pauseBlocker.status === 202, `pausing the blocker answered ${pauseBlocker.status}`);
    const out: Record<string, unknown> = {};
    for (const [what, id] of [["unknownKeyId", unknownKey], ["flippedTagByte", flippedTag]] as const) {
      const paused = await waitFor(`${what} paused`, () => crawlRow(id), (r) => r.status === "paused", 120_000, 100);
      check(failures, paused.pause_reason === "credentials_unreadable", `${what}: paused for '${paused.pause_reason}' (want credentials_unreadable)`);
      const resume = await call("POST", `/crawls/${id}/resume`, tenant);
      check(failures, resume.status === 409 && resume.body["code"] === "CREDENTIALS_REQUIRED", `${what}: resume answered ${resume.status} ${String(resume.body["code"])} (want 409 CREDENTIALS_REQUIRED)`);
      const counts = await pageCounts(id);
      check(failures, counts.rows === 0, `${what}: ${counts.rows} pages rows (want none: nothing was fetched)`);
      out[what] = { status: paused.status, pauseReason: paused.pause_reason, resumeStatus: resume.status, resumeCode: resume.body["code"], pagesRows: counts.rows };
    }
    check(failures, gatedHost.stats.requests === 0, `the gated host saw ${gatedHost.stats.requests} request(s), ${gatedHost.stats.gatedOk} served, ${gatedHost.stats.unauthorized} refused (want none)`);
    await call("POST", `/crawls/${blocker}/cancel`, tenant);
    return { ...out, gatedHostRequests: gatedHost.stats.requests, failures };
  } finally {
    await blockerHost.close();
    await gatedHost.close();
  }
}

/** The secret scan: every table, the workers' output, the API's log and responses, every /metrics scrape. */
async function secretScan(metricsTexts: string[]): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const cols = await db.execute(sql`
    select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and data_type in ('text', 'character varying', 'jsonb', 'json', 'ARRAY', 'bytea')
    order by table_name, column_name`);
  const columns = cols.rows as { table_name: string; column_name: string; data_type: string }[];
  const tables = new Set(columns.map((c) => c.table_name));
  let cellsChecked = 0;
  for (const { table_name, column_name, data_type } of columns) {
    for (const secret of SECRETS) {
      const hit =
        data_type === "bytea"
          ? await db.execute(sql`select count(*)::int as n from ${sql.identifier(table_name)} where position(convert_to(${secret}, 'UTF8') in ${sql.identifier(column_name)}) > 0`)
          : await db.execute(sql`select count(*)::int as n from ${sql.identifier(table_name)} where ${sql.identifier(column_name)}::text like ${`%${secret}%`}`);
      cellsChecked += 1;
      if (Number((hit.rows[0] as { n: number }).n) > 0) failures.push(`${table_name}.${column_name} holds a credential value`);
    }
  }
  const texts: Record<string, string> = {
    "api log": apiLog.join("\n"),
    "api responses": apiTexts.join("\n"),
    "/metrics scrapes": metricsTexts.join("\n"),
  };
  for (const w of workers) {
    texts[`worker ${w.instanceId} stdout`] = w.stdout.join("");
    texts[`worker ${w.instanceId} stderr`] = w.stderr.join("");
  }
  for (const [where, text] of Object.entries(texts)) {
    for (const secret of SECRETS) if (text.includes(secret)) failures.push(`${where} carries a credential value`);
  }
  const vault = await db.execute(sql`select count(*)::int as n from crawl_credentials`);
  return {
    tablesScanned: tables.size,
    columnsScanned: columns.length,
    columnSecretProbes: cellsChecked,
    textsScanned: Object.keys(texts),
    bytesOfOutputScanned: Object.values(texts).reduce((n, t) => n + Buffer.byteLength(t), 0),
    secretsProbed: SECRETS.length,
    vaultRowsPresent: Number((vault.rows[0] as { n: number }).n),
    failures,
  };
}

async function get(url: string, token?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, text: await res.text() };
}

/**
 * The label NAMES a scrape may carry: the engine's own (`kind`, `status`,
 * `fetch_class`, `role`, `outcome`), the histogram's (`le`), and the ones
 * prom-client's default Node process metrics add (`version`, `major`, `minor`,
 * `patch` on `nodejs_version_info`, `space` on the heap-space gauges, `type` on
 * the GC histogram). None of those is a tenant, crawl, host or URL; the property
 * that matters is checked on the label VALUES below, and by `test/ops/metrics.test.ts`.
 */
const ALLOWED_LABELS = new Set([
  "kind", "status", "fetch_class", "role", "outcome", "le", "quantile",
  "version", "major", "minor", "patch", "space", "type",
]);

/** Clause 5's live half: the endpoints of the API and each worker. */
async function clause5(metricsTexts: string[], apiInstanceId: string): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const out: Record<string, unknown> = {};
  const targets: [string, string][] = [["api", apiBase], ...live().map((w): [string, string] => [`worker ${w.instanceId}`, `http://127.0.0.1:${w.port}`])];
  for (const [name, base] of targets) {
    const h = await get(`${base}/healthz`);
    const r = await get(`${base}/readyz`);
    const noToken = await get(`${base}/metrics`);
    const apiToken = await get(`${base}/metrics`, API_TOKEN);
    const m = await get(`${base}/metrics`, METRICS_TOKEN);
    metricsTexts.push(m.text);
    check(failures, h.status === 200, `${name}: /healthz ${h.status}`);
    check(failures, r.status === 200, `${name}: /readyz ${r.status}`);
    check(failures, noToken.status === 401, `${name}: /metrics with no token answered ${noToken.status} (want 401)`);
    check(failures, apiToken.status === 401, `${name}: /metrics with the API token answered ${apiToken.status} (want 401)`);
    check(failures, m.status === 200 && m.text.includes("ariadne_jobs"), `${name}: /metrics with the metrics token answered ${m.status}`);
    const names = new Set([...m.text.matchAll(/[{,]([a-z_]+)="/g)].map((x) => x[1] as string));
    for (const label of names) check(failures, ALLOWED_LABELS.has(label), `${name}: /metrics carries a label named '${label}'`);
    const values = [...m.text.matchAll(/[a-z_]+="([^"]*)"/g)].map((x) => x[1] as string);
    for (const v of values) {
      check(failures, !v.includes(`g28b-${RUN}`) && !v.includes("127.0.0.") && !v.startsWith("crawl_") && !v.startsWith("http"), `${name}: a /metrics label value carries a tenant, host, crawl or URL (${v.slice(0, 40)})`);
    }
    out[name] = { healthz: h.status, readyz: r.status, metricsNoToken: noToken.status, metricsApiToken: apiToken.status, metricsWithToken: m.status, labelNames: [...names].sort() };
  }
  const ids = [apiInstanceId, ...live().map((w) => w.instanceId)];
  const reg = await db.execute(
    sql`select role, count(*)::int as n from instances
        where stopped_at is null and heartbeat_at > now() - interval '60 seconds'
          and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        group by role order by role`,
  );
  const liveInstances = Object.fromEntries((reg.rows as { role: string; n: number }[]).map((x) => [x.role, x.n]));
  out["liveInstances"] = liveInstances;
  check(failures, liveInstances["api"] === 1 && liveInstances["worker"] === live().length, `live instances ${JSON.stringify(liveInstances)} (want 1 api and ${live().length} workers)`);
  return { ...out, failures };
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  const url = databaseUrl();
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName === "ariadne") throw new Error("refusing to run against the dev database 'ariadne': use a database of its own (ariadne_gate28b)");
  db = createDb(url);
  const stray = await db.execute(sql`select count(*)::int as n from jobs where status in ('queued', 'running')`);
  if (Number((stray.rows[0] as { n: number }).n) > 0) throw new Error(`${dbName} has queued or running jobs: the workers this gate starts would claim them`);
  say(`GATE 28b workers — database ${dbName}, run ${RUN}`);
  say(`node ${process.version}`);

  const scratch = await mkdtemp(join(tmpdir(), "ariadne-gate-workers-"));
  peersFile = join(scratch, "peers.json");
  await writeFile(peersFile, "[]");
  api = createApiServer({
    db,
    config: {
      token: API_TOKEN,
      metricsToken: METRICS_TOKEN,
      allowedDomains: ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4"],
      credentialKeys: KEYS,
      crawlRunner: "workers",
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      exportDir: join(scratch, "exports"),
      renderDir: join(scratch, "renders"),
      log: (line) => apiLog.push(line),
    },
  });
  apiBase = `http://127.0.0.1:${(await api.listen(0)).port}`;
  const apiInstance = await api.service.instanceId();
  await writePeers([apiInstance]);

  const onSignal = (signal: NodeJS.Signals): void => {
    killAll("SIGKILL");
    console.error(`gate-workers: ${signal} — children killed`);
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", () => killAll("SIGKILL"));

  try {
    await spawnWorker(apiInstance);
    await spawnWorker(apiInstance);
    say(`two workers up: ${workers.map((w) => w.instanceId).join(", ")}`);

    await record("2 (a fifth crawl of a running host waits)", async () => clause2());
    await record("1 (four tenants x four hosts, claimed once, two at a time)", async () => clause1());
    await record("3 (kill -9 mid-crawl: paused worker_lost, leases released, resume finishes elsewhere, no duplicate pages)", async () => clause3(apiInstance));
    await record("4a (credentialed crawl killed and finished elsewhere, values intact)", async () => clause4Credentialed(apiInstance));
    await record("4c (unknown key id and flipped tag byte: paused credentials_unreadable, 409 on resume)", async () => clause4Unreadable());

    const metricsTexts: string[] = [];
    await record("5 (live /healthz /readyz /metrics, instances registered)", async () => clause5(metricsTexts, apiInstance));
    await record("4b (secret scan: every table, both workers' output, the API's log and responses, /metrics)", async () => secretScan(metricsTexts));

    const pass = Object.values(clauses).every((c) => c.pass);
    console.log("");
    console.log(JSON.stringify({ gate: "28b-workers", run: RUN, database: dbName, pass, clauses }, null, 2));
    say(pass ? "GATE PASSED (clauses 1-5)" : "GATE FAILED — see the clauses above");
    return pass ? 0 : 1;
  } finally {
    // Graceful first, then no mercy: a worker must not outlive this script.
    for (const w of live()) w.proc.kill("SIGTERM");
    await Promise.race([Promise.all(live().map((w) => w.exited)), sleep(30_000)]);
    killAll("SIGKILL");
    await api.close().catch((e: unknown) => console.error(`api close failed: ${String(e)}`));
    await closeFetchAgents();
    await closeDb(db);
    await rm(scratch, { recursive: true, force: true });
    // The crawls and jobs stay as evidence.
    say(`done; rows of run ${RUN} stay in ${dbName}`);
  }
}

process.exitCode = await main();

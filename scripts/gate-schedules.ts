/**
 * The Phase 28c gate, clauses 1 and 2: schedules fired by a leader-elected
 * scheduler in worker PROCESSES, one leader killed mid-run.
 *
 *   DATABASE_URL=postgresql://…/ariadne_gate28c node --import tsx scripts/gate-schedules.ts [--log-dir=<dir>]
 *
 * It runs the API service in this process (`crawlRunner: "workers"`, and NOT a
 * scheduler candidate) beside two `scripts/run-worker-trusted.ts --scheduler`
 * children on the production clock (`scheduleEvery` 30 s, heartbeat 10 s, dead
 * after 60 s, reaper every 30 s), against loopback fixture hosts it serves
 * itself, and proves the spec's "Gates 28c":
 *
 *  1. Two processes are scheduler candidates. Three schedules, each a tenant of
 *     its own:
 *       - S1, `* * * * *`, `render: null`, a 20-page site. Over the ten slots
 *         T0 … T0+9 min (T0 its first slot) it fires EXACTLY 10 times — one
 *         fire in each minute [T0+i, T0+i+1), none skipped — while the leader is
 *         `kill -9`'d once, at a moment no S1 crawl or chain link is live, and a
 *         replacement worker keeps two candidates. Another candidate must lead
 *         within one `scheduleEvery` (+5 s for the poll). Each fired crawl runs
 *         crawl and then rules (`crawl_history`: `finished`, then
 *         `rules_finished{outcome: done}`, no render link, no chain failure,
 *         every event carrying S1's id), and `crawl_compare` of the first and
 *         the tenth answers `comparable: true`.
 *       - S2, `* * * * *`: its first crawl is paused (`crawl_pause`) once it is
 *         fetching, so its next slot is an `overlap` skip naming that crawl.
 *       - S3, `* * * * *`, a host the API allows (127.0.0.5) and the workers'
 *         allowlist (127.0.0.1 to .4, in code) does not: a `not-allowed` skip,
 *         no fire, no request to the host.
 *       Both read through `schedule_history`, whose fire and skip events carry
 *       `crawl_id` null (C9) and which answers the schedule's own kinds only
 *       (spec item 16: "one schedule's fires and skips").
 *  2. `crawl_history` reads the lifecycle of a crawl that was paused, resumed
 *     and finished: S2's crawl, resumed (after the schedules are disabled) and
 *     run to its end. The tested proof is test/events/crawl-events.test.ts
 *     test (a); this is the same tool over a real worker's crawl.
 *
 * THE LEADER is read from the database, never from a process's say-so: the
 * backend in `pg_stat_activity` whose `application_name` is
 * `ariadne-scheduler:<instanceId>` and which holds the granted advisory lock
 * `SCHEDULER_LOCK` in `pg_locks` (classid the key's high 32 bits, objid its
 * low 32, objsubid 1 — the same test the scheduler applies to its own session).
 * It is sampled every second for the whole run.
 *
 * A scheduler's first lock attempt is one `scheduleEvery` after its start, so
 * the schedules are created only once a leader is seen.
 *
 * SAFETY. It refuses any database but `ariadne_gate28c` — its workers fire
 * every tenant's due schedules — and one with a queued or running job, an
 * enabled schedule, or a scheduler lock already held. It disables its three
 * schedules before it ends, on every path. Rows stay as evidence. Every child
 * is killed on any exit.
 *
 * Every clause keeps a failure list; `GATE PASSED` prints only when every list
 * is empty, and the exit code is non-zero otherwise. Nothing is tuned to pass.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../src/db/client.js";
import { createApiServer, type ApiServer } from "../src/api/http.js";
import type { CredentialKeys } from "../src/crawl/credential-vault.js";
import { closeFetchAgents } from "../src/crawl/http.js";
import { SCHEDULER_LOCK } from "../src/schedule/scheduler.js";

const GATE_DB = "ariadne_gate28c";
const SCHEDULE_EVERY_MS = 30_000;
const SLOTS = 10;
const MINUTE = 60_000;
/** Another candidate leads within one `scheduleEvery`; 5 s covers the 1 s poll and the try itself. */
const TAKEOVER_BOUND_MS = SCHEDULE_EVERY_MS + 5_000;
/** The fire after which the leader is killed (once its chain has ended). */
const KILL_AFTER_FIRE = 3;

const ROOT = join(import.meta.dirname, "..");
const RUN = randomBytes(3).toString("hex");
const API_TOKEN = `gate-api-${randomBytes(12).toString("hex")}`;
const KEY_ID = `gate-${RUN}`;
const KEY_BYTES = randomBytes(32);
const KEY_ENV = `${KEY_ID}:${KEY_BYTES.toString("base64")}`;
const KEYS: CredentialKeys = { current: { id: KEY_ID, key: KEY_BYTES } };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 23)}] ${line}`);
const iso = (ms: number): string => new Date(ms).toISOString();

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  return url;
}

function parseArgs(argv: readonly string[]): { logDir: string | null } {
  let logDir: string | null = null;
  for (const [index, arg] of argv.entries()) {
    const m = /^--log-dir=(.+)$/.exec(arg);
    if (m !== null) {
      logDir = m[1] as string;
      continue;
    }
    throw new Error(`gate-schedules: argument ${index + 1} is not one this script takes (--log-dir=<dir>)`);
  }
  return { logDir };
}

// ------------------------------------------------------------------ fixture hosts

interface FixtureHost {
  base: string;
  hostKey: string;
  stats: { requests: number; pageHits: number };
  close(): Promise<void>;
}

/** A finite tree of `size` pages on `ip` (page n links to 3n+1..3n+3), each answered after `delayMs`. */
async function startHost(ip: string, size: number, delayMs: number): Promise<FixtureHost> {
  const stats = { requests: 0, pageHits: 0 };
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
    stats.pageHits += 1;
    setTimeout(() => {
      const links = [1, 2, 3]
        .map((k) => 3 * n + k)
        .filter((m) => m < size)
        .map((m) => `<a href="/t/${m}">page ${m}</a>`)
        .join(" ");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><title>Schedule gate page ${n} of ${ip}</title>` +
          `<meta name="description" content="A scheduler gate fixture page, number ${n}, with enough words to be a description."></head>` +
          `<body><h1>Schedule gate page ${n}</h1><p>${links}</p></body></html>`,
      );
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ------------------------------------------------------------------ worker children

interface Worker {
  proc: ChildProcess;
  pid: number;
  instanceId: string;
  stderr: string[];
  exited: Promise<number | null>;
  dead: boolean;
  log: WriteStream | null;
}

const workers: Worker[] = [];
let peersFile = "";
let apiInstance = "";
let logDir: string | null = null;

async function writePeers(): Promise<void> {
  await writeFile(peersFile, JSON.stringify([apiInstance, ...workers.map((w) => w.instanceId)]));
}

async function spawnWorker(label: string): Promise<Worker> {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/run-worker-trusted.ts", "--scheduler", `--schedule-every-ms=${SCHEDULE_EVERY_MS}`],
    {
      cwd: ROOT,
      env: {
        PATH: process.env["PATH"],
        DATABASE_URL: databaseUrl(),
        ARIADNE_CREDENTIALS_KEY: KEY_ENV,
        TRUSTED_WORKER_PEERS_FILE: peersFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const pid = proc.pid;
  if (pid === undefined) throw new Error("worker child has no pid");
  const log = logDir === null ? null : createWriteStream(join(logDir, `worker-${label}-${pid}.log`));
  proc.stdout?.setEncoding("utf8").on("data", (c: string) => {
    stdout.push(c);
    log?.write(c);
  });
  // Every scheduler line goes to the run log as it happens: the leader's own account, beside the database's.
  let partial = "";
  proc.stderr?.setEncoding("utf8").on("data", (c: string) => {
    stderr.push(c);
    log?.write(c);
    partial += c;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (/scheduler/.test(line)) say(`  worker ${label} (pid ${pid}): ${line}`);
  });
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  const ready = await new Promise<{ instanceId: string }>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`worker not ready in 90 s\n${stderr.join("")}`)), 90_000);
    const poll = setInterval(() => {
      const line = stdout.join("").split("\n").find((l) => l.startsWith("READY "));
      if (line === undefined) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(JSON.parse(line.slice("READY ".length)) as { instanceId: string });
    }, 25);
    void exited.then((code) => {
      clearInterval(poll);
      clearTimeout(deadline);
      reject(new Error(`worker exited ${String(code)} before it was ready\n${stderr.join("")}`));
    });
  });
  const worker: Worker = { proc, pid, instanceId: ready.instanceId, stderr, exited, dead: false, log };
  void exited.then(() => {
    worker.dead = true;
    log?.end();
  });
  workers.push(worker);
  await writePeers();
  say(`worker ${label} up: pid ${pid}, instance ${worker.instanceId}`);
  return worker;
}

const live = (): Worker[] => workers.filter((w) => !w.dead);

function killAll(signal: NodeJS.Signals): void {
  for (const w of workers) {
    if (!w.dead) {
      try {
        w.proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

// ------------------------------------------------------------------ the API and its client

let db: Db;
let api: ApiServer;
let apiBase = "";
const apiLog: string[] = [];

interface Res {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, tenant: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${API_TOKEN}`, "x-ariadne-tenant": tenant };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function ok(method: string, path: string, tenant: string, want: number, body?: unknown): Promise<Record<string, unknown>> {
  const res = await call(method, path, tenant, body);
  if (res.status !== want) throw new Error(`${method} ${path}: ${res.status} (want ${want}) ${res.text.slice(0, 400)}`);
  return res.body;
}

interface Event {
  id: string;
  at: string;
  kind: string;
  scheduleId: string | null;
  crawlId: string | null;
  detail: Record<string, unknown>;
}

/** Every page of a history route, oldest first. */
async function history(path: string, tenant: string): Promise<Event[]> {
  const out: Event[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await ok("GET", `${path}?limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, tenant, 200);
    out.push(...(page["items"] as Event[]));
    cursor = (page["nextCursor"] as string | null) ?? null;
    if (cursor === null) return out;
  }
}

const tenantFor = (label: string): string => `g28c-${RUN}-${label}`;

// ------------------------------------------------------------------ the leader, from the database

interface LeaderSample {
  at: number;
  leaders: string[];
}

async function readLeaders(): Promise<string[]> {
  const r = await db.execute(sql`
    select a.application_name as name
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory' and l.granted
       and l.database = (select oid from pg_database where datname = current_database())
       and l.classid = (${SCHEDULER_LOCK}::bigint >> 32)::oid
       and l.objid = (${SCHEDULER_LOCK}::bigint & 4294967295)::oid
       and l.objsubid = 1`);
  return (r.rows as { name: string }[]).map((row) => row.name.replace(/^ariadne-scheduler:/, ""));
}

/** Leadership as sampled every second: the transitions, and any sample that saw two leaders. */
const leaderTimeline: { at: string; leader: string | null }[] = [];
let leaderSamples = 0;
let multiLeaderSamples = 0;
let lastLeader: string | null | undefined;
let currentLeader: string | null = null;
const leaderLog: LeaderSample[] = [];

async function sampleLeader(): Promise<void> {
  const leaders = await readLeaders();
  const now = Date.now();
  leaderSamples += 1;
  if (leaders.length > 1) multiLeaderSamples += 1;
  leaderLog.push({ at: now, leaders });
  const leader = leaders[0] ?? null;
  currentLeader = leader;
  if (leader !== lastLeader) {
    lastLeader = leader;
    leaderTimeline.push({ at: iso(now), leader });
    say(`leader is now ${leader ?? "(none)"}${leaders.length > 1 ? ` — and ${leaders.length - 1} more!` : ""}`);
  }
}

// ------------------------------------------------------------------ rows

async function eventsOf(scheduleId: string, kind: string): Promise<{ at: Date; detail: Record<string, unknown> }[]> {
  const r = await db.execute(
    sql`select at, detail from crawl_events where schedule_id = ${scheduleId} and kind = ${kind} and crawl_id is null order by id`,
  );
  return (r.rows as { at: Date | string; detail: Record<string, unknown> }[]).map((row) => ({ at: new Date(row.at), detail: row.detail }));
}

/** S1's crawls or chain links still live (the overlap read's own predicate). */
async function liveWorkOf(scheduleId: string): Promise<number> {
  const r = await db.execute(sql`
    select count(*)::int as n from crawls c
     where c.schedule_id = ${scheduleId}
       and (c.status in ('queued', 'running', 'paused')
            or exists (select 1 from jobs j where j.crawl_id = c.id and j.status in ('queued', 'running')))`);
  return Number((r.rows[0] as { n: number }).n);
}

async function rulesFinished(crawlId: string): Promise<boolean> {
  const r = await db.execute(sql`select count(*)::int as n from crawl_events where crawl_id = ${crawlId} and kind = 'rules_finished'`);
  return Number((r.rows[0] as { n: number }).n) > 0;
}

/** Pages stored so far: the live count (`crawls.pages_crawled` is written only when the crawl closes). */
async function pagesStored(crawlId: string): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from pages where crawl_id = ${crawlId}`);
  return Number((r.rows[0] as { n: number }).n);
}

async function crawlStatus(crawlId: string): Promise<{ status: string; pages_crawled: number; pause_reason: string | null }> {
  const r = await db.execute(sql`select status, pages_crawled, pause_reason from crawls where id = ${crawlId}`);
  const row = r.rows[0] as { status: string; pages_crawled: number; pause_reason: string | null } | undefined;
  if (row === undefined) throw new Error(`no crawl ${crawlId}`);
  return row;
}

async function nextRunAt(scheduleId: string): Promise<number | null> {
  const r = await db.execute(sql`select next_run_at from schedules where id = ${scheduleId}`);
  const v = (r.rows[0] as { next_run_at: Date | string | null } | undefined)?.next_run_at ?? null;
  return v === null ? null : new Date(v).getTime();
}

async function waitFor<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms: ${what} (last: ${JSON.stringify(value).slice(0, 300)})`);
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------------ clauses

interface Clause {
  pass: boolean;
  evidence: Record<string, unknown>;
}
const clauses: Record<string, Clause> = {};

function check(failures: string[], cond: boolean, message: string): void {
  if (!cond) failures.push(message);
}

/**
 * Run one clause. The body pushes onto `failures`; a throw is a failure too.
 * The clause passes only when the list is empty (the 28b lesson: a clause with
 * failures never prints PASS).
 */
async function record(name: string, run: (failures: string[]) => Promise<Record<string, unknown>>): Promise<void> {
  const failures: string[] = [];
  let evidence: Record<string, unknown> = {};
  try {
    evidence = await run(failures);
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  clauses[name] = { pass: failures.length === 0, evidence: { ...evidence, failures } };
  say(`clause ${name}: ${failures.length === 0 ? "PASS" : `FAIL — ${failures.join(" | ")}`}`);
}

// ------------------------------------------------------------------ main

interface Sched {
  id: string;
  tenant: string;
  label: string;
}

const scheds: Sched[] = [];

/** This run's schedules off; every refusal is collected and thrown together. */
async function disableAll(): Promise<void> {
  const errors: string[] = [];
  for (const s of scheds) {
    const res = await call("PATCH", `/schedules/${s.id}`, s.tenant, { enabled: false }).catch((e: unknown) => ({
      status: -1,
      text: String(e),
    }));
    if (res.status !== 200) errors.push(`${s.label} ${s.id}: ${res.status} ${res.text.slice(0, 200)}`);
  }
  if (errors.length > 0) throw new Error(`could not disable: ${errors.join("; ")}`);
}

async function main(): Promise<number> {
  logDir = parseArgs(process.argv.slice(2)).logDir;
  const url = databaseUrl();
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName !== GATE_DB) {
    throw new Error(`refusing to run against '${dbName}': this gate's workers fire every due schedule they find, so it runs only on '${GATE_DB}'`);
  }
  if (logDir !== null) await mkdir(logDir, { recursive: true });
  db = createDb(url);
  const stray = await db.execute(sql`select count(*)::int as n from jobs where status in ('queued', 'running')`);
  if (Number((stray.rows[0] as { n: number }).n) > 0) throw new Error(`${dbName} has queued or running jobs: the workers this gate starts would claim them`);
  const enabled = await db.execute(sql`select count(*)::int as n from schedules where enabled`);
  if (Number((enabled.rows[0] as { n: number }).n) > 0) throw new Error(`${dbName} has enabled schedules: this gate's schedulers would fire them`);
  const held = await readLeaders();
  if (held.length > 0) throw new Error(`the scheduler lock is already held on ${dbName} (by ${held.join(", ")}): another scheduler runs here`);

  say(`GATE 28c schedules — database ${dbName}, run ${RUN}, node ${process.version}, scheduleEvery ${SCHEDULE_EVERY_MS} ms`);

  const scratch = await mkdtemp(join(tmpdir(), "ariadne-gate-schedules-"));
  peersFile = join(scratch, "peers.json");
  await writeFile(peersFile, "[]");
  const h1 = await startHost("127.0.0.1", 20, 50);
  const h2 = await startHost("127.0.0.2", 600, 100);
  const h5 = await startHost("127.0.0.5", 20, 50);
  say(`fixture hosts: S1 ${h1.hostKey} (20 pages), S2 ${h2.hostKey} (600 pages, slow), S3 ${h5.hostKey} (not on the workers' allowlist)`);

  api = createApiServer({
    db,
    config: {
      token: API_TOKEN,
      metricsToken: null,
      // The API allows 127.0.0.5; the workers (scripts/run-worker-trusted.ts) do not.
      allowedDomains: ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5"],
      credentialKeys: KEYS,
      crawlRunner: "workers",
      // Not a scheduler candidate: the gate's two candidates are the workers.
      scheduler: false,
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      exportDir: join(scratch, "exports"),
      renderDir: join(scratch, "renders"),
      log: (line) => apiLog.push(line),
    },
  });
  apiBase = `http://127.0.0.1:${(await api.listen(0)).port}`;
  apiInstance = await api.service.instanceId();
  await writePeers();

  // Interrupted: the workers die first (nothing fires after this), then the schedules are disabled, said aloud.
  const onSignal = (signal: NodeJS.Signals): void => {
    killAll("SIGKILL");
    console.error(`gate-schedules: ${signal} — children killed; disabling this run's schedules`);
    void disableAll()
      .catch((error: unknown) => console.error(`gate-schedules: disabling the schedules failed — ${String(error)}`))
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", () => killAll("SIGKILL"));

  // The leader sampler: every second, for the whole run.
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        await sampleLeader();
      } catch (error) {
        say(`leader sample failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(1_000);
    }
  })();

  const evidence: Record<string, unknown> = {};
  try {
    await spawnWorker("A");
    await spawnWorker("B");
    const startedAt = Date.now();
    await waitFor("a scheduler leader", async () => currentLeader, (l) => l !== null, 2 * SCHEDULE_EVERY_MS + 15_000, 250);
    say(`first leader after ${Date.now() - startedAt} ms: ${currentLeader}`);

    // Not within 5 s of a minute boundary, so the three schedules share their first slot.
    while (60_000 - (Date.now() % 60_000) < 5_000) await sleep(250);
    const create = async (label: string, siteUrl: string, maxPages: number): Promise<{ s: Sched; nextRunAt: string }> => {
      const tenant = tenantFor(label);
      const body = await ok("POST", "/schedules", tenant, 201, {
        crawl: { siteUrl, maxPages, maxConcurrency: 1 },
        cron: "* * * * *",
        timezone: "UTC",
        render: null,
      });
      const s = { id: String(body["scheduleId"]), tenant, label };
      scheds.push(s);
      say(`${label}: ${s.id} (tenant ${tenant}), next run ${String(body["nextRunAt"])}`);
      return { s, nextRunAt: String(body["nextRunAt"]) };
    };
    const c1 = await create("S1", `${h1.base}/`, 20);
    const c2 = await create("S2", `${h2.base}/`, 600);
    const c3 = await create("S3", `${h5.base}/`, 20);
    const [s1, s2, s3] = [c1.s, c2.s, c3.s];
    const t0 = new Date(c1.nextRunAt).getTime();
    const windowEnd = t0 + SLOTS * MINUTE;
    say(`S1's window: the ${SLOTS} slots ${iso(t0)} … ${iso(t0 + (SLOTS - 1) * MINUTE)}; fires counted in [${iso(t0)}, ${iso(windowEnd)})`);
    evidence["window"] = { t0: iso(t0), end: iso(windowEnd), firstSlots: { S1: c1.nextRunAt, S2: c2.nextRunAt, S3: c3.nextRunAt } };

    // ---- the run: S2's pause, the kill, until the window has closed
    let s2Crawl: string | null = null;
    let s2PausedAt: number | null = null;
    let kill: { at: number; instanceId: string; pid: number; s1FiresBefore: number } | null = null;
    let takeover: { at: number; instanceId: string; ms: number } | null = null;
    while (Date.now() < windowEnd + 5_000) {
      // S2: pause its first crawl once it is fetching.
      if (s2PausedAt === null) {
        const fired = await eventsOf(s2.id, "schedule_fired");
        const first = fired[0];
        if (first !== undefined) {
          s2Crawl = String(first.detail["crawlId"]);
          const row = await crawlStatus(s2Crawl);
          if (row.status !== "queued" && row.status !== "running") {
            throw new Error(`S2's first crawl ${s2Crawl} is ${row.status} before the gate could pause it`);
          }
          const stored = await pagesStored(s2Crawl);
          if (row.status === "running" && stored >= 3) {
            const res = await call("POST", `/crawls/${s2Crawl}/pause`, s2.tenant);
            say(`S2: crawl_pause of ${s2Crawl} at ${stored} stored pages answered ${res.status}`);
            if (res.status !== 202 && res.status !== 200) throw new Error(`pause of S2's crawl answered ${res.status} ${res.text}`);
            await waitFor("S2's crawl paused", () => crawlStatus(s2Crawl as string), (r) => r.status === "paused", 60_000);
            s2PausedAt = Date.now();
            say(`S2: ${s2Crawl} is paused`);
          }
        }
      }
      // The kill: once, after fire KILL_AFTER_FIRE's chain ended, with nothing of S1 live and the next slot ≥ 15 s away.
      if (kill === null) {
        const fires = await eventsOf(s1.id, "schedule_fired");
        const last = fires[fires.length - 1];
        const next = await nextRunAt(s1.id);
        if (
          fires.length >= KILL_AFTER_FIRE &&
          last !== undefined &&
          (await rulesFinished(String(last.detail["crawlId"]))) &&
          (await liveWorkOf(s1.id)) === 0 &&
          next !== null &&
          next - Date.now() >= 15_000
        ) {
          const leaders = await readLeaders();
          const victim = workers.find((w) => !w.dead && w.instanceId === leaders[0]);
          if (leaders.length !== 1 || victim === undefined) {
            throw new Error(`the leader is not one of this gate's live workers (leaders: ${JSON.stringify(leaders)})`);
          }
          kill = { at: Date.now(), instanceId: victim.instanceId, pid: victim.pid, s1FiresBefore: fires.length };
          victim.proc.kill("SIGKILL");
          say(`KILL -9 the leader: worker pid ${victim.pid}, instance ${victim.instanceId} (S1 fires so far ${fires.length}, nothing of S1 live, next slot ${iso(next)})`);
          await victim.exited;
          await spawnWorker("C");
          say(`replacement worker up; candidates: ${live().map((w) => w.instanceId).join(", ")}`);
        }
      } else if (takeover === null && currentLeader !== null && currentLeader !== kill.instanceId) {
        const at = leaderLog.find((s) => s.at > kill!.at && s.leaders.length > 0 && s.leaders[0] !== kill!.instanceId)?.at ?? Date.now();
        takeover = { at, instanceId: currentLeader, ms: at - kill.at };
        say(`takeover: ${currentLeader} leads ${takeover.ms} ms after the kill`);
      }
      await sleep(1_000);
    }
    say("the window has closed; waiting for the window's chains to end");

    const firesAll = await eventsOf(s1.id, "schedule_fired");
    const inWindow = firesAll.filter((f) => f.at.getTime() >= t0 && f.at.getTime() < windowEnd);
    const windowCrawls = inWindow.map((f) => String(f.detail["crawlId"]));
    // Each windowed crawl's chain must end (rules_finished or a chain failure), bounded.
    await waitFor(
      "every windowed S1 crawl's chain ended",
      async () => {
        let ended = 0;
        for (const id of windowCrawls) {
          const r = await db.execute(
            sql`select count(*)::int as n from crawl_events where crawl_id = ${id} and kind in ('rules_finished', 'schedule_chain_failed')`,
          );
          if (Number((r.rows[0] as { n: number }).n) > 0) ended += 1;
        }
        return ended;
      },
      (n) => n === windowCrawls.length,
      180_000,
      1_000,
    );

    // Stop the schedules, then let whatever S1 fired after the window settle.
    await disableAll();
    say("S1, S2, S3 disabled");
    await waitFor("no S1 crawl or link live", () => liveWorkOf(s1.id), (n) => n === 0, 180_000, 1_000);

    // ---- clause 1a: exactly ten fires, one per slot, the leader killed once
    await record("1a (two candidates; 10 slots fire exactly 10 times; the leader killed once)", async (failures) => {
      const buckets = Array.from({ length: SLOTS }, (_, i) =>
        inWindow.filter((f) => f.at.getTime() >= t0 + i * MINUTE && f.at.getTime() < t0 + (i + 1) * MINUTE).length,
      );
      const s1Skips = await eventsOf(s1.id, "schedule_skipped");
      const skipsInWindow = s1Skips.filter((f) => f.at.getTime() >= t0 && f.at.getTime() < windowEnd);
      check(failures, inWindow.length === SLOTS, `S1 fired ${inWindow.length} times in its ${SLOTS} slots (want exactly ${SLOTS})`);
      check(failures, buckets.every((n) => n === 1), `S1's fires per minute were ${JSON.stringify(buckets)} (want one in each)`);
      check(failures, skipsInWindow.length === 0, `S1 skipped ${skipsInWindow.length} slots in the window (want 0): ${JSON.stringify(skipsInWindow.map((s) => s.detail))}`);
      check(failures, new Set(windowCrawls).size === windowCrawls.length, "two of S1's fires name the same crawl");
      check(failures, kill !== null, "the leader was never killed");
      check(failures, takeover !== null, "no other candidate took the lead after the kill");
      if (takeover !== null) check(failures, takeover.ms <= TAKEOVER_BOUND_MS, `the takeover took ${takeover.ms} ms (bound ${TAKEOVER_BOUND_MS} ms: one scheduleEvery + 5 s)`);
      if (kill !== null) {
        const firesAfter = inWindow.filter((f) => f.at.getTime() > kill!.at).length;
        check(failures, firesAfter > 0, "no S1 fire after the kill");
        check(failures, firesAfter + kill.s1FiresBefore === inWindow.length, `fires before the kill (${kill.s1FiresBefore}) and after (${firesAfter}) do not add up to ${inWindow.length}`);
      }
      check(failures, multiLeaderSamples === 0, `${multiLeaderSamples} samples saw two leaders`);
      const liveCandidates = live().length;
      check(failures, liveCandidates === 2, `${liveCandidates} candidate workers live at the end (want 2)`);
      const fireLag = inWindow.map((f, i) => Math.round((f.at.getTime() - (t0 + i * MINUTE)) / 100) / 10);
      return {
        s1: s1.id,
        firesInWindow: inWindow.length,
        firesPerMinute: buckets,
        fireLagSeconds: fireLag,
        fireTimes: inWindow.map((f) => f.at.toISOString()),
        firesAfterWindow: firesAll.length - inWindow.length,
        skipsInWindow: skipsInWindow.length,
        kill: kill === null ? null : { at: iso(kill.at), instanceId: kill.instanceId, pid: kill.pid, s1FiresBefore: kill.s1FiresBefore },
        takeover: takeover === null ? null : { at: iso(takeover.at), instanceId: takeover.instanceId, ms: takeover.ms },
        leaderTimeline,
        leaderSamples,
        multiLeaderSamples,
        candidatesAtEnd: live().map((w) => w.instanceId),
        workersStarted: workers.map((w) => ({ pid: w.pid, instanceId: w.instanceId, dead: w.dead })),
      };
    });

    // ---- clause 1b: each fire ran crawl then rules
    await record("1b (each fired crawl ran crawl then rules: crawl_history)", async (failures) => {
      const perCrawl: Record<string, unknown>[] = [];
      for (const id of windowCrawls) {
        const status = await ok("GET", `/crawls/${id}`, s1.tenant, 200);
        const events = await history(`/crawls/${id}/history`, s1.tenant);
        const kinds = events.map((e) => e.kind);
        const finished = kinds.indexOf("finished");
        const rulesDone = events.findIndex((e) => e.kind === "rules_finished" && e.detail["outcome"] === "done");
        check(failures, status["status"] === "finished", `${id}: status ${String(status["status"])} (want finished)`);
        check(failures, status["renderDocuments"] === "not kept", `${id}: renderDocuments ${String(status["renderDocuments"])} (want "not kept")`);
        check(failures, finished >= 0, `${id}: no finished event`);
        check(failures, rulesDone > finished && finished >= 0, `${id}: no rules_finished{outcome: done} after finished (kinds ${kinds.join(",")})`);
        check(failures, !kinds.some((k) => k.startsWith("render_")), `${id}: a render link ran on a render: null schedule`);
        check(failures, !kinds.includes("schedule_chain_failed"), `${id}: schedule_chain_failed`);
        check(failures, events.every((e) => e.scheduleId === s1.id), `${id}: an event without S1's schedule id`);
        perCrawl.push({ crawlId: id, status: status["status"], pagesCrawled: status["pagesCrawled"], renderDocuments: status["renderDocuments"], kinds });
      }
      check(failures, perCrawl.length === SLOTS, `${perCrawl.length} crawls checked (want ${SLOTS})`);
      return { crawls: perCrawl };
    });

    // ---- clause 1c: the compare between two fired crawls
    await record("1c (crawl_compare of two fired crawls is comparable)", async (failures) => {
      const base = windowCrawls[0];
      const head = windowCrawls[windowCrawls.length - 1];
      if (base === undefined || head === undefined || base === head) {
        failures.push("fewer than two fired crawls to compare");
        return {};
      }
      const cmp = await ok("GET", `/compare?baseCrawlId=${base}&headCrawlId=${head}`, s1.tenant, 200);
      check(failures, cmp["comparable"] === true, `comparable ${String(cmp["comparable"])}, caveats ${JSON.stringify(cmp["caveats"])}`);
      return { base, head, comparable: cmp["comparable"], caveats: cmp["caveats"] ?? null };
    });

    // ---- clause 1d: an overlap skip and a not-allowed skip
    await record("1d (an overlap skip and a not-allowed skip are recorded: schedule_history)", async (failures) => {
      const h2Events = await history(`/schedules/${s2.id}/history`, s2.tenant);
      const h3Events = await history(`/schedules/${s3.id}/history`, s3.tenant);
      const s2Fires = h2Events.filter((e) => e.kind === "schedule_fired");
      const overlaps = h2Events.filter((e) => e.kind === "schedule_skipped" && e.detail["reason"] === "overlap");
      const s3Fires = h3Events.filter((e) => e.kind === "schedule_fired");
      const notAllowed = h3Events.filter((e) => e.kind === "schedule_skipped" && e.detail["reason"] === "not-allowed");
      check(failures, s2PausedAt !== null, "S2's crawl was never paused");
      check(failures, s2Fires.length === 1, `S2 fired ${s2Fires.length} crawls (want 1: every later slot overlaps)`);
      check(failures, overlaps.length >= 1, "S2 has no overlap skip");
      check(failures, overlaps.every((e) => e.detail["crawlId"] === s2Crawl), "an S2 overlap skip names another crawl than the paused one");
      check(failures, notAllowed.length >= 1, "S3 has no not-allowed skip");
      check(failures, s3Fires.length === 0, `S3 fired ${s3Fires.length} crawls (want 0)`);
      check(failures, h5.stats.requests === 0, `S3's host saw ${h5.stats.requests} requests (want 0)`);
      const both = [...h2Events, ...h3Events];
      const firesAndSkips = both.filter((e) => e.kind === "schedule_fired" || e.kind === "schedule_skipped");
      check(failures, firesAndSkips.every((e) => e.crawlId === null), "a fire or skip event carries a crawl_id (C9: null, the crawl named in detail)");
      // The spec (item 16: "one schedule's fires and skips") and the tool's own description:
      // schedule_history answers the schedule kinds only, not its fired crawls' lifecycles.
      const SCHEDULE_KINDS = new Set(["schedule_fired", "schedule_skipped", "schedule_chain_failed"]);
      const foreignKinds = [...new Set(both.filter((e) => !SCHEDULE_KINDS.has(e.kind)).map((e) => e.kind))];
      check(
        failures,
        foreignKinds.length === 0,
        `schedule_history answers ${both.length - firesAndSkips.length} events of kinds other than the schedule's own ` +
          `(${foreignKinds.join(", ")}): its fired crawls' lifecycle events`,
      );
      return {
        s2: { id: s2.id, crawl: s2Crawl, pausedAt: s2PausedAt === null ? null : iso(s2PausedAt), fires: s2Fires.length, overlapSkips: overlaps.length, firstOverlap: overlaps[0] ?? null },
        s3: { id: s3.id, fires: s3Fires.length, notAllowedSkips: notAllowed.length, firstSkip: notAllowed[0] ?? null, hostRequests: h5.stats.requests },
        historyKinds: {
          s2: Object.fromEntries([...new Set(h2Events.map((e) => e.kind))].map((k) => [k, h2Events.filter((e) => e.kind === k).length])),
          s3: Object.fromEntries([...new Set(h3Events.map((e) => e.kind))].map((k) => [k, h3Events.filter((e) => e.kind === k).length])),
        },
      };
    });

    // ---- clause 2: crawl_history over a paused, resumed and finished crawl
    await record("2 (crawl_history reads a crawl paused, resumed and finished)", async (failures) => {
      if (s2Crawl === null) {
        failures.push("S2 never fired a crawl");
        return {};
      }
      const id = s2Crawl;
      const res = await ok("POST", `/crawls/${id}/resume`, s2.tenant, 202);
      say(`clause 2: resumed ${id}: ${JSON.stringify(res)}`);
      await waitFor("S2's crawl finished", () => crawlStatus(id), (r) => r.status === "finished", 300_000, 1_000);
      await waitFor("S2's chain ended", () => rulesFinished(id), (v) => v, 120_000, 1_000);
      const events = await history(`/crawls/${id}/history`, s2.tenant);
      const kinds = events.map((e) => e.kind);
      const want = ["queued", "claimed", "started", "paused", "resumed", "claimed", "started", "finished", "rules_finished"];
      let at = 0;
      for (const k of kinds) if (k === want[at]) at += 1;
      check(failures, at === want.length, `the history ${kinds.join(",")} does not hold ${want.join(",")} in order`);
      const paused = events.find((e) => e.kind === "paused");
      check(failures, paused?.detail["reason"] === "request", `the pause's reason is ${String(paused?.detail["reason"])} (want request)`);
      const resumed = events.find((e) => e.kind === "resumed");
      check(failures, resumed?.detail["auto"] === false, `resumed.auto is ${String(resumed?.detail["auto"])} (want false: an agent's resume)`);
      return { crawlId: id, events: events.map((e) => ({ at: e.at, kind: e.kind, detail: e.detail })) };
    });

    const pass = Object.values(clauses).every((c) => c.pass);
    console.log("");
    console.log(JSON.stringify({ gate: "28c-schedules", run: RUN, database: dbName, pass, ...evidence, clauses }, null, 2));
    say(pass ? "GATE PASSED (clauses 1 and 2)" : "GATE FAILED — see the clauses above");
    return pass ? 0 : 1;
  } finally {
    // The schedules off on every path, said aloud if it fails.
    await disableAll().catch((error: unknown) => console.error(`gate-schedules: ${String(error)}`));
    sampling = false;
    await sampler;
    for (const w of live()) w.proc.kill("SIGTERM");
    await Promise.race([Promise.all(live().map((w) => w.exited)), sleep(30_000)]);
    killAll("SIGKILL");
    await api.close().catch((e: unknown) => console.error(`api close failed: ${String(e)}`));
    await closeFetchAgents();
    for (const h of [h1, h2, h5]) await h.close();
    await closeDb(db);
    if (logDir !== null) await writeFile(join(logDir, "api.log"), apiLog.join("\n"));
    await rm(scratch, { recursive: true, force: true });
    say(`done; rows of run ${RUN} stay in ${dbName}`);
  }
}

process.exitCode = await main();

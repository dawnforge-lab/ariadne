/**
 * The Phase 28b gate, clause 6: the 50,000-page crawl as a `crawl` JOB in a
 * worker process, with the worker's RSS sampled from outside.
 *
 *   DATABASE_URL=postgresql://…/ariadne_gate28b node --import tsx scripts/gate-worker.ts
 *
 * This process is the harness: it serves the 50k fixture site
 * (`test/gate/site-server.ts`), enqueues the crawl through the API service in
 * `workers` mode (the same `startCrawl` a Talos call reaches, so the stored
 * config and the job are the production shape), and spawns ONE
 * `scripts/run-worker-trusted.ts` child under
 * `--max-old-space-size=512`. It then reads the CHILD's `VmRSS` from
 * `/proc/<pid>/status` every 2 s until the crawl is `finished`, and fails if
 * the peak is above 290.2 MB: the crawl phase of `gate-rules.ts`'s peak, which
 * this worker must not exceed (hard limit 512 MB, build plan rule 6).
 *
 * The child, not this process, runs the crawl, so the number is the worker's
 * alone: the fixture's and the harness's memory are not in it. `VmHWM` (the
 * kernel's own peak) is read at the end as a cross-check on the sampler.
 *
 * `GATE_PAGES` sets a smaller site for a smoke run, labelled loudly and never a
 * passed gate (as `gate-crawl.ts`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { closeDb, createDb } from "../src/db/client.js";
import { ApiService } from "../src/api/service.js";
import { CRAWL_DEFAULTS } from "../src/crawl/loop.js";
import { closeFetchAgents } from "../src/crawl/http.js";
import type { CredentialKeys } from "../src/crawl/credential-vault.js";
import { parseTenant } from "../src/tenant.js";
import { startSiteServer } from "../test/gate/site-server.js";

const ROOT = join(import.meta.dirname, "..");
const GATE_PAGES = 50_000;
/** The clause's bound, in MB (the crawl phase of gate-rules.ts), and the build plan's hard limit. */
const PEAK_BOUND_MB = 290.2;
const HARD_LIMIT_MB = 512;
const SAMPLE_MS = 2_000;
const MB = 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  return url;
}

function pageTarget(): number {
  const raw = process.env["GATE_PAGES"];
  if (raw === undefined || raw === "") return GATE_PAGES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 3) throw new RangeError(`GATE_PAGES must be an integer >= 3, got ${raw}`);
  return value;
}

/** Same headroom as gate-crawl.ts: the SITE ends the crawl, not the budget (see its comment). */
const budgetHeadroom = (pages: number): number => Math.max(50, Math.ceil(pages * 0.1));

/** A `kB` field of /proc/<pid>/status, in bytes. */
async function procKb(pid: number, field: "VmRSS" | "VmHWM"): Promise<number> {
  const text = await readFile(`/proc/${pid}/status`, "utf8");
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(text);
  if (match === null) throw new Error(`/proc/${pid}/status has no ${field}`);
  return Number(match[1]) * 1024;
}

async function main(): Promise<number> {
  const url = databaseUrl();
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName === "ariadne") throw new Error("refusing to run against the dev database 'ariadne': use a database of its own (ariadne_gate28b)");
  const pages = pageTarget();
  const budget = pages + budgetHeadroom(pages);
  const isGate = pages === GATE_PAGES;
  console.log(
    isGate
      ? `PHASE 28b GATE, CLAUSE 6 — ${GATE_PAGES.toLocaleString()} pages as a worker job, peak RSS must be <= ${PEAK_BOUND_MB} MB (hard limit ${HARD_LIMIT_MB} MB)`
      : `SMOKE RUN — ${pages.toLocaleString()} pages. NOT the gate (set GATE_PAGES=${GATE_PAGES} for that).`,
  );
  console.log(`node ${process.version}; database ${dbName}`);

  const db = createDb(url);
  const stray = await db.execute(sql`select count(*)::int as n from jobs where status in ('queued', 'running')`);
  if (Number((stray.rows[0] as { n: number }).n) > 0) throw new Error(`${dbName} has queued or running jobs: the worker this gate starts would claim them`);

  const keyBytes = randomBytes(32);
  const keyId = `gate-${randomBytes(3).toString("hex")}`;
  const keys: CredentialKeys = { current: { id: keyId, key: keyBytes } };
  const site = await startSiteServer(pages);
  const service = new ApiService(db, {
    credentialKeys: keys,
    allowedDomains: ["127.0.0.1"],
    crawlRunner: "workers",
    // Politeness is waived for the fixture alone, as in gate-crawl.ts: it is ours and its robots.txt says Crawl-delay: 0.
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    log: (line) => console.error(`api: ${line}`),
  });

  let child: ChildProcess | undefined;
  const stderr: string[] = [];
  const stdout: string[] = [];
  const killChild = (): void => { if (child !== undefined && child.exitCode === null) child.kill("SIGKILL"); };
  process.on("exit", killChild);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { killChild(); process.exit(130); });

  try {
    const tenant = parseTenant("gate-28b-50k");
    const accepted = await service.startCrawl(tenant, {
      siteUrl: `${site.base}/`,
      maxPages: budget,
      maxDepth: CRAWL_DEFAULTS.maxDepth,
      maxConcurrency: 16,
    });
    const crawlId = accepted.crawlId;
    console.log(`fixture site    ${pages.toLocaleString()} URLs at ${site.base}, crawl budget ${budget.toLocaleString()}`);
    console.log(`crawl id        ${crawlId} (queued, job enqueued, no worker yet)`);

    child = spawn(process.execPath, ["--max-old-space-size=512", "--import", "tsx", "scripts/run-worker-trusted.ts"], {
      cwd: ROOT,
      env: {
        PATH: process.env["PATH"],
        DATABASE_URL: url,
        ARIADNE_CREDENTIALS_KEY: `${keyId}:${keyBytes.toString("base64")}`,
        TRUSTED_WORKER_CONCURRENCY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8").on("data", (c: string) => stdout.push(c));
    child.stderr?.setEncoding("utf8").on("data", (c: string) => stderr.push(c));
    const pid = child.pid;
    if (pid === undefined) throw new Error("worker child has no pid");
    const exited = new Promise<number | null>((resolve) => child?.once("exit", (code) => resolve(code)));
    let childExit: number | null | undefined;
    void exited.then((code) => { childExit = code; });
    console.log(`worker child    pid ${pid}, node --max-old-space-size=512`);

    const startedAt = Date.now();
    let peak = 0;
    let peakAtMs = 0;
    let samples = 0;
    let status = "queued";
    let lastReport = 0;
    for (;;) {
      if (childExit !== undefined) {
        throw new Error(`the worker exited ${String(childExit)} before the crawl finished\n${stderr.join("").slice(-2000)}`);
      }
      const rss = await procKb(pid, "VmRSS");
      samples += 1;
      if (rss > peak) { peak = rss; peakAtMs = Date.now() - startedAt; }
      const row = await db.execute(sql`select status, pages_crawled from crawls where id = ${crawlId}`);
      const r = row.rows[0] as { status: string; pages_crawled: number } | undefined;
      if (r === undefined) throw new Error(`crawl ${crawlId} vanished`);
      status = r.status;
      if (status === "finished") break;
      if (status === "failed" || status === "paused" || status === "cancelled") {
        throw new Error(`the crawl ended '${status}' before it finished\n${stderr.join("").slice(-2000)}`);
      }
      if (Date.now() - lastReport > 60_000) {
        lastReport = Date.now();
        const frontier = await db.execute(sql`select count(*)::int as n from frontier where crawl_id = ${crawlId} and state = 'done'`);
        console.log(`  +${Math.round((Date.now() - startedAt) / 1000)}s  ${status}  frontier done ${(frontier.rows[0] as { n: number }).n.toLocaleString()}  rss ${(rss / MB).toFixed(1)} MB (peak ${(peak / MB).toFixed(1)})`);
      }
      await sleep(SAMPLE_MS);
    }
    const elapsedMs = Date.now() - startedAt;
    // One last read: the kernel's own high-water mark, as a cross-check of the sampler.
    const hwm = await procKb(pid, "VmHWM");
    const finalRss = await procKb(pid, "VmRSS");
    peak = Math.max(peak, finalRss);

    const counts = await db.execute(sql`select count(*)::int as pages, count(distinct url)::int as distinct_urls from pages where crawl_id = ${crawlId}`);
    const { pages: pageRows, distinct_urls: distinctUrls } = counts.rows[0] as { pages: number; distinct_urls: number };
    const job = await db.execute(sql`select kind, status, claimed_by from jobs where crawl_id = ${crawlId}`);
    const crawl = await db.execute(sql`select pages_crawled from crawls where id = ${crawlId}`);
    const pagesCrawled = Number((crawl.rows[0] as { pages_crawled: number }).pages_crawled);

    console.log("");
    console.log(`crawl id        ${crawlId}`);
    console.log(`status          ${status}`);
    console.log(`jobs            ${JSON.stringify(job.rows)}`);
    console.log(`pages crawled   ${pagesCrawled.toLocaleString()}`);
    console.log(`pages rows      ${pageRows.toLocaleString()} (${distinctUrls.toLocaleString()} distinct URLs)`);
    console.log(`elapsed         ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`throughput      ${(pagesCrawled / (elapsedMs / 1000)).toFixed(1)} pages/sec`);
    console.log(`rss samples     ${samples} every ${SAMPLE_MS / 1000}s`);
    console.log(`PEAK RSS        ${(peak / MB).toFixed(1)} MB (sampled, at +${(peakAtMs / 1000).toFixed(0)}s); kernel VmHWM ${(hwm / MB).toFixed(1)} MB`);

    const failures: string[] = [];
    if (peak / MB > PEAK_BOUND_MB) failures.push(`peak RSS ${(peak / MB).toFixed(1)} MB exceeds the ${PEAK_BOUND_MB} MB bound`);
    if (hwm / MB > PEAK_BOUND_MB) failures.push(`kernel VmHWM ${(hwm / MB).toFixed(1)} MB exceeds the ${PEAK_BOUND_MB} MB bound`);
    if (peak / MB > HARD_LIMIT_MB) failures.push(`peak RSS exceeds the ${HARD_LIMIT_MB} MB hard limit`);
    if (pagesCrawled !== pages) failures.push(`crawled ${pagesCrawled} pages, expected exactly ${pages}`);
    if (pageRows !== pagesCrawled || distinctUrls !== pageRows) failures.push(`${pageRows} pages rows (${distinctUrls} distinct) for ${pagesCrawled} crawled pages`);
    const only = job.rows as { kind: string; status: string }[];
    if (only.length !== 1 || only[0]?.kind !== "crawl" || only[0].status !== "done") failures.push(`the crawl's jobs are ${JSON.stringify(only)}, want one crawl job, done`);

    console.log("");
    console.log(JSON.stringify({ gate: "28b-clause-6", isGate, pages, crawlId, peakRssMb: Number((peak / MB).toFixed(1)), kernelVmHwmMb: Number((hwm / MB).toFixed(1)), boundMb: PEAK_BOUND_MB, elapsedSeconds: Math.round(elapsedMs / 1000), pass: failures.length === 0 }));
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      return 1;
    }
    console.log(isGate ? "GATE PASSED (clause 6)" : "smoke run passed (not the gate)");
    return 0;
  } finally {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise<void>((r) => child?.once("exit", () => r())), sleep(30_000)]);
      killChild();
    }
    await service.close();
    await closeFetchAgents();
    await site.close();
    await closeDb(db);
  }
}

process.exitCode = await main();

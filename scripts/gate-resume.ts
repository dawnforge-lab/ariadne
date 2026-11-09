/**
 * The Phase 1 gate's second half: a crawl stopped in the middle finishes
 * correctly when it is resumed, with no page crawled twice and none lost.
 *
 * Run it after the memory gate:
 *
 *   DATABASE_URL=… node --import tsx scripts/gate-resume.ts
 *
 * The shape is: crawl the same 50,000-page fixture, abort at ~20,000 pages,
 * then call `resumeCrawl` on the same crawl id and let it drain. The frontier
 * *is* the resume state — pending rows are still pending, done rows are never
 * re-fetched — so the two assertions at the end are the whole point:
 *
 *   frontier `done` == 50,000    nothing was lost when the first run stopped
 *   `pages` rows   == 50,000     and nothing was crawled twice
 *
 * `reclaimLeases: true` is passed because that is what an operator resuming a
 * *crashed* worker must pass: rows the dead worker held are otherwise unleasable
 * until their deadline (see leaseSecondsFor in loop.ts) passes. Here the first
 * run stopped gracefully and released its own leases, so the reclaim finds
 * nothing to do — the count it reports is printed either way, because "how many
 * leases were stranded" is the number that tells the two cases apart.
 *
 * What this does NOT model is a hard kill (SIGKILL) mid-batch. The loop marks a
 * frontier row `done` as soon as the writer has *buffered* its page row, so a
 * process killed outright loses whatever is still in the writer's buffers while
 * the frontier says those URLs are finished. See docs/gates/phase-1.md.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { crawls } from "../src/db/schema.js";
import { frontierCounts } from "../src/crawl/frontier.js";
import { CRAWL_DEFAULTS, resumeCrawl, runCrawl, type CrawlConfig } from "../src/crawl/loop.js";
import { startSiteServer } from "../test/gate/site-server.js";

const GATE_PAGES = 50_000;

/** Fraction of the site crawled before the first run is stopped. */
const ABORT_AT_FRACTION = 0.4;

/** How often the frontier is polled while waiting to hit the abort point. */
const POLL_MS = 250;

/** Give up waiting for a milestone rather than hanging a CI job forever. */
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;

const MB = 1024 * 1024;

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL must be set (no fallback)");
  }
  return url;
}

function pageTarget(): number {
  const raw = process.env["GATE_PAGES"];
  if (raw === undefined || raw === "") return GATE_PAGES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 10) {
    throw new RangeError(`GATE_PAGES must be an integer ≥ 10, got ${raw}`);
  }
  return value;
}

/** Budget headroom above the site's size. See scripts/gate-crawl.ts. */
function budgetHeadroom(pages: number): number {
  return Math.max(50, Math.ceil(pages * 0.1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Highest RSS seen across both runs. The memory contract is gate-crawl.ts's
 * measurement, not this script's — but a resume that quietly cost more RAM than
 * a fresh crawl would be worth knowing about, so the number is taken here too.
 */
function startRssSampler(): { peakBytes: () => number } {
  let peak = process.memoryUsage.rss();
  const sample = (): void => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) peak = rss;
  };
  setInterval(sample, 2_000).unref();
  return {
    peakBytes: () => {
      sample();
      return peak;
    },
  };
}

async function countRows(db: Db, table: string, crawlId: string): Promise<number> {
  const res = await db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where crawl_id = ${crawlId}`,
  );
  return Number(res.rows[0]?.["n"] ?? 0);
}

/**
 * The crawl id of the run that is already in flight.
 *
 * `runCrawl` mints the id and only returns it when the crawl is over, and this
 * script has to abort that crawl in the middle — so the id is read back from
 * the `crawls` row it wrote. The site URL carries an ephemeral port unique to
 * this process, and the row must be newer than the moment we started, so the
 * match is unambiguous.
 */
async function waitForCrawlId(db: Db, siteUrl: string, since: Date): Promise<string> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ id: crawls.id })
      .from(crawls)
      .where(and(eq(crawls.siteUrl, siteUrl), gte(crawls.startedAt, since)));
    if (rows.length > 1) {
      throw new Error(`gate-resume: ${rows.length} crawls match ${siteUrl}; cannot pick one`);
    }
    const id = rows[0]?.id;
    if (id !== undefined) return id;
    await sleep(POLL_MS);
  }
  throw new Error(`gate-resume: no crawls row for ${siteUrl} after ${WAIT_TIMEOUT_MS}ms`);
}

/** Wait until the crawl has finished `target` URLs. */
async function waitForDone(db: Db, crawlId: string, target: number): Promise<number> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const counts = await frontierCounts(db, crawlId);
    if (counts.done >= target) return counts.done;
    await sleep(POLL_MS);
  }
  throw new Error(`gate-resume: crawl ${crawlId} did not reach ${target} done rows in time`);
}

async function main(): Promise<number> {
  const pages = pageTarget();
  const abortAt = Math.max(1, Math.floor(pages * ABORT_AT_FRACTION));
  const isGate = pages === GATE_PAGES;
  console.log(
    isGate
      ? `PHASE 1 RESUME GATE — ${pages.toLocaleString()} pages, first run stopped at ~${abortAt.toLocaleString()}`
      : `SMOKE RUN — ${pages.toLocaleString()} pages. NOT the gate (set GATE_PAGES=${GATE_PAGES} for that).`,
  );
  console.log(`node ${process.version}, flags ${process.execArgv.join(" ") || "(none)"}`);

  const site = await startSiteServer(pages);
  const db = createDb(databaseUrl());
  const sampler = startRssSampler();
  const config: CrawlConfig = {
    siteUrl: `${site.base}/`,
    maxPages: pages + budgetHeadroom(pages),
    maxDepth: CRAWL_DEFAULTS.maxDepth,
    userAgent: CRAWL_DEFAULTS.userAgent,
    perHostDelayMs: 0,
    maxConcurrency: 16,
    allowPrivate: true,
  };

  try {
    // ---- Run 1: crawl, then stop in the middle. -------------------------
    const controller = new AbortController();
    // A second of slack, because `crawls.started_at` is Postgres's clock and
    // this is Node's. The port in the site URL is what actually makes the match
    // unique; this only stops a skewed clock hiding the row we are looking for.
    const since = new Date(Date.now() - 1_000);
    const startedAt = Date.now();
    const first = runCrawl(db, config, controller.signal);

    const crawlId = await waitForCrawlId(db, config.siteUrl, since);
    console.log(`crawl id        ${crawlId}`);
    const doneAtAbort = await waitForDone(db, crawlId, abortAt);
    controller.abort();

    const summary1 = await first;
    const elapsed1 = Date.now() - startedAt;
    const afterAbort = await frontierCounts(db, crawlId);
    const pagesAfterRun1 = await countRows(db, "pages", crawlId);

    console.log("");
    console.log(`run 1 status    ${summary1.status}${summary1.pauseReason === null ? "" : ` [${summary1.pauseReason}]`}${summary1.note === null ? "" : ` (${summary1.note})`}`);
    console.log(`run 1 pages     ${summary1.pagesCrawled.toLocaleString()} (abort requested at ${doneAtAbort.toLocaleString()} done)`);
    console.log(`run 1 rows      ${pagesAfterRun1.toLocaleString()} in pages`);
    console.log(
      `frontier        pending ${afterAbort.pending.toLocaleString()}, leased ${afterAbort.leased}, ` +
        `done ${afterAbort.done.toLocaleString()}, failed ${afterAbort.failed}`,
    );
    console.log(`run 1 elapsed   ${(elapsed1 / 1000).toFixed(1)}s`);

    // ---- Run 2: resume the same crawl id and drain the frontier. --------
    const resumedAt = Date.now();
    // `config` is re-stated rather than inherited: `allowPrivate` is never
    // persisted on the crawls row (build-plan §7 / storableConfig), so the
    // one caller that legitimately needs it says so again, here, in the open.
    const summary2 = await resumeCrawl(db, crawlId, {
      config,
      reclaimLeases: true,
    });
    const elapsed2 = Date.now() - resumedAt;

    const pageRows = await countRows(db, "pages", crawlId);
    const linkRows = await countRows(db, "links", crawlId);
    const distinct = await db.execute(
      sql`select count(distinct url)::int as n from pages where crawl_id = ${crawlId}`,
    );
    const distinctUrls = Number(distinct.rows[0]?.["n"] ?? 0);

    console.log("");
    console.log(`run 2 status    ${summary2.status}${summary2.note === null ? "" : ` (${summary2.note})`}`);
    console.log(`run 2 pages     ${(summary2.pagesCrawled - summary1.pagesCrawled).toLocaleString()} (this run)`);
    console.log(`total pages     ${summary2.pagesCrawled.toLocaleString()}`);
    console.log(
      `frontier        pending ${summary2.frontier.pending}, leased ${summary2.frontier.leased}, ` +
        `done ${summary2.frontier.done.toLocaleString()}, failed ${summary2.frontier.failed}`,
    );
    console.log(`pages rows      ${pageRows.toLocaleString()} (${distinctUrls.toLocaleString()} distinct URLs)`);
    console.log(`links rows      ${linkRows.toLocaleString()}`);
    console.log(`run 2 elapsed   ${(elapsed2 / 1000).toFixed(1)}s`);
    console.log(`peak RSS        ${(sampler.peakBytes() / MB).toFixed(1)} MB (across both runs)`);
    console.log("");

    const failures: string[] = [];
    if (summary1.status !== "paused" || summary1.pauseReason !== "shutdown") {
      failures.push(`run 1 ended '${summary1.status}' (${String(summary1.pauseReason)}), expected 'paused' (shutdown)`);
    }
    if (afterAbort.pending + afterAbort.leased === 0) {
      failures.push("run 1 drained the frontier; there was nothing left to resume");
    }
    if (summary2.status !== "finished") {
      failures.push(`run 2 ended '${summary2.status}', expected 'finished'`);
    }
    if (summary2.frontier.done !== pages) {
      failures.push(`frontier done is ${summary2.frontier.done}, expected ${pages}`);
    }
    if (pageRows !== pages) {
      failures.push(`pages table holds ${pageRows} rows, expected exactly ${pages}`);
    }
    if (distinctUrls !== pageRows) {
      failures.push(`${pageRows} pages rows over only ${distinctUrls} distinct URLs — a URL was crawled twice`);
    }

    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      return 1;
    }
    console.log(isGate ? "RESUME GATE PASSED" : "smoke run passed (not the gate)");
    // Rows stay for inspection; `delete from crawls where id = '…'` cascades.
    return 0;
  } finally {
    await closeDb(db);
    await site.close();
  }
}

process.exitCode = await main();

/**
 * The Phase 1 gate: crawl 50,000 pages in one process and stay under 512MB of
 * RSS.
 *
 * This is the milestone the whole phase exists for, and it is a measurement,
 * not a smoke test. The number it prints — peak RSS — is the evidence recorded
 * in docs/gates/phase-1.md. If it comes out over the line, the answer is a heap
 * snapshot and a fix, never a bigger line (build plan rule 6: RAM is
 * O(concurrency), never O(URLs)).
 *
 * Run it the way the gate is defined:
 *
 *   DATABASE_URL=… node --max-old-space-size=512 --import tsx scripts/gate-crawl.ts
 *
 * `--max-old-space-size=512` is load-bearing. Without it an unbounded structure
 * merely makes the machine swap and the run slow; with it, the process dies at
 * the boundary and says so.
 *
 * `allowPrivate: true` is the one sanctioned non-test use of that flag: the
 * site under test is a loopback fixture (test/gate/site-server.ts), and the URL
 * policy would otherwise — correctly — refuse to fetch 127.0.0.1.
 */
import { sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { CRAWL_DEFAULTS, runCrawl } from "../src/crawl/loop.js";
import { startSiteServer } from "../test/gate/site-server.js";
import { LOCAL_TENANT } from "../src/api/tenant.js";

/** The gate's two numbers. Both are the build plan's, not this script's. */
const GATE_PAGES = 50_000;
const GATE_PEAK_RSS_BYTES = 512 * 1024 * 1024;

/**
 * Headroom between the fixture's page count and `maxPages`, so the *site* is
 * what ends this crawl rather than the budget.
 *
 * That is deliberate, and it is the one place this script departs from the
 * brief's literal `maxPages: 50_000`. It was introduced in Phase 1 to work
 * around a frontier-budgeting defect, and it is KEPT after that defect's fix
 * for a different reason.
 *
 * The defect (docs/gates/phase-1.md, finding 3; fixed in the Phase 23
 * follow-up, `enqueue` in src/crawl/loop.ts): the loop reserved a frontier slot
 * per *candidate* before knowing whether the URL was already queued, and
 * returned it only after the insert. Every page opens with the same site-wide
 * nav, whose targets are always known, so near the cap the nav took the last
 * of the room and the page's new links behind it were skipped. Measured here
 * as 599 of 600; on a real site (lavishalice, maxPages 600) as ~50 short with
 * thousands of link targets never queued. `enqueue` now asks the frontier
 * which candidates it already holds and reserves room only for the rest, so a
 * budget set exactly to the site's size would crawl the whole site.
 *
 * Why the headroom stays: a crawl that ends AT its budget is, correctly,
 * indistinguishable from one the budget cut short. `pagesCrawled >= maxPages`
 * is the completeness signal (`skipReason` in src/rules/query/link-graph.ts):
 * on it `links.orphan` declines to run (`links.orphan-skipped` says why) and
 * `structure.deep-page` caveats its depths. A gate crawl budgeted to the
 * site's exact size would therefore be reported as capped, and
 * scripts/gate-rules.ts would time the orphan query skipping rather than
 * running. With headroom the *site* ends the crawl,
 * the crawl is complete in the only sense the rules can verify, and the exact
 * page-count assertion still holds.
 */
function budgetHeadroom(pages: number): number {
  return Math.max(50, Math.ceil(pages * 0.1));
}

/** How often RSS is sampled. */
const SAMPLE_MS = 2_000;

const MB = 1024 * 1024;

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL must be set (no fallback)");
  }
  return url;
}

/**
 * Page count for this run. The gate is 50,000; a smaller value is allowed so
 * the script itself can be exercised in seconds, and is labelled loudly so a
 * 500-page run can never be read as a passed gate.
 */
function pageTarget(): number {
  const raw = process.env["GATE_PAGES"];
  if (raw === undefined || raw === "") return GATE_PAGES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 3) {
    throw new RangeError(`GATE_PAGES must be an integer ≥ 3, got ${raw}`);
  }
  return value;
}

/** A sampler that keeps the highest RSS it has seen, plus when it saw it. */
function startRssSampler(): { peakBytes: () => number; peakAtMs: () => number; stop: () => void } {
  const startedAt = Date.now();
  let peak = process.memoryUsage.rss();
  let peakAt = 0;
  const sample = (): void => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) {
      peak = rss;
      peakAt = Date.now() - startedAt;
    }
  };
  const timer = setInterval(sample, SAMPLE_MS);
  // The sampler must never be the reason the process stays alive.
  timer.unref();
  return {
    peakBytes: () => {
      sample();
      return peak;
    },
    peakAtMs: () => peakAt,
    stop: () => clearInterval(timer),
  };
}

async function countRows(db: Db, table: string, crawlId: string): Promise<number> {
  const res = await db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where crawl_id = ${crawlId}`,
  );
  return Number(res.rows[0]?.["n"] ?? 0);
}

async function main(): Promise<number> {
  const pages = pageTarget();
  const budget = pages + budgetHeadroom(pages);
  const isGate = pages === GATE_PAGES;
  console.log(
    isGate
      ? `PHASE 1 GATE — ${GATE_PAGES.toLocaleString()} pages, peak RSS must stay under ${GATE_PEAK_RSS_BYTES / MB}MB`
      : `SMOKE RUN — ${pages.toLocaleString()} pages. NOT the gate (set GATE_PAGES=${GATE_PAGES} for that).`,
  );
  console.log(`node ${process.version}, flags ${process.execArgv.join(" ") || "(none)"}`);
  console.log(`fixture site    ${pages.toLocaleString()} URLs, crawl budget ${budget.toLocaleString()}`);

  const site = await startSiteServer(pages);
  const db = createDb(databaseUrl());
  const sampler = startRssSampler();
  const startedAt = Date.now();

  try {
    const summary = await runCrawl(db, LOCAL_TENANT, {
      siteUrl: `${site.base}/`,
      maxPages: budget,
      maxDepth: CRAWL_DEFAULTS.maxDepth,
      userAgent: CRAWL_DEFAULTS.userAgent,
      // The fixture is ours and its robots.txt says `Crawl-delay: 0`. Nothing
      // about this waiver applies to a real origin (rule 9).
      perHostDelayMs: 0,
      maxConcurrency: 16,
      allowPrivate: true,
    });

    const elapsedMs = Date.now() - startedAt;
    const peak = sampler.peakBytes();
    const pageRows = await countRows(db, "pages", summary.crawlId);
    const linkRows = await countRows(db, "links", summary.crawlId);

    console.log("");
    console.log(`crawl id        ${summary.crawlId}`);
    console.log(`status          ${summary.status}${summary.note === null ? "" : ` (${summary.note})`}`);
    console.log(`pages crawled   ${summary.pagesCrawled.toLocaleString()}`);
    console.log(`pages rows      ${pageRows.toLocaleString()}`);
    console.log(`links rows      ${linkRows.toLocaleString()}`);
    console.log(
      `frontier        pending ${summary.frontier.pending}, leased ${summary.frontier.leased}, ` +
        `done ${summary.frontier.done}, failed ${summary.frontier.failed}`,
    );
    console.log(
      `writer          pages ${summary.writer.pages}, links ${summary.writer.links}, ` +
        `hreflang ${summary.writer.hreflang}, structured data ${summary.writer.structuredData}`,
    );
    console.log(
      `sitemap entries ${
        summary.discovery === null
          ? "none: stopped before discovery was recorded"
          : summary.discovery.sitemapEntries.toLocaleString()
      }`,
    );
    console.log(`elapsed         ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`throughput      ${(summary.pagesCrawled / (elapsedMs / 1000)).toFixed(1)} pages/sec`);
    console.log(`PEAK RSS        ${(peak / MB).toFixed(1)} MB (at +${(sampler.peakAtMs() / 1000).toFixed(0)}s)`);
    console.log("");

    const failures: string[] = [];
    if (peak > GATE_PEAK_RSS_BYTES) {
      failures.push(
        `peak RSS ${(peak / MB).toFixed(1)}MB exceeds the ${GATE_PEAK_RSS_BYTES / MB}MB contract`,
      );
    }
    // Exactly the site, not merely enough of it: a count over `pages` would
    // mean the crawler invented URLs, and one under means it lost some.
    if (summary.pagesCrawled !== pages) {
      failures.push(`crawled ${summary.pagesCrawled} pages, expected exactly ${pages}`);
    }
    if (pageRows !== summary.pagesCrawled) {
      failures.push(`${pageRows} pages rows for ${summary.pagesCrawled} crawled pages`);
    }

    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      return 1;
    }
    console.log(isGate ? "GATE PASSED" : "smoke run passed (not the gate)");
    // The rows stay: the crawl id above identifies them for inspection. Drop
    // them with `delete from crawls where id = '<crawl id>'` (cascades).
    return 0;
  } finally {
    sampler.stop();
    await closeDb(db);
    await site.close();
  }
}

process.exitCode = await main();

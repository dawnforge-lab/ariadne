/**
 * The Phase 4 gate: the WHOLE pipeline over 50,000 pages in one process —
 * crawl, then every rule of every kind — staying under 512MB of RSS.
 *
 * Phase 1 measured the crawler alone (169.5 MB peak, docs/gates/phase-1.md).
 * Phase 4 adds the half that was missing: the rule pass. It scans the 50,000
 * `pages` rows through 26 page rules, runs the two derivations, then 38 query
 * rules and 10 metric rules that read the crawl's tables whole — in SQL, never
 * into the heap (hard rule 3). The 512MB contract covers the process, so it
 * covers both halves.
 *
 * Run it the way the gate is defined:
 *
 *   DATABASE_URL=… node --max-old-space-size=512 --import tsx scripts/gate-rules.ts
 *
 * `--max-old-space-size=512` is load-bearing, exactly as in `gate-crawl.ts`:
 * without it an unbounded structure merely makes the machine swap; with it, the
 * process dies at the boundary and says so.
 *
 * WHAT IS GATED AND WHAT IS MERELY RECORDED
 *
 *  - **Gated:** peak RSS across the whole process, ≤ 512MB. Over the line is a
 *    non-zero exit; the script itself takes no heap snapshot. Finding the
 *    unbounded structure with one is the operator's next step, and raising the
 *    line is not an option (build plan rule 6).
 *    Also gated: the crawl reaching exactly the fixture's page count, and the
 *    rule pass scanning exactly the pages the crawl wrote — a rule pass that
 *    silently judged half a site would otherwise read as a fast one.
 *  - **Recorded, not gated:** every wall time here. This is the first
 *    measurement of the rule pass at scale, so it is the baseline rather than a
 *    threshold. Two rules are printed by name whatever they rank, for two
 *    different reasons:
 *      - `content.near-duplicate` — the simhash banding join, quadratic within
 *        a band. Phase 3's gate doc measured it on a 5k corpus and explicitly
 *        mandated a re-measure here. This is that mandate.
 *      - `content.template-similarity` — a Phase 4 rule, so Phase 3 mandated
 *        nothing about it; its OWN header flags a cost linear in the number of
 *        page types, and that flag has never been measured at scale.
 *
 * `allowPrivate: true` is the same sanctioned use as Phase 1: the site under
 * test is a loopback fixture (test/gate/site-server.ts).
 */
import { sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { CRAWL_DEFAULTS, runCrawl } from "../src/crawl/loop.js";
import { buildRegistry } from "../src/rules/index.js";
import {
  Registry,
  type AnyRule,
  type Finding,
  type Metric,
  type PageRecord,
} from "../src/rules/registry/registry.js";
import { runRules } from "../src/rules/run.js";
import { startSiteServer } from "../test/gate/site-server.js";

/** The gate's two numbers. Both are the build plan's, not this script's. */
const GATE_PAGES = 50_000;
const GATE_PEAK_RSS_BYTES = 512 * 1024 * 1024;

/** How often RSS is sampled — the Phase 1 interval, so the two are comparable. */
const SAMPLE_MS = 2_000;

const MB = 1024 * 1024;

/** How many rules appear in the slowest-rules table. */
const SLOWEST_SHOWN = 12;

/**
 * The two rules whose cost was flagged before this gate ran — one by Phase 3's
 * gate doc (`content.near-duplicate`), one by its own header
 * (`content.template-similarity`); see the module header for which is which.
 * Printed by name whether or not they make the slowest table, because "it did
 * not rank" is not an answer to "how long did it take".
 */
const REMEASURE_RULE_IDS = ["content.near-duplicate", "content.template-similarity"];

/**
 * Headroom between the fixture's page count and `maxPages`, so the *site* ends
 * the crawl rather than the budget. Phase 1's finding 3, unchanged: a crawl
 * budgeted at exactly the site's size stops one page short, and the gate asserts
 * an exact count. See the comment on `budgetHeadroom` in scripts/gate-crawl.ts.
 */
function budgetHeadroom(pages: number): number {
  return Math.max(50, Math.ceil(pages * 0.1));
}

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL must be set (no fallback)");
  }
  return url;
}

/**
 * Page count for this run. The gate is 50,000; a smaller value is allowed so the
 * script itself can be exercised in seconds, and is labelled loudly so a
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

/**
 * An existing crawl to run the rules over, instead of crawling. A development
 * convenience — the crawl half takes a quarter of an hour — and it is NEVER the
 * gate: without the crawl in the same process there is no whole-pipeline peak
 * RSS to report, so the run says so in its header and in its verdict.
 */
function reusedCrawlId(): string | null {
  const raw = process.env["GATE_CRAWL_ID"];
  return raw === undefined || raw === "" ? null : raw;
}

interface PhaseRss {
  peakBytes: number;
  /** Milliseconds from the start of the phase to its peak. */
  peakAtMs: number;
}

/**
 * A sampler that keeps the highest RSS it has seen — for the process as a whole,
 * which is what the contract is about, and for the current named phase, which is
 * what says whether the crawl or the rules is the expensive half.
 *
 * The phase peak is seeded with a fresh reading at `startPhase`, so a phase
 * inherits the level it starts at rather than pretending memory begins at zero.
 */
function startRssSampler(): {
  peakBytes: () => number;
  peakAtMs: () => number;
  startPhase: () => void;
  endPhase: () => PhaseRss;
  stop: () => void;
} {
  const startedAt = Date.now();
  let peak = process.memoryUsage.rss();
  let peakAt = 0;
  let phasePeak = peak;
  let phaseStartedAt = startedAt;
  let phasePeakAt = 0;

  const sample = (): void => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) {
      peak = rss;
      peakAt = Date.now() - startedAt;
    }
    if (rss > phasePeak) {
      phasePeak = rss;
      phasePeakAt = Date.now() - phaseStartedAt;
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
    startPhase: () => {
      phaseStartedAt = Date.now();
      phasePeak = process.memoryUsage.rss();
      phasePeakAt = 0;
      sample();
    },
    endPhase: () => {
      sample();
      return { peakBytes: phasePeak, peakAtMs: phasePeakAt };
    },
    stop: () => clearInterval(timer),
  };
}

interface RuleTiming {
  id: string;
  kind: AnyRule["kind"];
  /** How many times the runner called it — 1 per page for a page rule. */
  calls: number;
  ms: number;
}

/**
 * The registry the gate hands the runner: the real ruleset, with each rule's
 * `run` wrapped in a stopwatch and each phase's first `byKind` call timestamped.
 *
 * Wrapping rather than instrumenting `runRules` is deliberate — the pipeline
 * under measurement has to be the pipeline that ships, so nothing in `src/`
 * gains a hook it only ever uses here. The cost of the wrapper is two
 * `performance.now()` calls per rule invocation (1.3M of them at 50k pages ×
 * 26 page rules, tens of milliseconds in total), which is inside the noise of
 * the numbers being reported and is stated in the gate doc rather than hidden.
 */
class TimedRegistry extends Registry {
  readonly timings = new Map<string, RuleTiming>();
  /** When the runner first asked for each kind — i.e. when that phase began. */
  readonly phaseStartedAt = new Map<AnyRule["kind"], number>();
  /** When the last rule of each kind returned. */
  readonly phaseEndedAt = new Map<AnyRule["kind"], number>();

  override byKind<K extends AnyRule["kind"]>(kind: K): Extract<AnyRule, { kind: K }>[] {
    if (!this.phaseStartedAt.has(kind)) this.phaseStartedAt.set(kind, performance.now());
    return super.byKind(kind);
  }

  private record(rule: AnyRule, elapsedMs: number): void {
    const existing = this.timings.get(rule.id);
    if (existing === undefined) {
      this.timings.set(rule.id, { id: rule.id, kind: rule.kind, calls: 1, ms: elapsedMs });
    } else {
      existing.calls += 1;
      existing.ms += elapsedMs;
    }
    this.phaseEndedAt.set(rule.kind, performance.now());
  }

  /** Register the real rule behind a stopwatch of the same kind and signature. */
  wrap(rule: AnyRule): void {
    switch (rule.kind) {
      case "page":
        this.register({
          ...rule,
          run: (page: PageRecord): Finding[] => {
            const started = performance.now();
            try {
              return rule.run(page);
            } finally {
              this.record(rule, performance.now() - started);
            }
          },
        });
        return;
      case "query":
        this.register({
          ...rule,
          run: async (db: Db, crawlId: string): Promise<Finding[]> => {
            const started = performance.now();
            try {
              return await rule.run(db, crawlId);
            } finally {
              this.record(rule, performance.now() - started);
            }
          },
        });
        return;
      case "metric":
        this.register({
          ...rule,
          run: async (db: Db, crawlId: string): Promise<Metric[]> => {
            const started = performance.now();
            try {
              return await rule.run(db, crawlId);
            } finally {
              this.record(rule, performance.now() - started);
            }
          },
        });
        return;
    }
  }
}

function timedRegistry(): TimedRegistry {
  const timed = new TimedRegistry();
  // Insertion order carries through `all()`, so the rules run in exactly the
  // order the shipped registry runs them.
  for (const rule of buildRegistry().all()) timed.wrap(rule);
  return timed;
}

async function countRows(db: Db, table: string, crawlId: string): Promise<number> {
  const res = await db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where crawl_id = ${crawlId}`,
  );
  const row = res.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns exactly one row over any input,
    // including none. No row is therefore not "this table is empty for this
    // crawl" — it is a statement that did not run the way it reads, and a gate
    // that reported it as 0 would fail the page-count check for the wrong
    // reason (hard rule 7, and the metric rules' own idiom).
    throw new Error(`gate: count over '${table}' for crawl '${crawlId}' returned no row`);
  }
  return Number(row["n"]);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function megabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** `label` padded so the printed block lines up like gate-crawl.ts's. */
function line(label: string, value: string): string {
  return `${label.padEnd(16)}${value}`;
}

async function main(): Promise<number> {
  const pages = pageTarget();
  const reuse = reusedCrawlId();
  const isGate = pages === GATE_PAGES && reuse === null;

  if (reuse !== null) {
    console.log(`RULES-ONLY RUN over crawl ${reuse} — NOT the gate (no crawl in this process).`);
  } else {
    console.log(
      isGate
        ? `PHASE 4 GATE — full pipeline over ${GATE_PAGES.toLocaleString()} pages, ` +
            `peak RSS must stay under ${GATE_PEAK_RSS_BYTES / MB}MB`
        : `SMOKE RUN — ${pages.toLocaleString()} pages. NOT the gate (set GATE_PAGES=${GATE_PAGES} for that).`,
    );
  }
  console.log(`node ${process.version}, flags ${process.execArgv.join(" ") || "(none)"}`);

  const registry = timedRegistry();
  const counts = {
    page: registry.byKind("page").length,
    query: registry.byKind("query").length,
    metric: registry.byKind("metric").length,
  };
  // Asking for the counts above already timestamped every phase start. Clear
  // them so the phase boundaries below are the runner's, not this line's.
  registry.phaseStartedAt.clear();
  console.log(
    line(
      "ruleset",
      `${registry.all().length} rules — ${counts.page} page, ${counts.query} query, ${counts.metric} metric`,
    ),
  );

  const db = createDb(databaseUrl());
  const sampler = startRssSampler();
  const site = reuse === null ? await startSiteServer(pages) : null;
  let siteOpen = site !== null;

  try {
    let crawlId: string;

    if (site === null) {
      if (reuse === null) {
        throw new Error("unreachable: no fixture site was started and no crawl id was given");
      }
      crawlId = reuse;
    } else {
      const budget = pages + budgetHeadroom(pages);
      console.log(
        line("fixture site", `${pages.toLocaleString()} URLs, crawl budget ${budget.toLocaleString()}`),
      );
      console.log("");
      console.log("— crawl phase —");

      sampler.startPhase();
      const crawlStartedAt = Date.now();
      const summary = await runCrawl(db, {
        siteUrl: `${site.base}/`,
        maxPages: budget,
        maxDepth: CRAWL_DEFAULTS.maxDepth,
        userAgent: CRAWL_DEFAULTS.userAgent,
        // The fixture is ours and its robots.txt says `Crawl-delay: 0`. Nothing
        // about this waiver applies to a real origin (rule 9).
        perHostDelayMs: 0,
        maxConcurrency: 16,
        allowPrivate: true,
        // Left at its default (on) deliberately: the host rules read the probe,
        // and Phase 1's gate crawl ran with it on too.
      });
      const crawlMs = Date.now() - crawlStartedAt;
      const crawlRss = sampler.endPhase();
      crawlId = summary.crawlId;

      console.log(line("crawl id", summary.crawlId));
      console.log(
        line("status", `${summary.status}${summary.note === null ? "" : ` (${summary.note})`}`),
      );
      console.log(line("pages crawled", summary.pagesCrawled.toLocaleString()));
      console.log(
        line(
          "frontier",
          `pending ${summary.frontier.pending}, leased ${summary.frontier.leased}, ` +
            `done ${summary.frontier.done}, failed ${summary.frontier.failed}`,
        ),
      );
      console.log(line("elapsed", seconds(crawlMs)));
      console.log(
        line("throughput", `${(summary.pagesCrawled / (crawlMs / 1000)).toFixed(1)} pages/sec`),
      );
      console.log(
        line("peak RSS", `${megabytes(crawlRss.peakBytes)} (at +${(crawlRss.peakAtMs / 1000).toFixed(0)}s)`),
      );

      if (summary.pagesCrawled !== pages) {
        console.error(`FAIL: crawled ${summary.pagesCrawled} pages, expected exactly ${pages}`);
        return 1;
      }
      // The fixture is closed the moment the crawl is done: nothing in the rule
      // pass may fetch (hard rule 2), and a site still listening would leave
      // that claim untested. If a rule reaches for the network below, it now
      // gets a connection refused rather than a page.
      await site.close();
      siteOpen = false;
      console.log(line("fixture", "closed — the rule pass has no site to fetch from"));
    }

    const pageRows = await countRows(db, "pages", crawlId);
    const linkRows = await countRows(db, "links", crawlId);
    console.log(line("pages rows", pageRows.toLocaleString()));
    console.log(line("links rows", linkRows.toLocaleString()));

    console.log("");
    console.log("— rules phase —");
    sampler.startPhase();
    const rulesStartedAt = performance.now();
    const run = await runRules(db, crawlId, registry);
    const rulesMs = performance.now() - rulesStartedAt;
    const rulesRss = sampler.endPhase();

    // The phase boundaries, as the runner walked them. The runner asks the
    // registry for a kind exactly once per phase, and every rule reports when it
    // returned, so three of the four boundaries are exact:
    //
    //   page   — from the runner's first `byKind("page")` to the last page rule
    //            returning. Includes the page cursor's selects and the issue
    //            flushes between batches, which are part of what a page pass
    //            costs.
    //   derive — from the last page rule to the runner asking for the query
    //            rules. This is the one figure with company: it also carries the
    //            loop's final (empty) page select and its last flush. Both are
    //            single round trips; the derivations are two full-table passes.
    //   query  — between the runner's `byKind("query")` and `byKind("metric")`,
    //            exact.
    //   metric — from `byKind("metric")` to `runRules` returning, exact.
    //
    // Their sum is short of the total by the runner's preamble (the `crawls`
    // existence check), printed as the residual rather than folded into a phase.
    const pageStart = registry.phaseStartedAt.get("page") ?? rulesStartedAt;
    const pageEnd = registry.phaseEndedAt.get("page") ?? pageStart;
    const queryStart = registry.phaseStartedAt.get("query") ?? pageEnd;
    const metricStart = registry.phaseStartedAt.get("metric") ?? queryStart;
    const rulesEndedAt = rulesStartedAt + rulesMs;
    const phases = [
      { name: "page rules", ms: pageEnd - pageStart },
      { name: "derivations", ms: queryStart - pageEnd },
      { name: "query rules", ms: metricStart - queryStart },
      { name: "metric rules", ms: rulesEndedAt - metricStart },
    ];
    const accounted = phases.reduce((total, phase) => total + phase.ms, 0);

    console.log(line("pages scanned", run.pagesScanned.toLocaleString()));
    console.log(line("findings", run.findings.toLocaleString()));
    console.log(line("metric rows", run.metrics.toLocaleString()));
    console.log(line("wall total", seconds(rulesMs)));
    for (const phase of phases) {
      console.log(
        line(`  ${phase.name}`, `${seconds(phase.ms)}  (${((phase.ms / rulesMs) * 100).toFixed(1)}%)`),
      );
    }
    console.log(line("  unaccounted", seconds(rulesMs - accounted)));
    console.log(
      line("peak RSS", `${megabytes(rulesRss.peakBytes)} (at +${(rulesRss.peakAtMs / 1000).toFixed(0)}s)`),
    );

    const issueRows = await countRows(db, "issues", crawlId);
    const metricRows = await countRows(db, "metrics", crawlId);
    console.log(line("issues rows", issueRows.toLocaleString()));
    console.log(line("metrics rows", metricRows.toLocaleString()));

    console.log("");
    console.log(`— slowest ${SLOWEST_SHOWN} rules —`);
    const timings = [...registry.timings.values()].sort((a, b) => b.ms - a.ms);
    for (const timing of timings.slice(0, SLOWEST_SHOWN)) {
      console.log(
        line(
          `${(timing.ms / 1000).toFixed(2)}s`,
          `${timing.id} (${timing.kind}${timing.calls === 1 ? "" : `, ${timing.calls.toLocaleString()} calls`})`,
        ),
      );
    }

    console.log("");
    console.log("— the two flagged rules —");
    for (const id of REMEASURE_RULE_IDS) {
      const timing = registry.timings.get(id);
      if (timing === undefined) {
        // A rule id that has moved on cannot be reported as "fast": it was never
        // measured (hard rule 7).
        console.error(`FAIL: '${id}' is not in the registry — this gate cannot re-measure it`);
        return 1;
      }
      const rank = timings.findIndex((t) => t.id === id) + 1;
      console.log(line(`${(timing.ms / 1000).toFixed(2)}s`, `${id} (rank ${rank} of ${timings.length})`));
    }

    console.log("");
    console.log("— metric rows per metric rule —");
    for (const [id, rows] of Object.entries(run.byMetric).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(line(String(rows), id));
    }

    const peak = sampler.peakBytes();
    console.log("");
    console.log(
      line(
        "PEAK RSS",
        `${megabytes(peak)} across both phases (at +${(sampler.peakAtMs() / 1000).toFixed(0)}s), ` +
          `contract ${GATE_PEAK_RSS_BYTES / MB} MB`,
      ),
    );
    console.log("");

    const failures: string[] = [];
    if (peak > GATE_PEAK_RSS_BYTES) {
      failures.push(`peak RSS ${megabytes(peak)} exceeds the ${GATE_PEAK_RSS_BYTES / MB}MB contract`);
    }
    // A rule pass that judged fewer pages than the crawl wrote is a fast pass
    // over a partial site, which would otherwise read as a good number.
    if (run.pagesScanned !== pageRows) {
      failures.push(`rules scanned ${run.pagesScanned} pages, but the crawl wrote ${pageRows} rows`);
    }
    // Every metric rule must have run. `byMetric` names every rule the metric
    // phase drove, including the ones that produced no rows, so a metric rule
    // skipped entirely is visible here and a metric rule that legitimately
    // emitted nothing is not mistaken for one.
    const metricRuleIds = registry.byKind("metric").map((rule) => rule.id);
    const missing = metricRuleIds.filter((id) => !(id in run.byMetric));
    if (missing.length > 0) failures.push(`metric rules that never ran: ${missing.join(", ")}`);

    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      return 1;
    }
    console.log(
      isGate ? "GATE PASSED" : "run passed — NOT the gate (see the header for why)",
    );
    // The rows stay: the crawl id above identifies them for inspection. Drop
    // them with `delete from crawls where id = '<crawl id>'` (cascades).
    return 0;
  } finally {
    sampler.stop();
    await closeDb(db);
    // The happy path closed the fixture the moment the crawl ended; this is the
    // error path, where the crawl or the rule pass threw first. Guarded by a
    // flag rather than by swallowing the second close's error, which would be a
    // fallback hiding a real one (hard rule 7).
    if (site !== null && siteOpen) await site.close();
  }
}

process.exitCode = await main();

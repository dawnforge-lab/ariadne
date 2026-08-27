/**
 * The whole-pipeline gate: 50,000 pages through every pass this engine has, in
 * ONE process, staying under 512MB of RSS.
 *
 * Phase 1 measured the crawler alone (169.5 MB peak, docs/gates/phase-1.md).
 * Phase 4 added the half that was missing — the rule pass — and this script was
 * written for it. Phase 5 adds the pass BETWEEN them: a budgeted render pass
 * that drives a real Chromium over a selection of the crawl (spec §5). So the
 * script now runs three phases, in the order production runs them:
 *
 *   crawl  →  render  →  rules
 *
 * WHY IT IS THIS SCRIPT AND NOT A SECOND ONE. The gate's only hard memory
 * number is the peak RSS of a process that does all of it, and there is exactly
 * one way to measure that: do all of it in one process. A `scripts/gate-render.ts`
 * beside this one would have to crawl 50,000 pages itself to have anything to
 * render, and would then be this file with a different name — or it would skip
 * the crawl, and measure a render pass against a peak that no longer contains
 * the crawler. The render phase is therefore inserted here, and the consequence
 * is stated rather than hidden: **`docs/gates/phase-4.md`'s reproduction command
 * now runs three phases, not two.** That document is immutable and its numbers
 * stand as the record of the tree they were measured on; the supersession is
 * noted in `docs/gates/phase-5.md`.
 *
 * Run it the way the gate is defined:
 *
 *   DATABASE_URL=… node --max-old-space-size=512 --import tsx scripts/gate-rules.ts
 *
 * `--max-old-space-size=512` is load-bearing, exactly as in `gate-crawl.ts`:
 * without it an unbounded structure merely makes the machine swap; with it, the
 * process dies at the boundary and says so.
 *
 * WHEN THE FIXTURE CLOSES, AND WHY IT MOVED. Phase 4 closed the fixture web
 * server the instant the crawl ended, so that a rule reaching for the network
 * (hard rule 2) got a connection refused rather than a page. The render pass
 * *must* fetch — that is what it is — so the fixture now stays up through it and
 * closes immediately after. The rule pass still faces a dead socket, which is
 * the property that was worth having.
 *
 * WHAT IS GATED AND WHAT IS MERELY RECORDED
 *
 *  - **Gated:** peak RSS across the whole process, ≤ 512MB. Over the line is a
 *    non-zero exit; the script itself takes no heap snapshot. Finding the
 *    unbounded structure with one is the operator's next step, and raising the
 *    line is not an option (build plan rule 6). The 512MB contract is about
 *    THIS process — the browser's own processes are children with their own
 *    address spaces, so their RSS is measured and reported beside the gated
 *    number rather than folded into it (see `childRssBytes`).
 *    Also gated: the crawl reaching exactly the fixture's page count; the rule
 *    pass scanning exactly the pages the crawl wrote (a rule pass that silently
 *    judged half a site would otherwise read as a fast one); and the render
 *    pass rendering **no more than `GATE_RENDER_PCT` of the crawled URLs**,
 *    which is the budget contract of spec §5 asserted rather than trusted.
 *  - **Recorded, not gated:** every wall time here, and every number the render
 *    pass produces except the count above. Two rules are printed by name
 *    whatever they rank, for two different reasons:
 *      - `content.near-duplicate` — the simhash banding join, quadratic within
 *        a band. Phase 3's gate doc measured it on a 5k corpus and explicitly
 *        mandated a re-measure here. This is that mandate.
 *      - `content.template-similarity` — a Phase 4 rule, so Phase 3 mandated
 *        nothing about it; its OWN header flags a cost linear in the number of
 *        page types, and that flag has never been measured at scale.
 *    And the render pass's own numbers are printed in full — selection stats,
 *    per-render mean, failures by class, and what the fixture server was asked
 *    for while the browser was running (the politeness residual, measured at the
 *    wire rather than argued from the renderer's own counters).
 *
 * `allowPrivate: true` is the same sanctioned use as Phase 1: the site under
 * test is a loopback fixture (test/gate/site-server.ts).
 */
import { readdirSync, readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { CRAWL_DEFAULTS, runCrawl } from "../src/crawl/loop.js";
import {
  RENDER_PASS_DEFAULTS,
  runRenderPass,
  type RenderPassSummary,
} from "../src/crawl/render/run-render.js";
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

/** The gate's three numbers. All are the build plan's, not this script's. */
const GATE_PAGES = 50_000;
const GATE_PEAK_RSS_BYTES = 512 * 1024 * 1024;
/**
 * The render budget, as a share of the crawled URLs — spec §5's "never more
 * than 5% of the site leaves through a browser". `RENDER_DEFAULTS.renderBudgetPct`
 * is the same number on the production side; it is restated here rather than
 * imported ON PURPOSE, so that a gate assertion cannot be satisfied by editing
 * the constant the code under test reads.
 */
const GATE_RENDER_PCT = 5;

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
  /** Peak summed RSS of this process's descendants. See `childRssBytes`. */
  childPeakBytes: number;
  /** How many descendants were alive at that peak. */
  childPeakCount: number;
}

/**
 * The RSS of every descendant of this process, summed, with a count.
 *
 * WHY THIS EXISTS AND WHAT IT IS WORTH. The 512MB contract is about the Node
 * process (build plan rule 6), and `process.memoryUsage.rss()` reports exactly
 * that — it cannot see Chromium, which Playwright runs as a child with its own
 * address space and its own renderer/GPU/zygote children under it. Reporting
 * only the gated number would let the phase-5 gate doc say "the render pass cost
 * 12MB" about a pass that ran half a gigabyte of browser next door. So the
 * browser tree is measured, and reported BESIDE the gated figure rather than
 * added to it.
 *
 * **It is an upper bound, not a total.** RSS counts every resident page a
 * process maps, and Chromium's processes share a great deal — the binary, the
 * zygote's heap, shared memory buffers — so summing their RSS counts those pages
 * once per process. The honest statement of the number is "no more than this",
 * and that is how the gate doc must quote it. A true figure would need PSS
 * (`/proc/<pid>/smaps_rollup`), which costs a kernel page walk per process per
 * sample; that is too expensive to run every 2s next to the thing being timed.
 *
 * `/proc` is a live directory: a process can exit between `readdir` and the read
 * of its `stat`. `ENOENT` and `ESRCH` — the two errnos the kernel reports for
 * exactly that — are the only thing skipped here, BY NAME, and every other errno
 * is rethrown. Skipping those two is not a fallback hiding a failure (hard rule
 * 7): a process that no longer exists has no RSS, and a sample that threw for it
 * would report the browser as costing nothing. Anything else — `EACCES` under a
 * `hidepid` mount, say — means this reader cannot see the machine it claims to
 * be measuring, and that must stop the gate rather than quietly shrink its
 * browser figure.
 */
function childRssBytes(rootPid: number): { bytes: number; count: number } {
  const pageSize = 4096;
  /** pid → ppid, for every process on the machine. */
  const parents = new Map<number, number>();
  /** pid → resident pages, for the same. */
  const resident = new Map<number, number>();

  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let stat: string;
    let statm: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      statm = readFileSync(`/proc/${pid}/statm`, "utf8");
    } catch (error) {
      // The process exited between the readdir and here — and ONLY that. See
      // the header: any other errno is this reader failing, not a pid vanishing.
      if (!isVanishedProcessError(error)) throw error;
      continue;
    }
    // `comm` is parenthesised and may itself contain spaces and parentheses, so
    // the fields after it are found from the LAST ')' rather than by splitting
    // the whole line — the classic /proc/stat parsing trap.
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    const after = stat.slice(close + 2).split(" ");
    // After `comm` the fields are: state, ppid, … — ppid is the second.
    const ppid = Number(after[1]);
    const pages = Number(statm.split(" ")[1]);
    if (!Number.isInteger(ppid) || !Number.isInteger(pages)) continue;
    parents.set(pid, ppid);
    resident.set(pid, pages);
  }

  let bytes = 0;
  let count = 0;
  for (const pid of parents.keys()) {
    if (pid === rootPid) continue;
    // Walk up to the root. The hop limit is not a guess about depth: /proc can
    // hand back a cycle if a pid was reused mid-scan, and an unbounded walk
    // would hang the sampler on it.
    let cursor = pid;
    for (let hop = 0; hop < 64; hop++) {
      const parent = parents.get(cursor);
      if (parent === undefined || parent <= 1) break;
      if (parent === rootPid) {
        bytes += (resident.get(pid) ?? 0) * pageSize;
        count += 1;
        break;
      }
      cursor = parent;
    }
  }
  return { bytes, count };
}

/**
 * Whether a `/proc` read failed because its process is gone.
 *
 * The two errnos the kernel uses for a pid that vanished between the `readdir`
 * and the read: `ENOENT` (the directory entry is already unlinked) and `ESRCH`
 * (the entry survives but the task behind it does not). Nothing else counts —
 * see `childRssBytes`'s header.
 */
function isVanishedProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
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
  /**
   * `children` turns on the /proc walk for this phase. Off by default: only the
   * render phase has children, and walking every process on the machine every
   * two seconds beside a crawl that is being timed is work the measurement does
   * not need.
   */
  startPhase: (opts?: { children?: boolean }) => void;
  endPhase: () => PhaseRss;
  stop: () => void;
} {
  const startedAt = Date.now();
  let peak = process.memoryUsage.rss();
  let peakAt = 0;
  let phasePeak = peak;
  let phaseStartedAt = startedAt;
  let phasePeakAt = 0;
  let watchChildren = false;
  let childPeak = 0;
  let childPeakCount = 0;

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
    if (watchChildren) {
      const children = childRssBytes(process.pid);
      if (children.bytes > childPeak) {
        childPeak = children.bytes;
        childPeakCount = children.count;
      }
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
    startPhase: (opts = {}) => {
      phaseStartedAt = Date.now();
      phasePeak = process.memoryUsage.rss();
      phasePeakAt = 0;
      watchChildren = opts.children === true;
      childPeak = 0;
      childPeakCount = 0;
      sample();
    },
    endPhase: () => {
      sample();
      const phase = {
        peakBytes: phasePeak,
        peakAtMs: phasePeakAt,
        childPeakBytes: childPeak,
        childPeakCount,
      };
      watchChildren = false;
      return phase;
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
        ? `PHASE 5 GATE — crawl + render + rules over ${GATE_PAGES.toLocaleString()} pages, ` +
            `peak RSS must stay under ${GATE_PEAK_RSS_BYTES / MB}MB and the render pass ` +
            `under ${GATE_RENDER_PCT}% of them`
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
  /**
   * What the render phase measured, or null on a rules-only run — where there
   * is no fixture to render and the numbers would be another run's.
   */
  let renderReport: { summary: RenderPassSummary; ms: number; rss: PhaseRss } | null = null;
  /** The crawl phase's own peak, kept for the three-phase summary at the end. */
  let crawlPeakBytes = 0;

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

      // ONE CONFIG OBJECT, TWO PASSES. `RenderPassConfig` is satisfied
      // structurally by a `CrawlConfig`, deliberately (run-render.ts's header):
      // the render pass inherits the crawl's user agent and its per-host
      // spacing, so a site cannot see two differently-behaved clients from one
      // audit (rule 9). Handing both passes the same object is that design
      // used rather than described.
      //
      // THE THREE RENDER KNOBS ARE DELIBERATELY ABSENT. `renderBudgetPct`,
      // `renderMaxPages` and `renderSamplePerType` are left unset, so the pass
      // resolves `RENDER_DEFAULTS` — and `crawls.config_jsonb` records a crawl
      // that named none of them. That is the shape a default-configured
      // production crawl has, and it is the shape `render.coverage` re-resolves
      // its numbers from; the gate runs it rather than a configuration nobody
      // ships. The drift that shape exposes is disclosed in docs/gates/phase-5.md.
      const config = {
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
      };

      sampler.startPhase();
      const crawlStartedAt = Date.now();
      const summary = await runCrawl(db, config);
      const crawlMs = Date.now() - crawlStartedAt;
      const crawlRss = sampler.endPhase();
      crawlPeakBytes = crawlRss.peakBytes;
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

      // ——— render phase ———
      //
      // The fixture is still up, and must be: this pass drives a real browser
      // at it. The crawl's own `status` is `finished` by now, which is what
      // `runRenderPass` requires before it will touch the frontier.
      console.log("");
      console.log("— render phase —");

      const servedBefore = site.served();
      sampler.startPhase({ children: true });
      const renderStartedAt = Date.now();
      // `onRequestBlocked` counts THIRD-PARTY aborts. On this fixture the
      // number is expected to be zero — every URL the pages reference is
      // same-origin — and zero is the point: it is the one number that can
      // distinguish "the third-party block worked" from "there was nothing to
      // block", once read beside the server's own request counters below.
      let thirdPartyBlocked = 0;
      const render = await runRenderPass(db, crawlId, config, {
        onRequestBlocked: () => {
          thirdPartyBlocked += 1;
        },
      });
      const renderMs = Date.now() - renderStartedAt;
      const renderRss = sampler.endPhase();
      const servedAfter = site.served();

      const attempted = render.rendered + render.failures;
      console.log(line("budget", `${render.selection.budget} of ${pages.toLocaleString()} URLs`));
      console.log(
        line(
          "candidates",
          `${render.selection.suspects} suspect + ${render.selection.sampled} sampled = ` +
            `${render.selection.suspects + render.selection.sampled}` +
            `${render.selection.truncated ? " (truncated to the budget)" : ""}`,
        ),
      );
      console.log(line("selected", render.selection.selected.length.toLocaleString()));
      console.log(line("rendered", render.rendered.toLocaleString()));
      console.log(line("failures", render.failures.toLocaleString()));
      console.log(line("unrendered", render.unrendered.toLocaleString()));
      console.log(line("elapsed", seconds(renderMs)));
      // Wall ÷ renders, which at `renderConcurrency` workers is a THROUGHPUT
      // figure and not one render's latency: four workers each spending ~3.4s
      // (a navigation plus the 3s settle) produce a mean near 0.85s. Labelled
      // with the concurrency so the two are never read as the same number.
      const concurrency = RENDER_PASS_DEFAULTS.renderConcurrency;
      console.log(
        line(
          "per render",
          attempted === 0
            ? "n/a (nothing rendered)"
            : `${(renderMs / attempted).toFixed(0)}ms wall/render at concurrency ${concurrency} ` +
              `(≈${((renderMs * concurrency) / attempted).toFixed(0)}ms per render latency)`,
        ),
      );
      console.log(
        line("peak RSS", `${megabytes(renderRss.peakBytes)} (at +${(renderRss.peakAtMs / 1000).toFixed(0)}s)`),
      );
      console.log(
        line(
          "browser RSS",
          `${megabytes(renderRss.childPeakBytes)} across ${renderRss.childPeakCount} child ` +
            `process(es) at its peak — NOT gated, and an upper bound (shared pages ` +
            `counted once per process)`,
        ),
      );
      console.log(
        line(
          "fixture served",
          `${(servedAfter.total - servedBefore.total).toLocaleString()} requests during this ` +
            `phase — ${servedAfter.html - servedBefore.html} html, ` +
            `${servedAfter.meta - servedBefore.meta} meta, ` +
            `${servedAfter.notFound - servedBefore.notFound} 404`,
        ),
      );
      console.log(line("third-party", `${thirdPartyBlocked} request(s) aborted`));

      // The pass's own invariant, checked rather than trusted: a URL is leased
      // once, rendered once and completed once, so nothing may be left over.
      if (attempted !== render.selection.selected.length || render.unrendered !== 0) {
        console.error(
          `FAIL: render pass attempted ${attempted} of ${render.selection.selected.length} ` +
            `selected URLs and left ${render.unrendered} in render_pending`,
        );
        return 1;
      }
      // THE BUDGET CONTRACT, asserted on the count the pass was ALLOWED to make
      // rather than the count it happened to make — a pass that selected 3,000
      // pages and crashed after 400 has still broken the contract.
      // `ceil`, because that is the arithmetic the selection itself does:
      // `min(ceil(pages × pct/100), renderMaxPages)` in select.ts. Comparing
      // against the un-rounded product fails a pass that obeyed its budget
      // exactly — a 30-page smoke run is allowed ceil(1.5) = 2 seats and would
      // be reported here as over a ceiling of 1.5. At 50,000 pages the two
      // agree, so this is a hole in the small sizes, not in the gate run.
      const renderCeiling = Math.ceil((summary.pagesCrawled * GATE_RENDER_PCT) / 100);
      if (render.selection.selected.length > renderCeiling) {
        console.error(
          `FAIL: render pass selected ${render.selection.selected.length} URLs, over the ` +
            `${GATE_RENDER_PCT}% ceiling of ${renderCeiling} for a ${summary.pagesCrawled}-page crawl`,
        );
        return 1;
      }
      renderReport = { summary: render, ms: renderMs, rss: renderRss };

      // NOW the fixture closes — after the pass that is supposed to fetch and
      // before the pass that is not. Nothing in the rule pass may fetch (hard
      // rule 2), and a site still listening would leave that claim untested. If
      // a rule reaches for the network below, it gets a connection refused
      // rather than a page.
      await site.close();
      siteOpen = false;
      console.log("");
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

    // ——— the four render checks, answered from the rows this run wrote ———
    //
    // The point of printing them is that a ZERO here is a real answer and has
    // to be readable as one. Three of the four rules speak only about pages
    // that were rendered, so "no findings" means either "this site's HTML holds
    // everything" or "nothing was rendered" — and `render.coverage`, printed
    // beside them, is the row that tells the two apart (its own header says so).
    // The gate doc quotes both together for exactly that reason.
    console.log("");
    console.log("— the render checks on this crawl —");
    const renderIssues = await db.execute<{ rule_id: string; n: number }>(sql`
      select rule_id, count(*)::int as n from issues
      where crawl_id = ${crawlId}
        and rule_id in ('content.csr-dependent', 'nav.js-only', 'filters.js-only', 'redirect.js')
      group by rule_id order by rule_id`);
    const byRule = new Map(renderIssues.rows.map((row) => [row.rule_id, row.n]));
    for (const [id, check] of [
      ["content.csr-dependent", "CHECK-01"],
      ["filters.js-only", "CHECK-02"],
      ["nav.js-only", "CHECK-34"],
      ["redirect.js", "CHECK-10"],
    ] as const) {
      console.log(line(String(byRule.get(id) ?? 0), `${id} (${check}) findings`));
    }
    const coverage = await db.execute<{ value_jsonb: unknown }>(sql`
      select value_jsonb from metrics
      where crawl_id = ${crawlId} and metric_id = 'render.coverage' and scope = 'site'`);
    const coverageRow = coverage.rows[0];
    if (coverageRow === undefined) {
      // A gate that printed nothing here would be a gate whose render evidence
      // has no denominator, and every zero above would be unreadable.
      console.error("FAIL: render.coverage wrote no site row for this crawl");
      return 1;
    }
    console.log(line("render.coverage", JSON.stringify(coverageRow.value_jsonb)));

    const peak = sampler.peakBytes();
    console.log("");
    if (renderReport !== null) {
      console.log(
        line(
          "phase peaks",
          `crawl ${megabytes(crawlPeakBytes)}, render ${megabytes(renderReport.rss.peakBytes)} ` +
            `(+ browser ${megabytes(renderReport.rss.childPeakBytes)}, not gated), ` +
            `rules ${megabytes(rulesRss.peakBytes)}`,
        ),
      );
    }
    console.log(
      line(
        "PEAK RSS",
        `${megabytes(peak)} across every phase (at +${(sampler.peakAtMs() / 1000).toFixed(0)}s), ` +
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
    // The happy path closed the fixture after the render pass — the last phase
    // that is allowed to fetch — and before the rule pass, which is not. This is
    // the error path, where the crawl, the render pass or the rule pass threw
    // before that close was reached. Guarded by a flag rather than by swallowing
    // the second close's error, which would be a fallback hiding a real one
    // (hard rule 7).
    if (site !== null && siteOpen) await site.close();
  }
}

process.exitCode = await main();

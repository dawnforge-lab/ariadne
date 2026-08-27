/**
 * The crawl loop: the one place where discovery, the frontier, politeness,
 * fetching, parsing and persistence meet.
 *
 * The shape is deliberately boring — lease a batch, fetch it, write it, enqueue
 * what it found, repeat — because every interesting decision has already been
 * made by a module that can be tested on its own. What this file owns is the
 * wiring, and the wiring has four properties worth stating up front:
 *
 *  - **Nothing accumulates per URL.** The frontier is a table, results go
 *    straight through `PageWriter`, and the only per-crawl numbers held in
 *    memory are counters. RAM is O(concurrency), never O(URLs) (rule 6). The
 *    one deliberate exception is discovery's sitemap entry list, which is
 *    capped by `discover` itself and written out before the loop starts.
 *
 *  - **Every URL about to be fetched has passed `isUrlAllowed` *and* robots.**
 *    Not at fetch time — at *enqueue* time, for the seed, for sitemap entries,
 *    for links, and for redirect targets alike (rule 5; `fetchPage` re-checks
 *    the policy anyway, which is belt and braces, not a substitute).
 *
 *  - **Every leased URL ends as a row.** A 404, a redirect, a block and a
 *    timeout that exhausted its retries are all `pages` rows carrying their
 *    fetch class. A URL never disappears from the record (rule 7). The single
 *    exception is a URL that will be retried: it is written when its attempt is
 *    final, so a retry that succeeds is not silently dropped by the
 *    `(crawl_id, url)` conflict behind a timeout row that was written first.
 *
 *  - **Our bugs are loud.** `fetchPage` throws for a malformed user agent;
 *    `PageWriter.flush` throws an `AggregateError` when a table's insert fails.
 *    Neither is caught here. A crawl that cannot write its results must not
 *    report a clean finish.
 *
 * Resume seam (Task 12's gate script, and any operator restart): a crawl is
 * identified by its `crawls` row and its frontier, so `resumeCrawl(db,
 * crawlId, …)` picks up exactly where a killed process left off — pending rows
 * are still pending, `done` rows are never re-fetched (enqueue conflicts do
 * nothing), and rows the dead worker had leased become leasable again the
 * moment their lease deadline passes. A resume that will not wait out that
 * deadline passes `reclaimLeases: true`, which is safe only when no other
 * worker is live on the crawl.
 *
 * That resume is only as honest as the `done` marks it trusts, so this file no
 * longer writes them: a URL is completed by `PageWriter.flushPages`, inside the
 * transaction that commits its page row. A process killed between the fetch and
 * that commit costs one re-fetch. Before, it cost the page — the frontier said
 * done and the row was still in a buffer (build plan §7).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { crawls, sitemapUrls } from "../db/schema.js";
// Ruleset provenance for the `crawls` row: the registry owns the number, the
// loop only stamps it.
import { RULESET_VERSION } from "../rules/registry/registry.js";
import { discover, type DiscoveryResult, type DiscoveryTruncation, type RobotsInfo } from "./discovery.js";
import { fetchPage, type FetchClass, type FetchResult } from "./fetch-page.js";
import { probeHostVariants } from "./host-probe.js";
import {
  crawledRows,
  enqueueUrls,
  failUrl,
  frontierCounts,
  leaseBatch,
  releaseLeases,
  type EnqueueItem,
  type FrontierCounts,
  type LeasedUrl,
} from "./frontier.js";
import {
  RENDER_DEFAULTS,
  resolveRenderConfig,
  type RenderSelectionConfig,
} from "./render/select.js";
import { analyzePage } from "./parse/page-analyzer.js";
import { hostProbeStarts, isSameOrigin, normalizeUrl } from "./parse/url-utils.js";
import { PageWriter, type PageWriterStats } from "./persist.js";
import { CrawlWindow, HostGate, type BatchOutcome } from "./politeness.js";
import { isUrlAllowed } from "./url-policy.js";

/**
 * `RenderSelectionConfig` is extended rather than restated: the render pass's
 * three knobs (`renderBudgetPct`, `renderMaxPages`, `renderSamplePerType`) are
 * part of a crawl's configuration — they are stored on the `crawls` row with
 * everything else and read back by a resume — but the module that ACTS on them
 * owns their meaning, their defaults (`RENDER_DEFAULTS`) and their validation.
 */
export interface CrawlConfig extends RenderSelectionConfig {
  siteUrl: string;
  maxPages: number;
  maxDepth: number;
  userAgent: string;
  perHostDelayMs: number;
  maxConcurrency: number;
  /**
   * TEST ONLY. Threaded through to url-policy, fetch-page and discovery so the
   * suite can crawl a 127.0.0.1 fixture server. Never wire this to an API
   * field, a CLI flag or an env var.
   *
   * It is also the one field that is NOT persisted on the `crawls` row: a
   * resume must re-assert it in `ResumeOpts.config` rather than inherit it.
   * See storableConfig.
   */
  allowPrivate?: boolean;
  /**
   * Walk the host's other spellings before crawling (see host-probe). Defaults
   * to on: it costs four chains paced by `perHostDelayMs`, and it is the only
   * evidence the host rules (CHECK-13/14/15) have. Set false to skip it — the
   * rules then report the check as skipped rather than passing it.
   */
  probeHosts?: boolean;
  /**
   * Domains the site used to live on, probed alongside its own spellings. A
   * bare host or a full http(s) URL; anything else throws rather than being
   * quietly dropped (see hostProbeStarts).
   */
  legacyHosts?: string[];
}

/**
 * `crawls.discovery_jsonb`: what the crawl learned before it fetched a page.
 *
 * `robots.raw` is the robots.txt text as served (discovery caps the read at
 * 500KB), stored verbatim so the rules can re-parse it against the URLs the
 * crawl found instead of re-fetching it — hard rule 3, in a column.
 * `sitemapSources` is the sitemap documents the walk was *pointed at*, so
 * "no sitemap is declared" and "the declared sitemap could not be read" stay
 * different facts: the second one shows up in `truncation.failures` with a
 * non-empty `sitemapSources`.
 */
export interface DiscoveryEvidence {
  robots: {
    outcome: RobotsInfo["outcome"];
    crawlDelaySec: number | null;
    note: string | null;
    raw: string | null;
    /**
     * `raw` is a 500KB prefix, not the whole file. It travels with the text
     * because a rule that re-parses a truncated robots.txt would find no
     * `Disallow` for every rule past the cap and conclude the URL is allowed —
     * the same silent "not disallowed" an unreachable robots.txt is refused
     * for (RFC 9309 §2.3.1.4). A rule reading `raw` must check this and refuse
     * to conclude, not conclude quietly.
     */
    truncated: boolean;
  };
  sitemapSources: string[];
  truncation: DiscoveryTruncation;
  /** Sitemap documents attempted. Lifted out of `truncation` for the rules. */
  docsFetched: number;
}

/** `crawls.notfound_probe_jsonb` when the probe ran: the site's 404 template. */
export interface NotFoundProbeSample {
  probeUrl: string;
  statusCode: number | null;
  fetchClass: FetchClass;
  /** The template's length, when it answered 200 with HTML. Else null. */
  wordCount: number | null;
  /**
   * The template's simhash as `String(BigInt.asIntN(64, …))` — the same signed
   * spelling `pages.simhash` is stored in, so the soft-404 rule can compare
   * the two in SQL without converting either. Null unless the probe got 200
   * HTML back.
   */
  simhash: string | null;
}

/**
 * `crawls.notfound_probe_jsonb` when the probe did not run. A null column
 * would be indistinguishable from a crawl that predates the probe; this says
 * which decision was taken and why (hard rule 7).
 */
export interface SkippedProbe {
  skipped: string;
}

export type NotFoundProbeEvidence = NotFoundProbeSample | SkippedProbe;

/**
 * The values a caller that does not care gets. Not applied inside `runCrawl` —
 * `CrawlConfig` is fully specified on purpose, so a field nobody set cannot
 * quietly become a politeness decision — but exported so the API and CLI
 * layers have one place to read them from rather than three.
 */
export const CRAWL_DEFAULTS = {
  maxDepth: 10,
  userAgent: "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)",
  perHostDelayMs: 1000,
  maxConcurrency: 16,
  // The render pass's three, from the module that spends them. Spread rather
  // than copied so there is one place a budget can be changed.
  ...RENDER_DEFAULTS,
} as const;

export interface CrawlSummary {
  crawlId: string;
  /**
   * How the run ended, mirroring `crawls.status`:
   *  - `finished`  — the frontier drained, or `maxPages` was reached.
   *  - `cancelled` — the abort signal fired; the frontier still has work.
   *  - `failed`    — the crawl could not legitimately proceed. Today that is
   *    an unreachable robots.txt (complete disallow, RFC 9309 §2.3.1.4). A
   *    caller must branch on this: 0 pages with `failed` is not an empty site.
   */
  status: "finished" | "cancelled" | "failed";
  /** Pages persisted across the crawl's whole life, resumes included. */
  pagesCrawled: number;
  frontier: FrontierCounts;
  /** What the write path actually wrote, including what it could not. */
  writer: PageWriterStats;
  robots: { outcome: RobotsInfo["outcome"]; note: string | null };
  discovery: { sitemapEntries: number; truncation: DiscoveryTruncation };
  /** Why the crawl ended, when that needs saying. Null on a clean finish. */
  note: string | null;
}

/**
 * The deadline this loop gives `fetchPage`. Stated here rather than left to
 * fetch-page's own default because the lease duration is computed from it —
 * two places that must agree, so there is one number.
 */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Floor on a lease, and the slack added on top of the worst-case wait. A lease
 * must outlive everything one attempt can spend — the queue behind `HostGate`,
 * the fetch itself, then parse and insert — because a lease that expires while
 * the work is still running invites a second worker to fetch the same URL,
 * which is a politeness violation (rule 9), not merely wasted effort.
 */
const LEASE_FLOOR_SECONDS = 180;
const LEASE_SLACK_MS = 30_000;

/**
 * How long a batch of `batchSize` URLs may be leased for, given the per-host
 * spacing actually in force.
 *
 * The bad case is a batch that is entirely one host — which is the *normal*
 * case for a single-site crawl. `HostGate` hands out one slot per
 * `delayMs`, so the last member of a batch of 16 under `Crawl-delay: 30` does
 * not start its fetch for ~8 minutes; a flat 180s lease would have expired on
 * it long before, and a second worker could legitimately re-lease and re-fetch
 * a URL that is still in flight. `batchSize + 1` rather than `batchSize`
 * because the gate may already owe an earlier batch one delay's wait.
 *
 * The cost is the other direction: a crashed worker's URLs sit idle for this
 * long before anyone else may take them. That is the honest price of not
 * double-fetching, and a resume that knows the worker is dead skips the wait
 * entirely with `reclaimLeases`.
 */
function leaseSecondsFor(delayMs: number, batchSize: number): number {
  const worstCaseMs = delayMs * (batchSize + 1) + FETCH_TIMEOUT_MS + LEASE_SLACK_MS;
  return Math.max(LEASE_FLOOR_SECONDS, Math.ceil(worstCaseMs / 1000));
}

/** Attempts a transient failure gets before the URL is marked failed. */
const MAX_ATTEMPTS = 3;

/**
 * Fetch classes worth trying again: the site did not answer, so we learned
 * nothing about the URL. Everything else *is* an answer — a 404, a block, a
 * redirect, a PDF — and asking twice would only be rude.
 *
 * `unsupported_encoding` is deliberately NOT here, and it is the member most
 * likely to be added by mistake because it reads like a failure. It is an
 * answer: the server replied, in a coding we cannot read, and it will reply
 * the same way every time (some CDNs return `br` whatever `accept-encoding`
 * says). Retrying a deterministic non-answer is three times the load for the
 * same result — the exact rudeness this set's own rule forbids.
 */
const TRANSIENT: ReadonlySet<FetchClass> = new Set<FetchClass>([
  "timeout",
  "network_error",
]);

/**
 * Bytes reserved in the window's in-flight budget for one fetch. A body's real
 * size is unknown until it has been read, so the reservation is fetch-page's
 * own hard cap — the worst case, which is the only number that can bound peak
 * RSS before the fact. Real sizes are reported to the window afterwards, in
 * `BatchOutcome.htmlBytes`.
 */
const RESERVED_BYTES_PER_FETCH = 1024 * 1024;

/** How long to wait before re-polling the byte budget. See admit(). */
const ADMIT_POLL_MS = 25;

/** Wait before re-leasing when the frontier is empty but another worker is busy. */
const IDLE_POLL_MS = 500;

/** Rows per `sitemap_urls` insert. */
const SITEMAP_BATCH = 500;

/**
 * Mirrors CrawlWindow's own initial-concurrency default. Passed explicitly so
 * a `maxConcurrency` below it is a smaller window rather than a RangeError.
 */
const WINDOW_INITIAL = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResumeOpts {
  /**
   * Overrides the config stored on the `crawls` row. Use it to change pacing
   * or raise `maxPages` for the continuation; omit it to resume exactly as the
   * crawl was configured.
   *
   * It is also the ONLY way to resume with `allowPrivate` on: the flag is
   * never persisted, so a resume that needs it (fixture-server tests and gate
   * scripts) must re-state it here. See storableConfig.
   */
  config?: CrawlConfig;
  signal?: AbortSignal;
  /**
   * Return *every* live lease in the crawl to pending before starting, instead
   * of waiting for the dead worker's leases to expire (see leaseSecondsFor).
   * Correct
   * for a resume after a crash — which is the case the gate script exercises —
   * and wrong while another worker is still running: it would hand that
   * worker's URLs to this one.
   */
  reclaimLeases?: boolean;
}

/**
 * Start a new crawl of `config.siteUrl`.
 *
 * Creates the `crawls` row, reads robots.txt and the sitemap tree, seeds the
 * frontier, and runs the loop until the frontier drains, `maxPages` is reached
 * or `signal` aborts.
 */
export async function runCrawl(
  db: Db,
  config: CrawlConfig,
  signal?: AbortSignal,
): Promise<CrawlSummary> {
  validateConfig(config);

  const crawlId = `crawl_${randomUUID()}`;
  await db.insert(crawls).values({
    id: crawlId,
    siteUrl: config.siteUrl,
    config: storableConfig(config),
    rulesetVersion: RULESET_VERSION,
    status: "running",
  });

  return execute(db, crawlId, config, signal);
}

/**
 * Continue an existing crawl — after a crash, an abort, or a `maxPages` stop
 * that the operator wants to extend.
 *
 * The frontier *is* the resume state: pending rows are still pending and done
 * rows are never re-fetched, so this re-seeds and re-walks the sitemap without
 * re-crawling anything. Discovery does run again, because robots rules and the
 * crawl-delay are needed to gate and pace whatever the continuation discovers,
 * and a crawl resumed hours later must honour the rules as they are now.
 *
 * The host probe runs again too, and its result OVERWRITES `host_probe_jsonb`:
 * like discovery it is a reading of the site as it is now, and half of one
 * crawl's variants beside half of another's would be evidence of no particular
 * moment. Same for the known-404 probe on the way out. The cost is up to four
 * more origin-root chains per resume, paced by the same gate as ever (rule 9) —
 * a caller resuming often enough for that to matter passes `probeHosts: false`
 * in `opts.config`, and the row then keeps whatever walk the earlier run
 * stored, untouched.
 */
export async function resumeCrawl(
  db: Db,
  crawlId: string,
  opts: ResumeOpts = {},
): Promise<CrawlSummary> {
  const rows = await db.select().from(crawls).where(eq(crawls.id, crawlId));
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`resumeCrawl: no crawl ${crawlId}`);
  }

  const config = opts.config ?? parseStoredConfig(row.config, crawlId);
  validateConfig(config);

  if (opts.reclaimLeases === true) {
    await releaseLeases(db, crawlId, null);
  }

  await db
    .update(crawls)
    .set({ status: "running", finishedAt: null })
    .where(eq(crawls.id, crawlId));

  return execute(db, crawlId, config, opts.signal);
}

/**
 * The config as `crawls.config_jsonb` should hold it: everything except
 * `allowPrivate` (build-plan §7, "before the first real-site crawl").
 *
 * `allowPrivate` is a test-only escape hatch that admits loopback and RFC1918
 * targets. Persisting it would make it *durable* — every resume of that crawl
 * would silently re-enable it, months later, in a process nobody was thinking
 * about, from a row nobody reads. That is exactly the silent fallback this
 * project forbids (hard rule 7): the dangerous setting would carry itself
 * forward without anyone re-stating the intent.
 *
 * So the row does not carry it, and `parseStoredConfig` does not restore it. A
 * resume that genuinely needs it — the fixture-server gate scripts, and only
 * those — re-asserts it in `ResumeOpts.config`, at the call site, in the open.
 *
 * The running crawl is unaffected: `execute` gets the caller's config object,
 * not this copy. Only what outlives the process is trimmed.
 */
function storableConfig(config: CrawlConfig): Omit<CrawlConfig, "allowPrivate"> {
  const { allowPrivate: _allowPrivate, ...rest } = config;
  return rest;
}

/**
 * A stored config is data we wrote, but it has been through a jsonb column and
 * possibly a schema change, so it is validated rather than trusted. A resume
 * on a config we cannot read must stop, not guess: guessing here would silently
 * re-crawl a site at the wrong pace.
 *
 * `allowPrivate` is deliberately not among the fields read back. `runCrawl`
 * strips it on the way in (see storableConfig), and a row that has one anyway —
 * written before this rule, or edited by hand — must not be the thing that
 * turns it on. Off is the value the escape hatch has unless a caller says
 * otherwise in this call, which is the whole point of the strip; leaving it
 * off is the documented behaviour, not a guess covering a failure.
 */
function parseStoredConfig(value: unknown, crawlId: string): CrawlConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(`resumeCrawl: crawl ${crawlId} has no readable config`);
  }
  const raw = value as Record<string, unknown>;
  const config = {
    siteUrl: raw["siteUrl"],
    maxPages: raw["maxPages"],
    maxDepth: raw["maxDepth"],
    userAgent: raw["userAgent"],
    perHostDelayMs: raw["perHostDelayMs"],
    maxConcurrency: raw["maxConcurrency"],
    probeHosts: raw["probeHosts"],
    legacyHosts: raw["legacyHosts"],
    renderBudgetPct: raw["renderBudgetPct"],
    renderMaxPages: raw["renderMaxPages"],
    renderSamplePerType: raw["renderSamplePerType"],
  };
  for (const [field, expected] of [
    ["siteUrl", "string"],
    ["maxPages", "number"],
    ["maxDepth", "number"],
    ["userAgent", "string"],
    ["perHostDelayMs", "number"],
    ["maxConcurrency", "number"],
  ] as const) {
    if (typeof config[field] !== expected) {
      throw new Error(
        `resumeCrawl: crawl ${crawlId} config.${field} is ${typeof config[field]}, expected ${expected}`,
      );
    }
  }
  // The optional fields: absent is fine, present-and-wrong is not. A stored
  // `probeHosts: "false"` must not resume as "probe on" (it is truthy) or as
  // "probe off" (a guess) — it must stop.
  for (const field of ["probeHosts"] as const) {
    if (config[field] !== undefined && typeof config[field] !== "boolean") {
      throw new Error(`resumeCrawl: crawl ${crawlId} config.${field} is not a boolean`);
    }
  }
  // Same ruling for the render budget: a stored `renderMaxPages: "500"` must
  // not resume as a NaN budget that renders nothing and says nothing.
  // `validateConfig` then range-checks whatever is genuinely a number.
  for (const field of [
    "renderBudgetPct",
    "renderMaxPages",
    "renderSamplePerType",
  ] as const) {
    if (config[field] !== undefined && typeof config[field] !== "number") {
      throw new Error(`resumeCrawl: crawl ${crawlId} config.${field} is not a number`);
    }
  }
  if (
    config.legacyHosts !== undefined &&
    (!Array.isArray(config.legacyHosts) ||
      !config.legacyHosts.every((host) => typeof host === "string"))
  ) {
    throw new Error(
      `resumeCrawl: crawl ${crawlId} config.legacyHosts is not an array of strings`,
    );
  }
  return config as CrawlConfig;
}

function validateConfig(config: CrawlConfig): void {
  const positiveInts = [
    ["maxPages", config.maxPages],
    ["maxDepth", config.maxDepth],
    ["maxConcurrency", config.maxConcurrency],
  ] as const;
  for (const [field, value] of positiveInts) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`CrawlConfig.${field} must be an integer ≥ 1, got ${value}`);
    }
  }
  if (!Number.isFinite(config.perHostDelayMs) || config.perHostDelayMs < 0) {
    throw new RangeError(
      `CrawlConfig.perHostDelayMs must be ≥ 0, got ${config.perHostDelayMs}`,
    );
  }
  if (config.userAgent.trim() === "") {
    throw new Error("CrawlConfig.userAgent must not be empty (rule 9: branded UA)");
  }
  if (normalizeUrl(config.siteUrl) === null) {
    throw new Error(`CrawlConfig.siteUrl is not an http(s) URL: ${config.siteUrl}`);
  }
  if (config.probeHosts !== false) {
    // Throws on a legacyHosts entry that names no host — here, before the
    // crawls row exists, rather than four fetches into the run.
    hostProbeStarts(config.siteUrl, config.legacyHosts ?? []);
  }
  // The render budget, checked by the module that will spend it. A nonsense
  // budget stops the crawl at line one rather than after the last page, where
  // the render pass would have been the one to find out.
  resolveRenderConfig(config);
}

/**
 * Discovery, seeding and the loop — the part `runCrawl` and `resumeCrawl`
 * share — plus the one guarantee that has to wrap all of it: an error on the
 * way out closes the `crawls` row as `failed` before it propagates. A row left
 * `running` forever is a lie about a process that is gone, and the next reader
 * cannot tell it from a live crawl.
 *
 * The error itself is never swallowed; if recording the failure *also* fails,
 * both surface together.
 */
async function execute(
  db: Db,
  crawlId: string,
  config: CrawlConfig,
  signal: AbortSignal | undefined,
): Promise<CrawlSummary> {
  try {
    return await runToCompletion(db, crawlId, config, signal);
  } catch (error) {
    try {
      // The frontier's own crawled count, not a counter held in this process:
      // it is the honest number, and it survives whatever went wrong.
      await closeCrawl(db, crawlId, "failed", crawledRows(await frontierCounts(db, crawlId)));
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `crawl ${crawlId} failed, and marking the crawls row failed too`,
      );
    }
    throw error;
  }
}

async function runToCompletion(
  db: Db,
  crawlId: string,
  config: CrawlConfig,
  signal: AbortSignal | undefined,
): Promise<CrawlSummary> {
  const allowPrivate = config.allowPrivate === true;

  // INSERTION 1 — the host probe, before discovery. It asks what the site's
  // *other names* do, which is a question the crawl proper can never answer:
  // everything after this line happens under the one spelling the crawl was
  // seeded with, robots.txt included. Four chains, up to five hops each, one
  // at a time and paced by `perHostDelayMs` — robots.txt is not readable yet,
  // so the config delay is the spacing it can honour; see host-probe.
  if (config.probeHosts !== false) {
    const hostProbe = await probeHostVariants(config.siteUrl, {
      userAgent: config.userAgent,
      allowPrivate,
      legacyHosts: config.legacyHosts,
      perHostDelayMs: config.perHostDelayMs,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    await db.update(crawls).set({ hostProbe }).where(eq(crawls.id, crawlId));
  }

  const discovery = await discover(config.siteUrl, {
    userAgent: config.userAgent,
    allowPrivate,
  });

  // INSERTION 2 — discovery's own findings, written before anything branches on
  // them. A crawl that refuses to run because robots.txt is unreachable is
  // exactly the crawl whose discovery evidence a reader most needs.
  await db
    .update(crawls)
    .set({ discovery: discoveryEvidence(discovery) })
    .where(eq(crawls.id, crawlId));

  // Complete disallow: robots.txt could not be read, which is not permission
  // (RFC 9309 §2.3.1.4). The crawl fails loudly rather than reporting a clean
  // zero-page finish that reads like an empty site.
  if (discovery.robots.outcome === "unreachable") {
    const note =
      discovery.robots.note ?? "robots.txt unreachable: complete disallow in force";
    // Whatever an earlier run of this crawl already did stands — a resume that
    // finds robots.txt down must not rewrite the row's page count to zero.
    const crawled = crawledRows(await frontierCounts(db, crawlId));
    await writeNotFoundProbe(db, crawlId, {
      skipped: `not probed: ${note}`,
    });
    await closeCrawl(db, crawlId, "failed", crawled);
    return summarise(db, crawlId, "failed", crawled, emptyWriterStats(), discovery, note);
  }

  const writer = new PageWriter(db, crawlId);
  const window = new CrawlWindow({
    max: config.maxConcurrency,
    initial: Math.min(WINDOW_INITIAL, config.maxConcurrency),
  });
  const gate = new HostGate({
    perHostDelayMs: config.perHostDelayMs,
    robotsCrawlDelaySec: discovery.robots.crawlDelaySec,
  });

  // The frontier is the crawl's memory: on a resume these numbers come back
  // non-zero and the run continues against the same budget rather than
  // starting a second crawl inside the first one's row.
  //
  // `crawledRows` rather than `done` alone, and both numbers below count
  // `render_pending`: a render selection MOVES rows out of `done`, and a resume
  // that read those as uncrawled would re-fetch every rendered page and would
  // let the frontier grow past `maxPages` by however many rows the selection
  // took (hard rule 7 — the miscount would be silent).
  const startCounts = await frontierCounts(db, crawlId);
  let pagesCrawled = crawledRows(startCounts);
  let frontierRows =
    startCounts.pending +
    startCounts.leased +
    startCounts.failed +
    crawledRows(startCounts);

  /**
   * Enqueue candidates that pass every gate, never letting the frontier grow
   * past `maxPages` rows. The cap is on rows *ever inserted*, so a hub page
   * with 5000 links cannot turn a 100-page crawl into a 5000-row table.
   *
   * `frontierRows` is *reserved* as each candidate is accepted, not compared
   * once at the top: up to `maxConcurrency` calls of this function are in
   * flight at any moment, and a check-then-insert separated by an `await`
   * would let every one of them spend the same remaining room. The check and
   * the increment sit in one synchronous step — no `await` between them — so
   * the reservation is exact even with sixteen handlers interleaving. The
   * count is corrected downwards afterwards by however many rows the
   * `(crawl_id, url)` conflict dropped, so URLs already in the frontier do not
   * permanently consume budget.
   */
  const enqueue = async (
    urls: readonly string[],
    depth: number,
    discoveredVia: string,
  ): Promise<void> => {
    if (frontierRows >= config.maxPages) return;

    const items: EnqueueItem[] = [];
    for (const raw of urls) {
      // normalizeUrl is the single frontier-key authority (url-utils). Links
      // arrive already normalised from the analyzer; the seed and sitemap
      // entries do not, and running it twice is idempotent.
      const url = normalizeUrl(raw);
      if (url === null) continue;
      if (!isSameOrigin(url, config.siteUrl)) continue; // external: linked, never fetched
      const verdict = await isUrlAllowed(url, { allowPrivate });
      if (!verdict.allowed) continue;
      // isSameOrigin admits www<->apex and http->https spellings, and the
      // robots wrapper judges those by the same rules (RobotsInfo.isAllowed):
      // a variant spelling is never a way around Disallow.
      if (!discovery.robots.isAllowed(url)) continue;

      // Reserve. Atomic with respect to the event loop, which is what makes
      // the cap hold across concurrent handlers.
      if (frontierRows >= config.maxPages) break;
      frontierRows += 1;
      items.push({ url, depth, discoveredVia });
    }
    if (items.length === 0) return;

    // A throw here leaves the reservation standing, which is the safe
    // direction: the crawl is on its way out, and over-counting the frontier
    // can only stop work early, never run past maxPages.
    const inserted = await enqueueUrls(db, crawlId, items);
    frontierRows -= items.length - inserted;
  };

  /**
   * Reserve the per-fetch byte budget, waiting for room rather than spinning.
   * `admitBytes` is a poll — there is no completion to await — so this sleeps
   * between attempts and gives up only when the crawl is aborting.
   */
  const admit = async (): Promise<boolean> => {
    while (!window.admitBytes(RESERVED_BYTES_PER_FETCH)) {
      if (signal?.aborted === true) return false;
      await sleep(ADMIT_POLL_MS);
    }
    return true;
  };

  /** Fetch, parse, persist and enqueue one leased URL. */
  const handleOne = async (
    item: LeasedUrl,
  ): Promise<{ outcome: BatchOutcome | null; persisted: boolean }> => {
    if (!(await admit())) return { outcome: null, persisted: false };
    try {
      // Claimed immediately before a fetch we are certainly going to issue —
      // acquiring earlier would burn the host's slot on work we then skip.
      await gate.acquire(new URL(item.url).host);

      const result = await fetchPage(item.url, {
        userAgent: config.userAgent,
        allowPrivate,
        timeoutMs: FETCH_TIMEOUT_MS,
      });

      // A transient failure with attempts left is not written yet: the row for
      // this URL records its *final* outcome, and writing a timeout now would
      // win the (crawl_id, url) conflict against the retry that succeeds.
      if (TRANSIENT.has(result.fetchClass) && item.attempts < MAX_ATTEMPTS) {
        await failUrl(db, crawlId, item.url, { requeue: true, maxAttempts: MAX_ATTEMPTS });
        return { outcome: toOutcome(result), persisted: false };
      }

      const analysis =
        result.fetchClass === "ok" && result.body !== null
          ? analyzePage(result.body, item.url)
          : null;

      // The frontier row is settled by the writer, in the transaction that
      // commits this page row — never here, where the row is only buffered.
      // A page whose retries are spent is the loop's to settle instead: it
      // becomes `failed` below, and a completion would overwrite that.
      await writer.addPage(item, result, analysis, {
        complete: !TRANSIENT.has(result.fetchClass),
      });

      if (analysis !== null && item.depth < config.maxDepth) {
        await enqueue(
          analysis.links.map((link) => link.href),
          item.depth + 1,
          "link",
        );
      }
      // Same depth: a redirect is one URL wearing two names, not a step further
      // into the site. `redirectUrl` is null when the target was policy-refused
      // (fetch-page drops it and says why in `disallowedReason`).
      if (result.fetchClass === "redirect" && result.redirectUrl !== null) {
        await enqueue([result.redirectUrl], item.depth, "redirect");
      }

      if (TRANSIENT.has(result.fetchClass)) {
        // Retries spent. The row is written, and the frontier says so.
        await failUrl(db, crawlId, item.url, { requeue: false, maxAttempts: MAX_ATTEMPTS });
      }
      return { outcome: toOutcome(result), persisted: true };
    } finally {
      // Exactly paired with admit(): under-releasing wedges the budget for the
      // rest of the crawl, and nothing would say why.
      window.releaseBytes(RESERVED_BYTES_PER_FETCH);
    }
  };

  const workerId = `worker_${randomUUID()}`;
  let aborted = false;
  let seedNote: string | null = null;
  /**
   * Errors on the way out, in the order they happened: the loop's own, then
   * the shutdown's. A `finally` would have let the flush's error *replace* the
   * loop's, which is the failure this collection exists to prevent — losing
   * the error that explains the crawl in order to report the one it caused
   * (rule 7). Every one of them surfaces, together.
   */
  const failures: unknown[] = [];

  try {
    await enqueue([config.siteUrl], 0, "seed");
    await enqueue(
      discovery.sitemapEntries.map((entry) => entry.url),
      0,
      "sitemap",
    );
    await persistSitemap(db, crawlId, discovery);

    if (frontierRows === 0) {
      // A crawl with nothing in its frontier is about to report zero pages.
      // Say why, so "the site is empty" and "robots or the URL policy
      // refused the only URLs we had" do not look identical (rule 7).
      seedNote =
        "nothing to crawl: the seed URL and every sitemap entry were refused " +
        "by robots.txt, the URL policy, or the same-origin boundary";
    }

    while (pagesCrawled < config.maxPages) {
      if (signal?.aborted === true) {
        aborted = true;
        break;
      }

      const room = config.maxPages - pagesCrawled;
      const size = Math.min(window.size(), room);
      const batch = await leaseBatch(
        db,
        crawlId,
        workerId,
        size,
        leaseSecondsFor(gate.effectiveDelayMs(), size),
      );

      if (batch.length === 0) {
        // Nothing to lease. If nothing is leased anywhere either, the frontier
        // is drained and the crawl is done; otherwise another worker holds the
        // remaining URLs and may yet return them.
        if ((await frontierCounts(db, crawlId)).leased === 0) break;
        await sleep(IDLE_POLL_MS);
        continue;
      }

      // allSettled, not all: a handler that throws (our bug — a malformed
      // user agent, a page row that will not normalise) must still take the
      // crawl down, but only once its siblings have finished. `Promise.all`
      // would return while they were mid-`addPage`, and the shutdown below
      // would flush the writer's buffers underneath them.
      const settled = await Promise.allSettled(batch.map((item) => handleOne(item)));
      const outcomes: BatchOutcome[] = [];
      const errors: unknown[] = [];
      for (const result of settled) {
        if (result.status === "rejected") {
          errors.push(result.reason);
          continue;
        }
        if (result.value.persisted) pagesCrawled += 1;
        if (result.value.outcome !== null) outcomes.push(result.value.outcome);
      }
      window.onBatchSettled(outcomes);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `crawl loop: ${errors.length} URLs threw`);
      }

      // The batch ends where its lease does. Completion now lives in the
      // writer's flush, so leaving rows buffered would leave their frontier
      // rows `leased` — and two things go wrong if that outlives the lease
      // this batch was sized for (leaseSecondsFor): another worker re-leases
      // and re-fetches URLs we have already crawled (rule 9), and the
      // drain check above never fires, because a frontier whose last URLs are
      // sitting in this buffer never reports `leased === 0`. Flushing here
      // costs a smaller insert and buys back both. The batch's errors are
      // raised first: those rows go out in the shutdown flush below, and a
      // flush that threw here would replace the error that explains the crawl.
      await writer.flush();
    }
    if (signal?.aborted === true) aborted = true;
  } catch (error) {
    failures.push(error);
  }

  // Shutdown runs whatever happened above, and each step runs even if the
  // previous one failed: buffered rows must be written, and this worker's
  // leases must not stay held for a lease's worth of minutes on the way out.
  try {
    await writer.flush();
  } catch (error) {
    failures.push(error);
  }
  try {
    await releaseLeases(db, crawlId, workerId);
  } catch (error) {
    failures.push(error);
  }

  raiseFailures(crawlId, failures, "while running and shutting down");

  // INSERTION 3 — one last fetch, of a URL that cannot exist, so the rules can
  // tell a real 404 from a site that answers 200 for everything. It runs after
  // the loop's errors have been dealt with (a crawl that is failing does not
  // get to make another request) and before the row is closed.
  //
  // Contained, unlike everything above it: by this point every page has been
  // fetched, written and committed, and the probe is an epilogue. A throw from
  // it — the analyzer on a hostile template, a lost connection on its own
  // update — must not turn a crawl that did all of its work into a `failed`
  // row, which is what letting it propagate to `execute` would do. It is
  // written down instead, in the shape the probe's other decisions take
  // (`{ skipped }`, hard rule 7): a reader sees a probe that ran and failed,
  // never a null column or a half-written sample.
  //
  // The one thing not on offer is log-and-continue. If the skip cannot be
  // recorded either, the crawl has lost its ability to say what it knows, and
  // both errors go into the same aggregation the loop and the shutdown use.
  const status = aborted ? "cancelled" : "finished";
  try {
    await probeKnownMissing(db, crawlId, config, discovery, gate, {
      allowPrivate,
      pagesCrawled,
      aborted,
    });
  } catch (error) {
    try {
      await writeNotFoundProbe(db, crawlId, {
        skipped: `probe failed: ${messageOf(error)}`,
      });
    } catch (writeError) {
      failures.push(error, writeError);
    }
  }
  raiseFailures(crawlId, failures, "while probing for a known-404");
  await closeCrawl(db, crawlId, status, pagesCrawled);
  return summarise(
    db,
    crawlId,
    status,
    pagesCrawled,
    writer.stats(),
    discovery,
    aborted
      ? "aborted by the caller; the frontier still holds pending URLs"
      : seedNote,
  );
}

/**
 * Throw what went wrong: the single error as itself, several together, nothing
 * when nothing did. One shape for every collection point in the loop, so an
 * error is never lost to the one it caused (rule 7).
 */
function raiseFailures(crawlId: string, failures: unknown[], when: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `crawl ${crawlId}: ${failures.length} errors ${when}`);
  }
}

/** A thrown value's message, for a column that has to hold a reason. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `crawls.discovery_jsonb` row for one discovery result. */
function discoveryEvidence(discovery: DiscoveryResult): DiscoveryEvidence {
  return {
    robots: {
      outcome: discovery.robots.outcome,
      crawlDelaySec: discovery.robots.crawlDelaySec,
      note: discovery.robots.note,
      raw: discovery.robots.raw,
      truncated: discovery.robots.truncated,
    },
    // The documents the walk was pointed at. Today that is exactly what
    // robots.txt declared, because `discover` is called without
    // `extraSitemaps`; a caller that starts passing them must add them here,
    // or "the site declares no sitemap" becomes a lie.
    sitemapSources: [...discovery.robots.sitemapUrls],
    truncation: discovery.truncation,
    docsFetched: discovery.truncation.docsFetched,
  };
}

async function writeNotFoundProbe(
  db: Db,
  crawlId: string,
  probe: NotFoundProbeEvidence,
): Promise<void> {
  await db.update(crawls).set({ notfoundProbe: probe }).where(eq(crawls.id, crawlId));
}

/**
 * Fetch one URL that cannot exist and record what came back.
 *
 * This is the site's own answer to "what do you do with a URL you do not
 * have", and there is no other way to get it: a soft-404 site returns 200 for
 * every wrong URL, so a crawl of real URLs can never see the template. When
 * the answer *is* 200 HTML, the template's simhash and word count go into the
 * row and become the fingerprint the soft-404 rule (CHECK-16) compares crawled
 * pages against — `String(BigInt.asIntN(64, …))`, the same signed spelling
 * `pages.simhash` uses, so the comparison is one SQL expression.
 *
 * It is one fetch, through the same politeness gate as any other (hard rule 9)
 * and the same URL policy (hard rule 5, inside `fetchPage`), and it produces no
 * `pages` row and no frontier entry: it is not a page of the site.
 *
 * Every reason not to probe is written down instead of leaving the column null
 * (hard rule 7): a null means "this crawl predates the probe", and a reader
 * cannot be left guessing which of the two it is looking at.
 */
async function probeKnownMissing(
  db: Db,
  crawlId: string,
  config: CrawlConfig,
  discovery: DiscoveryResult,
  gate: HostGate,
  opts: { allowPrivate: boolean; pagesCrawled: number; aborted: boolean },
): Promise<void> {
  if (opts.aborted) {
    // The caller asked us to stop. Issuing another request would be the one
    // thing an abort is meant to prevent; a resume will take the sample.
    await writeNotFoundProbe(db, crawlId, {
      skipped: "crawl cancelled before the known-404 probe",
    });
    return;
  }
  if (opts.pagesCrawled === 0) {
    await writeNotFoundProbe(db, crawlId, {
      skipped: "no pages crawled: nothing to compare a 404 template against",
    });
    return;
  }

  const probeUrl = `${new URL(config.siteUrl).origin}/__ariadne-404-probe-${randomUUID()}`;
  if (!discovery.robots.isAllowed(probeUrl)) {
    await writeNotFoundProbe(db, crawlId, {
      skipped: `robots.txt disallows the probe path (${probeUrl})`,
    });
    return;
  }

  await gate.acquire(new URL(probeUrl).host);
  const result = await fetchPage(probeUrl, {
    userAgent: config.userAgent,
    allowPrivate: opts.allowPrivate,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  // Only a 200 with HTML carries a template. Everything else — the 404 we
  // hoped for, a redirect, a block — is recorded as the class it was.
  const analysis =
    result.fetchClass === "ok" && result.body !== null
      ? analyzePage(result.body, probeUrl)
      : null;

  await writeNotFoundProbe(db, crawlId, {
    probeUrl,
    statusCode: result.statusCode,
    fetchClass: result.fetchClass,
    wordCount: analysis?.wordCount ?? null,
    simhash: analysis === null ? null : String(BigInt.asIntN(64, analysis.simhash)),
  });
}

function toOutcome(result: FetchResult): BatchOutcome {
  return {
    fetchClass: result.fetchClass,
    responseTimeMs: result.responseTimeMs,
    htmlBytes: result.htmlBytes,
  };
}

function emptyWriterStats(): PageWriterStats {
  return { pages: 0, links: 0, hreflang: 0, structuredData: 0, hreflangUnresolved: 0 };
}

/**
 * Write the sitemap as it was declared — every entry, not only the ones the
 * frontier had room for. "The site says these URLs exist" and "we crawled
 * them" are different facts, and the coverage rules need both.
 *
 * Each row carries the entry twice: `url` is the `<loc>` as the site published
 * it, which is what the report quotes, and `url_normalised` is that same entry
 * through `normalizeUrl` — the spelling `pages.url` is keyed by, and the only
 * one a join to `pages` can use. A `<loc>` carrying a fragment or unsorted
 * query params names the very page the crawl fetched from it, and without the
 * second column the sitemap rules would report it as uncrawled and its page as
 * unlisted (see the sitemap rules' module header).
 *
 * `discover()` policy-checks every entry before it gets here, so a `<loc>` that
 * will not normalise is this engine's defect and not a site's — it throws
 * rather than writing a row that could never join (hard rule 7).
 */
async function persistSitemap(
  db: Db,
  crawlId: string,
  discovery: DiscoveryResult,
): Promise<void> {
  const entries = discovery.sitemapEntries;
  for (let i = 0; i < entries.length; i += SITEMAP_BATCH) {
    const batch = entries.slice(i, i + SITEMAP_BATCH).map((entry) => {
      const normalised = normalizeUrl(entry.url);
      if (normalised === null) {
        throw new Error(`persistSitemap: cannot normalise sitemap entry ${entry.url}`);
      }
      return {
        crawlId,
        url: entry.url,
        urlNormalised: normalised,
        sitemapSource: entry.source,
        lastmod: entry.lastmod,
      };
    });
    // discover() dedupes by URL, so a conflict here means a resume re-reading
    // the same sitemap. The first read's row stands.
    await db.insert(sitemapUrls).values(batch).onConflictDoNothing();
  }
}

async function closeCrawl(
  db: Db,
  crawlId: string,
  status: CrawlSummary["status"],
  pagesCrawled: number,
): Promise<void> {
  await db
    .update(crawls)
    .set({ status, finishedAt: new Date(), pagesCrawled })
    .where(eq(crawls.id, crawlId));
}

async function summarise(
  db: Db,
  crawlId: string,
  status: CrawlSummary["status"],
  pagesCrawled: number,
  writerStats: PageWriterStats,
  discovery: DiscoveryResult,
  note: string | null,
): Promise<CrawlSummary> {
  return {
    crawlId,
    status,
    pagesCrawled,
    frontier: await frontierCounts(db, crawlId),
    writer: writerStats,
    robots: { outcome: discovery.robots.outcome, note: discovery.robots.note },
    discovery: {
      sitemapEntries: discovery.sitemapEntries.length,
      truncation: discovery.truncation,
    },
    note,
  };
}

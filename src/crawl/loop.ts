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
  type DiscoveredVia,
  type EnqueueItem,
  type FrontierCounts,
  type LeasedUrl,
} from "./frontier.js";
import {
  RENDER_DEFAULTS,
  resolveRenderConfig,
  type RenderSelectionConfig,
} from "./render/select.js";
import { inferPageTemplates, type PageTemplateInference } from "./page-type.js";
import { analyzePage } from "./parse/page-analyzer.js";
import { hostProbeStarts, isSameOrigin, normalizeUrl } from "./parse/url-utils.js";
import { PageWriter, type PageWriterStats } from "./persist.js";
import { CrawlWindow, HostGate, type BatchOutcome } from "./politeness.js";
import {
  fetchCrawlResources,
  type ResourcePassSummary,
} from "./resources/fetch-resources.js";
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
  /**
   * Sitemap documents the client handed the crawl, walked alongside the ones
   * robots.txt declares (discovery's `extraSitemaps`).
   *
   * IT IS NOT A WAY AROUND THE NO-SPECULATIVE-PROBE RULE, it is the other half
   * of it: the engine never guesses at `/sitemap.xml`, so a site that publishes
   * a sitemap without declaring it in robots.txt has exactly one way to get it
   * crawled — somebody who knows where it is says so. `sitemap.missing`
   * (CHECK-06) still reports the undeclared sitemap, because that is still true
   * of the site and still worth fixing.
   *
   * Full http(s) URLs, absolute; anything else throws in `validateCrawlConfig`
   * rather than being dropped mid-walk. The API applies the URL policy and the
   * allowlist to each one before the crawl row exists (`checkSitemapUrls`,
   * src/api/service.ts) — this field is trusted by the time it reaches here in
   * exactly the way `legacyHosts` is.
   */
  sitemapUrls?: string[];
  /**
   * How many findings each listing rule may report when this crawl is judged.
   * A positive integer, or `null` for UNCAPPED — every orphan, every duplicate
   * group, every blocked sitemap entry. Absent is the engine's defaults (200 URL
   * findings, 500 near-duplicate pairs), which is what every crawl before P8-T4
   * got.
   *
   * An uncapped listing normally carries no truncation note, and the direction
   * that matters is the other one: a note means the list is incomplete, and its
   * absence means it is complete. `null` does not promise "no note anywhere" —
   * `content.near-duplicate`'s scan ceiling is not the operator's to lift (hard
   * rule 6, `NEAR_DUPLICATE_PAIR_CEILING`), and a run that reaches it says so in
   * the usual honest way.
   *
   * IT IS NOT A CRAWL SETTING AND THE CRAWL LOOP NEVER READS IT. It rides on
   * the crawl config because that is the only durable place a crawl-start
   * decision can live: the rules run is a separate call (`crawl_rules`, `POST
   * /crawls/:id/rules`) with no argument of its own, so a billed audit that
   * asked for the whole picture would silently be re-judged at 200 the moment
   * anyone re-ran the rules. `runRules` reads this key off the row
   * (`storedFindingCap`, src/rules/query/crawl-evidence.ts).
   */
  findingCap?: number | null;
  /**
   * The resource fetch pass's two budgets: distinct files this crawl may ask
   * about, and distinct hosts it may ask. Absent is
   * `RESOURCE_DEFAULTS` (10_000 and 20) — the module that spends them owns the
   * numbers and the reasoning behind them, exactly as the render pass owns its
   * three.
   *
   * They are CRAWL config rather than arguments to the pass because the pass is
   * part of a crawl and a resume must run it the way the first attempt was told
   * to. A cap is never silent: rows beyond it keep their null `fetch_class` and
   * carry `fetch_reason: 'resource-cap'` (hard rule 7).
   */
  maxResources?: number;
  maxResourceHosts?: number;
}

/**
 * `crawls.discovery_jsonb`: what the crawl learned before it fetched a page.
 *
 * `robots.raw` is the robots.txt text as served (discovery caps the read at
 * 500KB), stored verbatim so the rules can re-parse it against the URLs the
 * crawl found instead of re-fetching it — hard rule 3, in a column.
 * `sitemapSources` is the sitemap documents ROBOTS.TXT DECLARED, so "no sitemap
 * is declared" and "the declared sitemap could not be read" stay different
 * facts: the second one shows up in `truncation.failures` with a non-empty
 * `sitemapSources`.
 *
 * `suppliedSitemaps` is the documents the CLIENT named at crawl start
 * (`CrawlConfig.sitemapUrls`). It is a second list rather than more entries in
 * the first one, and that is the whole of the provenance record: a document in
 * `sitemapSources` was declared, a document in `suppliedSitemaps` was supplied,
 * and a document in both was both — which is the honest answer for a client who
 * re-states a sitemap the site already declares. Folding the two together would
 * make `sitemap.missing` (CHECK-06) go quiet the moment a client supplied a
 * URL, reporting "robots.txt declares a sitemap" about a robots.txt that
 * declares nothing.
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
  /**
   * The sitemap documents the crawl was handed at start. Empty when nobody
   * supplied one — including on every crawl written before the field existed,
   * where nobody could (readers treat an absent value as empty and a value of
   * the wrong shape as a refusal; see `parseDiscovery`).
   */
  suppliedSitemaps: string[];
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
  /**
   * What the crawl-end template inference did (`inferPageTemplates`), or null
   * when it did not run — which today means a crawl that failed before it could
   * see its own population. Null is not "nothing to collapse": that is
   * `pagesRetyped: 0`, and the two must not be read as the same thing.
   */
  pageTemplates: PageTemplateInference | null;
  /**
   * What the resource fetch pass did, or null when it did not run — a crawl
   * that failed before it had pages, or one that was cancelled (an abort means
   * stop asking servers for things, and the pass is all asking). Null is not
   * "no resources": that is a summary whose `seen` is 0, and the two must not
   * be read as the same thing.
   */
  resources: ResourcePassSummary | null;
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

/** Attempts a retryable failure gets before the URL is marked failed. */
const MAX_ATTEMPTS = 3;

/**
 * Fetch classes worth trying again. Two different reasons sit in this set, and
 * both have to hold for a member to belong here.
 *
 * `timeout` and `network_error` are the original pair: the site did not answer,
 * so we learned nothing about the URL. Most classes *are* an answer — a 404, a
 * redirect, a PDF — and asking twice would only be rude.
 *
 * `blocked` is the member added in Task 6b, and it is here for the *other*
 * reason: it is an answer about the CRAWLER, not about the URL. A 429 from a
 * token bucket says "not at this rate", and the page behind it is usually
 * served the moment the rate drops — which is exactly what the retry now lands
 * in, because `HostGate.report` has doubled that host's spacing before the
 * requeued URL is leased again. Retrying a block at the SAME pace would be the
 * rudeness this set's rule forbids; retrying it slower is the polite reading of
 * what the server asked for (rule 9). A deterministic 403 settles in three
 * paced attempts and one classified row.
 *
 * `unsupported_encoding` is deliberately NOT here, and it is the member most
 * likely to be added by mistake because it reads like a failure. It is an
 * answer: the server replied, in a coding we cannot read, and it will reply
 * the same way every time (some CDNs return `br` whatever `accept-encoding`
 * says). Retrying a deterministic non-answer is three times the load for the
 * same result, and no amount of backing off changes it.
 */
const RETRYABLE: ReadonlySet<FetchClass> = new Set<FetchClass>([
  "timeout",
  "network_error",
  "blocked",
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
  validateCrawlConfig(config);

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
  validateCrawlConfig(config);

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
 *
 * Exported because `runCrawl` is no longer the only writer of a `crawls` row:
 * the API's queue creates the row when a crawl is ACCEPTED and runs it later
 * (src/api/service.ts), and it must strip the flag by the same authority rather
 * than by a second copy of the rule that could drift from this one.
 *
 * Migration 0012 gave the render pass's requested URL list its own column
 * (`crawls.render_urls_jsonb`) and backfilled the key out, so this function is
 * once again the ONLY writer of config_jsonb and the row holds exactly what it
 * returns. The second-writer amendment this docblock carried through Phase 8 —
 * and the "patch keys individually" rule it imposed — is retired; the history
 * is in docs/gates/phase-8.md §12 and §15.
 */
export function storableConfig(config: CrawlConfig): Omit<CrawlConfig, "allowPrivate"> {
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
 *
 * Exported for the second reader of that column: the API's render endpoint
 * builds its `RenderPassConfig` from the crawl's own stored config, so the
 * render pass cannot end up with a different user agent or a different per-host
 * delay than the crawl it belongs to (rule 9). Its messages name the crawl
 * rather than a function, because two callers now raise them.
 *
 * The closed field set below is load-bearing beyond validation. It carried the
 * render pass's `renderUrls` record through Phase 8; migration 0012 moved that
 * record to `crawls.render_urls_jsonb` (history in docs/gates/phase-8.md §12
 * and §15), and what the closed set now guarantees is that a row still holding
 * the legacy key — written before 0012 by a process that has since been
 * replaced, or edited by hand — cannot leak it into a later pass's
 * `CrawlConfig`.
 */
export function parseStoredConfig(value: unknown, crawlId: string): CrawlConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(`crawl ${crawlId}: stored config is not readable`);
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
    sitemapUrls: raw["sitemapUrls"],
    renderBudgetPct: raw["renderBudgetPct"],
    renderMaxPages: raw["renderMaxPages"],
    renderSamplePerType: raw["renderSamplePerType"],
    findingCap: raw["findingCap"],
    maxResources: raw["maxResources"],
    maxResourceHosts: raw["maxResourceHosts"],
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
        `crawl ${crawlId}: stored config.${field} is ${typeof config[field]}, expected ${expected}`,
      );
    }
  }
  // The optional fields: absent is fine, present-and-wrong is not. A stored
  // `probeHosts: "false"` must not resume as "probe on" (it is truthy) or as
  // "probe off" (a guess) — it must stop.
  for (const field of ["probeHosts"] as const) {
    if (config[field] !== undefined && typeof config[field] !== "boolean") {
      throw new Error(`crawl ${crawlId}: stored config.${field} is not a boolean`);
    }
  }
  // Same ruling for the render budget: a stored `renderMaxPages: "500"` must
  // not resume as a NaN budget that renders nothing and says nothing.
  // `validateConfig` then range-checks whatever is genuinely a number.
  for (const field of [
    "renderBudgetPct",
    "renderMaxPages",
    "renderSamplePerType",
    // The resource budgets, on the same terms: a stored `maxResources: "500"`
    // must not resume as a NaN cap that stops the pass at the first row and
    // reports it as a cap the operator asked for.
    "maxResources",
    "maxResourceHosts",
  ] as const) {
    if (config[field] !== undefined && typeof config[field] !== "number") {
      throw new Error(`crawl ${crawlId}: stored config.${field} is not a number`);
    }
  }
  // `findingCap` is the one field where NULL IS A VALUE rather than an absence,
  // so it cannot join the loop above: null means "uncapped, list everything",
  // absent means "the engine's defaults", and collapsing the two would turn a
  // billed audit's explicit choice into the default the moment it was read back.
  // Anything else — a string, a zero, a fraction — is a config we cannot read
  // the operator's intent out of, and it stops here (the same ruling
  // `storedFindingCap` makes for the rules-run path, which reads the raw jsonb
  // rather than this).
  if (
    config.findingCap !== undefined &&
    config.findingCap !== null &&
    (!Number.isInteger(config.findingCap) || (config.findingCap as number) < 1)
  ) {
    throw new Error(
      `crawl ${crawlId}: stored config.findingCap is neither a positive integer nor null`,
    );
  }
  // The two string lists, on the same terms: a stored value of the wrong shape
  // is a config we cannot read, not a list to quietly treat as empty. A resume
  // that dropped `sitemapUrls` would walk fewer documents than the first run
  // and report the difference as the site's.
  for (const field of ["legacyHosts", "sitemapUrls"] as const) {
    const value = config[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
    ) {
      throw new Error(
        `crawl ${crawlId}: stored config.${field} is not an array of strings`,
      );
    }
  }
  return config as CrawlConfig;
}

/**
 * Range-check a crawl configuration, throwing on anything a crawl must not be
 * started with.
 *
 * Exported because the API validates a request body BEFORE the crawl row
 * exists: a `maxPages: 0` supplied over the wire is a 400 with this function's
 * own message, not a crawl row that is created, queued, and only then found to
 * be unrunnable.
 */
export function validateCrawlConfig(config: CrawlConfig): void {
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
  // A supplied sitemap must be an absolute http(s) URL: the sitemaps protocol
  // has no relative documents, and `discover` resolves nothing — a bare
  // `/sitemap.xml` would reach the walk as a URL nothing can fetch and be
  // recorded as a failure the operator would read as the site's. Named here,
  // before the row exists, for the same reason legacyHosts is.
  for (const url of config.sitemapUrls ?? []) {
    if (normalizeUrl(url) === null) {
      throw new Error(
        `CrawlConfig.sitemapUrls entry is not an absolute http(s) URL: ${url}`,
      );
    }
  }
  // The finding cap, checked here even though the crawl loop never reads it:
  // it is stored on the row at crawl start and spent hours later by a rules run,
  // and `findingCap: 0` — a listing rule that may report nothing, which is the
  // always-passes rule hard rule 1 forbids — must be refused by the request that
  // set it rather than by a judgement nobody is watching. `null` is uncapped and
  // is a legitimate value; absent is the engine's defaults.
  if (
    config.findingCap !== undefined &&
    config.findingCap !== null &&
    (!Number.isInteger(config.findingCap) || config.findingCap < 1)
  ) {
    throw new RangeError(
      `CrawlConfig.findingCap must be an integer ≥ 1, or null for uncapped, got ` +
        `${String(config.findingCap)}`,
    );
  }
  // The resource budgets, checked here for the render budget's reason below: a
  // `maxResources: 0` is a pass that asks about nothing and marks every row
  // `resource-cap`, which reads like a decision somebody took. If that is the
  // intent it has to be said in a way nobody can mistake for a typo, and this
  // is not it.
  for (const [field, value] of [
    ["maxResources", config.maxResources],
    ["maxResourceHosts", config.maxResourceHosts],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new RangeError(
        `CrawlConfig.${field} must be an integer ≥ 1, got ${String(value)}`,
      );
    }
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
    // The documents the client named, walked beside the declared ones. The
    // engine still probes nothing on its own (see discover's header).
    extraSitemaps: config.sitemapUrls,
  });

  // INSERTION 2 — discovery's own findings, written before anything branches on
  // them. A crawl that refuses to run because robots.txt is unreachable is
  // exactly the crawl whose discovery evidence a reader most needs.
  await db
    .update(crawls)
    .set({ discovery: discoveryEvidence(discovery, config) })
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
    return summarise(
      db,
      crawlId,
      "failed",
      crawled,
      emptyWriterStats(),
      discovery,
      null,
      // The resource pass never ran: this crawl was refused before it had a
      // page, let alone a page's references.
      null,
      note,
    );
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

  /**
   * The spacing, on the crawl row, for whoever is polling.
   *
   * The gate lives in this process and the poller reads the database, so a
   * number nobody wrote down is a number the operator cannot act on — and
   * acting on it is the whole point: a crawl that has quietly escalated to 8s
   * per page looks identical, from `crawl_status`, to one that is merely large.
   * Written once up front (so the column means "the base, so far" rather than
   * "unknown" from the first poll) and then only when it MOVES, which is at
   * most a handful of times per host per crawl.
   *
   * At the batch boundary rather than inside `handleOne`: concurrent handlers
   * would race to write the same value, and one write per batch is enough for a
   * caller polling every 15-30 seconds.
   */
  let reportedSpacingMs = gate.maxSpacingMs();
  const recordSpacing = async (): Promise<void> => {
    await db.update(crawls).set({ hostSpacingMs: reportedSpacingMs }).where(eq(crawls.id, crawlId));
  };
  await recordSpacing();

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
    // The frontier's closed vocabulary rather than a string: the agent surface
    // filters `pages` by this value against `DISCOVERED_VIA`, so a fifth kind
    // of discovery has to be declared there before it can be enqueued here.
    discoveredVia: DiscoveredVia,
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
    const host = new URL(item.url).host;
    try {
      // Claimed immediately before a fetch we are certainly going to issue —
      // acquiring earlier would burn the host's slot on work we then skip.
      await gate.acquire(host);

      const result = await fetchPage(item.url, {
        userAgent: config.userAgent,
        allowPrivate,
        timeoutMs: FETCH_TIMEOUT_MS,
      });

      // The gate hears about it FIRST, and per fetch rather than per batch, so
      // the escalation is in force for the next ACQUISITION rather than only
      // for the next batch. Not "the next request", which is what this used to
      // say and is stronger than the gate can deliver: `acquire` claims a host's
      // slot and returns, so a sibling handler that already got through it has
      // its start time fixed, and `pushSlot` only ever moves the slot AFTER it
      // forward. What the immediacy buys is that no further slot is claimed at
      // the old spacing. This is the spacing half of the back-pressure; the
      // window's concurrency half is applied to the batch below (see
      // politeness).
      gate.report(host, {
        fetchClass: result.fetchClass,
        statusCode: result.statusCode,
        retryAfterMs: result.retryAfterMs,
        url: item.url,
      });

      // A retryable failure with attempts left is not written yet: the row for
      // this URL records its *final* outcome, and writing a timeout — or a
      // block — now would win the (crawl_id, url) conflict against the retry
      // that succeeds.
      if (RETRYABLE.has(result.fetchClass) && item.attempts < MAX_ATTEMPTS) {
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
      await writer.addPage(item, settledResult(result, item, gate.spacingMs(host)), analysis, {
        complete: !RETRYABLE.has(result.fetchClass),
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

      if (RETRYABLE.has(result.fetchClass)) {
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
        // The WIDEST spacing in force, not the configured one: once a host has
        // been escalated the batch behind it takes proportionally longer, and
        // a lease sized on the base delay would expire mid-batch and invite a
        // second worker onto URLs still in flight (see leaseSecondsFor).
        leaseSecondsFor(gate.maxSpacingMs(), size),
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
      if (gate.maxSpacingMs() !== reportedSpacingMs) {
        reportedSpacingMs = gate.maxSpacingMs();
        await recordSpacing();
      }
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

  // INSERTION 3b — the crawl asks about the files its pages point at.
  //
  // Numbered 3b rather than 5 because the markers are positional and INSERTION
  // 4 is cited by name elsewhere (docs/superpowers/plans/2026-08-29-phase-9-
  // schema-truth.md): this pass sits between the 404 probe and the template
  // inference, so it takes a name that says so instead of renaming theirs.
  //
  // WHY HERE, between the probe and the template inference, and not at either
  // of the two obvious alternatives:
  //
  //  - AFTER THE PAGE CRAWL, because the reference set is only complete once
  //    the last page has been parsed and written. A pass that ran alongside the
  //    loop would ask about a moving target: it would either re-query the work
  //    list forever or miss the files the last pages introduced, and both are
  //    silent incompleteness. Running it here also means every resource request
  //    is issued when no page fetch is competing for the same host's queue,
  //    which is what keeps the arithmetic in that module's header honest.
  //  - BEFORE `inferPageTemplates` and before `closeCrawl`, because a crawl's
  //    wall time is what an operator budgets and what `crawl_status` reports.
  //    A pass that ran after the row was closed would be work happening on
  //    somebody's server while the record said the crawl had finished, and a
  //    reader who saw `finished` would be seeing a crawl whose resource rows
  //    were still filling in. It sits after the 404 probe for the same reason
  //    the probe sits after the loop: the probe is one more request to the
  //    ORIGIN, and it belongs with the page phase it reasons about.
  //
  // Skipped on an abort, exactly as the probe is: the caller asked us to stop,
  // and every row this pass would write is a request to somebody's server. The
  // nulls it leaves are the resume's work list, unchanged.
  //
  // AN ABORT THAT ARRIVES *DURING* THE PASS is the other half of that, and it
  // is why `status` is computed below this line rather than above the probe: the
  // pass stops asking within one row and returns `aborted: true`, and a crawl
  // that closed `finished` on the strength of a flag computed before the pass
  // ran would be reporting a complete resource census it does not have (hard
  // rule 7). The rows it left are null with no reason, which is exactly what a
  // resume picks up.
  //
  // NOT CONTAINED the way the probe is, and for the inference's reason: this
  // pass classifies every site-side failure into a row (a 404 image, a dead CDN,
  // a robots.txt that refuses us), so anything it throws is OUR defect or a
  // failed write — and there is no column in which to write "the resource rows
  // are missing because the writer broke". It propagates, `execute` closes the
  // row `failed`, and the operator finds out (hard rule 7).
  const resourcePass = aborted
    ? null
    : await fetchCrawlResources(db, crawlId, {
        siteUrl: config.siteUrl,
        userAgent: config.userAgent,
        // THE SAME GATE the pages were fetched through — not a new one. A host
        // that earned 8s of spacing by refusing the page crawl is still at 8s
        // when we ask it about its images (hard rule 9).
        gate,
        // Already read by `discover`; the pass re-reads nobody's robots.txt but
        // a third-party asset host's.
        originRobots: discovery.robots,
        // THE SETTLED WINDOW, not the configured ceiling. The gate carries its
        // own state because the pass is handed the gate itself; the window
        // cannot, because the pass runs its own worker pool — so the number it
        // adapted to is threaded here by hand. A site that answered 503s until
        // the window collapsed 4 -> 1 gets one resource worker, not four. Per-host
        // spacing alone would not have delivered that (it serialises ONE host,
        // and resources routinely span several), and "the origin just told us to
        // slow down" is not a statement about one host's queue (rule 9).
        maxConcurrency: Math.min(window.size(), config.maxConcurrency),
        maxResources: config.maxResources,
        maxResourceHosts: config.maxResourceHosts,
        timeoutMs: FETCH_TIMEOUT_MS,
        allowPrivate,
        signal,
      });

  // The pass stops asking the moment the signal fires, so a crawl that was
  // cancelled inside it must say `cancelled` — with the note, and with the
  // frontier's own account of what is left.
  if (resourcePass?.aborted === true || signal?.aborted === true) aborted = true;
  const status = aborted ? "cancelled" : "finished";

  // INSERTION 4 — the crawl types its own population, now that it has one.
  //
  // WHY HERE AND NOWHERE ELSE. `page_type` is written per URL as each page is
  // persisted, and a single URL cannot say whether `/collections/all-white` is
  // a template or a page — only the other 550 URLs can. This is the one moment
  // when the population is complete and no reader has acted on it yet, and the
  // readers who come next all want the collapsed answer:
  //
  //  - the auditing agent, which reads the crawl's page types to name the key
  //    templates it wants rendered (`crawl_render` with `urls`) BEFORE the
  //    rules ever run — the flow P8-T2 built, and the one this collapse exists
  //    to serve;
  //  - the automatic render selection, whose per-type sample means "one page
  //    per template" only if a type is a template;
  //  - `pages_query`/`issues_list`'s `pageType` filter, which must give the
  //    same answer before and after a rules run — a crawl's evidence changing
  //    under a reader who did nothing is not evidence;
  //  - the metric cohorts, last rather than first.
  //
  // The alternative considered and rejected was a derivation in the rules run
  // (`deriveClickDepth`'s slot). It is a smaller change and it leaves this file
  // untouched, but it collapses the types AFTER the two readers above have
  // already used them — the agent would still be naming templates out of 196
  // singletons, which is the defect. It also re-runs on every `crawl_rules`
  // call, while the population it reasons about only ever changes when the
  // crawl does.
  //
  // Not contained the way the 404 probe is: this issues no request and touches
  // no site, so a failure here is our bug over rows we already hold, and there
  // is no column in which to write "the types are the parse-time ones". It
  // propagates, `execute` closes the row `failed`, and the operator finds out
  // (hard rule 7) rather than reading singleton cohorts that look deliberate.
  //
  // Since migration 0012 the pass also stamps `template_inference_jsonb` with
  // what it did, in the same transaction as the retype it describes — so the
  // 196 -> 13 fact is a column on this row rather than a log line this process
  // prints and forgets. The write is `inferPageTemplates`' because the
  // transaction is (see `recordInference`), and it lands BEFORE `closeCrawl`:
  // a reader who sees `finished` sees the marker too.
  const pageTemplates = await inferPageTemplates(db, crawlId);

  await closeCrawl(db, crawlId, status, pagesCrawled);
  return summarise(
    db,
    crawlId,
    status,
    pagesCrawled,
    writer.stats(),
    discovery,
    pageTemplates,
    resourcePass,
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

/**
 * The `crawls.discovery_jsonb` row for one discovery result.
 *
 * The config is the second argument because the PROVENANCE of the sitemap
 * documents is not something the walk can report: `discover` is handed two
 * lists and merges them, so which document came from where is known here and
 * only here. Both lists are written, unfolded — see `DiscoveryEvidence`.
 */
function discoveryEvidence(
  discovery: DiscoveryResult,
  config: CrawlConfig,
): DiscoveryEvidence {
  return {
    robots: {
      outcome: discovery.robots.outcome,
      crawlDelaySec: discovery.robots.crawlDelaySec,
      note: discovery.robots.note,
      raw: discovery.robots.raw,
      truncated: discovery.robots.truncated,
    },
    // The `Sitemap:` lines robots.txt carried, and nothing else. A supplied
    // document belongs in the list below it: putting it here would turn "the
    // site declares no sitemap" into a lie about the site.
    sitemapSources: [...discovery.robots.sitemapUrls],
    suppliedSitemaps: [...(config.sitemapUrls ?? [])],
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

/**
 * The result as it should be RECORDED, which is not always the result as it was
 * fetched.
 *
 * One case today: a block whose retries are spent. `fetch_class: 'blocked'`
 * says a WAF answered; it does not say whether we tried once or three times, or
 * how far the engine had already backed off when it gave up. Both belong in the
 * row, because the operator's next decision turns on them — a block at 8s of
 * spacing after three attempts is a site saying no, not a crawl that went in
 * too fast, and the answer to it is a conversation with the site's owner rather
 * than another crawl (rule 9, and the yellow.com.mt lesson).
 *
 * Anything `fetchPage` already had to say is kept and appended to, never
 * overwritten: an ignored `Retry-After` is exactly the kind of thing a reader
 * of this row needs alongside the block.
 */
function settledResult(
  result: FetchResult,
  item: LeasedUrl,
  spacingMs: number,
): FetchResult {
  if (result.fetchClass !== "blocked") return result;
  const status = result.statusCode === null ? "no status" : String(result.statusCode);
  const attempts = `${item.attempts} attempt${item.attempts === 1 ? "" : "s"}`;
  const reason =
    `blocked (${status}) after ${attempts}, spacing reached ${spacingMs}ms` +
    (result.disallowedReason === null ? "" : `; ${result.disallowedReason}`);
  return { ...result, disallowedReason: reason };
}

function toOutcome(result: FetchResult): BatchOutcome {
  return {
    fetchClass: result.fetchClass,
    responseTimeMs: result.responseTimeMs,
    htmlBytes: result.htmlBytes,
  };
}

function emptyWriterStats(): PageWriterStats {
  return {
    pages: 0,
    links: 0,
    hreflang: 0,
    structuredData: 0,
    resources: 0,
    pageResources: 0,
    hreflangUnresolved: 0,
  };
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
  pageTemplates: PageTemplateInference | null,
  resources: ResourcePassSummary | null,
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
    pageTemplates,
    resources,
    note,
  };
}

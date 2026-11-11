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
 *    A same-origin URL the policy allows and robots.txt forbids is never
 *    fetched and, since Phase 23 T3, never silently dropped either: it is a
 *    `disallowed` page row quoting the robots.txt line, written against its own
 *    budget (`CrawlConfig.maxBlockedUrls`) and never against `maxPages`.
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
import { and, asc, eq, gt, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { crawls, frontier, jobs, listUrls, sitemapHreflang, sitemapMemberships, sitemapUrls } from "../db/schema.js";
// Ruleset provenance for the `crawls` row: the registry owns the number, the
// loop only stamps it.
import { RULESET_VERSION } from "../rules/registry/registry.js";
import {
  discover,
  DiscoveryAbortedError,
  ROBOTS_BLOCKED_REASON_PREFIX,
  robotsBlockedReason,
  type DiscoveryResult,
  type DiscoverySitemapFacts,
  type DiscoveryTruncation,
  type RobotsInfo,
  type SitemapSink,
} from "./discovery.js";
import {
  ControlWatcher,
  readPauseReason,
  type PauseReason,
  type StopReason,
} from "./control.js";
import {
  fetchPage,
  FetchAbortedError,
  MAX_BODY,
  pageRequestHeaders,
  type FetchClass,
  type FetchResult,
} from "./fetch-page.js";
import { probeHostVariants, type HostProbeResult } from "./host-probe.js";
import {
  isClassifiableResponse,
  platformProfileRecord,
  readStoredPlatform,
  type Platform,
  type StoredPlatformProfile,
} from "./platform.js";
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
import {
  hostProbeStarts,
  INDEXED_URL_MAX,
  isSameOrigin,
  normalizeUrl,
} from "./parse/url-utils.js";
import { PageWriter, type PageWriterStats } from "./persist.js";
import { CrawlWindow, HostGate, type BatchOutcome } from "./politeness.js";
import {
  recheckServerErrors,
  type RecheckPassSummary,
} from "./recheck/recheck-server-errors.js";
import {
  fetchCrawlResources,
  markResourcesNotAsked,
  type ResourcePassSummary,
} from "./resources/fetch-resources.js";
import { isUrlAllowed } from "./url-policy.js";
import {
  EXCLUDED_REASON_PREFIX,
  MAX_PATTERN_LENGTH,
  MAX_SCOPE_PATTERNS,
  scopeRefusesSql,
  scopeVerdict,
  type CrawlScope,
} from "./url-scope.js";
import { engineVersion, redactRequestHeaders } from "./versions.js";
import {
  credentialError,
  credentialHeadersFor,
  credentialShapeError,
  describeShape,
  requireCredentials,
  sameShape,
  type CrawlCredentials,
  type CredentialShape,
  type CredentialTarget,
} from "./credentials.js";
import { storableCap, storableDeep } from "./storable-text.js";
import type { TenantId } from "../tenant.js";
import { hostKeyOf } from "./host-key.js";

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
   * It is one of the two fields that are NOT persisted on the `crawls` row: a
   * resume must re-assert it in `ResumeOpts.config` rather than inherit it.
   * See storableConfig.
   */
  allowPrivate?: boolean;
  /**
   * TEST ONLY override of the recheck pass's `MIN_RECHECK_GAP_MS`, on
   * `allowPrivate`'s precedent in every respect. Never wire this to an API
   * field, a CLI flag or an env var.
   *
   * WHY IT EXISTS AT ALL. The 60 second floor between the two observations is
   * the CLAIM THE EVIDENCE MAKES — "still broken a minute later" — and not a
   * tuning knob, so production has no reason to move it and no way to. But it
   * is also real wall time inside any test that drives `runCrawl` over a
   * fixture carrying a 5xx: the pass's own test-only `minGapMs`
   * (`RecheckPassOpts`) cannot reach a crawl the loop runs, so before this
   * field three loop-driven suites each waited a real minute for a pass whose
   * behaviour their assertions do not depend on the gap for
   * (test/db/migration-0016.test.ts, test/crawl/fetch-resources.test.ts,
   * test/fixtures/harness.test.ts). The alternative was raising three timeouts
   * and paying three minutes on every CI run for nothing.
   *
   * WHAT KEEPS IT HONEST, in the order the risks run:
   *
   *  - **It is not persisted.** `storableConfig` strips it beside
   *    `allowPrivate`, and `parseStoredConfig`'s closed field set does not read
   *    it back, so no resume months later inherits a one-second gap from a row
   *    nobody reads (hard rule 7).
   *  - **It is not accepted over the API at any value.** `StartCrawlInput`'s
   *    field allowlist is closed (`parseStartBody`, src/api/config-schema.ts),
   *    so a body carrying this key is refused by both transports; it wants the
   *    named refusal `allowPrivate` gets, so the message says WHY rather than
   *    "unknown field". A client that could shrink the gap could make every
   *    transient 5xx clear.
   *  - **The default is the real number, and it is asserted as a number.**
   *    Absent means `MIN_RECHECK_GAP_MS` — the spread at INSERTION 3c passes
   *    nothing when nobody said anything. Since every loop-driven test now sets
   *    this, the 60 seconds is pinned by reading the exported constant
   *    (test/crawl/recheck.test.ts, "keeps the real floor at 60 seconds and the
   *    real cap at 500 rows") rather than by a test that waits a minute to
   *    observe a number. What the loop-driven tests still prove is that the pass
   *    honours THE GAP IT WAS GIVEN: test/db/migration-0016.test.ts reads it
   *    back off the two timestamps.
   */
  recheckMinGapMs?: number;
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
   * `list` (Phase 27c): fetch the URLs stored in `list_urls` at depth 0,
   * follow redirects but no link, and read no sitemap unless `sitemapUrls` is
   * given. Absent is `spider`. Stored, so a resume stays in the same mode.
   */
  mode?: CrawlMode;
  /**
   * The distinct URLs in `list_urls`. Required when `mode` is `list`; stored
   * (the count, never the URLs: Deviation 2).
   */
  listUrlCount?: number;
  /**
   * How many findings each listing rule may report when this crawl is judged.
   * A positive integer, or `null` for UNCAPPED — every orphan, every duplicate
   * group, every blocked sitemap entry. Absent is the engine's default (200 URL
   * findings), which is what every crawl before P8-T4 got.
   *
   * An uncapped listing carries no truncation note, and the direction that
   * matters is the other one: a note means the list is incomplete, and its
   * absence means it is complete.
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
  /**
   * Whether this crawl asks the site about the files its pages point at.
   * Absent is TRUE — the pass runs, which is what every crawl since P11-T2 has
   * done and what a complete audit needs.
   *
   * IT IS AN OFF SWITCH, NOT A BUDGET, and that is why it is a boolean rather
   * than `maxResources: 0` (which `validateCrawlConfig` refuses on purpose: a
   * zero cap reads like a typo and would mark every row `resource-cap`, a reason
   * that says a budget ran out when no budget was ever spent). An operator who
   * says no to the pass is making a decision about somebody's server — a client
   * who asked us not to touch their CDN, a re-crawl that only needs the page
   * census — and the record has to be able to say that plainly.
   *
   * WHAT FALSE DOES NOT TURN OFF: the analyzer's references. `PageWriter` still
   * writes the `resources` rows and the `page_resources` edges, because reading
   * markup costs nobody a request and "this site's HTML points at 812 distinct
   * files" is evidence whether or not we asked about any of them. What false
   * turns off is the asking — and every row it leaves unasked is stamped with
   * `RESOURCE_OFF_REASON`, so a reader can tell the operator's decision from an
   * interrupted pass, from a cap, and from a crawl written before 0013.
   */
  fetchResources?: boolean;
  /**
   * How many ROBOTS-BLOCKED internal URLs this crawl may record as page rows
   * (Phase 23 T3, study D1). Absent is `maxPages`.
   *
   * A same-origin URL that passes the url-policy and that robots.txt disallows
   * is never requested; it is written as a `disallowed` page row whose
   * `fetch_reason` quotes the matching line, so `robots.blocks-internal-urls`
   * can report it with its inlinks. THIS IS ITS OWN BUDGET AND NEVER
   * `maxPages`'S: a blocked row costs the site nothing, and a robots.txt that
   * disallows a faceted space (`Disallow: /*?filter=` linked from every page)
   * must not be able to stop the crawl from fetching real pages. Past the
   * budget a URL is counted in `crawls.robots_blocked_dropped` instead of
   * written — a number, never a silence (hard rule 7).
   *
   * Sitemap entries are not recorded against it: a sitemap entry robots.txt
   * disallows is already on record in `sitemap_urls` and reported by
   * `robots.blocks-sitemap-urls`, and spending this budget on a sitemap's
   * blocked entries before the first link is read would starve the finding
   * this budget exists for.
   *
   * CRAWL config rather than an engine constant for the resource budgets'
   * reason: a resume must spend the same budget the first attempt was given.
   * Not accepted over the API (yet): the crawl-start schema is
   * closed, so every API crawl takes the `maxPages` default.
   */
  maxBlockedUrls?: number;
  /**
   * Apply a platform profile when the site's headers name its platform
   * (src/crawl/platform.ts; Shopify: one request in flight, ≥1 s per host).
   * Absent means on. `false` is the operator's opt-out: the platform is still
   * detected and recorded, with `optedOut: true`, and nothing is clamped.
   *
   * ENGINE config, on `maxBlockedUrls`'s terms: stored on the row so a resume
   * makes the same choice, and NOT accepted over the API — the
   * crawl-start schema is closed, so a client cannot opt a
   * crawl out of the pace the platform tolerates.
   */
  platformProfiles?: boolean;
  /**
   * THE CRAWL'S SCOPE (Phase 27c): anchored wildcard patterns over the whole
   * normalised URL (`src/crawl/url-scope.ts`). A URL an `exclude` pattern
   * matches, or — with a non-empty `include` — one no `include` pattern
   * matches, is refused at admission: after url-policy, before robots, for
   * every link, sitemap entry and redirect target. The seed is not asked; the
   * API refuses a seed its own scope excludes before the row exists.
   *
   * A refused link or redirect target is an `excluded` page row naming the
   * pattern, never a request, written against the `maxBlockedUrls` budget it
   * shares with robots-blocked rows; past it the URL is counted in
   * `crawls.excluded_dropped`. A refused sitemap entry is skipped, not written
   * (the robots-blocked precedent; Deviation 8): it is on record in
   * `sitemap_urls` already.
   *
   * Stored, and changeable while paused: a resume whose scope refuses URLs
   * still pending re-files them as `excluded` rows before its first lease
   * (`refileOutOfScope`). At most `MAX_SCOPE_PATTERNS` patterns of at most
   * `MAX_PATTERN_LENGTH` characters each.
   */
  exclude?: string[];
  include?: string[];
  /**
   * How many redirects one chain may follow (Phase 27c), counted on the
   * frontier row (`frontier.redirect_hops`): a redirect target inherits its
   * source's count plus one, and a target already in the frontier keeps its
   * own (Deviation 12). The redirect whose target would exceed the cap is
   * written with the reason and its target is not queued. Absent is
   * `CRAWL_DEFAULTS.maxRedirectHops` (10); an integer from 1 to 20.
   */
  maxRedirectHops?: number;
  /**
   * The longest URL this crawl will queue or request (Phase 27c). At
   * admission a LINK longer than it (and within the index's ceiling) is an
   * `excluded` row naming the limit, on the shared budget; a sitemap entry is
   * skipped (Deviation 8). A REDIRECT TARGET longer than it never reaches
   * admission: every `fetchPage` call the loop makes is passed the limit
   * (`UrlPolicyOpts.maxUrlLength`), `fetchPage` resolves the `Location` under
   * it and refuses the target, and the redirect's own row records why
   * (`fetch_reason` `redirect target refused: too_long (…)`); the target gets
   * no row and is not queued. The same option refuses an over-long seed
   * (27c final wave M3). Absent is
   * `CRAWL_DEFAULTS.maxUrlLength`,
   * the index's own limit (`INDEXED_URL_MAX`, 2,500); an integer from 256 to
   * 2,500. Not changeable after start: lowering it mid-crawl would need the
   * re-filter the scope lists get (Deviation 11).
   */
  maxUrlLength?: number;
  /**
   * THE CRAWL'S CREDENTIALS (Phase 27c): custom request headers, HTTP Basic
   * auth and cookies (`src/crawl/credentials.ts`). Sent ONLY to requests whose
   * own URL is in the site family (`credentialHeadersFor`, decided per
   * request and per redirect hop) — the host probe, robots.txt, sitemaps,
   * pages, the recheck, the known-404 probe and same-family resources — and
   * never to any other host.
   *
   * NEVER STORED WITH THE CONFIG, on `allowPrivate`'s precedent:
   * `storableConfig` strips it, and `parseStoredConfig`'s closed field set
   * never reads it back. A secret value must not reach a column in clear, a
   * log line, an error or a response; the API keeps it encrypted in
   * `crawl_credentials` (28b, `CredentialVault`). A resume re-supplies it
   * through `ResumeOpts.config`, and a resume that does not is refused
   * (`credentialShape`).
   */
  credentials?: CrawlCredentials;
  /**
   * What `credentials` looked like — which fields, and the header and cookie
   * names (`shapeOf`) — and STORED, so the row says this crawl needs them. A
   * run whose shape is set and whose `credentials` are absent or of another
   * shape is refused with `CredentialsMissingError` before its first request
   * (hard rule 7): a crawl never continues unauthenticated against a site
   * that needed auth. Required whenever `credentials` is given
   * (`validateCrawlConfig`), so the record cannot be left out.
   */
  credentialShape?: CredentialShape;
}

/** How a crawl finds its URLs: by following links (`spider`) or from a stored list. */
export type CrawlMode = "spider" | "list";

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
  /**
   * The walk's own truncation, plus `interrupted` (Phase 27d): set to true on
   * the evidence an EARLIER run wrote by a run about to clear the staged
   * sitemap memberships and alternates for its re-walk
   * (`SitemapRowSink.prepare`, written ahead), and left there when that run
   * ends — stopped, failed, or crashed — before writing its own; that evidence then no longer describes what is
   * staged. Never written by a walk that returned: the next complete walk
   * rewrites this object whole and the key is gone. Absent reads false
   * (`readSitemapHreflang`).
   */
  truncation: DiscoveryTruncation & { interrupted?: boolean };
  /** Sitemap documents attempted. Lifted out of `truncation` for the rules. */
  docsFetched: number;
  /**
   * What the walk handed `sitemap_memberships` and `sitemap_hreflang`, and what
   * it could not (Phase 26c). Written on every crawl from then on, zeros when
   * there was no sitemap; ABSENT on an older crawl, which is how a rule tells
   * "no memberships" from "never recorded" (`sitemapFactsRecorded`).
   */
  sitemapFacts?: DiscoverySitemapFacts;
  /**
   * False when the crawl read no sitemap document (a list crawl without
   * `sitemapUrls`). ABSENT on an older row, which read them: absent is true.
   */
  sitemapsRead?: boolean;
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
  // Phase 27c. A chain longer than ten hops is a site defect worth a finding,
  // not a path worth following further; the URL limit is the index's own.
  maxRedirectHops: 10,
  maxUrlLength: INDEXED_URL_MAX,
  // The render pass's three, from the module that spends them. Spread rather
  // than copied so there is one place a budget can be changed.
  ...RENDER_DEFAULTS,
} as const;

export interface CrawlSummary {
  crawlId: string;
  /**
   * How the run ended, mirroring `crawls.status`:
   *  - `finished`  — the frontier drained, or `maxPages` was reached.
   *  - `paused`    — the run stopped with its frontier intact and is resumable:
   *    an agent's pause (`pauseReason: "request"`) or this process shutting
   *    down (the abort signal, `pauseReason: "shutdown"`). A shutdown is a
   *    pause (Phase 27b).
   *  - `cancelled` — an agent's cancel. Final: `resumeCrawl` refuses it. What
   *    was crawled stays judgeable.
   *  - `failed`    — the crawl could not legitimately proceed: an unreachable
   *    robots.txt (complete disallow, RFC 9309 §2.3.1.4), or an error, the
   *    control poll's included. A caller must branch on this: 0 pages with
   *    `failed` is not an empty site.
   */
  status: "finished" | "paused" | "cancelled" | "failed";
  /** Why a `paused` run paused; null for every other status. */
  pauseReason: PauseReason | null;
  /** Pages persisted across the crawl's whole life, resumes included. */
  pagesCrawled: number;
  frontier: FrontierCounts;
  /** What the write path actually wrote, including what it could not. */
  writer: PageWriterStats;
  /**
   * What robots.txt said, or null when this run was stopped (paused or
   * cancelled) before its discovery was recorded — in the host probe, in the
   * sitemap walk, or as the walk returned (Phase 27d). Null is not "absent":
   * nothing was concluded.
   */
  robots: { outcome: RobotsInfo["outcome"]; note: string | null } | null;
  /** What the sitemap walk found; null exactly when `robots` is. */
  discovery: { sitemapEntries: number; truncation: DiscoveryTruncation } | null;
  /**
   * False when no sitemap document was requested (list mode without
   * `sitemapUrls`): zero entries then means "not read", not "none declared".
   * Null exactly when `robots` is: the walk was stopped, not skipped.
   */
  sitemapsRead: boolean | null;
  /**
   * What the crawl-end template inference did (`inferPageTemplates`), or null
   * when it did not run — which today means a crawl that failed before it could
   * see its own population, or one stopped before its page loop (in the host
   * probe or the sitemap walk, Phase 27d). Null is not "nothing to collapse": that is
   * `pagesRetyped: 0`, and the two must not be read as the same thing.
   */
  pageTemplates: PageTemplateInference | null;
  /**
   * What the resource fetch pass did, or null when it did not run — a crawl
   * that failed before it had pages, or one that was stopped (paused or
   * cancelled: a stop means stop asking servers for things, and the pass is
   * all asking). Null is not
   * "no resources": that is a summary whose `seen` is 0, and the two must not
   * be read as the same thing.
   */
  resources: ResourcePassSummary | null;
  /**
   * What the re-verification pass (5xx and no-response rows) did, or null when it did not run — a
   * crawl that failed before it had pages, or one that was already stopped
   * (paused or cancelled) when the pass's turn came (a stop means stop asking
   * servers for things,
   * and the pass is all asking). The `resources: null` precedent, with the same
   * warning: null is not "no server errors". That is a summary whose
   * `rechecked` is 0, and the two must not be read as the same thing — one says
   * nobody looked, the other says there was nothing to look at.
   */
  recheck: RecheckPassSummary | null;
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
 * RSS before the fact. IMPORTED, not restated: a 1MiB literal left here when
 * the cap moved to 2MiB (Phase 23) would under-reserve every fetch by half and
 * let in-flight bytes reach twice the budget. Real sizes are reported to the
 * window afterwards, in `BatchOutcome.htmlBytes`.
 */
const RESERVED_BYTES_PER_FETCH = MAX_BODY;

/** How long to wait before re-polling the byte budget. See admit(). */
const ADMIT_POLL_MS = 25;

/** Wait before re-leasing when the frontier is empty but another worker is busy. */
const IDLE_POLL_MS = 500;

/** Rows per `sitemap_urls`, `sitemap_memberships` and `sitemap_hreflang` insert. */
const SITEMAP_BATCH = 500;

/**
 * Mirrors CrawlWindow's own initial-concurrency default. Passed explicitly so
 * a `maxConcurrency` below it is a smaller window rather than a RangeError.
 */
const WINDOW_INITIAL = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TEST ONLY — never wire it to an API field. Observation points a suite uses to
 * measure the loop where it imposes its behaviour, like the renderer's
 * `RenderTestFaults`.
 */
export interface LoopTestHooks {
  /**
   * Told each slot the crawl's host gate hands out, with the host and the
   * slot's scheduled start (`Date.now()`, the clock the gate spaces on). A
   * pacing test asserts on these rather than on request arrival at the server,
   * which adds jitter that is not the gate's. Called synchronously as the slot
   * is claimed, before the wait: the loop ignores what it returns, but a test
   * may act on it — a shutdown test aborts its run from here to land the stop
   * at a known point in the page loop.
   */
  onGrant?: (host: string, slotAtMs: number) => void;
  /**
   * Awaited at the end of every flush of the sitemap row sink — while the
   * walk's document clocks are paused and the body waits — with the run's stop
   * signal. A stop test writes its request from here to land a stop inside a
   * flush (27d Review Focus 2).
   */
  onSitemapFlush?: (stop: AbortSignal) => Promise<void>;
  /**
   * Awaited as soon as `discover` returns, before the run checks its stop
   * signal and writes the discovery evidence — the window between discovery
   * and the first lease (27d Review Focus 1).
   */
  afterDiscovery?: (stop: AbortSignal) => Promise<void>;
  /**
   * Awaited after each batch of the run's seeding — a batch of `sitemap_urls`
   * rows, or a chunk of the sitemap or list URLs looked up for the frontier —
   * with the run's stop signal, so a stop test can land a pause between two
   * batches (27d ruling R9).
   */
  onSeedingBatch?: (stage: "sitemap_urls" | "frontier", stop: AbortSignal) => Promise<void>;
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
  /**
   * The process's shutdown signal. Firing it PAUSES the crawl (reason
   * `shutdown`); an agent's pause or cancel arrives through
   * `crawls.control_request` instead (`ControlWatcher`).
   */
  signal?: AbortSignal;
  /**
   * The status the claim must find. The API queue sets `queued`, so a crawl
   * somebody else moved while it waited is not run.
   *
   * With it: an EXISTING row whose status is anything else — `paused`,
   * `cancelled`, `running`, `finished`, `failed` — throws `ClaimLostError`
   * carrying that status, whether the read before the claim saw it or the
   * claim itself (`where status = 'queued'`, zero rows) lost the race. Nothing
   * is written. A row that does not exist at all is a plain `Error` (`no
   * crawl …`), never a `ClaimLostError`: delete refuses a queued crawl, so a
   * row vanishing under the runner is an anomaly and stays loud.
   *
   * Without it: any status but `cancelled` is claimed, and `cancelled` throws a
   * plain `Error` (a cancel is final).
   */
  expectStatus?: "queued";
  /**
   * Return *every* live lease in the crawl to pending before starting, instead
   * of waiting for the dead worker's leases to expire (see leaseSecondsFor).
   * Correct
   * for a resume after a crash — which is the case the gate script exercises —
   * and wrong while another worker is still running: it would hand that
   * worker's URLs to this one.
   */
  reclaimLeases?: boolean;
  /** TEST ONLY — see `LoopTestHooks`. */
  testHooks?: LoopTestHooks;
  /**
   * Awaited inside the transaction of the run's closing write — every close:
   * finished, paused, cancelled, failed — with what that write recorded. A
   * throw rolls the close back (and the run fails loudly, as any close that
   * cannot be written does). The job runner settles the crawl's job here
   * (src/worker/crawl-job.ts), so the crawl reading closed and its job still
   * holding it are never both true at once.
   */
  onClose?: CloseHook;
  /**
   * The job this run is the work of (28b T4b): the runner's claimed `crawl`
   * job and the instance that claimed it. With it the run writes the crawl
   * only while it OWNS it:
   *
   *  - the claim (`queued → running`) also requires the job to be still
   *    `running` and claimed by `instanceId`. A job abandoned between the
   *    runner's claim and this one (a reaper that read the runner as dead,
   *    `crawl_resume` adopting it) loses the claim with `JobLostError`, and
   *    the crawl never starts under an abandoned job;
   *  - every close (finished, stopped, failed) first checks the same. A job
   *    that is no longer this run's closes the crawl only if nobody else holds
   *    it — the crawl still `running` and no other live job for it — and
   *    otherwise writes nothing and throws `JobLostError`: whoever took the
   *    crawl (the reaper's `worker_lost` pause, a resume's fresh job and its
   *    runner) has the row, and a late close from here would overwrite it.
   *
   * Locks are taken crawl row first, then job row, as every other writer of
   * the pair takes them (the reaper, `crawl_resume`, `crawl_mark_failed`,
   * the close's own `onClose`).
   */
  owner?: RunOwner;
}

/** See `ResumeOpts.owner`. */
export interface RunOwner {
  jobId: string;
  instanceId: string;
}

/** What a run's close wrote, as `ResumeOpts.onClose` is told it. */
export interface ClosedRecord {
  status: CrawlSummary["status"];
  pauseReason: PauseReason | null;
  /** The sentence a `failed` close wrote; null on every other close. */
  failureReason: string | null;
}

type CloseTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** See `ResumeOpts.onClose`. */
export type CloseHook = (tx: CloseTx, closed: ClosedRecord) => Promise<void>;

/**
 * A resume's claim found the row in another status than the one it expected
 * (`ResumeOpts.expectStatus`): something else moved the crawl between the
 * caller's read and the claim. Nothing was changed.
 */
export class ClaimLostError extends Error {
  readonly crawlId: string;
  readonly status: string;
  constructor(crawlId: string, status: string, expected: string) {
    super(
      `resumeCrawl: crawl ${crawlId} is '${status}', not '${expected}': something else ` +
        `moved it before this run could claim it, and nothing was changed`,
    );
    this.name = "ClaimLostError";
    this.crawlId = crawlId;
    this.status = status;
  }
}

/**
 * The run's job is no longer its own (`ResumeOpts.owner`): it was abandoned by
 * a reaper or adopted by `crawl_resume` — at the claim (`stage: "start"`, the
 * crawl was never started) or at a close (`"close"`, the crawl has another
 * holder, and this run's close was not written). A `ClaimLostError`, so a
 * runner that already treats a lost claim as "nothing to write" treats this
 * the same.
 */
export class JobLostError extends ClaimLostError {
  readonly jobId: string;
  readonly stage: "start" | "close";
  constructor(crawlId: string, status: string, jobId: string, stage: "start" | "close") {
    super(crawlId, status, "queued");
    this.message =
      stage === "start"
        ? `resumeCrawl: crawl ${crawlId}'s job ${jobId} is no longer this runner's (a reaper ` +
          "abandoned it, or crawl_resume adopted the crawl) — the crawl was not started, and " +
          "nothing was changed"
        : `crawl ${crawlId}'s job ${jobId} was taken from this run (a reaper abandoned it, or ` +
          `crawl_resume adopted the crawl), and the crawl ('${status}') has been taken since: ` +
          "this run's close was not written";
    this.name = "JobLostError";
    this.jobId = jobId;
    this.stage = stage;
  }
}

/**
 * Start a new crawl of `config.siteUrl`.
 *
 * Creates the `crawls` row, reads robots.txt and the sitemap tree, seeds the
 * frontier, and runs the loop until the frontier drains, `maxPages` is reached,
 * an agent's pause or cancel arrives through `crawls.control_request`, or
 * `signal` (the process shutting down) aborts, which pauses the crawl.
 */
export async function runCrawl(
  db: Db,
  tenant: TenantId,
  config: CrawlConfig,
  signal?: AbortSignal,
  testHooks?: LoopTestHooks,
): Promise<CrawlSummary> {
  validateCrawlConfig(config);
  // A list crawl's URLs live in `list_urls`, written by the API's start with
  // the row (src/api/service.ts) and run through `resumeCrawl`. A crawl minted
  // here has a fresh id and so no listed URL: it would be a silently empty
  // crawl blaming robots.txt (27c final wave M8). Refused, before the row.
  if (config.mode === "list") {
    throw new Error(
      `runCrawl cannot start a mode "list" crawl of ${config.siteUrl}: its URLs are the ` +
        "list_urls rows the API's crawl start writes with the crawl row, and a crawl " +
        "minted here has none. Start a list crawl through the API (crawl_start)",
    );
  }
  // Before the row exists and before any request: a crawl that needs
  // credentials it was not given is refused, never run unauthenticated.
  requireCredentials(null, config.siteUrl, config.credentialShape, config.credentials);

  const crawlId = `crawl_${randomUUID()}`;
  await db.insert(crawls).values({
    id: crawlId,
    tenantId: tenant,
    siteUrl: config.siteUrl,
    hostKey: hostKeyOf(config.siteUrl),
    config: storableConfig(config),
    rulesetVersion: RULESET_VERSION,
    status: "running",
  });

  return execute(db, crawlId, config, signal, testHooks, undefined);
}

/**
 * Continue an existing crawl — after a crash, a pause (an agent's, or a
 * shutdown's), or a `maxPages` stop that the operator wants to extend. A
 * `cancelled` crawl is refused: a cancel is final.
 *
 * The claim clears `pause_reason` but NOT `control_request`. A crawl whose
 * process died with a pause or cancel pending still holds it on its `running`
 * row, and a (`reclaimLeases`) resume of it honours that request at its first
 * poll. That is intended: the agent asked, and nobody has answered yet.
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
 *
 * THE POLITENESS STATE IS RE-ENTERED, not restarted. `crawls.host_spacing_ms`
 * is the widest spacing this crawl's gate ever reached, and it is a finding
 * rather than a setting — a host refused us and the engine backed off (rule 9).
 * The continuation's gate is built with it (see `storedSpacing` and
 * `HostGate.earnedSpacingMs`), so a crawl that earned 8s resumes at 8s whatever
 * its stored `perHostDelayMs` says. Until P12-T3 it did not: the gate came up at
 * the configured floor and the first `recordSpacing` wrote that floor back over
 * the evidence, which made the regression invisible from `crawl_status` as well
 * as rude to the site.
 *
 * Since migration 0015 that re-entry is PER HOST. `crawls.host_spacing_jsonb`
 * (`HostGate.restore`) is the same finding split by host, so each host resumes
 * at ITS OWN earned spacing rather than at the single crawl-wide widest — a
 * crawl whose CDN earned 8s while the origin stayed at 1s resumes the origin at
 * 1s. Since Phase 24a the map carries each host's whole ratchet state (base,
 * level, recovery count, two-strike lock, throttle counters), so a resumed host
 * keeps its place on the ratchet and a resume is not a way round the lock; a
 * pre-24a `{host: ms}` map still loads, each number re-entering as that host's
 * base. A host the map does not name (discovered only
 * on the continuation) and a pre-0015 crawl whose map is null both fall back to
 * the crawl-wide `host_spacing_ms`, which stays for exactly that — honest
 * degradation in the polite direction, never a fabricated per-host split.
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

  if (opts.expectStatus !== undefined) {
    // Any other status, `cancelled` included, is a claim already lost: the
    // caller (the API queue) skips on the type, not on the sentence.
    if (row.status !== opts.expectStatus) {
      throw new ClaimLostError(crawlId, row.status, opts.expectStatus);
    }
  } else if (row.status === "cancelled") {
    throw new Error(`resumeCrawl: crawl ${crawlId} is cancelled, and a cancel is final`);
  }

  const config = opts.config ?? parseStoredConfig(row.config, crawlId);
  validateCrawlConfig(config);
  // THE ROW DECIDES WHETHER CREDENTIALS ARE NEEDED. An `opts.config` that
  // leaves `credentialShape` out must not be the way a crawl that needed auth
  // resumes without it, and one that states a SMALLER (or any other) shape must
  // not be the way it resumes with less (27c T9): when the row stores a shape,
  // an override's own shape must be that shape. Only a row with none takes the
  // override's. Before the claim, so a refused resume has changed nothing.
  const rowShape = storedCredentialShape(row.config, crawlId);
  if (
    rowShape !== null &&
    config.credentialShape !== undefined &&
    !sameShape(rowShape, config.credentialShape)
  ) {
    throw new Error(
      `resumeCrawl: crawl ${crawlId}'s override config states a credentialShape other than ` +
        `the one its row stores (${describeShape(rowShape)}): the row decides which ` +
        `credentials a resume needs`,
    );
  }
  requireCredentials(crawlId, config.siteUrl, rowShape ?? config.credentialShape, config.credentials);

  // THE CLAIM, a compare-and-swap rather than a blind write. With
  // `expectStatus` it is conditioned on that status (the API queue's `queued`),
  // so a crawl moved between the read above and here is not run. Without it,
  // any status but `cancelled`: the check above, repeated in the WHERE so a
  // cancel that lands between the read and here is still refused.
  //
  // It does NOT clear `control_request`. A row holds one only while `running`,
  // so the only claim that can meet one is a resume of a crawl whose process
  // died with a request pending (`reclaimLeases`); that resume honours the
  // request at its first poll, which is intended — the agent asked for it.
  //
  // WITH AN OWNER (28b T4b) the claim is also conditioned on the run's job
  // being still its own, read under the crawl row's lock and then the job
  // row's (`ResumeOpts.owner`): a job abandoned between the runner's claim and
  // this one never starts the crawl. A transaction, not a sub-select in the
  // WHERE: a sub-select would read the job as of the statement's snapshot even
  // after waiting out a writer that changed it.
  const claim = (writer: Db | CloseTx) =>
    writer
      .update(crawls)
      .set({
        status: "running",
        finishedAt: null,
        // The earlier run's sentence goes with the status it belonged to: the
        // column's contract is `failure_reason IS NOT NULL` ⟹ `status = 'failed'`
        // (migration 0017), and a `running` row still carrying why it once failed
        // breaks it and tells a reader a live crawl has already died.
        failureReason: null,
        // And the pause's reason goes with the pause: non-null exactly when
        // `status = 'paused'` (27b column contract).
        pauseReason: null,
      })
      .where(
        opts.expectStatus === undefined
          ? and(eq(crawls.id, crawlId), ne(crawls.status, "cancelled"))
          : and(eq(crawls.id, crawlId), eq(crawls.status, opts.expectStatus)),
      )
      .returning({ id: crawls.id });
  const owner = opts.owner;
  const claimed =
    owner === undefined
      ? await claim(db)
      : await db.transaction(async (tx) => {
          const status = await lockCrawlStatus(tx, crawlId);
          if (!(await ownsJob(tx, owner))) throw new JobLostError(crawlId, status, owner.jobId, "start");
          return claim(tx);
        });
  if (claimed.length === 0) {
    const [now] = await db
      .select({ status: crawls.status })
      .from(crawls)
      .where(eq(crawls.id, crawlId));
    // Gone between the read and the claim: an anomaly, not a lost claim.
    if (now === undefined) throw new Error(`resumeCrawl: no crawl ${crawlId}`);
    if (opts.expectStatus === undefined) {
      // The one status the unconditioned claim refuses.
      throw new Error(`resumeCrawl: crawl ${crawlId} is cancelled, and a cancel is final`);
    }
    throw new ClaimLostError(crawlId, now.status, opts.expectStatus);
  }

  // After the claim, so a lost claim has touched nothing.
  if (opts.reclaimLeases === true) {
    await releaseLeases(db, crawlId, null);
  }

  return execute(db, crawlId, config, opts.signal, opts.testHooks, { onClose: opts.onClose, owner: opts.owner });
}

/**
 * The config as `crawls.config_jsonb` should hold it: everything except the two
 * TEST-ONLY fields, `allowPrivate` (build-plan §7, "before the first real-site
 * crawl") and `recheckMinGapMs` (P17).
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
 *
 * `recheckMinGapMs` joins the strip by the same argument, one field over. It
 * shortens the floor under the gap between the two 5xx observations so a
 * loop-driven test does not wait a real minute, and a row that carried it would
 * make that durable: every resume of that crawl would re-verify its server
 * errors a second after seeing them and report the answer as if a minute had
 * passed. Persisting a shortened gap is persisting a WEAKER CLAIM about the
 * evidence, which is worse than persisting a stale number.
 *
 * `credentials` (Phase 27c) joins the strip for a stronger reason than either:
 * its values are SECRETS — header values, a password, cookie values — and a
 * secret value must never reach a column. What the row keeps is
 * `credentialShape` (names only), so a resume knows to ask for them again.
 */
export function storableConfig(
  config: CrawlConfig,
): Omit<CrawlConfig, "allowPrivate" | "recheckMinGapMs" | "credentials"> {
  const {
    allowPrivate: _allowPrivate,
    recheckMinGapMs: _recheckMinGapMs,
    credentials: _credentials,
    ...rest
  } = config;
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
 * `recheckMinGapMs` is absent from the closed set below for the same reason and
 * with the same consequence: a resume re-verifies this crawl's server errors at
 * `MIN_RECHECK_GAP_MS`, whatever a test handed the first run.
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
    mode: raw["mode"],
    listUrlCount: raw["listUrlCount"],
    renderBudgetPct: raw["renderBudgetPct"],
    renderMaxPages: raw["renderMaxPages"],
    renderSamplePerType: raw["renderSamplePerType"],
    findingCap: raw["findingCap"],
    maxResources: raw["maxResources"],
    maxResourceHosts: raw["maxResourceHosts"],
    fetchResources: raw["fetchResources"],
    maxBlockedUrls: raw["maxBlockedUrls"],
    platformProfiles: raw["platformProfiles"],
    exclude: raw["exclude"],
    include: raw["include"],
    maxRedirectHops: raw["maxRedirectHops"],
    maxUrlLength: raw["maxUrlLength"],
    // The shape only (Phase 27c). `credentials` is never read back: the row
    // must not hold one, and one that somehow does is not the thing that
    // turns them on.
    credentialShape: storedCredentialShape(raw, crawlId) ?? undefined,
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
  // `fetchResources` joins `probeHosts` here rather than defaulting on a
  // non-boolean: a stored `"false"` is truthy, so a resume would turn the pass
  // back ON for a client who asked us not to touch their servers, and a resume
  // that guessed `false` would silently stop asking about a crawl that did.
  // `platformProfiles` joins them on the same terms: a stored `"false"` that
  // resumed as "on" would clamp a crawl its operator opted out, and one that
  // resumed as "off" would crawl a Shopify store at full width.
  for (const field of ["probeHosts", "fetchResources", "platformProfiles"] as const) {
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
    // The blocked-row budget (Phase 23 T3), on the same terms.
    "maxBlockedUrls",
    // Phase 27c's two limits, on the same terms.
    "maxRedirectHops",
    "maxUrlLength",
    "listUrlCount",
  ] as const) {
    if (config[field] !== undefined && typeof config[field] !== "number") {
      throw new Error(`crawl ${crawlId}: stored config.${field} is not a number`);
    }
  }
  // A stored mode we cannot read must stop: read as `spider`, a list crawl
  // would resume by following links across a site it was told to sample.
  if (config.mode !== undefined && config.mode !== "spider" && config.mode !== "list") {
    throw new Error(`crawl ${crawlId}: stored config.mode is not "spider" or "list"`);
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
  // The scope lists join them (Phase 27c): a resume that read a mangled
  // `exclude` as empty would fetch every URL the agent fenced off. The same
  // shape rule `storedScope` (src/rules/query/crawl-evidence.ts) applies.
  for (const field of ["legacyHosts", "sitemapUrls", "exclude", "include"] as const) {
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
 * `config_jsonb.credentialShape`, validated, or null when the row has none. A
 * present-but-malformed shape stops the read (the `parseStoredConfig` ruling):
 * read as "none", it would let a crawl that needed auth run without it.
 * Exported beside `parseStoredConfig` for `resumeCrawl`, which consults the row
 * even when an override config is supplied.
 */
export function storedCredentialShape(value: unknown, crawlId: string): CredentialShape | null {
  if (typeof value !== "object" || value === null) {
    throw new Error(`crawl ${crawlId}: stored config is not readable`);
  }
  const shape = (value as Record<string, unknown>)["credentialShape"];
  if (shape === undefined) return null;
  const error = credentialShapeError(shape, `crawl ${crawlId}: stored config.credentialShape`);
  if (error !== null) throw new Error(error);
  return shape as CredentialShape;
}

/** `CrawlConfig.maxRedirectHops`' range (Phase 27c). */
export const MIN_REDIRECT_HOPS = 1;
export const MAX_REDIRECT_HOPS = 20;
/** `CrawlConfig.maxUrlLength`'s floor; its ceiling is `INDEXED_URL_MAX`. */
export const MIN_URL_LENGTH = 256;

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
  if (config.mode !== undefined && config.mode !== "spider" && config.mode !== "list") {
    throw new Error(`CrawlConfig.mode must be "spider" or "list", got ${String(config.mode)}`);
  }
  if (config.mode === "list") {
    if (
      config.listUrlCount === undefined ||
      !Number.isInteger(config.listUrlCount) ||
      config.listUrlCount < 1
    ) {
      throw new RangeError(
        `CrawlConfig.listUrlCount must be an integer ≥ 1 when mode is "list", got ${config.listUrlCount}`,
      );
    }
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
    // A blocked budget of 0 would turn every robots-blocked link into an
    // overflow count with no row behind it — the silence this budget exists
    // to bound, made total. Refused for the same reason as the two above.
    ["maxBlockedUrls", config.maxBlockedUrls],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new RangeError(
        `CrawlConfig.${field} must be an integer ≥ 1, got ${String(value)}`,
      );
    }
  }
  // Phase 27c's limits: a nonsense value is refused before the row exists,
  // never clamped.
  if (
    config.maxRedirectHops !== undefined &&
    (!Number.isInteger(config.maxRedirectHops) ||
      config.maxRedirectHops < MIN_REDIRECT_HOPS ||
      config.maxRedirectHops > MAX_REDIRECT_HOPS)
  ) {
    throw new RangeError(
      `CrawlConfig.maxRedirectHops must be an integer from ${MIN_REDIRECT_HOPS} to ` +
        `${MAX_REDIRECT_HOPS}, got ${String(config.maxRedirectHops)}`,
    );
  }
  if (
    config.maxUrlLength !== undefined &&
    (!Number.isInteger(config.maxUrlLength) ||
      config.maxUrlLength < MIN_URL_LENGTH ||
      config.maxUrlLength > INDEXED_URL_MAX)
  ) {
    throw new RangeError(
      `CrawlConfig.maxUrlLength must be an integer from ${MIN_URL_LENGTH} to ` +
        `${INDEXED_URL_MAX}, got ${String(config.maxUrlLength)}`,
    );
  }
  // The scope lists. An empty pattern matches only the empty string, so it can
  // never match a URL: in `exclude` it is dead, and in `include` it would
  // quietly fence off every link — refused either way.
  for (const field of ["exclude", "include"] as const) {
    const patterns = config[field];
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) {
      throw new TypeError(`CrawlConfig.${field} must be an array of strings`);
    }
    if (patterns.length > MAX_SCOPE_PATTERNS) {
      throw new RangeError(
        `CrawlConfig.${field} holds ${patterns.length} patterns; the limit is ${MAX_SCOPE_PATTERNS}`,
      );
    }
    for (const pattern of patterns) {
      if (pattern === "") {
        throw new RangeError(`CrawlConfig.${field} pattern is empty, and can never match a URL`);
      }
      if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new RangeError(
          `CrawlConfig.${field} pattern is ${pattern.length} characters; the limit is ` +
            `${MAX_PATTERN_LENGTH}`,
        );
      }
    }
  }
  // The credentials (Phase 27c). The messages name fields and header or
  // cookie NAMES, never a value. Supplied credentials need the shape that
  // records them, or the row would not say the crawl needs them and a resume
  // would run unauthenticated.
  if (config.credentials !== undefined) {
    const error = credentialError(config.credentials, "CrawlConfig.credentials");
    if (error !== null) throw new TypeError(error);
  }
  if (config.credentialShape !== undefined) {
    const error = credentialShapeError(config.credentialShape, "CrawlConfig.credentialShape");
    if (error !== null) throw new TypeError(error);
  }
  if (config.credentials !== undefined && config.credentialShape === undefined) {
    throw new TypeError(
      "CrawlConfig.credentials was given without CrawlConfig.credentialShape: the stored " +
        "row would not say this crawl needs credentials, and a resume would run without them",
    );
  }
  // The test-only recheck gap, checked here for `findingCap`'s reason: the pass
  // that spends it runs after the last page, so a nonsense value would be found
  // by a `RangeError` an hour into a crawl. It is range-checked and not
  // clamped — a fractional or negative gap is a caller's mistake, not a number
  // to quietly round (hard rule 7).
  if (
    config.recheckMinGapMs !== undefined &&
    (!Number.isInteger(config.recheckMinGapMs) || config.recheckMinGapMs < 0)
  ) {
    throw new RangeError(
      `CrawlConfig.recheckMinGapMs must be an integer ≥ 0, got ` +
        `${String(config.recheckMinGapMs)}`,
    );
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
 *
 * AND THE ROW NOW SAYS WHY (migration 0017). The status alone told a reader
 * that something went wrong and refused to say what — the Phase 17 gate watched
 * a crawl close `failed` in 14 seconds with the only sentence about it in this
 * process's log (docs/gates/phase-17.md §5, clause 5). `crawls.failure_reason`
 * carries `failureReasonOf(error)`, the message's FIRST LINE; the stack still
 * goes to the log exactly as before.
 */
async function execute(
  db: Db,
  crawlId: string,
  config: CrawlConfig,
  signal: AbortSignal | undefined,
  testHooks: LoopTestHooks | undefined,
  closer: RunCloser | undefined,
): Promise<CrawlSummary> {
  // THE ONE SIGNAL THE RUN STOPS ON (Phase 27b). It fires on an agent's pause
  // or cancel (polled off `crawls.control_request`), on the process's own
  // shutdown signal (a pause, reason `shutdown`), and on a poll that failed.
  // Stopped in the `finally`, whatever happened: an interval left armed would
  // keep the process alive and keep reading a row nobody is running.
  const watcher = new ControlWatcher(db, crawlId, { shutdown: signal });
  watcher.start();
  try {
    // What this run sent and which build sent it (Phase 25 §3). Latest wins on
    // a resume: the column describes the process that finished the crawl.
    await db
      .update(crawls)
      .set({
        // The credential headers a page on the seed's own origin is sent ride
        // along REDACTED: the row says they were sent, never what they held.
        requestHeaders: redactRequestHeaders(
          {
            ...credentialHeadersFor(config.siteUrl, config.siteUrl, config.credentials),
            ...pageRequestHeaders(config.userAgent),
          },
          // The shape's names, and the credentials' own as well: the two agree
          // by the time a run gets here (`requireCredentials`), and a value
          // must not reach the row even if they ever did not.
          [
            ...(config.credentialShape?.requestHeaderNames ?? []),
            ...Object.keys(config.credentials?.requestHeaders ?? {}),
          ],
        ),
        engineVersion: engineVersion(),
      })
      .where(eq(crawls.id, crawlId));
    return await runToCompletion(db, crawlId, config, watcher, testHooks, closer);
  } catch (caught) {
    // A close refused because the run's job was taken (`ResumeOpts.owner`):
    // the crawl has another holder, and a `failed` close would be the same
    // overwrite the refused one was. Up as it is, nothing written.
    if (caught instanceof JobLostError) {
      await watcher.stop();
      throw caught;
    }
    // A control poll that failed on the way down is surfaced beside whatever
    // ended the run, never lost to it (rule 7). The run's own paths already
    // raise it when it is the cause; this covers an error that got there first.
    await watcher.stop();
    const controlFailure = watcher.failure();
    const error =
      controlFailure === null || controlFailure === caught || containsError(caught, controlFailure)
        ? caught
        : new AggregateError(
            [caught, controlFailure],
            `crawl ${crawlId} failed, and its control poll failed too`,
          );
    try {
      // The frontier's own crawled count, not a counter held in this process:
      // it is the honest number, and it survives whatever went wrong.
      await closeCrawl(
        db,
        crawlId,
        "failed",
        crawledRows(await frontierCounts(db, crawlId)),
        null,
        failureReasonOf(error),
        null,
        closer,
      );
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `crawl ${crawlId} failed, and marking the crawls row failed too`,
      );
    }
    throw error;
  } finally {
    await watcher.stop();
  }
}

/** Whether `error` is `target` or an AggregateError that holds it, at any depth. */
function containsError(error: unknown, target: unknown): boolean {
  if (error === target) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((inner: unknown) => containsError(inner, target));
  }
  return false;
}

/**
 * Stop the control watcher and raise a poll failure it recorded, before a row
 * is closed. Stopped FIRST so nothing it records after the check is lost: the
 * close itself re-reads `control_request` in its own UPDATE, so a request
 * landing after this still decides a stopped close (cancel over pause).
 */
async function settleControl(watcher: ControlWatcher): Promise<void> {
  await watcher.stop();
  const failure = watcher.failure();
  if (failure !== null) throw failure;
}

/**
 * The earned spacing the next run of this crawl must read back — the crawl-wide
 * `crawls.host_spacing_ms` AND the per-host `crawls.host_spacing_jsonb` (raw:
 * `HostGate.restore` validates it).
 *
 * A missing row is a defect rather than a null: `runToCompletion` is only ever
 * reached through a crawl whose row this process just wrote or just read, so a
 * row that is gone means something deleted it underneath the run, and a silent
 * "no spacing earned" would be that deletion reported as a politeness fact
 * (hard rule 7).
 *
 * The jsonb is data this engine wrote, but it has been through a column and
 * possibly a schema change, so it is validated rather than trusted (the
 * `parseStoredConfig` precedent) — by `HostGate.restore`, which owns both of its
 * shapes (pre-24a `{host: ms}`, 24a `{host: HostSpacingEntry}`). Null is the
 * honest "no map" — a fresh crawl, or a pre-0015 row; the gate then falls each
 * host back to the crawl-wide number. A present-but-malformed map is not
 * silently dropped: `restore` throws, because a resume that quietly forgot a
 * host's earned spacing would walk back into the pace that host refused (hard
 * rules 7 and 9).
 */
async function storedSpacing(
  db: Db,
  crawlId: string,
): Promise<{ earnedSpacingMs: number | null; hostSpacingJsonb: unknown }> {
  const rows = await db
    .select({ hostSpacingMs: crawls.hostSpacingMs, hostSpacingJsonb: crawls.hostSpacingJsonb })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`crawl ${crawlId}: the crawls row is gone; cannot read its earned spacing`);
  }
  return { earnedSpacingMs: row.hostSpacingMs, hostSpacingJsonb: row.hostSpacingJsonb };
}

/**
 * The pace a crawl runs at under `profile`: the config, with concurrency capped
 * and spacing floored by what the profile applied. A profile only ever slows a
 * crawl down; no profile, or an opted-out one (`applied: null`), is the config.
 */
function pacingOf(
  config: CrawlConfig,
  profile: StoredPlatformProfile | null,
): { maxConcurrency: number; perHostDelayMs: number } {
  const applied = profile?.applied ?? null;
  if (applied === null) {
    return { maxConcurrency: config.maxConcurrency, perHostDelayMs: config.perHostDelayMs };
  }
  return {
    maxConcurrency: Math.min(config.maxConcurrency, applied.maxConcurrency),
    perHostDelayMs: Math.max(config.perHostDelayMs, applied.perHostDelayMs),
  };
}

/**
 * The platform profile an earlier run of this crawl recorded, or null. The two
 * columns are written together (`recordPlatform`), so one set without the
 * other — or a `platform` that disagrees with the profile's — is a row we
 * cannot read a pace out of, and it stops the run (rule 7).
 */
async function storedPlatformProfile(
  db: Db,
  crawlId: string,
): Promise<StoredPlatformProfile | null> {
  const rows = await db
    .select({ platform: crawls.platform, platformProfile: crawls.platformProfile })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`crawl ${crawlId}: the crawls row is gone; cannot read its platform profile`);
  }
  return readStoredPlatform(row.platform, row.platformProfile, crawlId).profile;
}

/**
 * How many candidate URLs `enqueue` gates and looks up in the frontier per
 * round trip. A page's links fit in one; a sitemap's entries are taken this
 * many at a time so they can stop at the cap. The lookup binds the chunk as
 * ONE array parameter, so this is not a parameter-count limit, only a bound on
 * the work done past a full frontier.
 */
const ENQUEUE_LOOKUP_CHUNK = 1_000;

async function runToCompletion(
  db: Db,
  crawlId: string,
  config: CrawlConfig,
  watcher: ControlWatcher,
  testHooks: LoopTestHooks | undefined,
  closer: RunCloser | undefined,
): Promise<CrawlSummary> {
  const allowPrivate = config.allowPrivate === true;
  const listMode = config.mode === "list";
  // Everything below stops on the watcher's signal, never on the caller's
  // directly: the caller's is one of the watcher's inputs (a shutdown).
  const signal = watcher.signal;
  // Phase 27c: what this crawl admits, resolved once. Absent is the default,
  // never "no limit".
  const scope: CrawlScope = { exclude: config.exclude ?? [], include: config.include ?? [] };
  const scoped = scope.exclude.length > 0 || scope.include.length > 0;
  const maxUrlLength = config.maxUrlLength ?? CRAWL_DEFAULTS.maxUrlLength;
  const maxRedirectHops = config.maxRedirectHops ?? CRAWL_DEFAULTS.maxRedirectHops;
  // Phase 27c: the credentials every request builder below is handed. Each
  // decides per request, from that request's own URL, whether to send them.
  const credentials: CredentialTarget | undefined =
    config.credentials === undefined
      ? undefined
      : { siteUrl: config.siteUrl, values: config.credentials };

  // THE PLATFORM PROFILE (Phase 24a §3.1; src/crawl/platform.ts). The first
  // classifiable response — an `ok` HTML page from the crawl's origin — is
  // asked which platform it runs on, from its headers alone. The host probe's
  // responses come first when it runs; otherwise the seed fetch's (or whichever
  // page is the first to answer `ok`, if the seed redirected). One verdict per
  // crawl: once a response has been classified, later ones are not asked.
  //
  // A resume re-enters the profile an earlier run recorded and asks nothing:
  // the pace it applied binds the continuation exactly as earned spacing does.
  // A run that classified a response as "no platform" recorded nothing, so its
  // resume asks again — the same verdict, from a fresh response.
  let activeProfile: StoredPlatformProfile | null = await storedPlatformProfile(db, crawlId);
  let platformDecided = activeProfile !== null;
  /** The platform `result` names, if it is the crawl's one classifiable response. */
  const classifyPlatform = (result: FetchResult): Platform | null => {
    if (platformDecided || !isClassifiableResponse(result, config.siteUrl)) return null;
    platformDecided = true;
    return result.platformHint;
  };
  const recordPlatform = async (record: StoredPlatformProfile): Promise<void> => {
    await db
      .update(crawls)
      .set({ platform: record.platform, platformProfile: record })
      .where(eq(crawls.id, crawlId));
  };

  // INSERTION 1 — the host probe, before discovery. It asks what the site's
  // *other names* do, which is a question the crawl proper can never answer:
  // everything after this line happens under the one spelling the crawl was
  // seeded with, robots.txt included. Four chains, up to five hops each, one
  // at a time and paced by `perHostDelayMs` — robots.txt is not readable yet,
  // so the config delay is the spacing it can honour; see host-probe. On a
  // resume of a profiled crawl that delay is already the profile's floor
  // (`pacingOf`), and on a fresh crawl the hop that names the platform raises
  // the probe's own gate to it for every hop after (the `onResponse` floor).
  //
  // A pause or cancel stops it mid-chain (Phase 27d): the probe rejects with
  // `FetchAbortedError`, records nothing, and the run closes stopped.
  let probePlatform: Platform | null = null;
  if (config.probeHosts !== false) {
    let hostProbe: HostProbeResult;
    try {
      hostProbe = await probeHostVariants(config.siteUrl, {
        userAgent: config.userAgent,
        signal,
        allowPrivate,
        credentials,
        legacyHosts: config.legacyHosts,
        perHostDelayMs: pacingOf(config, activeProfile).perHostDelayMs,
        timeoutMs: FETCH_TIMEOUT_MS,
        onResponse: (result) => {
          if (probePlatform !== null) return undefined;
          probePlatform = classifyPlatform(result);
          if (probePlatform === null) return undefined;
          return pacingOf(config, platformProfileRecord(probePlatform, config, new Date()))
            .perHostDelayMs;
        },
      });
    } catch (error) {
      if (error instanceof FetchAbortedError && signal.aborted) {
        return closeStoppedBeforePages(db, crawlId, watcher, closer);
      }
      throw error;
    }
    // Redirect targets and reasons the site's other spellings answered with:
    // site text, so through the storability boundary (ruling R11).
    await db.update(crawls).set({ hostProbe: storableDeep(hostProbe) }).where(eq(crawls.id, crawlId));
  }
  // Named by the probe: applied before the window and the gate exist, so no
  // worker ever runs at the unclamped pace — nor does discovery's sitemap walk.
  if (probePlatform !== null) {
    activeProfile = platformProfileRecord(probePlatform, config, new Date());
    await recordPlatform(activeProfile);
  }

  // A resume walks the sitemaps again. `sitemap_urls` is keyed, so a re-read
  // lands on the rows the first read wrote. The staging the walk writes —
  // `sitemap_memberships` and `sitemap_hreflang` — stays the earlier walk's
  // until this walk replaces it, and is cleared only then (27d ruling R17): by
  // the sink before its first insert, or below once a walk that staged nothing
  // has returned. A resume that finds robots.txt unreachable walks nothing, so
  // it replaces nothing: the earlier walk's staging stands beside the evidence
  // that counts it (`writeUnreachableRobotsEvidence`).
  //
  // A pause or cancel stops the walk mid-document (Phase 27d): `discover`
  // rejects with `DiscoveryAbortedError`, and the run closes stopped with no
  // discovery evidence and nothing enqueued. A resume walks again from the top.
  //
  // THE INTERRUPTED MARK, WRITTEN AHEAD (rulings R8, R10; 27d final), by
  // `SitemapRowSink.prepare`. From the clear until this run's own evidence is
  // on the row, an earlier run's evidence (on a resume) no longer describes
  // what is staged. So it is marked `interrupted` BEFORE the clear, and the
  // evidence write below replaces the object whole, which drops the key.
  // Whatever ends the run in between — a stop, a failed poll, a failed sink
  // insert, `persistSitemap`, the evidence write itself, or the process dying
  // with no catch or close run at all — leaves the mark on the row, so a
  // `failed` row, which can still be judged, never pairs complete-looking
  // evidence with a partial staging. A fresh crawl has no evidence yet, and
  // the mark matches no row.
  let discovery: DiscoveryResult;
  // When this run's walk began: the stamp every entry it persists carries
  // (`sitemap_urls.seen_at`), so the sweep after the last batch can tell the
  // rows this walk listed from the ones an earlier walk left behind.
  const walkStartedAt = new Date();
  const onSitemapFlush = testHooks?.onSitemapFlush;
  const sitemapSink = new SitemapRowSink(
    db,
    crawlId,
    onSitemapFlush === undefined ? undefined : () => onSitemapFlush(signal),
  );
  try {
    discovery = await discover(config.siteUrl, {
      userAgent: config.userAgent,
      signal,
      allowPrivate,
      credentials,
      // The sitemap walk's own spacing: the crawl's, floored by a profile already
      // known (probe or resume). Robots' Crawl-delay is folded in by discover.
      perHostDelayMs: pacingOf(config, activeProfile).perHostDelayMs,
      // The documents the client named, walked beside the declared ones. The
      // engine still probes nothing on its own (see discover's header).
      extraSitemaps: config.sitemapUrls,
      // List mode reads no sitemap unless the client named one; then the walk is
      // the spider's (declared and supplied), and only the entries' enqueue is
      // skipped below.
      walkSitemaps: config.mode !== "list" || config.sitemapUrls !== undefined,
      sink: sitemapSink,
    });
  } catch (error) {
    if (error instanceof DiscoveryAbortedError && signal.aborted) {
      return closeStoppedBeforePages(db, crawlId, watcher, closer);
    }
    throw error;
  }
  // The walk returned: what it staged replaces the earlier walk's, and a walk
  // that staged nothing (no sitemap declared, every document failed) replaces
  // it with nothing. A no-op when the sink already cleared before its first
  // insert. Not when robots.txt was unreachable: `discover` then walked no
  // sitemap (complete disallow, verified there), so there is nothing to
  // replace the earlier walk's staging with — see the evidence write below.
  if (discovery.robots.outcome !== "unreachable") {
    await sitemapSink.prepare();
  }
  await testHooks?.afterDiscovery?.(signal);
  // A stop that landed as the walk finished — after its last request, before
  // anything below writes evidence or enqueues a URL — closes the run exactly
  // as one inside the walk does. One that lands later is caught between the
  // batches of `persistSitemap` and of the seeding enqueue below, and finally
  // by the page loop's own check before its first lease.
  //
  // A failed control poll is not a stop, and discovery is complete: it is left
  // to the paths below, which raise it beside whatever else they conclude —
  // the robots refusal keeps its note beside it (27b M7), and the page loop
  // stops on the signal and raises it before any close.
  if (signal.aborted && watcher.failure() === null) {
    return closeStoppedBeforePages(db, crawlId, watcher, closer);
  }

  // THE SITEMAP'S ENTRIES, ON RECORD BEFORE THE EVIDENCE THAT COUNTS THEM
  // (Phase 27d). Written in batches, and a stop between two batches closes the
  // run as a stop in the walk does: no evidence goes on the row over a partial
  // `sitemap_urls`, so no reader is shown evidence counting entries the table
  // does not hold. A resume writes them again (the rows are keyed). A failed
  // poll stops it too; the close then raises it and the row closes failed.
  if (!(await persistSitemap(db, crawlId, discovery, signal, testHooks?.onSeedingBatch, walkStartedAt))) {
    return closeStoppedBeforePages(db, crawlId, watcher, closer);
  }

  // INSERTION 2 — discovery's own findings, written before anything branches on
  // them. A crawl that refuses to run because robots.txt is unreachable is
  // exactly the crawl whose discovery evidence a reader most needs.
  //
  // The site's robots.txt text rides in this evidence (`robots.raw`, and the
  // note can quote it), so it passes the storability boundary (ruling R11): a
  // NUL in robots.txt must not fail the crawl before any page is fetched.
  const evidence = storableDeep(discoveryEvidence(discovery, config));
  if (discovery.robots.outcome === "unreachable") {
    await writeUnreachableRobotsEvidence(db, crawlId, evidence, sitemapSink);
  } else {
    await db.update(crawls).set({ discovery: evidence }).where(eq(crawls.id, crawlId));
  }

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
    // THE SAME SENTENCE THE SUMMARY CARRIES, onto the row (migration 0017).
    // This path composes a classified sentence rather than catching an error,
    // so there is nothing to take a first line of: `note` names the outcome,
    // the attempts and the status the host answered with, and it is what the
    // Phase 17 gate could only read in a log.
    //
    // A control poll that ALSO failed is not allowed to replace that sentence
    // (27b): `settleControl` would throw the poll failure alone and the robots
    // note would be lost. Both go up together, as `execute` combines them, and
    // the aggregate's first line — what `execute` writes to `failure_reason` —
    // carries the robots note.
    await watcher.stop();
    const pollFailure = watcher.failure();
    if (pollFailure !== null) {
      throw new AggregateError(
        [new Error(note), pollFailure],
        `crawl ${crawlId} failed: ${note}; and its control poll failed too`,
      );
    }
    const closed = await closeCrawl(db, crawlId, "failed", crawled, null, note, null, closer);
    return summarise(
      db,
      crawlId,
      closed,
      crawled,
      emptyWriterStats(),
      discovery,
      null,
      // The resource pass never ran: this crawl was refused before it had a
      // page, let alone a page's references.
      null,
      // Nor the recheck pass, for the same reason: no page was fetched, so no
      // page answered 5xx, so there is nothing a second look could be about.
      null,
      note,
    );
  }

  const writer = new PageWriter(db, crawlId);
  // The pace in force from the first worker: the config, clamped by a profile
  // the probe (or an earlier run of this crawl) already applied. `min`/`max`
  // against the config again, so a profile can only ever slow a crawl down.
  const { maxConcurrency, perHostDelayMs } = pacingOf(config, activeProfile);
  const window = new CrawlWindow({
    max: maxConcurrency,
    initial: Math.min(WINDOW_INITIAL, maxConcurrency),
  });
  // THE SPACING AN EARLIER RUN OF THIS CRAWL EARNED, read back off the row.
  //
  // Null on every fresh crawl (nothing has written the column yet), so this
  // changes nothing about `runCrawl`. On a resume it is the whole point: the
  // column is a finding — a host refused us and the gate doubled its spacing —
  // and a continuation that rebuilt the gate from `perHostDelayMs` alone would
  // walk straight back into the pace that earned the refusal, then overwrite
  // the evidence with the configured floor on the very first `recordSpacing`
  // below. `HostGate` folds it into the same max as robots' `Crawl-delay`; see
  // `earnedSpacingMs` there for why the policy lives in that module.
  const { earnedSpacingMs, hostSpacingJsonb } = await storedSpacing(db, crawlId);
  const gate = new HostGate({
    perHostDelayMs,
    robotsCrawlDelaySec: discovery.robots.crawlDelaySec,
    earnedSpacingMs,
    onGrant: testHooks?.onGrant,
  });
  // The PER-HOST state beside the crawl-wide number: each host re-enters its own
  // earned spacing — and, since Phase 24a, its place on the ratchet — rather than
  // the widest any host reached (migration 0015). Null on a fresh or pre-0015
  // crawl, when every host falls back to the crawl-wide `earnedSpacingMs`. A
  // column `restore` cannot read stops the run, naming the crawl (rule 7).
  if (hostSpacingJsonb !== null) {
    try {
      gate.restore(hostSpacingJsonb);
    } catch (error) {
      throw new Error(
        `crawl ${crawlId}: stored host_spacing_jsonb cannot be restored: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  /**
   * The spacing, on the crawl row: the crawl-wide `host_spacing_ms` for whoever
   * is polling, and the per-host `host_spacing_jsonb` (`HostGate.snapshot()`:
   * each host's spacing, ratchet state and throttle counters) for whoever
   * resumes.
   *
   * The gate lives in this process and both readers read the database, so a
   * number nobody wrote down is a number they cannot act on — and acting on it
   * is the whole point: a crawl that has quietly escalated to 8s per page looks
   * identical, from `crawl_status`, to one that is merely large; and a resume
   * that could not read the earned spacing back would hit the site at the pace
   * it already refused (hard rule 9). Written once up front (so the crawl-wide
   * column means "the base, so far" rather than "unknown" from the first poll,
   * and the map is `{}` rather than the null a pre-0015 row carries) and then
   * whenever ANY host's spacing MOVES (an escalation, a recovery, a raised
   * floor) — the gate's `spacingGeneration`, not the crawl-wide widest. The
   * throttle counters ride along on those writes; a counter that moves WITHOUT
   * the spacing moving (a `Retry-After` on a response that was not a refusal)
   * waits for the next move or the close write. A hard kill, or a run that
   * fails by throwing (which skips the close write), loses that counter — only
   * evidence, never pace. Both are a handful of writes per crawl, but keying on the
   * widest alone left a rule-9 hole: a non-widest host that a resume seeded from
   * the per-host map (say a CDN that earned 8s while the origin stayed at 1s, now
   * resuming with a NEW host wider than the origin) can escalate WITHOUT moving
   * the widest, so its new spacing would never be re-written, and a hard kill
   * before the close write would leave the resume re-entering it BELOW what it
   * earned — faster than the site allowed. Keying on the generation captures such
   * a host within a batch, restoring the pre-0015 "at most one batch stale" for
   * every host. The wider-crawl-wide-fallback only ever covered a host ABSENT
   * from the map (`spacingMs` → `delayMs`); a host PRESENT at a stale value is
   * seeded at that stale value and does NOT fall back, which is exactly why the
   * write must fire on its move.
   *
   * A final write at close (after the resource pass, which shares this gate and
   * can escalate a third-party host) still lands the complete map on a clean or
   * aborted finish. A hard kill loses only whatever moved since the last WRITE:
   * for a page-crawl host that is at most one batch (the generation checkpoint
   * fires per batch); for the resource pass there is no per-batch checkpoint, so
   * a mid-pass kill loses that whole pass's escalations. Both cases resume the
   * affected host at the crawl-wide fallback or wider — never below — so the
   * loss is politeness slack, never a rule-9 breach. Narrowing the resource-pass
   * window is a Phase 14 pointer.
   *
   * At the batch boundary rather than inside `handleOne`: concurrent handlers
   * would race to write the same value, and one write per batch is enough for a
   * caller polling every 15-30 seconds.
   */
  let reportedSpacingMs = gate.maxSpacingMs();
  let reportedSpacingGen = gate.spacingGeneration();
  const recordSpacing = async (): Promise<void> => {
    await db
      .update(crawls)
      .set({ hostSpacingMs: reportedSpacingMs, hostSpacingJsonb: gate.snapshot() })
      .where(eq(crawls.id, crawlId));
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
  /**
   * THE NEVER-REQUESTED BUDGET (Phase 23 T3, study D1; shared since 27c), kept
   * beside the frontier's and never mixed with it: `blockedRows` counts the
   * page rows this crawl has RECORDED without a request — robots-blocked
   * `disallowed` rows and scope-refused `excluded` rows alike — against
   * `maxBlockedUrls` (default `maxPages`). A counter, not a set — the dedupe is
   * the `pages (crawl_id, url)` unique index's, as the frontier's is its
   * primary key's (hard rule 6).
   *
   * Read off the table on every start rather than assumed zero, so a resume
   * spends what is left of the budget rather than a second one.
   */
  const blockedBudget = config.maxBlockedUrls ?? config.maxPages;

  /**
   * THE RE-FILTER (Phase 27c), both ways. A crawl paused under one scope and
   * resumed under another holds unfetched URLs its scope now refuses — they
   * are re-filed as `excluded` rows (or counted past the budget) and leave the
   * frontier — and `excluded` rows its scope now admits, which go back into
   * the frontier (or, with no room, are deleted and the cap stamped). All of
   * it before the first lease. Run on every start: a fresh crawl has neither
   * and it costs two lookups. Before the frontier counts and the budget count
   * below, so both read what the re-filter left.
   */
  const refiled = await refileOutOfScope(db, crawlId, scope, {
    blockedBudget,
    maxPages: config.maxPages,
    maxUrlLength,
    robots: discovery.robots,
  });
  let blockedRows = await neverRequestedRowCount(db, crawlId);

  const startCounts = await frontierCounts(db, crawlId);
  let pagesCrawled = crawledRows(startCounts);
  // Whether pages were already on record when this run began — the same number,
  // read as a question. `closeCrawl` needs it because the cap-exceeded counter
  // this run accumulates is a DELTA on a resume and the whole count on a fresh
  // crawl; see its docblock for why the difference is not cosmetic.
  const resumed = pagesCrawled > 0;
  let frontierRows =
    startCounts.pending +
    startCounts.leased +
    startCounts.failed +
    crawledRows(startCounts);

  /**
   * Whether the frontier cap has turned a NEW URL away on this crawl —
   * `crawls.frontier_capped` (migration 0023), mirrored here so the hot path
   * never reads it back. Set true by `enqueue` the first time a URL the
   * frontier does not hold finds no room under `maxPages`, and stamped on the
   * crawl row then, once.
   *
   * It exists for the case `pagesCrawled >= maxPages` cannot see: a crawl the
   * residual reservation race (see `enqueue`) left short of its cap with
   * nothing pending. That crawl's link graph is partial, and `links.orphan`
   * reads this flag to say so instead of reporting the gap as orphans (hard
   * rule 7).
   *
   * A fresh crawl stamps false before its first enqueue, so false is a
   * measurement. A resume reads what the row holds: true stays true, and the
   * null of a crawl first run before 0023 stays null unless this run meets the
   * cap — the `robots_blocked_dropped` rule for a column nobody filled.
   */
  let frontierCapped: boolean | null;
  if (resumed) {
    const [capRow] = await db
      .select({ frontierCapped: crawls.frontierCapped })
      .from(crawls)
      .where(eq(crawls.id, crawlId));
    if (capRow === undefined) throw new Error(`runToCompletion: no crawls row for ${crawlId}`);
    frontierCapped = capRow.frontierCapped;
  } else {
    await db.update(crawls).set({ frontierCapped: false }).where(eq(crawls.id, crawlId));
    frontierCapped = false;
  }
  // The re-filter turned a re-admitted URL away for want of room: the cap's
  // meaning exactly. It stamped the row in its transaction; a fresh crawl's
  // stamp above has just overwritten that, so it is stamped again here.
  if (refiled.unroomed > 0 && frontierCapped !== true) {
    frontierCapped = true;
    await db.update(crawls).set({ frontierCapped: true }).where(eq(crawls.id, crawlId));
  }

  /**
   * The two overflow columns are stamped 0 on a crawl that holds no pages yet —
   * the row then says "counted, nothing turned away" rather than the null a
   * pre-0020 (robots) or pre-0036 (excluded) crawl carries. A resume adds to
   * whatever is there, and `null + n` stays null in SQL: a crawl whose first
   * run predates the column never acquires a partial count that reads like a
   * whole one (`resource_refs_capped_pages`' rule). The re-filter's overflow is
   * added after the stamp, so a fresh row counts it too.
   */
  if (!resumed) {
    await db
      .update(crawls)
      .set({ robotsBlockedDropped: 0, excludedDropped: 0 })
      .where(eq(crawls.id, crawlId));
  }
  if (refiled.dropped > 0) {
    await db
      .update(crawls)
      .set({ excludedDropped: sql`${crawls.excludedDropped} + ${refiled.dropped}` })
      .where(eq(crawls.id, crawlId));
  }

  /**
   * Record URLs the crawl will never request — robots-blocked (`kind:
   * "robots"`) or scope-refused (`"excluded"`): a page row each while the
   * shared budget lasts, a count on the crawl row past it, in the column that
   * names the cause. Never a request (the caller has already decided), and
   * never a frontier row.
   *
   * `refused` is one `enqueue` call's distinct candidates, url -> the
   * `fetch_reason` it is recorded with — bounded by the call (one page's
   * links, the analyzer caps them at 2,000), never by the crawl.
   *
   * A URL ALREADY ON RECORD is neither a new row nor a drop: a site whose every
   * page links to `/cart` has one `/cart` row, and the thousandth page's link to
   * it must not read as "turned away" once the budget is full. One indexed
   * lookup per call answers that; it is SQL, not a set of seen URLs.
   *
   * The budget is RESERVED in one synchronous step after that lookup — the
   * check and the increment with no `await` between them — for the frontier's
   * reason: up to `maxConcurrency` handlers are in here at once, and the two
   * kinds spend ONE counter. The count is then corrected downwards by however
   * many rows the conflict dropped (a sibling handler recorded the same URL a
   * moment earlier). What that race can still do, and it is stated rather than
   * hidden: when the budget is full, two handlers that both met a URL neither
   * had seen recorded may count it twice, and one that a sibling recorded in
   * the same instant may be counted as turned away. The dropped columns are
   * counts of discoveries turned away, documented as such (src/db/schema.ts),
   * and never claimed as distinct URLs.
   */
  const recordNeverRequested = async (
    kind: "robots" | "excluded",
    refused: ReadonlyMap<string, string>,
    depth: number,
    discoveredVia: DiscoveredVia,
  ): Promise<void> => {
    const candidates = [...refused.keys()];
    const known = await db.execute<{ url: string }>(sql`
      select url from pages
      where crawl_id = ${crawlId} and url = any(${sql.param(candidates)}::text[])`);
    const onRecord = new Set(known.rows.map((row) => row.url));
    const fresh = candidates.filter((url) => !onRecord.has(url));
    if (fresh.length === 0) return;

    // Reserve. Synchronous with the check — see the docblock.
    const take = Math.min(Math.max(0, blockedBudget - blockedRows), fresh.length);
    blockedRows += take;
    const overflow = fresh.length - take;

    if (take > 0) {
      const rows = fresh.slice(0, take).map((url) => {
        const reason = refused.get(url);
        if (reason === undefined) {
          throw new Error(`recordNeverRequested: ${url} lost its ${kind} reason`);
        }
        return { item: { url, depth, discoveredVia }, reason };
      });
      const inserted =
        kind === "robots"
          ? await writer.insertRobotsBlocked(rows)
          : await writer.insertExcluded(rows);
      blockedRows -= take - inserted;
    }
    if (overflow > 0) {
      await db
        .update(crawls)
        .set(
          kind === "robots"
            ? { robotsBlockedDropped: sql`${crawls.robotsBlockedDropped} + ${overflow}` }
            : { excludedDropped: sql`${crawls.excludedDropped} + ${overflow}` },
        )
        .where(eq(crawls.id, crawlId));
    }
  };

  /**
   * Enqueue candidates that pass every gate, never letting the frontier grow
   * past `maxPages` rows. The cap is on rows *ever inserted*, so a hub page
   * with 5000 links cannot turn a 100-page crawl into a 5000-row table.
   *
   * ROOM IS RESERVED ONLY FOR URLS THE FRONTIER DOES NOT ALREADY HOLD. Before
   * reserving, one indexed lookup on `(crawl_id, url)` asks which of the
   * candidates are queued already — a question put to the database, never to a
   * set of seen URLs in memory (hard rules 3 and 6). Every page on a real site
   * opens with the same site-wide nav, whose targets are always known; when
   * room was reserved per candidate before that was known, the nav took the
   * last of the room near the cap, the cap check tripped, and the page's
   * genuinely new links behind it were skipped. The room came back after the
   * insert, but those links were gone, and every later page did the same: a
   * capped crawl froze short of `maxPages` with nothing pending, and read as a
   * complete crawl of a smaller site (hard rule 7 — the gate crawl of
   * lavishalice at maxPages 600 ended at 554 with 3,475 followable targets
   * never queued). Candidates repeated within one call are collapsed here for
   * the same reason: a page linking one new URL twice must not spend two slots.
   *
   * `frontierRows` is *reserved* as each unknown candidate is accepted, not
   * compared once at the top: up to `maxConcurrency` calls of this function are
   * in flight at any moment, and a check-then-insert separated by an `await`
   * would let every one of them spend the same remaining room. The check and
   * the increment sit in one synchronous step — no `await` between them — so
   * the frontier can never pass `maxPages`, even with sixteen handlers
   * interleaving.
   *
   * THE RESIDUAL RACE. The lookup is a snapshot: two calls in flight together
   * can both find the same new URL unknown and both reserve a slot for it. One
   * insert wins; the other's `(crawl_id, url)` conflict drops the row, and the
   * correction after the insert gives that slot back. While both reservations
   * stand, the frontier counts one row more than it will hold, so at the exact
   * cap a third call can find no room and skip a new URL it would have had
   * room for. That is bounded twice over: the over-count is at most the URLs
   * new to more than one of the `maxConcurrency` in-flight calls at the same
   * instant, and it lasts only until the losing insert returns — after which
   * any later page that offers a new URL fills the slot. It errs in the safe
   * direction (never past `maxPages`), and it can only leave the crawl short if
   * no page fetched after that instant offers a single URL the frontier does
   * not hold, which on a site larger than the cap is the exception rather than
   * the rule it used to be. A URL found KNOWN cannot be wrong later: frontier
   * rows are never deleted while the crawl runs.
   *
   * What the race can still do, then, is end a crawl below `maxPages` with
   * nothing pending — which `pagesCrawled >= maxPages` would read as a crawl
   * that reached every page. It is made visible rather than argued away: the
   * first time a URL the frontier does not hold meets a full frontier, the
   * crawl row is stamped `frontier_capped = true`, and `links.orphan` treats
   * that crawl as capped whatever its page count.
   *
   * Candidates are taken in chunks of `ENQUEUE_LOOKUP_CHUNK`, one lookup per
   * chunk. A page's links fit one chunk, so a link enqueue is one lookup; the
   * chunking is for the sitemap, whose entries (up to the discovery cap) stop
   * at the first chunk that fills the frontier, as they always stopped at the
   * cap, instead of being gated and looked up in full.
   *
   * A candidate robots.txt disallows is NOT enqueued — it is never fetched —
   * and since Phase 23 T3 it is not dropped either: it is collected with the
   * line that blocked it and recorded by `recordNeverRequested`, against its own
   * budget. A candidate the crawl's scope refuses (Phase 27c) takes the same
   * path one step earlier, as an `excluded` row on the same budget. That is why a full frontier no longer ends the scan early for a
   * page's links (a blocked link past the frontier cap is still a fact), while
   * the sitemap's entries, which are never recorded as blocked rows, still stop
   * at the cap as they always did.
   */
  const enqueue = async (
    urls: readonly string[],
    depth: number,
    // The frontier's closed vocabulary rather than a string: the agent surface
    // filters `pages` by this value against `DISCOVERED_VIA`, so a fifth kind
    // of discovery has to be declared there before it can be enqueued here.
    discoveredVia: DiscoveredVia,
    // The chain length a redirect target carries (Deviation 12); 0 for every
    // other kind of discovery. A URL the frontier already holds keeps its own.
    redirectHops = 0,
  ): Promise<void> => {
    // Sitemap entries robots.txt disallows are on record in `sitemap_urls` and
    // reported by `robots.blocks-sitemap-urls`; see `CrawlConfig.maxBlockedUrls`.
    // Entries the scope refuses are skipped for the same reason (Deviation 8).
    const recordsBlocked = discoveredVia !== "sitemap";
    // The run's seeding, which a resume repeats (see the chunk loop).
    const seeding = discoveredVia === "sitemap" || discoveredVia === "list";
    // The seed is the API's to check against the scope (a seed the scope
    // refuses is a validation error before the row exists); here it is the
    // crawl's starting point, and refusing it would be an empty crawl.
    const checksScope = scoped && discoveredVia !== "seed";
    // The crawl's own URL length limit, on the same terms: below the index's
    // ceiling it is this crawl's decision, so it is a row, not a silence
    // (rule 7). The seed is left to `fetchPage`, which refuses it as a
    // `disallowed` row naming the limit.
    const checksLength = discoveredVia !== "seed";
    // A full frontier is only taken at its word once the cap is on record: until
    // then the candidates are looked up, so that a new URL turned away stamps
    // `frontier_capped` rather than vanishing unrecorded.
    if (frontierRows >= config.maxPages && frontierCapped === true && !recordsBlocked) return;

    const items: EnqueueItem[] = [];
    // Every URL this call has already judged, so a repeat is neither reserved
    // twice nor recorded twice. Distinct within the call, bounded by it.
    const seen = new Set<string>();
    // url -> the `fetch_reason` it will be recorded with. Distinct within the
    // call, bounded by it.
    const blocked = new Map<string, string>();
    // url -> the scope's reason, on `blocked`'s terms.
    const excluded = new Map<string, string>();
    // Whether this call is the one that met the cap first (see below).
    let stampCapped = false;
    for (let start = 0; start < urls.length; start += ENQUEUE_LOOKUP_CHUNK) {
      // THE SEEDING STOPS ON A STOP (Phase 27d, ruling R9): between two chunks
      // of the sitemap's entries or the listed URLs, a pause or cancel ends the
      // scan, what is reserved so far is inserted below, and the page loop's
      // first check closes the run. A resume enqueues them all again. A page's
      // links never stop here: that page's row is written, and a link cut off
      // now would never be offered to the frontier again.
      if (seeding) {
        if (start > 0) await testHooks?.onSeedingBatch?.("frontier", signal);
        if (signal.aborted) break;
      }
      // The sitemap stops at the cap; a page's links are scanned to the end
      // for the robots-blocked ones (see the docblock).
      if (frontierRows >= config.maxPages && frontierCapped === true && !recordsBlocked) break;

      const candidates: string[] = [];
      for (const raw of urls.slice(start, start + ENQUEUE_LOOKUP_CHUNK)) {
        // normalizeUrl is the single frontier-key authority (url-utils). Links
        // arrive already normalised from the analyzer; the seed and sitemap
        // entries do not, and running it twice is idempotent.
        const url = normalizeUrl(raw);
        if (url === null || seen.has(url)) continue;
        seen.add(url);
        if (!isSameOrigin(url, config.siteUrl)) continue; // external: linked, never fetched
        // Rule 5 first, for every candidate — a blocked row is recorded only
        // for a URL the policy would have let us fetch; robots.txt is then the
        // reason no fetch follows.
        // Asked at the index's own ceiling, not the crawl's limit, so a URL only
        // `maxUrlLength` refuses can be told apart below and recorded. Over the
        // ceiling it is url-policy's `too_long`, with no row, as it always was.
        const verdict = await isUrlAllowed(url, { allowPrivate });
        if (!verdict.allowed) continue;
        if (checksLength && url.length > maxUrlLength) {
          if (recordsBlocked) {
            excluded.set(
              url,
              `${EXCLUDED_REASON_PREFIX}longer than maxUrlLength (${url.length} characters; ` +
                `the limit is ${maxUrlLength})`,
            );
          }
          continue;
        }
        // The crawl's scope (Phase 27c), after the policy and BEFORE robots: a
        // URL the agent fenced off is the agent's decision whatever robots.txt
        // says, and its row names the pattern rather than a Disallow line.
        if (checksScope) {
          const inScope = scopeVerdict(url, scope);
          if (!inScope.admitted) {
            if (recordsBlocked) excluded.set(url, inScope.reason);
            continue;
          }
        }
        // isSameOrigin admits www<->apex and http->https spellings, and the
        // robots wrapper judges those by the same rules (RobotsInfo.isAllowed):
        // a variant spelling is never a way around Disallow.
        if (!discovery.robots.isAllowed(url)) {
          if (recordsBlocked) {
            // The line that decided, quoted from the robots.txt this crawl
            // read. A disallow with no line behind it would be a row that
            // cannot say why it was never requested — our defect, and loud
            // (rule 7).
            const line = discovery.robots.matchingRule(url);
            if (line === null) {
              throw new Error(
                `enqueue: robots.txt disallows ${url} but names no line that decided it ` +
                  `(robots outcome '${discovery.robots.outcome}')`,
              );
            }
            blocked.set(url, robotsBlockedReason(line));
          }
          continue;
        }
        candidates.push(url);
      }
      // Nothing new can be reserved into a full frontier, so once the cap is on
      // record it is not asked.
      if (candidates.length === 0) continue;
      if (frontierRows >= config.maxPages && frontierCapped === true) continue;

      // Which of them the frontier already holds: one indexed lookup on the
      // `(crawl_id, url)` primary key. They cost no room.
      const known = await db.execute<{ url: string }>(sql`
        select url from frontier
        where crawl_id = ${crawlId} and url = any(${sql.param(candidates)}::text[])`);
      const queued = new Set(known.rows.map((row) => row.url));

      // Reserve, for the unknown ones only. Synchronous from the check to the
      // increment — no `await` in this loop — which is what makes the cap hold
      // across concurrent handlers.
      for (const url of candidates) {
        if (queued.has(url)) continue;
        if (frontierRows >= config.maxPages) {
          // A new URL turned away. Flipped here, in the synchronous step, so
          // exactly one call stamps the row.
          if (frontierCapped !== true) {
            frontierCapped = true;
            stampCapped = true;
          }
          break;
        }
        frontierRows += 1;
        items.push({ url, depth, discoveredVia, redirectHops });
      }
    }
    if (stampCapped) {
      await db.update(crawls).set({ frontierCapped: true }).where(eq(crawls.id, crawlId));
    }
    if (items.length > 0) {
      // A throw here leaves the reservation standing, which is the safe
      // direction: the crawl is on its way out, and over-counting the frontier
      // can only stop work early, never run past maxPages.
      const inserted = await enqueueUrls(db, crawlId, items);
      // The residual race's correction: a URL another call inserted between
      // our lookup and our insert was dropped by the conflict, and its slot is
      // returned here (see the docblock).
      frontierRows -= items.length - inserted;
    }
    // After the frontier: the URLs that will be fetched are queued before the
    // ones that never will be are written down.
    if (excluded.size > 0) {
      await recordNeverRequested("excluded", excluded, depth, discoveredVia);
    }
    if (blocked.size > 0) await recordNeverRequested("robots", blocked, depth, discoveredVia);
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

  /**
   * THE MID-CRAWL CLAMP'S TWO HALVES THE GATE CANNOT DELIVER (Phase 24a fix
   * round 1). A profile learned off the seed fetch lands while the rest of its
   * batch is already inside `handleOne`: some siblings are sleeping in
   * `gate.acquire` on a slot claimed at the OLD spacing, and the window's new
   * size only binds the NEXT batch. Left alone, those siblings would fire at
   * the old pace and several at once — exactly what the profile exists to stop.
   *
   *  - `platformEpoch` moves once, when the clamp lands. A handler that wakes
   *    from `acquire` and sees it moved gives the slot up and claims again at
   *    the new spacing.
   *  - `sending` counts requests between their slot claim and their response.
   *    A handler waits for it to drop below `window.maxSize()` before it claims
   *    a slot at all, so after a clamp to 1 there is never a second request on
   *    the wire, whatever the batch held. Before a clamp `maxSize()` is at least
   *    the batch size, so the wait never binds and nothing changes.
   *
   * WHY HERE AND NOT IN `HostGate.acquire`. `acquire`'s contract is one claim
   * per call — the slot it fixes is the slot it returns at — and the ratchet's
   * timing, its tests and the resource pass all rest on that (see the
   * `report` docblock on what "the next acquisition" means). Making it
   * re-claim on every spacing change would quietly change escalation too, a
   * behaviour Task 1 settled. The profile is a one-off, crawl-level event the
   * loop owns, so the loop re-claims; the gate stays the gate.
   */
  let platformEpoch = 0;
  let sending = 0;

  /** Wait for the window to have room on the wire, or for the crawl to abort. */
  const claimSend = async (host: string): Promise<boolean> => {
    for (;;) {
      while (sending >= window.maxSize()) {
        if (signal?.aborted === true) return false;
        await sleep(ADMIT_POLL_MS);
      }
      const epoch = platformEpoch;
      sending += 1;
      // Claimed immediately before a fetch we are certainly going to issue —
      // acquiring earlier would burn the host's slot on work we then skip.
      // The crawl's signal wakes the wait (Phase 27b, Ruling 2): a stop must
      // not sit out a queue of slots under a long spacing. An aborted claim is
      // not a slot; the wire goes back and nothing is sent.
      if (!(await gate.acquire(host, signal))) {
        sending -= 1;
        return false;
      }
      if (platformEpoch === epoch) return true;
      // The profile landed while we slept on a slot claimed at the old pace:
      // that slot is void. Give the wire back and claim at the new one.
      sending -= 1;
    }
  };

  /** Fetch, parse, persist and enqueue one leased URL. */
  const handleOne = async (
    item: LeasedUrl,
  ): Promise<{ outcome: BatchOutcome | null; persisted: boolean }> => {
    if (!(await admit())) return { outcome: null, persisted: false };
    const host = new URL(item.url).host;
    try {
      if (!(await claimSend(host))) return { outcome: null, persisted: false };
      let result: FetchResult;
      try {
        result = await fetchPage(item.url, {
          userAgent: config.userAgent,
          allowPrivate,
          maxUrlLength,
          credentials,
          timeoutMs: FETCH_TIMEOUT_MS,
          // A pause or cancel reaches the request on the wire (Phase 27b).
          signal,
        });
      } catch (error) {
        // THE CRAWL STOPPED, NOT THE SITE. An aborted fetch learned nothing
        // about the URL, so nothing is written: no page row, no failed
        // frontier row. Its row stays leased and the shutdown below returns it
        // to pending with the attempt refunded, so the resume asks it afresh.
        if (error instanceof FetchAbortedError) return { outcome: null, persisted: false };
        throw error;
      } finally {
        // Off the wire the moment the response is in: parsing and persisting
        // are ours, not the site's.
        sending -= 1;
      }

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

      // The platform, if this is the crawl's first classifiable response and
      // the probe did not already answer the question. Workers are running, so
      // the clamp lands mid-crawl: synchronously, before anything else awaits,
      // so every LATER admission sees it — the next batch is leased at the new
      // window and the next gate acquisition at the new base. Requests already
      // SENT finish at the old settings — nothing can recall them — and
      // `appliedAt` says when it changed. Siblings still waiting on a slot do
      // NOT: the epoch voids their slot and `sending` holds them to the new
      // window (see `claimSend`).
      const detected = classifyPlatform(result);
      if (detected !== null) {
        const record = platformProfileRecord(detected, config, new Date());
        if (record.applied !== null) {
          window.clampMax(record.applied.maxConcurrency);
          gate.raiseBase(record.applied.perHostDelayMs);
          platformEpoch += 1;
        }
        await recordPlatform(record);
      }

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
      await writer.addPage(
        item,
        settledResult(result, item, gate.spacingMs(host), maxRedirectHops, config.siteUrl),
        analysis,
        { complete: !RETRYABLE.has(result.fetchClass) },
      );

      // List mode records a page's links (the writer above) and follows none.
      if (analysis !== null && !listMode && item.depth < config.maxDepth) {
        await enqueue(
          analysis.links.map((link) => link.href),
          item.depth + 1,
          "link",
        );
      }
      // Same depth: a redirect is one URL wearing two names, not a step further
      // into the site. `redirectUrl` is null when the target was policy-refused
      // (fetch-page drops it and says why in `disallowedReason`).
      //
      // The redirect cap (Deviation 12): the target is queued one hop further
      // down this chain, unless that is past the cap — then the row written
      // above says so (`settledResult`) and the chain stops here.
      if (
        result.fetchClass === "redirect" &&
        result.redirectUrl !== null &&
        item.redirectHops + 1 <= maxRedirectHops
      ) {
        await enqueue([result.redirectUrl], item.depth, "redirect", item.redirectHops + 1);
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
    if (listMode) {
      // The listed URLs, in position order, a chunk at a time (rule 6). A
      // resume reads them again: enqueue is idempotent on the frontier and the
      // pages table, so a URL already fetched is not queued twice.
      let read = 0;
      for (let after = -1; ; ) {
        // A stop between chunks ends the read (Phase 27d): see `enqueue`.
        if (signal?.aborted === true) break;
        const chunk = await db
          .select({ position: listUrls.position, url: listUrls.url })
          .from(listUrls)
          .where(and(eq(listUrls.crawlId, crawlId), gt(listUrls.position, after)))
          .orderBy(asc(listUrls.position))
          .limit(ENQUEUE_LOOKUP_CHUNK);
        if (chunk.length === 0) break;
        read += chunk.length;
        await enqueue(
          chunk.map((row) => row.url),
          0,
          "list",
        );
        after = chunk[chunk.length - 1]!.position;
      }
      // The table must hold what the start promised, before a page is leased:
      // a short or missing list would otherwise run as a short crawl whose
      // "nothing to crawl" note blames robots.txt (27c final wave M8; rule 7).
      // A read a stop cut short is not that: the run closes stopped, and its
      // resume reads the list again from the start.
      if (signal?.aborted !== true && read !== config.listUrlCount) {
        throw new Error(
          `crawl ${crawlId}: read ${read} list_urls rows, but its config.listUrlCount ` +
            `is ${String(config.listUrlCount)}; the listed URLs are not what the crawl's ` +
            "start stored, so it is refused rather than run on part of its list",
        );
      }
    } else {
      await enqueue([config.siteUrl], 0, "seed");
      await enqueue(
        discovery.sitemapEntries.map((entry) => entry.url),
        0,
        "sitemap",
      );
    }
    // (`sitemap_urls` was written before the evidence, above.)

    if (frontierRows === 0) {
      // A crawl with nothing in its frontier is about to report zero pages.
      // Say why, so "the site is empty" and "robots or the URL policy
      // refused the only URLs we had" do not look identical (rule 7).
      seedNote = listMode
        ? "nothing to crawl: every listed URL was refused by robots.txt, the URL policy, " +
          "the crawl scope, or the same-origin boundary"
        : "nothing to crawl: the seed URL and every sitemap entry were refused " +
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
      // Any host's spacing moving triggers the write, not only the crawl-wide
      // widest: a non-widest in-map host must not be left stale for a resume to
      // re-enter too fast (see the recordSpacing docblock, and spacingGeneration).
      if (gate.spacingGeneration() !== reportedSpacingGen) {
        reportedSpacingGen = gate.spacingGeneration();
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
    // With the attempt refunded: every row still leased here was never
    // fetched to an answer (an abort in admit, in the send wait, or on the
    // wire), so it must not come back one attempt closer to `failed`.
    await releaseLeases(db, crawlId, workerId, { refundAttempt: true });
  } catch (error) {
    failures.push(error);
  }
  // A control poll that failed is what stopped the loop, and it ends the run
  // `failed` with that error, never `paused` (rule 7).
  const controlFailure = watcher.failure();
  if (controlFailure !== null) failures.push(controlFailure);

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
  //
  // A STOP DURING THE PROBE (27d) aborts its request and is not a failure of
  // it: the run closes stopped, as a stop in the page loop does (the probe
  // recorded as not run, the recheck and resource passes skipped), and a
  // resume probes. A failed control poll also fires the signal; it is raised
  // here, before any "crawl stopped" record, as the page loop raises it above,
  // and the row closes failed.
  let probeStopped = false;
  try {
    probeStopped =
      (await probeKnownMissing(db, crawlId, config, discovery, gate, {
        allowPrivate,
        credentials,
        pagesCrawled,
        aborted,
        signal,
      })) === "aborted";
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
  if (probeStopped) {
    const pollFailure = watcher.failure();
    if (pollFailure !== null) throw pollFailure;
    await writeNotFoundProbe(db, crawlId, { skipped: STOPPED_BEFORE_404_PROBE });
    aborted = true;
  }

  // INSERTION 3c — the crawl takes a SECOND look at every page that answered
  // "server error", so a finding can say whether the error persists rather than
  // only that it happened once (P17; docs/superpowers/specs/2026-09-08-5xx-
  // recheck-design.md) — and, since Phase 23, at every page that gave no
  // response at all (`timeout`, `network_error`; `RECHECK_CLASSES`). Lettered like 3b, for 3b's reason: the markers are
  // positional and INSERTION 4 is cited by name elsewhere.
  //
  // WHY HERE, between the known-404 probe and the resource pass:
  //
  //  - IT IS A PAGE-PHASE QUESTION, and it belongs with the phase it reasons
  //    about — the same argument that puts the 404 probe after the loop: one
  //    more request to the ORIGIN, about the pages we just fetched.
  //  - BEFORE THE RESOURCE PASS, because running after it would measure a
  //    server we have just spent an hour loading. "The site was under our load"
  //    is the confound this pass exists to rule out, so the second observation
  //    is taken before we spend R more requests on the origin's images. It is
  //    also why the pass cannot be an endpoint an agent calls later: TIME IS THE
  //    MEASUREMENT, and a recheck run days afterwards is measuring a different
  //    site while stamping its answer on a crawl whose findings claim to
  //    describe one moment.
  //
  // Skipped on an abort exactly as the resource pass is, and for the same
  // reason: every row it would write costs somebody's server a request. The
  // rows it leaves keep both nulls, which is the resume's work list unchanged.
  //
  // NOT CONTAINED, on the resource pass's grounds rather than the probe's: this
  // pass classifies every site-side failure into a row, so anything it throws is
  // our defect or a failed write, and there is no column in which to write "the
  // recheck columns are missing because the writer broke".
  //
  // It costs up to 60 seconds of wall time on a crawl that saw a 5xx and
  // nothing at all on one that did not (`MIN_RECHECK_GAP_MS`, paid once across
  // the whole oldest-first walk, and the work list is empty on a healthy site).
  const recheckPass = aborted
    ? null
    : await recheckServerErrors(db, crawlId, {
        userAgent: config.userAgent,
        // THE SAME GATE the pages were fetched through — not a new one — so a
        // host that earned 8s of spacing keeps it, and a 503 on recheck
        // escalates it for the resource pass below (hard rule 9).
        gate,
        // Already read by `discover`. The work list is this crawl's own pages,
        // so the origin's rules are the only rules in play.
        robots: discovery.robots,
        timeoutMs: FETCH_TIMEOUT_MS,
        allowPrivate,
        credentials,
        // TEST ONLY, and spread rather than passed so ABSENT stays absent: the
        // pass's own default is `MIN_RECHECK_GAP_MS`, and a `minGapMs:
        // undefined` must reach it as "nobody said" rather than as a value. See
        // the field's docblock on `CrawlConfig` — it is stripped from the stored
        // row exactly as `allowPrivate` is, and refused over the API.
        ...(config.recheckMinGapMs === undefined
          ? {}
          : { minGapMs: config.recheckMinGapMs }),
        signal,
      });

  if (recheckPass !== null) {
    // The count is stamped WHATEVER happened — an aborted pass says what it
    // actually did — while the time is stamped only by a pass that COMPLETED.
    // That asymmetry is the whole reason both columns exist: a 0 count reads
    // the same on "rechecked nothing" and "nobody looked", and the null time
    // beside it is what tells them apart (see the schema comments).
    await db
      .update(crawls)
      .set({
        recheckPassCount: recheckPass.rechecked,
        ...(recheckPass.aborted ? {} : { recheckPassAt: new Date() }),
      })
      .where(eq(crawls.id, crawlId));
  }
  // Folded in BEFORE the resource pass reads it: an abort that landed inside the
  // recheck means the caller has asked us to stop talking to this site, and the
  // resource pass is the next thing that would.
  if (recheckPass?.aborted === true) aborted = true;

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
  //
  // THE OPERATOR'S OFF SWITCH sits beside the abort and reads the same way from
  // here — no pass, `resources: null` on the summary — and differently from
  // everywhere else. An abort decided nothing about the rows it did not reach;
  // `fetchResources: false` decided all of them, so the rows are stamped with
  // the reason instead of being left blank (see `RESOURCE_OFF_REASON`). The
  // check is `=== false` rather than falsy, because absent means ON.
  if (config.fetchResources === false && !aborted) {
    await markResourcesNotAsked(db, crawlId);
  }
  const resourcePass = aborted || config.fetchResources === false
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
        credentials,
        signal,
      });

  // The pass stops asking the moment the signal fires, so a crawl that was
  // stopped inside it must close stopped (paused or cancelled), with the note
  // and with the frontier's own account of what is left — never `finished`
  // over a resource census it does not have.
  if (resourcePass?.aborted === true || signal?.aborted === true) aborted = true;
  const outcome = aborted ? "stopped" : "finished";

  // The final earned-spacing write, after the resource pass (which shares this
  // gate and may have escalated a third-party host). The crawl-wide number is
  // re-read from the gate so a resource-pass escalation shows on `crawl_status`,
  // and the per-host map lands complete: a per-host escalation that never moved
  // the crawl-wide widest was not captured at a batch boundary, and this is
  // where a resume reads it (`HostGate.restore`). One write, once, on the way
  // out — the same rarity the in-loop guard keeps.
  reportedSpacingMs = gate.maxSpacingMs();
  await recordSpacing();

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

  // The watcher is stopped before the close, and a failed poll is raised
  // rather than closed over. A stopped close reads WHY off the row itself
  // (`closeCrawl`), so a request that lands after this still decides it.
  await settleControl(watcher);
  const closed = await closeCrawl(
    db,
    crawlId,
    outcome,
    pagesCrawled,
    { delta: writer.stats().resourceRefsCappedPages, resumed },
    null,
    outcome === "stopped" ? watcher.stopReason() : null,
    closer,
  );
  return summarise(
    db,
    crawlId,
    closed,
    pagesCrawled,
    writer.stats(),
    discovery,
    pageTemplates,
    resourcePass,
    recheckPass,
    outcome === "stopped" ? stoppedNote(closed) : seedNote,
  );
}

/**
 * The discovery evidence of a run that found robots.txt unreachable (27d
 * ruling R17). That run walked no sitemap (`discover`: complete disallow), so
 * it staged nothing and replaces nothing.
 *
 *  - A crawl that already holds evidence — a resume of a walked crawl — keeps
 *    the walk's keys (`suppliedSitemaps`, `truncation` with any `interrupted`
 *    mark, `docsFetched`, `sitemapFacts`, `sitemapsRead`): they still describe
 *    the staging the earlier walk left, which stands. The keys robots.txt
 *    itself decides come from THIS read (controller ruling R5): `robots`, and
 *    `sitemapSources` — the `Sitemap:` lines the file declared, which an
 *    unreachable file declared none of. Keeping the earlier file's lines beside
 *    an `unreachable` outcome would have `robots_get` say this read declared
 *    them.
 *  - A crawl with none gets this run's evidence whole, as a fresh crawl always
 *    has. Its staging is cleared first (`prepare`; the mark matches no row):
 *    rows on it can only be a walk stopped before it wrote evidence, and the
 *    whole evidence counts none, so no reader pairs the two.
 */
async function writeUnreachableRobotsEvidence(
  db: Db,
  crawlId: string,
  evidence: DiscoveryEvidence,
  sink: SitemapRowSink,
): Promise<void> {
  const merged = await db
    .update(crawls)
    .set({
      // The robots-derived keys only; the walk's keys stand (see above).
      discovery: sql`${crawls.discovery} || jsonb_build_object(
        'robots', ${JSON.stringify(evidence.robots)}::jsonb,
        'sitemapSources', ${JSON.stringify(evidence.sitemapSources)}::jsonb
      )`,
    })
    .where(and(eq(crawls.id, crawlId), isNotNull(crawls.discovery)))
    .returning({ id: crawls.id });
  if (merged.length === 1) return;
  await sink.prepare();
  await db.update(crawls).set({ discovery: evidence }).where(eq(crawls.id, crawlId));
}

/**
 * Mark the discovery evidence an EARLIER run of this crawl kept as
 * `truncation.interrupted` (rulings R8, R10). Written AHEAD, just before this
 * run clears the staged sitemap memberships and alternates for its re-walk
 * (`SitemapRowSink.prepare`, the one caller): from then until
 * its own evidence is written, the kept evidence no longer describes what is
 * staged, and a run that ends in between — however, a crash included — leaves
 * the mark. The hreflang absence rules refuse on it and the marker names it,
 * until a complete walk rewrites the evidence (which drops the key). A crawl
 * with no evidence yet — a fresh one — has nothing to mark: the update matches
 * no row. Idempotent.
 */
export async function markEvidenceInterrupted(db: Db, crawlId: string): Promise<void> {
  await db
    .update(crawls)
    .set({
      discovery: sql`jsonb_set(${crawls.discovery}, '{truncation}', coalesce(${crawls.discovery}->'truncation', '{}'::jsonb) || '{"interrupted": true}'::jsonb)`,
    })
    .where(and(eq(crawls.id, crawlId), isNotNull(crawls.discovery)));
}

/**
 * Close a run that was stopped before its page loop (Phase 27d): in the host
 * probe, in the sitemap walk, as discovery returned, or while `sitemap_urls`
 * was being written. It makes the page loop's stopped close — the control
 * settled (a failed poll is raised, and `execute` closes the row failed), the
 * known-404 probe recorded as skipped, then one `closeCrawl('stopped')` whose
 * UPDATE reads the request off the row — less everything that never ran: no
 * discovery evidence is written and nothing is enqueued, so the summary's
 * discovery fields are null, and no writer counted, so the cap-exceeded column
 * is left alone (`refsCapped: null`).
 *
 * ONE ORDER DIFFERS, deliberately: the control is settled BEFORE the 404 skip
 * is written, where the page loop writes the skip first and raises a poll
 * failure before it. Settling first is what keeps a failed poll from leaving
 * a "crawl stopped" sentence on a row that then closes `failed`; the page loop
 * gets the same guarantee from raising the poll failure ahead of its probe.
 *
 * A stop after the run cleared the staged sitemap memberships and alternates
 * finds evidence an EARLIER run kept already marked `interrupted`:
 * `SitemapRowSink.prepare` writes the mark ahead of the clear (rulings R8,
 * R10), so this close has nothing to add. A stop before the walk cleared
 * anything finds the earlier evidence and staging still a matched pair.
 *
 * The page count is the frontier's, as the robots refusal's is: a resume
 * stopped here keeps what its earlier runs crawled.
 */
async function closeStoppedBeforePages(
  db: Db,
  crawlId: string,
  watcher: ControlWatcher,
  closer: RunCloser | undefined,
): Promise<CrawlSummary> {
  await settleControl(watcher);
  await writeNotFoundProbe(db, crawlId, { skipped: STOPPED_BEFORE_404_PROBE });
  const crawled = crawledRows(await frontierCounts(db, crawlId));
  const closed = await closeCrawl(db, crawlId, "stopped", crawled, null, null, watcher.stopReason(), closer);
  return summarise(
    db,
    crawlId,
    closed,
    crawled,
    emptyWriterStats(),
    null,
    null,
    null,
    null,
    stoppedNote(closed),
  );
}

/**
 * The summary's sentence for a stopped run, from the frontier as the close
 * left it. A function of the counts because `summarise` reads them once.
 */
function stoppedNote(closed: ClosedAs): (frontier: FrontierCounts) => string {
  return (frontier) => {
    if (closed.status === "cancelled") {
      return `cancelled; ${frontier.pending} URL(s) were never fetched`;
    }
    if (closed.status === "paused" && closed.pauseReason !== null) {
      return `paused (${closed.pauseReason}); the frontier still holds ${frontier.pending} pending URL(s)`;
    }
    throw new Error(
      `stoppedNote: a stopped close came back '${closed.status}' with pause reason ` +
        `${String(closed.pauseReason)}`,
    );
  };
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
 * What goes in `crawls.failure_reason`: the message's FIRST LINE, trimmed.
 *
 * EXPORTED, AND THE ONLY ONE. Both writers of the column reach a failed row
 * through a thrown value — the loop's `execute` below, and the API queue
 * runner's catch (`src/api/service.ts`) — and they had a copy of this each.
 * Two copies of "what a served sentence may be" is two places for the rule to
 * drift; the API imports this one. It lives here because this module is the
 * column's first writer and the API already imports from it, so there is no
 * cycle to pay for.
 *
 * The `pages.render_error` precedent, and deliberately the same one: an
 * engine-originated diagnostic string, first line only, no stack frames. The
 * stack is still logged by whoever catches the error — this is the sentence,
 * not the trace, and a column that carried a trace would put one on the wire
 * (docs/talos-surface.md §9, obligation 6).
 *
 * A MESSAGE WITH NOTHING IN IT IS A SENTENCE ABOUT THAT, never a throw. This
 * is called from inside the recovery path that closes the row `failed`, so a
 * throw here would abandon the close and leave the row `running` for ever —
 * the exact lie this module exists to prevent, produced by the guard meant to
 * keep the column honest. A dependency that throws `new Error("")` is still a
 * defect of ours; naming it in the column is how it gets seen (hard rule 7),
 * and the row closes either way.
 */
export function failureReasonOf(error: unknown): string {
  // A thrown `null` or `undefined` stringifies to "null"/"undefined", which is
  // a non-empty string and would sail past the check below as if it were a
  // reason. It is not one: it is the same defect as an empty message.
  const message = error === null || error === undefined ? "" : messageOf(error);
  const first = (message.split("\n")[0] ?? message).trim();
  if (first === "") return `the crawl threw a ${thrownKind(error)} with no message`;
  return first;
}

/** What was thrown, for the sentence above: a class name where there is one. */
function thrownKind(error: unknown): string {
  if (error === null) return "null";
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
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
    sitemapFacts: discovery.sitemapFacts,
    sitemapsRead: discovery.sitemapsRead,
  };
}

/**
 * The known-404 probe's record on a stopped run — written by the page loop's
 * stopped close (`probeKnownMissing`) and by a stop in the host probe or the
 * sitemap walk (`closeStoppedBeforePages`) alike.
 */
const STOPPED_BEFORE_404_PROBE = "crawl stopped (paused or cancelled) before the known-404 probe";

async function writeNotFoundProbe(
  db: Db,
  crawlId: string,
  probe: NotFoundProbeEvidence,
): Promise<void> {
  // The site's answer to a missing URL (status, reason, location): site text,
  // so through the storability boundary (ruling R11).
  await db
    .update(crawls)
    .set({ notfoundProbe: storableDeep(probe) })
    .where(eq(crawls.id, crawlId));
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
 *
 * Answers `"aborted"`, having written nothing, when `opts.signal` fires while
 * the probe waits for its slot or is on the wire (27d): the caller records the
 * stop, or raises the failed poll that fired it.
 */
async function probeKnownMissing(
  db: Db,
  crawlId: string,
  config: CrawlConfig,
  discovery: DiscoveryResult,
  gate: HostGate,
  opts: {
    allowPrivate: boolean;
    credentials: CredentialTarget | undefined;
    pagesCrawled: number;
    aborted: boolean;
    signal: AbortSignal;
  },
): Promise<"recorded" | "aborted"> {
  if (opts.aborted) {
    // The crawl was told to stop (paused or cancelled). Issuing another
    // request would be the one thing a stop is meant to prevent; a resume will
    // take the sample.
    await writeNotFoundProbe(db, crawlId, { skipped: STOPPED_BEFORE_404_PROBE });
    return "recorded";
  }
  if (opts.pagesCrawled === 0) {
    await writeNotFoundProbe(db, crawlId, {
      skipped: "no pages crawled: nothing to compare a 404 template against",
    });
    return "recorded";
  }

  const probeUrl = `${new URL(config.siteUrl).origin}/__ariadne-404-probe-${randomUUID()}`;
  if (!discovery.robots.isAllowed(probeUrl)) {
    await writeNotFoundProbe(db, crawlId, {
      skipped: `robots.txt disallows the probe path (${probeUrl})`,
    });
    return "recorded";
  }

  // A stop wakes the slot wait and aborts the request on the wire (27d): the
  // probe is a request to the site like any other, and a stop is honoured in
  // whatever phase it lands. Nothing is written for it here; the caller decides
  // what the stop means (a stopped close, or a failed poll raised).
  if (!(await gate.acquire(new URL(probeUrl).host, opts.signal))) return "aborted";
  let result: FetchResult;
  try {
    result = await fetchPage(probeUrl, {
      userAgent: config.userAgent,
      allowPrivate: opts.allowPrivate,
      credentials: opts.credentials,
      maxUrlLength: config.maxUrlLength ?? CRAWL_DEFAULTS.maxUrlLength,
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: opts.signal,
    });
  } catch (error) {
    if (error instanceof FetchAbortedError && opts.signal.aborted) return "aborted";
    throw error;
  }
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
  return "recorded";
}

/**
 * The result as it should be RECORDED, which is not always the result as it was
 * fetched.
 *
 * Two cases. The second (Phase 27c) is a redirect whose target would be one
 * hop past `maxRedirectHops`: the row keeps the target in `redirect_url`, and
 * its reason says why nothing was queued behind it.
 *
 * The first: a block whose retries are spent. `fetch_class: 'blocked'`
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
  maxRedirectHops: number,
  siteUrl: string,
): FetchResult {
  // A redirect whose target would be one hop past the cap (Phase 27c): the
  // target is not queued, and the row is the one place that can say why. Not
  // a cross-origin target: `enqueue` would never have queued it, so the cap
  // is not why it was not followed.
  if (
    result.fetchClass === "redirect" &&
    result.redirectUrl !== null &&
    item.redirectHops + 1 > maxRedirectHops &&
    isSameOrigin(result.redirectUrl, siteUrl)
  ) {
    const capped =
      `redirect not followed: this URL is ${item.redirectHops} redirect` +
      `${item.redirectHops === 1 ? "" : "s"} into its chain and maxRedirectHops is ` +
      `${maxRedirectHops}`;
    return {
      ...result,
      disallowedReason:
        result.disallowedReason === null ? capped : `${result.disallowedReason}; ${capped}`,
    };
  }
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
    resourceRefsCappedPages: 0,
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
  // The run's stop signal (Phase 27d), asked before every batch: true when
  // every entry was written, false when a stop came first.
  signal: AbortSignal,
  onBatch: LoopTestHooks["onSeedingBatch"],
  // When this run's walk began. Each entry is stamped with it, and the rows an
  // earlier walk wrote that this one did not list (`seen_at` older) are removed
  // after the last batch (Phase 28b: a site that dropped a URL no longer lists it).
  walkStartedAt: Date,
): Promise<boolean> {
  const entries = discovery.sitemapEntries;
  for (let i = 0; i < entries.length; i += SITEMAP_BATCH) {
    if (signal.aborted) return false;
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
        seenAt: walkStartedAt,
      };
    });
    // discover() dedupes by URL, so a conflict here means a resume re-reading
    // the same sitemap: the first read's row stands and is re-stamped with this
    // walk's start, which keeps the sweep below from removing it. `lastmod` is
    // the sitemap's own text, so the batch passes the storability boundary
    // (ruling R10).
    await db
      .insert(sitemapUrls)
      .values(storableDeep(batch))
      .onConflictDoUpdate({
        target: [sitemapUrls.crawlId, sitemapUrls.url],
        set: { seenAt: walkStartedAt },
      });
    await onBatch?.("sitemap_urls", signal);
  }
  // Only a persist that wrote every batch gets here (a stop returned above), and
  // only a walk that read something: robots.txt unreachable walks nothing, so its
  // empty entry list says nothing about what the site lists and the earlier
  // walk's rows stand beside its kept evidence.
  if (discovery.robots.outcome !== "unreachable") {
    await db
      .delete(sitemapUrls)
      .where(and(eq(sitemapUrls.crawlId, crawlId), lt(sitemapUrls.seenAt, walkStartedAt)));
  }
  return true;
}

/**
 * The crawl's `SitemapSink` (Phase 26c): discovery's memberships into
 * `sitemap_memberships`, its alternates into `sitemap_hreflang`, written while
 * the walk runs. The calls only buffer; `flush`, which the sitemap stream awaits
 * after every chunk, writes everything buffered in batches of SITEMAP_BATCH, so
 * the buffers never outgrow a chunk's entries (hard rule 6).
 *
 * Each row carries its URL twice, as `sitemap_urls` does: as the site wrote it
 * and through `normalizeUrl`, the spelling a join to `pages` needs. Discovery
 * has measured both against the index limit and policy-checked the URL, so one
 * that will not normalise is this engine's defect and throws (hard rule 7).
 *
 * A membership is keyed on (crawl, URL, document): a URL one document lists
 * twice is one row (`onConflictDoNothing`). A staged alternate is not keyed —
 * two documents may state the same pair — and is the sitemap's own text (the
 * `hreflang` attribute), so both batches cross the storability boundary.
 *
 * Exported for scripts/probe-sitemap-50mb.ts, which measures `discover` with
 * the sink the crawl uses rather than a stand-in.
 */
export class SitemapRowSink implements SitemapSink {
  private readonly memberships: (typeof sitemapMemberships.$inferInsert)[] = [];
  private readonly alternates: (typeof sitemapHreflang.$inferInsert)[] = [];
  /** The one clear of this crawl's earlier staging; see `prepare`. */
  private prepared: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly crawlId: string,
    /** TEST ONLY: `LoopTestHooks.onSitemapFlush`, awaited after each flush. */
    private readonly onFlush?: () => Promise<void>,
  ) {}

  private normalised(url: string): string {
    const normalised = normalizeUrl(url);
    if (normalised === null) {
      throw new Error(`SitemapRowSink: cannot normalise sitemap URL ${url}`);
    }
    return normalised;
  }

  membership(url: string, source: string): void {
    this.memberships.push({
      crawlId: this.crawlId,
      url,
      urlNormalised: this.normalised(url),
      sitemapSource: source,
    });
  }

  alternate(url: string, a: { hreflang: string; href: string }, source: string): void {
    this.alternates.push({
      crawlId: this.crawlId,
      url,
      urlNormalised: this.normalised(url),
      hreflangCode: a.hreflang,
      targetUrl: a.href,
      sitemapSource: source,
    });
  }

  /**
   * Clear the staging an earlier walk of this crawl left, so that what this
   * walk stages replaces it (27d ruling R17). Idempotent: the first call does
   * the work, and every later call awaits that same work.
   *
   * WRITE-AHEAD ORDER (rulings R8, R10; 27d final F4): the earlier run's
   * evidence is marked `interrupted` FIRST, and only then are this crawl's
   * `sitemap_hreflang` and `sitemap_memberships` rows deleted. A run that ends
   * anywhere after the mark — a crash included — leaves it, until the run's
   * own evidence replaces the object. A fresh crawl has no evidence, and the
   * mark matches no row.
   *
   * Called by `flush` (so before its first insert), and by the crawl once a walk
   * has returned (a walk may stage nothing). A robots.txt that was unreachable
   * walks nothing and so replaces nothing: then it is called only on a row with
   * no evidence (`writeUnreachableRobotsEvidence`).
   */
  prepare(): Promise<void> {
    this.prepared ??= (async () => {
      await markEvidenceInterrupted(this.db, this.crawlId);
      await this.db.delete(sitemapHreflang).where(eq(sitemapHreflang.crawlId, this.crawlId));
      await this.db.delete(sitemapMemberships).where(eq(sitemapMemberships.crawlId, this.crawlId));
    })();
    return this.prepared;
  }

  async flush(): Promise<void> {
    // On every flush, buffered rows or not: the first flush is where the walk
    // starts writing its staging (a document's first chunk may carry no row),
    // and the `onFlush` observer sees the clear done. Only a walk that reaches
    // a sitemap document flushes — never one refused by robots.txt.
    await this.prepare();
    while (this.memberships.length > 0) {
      const batch = this.memberships.splice(0, SITEMAP_BATCH);
      await this.db.insert(sitemapMemberships).values(storableDeep(batch)).onConflictDoNothing();
    }
    while (this.alternates.length > 0) {
      const batch = this.alternates.splice(0, SITEMAP_BATCH);
      await this.db.insert(sitemapHreflang).values(storableDeep(batch));
    }
    await this.onFlush?.();
  }
}

/**
 * How many never-requested page rows this crawl already holds — robots-blocked
 * and scope-excluded alike, the starting point of the budget they share
 * (`CrawlConfig.maxBlockedUrls`), read once per run so a resume spends what is
 * left rather than a second budget. The robots half is the predicate
 * `ROBOTS_BLOCKED` (src/rules/helpers.ts) spells: the class AND the robots
 * reason, so a url-policy refusal is not counted against robots.txt.
 */
async function neverRequestedRowCount(
  db: Pick<Db, "execute">,
  crawlId: string,
): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pages
    where crawl_id = ${crawlId}
      and (
        fetch_class = 'excluded'
        or (fetch_class = 'disallowed'
          and starts_with(coalesce(fetch_reason, ''), ${ROBOTS_BLOCKED_REASON_PREFIX})))`);
  const n = res.rows[0]?.n;
  if (typeof n !== "number") {
    throw new Error(`neverRequestedRowCount: count came back as ${typeof n}, not a number`);
  }
  return n;
}

/** Rows the re-filter reads, writes and deletes per round trip. */
const REFILE_CHUNK_ROWS = 500;

/**
 * What the re-filter needs besides the scope (`refileOutOfScope`).
 */
export interface RefileLimits {
  /**
   * The shared never-requested budget, WHOLE (`maxBlockedUrls`, default
   * `maxPages`). The forward pass spends what the rows on record leave of it,
   * counted inside the transaction after the backward pass.
   */
  blockedBudget: number;
  /** `CrawlConfig.maxPages`: the frontier cap a re-admitted URL must fit under. */
  maxPages: number;
  /** The crawl's URL length limit: an `excluded` row longer than it stays. */
  maxUrlLength: number;
  /**
   * robots.txt as this run read it. A URL the scope now admits and robots
   * disallows is never queued (rule 9): its row becomes the robots-blocked row
   * admission would have written.
   */
  robots: Pick<RobotsInfo, "isAllowed" | "matchingRule" | "outcome">;
}

export interface RefileResult {
  /** Leasable frontier URLs the scope refuses, written as `excluded` rows. */
  refiled: number;
  /** The same, past the budget: retired and counted, never written. */
  dropped: number;
  /** `excluded` rows the scope now admits, back in the frontier as pending. */
  readmitted: number;
  /** `excluded` rows the scope now admits and robots.txt disallows, re-classed. */
  reblocked: number;
  /** `excluded` rows the scope now admits with no frontier room: row deleted. */
  unroomed: number;
}

/**
 * LEASABLE, in `leaseBatch`'s own words (src/crawl/frontier.ts): pending, or
 * leased by a worker whose lease has run out. A dead worker's expired leases
 * survive a pause (the pause returns only its own worker's), and they are
 * leased again the moment a run starts, so they are re-filtered with the
 * pending ones. `now()` is the transaction's start, so the select and the
 * deletes read one instant.
 */
const LEASABLE = sql`(frontier.state = 'pending' or (frontier.state = 'leased' and frontier.leased_until < now()))`;

/**
 * THE RE-FILTER (Phase 27c), run on every start before the first lease, BOTH
 * WAYS, so the crawl's records match the scope it runs under now — not the one
 * a URL was first judged by.
 *
 * THE ORDER IS BACKWARD, THEN FORWARD (27c final wave M4). The backward pass
 * deletes `excluded` rows, which frees never-requested budget, so the forward
 * pass measures its budget after it, in the same transaction; and the backward
 * pass's frontier room already leaves out the rows the forward pass is about
 * to retire, so neither pass is short of what the other frees.
 *
 * FORWARD — every LEASABLE frontier URL the scope refuses leaves the frontier.
 * Each becomes an `excluded` page row — the one admission would have written,
 * through `PageWriter.insertExcluded`, its reason from `scopeVerdict` — while
 * `limits.blockedBudget` minus the never-requested rows on record (counted
 * after the backward pass) lasts; the rest are counted in `dropped`, which the caller
 * adds to `crawls.excluded_dropped`. A URL that already has a page row is
 * retired without a row or a count, on admission's terms. Skipped for an empty
 * scope, which refuses nothing.
 *
 * BACKWARD — every `excluded` row the scope now ADMITS (a pattern removed or
 * widened while paused; an empty scope admits them all) is undone, because
 * otherwise the URL is re-fetched only if some page links it again, and then
 * the fetch is lost to the `pages (crawl_id, url)` conflict behind the stale
 * row. Not a row longer than `maxUrlLength`: that refusal is the length, not a
 * pattern, and the limit does not change. Each such row, in order:
 *  - robots.txt disallows it: re-classed as the robots-blocked row admission
 *    would write (`disallowed`, the matching line) — never queued (rule 9),
 *    and budget-neutral (the two kinds share one budget);
 *  - the frontier has room under `maxPages` (rows ever inserted, as `enqueue`
 *    counts them): back in the frontier, pending, at its depth and discovery
 *    kind with `redirect_hops` 0, and its row deleted;
 *  - no room: its row deleted, and `crawls.frontier_capped` stamped true — the
 *    cap turned a URL away, which is that column's existing meaning.
 *
 * THE SELECTION IS SQL — `scopeRefusesSql`, the one SQL form of the patterns,
 * pinned to the matcher by the parity test in test/crawl/url-scope.test.ts
 * (Ruling P1) — and rows are read, written and deleted in chunks of
 * `REFILE_CHUNK_ROWS`, locked as they are read, so memory is bounded by the
 * chunk and never by the crawl (hard rule 6). The page rows are shaped in
 * TypeScript rather than by an `INSERT … SELECT`, deliberately (controller
 * ruling, fix round 1): `page_type` (`derivePageType`), the per-pattern reason
 * and the ~80 columns `pageRow` fills have one author.
 *
 * ONE TRANSACTION, so a crash leaves the frontier and the rows as they were or
 * as they end, never a URL in both or in neither. A row the SQL refuses and
 * `scopeVerdict` admits means the two forms disagree — our defect, and it
 * throws rather than guessing which one is right (hard rule 7).
 *
 * Exported for test/crawl/scope-admission.test.ts.
 */
export async function refileOutOfScope(
  db: Db,
  crawlId: string,
  scope: CrawlScope,
  limits: RefileLimits,
): Promise<RefileResult> {
  const { blockedBudget, maxPages, maxUrlLength, robots } = limits;
  if (!Number.isInteger(blockedBudget) || blockedBudget < 0) {
    throw new RangeError(
      `refileOutOfScope: blockedBudget must be an integer ≥ 0, got ${blockedBudget}`,
    );
  }
  const writer = new PageWriter(db, crawlId);
  return db.transaction(async (tx) => {
    const result: RefileResult = {
      refiled: 0,
      dropped: 0,
      readmitted: 0,
      reblocked: 0,
      unroomed: 0,
    };

    // The scope's refusal of a frontier row, in SQL (`false` for an empty scope).
    const refuses = scopeRefusesSql(sql`frontier.url`, scope);

    // ---- Backward: `excluded` rows the scope now admits.
    // The room is what the frontier holds once the forward pass below has
    // retired every leasable URL the scope refuses (both its branches delete
    // the frontier row), so the backward pass is not short of room the
    // forward pass is about to free.
    const held = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from frontier
      where crawl_id = ${crawlId} and not (${LEASABLE} and ${refuses})`);
    const frontierRows = held.rows[0]?.n;
    if (typeof frontierRows !== "number") {
      throw new Error(`refileOutOfScope: count came back as ${typeof frontierRows}, not a number`);
    }
    let room = Math.max(0, maxPages - frontierRows);
    const admits = sql`not ${scopeRefusesSql(sql`pages.url`, scope)}
      and char_length(pages.url) <= ${maxUrlLength}`;
    for (;;) {
      const chunk = await tx.execute<{
        id: string;
        url: string;
        depth: number;
        discovered_via: string;
      }>(sql`
        select id, url, depth, discovered_via from pages
        where crawl_id = ${crawlId} and fetch_class = 'excluded' and ${admits}
        order by depth asc, url asc
        limit ${REFILE_CHUNK_ROWS}
        for update`);
      if (chunk.rows.length === 0) break;
      const readmit: { id: string; url: string; depth: number; discoveredVia: string }[] = [];
      const reblock: { id: string; reason: string }[] = [];
      const unroom: string[] = [];
      for (const row of chunk.rows) {
        if (!robots.isAllowed(row.url)) {
          const line = robots.matchingRule(row.url);
          if (line === null) {
            throw new Error(
              `refileOutOfScope: robots.txt disallows ${row.url} but names no line that ` +
                `decided it (robots outcome '${robots.outcome}')`,
            );
          }
          // Through the storability boundary admission's robots row passes
          // (`insertNeverRequested`'s `storableDeep`): the line is the site's
          // text and may hold a U+0000 Postgres refuses (27c final wave M2).
          reblock.push({ id: row.id, reason: storableCap(robotsBlockedReason(line)) });
        } else if (room > 0) {
          room -= 1;
          readmit.push({
            id: row.id,
            url: row.url,
            depth: Number(row.depth),
            discoveredVia: row.discovered_via,
          });
        } else {
          unroom.push(row.id);
        }
      }
      if (readmit.length > 0) {
        const inserted = await tx
          .insert(frontier)
          .values(
            readmit.map((r) => ({
              crawlId,
              url: r.url,
              depth: r.depth,
              discoveredVia: r.discoveredVia,
              redirectHops: 0,
            })),
          )
          .onConflictDoNothing({ target: [frontier.crawlId, frontier.url] })
          .returning({ url: frontier.url });
        // A URL the frontier already held cost no room.
        room += readmit.length - inserted.length;
        result.readmitted += inserted.length;
      }
      const deleted = [...readmit.map((r) => r.id), ...unroom];
      if (deleted.length > 0) {
        await tx.execute(sql`
          delete from pages
          where crawl_id = ${crawlId} and id = any(${sql.param(deleted)}::text[])`);
      }
      if (reblock.length > 0) {
        await tx.execute(sql`
          update pages set fetch_class = 'disallowed', fetch_reason = v.reason
          from unnest(
            ${sql.param(reblock.map((r) => r.id))}::text[],
            ${sql.param(reblock.map((r) => r.reason))}::text[]) as v(id, reason)
          where pages.crawl_id = ${crawlId} and pages.id = v.id`);
        result.reblocked += reblock.length;
      }
      result.unroomed += unroom.length;
    }

    // ---- Forward: the frontier's leasable URLs the scope refuses.
    // Its budget is measured HERE, after the backward pass, so rows that pass
    // deleted (re-admitted, or turned away for room) are budget it may spend
    // (27c final wave M4).
    if (scope.exclude.length > 0 || scope.include.length > 0) {
      let left = Math.max(0, blockedBudget - (await neverRequestedRowCount(tx, crawlId)));
      while (left > 0) {
        const chunk = await tx.execute<{ url: string; depth: number; discovered_via: string }>(sql`
          select url, depth, discovered_via from frontier
          where crawl_id = ${crawlId} and ${LEASABLE} and ${refuses}
          order by depth asc, discovered_at asc, url asc
          limit ${Math.min(REFILE_CHUNK_ROWS, left)}
          for update`);
        if (chunk.rows.length === 0) break;
        const rows = chunk.rows.map((row) => {
          const verdict = scopeVerdict(row.url, scope);
          if (verdict.admitted) {
            throw new Error(
              `refileOutOfScope: crawl ${crawlId}: the SQL form of the scope refuses ${row.url} ` +
                `and scopeVerdict admits it; the two forms disagree`,
            );
          }
          return {
            item: { url: row.url, depth: Number(row.depth), discoveredVia: row.discovered_via },
            reason: verdict.reason,
          };
        });
        const inserted = await writer.insertExcluded(rows, tx);
        // The same predicate as the read, so it deletes exactly what was read
        // (the rows are locked; `leaseBatch` skips locked rows).
        await tx.execute(sql`
          delete from frontier
          where crawl_id = ${crawlId} and ${LEASABLE}
            and url = any(${sql.param(rows.map((r) => r.item.url))}::text[])`);
        result.refiled += inserted;
        // Only rows that landed spend the budget: one already on record did not.
        left -= inserted;
      }
      // Past the budget: retired and counted, a URL already on record excepted.
      const rest = await tx.execute<{ n: number }>(sql`
        with gone as (
          delete from frontier
          where crawl_id = ${crawlId} and ${LEASABLE} and ${refuses}
          returning url)
        select count(*)::int as n from gone
        where not exists (
          select 1 from pages where pages.crawl_id = ${crawlId} and pages.url = gone.url)`);
      const dropped = rest.rows[0]?.n;
      if (typeof dropped !== "number") {
        throw new Error(`refileOutOfScope: count came back as ${typeof dropped}, not a number`);
      }
      result.dropped = dropped;
    }

    if (result.unroomed > 0) {
      await tx.update(crawls).set({ frontierCapped: true }).where(eq(crawls.id, crawlId));
    }
    return result;
  });
}

/**
 * Close the row: the terminal status, the finish time, the page count — and,
 * when this process ran pages, the cap-exceeded count beside them.
 *
 * ## The three outcomes (Phase 27b)
 *
 * `finished` and `failed` are the status they name. `stopped` is a run that
 * stopped short on its control signal, and the row ITSELF says which status
 * that is, in one `UPDATE … RETURNING`:
 *
 *  - `control_request = 'cancel'` → `cancelled`, `cancelled_at = now()`;
 *  - `control_request = 'pause'`  → `paused`, `pause_reason = 'request'`;
 *  - no request (the process's shutdown signal) → `paused`, `'shutdown'`.
 *
 * Read off the column in the same statement rather than from the watcher's
 * last poll, so a cancel that lands while the loop winds down still wins
 * (cancel > pause request > pause shutdown). The one case it does not cover is
 * a watcher that RECORDED a request over a column that no longer says so (a
 * cancel over anything but 'cancel', a pause over neither 'pause' nor
 * 'cancel') — impossible today, since only a close clears the column — and
 * that is a throw (the UPDATE is conditioned on it, so nothing is written),
 * never a guess.
 *
 * Every outcome clears `control_request`, and sets `pause_reason` and
 * `cancelled_at` to agree with the status (the 27b column contract:
 * `pause_reason` non-null exactly when `paused`, `cancelled_at` only when
 * `cancelled`, `control_request` only while `running`). A request that arrives
 * after the run has done its work is answered by `finished` (Deviation 12).
 *
 * ## `refsCapped`, and why it is optional
 *
 * `crawls.resource_refs_capped_pages` counts the pages whose analyzer dropped a
 * resource reference at `MAX_RESOURCE_REFS` (migration 0014). The counter lives
 * on `PageWriter` because that is where the pages go past — the alternative,
 * deriving it from `page_resources`, is O(edges) and was measured at 73 ms on a
 * 500,000-edge crawl against a `crawl_status` whose other reads are ≤ 3 ms
 * (docs/gates/phase-11.md §10.1). This is where the counter is stamped.
 *
 * It is optional because `execute`'s failure path closes rows it has no writer
 * for: a crawl that died anywhere in `runToCompletion` is closed from the
 * FRONTIER's numbers, and the process holding the counter is the thing that just
 * failed. Passing `null` LEAVES THE COLUMN ALONE, which is the honest outcome —
 * nobody counted, and the null says exactly that. Writing 0 there would report a
 * measurement no one took (hard rule 7).
 *
 * ## The resume arithmetic, and the null that has to survive it
 *
 * `delta` is what THIS run's writer saw, so a resume must ADD rather than
 * overwrite: its writer only ever met the pages this run fetched, and the
 * earlier run's truncated pages are still truncated. The addition is done in
 * SQL, not in TypeScript, for one property — `null + n` is null in SQL. A crawl
 * whose first run predates this column has no count, and a resume must not turn
 * that honest null into a partial number that reads like a whole one.
 *
 * A fresh crawl assigns instead of adding: its writer saw every page, the
 * column is null before it, and `null + n` would leave a crawl that DID count
 * looking uncounted.
 *
 * THE TWO RULES COMPOSE INTO A PERMANENT NULL, and it is the honest outcome
 * rather than an oversight. A crawl that persisted pages and then died before
 * ANY close leaves the column null (this function was never reached, or was
 * reached through `execute`'s catch with no writer); a later resume sees pages
 * on record, so it adds — and `null + n` is null. That crawl answers "we do not
 * know" for ever. It is the only answer available: the dead run's truncated
 * pages were counted in a process that is gone, nothing in the tables can
 * reconstruct them, and stamping the resume's own count would publish a partial
 * number in a field a reader takes for a whole one (hard rule 7). A fresh crawl
 * is what produces a number.
 *
 * ## `failureReason`, and why it is CHECKED rather than defaulted
 *
 * `crawls.failure_reason` (migration 0017) holds one sentence saying why a
 * `failed` row is failed. The column's contract is an implication —
 * `failure_reason IS NOT NULL` ⟹ `status = 'failed'` — and this function is
 * where it is enforced, in both directions, as a throw:
 *
 *  - a `failed` close with NO reason would put a row on the wire that says
 *    "something went wrong" and refuses to say what, which is the exact defect
 *    0017 exists to remove;
 *  - a NON-`failed` close WITH one would file a sentence about a failure under
 *    a `finished` status, where every reader would misread it.
 *
 * Neither is a caller's mistake to absorb quietly (hard rule 7), and neither is
 * reachable from this module today — the check is here so the NEXT close path
 * cannot forget.
 *
 * The write is unconditional in the other direction: a non-`failed` close sets
 * the column to NULL rather than leaving it alone, so a resume that finishes a
 * crawl an earlier run failed does not leave the earlier run's sentence
 * standing under a `finished` status.
 */
async function closeCrawl(
  db: Db,
  crawlId: string,
  outcome: "finished" | "stopped" | "failed",
  pagesCrawled: number,
  refsCapped: { delta: number; resumed: boolean } | null = null,
  failureReason: string | null = null,
  stop: StopReason | null = null,
  closer: RunCloser | undefined = undefined,
): Promise<ClosedAs> {
  if (closer === undefined || (closer.onClose === undefined && closer.owner === undefined)) {
    return closeCrawlOn(db, crawlId, outcome, pagesCrawled, refsCapped, failureReason, stop);
  }
  const { onClose, owner } = closer;
  // The close and whatever the caller records with it (the job runner's
  // settle, `ResumeOpts.onClose`) commit together or not at all — and, with
  // an owner, only while the run still owns the crawl (`ResumeOpts.owner`),
  // checked under the crawl row's lock and then the job row's.
  return db.transaction(async (tx) => {
    if (owner !== undefined) await requireCloseOwnership(tx, crawlId, owner);
    const closed = await closeCrawlOn(tx, crawlId, outcome, pagesCrawled, refsCapped, failureReason, stop);
    if (onClose !== undefined) {
      await onClose(tx, {
        status: closed.status,
        pauseReason: closed.pauseReason,
        failureReason: failureReason === null ? null : storableCap(failureReason),
      });
    }
    return closed;
  });
}

/** What a run's closes do beside their write: `ResumeOpts.onClose` and `ResumeOpts.owner`. */
interface RunCloser {
  onClose?: CloseHook;
  owner?: RunOwner;
}

/**
 * The crawl row's status, locked `FOR NO KEY UPDATE` — the first lock of the
 * crawl → job order (`ResumeOpts.owner`).
 *
 * NOT `FOR UPDATE` (28b T4b fix round 1): inserting a job takes `FOR KEY
 * SHARE` on its crawl row (the foreign key), and `FOR UPDATE` conflicts with
 * it while `FOR NO KEY UPDATE` does not. A synchronous render that adopts a
 * dead render job locks that job row, then inserts its own (key share on the
 * crawl); a writer holding the crawl `FOR UPDATE` and waiting for the job row
 * would close a cycle (40P01). `FOR NO KEY UPDATE` still excludes every other
 * writer of the crawl row — each `UPDATE crawls` takes it, and the reaper, the
 * claim and the closes all lock with it.
 */
async function lockCrawlStatus(tx: CloseTx, crawlId: string): Promise<string> {
  const [row] = await tx
    .select({ status: crawls.status })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .for("no key update");
  if (row === undefined) throw new Error(`resumeCrawl: no crawl ${crawlId}`);
  return row.status;
}

/**
 * Whether a run still owns its crawl, read as the start claim reads it: the
 * crawl row locked (`lockCrawlStatus`), then the job row (`ownsJob`). For a
 * runner's own writes outside the loop (src/worker/crawl-job.ts: the
 * `credentials_unreadable` pause, a close of a run that threw before the
 * loop), in the transaction that makes them. `status` is null for a crawl
 * that no longer exists.
 */
export async function lockRunOwnership(
  tx: CloseTx,
  crawlId: string,
  owner: RunOwner,
): Promise<{ status: string | null; owned: boolean }> {
  const [row] = await tx
    .select({ status: crawls.status })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .for("no key update");
  if (row === undefined) return { status: null, owned: false };
  return { status: row.status, owned: await ownsJob(tx, owner) };
}

/** Whether the run's job is still `running` under its instance, the job row locked. */
async function ownsJob(tx: CloseTx, owner: RunOwner): Promise<boolean> {
  const [job] = await tx
    .select({ status: jobs.status, claimedBy: jobs.claimedBy })
    .from(jobs)
    .where(eq(jobs.id, owner.jobId))
    .for("update");
  return job !== undefined && job.status === "running" && job.claimedBy === owner.instanceId;
}

/**
 * A close of a run with an owner (`ResumeOpts.owner`): written when the job is
 * still the run's, or — taken from it — when nobody else has the crawl (still
 * `running`, no other live job): the run that is actually working it closes
 * it, and its `onClose` then settles nothing, the job being settled already.
 * Otherwise `JobLostError`, and nothing is written.
 */
async function requireCloseOwnership(tx: CloseTx, crawlId: string, owner: RunOwner): Promise<void> {
  const status = await lockCrawlStatus(tx, crawlId);
  if (await ownsJob(tx, owner)) return;
  const others = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.crawlId, crawlId), ne(jobs.id, owner.jobId), sql`${jobs.status} in ('queued', 'running')`))
    .limit(1);
  if (status === "running" && others.length === 0) return;
  throw new JobLostError(crawlId, status, owner.jobId, "close");
}

/** `closeCrawl`'s write, on the pool or inside the transaction it shares with `onClose`. */
async function closeCrawlOn(
  db: Db | CloseTx,
  crawlId: string,
  outcome: "finished" | "stopped" | "failed",
  pagesCrawled: number,
  refsCapped: { delta: number; resumed: boolean } | null,
  failureReason: string | null,
  stop: StopReason | null,
): Promise<ClosedAs> {
  if (outcome === "failed" && failureReason === null) {
    throw new Error(
      `closeCrawl: crawl ${crawlId} is being closed 'failed' with no reason — ` +
        `crawls.failure_reason is what a reader is left with (migration 0017)`,
    );
  }
  if (outcome !== "failed" && failureReason !== null) {
    throw new Error(
      `closeCrawl: crawl ${crawlId} is being closed '${outcome}' with a failure ` +
        `reason ('${failureReason}') — that column belongs to 'failed' rows only`,
    );
  }
  // A stopped close without a reason to stop, or a reason handed to another
  // close, is a defect in the caller: the loop only stops on its watcher.
  if ((outcome === "stopped") !== (stop !== null)) {
    throw new Error(
      `closeCrawl: crawl ${crawlId} is being closed '${outcome}' with stop reason ` +
        `${JSON.stringify(stop)} — a stop reason belongs to a stopped close, and only there`,
    );
  }
  const common = {
    finishedAt: new Date(),
    pagesCrawled,
    ...(refsCapped === null
      ? {}
      : {
          resourceRefsCappedPages: refsCapped.resumed
            ? sql`${crawls.resourceRefsCappedPages} + ${refsCapped.delta}`
            : refsCapped.delta,
        }),
  };

  if (outcome !== "stopped") {
    // A FAILED CLOSE IS CONDITIONED ON `running` (27b). Every failed close in
    // the loop happens while the run holds the row — the robots refusal, and
    // `execute`'s catch for an error on the way out. An error that comes AFTER
    // a successful close (a `summarise` read that throws once the row says
    // `cancelled`) must not re-close the row `failed`: that would clear
    // `cancelled_at` and make a final cancel resumable. Zero rows moved is
    // thrown, naming what the row already says, so `execute` surfaces it
    // beside the original error rather than in place of it.
    const rows = await db
      .update(crawls)
      .set({
        ...common,
        status: outcome,
        // A reason can quote the site (a robots.txt note, a fetch reason), so it
        // passes the storability boundary (ruling R11). Null stays null.
        failureReason: failureReason === null ? null : storableCap(failureReason),
        controlRequest: null,
        pauseReason: null,
        cancelledAt: null,
      })
      .where(
        outcome === "failed"
          ? and(eq(crawls.id, crawlId), eq(crawls.status, "running"))
          : eq(crawls.id, crawlId),
      )
      .returning({ id: crawls.id });
    if (outcome === "failed" && rows.length === 0) {
      const [now] = await db
        .select({ status: crawls.status })
        .from(crawls)
        .where(eq(crawls.id, crawlId));
      throw new Error(
        now === undefined
          ? `closeCrawl: crawl ${crawlId}: the crawls row is gone; cannot close it failed`
          : `closeCrawl: crawl ${crawlId} is already '${now.status}', not 'running': its row ` +
              `was closed before this failure could be recorded, and it is not overwritten`,
      );
    }
    return { status: outcome, pauseReason: null };
  }

  // The request the watcher RECORDED must still stand in the column, or the
  // CASE would read a cleared column as a shutdown: a recorded cancel needs
  // 'cancel'; a recorded pause needs 'pause' or the cancel that may have
  // overtaken it. A shutdown records nothing and conditions nothing.
  const recorded =
    stop?.kind === "cancel" ? "cancel" : stop?.kind === "pause" && stop.reason === "request" ? "pause" : null;
  const requestStillStanding =
    recorded === "cancel"
      ? eq(crawls.controlRequest, "cancel")
      : recorded === "pause"
        ? sql`${crawls.controlRequest} in ('pause', 'cancel')`
        : sql`true`;

  // THE STOPPED CLOSE: one statement, the column decides (see the docblock).
  // Every CASE reads the row as it was before this UPDATE, so `control_request
  // = null` in the same SET does not change what the others see.
  const rows = await db
    .update(crawls)
    .set({
      ...common,
      status: sql`case when ${crawls.controlRequest} = 'cancel' then 'cancelled' else 'paused' end`,
      pauseReason: sql`case when ${crawls.controlRequest} = 'cancel' then null
                            when ${crawls.controlRequest} = 'pause' then 'request'
                            else 'shutdown' end`,
      cancelledAt: sql`case when ${crawls.controlRequest} = 'cancel' then now() else null end`,
      controlRequest: null,
      failureReason: null,
    })
    .where(and(eq(crawls.id, crawlId), requestStillStanding))
    .returning({ status: crawls.status, pauseReason: crawls.pauseReason });
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      recorded === null
        ? `closeCrawl: crawl ${crawlId}: the crawls row is gone; cannot close it`
        : `closeCrawl: crawl ${crawlId} was asked to ${recorded}, but its control_request ` +
            `no longer says so — something cleared it under the run; not guessing a status`,
    );
  }
  const pauseReason = readPauseReason(row.pauseReason, crawlId);
  if (row.status === "cancelled" && pauseReason === null) {
    return { status: "cancelled", pauseReason: null };
  }
  if (row.status === "paused" && pauseReason !== null) {
    return { status: "paused", pauseReason };
  }
  throw new Error(
    `closeCrawl: crawl ${crawlId}'s stopped close came back '${row.status}' with pause ` +
      `reason ${String(pauseReason)}`,
  );
}

/** What a close wrote: the status and, for a pause, its reason. */
interface ClosedAs {
  status: CrawlSummary["status"];
  pauseReason: PauseReason | null;
}

async function summarise(
  db: Db,
  crawlId: string,
  closed: ClosedAs,
  pagesCrawled: number,
  writerStats: PageWriterStats,
  /** Null when the run was stopped before its discovery was recorded. */
  discovery: DiscoveryResult | null,
  pageTemplates: PageTemplateInference | null,
  resources: ResourcePassSummary | null,
  recheck: RecheckPassSummary | null,
  note: string | null | ((frontier: FrontierCounts) => string),
): Promise<CrawlSummary> {
  const frontier = await frontierCounts(db, crawlId);
  return {
    crawlId,
    status: closed.status,
    pauseReason: closed.pauseReason,
    pagesCrawled,
    frontier,
    writer: writerStats,
    robots:
      discovery === null
        ? null
        : { outcome: discovery.robots.outcome, note: discovery.robots.note },
    discovery:
      discovery === null
        ? null
        : {
            sitemapEntries: discovery.sitemapEntries.length,
            truncation: discovery.truncation,
          },
    sitemapsRead: discovery === null ? null : discovery.sitemapsRead,
    pageTemplates,
    resources,
    recheck,
    note: typeof note === "function" ? note(frontier) : note,
  };
}

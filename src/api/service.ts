/**
 * The service layer: every question the agent surface can ask, answered once.
 *
 * This module is transport-neutral by construction — plain arguments in, plain
 * data out, typed errors — because it has two callers. `src/api/http.ts` is
 * routing and serialisation over it; `src/api/mcp.ts` is a second transport
 * over the SAME functions, not over the HTTP routes. Nothing here
 * knows about status codes, headers, JSON text or MCP tool shapes: it raises
 * `ServiceError` with a code, and each transport maps that code to whatever its
 * protocol calls a refusal.
 *
 * It is also the only place in the API layer where SQL lives (the plan's rule).
 * A route that needs a number asks a method here; it does not reach for a table.
 *
 * ## The crawl queue, and what a restart means
 *
 * A crawl is started by `POST /crawls`, which must answer immediately with an
 * id — so the `crawls` row is created **when the crawl is accepted**, in status
 * `queued`, and the run happens later. One crawl runs at a time per server
 * process; the rest wait in FIFO order.
 *
 * The queue is crawl-row-backed (Talos obligation 3: crawl rows are the
 * isolation unit, nothing assumes "the one current crawl"). The row carries the
 * site, the config and the ruleset stamp from the moment of acceptance, so a
 * queued crawl is durable, listable and inspectable exactly like a running one.
 * What is held in memory is only this process's *intent*: an ordered list of
 * ids it means to run.
 *
 * **Restart behaviour, stated rather than discovered.** A server that dies with
 * work queued leaves `queued` rows behind. This server does NOT adopt them at
 * boot, and the reason is not caution about our own state — it is that another
 * engine process may be running that very crawl right now (multi-instance is
 * the deployment obligation 3 anticipates), and a boot-time sweep cannot tell
 * "my orphan" from "someone else's live work". So:
 *
 *  - the work is **not silently lost**: the row stands, with its config, in
 *    status `queued`, and `GET /crawls` lists it;
 *  - it is **not silently started**: only crawls enqueued by THIS process are
 *    ever run by it;
 *  - and the difference is **visible**: `queuePosition` is a number for a crawl
 *    this process is holding and `null` for a queued row nobody is holding. A
 *    caller that finds `status: "queued"` with `queuePosition: null` is looking
 *    at abandoned work and can re-submit it.
 *
 * A crawl left `running` by a killed process is the other half of the same
 * story, and it already had an answer: `markCrawlFailed`, whose lease test is
 * the same one the render driver uses to tell a live crawl from a dead one.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath, sep as pathSep } from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crawls, frontier, issues, pages } from "../db/schema.js";
import {
  CRAWL_DEFAULTS,
  failureReasonOf,
  parseStoredConfig,
  resumeCrawl,
  storableConfig,
  validateCrawlConfig,
  type CrawlConfig,
} from "../crawl/loop.js";
import { DISCOVERED_VIA, frontierCounts, type FrontierCounts } from "../crawl/frontier.js";
import { FETCH_CLASSES, type FetchClass } from "../crawl/fetch-page.js";
// The resource vocabulary this surface reads, imported rather than spelled out:
// the one `fetch_reason` literal a surface may read (a constant this repository
// defines, never a sentence somebody could reword) and the two `fetch_class`
// members the coverage aggregate names. See `resourceCoverage`.
import {
  RESOURCE_CAP_REASON,
  RESOURCE_OK_CLASS,
  RESOURCE_ROBOTS_DENIED_CLASS,
  RESOURCE_ROBOTS_UNREACHABLE_CLASS,
} from "../crawl/resources/fetch-resources.js";
// The robots vocabulary from the module that WRITES it, never a copy: a fourth
// outcome added there must not turn every new crawl's stored evidence into a
// validation refusal here. See `ROBOTS_OUTCOMES` in discovery.ts.
import { ROBOTS_OUTCOMES } from "../crawl/discovery.js";
// The recheck vocabulary, imported from the two modules that WRITE it rather
// than spelled out here: the cap reason the pass stamps on a row it never got
// to (`RESOURCE_CAP_REASON`'s twin), and the set of second-observation classes
// the rule pair calls "the site answered, and not with a 5xx". See
// `recheckCoverage`.
import { RECHECK_CAP_REASON, RECHECK_CLASSES } from "../crawl/recheck/recheck-server-errors.js";
import { throttleRecordOf, type HostThrottle } from "../crawl/politeness.js";
import {
  readStoredPlatform,
  type Platform,
  type StoredPlatformProfile,
} from "../crawl/platform.js";
import { NO_RESPONSE, NO_RESPONSE_ANSWERED, RECHECK_CLEARED } from "../rules/page/status.js";
import {
  RENDER_HTML_DIR,
  RenderPassRefusal,
  runRenderPass,
  type RenderPassSummary,
} from "../crawl/render/run-render.js";
import { resolveRenderConfig } from "../crawl/render/select.js";
import { hostProbeStarts, hostnameSpellings, normalizeUrl } from "../crawl/parse/url-utils.js";
import { isUrlAllowed, UrlPolicyError } from "../crawl/url-policy.js";
import { buildRegistry } from "../rules/index.js";
import { RULESET_VERSION, type Registry } from "../rules/registry/registry.js";
import {
  metricTableColumns,
  metricTableOrder,
  metricTableSummary,
  shapeMetricTable,
  type MetricCell,
  type MetricColumn,
  type MetricSummaryValue,
  type StoredMetricRow,
} from "../rules/registry/metric-table.js";
import {
  METRIC_SCOPES,
  type AnyRule,
  type IssueType,
  type Priority,
  type RuleCategory,
  type RuleColumn,
  type Severity,
} from "../rules/registry/types.js";
import {
  JudgementError,
  OVERRIDABLE_THRESHOLDS,
  effectiveThresholds,
  parseJudgement,
  readStoredJudgement,
  type JudgedWith,
  type JudgementBlock,
  type ThresholdName,
} from "../rules/judgement.js";
import {
  indexabilityOf,
  ROBOTS_BLOCKED,
  type Indexability,
  type IndexabilityStatus,
} from "../rules/helpers.js";
import { UNTYPED } from "../rules/metric/cohort.js";
import { resolveRuleCaps, storedFindingCap } from "../rules/query/crawl-evidence.js";
import { runRules, type RunSummary } from "../rules/run.js";
import { isHostAllowed, type ServiceConfig } from "./config.js";
import {
  CSV_VIEWS,
  CSV_VIEW_DEFS,
  CRAWL_OVERVIEW_HEADER,
  ISSUES_OVERVIEW_HEADER,
  crawlOverviewRecords,
  issuesOverviewCells,
  metricTableCells,
  metricTableHeader,
  EXPORT_FORMATS,
  csvFilename,
  csvRecord,
  type CsvViewContext,
  type CsvViewName,
  type ExportFormat,
} from "./csv.js";
import { ServiceError, clip } from "./errors.js";
import {
  buildCrawlOverview,
  buildIssuesOverview,
  type CrawlOverview,
  type IssuesOverview,
  type SnapshotReader,
} from "./overview.js";
import {
  copyRenderer,
  isPlainObject,
  judgementViewOf,
  loadJudgementView,
  mergePatch,
  notDisabled,
  readJudgementBlock,
  refuseIfDisabled,
  storableBlock,
  triageFields,
  type JudgementStale,
  type JudgementView,
} from "./judgement-view.js";

export { ServiceError, type ServiceErrorCode } from "./errors.js";

/**
 * The crawl budget a request that does not name one gets.
 *
 * `CRAWL_DEFAULTS` deliberately has no `maxPages` — the crawl loop refuses to
 * invent a budget, because a budget is a politeness decision (rule 9). The API
 * has to have an answer anyway, and "unbounded" is the one answer that must not
 * be it: an agent that forgets the field would otherwise crawl a 400k-page site
 * to the end. 500 is a first look at a site, and a caller who wants more says
 * so in the request.
 */
export const API_CRAWL_DEFAULTS = { maxPages: 500 } as const;

/**
 * The politeness floor under `perHostDelayMs` for a crawl a CLIENT asked for.
 *
 * The MCP tool descriptions have said "perHostDelayMs has a floor" since the
 * agent surface was written, and until now there was none: an agent that sent
 * `perHostDelayMs: 0` got a crawl that hit one host as fast as the concurrency
 * window allowed. A claim the engine does not keep is worse than no claim, and
 * the yellow.com.mt incident (docs/talos-integration.md) is what being wrong
 * about this costs.
 *
 * 250ms — four requests a second to one host — is not a tuned number and is not
 * meant to be a comfortable one. It is the point below which a crawler is no
 * longer plausibly reading a site and is measurably load-testing it. The
 * genuinely polite delays are ten times this (`CRAWL_DEFAULTS` is 1000ms, the
 * crawl skill recommends 2000ms on anything Cloudflare-fronted); a caller who
 * hits this floor has already ignored all of that.
 *
 * REFUSED, NOT CLAMPED. Silently raising the value to 250 would answer a
 * request nobody made and leave the caller believing their number took effect
 * (hard rule 7). The refusal names the floor, so the fix is one edit.
 *
 * ## The boundary this does NOT cross, stated because it is load-bearing
 *
 * The floor binds `parseStartCrawlInput`, which is the request-field seam and
 * the ONLY seam both transports pass through (`POST /crawls` parses a body with
 * it, `crawl_start` parses its arguments with it). It deliberately does NOT
 * bind `effectiveConfig` or `validateCrawlConfig`, which is where a
 * `crawlDefaults.perHostDelayMs` supplied by the process that CONSTRUCTS the
 * server would be caught.
 *
 * That is the same process-trust seam `allowPrivate` rests on: the constructor
 * holds the database handle and the auth token, and it is how the test suite
 * crawls its own 127.0.0.1 fixture site at `perHostDelayMs: 0` without waiting
 * a second per page. A floor there would not make anything more polite — a
 * loopback fixture server has nobody to be rude to — and it would make the
 * suite unrunnable. The distinction is: a delay that arrived over the wire is
 * subject to the floor; a delay the operator compiled into the process is that
 * operator's decision.
 */
export const MIN_PER_HOST_DELAY_MS = 250;

/**
 * How many sitemap documents one crawl-start request may name.
 *
 * The walk itself is capped at 300 documents including everything a sitemap
 * INDEX points at (`MAX_SITEMAP_DOCS`, src/crawl/discovery.ts), so this is not
 * the limit that protects the origin — it is the limit on what a REQUEST may
 * carry into `config_jsonb`, which is a column every resume and every render
 * pass reads back. Fifty root documents is already a site whose sitemap has an
 * index, and supplying the index is both shorter and more faithful to what the
 * site publishes. Refused rather than trimmed: a list this engine silently cut
 * would leave the caller believing every document was walked (hard rule 7).
 */
export const MAX_SUPPLIED_SITEMAPS = 50;

/** `CrawlDetail.platform` and `.platformProfile`, off the two crawls columns. */
function platformFields(
  platformColumn: string | null,
  profileColumn: unknown,
  crawlId: string,
): { platform: Platform | null; platformProfile: StoredPlatformProfile | null } {
  const { platform, profile } = readStoredPlatform(platformColumn, profileColumn, crawlId);
  return { platform, platformProfile: profile };
}

/** Rows per page when the caller does not say, and the ceiling when they do. */
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

/**
 * The crawl-start body, after validation. Every field except `siteUrl` is an
 * override of a default; the set is closed (see `parseStartCrawlInput`).
 */
export interface StartCrawlInput {
  siteUrl: string;
  maxPages?: number;
  maxDepth?: number;
  userAgent?: string;
  perHostDelayMs?: number;
  maxConcurrency?: number;
  probeHosts?: boolean;
  legacyHosts?: string[];
  sitemapUrls?: string[];
  renderBudgetPct?: number;
  renderMaxPages?: number;
  renderSamplePerType?: number;
  findingCap?: number | null;
  fetchResources?: boolean;
  /**
   * The crawl's judgement block (Phase 27a), as the caller sent it: checked to
   * be a JSON object here and parsed against the ruleset by `startCrawl`
   * (`parseJudgement`), which is where the registry is. Its `findingCap` is
   * stored in `config_jsonb.findingCap`; the rest in `judgement_jsonb`.
   */
  judgement?: unknown;
}

type FieldKind = "string" | "number" | "boolean" | "string[]" | "number|null" | "object";

/**
 * The wire's whole vocabulary for starting a crawl.
 *
 * A closed table rather than a cast: a body is validated field by field and an
 * unknown key is a 400 naming it. The alternative — spreading the body into a
 * config and letting the extra keys ride along — is how a field that was never
 * meant to cross the wire crosses it, which is precisely the failure
 * `allowPrivate` demonstrates below.
 *
 * EXPORTED because the MCP transport advertises a schema rather than parsing a
 * body: `crawl_start`'s tool schema names these fields with a description each,
 * and a test asserts the two sets are equal. A field added here and forgotten
 * there would be a field the HTTP surface accepts and the agent surface cannot
 * see — which is how a second, quietly smaller API appears.
 */
export const START_CRAWL_FIELDS: Record<keyof StartCrawlInput, FieldKind> = {
  siteUrl: "string",
  maxPages: "number",
  maxDepth: "number",
  userAgent: "string",
  perHostDelayMs: "number",
  maxConcurrency: "number",
  probeHosts: "boolean",
  legacyHosts: "string[]",
  sitemapUrls: "string[]",
  renderBudgetPct: "number",
  renderMaxPages: "number",
  renderSamplePerType: "number",
  findingCap: "number|null",
  fetchResources: "boolean",
  judgement: "object",
};

/**
 * The fields `POST /crawls/:id/render` accepts, on the same terms and for the
 * same reason as `START_CRAWL_FIELDS`: the MCP tool advertises a schema, the
 * HTTP route parses a body, and a test asserts the two sets are the same one.
 */
export const RENDER_CRAWL_FIELDS: Record<keyof RenderCrawlInput, FieldKind> = {
  urls: "string[]",
};

/**
 * How many unrenderable URLs a refusal spells out before it says "…".
 *
 * A caller who pasted a whole listing can be wrong about all of it, and a 400
 * carrying four hundred URLs is a body nobody reads. Enough to see the PATTERN
 * of the mistake — a stale host, a missing trailing slash — and the count above
 * it is exact either way.
 */
const MISSING_URLS_NAMED = 5;

/**
 * Validate a render body. Same discipline as `parseStartCrawlInput`: an unknown
 * field is a refusal naming it, never an ignored instruction. A caller who sent
 * `{"pages": [...]}` and got a 200 would believe the engine rendered what they
 * named, and it would have rendered its own automatic selection instead.
 *
 * An ABSENT body is the automatic pass, which is why this accepts `undefined`
 * where the crawl-start parser demands an object: the route existed for two
 * phases without one and every caller of it sends nothing.
 */
export function parseRenderCrawlInput(raw: unknown): RenderCrawlInput {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServiceError("VALIDATION", "request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const kind = RENDER_CRAWL_FIELDS[key as keyof RenderCrawlInput];
    if (kind === undefined) {
      throw new ServiceError(
        "VALIDATION",
        `unknown field '${clip(key)}' (accepted: ${Object.keys(RENDER_CRAWL_FIELDS).join(", ")})`,
      );
    }
    if (value === undefined) continue;
    assertKind(key, value, kind);
    input[key] = value;
  }
  return input as RenderCrawlInput;
}

/**
 * Validate a crawl-start body. Never casts, never ignores a field it does not
 * know, and never accepts either TEST-ONLY crawl-config field at any value
 * (`allowPrivate`, `recheckMinGapMs`).
 *
 * Shared by both transports on purpose: the MCP server's `crawl_start` gets the
 * same field allowlist and the same refusals as the HTTP route, because the
 * argument that a test-only escape hatch must not be reachable from outside the
 * process does not weaken when the caller is on stdio.
 */
export function parseStartCrawlInput(raw: unknown): StartCrawlInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServiceError("VALIDATION", "request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  // Named before the unknown-field loop so the refusal says WHY rather than
  // "unknown field": a caller sending this has read about the flag somewhere
  // and needs to be told it is not an API field at all, at any value.
  if ("allowPrivate" in body) {
    throw new ServiceError(
      "VALIDATION",
      "allowPrivate is not accepted over the API at any value: it is a test-only " +
        "escape hatch that admits loopback and private targets, it is never persisted " +
        "on a crawl row, and it can only be set by the process that constructs the " +
        "server",
    );
  }

  // The second test-only field, refused by name for the same reason and with
  // the same weight (P17). The 60-second floor between a page's two
  // observations is the CLAIM the evidence makes — "still broken a minute
  // later" — not a tuning knob: a caller who could shrink it could make every
  // transient 5xx clear and turn a `critical` into a `warning` on demand.
  if ("recheckMinGapMs" in body) {
    throw new ServiceError(
      "VALIDATION",
      "recheckMinGapMs is not accepted over the API at any value: it is a test-only " +
        "crawl-config field that shortens the minimum gap between a page's two fetch " +
        "observations, it is never persisted on a crawl row, and it can only be set by " +
        "the process that constructs the server",
    );
  }

  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const kind = START_CRAWL_FIELDS[key as keyof StartCrawlInput];
    if (kind === undefined) {
      throw new ServiceError(
        "VALIDATION",
        `unknown field '${clip(key)}' (accepted: ${Object.keys(START_CRAWL_FIELDS).join(", ")})`,
      );
    }
    if (value === undefined) continue;
    assertKind(key, value, kind);
    input[key] = value;
  }

  if (typeof input["siteUrl"] !== "string" || input["siteUrl"].trim() === "") {
    throw new ServiceError("VALIDATION", "siteUrl is required and must be a non-empty string");
  }

  // The politeness floor the tool descriptions promise. Here rather than in
  // `validateCrawlConfig` because this is the seam BOTH transports pass through
  // and the construction-trust path does not — see `MIN_PER_HOST_DELAY_MS`.
  const delay = input["perHostDelayMs"];
  if (typeof delay === "number" && delay < MIN_PER_HOST_DELAY_MS) {
    throw new ServiceError(
      "VALIDATION",
      `perHostDelayMs ${delay} is below this server's politeness floor of ` +
        `${MIN_PER_HOST_DELAY_MS}ms: the per-host delay is not a throughput knob, and a ` +
        `crawl faster than four requests a second to one host is load-testing it. ` +
        `robots.txt's own crawl-delay still wins when it is longer`,
    );
  }
  return input as unknown as StartCrawlInput;
}

function assertKind(key: string, value: unknown, kind: FieldKind): void {
  const bad = (expected: string): never => {
    throw new ServiceError("VALIDATION", `field '${key}' must be ${expected}`);
  };
  switch (kind) {
    case "string":
      if (typeof value !== "string") bad("a string");
      return;
    case "number":
      // A number that is not finite is not a number a config can use, and
      // JSON.parse produces no NaN — so this only ever catches a caller who
      // sent a string. Naming the type beats a RangeError three layers down.
      if (typeof value !== "number" || !Number.isFinite(value)) bad("a finite number");
      return;
    case "boolean":
      if (typeof value !== "boolean") bad("a boolean");
      return;
    case "string[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        bad("an array of strings");
      }
      return;
    case "number|null":
      // NULL IS A VALUE HERE, not an omission, and it is the whole reason this
      // kind exists: `findingCap: null` says "list everything", which is a
      // different instruction from leaving the field out ("use the defaults").
      // Every other field on the wire treats a null as a caller who meant to
      // send nothing.
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        bad("a finite number, or null");
      }
      return;
    case "object":
      // A JSON object and nothing else: a null here is not "no judgement" (an
      // absent field is), and an array is not a block with no keys.
      if (!isPlainObject(value)) bad("a JSON object");
      return;
  }
}

/** What `POST /crawls` (and `crawl_start`) answers with. */
export interface CrawlAccepted {
  crawlId: string;
  /** The row's status at acceptance. Always `queued`; poll for the live one. */
  status: string;
  /** Crawls this process must finish first. 0 = it is starting now. */
  queuePosition: number;
}

/** One crawl, as a listing row. */
export interface CrawlListItem {
  crawlId: string;
  siteUrl: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pagesCrawled: number;
  renderPassCount: number;
}

/** One crawl, in full. */
export interface CrawlDetail extends CrawlListItem {
  rulesetVersion: string;
  pagesTotal: number | null;
  /**
   * WHY THIS CRAWL IS `failed` — one sentence, or null.
   *
   * **Null unless `status` is `failed`.** The column's contract is an
   * implication (`crawls.failure_reason`, migration 0017): a reason implies a
   * failure, and a failure does NOT imply a reason. A `failed` crawl with null
   * here is a row closed before 0017 existed — "the engine recorded no reason",
   * which is a different sentence from "it failed for no reason" and must be
   * rendered as such. Every crawl closed since carries one.
   *
   * WHY IT IS ON THE WIRE. Without it a `failed` status is a dead end: the
   * Phase 17 gate pointed a crawl at a host whose robots.txt answered 502, and
   * fourteen seconds later the surface said `failed` and nothing else — the
   * sentence explaining it existed only in the engine's process log, which is
   * exactly the place a caller driving this engine over a network cannot read
   * (docs/gates/phase-17.md §5, clause 5).
   *
   * THREE WRITERS, three shapes of sentence, and a reader can tell them apart:
   * the crawl loop's own classified sentence when the crawl was REFUSED before
   * it began (`robots.txt unreachable after 3 attempts (HTTP 502): complete
   * disallow`); the first line of whatever threw inside the run; and the fixed
   * `marked failed by an operator: no worker held it` when a caller retired an
   * orphan with `crawl_mark_failed` (`MARKED_FAILED_REASON`).
   *
   * **It is a DIAGNOSTIC STRING, not client copy** — `pages_query`'s
   * `renderError` precedent, and the same caveat: first line only, never a
   * stack, but engine-originated text rather than a sentence written for a
   * tenant to read (docs/talos-surface.md §9).
   *
   * NOT ON `CrawlListItem`: a listing row says a crawl failed, and the crawl is
   * where the reason lives.
   */
  failureReason: string | null;
  frontier: FrontierCounts;
  /**
   * This process's queue position, or null.
   *
   * Null for every crawl that is not `queued` — and, importantly, null for a
   * `queued` row this process is NOT holding: work a dead process accepted and
   * nobody will run. See the module header.
   */
  queuePosition: number | null;
  /**
   * Unexpired leases the crawl holds right now — crawl leases and render leases
   * alike. Non-zero means somebody is working it; zero on a `running` row means
   * the worker is gone (the condition `markCrawlFailed` requires).
   */
  liveLeases: number;
  /**
   * Pages that ended as `fetch_class = 'blocked'`: a WAF or a rate limiter
   * answered instead of the site (401/403/429, a `cf-mitigated` header, or a
   * challenge page behind a 503).
   *
   * It is on the polling shape rather than left to a `pages` query because it
   * is the number an operator has to WATCH RISE, not discover afterwards. The
   * engine protects itself when it climbs — the host's spacing doubles per
   * block and each blocked URL is retried up to three times under the widened
   * spacing — but a count that keeps climbing anyway means the site does not
   * want to be crawled at this pace, or at all, and the answer is a slower
   * re-crawl or a conversation with its owner. Never a harder push (rule 9).
   *
   * Counted live off the `pages` rows, so it is meaningful mid-crawl.
   */
  blockedPages: number;
  /**
   * The internal URLs robots.txt kept this crawl out of (Phase 23 T3, study
   * D1) — NOT `blockedPages`, which is a site refusing requests we made; these
   * are requests we never made.
   *
   * `recorded` is the `disallowed` page rows carrying the robots reason, counted
   * live off `pages` (`ROBOTS_BLOCKED`): never requested, each reported with its
   * inlinks by `robots.blocks-internal-urls`. Rows a url-policy refusal wrote
   * are not among them. Zero is a measurement.
   *
   * `dropped` is `crawls.robots_blocked_dropped`: discoveries of blocked URLs
   * turned away because the blocked-row budget (`maxBlockedUrls`, default
   * `maxPages`) was full. A count of DISCOVERIES, not distinct URLs — one URL
   * linked from three pages after the budget filled counts three. NON-ZERO
   * MEANS THE RULE'S LIST IS INCOMPLETE, and the finding carries a truncation
   * note saying so. NULL IS NOT ZERO: it is a crawl written before migration
   * 0020 (or a resume of one), where nobody counted.
   */
  robotsBlocked: {
    /** Robots-blocked page rows on record, never requested. Zero is a measurement. */
    recorded: number;
    /** `crawls.robots_blocked_dropped`: discoveries turned away; null = not counted. */
    dropped: number | null;
  };
  /**
   * The widest per-host spacing the crawl's politeness gate has escalated to,
   * in milliseconds, or null when no crawl loop ever reported one (a row that
   * predates the field, or a crawl that failed before it started fetching).
   *
   * It is the other half of `blockedPages`, and the pair is what makes "this
   * crawl is slow" readable instead of alarming. Spacing well above the
   * configured `perHostDelayMs` with `blockedPages` no longer rising is the
   * engine having found the site's rate and settled there — the correct outcome,
   * and the one a caller must not "fix" by restarting. Spacing pinned at the
   * 30s cap is the engine out of room to back off further, which is where an
   * operator has to decide rather than wait.
   */
  hostSpacingMs: number | null;
  /**
   * How hard each host pushed back, per host, as the crawl loop persisted it
   * (`crawls.host_spacing_jsonb`, Phase 24a): `responses429`, `retryAfterSeen`,
   * `escalations` (cumulative; the level in force is `escalations - recoveries`),
   * `recoveries`, `recoveryLocked`, `peakSpacingMs`, `finalSpacingMs`. Every host
   * the crawl touched is in it, including ones that never pushed back (all
   * counters zero).
   *
   * CRAWL EVIDENCE, NOT A FINDING (the Phase 16 ruling: how a site received the
   * crawl is not a site issue). Null only when no record was ever stored: the
   * column is null (a pre-24a crawl, or one that failed before its first write)
   * or holds a pre-24a `{host: ms}` map. `{}` is a 24a crawl that touched no
   * host. Null is never a record of zeros.
   */
  throttle: Record<string, HostThrottle> | null;
  /**
   * The platform the site's own response headers named (`crawls.platform`,
   * migration 0024): `"shopify"` today, read off the first `ok` HTML response
   * from the crawl's origin. Null means no platform was named — the headers
   * named none (a Shopify store whose CDN strips its headers included), no
   * page answered `ok`, or the crawl predates 0024 — and the crawl ran at its
   * configured settings.
   */
  platform: Platform | null;
  /**
   * What the platform profile did to this crawl (`crawls.platform_profile_jsonb`),
   * null exactly when `platform` is. `applied` holds the values in force after
   * the clamp — `maxConcurrency`, `perHostDelayMs`, `renderConcurrency`,
   * `navigationTimeoutMs`; a caller's own setting stands wherever it was already
   * slower — and `appliedAt` when it took effect (mid-crawl when no host probe
   * ran). `optedOut: true` with `applied: null` means the operator turned
   * profiles off for this crawl and nothing was clamped.
   */
  platformProfile: StoredPlatformProfile | null;
  /**
   * The extra hosts this crawl was told the site used to live on, echoed from
   * its stored config. Empty when none were named.
   *
   * It is on the detail because it is the only place the host rules' evidence
   * can be checked against what was asked for. `host.legacy-redirect`
   * (CHECK-15) reports what the probe found; without this a reader cannot tell
   * "the legacy domain does not redirect" from "no legacy domain was ever
   * given to the crawl", and the second is a crawl-configuration mistake
   * dressed up as a site defect.
   *
   * Empty is a real answer, not a fallback: `legacyHosts` is optional, so an
   * absent key means nobody named one. A stored value of the wrong SHAPE is a
   * refusal instead (see `configStringList`).
   */
  legacyHosts: string[];
  /**
   * The sitemap documents this crawl was handed at start, echoed from its
   * stored config. Empty when none were supplied.
   *
   * Beside `legacyHosts` for the same reason: it is a denominator. This engine
   * never probes for an undeclared sitemap, so `sitemap.missing` (CHECK-06)
   * reporting an undeclared sitemap next to an empty list here means nobody has
   * yet handed the crawl the document — a crawl to re-run with it, not a report
   * to write. Next to a non-empty list it means the supplied document WAS
   * walked and robots.txt still does not declare it, which is the site's own
   * finding.
   */
  sitemapUrls: string[];
  /**
   * How many findings each listing rule may report when this crawl is judged:
   * a positive integer, or `null` for uncapped.
   *
   * RESOLVED, NOT RAW. The three cases the stored config can be in map onto the
   * two values a reader gets:
   *  - the key is ABSENT — nobody chose, so the crawl will be judged under the
   *    engine's default and that default is what is reported: 200.
   *  - the key is `null` — uncapped, reported as `null`.
   *  - the key is a number — that number.
   *
   * So this answers "what will this crawl's listings be cut at", which is the
   * question an agent that just set `findingCap` has. It is on the detail beside
   * `legacyHosts` and `sitemapUrls` for the same reason those are: the audit and
   * crawl skills now tell an agent to set `findingCap: null` for client work, and
   * a setting nothing can confirm is a setting nobody can trust took effect.
   *
   * The one thing it cannot distinguish is an explicit `200` from an absent key,
   * and since Phase 19 §11 there is nothing left to distinguish: the
   * near-duplicate rule's separate PAIR budget (200 against a default 500) went
   * with the pair shape, so one budget now cuts every listing and the stated
   * default judges exactly as the absent one does. The crawl skill says the
   * same from the other side.
   */
  findingCap: number | null;
  /**
   * When the rules last COMPLETED a pass over this crawl, or null.
   *
   * The judged-state marker (`crawls.rules_run_at`), and the field to check
   * before reading anything into an empty findings list. Null means no
   * complete pass is on record — never judged, being judged right now, or
   * judged by a run that died part-way — so `findingsCount: 0` beside a null
   * here is "nobody has looked", and beside a timestamp it is "looked, found
   * nothing". Those are different reports.
   */
  rulesRunAt: string | null;
  /**
   * Whether the crawl's judgement block has moved since the rules run that
   * `rulesRunAt` records, and why (`overrides` | `thresholds` | `findingCap`).
   * `{stale: false, reasons: []}` on a crawl nobody has judged — there is no
   * judgement to be stale. Read off the same row as `rulesRunAt`, so the two
   * describe one instant. Re-running the rules clears it.
   */
  judgementStale: JudgementStale;
  /**
   * Rows in the `issues` table for this crawl, counted live.
   *
   * The same number the issues listing's groups sum to when the crawl's
   * judgement disables no rule (a disabled rule's stored rows are counted
   * here and filtered out of the listing), so a reader can tell at a glance
   * whether the judgement produced anything at all without paging a listing.
   * Read with `rulesRunAt`, never alone.
   */
  findingsCount: number;
  /**
   * How many pages a rules run over this crawl scans: the `pages` rows it
   * holds, counted live.
   *
   * IT DESCRIBES THE CRAWL, NOT A RUN. A crawl nobody has judged reports its
   * page count like any other — the field says how many pages a judgement
   * *would* scan, and `rulesRunAt` remains the only thing that says whether one
   * happened. That is what makes it usable: the audit skill fills
   * `crawl.rulesRun.pagesScanned` from here for a crawl somebody else judged,
   * instead of re-running the rules over shared state to learn a number the
   * database already holds.
   *
   * DERIVED, NOT STORED, and the derivation is an equality rather than an
   * approximation. `runRules` counts one `pagesScanned` per iteration of its
   * page cursor, and that cursor selects from `pages` on `crawl_id` alone —
   * no status filter, no type filter, no cap (src/rules/run.ts, the
   * `PAGE_BATCH` keyset loop). The `pages` row SET is fixed once the crawl
   * has stopped — later passes UPDATE rows in place (the renderer,
   * `deriveClickDepth`, the template retype) but none inserts or deletes
   * one, and a count sees only the set. So `count(*) where crawl_id = …` IS the
   * number that run reported, not an estimate of it, and the config doctrine
   * applies: do not store what the tables already say.
   *
   * **THE EQUALITY IS THE GROUND, AND IT IS BREAKABLE.** Should the page cursor
   * ever gain a filter — judge only the indexable pages, skip the redirects —
   * this count and the run's would part company, and every report that quotes
   * one as the other would be wrong without anything failing. The change that
   * adds such a filter owes this field either a matching predicate or a rename.
   *
   * Not `pagesCrawled`, which sits beside it: that is the crawl loop's own
   * counter, closed out from the frontier's `done + renderPending` rows. It
   * answers "what did the crawl fetch"; this answers "what will the rules
   * read". They agree on every crawl in the dev database, and they are still
   * different facts read off different tables.
   */
  pagesScanned: number;
  /**
   * Whether this crawl asked the site about the files its pages point at —
   * the resource fetch pass, echoed from the stored config and RESOLVED the way
   * `findingCap` is: an absent key reports the engine's default, which is
   * `true`.
   *
   * It is the denominator for everything in `resources` below, and it is on the
   * detail for `legacyHosts`' reason: a setting nothing can confirm is a setting
   * nobody can trust took effect. `false` beside `resources.fetched: 0` is an
   * operator's decision; `true` beside the same zero is a pass that has not run
   * or could not finish, and those are different reports.
   *
   * A stored value that is not a boolean is a REFUSAL rather than a guess (see
   * `configFetchResources`): `"false"` is truthy and would read as "we asked",
   * about a crawl that did not.
   */
  fetchResources: boolean;
  /**
   * How many of this crawl's PAGES carried more resource REFERENCES than the
   * analyzer's cap keeps (2,000 per page) — references turned away, counted
   * instead of silent (migration 0014, P12-T1).
   *
   * REFERENCES, NOT FILES, and the distinction is not pedantry. Past the cap the
   * analyzer stops resolving, so it cannot know whether a turned-away reference
   * was a new URL or a repeat of one it already holds. A page whose 2,001st
   * reference duplicates its first is counted here and lost no file at all. The
   * field claims what the analyzer can see — a reference dropped unexamined —
   * and nothing stronger.
   *
   * NULL IS NOT ZERO, and the difference is the whole reason the field exists.
   * Null means nobody counted, which happens three ways: a crawl written before
   * migration 0014; a crawl still running; and a crawl whose process died before
   * its first close and was later resumed — the first run's pages went
   * uncounted with the process that read them, so the null is PERMANENT on that
   * crawl rather than something the resume repairs (see `closeCrawl`). Zero
   * means the analyzer read every page of this crawl and none of them lost a
   * reference — a measurement. A dashboard that renders the two the same way is
   * telling an operator we checked when we did not (hard rule 7).
   *
   * IT IS NOT IN `resources` BELOW, deliberately, and the placement is the
   * honest one on two counts. It counts PAGES and every number in that block
   * counts FILES; and it is a value the crawl STAMPED at close, while that
   * block is read live off the `resources` table in one statement. Filed among
   * them it would make the block's own contract false.
   *
   * IT IS ALSO NOT A DENOMINATOR-SHARING PARTNER OF `pagesCrawled`. This counts
   * the analyses the page writer was HANDED; `pagesCrawled` is the crawl loop's
   * own count, closed out from the frontier's settled rows. On a crawl that
   * analysed the same URL twice — a redirect target reached under its own row,
   * whose second `pages` insert the `(crawl_id, url)` unique index drops — this
   * number can legitimately exceed `pagesCrawled`. **Do not render
   * `resourceRefsCappedPages / pagesCrawled` as a percentage**: the two are read
   * off different sources and a ratio above 1 is not a bug in either.
   *
   * WHAT A NON-ZERO NUMBER MEANS FOR THE NUMBERS BESIDE IT: on those pages
   * `resources.seen` MAY BE a floor. Some of the turned-away references would
   * have been files this crawl never recorded, so counts derived from the census
   * — broken files, uncached files, page weight — may be counts over a sample of
   * that page's references rather than over all of them. Which it is, on which
   * page, is not knowable from here: that is the price of taking the signal
   * where the cap is enforced rather than resolving past it. It is a cap, not a
   * fault: `imagesTotal` and its siblings stay exact and uncapped, and no
   * page-level count moved.
   *
   * The count is carried rather than derived because Phase 11 measured the
   * derivation: scanning `page_resources` for it costs 73 ms on a 500,000-edge
   * crawl, against an endpoint whose other reads are ≤ 3 ms (phase-11.md
   * §10.1). The analyzer flags the page, `PageWriter` counts the flagged pages
   * and `closeCrawl` stamps the total.
   */
  resourceRefsCappedPages: number | null;
  /**
   * What this crawl knows about the images, stylesheets and scripts its pages
   * reference — **read live off the `resources` table, never off a pass's
   * summary**.
   *
   * THE DISTINCTION IS LOAD-BEARING. A resumed crawl's pass asks only the rows
   * still unfetched, so its summary honestly reports `fetched: 0` on a crawl
   * whose every file was fetched by the first attempt. The database is the only
   * thing that can answer "what does this crawl know", which is the question a
   * poller and an auditor are both asking, so these numbers are counted here
   * exactly as `findingsCount` and `blockedPages` are.
   *
   * THREE counts PARTITION the rows — `fetched + failed + skipped == seen` —
   * and they are read in ONE statement so that stays true of a crawl whose pass
   * is running while somebody polls it. `robotsDenied` and `robotsUnreachable`
   * are SUBSETS of `failed` and are not part of that arithmetic; the P12-T1
   * split added a second subset and moved nothing, which is exactly why it
   * could be additive.
   *
   * On a crawl written before migration 0013 every number here is 0, which is
   * not "this site references no files": that case is what the
   * `resources.not-recorded` finding exists to say, and `rulesRunAt` is what
   * says whether it could have been written. A crawl that recorded its files and
   * asked about none of them — `seen` above zero with `skipped` equal to it —
   * has the sibling marker `resources.not-fetched` instead (P12-T2), so a reader
   * of the findings alone is not left to infer either case from a silence.
   */
  resources: {
    /**
     * Distinct files this crawl's pages reference, fetched or not — the
     * analyzer's census. Recorded even when `fetchResources` is false, because
     * reading markup costs nobody a request.
     */
    seen: number;
    /** Rows the pass classified `ok`: a server answered about the file. */
    fetched: number;
    /**
     * Rows the pass classified anything else — a 4xx or 5xx, a request that
     * failed, a URL our own policy refused, a file robots.txt put out of reach.
     * A count of files this crawl could NOT weigh, not a count of broken files:
     * which is which is `fetch_class` per row, and `resources.broken` is the
     * rule that judges it.
     */
    failed: number;
    /**
     * Rows with a null `fetch_class`: SEEN, NOT ASKED. The null-vs-zero
     * doctrine's newest citizen, and four different sentences live under it —
     * the pass has not run yet, it was interrupted, a cap stopped short of the
     * row, or the operator turned it off. Every one of the last three writes
     * its reason onto the row, and the resources CSV view is where a reader
     * sees them.
     */
    skipped: number;
    /**
     * Files a host's robots.txt FORBADE — it was read, and it said no. A subset
     * of `failed`.
     *
     * ON ITS OWN because it is the number most likely to be misread, and until
     * P12-T1 it carried a second meaning it could not signal. An unreachable
     * robots.txt is a COMPLETE DISALLOW (RFC 9309 §2.3.1.4), so a CDN that was
     * down while the pass ran behaved exactly like a CDN that forbids us and
     * landed in the same count — a wall of `robots_denied` where half of it
     * meant "we could not ask". That half is now `robotsUnreachable` beside
     * this, split on `RobotsInfo.outcome` (a closed vocabulary the fetch pass
     * holds at the deny site) and never on the reason sentence: a count built by
     * matching prose goes quietly wrong the day somebody rewords an error
     * message (docs/gates/phase-11.md §10.2).
     *
     * **A crawl that ran before P12-T1 has every robots refusal in this number**
     * — the split is written going forward, and nothing rewrote history.
     */
    robotsDenied: number;
    /**
     * Files whose host could not tell us its rules: robots.txt answered 5xx,
     * timed out, failed at the network, or lived at a URL our own policy
     * refused. Also a subset of `failed`, and also a complete disallow — we made
     * no request for any of these — but a different fact from the count above.
     *
     * READ IT AS A FACT ABOUT OUR EVIDENCE, NOT AS THE SITE'S FAULT. A number
     * here says a host was unreachable during the window this pass ran — often
     * a third party's CDN and not the client's server at all, and often
     * transient. It is the honest reason a file the site depends on carries no
     * measurement.
     *
     * A LATER PASS DOES NOT RETRY THEM. The pass's work list is the null
     * `fetch_class` column, and these rows have a class, so they are settled as
     * far as it is concerned. A fresh crawl is what re-asks; that is the same
     * treatment every other decided class gets, and the alternative — a class
     * that means "decided" on Monday and "ask again" on Tuesday — is a row
     * nobody can read.
     */
    robotsUnreachable: number;
    /**
     * True when a resource cap stopped the pass short of at least one row
     * (`maxResources` or `maxResourceHosts`).
     *
     * THE CAPS ARE BUDGETS PER RUN, not per crawl: `resumeCrawl` grants the
     * whole budget again, so a crawl's lifetime total can exceed
     * `maxResources` and this flag goes back to false once a later run weighs
     * the rows the earlier one left capped.
     *
     * ONE FLAG FOR BOTH CAPS, deliberately: the row records a single reason
     * (`resource-cap`) whichever cap stopped it, so a surface reading the
     * database cannot honestly claim to know which — and inventing two flags out
     * of one fact is how a dashboard reports a host cap that never fired. The
     * in-run distinction exists on `CrawlSummary.resources`
     * (`cappedByResources` / `cappedByHosts`) and belongs to the process that
     * ran the pass.
     */
    capped: boolean;
  };
  /**
   * What the 5xx RE-VERIFICATION pass knows about this crawl — the second look
   * every `server_error` page gets at crawl end (migration 0016, Phase 17).
   *
   * WHY IT IS ON THE WIRE AT ALL. It is the only mechanism on this surface that
   * turns a `critical` into a `warning`: a 5xx whose second observation got a
   * non-5xx answer from the site fires `http.server-error-transient` instead of
   * `http.server-error`. A consumer that cannot see the arithmetic cannot check
   * the engine's verdict before quoting it to a client.
   *
   * COUNTED LIVE OFF `pages`, IN ONE STATEMENT, exactly as `resources` above is
   * and for the same reason: the pass writes rows while a poller reads them, and
   * five counts on five pool connections are five snapshots — a `serverErrors`
   * from before a row settled beside a `pending` from after it composes an
   * arithmetic nobody's database ever held. The demo page polls this block every
   * two seconds to watch `pending` fall.
   *
   * `confirmed + cleared + inconclusive + pending == serverErrors`, always. The
   * four are a partition of the crawl's 5xx rows by their `recheck_fetch_class`;
   * `capped` is a flag over the same rows and is not a term in that sum.
   *
   * NOT ON `CrawlListItem`. A listing row is not a coverage report.
   */
  recheck: {
    /**
     * Pages whose FIRST fetch ended `server_error` — the denominator, and the
     * only number here that is about the crawl rather than about the pass. Zero
     * is a measurement: this crawl saw no server errors.
     */
    serverErrors: number;
    /** Re-asked, and the site answered 5xx again: still broken. */
    confirmed: number;
    /**
     * Re-asked, and the site answered something that is not a 5xx — the
     * transient blip. `RECHECK_CLEARED` is the set, and it is IMPORTED from the
     * rule that judges it rather than restated (see `recheckCoverage`).
     */
    cleared: number;
    /**
     * Re-asked, and no answer ABOUT THE PAGE came back: a timeout, a network
     * error, a block (which is an answer about our crawler), or a URL our own
     * policy or the site's robots.txt refused on the second look. A decided
     * outcome, never an absence — and the finding stays `critical`.
     */
    inconclusive: number;
    /**
     * NOT RE-ASKED AT ALL: nobody looked. A crawl written before migration
     * 0016, a crawl that failed or was cancelled before the pass reached the
     * row, a pass still running, or a row the cap stopped short of (which is
     * also counted in `capped`). Read it with `passAt`: `pending` equal to
     * `serverErrors` beside a null `passAt` is "no pass is on record", and
     * beside a timestamp it is a pass that ran and reached none of them.
     */
    pending: number;
    /**
     * THE SAME PASS OVER THE PAGES THAT GAVE NO RESPONSE AT ALL (Phase 23,
     * ruleset 0.18.0): first fetch `timeout` or `network_error`. A separate
     * block rather than more rows in the five numbers above, because the
     * partition is different — for these rows a 5xx or a block on the second
     * look is an ANSWER (`http.no-response-transient`), where for a 5xx row it
     * is "confirmed" or "inconclusive" — and folding them in would change what
     * every existing number above means to every consumer already reading it.
     *
     * `confirmed + answered + inconclusive + pending == pages`, always.
     */
    noResponse: {
      /** Pages whose FIRST fetch gave no HTTP response. The denominator. */
      pages: number;
      /** Re-asked, and still no response (timeout or network error). */
      confirmed: number;
      /**
       * Re-asked, and the site gave an HTTP answer — any answer, a 5xx or a
       * block included (`NO_RESPONSE_ANSWERED`, imported from the rule). The
       * rows `http.no-response-transient` claims.
       */
      answered: number;
      /** Re-asked with no request made: our policy or robots.txt refused it. */
      inconclusive: number;
      /** Not re-asked at all, the cap's rows included. */
      pending: number;
    };
    /**
     * True when one of the pass's two budgets (`MAX_RECHECKS` for the 5xx,
     * `NO_RESPONSE_RECHECK_CAP` for the no-response rows) stopped it short of at
     * least one row — those rows carry `recheck_reason` with a null class and are
     * counted in the `pending` of their block. The no-response breaker's
     * `host-unresponsive` rows are pending too, but do not set this flag: it
     * matches the cap's literal only.
     *
     * ONE LITERAL, READ AS A CONSTANT (`RECHECK_CAP_REASON`), on
     * `resources.capped`'s model: the reasons on this column are the fetch
     * layer's own sentences everywhere else, and a count built by matching prose
     * goes quietly to zero the day somebody rewords one.
     */
    capped: boolean;
    /**
     * When a recheck pass COMPLETED over this crawl (`crawls.recheck_pass_at`),
     * or null when no complete pass is on record — the `rulesRunAt` precedent,
     * and the field that tells "no server errors" apart from "nobody looked".
     * An ABORTED pass leaves it null and still settles the rows it reached.
     */
    passAt: string | null;
  };
}

/**
 * The site's own robots.txt as this crawl read it — `GET /crawls/:id/robots`.
 *
 * EVERY FIELD IS STORED EVIDENCE, none of it re-fetched: the crawl wrote the
 * text and the outcome into `crawls.discovery_jsonb` before it seeded the
 * frontier (hard rule 3 — the surface reads the database), so this is what the
 * crawl actually obeyed rather than what the file says today. A file that has
 * changed since is a fact about the site, and reading the live one here would
 * hide it.
 *
 * The body itself is the site's own public document, so there is nothing
 * tenant-private in it — and the WRAPPER is still a closed shape, because the
 * blob it is read out of is `jsonb` and everything else in that blob (the
 * sitemap walk's failures, its counters) belongs to other endpoints.
 */
/** One overridable threshold as `crawl_config_get` reports it. */
export interface ThresholdSetting {
  /** The value the crawl's NEXT rules run will use: the override, else the default. */
  value: number;
  default: number;
  /** The inclusive bounds an override must sit within. */
  min: number;
  max: number;
  /** True when the crawl's block sets this threshold, whatever the value. */
  overridden: boolean;
}

/**
 * A crawl's judgement as `crawl_config_get` (`GET /crawls/:id/config`) and
 * `crawl_config_set` answer it.
 */
export interface CrawlConfigOut {
  crawlId: string;
  /**
   * The crawl's current block, `{}` when nothing is set. `findingCap` appears
   * when the crawl's config carries one — null is uncapped — and is absent when
   * the engine default (200) applies by omission.
   */
  judgement: JudgementBlock;
  /** Every overridable threshold, as the block leaves it. */
  thresholds: Record<ThresholdName, ThresholdSetting>;
  /** What the last rules run was judged with, or null on a crawl nobody judged. */
  judgedWith: JudgedWith | null;
  judgementStale: JudgementStale;
}

export interface RobotsEvidence {
  crawlId: string;
  /**
   * The URL the crawl asked for: `/robots.txt` on the seed's origin. NOT
   * necessarily where the answer came from — a redirect to another host is
   * followed and its rules are the ones that applied — which the crawl does
   * not record separately; `note` says when something like that happened.
   */
  robotsUrl: string;
  /**
   * `read` — 2xx and parsed, the site's rules applied.
   * `absent` — 4xx, the site says there are no rules: crawled allow-all.
   * `unreachable` — 5xx, timeout, network error or a refused URL. The site
   * could not tell us its rules, which RFC 9309 §2.3.1.4 does NOT treat as
   * "there are none".
   */
  outcome: string;
  /** The text as served, or null when nothing was read (`absent`/`unreachable`). */
  raw: string | null;
  /**
   * True when `raw` is a 500KB PREFIX rather than the whole file. Anything
   * concluded from the stored text about a rule past that point is unsound —
   * a missing `Disallow` may simply be past the cap.
   */
  truncated: boolean;
  /** The `Crawl-delay` the crawl honoured, in seconds, or null if none. */
  crawlDelaySec: number | null;
  /** Why the rules are what they are, when that needed saying. Null when read. */
  note: string | null;
  /** The `Sitemap:` lines THIS FILE carried, in the order declared. */
  sitemapSources: string[];
  /**
   * The sitemap documents the crawl was handed at start (`sitemapUrls`), which
   * the walk read alongside the declared ones. Empty when none were supplied.
   *
   * It is here rather than only on the crawl detail because this is the endpoint
   * that answers "which sitemaps did this crawl read": the two lists together
   * are that answer, and either one alone is a different, smaller claim. A
   * document in BOTH was declared and re-supplied — the walk fetched it once.
   */
  suppliedSitemaps: string[];
  /**
   * The user agent the crawl identified as — the groups in this file that
   * governed it. Null when the stored config does not carry one, which is a
   * row no crawl loop wrote: the matching is then unreproducible rather than
   * assumed to be `*`.
   */
  userAgent: string | null;
}

/** A page of results, in the surface's one pagination shape. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** `runRenderPass`'s summary, minus the selection's URL list. */
export interface RenderSummaryOut {
  crawlId: string;
  rendered: number;
  failures: number;
  unrendered: number;
  elapsedMs: number;
  /**
   * The pass's same-origin requests (Phase 24a): `paced` waited for the host
   * gate's slot, `fromCache` were answered by the shared HTTP cache without
   * reaching the site, `unpacedNetwork` reached the site without a slot (a
   * cache hit predicted and missed, or a speculation-rules prefetch). See
   * `RenderPassSummary.requests`.
   */
  requests: {
    paced: number;
    fromCache: number;
    unpacedNetwork: number;
  };
  /**
   * Spellings of the crawl's origin (`www.` / apex) the render browser could
   * not reach, because their address was not approved at launch — each with
   * its reason. A page on one is a `policy refusal` render error. What the
   * reason may say is bounded where it is written (`resolveApprovedAddress`):
   * a refused answer keeps its address, a resolver failure is the bare
   * sentence and its detail is in the log (see `mapRenderPassError`).
   */
  unpinnedHosts: Array<{
    host: string;
    reason: string;
  }>;
  selection: {
    /**
     * Which decision chose the pages: `auto` (the engine's suspicion-plus-sample
     * selection) or `explicit` (the caller named them). The four fields after it
     * describe the automatic decision and are **null** when it did not run —
     * never zero, which would read as an automatic selection that found nothing.
     */
    mode: "auto" | "explicit";
    selected: number;
    budget: number | null;
    suspects: number | null;
    sampled: number | null;
    truncated: boolean | null;
  };
}

/** What `POST /crawls/:id/render` (and `crawl_render`) accepts as a body. */
export interface RenderCrawlInput {
  /**
   * The pages to render, in place of the automatic selection. Absent is the
   * default and leaves the pass exactly as it was.
   */
  urls?: string[];
}

/**
 * What a group says when the rule that produced it CAPPED its listing.
 *
 * Absent — the empty case — means `count` is the whole truth: the rule listed
 * every case it found. Present, `count` is only how many rows the rule wrote,
 * and the magnitude of the problem is the other field: `total` where the rule
 * counted every case exactly (a `count(*) over ()` beside a capped listing),
 * `atLeast` where counting the rest would have cost precisely what the cap
 * exists to save, so the number says how many were SEEN and nothing about how
 * many exist. The two shapes are the rules' own `TruncationNote` contract
 * (`src/rules/query/crawl-evidence.ts`), carried to the wire unweakened: a
 * reader may render "and N more" from `total` and only "and at least N more"
 * from `atLeast`.
 *
 * The distinction is not pedantry. `links.orphan` reports 200 on a site with
 * 222 orphans, and `hreflang.alternates-not-crawled` — the one rule that stops
 * LOOKING rather than stops listing, so its number is a floor and the real one
 * is unknown at the cap's price — reports what it saw; without this field both
 * read as exact, and an audit quotes a floor as a fact (the Phase 6 gate's D-1
 * — an auditor did exactly that, and had to reconstruct the real magnitude from
 * a metric). `content.near-duplicate` was the second `atLeast` rule until Phase
 * 19 §11 made it count in SQL; it writes an exact `total` now.
 */
export type IssueTruncation =
  | { truncated: true; total: number; atLeast?: never }
  | { truncated: true; atLeast: number; total?: never }
  /** No note: nothing was capped, and no field is added to the group. */
  | { truncated?: never; total?: never; atLeast?: never };

/**
 * One rule's findings on one crawl, as the agent's triage view.
 *
 * The count and the severity are FACTS from the `issues` rows; the checkIds,
 * category and title are COPY, joined from the registry at read time. Neither
 * half is stored twice: the API layer holds no rule copy of its own, so a rule
 * whose title changes changes here with it and nowhere else.
 */
export type IssueGroup = {
  ruleId: string;
  checkIds: string[];
  severity: string;
  /**
   * The reader's axes (Phase 27a): the rule's type and priority after the
   * crawl's overrides, joined at read time like the copy (`triage.ts` plus
   * `crawls.judgement_jsonb`). Each `…Overridden` flag is present, and `true`,
   * only when the crawl's judgement block sets that value; absent otherwise.
   */
  type: IssueType;
  priority: Priority;
  typeOverridden?: true;
  priorityOverridden?: true;
  category: string;
  title: string;
  /**
   * How many rows this group holds — which is the number of cases found only
   * when no `truncated` field sits beside it.
   */
  count: number;
  /** At most `ISSUE_SAMPLE_URLS`, ascending — a sample, never the slice. */
  sampleUrls: string[];
} & IssueTruncation;

/**
 * Read a rule's truncation note off the `truncated` key of whichever of its
 * findings carries one (the last, by `noteOnLast`).
 *
 * VALIDATED, never cast: the note crosses from a rule's evidence blob — a
 * `jsonb` column, so anything at all by the time it is read back — into a
 * number a client will quote to a site owner. The `crawl-evidence` parsers set
 * the precedent and the reason is the same: a shape that does not match is a
 * defect to surface, not a value to coerce. Malformed is therefore LOUD (hard
 * rule 7): the alternative is dropping the note, and a dropped note reads as
 * "count is the total", which is the exact untruth this field exists to stop.
 *
 * The note's own `reported` is deliberately ignored. `count` is measured from
 * the rows this query actually grouped, and under a `pageType` filter the two
 * legitimately differ — see `listIssues` for what the pair means then.
 */
function truncationOf(raw: unknown, ruleId: string): IssueTruncation {
  if (raw === null || raw === undefined) return {};
  const bad = (why: string): never => {
    throw new Error(
      `rule '${ruleId}' wrote a truncation note that ${why}: ` +
        `${JSON.stringify(raw)} matches neither shape of TruncationNote`,
    );
  };
  if (typeof raw !== "object" || Array.isArray(raw)) return bad("is not an object");
  const note = raw as Record<string, unknown>;
  const magnitude = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;
  const total = note["total"];
  const atLeast = note["atLeast"];
  if (magnitude(total) && atLeast === undefined) return { truncated: true, total };
  if (magnitude(atLeast) && total === undefined) return { truncated: true, atLeast };
  return bad("names neither a whole-number 'total' nor a whole-number 'atLeast'");
}

/**
 * One rule's fired state on ONE crawl — the field that makes the catalog a
 * report rather than a list.
 *
 * `count` is the rows the rule wrote for that crawl, and **zero is a real
 * value**: on a judged crawl it says the rule ran over this site and found
 * nothing. The state that is NOT a count is `null` on the rule's `fired` field,
 * which says no rules pass has completed — see `CatalogRule.fired`.
 *
 * `atLeast` is present, and always `true`, when the rule CAPPED its listing:
 * `count` is then a floor rather than the number of cases, so a UI must render
 * it as "3 or more" and never as "3". It is read off the same truncation note
 * `listIssues` reads (`truncationNote` / `truncationOf`) rather than derived a
 * second time — one note, two surfaces, no chance of them disagreeing about
 * whether a number is exact.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY is the magnitude itself. `issues_list`
 * owns that, because there it is one row of a triage view a reader is already
 * looking at; here it would be a second, subtly different number on every row
 * of a checklist. The flag says "this count is not the whole story"; the tool that
 * tells the rest of the story is named in the description.
 *
 * ## `measuresOnly`, and the claim it stops the catalog making
 *
 * Present, and always `true`, on a rule whose `kind` is `metric`. A metric rule
 * **measures rather than finds: it writes no issues** — the same sentence
 * `findingRule` refuses `issues_list` and `issue_urls` with when a caller names
 * one — so its `count` is 0 on every judged crawl, structurally, whatever the
 * site is like.
 *
 * Without the flag the catalog would state in a payload exactly what that route
 * refuses to state at all: `{count: 0}`, in the identical shape a genuine clean
 * check uses. A dashboard would render "passed" against a rule that never had a
 * verdict to give. Saying so only in the MCP tool description is not enough —
 * that is the one transport a UI author does not read — so the discriminator is
 * on the payload, where every consumer sees it. The numbers such a rule DID
 * produce are in the metrics listing.
 */
export interface RuleFired {
  count: number;
  atLeast?: true;
  measuresOnly?: true;
}

/**
 * One rule as the catalog renders it: its identity, its copy, and — when a
 * crawl was named — what it found there.
 *
 * The copy is the CURRENT ruleset's, joined live from the registry exactly as
 * `IssueGroup`'s is. Nothing here is stored, so a rule whose explanation is
 * rewritten is rewritten on every surface at once.
 */
export interface CatalogRule {
  id: string;
  kind: AnyRule["kind"];
  severity: Severity;
  /**
   * The rule's type and priority (Phase 27a) — ABSENT on a metric rule, which
   * produces no findings to triage. With a crawl named they are that crawl's,
   * after its overrides, and each `…Overridden` flag is present (`true`) only
   * when the crawl's judgement block sets the value.
   */
  type?: IssueType;
  priority?: Priority;
  typeOverridden?: true;
  priorityOverridden?: true;
  /**
   * Present, and `true`, only with a crawl named and only on a rule that crawl's
   * judgement disables. A disabled rule still RUNS and its findings are still
   * stored, so `fired.count` beside it counts them — they are left out of
   * `issues_list`, the CSV views and the export, and re-enabling the rule
   * brings them back without a re-run.
   */
  disabled?: true;
  category: RuleCategory;
  checkIds: string[];
  title: string;
  explanation: string;
  howToFix: string;
  /**
   * THE RULE'S REPORT, column by column — the four standard columns every
   * finding row carries, then what this rule declares (`columnsFor`).
   *
   * ABSENT on a metric rule, which writes a table of its own shape into
   * `metrics` rather than finding rows into `issues`: there is no finding row
   * for a column to be a column of, and `measuresOnly` on `fired` is the flag
   * that says so. Present on every rule that finds, and never empty — the four
   * standard columns are in it even for a rule whose own report is only the
   * address.
   *
   * It is here so a client can lay out a rule's table BEFORE it asks for the
   * rows: the same list `issue_urls` serves with its rows, from the same
   * function, so a header drawn from the catalog and one drawn from the listing
   * cannot disagree.
   */
  columns?: RuleColumn[];
  /**
   * THE METRIC'S TABLE, header first — `columns`' mirror, and present on
   * exactly the rules `columns` is absent from.
   *
   * `columns` is the header of the metric table (`metric_table`), in order, with
   * the row's scope leading it; `summary` is the labels of the site-level
   * scalars printed above the table. Both come from the rule's own declaration
   * through the same function the shaped table uses, so a header drawn from the
   * catalog and one drawn from the rows cannot disagree.
   *
   * ABSENT on every rule that finds, which has `columns` instead. The two fields
   * are never both present and never both absent.
   */
  table?: { columns: MetricColumn[]; summary: MetricColumn[]; order?: number };
  /**
   * Present ONLY on a NOT MEASURED marker, and then the registry's own reason
   * string — the crawl condition whose silence the marker explains. Absent on
   * every ordinary rule: never `null`, never `""`, so `"marker" in rule` and a
   * truthiness test agree (`RuleMeta.marker`, which the flag is copied from).
   *
   * IT IS NOT A SEVERITY AND NOT A COUNT. A marker's findings say that a check
   * COULD NOT BE ANSWERED on this crawl — `links.orphan-skipped`,
   * `resources.not-fetched`, `crawl.blocked` and their siblings — so they are
   * facts about the crawl, not about the site. Every one of them is `info`, and
   * a consumer that bands by severity alone therefore files them beside real
   * notices, where a reader counts them as things to fix. The registry knows
   * which rules those are; without this field the wire does not, and no
   * consumer can tell them apart without hard-coding a list that goes stale the
   * next time a marker is added. The demo page routes on exactly this flag
   * (`src/demo/index.html`, `#band-not-checked`).
   */
  marker?: string;
  /**
   * THREE STATES, AND THEY ARE THREE DIFFERENT SENTENCES.
   *
   *  - **absent** — no crawl was named. This is the checklist skeleton: what
   *    the engine CAN look for, before anybody has looked.
   *  - **null** — a crawl was named and it has never been judged
   *    (`crawls.rules_run_at` is null). Nothing is known about this rule on
   *    this site.
   *  - **`{count}`** — a crawl was named and a rules pass completed over it.
   *    `count: 0` is then a measurement: this rule looked and found nothing.
   *
   * Collapsing the last two — answering 0 for a crawl nobody judged — would
   * paint a clean dashboard for a site nobody has examined, which is hard rule
   * 7's failure in its UI-facing form.
   */
  fired?: RuleFired | null;
}

/** The whole ruleset, as `GET /rules` and `rules_catalog` answer it. */
export interface RulesCatalog {
  /**
   * The ruleset the COPY in this answer comes from — always the engine's
   * current one, including when a crawl is named. A crawl judged under an older
   * ruleset is described by today's rules; where it holds rows for a rule that
   * no longer exists, the catalog refuses rather than dropping the count (see
   * `firedByRule`).
   */
  rulesetVersion: string;
  rules: CatalogRule[];
  /**
   * Present only with a crawl named: whether that crawl's stored judgement is
   * stale against its current block (`JudgementStale`), and the thresholds the
   * copy in this answer was rendered with — the ones the crawl's last rules run
   * used, or, on a crawl never judged, its current block's.
   */
  judgementStale?: JudgementStale;
  thresholds?: Record<ThresholdName, number>;
}

/**
 * One finding, at URL level: the sf-action-plan tab feed.
 *
 * `evidence` is the stored `details_jsonb` verbatim — what the rule wrote,
 * including its own `pageUrl` — because an evidence blob is the rule's
 * testimony and the API is not entitled to edit it. It is tenant-safe by the
 * registry's discipline (a rule builds evidence from crawled rows, never from a
 * stack or a path), and the WRAPPER is a closed shape all the same.
 */
export interface IssueUrl {
  /**
   * The finding's URL, as `address` under the name this surface has always used.
   *
   * KEPT AS AN ALIAS, not as a second fact: it is the same string `address`
   * carries, byte for byte. Phase 20 renamed the column to `address` because
   * that is what a report reader calls it (Screaming Frog's per-issue exports
   * head their first column `Address`, and this row is now a report row rather
   * than a JSON pair) — and a rename that dropped `url` would break every
   * client reading this listing today for no gain. It stays for one release;
   * `docs/talos-surface.md` §4.4 says when it goes.
   */
  url: string | null;
  /** Null for a site-wide finding: a fact about the crawl, not about a page. */
  address: string | null;
  /**
   * THE THREE STANDARD COLUMNS after the address, derived from the `pages` row
   * this finding names (`issues.page_id` -> `pages`), never from the evidence.
   *
   * **All three are null when there is no page row to derive them from**, and
   * that is two different situations rather than one:
   *
   *  - a SITE-SCOPED finding (`sitemap.missing`, `robots.check-skipped`, every
   *    marker) names no URL at all, so `address` is null beside them;
   *  - a finding that names a URL the crawl never made a `pages` row for —
   *    `host.http-serves-200` on a probed host variant, `sitemap.uncrawled` on
   *    a URL the frontier never reached, `robots.blocks-sitemap-urls` on one
   *    robots.txt kept out — has an `address` and nulls here. Null is "nobody
   *    fetched this URL", never "it was fine".
   */
  statusCode: number | null;
  indexability: Indexability | null;
  indexabilityStatus: IndexabilityStatus | null;
  /**
   * The rule's own testimony, verbatim, INCLUDING its `pageUrl` key — unchanged
   * by Phase 20 and deliberately not flattened into the row.
   *
   * The response's `columns` is what tells a client which of these keys to
   * print and under what heading: the four standard columns above are read off
   * the ITEM, and every other column's `key` is read off `evidence`. Flattening
   * the blob into the row would have made those two lookups one — and would
   * have let a rule that recorded a field called `statusCode` (nine of them do,
   * and it is the same number as the standard column by construction) silently
   * replace a column derived from the page row. The blob stays a blob.
   */
  evidence: Record<string, unknown>;
}

/**
 * THE FOUR COLUMNS EVERY FINDING ROW BEGINS WITH, in order, with the headings a
 * client prints.
 *
 * They are the surface's, not any rule's: `address` is the finding's own URL and
 * the other three are `indexabilityOf` over the `pages` row it names. Every
 * rule's declared columns follow them (`columnsFor`), and `defineRule` refuses a
 * rule that declares one of these keys itself — one heading, one source.
 *
 * The labels are Screaming Frog's, exactly, because these four head every
 * per-issue export it writes and the people reading these reports read those
 * every week.
 */
export const STANDARD_ISSUE_COLUMNS: ReadonlyArray<RuleColumn> = [
  { key: "address", label: "Address" },
  { key: "statusCode", label: "Status Code" },
  { key: "indexability", label: "Indexability" },
  { key: "indexabilityStatus", label: "Indexability Status" },
];

/**
 * One rule's report, column by column: the standard four, then what the rule
 * itself declares.
 *
 * ONE FUNCTION, read by the JSON listing, the CSV writer, the rules catalog and
 * the demo — so a client that renders the table from `columns` and a spreadsheet
 * that opens the export see the same headings in the same order.
 */
export function columnsFor(rule: AnyRule): RuleColumn[] {
  return [...STANDARD_ISSUE_COLUMNS, ...(rule.columns ?? [])];
}

/**
 * One rule's findings as a table: the columns to print, then the rows.
 *
 * `columns` is on the RESPONSE rather than on every row, because it is the same
 * list for every row of one rule's listing and a client renders a header once.
 * It is served with the first page and with every page after it — a caller that
 * follows a cursor gets the header again rather than having to keep it, which
 * costs a few hundred bytes and removes the state.
 */
export interface IssueUrlPage extends Page<IssueUrl> {
  columns: RuleColumn[];
}

/**
 * One row of the companion inlinks report: an internal link that points at
 * something one of the three target rules found (`INLINK_REPORT_TARGETS`).
 *
 * `statusCode` is the TARGET's, read off its own crawled `pages` row — the same
 * number the finding carries — because the question the row answers is "which
 * page links to this broken URL, and how broken is it". On a
 * `robots.blocks-internal-urls` row it is always null: the target was never
 * requested, so it has no status, and none is invented.
 */
export interface IssueInlink {
  source: string;
  destination: string;
  /** Null is a link with no anchor text at all — an image link, a bare `<a>`. */
  anchor: string | null;
  statusCode: number | null;
}

/**
 * The inlinks report's columns. Fixed rather than declared per rule, because
 * the report is one shape: it is a view of the `links` table, not of a rule's
 * evidence, and every rule that has one has the same one. Screaming Frog's
 * headings, for `STANDARD_ISSUE_COLUMNS`' reason.
 */
export const INLINK_COLUMNS: ReadonlyArray<RuleColumn> = [
  { key: "source", label: "Source" },
  { key: "destination", label: "Destination" },
  { key: "anchor", label: "Anchor" },
  { key: "statusCode", label: "Status Code" },
];

/**
 * WHICH RULES HAVE AN INLINKS REPORT, and the predicate on the TARGET row each
 * one's links point at (aliased `tgt`).
 *
 * A map rather than a flag on the rule, and deliberately short: an inlinks
 * report is only meaningful for a rule that reports a TARGET the site links to.
 * Every other rule reports the page itself, where "which pages link here" is a
 * different question from the finding and `/urls` is the whole answer. Each
 * entry is the rule's OWN predicate, so the report cannot list links to pages
 * the rule did not fire on:
 *
 *  - the two rules `linkTargetClassFindings` defines, by the class it passes;
 *  - `robots.blocks-internal-urls` (Phase 23 T3) by `ROBOTS_BLOCKED` — the
 *    `disallowed` class AND the robots reason, never the class alone, which
 *    would list links to URLs our own url-policy refused as robots blocks.
 *    Its `statusCode` cell is always null: the target was never requested.
 */
const CLIENT_ERROR: FetchClass = "client_error";
const SERVER_ERROR: FetchClass = "server_error";
export const INLINK_REPORT_TARGETS: Readonly<Record<string, SQL>> = {
  "links.broken-internal": sql`tgt.fetch_class = ${CLIENT_ERROR}`,
  "links.to-server-error": sql`tgt.fetch_class = ${SERVER_ERROR}`,
  "robots.blocks-internal-urls": ROBOTS_BLOCKED("tgt"),
};

/** The inlinks report as a page: its columns, then its rows. */
export interface IssueInlinkPage extends Page<IssueInlink> {
  columns: ReadonlyArray<RuleColumn>;
}

/**
 * The three sets a cross-crawl diff partitions a rule's URLs into.
 *
 * Exported because it is the `set` argument's vocabulary on both transports and
 * the refusal that names the accepted values reads it, so there is one list.
 */
export const COMPARE_SETS = ["new", "resolved", "persisting"] as const;
export type CompareSet = (typeof COMPARE_SETS)[number];

/** One side of a comparison: which crawl, judged when, under what. */
export interface CompareSide {
  crawlId: string;
  siteUrl: string;
  /** Never null on a side that got this far — an unjudged crawl is refused. */
  rulesRunAt: string;
  /**
   * The ruleset versions STAMPED ON THIS CRAWL'S FINDINGS, sorted — not the
   * `crawls.ruleset_version` column.
   *
   * The two genuinely disagree in the reference data: `crawl_02ff6f7a`'s crawl
   * row says `0.6.0` (the ruleset at CRAWL time) while every one of its 17,659
   * findings says `0.7.0` (the ruleset that JUDGED it, months later). A
   * comparison is about the findings, so the findings' own stamp is the honest
   * source and the crawl row's is not read here at all.
   *
   * Empty when the crawl wrote no findings: there is then no record of which
   * ruleset judged it, which is a fact about the evidence rather than a version
   * to compare — see the `ruleset-unrecorded` caveat.
   *
   * `[""]` is the OTHER shape of the same absence: `issues.ruleset_version`
   * defaults to the empty string for rows written before the stamp existed, and
   * that is not a version either. `rulesetCaveat` treats both as unrecorded, so
   * two unstamped crawls can never come back `comparable: true` on the strength
   * of `"" === ""`.
   */
  rulesetVersions: string[];
  /**
   * The listing cap this crawl's rules ran under — 200 when nobody chose, null
   * for an uncapped (billed) run. Two crawls with different caps produce
   * different counts on the SAME site under the SAME ruleset, so it is on the
   * side rather than left to be inferred from a count that moved.
   */
  findingCap: number | null;
  /** `issues` rows in this crawl — the number the per-rule counts sum to. */
  findingsCount: number;
}

/**
 * One thing the engine knows about this comparison that the numbers do not say.
 *
 * A code and a sentence, not a sentence alone: a dashboard greys a column on the
 * code and an agent quotes the message, and neither should have to parse the
 * other's half.
 */
export interface CompareCaveat {
  code:
    | "ruleset-mismatch"
    | "ruleset-unrecorded"
    | "ruleset-mixed"
    | "finding-cap-differs"
    | "severity-changed"
    | "judgement-overrides";
  message: string;
}

/** One rule's change between two crawls of one site. */
export interface CompareRule {
  ruleId: string;
  /**
   * The severity the HEAD crawl's rows carry — the current reading — falling
   * back to the base's for a rule that fired only in the base. A severity that
   * MOVED between the two is reported here at its head value and named in a
   * `severity-changed` caveat; it is never averaged or silently preferred.
   */
  severity: string;
  category: string;
  checkIds: string[];
  title: string;
  /** `issues` ROWS, the number `issues_list` reports for this rule. */
  baseCount: number;
  headCount: number;
  /**
   * DISTINCT URLS, which is what the diff is over. `baseCount` and `baseUrls`
   * differ for every rule that can fire more than once on a page —
   * `images.oversized` files one finding per IMAGE and wrote 833 rows across 157
   * URLs on the reference crawl — and the two invariants a consumer may rely on
   * are stated in terms of the URL counts: `headUrls == new + persisting` and
   * `baseUrls == resolved + persisting`.
   */
  baseUrls: number;
  headUrls: number;
  /** URLs the head has and the base did not. */
  new: number;
  /** URLs the base had and the head does not. */
  resolved: number;
  /** URLs both crawls carry for this rule. */
  persisting: number;
  /**
   * Whether that side's rule CAPPED its listing (the `truncated` note
   * `issues_list` reports). A capped side's absent URLs are absent because the
   * rule stopped writing, not because the site was fixed, so a `new`/`resolved`
   * count beside a true here is not a change in the site.
   */
  baseTruncated: boolean;
  headTruncated: boolean;
}

/** Two crawls of one site, rule by rule. */
export interface CrawlComparison {
  base: CompareSide;
  head: CompareSide;
  /**
   * Whether anything the engine can check says the two sides' counts were
   * produced under different conditions. False when the ruleset versions differ
   * (or cannot be read) or the finding caps differ; every reason is in
   * `caveats`. It is NOT a refusal — the counts are returned either way.
   *
   * True is the weaker claim it sounds: it says the two stamps agree, not that
   * the numbers mean the same thing. Engine behaviour has changed under one
   * version before — see the NOT ROW-COMPARABLE box in docs/gates/phase-8.md
   * §7.2, where commit `9fdaafa` changed what a `page_type` value means with
   * `RULESET_VERSION` held at 0.6.0.
   */
  comparable: boolean;
  caveats: CompareCaveat[];
  /**
   * Every rule with findings in either crawl, ordered by severity then rule id
   * — `issues_list`'s order, so a UI puts the same rule in the same place twice.
   *
   * NOT PAGINATED, for `rulesCatalog`'s reason: the list is bounded by the
   * ruleset (86 rules), not by the crawl, and it carries no copy blob — a
   * comparison of the reference crawls is 22 rows.
   */
  rules: CompareRule[];
}

/** One URL in one of a comparison's three sets. */
export interface CompareUrl {
  /** Null for a site-wide finding, which compares by rule presence alone. */
  url: string | null;
}

/**
 * ONE METRIC AS A TABLE — the metric side of `issue_urls`, and the shape every
 * surface that PRINTS a metric reads.
 *
 * `metrics_get` serves a metric's stored `value` verbatim, which is right for an
 * agent and unusable for a table: the object's shape belongs to the metric, and
 * five different shapes meant every consumer hand-writing five renderers. This
 * is the same numbers, shaped ONCE (`shapeMetricTable`, from the rule's own
 * `table` declaration) into the header and rows a client draws. The demo, the
 * `metric_table` CSV and the `metric_table` tool all read this one function, so
 * a number's heading is the same string wherever it is printed.
 *
 * `summary` is the site-level scalars that sit ABOVE the table rather than in
 * it — `url.param-volumes`' four counts of the site's parameters, which would
 * otherwise be repeated on every parameter row. Empty on the twelve metrics that
 * have none.
 *
 * `note` IS PRESENT EXACTLY WHEN `rows` IS EMPTY, and it says which kind of
 * empty this is: a judged crawl whose metric wrote nothing, or a metric that
 * wrote its rows and whose list inside them is empty. An empty table with no
 * word about why is the silence hard rule 7 forbids — and the case that is NOT
 * in this shape at all is a crawl nobody judged, which is a refusal (see
 * `metricTable`).
 */
export interface MetricTableOut {
  metricId: string;
  title: string;
  explanation: string;
  howToFix: string;
  summary: MetricSummaryValue[];
  columns: MetricColumn[];
  rows: Record<string, MetricCell>[];
  note?: string;
  /**
   * Whether the crawl's judgement block has moved since the rules run that
   * wrote these rows (`CrawlDetail.judgementStale`). The rows are that run's,
   * served as written.
   */
  judgementStale: JudgementStale;
}

/** One metric row, with the registry's copy joined — the quotable table. */
export interface MetricRow {
  metricId: string;
  scope: string;
  scopeValue: string;
  value: unknown;
  title: string;
  explanation: string;
  checkIds: string[];
  category: string;
}

/**
 * One page, slim: what a triage question asks of a page and no more.
 *
 * Deliberately NOT the row. `pages` has sixty columns — content hashes,
 * simhashes, heading vectors, raw canonical strings — and an endpoint that
 * returned them would be an export in listing clothes (obligation 1) as well as
 * a serialisation surface nobody audited. The fields here are the ones a filter
 * or a follow-up question needs; the whole row is what the export is for.
 */
export interface PageRow {
  url: string;
  statusCode: number | null;
  fetchClass: string;
  pageType: string | null;
  /** `is_indexable`; null when the crawl never got a verdict for this URL. */
  indexable: boolean | null;
  depth: number;
  /**
   * Clicks from the home page: the shortest chain of internal links that
   * reaches this URL. NULL means no chain does — the page is unreachable, which
   * is a finding and never a zero (see `pages.click_depth`). Null on every row
   * of a crawl the rules have not been run over since Phase 7, because the
   * derivation that computes it runs there.
   */
  clickDepth: number | null;
  /** How the crawler found this URL: seed, link, sitemap or redirect. */
  discoveredVia: string;
  wordCount: number | null;
  /**
   * The same count minus the words the page's own markup says are not
   * displayed. Null on a page no Phase-7-or-later analyzer ran on.
   */
  renderableWordCount: number | null;
  rendered: boolean;
  /** The browser's `innerText` count — what a reader sees. Read by no rule. */
  renderedWordCount: number | null;
  /**
   * The analyzer's renderable count over the post-JavaScript DOM: the rendered
   * side of `content.csr-dependent`, comparable with `renderableWordCount`
   * because one function produced both. Null on an unrendered page and on every
   * page of a pre-Phase-8 crawl.
   */
  renderedRenderableWordCount: number | null;
  /** Why an ATTEMPTED render produced nothing. Null is not "it worked". */
  renderError: string | null;
  /**
   * When the crawl fetched this page (migration 0016), or null on a row written
   * before the column existed. Serialised as an ISO timestamp by both
   * transports, like every other instant this surface publishes.
   */
  fetchedAt: Date | null;
  /**
   * The 5xx RE-VERIFICATION pass's second observation, in the `fetchClass`
   * vocabulary. NULL MEANS NOBODY ASKED — the pass only ever asks about a page
   * whose first fetch was `server_error`, so null is what a healthy page carries.
   * `server_error` again is a confirmed outage; anything the site answered that
   * is not a 5xx is the transient case `http.server-error-transient` reports;
   * `timeout`, `network_error`, `blocked` and `disallowed` are the second look
   * learning nothing, and the finding stays `critical`.
   */
  recheckFetchClass: string | null;
  /** The status the second look got. Null when there was no response at all. */
  recheckStatusCode: number | null;
  /**
   * Why the second look ended as it did, or why it was never made: the fetch
   * layer's own sentence, and `recheck-cap` on a row the pass's budget stopped
   * short of. Null with a null class means nobody asked at all.
   */
  recheckReason: string | null;
  /** When the pass settled this row. Null exactly when `recheckFetchClass` is. */
  recheckAt: Date | null;
}

/** The datasets `GET /crawls/:id/export` can write. */
export type ExportDataset = "issues" | "pages" | "metrics";
export const EXPORT_DATASETS: readonly ExportDataset[] = ["issues", "pages", "metrics"];

/** What an export answers with: where the file is, not what is in it. */
export interface ExportResult {
  dataset: ExportDataset;
  /**
   * Absolute path, under the server's export directory. One file per (crawl,
   * dataset): a re-export replaces it rather than adding a second copy.
   */
  path: string;
  rows: number;
  /** Size of the gzipped file on disk. */
  bytes: number;
  /**
   * Present only on the `issues` dataset: the rules the crawl's judgement
   * disables, whose stored findings the file leaves out (sorted; `[]` when
   * none). Without it a reader could not tell "filtered out" from "did not
   * fire".
   */
  disabledRules?: string[];
}

/**
 * What a CSV export answers with. A DIFFERENT SHAPE from `ExportResult`, and
 * deliberately: the JSONL answer is a contract callers already parse, and
 * growing a `format` key onto it would change a response nobody asked to
 * change. The two are told apart by their own keys — `dataset` on one, `format`
 * and `view` on the other.
 */
export interface CsvExportResult {
  format: "csv";
  view: CsvViewName;
  /** Present only on `issue_urls`, which is a view of ONE rule. */
  ruleId?: string;
  /** Present only on `metric_table`, which is a view of ONE metric. */
  metricId?: string;
  path: string;
  /** DATA rows. The header is always written and is never counted here. */
  rows: number;
  bytes: number;
  /**
   * The rules the crawl's judgement disables, whose findings the file leaves
   * out — present on the four views that read findings (`issues`,
   * `issue_urls`, `issues_overview`, `crawl_overview`), as on the `issues`
   * JSONL dataset's answer, so a reader can tell "filtered out" from "did not
   * fire". Absent on the views that read no findings.
   */
  disabledRules?: string[];
}

/** A prepared CSV stream: validated, not yet read. */
export interface CsvStream {
  view: CsvViewName;
  ruleId: string | null;
  /** The metric `metric_table` was asked for; null on every other view. */
  metricId: string | null;
  /** Deterministic per (crawl, view, rule) — what a browser saves it as. */
  filename: string;
  /**
   * The disabled rules the file leaves out, read with the rows' judgement;
   * null on a view that reads no findings (`CsvExportResult.disabledRules`).
   */
  disabledRules: string[] | null;
  /**
   * The file, record by record, header first.
   *
   * ONE YIELD IS ONE RECORD, never one line: a cell holding a newline is quoted
   * and spans two lines while remaining one row. That is why the row count is
   * yields minus the header and not a line count.
   */
  records(): AsyncGenerator<string>;
}

/** What the two halves of `export_crawl` were asked for, after validation. */
type ExportRequest =
  | { format: "jsonl.gz"; dataset: ExportDataset }
  | { format: "csv"; view: CsvViewName; ruleId: string | null; metricId: string | null };

/** Sample URLs carried on an issue group. Five is a sample; more is a slice. */
export const ISSUE_SAMPLE_URLS = 5;

/**
 * Rows read per round trip while exporting.
 *
 * The memory contract (hard rule 6) applies to a 50k-page crawl's export
 * exactly as it applies to the crawl: RAM is O(batch), never O(rows). The
 * export reads a keyset page, writes it into the gzip stream, and lets it go —
 * there is no array of findings anywhere in this file.
 */
export const EXPORT_BATCH = 500;

/**
 * Severity as a sort key, in SQL.
 *
 * Ordering happens in the database, not in JavaScript: a keyset cursor compares
 * against the same expression the ORDER BY uses, so the two must be one
 * expression rather than two implementations that agree today. `else 3` is
 * unreachable — every severity is written from a rule's own identity, which
 * `defineRule` constrains to the three — and it is there so that a row with a
 * severity the ruleset cannot produce sorts last and stays VISIBLE, rather than
 * getting a null rank that a keyset comparison would silently skip.
 */
const SEVERITY_RANK = sql`case i.severity when 'critical' then 0 when 'warning' then 1 when 'info' then 2 else 3 end`;

/**
 * The same order as `SEVERITY_RANK`, in JavaScript — for the one listing that
 * is sorted in memory because its rows are the registry rather than a table
 * (`rulesCatalog`).
 *
 * A `Record<Severity, number>` and not a lookup with a default: `Severity` is
 * closed, so a fourth severity would fail to compile here instead of silently
 * sorting somewhere. That is the property `SEVERITY_RANK`'s `else 3` buys in
 * SQL, where the value arrives from a row this process did not write.
 */
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * THE CATALOG'S ORDER: severity then id for the rules that FIND, and the
 * declared display order then id for the rules that MEASURE.
 *
 * The rules that find are unchanged and stay in `listIssues`' own order, so a UI
 * rendering both puts the same rule in the same place twice — that property was
 * the whole reason for the severity sort and nothing here touches it.
 *
 * The metrics sort among THEMSELVES, and the reason they can is that they are
 * all `info` and none of them ever appears in `listIssues`: a metric writes no
 * finding row, so no other listing has an opinion about where it goes. Ordering
 * them by id put `site.health` — the census every other metric table is a part
 * of — tenth of fourteen, which is an accident of the alphabet rather than a
 * decision. So the decision is declared, on the table itself
 * (`MetricTableCommon`), and read here.
 *
 * They form ONE BLOCK at the end of the `info` band rather than interleaving
 * with the info findings by id, because a client reading the catalog top to
 * bottom draws the metric section from a contiguous run — the demo does exactly
 * that (src/demo/index.html), and it invents no order of its own.
 */
function catalogOrder(a: AnyRule, b: AnyRule): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  // Findings before metrics inside a band. Both are the same kind or this is
  // the answer; only then is either sub-order asked for.
  const kindRank = (rule: AnyRule): number => (rule.kind === "metric" ? 1 : 0);
  const byKind = kindRank(a) - kindRank(b);
  if (byKind !== 0) return byKind;
  if (a.kind === "metric" && b.kind === "metric") {
    const byOrder = metricTableOrder(a.table) - metricTableOrder(b.table);
    if (byOrder !== 0) return byOrder;
  }
  return a.id.localeCompare(b.id);
}

/**
 * `SEVERITY_ORDER` for a severity that came off a ROW rather than out of the
 * registry — the same `else 3` `SEVERITY_RANK` uses, and for the same reason: a
 * value this ruleset cannot produce sorts last and stays visible rather than
 * being dropped or crashing the sort.
 */
function severityRank(severity: string): number {
  return severity in SEVERITY_ORDER ? SEVERITY_ORDER[severity as Severity] : 3;
}

/**
 * `crawls.site_url`'s hostname, in SQL.
 *
 * Every row this engine writes went through `normalizeUrl`, so `site_url` is
 * `scheme://host[:port]/path` with the host already lowercased — but the pattern
 * is written to survive a row we did not write: it accepts (and discards) a
 * userinfo section and it keeps an IPv6 literal's brackets, which is the
 * spelling `URL.hostname` and therefore `hostnameSpellings` both use. A
 * `site_url` the pattern cannot read yields null, which matches no family and so
 * hides the row from a site filter rather than offering it to the wrong site.
 */
/**
 * The one fetch class the recheck block is about, TYPED so a rename in
 * `src/crawl/fetch-page.ts` stops compiling here rather than turning
 * `recheckCoverage`'s counts silently to zero. The class names beside it are
 * imported sets (`RECHECK_CLEARED`) for the same reason.
 */
const SERVER_ERROR_CLASS: FetchClass = "server_error";

/**
 * The first-observation classes `crawl_status.recheck.noResponse` counts:
 * the rule's own `NO_RESPONSE` set, so `noResponse.pages` is by construction the
 * rows the `http.no-response` pair judges. EXPORTED for the cross-module test
 * (test/rules/status.test.ts) that pins it, the pass's no-response walk and the
 * rule to one set.
 */
export const NO_RESPONSE_CLASSES: readonly string[] = [...NO_RESPONSE];

/**
 * What `markCrawlFailed` writes into `crawls.failure_reason` (migration 0017).
 *
 * A CONSTANT, and exported, because it is the one failure sentence on this
 * surface that nothing threw: an operator retired a row whose worker was gone,
 * and the sentence has to say that rather than imply a crawl that broke. A test
 * asserting it by re-typing the prose would go quietly green the day somebody
 * reworded it (the `RESOURCE_CAP_REASON` discipline, one column along).
 */
export const MARKED_FAILED_REASON =
  "marked failed by an operator: no worker held it";

const CRAWL_HOSTNAME = sql`substring(lower(${crawls.siteUrl}) from '^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?(\\[[^\\]]*\\]|[^:/?#]*)')`;

/**
 * The hostnames that ARE this site, for a caller-supplied URL — the crawler's
 * own list, never a second definition of it.
 *
 * Refuses anything that is not an http(s) URL by name. `normalizeUrl` is the
 * parse and the scheme check in one (it returns null for both), which is the
 * same step `startCrawl` takes on a seed.
 */
function siteFamily(siteUrl: string): string[] {
  const normalised = normalizeUrl(siteUrl.trim());
  if (normalised === null) {
    throw new ServiceError("VALIDATION", `siteUrl is not an http(s) URL: ${clip(siteUrl)}`);
  }
  return hostnameSpellings(new URL(normalised).hostname);
}

/**
 * Whether two site URLs name the same site, by the engine's one definition of
 * "the same site": the apex and its `www` twin, any scheme, any port.
 *
 * The comparison is `spellings(a) ∋ host(b)` rather than an equality of apexes,
 * so it keeps answering correctly if `hostnameSpellings` ever learns a third
 * spelling.
 */
function sameHostFamily(a: string, b: string): boolean {
  return hostnameSpellings(new URL(a).hostname).includes(new URL(b).hostname);
}

/**
 * A rule's truncation note for one crawl, as a scalar subquery — read
 * RULE-WIDE, correlated against whatever the enclosing query calls `i`.
 *
 * ONE EXPRESSION, TWO READERS. `listIssues` lifts the note onto a group and
 * `rulesCatalog` reduces it to "this count is a floor"; both must agree about
 * WHICH note belongs to a rule, or the triage view and the checklist would
 * disagree about whether the same number is exact. The rule-wide scoping (no
 * severity or page-type predicate) is deliberate and is argued in `listIssues`:
 * no filter may be able to hide a truncation.
 */
function truncationNote(crawlId: string): SQL {
  return sql`(select i2.details_jsonb->'truncated'
                from issues i2
               where i2.crawl_id = ${crawlId}
                 and i2.rule_id = i.rule_id
                 and i2.details_jsonb->'truncated' is not null
               limit 1)`;
}

/** The filters `GET /crawls/:id/issues` accepts. Every one is validated. */
export interface IssueQuery {
  severity?: string;
  checkId?: string;
  ruleId?: string;
  category?: string;
  pageType?: string;
  limit?: number;
  cursor?: string;
}

export interface MetricQuery {
  metricId?: string;
  scope?: string;
  scopeValue?: string;
  limit?: number;
  cursor?: string;
}

export interface PageQuery {
  pageType?: string;
  statusCode?: number;
  indexable?: boolean;
  rendered?: boolean;
  fetchClass?: string;
  discoveredVia?: string;
  limit?: number;
  cursor?: string;
}

interface QueueEntry {
  crawlId: string;
  /** The effective config, `allowPrivate` included — never the stored one. */
  config: CrawlConfig;
  /**
   * Whether this entry CONTINUES a crawl that has already run, rather than
   * starting one that has not.
   *
   * The runner treats the two identically — `resumeCrawl` is what it has always
   * called, because a queued crawl's frontier is empty and continuing an empty
   * frontier is a fresh run — so this exists for the log line and nothing else.
   * "crawl X starting" against a row with 4,000 pages already in it is the kind
   * of small lie that costs an operator an hour.
   */
  resuming: boolean;
}

/**
 * What a resume of one crawl would have to do — see `owedWork`, which is the
 * only place these numbers are produced and the docblock that argues them.
 */
interface OwedWork {
  /** Frontier rows never leased. */
  pending: number;
  /** Frontier rows a worker leased and did not come back for. */
  expired: number;
  /** `resources` rows with a null `fetch_class`, or 0 when the pass is off. */
  resources: number;
  /** Whether this crawl was configured with `fetchResources: false`. */
  resourcesOff: boolean;
  /** Crawled pages awaiting the render pass. NOT part of `total`. */
  renderPending: number;
  /** `pending + expired + resources`: what a continuation would consume. */
  total: number;
}

interface RunningCrawl {
  crawlId: string;
  controller: AbortController;
  done: Promise<void>;
}

export class ApiService {
  private readonly registry: Registry;
  private readonly log: (line: string) => void;
  /**
   * The registry, indexed for read-time copy joins — built ONCE per server.
   *
   * `buildRegistry()` runs `defineRule` over every rule in the ruleset. It is
   * cheap but it is not free, and a per-request rebuild would put it on the hot
   * path of every issues and metrics page an agent asks for. The rules are
   * immutable for the life of the process, so the index is too.
   */
  private readonly rules: Map<string, AnyRule>;
  /** Finding-rule ids by the check they claim, and by category. */
  private readonly findingRulesByCheck: Map<string, string[]>;
  private readonly findingRulesByCategory: Map<string, string[]>;
  /** Every claimed check / category, finding rules and metric rules alike. */
  private readonly allChecks: Set<string>;
  private readonly allCategories: Set<string>;
  private readonly exportDir: string;
  /**
   * Where this server's render passes keep their serialised documents — the
   * ROOT, under which the pass makes one directory per crawl.
   *
   * Resolved once, here, exactly as `exportDir` is and for the same reason: the
   * value is stored in `pages.rendered_html_path` and read back by a person who
   * will not be standing in this process's working directory. Unset means
   * `renders/` under it, which is what `RENDER_HTML_DIR` names.
   */
  private readonly renderDir: string;

  /**
   * Crawls this process is currently judging — one rules run at a time, per
   * crawl. See `runRulesForCrawl` for why the serialisation lives here rather
   * than in the database.
   */
  private readonly judging = new Set<string>();

  /** Crawls accepted by this process and not yet started, in FIFO order. */
  private readonly waiting: QueueEntry[] = [];
  private running: RunningCrawl | null = null;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly config: ServiceConfig,
  ) {
    // Built once, here: `buildRegistry` runs `defineRule` over every rule, so a
    // rule missing its client-facing copy throws at server construction rather
    // than at the first `POST /crawls/:id/rules`.
    this.registry = buildRegistry();
    this.rules = new Map(this.registry.all().map((rule) => [rule.id, rule]));
    this.findingRulesByCheck = new Map();
    this.findingRulesByCategory = new Map();
    this.allChecks = new Set();
    this.allCategories = new Set();
    for (const rule of this.registry.all()) {
      for (const check of rule.checkIds) this.allChecks.add(check);
      this.allCategories.add(rule.category);
      // Metric rules are indexed for the "claimed, but not by a finding rule"
      // refusal below and NOT as issue filters: no finding ever carries a
      // metric id, so a metric-only filter on `issues` is a question whose
      // answer is structurally empty, and an empty page would read as "this
      // site is clean".
      if (rule.kind === "metric") continue;
      for (const check of rule.checkIds) push(this.findingRulesByCheck, check, rule.id);
      push(this.findingRulesByCategory, rule.category, rule.id);
    }
    this.log = config.log ?? ((line) => console.error(line));
    this.exportDir = resolvePath(config.exportDir ?? joinPath(process.cwd(), "exports"));
    this.renderDir = resolvePath(config.renderDir ?? joinPath(process.cwd(), RENDER_HTML_DIR));
  }

  /**
   * Accept a crawl: check it may be pointed at this host, create its row, and
   * put it in this process's queue.
   *
   * The order of the checks is the order of their authority. The allowlist is
   * the operator's policy and comes first, so a host nobody permitted is
   * refused before we spend a URL-policy verdict on it. `isUrlAllowed` is the
   * engine's own perimeter (hard rule 5) and is applied to the seed here even
   * though the crawl loop re-applies it at enqueue and `fetchPage` re-applies
   * it at connect: a caller who names a blocked host deserves a 403 now, not a
   * crawl row that fails later for a reason they must go and read.
   *
   * THE SEED IS NOT THE ONLY HOST A CRAWL FETCHES. `legacyHosts` adds hosts the
   * host probe visits before any robots.txt has been read, and `sitemapUrls`
   * adds documents the discovery walk fetches that no robots.txt pointed at, so
   * both go through the same two checks — see `checkLegacyHosts` and
   * `checkSitemapUrls`, which is where the allowlist would otherwise have had a
   * hole big enough to drive a crawler through.
   */
  async startCrawl(input: StartCrawlInput): Promise<CrawlAccepted> {
    if (this.closed) {
      throw new ServiceError("CONFLICT", "the server is shutting down and is not accepting crawls");
    }

    const siteUrl = normalizeUrl(input.siteUrl.trim());
    if (siteUrl === null) {
      throw new ServiceError(
        "VALIDATION",
        `siteUrl is not an http(s) URL: ${clip(input.siteUrl)}`,
      );
    }
    const host = new URL(siteUrl).hostname;

    if (!this.crawlHostAllowed(host)) {
      // The rejected host is named; the allowlist itself is NOT listed back.
      // On a multi-tenant deployment its contents are other tenants' domains
      // (obligation 6), and the caller does not need them to fix their request.
      throw new ServiceError(
        "FORBIDDEN",
        this.config.allowedDomains.length === 0
          ? `host '${host}' is not permitted: this server's crawl allowlist is empty, ` +
            `so no crawl target is accepted (queries are unaffected)`
          : `host '${host}' is not in this server's crawl allowlist`,
      );
    }

    const allowPrivate = this.config.crawlDefaults?.allowPrivate === true;
    const verdict = await isUrlAllowed(siteUrl, { allowPrivate });
    if (!verdict.allowed) {
      throw new ServiceError(
        "FORBIDDEN",
        `siteUrl refused by the URL policy: ${verdict.reason ?? "no reason given"}`,
      );
    }

    await this.checkLegacyHosts(siteUrl, input.legacyHosts, allowPrivate);
    // The other list of URLs a request adds to the crawl: documents the walk
    // will fetch that no robots.txt pointed at (hard rule 5 — the policy runs
    // on every URL a client supplies, not only on the seed).
    await this.checkSitemapUrls(siteUrl, input.sitemapUrls, allowPrivate);

    // The judgement block is not crawl config: it is split off here, parsed
    // against the ruleset, and its `findingCap` — the one key whose bytes live
    // in `config_jsonb` (plan Deviation 1) — joins the crawl config.
    const { judgement: rawJudgement, ...crawlInput } = input;
    const block = rawJudgement === undefined ? null : this.parseJudgementInput(rawJudgement);
    if (block?.findingCap !== undefined) {
      if (crawlInput.findingCap !== undefined && crawlInput.findingCap !== block.findingCap) {
        throw new ServiceError(
          "VALIDATION",
          `findingCap (${String(crawlInput.findingCap)}) and judgement.findingCap ` +
            `(${String(block.findingCap)}) disagree: they are one setting, so send it once, ` +
            "or send the same value in both places",
        );
      }
      crawlInput.findingCap = block.findingCap;
    }

    const crawlConfig = this.effectiveConfig(siteUrl, crawlInput);
    try {
      validateCrawlConfig(crawlConfig);
    } catch (error) {
      // The loop's own range checks, surfaced where the caller can fix them.
      // Its messages name the field and the value and nothing else.
      throw new ServiceError("VALIDATION", messageOf(error));
    }

    const crawlId = `crawl_${randomUUID()}`;
    await this.db.insert(crawls).values({
      id: crawlId,
      siteUrl,
      // The same strip `runCrawl` applies, by the same function: `allowPrivate`
      // never reaches a row, so a resume of this crawl months from now cannot
      // inherit it (build-plan §7 item 3).
      config: storableConfig(crawlConfig),
      // Null when the request named no judgement — "no overrides", the state
      // every crawl before 27a is in.
      judgement: block === null ? null : storableBlock(block),
      rulesetVersion: RULESET_VERSION,
      status: "queued",
    });

    const entry: QueueEntry = { crawlId, config: crawlConfig, resuming: false };
    this.waiting.push(entry);
    this.pump();
    return { crawlId, status: "queued", queuePosition: this.queuePosition(crawlId) ?? 0 };
  }

  /**
   * The crawl-trigger allowlist gate, in one place for its four callers
   * (start, resume, legacyHosts/sitemapUrls, render urls) so the demo posture
   * cannot drift per-site. `allowAnyPublicHost` short-circuits the ALLOWLIST
   * only; every caller runs the URL policy regardless.
   */
  private crawlHostAllowed(host: string): boolean {
    if (this.config.allowAnyPublicHost === true) return true;
    return isHostAllowed(host, this.config.allowedDomains);
  }

  /**
   * Newest first, `(started_at, id)` descending — a total order, so a cursor is
   * exact.
   *
   * ## The `siteUrl` filter, and why it matches a FAMILY
   *
   * This is the project history a dashboard's date picker is built on: "every
   * crawl of this site, newest first". A caller holding `https://example.com/`
   * must find the crawl that was seeded as `http://www.example.com/`, because
   * the engine considers those one site everywhere else — `hostProbeStarts`
   * probes all four spellings as one crawl, and `checkAddedHosts` refuses to
   * treat any of them as an added host. A filter that matched the stored string
   * would answer "no crawls" for a site crawled last week, which is the silent
   * wrong answer hard rule 7 exists to stop.
   *
   * So the match is on the HOSTNAME, through `hostnameSpellings` — the crawler's
   * own definition of a site's spellings, imported rather than restated — and it
   * ignores the scheme and the port for the same reason `checkAddedHosts` does:
   * its verdict is about the host, not the URL. The hostname is extracted from
   * `crawls.site_url` in SQL rather than in JavaScript, because the alternative
   * is reading the whole table to filter it (rule 3's posture, applied to a
   * table that is small today and is one row per crawl per tenant tomorrow).
   *
   * A `siteUrl` that is not an http(s) URL is refused by name. It is not read as
   * "no filter": an unfiltered listing returned to a caller who mistyped their
   * host is another tenant's crawl list arriving as an answer.
   */
  async listCrawls(
    opts: { siteUrl?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<CrawlListItem>> {
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCrawlCursor(opts.cursor);
    const where: SQL[] = [];
    if (opts.siteUrl !== undefined) {
      where.push(sql`${CRAWL_HOSTNAME} = any(${sql.param(siteFamily(opts.siteUrl))}::text[])`);
    }
    if (cursor !== null) {
      where.push(
        sql`(${crawls.startedAt}, ${crawls.id}) < (${cursor.startedAt}::timestamptz, ${cursor.id}::text)`,
      );
    }

    const rows = await this.db
      .select({
        id: crawls.id,
        siteUrl: crawls.siteUrl,
        status: crawls.status,
        startedAt: crawls.startedAt,
        // THE CURSOR'S HALF OF THE SORT KEY, AND IT IS NOT `startedAt`.
        // `timestamptz` has microsecond precision and node-postgres parses it
        // into a JS `Date`, which has milliseconds — so a cursor built from the
        // Date would compare `12:00:00.123000` against a row stored at
        // `12:00:00.123111` and SKIP it. Two crawls accepted in the same
        // millisecond is not a hypothetical: a client submitting a batch does
        // it, and the skipped row would simply never be listed. This column is
        // the stored value at full precision, and it is what the cursor carries.
        startedAtExact: sql<string>`to_char(${crawls.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        finishedAt: crawls.finishedAt,
        pagesCrawled: crawls.pagesCrawled,
        renderPassCount: crawls.renderPassCount,
      })
      .from(crawls)
      .where(where.length === 0 ? undefined : sql.join(where, sql` and `))
      .orderBy(desc(crawls.startedAt), desc(crawls.id))
      .limit(limit + 1);

    // One row past the page is what says whether there IS a next page. It is
    // dropped, never returned, so `items.length <= limit` always holds.
    const items = rows.slice(0, limit).map((row) => ({
      crawlId: row.id,
      siteUrl: row.siteUrl,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
      pagesCrawled: row.pagesCrawled,
      renderPassCount: row.renderPassCount,
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      nextCursor: last === undefined ? null : encodeCursor(last.startedAtExact, last.id),
    };
  }

  /**
   * One crawl, in full.
   *
   * `rulesRunAt`, `findingsCount` AND `pagesScanned` COME OUT OF ONE STATEMENT,
   * and that is a correctness requirement rather than a saved round trip. The
   * three describe each other: the marker says whether a judgement is on
   * record, the findings count says what it produced, the page count says over
   * how much, and the tool descriptions tell an agent to read
   * `findingsCount: 0` beside a timestamp as "looked, found nothing" — over
   * `pagesScanned` pages.
   *
   * Read on two pool connections they would be two SNAPSHOTS, and `runRules`'
   * opening transaction clears the marker and deletes the crawl's issues
   * together (src/rules/run.ts). A crawl-row read landing just BEFORE that
   * commit and a `count(*)` landing just after would compose
   * `{rulesRunAt: <the previous run's stamp>, findingsCount: 0}` — a sentence
   * neither of the two states ever said, and precisely the one an agent is
   * told means the site is clean. The counts are therefore scalar subqueries on
   * the crawl-row select: one statement, one snapshot, no pair that never
   * existed.
   *
   * `pagesScanned` JOINS THAT STATEMENT rather than becoming a second read, for
   * the same reason and not for the round trip. It is the denominator every
   * report writes the findings count against ("1,326 findings over 551 pages"),
   * and a resumed crawl adds `pages` rows — so a page count read on its own
   * connection could be paired with a marker from before the resume, and the
   * two numbers would then describe different crawls of the same site.
   *
   * The genuinely mid-run shape — `{rulesRunAt: null, findingsCount: <partial>}`
   * — is left exactly as it is. It is honest and documented: no complete pass
   * is on record, and what is in the table belongs to the run in flight.
   *
   * The other three counts stay parallel and independent on purpose: the
   * frontier counts, the lease count and the blocked-page count are each read
   * as one number, and none of them is interpreted through another.
   */
  async getCrawl(crawlId: string): Promise<CrawlDetail> {
    return await this.crawlDetailOn(this.db, crawlId);
  }

  /**
   * `getCrawl` over a given reader: the pool, or a transaction whose snapshot
   * the caller needs the detail to share. The Crawl Overview reads its `urls`
   * section through here INSIDE its snapshot, so those entries are
   * `crawl_status`'s own fields and describe the same moment as every other
   * section.
   *
   * On the pool the six reads below run in parallel, each on a connection of
   * its own, as they always have. A transaction holds ONE client, and pg does
   * not run two statements on one client at once: it queues them, warns that
   * the queueing is deprecated, and pg 9 removes it. So on a transaction the
   * reads are awaited one after another; the snapshot makes the order
   * irrelevant to what they see.
   */
  private async crawlDetailOn(db: SnapshotReader, crawlId: string): Promise<CrawlDetail> {
    const { row, findingsCount, pagesScanned } = await this.crawlRowWithCounts(crawlId, db);
    const reads = [
      () => frontierCounts(db, crawlId),
      () => this.liveLeaseCount(crawlId, db),
      () => this.blockedPageCount(crawlId, db),
      () => this.robotsBlockedCount(crawlId, db),
      () => this.resourceCoverage(crawlId, db),
      // The crawl row's own stamp rides in rather than being read again: it
      // came out of the statement above, so the block's `passAt` and its
      // counts cannot describe two different runs of the pass.
      () => this.recheckCoverage(crawlId, row.recheckPassAt, db),
    ] as const;
    const [counts, liveLeases, blockedPages, robotsBlockedRows, resourceCounts, recheckCounts] =
      db === this.db
        ? await Promise.all([
            reads[0](), reads[1](), reads[2](), reads[3](), reads[4](), reads[5](),
          ])
        : ([
            await reads[0](),
            await reads[1](),
            await reads[2](),
            await reads[3](),
            await reads[4](),
            await reads[5](),
          ] as const);
    return {
      crawlId: row.id,
      siteUrl: row.siteUrl,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
      pagesCrawled: row.pagesCrawled,
      pagesTotal: row.pagesTotal,
      renderPassCount: row.renderPassCount,
      rulesetVersion: row.rulesetVersion,
      // Straight off the column, null included. The null is not defaulted to a
      // sentence here on either side of the contract: on a `finished` crawl it
      // is the correct answer, and on a `failed` one it means the row predates
      // migration 0017 — which is a fact about our own history and is said in
      // those words by the surfaces that render it, never invented here.
      failureReason: row.failureReason,
      frontier: counts,
      queuePosition: row.status === "queued" ? this.queuePosition(crawlId) : null,
      liveLeases,
      blockedPages,
      // The overflow is STAMPED on the crawl row (null kept: nobody counted),
      // the recorded rows are counted live, like `blockedPages` beside them.
      robotsBlocked: { recorded: robotsBlockedRows, dropped: row.robotsBlockedDropped },
      hostSpacingMs: row.hostSpacingMs,
      throttle: throttleRecordOf(row.hostSpacingJsonb),
      // Validated, as the loop validates them before resuming: columns we
      // cannot read are a defect of ours, and that is a 500, not a null.
      ...platformFields(row.platform, row.platformProfile, crawlId),
      legacyHosts: configStringList(row.config, "legacyHosts", crawlId),
      sitemapUrls: configStringList(row.config, "sitemapUrls", crawlId),
      findingCap: configFindingCap(row.config, crawlId),
      rulesRunAt: row.rulesRunAt === null ? null : row.rulesRunAt.toISOString(),
      // Off the SAME row as `rulesRunAt`, so the flag and the marker cannot
      // describe two different runs.
      judgementStale: judgementViewOf(row, crawlId, this.registry).judgementStale,
      findingsCount,
      pagesScanned,
      fetchResources: configFetchResources(row.config, crawlId),
      // Straight off the column, null included: this one is STAMPED evidence,
      // not a count taken here, and the null is the honest answer for every
      // crawl no 0014-aware loop ever closed.
      resourceRefsCappedPages: row.resourceRefsCappedPages,
      resources: resourceCounts,
      recheck: recheckCounts,
    };
  }

  /**
   * The crawl's resource census, counted live off the `resources` table —
   * `CrawlDetail.resources`.
   *
   * EVERY `resources` ROW IS COUNTED, share images included (Phase 26c). The
   * resource pass fetches an `og:image` / `twitter:image` file like any page
   * file, so it is seen and fetched or failed here; `resources.share_image`
   * (the CSV `shareImage` column) is how a reader tells those rows apart.
   *
   * ONE STATEMENT, and that is the whole reason this is not four counts in a
   * `Promise.all`. The four numbers are a PARTITION of the rows
   * (`fetched + failed + skipped == seen`), the pass writes those rows while a
   * caller may be polling, and four reads on four pool connections are four
   * snapshots: a `seen` from before a batch landed beside a `fetched` from after
   * it composes an arithmetic nobody's database ever held. The same argument
   * `crawlRowWithCounts` makes about the judged marker, one table along.
   *
   * `capped` is a boolean rather than a count because that is what the rows can
   * honestly support: `RESOURCE_CAP_REASON` is one literal for both caps (see
   * the field's docblock), and the number of rows carrying it is "how many rows
   * the pass had not reached when it stopped", which is `skipped` under another
   * name on a crawl that was not also interrupted. One flag, one meaning.
   *
   * IT IS NOT FILTERED BY `fetch_reason` ANYWHERE ELSE. The reasons are
   * sentences — a URL policy's refusal, a robots note, the fetch layer's own
   * description of a timeout — and a count built by matching them would be a
   * count that changes when somebody rewords an error message. The one reason
   * this reads is a constant this repository defines.
   *
   * The class names are the same discipline, and for the same reason: they are
   * `RESOURCE_OK_CLASS`, `RESOURCE_ROBOTS_DENIED_CLASS` and
   * `RESOURCE_ROBOTS_UNREACHABLE_CLASS`, imported and INTERPOLATED rather than
   * typed out as `'ok'`, `'robots_denied'` and `'robots_unreachable'`. A bare
   * literal here would typecheck for ever against a renamed vocabulary while
   * the count it feeds quietly reported 0.
   *
   * THE PARTITION DID NOT MOVE when P12-T1 split the robots classes, and the
   * shape of this statement is why: `failed` is every non-null class that is not
   * `ok`, so a NEW class joins it without being named, and the two robots counts
   * are `filter`s over the same rows rather than terms in the sum. A partition
   * written as an explicit list of classes would have needed editing — and would
   * have quietly dropped the new one until somebody did.
   */
  private async resourceCoverage(
    crawlId: string,
    db: SnapshotReader = this.db,
  ): Promise<CrawlDetail["resources"]> {
    const rows = await db.execute<{
      seen: number;
      fetched: number;
      failed: number;
      skipped: number;
      robots_denied: number;
      robots_unreachable: number;
      capped: boolean;
    }>(sql`
      select count(*)::int as seen,
             count(*) filter (where r.fetch_class = ${RESOURCE_OK_CLASS})::int as fetched,
             count(*) filter (
               where r.fetch_class is not null and r.fetch_class <> ${RESOURCE_OK_CLASS}
             )::int as failed,
             count(*) filter (where r.fetch_class is null)::int as skipped,
             count(*) filter (
               where r.fetch_class = ${RESOURCE_ROBOTS_DENIED_CLASS}
             )::int as robots_denied,
             count(*) filter (
               where r.fetch_class = ${RESOURCE_ROBOTS_UNREACHABLE_CLASS}
             )::int as robots_unreachable,
             count(*) filter (
               where r.fetch_class is null and r.fetch_reason = ${RESOURCE_CAP_REASON}
             ) > 0 as capped
      from resources r
      where r.crawl_id = ${crawlId}`);
    const row = rows.rows[0];
    if (row === undefined) {
      // A bare aggregate over an empty table still answers one row. No row at
      // all means the statement did not run the way this code believes it did,
      // which is a defect of ours and not a crawl with no resources.
      throw new Error(`resourceCoverage: the aggregate over crawl ${crawlId} answered no row`);
    }
    return {
      seen: row.seen,
      fetched: row.fetched,
      failed: row.failed,
      skipped: row.skipped,
      robotsDenied: row.robots_denied,
      robotsUnreachable: row.robots_unreachable,
      capped: row.capped,
    };
  }

  /**
   * The crawl's 5xx re-verification coverage, counted live off `pages` —
   * `CrawlDetail.recheck`.
   *
   * ONE STATEMENT, on `resourceCoverage`'s argument one table along: the four
   * outcome counts are a PARTITION of this crawl's `server_error` rows
   * (`confirmed + cleared + inconclusive + pending == serverErrors`), the pass
   * settles those rows while a poller may be watching `pending` fall, and four
   * reads on four pool connections are four snapshots — a denominator from
   * before a row settled beside a `pending` from after it is an arithmetic
   * nobody's database ever held.
   *
   * THE VOCABULARY IS IMPORTED, NEVER TYPED OUT, for the reason the resource
   * block states: a bare `'ok'` here would typecheck for ever against a renamed
   * class while the count it feeds quietly reported 0. `RECHECK_CLEARED` is the
   * SAME set `http.server-error-transient` fires on (`src/rules/page/status.ts`),
   * so `cleared` is by construction the number of pages that rule claims —
   * a copy of the six class names would answer a different question the day a
   * seventh joined. `SERVER_ERROR_CLASS` is a typed `FetchClass`, so a rename
   * stops compiling here.
   *
   * `inconclusive` IS THE REMAINDER, written as "decided, and neither of the
   * other two", never as a list of `timeout | network_error | blocked |
   * disallowed`. A new fetch class joins it without being named — and a
   * hand-listed alternative would have dropped it silently into nothing, which
   * is exactly how a partition stops adding up.
   *
   * `capped` matches ONE literal this repository defines (`RECHECK_CAP_REASON`)
   * rather than "any reason at all": the field is named for the budget, and the
   * day the pass gains a second reason to decline a row, this flag must not
   * start calling it a cap. Those rows are counted in `pending` either way,
   * because nothing about them was decided.
   *
   * `noResponse` (Phase 23) is the same pass's partition of the `timeout` /
   * `network_error` rows, counted in the SAME statement for the same snapshot
   * reason, and against `NO_RESPONSE_ANSWERED` — the set
   * `http.no-response-transient` fires on — so `answered` is by construction
   * the number of pages that rule claims. The statement scans `RECHECK_CLASSES`
   * (the pass's own work list), so `capped` covers the one shared budget.
   *
   * `passAt` is NOT counted here — it is `crawls.recheck_pass_at`, handed in
   * from the crawl-row read so the stamp and the counts come off one crawl-row
   * snapshot rather than two.
   */
  private async recheckCoverage(
    crawlId: string,
    passAt: Date | null,
    db: SnapshotReader = this.db,
  ): Promise<CrawlDetail["recheck"]> {
    // The set as a list, so the template renders it as an IN tuple of bound
    // parameters — never as text spliced into the statement.
    const cleared = [...RECHECK_CLEARED];
    const answered = [...NO_RESPONSE_ANSWERED];
    const noResponse = [...NO_RESPONSE_CLASSES];
    // The whole work list the pass walks, so the shared cap is read over it.
    const rechecked = [...RECHECK_CLASSES];
    const rows = await db.execute<{
      server_errors: number;
      confirmed: number;
      cleared: number;
      inconclusive: number;
      pending: number;
      nr_pages: number;
      nr_confirmed: number;
      nr_answered: number;
      nr_inconclusive: number;
      nr_pending: number;
      capped: boolean;
    }>(sql`
      select count(*) filter (where p.fetch_class = ${SERVER_ERROR_CLASS})::int as server_errors,
             count(*) filter (
               where p.fetch_class = ${SERVER_ERROR_CLASS}
                 and p.recheck_fetch_class = ${SERVER_ERROR_CLASS}
             )::int as confirmed,
             count(*) filter (
               where p.fetch_class = ${SERVER_ERROR_CLASS}
                 and p.recheck_fetch_class in ${cleared}
             )::int as cleared,
             count(*) filter (
               where p.fetch_class = ${SERVER_ERROR_CLASS}
                 and p.recheck_fetch_class is not null
                 and p.recheck_fetch_class <> ${SERVER_ERROR_CLASS}
                 and not (p.recheck_fetch_class in ${cleared})
             )::int as inconclusive,
             count(*) filter (
               where p.fetch_class = ${SERVER_ERROR_CLASS} and p.recheck_fetch_class is null
             )::int as pending,
             count(*) filter (where p.fetch_class in ${noResponse})::int as nr_pages,
             count(*) filter (
               where p.fetch_class in ${noResponse}
                 and p.recheck_fetch_class in ${noResponse}
             )::int as nr_confirmed,
             count(*) filter (
               where p.fetch_class in ${noResponse}
                 and p.recheck_fetch_class in ${answered}
             )::int as nr_answered,
             count(*) filter (
               where p.fetch_class in ${noResponse}
                 and p.recheck_fetch_class is not null
                 and not (p.recheck_fetch_class in ${noResponse})
                 and not (p.recheck_fetch_class in ${answered})
             )::int as nr_inconclusive,
             count(*) filter (
               where p.fetch_class in ${noResponse} and p.recheck_fetch_class is null
             )::int as nr_pending,
             count(*) filter (
               where p.recheck_fetch_class is null and p.recheck_reason = ${RECHECK_CAP_REASON}
             ) > 0 as capped
      from pages p
      where p.crawl_id = ${crawlId} and p.fetch_class in ${rechecked}`);
    const row = rows.rows[0];
    if (row === undefined) {
      // A bare aggregate over no rows still answers one row. No row at all
      // means the statement did not run the way this code believes it did,
      // which is our defect and not a crawl with no server errors.
      throw new Error(`recheckCoverage: the aggregate over crawl ${crawlId} answered no row`);
    }
    return {
      serverErrors: row.server_errors,
      confirmed: row.confirmed,
      cleared: row.cleared,
      inconclusive: row.inconclusive,
      pending: row.pending,
      noResponse: {
        pages: row.nr_pages,
        confirmed: row.nr_confirmed,
        answered: row.nr_answered,
        inconclusive: row.nr_inconclusive,
        pending: row.nr_pending,
      },
      capped: row.capped,
      passAt: passAt === null ? null : passAt.toISOString(),
    };
  }

  /**
   * The site's robots.txt as this crawl read it, out of the stored discovery
   * evidence — `GET /crawls/:id/robots` and `robots_get`.
   *
   * A READ OF EVIDENCE, never a fetch (hard rule 2 and 3): this is the file the
   * crawl obeyed. It is also the only way to see it — nothing else on the
   * surface carries the text, so a robots.txt question was previously
   * answerable only by asking the site again, which answers a different
   * question (what it says now) and costs the site a request.
   *
   * A crawl with no discovery blob is a 409 rather than an empty answer, by the
   * same argument the render path makes: `discovery_jsonb` is written before
   * the frontier is seeded, so its absence means the crawl never got that far —
   * and "we have no record" must not be served as "the site has no robots.txt",
   * which is a fact with the opposite meaning.
   */
  async getRobots(crawlId: string): Promise<RobotsEvidence> {
    const row = await this.crawlRow(crawlId);
    const robots = this.parseRobots(row.discovery, crawlId);

    let robotsUrl: string;
    try {
      robotsUrl = new URL("/robots.txt", row.siteUrl).href;
    } catch {
      // `site_url` is `normalizeUrl` output on every row this engine writes, so
      // this is a row we did not write. Loud rather than an omitted field.
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} has a site URL that is not a URL, so the robots.txt it ` +
          `would have asked for cannot be named`,
      );
    }

    const config = row.config;
    const userAgent =
      isRecord(config) && typeof config["userAgent"] === "string" ? config["userAgent"] : null;

    return {
      crawlId,
      robotsUrl,
      outcome: robots.outcome,
      raw: robots.raw,
      truncated: robots.truncated,
      crawlDelaySec: robots.crawlDelaySec,
      note: robots.note,
      sitemapSources: robots.sitemapSources,
      suppliedSitemaps: robots.suppliedSitemaps,
      userAgent,
    };
  }

  /**
   * Close a crawl nobody is working: `running` or `queued` → `failed`.
   *
   * Three conditions, each refused with a 409 that says which one failed,
   * because this endpoint's whole risk is being used on a crawl that is merely
   * slow.
   *
   *  1. **The row says `running` or `queued`.** Anything else is already
   *     closed, and a terminal crawl is not a crash to clean up after.
   *  2. **This process is not holding it.** A crawl this server is running, or
   *     is holding in its queue to run next, is live work whatever the database
   *     says — and a live crawl between batches momentarily holds no lease at
   *     all, which is exactly the window an impatient caller would look in.
   *     `queuePosition` is the same process-truth this server reports on every
   *     crawl detail, used here as a guard.
   *  3. **It holds no unexpired lease.** A live worker holds leases; a dead
   *     one's expire (see `leaseSecondsFor` in the crawl loop). This is the
   *     same live/dead distinction `runRenderPass`'s guard makes, and it counts
   *     render leases too — a `render_pending` row with a live deadline belongs
   *     to a working render pass and is invisible to the frontier's `leased`
   *     count (see `heldRenderLeases`).
   *
   * WHY `queued` IS HERE. The queue's restart contract (module header) leaves a
   * dead process's accepted work as `queued` rows that no process is holding:
   * visible in `GET /crawls`, `queuePosition: null`, and — until this widening
   * — un-actionable, because the endpoint asked for `running`. That left the
   * only orphan the surface could not close, so a caller cleaning up after a
   * crash had a listing full of work they could neither run nor retire. The
   * process-truth test in (2) is what makes it safe: this server refuses to
   * close what it is holding, and it never claims to know about another
   * process's queue — which is why the row it closes is the one whose status it
   * read, and the update is conditioned on that status still being there.
   */
  async markCrawlFailed(crawlId: string): Promise<CrawlDetail> {
    const row = await this.crawlRow(crawlId);
    if (row.status !== "running" && row.status !== "queued") {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is '${row.status}', not 'running' or 'queued': only a crawl ` +
          `whose worker is gone can be marked failed`,
      );
    }
    if (this.queuePosition(crawlId) !== null) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is held by this server (${row.status}): cancel the server or ` +
          `wait for it, do not mark live work failed`,
      );
    }
    const live = await this.liveLeaseCount(crawlId);
    if (live > 0) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} holds ${live} unexpired lease(s): a worker is still on it. ` +
          `A dead worker's leases expire on their own — try again after they do`,
      );
    }

    await this.db
      .update(crawls)
      // THE REASON IS A FIXED SENTENCE, because this close has no error to
      // quote: nothing threw, and the three guards above have just established
      // the only fact there is — the row is `queued` or `running`, this server
      // is not holding it, and no unexpired lease is on it. That is what the
      // sentence says, and it is what distinguishes this row on the wire from
      // one the crawl loop closed with a cause of its own (migration 0017).
      .set({
        status: "failed",
        finishedAt: new Date(),
        failureReason: MARKED_FAILED_REASON,
      })
      // Conditioned on the status this call READ, so a crawl that started (or
      // was closed by its own worker) between the guard and here is left alone
      // rather than overwritten. `getCrawl` below reports what actually stands.
      .where(and(eq(crawls.id, crawlId), eq(crawls.status, row.status)));
    return this.getCrawl(crawlId);
  }

  /**
   * Continue a crawl that stopped with work still owed —
   * `POST /crawls/:id/resume` and `crawl_resume`.
   *
   * WHY THIS EXISTS. The engine has always been able to do it: the frontier IS
   * the resume state, `resumeCrawl` in the crawl loop has continued crawls since
   * Phase 1, and the API's own queue runner already calls it for every crawl it
   * starts. What was missing was reachability. When the Phase 11 gate crawl's
   * harness stopped the server 40 minutes into the resource pass, the row closed
   * `cancelled` with 786 resource rows still unasked, and finishing them took a
   * script with a database handle — for an operator driving this engine over the
   * network there was no move at all (docs/gates/phase-11.md §5). This is that
   * move.
   *
   * IT IS THE SAME CRAWL CONTINUING, and everything about the answer says so.
   * The row is not replaced, the id does not change, the frontier is not
   * re-seeded, and pages already on record are never re-fetched (the loop's own
   * guarantee: a `done` row is a promise that the page is in the database). So
   * the answer is `crawl_start`'s — `{crawlId, status: "queued", queuePosition}`
   * — because a resume is accepted exactly the way a start is: put in this
   * process's queue, run when the runner reaches it, polled through
   * `crawl_status`. The row is moved to `queued` here for the same reason: a
   * crawl this server is holding must be visible as held, and a `finished_at`
   * left on a row that is queued again would be a contradiction, so it is
   * cleared with it — and so is `rules_run_at`, for the sharper reason argued at
   * the write itself: a judged-then-resumed crawl would otherwise carry a
   * timestamp over a crawl that has since grown pages.
   *
   * WHAT THE CALLER MUST NOT READ THE ANSWER AS. Nothing here reports what the
   * resumed run will find. `crawl_status` remains the truth about the crawl, and
   * the reason is the one P11-T4 argued and the gate crawl then demonstrated:
   * the resumed pass's own summary describes THE PROCESS ("784 resources
   * fetched"), while the database describes THE CRAWL ("1,995 fetched across 11
   * hosts"). Both are true, and a surface that rendered the summary would have
   * told an auditor that 1,213 files were never asked about.
   *
   * ## The trust posture is `crawl_start`'s, re-applied to the STORED site
   *
   * A crawl accepted last month is not permission to fetch today. The allowlist
   * and the URL policy are re-checked against `crawls.site_url` — the site as it
   * was stored, never a site the caller names, because the caller names nothing
   * but an id — and so are the two lists that add hosts to a run: `legacyHosts`
   * (whose hosts the probe fetches before it has read anybody's robots.txt) and
   * `sitemapUrls` (documents the walk fetches that no robots.txt pointed at).
   * A resume re-runs discovery and the host probe, so those really are fetched
   * again, and hard rule 5 is not satisfied by the check the first run passed.
   * A site that has since left this server's allowlist does not resume, and the
   * refusal names the host.
   *
   * The pacing is the crawl's own stored config, not this server's current
   * defaults: continuing somebody's 2000ms crawl at a newer default's 250ms
   * would be a politeness change nobody asked for (rule 9). `allowPrivate` is
   * the one field re-asserted from this process, because it is deliberately
   * never persisted (see `storableConfig`) — the same process-trust seam every
   * other path uses.
   *
   * ## The refusals, and what each one is protecting
   *
   *  1. **No such crawl** — 404. There is nothing to continue.
   *  2. **This server is holding it** — 409. `queuePosition` is the same
   *     process-truth every crawl detail reports, and it also refuses a second
   *     resume of a crawl already waiting in this queue.
   *  3. **A live worker holds leases** — 409, naming the count. An unexpired
   *     `leased_until` is the frontier's own live-worker detector, and it is the
   *     test `markCrawlFailed` and the render driver already make.
   *  4. **Nothing left to resume** — 409 on a settled crawl with no owed work,
   *     naming every place that was looked: pending frontier rows, rows whose
   *     lease has expired, and resource rows with a null `fetch_class`. A
   *     "resume" that quietly ran discovery, found nothing to do and closed the
   *     row again would cost the site a robots.txt, a sitemap walk and up to
   *     four host-probe chains to change nothing (rule 7).
   *  5. **The allowlist / the URL policy** — 403, naming the host.
   *  6. **The row moved under the call** — 409. The claiming update is
   *     conditioned on the status this method read, and its row count is READ:
   *     zero means something else took the crawl between the guards and the
   *     write, and nothing is queued.
   *
   * A CANCELLED CRAWL WITH WORK LEFT IS RESUMABLE, and that is a ruling rather
   * than an oversight. `cancelled` means an abort signal fired — an operator
   * stopped the server, or stopped the crawl — and the loop's abort path is
   * careful to decide nothing on the way out: the URLs it never leased stay
   * pending, the resource rows it never reached stay null with no reason, and
   * the 404 probe and the resource pass are skipped rather than recorded as
   * having found nothing. So the rows an abort leaves are precisely the
   * questions nobody has answered yet, and resuming asks only those. An operator
   * who changes their mind is the ordinary case (it is what the Phase 11 gate
   * did), and refusing it would mean re-crawling a site from scratch to recover
   * from a decision that cost the site nothing. `failed` is here on the same
   * terms — a crash decided nothing either — and a caller who wants the crawl
   * dead rather than continued still has `crawl_mark_failed`.
   *
   * ## The honest race, stated rather than papered over
   *
   * Checks (2) and (3) are a SNAPSHOT. A lease can expire between the count and
   * the enqueue, and a worker this server cannot see can take a fresh one just
   * after it — no lock spans the two, and adding one would only move the window.
   * Refusal (6) is what narrows it as far as it goes without a lock: the claim
   * is a compare-and-swap on the status this method read, so of two callers who
   * both passed the guards only the one whose UPDATE lands first is accepted,
   * and the database refuses the other on the row itself. It cannot close the
   * window against a process that never touches the status at all.
   *
   * What makes the remainder survivable is that the guard is not the safety
   * mechanism:
   * `leaseBatch` is. Two workers leasing at the same instant get DISJOINT
   * batches (`for update skip locked` over a materialized CTE, see
   * src/crawl/frontier.ts), and a page row lands in the same transaction that
   * moves its frontier row to `done`. So the worst case a lost race produces is
   * two workers dividing one crawl's remaining frontier between them — slower
   * per worker, twice the politeness pressure on the host, and every page still
   * written exactly once. That is why this path does NOT reclaim leases: the
   * loop's `reclaimLeases` hands every live lease in the crawl back to pending,
   * which is right after a crash and wrong while somebody is working, and this
   * server cannot tell the two apart from outside. Expired leases come back on
   * their own through `leaseBatch`; live ones stay with whoever holds them.
   */
  async resumeCrawl(crawlId: string): Promise<CrawlAccepted> {
    if (this.closed) {
      throw new ServiceError(
        "CONFLICT",
        "the server is shutting down and is not accepting crawls",
      );
    }

    const row = await this.crawlRow(crawlId);

    // FIRST, BECAUSE IT IS FREE AND BECAUSE THE NEXT CHECKS ARE NOT. This one is
    // an array lookup in this process; `isUrlAllowed` below resolves the host,
    // which is a DNS round trip spent on a request this server was always going
    // to refuse. The three policy checks keep their own order relative to each
    // other (allowlist before URL policy, per `startCrawl`) — this is inserted
    // ahead of them, not shuffled among them.
    if (this.queuePosition(crawlId) !== null) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is already held by this server ('${row.status}'): it is ` +
          `running now or waiting to run, and a resume would be a second worker on ` +
          `the same crawl`,
      );
    }

    // The site as the row stores it, re-vetted from scratch. `normalizeUrl`
    // answers null only for a row this engine did not write (every writer
    // normalises on the way in), and that is a 409 rather than a guess: a crawl
    // whose target cannot be parsed is a crawl nobody can say is allowed.
    const siteUrl = normalizeUrl(row.siteUrl);
    if (siteUrl === null) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} has a site URL that is not an http(s) URL, so this server ` +
          `cannot check whether it may still be crawled`,
      );
    }
    const host = new URL(siteUrl).hostname;
    if (!this.crawlHostAllowed(host)) {
      // The same sentence `startCrawl` refuses with, and the same silence about
      // what the allowlist contains (obligation 6).
      throw new ServiceError(
        "FORBIDDEN",
        this.config.allowedDomains.length === 0
          ? `host '${host}' is not permitted: this server's crawl allowlist is empty, ` +
            `so no crawl target is accepted (queries are unaffected). Crawl ` +
            `${crawlId} cannot be resumed`
          : `host '${host}' is not in this server's crawl allowlist, so crawl ${crawlId} ` +
            `cannot be resumed: a crawl accepted earlier is not standing permission`,
      );
    }

    const allowPrivate = this.config.crawlDefaults?.allowPrivate === true;
    const verdict = await isUrlAllowed(siteUrl, { allowPrivate });
    if (!verdict.allowed) {
      throw new ServiceError(
        "FORBIDDEN",
        `crawl ${crawlId}'s siteUrl is refused by the URL policy: ` +
          `${verdict.reason ?? "no reason given"}`,
      );
    }

    // The crawl's own settings, validated rather than trusted — the same read
    // the render endpoint makes, and it refuses on the same terms.
    let stored: CrawlConfig;
    try {
      stored = parseStoredConfig(row.config, crawlId);
    } catch (error) {
      throw new ServiceError("CONFLICT", messageOf(error));
    }
    const config: CrawlConfig = { ...stored, allowPrivate };
    try {
      validateCrawlConfig(config);
    } catch (error) {
      throw new ServiceError("CONFLICT", messageOf(error));
    }

    // Hard rule 5 over the hosts the RESUME will fetch, not the ones the first
    // run did: discovery and the host probe both run again.
    await this.checkLegacyHosts(siteUrl, config.legacyHosts, allowPrivate);
    await this.checkSitemapUrls(siteUrl, config.sitemapUrls, allowPrivate);

    const live = await this.liveLeaseCount(crawlId);
    if (live > 0) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} holds ${live} unexpired lease(s): a worker is still on it, ` +
          `and resuming would put a second crawler on the same site. A dead worker's ` +
          `leases expire on their own — try again after they do`,
      );
    }

    // Only a SETTLED crawl can be out of work. A `queued` or `running` row that
    // nobody is holding is a crawl a dead process left behind: its frontier may
    // be empty simply because it never got as far as seeding one, and resuming
    // it does what a fresh start does — discover, seed, loop.
    if (row.status !== "queued" && row.status !== "running") {
      const work = await this.owedWork(crawlId, config);
      if (work.total === 0) {
        throw new ServiceError("CONFLICT", nothingToResume(crawlId, row.status, work));
      }
    }

    const claimed = await this.db
      .update(crawls)
      .set({
        status: "queued",
        // `finished_at` goes with the status: a queued crawl has not finished,
        // and a row saying both would be unreadable. The crawl loop clears it
        // too when it starts, but a row can sit in this queue for a while first.
        finishedAt: null,
        // AND SO DOES `rules_run_at`, for a sharper reason than tidiness.
        //
        // It is the surface's single load-bearing sentence (talos-surface.md
        // §5): a timestamp means a complete rules pass is on record, so an empty
        // findings answer means "looked, found nothing", and null means nobody
        // has looked. Judge a cancelled crawl and then resume it, and the
        // timestamp would survive over a crawl that has since grown pages —
        // `findingsCount` would describe a strictly smaller crawl than
        // `pagesScanned` counts, and every reader is told to trust the pair.
        // `crawl_compare` would inherit the staleness silently, because it
        // compares two crawls it believes were both judged.
        //
        // So the marker is cleared here, by `finishedAt`'s own argument: the row
        // must not say two things that cannot both be true. The findings rows
        // themselves are left alone and are then read exactly as a run that died
        // part-way — a state the surface already documents and handles — until
        // `crawl_rules` re-judges the finished crawl and rewrites them.
        rulesRunAt: null,
        // The stamp of what that judgement used goes with it: non-null exactly when `rules_run_at` is (27a).
        rulesJudgedWith: null,
        // AND THE FAILURE SENTENCE, by `finishedAt`'s argument again: the
        // column's contract is `failure_reason IS NOT NULL` ⟹ `status =
        // 'failed'` (migration 0017), so a queued row still carrying why the
        // last run failed breaks it — and serves an accepted crawl with a
        // death notice attached. The loop clears it too when it starts.
        failureReason: null,
      })
      // Conditioned on the status this call READ, for `markCrawlFailed`'s
      // reason: a crawl that started under another process between the guards
      // and here is left exactly as it is.
      .where(and(eq(crawls.id, crawlId), eq(crawls.status, row.status)));

    // AND THE COMPARE-AND-SWAP IS READ, which is the whole point of writing one.
    //
    // Zero rows means the guard above raced: between reading the row and this
    // statement, something else moved the crawl — another process started it,
    // its own worker closed it, `crawl_mark_failed` retired it. Queueing anyway
    // would answer `{status: "queued"}` about a row that says nothing of the
    // kind, and this process would then run a crawl somebody else may be
    // running: a silent no-op dressed as an acceptance, which is exactly what
    // hard rule 7 forbids and exactly the trap `markCrawlFailed`'s conditioned
    // update was written to avoid.
    //
    // It is also the narrowest this server can make the double-accept race
    // without a lock: two callers reading the same status both reach here, and
    // only the one whose UPDATE lands first sees a row. The other is refused,
    // by the database, on the row itself.
    if (claimed.rowCount === null) {
      throw new Error(
        `resumeCrawl: the update of crawl ${crawlId} reported no row count, so whether ` +
          `this server claimed it is unknown`,
      );
    }
    if (claimed.rowCount === 0) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} changed state while this resume was being checked — it was ` +
          `'${row.status}' when the call began and something else has moved it since. ` +
          `Nothing was queued; read crawl_status and try again`,
      );
    }

    const entry: QueueEntry = { crawlId, config, resuming: true };
    this.waiting.push(entry);
    this.pump();
    return { crawlId, status: "queued", queuePosition: this.queuePosition(crawlId) ?? 0 };
  }

  /**
   * What a resume of this crawl would actually have to do, counted in one
   * statement so the four numbers describe one instant.
   *
   * The three that COUNT are the three a continuation consumes: frontier rows
   * still `pending`, frontier rows whose lease has expired (`leaseBatch` takes
   * exactly those two states — this is not a second definition of resumable, it
   * is that predicate read as a question), and `resources` rows with a null
   * `fetch_class`, which is precisely the work list the resource pass walks.
   *
   * `renderPending` is counted and deliberately NOT part of the total. Those
   * rows are already-crawled pages the render selection promoted, and the crawl
   * loop never leases them; they are `crawl_render`'s work. Counting them would
   * make a resume "succeed" by running a whole discovery pass to do nothing, and
   * not naming them at all would leave an operator staring at a crawl with
   * visibly unfinished-looking rows and a refusal that did not mention them. So
   * the refusal names them and points at the tool that owns them.
   *
   * THE RESOURCE COUNT IS ZERO WHEN THE PASS IS OFF, and that is the honest
   * reading rather than a special case. `fetchResources: false` means the
   * operator decided about every one of those rows (they carry
   * `resource-fetch-off`), and a resume will not run the pass, so a null
   * `fetch_class` there is a decision on record and not owed work. Counting it
   * would let a resume be accepted for work that provably will not happen.
   */
  private async owedWork(crawlId: string, config: CrawlConfig): Promise<OwedWork> {
    const result = await this.db.execute<{
      pending: number;
      expired: number;
      unfetched_resources: number;
      render_pending: number;
    }>(sql`
      select
        (select count(*)::int from frontier
          where crawl_id = ${crawlId} and state = 'pending') as pending,
        (select count(*)::int from frontier
          where crawl_id = ${crawlId} and state = 'leased'
            and leased_until < now()) as expired,
        (select count(*)::int from resources
          where crawl_id = ${crawlId} and fetch_class is null) as unfetched_resources,
        (select count(*)::int from frontier
          where crawl_id = ${crawlId} and state = 'render_pending') as render_pending`);
    const row = result.rows[0];
    if (row === undefined) {
      // A bare aggregate answers one row over an empty table. No row means the
      // statement did not run the way this code believes it did.
      throw new Error(`owedWork: the count for crawl ${crawlId} answered no row`);
    }
    const resourcesOff = config.fetchResources === false;
    const resources = resourcesOff ? 0 : row.unfetched_resources;
    return {
      pending: row.pending,
      expired: row.expired,
      resources,
      resourcesOff,
      renderPending: row.render_pending,
      total: row.pending + row.expired + resources,
    };
  }

  /**
   * Run the render pass over a finished crawl.
   *
   * The driver's own three-condition guard is the authority on whether a crawl
   * may be rendered, and it is NOT re-implemented here — it is called, and its
   * refusals are mapped. See `mapRenderPassError` for the coupling that costs.
   *
   * What this method does own is the pass's configuration, and it comes from
   * the crawl's own row: the same user agent, the same per-host delay, the same
   * render budget, plus the robots `Crawl-delay` the crawl honoured. A render
   * pass that paced itself differently from the crawl it belongs to would be a
   * politeness regression the site would experience as a second, ruder crawler
   * (rule 9).
   *
   * ## `urls`: the caller names the pages
   *
   * Absent, everything above is what happens and the pass is byte-identical to
   * what it always was. Present, the list REPLACES the automatic selection for
   * this pass — see `selectExplicitRenderSet` — and this method owns every
   * refusal that stands in front of it, because each one is a status code and a
   * sentence rather than a database question: see `checkRenderUrls`.
   *
   * The list is validated BEFORE the driver's own three refusals are reached. A
   * malformed request is refused as a malformed request; whether the crawl is
   * live is a fact about the world and is the driver's to state, in the same
   * order `parseStartCrawlInput` puts a bad body ahead of a busy queue.
   */
  async renderCrawl(crawlId: string, input: RenderCrawlInput = {}): Promise<RenderSummaryOut> {
    const row = await this.crawlRow(crawlId);

    let config: CrawlConfig;
    try {
      config = parseStoredConfig(row.config, crawlId);
    } catch (error) {
      throw new ServiceError("CONFLICT", messageOf(error));
    }
    const robotsCrawlDelaySec = this.robotsCrawlDelay(row.discovery, crawlId);
    const renderUrls =
      input.urls === undefined
        ? undefined
        : await this.checkRenderUrls(crawlId, input.urls, config);

    let summary: RenderPassSummary;
    try {
      summary = await runRenderPass(this.db, crawlId, {
        ...config,
        robotsCrawlDelaySec,
        ...(renderUrls === undefined ? {} : { renderUrls }),
        // NOT left to the pass's own cwd-relative default. The render pass
        // writes a file per rendered page, and a server that never said where
        // put them wherever it happened to be started — which is how this
        // repository's own suite left twelve crawl directories in the working
        // tree. The directory is a SERVER property (`ServiceConfig.renderDir`),
        // absolutised at construction, and no request may name it.
        renderHtmlDir: this.renderDir,
        allowPrivate: this.config.crawlDefaults?.allowPrivate === true,
        ...(this.config.resolveAddress === undefined
          ? {}
          : { resolveAddress: this.config.resolveAddress }),
      });
    } catch (error) {
      throw mapRenderPassError(error, crawlId, this.log);
    }

    return {
      crawlId: summary.crawlId,
      rendered: summary.rendered,
      failures: summary.failures,
      unrendered: summary.unrendered,
      elapsedMs: summary.elapsedMs,
      requests: summary.requests,
      // PROJECTED, not passed through: `detail` is the resolver's own message
      // (`UnpinnedHost.detail`) and goes to the log under this crawl's id,
      // the way the launch refusal's does below. The caller gets the host and
      // the sentence url-policy wrote for them.
      unpinnedHosts: summary.unpinnedHosts.map(({ host, reason, detail }) => {
        if (detail !== null) {
          this.log(`api: render launch crawl ${crawlId} did not pin ${host} — ${reason}: ${detail}`);
        }
        return { host, reason };
      }),
      // The selection's URL list is a page list, and a page list is not a
      // response body (obligation 1: never a full export inline). Its size is.
      // `mode` rides beside it because the four numbers under it mean nothing
      // without it: on an explicit pass they are null, and a caller that reads
      // `budget: null` as "no budget was enforced" is reading it correctly.
      selection: {
        mode: summary.selection.mode,
        selected: summary.selection.selected.length,
        budget: summary.selection.budget,
        suspects: summary.selection.suspects,
        sampled: summary.selection.sampled,
        truncated: summary.selection.truncated,
      },
    };
  }

  /**
   * Judge a crawl: run every rule in the registry over it.
   *
   * Refused while the crawl is in flight. `runRules` itself has no such guard —
   * it would happily judge a half-crawled site — and the findings it produced
   * would change under the reader as the crawl went on: an orphan that is only
   * an orphan because the page linking to it has not been fetched yet, a
   * sitemap entry "uncrawled" because its turn has not come. Evidence has to be
   * about a crawl that has stopped moving.
   *
   * ## And refused while ANOTHER RUN IS JUDGING THE SAME CRAWL
   *
   * The status guard above is not enough, because it says nothing about a
   * second *rules run*. Two overlapping runs on one finished crawl used to be
   * merely wasteful; since a run deletes the crawl's `issues` rows at the top
   * and writes its own (see `runRules`), they are destructive. Interleaved,
   * the second run's delete lands in the middle of the first run's inserts, so
   * the table ends up holding a SUFFIX of run A beside all of run B — two
   * judgements in one table with nothing to tell them apart, and a summary
   * from each describing a table neither of them produced. That is the exact
   * silently-mixed state the single delete was designed to make impossible,
   * and the argument for it ("what survives a run is what that run found")
   * holds only for a single writer. The friendlier outcome — both runs abort
   * on `issues_dedupe` — is luck, not a guard.
   *
   * ## Why the lock is in this process and not in Postgres
   *
   * A `pg_advisory_xact_lock` was the obvious answer and it does not work
   * here: it is released when its transaction ends, and a rules run is not one
   * transaction. `runRules` issues its `ANALYZE`s, its delete, its page-cursor
   * selects and its finding inserts as separate autocommitted statements, and
   * wraps only each metric rule's delete+insert pair. A lock taken inside any
   * one of those covers that statement and nothing else.
   *
   * A SESSION-level `pg_advisory_lock` does span statements — but only for the
   * connection that took it, and `Db` is a pool that hands out a connection
   * per statement. Holding one across the run would mean pinning a client for
   * the run's whole duration and threading it through `runRules`, changing the
   * rules runner's contract to buy a guard for a case a single-process server
   * does not have. So the hold lives here, in memory, keyed by crawl id.
   *
   * WHAT THAT IS HONEST ABOUT: this serialises runs **within this process
   * only**. Two Ariadne servers pointed at one database can still interleave
   * two runs over one crawl, and nothing here would notice. That is the same
   * boundary the queue already stands on — `markCrawlFailed` refuses work
   * "held by this server" from process truth and explicitly never claims to
   * know another process's queue — so this adds no assumption the surface did
   * not already make. A multi-process deployment needs a database-level lock,
   * and the place for it is a pinned client inside `runRules`, not here.
   *
   * The refusal is a 409 rather than a wait, matching the render path: the
   * caller asked for a run that would produce a judgement, and the answer
   * "another run is producing it, ask again" is one an agent can act on, where
   * a silent block is a request that appears to hang.
   */
  async runRulesForCrawl(crawlId: string): Promise<RunSummary> {
    const row = await this.crawlRow(crawlId);
    if (row.status === "queued" || row.status === "running") {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is '${row.status}': the rules may only run over a crawl that ` +
          `has stopped, or they would judge a site that is still being fetched`,
      );
    }
    // The stored judgement block, validated before the crawl is claimed or a
    // row is touched: an override of a rule this ruleset lacks (a later
    // ruleset removed it) is the CONFLICT the read surfaces answer, naming the
    // crawl and the rule and pointing at crawl_config_set — not the bare
    // `JudgementError` `runRules` would throw, which a transport answers 500.
    // Synchronous, like the claim below, so nothing can move between the two.
    // `crawl_config_set` validates against this registry, so a block that
    // passes here cannot gain an unknown rule before `runRules` reads it.
    readJudgementBlock(row.judgement, crawlId, this.registry);
    // Check and claim in ONE synchronous step — no `await` between them — so
    // two callers that both got past the status read cannot both see an
    // unheld crawl.
    if (this.judging.has(crawlId)) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is already being judged by this server: a rules run rewrites ` +
          `the crawl's issues, so two runs would leave the table holding half of each. ` +
          `Wait for the run in flight and read its summary, or ask again when it ends`,
      );
    }
    this.judging.add(crawlId);
    try {
      return await runRules(this.db, crawlId, this.registry);
    } catch (error) {
      // The one refusal `runRules` owns: an id nothing knows. It is raced with
      // the read above (a crawl deleted in between), so it is mapped rather
      // than assumed impossible.
      if (error instanceof Error && error.message.startsWith("no such crawl")) {
        throw new ServiceError("NOT_FOUND", `no such crawl '${crawlId}'`);
      }
      throw error;
    } finally {
      // Released on the failure path too: a run that threw is a run that is no
      // longer writing, and a crawl no one could ever judge again because one
      // run died would be a worse failure than the one being guarded against.
      this.judging.delete(crawlId);
    }
  }

  /**
   * A crawl's judgement: its current block (with `findingCap` folded in from
   * the config, where its bytes live), every overridable threshold as that
   * block leaves it, the stamp of the last rules run and whether the block has
   * moved since. `crawl_config_get` and `GET /crawls/:id/config`.
   *
   * One read of the crawl row (`loadJudgementView`), so the block, the stamp
   * and the staleness describe one instant. Refuses as the read surfaces do: a
   * stored override of a rule this ruleset lacks is a 409 naming it, which
   * `setCrawlJudgement` is the way out of.
   */
  async getCrawlConfig(crawlId: string): Promise<CrawlConfigOut> {
    return crawlConfigOf(crawlId, await this.judgementView(crawlId));
  }

  /**
   * Change a crawl's judgement: `crawl_config_set` and
   * `PATCH /crawls/:id/config`, body `{judgement: {...}}`.
   *
   * `judgement` is an RFC 7396 merge-patch (`mergePatch`) of the stored block:
   * objects merge key by key, and a `null` removes a key, so
   * `rules: {"title.too-long": null}` drops that rule's override and
   * `thresholds: {SLOW_MS: null}` returns the threshold to its default. The
   * merged block is parsed against the ruleset (`parseJudgement`) before
   * anything is written; a refusal writes nothing.
   *
   * ## `findingCap` is the one exception to "null removes"
   *
   * For this key null is a VALUE everywhere on the surface: uncapped, the
   * billed-audit setting `crawl_start` documents and `crawl_status` reports.
   * Reading `judgement.findingCap: null` as "remove the key" would turn an
   * agent's "list everything" into the engine's default of 200 without a word,
   * and the audit would come back truncated. So here, as at `crawl_start`,
   * null sets uncapped, and the default is restored by naming it — 200 judges
   * exactly as an absent key does (`resolveRuleCaps`, and `staleReasons`
   * compares the resolved caps). Every state stays reachable and none is
   * reached by accident. The cap is written to `config_jsonb.findingCap`,
   * never into `judgement_jsonb` (plan Deviation 1).
   *
   * ## Refusals
   *
   *  - any key other than `judgement`: VALIDATION (crawl fields are Phase 27b);
   *  - a `judgement` that is absent, null or not an object: VALIDATION — a null
   *    here would mean "delete the whole block", including a cap whose null is
   *    a value, so clearing is spelled per section instead;
   *  - a merged block `parseJudgement` refuses: VALIDATION, naming the path;
   *  - a rules run in flight for the crawl in this process: CONFLICT. Refused,
   *    not queued — the run read its judgement when it started and stamps
   *    what it read;
   *  - no such crawl: NOT_FOUND.
   *
   * The read-merge-write is one transaction holding the crawl row
   * (`for update`), so two concurrent patches cannot each lose the other's
   * key. The in-flight check is in-process, as `runRulesForCrawl`'s own is
   * (see there for why the hold is not in the database). A run that claims the
   * crawl between that check and this write reads either block, and stamps the
   * one it read, so `judgementStale` reports the outcome truthfully either way.
   */
  async setCrawlJudgement(crawlId: string, patch: unknown): Promise<CrawlConfigOut> {
    if (!isPlainObject(patch)) {
      throw new ServiceError("VALIDATION", "request body must be a JSON object");
    }
    const others = Object.keys(patch).filter((key) => key !== "judgement");
    if (others.length > 0) {
      throw new ServiceError(
        "VALIDATION",
        "only `judgement` can be set; crawl fields arrive in Phase 27b " +
          `(refused: ${others.map(clip).join(", ")})`,
      );
    }
    const judgementPatch = patch["judgement"];
    if (judgementPatch === undefined) {
      throw new ServiceError(
        "VALIDATION",
        "the body must carry `judgement`: the merge-patch to apply to the crawl's judgement block",
      );
    }
    if (!isPlainObject(judgementPatch)) {
      throw new ServiceError(
        "VALIDATION",
        "judgement must be a JSON object (a merge-patch of the block); to clear every " +
          'override send {"rules": null, "thresholds": null}',
      );
    }
    this.refuseWhileJudging(crawlId);

    const { findingCap: capPatch, ...blockPatch } = judgementPatch;
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ config: crawls.config, judgement: crawls.judgement })
        .from(crawls)
        .where(eq(crawls.id, crawlId))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (row === undefined) throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);

      // The stored block is what the patch merges onto, so it must be one.
      // The ONE refusal let through is an override of a rule this ruleset no
      // longer defines: removing it is the repair the read surfaces point
      // here for, and the merged block is parsed below either way — an
      // override the patch leaves in place is refused there, naming it.
      try {
        readStoredJudgement(row.judgement, crawlId, this.registry);
      } catch (error) {
        if (!(error instanceof JudgementError && error.reason === "unknown-rule")) throw error;
      }

      const merged = mergePatch(row.judgement ?? {}, blockPatch) as Record<string, unknown>;
      const block = this.parseJudgementInput(
        capPatch === undefined ? merged : { ...merged, findingCap: capPatch },
      );

      let config: unknown = undefined;
      if (block.findingCap !== undefined) {
        // Read through the same validation every reader of the key uses, so a
        // config this cannot read is refused rather than overwritten.
        try {
          storedFindingCap(row.config, crawlId);
        } catch (error) {
          throw new ServiceError("CONFLICT", messageOf(error));
        }
        config = { ...(row.config as Record<string, unknown>), findingCap: block.findingCap };
      }

      // Again, synchronously before the write: the check above was before an
      // `await`, and a run may have claimed the crawl since.
      this.refuseWhileJudging(crawlId);
      await tx
        .update(crawls)
        .set({ judgement: storableBlock(block), ...(config === undefined ? {} : { config }) })
        .where(eq(crawls.id, crawlId));
    });
    return await this.getCrawlConfig(crawlId);
  }

  /** The refusal `setCrawlJudgement` gives while this process is judging the crawl. */
  private refuseWhileJudging(crawlId: string): void {
    if (this.judging.has(crawlId)) {
      throw new ServiceError(
        "CONFLICT",
        `rules are running for crawl ${crawlId}: its judgement cannot change under a run ` +
          "that has already read it. Wait for crawl_rules to answer, then set it again",
      );
    }
  }

  /**
   * The whole ruleset as a catalog — and, when a crawl is named, what each rule
   * found on it. `GET /rules` and `rules_catalog`.
   *
   * This is the checklist a dashboard renders. `listIssues` answers "what is
   * wrong with this site" and therefore names only the rules that fired;
   * a UI has to draw the OTHER rows too — the checks that passed, and the
   * checks that exist at all before any crawl has been run. Those rows cannot
   * be reconstructed from a findings listing, because an absence there has no
   * name.
   *
   * ## Not paginated, and that is not an oversight
   *
   * Obligation 1 forbids a full export inline. This is not one: it is a CLOSED
   * resource whose size is the ruleset's, not the crawl's. It does not grow
   * with pages, findings or links — the three things that make an export an
   * export — and it is the same rows on a 5-page site and a 50k-page one. A
   * cursor over it would make every consumer loop to assemble a checklist they
   * need whole in order to draw anything at all. The listings that DO scale
   * with the data are all paginated, and none of them is this.
   *
   * BOUNDED IS NOT THE SAME AS SMALL, and the tool description says so rather
   * than letting a caller find out: every rule's full client-facing copy is
   * tens of kilobytes in one answer (about 80KB at ruleset 0.7.0 — roughly
   * 20k tokens for an agent deciding whether to spend the context on it).
   *
   * ## One walk, one query
   *
   * The registry is walked in memory (it is built once, at construction) and
   * joined against a SINGLE grouped count over `issues`. Never a count per
   * rule: that would be one round trip per rule for one dashboard paint, and it
   * would let the counts come from as many different snapshots.
   *
   * Sorted by severity then id for the rules that FIND — the order `listIssues`
   * returns its groups in, so a UI that renders both puts the same rule in the
   * same place twice — and by the DECLARED table order then id for the rules
   * that measure, which form one block at the end (see `catalogOrder`).
   */
  async rulesCatalog(opts: { crawlId?: string } = {}): Promise<RulesCatalog> {
    const ordered = [...this.registry.all()].sort(catalogOrder);
    // With a crawl named, its judgement: the copy is rendered with the
    // thresholds its findings were judged with, and type, priority and
    // `disabled` are its own after overrides. Without one, the registry's
    // defaults — the rendering every rule carries.
    const view = opts.crawlId === undefined ? null : await this.judgementView(opts.crawlId);
    const rendered = view === null ? null : copyRenderer(view.copyThresholds);
    const copy = (rule: AnyRule): CatalogRule => ({
      id: rule.id,
      kind: rule.kind,
      severity: rule.severity,
      // Absent on a metric rule, which has no findings to triage — spread, for
      // the `marker` discipline below.
      ...(rule.kind === "metric"
        ? {}
        : view === null
          ? { type: rule.type, priority: rule.priority }
          : triageFields(view, rule.id)),
      ...(view !== null && view.disabledRules.includes(rule.id)
        ? { disabled: true as const }
        : {}),
      category: rule.category,
      checkIds: [...rule.checkIds],
      ...(rendered === null
        ? { title: rule.title, explanation: rule.explanation, howToFix: rule.howToFix }
        : rendered(rule.id)),
      // Absent on a metric rule for `columns`' own reason (it writes no finding
      // row), spread rather than set to undefined so `"columns" in rule` and a
      // truthiness test agree — the `marker` discipline, one field along.
      ...(rule.kind === "metric"
        ? {
            table: {
              columns: metricTableColumns(rule.table),
              summary: metricTableSummary(rule.table),
              // The declared position, spread for the `marker` discipline: the
              // key is on a table that states one and absent on a table that
              // does not, so a client can tell "position 0" from "no position".
              ...(rule.table.order === undefined ? {} : { order: rule.table.order }),
            },
          }
        : { columns: columnsFor(rule) }),
      // The registry's flag, mirrored exactly: the key exists on a marker and
      // on nothing else. Spreading a `marker: undefined` instead would put the
      // key on all 96 rows and make "is this a marker" a truthiness question
      // about a value that is sometimes absent — see `CatalogRule.marker`.
      ...(rule.marker === undefined ? {} : { marker: rule.marker }),
    });

    // NO CRAWL, NO `fired` KEY AT ALL. Not `null`, which means "this crawl was
    // never judged" — a claim about a crawl nobody named would be an answer to
    // a question nobody asked.
    if (opts.crawlId === undefined || view === null) {
      return { rulesetVersion: RULESET_VERSION, rules: ordered.map(copy) };
    }

    const { judged, fired } = await this.firedByRule(opts.crawlId);
    const firedFor = (rule: AnyRule): RuleFired => {
      const counted = fired.get(rule.id) ?? { count: 0 };
      // A metric rule's zero is structural, not a verdict: it measures rather
      // than finds, so it writes no issues on any crawl. The flag rides the
      // payload rather than the tool description because a dashboard reads the
      // payload — see `RuleFired`.
      return rule.kind === "metric" ? { ...counted, measuresOnly: true } : counted;
    };
    return {
      rulesetVersion: RULESET_VERSION,
      rules: ordered.map((rule) => ({
        ...copy(rule),
        // The whole distinction, in one expression: unjudged is null for every
        // rule, and judged is a count for every rule — zero where the rule
        // wrote nothing, which is a measurement rather than a silence.
        fired: judged ? firedFor(rule) : null,
      })),
      judgementStale: view.judgementStale,
      thresholds: { ...view.copyThresholds },
    };
  }

  /**
   * One crawl's judged-state and its findings-per-rule, from ONE statement.
   *
   * The marker and the counts ride together for the reason `crawlRowWithCounts`
   * spells out: `runRules` clears `rules_run_at` and deletes the crawl's issues
   * in a single transaction, so two reads on two pool connections could compose
   * `{judged: true, counts: none}` — a state that never existed, and precisely
   * the one a dashboard would paint as a clean site. A `left join lateral`
   * keeps them in one snapshot and still answers for a crawl with no findings
   * at all (one row, `rule_id` null).
   *
   * A rule id the current ruleset does not define is a refusal, not a dropped
   * row (`ruleFor`, the same 409 `listIssues` raises). Silently skipping it
   * would leave the catalog's counts no longer summing to `findingsCount`, with
   * nothing on the wire saying why.
   */
  private async firedByRule(
    crawlId: string,
  ): Promise<{ judged: boolean; fired: Map<string, RuleFired> }> {
    const result = await this.db.execute<{
      judged: boolean;
      rule_id: string | null;
      n: number | null;
      truncation: unknown;
    }>(sql`
      select c.rules_run_at is not null as judged,
             g.rule_id,
             g.n,
             g.truncation
        from crawls c
        left join lateral (
          select i.rule_id,
                 count(*)::int as n,
                 ${truncationNote(crawlId)} as truncation
            from issues i
           where i.crawl_id = c.id
           group by i.rule_id
        ) g on true
       where c.id = ${crawlId}`);

    const rows = result.rows;
    const first = rows[0];
    if (first === undefined) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
    }

    const fired = new Map<string, RuleFired>();
    for (const row of rows) {
      // The left join's own row for a crawl that holds no findings.
      if (row.rule_id === null) continue;
      this.ruleFor(row.rule_id, crawlId, "issues");
      if (typeof row.n !== "number") {
        throw new Error(
          `firedByRule: rule '${row.rule_id}' counted as ${typeof row.n}, not a number`,
        );
      }
      const note = truncationOf(row.truncation, row.rule_id);
      fired.set(
        row.rule_id,
        note.truncated === true ? { count: row.n, atLeast: true } : { count: row.n },
      );
    }
    return { judged: first.judged === true, fired };
  }

  /**
   * The crawl's findings, grouped by rule: the triage view.
   *
   * GROUPED BY (rule, severity) rather than by rule alone, and the pair is the
   * sort key. A rule's severity is single-sourced from its identity
   * (`queryFinding`, `pageRule`), so today the two group the same way — but the
   * severity in the answer is read from the ROWS, not from the registry,
   * because it is a fact about what was recorded rather than copy. If a crawl
   * ever holds rows for one rule at two severities (a re-judge across a ruleset
   * change), both appear, in their own places in the order, rather than one
   * being picked arbitrarily and the other vanishing.
   *
   * The copy — title, category, checkIds — is joined from the registry here,
   * at read time. A rule id the current ruleset does not define is a 409 naming
   * it: the alternative is a findings table rendered with blank titles, which
   * is a report a client cannot act on and a silence hard rule 7 forbids.
   *
   * ## The truncation note
   *
   * A capped rule stamps its magnitude onto one of its findings
   * (`noteTruncation` / `noteAtLeastTruncation`), and that fact is lifted onto
   * the group as `truncated` + `total` | `atLeast` (`IssueTruncation`). Without
   * it `count: 200` on a rule that stops listing at 200 reads as "200 cases",
   * which is what the Phase 6 gate's auditor was told to report.
   *
   * The note is read RULE-WIDE — a subquery over this crawl and this rule id,
   * outside the filters the caller supplied — for one reason: no filter may be
   * able to HIDE a truncation. The note lives on a single row, so a `pageType`
   * or `severity` filter that happened to exclude that row would answer a
   * capped listing with no note at all, and silence here reads as "count is the
   * total". Over-reporting the magnitude is the survivable direction; hiding it
   * is not.
   *
   * The consequence, stated rather than left to be discovered: under a
   * `pageType` filter `count` is the cohort's rows while `total`/`atLeast`
   * remain the RULE's magnitude, so the two are not two ends of one fraction.
   * The field names a property of the rule's run; the count names the rows in
   * front of you.
   */
  async listIssues(
    crawlId: string,
    opts: IssueQuery = {},
  ): Promise<Page<IssueGroup> & { disabledRules: string[]; judgementStale: JudgementStale }> {
    // The crawl's judgement, which also answers the 404 for a crawl nothing knows.
    const view = await this.judgementView(crawlId);
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeIssueCursor(opts.cursor);
    const copy = copyRenderer(view.copyThresholds);

    // A disabled rule's findings are stored and left out HERE, in SQL (hard
    // rule 3); `disabledRules` on the answer says which, so a reader can tell
    // "filtered out" from "did not fire".
    const where: SQL[] = [sql`i.crawl_id = ${crawlId}`, notDisabled(view.disabledRules)];
    if (opts.severity !== undefined) where.push(sql`i.severity = ${parseSeverity(opts.severity)}`);
    const ruleIds = this.filterRuleIds(opts);
    // `in ${ids}` rather than `= any(${ids})`: drizzle spreads an array in a
    // template into a parenthesised parameter list, so the `any` spelling
    // compiles to `any(($1))` — a record where an array was meant, which
    // Postgres refuses. `filterRuleIds` never returns an empty list, which is
    // the one shape `in ()` could not express.
    if (ruleIds !== null) where.push(sql`i.rule_id in ${ruleIds}`);
    if (opts.pageType !== undefined) {
      const match = await this.pageTypeCondition(crawlId, opts.pageType);
      // Reaches through the finding's page, which means a SITE-WIDE finding
      // (page_id null) is not in a page-type cohort — correctly: it is not a
      // fact about that template, or about any template.
      where.push(
        sql`exists (select 1 from pages p where p.crawl_id = ${crawlId} and p.id = i.page_id and ${match})`,
      );
    }
    if (cursor !== null) {
      where.push(
        sql`(${SEVERITY_RANK}, i.rule_id) > (${cursor.rank}::int, ${cursor.ruleId}::text)`,
      );
    }

    const result = await this.db.execute<{
      rule_id: string;
      severity: string;
      severity_rank: number;
      n: number;
      sample_urls: string[] | null;
      truncation: unknown;
    }>(sql`
      select i.rule_id,
             i.severity,
             ${SEVERITY_RANK} as severity_rank,
             count(*)::int as n,
             (array_agg(distinct i.details_jsonb->>'pageUrl'
                        order by i.details_jsonb->>'pageUrl')
                filter (where i.details_jsonb->>'pageUrl' is not null)
             )[1:${sql.raw(String(ISSUE_SAMPLE_URLS))}] as sample_urls,
             ${truncationNote(crawlId)} as truncation
      from issues i
      where ${sql.join(where, sql` and `)}
      group by i.rule_id, i.severity
      order by severity_rank asc, i.rule_id asc
      limit ${limit + 1}`);

    const rows = result.rows;
    const items = rows.slice(0, limit).map((row) => {
      const rule = this.ruleFor(row.rule_id, crawlId, "issues");
      return {
        ruleId: row.rule_id,
        checkIds: [...rule.checkIds],
        severity: row.severity,
        ...triageFields(view, row.rule_id),
        category: rule.category,
        // Rendered with the thresholds the findings were judged with, so a
        // title that quotes a number quotes the one the rule used.
        title: copy(row.rule_id).title,
        count: row.n,
        // Null is what Postgres returns for an aggregate over no rows that
        // pass the filter — a rule whose every finding is site-wide. An empty
        // list is the honest reading and the one a caller can iterate.
        sampleUrls: row.sample_urls ?? [],
        ...truncationOf(row.truncation, row.rule_id),
      };
    });
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      nextCursor:
        last === undefined
          ? null
          : encodeCursor(String(last.severity_rank), last.rule_id),
      disabledRules: view.disabledRules,
      judgementStale: view.judgementStale,
    };
  }

  /**
   * The Issues Overview: one row per rule with the crawl's judgement applied
   * (`overview.ts`). `issues_overview` and the `issues_overview` CSV view are
   * both this one answer.
   */
  async issuesOverview(
    crawlId: string,
    opts: { includeZero?: boolean } = {},
  ): Promise<IssuesOverview> {
    return (await this.issuesOverviewRead(crawlId, opts.includeZero === true)).overview;
  }

  /**
   * The Issues Overview with the judgement view it was built from, both read
   * inside the builder's one snapshot (Ruling 14). The CSV renders its copy
   * from this same view instead of reading the crawl row a second time.
   */
  private async issuesOverviewRead(
    crawlId: string,
    includeZero: boolean,
  ): Promise<{ overview: IssuesOverview; view: JudgementView }> {
    return await buildIssuesOverview(
      this.db,
      crawlId,
      this.registry,
      (id) => this.ruleFor(id, crawlId, "issues"),
      includeZero,
    );
  }

  /**
   * The Crawl Overview: sectioned counts that describe the crawl
   * (`buildCrawlOverview`). `crawl_overview` and the `crawl_overview` CSV view
   * are both this one answer. The `urls` section is `getCrawl`'s own fields, so
   * it reconciles with `crawl_status` by construction; an unknown crawl is the
   * `NOT_FOUND` `getCrawl` answers.
   */
  async crawlOverview(crawlId: string): Promise<CrawlOverview> {
    return (await this.crawlOverviewRead(crawlId)).overview;
  }

  /** `crawlOverview` with the judgement view it was built under (one snapshot). */
  private async crawlOverviewRead(
    crawlId: string,
  ): Promise<{ overview: CrawlOverview; view: JudgementView }> {
    return await buildCrawlOverview(
      this.db,
      crawlId,
      this.registry,
      (reader) => this.crawlDetailOn(reader, crawlId),
      (id) => this.ruleFor(id, crawlId, "issues"),
    );
  }

  /**
   * One rule's findings, URL by URL — the action-plan tab feed.
   *
   * Ordered by URL, with `dedupe_key` breaking ties. That pair is a TOTAL order
   * (the `issues_dedupe` unique index is on crawl, rule and dedupe key), which
   * is what makes the cursor exact rather than approximately right.
   *
   * The sort key coalesces a null `pageUrl` to the empty string, so site-wide
   * findings sort first and stay INSIDE the keyset comparison. A row comparison
   * against a null is null — neither true nor false — so ordering on the raw
   * column would have dropped exactly those rows from every page after the
   * first: the quiet kind of pagination bug that looks like a clean site. The
   * empty string is unambiguous here because a `pageUrl` is either absent or a
   * URL, and no URL is empty (the `sitemap_urls.url_normalised` precedent).
   */
  async listIssueUrls(
    crawlId: string,
    ruleId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<IssueUrlPage> {
    const view = await this.judgementView(crawlId);
    const rule = this.findingRule("ruleId", ruleId);
    // A disabled rule is refused rather than answered: its findings are stored,
    // and an empty page would read as "this rule found nothing".
    refuseIfDisabled(view, crawlId, ruleId);
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor, 2);

    const where: SQL[] = [sql`i.crawl_id = ${crawlId}`, sql`i.rule_id = ${ruleId}`];
    if (cursor !== null) {
      where.push(
        sql`(coalesce(i.details_jsonb->>'pageUrl', ''), i.dedupe_key) >
            (${cursor[0]}::text, ${cursor[1]}::text)`,
      );
    }

    // THE JOIN IS A LEFT JOIN, and that is the whole shape of the standard
    // columns. A finding names a page (`issues.page_id`), names a URL with no
    // page row behind it, or names nothing at all — an inner join would drop the
    // last two silently, which is a listing that says a rule found fewer things
    // than it did (hard rule 7). The eight columns are the projection
    // `indexabilityOf` reads and nothing else: this is a listing, not
    // `pages_query`.
    const result = await this.db.execute<{
      url: string | null;
      url_key: string;
      evidence: unknown;
      dedupe_key: string;
      page_url: string | null;
      status_code: number | null;
      fetch_class: string | null;
      robots_meta: string | null;
      x_robots_tag: string | null;
      is_indexable: boolean | null;
      canonical_html: string | null;
      canonical_header: string | null;
    }>(sql`
      select i.details_jsonb->>'pageUrl' as url,
             coalesce(i.details_jsonb->>'pageUrl', '') as url_key,
             i.details_jsonb as evidence,
             i.dedupe_key,
             p.url as page_url, p.status_code, p.fetch_class,
             p.robots_meta, p.x_robots_tag, p.is_indexable,
             p.canonical_html, p.canonical_header
      from issues i
      -- The crawl is on BOTH sides of the join, not just in the WHERE. A page
      -- id is unique across the database today, so this is belt and braces —
      -- and it is the kind of belt Talos obligation 6 asks for: a join that can
      -- only ever reach rows of the crawl the caller named cannot serve one
      -- tenant's page beside another's finding, whatever a future id scheme
      -- does.
      left join pages p on p.id = i.page_id and p.crawl_id = i.crawl_id
      where ${sql.join(where, sql` and `)}
      order by url_key asc, i.dedupe_key asc
      limit ${limit + 1}`);

    const rows = result.rows;
    const items = rows.slice(0, limit).map((row): IssueUrl => {
      // `fetch_class` is `not null` on a `pages` row, so a null here is the
      // left join finding nothing — there is no page, and the three derived
      // columns are null rather than guessed.
      const judged =
        row.fetch_class === null
          ? null
          : indexabilityOf({
              url: row.page_url ?? "",
              fetchClass: row.fetch_class,
              statusCode: row.status_code,
              robotsMeta: row.robots_meta,
              xRobotsTag: row.x_robots_tag,
              isIndexable: row.is_indexable,
              canonicalHtml: row.canonical_html,
              canonicalHeader: row.canonical_header,
            });
      return {
        url: row.url,
        address: row.url,
        statusCode: row.fetch_class === null ? null : row.status_code,
        indexability: judged === null ? null : judged.indexability,
        indexabilityStatus: judged === null ? null : judged.status,
        evidence: asEvidence(row.evidence, crawlId, ruleId),
      };
    });
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      columns: columnsFor(rule),
      items,
      nextCursor: last === undefined ? null : encodeCursor(last.url_key, last.dedupe_key),
    };
  }

  /**
   * THE COMPANION INLINKS REPORT for the three rules that report a linked
   * TARGET (`INLINK_REPORT_TARGETS`): every internal link that points at a
   * broken or robots-blocked target, one row per LINK.
   *
   * `GET /crawls/:id/issues/:rule/inlinks` and the `issue_inlinks` tool. It
   * exists because `links.broken-internal`, `links.to-server-error` and (Phase
   * 23 T3) `robots.blocks-internal-urls` report the TARGET — one dead or
   * blocked URL linked from two hundred pages is one thing to fix,
   * and two hundred findings would bury it — while the person who makes the fix
   * edits the SOURCE page's markup. The finding's `sampleSources` is a sample of
   * ten; this is the list, and it is the same list Screaming Frog's "inlinks"
   * export beside each issue is (`Source`, `Destination`, `Anchor`,
   * `Status Code`).
   *
   * SQL ONLY, hard rule 3: the `links` table is never loaded into memory. One
   * keyset-cursored, bounded query over `(source_page_id, target_url, position)`
   * — the same total order the CSV views ride, and the same the `links` primary
   * key is built on.
   *
   * IT READS THE LINKS, NOT THE FINDINGS. The predicate is the target page's
   * own `fetch_class`, which is exactly what the rule fires on, so the rows here
   * are the links behind the rule's findings whether or not a rules pass has
   * ever run — and a rule that CAPPED its findings still gets a complete inlinks
   * report, because the cap is on how many targets were listed and this is
   * about the links.
   *
   * THE PRICE OF THAT, STATED: on a capped run this report can name a
   * destination that has no row in `/urls` at all, because the rule's listing
   * stopped before reaching it. The two answers are the same crawl read through
   * different limits, not a disagreement — but a client joining one to the other
   * has to expect destinations the findings page never showed it.
   */
  async listIssueInlinks(
    crawlId: string,
    ruleId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<IssueInlinkPage> {
    const view = await this.judgementView(crawlId);
    this.findingRule("ruleId", ruleId);
    // Refused for a disabled rule, as `listIssueUrls` is, although this report
    // reads the links rather than the findings: it is the rule's report, and
    // the crawl's judgement says the rule is not reported on.
    refuseIfDisabled(view, crawlId, ruleId);
    const target = INLINK_REPORT_TARGETS[ruleId];
    if (target === undefined) {
      // A 404, not an empty page: "this rule has no inlinks report" and "this
      // rule's inlinks report is empty" are different sentences, and answering
      // the second to the first question is the silent failure hard rule 7
      // forbids. The message names the rules that DO have one, so a caller that
      // guessed is told what to ask for instead.
      throw new ServiceError(
        "NOT_FOUND",
        `rule '${clip(ruleId)}' has no inlinks report: only ` +
          `${Object.keys(INLINK_REPORT_TARGETS).sort().join(", ")} report the links that ` +
          "point at what they found — every other rule reports the page itself, and its " +
          "rows are on /issues/:rule/urls",
      );
    }
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor, 3);
    const after = cursor ?? ["", "", "-1"];
    const position = Number(after[2]);
    if (!Number.isInteger(position)) {
      throw new ServiceError("VALIDATION", "cursor is not a cursor this listing issued");
    }

    const result = await this.db.execute<{
      source: string;
      destination: string;
      anchor: string | null;
      status_code: number | null;
      source_page_id: string;
      position: number;
    }>(sql`
      select src.url as source, l.target_url as destination, l.anchor,
             tgt.status_code, l.source_page_id, l.position
      from links l
      join pages src on src.crawl_id = ${crawlId} and src.id = l.source_page_id
      join pages tgt on tgt.crawl_id = ${crawlId} and tgt.url = l.target_url
      where l.crawl_id = ${crawlId}
        and l.is_internal
        and ${target}
        and (l.source_page_id, l.target_url, l.position) >
            (${after[0]}::text, ${after[1]}::text, ${position}::int)
      order by l.source_page_id asc, l.target_url asc, l.position asc
      limit ${limit + 1}`);

    const rows = result.rows;
    const items = rows.slice(0, limit).map((row) => ({
      source: row.source,
      destination: row.destination,
      anchor: row.anchor,
      statusCode: row.status_code,
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      columns: INLINK_COLUMNS,
      items,
      nextCursor:
        last === undefined
          ? null
          : encodeCursor(last.source_page_id, last.destination, String(last.position)),
    };
  }

  /**
   * Two crawls of one site, rule by rule: what appeared, what went away, what
   * is still there. `GET /compare` and `crawl_compare`.
   *
   * ## Identity: `(rule_id, url)`, and why it is not `dedupe_key`
   *
   * `dedupe_key` is the column the `issues_dedupe` unique index is built on, so
   * it is tempting to read it as "which finding this is". It is not, and the
   * reference data says so in four different shapes. The key is whatever a rule
   * chose to make its findings distinct WITHIN ONE CRAWL, and the ruleset uses
   * it four ways:
   *
   *  1. **The page URL** — most rules (`links.orphan`, `title.too-long`,
   *     `meta-description.missing`, `links.broken-internal`, …).
   *  2. **A CONTENT HASH** — `title.duplicate`, `meta-description.duplicate`,
   *     `h1.duplicate-text` key on a hash of the duplicated VALUE;
   *     `content.exact-duplicate` and `content.near-duplicate` key on a content
   *     hash or a hash of a URL PAIR.
   *  3. **A COMPOSITE naming a second URL or a code** —
   *     `hreflang.missing-return-link` is `<pageUrl>→<member>`, the hreflang
   *     cluster rules are `<pageUrl>#<code>`.
   *  4. **The literal string `"site"`** — every rule whose finding is about the
   *     crawl rather than a page (`sitemap.missing`, `robots.missing`,
   *     `schema.none-on-site`).
   *
   * Only shape 1 is stable across crawls in the way a diff needs. Shape 2 moves
   * the moment the site edits the text: a page whose title is still duplicated,
   * with a word changed, hashes differently — and a `dedupe_key` diff would
   * report that as one finding resolved and one new, which is the opposite of
   * what happened. Shape 3 is stable only while BOTH endpoints are, so one
   * removed page invents a resolution on every page that pointed at it. Shape 4
   * is a constant and would compare correctly, which is the exception that
   * proves the rule rather than a reason to use the column.
   *
   * The page URL is the one identity every finding shares and the only one that
   * means the same thing in two crawls, so the join is `(rule_id, pageUrl)` —
   * read from `details_jsonb->>'pageUrl'`, which `runRules` writes onto every
   * row from the finding's own `pageUrl` (src/rules/run.ts).
   *
   * **What that costs, stated rather than discovered.** A rule that fires more
   * than once on a page COLLAPSES TO PER-URL PRESENCE. On the reference crawl
   * `images.oversized` — one finding per IMAGE — wrote 833 findings across 157
   * URLs; this comparison sees 157 things, and a page that went from one
   * oversized image to nine is `persisting`, not `new`. (`content.near-duplicate`
   * was this paragraph's example while it reported PAIRS; since Phase 19 §11 it
   * is one row per page and no longer multi-fires.) That is why `baseCount` and
   * `headCount` (rows — the numbers `issues_list` reports) travel beside
   * `baseUrls` and `headUrls` (the diff's own denominators), and why the two
   * invariants are stated on the URL counts:
   * `headUrls == new + persisting` and `baseUrls == resolved + persisting`.
   *
   * A SITE-LEVEL finding has no page URL. It compares by RULE PRESENCE — the
   * key is the empty string, which no URL can be (`listIssueUrls`' precedent) —
   * and it surfaces in the drill-down as `url: null`.
   *
   * ## The refusals, in the order they are checked
   *
   *  1. **Either crawl unknown** — 404 naming it.
   *  2. **The same crawl twice** — a diff of a crawl against itself is every
   *     rule `persisting` and every delta zero, which a dashboard would paint as
   *     "nothing changed on this site". It is a caller mistake with a
   *     plausible-looking answer, so it is refused rather than answered.
   *  3. **Different sites** — 400 naming both hosts. Before the judged check, on
   *     purpose: a caller who names another tenant's crawl must not learn from
   *     the refusal whether that crawl has been judged (obligation 6).
   *  4. **Either crawl unjudged** — 400 naming which. `rulesRunAt` null means no
   *     complete rules pass is on record, so an empty side is "nobody looked",
   *     and diffing it would report every finding on the other side as new or
   *     resolved. The reference crawl `crawl_2af4daf1` is exactly this: 1,314
   *     findings in the table and `rules_run_at` null.
   *
   * A RULESET MISMATCH IS NOT A REFUSAL. It is `comparable: false` with a caveat
   * naming both versions, and the counts are returned — the engine states what
   * it knows and the consumer decides whether to draw the Change column. Nor is
   * a finding-cap mismatch, which gets its own caveat and also clears
   * `comparable`: on the reference pair the base was capped at 200 per listing
   * and the head was uncapped, and `links.orphan` moves 200 → 243 for that
   * reason alone.
   *
   * ## One snapshot
   *
   * Both statements run inside one `repeatable read, read only` transaction.
   * `runRules` clears `rules_run_at` and deletes the crawl's issues in a single
   * transaction (src/rules/run.ts), so a re-judge landing between the crawl-row
   * read and the aggregate would compose a comparison neither state ever had:
   * "judged, and every finding resolved". This is `crawlRowWithCounts`' argument
   * where the two facts cannot be put in one statement.
   */
  async compareCrawls(baseCrawlId: string, headCrawlId: string): Promise<CrawlComparison> {
    return await this.db.transaction(
      async (tx) => {
        const { base, head } = await comparePair(tx, baseCrawlId, headCrawlId);
        const rows = await compareRuleRows(tx, baseCrawlId, headCrawlId);

        const caveats: CompareCaveat[] = [];
        const rules: CompareRule[] = [];
        let baseFindings = 0;
        let headFindings = 0;
        for (const row of rows) {
          const rule = this.ruleFor(row.rule_id, row.base_n > 0 ? baseCrawlId : headCrawlId, "issues");
          const baseSevs = row.base_sevs ?? [];
          const headSevs = row.head_sevs ?? [];
          const worst = (list: string[]): string =>
            [...list].sort((a, b) => severityRank(a) - severityRank(b))[0] ?? rule.severity;
          // The head's reading is the current one. A rule that fired only in the
          // base has no head reading, and its own is what there is.
          const severity = headSevs.length > 0 ? worst(headSevs) : worst(baseSevs);
          if (baseSevs.length > 0 && headSevs.length > 0 && !sameSet(baseSevs, headSevs)) {
            caveats.push({
              code: "severity-changed",
              message:
                `rule '${row.rule_id}' is recorded at ${[...baseSevs].sort().join("/")} in ` +
                `${baseCrawlId} and ${[...headSevs].sort().join("/")} in ${headCrawlId}: the ` +
                `row reports the head severity (${severity}), and a severity column charted ` +
                `across the two crawls is charting a ruleset change rather than the site`,
            });
          }
          baseFindings += row.base_n;
          headFindings += row.head_n;
          rules.push({
            ruleId: row.rule_id,
            severity,
            category: rule.category,
            checkIds: [...rule.checkIds],
            title: rule.title,
            baseCount: row.base_n,
            headCount: row.head_n,
            baseUrls: row.base_u,
            headUrls: row.head_u,
            new: row.added,
            resolved: row.removed,
            persisting: row.kept,
            baseTruncated: row.base_trunc,
            headTruncated: row.head_trunc,
          });
        }
        rules.sort(
          (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.ruleId.localeCompare(b.ruleId),
        );

        const baseSide: CompareSide = { ...base, rulesetVersions: versionsOf(rows, "base"), findingsCount: baseFindings };
        const headSide: CompareSide = { ...head, rulesetVersions: versionsOf(rows, "head"), findingsCount: headFindings };
        // BOTH CHECKS RUN, ALWAYS. `&&` would short-circuit, and the pair that
        // most needs both sentences is exactly the one where the first fails:
        // the reference pair is judged by two rulesets AND under two finding
        // caps, and a reader told only about the ruleset would attribute
        // `links.orphan` 200 → 243 to a ruleset change. The caveats are the
        // answer; `comparable` is only their conjunction.
        const rulesetAgrees = rulesetCaveat(baseSide, headSide, caveats);
        const capsAgree = capCaveat(baseSide, headSide, caveats);
        const comparable = rulesetAgrees && capsAgree;
        // Not part of `comparable`: the counts above are the stored findings,
        // disabled rules included, so they ARE comparable — but a reader who
        // holds them beside either crawl's issues_list deserves to know why
        // that listing is shorter. Read inside this snapshot.
        await this.overridesCaveats(tx, [baseCrawlId, headCrawlId], caveats);
        // Severity caveats are appended above, inside the rule walk; sorting the
        // list puts the whole-comparison ones first whatever order they were
        // found in, so a reader meets the reason `comparable` is false before the
        // per-rule notes.
        caveats.sort((a, b) => CAVEAT_ORDER.indexOf(a.code) - CAVEAT_ORDER.indexOf(b.code));
        return { base: baseSide, head: headSide, comparable, caveats, rules };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * The `judgement-overrides` caveat for each side whose stored judgement
   * disables a rule, naming the crawl and how many. Inside the comparison's
   * transaction, so the blocks are read from the same snapshot as the counts.
   */
  private async overridesCaveats(
    tx: Pick<Db, "select">,
    crawlIds: string[],
    caveats: CompareCaveat[],
  ): Promise<void> {
    const ids = [...new Set(crawlIds)];
    const rows = await tx
      .select({
        id: crawls.id,
        config: crawls.config,
        judgement: crawls.judgement,
        rulesJudgedWith: crawls.rulesJudgedWith,
        rulesRunAt: crawls.rulesRunAt,
      })
      .from(crawls)
      .where(inArray(crawls.id, ids));
    for (const id of ids) {
      const row = rows.find((r) => r.id === id);
      if (row === undefined) {
        throw new Error(`compareCrawls: crawl ${id} vanished inside the comparison's snapshot`);
      }
      const { disabledRules } = judgementViewOf(row, id, this.registry);
      if (disabledRules.length === 0) continue;
      const n = disabledRules.length;
      caveats.push({
        code: "judgement-overrides",
        message:
          `crawl '${id}' has ${n} rule${n === 1 ? "" : "s"} disabled by its judgement ` +
          `(${disabledRules.join(", ")}): their stored findings are counted in this ` +
          "comparison, but issues_list and the exports leave them out of that crawl's " +
          "listings, so the two will not agree for those rules",
      });
    }
  }

  /**
   * One rule's URLs in one of a comparison's three sets — the drill-down behind
   * the counts. `GET /compare/urls` and `compare_urls`.
   *
   * The counts are on the summary and the URLs are only here, which is
   * obligation 1's shape: a chat agent gets `new: 243` in one small object and
   * asks for the list when it wants the list.
   *
   * **The set arithmetic is SQL's** (rule 3). `except` and `intersect` over two
   * `select distinct`s that each ride the `issues_crawl_rule` index; the keyset
   * predicate goes INSIDE the left-hand select, where it is a filter on the
   * ordering column rather than a filter on the result of a set operation, so
   * the plan stays a bounded scan of one rule's rows and this process never
   * holds more than a page.
   *
   * Ordered by the URL key, which is a total order (the two sets are sets of
   * distinct keys), so the cursor is exact rather than approximately right. The
   * empty-string key sorts first and comes back as `url: null` — the site-level
   * finding, which compares by rule presence.
   */
  async listCompareUrls(
    baseCrawlId: string,
    headCrawlId: string,
    ruleId: string,
    set: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Page<CompareUrl>> {
    this.findingRule("ruleId", ruleId);
    const which = parseCompareSet(set);
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor, 1)[0];

    return await this.db.transaction(
      async (tx) => {
        await comparePair(tx, baseCrawlId, headCrawlId);
        // Which side leads the set operation IS the definition of the set:
        // `new` and `persisting` are questions about the head's URLs, `resolved`
        // is a question about the base's. The keyset predicate rides the leading
        // select for that reason — it is the side whose rows are being ordered.
        const lead = which === "resolved" ? baseCrawlId : headCrawlId;
        const other = which === "resolved" ? headCrawlId : baseCrawlId;
        const operator = which === "persisting" ? sql`intersect` : sql`except`;
        const result = await tx.execute<{ k: string }>(sql`
          select k from (
            (select distinct coalesce(i.details_jsonb->>'pageUrl', '') as k
               from issues i
              where i.crawl_id = ${lead} and i.rule_id = ${ruleId}
                ${cursor === null ? sql`` : sql`and coalesce(i.details_jsonb->>'pageUrl', '') > ${cursor}`})
            ${operator}
            (select distinct coalesce(i.details_jsonb->>'pageUrl', '') as k
               from issues i
              where i.crawl_id = ${other} and i.rule_id = ${ruleId})
          ) s
          order by k asc
          limit ${limit + 1}`);

        const rows = result.rows;
        const items = rows.slice(0, limit).map((row) => ({ url: row.k === "" ? null : row.k }));
        const last = rows.length > limit ? rows[limit - 1] : undefined;
        return { items, nextCursor: last === undefined ? null : encodeCursor(last.k) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * The crawl's metrics, with the registry's copy joined.
   *
   * `value` crosses the wire exactly as the metric rule wrote it. A metric is a
   * measurement, and reshaping one in the API layer would put a second opinion
   * about what was counted between the rule and the reader.
   */
  async listMetrics(
    crawlId: string,
    opts: MetricQuery = {},
  ): Promise<Page<MetricRow> & { judgementStale: JudgementStale }> {
    // The crawl's judgement, for `judgementStale` only: a metric is a stored
    // measurement of the run that wrote it (`site.health` counted the rules
    // that run left enabled), so the flag says whether the block has moved
    // since — the rows themselves are served as written.
    const view = await this.judgementView(crawlId);
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor, 3);

    const where: SQL[] = [sql`m.crawl_id = ${crawlId}`];
    if (opts.metricId !== undefined) {
      const rule = this.rules.get(opts.metricId);
      if (rule === undefined || rule.kind !== "metric") {
        throw new ServiceError(
          "VALIDATION",
          `metricId '${clip(opts.metricId)}' is not a metric this ruleset defines`,
        );
      }
      where.push(sql`m.metric_id = ${opts.metricId}`);
    }
    if (opts.scope !== undefined) {
      if (!(METRIC_SCOPES as readonly string[]).includes(opts.scope)) {
        throw new ServiceError(
          "VALIDATION",
          `scope '${clip(opts.scope)}' is not a metric scope (one of: ${METRIC_SCOPES.join(", ")})`,
        );
      }
      where.push(sql`m.scope = ${opts.scope}`);
    }
    if (opts.scopeValue !== undefined) {
      // Free text — a template name or a sitemap URL — so it is validated
      // against the crawl's own rows rather than a closed list. A name this
      // crawl never measured is a typo, and an empty page would read as "that
      // cohort has no metrics" (which is a different, false statement).
      await this.assertExists(
        sql`select 1 from metrics where crawl_id = ${crawlId} and scope_value = ${opts.scopeValue} limit 1`,
        `scopeValue '${clip(opts.scopeValue)}' names nothing crawl ${crawlId} measured`,
      );
      where.push(sql`m.scope_value = ${opts.scopeValue}`);
    }
    if (cursor !== null) {
      where.push(
        sql`(m.metric_id, m.scope, m.scope_value) >
            (${cursor[0]}::text, ${cursor[1]}::text, ${cursor[2]}::text)`,
      );
    }

    const result = await this.db.execute<{
      metric_id: string;
      scope: string;
      scope_value: string;
      value: unknown;
    }>(sql`
      select m.metric_id, m.scope, m.scope_value, m.value_jsonb as value
      from metrics m
      where ${sql.join(where, sql` and `)}
      order by m.metric_id asc, m.scope asc, m.scope_value asc
      limit ${limit + 1}`);

    const rows = result.rows;
    const items = rows.slice(0, limit).map((row) => {
      const rule = this.ruleFor(row.metric_id, crawlId, "metrics");
      return {
        metricId: row.metric_id,
        scope: row.scope,
        scopeValue: row.scope_value,
        value: row.value,
        title: rule.title,
        explanation: rule.explanation,
        checkIds: [...rule.checkIds],
        category: rule.category,
      };
    });
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      nextCursor:
        last === undefined
          ? null
          : encodeCursor(last.metric_id, last.scope, last.scope_value),
      judgementStale: view.judgementStale,
    };
  }

  /**
   * ONE METRIC AS A TABLE: the rows it wrote for this crawl, shaped by its own
   * declaration into a header and rows (`MetricTableOut`).
   *
   * ## Why the rows are read whole, and what bounds them
   *
   * Every other listing on this surface is a keyset cursor, because its rows are
   * a table that grows with the site. These are not: one metric's rows for one
   * crawl are one row per COHORT — a page type, a sitemap document, or the site
   * — and the cohorts are the crawler's collapsed template set, tens of rows on
   * a real site. The shaping needs them together anyway (a table has one header
   * and one order), so this reads them in one statement and shapes them in one
   * place rather than paginating a page the client would have to reassemble.
   * `metrics_get` is still the paginated read of the same rows for an agent that
   * wants the raw values.
   *
   * ## The three empty answers, which are three different sentences
   *
   *  - **An unknown metric id is a 404**, not an empty table: the id is the
   *    RESOURCE here, where on `metrics_get` it is a filter (and a 400 there).
   *    `retired.metric` and `redirect.volme` are both "no such thing", and a
   *    table rendered with no columns would say "this metric measured nothing".
   *  - **A crawl nobody judged is a 404** naming that fact. Metrics are written
   *    by `crawl_rules`; until it has run there is no answer, and serving
   *    `rows: []` would be "this site has nothing" where the truth is "nobody
   *    has looked" (hard rule 7, and §5 of the surface contract).
   *  - **A judged crawl whose metric wrote nothing, or wrote rows whose list is
   *    empty, is `rows: []` WITH A NOTE** saying which of the two it is. That is
   *    a measurement, and the note is what keeps it from reading as the refusals
   *    above.
   */
  async metricTable(crawlId: string, metricId: string): Promise<MetricTableOut> {
    // `judgementStale` rides the table for `listMetrics`' reason.
    const { judgementStale } = await this.judgementView(crawlId);
    const rule = this.rules.get(metricId);
    if (rule === undefined || rule.kind !== "metric") {
      throw new ServiceError(
        "NOT_FOUND",
        `'${clip(metricId)}' is not a metric in ruleset ${RULESET_VERSION}` +
          (rule === undefined
            ? ""
            : " — it is a rule that finds, and its table is /crawls/:id/issues/:ruleId/urls") +
          ": rules_catalog names the metrics this engine measures",
      );
    }

    const result = await this.db.execute<{
      scope: string;
      scope_value: string;
      value: unknown;
    }>(sql`
      select m.scope, m.scope_value, m.value_jsonb as value
      from metrics m
      where m.crawl_id = ${crawlId} and m.metric_id = ${metricId}
      order by m.scope asc, m.scope_value asc`);

    const stored: StoredMetricRow[] = result.rows.map((row) => ({
      scope: row.scope,
      scopeValue: row.scope_value,
      value: row.value,
    }));
    const shaped = shapeMetricTable(metricId, rule.table, stored);
    const copy = {
      metricId,
      title: rule.title,
      explanation: rule.explanation,
      howToFix: rule.howToFix,
    };

    if (shaped.rows.length > 0) return { ...copy, ...shaped, judgementStale };

    // Empty, so this answer has to say WHICH empty. The judged check is one
    // column and is only asked here, on the path where the difference matters.
    const judged = await this.db
      .select({ rulesRunAt: crawls.rulesRunAt })
      .from(crawls)
      .where(eq(crawls.id, crawlId))
      .limit(1);
    const rulesRunAt = judged[0]?.rulesRunAt ?? null;
    if (stored.length === 0 && rulesRunAt === null) {
      throw new ServiceError(
        "NOT_FOUND",
        `crawl ${crawlId} holds no rows for metric '${clip(metricId)}' and has never been ` +
          "judged (rulesRunAt is null): run the rules over it before reading its metrics — " +
          "an empty table here would read as 'this site measured nothing'",
      );
    }
    const note =
      stored.length === 0
        ? `crawl ${crawlId} was judged and metric '${metricId}' wrote no rows: the table is ` +
          "empty because there was nothing to measure, not because nobody looked"
        : `metric '${metricId}' wrote ${stored.length} row(s) for crawl ${crawlId} and the ` +
          "list they expand into rows is empty: nothing was found to list";
    return { ...copy, ...shaped, note, judgementStale };
  }

  /**
   * The crawl's pages, filtered and slim.
   *
   * Ordered by URL, which is a total order within a crawl (`pages_crawl_url` is
   * unique), so the cursor is one column and exact.
   */
  async listPages(crawlId: string, opts: PageQuery = {}): Promise<Page<PageRow>> {
    await this.assertCrawl(crawlId);
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor, 1);

    const where: (SQL | undefined)[] = [eq(pages.crawlId, crawlId)];
    if (opts.pageType !== undefined) {
      where.push(await this.pageTypeCondition(crawlId, opts.pageType, sql`${pages.pageType}`));
    }
    if (opts.statusCode !== undefined) {
      if (!Number.isInteger(opts.statusCode) || opts.statusCode < 100 || opts.statusCode > 599) {
        throw new ServiceError(
          "VALIDATION",
          `statusCode must be an HTTP status between 100 and 599, got ${clip(String(opts.statusCode))}`,
        );
      }
      where.push(eq(pages.statusCode, opts.statusCode));
    }
    // `is_indexable` is nullable, and the null means "no verdict" — a page the
    // crawl never got an answer for. `indexable=false` therefore matches rows
    // that ARE false, never rows that are unknown; a caller after the unknowns
    // reads them off the listing, where they come back as null.
    if (opts.indexable !== undefined) where.push(eq(pages.isIndexable, opts.indexable));
    if (opts.rendered !== undefined) where.push(eq(pages.rendered, opts.rendered));
    // Both of these are CLOSED vocabularies owned by the crawl layer, and both
    // are validated against the real one rather than passed through: a value
    // the crawler cannot write selects no rows, and an empty page would read as
    // "no page of this crawl was blocked" — which is the opposite of what a
    // caller who typo'd `blocked` needs to hear.
    if (opts.fetchClass !== undefined) {
      if (!(FETCH_CLASSES as readonly string[]).includes(opts.fetchClass)) {
        throw new ServiceError(
          "VALIDATION",
          `fetchClass '${clip(opts.fetchClass)}' is not a fetch class ` +
            `(one of: ${FETCH_CLASSES.join(", ")})`,
        );
      }
      where.push(eq(pages.fetchClass, opts.fetchClass));
    }
    if (opts.discoveredVia !== undefined) {
      if (!(DISCOVERED_VIA as readonly string[]).includes(opts.discoveredVia)) {
        throw new ServiceError(
          "VALIDATION",
          `discoveredVia '${clip(opts.discoveredVia)}' is not a discovery kind ` +
            `(one of: ${DISCOVERED_VIA.join(", ")})`,
        );
      }
      where.push(eq(pages.discoveredVia, opts.discoveredVia));
    }
    if (cursor !== null) where.push(gt(pages.url, cursor[0]));

    const rows = await this.db
      // The field allowlist IS this projection: named columns, never `select()`
      // and a spread. A column added to `pages` tomorrow does not appear on the
      // wire because nobody named it (Talos obligation 6).
      .select(PAGE_FIELDS)
      .from(pages)
      .where(and(...where))
      .orderBy(asc(pages.url))
      .limit(limit + 1);

    const items = rows.slice(0, limit);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: last === undefined ? null : encodeCursor(last.url) };
  }

  /**
   * Write one dataset of a crawl to a gzipped JSONL file, and answer with the
   * path.
   *
   * NEVER INLINE, and that is obligation 1 rather than a preference: the caller
   * on the other end of this surface is a chat agent with a context window, and
   * a 50k-row findings dump is the one response shape that cannot be made safe
   * by pagination because the caller asked for all of it. The file is for the
   * humans and the pipelines; the agent gets a path and a count.
   *
   * The rows are streamed — a keyset page in, a gzip write out, and let go —
   * so the memory cost is O(`EXPORT_BATCH`) rather than O(rows) (hard rule 6).
   * There is no array of findings in this method and there must never be one.
   *
   * ## The name is deterministic, and the write is atomic
   *
   * One file per (crawl, dataset): `<crawl>-<dataset>.jsonl.gz`, overwritten by
   * the next export of the same pair. A timestamped name never collides and
   * never stops accumulating either — an agent that loops over `/export` fills
   * a disk, and nothing in the surface would say so.
   *
   * A deterministic name makes two callers meeting on one path ROUTINE rather
   * than a same-millisecond accident, so the bytes go to a temp file and are
   * `rename`d into place, which is atomic within a directory: a reader either
   * sees the previous complete export or the new complete one, never the half
   * of one that a crashed writer left behind. The temp name carries the pid AND
   * a random suffix, because two concurrent requests in THIS process share a
   * pid and would otherwise write over each other's temp file.
   *
   * A write that fails takes its temp file with it and leaves any existing
   * export standing: a truncated `.jsonl.gz` is a file a pipeline would read as
   * a short crawl. The error surfaces either way.
   */
  async exportCrawl(
    crawlId: string,
    opts: { dataset?: string; format?: string; view?: string; ruleId?: string } = {},
  ): Promise<ExportResult | CsvExportResult> {
    await this.assertCrawl(crawlId);
    const request = parseExportRequest(opts, (field, id) => this.findingRule(field, id));

    if (request.format === "csv") {
      const stream = await this.csvStream(
        crawlId,
        request.view,
        request.ruleId,
        request.metricId,
      );
      const { written, bytes, path } = await this.writeExport(
        stream.filename,
        new PassThrough(),
        stream.records(),
      );
      return {
        format: "csv",
        view: stream.view,
        ...(stream.ruleId === null ? {} : { ruleId: stream.ruleId }),
        ...(stream.metricId === null ? {} : { metricId: stream.metricId }),
        path,
        // The header is written and is not a row. `written` counts records.
        rows: written - 1,
        bytes,
        ...(stream.disabledRules === null ? {} : { disabledRules: stream.disabledRules }),
      };
    }

    const { dataset } = request;
    // The findings dataset applies the crawl's judgement, read once before the
    // first byte: a disabled rule's findings are left out (in SQL), the copy is
    // rendered with the thresholds they were judged with, and the answer names
    // what was left out. The other two datasets are not findings.
    const view = dataset === "issues" ? await this.judgementView(crawlId) : null;
    const { written, bytes, path } = await this.writeExport(
      `${slug(crawlId)}-${dataset}.jsonl.gz`,
      createGzip(),
      this.jsonlRecords(crawlId, dataset, view),
    );
    return {
      dataset,
      path,
      rows: written,
      bytes,
      ...(view === null ? {} : { disabledRules: view.disabledRules }),
    };
  }

  /** The JSONL dataset as text records — one JSON object per line, as it always was. */
  private async *jsonlRecords(
    crawlId: string,
    dataset: ExportDataset,
    view: JudgementView | null,
  ): AsyncGenerator<string> {
    for await (const row of this.exportRows(crawlId, dataset, view)) {
      yield `${JSON.stringify(row)}\n`;
    }
  }

  /**
   * Write a stream of records into the export directory, atomically.
   *
   * The `sink` is what the records are written through — `createGzip()` for the
   * JSONL datasets, a `PassThrough` for CSV, which is the whole difference
   * between the two formats at this level. Everything else (the name check, the
   * temp file, the backpressure, the rename) is one implementation because the
   * failure it defends against is one failure.
   */
  private async writeExport(
    filename: string,
    sink: Duplex,
    records: AsyncIterable<string>,
  ): Promise<{ written: number; bytes: number; path: string }> {
    await mkdir(this.exportDir, { recursive: true });
    // The crawl id reaches this from the request path, so it is slugged before
    // it becomes a filename and the result is checked to be inside the export
    // directory. A caller names a crawl, never a path.
    const file = joinPath(this.exportDir, filename);
    if (!resolvePath(file).startsWith(this.exportDir + pathSep)) {
      throw new Error(`export: refusing to write outside the export directory (${file})`);
    }
    const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;

    // THE HANDLER IS ATTACHED AT CREATION, and that placement is the whole
    // point. The write side fails on its own schedule — ENOSPC, a directory
    // removed underneath us, EACCES on open — and control spends most of this
    // method parked in the row generator's database awaits. A `pipeline()`
    // promise whose rejection has no handler AT THE MOMENT IT REJECTS is an
    // unhandled rejection, and an unhandled rejection ends the process in Node
    // 22: a full disk would take the API server down with it. Catching here
    // turns that into a value, which the loop below checks and re-throws as its
    // own error (the same reasoning as the queue runner's catch in `pump`).
    let writeError: unknown = null;
    const written = pipeline(sink, createWriteStream(temp)).catch((error: unknown) => {
      writeError = error;
    });

    let count = 0;
    try {
      for await (const record of records) {
        if (writeError !== null) throw writeError;
        // Backpressure honoured: the sink's buffer says when to wait, so a slow
        // disk slows the reader rather than filling memory with pending writes.
        if (!sink.write(record)) await once(sink, "drain");
        count += 1;
      }
      sink.end();
      await written;
      if (writeError !== null) throw writeError;
      // The rename is the publish step: everything above wrote a temp file
      // nobody was reading.
      await rename(temp, file);
    } catch (error) {
      sink.destroy();
      await written;
      await unlink(temp).catch(() => undefined);
      throw error;
    }

    const { size } = await stat(file);
    return { written: count, bytes: size, path: file };
  }

  /**
   * A CSV view of a crawl, validated and ready to stream — the HTTP transport's
   * half of `export_crawl`.
   *
   * NOT A FILE. The dashboard's "Bulk export" block is a download: Talos proxies
   * these bytes straight to a browser, so the response body IS the file and
   * nothing is written to this server's disk. The MCP transport, whose caller
   * has no browser, gets the file-writing half (`exportCrawl` with
   * `format: "csv"`) — same rows, same writer, one place they are decided.
   *
   * Everything that can be refused is refused HERE, before a byte is streamed:
   * once the 200 and the `text/csv` header are on the wire there is no status
   * code left to change, and a half-written file that a client reads as a
   * complete export is exactly the silent failure hard rule 7 forbids. That
   * includes the refusal that is NOT about the request — a crawl holding
   * findings for a rule this ruleset has retired (see `assertViewAnswerable`).
   */
  async prepareCsvExport(
    crawlId: string,
    opts: {
      dataset?: string;
      format?: string;
      view?: string;
      ruleId?: string;
      metricId?: string;
    } = {},
  ): Promise<CsvStream> {
    await this.assertCrawl(crawlId);
    const request = parseExportRequest(
      { ...opts, format: opts.format ?? "csv" },
      (field, id) => this.findingRule(field, id),
    );
    if (request.format !== "csv") {
      throw new ServiceError(
        "VALIDATION",
        `this route streams CSV; format '${request.format}' writes a file — ask for it ` +
          "without format=csv and read the path it answers with",
      );
    }
    return this.csvStream(crawlId, request.view, request.ruleId, request.metricId);
  }

  /**
   * The one refusal a CSV view can hit that the REQUEST does not contain: a
   * stored finding whose rule this ruleset no longer defines.
   *
   * `issues` joins every row's copy out of the registry at read time, exactly as
   * `issues_list` does, and `ruleFor` refuses a row it cannot join rather than
   * writing blank titles into a client's spreadsheet. Left to fire inside the
   * generator, that refusal arrives AFTER the header — a 200 and a torn socket,
   * where every JSON surface answers the same crawl a clean 409 telling the
   * caller to re-run the rules. So the rule ids are asked for first: one
   * `select distinct rule_id`, which rides the `issues_crawl_rule` index and
   * costs milliseconds against the 17,659-finding reference crawl, and the same
   * `ruleFor` that would have thrown later throws now, before a byte.
   *
   * `issue_urls` needs none of this — `parseExportRequest` has already put its
   * one rule through `findingRule`. The other six views never touch the
   * registry at all.
   */
  private async assertViewAnswerable(
    crawlId: string,
    view: CsvViewName,
    disabledRules: readonly string[],
  ): Promise<void> {
    if (view !== "issues") return;
    // The disabled rules' rows are not in the file, so they are not asked about.
    const result = await this.db.execute<{ rule_id: string }>(
      sql`select distinct i.rule_id from issues i
           where i.crawl_id = ${crawlId} and ${notDisabled(disabledRules)}`,
    );
    for (const row of result.rows) this.ruleFor(row.rule_id, crawlId, "issues");
  }

  /**
   * The prepared stream itself. The validation is the caller's; this reads rows.
   *
   * TWO KINDS OF VIEW MEET HERE. Eight are a keyset read of a table and stream
   * in batches of `EXPORT_BATCH` (`CSV_QUERY_VIEWS`); `metric_table` is one
   * metric's rows shaped by its own declaration, which is not a query at all —
   * see `metricTableStream`, which is where its refusals happen and where the
   * bound on its size is argued.
   */
  private async csvStream(
    crawlId: string,
    view: CsvViewName,
    ruleId: string | null,
    metricId: string | null,
  ): Promise<CsvStream> {
    if (view === "metric_table") {
      if (metricId === null) {
        // Unreachable through `parseExportRequest`, which requires the id — and
        // stated rather than defaulted, because an export named for a metric
        // nobody asked for is worse than a refusal.
        throw new Error("csvStream: the metric_table view was prepared without a metricId");
      }
      return await this.metricTableStream(crawlId, metricId);
    }
    if (view === "issues_overview") return await this.issuesOverviewStream(crawlId);
    if (view === "crawl_overview") return await this.crawlOverviewStream(crawlId);
    // The two findings views apply the crawl's judgement, read once before the
    // header (a refusal after it is a torn socket): a disabled rule's findings
    // are left out in SQL, `issue_urls` of a disabled rule is refused outright
    // as `issue_urls` the listing is, and the copy is rendered with the
    // thresholds the findings were judged with. No other view reads findings.
    const judged =
      view === "issues" || view === "issue_urls" ? await this.judgementView(crawlId) : null;
    if (judged !== null && ruleId !== null) refuseIfDisabled(judged, crawlId, ruleId);
    const disabledRules = judged === null ? [] : judged.disabledRules;
    const copy = judged === null ? null : copyRenderer(judged.copyThresholds);
    await this.assertViewAnswerable(crawlId, view, disabledRules);
    const def = CSV_VIEW_DEFS[view];
    const ctx: CsvViewContext = {
      // `columnsFor` rather than the rule's own `columns`: the four standard
      // columns are the surface's, and a spreadsheet that omitted them would be
      // a different table from the one the JSON listing serves.
      rule: (id) => {
        const rule = this.ruleFor(id, crawlId, "issues");
        if (judged === null || copy === null) {
          throw new Error(
            `csvStream: view '${view}' asked for rule copy, which only the findings views read`,
          );
        }
        const triage = triageFields(judged, id);
        return {
          title: copy(id).title,
          category: rule.category,
          checkIds: rule.checkIds,
          type: triage.type,
          priority: triage.priority,
          columns: columnsFor(rule),
        };
      },
      evidence: (value, id) => asEvidence(value, crawlId, id),
    };
    const db = this.db;
    return {
      view,
      ruleId,
      metricId: null,
      filename: csvFilename(slug(crawlId), view, ruleId === null ? null : slug(ruleId)),
      disabledRules: judged === null ? null : judged.disabledRules,
      async *records(): AsyncGenerator<string> {
        // THE HEADER IS UNCONDITIONAL. A zero-row CSV with no header is a file
        // that cannot say what it failed to contain, and a reader would have to
        // guess whether the export ran at all.
        yield csvRecord(def.header(ruleId, ctx));
        let cursor: readonly string[] = def.start;
        for (;;) {
          const result = await db.execute<Record<string, unknown>>(
            def.query(crawlId, cursor, EXPORT_BATCH, ruleId, disabledRules),
          );
          if (result.rows.length === 0) return;
          // Read a batch, write it, let it go: RAM is O(EXPORT_BATCH) and never
          // O(rows), which is hard rule 3 for the links-derived views and hard
          // rule 6 for the rest. Nothing here accumulates.
          for (const row of result.rows) yield csvRecord(def.cells(row, ctx));
          const last = result.rows[result.rows.length - 1];
          if (last === undefined) return;
          cursor = def.next(last);
        }
      },
    };
  }

  /**
   * `issues_overview` as a stream: header, then the overview's rows. Built whole
   * before the first byte, for `metricTableStream`'s reason: its refusals (an
   * unjudged crawl, a stored finding of an unknown rule) must be a clean 409,
   * not a torn socket. At most one row per rule, so the table is bounded by the
   * ruleset and not by the site.
   */
  private async issuesOverviewStream(crawlId: string): Promise<CsvStream> {
    const { overview, view } = await this.issuesOverviewRead(crawlId, false);
    const copy = copyRenderer(view.copyThresholds);
    return {
      view: "issues_overview",
      ruleId: null,
      metricId: null,
      filename: csvFilename(slug(crawlId), "issues_overview", null),
      disabledRules: overview.disabledRules,
      async *records(): AsyncGenerator<string> {
        yield csvRecord(ISSUES_OVERVIEW_HEADER);
        for (const row of overview.rows) {
          yield csvRecord(issuesOverviewCells(row, copy(row.ruleId)));
        }
      },
    };
  }

  /**
   * `crawl_overview` as a stream: header, one row per entry, then one row per
   * not-measured section or entry. Built whole before the first byte, for
   * `issuesOverviewStream`'s reason (its refusals must be a clean status, not a
   * torn socket); bounded by the sections, not by the site.
   */
  private async crawlOverviewStream(crawlId: string): Promise<CsvStream> {
    const { overview, view } = await this.crawlOverviewRead(crawlId);
    return {
      view: "crawl_overview",
      ruleId: null,
      metricId: null,
      filename: csvFilename(slug(crawlId), "crawl_overview", null),
      // Its issues grid leaves the disabled rules' findings out.
      disabledRules: view.disabledRules,
      async *records(): AsyncGenerator<string> {
        yield csvRecord(CRAWL_OVERVIEW_HEADER);
        for (const cells of crawlOverviewRecords(overview)) yield csvRecord(cells);
      },
    };
  }

  /**
   * `metric_table` as a stream: the shaped table, header then rows.
   *
   * THE WHOLE TABLE IS BUILT BEFORE THE FIRST BYTE, and that is deliberate
   * rather than a shortcut. `metricTable` is where this view's refusals live —
   * an unknown metric, a crawl nobody judged — and a refusal that fires inside
   * the generator arrives after the 200 and the header, which is a torn socket
   * where the JSON surface answers a clean 404 (`prepareCsvExport`'s rule, one
   * view along). The table is also what the view IS: its rows are a
   * transformation of the metric's stored rows, not a window onto them, so
   * there is nothing to page.
   *
   * The size is bounded by the metric, not by the site: one stored row per
   * cohort, expanded by the shaper within the metric's own caps
   * (`CSV_QUERY_VIEWS` states the argument). The largest today is
   * `inlinks.sources-by-type` at cohorts × `SOURCE_TYPE_CAP`.
   *
   * A NOTE ON AN EMPTY TABLE IS NOT WRITTEN INTO THE FILE. The header is, so the
   * file says what it failed to contain, and the sentence explaining WHY it is
   * empty is on the JSON route and the MCP tool where a reader can act on it —
   * a comment line in a CSV is a row to every parser that opens it.
   */
  private async metricTableStream(crawlId: string, metricId: string): Promise<CsvStream> {
    const table = await this.metricTable(crawlId, metricId);
    return {
      view: "metric_table",
      ruleId: null,
      metricId,
      filename: csvFilename(slug(crawlId), "metric_table", slug(metricId)),
      disabledRules: null,
      async *records(): AsyncGenerator<string> {
        yield csvRecord(metricTableHeader(table));
        for (const row of table.rows) yield csvRecord(metricTableCells(table, row));
      },
    };
  }

  /**
   * Stop the queue: abort the crawl in flight and wait for it to close its row.
   *
   * The abort is the crawl loop's own graceful path — the run ends `cancelled`
   * with its frontier intact, resumable. Crawls still waiting are left as
   * `queued` rows and logged: this process will not run them and says so, which
   * is the restart contract in the module header.
   */
  async close(): Promise<void> {
    this.closed = true;
    const abandoned = this.waiting.splice(0, this.waiting.length);
    const current = this.running;
    if (current !== null) {
      current.controller.abort();
      await current.done;
    }
    if (abandoned.length > 0) {
      this.log(
        `api: ${abandoned.length} crawl(s) left queued and unstarted ` +
          `(${abandoned.map((e) => e.crawlId).join(", ")}); their rows stay 'queued' and ` +
          `no process is holding them`,
      );
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * Start the next crawl if nothing is running.
   *
   * `this.running` is assigned in the same synchronous step that removes the
   * entry from `waiting`, before the run's first `await` can yield, so two
   * `startCrawl` calls in the same tick cannot both find the runner idle.
   */
  private pump(): void {
    if (this.closed || this.running !== null) return;
    const next = this.waiting.shift();
    if (next === undefined) return;

    const controller = new AbortController();
    const entry: RunningCrawl = {
      crawlId: next.crawlId,
      controller,
      done: Promise.resolve(),
    };
    this.running = entry;
    // NOTHING AWAITS THIS PROMISE UNTIL `close()`, so it must not be able to
    // reject. `runQueued` already catches the crawl's own errors — but its
    // catch block writes to the database, and a database that is gone makes
    // BOTH the run and its own record-keeping throw. That rejection would then
    // sit unhandled on a promise nobody is holding, and an unhandled rejection
    // ends the process in Node 22: one bad crawl would take the whole API
    // server down with it.
    //
    // The catch is before the `finally` deliberately, so `entry.done` is a
    // settled, non-rejecting promise by the time `close()` awaits it.
    entry.done = this.runQueued(next, controller.signal)
      .catch((error: unknown) => {
        this.log(
          `api: crawl ${entry.crawlId} — the queue runner itself failed and could not ` +
            `record it: ${messageOf(error)}`,
        );
      })
      .finally(() => {
        if (this.running === entry) this.running = null;
        this.pump();
      });
  }

  /**
   * Run one queued crawl.
   *
   * `resumeCrawl` rather than `runCrawl` because the row already exists — it
   * was created when the crawl was accepted. A queued crawl's frontier is
   * empty, so a resume of it does exactly what a fresh run does: discover,
   * seed, loop. The config passed in is the effective one, `allowPrivate`
   * included; the row's stored copy never had it (`storableConfig`), and
   * `ResumeOpts.config` is the documented place to re-assert it.
   *
   * That identity is why `crawl_resume` needed no new runner: an entry put here
   * by `ApiService.resumeCrawl` differs only in that its frontier is NOT empty,
   * and the loop has continued non-empty frontiers since Phase 1. `entry.resuming`
   * changes the log line and nothing else.
   *
   * `reclaimLeases` is not passed, on either path. See `ApiService.resumeCrawl`:
   * it would hand every live lease in the crawl back to pending, which is right
   * after a crash and wrong while another process is working, and this server
   * cannot tell those apart from outside.
   */
  private async runQueued(entry: QueueEntry, signal: AbortSignal): Promise<void> {
    this.log(
      `api: crawl ${entry.crawlId} ${entry.resuming ? "resuming" : "starting"} ` +
        `(${entry.config.siteUrl})`,
    );
    try {
      const summary = await resumeCrawl(this.db, entry.crawlId, {
        config: entry.config,
        signal,
      });
      // The template inference beside the page count, because the pair is the
      // whole of "what shape is this site" and the alternative is a second
      // census over `pages` to find out. `pageTemplates` is null only when the
      // pass did not run (a crawl that failed before it had a population), and
      // that is said in those words rather than printed as a zero.
      const templates =
        summary.pageTemplates === null
          ? "page types not inferred"
          : `${summary.pageTemplates.typesBefore} URL shape(s) -> ` +
            `${summary.pageTemplates.typesAfter} page type(s), ` +
            `${summary.pageTemplates.pagesRetyped} retyped`;
      this.log(
        `api: crawl ${entry.crawlId} ${summary.status} — ` +
          `${summary.pagesCrawled} page(s), ${templates}`,
      );
    } catch (error) {
      // The crawl's own failure path has already closed the row as `failed`
      // (see `execute` in the crawl loop) for anything thrown inside the run.
      // A throw BEFORE that — a row deleted underneath us, a config the loop
      // will not take — would leave the row `queued`, which is a lie: nobody
      // will ever run it. Closing it is transparency, not recovery; the error
      // is logged either way and never swallowed into a clean-looking row.
      // AND THE ROW SAYS WHY, not only this process's log (migration 0017).
      // The `where` is what keeps the two writers from arguing: a row the loop
      // already closed `failed` — with the loop's own, more specific reason —
      // is no longer `queued`, so this update passes over it and leaves that
      // sentence alone. Only the throws that never reached the loop land here.
      this.log(`api: crawl ${entry.crawlId} threw — ${messageOf(error)}`);
      await this.db
        .update(crawls)
        .set({
          status: "failed",
          finishedAt: new Date(),
          // The crawl loop's own helper, imported rather than re-implemented:
          // one rule for what may go in this column, on both sides of the seam.
          // It composes a sentence for an error with no message rather than
          // throwing, because a throw here would abandon this close and leave
          // the row `queued` for ever — the lie this catch exists to prevent.
          failureReason: failureReasonOf(error),
        })
        .where(and(eq(crawls.id, entry.crawlId), eq(crawls.status, "queued")));
    }
  }

  /** 0 = running now or next; null = this process is not holding this crawl. */
  private queuePosition(crawlId: string): number | null {
    if (this.running?.crawlId === crawlId) return 0;
    const index = this.waiting.findIndex((e) => e.crawlId === crawlId);
    if (index < 0) return null;
    return this.running === null ? index : index + 1;
  }

  /**
   * The allowlist, applied to the hosts `legacyHosts` adds to the crawl.
   *
   * WHY THIS EXISTS AT ALL. `legacyHosts` is not decoration: `probeHostVariants`
   * fetches the origin root of every one of them, up to five hops each, and
   * those fetches are — by host-probe.ts's own account — the ONLY fetches in
   * the crawler not covered by robots.txt, because which host's robots.txt
   * governs the site is exactly what the probe is trying to find out. Gating
   * only `siteUrl` therefore left `{siteUrl: <allowed>, legacyHosts:
   * ["victim.example"]}` as a way to point a branded crawler at any host on the
   * internet with an operator's allowlist in force and no rules read first.
   *
   * WHAT IS GATED, precisely: the hosts the probe would fetch that are NOT the
   * site's own spellings. `hostProbeStarts(siteUrl)` is the family the crawler
   * already treats as this one site — apex/www × http/https, the same variants
   * `isSameOrigin` admits into the crawl — and an allowlist entry authorises
   * that family (see `isHostAllowed`). Everything `legacyHosts` ADDS is a
   * different site by every definition the engine has, so each one must be
   * allowlisted in its own right, and each one gets the URL policy applied to
   * it as well.
   *
   * The subtraction is done with `hostProbeStarts` itself rather than by
   * re-deriving the spellings here, for the reason its own docblock gives: it
   * is the probe's contract, and the host rules already subtract with it.
   *
   * RUN EVEN WHEN `probeHosts` IS FALSE. Nothing is fetched in that case, but
   * the entries are still written to the crawl row, and a resume that turns
   * probing on would fetch hosts this server never authorised. The row must not
   * carry a host the allowlist would have refused.
   *
   * A malformed entry is a 400 here — `hostProbeStarts` throws on one — rather
   * than an error the crawl discovers after it has been accepted, queued and
   * started.
   */
  private async checkLegacyHosts(
    siteUrl: string,
    legacyHosts: readonly string[] | undefined,
    allowPrivate: boolean,
  ): Promise<void> {
    if (legacyHosts === undefined || legacyHosts.length === 0) return;

    let ownSpellings: string[];
    let everyStart: string[];
    try {
      ownSpellings = hostProbeStarts(siteUrl);
      everyStart = hostProbeStarts(siteUrl, legacyHosts);
    } catch (error) {
      throw new ServiceError("VALIDATION", messageOf(error));
    }

    await this.checkAddedHosts(everyStart, ownSpellings, allowPrivate, {
      allowlist: (host) =>
        `legacyHosts names '${host}', which is not in this server's crawl allowlist: ` +
        `the host probe fetches every legacy host, and those fetches are the only ` +
        `ones the crawler makes before it has read anybody's robots.txt`,
      policy: (host, reason) => `legacyHosts entry '${host}' refused by the URL policy: ${reason}`,
    });
  }

  /**
   * The sitemap documents a client handed the crawl, checked on exactly the
   * terms `legacyHosts` is.
   *
   * WHY THE FIELD EXISTS. The crawler never probes `/sitemap.xml` on spec (the
   * P1 ruling in src/crawl/discovery.ts): a document nobody pointed at is not
   * something this engine invents a request for, and reporting whatever comes
   * back as the site's published sitemap would be a fact we made up. That
   * leaves a real site — one whose sitemap exists and whose robots.txt never
   * says so — uncrawlable through its sitemap, and this is the other half of
   * the ruling: somebody who KNOWS where the document is says so, once, at
   * crawl start. The undeclared sitemap is still reported (`sitemap.missing`,
   * CHECK-06), because it is still worth fixing.
   *
   * WHAT IS GATED. Each entry must be an absolute http(s) URL — a 400 naming
   * the entry, here, rather than a walk failure the operator would read as the
   * site's — and each must be a URL this server may point a fetch at: the
   * site's own family (apex/www × http/https) is authorised by the crawl
   * itself, and anything else must be on the allowlist in its own right. A
   * sitemap on a CDN or a subdomain is ordinary and is exactly what the second
   * clause is for; `{siteUrl: <allowed>, sitemapUrls: ["https://victim/x.xml"]}`
   * is what it refuses.
   *
   * The order matters: unreadable URLs are named first (a 400 the caller can
   * fix from the message), then the allowlist, then the URL policy — the same
   * order and the same authority as `startCrawl`'s own checks.
   */
  private async checkSitemapUrls(
    siteUrl: string,
    sitemapUrls: readonly string[] | undefined,
    allowPrivate: boolean,
  ): Promise<void> {
    if (sitemapUrls === undefined || sitemapUrls.length === 0) return;

    if (sitemapUrls.length > MAX_SUPPLIED_SITEMAPS) {
      throw new ServiceError(
        "VALIDATION",
        `sitemapUrls names ${sitemapUrls.length} documents, above this server's limit of ` +
          `${MAX_SUPPLIED_SITEMAPS}. A site with more sitemap documents than that has a ` +
          `sitemap INDEX — supply the index and the walk follows it, three levels deep`,
      );
    }

    const targets: string[] = [];
    for (const entry of sitemapUrls) {
      // `normalizeUrl` is parse and canonicalisation in one, and it rejects
      // every scheme the crawler does not speak. The entry is quoted back as
      // the caller wrote it; the crawl fetches that spelling too (discovery
      // normalises only to compare documents, never to rewrite one).
      if (normalizeUrl(entry) === null) {
        throw new ServiceError(
          "VALIDATION",
          `sitemapUrls entry '${clip(entry)}' is not an absolute http(s) URL. A sitemap ` +
            `document is named in full ('https://site.example/sitemap.xml'); the walk ` +
            `resolves nothing relative`,
        );
      }
      targets.push(entry);
    }

    let ownSpellings: string[];
    try {
      ownSpellings = hostProbeStarts(siteUrl);
    } catch (error) {
      throw new ServiceError("VALIDATION", messageOf(error));
    }

    await this.checkAddedHosts(targets, ownSpellings, allowPrivate, {
      allowlist: (host) =>
        `sitemapUrls names a document on '${host}', which is neither a spelling of this ` +
        `crawl's own site nor in this server's crawl allowlist: the walk fetches every ` +
        `document it is handed, so each host must be permitted in its own right`,
      policy: (host, reason) =>
        `sitemapUrls entry on '${host}' refused by the URL policy: ${reason}`,
    });
  }

  /**
   * The allowlist and the URL policy, applied to the hosts a request ADDS to a
   * crawl beyond the seed's own family.
   *
   * One implementation for the two fields that add them (`legacyHosts` and
   * `sitemapUrls`) rather than a copy each: the posture is a single decision —
   * the site's own spellings are authorised by the crawl, everything else is a
   * different site and is allowlisted or refused — and two copies of it would
   * be two chances to fix a hole once. Callers supply the sentences, because a
   * refusal that does not say which field it is about is a refusal nobody can
   * act on.
   *
   * `own` is the site's own start URLs (`hostProbeStarts(siteUrl)`), compared
   * by hostname; `targets` are absolute URLs. One check per distinct added
   * host — the policy's verdict is about the host and the scheme, not the path.
   */
  private async checkAddedHosts(
    targets: readonly string[],
    own: readonly string[],
    allowPrivate: boolean,
    refusal: {
      allowlist: (host: string) => string;
      policy: (host: string, reason: string) => string;
    },
  ): Promise<void> {
    const ownHosts = new Set(own.map((start) => new URL(start).hostname));
    const checked = new Set<string>();
    for (const target of targets) {
      const host = new URL(target).hostname;
      if (ownHosts.has(host)) continue;
      if (checked.has(host)) continue;
      checked.add(host);

      if (!this.crawlHostAllowed(host)) {
        throw new ServiceError("FORBIDDEN", refusal.allowlist(host));
      }
      const verdict = await isUrlAllowed(target, { allowPrivate });
      if (!verdict.allowed) {
        throw new ServiceError(
          "FORBIDDEN",
          refusal.policy(host, verdict.reason ?? "no reason given"),
        );
      }
    }
  }

  /**
   * The pages a caller named for the render pass, checked and resolved to this
   * crawl's own spellings — or a refusal saying which entry stopped it.
   *
   * ## THE ORDER, and why it is this one
   *
   * Every step is a refusal, so the order decides which sentence a caller with
   * two problems is told about first. It runs cheapest-and-most-fundamental to
   * costliest:
   *
   *  1. **Non-empty.** An empty list is not "render nothing" — a pass meant to
   *     be off is a pass that is not run, the same reading `renderBudgetPct: 0`
   *     already gets.
   *  2. **Readable as a URL** (`normalizeUrl`), which also rejects every scheme
   *     the crawler does not speak. This is the spelling `pages.url` is stored
   *     in, so it is normalisation and parse in one step.
   *  3. **Deduplicated**, on that normalised spelling, first occurrence winning.
   *     Before the cap, so a list that repeats a URL is not refused for a
   *     ceiling it does not actually reach.
   *  4. **The cap.** More than `renderMaxPages` distinct pages is a 400 naming
   *     the cap, NOT a silent slice. The automatic budget cuts and says
   *     `truncated: true`, because it built the candidate list itself; a list a
   *     caller wrote is a deliberate statement about which pages matter, and
   *     rendering the first N of it while answering 200 would be this engine
   *     deciding which of somebody's templates to drop.
   *  5. **The URL policy** — hard rule 5, on every URL this engine is about to
   *     fetch, whoever supplied it. A render IS a fetch.
   *  6. **The allowlist posture**, exactly as `checkLegacyHosts` applies it: a
   *     host in the site's own family (apex/www × http/https) is authorised by
   *     the crawl itself; anything else must be in this server's allowlist in
   *     its own right. Reachable through `legacyHosts`, whose pages are in this
   *     crawl and are a different site by every definition the engine has.
   *  7. **It is a page of THIS crawl that fetched OK with a 200.** Last,
   *     because it is the only step that needs the database — and it is what
   *     makes this list a re-visit rather than a way to point the renderer at a
   *     URL nobody crawled. A URL that misses is a 400 naming it; it is never
   *     fetched.
   *
   * Steps 5 and 6 are belt-and-braces on a page the crawler already fetched
   * under both rules, and they are here anyway: the request is a fetch
   * instruction from a client, and hard rule 5 admits no "it was checked
   * earlier" exemption.
   */
  private async checkRenderUrls(
    crawlId: string,
    urls: readonly string[],
    config: CrawlConfig,
  ): Promise<string[]> {
    if (urls.length === 0) {
      throw new ServiceError(
        "VALIDATION",
        "urls was given as an empty list: a render pass with no pages is a pass not " +
          "run. Omit urls to let the engine select, or name at least one page",
      );
    }

    const normalised: string[] = [];
    const seen = new Set<string>();
    for (const entry of urls) {
      const url = normalizeUrl(entry);
      if (url === null) {
        throw new ServiceError(
          "VALIDATION",
          `urls entry '${clip(entry)}' is not an http(s) URL this engine can render`,
        );
      }
      if (seen.has(url)) continue;
      seen.add(url);
      normalised.push(url);
    }

    const { renderMaxPages } = resolveRenderConfig(config);
    if (normalised.length > renderMaxPages) {
      throw new ServiceError(
        "VALIDATION",
        `urls names ${normalised.length} distinct pages, above this crawl's ` +
          `renderMaxPages of ${renderMaxPages}. The list is not silently trimmed — ` +
          `a named list is a statement about which pages matter, so shorten it to ` +
          `${renderMaxPages} or fewer. A crawl's renderMaxPages is fixed at ` +
          `crawl_start and cannot be changed afterwards: a bigger budget means a ` +
          `new crawl started with a higher renderMaxPages`,
      );
    }

    const allowPrivate = this.config.crawlDefaults?.allowPrivate === true;
    // The site's own spellings, from the crawl's stored `siteUrl`. It reaches
    // `hostProbeStarts` unvalidated as a URL — `parseStoredConfig` checks it is
    // a string — so a row nothing this engine wrote could produce a throw here.
    // That is the crawl's config being unreadable, not the caller's list being
    // wrong, and it gets the 409 `parseStoredConfig`'s own failure gets.
    let own: Set<string>;
    try {
      own = new Set(hostProbeStarts(config.siteUrl).map((start) => new URL(start).hostname));
    } catch (error) {
      throw new ServiceError("CONFLICT", messageOf(error));
    }
    for (const url of normalised) {
      const verdict = await isUrlAllowed(url, { allowPrivate });
      if (!verdict.allowed) {
        throw new ServiceError(
          "FORBIDDEN",
          `urls entry '${clip(url)}' refused by the URL policy: ` +
            `${verdict.reason ?? "no reason given"}`,
        );
      }
      const host = new URL(url).hostname;
      if (!own.has(host) && !this.crawlHostAllowed(host)) {
        throw new ServiceError(
          "FORBIDDEN",
          `urls entry '${clip(url)}' is on '${host}', which is neither a spelling of ` +
            `this crawl's own site nor in this server's crawl allowlist`,
        );
      }
    }

    // One statement for the whole list. `= any(...)` rather than a round trip
    // per URL, and the answer is the SET that resolved — the missing ones are
    // computed here so the refusal can name them rather than say "one of these".
    const found = await this.db
      .select({ url: pages.url })
      .from(pages)
      .where(
        and(
          eq(pages.crawlId, crawlId),
          eq(pages.fetchClass, "ok"),
          eq(pages.statusCode, 200),
          sql`${pages.url} = any(${sql.param(normalised)}::text[])`,
        ),
      );
    const renderable = new Set(found.map((r) => r.url));
    const missing = normalised.filter((url) => !renderable.has(url));
    if (missing.length > 0) {
      throw new ServiceError(
        "VALIDATION",
        `urls names ${missing.length} page(s) this crawl cannot render — ` +
          `${missing.slice(0, MISSING_URLS_NAMED).map((u) => `'${clip(u)}'`).join(", ")}` +
          `${missing.length > MISSING_URLS_NAMED ? ", …" : ""}. The render pass re-visits ` +
          `pages this crawl already fetched, so a URL must be one of them and must have ` +
          `answered 200; it is never fetched for the first time here. Check the spelling ` +
          `with pages_query, or re-crawl if the page is genuinely missing`,
      );
    }

    return normalised;
  }

  /**
   * A judgement block from a request (`crawl_start`, `crawl_config_set`),
   * parsed against this server's ruleset. Every refusal — an unknown rule id
   * included, which on a REQUEST is the caller's mistake rather than a stored
   * row's drift — is a 400 carrying `parseJudgement`'s "<path>: <reason>".
   */
  private parseJudgementInput(raw: unknown): JudgementBlock {
    try {
      return parseJudgement(raw, this.registry);
    } catch (error) {
      if (error instanceof JudgementError) throw new ServiceError("VALIDATION", error.message);
      throw error;
    }
  }

  private effectiveConfig(siteUrl: string, input: Omit<StartCrawlInput, "judgement">): CrawlConfig {
    // Precedence, low to high: the engine's defaults, the API's own maxPages,
    // the process-trust overrides, then the request. `stripUndefined` on the
    // request half because an absent optional field must not overwrite a
    // default with `undefined`.
    return {
      ...CRAWL_DEFAULTS,
      ...API_CRAWL_DEFAULTS,
      ...stripUndefined(this.config.crawlDefaults ?? {}),
      ...stripUndefined({ ...input, siteUrl }),
    } as CrawlConfig;
  }

  /**
   * The rows one export dataset is made of, streamed by keyset cursor.
   *
   * A generator rather than a list, and the reason is the memory contract: the
   * caller writes each row into a gzip stream and drops it, so at no point does
   * a crawl's worth of findings exist in this process. Every dataset starts its
   * cursor at the empty string(s), which sort before every real key, so there
   * is no "first page" branch to get wrong.
   */
  private async *exportRows(
    crawlId: string,
    dataset: ExportDataset,
    view: JudgementView | null,
  ): AsyncGenerator<Record<string, unknown>> {
    if (dataset === "issues") {
      if (view === null) {
        throw new Error(
          `exportRows: the issues dataset of crawl ${crawlId} was asked for without its judgement`,
        );
      }
      const copy = copyRenderer(view.copyThresholds);
      let ruleId = "";
      let dedupeKey = "";
      for (;;) {
        const result = await this.db.execute<{
          rule_id: string;
          severity: string;
          url: string | null;
          evidence: unknown;
          dedupe_key: string;
        }>(sql`
          select i.rule_id, i.severity,
                 i.details_jsonb->>'pageUrl' as url,
                 i.details_jsonb as evidence,
                 i.dedupe_key
          from issues i
          where i.crawl_id = ${crawlId}
            and ${notDisabled(view.disabledRules)}
            and (i.rule_id, i.dedupe_key) > (${ruleId}::text, ${dedupeKey}::text)
          order by i.rule_id asc, i.dedupe_key asc
          limit ${EXPORT_BATCH}`);
        if (result.rows.length === 0) return;
        for (const row of result.rows) {
          const rule = this.ruleFor(row.rule_id, crawlId, "issues");
          yield {
            ruleId: row.rule_id,
            checkIds: [...rule.checkIds],
            severity: row.severity,
            category: rule.category,
            title: copy(row.rule_id).title,
            url: row.url,
            evidence: asEvidence(row.evidence, crawlId, row.rule_id),
          };
        }
        const last = result.rows[result.rows.length - 1];
        if (last === undefined) return;
        ruleId = last.rule_id;
        dedupeKey = last.dedupe_key;
      }
    }

    if (dataset === "pages") {
      let url = "";
      for (;;) {
        const rows = await this.db
          .select(PAGE_FIELDS)
          .from(pages)
          .where(and(eq(pages.crawlId, crawlId), gt(pages.url, url)))
          .orderBy(asc(pages.url))
          .limit(EXPORT_BATCH);
        if (rows.length === 0) return;
        for (const row of rows) yield { ...row };
        const last = rows[rows.length - 1];
        if (last === undefined) return;
        url = last.url;
      }
    }

    let metricId = "";
    let scope = "";
    let scopeValue = "";
    for (;;) {
      const result = await this.db.execute<{
        metric_id: string;
        scope: string;
        scope_value: string;
        value: unknown;
      }>(sql`
        select m.metric_id, m.scope, m.scope_value, m.value_jsonb as value
        from metrics m
        where m.crawl_id = ${crawlId}
          and (m.metric_id, m.scope, m.scope_value) >
              (${metricId}::text, ${scope}::text, ${scopeValue}::text)
        order by m.metric_id asc, m.scope asc, m.scope_value asc
        limit ${EXPORT_BATCH}`);
      if (result.rows.length === 0) return;
      for (const row of result.rows) {
        const rule = this.ruleFor(row.metric_id, crawlId, "metrics");
        yield {
          metricId: row.metric_id,
          scope: row.scope,
          scopeValue: row.scope_value,
          value: row.value,
          title: rule.title,
          explanation: rule.explanation,
          checkIds: [...rule.checkIds],
          category: rule.category,
        };
      }
      const last = result.rows[result.rows.length - 1];
      if (last === undefined) return;
      metricId = last.metric_id;
      scope = last.scope;
      scopeValue = last.scope_value;
    }
  }

  /**
   * The rule ids an issue filter selects, or null when no rule-shaped filter
   * was given.
   *
   * `ruleId`, `checkId` and `category` are three ways of naming the same thing,
   * so they INTERSECT rather than compete — and a combination that selects no
   * rule at all is a 400 naming both halves. An empty page would be read as
   * "nothing is wrong with this site", which is a false statement about a
   * question that was never asked.
   */
  private filterRuleIds(opts: IssueQuery): string[] | null {
    const chosen: { field: string; value: string; ids: string[] }[] = [];

    if (opts.ruleId !== undefined) {
      this.findingRule("ruleId", opts.ruleId);
      chosen.push({ field: "ruleId", value: opts.ruleId, ids: [opts.ruleId] });
    }
    if (opts.checkId !== undefined) {
      const ids = this.findingRulesByCheck.get(opts.checkId);
      if (ids === undefined) {
        throw new ServiceError(
          "VALIDATION",
          this.allChecks.has(opts.checkId)
            ? `checkId '${clip(opts.checkId)}' is claimed only by metric rules in ruleset ` +
              `${RULESET_VERSION}: it is measured, not found — ask /crawls/:id/metrics`
            : `checkId '${clip(opts.checkId)}' is claimed by no rule in ruleset ${RULESET_VERSION}`,
        );
      }
      chosen.push({ field: "checkId", value: opts.checkId, ids });
    }
    if (opts.category !== undefined) {
      const ids = this.findingRulesByCategory.get(opts.category);
      if (ids === undefined) {
        throw new ServiceError(
          "VALIDATION",
          // THE `allCategories` ARM IS DEFENSIVE AND CURRENTLY UNREACHABLE:
          // every category a metric rule uses is also used by a finding rule in
          // this ruleset, so the set of metric-only categories is empty and no
          // test can reach it. It is kept because a future metric-only category
          // (a `performance` group, say) would otherwise be refused as "not a
          // category" — true of the finding rules, and misleading about the
          // ruleset. The checkId arm above IS reachable (CHECK-29 is claimed
          // only by `url.param-volumes`) and is tested.
          this.allCategories.has(opts.category)
            ? `category '${clip(opts.category)}' holds only metric rules in ruleset ` +
              `${RULESET_VERSION} — ask /crawls/:id/metrics`
            : `category '${clip(opts.category)}' is not a rule category in ruleset ${RULESET_VERSION}`,
        );
      }
      chosen.push({ field: "category", value: opts.category, ids });
    }

    const first = chosen[0];
    if (first === undefined) return null;
    let ids = first.ids;
    for (const next of chosen.slice(1)) ids = ids.filter((id) => next.ids.includes(id));
    if (ids.length === 0) {
      throw new ServiceError(
        "VALIDATION",
        `no rule matches ${chosen.map((c) => `${c.field}='${clip(c.value)}'`).join(" and ")}: ` +
          `these filters select no rule, so an empty answer would say nothing was found ` +
          `rather than that nothing was asked`,
      );
    }
    return ids;
  }

  /** A finding rule by id, refusing an unknown id and a metric rule by name. */
  private findingRule(field: string, id: string): AnyRule {
    const rule = this.rules.get(id);
    if (rule === undefined) {
      throw new ServiceError(
        "VALIDATION",
        `${field} '${clip(id)}' is not a rule in ruleset ${RULESET_VERSION}`,
      );
    }
    if (rule.kind === "metric") {
      throw new ServiceError(
        "VALIDATION",
        `${field} '${clip(id)}' names a metric rule, which measures rather than finds: ` +
          `it writes no issues — ask /crawls/:id/metrics`,
      );
    }
    return rule;
  }

  /** The crawl's judgement as the read surfaces apply it (`judgement-view.ts`). */
  private async judgementView(crawlId: string): Promise<JudgementView> {
    return await loadJudgementView(this.db, crawlId, this.registry);
  }

  /**
   * The rule a stored row belongs to — the read-time copy join.
   *
   * A row whose rule the current ruleset does not define is refused rather than
   * rendered with blank copy: an issues table with no titles is a report a
   * client cannot act on, and the caller can fix this by re-running the rules
   * (which is what the message says).
   */
  private ruleFor(id: string, crawlId: string, table: "issues" | "metrics"): AnyRule {
    const rule = this.rules.get(id);
    if (rule === undefined) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} holds ${table} rows for '${clip(id)}', which ruleset ` +
          `${RULESET_VERSION} does not define, so there is no copy to answer with: ` +
          `re-run the rules over this crawl`,
      );
    }
    return rule;
  }

  /**
   * The SQL for one page-type cohort, after checking the crawl HAS that cohort.
   *
   * `page_type` is not a closed set — it is the client's patterns plus detected
   * URL templates — so it is validated against the crawl's own rows. A name
   * this crawl never produced is a typo, and answering it with an empty page
   * would say "no pages of that template have this problem" about a template
   * that does not exist here.
   *
   * `UNTYPED` is the one reserved name, and it means what it means everywhere
   * else in the engine (see the metric cohorts): the pages the crawler could
   * not type, which are a cohort rather than an absence.
   */
  private async pageTypeCondition(
    crawlId: string,
    pageType: string,
    column: SQL = sql`p.page_type`,
  ): Promise<SQL> {
    const untyped = pageType === UNTYPED;
    await this.assertExists(
      untyped
        ? sql`select 1 from pages where crawl_id = ${crawlId} and page_type is null limit 1`
        : sql`select 1 from pages where crawl_id = ${crawlId} and page_type = ${pageType} limit 1`,
      `pageType '${clip(pageType)}' names no page in crawl ${crawlId}`,
    );
    return untyped ? sql`${column} is null` : sql`${column} = ${pageType}`;
  }

  /** A crawl id that exists, or a 404 — every query route's first question. */
  private async assertCrawl(crawlId: string): Promise<void> {
    const rows = await this.db
      .select({ id: crawls.id })
      .from(crawls)
      .where(eq(crawls.id, crawlId))
      .limit(1);
    if (rows.length === 0) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
    }
  }

  /** Run an existence probe, refusing with `message` when it finds nothing. */
  private async assertExists(probe: SQL, message: string): Promise<void> {
    const result = await this.db.execute(probe);
    if (result.rows.length === 0) throw new ServiceError("VALIDATION", message);
  }

  private async crawlRow(crawlId: string): Promise<typeof crawls.$inferSelect> {
    const rows = await this.db.select().from(crawls).where(eq(crawls.id, crawlId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
    }
    return row;
  }

  /**
   * The crawl row and the two counts read beside it, from ONE statement and
   * therefore one snapshot of the database.
   *
   * The subqueries are what make `rulesRunAt`, `findingsCount` and
   * `pagesScanned` describe the same instant — see `getCrawl` for what a
   * two-snapshot read would compose out of a rules run's opening transaction.
   * `count(*)` over `issues (crawl_id)` and over `pages (crawl_id)` are both
   * index-only scans; the pairing is what this costs a round trip for, and it
   * costs nothing else.
   *
   * BOTH SUBQUERIES ARE BUILT, NOT WRITTEN, and that is the fix for a live
   * defect rather than a style preference. A column interpolated into a `sql`
   * template inside the select list of a single-table select renders
   * UNQUALIFIED (a `where` clause and a joined query's projection both qualify
   * it — this one case does not), so
   * `` sql`… from ${pages} where ${pages.crawlId} = ${crawls.id}` `` came out as
   * `where "crawl_id" = "id"` — and Postgres resolves BOTH names in the inner
   * scope, against `pages.id`, so the correlated subquery correlated with
   * nothing and counted 0 on every crawl. The findings count written the same
   * way is right only by accident: `issues` has no `id` column, so `"id"` has
   * nothing to bind to inside and falls out to `crawls.id`. Add an `id` to
   * `issues` and every judged crawl would start reporting `findingsCount: 0` —
   * silently, and reading as "the site is clean". `eq()` inside a select
   * builder renders `"pages"."crawl_id" = "crawls"."id"`, which says what it
   * means and keeps the compile-error-on-rename the schema objects are here
   * for.
   */
  private async crawlRowWithCounts(
    crawlId: string,
    db: SnapshotReader = this.db,
  ): Promise<{ row: typeof crawls.$inferSelect; findingsCount: number; pagesScanned: number }> {
    const findingRows = db
      .select({ n: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.crawlId, crawls.id));
    const pageRows = db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(eq(pages.crawlId, crawls.id));

    const rows = await db
      .select({
        ...getTableColumns(crawls),
        findingsCount: sql<number>`(${findingRows})`,
        pagesScanned: sql<number>`(${pageRows})`,
      })
      .from(crawls)
      .where(eq(crawls.id, crawlId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
    }
    const { findingsCount, pagesScanned, ...rest } = row;
    if (typeof findingsCount !== "number") {
      throw new Error(`crawlRowWithCounts: findingsCount came back as ${typeof findingsCount}, not a number`);
    }
    if (typeof pagesScanned !== "number") {
      throw new Error(`crawlRowWithCounts: pagesScanned came back as ${typeof pagesScanned}, not a number`);
    }
    return { row: rest, findingsCount, pagesScanned };
  }

  /**
   * Leases with a deadline still in the future, of either kind.
   *
   * Deliberately keyed on `lease_id is not null and leased_until > now()`
   * rather than on the row's state, because the two kinds of lease live in
   * different states: a crawl lease moves the row to `leased`, a render lease
   * leaves it at `render_pending` (see `heldRenderLeases`). "Is anyone working
   * this crawl" has to be true of both.
   */
  private async liveLeaseCount(crawlId: string, db: SnapshotReader = this.db): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(frontier)
      .where(
        and(
          eq(frontier.crawlId, crawlId),
          isNotNull(frontier.leaseId),
          sql`${frontier.leasedUntil} > now()`,
        ),
      );
    const n = rows[0]?.n;
    if (typeof n !== "number") {
      throw new Error(`liveLeaseCount: count came back as ${typeof n}, not a number`);
    }
    return n;
  }

  /**
   * Pages this crawl recorded as `blocked`.
   *
   * A count, not a sample: what the polling shape needs is one number that can
   * be compared with the previous poll.
   *
   * THE URLS THEMSELVES ARE ONE QUERY AWAY, and now they really are: the pages
   * listing takes `fetchClass=blocked` (`listPages`), which is the filter this
   * comment used to say did not exist and ought to. Every blocked row carries
   * its `fetchReason` too — the status, the attempts and the spacing the engine
   * had escalated to — so "crawl slower" and "this site refuses us" are
   * distinguishable from the listing rather than only from a re-crawl.
   */
  private async blockedPageCount(crawlId: string, db: SnapshotReader = this.db): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(and(eq(pages.crawlId, crawlId), eq(pages.fetchClass, "blocked")));
    const n = rows[0]?.n;
    if (typeof n !== "number") {
      throw new Error(`blockedPageCount: count came back as ${typeof n}, not a number`);
    }
    return n;
  }

  /**
   * The robots-blocked page rows (`CrawlDetail.robotsBlocked.recorded`): the
   * class AND the robots reason (`ROBOTS_BLOCKED`), so a url-policy refusal is
   * not counted as a robots.txt block.
   */
  private async robotsBlockedCount(crawlId: string, db: SnapshotReader = this.db): Promise<number> {
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pages p
      where p.crawl_id = ${crawlId} and ${ROBOTS_BLOCKED("p")}`);
    const n = rows.rows[0]?.n;
    if (typeof n !== "number") {
      throw new Error(`robotsBlockedCount: count came back as ${typeof n}, not a number`);
    }
    return n;
  }

  /**
   * The robots half of a crawl's stored discovery evidence, VALIDATED FIELD BY
   * FIELD rather than cast.
   *
   * Two callers, and both of them act on what it says: the render pass paces
   * itself by `crawlDelaySec` (rule 9 — a pass that ignored it would be a
   * second, ruder visit), and `getRobots` publishes the text an auditor will
   * quote to a site owner. `discovery_jsonb` is a jsonb column, so by read time
   * it is whatever is in the row; a `truncated` that is not a boolean reads as
   * falsy and turns "this text is a 500KB prefix" into silence, which is the
   * exact untruth the flag exists to prevent. This is the discipline
   * `parseDiscovery` applies for the rules (src/rules/query/crawl-evidence.ts),
   * raising the API's own refusal instead of a bare Error.
   *
   * A crawl with no discovery blob is a CONFLICT rather than an empty answer:
   * `discovery_jsonb` is written by `runCrawl` before the frontier is seeded,
   * so a row without one belongs to a crawl that never got that far. Rendering
   * it would mean visiting a site at a pace we have no evidence it permits, and
   * publishing it would mean reporting "no robots.txt" about a file nobody
   * asked for (hard rule 7).
   */
  private parseRobots(
    discovery: unknown,
    crawlId: string,
  ): {
    outcome: string;
    raw: string | null;
    truncated: boolean;
    crawlDelaySec: number | null;
    note: string | null;
    sitemapSources: string[];
    suppliedSitemaps: string[];
  } {
    if (discovery === null || discovery === undefined) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} has no discovery evidence: it never completed discovery, so ` +
          `there is nothing to render and no robots crawl-delay to honour`,
      );
    }
    if (!isRecord(discovery)) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} discovery evidence is not an object`,
      );
    }
    const robots = discovery["robots"];
    if (robots === null || typeof robots !== "object") {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} discovery evidence has no robots object`,
      );
    }
    const bad = (why: string): never => {
      throw new ServiceError("CONFLICT", `crawl ${crawlId} discovery evidence has ${why}`);
    };
    const record = robots as Record<string, unknown>;

    const outcome = record["outcome"];
    if (typeof outcome !== "string" || !(ROBOTS_OUTCOMES as readonly string[]).includes(outcome)) {
      bad(`an unknown robots.outcome (one of: ${ROBOTS_OUTCOMES.join(", ")})`);
    }
    const raw = record["raw"];
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      bad("a non-string robots.raw");
    }
    const truncated = record["truncated"];
    if (typeof truncated !== "boolean") bad("a non-boolean robots.truncated");
    const note = record["note"];
    if (note !== null && note !== undefined && typeof note !== "string") {
      bad("a non-string robots.note");
    }
    const delay = record["crawlDelaySec"];
    if (delay !== null && delay !== undefined && typeof delay !== "number") {
      bad("a non-numeric robots.crawlDelaySec");
    }
    // The declared sitemaps live one level up, on the discovery blob itself —
    // every one of them came off a `Sitemap:` line in this file
    // (`discoveryEvidence`, src/crawl/loop.ts).
    const sources = discovery["sitemapSources"];
    if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string")) {
      bad("no sitemapSources array of strings");
    }
    // Its sibling: the documents the CLIENT supplied, which the walk read too.
    // Absent is empty — the field arrived with the ability to supply a sitemap,
    // so a crawl written before it had none — and the wrong shape is a refusal,
    // because "no sitemap was supplied" is a claim about how this crawl was run
    // and must not be invented (the `parseDiscovery` ruling, hard rule 7).
    const supplied = discovery["suppliedSitemaps"];
    if (
      supplied !== undefined &&
      supplied !== null &&
      (!Array.isArray(supplied) || supplied.some((s) => typeof s !== "string"))
    ) {
      bad("a suppliedSitemaps that is not an array of strings");
    }

    return {
      outcome: outcome as string,
      raw: (raw as string | null | undefined) ?? null,
      truncated: truncated as boolean,
      crawlDelaySec: (delay as number | null | undefined) ?? null,
      note: (note as string | null | undefined) ?? null,
      sitemapSources: sources as string[],
      suppliedSitemaps: (supplied as string[] | null | undefined) ?? [],
    };
  }

  /** The crawl-delay the render pass has to honour, off the same evidence. */
  private robotsCrawlDelay(discovery: unknown, crawlId: string): number | null {
    return this.parseRobots(discovery, crawlId).crawlDelaySec;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One of the crawl config's string lists (`legacyHosts`, `sitemapUrls`) off a
 * stored config, checked rather than cast.
 *
 * Absent is `[]` and that is the honest reading: both fields are optional, and
 * a crawl started without one was told about no legacy domain and handed no
 * sitemap. A value of the wrong SHAPE is a different matter — it is a config
 * this engine did not write, and echoing `[]` for it would report "nothing was
 * configured" about a row that says otherwise (hard rule 7).
 * `parseStoredConfig` refuses the same shape for the same reason; this is the
 * read-only half of it, which does not demand the rest of the config be
 * readable in order to answer a status poll.
 */
function configStringList(config: unknown, field: string, crawlId: string): string[] {
  if (!isRecord(config)) {
    throw new ServiceError("CONFLICT", `crawl ${crawlId} has a stored config that is not an object`);
  }
  const value = config[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} has a stored config.${field} that is not an array of strings`,
    );
  }
  return value as string[];
}

/**
 * The finding cap this crawl will be judged under, for `CrawlDetail`.
 *
 * Through the rules layer's own reader and resolver rather than a second copy of
 * the mapping: `runRules` reads this row with exactly these two functions, so
 * what the detail reports and what the judgement applies cannot drift. A stored
 * value of the wrong shape is a refusal rather than a guess, and it is mapped to
 * the same 409 `configStringList` raises one field along — the crawl's config is
 * unreadable, which is a state of the row rather than a fault in the request.
 */
function configFindingCap(config: unknown, crawlId: string): number | null {
  try {
    return resolveRuleCaps(storedFindingCap(config, crawlId)).listing;
  } catch (error) {
    throw new ServiceError("CONFLICT", messageOf(error));
  }
}

/**
 * `crawl_config_get`'s answer from a judgement view: the block with the
 * config's `findingCap` folded back in (absent when the config has none), and
 * every overridable threshold as the block leaves it.
 */
function crawlConfigOf(crawlId: string, view: JudgementView): CrawlConfigOut {
  const block = view.block ?? {};
  const effective = effectiveThresholds(view.block);
  const thresholds = Object.fromEntries(
    (Object.entries(OVERRIDABLE_THRESHOLDS) as [ThresholdName, (typeof OVERRIDABLE_THRESHOLDS)[ThresholdName]][]).map(
      ([name, row]) => [
        name,
        {
          value: effective[name],
          default: row.default,
          min: row.min,
          max: row.max,
          overridden: block.thresholds?.[name] !== undefined,
        },
      ],
    ),
  ) as Record<ThresholdName, ThresholdSetting>;
  return {
    crawlId,
    judgement: {
      ...block,
      ...(view.findingCap === undefined ? {} : { findingCap: view.findingCap }),
    },
    thresholds,
    judgedWith: view.judgedWith,
    judgementStale: view.judgementStale,
  };
}

/**
 * Whether this crawl ran the resource fetch pass, for `CrawlDetail`.
 *
 * RESOLVED, like `configFindingCap`: an absent key is the engine's default,
 * which is `true` — every crawl since the pass shipped asks, and every crawl
 * written before it also reports `true`, honestly, because nobody chose
 * otherwise (what such a crawl lacks is the rows, and `resources.seen` is where
 * that shows).
 *
 * A stored value that is neither absent nor a boolean is a 409 on the same
 * terms as `configStringList`'s: `"false"` is truthy in JavaScript, so guessing
 * would report "this crawl asked the site about its files" about a crawl that
 * did not, which is the whole failure this field exists to prevent. The crawl
 * loop refuses the same shape at `parseStoredConfig`, so a resume and a reader
 * agree.
 */
function configFetchResources(config: unknown, crawlId: string): boolean {
  if (!isRecord(config)) return true;
  const value = config["fetchResources"];
  if (value === undefined || value === null) return true;
  if (typeof value !== "boolean") {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} has a stored config.fetchResources that is not a boolean`,
    );
  }
  return value;
}

// ------------------------------------------------------- the cross-crawl diff

/**
 * The reader `compareCrawls` and `listCompareUrls` share — a transaction handle,
 * not the pool, because both run every statement of one answer in one snapshot.
 */
type Reader = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The order the caveats are presented in: the whole comparison, then the rules. */
const CAVEAT_ORDER: CompareCaveat["code"][] = [
  "ruleset-mismatch",
  "ruleset-unrecorded",
  "ruleset-mixed",
  "finding-cap-differs",
  "judgement-overrides",
  "severity-changed",
];

/** `set`, validated against the one list both transports advertise. */
function parseCompareSet(value: string): CompareSet {
  const found = COMPARE_SETS.find((s) => s === value);
  if (found === undefined) {
    throw new ServiceError(
      "VALIDATION",
      `set '${clip(value)}' is not one of: ${COMPARE_SETS.join(", ")}`,
    );
  }
  return found;
}

/** Two lists of severities, compared as sets. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Both crawls' comparison-relevant facts, and every refusal that depends on
 * them — the shared pre-flight of `compareCrawls` and `listCompareUrls`.
 *
 * ONE STATEMENT for both rows so the two sides are read in one snapshot, and
 * inside the caller's transaction so the aggregate that follows is in it too.
 * The refusal ORDER is argued in `compareCrawls`' header; it is stated here as
 * code because both entry points must refuse identically — a drill-down that
 * answered a cross-site question the summary refuses would be the whole guard
 * with a hole in it.
 */
async function comparePair(
  reader: Reader,
  baseCrawlId: string,
  headCrawlId: string,
): Promise<{ base: Omit<CompareSide, "rulesetVersions" | "findingsCount">; head: Omit<CompareSide, "rulesetVersions" | "findingsCount"> }> {
  if (baseCrawlId === headCrawlId) {
    throw new ServiceError(
      "VALIDATION",
      `baseCrawlId and headCrawlId both name '${clip(baseCrawlId)}': a crawl compared with ` +
        `itself reports every rule as persisting and every change as zero, which is not a ` +
        `fact about the site`,
    );
  }

  const result = await reader.execute<{
    id: string;
    site_url: string;
    rules_run_at: string | null;
    config_jsonb: unknown;
  // `rules_run_at` IS FORMATTED IN SQL, not parsed here. `execute` is the raw
  // driver path: drizzle's own column mapping — what turns a `timestamptz` into
  // a `Date` on a `select()` — is not in it, so the value arrives as Postgres'
  // text spelling, a space where ISO-8601 wants a T. This produces the exact
  // string `getCrawl` answers with, from the database rather than reconstructed
  // from a format JavaScript only mostly parses. `to_char` of null is null, so
  // the column still answers the judged question.
  }>(sql`
    select id,
           site_url,
           to_char(rules_run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as rules_run_at,
           config_jsonb
      from crawls
     where id in (${baseCrawlId}, ${headCrawlId})`);
  const rows = new Map(result.rows.map((row) => [row.id, row]));
  const missing = [baseCrawlId, headCrawlId].filter((id) => !rows.has(id));
  if (missing.length > 0) {
    throw new ServiceError(
      "NOT_FOUND",
      `no such crawl${missing.length > 1 ? "s" : ""} ${missing.map((id) => `'${clip(id)}'`).join(" and ")}`,
    );
  }
  const baseRow = rows.get(baseCrawlId);
  const headRow = rows.get(headCrawlId);
  if (baseRow === undefined || headRow === undefined) {
    throw new Error("comparePair: a row present in the map is absent from it");
  }

  // BEFORE the judged check. A caller who names a crawl of another site must
  // learn only that it is another site (obligation 6).
  //
  // A `site_url` that is not a URL is a 409 rather than a 500, by `getRobots`'
  // argument: every row this engine writes went through `normalizeUrl`, so it is
  // a row we did not write, and that is a state of the row rather than a fault
  // in the request. It must NEVER be read as "these are different sites" — that
  // would refuse a legitimate comparison for a reason nobody could act on.
  let baseHost: string;
  let headHost: string;
  try {
    baseHost = new URL(baseRow.site_url).hostname;
    headHost = new URL(headRow.site_url).hostname;
  } catch {
    throw new ServiceError(
      "CONFLICT",
      `one of crawls '${clip(baseCrawlId)}' and '${clip(headCrawlId)}' has a site URL that ` +
        `is not a URL, so whether they are the same site cannot be decided`,
    );
  }
  if (!sameHostFamily(baseRow.site_url, headRow.site_url)) {
    throw new ServiceError(
      "VALIDATION",
      `crawls of different sites cannot be compared: '${clip(baseCrawlId)}' crawled ` +
        `'${baseHost}' and '${clip(headCrawlId)}' crawled '${headHost}'`,
    );
  }

  const unjudged = [
    ...(baseRow.rules_run_at === null ? [baseCrawlId] : []),
    ...(headRow.rules_run_at === null ? [headCrawlId] : []),
  ];
  if (unjudged.length > 0) {
    throw new ServiceError(
      "VALIDATION",
      `${unjudged.map((id) => `'${clip(id)}'`).join(" and ")} ` +
        `${unjudged.length > 1 ? "have" : "has"} never been judged (rulesRunAt is null), so ` +
        `there is nothing to compare — run the rules over ` +
        `${unjudged.length > 1 ? "them" : "it"} first. Findings already in the table belong ` +
        `to a pass that did not complete`,
    );
  }

  const side = (
    row: { id: string; site_url: string; rules_run_at: string | null },
    config: unknown,
  ): Omit<CompareSide, "rulesetVersions" | "findingsCount"> => {
    if (row.rules_run_at === null) throw new Error("comparePair: an unjudged side survived");
    return {
      crawlId: row.id,
      siteUrl: row.site_url,
      rulesRunAt: row.rules_run_at,
      findingCap: configFindingCap(config, row.id),
    };
  };
  return { base: side(baseRow, baseRow.config_jsonb), head: side(headRow, headRow.config_jsonb) };
}

/** One row of the comparison, straight out of the one statement that builds it. */
interface CompareRuleRow extends Record<string, unknown> {
  rule_id: string;
  base_n: number;
  head_n: number;
  base_u: number;
  head_u: number;
  base_sevs: string[] | null;
  head_sevs: string[] | null;
  base_versions: string[] | null;
  head_versions: string[] | null;
  base_trunc: boolean;
  head_trunc: boolean;
  added: number;
  removed: number;
  kept: number;
}

/**
 * The whole comparison, as one statement — the set arithmetic included.
 *
 * RULE 3 IN ITS SHARPEST FORM. The alternative shape is two `select` statements
 * of URLs and a `Set` difference in JavaScript, which is O(findings) in this
 * process's memory: 17,659 rows on the reference crawl and unbounded on a 50k
 * gate crawl. Every set here is built and differenced by Postgres, and what
 * crosses into this process is one row per rule — at most the ruleset's 86.
 *
 * The `materialized` CTEs are the reason the whole thing is one pass per crawl:
 * each side's rows are read once, and everything derived from them (row count,
 * distinct-URL count, severity set, ruleset set, truncation flag) reads that one
 * materialisation instead of re-scanning `issues`. Without the keyword Postgres
 * is free to inline a CTE and scan the table again per reference.
 *
 * The `full join` is on `(rule_id, k)` and is what makes the three sets one
 * pass: a null on the base side is a URL only the head has (`new`), a null on
 * the head side is one only the base had (`resolved`), and a row with both is
 * `persisting`. The nulls are the JOIN's own — a site-level finding's key is the
 * empty string, never null — which is why the coalesce is inside the CTEs.
 *
 * ## Why each side's aggregate is three small groupings joined, not one
 *
 * The obvious spelling is one `group by rule_id` over the side's rows carrying
 * `count(*)`, `count(distinct k)` and two `array_agg(distinct …)`. It is 3.4×
 * slower on the reference pair and it scales worse, both for one reason: a
 * `distinct` aggregate makes Postgres sort the WHOLE side by `(rule_id, k)`
 * before it can group, so the 17,659-row head became a `GroupAggregate` over a
 * 2,725kB quicksort — **112 ms of a 143 ms query**. Split as below, the row
 * count and the truncation flag are a hash aggregate over the raw rows, the URL
 * count is a hash aggregate over the already-distinct key set, and the two
 * `distinct` aggregates run over `…stamp` — at most a handful of rows per rule —
 * so nothing sorts the big side at all. Measured: **143 ms → 41.8 ms**, and the
 * sort that went away is the term that would have spilled to disk on a 50k-page
 * crawl's findings table rather than merely costing milliseconds.
 *
 * `u` is computed from the key set rather than derived as `kept + added`, even
 * though the two are equal by construction. That equality is the invariant the
 * transport tests assert (`headUrls == new + persisting`), and an invariant
 * whose two sides come from one expression checks nothing.
 */
async function compareRuleRows(
  reader: Reader,
  baseCrawlId: string,
  headCrawlId: string,
): Promise<CompareRuleRow[]> {
  /** One side: its rows, its key set, its distinct stamps, and the aggregate. */
  const side = (prefix: string, crawlId: string): SQL => {
    const raw = sql.raw(`${prefix}raw`);
    const keys = sql.raw(`${prefix}k`);
    const stamp = sql.raw(`${prefix}stamp`);
    return sql`
      ${raw} as materialized (
        select i.rule_id,
               i.severity,
               i.ruleset_version,
               coalesce(i.details_jsonb->>'pageUrl', '') as k,
               (i.details_jsonb->'truncated' is not null) as trunc
          from issues i
         where i.crawl_id = ${crawlId}),
      ${keys} as (select distinct rule_id, k from ${raw}),
      ${stamp} as (select distinct rule_id, severity, ruleset_version from ${raw}),
      ${sql.raw(prefix)} as (
        select counts.rule_id, counts.n, counts.trunc, urls.u, stamps.sevs, stamps.versions
          from (select rule_id, count(*)::int as n, bool_or(trunc) as trunc
                  from ${raw} group by rule_id) counts
          join (select rule_id, count(*)::int as u
                  from ${keys} group by rule_id) urls using (rule_id)
          join (select rule_id,
                       array_agg(distinct severity) as sevs,
                       array_agg(distinct ruleset_version) as versions
                  from ${stamp} group by rule_id) stamps using (rule_id))`;
  };

  const result = await reader.execute<CompareRuleRow>(sql`
    with ${side("b", baseCrawlId)},
         ${side("h", headCrawlId)},
         d as (
           select coalesce(bk.rule_id, hk.rule_id) as rule_id,
                  count(*) filter (where bk.k is null)::int as added,
                  count(*) filter (where hk.k is null)::int as removed,
                  count(*) filter (where bk.k is not null and hk.k is not null)::int as kept
             from bk full join hk on bk.rule_id = hk.rule_id and bk.k = hk.k
            group by 1),
         ids as (select rule_id from b union select rule_id from h)
    select ids.rule_id,
           coalesce(b.n, 0) as base_n,
           coalesce(h.n, 0) as head_n,
           coalesce(b.u, 0) as base_u,
           coalesce(h.u, 0) as head_u,
           b.sevs as base_sevs,
           h.sevs as head_sevs,
           b.versions as base_versions,
           h.versions as head_versions,
           coalesce(b.trunc, false) as base_trunc,
           coalesce(h.trunc, false) as head_trunc,
           coalesce(d.added, 0) as added,
           coalesce(d.removed, 0) as removed,
           coalesce(d.kept, 0) as kept
      from ids
      left join b on b.rule_id = ids.rule_id
      left join h on h.rule_id = ids.rule_id
      left join d on d.rule_id = ids.rule_id`);
  return result.rows;
}

/**
 * The ruleset versions one side's findings are stamped with, sorted and
 * deduplicated across the rules.
 *
 * The FINDINGS' stamp, never `crawls.ruleset_version`: the crawl column records
 * the ruleset at CRAWL time and the rows record the ruleset that judged them,
 * and on the reference data they differ by a whole version (a 0.6.0 crawl
 * re-judged at 0.7.0). An empty list is a judged crawl that wrote no findings —
 * nothing to read the version off.
 */
function versionsOf(rows: readonly CompareRuleRow[], side: "base" | "head"): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const version of (side === "base" ? row.base_versions : row.head_versions) ?? []) {
      seen.add(version);
    }
  }
  return [...seen].sort();
}

/** How a version list reads in a caveat, empty strings included. */
function versionList(versions: readonly string[]): string {
  return versions.map((v) => (v === "" ? "(unstamped)" : v)).join(", ");
}

/**
 * The ruleset half of `comparable`, with its caveat. Returns whether the two
 * sides agree.
 *
 * Three ways to disagree, each named separately because each is a different
 * thing for a consumer to do about it: the versions differ (the counts are of
 * different questions), one side has no version at all (nothing to check), or
 * one side holds findings from more than one ruleset (a crawl judged across a
 * change, including the `""` rows written before the stamp existed).
 *
 * ## `""` IS NOT A VERSION, and this is the subtle one
 *
 * `issues.ruleset_version` defaults to the empty string, which schema.ts calls
 * "written before the stamp existed" — deliberately NOT backfilled, because a
 * version number nobody can check is a claim rather than a record. Two such
 * sides would compare `"" === ""` and come out `comparable: true` with no
 * caveat at all: the strongest possible answer, produced from the total absence
 * of evidence. It is the same shape of error as reading `findingsCount: 0` on
 * an unjudged crawl as "this site is clean" (hard rule 7), and it is worse here
 * because two unstamped crawls are exactly what an OLD pair looks like.
 *
 * So an unstamped side is `ruleset-unrecorded`, alongside the side that wrote
 * no findings at all: in both cases nothing on any row says which rules ran,
 * and the honest answer is that there is nothing to check rather than that the
 * check passed. The caveat names WHICH of the two it is per side, because the
 * remedy differs — a crawl with no findings may simply be clean, while an
 * unstamped one is old and wants re-judging.
 */
function rulesetCaveat(base: CompareSide, head: CompareSide, caveats: CompareCaveat[]): boolean {
  const mixed = [base, head].filter((side) => side.rulesetVersions.length > 1);
  if (mixed.length > 0) {
    for (const side of mixed) {
      caveats.push({
        code: "ruleset-mixed",
        message:
          `'${side.crawlId}' holds findings stamped with more than one ruleset version ` +
          `(${versionList(side.rulesetVersions)}), so no single version describes what judged ` +
          `it: re-run the rules over it before reading a change`,
      });
    }
    return false;
  }
  // Two ways for a side to record no version: it wrote no rows, or its rows
  // carry the pre-stamp empty string. `every` rather than `[0] === ""` so the
  // predicate stays true if the `mixed` guard above is ever loosened.
  const unrecorded = [base, head].filter(
    (side) => side.rulesetVersions.length === 0 || side.rulesetVersions.every((v) => v === ""),
  );
  if (unrecorded.length > 0) {
    const why = (side: CompareSide): string =>
      side.rulesetVersions.length === 0
        ? `'${side.crawlId}' wrote no findings`
        : `'${side.crawlId}' holds findings written before the ruleset stamp existed ` +
          `(${versionList(side.rulesetVersions)})`;
    caveats.push({
      code: "ruleset-unrecorded",
      message:
        `${unrecorded.map(why).join(", and ")}, so the ruleset that judged ` +
        `${unrecorded.length > 1 ? "them" : "it"} is not recorded on any row and cannot be ` +
        `checked against the other side: re-run the rules before reading a change`,
    });
    return false;
  }
  const baseVersion = base.rulesetVersions[0] ?? "";
  const headVersion = head.rulesetVersions[0] ?? "";
  if (baseVersion !== headVersion) {
    // The message states the row-comparability claim in its own words and cites
    // NOTHING OF OURS. It shipped citing `docs/gates/phase-8.md §7.2` — the
    // precedent that argument comes from, and still cited in `CrawlComparison`'s
    // own documentation above — but a caveat is a PAYLOAD string: a Talos
    // dashboard renders it to a tenant who has no such file, cannot read it, and
    // learns from it only that this engine keeps documents somewhere (Talos
    // obligation 6, the Phase 10 tenant-safety sweep). The reference belongs in
    // the code, where the reader can follow it.
    caveats.push({
      code: "ruleset-mismatch",
      message:
        `these crawls were judged by different rulesets: '${base.crawlId}' at ` +
        `${versionList([baseVersion])} and '${head.crawlId}' at ${versionList([headVersion])}. ` +
        `A rule can change what it looks for, what it calls a finding and how severely it ` +
        `reports one between versions, so a count that moved may be the ruleset moving rather ` +
        `than the site. These rows are not row-comparable: read each side as its own report ` +
        `rather than subtracting one from the other`,
    });
    return false;
  }
  return true;
}

/** The finding-cap half of `comparable`, with its caveat. */
function capCaveat(base: CompareSide, head: CompareSide, caveats: CompareCaveat[]): boolean {
  if (base.findingCap === head.findingCap) return true;
  const say = (cap: number | null): string => (cap === null ? "uncapped" : `capped at ${cap}`);
  caveats.push({
    code: "finding-cap-differs",
    message:
      `these crawls were judged under different finding caps: '${base.crawlId}' ${say(base.findingCap)} ` +
      `and '${head.crawlId}' ${say(head.findingCap)}. A listing rule stops writing rows at its ` +
      `cap, so a count that moved may be the cap moving rather than the site — the per-rule ` +
      `baseTruncated and headTruncated flags say which rules were actually cut`,
  });
  return false;
}

/**
 * Map a `runRenderPass` throw onto a service refusal.
 *
 * The driver's deliberate refusals are `RenderPassRefusal`s and carry the
 * answer they need (`live` → 409, `missing` → 404); everything else it throws
 * is a defect and is returned untouched, to become a 500 with a correlation id.
 *
 * This used to match on the message prefix, and that was wrong in a way worth
 * recording: `runRenderPass`'s `RangeError` for a bad `renderConcurrency` also
 * begins `runRenderPass: `, so our own bug was being handed to the caller as
 * "the crawl is busy, try later". The type is carried by the throw now, and the
 * guards' wording is free to change without changing this function.
 */
function mapRenderPassError(
  error: unknown,
  crawlId: string,
  log: (line: string) => void,
): unknown {
  // The render browser could not be launched against this crawl's site:
  // url-policy refused the address the site's name resolves to, or could not
  // resolve it (Phase 24a's DNS pin). A fact about the site and the network,
  // not our defect, so a 409 naming the reason — never a 500 "internal error"
  // the caller can do nothing with. Nothing was rendered; the rows the
  // selection put in `render_pending` stay there, exactly as any launch
  // failure leaves them, and a later pass re-selects.
  //
  // WHAT THE REASON MAY SAY is bounded where it is written
  // (`resolveApprovedAddress`, "What the thrown message may say"): a refused
  // address keeps the host, the answer and the range, because that is public
  // DNS data about the caller's own site and the sentence the crawl's blocked
  // fetches already carry. A resolver failure says only that the name could
  // not be resolved; the resolver's own message rides on `cause` and goes
  // where a 500's stack goes — the log, under a correlation id the caller is
  // handed so an operator can find the line (obligation 6, same seam as
  // `http.ts`'s 500).
  if (error instanceof UrlPolicyError) {
    let reason = error.message;
    if (error.cause !== undefined) {
      const correlationId = randomUUID();
      log(
        `api: render launch ${correlationId} crawl ${crawlId} — ${error.message}: ` +
          messageOf(error.cause),
      );
      reason = `${reason}; detail logged under ${correlationId}`;
    }
    return new ServiceError("CONFLICT", `the render pass could not start: ${reason} (${error.code})`);
  }
  if (!(error instanceof RenderPassRefusal)) return error;
  // The `runRenderPass: ` prefix is the driver naming itself to a log reader.
  // A caller of the API already knows which endpoint they called.
  const message = error.message.startsWith("runRenderPass: ")
    ? error.message.slice("runRenderPass: ".length)
    : error.message;
  return new ServiceError(error.reason === "missing" ? "NOT_FOUND" : "CONFLICT", message);
}

/**
 * The `pages` field allowlist — ONE definition, three readers.
 *
 * The listing and the export both project through this object, so a column
 * added to `pages` tomorrow reaches neither until somebody names it here. Two
 * hand-maintained copies of a projection is how one of them eventually gains a
 * column the other refuses (Talos obligation 6).
 *
 * Exported for the third reader, which reads only the KEYS:
 * `test/skills/identifier-guard` checks that every page field the skills tell an
 * agent to read is a field this projection publishes.
 */
export const PAGE_FIELDS = {
  url: pages.url,
  statusCode: pages.statusCode,
  fetchClass: pages.fetchClass,
  /**
   * Why the row has no usable body or target, when that needed saying: a URL
   * the policy refused, a dropped redirect target, a coding we could not read,
   * and — since Task 6b — a block, with the attempts it took and the per-host
   * spacing the engine had escalated to before giving up.
   *
   * Named here deliberately. `fetchClass: "blocked"` on its own cannot tell an
   * agent whether the crawl went in too fast or the site refuses us outright,
   * and that is the difference between re-crawling slower and calling the site's
   * owner. It is safe to expose by the same discipline that builds it: the
   * reason is composed from the response and the URL policy only, never from a
   * stack trace or a local path (see FetchResult.disallowedReason).
   */
  fetchReason: pages.fetchReason,
  pageType: pages.pageType,
  indexable: pages.isIndexable,
  depth: pages.depth,
  /**
   * CLICKS FROM THE HOME PAGE, beside the discovery depth above and never
   * instead of it.
   *
   * The two answer different questions and an agent needs both: `depth` is where
   * the crawler's frontier found the URL — and since every sitemap entry is
   * enqueued as a seed, a page nothing links to is recorded there at 0 —
   * while this is the shortest path a visitor could walk to it. Null is the
   * finding: no internal link path reaches the page at all.
   *
   * Named here because CHECK-31 asks for a per-bucket table (depth 0, 1, 2 …,
   * plus the unreachable pages) and the click-depth METRIC gives percentiles
   * rather than buckets. Without this column an agent could see the shape of the
   * distribution and could not name a single page in it.
   */
  clickDepth: pages.clickDepth,
  /**
   * How the crawler reached this URL — seed, link, sitemap or redirect.
   *
   * Named here because it is half of the orphan cross-check: a page whose only
   * discovery was `sitemap` was never linked to from anywhere the crawl walked,
   * and `links.orphan`'s finding is checkable against the page list only if the
   * list says so. It is a fact about our own walk, not about the visitor's site,
   * and it is written by the crawl loop's four `enqueue` call sites.
   */
  discoveredVia: pages.discoveredVia,
  /**
   * Every word of visible text the HTML carried.
   *
   * SEMANTICS: template content is NOT counted (Phase 7); rows written before
   * that change counted it, and carry the old meaning. See `pages.word_count`.
   */
  wordCount: pages.wordCount,
  /**
   * The same count minus the words the page's own MARKUP says are not shown —
   * `hidden`, inline `display:none`, a closed `<dialog>`, a closed `<details>`'
   * body. Always <= `wordCount`, and the number `content.soft-404`'s length
   * ceiling is applied to. (`content.thin` judged on it between Phase 7 and
   * Phase 19 §11 and now judges on the page's MAIN-content count, which its
   * finding carries as `mainWords`.)
   *
   * BOTH COLUMNS, SIDE BY SIDE, deliberately. The surface used to publish only
   * `wordCount`, which on a page that hides half its markup is a number nobody
   * can see on the page — an agent reading the page list was quoting the
   * inflated figure. It is still here because it is what the HTML carries, and
   * the gap between the two is evidence about the page rather than an error in
   * either.
   *
   * NULL IS A GATE, not a zero: it means no Phase-7-or-later analyzer wrote the
   * row, so the correction was never computed. A page the analyzer never ran on
   * at all — a PDF, a 404 — is null in both columns, which is a different fact.
   */
  renderableWordCount: pages.renderableWordCount,
  rendered: pages.rendered,
  renderedWordCount: pages.renderedWordCount,
  /**
   * THE OTHER HALF OF `content.csr-dependent`'s COMPARISON (P8-T1), and the
   * reason it is on the wire at all.
   *
   * `renderedWordCount` above is the browser's `innerText`; this is the crawl's
   * own analyzer run over the serialised post-JavaScript DOM, so it and
   * `renderableWordCount` are two readings by ONE instrument and the rule
   * subtracts them. Publishing it is not decoration: the audit skill tells an
   * agent to check that a diff rule COULD have fired before recording its
   * silence as a PASS, and that check is exactly "read these two columns on the
   * rendered pages". Without it the instruction is unfollowable and the Phase 7
   * disposition (CHECK-01 recorded as a SKIP with the arithmetic in the notes)
   * could not have been reached from the surface.
   *
   * Null on a page nobody rendered, and on every page of a crawl rendered
   * before Phase 8 — which is a crawl `content.csr-dependent` refuses outright
   * rather than judges.
   */
  renderedRenderableWordCount: pages.renderedRenderableWordCount,
  renderError: pages.renderError,
  /**
   * WHEN THE FIRST OBSERVATION WAS TAKEN — the timestamp the page writer stamps
   * on every row (migration 0016). Null only on a row written before it.
   *
   * Named here because it is the other end of the recheck's gap: the second
   * observation's `recheckAt` beside it is what says how long the site had to
   * recover, and a gap nobody can compute is a claim nobody can check.
   */
  fetchedAt: pages.fetchedAt,
  /**
   * THE SECOND OBSERVATION, in the same `fetchClass` vocabulary as the first —
   * the 5xx re-verification pass's answer for this page (Phase 17).
   *
   * The projection is documented as deliberately slim, so this is a decision
   * rather than a drift: the recheck is the ONLY mechanism on this surface that
   * turns a `critical` into a `warning` (`http.server-error` becomes
   * `http.server-error-transient` when the second look got a non-5xx answer),
   * and an agent that cannot see the second observation cannot check the
   * engine's arithmetic before quoting it to a client.
   *
   * NULL MEANS NOBODY ASKED, and it never means "it was fine": the pass only
   * ever asks about a row whose FIRST fetch was `server_error`, so it is null on
   * every healthy page of every crawl. `recheckReason` beside it separates "the
   * pass never reached this row" (both null) from "the pass declined to ask, and
   * says why" (a reason with a null class).
   *
   * Tenant-safe by the same construction as `fetchReason`: composed from the
   * response and the URL policy, never from a stack trace or a local path.
   */
  recheckFetchClass: pages.recheckFetchClass,
  /** The status the second look got, or null when there was no response. */
  recheckStatusCode: pages.recheckStatusCode,
  /**
   * Why, in the fetch layer's own words — `fetchReason`'s twin for the second
   * observation, null on a recheck that simply worked, and the column that
   * carries the pass's own `recheck-cap` on a row it never got to.
   */
  recheckReason: pages.recheckReason,
  /**
   * When the pass SETTLED this row. Moves with `recheckFetchClass`: both null or
   * both non-null, over the whole table.
   */
  recheckAt: pages.recheckAt,
} as const;

const SEVERITIES: readonly Severity[] = ["critical", "warning", "info"];

/** A severity the ruleset can actually produce, or a 400 naming the field. */
function parseSeverity(value: string): string {
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new ServiceError(
      "VALIDATION",
      `severity '${clip(value)}' is not a severity (one of: ${SEVERITIES.join(", ")})`,
    );
  }
  return value;
}

/**
 * What an export was asked for — the two formats' vocabularies, kept apart.
 *
 * `dataset` belongs to `jsonl.gz` and `view` belongs to `csv`, and mixing them
 * is refused rather than resolved. A caller who wrote `format=csv&dataset=pages`
 * was thinking of one thing and asking for another; answering the half we
 * understood would hand them a file that is not the one they meant, with a 200
 * on it. The same argument as `checkQuery`'s unknown-parameter refusal.
 *
 * The rule id is validated through `findingRule`, so the two refusals that
 * matter arrive in the caller's words: a rule this ruleset does not define, and
 * a METRIC rule, which writes no findings at all — a header with no rows under
 * it would read as "this rule found nothing".
 */
function parseExportRequest(
  opts: { dataset?: string; format?: string; view?: string; ruleId?: string; metricId?: string },
  findingRule: (field: string, id: string) => AnyRule,
): ExportRequest {
  const format = parseFormat(opts.format);

  if (format === "jsonl.gz") {
    for (const [field, value] of [
      ["view", opts.view],
      ["ruleId", opts.ruleId],
      ["metricId", opts.metricId],
    ] as const) {
      if (value !== undefined) {
        throw new ServiceError(
          "VALIDATION",
          `'${field}' belongs to the CSV export: ask for format=csv, or drop it and ` +
            `name a dataset (one of: ${EXPORT_DATASETS.join(", ")})`,
        );
      }
    }
    return { format, dataset: parseDataset(opts.dataset) };
  }

  if (opts.dataset !== undefined) {
    throw new ServiceError(
      "VALIDATION",
      "'dataset' belongs to the jsonl.gz export; the CSV export takes a 'view' " +
        `(one of: ${CSV_VIEWS.join(", ")})`,
    );
  }

  const view = parseCsvView(opts.view);

  // THE ONE VIEW THAT IS NOT A KEYSET READ, and the one that takes a metric
  // rather than a rule. Its subject is required for `issue_urls`' reason: the
  // view IS one metric's table, and there is no such thing as all of them.
  if (view === "metric_table") {
    if (opts.ruleId !== undefined) {
      throw new ServiceError(
        "VALIDATION",
        "'ruleId' narrows the issue_urls view; the metric_table view is one METRIC's table " +
          "and takes a 'metricId'",
      );
    }
    if (opts.metricId === undefined || opts.metricId === "") {
      throw new ServiceError(
        "VALIDATION",
        "view 'metric_table' is one metric's table and needs a 'metricId' — rules_catalog " +
          "names the metrics this engine measures",
      );
    }
    return { format, view, ruleId: null, metricId: opts.metricId };
  }
  if (view === "issues_overview") {
    if (opts.ruleId !== undefined || opts.metricId !== undefined) {
      throw new ServiceError(
        "VALIDATION",
        "the issues_overview view is one row per rule over the whole crawl; it takes no " +
          "'ruleId' or 'metricId'",
      );
    }
    return { format, view, ruleId: null, metricId: null };
  }
  if (view === "crawl_overview") {
    if (opts.ruleId !== undefined || opts.metricId !== undefined) {
      throw new ServiceError(
        "VALIDATION",
        "the crawl_overview view is the whole crawl's overview sections; it takes no " +
          "'ruleId' or 'metricId'",
      );
    }
    return { format, view, ruleId: null, metricId: null };
  }
  if (opts.metricId !== undefined) {
    throw new ServiceError(
      "VALIDATION",
      `'metricId' names the metric_table view's subject; view '${view}' is not about one metric`,
    );
  }

  const needsRuleId = CSV_VIEW_DEFS[view].needsRuleId;
  if (needsRuleId && (opts.ruleId === undefined || opts.ruleId === "")) {
    throw new ServiceError(
      "VALIDATION",
      `view '${view}' is one rule's findings and needs a 'ruleId' — issues_list names ` +
        "the rules this crawl has findings for",
    );
  }
  if (!needsRuleId && opts.ruleId !== undefined) {
    throw new ServiceError(
      "VALIDATION",
      `'ruleId' narrows the issue_urls view; view '${view}' is not about one rule`,
    );
  }
  if (opts.ruleId !== undefined) findingRule("ruleId", opts.ruleId);
  return { format, view, ruleId: opts.ruleId ?? null, metricId: null };
}

/** The export format, defaulting to the one that shipped first. */
function parseFormat(value: string | undefined): ExportFormat {
  if (value === undefined) return "jsonl.gz";
  if (!(EXPORT_FORMATS as readonly string[]).includes(value)) {
    throw new ServiceError(
      "VALIDATION",
      `format '${clip(value)}' is not an export format (one of: ${EXPORT_FORMATS.join(", ")})`,
    );
  }
  return value as ExportFormat;
}

/** The CSV view, defaulting to the one an audit is usually after. */
function parseCsvView(value: string | undefined): CsvViewName {
  if (value === undefined) return "issues";
  if (!(CSV_VIEWS as readonly string[]).includes(value)) {
    throw new ServiceError(
      "VALIDATION",
      `view '${clip(value)}' is not an export view (one of: ${CSV_VIEWS.join(", ")})`,
    );
  }
  return value as CsvViewName;
}

/** The export dataset, defaulting to the one an audit is usually after. */
function parseDataset(value: string | undefined): ExportDataset {
  if (value === undefined) return "issues";
  if (!(EXPORT_DATASETS as readonly string[]).includes(value)) {
    throw new ServiceError(
      "VALIDATION",
      `dataset '${clip(value)}' is not an export dataset (one of: ${EXPORT_DATASETS.join(", ")})`,
    );
  }
  return value as ExportDataset;
}

/**
 * A crawl id as a filename component.
 *
 * The id reaches the export from the request path. It has already been matched
 * against a `crawls` row, so it is not attacker-chosen in practice — and it is
 * still slugged, because "the database vouches for it" is a property of today's
 * ids rather than of the filesystem. The caller of `exportCrawl` checks the
 * resulting path stays inside the export directory as well; neither check is
 * load-bearing alone.
 */
function slug(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

/** Evidence as stored, or a refusal — never a `{}` standing in for a row. */
function asEvidence(value: unknown, crawlId: string, ruleId: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} holds a finding for '${clip(ruleId)}' whose evidence is not an ` +
        `object: re-run the rules over this crawl`,
    );
  }
  return value as Record<string, unknown>;
}

function push(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [value]);
  else existing.push(value);
}

/**
 * A listing cursor: the sort key of the last row returned, base64url-encoded so
 * it is opaque to the caller and one token rather than three query parameters.
 *
 * Opaque, not encrypted — it carries values the caller was just given. What it
 * must not be is *guessable in the wrong shape*: a cursor that does not decode
 * is a 400, never an empty page, because an agent that paginated into silence
 * would conclude the listing had ended.
 *
 * JSON-encoded rather than delimiter-joined, because the parts are no longer
 * timestamps and ids: a URL may contain the delimiter, and so may a dedupe key
 * built from one. A cursor that split in the wrong place would page from a
 * position nobody asked for — silently, and only for the sites whose URLs
 * happen to contain the character.
 */
function encodeCursor(...parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

// Overloaded by arity so a caller destructures a TUPLE rather than an array of
// possibly-undefined parts: the arity check below is what makes that safe, and
// the type says so instead of every call site restating it.
function decodeCursor(cursor: string, arity: 1): [string];
function decodeCursor(cursor: string, arity: 2): [string, string];
function decodeCursor(cursor: string, arity: 3): [string, string, string];
function decodeCursor(cursor: string, arity: number): string[] {
  const bad = (): never => {
    throw new ServiceError("VALIDATION", "cursor is not a cursor this server issued");
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return bad();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== arity ||
    parsed.some((part) => typeof part !== "string")
  ) {
    return bad();
  }
  return parsed as string[];
}

/** The crawls listing's cursor: an exact timestamp and an id. */
function decodeCrawlCursor(cursor: string): { startedAt: string; id: string } {
  const [startedAt, id] = decodeCursor(cursor, 2);
  if (id === "" || Number.isNaN(Date.parse(startedAt))) {
    throw new ServiceError("VALIDATION", "cursor is not a cursor this server issued");
  }
  return { startedAt, id };
}

/** The issues listing's cursor: a severity rank and a rule id. */
function decodeIssueCursor(cursor: string): { rank: number; ruleId: string } {
  const [rank, ruleId] = decodeCursor(cursor, 2);
  const parsed = Number(rank);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3 || ruleId === "") {
    throw new ServiceError("VALIDATION", "cursor is not a cursor this server issued");
  }
  return { rank: parsed, ruleId };
}

function parseLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_SIZE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) {
    throw new ServiceError(
      "VALIDATION",
      `limit must be an integer between 1 and ${PAGE_SIZE_MAX}, got ${clip(String(limit))}`,
    );
  }
  return limit;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The refusal a settled crawl with nothing owed comes back with.
 *
 * It NAMES EVERY PLACE THAT WAS LOOKED, with its number, and that is the whole
 * design of the sentence. "Nothing to resume" on its own is unfalsifiable: the
 * caller cannot tell it from a bug in the check, and the one thing they want to
 * know — was the resource pass counted? — is exactly what a short refusal hides.
 * Three zeroes and the places they came from is a sentence an operator can argue
 * with (hard rule 7).
 *
 * The two conditional clauses are the two ways "zero" means something other than
 * "asked and answered": a crawl with the resource pass switched off has null
 * `fetch_class` rows that are a decision rather than owed work, and a crawl with
 * `render_pending` rows has visible unfinished work that belongs to a different
 * tool. Both would otherwise send a reader looking for a defect.
 */
function nothingToResume(crawlId: string, status: string, work: OwedWork): string {
  const parts = [
    `crawl ${crawlId} is '${status}' and has nothing left to resume: ` +
      `${work.pending} pending frontier row(s), ${work.expired} whose lease has expired, ` +
      `${work.resources} resource row(s) still unasked`,
  ];
  if (work.resourcesOff) {
    parts.push(
      `this crawl was configured with fetchResources: false, so its unfetched resource ` +
        `rows carry that decision and a resume would not ask about them`,
    );
  }
  if (work.renderPending > 0) {
    parts.push(
      `${work.renderPending} page(s) are render_pending — already crawled, awaiting the ` +
        `render pass, which is crawl_render's work and not a resume's`,
    );
  }
  parts.push(
    `a crawl that finished what it was asked to do is re-run as a new crawl, not continued`,
  );
  return parts.join(". ");
}

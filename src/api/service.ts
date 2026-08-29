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
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { and, asc, desc, eq, getTableColumns, gt, isNotNull, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crawls, frontier, issues, pages } from "../db/schema.js";
import {
  CRAWL_DEFAULTS,
  parseStoredConfig,
  resumeCrawl,
  storableConfig,
  validateCrawlConfig,
  type CrawlConfig,
} from "../crawl/loop.js";
import { DISCOVERED_VIA, frontierCounts, type FrontierCounts } from "../crawl/frontier.js";
import { FETCH_CLASSES } from "../crawl/fetch-page.js";
// The robots vocabulary from the module that WRITES it, never a copy: a fourth
// outcome added there must not turn every new crawl's stored evidence into a
// validation refusal here. See `ROBOTS_OUTCOMES` in discovery.ts.
import { ROBOTS_OUTCOMES } from "../crawl/discovery.js";
import {
  RENDER_HTML_DIR,
  RenderPassRefusal,
  runRenderPass,
  type RenderPassSummary,
} from "../crawl/render/run-render.js";
import { resolveRenderConfig } from "../crawl/render/select.js";
import { hostProbeStarts, normalizeUrl } from "../crawl/parse/url-utils.js";
import { isUrlAllowed } from "../crawl/url-policy.js";
import { buildRegistry } from "../rules/index.js";
import { RULESET_VERSION, type Registry } from "../rules/registry/registry.js";
import {
  METRIC_SCOPES,
  type AnyRule,
  type Severity,
} from "../rules/registry/types.js";
import { UNTYPED } from "../rules/metric/cohort.js";
import { runRules, type RunSummary } from "../rules/run.js";
import { isHostAllowed, type ServiceConfig } from "./config.js";

/**
 * The four ways a request can be refused for a reason the caller can act on.
 * A transport maps these; nothing else in this module knows they become 400,
 * 403, 404 and 409.
 */
export type ServiceErrorCode = "VALIDATION" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

/**
 * A refusal with a reason the caller may be shown.
 *
 * Every message raised as a `ServiceError` is tenant-safe by construction: it
 * is built from crawl ids, field names, statuses, counts and URL-policy reasons
 * — never from a stack, a file path or an internal hostname (Talos obligation
 * 6). Anything that is NOT a `ServiceError` is a defect, and the transport
 * turns it into a 500 with a correlation id, keeping the detail in the log.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

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
}

type FieldKind = "string" | "number" | "boolean" | "string[]" | "number|null";

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
 * know, and never accepts `allowPrivate` at any value.
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
   * Rows in the `issues` table for this crawl, counted live.
   *
   * The same number the issues listing's groups sum to, so a reader can tell
   * at a glance whether the judgement produced anything at all without paging
   * a listing. Read with `rulesRunAt`, never alone.
   */
  findingsCount: number;
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
 * 222 orphans and `content.near-duplicate` reports 500 of an unknown number;
 * without this field both read as exact, and an audit quotes a floor as a fact
 * (the Phase 6 gate's D-1 — an auditor did exactly that, and had to reconstruct
 * the real magnitude from a metric).
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
 * One finding, at URL level: the sf-action-plan tab feed.
 *
 * `evidence` is the stored `details_jsonb` verbatim — what the rule wrote,
 * including its own `pageUrl` — because an evidence blob is the rule's
 * testimony and the API is not entitled to edit it. It is tenant-safe by the
 * registry's discipline (a rule builds evidence from crawled rows, never from a
 * stack or a path), and the WRAPPER is a closed shape all the same.
 */
export interface IssueUrl {
  /** Null for a site-wide finding: a fact about the crawl, not about a page. */
  url: string | null;
  evidence: Record<string, unknown>;
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
}

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

    if (!isHostAllowed(host, this.config.allowedDomains)) {
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

    const crawlConfig = this.effectiveConfig(siteUrl, input);
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
      rulesetVersion: RULESET_VERSION,
      status: "queued",
    });

    const entry: QueueEntry = { crawlId, config: crawlConfig };
    this.waiting.push(entry);
    this.pump();
    return { crawlId, status: "queued", queuePosition: this.queuePosition(crawlId) ?? 0 };
  }

  /** Newest first, `(started_at, id)` descending — a total order, so a cursor is exact. */
  async listCrawls(opts: { limit?: number; cursor?: string } = {}): Promise<Page<CrawlListItem>> {
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCrawlCursor(opts.cursor);

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
      .where(
        cursor === null
          ? undefined
          : sql`(${crawls.startedAt}, ${crawls.id}) < (${cursor.startedAt}::timestamptz, ${cursor.id}::text)`,
      )
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
   * `rulesRunAt` AND `findingsCount` COME OUT OF ONE STATEMENT, and that is a
   * correctness requirement rather than a saved round trip. The two describe
   * each other: the marker says whether a judgement is on record, the count
   * says what it produced, and the tool descriptions tell an agent to read
   * `findingsCount: 0` beside a timestamp as "looked, found nothing".
   *
   * Read on two pool connections they would be two SNAPSHOTS, and `runRules`'
   * opening transaction clears the marker and deletes the crawl's issues
   * together (src/rules/run.ts). A crawl-row read landing just BEFORE that
   * commit and a `count(*)` landing just after would compose
   * `{rulesRunAt: <the previous run's stamp>, findingsCount: 0}` — a sentence
   * neither of the two states ever said, and precisely the one an agent is
   * told means the site is clean. The count is therefore a scalar subquery on
   * the crawl-row select: one statement, one snapshot, no pair that never
   * existed.
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
    const { row, findingsCount } = await this.crawlRowWithFindings(crawlId);
    const [counts, liveLeases, blockedPages] = await Promise.all([
      frontierCounts(this.db, crawlId),
      this.liveLeaseCount(crawlId),
      this.blockedPageCount(crawlId),
    ]);
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
      frontier: counts,
      queuePosition: row.status === "queued" ? this.queuePosition(crawlId) : null,
      liveLeases,
      blockedPages,
      hostSpacingMs: row.hostSpacingMs,
      legacyHosts: configStringList(row.config, "legacyHosts", crawlId),
      sitemapUrls: configStringList(row.config, "sitemapUrls", crawlId),
      rulesRunAt: row.rulesRunAt === null ? null : row.rulesRunAt.toISOString(),
      findingsCount,
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
      .set({ status: "failed", finishedAt: new Date() })
      // Conditioned on the status this call READ, so a crawl that started (or
      // was closed by its own worker) between the guard and here is left alone
      // rather than overwritten. `getCrawl` below reports what actually stands.
      .where(and(eq(crawls.id, crawlId), eq(crawls.status, row.status)));
    return this.getCrawl(crawlId);
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
      });
    } catch (error) {
      throw mapRenderPassError(error);
    }

    return {
      crawlId: summary.crawlId,
      rendered: summary.rendered,
      failures: summary.failures,
      unrendered: summary.unrendered,
      elapsedMs: summary.elapsedMs,
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
  async listIssues(crawlId: string, opts: IssueQuery = {}): Promise<Page<IssueGroup>> {
    await this.assertCrawl(crawlId);
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeIssueCursor(opts.cursor);

    const where: SQL[] = [sql`i.crawl_id = ${crawlId}`];
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
             (select i2.details_jsonb->'truncated'
                from issues i2
               where i2.crawl_id = ${crawlId}
                 and i2.rule_id = i.rule_id
                 and i2.details_jsonb->'truncated' is not null
               limit 1) as truncation
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
        category: rule.category,
        title: rule.title,
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
    };
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
  ): Promise<Page<IssueUrl>> {
    await this.assertCrawl(crawlId);
    this.findingRule("ruleId", ruleId);
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor, 2);

    const where: SQL[] = [sql`i.crawl_id = ${crawlId}`, sql`i.rule_id = ${ruleId}`];
    if (cursor !== null) {
      where.push(
        sql`(coalesce(i.details_jsonb->>'pageUrl', ''), i.dedupe_key) >
            (${cursor[0]}::text, ${cursor[1]}::text)`,
      );
    }

    const result = await this.db.execute<{
      url: string | null;
      url_key: string;
      evidence: unknown;
      dedupe_key: string;
    }>(sql`
      select i.details_jsonb->>'pageUrl' as url,
             coalesce(i.details_jsonb->>'pageUrl', '') as url_key,
             i.details_jsonb as evidence,
             i.dedupe_key
      from issues i
      where ${sql.join(where, sql` and `)}
      order by url_key asc, i.dedupe_key asc
      limit ${limit + 1}`);

    const rows = result.rows;
    const items = rows.slice(0, limit).map((row) => ({
      url: row.url,
      evidence: asEvidence(row.evidence, crawlId, ruleId),
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      nextCursor: last === undefined ? null : encodeCursor(last.url_key, last.dedupe_key),
    };
  }

  /**
   * The crawl's metrics, with the registry's copy joined.
   *
   * `value` crosses the wire exactly as the metric rule wrote it. A metric is a
   * measurement, and reshaping one in the API layer would put a second opinion
   * about what was counted between the rule and the reader.
   */
  async listMetrics(crawlId: string, opts: MetricQuery = {}): Promise<Page<MetricRow>> {
    await this.assertCrawl(crawlId);
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
    };
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
  async exportCrawl(crawlId: string, opts: { dataset?: string } = {}): Promise<ExportResult> {
    await this.assertCrawl(crawlId);
    const dataset = parseDataset(opts.dataset);

    await mkdir(this.exportDir, { recursive: true });
    // The crawl id reaches this from the request path, so it is slugged before
    // it becomes a filename and the result is checked to be inside the export
    // directory. A caller names a crawl, never a path.
    const file = joinPath(this.exportDir, `${slug(crawlId)}-${dataset}.jsonl.gz`);
    if (!resolvePath(file).startsWith(this.exportDir + pathSep)) {
      throw new Error(`export: refusing to write outside the export directory (${file})`);
    }
    const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;

    const gzip = createGzip();
    // THE HANDLER IS ATTACHED AT CREATION, and that placement is the whole
    // point. The write side fails on its own schedule — ENOSPC, a directory
    // removed underneath us, EACCES on open — and control spends most of this
    // method parked in `exportRows`' database awaits. A `pipeline()` promise
    // whose rejection has no handler AT THE MOMENT IT REJECTS is an unhandled
    // rejection, and an unhandled rejection ends the process in Node 22: a full
    // disk would take the API server down with it. Catching here turns that
    // into a value, which the loop below checks and re-throws as its own error
    // (the same reasoning as the queue runner's catch in `pump`).
    let writeError: unknown = null;
    const written = pipeline(gzip, createWriteStream(temp)).catch((error: unknown) => {
      writeError = error;
    });

    let rows = 0;
    try {
      for await (const row of this.exportRows(crawlId, dataset)) {
        if (writeError !== null) throw writeError;
        // Backpressure honoured: gzip's buffer says when to wait, so a slow
        // disk slows the reader rather than filling memory with pending writes.
        if (!gzip.write(`${JSON.stringify(row)}\n`)) await once(gzip, "drain");
        rows += 1;
      }
      gzip.end();
      await written;
      if (writeError !== null) throw writeError;
      // The rename is the publish step: everything above wrote a temp file
      // nobody was reading.
      await rename(temp, file);
    } catch (error) {
      gzip.destroy();
      await written;
      await unlink(temp).catch(() => undefined);
      throw error;
    }

    const { size } = await stat(file);
    return { dataset, path: file, rows, bytes: size };
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
   */
  private async runQueued(entry: QueueEntry, signal: AbortSignal): Promise<void> {
    this.log(`api: crawl ${entry.crawlId} starting (${entry.config.siteUrl})`);
    try {
      const summary = await resumeCrawl(this.db, entry.crawlId, {
        config: entry.config,
        signal,
      });
      this.log(
        `api: crawl ${entry.crawlId} ${summary.status} — ${summary.pagesCrawled} page(s)`,
      );
    } catch (error) {
      // The crawl's own failure path has already closed the row as `failed`
      // (see `execute` in the crawl loop) for anything thrown inside the run.
      // A throw BEFORE that — a row deleted underneath us, a config the loop
      // will not take — would leave the row `queued`, which is a lie: nobody
      // will ever run it. Closing it is transparency, not recovery; the error
      // is logged either way and never swallowed into a clean-looking row.
      this.log(`api: crawl ${entry.crawlId} threw — ${messageOf(error)}`);
      await this.db
        .update(crawls)
        .set({ status: "failed", finishedAt: new Date() })
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

      if (!isHostAllowed(host, this.config.allowedDomains)) {
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
          `a named list is a statement about which pages matter, so shorten it or ` +
          `raise renderMaxPages on the crawl`,
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
      if (!own.has(host) && !isHostAllowed(host, this.config.allowedDomains)) {
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

  private effectiveConfig(siteUrl: string, input: StartCrawlInput): CrawlConfig {
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
  ): AsyncGenerator<Record<string, unknown>> {
    if (dataset === "issues") {
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
            title: rule.title,
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
          // ruleset. The checkId arm above IS reachable (CHECK-08 is claimed
          // only by `sitemap.structure`) and is tested.
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
   * The crawl row and its findings count, from ONE statement and therefore one
   * snapshot of the database.
   *
   * The subquery is what makes `rulesRunAt` and `findingsCount` describe the
   * same instant — see `getCrawl` for what a two-snapshot read would compose
   * out of a rules run's opening transaction. `count(*)` over
   * `issues (crawl_id)` is an index-only scan; the pairing is what this costs
   * a round trip for, and it costs nothing else.
   */
  private async crawlRowWithFindings(
    crawlId: string,
  ): Promise<{ row: typeof crawls.$inferSelect; findingsCount: number }> {
    const rows = await this.db
      .select({
        ...getTableColumns(crawls),
        // Through the schema objects rather than raw table text, so a rename of
        // the table or the column is a compile error here rather than a 500 the
        // first time somebody polls a crawl.
        findingsCount: sql<number>`(select count(*)::int from ${issues} where ${issues.crawlId} = ${crawls.id})`,
      })
      .from(crawls)
      .where(eq(crawls.id, crawlId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
    }
    const { findingsCount, ...rest } = row;
    if (typeof findingsCount !== "number") {
      throw new Error(`crawlRowWithFindings: count came back as ${typeof findingsCount}, not a number`);
    }
    return { row: rest, findingsCount };
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
  private async liveLeaseCount(crawlId: string): Promise<number> {
    const rows = await this.db
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
  private async blockedPageCount(crawlId: string): Promise<number> {
    const rows = await this.db
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
function mapRenderPassError(error: unknown): unknown {
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
   * body. Always <= `wordCount`, and it is the number a thin-content judgement
   * is actually made on (`content.thin`).
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
 * Bound and de-fang a caller's own string before it goes back in an error.
 *
 * Not an escaping function — the response is JSON, which quotes for us — but a
 * length and control-character cap, so a 10MB field name or a terminal escape
 * sequence cannot ride an error message into somebody's log or console.
 */
function clip(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

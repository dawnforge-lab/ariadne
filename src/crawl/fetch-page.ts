/**
 * The single fetch primitive the crawl loop uses. One URL in, one classified
 * result out — nothing here throws for a target-site problem: a refusal, a
 * timeout, a reset connection and a 2MB body are all classified rows, never
 * exceptions (build plan rule 7, "no silent fallbacks" cuts both ways — an
 * error must be visible *and* recorded, not swallowed and not thrown past the
 * loop).
 *
 * The converse holds too, and matters as much: a problem that is *ours* — a
 * malformed user agent, a bad option — is rethrown, never classified. See
 * isProgrammerError. Classifying our own bug as `network_error` would bury a
 * one-line config defect under 50k indistinguishable rows.
 *
 * Fetch semantics are OpenSEO's decisions (site-audit-workflow-helpers.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070), read as reference and
 * re-implemented over undici rather than lifted: manual redirects so every hop
 * is its own row, a 2MiB body cap (spent on decompressed bytes — see
 * readCappedDecoded), and the bot-challenge classification table. Divergences
 * from that table are marked "CHANGED" at their line.
 *
 * The plumbing under all of that — connection pools, the connect-time address
 * guard, the capped reader, charset decoding, error classification — lives in
 * ./http, because discovery (robots.txt, sitemaps) needs the same guarantees
 * on documents that are not pages. What stays here is what is specific to
 * fetching an HTML page.
 */
import { request } from "undici";
import { isUrlAllowed } from "./url-policy.js";
import { detectPlatform, type Platform } from "./platform.js";
import {
  ACCEPT_ENCODING,
  blockedAddressMessage,
  decodeBody,
  headerValue,
  headerValues,
  isProgrammerError,
  isTimeout,
  mimeType,
  newAgent,
  readCappedDecoded,
  sharedAgent,
  type DnsLookupFn,
  type HeaderBag,
} from "./http.js";
import { captureResponseHeaders, type StoredResponseHeaders } from "./response-headers.js";
import { parseLinkHeader, relTokens, type LinkHeaderEntry } from "./link-header.js";
import { MAX_HREFLANG_PAIRS, type HreflangPair } from "./parse/page-analyzer.js";
import { credentialHeadersOf, type CredentialTarget } from "./credentials.js";

/**
 * The body cap, spent on **decompressed** bytes (see readCappedDecoded). It
 * bounds the wire read too, because the reader stops inflating and destroys
 * the socket the moment the cap is reached — a compressed body can therefore
 * never cost more than ~2MiB of transfer either.
 *
 * 2MiB since Phase 23 (docs/research/2026-10-21-screaming-frog-study.md, D2):
 * 1MiB refused real pages that search engines read, and a refused page was
 * then silent. Over the cap a 200 HTML page is `too_large` and
 * `page.html-too-large` reports it; `htmlBytes` on that row is this number,
 * the byte count at which reading stopped.
 *
 * EXPORTED because three readers need the SAME number: the crawl loop reserves
 * it per fetch in `CrawlWindow`'s byte budget (the worst case is the only number
 * that bounds peak RSS before the fact — 64MiB / 2MiB = at most 32 bodies in
 * flight, whatever the concurrency), and `page.html-too-large` reports it as the
 * limit the page went over.
 */
export const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/** How much of the body the challenge markers are searched in. */
const CHALLENGE_SNIPPET_BYTES = 4_000;

/**
 * Markers of a bot-mitigation challenge page. Classifying these as `blocked`
 * is the point: recording the challenge HTML as if it were the page is how an
 * audit silently reports a whole site as thin content.
 *
 * CHANGED from OpenSEO's list: theirs is the first five; the rest are the
 * non-Cloudflare vendors (Imperva/Incapsula, PerimeterX, DataDome) that the
 * plan's starter table added. "verify"/"verifying you are human" are both
 * kept — Cloudflare has shipped both wordings.
 */
const CHALLENGE_BODY_MARKERS = [
  "just a moment...",
  "challenge-platform",
  "cf-browser-verification",
  "attention required! | cloudflare",
  "verifying you are human",
  "verify you are human",
  "_incapsula_",
  "request unsuccessful. incapsula",
  "perimeterx",
  "px-captcha",
  "datadome",
];

const HTML_MIME_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * How a fetch ended. Stored verbatim in `pages.fetch_class`.
 *
 * Adding a member here is not a local change. `loop`'s TRANSIENT set decides
 * whether the URL is fetched again, `politeness`'s BACKPRESSURE set decides
 * whether the window collapses, and a dozen rules name classes in SQL. A new
 * member that nobody placed in those two sets silently gets both defaults —
 * not retried, not throttling — which may be right, but only if someone said
 * so. Audit all three when you add one; the sets carry a note naming the
 * member most likely to be misfiled.
 *
 * A LIST RATHER THAN A BARE UNION, and the type is derived from it: the agent
 * surface validates a `fetchClass` filter against these values
 * (`ApiService.listPages`), so the vocabulary has to exist at runtime. Deriving
 * the type from the list rather than maintaining a second copy beside it is
 * what keeps the two from drifting — a class added here is filterable the same
 * day, and one that is not in this list is not a class at all.
 */
export const FETCH_CLASSES = [
  "ok",
  "redirect",
  "client_error",
  "server_error",
  "blocked",
  "timeout",
  "network_error",
  "non_html",
  "too_large",
  /**
   * The response carried a `content-encoding` we do not implement, so its
   * bytes are unreadable to us. Distinct from `network_error` because it is
   * DETERMINISTIC: the same request gets the same undecodable answer, so it
   * must stay out of the retry bucket (see loop's TRANSIENT). Some CDNs ignore
   * `accept-encoding` and answer `br` regardless; three fetches of that is
   * three times the rudeness for the same non-answer (rule 9).
   */
  "unsupported_encoding",
  "disallowed",
  /**
   * The URL was recorded and never requested because the crawl's own scope
   * patterns (`exclude` / `include`) refuse it. Our decision, not the site's
   * answer; see `NEVER_REQUESTED` in src/rules/helpers.ts.
   */
  "excluded",
] as const;

export type FetchClass = (typeof FETCH_CLASSES)[number];

export interface FetchResult {
  url: string;
  statusCode: number | null;
  fetchClass: FetchClass;
  contentType: string | null;
  /**
   * Absolute, resolved against url, and policy-checked. Null unless the
   * response was a 3xx whose Location resolved to a crawlable http(s) URL —
   * see resolveRedirectTarget.
   */
  redirectUrl: string | null;
  /** Decoded html text, ≤ MAX_BODY (2MiB); null for every class except `ok`. */
  body: string | null;
  /**
   * How many bytes of body we hold, capped at MAX_BODY. For the classes that
   * keep a body this is the html's own size — the **decompressed** length when
   * the response was gzipped, so it means the same thing whether or not the
   * origin compresses, and matches what the analyzer measures. For the classes
   * whose body is drained unread (redirects, non-HTML, 4xx) it is the wire
   * bytes, which is what those cost us.
   */
  htmlBytes: number;
  /** Time to response headers, not to the last body byte. */
  responseTimeMs: number;
  /**
   * `Retry-After`, in milliseconds from the moment the response arrived, on the
   * classes where it is a throttle: `blocked` (401/403/429/challenge) and a 503
   * `server_error`. Null everywhere else — a 404 carrying the header is not
   * asking us to slow the site down, and honouring it there would let one
   * misconfigured error page pace the whole crawl.
   *
   * Null also when the header WAS there and could not be read; the reason is
   * then written into `disallowedReason` so the row says so (hard rule 7). It
   * is never NaN and never a guess.
   *
   * NOT persisted: it is a fact about a moment, consumed by `HostGate.report`,
   * which caps it at `maxDelayMs` before honouring it. This object carries what
   * the server said; the gate decides what to do about it.
   */
  retryAfterMs: number | null;
  /** From `Link: <...>; rel="canonical"`, verbatim (not normalised). */
  canonicalHeader: string | null;
  xRobotsTag: string | null;
  /**
   * The platform the response headers name (`detectPlatform`, src/crawl/
   * platform.ts), or null when they name none or nothing answered. Computed
   * here because this is the one place that holds the headers; the response's
   * other headers are not kept. NOT persisted per page: the crawl loop reads
   * it off the first classifiable response and records the verdict on the
   * crawl row (`crawls.platform`).
   */
  platformHint: Platform | null;
  /**
   * The allowlisted response headers (`captureResponseHeaders`), or null —
   * EXACTLY when no response headers arrived, whatever the class: a connect or
   * header timeout, a `disallowed` refusal, a `network_error` before any
   * response. Set on every fetch that SAW a response, including a `timeout`
   * whose deadline expired during the body and a `network_error` raised after
   * the headers (a corrupt gzip body, a mid-body reset): those headers arrived
   * and are real, while `statusCode` stays null there. Persisted as
   * `pages.response_headers`.
   */
  responseHeaders: StoredResponseHeaders | null;
  /**
   * Hreflang pairs from the `Link` header (Phase 26c): entries whose `rel`
   * tokens include `alternate` with a non-empty `hreflang`, hrefs as written,
   * at most `MAX_HREFLANG_PAIRS`. Read on every classified response, HTML or
   * not and redirect or not, from the FULL header — never from
   * `responseHeaders`, whose values are cut at `RESPONSE_HEADER_VALUE_CAP`
   * (deviation 2). Empty wherever `canonicalHeader` is null for want of a
   * classified response (no status: a refusal, a timeout, a network error).
   * Persist writes them as `source = 'header'` rows.
   */
  headerHreflang: HreflangPair[];
  /**
   * Why this row has no usable body or target, in plain words. Set on
   * `disallowed` (the URL or the address it resolved to), on `redirect` when
   * the Location was dropped rather than passed on, on `unsupported_encoding`
   * (naming the coding we could not read), and on a throttle whose
   * `Retry-After` we had to ignore (naming the value we refused). Null
   * otherwise.
   *
   * **This is persisted**, as `pages.fetch_reason` — the class alone is not an
   * explanation, and a reason that lived only in this object would be an
   * argument about transparency that was false the moment the row was written
   * (hard rule 7). Anything put here reaches an operator's report, so it is
   * built from the response and the URL policy only: never a stack trace,
   * never a local path.
   *
   * The name is now narrower than the job — it predates the other three uses —
   * but renaming it ripples through `persist`, the column and the rule layer
   * for no behavioural gain.
   */
  disallowedReason: string | null;
}

/**
 * Thrown (never returned) when the caller's `FetchOpts.signal` aborts a fetch.
 * An abort is not a fact about the target site, so it must never become a
 * classified row: the loop catches this and puts the URL back in the frontier.
 */
export class FetchAbortedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`fetch of ${url} aborted by the crawl's signal`);
    this.name = "FetchAbortedError";
    this.url = url;
  }
}

export interface FetchOpts {
  userAgent: string;
  /**
   * The crawl's control signal. Aborting it rejects `fetchPage` with
   * FetchAbortedError — it never resolves to a FetchResult. The per-fetch
   * deadline is separate and still yields a `timeout` row.
   */
  signal?: AbortSignal;
  /** Applied to connect, response headers, and inter-chunk body reads. */
  timeoutMs?: number;
  /**
   * TEST ONLY. Relaxes both the URL check and the connect-time address
   * re-check to the same floor (see url-policy) so the suite can crawl a
   * 127.0.0.1 fixture server. Never wire this to config, an API field or an
   * env var.
   */
  allowPrivate?: boolean;
  /**
   * The crawl's URL length limit (`UrlPolicyOpts.maxUrlLength`), applied to the
   * URL before it is requested and to a redirect target before it is offered
   * back to the crawl. Absent is the index's own limit.
   */
  maxUrlLength?: number;
  /**
   * TEST ONLY. Replaces `dns.lookup` under the connect-time guard, so the
   * SSRF tests can pin a hostname to an address without touching the network.
   * Supplying it also opts out of the shared connection pool.
   */
  lookup?: DnsLookupFn;
  /**
   * The crawl's credentials (Phase 27c), sent only when THIS url is in the
   * site family (`credentialHeadersFor`). A redirect is never followed here —
   * each hop is its own `fetchPage` call — so each hop decides for itself.
   */
  credentials?: CredentialTarget;
}

/**
 * `Link: <https://ex.com/c>; rel="canonical", <...>; rel="next"` -> the
 * canonical target, verbatim. Normalisation is the analyzer's job, not ours.
 */
export function parseCanonicalLinkHeader(value: string | null): string | null {
  if (value === null) return null;
  return canonicalOf(parseLinkHeader([value]).entries);
}

/**
 * The first entry with a non-empty URI whose `rel` tokens include `canonical`,
 * its URI verbatim. An empty `<>` is skipped rather than ending the search, as
 * the pre-26c regex did.
 */
function canonicalOf(entries: LinkHeaderEntry[]): string | null {
  const canonical = entries.find(
    (entry) => entry.uri !== "" && relTokens(entry).includes("canonical"),
  );
  return canonical === undefined ? null : canonical.uri;
}

/**
 * `Link: <…>; rel="alternate"; hreflang="de"` -> the hreflang pairs (Phase
 * 26c), as the analyzer reads `<link rel=alternate hreflang>`: `rel` taken as
 * tokens, a non-empty `hreflang` required, the URI left as written (persist
 * resolves it against the page URL and measures it against
 * `INDEXED_URL_MAX`), at most `MAX_HREFLANG_PAIRS`.
 */
function hreflangOf(entries: LinkHeaderEntry[]): HreflangPair[] {
  const pairs: HreflangPair[] = [];
  for (const entry of entries) {
    if (pairs.length >= MAX_HREFLANG_PAIRS) break;
    const code = entry.params["hreflang"];
    if (code && relTokens(entry).includes("alternate")) pairs.push({ code, href: entry.uri });
  }
  return pairs;
}

/**
 * `Retry-After` (RFC 9110 §10.2.3), in milliseconds from `nowMs`.
 *
 * Two legal spellings — delta-seconds (`120`) and an HTTP-date (`Wed, 21 Oct
 * 2015 07:28:00 GMT`) — and a long tail of things servers send instead. The
 * contract for that tail is the point of this function: an unreadable value
 * yields `ms: null` and a `note` saying what was refused. Never NaN, never a
 * silent 0, never a throw. A crawl must not stop because a WAF sent `soon`,
 * and it must not pretend the header was absent either (hard rule 7).
 *
 * What it deliberately does NOT do is cap: `31536000` (a year) is read as a
 * year, and `HostGate` is where that meets `maxDelayMs`. One policy, in the one
 * module that owns spacing.
 *
 * The date branch requires a letter in the value before `Date.parse` sees it.
 * `Date.parse` is lenient in ways no HTTP-date is — `"2026"` parses as a year,
 * `"-5"` as who-knows-what — and an IMF-fixdate always carries a month name.
 * Without the guard a hostile `"3000"` would become a millennium of back-off.
 */
export function parseRetryAfter(
  value: string | null,
  nowMs: number = Date.now(),
): { ms: number | null; note: string | null } {
  if (value === null) return { ms: null, note: null };

  const raw = value.trim();
  const unreadable = {
    ms: null,
    note: `unreadable Retry-After header (${clipHeader(value)}); ignored`,
  };
  if (raw === "") return unreadable;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    // A 300-digit header parses to Infinity. It is not a number we can use.
    if (!Number.isFinite(seconds)) return unreadable;
    return { ms: seconds * 1000, note: null };
  }

  if (!/[a-zA-Z]/.test(raw)) return unreadable;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return unreadable;

  const deltaMs = at - nowMs;
  if (deltaMs > 0) return { ms: deltaMs, note: null };
  return {
    ms: 0,
    note: `Retry-After named a time in the past (${clipHeader(value)}); ignored`,
  };
}

/** A header value fit to put in a row an operator will read. */
function clipHeader(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * The classes on which a `Retry-After` is a throttle rather than noise: a
 * block, and the 503 that did not turn out to be a challenge. A 404 or a
 * redirect carrying the header is answering about itself, not asking the
 * crawler to slow down, and pacing a whole host off one is how a single broken
 * error page halves a crawl.
 */
function isThrottle(fetchClass: FetchClass, statusCode: number): boolean {
  return fetchClass === "blocked" || (fetchClass === "server_error" && statusCode === 503);
}

/**
 * Status/header classification, OpenSEO's table.
 *
 * EXPORTED for the resource fetch pass (src/crawl/resources/fetch-resources.ts),
 * which asks a server about an image the same way this asks about a page and
 * must reach the same verdict about a 403, a `cf-mitigated` header or a 503 —
 * a second copy of this table would be the fork hard rule 9 is about, and it
 * would drift the first time a vendor added a header. That caller has no body
 * to offer (it fetches HEAD), so it passes an empty snippet: a 503 it cannot
 * check for challenge markers stays a `server_error`, which is the honest
 * reading and the same one this function makes for a 503 whose body was
 * undecodable.
 *
 * CHANGED from the plan's starter table: `cf-mitigated` blocks on any value,
 * not only "challenge" — that matches OpenSEO, and Cloudflare has never
 * documented the value set, so equality would fail open on the next one.
 *
 * Kept from OpenSEO: only 503 consults the body markers. 401/403/429 are
 * already `blocked` by status, and a 200 carrying challenge HTML is rare
 * enough (and indistinguishable enough from a page *about* Cloudflare) that
 * matching markers there would misclassify real pages.
 */
export function classifyStatus(
  status: number,
  headers: HeaderBag,
  bodySnippet: string,
): FetchClass {
  if (headerValue(headers, "cf-mitigated") !== null) return "blocked";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (status === 503) {
    const snippet = bodySnippet.toLowerCase();
    if (CHALLENGE_BODY_MARKERS.some((marker) => snippet.includes(marker))) {
      return "blocked";
    }
  }
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "ok";
}

/**
 * Resolve a `Location` against the page URL and put the result through the
 * URL policy before handing it on.
 *
 * A `Location` is attacker-controlled text: `javascript:alert(1)`, `data:…`
 * and `file:///etc/passwd` are all *absolute URLs*, so resolving alone
 * launders them into a field the crawl loop persists and the report layer is
 * apt to render as an href. Anything the policy refuses is dropped, and the
 * drop is stated in `droppedReason` rather than looking like a 3xx that
 * simply had no target.
 *
 * The fact of the redirect stays true regardless: the caller keeps
 * `fetchClass: "redirect"` and the status code, and only loses something to
 * enqueue.
 *
 * Uses `isUrlAllowed`, not `isCrawlableUrl`, for one reason: it is the only
 * one of the two that honours `allowPrivate`, so a loopback fixture server's
 * own redirects still resolve under test. The policy applied is otherwise the
 * same, and it is the same seam the pre-flight check uses.
 */
async function resolveRedirectTarget(
  location: string | null,
  pageUrl: string,
  allowPrivate: boolean,
  maxUrlLength: number | undefined,
): Promise<{ redirectUrl: string | null; droppedReason: string | null }> {
  if (location === null) {
    return { redirectUrl: null, droppedReason: "3xx without a Location header" };
  }

  let resolved: string;
  try {
    resolved = new URL(location, pageUrl).href;
  } catch {
    return {
      redirectUrl: null,
      droppedReason: `unresolvable Location header (${location})`,
    };
  }

  const verdict = await isUrlAllowed(resolved, { allowPrivate, maxUrlLength });
  if (verdict.allowed) return { redirectUrl: resolved, droppedReason: null };
  return {
    redirectUrl: null,
    droppedReason: `redirect target refused: ${verdict.reason}`,
  };
}

function emptyResult(
  url: string,
  fetchClass: FetchClass,
  responseTimeMs: number,
  disallowedReason: string | null = null,
  responseHeaders: StoredResponseHeaders | null = null,
): FetchResult {
  return {
    url,
    statusCode: null,
    fetchClass,
    contentType: null,
    redirectUrl: null,
    body: null,
    htmlBytes: 0,
    responseTimeMs,
    // Nothing was read, so nothing was asked of us. A timeout is not a throttle
    // with an unstated interval.
    retryAfterMs: null,
    canonicalHeader: null,
    xRobotsTag: null,
    platformHint: null,
    responseHeaders,
    headerHreflang: [],
    disallowedReason,
  };
}

/**
 * The request headers every page fetch sends — one definition, read by
 * `fetchPage` and recorded (redacted) on the crawl row.
 */
export function pageRequestHeaders(userAgent: string): Record<string, string> {
  return {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    // undici's `request` does not decode transport encodings (unlike
    // `fetch`), so asking for gzip means we own the inflating — see
    // readCappedDecoded, which is also why only gzip is offered. Worth
    // owning: HTML compresses 4-6x, and a crawl that refuses compression
    // is four times the bandwidth on someone else's origin (rule 9).
    "accept-encoding": ACCEPT_ENCODING,
  };
}

/**
 * Fetch one URL and classify the result.
 *
 * Classification precedence, in order, so the reason a row carries is the
 * most specific true thing about it:
 *   disallowed -> redirect (3xx) -> status (blocked / 4xx / 5xx) ->
 *   non_html -> too_large -> unsupported_encoding -> ok
 * A 500 with a 5MB html body is `server_error`, not `too_large`: the status
 * is why the page is unusable. A 200 pdf is `non_html` whatever its size,
 * because we never wanted its bytes. A 503 we could not decode stays a 503.
 *
 * `timeout` and `network_error` are outside that order: they are what happens
 * when there is no response to classify at all.
 *
 * `body` is populated only for `ok`. Every other class has a body that is
 * either absent, unusable, or not worth carrying into the rule engine.
 */
export async function fetchPage(url: string, opts: FetchOpts): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPrivate = opts.allowPrivate === true;
  const started = Date.now();
  const callerSignal = opts.signal;
  if (callerSignal?.aborted) throw new FetchAbortedError(url);

  const verdict = await isUrlAllowed(url, { allowPrivate, maxUrlLength: opts.maxUrlLength });
  if (!verdict.allowed) {
    return emptyResult(url, "disallowed", Date.now() - started, verdict.reason);
  }

  // A caller-supplied resolver cannot share a pooled connector, so it gets an
  // agent of its own that is destroyed with the request.
  const ephemeral =
    opts.lookup === undefined ? null : newAgent(allowPrivate, opts.lookup);
  const dispatcher = ephemeral ?? sharedAgent(allowPrivate);

  // One deadline over the whole operation — connect, headers and body. undici's
  // own timeouts are per-phase, so a server that dribbles a byte every second
  // would satisfy bodyTimeout forever without this.
  const deadline = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    deadline.abort();
  }, timeoutMs);
  const requestSignal =
    callerSignal === undefined
      ? deadline.signal
      : AbortSignal.any([deadline.signal, callerSignal]);

  // Captured the moment response headers arrive, so the catch path can keep
  // them when the body then fails (a deadline expiring mid-body).
  let responseHeaders: StoredResponseHeaders | null = null;

  try {
    const response = await request(url, {
      dispatcher,
      method: "GET",
      // The credential headers first and the engine's after: the refused
      // names (`credentialError`) already keep them apart, and the engine's
      // identity wins regardless (rule 9).
      headers: {
        ...credentialHeadersOf(url, opts.credentials),
        ...pageRequestHeaders(opts.userAgent),
      },
      // Manual redirects: a 3xx is its own row and the crawl loop enqueues the
      // target (which re-enters url-policy on the way in), so chains and loops
      // are visible in the recorded rows instead of collapsed by the client.
      // undici follows nothing unless a redirect interceptor is installed on
      // the dispatcher, and ours has none — see newAgent.
      signal: requestSignal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const responseTimeMs = Date.now() - started;
    const headers = response.headers as HeaderBag;
    responseHeaders = captureResponseHeaders(headers);
    const statusCode = response.statusCode;
    const contentType = headerValue(headers, "content-type");
    const xRobotsTag = headerValue(headers, "x-robots-tag");
    // Parsed once, from the full header values (repeated `Link` fields arrive
    // as an array), for both the canonical and the hreflang pairs.
    const link = parseLinkHeader(headerValues(headers, "link")).entries;
    const canonicalHeader = canonicalOf(link);
    const headerHreflang = hreflangOf(link);
    const platformHint = detectPlatform(headers);
    const mime = mimeType(contentType);
    const isHtml = mime !== null && HTML_MIME_TYPES.has(mime);
    const isRedirect = statusCode >= 300 && statusCode < 400;

    // 503 is the one status whose verdict depends on the body, so everything
    // else can be classified from the status line and headers alone.
    const statusClass = classifyStatus(statusCode, headers, "");
    // Hold bytes only when they can still change the answer or be returned:
    // a 503's challenge markers, or html on an otherwise-ok response. A 403
    // challenge page and a 404's html are drained and dropped, not buffered.
    const keepBody =
      !isRedirect && (statusCode === 503 || (isHtml && statusClass === "ok"));
    const read = await readCappedDecoded(
      response.body,
      headerValue(headers, "content-encoding"),
      MAX_BODY,
      keepBody,
    );

    if (isRedirect) {
      const target = await resolveRedirectTarget(
        headerValue(headers, "location"),
        url,
        allowPrivate,
        opts.maxUrlLength,
      );
      return {
        url,
        statusCode,
        fetchClass: "redirect",
        contentType,
        redirectUrl: target.redirectUrl,
        body: null,
        htmlBytes: read.bytes,
        responseTimeMs,
        retryAfterMs: null, // a 3xx is an answer, not a throttle
        canonicalHeader,
        xRobotsTag,
        platformHint,
        responseHeaders,
        headerHreflang,
        disallowedReason: target.droppedReason,
      };
    }

    let fetchClass = statusClass;
    if (statusCode === 503 && read.buffer !== null) {
      const snippet = decodeBody(
        read.buffer.subarray(0, CHALLENGE_SNIPPET_BYTES),
        contentType,
      );
      fetchClass = classifyStatus(statusCode, headers, snippet);
    }
    if (fetchClass === "ok" && !isHtml) fetchClass = "non_html";
    // Decompressed, not wire: a 40KB body that inflates past MAX_BODY is a
    // `too_large` row with no body, never a page row holding the first 2MiB of
    // it. Precedence is unchanged — the status still wins, so a 500 with a
    // 5MB body is `server_error`.
    if (fetchClass === "ok" && read.truncated) fetchClass = "too_large";
    // A 200 whose bytes we cannot decode is a page we did not get. Its own
    // class, not `network_error`: the failure is deterministic, so it must not
    // land in loop's retry bucket. Say which coding defeated us rather than
    // recording an empty page (rule 7). A non-`ok` class keeps its own, more
    // specific verdict: a 503 we could not decode is still a 503, we simply
    // could not check it for challenge markers.
    if (fetchClass === "ok" && read.unsupportedEncoding !== null) {
      fetchClass = "unsupported_encoding";
    }

    // The throttle's own answer to "when may we come back". Read only once the
    // class is settled, because the class is what decides whether the header is
    // an instruction or noise (see isThrottle).
    const retryAfter = isThrottle(fetchClass, statusCode)
      ? parseRetryAfter(headerValue(headers, "retry-after"))
      : { ms: null, note: null };

    return {
      url,
      statusCode,
      fetchClass,
      contentType,
      redirectUrl: null,
      body:
        fetchClass === "ok" && read.buffer !== null
          ? decodeBody(read.buffer, contentType)
          : null,
      htmlBytes: read.bytes,
      responseTimeMs,
      retryAfterMs: retryAfter.ms,
      canonicalHeader,
      xRobotsTag,
      platformHint,
      responseHeaders,
      headerHreflang,
      // Two reasons can want this field, and they never co-occur: an
      // unsupported coding is an `ok`-turned-`unsupported_encoding`, a refused
      // Retry-After is a throttle. The coding wins if that ever changes,
      // because it is why the row has no body at all.
      disallowedReason:
        read.unsupportedEncoding !== null
          ? `unsupported content-encoding (${read.unsupportedEncoding})`
          : retryAfter.note,
    };
  } catch (error) {
    // The caller's abort wins over every classification, including a deadline
    // that fired in the same tick: nothing aborted is ever written as a row.
    if (callerSignal?.aborted) throw new FetchAbortedError(url);
    // Our bug, not theirs — surface it loudly instead of burying it in a
    // classified row. This is the only path out of fetchPage that throws.
    if (isProgrammerError(error)) throw error;

    const responseTimeMs = Date.now() - started;
    const refusal = blockedAddressMessage(error);
    if (refusal !== null) {
      return emptyResult(url, "disallowed", responseTimeMs, refusal);
    }
    if (deadlineHit || isTimeout(error)) {
      return emptyResult(url, "timeout", responseTimeMs, null, responseHeaders);
    }
    // Also where a body that claimed `content-encoding: gzip` and was not gzip
    // lands (zlib Z_DATA_ERROR / Z_BUF_ERROR out of readCappedDecoded): the
    // response was unreadable, which is a failed fetch and not an empty page.
    return emptyResult(url, "network_error", responseTimeMs, null, responseHeaders);
  } finally {
    clearTimeout(timer);
    if (ephemeral !== null) await ephemeral.destroy();
  }
}

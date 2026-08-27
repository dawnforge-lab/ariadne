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
 * is its own row, a 1MiB body cap (spent on decompressed bytes — see
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
import {
  ACCEPT_ENCODING,
  blockedAddressMessage,
  decodeBody,
  headerValue,
  isProgrammerError,
  isTimeout,
  mimeType,
  newAgent,
  readCappedDecoded,
  sharedAgent,
  type DnsLookupFn,
  type HeaderBag,
} from "./http.js";

/**
 * The body cap, spent on **decompressed** bytes (see readCappedDecoded). It
 * bounds the wire read too, because the reader stops inflating and destroys
 * the socket the moment the cap is reached — a compressed body can therefore
 * never cost more than ~1MiB of transfer either.
 */
const MAX_BODY = 1024 * 1024;
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
 */
export type FetchClass =
  | "ok"
  | "redirect"
  | "client_error"
  | "server_error"
  | "blocked"
  | "timeout"
  | "network_error"
  | "non_html"
  | "too_large"
  /**
   * The response carried a `content-encoding` we do not implement, so its
   * bytes are unreadable to us. Distinct from `network_error` because it is
   * DETERMINISTIC: the same request gets the same undecodable answer, so it
   * must stay out of the retry bucket (see loop's TRANSIENT). Some CDNs ignore
   * `accept-encoding` and answer `br` regardless; three fetches of that is
   * three times the rudeness for the same non-answer (rule 9).
   */
  | "unsupported_encoding"
  | "disallowed";

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
  /** Decoded html text, ≤ 1MiB; null for every class except `ok`. */
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
  /** From `Link: <...>; rel="canonical"`, verbatim (not normalised). */
  canonicalHeader: string | null;
  xRobotsTag: string | null;
  /**
   * Why this row has no usable body or target, in plain words. Set on
   * `disallowed` (the URL or the address it resolved to), on `redirect` when
   * the Location was dropped rather than passed on, and on
   * `unsupported_encoding` (naming the coding we could not read). Null
   * otherwise.
   *
   * **This is persisted**, as `pages.fetch_reason` — the class alone is not an
   * explanation, and a reason that lived only in this object would be an
   * argument about transparency that was false the moment the row was written
   * (hard rule 7). Anything put here reaches an operator's report, so it is
   * built from the response and the URL policy only: never a stack trace,
   * never a local path.
   *
   * The name is now narrower than the job — it predates the other two uses —
   * but renaming it ripples through `persist`, the column and the rule layer
   * for no behavioural gain.
   */
  disallowedReason: string | null;
}

export interface FetchOpts {
  userAgent: string;
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
   * TEST ONLY. Replaces `dns.lookup` under the connect-time guard, so the
   * SSRF tests can pin a hostname to an address without touching the network.
   * Supplying it also opts out of the shared connection pool.
   */
  lookup?: DnsLookupFn;
}

/**
 * `Link: <https://ex.com/c>; rel="canonical", <...>; rel="next"` -> the
 * canonical target, verbatim. Normalisation is the analyzer's job, not ours.
 */
export function parseCanonicalLinkHeader(value: string | null): string | null {
  if (value === null) return null;
  for (const part of value.split(",")) {
    const match = part.match(/<([^>]+)>\s*;([^]*)/);
    if (match === null) continue;
    if (/rel\s*=\s*"?canonical"?/i.test(match[2] ?? "")) {
      return (match[1] ?? "").trim() || null;
    }
  }
  return null;
}

/**
 * Status/header classification, OpenSEO's table.
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
function classifyStatus(
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

  const verdict = await isUrlAllowed(resolved, { allowPrivate });
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
    canonicalHeader: null,
    xRobotsTag: null,
    disallowedReason,
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

  const verdict = await isUrlAllowed(url, { allowPrivate });
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

  try {
    const response = await request(url, {
      dispatcher,
      method: "GET",
      headers: {
        "user-agent": opts.userAgent,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        // undici's `request` does not decode transport encodings (unlike
        // `fetch`), so asking for gzip means we own the inflating — see
        // readCappedDecoded, which is also why only gzip is offered. Worth
        // owning: HTML compresses 4-6x, and a crawl that refuses compression
        // is four times the bandwidth on someone else's origin (rule 9).
        "accept-encoding": ACCEPT_ENCODING,
      },
      // Manual redirects: a 3xx is its own row and the crawl loop enqueues the
      // target (which re-enters url-policy on the way in), so chains and loops
      // are visible in the recorded rows instead of collapsed by the client.
      // undici follows nothing unless a redirect interceptor is installed on
      // the dispatcher, and ours has none — see newAgent.
      signal: deadline.signal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const responseTimeMs = Date.now() - started;
    const headers = response.headers as HeaderBag;
    const statusCode = response.statusCode;
    const contentType = headerValue(headers, "content-type");
    const xRobotsTag = headerValue(headers, "x-robots-tag");
    const canonicalHeader = parseCanonicalLinkHeader(headerValue(headers, "link"));
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
        canonicalHeader,
        xRobotsTag,
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
    // `too_large` row with no body, never a page row holding the first MiB of
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
      canonicalHeader,
      xRobotsTag,
      disallowedReason:
        read.unsupportedEncoding === null
          ? null
          : `unsupported content-encoding (${read.unsupportedEncoding})`,
    };
  } catch (error) {
    // Our bug, not theirs — surface it loudly instead of burying it in a
    // classified row. This is the only path out of fetchPage that throws.
    if (isProgrammerError(error)) throw error;

    const responseTimeMs = Date.now() - started;
    const refusal = blockedAddressMessage(error);
    if (refusal !== null) {
      return emptyResult(url, "disallowed", responseTimeMs, refusal);
    }
    if (deadlineHit || isTimeout(error)) {
      return emptyResult(url, "timeout", responseTimeMs);
    }
    // Also where a body that claimed `content-encoding: gzip` and was not gzip
    // lands (zlib Z_DATA_ERROR / Z_BUF_ERROR out of readCappedDecoded): the
    // response was unreadable, which is a failed fetch and not an empty page.
    return emptyResult(url, "network_error", responseTimeMs);
  } finally {
    clearTimeout(timer);
    if (ephemeral !== null) await ephemeral.destroy();
  }
}

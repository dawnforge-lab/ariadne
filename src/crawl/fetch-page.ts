/**
 * The single fetch primitive the crawl loop uses. One URL in, one classified
 * result out — nothing here throws for a target-site problem: a refusal, a
 * timeout, a reset connection and a 2MB body are all classified rows, never
 * exceptions (build plan rule 7, "no silent fallbacks" cuts both ways — an
 * error must be visible *and* recorded, not swallowed and not thrown past the
 * loop).
 *
 * Fetch semantics are OpenSEO's decisions (site-audit-workflow-helpers.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070), read as reference and
 * re-implemented over undici rather than lifted: manual redirects so every hop
 * is its own row, a 1MiB body cap, and the bot-challenge classification table.
 * Divergences from that table are marked "CHANGED" at their line.
 */
import { lookup as systemLookup, type LookupOptions } from "node:dns";
import { Agent, request } from "undici";
import { blockedAddressReason, isUrlAllowed } from "./url-policy.js";

const MAX_BODY = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * A constant, not the caller's `timeoutMs`, because it is baked into the
 * shared pool's connector. The per-request deadline still bounds a slow
 * connect: aborting the request aborts the connect attempt with it.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** How much of the body the challenge markers are searched in. */
const CHALLENGE_SNIPPET_BYTES = 4_000;

/** Error code the socket lookup hook stamps on a connect-time refusal. */
const BLOCKED_ADDRESS_CODE = "ARIADNE_BLOCKED_ADDRESS";

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
  | "disallowed";

export interface FetchResult {
  url: string;
  statusCode: number | null;
  fetchClass: FetchClass;
  contentType: string | null;
  /** Absolute, resolved against url; null unless 3xx with a usable Location. */
  redirectUrl: string | null;
  /** Decoded html text, ≤ 1MiB; null for every class except `ok`. */
  body: string | null;
  /** Body bytes actually received, capped at MAX_BODY. */
  htmlBytes: number;
  /** Time to response headers, not to the last body byte. */
  responseTimeMs: number;
  /** From `Link: <...>; rel="canonical"`, verbatim (not normalised). */
  canonicalHeader: string | null;
  xRobotsTag: string | null;
  /** Why the URL or its resolved address was refused; null unless disallowed. */
  disallowedReason: string | null;
}

export interface LookupAddress {
  address: string;
  family: number;
}

/**
 * Node's shape exactly: on the error path the address argument is ignored, so
 * callers pass `""` rather than making the parameter optional (an optional
 * parameter makes this type unassignable to `net.LookupFunction`).
 */
export type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addressOrAddresses: string | LookupAddress[],
  family?: number,
) => void;

/** The `dns.lookup` shape `net.connect` expects. */
export type DnsLookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: DnsLookupCallback,
) => void;

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
 * Wraps a resolver so every address it returns is policy-checked *before*
 * `net.connect` opens the socket. This is the wall url-policy's facade is not:
 * a public hostname with a private A record (metadata.goog -> 169.254.169.254)
 * passes the string-level check and dies here instead. Because the check sits
 * on the same resolution the socket then uses, it also closes the DNS-rebind
 * window — there is no second lookup between verdict and connect.
 *
 * Refusal is "any", not "all": one blocked answer among several refuses the
 * host, matching url-policy's mixed-answer rule.
 */
function guardedLookup(base: DnsLookupFn, allowPrivate: boolean): DnsLookupFn {
  return (hostname, options, callback) => {
    // Always ask for every answer: checking only the address net.connect
    // happens to pick would leave the others unexamined on a retry.
    base(hostname, { ...options, all: true }, (err, result) => {
      if (err) {
        callback(err, "");
        return;
      }
      const addresses = Array.isArray(result) ? result : [];
      if (addresses.length === 0) {
        const empty: NodeJS.ErrnoException = new Error(
          `no addresses resolved for ${hostname}`,
        );
        empty.code = "ENOTFOUND";
        callback(empty, "");
        return;
      }

      for (const entry of addresses) {
        const reason = blockedAddressReason(entry.address, { allowPrivate });
        if (reason !== null) {
          const refusal: NodeJS.ErrnoException = new Error(
            `${hostname} resolves to ${entry.address}: ${reason}`,
          );
          refusal.code = BLOCKED_ADDRESS_CODE;
          callback(refusal, "");
          return;
        }
      }

      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      // Guaranteed present by the length check above; reported as a failed
      // lookup rather than thrown, because a throw inside a dns callback is an
      // uncaught exception, not a classified fetch.
      const first = addresses[0];
      if (first === undefined) {
        const missing: NodeJS.ErrnoException = new Error(
          `no usable address for ${hostname}`,
        );
        missing.code = "ENOTFOUND";
        callback(missing, "");
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

function newAgent(allowPrivate: boolean, base: DnsLookupFn): Agent {
  // undici forwards its `connect` options to net.connect / tls.connect, which
  // is how the guarded resolver reaches the socket.
  return new Agent({
    connect: {
      timeout: CONNECT_TIMEOUT_MS,
      lookup: guardedLookup(base, allowPrivate),
    },
  });
}

/**
 * Exactly two shared pools, one per address policy, so keep-alive survives
 * between fetches and the connection count stays O(concurrency) rather than
 * O(URLs). Nothing per-request is baked into a pool — that is why the connect
 * timeout is a constant and the caller's `timeoutMs` is enforced per request
 * instead. A caller-supplied `lookup` gets a throwaway agent (tests only),
 * because the resolver *is* baked into the connector.
 */
const sharedAgents = new Map<string, Agent>();

function sharedAgent(allowPrivate: boolean): Agent {
  const key = allowPrivate ? "private" : "public";
  const existing = sharedAgents.get(key);
  if (existing !== undefined) return existing;
  const created = newAgent(allowPrivate, systemLookup as DnsLookupFn);
  sharedAgents.set(key, created);
  return created;
}

/** Closes the shared pools. For process shutdown and test teardown. */
export async function closeFetchAgents(): Promise<void> {
  const agents = [...sharedAgents.values()];
  sharedAgents.clear();
  await Promise.all(agents.map((agent) => agent.close()));
}

type HeaderBag = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderBag, name: string): string | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? raw.join(", ") : raw;
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

function mimeType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const value = contentType.split(";")[0]?.trim().toLowerCase();
  return value === undefined || value === "" ? null : value;
}

function charsetOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = contentType.match(/;\s*charset\s*=\s*"?([^";]+)"?/i);
  return match === null ? null : (match[1] ?? "").trim() || null;
}

/**
 * Decode with the declared charset, defaulting to utf-8.
 *
 * Two deliberate non-fatal paths, neither of them a hidden error: a charset
 * label Node's ICU does not know (`charset=not-a-real-charset`) decodes as
 * utf-8, and bytes that are malformed in the chosen encoding become U+FFFD
 * rather than throwing. Both are what a browser does, and both keep the page
 * classified on its HTTP facts. A page whose bytes we cannot read is still a
 * page the rules should see; throwing here would turn a target-site defect
 * into a crawler crash.
 */
function decodeBody(bytes: Buffer, contentType: string | null): string {
  const label = charsetOf(contentType) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

interface CappedBody {
  bytes: number;
  buffer: Buffer | null;
  truncated: boolean;
}

/**
 * Read at most `MAX_BODY` bytes. Under the cap the stream is drained to the
 * end so the socket returns to the pool; over it, the stream is destroyed,
 * which aborts the request — we will not pay for the rest of a 2GB response.
 * `keep` is false when the caller has already decided to discard the body
 * (non-HTML, redirects): the bytes are still counted and drained, never held.
 */
async function readCapped(
  body: AsyncIterable<Buffer> & { destroy: (error?: Error) => void },
  keep: boolean,
): Promise<CappedBody> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  for await (const chunk of body) {
    const remaining = MAX_BODY - bytes;
    if (chunk.byteLength > remaining) {
      if (keep && remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes = MAX_BODY;
      truncated = true;
      break;
    }
    if (keep) chunks.push(chunk);
    bytes += chunk.byteLength;
  }

  if (truncated) body.destroy();
  return {
    bytes,
    buffer: keep ? Buffer.concat(chunks) : null,
    truncated,
  };
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

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** The connect-time refusal message, if this error is one. */
function blockedAddressMessage(error: unknown): string | null {
  for (const link of errorChain(error)) {
    if (errorCode(link) === BLOCKED_ADDRESS_CODE) {
      return link instanceof Error ? link.message : String(link);
    }
  }
  return null;
}

const TIMEOUT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
]);

function isTimeout(error: unknown): boolean {
  return errorChain(error).some((link) => {
    const code = errorCode(link);
    return code !== null && TIMEOUT_CODES.has(code);
  });
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
 *   non_html -> too_large -> ok
 * A 500 with a 5MB html body is `server_error`, not `too_large`: the status
 * is why the page is unusable. A 200 pdf is `non_html` whatever its size,
 * because we never wanted its bytes.
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
    const read = await readCapped(response.body, keepBody);

    if (isRedirect) {
      const location = headerValue(headers, "location");
      let redirectUrl: string | null = null;
      if (location !== null) {
        try {
          redirectUrl = new URL(location, url).href;
        } catch {
          // A Location we cannot resolve is a defect on the target's side; the
          // row still records the hop, with nothing to enqueue.
          redirectUrl = null;
        }
      }
      return {
        url,
        statusCode,
        fetchClass: "redirect",
        contentType,
        redirectUrl,
        body: null,
        htmlBytes: read.bytes,
        responseTimeMs,
        canonicalHeader,
        xRobotsTag,
        disallowedReason: null,
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
    if (fetchClass === "ok" && read.truncated) fetchClass = "too_large";

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
      disallowedReason: null,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - started;
    const refusal = blockedAddressMessage(error);
    if (refusal !== null) {
      return emptyResult(url, "disallowed", responseTimeMs, refusal);
    }
    if (deadlineHit || isTimeout(error)) {
      return emptyResult(url, "timeout", responseTimeMs);
    }
    return emptyResult(url, "network_error", responseTimeMs);
  } finally {
    clearTimeout(timer);
    if (ephemeral !== null) await ephemeral.destroy();
  }
}

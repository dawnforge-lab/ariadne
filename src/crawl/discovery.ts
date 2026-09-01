/**
 * Discovery: the two documents a crawl reads before it reads any page —
 * robots.txt and the sitemap tree it points at.
 *
 * These are not HTML pages, so `fetchPage` is the wrong primitive (its 1MiB
 * cap, HTML mime gate and challenge table are all about pages). They are
 * network I/O like any other, though, so they share fetch-page's discipline
 * through `./http`: the same connection pools, the same connect-time address
 * guard (a public hostname whose A record points at 169.254.169.254 dies at
 * the socket, in discovery exactly as in a page fetch), the same capped
 * streaming read, and the same rule that a target-site problem is recorded,
 * never thrown.
 *
 * `discover` returns facts — the parsed robots rules, the sitemap URLs, and an
 * honest account of everything it could not read. Persisting sitemap entries
 * to `sitemap_urls` is the crawl loop's job.
 *
 * Two things it does decide, because they are politeness and both bite before
 * the crawl loop exists (build plan rule 9):
 *  - An *unreachable* robots.txt (5xx, timeout, network error, refused URL —
 *    as opposed to an absent one, which is a 4xx and normal) is retried, and
 *    then means complete disallow, per RFC 9309 §2.3.1.4. A site whose server
 *    is erroring does not get crawled on the assumption it would have let us.
 *  - The crawl-delay it just parsed is applied to its own sitemap walk. Having
 *    read `Crawl-delay: 10` and then fetched 300 shards back-to-back would be
 *    the yellow.com.mt incident with extra steps.
 *
 * Caps (RFC 9309 for robots, the sitemaps.org protocol and Google's published
 * limits for the rest):
 *  - robots.txt: 500KB read, the remainder ignored — Google's documented
 *    behaviour. A robots.txt this big is already pathological; refusing it
 *    outright would be *less* polite than honouring the part we read.
 *  - sitemap document: 10MB, on the DECOMPRESSED bytes. Over the cap the
 *    document is skipped whole, never half-parsed: half a sitemap looks
 *    exactly like a complete one, and would quietly under-report coverage.
 *  - sitemap index recursion: 3 levels below the first document.
 *  - 300 documents per crawl, and a cap on the entries kept in memory (the
 *    memory contract is RAM O(concurrency), and 300 × 50k entries is not).
 * Every cap that bites is counted in `truncation`; none of them is silent.
 *
 * The byte caps bound what arrives on the wire, which is not the same as
 * bounding what a parser can make of it — so a sitemap carrying a `<!DOCTYPE`
 * is refused before it reaches the XML parser. See parseSitemapDoc.
 */
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import robotsParserImport from "robots-parser";
import { request } from "undici";
import { isUrlAllowed } from "./url-policy.js";
import { isSameOrigin, normalizeUrl, onRulesOrigin } from "./parse/url-utils.js";
import {
  blockedAddressMessage,
  decodeBody,
  describeError,
  headerValue,
  isProgrammerError,
  isTimeout,
  readCapped,
  sharedAgent,
  type HeaderBag,
} from "./http.js";

const gunzip = promisify(gunzipCallback);

/** The subset of robots-parser's surface we use. */
interface RobotsRules {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

/**
 * robots-parser is CommonJS (`module.exports = fn`) with an ESM-shaped
 * `.d.ts` (`export default fn`). Under NodeNext without esModuleInterop, TS
 * types the default import as the module namespace object, which is not
 * callable — while the value Node's CJS/ESM interop actually binds *is* the
 * function. One cast at the seam, with the upstream signature restated, so
 * the rest of the file stays typed rather than leaking `any`.
 */
const robotsParser = robotsParserImport as unknown as (
  robotsUrl: string,
  contents: string,
) => RobotsRules;

const ROBOTS_MAX_BYTES = 500 * 1024;
const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_DOCS = 300;

/**
 * The one cap the brief does not name, and the reason it exists: the sitemap
 * protocol allows 50,000 URLs per document, so 300 documents is 15 million
 * entries — gigabytes of strings held at once, which breaks the memory
 * contract long before the crawl starts. Overridable per call so the crawl
 * loop can raise it deliberately once entries stream to the database.
 */
const MAX_SITEMAP_ENTRIES = 200_000;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECT_HOPS = 5;

/**
 * A robots.txt that is *unreachable* rather than absent gets three tries with
 * a short linear backoff before we conclude the origin cannot tell us its
 * rules. Three is enough to ride out a restart or a blip without becoming a
 * load test on a server that is already failing.
 */
const ROBOTS_ATTEMPTS = 3;
const ROBOTS_RETRY_BACKOFF_MS = 250;

/**
 * The pacing an origin gets when its robots.txt is unreachable and the caller
 * has opted into crawling anyway: never `null`. We are about to crawl a server
 * that just failed to serve a 60-byte text file, so it gets the delay it never
 * got to ask for.
 */
const UNREACHABLE_CRAWL_DELAY_SEC = 5;

/**
 * The ceiling on an honoured `Crawl-delay`, matching the ceiling the crawl
 * loop's governor will apply. A site asking for 3600 seconds between requests
 * is asking us not to crawl it at all, which is a decision for the operator
 * who scheduled the audit, not something discovery should silently sit out.
 */
const MAX_CRAWL_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** gzip's two magic bytes. Trusted over the headers — see decompress. */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * The three outcomes of asking for robots.txt, which RFC 9309 treats very
 * differently and which must never collapse into one another:
 *  - `read`       — 2xx, parsed. The site's rules apply.
 *  - `absent`     — 4xx. The site says there are no rules: allow all. Normal.
 *  - `unreachable` — 5xx, timeout, network error, or a URL the policy refused,
 *    after retries. The site could not tell us its rules, which is *not* the
 *    same as telling us there are none. §2.3.1.4: complete disallow.
 *
 * A LIST RATHER THAN A BARE UNION, and the type is derived from it, for the
 * reason `FETCH_CLASSES` and `DISCOVERED_VIA` are: the value crosses into a
 * jsonb column and comes back as `unknown`, so the API validates it at read
 * time (`ApiService.parseRobots`) and therefore needs the vocabulary at
 * RUNTIME. A hand-kept second copy of these three would drift the moment a
 * fourth outcome was added here — and it would drift silently in the worst
 * direction: every new crawl's stored evidence would then fail validation, so
 * `robots_get` and the render path would refuse crawls that are perfectly
 * sound. One list, one type, no copy.
 */
export const ROBOTS_OUTCOMES = ["read", "absent", "unreachable"] as const;

export type RobotsOutcome = (typeof ROBOTS_OUTCOMES)[number];

export interface RobotsInfo {
  /** True only when a robots.txt was fetched and parsed. */
  fetched: boolean;
  /**
   * Which of the three outcomes this was. The discriminant to branch on;
   * `status` stays a numeric HTTP status (and is null when there was no
   * response at all) so it can be stored and compared as one.
   */
  outcome: RobotsOutcome;
  /** The HTTP status, when we got one. */
  status: number | null;
  /** How many times robots.txt was requested (>1 only after a retry). */
  attempts: number;
  /**
   * True when no rule forbids this URL. Allow-all when robots.txt is absent;
   * deny-all when it is unreachable and the caller has not opted out (see
   * DiscoveryOpts.onUnreachableRobots).
   *
   * A URL on a same-site origin variant (www <-> apex, http <-> https) is
   * judged by the rules as if it were written on the origin robots.txt was
   * read from — `isSameOrigin` admits those spellings into the crawl, so they
   * must not escape its rules. See onRulesOrigin.
   */
  isAllowed(url: string): boolean;
  crawlDelaySec: number | null;
  sitemapUrls: string[];
  raw: string | null;
  /** True when robots.txt was longer than the 500KB read cap. */
  truncated: boolean;
  /**
   * Why the rules are what they are, in plain words: a 404, a network error, a
   * refused URL, and what we did about it. Null when robots.txt was read. A
   * site with no robots.txt is normal and is not an error — but "we are
   * crawling allow-all because it 404s" and "we are refusing to crawl because
   * it 503s" are both facts the caller must be able to see and report, which
   * is why this is a field and not a log line.
   */
  note: string | null;
}

export interface SitemapEntry {
  url: string;
  /** The sitemap document this entry was read from. */
  source: string;
  lastmod: string | null;
}

export interface DiscoveryTruncation {
  /** Documents fetched and then dropped whole for exceeding the size cap. */
  oversizedDocsSkipped: number;
  /**
   * Documents we attempted: fetched, refused by the URL policy, or failed.
   * Every sitemap that was pointed at and not parsed is either counted here
   * and described in `failures`, or excluded by a cap flagged below.
   */
  docsFetched: number;
  /** A sitemap index pointed deeper than MAX_SITEMAP_DEPTH. */
  depthLimited: boolean;
  depthLimitedDocs: number;
  /** The 300-document cap stopped the walk with documents still queued. */
  docLimited: boolean;
  /** The entry cap stopped collection. */
  entryLimited: boolean;
  /** `<loc>` values that were empty, unparseable, or refused by the policy. */
  malformedEntriesSkipped: number;
  /** One line per document that was pointed at and could not be read. */
  failures: { url: string; reason: string }[];
}

export interface DiscoveryResult {
  robots: RobotsInfo;
  /** Deduped by url, first source wins. */
  sitemapEntries: SitemapEntry[];
  truncation: DiscoveryTruncation;
}

export interface DiscoveryOpts {
  userAgent: string;
  /**
   * Sitemaps to walk in addition to the ones robots.txt declares — documents
   * somebody NAMED (the site's owner, through the operator or the agent that
   * started the crawl), never documents this engine guessed at. See `discover`
   * on why the difference is the whole of the policy.
   *
   * They are merged with the declared ones and deduplicated on the normalised
   * spelling, first mention winning, so a client who supplies a sitemap the
   * site already declares costs the origin one request rather than two.
   * WHICH list a document came from is not recorded here: `discover` returns
   * facts about the walk, and the two lists are the caller's own — the crawl
   * loop writes both into `crawls.discovery_jsonb` (see `discoveryEvidence`).
   */
  extraSitemaps?: string[];
  /** Per-document deadline: connect, headers and body together. */
  timeoutMs?: number;
  /** Overrides the in-memory entry cap. See MAX_SITEMAP_ENTRIES. */
  maxEntries?: number;
  /**
   * What an *unreachable* robots.txt means (5xx, timeout, network error,
   * refused URL — never a 4xx, which is an absent robots.txt and always means
   * allow-all). Defaults to "disallow", which is RFC 9309 §2.3.1.4 and what a
   * polite crawler does. "allow" is a deliberate operator escape hatch — for
   * an audit of a site whose robots.txt is known-broken — and it is not free:
   * the origin gets UNREACHABLE_CRAWL_DELAY_SEC of pacing rather than none.
   */
  onUnreachableRobots?: "disallow" | "allow";
  /**
   * Ceiling on the honoured crawl-delay, default MAX_CRAWL_DELAY_MS. 0 turns
   * pacing off, which only the test suite has any business doing.
   */
  maxCrawlDelayMs?: number;
  /** Backoff between robots.txt retries. Lowered by tests. */
  retryBackoffMs?: number;
  /**
   * TEST ONLY. Relaxes the URL check and the connect-time address re-check to
   * the same floor as fetch-page's, so the suite can read a 127.0.0.1 fixture
   * server. Never wire this to config, an API field or an env var.
   */
  allowPrivate?: boolean;
}

/**
 * A robots stand-in for a robots.txt we do not have, with the reason it is
 * standing in and the verdict that reason earns.
 */
function noRobots(fields: {
  outcome: RobotsOutcome;
  allowed: boolean;
  crawlDelaySec: number | null;
  status: number | null;
  attempts: number;
  note: string;
}): RobotsInfo {
  return {
    fetched: false,
    outcome: fields.outcome,
    status: fields.status,
    attempts: fields.attempts,
    isAllowed: () => fields.allowed,
    crawlDelaySec: fields.crawlDelaySec,
    sitemapUrls: [],
    raw: null,
    truncated: false,
    note: fields.note,
  };
}

interface DocResult {
  ok: boolean;
  /** The URL the bytes actually came from, after any redirects. */
  url: string;
  status: number | null;
  body: Buffer | null;
  contentType: string | null;
  /** The document exceeded the byte cap. */
  oversized: boolean;
  /**
   * The URL policy refused this URL, or the address it resolved to. A verdict,
   * not a failure: retrying it would produce the same answer.
   */
  refused: boolean;
  /** Bytes were kept, but the document continued past the cap. */
  truncated: boolean;
  /** Why there are no bytes. Null when ok. */
  reason: string | null;
}

function failedDoc(
  url: string,
  reason: string,
  status: number | null = null,
  refused = false,
): DocResult {
  return {
    ok: false,
    url,
    status,
    body: null,
    contentType: null,
    oversized: false,
    refused,
    truncated: false,
    reason,
  };
}

/**
 * Undo gzip when the bytes are gzip, whatever the headers claim.
 *
 * The magic bytes are the authority here rather than `content-encoding`,
 * because both spellings reach us: a `.xml.gz` file served as
 * `application/gzip` with no encoding header, and an ordinary sitemap served
 * with `content-encoding: gzip` (undici's `request` does not decode transport
 * encodings — unlike `fetch` — so both arrive as gzip bytes either way).
 *
 * `maxOutputLength` is the gzip-bomb defence and the reason the cap can be
 * stated on decompressed bytes: an 11KB body that expands to 11MB fails here
 * rather than allocating 11MB. Two rounds at most, for the doubly-encoded
 * case (a .gz file that the server also gzipped in transit).
 */
async function decompress(bytes: Buffer, maxBytes: number): Promise<Buffer | "oversized"> {
  let current = bytes;
  for (let round = 0; round < 2; round++) {
    if (current[0] !== GZIP_MAGIC_0 || current[1] !== GZIP_MAGIC_1) return current;
    try {
      current = await gunzip(current, { maxOutputLength: maxBytes });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        return "oversized";
      }
      throw error;
    }
  }
  return current;
}

/**
 * GET one non-HTML document, capped and policy-checked.
 *
 * Every hop — the URL as given and every redirect target — goes through
 * `isUrlAllowed` before a socket is opened (hard rule 5), and the connect-time
 * address guard in `./http` re-checks whatever DNS actually returns. Redirects
 * are followed rather than recorded, unlike page fetches: a redirect on
 * robots.txt or a sitemap is plumbing (apex -> www, http -> https), not a fact
 * about the site's URL graph, and refusing to follow it would lose the
 * sitemap on a large share of real sites.
 */
async function fetchDoc(
  startUrl: string,
  maxBytes: number,
  keepTruncated: boolean,
  opts: DiscoveryOpts,
): Promise<DocResult> {
  const allowPrivate = opts.allowPrivate === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const verdict = await isUrlAllowed(url, { allowPrivate });
    if (!verdict.allowed) {
      return failedDoc(url, `refused by URL policy: ${verdict.reason}`, null, true);
    }

    const deadline = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      deadline.abort();
    }, timeoutMs);

    try {
      const response = await request(url, {
        dispatcher: sharedAgent(allowPrivate),
        method: "GET",
        headers: {
          "user-agent": opts.userAgent,
          accept: "text/plain,application/xml,text/xml,application/gzip;q=0.9,*/*;q=0.8",
        },
        signal: deadline.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const headers = response.headers as HeaderBag;
      const status = response.statusCode;

      if (status >= 300 && status < 400) {
        // Drain so the socket goes back to the pool, then take the hop.
        await readCapped(response.body, maxBytes, false);
        const location = headerValue(headers, "location");
        if (location === null) {
          return failedDoc(url, `HTTP ${status} without a Location header`, status);
        }
        try {
          url = new URL(location, url).href;
        } catch {
          return failedDoc(url, `unresolvable Location header (${location})`, status);
        }
        continue;
      }

      if (status < 200 || status >= 300) {
        await readCapped(response.body, maxBytes, false);
        return failedDoc(url, `HTTP ${status}`, status);
      }

      const read = await readCapped(response.body, maxBytes, true);
      if (read.truncated && !keepTruncated) {
        return {
          ok: false,
          url,
          status,
          body: null,
          contentType: headerValue(headers, "content-type"),
          oversized: true,
          refused: false,
          truncated: true,
          reason: `larger than the ${maxBytes}-byte document cap`,
        };
      }

      const raw = read.buffer ?? Buffer.alloc(0);
      const decoded = await decompress(raw, maxBytes);
      if (decoded === "oversized") {
        return {
          ok: false,
          url,
          status,
          body: null,
          contentType: headerValue(headers, "content-type"),
          oversized: true,
          refused: false,
          truncated: true,
          reason: `expands beyond the ${maxBytes}-byte document cap`,
        };
      }

      // Anything still encoded after that is an encoding we do not implement;
      // say so rather than handing the parser bytes it will read as empty.
      const encoding = headerValue(headers, "content-encoding");
      if (
        decoded === raw &&
        encoding !== null &&
        !/^\s*(identity|gzip|x-gzip)\s*$/i.test(encoding)
      ) {
        return failedDoc(url, `unsupported content-encoding (${encoding})`, status);
      }

      return {
        ok: true,
        url,
        status,
        body: decoded,
        contentType: headerValue(headers, "content-type"),
        oversized: false,
        refused: false,
        truncated: read.truncated,
        reason: null,
      };
    } catch (error) {
      // Our bug, not theirs — the same contract fetch-page keeps.
      if (isProgrammerError(error)) throw error;
      const refusal = blockedAddressMessage(error);
      if (refusal !== null) return failedDoc(url, `refused at connect: ${refusal}`, null, true);
      if (deadlineHit || isTimeout(error)) return failedDoc(url, "timed out");
      return failedDoc(url, describeError(error));
    } finally {
      clearTimeout(timer);
    }
  }

  return failedDoc(url, `more than ${MAX_REDIRECT_HOPS} redirects`);
}

/**
 * How to read a robots.txt request that produced no rules.
 *
 * `absent` is the site telling us there are none (a 4xx, RFC 9309 §2.3.1.3 —
 * "unavailable" means allow all). Everything else is the site failing to tell
 * us anything: a 5xx, a timeout, a reset, a broken redirect, a body we could
 * not decode. Those are `retry`, and become `unreachable` once the retries are
 * spent. A URL the policy refused is `unreachable` immediately — the verdict
 * is deterministic, and asking again would only be rude.
 */
function classifyRobotsFailure(doc: DocResult): "absent" | "unreachable" | "retry" {
  if (doc.refused) return "unreachable";
  if (doc.status !== null && doc.status >= 400 && doc.status < 500) return "absent";
  return "retry";
}

/**
 * Read one origin's robots.txt and turn it into rules.
 *
 * EXPORTED for the resource fetch pass (src/crawl/resources/fetch-resources.ts).
 * A crawl's pages all live on one origin, so `discover` calls this once and the
 * result rides on the crawl; a crawl's RESOURCES do not — an asset host is
 * somebody else's server, with rules of its own that no earlier phase could have
 * read. That pass calls this once per third-party host and caches the answer for
 * the crawl (bounded by its host cap), which is the same contract this function
 * has always had: one origin in, one `RobotsInfo` out, up to three requests, and
 * an unreachable robots.txt is a complete disallow rather than permission (RFC
 * 9309 §2.3.1.4). Nothing about it is specific to the origin being crawled, and
 * a second implementation of it would be a second reading of the protocol.
 */
export async function fetchRobots(
  siteUrl: string,
  opts: DiscoveryOpts,
  unreachableMode: "disallow" | "allow",
): Promise<RobotsInfo> {
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", siteUrl).href;
  } catch {
    return noRobots({
      outcome: "unreachable",
      allowed: unreachableMode === "allow",
      crawlDelaySec: UNREACHABLE_CRAWL_DELAY_SEC,
      status: null,
      attempts: 0,
      note: `unparseable site URL (${siteUrl}): robots.txt could not be requested`,
    });
  }

  const backoffMs = opts.retryBackoffMs ?? ROBOTS_RETRY_BACKOFF_MS;
  let doc = await fetchDoc(robotsUrl, ROBOTS_MAX_BYTES, true, opts);
  let attempts = 1;
  while (!doc.ok && classifyRobotsFailure(doc) === "retry" && attempts < ROBOTS_ATTEMPTS) {
    // Linear backoff, deliberately short: this is a 60-byte text file, and the
    // origin is already unhappy. Three tries, ~750ms, then we stop asking.
    await sleep(backoffMs * attempts);
    doc = await fetchDoc(robotsUrl, ROBOTS_MAX_BYTES, true, opts);
    attempts++;
  }

  if (!doc.ok || doc.body === null) {
    const reason = doc.reason ?? "no body";
    const tried = attempts === 1 ? "" : ` after ${attempts} attempts`;

    if (classifyRobotsFailure(doc) === "absent") {
      // The site answered, and the answer is "there is no robots.txt here".
      // That is a rule: allow all (RFC 9309 §2.3.1.3), and not an error.
      return noRobots({
        outcome: "absent",
        allowed: true,
        crawlDelaySec: null,
        status: doc.status,
        attempts,
        note: `robots.txt absent (${reason}): crawling allow-all`,
      });
    }

    // The site could not answer. That is not permission. RFC 9309 §2.3.1.4
    // says complete disallow, and build plan rule 9 agrees: a server that
    // cannot serve its own robots.txt is not a server to start crawling.
    // The caller can override — loudly, per-call, and never for free.
    return noRobots({
      outcome: "unreachable",
      allowed: unreachableMode === "allow",
      crawlDelaySec: UNREACHABLE_CRAWL_DELAY_SEC,
      status: doc.status,
      attempts,
      note:
        unreachableMode === "allow"
          ? `robots.txt unreachable${tried} (${reason}): crawling anyway on the caller's ` +
            `instruction, paced at ${UNREACHABLE_CRAWL_DELAY_SEC}s between requests`
          : `robots.txt unreachable${tried} (${reason}): complete disallow`,
    });
  }

  const raw = decodeBody(doc.body, doc.contentType);
  const parsed = robotsParser(doc.url, raw);
  const userAgent = opts.userAgent;
  // The origin these rules govern: the robots.txt we actually read, after any
  // redirect. Every same-site spelling is judged against it (onRulesOrigin).
  const rulesOrigin = new URL(doc.url).origin;

  return {
    fetched: true,
    outcome: "read",
    attempts,
    status: doc.status,
    // robots-parser answers `undefined` when no group matches, when the URL is
    // unparseable, or when it belongs to another host. None of those is a
    // prohibition, and none of them is guesswork: "no rule forbids this" is
    // exactly what the protocol says to do. Same-site origin variants are
    // rewritten onto the rules origin first, so "another host" cannot mean a
    // second spelling of this one — see onRulesOrigin.
    isAllowed: (url: string) =>
      parsed.isAllowed(onRulesOrigin(url, rulesOrigin), userAgent) !== false,
    crawlDelaySec: parsed.getCrawlDelay(userAgent) ?? null,
    sitemapUrls: parsed.getSitemaps(),
    raw,
    truncated: doc.truncated,
    note: null,
  };
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Sitemaps in the wild use both the default namespace and a prefix
  // (<sm:urlset>); strip the prefix so one shape reaches the reader.
  removeNSPrefix: true,
  // Keep every leaf a string: lastmod "2026" is a date, not the number 2026.
  parseTagValue: false,
  trimValues: true,
});

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A child element's text, when it is text. */
function childText(node: unknown, name: string): string | null {
  if (typeof node !== "object" || node === null) return null;
  const value = (node as Record<string, unknown>)[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

interface ParsedDoc {
  kind: "index" | "urlset";
  locs: { loc: string | null; lastmod: string | null }[];
}

/**
 * How much of the document is searched for a DTD. A `<!DOCTYPE` may only
 * appear in the prolog, before the root element, so a generous prefix is the
 * whole of where it can legally be — and a `<!DOCTYPE` further in is not a
 * doctype at all.
 */
const PROLOG_SEARCH_CHARS = 4_096;

/**
 * A DTD in a sitemap is refused, and the document with it.
 *
 * The 10MB cap bounds the bytes that arrive, not what a parser can be made to
 * build out of them: a few hundred bytes of nested entity definitions
 * ("billion laughs") expand inside the parser to gigabytes, which is the
 * memory contract (rule 6) broken by a document that never came close to the
 * size cap. Sitemaps have no legitimate use for a DTD — the entities that
 * matter in a `<loc>` (`&amp;`, `&lt;`, `&quot;`) are XML's predefined five
 * and need no declaration — so refusing every one of them costs nothing real
 * and is one check rather than a parser audit.
 */
function hasDoctype(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml.slice(0, PROLOG_SEARCH_CHARS));
}

/**
 * `<sitemapindex>` or `<urlset>` -> its `<loc>`/`<lastmod>` pairs, or null
 * when the document is neither. Null is the interesting case: a server that
 * answers a sitemap request with an HTML error page and a 200 is common, and
 * reading that as "a sitemap with no URLs" would under-report a whole site's
 * coverage with no trace of why.
 */
function parseSitemapDoc(xml: string): ParsedDoc | null {
  const root = xmlParser.parse(xml) as Record<string, unknown>;

  const index = root["sitemapindex"];
  if (typeof index === "object" && index !== null) {
    return {
      kind: "index",
      locs: toArray((index as Record<string, unknown>)["sitemap"]).map((node) => ({
        loc: childText(node, "loc"),
        lastmod: childText(node, "lastmod"),
      })),
    };
  }

  const urlset = root["urlset"];
  if (typeof urlset === "object" && urlset !== null) {
    return {
      kind: "urlset",
      locs: toArray((urlset as Record<string, unknown>)["url"]).map((node) => ({
        loc: childText(node, "loc"),
        lastmod: childText(node, "lastmod"),
      })),
    };
  }

  return null;
}

/**
 * The documents the walk starts from: what robots.txt declared, then what the
 * caller supplied, with each document named once.
 *
 * DEDUPED ON THE NORMALISED SPELLING rather than on the string, because the two
 * lists are written by different people. A site declares
 * `Sitemap: https://site.example/sitemap.xml` and the client, reading it off a
 * CMS screen, supplies `https://site.example/sitemap.xml#gid=0` or the same URL
 * with its query parameters in the other order. Those are one document, and
 * fetching it twice would be one extra request to an origin we are about to
 * spend a whole crawl on (rule 9), plus a second, identical set of entries the
 * dedupe downstream would silently absorb.
 *
 * The URL KEPT is the first spelling, not the normalised key: what is fetched
 * is what somebody wrote, and normalisation is a comparison device here, not an
 * edit. A URL `normalizeUrl` cannot read is kept as its own key and passed
 * through — `fetchDoc` refuses it by policy and the refusal is recorded with the
 * URL as given, which is more use to whoever mistyped it than a silent drop.
 */
function startingSources(declared: readonly string[], supplied: readonly string[]): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const url of [...declared, ...supplied]) {
    const key = normalizeUrl(url) ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(url);
  }
  return sources;
}

/**
 * Read robots.txt and walk the sitemap tree it points at.
 *
 * Never throws for anything the target site does — an absent robots.txt, a
 * sitemap that 404s, a 200 that is really an HTML error page and an 11MB
 * shard are all recorded facts on the result. It does throw for our own bugs
 * (a malformed user agent), for the same reason fetch-page does.
 *
 * Sitemap sources are exactly the ones robots.txt declares plus the caller's
 * `extraSitemaps`; there is no speculative probe of `/sitemap.xml`, because a
 * document nobody pointed at is the caller's decision to make (and to pay the
 * request for), not ours to make silently.
 *
 * A SUPPLIED SITEMAP IS NOT A SPECULATIVE ONE, and the stance above is what
 * makes `extraSitemaps` the right seam rather than an exception to it: the
 * request is still one somebody decided to make, and the crawl still records
 * who pointed at each document. What the engine refuses to do is invent a URL
 * and then report whatever comes back as if the site had published it. The two
 * paths — declared in robots.txt, or handed to the crawl at start — are the
 * only two, and a site with neither has an undeclared sitemap, which is a
 * finding (`sitemap.missing`, CHECK-06) rather than something to paper over.
 *
 * The two lists are merged and deduplicated on the normalised spelling
 * (`startingSources`): a document both named is walked once.
 *
 * Documents are read one at a time, spaced by the crawl-delay robots.txt asked
 * for (capped, see MAX_CRAWL_DELAY_MS). Discovery is a handful of requests on
 * a normal site and 300 on a sharded one; reading a `Crawl-delay` and then
 * ignoring it for our own requests is the bug rule 9 exists to prevent.
 */
export async function discover(
  siteUrl: string,
  opts: DiscoveryOpts,
): Promise<DiscoveryResult> {
  const allowPrivate = opts.allowPrivate === true;
  const maxEntries = opts.maxEntries ?? MAX_SITEMAP_ENTRIES;
  const unreachableMode = opts.onUnreachableRobots ?? "disallow";
  const maxCrawlDelayMs = opts.maxCrawlDelayMs ?? MAX_CRAWL_DELAY_MS;

  const truncation: DiscoveryTruncation = {
    oversizedDocsSkipped: 0,
    docsFetched: 0,
    depthLimited: false,
    depthLimitedDocs: 0,
    docLimited: false,
    entryLimited: false,
    malformedEntriesSkipped: 0,
    failures: [],
  };

  const robots = await fetchRobots(siteUrl, opts, unreachableMode);

  const sources = startingSources(robots.sitemapUrls, opts.extraSitemaps ?? []);

  // Complete disallow means complete: we do not go on to pull 300 sitemap
  // shards off an origin that could not serve its robots.txt. The sources are
  // still named, so "we never looked" is visible rather than inferred.
  if (robots.outcome === "unreachable" && unreachableMode === "disallow") {
    for (const url of sources) {
      truncation.failures.push({
        url,
        reason: "not fetched: robots.txt unreachable, complete disallow in force",
      });
    }
    return { robots, sitemapEntries: [], truncation };
  }

  const queue: { url: string; depth: number }[] = sources.map((url) => ({
    url,
    depth: 0,
  }));

  const seen = new Set<string>();
  const entries = new Map<string, SitemapEntry>();

  // The delay applies from the robots.txt request onwards: that was a request
  // to this origin too, and the delay it declared starts counting there.
  const crawlDelayMs = Math.min(
    (robots.crawlDelaySec ?? 0) * 1000,
    Math.max(maxCrawlDelayMs, 0),
  );
  let lastRequestAt = robots.attempts > 0 ? Date.now() : null;

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (seen.has(next.url)) continue;
    seen.add(next.url);

    if (next.depth > MAX_SITEMAP_DEPTH) {
      truncation.depthLimited = true;
      truncation.depthLimitedDocs++;
      continue;
    }
    if (truncation.docsFetched >= MAX_SITEMAP_DOCS) {
      truncation.docLimited = true;
      break;
    }
    if (entries.size >= maxEntries) {
      truncation.entryLimited = true;
      break;
    }

    if (crawlDelayMs > 0 && lastRequestAt !== null) {
      // Measured from the end of the previous request, so a slow document
      // never shortens the gap the site asked for.
      const waited = Date.now() - lastRequestAt;
      if (waited < crawlDelayMs) await sleep(crawlDelayMs - waited);
    }

    truncation.docsFetched++;
    const doc = await fetchDoc(next.url, SITEMAP_MAX_BYTES, false, opts);
    lastRequestAt = Date.now();
    if (doc.oversized) truncation.oversizedDocsSkipped++;
    if (!doc.ok || doc.body === null) {
      truncation.failures.push({
        url: next.url,
        reason: doc.reason ?? "no body",
      });
      continue;
    }
    // The bytes came from doc.url; if a redirect took us there, do not walk
    // the same document again under its other name.
    seen.add(doc.url);

    const xml = decodeBody(doc.body, doc.contentType);
    if (hasDoctype(xml)) {
      truncation.failures.push({
        url: next.url,
        reason: "refused: <!DOCTYPE declaration in a sitemap (entity-expansion risk)",
      });
      continue;
    }

    const parsed = parseSitemapDoc(xml);
    if (parsed === null) {
      truncation.failures.push({
        url: next.url,
        reason: "no <urlset> or <sitemapindex> root element",
      });
      continue;
    }

    for (const item of parsed.locs) {
      if (item.loc === null) {
        truncation.malformedEntriesSkipped++;
        continue;
      }
      let resolved: string;
      try {
        // Absolute only, deliberately: the sitemaps protocol requires it, and
        // resolving a relative <loc> against the document would manufacture
        // URLs out of junk ("not a url at all" -> <base>/not%20a%20url…) that
        // the site never declared. A loc we cannot read as a URL is counted,
        // not guessed at.
        resolved = new URL(item.loc).href;
      } catch {
        truncation.malformedEntriesSkipped++;
        continue;
      }
      if (parsed.kind === "index") {
        // The queue can never usefully hold more documents than we are allowed
        // to fetch, and a hostile index listing a million shards must not cost
        // a million queue entries — RAM is O(concurrency), not O(URLs). The
        // child's own URL-policy check happens in fetchDoc, where a refusal
        // becomes a named failure rather than an anonymous counter.
        if (queue.length >= MAX_SITEMAP_DOCS) {
          truncation.docLimited = true;
          break;
        }
        queue.push({ url: resolved, depth: next.depth + 1 });
        continue;
      }

      // A <loc> is site-controlled text heading for a field the crawl loop
      // will enqueue and the report layer may render: policy-check it here
      // rather than trusting a later caller to remember (hard rule 5).
      const verdict = await isUrlAllowed(resolved, { allowPrivate });
      if (!verdict.allowed) {
        truncation.malformedEntriesSkipped++;
        continue;
      }

      if (entries.size >= maxEntries) {
        truncation.entryLimited = true;
        break;
      }
      if (!entries.has(resolved)) {
        entries.set(resolved, {
          url: resolved,
          source: doc.url,
          lastmod: item.lastmod,
        });
      }
    }
  }

  return { robots, sitemapEntries: [...entries.values()], truncation };
}

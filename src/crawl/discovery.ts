/**
 * Discovery: the two documents a crawl reads before it reads any page —
 * robots.txt and the sitemap tree it points at.
 *
 * These are not HTML pages, so `fetchPage` is the wrong primitive (its 2MiB
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
 * Phase 26c: sitemaps are read as a stream (`parseSitemapStream`), never
 * buffered whole, and the walk hands the caller's `SitemapSink` two things the
 * entry list cannot hold — every (URL, document) MEMBERSHIP, so a URL two
 * documents list is listed twice, and every `xhtml:link` ALTERNATE, staged for
 * the hreflang rules. The sink is flushed from the stream's `drain`, so memory
 * is O(chunk + one sink batch) whatever the document's size. What the walk
 * handed over, and what it could not, is `sitemapFacts`.
 *
 * Two things it does decide, because they are politeness and both bite before
 * the crawl loop exists (build plan rule 9):
 *  - An *unreachable* robots.txt (5xx, timeout, network error, refused URL —
 *    as opposed to an absent one, which is a 4xx and normal) is retried, and
 *    then means complete disallow, per RFC 9309 §2.3.1.4. A site whose server
 *    is erroring does not get crawled on the assumption it would have let us.
 *  - Its own sitemap walk is paced at the wider of the crawl's configured
 *    `perHostDelayMs` (already floored by a platform profile when one is
 *    known before discovery) and the crawl-delay it just parsed. Having read
 *    `Crawl-delay: 10` and then fetched 300 shards back-to-back would be the
 *    yellow.com.mt incident with extra steps — and so would fetching them at
 *    0 ms on a site the crawl itself paces at 1 s. Until Phase 24a the walk
 *    honoured only the robots number; a site with no `Crawl-delay` had its
 *    shards read back-to-back whatever the crawl was configured at.
 *
 * Caps (RFC 9309 for robots, the sitemaps.org protocol and Google's published
 * limits for the rest):
 *  - robots.txt: 500KB read, the remainder ignored — Google's documented
 *    behaviour. A robots.txt this big is already pathological; refusing it
 *    outright would be *less* polite than honouring the part we read.
 *  - sitemap document: the protocol's 50MB (`SITEMAP_MAX_BYTES`), on the
 *    DECOMPRESSED bytes, and the same number on the wire. Since Phase 26c a
 *    document over it keeps the entries read before the cap (deviation 3): it
 *    is named in `sitemapFacts.oversizedDocs` and counted in
 *    `truncation.oversizedDocsSkipped`, and it is not a failure.
 *  - sitemap index recursion: 3 levels below the first document.
 *  - 300 documents per crawl, and a cap on the entries kept in memory (the
 *    memory contract is RAM O(concurrency), and 300 × 50k entries is not).
 *  - memberships and staged alternates: MAX_SITEMAP_MEMBERSHIPS and
 *    MAX_SITEMAP_HREFLANG_ROWS per crawl; a URL over the index limit
 *    (`INDEXED_URL_MAX`) is never handed over, only counted.
 * Every cap that bites is counted in `truncation` or `sitemapFacts`; none of
 * them is silent.
 *
 * The byte caps bound what arrives, which is not the same as bounding what a
 * parser can make of it — so a sitemap carrying a `<!DOCTYPE` is refused before
 * it reaches the XML tokenizer (src/crawl/sitemap-stream.ts).
 */
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";
import robotsParserImport from "robots-parser";
import { request, type Dispatcher } from "undici";
import { isUrlAllowed } from "./url-policy.js";
import { fitsIndex, isSameOrigin, normalizeUrl, onRulesOrigin } from "./parse/url-utils.js";
import { hreflangTarget } from "./parse/page-analyzer.js";
import {
  parseSitemapStream,
  SITEMAP_MAX_BYTES,
  type SitemapStreamResult,
  type SitemapUrlEntry,
} from "./sitemap-stream.js";
import {
  blockedAddressMessage,
  charsetOf,
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
  /** 1-based line of the rule that decided; -1 when no rule matched. */
  getMatchingLineNumber(url: string, ua?: string): number;
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
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_DOCS = 300;

/**
 * Per-crawl caps on what the walk hands the sink (Phase 26c). Rows, not memory
 * — the sink writes them as they come — but a hostile tree of 300 documents of
 * 50 MB each must not become tens of millions of rows. A cap that bites sets
 * its `sitemapFacts` flag; the walk goes on, and only that kind of row stops.
 */
export const MAX_SITEMAP_MEMBERSHIPS = 800_000;
export const MAX_SITEMAP_HREFLANG_ROWS = 1_000_000;

/** `sitemapFacts.oversizedDocs` names at most this many documents. */
const MAX_OVERSIZED_DOCS_NAMED = 50;

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
  /**
   * The robots.txt line that DECIDED this URL — `Disallow: /private/`, or the
   * `Allow:` line that won — as the site wrote it, comment stripped and
   * whitespace trimmed. Null when no line matched (the protocol's default
   * allow), and always null when there is no robots.txt text at all (absent
   * or unreachable: the verdict then comes from the outcome, not from a line).
   *
   * Judged exactly as `isAllowed` is — same parser, same user agent, same
   * same-site origin rewrite — so a `false` from `isAllowed` on a read
   * robots.txt always has a line here. The crawl loop quotes it as the reason
   * a robots-blocked row was never requested (`robotsBlockedReason`), and
   * throws if a disallow ever arrives without one rather than writing a row
   * that cannot say why (hard rule 7).
   */
  matchingRule(url: string): string | null;
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
  /**
   * Documents that ran past the size cap. Until Phase 26c each was dropped
   * whole and also listed in `failures`; since then the entries read before the
   * cap are kept and the document is named in `sitemapFacts.oversizedDocs`
   * instead. The count keeps its name, for the `sitemap.structure` metric.
   */
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
  /**
   * `<loc>` values that were empty, unparseable, or refused by the policy, and
   * (Phase 26c) alternate `href`s that do not resolve against the document.
   */
  malformedEntriesSkipped: number;
  /** One line per document that was pointed at and could not be read. */
  failures: { url: string; reason: string }[];
}

/**
 * What the sitemap walk recorded beyond the entries (Phase 26c): written to
 * `crawls.discovery_jsonb.sitemapFacts`. A crawl without the key predates it.
 */
export type DiscoverySitemapFacts = {
  /**
   * Memberships handed to the sink: one per `<loc>` a urlset lists. A document
   * that repeats a URL hands it over again, and `sitemap_memberships` (keyed on
   * URL and document) stores it once, so the table can hold fewer.
   */
  memberships: number;
  /** MAX_SITEMAP_MEMBERSHIPS was reached and later memberships were dropped. */
  membershipLimited: boolean;
  /** Alternates handed to the sink (`sitemap_hreflang` rows). */
  hreflangRows: number;
  /** MAX_SITEMAP_HREFLANG_ROWS was reached and later alternates were dropped. */
  hreflangLimited: boolean;
  /**
   * `<loc>`s, and alternate targets, over `INDEXED_URL_MAX` in the spelling a
   * row would store: counted here, handed to nobody.
   */
  overlongLocsSkipped: number;
  /**
   * Documents that ran past the size cap, in walk order, capped at 50 (every
   * one is counted in `truncation.oversizedDocsSkipped`). `bytesRead` is the
   * decompressed bytes read, or the wire bytes when the compressed body itself
   * passed the cap; `urlsKept` is the entries kept from it.
   */
  oversizedDocs: { url: string; bytesRead: number; urlsKept: number }[];
};

export interface DiscoveryResult {
  robots: RobotsInfo;
  /** Deduped by url, first source wins. */
  sitemapEntries: SitemapEntry[];
  truncation: DiscoveryTruncation;
  /** Phase 26c: written on every result, zeros when there was no sitemap. */
  sitemapFacts: DiscoverySitemapFacts;
}

/**
 * Where the walk's memberships and alternates go (Phase 26c). The calls are
 * synchronous and only buffer; `flush` writes what is buffered and is awaited
 * after every chunk of every document, so the buffer is O(chunk). A `flush`
 * that throws stops the walk: it is the engine's failure, not the site's.
 *
 * Every URL handed over has passed `fitsIndex` in the spelling it is given in
 * and in its `normalizeUrl` spelling, and a membership's URL has passed the URL
 * policy. `alternate`'s `href` is already resolved against the document.
 */
export interface SitemapSink {
  membership(url: string, source: string): void;
  alternate(url: string, a: { hreflang: string; href: string }, source: string): void;
  flush(): Promise<void>;
}

/**
 * `discover`'s options: everything `fetchRobots` takes, plus the spacing the
 * sitemap walk honours.
 */
export interface DiscoverOpts extends DiscoveryOpts {
  /**
   * The crawl's own spacing between two requests, in ms — `CrawlConfig.
   * perHostDelayMs`, floored by the crawl's platform profile when the host
   * probe already named the platform (src/crawl/platform.ts). The sitemap walk
   * waits `max(this, robots Crawl-delay)` between documents. Required, not
   * defaulted, for the host probe's reason: a walk paced by a number nobody
   * chose would be a politeness decision made by omission.
   *
   * Unlike the robots number it is NOT bounded by `maxCrawlDelayMs`, which is
   * a ceiling on what a SITE may ask of us; this is what we asked of
   * ourselves, and the crawl's gate bounds it the same way (30 s).
   */
  perHostDelayMs: number;
  /** Receives every membership and staged alternate. See `SitemapSink`. */
  sink: SitemapSink;
  /**
   * The per-document size cap, decompressed and on the wire. Defaults to the
   * protocol's `SITEMAP_MAX_BYTES`; lowered by tests, which cannot afford a
   * 50 MB fixture per case.
   */
  maxSitemapBytes?: number;
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
    // No text, so no line decided anything: the verdict above is the outcome's.
    matchingRule: () => null,
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
 * One hop's deadline, which the reader may pause.
 *
 * A sitemap is read while the walk writes its rows: the stream awaits the
 * sink's `flush` after every chunk, and the socket waits meanwhile. That time
 * is ours, not the site's, so it stops the clock — otherwise a 50 MB document
 * with half a million memberships would time out on our own inserts.
 */
class Deadline {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private remainingMs: number;
  private startedAt = 0;
  private done = false;
  /** The deadline fired and aborted the request. */
  hit = false;

  constructor(ms: number) {
    this.remainingMs = ms;
    this.resume();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  pause(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remainingMs -= Date.now() - this.startedAt;
  }

  resume(): void {
    if (this.timer !== null || this.done || this.hit) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(
      () => {
        this.hit = true;
        this.timer = null;
        this.controller.abort();
      },
      Math.max(this.remainingMs, 0),
    );
  }

  clear(): void {
    this.done = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The final 2xx answer to a document request, as its reader gets it. */
interface DocResponse {
  /** The URL the bytes come from, after any redirects. */
  url: string;
  status: number;
  headers: HeaderBag;
  /** The reader owns it: read it to the end or destroy it. */
  body: Dispatcher.ResponseData["body"];
  deadline: Deadline;
}

/**
 * The reader's own failure — the sitemap sink's insert, say — as opposed to the
 * site's. `requestDoc` classifies everything a reader throws as a failed
 * document unless it is wrapped in this, which it rethrows unwrapped.
 */
class ReaderFault extends Error {
  constructor(readonly fault: unknown) {
    super("discovery: the document reader failed", { cause: fault });
  }
}

/**
 * GET one non-HTML document, policy-checked, and hand the 2xx answer to `read`.
 *
 * Every hop — the URL as given and every redirect target — goes through
 * `isUrlAllowed` before a socket is opened (hard rule 5), and the connect-time
 * address guard in `./http` re-checks whatever DNS actually returns. Redirects
 * are followed rather than recorded, unlike page fetches: a redirect on
 * robots.txt or a sitemap is plumbing (apex -> www, http -> https), not a fact
 * about the site's URL graph, and refusing to follow it would lose the
 * sitemap on a large share of real sites.
 *
 * The hop's deadline runs while `read` reads (less any time it pauses it), and
 * whatever `read` throws is classified like a failed request — a reset, a
 * timeout, a corrupt gzip — unless it is a programmer error or a `ReaderFault`.
 */
async function requestDoc<T>(
  startUrl: string,
  opts: DiscoveryOpts,
  drainBytes: number,
  read: (response: DocResponse) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; failure: DocResult }> {
  const allowPrivate = opts.allowPrivate === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failed = (doc: DocResult) => ({ ok: false as const, failure: doc });
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const verdict = await isUrlAllowed(url, { allowPrivate });
    if (!verdict.allowed) {
      return failed(failedDoc(url, `refused by URL policy: ${verdict.reason}`, null, true));
    }

    const deadline = new Deadline(timeoutMs);
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
        await readCapped(response.body, drainBytes, false);
        const location = headerValue(headers, "location");
        if (location === null) {
          return failed(failedDoc(url, `HTTP ${status} without a Location header`, status));
        }
        try {
          url = new URL(location, url).href;
        } catch {
          return failed(failedDoc(url, `unresolvable Location header (${location})`, status));
        }
        continue;
      }

      if (status < 200 || status >= 300) {
        await readCapped(response.body, drainBytes, false);
        return failed(failedDoc(url, `HTTP ${status}`, status));
      }

      return { ok: true, value: await read({ url, status, headers, body: response.body, deadline }) };
    } catch (error) {
      if (error instanceof ReaderFault) throw error.fault;
      // Our bug, not theirs — the same contract fetch-page keeps.
      if (isProgrammerError(error)) throw error;
      const refusal = blockedAddressMessage(error);
      if (refusal !== null) {
        return failed(failedDoc(url, `refused at connect: ${refusal}`, null, true));
      }
      if (deadline.hit || isTimeout(error)) return failed(failedDoc(url, "timed out"));
      return failed(failedDoc(url, describeError(error)));
    } finally {
      deadline.clear();
    }
  }

  return failed(failedDoc(url, `more than ${MAX_REDIRECT_HOPS} redirects`));
}

/** A content-encoding the bytes may arrive in: none, or gzip (sniffed anyway). */
function readableEncoding(encoding: string | null): boolean {
  return encoding === null || /^\s*(identity|gzip|x-gzip)\s*$/i.test(encoding);
}

/**
 * GET robots.txt: buffered, capped at `maxBytes`, the bytes past the cap
 * ignored (`truncated`), and gzip undone.
 */
async function fetchDoc(
  startUrl: string,
  maxBytes: number,
  opts: DiscoveryOpts,
): Promise<DocResult> {
  const result = await requestDoc(startUrl, opts, maxBytes, async (response): Promise<DocResult> => {
    const { url, status, headers } = response;
    const read = await readCapped(response.body, maxBytes, true);
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
    if (decoded === raw && !readableEncoding(encoding)) {
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
  });
  return result.ok ? result.value : result.failure;
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
 * The prefix of `pages.fetch_reason` on a row the crawl recorded and never
 * requested because robots.txt disallowed it (Phase 23 T3, study D1).
 *
 * It is what keeps the two meanings of `fetch_class = 'disallowed'` apart: the
 * same class is written when OUR url-policy refuses a URL at fetch time
 * (`fetchPage`'s `emptyResult`, reason in the policy's own words, which never
 * start with this). `robots.blocks-internal-urls`, its inlinks report and every
 * census that must not count a never-requested URL as crawled select on the
 * prefix (`ROBOTS_BLOCKED`, src/rules/helpers.ts), never on the class alone.
 */
export const ROBOTS_BLOCKED_REASON_PREFIX = "robots.txt: ";

/** `fetch_reason` for a robots-blocked row: the prefix and the line that decided. */
export function robotsBlockedReason(line: string): string {
  return `${ROBOTS_BLOCKED_REASON_PREFIX}${line}`;
}

/**
 * The verdict and the deciding line for one robots.txt text — `isAllowed` and
 * `matchingRule` exactly as `RobotsInfo` carries them, as a pure function of
 * the text so both can be tested without a server.
 *
 * `robotsUrl` is the URL the text was actually read from (after redirects): its
 * origin is the one these rules govern, and every same-site spelling is
 * rewritten onto it first (onRulesOrigin).
 *
 * robots-parser answers `undefined` when no group matches, when the URL is
 * unparseable, or when it belongs to another host. None of those is a
 * prohibition, and none of them is guesswork: "no rule forbids this" is exactly
 * what the protocol says to do. Same-site origin variants are rewritten onto
 * the rules origin first, so "another host" cannot mean a second spelling of
 * this one.
 *
 * The precedence is robots-parser's, which is RFC 9309 §2.2.2's: the longest
 * matching pattern wins, an `Allow` beats a `Disallow` of the same length, `*`
 * matches any run of characters and a trailing `$` anchors the end. The line is
 * quoted from the text by the parser's own line number, split on the same line
 * endings the parser splits on, so the two cannot disagree about which line it
 * was.
 */
export function robotsRulesOf(
  robotsUrl: string,
  raw: string,
  userAgent: string,
): {
  parsed: RobotsRules;
  isAllowed: (url: string) => boolean;
  matchingRule: (url: string) => string | null;
} {
  const parsed = robotsParser(robotsUrl, raw);
  const rulesOrigin = new URL(robotsUrl).origin;
  // Split once, not once per URL: the text is up to 500KB and the crawl loop
  // asks about every disallowed link it meets.
  const lines = raw.split(/\r\n|\r|\n/);
  return {
    parsed,
    isAllowed: (url: string) =>
      parsed.isAllowed(onRulesOrigin(url, rulesOrigin), userAgent) !== false,
    matchingRule: (url: string) => {
      const line = parsed.getMatchingLineNumber(onRulesOrigin(url, rulesOrigin), userAgent);
      if (!Number.isInteger(line) || line < 1) return null;
      const text = lines[line - 1];
      if (text === undefined) {
        throw new Error(
          `robots.txt rule line ${line} is past the end of a ${lines.length}-line text`,
        );
      }
      // The parser strips a `#` comment before it reads a line; so does the quote.
      const hash = text.indexOf("#");
      return (hash === -1 ? text : text.slice(0, hash)).trim();
    },
  };
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
  let doc = await fetchDoc(robotsUrl, ROBOTS_MAX_BYTES, opts);
  let attempts = 1;
  while (!doc.ok && classifyRobotsFailure(doc) === "retry" && attempts < ROBOTS_ATTEMPTS) {
    // Linear backoff, deliberately short: this is a 60-byte text file, and the
    // origin is already unhappy. Three tries, ~750ms, then we stop asking.
    await sleep(backoffMs * attempts);
    doc = await fetchDoc(robotsUrl, ROBOTS_MAX_BYTES, opts);
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
  const userAgent = opts.userAgent;
  const rules = robotsRulesOf(doc.url, raw, userAgent);

  return {
    fetched: true,
    outcome: "read",
    attempts,
    status: doc.status,
    isAllowed: rules.isAllowed,
    matchingRule: rules.matchingRule,
    crawlDelaySec: rules.parsed.getCrawlDelay(userAgent) ?? null,
    sitemapUrls: rules.parsed.getSitemaps(),
    raw,
    truncated: doc.truncated,
    note: null,
  };
}

/**
 * Count the bytes a body brings over the wire and stop it past `maxBytes`.
 *
 * The stream caps DECOMPRESSED bytes, which is the cap that protects memory,
 * but a gzip body of empty blocks inflates to nothing and would never reach it:
 * the request would run until its deadline, pulling bytes the whole time. This
 * is the wire half of the old buffered cap, kept at the same number. The chunk
 * that crosses the line is still handed on — for an uncompressed body it is the
 * chunk the stream's own cap stops on, so the stream reports that one — and the
 * next pull throws, with `wire.exceeded` set for the caller to read.
 */
async function* wireCapped(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  wire: { bytes: number; exceeded: boolean },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of body) {
    wire.bytes += chunk.byteLength;
    yield chunk;
    if (wire.bytes > maxBytes) {
      wire.exceeded = true;
      throw new Error(`more than the ${maxBytes}-byte document cap on the wire`);
    }
  }
}

/** The stream's callbacks for one document, bound to the URL it came from. */
interface SitemapHandlers {
  onUrl: (entry: SitemapUrlEntry) => void;
  onSitemap: (loc: string, lastmod: string | null) => void;
  /** Hand what the last chunk produced to the sink, and flush it. */
  drain: () => Promise<void>;
}

type StreamedDoc =
  | {
      outcome: "read";
      /** The URL the bytes came from, after any redirects. */
      url: string;
      result: SitemapStreamResult;
    }
  | { outcome: "oversized-on-wire"; url: string; wireBytes: number }
  | { outcome: "failed"; reason: string };

/**
 * GET one sitemap and stream it through `parseSitemapStream`, which owns the
 * body from there on.
 *
 * The hop's deadline still bounds the read (the stream bounds bytes, not
 * time), paused while `drain` runs: see `Deadline`. A content-encoding other
 * than gzip or identity is refused before a byte is read. A `drain` that throws
 * is the walk's own failure and leaves here as itself (`ReaderFault`); anything
 * the body or the inflater throws is the document's, and becomes `failed`.
 */
async function streamSitemap(
  startUrl: string,
  opts: DiscoveryOpts,
  maxBytes: number,
  handlersFor: (source: string) => SitemapHandlers,
): Promise<StreamedDoc> {
  const wire = { bytes: 0, exceeded: false };
  let source: string | null = null;
  const result = await requestDoc(
    startUrl,
    opts,
    maxBytes,
    async (response): Promise<SitemapStreamResult> => {
      source = response.url;
      const encoding = headerValue(response.headers, "content-encoding");
      if (!readableEncoding(encoding)) {
        response.body.destroy();
        return { kind: "refused", reason: `unsupported content-encoding (${encoding})` };
      }
      const handlers = handlersFor(response.url);
      return parseSitemapStream(wireCapped(response.body, maxBytes, wire), {
        maxBytes,
        charset: charsetOf(headerValue(response.headers, "content-type")),
        onUrl: handlers.onUrl,
        onSitemap: handlers.onSitemap,
        drain: async () => {
          response.deadline.pause();
          try {
            await handlers.drain();
          } catch (error) {
            throw new ReaderFault(error);
          } finally {
            response.deadline.resume();
          }
        },
      });
    },
  );
  // Checked first: the throw that stopped the body surfaces as a failure.
  if (wire.exceeded && source !== null) {
    return { outcome: "oversized-on-wire", url: source, wireBytes: wire.bytes };
  }
  if (!result.ok) return { outcome: "failed", reason: result.failure.reason ?? "no body" };
  if (source === null) throw new Error(`streamSitemap: ${startUrl} was read with no source URL`);
  return { outcome: "read", url: source, result: result.value };
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
 * sitemap that 404s, a 200 that is really an HTML error page and a 60MB
 * shard are all recorded facts on the result. It does throw for our own bugs
 * (a malformed user agent), for the same reason fetch-page does — and for a
 * sink that cannot write, which is ours too.
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
 * Documents are read one at a time, spaced by the wider of the crawl's own
 * `perHostDelayMs` and the crawl-delay robots.txt asked for (the robots number
 * capped, see MAX_CRAWL_DELAY_MS). Discovery is a handful of requests on a
 * normal site and 300 on a sharded one; reading a `Crawl-delay` and then
 * ignoring it for our own requests is the bug rule 9 exists to prevent, and so
 * is walking 300 shards faster than the crawl that follows will read pages.
 */
export async function discover(
  siteUrl: string,
  opts: DiscoverOpts,
): Promise<DiscoveryResult> {
  if (!Number.isFinite(opts.perHostDelayMs) || opts.perHostDelayMs < 0) {
    throw new RangeError(`discover: perHostDelayMs must be ≥ 0, got ${opts.perHostDelayMs}`);
  }
  const maxSitemapBytes = opts.maxSitemapBytes ?? SITEMAP_MAX_BYTES;
  if (!Number.isInteger(maxSitemapBytes) || maxSitemapBytes <= 0) {
    throw new RangeError(`discover: maxSitemapBytes must be a positive integer, got ${maxSitemapBytes}`);
  }
  const allowPrivate = opts.allowPrivate === true;
  const maxEntries = opts.maxEntries ?? MAX_SITEMAP_ENTRIES;
  const unreachableMode = opts.onUnreachableRobots ?? "disallow";
  const maxCrawlDelayMs = opts.maxCrawlDelayMs ?? MAX_CRAWL_DELAY_MS;
  const sink = opts.sink;

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
  const sitemapFacts: DiscoverySitemapFacts = {
    memberships: 0,
    membershipLimited: false,
    hreflangRows: 0,
    hreflangLimited: false,
    overlongLocsSkipped: 0,
    oversizedDocs: [],
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
    return { robots, sitemapEntries: [], truncation, sitemapFacts };
  }

  const queue: { url: string; depth: number }[] = sources.map((url) => ({
    url,
    depth: 0,
  }));

  const seen = new Set<string>();
  const entries = new Map<string, SitemapEntry>();

  /**
   * One `<url>` of a urlset, read from `source` (the document's URL after
   * redirects). Every check a `<loc>` faces is here, once, and the entry, its
   * membership and its alternates all follow from the one verdict.
   */
  const acceptUrl = async (
    entry: SitemapUrlEntry,
    source: string,
    doc: { urlsKept: number },
  ): Promise<void> => {
    let resolved: string;
    try {
      // Absolute only, deliberately: the sitemaps protocol requires it, and
      // resolving a relative <loc> against the document would manufacture
      // URLs out of junk ("not a url at all" -> <base>/not%20a%20url…) that
      // the site never declared. A loc we cannot read as a URL is counted,
      // not guessed at.
      resolved = new URL(entry.loc).href;
    } catch {
      truncation.malformedEntriesSkipped++;
      return;
    }
    // Measured on both spellings a row stores (`url`, `url_normalised`), before
    // the policy, which would refuse it too but only as one more malformed
    // entry: a URL no index can hold is its own fact (deviation 9).
    const normalised = normalizeUrl(resolved);
    if (!fitsIndex(resolved) || (normalised !== null && !fitsIndex(normalised))) {
      sitemapFacts.overlongLocsSkipped++;
      return;
    }
    // A <loc> is site-controlled text heading for a field the crawl loop
    // will enqueue and the report layer may render: policy-check it here
    // rather than trusting a later caller to remember (hard rule 5).
    const verdict = await isUrlAllowed(resolved, { allowPrivate });
    if (!verdict.allowed) {
      truncation.malformedEntriesSkipped++;
      return;
    }
    if (normalised === null) {
      // The policy admits only http(s) URLs it can parse, and those normalise.
      throw new Error(`discover: an allowed sitemap URL does not normalise: ${resolved}`);
    }
    doc.urlsKept++;

    if (sitemapFacts.memberships >= MAX_SITEMAP_MEMBERSHIPS) {
      sitemapFacts.membershipLimited = true;
    } else {
      sink.membership(resolved, source);
      sitemapFacts.memberships++;
    }

    // The entry list is unchanged: first source wins, and a full list stops the
    // walk at the next document. The rest of this one is still read, for its
    // memberships and alternates.
    if (!entries.has(resolved)) {
      if (entries.size >= maxEntries) {
        truncation.entryLimited = true;
      } else {
        entries.set(resolved, { url: resolved, source, lastmod: entry.lastmod });
      }
    }

    for (const alternate of entry.alternates) {
      // Resolved as the page analyzer resolves an HTML alternate, against the
      // document that states it, so the length checked is the length stored.
      const target = hreflangTarget(alternate.href, source);
      if (target === null) {
        truncation.malformedEntriesSkipped++;
        continue;
      }
      if (!fitsIndex(target)) {
        sitemapFacts.overlongLocsSkipped++;
        continue;
      }
      if (sitemapFacts.hreflangRows >= MAX_SITEMAP_HREFLANG_ROWS) {
        sitemapFacts.hreflangLimited = true;
        break;
      }
      sink.alternate(resolved, { hreflang: alternate.hreflang, href: target }, source);
      sitemapFacts.hreflangRows++;
    }
  };

  const recordOversized = (url: string, bytesRead: number, urlsKept: number): void => {
    truncation.oversizedDocsSkipped++;
    if (sitemapFacts.oversizedDocs.length < MAX_OVERSIZED_DOCS_NAMED) {
      sitemapFacts.oversizedDocs.push({ url, bytesRead, urlsKept });
    }
  };

  // The delay applies from the robots.txt request onwards: that was a request
  // to this origin too, and the delay it declared starts counting there. The
  // site's number is capped (MAX_CRAWL_DELAY_MS); ours is the crawl's own.
  const crawlDelayMs = Math.max(
    opts.perHostDelayMs,
    Math.min((robots.crawlDelaySec ?? 0) * 1000, Math.max(maxCrawlDelayMs, 0)),
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
    const doc = { urlsKept: 0 };
    // The stream's callbacks are synchronous and the checks a <loc> faces are
    // not (the policy), so a chunk's entries wait here, O(chunk), until the
    // stream drains.
    const pending: SitemapUrlEntry[] = [];
    let indexFull = false;
    let docSource: string | null = null;
    const drainPending = async (): Promise<void> => {
      if (docSource === null) return;
      for (const entry of pending.splice(0)) await acceptUrl(entry, docSource, doc);
      await sink.flush();
    };

    const read = await streamSitemap(next.url, opts, maxSitemapBytes, (source) => {
      docSource = source;
      return {
        onUrl: (entry) => {
          pending.push(entry);
        },
        onSitemap: (loc) => {
          // The rest of an index past a full queue is read, and ignored.
          if (indexFull) return;
          let resolved: string;
          try {
            resolved = new URL(loc).href;
          } catch {
            truncation.malformedEntriesSkipped++;
            return;
          }
          // The queue can never usefully hold more documents than we are
          // allowed to fetch, and a hostile index listing a million shards must
          // not cost a million queue entries — RAM is O(concurrency), not
          // O(URLs). The child's own URL-policy check happens when it is
          // requested, where a refusal becomes a named failure rather than an
          // anonymous counter.
          if (queue.length >= MAX_SITEMAP_DOCS) {
            truncation.docLimited = true;
            indexFull = true;
            return;
          }
          queue.push({ url: resolved, depth: next.depth + 1 });
          doc.urlsKept++;
        },
        drain: drainPending,
      };
    });
    lastRequestAt = Date.now();
    // A document that failed mid-stream keeps the complete entries it gave
    // before it failed; the failure is recorded beside them.
    await drainPending();

    if (read.outcome === "failed") {
      truncation.failures.push({ url: next.url, reason: read.reason });
      continue;
    }
    // The bytes came from read.url; if a redirect took us there, do not walk
    // the same document again under its other name.
    seen.add(read.url);

    if (read.outcome === "oversized-on-wire") {
      recordOversized(next.url, read.wireBytes, doc.urlsKept);
      continue;
    }
    const result = read.result;
    if (result.kind === "refused") {
      truncation.failures.push({ url: next.url, reason: result.reason });
      continue;
    }
    truncation.malformedEntriesSkipped += result.malformedEntries;
    if (result.oversized) recordOversized(next.url, result.bytes, doc.urlsKept);
  }

  return { robots, sitemapEntries: [...entries.values()], truncation, sitemapFacts };
}

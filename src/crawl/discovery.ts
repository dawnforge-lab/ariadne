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
 * Nothing here decides anything. `discover` returns facts — the parsed robots
 * rules, the sitemap URLs, and an honest account of everything it could not
 * read. Persisting sitemap entries to `sitemap_urls` and obeying the crawl
 * delay are the crawl loop's job.
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
 */
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import robotsParserImport from "robots-parser";
import { request } from "undici";
import { isUrlAllowed } from "./url-policy.js";
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

/** gzip's two magic bytes. Trusted over the headers — see decompress. */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export interface RobotsInfo {
  /** True only when a robots.txt was fetched and parsed. */
  fetched: boolean;
  /** The HTTP status, when we got one. */
  status: number | null;
  /** True when no rule forbids this URL — including when there is no robots. */
  isAllowed(url: string): boolean;
  crawlDelaySec: number | null;
  sitemapUrls: string[];
  raw: string | null;
  /** True when robots.txt was longer than the 500KB read cap. */
  truncated: boolean;
  /**
   * Why there are no rules, in plain words: a 404, a network error, a refused
   * URL. Null when robots.txt was read. A site with no robots.txt is normal
   * and is not an error — but "we are crawling allow-all because we could not
   * read robots.txt" is a fact the caller must be able to see and report,
   * which is why it is a field and not a log line.
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
  /** Sitemaps to walk in addition to the ones robots.txt declares. */
  extraSitemaps?: string[];
  /** Per-document deadline: connect, headers and body together. */
  timeoutMs?: number;
  /** Overrides the in-memory entry cap. See MAX_SITEMAP_ENTRIES. */
  maxEntries?: number;
  /**
   * TEST ONLY. Relaxes the URL check and the connect-time address re-check to
   * the same floor as fetch-page's, so the suite can read a 127.0.0.1 fixture
   * server. Never wire this to config, an API field or an env var.
   */
  allowPrivate?: boolean;
}

/** An allow-all robots stand-in, with the reason it is standing in. */
function noRobots(note: string, status: number | null): RobotsInfo {
  return {
    fetched: false,
    status,
    isAllowed: () => true,
    crawlDelaySec: null,
    sitemapUrls: [],
    raw: null,
    truncated: false,
    note,
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
  /** Bytes were kept, but the document continued past the cap. */
  truncated: boolean;
  /** Why there are no bytes. Null when ok. */
  reason: string | null;
}

function failedDoc(url: string, reason: string, status: number | null = null): DocResult {
  return {
    ok: false,
    url,
    status,
    body: null,
    contentType: null,
    oversized: false,
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
      return failedDoc(url, `refused by URL policy: ${verdict.reason}`);
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
        truncated: read.truncated,
        reason: null,
      };
    } catch (error) {
      // Our bug, not theirs — the same contract fetch-page keeps.
      if (isProgrammerError(error)) throw error;
      const refusal = blockedAddressMessage(error);
      if (refusal !== null) return failedDoc(url, `refused at connect: ${refusal}`);
      if (deadlineHit || isTimeout(error)) return failedDoc(url, "timed out");
      return failedDoc(url, describeError(error));
    } finally {
      clearTimeout(timer);
    }
  }

  return failedDoc(url, `more than ${MAX_REDIRECT_HOPS} redirects`);
}

async function fetchRobots(siteUrl: string, opts: DiscoveryOpts): Promise<RobotsInfo> {
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", siteUrl).href;
  } catch {
    return noRobots(`unparseable site URL (${siteUrl})`, null);
  }

  const doc = await fetchDoc(robotsUrl, ROBOTS_MAX_BYTES, true, opts);
  if (!doc.ok || doc.body === null) {
    // Every unreadable robots.txt — 404, 5xx, timeout, refused URL — becomes
    // allow-all with the reason attached. RFC 9309 permits treating a 5xx as
    // "disallow everything", and Google does for 12 hours; we deliberately do
    // not. Ariadne crawls sites with the owner's permission, and silently
    // producing an empty audit because one request 503'd is a worse failure
    // than crawling a site whose robots.txt we could not read — as long as
    // the caller can see that is what happened, which is what `note` is for.
    return noRobots(`robots.txt not read: ${doc.reason ?? "no body"}`, doc.status);
  }

  const raw = decodeBody(doc.body, doc.contentType);
  const parsed = robotsParser(doc.url, raw);
  const userAgent = opts.userAgent;

  return {
    fetched: true,
    status: doc.status,
    // robots-parser answers `undefined` when no group matches, when the URL is
    // unparseable, or when it belongs to another host. None of those is a
    // prohibition, and none of them is guesswork: "no rule forbids this" is
    // exactly what the protocol says to do.
    isAllowed: (url: string) => parsed.isAllowed(url, userAgent) !== false,
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
 * Documents are read one at a time. Discovery is a handful of requests on a
 * normal site, and serialising them is the politeness floor until the crawl
 * loop's governor owns the schedule.
 */
export async function discover(
  siteUrl: string,
  opts: DiscoveryOpts,
): Promise<DiscoveryResult> {
  const allowPrivate = opts.allowPrivate === true;
  const maxEntries = opts.maxEntries ?? MAX_SITEMAP_ENTRIES;

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

  const robots = await fetchRobots(siteUrl, opts);

  const queue: { url: string; depth: number }[] = [
    ...robots.sitemapUrls,
    ...(opts.extraSitemaps ?? []),
  ].map((url) => ({ url, depth: 0 }));

  const seen = new Set<string>();
  const entries = new Map<string, SitemapEntry>();

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

    truncation.docsFetched++;
    const doc = await fetchDoc(next.url, SITEMAP_MAX_BYTES, false, opts);
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

    const parsed = parseSitemapDoc(decodeBody(doc.body, doc.contentType));
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

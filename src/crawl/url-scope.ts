/**
 * Crawl scope: anchored wildcard patterns over the full URL.
 *
 * `*` matches any run of characters (including none); every other character is
 * literal and the match is case-sensitive and anchored at both ends. The same
 * patterns have an SQL form (`patternToLike`, `scopeRefusesSql`) so rules and
 * the resume re-filter ask the question in one statement; the parity test in
 * test/crawl/url-scope.test.ts pins the two forms row for row.
 */
import { sql, type SQL } from "drizzle-orm";

import { isSameOrigin } from "./parse/url-utils.js";

export interface CrawlScope {
  exclude: readonly string[];
  include: readonly string[];
}

export const EXCLUDED_REASON_PREFIX = "crawl scope: ";

/** Patterns per list (`exclude`, `include`), and characters per pattern. */
export const MAX_SCOPE_PATTERNS = 100;
export const MAX_PATTERN_LENGTH = 512;

/**
 * Leftmost occurrence of `pat` in `text[from, to)`, or -1. Knuth-Morris-Pratt,
 * O(|pat| + (to - from)) in the worst case (String.indexOf promises no bound).
 */
function kmpFind(text: string, from: number, to: number, pat: string): number {
  const m = pat.length;
  if (m === 0) return from;
  const fail = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && pat[i] !== pat[k]) k = fail[k - 1]!;
    if (pat[i] === pat[k]) k++;
    fail[i] = k;
  }
  for (let i = from, k = 0; i < to; i++) {
    while (k > 0 && text[i] !== pat[k]) k = fail[k - 1]!;
    if (text[i] === pat[k]) k++;
    if (k === m) return i - m + 1;
  }
  return -1;
}

/**
 * Anchored wildcard match in O(|pattern| + |url|). The pattern is split on `*`
 * into literal segments: the first must match at the URL start, the last at
 * its end, and each middle one is taken at its leftmost occurrence after the
 * previous (optimal for `*`, which can absorb anything between) by KMP. Never
 * a RegExp, so an agent-supplied pattern cannot cause catastrophic backtracking.
 */
export function matchesPattern(pattern: string, url: string): boolean {
  const segs = pattern.split("*");
  if (segs.length === 1) return pattern === url;
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;
  if (url.length < first.length + last.length) return false;
  if (!url.startsWith(first) || !url.endsWith(last)) return false;
  let pos = first.length;
  const end = url.length - last.length;
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (seg.length === 0) continue;
    const at = kmpFind(url, pos, end, seg);
    if (at === -1) return false;
    pos = at + seg.length;
  }
  return true;
}

export type ScopeVerdict = { admitted: true } | { admitted: false; reason: string };

/** Exclude first; then a non-empty include that nothing matches. */
export function scopeVerdict(url: string, scope: CrawlScope): ScopeVerdict {
  for (const pattern of scope.exclude) {
    if (matchesPattern(pattern, url)) {
      return {
        admitted: false,
        reason: `${EXCLUDED_REASON_PREFIX}matches exclude pattern '${pattern}'`,
      };
    }
  }
  if (scope.include.length > 0 && !scope.include.some((p) => matchesPattern(p, url))) {
    return { admitted: false, reason: `${EXCLUDED_REASON_PREFIX}matches no include pattern` };
  }
  return { admitted: true };
}

/** The pattern as a Postgres `LIKE … ESCAPE '\'` operand. */
export function patternToLike(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += "%";
    else if (ch === "\\" || ch === "%" || ch === "_") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

function likeAny(urlExpr: SQL, patterns: readonly string[]): SQL {
  const clauses = patterns.map((p) => sql`${urlExpr} LIKE ${patternToLike(p)} ESCAPE '\\'`);
  return sql.join(clauses, sql` OR `);
}

/**
 * True where `scopeVerdict` would refuse the URL. Patterns are bound
 * parameters, never spliced text. `false` for an empty scope. A NULL urlExpr
 * yields NULL, not true, so callers pass a non-null column.
 */
export function scopeRefusesSql(urlExpr: SQL, scope: CrawlScope): SQL {
  const parts: SQL[] = [];
  if (scope.exclude.length > 0) parts.push(sql`(${likeAny(urlExpr, scope.exclude)})`);
  if (scope.include.length > 0) parts.push(sql`NOT (${likeAny(urlExpr, scope.include)})`);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * SQL: the URL is in the crawl's site family, the family `isSameOrigin`
 * (src/crawl/parse/url-utils.ts) admits for `siteUrl`: the site's host or its
 * www/apex twin, same scheme and port, or an http->https default-port upgrade.
 * It mirrors `isSameOrigin` by enumerating the admissible origins in
 * TypeScript (each candidate is checked with `isSameOrigin` itself) and
 * matching the URL's `scheme://authority` prefix against them, so the two
 * cannot drift. NULL for a NULL urlExpr. Userinfo in the authority is not
 * understood (such a URL reads as off-origin, the safe direction here).
 */
export function sameOriginSql(urlExpr: SQL, siteUrl: string): SQL {
  const site = new URL(siteUrl);
  const bare = site.hostname.toLowerCase().replace(/^www\./, "");
  const origins: string[] = [];
  for (const host of [bare, `www.${bare}`]) {
    for (const scheme of ["http:", "https:"]) {
      for (const port of ["", site.port]) {
        const authority = port === "" ? host : `${host}:${port}`;
        const origin = `${scheme}//${authority}`;
        if (isSameOrigin(`${origin}/`, siteUrl) && !origins.includes(origin)) origins.push(origin);
      }
    }
  }
  return sql`lower(substring(${urlExpr} from '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*')) = any(${sql.param(origins)}::text[])`;
}

/**
 * True where the crawl's scope fenced the URL off: it is in the site family
 * (`sameOriginSql`) AND `scopeRefusesSql`. Frontier admission checks
 * `isSameOrigin` before the scope, so an off-origin URL is never a scope
 * decision and stays "not crawled" for the site-boundary reason.
 */
export function fencedOffSql(urlExpr: SQL, scope: CrawlScope, siteUrl: string): SQL {
  return sql`(${sameOriginSql(urlExpr, siteUrl)} AND ${scopeRefusesSql(urlExpr, scope)})`;
}

/** The schemes every stored URL starts with (admission refuses any other). */
const STORED_SCHEMES = ["http://", "https://"] as const;

/**
 * A message when the pattern can provably never match a URL this crawl
 * admits; null otherwise. The match is anchored and case-sensitive, and every
 * stored URL starts `http://` or `https://` with a lower-case scheme and host:
 *
 *  - an upper-case letter in a literal scheme or host never matches;
 *  - a non-empty literal prefix (up to the first `*`) that is neither a prefix
 *    of `http://` / `https://` nor starts with one never matches: `/cart*`,
 *    `/blog/*` and `example.com/*` are path or host rules missing their
 *    leading `*`;
 *  - a literal `scheme://host[:port]` is checked in the ONE direction
 *    admission asks it (loop.ts `enqueue`, the list check, `sameOriginSql`):
 *    `isSameOrigin(<a URL under it>, siteUrl)` — the site's host or its
 *    www/apex twin on the site's scheme and port, or https for a
 *    default-port http site. So `http://example.com/*` on an https site is
 *    refused: no http URL is ever admitted there. A pattern whose host a `*`
 *    cuts short (`https://*.ex.com/*`) is judged by its scheme alone.
 */
export function patternFamilyError(pattern: string, siteUrl: string): string | null {
  const star = pattern.indexOf("*");
  const prefix = star === -1 ? pattern : pattern.slice(0, star);
  const schemeEnd = prefix.indexOf("://");
  if (schemeEnd !== -1) {
    const slash = prefix.indexOf("/", schemeEnd + 3);
    const literalOrigin = slash === -1 ? prefix : prefix.slice(0, slash);
    if (/[A-Z]/.test(literalOrigin)) {
      return `pattern '${pattern}' has an upper-case letter in its scheme or host, so it can never match: stored URLs have a lower-case scheme and host and matching is case-sensitive`;
    }
  }
  if (
    prefix !== "" &&
    !STORED_SCHEMES.some((scheme) => scheme.startsWith(prefix) || prefix.startsWith(scheme))
  ) {
    return (
      `pattern '${pattern}' can never match: a pattern is matched against the whole URL ` +
      "from its first character, and every URL starts with http:// or https://. " +
      "A path rule needs a leading '*' (e.g. '*/cart*', '*/blog/*')"
    );
  }
  const scheme = STORED_SCHEMES.find((s) => prefix.startsWith(s));
  if (scheme === undefined) return null;
  const slash = prefix.indexOf("/", scheme.length);
  if (slash === -1 && star !== -1) {
    // The host is cut short by a `*`: only the scheme can be judged, spelled
    // onto the site's own host and port.
    if (isSameOrigin(`${scheme}${new URL(siteUrl).host}/`, siteUrl)) return null;
    return (
      `pattern '${pattern}' names the scheme ${scheme.slice(0, -3)}, which this crawl never ` +
      `admits for the site ${siteUrl}, so it can never match`
    );
  }
  const origin = slash === -1 ? prefix : prefix.slice(0, slash);
  const host = origin.slice(scheme.length);
  if (isSameOrigin(`${origin}/`, siteUrl)) return null;
  return (
    `pattern '${pattern}' names origin '${origin}' (host '${host}'), which this crawl never ` +
    `admits for the site ${siteUrl}: a crawl admits the site's host or its www/apex twin on ` +
    "the site's own scheme and port (or https for an http site on the default port), so " +
    "the pattern can never match"
  );
}

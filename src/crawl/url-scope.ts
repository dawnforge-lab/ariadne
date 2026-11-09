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

/**
 * Anchored wildcard match, linear in pattern + url length: the greedy
 * two-pointer algorithm with a single backtrack point (the last `*`). Never a
 * RegExp, so an agent-supplied pattern cannot cause catastrophic backtracking.
 */
export function matchesPattern(pattern: string, url: string): boolean {
  let p = 0;
  let u = 0;
  let starP = -1;
  let starU = 0;
  while (u < url.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starP = p++;
      starU = u;
    } else if (p < pattern.length && pattern[p] === url[u]) {
      p++;
      u++;
    } else if (starP !== -1) {
      p = starP + 1;
      u = ++starU;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
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
 * parameters, never spliced text. `false` for an empty scope.
 */
export function scopeRefusesSql(urlExpr: SQL, scope: CrawlScope): SQL {
  const parts: SQL[] = [];
  if (scope.exclude.length > 0) parts.push(sql`(${likeAny(urlExpr, scope.exclude)})`);
  if (scope.include.length > 0) parts.push(sql`NOT (${likeAny(urlExpr, scope.include)})`);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * A message when the pattern's literal prefix (up to the first `*`) names a
 * scheme and host that `isSameOrigin` rejects for the site; null otherwise.
 * A pattern whose host is cut short by a `*` (or that has no scheme) cannot
 * be judged here and is never refused.
 */
export function patternFamilyError(pattern: string, siteUrl: string): string | null {
  const star = pattern.indexOf("*");
  const prefix = star === -1 ? pattern : pattern.slice(0, star);
  const schemeEnd = prefix.indexOf("://");
  if (schemeEnd === -1) return null;
  const hostStart = schemeEnd + 3;
  const slash = prefix.indexOf("/", hostStart);
  if (slash === -1 && star !== -1) return null;
  const origin = slash === -1 ? prefix : prefix.slice(0, slash);
  const host = origin.slice(hostStart);
  // isSameOrigin admits an http->https upgrade one way only; a pattern may
  // name either spelling of the site, so ask both ways.
  if (isSameOrigin(origin, siteUrl) || isSameOrigin(siteUrl, origin)) return null;
  return `pattern '${pattern}' names host '${host}', which is not the crawl's site (${siteUrl}) or its www/apex, http/https spelling`;
}

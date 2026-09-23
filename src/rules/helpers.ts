import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { normalizeUrl } from "../crawl/parse/url-utils.js";
import { copyFor } from "./registry/copy/index.js";
import type { MetricTable } from "./registry/metric-table.js";
import { defineRule, RULESET_VERSION } from "./registry/registry.js";
import type {
  Finding,
  Metric,
  MetricRule,
  MetricScope,
  PageRecord,
  PageRule,
  RuleCategory,
  RuleColumn,
  Severity,
} from "./registry/types.js";

/**
 * A page whose on-page signals are meaningful: fetched OK as HTML with a 200.
 *
 * Takes the two columns it reads rather than a whole `PageRecord`, so a rule
 * holding a narrower projection of `pages` — the hreflang join rules select
 * four columns per target, not the row — asks the same question through the
 * same function instead of restating the condition beside it.
 */
export function isAuditable(page: Pick<PageRecord, "fetchClass" | "statusCode">): boolean {
  return page.fetchClass === "ok" && page.statusCode === 200;
}

/**
 * `isAuditable` for a rule that asks the question in SQL, over an aliased
 * `pages`. The hreflang marker reads its declaring pages this way and judges
 * the same pages `isAuditable` admits everywhere else in that file, so the two
 * halves of one rule are one predicate rather than a function and a string that
 * happen to say the same thing.
 *
 * NOT the same predicate as `JUDGED` below, which adds `is_indexable = true`
 * and the canonical exclusion: an hreflang annotation, a JavaScript redirect or
 * a soft 404 is worth reading on a page that is fetched and 200 whether or not
 * it carries a noindex or defers to another URL.
 */
export const FETCHED_OK = (alias: string): SQL =>
  sql.raw(`${alias}.fetch_class = 'ok' and ${alias}.status_code = 200`);

/**
 * Whether a stored string actually declares something. A tag that reached the
 * database as `""` or `"   "` — `<title> </title>`, `<link rel=canonical
 * href="">`, an empty robots meta — declares nothing, and reading it as a
 * declaration hides the page from the rule that reports its absence while
 * every other rule quietly accepts it: the always-passes hole hard rule 1
 * forbids. Blank is "not declared", everywhere in the rule layer.
 */
export function present(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/**
 * The three columns a canonical declaration is read from.
 *
 * A `Pick` rather than a whole `PageRecord`, for `isAuditable`'s reason: the
 * hreflang and link rules hold a narrow projection of `pages` — four columns
 * per target, not the row — and they must ask this question through these
 * functions rather than restating it beside their own row shape.
 */
export type CanonicalDeclaration = Pick<
  PageRecord,
  "url" | "canonicalHtml" | "canonicalHeader"
>;

/**
 * The canonical the page effectively declares. The HTML `<link rel=canonical>`
 * wins over the HTTP `Link` header because that is the order search engines
 * apply when both are present; `canonical.html-header-conflict` is what reports
 * the disagreement, so the other rules can work from one value.
 *
 * `present` is what "declares" means here: `<link rel=canonical href="">`
 * reaches the database as an empty string, and an empty href names no URL.
 */
export function effectiveCanonical(page: CanonicalDeclaration): string | null {
  if (present(page.canonicalHtml)) return page.canonicalHtml;
  return present(page.canonicalHeader) ? page.canonicalHeader : null;
}

/**
 * Where a declared canonical actually points, as a comparable key, or `null`
 * when the value is not a URL we can resolve at all. Relative values resolve
 * against the page URL first, so `/x` on `https://example.com/page` is
 * `https://example.com/x` — the same resolution a browser and a crawler do.
 *
 * `normalizeUrl` is the one authority for URL identity in this codebase, and
 * both sides of every comparison below go through it, so a fragment, a
 * hostname's case or query-parameter order is never mistaken for a difference.
 */
export function resolveCanonical(canonical: string, pageUrl: string): string | null {
  return normalizeUrl(canonical, pageUrl);
}

export interface CanonicalTarget {
  /** The declared value, verbatim, for the evidence. */
  canonical: string;
  /** The normalized target, or null when the declared value does not parse. */
  resolved: string | null;
  /** True when the canonical resolves to a URL that is not this page. */
  pointsElsewhere: boolean;
}

/**
 * What a page's canonical declaration comes to: the declared value, where it
 * resolves, and whether that is somewhere other than this page — or `null` when
 * the page declares no canonical at all.
 *
 * MOVED HERE FROM src/rules/page/canonical.ts (Phase 19), which re-exports it
 * at its old address. It was already shared by the query rules that judge the
 * canonical's *target* (`canonical.non-200-target`, `canonical.non-indexable-
 * target`, `url.*`, `pagination.*`); Phase 19 gave it a second class of caller
 * — every rule that must not judge a page which has handed its signals to
 * another URL (`isCanonicalisedElsewhere`) — and a resolution the exclusion and
 * the finding could disagree about is the one thing that pairing must not have.
 * One resolution, one precedence order (HTML over header), one normalizer.
 */
export function resolveEffectiveCanonical(page: CanonicalDeclaration): CanonicalTarget | null {
  const canonical = effectiveCanonical(page);
  if (canonical === null) return null;
  const resolved = resolveCanonical(canonical, page.url);
  const pageNormalized = normalizeUrl(page.url);
  return {
    canonical,
    resolved,
    pointsElsewhere: resolved !== null && resolved !== pageNormalized,
  };
}

/**
 * A page that has handed its indexing signals to another URL: it declares a
 * canonical (HTML first, header second) and that canonical resolves to a URL
 * which is not this page.
 *
 * Such a page is not a page a search engine ranks — it is a request to treat
 * some other URL as the real one — so the rules that judge what a page SAYS
 * about itself skip it: a duplicate body under a tracking parameter, an
 * hreflang block inherited from the template it is a variant of, are the
 * situation the canonical already fixes, and reporting them is reporting the
 * remedy as the fault (Phase 19 §1).
 *
 * The exclusion is BY THE DECLARATION ONLY. Whether the canonical target is
 * itself sound — a 200, indexable, not a redirect — is `canonical.*`'s
 * business and is already reported there, so a page is invisible to the rules
 * below whether or not the URL it names turns out to be a good one.
 *
 * A canonical that does not resolve to a URL at all (`href="not a url"`) is NOT
 * "elsewhere": it names nowhere, the page keeps its own signals, and
 * `canonical.points-elsewhere` reports the malformation. Silence is the
 * expensive mistake here (hard rule 1), so the doubtful case stays visible.
 */
export function isCanonicalisedElsewhere(page: CanonicalDeclaration): boolean {
  return resolveEffectiveCanonical(page)?.pointsElsewhere === true;
}

/**
 * The columns the judged cohort is decided from — a `Pick` rather than a whole
 * `PageRecord`, for `isAuditable`'s reason: a rule holding a narrower
 * projection of `pages` must ask this question through this function rather
 * than restating it beside its own row shape.
 */
export type JudgedInput = CanonicalDeclaration &
  Pick<PageRecord, "fetchClass" | "statusCode" | "isIndexable">;

/**
 * THE JUDGED PAGE: one the audit reports defects on AS ITS OWN PAGE — fetched
 * OK with a 200, indexable, and not canonicalised elsewhere (Phase 22 §1).
 *
 * Composed from the two cohorts that were already here rather than restated:
 * `isAuditable` (fetched OK, 200), the stored `is_indexable` and
 * `isCanonicalisedElsewhere`. The owner's rule, reading the raelon.ca crawl:
 * "if a page is indexable or not or it has other rules in place that doesn't
 * make it an error" — a noindex page is out of the index and a canonicalised
 * one has handed its signals to another URL, so a duplicate title, a thin body
 * or an incomplete Product block on either belongs to the URL it defers to and
 * not to it. `site.health`'s `urlsCanonicalised` and `urlsNoindex` are what
 * stop that exclusion from being silent (hard rule 1).
 *
 * WHICH RULES DELIBERATELY DO NOT USE IT, because their subject is the very
 * thing this predicate excludes or is true whatever the page's directives say:
 *
 *  - the canonical rules (`canonical.*`, `directive.canonical-noindex-conflict`)
 *    — their subject IS the canonical;
 *  - `indexability.noindex`, `indexability.meta-header-conflict` — their
 *    subject is the directive;
 *  - the response-code rules (`http.server-error*`, `crawl.blocked`,
 *    `links.broken-internal`, `links.to-server-error`) — a 404 is a 404;
 *  - `content.soft-404` — a 200 that is really a not-found is a fault whatever
 *    its canonical or its robots meta says (fetched OK + 200, indexable or not);
 *  - the sitemap-entry rules (`sitemap.non-200`, `.redirected`,
 *    `.non-indexable`, `.uncrawled`, `robots.blocks-sitemap-urls`) — their
 *    subject is the sitemap ENTRY, and a canonicalised entry is precisely what
 *    `sitemap.non-indexable` now also reports;
 *  - the resource rules (`resources.*`, `images.oversized`,
 *    `images.legacy-format`) — their subject is the file;
 *  - the render rules (`content.csr-dependent`, `nav.js-only`,
 *    `filters.js-only`, `redirect.js`) — a canonicalised page rendered by the
 *    sample is still evidence about the template;
 *  - `url.normalisation-variants`, `url.tracking-params-internal`, `hreflang.*`
 *    (canonical-aware since Phase 19) and `pagination.*`.
 *
 * `isIndexable` is READ here and not recomputed from the robots columns, so
 * that this and `JUDGED` — which has only the column — decide the same pages.
 * `indexabilityOf` is where the column is checked against the directives it was
 * written from, and it throws when they disagree (hard rule 7), so a `true`
 * column beside a noindex meta never reaches a rule as a silent judgement.
 */
export function isJudged(page: JudgedInput): boolean {
  return isAuditable(page) && page.isIndexable === true && !isCanonicalisedElsewhere(page);
}

/**
 * The declared value with its fragment removed — `normalizeUrl`'s `hash = ""`.
 * Every step below reads this rather than the raw column.
 */
const NO_FRAGMENT = (value: string): string => `split_part(${value}, '#', 1)`;

/**
 * `scheme://authority` lower-cased with a default port dropped, followed by the
 * path — everything `normalizeUrl` settles about a URL except its query.
 *
 * The authority is the run between `//` and the first `/`, `?` or `#`, and ONLY
 * that run is lower-cased: a path is case-sensitive on every server that serves
 * one, so `/Page` and `/page` are two URLs and lower-casing here would answer
 * "self" for a canonical that genuinely names another. An empty path becomes
 * `/`, which is what `new URL` does with `https://example.com`.
 *
 * The port rule is looser than WHATWG's on purpose: `:80` and `:443` are
 * dropped from either scheme rather than each from its own. `https://x:80/p` is
 * therefore read as `https://x/p` where `normalizeUrl` keeps the port — a
 * disagreement that can only answer "self" where TypeScript answers
 * "elsewhere", which is the harmless direction (see the doc block below).
 */
const ORIGIN_AND_PATH = (value: string): string => {
  const f = NO_FRAGMENT(value);
  return (
    `regexp_replace(lower(substring(${f} from '^[^/?#]*//[^/?#]*')), ':(80|443)$', '')` +
    ` || coalesce(nullif(split_part(` +
    `coalesce(substring(${f} from '^[^/?#]*//[^/?#]*(.*)$'), ''), '?', 1), ''), '/')`
  );
};

/**
 * The query string as a SET of `k=v` pairs, which is how the two sides are
 * compared: `normalizeUrl` calls `searchParams.sort()`, so `?b=2&a=1` and
 * `?a=1&b=2` are one URL, and a comparison that read the string would answer
 * "elsewhere" for a page canonicalising to itself — the wrong "yes" hard rule 1
 * forbids. Set equality rather than a sort because it is one expression with no
 * correlated subquery, and it errs the same safe way on the case the two forms
 * differ on (a repeated key, noted below). Empty members are removed so a
 * trailing `?` or `&` — which `URLSearchParams` drops — is not a difference.
 */
const QUERY_SET = (value: string): string =>
  `array_remove(string_to_array(` +
  `coalesce(substring(${NO_FRAGMENT(value)} from '[?](.*)$'), ''), '&'), '')`;

/**
 * Whether the steps above can settle this value at all. Three shapes they
 * cannot, and each makes the whole test answer NO rather than guess:
 *
 *  - anything with a byte outside ASCII (`octet_length <> length`): `new URL`
 *    punycodes a host and percent-encodes a path, and SQL does neither;
 *  - whitespace or a backslash: `new URL` strips tabs and newlines and rewrites
 *    `\` to `/` for http(s), and a raw space becomes `%20`;
 *  - a dot segment (`/../`, `/./`): `new URL` resolves it away.
 *
 * Each of these could otherwise make two spellings of ONE URL compare unequal,
 * which is the silencing direction. `%2e` as an encoded dot segment is not
 * caught — see the residuals in the doc block below.
 */
const SQL_SETTLEABLE = (value: string): string =>
  `octet_length(${value}) = length(${value}) ` +
  `and ${value} !~ '[[:space:]\\\\]' ` +
  `and ${NO_FRAGMENT(value)} !~ '/[.][.]?(/|$)'`;

/**
 * `isCanonicalisedElsewhere` for a rule whose question is a GROUP rather than a
 * row: the same test, in SQL, over an aliased `pages`.
 *
 * SQL cannot run `normalizeUrl`, so this applies `normalizeUrl`'s steps to BOTH
 * SIDES as SQL expressions — fragment stripped, scheme and host lower-cased,
 * default port dropped, empty path made `/`, query compared as a set — and
 * compares the results. It used to compare the declared string to
 * `pages.url` and `pages.url_normalised` verbatim, which answered "elsewhere"
 * for a self-canonical carrying a `#top`, an upper-cased host or its query
 * parameters in another order: a wrong "yes" that drops the page from both
 * duplicate rules and every hreflang rule without saying so (hard rule 1).
 *
 * WHERE IT STILL ANSWERS NO WITHOUT LOOKING. A relative canonical (`/page`) is
 * never read as "elsewhere" here — SQL has no base URL to resolve against — and
 * neither is a value `SQL_SETTLEABLE` rejects. The asymmetry is deliberate and
 * is the same one throughout this file: a wrong "yes" SILENCES a rule, a wrong
 * "no" only leaves a finding a reader can dismiss.
 *
 * WHAT THE TWO FORMS CAN STILL DISAGREE ABOUT, and in which direction. Every
 * one of these is SQL answering "not elsewhere" where `isCanonicalisedElsewhere`
 * answers "elsewhere" — the page stays visible to the rules, never the reverse:
 *
 *  - a relative canonical, and any value with non-ASCII, whitespace, a
 *    backslash or a dot segment in it (above);
 *  - `:80` on https or `:443` on http (the loose port rule above);
 *  - a query whose keys repeat: `?a=2&a=1` and `?a=1&a=2` are two URLs to
 *    `searchParams.sort()`, which is stable and so keeps the values in the
 *    order it met them, and one set here. `?a=1&a=1` and `?a=1` likewise;
 *  - `%2e%2e` as an encoded dot segment, which `new URL` resolves and the guard
 *    above does not catch;
 *  - userinfo (`https://User@host/p`), whose case `new URL` preserves and the
 *    authority lower-casing here does not.
 *
 * `pages.url_normalised` is no longer consulted. It is not `normalizeUrl(url)`
 * — the writer lower-cases the WHOLE string and strips a trailing slash on top
 * of it (src/crawl/persist.ts), an analytic key — so a canonical matching it
 * matched a lossier URL than the TypeScript form compares against, and a page
 * at `/Page/` canonicalising to `/page` read as self here and as elsewhere
 * there. `ORIGIN_AND_PATH(url)` is the exact comparison instead, and the two
 * forms are pinned against each other case by case in test/rules/helpers.test.ts.
 *
 * THREE-VALUED LOGIC IS COALESCED AWAY, and that is load-bearing: a page with
 * no canonical at all leaves the comparison NULL, and `not (NULL)` is NULL, so
 * an uncoalesced form would drop exactly the pages it is meant to KEEP from
 * every `and not CANONICALISED_ELSEWHERE(p)` filter. False means "not
 * canonicalised elsewhere", including "declares nothing".
 */
export const CANONICALISED_ELSEWHERE = (alias: string): SQL => {
  const declared =
    `coalesce(nullif(btrim(${alias}.canonical_html), ''), ` +
    `nullif(btrim(${alias}.canonical_header), ''))`;
  const url = `${alias}.url`;
  return sql.raw(
    `coalesce(${declared} ~* '^https?://'` +
      ` and (${SQL_SETTLEABLE(declared)})` +
      ` and (${ORIGIN_AND_PATH(declared)} is distinct from ${ORIGIN_AND_PATH(url)}` +
      ` or not (${QUERY_SET(declared)} <@ ${QUERY_SET(url)}` +
      ` and ${QUERY_SET(url)} <@ ${QUERY_SET(declared)})), false)`,
  );
};

/**
 * A URL as a comparison key, in SQL: `normalizeUrl`'s settled form of it, as far
 * as SQL can settle it — fragment stripped, scheme and authority lower-cased, a
 * default port dropped, an empty path made `/`, and the query sorted so
 * `?b=2&a=1` and `?a=1&b=2` are one key.
 *
 * THE TYPESCRIPT TWIN IS `targetKey` (src/rules/query/hreflang.ts), which runs
 * `normalizeUrl` itself. This cannot — SQL has no URL parser — so it applies the
 * same steps as string operations, exactly as `CANONICALISED_ELSEWHERE` does,
 * and it is used where BOTH SIDES go through it: `pages.url` (already
 * `normalizeUrl` output) against `hreflang.target_url` (a plain absolute href).
 * Where the two spellings differ in something this cannot settle — a
 * percent-encoding, a non-ASCII host, a dot segment — the keys differ, the two
 * URLs do not match, and the effect is a cluster that fails to form: a duplicate
 * group reported that might have been collapsed, never a group silenced. That
 * is the safe direction (hard rule 1), and it is the same asymmetry every URL
 * comparison in this file is built on.
 */
export const URL_MATCH_KEY = (value: string): SQL =>
  sql.raw(
    `(${ORIGIN_AND_PATH(value)} || '?' || coalesce(` +
      `(select string_agg(kv, '&' order by kv) from unnest(${QUERY_SET(value)}) as kv), ''))`,
  );

/**
 * `isJudged` for a rule that asks the question in SQL, over an aliased `pages`:
 * fetched OK with a 200, indexable, and not canonicalised elsewhere.
 *
 * ONE SPELLING, and that is the point of it. Before Phase 22 this condition was
 * written out in nine files — `content.ts`'s private `AUDITABLE`,
 * `field-duplicates.ts`'s and `structured-data.ts`'s and `link-graph.ts`'s
 * `INDEXABLE`, and five inline `fetch_class = 'ok' and status_code = 200`
 * fragments — three of which had already been given the canonical exclusion and
 * six of which had not, so whether a canonicalised page was judged depended on
 * which rule was asking. The cohort and the list of rules that deliberately
 * stay outside it are documented on `isJudged` above; this is the same
 * predicate for the rules whose question is a GROUP rather than a row, and
 * test/rules/helpers.test.ts pins the two against each other case by case.
 *
 * PARENTHESISED, unlike `FETCHED_OK`: it contains a `not`, and a caller
 * interpolating it into anything but a chain of `and`s would otherwise bind it
 * wrongly and silently.
 *
 * `is_indexable = true`, SPELLED AS A PLAIN EQUALITY AND NOT WRAPPED, and that
 * is a measured requirement rather than a style. The three partial duplicate
 * indexes are built `where fetch_class = 'ok' and status_code = 200 and
 * is_indexable = true and <field> is not null` (`pages_dupe_title` and its two
 * siblings, src/db/schema.ts), and Postgres uses a partial index only when it
 * can PROVE the query's WHERE implies the index's — which it does for these
 * three clauses as written here, and does NOT do for `coalesce(… , false)`
 * around them or for `is_indexable IS TRUE`. Both of those were tried against
 * the reference crawl and both lost `pages_dupe_title` to a whole-crawl bitmap
 * scan: a slow query, never an error, which is the failure that hides. Keep the
 * three clauses conjunctive and unwrapped; anything ADDED beside them (the
 * canonical exclusion below) only restricts further and costs nothing.
 *
 * THE PRICE IS THREE-VALUED LOGIC, and the rule it imposes on callers: a NULL
 * `is_indexable` — which no crawl this engine writes produces (see
 * `indexabilityOf`), the column being nullable only for rows no writer here
 * made — leaves this expression NULL rather than false. Every WHERE clause
 * reads that as "no", which is the right answer and is how all ten callers use
 * it. **Never negate it.** `and not JUDGED(p)` would drop a null-flagged row
 * from both sides of a partition, and that is the page that vanishes without a
 * number (hard rule 1). `site.health` counts the pages the cohort sets aside by
 * spelling their conditions out for exactly this reason, and
 * test/rules/helpers.test.ts pins the NULL case so the property cannot be
 * forgotten.
 */
export const JUDGED = (alias: string): SQL =>
  sql`(${FETCHED_OK(alias)} and ${sql.raw(
    `${alias}.is_indexable = true`,
  )} and not ${CANONICALISED_ELSEWHERE(alias)})`;

/**
 * `none` as a whole directive: the list is comma- and space-delimited, so the
 * token has to be bounded on both sides. A substring test would read "nonevent"
 * as a directive and hide the page from every rule below.
 */
const NONE_DIRECTIVE = /(?:^|[\s,])none(?:[\s,]|$)/i;

/**
 * Whether a robots directive string asks for noindex. Substring match for
 * `noindex` itself, because the directive arrives as a comma list
 * ("max-snippet:-1, noindex, nofollow") and the value is stored verbatim.
 *
 * `none` counts too: it is Google's shorthand for "noindex, nofollow", and a
 * page carrying it is out of the index just as surely as one that spelled the
 * directive out.
 *
 * MOVED HERE FROM src/rules/page/indexability.ts (Phase 20), which re-exports
 * it at its old address, for the reason `resolveEffectiveCanonical` moved: the
 * function now has a second class of caller — `indexabilityOf`, which every
 * finding row on the API surface is labelled by — and helpers.ts cannot import
 * from a rule file that imports helpers.ts. One definition of "noindex", read
 * by the rule that reports it and by the column that labels every other rule's
 * rows.
 *
 * MIRRORED IN `isIndexable` (src/crawl/persist.ts), which stamps
 * `pages.is_indexable` at crawl time from the same two robots sources. The two
 * must agree — a page this function calls noindex and that column calls
 * indexable is a contradiction the report cannot resolve. Change one, change
 * the other.
 */
export function saysNoindex(value: string | null): boolean {
  return present(value) && (/noindex/i.test(value) || NONE_DIRECTIVE.test(value));
}

/** The two robots channels a page can carry a directive on. */
export type RobotsDeclaration = Pick<PageRecord, "robotsMeta" | "xRobotsTag">;

/** Whether either robots source on this page asks for noindex. */
export function hasNoindex(page: RobotsDeclaration): boolean {
  return saysNoindex(page.robotsMeta) || saysNoindex(page.xRobotsTag);
}

/**
 * The columns `indexabilityOf` reads. A `Pick` rather than a whole `PageRecord`
 * for `isAuditable`'s reason: the API's listing query holds a narrow projection
 * of `pages` (`ISSUE_PAGE_COLUMNS`, src/api/service.ts) and must ask this
 * question through this function rather than restating it in SQL.
 */
export type IndexabilityInput = CanonicalDeclaration &
  RobotsDeclaration &
  Pick<PageRecord, "fetchClass" | "statusCode" | "isIndexable">;

/** The two words the `indexability` column can hold. */
export type Indexability = "Indexable" | "Non-Indexable";

/**
 * Why a URL is not indexable, in the closed vocabulary the reports print.
 * The empty string is the value an INDEXABLE row carries: there is no reason,
 * and an empty cell is what a reader expects to see beside "Indexable".
 */
export type IndexabilityStatus =
  | ""
  | "Noindex"
  | "Canonicalised"
  | "Redirected"
  | "Client Error"
  | "Server Error"
  | "Blocked by robots.txt"
  | "Blocked by bot protection"
  | "No Response"
  | "Not HTML";

/**
 * THE TWO STANDARD COLUMNS EVERY FINDING ROW CARRIES, derived from the `pages`
 * row the finding names: is this URL indexable, and if not, why.
 *
 * ONE HELPER, and that is the point of it. Screaming Frog prints `Indexability`
 * and `Indexability Status` on every per-issue export, and a client reading a
 * "sitemap contains non-indexable URLs" report wants to know WHICH KIND of
 * non-indexable each row is without opening a second report. Every surface here
 * — the JSON listing, the CSV, the demo table — reads this function, so the
 * three cannot disagree about a page.
 *
 * ## The precedence, and why it is this order
 *
 * The conditions overlap: a 301 can carry a noindex meta, a 404 page can
 * declare a canonical. The order below is the order in which the fact SETTLES
 * what a search engine does with the URL, most decisive first — a redirect is
 * never indexed whatever its HTML says, and a 200's own directives only matter
 * once there is a 200.
 *
 *  1. `redirect`            -> `Redirected`             (the URL is not a page)
 *  2. `client_error`        -> `Client Error`
 *  3. `server_error`        -> `Server Error`
 *  4. `blocked`             -> `Blocked by bot protection`
 *  5. `disallowed`          -> `Blocked by robots.txt`
 *  6. `timeout`, `network_error` -> `No Response`
 *  7. `non_html`, `too_large`, `unsupported_encoding` -> `Not HTML`
 *  8. `ok` and a status that is not 200 -> `Not HTML`
 *  9. `ok` 200 + noindex on either robots channel -> `Noindex`
 * 10. `ok` 200 + a canonical naming another URL   -> `Canonicalised`
 * 11. otherwise                                    -> `Indexable`, status `""`
 *
 * Three of those groupings are decisions rather than readings, and each is a
 * choice between members of a closed vocabulary rather than a place to invent
 * a value:
 *
 *  - **`blocked` is its own status, whatever the wire said.** The class means
 *    the site refused THIS CLIENT — a WAF challenge, a 401/403/429, a
 *    `cf-mitigated` header on any status — so it is never `No Response` (we did
 *    get an answer) and never `Blocked by robots.txt` (robots.txt said
 *    nothing). It is not read off the status code either: a challenge is
 *    routinely served with a 200, and printing `Status Code: 200 |
 *    Indexability Status: Client Error` contradicts itself on the very rule
 *    (`crawl.blocked`) whose subject is that distinction. The status code is
 *    already its own column and `crawl.blocked`'s `fetchReason` (headed `Block
 *    Reason`) names the mechanism, so this
 *    column says the one thing neither of those says: the answer we got was a
 *    refusal, not a page. Every `blocked` row reads `Blocked by bot
 *    protection` — including the 5xx challenge, which is a block wearing a
 *    server error's clothes, not an outage.
 *  - **`too_large` and `unsupported_encoding` join `non_html`.** All three mean
 *    the same thing to a reader: the response arrived and produced no HTML this
 *    engine could read, so there is nothing to judge indexability FROM. The
 *    causes differ (a body past the read cap, a `content-encoding` we do not
 *    implement, a content type that was never HTML) and `fetchClass` is where a
 *    reader finds out which — that column is on `pages_query` and on the
 *    `internal_urls` export, and this one is not a second copy of it.
 *  - **`ok` with a status that is not 200** — a 204, a 206 — is `Not HTML` for
 *    the same reason: `pages.is_indexable` is false on it by construction
 *    (src/crawl/persist.ts requires the 200), and no body was analysed.
 *
 * ## `is_indexable` is asserted against, not read
 *
 * The column is the crawler's own stamp (`isIndexable`, src/crawl/persist.ts):
 * a 200, fetched ok, with no noindex on either channel. That is exactly cases
 * 8-11 above minus the canonical, so this function computes the same answer
 * from the same columns and — on every `ok` row, the non-200s included — uses
 * the stored boolean as a CHECK on itself: a row
 * where the two disagree — `is_indexable = true` on a page this function calls
 * `Noindex`, say — is a writer defect or a hand-edited row, and it throws
 * rather than printing one of the two answers and dropping the other (hard rule
 * 7). `Canonicalised` is the one status the column cannot express, and it is
 * the one case where a `true` column and a `Non-Indexable` verdict are both
 * right: a canonicalised page IS crawled and indexable, it has simply handed
 * its signals elsewhere, which is why the check exempts it.
 *
 * A `null` `is_indexable` asserts nothing, and no crawl this engine writes
 * produces one: `PageWriter` computes a boolean for every row it inserts
 * (src/crawl/persist.ts), including the ones that were never fetched as HTML,
 * where the answer is simply `false`. The column is nullable in the schema and
 * the null branch here is defensive for that reason alone — a hand-edited row,
 * a row from a future writer, a projection that lost the column — and it
 * declines to assert rather than inventing an agreement it cannot check.
 */
export function indexabilityOf(page: IndexabilityInput): {
  indexability: Indexability;
  status: IndexabilityStatus;
} {
  const nonIndexable = (status: IndexabilityStatus): {
    indexability: Indexability;
    status: IndexabilityStatus;
  } => ({ indexability: "Non-Indexable", status });

  switch (page.fetchClass) {
    case "redirect":
      return nonIndexable("Redirected");
    case "client_error":
      return nonIndexable("Client Error");
    case "server_error":
      return nonIndexable("Server Error");
    case "blocked":
      return nonIndexable("Blocked by bot protection");
    case "disallowed":
      return nonIndexable("Blocked by robots.txt");
    case "timeout":
    case "network_error":
      return nonIndexable("No Response");
    case "non_html":
    case "too_large":
    case "unsupported_encoding":
      return nonIndexable("Not HTML");
    case "ok":
      break;
    default:
      // A `fetch_class` this function has never met. It is a `text` column, so
      // the type system has not seen it, and the honest answer to "is this
      // indexable" is not a guess: `FETCH_CLASSES` is the closed vocabulary and
      // a member added there without a case here is a defect to surface.
      throw new Error(
        `indexabilityOf: unknown fetch_class '${page.fetchClass}' — add it to the ` +
          "precedence in src/rules/helpers.ts rather than letting a row be labelled " +
          "by a default",
      );
  }

  // An `ok` row that is not a 200 goes through the same check as the rest: the
  // writer requires the 200 too, so `is_indexable = true` beside a 204 is the
  // same class of writer defect as a `true` beside a noindex, and returning
  // early here would be the one `ok` row that escaped its own audit.
  const answer =
    page.statusCode !== 200
      ? nonIndexable("Not HTML")
      : hasNoindex(page)
        ? nonIndexable("Noindex")
        : isCanonicalisedElsewhere(page)
          ? nonIndexable("Canonicalised")
          : { indexability: "Indexable" as const, status: "" as const };

  // The stored column as a check on this computation, never as its source. The
  // canonical is invisible to `is_indexable`, so a `Canonicalised` row is the
  // one place the two legitimately differ.
  if (page.isIndexable !== null && answer.status !== "Canonicalised") {
    const expected = answer.indexability === "Indexable";
    if (page.isIndexable !== expected) {
      throw new Error(
        `indexabilityOf: '${page.url}' stores is_indexable=${String(page.isIndexable)} ` +
          `but its status and robots directives read '${answer.status || "Indexable"}' — ` +
          "the crawl writer (src/crawl/persist.ts) and this function must agree about " +
          "indexability",
      );
    }
  }
  return answer;
}

/**
 * The identity a finding is stamped with. `pageRule` hands this to the rule
 * body so the id and severity are written once, in the rule's definition,
 * rather than restated inside it where they can drift.
 */
export interface RuleIdentity {
  id: string;
  severity: Severity;
}

export function finding(
  rule: RuleIdentity,
  page: PageRecord,
  evidence: Record<string, unknown>,
): Finding {
  return {
    ruleId: rule.id,
    pageId: page.id,
    pageUrl: page.url,
    severity: rule.severity,
    evidence,
    dedupeKey: page.url,
  };
}

/**
 * The query rules' twin of `finding`. A query rule builds its findings from
 * SQL rows rather than from a `pages` record, so it names the page itself —
 * but the id and severity still come from the rule's own identity rather than
 * being restated per finding, which is where the two can drift apart.
 */
export function queryFinding(
  self: RuleIdentity,
  f: {
    pageId: string | null;
    pageUrl: string | null;
    evidence: Record<string, unknown>;
    dedupeKey: string;
  },
): Finding {
  // Destructured field by field rather than spread: a spread of `f` — wherever
  // it sits in the literal — carries whatever else the caller's object holds,
  // and a `ruleId` or `severity` that arrived from a SQL row (`select *` into
  // the payload, say) would either override the rule's own identity or ride
  // along into the `issues` row. The identity is single-sourced from `self`,
  // and only the four fields named here come from the caller.
  const { pageId, pageUrl, evidence, dedupeKey } = f;
  return { ruleId: self.id, pageId, pageUrl, severity: self.severity, evidence, dedupeKey };
}

/**
 * The metric rules' twin of `queryFinding`. A metric rule produces numbers
 * rather than accusations, so there is no page and no severity to carry — but
 * the identity question is the same one, and sharper: the runner deletes a
 * metric rule's rows for the crawl with `metric_id = <the rule's id>` before
 * inserting its fresh set, so a row filed under any other metric id would never
 * be recomputed and never removed. `metricId` therefore comes from `self` and
 * from nowhere else.
 *
 * The parameter is a discriminated union rather than one shape with an optional
 * `scopeValue`, because the two scopes ask for different things and the optional
 * spelling let a caller write both of the rows the runner refuses:
 *
 *   - every scope but `site` REQUIRES a name. A `page_type` row is the answer
 *     for one group of pages and a `sitemap_doc` row the answer for one sitemap
 *     document; without a name neither identifies what it counted, and the empty
 *     string is already spoken for — it is what a site row stores in the
 *     composite primary key `(crawl_id, metric_id, scope, scope_value)`.
 *   - `site` ACCEPTS no name. There is one site per crawl, so a scope value on
 *     it would key a second "site" row and answer the same question twice.
 *
 * Both are now unrepresentable for a caller that uses this helper. The runner
 * checks them again at the JavaScript boundary, where a rule body's return value
 * is not something the type system has seen.
 */
/**
 * The identity a metric row is stamped with — an id and nothing else.
 *
 * A metric carries no severity (it accuses no one) and names no page, so where
 * `RuleIdentity` has two fields this has one. It exists as a named type all the
 * same, because it is the thing `metricRow` refuses to take from anywhere but
 * the rule's own definition: the runner deletes a metric rule's rows by
 * `metric_id = <the rule's id>`, so a row filed under any other id is a row
 * nothing ever recomputes or removes.
 */
export interface MetricIdentity {
  id: string;
}

export function metricRow(
  self: MetricIdentity,
  m:
    | { scope: "site"; value: Record<string, unknown> }
    | {
        scope: Exclude<MetricScope, "site">;
        scopeValue: string;
        value: Record<string, unknown>;
      },
): Metric {
  // Each field named rather than spread, for `queryFinding`'s reason: a spread
  // of `m` would carry whatever else the caller's object holds — a `metricId`
  // read out of a SQL row, say — either overriding the rule's own identity or
  // riding along into the `metrics` row.
  if (m.scope === "site") {
    return { metricId: self.id, scope: "site", scopeValue: "", value: m.value };
  }
  return { metricId: self.id, scope: m.scope, scopeValue: m.scopeValue, value: m.value };
}

/**
 * Define a page rule: the registry metadata, the client-facing copy (which
 * `copyFor` throws for if it is missing — a rule cannot ship untitled) and the
 * ruleset version, assembled around a body that receives the page and the
 * rule's own identity.
 *
 * One definition, imported by every page-rule file, so the shape of a rule is
 * stated in a single place.
 */
export function pageRule(
  id: string,
  checkIds: string[],
  category: RuleCategory,
  severity: Severity,
  // THE REPORT'S COLUMNS, positional and required, immediately before the body
  // that writes the evidence they name — so the declaration and the object
  // literal it describes are read together. An EMPTY array is the answer for a
  // rule whose report is the four standard columns and nothing else; see
  // `RuleMeta.columns`.
  columns: ReadonlyArray<RuleColumn>,
  run: (page: PageRecord, self: RuleIdentity) => Finding[],
  // The NOT MEASURED marker flag, threaded through so a page-rule marker
  // (`content.thin-skipped`) declares itself the same one way every other marker
  // does. See `RuleMeta.marker`: present only on a marker, the value its reason.
  marker?: string,
): PageRule {
  const self: RuleIdentity = { id, severity };
  return defineRule<PageRule>({
    kind: "page",
    id,
    checkIds,
    category,
    severity,
    columns,
    ...copyFor(id),
    rulesetVersion: RULESET_VERSION,
    ...(marker === undefined ? {} : { marker }),
    run: (page) => run(page, self),
  });
}

/**
 * Define a metric rule: `pageRule`'s twin for the kind that produces numbers.
 *
 * Same job — registry metadata, the copy `copyFor` throws for if it is missing,
 * the ruleset version — and the same reason to be a factory rather than four
 * spelled-out object literals: the id appears in three places that must agree
 * (the registry key, the `copyFor` lookup, and the `metricId` stamped on every
 * row the rule emits), and here it is written once and handed to the body as
 * `self`. A rule that restated its own id in a `metricRow` call could drift
 * from the id the runner deletes by, which is the one drift the metrics table
 * cannot survive: rows nothing owns are never recomputed and never removed.
 *
 * `severity` is not a parameter, unlike `pageRule`'s. A metric states what was
 * counted; it accuses the site of nothing, and the judgement is the agent's —
 * so `info` is not a default here, it is the only value the kind can have.
 *
 * `table` IS a parameter, positional and required, immediately before the body
 * that writes the values it names — `pageRule`'s `columns`, for the kind that
 * measures. It is the metric's report: the shaper that turns the rows the body
 * below returns into rows a client reads, and the label over every one of their
 * columns (src/rules/registry/metric-table.ts). Declaring it beside the body
 * rather than in a table somewhere else is what lets the two be read together,
 * and `defineRule` refuses a metric rule without one.
 */
export function metricRule(
  id: string,
  checkIds: string[],
  category: RuleCategory,
  table: MetricTable,
  run: (db: Db, crawlId: string, self: MetricIdentity) => Promise<Metric[]>,
): MetricRule {
  const self: MetricIdentity = { id };
  return defineRule<MetricRule>({
    kind: "metric",
    id,
    checkIds,
    category,
    severity: "info",
    ...copyFor(id),
    rulesetVersion: RULESET_VERSION,
    table,
    run: (db, crawlId) => run(db, crawlId, self),
  });
}

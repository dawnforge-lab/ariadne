/**
 * The URL-hygiene rules: what the site's own URLs say about how many of them
 * there are.
 *
 * Three questions, all of them about sets of URLs rather than about one page,
 * which is why none of them can be a page rule: the same page reachable under
 * two spellings (CHECK-30), internal links carrying campaign tags (CHECK-28),
 * and parameter variants that invite indexing of themselves (CHECK-27).
 *
 * The `url_params` inventory is NOT read here. It is the agent's context for
 * judging a site's parameter handling; a rule that turned "this site uses 40
 * parameters" into a finding would be reporting a fact, not a fault.
 *
 * All three read the crawl row first, through `readCrawlEvidence`, and discard
 * what it returns. None of them needs the discovery evidence; all of them need
 * the crawl to exist and to be a row this engine wrote, because a crawl id
 * nothing knows groups, joins and scans to nothing, and three empty results
 * read exactly like a site with tidy URLs (the `sitemap` rules' precedent, and
 * `runRules`' own).
 *
 * **TWO OF THE THREE KEEP THE FETCHED-OK COHORT** where the on-page rules moved
 * to `isJudged` in Phase 22 §1, and on purpose. `url.normalisation-variants`
 * asks which URLs BOTH SERVE the page, and a canonical on one of them is the
 * fix it is looking for, not a reason to stop looking; `url.tracking-params-
 * internal` judges the LINK a page makes, which is a link whatever the page
 * linking from says about itself. `url.parameter-pages-indexable` is the judged
 * one, and it always was in substance: it already required an indexable page
 * with a self-referential canonical, which is `isJudged` plus the canonical
 * being present, so the swap below is the rule layer's one authority replacing
 * a condition spelled out beside it.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { pages } from "../../db/schema.js";
import { TRACKING_PARAMS } from "../derive/url-params.js";
import { FETCHED_OK, isJudged, queryFinding, type RuleIdentity } from "../helpers.js";
import { resolveEffectiveCanonical } from "../page/canonical.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { capsOr, limitTo, noteTruncation, readCrawlEvidence } from "./crawl-evidence.js";

const CATEGORY = "url" as const;

const VARIANTS: RuleIdentity = { id: "url.normalisation-variants", severity: "critical" };
const TRACKING: RuleIdentity = { id: "url.tracking-params-internal", severity: "warning" };
const PARAM_PAGES: RuleIdentity = { id: "url.parameter-pages-indexable", severity: "warning" };

/**
 * Variant URLs listed on a normalisation finding. The count beside them is
 * exact; this bounds only what is quoted, so a normalisation key shared by a
 * thousand URLs does not put a thousand strings in a jsonb column.
 */
export const SAMPLE_VARIANTS = 10;

/** Pages read per round trip by the parameter-page scan: a batch, never the table. */
export const PARAM_PAGE_BATCH = 500;

/**
 * The POSIX pattern that finds a tracking param, applied to a URL's query
 * string ALONE — everything after the first `?`, which is the region the SQL
 * below slices out before matching.
 *
 * Matching the whole URL would be wrong in a way that produces a false
 * accusation rather than a near miss. A `?` is legal inside a parameter VALUE
 * and `normalizeUrl` preserves it, so our own crawler can store
 * `?to=/x?utm_source=y` — one parameter named `to`. A `[?&]`-anchored pattern
 * over the whole string matches the `?` inside that value, while the JS parse
 * below reports the URL's real parameters and finds no tracking name among
 * them: a warning about campaign parameters over a URL that carries none.
 * Slicing the query region first makes the two agree — inside it, that inner
 * `?` is an ordinary character with no `&` or start-of-string before it.
 *
 * `(^|&)` anchors the name to the start of a parameter, so `my_gclid=1` is not
 * a `gclid`; `(=|&|$)` anchors its end, so `utm_sourced=1` is not a
 * `utm_source`. A valueless `?fbclid` matches on the `&`/end branch, because a
 * parameter with no value is still a parameter the URL carries.
 *
 * Case-sensitive (`~`, not `~*`), like the inventory's `is_tracking` flag and
 * for the same reason: `UTM_Source` is a parameter the site invented that no
 * analytics tool reads as a campaign tag.
 */
const TRACKING_PATTERN = `(^|&)(${TRACKING_PARAMS.join("|")})(=|&|$)`;

// The pattern is built by joining the names with `|`, so a name carrying a
// regex metacharacter would silently change what it matches. Checked at module
// load rather than trusted: the list is edited by hand.
for (const name of TRACKING_PARAMS) {
  if (!/^[a-z_]+$/.test(name)) {
    throw new Error(
      `url.tracking-params-internal: tracking param '${name}' is not a literal ` +
        "alternation branch — the SQL pattern it builds would not mean what it says",
    );
  }
}

/**
 * Groups of URLs the crawl fetched separately that are the same page under the
 * analytic normalisation key — and that each answered with a page.
 *
 * `url_normalised` is what `normalizeUrl` made of each URL, then lowercased
 * with its trailing slash stripped (see the `PageWriter` header), while
 * `pages.url` is the frontier key the crawler actually fetched. Two rows
 * sharing the first and differing in the second are one page reachable at two
 * addresses.
 *
 * **The 200 filter is the rule.** Without it this fires on every site that
 * redirects `/a` to `/a/` — the most common normalisation pair there is, and
 * the configuration that FIXES the problem this rule reports. The redirect
 * source and its target share a normalisation key by design; reporting them
 * under copy about split ranking signals would be a false statement about a
 * site doing the right thing, and a rule that fires on every crawl is the
 * always-fires twin of a rule that always passes (build plan §6). What is left
 * is the real fault: two URLs that BOTH serve the page, with nothing telling a
 * search engine which one is the address.
 *
 * The finding lands on the lexically first variant rather than on the crawl:
 * an action plan needs a URL to point at, and the group's other members are in
 * the evidence beside it.
 */
async function variantFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, VARIANTS.id);
  const result = await db.execute<{
    url_normalised: string;
    variant_count: number;
    total_matches: number;
    variants: string[];
    first_id: string;
  }>(sql`
    with served as (
      select p.id, p.url, p.url_normalised
      from pages p
      where p.crawl_id = ${crawlId} and ${FETCHED_OK("p")}
    ),
    groups as (
      select s.url_normalised, count(distinct s.url)::int as variant_count
      from served s
      group by s.url_normalised
      having count(distinct s.url) > 1
    )
    select g.url_normalised, g.variant_count,
           count(*) over ()::int as total_matches,
           s.variants, s.first_id
    from groups g
    cross join lateral (
      select array_agg(sample.url) as variants, (array_agg(sample.id))[1] as first_id
      from (
        select s2.url, s2.id
        from served s2
        where s2.url_normalised = g.url_normalised
        order by s2.url
        limit ${SAMPLE_VARIANTS}
      ) sample
    ) s
    order by g.url_normalised
    ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(VARIANTS, {
      pageId: row.first_id,
      pageUrl: row.variants[0] ?? null,
      evidence: {
        urlNormalised: row.url_normalised,
        variants: row.variants,
        count: row.variant_count,
      },
      dedupeKey: row.url_normalised,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * Internal links whose target URL carries a campaign or ad-click parameter.
 *
 * Target-centric, like `links.broken-internal`: one tagged URL linked from
 * forty pages is one URL to clean up, and the count says how many links point
 * at it. Internal only — another site's tracking parameters are not ours to
 * fix, and a tagged outbound link is often deliberate.
 *
 * The candidate set is decided in SQL, so the links table is never loaded (hard
 * rule 3) and the cap bounds only what is listed. **Which parameters a target
 * actually carries is settled in JavaScript, and that answer is the authority:**
 * a candidate whose parsed query string holds no tracking key produces no
 * finding, so `params: []` is unreachable and this rule can never accuse a URL
 * of carrying a campaign tag it does not have. The SQL pattern is a pre-filter
 * — an upper bound on the set — matched against the query region alone so the
 * two agree (see `TRACKING_PATTERN`); naming the parameters in SQL as well
 * would mean unnesting every internal link's query string to rebuild a list
 * `URL.searchParams` already has.
 */
async function trackingFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, TRACKING.id);
  const result = await db.execute<{
    target_url: string;
    page_id: string | null;
    inlink_count: number;
    total_matches: number;
  }>(sql`
    select l.target_url, p.id as page_id, count(*)::int as inlink_count,
           count(*) over ()::int as total_matches
    from links l
    left join pages p on p.crawl_id = ${crawlId} and p.url = l.target_url
    where l.crawl_id = ${crawlId}
      and l.is_internal
      and position('?' in l.target_url) > 0
      and substr(l.target_url, position('?' in l.target_url) + 1) ~ ${TRACKING_PATTERN}
    group by l.target_url, p.id
    order by l.target_url
    ${limitTo(caps.listing)}`);

  const tracking = new Set(TRACKING_PARAMS);
  const findings: Finding[] = [];
  // The pre-filter's count, corrected for every candidate the parse rejected.
  // With the query-region pattern the two should never disagree, so this only
  // ever subtracts zero; it is here because a total that counted a row we
  // refused to list would be a number nothing behind it supports. Past the cap
  // no row is inspected, so beyond it the count remains the pre-filter's.
  let total = result.rows[0]?.total_matches ?? 0;

  for (const row of result.rows) {
    let params: string[];
    try {
      params = [...new URL(row.target_url).searchParams.keys()].filter((k) => tracking.has(k));
    } catch {
      // `links.target_url` is `normalizeUrl` output, so this is our defect
      // rather than a site's, and it is not something to skip quietly.
      throw new Error(`${TRACKING.id}: link target '${row.target_url}' is not a URL`);
    }
    if (params.length === 0) {
      total -= 1;
      continue;
    }
    findings.push(
      queryFinding(TRACKING, {
        // Null when the crawl never fetched the tagged URL — a link to a URL
        // that does not answer is a different rule's finding; this one is about
        // the tag, and the URL is the evidence either way.
        pageId: row.page_id,
        pageUrl: row.target_url,
        evidence: {
          targetUrl: row.target_url,
          params: [...new Set(params)].sort(),
          inlinkCount: row.inlink_count,
        },
        dedupeKey: row.target_url,
      }),
    );
  }
  return noteTruncation(findings, total);
}

/**
 * Indexable 200 pages that carry a query string and canonicalise to themselves.
 *
 * The self-reference is the point. A parameter variant that canonicalises to
 * the clean URL is the configuration working; one with no canonical at all is
 * `canonical.missing`'s finding and a different fix. What this rule reports is
 * the variant that declares itself the canonical version — every filter,
 * sort and session combination inviting indexing as a page in its own right,
 * which is how a catalogue of two hundred products becomes forty thousand
 * indexable URLs.
 *
 * Warning, not critical: parameterised pages are legitimately indexable on
 * plenty of sites (a search results page a client wants ranking, a paginated
 * feed), so the finding is not a verdict — but the failure mode it names is
 * how a catalogue of two hundred products becomes forty thousand indexable
 * URLs, which is more than a note. The `url_params` inventory beside this
 * finding is what tells the agent which parameters are involved.
 *
 * Batched by page id, and the canonical is resolved in JavaScript by the same
 * `resolveEffectiveCanonical` the canonical page rules use — a canonical can be
 * relative, carry a fragment, or spell its query string in another order, and
 * SQL cannot settle any of the three.
 */
async function parameterPageFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, PARAM_PAGES.id);

  const findings: Finding[] = [];
  let total = 0;
  let cursor = "";
  for (;;) {
    const batch = await db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.crawlId, crawlId),
          gt(pages.id, cursor),
          eq(pages.isIndexable, true),
          sql`position('?' in ${pages.url}) > 0`,
        ),
      )
      .orderBy(asc(pages.id))
      .limit(PARAM_PAGE_BATCH);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const page of batch) {
      // `is_indexable` already implies a 200 OK for every row the writer wrote,
      // but `isJudged` is the rule layer's single authority on "a page we may
      // judge" (Phase 22 §1) and it stays the one that decides here too. Its
      // canonical half is redundant with the self-canonical test below rather
      // than a second exclusion: a page canonicalised elsewhere fails both.
      if (!isJudged(page)) continue;
      const canonical = resolveEffectiveCanonical(page);
      if (canonical === null || canonical.resolved === null || canonical.pointsElsewhere) continue;

      // The scan continues past the cap so the total is the real number of
      // parameter pages, not the number that fitted (the robots.txt precedent).
      total++;
      if (caps.listing !== null && findings.length >= caps.listing) continue;
      findings.push(
        queryFinding(PARAM_PAGES, {
          pageId: page.id,
          pageUrl: page.url,
          evidence: {
            url: page.url,
            params: [...new Set(new URL(page.url).searchParams.keys())].sort(),
          },
          dedupeKey: page.url,
        }),
      );
    }
  }
  return noteTruncation(findings, total);
}

export const urlHygieneRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: VARIANTS.id,
    checkIds: ["CHECK-30"],
    category: CATEGORY,
    severity: VARIANTS.severity,
    columns: [
      { key: "count", label: "Occurrences" },
      { key: "variants", label: "Addresses" },
      { key: "urlNormalised", label: "Normalised Address" },
    ],
    ...copyFor(VARIANTS.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => variantFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: TRACKING.id,
    checkIds: ["CHECK-28"],
    category: CATEGORY,
    severity: TRACKING.severity,
    columns: [
      { key: "params", label: "Parameters" },
      { key: "inlinkCount", label: "Inlinks" },
    ],
    ...copyFor(TRACKING.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => trackingFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: PARAM_PAGES.id,
    checkIds: ["CHECK-27"],
    category: CATEGORY,
    severity: PARAM_PAGES.severity,
    columns: [{ key: "params", label: "Parameters" }],
    ...copyFor(PARAM_PAGES.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => parameterPageFindings(db, crawlId, capsOr(caps)),
  }),
];

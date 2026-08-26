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
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { pages } from "../../db/schema.js";
import { TRACKING_PARAMS } from "../derive/url-params.js";
import { isAuditable, queryFinding, type RuleIdentity } from "../helpers.js";
import { resolveEffectiveCanonical } from "../page/canonical.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import { noteTruncation, readCrawlEvidence, URL_FINDING_CAP } from "./crawl-evidence.js";

const CATEGORY = "url" as const;

const VARIANTS: RuleIdentity = { id: "url.normalisation-variants", severity: "warning" };
const TRACKING: RuleIdentity = { id: "url.tracking-params-internal", severity: "warning" };
const PARAM_PAGES: RuleIdentity = { id: "url.parameter-pages-indexable", severity: "info" };

/**
 * Variant URLs listed on a normalisation finding. The count beside them is
 * exact; this bounds only what is quoted, so a normalisation key shared by a
 * thousand URLs does not put a thousand strings in a jsonb column.
 */
export const SAMPLE_VARIANTS = 10;

/** Pages read per round trip by the parameter-page scan: a batch, never the table. */
export const PARAM_PAGE_BATCH = 500;

/**
 * The POSIX pattern that finds a tracking param inside a URL's query string.
 *
 * `[?&]` anchors the name to the start of a parameter, so `my_gclid=1` is not a
 * `gclid`; `(=|&|$)` anchors its end, so `utm_sourced=1` is not a `utm_source`.
 * A valueless `?fbclid` matches on the `&`/end branch, because a parameter with
 * no value is still a parameter the URL carries.
 *
 * Case-sensitive (`~`, not `~*`), like the inventory's `is_tracking` flag and
 * for the same reason: `UTM_Source` is a parameter the site invented that no
 * analytics tool reads as a campaign tag.
 */
const TRACKING_PATTERN = `[?&](${TRACKING_PARAMS.join("|")})(=|&|$)`;

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
async function variantFindings(db: Db, crawlId: string): Promise<Finding[]> {
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
      where p.crawl_id = ${crawlId} and p.fetch_class = 'ok' and p.status_code = 200
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
    limit ${URL_FINDING_CAP}`);

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
 * The set and the exact total are decided in SQL, so the links table is never
 * loaded (hard rule 3) and the cap bounds only what is listed. Which parameters
 * a listed target carries is worked out in JavaScript afterwards, over at most
 * `URL_FINDING_CAP` URLs: naming them in SQL would mean unnesting every
 * internal link's query string to report a list the pattern has already proved
 * non-empty.
 */
async function trackingFindings(db: Db, crawlId: string): Promise<Finding[]> {
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
      and l.target_url ~ ${TRACKING_PATTERN}
    group by l.target_url, p.id
    order by l.target_url
    limit ${URL_FINDING_CAP}`);

  const tracking = new Set(TRACKING_PARAMS);
  const findings = result.rows.map((row) => {
    let params: string[];
    try {
      params = [...new URL(row.target_url).searchParams.keys()].filter((k) => tracking.has(k));
    } catch {
      // `links.target_url` is `normalizeUrl` output, so this is our defect
      // rather than a site's, and it is not something to skip quietly.
      throw new Error(`${TRACKING.id}: link target '${row.target_url}' is not a URL`);
    }
    return queryFinding(TRACKING, {
      // Null when the crawl never fetched the tagged URL — a link to a URL that
      // does not answer is a different rule's finding; this one is about the
      // tag, and the URL is the evidence either way.
      pageId: row.page_id,
      pageUrl: row.target_url,
      evidence: {
        targetUrl: row.target_url,
        params: [...new Set(params)].sort(),
        inlinkCount: row.inlink_count,
      },
      dedupeKey: row.target_url,
    });
  });
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
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
 * Info, not a warning: parameterised pages are legitimately indexable on plenty
 * of sites (a search results page a client wants ranking, a paginated feed),
 * and the `url_params` inventory beside this finding is what tells the agent
 * which parameters are involved.
 *
 * Batched by page id, and the canonical is resolved in JavaScript by the same
 * `resolveEffectiveCanonical` the canonical page rules use — a canonical can be
 * relative, carry a fragment, or spell its query string in another order, and
 * SQL cannot settle any of the three.
 */
async function parameterPageFindings(db: Db, crawlId: string): Promise<Finding[]> {
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
      // but `isAuditable` is the rule layer's single authority on "a page we
      // may judge" and it stays the one that decides here too.
      if (!isAuditable(page)) continue;
      const canonical = resolveEffectiveCanonical(page);
      if (canonical === null || canonical.resolved === null || canonical.pointsElsewhere) continue;

      // The scan continues past the cap so the total is the real number of
      // parameter pages, not the number that fitted (the robots.txt precedent).
      total++;
      if (findings.length >= URL_FINDING_CAP) continue;
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
    ...copyFor(VARIANTS.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => variantFindings(db, crawlId),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: TRACKING.id,
    checkIds: ["CHECK-28"],
    category: CATEGORY,
    severity: TRACKING.severity,
    ...copyFor(TRACKING.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => trackingFindings(db, crawlId),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: PARAM_PAGES.id,
    checkIds: ["CHECK-27"],
    category: CATEGORY,
    severity: PARAM_PAGES.severity,
    ...copyFor(PARAM_PAGES.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => parameterPageFindings(db, crawlId),
  }),
];

/**
 * The sitemap rules: what the site says exists, against what the crawl found.
 *
 * Two of them read the crawl's discovery evidence (what robots.txt declared,
 * and which declared documents could not be read). The other five are SQL
 * joins between `sitemap_urls` — every `<loc>` the walk collected, whether or
 * not the frontier had room for it — and `pages`.
 *
 * ## The join basis
 *
 * `sitemap_urls.url` is the `<loc>` resolved with `new URL(loc).href` — the
 * spelling the site published — and `pages.url` is `normalizeUrl` output, the
 * frontier key. The two differ in exactly two ways: `normalizeUrl` strips the
 * fragment and sorts query parameters. A `<loc>` carrying `#section`, or one
 * whose query string is not in sorted order, is therefore the same URL as the
 * `pages` row the crawl created *from that very entry* spelled differently.
 *
 * So the join is on `sitemap_urls.url_normalised`, which the crawl loop writes
 * beside the published spelling through the same `normalizeUrl` the frontier
 * uses. Matching the published spelling instead reported such an entry as one
 * the crawl never reached and its page as one the sitemap never listed: two
 * findings about a site that had done nothing wrong, on nothing but
 * punctuation. Every rule below quotes `s.url` in its evidence all the same —
 * the published `<loc>` is the line of XML somebody edits.
 *
 * Rows written before that column existed carry an empty string, which matches
 * no page and joins to nothing — the same silence they had when the join was
 * on the published spelling.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import {
  noteTruncation,
  readCrawlEvidence,
  robotsUnreadable,
  URL_FINDING_CAP,
} from "./crawl-evidence.js";

const CATEGORY = "sitemap";

/**
 * Documents listed on the `sitemap.invalid` finding. One finding carries the
 * list, and the list is bounded: a sitemap index whose every shard 500s
 * produces one failure per shard, and a report page is not the place for three
 * hundred of them. `failureCount` is always the true number.
 */
export const MAX_FAILURES_LISTED = 50;

const MISSING: RuleIdentity = { id: "sitemap.missing", severity: "warning" };
const INVALID: RuleIdentity = { id: "sitemap.invalid", severity: "warning" };
const NON_200: RuleIdentity = { id: "sitemap.non-200", severity: "warning" };
const REDIRECTED: RuleIdentity = { id: "sitemap.redirected", severity: "warning" };
const NON_INDEXABLE: RuleIdentity = { id: "sitemap.non-indexable", severity: "warning" };
const UNCRAWLED: RuleIdentity = { id: "sitemap.uncrawled", severity: "info" };
const NOT_IN_SITEMAP: RuleIdentity = { id: "pages.not-in-sitemap", severity: "info" };

/** One crawled sitemap entry: the `<loc>` and the page row it matched. */
interface JoinRow extends Record<string, unknown> {
  url: string;
  page_id: string;
  status_code: number | null;
  fetch_class: string;
  redirect_url: string | null;
  robots_meta: string | null;
  x_robots_tag: string | null;
  /** The size of the whole matching set, before the cap. */
  total_matches: number;
}

/**
 * Sitemap entries whose `pages` row satisfies `condition`, capped.
 *
 * `count(*) over ()` is evaluated across the full result set before `limit`
 * takes its slice, so the exact total survives the cap and Postgres never
 * hands back more than `URL_FINDING_CAP` rows — the memory contract holds
 * whatever the size of the sitemap (hard rule 6).
 *
 * The crawl row is read first and its result discarded: none of the join rules
 * needs the discovery evidence, but all of them need the crawl to exist and to
 * be a row this engine wrote (see `readCrawlEvidence`), because a crawl id
 * nothing knows joins to nothing and would report a clean sitemap.
 */
async function joinFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  condition: SQL,
  evidenceOf: (row: JoinRow) => Record<string, unknown>,
): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, self.id);
  const result = await db.execute<JoinRow>(sql`
    select s.url, p.id as page_id, p.status_code, p.fetch_class, p.redirect_url,
           p.robots_meta, p.x_robots_tag,
           count(*) over ()::int as total_matches
    from sitemap_urls s
    join pages p on p.crawl_id = ${crawlId} and p.url = s.url_normalised
    where s.crawl_id = ${crawlId} and ${condition}
    order by s.url
    limit ${URL_FINDING_CAP}`);

  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.page_id,
      pageUrl: row.url,
      evidence: evidenceOf(row),
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

export const sitemapRules: QueryRule[] = [
  // The claim is precisely "robots.txt declares no sitemap" — this engine does
  // not probe /sitemap.xml speculatively (a P1 ruling), so a site with a
  // sitemap nobody points at is a site with an undeclared sitemap, which is the
  // finding. The copy must not say "no sitemap exists".
  //
  // Gated on being able to read robots.txt at all: a file we hold a 500KB
  // prefix of may declare a `Sitemap:` past the cap, and one we never read
  // declares nothing we know about. `robots.check-skipped` reports those.
  defineRule<QueryRule>({
    kind: "query",
    id: MISSING.id,
    checkIds: ["CHECK-06"],
    category: CATEGORY,
    severity: MISSING.severity,
    ...copyFor(MISSING.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const { discovery } = await readCrawlEvidence(db, crawlId, MISSING.id);
      if (robotsUnreadable(discovery) !== null) return [];
      if (discovery.sitemapSources.length > 0) return [];
      return [
        queryFinding(MISSING, {
          pageId: null,
          pageUrl: null,
          evidence: { robotsOutcome: discovery.robots.outcome, sitemapSources: [] },
          dedupeKey: "site",
        }),
      ];
    },
  }),

  // Documents the walk was pointed at and could not read: a 500, a body that
  // is not XML, a `<!DOCTYPE` we refuse, a URL the policy would not fetch.
  // One finding carrying the list, because a broken sitemap index is one fault
  // however many shards it names.
  defineRule<QueryRule>({
    kind: "query",
    id: INVALID.id,
    checkIds: ["CHECK-06"],
    category: CATEGORY,
    severity: INVALID.severity,
    ...copyFor(INVALID.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const { discovery } = await readCrawlEvidence(db, crawlId, INVALID.id);
      // An unreachable robots.txt makes the crawl refuse to fetch anything,
      // and discovery records one "not fetched" failure per declared source.
      // Those documents were never opened, so nothing about them is invalid —
      // reporting them here would blame the site for our own refusal.
      if (discovery.robots.outcome === "unreachable") return [];
      const failures = discovery.truncation.failures;
      if (failures.length === 0) return [];
      return [
        queryFinding(INVALID, {
          pageId: null,
          pageUrl: null,
          evidence: {
            failures: failures.slice(0, MAX_FAILURES_LISTED),
            failureCount: failures.length,
          },
          dedupeKey: "site",
        }),
      ];
    },
  }),

  // A listed URL that answered with something other than a 200.
  //
  // The condition is the STATUS CODE, not `fetch_class`, and the difference is
  // what the rule is honest about — the `canonical.non-200-target` precedent:
  //  - `status_code is null` is a fetch that got no HTTP answer at all (a
  //    timeout, a connection failure, a refused address). We learned nothing
  //    about that URL, and "does not return 200" would be a claim about a
  //    response that never arrived. `sitemap.uncrawled` reports it, because
  //    what is true of it is that this crawl never reached the page.
  //  - a 200 that was not HTML (`non_html` — a PDF or an image, both perfectly
  //    legitimate sitemap entries) or one whose body ran past the size cap
  //    (`too_large`) DID return 200. Firing here would put a status of 200 in
  //    the evidence of a finding titled "does not return 200".
  //
  // Redirects are excluded and reported by `sitemap.redirected`: a redirect is
  // a working answer pointing elsewhere, with a different fix (list the
  // destination), and billing it here too would put two findings on one line
  // of XML.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_200.id,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: NON_200.severity,
    ...copyFor(NON_200.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      joinFindings(
        NON_200,
        db,
        crawlId,
        sql`p.fetch_class <> 'redirect'
            and p.status_code is not null and p.status_code <> 200`,
        (row) => ({
          url: row.url,
          statusCode: row.status_code,
          fetchClass: row.fetch_class,
        }),
      ),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: REDIRECTED.id,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: REDIRECTED.severity,
    ...copyFor(REDIRECTED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      joinFindings(REDIRECTED, db, crawlId, sql`p.fetch_class = 'redirect'`, (row) => ({
        url: row.url,
        statusCode: row.status_code,
        redirectUrl: row.redirect_url,
      })),
  }),

  // A listed URL that answers with a 200 page telling search engines to keep
  // it out of the index. The 200 is half the condition and it is what keeps
  // this rule disjoint from the two above: `is_indexable` is false for every
  // 404, redirect and 5xx as well, so testing it alone would report a listed
  // 404 under copy about a robots directive that page never had.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_INDEXABLE.id,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: NON_INDEXABLE.severity,
    ...copyFor(NON_INDEXABLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      joinFindings(
        NON_INDEXABLE,
        db,
        crawlId,
        sql`p.fetch_class = 'ok' and p.status_code = 200 and p.is_indexable = false`,
        (row) => ({
          url: row.url,
          robotsMeta: row.robots_meta,
          xRobotsTag: row.x_robots_tag,
        }),
      ),
  }),

  // A listed URL this crawl has no usable record of, which is TWO shapes in
  // the database and one thing to tell a client:
  //  - no `pages` row at all: the crawl never attempted the URL. Usually its
  //    own boundary — a page cap, a depth cap, a URL robots.txt disallowed.
  //  - a `pages` row with a null status: the crawl attempted it and got no
  //    HTTP answer back (a timeout, a connection failure, an address the
  //    policy refused at connect time). Nothing is known about the page.
  //
  // The second belongs here rather than in `sitemap.non-200`, which would have
  // to invent a status to report, and it must not be silent: an attempted-and-
  // failed URL HAS a row, so the "no row" test alone would drop it. `attempted`
  // says which shape it is, and `fetchClass` names the failure.
  //
  // Info either way: the crawl not reaching a URL is a limit of this crawl
  // first, and a fault on the site only once someone confirms it.
  defineRule<QueryRule>({
    kind: "query",
    id: UNCRAWLED.id,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: UNCRAWLED.severity,
    ...copyFor(UNCRAWLED.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      await readCrawlEvidence(db, crawlId, UNCRAWLED.id);
      const result = await db.execute<{
        url: string;
        page_id: string | null;
        fetch_class: string | null;
        total_matches: number;
      }>(sql`
        select s.url, p.id as page_id, p.fetch_class,
               count(*) over ()::int as total_matches
        from sitemap_urls s
        left join pages p on p.crawl_id = ${crawlId} and p.url = s.url_normalised
        where s.crawl_id = ${crawlId}
          and (p.id is null or p.status_code is null)
        order by s.url
        limit ${URL_FINDING_CAP}`);

      const findings = result.rows.map((row) =>
        queryFinding(UNCRAWLED, {
          // The failed attempt has a row, and the finding belongs on it: that
          // row is where the fetch outcome lives. A URL never attempted has
          // none, and there is nothing to name.
          pageId: row.page_id,
          pageUrl: row.url,
          evidence: {
            url: row.url,
            attempted: row.page_id !== null,
            ...(row.page_id === null ? {} : { fetchClass: row.fetch_class, statusCode: null }),
          },
          dedupeKey: row.url,
        }),
      );
      return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
    },
  }),

  // Indexable 200 pages the sitemap does not list.
  //
  // DATA-GATED: it runs only when the crawl holds at least one sitemap entry.
  // With no sitemap at all every page on the site satisfies the condition, and
  // the honest report of that site is one finding — `sitemap.missing`, which
  // owns CHECK-06 — not one per URL under copy telling the client to add pages
  // to a file they do not have.
  defineRule<QueryRule>({
    kind: "query",
    id: NOT_IN_SITEMAP.id,
    checkIds: ["CHECK-09"],
    category: CATEGORY,
    severity: NOT_IN_SITEMAP.severity,
    ...copyFor(NOT_IN_SITEMAP.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      await readCrawlEvidence(db, crawlId, NOT_IN_SITEMAP.id);
      const gate = await db.execute<{ has_sitemap: boolean }>(sql`
        select exists (
          select 1 from sitemap_urls s where s.crawl_id = ${crawlId}
        ) as has_sitemap`);
      if (gate.rows[0]?.has_sitemap !== true) return [];

      const result = await db.execute<{ id: string; url: string; total_matches: number }>(sql`
        select p.id, p.url, count(*) over ()::int as total_matches
        from pages p
        where p.crawl_id = ${crawlId}
          and p.fetch_class = 'ok'
          and p.status_code = 200
          and p.is_indexable
          and not exists (
            select 1 from sitemap_urls s
            where s.crawl_id = ${crawlId} and s.url_normalised = p.url
          )
        order by p.url
        limit ${URL_FINDING_CAP}`);

      const findings = result.rows.map((row) =>
        queryFinding(NOT_IN_SITEMAP, {
          pageId: row.id,
          pageUrl: row.url,
          evidence: { pageUrl: row.url },
          dedupeKey: row.url,
        }),
      );
      return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
    },
  }),
];

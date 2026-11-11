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
 * Rows written before that column existed carry its empty-string default, and
 * an empty string matches no page. That is not a quiet outcome: every entry of
 * such a crawl fails the join, so `sitemap.uncrawled` would report the whole
 * sitemap as never reached and `pages.not-in-sitemap` every indexable 200 (its
 * data gate only asks that sitemap rows EXIST, and they do).
 *
 * So these rules do not tolerate it — they refuse it. No crawl can write an
 * empty `url_normalised` (`normalizeUrl` returns at least `scheme://host/`,
 * and `persistSitemap` throws on anything it rejects), which makes the default
 * unambiguous at read time, and every rule below opens with
 * `assertNormalisedSitemap`: it throws, names the crawl and an example entry,
 * and says to re-crawl the site. A pre-Phase-4 crawl is not a re-judge target.
 * Same ruling `parseDiscovery` makes for a null `discovery_jsonb`, for the same
 * reason (hard rule 7).
 */
import { sql, type SQL } from "drizzle-orm";

// `isSameOrigin` comes from the pure url-utils module for the reason the host
// rules import `hostProbeStarts` from it: it is the crawl boundary's own
// predicate, and taking it from src/crawl/loop.ts would pull the fetch stack
// into every rule run (hard rule 2 — rules read the database).
import { isSameOrigin } from "../../crawl/parse/url-utils.js";
import type { Db } from "../../db/client.js";
import {
  CANONICALISED_ELSEWHERE,
  FETCHED_OK,
  hasNoindex,
  JUDGED,
  queryFinding,
  NEVER_REQUESTED,
  type RuleIdentity,
} from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import {
  assertNormalisedSitemap,
  noteTruncation,
  readCrawlEvidence,
  robotsUnreadable,
  capsOr,
  limitTo,
  storedScope,
} from "./crawl-evidence.js";
import { fencedOffSql } from "../../crawl/url-scope.js";

const CATEGORY = "sitemap";

/**
 * Documents listed on the `sitemap.invalid` finding. One finding carries the
 * list, and the list is bounded: a sitemap index whose every shard 500s
 * produces one failure per shard, and a report page is not the place for three
 * hundred of them. `failureCount` is always the true number.
 */
export const MAX_FAILURES_LISTED = 50;

const MISSING: RuleIdentity = { id: "sitemap.missing", severity: "warning" };
/** Exported for `hreflang.declarations-incomplete`, whose reason names this finding by its title. */
export const INVALID: RuleIdentity = { id: "sitemap.invalid", severity: "critical" };
const NON_200: RuleIdentity = { id: "sitemap.non-200", severity: "critical" };
const REDIRECTED: RuleIdentity = { id: "sitemap.redirected", severity: "warning" };
const NON_INDEXABLE: RuleIdentity = { id: "sitemap.non-indexable", severity: "critical" };
const UNCRAWLED: RuleIdentity = { id: "sitemap.uncrawled", severity: "info" };
const NOT_IN_SITEMAP: RuleIdentity = { id: "pages.not-in-sitemap", severity: "info" };

/** One crawled sitemap entry: the `<loc>` and the page row it matched. */
interface JoinRow extends Record<string, unknown> {
  url: string;
  page_id: string;
  status_code: number | null;
  fetch_class: string;
  redirect_url: string | null;
  /**
   * The two robots channels, which are the EVIDENCE on a
   * `sitemap.non-indexable` row and also what its `reason` is decided from:
   * `hasNoindex` over this pair is `indexabilityOf`'s own test, so the word in
   * the evidence and the Indexability Status column beside it are one reading.
   * Both are empty on an entry set aside for its canonical, which is why the
   * reason exists at all.
   */
  robots_meta: string | null;
  x_robots_tag: string | null;
  /**
   * The stored indexability stamp, read by `sitemap.non-indexable` for ONE
   * case the two channels above cannot speak for: a 200 whose stamp is null.
   * No crawl this engine writes produces one (`PageWriter` computes a boolean
   * for every row), and `indexabilityOf` declines to assert over it — but the
   * rule's cohort admits it, because `site.health` counts it among the pages
   * set aside and the two must partition the same 200s. Such a row reads
   * `noindex`, which is the word that census files it under.
   */
  is_indexable: boolean | null;
  /** The size of the whole matching set, before the cap. */
  total_matches: number;
}

/**
 * Sitemap entries whose `pages` row satisfies `condition`, capped.
 *
 * `count(*) over ()` is evaluated across the full result set before `limit`
 * takes its slice, so the exact total survives the cap and Postgres never
 * hands back more than `caps.listing` rows — the memory contract holds
 * whatever the size of the sitemap (hard rule 6). An UNCAPPED run is the
 * operator asking for a row per listed URL, and the honesty of that trade is
 * the point: what comes back is bounded by the sitemap the site publishes, not
 * by anything this rule chooses, and the run's memory is O(what was found).
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
  caps: RuleCaps,
): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, self.id);
  await assertNormalisedSitemap(db, crawlId, self.id);
  const result = await db.execute<JoinRow>(sql`
    select s.url, p.id as page_id, p.status_code, p.fetch_class, p.redirect_url,
           p.robots_meta, p.x_robots_tag, p.is_indexable,
           count(*) over ()::int as total_matches
    from sitemap_urls s
    join pages p on p.crawl_id = ${crawlId} and p.url = s.url_normalised
    where s.crawl_id = ${crawlId} and ${condition}
    order by s.url
    ${limitTo(caps.listing)}`);

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
    columns: [
      { key: "robotsOutcome", label: "robots.txt Outcome" },
      { key: "sitemapSources", label: "Sitemap Sources" },
    ],
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
    needsSitemaps: true,
    checkIds: ["CHECK-06"],
    category: CATEGORY,
    severity: INVALID.severity,
    columns: [
      { key: "failures", label: "Failures" },
      { key: "failureCount", label: "Failure Count" },
    ],
    ...copyFor(INVALID.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const { discovery } = await readCrawlEvidence(db, crawlId, INVALID.id);
      // An unreachable robots.txt makes the crawl refuse to fetch anything,
      // and discovery records one "not fetched" failure per declared source.
      // Those documents were never opened, so nothing about them is invalid —
      // reporting them here would blame the site for our own refusal.
      //
      // What says "a walk ran" is `truncation.docsFetched`, the documents the
      // walk attempted, and not the robots outcome: a resume that finds robots
      // unreachable keeps the earlier walk's evidence and replaces only `robots`
      // and `sitemapSources` (28a ruling R5), so its `truncation.failures` are
      // that walk's real ones. (`sitemapsRead` cannot say: the refusal records
      // it true, and a spider crawl always does.) No attempt, no judgement.
      if (discovery.truncation.docsFetched === 0) return [];
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
    needsSitemaps: true,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: NON_200.severity,
    columns: [{ key: "fetchClass", label: "Fetch Class" }],
    ...copyFor(NON_200.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
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
        capsOr(caps),
      ),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: REDIRECTED.id,
    needsSitemaps: true,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: REDIRECTED.severity,
    columns: [{ key: "redirectUrl", label: "Redirect URL" }],
    ...copyFor(REDIRECTED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      joinFindings(
        REDIRECTED,
        db,
        crawlId,
        sql`p.fetch_class = 'redirect'`,
        (row) => ({
          url: row.url,
          statusCode: row.status_code,
          redirectUrl: row.redirect_url,
        }),
        capsOr(caps),
      ),
  }),

  // A listed URL that answers with a 200 page a search engine is not going to
  // keep: it carries a noindex, OR it canonicalises to another URL. The 200 is
  // half the condition and it is what keeps this rule disjoint from the two
  // above: `is_indexable` is false for every 404, redirect and 5xx as well, so
  // testing it alone would report a listed 404 under copy about a robots
  // directive that page never had.
  //
  // THE CANONICALISED CASE ARRIVED IN PHASE 22 §1, and it is the inverse of the
  // same phase's other move. Every other rule STOPPED judging canonicalised
  // pages, because the defect belongs to the URL they defer to — but a sitemap
  // is a list of URLs the site is asking to have indexed, and a URL that has
  // told search engines to index something else does not belong on it. The
  // cohort this rule reports over is therefore the COMPLEMENT OF `JUDGED`
  // WITHIN THE FETCHED-OK 200s: a 200 this crawl did not judge, because it
  // noindexes itself or defers to another URL. Not "the opposite of JUDGED" —
  // the 404s, redirects and 5xx are outside `JUDGED` too and belong to the two
  // rules above.
  //
  // `is_indexable IS NOT TRUE` rather than `= false`, so that a NULL stamp
  // lands here rather than in neither cohort. That is the predicate
  // `site.health` counts its noindex set-aside with (src/rules/metric/
  // health-metrics.ts), and the two must partition the same 200s: with `=
  // false` a NULL-stamped 200 that canonicalises nowhere would be judged by
  // nothing and set aside by nobody. No crawl this engine writes produces a
  // NULL there — `PageWriter` computes a boolean for every row — and the row is
  // covered rather than assumed away. Its `reason` reads `noindex`, because
  // that is the word `site.health` files it under, and one vocabulary across
  // the two is worth more than a second guess at a row nothing writes.
  //
  // `reason` is what a reader needs beside the two robots columns, which are
  // both empty on a canonicalised entry: without it, half this rule's rows
  // would carry copy about a directive and no evidence of one.
  //
  // NOINDEX TAKES PRECEDENCE when a page is both, which is `indexabilityOf`'s
  // order (src/rules/helpers.ts, case 9 before case 10) and the order
  // `site.health` sets the two aside in: a noindex is the page's own explicit
  // instruction to stay out of the index, while a canonical is a hint about
  // which URL to prefer, and search engines treat the explicit directive as
  // the stronger signal — which is why the Indexability Status column beside
  // this row already reads `Noindex`. The word is read from the predicate that
  // column uses — `hasNoindex` over the two robots channels — so a row cannot
  // say `canonicalised` where the column beside it says `Noindex`; the stamp
  // is consulted only for the null case above, where that column asserts
  // nothing at all.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_INDEXABLE.id,
    needsSitemaps: true,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: NON_INDEXABLE.severity,
    columns: [
      { key: "reason", label: "Reason" },
      { key: "robotsMeta", label: "Meta Robots" },
      { key: "xRobotsTag", label: "X-Robots-Tag" },
    ],
    ...copyFor(NON_INDEXABLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      joinFindings(
        NON_INDEXABLE,
        db,
        crawlId,
        sql`${FETCHED_OK("p")}
            and (p.is_indexable is not true or ${CANONICALISED_ELSEWHERE("p")})`,
        (row) => ({
          url: row.url,
          reason:
            hasNoindex({ robotsMeta: row.robots_meta, xRobotsTag: row.x_robots_tag }) ||
            row.is_indexable !== true
              ? "noindex"
              : "canonicalised",
          robotsMeta: row.robots_meta,
          xRobotsTag: row.x_robots_tag,
        }),
        capsOr(caps),
      ),
  }),

  // A listed URL this crawl has no usable record of, which is THREE shapes in
  // the database and one thing to tell a client:
  //  - no `pages` row at all, for a URL inside the crawl boundary: the crawl
  //    never attempted it and could have. Usually its own limit — a page cap,
  //    a depth cap, a URL robots.txt disallowed.
  //  - no `pages` row at all, for a URL OUTSIDE the crawl boundary: the crawl
  //    never attempted it and never would have. `isSameOrigin` is the gate the
  //    frontier applies to every candidate (src/crawl/loop.ts), so such an
  //    entry is skipped by design, not by any limit. Usually another host;
  //    equally another port, or the plain-http spelling of a site crawled over
  //    https, because an origin is all three. The www twin of the site's own
  //    host is INSIDE the boundary — `isSameOrigin` admits it — which is why
  //    the question is asked of that function and not of the hostname.
  //  - a `pages` row with a null status: the crawl attempted it and got no
  //    HTTP answer back (a timeout, a connection failure, an address the
  //    policy refused at connect time). Nothing is known about the page.
  //    ONE SUCH ROW WAS NEVER ATTEMPTED (Phase 23 T3): a robots-blocked row,
  //    recorded because a page links to the URL and robots.txt forbade the
  //    request. It reads `attempted: false` with `fetchClass: disallowed` —
  //    the first cause, robots.txt, named by the row itself.
  //
  // The third belongs here rather than in `sitemap.non-200`, which would have
  // to invent a status to report, and it must not be silent: an attempted-and-
  // failed URL HAS a row, so the "no row" test alone would drop it. `attempted`
  // says whether a fetch happened, and `fetchClass` names the failure.
  //
  // `offOrigin` separates the first two, and it exists because the copy of this
  // finding names causes. A supplied or declared sitemap may legitimately list
  // URLs this crawl's boundary excludes — a CDN-hosted sitemap is now an
  // ordinary case (the crawl skill invites one) — and telling an operator that
  // such an entry hit a page limit, a robots disallow or a failed request would
  // send them chasing three causes none of which is true. It is computed with
  // `isSameOrigin` over the frontier key, the same function and the same input
  // the loop gates on, so it says what the crawler actually did rather than
  // approximating it. A rule may not fetch (hard rule 2); this is arithmetic on
  // two strings the database already holds.
  //
  // Info either way: the crawl not reaching a URL is a limit of this crawl
  // first, and a fault on the site only once someone confirms it.
  defineRule<QueryRule>({
    kind: "query",
    id: UNCRAWLED.id,
    needsSpider: true,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: UNCRAWLED.severity,
    columns: [
      { key: "attempted", label: "Attempted" },
      { key: "offOrigin", label: "Off Origin" },
      { key: "fetchClass", label: "Fetch Class", optional: true },
    ],
    ...copyFor(UNCRAWLED.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps): Promise<Finding[]> => {
      const { siteUrl } = await readCrawlEvidence(db, crawlId, UNCRAWLED.id);
      await assertNormalisedSitemap(db, crawlId, UNCRAWLED.id);
      const scope = await storedScope(db, crawlId);
      const result = await db.execute<{
        url: string;
        url_normalised: string;
        page_id: string | null;
        fetch_class: string | null;
        never_requested: boolean;
        total_matches: number;
      }>(sql`
        select s.url, s.url_normalised, p.id as page_id, p.fetch_class,
               coalesce(${NEVER_REQUESTED("p")}, false) as never_requested,
               count(*) over ()::int as total_matches
        from sitemap_urls s
        left join pages p on p.crawl_id = ${crawlId} and p.url = s.url_normalised
        where s.crawl_id = ${crawlId}
          and (p.id is null or p.status_code is null)
          -- An entry the crawl's CURRENT scope fences off was not crawled by
          -- our own decision (27c). url_normalised is NOT NULL, and
          -- assertNormalisedSitemap has refused the empty default.
          and not ${fencedOffSql(sql`s.url_normalised`, scope, scope.siteUrl)}
        order by s.url
        ${limitTo(capsOr(caps).listing)}`);

      const findings = result.rows.map((row) =>
        queryFinding(UNCRAWLED, {
          // The failed attempt has a row, and the finding belongs on it: that
          // row is where the fetch outcome lives. A URL never attempted has
          // none, and there is nothing to name.
          pageId: row.page_id,
          pageUrl: row.url,
          evidence: {
            url: row.url,
            // A robots-blocked or scope-excluded row (Phase 23 T3, 27c) has a row and was NEVER
            // REQUESTED — recorded because a page links to it — so it is not
            // an attempt; its `fetchClass` still says why there is no page.
            attempted: row.page_id !== null && !row.never_requested,
            // The frontier key, not the published `<loc>`: `isSameOrigin` is
            // asked the same question about the same string the loop asked it
            // about. `assertNormalisedSitemap` has already refused a crawl
            // whose rows carry the empty-string default, so this is a URL.
            offOrigin: !isSameOrigin(row.url_normalised, siteUrl),
            // `fetchClass` only, and no `statusCode`: this rule selects rows
            // whose status is null by construction (`p.id is null or
            // p.status_code is null`), so a `statusCode` key here could only
            // ever be null — a heading over an empty cell, and one the
            // standard `Status Code` column already prints from the page row.
            ...(row.page_id === null ? {} : { fetchClass: row.fetch_class }),
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
    needsSpider: true,
    checkIds: ["CHECK-09"],
    category: CATEGORY,
    severity: NOT_IN_SITEMAP.severity,
    columns: [],
    ...copyFor(NOT_IN_SITEMAP.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps): Promise<Finding[]> => {
      await readCrawlEvidence(db, crawlId, NOT_IN_SITEMAP.id);
      await assertNormalisedSitemap(db, crawlId, NOT_IN_SITEMAP.id);
      const gate = await db.execute<{ has_sitemap: boolean }>(sql`
        select exists (
          select 1 from sitemap_urls s where s.crawl_id = ${crawlId}
        ) as has_sitemap`);
      if (gate.rows[0]?.has_sitemap !== true) return [];

      const result = await db.execute<{ id: string; url: string; total_matches: number }>(sql`
        select p.id, p.url, count(*) over ()::int as total_matches
        from pages p
        where p.crawl_id = ${crawlId}
          -- THE JUDGED COHORT (Phase 22 §1). A canonicalised page should NOT be
          -- in the sitemap -- sitemap.non-indexable reports it when it is --
          -- so reporting it as missing from one is the inverse of right.
          and ${JUDGED("p")}
          and not exists (
            select 1 from sitemap_urls s
            where s.crawl_id = ${crawlId} and s.url_normalised = p.url
          )
        order by p.url
        ${limitTo(capsOr(caps).listing)}`);

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

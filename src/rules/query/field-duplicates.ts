/**
 * The field-level duplicate rules: one title, one meta description or one H1
 * shared by pages that are otherwise different pages (CHECK-35, CHECK-36,
 * CHECK-37).
 *
 * These are the table-stakes numbers of any audit, and until Phase 7 this
 * engine could not report them: the first real audit run against a client site
 * had to record "duplicate titles" and "duplicate meta descriptions" as
 * UNMEASURED, because every rule that touched those columns judged one page at
 * a time and a duplicate is by definition a fact about two. The three checks
 * were already CLAIMED — by `title.missing`, `meta-description.missing` and
 * `headings.h1-missing`, which ask whether the field exists — so the gap did
 * not show up in the coverage pin either. A field that exists on every page and
 * says the same thing on all of them is the failure those rules cannot see.
 *
 * **Why this is a query rule and not a page rule.** A page rule is handed one
 * `PageRecord`. "Is this title unique on this site" is a question about the
 * whole crawl, so it is SQL over the `pages` table (hard rule 3: every link and
 * cross-page question is a query, never a table loaded into memory). Nothing
 * here fetches (hard rule 2) and nothing here re-derives a value: the analyzer
 * wrote `title`, `meta_description` and `h1_text` during its single streaming
 * pass, and these rules group what it stored.
 *
 * **The shape all three share**, which is `content.exact-duplicate`'s:
 *
 *  - one finding per GROUP, not per page and not per pair. "These four URLs
 *    carry the same title" is one decision to make and one template to fix;
 *    four findings saying it would be four times the work for one change.
 *  - the finding lands on the group's lexically first member, so an action plan
 *    has a URL to open, and the rest of the group is in the evidence.
 *  - `count` is the group's REAL size and `pages` is a capped, ordered sample
 *    of it (`DUPLICATE_SAMPLE_URLS`). A templated catalogue can put one title on
 *    ten thousand URLs, and a findings row is not the place to list them; the
 *    count is what says how big the problem is. Since Phase 22 the size is
 *    counted in hreflang CLUSTERS and the sample lists one URL per cluster —
 *    see below.
 *  - the LISTING of groups stops at the run's `caps.listing` with an exact
 *    `noteTruncation` total behind it, because the grouping runs to completion
 *    either way — only the listing is cut. An uncapped run (`findingCap: null`)
 *    reports every group and writes no note.
 *  - `findingCap` moves the number of GROUPS, never `DUPLICATE_SAMPLE_URLS`.
 *    One finding quotes twenty URLs and the group's exact count at every cap:
 *    the magnitude is the count, the sample is there to open. A row carrying a
 *    ten-thousand-element array would be a pathological finding, not a fuller
 *    picture.
 *
 * **The cohort is the JUDGED page** (`JUDGED`, src/rules/helpers.ts) — fetched
 * OK, 200, indexable, not canonicalised elsewhere — which is the same one
 * `content.exact-duplicate` and `content.near-duplicate` use. A duplicate title
 * on a page search engines are told to ignore is not a finding: the page is out
 * of the index, or it has handed its signals to another URL, so nothing of it
 * competes with anything. Redirects and errors have no title worth comparing at
 * all. Phase 22 added the canonical half of that exclusion, which is what took
 * raelon.ca's 79 duplicate-title groups down to 5: most of them were Shopify
 * collection paths canonicalising to `/products/x`.
 *
 * SINCE MIGRATION 0012 THE COHORT IS ALSO AN INDEX PREDICATE. The three partial
 * indexes `pages_dupe_title`, `pages_dupe_meta_description` and
 * `pages_dupe_h1_text` (src/db/schema.ts, beside the simhash bands) are built
 * `where fetch_class = 'ok' and status_code = 200 and is_indexable = true and
 * <field> is not null`, and Postgres uses a partial index only when it can
 * prove the query's WHERE implies the index's. `JUDGED` is that predicate plus
 * the canonical exclusion, which implies it; WIDEN the cohort without widening
 * those indexes and the planner stops using them — a slow query, not an error.
 *
 * **Hreflang alternates are one member** (Phase 22 §2). A correctly
 * internationalised site publishes the same title on `/x` and `/fr/x` whenever
 * a string is untranslated, and the reciprocal annotation is precisely what
 * tells a search engine those are one page in two languages. `hreflang_cluster`
 * (src/rules/query/hreflang-cluster.ts) is where that is decided; here it means
 * the group's `count` is its distinct clusters, `pages` lists the lexically
 * first URL of each, and `alternatesCollapsed` says how many URLs were folded
 * in. A group that falls below two clusters produces no finding at all.
 *
 * **Pages 2+ of a paginated series are left out** (Phase 23 T7, study 4.5): a
 * judged page with `rel_prev` set repeats its listing's title, description and
 * H1 by construction. They are counted, not hidden — `paginationExcluded` on
 * every finding and `urlsPaginated` on `site.health`. `content.exact-duplicate`
 * and `content.near-duplicate` keep them: a duplicated paginated BODY is real.
 *
 * **Blank never groups.** `null` and `''` are dropped before the grouping, in
 * all three rules. Postgres groups nulls together, so without that guard every
 * page missing a title would be reported as sharing a title with every other
 * one — a finding built on the absence of the very thing being compared, and a
 * second, wrong-copy report of what `title.missing` already says.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { JUDGED, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { DUPLICATE_SAMPLE_URLS } from "./content.js";
import { assertCrawl, capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { CLUSTER_KEY, HREFLANG_CLUSTER_CTES } from "./hreflang-cluster.js";

/**
 * The category, for all four rules.
 *
 * `on-page` rather than `content`, deliberately, and the split is not arbitrary:
 * `content.exact-duplicate` is about the BODY two URLs serve, which is a
 * question of what was published, while these three are about the head tags and
 * the headline a template writes — the same family the report already groups
 * `title.*`, `meta-description.*` and `headings.*` under, and the same place a
 * client goes to fix them (`RuleCategory`, src/rules/registry/types.ts).
 */
const CATEGORY = "on-page" as const;

const TITLE: RuleIdentity = { id: "title.duplicate", severity: "warning" };
const META: RuleIdentity = { id: "meta-description.duplicate", severity: "warning" };
const H1: RuleIdentity = { id: "h1.duplicate-text", severity: "warning" };
const H1_SKIPPED: RuleIdentity = { id: "h1.duplicate-skipped", severity: "info" };

/** The stable identity of one duplicated value. */
function valueKey(value: string): string {
  // Hashed rather than used verbatim, for `content.near-duplicate`'s reason:
  // `dedupe_key` is a column and part of a unique index, a meta description
  // runs to 160 characters and a title tag can legally be far longer than that
  // — and the group's IDENTITY is all the key has to carry. The value itself
  // is in the evidence, where a reader can read it.
  return createHash("sha256").update(value).digest("hex");
}

/** One field's spelling: the column to group by, and the evidence key it fills. */
export interface DuplicateField {
  /**
   * The `pages` column, as SQL. A closed union because it reaches the query
   * through `sql.raw`: only these literals can, whoever imports the function.
   * Each has a partial `pages_dupe_*` index on the JUDGED predicate.
   */
  column: "title" | "meta_description" | "h1_text" | "og_title" | "og_description";
  /** The evidence key the duplicated value is written under. */
  evidenceKey: string;
}

type GroupRow = {
  value: string;
  /** Distinct hreflang clusters carrying the value — the group's size. */
  page_count: number;
  /** URLs carrying it, before the clusters collapsed. */
  member_count: number;
  urls: string[];
  first_id: string;
  total_matches: number;
  /** Judged pages declaring rel=prev, left out of the grouping. */
  pagination_excluded: number;
};

/**
 * Groups of indexable 200 pages whose `field` holds the same trimmed value.
 *
 * **Exact equality after trimming, and nothing cleverer.** Two titles differing
 * by a trailing space are the same title — that difference exists nowhere a
 * reader or a search engine can see — and two differing by a word are two
 * titles this rule says nothing about. A near-match ("Blue Shoes | Shop" vs
 * "Blue Shoes | Store") is a judgement about how much of a title is
 * boilerplate, and `content.near-duplicate` is where this engine makes
 * similarity claims, with a measured distance behind them. Stating an exact
 * rule and holding to it is what makes a finding here arguable in front of a
 * client.
 *
 * `btrim` is belt and braces rather than the trimming itself: the analyzer
 * already stores `title` and `meta_description` `.trim()`ed and `h1_text`
 * whitespace-collapsed as well, so it changes nothing for a row this crawler
 * wrote and stops a row written any other way from grouping alone.
 *
 * ONE LIMITATION IT DOES NOT COVER, stated rather than left to be discovered: a
 * title broken across lines in the template (`<title>Blue\n  Shoes</title>`)
 * keeps its internal whitespace in the column, so it does NOT group with the
 * same title written on one line, though a browser renders both identically.
 * Collapsing internal whitespace here would be a second, silent normalisation
 * on top of the analyzer's — the place to fix that is the capture, where the
 * parity oracle can hold it honest, not the comparison.
 *
 * **The sample is ordered and the count is not sampled.** The inner `order by
 * p2.url` with its own `limit` means Postgres never materialises a
 * ten-thousand-URL array to throw most of it away, and it means the same crawl
 * judged twice quotes the same URLs in the same order rather than whichever
 * ones the plan emitted first (the deterministic-cap lesson).
 *
 * **Group ordering is by the group's first URL** — the same key the finding
 * lands on — so which groups survive the cap is settled and readable
 * rather than arbitrary. Like every other URL ordering in the rule layer it is
 * the database's collation, so a database created with a different one may cut
 * a different last group; the COUNT behind the cap is exact either way.
 *
 * **THE CAP COMES BEFORE THE LATERAL, and that is a measured requirement rather
 * than a tidiness.** A `cross join lateral` under an `order by`/`limit` at the
 * same query level is evaluated for EVERY row the FROM produces, because the
 * limit cannot be applied until the rows exist — so ordering on a value the
 * lateral computes runs one twenty-row indexed lookup per GROUP, not per
 * reported group. On a templated 50,000-page site with 5,000 duplicate groups
 * that measured **2m41s for one rule**, against 69s for all 42 query rules in
 * the Phase 5 gate. The three CTEs below exist to stop that:
 *
 *  1. `dupes` groups and carries `min(p.url) as first_url` out of the SAME
 *     aggregate — the group's lexically first member, which is exactly what the
 *     lateral's `order by p2.url limit N` puts at `urls[0]`, so the ordering
 *     key and the finding's carrier are computed once and for free;
 *  2. `capped` takes the `count(*) over ()` exact total (a window is evaluated
 *     over the whole CTE before its own `order by`/`limit`, so the total is
 *     every group) and cuts to `caps.listing`;
 *  3. the lateral then runs against the surviving rows and no more.
 *
 * AN UNCAPPED RUN IS WHERE THAT SHAPE EARNS ITS KEEP RATHER THAN LOSING IT.
 * With `limit all` the third step runs the twenty-URL lookup once per group
 * again — which is the cost the operator asked for, one indexed lookup per
 * finding they will actually read — and it is still ordered, still counted
 * exactly, and still one row per group. The 2m41s regression above came from
 * running the lateral for groups nobody would ever see; here nothing is
 * discarded.
 *
 * Every semantic above is preserved — same group order, same carrier, same
 * exact totals, same truncation note — and the 20,000-page case measured 3.3s
 * instead of 28.9s. `content.exact-duplicate` was restructured the same way in
 * the same commit; it is the shape's origin and had the same cost curve.
 */
export async function groupFindings(
  db: Db,
  crawlId: string,
  self: RuleIdentity,
  field: DuplicateField,
  caps: RuleCaps,
): Promise<Finding[]> {
  const { findings, total } = await duplicateGroups(db, crawlId, self, field, caps);
  return noteTruncation(findings, total);
}

/**
 * `groupFindings` before its truncation note: the capped listing of groups and
 * the exact number of groups behind it. Exported for a rule that lists SEVERAL
 * fields under one id (`social.og-duplicate`, src/rules/query/social.ts): it
 * cuts the concatenation to one cap and writes ONE note with the summed total.
 * Two noted listings concatenated could not say that: a rule's note rides on
 * its last finding, and the API reads one note per rule.
 */
export async function duplicateGroups(
  db: Db,
  crawlId: string,
  self: RuleIdentity,
  field: DuplicateField,
  caps: RuleCaps,
): Promise<{ findings: Finding[]; total: number }> {
  // A crawl id nothing knows groups nothing and would report a clean bill of
  // health for a crawl that does not exist (hard rule 7, `links.orphan`'s
  // precedent). These rules read no evidence blob, so this is the existence
  // gate rather than `readCrawlEvidence`.
  await assertCrawl(db, crawlId, self.id);

  // `sql.raw` because a column name is not a parameter — Postgres has no
  // placeholder for one. The values it can ever take are the literals of
  // `DuplicateField.column`'s union (used by the rules at the bottom of this
  // file and by `social.og-duplicate`), so no crawl datum reaches here.
  const column = sql.raw(`p.${field.column}`);

  const result = await db.execute<GroupRow>(sql`
    with ${HREFLANG_CLUSTER_CTES(crawlId)},
    members as (
      select btrim(${column}) as value, p.id, p.url,
             ${CLUSTER_KEY("p", "hc")} as cluster_key
      from pages p
      left join hreflang_cluster hc on hc.page_id = p.id
      where p.crawl_id = ${crawlId} and ${JUDGED("p")}
        and ${column} is not null and btrim(${column}) <> ''
        -- Pages 2+ of a paginated series declare rel=prev and leave the rule
        -- (Phase 23 T7). A bare IS NULL on a non-indexed column: the partial
        -- pages_dupe_* index and its btrim() key are untouched.
        and p.rel_prev is null
    ),
    paginated as (
      -- The exclusion, counted: every judged page that declares rel=prev,
      -- whatever its field holds, so the number is the one site.health shows.
      select count(*)::int as n
      from pages p
      where p.crawl_id = ${crawlId} and ${JUDGED("p")} and p.rel_prev is not null
    ),
    dupes as (
      select m.value,
             count(distinct m.cluster_key)::int as page_count,
             count(*)::int as member_count,
             min(m.url) as first_url
      from members m
      group by m.value
      having count(distinct m.cluster_key) > 1
    ),
    capped as (
      select d.value, d.page_count, d.member_count, d.first_url,
             count(*) over ()::int as total_matches
      from dupes d
      order by d.first_url
      ${limitTo(caps.listing)}
    )
    select c.value, c.page_count, c.member_count, c.total_matches, s.urls, s.first_id,
           (select n from paginated) as pagination_excluded
    from capped c
    cross join lateral (
      select array_agg(sample.url) as urls, (array_agg(sample.id))[1] as first_id
      from (
        select min(m2.url) as url, (array_agg(m2.id order by m2.url))[1] as id
        from members m2
        where m2.value = c.value
        group by m2.cluster_key
        order by 1
        limit ${DUPLICATE_SAMPLE_URLS}
      ) sample
    ) s
    order by c.first_url`);

  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.first_id,
      pageUrl: row.urls[0] ?? null,
      evidence: {
        [field.evidenceKey]: row.value,
        // Exact: the group's real size in CLUSTERS, whatever the sample below
        // holds. An hreflang cluster is one member (Phase 22 §2), so this is
        // the number of distinct pages competing with each other rather than
        // the number of URLs carrying the value.
        count: row.page_count,
        pages: row.urls,
        // The URLs the line above folded away: members minus clusters. Zero on
        // a site with no reciprocal alternates, and carried anyway — a reader
        // comparing `count` against a longer list of URLs elsewhere in the
        // report is owed the number rather than left to infer it (Phase 22 §3).
        alternatesCollapsed: row.member_count - row.page_count,
        // Judged pages that declare rel=prev (page 2+ of a series), left out of
        // the grouping altogether: a listing repeats its title, description and
        // H1 across its pages by construction. Crawl-wide, the same on every
        // finding and the same number `site.health` publishes (Phase 23 T7).
        paginationExcluded: row.pagination_excluded,
      },
      dedupeKey: valueKey(row.value),
    }),
  );
  // An empty listing has no window row: zero groups, which is what it means.
  return { findings, total: result.rows[0]?.total_matches ?? 0 };
}

type H1Coverage = {
  indexable_pages: number;
  pages_with_h1: number;
  pages_with_h1_text: number;
};

/**
 * What this crawl knows about its pages' H1 TEXT, as opposed to their H1 count.
 *
 * Three numbers, because the H1 rule has a silence that means two different
 * things and only these three can tell them apart. See `h1TextUnavailable`.
 */
async function h1Coverage(db: Db, crawlId: string, ruleId: string): Promise<H1Coverage> {
  await assertCrawl(db, crawlId, ruleId);
  const result = await db.execute<H1Coverage>(sql`
    select count(*)::int as indexable_pages,
           count(*) filter (where p.h1_count > 0)::int as pages_with_h1,
           count(*) filter (where p.h1_text is not null)::int as pages_with_h1_text
    from pages p
    where p.crawl_id = ${crawlId} and ${JUDGED("p")}`);
  const row = result.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns one row over any input, including
    // none. No row is a statement that did not run the way it reads.
    throw new Error(`${ruleId}: crawl '${crawlId}' h1 coverage query returned no row`);
  }
  return row;
}

/**
 * Why `h1.duplicate-text` could not be run on this crawl, or null when it can.
 *
 * **The unknown-is-not-evidence gate**, and the reason this rule has a skip
 * twin when the two rules beside it do not. `pages.h1_text` arrived with
 * migration 0010 (Phase 7) and is written by the analyzer from that point
 * onward, so on every crawl this engine performed BEFORE Phase 7 the column is
 * null on every row. A rule reading it there groups nothing and returns
 * nothing — and an empty finding list is exactly what a site with no duplicate
 * H1s produces. Two crawls, two opposite facts, one silence: precisely the
 * always-passes hole hard rule 1 forbids, arriving through a schema version
 * rather than through a bad predicate.
 *
 * **The analyzer invariant this rests on**, which is what makes the condition
 * DECIDE the question rather than merely suggest an answer: from P7 onward,
 * `h1_count > 0` implies `h1_text IS NOT NULL`. The two come off one parse —
 * the count from each `<h1>` open tag and the text from the first one's close
 * (`headingCounts[0]` and `h1s`/`h1Text` in src/crawl/parse/page-analyzer.ts),
 * written together by `PageWriter` — and an `<h1>` holding only an image stores
 * `''`, which is present-but-blank rather than null. So a row with a count and
 * no text is not a row a P7-or-later analyzer produced, and an entire cohort in
 * that state can only be a pre-P7 crawl.
 *
 * The condition names that crawl and nothing else: NO indexable page has H1
 * text, while some indexable page HAS an h1 (`h1_count > 0`). The second half
 * is what keeps the skip precise. A site whose indexable pages genuinely carry
 * no `<h1>` at all also has no H1 text, and there the silence is a true
 * statement — the missing headings are `headings.h1-missing`'s finding, once
 * per page, and announcing a skipped check beside it would be a second report
 * of the same fact under copy that tells the client to re-crawl for no reason.
 *
 * A MIXED crawl — some rows with text, some without — is not a skip. It is a
 * crawl whose later pages were analysed by this version, and the rule runs over
 * what it has; a pre-P7 row simply does not join any group. That is a narrower
 * blind spot than the whole check and it is not one this pair can describe, so
 * it is stated here rather than papered over.
 *
 * `h1.duplicate-text` needs no matching gate: with no non-null `h1_text` in the
 * cohort there is no group for it to find, so exactly one of the two rules can
 * ever speak about a crawl. The partition is structural rather than a flag the
 * two share, which is what stops it from drifting (the `links.orphan` /
 * `links.orphan-skipped` pair share their gate FUNCTION for the same reason —
 * neither rule may depend on the other having run).
 */
function h1TextUnavailable(coverage: H1Coverage): string | null {
  if (coverage.pages_with_h1_text > 0) return null;
  if (coverage.pages_with_h1 === 0) return null;
  return (
    `this crawl stored no H1 text for any of its ${coverage.indexable_pages} indexable ` +
    `page(s), while ${coverage.pages_with_h1} of them do carry an H1 element — so the ` +
    "column the duplicate-heading check reads was written by no analyzer that ran here " +
    "(pages.h1_text arrived in Phase 7 and is null on every row an earlier crawl wrote). " +
    "Re-crawl the site to produce rows this check can read"
  );
}

export const fieldDuplicateRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: TITLE.id,
    checkIds: ["CHECK-35"],
    category: CATEGORY,
    severity: TITLE.severity,
    columns: [
      { key: "title", label: "Title 1" },
      { key: "count", label: "Occurrences" },
      { key: "pages", label: "Addresses" },
      { key: "alternatesCollapsed", label: "Alternates Collapsed" },
      { key: "paginationExcluded", label: "Paginated Pages Set Aside (Site-Wide)" },
    ],
    ...copyFor(TITLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      groupFindings(db, crawlId, TITLE, { column: "title", evidenceKey: "title" }, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: META.id,
    checkIds: ["CHECK-36"],
    category: CATEGORY,
    severity: META.severity,
    columns: [
      { key: "metaDescription", label: "Meta Description 1" },
      { key: "count", label: "Occurrences" },
      { key: "pages", label: "Addresses" },
      { key: "alternatesCollapsed", label: "Alternates Collapsed" },
      { key: "paginationExcluded", label: "Paginated Pages Set Aside (Site-Wide)" },
    ],
    ...copyFor(META.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      groupFindings(
        db,
        crawlId,
        META,
        { column: "meta_description", evidenceKey: "metaDescription" },
        capsOr(caps),
      ),
  }),

  // The heading rule reads `pages.h1_text`: the FIRST h1's text, collapsed,
  // trimmed and capped at 300 characters by the analyzer.
  //
  // TWO LIMITATIONS IT INHERITS FROM THAT COLUMN, both stated because they
  // change what a finding means rather than merely how it is produced:
  //
  //  1. The capture matches cheerio's `.text()`, which concatenates the h1's
  //     descendant text nodes with no separator — so `<h1>Big<br>Sale</h1>` is
  //     captured as `BigSale`, one word. Two headings that a reader sees as
  //     identical and that differ in their inline markup are still grouped
  //     (the text is the same either way); two that a reader sees as different
  //     could in principle collide only if their collapsed text is byte-equal,
  //     which is the same equality every rule in this file states.
  //  2. Only the FIRST h1 is stored. A page carrying three of them (which
  //     `headings.h1-multiple` reports) contributes one heading here, and a
  //     duplicate among its second and third is invisible to this rule.
  //
  // Exact equality of that stored value is the contract, and it is the whole
  // contract: nothing here judges how similar two headings are.
  defineRule<QueryRule>({
    kind: "query",
    id: H1.id,
    checkIds: ["CHECK-37"],
    category: CATEGORY,
    severity: H1.severity,
    columns: [
      { key: "h1Text", label: "H1-1" },
      { key: "count", label: "Occurrences" },
      { key: "pages", label: "Addresses" },
      { key: "alternatesCollapsed", label: "Alternates Collapsed" },
      { key: "paginationExcluded", label: "Paginated Pages Set Aside (Site-Wide)" },
    ],
    ...copyFor(H1.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      groupFindings(db, crawlId, H1, { column: "h1_text", evidenceKey: "h1Text" }, capsOr(caps)),
  }),

  // A check we could not run is visible, never silent (hard rule 7). One
  // finding, site-scoped, naming the reason in its evidence — and the reason is
  // about the CRAWL rather than about the site, so the severity is info and the
  // copy is its own (rendering "The same heading on more than one page" over
  // "this crawl stored no headings" would be a false statement to a client).
  defineRule<QueryRule>({
    kind: "query",
    id: H1_SKIPPED.id,
    checkIds: ["CHECK-37"],
    category: CATEGORY,
    severity: H1_SKIPPED.severity,
    columns: [
      { key: "skipped", label: "Reason" },
      { key: "indexablePages", label: "Indexable Pages" },
      { key: "pagesWithH1", label: "Pages With An H1" },
      { key: "pagesWithH1Text", label: "Pages With H1 Text" },
    ],
    ...copyFor(H1_SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "This crawl stored no H1 text, so duplicate H1s could not be checked; re-crawl the site.",
    run: async (db, crawlId): Promise<Finding[]> => {
      const coverage = await h1Coverage(db, crawlId, H1_SKIPPED.id);
      const skipped = h1TextUnavailable(coverage);
      if (skipped === null) return [];
      return [
        queryFinding(H1_SKIPPED, {
          pageId: null,
          pageUrl: null,
          evidence: {
            skipped,
            indexablePages: coverage.indexable_pages,
            pagesWithH1: coverage.pages_with_h1,
            // Zero whenever this rule speaks, and carried anyway: it is the
            // number the condition turns on, and a reader should not have to
            // take the sentence above on trust.
            pagesWithH1Text: coverage.pages_with_h1_text,
          },
          dedupeKey: "site",
        }),
      ];
    },
  }),
];

/**
 * The link-graph metrics: how many internal links each page receives, which
 * pages sit at the ends of that distribution, which templates link into which,
 * and how far from the seed the site's pages sit.
 *
 * These are the first metric rules. Five properties hold across all of them and
 * are stated once here rather than four times below:
 *
 *  1. **Every number is computed by Postgres.** Percentiles are
 *     `percentile_cont`, means are `avg`, the top/bottom lists are `ORDER BY …
 *     LIMIT`, and the source-type rollup is a windowed `CASE`. Nothing streams
 *     rows into JavaScript to count them, so a 50,000-page crawl returns a
 *     handful of rows per rule and the `links` table is never loaded into
 *     memory (hard rule 3).
 *
 *  2. **The cohort is the same everywhere**: pages this crawl fetched OK with a
 *     200 that are indexable. A 404, a redirect or a noindex page is not
 *     competing for crawl attention or link equity, so counting it would move
 *     every number in the table without describing anything a client can act
 *     on. The SOURCE side of a link is deliberately NOT filtered this way — a
 *     noindex page still links, and the link it makes is still a link.
 *
 *  3. **A link a page makes to itself is not an inbound link** — the
 *     `links.orphan` lesson (`source_page_id <> p.id`). A logo linking home, a
 *     self-referential breadcrumb or a pagination control naming its own URL
 *     would otherwise give every page in a template an inbound link it does not
 *     have. Counts are `count(distinct source_page_id)`: a page named in both
 *     the header and the footer of one other page is one inbound link, not two.
 *
 *  4. **A page nothing links to counts as 0, not as an absence.** The inlink
 *     cohort is a LEFT JOIN, so the pages that would make the distribution look
 *     bad are exactly the ones a naive inner join would drop. Same lesson, same
 *     rule as the orphan check.
 *
 *  5. **A crawl id nothing knows is refused, not answered.** Every one of these
 *     queries aggregates over `pages` filtered by `crawl_id`, so an id with no
 *     row behind it produces a table of zeroes — `count: 0`, every statistic
 *     null, empty lists — which is EXACTLY the answer a real crawl with no
 *     indexable pages gets. Two different facts must not share one shape, so
 *     each rule opens with `assertCrawl` and throws instead (hard rule 7, and
 *     `runRules`' own precedent). The gate is the one in
 *     `../query/crawl-evidence.js` rather than a copy per file: the crawl
 *     metrics and the URL metric already take it there, and a second definition
 *     of "does this crawl exist" is a second answer waiting to disagree.
 *
 * `page_type` cohorts group by the crawler's own template detection
 * (src/crawl/page-type.ts, whose crawl-end pass has already collapsed a URL
 * shape that occurred once into the family it belongs to — a cohort here is a
 * template). The column is nullable, so a null groups under the
 * documented sentinel `UNTYPED` rather than vanishing: a cohort of pages the
 * detector could not type is still a cohort, and dropping it would silently
 * change what "the site" means between two metrics. The sentinel, the cohort
 * predicate and the column checks now live in `./cohort.js`, shared with the
 * content and hreflang metrics so all three measure one set of pages.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { COHORT_PAGE_TYPE, cohortFilter, nullableNum, num, UNTYPED } from "./cohort.js";

/** How many URLs `inlinks.extremes` names at each end. */
export const EXTREMES_LIST_CAP = 20;

/**
 * How many source page types `inlinks.sources-by-type` names per target
 * cohort before the remainder is rolled into one `(other)` bucket.
 */
export const SOURCE_TYPE_CAP = 25;

/**
 * The bucket the types past `SOURCE_TYPE_CAP` are summed into.
 *
 * Parenthesised for the same reason as `UNTYPED`, and with more force. A
 * `page_type` is a detected URL template (`/blog/:id/:slug`), which cannot be
 * spelled this way, or a CLIENT-CONFIGURED name, which can: nothing stops a
 * client calling a template `other`. Where `UNTYPED` MERGES such a collision —
 * sound, because by the time a reader has the table the two really are
 * indistinguishable — a merge here would NOT be sound. The ranked CTE knows
 * perfectly well which rows are a real `other` type inside the cap and which
 * are the rollup past it, so summing them into one key would destroy a
 * distinction the query still holds. Parenthesising keeps the two apart: a
 * client's `other` stays its own key beside `(other)`.
 */
export const OTHER_SOURCES = "(other)";

/**
 * One row per cohort page: its url, its type, and how many DISTINCT other pages
 * link to it. Shared by the distribution and the extremes list so "an inbound
 * link" is defined once — two metrics about the same quantity that disagreed
 * about what it was would be worse than one.
 *
 * The `page_type` a cohort exposes is ALREADY coalesced, here and in the depth
 * cohort below, so everything downstream groups by a non-null column — see
 * `UNTYPED` for why that placement is the design rather than a convenience.
 *
 * `group by p.id` alone is enough to select `p.url` and `p.page_type` beside
 * the aggregate: `pages.id` is the table's primary key, so Postgres knows both
 * are functionally dependent on it.
 */
function inlinkCohort(crawlId: string): SQL {
  return sql`
    select p.url as url, ${COHORT_PAGE_TYPE} as page_type,
           count(distinct l.source_page_id)::int as v
    from pages p
    left join links l
      on l.crawl_id = ${crawlId}
     and l.target_url = p.url
     and l.source_page_id <> p.id
    where ${cohortFilter(crawlId)}
    group by p.id`;
}

/**
 * The eight numbers of a distribution, over a cohort CTE that exposes its
 * measurement as `v`.
 *
 * Percentiles and the mean are rounded to two decimal places IN SQL. They are
 * quotable figures in a report rather than inputs to another calculation, and
 * an unrounded `percentile_cont` lands on values like `2.7500000000000004` —
 * float noise that would be printed to a client verbatim.
 */
const DISTRIBUTION_AGGREGATES = sql`
  count(*)::int as count,
  min(v)::int as min,
  round((percentile_cont(0.25) within group (order by v))::numeric, 2)::float8 as p25,
  round((percentile_cont(0.5)  within group (order by v))::numeric, 2)::float8 as median,
  round((percentile_cont(0.75) within group (order by v))::numeric, 2)::float8 as p75,
  round((percentile_cont(0.95) within group (order by v))::numeric, 2)::float8 as p95,
  max(v)::int as max,
  round(avg(v), 2)::float8 as mean`;

/**
 * The same eight numbers, plus the count of cohort pages whose measurement is
 * NULL — the ninth column only a measure that can be absent has.
 *
 * The eight above already read a nullable `v` correctly: `count(*)` is the whole
 * cohort, and every aggregate beside it (`min`, `avg`, `percentile_cont`)
 * ignores nulls, so the statistics describe the pages that HAVE a value while
 * the count describes the cohort. That is the right split and it is also
 * invisible — a reader cannot tell `count: 443` with three unmeasured pages from
 * `count: 443` with none. This column is what makes the difference legible, and
 * for click depth it is not a footnote but the finding: a page no internal link
 * reaches is the worst case in the table, worse than the deepest page in it, and
 * CHECK-31 has demanded that bucket in block capitals since before any rule
 * could compute it.
 */
const NULL_COUNT_AGGREGATE = sql`count(*) filter (where v is null)::int as null_count`;

/**
 * The three row shapes below are type ALIASES rather than interfaces, and that
 * is a constraint of `db.execute<T>`, not a style choice: its `T` must extend
 * `Record<string, unknown>`, which an object type satisfies through its
 * implicit index signature and an interface does not.
 *
 * The declared types are what the SQL's casts promise; `num` below is what
 * checks that promise at run time, where the driver rather than the compiler
 * decides.
 */
type DistributionRow = {
  scope: string;
  scope_value: string;
  count: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
  /**
   * Present only when the caller asked for it (`withNullCount`), because only a
   * measure that can be absent has one. Declared optional rather than nullable:
   * a null here would be a null COUNT, which is a different claim from "this
   * distribution has no null bucket".
   */
  null_count?: number;
};

/**
 * Run the distribution shape over a cohort and return its metric rows: one for
 * the site, one per `page_type`.
 *
 * The site row is produced by the SAME cohort CTE as the cohort rows, in one
 * statement, so the two can never be computed over different sets of pages —
 * which is the failure mode of computing them in two queries. It has no `GROUP
 * BY`, so an empty cohort still yields one row (`count: 0`, every statistic
 * null): a metric that is absent means the rule did not run, and "this crawl
 * has no indexable pages" is an answer rather than a silence.
 */
async function distribution(
  db: Db,
  crawlId: string,
  self: MetricIdentity,
  cohort: SQL,
  withNullCount = false,
): Promise<Metric[]> {
  // Property 5: an unknown crawl would otherwise be a `count: 0` site row.
  await assertCrawl(db, crawlId, self.id);

  const aggregates = withNullCount
    ? sql`${DISTRIBUTION_AGGREGATES}, ${NULL_COUNT_AGGREGATE}`
    : DISTRIBUTION_AGGREGATES;

  const rows = await db.execute<DistributionRow>(sql`
    with cohort as (${cohort})
    select 'site' as scope, '' as scope_value, ${aggregates} from cohort
    union all
    select 'page_type' as scope, page_type as scope_value,
           ${aggregates}
    from cohort
    group by page_type
    order by scope, scope_value`);

  return rows.rows.map((row) => {
    const value: Record<string, number | null> = {
      count: num(row.count, "count", self.id),
      min: nullableNum(row.min, "min", self.id),
      p25: nullableNum(row.p25, "p25", self.id),
      median: nullableNum(row.median, "median", self.id),
      p75: nullableNum(row.p75, "p75", self.id),
      p95: nullableNum(row.p95, "p95", self.id),
      max: nullableNum(row.max, "max", self.id),
      mean: nullableNum(row.mean, "mean", self.id),
    };
    // `num`, not `nullableNum`: the column is a count, so it is 0 over a cohort
    // with nothing missing and never null. A null arriving here would mean the
    // filtered aggregate had been edited into something else.
    if (withNullCount) value["nullCount"] = num(row.null_count, "null_count", self.id);
    if (row.scope === "site") return metricRow(self, { scope: "site", value });
    return metricRow(self, { scope: "page_type", scopeValue: row.scope_value, value });
  });
}

type ExtremeRow = {
  side: string;
  url: string;
  v: number;
};

/**
 * The two ends of the inlink distribution, as URLs.
 *
 * Both lists are cut in SQL — `ORDER BY … LIMIT` — because the alternative is a
 * jsonb value with one entry per page of the site. Ties are broken by url
 * ASCENDING in BOTH lists: the count's direction reverses between them, the
 * tiebreak does not, so the same set of equal-count pages is listed in the same
 * order at either end and two runs over one crawl name the same URLs (the
 * deterministic-cap lesson).
 *
 * On a site with fewer than `EXTREMES_LIST_CAP` cohort pages the two lists name
 * the same pages in opposite orders. That is the honest answer for a small
 * site, not a defect to hide.
 *
 * `rank` is selected only so the UNION can be ordered by it — a UNION's own
 * ORDER BY sees output columns, not the subqueries' orderings, so without it
 * the rows would arrive in whatever order the plan produced and the lists would
 * be built out of order.
 */
async function extremes(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // Property 5: an unknown crawl would otherwise be two empty lists.
  await assertCrawl(db, crawlId, self.id);

  const rows = await db.execute<ExtremeRow>(sql`
    with cohort as (${inlinkCohort(crawlId)}),
    bottom as (select url, v from cohort order by v asc, url asc limit ${EXTREMES_LIST_CAP}),
    top as (select url, v from cohort order by v desc, url asc limit ${EXTREMES_LIST_CAP})
    select 'bottom' as side, url, v, row_number() over (order by v asc, url asc) as rank
    from bottom
    union all
    select 'top' as side, url, v, row_number() over (order by v desc, url asc) as rank
    from top
    order by side, rank`);

  const lists: Record<string, { url: string; inlinks: number }[]> = { bottom: [], top: [] };
  for (const row of rows.rows) {
    const list = lists[row.side];
    // The query emits exactly two labels; anything else is an edit that broke
    // the shape, and it must not become a silently missing list.
    if (list === undefined) throw new Error(`${self.id}: unknown list side '${row.side}'`);
    list.push({ url: String(row.url), inlinks: num(row.v, "v", self.id) });
  }
  return [metricRow(self, { scope: "site", value: { bottom: lists.bottom, top: lists.top } })];
}

type SourceTypeRow = {
  target_type: string;
  bucket: string | null;
  inlinks: number | null;
};

/**
 * Which templates link into each template.
 *
 * The count is DISTINCT (source page, target page) pairs, the same unit the
 * distribution counts, so "the blog sends 6 links into the blog" means six
 * distinct page-to-page links rather than six anchors.
 *
 * Two bounds, both in SQL. The target side is one metric row per cohort
 * `page_type` — cohorts are rows, never nested arrays — and the source side is
 * capped at `SOURCE_TYPE_CAP` types per row with the remainder summed into
 * `OTHER_SOURCES`, ranked by count descending and then type name ascending so
 * the cut is deterministic. A site with hundreds of detected templates would
 * otherwise put hundreds of keys in one jsonb object. The rollup key is
 * parenthesised so a client template genuinely named `other` keeps its own
 * entry beside it — see the constant.
 *
 * A target cohort NOTHING links to gets `{sources: {}}` rather than no row: the
 * runner deletes and rewrites a metric's rows every run, so an absent row means
 * "not computed", and "no page on this site links into this template" is a
 * finding worth stating.
 */
async function sourcesByType(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // Property 5: an unknown crawl would otherwise be no rows at all — the same
  // silence a crawl with no cohort pages legitimately produces.
  await assertCrawl(db, crawlId, self.id);

  const rows = await db.execute<SourceTypeRow>(sql`
    with target as (
      select p.id as id, p.url as url, ${COHORT_PAGE_TYPE} as target_type
      from pages p
      where ${cohortFilter(crawlId)}
    ),
    edges as (
      select distinct t.target_type as target_type,
             coalesce(s.page_type, ${UNTYPED}) as source_type,
             l.source_page_id as source_id,
             t.id as target_id
      from links l
      join target t on t.url = l.target_url and l.source_page_id <> t.id
      -- LEFT, and the coalesce above is why it can be: the links table has no
      -- foreign key to pages, so a source_page_id with no row behind it is a
      -- database state nothing forbids. An inner join would silently DROP that
      -- link — and inlinks.distribution counts it, since it reads
      -- source_page_id without visiting pages at all. The two CHECK-33 metrics
      -- would then disagree about the same site by however many dangling
      -- sources it had. Left join instead, and such a source lands in the
      -- untyped bucket with the pages the detector could not type.
      left join pages s on s.id = l.source_page_id and s.crawl_id = ${crawlId}
      where l.crawl_id = ${crawlId}
    ),
    counts as (
      select target_type, source_type, count(*)::int as inlinks
      from edges
      group by target_type, source_type
    ),
    ranked as (
      select target_type, source_type, inlinks,
             row_number() over (
               partition by target_type order by inlinks desc, source_type asc
             ) as rank
      from counts
    ),
    types as (select distinct target_type from target)
    select ty.target_type as target_type,
           case
             when r.source_type is null then null
             when r.rank <= ${SOURCE_TYPE_CAP} then r.source_type
             else ${OTHER_SOURCES}
           end as bucket,
           sum(r.inlinks)::int as inlinks
    from types ty
    left join ranked r on r.target_type = ty.target_type
    group by ty.target_type, bucket
    order by ty.target_type, min(r.rank)`);

  const sources = new Map<string, Record<string, number>>();
  for (const row of rows.rows) {
    const type = String(row.target_type);
    const bucket = sources.get(type) ?? {};
    sources.set(type, bucket);
    // The left join's miss: a target cohort with no inbound links at all. The
    // empty object it leaves behind IS the answer.
    if (row.bucket === null) continue;
    bucket[String(row.bucket)] = num(row.inlinks, "inlinks", self.id);
  }

  return [...sources].map(([type, buckets]) =>
    metricRow(self, { scope: "page_type", scopeValue: type, value: { sources: buckets } }),
  );
}

const LINKS = "links";
const TECHNICAL = "technical";

/**
 * The five link-graph metrics.
 *
 * Each is assembled by `metricRule`, which writes the id once and hands it to
 * the body as `self`: the id the registry keys, the id `copyFor` looks up and
 * the id stamped on every row are then one string rather than three that agree
 * today. Severity is not stated here because the kind has only one — see the
 * factory.
 */
export const linkMetrics: MetricRule[] = [
  metricRule("inlinks.distribution", ["CHECK-33"], LINKS, async (db, crawlId, self) =>
    distribution(db, crawlId, self, inlinkCohort(crawlId)),
  ),

  metricRule("inlinks.extremes", ["CHECK-33"], LINKS, async (db, crawlId, self) =>
    extremes(db, crawlId, self),
  ),

  metricRule("inlinks.sources-by-type", ["CHECK-33b"], LINKS, async (db, crawlId, self) =>
    sourcesByType(db, crawlId, self),
  ),

  // DISCOVERY depth: how the crawler first arrived at each page, which is a
  // fact about the crawl and NOT about the site's structure. Every sitemap entry
  // is enqueued as a seed at depth 0 (src/crawl/loop.ts), so on a site whose
  // sitemap covers the estate this distribution collapses to zero and says
  // nothing about how far a visitor is from anything — the Phase 6 gate crawl
  // put 437 of 443 indexable pages at "depth 0" beside a median inbound link
  // count of zero.
  //
  // IT KEEPS ITS DATA AND LOSES ITS CLAIM. The number is real evidence about
  // crawl behaviour — which pages needed the sitemap to be found at all is
  // exactly what `discoveredVia` and this metric together say — so the table
  // stays and its copy now says discovery depth in its own words. CHECK-31 asks
  // how many CLICKS from the home page a page is, and that question moved to
  // the metric below it, which computes it.
  //
  // Depth is a property of the page row rather than of the link table, so its
  // cohort is a plain select — but it is the SAME cohort, which is what lets a
  // reader put the depth table beside the inlink table and read them as two
  // views of one set of pages.
  // IT CLAIMS CHECK-32 rather than nothing, and the reason is not bookkeeping:
  // a rule must claim a check (`defineRule`), and the check this table is
  // evidence for is the ORPHAN one. A crawl whose depth distribution collapses
  // to zero is a crawl that found its pages from the sitemap rather than from
  // links, which is the site-wide shadow of the per-page fact `links.orphan`
  // reports. The verdict stays with that rule; this is the shape beside it.
  metricRule("structure.depth-distribution", ["CHECK-32"], TECHNICAL, async (db, crawlId, self) =>
    distribution(
      db,
      crawlId,
      self,
      sql`select ${COHORT_PAGE_TYPE} as page_type, p.depth as v
          from pages p
          where ${cohortFilter(crawlId)}`,
    ),
  ),

  // CLICK depth, and the metric CHECK-31 has always meant: the shortest chain of
  // internal links from the home page, computed by `deriveClickDepth` in the
  // derivation phase and read here off `pages.click_depth`.
  //
  // The cohort is the same as every metric's, so this table sits beside the
  // inlink table over one set of pages — and the shape is the same eight numbers
  // plus the ninth this measure needs. `nullCount` is the pages the link graph
  // does not reach: a sitemap-only page, which is the worst bucket in the
  // distribution rather than a missing value, and which the DISCOVERY metric
  // above structurally cannot show (it records such a page at 0).
  metricRule(
    "structure.click-depth-distribution",
    ["CHECK-31"],
    TECHNICAL,
    async (db, crawlId, self) =>
      distribution(
        db,
        crawlId,
        self,
        sql`select ${COHORT_PAGE_TYPE} as page_type, p.click_depth as v
            from pages p
            where ${cohortFilter(crawlId)}`,
        true,
      ),
  ),
];

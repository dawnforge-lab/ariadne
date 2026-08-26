/**
 * The link-graph metrics: how many internal links each page receives, which
 * pages sit at the ends of that distribution, which templates link into which,
 * and how far from the seed the site's pages sit.
 *
 * These are the first metric rules. Four properties hold across all of them and
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
 * `page_type` cohorts group by the crawler's own template detection
 * (`derivePageType`). The column is nullable, so a null groups under the
 * documented sentinel `UNTYPED` rather than vanishing: a cohort of pages the
 * detector could not type is still a cohort, and dropping it would silently
 * change what "the site" means between two metrics.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Metric,
  type MetricRule,
} from "../registry/registry.js";

/**
 * The scope value a cohort of pages with no `page_type` is filed under.
 *
 * Parenthesised on purpose: `derivePageType` returns either a client-configured
 * type name or a detected URL template (`/blog/:id/:slug`), and neither can
 * ever be spelled `(untyped)` — so the sentinel cannot collide with a real
 * cohort and be read as one. The empty string was not available: it is what a
 * site-scoped row stores in the metrics primary key.
 */
export const UNTYPED = "(untyped)";

/** How many URLs `inlinks.extremes` names at each end. */
export const EXTREMES_LIST_CAP = 20;

/**
 * How many source page types `inlinks.sources-by-type` names per target
 * cohort before the remainder is rolled into one `other` bucket.
 */
export const SOURCE_TYPE_CAP = 25;

/** The bucket the types past `SOURCE_TYPE_CAP` are summed into. */
const OTHER_SOURCES = "other";

/** The pages every metric here measures: fetched OK, 200, indexable. */
function cohortFilter(crawlId: string): SQL {
  return sql`p.crawl_id = ${crawlId}
    and p.fetch_class = 'ok'
    and p.status_code = 200
    and p.is_indexable`;
}

/**
 * One row per cohort page: its url, its type, and how many DISTINCT other pages
 * link to it. Shared by the distribution and the extremes list so "an inbound
 * link" is defined once — two metrics about the same quantity that disagreed
 * about what it was would be worse than one.
 *
 * The `page_type` a cohort exposes is ALREADY coalesced, here and in the depth
 * cohort below, so everything downstream groups by a non-null column. Doing it
 * in the outer `GROUP BY` instead would leave a null cohort and a (hypothetical)
 * literal `(untyped)` cohort as two groups projecting one scope value — two
 * rows for one primary key, which the runner rejects as a rule answering the
 * same question twice.
 *
 * `group by p.id` alone is enough to select `p.url` and `p.page_type` beside
 * the aggregate: `pages.id` is the table's primary key, so Postgres knows both
 * are functionally dependent on it.
 */
function inlinkCohort(crawlId: string): SQL {
  return sql`
    select p.url as url, coalesce(p.page_type, ${UNTYPED}) as page_type,
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
};

/**
 * A number from a SQL row, checked rather than cast.
 *
 * The casts in the queries above are what make these columns `int4`/`float8`
 * — types the driver parses to JavaScript numbers. A cast dropped in an edit
 * would hand back an `int8` or a `numeric`, which arrive as STRINGS, and
 * `{count: "10"}` in a jsonb column is a metric that reads correctly and
 * compares wrongly forever after. It fails here instead (hard rule 7).
 */
function num(value: unknown, column: string, ruleId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${ruleId}: column '${column}' came back as ${typeof value}, not a number`);
  }
  return value;
}

/** The same, for the statistics that are null over an empty cohort. */
function nullableNum(value: unknown, column: string, ruleId: string): number | null {
  return value === null ? null : num(value, column, ruleId);
}

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
  self: { id: string },
  cohort: SQL,
): Promise<Metric[]> {
  const rows = await db.execute<DistributionRow>(sql`
    with cohort as (${cohort})
    select 'site' as scope, '' as scope_value, ${DISTRIBUTION_AGGREGATES} from cohort
    union all
    select 'page_type' as scope, page_type as scope_value,
           ${DISTRIBUTION_AGGREGATES}
    from cohort
    group by page_type
    order by scope, scope_value`);

  return rows.rows.map((row) => {
    const value = {
      count: num(row.count, "count", self.id),
      min: nullableNum(row.min, "min", self.id),
      p25: nullableNum(row.p25, "p25", self.id),
      median: nullableNum(row.median, "median", self.id),
      p75: nullableNum(row.p75, "p75", self.id),
      p95: nullableNum(row.p95, "p95", self.id),
      max: nullableNum(row.max, "max", self.id),
      mean: nullableNum(row.mean, "mean", self.id),
    };
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
async function extremes(db: Db, crawlId: string, self: { id: string }): Promise<Metric[]> {
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
 * `other`, ranked by count descending and then type name ascending so the cut
 * is deterministic. A site with hundreds of detected templates would otherwise
 * put hundreds of keys in one jsonb object.
 *
 * A target cohort NOTHING links to gets `{sources: {}}` rather than no row: the
 * runner deletes and rewrites a metric's rows every run, so an absent row means
 * "not computed", and "no page on this site links into this template" is a
 * finding worth stating.
 */
async function sourcesByType(db: Db, crawlId: string, self: { id: string }): Promise<Metric[]> {
  const rows = await db.execute<SourceTypeRow>(sql`
    with target as (
      select p.id as id, p.url as url, coalesce(p.page_type, ${UNTYPED}) as target_type
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
      join pages s on s.id = l.source_page_id and s.crawl_id = ${crawlId}
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
 * The four link-graph metrics. Every one is `info`: a metric states a number
 * about the site, and a number is not a fault — the judgement is the agent's.
 */
export const linkMetrics: MetricRule[] = [
  defineRule<MetricRule>({
    kind: "metric",
    id: "inlinks.distribution",
    checkIds: ["CHECK-33"],
    category: LINKS,
    severity: "info",
    ...copyFor("inlinks.distribution"),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Metric[]> =>
      distribution(db, crawlId, { id: "inlinks.distribution" }, inlinkCohort(crawlId)),
  }),

  defineRule<MetricRule>({
    kind: "metric",
    id: "inlinks.extremes",
    checkIds: ["CHECK-33"],
    category: LINKS,
    severity: "info",
    ...copyFor("inlinks.extremes"),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Metric[]> =>
      extremes(db, crawlId, { id: "inlinks.extremes" }),
  }),

  defineRule<MetricRule>({
    kind: "metric",
    id: "inlinks.sources-by-type",
    checkIds: ["CHECK-33b"],
    category: LINKS,
    severity: "info",
    ...copyFor("inlinks.sources-by-type"),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Metric[]> =>
      sourcesByType(db, crawlId, { id: "inlinks.sources-by-type" }),
  }),

  // Depth is a property of the page row rather than of the link table, so its
  // cohort is a plain select — but it is the SAME cohort, which is what lets a
  // reader put the depth table beside the inlink table and read them as two
  // views of one set of pages.
  defineRule<MetricRule>({
    kind: "metric",
    id: "structure.depth-distribution",
    checkIds: ["CHECK-31"],
    category: TECHNICAL,
    severity: "info",
    ...copyFor("structure.depth-distribution"),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Metric[]> =>
      distribution(
        db,
        crawlId,
        { id: "structure.depth-distribution" },
        sql`select coalesce(p.page_type, ${UNTYPED}) as page_type, p.depth as v
            from pages p
            where ${cohortFilter(crawlId)}`,
      ),
  }),
];

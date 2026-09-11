/**
 * What every metric rule measures, and how it checks what Postgres hands back.
 *
 * These three things — the cohort of pages, the sentinel a null `page_type`
 * groups under, and the run-time type check on a SQL column — were written once
 * for the link-graph metrics and are now shared by every metric file. They live
 * here rather than in one rule's file because they are the reason a reader can
 * put two metric tables side by side: `inlinks.distribution`,
 * `content.metrics-by-type` and `hreflang.coverage` count the SAME pages and
 * name the SAME untyped cohort, and that is a property of the metric layer
 * rather than of any one rule in it.
 */
import { sql, type SQL } from "drizzle-orm";

import type { MetricColumn } from "../registry/metric-table.js";

/**
 * THE EIGHT COLUMNS OF A DISTRIBUTION, headed once for every metric that has
 * one.
 *
 * `readStats` below writes exactly these eight keys, and five metrics print them
 * — the two depth distributions, the inlink distribution, and the two
 * per-measure tables. One constant, so the same statistic is under the same
 * heading in all five and a reader comparing two of them is comparing columns
 * rather than spellings.
 *
 * THE ORDER IS THE READING ORDER AND IT IS NOT THE SORTED ONE: the count, then
 * the floor, then the quartile, then the two middles — median beside mean,
 * because the pair is the shape of the distribution and a reader compares them
 * to each other — then the upper tail and the ceiling. `count` is headed `Pages`
 * because that is what it counts in every one of the five tables.
 */
export const DISTRIBUTION_COLUMNS: readonly MetricColumn[] = [
  { key: "count", label: "Pages" },
  { key: "min", label: "Min" },
  { key: "p25", label: "P25" },
  { key: "median", label: "Median" },
  { key: "mean", label: "Mean" },
  { key: "p75", label: "P75" },
  { key: "p95", label: "P95" },
  { key: "max", label: "Max" },
];

/**
 * The scope value a cohort of pages with no `page_type` is filed under.
 *
 * Parenthesised so it reads as a label rather than as a template name a site
 * might really have — but that is a courtesy to the reader, NOT a uniqueness
 * claim. The crawler's typing (src/crawl/page-type.ts) produces a detected URL
 * template (`/blog/:id/:slug`, per URL and then collapsed over the whole
 * population at crawl end), which cannot be spelled this way, or a
 * CLIENT-CONFIGURED name, which can: nothing stops a client calling a bucket
 * `(untyped)`.
 *
 * That case is handled rather than argued away, and the handling is the reason
 * the coalesce lives inside each cohort CTE instead of in an outer `GROUP BY`:
 * a client-named `(untyped)` and the untyped pages MERGE into one cohort, one
 * row, one scope value. A merge is the only sound answer — the two are
 * indistinguishable by the time a reader has the table — and doing it in the
 * cohort makes it structural. Coalescing later would instead produce two groups
 * projecting one scope value, which is two rows for one primary key and a rule
 * the runner rejects for answering the same question twice.
 *
 * The empty string was not available for the sentinel: it is what a
 * site-scoped row stores in the metrics primary key.
 */
export const UNTYPED = "(untyped)";

/**
 * The pages every metric measures: fetched OK, 200, indexable.
 *
 * A 404, a redirect or a noindex page is not competing for crawl attention or
 * link equity, so counting it would move every number in every metric table
 * without describing anything a client can act on.
 *
 * The alias is fixed at `p` rather than parameterised, because a shared cohort
 * whose spelling varied per caller would be back to being restated per rule.
 * Every metric query below aliases `pages` as `p` in the CTE this predicate
 * filters. Where a rule reads the SOURCE side of a relationship — the page
 * making a link, rather than the page being measured — it deliberately does NOT
 * apply this: a noindex page still links, and the link it makes is still a link.
 */
export function cohortFilter(crawlId: string): SQL {
  return sql`p.crawl_id = ${crawlId}
    and p.fetch_class = 'ok'
    and p.status_code = 200
    and p.is_indexable`;
}

/**
 * The cohort's `page_type`, already coalesced — see `UNTYPED` for why the
 * coalesce belongs in the cohort rather than in an outer `GROUP BY`.
 *
 * Aliased `p` like `cohortFilter`, so it names the page being MEASURED. Where a
 * query also types the other side of a relationship — the page making a link —
 * that one spells its own coalesce, because it is a different page and a
 * different alias, and hiding that behind this constant would read as though
 * the two were the same cohort.
 */
export const COHORT_PAGE_TYPE: SQL = sql`coalesce(p.page_type, ${UNTYPED})`;

/**
 * The eight numbers of a distribution over one column, prefixed so several of
 * them can be selected side by side in one statement.
 *
 * `count` is `count(<column>)`, NOT `count(*)`: it is how many pages carry a
 * value for this measure. The two differ when the analyzer wrote no measurement
 * for a page, and the difference matters — `percentile_cont` and `avg` skip
 * nulls silently, so a `count(*)` beside them would claim a population the
 * statistics were not computed over. A page with no word count is absent from
 * the word-count column and present in the text-ratio one; each column says how
 * many pages it actually measured.
 *
 * Rounding is IN SQL and per measure, because measures live on different
 * scales. Word counts are quotable at two decimal places; a text ratio is a
 * fraction between 0 and 1, where two decimal places would collapse distinct
 * templates into one number, so it keeps four; a byte count is an integer and
 * takes none.
 *
 * IT LIVES HERE, beside the cohort, rather than in the file that first needed
 * it: `content.metrics-by-type` wrote it, `page.weight` (P11-T3) is the second
 * caller, and a distribution copied into a second metric file is a second place
 * for the null-handling above to be got wrong. Same reason `cohortFilter` and
 * `UNTYPED` are here.
 */
export function statsAggregates(column: SQL, prefix: string, decimals: number): SQL {
  const as = (name: string): SQL => sql.raw(`${prefix}_${name}`);
  const places = sql.raw(String(decimals));
  const rounded = (expr: SQL): SQL => sql`round((${expr})::numeric, ${places})::float8`;
  const pct = (q: string): SQL =>
    rounded(sql`percentile_cont(${sql.raw(q)}) within group (order by ${column})`);
  return sql`
    count(${column})::int as ${as("count")},
    ${rounded(sql`min(${column})`)} as ${as("min")},
    ${pct("0.25")} as ${as("p25")},
    ${pct("0.5")} as ${as("median")},
    ${pct("0.75")} as ${as("p75")},
    ${pct("0.95")} as ${as("p95")},
    ${rounded(sql`max(${column})`)} as ${as("max")},
    ${rounded(sql`avg(${column})`)} as ${as("mean")}`;
}

/**
 * The columns of one prefixed distribution, read back and type-checked.
 *
 * Indexed by name rather than destructured because a query selects several of
 * these shapes into one row under different prefixes; the row types that carry
 * them are index signatures for the same reason.
 */
export function readStats(
  row: Record<string, unknown>,
  prefix: string,
  ruleId: string,
): Record<string, number | null> {
  const read = (name: string): number | null =>
    nullableNum(row[`${prefix}_${name}`], `${prefix}_${name}`, ruleId);
  return {
    count: num(row[`${prefix}_count`], `${prefix}_count`, ruleId),
    min: read("min"),
    p25: read("p25"),
    median: read("median"),
    p75: read("p75"),
    p95: read("p95"),
    max: read("max"),
    mean: read("mean"),
  };
}

/**
 * A number from a SQL row, checked rather than cast.
 *
 * The casts in the metric queries are what make these columns `int4`/`float8`
 * — types the driver parses to JavaScript numbers. A cast dropped in an edit
 * would hand back an `int8` or a `numeric`, which arrive as STRINGS, and
 * `{count: "10"}` in a jsonb column is a metric that reads correctly and
 * compares wrongly forever after. It fails here instead (hard rule 7).
 */
export function num(value: unknown, column: string, ruleId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${ruleId}: column '${column}' came back as ${typeof value}, not a number`);
  }
  return value;
}

/** The same, for the statistics that are null over an empty cohort. */
export function nullableNum(value: unknown, column: string, ruleId: string): number | null {
  return value === null ? null : num(value, column, ruleId);
}

/**
 * A boolean column from a SQL row, checked the same way.
 *
 * The driver returns Postgres `bool` as a JavaScript boolean, so what this
 * catches is a column that stopped being one — a `count(*) > 0` rewritten as a
 * `count(*)`, a boolean built by string concatenation. `{isTracking: "f"}` in a
 * jsonb column is truthy to every later reader, which is the quietest possible
 * way for a flag to invert.
 */
export function bool(value: unknown, column: string, ruleId: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${ruleId}: column '${column}' came back as ${typeof value}, not a boolean`);
  }
  return value;
}

/**
 * A text column from a SQL row, checked the same way and for the same reason:
 * a `scope_value` that arrived as something other than a string would be
 * stringified into the metrics primary key as `[object Object]`.
 */
export function text(value: unknown, column: string, ruleId: string): string {
  if (typeof value !== "string") {
    throw new Error(`${ruleId}: column '${column}' came back as ${typeof value}, not a string`);
  }
  return value;
}

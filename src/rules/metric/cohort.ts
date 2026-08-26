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

/**
 * The scope value a cohort of pages with no `page_type` is filed under.
 *
 * Parenthesised so it reads as a label rather than as a template name a site
 * might really have — but that is a courtesy to the reader, NOT a uniqueness
 * claim. `derivePageType` returns a detected URL template (`/blog/:id/:slug`),
 * which cannot be spelled this way, or a CLIENT-CONFIGURED name, which can:
 * nothing stops a client calling a bucket `(untyped)`.
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

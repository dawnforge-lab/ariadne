/**
 * The hreflang metric: how much of the site actually declares its alternates
 * (CHECK-24).
 *
 * The hreflang QUERY rules answer "are the declarations this site makes
 * correct" — invalid codes, missing return links, non-indexable targets, absent
 * x-default. None of them can answer "how much of the site declares anything at
 * all", because a page with no hreflang breaks no rule; it is simply outside
 * every declaration set. On an international site that silence is the finding,
 * and it is a number rather than a fault, so it belongs here.
 *
 * Same properties as every metric: computed by Postgres, over the shared cohort
 * (`./cohort.js`), with a null `page_type` under the `UNTYPED` sentinel, and a
 * crawl id nothing knows REFUSED rather than answered (`assertCrawl`; see
 * property 5 in `./link-metrics.js`).
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { COHORT_PAGE_TYPE, cohortFilter, nullableNum, num, text } from "./cohort.js";

const HREFLANG = "hreflang";

type CoverageRow = {
  scope: string;
  scope_value: string;
  pages_with_hreflang: number;
  indexable_pages: number;
  coverage_pct: number | null;
};

/**
 * Coverage for the site and for each template.
 *
 * A page is COVERED when it publishes at least one hreflang declaration, from
 * any source the crawler records — HTML `<link>`, HTTP header or sitemap entry.
 * The unit is the page, not the declaration: `exists`, so a page naming six
 * alternates is one covered page and not six, and a page naming one is as
 * covered as a page naming twelve. Whether the set it names is COMPLETE is the
 * query rules' subject, and a coverage number that quietly answered a different
 * question would be quoted as if it had answered this one.
 *
 * `coveragePct` is computed in SQL as `100 × covered / cohort`, rounded to one
 * decimal place, and is NULL over an empty cohort rather than 0: nothing was
 * measured, and "0% of this site declares hreflang" is a statement about a site
 * that the absence of pages does not support (hard rule 7 — no number invented
 * to fill a hole).
 *
 * The site row comes from the same CTE as the cohort rows in one statement, so
 * the two cannot disagree, and it is emitted even for an empty cohort: an
 * absent metric row means the rule did not run.
 */
async function coverage(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // An unknown crawl produces the same site row an empty cohort does —
  // `0 / 0`, coverage null. Refused instead.
  await assertCrawl(db, crawlId, self.id);

  const aggregates = sql`
    count(*) filter (where covered)::int as pages_with_hreflang,
    count(*)::int as indexable_pages,
    case when count(*) = 0 then null
         else round(100.0 * count(*) filter (where covered) / count(*), 1)::float8
    end as coverage_pct`;

  const rows = await db.execute<CoverageRow>(sql`
    with cohort as (
      select ${COHORT_PAGE_TYPE} as page_type,
             exists (
               select 1 from hreflang h
               where h.crawl_id = ${crawlId} and h.page_id = p.id
             ) as covered
      from pages p
      where ${cohortFilter(crawlId)}
    )
    select 'site' as scope, '' as scope_value, ${aggregates} from cohort
    union all
    select 'page_type' as scope, page_type as scope_value, ${aggregates}
    from cohort
    group by page_type
    order by scope, scope_value`);

  return rows.rows.map((row) => {
    const value = {
      pagesWithHreflang: num(row.pages_with_hreflang, "pages_with_hreflang", self.id),
      indexablePages: num(row.indexable_pages, "indexable_pages", self.id),
      coveragePct: nullableNum(row.coverage_pct, "coverage_pct", self.id),
    };
    if (row.scope === "site") return metricRow(self, { scope: "site", value });
    return metricRow(self, {
      scope: "page_type",
      scopeValue: text(row.scope_value, "scope_value", self.id),
      value,
    });
  });
}

export const hreflangMetrics: MetricRule[] = [
  metricRule("hreflang.coverage", ["CHECK-24"], HREFLANG, async (db, crawlId, self) =>
    coverage(db, crawlId, self),
  ),
];

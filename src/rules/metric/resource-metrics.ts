/**
 * `page.weight`: how many bytes a page of each template is made of.
 *
 * The HTML the server sent (`pages.html_bytes`) plus the bytes of every file
 * that page's HTML points at, joined through `page_resources` and weighed by the
 * resource fetch pass. One statement, five distributions, one row per template
 * and one for the site — the `content.metrics-by-type` shape, and deliberately
 * so: two metric tables a reader puts side by side must count the same pages
 * (`./cohort.js`) and name the same untyped cohort.
 *
 * ## TWO BOUNDS, AND WHY THE ROW STATES BOTH
 *
 * **A ceiling.** `page_resources` is the analyzer's reference list, and an
 * `<img>` carrying both `src` and `srcset` contributes BOTH URLs — the fallback
 * and the first rendition, two real files, with nothing in the schema saying
 * which a given client would pick (the caveat is written on the table itself,
 * src/db/schema.ts). A browser downloads one of them. So on a responsive
 * template the sum over-counts, roughly two-fold on such images, and the number
 * is an upper bound rather than a measurement of one visit.
 *
 * **A floor.** A referenced file the pass never weighed — unasked
 * (`fetch_class` null), refused by our own policy, disallowed by robots, a
 * request that failed, or a response with no size — contributes nothing to the
 * sum. Those files exist and have weight; we do not know how much. So the sum is
 * also a lower bound, and `pagesWithUnmeasuredResources` and `atLeast` are what
 * say by how much of the page.
 *
 * Two honest bounds around a number nobody can measure exactly from markup, not
 * one number pretending to be the answer — which is the ruling `page_resources`'
 * own header hands this metric, discharged here and in the copy.
 *
 * ## WHAT IT CANNOT SEE
 *
 * Only the SERVED HTML's references (the `resources` table's standing caveat):
 * an asset injected by JavaScript is not in the table, so a client-rendered site
 * weighs far less here than in a browser. Fonts, media and favicons are out of
 * scope this phase (owner decision 1), so they are absent from the sum as well —
 * this is the weight of the HTML, images, stylesheets and scripts a page
 * declares, stated as such wherever it is quoted.
 *
 * ## THE CHECKS IT EVIDENCES
 *
 * CHECK-48 ("Render-blocking resources and JS bundle size") for its script
 * column — bundle SIZE per template is exactly what that check records, while
 * whether a script blocks rendering and how much of it goes unused stay browser
 * work, because neither is in anything this crawl stores. CHECK-49 ("Image
 * optimisation") for its image column, beside the per-file findings that name
 * the offenders. It is a METRIC, so it evidences and does not judge: there is no
 * threshold here, no verdict, and the checklist's own Evaluate lines are the
 * agent's to apply.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import { perScopeMeasure } from "../registry/metric-table.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import {
  COHORT_PAGE_TYPE,
  cohortFilter,
  DISTRIBUTION_COLUMNS,
  num,
  readStats,
  statsAggregates,
  text,
} from "./cohort.js";

/** The prefixes of the five distributions, and the keys they are read back as. */
const WEIGHT = "weight";
const HTML = "html";
const IMAGE = "image";
const CSS = "css";
const JS = "js";

/**
 * A type alias with an index signature, for `content.metrics-by-type`'s reason:
 * `db.execute<T>` needs `T extends Record<string, unknown>`, and the forty
 * statistic columns are addressed by computed name. `num`/`readStats` are what
 * check the driver's actual output — the declared type checks nothing.
 */
type WeightRow = Record<string, unknown> & { scope: string; scope_value: string };

/**
 * The bytes of one kind of resource on one page, counted only where the pass
 * actually weighed the file.
 *
 * `fetch_class = 'ok' and bytes is not null` is the whole population, and the
 * `filter` rather than a `where` is what keeps the unweighed rows visible: they
 * still count towards `referenced`, which is how the coverage pair below can say
 * a page referenced eleven files and we weighed three.
 */
function kindBytes(kind: string): ReturnType<typeof sql> {
  return sql`coalesce(sum(r.bytes) filter (
    where r.fetch_class = 'ok' and r.bytes is not null and r.kind = ${kind}
  ), 0)::bigint`;
}

async function pageWeight(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // A crawl id nothing knows has no pages, which aggregates to a site row of
  // zeroes and null statistics — the same answer an empty crawl gives. Two
  // facts sharing one shape is the silent failure hard rule 7 forbids.
  await assertCrawl(db, crawlId, self.id);

  const aggregates = sql`${statsAggregates(sql`page_weight`, WEIGHT, 0)},
    ${statsAggregates(sql`html_bytes`, HTML, 0)},
    ${statsAggregates(sql`image_bytes`, IMAGE, 0)},
    ${statsAggregates(sql`css_bytes`, CSS, 0)},
    ${statsAggregates(sql`js_bytes`, JS, 0)},
    coalesce(sum(referenced), 0)::int as resources_referenced,
    coalesce(sum(weighed), 0)::int as resources_weighed,
    count(*) filter (where referenced > weighed)::int as pages_unmeasured,
    -- float8, not the int8 the sum is: the driver hands an int8 back as a
    -- STRING, and the num() guard would fail rather than run. Bytes past
    -- 2^53 are not a case anything here has.
    coalesce(sum(other_bytes), 0)::float8 as other_bytes,
    string_agg(distinct other_kinds, ', ') as other_kinds`;

  const result = await db.execute<WeightRow>(sql`
    with cohort as (
      select p.id, ${COHORT_PAGE_TYPE} as page_type, p.html_bytes
      from pages p
      where ${cohortFilter(crawlId)}
    ),
    edges as (
      select pr.page_id,
             count(*)::int as referenced,
             count(*) filter (
               where r.fetch_class = 'ok' and r.bytes is not null
             )::int as weighed,
             ${kindBytes("image")} as image_bytes,
             ${kindBytes("css")} as css_bytes,
             ${kindBytes("js")} as js_bytes,
             -- The guard below: bytes this table has no column for, and the
             -- kinds that produced them.
             coalesce(sum(r.bytes) filter (
               where r.fetch_class = 'ok' and r.bytes is not null
                 and r.kind not in ('image', 'css', 'js')
             ), 0)::bigint as other_bytes,
             string_agg(distinct r.kind, ', ') filter (
               where r.kind not in ('image', 'css', 'js')
             ) as other_kinds
      from page_resources pr
      join resources r on r.crawl_id = pr.crawl_id and r.url = pr.resource_url
      where pr.crawl_id = ${crawlId}
      group by pr.page_id
    ),
    per_page as (
      select c.page_type,
             c.html_bytes::float8 as html_bytes,
             coalesce(e.image_bytes, 0)::float8 as image_bytes,
             coalesce(e.css_bytes, 0)::float8 as css_bytes,
             coalesce(e.js_bytes, 0)::float8 as js_bytes,
             -- Null when the page's own HTML size was never recorded: a page
             -- weight without the page's HTML in it is not this page's weight,
             -- and a null drops out of every statistic rather than counting as
             -- a light page (the per-measure count contract).
             (c.html_bytes + coalesce(
                e.image_bytes + e.css_bytes + e.js_bytes + e.other_bytes, 0
              ))::float8 as page_weight,
             coalesce(e.referenced, 0) as referenced,
             coalesce(e.weighed, 0) as weighed,
             coalesce(e.other_bytes, 0) as other_bytes,
             e.other_kinds
      from cohort c
      left join edges e on e.page_id = c.id
    )
    select 'site' as scope, '' as scope_value, ${aggregates} from per_page
    union all
    select 'page_type' as scope, page_type as scope_value, ${aggregates}
    from per_page
    group by page_type
    order by scope, scope_value`);

  return result.rows.map((row) => {
    const otherBytes = num(row.other_bytes, "other_bytes", self.id);
    if (otherBytes > 0) {
      // `ResourceKind` is image|css|js (src/crawl/parse/page-analyzer.ts) and
      // the three columns below break the sum out by exactly those. A fourth
      // kind would be inside `page_weight` and inside none of the columns, so
      // the breakdown would silently stop adding up to the total it breaks
      // down. Adding a kind means adding a column here, deliberately.
      throw new Error(
        `${self.id}: crawl '${crawlId}' weighs ${otherBytes} byte(s) of resources whose ` +
          `kind (${row.other_kinds ?? "unknown"}) is not image, css or js — the per-kind ` +
          `columns would no longer add up to the page weight`,
      );
    }
    const referenced = num(row.resources_referenced, "resources_referenced", self.id);
    const weighed = num(row.resources_weighed, "resources_weighed", self.id);
    const value = {
      pageWeight: readStats(row, WEIGHT, self.id),
      htmlBytes: readStats(row, HTML, self.id),
      imageBytes: readStats(row, IMAGE, self.id),
      cssBytes: readStats(row, CSS, self.id),
      jsBytes: readStats(row, JS, self.id),
      resourcesReferenced: referenced,
      resourcesWeighed: weighed,
      pagesWithUnmeasuredResources: num(row.pages_unmeasured, "pages_unmeasured", self.id),
      // Derived from the pair beside it rather than computed a second way in
      // SQL: the flag and the counts cannot then disagree, and the counts are
      // what a reader checks it against.
      atLeast: referenced > weighed,
    };
    if (row.scope === "site") return metricRow(self, { scope: "site", value });
    return metricRow(self, {
      scope: "page_type",
      scopeValue: text(row.scope_value, "scope_value", self.id),
      value,
    });
  });
}

export const resourceMetrics: MetricRule[] = [
  // CHECK-48 for the script column and CHECK-49 for the image one — evidence
  // for two checks whose verdicts stay with the agent, exactly as the module
  // header states. Neither claim is the whole check: render-blocking analysis
  // and unused-JavaScript measurement are browser work and remain so.
  metricRule(
    "page.weight",
    ["CHECK-48", "CHECK-49"],
    "technical",
    // FIVE MEASURES, then four facts about the SCOPE repeated on each of its
    // measure rows. The four are a property of the cohort and not of any one
    // byte count — how many files its pages reference, how many were weighed,
    // how many pages carry a file nobody weighed, and whether the whole row is
    // therefore a floor — and they have to be beside every row because a reader
    // quoting the image median needs to know the images were not fetched.
    perScopeMeasure(
      "Template",
      [
        { key: "pageWeight", label: "Page Weight" },
        { key: "htmlBytes", label: "HTML" },
        { key: "imageBytes", label: "Images" },
        { key: "cssBytes", label: "CSS" },
        { key: "jsBytes", label: "JavaScript" },
      ],
      DISTRIBUTION_COLUMNS,
      [
        { key: "resourcesReferenced", label: "File References" },
        { key: "resourcesWeighed", label: "Files Weighed" },
        { key: "pagesWithUnmeasuredResources", label: "Pages With Unweighed Files" },
        { key: "atLeast", label: "Floor" },
      ],
      7,
    ),
    async (db, crawlId, self) => pageWeight(db, crawlId, self),
  ),
];

/**
 * The URL-parameter metric: how much of this site's URL space is query
 * parameters, and which parameters make it up (CHECK-29, CHECK-27).
 *
 * The url-hygiene QUERY rules answer "is this particular parameterised URL
 * indexable when it should not be" — one finding per URL, one fix per URL.
 * Faceted navigation is not that question: a site with 40,000 filter
 * combinations has one decision to make about its facets, and the input to that
 * decision is the SHAPE of the parameter space — how many distinct parameters
 * exist, which ones carry the volume, how many of the crawled URLs carry any
 * parameter at all. That is a table of numbers rather than a list of faults,
 * which is why CHECK-29 waited for the metric layer.
 *
 * **Ordering dependency, and why it is safe.** Every number here comes from
 * `url_params`, which is written by the `deriveUrlParams` DERIVATION, not by
 * the crawler. `runRules` runs the phases in a fixed order — page rules,
 * derivations, query rules, metrics — so the inventory is current for this
 * crawl by the time this rule runs. The rule does not rebuild it and must not:
 * a metric that recomputed the inventory could report a parameter space the
 * `url.*` findings were never judged against. If the inventory is empty for a
 * crawl whose pages carry `?`, that is a derivation that did not run, and it
 * shows up here as `totalParams: 0` beside a non-zero `parameterisedPages` —
 * two columns that cannot both be right, which is the loudest a metric gets.
 *
 * Same properties as every metric: computed by Postgres, never a table pulled
 * into memory (hard rule 3).
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import { expandList } from "../registry/metric-table.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { bool, cohortFilter, num, text } from "./cohort.js";

// Named `URL_CATEGORY` rather than `URL`: a module-level `URL` shadows the
// global one, and a later edit reaching for `new URL(...)` here would get a
// string instead of a constructor.
const URL_CATEGORY = "url";

/**
 * How many parameters `topParams` names.
 *
 * The whole inventory is not on offer here: a faceted site can carry hundreds
 * of distinct parameter names, and a metric row is a jsonb value that travels
 * into a report and into an agent's context. Twenty is the head of the
 * distribution — the parameters that actually shape the crawl surface — and
 * `totalParams` beside it says how many there are in total, so a truncated list
 * is never mistaken for the whole inventory. The full inventory is a table
 * (`url_params`) the agent can query when it wants the tail.
 */
export const TOP_PARAMS_CAP = 20;

type TotalsRow = {
  total_params: number;
  tracking_params: number;
  parameterised_pages: number;
  parameterised_indexable_pages: number;
};

type ParamRow = {
  param_name: string;
  occurrence_count: number;
  is_tracking: boolean;
};

/**
 * The site's parameter volumes, and the twenty parameters carrying the most of
 * them (CHECK-29 — faceted navigation; CHECK-27 — the parameter audit).
 *
 * One site row, always, even for a site that uses no parameters at all: an
 * absent metric row means the rule did not run, and "this site publishes no
 * parameterised URLs" is an answer worth stating.
 *
 * **What each column counts.**
 *
 *  - `totalParams` / `trackingParams` — distinct parameter NAMES in the crawl's
 *    inventory, and how many of those are the campaign tags and ad-click ids
 *    `TRACKING_PARAMS` names. The classification is the derivation's, read from
 *    `url_params.is_tracking` rather than restated here: a second list would
 *    drift from the one `url.tracking-params-internal` fires on, and the drift
 *    would be invisible — a table flagging a parameter no rule reports.
 *  - `topParams` — the same inventory, ordered by how many URLs carry each
 *    parameter, descending, ties broken by parameter name ascending so two runs
 *    over one crawl name the same twenty in the same order (the deterministic-
 *    cap lesson). `occurrences` is a count of URLS, not of occurrences within
 *    them: `?tag=a&tag=b` is one URL carrying `tag`.
 *  - `parameterisedPages` — pages of this crawl whose URL carries a query
 *    string, over EVERY page row the crawl wrote, whatever its status. That is
 *    the population the inventory itself was built from, and the two would
 *    otherwise be percentages of different sites.
 *  - `parameterisedIndexablePages` — the subset of those in the shared metric
 *    cohort (fetched OK, 200, indexable). This is the number CHECK-29 turns on:
 *    a filter URL that 404s or carries a noindex is a crawl-budget question,
 *    while one that is indexable is competing with the page it was filtered
 *    from.
 *
 * The `?` test is `position('?' in url) > 0`, the same test `deriveUrlParams`
 * splits on, so a page counted here is a page the inventory could have taken a
 * parameter from. A URL whose query string is empty (`/x?`) carries a `?` and
 * contributes no parameter name — it is one parameterised page with nothing in
 * the inventory, which is what both columns then say.
 */
async function paramVolumes(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // A crawl id nothing knows aggregates to zeroes, and a table of zeroes reads
  // exactly like a site that publishes no parameters (hard rule 7, and
  // `runRules`' own precedent).
  await assertCrawl(db, crawlId, self.id);

  const totals = await db.execute<TotalsRow>(sql`
    select
      (select count(*)::int from url_params up where up.crawl_id = ${crawlId})
        as total_params,
      (select count(*)::int from url_params up
        where up.crawl_id = ${crawlId} and up.is_tracking)
        as tracking_params,
      count(*) filter (where position('?' in p.url) > 0)::int as parameterised_pages,
      count(*) filter (where position('?' in p.url) > 0 and ${cohortFilter(crawlId)})::int
        as parameterised_indexable_pages
    from pages p
    where p.crawl_id = ${crawlId}`);

  const row = totals.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns exactly one row over any input,
    // including none. No row at all is therefore not "this crawl has no pages"
    // — it is a statement that did not run the way it reads.
    throw new Error(`${self.id}: crawl '${crawlId}' totals query returned no row`);
  }

  const top = await db.execute<ParamRow>(sql`
    select up.param_name, up.occurrence_count, up.is_tracking
    from url_params up
    where up.crawl_id = ${crawlId}
    order by up.occurrence_count desc, up.param_name asc
    limit ${TOP_PARAMS_CAP}`);

  return [
    metricRow(self, {
      scope: "site",
      value: {
        totalParams: num(row.total_params, "total_params", self.id),
        trackingParams: num(row.tracking_params, "tracking_params", self.id),
        topParams: top.rows.map((p) => ({
          name: text(p.param_name, "param_name", self.id),
          occurrences: num(p.occurrence_count, "occurrence_count", self.id),
          isTracking: bool(p.is_tracking, "is_tracking", self.id),
        })),
        parameterisedIndexablePages: num(
          row.parameterised_indexable_pages,
          "parameterised_indexable_pages",
          self.id,
        ),
        parameterisedPages: num(row.parameterised_pages, "parameterised_pages", self.id),
      },
    }),
  ];
}

export const urlMetrics: MetricRule[] = [
  // THE TABLE IS THE PARAMETER LIST; the four site-wide counts are the summary
  // above it. Putting those counts in columns would repeat one site's four
  // numbers on every parameter row, and the row a reader acts on is the
  // parameter.
  metricRule(
    "url.param-volumes",
    ["CHECK-29", "CHECK-27"],
    URL_CATEGORY,
    expandList(
      "topParams",
      [
        { key: "name", label: "Parameter" },
        { key: "occurrences", label: "URLs" },
        { key: "isTracking", label: "Tracking" },
      ],
      [
        { key: "totalParams", label: "Parameters Found" },
        { key: "trackingParams", label: "Tracking Parameters" },
        { key: "parameterisedPages", label: "URLs With Parameters" },
        { key: "parameterisedIndexablePages", label: "Indexable URLs With Parameters" },
      ],
      13,
    ),
    async (db, crawlId, self) => paramVolumes(db, crawlId, self),
  ),
];

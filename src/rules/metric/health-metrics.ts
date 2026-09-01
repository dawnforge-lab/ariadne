/**
 * The health rollup: how this crawl's own judgement distributes over the pages
 * it judged.
 *
 * Every other metric in this directory measures the SITE — its links, its
 * sitemap, its text, its redirects. This one measures the JUDGEMENT: it counts
 * the auditable pages, and it counts how many of them carry a finding, once
 * each, at the worst severity they carry. It answers "how much of this site did
 * the ruleset have something to say about", which is a question about the
 * `issues` table rather than about the client.
 *
 * ## Why it exists, and what it deliberately is not
 *
 * Talos' Site Audit UI draws a health gauge (`docs/talos-integration.md`
 * obligation 6, the owner's decision of 2026-09-01). **Ariadne emits the
 * ingredients and the documented ratio; Talos owns the gauge, the thresholds
 * and the labels.** So there is no grade in this row, no letter, no band, no
 * "good/poor", and no threshold anywhere in the copy — a number and its
 * definition, and the consumer decides what it means. A grade computed here
 * would be the engine passing judgement, which is the agent's job in the audit
 * product and the UI's job in the Talos one.
 *
 * ## THE CHECKLIST CLAIM IS STRUCTURAL, NOT SEMANTIC — read this before
 * quoting `checkIds`
 *
 * Hard rule 10 says a rule carries the checklist ids it answers, and
 * `defineRule` enforces at least one. **No check in
 * `skills/ariadne-audit/checklist.md` asks for a site-wide judgement rollup** —
 * the file was read end to end for this rule, all 81 checks, and the closest
 * thing to a statement about one is Evaluation Principle 2, which says the
 * opposite: "Never answer a check from a crawl summary. Use the source the
 * check names." This row IS a crawl summary. An auditor walking the checklist
 * should never reach a verdict from it.
 *
 * It is filed under CHECK-32 because that is where the checklist keeps a
 * PARTITION OF THE PAGE CENSUS: `structure.depth-distribution` sits there,
 * counting the same pages into depth buckets with one bucket (unreachable)
 * carrying the meaning, which is this row's shape exactly. That is a filing
 * decision and nothing more. **It is not a claim that this metric answers the
 * orphan check**, and an agent must not quote it as one. The alternatives were
 * to invent a checklist check for a dashboard feature (the audit product does
 * not change in this phase — owner decision 5) or to weaken `defineRule`'s
 * one-check-minimum (which would put a hole in rule 10's guard for every future
 * rule, and would break the `rules_catalog` contract that every rule carries at
 * least one check id). Both were rejected, the reasoning is in the Phase 10 T2
 * report, and the reviewer owns the ruling.
 *
 * ## The census, and what is outside it
 *
 * `urlsTotal` is the AUDITABLE pages: fetched OK with a 200, which is
 * `isAuditable` in src/rules/helpers.ts and the population nearly every page
 * rule guards itself with. It is deliberately NOT `cohortFilter`'s cohort (the
 * other metrics'), which additionally requires `is_indexable`: a noindex 200
 * page is still judged — `indexability.noindex`, `canonical.noindex-canonicalised`
 * and every on-page rule fire on it — so excluding it would leave findings
 * attached to pages the denominator had never heard of, and four buckets that
 * do not partition anything.
 *
 * It is also not the crawl's page count. A redirect, a 404, a 5xx or a
 * connection failure is not a page the ruleset can judge as CONTENT, and the
 * findings those pages do carry belong to the status rules and to
 * `redirect.volume`. They are excluded from every bucket here — and
 * `pagesNotAuditable` is the column that says how many, so the exclusion is a
 * number a reader can see rather than a silence they have to infer
 * (`urlsTotal + pagesNotAuditable` is the crawl's page count). On the Phase 10
 * reference crawl that is 443 auditable pages and 108 outside, carrying 97
 * findings between them: without the column, a health row of 443 would look
 * like the whole crawl.
 *
 * ## The ratio is over REPORTED findings
 *
 * `cleanRatio` counts pages with no finding IN THE `issues` TABLE. Under a
 * `findingCap` the listing rules stop writing rows at the cap and record the
 * exact total in a truncation note, so pages past the cap carry no row and land
 * in `urlsClean`. That is deliberate and it is the only coherent answer: this
 * metric describes THE JUDGEMENT THAT EXISTS, and re-deriving a hypothetical
 * uncapped judgement inside a metric would mean re-running the rules. What it
 * costs is stated in the copy rather than hidden: on a capped run the ratio is
 * a floor of what is known, not a fact about the site. Ariadne's own reference
 * crawls are uncapped, so no reference number here is affected.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import type { Metric, MetricRule, Severity } from "../registry/registry.js";
import { nullableNum, num } from "./cohort.js";

/**
 * The severities, worst first. ONE list, used twice in the statement below: to
 * build the `case` that ranks a finding, and to build the guard that refuses a
 * severity the ranking does not know.
 *
 * The order is the ranking — `min` over it is "the worst severity this page
 * carries" — so a severity added to `Severity` without a place here is a
 * severity the `case` maps to null, which is the shape of "no finding at all".
 * A page whose only finding was an unranked one would then be counted CLEAN,
 * which is hard rule 1's always-passes defect with a metric's face on. Hence
 * the guard: an unmapped severity throws and names itself.
 */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "warning", "info"];

type HealthRow = {
  urls_total: number;
  urls_with_critical: number;
  urls_with_warning_only: number;
  urls_with_info_only: number;
  urls_clean: number;
  clean_ratio: number | null;
  pages_not_auditable: number;
  unmapped_severities: number;
  unmapped_list: string | null;
};

/**
 * One site row: the auditable census, its four severity buckets, and the ratio.
 *
 * The columns, in the order they are written:
 *
 *  - `urlsTotal` — auditable pages: fetched OK, status 200. The denominator of
 *    everything below it, and the module header says why it is neither the
 *    crawl's page count nor the metric cohort.
 *  - `urlsWithCritical` — pages whose worst finding is critical.
 *  - `urlsWithWarningOnly` — pages carrying at least one warning and no
 *    critical.
 *  - `urlsWithInfoOnly` — pages carrying only info findings.
 *  - `urlsClean` — pages carrying no finding of any severity.
 *  - `cleanRatio` — `urlsClean / urlsTotal`, four decimal places. NULL over an
 *    empty census rather than 0 or 1: nothing was measured, and both of those
 *    are claims about a site that has no auditable pages (`redirect.volume`'s
 *    `ratioPct` answers the same way for the same reason).
 *  - `pagesNotAuditable` — pages the crawl fetched that this census excludes.
 *
 * **The four buckets partition `urlsTotal` exactly**, and that is a property of
 * the statement rather than a hope: every cohort page appears once on the left
 * of the join, and the four filters are over `rank ∈ {1,2,3}` and `rank is
 * null`, which are mutually exclusive and cover the domain.
 *
 * A finding whose `page_id` is null — the sitemap, robots and host rules speak
 * about the site, not about a page — joins to no cohort row and therefore
 * poisons no bucket. It is not counted anywhere in this table; a site-level
 * fault is not a share of the pages.
 *
 * ONE GROUPED PASS, no per-page iteration: the worst severity per page is a
 * `min` over the ordered mapping inside a single `group by page_id`, and the
 * buckets are `filter`ed counts over the result. A crawl with 17,659 findings
 * over 443 pages is one statement, not 443.
 */
async function siteHealth(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // A crawl id nothing knows has no pages, which aggregates to a census of zero
  // and a null ratio — the same answer an empty crawl gives. Two facts sharing
  // one shape is the silent failure hard rule 7 forbids.
  await assertCrawl(db, crawlId, self.id);

  const severities = sql.param([...SEVERITY_ORDER]);
  // `when 'critical' then 1 when 'warning' then 2 when 'info' then 3` — built
  // from the list above so the ranking and the guard below cannot disagree. The
  // rank is `sql.raw` because it is an array index rather than input, and a
  // bound parameter in a `case` result has no type Postgres can infer.
  const ranking = sql.join(
    SEVERITY_ORDER.map((s, i) => sql`when ${s} then ${sql.raw(String(i + 1))}`),
    sql` `,
  );

  const result = await db.execute<HealthRow>(sql`
    with crawled as (
      select count(*)::int as n from pages p where p.crawl_id = ${crawlId}
    ),
    cohort as (
      select p.id
      from pages p
      where p.crawl_id = ${crawlId}
        and p.fetch_class = 'ok'
        and p.status_code = 200
    ),
    worst as (
      select i.page_id,
             min(case i.severity ${ranking} else null end) as rank,
             count(*) filter (
               where not (i.severity = any(${severities}::text[]))
             )::int as unmapped,
             string_agg(distinct i.severity, ', ') filter (
               where not (i.severity = any(${severities}::text[]))
             ) as unmapped_list
      from issues i
      join cohort c on c.id = i.page_id
      where i.crawl_id = ${crawlId}
      group by i.page_id
    )
    select
      count(*)::int as urls_total,
      count(*) filter (where w.rank = 1)::int as urls_with_critical,
      count(*) filter (where w.rank = 2)::int as urls_with_warning_only,
      count(*) filter (where w.rank = 3)::int as urls_with_info_only,
      count(*) filter (where w.rank is null)::int as urls_clean,
      round(count(*) filter (where w.rank is null)::numeric
            / nullif(count(*), 0), 4)::float8 as clean_ratio,
      ((select n from crawled) - count(*))::int as pages_not_auditable,
      coalesce(sum(w.unmapped), 0)::int as unmapped_severities,
      string_agg(distinct w.unmapped_list, ', ') as unmapped_list
    from cohort c
    left join worst w on w.page_id = c.id`);

  const row = result.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns one row over any input, including
    // none. No row is a statement that did not run the way it reads.
    throw new Error(`${self.id}: crawl '${crawlId}' health query returned no row`);
  }

  const unmapped = num(row.unmapped_severities, "unmapped_severities", self.id);
  if (unmapped > 0) {
    // See `SEVERITY_ORDER`: an unranked severity is invisible to `min`, so
    // those pages would be reported CLEAN. The metric stops instead of
    // publishing a ratio that counts judged pages as unjudged.
    throw new Error(
      `${self.id}: crawl '${crawlId}' holds ${unmapped} finding(s) whose severity ` +
        `(${row.unmapped_list ?? "unknown"}) is not one of ${SEVERITY_ORDER.join(", ")} — ` +
        `the worst-severity ranking cannot place them, and counting their pages as ` +
        `clean would be a false ratio`,
    );
  }

  const urlsTotal = num(row.urls_total, "urls_total", self.id);
  const urlsWithCritical = num(row.urls_with_critical, "urls_with_critical", self.id);
  const urlsWithWarningOnly = num(row.urls_with_warning_only, "urls_with_warning_only", self.id);
  const urlsWithInfoOnly = num(row.urls_with_info_only, "urls_with_info_only", self.id);
  const urlsClean = num(row.urls_clean, "urls_clean", self.id);

  // The partition, checked rather than promised. The statement above makes it
  // structurally true; this is what catches an edit that stops it being so —
  // a fifth bucket, a `filter` that overlaps another, a cohort that changed
  // between the CTE and the join — before a dashboard renders the difference
  // as a slice of nothing.
  const bucketed = urlsWithCritical + urlsWithWarningOnly + urlsWithInfoOnly + urlsClean;
  if (bucketed !== urlsTotal) {
    throw new Error(
      `${self.id}: crawl '${crawlId}' buckets sum to ${bucketed} over ${urlsTotal} ` +
        `auditable pages — the four buckets must partition the census exactly`,
    );
  }

  return [
    metricRow(self, {
      scope: "site",
      value: {
        urlsTotal,
        urlsWithCritical,
        urlsWithWarningOnly,
        urlsWithInfoOnly,
        urlsClean,
        cleanRatio: nullableNum(row.clean_ratio, "clean_ratio", self.id),
        pagesNotAuditable: num(row.pages_not_auditable, "pages_not_auditable", self.id),
      },
    }),
  ];
}

export const healthMetrics: MetricRule[] = [
  // CHECK-32 is a FILING decision, not an answer to the orphan check — see the
  // module header, which states what no checklist check asks for.
  metricRule("site.health", ["CHECK-32"], "crawl", async (db, crawlId, self) =>
    siteHealth(db, crawlId, self),
  ),
];

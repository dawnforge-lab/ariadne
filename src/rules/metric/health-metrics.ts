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
 * ## THE CHECKLIST CLAIM — CHECK-83, and it is the check this row is about
 *
 * Hard rule 10 says a rule carries the checklist ids it answers, and
 * `defineRule` enforces at least one. This row is a rollup of the AUDIT'S OWN
 * FINDINGS: how far the judgement reached across the pages the crawl could
 * judge, and how many pages it could not judge at all. That is a statement about
 * the engine's coverage of the site, which is exactly what CHECK-83 "Engine
 * coverage and evidence completeness" asks for — the check the audit answers
 * FIRST, because every later verdict is a verdict about the evidence CHECK-83
 * describes.
 *
 * Evaluation Principle 2 still binds, and the copy still says so: "Never answer
 * a check from a crawl summary. Use the source the check names." A reader must
 * not reach a verdict on CHECK-22 or CHECK-35 from this table. What is different
 * from every other metric here is that CHECK-83's own subject IS the crawl
 * summary, so this row is that check's evidence rather than a summary standing
 * in for one.
 *
 * **HISTORY, because the claim moved and a reader of an older crawl will meet
 * the old one.** Phase 10 shipped this metric carrying CHECK-32 — a FILING
 * decision, made because the checklist then had no check for a site-wide
 * judgement rollup and CHECK-32 was where a partition of the page census lived
 * (`structure.depth-distribution` sits there). The Phase 10 T2 review ruled that
 * bridge explicitly temporary and ledgered the handoff; Phase 11 added CHECK-83
 * and this claim moved to it, in one line, exactly as ledgered. A crawl judged
 * under 0.7.0 has findings and metrics written when the id was CHECK-32; the
 * copy is joined at read time, so such a crawl is DESCRIBED by today's filing
 * (`docs/talos-surface.md` §7.3).
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
 * It is also not the crawl's page count, and the remainder is OPEN-ENDED rather
 * than a list. The predicate is positive — fetched OK, answered 200, which for
 * this crawler means an HTML body it could read — so what falls outside it is
 * EVERYTHING ELSE: redirects, 4xx and 5xx, requests that failed or were blocked,
 * and 200s that were not HTML (`non_html`, `too_large`, `unsupported_encoding`)
 * or were another 2xx entirely. Enumerating "a redirect, a 404, a 5xx" as though
 * that were the whole remainder is the mistake this paragraph exists to stop: it
 * is the shape of the predicate, not a catalogue.
 *
 * Those pages are excluded from every bucket here, and `pagesNotAuditable` is
 * the column that says how many, so the exclusion is a number a reader can see
 * rather than a silence they have to infer (`urlsTotal + pagesNotAuditable` is
 * the crawl's page count). **The other tables do not cover the remainder
 * either**: `redirect.volume` counts the redirects and the status rules judge
 * the error responses, but a 200 that was not HTML is counted by NEITHER — the
 * reference crawl has exactly one such row — which is the second reason this
 * column is on the row rather than left to a reader's arithmetic. On that crawl
 * it is 443 auditable pages and 108 outside, carrying 97 findings between them:
 * without the column, a health row of 443 would look like the whole crawl.
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
  // CHECK-83 is the check this table is ABOUT — see the module header. It was
  // filed under CHECK-32 for one phase, as an explicitly temporary bridge, while
  // no check existed for the engine's own coverage.
  metricRule("site.health", ["CHECK-83"], "crawl", async (db, crawlId, self) =>
    siteHealth(db, crawlId, self),
  ),
];

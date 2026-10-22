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
 * `urlsTotal` is the JUDGED pages: fetched OK with a 200, indexable, and not
 * canonicalised elsewhere — `isJudged`/`JUDGED` in src/rules/helpers.ts, and
 * since Phase 22 §1 the population nearly every page rule guards itself with.
 * It is now the SAME cohort `cohortFilter` gives every other metric, which it
 * deliberately was not before: until Phase 22 a noindex or canonicalised 200
 * was still judged by every on-page rule, so excluding it here would have left
 * findings attached to pages the denominator had never heard of. The rules
 * moved; this moved with them, and the two columns below are what keep the
 * move visible.
 *
 * `urlsCanonicalised` and `urlsNoindex` are the fetched, 200-answering URLs the
 * judged cohort sets aside, and they exist so that nothing goes silent without
 * a trace (Phase 22 §3): a crawl that reports far fewer findings than the last
 * one must be able to say how many pages it stopped judging and why. They are
 * DISJOINT, with NOINDEX taking precedence — a page that both noindexes itself
 * and canonicalises elsewhere is counted once, under the noindex.
 *
 * That is `indexabilityOf`'s order, and deliberately the same one: a noindex is
 * the page's own explicit instruction to stay out of the index, while a
 * canonical is a hint about which URL to prefer, and search engines treat the
 * explicit directive as the stronger signal — which is why the per-row
 * Indexability Status column already shows `Noindex` first. ONE VOCABULARY
 * across the surface: a page a reader sees labelled `Noindex` in a finding row
 * is the page this table counts under `urlsNoindex`, and
 * `sitemap.non-indexable`'s `reason` says `noindex` about it too.
 *
 * The three are EQUIVALENT BY CONSTRUCTION rather than textually identical:
 * this table tests the stamped `is_indexable`, while the Indexability Status
 * column and `sitemap.non-indexable`'s `reason` ask `hasNoindex` of the two
 * robots channels. They cannot disagree, because the stamp is written from
 * those same two channels (`src/crawl/persist.ts`) and `indexabilityOf` throws
 * when a row says otherwise (src/rules/helpers.ts) — a contradiction is a loud
 * error, not a page counted under one word here and another word there.
 *
 * **The partition, in full:** `urlsTotal + urlsCanonicalised + urlsNoindex +
 * pagesNotAuditable` is every URL the crawl has a `pages` row for. It is
 * asserted in `siteHealth`, in test/rules/health-metrics.test.ts and end to end
 * in the fixture harness.
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
 * Since Phase 23 T3 the remainder also holds the ROBOTS-BLOCKED rows: internal
 * URLs a page linked to that robots.txt disallowed, recorded and never
 * requested. They are counted there DELIBERATELY, not by accident of the
 * predicate: the column is "URLs Not Judged" and the partition is over every
 * URL the crawl has a row for, and a blocked URL is exactly that — on record,
 * not judged, and reported by `robots.blocks-internal-urls`. The censuses of
 * what was FETCHED (`redirect.volume`'s denominator, `render.coverage`'s
 * `pagesCrawled`, the render budget) exclude them instead (`ROBOTS_BLOCKED`).
 *
 * Those pages are excluded from every bucket here, and `pagesNotAuditable` is
 * the column that says how many, so the exclusion is a number a reader can see
 * rather than a silence they have to infer (it is the crawl's page count minus
 * the three cohorts above). **The other tables do not cover the remainder
 * either**: `redirect.volume` counts the redirects and the status rules judge
 * the error responses, but a 200 that was not HTML is counted by NEITHER — the
 * reference crawl has exactly one such row — which is the second reason this
 * column is on the row rather than left to a reader's arithmetic. On that crawl
 * it is 441 judged pages, 2 set aside as canonicalised and 108 outside, those
 * 108 carrying 97 findings between them: without the column, a health row of
 * 441 would look like the whole crawl.
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
import {
  CANONICALISED_ELSEWHERE,
  FETCHED_OK,
  JUDGED,
  metricRow,
  metricRule,
  type MetricIdentity,
} from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import { perScope } from "../registry/metric-table.js";
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
  urls_canonicalised: number;
  urls_noindex: number;
  urls_paginated: number;
  pages_not_auditable: number;
  /** Fetched OK with a 200: the three cohort counts above must sum to it. */
  fetched_ok: number;
  /** Every `pages` row of the crawl: all four counts must sum to it. */
  crawled: number;
  unmapped_severities: number;
  unmapped_list: string | null;
};

/**
 * One site row: the auditable census, its four severity buckets, and the ratio.
 *
 * The columns, in the order they are written:
 *
 *  - `urlsTotal` — judged pages: fetched OK, status 200, indexable, not
 *    canonicalised elsewhere. The denominator of everything below it, and the
 *    module header says why it is not the crawl's page count.
 *  - `urlsWithCritical` — pages whose worst finding is critical.
 *  - `urlsWithWarningOnly` — pages carrying at least one warning and no
 *    critical.
 *  - `urlsWithInfoOnly` — pages carrying only info findings.
 *  - `urlsClean` — pages carrying no finding of any severity.
 *  - `cleanRatio` — `urlsClean / urlsTotal`, four decimal places. NULL over an
 *    empty census rather than 0 or 1: nothing was measured, and both of those
 *    are claims about a site that has no auditable pages (`redirect.volume`'s
 *    `ratioPct` answers the same way for the same reason).
 *  - `pagesNotAuditable` — pages the crawl has a row for that are not fetched-OK
 *    200s at all: redirects, errors, blocks, non-HTML bodies.
 *  - `urlsCanonicalised` — fetched-OK 200s set aside because they hand their
 *    signals to another URL and carry no noindex of their own.
 *  - `urlsNoindex` — fetched-OK 200s set aside because they carry a noindex,
 *    whether or not they also canonicalise elsewhere (the precedence above).
 *  - `urlsPaginated` — JUDGED pages that declare rel=prev (page 2+ of a series),
 *    left out of the three field-duplicate rules only (Phase 23 T7). Unlike the
 *    two above this is NOT a partition member: these pages are inside
 *    `urlsTotal` and every other rule still judges them.
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
 * over 441 pages is one statement, not 441.
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
    with census as (
      -- ONE PASS OVER THE CRAWL'S PAGES, four counts out of it, so the
      -- partition this table publishes is arithmetic over one population
      -- rather than four statements that have to agree.
      select count(*)::int as crawled,
             count(*) filter (where ${FETCHED_OK("p")})::int as fetched_ok,
             -- NOINDEX IS TESTED FIRST, and the canonical bucket is what is
             -- left, because that is indexabilityOf's order (case 9 before
             -- case 10, src/rules/helpers.ts) and one vocabulary is better
             -- than two: a noindex is the page's own explicit instruction to
             -- stay out of the index, while a canonical is a hint about which
             -- URL to prefer, and search engines treat the explicit directive
             -- as the stronger signal. The Indexability Status column already
             -- shows Noindex for a page carrying both; these columns now set
             -- the same page aside under the same word.
             --
             -- "Fetched OK with a 200 and not is_indexable" IS "carries a
             -- noindex": the writer sets is_indexable from the two robots
             -- channels and requires the 200 (src/crawl/persist.ts). A NULL
             -- lands in this bucket rather than nowhere — "is not true", not
             -- "= false" — so the partition cannot be broken by one; no crawl
             -- this engine writes produces one, and indexabilityOf is what
             -- refuses the contradiction out loud.
             count(*) filter (
               where ${FETCHED_OK("p")} and p.is_indexable is not true
             )::int as noindex,
             -- The rest of the set-aside: indexable, so not counted above, and
             -- handing its signals to another URL. "is_indexable = true"
             -- rather than "is not false", so a NULL is counted once — over
             -- there — and never twice.
             count(*) filter (
               where ${FETCHED_OK("p")} and p.is_indexable = true
                 and ${CANONICALISED_ELSEWHERE("p")}
             )::int as canonicalised
      from pages p
      where p.crawl_id = ${crawlId}
    ),
    paginated as (
      -- Judged pages declaring rel=prev: left out of the three field-duplicate
      -- rules (Phase 23 T7). NOT a partition member — these pages stay in
      -- urlsTotal and every other rule still judges them.
      select count(*)::int as n
      from pages p
      where p.crawl_id = ${crawlId} and ${JUDGED("p")} and p.rel_prev is not null
    ),
    cohort as (
      select p.id
      from pages p
      where p.crawl_id = ${crawlId} and ${JUDGED("p")}
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
      (select canonicalised from census)::int as urls_canonicalised,
      (select noindex from census)::int as urls_noindex,
      (select n from paginated)::int as urls_paginated,
      ((select crawled from census) - (select fetched_ok from census))::int
        as pages_not_auditable,
      (select fetched_ok from census)::int as fetched_ok,
      (select crawled from census)::int as crawled,
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
        `judged pages — the four buckets must partition the census exactly`,
    );
  }

  const urlsCanonicalised = num(row.urls_canonicalised, "urls_canonicalised", self.id);
  const urlsNoindex = num(row.urls_noindex, "urls_noindex", self.id);
  const urlsPaginated = num(row.urls_paginated, "urls_paginated", self.id);
  const pagesNotAuditable = num(row.pages_not_auditable, "pages_not_auditable", self.id);
  const fetchedOk = num(row.fetched_ok, "fetched_ok", self.id);
  const crawled = num(row.crawled, "crawled", self.id);

  // THE SECOND PARTITION, checked for the first one's reason (Phase 22 §3).
  // Every URL the crawl fetched is in exactly one of four places: judged, set
  // aside as canonicalised, set aside as noindex, or outside the fetched-OK
  // 200 census entirely. The statement above makes that structurally true —
  // the three cohort counts are `filter`s over one pass whose conditions are
  // mutually exclusive and cover `fetched_ok` — and this is what catches the
  // edit that stops it being so, before a dashboard renders pages that
  // vanished between two numbers.
  if (urlsTotal + urlsCanonicalised + urlsNoindex !== fetchedOk) {
    throw new Error(
      `${self.id}: crawl '${crawlId}' counts ${urlsTotal} judged + ` +
        `${urlsCanonicalised} canonicalised + ${urlsNoindex} noindex over ` +
        `${fetchedOk} URLs fetched OK with a 200 — the three cohorts must ` +
        `partition that census exactly`,
    );
  }
  if (fetchedOk + pagesNotAuditable !== crawled) {
    throw new Error(
      `${self.id}: crawl '${crawlId}' counts ${fetchedOk} fetched OK plus ` +
        `${pagesNotAuditable} not judged over ${crawled} pages — every URL the ` +
        `crawl fetched must be in exactly one of the two`,
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
        pagesNotAuditable,
        urlsCanonicalised,
        urlsNoindex,
        urlsPaginated,
      },
    }),
  ];
}

export const healthMetrics: MetricRule[] = [
  // CHECK-83 is the check this table is ABOUT — see the module header. It was
  // filed under CHECK-32 for one phase, as an explicitly temporary bridge, while
  // no check existed for the engine's own coverage.
  metricRule(
    "site.health",
    ["CHECK-83"],
    "crawl",
    // One row, and the scope column says so: `Scope` heads it because a metric
    // with no cohort rows has no template to name, and the single cell reads
    // `Site`.
    // FIRST IN THE SECTION (the trailing `0`). Every other table is a part of
    // this census, so a reader meets the whole before the pieces — the argument
    // the site row makes inside one table, one level up (`MetricTableCommon`).
    perScope("Scope", [
      { key: "urlsTotal", label: "Pages Judged" },
      { key: "urlsWithCritical", label: "With Critical" },
      { key: "urlsWithWarningOnly", label: "With Warning Only" },
      { key: "urlsWithInfoOnly", label: "With Info Only" },
      { key: "urlsClean", label: "Clean" },
      { key: "cleanRatio", label: "Clean Ratio" },
      { key: "pagesNotAuditable", label: "URLs Not Judged" },
      // THE TWO EXCLUSIONS THE JUDGED COHORT MAKES, on the row rather than in
      // silence (Phase 22 §3). They come last, after the census and its
      // buckets, because they are a footnote to `urlsTotal`: these are the
      // fetched, 200-answering URLs the ruleset deliberately did not judge.
      { key: "urlsCanonicalised", label: "Canonicalised (set aside)" },
      { key: "urlsNoindex", label: "Noindex (set aside)" },
      { key: "urlsPaginated", label: "Paginated Pages Set Aside" },
    ], 0),
    async (db, crawlId, self) => siteHealth(db, crawlId, self),
  ),
];

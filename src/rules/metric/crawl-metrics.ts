/**
 * The crawl-shape metrics: how much of the crawl was redirects (CHECK-10), and
 * what the site's sitemap is made of (CHECK-08).
 *
 * Both answer a question the finding rules structurally cannot. `redirect.chain`
 * and `redirect.loop` report BROKEN redirect paths, one finding per path; a site
 * whose every redirect is a clean single hop breaks none of them and can still
 * be spending a fifth of its crawl budget on 301s, which is CHECK-10's
 * "redirect volume" half. `sitemap.missing`, `sitemap.uncrawled` and the rest
 * judge what the sitemap CLAIMS; whether the claims are split across documents
 * a large site can maintain is CHECK-08, and it is a description rather than a
 * fault.
 *
 * Neither measures the metric cohort, and that is deliberate: both are about the
 * crawl, not about the site's indexable pages. A redirect is by definition not
 * a 200, so filtering to the cohort would leave `redirect.volume` counting
 * nothing at all.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl, readCrawlEvidence } from "../query/crawl-evidence.js";
import { CHAIN, LOOP } from "../query/redirects.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { bool, nullableNum, num, text } from "./cohort.js";

const REDIRECTS = "redirects";
const SITEMAP = "sitemap";

/**
 * The sitemaps protocol's per-document limit: 50,000 `<url>` entries. A
 * document past it is one search engines may read only the first 50,000 entries
 * of, which is why it is a column of this metric rather than a matter of taste.
 */
export const SITEMAP_URL_CAP = 50_000;

/**
 * How many per-document rows `sitemap.structure` writes.
 *
 * A sitemap index may point at three hundred documents (`MAX_SITEMAP_DOCS`),
 * and three hundred metric rows for one crawl is a table nobody reads and an
 * agent context nobody can afford. The fifty LARGEST are the ones the structure
 * question is about — a flat 200,000-entry document is visible in the first row
 * — and the site row's `docs` says how many there are in total, so a capped
 * listing is never mistaken for the whole set.
 *
 * The order is `urls` descending, ties broken by source URL ascending: two runs
 * over one crawl therefore emit the same fifty documents in the same order (the
 * deterministic-cap lesson).
 */
export const SITEMAP_DOC_ROWS_CAP = 50;

type RedirectRow = {
  redirect_pages: number;
  total_pages: number;
  ratio_pct: number | null;
  chains: number;
  loops: number;
};

/**
 * How many findings one rule actually has for this crawl — the listing, or the
 * exact total behind it where the listing was capped.
 *
 * `redirect.chain` and `redirect.loop` stop LISTING at `URL_FINDING_CAP` (200)
 * and write the exact total into the last finding's evidence as
 * `truncated: {reported, total}` — an `ExactTruncation`, because both rules run
 * their scan to completion and count every case (`heads.size`, `cycles.size`).
 * Counting the issues rows alone would therefore report exactly 200 chains for
 * a site with four thousand, and 200 is a number a client would act on.
 *
 * `greatest` rather than `coalesce(total, listed)` for two reasons: an
 * uncapped rule writes no note at all, so `total` is null and the listing is
 * the answer; and the result can never come back BELOW the number of rows
 * actually on disk, whatever a note says.
 *
 * The `jsonb_typeof` guard is what keeps the cast honest — a `truncated` note
 * of another shape (`{reported, atLeast}`, which these two rules never write)
 * contributes nothing rather than raising a cast error from inside the SQL
 * layer, and the listing stands.
 */
function exactFindingCount(crawlId: string, ruleId: string): SQL {
  return sql`(
    select greatest(
      count(*),
      coalesce(max(case
        when jsonb_typeof(i.details_jsonb -> 'truncated' -> 'total') = 'number'
        then (i.details_jsonb -> 'truncated' ->> 'total')::int
      end), 0)
    )::int
    from issues i
    where i.crawl_id = ${crawlId} and i.rule_id = ${ruleId}
  )`;
}

/**
 * How much of the crawl was redirects, and how much of that was broken
 * (CHECK-10).
 *
 * **What each column counts.**
 *
 *  - `redirectPages` — page rows whose `fetch_class` is `redirect`: URLs this
 *    crawl requested and was sent away from. One row per URL, so a template
 *    link that redirects on every page of the site is ONE redirect page here.
 *    (The checklist's crawl-budget number is redirect INLINKS, which is a
 *    question for the link graph rather than for this table; it is not claimed
 *    here and this column does not stand in for it.)
 *  - `totalPages` — every page row of the crawl, whatever its status. Redirects
 *    are a share of what was fetched, not of what was indexable, so this is
 *    deliberately not the metric cohort.
 *  - `ratioPct` — `100 × redirectPages / totalPages`, computed in SQL and
 *    rounded to one decimal place (`hreflang.coverage`'s idiom). NULL over a
 *    crawl with no pages rather than 0: nothing was measured, and "0% of this
 *    crawl was redirects" is a claim the absence of pages does not support.
 *  - `chains` / `loops` — how many redirect chains and loops the QUERY rules
 *    found on this crawl, read from their own `issues` rows.
 *
 * **The query-phase coupling, stated out loud.** The last two columns are not
 * computed here: they are counted out of the `issues` table, which is what
 * `redirect.chain` and `redirect.loop` wrote earlier in this same run. A rule
 * reading the database is exactly what a rule is supposed to do (hard rule 3),
 * but the ORDER matters — the metric phase runs after the query phase in
 * `runRules`, so those rows are complete by the time this counts them. Run this
 * rule alone against a crawl whose query rules have not run and it reports zero
 * chains, which is not the same claim as "this site has no chains"; nothing
 * outside `runRules` should be running one phase without the other.
 *
 * The rule ids come from the rules themselves (`CHAIN.id`, `LOOP.id`), not from
 * string literals here: a renamed rule would otherwise leave this metric
 * silently counting nothing.
 */
async function redirectVolume(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // A crawl id nothing knows counts zero redirect pages out of zero pages —
  // indistinguishable from a clean crawl (hard rule 7, `runRules`' precedent).
  await assertCrawl(db, crawlId, self.id);

  const rows = await db.execute<RedirectRow>(sql`
    select
      count(*) filter (where p.fetch_class = 'redirect')::int as redirect_pages,
      count(*)::int as total_pages,
      case when count(*) = 0 then null
           else round(100.0 * count(*) filter (where p.fetch_class = 'redirect')
                      / count(*), 1)::float8
      end as ratio_pct,
      ${exactFindingCount(crawlId, CHAIN.id)} as chains,
      ${exactFindingCount(crawlId, LOOP.id)} as loops
    from pages p
    where p.crawl_id = ${crawlId}`);

  const row = rows.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns one row over any input, including
    // none. No row is a statement that did not run the way it reads.
    throw new Error(`${self.id}: crawl '${crawlId}' redirect query returned no row`);
  }

  return [
    metricRow(self, {
      scope: "site",
      value: {
        redirectPages: num(row.redirect_pages, "redirect_pages", self.id),
        totalPages: num(row.total_pages, "total_pages", self.id),
        ratioPct: nullableNum(row.ratio_pct, "ratio_pct", self.id),
        chains: num(row.chains, "chains", self.id),
        loops: num(row.loops, "loops", self.id),
      },
    }),
  ];
}

type SitemapRow = {
  ord: number;
  scope: string;
  scope_value: string;
  docs: number | null;
  total_urls: number | null;
  url_cap_breaches: number | null;
  urls: number | null;
  breaches_50k: boolean | null;
};

/**
 * What the site's sitemap is made of: one site row, and one row per sitemap
 * document (CHECK-08).
 *
 * **The scope.** The per-document rows are scoped `sitemap_doc`, with the
 * document's own URL in `scope_value`. That scope was added for this rule (see
 * `MetricScope` in src/rules/registry/types.ts): the runner validates a metric
 * row's scope against a closed set, and the two that existed were `site` and
 * `page_type`. Filing `https://site/sitemap-products.xml` under `page_type`
 * would have fitted without a code change and been a lie — every other reader
 * of that scope, from the report to the agent, takes a `page_type` value to be
 * a template name and the row to be a cohort of pages. A new kind of row gets
 * its own scope.
 *
 * **What each column counts.** The site row:
 *
 *  - `docs` — sitemap documents that contributed at least one entry to this
 *    crawl. It is not the number of documents fetched: an index file lists
 *    children and holds no `<url>` of its own, an empty document contributes
 *    nothing, and a document whose every entry was already listed by an earlier
 *    one contributes nothing either (the walk dedupes by URL, first source
 *    wins). Those are all documents with no rows to be counted from, and this
 *    column says so rather than implying they were never read.
 *  - `totalUrls` — sitemap entries stored for the crawl, deduped the same way:
 *    a URL listed in three documents is one entry, filed under the first.
 *  - `oversizedDocsSkipped` — documents the walk fetched and DROPPED WHOLE for
 *    exceeding the read cap, from the crawl's discovery evidence. Their entries
 *    are in neither count above, and without this column their absence would be
 *    invisible.
 *  - `urlCapBreaches` — documents carrying more than `SITEMAP_URL_CAP` entries.
 *    Counted over EVERY document, not only the fifty listed below.
 *  - `entryCapReached` — the discovery walk stopped collecting at its entry cap
 *    (`entryLimited`). When it is true every count in this table is a FLOOR and
 *    a `breaches50k` of false may be a false negative, because the entries that
 *    would have proved it were never collected. It is a column rather than a
 *    footnote for that reason: the numbers beside it change meaning (hard rule
 *    7).
 *
 * And each `sitemap_doc` row: `urls`, how many entries that document
 * contributed, and `breaches50k`, whether that is past the protocol's 50,000.
 *
 * Site and document rows come from ONE statement over one CTE, so the site's
 * `docs` and the rows beneath it can never be computed over different sets.
 */
async function sitemapStructure(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // The discovery blob is read for two of the site row's columns, so this rule
  // takes the gate that validates it — which is also the crawl-exists check.
  const { discovery } = await readCrawlEvidence(db, crawlId, self.id);

  const rows = await db.execute<SitemapRow>(sql`
    with per_doc as (
      select s.sitemap_source as source, count(*)::int as urls
      from sitemap_urls s
      where s.crawl_id = ${crawlId}
      group by s.sitemap_source
    ),
    totals as (
      select count(*)::int as docs,
             coalesce(sum(urls), 0)::int as total_urls,
             count(*) filter (where urls > ${SITEMAP_URL_CAP})::int as url_cap_breaches
      from per_doc
    ),
    ranked as (
      select source, urls,
             row_number() over (order by urls desc, source asc)::int as rn
      from per_doc
    )
    select 0 as ord, 'site' as scope, '' as scope_value,
           t.docs, t.total_urls, t.url_cap_breaches,
           null::int as urls, null::boolean as breaches_50k
    from totals t
    union all
    select r.rn as ord, 'sitemap_doc' as scope, r.source as scope_value,
           null::int as docs, null::int as total_urls, null::int as url_cap_breaches,
           r.urls, r.urls > ${SITEMAP_URL_CAP} as breaches_50k
    from ranked r
    where r.rn <= ${SITEMAP_DOC_ROWS_CAP}
    order by ord`);

  return rows.rows.map((row) => {
    if (row.scope === "site") {
      return metricRow(self, {
        scope: "site",
        value: {
          docs: num(row.docs, "docs", self.id),
          totalUrls: num(row.total_urls, "total_urls", self.id),
          oversizedDocsSkipped: discovery.truncation.oversizedDocsSkipped,
          urlCapBreaches: num(row.url_cap_breaches, "url_cap_breaches", self.id),
          entryCapReached: discovery.truncation.entryLimited,
        },
      });
    }
    return metricRow(self, {
      scope: "sitemap_doc",
      scopeValue: text(row.scope_value, "scope_value", self.id),
      value: {
        urls: num(row.urls, "urls", self.id),
        breaches50k: bool(row.breaches_50k, "breaches_50k", self.id),
      },
    });
  });
}

export const crawlMetrics: MetricRule[] = [
  metricRule("redirect.volume", ["CHECK-10"], REDIRECTS, async (db, crawlId, self) =>
    redirectVolume(db, crawlId, self),
  ),

  metricRule("sitemap.structure", ["CHECK-08"], SITEMAP, async (db, crawlId, self) =>
    sitemapStructure(db, crawlId, self),
  ),
];

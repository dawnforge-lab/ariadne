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
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, ROBOTS_BLOCKED, type MetricIdentity } from "../helpers.js";
import { assertCrawl, readCrawlEvidence } from "../query/crawl-evidence.js";
import { CHAIN, LOOP } from "../query/redirects.js";
import { perScope } from "../registry/metric-table.js";
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
};

type RedirectInlinkRow = {
  redirect_inlinks: number;
};

type FindingCountRow = {
  rule_id: string;
  listed: number;
  /** The `truncated` notes those rows carry, as jsonb — `null` when none does. */
  notes: unknown;
};

/**
 * How many findings one rule actually has for this crawl — the listing, or the
 * exact total behind it where the listing was capped.
 *
 * `redirect.chain` and `redirect.loop` stop LISTING at the run's finding cap
 * (200 by default, whatever `findingCap` says otherwise, nothing at all when it
 * is null) and write the exact total into the last finding's evidence as
 * `truncated: {reported, total}` — an `ExactTruncation`, because both rules run
 * their scan to completion and count every case (`heads.size`, `cycles.size`).
 * Counting the issues rows alone would therefore report exactly 200 chains for
 * a site with four thousand, and 200 is a number a client would act on.
 *
 * NOTHING HERE CHANGED WHEN THE CAP BECAME A KNOB, and that is the point of
 * reading the note rather than the number: an uncapped run writes no note, which
 * case 1 below already handles as "the listing is complete", so the metric is
 * exact at every cap without knowing what the cap was.
 *
 * **Three situations, three different answers, and only one of them is a
 * count.** `redirectVolume`'s second query hands back the rows a rule listed and
 * every `truncated` note among them; this function decides what that means:
 *
 *  1. **No note.** The listing is complete — that is what the absence of a note
 *     MEANS, not a value missing from it — so the row count is the answer. This
 *     is semantics rather than a fallback.
 *  2. **An `ExactTruncation` (`{reported, total}` with a numeric `total`).** The
 *     rule counted every case and listed some of them, so `total` is the answer.
 *     Taken as `greatest(listed, total)`, so the number can never come back
 *     below the rows actually on disk whatever a note claims.
 *  3. **Anything else** — a `total` that is not a number, or the
 *     `LowerBoundTruncation` shape (`{reported, atLeast}`) — **throws.**
 *
 * The third case is the one worth spelling out. A `{reported, atLeast}` note is
 * a rule saying "I stopped looking"; there is no exact total behind it, and
 * these two rules never write one today. Ignoring it and reporting the listing
 * would put 200 in a column called `chains`, under copy that says "counted in
 * full" — a true-looking number nothing behind it answered, which is exactly
 * hard rule 1's always-passes defect wearing a metric's clothes. If a future
 * edit ever swaps these rules to `noteAtLeastTruncation`, this throws and the
 * decision gets made deliberately: a lower bound needs a column that says it is
 * one. The same goes for a malformed note — a `total` of `"4111"` or `null` is a
 * note we cannot read, and a metric that cannot read its input says so (hard
 * rule 7).
 */
function exactFindingCount(row: FindingCountRow, self: MetricIdentity): number {
  const listed = num(row.listed, "listed", self.id);
  if (row.notes === null || row.notes === undefined) return listed;

  const bad = (why: string, note: unknown): never => {
    throw new Error(
      `${self.id}: crawl finding '${row.rule_id}' carries a truncation note that ${why} ` +
        `(${JSON.stringify(note)}) — an exact count cannot be read from it, and the ` +
        `${listed} listed rows are a capped listing rather than a total`,
    );
  };

  // `jsonb_agg` of a jsonb column: an array of the notes, one per finding that
  // carries one. Normally that is exactly one — the note rides on the last
  // finding of a capped listing — but the shape is validated rather than
  // assumed, because "there is only ever one" is a property of the writer and
  // this reads the table.
  if (!Array.isArray(row.notes)) return bad("did not come back as a JSON array", row.notes);

  let total = listed;
  for (const note of row.notes) {
    if (typeof note !== "object" || note === null || Array.isArray(note)) {
      return bad("is not an object", note);
    }
    const value = (note as Record<string, unknown>)["total"];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return bad(
        "names no numeric `total` — a lower-bound note (`atLeast`) or a malformed one",
        note,
      );
    }
    total = Math.max(total, value);
  }
  return total;
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
 *  - `redirectInlinks` — internal LINKS pointing at one of those URLs. This is
 *    the crawl-budget half of CHECK-10, and it is a different number from the
 *    one above rather than a restatement of it: the template link that redirects
 *    is one redirect page and one inlink per page of the site, so a site with
 *    three redirecting nav items and ten thousand pages has 3 redirect pages and
 *    30,000 redirect inlinks. The first says how many URLs are wrong; the second
 *    says how often the site walks into them, which is what the budget is
 *    actually spent on and what the fix (repointing links) actually changes.
 *
 *    THE JOIN, spelled exactly as every other link-to-page join in this engine:
 *    `pages.url = links.target_url`. Both sides are `normalizeUrl` output — the
 *    analyzer resolves every href through it before storing a `links` row, and
 *    the frontier keys `pages` by it — so the two are directly comparable and no
 *    normalisation happens here (see `links.orphan` and `links.broken-internal`,
 *    which spell it the same way; `links.target_page_id` is written null by the
 *    crawler and is not the join). `is_internal` is required because the figure
 *    is about this site's own crawl budget; in practice it excludes nothing,
 *    since only a URL this crawl fetched has a `pages` row at all, and saying so
 *    is cheaper than leaving a reader to work it out.
 *  - `totalPages` — every page row of the crawl, whatever its status, EXCEPT
 *    the robots-blocked rows (Phase 23 T3), which were recorded and never
 *    requested. Redirects are a share of what was fetched, not of what was
 *    indexable, so this is deliberately not the metric cohort.
 *  - `ratioPct` — `100 × redirectPages / totalPages`, computed in SQL and
 *    rounded to one decimal place (`hreflang.coverage`'s idiom). NULL over a
 *    crawl with no pages rather than 0: nothing was measured, and "0% of this
 *    crawl was redirects" is a claim the absence of pages does not support.
 *  - `chains` / `loops` — how many redirect chains and loops the QUERY rules
 *    found on this crawl, read from their own `issues` rows. EXACT, including
 *    where those rules stopped listing at the run's finding cap: see
 *    `exactFindingCount` for the three shapes a truncation note can take and
 *    why two of them throw rather than report the listing.
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
      end as ratio_pct
    from pages p
    where p.crawl_id = ${crawlId}
      -- What was FETCHED: a robots-blocked row was never requested (Phase 23
      -- T3), and a share of "what the crawl fetched" must not count it.
      and not ${ROBOTS_BLOCKED("p")}`);

  const row = rows.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns one row over any input, including
    // none. No row is a statement that did not run the way it reads.
    throw new Error(`${self.id}: crawl '${crawlId}' redirect query returned no row`);
  }

  // The link side of the same question. A separate statement rather than a
  // fourth aggregate above, because it counts `links` rows and the query above
  // counts `pages` rows: folding them into one join would multiply every page
  // count by that page's inlink count, which is the classic way to make two
  // correct numbers into two wrong ones.
  //
  // The `links` table is never loaded into memory (hard rule 3) — this is a
  // count over the `links_crawl_target_url` index, and a redirect-heavy site is
  // exactly where an in-memory version would fall over.
  const inlinks = await db.execute<RedirectInlinkRow>(sql`
    select count(*)::int as redirect_inlinks
    from links l
    join pages p on p.crawl_id = ${crawlId} and p.url = l.target_url
    where l.crawl_id = ${crawlId} and l.is_internal and p.fetch_class = 'redirect'`);
  const inlinkRow = inlinks.rows[0];
  if (inlinkRow === undefined) {
    throw new Error(`${self.id}: crawl '${crawlId}' redirect inlink query returned no row`);
  }

  // The findings the two redirect rules wrote, and any truncation notes among
  // them. Grouped in SQL and judged in JavaScript, because "how many chains are
  // there" is not one aggregate: a note that cannot be read as an exact total
  // has to stop the metric rather than fold into a number (`exactFindingCount`).
  const counted = await db.execute<FindingCountRow>(sql`
    select i.rule_id,
           count(*)::int as listed,
           jsonb_agg(i.details_jsonb -> 'truncated')
             filter (where jsonb_exists(i.details_jsonb, 'truncated')) as notes
    from issues i
    where i.crawl_id = ${crawlId}
      and i.rule_id = any(${sql.param([CHAIN.id, LOOP.id])}::text[])
    group by i.rule_id`);

  // A rule with no findings has no row here, and that is the honest zero: no
  // rows listed and no note to say otherwise.
  const byRule = new Map(counted.rows.map((r) => [text(r.rule_id, "rule_id", self.id), r]));
  const found = (ruleId: string): number => {
    const r = byRule.get(ruleId);
    return r === undefined ? 0 : exactFindingCount(r, self);
  };

  return [
    metricRow(self, {
      scope: "site",
      value: {
        redirectPages: num(row.redirect_pages, "redirect_pages", self.id),
        redirectInlinks: num(inlinkRow.redirect_inlinks, "redirect_inlinks", self.id),
        totalPages: num(row.total_pages, "total_pages", self.id),
        ratioPct: nullableNum(row.ratio_pct, "ratio_pct", self.id),
        chains: found(CHAIN.id),
        loops: found(LOOP.id),
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
  metricRule(
    "redirect.volume",
    ["CHECK-10"],
    REDIRECTS,
    perScope("Scope", [
      { key: "totalPages", label: "Pages Fetched" },
      { key: "redirectPages", label: "Redirecting URLs" },
      { key: "ratioPct", label: "Redirects (%)" },
      { key: "redirectInlinks", label: "Inlinks To Redirects" },
      { key: "chains", label: "Redirect Chains" },
      { key: "loops", label: "Redirect Loops" },
    ], 8),
    async (db, crawlId, self) => redirectVolume(db, crawlId, self),
  ),

  // THE ONE TABLE WHOSE TWO SCOPES SPELL A COLUMN DIFFERENTLY. The site row
  // counts the whole sitemap set (`totalUrls`, `urlCapBreaches` — how many
  // documents went over the 50,000-entry limit) and a document row counts itself
  // (`urls`, `breaches50k` — whether THIS one did). Two stored keys, one heading
  // each, declared with `from`; the three site-only columns are empty on a
  // document row, which is what an absent key prints.
  metricRule(
    "sitemap.structure",
    ["CHECK-08"],
    SITEMAP,
    perScope("Sitemap", [
      { key: "entries", label: "Entries", from: ["totalUrls", "urls"] },
      {
        key: "over50kEntries",
        label: "Over 50,000 Entries",
        from: ["urlCapBreaches", "breaches50k"],
      },
      { key: "docs", label: "Documents" },
      { key: "oversizedDocsSkipped", label: "Documents Dropped For Size" },
      { key: "entryCapReached", label: "Entry Cap Reached" },
    ], 10),
    async (db, crawlId, self) => sitemapStructure(db, crawlId, self),
  ),
];

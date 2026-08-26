/**
 * The content metrics: how much text the site's templates carry, and how alike
 * the pages inside a template are.
 *
 * Both are EVIDENCE FOR CHECK-38, which is an AGENT check — whether a page
 * matches the intent it targets is judgement, and the build plan forbids a rule
 * that claims to have made it. These two rules make no such claim: they measure
 * a distribution and a distance, and the agent reads them beside the page's
 * query data. That is why a metric may carry an agent check's id where a
 * finding-producing rule may not (see `test/rules/coverage.test.ts`, where the
 * distinction is asserted rather than assumed).
 *
 * The properties the link-graph metrics state hold here too, and for the same
 * reasons: every number is computed by Postgres, the cohort is the shared one
 * (`./cohort.js` — fetched OK, 200, indexable), a null `page_type` groups under
 * the `UNTYPED` sentinel rather than vanishing, and a crawl id nothing knows is
 * REFUSED rather than answered with the empty table it would otherwise
 * aggregate to (`assertCrawl`; see property 5 in `./link-metrics.js`).
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { COHORT_PAGE_TYPE, cohortFilter, nullableNum, num, text } from "./cohort.js";

const CONTENT = "content";

/**
 * How many pages of a type `content.template-similarity` compares.
 *
 * The measurement is over PAIRS, so its cost is quadratic in the size of the
 * cohort: a template with 5,000 pages has 12.5 million pairs, and computing
 * them to summarise them would be the memory contract's cost moved into
 * Postgres. The sample bounds it at 19,900 pairs per type (200 × 199 / 2),
 * which is enough to describe a distribution and cheap enough to compute.
 *
 * **The sample is the first 200 pages of the type BY `pages.id`.** Page ids are
 * random UUIDs, so that ordering is arbitrary with respect to everything a
 * reader might worry about — depth, crawl order, URL — which is exactly what is
 * wanted: an arbitrary sample of a template's pages, rather than one biased
 * towards the pages the crawler happened to reach first. It is also
 * DETERMINISTIC: two runs over one crawl compare the same pages and produce the
 * same numbers (the deterministic-cap lesson).
 *
 * The value says so out loud — `pagesFingerprinted`, `pagesSampled` and
 * `pairsSampled` are all in the shape — so a reader can see when a number
 * describes a sample rather than the whole template.
 *
 * `pagesFingerprinted` is named for what it counts and not for what a reader
 * might wish it counted: the sample is drawn from the pages that HAVE a
 * fingerprint, so that is the population the sample is representative of, and
 * it is the honest denominator. It is not the number of pages the type has —
 * a cohort page the crawl recorded no simhash for is outside this metric
 * entirely — and a column called `pagesInType` over this count would understate
 * real type size wherever the two differ, in a value that travels to a report
 * and to the agent without its copy attached.
 */
export const TEMPLATE_SAMPLE_PAGES = 200;

/** The tight distance the `shareWithin3BitsPct` column counts pairs inside of. */
export const TEMPLATE_NEAR_BITS = 3;

/** The loose distance `shareWithin8BitsPct` counts pairs inside of. */
export const TEMPLATE_LOOSE_BITS = 8;

/**
 * The eight numbers of a distribution over one column, prefixed so two of them
 * can be selected side by side in one statement.
 *
 * `count` is `count(<column>)`, NOT `count(*)`: it is how many pages carry a
 * value for this measure. The two differ when the analyzer wrote no measurement
 * for a page, and the difference matters — `percentile_cont` and `avg` skip
 * nulls silently, so a `count(*)` beside them would claim a population the
 * statistics were not computed over. A page with no word count is absent from
 * the word-count column and present in the text-ratio one; each column says how
 * many pages it actually measured.
 *
 * Rounding is IN SQL and per measure, because the two measures live on
 * different scales. Word counts are quotable at two decimal places; a text
 * ratio is a fraction between 0 and 1, where two decimal places would collapse
 * distinct templates into one number, so it keeps four.
 */
function statsAggregates(column: SQL, prefix: string, decimals: number): SQL {
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
 * Indexed by name rather than destructured because the query selects two of
 * these shapes into one row under different prefixes; the row type below is an
 * index signature for the same reason.
 */
function readStats(
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
 * A type alias rather than an interface, and an index signature rather than
 * sixteen named fields: `db.execute<T>` needs `T extends Record<string,
 * unknown>`, which an interface does not satisfy, and the sixteen statistic
 * columns are addressed by computed name anyway. `num`/`nullableNum` are what
 * check the driver's actual output — the declared type checks nothing.
 */
type StatsRow = Record<string, unknown> & { scope: string; scope_value: string };

const WORDS = "words";
const RATIO = "ratio";

/**
 * Word count and text ratio per template (CHECK-38 evidence).
 *
 * The site row and the cohort rows come from ONE statement over one CTE, so the
 * two can never be computed over different sets of pages. The site row has no
 * `GROUP BY`, so an empty cohort still yields a row with `count: 0` and null
 * statistics: an absent metric row means the rule did not run, and "this crawl
 * has no indexable pages" is an answer rather than a silence.
 */
async function contentByType(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  // An unknown crawl aggregates to that same `count: 0` site row, which is a
  // different fact wearing the same shape. Refused instead.
  await assertCrawl(db, crawlId, self.id);

  const aggregates = sql`${statsAggregates(sql`words`, WORDS, 2)},
    ${statsAggregates(sql`ratio`, RATIO, 4)}`;
  const rows = await db.execute<StatsRow>(sql`
    with cohort as (
      select ${COHORT_PAGE_TYPE} as page_type,
             p.word_count as words,
             p.text_ratio as ratio
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
      wordCount: readStats(row, WORDS, self.id),
      textRatio: readStats(row, RATIO, self.id),
    };
    if (row.scope === "site") return metricRow(self, { scope: "site", value });
    return metricRow(self, {
      scope: "page_type",
      scopeValue: text(row.scope_value, "scope_value", self.id),
      value,
    });
  });
}

type SimilarityRow = {
  page_type: string;
  pages_fingerprinted: number;
  pages_sampled: number;
  pairs_sampled: number;
  mean_hamming: number;
  p25: number;
  median: number;
  p75: number;
  share_within_near: number;
  share_within_loose: number;
};

/**
 * How alike the pages of a template are, as a distribution of simhash distances
 * (CHECK-38 evidence).
 *
 * Each pair of pages in a template is scored by the hamming distance between
 * their content fingerprints — 0 means the text is identical as far as the
 * fingerprint can tell, 64 means they share nothing. A template whose pairs sit
 * a handful of bits apart is one whose pages are largely the same text with
 * different values dropped into it; a template whose pairs sit thirty apart is
 * one where each page says something of its own. Which of those is a problem is
 * the agent's judgement and CHECK-38's subject; this rule supplies the number.
 *
 * **Why a sample join rather than the band indexes.** `pages_simhash_band0..3`
 * exist so `content.near-duplicate` can find pairs within three bits without a
 * quadratic join, and they work by requiring an exact match on one 16-bit band.
 * That is a filter for CLOSE pairs, and this metric needs the WHOLE
 * distribution: reading it through the bands would keep the near-identical
 * pairs and discard everything else, so a template of entirely distinct pages
 * would report as one with no pairs at all — a measurement biased precisely
 * where it is most likely to be quoted. The bands are therefore not applicable
 * here, and the quadratic is bounded by the sample instead
 * (`TEMPLATE_SAMPLE_PAGES`).
 *
 * **What that costs.** At most 19,900 pairs per type, so the total is bounded
 * by 19,900 × the number of distinct page types in the crawl. Types come from
 * the crawler's template detection, which produces tens of them on a normal
 * site; a crawl that produced hundreds would pay proportionally, and the pair
 * count is bounded but not small. `bit_count` over an in-memory join of at most
 * 200 rows per type is the cheapest part of it.
 *
 * **The sign, again.** `pages.simhash` is a SIGNED bigint holding the
 * analyzer's unsigned 64-bit value (`BigInt.asIntN`). Both operations used here
 * are representation-level rather than arithmetic — `#` XORs the two's
 * complement bit patterns and `bit_count(…::bit(64))` counts set bits in the
 * result — so no conversion is needed and none happens.
 *
 * One row per page type, and NO SITE ROW: a distance between two pages of
 * different templates is a number with no meaning, so the site as a whole has
 * nothing to say here. A type with fewer than two fingerprinted pages has no
 * pair and gets no row either — unlike the distributions above, where an empty
 * cohort is still worth stating, there is genuinely nothing to state.
 */
async function templateSimilarity(
  db: Db,
  crawlId: string,
  self: MetricIdentity,
): Promise<Metric[]> {
  // No site row means an unknown crawl produces NO rows at all — the same
  // silence a site with no template of two fingerprinted pages produces.
  await assertCrawl(db, crawlId, self.id);

  const round2 = (expr: SQL): SQL => sql`round((${expr})::numeric, 2)::float8`;
  const pct = (q: string): SQL =>
    round2(sql`percentile_cont(${sql.raw(q)}) within group (order by pr.hamming)`);
  const share = (bits: number): SQL =>
    sql`round(100.0 * count(*) filter (where pr.hamming <= ${bits}) / count(*), 1)::float8`;

  const rows = await db.execute<SimilarityRow>(sql`
    with cohort as (
      select ${COHORT_PAGE_TYPE} as page_type, p.id as id, p.simhash as simhash
      from pages p
      where ${cohortFilter(crawlId)} and p.simhash is not null
    ),
    sampled as (
      select page_type, id, simhash
      from (
        select page_type, id, simhash,
               row_number() over (partition by page_type order by id) as rn
        from cohort
      ) ranked
      where rn <= ${TEMPLATE_SAMPLE_PAGES}
    ),
    sizes as (
      select page_type, count(*)::int as pages_fingerprinted from cohort group by page_type
    ),
    sample_sizes as (
      select page_type, count(*)::int as pages_sampled from sampled group by page_type
    ),
    pairs as (
      -- a.id < b.id: each unordered pair once, and never a page against itself.
      select a.page_type as page_type,
             bit_count((a.simhash # b.simhash)::bit(64))::int as hamming
      from sampled a
      join sampled b on b.page_type = a.page_type and a.id < b.id
    )
    select pr.page_type as page_type,
           z.pages_fingerprinted as pages_fingerprinted,
           s.pages_sampled as pages_sampled,
           count(*)::int as pairs_sampled,
           ${round2(sql`avg(pr.hamming)`)} as mean_hamming,
           ${pct("0.25")} as p25,
           ${pct("0.5")} as median,
           ${pct("0.75")} as p75,
           ${share(TEMPLATE_NEAR_BITS)} as share_within_near,
           ${share(TEMPLATE_LOOSE_BITS)} as share_within_loose
    from pairs pr
    join sizes z on z.page_type = pr.page_type
    join sample_sizes s on s.page_type = pr.page_type
    group by pr.page_type, z.pages_fingerprinted, s.pages_sampled
    order by pr.page_type`);

  return rows.rows.map((row) =>
    metricRow(self, {
      scope: "page_type",
      scopeValue: text(row.page_type, "page_type", self.id),
      value: {
        pagesFingerprinted: num(row.pages_fingerprinted, "pages_fingerprinted", self.id),
        pagesSampled: num(row.pages_sampled, "pages_sampled", self.id),
        pairsSampled: num(row.pairs_sampled, "pairs_sampled", self.id),
        meanHamming: num(row.mean_hamming, "mean_hamming", self.id),
        p25: num(row.p25, "p25", self.id),
        median: num(row.median, "median", self.id),
        p75: num(row.p75, "p75", self.id),
        shareWithin3BitsPct: num(row.share_within_near, "share_within_near", self.id),
        shareWithin8BitsPct: num(row.share_within_loose, "share_within_loose", self.id),
      },
    }),
  );
}

/**
 * The two content metrics.
 *
 * The `shareWithin3BitsPct` / `shareWithin8BitsPct` key names spell
 * `TEMPLATE_NEAR_BITS` and `TEMPLATE_LOOSE_BITS`, which the copy test pins:
 * a threshold that moved without its key and its copy moving with it would be
 * a column whose name lies about what it counted. Both halves of the suffix
 * earn their place — the numeral is a distance in BITS and the value is a
 * PERCENTAGE, and `shareWithin3Pct` would read as "within 3 per cent" to
 * anyone holding the jsonb without the copy beside it.
 */
export const contentMetrics: MetricRule[] = [
  metricRule("content.metrics-by-type", ["CHECK-38"], CONTENT, async (db, crawlId, self) =>
    contentByType(db, crawlId, self),
  ),

  metricRule("content.template-similarity", ["CHECK-38"], CONTENT, async (db, crawlId, self) =>
    templateSimilarity(db, crawlId, self),
  ),
];

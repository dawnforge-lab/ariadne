/**
 * The content rules: what the site's own text says about pages that are not
 * what they claim to be.
 *
 * Four questions, none of which a page rule can answer, because each of them
 * needs something outside the row — the site's 404 template (CHECK-13),
 * another page of the same site (CHECK-39), or the CRAWL's own census
 * (CHECK-40, below):
 *
 *  - `content.soft-404`     a page that answers 200 and is a missing page
 *  - `content.exact-duplicate`  byte-identical text at more than one URL
 *  - `content.near-duplicate`   main content that differs only in boilerplate
 *  - `content.thin`         a page with too little content of its own
 *
 * …and two NOT MEASURED markers, `content.near-duplicate-skipped` and
 * `content.thin-skipped`, for the crawl on which the last two cannot be asked
 * at all (see below).
 *
 * **WHY `content.thin` IS HERE AND NOT IN src/rules/page/on-page.ts** (Phase 19
 * §11). It was a page rule for eleven phases, reading `renderable_word_count`
 * off the row it was handed. The amendment moved its floor onto
 * `main_word_count` — the words that are not the header, navigation, sidebar
 * and footer — and that column has a null a page rule cannot read: null means
 * "this page has no main content of its own" on a 0018 crawl and "nothing on
 * this crawl was ever measured" on an older one. The first is a page that IS
 * thin (zero words of its own); the second is a page nothing may be concluded
 * about. A page rule sees one row and cannot tell them apart, so it would have
 * had to pick one — inventing a finding on every old crawl, or passing every
 * empty page in silence (hard rule 1). The census that separates them is a
 * question about the crawl, which makes this a query rule, and its marker one
 * too. See `thinFindings`.
 *
 * All of them run entirely in SQL over columns the analyzer already wrote
 * (`has_soft404_phrases`, `word_count`, `content_hash`, `simhash`,
 * `main_simhash`, `main_word_count`). Nothing here fetches (hard rule 2),
 * nothing here loads a table into memory (hard rule 3), and no rule re-hashes a
 * page: the fingerprints were computed once, during the single streaming parse.
 *
 * **THE CANONICAL IS READ BY EVERY RULE HERE BUT THE SOFT 404** (Phase 19 §1
 * and §11). A page whose
 * declared canonical names another URL has already handed its signals over, and
 * reporting it as a duplicate reports the remedy as the fault — which is what
 * the crawl behind Phase 19 did, twice, at critical severity. The two duplicate
 * rules and `content.thin` therefore filter with `CANONICALISED_ELSEWHERE`, the
 * string-level SQL form of `isCanonicalisedElsewhere`, stated once in
 * src/rules/helpers.ts and used from here rather than restated — a parameter
 * variant of a full page is not a thin page any more than it is a duplicate
 * one; it is the same page, said once. `content.soft-404` does NOT: a page that is a
 * missing page is a missing page whoever it points at, and a soft 404 under a
 * tracking parameter is still a URL the site should stop serving 200 for.
 *
 * **The signed-bigint contract.** `simhash64` produces a value in the unsigned
 * 64-bit range; `pages.simhash` and `pages.main_simhash` are signed Postgres
 * bigints and `PageWriter` stores `BigInt.asIntN(64, …)` into both — one
 * spelling, two columns. Every comparison below runs on that signed
 * value, and that is safe because both operations used are representation-level
 * rather than arithmetic: `#` XORs the two's-complement bit patterns, and
 * `bit_count(…::bit(64))` counts set bits in them. The stored 404 template
 * arrives in the same signed spelling (`NotFoundProbeSample.simhash`), so no
 * conversion happens anywhere between the analyzer and the comparison.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { CANONICALISED_ELSEWHERE, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import {
  capsOr,
  limitTo,
  noteTruncation,
  readCrawlEvidence,
  readNotFoundProbe,
  type NotFoundProbeReading,
} from "./crawl-evidence.js";

const CATEGORY = "content" as const;

const SOFT_404: RuleIdentity = { id: "content.soft-404", severity: "critical" };
const EXACT: RuleIdentity = { id: "content.exact-duplicate", severity: "critical" };
const NEAR: RuleIdentity = { id: "content.near-duplicate", severity: "warning" };
const NEAR_SKIPPED: RuleIdentity = {
  id: "content.near-duplicate-skipped",
  severity: "info",
};
const THIN: RuleIdentity = { id: "content.thin", severity: "warning" };
const THIN_SKIPPED: RuleIdentity = { id: "content.thin-skipped", severity: "info" };

/**
 * Below this, a page carrying "page not found" wording is reported as one.
 *
 * Deliberately generous — well above `THIN_WORDS` — because the phrase alone is
 * not the finding. An article ABOUT broken links contains the same words and
 * runs to a thousand of them; a 404 rendered into the site's shell rarely
 * clears three hundred. Exported because the client-facing copy quotes it.
 */
export const SOFT_404_WORDS = 300;

/**
 * How close to the site's own 404 template a page may sit before it is one.
 *
 * Four bits out of sixty-four. A template rendered around different breadcrumbs
 * or a different `<title>` moves a handful of bits; genuinely different pages
 * sit thirty-odd apart (see the corpus assertions in the test), so the band
 * between the two is wide and nothing lives in it.
 */
export const TEMPLATE_HAMMING = 4;

/** How close two pages may sit before they are near-duplicates of each other. */
export const NEAR_DUPLICATE_HAMMING = 3;

/**
 * How much MAIN content a page must have of its own before it can be one half of
 * a near-duplicate pair. Both sides must clear it.
 *
 * Fifty words is the floor under which the question stops being answerable
 * rather than a judgement about quality. A simhash over a couple of dozen words
 * is dominated by a handful of tokens, so two pages carrying nothing but a
 * heading and a sentence land inside three bits of each other whenever the
 * heading pattern repeats — and on a templated site that is every empty
 * category, every out-of-stock product and every tag archive. Those pages are a
 * real problem and they have a rule: `content.thin`, below in this file, reports
 * them at a floor of `THIN_WORDS` words of their own. Reporting them a second
 * time as duplicates of one another says nothing new and buries the pages that
 * genuinely have near-identical content.
 *
 * It sits BELOW `THIN_WORDS` on purpose, and the gap is the point: a page
 * between 50 and 150 main words is thin AND can still be shown to be a copy of
 * another page, which is a sharper finding than either alone. Only below fifty
 * does the fingerprint stop carrying enough of the page to compare.
 */
export const NEAR_DUPLICATE_MIN_MAIN_WORDS = 50;

/**
 * The thin-content floor: below this many words of its OWN content, an
 * indexable page is reported (CHECK-40, CHECK-13).
 *
 * MOVED HERE FROM src/rules/page/on-page.ts with the rule (Phase 19 §11), so
 * the floor and the floor beneath it — `NEAR_DUPLICATE_MIN_MAIN_WORDS`, whose
 * docblock argues the gap between them — are one file apart no longer.
 * Exported because the client-facing copy quotes the number and
 * test/rules/copy.test.ts asserts the sentence against this constant.
 *
 * The number did not move in Phase 19; the QUANTITY it is applied to did. It
 * used to be `renderable_word_count` (the words the page's markup does not
 * hide) and is now `main_word_count` (the words that are not header,
 * navigation, sidebar or footer). On the crawl that provoked the amendment,
 * 35 pages have fewer than 150 words of their own and NOT ONE has fewer than
 * 150 renderable words — every page carries ~900 words of chrome — so the rule
 * fired on nothing at all while a third of the site's `/pages/*` URLs were
 * empty templates. That is the always-passes shape hard rule 1 forbids, and
 * the column is what was wrong with it.
 */
export const THIN_WORDS = 150;

/**
 * How many of a page's near-duplicates one finding names.
 *
 * `DUPLICATE_SAMPLE_URLS`'s argument, one size down: the exact count is in the
 * evidence beside the list, so the list is there to be READ — to see whether
 * the partners are the same template or a scatter across the site — and a page
 * in a cluster of forty has forty near-identical URLs of which any five tell
 * the same story. Five rather than twenty because these carry a distance and a
 * word count each and are ordered by closeness: the first ones are the ones
 * worth looking at, and the tail is a repetition of the cluster the count
 * already sizes.
 */
export const NEAR_DUPLICATE_CLOSEST = 5;

/**
 * How far a page's own near-duplicate count is allowed to run before the number
 * becomes "200 or more".
 *
 * THIS IS A WALL-CLOCK BOUND, not a listing budget, and it is what takes the
 * expensive half of the rule's cost off the square of the site. Counting every
 * partner exactly means visiting every pair, and a degenerate cohort — a
 * templated site where thousands of pages share one main-content fingerprint —
 * has a square of them. Measured on a seeded cohort of identical fingerprints,
 * the exact count took 101.9s at 5,000 pages and 950.1s at 20,000; with this cap
 * the same crawls take 16.5s and 98.7s (the full numbers and the plan that
 * explains them are on `nearDuplicateFindings`). The memory contract was never
 * at risk — the partners are counted inside Postgres — but hard rule 6's
 * sibling, a 50k crawl that finishes, was.
 *
 * Two hundred rather than five or fifty because the count is READ, not just
 * sorted on: "eleven near-duplicates" and "sixty" are different findings about
 * different problems, and both should be exact. Above two hundred they are the
 * same finding — this template has no distinct content — and the extra
 * precision buys a reader nothing while costing every page beyond the cap a
 * full pass over its band candidates.
 *
 * A page that hits it says so IN THE EVIDENCE (`nearDuplicatesAtLeast: true`),
 * in the vocabulary the listing notes already use for a floor
 * (`LowerBoundTruncation`, src/rules/query/crawl-evidence.ts): a number nothing
 * behind it counted exactly must never be presented as exact. Absent the flag,
 * `nearDuplicates` is the exact count.
 */
export const NEAR_DUPLICATE_COUNT_CAP = 200;

/**
 * One probe past the cap: the extra row is how the query knows the difference
 * between "exactly 200" and "200 or more" without counting the rest.
 */
const NEAR_DUPLICATE_COUNT_PROBE = NEAR_DUPLICATE_COUNT_CAP + 1;

/**
 * URLs quoted on a duplicate-GROUP finding. The count beside them is exact.
 *
 * Shared with the field-level duplicate rules (src/rules/query/field-duplicates.ts),
 * which report the same shape over titles, meta descriptions and H1 text: a
 * group finding quotes the same number of URLs whichever field produced it, so
 * a reader meets one list length rather than two, and the number moves in one
 * place.
 */
export const DUPLICATE_SAMPLE_URLS = 20;

/** The three content rules' idea of a page worth judging, in SQL. */
const AUDITABLE = (alias: string): SQL =>
  sql.raw(
    `${alias}.fetch_class = 'ok' and ${alias}.status_code = 200 and ${alias}.is_indexable = true`,
  );

/**
 * The site's 404 template as a signed bigint, or null when this crawl has none
 * to compare against.
 *
 * Null covers four different situations, and none of them is a finding:
 *  - the column is null: the crawl never reached the probe step;
 *  - `{ skipped }`: the step ran and decided not to fetch (cancelled, robots
 *    disallowed the probe path, nothing crawled), and said why;
 *  - the probe did not answer 200: the site returns a real 404 for a URL it does
 *    not have, which is the healthy configuration and leaves no template;
 *  - it answered 200 with something the analyzer could not fingerprint.
 *
 * In all four the *template* signal is unavailable while the *phrase* signal is
 * unaffected, so the rule goes on running with one signal instead of two. That
 * is data-gating inside a live rule, not a skipped check: `content.soft-404`
 * still reports every page whose wording and length say it is a 404, and no
 * separate `…-skipped` rule is needed to explain a silence, because silence
 * here still means "no page matched what could be checked".
 */
function templateSimhash(probe: NotFoundProbeReading): bigint | null {
  const sample = probe.probe;
  if (sample === null || "skipped" in sample) return null;
  if (sample.statusCode !== 200 || sample.simhash === null) return null;
  // Validated by `parseNotFoundProbe`: an integer inside the signed 64-bit
  // range, in the same spelling `pages.simhash` holds.
  return BigInt(sample.simhash);
}

/**
 * Pages that answer 200 and are a missing page (CHECK-13).
 *
 * Two independent signal paths, and EITHER alone fires the rule:
 *
 *  1. *phrases* — the analyzer found "page not found" wording in the visible
 *     text AND the page is under `SOFT_404_WORDS`. Neither half is enough on
 *     its own: an article about 404s carries the words, and a short page is
 *     `content.thin`'s finding, not this one.
 *
 *     THE LENGTH IS `renderable_word_count` (Phase 7), the words the page's
 *     own markup does not hide — the same column `content.thin`'s floor reads,
 *     and for a sharper version of the same reason. A soft 404 is a short page
 *     rendered into the site's full shell, so its raw `word_count` carries
 *     every word of that shell's mega-menu, currency picker and closed
 *     accordions: on the site that provoked the change, ~740 of them, which is
 *     more than twice this ceiling on its own. Reading the inflated column
 *     makes the ceiling far too permissive and the failures are FALSE
 *     NEGATIVES — a real soft 404 that never fires — which is the phase's own
 *     defect direction.
 *
 *     NO COALESCE, deliberately. A pre-Phase-7 row has a `word_count` and no
 *     renderable one, and `coalesce(renderable, word_count)` would reintroduce
 *     exactly the silent wrong-column fallback the thin-content rule one file
 *     away refuses by name. `null < 300` is NULL and SQL drops the row, so
 *     such a page is not judged on this path — and it is not judged in
 *     silence either: `content.thin-skipped` announces the same crawl's same
 *     pages, once per page, with copy that says re-crawl. The `is not null`
 *     guard stays for the JavaScript arm below, which re-derives the signal
 *     list and must agree with the WHERE clause exactly.
 *  2. *template-match* — the page sits within `TEMPLATE_HAMMING` bits of the
 *     body the site served for a URL that cannot exist. This is the path that
 *     catches the soft 404 with no telltale wording at all, and it exists only
 *     because the crawl deliberately fetched one URL it knew was missing.
 *
 * Which paths fired is named in the evidence rather than left implied, because
 * they carry different weight: a template match is close to proof, while
 * wording plus brevity is a strong suggestion the agent may want to look at.
 * `hammingToTemplate` appears exactly when a distance was actually computed —
 * there is no "0" standing in for "not measured".
 */
async function soft404Findings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  // The crawl must exist before anything is concluded from an empty scan (the
  // `sitemap` rules' precedent). `readNotFoundProbe` throws for an unknown
  // crawl id too, so this is the probe read rather than a second round trip.
  const template = templateSimhash(await readNotFoundProbe(db, crawlId, SOFT_404.id));

  // Passed as a decimal string with an explicit cast rather than as a bigint:
  // the driver stringifies a bigint anyway, and the cast says what the
  // parameter is instead of leaving it to inference.
  const distance =
    template === null
      ? null
      // `::int` on the outside is not cosmetic: `bit_count` returns a bigint,
      // which the driver hands back as a STRING, and a string distance would
      // reach the evidence as `"3"` and compare against the threshold by
      // coercion. A distance is a small number and is carried as one.
      : sql`bit_count((p.simhash # ${String(template)}::bigint)::bit(64))::int`;

  const result = await db.execute<{
    id: string;
    url: string;
    word_count: number | null;
    renderable_word_count: number | null;
    has_soft404_phrases: boolean;
    hamming: number | null;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.word_count, p.renderable_word_count, p.has_soft404_phrases,
           ${distance === null ? sql`null::int` : distance} as hamming,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId} and ${AUDITABLE("p")}
      and (
        (p.has_soft404_phrases and p.renderable_word_count is not null
          and p.renderable_word_count < ${SOFT_404_WORDS})
        or ${
          distance === null
            ? sql`false`
            : sql`(p.simhash is not null and ${distance} <= ${TEMPLATE_HAMMING})`
        }
      )
    order by p.url
    ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) => {
    const signals: string[] = [];
    if (
      row.has_soft404_phrases &&
      row.renderable_word_count !== null &&
      row.renderable_word_count < SOFT_404_WORDS
    ) {
      signals.push("phrases");
    }
    if (row.hamming !== null && row.hamming <= TEMPLATE_HAMMING) signals.push("template-match");
    // The WHERE clause admits a row only if one of the two paths matched, so an
    // empty list here would mean the SQL and the JavaScript disagree about what
    // fired — a finding with no signal behind it, which is exactly the silent
    // nonsense hard rule 7 exists to stop.
    if (signals.length === 0) {
      throw new Error(
        `${SOFT_404.id}: page '${row.url}' matched the query but no signal explains it`,
      );
    }
    return queryFinding(SOFT_404, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        signals,
        // Both counts, like `content.thin`'s finding: the ceiling was applied
        // to the renderable one, and a reader comparing "42 words a visitor
        // reaches, 780 in the HTML" can see at a glance that the page is a
        // shell around an error message.
        wordCount: row.word_count,
        renderableWordCount: row.renderable_word_count,
        ...(row.hamming === null ? {} : { hammingToTemplate: row.hamming }),
      },
      dedupeKey: row.url,
    });
  });
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * Groups of indexable 200 pages whose visible text hashes identically
 * (CHECK-39).
 *
 * One finding per GROUP, not per page and not per pair: "these four URLs are
 * the same page" is one decision to make, and four findings saying it would be
 * four times the work for the same fix. It lands on the lexically first member
 * so an action plan has a URL to point at, and the rest are in the evidence.
 *
 * `content_hash is not null` is load-bearing. Postgres groups nulls together,
 * so without it every page the analyzer could not read would be reported as
 * identical to every other one — a finding built on knowing nothing about
 * either page.
 *
 * `pageTypes` is the distinct set across the WHOLE group, not across the
 * quoted sample: duplicates spanning two templates (a product page and its
 * print version) are a different problem from duplicates inside one, and that
 * distinction must not depend on which twenty URLs happened to be quoted.
 *
 * **A PAGE CANONICALISED ELSEWHERE IS NOT A MEMBER** (Phase 19 §1). The crawl
 * that provoked this produced exactly two findings and both were the same
 * mistake: `/collections/sale` beside `/collections/sale?product-type=dress`,
 * and `/pages/email-signup` beside a `?srsltid=` Google tracking variant. In
 * each pair the variant declares `<link rel=canonical>` to the base URL — which
 * is, word for word, the first thing this rule's own `howToFix` tells a reader
 * to do — and the rule reported the fixed state as critical because it grouped
 * on `content_hash` and never read the canonical. So the filter goes on BOTH
 * halves of the query: the `dupes` CTE, which decides whether a group exists
 * and how big it is, and the `sample` lateral, which decides which URLs are
 * quoted. One without the other would leave a finding whose count and whose URL
 * list disagreed about what a member is.
 *
 * A group that shrinks below two members by this filter is not a finding at all
 * — `having count(*) > 1` is applied after it — which is what makes a pair of
 * parameter variants under one canonical disappear rather than shrink to a
 * confusing group of one. A group of three whose third member is canonicalised
 * elsewhere still fires, on the two that are not, and says `count: 2`: the two
 * URLs that genuinely compete are still competing.
 *
 * **THE CAP COMES BEFORE THE LATERAL.** A `cross join lateral` under an
 * `order by`/`limit` at the same query level is evaluated for every row the FROM
 * produces — the limit cannot apply until the rows exist — so the twenty-URL
 * lookup ran once per GROUP rather than once per reported group, and a
 * templated site with thousands of duplicate groups paid minutes for it. The
 * `capped` CTE takes the exact `count(*) over ()` total (a window is evaluated
 * over the whole CTE before its own `order by`/`limit`, so it counts every
 * group) and cuts to `caps.listing` first; the lateral then runs against at
 * most that many rows. Semantics are untouched — same group order, same
 * carrier, same totals — and the same restructure is in
 * src/rules/query/field-duplicates.ts, which took this shape from here.
 *
 * **WHAT THE CAP GOVERNS, AND WHAT IT DOES NOT.** `findingCap` moves the number
 * of GROUPS this rule reports — uncapped, every duplicate group on the site gets
 * a row. It does NOT move `DUPLICATE_SAMPLE_URLS`: one finding quotes twenty
 * URLs and the group's EXACT count at every cap, including none. A group of five
 * thousand pages is one row saying "5,000 pages, here are twenty of them", never
 * a five-thousand-element array in a single `details` jsonb — that would be a
 * pathological row rather than a fuller picture, and the exact count already
 * carries the magnitude. Uncapped means more findings, not fatter ones.
 */
async function exactDuplicateFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, EXACT.id);
  const result = await db.execute<{
    content_hash: string;
    page_count: number;
    page_types: string[] | null;
    urls: string[];
    first_id: string;
    total_matches: number;
  }>(sql`
    with dupes as (
      select p.content_hash,
             count(*)::int as page_count,
             array_agg(distinct p.page_type)
               filter (where p.page_type is not null) as page_types
      from pages p
      where p.crawl_id = ${crawlId} and ${AUDITABLE("p")} and p.content_hash is not null
        and not ${CANONICALISED_ELSEWHERE("p")}
      group by p.content_hash
      having count(*) > 1
    ),
    capped as (
      select d.content_hash, d.page_count, d.page_types,
             count(*) over ()::int as total_matches
      from dupes d
      order by d.content_hash
      ${limitTo(caps.listing)}
    )
    select c.content_hash, c.page_count, c.page_types, c.total_matches,
           s.urls, s.first_id
    from capped c
    cross join lateral (
      select array_agg(sample.url) as urls, (array_agg(sample.id))[1] as first_id
      from (
        select p2.id, p2.url
        from pages p2
        where p2.crawl_id = ${crawlId} and ${AUDITABLE("p2")}
          and not ${CANONICALISED_ELSEWHERE("p2")}
          and p2.content_hash = c.content_hash
        order by p2.url
        limit ${DUPLICATE_SAMPLE_URLS}
      ) sample
    ) s
    order by c.content_hash`);

  const findings = result.rows.map((row) =>
    queryFinding(EXACT, {
      pageId: row.first_id,
      pageUrl: row.urls[0] ?? null,
      evidence: {
        contentHash: row.content_hash,
        urls: row.urls,
        // Exact: the group's real size, whatever the sample above holds.
        count: row.page_count,
        // Null when every member's page type is null — `array_agg` over an
        // all-null group returns null rather than an empty array. Sorted here
        // rather than in the aggregate because Postgres would sort it under the
        // database's collation, and the same two templates would come back in a
        // different order on a database created with a different one.
        pageTypes: [...(row.page_types ?? [])].sort(),
      },
      dedupeKey: row.content_hash,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * What the gate query below reads, so the rules and their markers share one
 * shape.
 *
 * READ BY FOUR RULES, not two (Phase 19 §11): `content.near-duplicate` and
 * `content.thin` both stand on the main-content fingerprint, and each has a
 * marker that fires exactly where its rule cannot run. The population is the
 * same one both rules judge — auditable and indexable — so a crawl either
 * carries this measurement or it does not, and the two pairs never disagree
 * about which.
 */
interface MainFingerprintCensus {
  /** Pages these rules would consider at all: auditable, indexable. */
  auditable: number;
  /** Whether ANY of them carries a `main_simhash`. */
  anyMainSimhash: boolean;
}

async function mainFingerprintCensus(db: Db, crawlId: string): Promise<MainFingerprintCensus> {
  // `bool_or` over the same population the two rules start from, so the gate
  // and the rules can never disagree about which pages were in scope. Over zero
  // rows it returns NULL, which `?? false` turns into "no fingerprint" — and
  // the `auditable` count is what keeps that from being read as a skip: an
  // empty crawl has nothing to measure, which is not the same as a crawl whose
  // pages were measured with an older analyzer.
  const rows = await db.execute<{ auditable: number; any_main: boolean | null }>(sql`
    select count(*)::int as auditable,
           bool_or(p.main_simhash is not null) as any_main
    from pages p
    where p.crawl_id = ${crawlId} and ${AUDITABLE("p")}`);
  const row = rows.rows[0];
  // An aggregate with no GROUP BY returns exactly one row for any input; no row
  // means the query is not the query this function thinks it is.
  if (row === undefined) {
    throw new Error(`content: the main-fingerprint census for ${crawlId} returned no row`);
  }
  return { auditable: Number(row.auditable), anyMainSimhash: row.any_main ?? false };
}

/**
 * Whether the main-content measurement exists on this crawl at all: false when
 * `content.near-duplicate` and `content.thin` can be asked, true when their two
 * markers are the answer instead.
 *
 * ONE PREDICATE, READ BY ALL FOUR, so each rule's silence and its marker's
 * sentence are the same decision rather than two that happen to agree.
 *
 * It takes the census rather than fetching one, because the marker needs the
 * `auditable` count for its evidence as well as the verdict: a predicate that
 * queried for itself would make that function ask the database the same
 * question twice to answer one question once.
 */
function mainFingerprintUnavailable(census: MainFingerprintCensus): boolean {
  return census.auditable > 0 && !census.anyMainSimhash;
}

/**
 * The NOT MEASURED marker for a crawl the main-content fingerprint does not
 * exist on (Phase 19 §2, hard rule 1).
 *
 * **THE PREDICATE, AND WHY IT IS THIS ONE.** It fires when the crawl holds
 * pages `content.near-duplicate` would have judged — auditable, indexable — and
 * NOT ONE of them carries a `main_simhash`. Two crawls satisfy that and both
 * are honestly unmeasurable:
 *
 *  - a crawl written before migration 0018, where the column exists and every
 *    row is null because nothing computed it. This is the case the marker was
 *    asked for, and the fingerprint cannot be recovered afterwards: it is taken
 *    from the page's text while the page is being read, and the crawl does not
 *    store the HTML.
 *  - a 0018 crawl whose every page turned out to have no main content at all —
 *    an empty `<main>`, or a body that is nothing but navigation and footer on
 *    every single URL. Vanishingly rare and not what this was written for, but
 *    the same sentence is true of it: nothing on this crawl carries the
 *    fingerprint the check compares, so the check was not run.
 *
 * **WHAT MUST NOT FIRE IT** is the ordinary 0018 crawl, where SOME pages carry
 * no main content — a redirect landing page, an image gallery, a menu-only
 * index. Those pages are simply not candidates, exactly as a page with no
 * `content_hash` is not a candidate for the exact-duplicate rule, and the check
 * WAS run: it ran over the pages that had something to compare. A predicate
 * written as "any auditable page has a null `main_simhash`" would fire on every
 * real site and turn a marker that means "this could not be measured" into
 * noise attached to a crawl that measured it fine. Hence `bool_or`, not
 * `count(*) filter`.
 *
 * Site-scoped: one finding for the crawl, not one per page. The condition is a
 * property of the crawl, and a pre-0018 crawl of fifty thousand pages would
 * otherwise write fifty thousand copies of one sentence. `content.thin-skipped`
 * is its twin in every respect since §11 — same census, same scope, same
 * sentence about a different check — and the two fire together, because a crawl
 * that never measured main content could not answer either question.
 */
async function nearDuplicateSkippedFindings(db: Db, crawlId: string): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, NEAR_SKIPPED.id);
  const census = await mainFingerprintCensus(db, crawlId);
  if (!mainFingerprintUnavailable(census)) return [];
  return [
    queryFinding(NEAR_SKIPPED, {
      pageId: null,
      pageUrl: null,
      evidence: {
        // The size of what went unjudged, so a reader can weigh the gap: these
        // are the pages the check would have compared had the fingerprint been
        // there, and every one of them is unexamined for near-duplicates. Named
        // `indexablePages` because that is what this quantity is called
        // everywhere else it is published (`schema.none-on-site`,
        // `hreflang.coverage`) — the same predicate, the same word.
        indexablePages: census.auditable,
        minMainWords: NEAR_DUPLICATE_MIN_MAIN_WORDS,
      },
      dedupeKey: "site",
    }),
  ];
}

/**
 * Indexable 200 pages whose MAIN CONTENT sits within `NEAR_DUPLICATE_HAMMING`
 * bits of at least one OTHER page of the same crawl (CHECK-39).
 *
 * **ONE FINDING PER PAGE, NOT PER PAIR** (Phase 19 §11), and the amendment is
 * an observation rather than a preference. The re-crawl at 0018
 * (`crawl_9278877e`, 547 pages) produced 500 pairs — the cap — over a cluster
 * of 79 near-empty `/pages/*` URLs whose main content was one heading and the
 * theme's footer. Seventy-nine pages are 3,081 pairs, and a findings table
 * holding 500 arbitrary ones of them says the same sentence five hundred times
 * about the same 79 URLs. Per page, the same cluster is 79 rows each saying
 * "78 near-duplicates, here are the five closest", which is one row per
 * decision a reader actually has to make. Screaming Frog's "Near Duplicates"
 * column is the precedent for the shape: a count and the closest matches
 * against each URL.
 *
 * It is also what makes the listing bounded by the SITE rather than by the
 * square of it, and that is hard rule 6 rather than tidiness. The old shape
 * carried a scan ceiling (`NEAR_DUPLICATE_PAIR_CEILING`, 100,000 pairs) because
 * an uncapped run over a degenerate site put the process past the 512MB memory
 * contract at 2,000 pages and exhausted a 4GB heap at 20,000: the findings
 * ARRAY was quadratic. Aggregating in SQL removes the structure rather than
 * capping it — the pair set is counted inside Postgres and never crosses the
 * driver, and what this process holds is at most one finding per page, exactly
 * like every other listing rule. The ceiling went with it (see
 * `resolveRuleCaps`).
 *
 * **AND THE COUNT IS BOUNDED PER PAGE, WHICH IS WHAT TOOK THE WALL CLOCK OFF
 * THE SQUARE.** Removing the quadratic ARRAY left the quadratic WORK: a
 * symmetric self-join aggregated per page still visits every pair, so on a
 * degenerate cohort — one fingerprint shared by thousands of pages — the clock
 * grew with the square even though the memory did not. It is now one bounded
 * probe per page: for each candidate `a`, a lateral that stops after
 * `NEAR_DUPLICATE_COUNT_PROBE` partners, so the rows fetched and filtered are
 * O(pages × 201) rather than O(pairs). A page at the cap reports
 * `nearDuplicates: 200` with `nearDuplicatesAtLeast` beside it — a floor, said
 * as a floor. What is left growing with the square, and why it is cheap, is in
 * **What this costs** below with the numbers.
 *
 * The evidence names the page's own main word count, how many near-duplicates
 * it has (exact below `NEAR_DUPLICATE_COUNT_CAP`, a stated floor at it,
 * whatever the `closest` list holds) and the `NEAR_DUPLICATE_CLOSEST` nearest
 * partners with their distances — nearest first, ties broken by URL. `pageUrl`
 * is not in the evidence because the writer puts it there (src/rules/run.ts), on
 * every finding, from the finding's own `pageUrl`.
 *
 * **WHY `main_simhash` AND NOT `simhash`** (Phase 19 §2). `simhash` is taken
 * over the whole visible text, and on a templated site most of that text is the
 * same header, navigation and footer on every page. The crawl that provoked
 * this carries a smallest page of 916 words and a median of 1,064, of which
 * about 900 are chrome: two pages with 150 words of their own therefore agree
 * on six sevenths of their tokens and land inside three bits of each other
 * whatever they say. The rule reported 500 pairs (the cap), 237 of them across
 * templates with nothing to do with one another, every one at a distance of 1
 * or 2. That is not a threshold that was set too wide — it is a fingerprint
 * measuring the furniture. `main_simhash` is the same fingerprint over the text
 * inside `<main>`, or over the body when there is no `<main>`, and in both
 * cases minus every `<nav>`, `<header>`, `<footer>` and `<aside>` subtree (see
 * page-analyzer.ts).
 *
 * **THE PAGE MUST HAVE CONTENT OF ITS OWN.** Both sides need
 * `main_word_count >= NEAR_DUPLICATE_MIN_MAIN_WORDS`, for the reason written on
 * that constant: below it the fingerprint is a handful of tokens and every
 * near-empty page on a template is a near-duplicate of every other one.
 * `content.thin` is the rule those pages belong to, and after the amendment it
 * is the rule that actually names them.
 *
 * **AND NEITHER SIDE MAY BE CANONICALISED ELSEWHERE** (§1) — a parameter
 * variant that points at its base URL is the fix, not the fault. The filter is
 * on both sides of the join and again inside the lateral, so a canonicalised
 * page is neither reported nor counted as somebody else's near-duplicate; a
 * count and a list that disagreed about what a partner is would be worse than
 * either.
 *
 * **THE BAND INDEXES COVER THIS COLUMN** (migration 0019).
 * `pages_simhash_band0..3` (migration 0004) index `simhash` and only `simhash`,
 * so when Phase 19 moved this rule onto `main_simhash` the four band predicates
 * below stopped matching anything and the pair join degraded to the quadratic
 * nested loop priced further down. `pages_main_simhash_band0..3` are the same
 * four expressions over the new column, and `test/db/migration-0019.test.ts` is
 * what proves the planner uses them: it lifts the four predicates below out of
 * this file, EXPLAINs the pair join over 4,000 rows, and asserts all four
 * `Bitmap Index Scan`s are in the plan under one `BitmapOr` with no sequential
 * scan on the inner side. It also compares those predicates with the four
 * `pg_indexes` definitions, so a change to either spelling fails there.
 *
 * **The banding join.** A self-join over every pair of pages is quadratic, so
 * the candidate set is narrowed first by four 16-bit bands: two hashes are only
 * considered if they agree exactly on one of bits 0-15, 16-31, 32-47 or 48-63.
 * That is a filter, not an approximation — pigeonhole: a pair differing in at
 * most 3 bits cannot have a differing bit in all four 16-bit bands, so at least
 * one band must match, and no pair inside the threshold can slip past. The
 * `bit_count` in the WHERE clause is the exact verification the bands only
 * approximate.
 *
 * **The probe is SYMMETRIC** (`b.id <> a.id`, where the pair form said
 * `a.id < b.id`). A page has to see every partner it has, not the ones with a
 * larger id, or the count would be an artefact of insertion order. Each pair is
 * therefore visited twice, once from each end, which is what one row per page
 * means — and the per-page `limit` is what keeps that from being a second
 * quadratic.
 *
 * **The sign, again.** `>>` on a Postgres bigint is an arithmetic shift, so the
 * sign bit propagates into the high bits of a shifted negative value — but both
 * sides of every band comparison are shifted identically and then masked with
 * `& 65535`, which keeps only the 16 bits of the band itself. Whatever the sign
 * extension puts above them is masked off on both sides, so the comparison is
 * on the same 16 bits it would be for a positive value. The XOR and `bit_count`
 * are representation-level and never look at the sign at all.
 *
 * Exact duplicates are excluded by `content_hash is distinct from` rather than
 * by distance: two identical pages are 0 bits apart and would otherwise be
 * reported twice, once by each rule, with two different fixes attached. A page
 * whose only twins are byte-identical therefore has no near-duplicates and no
 * finding here — `content.exact-duplicate` has it.
 *
 * **The four band predicates below are coupled, textually, to the four
 * expression indexes `pages_main_simhash_band0..3`** (migration 0019; declared
 * in src/db/schema.ts, where the same warning is written from the other side).
 * Postgres matches an expression index by comparing parse trees, so band 0 must
 * keep saying `(a.main_simhash >> 0) & 65535` — `int8shr(x, 0)` is not folded
 * away, and an index on a simpler spelling would not match it. And a single arm
 * that fails to match takes the WHOLE BitmapOr with it, because Postgres will
 * not use indexes for an OR unless every branch is indexable. That failure is
 * silent: a slow query, not an error — which is why the coupling is asserted
 * rather than described: `test/db/migration-0019.test.ts` compares these four
 * predicates with the four index definitions and EXPLAINs the join. Perturbing
 * one shift there turns the whole plan into a sequential scan on the inner
 * side, and that is what the test catches. THE CLOSEST-PARTNER LATERAL'S OWN
 * BANDS ARE SPELLED WITH A TWO-LETTER ALIAS (`cp`/`nb`) ON PURPOSE: that test
 * lifts every single-letter band predicate out of this file and expects exactly
 * the four the counting probe runs, so its copies must not answer to the same
 * regex. Postgres matches the index on the expression, not on the alias — and
 * the counting probe keeps `a`/`b` for the same reason, so the four the test
 * lifts are the four the count is bounded by.
 *
 * **THE CAP COMES BEFORE THE LATERAL**, the exact-duplicate rule's lesson one
 * file-section up: a `cross join lateral` at the same query level as an
 * `order by`/`limit` is evaluated for every row the FROM produces. The `capped`
 * CTE takes the exact `count(*) over ()` total (a window is evaluated over the
 * whole CTE before its own `order by`/`limit`) and cuts to `caps.listing`
 * first, so the five-closest lookup runs against at most that many pages rather
 * than against every page on the site that has a near-duplicate.
 *
 * **What this costs.** Two shapes of site, both measured on this column with
 * 0019's indexes in place and `pages` ANALYZEd, running the whole rule:
 *
 *  - the SITE THE COST TABLE IS ABOUT (skills/ariadne-audit/SKILL.md): 20,000
 *    pages carrying 500 near-duplicate clusters of four. 200 findings in 0.61s
 *    at the default cap, 2,000 uncapped in 0.74s. This is the ordinary case —
 *    most pages have no partner at all, and the ones that do have three.
 *  - the DEGENERATE COHORT, which is what the per-page cap exists for: every
 *    page sharing one main-content fingerprint, so every page is every other
 *    page's near-duplicate. Counting each page's partners exactly took **101.9s
 *    at 5,000 pages and 950.1s at 20,000** — 4× the rows for 9.3× the time,
 *    which is the square, in Postgres's clock rather than in our memory.
 *    Through the per-page probe the same two crawls are **16.5s and 98.7s**.
 *
 * The residual growth in that second pair is worth naming rather than rounding
 * off, because it says where the next bottleneck is. EXPLAIN over the 5,000-page
 * cohort puts all four `Bitmap Index Scan`s under one `BitmapOr` inside the
 * lateral, per outer row, with the `Limit` stopping the heap scan at 201 rows
 * every time (`Heap Blocks: exact=110000` across 5,000 loops, `Rows Removed by
 * Filter: 0`). What the limit cannot bound is the BITMAP BUILD: the OR is
 * resolved over every candidate the bands match before a single heap row is
 * fetched, and on this cohort that is the whole crawl. So the heap work and the
 * canonical-exclusion evaluations — the expensive part, a dozen regex and array
 * operations per row — are O(pages × 201), and what remains O(pages²) is a
 * cheap in-memory bitmap. That is the difference between sixteen minutes and
 * ninety-nine seconds.
 *
 * Two caveats that belong in the 50k gate's expectations rather than in a
 * footnote:
 *  - expression indexes have no statistics until the table is ANALYZEd, and the
 *    planner will not choose a plan it cannot cost. A freshly loaded `pages` is
 *    exactly that table, so a gate crawl that runs the rules immediately after
 *    writing 50,000 rows should ANALYZE first or expect the planner to guess.
 *  - a 50k crawl that IS the degenerate cohort still costs minutes, not
 *    seconds, on the bitmap build above. It is bounded and it finishes; it is
 *    not free, and a site shaped like that is a site whose whole template has
 *    one page's worth of content — which is the finding, and the reason nobody
 *    needs its exact pair count.
 *
 * The listing is capped at `caps.listing` pages, ordered by how many
 * near-duplicates each has and then by URL, with the ordinary `noteTruncation`
 * note carrying the EXACT PAGE total — which the pair shape could not offer,
 * because counting every pair was the unbounded scan its cap existed to avoid,
 * and which the per-page count cap does not weaken: capping what one page says
 * about itself says nothing about how many pages there are, and that number is
 * still one `count(*) over ()`. The ordering survives the count cap too, with
 * one consequence worth naming: pages at the cap all tie at
 * `NEAR_DUPLICATE_COUNT_CAP` and are ordered among themselves by URL. On a site
 * with more than `caps.listing` such pages the listing is therefore an
 * alphabetical slice of one undifferentiated cohort — which is what that site
 * IS, and the finding to write about it is the template, not the row. The
 * threshold (`NEAR_DUPLICATE_HAMMING`, 3 bits) is not a knob and does not move
 * with either cap: it defines what a near-duplicate IS, and widening it would
 * change the finding rather than the size of the list.
 */
async function nearDuplicateFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, NEAR.id);
  // THE GATE, ASKED BEFORE THE JOIN. On a crawl with no main-content
  // fingerprint at all the query below would return nothing anyway — every
  // candidate is dropped by `main_simhash is not null` — and an empty result is
  // exactly what must not be reported as "no near-duplicates" (hard rule 1).
  // `content.near-duplicate-skipped` is what says so; this rule returns early
  // so that the two never disagree, and so that a crawl the check cannot be run
  // on does not pay for a scan whose answer is already known.
  if (mainFingerprintUnavailable(await mainFingerprintCensus(db, crawlId))) return [];
  const result = await db.execute<{
    id: string;
    url: string;
    main_word_count: number;
    near_count: number;
    closest: { url: string; hamming: number; mainWords: number }[];
    total_matches: number;
  }>(sql`
    with counted as (
      select a.id, a.url, a.main_simhash, a.content_hash, a.main_word_count,
             n.near_count
      from pages a
      cross join lateral (
        -- THE LIMIT IS INSIDE AND THE COUNT IS OUTSIDE, which is the whole
        -- bound: the derived table stops the moment it has produced
        -- NEAR_DUPLICATE_COUNT_PROBE partners, so this page costs at most that
        -- many band probes however many near-duplicates it really has. The
        -- aggregate over an empty derived table is 0, so a page with none is a
        -- row with near_count 0 rather than a missing row — the outer filter
        -- is what drops it, and the cross join never silently loses a page.
        select count(*)::int as near_count
        from (
          select 1
          from pages b
          where b.crawl_id = a.crawl_id and b.id <> a.id
            and a.content_hash is distinct from b.content_hash
            and ( (a.main_simhash >> 0)  & 65535 = (b.main_simhash >> 0)  & 65535
               or (a.main_simhash >> 16) & 65535 = (b.main_simhash >> 16) & 65535
               or (a.main_simhash >> 32) & 65535 = (b.main_simhash >> 32) & 65535
               or (a.main_simhash >> 48) & 65535 = (b.main_simhash >> 48) & 65535 )
            and ${AUDITABLE("b")}
            and not ${CANONICALISED_ELSEWHERE("b")}
            and b.main_simhash is not null
            and b.main_word_count >= ${NEAR_DUPLICATE_MIN_MAIN_WORDS}
            and bit_count((a.main_simhash # b.main_simhash)::bit(64)) <= ${NEAR_DUPLICATE_HAMMING}
          limit ${NEAR_DUPLICATE_COUNT_PROBE}
        ) probe
      ) n
      where a.crawl_id = ${crawlId} and ${AUDITABLE("a")}
        and not ${CANONICALISED_ELSEWHERE("a")}
        and a.main_simhash is not null
        and a.main_word_count >= ${NEAR_DUPLICATE_MIN_MAIN_WORDS}
        and n.near_count > 0
    ),
    capped as (
      select c.id, c.url, c.main_simhash, c.content_hash, c.main_word_count, c.near_count,
             count(*) over ()::int as total_matches
      from counted c
      order by c.near_count desc, c.url
      ${limitTo(caps.listing)}
    )
    select cp.id, cp.url, cp.main_word_count, cp.near_count, cp.total_matches, s.closest
    from capped cp
    cross join lateral (
      select coalesce(
               json_agg(
                 json_build_object('url', m.url, 'hamming', m.hamming, 'mainWords', m.main_words)
                 order by m.hamming, m.url),
               '[]'::json) as closest
      from (
        select nb.url, nb.main_word_count as main_words,
               bit_count((cp.main_simhash # nb.main_simhash)::bit(64))::int as hamming
        from pages nb
        where nb.crawl_id = ${crawlId} and ${AUDITABLE("nb")}
          and not ${CANONICALISED_ELSEWHERE("nb")}
          and nb.id <> cp.id
          and cp.content_hash is distinct from nb.content_hash
          and nb.main_simhash is not null
          and nb.main_word_count >= ${NEAR_DUPLICATE_MIN_MAIN_WORDS}
          and ( (cp.main_simhash >> 0)  & 65535 = (nb.main_simhash >> 0)  & 65535
             or (cp.main_simhash >> 16) & 65535 = (nb.main_simhash >> 16) & 65535
             or (cp.main_simhash >> 32) & 65535 = (nb.main_simhash >> 32) & 65535
             or (cp.main_simhash >> 48) & 65535 = (nb.main_simhash >> 48) & 65535 )
          and bit_count((cp.main_simhash # nb.main_simhash)::bit(64)) <= ${NEAR_DUPLICATE_HAMMING}
        order by hamming, nb.url
        limit ${NEAR_DUPLICATE_CLOSEST}
      ) m
    ) s
    order by cp.near_count desc, cp.url`);

  const findings = result.rows.map((row) => {
    // The probe row past the cap, turned into the two things a reader needs:
    // the number, and whether it is the whole number. `near_count` can only be
    // `NEAR_DUPLICATE_COUNT_PROBE` when the derived table stopped early, so this
    // is a fact about the query rather than a guess about the site.
    const atLeast = row.near_count > NEAR_DUPLICATE_COUNT_CAP;
    return queryFinding(NEAR, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        // How much content this page has of its own — the quantity the
        // distances were measured over. A page at 60 main words agreeing with
        // another to within three bits is a weaker claim than one at 800, and a
        // reader deciding whether to consolidate needs to see which this is.
        mainWords: row.main_word_count,
        // EXACT up to `NEAR_DUPLICATE_COUNT_CAP`, whatever `closest` holds: the
        // count comes from the per-page probe, the list from a five-row lateral.
        // At the cap it is a FLOOR and the flag beside it says so — 200 with
        // `nearDuplicatesAtLeast` is "200 or more", never "200".
        nearDuplicates: atLeast ? NEAR_DUPLICATE_COUNT_CAP : row.near_count,
        ...(atLeast ? { nearDuplicatesAtLeast: true } : {}),
        closest: row.closest,
      },
      dedupeKey: row.url,
    });
  });
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * Indexable 200 pages carrying fewer than `THIN_WORDS` words of their OWN
 * content (CHECK-40, CHECK-13).
 *
 * **THE COLUMN, AND WHY IT MOVED TWICE.** Phase 7 moved this floor off
 * `word_count` (every word the server sent) onto `renderable_word_count` (the
 * words the page's own markup does not hide), because a home page whose honest
 * visible content was 281 words counted 1,139 with its mega-menu, currency
 * picker and closed accordions in it. Phase 19 §11 moves it again, onto
 * `main_word_count`: the words that are not inside a `<nav>`, `<header>`,
 * `<footer>` or `<aside>` — the page's own content, whether or not the markup
 * hides any of it. The evidence for the second move is the same crawl the
 * phase was written from: 35 of its pages have under 150 words of their own,
 * NOT ONE has under 150 renderable words, and this rule fired on nothing while
 * a cluster of empty `/pages/*` templates sat in the index. Renderable words
 * were the right correction for hidden chrome and the wrong measure for
 * VISIBLE chrome, which is most of a templated site.
 *
 * Both numbers travel in the evidence — the page's own words and the whole
 * document's — because "94 words of its own, out of 830 on the page" is a
 * sentence someone can act on, and it names the shape of the problem: a page
 * that is mostly furniture.
 *
 * **THE NULL, AND WHY THIS IS A QUERY RULE** (hard rule 1). `main_word_count`
 * is null in two situations that must not be answered the same way:
 *
 *  - the analyzer found NO main-content text at all — an empty `<main>`, or a
 *    body that is nothing but navigation and footer. That page has zero words
 *    of its own, which is thinner than any page this rule reports, and it is
 *    reported AS zero (`mainWords: 0`, with a `note` saying so, since the
 *    column itself declines to write a number there). Passing it over would be
 *    the always-passes hole in its purest form: the emptiest page on the site,
 *    unjudged, because the measurement of it was "nothing".
 *  - the crawl predates migration 0018 and NOTHING on it was measured. Nothing
 *    may be concluded about such a page, and `content.thin-skipped` says so
 *    once for the crawl.
 *
 * A page rule sees one row and cannot tell those apart — which is why this rule
 * is no longer one. The census (`mainFingerprintCensus`) is a question about
 * the CRAWL, and it partitions the two cases exactly: on a crawl where some
 * page carries a fingerprint, a null is the analyzer's answer about that page;
 * on a crawl where none does, a null is the absence of the analyzer.
 *
 * `word_count is not null` is the other guard and it is not redundant: a 200
 * that served a PDF has no analysis and stores null in EVERY text column, which
 * is not a page with no main content — it is a page with no text evidence, and
 * this rule has always been silent about those. `resources.*` and the fetch
 * classification are what speak for them.
 *
 * **A PAGE CANONICALISED ELSEWHERE IS NOT JUDGED** (§1, extended to this rule
 * by §11). A parameter variant that declares the base URL canonical is not a
 * thin page: it is the same page as a full one, said a second way, and the
 * canonical is the fix rather than the fault. Without this filter a site with
 * faceted URLs reports its whole facet space as thin content the day it does
 * the right thing.
 *
 * The listing is capped at `caps.listing`, THINNEST FIRST rather than
 * alphabetically, and the order is a decision about what a cut list should
 * hold: the pages with nothing on them at all are the ones worth the first two
 * hundred rows, and an alphabetical cut would fill them with whatever the site
 * happens to name early. The total beside the note is exact (`count(*) over ()`
 * over the whole match set, evaluated before the limit).
 */
async function thinFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, THIN.id);
  // The gate, for `nearDuplicateFindings`'s reason and with the same predicate:
  // on a crawl with no main-content fingerprint every page's `main_word_count`
  // is null, the query below would call every one of them empty, and every one
  // of those findings would be an invention. `content.thin-skipped` is what
  // speaks there.
  if (mainFingerprintUnavailable(await mainFingerprintCensus(db, crawlId))) return [];
  const result = await db.execute<{
    id: string;
    url: string;
    main_word_count: number | null;
    word_count: number;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.main_word_count, p.word_count,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId} and ${AUDITABLE("p")}
      and not ${CANONICALISED_ELSEWHERE("p")}
      and p.word_count is not null
      and (p.main_word_count is null or p.main_word_count < ${THIN_WORDS})
    order by coalesce(p.main_word_count, 0), p.url
    ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(THIN, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        // Null is "no main-content text at all" on this crawl (the gate above
        // is what makes that reading safe), and zero words is what that is. The
        // note is carried rather than left to the number, because a reader
        // meeting `mainWords: 0` beside `wordCount: 830` should be told the
        // engine measured nothing there rather than counted nothing.
        mainWords: row.main_word_count ?? 0,
        ...(row.main_word_count === null ? { note: "no main-content text at all" } : {}),
        wordCount: row.word_count,
        threshold: THIN_WORDS,
      },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * The NOT MEASURED marker for the crawl `content.thin` cannot be asked of
 * (Phase 19 §11, hard rule 1).
 *
 * Same census, same predicate and same site scope as
 * `content.near-duplicate-skipped` — see that rule for why `bool_or` rather
 * than `count(*) filter`, and for the two crawls the predicate admits. What
 * differs is only which check goes unanswered: the thin-content floor now reads
 * `main_word_count`, so a crawl that never wrote that column has no number to
 * judge a page's own content by, and reading `renderable_word_count` instead
 * would answer the question with a quantity that includes every word of the
 * site's navigation and footer — on the crawl behind this phase, a page with 42
 * words of its own and 940 renderable ones would be reported healthy. That is
 * the silent wrong answer hard rule 7 forbids, in the direction that hides the
 * defect.
 *
 * **IT REPLACES A PAGE-SCOPED MARKER OF THE SAME NAME.** Until §11 this id was
 * a page rule firing on a row with a `word_count` and no
 * `renderable_word_count` — the pre-Phase-7 shape. Every crawl that produced
 * such a row also predates 0018, so those crawls still get this marker; what
 * changed is that it is now one finding for the crawl instead of one per page,
 * and that it also covers a crawl written between Phase 7 and migration 0018,
 * which has renderable counts, no main-content counts, and had nothing to say
 * about it at all.
 */
async function thinSkippedFindings(db: Db, crawlId: string): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, THIN_SKIPPED.id);
  const census = await mainFingerprintCensus(db, crawlId);
  if (!mainFingerprintUnavailable(census)) return [];
  return [
    queryFinding(THIN_SKIPPED, {
      pageId: null,
      pageUrl: null,
      evidence: {
        // The size of what went unjudged, in the word every site-scoped finding
        // publishes this quantity under.
        indexablePages: census.auditable,
        threshold: THIN_WORDS,
      },
      dedupeKey: "site",
    }),
  ];
}

export const contentRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: SOFT_404.id,
    checkIds: ["CHECK-13"],
    category: CATEGORY,
    severity: SOFT_404.severity,
    columns: [
      { key: "signals", label: "Signals" },
      { key: "wordCount", label: "Word Count" },
      { key: "renderableWordCount", label: "Renderable Word Count" },
      { key: "hammingToTemplate", label: "Distance To 404 Template", optional: true },
    ],
    ...copyFor(SOFT_404.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => soft404Findings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: EXACT.id,
    checkIds: ["CHECK-39"],
    category: CATEGORY,
    severity: EXACT.severity,
    columns: [
      { key: "count", label: "Occurrences" },
      { key: "urls", label: "Addresses" },
      { key: "pageTypes", label: "Page Types" },
      { key: "contentHash", label: "Hash" },
    ],
    ...copyFor(EXACT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => exactDuplicateFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: NEAR.id,
    checkIds: ["CHECK-39"],
    category: CATEGORY,
    severity: NEAR.severity,
    columns: [
      { key: "nearDuplicates", label: "No. Near Duplicates" },
      { key: "closest", label: "Closest Near Duplicate Match" },
      { key: "mainWords", label: "Main Content Word Count" },
      { key: "nearDuplicatesAtLeast", label: "Count Is A Floor", optional: true },
    ],
    ...copyFor(NEAR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => nearDuplicateFindings(db, crawlId, capsOr(caps)),
  }),

  // The check above, when the crawl cannot carry it. One site-scoped finding at
  // info severity: what it reports is the boundary of this crawl's evidence,
  // not a fault found on the site. It claims CHECK-39, the check whose
  // near-duplicate half it stands in for — the exact-duplicate half of the same
  // check still runs, on `content_hash`, which every crawl since 0001 has.
  defineRule<QueryRule>({
    kind: "query",
    id: NEAR_SKIPPED.id,
    checkIds: ["CHECK-39"],
    category: CATEGORY,
    severity: NEAR_SKIPPED.severity,
    columns: [
      { key: "indexablePages", label: "Indexable Pages" },
      { key: "minMainWords", label: "Minimum Main Content Word Count" },
    ],
    ...copyFor(NEAR_SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    // The reason states the OBSERVATION, not a cause it cannot establish. The
    // predicate fires on two crawls (see `nearDuplicateSkippedFindings`), and
    // the second — a current crawl on which no page turned out to have main
    // content of its own — was being told it ran before a measurement that in
    // fact ran on it. What is true of both is the census: nothing here carries
    // the fingerprint the comparison needs.
    marker:
      "No page in this crawl has a main-content fingerprint, so near duplicates could not be checked; re-crawl the site.",
    run: (db, crawlId) => nearDuplicateSkippedFindings(db, crawlId),
  }),

  // CHECK-40's floor and CHECK-13's short-page signal, on the words a page has
  // of its own. A QUERY rule since Phase 19 §11 — it was a page rule until the
  // floor moved onto `main_word_count`, whose null a page rule cannot read (see
  // `thinFindings`). Same id, same checks, same severity, same category: what
  // moved is the kind and the column, and both are recorded in the 0.14.0
  // entry of the ruleset log.
  defineRule<QueryRule>({
    kind: "query",
    id: THIN.id,
    checkIds: ["CHECK-40", "CHECK-13"],
    category: CATEGORY,
    severity: THIN.severity,
    columns: [
      { key: "mainWords", label: "Main Content Word Count" },
      { key: "wordCount", label: "Word Count" },
      { key: "threshold", label: "Threshold" },
      { key: "note", label: "Note", optional: true },
    ],
    ...copyFor(THIN.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => thinFindings(db, crawlId, capsOr(caps)),
  }),

  // And the crawl that rule cannot be run on. It claims the same two checks as
  // the rule it stands in for — the `content.thin-skipped` contract, which the
  // resource markers took from here — and it is site-scoped for its twin's
  // reason: the condition is a property of the crawl.
  defineRule<QueryRule>({
    kind: "query",
    id: THIN_SKIPPED.id,
    checkIds: ["CHECK-40", "CHECK-13"],
    category: CATEGORY,
    severity: THIN_SKIPPED.severity,
    columns: [
      { key: "indexablePages", label: "Indexable Pages" },
      { key: "threshold", label: "Threshold" },
    ],
    ...copyFor(THIN_SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    // States the observation, like its twin above: the predicate also admits a
    // current crawl on which no page has main content of its own, and a reason
    // opening "this crawl is old" would assert a cause the census cannot
    // establish.
    marker:
      "No page in this crawl has an own-content word count, so low content could not be checked; re-crawl the site.",
    run: (db, crawlId) => thinSkippedFindings(db, crawlId),
  }),
];

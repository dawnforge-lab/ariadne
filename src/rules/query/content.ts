/**
 * The content rules: what the site's own text says about pages that are not
 * what they claim to be.
 *
 * Three questions, none of which a page rule can answer, because each of them
 * compares a page against something outside it — the site's 404 template
 * (CHECK-13), or another page of the same site (CHECK-39):
 *
 *  - `content.soft-404`     a page that answers 200 and is a missing page
 *  - `content.exact-duplicate`  byte-identical text at more than one URL
 *  - `content.near-duplicate`   main content that differs only in boilerplate
 *
 * …and one NOT MEASURED marker, `content.near-duplicate-skipped`, for the crawl
 * on which the third of them cannot be asked at all (see below).
 *
 * All of them run entirely in SQL over columns the analyzer already wrote
 * (`has_soft404_phrases`, `word_count`, `content_hash`, `simhash`,
 * `main_simhash`, `main_word_count`). Nothing here fetches (hard rule 2),
 * nothing here loads a table into memory (hard rule 3), and no rule re-hashes a
 * page: the fingerprints were computed once, during the single streaming parse.
 *
 * **THE CANONICAL IS READ BY BOTH DUPLICATE RULES** (Phase 19 §1). A page whose
 * declared canonical names another URL has already handed its signals over, and
 * reporting it as a duplicate reports the remedy as the fault — which is what
 * the crawl behind Phase 19 did, twice, at critical severity. Both rules
 * therefore filter with `CANONICALISED_ELSEWHERE`, the string-level SQL form of
 * `isCanonicalisedElsewhere`, stated once in src/rules/helpers.ts and used from
 * here rather than restated. `content.soft-404` does NOT: a page that is a
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
import { createHash } from "node:crypto";

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
  noteAtLeastTruncation,
  noteTruncation,
  readCrawlEvidence,
  readNotFoundProbe,
  type NotFoundProbeReading,
} from "./crawl-evidence.js";

/**
 * The near-duplicate PAIR budget, re-exported beside the threshold it belongs
 * with. It is DEFINED in crawl-evidence.ts, with `URL_FINDING_CAP` and the
 * `findingCap` config that now moves both — one place where the cap doctrine
 * lives, rather than two constants that could drift apart.
 */
export { NEAR_DUPLICATE_PAIR_CAP } from "./crawl-evidence.js";

const CATEGORY = "content" as const;

const SOFT_404: RuleIdentity = { id: "content.soft-404", severity: "critical" };
const EXACT: RuleIdentity = { id: "content.exact-duplicate", severity: "critical" };
const NEAR: RuleIdentity = { id: "content.near-duplicate", severity: "warning" };
const NEAR_SKIPPED: RuleIdentity = {
  id: "content.near-duplicate-skipped",
  severity: "info",
};

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
 * real problem and they have a rule: `content.thin` reports them, at a floor of
 * 150 words a reader can reach. Reporting them a second time as duplicates of
 * one another says nothing new and buries the pairs that are.
 *
 * It sits BELOW `THIN_WORDS` on purpose, and the gap is the point: a page
 * between 50 and 150 main words is thin AND can still be shown to be a copy of
 * another page, which is a sharper finding than either alone. Only below fifty
 * does the fingerprint stop carrying enough of the page to compare.
 */
export const NEAR_DUPLICATE_MIN_MAIN_WORDS = 50;

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

/** The stable identity of an unordered pair of URLs. */
function pairKey(urlA: string, urlB: string): string {
  // Hashed rather than concatenated: a dedupe key is a column, two URLs can run
  // to a couple of kilobytes together, and the pair's identity is all that is
  // needed. Sorted first, so the same two pages produce the same key whichever
  // side of the join they landed on.
  return createHash("sha256").update(`${urlA}\n${urlB}`).digest("hex");
}

/** What the gate query below reads, so the rule and its marker share one shape. */
interface MainFingerprintCensus {
  /** Pages `content.near-duplicate` would consider at all: auditable, indexable. */
  auditable: number;
  /** Whether ANY of them carries a `main_simhash`. */
  anyMainSimhash: boolean;
}

async function mainFingerprintCensus(db: Db, crawlId: string): Promise<MainFingerprintCensus> {
  // `bool_or` over the same population the pair join starts from, so the gate
  // and the rule can never disagree about which pages were in scope. Over zero
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
  if (row === undefined) throw new Error(`${NEAR.id}: the main-fingerprint census returned no row`);
  return { auditable: Number(row.auditable), anyMainSimhash: row.any_main ?? false };
}

/**
 * Whether `content.near-duplicate` can be asked of this crawl at all: false when
 * it can, true when `content.near-duplicate-skipped` is the answer instead.
 *
 * ONE PREDICATE, READ BY BOTH, so the rule's silence and the marker's sentence
 * are the same decision rather than two that happen to agree.
 */
async function mainFingerprintUnavailable(db: Db, crawlId: string): Promise<boolean> {
  const census = await mainFingerprintCensus(db, crawlId);
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
 * property of the crawl (`content.thin-skipped`'s condition is a property of a
 * ROW, which is why that one is a page rule and this one is not), and a
 * pre-0018 crawl of fifty thousand pages would otherwise write fifty thousand
 * copies of one sentence.
 */
async function nearDuplicateSkippedFindings(db: Db, crawlId: string): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, NEAR_SKIPPED.id);
  const census = await mainFingerprintCensus(db, crawlId);
  if (census.auditable === 0 || census.anyMainSimhash) return [];
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
 * Pairs of indexable 200 pages whose MAIN-CONTENT fingerprints are within
 * `NEAR_DUPLICATE_HAMMING` bits of each other (CHECK-39).
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
 * inside `<main>`, or over the body with `<nav>`, `<header>`, `<footer>` and
 * `<aside>` removed when there is no `<main>` (see page-analyzer.ts).
 *
 * **THE PAGE MUST HAVE CONTENT OF ITS OWN.** Both sides need
 * `main_word_count >= NEAR_DUPLICATE_MIN_MAIN_WORDS`, for the reason written on
 * that constant: below it the fingerprint is a handful of tokens and every
 * near-empty page on a template is a near-duplicate of every other one.
 * `content.thin` is the rule those pages belong to.
 *
 * **AND NEITHER SIDE MAY BE CANONICALISED ELSEWHERE** (§1) — a parameter
 * variant that points at its base URL is the fix, not the fault. The filter is
 * on both sides of the join, so one canonicalised member removes the pair
 * rather than half of it.
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
 * reported twice, once by each rule, with two different fixes attached.
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
 * side, and that is what the test catches.
 *
 * **What this costs.** Measured on `simhash` while its own indexes covered it,
 * and quoted unchanged because the arithmetic did not change — only which
 * column it runs over, and 0019 gave the new column the same four bands. With
 * the indexes, 5,000 pages measured ~0.11s on a fresh table, against ~2.9s
 * without them as a quadratic nested loop. Two caveats that belong in the 50k
 * gate's expectations rather than in a footnote:
 *  - expression indexes have no statistics until the table is ANALYZEd, and the
 *    planner will not choose a plan it cannot cost. A freshly loaded `pages` is
 *    exactly that table, so a gate crawl that runs the rules immediately after
 *    writing 50,000 rows should ANALYZE first or expect the planner to guess.
 *  - 0.11s is the HEALTHY site, whose band values are spread. Band skew — a few
 *    thousand templated pages sharing a band value — measured ~521ms: bounded,
 *    because the `LIMIT` still stops the scan, but not closed.
 *
 * One finding per PAIR, capped at `caps.nearDuplicatePairs`. The note on a
 * truncated list says `atLeast`, not a total — and that word is the honest one:
 * counting every pair means computing the whole quadratic join, which is
 * precisely what the cap exists to avoid. For the same reason the query has no
 * ORDER BY (ordering would also force the full join), so which pairs are
 * reported past the cap is not defined — only that they are real pairs.
 *
 * **THE PAIR BUDGET FOLLOWS `findingCap`** (P8-T4), and this is the rule where
 * removing the cap costs the most: uncapped, the `limit` that stops the banding
 * join stops nothing, and the query runs to completion over every candidate pair
 * the four bands admit. That is the price of the honest answer — an audit that
 * says "at least 501 near-duplicate pairs" cannot tell a client whether the real
 * number is 502 or 40,000 — and it is the reason the number is a knob rather
 * than a new default.
 *
 * **AND THE SCAN THEREFORE HAS A CEILING `findingCap` CANNOT LIFT** — see
 * `NEAR_DUPLICATE_PAIR_CEILING`. It is not prudence, it is hard rule 6: without
 * it an uncapped run over a degenerate site puts the process past the 512MB
 * memory contract at 2,000 pages and exhausts a 4GB heap at 20,000. The ceiling
 * restores the contract; `findingCap` governs the REPORTING cap below it.
 *
 * The threshold (`NEAR_DUPLICATE_HAMMING`, 3 bits) is NOT part of the knob and
 * does not move with it: it defines what a near-duplicate IS, and widening it
 * would change the finding rather than the size of the list.
 */
async function nearDuplicateFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  // THE TWO LIMITS, RESOLVED INTO ONE.
  //
  // `caps.nearDuplicatePairs` is what the operator asked to have LISTED, and
  // `caps.nearDuplicatePairCeiling` is what this process can hold. The scan runs
  // to the smaller of them, so an uncapped run is uncapped up to the ceiling and
  // capped by it beyond — which is exactly what a run that hits the ceiling then
  // says out loud, because the honest `atLeast` note is written either way.
  //
  // `+ 1` is what makes that note honest: seeing one more pair than may be listed
  // is how the rule knows there ARE more without counting them. There is no case
  // left where the scan is unbounded, so there is no case where the absence of a
  // note is a guess.
  const pairs =
    caps.nearDuplicatePairs === null
      ? caps.nearDuplicatePairCeiling
      : Math.min(caps.nearDuplicatePairs, caps.nearDuplicatePairCeiling);
  await readCrawlEvidence(db, crawlId, NEAR.id);
  // THE GATE, ASKED BEFORE THE JOIN. On a crawl with no main-content
  // fingerprint at all the query below would return nothing anyway — every
  // candidate is dropped by `main_simhash is not null` — and an empty result is
  // exactly what must not be reported as "no near-duplicates" (hard rule 1).
  // `content.near-duplicate-skipped` is what says so; this rule returns early
  // so that the two never disagree, and so that a crawl the check cannot be run
  // on does not pay for a scan whose answer is already known.
  if (await mainFingerprintUnavailable(db, crawlId)) return [];
  const result = await db.execute<{
    id_a: string;
    url_a: string;
    type_a: string | null;
    main_words_a: number;
    id_b: string;
    url_b: string;
    type_b: string | null;
    main_words_b: number;
    hamming: number;
  }>(sql`
    select a.id as id_a, a.url as url_a, a.page_type as type_a,
           a.main_word_count as main_words_a,
           b.id as id_b, b.url as url_b, b.page_type as type_b,
           b.main_word_count as main_words_b,
           bit_count((a.main_simhash # b.main_simhash)::bit(64))::int as hamming
    from pages a
    join pages b on b.crawl_id = a.crawl_id and a.id < b.id
      and a.content_hash is distinct from b.content_hash
      and ( (a.main_simhash >> 0)  & 65535 = (b.main_simhash >> 0)  & 65535
         or (a.main_simhash >> 16) & 65535 = (b.main_simhash >> 16) & 65535
         or (a.main_simhash >> 32) & 65535 = (b.main_simhash >> 32) & 65535
         or (a.main_simhash >> 48) & 65535 = (b.main_simhash >> 48) & 65535 )
    where a.crawl_id = ${crawlId} and ${AUDITABLE("a")} and ${AUDITABLE("b")}
      and not ${CANONICALISED_ELSEWHERE("a")} and not ${CANONICALISED_ELSEWHERE("b")}
      and a.main_simhash is not null and b.main_simhash is not null
      and a.main_word_count >= ${NEAR_DUPLICATE_MIN_MAIN_WORDS}
      and b.main_word_count >= ${NEAR_DUPLICATE_MIN_MAIN_WORDS}
      and bit_count((a.main_simhash # b.main_simhash)::bit(64)) <= ${NEAR_DUPLICATE_HAMMING}
    ${limitTo(pairs + 1)}`);

  const findings = result.rows.slice(0, pairs).map((row) => {
    // The join orders the pair by row id, which says nothing to a reader. The
    // finding is stated in URL order instead, and the page type and the main
    // word count travel with their own URL rather than with a side of the join.
    const left = { id: row.id_a, url: row.url_a, type: row.type_a, words: row.main_words_a };
    const right = { id: row.id_b, url: row.url_b, type: row.type_b, words: row.main_words_b };
    // Two rows of one crawl cannot share a URL (`pages_crawl_url` is unique),
    // so the two sides never compare equal and the order is total.
    const [first, second] = row.url_a < row.url_b ? [left, right] : [right, left];
    return queryFinding(NEAR, {
      pageId: first.id,
      pageUrl: first.url,
      evidence: {
        urlA: first.url,
        urlB: second.url,
        hamming: row.hamming,
        pageTypeA: first.type,
        pageTypeB: second.type,
        // How much content each page has of its own — the quantity the distance
        // was measured over. Two pages at 60 main words apiece agreeing to
        // within three bits is a weaker claim than two at 800, and a reader
        // deciding whether to consolidate them needs to see which one this is.
        mainWordsA: first.words,
        mainWordsB: second.words,
      },
      dedupeKey: pairKey(first.url, second.url),
    });
  });

  // `rows.length` is the number of pairs the query SAW — `cap + 1` when the
  // limit cut it — which is exactly the lower bound this note may claim. The
  // other two rules in this file hand `noteTruncation` an exact `count(*)`.
  //
  // Below the ceiling and inside the reporting cap, `rows.length` and
  // `findings.length` are the same number and `noteAtLeastTruncation` writes
  // nothing — the listing was not truncated, and the absence of the note is what
  // tells a reader the list is the whole of it. The contrapositive is the
  // load-bearing half and it holds at every setting including uncapped: a note
  // means the list is incomplete, and only its absence means complete. An
  // uncapped run that hits the ceiling therefore carries one.
  return noteAtLeastTruncation(findings, result.rows.length);
}

export const contentRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: SOFT_404.id,
    checkIds: ["CHECK-13"],
    category: CATEGORY,
    severity: SOFT_404.severity,
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
    ...copyFor(NEAR_SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "This crawl ran before the engine measured each page's main content separately, so " +
      "pages could not be compared for near-duplicate content; re-crawl the site to measure them.",
    run: (db, crawlId) => nearDuplicateSkippedFindings(db, crawlId),
  }),
];

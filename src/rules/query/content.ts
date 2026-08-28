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
 *  - `content.near-duplicate`   text that differs only in boilerplate
 *
 * All three run entirely in SQL over columns the analyzer already wrote
 * (`has_soft404_phrases`, `word_count`, `content_hash`, `simhash`). Nothing
 * here fetches (hard rule 2), nothing here loads a table into memory (hard
 * rule 3), and no rule re-hashes a page: the fingerprints were computed once,
 * during the single streaming parse.
 *
 * **The signed-bigint contract.** `simhash64` produces a value in the unsigned
 * 64-bit range; `pages.simhash` is a signed Postgres bigint and `PageWriter`
 * stores `BigInt.asIntN(64, …)`. Every comparison below runs on that signed
 * value, and that is safe because both operations used are representation-level
 * rather than arithmetic: `#` XORs the two's-complement bit patterns, and
 * `bit_count(…::bit(64))` counts set bits in them. The stored 404 template
 * arrives in the same signed spelling (`NotFoundProbeSample.simhash`), so no
 * conversion happens anywhere between the analyzer and the comparison.
 */
import { createHash } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import {
  noteAtLeastTruncation,
  noteTruncation,
  readCrawlEvidence,
  readNotFoundProbe,
  URL_FINDING_CAP,
  type NotFoundProbeReading,
} from "./crawl-evidence.js";

const CATEGORY = "content" as const;

const SOFT_404: RuleIdentity = { id: "content.soft-404", severity: "warning" };
const EXACT: RuleIdentity = { id: "content.exact-duplicate", severity: "warning" };
const NEAR: RuleIdentity = { id: "content.near-duplicate", severity: "warning" };

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
 * Pairs reported by `content.near-duplicate` before it stops listing.
 *
 * Pairs, not pages, and that is the reason for a cap of its own: a site with a
 * thousand templated near-identical pages has half a million pairs, and a
 * findings table is not the place to enumerate them. See `nearDuplicateFindings`
 * for what the truncation note can and cannot say about the rest.
 */
export const NEAR_DUPLICATE_PAIR_CAP = 500;

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
async function soft404Findings(db: Db, crawlId: string): Promise<Finding[]> {
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
    limit ${URL_FINDING_CAP}`);

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
 * **THE CAP COMES BEFORE THE LATERAL.** A `cross join lateral` under an
 * `order by`/`limit` at the same query level is evaluated for every row the FROM
 * produces — the limit cannot apply until the rows exist — so the twenty-URL
 * lookup ran once per GROUP rather than once per reported group, and a
 * templated site with thousands of duplicate groups paid minutes for it. The
 * `capped` CTE takes the exact `count(*) over ()` total (a window is evaluated
 * over the whole CTE before its own `order by`/`limit`, so it counts every
 * group) and cuts to `URL_FINDING_CAP` first; the lateral then runs against at
 * most two hundred rows. Semantics are untouched — same group order, same
 * carrier, same totals — and the same restructure is in
 * src/rules/query/field-duplicates.ts, which took this shape from here.
 */
async function exactDuplicateFindings(db: Db, crawlId: string): Promise<Finding[]> {
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
      group by p.content_hash
      having count(*) > 1
    ),
    capped as (
      select d.content_hash, d.page_count, d.page_types,
             count(*) over ()::int as total_matches
      from dupes d
      order by d.content_hash
      limit ${URL_FINDING_CAP}
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

/**
 * Pairs of indexable 200 pages whose simhashes are within
 * `NEAR_DUPLICATE_HAMMING` bits of each other (CHECK-39).
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
 * expression indexes `pages_simhash_band0..3`** (migration 0004; declared in
 * src/db/schema.ts, where the same warning is written from the other side).
 * Postgres matches an expression index by comparing parse trees, so band 0 must
 * keep saying `(a.simhash >> 0) & 65535` — `int8shr(x, 0)` is not folded away,
 * and an index on a simpler spelling would not match it. And a single arm that
 * fails to match takes the WHOLE BitmapOr with it, because Postgres will not use
 * indexes for an OR unless every branch is indexable. That failure is silent: a
 * slow query, not an error. Change a band here, change its index there, and
 * confirm with EXPLAIN that all four `Bitmap Index Scan`s are still in the plan.
 *
 * **What this costs.** With the indexes, 5,000 pages measured ~0.11s on a fresh
 * table (against ~2.9s without them, as a quadratic nested loop). Two caveats
 * that belong in the 50k gate's expectations rather than in a footnote:
 *  - expression indexes have no statistics until the table is ANALYZEd, and the
 *    planner will not choose a plan it cannot cost. A freshly loaded `pages` is
 *    exactly that table, so a gate crawl that runs the rules immediately after
 *    writing 50,000 rows should ANALYZE first or expect the planner to guess.
 *  - 0.11s is the HEALTHY site, whose band values are spread. Band skew — a few
 *    thousand templated pages sharing a band value — measured ~521ms: bounded,
 *    because the `LIMIT` still stops the scan, but not closed.
 *
 * One finding per PAIR, capped at `NEAR_DUPLICATE_PAIR_CAP`. The note on a
 * truncated list says `atLeast`, not a total — and that word is the honest one:
 * counting every pair means computing the whole quadratic join, which is
 * precisely what the cap exists to avoid. For the same reason the query has no
 * ORDER BY (ordering would also force the full join), so which pairs are
 * reported past the cap is not defined — only that they are real pairs.
 */
async function nearDuplicateFindings(db: Db, crawlId: string): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, NEAR.id);
  const result = await db.execute<{
    id_a: string;
    url_a: string;
    type_a: string | null;
    id_b: string;
    url_b: string;
    type_b: string | null;
    hamming: number;
  }>(sql`
    select a.id as id_a, a.url as url_a, a.page_type as type_a,
           b.id as id_b, b.url as url_b, b.page_type as type_b,
           bit_count((a.simhash # b.simhash)::bit(64))::int as hamming
    from pages a
    join pages b on b.crawl_id = a.crawl_id and a.id < b.id
      and a.content_hash is distinct from b.content_hash
      and ( (a.simhash >> 0)  & 65535 = (b.simhash >> 0)  & 65535
         or (a.simhash >> 16) & 65535 = (b.simhash >> 16) & 65535
         or (a.simhash >> 32) & 65535 = (b.simhash >> 32) & 65535
         or (a.simhash >> 48) & 65535 = (b.simhash >> 48) & 65535 )
    where a.crawl_id = ${crawlId} and ${AUDITABLE("a")} and ${AUDITABLE("b")}
      and a.simhash is not null and b.simhash is not null
      and bit_count((a.simhash # b.simhash)::bit(64)) <= ${NEAR_DUPLICATE_HAMMING}
    limit ${NEAR_DUPLICATE_PAIR_CAP + 1}`);

  const findings = result.rows.slice(0, NEAR_DUPLICATE_PAIR_CAP).map((row) => {
    // The join orders the pair by row id, which says nothing to a reader. The
    // finding is stated in URL order instead, and the page type travels with
    // its own URL rather than with its side of the join.
    const left = { id: row.id_a, url: row.url_a, type: row.type_a };
    const right = { id: row.id_b, url: row.url_b, type: row.type_b };
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
      },
      dedupeKey: pairKey(first.url, second.url),
    });
  });

  // `rows.length` is the number of pairs the query SAW — `cap + 1` when the
  // limit cut it — which is exactly the lower bound this note may claim. The
  // other two rules in this file hand `noteTruncation` an exact `count(*)`.
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
    run: (db, crawlId) => soft404Findings(db, crawlId),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: EXACT.id,
    checkIds: ["CHECK-39"],
    category: CATEGORY,
    severity: EXACT.severity,
    ...copyFor(EXACT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => exactDuplicateFindings(db, crawlId),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: NEAR.id,
    checkIds: ["CHECK-39"],
    category: CATEGORY,
    severity: NEAR.severity,
    ...copyFor(NEAR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => nearDuplicateFindings(db, crawlId),
  }),
];

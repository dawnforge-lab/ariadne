/**
 * The render diff rules: what a browser saw that the raw HTML never said.
 *
 * Three questions, each of them a comparison between the two passes this engine
 * makes over a page — the streaming tokenizer's reading of the bytes the server
 * sent, and the counts the render pass measured in a real DOM after the page's
 * JavaScript had run:
 *
 *  - `content.csr-dependent`  the words are not in the HTML (CHECK-01)
 *  - `nav.js-only`            the navigation is not in the HTML (CHECK-34)
 *  - `filters.js-only`        the faceted links are not in the HTML (CHECK-02)
 *
 * **A page that was not rendered is NOT AUDITED by any of them, and that is not
 * the same as passing.** The render pass runs over a budgeted selection
 * (src/crawl/render/select.ts), so most pages of a large crawl have `rendered =
 * false` and every `rendered_*` column null. A rule that read those nulls as
 * zeroes would report "the raw HTML holds everything" about a page nobody
 * looked at — the always-passes defect of hard rule 1 wearing a diff's clothes.
 * Every query below therefore opens with `p.rendered = true`, and how much of
 * the crawl that covers is `render.coverage`'s subject
 * (src/rules/metric/render-metrics.ts), not something inferred from a silence.
 *
 * **A rendered page with a null count column throws** — see
 * `assertRenderedColumns`. That combination is not a page, it is a defect in
 * whatever wrote the row.
 *
 * Everything here is SQL over `pages` and (for the filter rule) `links`.
 * Nothing fetches (hard rule 2), nothing loads the link table into memory
 * (hard rule 3), and nothing re-reads a page's HTML: both sides of every
 * comparison were counted once, by the pass that produced them.
 */
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
import { assertCrawl, noteTruncation, URL_FINDING_CAP } from "./crawl-evidence.js";

const CSR: RuleIdentity = { id: "content.csr-dependent", severity: "critical" };
const NAV: RuleIdentity = { id: "nav.js-only", severity: "critical" };
const FILTERS: RuleIdentity = { id: "filters.js-only", severity: "warning" };

/**
 * How many times the raw word count the rendered one must reach before the page
 * counts as client-side rendered.
 *
 * Doubling, rather than "more words after rendering": every page gains a few
 * words in a browser — a cookie banner, a live search box, a lazily inserted
 * breadcrumb — and a rule that fired on those would fire on every page of every
 * modern site. Twice the text is a different claim: most of what the page says
 * was not in the HTML.
 */
export const CSR_WORD_MULTIPLE = 2;

/**
 * …and the absolute floor beneath the ratio, in words.
 *
 * The ratio alone is unusable at the small end: an eight-word shell that
 * renders sixteen words has doubled and is still a page with nothing on it,
 * while `2 × 0` is satisfied by any page at all. 150 words is roughly a short
 * paragraph of real body copy — enough that "the content arrives with the
 * JavaScript" is a statement about the page's substance rather than about its
 * furniture. Both conditions must hold.
 */
export const CSR_MIN_ADDED_WORDS = 150;

/**
 * Raw nav + footer links BELOW this and the page's navigation is, as far as the
 * HTML says, not there. Exclusive: a page with exactly five is not reported.
 */
export const NAV_RAW_MAX = 5;

/** …and rendered nav + footer links AT OR ABOVE this is a real navigation. */
export const NAV_RENDERED_MIN = 10;

/** …and the ratio between the two sides. See `navJsOnlyFindings` for the margin. */
export const NAV_RENDERED_MULTIPLE = 2;

/**
 * Filter-looking links a rendered page must expose before a raw side of zero is
 * worth reporting. Five is a facet block; one or two is a sort control, which is
 * not the crawl-budget story CHECK-02 asks about.
 */
export const FILTER_RENDERED_MIN = 5;

/**
 * Refuse a crawl holding a page that says `rendered = true` and stores no count.
 *
 * THE RULING THIS ENCODES: a rendered page whose `rendered_*` extraction columns
 * are null is a renderer-writer bug surfacing, and it is neither skipped nor read
 * as zero. The render pass writes `rendered = true` together with all five
 * counts, or it writes `rendered = false` with a `render_error` and no counts
 * (see `RenderResult` in src/crawl/render/renderer.ts) — there is no third shape,
 * so a row in one would mean the writer and this reader disagree about what a
 * rendered page is.
 *
 * Why it cannot be left alone: SQL is what makes the failure silent. Every
 * comparison below is arithmetic, `null >= 2 * null` is NULL, and a WHERE clause
 * drops a NULL row exactly as it drops a false one. The page would be excluded
 * from the finding query and included in nothing else — audited by no rule, and
 * counted as clean by every reader downstream. Validate, don't cast (hard rule
 * 7); the message names the page and the columns.
 *
 * `columns` is what THIS rule reads, not every render column: the crawl-evidence
 * discipline (each rule validates its own inputs, so a blob or a column it never
 * looks at cannot make it throw). `content.csr-dependent` also passes the RAW
 * `renderable_word_count` through here, because its comparison has two sides and
 * a null on either one loses the page the same way: an ok/200 HTML page crawled
 * by this version of the engine always carries one (`PageWriter` writes it with
 * `word_count`, off the same pass).
 *
 * ONE OF THE TWO NULLS IS NOT A WRITER DEFECT, and the message says so. A crawl
 * that predates Phase 7 has `renderable_word_count` null on EVERY row, because
 * the analyzer that wrote them did not compute it. That crawl cannot be re-judged
 * — the count is taken while the HTML is being read and the HTML is not stored —
 * so the rule refuses the whole crawl loudly rather than comparing a rendered
 * count against a raw one that measures a different thing (hard rule 7). The
 * page-rule side of the same problem is `content.thin-skipped`, which can skip
 * page by page because it judges one row at a time.
 */
async function assertRenderedColumns(
  db: Db,
  crawlId: string,
  ruleId: string,
  columns: readonly string[],
): Promise<void> {
  // Every string interpolated raw below is a literal from this file — never a
  // value from the database or from a caller outside it.
  const missing: SQL[] = columns.map((c) => sql.raw(`case when p.${c} is null then '${c}' end`));
  const anyNull: SQL[] = columns.map((c) => sql.raw(`p.${c} is null`));

  const res = await db.execute<{ url: string; missing: string[] }>(sql`
    select p.url,
           array_remove(array[${sql.join(missing, sql`, `)}], null) as missing
    from pages p
    where p.crawl_id = ${crawlId}
      and p.rendered = true
      and (${sql.join(anyNull, sql` or `)})
    order by p.url
    limit 1`);

  const row = res.rows[0];
  if (row === undefined) return;
  throw new Error(
    `${ruleId}: page '${row.url}' is marked rendered but stores no ` +
      `${row.missing.join(", ")} — the render pass writes every count column together ` +
      "with `rendered`, so this row is a writer defect rather than a page with nothing " +
      "on it. The comparison this rule makes has no side to make it from, and a row " +
      "dropped for a null would be a page no rule audited and every reader took for clean" +
      " (a missing `renderable_word_count` on every row means something else: a crawl " +
      "from before that column existed, which cannot be re-judged and has to be crawled " +
      "again)",
  );
}

/**
 * Pages whose text arrives with the JavaScript (CHECK-01).
 *
 * Fires when BOTH hold, on a page the render pass actually measured:
 *
 *   rendered_word_count >= CSR_WORD_MULTIPLE * greatest(renderable_word_count, 1)
 *   rendered_word_count - renderable_word_count >= CSR_MIN_ADDED_WORDS
 *
 * **THE RAW SIDE IS `renderable_word_count`, NOT `word_count` (Phase 7).** The
 * two sides of a subtraction have to be answers to the same question, and they
 * were not: the rendered side is `innerText`, which is what a reader sees, while
 * `word_count` includes every word the markup hides. On the site that provoked
 * the change that gap was ~740 words of drawer, picker and accordion on every
 * page, which made the raw side larger than the rendered one everywhere and
 * could mask a genuinely client-rendered page — a FALSE NEGATIVE, silent by
 * construction. `renderable_word_count` removes what the markup itself hides, so
 * what remains between the two sides is CSS-hidden text and JavaScript-injected
 * text, which is what this rule is about.
 *
 * The thresholds are unchanged. They were derived against a raw side that was
 * inflated, so on a chrome-heavy site the corrected column can only make this
 * rule MORE willing to fire — which is the direction the diagnosis says it was
 * wrong in.
 *
 * `greatest(renderable_word_count, 1)` is the divide-by-nothing guard, and
 * Postgres' `greatest` is the right function for it precisely because it IGNORES
 * nulls — but no null reaches it: `assertRenderedColumns` has already refused a
 * rendered page with no raw count, so the 1 stands in only for a genuine zero. A
 * shell that served no words at all and rendered 150 is the archetype of this
 * finding, and without the guard its ratio arm would be `150 >= 0`, true for
 * every page including the ones that render nothing.
 *
 * Hand-derived boundaries (the test pins each of these):
 *   renderable 100, rendered 250 → 250 ≥ 200 and 150 ≥ 150 — FIRES, both arms exactly at
 *   renderable 100, rendered 249 → 249 ≥ 200 but 149 < 150 — silent on the floor
 *   renderable 200, rendered 399 → 199 ≥ 150 but 399 < 400 — silent on the ratio
 *   renderable 0,   rendered 150 → 150 ≥ 2·1 and 150 ≥ 150 — FIRES (the empty shell)
 *
 * The evidence carries both counts and the difference rather than a ratio: an
 * action plan quotes "this page's HTML holds 12 of its 840 words", and a
 * multiplier computed here would be a second number saying the same thing with
 * rounding of its own.
 */
async function csrDependentFindings(db: Db, crawlId: string): Promise<Finding[]> {
  // A crawl id nothing knows scans no pages, which reads exactly like a site
  // with no CSR problem (`runRules`' precedent, hard rule 7).
  await assertCrawl(db, crawlId, CSR.id);
  await assertRenderedColumns(db, crawlId, CSR.id, [
    "renderable_word_count",
    "rendered_word_count",
  ]);

  const res = await db.execute<{
    id: string;
    url: string;
    word_count: number | null;
    renderable_word_count: number;
    rendered_word_count: number;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.word_count, p.renderable_word_count, p.rendered_word_count,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId}
      and p.rendered = true
      and p.rendered_word_count >= ${CSR_WORD_MULTIPLE} * greatest(p.renderable_word_count, 1)
      and p.rendered_word_count - p.renderable_word_count >= ${CSR_MIN_ADDED_WORDS}
    order by p.url
    limit ${URL_FINDING_CAP}`);

  const findings = res.rows.map((row) =>
    queryFinding(CSR, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        // Both raw numbers travel: `rawWordCount` is every word the HTML
        // carried and `renderableWordCount` is the subset the markup does not
        // hide, which is the one the arithmetic below is done in. A reader who
        // saw only the second could not tell a shell from a page whose copy is
        // merely folded away.
        rawWordCount: row.word_count,
        renderableWordCount: row.renderable_word_count,
        renderedWordCount: row.rendered_word_count,
        addedWords: row.rendered_word_count - row.renderable_word_count,
      },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, res.rows[0]?.total_matches ?? 0);
}

/**
 * Pages whose navigation exists only after JavaScript runs (CHECK-34).
 *
 * `raw` is `nav_link_count + footer_link_count` (both NOT NULL, both written by
 * the analyzer's single pass); `rendered` is the same sum of the two rendered
 * columns. Fires when all three hold:
 *
 *   raw < NAV_RAW_MAX                              (the HTML shows no navigation)
 *   rendered >= NAV_RENDERED_MIN                   (the browser shows a real one)
 *   rendered >= NAV_RENDERED_MULTIPLE * (raw + 1)  (and it is not a small delta)
 *
 * **THE MARGIN, which is the whole reason this rule can exist at all.** The raw
 * side carries a known ONE-DIRECTIONAL UNDERCOUNT: an `<a href>` left unclosed
 * across a `<nav>` or `<footer>` boundary is reconstructed INSIDE the container
 * by a browser's tree builder (the adoption agency algorithm), so the rendered
 * DOM holds one anchor per such tag that the raw byte stream never contained. A
 * streaming tokenizer cannot see it without being a DOM (hard rule 4). The
 * divergence is pinned by a named test in
 * src/crawl/parse/page-analyzer.upstream.test.ts and stated at the
 * `nav_link_count` column comment; the error is at most −1 per unclosed anchor
 * and never positive.
 *
 * So the threshold is a MARGIN, not a literal, and the margin is worth
 * computing rather than asserting. Write `k` for the number of unclosed anchors
 * and `r` for what the tokenizer counted; a page with NO JavaScript navigation
 * at all then renders `r + k`. For it to be reported falsely, all three
 * conditions must hold on those numbers:
 *
 *   r < 5,   r + k >= 10,   r + k >= 2(r + 1)  ⇔  k >= r + 2
 *
 * so the smallest malformed-HTML page this rule can misread needs
 * `k >= max(r + 2, 10 − r)`, which over r = 0…4 is k >= 10, 9, 8, 7, 6. **Six
 * unclosed anchors is the cheapest false positive available**, against a
 * realistic floor of two or three in hand-written or CMS-mangled markup — a
 * factor of two to five of headroom, and every one of those six would have to
 * sit in the nav or the footer of the same page.
 *
 * **The third condition is currently implied by the first two**, and is kept
 * deliberately. Over the integers admitted by `raw < 5`, `2(raw + 1)` peaks at
 * 10 — exactly `NAV_RENDERED_MIN` — so no page passes conditions 1 and 2 and
 * fails 3. It is the scale-invariant statement of the claim the copy makes ("the
 * rendered navigation is several times what the HTML holds"), so it is what
 * keeps the rule honest if either threshold ever moves; the test pins the
 * coincidence at raw 4 rather than leaving it as arithmetic nobody re-checks.
 *
 * Hand-derived boundaries (each pinned by the test):
 *   raw 4  (4+0), rendered 10 (10+0) → all three exactly at — FIRES
 *   raw 4,        rendered 9         → 9 < 10 — silent
 *   raw 5  (3+2), rendered 20        → 5 not < 5 — silent
 *   raw 0,        rendered 10        → FIRES (the empty shell's navigation)
 */
async function navJsOnlyFindings(db: Db, crawlId: string): Promise<Finding[]> {
  await assertCrawl(db, crawlId, NAV.id);
  await assertRenderedColumns(db, crawlId, NAV.id, [
    "rendered_nav_link_count",
    "rendered_footer_link_count",
  ]);

  // The two sums, spelled once as CTE columns rather than four times in the
  // predicate: the rule is about the pair, and a condition that restated the
  // addition could drift from the one the evidence quotes.
  const res = await db.execute<{
    id: string;
    url: string;
    nav_link_count: number;
    footer_link_count: number;
    rendered_nav_link_count: number;
    rendered_footer_link_count: number;
    raw_links: number;
    rendered_links: number;
    total_matches: number;
  }>(sql`
    with measured as (
      select p.id, p.url,
             p.nav_link_count, p.footer_link_count,
             p.rendered_nav_link_count, p.rendered_footer_link_count,
             p.nav_link_count + p.footer_link_count as raw_links,
             p.rendered_nav_link_count + p.rendered_footer_link_count as rendered_links
      from pages p
      where p.crawl_id = ${crawlId} and p.rendered = true
    )
    select m.*, count(*) over ()::int as total_matches
    from measured m
    where m.raw_links < ${NAV_RAW_MAX}
      and m.rendered_links >= ${NAV_RENDERED_MIN}
      and m.rendered_links >= ${NAV_RENDERED_MULTIPLE} * (m.raw_links + 1)
    order by m.url
    limit ${URL_FINDING_CAP}`);

  const findings = res.rows.map((row) =>
    queryFinding(NAV, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        rawNavLinks: row.nav_link_count,
        rawFooterLinks: row.footer_link_count,
        rawLinks: row.raw_links,
        renderedNavLinks: row.rendered_nav_link_count,
        renderedFooterLinks: row.rendered_footer_link_count,
        renderedLinks: row.rendered_links,
      },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, res.rows[0]?.total_matches ?? 0);
}

/**
 * Pages whose faceted navigation exists only after JavaScript runs (CHECK-02).
 *
 * Fires when the page's RAW filter links are zero and the rendered DOM exposed
 * at least `FILTER_RENDERED_MIN` of them. Zero on the raw side rather than a
 * threshold, because the claim is categorical: the crawler found no way at all
 * into this page's facets, so every URL behind them is invisible to a crawl that
 * does not run JavaScript — which is the crawl-budget and discoverability
 * question CHECK-02 asks.
 *
 * **THE PREDICATE IS SPELLED IN TWO PLACES AND MUST STAY IDENTICAL.** The
 * rendered side was counted in the browser by `MEASURE_SCRIPT`
 * (src/crawl/render/renderer.ts, whose comment points back at this rule): an
 * anchor is a filter link when its resolved href contains `?` OR matches
 * /filter|facet|sort/i. The raw side below asks exactly that of
 * `links.target_url`. Change one and the rule compares two different questions
 * and fires on the difference between them.
 *
 * **THE OPERANDS ARE NOT THE SAME SET, and that is stated rather than glossed.**
 * The DOM side counts EVERY `a[href]` on the page, `mailto:`, `javascript:` and
 * fragment-only hrefs included, with no deduplication. `links.target_url` is
 * what the analyzer stored: deduplicated by resolved target, filtered to http(s)
 * by `normalizeUrl`, and fragment-stripped (src/crawl/parse/page-analyzer.ts,
 * `closeAnchor`). The two differences push in opposite directions and both are
 * harmless for a gate of ZERO:
 *
 *  - deduplication can only collapse a non-empty set to a smaller non-empty
 *    one, never to none, so it cannot manufacture the zero this rule needs;
 *  - protocol filtering CAN, for a page whose only facet links are
 *    `javascript:` or `mailto:` hrefs. That page is reported — and correctly:
 *    a faceted navigation a crawler cannot follow without executing script is
 *    precisely the defect, whether the script runs from an href or from a
 *    listener.
 *
 * Hand-derived boundaries (each pinned by the test):
 *   raw 0 links,                  rendered 5 → FIRES
 *   raw 0 links,                  rendered 4 → silent (under the floor)
 *   raw 1 link `?colour=red`,     rendered 5 → silent (the `?` arm)
 *   raw 1 link `/facet-a` (no ?), rendered 5 → silent (the regex arm)
 */
async function filtersJsOnlyFindings(db: Db, crawlId: string): Promise<Finding[]> {
  await assertCrawl(db, crawlId, FILTERS.id);
  await assertRenderedColumns(db, crawlId, FILTERS.id, ["rendered_filter_link_count"]);

  const res = await db.execute<{
    id: string;
    url: string;
    rendered_filter_link_count: number;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.rendered_filter_link_count,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId}
      and p.rendered = true
      and p.rendered_filter_link_count >= ${FILTER_RENDERED_MIN}
      -- Hard rule 3: the link question is asked of the table, and asked as an
      -- existence test rather than a count — the gate is zero, so the first row
      -- found settles it and the index on (crawl_id, source_page_id) stops the
      -- scan there.
      and not exists (
        select 1 from links l
        where l.crawl_id = ${crawlId}
          and l.source_page_id = p.id
          and (position('?' in l.target_url) > 0
               or l.target_url ~* 'filter|facet|sort')
      )
    order by p.url
    limit ${URL_FINDING_CAP}`);

  const findings = res.rows.map((row) =>
    queryFinding(FILTERS, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        // Zero by construction — the NOT EXISTS above is what proves it, and it
        // is written into the evidence rather than left implicit because the
        // finding is a comparison and a reader is owed both of its sides.
        rawFilterLinks: 0,
        renderedFilterLinks: row.rendered_filter_link_count,
      },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, res.rows[0]?.total_matches ?? 0);
}

export const renderDiffRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: CSR.id,
    checkIds: ["CHECK-01"],
    category: "content",
    severity: CSR.severity,
    ...copyFor(CSR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => csrDependentFindings(db, crawlId),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: NAV.id,
    checkIds: ["CHECK-34"],
    category: "technical",
    severity: NAV.severity,
    ...copyFor(NAV.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => navJsOnlyFindings(db, crawlId),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: FILTERS.id,
    checkIds: ["CHECK-02"],
    category: "url",
    severity: FILTERS.severity,
    ...copyFor(FILTERS.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => filtersJsOnlyFindings(db, crawlId),
  }),
];

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
 * **WHICH INSTRUMENT EACH RULE COMPARES, and why they are not all the same
 * (P8-T1).** The render pass measures every page it renders twice — once with
 * `innerText` and DOM selectors inside the browser, once by running the crawl's
 * own `analyzeHtml` over the serialised post-JavaScript DOM (see the two family
 * blocks on `pages` in src/db/schema.ts). Phase 8 moved ONE of these three
 * rules onto the second family and deliberately left the other two on the
 * first:
 *
 *  - `content.csr-dependent` reads `rendered_renderable_word_count` against
 *    `renderable_word_count` — ONE instrument, two documents. It had to move:
 *    the analyzer cannot see a stylesheet, so class-hidden chrome sat on the
 *    raw side of the subtraction and on neither side of the rendered one, and
 *    the Phase 7 gate measured that as a near-constant 425 words which made the
 *    rule arithmetically unable to fire (docs/gates/phase-7.md §4.2, §4.9).
 *  - `nav.js-only` and `filters.js-only` stay on the browser's counts, and the
 *    comparability argument for each is written at its own docblock. In short:
 *    the nav rule's markup-vs-DOM divergence is BOUNDED (≤1 per unclosed
 *    anchor, one-directional, pinned by a named test) and the rule's thresholds
 *    are a derived margin of six against it, so re-siding would move a
 *    divergence that is already inside the noise the rule was built to absorb —
 *    and the filter rule's asymmetry is DELIBERATE, chosen for what it reports
 *    rather than tolerated. Symmetry is worth having where it decides an
 *    answer; churn is what it is called where it does not.
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
import type { RuleCaps } from "../registry/types.js";
import { assertCrawl, capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";

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
 *   rendered_renderable_word_count
 *     >= CSR_WORD_MULTIPLE * greatest(renderable_word_count, 1)
 *   rendered_renderable_word_count - renderable_word_count >= CSR_MIN_ADDED_WORDS
 *
 * **BOTH SIDES ARE NOW THE SAME INSTRUMENT (Phase 8), and the old comparison is
 * retired from this rule.** Until P8-T1 the rendered side was `innerText`
 * (`rendered_word_count`) and the raw side was the analyzer's
 * `renderable_word_count`. Phase 7 had already corrected the raw side once —
 * from `word_count`, which counted every word the markup hides, to the subset
 * it does not — and predicted the two columns would then differ only on
 * CSS-hidden chrome, small enough to compare directly.
 *
 * **THE PHASE 7 GATE FALSIFIED THAT PREDICTION, and this rule is what it cost.**
 * Measured across 28 rendered pages of a real Shopify theme
 * (docs/gates/phase-7.md §4.2), `renderable_word_count − rendered_word_count`
 * was **min 425, max 489, and exactly 425 on 19 of the 28** — not a ratio that
 * grew with the page but ONE CONSTANT BLOCK of class-hidden chrome, the same
 * 425 words on a 196-word page and on an 1,137-word one. The analyzer cannot
 * see a class (hard rules 2 and 4), so those words were on the raw side of the
 * subtraction and on neither side of the rendered one. §4.9 states the
 * consequence plainly: **the firing condition was arithmetically unreachable on
 * that crawl whatever the site did** — every rendered page's
 * rendered/renderable ratio ran 0.32–0.73 where the rule needs 2.0. The zero it
 * reported was not "no client-side rendering"; it was a comparison nothing
 * could answer, on the very site where CHECK-33b had just found 100% of
 * products with no HTML link path.
 *
 * **WHY THE SAME INSTRUMENT ON BOTH SIDES FIXES IT.** The chrome markup — the
 * drawers, popovers, `<template>`s and off-canvas menus — is present in BOTH
 * documents. It is in the bytes the server sent and it is still in the DOM
 * after the JavaScript has run; only the *renderer* knows a stylesheet hides
 * it. So the analyzer, which counts it in both, puts it on both sides:
 *
 *   raw      = chrome + server-rendered body            (C + B)
 *   rendered = chrome + server-rendered body + injected (C + B + J)
 *
 * and the FLOOR ARM CANCELS IT EXACTLY: (C + B + J) − (C + B) = J, the words
 * JavaScript added, which is the number this rule was always about. The RATIO
 * ARM does not cancel — it becomes `J >= B + C` — and that is stated rather
 * than glossed: chrome still makes a page harder to report, as it should
 * (a page that ships 400 words of anything and adds 100 is not client-rendered).
 * What changed is that the ratio is now REACHABLE: before, the rendered side
 * lacked C entirely, so on a chrome-heavy theme the ratio was structurally
 * below 1 and no page could ever reach 2.
 *
 * `rendered_word_count` is not deleted and is not read here: it stays the only
 * number in the database that says what a READER sees, and
 * `renderable_word_count − rendered_word_count` is what makes a site's
 * class-hidden chrome computable at all. It is evidence; it is no longer a
 * verdict.
 *
 * The thresholds are unchanged, and re-derived rather than inherited: the four
 * boundary cases below are the same arithmetic in the new column, and the
 * fixture that proves the cancellation end to end (`/render/csr-content`,
 * test/fixtures/pages/render-p5.ts) is built so that the retired comparison is
 * SILENT on it and this one fires.
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
 *   …and the cancellation itself, which the four above cannot show because none
 *   of them carries chrome:
 *   raw 172 / renderable 132, rendered 372 / renderable 332 (132 of chrome on
 *   BOTH sides, 200 words injected) → 332 ≥ 264 and 332 − 132 = 200 ≥ 150 —
 *   FIRES, and `addedWords` is exactly the 200 the script wrote. The retired
 *   comparison on the same page is `rendered_word_count` 232 against 132:
 *   232 < 264 and 100 < 150, SILENT on both arms.
 *
 * The evidence carries the two readings by each instrument and the difference
 * rather than a ratio: an action plan quotes "this page's HTML holds 12 of its
 * 840 words", and a multiplier computed here would be a second number saying
 * the same thing with rounding of its own.
 */
async function csrDependentFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  // A crawl id nothing knows scans no pages, which reads exactly like a site
  // with no CSR problem (`runRules`' precedent, hard rule 7).
  await assertCrawl(db, crawlId, CSR.id);
  // The guard set is THE COLUMNS THIS RULE NOW READS, which is what changed in
  // P8-T1: `rendered_word_count` left it because the rule no longer compares
  // against it, and `rendered_renderable_word_count` joined it. A crawl
  // rendered before Phase 8 has null there on every rendered row and CANNOT be
  // re-judged — the rendered DOM of a finished pass is not recoverable — so it
  // is refused loudly rather than compared against a column measuring something
  // else, exactly as a pre-P7 `renderable_word_count` is.
  await assertRenderedColumns(db, crawlId, CSR.id, [
    "renderable_word_count",
    "rendered_renderable_word_count",
  ]);

  const res = await db.execute<{
    id: string;
    url: string;
    word_count: number | null;
    renderable_word_count: number;
    rendered_analyzer_word_count: number | null;
    rendered_renderable_word_count: number;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.word_count, p.renderable_word_count,
           p.rendered_analyzer_word_count, p.rendered_renderable_word_count,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId}
      and p.rendered = true
      and p.rendered_renderable_word_count
            >= ${CSR_WORD_MULTIPLE} * greatest(p.renderable_word_count, 1)
      and p.rendered_renderable_word_count - p.renderable_word_count
            >= ${CSR_MIN_ADDED_WORDS}
    order by p.url
    ${limitTo(caps.listing)}`);

  const findings = res.rows.map((row) =>
    queryFinding(CSR, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        // FOUR NUMBERS, TWO DOCUMENTS, ONE INSTRUMENT. Each side carries the
        // analyzer's whole count and the subset its own markup does not hide,
        // so a reader can see the chrome on each side (`raw − renderable`) and
        // watch it cancel in `addedWords`. A reader given only the renderable
        // pair could not tell a shell from a page whose copy is merely folded
        // away; a reader given only one side could not check the subtraction.
        //
        // `renderedWordCount` — the browser's `innerText`, this rule's rendered
        // side until Phase 8 — is deliberately NOT here. It is a different
        // instrument, and putting it in the evidence of a subtraction it takes
        // no part in is the confusion this phase removed.
        rawWordCount: row.word_count,
        renderableWordCount: row.renderable_word_count,
        renderedAnalyzerWordCount: row.rendered_analyzer_word_count,
        renderedRenderableWordCount: row.rendered_renderable_word_count,
        addedWords: row.rendered_renderable_word_count - row.renderable_word_count,
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
 * **WHY THIS RULE DID NOT MOVE TO THE ANALYZER'S RENDERED COUNTS IN PHASE 8,
 * when `content.csr-dependent` did.** The option was real: running
 * `analyzeHtml` over the serialised post-JS DOM would count `nav a[href]` with
 * the same tokenizer that counted the raw side, and would therefore remove the
 * adoption-agency divergence above entirely — a browser's serialisation of its
 * own tree has no unclosed anchors left in it. It was assessed and declined,
 * and the difference from the CSR case is one of KIND, not of degree:
 *
 *  - **The CSR asymmetry decided answers.** Class-hidden chrome is unbounded,
 *    it grows with the theme rather than with the defect, and the Phase 7 gate
 *    measured it at a near-constant 425 words — enough to make the rule's
 *    firing condition unreachable on every page of a real site (§4.9). Nothing
 *    short of re-siding could fix that.
 *  - **This asymmetry is bounded, one-directional and already absorbed.** It is
 *    at most −1 per anchor left unclosed across a container boundary, never
 *    positive, and pinned by a named parity test. The margin computed above
 *    says the cheapest false positive it can produce needs SIX such anchors in
 *    one page's nav or footer, against a realistic floor of two or three. The
 *    correction re-siding would buy is therefore strictly inside the noise
 *    these thresholds were derived to tolerate.
 *  - **Re-siding is not free.** It needs two more `pages` columns (this phase
 *    ships exactly one migration, and its column set is ruled), and `NAV_RAW_MAX`,
 *    `NAV_RENDERED_MIN`, the multiple and the six-anchor margin would all have
 *    to be re-derived honestly against an instrument whose divergence is zero —
 *    a re-derivation that changes no answer this engine has ever given.
 *
 * So the rule keeps the browser's counts and this paragraph records the
 * decision. If a later phase adds the analyzer-side nav columns for another
 * reason, the margin arithmetic above is what has to be redone with it.
 *
 * Hand-derived boundaries (each pinned by the test):
 *   raw 4  (4+0), rendered 10 (10+0) → all three exactly at — FIRES
 *   raw 4,        rendered 9         → 9 < 10 — silent
 *   raw 5  (3+2), rendered 20        → 5 not < 5 — silent
 *   raw 0,        rendered 10        → FIRES (the empty shell's navigation)
 */
async function navJsOnlyFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
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
    ${limitTo(caps.listing)}`);

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
 * **WHY THIS RULE DID NOT MOVE TO THE ANALYZER'S RENDERED COUNTS IN PHASE 8
 * EITHER, and here the reason is the opposite of the nav rule's.** Running
 * `analyzeHtml` over the serialised post-JS DOM would produce a rendered filter
 * count out of the SAME extraction the raw side is stored from — deduplicated
 * by target, protocol-filtered, fragment-stripped — so the two operands would
 * at last be the same set. That is precisely why it was declined: **the
 * asymmetry above is not an error this rule tolerates, it is a choice this rule
 * makes.** The one difference that can change an answer is protocol filtering,
 * and the page it changes the answer on is a collection whose only route into
 * its facets is a `javascript:` or `mailto:` href — a page this rule REPORTS,
 * and correctly, because a facet space no crawler can follow without executing
 * script is the defect CHECK-02 exists to find. Making the sides symmetric
 * would silence exactly that page. The other difference, deduplication, cannot
 * manufacture the zero the gate needs and therefore changes nothing at all.
 *
 * Symmetry is a means here, not a virtue: `content.csr-dependent` needed it
 * because its asymmetry was unbounded and decided every answer; this rule's is
 * bounded to one shape of page and decides that page in the direction the check
 * wants. Recorded rather than re-litigated each phase.
 *
 * Hand-derived boundaries (each pinned by the test):
 *   raw 0 links,                  rendered 5 → FIRES
 *   raw 0 links,                  rendered 4 → silent (under the floor)
 *   raw 1 link `?colour=red`,     rendered 5 → silent (the `?` arm)
 *   raw 1 link `/facet-a` (no ?), rendered 5 → silent (the regex arm)
 */
async function filtersJsOnlyFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
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
    ${limitTo(caps.listing)}`);

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
    run: (db, crawlId, caps) => csrDependentFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: NAV.id,
    checkIds: ["CHECK-34"],
    category: "technical",
    severity: NAV.severity,
    ...copyFor(NAV.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => navJsOnlyFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: FILTERS.id,
    checkIds: ["CHECK-02"],
    category: "url",
    severity: FILTERS.severity,
    ...copyFor(FILTERS.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => filtersJsOnlyFindings(db, crawlId, capsOr(caps)),
  }),
];

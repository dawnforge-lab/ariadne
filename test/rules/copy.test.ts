import { describe, expect, it } from "vitest";
import { copyFor, ISSUE_COPY } from "../../src/rules/registry/copy/index.js";
import {
  META_MAX,
  META_MIN,
  THIN_WORDS,
  TITLE_MAX,
  TITLE_MIN,
} from "../../src/rules/page/on-page.js";
import { DEEP_DEPTH, SLOW_MS } from "../../src/rules/page/technical.js";
import {
  DUPLICATE_SAMPLE_URLS,
  NEAR_DUPLICATE_HAMMING,
  SOFT_404_WORDS,
} from "../../src/rules/query/content.js";
import {
  CSR_MIN_ADDED_WORDS,
  CSR_WORD_MULTIPLE,
  FILTER_RENDERED_MIN,
  NAV_RAW_MAX,
  NAV_RENDERED_MIN,
  NAV_RENDERED_MULTIPLE,
} from "../../src/rules/query/render-diff.js";
import { BREADCRUMB_PAGE_FLOOR } from "../../src/rules/query/structured-data.js";
import {
  EXTREMES_LIST_CAP,
  OTHER_SOURCES,
  SOURCE_TYPE_CAP,
} from "../../src/rules/metric/link-metrics.js";
import {
  TEMPLATE_LOOSE_BITS,
  TEMPLATE_NEAR_BITS,
  TEMPLATE_SAMPLE_PAGES,
} from "../../src/rules/metric/content-metrics.js";
import {
  SITEMAP_DOC_ROWS_CAP,
  SITEMAP_URL_CAP,
} from "../../src/rules/metric/crawl-metrics.js";
import { TOP_PARAMS_CAP } from "../../src/rules/metric/url-metrics.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";

/**
 * The content copy spells its distance out in words, so the threshold pin below
 * has to spell the constant out too. Only the values the rule could plausibly
 * take are here; an unmapped one fails the assertion rather than passing it.
 */
const NUMBER_WORDS: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
};

/**
 * Every rule id defined by the Phase 2 rule tables (plan tasks 4-6). Kept here
 * rather than derived from the registry so the copy lands before the rules do
 * and a rule added without copy fails loudly on this list.
 */
const PHASE_2_RULE_IDS = [
  "title.missing",
  "title.too-short",
  "title.too-long",
  "meta-description.missing",
  "meta-description.too-short",
  "meta-description.too-long",
  "headings.h1-missing",
  "headings.h1-multiple",
  "headings.level-skip",
  "content.thin",
  "content.placeholder",
  "http.server-error",
  "crawl.blocked",
  "canonical.missing",
  "canonical.points-elsewhere",
  "canonical.multiple",
  "canonical.html-header-conflict",
  "canonical.cross-domain",
  "directive.canonical-noindex-conflict",
  "indexability.noindex",
  "indexability.meta-header-conflict",
  "hreflang.invalid-code",
  "hreflang.missing-x-default",
  "mobile.viewport-missing",
  "images.missing-dimensions",
  "images.missing-alt",
  "performance.slow-response",
  "structure.deep-page",
];

/**
 * The query rules of the Phase 3 tables, listed the same way and for the same
 * reason: copy lands with the rule, and a rule added without copy fails here as
 * well as at registry build time.
 */
const PHASE_3_RULE_IDS = [
  "redirect.chain",
  "redirect.loop",
  "links.broken-internal",
  "canonical.non-200-target",
  "canonical.non-indexable-target",
  "links.orphan",
  "links.orphan-skipped",
  "hreflang.missing-return-link",
  "hreflang.non-indexable-target",
  "pagination.next-target-uncrawled",
  "pagination.next-not-linked",
  "pagination.canonical-to-other",
  "robots.missing",
  "robots.blocks-sitemap-urls",
  "robots.check-skipped",
  "sitemap.missing",
  "sitemap.invalid",
  "sitemap.non-200",
  "sitemap.redirected",
  "sitemap.non-indexable",
  "sitemap.uncrawled",
  "pages.not-in-sitemap",
  "url.normalisation-variants",
  "url.tracking-params-internal",
  "url.parameter-pages-indexable",
  "host.http-serves-200",
  "host.duplicate-host-200",
  "host.legacy-host-reachable",
  "host.probe-skipped",
  "content.soft-404",
  "content.exact-duplicate",
  "content.near-duplicate",
  "schema.none-on-site",
  "schema.product-incomplete",
  "schema.breadcrumb-absent",
  "schema.self-serving-reviews",
];

/**
 * The metric rules of the Phase 4 tables. Same contract as the two lists above
 * — copy lands with the rule — and the same reason to keep listing them by
 * hand: a metric that shipped without copy would render as a table with no
 * label saying what its numbers are.
 */
const PHASE_4_METRIC_IDS = [
  "inlinks.distribution",
  "inlinks.extremes",
  "inlinks.sources-by-type",
  "structure.depth-distribution",
  "content.metrics-by-type",
  "content.template-similarity",
  "hreflang.coverage",
  "url.param-volumes",
  "redirect.volume",
  "sitemap.structure",
];

/**
 * The render pass's rules. Same contract again — copy lands with the rule —
 * with one addition worth naming: `render.coverage` is a metric and the four
 * above it are findings, so the metric-only assertions below select it out of
 * this list rather than taking the whole of it.
 */
const PHASE_5_RULE_IDS = [
  "content.csr-dependent",
  "nav.js-only",
  "filters.js-only",
  "redirect.js",
  "render.coverage",
];

/** The metric ids of the list above — what the metric-copy contracts apply to. */
const PHASE_5_METRIC_IDS = ["render.coverage"];

/**
 * Phase 7's rules. Same contract as every list above: the copy lands with the
 * rule, and a rule that shipped without it fails here as well as at registry
 * build time.
 *
 * T1 corrected what existing rules measure rather than adding new verdicts —
 * apart from `content.thin-skipped`, which is a verdict about the CRAWL and
 * needs a title of its own for exactly that reason. T2 adds the three
 * field-level duplicate rules the checklist has always asked for, plus the
 * heading skip, which is the same crawl-not-site verdict one column over. T4
 * adds the click-depth metric, whose copy has to do something no other metric's
 * does: say what the table it stands NEXT TO measures, because
 * `structure.depth-distribution` keeps its data under a corrected title and the
 * two are one letter apart in a list.
 */
const PHASE_7_RULE_IDS = [
  "content.thin-skipped",
  "title.duplicate",
  "meta-description.duplicate",
  "h1.duplicate-text",
  "h1.duplicate-skipped",
  "structure.click-depth-distribution",
];

const ALL_RULE_IDS = [
  ...PHASE_2_RULE_IDS,
  ...PHASE_3_RULE_IDS,
  ...PHASE_4_METRIC_IDS,
  ...PHASE_5_RULE_IDS,
  ...PHASE_7_RULE_IDS,
];

describe("issue copy", () => {
  it("throws on an unknown rule id", () => {
    expect(() => copyFor("no.such-rule")).toThrow(/no copy/);
  });

  it("covers every rule id the phase tables define, and nothing else", () => {
    for (const id of ALL_RULE_IDS) {
      expect(() => copyFor(id), id).not.toThrow();
    }
    expect(Object.keys(ISSUE_COPY).sort()).toEqual([...ALL_RULE_IDS].sort());
  });

  it("every entry has substantive, client-facing text", () => {
    for (const [id, c] of Object.entries(ISSUE_COPY)) {
      expect(c.title.length, `${id} title`).toBeGreaterThan(5);
      expect(c.explanation.length, `${id} explanation`).toBeGreaterThan(40);
      expect(c.howToFix.length, `${id} howToFix`).toBeGreaterThan(30);
    }
  });

  // The on-page thresholds are asserted against the rule constants themselves,
  // so copy and rule cannot drift apart: change TITLE_MIN and this test fails
  // until the prose is changed with it.
  it("quotes the on-page thresholds the rules actually use", () => {
    expect(ISSUE_COPY["title.too-short"]!.explanation).toContain(
      `${TITLE_MIN} characters`,
    );
    expect(ISSUE_COPY["title.too-long"]!.explanation).toContain(
      `${TITLE_MAX} characters`,
    );
    expect(ISSUE_COPY["meta-description.too-short"]!.explanation).toContain(
      `${META_MIN} characters`,
    );
    expect(ISSUE_COPY["meta-description.too-long"]!.explanation).toContain(
      `${META_MAX} characters`,
    );
    expect(ISSUE_COPY["content.thin"]!.explanation).toContain(`${THIN_WORDS} words`);
  });

  // Asserted against the rule constants, like the on-page thresholds above, so
  // the prose cannot drift from the number the rule fires on. Word-bounded:
  // a bare `toContain("5 links deep")` would also pass against "15 links deep".
  it("quotes the technical thresholds the rules actually use", () => {
    expect(ISSUE_COPY["performance.slow-response"]!.explanation).toMatch(
      new RegExp(`\\b${SLOW_MS}ms\\b`),
    );
    expect(ISSUE_COPY["structure.deep-page"]!.explanation).toMatch(
      new RegExp(`\\b${DEEP_DEPTH} links deep\\b`),
    );
  });

  // The guards below are negative on purpose. A positive `toContain` still
  // passes when someone APPENDS an overpromise to text that already says the
  // right thing, so the forbidden claim is what has to be asserted against.
  it("content.placeholder claims only the literal phrase it detects", () => {
    const c = ISSUE_COPY["content.placeholder"]!;
    expect(c.explanation).toContain("lorem ipsum");
    // The analyzer matches /lorem ipsum/i in visible text and nothing else.
    const widened = /\bTODO\b|\bTBC\b|dummy (?:text|copy|content|name)|placeholder (?:of any kind|text such as)|generic placeholder|any placeholder/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(widened);
  });

  it("images.missing-dimensions claims the absent attribute, not proven CLS", () => {
    const c = ISSUE_COPY["images.missing-dimensions"]!;
    expect(c.explanation).toContain("attribute");
    // An empty attribute counts as present and CSS may already reserve the
    // space, so layout shift may not be happening at all.
    const certainty =
      /is shifting|causes layout shift|will shift|will cause layout shift|results in layout shift|creates layout shift/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(certainty);
  });

  it("mobile.viewport-missing speaks only to the absent tag", () => {
    const c = ISSUE_COPY["mobile.viewport-missing"]!;
    // The rule fires on `!hasViewport`. It knows nothing about the contents of
    // a viewport tag that does exist.
    const misconfigured =
      /misconfigured|incorrectly configured|incorrect viewport|wrong viewport|badly configured|invalid viewport/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(misconfigured);
  });

  // The rule is per SET now: it fires once per distinct cluster of alternates,
  // not once for the crawl and not once per page. Copy saying "this site" or
  // "this page" would describe the shape the rule used to have.
  it("hreflang.missing-x-default speaks about a cluster, not a site or a page", () => {
    const c = ISSUE_COPY["hreflang.missing-x-default"]!;
    const wrongScope = /this (?:crawl|site|page)|the whole site|site-wide/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(wrongScope);
  });

  // rel=next/rel=prev stopped being a discovery or consolidation signal in
  // 2019. The findings are about what the markup documents and about the HTML
  // links that are missing beside it.
  it("the pagination copy does not claim rel=next still consolidates a series", () => {
    for (const id of [
      "pagination.next-target-uncrawled",
      "pagination.next-not-linked",
      "pagination.canonical-to-other",
    ]) {
      const c = ISSUE_COPY[id]!;
      const overclaim =
        /rel=next (?:tells|lets|helps|allows|asks) (?:search engines|google|crawlers)|(?:search engines|google|crawlers) use rel=next|consolidat\w+ (?:the )?series (?:with|through|via) rel=next/i;
      expect(`${c.explanation} ${c.howToFix}`, id).not.toMatch(overclaim);
    }
  });

  // The engine never probes /sitemap.xml speculatively (a Phase 1 ruling), so
  // the only sitemaps it can see are the ones robots.txt declares. "This site
  // has no sitemap" is therefore a claim the rule cannot support: a sitemap
  // nobody declares is exactly the site this fires on.
  it("sitemap.missing claims an absent declaration, not an absent file", () => {
    const c = ISSUE_COPY["sitemap.missing"]!;
    expect(c.title.toLowerCase()).toContain("declared in robots.txt");
    const overclaim =
      /(?:site|there) (?:has|have|is|are) no sitemap|no sitemap (?:exists|at all|on (?:this|the) site)|does not have a sitemap/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });

  // `robotsUnreadable` lets `outcome === "absent"` through, so the rule also
  // fires on a site that serves no robots.txt at all. Copy that spoke only of
  // "the robots.txt contains no Sitemap: line" would describe a file that is
  // not there, and its fix would tell a client to edit it.
  it("sitemap.missing covers the site that serves no robots.txt either", () => {
    const c = ISSUE_COPY["sitemap.missing"]!;
    expect(`${c.explanation} ${c.howToFix}`).toMatch(/no robots\.txt|serves none|serves no robots/i);
  });

  // The rule fires on every non-200, non-redirect status, and `blocked` (401,
  // 403, 429) is one of them. "Restore the page or remove the entry" is the
  // wrong instruction for a URL a WAF is defending, so the fix has to branch
  // the way `canonical.non-200-target`'s does.
  it("sitemap.non-200 tells blocked apart from gone", () => {
    const fix = ISSUE_COPY["sitemap.non-200"]!.howToFix;
    expect(fix).toMatch(/\b401\b/);
    expect(fix).toMatch(/\b403\b/);
    expect(fix).toMatch(/\b429\b/);
    expect(fix).toMatch(/WAF|bot-protection|allowlist/i);
  });

  // The rule fires on `outcome === "absent"`, which is the site ANSWERING with
  // a 4xx. A server that could not serve robots.txt is a different finding
  // (`robots.check-skipped`), and copy blurring the two would tell a client to
  // write a file they may already have.
  it("robots.missing does not treat a server failure as an absent file", () => {
    const c = ISSUE_COPY["robots.missing"]!;
    const blurred = /unreachable|could not be (?:fetched|reached|read)|timed out|server error/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(blurred);
  });

  // Same contract as the on-page thresholds: the numbers in the content copy
  // are the rules' own constants, so changing one fails here until the prose
  // changes with it.
  it("quotes the content thresholds the rules actually use", () => {
    expect(ISSUE_COPY["content.soft-404"]!.explanation).toMatch(
      new RegExp(`\\b${SOFT_404_WORDS} words\\b`),
    );
    // And WHICH 300 words: the ceiling is applied to the renderable count, so
    // a short error message inside a full site shell is still short. Copy that
    // left this out would describe a rule that fires far less often than it
    // does on exactly the sites where it matters most.
    expect(ISSUE_COPY["content.soft-404"]!.explanation).toMatch(/the markup hides/i);
    expect(ISSUE_COPY["content.near-duplicate"]!.explanation).toContain(
      `${NUMBER_WORDS[NEAR_DUPLICATE_HAMMING]} bits out of sixty-four`,
    );
  });

  // The soft-404 rule fires on EITHER signal. Copy saying both are needed would
  // describe a rule half as sensitive as the one that ships, and copy claiming
  // the page was proved missing would overstate what a similarity measurement
  // and a word count can establish.
  it("content.soft-404 does not make either signal a requirement", () => {
    const c = ISSUE_COPY["content.soft-404"]!;
    expect(c.explanation).toContain("200");
    const bothRequired =
      /both signals|only when both|and also matches|must (?:also )?match the|combination of both/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(bothRequired);
  });

  // The near-duplicate rule measures a hamming distance between two content
  // fingerprints. It knows nothing about who wrote what, and near-duplicate
  // pages carry no ranking penalty — the finding is about consolidation.
  it("content.near-duplicate claims similarity, not plagiarism or a penalty", () => {
    const c = ISSUE_COPY["content.near-duplicate"]!;
    const overclaim =
      /plagiaris|scraped|stolen|copied from|duplicate content penalt|penalis|penaliz|will be penal/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });

  // The breadcrumb copy names the size of site it is advice for, and that
  // number is the rule's own floor. Same contract as the on-page thresholds.
  // The gate is `indexablePages < BREADCRUMB_PAGE_FLOOR` — so the floor is
  // inclusive and a site of exactly five pages fires. "More than five" would
  // describe a rule one page less sensitive than the one that ships.
  it("quotes the breadcrumb page floor the rule actually uses, inclusively", () => {
    const c = ISSUE_COPY["schema.breadcrumb-absent"]!;
    expect(c.explanation).toMatch(
      new RegExp(`\\bat least ${BREADCRUMB_PAGE_FLOOR} indexable pages\\b`),
    );
    expect(c.explanation).not.toMatch(new RegExp(`\\bmore than ${BREADCRUMB_PAGE_FLOOR}\\b`));
  });

  // The crawler reads JSON-LD and nothing else, so a site marked up in
  // microdata or RDFa is invisible to these rules. Copy saying a site has no
  // structured data, flatly, would be a claim about markup nobody looked at.
  it("the site-scoped schema copy claims JSON-LD, not every markup format", () => {
    for (const id of ["schema.none-on-site", "schema.breadcrumb-absent"]) {
      const c = ISSUE_COPY[id]!;
      expect(`${c.title} ${c.explanation}`, id).toContain("JSON-LD");
      const overclaim =
        /(?:has|have|uses?|carr(?:y|ies)) no structured data(?! .{0,20}JSON-LD)|no structured data (?:at all|of any kind|anywhere on the site\.)|no markup of any kind/i;
      expect(`${c.explanation} ${c.howToFix}`, id).not.toMatch(overclaim);
    }
  });

  // The presence blob behind the Product finding is the union across the page's
  // Product blocks, so a field it names is missing from all of them. Copy about
  // "the Product block" would misdescribe a page carrying several.
  it("schema.product-incomplete speaks about the page's blocks, not one block", () => {
    const c = ISSUE_COPY["schema.product-incomplete"]!;
    expect(c.explanation).toContain("No Product block on this page");
    const singular = /your Product block\b|the Product block on this page\b/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(singular);
  });

  // The self-serving finding is a statement about which snippets Google shows.
  // It is not an accusation that the reviews are fabricated, and there is no
  // penalty attached to publishing them.
  it("schema.self-serving-reviews claims a policy, not fake reviews or a penalty", () => {
    const c = ISSUE_COPY["schema.self-serving-reviews"]!;
    // The copy has to say so, rather than merely avoid saying the opposite:
    // "Google ignores your ratings" reads as a sanction unless it is denied.
    expect(c.explanation).toMatch(/not a penalty/i);
    const overclaim = /fake|fraudulent|fabricat|manual action|penalis|penaliz|will be penal/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });

  // The metric copy quotes both list caps in words, and both are the rules'
  // own constants. Pinned the way the on-page thresholds are: a cap that moves
  // fails here until the prose moves with it.
  it("quotes the list caps the link metrics actually apply", () => {
    expect(EXTREMES_LIST_CAP).toBe(20);
    expect(ISSUE_COPY["inlinks.extremes"]!.explanation).toContain("twenty");
    expect(SOURCE_TYPE_CAP).toBe(25);
    expect(ISSUE_COPY["inlinks.sources-by-type"]!.explanation).toContain("twenty-five");
    // The rollup bucket is a KEY a reader meets in the table, so the copy has to
    // name it — and name the parenthesised spelling, which is what keeps it
    // apart from a template a client really called `other`.
    expect(OTHER_SOURCES).toBe("(other)");
    expect(ISSUE_COPY["inlinks.sources-by-type"]!.explanation).toContain(OTHER_SOURCES);
  });

  // The metric-copy contract is that a reader can say what the table measured
  // from the text alone — so every COLUMN of the value shape has to appear in
  // it. p95 was the one the first draft left out: the number was in the jsonb
  // and nowhere in the prose. Asserted for both distribution metrics, which
  // share the shape, so the same omission cannot recur in the metrics Tasks 5
  // and 6 copy from this pattern.
  it("the distribution copy names every column of the shape, p95 included", () => {
    for (const id of [
      "inlinks.distribution",
      "structure.depth-distribution",
      "structure.click-depth-distribution",
    ]) {
      const text = ISSUE_COPY[id]!.explanation;
      expect(text, `${id}: the count`).toMatch(/how many pages were measured/i);
      expect(text, `${id}: min and max`).toMatch(/smallest and largest|shallowest and deepest/i);
      expect(text, `${id}: the mean`).toContain("mean");
      expect(text, `${id}: p25/median/p75`).toContain("quartiles");
      expect(text, `${id}: p95`).toContain("95th percentile");
    }
  });

  // The ninth column, and the reason the metric exists in the shape it does. A
  // `nullCount` a reader meets without prose behind it is a number they will
  // read as "no data" — which is the exact misreading that let a site with 437
  // unreachable pages pass CHECK-31. The copy has to say what it counts, that
  // those pages are NOT depth 0, and that they are the worst bucket.
  it("the click-depth copy explains the unreachable bucket rather than just having one", () => {
    const c = ISSUE_COPY["structure.click-depth-distribution"]!;
    expect(c.explanation).toMatch(/unreachable/i);
    expect(c.explanation, "says they are not depth zero").toMatch(
      /rather than being given a depth of zero/i,
    );
    expect(c.explanation, "names the sitemap-only case").toMatch(/sitemap/i);
    expect(c.explanation, "ranks the bucket").toMatch(/worst case/i);
    expect(c.howToFix, "the fix starts with them").toMatch(/unreachable/i);
    // And the count's population, which differs from every other distribution's
    // in this table: `count` includes the pages the statistics exclude.
    expect(c.explanation).toMatch(/count covers every page in the cohort/i);
  });

  // The other half of the same move: the metric that KEPT its data had to lose
  // the words "click depth" from its copy, because the number it holds is a
  // property of the crawl. A title still saying "click depth" over a column
  // that counts sitemap entries as zero hops is the defect this task removed.
  it("the discovery-depth copy claims the crawl, never a click path", () => {
    const c = ISSUE_COPY["structure.depth-distribution"]!;
    expect(c.title, "the title names discovery depth").toMatch(/discovery depth/i);
    expect(c.title, "and never click depth").not.toMatch(/click/i);
    expect(c.explanation, "it says whose property the number is").toMatch(
      /measurement of the crawl, not of the site/i,
    );
    // It has to say WHY it is flat on a sitemapped site, because that flatness
    // is what a reader would otherwise quote as good news.
    expect(c.explanation).toMatch(/sitemap/i);
    expect(c.explanation, "points at the metric that answers the click question").toMatch(
      /click depth table/i,
    );
  });

  // The same contract, for the Task 5 metrics — which do NOT inherit the
  // assertion above, because their shapes are their own. Every column of every
  // value shape has to be findable in the prose: a table's numbers are quoted
  // to a client, and a column nobody named is a number nobody can explain.
  it("content.metrics-by-type names all three measures and every column of each", () => {
    const text = ISSUE_COPY["content.metrics-by-type"]!.explanation;
    expect(text, "the three measures").toMatch(/word count/i);
    expect(text, "the three measures").toMatch(/renderable word count/i);
    expect(text, "the three measures").toMatch(/text ratio/i);
    // A column called "renderable" is meaningless without the sentence that
    // says what it leaves out, and that sentence is the whole reason the
    // measure is quotable to a client.
    expect(text, "what renderable excludes").toMatch(/the page's own markup hides/i);
    // And the other half of that sentence, which is the one a reader of this
    // table would otherwise get wrong: `text_ratio` reads the accumulator that
    // still includes hidden chrome. Two measures over the same page that treat
    // hidden text differently must both say which they are, or the table
    // silently invites the comparison it cannot support.
    expect(text, "the text ratio still counts hidden text").toMatch(
      /text ratio counts the hidden parts as text/i,
    );
    expect(text, "the count is per measure, over three now").toMatch(/three counts/i);
    expect(text, "the count").toMatch(/how many pages were measured/i);
    // And that the count is per measure rather than the size of the cohort —
    // the one place this shape differs from the link metrics' distribution.
    expect(text, "the count is per measure").toMatch(
      /pages that actually carry each measure|carry each measure/i,
    );
    expect(text, "min and max").toMatch(/shortest and longest/i);
    expect(text, "the mean").toContain("mean");
    expect(text, "p25/median/p75").toContain("quartiles");
    expect(text, "p95").toContain("95th percentile");
  });

  it("content.template-similarity names every column, the thresholds and the sample", () => {
    const c = ISSUE_COPY["content.template-similarity"]!;
    const text = c.explanation;
    // `pagesFingerprinted` counts the pages the metric could actually compare,
    // not the pages of the type: the cohort excludes any page the crawl
    // recorded no fingerprint for. The name says so and the copy must too — a
    // column called "pages in type" over a fingerprinted count would understate
    // real type size wherever the two differ, silently.
    expect(text, "pagesFingerprinted").toMatch(/how many of the type's pages carry a fingerprint/i);
    expect(text, "the pages it leaves out").toMatch(/neither compared nor counted/i);
    expect(text, "pagesSampled").toMatch(/how many of those were sampled/i);
    expect(text, "pairsSampled").toMatch(/how many pairs that was/i);
    expect(text, "meanHamming").toMatch(/mean distance/i);
    expect(text, "p25/median/p75").toContain("quartiles");
    // The two share columns, and the thresholds their KEYS spell. Pinned
    // against the rule's own constants, so a threshold that moves fails here
    // until the prose moves with it (the on-page-threshold contract).
    expect(TEMPLATE_NEAR_BITS).toBe(3);
    expect(TEMPLATE_LOOSE_BITS).toBe(8);
    expect(text, "shareWithin3BitsPct").toMatch(
      new RegExp(`percentage of pairs within ${TEMPLATE_NEAR_BITS} bits`, "i"),
    );
    expect(text, "shareWithin8BitsPct").toMatch(new RegExp(`within ${TEMPLATE_LOOSE_BITS} bits`, "i"));
    // The sampling rule is part of the shape: three of the columns describe it,
    // and a reader who cannot see it would read a sample as a census.
    expect(TEMPLATE_SAMPLE_PAGES).toBe(200);
    expect(text, "the sampling rule").toMatch(
      new RegExp(`first ${TEMPLATE_SAMPLE_PAGES} pages`, "i"),
    );
    expect(text, "the sample's ordering").toMatch(/page-id order/i);
  });

  // The plan's naming ruling, asserted negatively because that is the only
  // direction that holds: prose already saying "template similarity" can have
  // the other word appended to it and still pass a positive check. The metric
  // measures how alike two pages are; which parts of a page are worth reading
  // is a judgement it has not made.
  it("content.template-similarity is labelled template similarity and never the other word", () => {
    const c = ISSUE_COPY["content.template-similarity"]!;
    expect(`${c.title} ${c.explanation} ${c.howToFix}`).not.toMatch(/boilerplate/i);
    expect(`${c.title} ${c.explanation}`.toLowerCase()).toContain("template");
  });

  it("hreflang.coverage names its three columns and its empty-cohort answer", () => {
    const text = ISSUE_COPY["hreflang.coverage"]!.explanation;
    expect(text, "pagesWithHreflang").toMatch(
      /how many of this site's indexable pages publish at least one hreflang/i,
    );
    expect(text, "indexablePages").toMatch(/out of how many were measured/i);
    expect(text, "coveragePct").toMatch(/percentage rounded to one decimal place/i);
    // The null case is a column value a reader will meet, so it is copy too.
    expect(text, "the null percentage").toMatch(/no percentage rather than zero/i);
    // And the claim it must NOT make: coverage counts pages that declare
    // something, not pages whose declarations are correct — that is the
    // hreflang findings' subject, and conflating them would let a client read
    // "100% coverage" as "the international setup is sound".
    const overclaim = /(?:sets|declarations) are (?:complete|correct|valid)|correctly configured/i;
    expect(text).not.toMatch(overclaim);
  });

  // The same contract for the task 6 metrics: every column of every value shape
  // has to be findable in the prose, because a number that reaches a client
  // without a sentence explaining it is a number nobody can defend.
  it("url.param-volumes names every column of its shape, the cap and the tie-break", () => {
    const text = ISSUE_COPY["url.param-volumes"]!.explanation;
    expect(text, "totalParams").toMatch(/how many distinct parameter names/i);
    expect(text, "trackingParams").toMatch(/how many of those are tracking parameters/i);
    // The three columns of a `topParams` entry: name, occurrences, isTracking.
    expect(text, "topParams.occurrences").toMatch(/the number of URLs it appears on/i);
    expect(text, "topParams.isTracking").toMatch(/whether it is one of the tracking ones/i);
    expect(text, "parameterisedPages").toMatch(/how many crawled pages carry a query string/i);
    expect(text, "parameterisedIndexablePages").toMatch(
      /how many of those returned 200 and are indexable/i,
    );
    // The cap is the rule's own constant, and the tie-break is what makes the
    // list the same twenty on every run (the on-page-threshold contract).
    expect(TOP_PARAMS_CAP).toBe(20);
    expect(text, "the cap").toContain("twenty");
    expect(text, "the tie-break").toMatch(/ties broken by name/i);
  });

  it("redirect.volume names every column and what its counts are capped by", () => {
    const text = ISSUE_COPY["redirect.volume"]!.explanation;
    expect(text, "redirectPages").toMatch(/how many of the URLs this crawl requested/i);
    // `redirectInlinks` is a second count of the same fact and reads as a
    // restatement of the first unless the copy says how they differ — one
    // redirecting URL in a footer is one page and one link per page of the site.
    expect(text, "redirectInlinks").toMatch(
      /number of internal links pointing at one of those redirecting URLs/i,
    );
    expect(text, "the two counts are not the same number").toMatch(
      /the same fact counted the other way round/i,
    );
    expect(text, "totalPages").toMatch(/out of how many pages were fetched in total/i);
    expect(text, "ratioPct").toMatch(/percentage rounded to one decimal place/i);
    expect(text, "chains and loops").toMatch(/how many redirect chains and how many redirect loops/i);
    // The counts are exact even where the FINDINGS listing was capped, and the
    // copy has to say so: a reader comparing the table with the findings list
    // would otherwise take the difference for an error.
    expect(text, "the finding cap").toMatch(
      new RegExp(`counted in full even where that list was capped at the first ${URL_FINDING_CAP}`, "i"),
    );
    expect(text, "the null share").toMatch(/no percentage rather than zero/i);
  });

  // The three duplicate-group rules share one evidence shape — the duplicated
  // value, the exact size of the group, and a capped sample of its URLs — and a
  // reader who cannot tell the count from the list will read a twenty-URL
  // sample as the whole problem. Asserted for all three at once, because they
  // share a rule body and a copy that stopped naming a column would be the same
  // omission three times.
  it("the field-duplicate copy names the value, the exact count and the capped URL list", () => {
    const fields: Record<string, RegExp> = {
      "title.duplicate": /shared title/i,
      "meta-description.duplicate": /shared description/i,
      "h1.duplicate-text": /shared heading/i,
    };
    for (const [id, value] of Object.entries(fields)) {
      const text = ISSUE_COPY[id]!.explanation;
      expect(text, `${id}: the duplicated value`).toMatch(value);
      expect(text, `${id}: count`).toMatch(/how many indexable pages were found carrying it/i);
      expect(text, `${id}: pages`).toMatch(/up to twenty of those URLs in alphabetical order/i);
      // The distinction between the two, which is what makes the number
      // quotable: the count is the group, the list is a sample of it.
      expect(text, `${id}: the count is not the list`).toMatch(
        /the count is the whole group, the list is a sample of it/i,
      );
      // And the cohort, because a client checking the finding against their own
      // site will otherwise count noindexed and redirecting URLs too.
      expect(text, `${id}: the cohort`).toMatch(/returned 200 and are indexable/i);
    }
    // The list cap in the copy is the rule's own constant (the on-page-threshold
    // contract): a cap that moves fails here until the prose moves with it.
    expect(DUPLICATE_SAMPLE_URLS).toBe(20);
  });

  // Exact equality after trimming is the whole claim. Copy implying the engine
  // spotted SIMILAR titles would describe a measurement it did not make, and
  // duplicate titles carry no penalty of their own — the cost is that the pages
  // stop distinguishing themselves.
  it("the field-duplicate copy claims exact repetition, not similarity or a penalty", () => {
    for (const id of ["title.duplicate", "meta-description.duplicate", "h1.duplicate-text"]) {
      const c = ISSUE_COPY[id]!;
      expect(c.explanation, id).toMatch(/word for word/i);
      const overclaim =
        /similar|near-identical|almost the same|penalis|penaliz|will be penal|duplicate content penalt/i;
      expect(`${c.explanation} ${c.howToFix}`, id).not.toMatch(overclaim);
    }
    // And the heading rule says which heading it read: the column holds the
    // FIRST h1 only, so copy speaking of "the headings on these pages" would be
    // describing data the rule never sees.
    expect(ISSUE_COPY["h1.duplicate-text"]!.explanation).toMatch(/only each page's first H1/i);
  });

  // The skip's copy is about the CRAWL. It must not read as a fault on the
  // site, and it must name each of the three numbers its evidence carries,
  // because the last of them is the reason the check did not run.
  it("h1.duplicate-skipped explains the crawl, its three numbers and the remedy", () => {
    const c = ISSUE_COPY["h1.duplicate-skipped"]!;
    expect(c.title.toLowerCase()).toContain("could not be run");
    expect(c.explanation, "indexablePages").toMatch(/how many indexable pages the crawl held/i);
    expect(c.explanation, "pagesWithH1").toMatch(/how many of them carry an H1 element/i);
    expect(c.explanation, "pagesWithH1Text").toMatch(/how many have heading text stored/i);
    // Why a silence had to be reported at all — the unknown-is-not-evidence
    // argument, in the words a client reads.
    expect(c.explanation, "the two facts that share one silence").toMatch(
      /a site with no duplicate headings and a crawl that never read any heading/i,
    );
    expect(c.howToFix).toMatch(/re-crawl/i);
  });

  it("sitemap.structure names every column of both its shapes", () => {
    const text = ISSUE_COPY["sitemap.structure"]!.explanation;
    expect(text, "docs").toMatch(/number of documents that contributed at least one entry/i);
    expect(text, "totalUrls").toMatch(/total number of entries stored across them/i);
    expect(text, "oversizedDocsSkipped").toMatch(/dropped whole for being too large to read/i);
    expect(text, "urlCapBreaches").toMatch(/how many documents carry more than the 50,000/i);
    // `entryCapReached` changes what every other number means, so it is copy
    // rather than a footnote.
    expect(text, "entryCapReached").toMatch(/whether the crawl's own entry cap stopped collection/i);
    expect(text, "the floor that implies").toMatch(/a floor rather than a total/i);
    // The per-document row: scope value, urls, breaches50k.
    expect(text, "the doc row's identity").toMatch(/named by the URL it was fetched from/i);
    expect(text, "urls").toMatch(/how many entries it contributed/i);
    expect(text, "breaches50k").toMatch(/whether that is past 50,000/i);
    // Both caps are the rule's own constants.
    expect(SITEMAP_URL_CAP).toBe(50_000);
    expect(text, "the protocol cap").toContain("50,000");
    expect(SITEMAP_DOC_ROWS_CAP).toBe(50);
    expect(text, "the listing cap").toMatch(
      new RegExp(`largest ${SITEMAP_DOC_ROWS_CAP} documents are listed`, "i"),
    );
  });

  // The render diff rules' thresholds, pinned against the rules' own constants
  // exactly as the on-page ones are. These matter more than most: all three
  // fire on a comparison, and copy quoting a threshold the rule does not use
  // would describe a different, usually more sensitive, rule than the one that
  // produced the finding a client is reading.
  it("quotes the render diff thresholds the rules actually use", () => {
    const csr = ISSUE_COPY["content.csr-dependent"]!.explanation;
    expect(CSR_WORD_MULTIPLE).toBe(2);
    expect(csr, "the ratio arm").toMatch(/at least twice as many words/i);
    expect(csr, "the floor arm").toContain(`${CSR_MIN_ADDED_WORDS} words`);

    const nav = ISSUE_COPY["nav.js-only"]!.explanation;
    expect(nav, "the raw ceiling").toMatch(new RegExp(`fewer than ${NAV_RAW_MAX} links\\b`));
    expect(nav, "the rendered floor").toMatch(new RegExp(`at least ${NAV_RENDERED_MIN}\\b`));
    expect(NAV_RENDERED_MULTIPLE).toBe(2);
    expect(nav, "the ratio").toMatch(/at least twice as many as the HTML held/i);

    const filters = ISSUE_COPY["filters.js-only"]!.explanation;
    expect(filters, "the rendered floor").toMatch(
      new RegExp(`at least ${FILTER_RENDERED_MIN} of them`),
    );
    // The predicate is half the finding: a reader who cannot tell what counted
    // as a filter link cannot check the claim against their own page.
    expect(filters, "the `?` arm").toMatch(/query string/i);
    expect(filters, "the regex arm").toMatch(/filter, facet or sort/i);
  });

  // The standing accuracy constraint on this group, asserted negatively for the
  // reason the other negative guards are: prose that already says the right
  // thing can have the overclaim appended to it. Google renders, on a schedule
  // and a budget nobody outside Google can measure; what these rules establish
  // is that the content is not in the first response, which is a cost and a
  // risk rather than an invisibility.
  it("the render diff copy does not claim search engines cannot see the page", () => {
    for (const id of ["content.csr-dependent", "nav.js-only", "filters.js-only", "redirect.js"]) {
      const c = ISSUE_COPY[id]!;
      const overclaim =
        /(?:search engines|google|crawlers) (?:cannot|can't|will never|do not|don't) (?:see|index|read|find)|invisible to (?:search engines|google)|never indexed|will not be indexed/i;
      expect(`${c.title} ${c.explanation} ${c.howToFix}`, id).not.toMatch(overclaim);
    }
  });

  // The metric-copy column contract again, for the Phase 5 metric. Its shape is
  // two-sided — what the selection decided, and what the page rows now hold —
  // and the prose has to name both sides plus the reason they can disagree,
  // because a reader who takes them for one set of numbers will read a
  // legitimate difference as an error.
  it("render.coverage names every column of its shape and both of its sides", () => {
    const text = ISSUE_COPY["render.coverage"]!.explanation;
    expect(text, "pagesCrawled").toMatch(/how many pages the crawl read in total/i);
    expect(text, "selectionMode").toMatch(/the selection mode, which says who chose the pages/i);
    expect(text, "selectionBudget").toMatch(/how many pages the render pass was allowed to open/i);
    expect(text, "selectionSuspects").toMatch(/how many candidates were suspects/i);
    expect(text, "selectionSampled").toMatch(/how many were sampled/i);
    expect(text, "selectionSelected").toMatch(/how many were selected in the end/i);
    expect(text, "selectionTruncated").toMatch(/whether the selection was truncated/i);
    expect(text, "pagesRendered").toMatch(/how many pages are recorded as rendered/i);
    expect(text, "renderFailures").toMatch(/how many render failures were recorded/i);
    // The asymmetry the rule deliberately does not assert away.
    expect(text, "the two sides need not agree").toMatch(
      /need not add up to the number selected/i,
    );
    // P8-T2. The four automatic numbers are NULL on an explicit selection, and
    // the copy has to say so where the reader meets them — a null in a table
    // that nothing explains is read as a zero, and "0 suspects" is a claim about
    // the site's HTML that no explicit pass ever made.
    expect(text, "the explicit case's nulls").toMatch(/empty rather than zero/i);
  });

  // A metric states what was counted; it does not accuse the site of anything.
  // "Fix" language in a table's copy would turn a distribution into a fault
  // list, and the numbers at the bottom of a distribution are frequently fine.
  it("the metric copy describes a measurement rather than a defect", () => {
    for (const id of [...PHASE_4_METRIC_IDS, ...PHASE_5_METRIC_IDS]) {
      const c = ISSUE_COPY[id]!;
      const asFault =
        /this (?:is a|indicates a) (?:problem|fault|error)|must be fixed|you must fix|is broken|penalis|penaliz/i;
      expect(`${c.title} ${c.explanation} ${c.howToFix}`, id).not.toMatch(asFault);
    }
  });

  it("headings.h1-multiple does not claim a ranking penalty", () => {
    const c = ISSUE_COPY["headings.h1-multiple"]!;
    // Multiple H1s are valid HTML and are not a ranking problem; the finding
    // is about the outline and the likely templating accident.
    const overclaim =
      /dilut|penalt|hurts? (?:your )?rank|lower(?:s|ing)? (?:your )?rank|damages? (?:your )?rank/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });
});

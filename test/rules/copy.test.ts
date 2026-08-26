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
  NEAR_DUPLICATE_HAMMING,
  SOFT_404_WORDS,
} from "../../src/rules/query/content.js";
import { BREADCRUMB_PAGE_FLOOR } from "../../src/rules/query/structured-data.js";
import {
  EXTREMES_LIST_CAP,
  SOURCE_TYPE_CAP,
} from "../../src/rules/metric/link-metrics.js";

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
];

const ALL_RULE_IDS = [...PHASE_2_RULE_IDS, ...PHASE_3_RULE_IDS, ...PHASE_4_METRIC_IDS];

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
  });

  // The metric-copy contract is that a reader can say what the table measured
  // from the text alone — so every COLUMN of the value shape has to appear in
  // it. p95 was the one the first draft left out: the number was in the jsonb
  // and nowhere in the prose. Asserted for both distribution metrics, which
  // share the shape, so the same omission cannot recur in the metrics Tasks 5
  // and 6 copy from this pattern.
  it("the distribution copy names every column of the shape, p95 included", () => {
    for (const id of ["inlinks.distribution", "structure.depth-distribution"]) {
      const text = ISSUE_COPY[id]!.explanation;
      expect(text, `${id}: the count`).toMatch(/how many pages were measured/i);
      expect(text, `${id}: min and max`).toMatch(/smallest and largest|shallowest and deepest/i);
      expect(text, `${id}: the mean`).toContain("mean");
      expect(text, `${id}: p25/median/p75`).toContain("quartiles");
      expect(text, `${id}: p95`).toContain("95th percentile");
    }
  });

  // A metric states what was counted; it does not accuse the site of anything.
  // "Fix" language in a table's copy would turn a distribution into a fault
  // list, and the numbers at the bottom of a distribution are frequently fine.
  it("the metric copy describes a measurement rather than a defect", () => {
    for (const id of PHASE_4_METRIC_IDS) {
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

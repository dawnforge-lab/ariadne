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
];

const ALL_RULE_IDS = [...PHASE_2_RULE_IDS, ...PHASE_3_RULE_IDS];

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

  it("headings.h1-multiple does not claim a ranking penalty", () => {
    const c = ISSUE_COPY["headings.h1-multiple"]!;
    // Multiple H1s are valid HTML and are not a ranking problem; the finding
    // is about the outline and the likely templating accident.
    const overclaim =
      /dilut|penalt|hurts? (?:your )?rank|lower(?:s|ing)? (?:your )?rank|damages? (?:your )?rank/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });
});

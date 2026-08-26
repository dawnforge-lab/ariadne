import { describe, expect, it } from "vitest";
import { copyFor, ISSUE_COPY } from "../../src/rules/registry/copy/index.js";

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

describe("issue copy", () => {
  it("throws on an unknown rule id", () => {
    expect(() => copyFor("no.such-rule")).toThrow(/no copy/);
  });

  it("covers every Phase 2 rule id", () => {
    for (const id of PHASE_2_RULE_IDS) {
      expect(() => copyFor(id), id).not.toThrow();
    }
    expect(Object.keys(ISSUE_COPY).sort()).toEqual([...PHASE_2_RULE_IDS].sort());
  });

  it("every entry has substantive, client-facing text", () => {
    for (const [id, c] of Object.entries(ISSUE_COPY)) {
      expect(c.title.length, `${id} title`).toBeGreaterThan(5);
      expect(c.explanation.length, `${id} explanation`).toBeGreaterThan(40);
      expect(c.howToFix.length, `${id} howToFix`).toBeGreaterThan(30);
    }
  });

  // TODO(Task 4): the rule constants (TITLE_MIN/MAX, META_MIN/MAX, THIN_WORDS,
  // and the slow-response / depth thresholds) land with the rules. Re-point
  // these assertions at the imported constants then, so the copy and the rule
  // cannot drift apart; the literal substrings below are a placeholder pin.
  it("quotes thresholds that match the rule constants", () => {
    expect(ISSUE_COPY["title.too-short"]!.explanation).toContain("10 characters");
    expect(ISSUE_COPY["title.too-long"]!.explanation).toContain("60 characters");
    expect(ISSUE_COPY["meta-description.too-short"]!.explanation).toContain(
      "70 characters",
    );
    expect(ISSUE_COPY["meta-description.too-long"]!.explanation).toContain(
      "160 characters",
    );
    expect(ISSUE_COPY["content.thin"]!.explanation).toContain("150 words");
    expect(ISSUE_COPY["performance.slow-response"]!.explanation).toContain("1500ms");
    expect(ISSUE_COPY["structure.deep-page"]!.explanation).toContain(
      "5 links deep",
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

  it("headings.h1-multiple does not claim a ranking penalty", () => {
    const c = ISSUE_COPY["headings.h1-multiple"]!;
    // Multiple H1s are valid HTML and are not a ranking problem; the finding
    // is about the outline and the likely templating accident.
    const overclaim =
      /dilut|penalt|hurts? (?:your )?rank|lower(?:s|ing)? (?:your )?rank|damages? (?:your )?rank/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });
});

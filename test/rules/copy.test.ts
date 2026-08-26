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

  it("does not overpromise what the analyzer detects", () => {
    // content.placeholder matches the literal phrase only.
    expect(ISSUE_COPY["content.placeholder"]!.explanation).toContain("lorem ipsum");
    // images.missing-dimensions is about the absent attribute, not proven CLS.
    expect(ISSUE_COPY["images.missing-dimensions"]!.explanation).toContain(
      "attribute",
    );
  });
});

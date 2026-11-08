import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COPY_TEMPLATES,
  ISSUE_COPY,
  copyFor,
  renderCopy,
} from "../../src/rules/registry/copy/index.js";
import {
  DEFAULT_THRESHOLDS,
  OVERRIDABLE_THRESHOLDS,
  type ThresholdName,
} from "../../src/rules/threshold-table.js";

type Entry = { title: string; explanation: string; howToFix: string };

// The text committed at ruleset 0.22.0, before copy became a template.
const FIXTURE: Record<string, Entry> = JSON.parse(
  readFileSync(new URL("./__fixtures__/issue-copy-0.22.json", import.meta.url), "utf8"),
);

const FIELDS = ["title", "explanation", "howToFix"] as const;

describe("copy rendering (27a T4)", () => {
  it("renders every entry at the defaults exactly as 0.22.0 wrote it", () => {
    expect(Object.keys(COPY_TEMPLATES).sort()).toEqual(Object.keys(FIXTURE).sort());
    for (const id of Object.keys(FIXTURE)) {
      expect(renderCopy(id, DEFAULT_THRESHOLDS), id).toEqual(FIXTURE[id]);
      expect(copyFor(id), id).toEqual(FIXTURE[id]);
    }
    expect(ISSUE_COPY).toEqual(FIXTURE);
  });

  it("only names overridable thresholds in placeholders", () => {
    for (const [id, c] of Object.entries(COPY_TEMPLATES)) {
      for (const f of FIELDS) {
        for (const m of c[f].matchAll(/\{([^}]*)\}/g)) {
          const name = m[1]!.replace(/:n$/, "");
          expect(name in OVERRIDABLE_THRESHOLDS, `${id}.${f} names unknown '${m[1]}'`).toBe(true);
        }
      }
    }
  });

  // Every rule whose title carries an overridable threshold's number, and the
  // placeholder it must use (":n" where the default is written with a comma).
  const IN_TITLE: Record<string, [ThresholdName, boolean]> = {
    "title.too-short": ["TITLE_MIN", false],
    "title.too-long": ["TITLE_MAX", false],
    "meta-description.too-short": ["META_MIN", false],
    "meta-description.too-long": ["META_MAX", false],
    "headings.h1-too-long": ["H1_MAX", false],
    "h2.too-long": ["H2_MAX", false],
    "url.too-long": ["URL_MAX", false],
    "content.thin": ["THIN_WORDS", false],
    "performance.slow-response": ["SLOW_MS", false],
    "structure.deep-page": ["DEEP_DEPTH", false],
    "images.oversized": ["IMAGE_WEIGHT_WARN", true],
    "images.legacy-format": ["IMAGE_WEIGHT_WARN", true],
    "directives.unavailable-after": ["UNAVAILABLE_AFTER_WARN_DAYS", false],
    "content.soft-404": ["SOFT_404_WORDS", false],
    "redirect.chain": ["CHAIN_HOPS", false],
    "links.high-outlinks": ["HIGH_INTERNAL_OUTLINKS", true],
    "title.pixel-too-long": ["TITLE_PX_MAX", false],
    "title.pixel-too-short": ["TITLE_PX_MIN", false],
    "meta-description.pixel-too-long": ["META_PX_MAX", false],
    "meta-description.pixel-too-short": ["META_PX_MIN", false],
  };

  it.each(Object.entries(IN_TITLE))("%s title follows its threshold", (id, [name, comma]) => {
    const shown = comma ? "7,777" : "7777";
    const title = renderCopy(id, { ...DEFAULT_THRESHOLDS, [name]: 7777 }).title;
    expect(title).toContain(shown);
  });

  it("follows HIGH_EXTERNAL_OUTLINKS in the high-outlinks copy", () => {
    const c = renderCopy("links.high-outlinks", { ...DEFAULT_THRESHOLDS, HIGH_EXTERNAL_OUTLINKS: 7777 });
    expect(c.title).toContain("7777 external");
    expect(c.explanation).toContain("more than 7777 different external");
    expect(c.explanation).toContain("7777 is a review threshold");
  });

  it("renders an override into the explanation", () => {
    const c = renderCopy("title.too-long", { ...DEFAULT_THRESHOLDS, TITLE_MAX: 50 });
    expect(c.explanation).toContain("50 characters");
    expect(c.explanation).not.toContain("60 characters");
  });

  it("throws, naming the rule and the placeholder, on an unknown placeholder", () => {
    COPY_TEMPLATES["test.bad-name"] = { title: "t {NOPE}", explanation: "e", howToFix: "f" };
    try {
      expect(() => renderCopy("test.bad-name", DEFAULT_THRESHOLDS)).toThrow(/test\.bad-name.*NOPE/);
    } finally {
      delete COPY_TEMPLATES["test.bad-name"];
    }
  });

  it("throws on a malformed placeholder left after substitution", () => {
    COPY_TEMPLATES["test.bad-form"] = { title: "t {TITLE_MAX:x}", explanation: "e", howToFix: "f" };
    try {
      expect(() => renderCopy("test.bad-form", DEFAULT_THRESHOLDS)).toThrow(/test\.bad-form.*TITLE_MAX:x/);
    } finally {
      delete COPY_TEMPLATES["test.bad-form"];
    }
  });

  it("throws on a rule with no copy", () => {
    expect(() => renderCopy("no.such-rule", DEFAULT_THRESHOLDS)).toThrow(/no\.such-rule/);
  });
});

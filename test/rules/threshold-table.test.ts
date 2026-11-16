/**
 * The overridable thresholds' ranges against the extraction caps (Phase 27a,
 * final review, Ruling 16).
 *
 * `h1.too-long`, `headings.h2-too-long` and `url.too-long` fire on
 * `length > max`, over a value the crawler stored already cut at a cap. A max
 * at (or past) the cap is an override that can never fire: the rule would
 * always pass (hard rule 1). So each range's upper bound sits strictly below
 * the cap on what it measures, read from the cap itself — never restated here.
 */
import { describe, expect, it } from "vitest";

import { MAX_H1_TEXT_CHARS } from "../../src/crawl/parse/page-analyzer.js";
import { H2_TEXT_MAX } from "../../src/crawl/parse/page-facts.js";
import { INDEXED_URL_MAX } from "../../src/crawl/parse/url-utils.js";
import { parseJudgement } from "../../src/rules/judgement.js";
import { buildRegistry } from "../../src/rules/index.js";
import { SCHEMA_TEMPLATE_MIN_PAGES, SCHEMA_TEMPLATE_SHARE } from "../../src/rules/thresholds.js";
import { THRESHOLD_ROWS, type ThresholdName } from "../../src/rules/threshold-table.js";

const CAPPED: readonly (readonly [ThresholdName, string, number])[] = [
  ["H1_MAX", "MAX_H1_TEXT_CHARS", MAX_H1_TEXT_CHARS],
  ["H2_MAX", "H2_TEXT_MAX", H2_TEXT_MAX],
  ["URL_MAX", "INDEXED_URL_MAX", INDEXED_URL_MAX],
];

describe("a threshold measured against a capped value stays below the cap", () => {
  for (const [name, capName, cap] of CAPPED) {
    it(`${name}'s max is below ${capName}, so the rule can still fire at the max`, () => {
      expect(THRESHOLD_ROWS[name].max).toBeLessThan(cap);
      expect(THRESHOLD_ROWS[name].default).toBeLessThan(cap);
    });

    it(`${name} at the cap is refused as out of range`, () => {
      const registry = buildRegistry();
      expect(() => parseJudgement({ thresholds: { [name]: cap } }, registry)).toThrow(
        `thresholds.${name}`,
      );
      expect(parseJudgement({ thresholds: { [name]: cap - 1 } }, registry)).toEqual({
        thresholds: { [name]: cap - 1 },
      });
    });
  }
});

describe("the schema template thresholds (Phase 29a)", () => {
  it("are overridable with the ranges and defaults the rule is specified with", () => {
    expect(THRESHOLD_ROWS.SCHEMA_TEMPLATE_SHARE).toEqual({
      min: 50,
      max: 100,
      default: SCHEMA_TEMPLATE_SHARE,
    });
    expect(THRESHOLD_ROWS.SCHEMA_TEMPLATE_MIN_PAGES).toEqual({
      min: 2,
      max: 100_000,
      default: SCHEMA_TEMPLATE_MIN_PAGES,
    });
    expect([SCHEMA_TEMPLATE_SHARE, SCHEMA_TEMPLATE_MIN_PAGES]).toEqual([70, 10]);
  });

  it("refuse an override outside the range and accept the bounds", () => {
    const registry = buildRegistry();
    for (const [name, lo, hi] of [
      ["SCHEMA_TEMPLATE_SHARE", 50, 100],
      ["SCHEMA_TEMPLATE_MIN_PAGES", 2, 100_000],
    ] as const) {
      expect(() => parseJudgement({ thresholds: { [name]: lo - 1 } }, registry)).toThrow(
        `thresholds.${name}`,
      );
      expect(() => parseJudgement({ thresholds: { [name]: hi + 1 } }, registry)).toThrow(
        `thresholds.${name}`,
      );
      expect(parseJudgement({ thresholds: { [name]: lo } }, registry)).toEqual({
        thresholds: { [name]: lo },
      });
      expect(parseJudgement({ thresholds: { [name]: hi } }, registry)).toEqual({
        thresholds: { [name]: hi },
      });
    }
  });
});

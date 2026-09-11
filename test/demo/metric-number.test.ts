/**
 * THE ONE DECISION THE DEMO MAKES ABOUT A METRIC: how a number is spelled.
 *
 * Everything else in a metric block comes off the wire — the heading, the label,
 * the cell, the order of the blocks (docs/talos-surface.md §4.4b). The page
 * chooses exactly one thing, which is the STRING a served number is printed as,
 * and `test/demo/flow.test.ts` cannot check it: that file reads the page's
 * source and can assert which code path exists, never what it produces. So the
 * two functions are lifted out of the page and run (`./lift.ts`, the technique
 * test/demo/cell-twins.test.ts uses for the findings table's cell).
 *
 * ## Why the sub-one case has a test of its own
 *
 * The formatter shipped with two cases — whole numbers grouped, everything else
 * to one decimal — and one decimal is the wrong precision for the place this
 * engine keeps its ratios: `Text Ratio`'s median is 0.0125 and its minimum
 * 0.0106, and an operator reading the reference crawl saw a column of `0.0`
 * under a heading that had measured something. Printing a measurement as zero is
 * the silent failure hard rule 7 is about, one layer out from the engine, so the
 * cases below are written as the numbers the reference crawl really holds.
 */
import { describe, expect, it } from "vitest";

import { liftFunctions } from "./lift.js";

/** The page's own cell writer, which reaches `metricNumber` for a number. */
const metricCellText = liftFunctions<(value: unknown, label?: string) => string>(
  ["metricCellText", "metricNumber"],
  "metricCellText",
);

/** `metricNumber` alone, for the cases that are about the number and not the cell. */
const metricNumber = liftFunctions<(value: number, label?: string) => string>(
  ["metricNumber"],
  "metricNumber",
);

describe("metricNumber", () => {
  // label, value, printed — every row a number some metric really writes.
  const cases: [string, number, string][] = [
    // WHOLE IS WHOLE. A count is never 435.0.
    ["Pages Judged", 435, "435"],
    ["Pages Judged", 100, "100"],
    ["Pages Judged", 0, "0"],
    // Grouped by hand, at the first boundary and beyond it.
    ["Pages Judged", 1000, "1,000"],
    ["Pages Judged", 1234567, "1,234,567"],
    // BELOW ONE: up to four decimals, trailing zeros trimmed. These are the
    // reference crawl's `Text Ratio` minimum and its `Clean Ratio`.
    ["Min", 0.0106, "0.0106"],
    ["Median", 0.5, "0.5"],
    ["Median", 0.0125, "0.0125"],
    ["Mean", 0.012, "0.012"],
    // Four places is the precision the metrics carry; a fifth rounds into it
    // rather than printing a digit the engine did not measure.
    ["Min", 0.00006, "0.0001"],
    // ONE DECIMAL for everything else — the reference crawl's word-count mean.
    ["Mean", 1009.36, "1,009.4"],
    ["Mean", 719.99, "720.0"],
    // A PERCENTAGE IS ONE DECIMAL WHATEVER IT IS, so a column of them lines up:
    // a whole one keeps its place, and a small one is not four places wide
    // beside it.
    ["Coverage (%)", 12, "12.0"],
    ["Coverage (%)", 12.04, "12.0"],
    ["Within 3 Bits (%)", 0.5, "0.5"],
    ["Redirects (%)", 100, "100.0"],
  ];

  for (const [label, value, printed] of cases) {
    it(`prints ${value} under '${label}' as ${printed}`, () => {
      expect(metricNumber(value, label)).toBe(printed);
      // And through the cell path a row is actually drawn with, which is what
      // `reportTable` calls — the two must not be able to differ.
      expect(metricCellText(value, label)).toBe(printed);
    });
  }

  // A cell with no column behind it is the summary line, which passes the
  // summary's own label; a number with no label at all still prints.
  it("spells a number with no label by the value alone", () => {
    expect(metricNumber(0.0106)).toBe("0.0106");
    expect(metricNumber(1000)).toBe("1,000");
  });
});

describe("metricCellText", () => {
  it("prints a null and an absent key as an empty cell, never a zero", () => {
    expect(metricCellText(null, "Pages Judged")).toBe("");
    expect(metricCellText(undefined, "Documents")).toBe("");
  });

  it("spells a boolean for a reader rather than for the wire", () => {
    expect(metricCellText(true, "Entry Cap Reached")).toBe("Yes");
    expect(metricCellText(false, "Entry Cap Reached")).toBe("No");
  });

  it("prints a string exactly as served", () => {
    expect(metricCellText("(untyped)", "Template")).toBe("(untyped)");
    expect(metricCellText("Site", "Scope")).toBe("Site");
    expect(metricCellText("https://site/sitemap_1.xml", "Sitemap")).toBe(
      "https://site/sitemap_1.xml",
    );
  });

  // A shape the contract does not promise is thrown, not stringified: the
  // block's own error box is where a change of shape belongs (hard rule 7).
  it("throws on a cell that is not a scalar rather than writing [object Object]", () => {
    expect(() => metricCellText({ count: 1 }, "Pages")).toThrow(/neither a string, a number/);
    expect(() => metricCellText([1, 2], "Pages")).toThrow(/neither a string, a number/);
  });
});

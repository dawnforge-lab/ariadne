/**
 * The calibration script's reasons must state facts the run CHECKS. A reason
 * that matched by assumption would explain away a real divergence on a later
 * run and let the script exit 0 over it (hard rule 7). These tests drive the
 * predicates with a hand-built context: no Screaming Frog, no crawl.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  type ReasonContext,
  META_WIDTH_GAP_PX,
  TITLE_WIDTH_GAP_PX,
  assertUnderSfRun,
  measureExplains,
  reasonFor,
  sfExportEmpty,
} from "../../scripts/calibrate-sf.js";

function ctx(over: Partial<ReasonContext> = {}): ReasonContext {
  return {
    siteScheme: "http:",
    sfRowCount: 0,
    sf: () => undefined,
    sfWidth: () => null,
    ourWidth: () => null,
    fired: () => false,
    ...over,
  };
}

/** The filters whose Ariadne-only reason claims Screaming Frog's export is empty. */
const EMPTY_EXPORT_FILTERS = [
  "Canonicals:Unlinked",
  "Hreflang:Unlinked hreflang URLs",
  "Hreflang:Self Reference Only",
  "Pagination:Pagination Loop",
  "Links:Non-Indexable Page Inlinks Only",
  "Links:Pages With High Crawl Depth",
];

describe("the calibration reasons", () => {
  it("explains an Ariadne-only URL as 'analysis off' only when the filter's SF export is empty", () => {
    expect(sfExportEmpty("/x", ctx({ sfRowCount: 0 }))).toBe(true);
    expect(sfExportEmpty("/x", ctx({ sfRowCount: 1 }))).toBe(false);
    for (const filter of EMPTY_EXPORT_FILTERS) {
      expect(reasonFor(filter, "ariadne-only", "/authored26/x", ctx({ sfRowCount: 0 })), filter).toMatch(
        /export is empty/,
      );
      // An analysis-on re-run: SF lists something, so a URL only we list is a
      // real divergence and must stay unexplained.
      expect(reasonFor(filter, "ariadne-only", "/authored26/x", ctx({ sfRowCount: 3 })), filter).toBeNull();
    }
  });

  it("explains a title divergence as the measurement only when the bound lies between the widths and the gap is small", () => {
    const at = (sfw: number, ours: number): ReasonContext =>
      ctx({ sfWidth: () => sfw, ourWidth: () => ours });
    // SF 569 > 561, ours 559.1 <= 561, 9.9 px apart: the measure.
    expect(measureExplains("title", 561, "over", "sf-only", "/t", at(569, 559.1))).toBe(true);
    // The same SF verdict with our width far below: a serpWidth regression, not the measure.
    expect(measureExplains("title", 561, "over", "sf-only", "/t", at(569, 569 - TITLE_WIDTH_GAP_PX - 1))).toBe(false);
    // Our width also over the bound: then we should have flagged it; not the measure.
    expect(measureExplains("title", 561, "over", "sf-only", "/t", at(569, 562))).toBe(false);
    // No width on one side (no title stored): not the measure.
    expect(measureExplains("title", 561, "over", "sf-only", "/t", ctx({ sfWidth: () => 569 }))).toBe(false);
    // The lower bound, Ariadne only: ours 199 < 200, SF 203 >= 200.
    expect(measureExplains("title", 200, "below", "ariadne-only", "/t", at(203, 199))).toBe(true);
    expect(reasonFor("Page Titles:Over X Pixels", "sf-only", "/t", at(569, 559.1))).toMatch(/Width measurement/);
    expect(reasonFor("Page Titles:Over X Pixels", "sf-only", "/t", at(569, 540))).toBeNull();
  });

  it("explains a description divergence as the measurement only within the description gap", () => {
    const at = (sfw: number, ours: number): ReasonContext =>
      ctx({ sfWidth: () => sfw, ourWidth: () => ours });
    expect(measureExplains("description", 985, "over", "ariadne-only", "/m", at(985, 985.1))).toBe(true);
    expect(
      measureExplains("description", 985, "over", "ariadne-only", "/m", at(985 - META_WIDTH_GAP_PX - 1, 985.1)),
    ).toBe(false);
    expect(reasonFor("Meta Description:Below X Pixels", "ariadne-only", "/m", at(400, 399.1))).toMatch(
      /Measurement at the bound/,
    );
  });

  it("never explains a miss on the external private-address page as the loopback site", () => {
    expect(reasonFor("Links:Outlinks To Localhost", "sf-only", "/authored26/nofollow", ctx())).toMatch(/127\.0\.0\.1/);
    expect(reasonFor("Links:Outlinks To Localhost", "sf-only", "/authored26/private-host-link", ctx())).toBeNull();
  });

  it("explains the HTTPS-only filters only on a plain-HTTP crawl", () => {
    expect(reasonFor("Security:HTTP URLs", "sf-only", "/x", ctx({ siteScheme: "http:" }))).toMatch(/HTTPS-only/);
    expect(reasonFor("Security:HTTP URLs", "sf-only", "/x", ctx({ siteScheme: "https:" }))).toBeNull();
  });
});

describe("the calibration output directory", () => {
  const sfRun = join(
    fileURLToPath(new URL("../..", import.meta.url)),
    ".superpowers/sdd/2026-11-05-phase-26a-rules-over-existing-data/sf-run",
  );

  it("accepts the git-ignored sf-run workspace and a run directory under it", () => {
    expect(assertUnderSfRun(sfRun)).toBe(sfRun);
    expect(assertUnderSfRun(join(sfRun, "run-x"))).toBe(join(sfRun, "run-x"));
  });

  it("refuses a path outside it, a sibling that shares its prefix, and a traversal out of it", () => {
    expect(() => assertUnderSfRun(fileURLToPath(new URL("../../docs/gates", import.meta.url)))).toThrow(/refusing/);
    expect(() => assertUnderSfRun(`${sfRun}-copy`)).toThrow(/refusing/);
    expect(() => assertUnderSfRun(join(sfRun, "..", "..", "..", "..", "docs"))).toThrow(/refusing/);
  });
});

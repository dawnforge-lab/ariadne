import { describe, expect, it } from "vitest";
import {
  DEEP_DEPTH,
  SLOW_MS,
  technicalRules,
} from "../../src/rules/page/technical.js";
import { expectSilentOnNonOkFetches, mkPage, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(technicalRules, "technicalRules");

/**
 * One page shape that fires all five technical rules on a 200: no viewport, an
 * image short of both attributes, a slow first byte and a page buried deep.
 */
const BROKEN_TECHNICALS = [
  {
    hasViewport: false,
    imagesMissingDimensions: 2,
    imagesMissingAlt: 1,
    responseTimeMs: 4000,
    depth: 9,
  },
];

describe("technicalRules metadata", () => {
  it("defines exactly the five technical rules of the Phase 2 table", () => {
    expect(technicalRules.map((r) => r.id).sort()).toEqual(
      [
        "mobile.viewport-missing",
        "images.missing-dimensions",
        "images.missing-alt",
        "performance.slow-response",
        "structure.deep-page",
      ].sort(),
    );
  });

  it("claims exactly the checklist ids the table assigns", () => {
    expect(Object.fromEntries(technicalRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "mobile.viewport-missing": ["CHECK-52"],
      "images.missing-dimensions": ["CHECK-49"],
      "images.missing-alt": ["CHECK-49"],
      "performance.slow-response": ["CHECK-50"],
      "structure.deep-page": ["CHECK-31"],
    });
  });

  it("carries the severities the table assigns", () => {
    expect(Object.fromEntries(technicalRules.map((r) => [r.id, r.severity]))).toEqual({
      "mobile.viewport-missing": "warning",
      "images.missing-dimensions": "info",
      "images.missing-alt": "info",
      "performance.slow-response": "info",
      "structure.deep-page": "info",
    });
  });

  it("every rule is a page rule carrying copy and a ruleset version", () => {
    for (const r of technicalRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("no rule fires on the clean page", () => {
    for (const r of technicalRules) expect(r.run(mkPage()), r.id).toHaveLength(0);
  });

  it("no rule fires on a page that was not fetched as a 200 OK", () => {
    expectSilentOnNonOkFetches(technicalRules, BROKEN_TECHNICALS);
  });
});

describe("mobile.viewport-missing", () => {
  it("fires when the page declares no viewport meta tag", () => {
    const f = rule("mobile.viewport-missing").run(mkPage({ hasViewport: false }));
    expect(f).toHaveLength(1);
    expect(f[0]!.ruleId).toBe("mobile.viewport-missing");
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.dedupeKey).toBe("https://example.com/page");
    // The rule knows only that the tag is absent; it has nothing to report about
    // a tag it never saw.
    expect(f[0]!.evidence).toEqual({});
  });

  it("is silent when a viewport tag is present", () => {
    expect(rule("mobile.viewport-missing").run(mkPage({ hasViewport: true }))).toHaveLength(0);
  });
});

describe("images.missing-dimensions", () => {
  it("fires when at least one image lacks a width or height attribute", () => {
    const f = rule("images.missing-dimensions").run(
      mkPage({ imagesTotal: 8, imagesMissingDimensions: 3 }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toEqual({ imagesMissingDimensions: 3, imagesTotal: 8 });
  });

  it("boundary: 1 fires, 0 does not", () => {
    expect(
      rule("images.missing-dimensions").run(mkPage({ imagesMissingDimensions: 1 })),
    ).toHaveLength(1);
    expect(
      rule("images.missing-dimensions").run(mkPage({ imagesMissingDimensions: 0 })),
    ).toHaveLength(0);
  });

  it("is silent on a page with no images at all", () => {
    expect(
      rule("images.missing-dimensions").run(
        mkPage({ imagesTotal: 0, imagesMissingDimensions: 0 }),
      ),
    ).toHaveLength(0);
  });
});

describe("images.missing-alt", () => {
  it("fires when at least one image has no alt attribute", () => {
    const f = rule("images.missing-alt").run(mkPage({ imagesTotal: 4, imagesMissingAlt: 2 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toEqual({ imagesMissingAlt: 2, imagesTotal: 4 });
  });

  it("boundary: 1 fires, 0 does not", () => {
    expect(rule("images.missing-alt").run(mkPage({ imagesMissingAlt: 1 }))).toHaveLength(1);
    expect(rule("images.missing-alt").run(mkPage({ imagesMissingAlt: 0 }))).toHaveLength(0);
  });

  it("is independent of the dimensions rule", () => {
    const page = mkPage({ imagesMissingAlt: 2, imagesMissingDimensions: 0 });
    expect(rule("images.missing-alt").run(page)).toHaveLength(1);
    expect(rule("images.missing-dimensions").run(page)).toHaveLength(0);
  });
});

describe("performance.slow-response", () => {
  it("fires on a response slower than the threshold and reports both numbers", () => {
    const f = rule("performance.slow-response").run(mkPage({ responseTimeMs: 3200 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toEqual({ responseTimeMs: 3200, threshold: SLOW_MS });
  });

  it("boundary: 1501ms fires, 1500ms does not", () => {
    expect(SLOW_MS).toBe(1500);
    expect(
      rule("performance.slow-response").run(mkPage({ responseTimeMs: SLOW_MS + 1 })),
    ).toHaveLength(1);
    expect(
      rule("performance.slow-response").run(mkPage({ responseTimeMs: SLOW_MS })),
    ).toHaveLength(0);
  });

  // A page whose timing was never recorded is unknown, not fast: a rule that
  // fired on it would be reporting a number it does not have.
  it("is silent when the response time is unknown", () => {
    expect(
      rule("performance.slow-response").run(mkPage({ responseTimeMs: null })),
    ).toHaveLength(0);
  });
});

describe("structure.deep-page", () => {
  it("fires on a page deeper than the threshold and reports both numbers", () => {
    const f = rule("structure.deep-page").run(mkPage({ depth: 11 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toEqual({ depth: 11, threshold: DEEP_DEPTH });
  });

  it("boundary: depth 6 fires, depth 5 does not", () => {
    expect(DEEP_DEPTH).toBe(5);
    expect(rule("structure.deep-page").run(mkPage({ depth: DEEP_DEPTH + 1 }))).toHaveLength(1);
    expect(rule("structure.deep-page").run(mkPage({ depth: DEEP_DEPTH }))).toHaveLength(0);
  });

  it("is silent on the seed and the shallow pages under it", () => {
    for (const depth of [0, 1, 2, 3, 4]) {
      expect(rule("structure.deep-page").run(mkPage({ depth })), `depth ${depth}`)
        .toHaveLength(0);
    }
  });
});

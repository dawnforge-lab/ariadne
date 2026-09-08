import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/rules/index.js";
import { SLOW_MS, technicalRules } from "../../src/rules/page/technical.js";
import { expectSilentOnNonOkFetches, mkPage, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(technicalRules, "technicalRules");

/**
 * One page shape that fires all four technical rules on a 200: no viewport, an
 * image short of both attributes, and a slow first byte.
 */
const BROKEN_TECHNICALS = [
  {
    hasViewport: false,
    imagesMissingDimensions: 2,
    imagesMissingAlt: 1,
    responseTimeMs: 4000,
  },
];

/**
 * `structure.deep-page` was the fifth rule here and its pins moved with it, to
 * test/rules/link-graph-query.test.ts (Phase 9). It is a QUERY rule now: the
 * depth it reports is `pages.click_depth`, written by a derivation that runs
 * after the page cursor, so the page rule could only ever read last run's value
 * — or null, and pass, on a crawl's first judgement.
 */
describe("technicalRules metadata", () => {
  it("defines exactly the four technical page rules", () => {
    expect(technicalRules.map((r) => r.id).sort()).toEqual(
      [
        "mobile.viewport-missing",
        "images.missing-dimensions",
        "images.missing-alt",
        "performance.slow-response",
      ].sort(),
    );
  });

  it("claims exactly the checklist ids the table assigns", () => {
    expect(Object.fromEntries(technicalRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "mobile.viewport-missing": ["CHECK-52"],
      "images.missing-dimensions": ["CHECK-49"],
      "images.missing-alt": ["CHECK-49"],
      "performance.slow-response": ["CHECK-50"],
    });
  });

  it("carries the severities the table assigns", () => {
    expect(Object.fromEntries(technicalRules.map((r) => [r.id, r.severity]))).toEqual({
      "mobile.viewport-missing": "critical",
      "images.missing-dimensions": "info",
      "images.missing-alt": "warning",
      "performance.slow-response": "warning",
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
    expect(f[0]!.severity).toBe(rule("mobile.viewport-missing").severity);
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
    expect(f[0]!.severity).toBe(rule("images.missing-alt").severity);
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
    expect(f[0]!.severity).toBe(rule("performance.slow-response").severity);
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

// No page rule reads `depth` any more, and that is asserted rather than left to
// the id list above: discovery depth records where the CRAWLER found a URL —
// every sitemap entry is enqueued as a seed — so a rule judging the site on it
// is judging the crawl. The rule that used to is now a query rule over
// `click_depth`, with its pins in test/rules/link-graph-query.test.ts.
//
// EVERY page rule in the registry, not just this file's four: the claim is about
// the kind, so a depth-reading rule added under any other module fails here too.
describe("the depth a page rule may read", () => {
  it("is none: no page rule in the registry fires on discovery depth alone", () => {
    const pageRules = buildRegistry().byKind("page");
    // The set is not empty, so the loop below is an assertion rather than a
    // vacuous pass over nothing.
    expect(pageRules.length).toBeGreaterThan(0);
    for (const r of pageRules) {
      expect(r.run(mkPage({ depth: 11 })), r.id).toHaveLength(0);
    }
  });
});

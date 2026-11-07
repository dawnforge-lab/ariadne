import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/rules/index.js";
import { IMAGE_ALT_MAX } from "../../src/rules/thresholds.js";
import { SLOW_MS, technicalRules } from "../../src/rules/page/technical.js";
import {
  expectSilentOnNonOkFetches,
  expectSilentOnNotJudged,
  mkPage,
  mkV1Page,
  ruleLookup,
} from "./mk-page.js";

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
    imagesEmptyAlt: 1,
    imagesAltTooLong: 1,
    insecureRefs: { iframe: 0, media: 0, formAction: 0, forms: 1, sample: [] },
    url: "http://example.com/page",
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
  it("defines exactly the seven technical page rules", () => {
    expect(technicalRules.map((r) => r.id).sort()).toEqual(
      [
        "mobile.viewport-missing",
        "images.missing-dimensions",
        "images.missing-alt",
        "images.empty-alt",
        "images.alt-too-long",
        "security.form-insecure",
        "performance.slow-response",
      ].sort(),
    );
  });

  it("claims exactly the checklist ids the table assigns", () => {
    expect(Object.fromEntries(technicalRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "mobile.viewport-missing": ["CHECK-52"],
      "images.missing-dimensions": ["CHECK-49"],
      "images.missing-alt": ["CHECK-49"],
      "images.empty-alt": ["CHECK-49"],
      "images.alt-too-long": ["CHECK-49"],
      "security.form-insecure": ["CHECK-85"],
      "performance.slow-response": ["CHECK-50"],
    });
  });

  it("carries the severities the table assigns", () => {
    expect(Object.fromEntries(technicalRules.map((r) => [r.id, r.severity]))).toEqual({
      "mobile.viewport-missing": "critical",
      "images.missing-dimensions": "info",
      "images.missing-alt": "warning",
      "images.empty-alt": "info",
      "images.alt-too-long": "info",
      "security.form-insecure": "warning",
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

  it("no rule fires on a v1 row (every 26b column null)", () => {
    for (const r of technicalRules) expect(r.run(mkV1Page()), r.id).toHaveLength(0);
  });

  // PHASE 22 §1: the judged cohort's other two exclusions. A missing viewport
  // on a page nothing indexes is a fact about a URL nobody is served.
  // `security.form-insecure` is `isAuditable`, not `isJudged`: a form is a fault
  // of any auditable page, so it is outside this sweep and has its own test.
  it("no judged rule fires on a 200 that is noindexed or canonicalised elsewhere", () => {
    expectSilentOnNotJudged(
      technicalRules.filter((r) => r.id !== "security.form-insecure"),
      BROKEN_TECHNICALS,
    );
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
    expect(f[0]!.evidence).toEqual({ imagesMissingAlt: 2, imagesTotal: 4, sample: [] });
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

describe("images.missing-alt sample (26b)", () => {
  it("carries the stored sample as an optional column when it is recorded", () => {
    const r = rule("images.missing-alt");
    const f = r.run(mkPage({ imagesMissingAlt: 2, imagesMissingAltSample: ["/a.png", "/b.png"] }));
    expect(f[0]!.evidence).toEqual({
      imagesMissingAlt: 2,
      imagesTotal: 5,
      sample: ["/a.png", "/b.png"],
    });
    expect(r.columns.find((c) => c.key === "sample")).toEqual({
      key: "sample",
      label: "Images Missing Alt (sample)",
      optional: true,
    });
  });

  it("a v1 row has no sample key at all", () => {
    const f = rule("images.missing-alt").run(mkV1Page({ imagesMissingAlt: 2 }));
    expect(f).toHaveLength(1);
    expect(Object.keys(f[0]!.evidence)).toEqual(["imagesMissingAlt", "imagesTotal"]);
  });
});

describe("images.empty-alt", () => {
  const r = rule("images.empty-alt");
  it("fires on a positive count and carries the total", () => {
    const f = r.run(mkPage({ imagesEmptyAlt: 3, imagesTotal: 7 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toEqual({ imagesEmptyAlt: 3, imagesTotal: 7 });
  });
  it("is silent at zero, on a v1 row, and on a page nothing indexes", () => {
    expect(r.run(mkPage({ imagesEmptyAlt: 0 }))).toEqual([]);
    expect(r.run(mkV1Page())).toEqual([]);
    expect(r.run(mkPage({ imagesEmptyAlt: 3, robotsMeta: "noindex", isIndexable: false }))).toEqual([]);
  });
});

describe("images.alt-too-long", () => {
  const r = rule("images.alt-too-long");
  it("fires on a positive count and carries the limit", () => {
    const f = r.run(mkPage({ imagesAltTooLong: 2 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toEqual({ imagesAltTooLong: 2, max: IMAGE_ALT_MAX });
    expect(IMAGE_ALT_MAX).toBe(100);
  });
  it("is silent at zero, on a v1 row, and on a page nothing indexes", () => {
    expect(r.run(mkPage({ imagesAltTooLong: 0 }))).toEqual([]);
    expect(r.run(mkV1Page())).toEqual([]);
    expect(r.run(mkPage({ imagesAltTooLong: 2, robotsMeta: "noindex", isIndexable: false }))).toEqual([]);
  });
});

describe("security.form-insecure", () => {
  const r = rule("security.form-insecure");
  const refs = (o: Partial<{ formAction: number; forms: number }>) => ({
    iframe: 0, media: 0, formAction: 0, forms: 0, sample: [] as { kind: "form"; url: string }[], ...o,
  });

  it("fires on an http page with a form, with no formAction or sample keys when there are none", () => {
    const f = r.run(mkPage({ url: "http://example.com/contact", insecureRefs: refs({ forms: 2 }) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toEqual({ pageScheme: "http", forms: 2 });
  });

  it("fires on an https page whose form posts to http, listing only form entries", () => {
    const f = r.run(
      mkPage({
        insecureRefs: {
          iframe: 1, media: 0, formAction: 1, forms: 3,
          sample: [
            { kind: "iframe", url: "http://x.example/frame" },
            { kind: "form", url: "http://x.example/post" },
          ],
        },
      }),
    );
    expect(f[0]!.evidence).toEqual({
      pageScheme: "https",
      formAction: 1,
      forms: 3,
      sample: ["http://x.example/post"],
    });
  });

  it("is silent on an https page with forms but no http action", () => {
    expect(r.run(mkPage({ insecureRefs: refs({ forms: 2 }) }))).toEqual([]);
  });

  it("is silent on an http page with no form, and on a v1 row", () => {
    expect(r.run(mkPage({ url: "http://example.com/a", insecureRefs: refs({}) }))).toEqual([]);
    expect(r.run(mkV1Page({ url: "http://example.com/a" }))).toEqual([]);
  });

  it("still fires on an auditable page nothing indexes (isAuditable, not isJudged)", () => {
    const f = r.run(
      mkPage({
        url: "http://example.com/a",
        robotsMeta: "noindex",
        isIndexable: false,
        insecureRefs: refs({ forms: 1 }),
      }),
    );
    expect(f).toHaveLength(1);
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

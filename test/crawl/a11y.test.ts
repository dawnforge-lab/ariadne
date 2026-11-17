/**
 * The accessibility run's pure half (Phase 29b, src/crawl/render/a11y.ts): the
 * pinned axe-core, the 25-rule subset, and the shaping of an axe result into
 * the rows `render_a11y` stores. The run itself is renderer.test.ts's.
 *
 * The one browser here asks the PINNED axe which rules it has, so a rule id
 * this subset names and the package does not is a failing test, never a rule
 * that silently runs nothing.
 */
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  A11Y_RULES,
  A11Y_TARGETS_MAX,
  A11Y_TARGET_CHARS,
  AXE_RUN_OPTIONS,
  AXE_TIMEOUT_MS,
  axeSource,
  shapeAxeResults,
} from "../../src/crawl/render/a11y.js";

const require = createRequire(import.meta.url);

describe("the pinned axe-core", () => {
  it("is exactly 4.14.0", () => {
    expect((require("axe-core/package.json") as { version: string }).version).toBe("4.14.0");
  });

  it("is read once and memoised", () => {
    const first = axeSource();
    expect(first.length).toBeGreaterThan(100_000);
    expect(first).toContain("axe");
    // The same string object, not a second read of the file.
    expect(axeSource()).toBe(first);
  });

  it("pins the time budget and the target caps", () => {
    expect(AXE_TIMEOUT_MS).toBe(30_000);
    expect(A11Y_TARGETS_MAX).toBe(5);
    expect(A11Y_TARGET_CHARS).toBe(200);
  });

  it("runs exactly the subset, violations only, with selectors and no element refs", () => {
    expect(AXE_RUN_OPTIONS).toEqual({
      runOnly: { type: "rule", values: A11Y_RULES.map((r) => r.axeId) },
      resultTypes: ["violations"],
      iframes: false,
      elementRef: false,
      selectors: true,
      ancestry: false,
      xpath: false,
    });
  });
});

describe("A11Y_RULES", () => {
  it("is the 25 rules in order, with their group, severity and WCAG level", () => {
    expect(A11Y_RULES.map((r) => [r.group, r.axeId, r.severity, r.wcag])).toEqual([
      ["Text alternatives", "image-alt", "warning", "A"],
      ["Text alternatives", "input-image-alt", "warning", "A"],
      ["Text alternatives", "role-img-alt", "warning", "A"],
      ["Text alternatives", "area-alt", "warning", "A"],
      ["Text alternatives", "object-alt", "warning", "A"],
      ["Names", "link-name", "warning", "A"],
      ["Names", "button-name", "warning", "A"],
      ["Names", "input-button-name", "warning", "A"],
      ["Names", "select-name", "warning", "A"],
      ["Names", "label", "warning", "A"],
      ["Names", "frame-title", "warning", "A"],
      ["Language", "document-title", "warning", "A"],
      ["Language", "html-has-lang", "warning", "A"],
      ["Language", "html-lang-valid", "warning", "A"],
      ["Language", "valid-lang", "warning", "AA"],
      ["Behaviour", "meta-viewport", "info", "AA"],
      ["Behaviour", "meta-refresh", "warning", "A"],
      ["ARIA", "aria-hidden-focus", "warning", "A"],
      ["ARIA", "aria-required-attr", "warning", "A"],
      ["ARIA", "aria-valid-attr", "warning", "A"],
      ["ARIA", "aria-valid-attr-value", "warning", "A"],
      ["ARIA", "duplicate-id-aria", "warning", "A"],
      ["Structure", "list", "warning", "A"],
      ["Structure", "listitem", "warning", "A"],
      ["Contrast", "color-contrast", "warning", "AA"],
    ]);
  });

  describe("against the pinned axe in a page", () => {
    let browser: Browser;
    let rules: Array<{ ruleId: string; tags: string[] }>;

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent("<!doctype html><html lang=en><title>t</title><body></body></html>");
      await page.addScriptTag({ content: axeSource() });
      rules = (await page.evaluate("axe.getRules()")) as Array<{ ruleId: string; tags: string[] }>;
    }, 60_000);

    afterAll(async () => {
      await browser.close();
    });

    it("names only rules axe has, each tagged at the WCAG level the subset says", () => {
      for (const rule of A11Y_RULES) {
        const known = rules.find((r) => r.ruleId === rule.axeId);
        expect(known, `${rule.axeId} is not an axe 4.14.0 rule`).toBeDefined();
        expect(known!.tags, rule.axeId).toContain(rule.wcag === "A" ? "wcag2a" : "wcag2aa");
      }
    });
  });
});

/**
 * An axe 4.14.0 result, recorded from a real run (shape as `axe.run` resolves
 * it: the run metadata, the four result types, each violation's metadata and
 * each node's checks), trimmed to what the shaping reads plus enough of the
 * rest to prove the rest is ignored.
 */
function recorded(): Record<string, unknown> {
  const node = (target: unknown) => ({
    any: [{ id: "has-alt", data: null, relatedNodes: [], impact: "critical", message: "x" }],
    all: [],
    none: [],
    impact: "critical",
    html: "<img src=\"a.png\">",
    target,
    failureSummary: "Fix any of the following: …",
  });
  return {
    testEngine: { name: "axe-core", version: "4.14.0" },
    testRunner: { name: "axe" },
    testEnvironment: { userAgent: "x", windowWidth: 1280, windowHeight: 900 },
    timestamp: "2026-11-17T10:00:00.000Z",
    url: "http://127.0.0.1/a11y",
    toolOptions: {},
    inapplicable: [{ id: "area-alt", nodes: [] }],
    passes: [{ id: "document-title", nodes: [node(["title"])] }],
    incomplete: [{ id: "color-contrast", nodes: [node(["p"])] }],
    violations: [
      {
        id: "image-alt",
        impact: "critical",
        tags: ["cat.text-alternatives", "wcag2a", "wcag111"],
        description: "Ensure <img> elements have alternative text",
        help: "Images must have alternative text",
        helpUrl: "https://example.invalid/image-alt",
        nodes: [1, 2, 3, 4, 5, 6, 7].map((i) => node([`img[src="${i}.png"]`])),
      },
      {
        id: "button-name",
        impact: "critical",
        tags: ["cat.name-role-value", "wcag2a"],
        nodes: [
          // A shadow DOM path: the host's selector, then the element's inside it.
          node([["#host", "button"]]),
        ],
      },
      {
        id: "html-has-lang",
        impact: null,
        tags: ["cat.language", "wcag2a"],
        nodes: [node([`#${"x".repeat(250)}\u0000`])],
      },
    ],
  };
}

describe("shapeAxeResults", () => {
  it("keeps the violations, counts every node and caps the targets", () => {
    const shaped = shapeAxeResults(recorded());

    expect(shaped.map((v) => v.rule)).toEqual(["image-alt", "button-name", "html-has-lang"]);
    const [imageAlt, buttonName, hasLang] = shaped;
    expect(imageAlt).toEqual({
      rule: "image-alt",
      impact: "critical",
      nodeCount: 7,
      targets: [1, 2, 3, 4, 5].map((i) => `img[src="${i}.png"]`),
    });
    // The shadow path, joined.
    expect(buttonName).toEqual({
      rule: "button-name",
      impact: "critical",
      nodeCount: 1,
      targets: ["#host >>> button"],
    });
    // A selector is the site's text: storable and cut at 200.
    expect(hasLang!.impact).toBeNull();
    expect(hasLang!.targets[0]).toHaveLength(A11Y_TARGET_CHARS);
    expect(hasLang!.targets[0]).toBe(`#${"x".repeat(199)}`);
    expect(shapeAxeResults({ ...recorded(), violations: [] })).toEqual([]);
  });

  it("reads the cut-down wire shape: the in-world count, and the first five nodes only", () => {
    const sent = {
      violations: [
        {
          id: "image-alt",
          impact: "critical",
          nodeCount: 7,
          nodes: [1, 2, 3, 4, 5].map((i) => ({ target: [`img[src="${i}.png"]`] })),
        },
        { id: "label", impact: "critical", nodeCount: 2, nodes: [{ target: ["#a"] }, { target: ["#b"] }] },
      ],
    };
    expect(shapeAxeResults(sent)).toEqual([
      {
        rule: "image-alt",
        impact: "critical",
        nodeCount: 7,
        targets: [1, 2, 3, 4, 5].map((i) => `img[src="${i}.png"]`),
      },
      { rule: "label", impact: "critical", nodeCount: 2, targets: ["#a", "#b"] },
    ]);
  });

  it("makes a selector holding a NUL or a lone surrogate storable", () => {
    const raw = recorded();
    raw["violations"] = [
      { id: "label", impact: "critical", nodes: [{ target: ["#a\u0000b\uD800"] }] },
    ];
    expect(shapeAxeResults(raw)[0]!.targets).toEqual(["#a␀b�"]);
  });

  it("throws on a shape it does not know", () => {
    const bad: Array<[string, unknown]> = [
      ["no object", null],
      ["violations not an array", { violations: {} }],
      ["violations missing", { passes: [] }],
      ["a violation without an id", { violations: [{ impact: "minor", nodes: [] }] }],
      ["a rule outside the subset", { violations: [{ id: "region", impact: "moderate", nodes: [] }] }],
      ["a rule twice", {
        violations: [
          { id: "label", impact: "critical", nodes: [{ target: ["a"] }] },
          { id: "label", impact: "critical", nodes: [{ target: ["b"] }] },
        ],
      }],
      ["an impact that is not text", { violations: [{ id: "label", impact: 3, nodes: [] }] }],
      ["nodes not an array", { violations: [{ id: "label", impact: null, nodes: "x" }] }],
      ["a violation with no node", { violations: [{ id: "label", impact: null, nodes: [] }] }],
      ["a nodeCount that is not an integer", {
        violations: [{ id: "label", impact: null, nodeCount: "1", nodes: [{ target: ["a"] }] }],
      }],
      ["fewer nodes sent than the count allows", {
        violations: [{ id: "label", impact: null, nodeCount: 7, nodes: [{ target: ["a"] }] }],
      }],
      ["more nodes sent than counted", {
        violations: [{ id: "label", impact: null, nodeCount: 1, nodes: [{ target: ["a"] }, { target: ["b"] }] }],
      }],
      ["a node without a target", { violations: [{ id: "label", impact: null, nodes: [{}] }] }],
      ["an iframe path", { violations: [{ id: "label", impact: null, nodes: [{ target: ["iframe", "a"] }] }] }],
      ["an empty target", { violations: [{ id: "label", impact: null, nodes: [{ target: [] }] }] }],
      ["a selector that is not text", { violations: [{ id: "label", impact: null, nodes: [{ target: [7] }] }] }],
      ["an empty shadow path", { violations: [{ id: "label", impact: null, nodes: [{ target: [[]] }] }] }],
    ];
    for (const [why, raw] of bad) {
      expect(() => shapeAxeResults(raw), why).toThrow(/axe result/);
    }
  });
});

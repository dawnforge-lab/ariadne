/**
 * `html.head-closed-early` and `html.structure-invalid` (Phase 26b, Task 11).
 * The analyzer decides `closedEarly` (see its `htmlStructure` tests); these
 * tests prove the rules read it, using the analyzer's own output for the
 * Review Focus 3 boundary inputs.
 */
import { describe, expect, it } from "vitest";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import { htmlStructureRules } from "../../src/rules/page/html-structure.js";
import type { HtmlStructure } from "../../src/crawl/parse/page-facts.js";
import { ISSUE_COPY } from "../../src/rules/registry/copy/index.js";
import { expectSilentOnNonOkFetches, mkPage, mkV1Page, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(htmlStructureRules, "htmlStructureRules");
const early = rule("html.head-closed-early");
const harmless = rule("html.head-closed-early-harmless");
const invalid = rule("html.structure-invalid");

const OK: HtmlStructure = {
  htmlTags: 1, headTags: 1, bodyTags: 1, headBeforeBody: true, closedEarly: null,
};
const structureOf = (html: string): HtmlStructure =>
  analyzePage(html, "https://x.test/").htmlStructure;
const earlyOn = (html: string) => early.run(mkPage({ htmlStructure: structureOf(html) }));
const harmlessOn = (html: string) => harmless.run(mkPage({ htmlStructure: structureOf(html) }));
/** The standard Meta pixel fallback (owner call O3). */
const PIXEL =
  `<noscript><img height="1" width="1" style="display:none" ` +
  `src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"></noscript>`;

describe("metadata", () => {
  it("declares severities, categories, checks and columns", () => {
    expect([early.kind, early.severity, early.category, early.checkIds]).toEqual([
      "page", "warning", "technical", ["CHECK-18", "CHECK-04", "CHECK-24"],
    ]);
    expect(early.columns).toEqual([
      { key: "tag", label: "Closing Element" },
      { key: "snippet", label: "Element Snippet" },
      { key: "inNoscript", label: "Inside noscript" },
      { key: "lost", label: "Head Tags Lost" },
    ]);
    // Owner call O3: the early close that loses nothing, as an info note with
    // the same checks and category.
    expect([harmless.kind, harmless.severity, harmless.category, harmless.checkIds]).toEqual([
      "page", "info", "technical", ["CHECK-18", "CHECK-04", "CHECK-24"],
    ]);
    expect(harmless.columns).toEqual([
      { key: "tag", label: "Closing Element" },
      { key: "snippet", label: "Element Snippet" },
      { key: "inNoscript", label: "Inside noscript" },
    ]);
    expect([invalid.kind, invalid.severity, invalid.category, invalid.checkIds]).toEqual([
      "page", "info", "technical", ["CHECK-88"],
    ]);
    expect(invalid.columns).toEqual([
      { key: "problems", label: "Problems" },
      { key: "headTags", label: "Head Elements" },
      { key: "bodyTags", label: "Body Elements" },
    ]);
  });
});

describe("html.head-closed-early (Review Focus 3 boundaries)", () => {
  it("is silent on a valid document that omits </head> and starts its body content", () => {
    expect(earlyOn(`<!doctype html><title>x</title><div>a</div>`)).toHaveLength(0);
  });

  it("fires on the GTM shape when head tags follow it, listing what is lost", () => {
    const out = earlyOn(
      `<head><meta charset=utf-8><noscript><iframe src="https://gtm/x"></iframe></noscript>` +
        `<link rel="canonical" href="/c"></head><body>`,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({
      tag: "iframe",
      snippet: '<iframe src="https://gtm/x">',
      inNoscript: true,
      lost: ["link rel=canonical"],
    });
    expect(out[0]!.severity).toBe("warning");
  });

  it("fires on a div before the title", () => {
    const out = earlyOn(`<head><div>x</div><title>t</title>`);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({ tag: "div", inNoscript: false, lost: ["title"] });
  });

  it("text in the head with nothing after it but </head> is the harmless note, not this", () => {
    expect(earlyOn(`<head>hello</head>`)).toHaveLength(0);
    expect(harmlessOn(`<head>hello</head>`)[0]!.evidence).toEqual({
      tag: "#text",
      snippet: "hello",
      inNoscript: false,
    });
  });

  it("caps a 500-character start tag's snippet at 200", () => {
    const tag = `<img alt="${"a".repeat(500)}">`;
    const out = earlyOn(`<head>${tag}<title>t</title></head>`);
    expect(out[0]!.evidence).toMatchObject({ tag: "img" });
    expect((out[0]!.evidence as { snippet: string }).snippet).toHaveLength(200);
  });

  it("needs R8 evidence: a candidate with no later confirmation is silent", () => {
    expect(earlyOn(`<head><div>x</div><p>y</p>`)).toHaveLength(0);
  });

  it("an explicit <body> start tag is never a candidate", () => {
    expect(earlyOn(`<head><title>t</title><body><p>x</p>`)).toHaveLength(0);
  });

  it("a noscript child outside HEAD_ALLOWED is a candidate; a script child is not", () => {
    const meta = `<meta name="description" content="d">`;
    expect(earlyOn(`<head><noscript><iframe src="/f"></iframe></noscript>${meta}`)).toHaveLength(1);
    expect(earlyOn(`<head><noscript><script>1</script></noscript>${meta}`)).toHaveLength(0);
  });

  it("is confirmed by a meta description or a canonical link after the closer, not by a style", () => {
    expect(earlyOn(`<head><div>x</div><meta name="description" content="d">`)).toHaveLength(1);
    expect(earlyOn(`<head><div>x</div><link rel="canonical" href="/c">`)).toHaveLength(1);
    expect(earlyOn(`<head><div>x</div><style>a{}</style>`)).toHaveLength(0);
  });

  it("is silent on a v1 row (null structure) and on every non-OK fetch", () => {
    expect(early.run(mkV1Page())).toHaveLength(0);
    expectSilentOnNonOkFetches([early], [
      {
        htmlStructure: {
          ...OK,
          closedEarly: { tag: "div", snippet: "<div>", inNoscript: false, lost: ["title"] },
        },
      },
    ]);
  });
});

describe("html.head-closed-early-harmless (owner call O3)", () => {
  it("the Meta pixel last in the head is the info note, and not the warning", () => {
    const html =
      `<html><head><title>t</title><meta name="description" content="d">` +
      `<link rel="canonical" href="/c">${PIXEL}</head><body><p>x</p></body></html>`;
    expect(earlyOn(html)).toHaveLength(0);
    const out = harmlessOn(html);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("info");
    expect(out[0]!.evidence).toMatchObject({ tag: "img", inNoscript: true });
    expect(out[0]!.evidence).not.toHaveProperty("lost");
  });

  it("a pixel followed by a description and a canonical is the warning, with both lost", () => {
    const html =
      `<html><head><title>t</title>${PIXEL}<meta name="description" content="d">` +
      `<link rel="canonical" href="/c"></head><body><p>x</p></body></html>`;
    expect(harmlessOn(html)).toHaveLength(0);
    expect(earlyOn(html)[0]!.evidence).toMatchObject({
      tag: "img",
      inNoscript: true,
      lost: ["meta", "link rel=canonical"],
    });
  });

  it("a stylesheet link after the pixel is body-ok: nothing is lost", () => {
    const html =
      `<html><head><title>t</title>${PIXEL}<link rel="stylesheet" href="/a.css">` +
      `</head><body><p>x</p></body></html>`;
    expect(earlyOn(html)).toHaveLength(0);
    expect(harmlessOn(html)).toHaveLength(1);
  });

  it("is silent with no early close, on a v1 row and on every non-OK fetch", () => {
    expect(harmlessOn(`<html><head><title>t</title></head><body></body></html>`)).toHaveLength(0);
    expect(harmless.run(mkV1Page())).toHaveLength(0);
    expectSilentOnNonOkFetches([harmless], [
      {
        htmlStructure: {
          ...OK,
          closedEarly: { tag: "img", snippet: "<img>", inNoscript: true, lost: [] },
        },
      },
    ]);
  });

  it("a v2 row written before `lost` was recorded makes both rules throw, re-crawl", () => {
    // jsonb is not checked against the type: a pre-O3 row has no `lost` key.
    const stale = {
      ...OK,
      closedEarly: { tag: "img", snippet: "<img>", inNoscript: true },
    } as unknown as HtmlStructure;
    const page = mkPage({ htmlStructure: stale });
    expect(() => early.run(page)).toThrow(/re-crawl/);
    expect(() => harmless.run(page)).toThrow(/re-crawl/);
  });
});

describe("html.structure-invalid", () => {
  const evidenceOf = (s: Partial<HtmlStructure>) => {
    const out = invalid.run(mkPage({ htmlStructure: { ...OK, ...s } }));
    return out.length === 0 ? null : out[0]!.evidence;
  };

  it("is silent on a well-formed structure", () => {
    expect(evidenceOf({})).toBeNull();
  });
  it("head-missing", () => {
    expect(evidenceOf({ headTags: 0, headBeforeBody: null })).toEqual({
      problems: ["head-missing"], headTags: 0, bodyTags: 1,
    });
  });
  it("head-repeated", () => {
    expect(evidenceOf({ headTags: 2 })).toEqual({
      problems: ["head-repeated"], headTags: 2, bodyTags: 1,
    });
  });
  it("body-missing", () => {
    expect(evidenceOf({ bodyTags: 0, headBeforeBody: null })).toEqual({
      problems: ["body-missing"], headTags: 1, bodyTags: 0,
    });
  });
  it("body-repeated", () => {
    expect(evidenceOf({ bodyTags: 2 })).toEqual({
      problems: ["body-repeated"], headTags: 1, bodyTags: 2,
    });
  });
  it("head-after-body", () => {
    expect(evidenceOf({ headBeforeBody: false })).toEqual({
      problems: ["head-after-body"], headTags: 1, bodyTags: 1,
    });
  });
  it("lists several problems in a fixed order", () => {
    expect(evidenceOf({ headTags: 0, bodyTags: 3, headBeforeBody: null })).toMatchObject({
      problems: ["head-missing", "body-repeated"],
    });
  });

  it("is silent on a v1 row and on every non-OK fetch", () => {
    expect(invalid.run(mkV1Page())).toHaveLength(0);
    expectSilentOnNonOkFetches([invalid], [
      { htmlStructure: { ...OK, headTags: 0, headBeforeBody: null } },
    ]);
  });

  it("agrees with the analyzer on real documents", () => {
    const run = (html: string) => invalid.run(mkPage({ htmlStructure: structureOf(html) }));
    expect(run(`<html><title>t</title><body>x</body></html>`)).toHaveLength(1);
    expect(run(`<html><head></head><body>a</body><body>b</body></html>`)).toHaveLength(1);
    expect(run(`<html><head></head><body>a</body></html>`)).toHaveLength(0);
  });

  // Ruling R14: a document that leaves out the optional <head> and <body> start
  // tags is valid HTML, and the rule still reports it (info), because nothing in
  // the markup then marks where the head ends. The copy must say exactly that
  // and not call the page broken or invalid.
  it("reports a valid tagless document as head-missing and body-missing, without calling it invalid", () => {
    const out = invalid.run(
      mkPage({ htmlStructure: structureOf(`<!doctype html><title>x</title><p>hi`) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("info");
    expect(out[0]!.evidence).toEqual({
      problems: ["head-missing", "body-missing"], headTags: 0, bodyTags: 0,
    });
    const copy = ISSUE_COPY["html.structure-invalid"]!;
    for (const text of [copy.title, copy.explanation, copy.howToFix]) {
      expect(text).not.toMatch(/\b(invalid|broken)\b/i);
    }
    expect(copy.explanation).toMatch(/optional|valid HTML/);
    expect(copy.howToFix).toMatch(/explicit <head> and <body>/);
  });
});

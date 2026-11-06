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
const invalid = rule("html.structure-invalid");

const OK: HtmlStructure = {
  htmlTags: 1, headTags: 1, bodyTags: 1, headBeforeBody: true, closedEarly: null,
};
const structureOf = (html: string): HtmlStructure =>
  analyzePage(html, "https://x.test/").htmlStructure;
const earlyOn = (html: string) => early.run(mkPage({ htmlStructure: structureOf(html) }));

describe("metadata", () => {
  it("declares severities, categories, checks and columns", () => {
    expect([early.kind, early.severity, early.category, early.checkIds]).toEqual([
      "page", "warning", "technical", ["CHECK-18", "CHECK-04", "CHECK-24"],
    ]);
    expect(early.columns).toEqual([
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

  it("fires on the GTM shape: a noscript iframe in the head, confirmed by </head>", () => {
    const out = earlyOn(
      `<head><meta charset=utf-8><noscript><iframe src="https://gtm/x"></iframe></noscript></head><body>`,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({
      tag: "iframe",
      snippet: '<iframe src="https://gtm/x">',
      inNoscript: true,
    });
    expect(out[0]!.severity).toBe("warning");
  });

  it("fires on a div before the title", () => {
    const out = earlyOn(`<head><div>x</div><title>t</title>`);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({ tag: "div", inNoscript: false });
  });

  it("fires on text in the head, recorded as #text with the text as the snippet", () => {
    const out = earlyOn(`<head>hello</head>`);
    expect(out[0]!.evidence).toEqual({ tag: "#text", snippet: "hello", inNoscript: false });
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
      { htmlStructure: { ...OK, closedEarly: { tag: "div", snippet: "<div>", inNoscript: false } } },
    ]);
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

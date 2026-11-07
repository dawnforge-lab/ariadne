import { describe, expect, it } from "vitest";
import { closedByLabel, headRules } from "../../src/rules/page/head.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
import {
  expectSilentOnNonOkFetches,
  expectSilentOnNotJudged,
  mkPage,
  mkV1Page,
  NOT_JUDGED_200S,
  ruleLookup,
} from "./mk-page.js";

const rule = ruleLookup(headRules, "headRules");
const directives = rule("head.directives-outside-head");
const tags = rule("head.tags-outside-head");

/** A pre-0021 row: the analyzer never measured where the head ended. */
const PRE_0021: Partial<PageRecord> = {
  headClosedBy: null,
  titleOutsideHead: null,
  metaDescriptionOutsideHead: null,
  robotsOutsideHead: null,
  canonicalOutsideHead: null,
  hreflangOutsideHeadCount: null,
};

describe("head rule metadata", () => {
  it("declares the ids, severities, categories, checks and columns the brief names", () => {
    expect(headRules.map((r) => r.id)).toEqual([
      "head.directives-outside-head",
      "head.tags-outside-head",
    ]);
    expect(directives.severity).toBe("critical");
    expect(directives.category).toBe("indexability");
    expect(directives.checkIds).toEqual(["CHECK-18", "CHECK-04", "CHECK-24"]);
    expect(tags.severity).toBe("warning");
    expect(tags.category).toBe("on-page");
    expect(tags.checkIds).toEqual(["CHECK-35", "CHECK-36", "CHECK-87"]);
    for (const r of headRules) {
      expect(r.columns).toEqual([
        { key: "elements", label: "Elements Outside Head" },
        { key: "headClosedBy", label: "Closed By" },
        { key: "headClosedEarly", label: "Head Closed By (element)", optional: true },
      ]);
    }
  });
});

describe("Closed By spelling", () => {
  it("brackets element closers, says text for text, keeps end tags, and </head> for null", () => {
    expect(closedByLabel("img")).toBe("<img>");
    expect(closedByLabel("div")).toBe("<div>");
    expect(closedByLabel("body")).toBe("<body>");
    expect(closedByLabel("#text")).toBe("text");
    expect(closedByLabel("</html>")).toBe("</html>");
    expect(closedByLabel(null)).toBe("</head>");
  });
});

describe("head.directives-outside-head", () => {
  it("is silent on the clean page: closed by </head>, nothing after it", () => {
    expect(directives.run(mkPage())).toHaveLength(0);
  });

  it("reports a canonical after an implicit close, naming the closer", () => {
    const f = directives.run(mkPage({ canonicalOutsideHead: true, headClosedBy: "img" }));
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toEqual({ elements: "canonical", headClosedBy: "<img>" });
    expect(f[0]?.severity).toBe("critical");
  });

  it("shows </head> as the closer when the head was closed explicitly", () => {
    const f = directives.run(mkPage({ robotsOutsideHead: true, headClosedBy: null }));
    expect(f[0]?.evidence).toEqual({ elements: "meta robots", headClosedBy: "</head>" });
  });

  it("lists every directive outside, hreflang with its count, in one row", () => {
    const f = directives.run(
      mkPage({
        canonicalOutsideHead: true,
        robotsOutsideHead: true,
        hreflangOutsideHeadCount: 3,
        headClosedBy: "#text",
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toEqual({
      elements: "canonical, meta robots, hreflang (3)",
      headClosedBy: "text",
    });
  });

  it("fires on hreflang alone and not on a zero count", () => {
    expect(directives.run(mkPage({ hreflangOutsideHeadCount: 1, headClosedBy: "div" })))
      .toHaveLength(1);
    expect(directives.run(mkPage({ hreflangOutsideHeadCount: 0 }))).toHaveLength(0);
  });

  it("does not fire on a title or description outside the head", () => {
    expect(
      directives.run(mkPage({ titleOutsideHead: true, metaDescriptionOutsideHead: true })),
    ).toHaveLength(0);
  });

  it("is silent on a pre-0021 row: null is not measured, never 'inside'", () => {
    expect(directives.run(mkPage(PRE_0021))).toHaveLength(0);
  });

  it("keeps the fetched-OK cohort: fires on noindexed and canonicalised-elsewhere 200s", () => {
    // The point of the cohort: a misplaced noindex or canonical is what makes
    // a page non-judged, so the judged cohort would hide exactly these pages.
    for (const notJudged of NOT_JUDGED_200S) {
      expect(
        directives.run(mkPage({ ...notJudged, canonicalOutsideHead: true })),
        JSON.stringify(notJudged),
      ).toHaveLength(1);
    }
  });

  it("is silent on every non-200 fetch", () => {
    expectSilentOnNonOkFetches([directives], [{ canonicalOutsideHead: true }]);
  });
});

describe("head.tags-outside-head", () => {
  it("is silent on the clean page", () => {
    expect(tags.run(mkPage())).toHaveLength(0);
  });

  it("reports a title outside the head with its closer", () => {
    const f = tags.run(mkPage({ titleOutsideHead: true, headClosedBy: "svg" }));
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toEqual({ elements: "title", headClosedBy: "<svg>" });
    expect(f[0]?.severity).toBe("warning");
  });

  it("reports both tags in one row, </head> when closed explicitly", () => {
    const f = tags.run(mkPage({ titleOutsideHead: true, metaDescriptionOutsideHead: true }));
    expect(f[0]?.evidence).toEqual({
      elements: "title, meta description",
      headClosedBy: "</head>",
    });
  });

  it("names social tags outside the head (26b), after the title and description", () => {
    const social = mkPage().social;
    if (social === null) throw new Error("mkPage's clean page lost its social set");
    const outside = { social: { ...social, outsideHead: true } };
    expect(tags.run(mkPage({ ...outside, headClosedBy: "div" }))[0]?.evidence).toEqual({
      elements: "social",
      headClosedBy: "<div>",
    });
    expect(
      tags.run(mkPage({ ...outside, titleOutsideHead: true, metaDescriptionOutsideHead: true }))[0]
        ?.evidence,
    ).toEqual({ elements: "title, meta description, social", headClosedBy: "</head>" });
  });

  it("is silent on social tags inside the head, and on a v1 row's null social", () => {
    expect(tags.run(mkPage())).toHaveLength(0);
    expect(tags.run(mkV1Page())).toHaveLength(0);
  });

  it("does not fire on directives outside the head", () => {
    expect(
      tags.run(
        mkPage({ canonicalOutsideHead: true, robotsOutsideHead: true, hreflangOutsideHeadCount: 2 }),
      ),
    ).toHaveLength(0);
  });

  it("is silent on a pre-0021 row", () => {
    expect(tags.run(mkPage(PRE_0021))).toHaveLength(0);
  });

  it("is judged-only: silent on non-200s and on noindexed or canonicalised 200s", () => {
    expectSilentOnNonOkFetches([tags], [{ metaDescriptionOutsideHead: true }]);
    expectSilentOnNotJudged([tags], [{ titleOutsideHead: true }]);
  });
});

describe("the head rules name the closing element (26b)", () => {
  const closedEarly = {
    tag: "div",
    snippet: '<div class="promo">',
    inNoscript: false,
    lost: ["title", "link rel=canonical"],
  };
  const structure = {
    htmlTags: 1, headTags: 1, bodyTags: 1, headBeforeBody: true as boolean | null, closedEarly,
  };

  it("carries headClosedEarly {tag, snippet} on a v2 row that has one, on both rules", () => {
    const row = {
      htmlStructure: structure,
      headClosedBy: "div",
      canonicalOutsideHead: true,
      titleOutsideHead: true,
    };
    expect(directives.run(mkPage(row))[0]?.evidence).toEqual({
      elements: "canonical",
      headClosedBy: "<div>",
      headClosedEarly: { tag: "div", snippet: '<div class="promo">' },
    });
    expect(tags.run(mkPage(row))[0]?.evidence).toEqual({
      elements: "title",
      headClosedBy: "<div>",
      headClosedEarly: { tag: "div", snippet: '<div class="promo">' },
    });
  });

  // Owner call O3: an early close that loses nothing is not why anything is
  // outside the head (a tag after the explicit <body> is in the body whatever
  // closed the head), so it is not offered as the explanation.
  it("omits the key when the early close lost nothing, and throws on a pre-O3 row", () => {
    const row = {
      htmlStructure: { ...structure, closedEarly: { ...closedEarly, lost: [] } },
      headClosedBy: "div",
      canonicalOutsideHead: true,
      titleOutsideHead: true,
    };
    expect(directives.run(mkPage(row))[0]?.evidence).not.toHaveProperty("headClosedEarly");
    expect(tags.run(mkPage(row))[0]?.evidence).not.toHaveProperty("headClosedEarly");
    const stale = mkPage({
      ...row,
      htmlStructure: {
        ...structure,
        closedEarly: { tag: "div", snippet: "<div>", inNoscript: false },
      } as unknown as typeof structure,
    });
    expect(() => directives.run(stale)).toThrow(/re-crawl/);
    expect(() => tags.run(stale)).toThrow(/re-crawl/);
  });

  it("omits the key on a v1 row and on a v2 row with no early close", () => {
    const v1 = mkV1Page({ headClosedBy: "div", canonicalOutsideHead: true, titleOutsideHead: true });
    expect(directives.run(v1)[0]?.evidence).not.toHaveProperty("headClosedEarly");
    expect(tags.run(v1)[0]?.evidence).not.toHaveProperty("headClosedEarly");
    const v2 = mkPage({ canonicalOutsideHead: true, headClosedBy: null });
    expect(directives.run(v2)[0]?.evidence).not.toHaveProperty("headClosedEarly");
  });
});

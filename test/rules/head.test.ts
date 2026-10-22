import { describe, expect, it } from "vitest";
import { closedByLabel, headRules } from "../../src/rules/page/head.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
import {
  expectSilentOnNonOkFetches,
  expectSilentOnNotJudged,
  mkPage,
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
    expect(tags.checkIds).toEqual(["CHECK-35", "CHECK-36"]);
    for (const r of headRules) {
      expect(r.columns).toEqual([
        { key: "elements", label: "Elements Outside Head" },
        { key: "headClosedBy", label: "Closed By" },
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

import { describe, expect, it } from "vitest";
import {
  META_MAX,
  META_MIN,
  onPageRules,
  TITLE_MAX,
  TITLE_MIN,
} from "../../src/rules/page/on-page.js";
// The thin-content floor moved to the query rules with `content.thin` itself
// (Phase 19 §11) — see test/rules/content-query.test.ts, which owns that rule's
// cases now. It is still read here, to keep the clean page clear of it.
import { THIN_WORDS } from "../../src/rules/query/content.js";
import {
  CLEAN_META,
  CLEAN_TITLE,
  expectSilentOnNonOkFetches,
  expectSilentOnNotJudged,
  mkPage,
  ruleLookup,
} from "./mk-page.js";

const rule = ruleLookup(onPageRules, "onPageRules");

/**
 * Page shapes whose union fires all ten on-page rules on a 200: nothing
 * present, everything too short, everything too long. (`content.thin` and its
 * skip were in this file until Phase 19 §11 moved both to the query rules —
 * their floor reads a column whose null only the crawl's census can read.)
 */
const BROKEN_ON_PAGE = [
  {
    title: null,
    metaDescription: null,
    h1Count: 0,
    headingOrder: [1, 4],
    wordCount: 3,
    renderableWordCount: 3,
    hasLoremIpsum: true,
  },
  { title: "x".repeat(TITLE_MIN - 1), metaDescription: "x".repeat(META_MIN - 1) },
  {
    title: "x".repeat(TITLE_MAX + 1),
    metaDescription: "x".repeat(META_MAX + 1),
    h1Count: 3,
  },
];

describe("onPageRules metadata", () => {
  it("defines the ten on-page rules the Phase 2 table left in this file", () => {
    expect(onPageRules.map((r) => r.id).sort()).toEqual(
      [
        "content.placeholder",
        "headings.h1-missing",
        "headings.h1-multiple",
        "headings.level-skip",
        "meta-description.missing",
        "meta-description.too-long",
        "meta-description.too-short",
        "title.missing",
        "title.too-long",
        "title.too-short",
      ].sort(),
    );
  });

  it("every rule is a page rule carrying checkIds, copy and a ruleset version", () => {
    for (const r of onPageRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.checkIds.length, r.id).toBeGreaterThan(0);
      // The one body rule reports under `content`, beside the cross-page
      // content rules, so a client reading the content section of a report
      // finds every content finding there (see `CONTENT` in on-page.ts).
      expect(r.category, r.id).toBe(r.id.startsWith("content.") ? "content" : "on-page");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("claims the checklist ids the table assigns", () => {
    expect(rule("title.missing").checkIds).toEqual(["CHECK-35"]);
    expect(rule("meta-description.missing").checkIds).toEqual(["CHECK-36"]);
    expect(rule("headings.h1-missing").checkIds).toEqual(["CHECK-37"]);
    expect(rule("content.placeholder").checkIds).toEqual(["CHECK-40"]);
  });

  it("the clean page sits inside every threshold, so a silent rule means something", () => {
    expect(CLEAN_TITLE.length).toBeGreaterThanOrEqual(TITLE_MIN);
    expect(CLEAN_TITLE.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(CLEAN_META.length).toBeGreaterThanOrEqual(META_MIN);
    expect(CLEAN_META.length).toBeLessThanOrEqual(META_MAX);
    // `content.thin` is a query rule now, but the clean page still has to clear
    // its floor on every count it could be judged on — the row this helper
    // builds is what the DB-backed content tests insert too.
    expect(mkPage().mainWordCount).toBeGreaterThanOrEqual(THIN_WORDS);
    expect(mkPage().renderableWordCount).toBeGreaterThanOrEqual(THIN_WORDS);
    expect(mkPage().wordCount).toBeGreaterThanOrEqual(THIN_WORDS);
  });

  it("thresholds are the planned values the copy quotes", () => {
    expect([TITLE_MIN, TITLE_MAX, META_MIN, META_MAX, THIN_WORDS]).toEqual([
      10, 60, 70, 160, 150,
    ]);
  });

  it("no rule fires on the clean page", () => {
    for (const r of onPageRules) expect(r.run(mkPage()), r.id).toHaveLength(0);
  });

  it("no rule fires on a page that was not fetched as a 200 OK", () => {
    // Every on-page signal is missing or wrong in these shapes; the only reason
    // to stay silent is the fetch class. Redirects and errors are the status
    // rules' job.
    expectSilentOnNonOkFetches(onPageRules, BROKEN_ON_PAGE);
  });

  // PHASE 22 §1. The same sweep for the other half of the judged cohort: a page
  // that answered 200 and is either kept out of the index or canonicalised to
  // another URL carries none of these findings. The defect belongs to the URL
  // it defers to, or to nobody — and `site.health` counts both exclusions so
  // the silence is a number on the report rather than an absence.
  it("no rule fires on a 200 that is noindexed or canonicalised elsewhere", () => {
    expectSilentOnNotJudged(onPageRules, BROKEN_ON_PAGE);
  });
});

describe("title rules", () => {
  it("title.missing fires on a null title", () => {
    const f = rule("title.missing").run(mkPage({ title: null }));
    expect(f).toHaveLength(1);
    expect(f[0]!.ruleId).toBe("title.missing");
    expect(f[0]!.severity).toBe(rule("title.missing").severity);
    expect(f[0]!.evidence).toMatchObject({ title: null });
  });

  it("title.missing fires on a whitespace-only title", () => {
    const f = rule("title.missing").run(mkPage({ title: "   " }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ title: "   " });
  });

  it("title.missing carries the page identity and a dedupe key", () => {
    const f = rule("title.missing").run(
      mkPage({ id: "page_7", url: "https://example.com/x", title: null }),
    )[0]!;
    expect(f.pageId).toBe("page_7");
    expect(f.pageUrl).toBe("https://example.com/x");
    expect(f.dedupeKey).toBe("https://example.com/x");
  });

  it("title.missing is silent on the clean page", () => {
    expect(rule("title.missing").run(mkPage())).toHaveLength(0);
  });

  it("title.too-short boundary: 9 fires, 10 does not", () => {
    const f = rule("title.too-short").run(mkPage({ title: "x".repeat(9) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ title: "x".repeat(9), length: 9, min: 10 });
    expect(rule("title.too-short").run(mkPage({ title: "x".repeat(10) }))).toHaveLength(0);
  });

  it("title.too-short leaves an absent title to title.missing", () => {
    expect(rule("title.too-short").run(mkPage({ title: null }))).toHaveLength(0);
    expect(rule("title.too-short").run(mkPage({ title: "" }))).toHaveLength(0);
    expect(rule("title.too-short").run(mkPage({ title: "   " }))).toHaveLength(0);
  });

  it("title.too-long boundary: 61 fires, 60 does not", () => {
    const f = rule("title.too-long").run(mkPage({ title: "x".repeat(61) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ length: 61, max: 60 });
    expect(rule("title.too-long").run(mkPage({ title: "x".repeat(60) }))).toHaveLength(0);
  });
});

describe("meta description rules", () => {
  it("meta-description.missing fires on a null description", () => {
    const f = rule("meta-description.missing").run(mkPage({ metaDescription: null }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toMatchObject({ metaDescription: null });
  });

  it("meta-description.missing fires on a whitespace-only description", () => {
    expect(rule("meta-description.missing").run(mkPage({ metaDescription: " " })))
      .toHaveLength(1);
  });

  it("meta-description.missing is silent on the clean page", () => {
    expect(rule("meta-description.missing").run(mkPage())).toHaveLength(0);
  });

  it("meta-description.too-short boundary: 69 fires, 70 does not", () => {
    const f = rule("meta-description.too-short").run(
      mkPage({ metaDescription: "x".repeat(69) }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ length: 69, min: 70 });
    expect(
      rule("meta-description.too-short").run(mkPage({ metaDescription: "x".repeat(70) })),
    ).toHaveLength(0);
  });

  it("meta-description.too-short leaves an absent description to .missing", () => {
    expect(rule("meta-description.too-short").run(mkPage({ metaDescription: null })))
      .toHaveLength(0);
    expect(rule("meta-description.too-short").run(mkPage({ metaDescription: "" })))
      .toHaveLength(0);
  });

  it("meta-description.too-long boundary: 161 fires, 160 does not", () => {
    const f = rule("meta-description.too-long").run(
      mkPage({ metaDescription: "x".repeat(161) }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ length: 161, max: 160 });
    expect(
      rule("meta-description.too-long").run(mkPage({ metaDescription: "x".repeat(160) })),
    ).toHaveLength(0);
  });
});

describe("heading rules", () => {
  it("headings.h1-missing fires when the page has no h1", () => {
    const f = rule("headings.h1-missing").run(mkPage({ h1Count: 0, headingOrder: [2, 3] }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toMatchObject({ h1Count: 0 });
  });

  it("headings.h1-missing is silent on one h1 and on many", () => {
    expect(rule("headings.h1-missing").run(mkPage())).toHaveLength(0);
    expect(rule("headings.h1-missing").run(mkPage({ h1Count: 3 }))).toHaveLength(0);
  });

  it("headings.h1-multiple boundary: 2 fires, 1 and 0 do not", () => {
    const f = rule("headings.h1-multiple").run(mkPage({ h1Count: 2 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ h1Count: 2 });
    expect(rule("headings.h1-multiple").run(mkPage({ h1Count: 1 }))).toHaveLength(0);
    expect(rule("headings.h1-multiple").run(mkPage({ h1Count: 0 }))).toHaveLength(0);
  });

  it("headings.level-skip fires on 1 -> 3 and reports where", () => {
    const f = rule("headings.level-skip").run(mkPage({ headingOrder: [1, 3, 4] }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    // skipAt is the index in headingOrder of the heading that skipped a level.
    expect(f[0]!.evidence).toMatchObject({ headingOrder: [1, 3, 4], skipAt: 1 });
  });

  it("headings.level-skip reports only the first skip", () => {
    const f = rule("headings.level-skip").run(mkPage({ headingOrder: [1, 2, 5, 2, 6] }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ skipAt: 2 });
  });

  it("headings.level-skip ignores going back up, repeats and single headings", () => {
    for (const headingOrder of [[1, 2, 3], [1, 2, 2, 3, 2], [3, 1], [1], [], [2, 3, 4]]) {
      expect(rule("headings.level-skip").run(mkPage({ headingOrder })), String(headingOrder))
        .toHaveLength(0);
    }
  });

  it("headings.level-skip is silent when no heading order was recorded", () => {
    expect(rule("headings.level-skip").run(mkPage({ headingOrder: null }))).toHaveLength(0);
  });
});

describe("content rules", () => {
  it("content.placeholder fires on lorem ipsum and quotes the sentence it found", () => {
    // Phase 19 §3. The evidence used to be `{wordCount}` alone, which on the
    // crawl that provoked the change meant three 1,000-word blog posts and no
    // way to find the words: the placeholder was the post's excerpt and its
    // meta description, shown on the listing page and in the related-post
    // cards, and never in the article a reader would go and open.
    const snippet =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.";
    const f = rule("content.placeholder").run(
      mkPage({ hasLoremIpsum: true, wordCount: 320, placeholderSnippet: snippet }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe(rule("content.placeholder").severity);
    expect(f[0]!.evidence).toEqual({ wordCount: 320, snippet });
  });

  it("content.placeholder says the snippet is null on a pre-0018 row rather than omitting it", () => {
    // The flag was stored, the quotation was not, and the text is gone: a
    // crawl before migration 0018 cannot show a reader where the match is. The
    // finding still stands — the check ran and the answer is yes — so there is
    // no marker here, and the honest evidence is an explicit null rather than a
    // missing key or an invented sentence.
    const f = rule("content.placeholder").run(
      mkPage({ hasLoremIpsum: true, wordCount: 1_040, placeholderSnippet: null }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toEqual({ wordCount: 1_040, snippet: null });
    expect(Object.keys(f[0]!.evidence)).toContain("snippet");
  });

  // IT USED TO FIRE REGARDLESS OF INDEXABILITY, and Phase 22 §1 is where that
  // stopped: `content.placeholder` moved to the judged cohort with the nine
  // rules beside it. Lorem ipsum on a page search engines are told to skip is
  // not copy anybody reads, and if the template it came from is live anywhere
  // it is reported on the judged page that shares it.
  it("content.placeholder is silent on a noindexed page", () => {
    expect(
      rule("content.placeholder").run(
        mkPage({ hasLoremIpsum: true, robotsMeta: "noindex", isIndexable: false }),
      ),
    ).toHaveLength(0);
  });

  it("content.placeholder is silent on the clean page", () => {
    expect(rule("content.placeholder").run(mkPage())).toHaveLength(0);
  });
});

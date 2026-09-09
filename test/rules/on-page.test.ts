import { describe, expect, it } from "vitest";
import {
  META_MAX,
  META_MIN,
  onPageRules,
  THIN_WORDS,
  TITLE_MAX,
  TITLE_MIN,
} from "../../src/rules/page/on-page.js";
import {
  CLEAN_META,
  CLEAN_TITLE,
  expectSilentOnNonOkFetches,
  mkPage,
  ruleLookup,
} from "./mk-page.js";

const rule = ruleLookup(onPageRules, "onPageRules");

/**
 * Page shapes whose union fires all twelve on-page rules on a 200: nothing
 * present, everything too short, everything too long, and — for the Phase 7
 * skip — a page a pre-P7 crawl wrote, which carries a word count and no
 * renderable one.
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
  { wordCount: 400, renderableWordCount: null },
  { title: "x".repeat(TITLE_MIN - 1), metaDescription: "x".repeat(META_MIN - 1) },
  {
    title: "x".repeat(TITLE_MAX + 1),
    metaDescription: "x".repeat(META_MAX + 1),
    h1Count: 3,
  },
];

describe("onPageRules metadata", () => {
  it("defines the eleven on-page rules of the Phase 2 table, plus Phase 7's skip", () => {
    expect(onPageRules.map((r) => r.id).sort()).toEqual(
      [
        "content.placeholder",
        "content.thin",
        "content.thin-skipped",
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
      // The two body rules report under `content`, beside the cross-page
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
    expect(rule("content.thin").checkIds).toEqual(["CHECK-40", "CHECK-13"]);
    // The skip stands in for the rule it could not run, so it claims the same
    // checks: a check whose claimant reported "not judged" is still a check
    // with a rule behind it, and the coverage query must see that.
    expect(rule("content.thin-skipped").checkIds).toEqual(["CHECK-40", "CHECK-13"]);
    expect(rule("content.placeholder").checkIds).toEqual(["CHECK-40"]);
  });

  it("the clean page sits inside every threshold, so a silent rule means something", () => {
    expect(CLEAN_TITLE.length).toBeGreaterThanOrEqual(TITLE_MIN);
    expect(CLEAN_TITLE.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(CLEAN_META.length).toBeGreaterThanOrEqual(META_MIN);
    expect(CLEAN_META.length).toBeLessThanOrEqual(META_MAX);
    // The FLOOR reads the renderable count, so that is the number that has to
    // clear the threshold for the clean page's silence to mean anything.
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
  it("content.thin boundary: 149 renderable words fire, 150 do not", () => {
    const f = rule("content.thin").run(mkPage({ renderableWordCount: 149 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toMatchObject({ renderableWordCount: 149, threshold: 150 });
    expect(rule("content.thin").run(mkPage({ renderableWordCount: 150 }))).toHaveLength(0);
  });

  it("content.thin judges the renderable count, not the raw one", () => {
    // The lavishalice shape in miniature: 1,139 words in the HTML, 94 a reader
    // can reach. The raw number would have called this page healthy, which is
    // the false negative the Phase 7 correction exists to remove.
    const f = rule("content.thin").run(mkPage({ wordCount: 1139, renderableWordCount: 94 }));
    expect(f).toHaveLength(1);
    // Both numbers travel, so the finding can say which of the two is the
    // problem: the copy is written, and it is hidden.
    expect(f[0]!.evidence).toEqual({
      renderableWordCount: 94,
      wordCount: 1139,
      threshold: 150,
    });
    // And the converse: a page whose visible copy clears the floor is silent,
    // however few words the HTML carries beyond it.
    expect(
      rule("content.thin").run(mkPage({ wordCount: 200, renderableWordCount: 200 })),
    ).toHaveLength(0);
  });

  it("content.thin fires on an empty page", () => {
    expect(
      rule("content.thin").run(mkPage({ wordCount: 0, renderableWordCount: 0 })),
    ).toHaveLength(1);
  });

  it("content.thin is silent on a non-indexable page — thin on purpose is fine", () => {
    expect(rule("content.thin").run(mkPage({ renderableWordCount: 10, isIndexable: false })))
      .toHaveLength(0);
    expect(rule("content.thin").run(mkPage({ renderableWordCount: 10, isIndexable: null })))
      .toHaveLength(0);
  });

  it("content.thin is silent when no analysis ran at all — no guess", () => {
    // Both counts null: a 200 that served something the analyzer never read.
    expect(
      rule("content.thin").run(mkPage({ wordCount: null, renderableWordCount: null })),
    ).toHaveLength(0);
  });

  it("content.thin is silent on a pre-P7 row rather than reading the old column", () => {
    // A word count under the floor and no renderable count. Falling back to
    // `word_count` here would answer the question with a different quantity,
    // in silence, on old crawls only.
    expect(
      rule("content.thin").run(mkPage({ wordCount: 10, renderableWordCount: null })),
    ).toHaveLength(0);
  });

  it("content.thin-skipped reports that page instead, and quotes what was stored", () => {
    const f = rule("content.thin-skipped").run(
      mkPage({ wordCount: 10, renderableWordCount: null }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toEqual({ wordCount: 10, threshold: 150 });
  });

  it("content.thin-skipped is silent on a page the analyzer never read", () => {
    // Both null is "no text evidence", which `content.thin` was always quiet
    // about: a PDF served with a 200 is not a skipped check.
    expect(
      rule("content.thin-skipped").run(mkPage({ wordCount: null, renderableWordCount: null })),
    ).toHaveLength(0);
  });

  it("content.thin-skipped is silent on a current row, thin or not", () => {
    expect(rule("content.thin-skipped").run(mkPage())).toHaveLength(0);
    expect(
      rule("content.thin-skipped").run(mkPage({ wordCount: 10, renderableWordCount: 10 })),
    ).toHaveLength(0);
  });

  it("content.thin-skipped is silent on a non-indexable page, like the rule it stands in for", () => {
    expect(
      rule("content.thin-skipped").run(
        mkPage({ wordCount: 400, renderableWordCount: null, isIndexable: false }),
      ),
    ).toHaveLength(0);
  });

  it("at most one of the pair ever speaks about a page, and the unjudgeable ones are reported", () => {
    const shapes = [
      { wordCount: 10, renderableWordCount: 10 },
      { wordCount: 400, renderableWordCount: 400 },
      { wordCount: 400, renderableWordCount: null },
      { wordCount: 10, renderableWordCount: null },
      { wordCount: null, renderableWordCount: null },
    ];
    for (const shape of shapes) {
      const spoke =
        rule("content.thin").run(mkPage(shape)).length +
        rule("content.thin-skipped").run(mkPage(shape)).length;
      expect(spoke, JSON.stringify(shape)).toBeLessThanOrEqual(1);
    }
    // And a page the floor cannot be applied to is REPORTED rather than passed
    // over, which is the half a "at most one" assertion cannot state.
    expect(
      rule("content.thin-skipped").run(mkPage({ wordCount: 400, renderableWordCount: null })),
    ).toHaveLength(1);
  });

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

  it("content.placeholder fires regardless of indexability", () => {
    expect(
      rule("content.placeholder").run(mkPage({ hasLoremIpsum: true, isIndexable: false })),
    ).toHaveLength(1);
  });

  it("content.placeholder is silent on the clean page", () => {
    expect(rule("content.placeholder").run(mkPage())).toHaveLength(0);
  });
});

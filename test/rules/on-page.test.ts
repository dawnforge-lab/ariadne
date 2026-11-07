import { describe, expect, it } from "vitest";
import {
  H1_MAX,
  H2_MAX,
  META_MAX,
  META_MIN,
  onPageRules,
  TITLE_MAX,
  TITLE_MIN,
  URL_MAX,
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
  mkV1Page,
  ruleLookup,
} from "./mk-page.js";
import { INDEXED_URL_MAX } from "../../src/crawl/parse/url-utils.js";
import type { PageRecord } from "../../src/rules/registry/types.js";

const rule = ruleLookup(onPageRules, "onPageRules");

/**
 * Every rule here but `url.reference-too-long`, which is the one rule in the
 * file NOT gated on the judged cohort: an over-long reference was never
 * followed or stored whatever the page's index status, and the count is
 * written only on a page the crawl analysed (null otherwise), so the column
 * itself says when there is something to judge. Its own cases are below.
 */
const JUDGED_ON_PAGE_RULES = onPageRules.filter((r) => r.id !== "url.reference-too-long");

/**
 * Page shapes whose union fires every on-page rule on a 200: nothing
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
    h2Count: 0,
    titleCount: 2,
    metaDescriptionCount: 2,
  },
  { title: "x".repeat(TITLE_MIN - 1), metaDescription: "x".repeat(META_MIN - 1) },
  { title: "Shoes ", h1Text: "shoes" },
  {
    title: "x".repeat(TITLE_MAX + 1),
    metaDescription: "x".repeat(META_MAX + 1),
    h1Count: 3,
    h1Text: "x".repeat(H1_MAX + 1),
    h2Text: "x".repeat(H2_MAX + 1),
    url: "https://example.com/" + "a".repeat(URL_MAX),
  },
];

describe("onPageRules metadata", () => {
  it("defines the on-page rules this file holds (Phase 2's ten plus Phase 23's two length rules)", () => {
    expect(onPageRules.map((r) => r.id).sort()).toEqual(
      [
        "content.placeholder",
        "headings.h1-missing",
        "headings.h1-multiple",
        "headings.h1-too-long",
        "headings.level-skip",
        "h2.missing",
        "h2.too-long",
        "meta-description.missing",
        "meta-description.multiple",
        "meta-description.too-long",
        "meta-description.too-short",
        "title.missing",
        "title.multiple",
        "title.same-as-h1",
        "title.too-long",
        "title.too-short",
        "url.too-long",
        "url.reference-too-long",
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
      // `url.too-long` reads only `p.url` and reports beside the URL rules.
      expect(r.category, r.id).toBe(
        r.id.startsWith("content.") ? "content" : r.id.startsWith("url.") ? "url" : "on-page",
      );
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("claims the checklist ids the table assigns", () => {
    expect(rule("title.missing").checkIds).toEqual(["CHECK-35"]);
    expect(rule("meta-description.missing").checkIds).toEqual(["CHECK-36"]);
    expect(rule("headings.h1-missing").checkIds).toEqual(["CHECK-37"]);
    expect(rule("headings.h1-too-long").checkIds).toEqual(["CHECK-37"]);
    expect(rule("url.too-long").checkIds).toEqual(["CHECK-28"]);
    expect(rule("url.reference-too-long").checkIds).toEqual(["CHECK-28"]);
    expect(rule("h2.missing").checkIds).toEqual(["CHECK-37"]);
    expect(rule("h2.too-long").checkIds).toEqual(["CHECK-37"]);
    expect(rule("title.multiple").checkIds).toEqual(["CHECK-35"]);
    expect(rule("title.same-as-h1").checkIds).toEqual(["CHECK-35"]);
    expect(rule("meta-description.multiple").checkIds).toEqual(["CHECK-36"]);
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
    expect([TITLE_MIN, TITLE_MAX, META_MIN, META_MAX, H1_MAX, URL_MAX, THIN_WORDS]).toEqual([
      30, 60, 70, 155, 70, 115, 150,
    ]);
  });

  it("no rule fires on the clean page", () => {
    for (const r of onPageRules) expect(r.run(mkPage()), r.id).toHaveLength(0);
  });

  it("no rule fires on a page that was not fetched as a 200 OK", () => {
    // Every on-page signal is missing or wrong in these shapes; the only reason
    // to stay silent is the fetch class. Redirects and errors are the status
    // rules' job.
    expectSilentOnNonOkFetches(JUDGED_ON_PAGE_RULES, BROKEN_ON_PAGE);
  });

  // PHASE 22 §1. The same sweep for the other half of the judged cohort: a page
  // that answered 200 and is either kept out of the index or canonicalised to
  // another URL carries none of these findings. The defect belongs to the URL
  // it defers to, or to nobody — and `site.health` counts both exclusions so
  // the silence is a number on the report rather than an absence.
  it("no rule fires on a 200 that is noindexed or canonicalised elsewhere", () => {
    expectSilentOnNotJudged(JUDGED_ON_PAGE_RULES, BROKEN_ON_PAGE);
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

  it("title.too-short boundary: 29 fires, 30 does not", () => {
    const f = rule("title.too-short").run(mkPage({ title: "x".repeat(29) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ title: "x".repeat(29), length: 29, min: 30 });
    expect(rule("title.too-short").run(mkPage({ title: "x".repeat(30) }))).toHaveLength(0);
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

  it("meta-description.too-long boundary: 156 fires, 155 does not", () => {
    const f = rule("meta-description.too-long").run(
      mkPage({ metaDescription: "x".repeat(156) }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ length: 156, max: 155 });
    expect(
      rule("meta-description.too-long").run(mkPage({ metaDescription: "x".repeat(155) })),
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

  it("headings.h1-too-long boundary: 71 fires, 70 does not, null is silent", () => {
    const f = rule("headings.h1-too-long").run(mkPage({ h1Text: "x".repeat(71) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ h1Text: "x".repeat(71), length: 71, max: 70 });
    expect(rule("headings.h1-too-long").run(mkPage({ h1Text: "x".repeat(70) }))).toHaveLength(0);
    expect(rule("headings.h1-too-long").run(mkPage({ h1Text: null }))).toHaveLength(0);
  });

  it("headings.h1-too-long reports the analyzer's 300-character cap as 300", () => {
    const f = rule("headings.h1-too-long").run(mkPage({ h1Text: "x".repeat(300) }));
    expect(f[0]!.evidence).toMatchObject({ length: 300 });
  });

  it("h2.missing fires on h2Count 0, judges a v1 row too, and is silent on one H2", () => {
    const f = rule("h2.missing").run(mkPage({ h2Count: 0 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ h2Count: 0 });
    expect(rule("h2.missing").run(mkV1Page({ h2Count: 0 }))).toHaveLength(1);
    expect(rule("h2.missing").run(mkPage({ h2Count: 1 }))).toHaveLength(0);
  });

  it("h2.too-long boundary: 71 fires, 70 does not, null (no H2 or a v1 row) is silent", () => {
    const f = rule("h2.too-long").run(mkPage({ h2Text: "x".repeat(71) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ h2Text: "x".repeat(71), length: 71, max: 70 });
    expect(rule("h2.too-long").run(mkPage({ h2Text: "x".repeat(70) }))).toHaveLength(0);
    expect(rule("h2.too-long").run(mkPage({ h2Text: null }))).toHaveLength(0);
    expect(rule("h2.too-long").run(mkV1Page())).toHaveLength(0);
  });

  it("title.multiple fires above one element, silent on one and on a v1 row", () => {
    const f = rule("title.multiple").run(mkPage({ titleCount: 2 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toMatchObject({ titleCount: 2 });
    expect(rule("title.multiple").run(mkPage({ titleCount: 1 }))).toHaveLength(0);
    expect(rule("title.multiple").run(mkPage({ titleCount: 0 }))).toHaveLength(0);
    expect(rule("title.multiple").run(mkV1Page())).toHaveLength(0);
  });

  it("meta-description.multiple fires above one element, silent on one and on a v1 row", () => {
    const f = rule("meta-description.multiple").run(mkPage({ metaDescriptionCount: 3 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toMatchObject({ metaDescriptionCount: 3 });
    expect(rule("meta-description.multiple").run(mkPage({ metaDescriptionCount: 1 }))).toHaveLength(0);
    expect(rule("meta-description.multiple").run(mkV1Page())).toHaveLength(0);
  });

  it("title.same-as-h1 compares after whitespace collapse, trim and case, on every crawl", () => {
    const rid = rule("title.same-as-h1");
    const f = rid.run(mkPage({ title: "Shoes ", h1Text: "shoes" }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ title: "Shoes ", h1Text: "shoes" });
    expect(rid.run(mkPage({ title: "Red   Running  Shoes", h1Text: " red running shoes" }))).toHaveLength(1);
    expect(rid.run(mkV1Page({ title: "Shoes", h1Text: "SHOES" }))).toHaveLength(1);
    expect(rid.run(mkPage({ title: "Shoes", h1Text: "Shoe" }))).toHaveLength(0);
    expect(rid.run(mkPage({ title: null, h1Text: null }))).toHaveLength(0);
    expect(rid.run(mkPage({ title: "", h1Text: "" }))).toHaveLength(0);
  });

  it("url.reference-too-long fires on one over-long link and carries every count and the limit", () => {
    const r = rule("url.reference-too-long");
    expect([r.severity, r.category, r.checkIds]).toEqual(["warning", "url", ["CHECK-28"]]);
    expect(r.columns.map((c) => c.key)).toEqual(["links", "resources", "hreflang", "max"]);
    const f = r.run(mkPage({ overlongUrls: { links: 1, resources: 0, hreflang: 0 } }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toEqual({ links: 1, resources: 0, hreflang: 0, max: INDEXED_URL_MAX });
    expect(INDEXED_URL_MAX).toBe(2500);
    expect(r.run(mkPage({ overlongUrls: { links: 0, resources: 2, hreflang: 0 } }))).toHaveLength(1);
    expect(r.run(mkPage({ overlongUrls: { links: 0, resources: 0, hreflang: 3 } }))).toHaveLength(1);
  });

  it("url.reference-too-long is silent on all zeros and on a v2 row (null column)", () => {
    const r = rule("url.reference-too-long");
    expect(r.run(mkPage({ overlongUrls: { links: 0, resources: 0, hreflang: 0 } }))).toHaveLength(0);
    // A v2 row was written before the counts existed: null is "not measured",
    // and `extraction.not-recorded` speaks for it.
    expect(r.run(mkPage({ extractionVersion: 2, overlongUrls: null }))).toHaveLength(0);
    expect(
      r.run(mkPage({ extractionVersion: 2, overlongUrls: { links: 4, resources: 0, hreflang: 0 } })),
    ).toHaveLength(0);
    expect(r.run(mkV1Page())).toHaveLength(0);
    // A v3 row with no analysis (a 404, a redirect) has no counts either.
    expect(r.run(mkPage({ overlongUrls: null }))).toHaveLength(0);
  });

  it("url.reference-too-long reports a page that is not judged: the reference was still never followed", () => {
    const r = rule("url.reference-too-long");
    const counts = { links: 1, resources: 0, hreflang: 0 };
    expect(r.run(mkPage({ overlongUrls: counts, robotsMeta: "noindex", isIndexable: false }))).toHaveLength(1);
  });

  it("url.reference-too-long throws on a v3 count object missing a key: re-crawl", () => {
    const partial = { links: 1, resources: 0 } as unknown as PageRecord["overlongUrls"];
    expect(() => rule("url.reference-too-long").run(mkPage({ overlongUrls: partial }))).toThrow(
      /re-crawl/,
    );
  });

  it("url.too-long boundary: 116 fires, 115 does not, measured on the stored string", () => {
    const base = "https://example.com/";
    const at = (n: number) => base + "a".repeat(n - base.length);
    const f = rule("url.too-long").run(mkPage({ url: at(116) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({ length: 116, max: 115 });
    expect(rule("url.too-long").run(mkPage({ url: at(115) }))).toHaveLength(0);
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

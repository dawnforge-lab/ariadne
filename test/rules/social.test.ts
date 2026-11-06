/**
 * The four social page rules (Phase 26b, Task 6): Open Graph completeness,
 * conflicting Open Graph tags, an `og:url` that is not the page's canonical,
 * and the X card set.
 *
 * The clean page (`mkPage`) is a v2 row with a complete, consistent social set,
 * so each case overrides the one signal it is about. A v1 row (`mkV1Page`,
 * `social: null`) is silent for all four: it was never measured, and
 * `extraction.not-recorded` speaks for it.
 */
import { describe, expect, it } from "vitest";

import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import type { SocialFacts } from "../../src/crawl/parse/page-facts.js";
import { socialRules } from "../../src/rules/page/social.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
import { OG_REQUIRED } from "../../src/rules/thresholds.js";
import {
  expectSilentOnNonOkFetches,
  expectSilentOnNotJudged,
  mkPage,
  mkV1Page,
  ruleLookup,
} from "./mk-page.js";

const rule = ruleLookup(socialRules, "socialRules");
const ogIncomplete = rule("social.og-incomplete");
const ogMultiple = rule("social.og-multiple");
const ogUrlMismatch = rule("social.og-url-mismatch");
const xIncomplete = rule("social.x-incomplete");

/** The clean page's social set with `patch` applied to it. */
function social(patch: (s: SocialFacts) => void): Partial<PageRecord> {
  const base = mkPage().social;
  if (base === null) throw new Error("mkPage's clean page lost its social set");
  const copy = structuredClone(base);
  patch(copy);
  return { social: copy };
}

describe("social page rule metadata", () => {
  it("defines the four page rules, info, on-page, CHECK-87", () => {
    expect(socialRules.map((r) => r.id)).toEqual([
      "social.og-incomplete",
      "social.og-multiple",
      "social.og-url-mismatch",
      "social.x-incomplete",
    ]);
    for (const r of socialRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.severity, r.id).toBe("info");
      expect(r.category, r.id).toBe("on-page");
      expect(r.checkIds, r.id).toEqual(["CHECK-87"]);
      expect(r.marker, r.id).toBeUndefined();
    }
  });

  it("declares the evidence columns in the task's vocabulary", () => {
    expect(ogIncomplete.columns).toEqual([
      { key: "missing", label: "Missing OG Tags" },
      { key: "none", label: "No OG Tags" },
    ]);
    expect(ogMultiple.columns).toEqual([{ key: "tags", label: "Conflicting Tags" }]);
    expect(ogUrlMismatch.columns).toEqual([
      { key: "ogUrl", label: "OG URL" },
      { key: "canonical", label: "Canonical" },
    ]);
    expect(xIncomplete.columns).toEqual([
      { key: "missing", label: "Missing X Tags" },
      { key: "viaProperty", label: "Given as property=" },
    ]);
  });

  it("the required Open Graph set is title, type, image and url", () => {
    expect(OG_REQUIRED).toEqual(["title", "type", "image", "url"]);
  });
});

describe("the four rules on the clean page and on a v1 row", () => {
  it("are silent on the clean v2 page", () => {
    for (const r of socialRules) expect(r.run(mkPage()), r.id).toEqual([]);
  });

  it("are silent on a v1 row (extraction 1, social null): not measured, not missing", () => {
    for (const r of socialRules) expect(r.run(mkV1Page()), r.id).toEqual([]);
  });

  it("a null extraction stamp (before Phase 25) is not a v2 row either", () => {
    for (const r of socialRules) {
      expect(r.run(mkV1Page({ extractionVersion: null })), r.id).toEqual([]);
    }
  });

  it("are judged-only: silent on non-200s and on noindexed or canonicalised 200s", () => {
    const broken: Partial<PageRecord>[] = [
      { social: null },
      social((s) => {
        s.conflicting = ["og:title"];
        s.og.url = "https://example.com/other";
      }),
    ];
    expectSilentOnNonOkFetches(socialRules, broken);
    expectSilentOnNotJudged(socialRules, broken);
  });
});

describe("social.og-incomplete", () => {
  it("fires on a v2 row with no social tag at all, naming every required tag", () => {
    const f = ogIncomplete.run(mkPage({ social: null }));
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("info");
    expect(f[0]?.evidence).toEqual({
      missing: ["og:title", "og:type", "og:image", "og:url"],
      none: true,
    });
  });

  it("names only what is missing, in OG_REQUIRED order", () => {
    const f = ogIncomplete.run(
      mkPage(
        social((s) => {
          delete s.og.url;
          delete s.og.image;
        }),
      ),
    );
    expect(f[0]?.evidence).toEqual({ missing: ["og:image", "og:url"], none: false });
  });

  it("counts a tag present with empty content as missing", () => {
    const f = ogIncomplete.run(mkPage(social((s) => (s.og.type = ""))));
    expect(f[0]?.evidence).toEqual({ missing: ["og:type"], none: false });
  });

  it("an X-only set has no Open Graph tag: none is true", () => {
    const f = ogIncomplete.run(mkPage(social((s) => (s.og = {}))));
    expect(f[0]?.evidence).toEqual({
      missing: ["og:title", "og:type", "og:image", "og:url"],
      none: true,
    });
  });

  it("is silent when the required four are present, description and site_name aside", () => {
    expect(ogIncomplete.run(mkPage())).toEqual([]);
  });
});

describe("social.og-multiple", () => {
  it("fires on a conflicting og: tag, naming the og: ones only, og:image never (R15)", () => {
    const f = ogMultiple.run(
      mkPage(social((s) => (s.conflicting = ["og:image", "og:title", "twitter:title"]))),
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toEqual({ tags: ["og:title"] });
  });

  it("is silent on an og:image array, and fires on two og:title values (R15)", () => {
    // The Open Graph protocol makes og:image an array (first wins): a gallery
    // page's several images are not a conflict. og:title is single-valued.
    const page = (head: string) => {
      const url = "https://example.com/gallery";
      const a = analyzePage(`<html><head>${head}</head><body><p>x</p></body></html>`, url);
      return mkPage({ url, social: a.social });
    };
    const gallery = page(
      `<meta property="og:image" content="/1.png"><meta property="og:image" content="/2.png">`,
    );
    expect(gallery.social?.conflicting).toEqual(["og:image"]);
    expect(ogMultiple.run(gallery)).toEqual([]);
    const titles = page(
      `<meta property="og:title" content="One"><meta property="og:title" content="Two">`,
    );
    expect(ogMultiple.run(titles).map((f) => f.evidence)).toEqual([{ tags: ["og:title"] }]);
  });

  it("is silent when only X tags conflict", () => {
    expect(ogMultiple.run(mkPage(social((s) => (s.conflicting = ["twitter:card"]))))).toEqual([]);
  });

  it("is silent on a repeated tag with ONE value (counts 2, no conflict)", () => {
    expect(ogMultiple.run(mkPage(social((s) => (s.counts["og:title"] = 2))))).toEqual([]);
  });

  it("is silent on a v2 row with no social tags", () => {
    expect(ogMultiple.run(mkPage({ social: null }))).toEqual([]);
  });
});

describe("social.og-url-mismatch", () => {
  const PAGE = "https://example.com/page";

  it("fires when og:url names another page, quoting what it was compared with", () => {
    const f = ogUrlMismatch.run(
      mkPage({ url: PAGE, ...social((s) => (s.og.url = "https://example.com/other")) }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toEqual({ ogUrl: "https://example.com/other", canonical: PAGE });
  });

  it("is silent on a fragment, a host's case or a relative og:url that resolve to the page", () => {
    for (const ogUrl of ["https://EXAMPLE.com/page#top", "/page"]) {
      expect(
        ogUrlMismatch.run(mkPage({ url: PAGE, ...social((s) => (s.og.url = ogUrl)) })),
        ogUrl,
      ).toEqual([]);
    }
  });

  it("a trailing-slash variant is silent only where normalizeUrl equates the two", () => {
    // The root: `new URL` writes an empty path as "/", so these are one URL.
    expect(
      ogUrlMismatch.run(
        mkPage({ url: "https://example.com/", ...social((s) => (s.og.url = "https://example.com")) }),
      ),
    ).toEqual([]);
    // A path: "/page" and "/page/" are two URLs to normalizeUrl, so it fires.
    const f = ogUrlMismatch.run(
      mkPage({ url: PAGE, ...social((s) => (s.og.url = "https://example.com/page/")) }),
    );
    expect(f[0]?.evidence).toEqual({ ogUrl: "https://example.com/page/", canonical: PAGE });
  });

  it("compares against the page URL when no canonical is declared", () => {
    expect(
      ogUrlMismatch.run(mkPage({ url: PAGE, canonicalHtml: null, canonicalCount: 0 })),
    ).toEqual([]);
    const f = ogUrlMismatch.run(
      mkPage({
        url: PAGE,
        canonicalHtml: null,
        canonicalCount: 0,
        ...social((s) => (s.og.url = "https://example.com/x")),
      }),
    );
    expect(f[0]?.evidence).toEqual({ ogUrl: "https://example.com/x", canonical: PAGE });
  });

  it("an og:url that does not parse as a URL fires", () => {
    const f = ogUrlMismatch.run(mkPage(social((s) => (s.og.url = "http://exa mple.com/"))));
    expect(f).toHaveLength(1);
  });

  it("is silent when og:url is absent or empty (og-incomplete's business)", () => {
    expect(ogUrlMismatch.run(mkPage(social((s) => delete s.og.url)))).toEqual([]);
    expect(ogUrlMismatch.run(mkPage(social((s) => (s.og.url = ""))))).toEqual([]);
  });
});

describe("social.x-incomplete", () => {
  it("fires on a v2 row with no social tag at all", () => {
    const f = xIncomplete.run(mkPage({ social: null }));
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toEqual({
      missing: ["twitter:card", "twitter:title"],
      viaProperty: false,
    });
  });

  it("fires on no twitter:card, even with a title", () => {
    const f = xIncomplete.run(mkPage(social((s) => delete s.x.card)));
    expect(f[0]?.evidence).toEqual({ missing: ["twitter:card"], viaProperty: false });
  });

  it("fires on a card with no title anywhere", () => {
    const f = xIncomplete.run(
      mkPage(
        social((s) => {
          delete s.x.title;
          delete s.og.title;
        }),
      ),
    );
    expect(f[0]?.evidence).toEqual({ missing: ["twitter:title"], viaProperty: false });
  });

  it("is silent on a card whose title falls back to og:title", () => {
    expect(xIncomplete.run(mkPage(social((s) => delete s.x.title)))).toEqual([]);
  });

  it("fires on X tags given as property=, even with the set otherwise complete", () => {
    const f = xIncomplete.run(mkPage(social((s) => (s.xViaProperty = true))));
    expect(f[0]?.evidence).toEqual({ missing: [], viaProperty: true });
  });
});

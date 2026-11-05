import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { urlShapeRules } from "../../src/rules/page/url-shape.js";
import { INTERNAL_SEARCH_PARAMS, INTERNAL_SEARCH_PATH } from "../../src/rules/thresholds.js";
import {
  expectSilentOnNonOkFetches,
  expectSilentOnNotJudged,
  mkPage,
  ruleLookup,
} from "./mk-page.js";

const rule = ruleLookup(urlShapeRules, "urlShapeRules");

/** A page at `url` exactly as the crawler stores it: `normalizeUrl` output. */
function at(url: string) {
  const stored = normalizeUrl(url);
  if (stored === null) throw new Error(`test URL does not normalise: ${url}`);
  return mkPage({ url: stored });
}

/** The ids of the url-shape rules that fire on `url`. */
function firing(url: string): string[] {
  const page = at(url);
  return urlShapeRules.filter((r) => r.run(page).length > 0).map((r) => r.id).sort();
}

const BROKEN = [
  { url: "https://example.com/Upper" },
  { url: "https://example.com/under_score" },
  { url: "https://example.com/caf%C3%A9" },
  { url: "https://example.com/with%20space" },
  { url: "https://example.com/a//b" },
  { url: "https://example.com/shop/shop/x" },
  { url: "https://example.com/?s=shoes" },
];

describe("urlShapeRules metadata", () => {
  it("defines exactly the seven URL-shape rules", () => {
    expect(urlShapeRules.map((r) => r.id).sort()).toEqual([
      "url.internal-search",
      "url.multiple-slashes",
      "url.non-ascii",
      "url.repetitive-path",
      "url.spaces",
      "url.underscores",
      "url.uppercase",
    ]);
  });

  it("files them as url page rules with the severities and checks the brief names", () => {
    const expected: Record<string, [string, string]> = {
      "url.uppercase": ["info", "CHECK-30"],
      "url.underscores": ["info", "CHECK-30"],
      "url.non-ascii": ["info", "CHECK-30"],
      "url.spaces": ["warning", "CHECK-30"],
      "url.multiple-slashes": ["warning", "CHECK-30"],
      "url.repetitive-path": ["warning", "CHECK-30"],
      "url.internal-search": ["warning", "CHECK-67"],
    };
    for (const r of urlShapeRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.category, r.id).toBe("url");
      expect([r.severity, ...r.checkIds], r.id).toEqual(expected[r.id]);
    }
  });
});

describe("the clean page", () => {
  it("fires none of them", () => {
    expect(firing("https://example.com/page")).toEqual([]);
    expect(firing("https://example.com/")).toEqual([]);
  });
});

describe("url.uppercase", () => {
  it("fires on an upper-case letter in the path, with the path as evidence", () => {
    const out = rule("url.uppercase").run(at("https://example.com/Blog/Post"));
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toEqual({ path: "/Blog/Post" });
  });

  it("does not read the hex of a percent-escape as upper case", () => {
    expect(firing("https://example.com/caf%C3%A9")).not.toContain("url.uppercase");
  });
});

describe("url.underscores", () => {
  it("fires on an underscore in the path", () => {
    const out = rule("url.underscores").run(at("https://example.com/a_b"));
    expect(out[0]?.evidence).toEqual({ path: "/a_b" });
  });
});

describe("url.non-ascii", () => {
  it("fires on a literal and on an encoded non-ASCII character", () => {
    // `normalizeUrl` percent-encodes the literal, so both reach the rule as the
    // same stored URL.
    expect(firing("https://example.com/café")).toContain("url.non-ascii");
    expect(firing("https://example.com/caf%C3%A9")).toContain("url.non-ascii");
    expect(firing("https://example.com/caf%c3%a9")).toContain("url.non-ascii");
  });

  it("does not fire on an encoded ASCII byte", () => {
    expect(firing("https://example.com/a%7Eb")).not.toContain("url.non-ascii");
    expect(firing("https://example.com/a%2Fb")).not.toContain("url.non-ascii");
  });
});

describe("url.spaces", () => {
  it("fires on %20, on a literal space and on a plus in the path", () => {
    expect(firing("https://example.com/with%20space")).toContain("url.spaces");
    expect(firing("https://example.com/with space")).toContain("url.spaces");
    expect(firing("https://example.com/with+plus")).toContain("url.spaces");
  });

  it("does not read a plus or a space in the query", () => {
    expect(firing("https://example.com/page?x=a+b")).not.toContain("url.spaces");
    expect(firing("https://example.com/page?x=a%20b")).not.toContain("url.spaces");
  });
});

describe("url.multiple-slashes", () => {
  it("survives normalisation and fires on a double slash inside the path", () => {
    expect(at("https://example.com/a//b").url).toBe("https://example.com/a//b");
    expect(firing("https://example.com/a//b")).toContain("url.multiple-slashes");
    expect(firing("https://example.com/a///b")).toContain("url.multiple-slashes");
  });

  it("does not fire on single slashes", () => {
    expect(firing("https://example.com/a/b/")).toEqual([]);
  });
});

describe("url.repetitive-path", () => {
  it("fires on a repeated run and names it", () => {
    const one = rule("url.repetitive-path").run(at("https://example.com/shop/shop/x"));
    expect(one[0]?.evidence).toEqual({ path: "/shop/shop/x", repeated: "shop" });
    const two = rule("url.repetitive-path").run(at("https://example.com/a/b/a/b/"));
    expect(two[0]?.evidence).toEqual({ path: "/a/b/a/b/", repeated: "a/b" });
  });

  it("does not fire on a segment that recurs without repeating as a run", () => {
    expect(firing("https://example.com/a/b/c/a/")).not.toContain("url.repetitive-path");
    expect(firing("https://example.com/a/b/a/c")).not.toContain("url.repetitive-path");
  });

  it("ignores empty segments, so a double slash does not make a repeat", () => {
    expect(firing("https://example.com/a//b")).not.toContain("url.repetitive-path");
    expect(firing("https://example.com/a//a")).toContain("url.repetitive-path");
  });

  it("compares segments exactly", () => {
    expect(firing("https://example.com/Shop/shop")).not.toContain("url.repetitive-path");
  });
});

describe("url.internal-search", () => {
  it("fires on each search parameter, whole key, and names it", () => {
    for (const key of INTERNAL_SEARCH_PARAMS) {
      const out = rule("url.internal-search").run(at(`https://example.com/page?${key}=x`));
      expect(out, key).toHaveLength(1);
      expect(out[0]?.evidence, key).toEqual({ path: "/page", param: key });
    }
  });

  it("fires on a /search path, and the evidence has a null param", () => {
    const out = rule("url.internal-search").run(at("https://example.com/search/shoes"));
    expect(out[0]?.evidence).toEqual({ path: "/search/shoes", param: null });
    expect(firing("https://example.com/en/Search")).toContain("url.internal-search");
  });

  it("fires on ?s=shoes at the root", () => {
    expect(firing("https://example.com/?s=shoes")).toEqual(["url.internal-search"]);
  });

  it("does not fire on a longer key, a longer segment or a value", () => {
    expect(firing("https://example.com/search-tips")).toEqual([]);
    expect(firing("https://example.com/page?search_tips=1")).toEqual([]);
    expect(firing("https://example.com/page?x=search")).toEqual([]);
    expect(firing("https://example.com/researching/")).toEqual([]);
  });

  it("compares keys case-sensitively: ?S= is another parameter", () => {
    expect(firing("https://example.com/page?S=x")).toEqual([]);
  });

  it("pins the path pattern", () => {
    expect(INTERNAL_SEARCH_PATH.test("/search")).toBe(true);
    expect(INTERNAL_SEARCH_PATH.test("/a/search/b")).toBe(true);
    expect(INTERNAL_SEARCH_PATH.test("/search-tips")).toBe(false);
  });
});

describe("the path only (Review Focus 5)", () => {
  it("never reads the query or the host", () => {
    expect(firing("https://example.com/page?utm_source=X")).toEqual([]);
    expect(firing("https://Example.com/")).toEqual([]);
    expect(firing("https://EXAMPLE.com/page")).toEqual([]);
  });

  it("throws on a URL that does not parse instead of skipping the page", () => {
    const page = mkPage({ url: "not a url" });
    for (const r of urlShapeRules) expect(() => r.run(page), r.id).toThrow();
  });
});

describe("cohort", () => {
  it("is silent on every non-OK fetch", () => {
    expectSilentOnNonOkFetches(urlShapeRules, BROKEN);
  });

  it("is silent on an indexable 200 that is noindexed or canonicalised elsewhere", () => {
    expectSilentOnNotJudged(urlShapeRules, BROKEN);
  });
});

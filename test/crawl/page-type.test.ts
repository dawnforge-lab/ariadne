import { describe, expect, it } from "vitest";
import { derivePageType } from "../../src/crawl/page-type.js";

describe("derivePageType", () => {
  it("client patterns win", () => {
    expect(
      derivePageType("https://s.example/products/blue-widget", [
        { pattern: "/products/", pageType: "product" },
      ]),
    ).toBe("product");
  });

  it("takes the first matching client pattern", () => {
    const patterns = [
      { pattern: "/blog/", pageType: "article" },
      { pattern: "/blog/2024/", pageType: "archive" },
    ];
    expect(derivePageType("https://s.example/blog/2024/a-b-c", patterns)).toBe(
      "article",
    );
  });

  it("matches patterns against the pathname only, not the query or host", () => {
    const patterns = [{ pattern: "/products/", pageType: "product" }];
    // "/products/" appears only in the query string — not a product page.
    expect(
      derivePageType("https://s.example/search?q=/products/", patterns),
    ).toBe(derivePageType("https://s.example/search"));
  });

  it("falls back to the detected URL template", () => {
    // NOTE: the plan's illustrative pair was /blog/2024/my-post vs
    // /blog/2025/other-post. Those do NOT collapse to one template, and that
    // is deliberate upstream behaviour we are told to keep: url-utils treats a
    // segment as a slug only at three-or-more hyphen parts, so "my-post" and
    // "other-post" stay literal and the two URLs are two page types. The pair
    // below exercises the same "stable per template" property with segments
    // the documented slug rule actually covers.
    const t = derivePageType("https://s.example/blog/2024/my-great-post");
    expect(t).toBeTruthy();
    expect(t).toBe(derivePageType("https://s.example/blog/2025/another-fine-post"));
  });

  it("keeps two-part segments literal (upstream's slug rule)", () => {
    expect(derivePageType("https://s.example/blog/2024/my-post")).not.toBe(
      derivePageType("https://s.example/blog/2025/other-post"),
    );
  });

  it("gives the home page a stable type", () => {
    expect(derivePageType("https://s.example/")).toBe(
      derivePageType("https://s.example"),
    );
  });

  it("throws on a URL it cannot parse (no silent fallback)", () => {
    expect(() => derivePageType("not a url")).toThrow();
  });
});

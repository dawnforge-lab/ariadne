/**
 * Adapted from open-seo (MIT), src/server/lib/audit/url-utils.test.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 * Changes: imports rewritten to this repo's paths. Assertions are unchanged;
 * two cases were added at the end for the page_type-derivation behaviour Task
 * 9/11 depends on (the two-part-slug bias and the query-free path contract).
 */
import { describe, expect, it } from "vitest";
import {
  canonicalUrlKey,
  detectUrlTemplate,
  getOrigin,
  isSameOrigin,
  normalizeUrl,
} from "./url-utils.js";

describe("normalizeUrl", () => {
  it("normalizes host/query/hash, preserves trailing slash", () => {
    const value = normalizeUrl(
      "https://Example.COM/path/?b=2&a=1#section",
      "https://fallback.com",
    );

    expect(value).toBe("https://example.com/path/?a=1&b=2");
  });

  it("preserves a trailing slash on path-only URLs", () => {
    // A trailing slash is the canonical form on most CMSes; stripping it would
    // rewrite the canonical URL into its own redirect source and cause a loop.
    expect(normalizeUrl("https://example.com/services/")).toBe(
      "https://example.com/services/",
    );
  });

  it("preserves the absence of a trailing slash", () => {
    expect(normalizeUrl("https://example.com/services")).toBe(
      "https://example.com/services",
    );
  });

  it("returns null for unsupported protocol", () => {
    expect(normalizeUrl("mailto:test@example.com")).toBeNull();
  });
});

describe("canonicalUrlKey", () => {
  it("treats www and non-www as equal", () => {
    expect(canonicalUrlKey("https://www.example.com/")).toBe(
      canonicalUrlKey("https://example.com/"),
    );
  });

  it("treats http and https as equal", () => {
    expect(canonicalUrlKey("http://example.com/")).toBe(
      canonicalUrlKey("https://example.com/"),
    );
  });

  it("keeps the trailing-slash distinction in the path", () => {
    expect(canonicalUrlKey("https://example.com/services")).not.toBe(
      canonicalUrlKey("https://example.com/services/"),
    );
  });
});

describe("isSameOrigin", () => {
  it("accepts www host equivalence", () => {
    expect(
      isSameOrigin("https://www.example.com/products", "https://example.com"),
    ).toBe(true);
  });

  it("allows http to https upgrade on default ports", () => {
    expect(isSameOrigin("https://example.com/page", "http://example.com")).toBe(
      true,
    );
  });

  it("rejects mismatched hosts", () => {
    expect(isSameOrigin("https://example.org", "https://example.com")).toBe(
      false,
    );
  });
});

describe("detectUrlTemplate", () => {
  it("maps dynamic path segments", () => {
    expect(detectUrlTemplate("/blog/2026-03-01/my-great-post")).toBe(
      "/blog/:date/:slug",
    );
  });

  it("maps numeric id segments", () => {
    expect(detectUrlTemplate("/products/12345")).toBe("/products/:id");
  });

  it("maps uuid segments", () => {
    expect(
      detectUrlTemplate("/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
    ).toBe("/orders/:uuid");
  });

  // page_type derivation (Task 9/11) inherits this bias: a two-part slug is
  // assumed to be a fixed route, so /blog/hello-world is its own template.
  it("leaves two-part hyphenated segments literal", () => {
    expect(detectUrlTemplate("/blog/hello-world")).toBe("/blog/hello-world");
    expect(detectUrlTemplate("/my-account")).toBe("/my-account");
  });

  it("returns / for the root path", () => {
    expect(detectUrlTemplate("/")).toBe("/");
  });
});

describe("getOrigin", () => {
  it("returns URL origin", () => {
    expect(getOrigin("https://example.com:8080/path?q=1")).toBe(
      "https://example.com:8080",
    );
  });
});

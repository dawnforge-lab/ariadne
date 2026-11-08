/** The shared indexed-URL limit (Phase 26c, Task 1). */
import { describe, expect, it } from "vitest";

import { fitsIndex, INDEXED_URL_MAX } from "../../src/crawl/parse/url-utils.js";

describe("fitsIndex", () => {
  const prefix = "https://x.example/";
  const urlOfLength = (n: number): string => `${prefix}${"a".repeat(n - prefix.length)}`;

  it("is 2,500 characters", () => {
    expect(INDEXED_URL_MAX).toBe(2500);
  });

  it("accepts a URL of exactly 2,500 characters", () => {
    expect(urlOfLength(2500)).toHaveLength(2500);
    expect(fitsIndex(urlOfLength(2500))).toBe(true);
  });

  it("refuses a URL of 2,501 characters", () => {
    expect(fitsIndex(urlOfLength(2501))).toBe(false);
  });
});

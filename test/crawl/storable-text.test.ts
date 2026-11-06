import { describe, expect, it } from "vitest";
import { NUL_MARK, storableCap, storableText } from "../../src/crawl/storable-text.js";

describe("storableText: site text Postgres will accept", () => {
  it("replaces every U+0000 with U+2400, keeping the length", () => {
    expect(storableText("a\u0000b\u0000")).toEqual({ text: `a${NUL_MARK}b${NUL_MARK}`, cut: false });
  });

  it("replaces a lone surrogate with U+FFFD and keeps a well-formed pair", () => {
    expect(storableCap("a\uD800b\uDC00c")).toBe("a�b�c");
    expect(storableCap("😀")).toBe("😀");
  });

  it("cuts on a code-point boundary: a pair straddling the cap goes whole", () => {
    // "ab" + 😀 (two units): a cap of 3 would split the pair.
    expect(storableText("ab😀", 3)).toEqual({ text: "ab", cut: true });
    expect(storableText("ab😀", 4)).toEqual({ text: "ab😀", cut: false });
    expect(storableText("abc😀", 3)).toEqual({ text: "abc", cut: true });
  });

  it("does not cut without a cap", () => {
    expect(storableText("x".repeat(10_000))).toEqual({ text: "x".repeat(10_000), cut: false });
  });
});

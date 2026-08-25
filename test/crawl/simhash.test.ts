import { describe, expect, it } from "vitest";
import { simhash64, hammingDistance } from "../../src/crawl/parse/simhash.js";

describe("simhash64", () => {
  const base = "the quick brown fox jumps over the lazy dog ".repeat(30);
  it("is deterministic", () => {
    expect(simhash64(base)).toBe(simhash64(base));
  });
  it("near-identical texts land within hamming distance 3", () => {
    const tweaked = base.replace("lazy dog", "lazy cat");
    expect(
      hammingDistance(simhash64(base), simhash64(tweaked)),
    ).toBeLessThanOrEqual(3);
  });
  it("unrelated texts are far apart", () => {
    const other =
      "completely different content about sitemap parsing and robots ".repeat(
        30,
      );
    expect(
      hammingDistance(simhash64(base), simhash64(other)),
    ).toBeGreaterThan(10);
  });
  it("fits in 64 bits", () => {
    expect(simhash64(base) < (1n << 64n)).toBe(true);
  });

  // The value is unsigned-range (0 .. 2^64-1); pages.simhash is a SIGNED
  // Postgres bigint, so persistence wraps with BigInt.asIntN(64, value) and
  // the round trip must be lossless.
  it("survives the signed-bigint round trip persistence uses", () => {
    const h = simhash64(base);
    expect(h >= 0n).toBe(true);
    expect(BigInt.asUintN(64, BigInt.asIntN(64, h))).toBe(h);
  });

  it("is whitespace- and case-insensitive", () => {
    expect(simhash64("Hello   World\n Again")).toBe(
      simhash64("hello world again"),
    );
  });

  // Golden values, so the hash stays stable across refactors: a changed
  // simhash silently invalidates every stored near-duplicate signature.
  it("matches known values", () => {
    expect(simhash64("the quick brown fox jumps over the lazy dog")).toBe(
      0x18217848a40c830n,
    );
    expect(simhash64("one two three")).toBe(0xa63947c27151dd91n);
    expect(simhash64("word")).toBe(0x7058fcf636683f3dn);
    expect(simhash64("")).toBe(0xcbf29ce484222325n);
  });

  it("handles empty and single-word text without throwing", () => {
    expect(typeof simhash64("")).toBe("bigint");
    expect(typeof simhash64("word")).toBe("bigint");
  });
});

describe("hammingDistance", () => {
  it("is zero for identical values", () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0xdeadbeefn, 0xdeadbeefn)).toBe(0);
  });
  it("counts differing bits", () => {
    expect(hammingDistance(0b1011n, 0b0001n)).toBe(2);
    expect(hammingDistance(0n, (1n << 64n) - 1n)).toBe(64);
  });
});

import { Session } from "node:inspector/promises";
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

// ---------------------------------------------------------------------------
// Oracle: the pre-29d implementation (BigInt FNV, per-window join), kept
// verbatim so the optimised hash is pinned to it bit for bit.
// ---------------------------------------------------------------------------
const O_FNV_OFFSET = 0xcbf29ce484222325n;
const O_FNV_PRIME = 0x100000001b3n;
const O_MASK64 = 0xffffffffffffffffn;

function oracleFnv1a64(s: string): bigint {
  let h = O_FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * O_FNV_PRIME) & O_MASK64;
  }
  return h;
}

function simhash64Oracle(text: string): bigint {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const v = new Int32Array(64);
  const last = Math.max(1, words.length - 4 + 1);
  for (let i = 0; i < last; i++) {
    const h = oracleFnv1a64(words.slice(i, i + 4).join(" "));
    const lo = Number(h & 0xffffffffn) | 0;
    const hi = Number(h >> 32n) | 0;
    for (let b = 0; b < 32; b++) {
      v[b]! += ((lo >>> b) & 1) === 1 ? 1 : -1;
      v[b + 32]! += ((hi >>> b) & 1) === 1 ? 1 : -1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b]! > 0) out |= 1n << BigInt(b);
  return out;
}

/** mulberry32: a small seeded PRNG so a failing text reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD_POOL = [
  "the", "Quick", "BROWN", "fox", "café", "Ünïcode", "naïve", "İstanbul",
  "STRASSE", "straße", "ẞ", "Σίσυφος", "ΣΑΣ", "日本語", "検索エンジン", "😀",
  "👨‍👩‍👧", "a😀b", "\u{10400}x", "x", "", "ǅ", "ﬃ",
];
const SPACE_POOL = [
  " ", "  ", "\n", "\t", "\r\n", " \n \t ", "\u00a0", "\u2003", "\u3000",
  "\u2028", "\ufeff", "\u180e", "\u200b",
];

function randomText(rand: () => number): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  // A quarter of the texts have 0-3 words, the rest up to 40.
  const n = rand() < 0.25 ? Math.floor(rand() * 4) : Math.floor(rand() * 40);
  let out = rand() < 0.3 ? pick(SPACE_POOL) : "";
  for (let i = 0; i < n; i++) {
    out += pick(WORD_POOL) + (i < n - 1 || rand() < 0.3 ? pick(SPACE_POOL) : "");
  }
  return out;
}

describe("simhash64 vs the pre-29d oracle", () => {
  it("matches the oracle on random text", () => {
    const rand = prng(0x29d);
    for (let i = 0; i < 2000; i++) {
      const text = randomText(rand);
      expect(simhash64(text), JSON.stringify(text)).toBe(simhash64Oracle(text));
    }
  });

  it("matches the oracle on the empty, whitespace-only and short edge cases", () => {
    for (const text of ["", " ", "\n\t", "a", "a b", "a b c", "a b c d", "a b c d e", "\ud83d", "x\ud83d y"]) {
      expect(simhash64(text), JSON.stringify(text)).toBe(simhash64Oracle(text));
    }
  });

  it("allocates at least 5x less than the oracle", async () => {
    const rand = prng(7);
    const vocab = Array.from({ length: 400 }, (_, i) => `word${i}${WORD_POOL[i % WORD_POOL.length]}`);
    const text = Array.from({ length: 2000 }, () => vocab[Math.floor(rand() * vocab.length)]).join(" ");
    expect(simhash64(text)).toBe(simhash64Oracle(text));
    const runs = 50;
    const session = new Session();
    session.connect();
    const measure = async (fn: (t: string) => bigint): Promise<number> => {
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let i = 0; i < runs; i++) fn(text);
      const { profile } = await session.post("HeapProfiler.stopSampling");
      let allocated = 0;
      const walk = (node: typeof profile.head): void => {
        allocated += node.selfSize;
        node.children.forEach(walk);
      };
      walk(profile.head);
      return allocated;
    };
    try {
      const oracle = await measure(simhash64Oracle);
      const fresh = await measure(simhash64);
      expect(oracle).toBeGreaterThan(0);
      expect(fresh).toBeGreaterThan(0);
      expect(oracle / fresh).toBeGreaterThanOrEqual(5);
    } finally {
      session.disconnect();
    }
  });
});

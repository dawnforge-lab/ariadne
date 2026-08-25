/**
 * 64-bit simhash over word shingles — the near-duplicate signal behind the
 * "duplicate / thin content" checks. Two pages whose visible text differs only
 * in boilerplate land within a few bits of each other; unrelated pages sit
 * ~32 bits apart. Comparison is a hamming distance, cheap enough to run
 * pairwise in SQL over a crawl's worth of pages.
 *
 * Original to Ariadne (no upstream provenance).
 *
 * Storage note for the persistence layer (Task 11): `simhash64` returns a
 * value in the UNSIGNED 64-bit range (0 .. 2^64-1), while `pages.simhash` is a
 * signed Postgres `bigint`. Persist with `BigInt.asIntN(64, value)` and read
 * back with `BigInt.asUintN(64, stored)`; the round trip is lossless and the
 * bit pattern — all `hammingDistance` cares about — is unchanged either way.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * FNV-1a over UTF-16 code units. Not a cryptographic hash and not meant to be:
 * simhash needs a cheap, well-distributed bit mixer, and this one runs without
 * allocating per shingle.
 */
function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** Shingle width: 4-word windows, the usual near-duplicate trade-off. */
const SHINGLE_WIDTH = 4;

/**
 * 64-bit simhash over 4-word shingles of whitespace-normalised, lowercased
 * text. Deterministic: the same text always yields the same value, across
 * processes and runs.
 */
export function simhash64(text: string): bigint {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const v = new Int32Array(64);
  const last = Math.max(1, words.length - SHINGLE_WIDTH + 1);
  for (let i = 0; i < last; i++) {
    const h = fnv1a64(words.slice(i, i + SHINGLE_WIDTH).join(" "));
    // The tally reads each bit of `h` as a 32-bit Number pair rather than by
    // BigInt shift: 128 BigInt ops per shingle dominated the whole parse path
    // (measured ~2.6x on a 1500-word page), and the values are identical by
    // construction — same hash, same bits, same order. The golden-value tests
    // pin that equivalence.
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

/** Number of differing bits between two 64-bit simhashes (0..64). */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

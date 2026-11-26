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

const MASK64 = 0xffffffffffffffffn;

// FNV-1a 64 on two unsigned 32-bit halves. The offset basis is
// 0xcbf29ce484222325 and the prime 0x100000001b3 (hi 0x100, lo 0x1b3).
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3;
const TWO_POW_32 = 4294967296;

// The running hash lives in module state, not a returned pair, so feeding a
// character allocates nothing. Safe: simhash64 is synchronous and never
// re-entered.
// A typed array, because module-level `let` numbers above 2^31 are boxed on
// the heap on every store. [hi, lo] as int32 bit patterns.
const state = new Int32Array(2);

/**
 * One FNV-1a step over a UTF-16 code unit (XOR into the low half, then
 * multiply by the prime modulo 2^64): lo*prime carries into the high half, the
 * high half's own product by 0x100 falls past bit 64.
 */
function feed(unit: number): void {
  const lo = (state[1]! ^ unit) >>> 0;
  const carry = Math.floor((lo * FNV_PRIME_LO) / TWO_POW_32);
  state[0] = Math.imul(state[0]!, FNV_PRIME_LO) + (lo << 8) + carry;
  state[1] = Math.imul(lo, FNV_PRIME_LO);
}

/**
 * The code units `/\s/` matches (and `String.prototype.trim` strips):
 * WhiteSpace plus LineTerminator.
 */
function isSpace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 32 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Shingle width: 4-word windows, the usual near-duplicate trade-off. */
const SHINGLE_WIDTH = 4;

/**
 * 64-bit simhash over 4-word shingles of whitespace-normalised, lowercased
 * text. Deterministic: the same text always yields the same value, across
 * processes and runs.
 *
 * Allocation-lean (Phase 29d): the hash is FNV-1a 64 over UTF-16 code units on
 * two 32-bit halves, each window is fed word by word straight from the
 * lowercased text with a single space between words (what the old
 * join(" ") produced), and the 64 output bits become one BigInt at the end.
 * Output is bit-identical to the BigInt original; the golden-value tests and
 * the oracle test pin that.
 */
export function simhash64(text: string): bigint {
  const lower = text.toLowerCase();
  const n = lower.length;
  // A word is a maximal run of non-whitespace code units. Text with no words
  // is one empty word, as split(" ") gave (below: count 0 hashes nothing).
  let count = 0;
  for (let i = 0, inWord = false; i < n; i++) {
    const sp = isSpace(lower.charCodeAt(i));
    if (!sp && !inWord) count++;
    inWord = !sp;
  }
  const starts = new Int32Array(count);
  const ends = new Int32Array(count);
  for (let i = 0, w = 0, inWord = false; i < n; i++) {
    const sp = isSpace(lower.charCodeAt(i));
    if (!sp && !inWord) starts[w] = i;
    if (sp && inWord) ends[w++] = i;
    inWord = !sp;
    if (i === n - 1 && inWord) ends[w] = n;
  }
  const v = new Int32Array(64);
  const last = Math.max(1, count - SHINGLE_WIDTH + 1);
  for (let i = 0; i < last; i++) {
    state[0] = FNV_OFFSET_HI;
    state[1] = FNV_OFFSET_LO;
    const stop = Math.min(count, i + SHINGLE_WIDTH);
    for (let w = i; w < stop; w++) {
      if (w > i) feed(32);
      for (let c = starts[w]!, e = ends[w]!; c < e; c++) feed(lower.charCodeAt(c));
    }
    // The tally reads each bit of the hash as a 32-bit Number pair; the
    // golden-value tests pin that it equals the BigInt original.
    const lo = state[1]!;
    const hi = state[0]!;
    for (let b = 0; b < 32; b++) {
      v[b]! += ((lo >>> b) & 1) === 1 ? 1 : -1;
      v[b + 32]! += ((hi >>> b) & 1) === 1 ? 1 : -1;
    }
  }
  let outHi = 0;
  let outLo = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b]! > 0) outLo |= 1 << b;
    if (v[b + 32]! > 0) outHi |= 1 << b;
  }
  return (BigInt(outHi >>> 0) << 32n) | BigInt(outLo >>> 0);
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

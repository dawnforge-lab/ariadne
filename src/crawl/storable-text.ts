/**
 * Site text made storable in Postgres, and capped without breaking a character.
 *
 * A string the crawled site controls (console text, an attribute value, a tag's
 * source) can hold what Postgres refuses: U+0000 in `text` and `jsonb`, and an
 * unpaired surrogate in `jsonb`. A UTF-16 `slice()` at a cap can also make an
 * unpaired surrogate by cutting a pair in half. Any of these makes the batch
 * insert throw, so one hostile page would fail the batch and the crawl, and a
 * resume would hit it again. Every such string goes through `storableText`
 * before it is kept:
 *
 *  1. It is made well-formed (`toWellFormed`: a lone surrogate becomes U+FFFD).
 *  2. Every U+0000 becomes U+2400 (`␀`, SYMBOL FOR NULL). This keeps it visible
 *     instead of dropping it silently. It is one character, not the six of
 *     `\u0000`, because a page can write that escape as literal text and the
 *     stored value must not make the two indistinguishable.
 *  3. It is cut to `max` UTF-16 units on a code-point boundary, never half a
 *     surrogate pair, and `cut` says so.
 *
 * Steps 1 and 2 never change the length, so the cap means the same thing it
 * did before sanitising.
 */

/** What a U+0000 is stored as: U+2400 SYMBOL FOR NULL. */
export const NUL_MARK = "␀";

/** `raw` made storable and cut to at most `max` UTF-16 units (see the module header). */
export function storableText(raw: string, max = Infinity): { text: string; cut: boolean } {
  const visible = wellFormed(raw).replaceAll("\u0000", NUL_MARK);
  if (visible.length <= max) return { text: visible, cut: false };
  let end = max;
  // Well-formed, so a high surrogate at the edge is the first half of a pair
  // whose second half is past the cap: the whole pair goes.
  const last = visible.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: visible.slice(0, end), cut: true };
}

/** `storableText(raw, max).text`, for callers that do not record the cut. */
export function storableCap(raw: string, max = Infinity): string {
  return storableText(raw, max).text;
}

/**
 * `value` with every string inside it made storable (no cap): the one boundary
 * a row passes before it is buffered for Postgres (persist.ts, the render
 * writer). It walks arrays and plain objects, keys included (a parsed JSON-LD
 * key can hold U+0000 too). Every other value is returned as it is: numbers,
 * bigints, booleans, null, and class instances such as `Date`.
 *
 * COPY-ON-WRITE. It runs on every buffered row, so it allocates only where
 * something changes. A string with no U+0000 and no surrogate code unit is
 * returned as it is, without `toWellFormed` or `replaceAll` (a well-formed
 * pair is left alone either way; only strings that could change take the
 * sanitising path). An array or plain object whose children (and keys) all
 * come back `===` is returned AS IS, the same reference; one with a changed
 * child or key is rebuilt, and so is every container on the path above it,
 * while its clean siblings are shared, never copied. The input is never
 * mutated. A value that is already storable therefore comes back as the very
 * same value, and parity and dedupe keys see clean text exactly as before.
 *
 * DEPTH IS BOUNDED, and going past the bound is a defect, so it throws (ruling
 * R11). The walk recurses, and so does the driver's own `JSON.stringify` of the
 * same value. The producers cap their nesting well below the bound: JSON-LD is
 * refused past `MAX_LD_JSON_NESTING` (64) in the analyzer, and every other row
 * is a few levels deep. A value deeper than `STORABLE_MAX_DEPTH` therefore
 * means a producer lost its cap. It fails loudly here; it is never trimmed or
 * dropped.
 *
 * A rebuilt object is built with `Object.fromEntries`, which defines properties and
 * never assigns them. A `__proto__` key, an own key in anything `JSON.parse`
 * made, therefore stays a key. Assigning it would call the prototype setter:
 * the key would vanish and the prototype would change (review I2).
 */
export function storableDeep<T>(value: T): T {
  return deep(value, 0) as T;
}

/** The deepest array/object nesting `storableDeep` accepts; see its docblock. */
export const STORABLE_MAX_DEPTH = 100;

/** A U+0000 or any surrogate code unit: the only strings `storableText` may change uncapped. */
const MAYBE_UNSTORABLE = /[\u0000\uD800-\uDFFF]/;

/** `raw` made storable, returned AS IS (no copy) when it has nothing to change. */
function storableString(raw: string): string {
  return MAYBE_UNSTORABLE.test(raw) ? storableText(raw).text : raw;
}

function deep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return storableString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= STORABLE_MAX_DEPTH) {
    throw new Error(
      `storableDeep: value nested deeper than ${STORABLE_MAX_DEPTH} levels; ` +
        "the producer that built it must cap its nesting",
    );
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((inner) => {
      const next = deep(inner, depth + 1);
      if (next !== inner) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, inner]) => {
    const nextKey = storableString(key);
    const next = deep(inner, depth + 1);
    if (nextKey !== key || next !== inner) changed = true;
    return [nextKey, next] as const;
  });
  return changed ? Object.fromEntries(entries) : value;
}

/** ES2024's `String.prototype.toWellFormed` (Node 22); the project's ES2023 lib does not declare it. */
function wellFormed(s: string): string {
  return (s as string & { toWellFormed(): string }).toWellFormed();
}

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

/** ES2024's `String.prototype.toWellFormed` (Node 22); the project's ES2023 lib does not declare it. */
function wellFormed(s: string): string {
  return (s as string & { toWellFormed(): string }).toWellFormed();
}

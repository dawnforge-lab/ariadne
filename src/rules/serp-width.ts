import { SERP_GLYPHS } from "./serp-glyphs.generated.js";

/**
 * Rendered pixel width of `text` as Google lays out a SERP title (20px Arial)
 * or description (14px Arial): the sum of per-code-point advances from the
 * table we measured ourselves (scripts/measure-serp-glyphs.ts), kerning off,
 * rounded to one decimal.
 *
 * Whitespace is normalised first, the way a results page lays it out: every
 * run of ASCII whitespace (space, tab, LF, CR, FF) becomes one space and the
 * ends are trimmed. The analyzer stores titles trimmed but not collapsed, so a
 * newline or doubled space in the markup must not read as unmeasurable or wide.
 * U+00A0 is NOT collapsed (HTML keeps it) and stays a measured glyph.
 *
 * Returns null when any code point is missing from the table (outside the
 * covered ranges, or a glyph the font does not have). There is no default
 * width and no fallback font: a width we cannot measure is not guessed.
 */
export function serpWidth(text: string, kind: "title" | "description"): number | null {
  const table = SERP_GLYPHS[kind];
  let sum = 0;
  for (const ch of text.replace(/[ \t\n\r\f]+/g, " ").replace(/^ | $/g, "")) {
    const advance = table[ch.codePointAt(0)!];
    if (advance === undefined) return null;
    sum += advance;
  }
  return Math.round(sum * 10) / 10;
}

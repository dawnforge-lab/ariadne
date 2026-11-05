import { SERP_GLYPHS } from "./serp-glyphs.generated.js";

/**
 * Rendered pixel width of `text` as Google lays out a SERP title (20px Arial)
 * or description (14px Arial): the sum of per-code-point advances from the
 * table we measured ourselves (scripts/measure-serp-glyphs.ts), kerning off,
 * rounded to one decimal.
 *
 * Returns null when any code point is missing from the table (outside the
 * covered ranges, or a glyph the font does not have). There is no default
 * width and no fallback font: a width we cannot measure is not guessed.
 */
export function serpWidth(text: string, kind: "title" | "description"): number | null {
  const table = SERP_GLYPHS[kind];
  let sum = 0;
  for (const ch of text) {
    const advance = table[ch.codePointAt(0)!];
    if (advance === undefined) return null;
    sum += advance;
  }
  return Math.round(sum * 10) / 10;
}

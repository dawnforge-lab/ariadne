/**
 * Measures the SERP glyph-advance table in Chromium and writes
 * src/rules/serp-glyphs.generated.ts.
 *
 *   npx tsx scripts/measure-serp-glyphs.ts
 *
 * Method:
 *  1. Launch Playwright Chromium headless; open a CDP session.
 *  2. Verify via `CSS.getPlatformFontsForNode` that `20px Arial` and `14px
 *     Arial` resolve to Arial or Liberation Sans (metric-compatible). Anything
 *     else THROWS: there is no fallback font.
 *  3. For every code point in the covered ranges, render one `<span>` (all in
 *     one document) and ask CDP which platform fonts painted it. A code point
 *     whose span is not painted by exactly one font from the allowed set (no
 *     glyph at all, or a fallback font) is EXCLUDED, never recorded with a
 *     fallback's width. serpWidth returns null for an excluded code point.
 *     Control characters (Cc) are excluded outright. Probe text uses literal
 *     characters, not `&#N;` references (the HTML parser remaps &#128;-&#159;
 *     via Windows-1252, which once put 27 C1 controls in the table at width 0).
 *  4. Measure the kept code points with canvas `measureText(ch).width` at
 *     `20px Arial` / `14px Arial`, `fontKerning = "none"`, rounded to 3
 *     decimals: an advance sum, kerning off.
 *
 * The output is deterministic (ascending keys) and carries no date, so a
 * re-run on the same machine is byte-identical; only a different Chromium or
 * font changes the diff, which is what should show up in review.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0020, 0x052f],
  [0x2000, 0x206f],
  [0x20a0, 0x20cf],
];
const CONTROL = /^\p{Cc}$/u;
const ALLOWED = new Set(["Arial", "Liberation Sans"]);
const OUT = fileURLToPath(new URL("../src/rules/serp-glyphs.generated.ts", import.meta.url));

async function main(): Promise<void> {
  const t0 = Date.now();
  const browser = await chromium.launch();
  try {
    const version = browser.version();
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");

    const codePoints: number[] = [];
    for (const [lo, hi] of RANGES) for (let cp = lo; cp <= hi; cp++) codePoints.push(cp);

    // One document: a probe per size, then one span per code point. Span text
    // is set from the LITERAL character via textContent, never a numeric
    // character reference: the HTML parser remaps &#128;-&#159; through
    // Windows-1252, so the probe would draw a different character than the
    // canvas pass measures. (No nested named functions: tsx keepNames injects
    // a `__name` helper that does not exist in the page.)
    await page.setContent(
      `<body style="margin:0"><span id="p20" style="font:20px Arial">Hamburgefonstiv</span>` +
        `<span id="p14" style="font:14px Arial">Hamburgefonstiv</span>` +
        `<div id="g" style="font:20px Arial;white-space:pre"></div></body>`,
    );
    await page.evaluate((cps) => {
      const g = document.getElementById("g")!;
      for (const cp of cps) {
        const span = document.createElement("span");
        span.textContent = String.fromCodePoint(cp);
        g.appendChild(span);
      }
    }, codePoints);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const query = async (selector: string): Promise<number[]> =>
      (await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector })).nodeIds;
    const platformFamilies = async (nodeId: number): Promise<string[]> =>
      (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts.map((f) => f.familyName);

    let resolved = "";
    for (const [sel, size] of [["#p20", 20], ["#p14", 14]] as const) {
      const [nodeId] = await query(sel);
      const families = await platformFamilies(nodeId!);
      if (families.length !== 1 || !ALLOWED.has(families[0]!)) {
        throw new Error(
          `${size}px Arial resolved to [${families.join(", ")}], expected exactly one of ${[...ALLOWED].join(" / ")}. ` +
            `Install fonts-liberation (or Arial); refusing to measure with another font.`,
        );
      }
      resolved = families[0]!;
    }

    const spans = await query("#g > span");
    if (spans.length !== codePoints.length) {
      throw new Error(`expected ${codePoints.length} spans, found ${spans.length}`);
    }
    const kept: number[] = [];
    for (let i = 0; i < spans.length; i++) {
      const families = await platformFamilies(spans[i]!);
      // C0/C1 controls (general category Cc) are not glyphs: excluded
      // explicitly, whatever font the browser claims drew them.
      if (CONTROL.test(String.fromCodePoint(codePoints[i]!))) continue;
      if (families.length === 1 && ALLOWED.has(families[0]!)) kept.push(codePoints[i]!);
    }
    const excluded = codePoints.length - kept.length;

    const measured = await page.evaluate((cps) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fontKerning = "none";
      // No nested named functions here: tsx's keepNames injects a `__name`
      // helper that does not exist in the page context.
      const title: [number, number][] = [];
      const description: [number, number][] = [];
      ctx.font = "20px Arial";
      for (const cp of cps) title.push([cp, Math.round(ctx.measureText(String.fromCodePoint(cp)).width * 1000) / 1000]);
      ctx.font = "14px Arial";
      for (const cp of cps) description.push([cp, Math.round(ctx.measureText(String.fromCodePoint(cp)).width * 1000) / 1000]);
      return { title, description };
    }, kept);

    const emit = (name: string, rows: [number, number][]): string =>
      `  ${name}: {\n${rows.map(([cp, w]) => `    ${cp}: ${w},`).join("\n")}\n  },\n`;

    const header = `/**
 * GENERATED by scripts/measure-serp-glyphs.ts. Do not edit by hand.
 *
 * Per-code-point glyph advances for Google's SERP title (20px Arial) and
 * description (14px Arial) sizes, measured in Chromium with canvas
 * \`measureText(ch).width\` and rounded to 3 decimals: an advance sum, kerning
 * off (\`fontKerning = "none"\`).
 *
 * Chromium:         ${version}
 * Platform font:    ${resolved} (verified via CDP CSS.getPlatformFontsForNode for both sizes)
 * Covered ranges:   U+0020-U+052F, U+2000-U+206F, U+20A0-U+20CF (${codePoints.length} code points)
 * Excluded:         ${excluded} code points (control characters, or no glyph in the font, or painted by a fallback font; detected per code point over CDP)
 * Date:             omitted on purpose so a re-run on the same machine is byte-identical
 *
 * A code point missing from this table makes serpWidth() return null.
 */
`;
    const body =
      `export const SERP_GLYPHS: { title: Record<number, number>; description: Record<number, number> } = {\n` +
      emit("title", measured.title) +
      emit("description", measured.description) +
      `};\n`;
    writeFileSync(OUT, header + "\n" + body);
    console.log(
      `serp glyphs: ${kept.length} kept, ${excluded} excluded of ${codePoints.length}; ${resolved}; Chromium ${version}; ${Date.now() - t0} ms`,
    );
  } finally {
    await browser.close();
  }
}

await main();

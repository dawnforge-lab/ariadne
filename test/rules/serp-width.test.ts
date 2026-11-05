/**
 * serpWidth and the committed glyph table (src/rules/serp-glyphs.generated.ts).
 *
 * The last test launches a real Chromium and re-measures 20 fixed strings with
 * the same canvas settings the generator used (`20px Arial` / `14px Arial`,
 * kerning off). It proves the committed table still matches the font on THIS
 * machine. It depends on Arial or the metric-compatible Liberation Sans being
 * installed (CI's `playwright install --with-deps chromium` brings
 * `fonts-liberation`). If the font resolves to anything else it FAILS loudly;
 * it never skips and never loosens the tolerance.
 */
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { serpWidth } from "../../src/rules/serp-width.js";

const SAMPLES = [
  "Home",
  "WWW",
  "iii",
  "Buy Running Shoes Online | Free Delivery",
  "The Complete Guide to Technical SEO Audits in 2026",
  "Contact us - Example Ltd.",
  "Prices from €19.99 / £17.50 / $21",
  "Café Crème brûlée — recette facile",
  "Größe & Qualität: Über uns",
  "Привет, мир! Как дела?",
  "Καλημέρα κόσμε",
  "“Quoted” text – with dashes … and ellipsis",
  "MMMMMMMMMMMMMMMMMMMM",
  "llllllllllllllllllll",
  "0123456789 0123456789",
  "A very long description that goes on and on to check summation drift over many glyphs, which should stay within tolerance.",
  "Ñandú, año, señor, niño",
  "ŁÓDŹ Wrocław Kraków",
  "Hello, World! (v2.0) [beta] {x}",
  "UPPERCASE AND lowercase MiXeD",
];

describe("serpWidth", () => {
  it("is 0 for the empty string", () => {
    expect(serpWidth("", "title")).toBe(0);
  });

  it("measures wide glyphs wider than narrow ones", () => {
    expect(serpWidth("WWW", "title")!).toBeGreaterThan(serpWidth("iii", "title")!);
  });

  it("scales the description size to 0.7 of the title size", () => {
    const t = serpWidth("abc", "title")!;
    const d = serpWidth("abc", "description")!;
    expect(Math.abs(d - t * 0.7)).toBeLessThan(0.5);
  });

  it("returns null for a code point outside the table", () => {
    expect(serpWidth("日本", "title")).toBeNull();
    expect(serpWidth("abc 日", "description")).toBeNull();
  });

  it("returns null for C1 controls, which the HTML parser would remap to cp1252 glyphs", () => {
    expect(serpWidth("\u0085", "title")).toBeNull();
    expect(serpWidth("\u0080", "title")).toBeNull();
    expect(serpWidth("\u0080", "description")).toBeNull();
  });

  it("keeps the euro sign (U+20AC)", () => {
    expect(serpWidth("€", "title")!).toBeGreaterThan(0);
  });

  it("rounds to one decimal", () => {
    const w = serpWidth("Hello world", "title")!;
    expect(Math.round(w * 10) / 10).toBe(w);
  });

  it("matches Chromium's own canvas measurement within 0.5px for 20 samples", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await page.setContent(
        `<span id="t" style="font:20px Arial">Hamburgefonstiv</span><span id="d" style="font:14px Arial">Hamburgefonstiv</span>`,
      );
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      for (const id of ["#t", "#d"]) {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: id });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        const families = fonts.map((f) => f.familyName);
        expect(families.length).toBe(1);
        expect(["Arial", "Liberation Sans"]).toContain(families[0]);
      }
      const measured = await page.evaluate((samples) => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.fontKerning = "none";
        const out: { title: number; description: number }[] = [];
        for (const s of samples) {
          ctx.font = "20px Arial";
          const title = ctx.measureText(s).width;
          ctx.font = "14px Arial";
          out.push({ title, description: ctx.measureText(s).width });
        }
        return out;
      }, SAMPLES);
      SAMPLES.forEach((s, i) => {
        expect(Math.abs(serpWidth(s, "title")! - measured[i]!.title), `title: ${s}`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(serpWidth(s, "description")! - measured[i]!.description), `description: ${s}`).toBeLessThanOrEqual(0.5);
      });
    } finally {
      await browser.close();
    }
  }, 60_000);
});

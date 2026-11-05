import { describe, expect, it } from "vitest";
import { pixelWidthRules } from "../../src/rules/page/pixel-width.js";
import { onPageRules } from "../../src/rules/page/on-page.js";
import { serpWidth } from "../../src/rules/serp-width.js";
import { SERP_GLYPHS } from "../../src/rules/serp-glyphs.generated.js";
import {
  META_PX_MAX,
  META_PX_MIN,
  TITLE_PX_MAX,
  TITLE_PX_MIN,
} from "../../src/rules/thresholds.js";
import {
  expectSilentOnNonOkFetches,
  expectSilentOnNotJudged,
  mkPage,
  ruleLookup,
} from "./mk-page.js";

const rule = ruleLookup(pixelWidthRules, "pixelWidthRules");
const onPage = ruleLookup(onPageRules, "onPageRules");

type Kind = "title" | "description";

/**
 * A string whose measured width is EXACTLY `bound`, found by search over the
 * glyph table, so the boundary tests are built from the table and stay correct
 * after a regeneration. Two printable-ASCII glyphs, n of one and m of the other.
 */
function exactly(kind: Kind, bound: number): string {
  const table = SERP_GLYPHS[kind];
  const codes = Array.from({ length: 94 }, (_, i) => i + 33).filter((c) => table[c] !== undefined);
  for (const a of codes) {
    for (const b of codes) {
      if (a >= b) continue;
      for (let i = 1; i <= 300; i++) {
        const rest = bound - i * table[a]!;
        if (rest < 0) break;
        const m = Math.round(rest / table[b]!);
        const s = String.fromCodePoint(a).repeat(i) + String.fromCodePoint(b).repeat(m);
        if (serpWidth(s, kind) === bound) return s;
      }
    }
  }
  throw new Error(`no glyph combination measures exactly ${bound}px as a ${kind}`);
}

const CASES: Array<{
  id: string;
  field: "title" | "metaDescription";
  kind: Kind;
  bound: number;
  side: "over" | "under";
  severity: string;
  check: string;
  boundKey: "max" | "min";
}> = [
  { id: "title.pixel-too-long", field: "title", kind: "title", bound: TITLE_PX_MAX, side: "over", severity: "warning", check: "CHECK-35", boundKey: "max" },
  { id: "title.pixel-too-short", field: "title", kind: "title", bound: TITLE_PX_MIN, side: "under", severity: "info", check: "CHECK-35", boundKey: "min" },
  { id: "meta-description.pixel-too-long", field: "metaDescription", kind: "description", bound: META_PX_MAX, side: "over", severity: "warning", check: "CHECK-36", boundKey: "max" },
  { id: "meta-description.pixel-too-short", field: "metaDescription", kind: "description", bound: META_PX_MIN, side: "under", severity: "info", check: "CHECK-36", boundKey: "min" },
];

describe("pixelWidthRules metadata", () => {
  it("defines exactly the four pixel rules", () => {
    expect(pixelWidthRules.map((r) => r.id).sort()).toEqual([
      "meta-description.pixel-too-long",
      "meta-description.pixel-too-short",
      "title.pixel-too-long",
      "title.pixel-too-short",
    ]);
  });

  it("files them as on-page page rules with the severities and checks the brief names", () => {
    for (const c of CASES) {
      const r = rule(c.id);
      expect(r.kind, c.id).toBe("page");
      expect(r.category, c.id).toBe("on-page");
      expect([r.severity, ...r.checkIds], c.id).toEqual([c.severity, c.check]);
    }
  });

  it("starts the bounds at the values Task 13's calibration will confirm or move", () => {
    expect([TITLE_PX_MAX, TITLE_PX_MIN, META_PX_MAX, META_PX_MIN]).toEqual([561, 200, 985, 400]);
  });
});

describe.each(CASES)("$id", (c) => {
  const at = (s: string) => mkPage({ [c.field]: s });
  const edge = exactly(c.kind, c.bound);
  // One glyph past the bound: "!" is in the table, so the width stays known.
  const past = c.side === "over" ? edge + "!" : edge.slice(0, -1);

  it("is silent exactly on the bound (strict comparison)", () => {
    expect(serpWidth(edge, c.kind)).toBe(c.bound);
    expect(rule(c.id).run(at(edge))).toHaveLength(0);
  });

  it("fires one glyph past the bound, with the text, width and bound as evidence", () => {
    const width = serpWidth(past, c.kind)!;
    expect(c.side === "over" ? width > c.bound : width < c.bound).toBe(true);
    const out = rule(c.id).run(at(past));
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toEqual({
      [c.field]: past,
      pixelWidth: width,
      [c.boundKey]: c.bound,
    });
  });

  it("is silent on a value inside the bounds", () => {
    expect(rule(c.id).run(mkPage())).toHaveLength(0);
  });

  it("is silent when the value is missing or blank", () => {
    expect(rule(c.id).run(mkPage({ [c.field]: null }))).toHaveLength(0);
    expect(rule(c.id).run(at(""))).toHaveLength(0);
    expect(rule(c.id).run(at("   "))).toHaveLength(0);
  });

  it("is silent on a value with a character outside the measured table", () => {
    // A CJK character is not measured, so the width is unknowable, not zero.
    expect(rule(c.id).run(at(past + "日"))).toHaveLength(0);
  });

  it("declares the text, the width and the bound as columns", () => {
    expect(rule(c.id).columns?.map((col) => col.key)).toEqual([c.field, "pixelWidth", c.boundKey]);
  });
});

describe("a value in a script the table does not cover", () => {
  const cjk = "日本語のページタイトルです".repeat(8); // 104 characters, over the title limit

  it("is not pixel-judged by any title rule, while title.too-long still fires on characters", () => {
    const page = mkPage({ title: cjk });
    expect(serpWidth(cjk, "title")).toBeNull();
    for (const r of pixelWidthRules) {
      if (r.id.startsWith("title.")) expect(r.run(page), r.id).toHaveLength(0);
    }
    expect(onPage("title.too-long").run(page)).toHaveLength(1);
  });

  it("is not pixel-judged by any description rule, while meta-description.too-long still fires", () => {
    const page = mkPage({ metaDescription: cjk.repeat(2) }); // 208 characters
    for (const r of pixelWidthRules) {
      if (r.id.startsWith("meta-description.")) expect(r.run(page), r.id).toHaveLength(0);
    }
    expect(onPage("meta-description.too-long").run(page)).toHaveLength(1);
  });
});

describe("cohort", () => {
  // Each shape breaks all four rules at once: a title and description past the
  // upper bounds, and a pair under the lower ones, on separate shapes.
  const BROKEN = [
    {
      title: exactly("title", TITLE_PX_MAX) + "!",
      metaDescription: exactly("description", META_PX_MAX) + "!",
    },
    { title: "i", metaDescription: "i" },
  ];

  it("is silent on every non-OK fetch", () => {
    expectSilentOnNonOkFetches(pixelWidthRules, BROKEN);
  });

  it("is silent on an indexable 200 that is noindexed or canonicalised elsewhere", () => {
    expectSilentOnNotJudged(pixelWidthRules, BROKEN);
  });
});

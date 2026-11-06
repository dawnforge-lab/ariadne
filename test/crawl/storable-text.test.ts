import { describe, expect, it } from "vitest";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import { NUL_MARK, storableCap, storableDeep, storableText } from "../../src/crawl/storable-text.js";

describe("storableText: site text Postgres will accept", () => {
  it("replaces every U+0000 with U+2400, keeping the length", () => {
    expect(storableText("a\u0000b\u0000")).toEqual({ text: `a${NUL_MARK}b${NUL_MARK}`, cut: false });
  });

  it("replaces a lone surrogate with U+FFFD and keeps a well-formed pair", () => {
    expect(storableCap("a\uD800b\uDC00c")).toBe("a�b�c");
    expect(storableCap("😀")).toBe("😀");
  });

  it("cuts on a code-point boundary: a pair straddling the cap goes whole", () => {
    // "ab" + 😀 (two units): a cap of 3 would split the pair.
    expect(storableText("ab😀", 3)).toEqual({ text: "ab", cut: true });
    expect(storableText("ab😀", 4)).toEqual({ text: "ab😀", cut: false });
    expect(storableText("abc😀", 3)).toEqual({ text: "abc", cut: true });
  });

  it("does not cut without a cap", () => {
    expect(storableText("x".repeat(10_000))).toEqual({ text: "x".repeat(10_000), cut: false });
  });
});

describe("storableDeep: the writer's boundary (ruling R10)", () => {
  it("sanitises strings at any depth, object keys included", () => {
    expect(
      storableDeep({ a: "x\u0000", b: [{ "k\u0000": "\uD800" }], c: { d: ["e", "\uDC00f"] } }),
    ).toEqual({ a: `x${NUL_MARK}`, b: [{ [`k${NUL_MARK}`]: "�" }], c: { d: ["e", "�f"] } });
  });

  it("leaves numbers, bigints, booleans, null, undefined and Dates as they are", () => {
    const when = new Date(0);
    const out = storableDeep({ n: 1, b: 2n, t: true, z: null, u: undefined, when });
    expect(out).toStrictEqual({ n: 1, b: 2n, t: true, z: null, u: undefined, when });
    expect(out.when).toBe(when);
  });

  it("returns a clean value unchanged: every string is the same string", () => {
    const clean = {
      title: "Grüße 😀 ␀ \\u0000",
      list: ["Zürich 🚋", { k: "“quotes”" }],
      raw: { "@type": "Product", name: "Ä 😀" },
    };
    const out = storableDeep(clean);
    expect(out).toStrictEqual(clean);
    expect(JSON.stringify(out)).toBe(JSON.stringify(clean));
    expect(out.title).toBe(clean.title);
  });

  it("a clean analysed page passes through byte-identical", () => {
    const analysis = analyzePage(
      `<html lang="de"><head><title>Grüße 😀 ␀ \\u0000</title>` +
        `<meta name="description" content="Ünïcödé — “quotes”"><meta property="og:title" content="Share 🎉">` +
        `<script type="application/ld+json">{"@type":"Product","name":"Ä 😀"}</script></head>` +
        `<body><h1>Überschrift</h1><h2>Zwei 🎈</h2><a href="/z">Zürich 🚋</a><img src="/a.png"></body></html>`,
      "https://x.test/",
    );
    const out = storableDeep(analysis);
    expect(out).toStrictEqual(analysis);
    expect(JSON.stringify(out, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      JSON.stringify(analysis, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_ITEM_DEPTH,
  MAX_ITEM_VALUES,
  MAX_ITEM_WRITTEN_CHARS,
  MICRODATA_TEXT_MAX,
} from "../../src/crawl/parse/microdata.js";
import { analyzeHtml, analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import { validateBlock } from "../../src/rules/schema-org/validate.js";

const PAGE_URL = "https://example.com/shop/mug";

const page = (body: string): string =>
  `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

const microdata = (html: string) =>
  analyzeHtml(html, PAGE_URL).structuredData.filter((b) => b.format === "microdata");

describe("microdata extraction", () => {
  it("product with nested offer", () => {
    const html = page(
      `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Mug</span>` +
        `<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">` +
        `<meta itemprop="price" content="14.00"><link itemprop="availability" href="https://schema.org/InStock">` +
        `</div></div>`,
    );
    const result = analyzeHtml(html, PAGE_URL);
    expect(result.structuredData).toEqual([
      {
        type: "Product",
        format: "microdata",
        raw: {
          "@context": "https://schema.org",
          "@type": "Product",
          name: "Mug",
          offers: {
            "@type": "Offer",
            price: "14.00",
            availability: "https://schema.org/InStock",
          },
        },
      },
    ]);
    expect(result.structuredDataMicrodataErrors).toBe(0);
    expect(result.structuredDataSkips).toEqual({
      microdataItemrefSkipped: 0,
      rdfaUnsupported: 0,
      valuesCapped: 0,
    });
  });

  it("repeated property becomes an array, resolved against the page URL", () => {
    const blocks = microdata(
      page(
        `<div itemscope itemtype="https://schema.org/Product">` +
          `<img itemprop="image" src="/a.png"><img itemprop="image" src="b.png"></div>`,
      ),
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0]!.raw as Record<string, unknown>)["image"]).toEqual([
      "https://example.com/a.png",
      "https://example.com/shop/b.png",
    ]);
  });

  it("itemprop outside scope is an error", () => {
    const result = analyzeHtml(page(`<span itemprop="name">x</span>`), PAGE_URL);
    expect(result.structuredDataMicrodataErrors).toBe(1);
    expect(result.structuredData).toEqual([]);
  });

  it("top-level untyped scope is an error, nested untyped is a node", () => {
    const untyped = analyzeHtml(
      page(`<div itemscope><span itemprop="name">x</span><span itemprop="a">y</span></div>`),
      PAGE_URL,
    );
    // One error for the scope; its own properties attach to nothing and are
    // not counted again.
    expect(untyped.structuredDataMicrodataErrors).toBe(1);
    expect(untyped.structuredData).toEqual([]);

    const blank = analyzeHtml(page(`<div itemscope itemtype="  "></div>`), PAGE_URL);
    expect(blank.structuredDataMicrodataErrors).toBe(1);

    const nested = analyzeHtml(
      page(
        `<div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Ann</span>` +
          `<div itemprop="address" itemscope><span itemprop="streetAddress">1 Main St</span></div></div>`,
      ),
      PAGE_URL,
    );
    expect(nested.structuredDataMicrodataErrors).toBe(0);
    expect(nested.structuredData.map((b) => b.raw)).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "Ann",
        address: { streetAddress: "1 Main St" },
      },
    ]);
  });

  it("itemref counted, not followed", () => {
    const result = analyzeHtml(
      page(
        `<div itemscope itemtype="https://schema.org/Person" itemref="extra"><span itemprop="name">Ann</span></div>` +
          `<p id="extra"><span itemprop="jobTitle">Chef</span></p>`,
      ),
      PAGE_URL,
    );
    expect(result.structuredDataSkips.microdataItemrefSkipped).toBe(1);
    expect(result.structuredData.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Person", name: "Ann" },
    ]);
    // Not followed, so the referenced property is, to a forward pass, an
    // itemprop with no open item scope — and is counted as one.
    expect(result.structuredDataMicrodataErrors).toBe(1);
  });

  it("template and noscript are inert", () => {
    const result = analyzeHtml(
      page(
        `<template><div itemscope itemtype="https://schema.org/Thing"><span itemprop="name">x</span></div>` +
          `<span itemprop="stray">s</span></template>` +
          `<noscript><div itemscope itemtype="https://schema.org/Thing"><span itemprop="name">y</span></div>` +
          `<span itemprop="stray">s</span></noscript>` +
          `<template itemscope itemtype="https://schema.org/Thing"></template>` +
          `<noscript itemscope itemtype="https://schema.org/Thing"></noscript>`,
      ),
      PAGE_URL,
    );
    expect(result.structuredData).toEqual([]);
    expect(result.structuredDataMicrodataErrors).toBe(0);
  });

  it("reads text outside NON_CONTENT_TAGS and template only (R0.9)", () => {
    const blocks = microdata(
      page(
        `<div itemscope itemtype="https://schema.org/Thing"><span itemprop="name">  a` +
          `<template>T</template><noscript>N</noscript><script>S</script><style>Y</style>` +
          `<svg><text>V</text></svg>\n\n  b <b>c</b>  </span></div>`,
      ),
    );
    expect((blocks[0]!.raw as Record<string, unknown>)["name"]).toBe("a b c");
  });

  it("JSON-LD blocks say format jsonld", () => {
    const result = analyzeHtml(
      page(`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>`),
      PAGE_URL,
    );
    expect(result.structuredData).toEqual([
      {
        type: "Organization",
        format: "jsonld",
        raw: { "@context": "https://schema.org", "@type": "Organization" },
      },
    ]);
  });

  it("shared block cap: 30 JSON-LD nodes plus 30 microdata items give exactly 50 blocks", () => {
    const ld = Array.from({ length: 30 }, (_, i) => `{"@type":"Thing","name":"ld${i}"}`).join(",");
    const items = Array.from(
      { length: 30 },
      (_, i) => `<div itemscope itemtype="https://schema.org/Thing"><span itemprop="name">md${i}</span></div>`,
    ).join("");
    const result = analyzeHtml(
      page(`<script type="application/ld+json">[${ld}]</script>${items}`),
      PAGE_URL,
    );
    expect(result.structuredData).toHaveLength(50);
    expect(result.structuredData.filter((b) => b.format === "jsonld")).toHaveLength(30);
    expect(result.structuredData.filter((b) => b.format === "microdata")).toHaveLength(20);
  });

  it("every value form follows the spec list", () => {
    const blocks = microdata(
      page(
        `<div itemscope itemtype="https://schema.org/Event http://example.org/Other" itemid="/events/1">` +
          `<meta itemprop="a" content="meta-content">` +
          `<a itemprop="b" href="../x">link text</a>` +
          `<link itemprop="c" href="https://other.example/y">` +
          `<audio itemprop="d" src="s.mp3"></audio><video itemprop="d" src="v.mp4"></video>` +
          `<source itemprop="d" src="src.webm"><iframe itemprop="d" src="if.html"></iframe>` +
          `<embed itemprop="d" src="e.swf"><track itemprop="d" src="t.vtt">` +
          `<a itemprop="e" href="http://[bad">bad</a>` +
          `<a itemprop="f">no href</a>` +
          `<time itemprop="g" datetime="2026-11-13">13 Nov</time><time itemprop="h"> 14  Nov </time>` +
          `<data itemprop="i" value="42">forty-two</data><meter itemprop="j" value="0.5">half</meter>` +
          `<span itemprop="k l">both</span><span itemprop="m m">once</span>` +
          `</div>`,
      ),
    );
    expect(blocks).toEqual([
      {
        type: "Event",
        format: "microdata",
        raw: {
          "@context": "https://schema.org",
          "@type": "Event",
          "@id": "https://example.com/events/1",
          a: "meta-content",
          b: "https://example.com/x",
          c: "https://other.example/y",
          d: [
            "https://example.com/shop/s.mp3",
            "https://example.com/shop/v.mp4",
            "https://example.com/shop/src.webm",
            "https://example.com/shop/if.html",
            "https://example.com/shop/e.swf",
            "https://example.com/shop/t.vtt",
          ],
          e: "http://[bad",
          f: "",
          g: "2026-11-13",
          h: "14 Nov",
          i: "42",
          j: "0.5",
          k: "both",
          l: "both",
          m: "once",
        },
      },
    ]);
  });

  it("content is the value on any element that carries it (29a final review M1)", () => {
    const blocks = microdata(
      page(
        `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Mug</span>` +
          `<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">` +
          `<span itemprop="price" content="10.00">$10</span>` +
          `<span itemprop="priceCurrency" content="USD"></span></div>` +
          `<div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">` +
          `<span itemprop="ratingValue" content="4.5"></span><span itemprop="reviewCount" content="12"></span></div>` +
          `<a itemprop="url" href="/mug" content="https://example.com/canonical-mug">mug</a>` +
          `<time itemprop="releaseDate" datetime="2026-01-01" content="2026-02-02">Feb</time>` +
          `<span itemprop="sku" content="">SKU-1</span>` +
          `</div>`,
      ),
    );
    expect(blocks.map((b) => b.raw)).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Mug",
        offers: { "@type": "Offer", price: "10.00", priceCurrency: "USD" },
        aggregateRating: { "@type": "AggregateRating", ratingValue: "4.5", reviewCount: "12" },
        url: "https://example.com/canonical-mug",
        releaseDate: "2026-02-02",
        // An empty content attribute is the value as written, not the text.
        sku: "",
      },
    ]);
    // The empty elements' content values reach the validator as values; only
    // the empty content attribute is an empty value.
    const v = validateBlock(blocks[0]!.raw, PAGE_URL);
    expect(v.emptyValues).toEqual([{ path: "$.sku", type: "Product", property: "sku" }]);
    expect(v.nodes[0]!.emptyProperties).toEqual(["sku"]);
  });

  it("keeps a non-schema.org type as written, and property order is document order", () => {
    const blocks = microdata(
      page(
        `<div itemscope itemtype="http://data-vocabulary.org/Breadcrumb">` +
          `<span itemprop="n">outer <span itemprop="n">inner</span></span></div>`,
      ),
    );
    expect(blocks).toEqual([
      {
        type: "http://data-vocabulary.org/Breadcrumb",
        format: "microdata",
        raw: {
          "@context": "https://schema.org",
          "@type": "http://data-vocabulary.org/Breadcrumb",
          n: ["outer inner", "inner"],
        },
      },
    ]);
  });

  it("an item without itemprop inside another item is a top-level item of its own", () => {
    const blocks = microdata(
      page(
        `<div itemscope itemtype="https://schema.org/WebPage"><span itemprop="name">P</span>` +
          `<div itemscope itemtype="https://schema.org/Organization"><span itemprop="name">O</span></div>` +
          `</div>`,
      ),
    );
    // Emitted as each item closes: the inner one first.
    expect(blocks.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Organization", name: "O" },
      { "@context": "https://schema.org", "@type": "WebPage", name: "P" },
    ]);
  });

  it("a typed itemprop+itemscope with no enclosing item is an error and still a top-level item", () => {
    const result = analyzeHtml(
      page(
        `<div itemprop="mainEntity" itemscope itemtype="https://schema.org/Product">` +
          `<span itemprop="name">Mug</span></div>`,
      ),
      PAGE_URL,
    );
    expect(result.structuredDataMicrodataErrors).toBe(1);
    expect(result.structuredData.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Product", name: "Mug" },
    ]);
  });

  it("an @-keyword property name is an error, never a property", () => {
    const result = analyzeHtml(
      page(
        `<div itemscope itemtype="https://schema.org/Thing">` +
          `<span itemprop="@type name">x</span><span itemprop="@id">y</span></div>`,
      ),
      PAGE_URL,
    );
    expect(result.structuredDataMicrodataErrors).toBe(2);
    expect(result.structuredData.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Thing", name: "x" },
    ]);
  });

  it("a __proto__ property is an own key, not the prototype", () => {
    const blocks = microdata(
      page(`<div itemscope itemtype="https://schema.org/Thing"><span itemprop="__proto__">x</span></div>`),
    );
    const raw = blocks[0]!.raw as Record<string, unknown>;
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(raw, "__proto__")).toBe(true);
  });

  it("a document that ends inside an item still emits it", () => {
    const blocks = microdata(
      `<div itemscope itemtype="https://schema.org/Thing"><span itemprop="name">cut`,
    );
    expect(blocks.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Thing", name: "cut" },
    ]);
  });

  it("the facade carries both new fields", () => {
    const facade = analyzePage(
      page(`<div itemscope itemtype="https://schema.org/Thing" itemref="x"></div><span itemprop="n">a</span>`),
      PAGE_URL,
    );
    expect(facade.structuredDataMicrodataErrors).toBe(1);
    expect(facade.structuredDataSkips).toEqual({
      microdataItemrefSkipped: 1,
      rdfaUnsupported: 0,
      valuesCapped: 0,
    });
  });
});

describe("microdata adversarial size (Review Focus 4)", () => {
  it("10,000 values in one item keep 1,000 and count 9,000 as capped", () => {
    const metas = `<meta itemprop="x" content="y">`.repeat(10_000);
    const result = analyzeHtml(
      page(`<div itemscope itemtype="https://schema.org/Thing">${metas}</div>`),
      PAGE_URL,
    );
    expect(MAX_ITEM_VALUES).toBe(1000);
    const raw = result.structuredData[0]!.raw as Record<string, unknown>;
    expect(raw["x"]).toHaveLength(1000);
    expect(result.structuredDataSkips.valuesCapped).toBe(9000);
  });

  it("the value budget is per page, across items", () => {
    const item = `<div itemscope itemtype="https://schema.org/Thing">${`<meta itemprop="x" content="y">`.repeat(600)}</div>`;
    const result = analyzeHtml(page(item + item), PAGE_URL);
    const lengths = result.structuredData.map((b) => {
      const x = (b.raw as Record<string, unknown>)["x"];
      return Array.isArray(x) ? x.length : x === undefined ? 0 : 1;
    });
    expect(lengths).toEqual([600, 400]);
    expect(result.structuredDataSkips.valuesCapped).toBe(200);
  });

  it("a nested item past the cap counts once, and its own properties count themselves", () => {
    const filler = `<meta itemprop="x" content="y">`.repeat(1000);
    const result = analyzeHtml(
      page(
        `<div itemscope itemtype="https://schema.org/Thing">${filler}` +
          `<div itemprop="sub" itemscope itemtype="https://schema.org/Thing">` +
          `<span itemprop="a">1</span><span itemprop="b">2</span></div></div>`,
      ),
      PAGE_URL,
    );
    const raw = result.structuredData[0]!.raw as Record<string, unknown>;
    expect(raw["sub"]).toBeUndefined();
    expect(result.structuredDataSkips.valuesCapped).toBe(3);
  });

  it("a nested item under several names cannot multiply past the per-page cap", () => {
    // Each level is one value from the budget but is written once per name, so
    // without an emission cap 8 names x 9 levels would write 8^9 nodes.
    const names = "a b c d e f g h";
    const levels = 9;
    const html = page(
      `<div itemscope itemtype="https://schema.org/Thing">` +
        `<div itemprop="${names}" itemscope itemtype="https://schema.org/Thing">`.repeat(levels) +
        `<span itemprop="leaf">x</span>` +
        "</div>".repeat(levels + 1),
    );
    const result = analyzeHtml(html, PAGE_URL);
    const count = (v: unknown): number => {
      if (Array.isArray(v)) return v.reduce((n: number, x) => n + count(x), 0);
      if (v === null || typeof v !== "object") return 1;
      return Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !k.startsWith("@"))
        .reduce((n, [, x]) => n + count(x), 0) + 1;
    };
    // The top-level node itself is not a value; every other node and string is.
    expect(count(result.structuredData[0]!.raw) - 1).toBe(MAX_ITEM_VALUES);
    expect(result.structuredDataSkips.valuesCapped).toBeGreaterThan(0);
  });

  it("a long attribute value under many names cannot multiply past the per-page character cap", () => {
    const names = Array.from({ length: 300 }, (_, i) => `p${i}`).join(" ");
    const big = "x".repeat(1_000_000);
    const result = analyzeHtml(
      page(`<div itemscope itemtype="https://schema.org/Thing"><meta itemprop="${names}" content="${big}"></div>`),
      PAGE_URL,
    );
    expect(JSON.stringify(result.structuredData).length).toBeLessThan(MAX_ITEM_WRITTEN_CHARS + 10_000);
    expect(result.structuredDataSkips.valuesCapped).toBeGreaterThan(0);
  });

  it("a long itemid on a node under many names cannot multiply past the per-page character cap", () => {
    const names = Array.from({ length: 300 }, (_, i) => `p${i}`).join(" ");
    const id = `https://example.com/${"y".repeat(1_000_000)}`;
    const result = analyzeHtml(
      page(
        `<div itemscope itemtype="https://schema.org/Thing">` +
          `<div itemprop="${names}" itemscope itemtype="https://schema.org/Thing" itemid="${id}"></div></div>`,
      ),
      PAGE_URL,
    );
    expect(JSON.stringify(result.structuredData).length).toBeLessThan(MAX_ITEM_WRITTEN_CHARS + 10_000);
    expect(result.structuredDataSkips.valuesCapped).toBeGreaterThan(0);
  });

  it("a value written under two names costs two of the per-page cap", () => {
    const metas = `<meta itemprop="a b" content="y">`.repeat(600);
    const result = analyzeHtml(
      page(`<div itemscope itemtype="https://schema.org/Thing">${metas}</div>`),
      PAGE_URL,
    );
    const raw = result.structuredData[0]!.raw as Record<string, unknown>;
    expect(raw["a"]).toHaveLength(600);
    expect(raw["b"]).toHaveLength(400);
    expect(result.structuredDataSkips.valuesCapped).toBe(200);
  });

  it("nesting 200 deep returns, with errors counting the levels past 32", () => {
    const levels = 200;
    const open =
      `<div itemscope itemtype="https://schema.org/Thing">` +
      `<div itemprop="child" itemscope itemtype="https://schema.org/Thing">`.repeat(levels - 1);
    const html = page(`${open}<span itemprop="leaf">deep</span>${"</div>".repeat(levels)}`);
    const result = analyzeHtml(html, PAGE_URL);
    expect(MAX_ITEM_DEPTH).toBe(32);
    expect(result.structuredDataMicrodataErrors).toBe(levels - MAX_ITEM_DEPTH);
    expect(result.structuredData).toHaveLength(1);
    let node = result.structuredData[0]!.raw as Record<string, unknown>;
    let depth = 1;
    while (node["child"] !== undefined) {
      node = node["child"] as Record<string, unknown>;
      depth += 1;
    }
    expect(depth).toBe(MAX_ITEM_DEPTH);
    // The leaf sat under an item that was never opened: it attached to nothing.
    expect(node["leaf"]).toBeUndefined();
  });

  it("a 1 MB text inside an itemprop gives a 500-character value", () => {
    const big = "word ".repeat(200_000) + "x".repeat(10);
    const result = analyzeHtml(
      page(`<div itemscope itemtype="https://schema.org/Thing"><span itemprop="description">${big}</span></div>`),
      PAGE_URL,
    );
    const value = (result.structuredData[0]!.raw as Record<string, unknown>)["description"] as string;
    expect(MICRODATA_TEXT_MAX).toBe(500);
    expect(value).toHaveLength(MICRODATA_TEXT_MAX);
    expect(value).toBe(big.replace(/\s+/g, " ").trim().slice(0, MICRODATA_TEXT_MAX));
  });

  it("whitespace runs are collapsed before the cap, not counted against it", () => {
    const text = `a${" ".repeat(5000)}b${"\n".repeat(5000)}c`;
    const blocks = microdata(
      page(`<div itemscope itemtype="https://schema.org/Thing"><span itemprop="d">${text}</span></div>`),
    );
    expect((blocks[0]!.raw as Record<string, unknown>)["d"]).toBe("a b c");
  });
});

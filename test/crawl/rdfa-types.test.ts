import { describe, expect, it } from "vitest";
import { analyzeHtml } from "../../src/crawl/parse/page-analyzer.js";

const PAGE_URL = "https://example.com/shop/mug";

const rdfa = (body: string) => {
  const result = analyzeHtml(
    `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`,
    PAGE_URL,
  );
  return {
    blocks: result.structuredData.filter((b) => b.format === "rdfa"),
    skips: result.structuredDataSkips,
  };
};

const typeOf = (b: { raw: unknown }) => (b.raw as Record<string, unknown>)["@type"];

describe("RDFa typeof keeps every schema.org token (extraction 5)", () => {
  it("two schema: tokens give both, schema_type is the first", () => {
    const { blocks, skips } = rdfa(`<div vocab="https://schema.org/" typeof="schema:Product schema:Offer"></div>`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("Product");
    expect(typeOf(blocks[0]!)).toEqual(["Product", "Offer"]);
    expect(skips.rdfaUnsupported).toBe(0);
  });

  it("a foreign token beside a schema.org one is left out and the element is not counted unsupported", () => {
    const { blocks, skips } = rdfa(`<div vocab="https://schema.org/" typeof="schema:Product foaf:Thing"></div>`);
    expect(blocks).toHaveLength(1);
    expect(typeOf(blocks[0]!)).toBe("Product");
    expect(skips.rdfaUnsupported).toBe(0);
  });

  it("a foreign token alone is counted unsupported, as before", () => {
    const { blocks, skips } = rdfa(`<div vocab="https://schema.org/" typeof="foaf:Thing"></div>`);
    expect(blocks).toEqual([]);
    expect(skips.rdfaUnsupported).toBe(1);
  });

  it("a single token stays a string and duplicates collapse", () => {
    const { blocks } = rdfa(`<div vocab="https://schema.org/" typeof="Product schema:Product"></div>`);
    expect(typeOf(blocks[0]!)).toBe("Product");
  });
});

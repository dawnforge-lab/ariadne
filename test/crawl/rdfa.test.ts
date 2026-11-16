import { describe, expect, it } from "vitest";
import { createItemCore, type StructuredDataCounts } from "../../src/crawl/parse/item-core.js";
import { createMicrodataMachine } from "../../src/crawl/parse/microdata.js";
import { analyzeHtml } from "../../src/crawl/parse/page-analyzer.js";
import { createRdfaMachine } from "../../src/crawl/parse/rdfa.js";

const PAGE_URL = "https://example.com/shop/mug";

const page = (body: string): string =>
  `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

const rdfa = (body: string) => {
  const result = analyzeHtml(page(body), PAGE_URL);
  return {
    blocks: result.structuredData.filter((b) => b.format === "rdfa"),
    all: result.structuredData,
    skips: result.structuredDataSkips,
    errors: result.structuredDataMicrodataErrors,
  };
};

describe("RDFa Lite extraction", () => {
  it("organization via vocab", () => {
    const { blocks, errors } = rdfa(
      `<div vocab="https://schema.org/" typeof="Organization"><span property="name">Estuary</span>` +
        `<a property="url" href="/">home</a></div>`,
    );
    expect(blocks).toEqual([
      {
        type: "Organization",
        format: "rdfa",
        raw: {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "Estuary",
          url: "https://example.com/",
        },
      },
    ]);
    expect(errors).toBe(0);
  });

  it("http vocab without the trailing slash is schema.org too", () => {
    const { blocks } = rdfa(
      `<div vocab="http://schema.org" typeof="Thing"><span property="name">x</span></div>`,
    );
    expect(blocks).toHaveLength(1);
  });

  it("schema prefix without vocab", () => {
    const { blocks } = rdfa(
      `<div typeof="schema:Product"><span property="schema:name">Mug</span></div>`,
    );
    expect(blocks.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Product", name: "Mug" },
    ]);
  });

  it("nested typeof is a property value", () => {
    const { blocks } = rdfa(
      `<div vocab="https://schema.org/" typeof="Product"><span property="name">Mug</span>` +
        `<div property="offers" typeof="Offer" resource="#offer"><meta property="price" content="14.00">` +
        `<link property="availability" href="https://schema.org/InStock"></div></div>`,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.raw).toEqual({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Mug",
      offers: {
        "@type": "Offer",
        "@id": "https://example.com/shop/mug#offer",
        price: "14.00",
        availability: "https://schema.org/InStock",
      },
    });
  });

  it("value precedence: content, resource, href/src, datetime on time, text", () => {
    const { blocks } = rdfa(
      `<div vocab="https://schema.org/" typeof="Event">` +
        `<span property="a" content="C" resource="/r" href="/h">t</span>` +
        `<span property="b" resource="/r" href="/h">t</span>` +
        `<img property="c" src="i.png">` +
        `<time property="d" datetime="2026-01-01">January</time>` +
        `<span property="e">  some   text </span></div>`,
    );
    expect(blocks[0]!.raw).toEqual({
      "@context": "https://schema.org",
      "@type": "Event",
      a: "C",
      b: "https://example.com/r",
      c: "https://example.com/shop/i.png",
      d: "2026-01-01",
      e: "some text",
    });
  });

  it("full RDFa is counted, not misread", () => {
    const aboutPage = rdfa(
      `<div vocab="https://schema.org/" typeof="Thing" about="#me"><span property="name">x</span></div>`,
    );
    expect(aboutPage.blocks).toEqual([]);
    expect(aboutPage.skips.rdfaUnsupported).toBe(1);
    expect(aboutPage.errors).toBe(0);

    const relPage = rdfa(
      `<div vocab="https://schema.org/" typeof="Thing"><a property="url" rel="me" href="/x">x</a></div>`,
    );
    expect(relPage.blocks).toHaveLength(1);
    expect(relPage.blocks[0]!.raw).not.toHaveProperty("url");
    expect(relPage.skips.rdfaUnsupported).toBe(1);

    const foaf = rdfa(
      `<div vocab="http://xmlns.com/foaf/0.1/" typeof="Person"><span property="name">x</span></div>`,
    );
    expect(foaf.blocks).toEqual([]);
    expect(foaf.skips.rdfaUnsupported).toBe(2);

    const prefixed = rdfa(`<div typeof="foaf:Person"><span property="foaf:name">x</span></div>`);
    expect(prefixed.blocks).toEqual([]);
    expect(prefixed.skips.rdfaUnsupported).toBe(2);
    expect(prefixed.errors).toBe(0);

    const rebound = rdfa(
      `<div prefix="schema: http://example.org/ns#" typeof="schema:Thing"></div>`,
    );
    expect(rebound.blocks).toEqual([]);
    expect(rebound.skips.rdfaUnsupported).toBe(1);
  });

  it("plain rel on a link is not RDFa", () => {
    const { skips, blocks } = rdfa(
      `<a rel="nofollow" href="/x">x</a><link rel="canonical" href="/c">`,
    );
    expect(skips.rdfaUnsupported).toBe(0);
    expect(blocks).toEqual([]);
  });

  it("a property with no enclosing typeof describes the document: a skip, not an error (29a final review I2)", () => {
    // Valid RDFa 1.1: with no new subject, the property attaches to the document.
    const { blocks, errors, skips } = rdfa(`<span vocab="https://schema.org/" property="name">x</span>`);
    expect(blocks).toEqual([]);
    expect(errors).toBe(0);
    expect(skips.rdfaUnsupported).toBe(1);

    // The Drupal shape: the page title outside the typed article, via the schema: prefix.
    const drupal = rdfa(
      `<h1 property="schema:name">Title</h1>` +
        `<article typeof="schema:Article"><span property="schema:headline">Title</span></article>`,
    );
    expect(drupal.blocks.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Article", headline: "Title" },
    ]);
    expect(drupal.errors).toBe(0);
    expect(drupal.skips.rdfaUnsupported).toBe(1);

    // A typed node that is the document's property is still a block of its own;
    // only the link from the document is dropped, and counted.
    const linked = rdfa(
      `<div vocab="https://schema.org/" property="mainEntity" typeof="Product"><span property="name">Mug</span></div>`,
    );
    expect(linked.blocks.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Product", name: "Mug" },
    ]);
    expect(linked.errors).toBe(0);
    expect(linked.skips.rdfaUnsupported).toBe(1);
  });

  it("an empty top-level typeof is still a structural error", () => {
    const { blocks, errors } = rdfa(`<div vocab="https://schema.org/" typeof=""><span property="name">x</span></div>`);
    expect(blocks).toEqual([]);
    expect(errors).toBe(1);
  });

  it("nothing is read inside a template", () => {
    const { blocks } = rdfa(
      `<template><div vocab="https://schema.org/" typeof="Thing"></div></template>`,
    );
    expect(blocks).toEqual([]);
  });

  it("mixed formats on one page, in document order", () => {
    const result = analyzeHtml(
      `<!doctype html><html><head><script type="application/ld+json">` +
        `{"@context":"https://schema.org","@type":"WebSite","name":"s"}</script></head><body>` +
        `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Mug</span></div>` +
        `<div vocab="https://schema.org/" typeof="Organization"><span property="name">Estuary</span></div>` +
        `</body></html>`,
      PAGE_URL,
    );
    expect(result.structuredData.map((b) => [b.format, b.type])).toEqual([
      ["jsonld", "WebSite"],
      ["microdata", "Product"],
      ["rdfa", "Organization"],
    ]);
  });

  it("shares the value budget with microdata", () => {
    const metas = `<meta property="x" content="y">`.repeat(1005);
    const result = analyzeHtml(
      page(`<div vocab="https://schema.org/" typeof="Thing">${metas}</div>`),
      PAGE_URL,
    );
    expect((result.structuredData[0]!.raw as Record<string, unknown>)["x"]).toHaveLength(1000);
    expect(result.structuredDataSkips.valuesCapped).toBe(5);
  });

  it("a nested node under several property names cannot multiply past the cap", () => {
    const levels = 9;
    const html = page(
      `<div vocab="https://schema.org/" typeof="Thing">` +
        `<div property="a b c d e f g h" typeof="Thing">`.repeat(levels) +
        `<span property="name">x</span>` +
        "</div>".repeat(levels + 1),
    );
    const result = analyzeHtml(html, PAGE_URL);
    expect(JSON.stringify(result.structuredData).length).toBeLessThan(200_000);
    expect(result.structuredDataSkips.valuesCapped).toBeGreaterThan(0);
  });
});

describe("prefix attribute parsing is linear", () => {
  const timed = (prefix: string) => {
    const start = performance.now();
    const r = rdfa(`<div prefix="${prefix}" typeof="schema:Thing"></div>`);
    return { ms: performance.now() - start, r };
  };

  it("100,000 colon-free characters", () => {
    const { ms, r } = timed("a".repeat(100_000));
    expect(ms).toBeLessThan(250);
    expect(r.blocks).toHaveLength(1);
    expect(r.skips.rdfaUnsupported).toBe(0);
  });

  it("100,000 characters of a: b pairs, then a schema rebind still bites", () => {
    const pairs = "a: b ".repeat(20_000);
    const ok = timed(pairs);
    expect(ok.ms).toBeLessThan(250);
    expect(ok.r.blocks).toHaveLength(1);
    const rebound = timed(`${pairs}schema: http://example.org/ns#`);
    expect(rebound.ms).toBeLessThan(250);
    expect(rebound.r.blocks).toEqual([]);
    expect(rebound.r.skips.rdfaUnsupported).toBe(1);
  });
});

describe("machine end() with a frame still open", () => {
  const counts = (): StructuredDataCounts => ({
    errors: 0,
    skips: { microdataItemrefSkipped: 0, rdfaUnsupported: 0, valuesCapped: 0 },
    valuesUsed: 0,
    valuesWritten: 0,
  });

  it("the RDFa machine throws, naming itself and the open frames", () => {
    const machine = createRdfaMachine(PAGE_URL, () => {}, counts());
    machine.open("div", { vocab: "https://schema.org/", typeof: "Thing" }, 1);
    expect(() => machine.end()).toThrow(/rdfa: end\(\) with 1 item frame/);
  });

  it("the microdata machine throws, naming itself and the open frames", () => {
    const machine = createMicrodataMachine(PAGE_URL, () => {}, counts());
    machine.open("div", { itemscope: "", itemtype: "https://schema.org/Thing" }, 1);
    expect(() => machine.end()).toThrow(/microdata: end\(\) with 1 item frame/);
  });

  it("the core throws with an open frame and is quiet when everything closed", () => {
    const core = createItemCore("rdfa", () => {}, counts());
    expect(() => core.end()).not.toThrow();
    core.openDead(1);
    expect(() => core.end()).toThrow(/rdfa: end\(\) with 1 item frame/);
  });

  it("a document that ends inside an item still emits it (through parser.end)", () => {
    const { blocks } = rdfa(`<div vocab="https://schema.org/" typeof="Thing"><span property="name">cut`);
    expect(blocks.map((b) => b.raw)).toEqual([
      { "@context": "https://schema.org", "@type": "Thing", name: "cut" },
    ]);
  });
});

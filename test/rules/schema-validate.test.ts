import { describe, expect, it } from "vitest";

import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import {
  MAX_PROBLEMS_PER_LIST,
  blockValidationSchema,
  validateBlock,
  type BlockValidation,
} from "../../src/rules/schema-org/validate.js";

/** Every validation produced in this file, round-tripped through the schema at the end. */
const produced: BlockValidation[] = [];
function validate(raw: unknown): BlockValidation {
  const v = validateBlock(raw);
  produced.push(v);
  return v;
}

const CTX = "https://schema.org";

function product(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@context": CTX,
    "@type": "Product",
    name: "Widget",
    image: "https://example.com/w.jpg",
    description: "A widget",
    sku: "W-1",
    mpn: "M-1",
    gtin13: "0123456789012",
    brand: { "@type": "Brand", name: "Acme" },
    offers: {
      "@type": "Offer",
      price: "9.99",
      priceCurrency: "GBP",
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      url: "https://example.com/w",
    },
    ...extra,
  };
}

function expectNoProblems(v: BlockValidation): void {
  expect(v.unknownTypes).toEqual([]);
  expect(v.unknownProperties).toEqual([]);
  expect(v.propertyStatus).toEqual([]);
  expect(v.typeMismatches).toEqual([]);
  expect(v.emptyValues).toEqual([]);
  expect(v.references).toEqual([]);
  expect(v.outsideVocabulary).toBe(0);
  expect(v.listsCapped).toBe(false);
}

describe("validateBlock — the schema.org vocabulary", () => {
  it("a valid product with offer has no problems and one top-level node", () => {
    const v = validate(product());
    expectNoProblems(v);
    expect(v.topType).toBe("Product");
    expect(v.nodes).toEqual([
      {
        path: "$",
        type: "Product",
        properties: ["name", "image", "description", "sku", "mpn", "gtin13", "brand", "offers"],
        emptyProperties: [],
        propertiesCapped: false,
      },
    ]);
  });

  it("unknown type", () => {
    const v = validate({ "@context": CTX, "@type": "Prodcut", name: "x" });
    expect(v.unknownTypes).toEqual([{ path: "$", type: "Prodcut" }]);
    expect(v.topType).toBeNull();
    // A node with no known type has its properties left unjudged.
    expect(v.unknownProperties).toEqual([]);
  });

  it("unknown property", () => {
    const v = validate({ "@type": "Product", colour: "red" });
    expect(v.unknownProperties).toEqual([{ path: "$", type: "Product", property: "colour" }]);
  });

  it("a property outside the node's types is an unknown property too", () => {
    const v = validate({ "@type": "Person", price: "3" });
    expect(v.unknownProperties).toEqual([{ path: "$", type: "Person", property: "price" }]);
  });

  it("pending property goes to propertyStatus, not unknownProperties", () => {
    // `gtin` is pending in schema.org 30.1.
    const v = validate({ "@type": "Product", name: "x", gtin: "0123456789012" });
    expect(v.propertyStatus).toEqual([
      { path: "$", property: "gtin", status: "pending", supersededBy: null },
    ]);
    expect(v.unknownProperties).toEqual([]);
  });

  it("superseded property names its replacement", () => {
    const v = validate({ "@type": "VideoObject", actors: { "@type": "Person", name: "A" } });
    expect(v.propertyStatus).toEqual([
      { path: "$", property: "actors", status: "superseded", supersededBy: "actor" },
    ]);
  });

  it("range mismatch", () => {
    const v = validate({ "@type": "Product", offers: { "@type": "Person" } });
    expect(v.typeMismatches).toHaveLength(1);
    expect(v.typeMismatches[0]).toMatchObject({ path: "$.offers", property: "offers", type: "Person" });
    expect(v.typeMismatches[0]!.expected).toContain("Offer");
  });

  it("indexes a mismatch inside an array", () => {
    const v = validate({ "@type": "Product", offers: [{ "@type": "Offer" }, { "@type": "Person" }] });
    expect(v.typeMismatches.map((m) => m.path)).toEqual(["$.offers[1]"]);
  });

  it("text where a type is expected is not a mismatch", () => {
    const v = validate({ "@context": CTX, "@type": "Article", author: "Jane" });
    expect(v.typeMismatches).toEqual([]);
    expect(v.unknownProperties).toEqual([]);
  });

  it("a node typed only outside schema.org is walked as untyped", () => {
    const v = validate({
      "@context": CTX,
      "@type": "http://data-vocabulary.org/Breadcrumb",
      title: "Home",
      price: "3",
      gtin: "1",
      offers: { "@type": "Person" },
      child: { "@type": "Prodcut" },
    });
    expect(v.topType).toBeNull();
    expect(v.unknownProperties).toEqual([]);
    expect(v.propertyStatus).toEqual([]);
    expect(v.typeMismatches).toEqual([]);
    // The foreign type counts; bare keys are schema.org names, so they do not.
    expect(v.outsideVocabulary).toBe(1);
    // Descendants are still walked.
    expect(v.unknownTypes).toEqual([{ path: "$.child", type: "Prodcut" }]);
  });

  it("an untyped nested object is not judged, but typed nodes inside it are walked", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Organization",
      name: "Acme",
      address: { streetAddress: "1 High St", colour: "red", inner: { "@type": "Prodcut" } },
    });
    expect(v.unknownProperties).toEqual([]);
    expect(v.unknownTypes).toEqual([{ path: "$.address.inner", type: "Prodcut" }]);
  });

  it("a typed @graph container is judged as its own node and its members are not walked again", () => {
    const v = validate({
      "@context": CTX,
      "@type": "WebPage",
      name: "Home",
      "@graph": [{ "@type": "Prodcut" }, { "@type": "Product" }],
    });
    expect(v.topType).toBe("WebPage");
    expect(v.unknownTypes).toEqual([]);
    // The container is one node; its members are blocks of their own.
    expect(v.nodes).toEqual([
      { path: "$", type: "WebPage", properties: ["name"], emptyProperties: [], propertiesCapped: false },
    ]);
  });

  it("every schema.org spelling gives the same verdict", () => {
    const base = validate(product());
    const spellings: unknown[] = [
      product({ "@type": ["Product", "Thing"] }),
      product({ "@type": "schema:Product" }),
      product({ "@type": "https://schema.org/Product" }),
      product({ "@type": "http://www.schema.org/Product" }),
      product({ "@context": "http://schema.org/" }),
      product({ "@context": ["https://schema.org", { "@language": "en" }] }),
      product({ "@context": { "@vocab": "https://schema.org/" } }),
    ];
    // An @graph member as the analyzer stores it: no @context of its own.
    const member = product();
    delete member["@context"];
    spellings.push(member);
    for (const raw of spellings) expect(validate(raw)).toEqual(base);
  });

  it("a block in another vocabulary is counted and never judged", () => {
    const v = validate({
      "@context": { "@vocab": "https://example.org/" },
      "@type": "Product",
      name: "x",
      offers: { "@type": "Person" },
    });
    // Two nodes, each with its own non-keyword keys: 2 + (name, offers) = 4.
    expect(v.outsideVocabulary).toBe(4);
    expect(v.topType).toBeNull();
    expect(v.unknownTypes).toEqual([]);
    expect(v.unknownProperties).toEqual([]);
    expect(v.propertyStatus).toEqual([]);
    expect(v.typeMismatches).toEqual([]);

    const stringContext = validate({ "@context": "https://example.org/ctx", "@type": "Product" });
    expect(stringContext.outsideVocabulary).toBe(1);
  });

  it("a @graph member stored by the analyzer keeps its container's vocabulary", () => {
    const outside = analyzePage(
      `<script type="application/ld+json">{"@context":{"@vocab":"https://example.org/"},"@graph":[{"@type":"Product","colour":"red"}]}</script>`,
      "https://ex.com/",
    ).structuredData;
    expect(outside).toHaveLength(1);
    const v = validate(outside[0]!.raw);
    expect(v.unknownProperties).toEqual([]);
    expect(v.outsideVocabulary).toBeGreaterThan(0);
    const schema = analyzePage(
      `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","colour":"red"}]}</script>`,
      "https://ex.com/",
    ).structuredData;
    expect(validate(schema[0]!.raw).unknownProperties).toEqual([
      { path: "$", type: "Product", property: "colour" },
    ]);
  });

  it("counts a non-schema.org type or property in a schema.org block", () => {
    const v = validate({
      "@context": CTX,
      "@type": ["Product", "http://example.org/Gadget"],
      name: "x",
      "http://example.org/weight": 3,
    });
    expect(v.outsideVocabulary).toBe(2);
    expect(v.unknownTypes).toEqual([]);
    expect(v.unknownProperties).toEqual([]);
  });
});

describe("validateBlock — empty values (JSON-LD, Microdata, RDFa)", () => {
  it('"", whitespace-only text, [] and {} are empty, each at its own path', () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      name: "",
      description: "   ",
      image: [],
      brand: {},
      sku: "S-1",
    });
    expect(v.emptyValues).toEqual([
      { path: "$.name", type: "Product", property: "name" },
      { path: "$.description", type: "Product", property: "description" },
      { path: "$.image", type: "Product", property: "image" },
      { path: "$.brand", type: "Product", property: "brand" },
    ]);
  });

  it("0, false, a bare reference, a typed node and a node with a property are not empty", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      name: "Widget",
      weight: 0,
      isFamilyFriendly: false,
      manufacturer: { "@id": "https://example.com/#org" },
      brand: { "@type": "Brand" },
      offers: { price: "1" },
    });
    expect(v.emptyValues).toEqual([]);
  });

  it("an empty value inside a nested node is reported at the nested path, not at the parent", () => {
    const v = validate(product({ offers: { "@type": "Offer", price: "", priceCurrency: "EUR" } }));
    expect(v.emptyValues).toEqual([{ path: "$.offers.price", type: "Offer", property: "price" }]);
  });

  it("an empty member of an array is reported by its index; an untyped holder has a null type", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Organization",
      name: "Acme",
      sameAs: ["", "https://example.com/acme"],
      address: { streetAddress: " " },
    });
    expect(v.emptyValues).toEqual([
      { path: "$.sameAs[0]", type: "Organization", property: "sameAs" },
      { path: "$.address.streetAddress", type: null, property: "streetAddress" },
    ]);
  });

  it("an empty value object and an empty @list are empty", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Article",
      headline: { "@value": "  " },
      keywords: { "@list": [] },
    });
    expect(v.emptyValues).toEqual([
      { path: "$.headline", type: "Article", property: "headline" },
      { path: "$.keywords", type: "Article", property: "keywords" },
    ]);
  });

  it("names the property by its schema.org name in any spelling", () => {
    const v = validate({ "@context": CTX, "@type": "Product", "schema:name": "" });
    expect(v.emptyValues).toEqual([{ path: '$["schema:name"]', type: "Product", property: "name" }]);
  });

  it("is recorded in a block outside the vocabulary too, under the stated names", () => {
    const v = validate({ "@context": { "@vocab": "https://example.org/" }, "@type": "Widget", label: "" });
    expect(v.emptyValues).toEqual([{ path: "$.label", type: "Widget", property: "label" }]);
  });
});

describe("validateBlock — ids and references (JSON-LD node references)", () => {
  it("a bare {@id} is a reference; a node with @id and anything else defines its id", () => {
    const v = validate({
      "@context": CTX,
      "@type": "WebPage",
      "@id": "https://example.com/#webpage",
      name: "Home",
      publisher: { "@id": "https://example.com/#org" },
      author: { "@id": "https://example.com/#jane", "@type": "Person" },
      about: [{ "@id": "#topic" }, { "@id": "https://example.com/#webpage" }],
    });
    expect(v.references).toEqual([
      { path: "$.publisher", id: "https://example.com/#org" },
      { path: "$.about[0]", id: "#topic" },
      { path: "$.about[1]", id: "https://example.com/#webpage" },
    ]);
    expect(v.definedIds).toEqual(["https://example.com/#webpage", "https://example.com/#jane"]);
  });

  it("an empty or whitespace @id is no reference and defines nothing; a defined id is listed once", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Organization",
      "@id": "#org",
      name: "Acme",
      parentOrganization: { "@id": "" },
      department: [{ "@id": "#org", name: "Again" }, { "@id": "  ", name: "Blank" }],
    });
    expect(v.references).toEqual([]);
    expect(v.definedIds).toEqual(["#org"]);
  });

  it("references and ids are read in a block outside the vocabulary too", () => {
    const v = validate({
      "@context": { "@vocab": "https://example.org/" },
      "@type": "Widget",
      "@id": "#w",
      maker: { "@id": "#m" },
    });
    expect(v.definedIds).toEqual(["#w"]);
    expect(v.references).toEqual([{ path: "$.maker", id: "#m" }]);
  });
});

describe("validateBlock — the top-level node and its properties", () => {
  it("lists only the top-level node, its property names without keywords, deduplicated by schema.org name", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      "@id": "#p",
      name: "Widget",
      "schema:name": "Widget again",
      offers: { "@type": "Offer", price: "1" },
    });
    expect(v.nodes).toEqual([
      { path: "$", type: "Product", properties: ["name", "offers"], emptyProperties: [], propertiesCapped: false },
    ]);
  });

  it("emptyProperties names the properties that carry no non-empty value", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      name: "",
      image: ["", " "],
      sameAs: ["", "https://example.com/w"],
      offers: { "@type": "Offer", price: "" },
      weight: 0,
    });
    expect(v.nodes[0]).toEqual({
      path: "$",
      type: "Product",
      properties: ["name", "image", "sameAs", "offers", "weight"],
      emptyProperties: ["name", "image"],
      propertiesCapped: false,
    });
  });

  it("states the type as written when it is outside the vocabulary, and the primary type when known", () => {
    expect(validate({ "@context": CTX, "@type": "Prodcut", name: "x" }).nodes[0]!.type).toBe("Prodcut");
    expect(
      validate({ "@context": CTX, "@type": "http://data-vocabulary.org/Breadcrumb", title: "x" }).nodes[0]!.type,
    ).toBe("http://data-vocabulary.org/Breadcrumb");
    expect(
      validate({ "@context": { "@vocab": "https://example.org/" }, "@type": "Widget" }).nodes[0]!.type,
    ).toBe("Widget");
    expect(validate({ "@context": CTX, "@type": ["Thing", "Product"], name: "x" }).nodes[0]!.type).toBe("Product");
    expect(validate({ "@context": CTX, name: "untyped" }).nodes[0]!.type).toBeNull();
  });

  it("each @graph member is a top-level node of its own block", () => {
    const blocks = analyzePage(
      `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[` +
        `{"@type":"Organization","@id":"#org","name":"Acme"},` +
        `{"@type":"WebPage","name":"Home","publisher":{"@id":"#org"}}]}</script>`,
      "https://ex.com/",
    ).structuredData;
    expect(blocks).toHaveLength(2);
    const [org, page] = blocks.map((b) => validate(b.raw));
    expect(org!.nodes).toEqual([
      { path: "$", type: "Organization", properties: ["name"], emptyProperties: [], propertiesCapped: false },
    ]);
    expect(org!.definedIds).toEqual(["#org"]);
    expect(page!.nodes).toEqual([
      { path: "$", type: "WebPage", properties: ["name", "publisher"], emptyProperties: [], propertiesCapped: false },
    ]);
    expect(page!.references).toEqual([{ path: "$.publisher", id: "#org" }]);
  });
});

describe("validateBlock — caps and refusals", () => {
  it("lists cap at 50 with listsCapped", () => {
    const raw: Record<string, unknown> = { "@type": "Product" };
    for (let i = 0; i < 60; i += 1) raw[`made${i}`] = "x";
    const v = validate(raw);
    expect(MAX_PROBLEMS_PER_LIST).toBe(50);
    expect(v.unknownProperties).toHaveLength(50);
    expect(v.listsCapped).toBe(true);
  });

  it("a node's property list caps at 50, says so on the node, and sets listsCapped", () => {
    const raw: Record<string, unknown> = { "@context": CTX, "@type": "Product" };
    for (let i = 0; i < 60; i += 1) raw[`made${i}`] = i < 55 ? "x" : "";
    const v = validate(raw);
    expect(v.nodes[0]!.properties).toHaveLength(MAX_PROBLEMS_PER_LIST);
    expect(v.nodes[0]!.properties[0]).toBe("made0");
    expect(v.nodes[0]!.propertiesCapped).toBe(true);
    // Only listed properties can be named empty: made55..59 are past the cap.
    expect(v.nodes[0]!.emptyProperties).toEqual([]);
    expect(v.listsCapped).toBe(true);
  });

  it("references cap at 50; defined ids are never capped, so no reference reads as unresolved for want of room", () => {
    const raw: Record<string, unknown> = {
      "@context": CTX,
      "@type": "ItemList",
      itemListElement: Array.from({ length: 60 }, (_, i) => ({ "@id": `#item${i}` })),
      hasPart: Array.from({ length: 60 }, (_, i) => ({ "@id": `#part${i}`, "@type": "WebPage" })),
    };
    const v = validate(raw);
    expect(v.references).toHaveLength(MAX_PROBLEMS_PER_LIST);
    expect(v.definedIds).toHaveLength(60);
    expect(v.listsCapped).toBe(true);
  });

  it("refuses a block that is not a JSON object", () => {
    expect(() => validateBlock([{ "@type": "Product" }])).toThrow(/object/);
    expect(() => validateBlock("Product")).toThrow(/object/);
  });

  it("refuses a block nested deeper than the analyzer stores", () => {
    let node: Record<string, unknown> = { "@type": "Thing" };
    for (let i = 0; i < 70; i += 1) node = { "@type": "Thing", subjectOf: node };
    expect(() => validateBlock(node)).toThrow(/nest/);
  });

  it("blockValidationSchema is strict, and refuses a blob in the shape before the rework", () => {
    const v = validateBlock(product());
    expect(() => blockValidationSchema.parse({ ...v, extra: 1 })).toThrow();
    const { emptyValues: _e, definedIds: _d, references: _r, nodes: _n, ...rest } = v;
    expect(() =>
      blockValidationSchema.parse({ ...rest, googleFeatures: [], deprecatedFeatures: [] }),
    ).toThrow();
  });

  // Runs last (vitest runs a file's tests in order): every case above round-trips.
  it("blockValidationSchema.parse(validateBlock(x)) round-trips for every case above", () => {
    expect(produced.length).toBeGreaterThan(20);
    for (const v of produced) expect(blockValidationSchema.parse(v)).toEqual(v);
  });
});

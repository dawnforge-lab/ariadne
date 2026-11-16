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
/** The page every block here sits on: relative ids resolve against it. */
const DOC = "https://example.com/page";
function validate(raw: unknown, documentUrl: string = DOC): BlockValidation {
  const v = validateBlock(raw, documentUrl);
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
        type: "Product", types: ["Product"], typesCapped: false,
        properties: ["brand", "description", "gtin13", "image", "mpn", "name", "offers", "sku"],
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
      { path: "$", type: "WebPage", types: ["WebPage"], typesCapped: false, properties: ["name"], emptyProperties: [], propertiesCapped: false },
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
    for (const raw of spellings) expect(withoutTypes(validate(raw))).toEqual(withoutTypes(base));
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

  it("0, false, a bare reference and a node with a property are not empty; a typed node with none is", () => {
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
    expect(v.emptyValues).toEqual([{ path: "$.brand", type: "Product", property: "brand" }]);
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
      { path: "$.publisher", id: "https://example.com/#org", written: "https://example.com/#org" },
      { path: "$.about[0]", id: "https://example.com/page#topic", written: "#topic" },
      { path: "$.about[1]", id: "https://example.com/#webpage", written: "https://example.com/#webpage" },
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
    expect(v.definedIds).toEqual(["https://example.com/page#org"]);
  });

  it("references and ids are read in a block outside the vocabulary too", () => {
    const v = validate({
      "@context": { "@vocab": "https://example.org/" },
      "@type": "Widget",
      "@id": "#w",
      maker: { "@id": "#m" },
    });
    expect(v.definedIds).toEqual(["https://example.com/page#w"]);
    expect(v.references).toEqual([{ path: "$.maker", id: "https://example.com/page#m", written: "#m" }]);
  });
});

describe("validateBlock — the top-level node and its properties", () => {
  it("lists only the top-level node, its property names without keywords, deduplicated by schema.org name and sorted", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      "@id": "#p",
      name: "Widget",
      "schema:name": "Widget again",
      offers: { "@type": "Offer", price: "1" },
    });
    expect(v.nodes).toEqual([
      { path: "$", type: "Product", types: ["Product"], typesCapped: false, properties: ["name", "offers"], emptyProperties: [], propertiesCapped: false },
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
      type: "Product", types: ["Product"], typesCapped: false,
      properties: ["image", "name", "offers", "sameAs", "weight"],
      emptyProperties: ["image", "name"],
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
    const [org, page] = blocks.map((b) => validate(b.raw, "https://ex.com/"));
    expect(org!.nodes).toEqual([
      { path: "$", type: "Organization", types: ["Organization"], typesCapped: false, properties: ["name"], emptyProperties: [], propertiesCapped: false },
    ]);
    expect(org!.definedIds).toEqual(["https://ex.com/#org"]);
    expect(page!.nodes).toEqual([
      { path: "$", type: "WebPage", types: ["WebPage"], typesCapped: false, properties: ["name", "publisher"], emptyProperties: [], propertiesCapped: false },
    ]);
    expect(page!.references).toEqual([{ path: "$.publisher", id: "https://ex.com/#org", written: "#org" }]);
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
    expect(() => validateBlock([{ "@type": "Product" }], DOC)).toThrow(/object/);
    expect(() => validateBlock("Product", DOC)).toThrow(/object/);
  });

  it("refuses a block nested deeper than the analyzer stores", () => {
    let node: Record<string, unknown> = { "@type": "Thing" };
    for (let i = 0; i < 70; i += 1) node = { "@type": "Thing", subjectOf: node };
    expect(() => validateBlock(node, DOC)).toThrow(/nest/);
  });

  it("blockValidationSchema is strict, and refuses a blob in the shape before the rework", () => {
    const v = validateBlock(product(), DOC);
    expect(() => blockValidationSchema.parse({ ...v, extra: 1 })).toThrow();
    const { emptyValues: _e, definedIds: _d, references: _r, nodes: _n, ...rest } = v;
    expect(() =>
      blockValidationSchema.parse({ ...rest, googleFeatures: [], deprecatedFeatures: [] }),
    ).toThrow();
  });

});

// 29a rework, review fix round 1. Appended so no earlier line moves.

describe("validateBlock — ids resolved against the document base (JSON-LD 1.1 IRIs)", () => {
  it("a relative reference and an absolute definition of the same node resolve to one IRI", () => {
    const v = validate({
      "@context": CTX,
      "@type": "WebPage",
      "@id": "https://example.com/page#webpage",
      name: "Home",
      publisher: { "@id": "#org" },
      about: { "@id": "/topics/mugs" },
    });
    expect(v.definedIds).toEqual(["https://example.com/page#webpage"]);
    expect(v.references).toEqual([
      { path: "$.publisher", id: "https://example.com/page#org", written: "#org" },
      { path: "$.about", id: "https://example.com/topics/mugs", written: "/topics/mugs" },
    ]);
    // The relative definition of the page itself resolves to the same IRI as the absolute one.
    expect(validate({ "@context": CTX, "@type": "WebPage", "@id": "#webpage", name: "x" }).definedIds).toEqual([
      "https://example.com/page#webpage",
    ]);
  });

  it("a @base in the block's @context is the base, itself resolved against the page", () => {
    const absolute = validate({
      "@context": [CTX, { "@base": "https://other.example/dir/" }],
      "@type": "Organization",
      "@id": "org",
      name: "Acme",
      parentOrganization: { "@id": "parent" },
    });
    expect(absolute.definedIds).toEqual(["https://other.example/dir/org"]);
    expect(absolute.references).toEqual([
      { path: "$.parentOrganization", id: "https://other.example/dir/parent", written: "parent" },
    ]);
    const relative = validate({ "@context": { "@vocab": "https://schema.org/", "@base": "/shop/" }, "@id": "x", name: "y" });
    expect(relative.definedIds).toEqual(["https://example.com/shop/x"]);
    // A null @base removes the base: a relative id has nothing to resolve against and stays as written.
    const none = validate({ "@context": [CTX, { "@base": null }], "@id": "#x", name: "y", knows: { "@id": "#y" } });
    expect(none.definedIds).toEqual(["#x"]);
    expect(none.references).toEqual([{ path: "$.knows", id: "#y", written: "#y" }]);
  });

  it("blank-node ids are left as they are", () => {
    const v = validate({ "@context": CTX, "@type": "Person", "@id": "_:b0", name: "Ada", knows: { "@id": "_:b1" } });
    expect(v.definedIds).toEqual(["_:b0"]);
    expect(v.references).toEqual([{ path: "$.knows", id: "_:b1", written: "_:b1" }]);
  });

  it("an id that is not an IRI reference stays as written, as the microdata extractor stores an itemid", () => {
    const v = validate({ "@context": CTX, "@type": "Thing", name: "x", sameAs: { "@id": "http://[bad" } });
    expect(v.references).toEqual([{ path: "$.sameAs", id: "http://[bad", written: "http://[bad" }]);
  });

  it("a JSON-LD #org reference matches a microdata itemid that resolves to the same IRI", () => {
    const blocks = analyzePage(
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Home","publisher":{"@id":"#org"}}</script>` +
        `<div itemscope itemtype="https://schema.org/Organization" itemid="#org"><span itemprop="name">Acme</span></div>`,
      "https://ex.com/about",
    ).structuredData;
    const page = blocks.find((b) => b.format === "jsonld")!;
    const org = blocks.find((b) => b.format === "microdata")!;
    // The extractor resolves itemid against the page; the validator resolves @id the same way.
    expect((org.raw as Record<string, unknown>)["@id"]).toBe("https://ex.com/about#org");
    expect(validate(org.raw, "https://ex.com/about").definedIds).toEqual(["https://ex.com/about#org"]);
    expect(validate(page.raw, "https://ex.com/about").references).toEqual([
      { path: "$.publisher", id: "https://ex.com/about#org", written: "#org" },
    ]);
  });

  it("refuses a document URL that is not absolute, naming it", () => {
    expect(() => validateBlock({ "@type": "Thing" }, "/relative")).toThrow(/\/relative/);
  });
});

describe("validateBlock — a node with no properties and no @id is empty (spec §29a amendment)", () => {
  it("a node holding only keywords is empty at its own path, and its type is still judged", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      name: "Mug",
      offers: { "@type": "Offer" },
      aggregateRating: { "@type": "AggregateRating", "@context": CTX },
      review: { "@type": "Reveiw" },
      subjectOf: { "@language": "en" },
    });
    expect(v.emptyValues).toEqual([
      { path: "$.offers", type: "Product", property: "offers" },
      { path: "$.aggregateRating", type: "Product", property: "aggregateRating" },
      { path: "$.review", type: "Product", property: "review" },
      { path: "$.subjectOf", type: "Product", property: "subjectOf" },
    ]);
    // The empty node is still a node: its unknown type is reported too.
    expect(v.unknownTypes).toEqual([{ path: "$.review", type: "Reveiw" }]);
    expect(v.nodes[0]!.emptyProperties).toEqual(["aggregateRating", "offers", "review", "subjectOf"]);
  });

  it("an @id, a property, a value object or a list container is not an empty node", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      name: "Mug",
      brand: { "@type": "Brand", "@id": "#brand" },
      offers: { "@type": "Offer", price: "1" },
      description: { "@value": "Blue", "@language": "en" },
      keywords: { "@list": ["a"] },
    });
    expect(v.emptyValues).toEqual([]);
  });
});

describe("validateBlock — what defines an id (review M1)", () => {
  it("@context beside an @id is not content: such a node defines nothing", () => {
    // An @graph member {"@id": "#x"} as the analyzer stores it, with its container's context.
    expect(validate({ "@context": CTX, "@id": "#x" }).definedIds).toEqual([]);
    expect(validate({ "@context": CTX, "@id": "#x", "@type": "Thing" }).definedIds).toEqual([
      "https://example.com/page#x",
    ]);
  });
});

// 29a rework, re-review fix round 2.
describe("validateBlock — a blank @id is no @id, and a null context resets the base", () => {
  it("a typed node whose @id is blank is empty, as it defines and references nothing", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Product",
      name: "Mug",
      offers: { "@type": "Offer", "@id": "" },
      brand: { "@type": "Brand", "@id": "   " },
    });
    expect(v.emptyValues).toEqual([
      { path: "$.offers", type: "Product", property: "offers" },
      { path: "$.brand", type: "Product", property: "brand" },
    ]);
    expect(v.definedIds).toEqual([]);
    expect(v.references).toEqual([]);
  });

  it("a null entry in a context array resets the base to the document URL (JSON-LD 1.1)", () => {
    const v = validate({
      "@context": [{ "@base": "https://other.example/" }, null, CTX],
      "@type": "Thing",
      "@id": "#x",
      name: "x",
    });
    expect(v.definedIds).toEqual(["https://example.com/page#x"]);
    // Without the reset the declared base stands.
    expect(
      validate({ "@context": [{ "@base": "https://other.example/" }, CTX], "@type": "Thing", "@id": "#x", name: "x" })
        .definedIds,
    ).toEqual(["https://other.example/#x"]);
  });
});

// 29a rework gate fix: a node lists every stated type.
describe("validateBlock — a node lists every type it states", () => {
  it("two unrelated JSON-LD types: the primary is the first, and both are listed in authored order", () => {
    const v = validate({ "@context": CTX, "@type": ["SoftwareApplication", "FAQPage"], name: "App" });
    expect(v.nodes[0]).toMatchObject({ type: "SoftwareApplication", types: ["SoftwareApplication", "FAQPage"] });
  });

  it("reduces a schema.org spelling to the bare name, keeps any other as written, and lists each once", () => {
    const v = validate({
      "@context": CTX,
      "@type": ["https://schema.org/Product", "http://example.org/Gadget", "schema:Product"],
      name: "x",
    });
    expect(v.nodes[0]!.types).toEqual(["Product", "http://example.org/Gadget"]);
  });

  it("an untyped node lists no types; a single type lists one", () => {
    expect(validate({ "@context": CTX, name: "x" }).nodes[0]!.types).toEqual([]);
    expect(validate({ "@context": CTX, "@type": "Prodcut", name: "x" }).nodes[0]!.types).toEqual(["Prodcut"]);
  });

  it("the strict schema refuses a node written before types existed", () => {
    const v = validate({ "@context": CTX, "@type": "Thing", name: "x" });
    const { types: _t, ...node } = v.nodes[0]!;
    expect(() => blockValidationSchema.parse({ ...v, nodes: [node] })).toThrow();
  });
});

describe("validateBlock — every verdict round-trips", () => {
  // Runs last (vitest runs a file's describes in order): every case above round-trips.
  it("blockValidationSchema.parse(validateBlock(x)) round-trips for every case above", () => {
    expect(produced.length).toBeGreaterThan(20);
    for (const v of produced) expect(blockValidationSchema.parse(v)).toEqual(v);
  });
});

/** A verdict without its nodes' `types`: for comparing spellings whose type lists differ by design. */
function withoutTypes(v: BlockValidation): unknown {
  return { ...v, nodes: v.nodes.map(({ types: _t, ...node }) => node) };
}

// 29a rework gate fix, ruling (b): extraction stays at 4, so the microdata and
// RDFa extractors still store one type (their first itemtype / typeof token).
// These raws are hand-built in their shape with a `@type` ARRAY, to pin that
// the validator lists every type any stored block states, whatever its format.
describe("validateBlock — every type of a microdata- or RDFa-shaped node with a @type array", () => {
  it("a microdata-shaped item with two itemtype tokens lists both", () => {
    const v = validate({
      "@context": "https://schema.org",
      "@type": ["Product", "IndividualProduct"],
      "@id": "https://example.com/page#mug",
      name: "Mug",
    });
    expect(v.nodes[0]).toMatchObject({ type: "IndividualProduct", types: ["Product", "IndividualProduct"] });
  });

  it("an RDFa-shaped item with two typeof terms lists both, full-URL spellings reduced", () => {
    const v = validate({
      "@context": "https://schema.org",
      "@type": ["http://schema.org/LocalBusiness", "https://schema.org/Bakery"],
      name: "Crumb",
    });
    expect(v.nodes[0]).toMatchObject({ type: "Bakery", types: ["LocalBusiness", "Bakery"] });
  });
});

// 29a rework gate fix, security review: a node's type list is capped like its property list.
describe("validateBlock — a node's type list caps at MAX_PROBLEMS_PER_LIST", () => {
  const typed = (n: number): Record<string, unknown> => ({
    // Outside the vocabulary, so no unknown-type list fills up beside it.
    "@context": { "@vocab": "https://example.org/" },
    "@type": Array.from({ length: n }, (_, i) => `T${String(i).padStart(3, "0")}`),
    name: "x",
  });

  it("MAX types are listed whole, with no flag", () => {
    const v = validate(typed(MAX_PROBLEMS_PER_LIST));
    expect(v.nodes[0]!.types).toHaveLength(MAX_PROBLEMS_PER_LIST);
    expect(v.nodes[0]!.typesCapped).toBe(false);
    expect(v.listsCapped).toBe(false);
  });

  it("MAX + 1 types are cut to MAX, flagged on the node and on the block", () => {
    const v = validate(typed(MAX_PROBLEMS_PER_LIST + 1));
    expect(v.nodes[0]!.types).toHaveLength(MAX_PROBLEMS_PER_LIST);
    expect(v.nodes[0]!.types.at(-1)).toBe(`T${String(MAX_PROBLEMS_PER_LIST - 1).padStart(3, "0")}`);
    expect(v.nodes[0]!.typesCapped).toBe(true);
    expect(v.listsCapped).toBe(true);
  });
});

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

function feature(v: BlockValidation, id: string) {
  return v.googleFeatures.find((f) => f.feature === id);
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
  expect(v.deprecatedFeatures).toEqual([]);
  expect(v.outsideVocabulary).toBe(0);
  expect(v.listsCapped).toBe(false);
}

describe("validateBlock", () => {
  it("a valid product with offer has no problems and matches product-snippet and merchant-listing with empty missingRequired", () => {
    const v = validate(product());
    expectNoProblems(v);
    expect(v.topType).toBe("Product");
    expect(feature(v, "product-snippet")).toMatchObject({ path: "$", type: "Product", missingRequired: [] });
    expect(feature(v, "merchant-listing")).toMatchObject({ path: "$", type: "Product", missingRequired: [] });
    // The nested Offer and Brand match no feature.
    expect(v.googleFeatures.map((f) => f.feature).sort()).toEqual(["merchant-listing", "product-snippet"]);
  });

  it("merchant listing missing image", () => {
    const raw = product();
    delete raw["image"];
    const v = validate(raw);
    expect(feature(v, "merchant-listing")!.missingRequired).toContain("image");
    expect(feature(v, "product-snippet")!.missingRequired).toEqual([]);
  });

  it("names a missing price by its alternatives", () => {
    const v = validate(product({ offers: { "@type": "Offer", url: "https://example.com/w" } }));
    expect(feature(v, "merchant-listing")!.missingRequired).toEqual([
      "offers.price | offers.priceSpecification.price",
      "offers.priceCurrency | offers.priceSpecification.priceCurrency",
    ]);
    const viaSpec = validate(
      product({
        offers: {
          "@type": "Offer",
          priceSpecification: { "@type": "UnitPriceSpecification", price: 5, priceCurrency: "EUR" },
        },
      }),
    );
    expect(feature(viaSpec, "merchant-listing")!.missingRequired).toEqual([]);
  });

  it("aggregate offer is not a merchant listing", () => {
    const v = validate(
      product({
        offers: { "@type": "AggregateOffer", lowPrice: "5", highPrice: "9", priceCurrency: "GBP", offerCount: 3 },
      }),
    );
    expect(feature(v, "merchant-listing")).toBeUndefined();
    expect(feature(v, "product-snippet")!.missingRequired).toEqual([]);
  });

  it("Restaurant matches local-business and not organization", () => {
    const v = validate({
      "@context": CTX,
      "@type": "Restaurant",
      name: "Luigi's",
      address: { "@type": "PostalAddress", streetAddress: "1 High St" },
    });
    const ids = v.googleFeatures.map((f) => f.feature);
    expect(ids).toContain("local-business");
    expect(ids).not.toContain("organization");
    expect(feature(v, "local-business")).toMatchObject({ type: "Restaurant", missingRequired: [] });
    // A food establishment is asked for its cuisine; a plumber is not.
    expect(feature(v, "local-business")!.missingRecommended).toContain("servesCuisine");
    const plumber = validate({ "@context": CTX, "@type": "Plumber", name: "P", address: "1 High St" });
    expect(feature(plumber, "local-business")!.missingRecommended).not.toContain("servesCuisine");
    // A plain Organization still matches organization.
    const org = validate({ "@context": CTX, "@type": "Organization", name: "Acme" });
    expect(org.googleFeatures.map((f) => f.feature)).toEqual(["organization"]);
  });

  it("nested review waives itemReviewed; top-level review requires it", () => {
    const review = {
      "@type": "Review",
      author: { "@type": "Person", name: "Jane" },
      reviewRating: { "@type": "Rating", ratingValue: 4 },
    };
    const nested = validate(product({ review }));
    expect(nested.googleFeatures.filter((f) => f.feature === "review")).toEqual([
      expect.objectContaining({ path: "$.review", type: "Review", missingRequired: [] }),
    ]);
    const top = validate({ "@context": CTX, ...review });
    expect(feature(top, "review")!.path).toBe("$");
    expect(feature(top, "review")!.missingRequired).toEqual(["itemReviewed", "itemReviewed.name"]);
  });

  it("a review with an author and a date may omit its rating", () => {
    const dated = validate(
      product({ review: { "@type": "Review", author: { "@type": "Person", name: "J" }, datePublished: "2026-01-01" } }),
    );
    expect(feature(dated, "review")!.missingRequired).toEqual([]);
    const undated = validate(product({ review: { "@type": "Review", author: "Jane" } }));
    expect(feature(undated, "review")!.missingRequired).toEqual(["reviewRating", "reviewRating.ratingValue"]);
  });

  it("I1: a text value names its node, so author.name and itemReviewed.name are met by strings", () => {
    const v = validate({
      "@type": "Product",
      name: "P",
      review: { "@type": "Review", author: "Jane", reviewRating: { "@type": "Rating", ratingValue: 5 } },
    });
    expect(feature(v, "review")!.missingRequired).toEqual([]);
    const top = validate({
      "@type": "Review",
      author: { "@type": "Person", name: "J" },
      itemReviewed: "Some thing",
      reviewRating: { "@type": "Rating", ratingValue: 5 },
    });
    expect(feature(top, "review")!.missingRequired).toEqual([]);
    // A recommended `.name` step reads the same way; an empty string names nothing.
    const event = validate({
      "@type": "Event",
      name: "E",
      startDate: "2026-01-01",
      location: { "@type": "Place", address: "1 High St", name: "Hall" },
      organizer: "Acme",
      performer: "  ",
    });
    expect(feature(event, "event")!.missingRecommended).not.toContain("organizer.name");
    expect(feature(event, "event")!.missingRecommended).toContain("performer.name");
    // Only a final `name` step: a string author has no url.
    expect(feature(validate({ "@type": "Article", author: "Jane" }), "article")!.missingRecommended).toContain(
      "author.url",
    );
  });

  it("I2: a bare @id reference satisfies any deeper step and does not trigger whenPresent", () => {
    const refs = validate({
      "@type": "Review",
      author: { "@id": "#p" },
      itemReviewed: { "@id": "#prod" },
      reviewRating: { "@type": "Rating", ratingValue: 5 },
    });
    expect(feature(refs, "review")!.missingRequired).toEqual([]);
    const offersRef = validate({ "@type": "Product", name: "P", offers: { "@id": "#offer" } });
    expect(feature(offersRef, "product-snippet")!.missingRequired).toEqual([]);
    const venueRef = validate({ "@type": "Event", name: "E", startDate: "2026-01-01", location: { "@id": "#venue" } });
    expect(feature(venueRef, "event")!.missingRequired).toEqual([]);
    // One member is enough, so a reference beside an unpriced offer satisfies the price;
    // an unpriced described offer on its own still fires.
    const unpriced = validate({ "@type": "Product", name: "P", offers: [{ "@id": "#o" }, { "@type": "Offer" }] });
    expect(feature(unpriced, "product-snippet")!.missingRequired).toEqual([]);
    const onlyUnpriced = validate({ "@type": "Product", name: "P", offers: { "@type": "Offer", url: "u" } });
    expect(feature(onlyUnpriced, "product-snippet")!.missingRequired).toEqual([
      "offers.price | offers.priceSpecification.price | offers.lowPrice",
    ]);
  });

  it("I3: a top-level Review or AggregateRating carrying @id waives itemReviewed", () => {
    const rating = validate({ "@type": "AggregateRating", "@id": "#r", ratingValue: 4.5, ratingCount: 10 });
    expect(feature(rating, "aggregate-rating")!.missingRequired).toEqual([]);
    const noId = validate({ "@type": "AggregateRating", ratingValue: 4.5, ratingCount: 10 });
    expect(feature(noId, "aggregate-rating")!.missingRequired).toEqual(["itemReviewed", "itemReviewed.name"]);
  });

  it("I4: a nested rating matches only under a reviewable parent", () => {
    const inArticle = validate({
      "@type": "Article",
      headline: "h",
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4 },
    });
    expect(feature(inArticle, "aggregate-rating")).toBeUndefined();
    const inRecipe = validate({
      "@type": "Recipe",
      name: "R",
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4 },
    });
    expect(feature(inRecipe, "aggregate-rating")!.missingRequired).toEqual(["ratingCount | reviewCount"]);
    // Under an untyped wrapper the parent is untyped: no match.
    const wrapped = validate({
      "@type": "Product",
      name: "P",
      subjectOf: { review: { "@type": "Review", author: "J" } },
    });
    expect(feature(wrapped, "review")).toBeUndefined();
  });

  it("I6: breadcrumb waives item on the document-order last crumb and on the highest position", () => {
    const v = validate({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://example.com/" },
        { "@type": "ListItem", position: "3", name: "Here" },
        { "@type": "ListItem", position: 2, name: "Section", item: "https://example.com/s" },
      ],
    });
    expect(feature(v, "breadcrumb")!.missingRequired).toEqual([]);
    const middle = validate({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home" },
        { "@type": "ListItem", position: 3, name: "Here" },
        { "@type": "ListItem", position: 2, name: "Section", item: "https://example.com/s" },
      ],
    });
    expect(feature(middle, "breadcrumb")!.missingRequired).toEqual(["itemListElement.item"]);
  });

  it("N1: a URL item does not stand in for a crumb's name; a named or referenced item node does", () => {
    const crumbs = (first: Record<string, unknown>) =>
      validate({
        "@type": "BreadcrumbList",
        itemListElement: [first, { "@type": "ListItem", position: 2, name: "Here" }],
      });
    const urlItem = crumbs({ "@type": "ListItem", position: 1, item: "https://example.com/" });
    expect(feature(urlItem, "breadcrumb")!.missingRequired).toEqual(["itemListElement.name"]);
    const refItem = crumbs({ "@type": "ListItem", position: 1, item: { "@id": "https://example.com/" } });
    expect(feature(refItem, "breadcrumb")!.missingRequired).toEqual([]);
    const namedItem = crumbs({ "@type": "ListItem", position: 1, item: { "@id": "https://example.com/", name: "Home" } });
    expect(feature(namedItem, "breadcrumb")!.missingRequired).toEqual([]);
    const emptyRef = crumbs({ "@type": "ListItem", position: 1, item: { "@id": "" } });
    expect(feature(emptyRef, "breadcrumb")!.missingRequired).toEqual(["itemListElement.name"]);
    const bare = crumbs({ "@type": "ListItem", position: 1 });
    expect(feature(bare, "breadcrumb")!.missingRequired).toEqual(["itemListElement.name", "itemListElement.item"]);
  });

  it("N2: an empty @id is no reference", () => {
    const v = validate({ "@type": "Product", name: "P", offers: { "@id": "" } });
    expect(feature(v, "product-snippet")!.missingRequired).toEqual([
      "offers.price | offers.priceSpecification.price | offers.lowPrice",
    ]);
  });

  it("I7: an @list-wrapped crumb list reads like an array", () => {
    const v = validate({
      "@type": "BreadcrumbList",
      itemListElement: { "@list": [{ "@type": "ListItem", position: 1, name: "a", item: "u" }] },
    });
    expect(feature(v, "breadcrumb")!.missingRequired).toEqual([]);
    const bad = validate({
      "@type": "BreadcrumbList",
      itemListElement: { "@list": [{ "@type": "ListItem", name: "a" }, { "@type": "ListItem", position: 2 }] },
    });
    expect(feature(bad, "breadcrumb")!.missingRequired).toContain("itemListElement.position");
  });

  it("I8: a node typed only outside schema.org is walked as untyped", () => {
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
    expect(v.googleFeatures).toEqual([]);
    // The foreign type counts; bare keys are schema.org names, so they do not.
    expect(v.outsideVocabulary).toBe(1);
    // Descendants are still walked.
    expect(v.unknownTypes).toEqual([{ path: "$.child", type: "Prodcut" }]);
  });

  it("I9: product-snippet asks for an offer price only when offers alone qualify it", () => {
    const rated = validate({
      "@type": "Product",
      name: "P",
      offers: { "@type": "Offer" },
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4, ratingCount: 3 },
    });
    expect(feature(rated, "product-snippet")!.missingRequired).toEqual([]);
    const software = validate({
      "@type": "SoftwareApplication",
      name: "S",
      offers: { "@type": "Offer", price: 0 },
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4, ratingCount: 3 },
    });
    expect(feature(software, "software-app")!.missingRequired).toEqual([]);
  });

  it("breadcrumb: every crumb needs a position and a name, every crumb but the last an item", () => {
    const ok = validate({
      "@context": CTX,
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://example.com/" },
        // A crumb whose item is a node carrying its own name needs no name.
        { "@type": "ListItem", position: 2, item: { "@id": "https://example.com/a", name: "A" } },
        { "@type": "ListItem", position: 3, name: "Here" },
      ],
    });
    expect(feature(ok, "breadcrumb")!.missingRequired).toEqual([]);
    const bad = validate({
      "@context": CTX,
      "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", name: "Home" }, { "@type": "ListItem", position: 2 }],
    });
    expect(feature(bad, "breadcrumb")!.missingRequired).toEqual([
      "itemListElement.position",
      "itemListElement.name",
      "itemListElement.item",
    ]);
    const empty = validate({ "@context": CTX, "@type": "BreadcrumbList" });
    expect(feature(empty, "breadcrumb")!.missingRequired).toEqual(["itemListElement"]);
  });

  it("a nested aggregate rating waives itemReviewed and needs a count", () => {
    const v = validate(product({ aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5 } }));
    expect(feature(v, "aggregate-rating")).toMatchObject({
      path: "$.aggregateRating",
      missingRequired: ["ratingCount | reviewCount"],
    });
  });

  it("unknown type", () => {
    const v = validate({ "@context": CTX, "@type": "Prodcut", name: "x" });
    expect(v.unknownTypes).toEqual([{ path: "$", type: "Prodcut" }]);
    expect(v.topType).toBeNull();
    // A node with no known type has its properties left unjudged.
    expect(v.unknownProperties).toEqual([]);
    expect(v.googleFeatures).toEqual([]);
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

  it("FAQPage gives deprecatedFeatures faq", () => {
    const v = validate({ "@context": CTX, "@type": "FAQPage", mainEntity: [] });
    expect(v.deprecatedFeatures).toEqual([{ feature: "faq", path: "$", type: "FAQPage" }]);
    const howTo = validate({ "@context": CTX, "@type": "HowTo", name: "x" });
    expect(howTo.deprecatedFeatures).toEqual([{ feature: "how-to", path: "$", type: "HowTo" }]);
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
      "@graph": [{ "@type": "Prodcut" }, { "@type": "Product" }],
    });
    expect(v.topType).toBe("WebPage");
    expect(v.unknownTypes).toEqual([]);
    expect(v.googleFeatures).toEqual([]);
  });

  it("Review Focus 2: every schema.org spelling gives identical googleFeatures", () => {
    const base = validate(product()).googleFeatures;
    expect(base.length).toBeGreaterThan(0);
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
    for (const raw of spellings) expect(validate(raw).googleFeatures).toEqual(base);
  });

  it("Review Focus 2: a block in another vocabulary is counted and never judged", () => {
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
    expect(v.googleFeatures).toEqual([]);
    expect(v.deprecatedFeatures).toEqual([]);

    const stringContext = validate({ "@context": "https://example.org/ctx", "@type": "Product" });
    expect(stringContext.outsideVocabulary).toBe(1);
    expect(stringContext.googleFeatures).toEqual([]);
  });

  it("I5: a @graph member stored by the analyzer keeps its container's vocabulary", () => {
    const outside = analyzePage(
      `<script type="application/ld+json">{"@context":{"@vocab":"https://example.org/"},"@graph":[{"@type":"Product"}]}</script>`,
      "https://ex.com/",
    ).structuredData;
    expect(outside).toHaveLength(1);
    const v = validate(outside[0]!.raw);
    expect(v.googleFeatures).toEqual([]);
    expect(v.outsideVocabulary).toBeGreaterThan(0);
    const schema = analyzePage(
      `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"P","offers":{"@type":"Offer","price":1,"priceCurrency":"EUR"},"image":"i"}]}</script>`,
      "https://ex.com/",
    ).structuredData;
    expect(validate(schema[0]!.raw).googleFeatures.map((f) => f.feature)).toEqual([
      "product-snippet",
      "merchant-listing",
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

  it("lists cap at 50 with listsCapped", () => {
    const raw: Record<string, unknown> = { "@type": "Product" };
    for (let i = 0; i < 60; i += 1) raw[`made${i}`] = "x";
    const v = validate(raw);
    expect(MAX_PROBLEMS_PER_LIST).toBe(50);
    expect(v.unknownProperties).toHaveLength(50);
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

  it("blockValidationSchema is strict", () => {
    const v = validateBlock(product());
    expect(() => blockValidationSchema.parse({ ...v, extra: 1 })).toThrow();
  });

  // Runs last (vitest runs a file's tests in order): every case above round-trips.
  it("blockValidationSchema.parse(validateBlock(x)) round-trips for every case above", () => {
    expect(produced.length).toBeGreaterThan(20);
    for (const v of produced) expect(blockValidationSchema.parse(v)).toEqual(v);
  });
});

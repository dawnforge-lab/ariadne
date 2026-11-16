/**
 * `schema.property-coverage` (29a rework), against a real database.
 *
 * Blocks are inserted as the crawler stores them and `deriveSchemaValidation`
 * writes their verdicts, so the `nodes` the metric aggregates are the
 * validator's own. Every count below is worked out by hand beside the site
 * that produces it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pages, structuredData } from "../../src/db/schema.js";
import { deriveSchemaValidation } from "../../src/rules/derive/schema-validation.js";
import {
  COVERAGE_MAX_PROPERTIES,
  COVERAGE_MAX_TYPES,
  schemaMetrics,
} from "../../src/rules/metric/schema-metrics.js";
import { shapeMetricTable } from "../../src/rules/registry/metric-table.js";
import { MAX_PROBLEMS_PER_LIST } from "../../src/rules/schema-org/validate.js";
import {
  databaseUrl,
  dropCrawls,
  expectRefusesUnknownCrawl,
  metricLookup,
  metricRowsByScope,
  newMetricCrawl,
} from "./metric-db.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

const SITE = "https://schema-metrics.example";
const url = (path: string): string => `${SITE}${path}`;
const ID = "schema.property-coverage";
const C = "https://schema.org";

const rule = metricLookup(schemaMetrics, "schemaMetrics");

describe("schemaMetrics metadata", () => {
  it("defines property-coverage, claiming CHECK-44, info, structured-data", () => {
    expect(
      Object.fromEntries(schemaMetrics.map((r) => [r.id, [r.kind, r.checkIds, r.severity, r.category]])),
    ).toEqual({ [ID]: ["metric", ["CHECK-44"], "info", "structured-data"] });
  });

  it("carries its own copy and a ruleset version", () => {
    const r = rule(ID);
    expect(r.title.length).toBeGreaterThan(5);
    expect(r.explanation.length).toBeGreaterThan(40);
    expect(r.howToFix.length).toBeGreaterThan(30);
    expect(r.rulesetVersion).toBeTruthy();
  });
});

describe("schema.property-coverage against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    extractionVersion?: number;
  }

  const newCrawl = async (): Promise<string> => newMetricCrawl(db, SITE, createdCrawls, { pagesCrawled: 10 });

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: writerIndexable(s),
      robotsMeta: s.robotsMeta ?? null,
      depth: 1,
      discoveredVia: "link",
      extractionVersion: s.extractionVersion ?? 4,
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addBlock(
    crawlId: string,
    pageId: string,
    raw: Record<string, unknown>,
    format: "jsonld" | "microdata" | "rdfa" = "jsonld",
  ): Promise<void> {
    await db.insert(structuredData).values({
      crawlId,
      pageId,
      schemaType: typeof raw["@type"] === "string" ? raw["@type"] : "unknown",
      format,
      raw,
    });
  }

  const run = async (crawlId: string): Promise<Record<string, unknown>> =>
    metricRowsByScope(db, rule(ID), crawlId);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await dropCrawls(db, createdCrawls);
    await closeDb(db);
  });

  /**
   * THE SITE UNDER TEST. Six top-level nodes on judged pages:
   *  - /p1 Product (JSON-LD): name, image (""), offers;
   *  - /p2 Product (microdata): name (""), sku;
   *  - /p3 Prodcut (a type outside the vocabulary): name; and an untyped node;
   *  - /p4 Organization and WebPage: a graph split over two blocks.
   * /n is noindex and its Product is not counted.
   */
  async function site(): Promise<string> {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/p1" },
      { path: "/p2" },
      { path: "/p3" },
      { path: "/p4" },
      { path: "/n", robotsMeta: "noindex" },
    ]);
    await addBlock(crawlId, ids.get("/p1")!, {
      "@context": C,
      "@type": "Product",
      name: "Mug",
      image: "",
      offers: { "@type": "Offer", price: "1" },
    });
    await addBlock(crawlId, ids.get("/p2")!, { "@context": C, "@type": "Product", name: "", sku: "S" }, "microdata");
    await addBlock(crawlId, ids.get("/p3")!, { "@context": C, "@type": "Prodcut", name: "x" });
    await addBlock(crawlId, ids.get("/p3")!, { "@context": C, name: "untyped" });
    await addBlock(crawlId, ids.get("/p4")!, { "@context": C, "@type": "Organization", "@id": "#org", name: "Acme" });
    await addBlock(crawlId, ids.get("/p4")!, {
      "@context": C,
      "@type": "WebPage",
      name: "Home",
      publisher: { "@id": "#org" },
    });
    await addBlock(crawlId, ids.get("/n")!, { "@context": C, "@type": "Product", name: "z", color: "red" });
    await deriveSchemaValidation(db, crawlId);
    return crawlId;
  }

  it("counts top-level nodes per stated type and, per property, the nodes carrying a non-empty value", async () => {
    expect(await run(await site())).toEqual({
      // 6 = p1 + p2 + p3 (two, one untyped) + p4 (two); /n is not judged.
      "site|": { nodes: 6, propertyListsCapped: 0, typesNotListed: 0 },
      // name: p1 only (p2's is ""); image: on p1 but empty, so 0; offers p1; sku p2.
      "schema_type|Product": {
        nodes: 2,
        propertyListsCapped: 0,
        propertiesNotListed: 0,
        properties: { name: 1, image: 0, offers: 1, sku: 1 },
      },
      // A type outside the vocabulary counts under its stated name.
      "schema_type|Prodcut": { nodes: 1, propertyListsCapped: 0, propertiesNotListed: 0, properties: { name: 1 } },
      "schema_type|Organization": {
        nodes: 1,
        propertyListsCapped: 0,
        propertiesNotListed: 0,
        properties: { name: 1 },
      },
      // A bare reference is a value.
      "schema_type|WebPage": {
        nodes: 1,
        propertyListsCapped: 0,
        propertiesNotListed: 0,
        properties: { name: 1, publisher: 1 },
      },
    });
  });

  it("a type whose nodes carry no property is a row with an empty map", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [{ path: "/a" }]);
    await addBlock(crawlId, ids.get("/a")!, { "@context": C, "@type": "Thing" });
    await deriveSchemaValidation(db, crawlId);
    expect(await run(crawlId)).toEqual({
      "site|": { nodes: 1, propertyListsCapped: 0, typesNotListed: 0 },
      "schema_type|Thing": { nodes: 1, propertyListsCapped: 0, propertiesNotListed: 0, properties: {} },
    });
  });

  it("counts the nodes whose property list was capped, so a reader knows the counts are short", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [{ path: "/a" }]);
    const big: Record<string, unknown> = { "@context": C, "@type": "Product" };
    for (let i = 0; i < 60; i += 1) big[`made${i}`] = "x";
    await addBlock(crawlId, ids.get("/a")!, big);
    await deriveSchemaValidation(db, crawlId);
    const rows = await run(crawlId);
    expect(rows["site|"]).toEqual({ nodes: 1, propertyListsCapped: 1, typesNotListed: 0 });
    const product = rows["schema_type|Product"] as { propertyListsCapped: number; properties: Record<string, number> };
    expect(product.propertyListsCapped).toBe(1);
    expect(Object.keys(product.properties)).toHaveLength(50);
  });

  it("lists at most COVERAGE_MAX_TYPES types and COVERAGE_MAX_PROPERTIES properties, counting the rest", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [{ path: "/a" }]);
    // Two Products whose property sets differ, so the type has more distinct
    // properties (2 x 50 = 100 + 2) than one node's capped list.
    for (const offset of [0, 50]) {
      const node: Record<string, unknown> = { "@context": C, "@type": "Product" };
      for (let i = 0; i < 50; i += 1) node[`p${String(offset + i).padStart(3, "0")}`] = "x";
      await addBlock(crawlId, ids.get("/a")!, node);
    }
    await addBlock(crawlId, ids.get("/a")!, { "@context": C, "@type": "Product", z1: "x", z2: "x" });
    // COVERAGE_MAX_TYPES + 2 more types of one node each: Product (3 nodes)
    // ranks first, then the singletons by name, and the last two are counted.
    for (let i = 0; i < COVERAGE_MAX_TYPES + 1; i += 1) {
      await addBlock(crawlId, ids.get("/a")!, { "@context": C, "@type": `T${String(i).padStart(3, "0")}` });
    }
    await deriveSchemaValidation(db, crawlId);
    const rows = await run(crawlId);
    expect(rows["site|"]).toMatchObject({ typesNotListed: 2 });
    expect(Object.keys(rows).filter((k) => k.startsWith("schema_type|"))).toHaveLength(COVERAGE_MAX_TYPES);
    expect(rows[`schema_type|T${String(COVERAGE_MAX_TYPES).padStart(3, "0")}`]).toBeUndefined();
    const product = rows["schema_type|Product"] as { propertiesNotListed: number; properties: Record<string, number> };
    expect(Object.keys(product.properties)).toHaveLength(COVERAGE_MAX_PROPERTIES);
    expect(product.propertiesNotListed).toBe(2);
    // Ranked by count, then name: the two past the cap are the last by name.
    expect(product.properties["p099"]).toBe(1);
    expect(product.properties["z1"]).toBeUndefined();
  });

  it("answers a crawl with no structured data with a zero site row rather than silence", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/a" }]);
    expect(await run(crawlId)).toEqual({ "site|": { nodes: 0, propertyListsCapped: 0, typesNotListed: 0 } });
  });

  it("is silent on a crawl not wholly at extraction 4: microdata and RDFa nodes were not read", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [{ path: "/a", extractionVersion: 3 }]);
    await addBlock(crawlId, ids.get("/a")!, { "@context": C, "@type": "Product", name: "x" });
    await deriveSchemaValidation(db, crawlId);
    expect(await run(crawlId)).toEqual({});
  });

  it("throws, saying to re-run the rules, on a judged block with no verdict", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [{ path: "/a" }]);
    await addBlock(crawlId, ids.get("/a")!, { "@context": C, "@type": "Product", name: "x" });
    await expect(run(crawlId)).rejects.toThrow(/re-run the rules/);
  });

  it("throws, saying to re-run the rules, on a verdict in the shape written before the rework", async () => {
    const crawlId = await site();
    const [row] = await db
      .select({ id: structuredData.id, v: structuredData.validation })
      .from(structuredData)
      .where(eq(structuredData.crawlId, crawlId))
      .orderBy(structuredData.id)
      .limit(1);
    const { emptyValues: _e, definedIds: _d, references: _r, nodes: _n, ...rest } = row!.v!;
    await db
      .update(structuredData)
      .set({ validation: { ...rest, googleFeatures: [], deprecatedFeatures: [] } as never })
      .where(eq(structuredData.id, row!.id));
    await expect(run(crawlId)).rejects.toThrow(/re-run the rules/);
  });

  it("refuses a crawl id nothing knows, rather than answering an empty table", async () => {
    await expectRefusesUnknownCrawl(db, schemaMetrics);
  });

  it("shapes as a table: a row per type and property, the type's node count on each, the site's on its own row", async () => {
    const crawlId = await site();
    const rows = await rule(ID).run(db, crawlId);
    const shaped = shapeMetricTable(ID, rule(ID).table, rows);
    expect(shaped.columns.map((c) => c.label)).toEqual([
      "Schema Type",
      "Nodes",
      "Nodes With Property List Capped",
      "Types Not Listed",
      "Properties Not Listed",
      "Property",
      "Nodes With Value",
    ]);
    const facts = { propertyListsCapped: 0 };
    const product = { scope: "Product", nodes: 2, ...facts, typesNotListed: null, propertiesNotListed: 0 };
    expect(shaped.rows.filter((r) => r["scope"] === "Site" || r["scope"] === "Product")).toEqual([
      { scope: "Site", nodes: 6, ...facts, typesNotListed: 0, propertiesNotListed: null, key: null, value: null },
      { ...product, key: "name", value: 1 },
      { ...product, key: "offers", value: 1 },
      { ...product, key: "sku", value: 1 },
      { ...product, key: "image", value: 0 },
    ]);
  });
});

// 29a rework, review fix round 1 (M3): the copy's per-node cap is the validator's.
describe("schema.property-coverage copy names the validator's own cap", () => {
  it("says the property list stops at MAX_PROBLEMS_PER_LIST", () => {
    expect(rule(ID).explanation).toContain(`property list stops at ${MAX_PROBLEMS_PER_LIST}`);
  });
});

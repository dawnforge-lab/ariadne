/**
 * The `field_presence` derivation, against a real database.
 *
 * Like the `url_params` derivation, this writes an inventory nobody is accused
 * by: what is under test is the arithmetic of "which profiled fields does this
 * block actually carry", the group semantics the PK-less `structured_data`
 * table forces on the write-back, and the two properties that make a derivation
 * safe to run inside `runRules` — idempotence, and one crawl at a time.
 *
 * Rows are inserted directly rather than crawled: the analyzer's JSON-LD
 * extraction has its own suite, and what matters here is what this derivation
 * makes of the `raw_jsonb` it finds.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, structuredData } from "../../src/db/schema.js";
import {
  FIELD_PRESENCE_PAGE_BATCH,
  SCHEMA_PROFILES,
  deriveFieldPresence,
  type FieldPresence,
} from "../../src/rules/derive/field-presence.js";
import { mkDiscovery } from "./mk-discovery.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://schema.example";

/** A Product block with everything the profile asks for. */
const COMPLETE_PRODUCT = {
  "@type": "Product",
  name: "Trail Runner 3",
  image: ["https://schema.example/img/trail-3.jpg"],
  offers: { "@type": "Offer", price: "129.00", priceCurrency: "EUR" },
  description: "A light trail shoe with a rock plate.",
  sku: "TR-3-42",
  brand: { "@type": "Brand", name: "Ariadne" },
  aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "88" },
  review: [{ "@type": "Review", author: "A runner" }],
};

describe("SCHEMA_PROFILES", () => {
  // The profiles are the contract the rules read: `schema.product-incomplete`
  // reports the required fields this table names, and its copy quotes them.
  // Pinned so a field added to a profile is a deliberate edit with a copy
  // change beside it, rather than a silent widening of what a client is told.
  it("holds exactly the two profiles the plan's table names", () => {
    expect(Object.keys(SCHEMA_PROFILES).sort()).toEqual(["BreadcrumbList", "Product"]);
    expect(SCHEMA_PROFILES["Product"]!.required).toEqual(["name", "image", "offers"]);
    expect(SCHEMA_PROFILES["Product"]!.recommended).toEqual([
      "description",
      "sku",
      "brand",
      "aggregateRating",
      "review",
    ]);
    expect(SCHEMA_PROFILES["BreadcrumbList"]!.required).toEqual(["itemListElement"]);
    expect(SCHEMA_PROFILES["BreadcrumbList"]!.recommended).toEqual([]);
  });
});

describe("deriveFieldPresence against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  /** Blocks as `PageWriter` stores them: one row per JSON-LD node. */
  async function addBlocks(
    crawlId: string,
    blocks: { pageId: string; type: string; raw: unknown }[],
  ): Promise<void> {
    await db.insert(structuredData).values(
      blocks.map((b) => ({
        crawlId,
        pageId: b.pageId,
        schemaType: b.type,
        raw: b.raw as Record<string, unknown>,
      })),
    );
  }

  async function storedPresence(
    crawlId: string,
    pageId?: string,
  ): Promise<(FieldPresence | null)[]> {
    const rows = await db
      .select()
      .from(structuredData)
      .where(
        pageId === undefined
          ? eq(structuredData.crawlId, crawlId)
          : and(eq(structuredData.crawlId, crawlId), eq(structuredData.pageId, pageId)),
      )
      .orderBy(asc(structuredData.pageId), asc(structuredData.schemaType));
    return rows.map((r) => r.fieldPresence as FieldPresence | null);
  }

  /** The one presence blob of a page that carries a single block. */
  async function presenceOf(crawlId: string, pageId: string): Promise<FieldPresence> {
    const [presence] = await storedPresence(crawlId, pageId);
    if (presence === undefined || presence === null) {
      throw new Error(`no field presence written for ${pageId}`);
    }
    return presence;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("writes required and recommended presence for a complete Product", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [{ pageId: "page_a", type: "Product", raw: COMPLETE_PRODUCT }]);

    expect(await deriveFieldPresence(db, crawlId)).toEqual({ blocks: 1 });
    expect(await presenceOf(crawlId, "page_a")).toEqual({
      required: { name: true, image: true, offers: true },
      recommended: {
        description: true,
        sku: true,
        brand: true,
        aggregateRating: true,
        review: true,
      },
    });
  });

  it("marks an absent, empty-string or empty-array field as not present", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      {
        pageId: "page_a",
        type: "Product",
        raw: {
          "@type": "Product",
          // Present as a key, carrying nothing: a title of spaces declares no
          // more than a missing one (the `present()` helper's rule).
          name: "   ",
          image: [],
          offers: COMPLETE_PRODUCT.offers,
          description: "",
          sku: null,
        },
      },
    ]);

    await deriveFieldPresence(db, crawlId);
    expect(await presenceOf(crawlId, "page_a")).toEqual({
      required: { name: false, image: false, offers: true },
      recommended: {
        description: false,
        sku: false,
        brand: false,
        aggregateRating: false,
        review: false,
      },
    });
  });

  it("counts `offers` as present only when an offer carries a price", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      {
        pageId: "page_priceless",
        type: "Product",
        raw: { "@type": "Product", offers: { "@type": "Offer", availability: "InStock" } },
      },
      {
        pageId: "page_spec",
        type: "Product",
        raw: {
          "@type": "Product",
          offers: {
            "@type": "Offer",
            priceSpecification: { "@type": "PriceSpecification", price: "12.00" },
          },
        },
      },
      {
        // An array of offers — the shape a product with several variants uses.
        // One priced offer is enough; the first carries nothing.
        pageId: "page_array",
        type: "Product",
        raw: {
          "@type": "Product",
          offers: [
            { "@type": "Offer", availability: "OutOfStock" },
            { "@type": "Offer", price: "99.00" },
          ],
        },
      },
      {
        pageId: "page_empty_array",
        type: "Product",
        raw: { "@type": "Product", offers: [] },
      },
    ]);

    await deriveFieldPresence(db, crawlId);
    expect((await presenceOf(crawlId, "page_priceless")).required["offers"]).toBe(false);
    expect((await presenceOf(crawlId, "page_spec")).required["offers"]).toBe(true);
    expect((await presenceOf(crawlId, "page_array")).required["offers"]).toBe(true);
    expect((await presenceOf(crawlId, "page_empty_array")).required["offers"]).toBe(false);
  });

  it("ORs the blocks of one page and one type together, writing the union to each", async () => {
    // `structured_data` has no primary key, so the write-back is keyed by
    // (crawl, page, type) and every block of that group receives the same
    // answer: the union of what the page's blocks of that type carry. A page
    // whose second Product block supplies the image the first is missing is not
    // a page missing an image.
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      {
        pageId: "page_split",
        type: "Product",
        raw: { "@type": "Product", name: "Half a product", offers: COMPLETE_PRODUCT.offers },
      },
      {
        pageId: "page_split",
        type: "Product",
        raw: { "@type": "Product", image: COMPLETE_PRODUCT.image, sku: "TR-3-43" },
      },
    ]);

    expect(await deriveFieldPresence(db, crawlId)).toEqual({ blocks: 2 });
    const written = await storedPresence(crawlId, "page_split");
    expect(written).toHaveLength(2);
    for (const presence of written) {
      expect(presence?.required).toEqual({ name: true, image: true, offers: true });
      expect(presence?.recommended["sku"]).toBe(true);
    }
  });

  it("keeps the types of one page apart", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      { pageId: "page_both", type: "Product", raw: COMPLETE_PRODUCT },
      { pageId: "page_both", type: "BreadcrumbList", raw: { "@type": "BreadcrumbList" } },
    ]);

    await deriveFieldPresence(db, crawlId);
    const [breadcrumb, product] = await storedPresence(crawlId, "page_both");
    // Ordered by schema type: BreadcrumbList first.
    expect(breadcrumb).toEqual({ required: { itemListElement: false }, recommended: {} });
    expect(product?.required["name"]).toBe(true);
  });

  it("judges a BreadcrumbList on its item list alone", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      {
        pageId: "page_trail",
        type: "BreadcrumbList",
        raw: {
          "@type": "BreadcrumbList",
          itemListElement: [{ "@type": "ListItem", position: 1, name: "Home" }],
        },
      },
      { pageId: "page_bare", type: "BreadcrumbList", raw: { "@type": "BreadcrumbList", itemListElement: [] } },
    ]);

    await deriveFieldPresence(db, crawlId);
    expect(await presenceOf(crawlId, "page_trail")).toEqual({
      required: { itemListElement: true },
      recommended: {},
    });
    expect((await presenceOf(crawlId, "page_bare")).required["itemListElement"]).toBe(false);
  });

  it("leaves an unprofiled type's presence null rather than calling it empty", async () => {
    // Null means "no profile for this type", which is not the same claim as
    // "this block carries none of its fields". An Article row judged against
    // the Product profile would be a finding about a field Article never has.
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      { pageId: "page_article", type: "Article", raw: { "@type": "Article", headline: "Hello" } },
      { pageId: "page_product", type: "Product", raw: COMPLETE_PRODUCT },
    ]);

    expect(await deriveFieldPresence(db, crawlId)).toEqual({ blocks: 1 });
    expect(await storedPresence(crawlId, "page_article")).toEqual([null]);
  });

  it("writes nothing, loudly counted as nothing, for a crawl with no profiled blocks", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      { pageId: "page_org", type: "Organization", raw: { "@type": "Organization", name: "Us" } },
    ]);
    expect(await deriveFieldPresence(db, crawlId)).toEqual({ blocks: 0 });
    expect(await storedPresence(crawlId)).toEqual([null]);
  });

  it("streams past the page batch: every page's blocks are written", async () => {
    const crawlId = await newCrawl();
    const pageIds = Array.from(
      { length: FIELD_PRESENCE_PAGE_BATCH + 1 },
      (_, i) => `page_${String(i).padStart(5, "0")}`,
    );
    for (let i = 0; i < pageIds.length; i += 100) {
      await addBlocks(
        crawlId,
        pageIds.slice(i, i + 100).map((pageId) => ({
          pageId,
          type: "Product",
          raw: COMPLETE_PRODUCT,
        })),
      );
    }

    expect(await deriveFieldPresence(db, crawlId)).toEqual({ blocks: pageIds.length });
    const written = await storedPresence(crawlId);
    expect(written).toHaveLength(pageIds.length);
    expect(written.every((p) => p?.required["name"] === true)).toBe(true);
  });

  it("is idempotent: a second run leaves the same blobs", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      { pageId: "page_a", type: "Product", raw: { "@type": "Product", name: "Only a name" } },
    ]);

    const first = await deriveFieldPresence(db, crawlId);
    const afterFirst = await storedPresence(crawlId);
    const second = await deriveFieldPresence(db, crawlId);

    expect(second).toEqual(first);
    expect(await storedPresence(crawlId)).toEqual(afterFirst);
  });

  it("is scoped to one crawl: deriving mine does not touch yours", async () => {
    const mine = await newCrawl();
    const yours = await newCrawl();
    await addBlocks(mine, [{ pageId: "page_a", type: "Product", raw: COMPLETE_PRODUCT }]);
    await addBlocks(yours, [{ pageId: "page_a", type: "Product", raw: COMPLETE_PRODUCT }]);

    await deriveFieldPresence(db, mine);
    expect(await storedPresence(yours)).toEqual([null]);
  });

  it("refuses a crawl id nothing knows rather than deriving an empty inventory", async () => {
    await expect(deriveFieldPresence(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
  });
});

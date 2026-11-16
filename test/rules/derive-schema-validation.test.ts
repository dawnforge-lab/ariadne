/**
 * The `validation_jsonb` derivation, against a real database.
 *
 * Rows are inserted directly rather than crawled: what is under test is the
 * cursor loop, the batched write-back and the properties that make a derivation
 * safe inside `runRules` (idempotence, one crawl at a time, an unknown crawl is
 * an error), not what the validator makes of any one block (its own suite).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, structuredData } from "../../src/db/schema.js";
import {
  SCHEMA_VALIDATION_BATCH,
  deriveSchemaValidation,
} from "../../src/rules/derive/schema-validation.js";
import { blockValidationSchema } from "../../src/rules/schema-org/validate.js";
import { mkDiscovery } from "./mk-discovery.js";
import { mkPage } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://schema.example";

describe("deriveSchemaValidation against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      hostKey: hostKeyOf(SITE),
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  /** The one page every block of a crawl here sits on: its URL is the ids' base. */
  const pageOf = (crawlId: string): string => `${crawlId}_page`;
  async function addPage(crawlId: string, url = `${SITE}/`): Promise<void> {
    await db.insert(pages).values(mkPage({ id: pageOf(crawlId), crawlId, url }));
  }

  async function addBlocks(crawlId: string, raws: Record<string, unknown>[]): Promise<void> {
    await addPage(crawlId);
    for (let i = 0; i < raws.length; i += 1000) {
      await db.insert(structuredData).values(
        raws.slice(i, i + 1000).map((raw) => ({
          crawlId,
          pageId: pageOf(crawlId),
          schemaType: String(raw["@type"]),
          format: "jsonld" as const,
          raw,
        })),
      );
    }
  }

  async function stored(crawlId: string) {
    return db
      .select({ id: structuredData.id, validation: structuredData.validation })
      .from(structuredData)
      .where(eq(structuredData.crawlId, crawlId))
      .orderBy(asc(structuredData.id));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("writes a blob for every row", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      { "@type": "Product", name: "A", offers: { "@type": "Offer", price: "1" } },
      { "@type": "Organization", name: "Org" },
      { "@type": "NotARealType" },
    ]);
    expect(await deriveSchemaValidation(db, crawlId)).toEqual({ blocks: 3 });
    const rows = await stored(crawlId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.validation, `row ${row.id}`).not.toBeNull();
      expect(() => blockValidationSchema.parse(row.validation)).not.toThrow();
    }
  });

  it("is idempotent", async () => {
    const crawlId = await newCrawl();
    await addBlocks(crawlId, [
      { "@type": "Product", name: "A", bogusProp: 1 },
      { "@type": "Organization", name: "Org" },
    ]);
    await deriveSchemaValidation(db, crawlId);
    const first = await stored(crawlId);
    await deriveSchemaValidation(db, crawlId);
    expect(await stored(crawlId)).toEqual(first);
  });

  it("throws for an unknown crawl", async () => {
    await expect(deriveSchemaValidation(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
  });

  it("derives only the crawl it is given", async () => {
    const mine = await newCrawl();
    const other = await newCrawl();
    await addBlocks(mine, [{ "@type": "Organization", name: "Mine" }]);
    await addBlocks(other, [{ "@type": "Organization", name: "Other" }]);
    await deriveSchemaValidation(db, mine);
    expect((await stored(other))[0]!.validation).toBeNull();
  });

  it("batches", async () => {
    const crawlId = await newCrawl();
    const total = SCHEMA_VALIDATION_BATCH * 2 + 201;
    expect(total).toBe(1201);
    await addBlocks(
      crawlId,
      Array.from({ length: total }, (_, i) => ({ "@type": "Organization", name: `Org ${i}` })),
    );
    expect(await deriveSchemaValidation(db, crawlId)).toEqual({ blocks: total });
    const rows = await stored(crawlId);
    expect(rows).toHaveLength(total);
    expect(rows.filter((r) => r.validation === null)).toHaveLength(0);
  });

  it("validates every row when ids cross a digit boundary (numeric, not lexical, order)", async () => {
    // Regression (29a gate): `order by id` bound to the text alias, so rows sorted
    // lexically while the cursor advanced numerically, and every id below the
    // boundary was skipped. Explicit ids sit far above the dev sequence.
    const crawlId = await newCrawl();
    const first = 99_999_999_700;
    const total = SCHEMA_VALIDATION_BATCH + 100;
    await addPage(crawlId);
    for (let i = 0; i < total; i += 300) {
      await db.insert(structuredData).values(
        Array.from({ length: Math.min(300, total - i) }, (_, j) => ({
          id: first + i + j,
          crawlId,
          pageId: pageOf(crawlId),
          schemaType: "Organization",
          format: "jsonld" as const,
          raw: { "@type": "Organization", name: `Org ${i + j}` },
        })),
      );
    }
    expect(first + total - 1).toBe(100_000_000_299);
    expect(await deriveSchemaValidation(db, crawlId)).toEqual({ blocks: total });
    const rows = await stored(crawlId);
    expect(rows).toHaveLength(total);
    expect(rows.filter((r) => r.validation === null).map((r) => r.id)).toEqual([]);
  });
});

// 29a rework, review fix round 1: ids resolve against the page each block sits on.
describe("deriveSchemaValidation resolves ids against the page", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      hostKey: hostKeyOf(SITE),
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  it("stores a relative @id resolved against the URL of the block's own page", async () => {
    const crawlId = await newCrawl();
    const ids = { a: `${crawlId}_a`, b: `${crawlId}_b` };
    await db.insert(pages).values([
      mkPage({ id: ids.a, crawlId, url: `${SITE}/a` }),
      mkPage({ id: ids.b, crawlId, url: `${SITE}/shop/b` }),
    ]);
    const raw = { "@context": "https://schema.org", "@type": "WebPage", "@id": "#page", name: "x", about: { "@id": "#org" } };
    await db.insert(structuredData).values([
      { crawlId, pageId: ids.a, schemaType: "WebPage", format: "jsonld", raw },
      { crawlId, pageId: ids.b, schemaType: "WebPage", format: "jsonld", raw },
    ]);
    await deriveSchemaValidation(db, crawlId);
    const rows = await db
      .select({ v: structuredData.validation })
      .from(structuredData)
      .where(eq(structuredData.crawlId, crawlId))
      .orderBy(asc(structuredData.id));
    expect(rows.map((r) => r.v!.definedIds)).toEqual([[`${SITE}/a#page`], [`${SITE}/shop/b#page`]]);
    expect(rows.map((r) => r.v!.references)).toEqual([
      [{ path: "$.about", id: `${SITE}/a#org`, written: "#org" }],
      [{ path: "$.about", id: `${SITE}/shop/b#org`, written: "#org" }],
    ]);
  });

  it("throws, naming the row, for a block whose page row is missing: its base is unknown", async () => {
    const crawlId = await newCrawl();
    await db.insert(structuredData).values({
      crawlId,
      pageId: `${crawlId}_ghost`,
      schemaType: "Thing",
      format: "jsonld",
      raw: { "@type": "Thing", name: "x" },
    });
    await expect(deriveSchemaValidation(db, crawlId)).rejects.toThrow(
      new RegExp(`crawl '${crawlId}' structured_data row \\d+ has no page row`),
    );
  });
});

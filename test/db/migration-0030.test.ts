/**
 * Migration 0030: backfill `resources.share_image` for crawls written before
 * Phase 26c. A 26b share image is a `resources` row with no `page_resources`
 * edge, so those rows must read `share_image = true` and an edged row must not.
 *
 * The test runs the migration's own SQL file, so it cannot drift from it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pageResources, pages, resources } from "../../src/db/schema.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
const created: string[] = [];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
});

describe("0030 — share images of pre-26c crawls are marked", () => {
  it("sets share_image on edge-less rows only", async () => {
    const crawlId = `crawl_0030_${randomUUID()}`;
    await db.insert(crawls).values({
      id: crawlId, siteUrl: "https://m30.example", config: {}, rulesetVersion: "test",
    });
    created.push(crawlId);
    await db.insert(pages).values({
      id: `${crawlId}_p`, crawlId, url: "https://m30.example/",
      urlNormalised: "https://m30.example", fetchClass: "ok", depth: 0, discoveredVia: "seed",
    });
    // The pre-26c shape: every row has share_image false.
    await db.insert(resources).values([
      { crawlId, url: "https://m30.example/og.png", kind: "image" },
      { crawlId, url: "https://m30.example/logo.png", kind: "image" },
    ]);
    await db.insert(pageResources).values({
      crawlId, pageId: `${crawlId}_p`, resourceUrl: "https://m30.example/logo.png",
    });

    const file = readFileSync(new URL("../../drizzle/0030_share_image_backfill.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(file));

    const rows = await db
      .select({ url: resources.url, shareImage: resources.shareImage })
      .from(resources)
      .where(eq(resources.crawlId, crawlId))
      .orderBy(resources.url);
    expect(rows).toEqual([
      { url: "https://m30.example/logo.png", shareImage: false },
      { url: "https://m30.example/og.png", shareImage: true },
    ]);
  });
});

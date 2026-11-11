/**
 * Migration 0030: backfill `resources.share_image` for crawls written before
 * Phase 26c. A 26b share image is a `resources` row with no `page_resources`
 * edge, so those rows must read `share_image = true` and an edged row must not.
 *
 * The test runs the migration's own SQL file, so it cannot drift from it. That
 * UPDATE is unscoped (it touches every crawl's edge-less rows), and other test
 * files share this database in parallel, so the fixture, the UPDATE and the
 * assertions all run inside one transaction that is always rolled back
 * (final review I2): nothing outside it ever sees the update.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pageResources, pages, resources } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/** Thrown at the end of the transaction to roll it back; anything else is a failure. */
class RollBack extends Error {}

let db: Db;

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(db);
});

describe("0030 — share images of pre-26c crawls are marked", () => {
  it("sets share_image on edge-less rows only, inside a transaction that is rolled back", async () => {
    const crawlId = `crawl_0030_${randomUUID()}`;
    const file = readFileSync(new URL("../../drizzle/0030_share_image_backfill.sql", import.meta.url), "utf8");
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        await tx.insert(crawls).values({
          tenantId: LOCAL_TENANT,
          id: crawlId, siteUrl: "https://m30.example", hostKey: hostKeyOf("https://m30.example"), config: {}, rulesetVersion: "test",
        });
        await tx.insert(pages).values({
          id: `${crawlId}_p`, crawlId, url: "https://m30.example/",
          urlNormalised: "https://m30.example", fetchClass: "ok", depth: 0, discoveredVia: "seed",
        });
        // The pre-26c shape: every row has share_image false.
        await tx.insert(resources).values([
          { crawlId, url: "https://m30.example/og.png", kind: "image" },
          { crawlId, url: "https://m30.example/logo.png", kind: "image" },
        ]);
        await tx.insert(pageResources).values({
          crawlId, pageId: `${crawlId}_p`, resourceUrl: "https://m30.example/logo.png",
        });

        await tx.execute(sql.raw(file));

        const rows = await tx
          .select({ url: resources.url, shareImage: resources.shareImage })
          .from(resources)
          .where(eq(resources.crawlId, crawlId))
          .orderBy(resources.url);
        expect(rows).toEqual([
          { url: "https://m30.example/logo.png", shareImage: false },
          { url: "https://m30.example/og.png", shareImage: true },
        ]);
        asserted = true;
        throw new RollBack("roll back the unscoped backfill");
      })
      .catch((error: unknown) => {
        // A failed assertion or query inside surfaces as itself, not as a rollback.
        if (error instanceof RollBack) return error;
        throw error;
      });

    expect(outcome).toBeInstanceOf(RollBack);
    expect(asserted).toBe(true);
    // Rolled back: the crawl the transaction inserted is not there.
    const left = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, crawlId));
    expect(left).toEqual([]);
  });
});

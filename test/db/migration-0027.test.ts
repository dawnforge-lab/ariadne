/**
 * Migration 0027: four Phase 26b count columns widened from `smallint` to
 * `integer` (Ruling R7).
 *
 * 0026 created `title_count`, `meta_description_count`, `rel_next_count` and
 * `rel_prev_count` as smallint. A page within the 2 MiB body cap can carry
 * more than 32,767 such tags, so the insert would throw, the crawl would fail
 * and a resume would repeat it. 0027 widens them; no value is clamped.
 *
 * Claim: the four columns are integer, still nullable with no default, and
 * hold a value past the smallint range.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const WIDENED = ["title_count", "meta_description_count", "rel_next_count", "rel_prev_count"];

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

describe("0027 — the Phase 26b count columns are integer", () => {
  it("widens the four columns to integer, nullable, with no default", async () => {
    const rows = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = current_schema() and table_name = 'pages'
        and column_name in (${sql.join(WIDENED.map((n) => sql`${n}`), sql`, `)})
    `);
    const found = new Map(rows.rows.map((r) => [r.column_name, r]));
    expect(found.size).toBe(WIDENED.length);
    for (const column of WIDENED) {
      const row = found.get(column);
      expect(row?.data_type, column).toBe("integer");
      expect(row?.is_nullable, column).toBe("YES");
      expect(row?.column_default, column).toBeNull();
    }
  });

  it("stores a count past the smallint range", async () => {
    const crawlId = `crawl_0027_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id: crawlId, siteUrl: "https://m27.example", config: {}, rulesetVersion: "test",
    });
    created.push(crawlId);
    await db.insert(pages).values({
      id: `${crawlId}_p`, crawlId, url: "https://m27.example/",
      urlNormalised: "https://m27.example", fetchClass: "ok", depth: 0, discoveredVia: "seed",
      titleCount: 40_000, metaDescriptionCount: 40_001, relNextCount: 40_002, relPrevCount: 40_003,
    });
    const [page] = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(page?.titleCount).toBe(40_000);
    expect(page?.metaDescriptionCount).toBe(40_001);
    expect(page?.relNextCount).toBe(40_002);
    expect(page?.relPrevCount).toBe(40_003);
  });
});

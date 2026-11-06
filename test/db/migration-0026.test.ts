/**
 * Migration 0026: the Phase 26b page facts on `pages` (extraction version 2).
 *
 * Claim: all fifteen columns exist with their types, are nullable with no
 * default, a row that never names them reads null ("not measured"), and the
 * three duplicate-group indexes exist.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const COLUMNS: Array<[column: string, type: string]> = [
  ["html_lang", "text"],
  ["social", "jsonb"],
  ["h2_text", "text"],
  ["title_count", "smallint"],
  ["meta_description_count", "smallint"],
  ["robots_metas", "jsonb"],
  ["meta_refresh", "jsonb"],
  ["anchor_counts", "jsonb"],
  ["insecure_refs", "jsonb"],
  ["images_empty_alt", "integer"],
  ["images_alt_too_long", "integer"],
  ["images_missing_alt_sample", "jsonb"],
  ["rel_next_count", "smallint"],
  ["rel_prev_count", "smallint"],
  ["html_structure", "jsonb"],
];

const INDEXES = ["pages_dupe_h2_text", "pages_dupe_og_title", "pages_dupe_og_description"];

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

describe("0026 — the Phase 26b page facts", () => {
  it("adds all fifteen columns, nullable, with no default", async () => {
    const names = COLUMNS.map(([c]) => c);
    const rows = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = current_schema() and table_name = 'pages'
        and column_name in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
    `);
    const found = new Map(rows.rows.map((r) => [r.column_name, r]));
    expect(found.size).toBe(COLUMNS.length);
    for (const [column, type] of COLUMNS) {
      const row = found.get(column);
      expect(row, column).toBeDefined();
      expect(row?.data_type, column).toBe(type);
      expect(row?.is_nullable, column).toBe("YES");
      expect(row?.column_default, column).toBeNull();
    }
  });

  it("reads null on a row that never named them", async () => {
    const crawlId = `crawl_0026_${randomUUID()}`;
    await db.insert(crawls).values({
      id: crawlId, siteUrl: "https://m26.example", config: {}, rulesetVersion: "test",
    });
    created.push(crawlId);
    await db.insert(pages).values({
      id: `${crawlId}_p`, crawlId, url: "https://m26.example/",
      urlNormalised: "https://m26.example", fetchClass: "ok", depth: 0, discoveredVia: "seed",
    });
    const [page] = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(page?.htmlLang).toBeNull();
    expect(page?.social).toBeNull();
    expect(page?.h2Text).toBeNull();
    expect(page?.titleCount).toBeNull();
    expect(page?.metaDescriptionCount).toBeNull();
    expect(page?.robotsMetas).toBeNull();
    expect(page?.metaRefresh).toBeNull();
    expect(page?.anchorCounts).toBeNull();
    expect(page?.insecureRefs).toBeNull();
    expect(page?.imagesEmptyAlt).toBeNull();
    expect(page?.imagesAltTooLong).toBeNull();
    expect(page?.imagesMissingAltSample).toBeNull();
    expect(page?.relNextCount).toBeNull();
    expect(page?.relPrevCount).toBeNull();
    expect(page?.htmlStructure).toBeNull();
  });

  it("creates the three duplicate-group indexes", async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = current_schema() and tablename = 'pages'
        and indexname in (${sql.join(INDEXES.map((n) => sql`${n}`), sql`, `)})
    `);
    expect(rows.rows.map((r) => r.indexname).sort()).toEqual([...INDEXES].sort());
  });
});

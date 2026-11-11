/**
 * Migration 0025: the evidence-layer columns (Phase 25) — `pages.response_headers`,
 * `extraction_version`, `render_version`, `render_console` and `crawls.request_headers`,
 * `engine_version`, `render_launch_error`.
 *
 * Claim: all seven exist, are nullable with no default, and a row inserted without
 * naming them reads null (what a row written before Phase 25 looks like). Null is the
 * "not measured" half of every contract these columns carry, so it must be the only
 * thing the schema can produce on its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["pages", "response_headers", "jsonb"],
  ["pages", "extraction_version", "smallint"],
  ["pages", "render_version", "smallint"],
  ["pages", "render_console", "jsonb"],
  ["crawls", "request_headers", "jsonb"],
  ["crawls", "engine_version", "text"],
  ["crawls", "render_launch_error", "text"],
];

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

describe("0025 — the evidence-layer columns", () => {
  it("adds all seven, nullable, with no default", async () => {
    const rows = await db.execute<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = current_schema()
        and ((table_name = 'pages' and column_name in
               ('response_headers','extraction_version','render_version','render_console'))
          or (table_name = 'crawls' and column_name in
               ('request_headers','engine_version','render_launch_error')))
    `);
    const found = new Map(rows.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    expect(found.size).toBe(COLUMNS.length);
    for (const [table, column, type] of COLUMNS) {
      const row = found.get(`${table}.${column}`);
      expect(row, `${table}.${column}`).toBeDefined();
      expect(row?.data_type, `${table}.${column}`).toBe(type);
      expect(row?.is_nullable, `${table}.${column}`).toBe("YES");
      expect(row?.column_default, `${table}.${column}`).toBeNull();
    }
  });

  it("reads null on a row that never named them", async () => {
    const crawlId = `crawl_0025_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id: crawlId,
      siteUrl: "https://m25.example",
      config: {},
      rulesetVersion: "test",
    });
    created.push(crawlId);
    await db.insert(pages).values({
      id: `${crawlId}_p`,
      crawlId,
      url: "https://m25.example/",
      urlNormalised: "https://m25.example",
      fetchClass: "ok",
      depth: 0,
      discoveredVia: "seed",
    });

    const [crawl] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(crawl?.requestHeaders).toBeNull();
    expect(crawl?.engineVersion).toBeNull();
    expect(crawl?.renderLaunchError).toBeNull();

    const [page] = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(page?.responseHeaders).toBeNull();
    expect(page?.extractionVersion).toBeNull();
    expect(page?.renderVersion).toBeNull();
    expect(page?.renderConsole).toBeNull();
  });
});

/**
 * Migration 0036 (Phase 27c): `frontier.redirect_hops`, `crawls.excluded_dropped`,
 * `crawls.scope_changed_at` and the `list_urls` table.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, listUrls } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
const created: string[] = [];

async function newCrawl(): Promise<string> {
  const id = `crawl_${randomUUID()}`;
  await db.insert(crawls).values({ tenantId: LOCAL_TENANT, id, siteUrl: "https://s.example", config: {}, rulesetVersion: "test" });
  created.push(id);
  return id;
}

type Col = {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function column(table: string, name: string): Promise<Col | undefined> {
  const r = await db.execute<Col>(sql`
    select data_type, is_nullable, column_default from information_schema.columns
    where table_schema = current_schema() and table_name = ${table} and column_name = ${name}`);
  return r.rows[0];
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
});

describe("0036 columns", () => {
  it("frontier.redirect_hops is integer not null default 0", async () => {
    expect(await column("frontier", "redirect_hops")).toEqual({
      data_type: "integer",
      is_nullable: "NO",
      column_default: "0",
    });
  });

  it("crawls.excluded_dropped is a nullable integer with no default", async () => {
    expect(await column("crawls", "excluded_dropped")).toEqual({
      data_type: "integer",
      is_nullable: "YES",
      column_default: null,
    });
  });

  it("crawls.scope_changed_at is a nullable timestamptz with no default", async () => {
    expect(await column("crawls", "scope_changed_at")).toEqual({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
      column_default: null,
    });
  });

  it("a new crawl starts with both nulls", async () => {
    const id = await newCrawl();
    const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
    expect(row?.excludedDropped).toBeNull();
    expect(row?.scopeChangedAt).toBeNull();
  });
});

describe("0036 list_urls", () => {
  it("is keyed by (crawl_id, position)", async () => {
    const r = await db.execute<{ column_name: string }>(sql`
      select kcu.column_name from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      where tc.table_schema = current_schema() and tc.table_name = 'list_urls'
        and tc.constraint_type = 'PRIMARY KEY'
      order by kcu.ordinal_position`);
    expect(r.rows.map((x) => x.column_name)).toEqual(["crawl_id", "position"]);
    const id = await newCrawl();
    await db.insert(listUrls).values({ crawlId: id, position: 0, url: "https://s.example/a" });
    await expect(
      db.insert(listUrls).values({ crawlId: id, position: 0, url: "https://s.example/b" }),
    ).rejects.toThrow();
  });

  it("cascades on crawl delete", async () => {
    const id = await newCrawl();
    await db.insert(listUrls).values([
      { crawlId: id, position: 0, url: "https://s.example/a" },
      { crawlId: id, position: 1, url: "https://s.example/b" },
    ]);
    await db.delete(crawls).where(eq(crawls.id, id));
    expect(await db.select().from(listUrls).where(eq(listUrls.crawlId, id))).toEqual([]);
  });
});

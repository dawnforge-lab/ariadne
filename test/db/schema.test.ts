import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, closeDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

describe("schema", () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });
  afterAll(async () => { await closeDb(db); });

  it("creates all contract tables", async () => {
    const res = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`);
    const names = res.rows.map((r) => r.table_name);
    for (const t of ["crawls","pages","links","hreflang","structured_data",
                     "sitemap_urls","url_params","issues","metrics","frontier"]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it("pages has the extraction columns the checklist needs", async () => {
    const res = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'pages'`);
    const cols = res.rows.map((r) => r.column_name);
    for (const c of ["url_normalised","page_type","fetch_class","simhash","text_ratio",
                     "dom_size","rel_next","rel_prev","discovered_via","rendered_word_count",
                     "canonical_count","has_viewport","images_missing_dimensions",
                     "has_lorem_ipsum"]) {
      expect(cols, `missing pages.${c}`).toContain(c);
    }
    // Dropped in Phase 2: never written by the crawler, so a rule reading them
    // would be a rule that always passes (build plan hard rule 1).
    for (const gone of ["in_sitemap", "redirect_hops"]) {
      expect(cols, `${gone} should be dropped`).not.toContain(gone);
    }
  });
});

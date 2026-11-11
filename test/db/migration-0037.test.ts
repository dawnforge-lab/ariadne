/**
 * Migration 0037: `crawls.tenant_id`. Crawls that exist before it are
 * backfilled to `local`, and the column is NOT NULL with no default afterwards.
 *
 * The test runs the migration's own SQL file, so it cannot drift from it. The
 * migration is already applied to the shared database, so the fixture undoes it
 * (drops the column, which takes its index with it), inserts two pre-28a rows,
 * re-runs the file and asserts, all inside one transaction that is always
 * rolled back (the migration-0032 pattern).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

class RollBack extends Error {}

let db: Db;

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(db);
});

describe("0037 — crawls carry a tenant", () => {
  it("backfills pre-28a crawls to local and then refuses an insert without a tenant, rolled back", async () => {
    const tag = randomUUID();
    const ids = [`crawl_0037_a_${tag}`, `crawl_0037_b_${tag}`];
    const file = readFileSync(
      new URL("../../drizzle/0037_crawls_tenant_id.sql", import.meta.url),
      "utf8",
    );
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        // The state at 0036: no tenant column.
        await tx.execute(sql`alter table crawls drop column tenant_id`);
        for (const id of ids) {
          await tx.execute(sql`
            insert into crawls (id, site_url, config_jsonb, ruleset_version)
            values (${id}, 'https://m37.example', '{}'::jsonb, 'test')`);
        }

        await tx.execute(sql.raw(file));

        const rows = await tx
          .select({ id: crawls.id, tenantId: crawls.tenantId })
          .from(crawls)
          .where(inArray(crawls.id, ids));
        expect(rows).toHaveLength(2);
        for (const row of rows) expect(row.tenantId).toBe("local");

        // No column default: a writer that omits the tenant is refused. The
        // failed statement runs in a savepoint so the transaction stays usable.
        const refused = await tx
          .transaction(async (inner) => {
            await inner.execute(sql`
              insert into crawls (id, site_url, config_jsonb, ruleset_version)
              values (${`crawl_0037_c_${tag}`}, 'https://m37.example', '{}'::jsonb, 'test')`);
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(refused).not.toBeNull();
        const cause = (refused as { cause?: { code?: string } }).cause;
        expect(cause?.code).toBe("23502");

        asserted = true;
        throw new RollBack("roll back the column drop and the fixture");
      })
      .catch((error: unknown) => {
        if (error instanceof RollBack) return error;
        throw error;
      });

    expect(outcome).toBeInstanceOf(RollBack);
    expect(asserted).toBe(true);
    const left = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, ids[0]!));
    expect(left).toEqual([]);
  });
});

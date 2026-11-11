/**
 * Migration 0035: stored `cancelled` crawls become `paused` with reason
 * `shutdown` (before 27b the only path that wrote `cancelled` was a shutdown
 * abort). Runs the migration's own SQL inside a transaction that is always
 * rolled back (the migration-0032 pattern), since the UPDATE is unscoped.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

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

describe("0035 — cancelled becomes paused/shutdown", () => {
  it("relabels cancelled rows and leaves others, rolled back", async () => {
    const tag = randomUUID();
    const ids = {
      c1: `crawl_0035_c1_${tag}`,
      c2: `crawl_0035_c2_${tag}`,
      done: `crawl_0035_done_${tag}`,
    };
    const file = readFileSync(new URL("../../drizzle/0035_cancelled_to_paused.sql", import.meta.url), "utf8");
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        const row = (id: string, status: string) => ({
          id,
          tenantId: LOCAL_TENANT,
          siteUrl: "https://m35.example",
          hostKey: "m35.example",
          config: { maxPages: 10 },
          rulesetVersion: "test",
          status,
        });
        await tx.insert(crawls).values([
          row(ids.c1, "cancelled"),
          row(ids.c2, "cancelled"),
          row(ids.done, "finished"),
        ]);

        await tx.execute(sql.raw(file));

        const rows = await tx
          .select({ id: crawls.id, status: crawls.status, reason: crawls.pauseReason, at: crawls.cancelledAt })
          .from(crawls)
          .where(inArray(crawls.id, Object.values(ids)));
        const by = new Map(rows.map((r) => [r.id, r]));
        for (const id of [ids.c1, ids.c2]) {
          expect(by.get(id)).toMatchObject({ status: "paused", reason: "shutdown", at: null });
        }
        expect(by.get(ids.done)).toMatchObject({ status: "finished", reason: null, at: null });

        asserted = true;
        throw new RollBack("roll back the unscoped relabel");
      })
      .catch((error: unknown) => {
        if (error instanceof RollBack) return error;
        throw error;
      });

    expect(outcome).toBeInstanceOf(RollBack);
    expect(asserted).toBe(true);
    const left = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, ids.c1));
    expect(left).toEqual([]);
  });
});

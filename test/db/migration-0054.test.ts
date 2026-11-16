/**
 * Migration 0054: a rules run's stamp names the two schema template thresholds
 * (Phase 29a T8). A stamp written before it holds 20 thresholds, which
 * `readStamp` refuses (Phase 27a Ruling 15); the migration overlays what it
 * holds onto the two defaults, and a null stamp stays null.
 *
 * Runs the migration's own SQL file inside one transaction that is always rolled
 * back (the migration-0033 pattern), because the UPDATE is unscoped and other
 * test files share this database.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { DEFAULT_THRESHOLDS, readStamp } from "../../src/rules/judgement.js";
import { THRESHOLD_NAMES } from "../../src/rules/threshold-table.js";

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

describe("0054 — a stamp names the schema template thresholds", () => {
  it("lifts a 20-threshold stamp to all of them, keeps overrides, leaves null null, rolled back", async () => {
    const tag = randomUUID();
    const ids = {
      old: `crawl_0054_old_${tag}`,
      overridden: `crawl_0054_over_${tag}`,
      unjudged: `crawl_0054_unjudged_${tag}`,
    };
    const file = readFileSync(
      new URL("../../drizzle/0054_schema_template_thresholds.sql", import.meta.url),
      "utf8",
    );
    const judgedAt = new Date("2026-11-01T00:00:00.000Z");
    // The pre-0054 shape: every threshold but the two new ones.
    const twenty: Record<string, number> = Object.fromEntries(
      THRESHOLD_NAMES.filter(
        (n) => n !== "SCHEMA_TEMPLATE_SHARE" && n !== "SCHEMA_TEMPLATE_MIN_PAGES",
      ).map((n) => [n, DEFAULT_THRESHOLDS[n]]),
    );
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        const row = (id: string, stamp: unknown, rulesRunAt: Date | null) => ({
          id,
          tenantId: LOCAL_TENANT,
          siteUrl: "https://m54.example",
          hostKey: "m54.example",
          config: { maxPages: 10 },
          rulesetVersion: "test",
          rulesRunAt,
          rulesJudgedWith: stamp,
        });
        await tx.insert(crawls).values([
          row(ids.old, { disabledRules: [], thresholds: twenty }, judgedAt),
          row(
            ids.overridden,
            { disabledRules: [], thresholds: { ...twenty, SLOW_MS: 500 } },
            judgedAt,
          ),
          row(ids.unjudged, null, null),
        ]);

        // Before: readStamp refuses the 20-threshold stamp loudly.
        const before = await tx
          .select({ stamp: crawls.rulesJudgedWith })
          .from(crawls)
          .where(eq(crawls.id, ids.old));
        expect(() => readStamp(before[0]!.stamp, ids.old)).toThrow();

        await tx.execute(sql.raw(file));

        const rows = await tx
          .select({ id: crawls.id, stamp: crawls.rulesJudgedWith })
          .from(crawls)
          .where(inArray(crawls.id, Object.values(ids)));
        const stamp = new Map(rows.map((r) => [r.id, r.stamp]));

        // The SQL writes the defaults out literally; today's code agrees.
        expect(stamp.get(ids.old)).toEqual({
          disabledRules: [],
          thresholds: { ...DEFAULT_THRESHOLDS },
        });
        expect(stamp.get(ids.overridden)).toEqual({
          disabledRules: [],
          thresholds: { ...DEFAULT_THRESHOLDS, SLOW_MS: 500 },
        });
        expect(stamp.get(ids.unjudged)).toBeNull();
        for (const id of [ids.old, ids.overridden]) {
          expect(() => readStamp(stamp.get(id), id)).not.toThrow();
        }

        // Idempotent: a second application changes nothing.
        await tx.execute(sql.raw(file));
        const again = await tx
          .select({ id: crawls.id, stamp: crawls.rulesJudgedWith })
          .from(crawls)
          .where(inArray(crawls.id, Object.values(ids)));
        expect(new Map(again.map((r) => [r.id, r.stamp]))).toEqual(stamp);

        asserted = true;
        throw new RollBack("roll back the unscoped rewrite");
      })
      .catch((error: unknown) => {
        if (error instanceof RollBack) return error;
        throw error;
      });

    expect(outcome).toBeInstanceOf(RollBack);
    expect(asserted).toBe(true);
    const left = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, ids.old));
    expect(left).toEqual([]);
  });
});

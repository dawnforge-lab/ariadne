/**
 * Migration 0033: a rules run's stamp holds the EFFECTIVE thresholds it used
 * (Phase 27a final review, Ruling 15). A stamp written before it holds only the
 * overrides, so it is rewritten to the 0.22.0 / 0.23.0 defaults overlaid with
 * those overrides; a null stamp stays null.
 *
 * The test runs the migration's own SQL file, so it cannot drift from it. The
 * UPDATE is unscoped and other test files share this database, so the fixture,
 * the UPDATE and the assertions run inside one transaction that is always
 * rolled back (the migration-0030 / 0032 pattern).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { DEFAULT_THRESHOLDS, readStamp } from "../../src/rules/judgement.js";

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

describe("0033 — a stamp holds the effective thresholds", () => {
  it("rewrites override-only stamps to defaults plus overrides and leaves a null stamp null, rolled back", async () => {
    const tag = randomUUID();
    const ids = {
      plain: `crawl_0033_plain_${tag}`,
      slow: `crawl_0033_slow_${tag}`,
      unjudged: `crawl_0033_unjudged_${tag}`,
    };
    const file = readFileSync(
      new URL("../../drizzle/0033_rules_judged_with_effective.sql", import.meta.url),
      "utf8",
    );
    const judgedAt = new Date("2026-11-01T00:00:00.000Z");
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        const row = (id: string, stamp: unknown, rulesRunAt: Date | null) => ({
          id,
          siteUrl: "https://m33.example",
          config: { maxPages: 10 },
          rulesetVersion: "test",
          rulesRunAt,
          rulesJudgedWith: stamp,
        });
        // The pre-0033 shape: overrides only.
        await tx.insert(crawls).values([
          row(ids.plain, { disabledRules: [], thresholds: {} }, judgedAt),
          row(
            ids.slow,
            { disabledRules: ["title.too-long"], thresholds: { SLOW_MS: 500 }, findingCap: 50 },
            judgedAt,
          ),
          row(ids.unjudged, null, null),
        ]);

        await tx.execute(sql.raw(file));

        const rows = await tx
          .select({ id: crawls.id, stamp: crawls.rulesJudgedWith })
          .from(crawls)
          .where(inArray(crawls.id, Object.values(ids)));
        const stamp = new Map(rows.map((r) => [r.id, r.stamp]));

        // The SQL writes the defaults out literally; today's code agrees.
        expect(stamp.get(ids.plain)).toEqual({
          disabledRules: [],
          thresholds: { ...DEFAULT_THRESHOLDS },
        });
        expect(stamp.get(ids.slow)).toEqual({
          disabledRules: ["title.too-long"],
          thresholds: { ...DEFAULT_THRESHOLDS, SLOW_MS: 500 },
          findingCap: 50,
        });
        expect(stamp.get(ids.unjudged)).toBeNull();
        for (const id of [ids.plain, ids.slow]) {
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
        // A failed assertion or query inside surfaces as itself, not as a rollback.
        if (error instanceof RollBack) return error;
        throw error;
      });

    expect(outcome).toBeInstanceOf(RollBack);
    expect(asserted).toBe(true);
    const left = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, ids.plain));
    expect(left).toEqual([]);
  });
});

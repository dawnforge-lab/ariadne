/**
 * Migration 0058: a rules run's stamp names the image oversize threshold
 * (Phase 29b T6). A stamp written before it holds 22 thresholds, which
 * `readStamp` refuses (Phase 27a Ruling 15); the migration overlays what it
 * holds onto the default, and a null stamp stays null.
 *
 * Runs the migration's own SQL file inside one transaction that is always rolled
 * back (the migration-0054 pattern), because the UPDATE is unscoped and other
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

describe("0058 — a stamp names the image oversize threshold", () => {
  it("lifts a 22-threshold stamp to all of them, keeps overrides, leaves null null, rolled back", async () => {
    const tag = randomUUID();
    const ids = {
      old: `crawl_0058_old_${tag}`,
      overridden: `crawl_0058_over_${tag}`,
      unjudged: `crawl_0058_unjudged_${tag}`,
    };
    const file = readFileSync(
      new URL("../../drizzle/0058_image_oversize_threshold.sql", import.meta.url),
      "utf8",
    );
    const judgedAt = new Date("2026-11-17T00:00:00.000Z");
    // The pre-0058 shape: every threshold but the new one.
    const { IMAGE_OVERSIZE_PERCENT: _image, ...twentyTwo } = DEFAULT_THRESHOLDS;
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        const row = (id: string, stamp: unknown, rulesRunAt: Date | null) => ({
          id,
          tenantId: LOCAL_TENANT,
          siteUrl: "https://m58.example",
          hostKey: "m58.example",
          config: { maxPages: 10 },
          rulesetVersion: "test",
          rulesRunAt,
          rulesJudgedWith: stamp,
        });
        await tx.insert(crawls).values([
          row(ids.old, { disabledRules: [], thresholds: twentyTwo }, judgedAt),
          row(
            ids.overridden,
            { disabledRules: [], thresholds: { ...twentyTwo, SLOW_MS: 500 } },
            judgedAt,
          ),
          row(ids.unjudged, null, null),
        ]);

        // Before: readStamp refuses the 22-threshold stamp loudly.
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

        // The SQL writes the default out literally; today's code agrees.
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

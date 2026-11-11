/**
 * Migration 0032: backfill `crawls.rules_judged_with_jsonb` for crawls judged
 * before Phase 27a. Such a crawl was judged with no overrides and no threshold
 * changes, under the cap its config carried, so the stamp says exactly that —
 * and a crawl that was never judged keeps a null stamp beside its null
 * `rules_run_at`.
 *
 * The test runs the migration's own SQL file, so it cannot drift from it. The
 * UPDATE is unscoped and other test files share this database, so the fixture,
 * the UPDATE and the assertions run inside one transaction that is always
 * rolled back (the migration-0030 pattern).
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

describe("0032 — crawls judged before 27a carry a stamp", () => {
  it("stamps judged crawls with their stored cap and leaves unjudged ones null, rolled back", async () => {
    const tag = randomUUID();
    const ids = {
      capped: `crawl_0032_capped_${tag}`,
      uncapped: `crawl_0032_uncapped_${tag}`,
      defaulted: `crawl_0032_default_${tag}`,
      unjudged: `crawl_0032_unjudged_${tag}`,
    };
    const file = readFileSync(
      new URL("../../drizzle/0032_rules_judged_with_backfill.sql", import.meta.url),
      "utf8",
    );
    const judgedAt = new Date("2026-11-01T00:00:00.000Z");
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        const row = (id: string, config: Record<string, unknown>, rulesRunAt: Date | null) => ({
          id,
          tenantId: LOCAL_TENANT,
          siteUrl: "https://m32.example",
          hostKey: "m32.example",
          config,
          rulesetVersion: "test",
          rulesRunAt,
        });
        // The pre-27a shape: no stamp anywhere.
        await tx.insert(crawls).values([
          row(ids.capped, { maxPages: 10, findingCap: 200 }, judgedAt),
          row(ids.uncapped, { maxPages: 10, findingCap: null }, judgedAt),
          row(ids.defaulted, { maxPages: 10 }, judgedAt),
          row(ids.unjudged, { maxPages: 10, findingCap: 200 }, null),
        ]);

        await tx.execute(sql.raw(file));

        const rows = await tx
          .select({ id: crawls.id, stamp: crawls.rulesJudgedWith })
          .from(crawls)
          .where(inArray(crawls.id, Object.values(ids)));
        const stamp = new Map(rows.map((r) => [r.id, r.stamp]));

        expect(stamp.get(ids.capped)).toEqual({ disabledRules: [], thresholds: {}, findingCap: 200 });
        expect(stamp.get(ids.uncapped)).toEqual({ disabledRules: [], thresholds: {}, findingCap: null });
        const defaulted = stamp.get(ids.defaulted);
        expect(defaulted).toEqual({ disabledRules: [], thresholds: {} });
        expect(Object.keys(defaulted as object)).not.toContain("findingCap");
        expect(stamp.get(ids.unjudged)).toBeNull();
        // Each backfilled stamp is one the reader accepts once 0033 has given it
        // the effective thresholds (a stamp of overrides alone is refused).
        for (const id of [ids.capped, ids.uncapped, ids.defaulted]) {
          expect(() => readStamp(stamp.get(id), id)).toThrow(/thresholds/);
        }
        await tx.execute(sql.raw(readFileSync(
          new URL("../../drizzle/0033_rules_judged_with_effective.sql", import.meta.url),
          "utf8",
        )));
        const effective = await tx
          .select({ id: crawls.id, stamp: crawls.rulesJudgedWith })
          .from(crawls)
          .where(inArray(crawls.id, [ids.capped, ids.uncapped, ids.defaulted]));
        for (const { id, stamp: after } of effective) {
          expect(readStamp(after, id).thresholds).toEqual({ ...DEFAULT_THRESHOLDS });
        }

        asserted = true;
        throw new RollBack("roll back the unscoped backfill");
      })
      .catch((error: unknown) => {
        // A failed assertion or query inside surfaces as itself, not as a rollback.
        if (error instanceof RollBack) return error;
        throw error;
      });

    expect(outcome).toBeInstanceOf(RollBack);
    expect(asserted).toBe(true);
    const left = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, ids.capped));
    expect(left).toEqual([]);
  });
});

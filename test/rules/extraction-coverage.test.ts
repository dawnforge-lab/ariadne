import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { extractionCoverage } from "../../src/rules/helpers.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
const createdCrawls: string[] = [];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
});

async function seed(versions: Array<number | null>): Promise<string> {
  const id = `crawl_cov_${randomUUID()}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: "https://cov.example",
    config: {},
    rulesetVersion: "test",
  });
  createdCrawls.push(id);
  if (versions.length === 0) return id;
  await db.insert(pages).values(
    versions.map((v, i) => ({
      id: `${id}_p${i}`,
      crawlId: id,
      url: `https://cov.example/${i}`,
      urlNormalised: `https://cov.example/${i}`,
      fetchClass: "ok",
      depth: 0,
      discoveredVia: "seed",
      extractionVersion: v,
    })),
  );
  return id;
}

describe("extractionCoverage", () => {
  it("counts null as below: two at version 1 and one null", async () => {
    const id = await seed([1, 1, null]);
    expect(await extractionCoverage(db, id, 1)).toEqual({ atOrAbove: 2, below: 1 });
  });

  it("counts rows under the minimum as below, and rows over it as at-or-above", async () => {
    const id = await seed([1, 2, 3]);
    expect(await extractionCoverage(db, id, 2)).toEqual({ atOrAbove: 2, below: 1 });
  });

  it("reports zero and zero for a crawl with no pages", async () => {
    const id = await seed([]);
    expect(await extractionCoverage(db, id, 1)).toEqual({ atOrAbove: 0, below: 0 });
  });
});

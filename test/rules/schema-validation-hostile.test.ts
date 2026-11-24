/**
 * The schema-validation derivation and the per-page schema rules over a
 * HOSTILE crawl (Phase 29d final review, Important 1; hard rule 6).
 *
 * The worst block the analyzer can store is about 100k characters of bare
 * fragment references (`{"@id":"#a1"}`, ~7,000 of them). Ids are stored
 * RESOLVED against the page URL, so on a long page URL each block's verdict
 * fills its whole `MAX_BLOCK_ID_CHARS` budget (256 KiB) and sets
 * `idsTruncated`: about 340k characters of verdict per block. A page holds
 * up to 50 blocks. Before the fix the derivation held 500 such verdicts as
 * JSON strings at once (and pg one Bind buffer of the same size), and every
 * per-page rule loaded each selected page's `unresolved` lists whether it
 * read them or not.
 *
 * What is asserted: the verdicts say `idsTruncated`; the "at least" outputs
 * (the rule's `unresolvedAtLeast` on a page with one such block; on a page
 * with two or more, no `schema.unresolved-reference` finding and the
 * listing's `infoCountAtLeast`); and the heap (plus Buffers) the derivation
 * and a non-reference rule hold while they wait on the database, which must not scale with
 * the crawl's blocks.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { ApiService } from "../../src/api/service.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, structuredData } from "../../src/db/schema.js";
import { deriveSchemaValidation } from "../../src/rules/derive/schema-validation.js";
import { schemaValidationRules } from "../../src/rules/query/schema-validation.js";
import { MAX_PROBLEMS_PER_LIST, blockValidationSchema } from "../../src/rules/schema-org/validate.js";
import type { QueryRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { mkDiscovery } from "./mk-discovery.js";
import { mkPage } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

const SITE = "https://schema-hostile.example";
/** A long page URL: every resolved id is about 1,500 characters. */
const pageUrl = (i: number): string => `${SITE}/${"p".repeat(1500)}/${i}`;
const REFERENCES = 7000;
const BLOCKS_PER_PAGE = 50;
const HOSTILE_PAGES = 4;

/** ~100k characters: `REFERENCES` bare references, and one property ItemList does not take. */
const HOSTILE = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  bogusProperty: 1,
  itemListElement: Array.from({ length: REFERENCES }, (_, i) => ({ "@id": `#${i.toString(36)}` })),
};

/**
 * The most live heap (plus Buffers) the derivation may grow by. Bounded, it
 * holds one read batch (`SCHEMA_VALIDATION_READ_CHARS` of raw blocks, parsed)
 * and one write-back (`SCHEMA_VALIDATION_WRITE_CHARS`): measured at 56 MB on
 * this fixture. Unbounded (500 rows, one write-back per batch) it held every
 * block's parsed raw and verdict at once: measured at 195 MB here, growing with
 * the crawl's blocks to about 480 MB at a full batch of 500.
 */
const DERIVE_GROWTH_BOUND_BYTES = 96 * 1024 * 1024;

/**
 * The most live heap a non-reference per-page rule may grow by over these five
 * pages. Without the id lists the verdicts are small: measured at 17 MB.
 * Loading `unresolved` too (256 KiB a block, 50 blocks a page) measured at
 * 84 MB, and grows with every page the listing selects.
 */
const RULE_GROWTH_BOUND_BYTES = 40 * 1024 * 1024;

/**
 * The largest LIVE heap-plus-Buffers growth over the baseline seen while `run`
 * waits on the database. Each sample collects garbage first, so what is
 * measured is what the code holds across its awaits (the batch it read, the
 * verdicts it has not written, the statement being sent), not the garbage
 * one block's validation leaves behind, which made raw `heapUsed` peaks too
 * noisy to bound (128-220 MB for the same run). A sample can only run while
 * the code awaits, which is exactly when its batch and its pending write-back
 * are both held.
 */
async function peakLiveGrowth<T>(run: () => Promise<T>): Promise<{ result: T; growth: number }> {
  const used = (): number => {
    gc();
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const base = used();
  let peak = base;
  const timer = setInterval(() => {
    peak = Math.max(peak, used());
  }, 1);
  try {
    const result = await run();
    return { result, growth: peak - base };
  } finally {
    clearInterval(timer);
  }
}

const rule = (id: string): QueryRule => {
  const r = schemaValidationRules.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no rule '${id}'`);
  return r;
};

describe("a hostile structured-data crawl (29d final review, hard rule 6)", () => {
  let db: Db;
  let service: ApiService;
  let exportDir: string;
  const crawlId = `crawl_sd_hostile_${randomUUID()}`;

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
    exportDir = await mkdtemp(join(tmpdir(), "ariadne-sd-hostile-"));
    service = new ApiService(db, { credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], exportDir, log: () => {} });
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id: crawlId,
      siteUrl: `${SITE}/`,
      hostKey: hostKeyOf(`${SITE}/`),
      config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
      discovery: mkDiscovery(),
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: HOSTILE_PAGES + 1,
    });
    // Pages 0..HOSTILE_PAGES-1 hold 50 hostile blocks; the last holds one.
    for (let i = 0; i <= HOSTILE_PAGES; i++) {
      const pageId = `page_${randomUUID()}`;
      await db.insert(pages).values(
        mkPage({ id: pageId, crawlId, url: pageUrl(i), urlNormalised: pageUrl(i), extractionVersion: 4 }),
      );
      const blocks = i < HOSTILE_PAGES ? BLOCKS_PER_PAGE : 1;
      for (let b = 0; b < blocks; b += 10) {
        await db.insert(structuredData).values(
          Array.from({ length: Math.min(10, blocks - b) }, () => ({
            crawlId,
            pageId,
            schemaType: "ItemList",
            format: "jsonld" as const,
            raw: HOSTILE,
          })),
        );
      }
    }
  }, 120_000);

  afterAll(async () => {
    await db.delete(crawls).where(eq(crawls.id, crawlId));
    await rm(exportDir, { recursive: true, force: true });
    await closeDb(db);
  });

  it("derives every block within a bounded heap, each verdict saying idsTruncated", async () => {
    const { result, growth } = await peakLiveGrowth(() => deriveSchemaValidation(db, crawlId));
    expect(result).toEqual({ blocks: HOSTILE_PAGES * BLOCKS_PER_PAGE + 1, orphanBlocks: 0 });
    expect(growth).toBeLessThan(DERIVE_GROWTH_BOUND_BYTES);

    const verdicts = await db.execute<{ truncated: string; count: number; listed: number; n: number }>(sql`
      select validation_jsonb ->> 'idsTruncated' as truncated,
             (validation_jsonb ->> 'unresolvedCount')::int as count,
             jsonb_array_length(validation_jsonb -> 'unresolved') as listed,
             count(*)::int as n
        from structured_data where crawl_id = ${crawlId}
       group by 1, 2, 3`);
    // Every block alike: truncated, the exact count of its references, fewer listed.
    expect(verdicts.rows).toHaveLength(1);
    const v = verdicts.rows[0]!;
    expect(v).toMatchObject({ truncated: "true", count: REFERENCES, n: HOSTILE_PAGES * BLOCKS_PER_PAGE + 1 });
    expect(v.listed).toBeGreaterThan(MAX_PROBLEMS_PER_LIST);
    expect(v.listed).toBeLessThan(REFERENCES);
    const one = await db.execute<{ v: unknown }>(sql`
      select validation_jsonb as v from structured_data where crawl_id = ${crawlId} limit 1`);
    expect(() => blockValidationSchema.parse(one.rows[0]!.v)).not.toThrow();
  }, 120_000);

  it("a rule that does not read the ids loads none of them: bounded heap, every page found", async () => {
    const { result, growth } = await peakLiveGrowth(() => rule("schema.unknown-property").run(db, crawlId));
    expect(result.map((f) => f.pageUrl).sort()).toEqual(
      Array.from({ length: HOSTILE_PAGES + 1 }, (_, i) => pageUrl(i)).sort(),
    );
    expect(growth).toBeLessThan(RULE_GROWTH_BOUND_BYTES);
  }, 120_000);

  it("unresolved-reference: the one-block page counts at least; a page of truncated blocks has no finding", async () => {
    const found = await rule("schema.unresolved-reference").run(db, crawlId);
    // Pages with 50 truncated blocks: any of the others could define a block's
    // ids, so nothing is counted and no finding is filed.
    expect(found.map((f) => f.pageUrl)).toEqual([pageUrl(HOSTILE_PAGES)]);
    const evidence = found[0]!.evidence;
    expect(evidence).toMatchObject({ unresolvedAtLeast: true, problemsCapped: true });
    expect((evidence["unresolved"] as string[]).length).toBe(MAX_PROBLEMS_PER_LIST);
    expect(evidence["unresolvedCount"] as number).toBeGreaterThan(MAX_PROBLEMS_PER_LIST);
    expect(evidence["unresolvedCount"] as number).toBeLessThan(REFERENCES);
  }, 120_000);

  it("the listing says infoCountAtLeast on every page, the truncated-block pages included", async () => {
    // The listing answers only a judged crawl: judge it the real way.
    await service.runRulesForCrawl(LOCAL_TENANT, crawlId);
    const listing = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    expect(listing.items).toHaveLength(HOSTILE_PAGES + 1);
    for (const row of listing.items) {
      expect(row.infoCountAtLeast, row.url.slice(-2)).toBe(true);
    }
    const last = listing.items.find((r) => r.url === pageUrl(HOSTILE_PAGES))!;
    expect(last.infoCount).toBeGreaterThan(MAX_PROBLEMS_PER_LIST);
  }, 120_000);
});

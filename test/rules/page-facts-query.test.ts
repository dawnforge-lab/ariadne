/**
 * The v2 extraction gate and its NOT MEASURED marker (Phase 26b, Task 5).
 *
 * Rows are inserted directly: what is under test is what the gate and the marker
 * make of `pages.extraction_version`, not the crawling.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import {
  pageFactsRules,
  sitemapFactsRecorded,
  v2Gate,
  v3Gate,
} from "../../src/rules/query/page-facts.js";
import type { QueryRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://facts.example";
const SITEMAP_FACTS = {
  memberships: 0,
  membershipLimited: false,
  hreflangRows: 0,
  hreflangLimited: false,
  overlongLocsSkipped: 0,
  oversizedDocs: [],
};
const MARKER_ID = "extraction.not-recorded";

function marker(): QueryRule {
  const r = pageFactsRules.find((x) => x.id === MARKER_ID);
  if (!r) throw new Error(`no rule '${MARKER_ID}' in pageFactsRules`);
  return r;
}

interface PageSpec {
  url: string;
  extractionVersion: number | null;
  statusCode?: number;
}

describe("extraction.not-recorded and v2Gate", () => {
  let db: Db;
  const created: string[] = [];

  /**
   * A crawl row; by default its discovery recorded `sitemapFacts` (a 26c crawl),
   * so only the page stamps decide. `sitemapFacts: false` writes discovery as a
   * pre-26c crawl did, without the key.
   */
  async function newCrawl(opts: { sitemapFacts?: boolean } = {}): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    const discovery =
      opts.sitemapFacts === false ? { docsFetched: 0 } : { docsFetched: 0, sitemapFacts: SITEMAP_FACTS };
    await db
      .insert(crawls)
      .values({ id, tenantId: LOCAL_TENANT, siteUrl: SITE, hostKey: hostKeyOf(SITE), config: {}, rulesetVersion: "test", discovery });
    created.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    await db.insert(pages).values(
      specs.map((s) => ({
        id: `page_${randomUUID()}`,
        crawlId,
        url: s.url,
        urlNormalised: s.url.toLowerCase(),
        fetchClass: "ok",
        statusCode: s.statusCode ?? 200,
        extractionVersion: s.extractionVersion,
        depth: 1,
        discoveredVia: "link",
      })),
    );
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("is the only rule of the file and is a marker", () => {
    expect(pageFactsRules.map((r) => r.id)).toEqual([MARKER_ID]);
    const r = marker();
    expect(r.severity).toBe("info");
    expect(r.category).toBe("crawl");
    expect(r.marker).toBe(
      "This crawl was extracted before the page and sitemap facts these checks read existed, so they were not run; re-crawl the site.",
    );
    expect(r.checkIds).toEqual([
      "CHECK-04", "CHECK-08", "CHECK-10", "CHECK-18", "CHECK-22", "CHECK-24", "CHECK-25",
      "CHECK-28", "CHECK-34", "CHECK-35", "CHECK-36", "CHECK-37", "CHECK-49", "CHECK-85",
      "CHECK-86", "CHECK-87", "CHECK-88",
    ]);
  });

  it("a pre-bump crawl (every page at version 1) gets the marker and a closed gate (review focus 1)", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [
      { url: `${SITE}/a`, extractionVersion: 1 },
      { url: `${SITE}/b`, extractionVersion: 1 },
    ]);
    expect(await v2Gate(db, crawl)).toEqual({ recorded: false, atOrAbove: 0, below: 2 });
    const findings = await marker().run(db, crawl);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: MARKER_ID,
      severity: "info",
      pageId: null,
      pageUrl: null,
      dedupeKey: "site",
      evidence: { pagesNotRecorded: 2, pagesRecorded: 0, requiredVersion: 3, sitemapFactsRecorded: true },
    });
  });

  it("a crawl with null stamps (before Phase 25) is below version 2 too", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [{ url: `${SITE}/a`, extractionVersion: null }]);
    expect((await marker().run(db, crawl)).map((f) => f.evidence)).toEqual([
      { pagesNotRecorded: 1, pagesRecorded: 0, requiredVersion: 3, sitemapFactsRecorded: true },
    ]);
  });

  it("a mixed v1/v2 crawl closes v2Gate with one page on each side; the marker counts against 3", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [
      { url: `${SITE}/old`, extractionVersion: 1 },
      { url: `${SITE}/new`, extractionVersion: 2 },
    ]);
    expect(await v2Gate(db, crawl)).toEqual({ recorded: false, atOrAbove: 1, below: 1 });
    expect((await marker().run(db, crawl)).map((f) => f.evidence)).toEqual([
      { pagesNotRecorded: 2, pagesRecorded: 0, requiredVersion: 3, sitemapFactsRecorded: true },
    ]);
  });

  it("a v2-only crawl keeps v2Gate open, closes v3Gate and fires the marker", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [
      { url: `${SITE}/a`, extractionVersion: 2 },
      { url: `${SITE}/b`, extractionVersion: 2 },
    ]);
    expect(await v2Gate(db, crawl)).toEqual({ recorded: true, atOrAbove: 2, below: 0 });
    expect(await v3Gate(db, crawl)).toEqual({ recorded: false, atOrAbove: 0, below: 2 });
    expect((await marker().run(db, crawl)).map((f) => f.evidence)).toEqual([
      { pagesNotRecorded: 2, pagesRecorded: 0, requiredVersion: 3, sitemapFactsRecorded: true },
    ]);
  });

  it("an all-v3 crawl is silent and both gates are open", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [
      { url: `${SITE}/a`, extractionVersion: 3 },
      { url: `${SITE}/b`, extractionVersion: 3 },
    ]);
    expect(await v2Gate(db, crawl)).toEqual({ recorded: true, atOrAbove: 2, below: 0 });
    expect(await v3Gate(db, crawl)).toEqual({ recorded: true, atOrAbove: 2, below: 0 });
    expect(await marker().run(db, crawl)).toEqual([]);
  });

  it("a mixed v2/v3 crawl fires and v3Gate is closed", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [
      { url: `${SITE}/old`, extractionVersion: 2 },
      { url: `${SITE}/new`, extractionVersion: 3 },
    ]);
    expect(await v3Gate(db, crawl)).toEqual({ recorded: false, atOrAbove: 1, below: 1 });
    expect((await marker().run(db, crawl)).map((f) => f.evidence)).toEqual([
      { pagesNotRecorded: 1, pagesRecorded: 1, requiredVersion: 3, sitemapFactsRecorded: true },
    ]);
  });

  it("an empty crawl is silent", async () => {
    const crawl = await newCrawl();
    expect(await v2Gate(db, crawl)).toEqual({ recorded: true, atOrAbove: 0, below: 0 });
    expect(await v3Gate(db, crawl)).toEqual({ recorded: true, atOrAbove: 0, below: 0 });
    expect(await marker().run(db, crawl)).toEqual([]);
  });

  it("stays quiet when no page was fetched OK (nothing to have judged)", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [{ url: `${SITE}/gone`, extractionVersion: 1, statusCode: 404 }]);
    expect(await marker().run(db, crawl)).toEqual([]);
  });

  // Ruling R1: the marker also speaks for the sitemap facts discovery records
  // from Phase 26c on (`discovery_jsonb.sitemapFacts`).
  it("an all-v3 crawl whose discovery predates sitemapFacts fires, with no stale pages", async () => {
    const crawl = await newCrawl({ sitemapFacts: false });
    await addPages(crawl, [{ url: `${SITE}/a`, extractionVersion: 3 }]);
    expect(await sitemapFactsRecorded(db, crawl)).toBe(false);
    expect((await marker().run(db, crawl)).map((f) => f.evidence)).toEqual([
      { pagesNotRecorded: 0, pagesRecorded: 1, requiredVersion: 3, sitemapFactsRecorded: false },
    ]);
  });

  it("an all-v3 crawl with sitemapFacts is silent", async () => {
    const crawl = await newCrawl();
    await addPages(crawl, [{ url: `${SITE}/a`, extractionVersion: 3 }]);
    expect(await sitemapFactsRecorded(db, crawl)).toBe(true);
    expect(await marker().run(db, crawl)).toEqual([]);
  });

  it("a v2 crawl without sitemapFacts fires for both", async () => {
    const crawl = await newCrawl({ sitemapFacts: false });
    await addPages(crawl, [
      { url: `${SITE}/a`, extractionVersion: 2 },
      { url: `${SITE}/b`, extractionVersion: 2 },
    ]);
    expect((await marker().run(db, crawl)).map((f) => f.evidence)).toEqual([
      { pagesNotRecorded: 2, pagesRecorded: 0, requiredVersion: 3, sitemapFactsRecorded: false },
    ]);
  });

  it("a crawl with no discovery at all has no sitemapFacts, and fires even with no pages", async () => {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ tenantId: LOCAL_TENANT, id, siteUrl: SITE, hostKey: hostKeyOf(SITE), config: {}, rulesetVersion: "test" });
    created.push(id);
    expect(await sitemapFactsRecorded(db, id)).toBe(false);
    expect((await marker().run(db, id)).map((f) => f.evidence)).toEqual([
      { pagesNotRecorded: 0, pagesRecorded: 0, requiredVersion: 3, sitemapFactsRecorded: false },
    ]);
  });

  it("sitemapFactsRecorded throws for a crawl nothing knows", async () => {
    await expect(sitemapFactsRecorded(db, `crawl_${randomUUID()}`)).rejects.toThrow(
      /no such crawl/,
    );
  });

  it("throws for a crawl nothing knows, rather than reading it as clean", async () => {
    await expect(marker().run(db, `crawl_${randomUUID()}`)).rejects.toThrow(/no such crawl/);
  });
});

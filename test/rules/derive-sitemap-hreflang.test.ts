/**
 * The sitemap hreflang derivation, against a real database.
 *
 * Discovery stages every `xhtml:link` alternate a sitemap `<url>` carries in
 * `sitemap_hreflang` (Phase 26c Task 8), keyed by the `<loc>`, because the page
 * it describes may not exist yet. The derivation is what ties a staged row to
 * the page the crawl created, as an `hreflang` row with `source = 'sitemap'`,
 * so every hreflang rule reads the sitemap's annotations the way it reads the
 * page's own. Under test: which staged rows become `hreflang` rows, that the
 * duplicates discovery stages never become two, that a re-run replaces rather
 * than adds, and that nothing else (another source, another crawl, the staging
 * table) is touched.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, pages, sitemapHreflang } from "../../src/db/schema.js";
import { deriveSitemapHreflang } from "../../src/rules/derive/sitemap-hreflang.js";
import { mkDiscovery } from "./mk-discovery.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://sitemap-hreflang.example";
const url = (path: string): string => `${SITE}${path}`;
const SITEMAP = url("/sitemap.xml");

describe("deriveSitemapHreflang against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, paths: string[]): Promise<Map<string, string>> {
    const rows = paths.map((path) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(path),
      urlNormalised: url(path).toLowerCase(),
      fetchClass: "ok",
      statusCode: 200,
      isIndexable: true,
      depth: 1,
      discoveredVia: "sitemap",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [paths[i]!, r.id]));
  }

  /**
   * Stage one `<url>`'s alternates as discovery writes them: `url` is the
   * `<loc>` as published, `url_normalised` the frontier spelling it joins on.
   */
  async function stage(
    crawlId: string,
    loc: { published: string; normalised: string },
    alternates: Array<[code: string, target: string]>,
    sitemapSource = SITEMAP,
  ): Promise<void> {
    await db.insert(sitemapHreflang).values(
      alternates.map(([code, target]) => ({
        crawlId,
        url: loc.published,
        urlNormalised: loc.normalised,
        hreflangCode: code,
        targetUrl: url(target),
        sitemapSource,
      })),
    );
  }
  const at = (path: string) => ({ published: url(path), normalised: url(path) });

  async function rows(crawlId: string, source?: string) {
    const found = await db
      .select()
      .from(hreflang)
      .where(
        source === undefined
          ? eq(hreflang.crawlId, crawlId)
          : and(eq(hreflang.crawlId, crawlId), eq(hreflang.source, source)),
      )
      .orderBy(asc(hreflang.pageId), asc(hreflang.hreflangCode), asc(hreflang.targetUrl));
    return found.map((r) => ({
      pageId: r.pageId,
      code: r.hreflangCode,
      target: r.targetUrl,
      targetPageId: r.targetPageId,
      source: r.source,
    }));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("turns the staged alternates of a crawled URL into sitemap rows tied to its page", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, ["/en", "/de"]);
    await stage(crawlId, at("/en"), [
      ["en", "/en"],
      ["de", "/de"],
      ["x-default", "/en"],
    ]);

    expect(await deriveSitemapHreflang(db, crawlId)).toEqual({ rows: 3 });
    expect(await rows(crawlId)).toEqual([
      { pageId: ids.get("/en"), code: "de", target: url("/de"), targetPageId: null, source: "sitemap" },
      { pageId: ids.get("/en"), code: "en", target: url("/en"), targetPageId: null, source: "sitemap" },
      { pageId: ids.get("/en"), code: "x-default", target: url("/en"), targetPageId: null, source: "sitemap" },
    ]);
  });

  it("joins on the normalised <loc>, the spelling the frontier gave the page", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, ["/q?a=1&b=2"]);
    // The sitemap published the URL with a fragment and its query unsorted;
    // the page row the crawl made of it is the `normalizeUrl` spelling.
    await stage(crawlId, { published: url("/q?b=2&a=1#top"), normalised: url("/q?a=1&b=2") }, [
      ["fr", "/fr/q"],
    ]);

    expect(await deriveSitemapHreflang(db, crawlId)).toEqual({ rows: 1 });
    expect((await rows(crawlId)).map((r) => r.pageId)).toEqual([ids.get("/q?a=1&b=2")]);
  });

  it("writes one row for a pair staged twice, in one document or in two", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/en"]);
    // One document listing the URL twice stages its alternates twice; a second
    // document stating the same pair stages it a third time.
    await stage(crawlId, at("/en"), [["de", "/de"]]);
    await stage(crawlId, at("/en"), [["de", "/de"]]);
    await stage(crawlId, at("/en"), [["de", "/de"]], url("/sitemap-2.xml"));

    expect(await deriveSitemapHreflang(db, crawlId)).toEqual({ rows: 1 });
    expect(await rows(crawlId)).toHaveLength(1);
  });

  it("writes nothing for a URL the crawl has no page for, and leaves it staged", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/en"]);
    await stage(crawlId, at("/never-crawled"), [["de", "/de"]]);

    expect(await deriveSitemapHreflang(db, crawlId)).toEqual({ rows: 0 });
    expect(await rows(crawlId)).toEqual([]);
    expect(
      await db.select().from(sitemapHreflang).where(eq(sitemapHreflang.crawlId, crawlId)),
    ).toHaveLength(1);
  });

  it("is idempotent: a second run leaves the same rows", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/en", "/de"]);
    await stage(crawlId, at("/en"), [
      ["en", "/en"],
      ["de", "/de"],
    ]);
    await stage(crawlId, at("/de"), [
      ["en", "/en"],
      ["de", "/de"],
    ]);

    const first = await deriveSitemapHreflang(db, crawlId);
    const afterFirst = await rows(crawlId);
    const second = await deriveSitemapHreflang(db, crawlId);

    expect(first).toEqual({ rows: 4 });
    expect(second).toEqual(first);
    expect(await rows(crawlId)).toEqual(afterFirst);
  });

  it("replaces only the sitemap rows: the HTML and header rows are untouched", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, ["/en"]);
    const pageId = ids.get("/en")!;
    await db.insert(hreflang).values([
      { crawlId, pageId, hreflangCode: "fr", targetUrl: url("/fr"), targetPageId: null, source: "html" },
      { crawlId, pageId, hreflangCode: "it", targetUrl: url("/it"), targetPageId: null, source: "header" },
      // A sitemap row from an earlier derivation whose alternate is gone now.
      { crawlId, pageId, hreflangCode: "es", targetUrl: url("/es"), targetPageId: null, source: "sitemap" },
    ]);
    await stage(crawlId, at("/en"), [["de", "/de"]]);

    expect(await deriveSitemapHreflang(db, crawlId)).toEqual({ rows: 1 });
    expect((await rows(crawlId)).map((r) => [r.code, r.source])).toEqual([
      ["de", "sitemap"],
      ["fr", "html"],
      ["it", "header"],
    ]);
  });

  it("is scoped to one crawl: deriving mine does not read or delete yours", async () => {
    const mine = await newCrawl();
    const yours = await newCrawl();
    await addPages(mine, ["/en"]);
    await addPages(yours, ["/en"]);
    await stage(mine, at("/en"), [["de", "/de"]]);
    await stage(yours, at("/en"), [["fr", "/fr"]]);

    await deriveSitemapHreflang(db, yours);
    await deriveSitemapHreflang(db, mine);

    expect((await rows(mine)).map((r) => r.code)).toEqual(["de"]);
    expect((await rows(yours)).map((r) => r.code)).toEqual(["fr"]);
  });

  it("refuses a crawl id nothing knows rather than reporting zero rows", async () => {
    await expect(deriveSitemapHreflang(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
  });
});

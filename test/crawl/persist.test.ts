import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  crawls,
  hreflang,
  links,
  pages,
  structuredData,
} from "../../src/db/schema.js";
import { PageWriter } from "../../src/crawl/persist.js";
import type { FetchResult } from "../../src/crawl/fetch-page.js";
import type { PageAnalysis } from "../../src/crawl/parse/page-analyzer.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://s.example";

function makeAnalysis(overrides: Partial<PageAnalysis> = {}): PageAnalysis {
  return {
    title: "A title",
    metaDescription: "A description",
    canonicalHtml: `${SITE}/a`,
    canonicalCount: 1,
    robotsMeta: null,
    ogTitle: "og title",
    ogDescription: "og description",
    ogImage: `${SITE}/og.png`,
    headingCounts: [1, 2, 0, 0, 0, 0],
    headingOrder: [1, 2, 2],
    wordCount: 420,
    imagesTotal: 3,
    imagesMissingAlt: 1,
    hasAmp: false,
    links: [
      { href: `${SITE}/one`, anchor: "one", rel: null, nofollow: false, position: 0 },
      {
        href: `${SITE}/two`,
        anchor: "two",
        rel: "nofollow",
        nofollow: true,
        position: 1,
      },
      {
        href: "https://other.example/three",
        anchor: "three",
        rel: null,
        nofollow: false,
        position: 2,
      },
    ],
    relNext: `${SITE}/page/2`,
    relPrev: null,
    domSize: 120,
    textRatio: 0.31,
    hreflang: [
      { code: "en", href: "/en/a" },
      { code: "fr", href: "https://s.example/fr/a" },
    ],
    structuredData: [{ type: "Article", raw: { "@type": "Article", name: "n" } }],
    structuredDataParseErrors: 0,
    contentHash: "a".repeat(64),
    simhash: 1234567890123n,
    ...overrides,
  };
}

function makeFetch(url: string, overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    url,
    statusCode: 200,
    fetchClass: "ok",
    contentType: "text/html; charset=utf-8",
    redirectUrl: null,
    body: "<html></html>",
    htmlBytes: 4096,
    responseTimeMs: 87,
    canonicalHeader: null,
    xRobotsTag: null,
    disallowedReason: null,
    ...overrides,
  };
}

const item = (url: string, depth = 1, discoveredVia = "link") => ({
  url,
  depth,
  discoveredVia,
});

describe("PageWriter", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
    });
    createdCrawls.push(id);
    return id;
  }

  async function countOf(
    table: typeof pages | typeof links | typeof hreflang | typeof structuredData,
    crawlId: string,
  ): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.crawlId, crawlId));
    return rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
    await closeDb(db);
  });

  it("writes every buffered row for a 250-page crawl", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId, { batchSize: 100 });
    for (let i = 0; i < 250; i++) {
      const url = `${SITE}/p/${i}`;
      await writer.addPage(item(url), makeFetch(url), makeAnalysis());
    }
    await writer.flush();

    expect(await countOf(pages, crawlId)).toBe(250);
    expect(await countOf(links, crawlId)).toBe(750);
    expect(await countOf(hreflang, crawlId)).toBe(500);
    expect(await countOf(structuredData, crawlId)).toBe(250);
  });

  it("never lets a buffer exceed batchSize, even for one link-heavy page", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId, { batchSize: 100 });
    const many = Array.from({ length: 250 }, (_, i) => ({
      href: `${SITE}/l/${i}`,
      anchor: `l${i}`,
      rel: null,
      nofollow: false,
      position: i,
    }));
    const url = `${SITE}/hub`;
    await writer.addPage(item(url), makeFetch(url), makeAnalysis({ links: many }));

    // 250 link rows with batchSize 100 means two full batches already went to
    // the database *inside* addPage; only the 50-row remainder is still held.
    expect(await countOf(links, crawlId)).toBe(200);
    await writer.flush();
    expect(await countOf(links, crawlId)).toBe(250);
  });

  it("computes is_indexable from status, class and both robots signals", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const cases: Array<[string, FetchResult, PageAnalysis | null, boolean]> = [
      [`${SITE}/ok`, makeFetch(`${SITE}/ok`), makeAnalysis(), true],
      [
        `${SITE}/meta-noindex`,
        makeFetch(`${SITE}/meta-noindex`),
        makeAnalysis({ robotsMeta: "noindex,follow" }),
        false,
      ],
      [
        `${SITE}/meta-noindex-cased`,
        makeFetch(`${SITE}/meta-noindex-cased`),
        makeAnalysis({ robotsMeta: "NoIndex" }),
        false,
      ],
      [
        `${SITE}/header-noindex`,
        makeFetch(`${SITE}/header-noindex`, { xRobotsTag: "noindex" }),
        makeAnalysis(),
        false,
      ],
      [
        `${SITE}/404`,
        makeFetch(`${SITE}/404`, {
          statusCode: 404,
          fetchClass: "client_error",
          body: null,
        }),
        null,
        false,
      ],
      [
        `${SITE}/301`,
        makeFetch(`${SITE}/301`, {
          statusCode: 301,
          fetchClass: "redirect",
          body: null,
          redirectUrl: `${SITE}/ok`,
        }),
        null,
        false,
      ],
    ];
    for (const [url, fetch, analysis] of cases) {
      await writer.addPage(item(url), fetch, analysis);
    }
    await writer.flush();

    const rows = await db
      .select({ url: pages.url, isIndexable: pages.isIndexable })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r.isIndexable]));
    for (const [url, , , expected] of cases) {
      expect(byUrl.get(url), `is_indexable for ${url}`).toBe(expected);
    }
  });

  it("stores a high-bit simhash as a signed bigint that round-trips", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const unsigned = 0xf0e1d2c3b4a59687n; // high bit set
    const url = `${SITE}/simhash`;
    await writer.addPage(
      item(url),
      makeFetch(url),
      makeAnalysis({ simhash: unsigned }),
    );
    await writer.flush();

    const [row] = await db
      .select({ simhash: pages.simhash })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(row?.simhash).toBe(BigInt.asIntN(64, unsigned));
    expect(row!.simhash! < 0n).toBe(true);
    expect(BigInt.asUintN(64, row!.simhash!)).toBe(unsigned);
  });

  it("persists the structured-data parse-error count", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/bad-jsonld`;
    await writer.addPage(
      item(url),
      makeFetch(url),
      makeAnalysis({ structuredData: [], structuredDataParseErrors: 3 }),
    );
    await writer.flush();

    const [row] = await db
      .select({ errors: pages.structuredDataParseErrors })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(row?.errors).toBe(3);
  });

  it("resolves hreflang hrefs against the page URL and counts the unresolvable", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/de/seite`;
    await writer.addPage(
      item(url),
      makeFetch(url),
      makeAnalysis({
        hreflang: [
          { code: "en", href: "../en/page" },
          { code: "fr", href: "https://s.example/fr/page" },
          { code: "es", href: "http://[bad" },
        ],
      }),
    );
    await writer.flush();

    const rows = await db
      .select({ code: hreflang.hreflangCode, target: hreflang.targetUrl })
      .from(hreflang)
      .where(eq(hreflang.crawlId, crawlId));
    expect(rows).toHaveLength(2);
    const byCode = new Map(rows.map((r) => [r.code, r.target]));
    expect(byCode.get("en")).toBe(`${SITE}/en/page`);
    expect(byCode.get("fr")).toBe(`${SITE}/fr/page`);
    expect(writer.stats().hreflangUnresolved).toBe(1);
  });

  it("records link rows exactly as the analyzer deduped them, internal flag included", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/links`;
    const pageId = await writer.addPage(item(url), makeFetch(url), makeAnalysis());
    await writer.flush();

    const rows = await db
      .select({
        sourcePageId: links.sourcePageId,
        targetUrl: links.targetUrl,
        anchor: links.anchor,
        isInternal: links.isInternal,
        isNofollow: links.isNofollow,
        position: links.position,
      })
      .from(links)
      .where(eq(links.crawlId, crawlId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.sourcePageId === pageId)).toBe(true);
    const byTarget = new Map(rows.map((r) => [r.targetUrl, r]));
    expect(byTarget.get(`${SITE}/one`)?.isInternal).toBe(true);
    expect(byTarget.get(`${SITE}/two`)?.isNofollow).toBe(true);
    expect(byTarget.get("https://other.example/three")?.isInternal).toBe(false);
    expect(byTarget.get("https://other.example/three")?.position).toBe(2);
  });

  it("writes the fetch-side columns and a normalised url", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/Mixed/Case/?b=2&a=1`;
    await writer.addPage(item(url, 2, "sitemap"), makeFetch(url), makeAnalysis());
    await writer.flush();

    const [row] = await db
      .select()
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(row?.url).toBe(url);
    expect(row?.urlNormalised).toBe("https://s.example/mixed/case/?a=1&b=2");
    expect(row?.depth).toBe(2);
    expect(row?.discoveredVia).toBe("sitemap");
    expect(row?.pageType).toBe("/Mixed/Case");
    expect(row?.responseTimeMs).toBe(87);
    expect(row?.htmlBytes).toBe(4096);
    expect(row?.contentType).toBe("text/html; charset=utf-8");
    expect(row?.headingOrder).toEqual([1, 2, 2]);
    expect(row?.textRatio).toBeCloseTo(0.31, 5);
    expect(row?.relNext).toBe(`${SITE}/page/2`);
    expect(row?.h2Count).toBe(2);
  });

  it("strips a trailing slash from url_normalised", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    for (const url of [`${SITE}/x/`, `${SITE}/`]) {
      await writer.addPage(item(url), makeFetch(url), makeAnalysis());
    }
    await writer.flush();

    const rows = await db
      .select({ url: pages.url, normalised: pages.urlNormalised })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r.normalised]));
    expect(byUrl.get(`${SITE}/x/`)).toBe("https://s.example/x");
    expect(byUrl.get(`${SITE}/`)).toBe("https://s.example");
  });

  it("applies client page-type patterns when given", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId, {
      pageTypePatterns: [{ pattern: "/products/", pageType: "product" }],
    });
    const url = `${SITE}/products/blue-widget`;
    await writer.addPage(item(url), makeFetch(url), makeAnalysis());
    await writer.flush();

    const [row] = await db
      .select({ pageType: pages.pageType })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(row?.pageType).toBe("product");
  });

  it("writes a row with no analysis and no child rows", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/gone`;
    await writer.addPage(
      item(url),
      makeFetch(url, {
        statusCode: 404,
        fetchClass: "client_error",
        body: null,
        contentType: "text/html",
      }),
      null,
    );
    await writer.flush();

    const [row] = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(row?.fetchClass).toBe("client_error");
    expect(row?.statusCode).toBe(404);
    expect(row?.title).toBeNull();
    expect(row?.simhash).toBeNull();
    expect(row?.structuredDataParseErrors).toBe(0);
    expect(await countOf(links, crawlId)).toBe(0);
    expect(await countOf(hreflang, crawlId)).toBe(0);
    expect(await countOf(structuredData, crawlId)).toBe(0);
  });

  it("ignores a second row for the same (crawl, url)", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/twice`;
    await writer.addPage(item(url), makeFetch(url), null);
    await writer.addPage(item(url), makeFetch(url), null);
    await writer.flush();
    expect(await countOf(pages, crawlId)).toBe(1);
  });

  it("flush is idempotent and reports what it wrote", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/flush`;
    await writer.addPage(item(url), makeFetch(url), makeAnalysis());
    await writer.flush();
    await writer.flush();
    await writer.flush();

    expect(await countOf(pages, crawlId)).toBe(1);
    expect(await countOf(links, crawlId)).toBe(3);
    expect(writer.stats()).toEqual({
      pages: 1,
      links: 3,
      hreflang: 2,
      structuredData: 1,
      hreflangUnresolved: 0,
    });
  });
});

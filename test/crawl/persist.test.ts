import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  crawls,
  hreflang,
  links,
  pageResources,
  pages,
  resources,
  structuredData,
} from "../../src/db/schema.js";
import { PageWriter } from "../../src/crawl/persist.js";
import { EXTRACTION_VERSION } from "../../src/crawl/versions.js";
import {
  enqueueUrls,
  failUrl,
  frontierCounts,
  leaseBatch,
} from "../../src/crawl/frontier.js";
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
    h1Text: "A heading",
    wordCount: 420,
    // Below the raw count, as it always is: the analyzer's two streams share
    // every element boundary and the renderable one carries less text.
    renderableWordCount: 380,
    imagesTotal: 3,
    imagesMissingAlt: 1,
    imagesMissingDimensions: 0,
    hasAmp: false,
    hasViewport: false,
    hasLoremIpsum: false,
    hasSoft404Phrases: false,
    navLinkCount: 7,
    footerLinkCount: 4,
    frameworkMarkers: ["__NEXT_DATA__"],
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
    // Two files every page in this suite references, so the resource path is
    // exercised by every existing case as well as by its own.
    resourceRefs: [
      { url: `${SITE}/img/logo.png`, kind: "image" },
      { url: `${SITE}/css/site.css`, kind: "css" },
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
    resourceRefsCapped: false,
    contentHash: "a".repeat(64),
    simhash: 1234567890123n,
    // The main-content pair (P19-T1): a page with real content of its own, so
    // both are set and the word count is under the raw one — this analysis's
    // page has chrome, like every page. A test about the null contract
    // overrides BOTH, since they are one measurement reported twice.
    mainSimhash: 9876543210987n,
    mainWordCount: 260,
    // Null because `hasLoremIpsum` above is false: the two move together.
    placeholderSnippet: null,
    // Where the head ended (P23-T5): closed by `</head>`, nothing after it.
    headClosedBy: null,
    titleOutsideHead: false,
    metaDescriptionOutsideHead: false,
    robotsOutsideHead: false,
    canonicalOutsideHead: false,
    hreflangOutsideHeadCount: 0,
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
    retryAfterMs: null,
    canonicalHeader: null,
    xRobotsTag: null,
    platformHint: null,
    responseHeaders: null,
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
    table:
      | typeof pages
      | typeof links
      | typeof hreflang
      | typeof structuredData
      | typeof resources
      | typeof pageResources,
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
      await writer.addPage(item(url), makeFetch(url), makeAnalysis(), { complete: true });
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
    await writer.addPage(item(url), makeFetch(url), makeAnalysis({ links: many }), {
      complete: true,
    });

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
      // `none` is Google's shorthand for "noindex, nofollow". The page is out of
      // the index, so is_indexable must say so — and the rule layer's
      // `saysNoindex` agrees (see src/rules/page/indexability.ts).
      [
        `${SITE}/meta-none`,
        makeFetch(`${SITE}/meta-none`),
        makeAnalysis({ robotsMeta: "none" }),
        false,
      ],
      [
        `${SITE}/header-none`,
        makeFetch(`${SITE}/header-none`, { xRobotsTag: "NONE, noarchive" }),
        makeAnalysis(),
        false,
      ],
      // ...matched as a whole token only: a word that merely contains "none" is
      // not the directive, and the page stays indexable.
      [
        `${SITE}/meta-nonevent`,
        makeFetch(`${SITE}/meta-nonevent`),
        makeAnalysis({ robotsMeta: "nonevent" }),
        true,
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
      await writer.addPage(item(url), fetch, analysis, { complete: true });
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
      { complete: true },
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
      { complete: true },
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
      { complete: true },
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
    const pageId = await writer.addPage(item(url), makeFetch(url), makeAnalysis(), {
      complete: true,
    });
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
    await writer.addPage(item(url, 2, "sitemap"), makeFetch(url), makeAnalysis(), {
      complete: true,
    });
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

  it("stamps extraction_version 1 on every row it writes, a robots-blocked row included", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    await writer.addPage(item(`${SITE}/a`), makeFetch(`${SITE}/a`), makeAnalysis(), {
      complete: true,
    });
    await writer.addPage(item(`${SITE}/b`), makeFetch(`${SITE}/b`, { statusCode: 404, fetchClass: "client_error", body: null }), null, {
      complete: true,
    });
    await writer.flush();
    await writer.insertRobotsBlocked([
      { item: item(`${SITE}/blocked`), reason: "robots.txt: Disallow: /blocked" },
    ]);

    const rows = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(rows).toHaveLength(3);
    expect(EXTRACTION_VERSION).toBe(1);
    for (const row of rows) expect(row.extractionVersion, row.url).toBe(1);
    const blocked = rows.find((r) => r.url === `${SITE}/blocked`);
    expect(blocked?.fetchClass).toBe("disallowed");
    expect(blocked?.responseHeaders).toBeNull();
    // render_version belongs to the render writer, never this one.
    for (const row of rows) expect(row.renderVersion, row.url).toBeNull();
  });

  it("writes response_headers verbatim", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const responseHeaders = {
      values: {
        link: ["<a>; rel=x", "<b>; rel=y"],
        "content-type": ["text/html; charset=utf-8"],
      },
      truncated: ["content-security-policy"],
    };
    const url = `${SITE}/h`;
    await writer.addPage(item(url), makeFetch(url, { responseHeaders }), makeAnalysis(), {
      complete: true,
    });
    await writer.flush();
    const [row] = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(row?.responseHeaders).toEqual(responseHeaders);
  });

  // `fetched_at` is the FIRST of the two observations migration 0016 gave the
  // table, and the recheck pass computes the gap between them from it. Nothing
  // else writes it, so if the writer stops stamping it the column is null for
  // ever on that crawl and the gap is unmeasurable.
  it("stamps fetched_at on every row it writes, and leaves the recheck columns null", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const before = Date.now();
    const good = `${SITE}/works`;
    const broken = `${SITE}/boom`;
    await writer.addPage(item(good), makeFetch(good), makeAnalysis(), { complete: true });
    // A page with no body and no analysis is stamped too: the timestamp is the
    // FETCH's, not the analysis's.
    await writer.addPage(
      item(broken),
      makeFetch(broken, { statusCode: 503, fetchClass: "server_error", body: null }),
      null,
      { complete: true },
    );
    await writer.flush();
    const after = Date.now();

    const rows = await db
      .select({
        url: pages.url,
        fetchedAt: pages.fetchedAt,
        recheckFetchClass: pages.recheckFetchClass,
        recheckStatusCode: pages.recheckStatusCode,
        recheckReason: pages.recheckReason,
        recheckAt: pages.recheckAt,
      })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.fetchedAt, row.url).not.toBeNull();
      expect(row.fetchedAt!.getTime(), row.url).toBeGreaterThanOrEqual(before);
      expect(row.fetchedAt!.getTime(), row.url).toBeLessThanOrEqual(after);
      // NOBODY ASKED: the writer never writes a second observation, not even on
      // the 5xx row. Only the recheck pass does.
      expect(row.recheckFetchClass, row.url).toBeNull();
      expect(row.recheckStatusCode, row.url).toBeNull();
      expect(row.recheckReason, row.url).toBeNull();
      expect(row.recheckAt, row.url).toBeNull();
    }
  });

  // The conflict path, stated as a claim rather than left to be inferred: the
  // pages insert is `on conflict do nothing`, so a re-crawl of a URL already in
  // the table keeps the FIRST observation's row and its timestamp. Re-stamping
  // it would date the census by when we last looked (hard rule 7).
  it("keeps the first row's fetched_at when a second write hits the (crawl, url) conflict", async () => {
    const crawlId = await newCrawl();
    const url = `${SITE}/twice`;
    const first = new PageWriter(db, crawlId);
    await first.addPage(item(url), makeFetch(url), makeAnalysis(), { complete: true });
    await first.flush();
    const [original] = await db
      .select({ fetchedAt: pages.fetchedAt })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(original?.fetchedAt).not.toBeNull();

    await new Promise((ok) => setTimeout(ok, 5));
    const second = new PageWriter(db, crawlId);
    await second.addPage(item(url), makeFetch(url), makeAnalysis(), { complete: true });
    await second.flush();

    const rows = await db
      .select({ fetchedAt: pages.fetchedAt })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.fetchedAt!.getTime()).toBe(original!.fetchedAt!.getTime());
  });

  // The redirect graph is joined on `redirect_url_normalised`, so the writer
  // owes it the frontier key of the target — while `redirect_url` keeps the
  // `Location` as the server sent it, because that is the evidence. A page with
  // no redirect has neither.
  it("stores a redirect target in both spellings, and null for a page with none", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const moved = `${SITE}/moved`;
    await writer.addPage(
      item(moved),
      makeFetch(moved, {
        statusCode: 301,
        fetchClass: "redirect",
        body: null,
        redirectUrl: `${SITE}/target?b=2&a=1#section`,
      }),
      null,
      { complete: true },
    );
    await writer.addPage(item(`${SITE}/stays`), makeFetch(`${SITE}/stays`), makeAnalysis(), {
      complete: true,
    });
    await writer.flush();

    const rows = await db
      .select({
        url: pages.url,
        redirectUrl: pages.redirectUrl,
        redirectUrlNormalised: pages.redirectUrlNormalised,
      })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r]));
    expect(byUrl.get(moved)).toEqual({
      url: moved,
      redirectUrl: `${SITE}/target?b=2&a=1#section`,
      redirectUrlNormalised: `${SITE}/target?a=1&b=2`,
    });
    expect(byUrl.get(`${SITE}/stays`)).toEqual({
      url: `${SITE}/stays`,
      redirectUrl: null,
      redirectUrlNormalised: null,
    });
  });

  it("writes the rule-signal columns the page rules read", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/signals`;
    await writer.addPage(
      item(url),
      makeFetch(url),
      makeAnalysis({
        canonicalCount: 2,
        hasViewport: true,
        imagesMissingDimensions: 3,
        hasLoremIpsum: true,
        hasSoft404Phrases: true,
        navLinkCount: 21,
        footerLinkCount: 9,
        frameworkMarkers: ["__NEXT_DATA__", "data-reactroot"],
      }),
      { complete: true },
    );
    await writer.flush();

    const [row] = await db
      .select({
        canonicalCount: pages.canonicalCount,
        hasViewport: pages.hasViewport,
        imagesMissingDimensions: pages.imagesMissingDimensions,
        hasLoremIpsum: pages.hasLoremIpsum,
        hasSoft404Phrases: pages.hasSoft404Phrases,
        navLinkCount: pages.navLinkCount,
        footerLinkCount: pages.footerLinkCount,
        frameworkMarkers: pages.frameworkMarkers,
        renderedNavLinkCount: pages.renderedNavLinkCount,
        renderedFooterLinkCount: pages.renderedFooterLinkCount,
        renderedFilterLinkCount: pages.renderedFilterLinkCount,
        renderedRedirectUrl: pages.renderedRedirectUrl,
        renderError: pages.renderError,
      })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(row?.canonicalCount).toBe(2);
    expect(row?.hasViewport).toBe(true);
    expect(row?.imagesMissingDimensions).toBe(3);
    expect(row?.hasLoremIpsum).toBe(true);
    expect(row?.hasSoft404Phrases).toBe(true);
    expect(row?.navLinkCount).toBe(21);
    expect(row?.footerLinkCount).toBe(9);
    expect(row?.frameworkMarkers).toEqual(["__NEXT_DATA__", "data-reactroot"]);
    // The render-side twins belong to the render pass and to nothing else: the
    // HTML crawl leaves them null, which is what says this page was never
    // rendered rather than rendered and found to have no navigation.
    expect(row?.renderedNavLinkCount).toBeNull();
    expect(row?.renderedFooterLinkCount).toBeNull();
    expect(row?.renderedFilterLinkCount).toBeNull();
    expect(row?.renderedRedirectUrl).toBeNull();
    expect(row?.renderError).toBeNull();
  });

  it("strips a trailing slash from url_normalised", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    for (const url of [`${SITE}/x/`, `${SITE}/`]) {
      await writer.addPage(item(url), makeFetch(url), makeAnalysis(), { complete: true });
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
    await writer.addPage(item(url), makeFetch(url), makeAnalysis(), { complete: true });
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
      { complete: true },
    );
    await writer.flush();

    const [row] = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(row?.fetchClass).toBe("client_error");
    expect(row?.statusCode).toBe(404);
    expect(row?.title).toBeNull();
    expect(row?.simhash).toBeNull();
    expect(row?.structuredDataParseErrors).toBe(0);
    // No HTML, so no signal — the columns say "not seen", not "clean".
    expect(row?.canonicalCount).toBe(0);
    expect(row?.hasViewport).toBe(false);
    expect(row?.imagesMissingDimensions).toBe(0);
    expect(row?.hasLoremIpsum).toBe(false);
    expect(row?.hasSoft404Phrases).toBe(false);
    // Same reading for the nav captures: no HTML, no navigation. These three
    // are NOT NULL columns, so 0/0/[] is the value, and it is a fact about the
    // page rather than a stand-in for a missing one.
    expect(row?.navLinkCount).toBe(0);
    expect(row?.footerLinkCount).toBe(0);
    expect(row?.frameworkMarkers).toEqual([]);
    // Where the head ended (0021): no HTML, nothing measured — all six null,
    // which the outside-head rules read as silence.
    expect(row?.headClosedBy).toBeNull();
    expect(row?.titleOutsideHead).toBeNull();
    expect(row?.metaDescriptionOutsideHead).toBeNull();
    expect(row?.robotsOutsideHead).toBeNull();
    expect(row?.canonicalOutsideHead).toBeNull();
    expect(row?.hreflangOutsideHeadCount).toBeNull();
    expect(await countOf(links, crawlId)).toBe(0);
    expect(await countOf(hreflang, crawlId)).toBe(0);
    expect(await countOf(structuredData, crawlId)).toBe(0);
  });

  it("writes where the head ended and what came after it (migration 0021)", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/head-closed-early`;
    await writer.addPage(
      item(url),
      makeFetch(url),
      makeAnalysis({
        headClosedBy: "img",
        titleOutsideHead: true,
        metaDescriptionOutsideHead: false,
        robotsOutsideHead: true,
        canonicalOutsideHead: true,
        hreflangOutsideHeadCount: 4,
      }),
      { complete: true },
    );
    await writer.flush();

    const [row] = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(row?.headClosedBy).toBe("img");
    expect(row?.titleOutsideHead).toBe(true);
    expect(row?.metaDescriptionOutsideHead).toBe(false);
    expect(row?.robotsOutsideHead).toBe(true);
    expect(row?.canonicalOutsideHead).toBe(true);
    expect(row?.hreflangOutsideHeadCount).toBe(4);
  });

  it("ignores a second row for the same (crawl, url)", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/twice`;
    await writer.addPage(item(url), makeFetch(url), null, { complete: true });
    await writer.addPage(item(url), makeFetch(url), null, { complete: true });
    await writer.flush();
    expect(await countOf(pages, crawlId)).toBe(1);
  });

  it("attempts every table when one insert fails, and names what failed", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/poison`;
    // A position past int4 is rejected by Postgres, so the `links` insert —
    // and only that one — throws. `links` flushes second, so if flush() gave
    // up at the first failure, hreflang and structured_data would be lost.
    await writer.addPage(
      item(url),
      makeFetch(url),
      makeAnalysis({
        links: [
          {
            href: `${SITE}/one`,
            anchor: "one",
            rel: null,
            nofollow: false,
            position: 3_000_000_000,
          },
        ],
      }),
      { complete: true },
    );

    let caught: unknown;
    try {
      await writer.flush();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.message).toContain("links");
    expect(aggregate.errors).toHaveLength(1);
    expect((aggregate.errors[0] as Error).message).toContain("1 row(s) lost");

    expect(await countOf(links, crawlId)).toBe(0);
    expect(await countOf(pages, crawlId)).toBe(1);
    expect(await countOf(hreflang, crawlId)).toBe(2);
    expect(await countOf(structuredData, crawlId)).toBe(1);

    // The failed batch left the buffer, so the writer is usable again.
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(writer.stats()).toEqual({
      pages: 1,
      links: 0,
      hreflang: 2,
      structuredData: 1,
      resources: 2,
      pageResources: 2,
      hreflangUnresolved: 0,
      resourceRefsCappedPages: 0,
    });
  });

  /**
   * `pages.fetch_reason`. A classified failure whose reason lived only in the
   * `FetchResult` object was an argument about transparency that was false the
   * moment the row hit disk: `network_error` with nothing beside it is a row
   * nobody can act on (hard rule 7). These pin that the reason survives the
   * write, for both shapes that produce one.
   */
  describe("fetch reason", () => {
    it("persists the reason on an undecodable response", async () => {
      const crawlId = await newCrawl();
      const url = `${SITE}/brotli`;
      const writer = new PageWriter(db, crawlId, { batchSize: 1 });
      await writer.addPage(
        item(url),
        makeFetch(url, {
          fetchClass: "unsupported_encoding",
          body: null,
          disallowedReason: "unsupported content-encoding (br)",
        }),
        null,
        { complete: true },
      );
      await writer.flush();

      const row = (
        await db.select().from(pages).where(eq(pages.url, url))
      )[0];
      expect(row?.fetchClass).toBe("unsupported_encoding");
      // The class says what happened; only this says which coding did it.
      expect(row?.fetchReason).toBe("unsupported content-encoding (br)");
    });

    it("persists the reason a redirect target was dropped", async () => {
      const crawlId = await newCrawl();
      const url = `${SITE}/moved-js`;
      const writer = new PageWriter(db, crawlId, { batchSize: 1 });
      await writer.addPage(
        item(url),
        makeFetch(url, {
          statusCode: 302,
          fetchClass: "redirect",
          body: null,
          redirectUrl: null,
          disallowedReason: "redirect target refused: unsupported scheme (javascript:)",
        }),
        null,
        { complete: true },
      );
      await writer.flush();

      const row = (
        await db.select().from(pages).where(eq(pages.url, url))
      )[0];
      expect(row?.fetchClass).toBe("redirect");
      expect(row?.redirectUrl).toBeNull();
      // Without this, a refused `Location` is indistinguishable from a 3xx
      // that simply had none — the pre-existing hole the column also closes.
      expect(row?.fetchReason).toContain("javascript:");
    });

    it("leaves the reason null on a page that worked", async () => {
      const crawlId = await newCrawl();
      const url = `${SITE}/fine`;
      const writer = new PageWriter(db, crawlId, { batchSize: 1 });
      await writer.addPage(item(url), makeFetch(url), null, { complete: true });
      await writer.flush();

      const row = (
        await db.select().from(pages).where(eq(pages.url, url))
      )[0];
      expect(row?.fetchReason).toBeNull();
    });
  });

  /**
   * The hard-kill contract (build plan §7). A crawl marked a URL `done` as soon
   * as its page row was *buffered*, so a SIGKILL took up to `batchSize - 1`
   * pages with it and no resume ever fetched them again. These four tests are
   * the contract that replaced it: the frontier row moves only when the page
   * row commits, and the two move together.
   */
  describe("hard-kill durability", () => {
    /** Seed `urls` into the frontier of `crawlId` and lease them all. */
    async function leased(crawlId: string, urls: string[]): Promise<void> {
      await enqueueUrls(
        db,
        crawlId,
        urls.map((url) => ({ url, depth: 1, discoveredVia: "link" })),
      );
      await leaseBatch(db, crawlId, "w1", urls.length, 600);
    }

    it("a buffered page row leaves its URL leased, and a flush finishes both", async () => {
      const crawlId = await newCrawl();
      const urls = [`${SITE}/buffered/1`, `${SITE}/buffered/2`, `${SITE}/buffered/3`];
      await leased(crawlId, urls);

      // Fewer pages than the batch size: nothing has reached the database.
      const writer = new PageWriter(db, crawlId, { batchSize: 100 });
      for (const url of urls) {
        await writer.addPage(item(url), makeFetch(url), null, { complete: true });
      }

      // The kill lands here. The frontier still owes every one of these URLs,
      // so a resume re-fetches exactly what the buffer was holding.
      expect(await countOf(pages, crawlId)).toBe(0);
      expect(await frontierCounts(db, crawlId)).toEqual({
        pending: 0,
        leased: 3,
        done: 0,
        failed: 0,
        renderPending: 0,
      });

      await writer.flush();
      expect(await countOf(pages, crawlId)).toBe(3);
      expect(await frontierCounts(db, crawlId)).toEqual({
        pending: 0,
        leased: 0,
        done: 3,
        failed: 0,
        renderPending: 0,
      });
    });

    it("completes only the URLs the caller said it was not settling itself", async () => {
      const crawlId = await newCrawl();
      const mine = `${SITE}/settled/by-writer`;
      const theirs = `${SITE}/settled/by-caller`;
      await leased(crawlId, [mine, theirs]);

      const writer = new PageWriter(db, crawlId, { batchSize: 100 });
      await writer.addPage(item(mine), makeFetch(mine), null, { complete: true });
      await writer.addPage(item(theirs), makeFetch(theirs), null, { complete: false });
      // What the crawl loop does with a URL whose retries are spent, before the
      // flush that writes its row. A completion here would overwrite it.
      await failUrl(db, crawlId, theirs, { requeue: false, maxAttempts: 3 });
      await writer.flush();

      expect(await countOf(pages, crawlId)).toBe(2);
      expect(await frontierCounts(db, crawlId)).toEqual({
        pending: 0,
        leased: 0,
        done: 1,
        failed: 1,
        renderPending: 0,
      });
    });

    it("rolls the page rows back when the completion fails mid-transaction", async () => {
      const crawlId = await newCrawl();
      const ok = `${SITE}/atomic/ok`;
      const boom = `${SITE}/atomic/boom`;
      await leased(crawlId, [ok, boom]);

      // A failure inside the transaction, raised by Postgres itself: the
      // completion of `boom` throws after the page rows have been inserted.
      // Without one transaction around the pair, this is precisely the state
      // the bug produced — rows written, URLs still owed, or the reverse.
      await db.execute(
        sql.raw(`create or replace function ariadne_test_boom() returns trigger
                 language plpgsql as $$ begin
                   raise exception 'boom: injected mid-transaction failure';
                 end $$`),
      );
      await db.execute(
        sql.raw(`create trigger ariadne_test_boom_trg before update on frontier
                 for each row when (new.url = '${boom}')
                 execute function ariadne_test_boom()`),
      );

      try {
        const writer = new PageWriter(db, crawlId, { batchSize: 100 });
        for (const url of [ok, boom]) {
          await writer.addPage(item(url), makeFetch(url), null, { complete: true });
        }

        let caught: unknown;
        try {
          await writer.flush();
        } catch (error) {
          caught = error;
        }
        // Loud, and named: the page flush is the failure, not a silent skip.
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).message).toContain("pages");

        // Both halves are gone: no page rows, and no URL marked done — not even
        // the one whose completion would have succeeded on its own.
        expect(await countOf(pages, crawlId)).toBe(0);
        expect(await frontierCounts(db, crawlId)).toEqual({
          pending: 0,
          leased: 2,
          done: 0,
          failed: 0,
          renderPending: 0,
        });
      } finally {
        await db.execute(sql.raw("drop trigger if exists ariadne_test_boom_trg on frontier"));
        await db.execute(sql.raw("drop function if exists ariadne_test_boom()"));
      }
    });

    it("completes a URL whose page row lost the (crawl, url) conflict", async () => {
      // The redirect-target race: another handler wrote this crawl's row for
      // the URL first, so this insert drops the duplicate and returns nothing.
      // The URL is still crawled and still owed a completion — leaving it
      // leased would send the resume back for a page that is already there.
      const crawlId = await newCrawl();
      const url = `${SITE}/atomic/duplicate`;
      await leased(crawlId, [url]);
      await db.insert(pages).values({
        id: `page_${randomUUID()}`,
        crawlId,
        url,
        urlNormalised: url.toLowerCase(),
        statusCode: 200,
        fetchClass: "ok",
        depth: 1,
        discoveredVia: "redirect",
      });

      const writer = new PageWriter(db, crawlId, { batchSize: 100 });
      await writer.addPage(item(url), makeFetch(url), null, { complete: true });
      await writer.flush();

      expect(await countOf(pages, crawlId)).toBe(1);
      expect(writer.stats().pages).toBe(0); // the row was dropped, and says so
      expect((await frontierCounts(db, crawlId)).done).toBe(1);
    });
  });

  /**
   * P11-T1. The two tables are one fact split by cardinality: `resources` is
   * about FILES (one row per distinct URL per crawl) and `page_resources` is
   * about REFERENCES (one row per page per file). Everything below is a
   * consequence of that split, and the last case is the one that would let the
   * memory contract back in through the front door if it failed — the dedup has
   * to be the database's, because the alternative is a per-crawl set of URLs in
   * the writer (hard rule 6).
   */
  describe("resources", () => {
    it("writes a row and an edge per referenced URL, unfetched", async () => {
      const crawlId = await newCrawl();
      const writer = new PageWriter(db, crawlId);
      const url = `${SITE}/page-with-assets`;
      const pageId = await writer.addPage(
        item(url),
        makeFetch(url),
        makeAnalysis({
          resourceRefs: [
            { url: `${SITE}/img/hero.png`, kind: "image" },
            { url: `${SITE}/css/theme.css`, kind: "css" },
            { url: "https://cdn.other/app.js", kind: "js" },
          ],
        }),
        { complete: true },
      );
      await writer.flush();

      const rows = await db
        .select({
          url: resources.url,
          kind: resources.kind,
          fetchClass: resources.fetchClass,
          fetchReason: resources.fetchReason,
          statusCode: resources.statusCode,
          bytes: resources.bytes,
          bytesSource: resources.bytesSource,
          contentType: resources.contentType,
          cacheControl: resources.cacheControl,
          expires: resources.expires,
          fetchedAt: resources.fetchedAt,
          fetchMs: resources.fetchMs,
        })
        .from(resources)
        .where(eq(resources.crawlId, crawlId))
        .orderBy(resources.url);
      expect(rows).toEqual([
        {
          url: "https://cdn.other/app.js",
          kind: "js",
          // "SEEN, NOT YET ASKED" — the whole meaning of the null, and the
          // reason no rule may call an unfetched resource broken. Every other
          // fetch column is null with it: the pass writes them together.
          fetchClass: null,
          fetchReason: null,
          statusCode: null,
          bytes: null,
          bytesSource: null,
          contentType: null,
          cacheControl: null,
          expires: null,
          fetchedAt: null,
          fetchMs: null,
        },
        expect.objectContaining({ url: `${SITE}/css/theme.css`, kind: "css" }),
        expect.objectContaining({ url: `${SITE}/img/hero.png`, kind: "image" }),
      ]);

      const edges = await db
        .select({ pageId: pageResources.pageId, url: pageResources.resourceUrl })
        .from(pageResources)
        .where(eq(pageResources.crawlId, crawlId))
        .orderBy(pageResources.resourceUrl);
      expect(edges).toEqual([
        { pageId, url: "https://cdn.other/app.js" },
        { pageId, url: `${SITE}/css/theme.css` },
        { pageId, url: `${SITE}/img/hero.png` },
      ]);
      expect(writer.stats().resources).toBe(3);
      expect(writer.stats().pageResources).toBe(3);
    });

    /** THE SPLIT, stated as the test the brief asks for. */
    it("gives two pages sharing an image ONE resource row and TWO edges", async () => {
      const crawlId = await newCrawl();
      const writer = new PageWriter(db, crawlId, { batchSize: 1 });
      const shared = `${SITE}/img/shared.png`;
      const ids: string[] = [];
      for (const path of ["/a", "/b"]) {
        ids.push(
          await writer.addPage(
            item(`${SITE}${path}`),
            makeFetch(`${SITE}${path}`),
            makeAnalysis({ resourceRefs: [{ url: shared, kind: "image" }] }),
            { complete: true },
          ),
        );
      }
      await writer.flush();

      expect(await countOf(resources, crawlId)).toBe(1);
      const edges = await db
        .select({ pageId: pageResources.pageId, url: pageResources.resourceUrl })
        .from(pageResources)
        .where(eq(pageResources.crawlId, crawlId));
      expect(edges).toHaveLength(2);
      expect(edges.map((e) => e.pageId).sort()).toEqual([...ids].sort());
      expect(new Set(edges.map((e) => e.url))).toEqual(new Set([shared]));
      // The counter counts ROWS WRITTEN, so the conflict-dropped second insert
      // is not one — the same reading `stats().pages` already has.
      expect(writer.stats().resources).toBe(1);
      expect(writer.stats().pageResources).toBe(2);
    });

    /**
     * THE CAP-EXCEEDED COUNTER (P12-T1). The analyzer says on each page whether
     * the `MAX_RESOURCE_REFS` cap dropped a reference; the writer is where those
     * booleans become one number, because it is the one component every page
     * passes through exactly once and it already holds the crawl's other
     * O(pages) counters. The crawl loop stamps the total onto
     * `crawls.resource_refs_capped_pages` at close — the alternative, deriving
     * it from `page_resources`, was measured at 73 ms over 500,000 edges against
     * a `crawl_status` whose other reads are ≤ 3 ms (phase-11.md §10.1).
     */
    it("counts the pages whose analyzer hit the resource-ref cap, and no others", async () => {
      const crawlId = await newCrawl();
      const writer = new PageWriter(db, crawlId, { batchSize: 2 });
      for (const [path, capped] of [
        ["/plain", false],
        ["/gallery", true],
        ["/also-plain", false],
        ["/mega-menu", true],
      ] as const) {
        await writer.addPage(
          item(`${SITE}${path}`),
          makeFetch(`${SITE}${path}`),
          makeAnalysis({ resourceRefsCapped: capped }),
          { complete: true },
        );
      }
      // A page that produced no HTML has no analysis and therefore no answer —
      // it is not a page whose references were truncated, and counting it as
      // one would put a 404 in the number.
      await writer.addPage(
        item(`${SITE}/gone`),
        makeFetch(`${SITE}/gone`, { statusCode: 404, fetchClass: "client_error", body: null }),
        null,
        { complete: true },
      );
      await writer.flush();

      expect(writer.stats().resourceRefsCappedPages).toBe(2);
    });

    /**
     * The duplicate can also arrive INSIDE one insert, when both pages are in
     * the same batch. `on conflict do nothing` absorbs that too; a plain insert
     * would raise on the unique index and lose the whole batch.
     */
    it("absorbs a duplicate inside a single batch", async () => {
      const crawlId = await newCrawl();
      const writer = new PageWriter(db, crawlId, { batchSize: 100 });
      const shared = `${SITE}/img/batch.png`;
      for (const path of ["/a", "/b", "/c"]) {
        await writer.addPage(
          item(`${SITE}${path}`),
          makeFetch(`${SITE}${path}`),
          makeAnalysis({ resourceRefs: [{ url: shared, kind: "image" }] }),
          { complete: true },
        );
      }
      await writer.flush();

      expect(await countOf(resources, crawlId)).toBe(1);
      expect(await countOf(pageResources, crawlId)).toBe(3);
    });

    it("writes nothing for a page with no analysis", async () => {
      const crawlId = await newCrawl();
      const writer = new PageWriter(db, crawlId);
      const url = `${SITE}/404`;
      await writer.addPage(
        item(url),
        makeFetch(url, { statusCode: 404, fetchClass: "client_error", body: null }),
        null,
        { complete: true },
      );
      await writer.flush();
      expect(await countOf(resources, crawlId)).toBe(0);
      expect(await countOf(pageResources, crawlId)).toBe(0);
    });

    /**
     * The memory contract, at the writer. A page with more refs than
     * `batchSize` must push batches through the buffer rather than hold them —
     * the property `links` is already held to, and resources sit in the same
     * buffers on the same page.
     */
    it("never lets either buffer exceed batchSize for one asset-heavy page", async () => {
      const crawlId = await newCrawl();
      const writer = new PageWriter(db, crawlId, { batchSize: 100 });
      const many = Array.from({ length: 250 }, (_, i) => ({
        url: `${SITE}/i/${i}.png`,
        kind: "image" as const,
      }));
      const url = `${SITE}/gallery`;
      await writer.addPage(item(url), makeFetch(url), makeAnalysis({ resourceRefs: many }), {
        complete: true,
      });

      // Two full batches of each went to the database inside addPage; the
      // 50-row remainders are still buffered.
      expect(await countOf(resources, crawlId)).toBe(200);
      expect(await countOf(pageResources, crawlId)).toBe(200);
      await writer.flush();
      expect(await countOf(resources, crawlId)).toBe(250);
      expect(await countOf(pageResources, crawlId)).toBe(250);
    });

    /** Deleting a crawl takes both tables with it, like every sibling. */
    it("cascades from the crawl delete", async () => {
      const id = `crawl_${randomUUID()}`;
      await db.insert(crawls).values({
        id,
        siteUrl: SITE,
        config: {},
        rulesetVersion: "test",
      });
      const writer = new PageWriter(db, id);
      const url = `${SITE}/doomed`;
      await writer.addPage(item(url), makeFetch(url), makeAnalysis(), { complete: true });
      await writer.flush();
      expect(await countOf(resources, id)).toBe(2);
      expect(await countOf(pageResources, id)).toBe(2);

      await db.delete(crawls).where(eq(crawls.id, id));
      expect(await countOf(resources, id)).toBe(0);
      expect(await countOf(pageResources, id)).toBe(0);
      expect(await countOf(pages, id)).toBe(0);
    });
  });

  it("flush is idempotent and reports what it wrote", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const url = `${SITE}/flush`;
    await writer.addPage(item(url), makeFetch(url), makeAnalysis(), { complete: true });
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
      resources: 2,
      pageResources: 2,
      hreflangUnresolved: 0,
      resourceRefsCappedPages: 0,
    });
  });
});

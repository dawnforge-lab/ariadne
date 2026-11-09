/**
 * Phase 27c T3: a row with `fetch_class = 'excluded'` (the crawl's own scope
 * patterns turned the URL away at admission) is a URL nobody asked for, and a
 * URL the crawl's current scope fences off is not "not crawled".
 *
 * Rows are inserted directly (the link-targets pattern); the frontier does not
 * write `excluded` rows until Task 4, so this file is the only place the
 * rules meet one.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { hreflang, links, pages, sitemapUrls } from "../../src/db/schema.js";
import { healthMetrics } from "../../src/rules/metric/health-metrics.js";
import { crawlMetrics } from "../../src/rules/metric/crawl-metrics.js";
import { renderMetrics } from "../../src/rules/metric/render-metrics.js";
import { hreflangRules } from "../../src/rules/query/hreflang.js";
import { linkGraphRules } from "../../src/rules/query/link-graph.js";
import { linkTargetRules } from "../../src/rules/query/link-targets.js";
import { paginationRules } from "../../src/rules/query/pagination.js";
import { sitemapRules } from "../../src/rules/query/sitemap.js";
import { storedScope } from "../../src/rules/query/crawl-evidence.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { dropCrawls, metricLookup, metricRowsByScope, newMetricCrawl } from "./metric-db.js";

const SITE = "https://scope.example";
const url = (path: string): string => `${SITE}${path}`;

const queryRules = new Map<string, QueryRule>(
  [...linkTargetRules, ...linkGraphRules, ...hreflangRules, ...paginationRules, ...sitemapRules].map(
    (r) => [r.id, r],
  ),
);
function qrule(id: string): QueryRule {
  const r = queryRules.get(id);
  if (!r) throw new Error(`no query rule '${id}'`);
  return r;
}
const health = metricLookup(healthMetrics, "healthMetrics");
const crawlM = metricLookup(crawlMetrics, "crawlMetrics");
const renderM = metricLookup(renderMetrics, "renderMetrics");

function mentions(found: Finding[], needle: string): boolean {
  return JSON.stringify(found).includes(needle);
}

describe("excluded rows and fenced-off URLs", () => {
  let db: Db;
  const created: string[] = [];

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
    db = createDb(dbUrl);
    await runMigrations(db);
  });
  afterAll(async () => {
    await dropCrawls(db, created);
    await closeDb(db);
  });

  async function addPage(
    crawlId: string,
    path: string,
    o: Partial<typeof pages.$inferInsert> = {},
  ): Promise<string> {
    const id = `page_${randomUUID()}`;
    await db.insert(pages).values({
      id,
      crawlId,
      url: url(path),
      urlNormalised: url(path),
      pageType: "content",
      fetchClass: "ok",
      statusCode: 200,
      isIndexable: true,
      canonicalHtml: url(path),
      depth: 1,
      discoveredVia: "link",
      ...o,
    });
    return id;
  }

  async function link(crawlId: string, from: string, to: string): Promise<void> {
    await db.insert(links).values({
      crawlId,
      sourcePageId: from,
      targetUrl: url(to),
      targetPageId: null,
      anchor: "a",
      rel: null,
      isInternal: true,
      isNofollow: false,
      position: 0,
    });
  }

  const excludedRow = {
    fetchClass: "excluded",
    fetchReason: "crawl scope: matched exclude */private/*",
    statusCode: null,
    isIndexable: null,
    canonicalHtml: null,
  } as const;

  describe("an excluded page row", () => {
    async function build(): Promise<string> {
      const crawlId = await newMetricCrawl(db, SITE, created, {
        config: { userAgent: "AriadneBot-test", maxPages: 500 },
        discovery: mkDiscovery() as unknown as Record<string, unknown>,
      });
      const home = await addPage(crawlId, "/", {
        // One canonical and one hreflang alternate point at the excluded URL.
        canonicalHtml: url("/private/x"),
      });
      await addPage(crawlId, "/other");
      await addPage(crawlId, "/private/x", excludedRow);
      await link(crawlId, home, "/private/x");
      await db.insert(hreflang).values({
        crawlId,
        pageId: home,
        hreflangCode: "fr",
        targetUrl: url("/private/x"),
        targetPageId: null,
        source: "html",
      });
      return crawlId;
    }

    it("is reported by no link, canonical, orphan or hreflang rule", async () => {
      const crawlId = await build();
      for (const id of [
        "links.broken-internal",
        "links.to-server-error",
        "links.orphan",
        "canonical.non-200-target",
        "canonical.non-indexable-target",
        "hreflang.non-indexable-target",
      ]) {
        expect(mentions(await qrule(id).run(db, crawlId), "/private/x"), id).toBe(false);
      }
    });

    it("is not counted by redirect.volume, render.coverage or site.health's judged pages", async () => {
      const crawlId = await build();
      const redirect = (await metricRowsByScope(db, crawlM("redirect.volume"), crawlId))[
        "site|"
      ] as { totalPages: number };
      expect(redirect.totalPages).toBe(2);
      const render = (await metricRowsByScope(db, renderM("render.coverage"), crawlId))[
        "site|"
      ] as { pagesCrawled: number };
      expect(render.pagesCrawled).toBe(2);
      const h = (await metricRowsByScope(db, health("site.health"), crawlId))["site|"] as {
        urlsTotal: number;
        pagesNotAuditable: number;
      };
      // Home canonicalises away, /other is judged; the excluded row is a URL
      // not judged, like a robots-blocked one.
      expect(h.urlsTotal).toBe(1);
      expect(h.pagesNotAuditable).toBe(1);
    });

    it("is not a pagination target the series is judged against", async () => {
      const crawlId = await newMetricCrawl(db, SITE, created, {
        config: { userAgent: "AriadneBot-test", maxPages: 500 },
      });
      await addPage(crawlId, "/blog", { relNext: "/private/p2" });
      await addPage(crawlId, "/private/p2", excludedRow);
      // No scope is stored, so the excluded row reads as an uncrawled target.
      const found = await qrule("pagination.next-target-uncrawled").run(db, crawlId);
      expect(found).toHaveLength(1);
      expect(await qrule("pagination.non-indexable-target").run(db, crawlId)).toHaveLength(0);
      expect(await qrule("pagination.next-not-linked").run(db, crawlId)).toHaveLength(0);
    });
  });

  describe("not crawled because fenced off", () => {
    async function build(config: Record<string, unknown>): Promise<string> {
      const crawlId = await newMetricCrawl(db, SITE, created, {
        config: { userAgent: "AriadneBot-test", maxPages: 500, ...config },
        discovery: mkDiscovery() as unknown as Record<string, unknown>,
      });
      const home = await addPage(crawlId, "/", {
        relNext: "/private/p2",
      });
      await addPage(crawlId, "/pg", { relNext: "/open/p2" });
      for (const path of ["/private/s", "/open/s"]) {
        await db.insert(sitemapUrls).values({
          crawlId,
          url: url(path),
          urlNormalised: url(path),
          sitemapSource: url("/sitemap.xml"),
          lastmod: null,
        });
      }
      for (const path of ["/private/fr", "/open/fr"]) {
        await db.insert(hreflang).values({
          crawlId,
          pageId: home,
          hreflangCode: "fr",
          targetUrl: url(path),
          targetPageId: null,
          source: "html",
        });
      }
      return crawlId;
    }

    it("leaves the fenced-off URLs out, and the same URLs outside the pattern in", async () => {
      const crawlId = await build({ exclude: ["*/private/*"] });
      const sitemap = await qrule("sitemap.uncrawled").run(db, crawlId);
      expect(mentions(sitemap, "/open/s")).toBe(true);
      expect(mentions(sitemap, "/private/s")).toBe(false);
      const next = await qrule("pagination.next-target-uncrawled").run(db, crawlId);
      expect(mentions(next, "/open/p2")).toBe(true);
      expect(mentions(next, "/private/p2")).toBe(false);
      const alt = await qrule("hreflang.alternates-not-crawled").run(db, crawlId);
      // Counted by host: one alternate remains (the open one), not two.
      expect(alt).toHaveLength(1);
      expect(JSON.stringify(alt[0]!.evidence)).toContain('"total":1');
    });

    it("reports all of them when no scope is stored", async () => {
      const crawlId = await build({});
      expect(mentions(await qrule("sitemap.uncrawled").run(db, crawlId), "/private/s")).toBe(true);
      expect(
        mentions(await qrule("pagination.next-target-uncrawled").run(db, crawlId), "/private/p2"),
      ).toBe(true);
      const alt = await qrule("hreflang.alternates-not-crawled").run(db, crawlId);
      expect(JSON.stringify(alt[0]!.evidence)).toContain('"total":2');
    });

    it("honours an include list: a URL outside it is fenced off", async () => {
      const crawlId = await build({ include: ["*/open/*", `${SITE}/`, `${SITE}/pg`] });
      const sitemap = await qrule("sitemap.uncrawled").run(db, crawlId);
      expect(mentions(sitemap, "/private/s")).toBe(false);
      expect(mentions(sitemap, "/open/s")).toBe(true);
    });

    it("with an include list, off-origin URLs are still reported and same-origin ones outside it are not", async () => {
      const crawlId = await newMetricCrawl(db, SITE, created, {
        config: { userAgent: "AriadneBot-test", maxPages: 500, include: ["*/keep/*"] },
        discovery: mkDiscovery() as unknown as Record<string, unknown>,
      });
      const home = await addPage(crawlId, "/keep/home");
      const off = "https://elsewhere.example/page";
      await db.insert(sitemapUrls).values(
        [url("/outside/s"), off].map((u) => ({
          crawlId,
          url: u,
          urlNormalised: u,
          sitemapSource: url("/sitemap.xml"),
          lastmod: null,
        })),
      );
      await db.insert(hreflang).values(
        [url("/outside/fr"), off].map((u) => ({
          crawlId,
          pageId: home,
          hreflangCode: "fr",
          targetUrl: u,
          targetPageId: null,
          source: "html",
        })),
      );
      const sitemap = await qrule("sitemap.uncrawled").run(db, crawlId);
      expect(mentions(sitemap, off)).toBe(true);
      expect(mentions(sitemap, "/outside/s")).toBe(false);
      const alt = await qrule("hreflang.alternates-not-crawled").run(db, crawlId);
      const text = JSON.stringify(alt);
      expect(text).toContain("elsewhere.example");
      expect(text).toContain('"total":1');
    });
  });

  describe("storedScope", () => {
    async function crawlWith(config: unknown): Promise<string> {
      return newMetricCrawl(db, SITE, created, { config: config as Record<string, unknown> });
    }

    it("reads absent keys as empty lists", async () => {
      expect(await storedScope(db, await crawlWith({}))).toMatchObject({ exclude: [], include: [] });
    });

    it("reads both lists", async () => {
      const id = await crawlWith({ exclude: ["*/a/*"], include: ["*/b/*"] });
      expect(await storedScope(db, id)).toMatchObject({ exclude: ["*/a/*"], include: ["*/b/*"] });
    });

    it("throws naming the crawl for any other shape", async () => {
      const id = await crawlWith({ exclude: "*/a/*" });
      await expect(storedScope(db, id)).rejects.toThrow(id);
      const id2 = await crawlWith({ include: [1] });
      await expect(storedScope(db, id2)).rejects.toThrow(id2);
    });

    it("throws for a crawl that does not exist", async () => {
      await expect(storedScope(db, "crawl_missing")).rejects.toThrow("crawl_missing");
    });
  });

  describe("a URL with no scheme separator under a scope (27c final wave M1)", () => {
    it("a mailto: hreflang alternate under an include list is still reported, not dropped by a NULL", async () => {
      const crawlId = await newMetricCrawl(db, SITE, created, {
        config: { userAgent: "AriadneBot-test", maxPages: 500, include: ["*/keep/*"] },
        discovery: mkDiscovery() as unknown as Record<string, unknown>,
      });
      const home = await addPage(crawlId, "/keep/home");
      await db.insert(hreflang).values({
        crawlId,
        pageId: home,
        hreflangCode: "fr",
        targetUrl: "mailto:fr@scope.example",
        targetPageId: null,
        source: "html",
      });
      const alt = await qrule("hreflang.alternates-not-crawled").run(db, crawlId);
      const text = JSON.stringify(alt);
      expect(text).toContain('"host":"mailto:"');
      expect(text).toContain('"total":1');
    });
  });
});

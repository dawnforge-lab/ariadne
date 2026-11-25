/**
 * PDFs in `links.orphan`, `structure.deep-page` and `site.health` (Phase 29d
 * Task 14, owner ruling 2026-11-25: "Let's include pdfs in health checks,
 * orphan, deep").
 *
 * Rows are inserted directly; the REAL click-depth derivation walks the graph,
 * so the depth a PDF carries is the one a breadth-first search over `links`
 * produced. A PDF has no extracted outlinks, so it is only ever a link target.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { hostKeyOf } from "../../src/crawl/host-key.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { deriveClickDepth } from "../../src/rules/derive/click-depth.js";
import { healthMetrics } from "../../src/rules/metric/health-metrics.js";
import { DEEP_DEPTH, linkGraphRules } from "../../src/rules/query/link-graph.js";
import type { Finding } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { mkDiscovery } from "./mk-discovery.js";
import { databaseUrl, dropCrawls, metricLookup } from "./metric-db.js";
import { writerIndexable } from "./mk-page.js";

const SITE = "https://pdf-links.example";
const url = (path: string): string => `${SITE}${path}`;
const PDF = "application/pdf";
const WORD = "application/msword";

interface Spec {
  path: string;
  contentType?: string;
  fetchClass?: string;
  xRobotsTag?: string;
  depth?: number;
  discoveredVia?: string;
}

const SEED: Spec = { path: "/", depth: 0, discoveredVia: "seed", contentType: "text/html" };
const pdf = (path: string, extra: Partial<Spec> = {}): Spec => ({
  path,
  contentType: PDF,
  fetchClass: "non_html",
  ...extra,
});
const word = (path: string): Spec => ({ path, contentType: WORD, fetchClass: "non_html" });

describe("PDFs in the link-graph rules and site.health", () => {
  let db: Db;
  const created: string[] = [];
  const health = metricLookup(healthMetrics, "healthMetrics");

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      hostKey: hostKeyOf(SITE),
      config: { maxPages: 500, userAgent: "AriadneBot-test" },
      discovery: mkDiscovery() as unknown as Record<string, unknown>,
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 3,
    });
    created.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: Spec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      contentType: s.contentType ?? "text/html",
      fetchClass: s.fetchClass ?? "ok",
      statusCode: 200,
      isIndexable: writerIndexable({
        fetchClass: s.fetchClass ?? "ok",
        contentType: s.contentType ?? "text/html",
        ...(s.xRobotsTag === undefined ? {} : { xRobotsTag: s.xRobotsTag }),
      }),
      xRobotsTag: s.xRobotsTag ?? null,
      depth: s.depth ?? 1,
      discoveredVia: s.discoveredVia ?? "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLink(crawlId: string, fromId: string, targetPath: string): Promise<void> {
    await db.insert(links).values({
      crawlId,
      sourcePageId: fromId,
      targetUrl: url(targetPath),
      targetPageId: null,
      anchor: "read this",
      rel: null,
      isInternal: true,
      isNofollow: false,
      position: 0,
    });
  }

  /**
   * The seed plus a chain `/c1` … `/c<length>` (each rung linking the next, the
   * seed linking `/c1`) whose last rung links `target`, so `target` sits at
   * click depth `length + 1`. Returns the ids of every page it added, seed
   * included, keyed by path.
   */
  async function seedWithChainTo(
    crawlId: string,
    length: number,
    target: string,
    extra: Spec[],
  ): Promise<Map<string, string>> {
    const rungs = Array.from({ length }, (_, i) => `/c${i + 1}`);
    const ids = await addPages(crawlId, [SEED, ...rungs.map((path) => ({ path })), ...extra]);
    await addLink(crawlId, ids.get("/")!, rungs[0]!);
    for (let i = 0; i + 1 < rungs.length; i += 1) {
      await addLink(crawlId, ids.get(rungs[i]!)!, rungs[i + 1]!);
    }
    await addLink(crawlId, ids.get(rungs[length - 1]!)!, target);
    return ids;
  }

  async function clickDepthOf(crawlId: string, path: string): Promise<number | null> {
    const rows = await db
      .select({ d: pages.clickDepth })
      .from(pages)
      .where(and(eq(pages.crawlId, crawlId), eq(pages.url, url(path))));
    if (rows[0] === undefined) throw new Error(`no row for ${path}`);
    return rows[0].d;
  }

  const run = async (id: string, crawlId: string): Promise<Finding[]> => {
    const r = linkGraphRules.find((x) => x.id === id);
    if (r === undefined) throw new Error(`no rule ${id}`);
    return r.run(db, crawlId);
  };
  const urlsOf = (f: Finding[]): (string | null)[] => f.map((x) => x.pageUrl).sort();

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });
  afterAll(async () => {
    await dropCrawls(db, created);
    await closeDb(db);
  });

  describe("links.orphan", () => {
    it("reports an indexable PDF nothing links to, and no other file", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        SEED,
        { path: "/a" },
        pdf("/linked.pdf"),
        pdf("/lonely.pdf"),
        pdf("/noindex.pdf", { xRobotsTag: "noindex" }),
        word("/doc.doc"),
      ]);
      await addLink(crawlId, ids.get("/")!, "/a");
      await addLink(crawlId, ids.get("/a")!, "/linked.pdf");

      const found = await run("links.orphan", crawlId);
      expect(urlsOf(found)).toEqual([url("/lonely.pdf")]);
      expect(found[0]!.evidence).toEqual({ inSitemap: false, discoveredVia: "link" });
      // The completeness twin is about the crawl, not the cohort: it ran.
      expect(await run("links.orphan-skipped", crawlId)).toHaveLength(0);
    });

    it("does not count a PDF's link to itself as an inlink", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [SEED, pdf("/self.pdf")]);
      await addLink(crawlId, ids.get("/self.pdf")!, "/self.pdf");
      expect(urlsOf(await run("links.orphan", crawlId))).toEqual([url("/self.pdf")]);
    });
  });

  describe("structure.deep-page", () => {
    it("derives a click depth for a linked PDF and reports one buried past the threshold", async () => {
      const crawlId = await newCrawl();
      const ids = await seedWithChainTo(crawlId, DEEP_DEPTH, "/buried.pdf", [
        pdf("/near.pdf"),
        pdf("/buried.pdf"),
      ]);
      await addLink(crawlId, ids.get("/")!, "/near.pdf");
      await deriveClickDepth(db, crawlId);

      expect(await clickDepthOf(crawlId, "/near.pdf")).toBe(1);
      expect(await clickDepthOf(crawlId, "/buried.pdf")).toBe(DEEP_DEPTH + 1);

      const found = await run("structure.deep-page", crawlId);
      expect(urlsOf(found)).toEqual([url("/buried.pdf")]);
      expect(found[0]!.evidence).toEqual({ clickDepth: DEEP_DEPTH + 1, threshold: DEEP_DEPTH });
      // The home-linked PDF is neither buried nor an orphan.
      expect(urlsOf(await run("links.orphan", crawlId))).toEqual([]);
    });

    it("does not report a buried noindex PDF or a buried Word file", async () => {
      const crawlId = await newCrawl();
      const ids = await seedWithChainTo(crawlId, DEEP_DEPTH, "/hidden.pdf", [
        pdf("/hidden.pdf", { xRobotsTag: "noindex" }),
        word("/doc.doc"),
      ]);
      await addLink(crawlId, ids.get("/c" + String(DEEP_DEPTH))!, "/doc.doc");
      await deriveClickDepth(db, crawlId);

      expect(await clickDepthOf(crawlId, "/hidden.pdf")).toBe(DEEP_DEPTH + 1);
      expect(await run("structure.deep-page", crawlId)).toHaveLength(0);
    });
  });

  describe("site.health", () => {
    it("judges an indexable PDF, sets a noindex PDF aside and leaves a Word file not judged", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        SEED,
        { path: "/a" },
        pdf("/ok.pdf"),
        pdf("/noindex.pdf", { xRobotsTag: "noindex" }),
        word("/doc.doc"),
      ]);
      const rows = await health("site.health").run(db, crawlId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).toEqual({
        urlsTotal: 3, // the seed, /a and ok.pdf
        urlsWithCritical: 0,
        urlsWithWarningOnly: 0,
        urlsWithInfoOnly: 0,
        urlsClean: 3, // a PDF has no page-rule findings, which is why urlsPdf exists
        cleanRatio: 1,
        pagesNotAuditable: 1, // the Word file
        urlsCanonicalised: 0,
        urlsNoindex: 1, // the noindexed PDF
        urlsPaginated: 0,
        urlsPdf: 1,
      });
    });
  });
});

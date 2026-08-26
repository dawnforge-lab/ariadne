/**
 * The orphan rule, against a real database.
 *
 * Rows are inserted directly (the link-targets pattern): what is under test is
 * what the rule makes of the link graph, the frontier and the crawl row the
 * crawler left behind, not the crawling.
 *
 * The gate is as much the subject as the finding. `links.orphan` is the one
 * rule in the ruleset whose verdict is only meaningful over a COMPLETE crawl —
 * "nothing links to this page" and "we never fetched the page that links to it"
 * look identical from the database — so half these tests are about the crawl
 * refusing to answer, loudly, rather than about orphans.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, links, pages, sitemapUrls } from "../../src/db/schema.js";
import { linkGraphRules } from "../../src/rules/query/link-graph.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://orphans.example";
const MAX_PAGES = 500;

const byId = new Map(linkGraphRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in linkGraphRules`);
  return r;
}

describe("linkGraphRules metadata", () => {
  it("defines exactly the orphan rule of the Phase 3 table", () => {
    expect(linkGraphRules.map((r) => r.id)).toEqual(["links.orphan"]);
  });

  it("claims the checklist id, severity and category the table assigns", () => {
    const orphan = rule("links.orphan");
    expect(orphan.checkIds).toEqual(["CHECK-32"]);
    expect(orphan.severity).toBe("warning");
    expect(orphan.category).toBe("links");
    expect(orphan.kind).toBe("query");
    expect(orphan.title.length).toBeGreaterThan(5);
    expect(orphan.explanation.length).toBeGreaterThan(40);
    expect(orphan.rulesetVersion).toBeTruthy();
  });
});

describe("links.orphan against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    depth?: number;
    discoveredVia?: string;
  }

  /**
   * A crawl row that looks finished: a page cap the crawl did not reach, and
   * no frontier rows at all. The gate tests are the ones that make it look
   * unfinished, one condition at a time.
   */
  async function newCrawl(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: MAX_PAGES },
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 3,
      ...overrides,
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`.toLowerCase().replace(/\/$/, ""),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: writerIndexable(s),
      robotsMeta: s.robotsMeta ?? null,
      xRobotsTag: s.xRobotsTag ?? null,
      depth: s.depth ?? 1,
      discoveredVia: s.discoveredVia ?? "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLink(
    crawlId: string,
    fromId: string,
    targetPath: string,
    isInternal = true,
  ): Promise<void> {
    await db.insert(links).values({
      crawlId,
      sourcePageId: fromId,
      targetUrl: `${SITE}${targetPath}`,
      targetPageId: null,
      anchor: "read this",
      rel: null,
      isInternal,
      isNofollow: false,
      position: 0,
    });
  }

  const url = (path: string): string => `${SITE}${path}`;

  async function orphans(crawlId: string): Promise<Finding[]> {
    return rule("links.orphan").run(db, crawlId);
  }

  /** The seed row every crawl has: depth 0, discovered as the seed. */
  const SEED: PageSpec = { path: "/", depth: 0, discoveredVia: "seed" };

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("is silent on a complete crawl where every page has an inbound link", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [SEED, { path: "/a" }, { path: "/b" }]);
    await addLink(crawlId, ids.get("/")!, "/a");
    await addLink(crawlId, ids.get("/a")!, "/b");

    expect(await orphans(crawlId)).toHaveLength(0);
  });

  it("reports an indexable 200 page nothing links to, with its discovery evidence", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [SEED, { path: "/linked" }, { path: "/lonely" }]);
    await addLink(crawlId, ids.get("/")!, "/linked");

    const found = await orphans(crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "links.orphan",
      severity: "warning",
      pageId: ids.get("/lonely"),
      pageUrl: url("/lonely"),
      dedupeKey: url("/lonely"),
    });
    expect(found[0]!.evidence).toEqual({
      inSitemap: false,
      discoveredVia: "link",
    });
  });

  // The seed is where the crawl started. Nothing on the site has to link to it
  // for it to be reachable, and reporting the homepage as an orphan on every
  // crawl would be the always-fires twin of a rule that always passes.
  it("never reports the crawl seed", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [SEED]);

    expect(await orphans(crawlId)).toHaveLength(0);
  });

  // A page listed in the sitemap and linked from nowhere IS the finding — the
  // sitemap is how a crawler found it, not how a reader would. `inSitemap`
  // says which kind of orphan it is rather than excusing it.
  it("reports a sitemap-only page and says so in the evidence", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      SEED,
      { path: "/from-sitemap", discoveredVia: "sitemap" },
    ]);
    await db.insert(sitemapUrls).values({
      crawlId,
      url: url("/from-sitemap"),
      sitemapSource: `${SITE}/sitemap.xml`,
      lastmod: null,
    });

    const found = await orphans(crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.pageUrl).toBe(url("/from-sitemap"));
    expect(found[0]!.evidence).toEqual({ inSitemap: true, discoveredVia: "sitemap" });
  });

  it("says nothing about pages that are not indexable 200s", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      SEED,
      { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      { path: "/moved", fetchClass: "redirect", statusCode: 301 },
      { path: "/boom", fetchClass: "server_error", statusCode: 503 },
      { path: "/asset.pdf", fetchClass: "non_html" },
      { path: "/noindexed", robotsMeta: "noindex" },
    ]);

    expect(await orphans(crawlId)).toHaveLength(0);
  });

  // The link rows are what the rule joins on, and `target_url` is the same
  // `normalizeUrl` output `pages.url` is — so a link to the page counts however
  // it was flagged, and a link to a different URL does not.
  it("counts any inbound link row, and only one that names the page's URL", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      SEED,
      { path: "/pointed-at" },
      { path: "/near-miss" },
    ]);
    await addLink(crawlId, ids.get("/")!, "/pointed-at");
    await addLink(crawlId, ids.get("/")!, "/near-miss-typo");

    const found = await orphans(crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/near-miss")]);
  });

  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    await addPages(other, [SEED, { path: "/lonely" }]);

    const mine = await newCrawl();
    const mineIds = await addPages(mine, [SEED, { path: "/linked" }]);
    await addLink(mine, mineIds.get("/")!, "/linked");

    expect(await orphans(mine)).toHaveLength(0);
    expect(await orphans(other)).toHaveLength(1);
  });

  describe("the completeness gate", () => {
    /**
     * The gate's whole point: the same page set that produces an orphan finding
     * on a complete crawl must produce the skipped finding — and no orphan
     * findings at all — on an incomplete one.
     */
    async function withAnOrphan(crawlId: string): Promise<void> {
      await addPages(crawlId, [SEED, { path: "/lonely" }]);
    }

    function expectSkipped(found: Finding[], matching: RegExp): void {
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "links.orphan",
        // Info, not warning: it is a statement about the crawl, not a fault
        // found on the site.
        severity: "info",
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
      });
      expect(String(found[0]!.evidence.skipped)).toMatch(matching);
    }

    it("skips, loudly, when the frontier still holds pending URLs", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values({
        crawlId,
        url: url("/never-fetched"),
        state: "pending",
        depth: 1,
        discoveredVia: "link",
      });

      const found = await orphans(crawlId);
      expectSkipped(found, /pending/i);
      expect(found[0]!.evidence).toMatchObject({ pending: 1, leased: 0, failed: 0 });
    });

    it("skips when the frontier holds failed URLs", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values({
        crawlId,
        url: url("/gave-up"),
        state: "failed",
        depth: 1,
        discoveredVia: "link",
      });

      expectSkipped(await orphans(crawlId), /failed/i);
    });

    // A lease outstanding when the crawl stopped is a URL nobody finished:
    // the same blind spot as a pending one, and silently treating it as done
    // would be the fallback this codebase does not do.
    it("skips when the frontier holds a lease nobody released", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values({
        crawlId,
        url: url("/in-flight"),
        state: "leased",
        depth: 1,
        discoveredVia: "link",
      });

      expectSkipped(await orphans(crawlId), /leased/i);
    });

    it("does not skip on a frontier whose rows are all done", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values({
        crawlId,
        url: url("/lonely"),
        state: "done",
        depth: 1,
        discoveredVia: "link",
      });

      const found = await orphans(crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("warning");
    });

    it("skips when the crawl stopped at its page cap", async () => {
      const crawlId = await newCrawl({ pagesCrawled: MAX_PAGES });
      await withAnOrphan(crawlId);

      const found = await orphans(crawlId);
      expectSkipped(found, new RegExp(String(MAX_PAGES)));
      expect(found[0]!.evidence).toMatchObject({
        pagesCrawled: MAX_PAGES,
        maxPages: MAX_PAGES,
      });
    });

    // Without a page cap on the crawl row there is no way to know whether the
    // crawl ran to completion or stopped early, and assuming it completed
    // would be a guess dressed up as a finding.
    it("skips when the crawl config records no page cap", async () => {
      const crawlId = await newCrawl({ config: {} });
      await withAnOrphan(crawlId);

      expectSkipped(await orphans(crawlId), /maxPages/);
    });

    it("throws, naming the crawl, when there is no crawl row to gate on", async () => {
      const missing = `crawl_${randomUUID()}`;
      await expect(rule("links.orphan").run(db, missing)).rejects.toThrow(missing);
    });
  });
});

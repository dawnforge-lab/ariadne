/**
 * The link-count derivation (Phase 29c), against a real database.
 *
 * Every number below is hand-derived from the graph drawn on `fixture`, not read
 * back out of the query: a test fed by its own SQL would only assert that the
 * query is deterministic.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { deriveLinkCounts } from "../../src/rules/derive/link-counts.js";
import { buildRegistry } from "../../src/rules/index.js";
import { inlinkCohort } from "../../src/rules/metric/link-metrics.js";
import { runRules } from "../../src/rules/run.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { mkDiscovery } from "./mk-discovery.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://link-counts.example";
const url = (path: string): string => `${SITE}${path}`;

type Kind = "ok" | "gone" | "redirect";
interface LinkSpec {
  from: string;
  /** A path, or an absolute URL for an external link. */
  to: string;
  nofollow?: boolean;
}

describe("deriveLinkCounts against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      hostKey: hostKeyOf(SITE),
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: [path: string, kind: Kind][]) {
    const rows = specs.map(([path, kind]) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(path),
      urlNormalised: url(path),
      fetchClass: kind === "redirect" ? "redirect" : kind === "gone" ? "http_error" : "ok",
      statusCode: kind === "redirect" ? 301 : kind === "gone" ? 404 : 200,
      isIndexable: kind === "ok",
      depth: 0,
      discoveredVia: "sitemap",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]![0], r.id]));
  }

  async function addLinks(crawlId: string, ids: Map<string, string>, specs: LinkSpec[]) {
    await db.insert(links).values(
      specs.map((l, position) => {
        const sourcePageId = ids.get(l.from);
        if (sourcePageId === undefined) throw new Error(`no page for ${l.from}`);
        const external = l.to.startsWith("http");
        return {
          crawlId,
          sourcePageId,
          targetUrl: external ? l.to : url(l.to),
          targetPageId: null,
          anchor: "see this",
          rel: null,
          isInternal: !external,
          isNofollow: l.nofollow === true,
          position,
        };
      }),
    );
  }

  async function columns(crawlId: string) {
    const rows = await db
      .select({
        url: pages.url,
        inlinks: pages.inlinksInternal,
        outInternal: pages.outlinksInternal,
        outExternal: pages.outlinksExternal,
      })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    return Object.fromEntries(
      rows.map((r) => [
        r.url.slice(SITE.length),
        { inlinks: r.inlinks, outInternal: r.outInternal, outExternal: r.outExternal },
      ]),
    );
  }

  /**
   *   /  ──▶ /a (twice: duplicate rows)      /gone  404
   *   /  ──▶ /b (nofollow)                   /r     301
   *   /a ──▶ /a (self), /a ──▶ /gone
   *   /b ──▶ ext.example (twice), /b ──▶ /never-crawled
   */
  async function fixture() {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      ["/", "ok"],
      ["/a", "ok"],
      ["/b", "ok"],
      ["/gone", "gone"],
      ["/r", "redirect"],
    ]);
    await addLinks(crawlId, ids, [
      { from: "/", to: "/a" },
      { from: "/", to: "/a" },
      { from: "/", to: "/b", nofollow: true },
      { from: "/a", to: "/a" },
      { from: "/a", to: "/gone" },
      { from: "/b", to: "https://ext.example/" },
      { from: "/b", to: "https://ext.example/" },
      { from: "/b", to: "/never-crawled" },
    ]);
    return { crawlId, ids };
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("counts distinct internal inlinks and distinct outlink targets by hand-derived values", async () => {
    const { crawlId } = await fixture();
    const result = await deriveLinkCounts(db, crawlId);
    expect(result).toEqual({ pages: 5, withInlinks: 3, analysed: 3 });
    expect(await columns(crawlId)).toEqual({
      "/": { inlinks: 0, outInternal: 2, outExternal: 0 },
      // Inlinks: `/` only. The self-link does not count; the duplicate rows are one source.
      "/a": { inlinks: 1, outInternal: 2, outExternal: 0 },
      // Inlinks: `/` (nofollow still counts).
      "/b": { inlinks: 1, outInternal: 1, outExternal: 1 },
      // A non-OK row still gets an inlink count, and no outlinks.
      "/gone": { inlinks: 1, outInternal: null, outExternal: null },
      "/r": { inlinks: 0, outInternal: null, outExternal: null },
    });
  });

  it("agrees with inlinks.distribution's cohort for every cohort page", async () => {
    const { crawlId } = await fixture();
    await deriveLinkCounts(db, crawlId);
    const cohort = await db.execute<{ url: string; v: number }>(inlinkCohort(crawlId));
    expect(cohort.rows.length).toBeGreaterThan(0);
    const stored = await columns(crawlId);
    for (const row of cohort.rows) {
      expect(stored[row.url.slice(SITE.length)]!.inlinks, row.url).toBe(row.v);
    }
  });

  it("replaces a stale answer on a re-run", async () => {
    const { crawlId } = await fixture();
    await deriveLinkCounts(db, crawlId);
    const before = await columns(crawlId);
    await db.execute(
      sql`update pages set inlinks_internal = 99, outlinks_internal = 99, outlinks_external = 99
          where crawl_id = ${crawlId} and url = ${url("/a")}`,
    );
    await deriveLinkCounts(db, crawlId);
    expect(await columns(crawlId)).toEqual(before);
  });

  it("writes 0 on analysed pages and null elsewhere for a crawl with no links", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      ["/", "ok"],
      ["/gone", "gone"],
    ]);
    await deriveLinkCounts(db, crawlId);
    expect(await columns(crawlId)).toEqual({
      "/": { inlinks: 0, outInternal: 0, outExternal: 0 },
      "/gone": { inlinks: 0, outInternal: null, outExternal: null },
    });
  });

  it("throws for a crawl nothing knows", async () => {
    await expect(deriveLinkCounts(db, "crawl_does_not_exist")).rejects.toThrow(/no such crawl/);
  });

  it("runs in the derive step and reports pages and timing", async () => {
    const { crawlId } = await fixture();
    const summary = await runRules(db, crawlId, buildRegistry());
    expect(summary.derived["deriveLinkCounts.pages"]).toBe(5);
    expect(summary.derived["deriveLinkCounts.withInlinks"]).toBe(3);
    expect(summary.derived["deriveLinkCounts.analysed"]).toBe(3);
    expect(summary.derivedMs["deriveLinkCounts"]).toBeGreaterThanOrEqual(0);
    expect(Object.keys(summary.derivedMs).sort()).toEqual([
      "deriveClickDepth",
      "deriveLinkCounts",
      "deriveSchemaValidation",
      "deriveSitemapHreflang",
      "deriveUrlParams",
    ]);
  });
});

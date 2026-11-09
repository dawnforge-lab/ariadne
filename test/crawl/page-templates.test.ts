/**
 * Phase 2 of the page-type derivation: `collapseTemplates` over a whole crawl's
 * population, and `inferPageTemplates` over a real one in Postgres.
 *
 * The acceptance case is the Phase 6/7 gate site (lavishalice.com), whose page
 * typing was reported as a defect four times running: 196 distinct types over
 * 551 pages, 190 of them occurring exactly once, and `(untyped)` never. The
 * corpus below is a RECONSTRUCTION of that crawl's URL shapes, not a copy of
 * its URL list — the audit recorded the four real templates and their sizes
 * (`/products/:slug` 211, `/collections/:slug` 115, `/pages/:slug` 29, a blog
 * handful) and the shape of the tail, and the paths in `audits/` supplied the
 * spellings. It lands 196 types over 551 pages against the audit's 196 over
 * 551, and 192 singletons against its 190: the exact spread of the tail was
 * never written down, only its size and its shape.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import {
  collapseTemplates,
  derivePageType,
  inferPageTemplates,
  MIN_COHORT,
  type TemplateMember,
} from "../../src/crawl/page-type.js";

const SITE = "https://lavishalice.com";

/**
 * The population as the SQL presents it: one member per page type, carrying the
 * number of distinct PATHS under it — query strings dropped, exactly as
 * `inferPageTemplates`' group-by drops them.
 */
function population(paths: readonly string[]): TemplateMember[] {
  const byType = new Map<string, Set<string>>();
  for (const path of paths) {
    const url = new URL(`${SITE}${path}`);
    const type = derivePageType(url.href);
    const seen = byType.get(type);
    if (seen === undefined) byType.set(type, new Set([url.pathname]));
    else seen.add(url.pathname);
  }
  return [...byType].map(([pageType, distinct]) => ({ pageType, paths: distinct.size }));
}

/** The types this population ends up with, once the collapse has been applied. */
function typesAfter(paths: readonly string[]): Map<string, number> {
  const members = population(paths);
  const mapping = collapseTemplates(members);
  const counts = new Map<string, number>();
  for (const path of paths) {
    const before = derivePageType(`${SITE}${path}`);
    const after = mapping.get(before) ?? before;
    counts.set(after, (counts.get(after) ?? 0) + 1);
  }
  return counts;
}

/** `n` paths under `prefix` whose last segment has `hyphenParts` hyphen-separated parts. */
function generated(prefix: string, n: number, hyphenParts: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const parts = Array.from({ length: hyphenParts - 1 }, (_, p) => `w${p}`);
    return `${prefix}${[...parts, `n${i}`].join("-")}`;
  });
}

/**
 * The gate site, reconstructed. Sizes from the Phase 7 gate table; spellings in
 * the same shapes the audit's own URLs take (`/collections/activewear` and
 * `/collections/all-white` are literal under the slug rule, `/collections/
 * a-line-dresses` is not).
 */
const LAVISHALICE: string[] = [
  // The four real templates.
  ...generated("/products/", 211, 4), // long Shopify product handles
  ...generated("/collections/", 111, 3),
  ...generated("/pages/", 29, 3),
  ...generated("/blogs/blog/", 8, 4),
  // The tail the slug rule left literal: one type per URL.
  ...generated("/collections/x", 82, 1), // one-word handles: /collections/activewear
  ...generated("/collections/", 82, 2), // two-part handles: /collections/all-white
  ...generated("/pages/y", 10, 1),
  ...generated("/pages/", 10, 2),
  // Real one-offs from the crawl.
  "/collections/new-in/products/high-waisted-leggings-in-sage-sculpology",
  "/blogs/blog",
  "/blogs/news",
  "/apps/wishlist",
  "/",
  "/cart",
  "/search",
  "/agents.md",
];

describe("collapseTemplates — the gate site", () => {
  it("reconstructs the defect: 196 types over 551 pages, 192 of them singletons", () => {
    expect(LAVISHALICE.length).toBe(551);
    const members = population(LAVISHALICE);
    expect(members.length).toBe(196);
    expect(members.filter((m) => m.paths === 1).length).toBe(192);
  });

  it("collapses 196 types into the four real templates and an honest tail", () => {
    const after = typesAfter(LAVISHALICE);

    // The four templates the audit could not name from the crawl's own ids.
    expect(after.get("/products/:slug")).toBe(211);
    expect(after.get("/collections/:slug")).toBe(111 + 164);
    expect(after.get("/pages/:slug")).toBe(29 + 20);
    expect(after.get("/blogs/blog/:slug")).toBe(8);

    // ...and the tail, which is every page that is genuinely one of a kind.
    // Nothing is swept into an `(other)` bucket: each of these still says what
    // it is, which is the whole reason the collapse stops where it does.
    expect([...after.keys()].sort()).toEqual([
      "/",
      "/agents.md",
      "/apps/wishlist",
      "/blogs/blog",
      "/blogs/blog/:slug",
      "/blogs/news",
      "/cart",
      "/collections/:slug",
      "/collections/new-in/products/:slug",
      "/pages/:slug",
      "/search",
      "/products/:slug",
    ].sort());

    // Every page still has a type, and the count of them is a number an
    // auditor can work with.
    expect([...after.values()].reduce((a, b) => a + b, 0)).toBe(551);
    expect(after.size).toBe(12);
  });

  it("is idempotent: collapsing the collapsed population changes nothing", () => {
    const first = collapseTemplates(population(LAVISHALICE));
    const collapsed = LAVISHALICE.map((path) => {
      const type = derivePageType(`${SITE}${path}`);
      return first.get(type) ?? type;
    });
    // The second pass sees the types the first one produced, presented the way
    // the SQL presents them: one member per distinct type.
    const byType = new Map<string, number>();
    for (const type of collapsed) byType.set(type, (byType.get(type) ?? 0) + 1);
    const second = collapseTemplates(
      [...byType].map(([pageType, paths]) => ({ pageType, paths })),
    );
    expect([...second]).toEqual([]);
  });
});

describe("collapseTemplates — the collapse boundary", () => {
  const family = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `/services/seo-${i}`);

  it(`leaves a family of ${MIN_COHORT - 1} alone: two hand-written pages are two pages`, () => {
    const after = typesAfter(family(MIN_COHORT - 1));
    expect([...after.keys()].sort()).toEqual(["/services/seo-0", "/services/seo-1"]);
  });

  it(`collapses a family of ${MIN_COHORT}: three of a shape is a generator`, () => {
    const after = typesAfter(family(MIN_COHORT));
    expect([...after.keys()]).toEqual(["/services/:slug"]);
    expect(after.get("/services/:slug")).toBe(MIN_COHORT);
  });

  it("counts distinct paths, not pages: one page's query variants are one member", () => {
    // Three URLs, one path. The family has one member type and one path, so
    // nothing collapses — counting pages would have made this look like three.
    const members = population([
      "/services/seo-a",
      "/services/seo-a?ref=one",
      "/services/seo-a?ref=two",
    ]);
    expect(members).toEqual([{ pageType: "/services/seo-a", paths: 1 }]);
    expect([...collapseTemplates([...members, { pageType: "/services/ppc", paths: 1 }])]).toEqual(
      [],
    );
  });

  it("an established template absorbs the singleton beside it", () => {
    // `/collections/:slug` alone is 115 pages; `/collections/all` is one page
    // of the same family and joins it.
    const after = typesAfter([...generated("/collections/", 115, 3), "/collections/all"]);
    expect([...after.keys()]).toEqual(["/collections/:slug"]);
    expect(after.get("/collections/:slug")).toBe(116);
  });

  it("leaves a lone template its own name: /blog/:id does not become /blog/:slug", () => {
    // One member type, nothing to merge with — renaming it would throw away
    // the fact that this site's post ids are numeric.
    const after = typesAfter(["/blog/17", "/blog/18", "/blog/19", "/blog/20"]);
    expect([...after.keys()]).toEqual(["/blog/:id"]);
  });

  it("merges a family split across param spellings", () => {
    // The Phase 4/5 sighting: `/blog/17` types as `/blog/:id` and
    // `/blog/a-long-post-title` as `/blog/:slug`, so one blog reads as two
    // templates. They share a family and now share a type.
    const after = typesAfter([
      "/blog/17",
      "/blog/18",
      "/blog/a-long-post-title",
      "/blog/another-long-title",
    ]);
    expect([...after.keys()]).toEqual(["/blog/:slug"]);
    expect(after.get("/blog/:slug")).toBe(4);
  });
});

describe("collapseTemplates — what it refuses to collapse", () => {
  it("does not over-collapse a genuinely diverse small site", () => {
    const site = [
      "/",
      "/about",
      "/contact",
      "/services/seo",
      "/services/ppc",
      "/blog/a-first-post-here",
      "/blog/a-second-post-here",
      "/blog/a-third-post-here",
    ];
    const after = typesAfter(site);
    expect([...after.keys()].sort()).toEqual([
      "/",
      "/about",
      "/blog/:slug",
      "/contact",
      "/services/ppc",
      "/services/seo",
    ]);
  });

  it("never fuses root-level routes: there is no /:slug bucket", () => {
    const after = typesAfter(["/", "/cart", "/search", "/account", "/challenge"]);
    expect([...after.keys()].sort()).toEqual([
      "/",
      "/account",
      "/cart",
      "/challenge",
      "/search",
    ]);
  });

  it("collapses one level only: sections keep their names", () => {
    const after = typesAfter([
      ...generated("/blogs/news/", 5, 4),
      "/blogs/news/one-off",
      ...generated("/blogs/press/", 5, 4),
      "/blogs/press/one-off",
    ]);
    expect([...after.keys()].sort()).toEqual(["/blogs/news/:slug", "/blogs/press/:slug"]);
  });

  it("leaves a client-named page type alone", () => {
    // A type nobody derived from a path is a name somebody chose, and the pass
    // has no business rewriting it — even beside a family that does collapse.
    const members: TemplateMember[] = [
      { pageType: "product", paths: 200 },
      { pageType: "Category page", paths: 40 },
      { pageType: "/collections/:slug", paths: 10 },
      { pageType: "/collections/all", paths: 1 },
      { pageType: "/collections/all-white", paths: 1 },
    ];
    expect([...collapseTemplates(members)].sort()).toEqual([
      ["/collections/all", "/collections/:slug"],
      ["/collections/all-white", "/collections/:slug"],
    ]);
  });
});

// ---------------------------------------------------------------- the DB pass

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

describe("inferPageTemplates", () => {
  let db: Db;
  const created: string[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  /** A crawl whose pages are exactly `paths`, typed the way the crawler types them. */
  async function crawlOf(paths: readonly string[]): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    created.push(id);
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 1000 },
      rulesetVersion: "test",
      status: "finished",
    });
    await db.insert(pages).values(
      paths.map((path) => ({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url: `${SITE}${path}`,
        urlNormalised: `${SITE}${path}`,
        pageType: derivePageType(`${SITE}${path}`),
        statusCode: 200,
        fetchClass: "ok",
        depth: 1,
        discoveredVia: "link",
      })),
    );
    return id;
  }

  async function typeCensus(crawlId: string): Promise<Map<string | null, number>> {
    const rows = await db.execute<{ page_type: string | null; n: number }>(sql`
      select page_type, count(*)::int as n from pages
      where crawl_id = ${crawlId} group by page_type`);
    return new Map(rows.rows.map((r) => [r.page_type, r.n]));
  }

  it("retypes the crawl's pages in place and reports what it did", async () => {
    const crawlId = await crawlOf(LAVISHALICE);
    const result = await inferPageTemplates(db, crawlId);
    expect(result).toEqual({ typesBefore: 196, typesAfter: 12, pagesRetyped: 184 });

    const census = await typeCensus(crawlId);
    expect(census.get("/collections/:slug")).toBe(275);
    expect(census.get("/pages/:slug")).toBe(49);
    expect(census.get("/products/:slug")).toBe(211);
    expect(census.size).toBe(12);
  });

  it("is idempotent against the database, not only in the algorithm", async () => {
    const crawlId = await crawlOf(LAVISHALICE);
    await inferPageTemplates(db, crawlId);
    const once = await typeCensus(crawlId);
    const again = await inferPageTemplates(db, crawlId);
    expect(again).toEqual({ typesBefore: 12, typesAfter: 12, pagesRetyped: 0 });
    expect(await typeCensus(crawlId)).toEqual(once);
  });

  it("leaves an untyped page untyped: no bucket is invented for it", async () => {
    const crawlId = await crawlOf(["/collections/all", "/collections/all-white", "/collections/red"]);
    await db
      .update(pages)
      .set({ pageType: null })
      .where(eq(pages.url, `${SITE}/collections/red`));
    const result = await inferPageTemplates(db, crawlId);
    // Two typed pages left, which is under MIN_COHORT — the null page is not
    // counted into the family it would have belonged to.
    expect(result).toEqual({ typesBefore: 2, typesAfter: 2, pagesRetyped: 0 });
    expect((await typeCensus(crawlId)).get(null)).toBe(1);
  });

  it("touches no other crawl's pages", async () => {
    const mine = await crawlOf(["/collections/all", "/collections/all-white", "/collections/red"]);
    const theirs = await crawlOf(["/collections/all", "/collections/all-white", "/collections/red"]);
    await inferPageTemplates(db, mine);
    expect((await typeCensus(mine)).get("/collections/:slug")).toBe(3);
    expect((await typeCensus(theirs)).get("/collections/:slug")).toBeUndefined();
  });

  it("throws on a crawl id nothing knows (no silent zero)", async () => {
    await expect(inferPageTemplates(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
  });

  it("retypes every pair across several update batches: 1,201 singleton shapes, three batches", async () => {
    // RETYPE_BATCH is 500: 1,201 pairs are batches of 500, 500 and 1. The pairs
    // are built batch by batch (gate 27c: building all of them first cost
    // 23.5 MB at 40,000 shapes), so every slice boundary is exercised here.
    const paths = Array.from({ length: 1201 }, (_, i) => `/products/p${i}`);
    const crawlId = await crawlOf(paths);
    const result = await inferPageTemplates(db, crawlId);
    expect(result).toEqual({ typesBefore: 1201, typesAfter: 1, pagesRetyped: 1201 });
    expect(await typeCensus(crawlId)).toEqual(new Map([["/products/:slug", 1201]]));
  });
});

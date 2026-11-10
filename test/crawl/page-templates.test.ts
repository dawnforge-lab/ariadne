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
import { and, eq, sql } from "drizzle-orm";

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

  it("retypes every pair of 1,201 singleton shapes (once three 27c batches)", async () => {
    // 27c retyped in batches of 500 (RETYPE_BATCH), so 1,201 pairs crossed two
    // slice boundaries. 27d collapses in one SQL statement and has no batches;
    // the census is kept as it was so the 27c case still holds unchanged.
    const paths = Array.from({ length: 1201 }, (_, i) => `/products/p${i}`);
    const crawlId = await crawlOf(paths);
    const result = await inferPageTemplates(db, crawlId);
    expect(result).toEqual({ typesBefore: 1201, typesAfter: 1, pagesRetyped: 1201 });
    expect(await typeCensus(crawlId)).toEqual(new Map([["/products/:slug", 1201]]));
  });
});

// --------------------------------------------- the collapse in SQL (27d T9)

/**
 * `inferPageTemplates` collapses in ONE data-modifying SQL statement (27d,
 * hard rule 6), and `collapseTemplates` above stays as its oracle. These tests
 * pin the two together and pin the memory contract structurally: what comes
 * back to this process does not grow with the number of URL shapes.
 */
describe("inferPageTemplates — the collapse in SQL (27d)", () => {
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

  async function emptyCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    created.push(id);
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 100_000 },
      rulesetVersion: "test",
      status: "finished",
    });
    return id;
  }

  /**
   * A crawl carrying exactly `members`: `paths` pages per type, each on its own
   * path, with `page_type` written as given — client names and raw shapes
   * included, so the SQL predicate meets inputs `derivePageType` would never
   * produce as well as the ones it does. Each page's URL records the index of
   * the member it was written under, so the retyping can be read back per type.
   */
  async function crawlOfMembers(members: readonly TemplateMember[]): Promise<string> {
    const id = await emptyCrawl();
    const rows = members.flatMap((member, m) =>
      Array.from({ length: member.paths }, (_, j) => ({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url: `${SITE}/member-${m}/path-${j}`,
        urlNormalised: `${SITE}/member-${m}/path-${j}`,
        pageType: member.pageType,
        statusCode: 200,
        fetchClass: "ok",
        depth: 1,
        discoveredVia: "link",
      })),
    );
    if (rows.length > 0) await db.insert(pages).values(rows);
    return id;
  }

  /** member index -> the page type its pages carry now (one value per member, or it throws). */
  async function typeByMember(crawlId: string): Promise<Map<number, string>> {
    const rows = await db.execute<{ m: number; page_type: string }>(sql`
      select distinct split_part(split_part(url, '/member-', 2), '/', 1)::int as m, page_type
      from pages where crawl_id = ${crawlId}`);
    const out = new Map<number, string>();
    for (const row of rows.rows) {
      if (out.has(row.m)) throw new Error(`member ${row.m} was split across two page types`);
      out.set(row.m, row.page_type);
    }
    return out;
  }

  const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

  /**
   * The parity population: every way a type can enter, or fail to enter, a
   * family under `detectUrlTemplate`'s rule, and every way a family can pass or
   * fail the collapse. Comments name the case; the oracle decides the answer.
   */
  const PARITY: TemplateMember[] = [
    // Family /a/:slug — collapses: many members, mixed spellings.
    { pageType: "/a/plain", paths: 1 }, // one-word segment: member
    { pageType: "/a/one-two", paths: 1 }, // one hyphen: member
    { pageType: "/a/-", paths: 1 }, // one hyphen, nothing else: member
    { pageType: "/a/-x", paths: 2 }, // one leading hyphen: member
    { pageType: "/a/one-two-three", paths: 4 }, // two hyphens: a slug, not ours
    { pageType: "/a/--", paths: 1 }, // two hyphens, nothing else: not ours
    { pageType: "/a/123", paths: 3 }, // all digits: an id, not ours
    { pageType: "/a/0", paths: 1 }, // one digit: not ours
    { pageType: "/a/12a", paths: 1 }, // digits and a letter: member
    { pageType: "/a/١٢٣", paths: 1 }, // Arabic-Indic digits: not [0-9], so member
    { pageType: "/a/123\n", paths: 1 }, // digits then a newline: `$` is end of string, member
    { pageType: "/a/2024-01-15", paths: 1 }, // a date: not ours
    { pageType: `/a/${UUID}`, paths: 1 }, // a UUID: not ours
    { pageType: "/a/:id", paths: 2 }, // a detected id template: member
    { pageType: "/a/x‐y‐z", paths: 1 }, // Unicode hyphens are not '-': member
    { pageType: "/a/b/", paths: 1 }, // trailing slash: not its own template
    { pageType: "/a//b", paths: 1 }, // doubled slash: not its own template
    { pageType: "//a/b", paths: 1 }, // leading doubled slash: not its own template
    { pageType: "a/b", paths: 1 }, // no leading slash: not its own template
    // Family /c/:slug — collapses, and the family name is itself a member: it
    // counts toward the cohort and is not retyped.
    { pageType: "/c/:slug", paths: 5 },
    { pageType: "/c/x", paths: 1 },
    // Family /d/:slug — the family name alone: one member, nothing to merge.
    { pageType: "/d/:slug", paths: 9 },
    // Family /e/:slug — the family name and one member, two paths: under MIN_COHORT.
    { pageType: "/e/:slug", paths: 1 },
    { pageType: "/e/y", paths: 1 },
    // Family /f/:slug — one member, many paths: nothing to merge.
    { pageType: "/f/:id", paths: 7 },
    // Family /g/:slug — two members, two paths: under MIN_COHORT.
    { pageType: "/g/one", paths: 1 },
    { pageType: "/g/two", paths: 1 },
    // Family /h/:slug — two members, exactly MIN_COHORT paths: collapses.
    { pageType: "/h/one", paths: 1 },
    { pageType: "/h/two", paths: 2 },
    // Deeper families, one level only: /i/j/:slug and /i/k/:slug stay apart.
    { pageType: "/i/j/p", paths: 1 },
    { pageType: "/i/j/q", paths: 1 },
    { pageType: "/i/j/r", paths: 1 },
    { pageType: "/i/k/p", paths: 1 },
    { pageType: "/i/k/q", paths: 1 },
    { pageType: "/i/:id/p", paths: 1 }, // a placeholder in the prefix is still a member
    { pageType: "/i/:id/q", paths: 2 },
    { pageType: "/i/123/p", paths: 1 }, // a raw id in the prefix: not ours
    // Single segments: no family, ever.
    { pageType: "/", paths: 1 },
    { pageType: "/cart", paths: 1 },
    { pageType: "/search", paths: 1 },
    { pageType: "/:slug", paths: 4 },
    { pageType: "/products", paths: 6 }, // a client type spelled like a path, one segment
    // Client names: never ours.
    { pageType: "product", paths: 200 },
    { pageType: "Category page", paths: 40 },
    { pageType: "blog/post", paths: 3 },
    // A client type spelled like a two-segment path is indistinguishable from
    // a detected one and is treated as one — the documented blind spot.
    { pageType: "/collections/sale", paths: 1 },
    { pageType: "/collections/all", paths: 1 },
    { pageType: "/collections/new", paths: 1 },
  ];

  it("matches the JS oracle over every fixture type, type by type", async () => {
    expect(PARITY.length).toBeGreaterThanOrEqual(40);
    expect(new Set(PARITY.map((m) => m.pageType)).size).toBe(PARITY.length);
    const mapping = collapseTemplates(PARITY);
    // The fixture exercises both answers, or it pins nothing.
    expect(mapping.size).toBeGreaterThan(5);
    expect(PARITY.length - mapping.size).toBeGreaterThan(20);

    const crawlId = await crawlOfMembers(PARITY);
    const result = await inferPageTemplates(db, crawlId);

    const expected = new Map(PARITY.map((m, i) => [i, mapping.get(m.pageType) ?? m.pageType]));
    expect(await typeByMember(crawlId)).toEqual(expected);
    expect(result).toEqual({
      typesBefore: PARITY.length,
      typesAfter: new Set(expected.values()).size,
      pagesRetyped: PARITY.filter((m) => mapping.has(m.pageType)).reduce((a, m) => a + m.paths, 0),
    });
  });

  it("is idempotent: a second run over the parity population retypes nothing", async () => {
    const crawlId = await crawlOfMembers(PARITY);
    const first = await inferPageTemplates(db, crawlId);
    const once = await typeByMember(crawlId);
    const again = await inferPageTemplates(db, crawlId);
    expect(again).toEqual({
      typesBefore: first.typesAfter,
      typesAfter: first.typesAfter,
      pagesRetyped: 0,
    });
    expect(await typeByMember(crawlId)).toEqual(once);
  });

  it("reports zeros, and records that it ran, on a crawl with no typed pages", async () => {
    const none = await emptyCrawl();
    expect(await inferPageTemplates(db, none)).toEqual({
      typesBefore: 0,
      typesAfter: 0,
      pagesRetyped: 0,
    });

    const untyped = await crawlOfMembers([
      { pageType: "", paths: 2 },
      { pageType: "/x/placeholder", paths: 1 },
    ]);
    await db
      .update(pages)
      .set({ pageType: null })
      .where(and(eq(pages.crawlId, untyped), eq(pages.pageType, "/x/placeholder")));
    expect(await inferPageTemplates(db, untyped)).toEqual({
      typesBefore: 0,
      typesAfter: 0,
      pagesRetyped: 0,
    });

    const [row] = await db
      .select({ marker: crawls.templateInferenceJsonb })
      .from(crawls)
      .where(eq(crawls.id, none));
    expect(row!.marker).toMatchObject({ shapesBefore: 0, typesAfter: 0, retyped: 0 });
  });

  /**
   * THE MEMORY CONTRACT, structurally (hard rule 6). A heap delta is GC noise;
   * what the process holds is bounded by what the database sends it, so the
   * test watches the pg client. Over 40,002 singleton shapes — the 50k gate's
   * worst case, every product URL its own shape — no statement returns more
   * than one row, the collapse and the retype are ONE statement, and the
   * statements sent are the same ones a three-shape crawl sends.
   */
  it("sends one collapse statement and gets one row back, at 3 shapes and at 40,002", async () => {
    const { default: pg } = await import("pg");
    const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    type Sent = { text: string; rows: number };

    async function watched(crawlId: string): Promise<{
      result: Awaited<ReturnType<typeof inferPageTemplates>>;
      sent: Sent[];
      elapsedMs: number;
    }> {
      const original = proto.query;
      const sent: Sent[] = [];
      const record = (text: string, res: unknown): void => {
        const rows = (res as { rows?: unknown } | undefined)?.rows;
        sent.push({ text, rows: Array.isArray(rows) ? rows.length : 0 });
      };
      proto.query = function (this: object, ...args: unknown[]): unknown {
        const first = args[0];
        const text = String(
          typeof first === "string" ? first : (first as { text?: string } | undefined)?.text,
        );
        const last = args.at(-1);
        if (typeof last === "function") {
          args[args.length - 1] = (err: unknown, res: unknown): unknown => {
            if (err === null || err === undefined) record(text, res);
            return (last as (...a: unknown[]) => unknown)(err, res);
          };
          return original.apply(this, args);
        }
        const out = original.apply(this, args);
        if (out instanceof Promise) {
          return out.then((res: unknown) => {
            record(text, res);
            return res;
          });
        }
        return out;
      };
      try {
        const started = Date.now();
        const result = await inferPageTemplates(db, crawlId);
        return { result, sent, elapsedMs: Date.now() - started };
      } finally {
        proto.query = original;
      }
    }

    async function singletons(n: number): Promise<string> {
      const id = await emptyCrawl();
      // One statement, so seeding 40,002 rows costs the test seconds, not a minute.
      await db.execute(sql`
        insert into pages (id, crawl_id, url, url_normalised, page_type, status_code,
                           fetch_class, depth, discovered_via)
        select 'page_' || ${id} || '_' || i, ${id},
               ${SITE} || '/products/p' || i, ${SITE} || '/products/p' || i,
               '/products/p' || i, 200, 'ok', 1, 'link'
        from generate_series(1, ${n}::int) as i`);
      return id;
    }

    const small = await watched(await singletons(3));
    const large = await watched(await singletons(40_002));

    expect(small.result).toEqual({ typesBefore: 3, typesAfter: 1, pagesRetyped: 3 });
    expect(large.result).toEqual({ typesBefore: 40_002, typesAfter: 1, pagesRetyped: 40_002 });

    for (const run of [small, large]) {
      // Nothing that comes back grows with the population: at most one row a
      // statement (the crawl lookup, the counts row).
      expect(run.sent.filter((s) => s.rows > 1).map((s) => s.text.slice(0, 120))).toEqual([]);
      // The collapse and the retype are one statement, and it is the only one
      // that touches `pages`.
      const touchingPages = run.sent.filter((s) => /\bpages\b/i.test(s.text));
      expect(touchingPages).toHaveLength(1);
      expect(touchingPages[0]!.text).toMatch(/update\s+pages/i);
      expect(touchingPages[0]!.text).toMatch(/partition\s+by/i);
      expect(touchingPages[0]!.rows).toBe(1);
      // THE PLANNER SETTING (ruling R13), sent inside the transaction and
      // before the collapse: without it, stale statistics at crawl close plan
      // the retype as a quadratic nested loop.
      const setting = run.sent.findIndex((s) => /set\s+local\s+enable_nestloop\s*=\s*off/i.test(s.text));
      expect(setting, "set local enable_nestloop = off was never sent").toBeGreaterThanOrEqual(0);
      expect(setting).toBeLessThan(run.sent.indexOf(touchingPages[0]!));
    }
    // A quadratic plan fails here by name, not on the test's 120 s timeout: the
    // hash join takes ~4-5 s at 40,002 shapes.
    expect(large.elapsedMs, "inferPageTemplates at 40,002 shapes (ms)").toBeLessThan(30_000);
    // The same statements, in the same order, whatever the number of shapes.
    expect(large.sent.map((s) => s.text)).toEqual(small.sent.map((s) => s.text));
  }, 120_000);
});

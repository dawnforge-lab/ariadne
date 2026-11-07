/**
 * `page.weight` against a real database (P11-T3).
 *
 * The arithmetic is hand-derived in each case and asserted against the rows the
 * metric writes, so a change to the statement fails against a number a reader
 * can check rather than against a snapshot.
 *
 * TWO BOUNDS, NEITHER OF THEM A GUESS, and every case here is about one of
 * them. The sum is a CEILING because `page_resources` double-counts an `<img>`
 * carrying both `src` and `srcset` (schema.ts's own caveat), and a FLOOR
 * whenever a referenced file was never weighed — unasked, refused, disallowed,
 * failed, or answered without a size. The row says which pages are in the second
 * case (`pagesWithUnmeasuredResources`) and carries `atLeast` when any is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pageResources, pages, resources } from "../../src/db/schema.js";
import { resourceMetrics } from "../../src/rules/metric/resource-metrics.js";
import {
  databaseUrl,
  dropCrawls,
  expectRefusesUnknownCrawl,
  metricLookup,
  metricRowsByScope,
  newMetricCrawl,
} from "./metric-db.js";

const SITE = "https://weight.example";
const rule = metricLookup(resourceMetrics, "resourceMetrics");

describe("resourceMetrics metadata", () => {
  it("defines the page-weight metric and claims the checks it evidences", () => {
    expect(resourceMetrics.map((r) => r.id)).toEqual(["page.weight"]);
    const weight = rule("page.weight");
    // CHECK-48 for the JS half (bundle size per template — the render-blocking
    // half stays browser work) and CHECK-49 for the image half.
    expect(weight.checkIds).toEqual(["CHECK-48", "CHECK-49"]);
    expect(weight.kind).toBe("metric");
    expect(weight.severity).toBe("info");
    expect(weight.category).toBe("technical");
  });
});

describe("page.weight against the database", () => {
  let db: Db;
  const created: string[] = [];

  interface PageSpec {
    path: string;
    pageType?: string | null;
    htmlBytes?: number | null;
    isIndexable?: boolean;
    statusCode?: number;
    fetchClass?: string;
  }

  interface ResourceSpec {
    url: string;
    kind?: string;
    fetchClass?: string | null;
    bytes?: number | null;
    on: string[];
  }

  async function seed(
    pageSpecs: PageSpec[],
    resourceSpecs: ResourceSpec[],
  ): Promise<string> {
    const crawlId = await newMetricCrawl(db, SITE, created);
    const rows = pageSpecs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`,
      pageType: s.pageType === undefined ? "content" : s.pageType,
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode ?? 200,
      isIndexable: s.isIndexable ?? true,
      depth: 1,
      discoveredVia: "link",
      htmlBytes: s.htmlBytes === undefined ? 10_000 : s.htmlBytes,
    }));
    if (rows.length > 0) await db.insert(pages).values(rows);
    const ids = new Map(pageSpecs.map((s, i) => [s.path, rows[i]!.id]));

    if (resourceSpecs.length > 0) {
      await db.insert(resources).values(
        resourceSpecs.map((s) => ({
          crawlId,
          url: `${SITE}${s.url}`,
          kind: s.kind ?? "image",
          fetchClass: s.fetchClass === undefined ? "ok" : s.fetchClass,
          statusCode: s.fetchClass === null ? null : 200,
          bytes: s.bytes === undefined ? 1_000 : s.bytes,
          bytesSource: "header",
        })),
      );
      await db.insert(pageResources).values(
        resourceSpecs.flatMap((s) =>
          s.on.map((path) => ({ crawlId, pageId: ids.get(path)!, resourceUrl: `${SITE}${s.url}` })),
        ),
      );
    }
    return crawlId;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await dropCrawls(db, created);
    await closeDb(db);
  });

  it("sums each page's HTML and its weighed resources, per template and for the site", async () => {
    const crawlId = await seed(
      [
        { path: "/p1", pageType: "product", htmlBytes: 10_000 },
        { path: "/p2", pageType: "product", htmlBytes: 20_000 },
        { path: "/b1", pageType: "blog", htmlBytes: 30_000 },
      ],
      [
        // Shared by both product pages: one row, two edges, counted on both.
        { url: "/img/hero.png", bytes: 100_000, on: ["/p1", "/p2"] },
        { url: "/css/app.css", kind: "css", bytes: 50_000, on: ["/p1", "/p2", "/b1"] },
        { url: "/js/app.js", kind: "js", bytes: 200_000, on: ["/p2"] },
      ],
    );

    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    // /p1 = 10,000 + 100,000 + 50,000 = 160,000
    // /p2 = 20,000 + 100,000 + 50,000 + 200,000 = 370,000
    // /b1 = 30,000 + 50,000 = 80,000
    expect(rows["page_type|product"]).toMatchObject({
      pageWeight: { count: 2, min: 160_000, max: 370_000, mean: 265_000 },
      htmlBytes: { count: 2, min: 10_000, max: 20_000 },
      imageBytes: { count: 2, min: 100_000, max: 100_000 },
      cssBytes: { count: 2, min: 50_000, max: 50_000 },
      jsBytes: { count: 2, min: 0, max: 200_000 },
      resourcesReferenced: 5,
      resourcesWeighed: 5,
      pagesWithUnmeasuredResources: 0,
      atLeast: false,
    });
    expect(rows["page_type|blog"]).toMatchObject({
      pageWeight: { count: 1, min: 80_000, max: 80_000 },
      imageBytes: { count: 1, max: 0 },
      resourcesReferenced: 1,
      resourcesWeighed: 1,
      atLeast: false,
    });
    expect(rows["site|"]).toMatchObject({
      pageWeight: { count: 3, min: 80_000, max: 370_000 },
      resourcesReferenced: 6,
      resourcesWeighed: 6,
      atLeast: false,
    });
  });

  it("is a FLOOR when a referenced file was never weighed, and says which pages", async () => {
    const crawlId = await seed(
      [{ path: "/p1" }, { path: "/p2" }],
      [
        { url: "/img/weighed.png", bytes: 40_000, on: ["/p1", "/p2"] },
        // Never asked — unknown, not zero.
        { url: "/img/unfetched.png", fetchClass: null, bytes: null, on: ["/p1"] },
        // Asked and refused: a file we were not allowed to weigh.
        { url: "/img/denied.png", fetchClass: "robots_denied", bytes: null, on: ["/p1"] },
        // Answered, with no size to give.
        { url: "/img/sizeless.png", fetchClass: "ok", bytes: null, on: ["/p2"] },
      ],
    );
    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    expect(rows["site|"]).toMatchObject({
      pageWeight: { count: 2, min: 50_000, max: 50_000 },
      resourcesReferenced: 5,
      resourcesWeighed: 2,
      pagesWithUnmeasuredResources: 2,
      atLeast: true,
    });
  });

  it("never weighs a social-only image: it has no page_resources edge (deviation 3)", async () => {
    // A browser does not load an og:image; the crawl records it as a resources
    // row with no edge, and the page's weight is what the page loads.
    const crawlId = await seed(
      [{ path: "/p1" }],
      [
        { url: "/img/inline.png", bytes: 5_000, on: ["/p1"] },
        { url: "/og/share.png", bytes: 900_000, on: [] },
      ],
    );
    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    expect(rows["site|"]).toMatchObject({
      pageWeight: { count: 1, min: 15_000, max: 15_000 },
      resourcesReferenced: 1,
      resourcesWeighed: 1,
    });
  });

  it("counts a broken resource as unmeasured rather than as weight", async () => {
    const crawlId = await seed(
      [{ path: "/p1" }],
      [
        { url: "/img/gone.png", fetchClass: "client_error", bytes: null, on: ["/p1"] },
      ],
    );
    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    expect(rows["site|"]).toMatchObject({
      pageWeight: { count: 1, min: 10_000, max: 10_000 },
      resourcesReferenced: 1,
      resourcesWeighed: 0,
      pagesWithUnmeasuredResources: 1,
      atLeast: true,
    });
  });

  it("measures the metric cohort: no redirects, no errors, no noindex pages", async () => {
    const crawlId = await seed(
      [
        { path: "/keep" },
        { path: "/noindex", isIndexable: false },
        { path: "/moved", fetchClass: "redirect", statusCode: 301, isIndexable: false },
      ],
      [{ url: "/img/hero.png", bytes: 60_000, on: ["/keep", "/noindex", "/moved"] }],
    );
    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    expect(rows["site|"]).toMatchObject({
      pageWeight: { count: 1, min: 70_000, max: 70_000 },
      // The edges counted are the cohort's, so the coverage numbers describe
      // exactly the pages the distribution above was taken over.
      resourcesReferenced: 1,
      resourcesWeighed: 1,
    });
  });

  it("groups pages the crawler could not type under the untyped sentinel", async () => {
    const crawlId = await seed([{ path: "/x", pageType: null }], []);
    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    expect(Object.keys(rows).sort()).toEqual(["page_type|(untyped)", "site|"]);
  });

  it("answers an empty cohort with a row of zeroes and null statistics", async () => {
    const crawlId = await seed([], []);
    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    expect(Object.keys(rows)).toEqual(["site|"]);
    expect(rows["site|"]).toMatchObject({
      pageWeight: { count: 0, min: null, median: null, max: null, mean: null },
      resourcesReferenced: 0,
      resourcesWeighed: 0,
      pagesWithUnmeasuredResources: 0,
      atLeast: false,
    });
  });

  it("counts per measure: a page with no HTML size has no weight and still has resources", async () => {
    // The `content.metrics-by-type` contract, which this metric inherits: each
    // count is the pages that carry THAT measure. A page whose HTML size was
    // never recorded has no page weight — a total without the page's own HTML
    // in it is not the page's weight — and its resource bytes are still a fact.
    const crawlId = await seed(
      [{ path: "/known" }, { path: "/unknown", htmlBytes: null }],
      [{ url: "/img/hero.png", bytes: 40_000, on: ["/known", "/unknown"] }],
    );
    const rows = await metricRowsByScope(db, rule("page.weight"), crawlId);
    expect(rows["site|"]).toMatchObject({
      pageWeight: { count: 1, max: 50_000 },
      htmlBytes: { count: 1 },
      imageBytes: { count: 2, max: 40_000 },
    });
  });

  it("refuses to publish a breakdown that does not add up to the weight", async () => {
    // `ResourceKind` is image|css|js today, and the three per-kind columns break
    // the page weight out by exactly those. A fourth kind — fonts and media are
    // the ones this phase deliberately left out of scope — would be inside the
    // total and inside none of the columns, so the breakdown would silently
    // stop adding up to the number it breaks down. The metric stops instead,
    // naming the kind, which is what makes adding a kind a deliberate act
    // (hard rule 7).
    const crawlId = await seed(
      [{ path: "/p1" }],
      [{ url: "/fonts/body.woff2", kind: "font", bytes: 30_000, on: ["/p1"] }],
    );
    await expect(rule("page.weight").run(db, crawlId)).rejects.toThrow(
      /weighs 30000 byte\(s\) of resources whose kind \(font\)/,
    );
  });

  it("refuses a crawl id nothing knows", async () => {
    await expectRefusesUnknownCrawl(db, resourceMetrics);
  });
});

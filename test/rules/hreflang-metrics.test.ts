/**
 * The hreflang coverage metric, against a real database.
 *
 * Rows are inserted directly, and every percentage below is hand-derived from
 * the two counts beside it — the point of the metric is that the division
 * happens in SQL, so the test states what the division should produce rather
 * than repeating the expression.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { hreflang, pages } from "../../src/db/schema.js";
import { UNTYPED } from "../../src/rules/metric/cohort.js";
import { hreflangMetrics } from "../../src/rules/metric/hreflang-metrics.js";
import {
  databaseUrl,
  dropCrawls,
  expectRefusesUnknownCrawl,
  metricLookup,
  metricRowsByScope,
  newMetricCrawl,
} from "./metric-db.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

const SITE = "https://hreflang-metrics.example";
const url = (path: string): string => `${SITE}${path}`;

const rule = metricLookup(hreflangMetrics, "hreflangMetrics");

describe("hreflangMetrics metadata", () => {
  it("defines the one metric of the phase-4 table, with its check and severity", () => {
    expect(hreflangMetrics.map((r) => r.id)).toEqual(["hreflang.coverage"]);
    const r = rule("hreflang.coverage");
    expect([r.checkIds, r.severity, r.category, r.kind]).toEqual([
      ["CHECK-24"],
      "info",
      "hreflang",
      "metric",
    ]);
    expect(r.title.length).toBeGreaterThan(5);
    expect(r.explanation.length).toBeGreaterThan(40);
    expect(r.howToFix.length).toBeGreaterThan(30);
    expect(r.rulesetVersion).toBeTruthy();
  });
});

describe("hreflang.coverage against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    pageType: string | null;
    /** How many hreflang declarations this page publishes. */
    alternates?: number;
  }

  const newCrawl = async (): Promise<string> =>
    newMetricCrawl(db, SITE, createdCrawls, { pagesCrawled: 9 });

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      pageType: s.pageType,
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: writerIndexable(s),
      robotsMeta: s.robotsMeta ?? null,
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);

    const declarations = specs.flatMap((s, i) =>
      Array.from({ length: s.alternates ?? 0 }, (_, n) => ({
        crawlId,
        pageId: rows[i]!.id,
        hreflangCode: ["en", "fr", "de"][n] ?? `x${n}`,
        targetUrl: `${url(s.path)}?lang=${n}`,
        targetPageId: null,
        source: "html",
      })),
    );
    if (declarations.length > 0) await db.insert(hreflang).values(declarations);
  }

  const run = async (crawlId: string): Promise<Record<string, unknown>> =>
    metricRowsByScope(db, rule("hreflang.coverage"), crawlId);

  /**
   * THE SITE UNDER TEST. Seven cohort pages, three of which publish hreflang.
   *
   *   path      page_type   alternates
   *   /p1       product     3           <- three declarations, ONE covered page
   *   /p2       product     1
   *   /p3       product     0
   *   /b1       blog        0
   *   /b2       blog        0
   *   /b3       blog        0
   *   /u1       null (!)    2
   *   /noindex  product     2           excluded from the cohort
   *   /gone     product     2           excluded (404)
   */
  const SPECS: PageSpec[] = [
    { path: "/p1", pageType: "product", alternates: 3 },
    { path: "/p2", pageType: "product", alternates: 1 },
    { path: "/p3", pageType: "product" },
    { path: "/b1", pageType: "blog" },
    { path: "/b2", pageType: "blog" },
    { path: "/b3", pageType: "blog" },
    { path: "/u1", pageType: null, alternates: 2 },
    { path: "/noindex", pageType: "product", alternates: 2, robotsMeta: "noindex, follow" },
    {
      path: "/gone",
      pageType: "product",
      alternates: 2,
      statusCode: 404,
      fetchClass: "client_error",
    },
  ];

  let crawlId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
    crawlId = await newCrawl();
    await addPages(crawlId, SPECS);
  });

  afterAll(async () => {
    await dropCrawls(db, createdCrawls);
    await closeDb(db);
  });

  it("reports covered pages, cohort size and the percentage for the site and each type", async () => {
    const rows = await run(crawlId);

    // SITE: seven cohort pages, three of them publishing hreflang (/p1, /p2,
    // /u1). 100 * 3 / 7 = 42.857142… -> 42.9. The excluded pages' six
    // declarations count for nothing on either side of the division.
    expect(rows["site|"]).toEqual({
      pagesWithHreflang: 3,
      indexablePages: 7,
      coveragePct: 42.9,
    });

    // product: three cohort pages, two covered. 100 * 2 / 3 = 66.666… -> 66.7.
    // /p1's THREE declarations make it one covered page, not three.
    expect(rows["page_type|product"]).toEqual({
      pagesWithHreflang: 2,
      indexablePages: 3,
      coveragePct: 66.7,
    });

    // blog: three cohort pages, none covered. Stated as 0, not omitted.
    expect(rows["page_type|blog"]).toEqual({
      pagesWithHreflang: 0,
      indexablePages: 3,
      coveragePct: 0,
    });

    // The untyped cohort: one page, covered. 100 * 1 / 1 = 100.
    expect(rows[`page_type|${UNTYPED}`]).toEqual({
      pagesWithHreflang: 1,
      indexablePages: 1,
      coveragePct: 100,
    });

    expect(Object.keys(rows).sort()).toEqual([
      "page_type|(untyped)",
      "page_type|blog",
      "page_type|product",
      "site|",
    ]);
  });

  it("ignores the declarations of another crawl", async () => {
    // The hreflang table is keyed by crawl as well as by page, and a page id is
    // unique across crawls — but a join that forgot the crawl id would still
    // pass on a single-crawl database. This is the crawl that proves it did not.
    const otherCrawl = await newCrawl();
    await addPages(otherCrawl, [{ path: "/only", pageType: "product", alternates: 4 }]);
    expect((await run(otherCrawl))["site|"]).toEqual({
      pagesWithHreflang: 1,
      indexablePages: 1,
      coveragePct: 100,
    });
    // And the original crawl's numbers are untouched by the new one's pages.
    expect((await run(crawlId))["site|"]).toEqual({
      pagesWithHreflang: 3,
      indexablePages: 7,
      coveragePct: 42.9,
    });
  });

  it("answers an empty cohort with a null percentage rather than a zero", async () => {
    const emptyCrawl = await newCrawl();
    await addPages(emptyCrawl, [
      { path: "/only", pageType: "product", alternates: 2, statusCode: 500, fetchClass: "server_error" },
    ]);
    // 0 of 0 is not 0%: there is nothing to take a percentage of, and printing
    // "0% of pages have hreflang" for a crawl with no indexable pages would be
    // a fact about the crawl dressed up as a fact about the site.
    expect(await run(emptyCrawl)).toEqual({
      "site|": { pagesWithHreflang: 0, indexablePages: 0, coveragePct: null },
    });
  });

  it("refuses a crawl id nothing knows, rather than answering an empty table", async () => {
    // The empty-cohort row just above is exactly what an unknown crawl id would
    // aggregate to — `0 of 0`, coverage null — so the rule gates on the crawl
    // existing before it counts anything (hard rule 7).
    await expectRefusesUnknownCrawl(db, hreflangMetrics);
  });
});

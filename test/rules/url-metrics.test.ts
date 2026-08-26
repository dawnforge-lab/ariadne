/**
 * The URL-parameter metric, against a real database.
 *
 * Pages are inserted directly and the inventory is built by the REAL
 * derivation (`deriveUrlParams`) rather than by hand-written `url_params` rows:
 * the metric's whole ordering dependency is that the derivation ran first, and
 * a test that wrote the inventory itself would prove the arithmetic while
 * hiding the coupling it rests on.
 *
 * Every number below is hand-derived from the URL table printed beside it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pages } from "../../src/db/schema.js";
import { deriveUrlParams } from "../../src/rules/derive/url-params.js";
import { TOP_PARAMS_CAP, urlMetrics } from "../../src/rules/metric/url-metrics.js";
import type { Metric } from "../../src/rules/registry/types.js";
import { databaseUrl, dropCrawls, metricLookup, newMetricCrawl } from "./metric-db.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

const SITE = "https://url-metrics.example";
const url = (path: string): string => `${SITE}${path}`;

const rule = metricLookup(urlMetrics, "urlMetrics");

describe("urlMetrics metadata", () => {
  it("defines the one metric of the phase-4 table, with its checks and severity", () => {
    expect(urlMetrics.map((r) => r.id)).toEqual(["url.param-volumes"]);
    const r = rule("url.param-volumes");
    expect([r.checkIds, r.severity, r.category, r.kind]).toEqual([
      ["CHECK-29", "CHECK-27"],
      "info",
      "url",
      "metric",
    ]);
    expect(r.title.length).toBeGreaterThan(5);
    expect(r.explanation.length).toBeGreaterThan(40);
    expect(r.howToFix.length).toBeGreaterThan(30);
    expect(r.rulesetVersion).toBeTruthy();
  });
});

describe("url.param-volumes against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
  }

  const newCrawl = async (): Promise<string> => newMetricCrawl(db, SITE, createdCrawls);

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    await db.insert(pages).values(
      specs.map((s) => ({
        id: `page_${randomUUID()}`,
        crawlId,
        url: url(s.path),
        // The crawler normalises away nothing this test depends on; the metric
        // reads `url`, which is the published spelling.
        urlNormalised: url(s.path),
        pageType: "content",
        fetchClass: s.fetchClass ?? "ok",
        statusCode: s.statusCode === undefined ? 200 : s.statusCode,
        isIndexable: writerIndexable(s),
        robotsMeta: s.robotsMeta ?? null,
        depth: 1,
        discoveredVia: "link",
      })),
    );
  }

  /** The derivation, then the metric — `runRules`' own order. */
  async function run(crawlId: string): Promise<Record<string, unknown>> {
    await deriveUrlParams(db, crawlId);
    const rows: Metric[] = await rule("url.param-volumes").run(db, crawlId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect([row.metricId, row.scope, row.scopeValue]).toEqual([
      "url.param-volumes",
      "site",
      "",
    ]);
    return row.value;
  }

  /**
   * THE SITE UNDER TEST. Eight pages, seven of them carrying a query string.
   *
   *   path                        fetch        params carried
   *   /a?color=red&size=10        200 ok       color, size
   *   /b?color=blue               200 ok       color
   *   /c?color=green              404          color        <- not in the cohort
   *   /d?utm_source=news          200 ok       utm_source
   *   /e?utm_source=news&gclid=x  200 noindex  utm_source, gclid
   *   /f                          200 ok       (none — no query string at all)
   *   /g?sort=asc                 200 ok       sort
   *   /h?                         200 ok       (none — a `?` and nothing after it)
   */
  const SPECS: PageSpec[] = [
    { path: "/a?color=red&size=10" },
    { path: "/b?color=blue" },
    { path: "/c?color=green", statusCode: 404, fetchClass: "client_error" },
    { path: "/d?utm_source=news" },
    { path: "/e?utm_source=news&gclid=x", robotsMeta: "noindex, follow" },
    { path: "/f" },
    { path: "/g?sort=asc" },
    { path: "/h?" },
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

  it("counts the inventory, the tracking share and the parameterised pages", async () => {
    const value = await run(crawlId);

    expect(value).toEqual({
      // Five distinct parameter names: color, size, utm_source, gclid, sort.
      totalParams: 5,
      // Two of them are `TRACKING_PARAMS` members: utm_source and gclid. The
      // classification is the derivation's — the metric reads the flag it wrote.
      trackingParams: 2,
      // Ordered by URLs carrying the parameter, descending:
      //   color      /a, /b, /c        3
      //   utm_source /d, /e            2
      //   gclid      /e                1  \
      //   size       /a                1   > tied at one, name ascending
      //   sort       /g                1  /
      // `/c` is a 404 and still counts here: the inventory is over every URL
      // the crawl stored, which is what `parameterisedPages` counts too.
      topParams: [
        { name: "color", occurrences: 3, isTracking: false },
        { name: "utm_source", occurrences: 2, isTracking: true },
        { name: "gclid", occurrences: 1, isTracking: true },
        { name: "size", occurrences: 1, isTracking: false },
        { name: "sort", occurrences: 1, isTracking: false },
      ],
      // The cohort pages carrying a `?`: /a, /b, /d, /g, /h. /c is a 404 and /e
      // is noindex; /h carries a `?` with nothing after it, so it is a
      // parameterised page that put no name in the inventory.
      parameterisedIndexablePages: 5,
      // Every page row carrying a `?`, whatever it answered: all but /f.
      parameterisedPages: 7,
    });
  });

  it("names the twenty largest parameters, breaking ties by name", async () => {
    // Twenty-five parameters, one URL each, except `p25` which has two — so the
    // ordering has one strict winner and twenty-four ties. Name ascending
    // decides the ties, so `p01`…`p19` follow `p25` and `p20`…`p24` fall off
    // the end of the list. Deterministic: the same crawl always names these
    // twenty, in this order.
    const capCrawl = await newCrawl();
    const names = Array.from({ length: 25 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);
    await addPages(capCrawl, [
      ...names.map((name, i) => ({ path: `/c${i}?${name}=1` })),
      { path: "/c25b?p25=1" },
    ]);

    const value = await run(capCrawl);
    expect(value["totalParams"]).toBe(25);
    expect(value["trackingParams"]).toBe(0);
    const top = value["topParams"] as { name: string; occurrences: number }[];
    expect(top).toHaveLength(TOP_PARAMS_CAP);
    expect(top.map((p) => p.name)).toEqual([
      "p25",
      ...names.slice(0, 19),
    ]);
    expect(top[0]).toEqual({ name: "p25", occurrences: 2, isTracking: false });
    expect(top.map((p) => p.name)).not.toContain("p20");
  });

  it("states a site with no parameters as zeroes and an empty list", async () => {
    const plainCrawl = await newCrawl();
    await addPages(plainCrawl, [{ path: "/" }, { path: "/about" }]);
    expect(await run(plainCrawl)).toEqual({
      totalParams: 0,
      trackingParams: 0,
      topParams: [],
      parameterisedIndexablePages: 0,
      parameterisedPages: 0,
    });
  });

  it("ignores another crawl's pages and inventory", async () => {
    // `url_params` is keyed by crawl and page ids are unique across crawls, so
    // a query that forgot the crawl id would still pass on a single-crawl
    // database. This is the crawl that proves it did not.
    const otherCrawl = await newCrawl();
    await addPages(otherCrawl, [{ path: "/only?ref=elsewhere" }]);
    expect(await run(otherCrawl)).toEqual({
      totalParams: 1,
      trackingParams: 0,
      topParams: [{ name: "ref", occurrences: 1, isTracking: false }],
      parameterisedIndexablePages: 1,
      parameterisedPages: 1,
    });
    // And the original crawl is untouched by the new one's pages.
    expect((await run(crawlId))["totalParams"]).toBe(5);
  });

  it("refuses a crawl id nothing knows rather than reporting an empty site", async () => {
    await expect(rule("url.param-volumes").run(db, "crawl_nope")).rejects.toThrow(
      /no such crawl/,
    );
  });
});

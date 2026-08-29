/**
 * The content metrics, against a real database.
 *
 * Rows are inserted directly (the link-metrics pattern): what is under test is
 * the arithmetic the SQL performs over a set of measured pages, not the
 * crawling and parsing that produced the measurements.
 *
 * EVERY NUMBER BELOW IS HAND-DERIVED, and the derivation is written out beside
 * the assertion. `percentile_cont` interpolates linearly — for a sorted list
 * v0…v(n-1) and a quantile q, `pos = q * (n - 1)`, `i = floor(pos)`, and the
 * answer is `v[i] + (pos - i) * (v[i+1] - v[i])` — so each percentile below is
 * computed that way, in a comment, from the sorted list printed above it.
 *
 * `text_ratio` is a Postgres `real`, so the values stored are the float4
 * neighbours of the decimals written here (0.1 is 0.10000000149011612 once
 * widened to float8). Every ratio statistic is rounded to four decimal places
 * IN SQL, which is well inside that error, so the hand-derived decimals are the
 * values that come back. The test values are chosen at two decimal places so no
 * interpolation lands on a rounding boundary.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pages } from "../../src/db/schema.js";
import { UNTYPED } from "../../src/rules/metric/cohort.js";
import {
  contentMetrics,
  TEMPLATE_LOOSE_BITS,
  TEMPLATE_NEAR_BITS,
  TEMPLATE_SAMPLE_PAGES,
} from "../../src/rules/metric/content-metrics.js";
import {
  databaseUrl,
  dropCrawls,
  expectRefusesUnknownCrawl,
  metricLookup,
  metricRowsByScope,
  newMetricCrawl,
} from "./metric-db.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

const SITE = "https://content-metrics.example";
const url = (path: string): string => `${SITE}${path}`;

const rule = metricLookup(contentMetrics, "contentMetrics");

describe("contentMetrics metadata", () => {
  it("defines the two metrics of the phase-4 table", () => {
    expect(contentMetrics.map((r) => r.id).sort()).toEqual([
      "content.metrics-by-type",
      "content.template-similarity",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(contentMetrics.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      // CHECK-38 is an AGENT check: whether a page matches its intent is
      // judgement, and no rule may pass it. These two produce the EVIDENCE the
      // agent judges from, and a metric accuses the site of nothing — hence
      // `info`, like every metric.
      "content.metrics-by-type": [["CHECK-38"], "info", "content"],
      "content.template-similarity": [["CHECK-38"], "info", "content"],
    });
  });

  it("every rule is a metric rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of contentMetrics) {
      expect(r.kind, r.id).toBe("metric");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.howToFix.length, r.id).toBeGreaterThan(30);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    expect(titles.size).toBe(contentMetrics.length);
  });
});

describe("the content metrics against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    pageType: string | null;
    words?: number | null;
    /**
     * The renderable word count. Undefined means "the same as `words`", the
     * shape of a page with nothing hidden; an explicit null is a row a pre-P7
     * crawl wrote, which carries a word count and no renderable one.
     */
    renderable?: number | null;
    ratio?: number | null;
    simhash?: bigint | null;
    /** Only the sampling-cap test sets this: the sample is taken BY id. */
    id?: string;
  }

  const newCrawl = async (): Promise<string> =>
    newMetricCrawl(db, SITE, createdCrawls, { pagesCrawled: 10 });

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    await db.insert(pages).values(
      specs.map((s) => ({
        id: s.id ?? `page_${randomUUID()}`,
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
        wordCount: s.words === undefined ? null : s.words,
        renderableWordCount:
          s.renderable === undefined ? (s.words === undefined ? null : s.words) : s.renderable,
        textRatio: s.ratio === undefined ? null : s.ratio,
        simhash: s.simhash === undefined ? null : s.simhash,
      })),
    );
  }

  /** One metric rule's rows, keyed by `<scope>|<scopeValue>`. */
  const run = async (id: string, crawlId: string): Promise<Record<string, unknown>> =>
    metricRowsByScope(db, rule(id), crawlId);

  /**
   * THE SITE UNDER TEST for `content.metrics-by-type`. Eight cohort pages
   * (fetched OK, 200, indexable) and two deliberately outside it.
   *
   *   path      page_type   words   renderable   text_ratio
   *   /p1       product      100      80          0.10
   *   /p2       product      200     150          0.20
   *   /p3       product      300     200          0.30
   *   /p4       product      500     400          0.50
   *   /b1       blog         400     300          0.20
   *   /b2       blog         800     600          0.40
   *   /u1       null (!)    1000    null (!)      0.50   <- a pre-P7 row
   *   /u2       null (!)    null    null          null   <- measured by nothing
   *   /noindex  blog        9999    9999          0.99   excluded (noindex)
   *   /gone     retired        5       5          0.05   excluded (404)
   *
   * `/u1` is the shape the third distribution exists to be honest about: a
   * page a crawl from before Phase 7 wrote has a word count and no renderable
   * one, so it is IN the word-count column and ABSENT from the renderable one.
   * Reading its 1000 into both would be the metric claiming a measurement that
   * was never taken.
   */
  const SPECS: PageSpec[] = [
    { path: "/p1", pageType: "product", words: 100, renderable: 80, ratio: 0.1 },
    { path: "/p2", pageType: "product", words: 200, renderable: 150, ratio: 0.2 },
    { path: "/p3", pageType: "product", words: 300, renderable: 200, ratio: 0.3 },
    { path: "/p4", pageType: "product", words: 500, renderable: 400, ratio: 0.5 },
    { path: "/b1", pageType: "blog", words: 400, renderable: 300, ratio: 0.2 },
    { path: "/b2", pageType: "blog", words: 800, renderable: 600, ratio: 0.4 },
    { path: "/u1", pageType: null, words: 1000, renderable: null, ratio: 0.5 },
    { path: "/u2", pageType: null, words: null, renderable: null, ratio: null },
    { path: "/noindex", pageType: "blog", words: 9999, ratio: 0.99, robotsMeta: "noindex" },
    {
      path: "/gone",
      pageType: "retired",
      words: 5,
      ratio: 0.05,
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

  it("content.metrics-by-type reports all three measures for the site and each type", async () => {
    const rows = await run("content.metrics-by-type", crawlId);

    // SITE. Eight cohort pages; /u2 has neither measure, so both distributions
    // are over seven values.
    //   words sorted: 100,200,300,400,500,800,1000 — n=7, pos = q*6
    //     mean 3300/7 = 471.428571… -> 471.43
    //     p25    pos 1.5 -> 200 + 0.5*(300-200)  = 250
    //     median pos 3   -> 400
    //     p75    pos 4.5 -> 500 + 0.5*(800-500)  = 650
    //     p95    pos 5.7 -> 800 + 0.7*(1000-800) = 940
    //   ratios sorted: 0.1,0.2,0.2,0.3,0.4,0.5,0.5 — n=7
    //     mean 2.2/7 = 0.314285… -> 0.3143
    //     p25    pos 1.5 -> 0.2
    //     median pos 3   -> 0.3
    //     p75    pos 4.5 -> 0.4 + 0.5*(0.5-0.4) = 0.45
    //     p95    pos 5.7 -> 0.5
    //   renderable sorted: 80,150,200,300,400,600 — n=6 (/u1 has none), pos = q*5
    //     mean 1730/6 = 288.333… -> 288.33
    //     p25    pos 1.25 -> 150 + 0.25*(200-150) = 162.5
    //     median pos 2.5  -> 200 + 0.5*(300-200)  = 250
    //     p75    pos 3.75 -> 300 + 0.75*(400-300) = 375
    //     p95    pos 4.75 -> 400 + 0.75*(600-400) = 550
    expect(rows["site|"]).toEqual({
      wordCount: { count: 7, min: 100, p25: 250, median: 400, p75: 650, p95: 940, max: 1000, mean: 471.43 },
      renderableWordCount: { count: 6, min: 80, p25: 162.5, median: 250, p75: 375, p95: 550, max: 600, mean: 288.33 },
      textRatio: { count: 7, min: 0.1, p25: 0.2, median: 0.3, p75: 0.45, p95: 0.5, max: 0.5, mean: 0.3143 },
    });

    // product words 100,200,300,500 — n=4, pos = q*3.
    //   mean 1100/4 = 275
    //   p25    pos 0.75 -> 100 + 0.75*(200-100) = 175
    //   median pos 1.5  -> 200 + 0.5*(300-200)  = 250
    //   p75    pos 2.25 -> 300 + 0.25*(500-300) = 350
    //   p95    pos 2.85 -> 300 + 0.85*(500-300) = 470
    // product ratios 0.1,0.2,0.3,0.5 — same positions.
    //   mean 1.1/4 = 0.275
    //   p25    0.1 + 0.75*0.1 = 0.175
    //   median 0.2 + 0.5*0.1  = 0.25
    //   p75    0.3 + 0.25*0.2 = 0.35
    //   p95    0.3 + 0.85*0.2 = 0.47
    // product renderable 80,150,200,400 — same positions.
    //   mean 830/4 = 207.5
    //   p25    80 + 0.75*(150-80)  = 132.5
    //   median 150 + 0.5*(200-150) = 175
    //   p75    200 + 0.25*(400-200) = 250
    //   p95    200 + 0.85*(400-200) = 370
    expect(rows["page_type|product"]).toEqual({
      wordCount: { count: 4, min: 100, p25: 175, median: 250, p75: 350, p95: 470, max: 500, mean: 275 },
      renderableWordCount: { count: 4, min: 80, p25: 132.5, median: 175, p75: 250, p95: 370, max: 400, mean: 207.5 },
      textRatio: { count: 4, min: 0.1, p25: 0.175, median: 0.25, p75: 0.35, p95: 0.47, max: 0.5, mean: 0.275 },
    });

    // blog words 400,800 — n=2, pos = q*1. mean 600; p25 400+0.25*400 = 500;
    // median 600; p75 700; p95 400 + 0.95*400 = 780.
    // blog ratios 0.2,0.4. mean 0.3; p25 0.2+0.25*0.2 = 0.25; median 0.3;
    // p75 0.35; p95 0.2 + 0.95*0.2 = 0.39.
    // blog renderable 300,600. mean 450; p25 300+0.25*300 = 375; median 450;
    // p75 525; p95 300 + 0.95*300 = 585.
    expect(rows["page_type|blog"]).toEqual({
      wordCount: { count: 2, min: 400, p25: 500, median: 600, p75: 700, p95: 780, max: 800, mean: 600 },
      renderableWordCount: { count: 2, min: 300, p25: 375, median: 450, p75: 525, p95: 585, max: 600, mean: 450 },
      textRatio: { count: 2, min: 0.2, p25: 0.25, median: 0.3, p75: 0.35, p95: 0.39, max: 0.4, mean: 0.3 },
    });

    // The untyped cohort has TWO pages and a different count per measure: one
    // word count, one text ratio, and NO renderable count at all (/u1 is a
    // pre-P7 row and /u2 was measured by nothing). Each nested count is the
    // number of pages that carry that measure, not the size of the cohort. A
    // single value is its own every percentile; no value at all is a count of
    // zero and eight nulls, never a zero-word cohort.
    expect(rows[`page_type|${UNTYPED}`]).toEqual({
      wordCount: { count: 1, min: 1000, p25: 1000, median: 1000, p75: 1000, p95: 1000, max: 1000, mean: 1000 },
      renderableWordCount: { count: 0, min: null, p25: null, median: null, p75: null, p95: null, max: null, mean: null },
      textRatio: { count: 1, min: 0.5, p25: 0.5, median: 0.5, p75: 0.5, p95: 0.5, max: 0.5, mean: 0.5 },
    });

    // `retired` is the type of the 404 page alone, so a cohort row for it would
    // mean the fetch filter had stopped applying — and the noindex page's 9999
    // words would have doubled the blog maximum.
    expect(Object.keys(rows).sort()).toEqual([
      "page_type|(untyped)",
      "page_type|blog",
      "page_type|product",
      "site|",
    ]);
  });

  it("content.template-similarity measures pair distances within each type", async () => {
    const simCrawl = await newCrawl();
    // Simhashes chosen as bit patterns whose pairwise hamming distances can be
    // read off by eye:
    //   /s1 = 0b0000000 (0)     /s2 = 0b0000001 (1)
    //   /s3 = 0b0000011 (3)     /s4 = 0b1111111 (127)
    // Distances: s1s2 1, s1s3 2, s1s4 7, s2s3 1, s2s4 6, s3s4 5.
    await addPages(simCrawl, [
      { path: "/s1", pageType: "product", simhash: 0n },
      { path: "/s2", pageType: "product", simhash: 1n },
      { path: "/s3", pageType: "product", simhash: 3n },
      { path: "/s4", pageType: "product", simhash: 127n },
      // The excluded page carries a simhash that WOULD change the product
      // numbers (four more pairs) if the cohort filter stopped applying.
      { path: "/noindex", pageType: "product", simhash: 255n, robotsMeta: "noindex" },
      // Two blog pages at opposite ends of the 64-bit space: -1 is the signed
      // spelling of all sixty-four bits set, so the distance is 64. This is the
      // sign contract — `#` and `bit_count` are representation-level.
      { path: "/g1", pageType: "blog", simhash: 0n },
      { path: "/g2", pageType: "blog", simhash: -1n },
      // One page of its type: no pair, so no row.
      { path: "/solo", pageType: "solo", simhash: 42n },
      // Two pages of a type, one of them never fingerprinted: one page with a
      // simhash is not a pair either, so again no row.
      { path: "/h1", pageType: "half", simhash: 42n },
      { path: "/h2", pageType: "half", simhash: null },
    ]);

    const rows = await run("content.template-similarity", simCrawl);

    // product pairs sorted: 1,1,2,5,6,7 — n=6, pos = q*5.
    //   mean 22/6 = 3.666… -> 3.67
    //   p25    pos 1.25 -> 1 + 0.25*(2-1) = 1.25
    //   median pos 2.5  -> 2 + 0.5*(5-2)  = 3.5
    //   p75    pos 3.75 -> 5 + 0.75*(6-5) = 5.75
    //   within 3 bits: 1,1,2 -> 3 of 6 = 50.0%
    //   within 8 bits: all 6 -> 100.0%
    expect(rows["page_type|product"]).toEqual({
      pagesFingerprinted: 4,
      pagesSampled: 4,
      pairsSampled: 6,
      meanHamming: 3.67,
      p25: 1.25,
      median: 3.5,
      p75: 5.75,
      shareWithin3BitsPct: 50,
      shareWithin8BitsPct: 100,
    });

    // blog: one pair, 64 bits apart. Every percentile of a single value is
    // that value, and neither threshold is met.
    expect(rows["page_type|blog"]).toEqual({
      pagesFingerprinted: 2,
      pagesSampled: 2,
      pairsSampled: 1,
      meanHamming: 64,
      p25: 64,
      median: 64,
      p75: 64,
      shareWithin3BitsPct: 0,
      shareWithin8BitsPct: 0,
    });

    // A type with fewer than two fingerprinted pages has no pair to describe,
    // so it gets no row at all — unlike the distributions, where an empty
    // cohort is still an answer. There is nothing here to state.
    expect(Object.keys(rows).sort()).toEqual(["page_type|blog", "page_type|product"]);
  });

  it("samples the first pages by id per type and says how many pairs that was", async () => {
    const capCrawl = await newCrawl();
    // 205 pages of one type, with ids that sort in a known order. The first 200
    // by id all share one fingerprint; the last five are 64 bits away from it.
    //
    // The cap is what decides the answer: sampling the first 200 by id yields
    // C(200,2) = 19,900 pairs, every one of them 0 bits apart. Sampling all 205
    // would yield C(205,2) = 20,910 pairs, which split three ways — 19,900
    // among the first 200 at distance 0, 200 × 5 = 1,000 crossing between the
    // two groups at distance 64, and C(5,2) = 10 among the five extras, also at
    // distance 0 (they share the fingerprint -1). So the uncapped mean would be
    // 1,000 × 64 / 20,910 = 3.06 and the within-3 share 19,910/20,910 = 95.2%,
    // neither of which is asserted below: a missing cap, or a sample taken in
    // some other order, cannot produce these numbers.
    const specs: PageSpec[] = [];
    for (let i = 0; i < 205; i += 1) {
      specs.push({
        id: `page_${String(i).padStart(3, "0")}`,
        path: `/bulk${String(i).padStart(3, "0")}`,
        pageType: "bulk",
        simhash: i < TEMPLATE_SAMPLE_PAGES ? 0n : -1n,
      });
    }
    await addPages(capCrawl, specs);

    const rows = await run("content.template-similarity", capCrawl);
    expect(TEMPLATE_SAMPLE_PAGES).toBe(200);
    // 200*199/2 = 19,900.
    expect(rows["page_type|bulk"]).toEqual({
      pagesFingerprinted: 205,
      pagesSampled: 200,
      pairsSampled: 19_900,
      meanHamming: 0,
      p25: 0,
      median: 0,
      p75: 0,
      shareWithin3BitsPct: 100,
      shareWithin8BitsPct: 100,
    });
  });

  it("counts a page nothing measured as absent from that measure, not as a zero", async () => {
    const nullCrawl = await newCrawl();
    await addPages(nullCrawl, [
      { path: "/a", pageType: "product", words: 100, renderable: 60, ratio: null },
      { path: "/b", pageType: "product", words: null, renderable: null, ratio: 0.5 },
    ]);
    // Two pages, one value each per measure. A null read as 0 would give count
    // 2, a minimum of 0 and a mean of 50 — the shape of a site with an empty
    // page on it, which this is not.
    const one = (v: number) =>
      ({ count: 1, min: v, p25: v, median: v, p75: v, p95: v, max: v, mean: v });
    expect(await run("content.metrics-by-type", nullCrawl)).toEqual({
      "site|": {
        wordCount: one(100),
        renderableWordCount: one(60),
        textRatio: one(0.5),
      },
      "page_type|product": {
        wordCount: one(100),
        renderableWordCount: one(60),
        textRatio: one(0.5),
      },
    });
  });

  it("answers a crawl with no cohort pages with an empty site row rather than silence", async () => {
    const emptyCrawl = await newCrawl();
    await addPages(emptyCrawl, [
      { path: "/only", pageType: "product", words: 500, ratio: 0.5, statusCode: 500, fetchClass: "server_error" },
    ]);

    const empty = { count: 0, min: null, p25: null, median: null, p75: null, p95: null, max: null, mean: null };
    expect(await run("content.metrics-by-type", emptyCrawl)).toEqual({
      "site|": { wordCount: empty, renderableWordCount: empty, textRatio: empty },
    });
    // Similarity has no site row to state, so an empty crawl leaves it silent.
    expect(await run("content.template-similarity", emptyCrawl)).toEqual({});
  });

  it("says nothing about a crawl id that owns no pages", async () => {
    const otherCrawl = await newCrawl();
    expect(await run("content.template-similarity", otherCrawl)).toEqual({});
    expect(Object.keys(await run("content.metrics-by-type", otherCrawl))).toEqual(["site|"]);
  });

  it("refuses a crawl id nothing knows, rather than answering an empty table", async () => {
    // The pair of the test above, and the reason it is a separate one: a crawl
    // that EXISTS and owns no pages produces the empty site row and the silence
    // just pinned, so an unknown crawl id answered the same way would be two
    // different facts wearing one shape (hard rule 7).
    await expectRefusesUnknownCrawl(db, contentMetrics);
  });

  it("pins the two distance thresholds the shares are cut at", () => {
    // The value keys spell these numbers, so a threshold that moves without
    // the keys and the copy moving with it is a table whose columns lie.
    expect(TEMPLATE_NEAR_BITS).toBe(3);
    expect(TEMPLATE_LOOSE_BITS).toBe(8);
  });
});

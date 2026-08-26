/**
 * The link-graph metrics, against a real database.
 *
 * Rows are inserted directly (the link-graph / link-targets pattern): what is
 * under test is the arithmetic the SQL performs over a link graph, not the
 * crawling that produced one.
 *
 * EVERY NUMBER BELOW IS HAND-DERIVED, and the derivation is written out beside
 * the assertion. A metric whose expected value was copied from the output it
 * produced would assert only that the query is deterministic; these assert that
 * it is right. `percentile_cont` interpolates linearly — for a cohort sorted
 * v0…v(n-1) and a quantile q, `pos = q * (n - 1)`, `i = floor(pos)`, and the
 * answer is `v[i] + (pos - i) * (v[i+1] - v[i])` — so each percentile below is
 * computed that way, in a comment, from the sorted list printed above it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { links, pages } from "../../src/db/schema.js";
import { UNTYPED } from "../../src/rules/metric/cohort.js";
import {
  EXTREMES_LIST_CAP,
  linkMetrics,
  OTHER_SOURCES,
  SOURCE_TYPE_CAP,
} from "../../src/rules/metric/link-metrics.js";
import {
  databaseUrl,
  dropCrawls,
  expectRefusesUnknownCrawl,
  metricLookup,
  metricRowsByScope,
  newMetricCrawl,
} from "./metric-db.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

const SITE = "https://link-metrics.example";
const url = (path: string): string => `${SITE}${path}`;

const rule = metricLookup(linkMetrics, "linkMetrics");

describe("linkMetrics metadata", () => {
  it("defines the four metrics of the phase-4 table", () => {
    expect(linkMetrics.map((r) => r.id).sort()).toEqual([
      "inlinks.distribution",
      "inlinks.extremes",
      "inlinks.sources-by-type",
      "structure.depth-distribution",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(linkMetrics.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      // A metric is a number, not an accusation: every one of them is `info`.
      "inlinks.distribution": [["CHECK-33"], "info", "links"],
      "inlinks.extremes": [["CHECK-33"], "info", "links"],
      "inlinks.sources-by-type": [["CHECK-33b"], "info", "links"],
      "structure.depth-distribution": [["CHECK-31"], "info", "technical"],
    });
  });

  it("every rule is a metric rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of linkMetrics) {
      expect(r.kind, r.id).toBe("metric");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.howToFix.length, r.id).toBeGreaterThan(30);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    // Copy is looked up by rule id and rendered as a table's label: two metrics
    // sharing a title would render as the same table twice.
    expect(titles.size).toBe(linkMetrics.length);
  });
});

describe("the link-graph metrics against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    pageType: string | null;
    depth: number;
  }

  const newCrawl = async (): Promise<string> =>
    newMetricCrawl(db, SITE, createdCrawls, { pagesCrawled: 12 });

  /** Insert the pages, returning path -> page id. */
  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
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
      depth: s.depth,
      discoveredVia: s.depth === 0 ? "seed" : "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  /**
   * Insert links as `<source path> -> <target path>` pairs. The link table has
   * no page id for its target (the crawler always writes null there), so the
   * join every one of these metrics makes is `links.target_url = pages.url` —
   * the same join `links.orphan` makes.
   */
  async function addLinks(
    crawlId: string,
    ids: Map<string, string>,
    edges: [from: string, to: string][],
    external: string[] = [],
  ): Promise<void> {
    const sourceId = (path: string): string => {
      const id = ids.get(path);
      if (id === undefined) throw new Error(`no page for ${path}`);
      return id;
    };
    const rows = edges.map(([from, to], position) => ({
      crawlId,
      sourcePageId: sourceId(from),
      targetUrl: url(to),
      targetPageId: null,
      anchor: "see this",
      rel: null,
      isInternal: true,
      isNofollow: false,
      position,
    }));
    for (const [i, target] of external.entries()) {
      rows.push({
        crawlId,
        sourcePageId: sourceId("/u1"),
        targetUrl: target,
        targetPageId: null,
        anchor: "off site",
        rel: null,
        isInternal: false,
        isNofollow: false,
        position: 900 + i,
      });
    }
    await db.insert(links).values(rows);
  }

  /** One metric rule's rows, keyed by `<scope>|<scopeValue>`. */
  const run = async (id: string, crawlId: string): Promise<Record<string, unknown>> =>
    metricRowsByScope(db, rule(id), crawlId);

  /**
   * THE SITE UNDER TEST. Twelve pages: ten in the cohort every metric measures
   * (fetched OK, 200, indexable), and two deliberately outside it — a noindex
   * page and a 404 — so an assertion below can prove the cohort excludes them
   * while their outbound links are still counted.
   *
   *   path      page_type    depth   inlinks (distinct sources, self excluded)
   *   /u1       null (!)     0       5
   *   /u2       null (!)     5       1
   *   /p1       product      1       4
   *   /p2       product      2       2
   *   /p3       product      2       1
   *   /p4       product      3       0   <- nothing links to it but itself
   *   /b1       blog         1       3
   *   /b2       blog         2       2
   *   /b3       blog         3       2
   *   /b4       blog         4       1
   *   /noindex  blog         2       -   excluded from the cohort; LINKS to /p1
   *   /gone     retired      3       -   excluded (404); links to nothing
   */
  const SPECS: PageSpec[] = [
    { path: "/u1", pageType: null, depth: 0 },
    { path: "/u2", pageType: null, depth: 5 },
    { path: "/p1", pageType: "product", depth: 1 },
    { path: "/p2", pageType: "product", depth: 2 },
    { path: "/p3", pageType: "product", depth: 2 },
    { path: "/p4", pageType: "product", depth: 3 },
    { path: "/b1", pageType: "blog", depth: 1 },
    { path: "/b2", pageType: "blog", depth: 2 },
    { path: "/b3", pageType: "blog", depth: 3 },
    { path: "/b4", pageType: "blog", depth: 4 },
    { path: "/noindex", pageType: "blog", depth: 2, robotsMeta: "noindex, follow" },
    {
      path: "/gone",
      pageType: "retired",
      depth: 3,
      statusCode: 404,
      fetchClass: "client_error",
    },
  ];

  const EDGES: [string, string][] = [
    // The hub. `/u1 -> /p1` twice: two links, ONE inbound source — the counts
    // are `count(distinct source_page_id)`, so a navigation that names a page
    // in the header and again in the footer does not inflate it.
    ["/u1", "/p1"],
    ["/u1", "/p1"],
    ["/u1", "/p2"],
    ["/u1", "/b1"],
    ["/u1", "/b2"],
    ["/u1", "/u2"],
    // Links to the two pages outside the cohort. Neither may produce a row.
    ["/u1", "/noindex"],
    ["/u1", "/gone"],
    ["/u2", "/u1"],
    ["/p1", "/u1"],
    ["/p1", "/p2"],
    ["/p1", "/p3"],
    ["/p2", "/u1"],
    // The self-link, and /p4's only inbound link. A page that links to itself
    // is not linked to by the site (the `links.orphan` lesson).
    ["/p4", "/p4"],
    ["/b1", "/u1"],
    ["/b1", "/p1"],
    ["/b1", "/b2"],
    ["/b2", "/u1"],
    ["/b2", "/p1"],
    ["/b2", "/b1"],
    ["/b2", "/b3"],
    ["/b3", "/b1"],
    ["/b3", "/b4"],
    ["/b4", "/b3"],
    // From OUTSIDE the cohort into it: a noindex page still links, and the link
    // it makes is still a link. The source side is not filtered by indexability.
    ["/noindex", "/p1"],
  ];

  let crawlId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
    crawlId = await newCrawl();
    const ids = await addPages(crawlId, SPECS);
    await addLinks(crawlId, ids, EDGES, ["https://external.example/somewhere"]);
  });

  afterAll(async () => {
    await dropCrawls(db, createdCrawls);
    await closeDb(db);
  });

  it("inlinks.distribution reports the site and one cohort per page type", async () => {
    const rows = await run("inlinks.distribution", crawlId);

    // SITE. Ten cohort pages (the noindex page and the 404 are out), inlinks
    // sorted: 0,1,1,1,2,2,2,3,4,5 — n=10, so pos = q*9.
    //   mean  = 21/10 = 2.1
    //   p25   pos 2.25 -> v2=1, v3=1  -> 1 + 0.25*0 = 1
    //   median pos 4.5 -> v4=2, v5=2  -> 2
    //   p75   pos 6.75 -> v6=2, v7=3  -> 2 + 0.75*1 = 2.75
    //   p95   pos 8.55 -> v8=4, v9=5  -> 4 + 0.55*1 = 4.55
    expect(rows["site|"]).toEqual({
      count: 10,
      min: 0,
      p25: 1,
      median: 2,
      p75: 2.75,
      p95: 4.55,
      max: 5,
      mean: 2.1,
    });

    // product: 0,1,2,4 — n=4, pos = q*3.
    //   mean 7/4 = 1.75
    //   p25   pos 0.75 -> 0 + 0.75*(1-0) = 0.75
    //   median pos 1.5 -> 1 + 0.5*(2-1)  = 1.5
    //   p75   pos 2.25 -> 2 + 0.25*(4-2) = 2.5
    //   p95   pos 2.85 -> 2 + 0.85*(4-2) = 3.7
    expect(rows["page_type|product"]).toEqual({
      count: 4,
      min: 0,
      p25: 0.75,
      median: 1.5,
      p75: 2.5,
      p95: 3.7,
      max: 4,
      mean: 1.75,
    });

    // blog: 1,2,2,3 — n=4.
    //   mean 8/4 = 2
    //   p25   pos 0.75 -> 1 + 0.75*(2-1) = 1.75
    //   median pos 1.5 -> 2
    //   p75   pos 2.25 -> 2 + 0.25*(3-2) = 2.25
    //   p95   pos 2.85 -> 2 + 0.85*(3-2) = 2.85
    expect(rows["page_type|blog"]).toEqual({
      count: 4,
      min: 1,
      p25: 1.75,
      median: 2,
      p75: 2.25,
      p95: 2.85,
      max: 3,
      mean: 2,
    });

    // The pages whose `page_type` is null are a cohort like any other, under
    // the documented sentinel. 1,5 — n=2, pos = q*1.
    //   mean 3
    //   p25   pos 0.25 -> 1 + 0.25*4 = 2
    //   median pos 0.5 -> 3
    //   p75   pos 0.75 -> 4
    //   p95   pos 0.95 -> 1 + 0.95*4 = 4.8
    expect(rows[`page_type|${UNTYPED}`]).toEqual({
      count: 2,
      min: 1,
      p25: 2,
      median: 3,
      p75: 4,
      p95: 4.8,
      max: 5,
      mean: 3,
    });

    // And nothing else: `retired` is the type of the 404 page alone, so a
    // cohort row for it would mean the fetch filter had stopped applying.
    expect(Object.keys(rows).sort()).toEqual([
      "page_type|(untyped)",
      "page_type|blog",
      "page_type|product",
      "site|",
    ]);
  });

  it("counts a page nothing links to as zero rather than leaving it out", async () => {
    const rows = await run("inlinks.distribution", crawlId);
    // /p4's only inbound link is its own. If the join dropped it — an inner
    // join, or a self-link counted — the product cohort would be three pages
    // with a minimum of 1, and the site count would be 9.
    expect((rows["page_type|product"] as { count: number; min: number }).count).toBe(4);
    expect((rows["page_type|product"] as { count: number; min: number }).min).toBe(0);
    expect((rows["site|"] as { count: number }).count).toBe(10);
  });

  it("inlinks.extremes lists the least and most linked pages, ties broken by url", async () => {
    const rows = await run("inlinks.extremes", crawlId);
    expect(Object.keys(rows)).toEqual(["site|"]);

    // Ten cohort pages, fewer than the cap, so both lists name all of them —
    // in opposite orders. Ties are broken by url ASCENDING in BOTH lists (the
    // direction reverses for the count, never for the tiebreak), which is what
    // makes /b2,/b3,/p2 appear in that order in each.
    expect(rows["site|"]).toEqual({
      bottom: [
        { url: url("/p4"), inlinks: 0 },
        { url: url("/b4"), inlinks: 1 },
        { url: url("/p3"), inlinks: 1 },
        { url: url("/u2"), inlinks: 1 },
        { url: url("/b2"), inlinks: 2 },
        { url: url("/b3"), inlinks: 2 },
        { url: url("/p2"), inlinks: 2 },
        { url: url("/b1"), inlinks: 3 },
        { url: url("/p1"), inlinks: 4 },
        { url: url("/u1"), inlinks: 5 },
      ],
      top: [
        { url: url("/u1"), inlinks: 5 },
        { url: url("/p1"), inlinks: 4 },
        { url: url("/b1"), inlinks: 3 },
        { url: url("/b2"), inlinks: 2 },
        { url: url("/b3"), inlinks: 2 },
        { url: url("/p2"), inlinks: 2 },
        { url: url("/b4"), inlinks: 1 },
        { url: url("/p3"), inlinks: 1 },
        { url: url("/u2"), inlinks: 1 },
        { url: url("/p4"), inlinks: 0 },
      ],
    });
  });

  it("inlinks.sources-by-type says which templates link into each template", async () => {
    const rows = await run("inlinks.sources-by-type", crawlId);

    // Counted as DISTINCT (source page, target page) pairs, so the doubled
    // /u1 -> /p1 link is one. Derived per target cohort:
    //   product: /p1 <- u1,b1,b2,noindex ; /p2 <- u1,p1 ; /p3 <- p1 ; /p4 <- -
    //            -> (untyped) 2, blog 3 (the noindex page's type is blog),
    //               product 2
    expect(rows["page_type|product"]).toEqual({
      sources: { [UNTYPED]: 2, blog: 3, product: 2 },
    });

    //   blog: /b1 <- u1,b2,b3 ; /b2 <- u1,b1 ; /b3 <- b2,b4 ; /b4 <- b3
    //         -> (untyped) 2, blog 6
    expect(rows["page_type|blog"]).toEqual({ sources: { [UNTYPED]: 2, blog: 6 } });

    //   (untyped): /u1 <- u2,p1,p2,b1,b2 ; /u2 <- u1
    //              -> (untyped) 2, product 2, blog 2
    expect(rows[`page_type|${UNTYPED}`]).toEqual({
      sources: { [UNTYPED]: 2, product: 2, blog: 2 },
    });

    // One row per target cohort and no site row: the question is "what links
    // into THIS template", which the site as a whole cannot answer.
    expect(Object.keys(rows).sort()).toEqual([
      "page_type|(untyped)",
      "page_type|blog",
      "page_type|product",
    ]);
  });

  it("structure.depth-distribution measures click depth over the same cohort", async () => {
    const rows = await run("structure.depth-distribution", crawlId);

    // SITE. Depths of the ten cohort pages: 0,1,1,2,2,2,3,3,4,5 — n=10.
    //   mean 23/10 = 2.3
    //   p25   pos 2.25 -> v2=1, v3=2 -> 1 + 0.25*1 = 1.25
    //   median pos 4.5 -> v4=2, v5=2 -> 2
    //   p75   pos 6.75 -> v6=3, v7=3 -> 3
    //   p95   pos 8.55 -> v8=4, v9=5 -> 4 + 0.55*1 = 4.55
    expect(rows["site|"]).toEqual({
      count: 10,
      min: 0,
      p25: 1.25,
      median: 2,
      p75: 3,
      p95: 4.55,
      max: 5,
      mean: 2.3,
    });

    // product depths 1,2,2,3 — n=4. mean 2; p25 1+0.75 = 1.75; median 2;
    // p75 2 + 0.25*(3-2) = 2.25; p95 2 + 0.85*(3-2) = 2.85.
    expect(rows["page_type|product"]).toEqual({
      count: 4,
      min: 1,
      p25: 1.75,
      median: 2,
      p75: 2.25,
      p95: 2.85,
      max: 3,
      mean: 2,
    });

    // blog depths 1,2,3,4 — n=4. mean 2.5; p25 1 + 0.75*1 = 1.75;
    // median 2 + 0.5*1 = 2.5; p75 3 + 0.25*1 = 3.25; p95 3 + 0.85*1 = 3.85.
    expect(rows["page_type|blog"]).toEqual({
      count: 4,
      min: 1,
      p25: 1.75,
      median: 2.5,
      p75: 3.25,
      p95: 3.85,
      max: 4,
      mean: 2.5,
    });

    // untyped depths 0,5 — n=2. mean 2.5; p25 0 + 0.25*5 = 1.25; median 2.5;
    // p75 0 + 0.75*5 = 3.75; p95 0 + 0.95*5 = 4.75.
    expect(rows[`page_type|${UNTYPED}`]).toEqual({
      count: 2,
      min: 0,
      p25: 1.25,
      median: 2.5,
      p75: 3.75,
      p95: 4.75,
      max: 5,
      mean: 2.5,
    });

    expect(Object.keys(rows).sort()).toEqual([
      "page_type|(untyped)",
      "page_type|blog",
      "page_type|product",
      "site|",
    ]);
  });

  // The two lists are bounded in SQL, and the bound is the reason: a crawl of
  // 50,000 pages must not put 50,000 URLs in one jsonb value.
  it("caps each extremes list at the list cap, deterministically", async () => {
    const capCrawl = await newCrawl();
    // 22 pages: /x01 with three inbound links, /x02 with two, and twenty with
    // none at all. Every list slot is therefore contested by a tie, so the
    // url tiebreak decides which twenty are named.
    const specs: PageSpec[] = [];
    for (let i = 1; i <= 22; i += 1) {
      specs.push({ path: `/x${String(i).padStart(2, "0")}`, pageType: "page", depth: 1 });
    }
    const ids = await addPages(capCrawl, specs);
    await addLinks(capCrawl, ids, [
      ["/x03", "/x01"],
      ["/x04", "/x01"],
      ["/x05", "/x01"],
      ["/x06", "/x02"],
      ["/x07", "/x02"],
    ]);

    const rows = await run("inlinks.extremes", capCrawl);
    const value = rows["site|"] as {
      bottom: { url: string; inlinks: number }[];
      top: { url: string; inlinks: number }[];
    };
    expect(EXTREMES_LIST_CAP).toBe(20);
    expect(value.bottom).toHaveLength(EXTREMES_LIST_CAP);
    expect(value.top).toHaveLength(EXTREMES_LIST_CAP);

    // Bottom: the twenty zero-inlink pages, in url order — /x01 and /x02 are
    // the only pages with any inbound links, so they are the two omitted.
    expect(value.bottom.map((e) => e.url)).toEqual(
      Array.from({ length: 20 }, (_, i) => url(`/x${String(i + 3).padStart(2, "0")}`)),
    );
    expect(new Set(value.bottom.map((e) => e.inlinks))).toEqual(new Set([0]));

    // Top: /x01 (3), /x02 (2), then the zero-inlink pages in url order until
    // the cap — so the last two of them, /x21 and /x22, are the ones dropped.
    expect(value.top.slice(0, 2)).toEqual([
      { url: url("/x01"), inlinks: 3 },
      { url: url("/x02"), inlinks: 2 },
    ]);
    expect(value.top.slice(2).map((e) => e.url)).toEqual(
      Array.from({ length: 18 }, (_, i) => url(`/x${String(i + 3).padStart(2, "0")}`)),
    );
  });

  // The same bound on the other unbounded axis: a site with hundreds of
  // templates must not produce a jsonb object with hundreds of keys.
  it("caps the source types per target at the cap and rolls the rest into '(other)'", async () => {
    const capCrawl = await newCrawl();
    // One target, and thirty source pages each of its own type, each linking
    // to the target once. Every source type therefore has a count of 1, so the
    // cap's tiebreak — count desc, then type name ascending — decides: t01…t25
    // are named and t26…t30 are rolled up.
    const specs: PageSpec[] = [{ path: "/hub", pageType: "hub", depth: 0 }];
    const edges: [string, string][] = [];
    for (let i = 1; i <= 30; i += 1) {
      const path = `/s${String(i).padStart(2, "0")}`;
      specs.push({ path, pageType: `t${String(i).padStart(2, "0")}`, depth: 1 });
      edges.push([path, "/hub"]);
    }
    const ids = await addPages(capCrawl, specs);
    await addLinks(capCrawl, ids, edges);

    const rows = await run("inlinks.sources-by-type", capCrawl);
    expect(SOURCE_TYPE_CAP).toBe(25);

    const named: Record<string, number> = {};
    for (let i = 1; i <= SOURCE_TYPE_CAP; i += 1) named[`t${String(i).padStart(2, "0")}`] = 1;
    expect(OTHER_SOURCES).toBe("(other)");
    expect(rows["page_type|hub"]).toEqual({
      sources: { ...named, [OTHER_SOURCES]: 30 - SOURCE_TYPE_CAP },
    });

    // The thirty source pages are cohort members too, and nothing links to any
    // of them: a target cohort with no inbound links at all gets an EMPTY map
    // rather than no row, so "nothing links here" is an answer rather than a
    // silence (the recomputed-state contract — an absent row means a metric
    // that did not run).
    expect(rows["page_type|t01"]).toEqual({ sources: {} });
    expect(rows["page_type|t30"]).toEqual({ sources: {} });
    expect(Object.keys(rows)).toHaveLength(31);
  });

  // The rollup key is parenthesised, and this is what that buys. A `page_type`
  // can be a client-configured name, so a site really can have a template
  // called `other` — and unlike the `(untyped)` collision, merging it into the
  // rollup would NOT be sound: the ranked CTE still knows which rows are the
  // named type inside the cap and which are the remainder past it.
  it("keeps a source type genuinely named 'other' apart from the rollup bucket", async () => {
    const collideCrawl = await newCrawl();
    // One target, one source type literally named `other` with TWO source pages
    // (so it ranks first on count and lands well inside the cap), and thirty
    // single-page types after it. Ranks: `other` 1, t01…t24 2…25, and t25…t30
    // past the cap and into the rollup.
    const specs: PageSpec[] = [
      { path: "/hub", pageType: "hub", depth: 0 },
      { path: "/o1", pageType: "other", depth: 1 },
      { path: "/o2", pageType: "other", depth: 1 },
    ];
    const edges: [string, string][] = [
      ["/o1", "/hub"],
      ["/o2", "/hub"],
    ];
    for (let i = 1; i <= 30; i += 1) {
      const path = `/s${String(i).padStart(2, "0")}`;
      specs.push({ path, pageType: `t${String(i).padStart(2, "0")}`, depth: 1 });
      edges.push([path, "/hub"]);
    }
    const ids = await addPages(collideCrawl, specs);
    await addLinks(collideCrawl, ids, edges);

    const rows = await run("inlinks.sources-by-type", collideCrawl);

    const named: Record<string, number> = { other: 2 };
    // `other` took rank 1, so only 24 of the t-types fit under the cap.
    for (let i = 1; i <= SOURCE_TYPE_CAP - 1; i += 1) named[`t${String(i).padStart(2, "0")}`] = 1;
    expect(rows["page_type|hub"]).toEqual({
      sources: { ...named, [OTHER_SOURCES]: 30 - (SOURCE_TYPE_CAP - 1) },
    });
    // The two keys are distinct and neither absorbed the other's count.
    const hub = (rows["page_type|hub"] as { sources: Record<string, number> }).sources;
    expect(hub["other"]).toBe(2);
    expect(hub[OTHER_SOURCES]).toBe(6);
  });

  // `links` has no foreign key to `pages`, so a link whose source row is
  // missing is a database state nothing forbids. The two CHECK-33 metrics must
  // not disagree about it: `inlinks.distribution` counts `source_page_id`
  // without visiting `pages` at all, so `inlinks.sources-by-type` LEFT-joins
  // the source rather than dropping the link on an inner join.
  it("counts a link whose source page row is missing, and types it as untyped", async () => {
    const danglingCrawl = await newCrawl();
    await addPages(danglingCrawl, [{ path: "/target", pageType: "product", depth: 0 }]);
    await db.insert(links).values({
      crawlId: danglingCrawl,
      sourcePageId: "page_no_such_row",
      targetUrl: url("/target"),
      targetPageId: null,
      anchor: "from nowhere",
      rel: null,
      isInternal: true,
      isNofollow: false,
      position: 0,
    });

    // One inbound link, said by both metrics rather than by one of them.
    const dist = await run("inlinks.distribution", danglingCrawl);
    expect((dist["site|"] as { count: number; max: number }).max).toBe(1);
    expect(await run("inlinks.sources-by-type", danglingCrawl)).toEqual({
      "page_type|product": { sources: { [UNTYPED]: 1 } },
    });
  });

  it("answers a crawl with no cohort pages with an empty site row rather than silence", async () => {
    const emptyCrawl = await newCrawl();
    await addPages(emptyCrawl, [
      { path: "/only", pageType: "product", depth: 0, statusCode: 500, fetchClass: "server_error" },
    ]);

    // A distribution over nothing is `count: 0` and no statistics — stated,
    // not omitted, because a missing metric row means the metric never ran.
    const empty = { count: 0, min: null, p25: null, median: null, p75: null, p95: null, max: null, mean: null };
    expect(await run("inlinks.distribution", emptyCrawl)).toEqual({ "site|": empty });
    expect(await run("structure.depth-distribution", emptyCrawl)).toEqual({ "site|": empty });
    expect(await run("inlinks.extremes", emptyCrawl)).toEqual({ "site|": { bottom: [], top: [] } });
    // No target cohorts at all, so this one legitimately has nothing to say.
    expect(await run("inlinks.sources-by-type", emptyCrawl)).toEqual({});
  });

  it("says nothing about a crawl id that owns no pages", async () => {
    // Not an error and not a fabrication: the metrics are computed over the
    // crawl's rows, and a crawl with none has an empty cohort. The pair of this
    // test is the one below — a crawl that EXISTS and owns no pages is silence,
    // a crawl id nothing knows is an error, and the whole point is that the two
    // do not look alike.
    const otherCrawl = await newCrawl();
    const rows = await run("inlinks.sources-by-type", otherCrawl);
    expect(rows).toEqual({});
  });

  it("refuses a crawl id nothing knows, rather than answering an empty table", async () => {
    // The empty answers pinned just above are what an unknown crawl would
    // produce too — `count: 0`, two empty lists, no cohort rows — so each rule
    // gates on the crawl existing first (hard rule 7, `runRules`' precedent).
    await expectRefusesUnknownCrawl(db, linkMetrics);
  });
});

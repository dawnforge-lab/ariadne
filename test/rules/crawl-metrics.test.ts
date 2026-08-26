/**
 * The crawl-shape metrics — redirect volume and sitemap structure — against a
 * real database.
 *
 * Rows are inserted directly (the link-metrics pattern): what is under test is
 * the arithmetic over a crawl's stored rows, not the crawling that produced
 * them. Every number below is hand-derived from the table printed beside it.
 *
 * `redirect.volume` counts the `issues` rows the redirect QUERY rules wrote, so
 * this file inserts issues rows of its own — including one carrying the
 * truncation note a capped listing writes, which is the only way the metric can
 * report more chains than there are rows to count.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { issues, pages, sitemapUrls } from "../../src/db/schema.js";
import {
  crawlMetrics,
  SITEMAP_DOC_ROWS_CAP,
  SITEMAP_URL_CAP,
} from "../../src/rules/metric/crawl-metrics.js";
import type { Metric } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { databaseUrl, dropCrawls, metricLookup, newMetricCrawl } from "./metric-db.js";
import { normalised, writerIndexable, type IndexabilitySpec } from "./mk-page.js";

const SITE = "https://crawl-metrics.example";
const url = (path: string): string => `${SITE}${path}`;

const rule = metricLookup(crawlMetrics, "crawlMetrics");

describe("crawlMetrics metadata", () => {
  it("defines the two metrics of the phase-4 table, with their checks", () => {
    expect(crawlMetrics.map((r) => r.id)).toEqual(["redirect.volume", "sitemap.structure"]);
    expect(
      crawlMetrics.map((r) => [r.id, r.checkIds, r.category, r.severity, r.kind]),
    ).toEqual([
      ["redirect.volume", ["CHECK-10"], "redirects", "info", "metric"],
      ["sitemap.structure", ["CHECK-08"], "sitemap", "info", "metric"],
    ]);
    for (const r of crawlMetrics) {
      expect(r.title.length).toBeGreaterThan(5);
      expect(r.explanation.length).toBeGreaterThan(40);
      expect(r.howToFix.length).toBeGreaterThan(30);
      expect(r.rulesetVersion).toBeTruthy();
    }
  });
});

interface PageSpec extends IndexabilitySpec {
  path: string;
}

describe("the crawl metrics against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  const newCrawl = async (discovery: unknown = mkDiscovery()): Promise<string> =>
    newMetricCrawl(db, SITE, createdCrawls, {
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      discovery: discovery as Record<string, unknown> | null,
    });

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    await db.insert(pages).values(
      specs.map((s) => ({
        id: `page_${randomUUID()}`,
        crawlId,
        url: url(s.path),
        urlNormalised: url(s.path),
        pageType: "content",
        fetchClass: s.fetchClass ?? "ok",
        statusCode: s.statusCode === undefined ? 200 : s.statusCode,
        isIndexable: writerIndexable(s),
        depth: 1,
        discoveredVia: "link",
      })),
    );
  }

  /** Issues rows exactly as `runRules` writes them. */
  async function addIssues(
    crawlId: string,
    rows: { ruleId: string; key: string; details?: Record<string, unknown> }[],
  ): Promise<void> {
    await db.insert(issues).values(
      rows.map((r) => ({
        crawlId,
        ruleId: r.ruleId,
        pageId: null,
        severity: "warning",
        rulesetVersion: "test",
        dedupeKey: r.key,
        details: { pageUrl: url(`/${r.key}`), ...r.details },
      })),
    );
  }

  async function site(metricId: string, crawlId: string): Promise<Record<string, unknown>> {
    const rows: Metric[] = await rule(metricId).run(db, crawlId);
    const siteRows = rows.filter((m) => m.scope === "site");
    expect(siteRows).toHaveLength(1);
    expect(siteRows[0]!.metricId).toBe(metricId);
    expect(siteRows[0]!.scopeValue).toBe("");
    return siteRows[0]!.value;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await dropCrawls(db, createdCrawls);
    await closeDb(db);
  });

  describe("redirect.volume", () => {
    const ID = "redirect.volume";

    /**
     * THE CRAWL UNDER TEST. Seven page rows, three of them redirects.
     *
     *   /r1  301 redirect
     *   /r2  302 redirect
     *   /r3  301 redirect
     *   /ok1 200 ok
     *   /ok2 200 ok
     *   /ok3 200 ok
     *   /gone 404 client_error
     */
    const SPECS: PageSpec[] = [
      { path: "/r1", statusCode: 301, fetchClass: "redirect" },
      { path: "/r2", statusCode: 302, fetchClass: "redirect" },
      { path: "/r3", statusCode: 301, fetchClass: "redirect" },
      { path: "/ok1" },
      { path: "/ok2" },
      { path: "/ok3" },
      { path: "/gone", statusCode: 404, fetchClass: "client_error" },
    ];

    it("counts redirect pages, the whole crawl, the share and the graph faults", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, SPECS);
      await addIssues(crawlId, [
        { ruleId: "redirect.chain", key: "chain-a" },
        { ruleId: "redirect.chain", key: "chain-b" },
        { ruleId: "redirect.loop", key: "loop-a" },
        // Another rule's rows, on the same crawl: a count that forgot to filter
        // by rule id would fold these in.
        { ruleId: "links.broken-internal", key: "broken-a" },
        { ruleId: "links.broken-internal", key: "broken-b" },
      ]);

      expect(await site(ID, crawlId)).toEqual({
        redirectPages: 3,
        // Every page row, whatever it answered — the 404 included.
        totalPages: 7,
        // 100 * 3 / 7 = 42.857142… -> 42.9, rounded to one decimal place in SQL.
        ratioPct: 42.9,
        chains: 2,
        loops: 1,
      });
    });

    it("reports the exact chain count where the findings listing was capped", async () => {
      // A capped listing writes `truncated: {reported, total}` onto its last
      // finding, and `total` is the exact number the rule counted. Counting
      // rows alone would report 3 chains for a crawl with 4,111 of them.
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/r1", statusCode: 301, fetchClass: "redirect" }]);
      await addIssues(crawlId, [
        { ruleId: "redirect.chain", key: "chain-a" },
        { ruleId: "redirect.chain", key: "chain-b" },
        {
          ruleId: "redirect.chain",
          key: "chain-c",
          details: { truncated: { reported: 3, total: 4111 } },
        },
        // The loop rule was not capped: no note, so its listing is complete and
        // the row count is the answer. The absence of a note MEANS that.
        { ruleId: "redirect.loop", key: "loop-a" },
      ]);

      const value = await site(ID, crawlId);
      expect(value["chains"]).toBe(4111);
      expect(value["loops"]).toBe(1);
    });

    it("refuses a lower-bound truncation note rather than reporting the listing", async () => {
      // The other truncation shape — `{reported, atLeast}`, what a rule writes
      // when it stopped LOOKING — carries no exact total. These two rules never
      // write one today; if an edit ever swapped them to
      // `noteAtLeastTruncation`, reporting the listing under a column called
      // `chains` would put a capped 200 where the copy promises a full count.
      // The metric stops instead, so that decision gets made deliberately.
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/r1", statusCode: 301, fetchClass: "redirect" }]);
      await addIssues(crawlId, [
        {
          ruleId: "redirect.loop",
          key: "loop-a",
          details: { truncated: { reported: 1, atLeast: 9 } },
        },
      ]);

      await expect(rule(ID).run(db, crawlId)).rejects.toThrow(
        /redirect\.volume: crawl finding 'redirect\.loop' carries a truncation note/,
      );
    });

    it("refuses a truncation note whose total is not a number", async () => {
      // `total: "4111"` is a note we cannot read — a jsonb string where a count
      // belongs. Ignoring it would ship the capped listing as an exact count
      // under copy that says "counted in full" (hard rule 7).
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/r1", statusCode: 301, fetchClass: "redirect" }]);
      await addIssues(crawlId, [
        {
          ruleId: "redirect.chain",
          key: "chain-a",
          details: { truncated: { reported: 1, total: "4111" } },
        },
      ]);

      await expect(rule(ID).run(db, crawlId)).rejects.toThrow(
        /'redirect\.chain' carries a truncation note that names no numeric `total`/,
      );
    });

    it("refuses a truncation note that is not an object at all", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/r1", statusCode: 301, fetchClass: "redirect" }]);
      await addIssues(crawlId, [
        { ruleId: "redirect.chain", key: "chain-a", details: { truncated: 4111 } },
      ]);

      await expect(rule(ID).run(db, crawlId)).rejects.toThrow(/is not an object/);
    });

    it("answers a crawl with no pages with a null share rather than a zero", async () => {
      const crawlId = await newCrawl();
      // 0 of 0 is not 0%: there is nothing to take a share of, and "none of this
      // crawl was redirects" is a claim about a crawl that fetched nothing.
      expect(await site(ID, crawlId)).toEqual({
        redirectPages: 0,
        totalPages: 0,
        ratioPct: null,
        chains: 0,
        loops: 0,
      });
    });

    it("ignores another crawl's pages and issues", async () => {
      const mine = await newCrawl();
      const theirs = await newCrawl();
      await addPages(mine, [{ path: "/r1", statusCode: 301, fetchClass: "redirect" }]);
      await addPages(theirs, [
        { path: "/r1", statusCode: 301, fetchClass: "redirect" },
        { path: "/ok1" },
      ]);
      await addIssues(theirs, [{ ruleId: "redirect.chain", key: "chain-a" }]);

      expect(await site(ID, mine)).toEqual({
        redirectPages: 1,
        totalPages: 1,
        ratioPct: 100,
        chains: 0,
        loops: 0,
      });
    });

    it("refuses a crawl id nothing knows rather than reporting a clean crawl", async () => {
      await expect(rule(ID).run(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("sitemap.structure", () => {
    const ID = "sitemap.structure";

    const doc = (name: string): string => `${SITE}/${name}`;

    async function addEntries(
      crawlId: string,
      entries: { path: string; source: string }[],
    ): Promise<void> {
      await db.insert(sitemapUrls).values(
        entries.map((e) => ({
          crawlId,
          url: url(e.path),
          urlNormalised: normalised(url(e.path)),
          sitemapSource: e.source,
          lastmod: null,
        })),
      );
    }

    async function docRows(crawlId: string): Promise<[string, unknown][]> {
      const rows: Metric[] = await rule(ID).run(db, crawlId);
      return rows
        .filter((m) => m.scope === "sitemap_doc")
        .map((m) => [m.scopeValue, m.value] as [string, unknown]);
    }

    it("counts the documents, their entries and what the walk could not read", async () => {
      // THE SITEMAP UNDER TEST. Three documents contributing six entries:
      //   sitemap-products.xml   /p1 /p2 /p3
      //   sitemap-blog.xml       /b1 /b2
      //   sitemap-pages.xml      /x1
      // The crawl's discovery evidence says two further documents were fetched
      // and dropped whole for their size, so their entries are in none of these
      // counts — which is what that column is for.
      const crawlId = await newCrawl(
        mkDiscovery({ truncation: { oversizedDocsSkipped: 2, docsFetched: 5 } }),
      );
      await addEntries(crawlId, [
        { path: "/p1", source: doc("sitemap-products.xml") },
        { path: "/p2", source: doc("sitemap-products.xml") },
        { path: "/p3", source: doc("sitemap-products.xml") },
        { path: "/b1", source: doc("sitemap-blog.xml") },
        { path: "/b2", source: doc("sitemap-blog.xml") },
        { path: "/x1", source: doc("sitemap-pages.xml") },
      ]);

      expect(await site(ID, crawlId)).toEqual({
        docs: 3,
        totalUrls: 6,
        oversizedDocsSkipped: 2,
        urlCapBreaches: 0,
        entryCapReached: false,
      });

      // Ordered by entries descending, ties by source URL ascending.
      expect(await docRows(crawlId)).toEqual([
        [doc("sitemap-products.xml"), { urls: 3, breaches50k: false }],
        [doc("sitemap-blog.xml"), { urls: 2, breaches50k: false }],
        [doc("sitemap-pages.xml"), { urls: 1, breaches50k: false }],
      ]);
    });

    it("says so when the walk's entry cap stopped collection", async () => {
      // Every count in the table is then a floor, and a `breaches50k` of false
      // may be a false negative — so the flag travels with the numbers.
      const crawlId = await newCrawl(mkDiscovery({ truncation: { entryLimited: true } }));
      await addEntries(crawlId, [{ path: "/p1", source: doc("sitemap.xml") }]);
      expect((await site(ID, crawlId))["entryCapReached"]).toBe(true);
    });

    it("flags a document past the protocol's 50,000-entry limit", async () => {
      // The one assertion that cannot be made with a handful of rows: a column
      // that is always false is a column that never says anything, so the cap
      // is crossed for real. One statement, generated in Postgres.
      const crawlId = await newCrawl();
      const big = doc("sitemap-everything.xml");
      const small = doc("sitemap-extra.xml");
      const over = SITEMAP_URL_CAP + 1;
      // Generated in one statement rather than fifty thousand inserts.
      await db.execute(sql`
        insert into sitemap_urls (crawl_id, url, url_normalised, sitemap_source, lastmod)
        select ${crawlId},
               ${`${SITE}/big/`} || g || '/',
               ${`${SITE}/big/`} || g || '/',
               ${big},
               null
        from generate_series(1, ${over}) g`);
      await addEntries(crawlId, [{ path: "/x1", source: small }]);

      expect(await site(ID, crawlId)).toEqual({
        docs: 2,
        totalUrls: over + 1,
        oversizedDocsSkipped: 0,
        urlCapBreaches: 1,
        entryCapReached: false,
      });
      expect(await docRows(crawlId)).toEqual([
        [big, { urls: over, breaches50k: true }],
        [small, { urls: 1, breaches50k: false }],
      ]);
    });

    it("lists the fifty largest documents and says how many there are", async () => {
      // Fifty-two documents of one entry each: every document ties, so the
      // source URL decides, and the same crawl always names the same fifty.
      const crawlId = await newCrawl();
      const names = Array.from({ length: 52 }, (_, i) => `sitemap-${String(i).padStart(2, "0")}.xml`);
      await addEntries(
        crawlId,
        names.map((name, i) => ({ path: `/e${i}`, source: doc(name) })),
      );

      expect(await site(ID, crawlId)).toEqual({
        docs: 52,
        totalUrls: 52,
        oversizedDocsSkipped: 0,
        urlCapBreaches: 0,
        entryCapReached: false,
      });
      const rows = await docRows(crawlId);
      expect(rows).toHaveLength(SITEMAP_DOC_ROWS_CAP);
      expect(rows.map(([source]) => source)).toEqual(
        names.slice(0, SITEMAP_DOC_ROWS_CAP).map((name) => doc(name)),
      );
    });

    it("states a crawl with no sitemap entries rather than staying silent", async () => {
      const crawlId = await newCrawl();
      const rows: Metric[] = await rule(ID).run(db, crawlId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).toEqual({
        docs: 0,
        totalUrls: 0,
        oversizedDocsSkipped: 0,
        urlCapBreaches: 0,
        entryCapReached: false,
      });
    });

    it("refuses a crawl whose discovery evidence is missing", async () => {
      // Two of the site row's columns come out of that blob. A crawl without it
      // is not a site with nothing skipped — it is a row this crawler did not
      // write (hard rule 7).
      const crawlId = await newCrawl(null);
      await expect(rule(ID).run(db, crawlId)).rejects.toThrow(/discovery evidence is missing/);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(rule(ID).run(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });
});

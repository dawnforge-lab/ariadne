/**
 * The sitemap entry rules (26a, Task 10), against a real database: the
 * per-document entry limit, the over-long `<loc>`, the cross-host `<loc>` and
 * the invalid `<lastmod>`.
 *
 * Rows go straight into `sitemap_urls`. The 50,001-entry source is inserted
 * with `generate_series` in SQL, never built as a JS array.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, sitemapUrls } from "../../src/db/schema.js";
import { sitemapEntryRules } from "../../src/rules/query/sitemap-entries.js";
import type { Finding, QueryRule, RuleCaps } from "../../src/rules/registry/types.js";
import { SITEMAP_LOC_MAX, SITEMAP_URL_CAP } from "../../src/rules/thresholds.js";
import { mkDiscovery } from "./mk-discovery.js";
import { normalised } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://entries.example";
const SOURCE = `${SITE}/sitemap.xml`;

function rule(id: string): QueryRule {
  const r = sitemapEntryRules.find((x) => x.id === id);
  if (!r) throw new Error(`no rule '${id}'`);
  return r;
}

describe("sitemapEntryRules metadata", () => {
  it("claims the ids, checks, severities and category the table assigns", () => {
    expect(
      Object.fromEntries(sitemapEntryRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "sitemap.over-50k-urls": [["CHECK-08"], "warning", "sitemap"],
      "sitemap.url-too-long": [["CHECK-07"], "info", "sitemap"],
      "sitemap.cross-host-loc": [["CHECK-07"], "warning", "sitemap"],
      "sitemap.lastmod-invalid": [["CHECK-07"], "info", "sitemap"],
    });
    for (const r of sitemapEntryRules) expect(r.kind).toBe("query");
  });
});

describe("the sitemap entry rules against the database", () => {
  let db: Db;
  const created: string[] = [];

  // `finishedAt` defaults to the start (or now), so a test that names one
  // instant judges against it; pass `null` for a row no crawl loop closed.
  async function newCrawl(
    startedAt?: Date,
    finishedAt: Date | null = startedAt ?? new Date(),
  ): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 500, userAgent: "AriadneBot-test" },
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 1,
      discovery: mkDiscovery(),
      finishedAt,
      ...(startedAt === undefined ? {} : { startedAt }),
    });
    created.push(id);
    return id;
  }

  async function add(
    crawlId: string,
    entries: { url: string; source?: string; lastmod?: string | null }[],
  ): Promise<void> {
    await db.insert(sitemapUrls).values(
      entries.map((e) => ({
        crawlId,
        url: e.url,
        urlNormalised: normalised(e.url),
        sitemapSource: e.source ?? SOURCE,
        lastmod: e.lastmod ?? null,
      })),
    );
  }

  const run = (id: string, crawlId: string, caps?: RuleCaps): Promise<Finding[]> =>
    rule(id).run(db, crawlId, caps);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });
  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  // ------------------------------------------------------ over-50k-urls

  it("fires once per document holding more than the cap, and counts in SQL", async () => {
    const crawlId = await newCrawl();
    const big = `${SITE}/big.xml`;
    await db.execute(sql`
      insert into sitemap_urls (crawl_id, url, url_normalised, sitemap_source)
      select ${crawlId}, ${SITE + "/p/"} || g, ${SITE + "/p/"} || g, ${big}
      from generate_series(1, ${SITEMAP_URL_CAP + 1}) g`);
    await add(crawlId, [{ url: `${SITE}/small-1` }, { url: `${SITE}/small-2` }]);

    const found = await run("sitemap.over-50k-urls", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ruleId: "sitemap.over-50k-urls",
      severity: "warning",
      pageId: null,
      dedupeKey: big,
    });
    expect(found[0]!.evidence).toEqual({ sitemap: big, entries: SITEMAP_URL_CAP + 1 });
  });

  it("is silent at exactly the cap", async () => {
    const crawlId = await newCrawl();
    await db.execute(sql`
      insert into sitemap_urls (crawl_id, url, url_normalised, sitemap_source)
      select ${crawlId}, ${SITE + "/p/"} || g, ${SITE + "/p/"} || g, ${SOURCE}
      from generate_series(1, ${SITEMAP_URL_CAP}) g`);
    expect(await run("sitemap.over-50k-urls", crawlId)).toHaveLength(0);
  });

  // ------------------------------------------------------ url-too-long

  it("fires on a loc past the limit, not at it", async () => {
    const crawlId = await newCrawl();
    const prefix = `${SITE}/`;
    const atLimit = prefix + "a".repeat(SITEMAP_LOC_MAX - prefix.length);
    const over = atLimit + "b";
    await add(crawlId, [{ url: atLimit }, { url: over }, { url: `${SITE}/short` }]);

    const found = await run("sitemap.url-too-long", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ruleId: "sitemap.url-too-long", severity: "info", pageUrl: over });
    expect(found[0]!.evidence).toEqual({
      sitemap: SOURCE,
      loc: over.slice(0, 200),
      length: SITEMAP_LOC_MAX + 1,
    });
  });

  it("attaches the finding to the page the entry names, when there is one", async () => {
    const crawlId = await newCrawl();
    const over = `${SITE}/x#${"f".repeat(SITEMAP_LOC_MAX)}`;
    const pageId = `page_${randomUUID()}`;
    await db.insert(pages).values({
      id: pageId, crawlId, url: `${SITE}/x`, urlNormalised: `${SITE}/x`,
      fetchClass: "ok", statusCode: 200, depth: 0, discoveredVia: "sitemap",
    });
    await db.insert(sitemapUrls).values({
      crawlId, url: over, urlNormalised: `${SITE}/x`, sitemapSource: SOURCE, lastmod: null,
    });
    const found = await run("sitemap.url-too-long", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.pageId).toBe(pageId);
    expect(found[0]!.pageUrl).toBe(`${SITE}/x`);
  });

  // ------------------------------------------------------ cross-host-loc

  it("fires when the loc's scheme or host differs from its document's", async () => {
    const crawlId = await newCrawl();
    await add(crawlId, [
      { url: `${SITE}/same` },
      { url: "http://other.example/x" },
      { url: "http://entries.example/downgraded" },
      { url: "https://www.entries.example/www" },
      { url: "https://entries.example:8443/port" },
    ]);
    const found = await run("sitemap.cross-host-loc", crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([
      "http://entries.example/downgraded",
      "http://other.example/x",
      "https://entries.example:8443/port",
      "https://www.entries.example/www",
    ]);
    expect(found[1]).toMatchObject({ ruleId: "sitemap.cross-host-loc", severity: "warning" });
    expect(found[1]!.evidence).toEqual({ sitemap: SOURCE, loc: "http://other.example/x" });
  });

  it("compares against each entry's own document, case-insensitively", async () => {
    const crawlId = await newCrawl();
    await add(crawlId, [
      { url: "https://cdn.example/a", source: "https://cdn.example/sitemap.xml" },
      { url: "https://CDN.example/b", source: "https://cdn.example/sitemap.xml" },
    ]);
    expect(await run("sitemap.cross-host-loc", crawlId)).toHaveLength(0);
  });

  it("is silent for a document on another host that lists the crawled site's own URLs", async () => {
    // sitemaps.org cross-submission: the CDN-hosted document lists SITE's URLs.
    const crawlId = await newCrawl();
    await add(crawlId, [
      { url: `${SITE}/a`, source: "https://cdn.example/sitemap.xml" },
      { url: `${SITE}/b`, source: "https://cdn.example/sitemap.xml" },
    ]);
    expect(await run("sitemap.cross-host-loc", crawlId)).toHaveLength(0);
  });

  it("fires for a site sitemap listing a third host, and for http in an https sitemap", async () => {
    const crawlId = await newCrawl();
    await add(crawlId, [
      { url: "https://third.example/x" },
      { url: "http://entries.example/y" },
      // Another host's document listing a third host: differs from both.
      { url: "https://third.example/z", source: "https://cdn.example/sitemap.xml" },
    ]);
    const found = await run("sitemap.cross-host-loc", crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([
      "http://entries.example/y",
      "https://third.example/x",
      "https://third.example/z",
    ]);
  });

  // ------------------------------------------------------ lastmod-invalid

  it("reports a bad format and a future date, and accepts every W3C form", async () => {
    const crawlId = await newCrawl(new Date("2026-11-05T12:00:00Z"));
    const lastmods: Record<string, string | null> = {
      "/bad-month": "2026-13-01",
      "/future": "2999-01-01",
      "/valid-offset": "2026-11-04T10:00:00+00:00",
      "/no-zone": "2026-11-04T10:00:00",
      "/not-a-day": "2026-02-30",
      "/words": "yesterday",
      "/year": "2026",
      "/month": "2026-11",
      "/date": "2026-11-05",
      "/min": "2026-11-04T10:00Z",
      "/frac": "2026-11-04T10:00:00.123456-05:00",
      "/none": null,
    };
    await add(crawlId, Object.entries(lastmods).map(([p, lastmod]) => ({ url: SITE + p, lastmod })));

    const found = await run("sitemap.lastmod-invalid", crawlId);
    expect(found.map((f) => [new URL(f.pageUrl!).pathname, f.evidence["reason"]])).toEqual([
      ["/bad-month", "format"],
      ["/future", "future"],
      ["/not-a-day", "format"],
      ["/no-zone", "format"],
      ["/words", "format"],
    ]);
    expect(found[1]).toMatchObject({ ruleId: "sitemap.lastmod-invalid", severity: "info" });
    expect(found[1]!.evidence).toEqual({
      sitemap: SOURCE, loc: `${SITE}/future`, lastmod: "2999-01-01", reason: "future",
    });
  });

  it("judges the future against the crawl's end, honouring the offset and treating zone-less forms as UTC", async () => {
    const crawlId = await newCrawl(new Date("2026-11-05T12:00:00Z"));
    const lastmods: Record<string, string> = {
      // 12:30+01:00 is 11:30Z, before the crawl: valid.
      "/offset-before": "2026-11-05T12:30:00+01:00",
      // 12:30-01:00 is 13:30Z, after the crawl: future.
      "/offset-after": "2026-11-05T12:30:00-01:00",
      // Today's date, this month and this year: the period starts before the crawl.
      "/today": "2026-11-05",
      "/this-month": "2026-11",
      "/this-year": "2026",
      "/tomorrow": "2026-11-06",
      "/next-month": "2026-12",
      "/next-year": "2027",
    };
    await add(crawlId, Object.entries(lastmods).map(([p, lastmod]) => ({ url: SITE + p, lastmod })));
    const found = await run("sitemap.lastmod-invalid", crawlId);
    expect(found.map((f) => new URL(f.pageUrl!).pathname)).toEqual([
      "/next-month", "/next-year", "/offset-after", "/tomorrow",
    ]);
  });

  it("is silent on a lastmod stamped after the crawl began but before it ended", async () => {
    // The Phase 26a gate's lavishalice crawl: discovery read a Shopify sitemap
    // eight seconds after `started_at`, and the site stamped every entry with the
    // moment it generated the file. That was "now" when served, not future.
    const crawlId = await newCrawl(
      new Date("2026-11-04T17:17:00.507Z"),
      new Date("2026-11-04T17:32:28.598Z"),
    );
    await add(crawlId, [
      { url: `${SITE}/at-start`, lastmod: "2026-11-04T17:17:00+00:00" },
      { url: `${SITE}/seconds-after-start`, lastmod: "2026-11-04T17:17:08+00:00" },
      { url: `${SITE}/just-before-end`, lastmod: "2026-11-04T17:32:28+00:00" },
      { url: `${SITE}/after-end`, lastmod: "2026-11-04T17:32:29+00:00" },
      { url: `${SITE}/next-day`, lastmod: "2026-11-05" },
    ]);
    const found = await run("sitemap.lastmod-invalid", crawlId);
    expect(found.map((f) => [new URL(f.pageUrl!).pathname, f.evidence["reason"]])).toEqual([
      ["/after-end", "future"],
      ["/next-day", "future"],
    ]);
  });

  it("throws, naming the crawl, when there are lastmod values and no finished_at", async () => {
    const crawlId = await newCrawl(new Date("2026-11-04T17:17:00Z"), null);
    await add(crawlId, [{ url: `${SITE}/dated`, lastmod: "2026-11-04T17:17:08+00:00" }]);
    await expect(run("sitemap.lastmod-invalid", crawlId)).rejects.toThrow(
      new RegExp(`sitemap\\.lastmod-invalid: crawl '${crawlId}' has sitemap lastmod values but no finished_at`),
    );
  });

  it("does not refuse a crawl with no finished_at when no entry carries a lastmod", async () => {
    const crawlId = await newCrawl(new Date("2026-11-04T17:17:00Z"), null);
    await add(crawlId, [{ url: `${SITE}/undated`, lastmod: null }]);
    expect(await run("sitemap.lastmod-invalid", crawlId)).toEqual([]);
  });

  // ------------------------------------------------------ caps

  it("spends the listing cap and notes the exact total", async () => {
    const crawlId = await newCrawl();
    await add(crawlId, [1, 2, 3, 4, 5].map((n) => ({ url: `https://other${n}.example/x` })));
    const found = await run("sitemap.cross-host-loc", crawlId, { listing: 2 });
    expect(found).toHaveLength(2);
    expect(JSON.stringify(found.at(-1))).toContain('"total":5');
  });

  it("throws for a crawl that does not exist", async () => {
    for (const r of sitemapEntryRules) {
      await expect(r.run(db, `crawl_${randomUUID()}`)).rejects.toThrow();
    }
  });
});

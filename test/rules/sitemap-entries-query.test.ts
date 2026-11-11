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
import { crawls, pages, sitemapMemberships, sitemapUrls } from "../../src/db/schema.js";
import { sitemapEntryRules } from "../../src/rules/query/sitemap-entries.js";
import type { Finding, QueryRule, RuleCaps } from "../../src/rules/registry/types.js";
import { INDEXED_URL_MAX } from "../../src/crawl/parse/url-utils.js";
import { SITEMAP_MAX_BYTES } from "../../src/crawl/sitemap-stream.js";
import { pageFactsRules } from "../../src/rules/query/page-facts.js";
import { sitemapRules } from "../../src/rules/query/sitemap.js";
import { SITEMAP_LOC_MAX, SITEMAP_URL_CAP } from "../../src/rules/thresholds.js";
import { mkDiscovery } from "./mk-discovery.js";
import { normalised } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

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
      "sitemap.oversized": [["CHECK-08"], "warning", "sitemap"],
      "sitemap.url-in-multiple": [["CHECK-08"], "info", "sitemap"],
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
    discovery: ReturnType<typeof mkDiscovery> = mkDiscovery(),
  ): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE, hostKey: hostKeyOf(SITE),
      config: { maxPages: 500, userAgent: "AriadneBot-test" },
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 1,
      discovery,
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
        seenAt: new Date(),
        lastmod: e.lastmod ?? null,
      })),
    );
  }

  async function addMemberships(
    crawlId: string,
    rows: { url: string; source: string; normalised?: string }[],
  ): Promise<void> {
    await db.insert(sitemapMemberships).values(
      rows.map((r) => ({
        crawlId,
        url: r.url,
        urlNormalised: r.normalised ?? normalised(r.url),
        sitemapSource: r.source,
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
      insert into sitemap_memberships (crawl_id, url, url_normalised, sitemap_source)
      select ${crawlId}, ${SITE + "/p/"} || g, ${SITE + "/p/"} || g, ${big}
      from generate_series(1, ${SITEMAP_URL_CAP + 1}) g`);
    await addMemberships(crawlId, [
      { url: `${SITE}/small-1`, source: SOURCE },
      { url: `${SITE}/small-2`, source: SOURCE },
    ]);

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
      insert into sitemap_memberships (crawl_id, url, url_normalised, sitemap_source)
      select ${crawlId}, ${SITE + "/p/"} || g, ${SITE + "/p/"} || g, ${SOURCE}
      from generate_series(1, ${SITEMAP_URL_CAP}) g`);
    expect(await run("sitemap.over-50k-urls", crawlId)).toHaveLength(0);
  });

  it("counts a URL listed in two documents once per document (exact, not a lower bound)", async () => {
    const crawlId = await newCrawl();
    const a = `${SITE}/a.xml`;
    const b = `${SITE}/b.xml`;
    // Both documents list the same URLs. `sitemap_urls` would keep each URL
    // under its first source only, so document b would read as empty there;
    // memberships hold one row per URL per document.
    await db.execute(sql`
      insert into sitemap_memberships (crawl_id, url, url_normalised, sitemap_source)
      select ${crawlId}, ${SITE + "/p/"} || g, ${SITE + "/p/"} || g, src
      from generate_series(1, ${SITEMAP_URL_CAP + 1}) g, unnest(array[${a}, ${b}]::text[]) src`);
    const found = await run("sitemap.over-50k-urls", crawlId);
    expect(found.map((f) => f.evidence)).toEqual([
      { sitemap: a, entries: SITEMAP_URL_CAP + 1 },
      { sitemap: b, entries: SITEMAP_URL_CAP + 1 },
    ]);
  });

  it("says membershipLimited on its evidence when the membership cap was hit (the count is a floor)", async () => {
    const crawlId = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({ sitemapFacts: { membershipLimited: true } }),
    );
    await db.execute(sql`
      insert into sitemap_memberships (crawl_id, url, url_normalised, sitemap_source)
      select ${crawlId}, ${SITE + "/p/"} || g, ${SITE + "/p/"} || g, ${SOURCE}
      from generate_series(1, ${SITEMAP_URL_CAP + 1}) g`);
    const [finding] = await run("sitemap.over-50k-urls", crawlId);
    expect(finding!.evidence).toEqual({
      sitemap: SOURCE,
      entries: SITEMAP_URL_CAP + 1,
      membershipLimited: true,
    });
  });

  it("refuses a crawl without sitemapFacts (returns nothing) and the marker speaks", async () => {
    const crawlId = await newCrawl(undefined, undefined, mkDiscovery({ sitemapFacts: null }));
    await db.execute(sql`
      insert into sitemap_urls (crawl_id, url, url_normalised, sitemap_source, seen_at)
      select ${crawlId}, ${SITE + "/p/"} || g, ${SITE + "/p/"} || g, ${SOURCE}, now()
      from generate_series(1, ${SITEMAP_URL_CAP + 1}) g`);
    expect(await run("sitemap.over-50k-urls", crawlId)).toEqual([]);
    expect(await run("sitemap.oversized", crawlId)).toEqual([]);
    expect(await run("sitemap.url-in-multiple", crawlId)).toEqual([]);
    const marker = pageFactsRules.find((r) => r.id === "extraction.not-recorded");
    if (marker === undefined) throw new Error("no marker");
    const speaks = await marker.run(db, crawlId);
    expect(speaks).toHaveLength(1);
    expect(speaks[0]!.evidence).toMatchObject({ sitemapFactsRecorded: false });
  });

  // ------------------------------------------------------ oversized

  it("reports each oversized document with its bytes read and URLs kept", async () => {
    const big = `${SITE}/huge.xml`;
    const other = `${SITE}/huge-2.xml`;
    const crawlId = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({
        truncation: { oversizedDocsSkipped: 2 },
        sitemapFacts: {
          oversizedDocs: [
            { url: big, bytesRead: SITEMAP_MAX_BYTES, urlsKept: 123 },
            { url: other, bytesRead: SITEMAP_MAX_BYTES + 10, urlsKept: 4 },
          ],
        },
      }),
    );
    const found = await run("sitemap.oversized", crawlId);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      ruleId: "sitemap.oversized",
      severity: "warning",
      pageId: null,
      dedupeKey: big,
    });
    expect(found.map((f) => f.evidence)).toEqual([
      { sitemapUrl: big, bytesRead: SITEMAP_MAX_BYTES, urlsKept: 123, max: SITEMAP_MAX_BYTES },
      { sitemapUrl: other, bytesRead: SITEMAP_MAX_BYTES + 10, urlsKept: 4, max: SITEMAP_MAX_BYTES },
    ]);
  });

  it("is silent when no document ran past the cap", async () => {
    expect(await run("sitemap.oversized", await newCrawl())).toEqual([]);
  });

  // ------------------------------------------------------ url-in-multiple

  it("fires once per URL listed in more than one document, not for a repeat in one document", async () => {
    const crawlId = await newCrawl();
    const a = `${SITE}/a.xml`;
    const b = `${SITE}/b.xml`;
    const c = `${SITE}/c.xml`;
    await addMemberships(crawlId, [
      { url: `${SITE}/shared`, source: a },
      { url: `${SITE}/shared`, source: b },
      { url: `${SITE}/shared`, source: c },
      { url: `${SITE}/only-a`, source: a },
      { url: `${SITE}/only-b`, source: b },
      // One document, two spellings of one URL: still one source.
      { url: `${SITE}/twice`, source: a },
      { url: `${SITE}/twice#frag`, source: a, normalised: `${SITE}/twice` },
    ]);
    const found = await run("sitemap.url-in-multiple", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ruleId: "sitemap.url-in-multiple",
      severity: "info",
      dedupeKey: `${SITE}/shared`,
    });
    expect(found[0]!.evidence).toEqual({ url: `${SITE}/shared`, sitemaps: [a, b, c], count: 3 });
  });

  it("caps the listed sitemaps at 10 and keeps the true count", async () => {
    const crawlId = await newCrawl();
    await addMemberships(
      crawlId,
      Array.from({ length: 12 }, (_, i) => ({
        url: `${SITE}/shared`,
        source: `${SITE}/s${String(i).padStart(2, "0")}.xml`,
      })),
    );
    const [finding] = await run("sitemap.url-in-multiple", crawlId);
    const evidence = finding!.evidence as { sitemaps: string[]; count: number };
    expect(evidence.sitemaps).toHaveLength(10);
    expect(evidence.count).toBe(12);
  });

  it("attaches the finding to the crawled page, spends the listing cap and notes the total", async () => {
    const crawlId = await newCrawl();
    const pageId = `page_${randomUUID()}`;
    await db.insert(pages).values({
      id: pageId, crawlId, url: `${SITE}/u1`, urlNormalised: `${SITE}/u1`,
      fetchClass: "ok", statusCode: 200, depth: 0, discoveredVia: "sitemap",
    });
    const rows = [1, 2, 3].flatMap((n) => [
      { url: `${SITE}/u${n}`, source: `${SITE}/a.xml` },
      { url: `${SITE}/u${n}`, source: `${SITE}/b.xml` },
    ]);
    await addMemberships(crawlId, rows);
    const found = await run("sitemap.url-in-multiple", crawlId, { listing: 2 });
    expect(found).toHaveLength(2);
    expect(found[0]!.pageId).toBe(pageId);
    expect(JSON.stringify(found.at(-1))).toContain('"total":3');
  });

  it("says membershipLimited on its evidence when the membership cap was hit", async () => {
    const crawlId = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({ sitemapFacts: { membershipLimited: true } }),
    );
    await addMemberships(crawlId, [
      { url: `${SITE}/shared`, source: `${SITE}/a.xml` },
      { url: `${SITE}/shared`, source: `${SITE}/b.xml` },
    ]);
    const [finding] = await run("sitemap.url-in-multiple", crawlId);
    expect(finding!.evidence).toMatchObject({ membershipLimited: true });
  });

  // ------------------------------------------------------ overlong locs skipped

  it("reports the over-long locs discovery refused to store, once, beside the stored ones", async () => {
    const crawlId = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({ sitemapFacts: { overlongLocsSkipped: 7 } }),
    );
    await add(crawlId, [{ url: `${SITE}/${"a".repeat(SITEMAP_LOC_MAX)}` }]);
    const found = await run("sitemap.url-too-long", crawlId);
    expect(found).toHaveLength(2);
    const skipped = found.find((f) => f.pageUrl === null);
    expect(skipped).toMatchObject({ pageId: null, dedupeKey: "overlong-locs-skipped" });
    expect(skipped!.evidence).toEqual({ skipped: 7, max: INDEXED_URL_MAX });
  });

  it("states no skipped-locs finding when none was skipped, or on a pre-26c crawl", async () => {
    expect(await run("sitemap.url-too-long", await newCrawl())).toEqual([]);
    const old = await newCrawl(undefined, undefined, mkDiscovery({ sitemapFacts: null }));
    expect(await run("sitemap.url-too-long", old)).toEqual([]);
  });

  // ------------------------------------------------------ sitemap.invalid

  it("sitemap.invalid lists an oversized document from an old crawl's failures only", async () => {
    const failures = [{ url: `${SITE}/old-huge.xml`, reason: "document over the size limit" }];
    const old = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({ sitemapFacts: null, truncation: { failures, oversizedDocsSkipped: 1 } }),
    );
    const invalid = sitemapRules.find((r) => r.id === "sitemap.invalid");
    if (invalid === undefined) throw new Error("no sitemap.invalid");
    expect((await invalid.run(db, old))[0]!.evidence).toMatchObject({ failures });
    const fresh = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({
        truncation: { oversizedDocsSkipped: 1 },
        sitemapFacts: { oversizedDocs: [{ url: `${SITE}/huge.xml`, bytesRead: 1, urlsKept: 1 }] },
      }),
    );
    expect(await invalid.run(db, fresh)).toEqual([]);
  });

  // 28b T1: a resume that finds robots.txt unreachable keeps the earlier walk's
  // evidence (28a ruling R5) and replaces only `robots`, so the earlier walk's
  // failed document is still a fact about the site.
  it("sitemap.invalid judges a kept earlier walk's failures beside an unreachable robots.txt", async () => {
    const failures = [{ url: `${SITE}/broken.xml`, reason: "HTTP 500" }];
    const crawlId = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({
        robots: { outcome: "unreachable", raw: null },
        truncation: { docsFetched: 2, failures },
      }),
    );
    const invalid = sitemapRules.find((r) => r.id === "sitemap.invalid");
    if (invalid === undefined) throw new Error("no sitemap.invalid");
    const found = await invalid.run(db, crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toEqual({ failures, failureCount: 1 });
  });

  it("sitemap.invalid stays silent when robots.txt was unreachable and no walk ran", async () => {
    const crawlId = await newCrawl(
      undefined,
      undefined,
      mkDiscovery({
        robots: { outcome: "unreachable", raw: null },
        truncation: {
          docsFetched: 0,
          failures: [
            { url: `${SITE}/sitemap.xml`, reason: "not fetched: robots.txt unreachable, complete disallow in force" },
          ],
        },
      }),
    );
    const invalid = sitemapRules.find((r) => r.id === "sitemap.invalid");
    if (invalid === undefined) throw new Error("no sitemap.invalid");
    expect(await invalid.run(db, crawlId)).toEqual([]);
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
      crawlId, url: over, urlNormalised: `${SITE}/x`, sitemapSource: SOURCE, seenAt: new Date(), lastmod: null,
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

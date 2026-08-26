/**
 * The sitemap rules, against a real database.
 *
 * Two kinds of rule share this file. Two of them read the crawl's discovery
 * evidence — what robots.txt declared, and which of the declared documents
 * could not be read — and are site-scoped. The rest join `sitemap_urls` to
 * `pages`: the site's own claim about which URLs exist, against what the crawl
 * found when it fetched them.
 *
 * Rows are inserted directly (the link-graph pattern): what is under test is
 * what the rules make of the two tables, not the crawling that filled them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, sitemapUrls } from "../../src/db/schema.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { sitemapRules } from "../../src/rules/query/sitemap.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://sitemaps.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(sitemapRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in sitemapRules`);
  return r;
}

describe("sitemapRules metadata", () => {
  it("defines the seven sitemap rules", () => {
    expect(sitemapRules.map((r) => r.id).sort()).toEqual([
      "pages.not-in-sitemap",
      "sitemap.invalid",
      "sitemap.missing",
      "sitemap.non-200",
      "sitemap.non-indexable",
      "sitemap.redirected",
      "sitemap.uncrawled",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(sitemapRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "sitemap.missing": [["CHECK-06"], "warning", "sitemap"],
      "sitemap.invalid": [["CHECK-06"], "warning", "sitemap"],
      "sitemap.non-200": [["CHECK-07"], "warning", "sitemap"],
      "sitemap.redirected": [["CHECK-07"], "warning", "sitemap"],
      "sitemap.non-indexable": [["CHECK-07"], "warning", "sitemap"],
      // Info: a sitemap entry the crawl never reached is usually the crawl's
      // own boundary, not a fault on the site.
      "sitemap.uncrawled": [["CHECK-07"], "info", "sitemap"],
      "pages.not-in-sitemap": [["CHECK-09"], "info", "sitemap"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of sitemapRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    expect(titles.size).toBe(sitemapRules.length);
  });
});

describe("the sitemap rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    redirectUrl?: string;
  }

  async function newCrawl(discovery: unknown = mkDiscovery()): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 500, userAgent: "AriadneBot-test" },
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 1,
      discovery,
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path).toLowerCase().replace(/\/$/, ""),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: writerIndexable(s),
      robotsMeta: s.robotsMeta ?? null,
      xRobotsTag: s.xRobotsTag ?? null,
      redirectUrl: s.redirectUrl ?? null,
      depth: 1,
      discoveredVia: "sitemap",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addSitemapUrls(crawlId: string, paths: string[]): Promise<void> {
    await db.insert(sitemapUrls).values(
      paths.map((path) => ({
        crawlId,
        url: url(path),
        sitemapSource: `${SITE}/sitemap.xml`,
        lastmod: null,
      })),
    );
  }

  const run = async (id: string, crawlId: string): Promise<Finding[]> =>
    rule(id).run(db, crawlId);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  // ----------------------------------------------------------- sitemap.missing

  it("reports a site whose robots.txt declares no sitemap, site-scoped", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapSources: [] }));

    const found = await run("sitemap.missing", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "sitemap.missing",
      severity: "warning",
      pageId: null,
      pageUrl: null,
      dedupeKey: "site",
    });
    expect(found[0]!.evidence).toEqual({ robotsOutcome: "read", sitemapSources: [] });
  });

  it("is silent when robots.txt declares a sitemap", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapSources: [`${SITE}/sitemap.xml`] }));
    expect(await run("sitemap.missing", crawlId)).toHaveLength(0);
  });

  // An absent robots.txt is a complete answer — there is no file, so no file
  // declares a sitemap — and the finding is sound. This is the one case where
  // "declared in robots.txt" is true of a site with no robots.txt at all.
  it("fires when robots.txt is absent altogether", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({ robots: { outcome: "absent", raw: null }, sitemapSources: [] }),
    );
    expect(await run("sitemap.missing", crawlId)).toHaveLength(1);
  });

  // The rule's whole claim is about what robots.txt says. A file we read only
  // the first 500KB of may declare a `Sitemap:` past the cap, and one we could
  // not read says nothing at all — so the rule refuses rather than reporting a
  // declaration's absence it cannot vouch for. `robots.check-skipped` is what
  // says so out loud.
  it("refuses to conclude from a robots.txt it could not read whole", async () => {
    const truncated = await newCrawl(
      mkDiscovery({ robots: { truncated: true }, sitemapSources: [] }),
    );
    expect(await run("sitemap.missing", truncated)).toHaveLength(0);

    const unreachable = await newCrawl(
      mkDiscovery({ robots: { outcome: "unreachable", raw: null }, sitemapSources: [] }),
    );
    expect(await run("sitemap.missing", unreachable)).toHaveLength(0);
  });

  // ----------------------------------------------------------- sitemap.invalid

  it("reports the sitemap documents the crawl could not read, in one finding", async () => {
    const failures = [
      { url: `${SITE}/sitemap.xml`, reason: "no <urlset> or <sitemapindex> root element" },
      { url: `${SITE}/news.xml`, reason: "HTTP 500" },
    ];
    const crawlId = await newCrawl(mkDiscovery({ truncation: { failures, docsFetched: 2 } }));

    const found = await run("sitemap.invalid", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "sitemap.invalid",
      severity: "warning",
      pageId: null,
      pageUrl: null,
      dedupeKey: "site",
    });
    expect(found[0]!.evidence).toEqual({ failures, failureCount: 2 });
  });

  it("is silent when every declared document parsed", async () => {
    expect(await run("sitemap.invalid", await newCrawl())).toHaveLength(0);
  });

  // When robots.txt is unreachable the crawl refuses to fetch anything, and
  // discovery records one "not fetched" failure per declared source. Calling
  // those documents invalid would blame the site for a file we never opened.
  it("does not call a document invalid when robots.txt stopped us fetching it", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({
        robots: { outcome: "unreachable", raw: null },
        truncation: {
          docsFetched: 0,
          failures: [
            {
              url: `${SITE}/sitemap.xml`,
              reason: "not fetched: robots.txt unreachable, complete disallow in force",
            },
          ],
        },
      }),
    );
    expect(await run("sitemap.invalid", crawlId)).toHaveLength(0);
  });

  // ------------------------------------------------- the sitemap_urls ⋈ pages join

  it("sorts crawled sitemap entries into exactly one finding each", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/ok" },
      { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      { path: "/moved", fetchClass: "redirect", statusCode: 301, redirectUrl: url("/ok") },
      { path: "/hidden", robotsMeta: "noindex" },
    ]);
    await addSitemapUrls(crawlId, ["/ok", "/gone", "/moved", "/hidden"]);

    const non200 = await run("sitemap.non-200", crawlId);
    expect(non200).toHaveLength(1);
    expect(non200[0]!).toMatchObject({ pageId: ids.get("/gone"), pageUrl: url("/gone") });
    expect(non200[0]!.evidence).toEqual({
      url: url("/gone"),
      statusCode: 404,
      fetchClass: "client_error",
    });

    const redirected = await run("sitemap.redirected", crawlId);
    expect(redirected).toHaveLength(1);
    expect(redirected[0]!).toMatchObject({ pageId: ids.get("/moved"), pageUrl: url("/moved") });
    expect(redirected[0]!.evidence).toEqual({
      url: url("/moved"),
      statusCode: 301,
      redirectUrl: url("/ok"),
    });

    const nonIndexable = await run("sitemap.non-indexable", crawlId);
    expect(nonIndexable).toHaveLength(1);
    expect(nonIndexable[0]!).toMatchObject({ pageId: ids.get("/hidden"), pageUrl: url("/hidden") });
    expect(nonIndexable[0]!.evidence).toEqual({
      url: url("/hidden"),
      robotsMeta: "noindex",
      xRobotsTag: null,
    });

    // The 200 that is indexable fires nothing, and nothing was left uncrawled.
    expect(await run("sitemap.uncrawled", crawlId)).toHaveLength(0);
  });

  // `is_indexable` is false for every 404, redirect and 5xx as well as for a
  // noindexed page, so an ungated non-indexable rule would bill the same
  // broken entry twice — once as "does not return 200", once under copy about
  // a robots directive that page never had.
  it("keeps the three join rules disjoint: a 404 entry fires non-200 only", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/gone", fetchClass: "client_error", statusCode: 404 }]);
    await addSitemapUrls(crawlId, ["/gone"]);

    expect(await run("sitemap.non-200", crawlId)).toHaveLength(1);
    expect(await run("sitemap.non-indexable", crawlId)).toHaveLength(0);
    expect(await run("sitemap.redirected", crawlId)).toHaveLength(0);
  });

  // A redirect is not "does not return 200" either: it is a working answer
  // pointing somewhere else, with its own finding and its own fix.
  it("keeps a redirected entry out of sitemap.non-200", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/moved", fetchClass: "redirect", statusCode: 301, redirectUrl: url("/ok") },
    ]);
    await addSitemapUrls(crawlId, ["/moved"]);

    expect(await run("sitemap.non-200", crawlId)).toHaveLength(0);
    expect(await run("sitemap.redirected", crawlId)).toHaveLength(1);
  });

  it("reports a sitemap entry the crawl never fetched", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/ok" }]);
    await addSitemapUrls(crawlId, ["/ok", "/never-reached"]);

    const found = await run("sitemap.uncrawled", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "sitemap.uncrawled",
      severity: "info",
      pageId: null,
      pageUrl: url("/never-reached"),
      dedupeKey: url("/never-reached"),
    });
    expect(found[0]!.evidence).toEqual({ url: url("/never-reached") });
  });

  // The join is exact on the URL, and `sitemap_urls.url` is the published
  // `<loc>` while `pages.url` is `normalizeUrl` output — which strips the
  // fragment and sorts query parameters. A `<loc>` carrying either does not
  // match the page the crawl created FROM IT, and reads here as uncrawled. The
  // finding still fires (the crawl genuinely has no row under that spelling)
  // and its evidence says the spelling is what may be at fault. See the module
  // header for why this is not papered over in SQL.
  it("flags a finding whose URL spelling may differ from the frontier key", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/x" }]);
    await addSitemapUrls(crawlId, ["/x#section"]);

    const found = await run("sitemap.uncrawled", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toEqual({
      url: url("/x#section"),
      normalizationSensitive: true,
    });
  });

  it("caps the uncrawled findings and says so on the last one", async () => {
    const crawlId = await newCrawl();
    const total = URL_FINDING_CAP + 1;
    await addSitemapUrls(
      crawlId,
      Array.from({ length: total }, (_, i) => `/never/${String(i).padStart(4, "0")}`),
    );

    const found = await run("sitemap.uncrawled", crawlId);
    expect(found).toHaveLength(URL_FINDING_CAP);
    expect(found[found.length - 1]!.evidence).toMatchObject({
      truncated: { reported: URL_FINDING_CAP, total },
    });
  });

  // ------------------------------------------------------ pages.not-in-sitemap

  it("reports an indexable 200 page the sitemap does not list", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/listed" },
      { path: "/unlisted" },
      // Neither of these belongs in a sitemap, so neither is a finding.
      { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      { path: "/hidden", robotsMeta: "noindex" },
    ]);
    await addSitemapUrls(crawlId, ["/listed"]);

    const found = await run("pages.not-in-sitemap", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "pages.not-in-sitemap",
      severity: "info",
      pageId: ids.get("/unlisted"),
      pageUrl: url("/unlisted"),
      dedupeKey: url("/unlisted"),
    });
    expect(found[0]!.evidence).toEqual({ pageUrl: url("/unlisted") });
  });

  // The data gate. A crawl with no sitemap entries at all would otherwise
  // report every page on the site as "missing from the sitemap" — the same
  // fact CHECK-06 already reports once, as `sitemap.missing`, instead of once
  // per URL.
  it("does not run at all when the crawl has no sitemap entries", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapSources: [] }));
    await addPages(crawlId, [{ path: "/a" }, { path: "/b" }]);

    expect(await run("pages.not-in-sitemap", crawlId)).toHaveLength(0);
    // And the fact itself is reported, once, by the rule that owns it.
    expect(await run("sitemap.missing", crawlId)).toHaveLength(1);
  });

  it("caps the not-in-sitemap findings and says so on the last one", async () => {
    const crawlId = await newCrawl();
    const total = URL_FINDING_CAP + 1;
    await addPages(
      crawlId,
      Array.from({ length: total }, (_, i) => ({ path: `/p/${String(i).padStart(4, "0")}` })),
    );
    await addSitemapUrls(crawlId, ["/elsewhere"]);

    const found = await run("pages.not-in-sitemap", crawlId);
    expect(found).toHaveLength(URL_FINDING_CAP);
    expect(found[found.length - 1]!.evidence).toMatchObject({
      truncated: { reported: URL_FINDING_CAP, total },
    });
  });

  // ----------------------------------------------------------------- the reads

  it("refuses a crawl id nothing knows, naming it", async () => {
    const missing = `crawl_${randomUUID()}`;
    for (const r of sitemapRules) {
      await expect(r.run(db, missing), r.id).rejects.toThrow(missing);
    }
  });

  it("refuses a crawl row with no discovery evidence", async () => {
    const crawlId = await newCrawl(null);
    for (const r of sitemapRules) {
      await expect(r.run(db, crawlId), r.id).rejects.toThrow(/discovery/i);
    }
  });
});

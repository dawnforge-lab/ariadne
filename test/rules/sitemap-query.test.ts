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
import { normalised, writerIndexable, type IndexabilitySpec } from "./mk-page.js";

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
      "sitemap.invalid": [["CHECK-06"], "critical", "sitemap"],
      "sitemap.non-200": [["CHECK-07"], "critical", "sitemap"],
      "sitemap.redirected": [["CHECK-07"], "warning", "sitemap"],
      "sitemap.non-indexable": [["CHECK-07"], "critical", "sitemap"],
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
    /** The page's declared canonical, absolute. Undefined leaves it null. */
    canonical?: string;
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
      redirectUrlNormalised: s.redirectUrl === undefined ? null : normalised(s.redirectUrl),
      canonicalHtml: s.canonical ?? null,
      depth: 1,
      discoveredVia: "sitemap",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  /**
   * Sitemap entries, given as paths on the site under test — or, for the
   * off-origin cases, as absolute URLs on another host, which is what a
   * cross-host `<loc>` actually looks like in the column.
   */
  async function addSitemapUrls(crawlId: string, paths: string[]): Promise<void> {
    const published = (path: string): string =>
      /^https?:\/\//i.test(path) ? path : url(path);
    await db.insert(sitemapUrls).values(
      paths.map((path) => ({
        crawlId,
        url: published(path),
        // What the crawl loop writes beside the published `<loc>`, and what
        // every join below reads.
        urlNormalised: normalised(published(path)),
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

  // The claim is about ROBOTS.TXT, so a sitemap the client handed the crawl
  // does not answer it. This is why the evidence keeps the supplied documents
  // in their own list (`suppliedSitemaps`): folded into `sitemapSources` they
  // would silence a finding about a robots.txt that still declares nothing —
  // and the fix the site owner has to make would go unreported.
  it("still fires when the sitemap was supplied to the crawl rather than declared", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({
        sitemapSources: [],
        suppliedSitemaps: [`${SITE}/sitemap-extra.xml`],
      }),
    );
    const found = await run("sitemap.missing", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toEqual({ robotsOutcome: "read", sitemapSources: [] });
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
      severity: rule("sitemap.invalid").severity,
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
      // WHICH KIND of non-indexable, since Phase 22 §1 gave this rule a second
      // one. The two robots columns are empty on a canonicalised entry, so
      // without this key half the rule's rows would carry copy about a
      // directive and no evidence of one.
      reason: "noindex",
      robotsMeta: "noindex",
      xRobotsTag: null,
    });

    // The 200 that is indexable fires nothing, and nothing was left uncrawled.
    expect(await run("sitemap.uncrawled", crawlId)).toHaveLength(0);
  });

  /**
   * THE CANONICALISED CASE (Phase 22 §1), which is this phase's one widening of
   * a rule rather than a narrowing of it. Everything else stopped judging
   * canonicalised pages because the defect belongs to the URL they defer to —
   * but a sitemap is a list of URLs the site is ASKING to have indexed, and a
   * URL that has told search engines to index something else does not belong
   * on it. The `reason` is what tells the two cases apart on the report.
   */
  describe("a listed URL that canonicalises elsewhere", () => {
    it("reports it, with the reason and no robots evidence to show", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/live" },
        { path: "/live-variant", canonical: url("/live") },
      ]);
      await addSitemapUrls(crawlId, ["/live", "/live-variant"]);

      const found = await run("sitemap.non-indexable", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({ pageId: ids.get("/live-variant") });
      expect(found[0]!.evidence).toEqual({
        url: url("/live-variant"),
        reason: "canonicalised",
        robotsMeta: null,
        xRobotsTag: null,
      });
    });

    it("says canonicalised when a page is both, and still shows the directive", async () => {
      // A page can noindex itself AND defer to another URL. It is one entry and
      // one line of XML to delete, so it is one finding — and the canonical is
      // the more specific statement, which is the precedence `site.health`
      // sets the two aside in.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/live" },
        { path: "/both", canonical: url("/live"), robotsMeta: "noindex" },
      ]);
      await addSitemapUrls(crawlId, ["/both"]);

      const found = await run("sitemap.non-indexable", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        url: url("/both"),
        reason: "canonicalised",
        robotsMeta: "noindex",
        xRobotsTag: null,
      });
    });

    it("says nothing about a listed page that canonicalises to ITSELF", async () => {
      // The self-referential canonical is the healthy declaration every page
      // should carry, and a rule that read it as "canonicalised" would fire on
      // every correctly marked-up sitemap entry on the internet.
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/live", canonical: url("/live") }]);
      await addSitemapUrls(crawlId, ["/live"]);
      expect(await run("sitemap.non-indexable", crawlId)).toHaveLength(0);
    });
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

  // A 200 is a 200. A PDF (`non_html`) and a body that ran past the size cap
  // (`too_large`) are both legitimate sitemap entries that answered, so a
  // finding titled "does not return 200" carrying `statusCode: 200` would
  // contradict itself. Neither is uncrawled either: both were fetched.
  it("says nothing about a listed URL that answered 200 without being HTML", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/brochure.pdf", fetchClass: "non_html" },
      { path: "/huge", fetchClass: "too_large" },
    ]);
    await addSitemapUrls(crawlId, ["/brochure.pdf", "/huge"]);

    for (const id of ["sitemap.non-200", "sitemap.redirected", "sitemap.non-indexable"]) {
      expect(await run(id, crawlId), id).toHaveLength(0);
    }
    expect(await run("sitemap.uncrawled", crawlId)).toHaveLength(0);
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
    expect(found[0]!.evidence).toEqual({
      url: url("/never-reached"),
      attempted: false,
      // Inside the crawl boundary, so the causes the copy names — a page
      // limit, a depth limit, a robots disallow — are the ones in play.
      offOrigin: false,
    });
  });

  // A sitemap may list URLs on another host: a file that belongs to a different
  // property, or one a client supplied that covers more than the site under
  // audit. The frontier gates every candidate on `isSameOrigin`, so such an
  // entry is never attempted BY DESIGN — no page limit was reached, no robots
  // rule applied, no request failed. The finding still fires, because the crawl
  // genuinely has no record of the URL, and it has to say which case this is:
  // the copy names causes, and all the others are false here.
  it("marks a sitemap entry on another host as off-origin", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/ok" }]);
    const foreign = "https://cdn.other.example/page";
    await addSitemapUrls(crawlId, ["/ok", foreign]);

    const found = await run("sitemap.uncrawled", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      pageId: null,
      pageUrl: foreign,
      dedupeKey: foreign,
    });
    expect(found[0]!.evidence).toEqual({
      url: foreign,
      attempted: false,
      offOrigin: true,
    });
  });

  // The flag is the frontier's own predicate, not string equality on the
  // hostname, and it answers exactly what the crawler would have done:
  //  - the www twin of the site's host IS inside the boundary (`isSameOrigin`
  //    admits it), so calling it off-origin would send an operator to check a
  //    sitemap that is correct;
  //  - the plain-http spelling of a site crawled over https is NOT — an origin
  //    is a scheme, a host and a port, and the frontier skips that spelling
  //    exactly as it skips another host. Saying it hit a page limit would be
  //    the same lie for the same reason, so it is marked the same way.
  it("reads the crawl boundary the frontier reads, www twin and scheme included", async () => {
    const crawlId = await newCrawl();
    await addSitemapUrls(crawlId, [
      "https://www.sitemaps.example/twin",
      "http://sitemaps.example/plain",
    ]);

    const found = await run("sitemap.uncrawled", crawlId);
    expect(
      Object.fromEntries(found.map((f) => [f.evidence["url"], f.evidence["offOrigin"]])),
    ).toEqual({
      "https://www.sitemaps.example/twin": false,
      "http://sitemaps.example/plain": true,
    });
  });

  // A fetch that got no HTTP answer has a `pages` row with a null status, so
  // the "no row" test alone would drop it — and `sitemap.non-200` must not
  // claim it "does not return 200" when no response arrived at all. It is
  // reported here, as a URL the crawl did not reach, with the failure named.
  it("reports a listed URL whose fetch failed before any answer came back", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/slow", fetchClass: "timeout", statusCode: null },
    ]);
    await addSitemapUrls(crawlId, ["/slow"]);

    expect(await run("sitemap.non-200", crawlId)).toHaveLength(0);

    const found = await run("sitemap.uncrawled", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      // The row exists, so the finding names it: that row is where the fetch
      // outcome lives.
      pageId: ids.get("/slow"),
      pageUrl: url("/slow"),
    });
    expect(found[0]!.evidence).toEqual({
      url: url("/slow"),
      attempted: true,
      // A URL the crawl fetched is inside the boundary by construction — only
      // same-origin URLs ever reach the frontier — so this is always false
      // beside `attempted: true`. It is still stated, because the finding's
      // copy sends the reader to this field.
      offOrigin: false,
      fetchClass: "timeout",
      // And no `statusCode`: the rule only ever selects rows with a null
      // status, so the key could carry nothing, and the standard `Status Code`
      // column prints the page row's own (null) value beside it either way.
    });
  });

  // The published `<loc>` and the frontier key are two spellings of one URL:
  // `normalizeUrl` strips the fragment and sorts query parameters, so a site
  // that publishes `?b=2&a=1#section` for the page the crawl fetched at
  // `?a=1&b=2` is naming that very page. The join reads
  // `sitemap_urls.url_normalised`, so the entry matches its row in both
  // directions — no invented `sitemap.uncrawled`, no invented
  // `pages.not-in-sitemap` — while the evidence still quotes the spelling the
  // site published, because that is the line of XML somebody edits.
  it("joins a <loc> spelled with a fragment and unsorted parameters to its page", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/x?a=1&b=2" },
      { path: "/gone?a=1&b=2", fetchClass: "client_error", statusCode: 404 },
    ]);
    await addSitemapUrls(crawlId, ["/x?b=2&a=1#section", "/gone?b=2&a=1#top"]);

    expect(await run("sitemap.uncrawled", crawlId)).toHaveLength(0);
    expect(await run("pages.not-in-sitemap", crawlId)).toHaveLength(0);

    const found = await run("sitemap.non-200", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toEqual({
      url: url("/gone?b=2&a=1#top"),
      statusCode: 404,
      fetchClass: "client_error",
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
      // None of these belongs in a sitemap, so none is a finding.
      { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      { path: "/hidden", robotsMeta: "noindex" },
      // PHASE 22 §1: a canonicalised page SHOULD be absent from the sitemap —
      // `sitemap.non-indexable` is what reports it when it is listed — so
      // reporting it as missing from one is the inverse of right.
      { path: "/variant", canonical: url("/listed") },
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

  // A `sitemap_urls` row written before migration 0006 carries the column's
  // empty-string default, which matches no page — so every rule that joins the
  // two tables would report the whole sitemap as wrong rather than say nothing.
  // No crawl can write an empty spelling (`normalizeUrl` returns at least
  // `scheme://host/`, and `persistSitemap` throws on what it rejects), so the
  // default is unambiguous and is refused outright: the same ruling the missing
  // discovery evidence above gets, and the same remedy.
  it("refuses a crawl whose sitemap rows predate url_normalised", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/listed" }]);
    // Written the way migration 0006 left a pre-existing row: the published
    // spelling, and the column's default beside it.
    await db.insert(sitemapUrls).values({
      crawlId,
      url: url("/listed"),
      sitemapSource: `${SITE}/sitemap.xml`,
      lastmod: null,
    });

    for (const id of [
      "sitemap.non-200",
      "sitemap.redirected",
      "sitemap.non-indexable",
      "sitemap.uncrawled",
      "pages.not-in-sitemap",
    ]) {
      // The message names the crawl, quotes an entry, and says what to do.
      await expect(run(id, crawlId), id).rejects.toThrow(
        /no normalised spelling.*Re-crawl the site/s,
      );
      await expect(run(id, crawlId), id).rejects.toThrow(crawlId);
    }

    // The two rules that read the discovery blob alone never touch the column
    // and must keep working: gating them would refuse to say "this site
    // declares no sitemap" over a join they do not make.
    expect(await run("sitemap.missing", crawlId)).toHaveLength(0);
    expect(await run("sitemap.invalid", crawlId)).toHaveLength(0);
  });

  it("says nothing about a crawl whose sitemap rows are all normalised", async () => {
    // The other half of the gate: it must not fire on a healthy crawl. Every
    // other test in this file is that assertion too, but stating it once
    // directly means a gate that started throwing on everything fails here
    // rather than in twenty places at once.
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/listed" }]);
    await addSitemapUrls(crawlId, ["/listed"]);
    for (const r of sitemapRules) {
      await expect(r.run(db, crawlId), r.id).resolves.toBeDefined();
    }
  });
});

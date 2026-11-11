/**
 * The URL-hygiene rules, against a real database.
 *
 * Rows are inserted directly (the link-graph pattern): what is under test is
 * what the rules make of the URLs the crawler stored — the normalisation key,
 * the link table's targets, the canonical a parameter page declares — not the
 * crawling that produced them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { urlHygieneRules } from "../../src/rules/query/url-hygiene.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://urls.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(urlHygieneRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in urlHygieneRules`);
  return r;
}

describe("urlHygieneRules metadata", () => {
  it("defines the three rules of the plan's table", () => {
    expect(urlHygieneRules.map((r) => r.id).sort()).toEqual([
      "url.normalisation-variants",
      "url.parameter-pages-indexable",
      "url.tracking-params-internal",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(urlHygieneRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "url.normalisation-variants": [["CHECK-30"], "critical", "url"],
      "url.tracking-params-internal": [["CHECK-28"], "warning", "url"],
      // Info: a parameter page that canonicalises to itself is a configuration
      // to look at with the param inventory beside it, not a fault on its own.
      "url.parameter-pages-indexable": [["CHECK-27"], "warning", "url"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of urlHygieneRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    expect(titles.size).toBe(urlHygieneRules.length);
  });
});

describe("the URL rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    /** Defaults to `normalizeUrl` of the page's own URL — what the writer stores. */
    normalised?: string;
    canonical?: string | null;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE, hostKey: hostKeyOf(SITE),
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => {
      const full = url(s.path);
      const normalised = s.normalised ?? normalizeUrl(full);
      if (normalised === null) throw new Error(`${full} does not normalise`);
      return {
        id: `page_${randomUUID()}`,
        crawlId,
        url: full,
        urlNormalised: normalised,
        fetchClass: s.fetchClass ?? "ok",
        statusCode: s.statusCode === undefined ? 200 : s.statusCode,
        isIndexable: writerIndexable(s),
        robotsMeta: s.robotsMeta ?? null,
        xRobotsTag: s.xRobotsTag ?? null,
        canonicalHtml: s.canonical === undefined ? full : s.canonical,
        canonicalCount: s.canonical === null ? 0 : 1,
        depth: 1,
        discoveredVia: "link",
      };
    });
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLinks(
    crawlId: string,
    sourceId: string,
    targets: string[],
    isInternal = true,
  ): Promise<void> {
    await db.insert(links).values(
      targets.map((target, position) => ({
        crawlId,
        sourcePageId: sourceId,
        targetUrl: target.startsWith("http") ? target : url(target),
        targetPageId: null,
        anchor: "read this",
        rel: null,
        isInternal,
        isNofollow: false,
        position,
      })),
    );
  }

  const run = (id: string, crawlId: string): Promise<Finding[]> => rule(id).run(db, crawlId);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  describe("url.normalisation-variants", () => {
    const ID = "url.normalisation-variants";

    it("is silent when every URL has its own normalisation key", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/" }, { path: "/a" }, { path: "/b" }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("reports one finding per group of URLs sharing a key, listing the variants", async () => {
      const crawlId = await newCrawl();
      // Same page fetched under two spellings: the analyzer's normalisation key
      // collapses them, the frontier's does not.
      const ids = await addPages(crawlId, [
        { path: "/Product?a=1&b=2", normalised: url("/product?a=1&b=2") },
        { path: "/product?b=2&a=1", normalised: url("/product?a=1&b=2") },
        { path: "/alone" },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: rule(ID).severity,
        // The lexically first variant, so the finding lands on a URL rather
        // than on the crawl as a whole.
        pageId: ids.get("/Product?a=1&b=2"),
        pageUrl: url("/Product?a=1&b=2"),
        dedupeKey: url("/product?a=1&b=2"),
      });
      expect(found[0]!.evidence).toEqual({
        urlNormalised: url("/product?a=1&b=2"),
        variants: [url("/Product?a=1&b=2"), url("/product?b=2&a=1")],
        count: 2,
      });
    });

    it("is silent when one spelling redirects to the other", async () => {
      // The trailing-slash redirect: `/a` 301s to `/a/`, and the two share a
      // normalisation key by design. That is the configuration this rule wants
      // to see, not the fault it reports — and it is on so many sites that
      // firing here would make the rule fire on every crawl.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", normalised: url("/a"), statusCode: 301, fetchClass: "redirect" },
        { path: "/a/", normalised: url("/a") },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("fires when both spellings serve the page", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", normalised: url("/a") },
        { path: "/a/", normalised: url("/a") },
      ]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        urlNormalised: url("/a"),
        variants: [url("/a"), url("/a/")],
        count: 2,
      });
    });

    it("does not read another crawl's pages into this crawl's groups", async () => {
      const mine = await newCrawl();
      const yours = await newCrawl();
      await addPages(mine, [{ path: "/x", normalised: url("/shared") }]);
      await addPages(yours, [{ path: "/y", normalised: url("/shared") }]);
      expect(await run(ID, mine)).toHaveLength(0);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("url.tracking-params-internal", () => {
    const ID = "url.tracking-params-internal";

    it("is silent when no internal link carries a tracking param", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, ["/a", "/b?page=2", "/c?utmsource=x"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("groups by target, naming the params it carries and how many links point at it", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }, { path: "/hub" }]);
      const target = "/sale?utm_medium=email&utm_source=news";
      await addLinks(crawlId, ids.get("/")!, [target]);
      await addLinks(crawlId, ids.get("/hub")!, [target]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "warning",
        pageUrl: url(target),
        dedupeKey: url(target),
      });
      expect(found[0]!.evidence).toEqual({
        targetUrl: url(target),
        params: ["utm_medium", "utm_source"],
        inlinkCount: 2,
      });
    });

    it("names the target's page row when the crawl fetched it", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }, { path: "/sale?gclid=abc" }]);
      await addLinks(crawlId, ids.get("/")!, ["/sale?gclid=abc"]);

      const found = await run(ID, crawlId);
      expect(found[0]!.pageId).toBe(ids.get("/sale?gclid=abc"));
    });

    it("leaves the page id null when the target was never fetched", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, ["/never?fbclid=abc"]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageId).toBeNull();
    });

    it("ignores external links: another site's tracking params are not ours to fix", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, ["https://other.example/x?utm_source=us"], false);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("does not match a param whose name merely ends with a tracking name", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, ["/a?my_gclid=1", "/b?utm_sourced=1"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent when the tracking name is inside a parameter VALUE", async () => {
      // `?` is legal inside a value and `normalizeUrl` preserves it, so our own
      // crawler can store this: ONE parameter, named `to`, whose value happens
      // to contain the text `?utm_source=y`. A finding here would accuse the
      // URL of carrying a campaign tag it does not have — and would carry an
      // empty `params` list, since the parse finds no tracking key.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, ["/go?to=/x?utm_source=y"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("fires on a real tracking param sitting next to such a value", async () => {
      // One character apart from the case above, and the opposite verdict: here
      // `utm_source` is its own parameter.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, ["/go?to=/x&utm_source=y"]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        targetUrl: url("/go?to=/x&utm_source=y"),
        params: ["utm_source"],
        inlinkCount: 1,
      });
    });

    it("never reports a target with an empty params list", async () => {
      // The invariant behind the two cases above, asserted over a mixed set:
      // whatever the SQL pre-filter admits, a finding always names at least one
      // parameter the URL really carries.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, [
        "/a?to=/x?utm_source=y",
        "/b?to=/x?gclid=1&fbclid=2",
        "/c?plain=1",
        "/d?utm_campaign=spring",
      ]);

      const found = await run(ID, crawlId);
      for (const f of found) {
        expect(f.evidence["params"], String(f.pageUrl)).not.toEqual([]);
      }
      expect(found.map((f) => f.evidence["params"])).toEqual([["fbclid"], ["utm_campaign"]]);
    });

    it("matches a valueless tracking param", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, ["/a?page=2&fbclid"]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ params: ["fbclid"] });
    });

    it("caps the list at 200 targets and still says how many there are", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      const total = URL_FINDING_CAP + 5;
      await addLinks(
        crawlId,
        ids.get("/")!,
        Array.from({ length: total }, (_, i) => `/p${String(i).padStart(4, "0")}?utm_source=x`),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[URL_FINDING_CAP - 1]!.evidence["truncated"]).toEqual({
        reported: URL_FINDING_CAP,
        total,
      });
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("url.parameter-pages-indexable", () => {
    const ID = "url.parameter-pages-indexable";

    it("is silent on an indexable page with no query string", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/plain" }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("reports an indexable parameter page that canonicalises to itself", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/list?colour=red&sort=asc" }]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: rule(ID).severity,
        pageId: ids.get("/list?colour=red&sort=asc"),
        pageUrl: url("/list?colour=red&sort=asc"),
        dedupeKey: url("/list?colour=red&sort=asc"),
      });
      expect(found[0]!.evidence).toEqual({
        url: url("/list?colour=red&sort=asc"),
        params: ["colour", "sort"],
      });
    });

    it("is silent when the parameter page canonicalises to the clean URL", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/list?colour=red", canonical: url("/list") }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent when the parameter page declares no canonical at all", async () => {
      // "No canonical" is `canonical.missing`'s finding, and it is a different
      // fix. This rule is about the page that deliberately canonicalises the
      // parameter variant to itself.
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/list?colour=red", canonical: null }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent when the parameter page is noindexed or not a 200", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a?x=1", robotsMeta: "noindex" },
        { path: "/b?x=1", statusCode: 404, fetchClass: "client_error" },
        { path: "/c?x=1", statusCode: 301, fetchClass: "redirect" },
        { path: "/d?x=1", fetchClass: "non_html" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });
});

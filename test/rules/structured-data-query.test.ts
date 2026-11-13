/**
 * The structured-data rules against a real database.
 *
 * Rows are inserted directly (the content and url-hygiene pattern): what is
 * under test is what the rules make of the blocks the crawler stored, not the
 * JSON-LD extraction that produced them.
 *
 * Two of the three are site-scoped — "this site publishes no structured data at
 * all" and "no page on it carries a breadcrumb trail" — so their assertions are
 * about a crawl rather than about a page, and the pages inserted beside them
 * exist to make the site big enough to have an opinion about.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, structuredData } from "../../src/db/schema.js";
import {
  BREADCRUMB_PAGE_FLOOR,
  SELF_SERVING_FIELDS,
  SELF_SERVING_TYPES,
  structuredDataRules,
} from "../../src/rules/query/structured-data.js";
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

const SITE = "https://schema-rules.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(structuredDataRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in structuredDataRules`);
  return r;
}

describe("structuredDataRules metadata", () => {
  it("defines the three structured-data query rules", () => {
    expect(structuredDataRules.map((r) => r.id).sort()).toEqual([
      "schema.breadcrumb-absent",
      "schema.none-on-site",
      "schema.self-serving-reviews",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(
        structuredDataRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]]),
      ),
    ).toEqual({
      "schema.none-on-site": [["CHECK-43"], "info", "structured-data"],
      "schema.breadcrumb-absent": [["CHECK-45"], "info", "structured-data"],
      "schema.self-serving-reviews": [["CHECK-46"], "info", "structured-data"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of structuredDataRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    expect(titles.size).toBe(structuredDataRules.length);
  });

  it("names the self-serving types and fields Google's policy is about", () => {
    expect([...SELF_SERVING_TYPES]).toEqual(["Organization", "LocalBusiness"]);
    expect([...SELF_SERVING_FIELDS]).toEqual(["aggregateRating", "review"]);
  });
});

describe("the structured-data rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
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
      const normalised = normalizeUrl(full);
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
        depth: 1,
        discoveredVia: "link",
      };
    });
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  /** A crawl of `count` indexable pages, `/p0…`, and nothing else. */
  async function crawlOfPages(count: number): Promise<string> {
    const crawlId = await newCrawl();
    if (count > 0) {
      await addPages(
        crawlId,
        Array.from({ length: count }, (_, i) => ({ path: `/p${i}` })),
      );
    }
    return crawlId;
  }

  async function addBlocks(
    crawlId: string,
    blocks: { pageId: string; type: string; raw: Record<string, unknown> }[],
  ): Promise<void> {
    await db.insert(structuredData).values(
      blocks.map((b) => ({
        crawlId,
        pageId: b.pageId,
        schemaType: b.type,
        format: "jsonld" as const,
        raw: b.raw,
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

  describe("schema.none-on-site", () => {
    const ID = "schema.none-on-site";

    it("fires once for a crawl that stored no structured data at all", async () => {
      const crawlId = await crawlOfPages(3);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toEqual({
        ruleId: ID,
        severity: "info",
        // Site-scoped: the finding belongs to the crawl, not to a URL.
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
        evidence: { indexablePages: 3 },
      });
    });

    it("counts only indexable 200 pages in the evidence", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/ok" },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
        { path: "/hidden", robotsMeta: "noindex" },
      ]);

      expect((await run(ID, crawlId))[0]!.evidence).toEqual({ indexablePages: 1 });
    });

    it("is silent on a crawl with no indexable page at all", async () => {
      // A crawl that reached nothing has seen neither markup nor its absence,
      // and "this site publishes no structured data" would be a claim about a
      // site nobody read. The floor is drawn on the same number the finding
      // carries as evidence.
      const empty = await newCrawl();
      expect(await run(ID, empty)).toHaveLength(0);

      const allNoindex = await newCrawl();
      await addPages(allNoindex, [
        { path: "/hidden", robotsMeta: "noindex" },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);
      // The same silence covers a site whose every page is noindexed: it has no
      // rich result to earn, and its actual problem is the noindex, which the
      // indexability rules report by name.
      expect(await run(ID, allNoindex)).toHaveLength(0);

      // And one indexable page is enough to have an answer.
      await addPages(allNoindex, [{ path: "/visible" }]);
      expect(await run(ID, allNoindex)).toHaveLength(1);
    });

    it("is silent as soon as one block of any type was stored", async () => {
      // Any type at all: the check is whether the site uses structured data,
      // not whether it uses the two types this engine profiles.
      const crawlId = await crawlOfPages(3);
      const ids = await addPages(crawlId, [{ path: "/article" }]);
      await addBlocks(crawlId, [
        { pageId: ids.get("/article")!, type: "Article", raw: { "@type": "Article" } },
      ]);

      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("schema.breadcrumb-absent", () => {
    const ID = "schema.breadcrumb-absent";

    it("fires once for a site past the page floor with no BreadcrumbList", async () => {
      const crawlId = await crawlOfPages(BREADCRUMB_PAGE_FLOOR);
      const ids = await addPages(crawlId, [{ path: "/product" }]);
      // Structured data the site DOES publish — this rule is about breadcrumbs
      // alone, so a site with rich product markup and no trail still fires.
      await addBlocks(crawlId, [
        { pageId: ids.get("/product")!, type: "Product", raw: { "@type": "Product" } },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toEqual({
        ruleId: ID,
        severity: "info",
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
        evidence: { indexablePages: BREADCRUMB_PAGE_FLOOR + 1 },
      });
    });

    it("is silent below the page floor: a handful of pages needs no trail", async () => {
      const crawlId = await crawlOfPages(BREADCRUMB_PAGE_FLOOR - 1);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent when one page carries a BreadcrumbList", async () => {
      const crawlId = await crawlOfPages(BREADCRUMB_PAGE_FLOOR);
      const ids = await addPages(crawlId, [{ path: "/deep" }]);
      await addBlocks(crawlId, [
        {
          pageId: ids.get("/deep")!,
          type: "BreadcrumbList",
          raw: { "@type": "BreadcrumbList", itemListElement: [] },
        },
      ]);

      // Even an empty trail: whether the trail is filled in is the derivation's
      // question and Phase 4's coverage metric, not this rule's. What this rule
      // reports is a site that does not mark breadcrumbs up at all.
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("schema.self-serving-reviews", () => {
    const ID = "schema.self-serving-reviews";

    it("fires on an Organization carrying its own rating", async () => {
      const crawlId = await crawlOfPages(1);
      const ids = await addPages(crawlId, [{ path: "/about" }]);
      await addBlocks(crawlId, [
        {
          pageId: ids.get("/about")!,
          type: "Organization",
          raw: {
            "@type": "Organization",
            name: "Ariadne Ltd",
            aggregateRating: { "@type": "AggregateRating", ratingValue: "5" },
          },
        },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toEqual({
        ruleId: ID,
        severity: "info",
        pageId: ids.get("/about"),
        pageUrl: url("/about"),
        dedupeKey: `${url("/about")}#Organization`,
        evidence: { schemaType: "Organization", fields: ["aggregateRating"] },
      });
    });

    it("fires on a LocalBusiness carrying reviews, naming both fields when both are there", async () => {
      const crawlId = await crawlOfPages(1);
      const ids = await addPages(crawlId, [{ path: "/shop" }]);
      await addBlocks(crawlId, [
        {
          pageId: ids.get("/shop")!,
          type: "LocalBusiness",
          raw: {
            "@type": "LocalBusiness",
            aggregateRating: { "@type": "AggregateRating", ratingValue: "4.9" },
            review: [{ "@type": "Review", author: "A customer" }],
          },
        },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        schemaType: "LocalBusiness",
        fields: ["aggregateRating", "review"],
      });
      expect(found[0]!.dedupeKey).toBe(`${url("/shop")}#LocalBusiness`);
    });

    it("does not fire on a Product's rating: reviews of a product are allowed", async () => {
      const crawlId = await crawlOfPages(1);
      const ids = await addPages(crawlId, [{ path: "/shoe" }]);
      await addBlocks(crawlId, [
        {
          pageId: ids.get("/shoe")!,
          type: "Product",
          raw: {
            "@type": "Product",
            name: "Trail Runner 3",
            image: ["https://schema-rules.example/img.jpg"],
            offers: { "@type": "Offer", price: "129.00", priceCurrency: "EUR" },
            aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6" },
            review: [{ "@type": "Review", author: "A runner" }],
          },
        },
      ]);

      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent on an Organization whose rating key carries nothing", async () => {
      const crawlId = await crawlOfPages(1);
      const ids = await addPages(crawlId, [{ path: "/empty" }]);
      await addBlocks(crawlId, [
        {
          pageId: ids.get("/empty")!,
          type: "Organization",
          raw: { "@type": "Organization", name: "Ariadne Ltd", review: [], aggregateRating: null },
        },
      ]);

      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("reports a page and type once, whatever the block count", async () => {
      const crawlId = await crawlOfPages(1);
      const ids = await addPages(crawlId, [{ path: "/twice" }]);
      await addBlocks(crawlId, [
        {
          pageId: ids.get("/twice")!,
          type: "Organization",
          raw: { "@type": "Organization", aggregateRating: { ratingValue: "5" } },
        },
        {
          pageId: ids.get("/twice")!,
          type: "Organization",
          raw: { "@type": "Organization", review: [{ author: "Us" }] },
        },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      // The union across the page's blocks of that type, so a finding says what
      // the page publishes rather than what one of its scripts does.
      expect(found[0]!.evidence["fields"]).toEqual(["aggregateRating", "review"]);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });
});

/**
 * The per-node schema rules against a real database.
 *
 * Blocks are inserted as the crawler stores them, `deriveSchemaValidation`
 * fills the verdicts, and the rules read them. What is under test is what each
 * rule makes of a verdict, so the JSON-LD here is written to provoke exactly one
 * list.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, structuredData } from "../../src/db/schema.js";
import { deriveSchemaValidation } from "../../src/rules/derive/schema-validation.js";
import {
  MAX_PROBLEMS_IN_EVIDENCE,
  schemaValidationRules,
} from "../../src/rules/query/schema-validation.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { DEFAULT_THRESHOLDS } from "../../src/rules/judgement.js";
import type { JudgementContext } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://schema-validation.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(schemaValidationRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in schemaValidationRules`);
  return r;
}

const ctx = "https://schema.org";
const COMPLETE_PRODUCT = {
  "@context": ctx,
  "@type": "Product",
  name: "Mug",
  image: "https://schema-validation.example/mug.jpg",
  offers: { "@type": "Offer", price: "14.00", priceCurrency: "GBP" },
};
const CLEAN_ORG = { "@context": ctx, "@type": "Organization", name: "Estuary" };
/** One empty value: `$.name`. */
const EMPTY_NAMED_ORG = { ...CLEAN_ORG, name: "" };

describe("schemaValidationRules metadata", () => {
  it("defines the per-node rules and the template rule with the severities and checks the table assigns", () => {
    expect(
      Object.fromEntries(
        schemaValidationRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]]),
      ),
    ).toEqual({
      "schema.parse-error": [["CHECK-43"], "warning", "structured-data"],
      "schema.unknown-type": [["CHECK-43"], "warning", "structured-data"],
      "schema.unknown-property": [["CHECK-43"], "warning", "structured-data"],
      "schema.property-pending-or-superseded": [["CHECK-43"], "info", "structured-data"],
      "schema.embedded-type-mismatch": [["CHECK-43"], "warning", "structured-data"],
      "schema.empty-value": [["CHECK-43"], "warning", "structured-data"],
      "schema.unresolved-reference": [["CHECK-43"], "info", "structured-data"],
      "schema.template-inconsistent": [["CHECK-43"], "warning", "structured-data"],
    });
  });
});

describe("the schema validation rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    parseErrors?: number;
    microdataErrors?: number | null;
    pageType?: string | null;
    extractionVersion?: number;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      hostKey: hostKeyOf(SITE),
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
        structuredDataParseErrors: s.parseErrors ?? 0,
        structuredDataMicrodataErrors: s.microdataErrors === undefined ? 0 : s.microdataErrors,
        pageType: s.pageType ?? null,
        extractionVersion: s.extractionVersion ?? 4,
      };
    });
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addBlock(
    crawlId: string,
    pageId: string,
    raw: Record<string, unknown>,
    format: "jsonld" | "microdata" | "rdfa" = "jsonld",
  ): Promise<void> {
    const type = typeof raw["@type"] === "string" ? raw["@type"] : "Unknown";
    await db.insert(structuredData).values({
      crawlId,
      pageId,
      schemaType: type,
      format,
      raw: JSON.parse(JSON.stringify(raw)) as Record<string, unknown>,
    });
  }

  /** One indexable page `/a` carrying `blocks`, derived. */
  async function onePage(...blocks: Record<string, unknown>[]): Promise<string> {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [{ path: "/a" }]);
    for (const b of blocks) await addBlock(crawlId, ids.get("/a")!, b);
    await deriveSchemaValidation(db, crawlId);
    return crawlId;
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

  describe("schema.parse-error", () => {
    const ID = "schema.parse-error";

    it("fires on JSON-LD parse errors and on microdata errors, silent on a clean page", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/json", parseErrors: 2 },
        { path: "/micro", microdataErrors: 1 },
        { path: "/clean" },
      ]);
      const found = await run(ID, crawlId);
      expect(found.map((f) => [f.pageUrl, f.evidence, f.dedupeKey, f.severity])).toEqual([
        [url("/json"), { jsonLdParseErrors: 2, microdataErrors: 0 }, url("/json"), "warning"],
        [url("/micro"), { jsonLdParseErrors: 0, microdataErrors: 1 }, url("/micro"), "warning"],
      ]);
    });

    it("a v3 page with a JSON-LD parse error fires with microdataErrors null", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/v3", parseErrors: 1, microdataErrors: null }]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({ jsonLdParseErrors: 1, microdataErrors: null });
    });

    it("a v3 page with no JSON-LD error is silent", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/v3", microdataErrors: null }]);
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a noindex page", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/n", parseErrors: 3, robotsMeta: "noindex" }]);
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("notes truncation at caps.listing", async () => {
      const crawlId = await newCrawl();
      await addPages(
        crawlId,
        ["/a", "/b", "/c"].map((path) => ({ path, parseErrors: 1 })),
      );
      const found = await rule(ID).run(db, crawlId, { listing: 2 } as never);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/a"), url("/b")]);
      expect(found[1]!.evidence).toMatchObject({ truncated: { reported: 2, total: 3 } });
    });
  });

  describe("schema.unknown-type", () => {
    const ID = "schema.unknown-type";
    it("fires on a type schema.org does not define and is silent on a clean page", async () => {
      const bad = await onePage({ "@context": ctx, "@type": "Prodcut", name: "x" });
      const found = await run(ID, bad);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        problems: [{ format: "jsonld", path: "$", type: "Prodcut" }],
        problemCount: 1,
      });
      expect(await run(ID, await onePage(CLEAN_ORG))).toEqual([]);
    });
  });

  describe("schema.unknown-property", () => {
    const ID = "schema.unknown-property";
    it("fires on a property the type does not take", async () => {
      const found = await run(ID, await onePage({ ...CLEAN_ORG, flavour: "mint" }));
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        problems: [{ format: "jsonld", path: "$", type: "Organization", property: "flavour" }],
        problemCount: 1,
      });
      expect(await run(ID, await onePage(CLEAN_ORG))).toEqual([]);
    });
  });

  describe("schema.property-pending-or-superseded", () => {
    const ID = "schema.property-pending-or-superseded";
    it("fires on a pending property, as info", async () => {
      // `gtin` is pending in the pinned schema.org release.
      const found = await run(
        ID,
        await onePage({ ...COMPLETE_PRODUCT, gtin: "0123456789012" }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("info");
      expect(found[0]!.evidence).toEqual({
        problems: [
          { format: "jsonld", path: "$", property: "gtin", status: "pending", supersededBy: null },
        ],
        problemCount: 1,
      });
    });
    it("is silent on a clean page", async () => {
      expect(await run(ID, await onePage(CLEAN_ORG))).toEqual([]);
    });
  });

  describe("schema.embedded-type-mismatch", () => {
    const ID = "schema.embedded-type-mismatch";
    it("fires on a nested node of a type the property refuses", async () => {
      const found = await run(
        ID,
        await onePage({
          ...CLEAN_ORG,
          address: { "@type": "Product", name: "not an address" },
        }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence["problems"]).toMatchObject([
        { format: "jsonld", path: "$.address", property: "address", type: "Product" },
      ]);
      expect(await run(ID, await onePage(CLEAN_ORG))).toEqual([]);
    });
  });

  describe("schema.empty-value", () => {
    const ID = "schema.empty-value";
    it("fires as a warning, listing each empty value at its own path with the format, type and property", async () => {
      const found = await run(
        ID,
        await onePage({ ...COMPLETE_PRODUCT, name: "", offers: { "@type": "Offer", price: "", priceCurrency: "GBP" } }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("warning");
      expect(found[0]!.evidence).toEqual({
        problems: [
          { format: "jsonld", path: "$.name", type: "Product", property: "name" },
          { format: "jsonld", path: "$.offers.price", type: "Offer", property: "price" },
        ],
        problemCount: 2,
      });
    });

    it("is silent on a clean page, and on zero, false and a bare reference", async () => {
      expect(await run(ID, await onePage(COMPLETE_PRODUCT))).toEqual([]);
      expect(
        await run(ID, await onePage({ ...CLEAN_ORG, numberOfEmployees: 0, publishingPrinciples: { "@id": "#p" } })),
      ).toEqual([]);
    });

    it("problems are capped at 20 with the full count beside them, and carry the block format", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }]);
      for (let i = 0; i < MAX_PROBLEMS_IN_EVIDENCE + 5; i += 1) {
        await addBlock(crawlId, ids.get("/a")!, EMPTY_NAMED_ORG, i === 0 ? "microdata" : "jsonld");
      }
      await deriveSchemaValidation(db, crawlId);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      const problems = found[0]!.evidence["problems"] as { format: string }[];
      expect(problems).toHaveLength(MAX_PROBLEMS_IN_EVIDENCE);
      expect(found[0]!.evidence["problemCount"]).toBe(MAX_PROBLEMS_IN_EVIDENCE + 5);
      // Block id order: the first block inserted is the microdata one.
      expect(problems[0]!.format).toBe("microdata");
      expect(problems[1]!.format).toBe("jsonld");
    });
  });

  describe("schema.unresolved-reference", () => {
    const ID = "schema.unresolved-reference";
    const ORG = { "@context": ctx, "@type": "Organization", "@id": "#org", name: "Estuary" };
    const PAGE = { "@context": ctx, "@type": "WebPage", name: "Home", publisher: { "@id": "#org" } };

    it("a reference another block on the same page defines is resolved (a graph split over two scripts)", async () => {
      expect(await run(ID, await onePage(ORG, PAGE))).toEqual([]);
      // Order does not matter: the definition may come after the reference.
      expect(await run(ID, await onePage(PAGE, ORG))).toEqual([]);
    });

    it("fires as info on a reference no block of the page defines, listing only the unresolved ones", async () => {
      const found = await run(
        ID,
        await onePage(ORG, { ...PAGE, about: [{ "@id": "#org" }, { "@id": "#topic" }] }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("info");
      expect(found[0]!.evidence).toEqual({
        problems: [{ format: "jsonld", path: "$.about[1]", id: "#topic" }],
        problemCount: 1,
      });
    });

    it("reports an absolute IRI on another site with the IRI", async () => {
      const found = await run(
        ID,
        await onePage({ ...CLEAN_ORG, parentOrganization: { "@id": "https://parent.example/#org" } }),
      );
      expect(found[0]!.evidence).toEqual({
        problems: [{ format: "jsonld", path: "$.parentOrganization", id: "https://parent.example/#org" }],
        problemCount: 1,
      });
    });

    it("resolves per page: an id defined on another page does not resolve this page's reference", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }, { path: "/b" }]);
      await addBlock(crawlId, ids.get("/a")!, PAGE);
      await addBlock(crawlId, ids.get("/b")!, ORG);
      await deriveSchemaValidation(db, crawlId);
      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/a")]);
    });

    it("a definition in a microdata block resolves a JSON-LD reference on the same page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }]);
      await addBlock(crawlId, ids.get("/a")!, PAGE);
      await addBlock(crawlId, ids.get("/a")!, ORG, "microdata");
      await deriveSchemaValidation(db, crawlId);
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a crawl not wholly at extraction 4, where other blocks may not have been read", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a", extractionVersion: 3 }]);
      await addBlock(crawlId, ids.get("/a")!, PAGE);
      await deriveSchemaValidation(db, crawlId);
      expect(await run(ID, crawlId)).toEqual([]);
    });
  });

  describe("shared behaviour", () => {
    it("non-JUDGED pages are silent", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/n", robotsMeta: "noindex" }]);
      await addBlock(crawlId, ids.get("/n")!, EMPTY_NAMED_ORG);
      await deriveSchemaValidation(db, crawlId);
      expect(await run("schema.empty-value", crawlId)).toEqual([]);
    });

    it("a null validation on a judged page throws and says to re-run the rules", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }]);
      await addBlock(crawlId, ids.get("/a")!, CLEAN_ORG);
      await expect(run("schema.unknown-type", crawlId)).rejects.toThrow(
        new RegExp(`schema\\.unknown-type: ${url("/a")} structured data has no validation — re-run the rules`),
      );
    });

    it("a malformed validation blob throws naming the row id and saying to re-run the rules", async () => {
      const crawlId = await onePage(EMPTY_NAMED_ORG);
      const [row] = await db
        .select({ id: structuredData.id })
        .from(structuredData)
        .where(eq(structuredData.crawlId, crawlId));
      const stored = await db
        .select({ v: structuredData.validation })
        .from(structuredData)
        .where(eq(structuredData.id, row!.id));
      // A valid blob plus a key the strict schema refuses: still selected by the
      // SQL pre-filter, and malformed to the reader.
      await db
        .update(structuredData)
        .set({ validation: { ...stored[0]!.v!, nonsense: true } as never })
        .where(eq(structuredData.id, row!.id));
      await expect(run("schema.empty-value", crawlId)).rejects.toThrow(
        new RegExp(`row ${row!.id} .*re-run the rules`),
      );
    });

    it("a blob in the shape written before the rework is refused, never read", async () => {
      const crawlId = await onePage({ "@context": ctx, "@type": "Prodcut", name: "x" });
      const [row] = await db
        .select({ id: structuredData.id, v: structuredData.validation })
        .from(structuredData)
        .where(eq(structuredData.crawlId, crawlId));
      const { emptyValues: _e, definedIds: _d, references: _r, nodes: _n, ...rest } = row!.v!;
      await db
        .update(structuredData)
        .set({ validation: { ...rest, googleFeatures: [], deprecatedFeatures: [] } as never })
        .where(eq(structuredData.id, row!.id));
      await expect(run("schema.unknown-type", crawlId)).rejects.toThrow(/re-run the rules/);
      // A rule with nothing to say about the block refuses it too, rather than
      // reading the page as clean.
      await expect(run("schema.empty-value", crawlId)).rejects.toThrow(/re-run the rules/);
    });

    it("orders by URL and notes truncation at caps.listing", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/c" }, { path: "/a" }, { path: "/b" }]);
      for (const id of ids.values()) await addBlock(crawlId, id, EMPTY_NAMED_ORG);
      // `/c` carries a second block: the total counts PAGES (3), so a regression
      // to counting blocks (4) would fail here.
      await addBlock(crawlId, ids.get("/c")!, EMPTY_NAMED_ORG);
      await deriveSchemaValidation(db, crawlId);
      const found = await rule("schema.empty-value").run(db, crawlId, {
        listing: 2,
      } as never);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/a"), url("/b")]);
      expect(found[1]!.evidence).toMatchObject({ truncated: { reported: 2, total: 3 } });
    });
  });
  describe("schema.template-inconsistent", () => {
    const ID = "schema.template-inconsistent";
    const PRODUCT = { "@context": ctx, "@type": "Product", name: "Mug" };

    /** `total` product pages `/p0..`; the first `with` carry a Product block. */
    async function productSite(
      total: number,
      withProduct: number,
      opts: { extractionVersion?: number; pageType?: string | null } = {},
    ): Promise<string> {
      const crawlId = await newCrawl();
      const specs = Array.from({ length: total }, (_, i) => ({
        path: `/p${String(i).padStart(2, "0")}`,
        pageType: opts.pageType === undefined ? "product" : opts.pageType,
        ...(opts.extractionVersion === undefined ? {} : { extractionVersion: opts.extractionVersion }),
      }));
      const ids = await addPages(crawlId, specs);
      for (let i = 0; i < withProduct; i += 1) {
        await addBlock(crawlId, ids.get(specs[i]!.path)!, PRODUCT);
      }
      return crawlId;
    }

    const ctxWith = (overrides: Partial<Record<keyof typeof DEFAULT_THRESHOLDS, number>>): JudgementContext => ({
      thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
      disabledRules: new Set(),
    });

    it("fires on the 3 of 12 product pages lacking Product", async () => {
      const found = await run(ID, await productSite(12, 9));
      expect(found.map((f) => f.pageUrl)).toEqual([url("/p09"), url("/p10"), url("/p11")]);
      expect(found[0]).toMatchObject({
        ruleId: ID,
        severity: "warning",
        dedupeKey: `${url("/p09")}#Product`,
        evidence: { pageType: "product", schemaType: "Product", pagesWith: 9, pagesInType: 12 },
      });
    });

    it("is silent at 8 of 12 (66.7%)", async () => {
      expect(await run(ID, await productSite(12, 8))).toEqual([]);
    });

    it("an override of SCHEMA_TEMPLATE_SHARE 60 makes 8 of 12 fire", async () => {
      const crawlId = await productSite(12, 8);
      const found = await rule(ID).run(db, crawlId, undefined, ctxWith({ SCHEMA_TEMPLATE_SHARE: 60 }));
      expect(found).toHaveLength(4);
      expect(found[0]!.evidence).toMatchObject({ pagesWith: 8, pagesInType: 12 });
    });

    it("an override of SCHEMA_TEMPLATE_MIN_PAGES 5 makes 4 of 5 fire", async () => {
      const crawlId = await productSite(5, 4);
      expect(await run(ID, crawlId)).toEqual([]);
      const found = await rule(ID).run(db, crawlId, undefined, ctxWith({ SCHEMA_TEMPLATE_MIN_PAGES: 5 }));
      expect(found).toHaveLength(1);
    });

    it("pins the share boundary at >=: 7 of 10 (exactly 70%) fires, 6 of 9 (66.7%) is silent", async () => {
      const found = await run(ID, await productSite(10, 7));
      expect(found.map((f) => f.pageUrl)).toEqual([url("/p07"), url("/p08"), url("/p09")]);
      expect(found[0]!.evidence).toMatchObject({ pagesWith: 7, pagesInType: 10 });
      // Nine pages is under the default floor of ten, so the floor is lowered to
      // nine and the share alone decides.
      const nine = await productSite(9, 6);
      expect(
        await rule(ID).run(db, nine, undefined, ctxWith({ SCHEMA_TEMPLATE_MIN_PAGES: 9 })),
      ).toEqual([]);
    });

    it("counts a page once however many blocks carry the type", async () => {
      // 10 pages, 6 carrying Product, one of them in two blocks. By pages that is
      // 60% (silent); a count of blocks would read 7 of 10 and fire.
      const crawlId = await productSite(10, 6);
      const first = (
        await db.select({ id: pages.id, url: pages.url }).from(pages).where(eq(pages.crawlId, crawlId))
      ).find((p) => p.url === url("/p00"));
      if (first === undefined) throw new Error("fixture page /p00 was not inserted");
      await addBlock(crawlId, first.id, PRODUCT);
      expect(await run(ID, crawlId)).toEqual([]);

      // And with a seventh page, the share is 7 of 10 by pages, and the evidence
      // says 7, not 8.
      const seven = await productSite(10, 7);
      const p00 = (
        await db.select({ id: pages.id, url: pages.url }).from(pages).where(eq(pages.crawlId, seven))
      ).find((p) => p.url === url("/p00"));
      await addBlock(seven, p00!.id, PRODUCT);
      const found = await run(ID, seven);
      expect(found).toHaveLength(3);
      expect(found[0]!.evidence).toMatchObject({ pagesWith: 7, pagesInType: 10 });
    });

    it("is silent below 10 pages of the type", async () => {
      expect(await run(ID, await productSite(9, 8))).toEqual([]);
    });

    it("is silent when every page of the type carries it", async () => {
      expect(await run(ID, await productSite(12, 12))).toEqual([]);
    });

    it("never buckets untyped pages (null or empty page type)", async () => {
      expect(await run(ID, await productSite(12, 9, { pageType: null }))).toEqual([]);
      expect(await run(ID, await productSite(12, 9, { pageType: "" }))).toEqual([]);
    });

    it("is silent on a v3 crawl", async () => {
      expect(await run(ID, await productSite(12, 9, { extractionVersion: 3 }))).toEqual([]);
    });

    it("excludes the 'unknown' type from the comparison", async () => {
      const crawlId = await newCrawl();
      const specs = Array.from({ length: 12 }, (_, i) => ({
        path: `/u${String(i).padStart(2, "0")}`,
        pageType: "product",
      }));
      const ids = await addPages(crawlId, specs);
      for (let i = 0; i < 9; i += 1) {
        await db.insert(structuredData).values({
          crawlId,
          pageId: ids.get(specs[i]!.path)!,
          schemaType: "unknown",
          format: "jsonld",
          raw: {},
        });
      }
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("notes truncation at caps.listing", async () => {
      const found = await rule(ID).run(db, await productSite(12, 9), { listing: 2 } as never);
      expect(found).toHaveLength(2);
      expect(found[1]!.evidence).toMatchObject({ truncated: { reported: 2, total: 3 } });
    });
  });
});

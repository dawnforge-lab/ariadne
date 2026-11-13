/**
 * The `structured_data` listing and the `structured_data_nodes` CSV view
 * (Phase 29a T9).
 *
 * The crawl is seeded and then judged through `runRulesForCrawl`, so every
 * `validation_jsonb` blob the listing counts over was written by the real
 * derivation (`deriveSchemaValidation`), not by this file. The expected counts
 * are worked out from `validateBlock` — the function the derivation calls — with
 * R0.8's arithmetic, and the SQL has to agree.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { ApiService } from "../../src/api/service.js";
import { CSV_VIEW_DEFS, csvRecord, type CsvViewContext } from "../../src/api/csv.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, structuredData } from "../../src/db/schema.js";
import type { StructuredDataFormat } from "../../src/crawl/parse/page-analyzer.js";
import { validateBlock, type BlockValidation } from "../../src/rules/schema-org/validate.js";
import { GOOGLE_FEATURES } from "../../src/rules/schema-org/google-features.js";
import { LABEL_SEPARATOR, problemCells } from "../../src/api/structured-data.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";
import { LOCAL_TENANT, parseTenant } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://structured-data-listing.example";
const C = "https://schema.org";
const runId = randomUUID();
const crawlId = `crawl_sd_listing_${runId}`;
const unjudgedId = `crawl_sd_listing_unjudged_${runId}`;
const staleId = `crawl_sd_listing_stale_${runId}`;
const skipsId = `crawl_sd_listing_skips_${runId}`;
const malformedId = `crawl_sd_listing_malformed_${runId}`;
const allCrawls = [crawlId, unjudgedId, staleId, skipsId, malformedId];

const PRODUCT = {
  "@context": C,
  "@type": "Product",
  name: "Widget",
  offers: { "@type": "Offer", price: "9.99", priceCurrency: "EUR" },
};
const ORGANIZATION = { "@context": C, "@type": "Organization", name: "Acme", url: `${SITE}/` };
const ARTICLE = {
  "@context": C,
  "@type": ["Article", "Blorpticle"],
  headline: "Hello",
  fooBar: 1,
  author: { "@type": "Offer", price: "1" },
};
const PERSON = { "@context": C, "@type": "Person", name: "Ada" };
const FAQ = { "@context": C, "@type": "FAQPage", name: "Q" };

interface BlockSpec {
  path: string;
  type: string;
  format: StructuredDataFormat;
  raw: Record<string, unknown>;
}

/** In insertion order, which is `id` order, which is the CSV view's order. */
const BLOCKS: BlockSpec[] = [
  { path: "/product", type: "Product", format: "jsonld", raw: PRODUCT },
  { path: "/product", type: "Organization", format: "microdata", raw: ORGANIZATION },
  { path: "/article", type: "Article", format: "jsonld", raw: ARTICLE },
  { path: "/article", type: "Person", format: "jsonld", raw: PERSON },
  { path: "/article", type: "FAQPage", format: "jsonld", raw: FAQ },
];

const SKIPS = { microdataItemrefSkipped: 1, rdfaUnsupported: 0, valuesCapped: 0 };

let db: Db;
let service: ApiService;
let exportDir: string;

async function seedCrawl(id: string): Promise<Map<string, string>> {
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: `${SITE}/`, hostKey: hostKeyOf(`${SITE}/`),
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: 4,
  });
  const specs = [
    { path: "/", pageType: "home" },
    { path: "/article", pageType: "blog" },
    { path: "/broken", pageType: "blog", structuredDataParseErrors: 2, structuredDataMicrodataErrors: 1 },
    { path: "/product", pageType: "product", structuredDataSkips: SKIPS },
  ];
  const ids = new Map<string, string>();
  await db.insert(pages).values(
    specs.map(({ path, ...rest }, i) => {
      const url = `${SITE}${path}`;
      const pageId = `page_${randomUUID()}`;
      ids.set(path, pageId);
      return mkPage({
        id: pageId,
        crawlId: id,
        url,
        urlNormalised: url,
        ...(i === 0 ? { depth: 0, clickDepth: 0, discoveredVia: "seed" } : {}),
        ...rest,
      });
    }),
  );
  for (const block of BLOCKS) {
    await db.insert(structuredData).values({
      crawlId: id,
      pageId: ids.get(block.path)!,
      schemaType: block.type,
      format: block.format,
      raw: block.raw,
    });
  }
  return ids;
}

/** R0.8, in JS, over what `validateBlock` says — the oracle the SQL must match. */
function warnings(v: BlockValidation): number {
  return (
    v.unknownTypes.length +
    v.unknownProperties.length +
    v.typeMismatches.length +
    v.googleFeatures.filter((f) => f.missingRequired.length > 0).length
  );
}
function infos(v: BlockValidation): number {
  return (
    v.propertyStatus.length +
    v.googleFeatures.filter((f) => f.missingRecommended.length > 0).length +
    v.deprecatedFeatures.length
  );
}
function pageCounts(path: string): { warningCount: number; infoCount: number } {
  const verdicts = BLOCKS.filter((b) => b.path === path).map((b) => validateBlock(b.raw));
  return {
    warningCount: verdicts.reduce((n, v) => n + warnings(v), 0),
    infoCount: verdicts.reduce((n, v) => n + infos(v), 0),
  };
}

const NO_RULE_COPY: CsvViewContext = {
  rule: () => {
    throw new Error("structured_data_nodes asked for rule copy");
  },
  evidence: () => {
    throw new Error("structured_data_nodes asked for evidence");
  },
};

async function csvLines(id: string): Promise<string[]> {
  const stream = await service.prepareCsvExport(LOCAL_TENANT, id, { view: "structured_data_nodes" });
  const out: string[] = [];
  for await (const record of stream.records()) out.push(record);
  return out;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-sd-listing-"));
  service = new ApiService(db, { credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], exportDir, log: () => {} });

  await seedCrawl(crawlId);
  await service.runRulesForCrawl(LOCAL_TENANT, crawlId);

  await seedCrawl(unjudgedId);

  // Judged by this ruleset, then one blob nulled: the shape a crawl judged by
  // 0.25.1 (before the derivation existed) has on this table.
  await seedCrawl(staleId);
  await service.runRulesForCrawl(LOCAL_TENANT, staleId);
  await db.execute(sql`
    update structured_data set validation_jsonb = null
     where id = (select min(id) from structured_data where crawl_id = ${staleId})`);

  // Judged, then a stored skips object given a key the writer never writes.
  await seedCrawl(skipsId);
  await service.runRulesForCrawl(LOCAL_TENANT, skipsId);
  await db.execute(sql`
    update pages set structured_data_skips = structured_data_skips || '{"surprise": 1}'::jsonb
     where crawl_id = ${skipsId} and url = ${`${SITE}/product`}`);

  // Judged, then the Product block's first Google feature entry stripped of
  // `missingRequired`: every list is still an array, so only the entry-level
  // check can tell this blob from a clean one.
  await seedCrawl(malformedId);
  await service.runRulesForCrawl(LOCAL_TENANT, malformedId);
  await db.execute(sql`
    update structured_data
       set validation_jsonb = jsonb_set(validation_jsonb, '{googleFeatures,0}',
                                        (validation_jsonb #> '{googleFeatures,0}') - 'missingRequired')
     where id = (select min(id) from structured_data where crawl_id = ${malformedId})`);
}, 180_000);

afterAll(async () => {
  await service.close();
  for (const id of allCrawls) await db.delete(structuredData).where(eq(structuredData.crawlId, id));
  for (const id of allCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  rmSync(exportDir, { recursive: true, force: true });
});

describe("listStructuredData — the rows", () => {
  it("derived every block (the fixture is what it claims to be)", async () => {
    const rows = await db
      .select({ validation: structuredData.validation })
      .from(structuredData)
      .where(eq(structuredData.crawlId, crawlId));
    expect(rows).toHaveLength(BLOCKS.length);
    for (const row of rows) expect(row.validation).not.toBeNull();
  });

  it("lists the pages with blocks or errors, by URL, and leaves out a page with neither", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    expect(page.items.map((r) => r.url)).toEqual([
      `${SITE}/article`,
      `${SITE}/broken`,
      `${SITE}/product`,
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("answers the Product + microdata Organization page field by field", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    const product = page.items.find((r) => r.url === `${SITE}/product`);
    // The Product carries an Offer but no image: merchant-listing's one
    // required miss, which is a warning, and the recommended misses are info.
    const verdict = validateBlock(PRODUCT);
    expect(verdict.googleFeatures.find((f) => f.feature === "merchant-listing")?.missingRequired).toEqual([
      "image",
    ]);
    expect(product).toEqual({
      url: `${SITE}/product`,
      pageType: "product",
      indexable: true,
      formats: ["jsonld", "microdata"],
      types: ["Organization", "Product"],
      googleFeatures: ["merchant-listing", "organization", "product-snippet"],
      ...pageCounts("/product"),
      jsonLdParseErrors: 0,
      microdataErrors: 0,
      skips: SKIPS,
    });
    expect(product?.warningCount).toBe(1);
    expect(product?.infoCount).toBe(3);
  });

  it("names exactly the projected keys, in order (no spread of a row)", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    expect(Object.keys(page.items[0]!)).toEqual([
      "url", "pageType", "indexable", "formats", "types", "googleFeatures",
      "warningCount", "infoCount", "jsonLdParseErrors", "microdataErrors", "skips",
    ]);
  });

  it("sums every problem kind across a page's blocks", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    const article = page.items.find((r) => r.url === `${SITE}/article`);
    // Article: an unknown type, an unknown property and a type mismatch
    // (warnings) plus Article's recommended misses; FAQPage's withdrawn
    // feature (info); Person is clean.
    expect(article).toMatchObject({
      formats: ["jsonld"],
      types: ["Article", "FAQPage", "Person"],
      googleFeatures: ["article"],
      ...pageCounts("/article"),
    });
    expect(article?.warningCount).toBe(3);
    expect(article?.infoCount).toBe(2);
  });

  it("counts a page's parse and microdata errors as warnings, with no blocks at all", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    expect(page.items.find((r) => r.url === `${SITE}/broken`)).toEqual({
      url: `${SITE}/broken`,
      pageType: "blog",
      indexable: true,
      formats: [],
      types: [],
      googleFeatures: [],
      warningCount: 3,
      infoCount: 0,
      jsonLdParseErrors: 2,
      microdataErrors: 1,
      skips: { microdataItemrefSkipped: 0, rdfaUnsupported: 0, valuesCapped: 0 },
    });
  });
});

describe("listStructuredData — filters and paging", () => {
  it("format: pages holding at least one block of that syntax", async () => {
    const micro = await service.listStructuredData(LOCAL_TENANT, crawlId, { format: "microdata" });
    expect(micro.items.map((r) => r.url)).toEqual([`${SITE}/product`]);
    const json = await service.listStructuredData(LOCAL_TENANT, crawlId, { format: "jsonld" });
    expect(json.items.map((r) => r.url)).toEqual([`${SITE}/article`, `${SITE}/product`]);
    const rdfa = await service.listStructuredData(LOCAL_TENANT, crawlId, { format: "rdfa" });
    expect(rdfa.items).toEqual([]);
  });

  it("feature: pages with a block that matched that Google feature", async () => {
    const merchant = await service.listStructuredData(LOCAL_TENANT, crawlId, { feature: "merchant-listing" });
    expect(merchant.items.map((r) => r.url)).toEqual([`${SITE}/product`]);
    const article = await service.listStructuredData(LOCAL_TENANT, crawlId, { feature: "article" });
    expect(article.items.map((r) => r.url)).toEqual([`${SITE}/article`]);
    const recipe = await service.listStructuredData(LOCAL_TENANT, crawlId, { feature: "recipe" });
    expect(recipe.items).toEqual([]);
  });

  it("pageType: the cohort, and a cohort the crawl never produced is refused", async () => {
    const blog = await service.listStructuredData(LOCAL_TENANT, crawlId, { pageType: "blog" });
    expect(blog.items.map((r) => r.url)).toEqual([`${SITE}/article`, `${SITE}/broken`]);
    await expect(
      service.listStructuredData(LOCAL_TENANT, crawlId, { pageType: "nope" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("walks the listing a row at a time to the same rows", async () => {
    const whole = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    const walked: unknown[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      walked.push(...page.items);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(whole.items);
  });

  it("refuses a format outside the three, naming the accepted values", async () => {
    const error = await service
      .listStructuredData(LOCAL_TENANT, crawlId, { format: "xml" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION" });
    expect(String((error as Error).message)).toContain("jsonld, microdata, rdfa");
  });

  it("refuses a feature id Google has no profile for, naming the accepted ids", async () => {
    const error = await service
      .listStructuredData(LOCAL_TENANT, crawlId, { feature: "carousel" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION" });
    expect(String((error as Error).message)).toContain("merchant-listing");
  });
});

describe("listStructuredData — refusals", () => {
  it("refuses an unjudged crawl as issues_overview does, never an empty page", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, unjudgedId, {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(String((error as Error).message)).toContain(
      `crawl ${unjudgedId} has not been judged: run crawl_rules first`,
    );
  });

  it("refuses a crawl judged before the derivation existed (a null blob): re-run the rules", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, staleId, {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(String((error as Error).message)).toContain(
      `crawl ${staleId} was judged before structured data validation existed — re-run the rules (crawl_rules)`,
    );
  });

  it("answers another tenant's crawl exactly as a crawl that does not exist", async () => {
    const other = parseTenant(`sd-other-${runId.slice(0, 8)}`);
    const missing = `crawl_${randomUUID()}`;
    const foreign = await service.listStructuredData(other, crawlId, {}).catch((e: unknown) => e);
    const absent = await service.listStructuredData(other, missing, {}).catch((e: unknown) => e);
    expect(foreign).toMatchObject({ code: "NOT_FOUND" });
    expect(String((foreign as Error).message).split(crawlId).join(missing)).toBe(
      String((absent as Error).message),
    );
  });
});

describe("the structured_data_nodes CSV view", () => {
  it("writes the header and one row per (block, problem), a clean block as one row", async () => {
    const lines = await csvLines(crawlId);
    expect(lines[0]).toBe("URL,Format,Schema Type,Path,Node Type,Problem,Detail\r\n");
    const P = `${SITE}/product`;
    const A = `${SITE}/article`;
    expect(lines.slice(1)).toEqual(
      [
        [P, "jsonld", "Product", "$", "Product", "google-required", "merchant-listing: image"],
        [
          P, "jsonld", "Product", "$", "Product", "google-recommended",
          "product-snippet: aggregateRating, review, offers.availability, offers.priceValidUntil",
        ],
        [
          P, "jsonld", "Product", "$", "Product", "google-recommended",
          "merchant-listing: aggregateRating, brand, brand.name, category, color, description, gtin, " +
            "material, mpn, pattern, review, size, sku, offers.availability, offers.itemCondition, " +
            "offers.priceValidUntil",
        ],
        [
          P, "microdata", "Organization", "$", "Organization", "google-recommended",
          "organization: logo, sameAs, address, contactPoint, telephone, email, description",
        ],
        [A, "jsonld", "Article", "$", "Blorpticle", "unknown-type", "Blorpticle is not a schema.org type"],
        [A, "jsonld", "Article", "$", "Article", "unknown-property", "fooBar is not a property of Article"],
        [
          A, "jsonld", "Article", "$.author", "Offer", "type-mismatch",
          "author: Offer (expected Organization|Person)",
        ],
        [
          A, "jsonld", "Article", "$", "Article", "google-recommended",
          "article: author.name, author.url, dateModified, datePublished, image",
        ],
        [A, "jsonld", "Person", "", "", "", ""],
        [A, "jsonld", "FAQPage", "$", "FAQPage", "deprecated-feature", "faq"],
      ].map((cells) => csvRecord(cells)),
    );
  });

  it("continues across a 2-row limit by its (id, ord) keyset to the same rows", async () => {
    const def = CSV_VIEW_DEFS.structured_data_nodes;
    const walked: string[] = [];
    let cursor: readonly string[] = def.start;
    for (let guard = 0; guard < 20; guard++) {
      const result = await db.execute<Record<string, unknown>>(def.query(crawlId, cursor, 2, null, []));
      expect(result.rows.length).toBeLessThanOrEqual(2);
      if (result.rows.length === 0) break;
      for (const row of result.rows) walked.push(csvRecord(def.cells(row, NO_RULE_COPY)));
      cursor = def.next(result.rows[result.rows.length - 1]!);
    }
    expect(walked).toEqual((await csvLines(crawlId)).slice(1));
    expect(walked).toHaveLength(10);
  });

  it("refuses the unjudged and the pre-29a crawl before a byte, as the listing does", async () => {
    await expect(csvLines(unjudgedId)).rejects.toMatchObject({ code: "CONFLICT" });
    const stale = await csvLines(staleId).catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: "CONFLICT" });
    expect(String((stale as Error).message)).toContain("re-run the rules (crawl_rules)");
  });

  it("throws on a null blob met mid-stream rather than writing a clean row", async () => {
    const def = CSV_VIEW_DEFS.structured_data_nodes;
    const [nulled] = await db
      .select({ id: structuredData.id })
      .from(structuredData)
      .where(and(eq(structuredData.crawlId, staleId)))
      .orderBy(structuredData.id)
      .limit(1);
    const result = await db.execute<Record<string, unknown>>(def.query(staleId, def.start, 5, null, []));
    const row = result.rows.find((r) => String(r["id"]) === String(nulled!.id));
    expect(row).toBeDefined();
    expect(() => def.cells(row!, NO_RULE_COPY)).toThrow(/re-run the rules/);
  });
});

describe("the google-* Detail keeps AND and OR apart (review I1)", () => {
  it("no Google requirement label contains the comma the Detail joins labels with", () => {
    const labels = GOOGLE_FEATURES.flatMap((f) => [...f.required, ...f.recommended].map((r) => r.label));
    expect(labels.length).toBeGreaterThan(0);
    expect(LABEL_SEPARATOR.trim()).toBe(",");
    expect(labels.filter((label) => label.includes(","))).toEqual([]);
  });

  it("joins an anyOf label beside a plain one with ', ', leaving the label's own ' | ' readable as OR", () => {
    // A Product with an Offer that carries no price and no name: product-snippet
    // misses the plain `name` and the anyOf price label.
    const verdict = validateBlock({ "@context": C, "@type": "Product", offers: { "@type": "Offer" } });
    const snippet = verdict.googleFeatures.find((f) => f.feature === "product-snippet");
    const anyOf = "offers.price | offers.priceSpecification.price | offers.lowPrice";
    expect(snippet?.missingRequired).toEqual(["name", anyOf]);
    const cells = problemCells({ ...snippet, problem: "google-required" }, "test entry");
    expect(cells.detail).toBe(`product-snippet: name, ${anyOf}`);
  });
});

describe("the stored skips object is projected, not passed through (review I2)", () => {
  it("refuses, naming crawl and page, a skips object with a key the writer never writes", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, skipsId, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ code: expect.anything() });
    const message = String((error as Error).message);
    expect(message).toContain(skipsId);
    expect(message).toContain(`${SITE}/product`);
    expect(message).toContain("surprise");
  });
});

describe("a Google feature entry without its two lists is unreadable (review I3)", () => {
  it("the listing throws rather than counting the entry as clean", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, malformedId, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(new RegExp(`${malformedId}.*not a BlockValidation`));
  });

  it("the CSV view throws rather than writing the block as clean", async () => {
    // The refusal before the header passes (no blob is null); the row throws.
    await expect(csvLines(malformedId)).rejects.toThrow(/not a BlockValidation/);
  });
});

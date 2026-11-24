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
import { UNRESOLVED_NOT_MEASURED, problemCells } from "../../src/api/structured-data.js";
import { MAX_STRUCTURED_DATA_BLOCKS } from "../../src/crawl/parse/page-analyzer.js";
import { MAX_PROBLEMS_PER_LIST } from "../../src/rules/schema-org/validate.js";
import { issues, metrics } from "../../src/db/schema.js";
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
const oldShapeId = `crawl_sd_listing_old_shape_${runId}`;
const preV4Id = `crawl_sd_listing_pre_v4_${runId}`;
const capId = `crawl_sd_listing_cap_${runId}`;
const orphanId = `crawl_sd_listing_orphan_${runId}`;
const typelessId = `crawl_sd_listing_typeless_${runId}`;
const multiId = `crawl_sd_listing_multi_${runId}`;
const allCrawls = [crawlId, unjudgedId, staleId, skipsId, malformedId, oldShapeId, preV4Id, capId, orphanId, typelessId, multiId];

const PRODUCT = {
  "@context": C,
  "@type": "Product",
  name: "Widget",
  offers: { "@type": "Offer", price: "9.99", priceCurrency: "EUR" },
  // An empty value (a warning) and a reference nothing on the page defines (an info).
  image: "",
  brand: { "@id": "#brand" },
};
const ORGANIZATION = { "@context": C, "@type": "Organization", "@id": "#org", name: "Acme", url: `${SITE}/` };
const ARTICLE = {
  "@context": C,
  "@type": ["Article", "Blorpticle"],
  headline: "Hello",
  fooBar: 1,
  author: { "@type": "Offer", price: "1" },
  // `#org` is defined on /product, not here: references resolve per page.
  publisher: { "@id": "#org" },
  // `#ada` is defined by the Person block on this page: resolved across blocks.
  editor: { "@id": "#ada" },
};
const PERSON = { "@context": C, "@type": "Person", "@id": "#ada", name: "Ada" };
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

/**
 * R0.8, in JS, over what `validateBlock` says — the oracle the SQL must match.
 * A reference is an info only when no block of the same page defines its id.
 */
function warnings(v: BlockValidation): number {
  return v.unknownTypes.length + v.unknownProperties.length + v.typeMismatches.length + v.emptyValues.length;
}
function infos(v: BlockValidation, defined: ReadonlySet<string>): number {
  return v.propertyStatus.length + v.references.filter((r) => !defined.has(r.id)).length;
}
function pageCounts(path: string): { warningCount: number; infoCount: number } {
  const verdicts = BLOCKS.filter((b) => b.path === path).map((b) => validateBlock(b.raw, `${SITE}${b.path}`));
  const defined = new Set(verdicts.flatMap((v) => v.definedIds));
  return {
    warningCount: verdicts.reduce((n, v) => n + warnings(v), 0),
    infoCount: verdicts.reduce((n, v) => n + infos(v, defined), 0),
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

  // Judged, then the Product block's node entry stripped of `properties`:
  // every list is still an array, so only the entry-level check can tell this
  // blob from a clean one.
  await seedCrawl(malformedId);
  await service.runRulesForCrawl(LOCAL_TENANT, malformedId);
  await db.execute(sql`
    update structured_data
       set validation_jsonb = jsonb_set(validation_jsonb, '{nodes,0}',
                                        (validation_jsonb #> '{nodes,0}') - 'properties')
     where id = (select min(id) from structured_data where crawl_id = ${malformedId})`);

  // A crawl not wholly at extraction 4 (/broken read before microdata was):
  // unresolved references are not measured on it, by the rule, the listing or the CSV.
  await seedCrawl(preV4Id);
  await db.execute(sql`
    update pages set extraction_version = 3, structured_data_microdata_errors = null, structured_data_skips = null
     where crawl_id = ${preV4Id} and url = ${`${SITE}/broken`}`);
  await service.runRulesForCrawl(LOCAL_TENANT, preV4Id);

  // A page whose stored blocks reached the analyzer's cap: the Product block's
  // #brand reference, beside enough filler blocks to fill the page.
  const capPages = await seedCrawl(capId);
  for (let i = BLOCKS.filter((b) => b.path === "/product").length; i < MAX_STRUCTURED_DATA_BLOCKS; i += 1) {
    await db.insert(structuredData).values({
      crawlId: capId,
      pageId: capPages.get("/product")!,
      schemaType: "Thing",
      format: "jsonld",
      raw: { "@context": C, "@type": "Thing", name: `filler ${i}` },
    });
  }
  await service.runRulesForCrawl(LOCAL_TENANT, capId);

  // A block whose page row lost the (crawl_id, url) race (src/crawl/persist.ts,
  // `flushPages`): it points at a page id with no row. Judged with it in place.
  await seedCrawl(orphanId);
  await db.insert(structuredData).values({
    crawlId: orphanId,
    pageId: `${orphanId}_lost`,
    schemaType: "Product",
    format: "jsonld",
    raw: { "@context": C, "@type": "Product", name: "", brand: { "@id": "#nowhere" } },
  });
  await service.runRulesForCrawl(LOCAL_TENANT, orphanId);

  // A page whose one node is typed WebPage and FAQPage, and a block with 51
  // empty values (its list stops at the cap).
  const multiPages = await seedCrawl(multiId);
  await db.insert(structuredData).values([
    {
      crawlId: multiId,
      pageId: multiPages.get("/")!,
      schemaType: "WebPage",
      format: "jsonld",
      raw: { "@context": C, "@type": ["WebPage", "FAQPage"], name: "Home" },
    },
    {
      crawlId: multiId,
      pageId: multiPages.get("/")!,
      schemaType: "ItemList",
      format: "jsonld",
      raw: {
        "@context": C,
        "@type": "ItemList",
        itemListElement: Array.from({ length: MAX_PROBLEMS_PER_LIST + 1 }, () => ""),
      },
    },
  ]);
  await service.runRulesForCrawl(LOCAL_TENANT, multiId);

  // Judged, then the Product block's node stripped of `types`: the shape a
  // blob had before the gate fix, which must be refused as old.
  await seedCrawl(typelessId);
  await service.runRulesForCrawl(LOCAL_TENANT, typelessId);
  await db.execute(sql`
    update structured_data
       set validation_jsonb = jsonb_set(validation_jsonb, '{nodes,0}', (validation_jsonb #> '{nodes,0}') - 'types')
     where id = (select min(id) from structured_data where crawl_id = ${typelessId})`);

  // Judged, then the Product block's blob put back in the shape written before
  // the 29a rework: Google lists in, the standards facts out.
  await seedCrawl(oldShapeId);
  await service.runRulesForCrawl(LOCAL_TENANT, oldShapeId);
  await db.execute(sql`
    update structured_data
       set validation_jsonb = (validation_jsonb - 'emptyValues' - 'definedIds' - 'references' - 'nodes')
                              || '{"googleFeatures": [], "deprecatedFeatures": []}'::jsonb
     where id = (select min(id) from structured_data where crawl_id = ${oldShapeId})`);
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
    expect(product).toEqual({
      url: `${SITE}/product`,
      pageType: "product",
      indexable: true,
      formats: ["jsonld", "microdata"],
      types: ["Product", "Organization"],
      nodes: [
        {
          format: "jsonld",
          path: "$",
          type: "Product", types: ["Product"], typesCapped: false,
          properties: ["brand", "image", "name", "offers"],
          propertiesCapped: false,
        },
        { format: "microdata", path: "$", type: "Organization", types: ["Organization"], typesCapped: false, properties: ["name", "url"], propertiesCapped: false },
      ],
      ...pageCounts("/product"),
      jsonLdParseErrors: 0,
      microdataErrors: 0,
      skips: SKIPS,
      infoCountAtLeast: false, blocksAtCap: false, blocksDropped: null, nodesDropped: null, problemsCapped: false,
    });
    // The empty image is the one warning; the unresolved #brand the one info.
    expect(product?.warningCount).toBe(1);
    expect(product?.infoCount).toBe(1);
  });

  it("names exactly the projected keys, in order (no spread of a row)", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    expect(Object.keys(page.items[0]!)).toEqual([
      "url", "pageType", "indexable", "formats", "types", "nodes",
      "warningCount", "infoCount", "infoCountAtLeast", "jsonLdParseErrors", "microdataErrors", "skips", "blocksAtCap", "blocksDropped", "nodesDropped", "problemsCapped",
    ]);
    expect(Object.keys(page.items[0]!.nodes[0]!)).toEqual(["format", "path", "type", "types", "typesCapped", "properties", "propertiesCapped"]);
  });

  it("sums every problem kind across a page's blocks, resolving references per page", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    const article = page.items.find((r) => r.url === `${SITE}/article`);
    // Article: an unknown type, an unknown property and a type mismatch
    // (warnings), and `publisher: #org`, defined on another page only (info).
    // `editor: #ada` is defined by the Person block beside it and resolves.
    expect(article).toMatchObject({
      formats: ["jsonld"],
      types: ["Article", "Blorpticle", "Person", "FAQPage"],
      ...pageCounts("/article"),
    });
    expect(article?.nodes.map((n) => n.type)).toEqual(["Article", "Person", "FAQPage"]);
    expect(article?.warningCount).toBe(3);
    expect(article?.infoCount).toBe(1);
  });

  it("counts a page's parse and microdata errors as warnings, with no blocks at all", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    expect(page.items.find((r) => r.url === `${SITE}/broken`)).toEqual({
      url: `${SITE}/broken`,
      pageType: "blog",
      indexable: true,
      formats: [],
      types: [],
      nodes: [],
      warningCount: 3,
      infoCount: 0,
      jsonLdParseErrors: 2,
      microdataErrors: 1,
      skips: { microdataItemrefSkipped: 0, rdfaUnsupported: 0, valuesCapped: 0 },
      infoCountAtLeast: false, blocksAtCap: false, blocksDropped: null, nodesDropped: null, problemsCapped: false,
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
    expect(lines[0]).toBe("URL,Format,Schema Type,Path,Node Type,Problem,Detail,Blocks Dropped,Nodes Dropped\r\n");
    const P = `${SITE}/product`;
    const A = `${SITE}/article`;
    expect(lines.slice(1)).toEqual(
      [
        [P, "jsonld", "Product", "$.image", "Product", "empty-value", "image is empty"],
        [P, "jsonld", "Product", "$.brand", "", "unresolved-reference", `#brand (${P}#brand) is not defined on this page`],
        [P, "microdata", "Organization", "", "", "", ""],
        [A, "jsonld", "Article|Blorpticle", "$", "Blorpticle", "unknown-type", "Blorpticle is not a schema.org type"],
        [A, "jsonld", "Article|Blorpticle", "$", "Article", "unknown-property", "fooBar is not a property of Article"],
        [
          A, "jsonld", "Article|Blorpticle", "$.author", "Offer", "type-mismatch",
          "author: Offer (expected Organization|Person)",
        ],
        // `#org` is defined on /product only; `#ada` (the Person block below) resolves.
        [A, "jsonld", "Article|Blorpticle", "$.publisher", "", "unresolved-reference", `#org (${A}#org) is not defined on this page`],
        [A, "jsonld", "Person", "", "", "", ""],
        [A, "jsonld", "FAQPage", "", "", "", ""],
      // An extraction-4 page never counted what it dropped: two empty cells.
      ].map((cells) => csvRecord([...cells, "", ""])),
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
    expect(walked).toHaveLength(9);
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

describe("the CSV Detail cells of the standards problems", () => {
  it("an empty value names its property; a reference names its id", () => {
    expect(
      problemCells({ problem: "empty-value", path: "$.offers.price", type: "Offer", property: "price" }, "test"),
    ).toEqual({ path: "$.offers.price", nodeType: "Offer", problem: "empty-value", detail: "price is empty" });
    // An empty value under an untyped node has no type to print.
    expect(
      problemCells({ problem: "empty-value", path: "$.address.streetAddress", type: null, property: "streetAddress" }, "test"),
    ).toMatchObject({ nodeType: "" });
    expect(
      problemCells(
        { problem: "unresolved-reference", path: "$.publisher", id: "https://other.example/#org", written: "https://other.example/#org" },
        "test",
      ),
    ).toEqual({
      path: "$.publisher",
      nodeType: "",
      problem: "unresolved-reference",
      detail: "https://other.example/#org is not defined on this page",
    });
  });

  it("refuses an entry that is not the shape its problem names", () => {
    expect(() => problemCells({ problem: "empty-value", path: "$.x", type: 3, property: "x" }, "row 1")).toThrow(
      /row 1 .*type/,
    );
    expect(() => problemCells({ problem: "unresolved-reference", path: "$.x", written: "#x" }, "row 1")).toThrow(/'id'/);
    expect(() => problemCells({ problem: "google-required", path: "$" }, "row 1")).toThrow(/unknown problem/);
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

describe("a node entry without its property list is unreadable (review I3)", () => {
  // Refused up front since the final review: the shared shape check (staleBlob)
  // covers node entries, so the 409 comes before a row or a byte.
  it("the listing refuses it (409, re-run the rules) rather than counting the entry as clean", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, malformedId, {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(String((error as Error).message)).toMatch(new RegExp(`${malformedId}.*re-run the rules`));
  });

  it("the CSV view refuses it before a byte rather than writing the block as clean", async () => {
    await expect(csvLines(malformedId)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("a blob in the shape written before the 29a rework is refused, never read", () => {
  it("the listing refuses it up front (409) and says to re-run the rules (review M2)", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, oldShapeId, {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(String((error as Error).message)).toMatch(new RegExp(`${oldShapeId}.*re-run the rules \\(crawl_rules\\)`));
  });

  it("the CSV view refuses it before a byte, as the listing does", async () => {
    await expect(csvLines(oldShapeId)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// 29a rework, review fix round 1. Appended so no earlier line moves.
describe("unresolved references are not measured on a crawl not wholly at extraction 4 (review I2)", () => {
  it("the rule, the listing and the CSV agree: none counted, and the listing says why", async () => {
    const found = await db
      .select({ ruleId: issues.ruleId })
      .from(issues)
      .where(and(eq(issues.crawlId, preV4Id), eq(issues.ruleId, "schema.unresolved-reference")));
    expect(found).toEqual([]);

    const page = await service.listStructuredData(LOCAL_TENANT, preV4Id, {});
    expect(page.notMeasured).toEqual([UNRESOLVED_NOT_MEASURED]);
    expect(UNRESOLVED_NOT_MEASURED.id).toBe("schema.unresolved-reference");
    // /product's one info was the unresolved #brand; /article's the unresolved #org.
    expect(page.items.find((r) => r.url === `${SITE}/product`)?.infoCount).toBe(0);
    expect(page.items.find((r) => r.url === `${SITE}/article`)?.infoCount).toBe(0);

    const lines = await csvLines(preV4Id);
    expect(lines.filter((line) => line.includes("unresolved-reference"))).toEqual([]);
    const exported = await service.exportCrawl(LOCAL_TENANT, preV4Id, { format: "csv", view: "structured_data_nodes" });
    expect(exported).toMatchObject({ notMeasured: [UNRESOLVED_NOT_MEASURED] });
  });

  it("on a crawl wholly at extraction 4, nothing is named not measured", async () => {
    expect((await service.listStructuredData(LOCAL_TENANT, crawlId, {})).notMeasured).toEqual([]);
    const exported = await service.exportCrawl(LOCAL_TENANT, crawlId, { format: "csv", view: "structured_data_nodes" });
    expect(exported).toMatchObject({ notMeasured: [] });
  });
});

describe("a page whose stored blocks reached the analyzer's cap (review I3)", () => {
  it("is flagged on the listing and on the finding, which still fires", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, capId, {});
    expect(page.items.find((r) => r.url === `${SITE}/product`)?.blocksAtCap).toBe(true);
    expect(page.items.find((r) => r.url === `${SITE}/article`)?.blocksAtCap).toBe(false);
    const [finding] = await db
      .select({ details: issues.details })
      .from(issues)
      .where(and(eq(issues.crawlId, capId), eq(issues.ruleId, "schema.unresolved-reference"), eq(issues.dedupeKey, `${SITE}/product`)));
    expect(finding?.details).toMatchObject({ blocksAtCap: true, problemCount: 1 });
  });
});

// 29a rework, re-review fix round 2: orphan blocks are skipped, never refused.
describe("a block whose page row does not exist (persist.ts flushPages, by design)", () => {
  it("leaves the orphan unvalidated and every page's block validated", async () => {
    const rows = await db
      .select({ pageId: structuredData.pageId, v: structuredData.validation })
      .from(structuredData)
      .where(eq(structuredData.crawlId, orphanId));
    expect(rows.filter((r) => r.v === null).map((r) => r.pageId)).toEqual([`${orphanId}_lost`]);
    expect(rows.filter((r) => r.v !== null)).toHaveLength(BLOCKS.length);
  });

  it("the rules, the metric, the listing and the CSV answer as for the same crawl without it", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, orphanId, {});
    const clean = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    const strip = (items: typeof page.items) => items.map(({ url, ...rest }) => [url.split("/").pop(), rest]);
    expect(strip(page.items)).toEqual(strip(clean.items));
    expect((await csvLines(orphanId)).slice(1).map((l) => l.replace(SITE, ""))).toEqual(
      (await csvLines(crawlId)).slice(1).map((l) => l.replace(SITE, "")),
    );
    const found = await db
      .select({ ruleId: issues.ruleId, dedupeKey: issues.dedupeKey })
      .from(issues)
      .where(and(eq(issues.crawlId, orphanId), eq(issues.ruleId, "schema.empty-value")));
    expect(found.map((f) => f.dedupeKey)).toEqual([`${SITE}/product`]);
    const coverage = await db
      .select({ scope: metrics.scope, scopeValue: metrics.scopeValue, value: metrics.value })
      .from(metrics)
      .where(and(eq(metrics.crawlId, orphanId), eq(metrics.metricId, "schema.property-coverage")));
    expect(coverage.find((m) => m.scope === "site")?.value).toMatchObject({ nodes: BLOCKS.length });
  });
});

// 29a rework gate fix: nodes list every stated type.
describe("the listing's nodes list every stated type", () => {
  it("an Article also typed Blorpticle lists both, the primary first", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    const article = page.items.find((r) => r.url === `${SITE}/article`);
    expect(article?.nodes[0]).toMatchObject({ type: "Article", types: ["Article", "Blorpticle"] });
  });

  it("a blob whose nodes have no types is old: a 409 up front on the listing and the CSV", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, typelessId, {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(String((error as Error).message)).toContain("re-run the rules (crawl_rules)");
    await expect(csvLines(typelessId)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// 29a rework final review fix wave.
describe("the listing and CSV after the final review", () => {
  it("I2: a page row lists every type its nodes state, in authored order; the CSV Schema Type joins a block's", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, multiId, {});
    const home = page.items.find((r) => r.url === `${SITE}/`);
    expect(home?.types).toEqual(["WebPage", "FAQPage", "ItemList"]);
    const lines = await csvLines(multiId);
    const homeRows = lines.filter((l) => l.startsWith(`${SITE}/,`));
    expect(homeRows[0]).toBe(csvRecord([`${SITE}/`, "jsonld", "WebPage|FAQPage", "", "", "", "", "", ""]));
  });

  it("I1: a page whose block cut a list it counts says problemsCapped; the CSV holds the first MAX per list per block", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, multiId, {});
    const home = page.items.find((r) => r.url === `${SITE}/`);
    expect(home?.problemsCapped).toBe(true);
    expect(home?.warningCount).toBe(MAX_PROBLEMS_PER_LIST);
    const empties = (await csvLines(multiId)).filter((l) => l.startsWith(`${SITE}/,`) && l.includes(",empty-value,"));
    expect(empties).toHaveLength(MAX_PROBLEMS_PER_LIST);
  });
});

// Phase 29d, Task 3: what extraction 5 dropped, on the listing and the CSV.
// Appended so no earlier line moves.
describe("blocksDropped and nodesDropped (29d)", () => {
  const dropId = `crawl_sd_listing_dropped_${runId}`;
  const mixedId = `crawl_sd_listing_dropped_bad_${runId}`;
  const FIVE = { microdataItemrefSkipped: 0, rdfaUnsupported: 0, valuesCapped: 0, blocksDropped: 0, nodesDropped: 0 };

  async function atExtraction5(id: string, product: Record<string, number>): Promise<void> {
    await db.execute(sql`update pages set extraction_version = 5, structured_data_skips = ${JSON.stringify(FIVE)}::jsonb
                          where crawl_id = ${id}`);
    await db.execute(sql`update pages set structured_data_skips = ${JSON.stringify({ ...FIVE, ...product })}::jsonb
                          where crawl_id = ${id} and url = ${`${SITE}/product`}`);
  }

  beforeAll(async () => {
    allCrawls.push(dropId, mixedId);
    // 60 blocks on /product: the analyzer stored 50 and dropped 10.
    const ids = await seedCrawl(dropId);
    for (let i = BLOCKS.filter((b) => b.path === "/product").length; i < MAX_STRUCTURED_DATA_BLOCKS; i += 1) {
      await db.insert(structuredData).values({
        crawlId: dropId, pageId: ids.get("/product")!, schemaType: "Thing", format: "jsonld",
        raw: { "@context": C, "@type": "Thing", name: `filler ${i}` },
      });
    }
    await atExtraction5(dropId, { blocksDropped: 10 });
    await service.runRulesForCrawl(LOCAL_TENANT, dropId);

    // An extraction-5 page whose stored skips are the legacy three keys.
    await seedCrawl(mixedId);
    await service.runRulesForCrawl(LOCAL_TENANT, mixedId);
    await db.execute(sql`update pages set extraction_version = 5 where crawl_id = ${mixedId} and url = ${`${SITE}/product`}`);
  }, 120_000);

  it("an extraction-5 page with 60 blocks lists blocksDropped 10 and nodesDropped 0; blocksAtCap follows blocksDropped", async () => {
    const page = await service.listStructuredData(LOCAL_TENANT, dropId, {});
    const product = page.items.find((r) => r.url === `${SITE}/product`);
    expect(product).toMatchObject({ blocksDropped: 10, nodesDropped: 0, blocksAtCap: true });
    expect(product?.skips).toEqual({ microdataItemrefSkipped: 0, rdfaUnsupported: 0, valuesCapped: 0 });
    const article = page.items.find((r) => r.url === `${SITE}/article`);
    expect(article).toMatchObject({ blocksDropped: 0, nodesDropped: 0, blocksAtCap: false });
  });

  it("on an extraction-5 page, blocksAtCap is blocksDropped > 0 even when the stored count is at the cap", async () => {
    await db.execute(sql`update pages set structured_data_skips = structured_data_skips || '{"blocksDropped": 0}'::jsonb
                          where crawl_id = ${dropId} and url = ${`${SITE}/product`}`);
    const product = (await service.listStructuredData(LOCAL_TENANT, dropId, {})).items.find((r) => r.url === `${SITE}/product`);
    // 50 blocks are stored, yet nothing was dropped: the cap was reached, not exceeded.
    expect(product).toMatchObject({ blocksDropped: 0, blocksAtCap: false });
    await db.execute(sql`update pages set structured_data_skips = structured_data_skips || '{"blocksDropped": 10}'::jsonb
                          where crawl_id = ${dropId} and url = ${`${SITE}/product`}`);
  });

  it("an extraction-4 page lists both as null and keeps blocksAtCap as the stored count gives it", async () => {
    const capped = await service.listStructuredData(LOCAL_TENANT, capId, {});
    expect(capped.items.find((r) => r.url === `${SITE}/product`)).toMatchObject({ blocksDropped: null, nodesDropped: null, blocksAtCap: true });
    const plain = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    expect(plain.items.find((r) => r.url === `${SITE}/product`)).toMatchObject({ blocksDropped: null, nodesDropped: null, blocksAtCap: false });
  });

  it("an extraction-5 page whose skips lack the drop keys is a loud error naming the page, never null or 0", async () => {
    const error = await service.listStructuredData(LOCAL_TENANT, mixedId, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = String((error as Error).message);
    expect(message).toContain(mixedId);
    expect(message).toContain(`${SITE}/product`);
    expect(message).toContain("blocksDropped");
  });

  it("an extraction-4 page that holds the drop keys is a loud error too", async () => {
    await db.execute(sql`update pages set extraction_version = 4 where crawl_id = ${mixedId}`);
    await db.execute(sql`update pages set structured_data_skips = ${JSON.stringify(FIVE)}::jsonb
                          where crawl_id = ${mixedId} and url = ${`${SITE}/product`}`);
    const error = await service.listStructuredData(LOCAL_TENANT, mixedId, {}).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain(`${SITE}/product`);
    expect(String((error as Error).message)).toContain("blocksDropped");
  });

  it("the CSV carries both columns, filled on an extraction-5 page and empty for null", async () => {
    const five = await csvLines(dropId);
    const productRows = five.filter((l) => l.startsWith(`${SITE}/product,`));
    expect(productRows.length).toBeGreaterThan(0);
    for (const row of productRows) expect(row.endsWith(",10,0\r\n")).toBe(true);
    const articleRows = five.filter((l) => l.startsWith(`${SITE}/article,`));
    for (const row of articleRows) expect(row.endsWith(",0,0\r\n")).toBe(true);
    const four = await csvLines(crawlId);
    for (const row of four.slice(1)) expect(row.endsWith(",,\r\n")).toBe(true);
  });
});

// Phase 29d, Task 4: unresolved references past the 50th are counted. Appended so no earlier line moves.
describe("unresolved references past the 50th (29d)", () => {
  const manyId = `crawl_sd_listing_unresolved_${runId}`;

  beforeAll(async () => {
    allCrawls.push(manyId);
    const ids = await seedCrawl(manyId);
    // "/": 59 resolved references, then one that is not. "/article": 70 that are not.
    await db.insert(structuredData).values([
      {
        crawlId: manyId, pageId: ids.get("/")!, schemaType: "ItemList", format: "jsonld",
        raw: {
          "@context": C, "@type": "ItemList",
          hasPart: Array.from({ length: 59 }, (_, i) => ({ "@id": `#part${i}`, "@type": "WebPage" })),
          itemListElement: [...Array.from({ length: 59 }, (_, i) => ({ "@id": `#part${i}` })), { "@id": "#nowhere" }],
        },
      },
      {
        crawlId: manyId, pageId: ids.get("/article")!, schemaType: "ItemList", format: "jsonld",
        raw: { "@context": C, "@type": "ItemList", itemListElement: Array.from({ length: 70 }, (_, i) => ({ "@id": `#gone${i}` })) },
      },
    ]);
    await service.runRulesForCrawl(LOCAL_TENANT, manyId);
  }, 120_000);

  it("counts the 60th reference and the 70 unresolved ones exactly; problemsCapped only past 50", async () => {
    const many = await service.listStructuredData(LOCAL_TENANT, manyId, {});
    const base = await service.listStructuredData(LOCAL_TENANT, crawlId, {});
    // "/" holds only the first block; "/article" holds the shared seed's blocks too.
    expect(many.items.find((r) => r.url === `${SITE}/`)!.infoCount).toBe(1);
    expect(many.items.find((r) => r.url === `${SITE}/article`)!.infoCount).toBe(
      base.items.find((r) => r.url === `${SITE}/article`)!.infoCount + 70,
    );
    expect(many.items.find((r) => r.url === `${SITE}/`)!.problemsCapped).toBe(false);
    expect(many.items.find((r) => r.url === `${SITE}/article`)!.problemsCapped).toBe(true);
  });
});

// Phase 29d, Task 4 fix round 1: the page-level count is exact across blocks, and rule, listing and CSV agree.
describe("unresolved references across blocks of one page (29d)", () => {
  const refsTo = (ids: string[]) => ({
    "@context": C, "@type": "ItemList", itemListElement: ids.map((id) => ({ "@id": id })),
  });
  const defining = (ids: string[]) => ({
    "@context": C, "@type": "ItemList", hasPart: ids.map((id) => ({ "@id": id, "@type": "WebPage" })),
  });
  const ids = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => `#e${from + i}`);

  /** A crawl whose "/" holds exactly these blocks; answers its listing row, and its unresolved CSV rows. */
  async function scenario(name: string, raws: Record<string, unknown>[]) {
    const id = `crawl_sd_listing_xblock_${name}_${runId}`;
    allCrawls.push(id);
    const pageIds = await seedCrawl(id);
    for (const raw of raws) {
      await db.insert(structuredData).values({
        crawlId: id, pageId: pageIds.get("/")!, schemaType: "ItemList", format: "jsonld", raw,
      });
    }
    await service.runRulesForCrawl(LOCAL_TENANT, id);
    const row = (await service.listStructuredData(LOCAL_TENANT, id, {})).items.find((r) => r.url === `${SITE}/`)!;
    const csv = (await csvLines(id)).filter((l) => l.startsWith(`${SITE}/,`) && l.includes(",unresolved-reference,"));
    return { row, csv };
  }

  it("51 references all defined by another block: infoCount 0, not capped, no rows", async () => {
    const { row, csv } = await scenario("alldef", [refsTo(ids(0, 51)), defining(ids(0, 51))]);
    expect(row).toMatchObject({ infoCount: 0, problemsCapped: false });
    expect(csv).toEqual([]);
  });

  it("70 references with 30 defined elsewhere: exactly 40, not capped, 40 CSV rows", async () => {
    const { row, csv } = await scenario("forty", [refsTo(ids(0, 70)), defining(ids(0, 30))]);
    expect(row).toMatchObject({ infoCount: 40, problemsCapped: false });
    expect(csv).toHaveLength(40);
  });

  it("120 unresolved: counted exactly, capped, a CSV row for each; the path is named missing past the first 50", async () => {
    const { row, csv } = await scenario("many", [refsTo(ids(0, 120))]);
    expect(row).toMatchObject({ infoCount: 120, problemsCapped: true });
    expect(csv).toHaveLength(120);
    expect(csv.filter((l) => l.includes("(path not recorded)"))).toHaveLength(70);
  });

  it("an amplification page: the listing says infoCountAtLeast, the CSV rows say the list is incomplete", async () => {
    const base = `${SITE}/${"x".repeat(1500)}/`;
    const { row, csv } = await scenario("amp", [
      { "@context": [C, { "@base": base }], "@type": "ItemList", itemListElement: ids(0, 5000).map((id) => ({ "@id": id })) },
    ]);
    expect(row).toMatchObject({ infoCountAtLeast: true, problemsCapped: true });
    expect(row.infoCount).toBeGreaterThan(MAX_PROBLEMS_PER_LIST);
    expect(row.infoCount).toBeLessThan(5000);
    expect(csv.length).toBe(row.infoCount);
    expect(csv.every((l) => l.includes("the list is incomplete"))).toBe(true);
  });

  it("a normal page says infoCountAtLeast false and its rows carry no incomplete note", async () => {
    const { row, csv } = await scenario("normal", [refsTo(ids(0, 3))]);
    expect(row).toMatchObject({ infoCount: 3, infoCountAtLeast: false });
    expect(csv.some((l) => l.includes("the list is incomplete"))).toBe(false);
  });

  it("a verdict written when unresolved was cut at 50 (count 70, 50 listed) is refused: 409 from the listing and the CSV", async () => {
    const id = `crawl_sd_listing_cut50_${runId}`;
    allCrawls.push(id);
    const pageIds = await seedCrawl(id);
    await db.insert(structuredData).values({
      crawlId: id, pageId: pageIds.get("/")!, schemaType: "ItemList", format: "jsonld", raw: refsTo(ids(0, 70)),
    });
    await service.runRulesForCrawl(LOCAL_TENANT, id);
    // As 48d70b6 wrote it: no idsTruncated, unresolved cut at 50 beside a count of 70.
    await db.execute(sql`
      update structured_data
         set validation_jsonb = jsonb_set(validation_jsonb - 'idsTruncated', '{unresolved}',
               (select jsonb_agg(x) from (select x from jsonb_array_elements(validation_jsonb -> 'unresolved') x limit 50) t))
       where crawl_id = ${id}`);
    const error = await service.listStructuredData(LOCAL_TENANT, id, {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(String((error as Error).message)).toMatch(/re-run the rules/);
    await expect(csvLines(id)).rejects.toMatchObject({ code: "CONFLICT" });
    // The same cut with the flag present (count above the list, flag false) is refused too.
    await db.execute(sql`update structured_data set validation_jsonb = validation_jsonb || '{"idsTruncated": false}'::jsonb where crawl_id = ${id}`);
    await expect(service.listStructuredData(LOCAL_TENANT, id, {})).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

/**
 * `crawl_diff` (Phase 29c T7, rulings R9-R11): a field-level diff of two judged
 * crawls of one site, over stored facts only. Two crawls are written by hand
 * (rows straight into `pages`, `rules_run_at` set), so every changed and
 * notComparable count below is derived from this file's fixture, not read off
 * the implementation.
 *
 * Common URLs (19), by what differs between base and head. Everything not named
 * is equal: 200 / ok / indexable, extraction 4, inlinks 5, link score 30,
 * click depth 2, word count 400, the clean title / description / h1 / canonical.
 *
 *   /same        nothing
 *   /status      200 ok  -> 410 client_error, indexable true -> false, link score 30 -> null
 *   /gone        404 client_error -> 200 ok, indexable false -> true, link score null -> 30
 *   /title       title differs
 *   /meta        meta description differs
 *   /h1          h1 text differs
 *   /canon       canonical header null -> an address
 *   /robots-old  meta robots null -> noindex, BASE row is extraction 1
 *   /robots-new  meta robots null -> noindex, both extraction 4
 *   /wc19        word count 100 -> 119   (19% < 20%: unchanged at the default)
 *   /wc21        word count 100 -> 121   (21% > 20%: changed)
 *   /schema      schema types [Product] -> [Offer, Product]
 *   /in16        inlinks 10 -> 16        (delta 6 >= 5 and 60% > 50%: changed)
 *   /in5         inlinks 2 -> 5          (delta 3 < 5: unchanged)
 *   /depth       click depth 2 -> null   (unreachable: changed)
 *   /ls49        link score 40 -> 49     (delta 9 < 10: unchanged)
 *   /ls50        link score 40 -> 50     (delta 10 >= 10: changed)
 *   /Page, /page two distinct urls sharing url_normalised, identical in both
 * base only: /old.   head only: /new.   => common 19, added 1, removed 1,
 * base.pages 20, head.pages 20.
 *
 * Expected, per field. Content fields are not comparable on a pair where either
 * side is not fetch_class ok: /status and /gone, 2 in every content field.
 *
 *   status           changed 2 (/status, /gone)            notComparable 0
 *   fetchClass       changed 2 (same two)                  notComparable 0
 *   indexable        changed 2 (same two)                  notComparable 0
 *   title            changed 1 (/title)                    notComparable 2
 *   metaDescription  changed 1 (/meta)                     notComparable 2
 *   h1               changed 1 (/h1)                       notComparable 2
 *   canonical        changed 1 (/canon)                    notComparable 2
 *   metaRobots       changed 1 (/robots-new)               notComparable 3 (2 + /robots-old, extraction 1 < 2)
 *   wordCount        changed 1 (/wc21)                     notComparable 2
 *   schemaTypes      changed 1 (/schema)                   notComparable 3 (2 + /robots-old, extraction 1 < 4)
 *   inlinks          changed 1 (/in16)                     notComparable 0
 *   clickDepth       changed 1 (/depth)                    notComparable 0
 *   linkScore        changed 3 (/ls50, /status: scored on
 *                    one side only, /gone: newly scored)   notComparable 0
 *
 * wordCountChangePct 10: /wc19 (19% > 10%) and /wc21 both change -> 2.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { DIFF_FIELD_NAMES, DIFF_FIELDS, parseDiffThresholds } from "../../src/api/crawl-diff.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { ApiService, ServiceError } from "../../src/api/service.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, structuredData } from "../../src/db/schema.js";
import { EXTRACTION_VERSION } from "../../src/crawl/versions.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { LOCAL_TENANT, parseTenant } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";
import type { PageRecord } from "../../src/rules/registry/types.js";

const TOKEN = "test-token-crawl-diff-0123456789012345";
const SITE = "https://diff.example";
const OTHER_SITE = "https://elsewhere.example";
const runId = randomUUID();
const baseId = `crawl_diff_base_${runId}`;
const headId = `crawl_diff_head_${runId}`;
const legacyId = `crawl_diff_legacy_${runId}`;
const unjudgedId = `crawl_diff_unjudged_${runId}`;
const elsewhereId = `crawl_diff_else_${runId}`;
const OTHER = parseTenant(`other-${runId.slice(0, 8)}`);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let exportDir: string;
let service: ApiService;
let api: ApiServer;
let base: string;
let mcp: AriadneMcpServer;
let client: Client;

type Side = "base" | "head";
type Overrides = Partial<PageRecord>;
interface Spec {
  path: string;
  /** Overrides applied to the base row / the head row; absent side = absent page. */
  base?: Overrides;
  head?: Overrides;
  types?: { base?: string[]; head?: string[] };
}

const OLD_ROBOTS = "noindex";
const GONE: Overrides = { statusCode: 404, fetchClass: "client_error", isIndexable: false, linkScore: null };
const SPECS: Spec[] = [
  { path: "/same", base: {}, head: {} },
  { path: "/status", base: {}, head: { statusCode: 410, fetchClass: "client_error", isIndexable: false, linkScore: null } },
  { path: "/gone", base: GONE, head: {} },
  { path: "/title", base: {}, head: { title: "A different page title entirely" } },
  { path: "/meta", base: {}, head: { metaDescription: "A different description of the page." } },
  { path: "/h1", base: {}, head: { h1Text: "A different heading" } },
  { path: "/canon", base: {}, head: { canonicalHeader: `${SITE}/elsewhere` } },
  { path: "/robots-old", base: { extractionVersion: 1 }, head: { robotsMeta: OLD_ROBOTS } },
  { path: "/robots-new", base: {}, head: { robotsMeta: OLD_ROBOTS } },
  { path: "/wc19", base: { wordCount: 100 }, head: { wordCount: 119 } },
  { path: "/wc21", base: { wordCount: 100 }, head: { wordCount: 121 } },
  { path: "/schema", base: {}, head: {}, types: { base: ["Product"], head: ["Product", "Offer"] } },
  { path: "/in16", base: { inlinksInternal: 10 }, head: { inlinksInternal: 16 } },
  { path: "/in5", base: { inlinksInternal: 2 }, head: { inlinksInternal: 5 } },
  { path: "/depth", base: {}, head: { clickDepth: null } },
  { path: "/ls49", base: { linkScore: 40 }, head: { linkScore: 49 } },
  { path: "/ls50", base: { linkScore: 40 }, head: { linkScore: 50 } },
  { path: "/Page", base: {}, head: {} },
  { path: "/page", base: {}, head: {} },
  { path: "/old", base: {} },
  { path: "/new", head: {} },
];

const url = (path: string): string => `${SITE}${path}`;

async function seed(id: string, side: Side, opts: { site?: string; judged?: boolean; legacy?: boolean } = {}): Promise<void> {
  const site = opts.site ?? SITE;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT, id, siteUrl: `${site}/`, hostKey: hostKeyOf(`${site}/`),
    config: { siteUrl: `${site}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(), rulesetVersion: "test", status: "finished",
    pagesCrawled: SPECS.length, robotsBlockedDropped: 0,
    ...(opts.judged === false ? {} : { rulesRunAt: new Date() }),
  });
  const rows: PageRecord[] = [];
  const types: { crawlId: string; pageId: string; schemaType: string; format: "jsonld"; raw: object }[] = [];
  for (const spec of SPECS) {
    const overrides = spec[side];
    if (overrides === undefined) continue;
    const pageId = `page_${randomUUID()}`;
    rows.push(
      mkPage({
        id: pageId, crawlId: id, url: `${site}${spec.path}`, urlNormalised: `${site}${spec.path.toLowerCase()}`,
        extractionVersion: EXTRACTION_VERSION,
        inlinksInternal: opts.legacy ? null : 5,
        linkScore: opts.legacy ? null : 30,
        ...overrides,
        ...(opts.legacy ? { inlinksInternal: null, linkScore: null } : {}),
      }),
    );
    for (const t of spec.types?.[side] ?? []) {
      types.push({ crawlId: id, pageId, schemaType: t, format: "jsonld", raw: {} });
    }
  }
  await db.insert(pages).values(rows);
  if (types.length > 0) await db.insert(structuredData).values(types);
}

type Body = Record<string, unknown>;
async function http(path: string, tenant: string = LOCAL_TENANT): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": tenant },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ error: boolean; body: Body }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  return { error: result.isError === true, body: JSON.parse(text) as Body };
}

interface FieldCount { field: string; changed: number; notComparable: number }
const fieldsOf = (b: Body): Map<string, FieldCount> =>
  new Map((b["fields"] as FieldCount[]).map((f) => [f.field, f]));

async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error("expected a ServiceError, the call answered");
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-diff-"));
  const config: ServiceConfig = {
    credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], exportDir, log: () => {},
  };
  service = new ApiService(db, config);
  api = createApiServer({ db, config: { ...config, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  mcp = createMcpServer({ db, config: { ...config, tenant: LOCAL_TENANT } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-diff", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  await seed(baseId, "base");
  await seed(headId, "head");
  await seed(legacyId, "base", { legacy: true });
  await seed(unjudgedId, "head", { judged: false });
  await seed(elsewhereId, "head", { site: OTHER_SITE });
}, 60_000);

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await service.close();
  for (const id of [baseId, headId, legacyId, unjudgedId, elsewhereId]) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
});

describe("crawl_diff counts", () => {
  it("answers the url sets, both sides and the echoed defaults", async () => {
    const { body } = await tool("crawl_diff", { baseCrawlId: baseId, headCrawlId: headId });
    expect(body["urls"]).toEqual({ common: 19, added: 1, removed: 1 });
    expect(body["base"]).toMatchObject({ crawlId: baseId, siteUrl: `${SITE}/`, pages: 20 });
    expect(body["head"]).toMatchObject({ crawlId: headId, siteUrl: `${SITE}/`, pages: 20 });
    expect(typeof (body["base"] as Body)["rulesRunAt"]).toBe("string");
    expect(body["thresholds"]).toEqual({
      wordCountChangePct: 20, inlinksChangePct: 50, inlinksChangeMin: 5, linkScoreChangePoints: 10,
    });
  });

  it("lists every field in DIFF_FIELD_NAMES order", async () => {
    const { body } = await tool("crawl_diff", { baseCrawlId: baseId, headCrawlId: headId });
    expect((body["fields"] as FieldCount[]).map((f) => f.field)).toEqual([...DIFF_FIELD_NAMES]);
    expect(DIFF_FIELDS.map((f) => f.name)).toEqual([...DIFF_FIELD_NAMES]);
    expect([...DIFF_FIELD_NAMES]).toEqual([
      "status", "fetchClass", "indexable", "title", "metaDescription", "h1", "canonical",
      "metaRobots", "wordCount", "schemaTypes", "inlinks", "clickDepth", "linkScore",
    ]);
  });

  it("counts changed and notComparable per field as the fixture header derives", async () => {
    const { body } = await tool("crawl_diff", { baseCrawlId: baseId, headCrawlId: headId });
    const f = fieldsOf(body);
    const want: Record<string, [number, number]> = {
      status: [2, 0], fetchClass: [2, 0], indexable: [2, 0],
      title: [1, 2], metaDescription: [1, 2], h1: [1, 2], canonical: [1, 2],
      metaRobots: [1, 3], wordCount: [1, 2], schemaTypes: [1, 3],
      inlinks: [1, 0], clickDepth: [1, 0], linkScore: [3, 0],
    };
    for (const [field, [changed, notComparable]] of Object.entries(want)) {
      expect(f.get(field), field).toEqual({ field, changed, notComparable });
    }
  });

  it("pairs /Page with /page by url, never reporting one removed and one added", async () => {
    // Both exist in both crawls and share url_normalised: added and removed are
    // only /new and /old.
    const { body } = await tool("crawl_diff", { baseCrawlId: baseId, headCrawlId: headId });
    expect(body["urls"]).toMatchObject({ added: 1, removed: 1 });
  });

  it("does not read an absent page as a change in any field", async () => {
    // /old and /new are in one crawl only: the field counts above (status 2)
    // exclude them, so a 'removed' page is never also a status change.
    const f = fieldsOf((await tool("crawl_diff", { baseCrawlId: baseId, headCrawlId: headId })).body);
    expect(f.get("status")?.changed).toBe(2);
  });
});

describe("crawl_diff thresholds", () => {
  it("wordCountChangePct 10 counts 100 -> 119, and is echoed", async () => {
    const { body } = await tool("crawl_diff", { baseCrawlId: baseId, headCrawlId: headId, wordCountChangePct: 10 });
    expect(fieldsOf(body).get("wordCount")).toEqual({ field: "wordCount", changed: 2, notComparable: 2 });
    expect(body["thresholds"]).toMatchObject({ wordCountChangePct: 10 });
  });

  it("inlinksChangeMin 3 counts 2 -> 5 as well, linkScoreChangePoints 9 counts 40 -> 49", async () => {
    const { body } = await tool("crawl_diff", {
      baseCrawlId: baseId, headCrawlId: headId, inlinksChangeMin: 3, linkScoreChangePoints: 9,
    });
    // /in5: delta 3 >= 3 and 300 > 50 * 2 = 100: changed, with /in16.
    expect(fieldsOf(body).get("inlinks")?.changed).toBe(2);
    // /ls49 joins /ls50, /status and /gone.
    expect(fieldsOf(body).get("linkScore")?.changed).toBe(4);
  });

  it("refuses a value out of range or not an integer, naming the parameter", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ wordCountChangePct: 0 }, "wordCountChangePct"],
      [{ wordCountChangePct: "abc" }, "wordCountChangePct"],
      [{ wordCountChangePct: 1001 }, "wordCountChangePct"],
      [{ inlinksChangePct: 1.5 }, "inlinksChangePct"],
      [{ inlinksChangeMin: 100001 }, "inlinksChangeMin"],
      [{ linkScoreChangePoints: 101 }, "linkScoreChangePoints"],
    ];
    for (const [raw, name] of cases) {
      const e = await refusal(service.crawlDiff(LOCAL_TENANT, baseId, headId, raw as never));
      expect(e.code, name).toBe("VALIDATION");
      expect(e.message, name).toContain(name);
      expect(() => parseDiffThresholds(raw as never)).toThrow(name);
    }
  });

  it("refuses over both transports", async () => {
    const t = await tool("crawl_diff", { baseCrawlId: baseId, headCrawlId: headId, wordCountChangePct: 0 });
    expect(t.error).toBe(true);
    expect(t.body).toMatchObject({ code: "VALIDATION" });
    const h = await http(`/diff?baseCrawlId=${baseId}&headCrawlId=${headId}&wordCountChangePct=0`);
    expect(h.status).toBe(400);
    expect(h.body).toMatchObject({ code: "VALIDATION" });
    expect(JSON.stringify(h.body)).toContain("wordCountChangePct");
  });
});

describe("a crawl judged before 29c (Review Focus 1)", () => {
  it("reports inlinks and linkScore as not comparable on every common url, never unchanged", async () => {
    const { body } = await tool("crawl_diff", { baseCrawlId: legacyId, headCrawlId: headId });
    // The legacy crawl carries the same 19 + /old urls as base: common 19.
    expect(body["urls"]).toEqual({ common: 19, added: 1, removed: 1 });
    const f = fieldsOf(body);
    expect(f.get("inlinks")).toEqual({ field: "inlinks", changed: 0, notComparable: 19 });
    expect(f.get("linkScore")).toEqual({ field: "linkScore", changed: 0, notComparable: 19 });
    // The other fields are still answered.
    expect(f.get("status")?.changed).toBe(2);
  });
});

describe("refusals", () => {
  it("refuses a head that has never been judged (also what a rules run in flight looks like)", async () => {
    const e = await refusal(service.crawlDiff(LOCAL_TENANT, baseId, unjudgedId));
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("never been judged");
    expect(e.message).toContain(unjudgedId);
  });

  it("refuses two different sites", async () => {
    const e = await refusal(service.crawlDiff(LOCAL_TENANT, baseId, elsewhereId));
    expect(e.code).toBe("VALIDATION");
  });

  it("refuses the same crawl twice", async () => {
    const e = await refusal(service.crawlDiff(LOCAL_TENANT, baseId, baseId));
    expect(e.code).toBe("VALIDATION");
  });

  it("answers a foreign tenant exactly as a crawl that does not exist", async () => {
    const foreign = await refusal(service.crawlDiff(OTHER, baseId, headId));
    expect(foreign.code).toBe("NOT_FOUND");
    // The other tenant sees neither crawl: the same answer as two ids that do not exist.
    const missingBase = `crawl_${randomUUID()}`;
    const missingHead = `crawl_${randomUUID()}`;
    const absent = await refusal(service.crawlDiff(LOCAL_TENANT, missingBase, missingHead));
    expect(absent.code).toBe("NOT_FOUND");
    expect(foreign.message.replaceAll(baseId, "X").replaceAll(headId, "Y")).toBe(
      absent.message.replaceAll(missingBase, "X").replaceAll(missingHead, "Y"),
    );
  });
});

describe("transports", () => {
  it("GET /diff answers what crawl_diff answers", async () => {
    const q = `baseCrawlId=${baseId}&headCrawlId=${headId}&wordCountChangePct=10&inlinksChangeMin=3`;
    const h = await http(`/diff?${q}`);
    const t = await tool("crawl_diff", {
      baseCrawlId: baseId, headCrawlId: headId, wordCountChangePct: 10, inlinksChangeMin: 3,
    });
    expect(h.status).toBe(200);
    expect(h.body).toEqual(t.body);
  });
});

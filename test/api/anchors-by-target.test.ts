/**
 * The `anchors_by_target` listing (Phase 29c T6, CHECK-86, ruling R6): tool,
 * route and CSV view over one judged fixture site.
 *
 *   /target (content)  linked from s1..s7, one link each:
 *                      "Blue widgets" x3, "blue  WIDGETS" x1, "Red" x1,
 *                      "click here" x1, "" x1
 *   /t2 (product)      s1 links TWICE, "Click Here" and "click  here" (one source,
 *                      one anchor once normalised); s2 links with "" AND "read more"
 *   /t3 (untyped)      /target links with a null anchor; /t3 links to itself
 *   /lonely            nothing links to it
 *
 * Every count is in DISTINCT SOURCE PAGES (`src/api/anchors.ts`).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ANCHORS_TOP_N } from "../../src/api/anchors.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { ApiService, ServiceError } from "../../src/api/service.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { LOCAL_TENANT, parseTenant } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";

const TOKEN = "test-token-anchors-by-target-0123456789";
const SITE = "https://anchors.example";
const runId = randomUUID();
const judgedId = `crawl_anchors_${runId}`;
const legacyId = `crawl_anchors_legacy_${runId}`;
const unjudgedId = `crawl_anchors_unjudged_${runId}`;
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

const url = (path: string): string => `${SITE}${path}`;

type Edge = [from: string, to: string, anchor: string | null];

const SOURCES = ["/s1", "/s2", "/s3", "/s4", "/s5", "/s6", "/s7"];
const TARGET_ANCHORS = ["Blue widgets", "Blue widgets", "Blue widgets", "blue  WIDGETS", "Red", "click here", ""];
const EDGES: Edge[] = [
  ...SOURCES.map((s, i): Edge => [s, "/target", TARGET_ANCHORS[i] ?? null]),
  ["/s1", "/t2", "Click Here"],
  ["/s1", "/t2", "click  here"],
  ["/s2", "/t2", ""],
  ["/s2", "/t2", "read more"],
  ["/target", "/t3", null],
  ["/t3", "/t3", "self link"],
];
const PATHS = [...SOURCES, "/target", "/t2", "/t3", "/lonely"];

async function seed(id: string, judge: boolean): Promise<void> {
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT, id, siteUrl: `${SITE}/`, hostKey: hostKeyOf(`${SITE}/`),
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(), rulesetVersion: "test", status: "finished",
    pagesCrawled: PATHS.length, robotsBlockedDropped: 0,
  });
  const ids = new Map(PATHS.map((p) => [p, `page_${randomUUID()}`]));
  const typeOf = (p: string): string | null => (p === "/t2" ? "product" : p === "/t3" ? null : "content");
  await db.insert(pages).values(
    PATHS.map((path, i) =>
      mkPage({
        id: ids.get(path)!, crawlId: id, url: url(path), urlNormalised: url(path), pageType: typeOf(path),
        ...(i === 0 ? { depth: 0, clickDepth: 0, discoveredVia: "seed" } : {}),
      }),
    ),
  );
  await db.insert(links).values(
    EDGES.map(([from, to, anchor], position) => ({
      crawlId: id, sourcePageId: ids.get(from)!, targetUrl: url(to), targetPageId: null,
      anchor, rel: null, isInternal: true, isNofollow: false, position,
    })),
  );
  if (judge) await service.runRulesForCrawl(LOCAL_TENANT, id);
}

async function http(path: string, tenant: string = LOCAL_TENANT): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": tenant },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ error: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  return { error: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

type Row = Record<string, unknown>;
const items = (b: Record<string, unknown>): Row[] => b["items"] as Row[];
const byPath = (rows: Row[]): Map<string, Row> =>
  new Map(rows.map((r) => [String(r["url"]).slice(SITE.length), r]));

async function csvRecords(id: string): Promise<string[]> {
  const stream = await service.prepareCsvExport(LOCAL_TENANT, id, { view: "anchors_by_target" });
  const out: string[] = [];
  for await (const record of stream.records()) out.push(record);
  return out;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-anchors-"));
  const config: ServiceConfig = {
    credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], exportDir, log: () => {},
  };
  service = new ApiService(db, config);
  api = createApiServer({ db, config: { ...config, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  mcp = createMcpServer({ db, config: { ...config, tenant: LOCAL_TENANT } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-anchors", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  await seed(judgedId, true);
  await seed(legacyId, true);
  // Judged before 29c: the counts null, rules_run_at kept.
  await db.update(pages).set({ inlinksInternal: null }).where(eq(pages.crawlId, legacyId));
  await seed(unjudgedId, false);
}, 60_000);

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await service.close();
  for (const id of [judgedId, legacyId, unjudgedId]) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
});

describe("anchors_by_target rows", () => {
  it("answers the brief's fixture: 7 inlinks, 4 distinct anchors, the top list and the share", async () => {
    const rows = byPath(items((await tool("anchors_by_target", { crawlId: judgedId })).body));
    expect(rows.get("/target")).toEqual({
      url: url("/target"),
      pageType: "content",
      inlinks: 7,
      distinctAnchors: 4,
      topAnchors: [
        { text: "blue widgets", count: 4 },
        { text: "click here", count: 1 },
        { text: "red", count: 1 },
      ],
      emptyAnchors: 1,
      nonDescriptiveAnchors: 1,
      genericShare: 0.2857,
    });
  });

  it("lists only pages with internal inlinks, ordered by url", async () => {
    const rows = items((await tool("anchors_by_target", { crawlId: judgedId })).body);
    expect(rows.map((r) => String(r["url"]).slice(SITE.length))).toEqual(["/t2", "/t3", "/target"]);
  });

  it("inlinks equals pages.inlinks_internal, and a self-link is not an inlink", async () => {
    const stored = await db.select({ url: pages.url, n: pages.inlinksInternal }).from(pages).where(eq(pages.crawlId, judgedId));
    const want = new Map(stored.map((r) => [r.url.slice(SITE.length), r.n]));
    const rows = byPath(items((await tool("anchors_by_target", { crawlId: judgedId })).body));
    for (const [path, row] of rows) expect(row["inlinks"], path).toBe(want.get(path));
    // /t3's only inlink is /target's; its own link to itself is excluded.
    expect(rows.get("/t3")).toMatchObject({ inlinks: 1 });
  });

  it("counts distinct source pages: one source linking twice with one anchor counts once", async () => {
    const rows = byPath(items((await tool("anchors_by_target", { crawlId: judgedId })).body));
    // s1 links to /t2 twice ("Click Here", "click  here") and s2 twice ("" and "read more").
    expect(rows.get("/t2")).toMatchObject({
      pageType: "product",
      inlinks: 2,
      distinctAnchors: 3,
      topAnchors: [{ text: "click here", count: 1 }, { text: "read more", count: 1 }],
      emptyAnchors: 1,
      nonDescriptiveAnchors: 2,
    });
  });

  it("keeps genericShare at or below 1 when a source mixes empty and generic links", async () => {
    const rows = byPath(items((await tool("anchors_by_target", { crawlId: judgedId })).body));
    // empty + nonDescriptive over inlinks would be 3 / 2.
    expect(rows.get("/t2")?.["genericShare"]).toBe(1);
    for (const row of rows.values()) expect(row["genericShare"] as number).toBeLessThanOrEqual(1);
  });

  it("reads a null anchor as empty, and an untyped target has a null pageType", async () => {
    const rows = byPath(items((await tool("anchors_by_target", { crawlId: judgedId })).body));
    expect(rows.get("/t3")).toEqual({
      url: url("/t3"), pageType: null, inlinks: 1, distinctAnchors: 1, topAnchors: [],
      emptyAnchors: 1, nonDescriptiveAnchors: 0, genericShare: 1,
    });
  });

  it("lists at most the top N anchors", () => {
    expect(ANCHORS_TOP_N).toBe(5);
  });
});

describe("anchors_by_target paging and filters", () => {
  it("a cursor walk returns every row exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pagesRead = 0;
    do {
      const res = await service.listAnchorsByTarget(LOCAL_TENANT, judgedId, { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...res.items.map((r) => r.url.slice(SITE.length)));
      cursor = res.nextCursor ?? undefined;
      pagesRead++;
    } while (cursor !== undefined && pagesRead < 10);
    expect(seen).toEqual(["/t2", "/t3", "/target"]);
    expect(pagesRead).toBe(3);
  });

  it("filters by pageType, (untyped) included, and refuses a cohort that names no page", async () => {
    const product = items((await tool("anchors_by_target", { crawlId: judgedId, pageType: "product" })).body);
    expect(product.map((r) => String(r["url"]).slice(SITE.length))).toEqual(["/t2"]);
    const untyped = items((await tool("anchors_by_target", { crawlId: judgedId, pageType: "(untyped)" })).body);
    expect(untyped.map((r) => String(r["url"]).slice(SITE.length))).toEqual(["/t3"]);
    const nothing = await tool("anchors_by_target", { crawlId: judgedId, pageType: "no-such-type" });
    expect(nothing.error).toBe(true);
  });

  it("the route answers exactly what the tool answers", async () => {
    const viaRoute = await http(`/crawls/${judgedId}/anchors-by-target`);
    const viaTool = await tool("anchors_by_target", { crawlId: judgedId });
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body).toEqual(viaTool.body);
    const filtered = await http(`/crawls/${judgedId}/anchors-by-target?pageType=product&limit=1`);
    expect(items(filtered.body)).toHaveLength(1);
  });
});

describe("anchors_by_target CSV view", () => {
  it("writes the header and the same rows, topAnchors as 'text (n); text (n)'", async () => {
    const out = await csvRecords(judgedId);
    expect(out[0]).toBe("url,pageType,inlinks,distinctAnchors,emptyAnchors,nonDescriptiveAnchors,genericShare,topAnchors\r\n");
    const lines = out.slice(1).map((l) => l.trimEnd());
    expect(lines).toEqual([
      `${url("/t2")},product,2,3,1,2,1,click here (1); read more (1)`,
      `${url("/t3")},,1,1,1,0,1,`,
      `${url("/target")},content,7,4,1,1,0.2857,blue widgets (4); click here (1); red (1)`,
    ]);
  });

  it("refuses a crawl judged before 29c and an unjudged one, before the header", async () => {
    await expect(csvRecords(legacyId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(csvRecords(unjudgedId)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("anchors_by_target refusals", () => {
  it("a crawl judged before 29c is a CONFLICT that says to re-run the rules", async () => {
    const answer = await tool("anchors_by_target", { crawlId: legacyId });
    expect(answer.error).toBe(true);
    expect(answer.body).toMatchObject({ code: "CONFLICT" });
    expect(String(answer.body["error"])).toContain("re-run the rules");
    expect((await http(`/crawls/${legacyId}/anchors-by-target`)).status).toBe(409);
  });

  it("an unjudged crawl is a CONFLICT that says to run the rules", async () => {
    const answer = await tool("anchors_by_target", { crawlId: unjudgedId });
    expect(answer.body).toMatchObject({ code: "CONFLICT" });
    expect(String(answer.body["error"])).toContain("crawl_rules");
  });

  it("an unknown crawl is NOT_FOUND, and so is another tenant's, in the same words", async () => {
    const missing = `crawl_${randomUUID()}`;
    const absent = await http(`/crawls/${missing}/anchors-by-target`);
    expect(absent.status).toBe(404);
    const foreign = await http(`/crawls/${judgedId}/anchors-by-target`, OTHER);
    expect(foreign.status).toBe(404);
    expect(JSON.parse(JSON.stringify(foreign.body).split(judgedId).join(missing))).toEqual(absent.body);
    await expect(service.listAnchorsByTarget(OTHER, judgedId)).rejects.toBeInstanceOf(ServiceError);
  });
});

/**
 * Link facts on the surface (Phase 29c T5): `inlinksInternal`, `outlinksInternal`,
 * `outlinksExternal` and `linkScore` on `pages_query` (tool, route, JSONL export),
 * on the `internal_urls` CSV, and the `link-counts` section of `crawl_overview`.
 *
 * One ten-page site judged through the real rules run, so the values asserted are
 * the derivations' own:
 *
 *   edges  p1..p9 -> p0;  p0 -> p1, p2, p3;  p1 -> p2, p3
 *   external targets  p0: 2, p5: 1, p7: 5
 *
 *   inlinks   p0=9 p1=1 p2=2 p3=2 p4..p9=0    sorted 0x6 1 2 2 9  -> p50 0, p90 2, max 9
 *   outlinks  p0=3 p1=3 p2..p9=1              sorted 1x8 3 3      -> p50 1, p90 3, max 3
 *   external  p0=2 p5=1 p7=5, others 0        sorted 0x7 1 2 5    -> p50 0, p90 2, max 5
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { NOT_MEASURED_REASONS, type CrawlOverview } from "../../src/api/overview.js";
import { ApiService } from "../../src/api/service.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";

const TOKEN = "test-token-link-facts-0123456789";
const SITE = "https://link-facts.example";
const runId = randomUUID();
const judgedId = `crawl_link_facts_${runId}`;
const legacyId = `crawl_link_facts_legacy_${runId}`;
const PATHS = Array.from({ length: 10 }, (_u, i) => `/p${i}`);

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

async function seed(id: string): Promise<void> {
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: `${SITE}/`, hostKey: hostKeyOf(`${SITE}/`),
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: PATHS.length,
    robotsBlockedDropped: 0,
  });
  const ids = new Map(PATHS.map((p) => [p, `page_${randomUUID()}`]));
  await db.insert(pages).values(
    PATHS.map((path, i) =>
      mkPage({
        id: ids.get(path)!, crawlId: id, url: url(path), urlNormalised: url(path),
        ...(i === 0 ? { depth: 0, clickDepth: 0, discoveredVia: "seed" } : {}),
      }),
    ),
  );
  const internal: [string, string][] = [
    ...PATHS.slice(1).map((p) => [p, "/p0"] as [string, string]),
    ["/p0", "/p1"], ["/p0", "/p2"], ["/p0", "/p3"], ["/p1", "/p2"], ["/p1", "/p3"],
  ];
  const external: [string, number][] = [["/p0", 2], ["/p5", 1], ["/p7", 5]];
  const rows = internal.map(([from, to], position) => ({
    crawlId: id, sourcePageId: ids.get(from)!, targetUrl: url(to), targetPageId: null,
    anchor: "read the page about it", rel: null, isInternal: true, isNofollow: false, position,
  }));
  for (const [from, n] of external) {
    for (let k = 0; k < n; k++) {
      rows.push({
        crawlId: id, sourcePageId: ids.get(from)!, targetUrl: `https://elsewhere.example/${from}-${k}`,
        targetPageId: null, anchor: "off site reference", rel: null, isInternal: false,
        isNofollow: false, position: 100 + k,
      });
    }
  }
  await db.insert(links).values(rows);
}

async function http(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local" },
  });
  expect(res.status, path).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  expect(result.isError === true, text).toBe(false);
  return JSON.parse(text) as Record<string, unknown>;
}

type Item = Record<string, unknown>;
const byPath = (items: Item[]): Map<string, Item> =>
  new Map(items.map((i) => [String(i["url"]).slice(SITE.length), i]));

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-link-facts-"));
  const config: ServiceConfig = {
    credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], exportDir, log: () => {},
  };
  service = new ApiService(db, config);
  api = createApiServer({ db, config: { ...config, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  mcp = createMcpServer({ db, config: { ...config, tenant: LOCAL_TENANT } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-link-facts", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  await seed(judgedId);
  await service.runRulesForCrawl(LOCAL_TENANT, judgedId);
  await seed(legacyId);
  await service.runRulesForCrawl(LOCAL_TENANT, legacyId);
  // Judged before 29c: the five columns null, rules_run_at kept.
  await db.update(pages).set({
    inlinksInternal: null, outlinksInternal: null, outlinksExternal: null,
    linkScore: null, linkScoreRaw: null,
  }).where(eq(pages.crawlId, legacyId));
}, 60_000);

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await service.close();
  for (const id of [judgedId, legacyId]) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
});

const EXPECT_INLINKS: Record<string, number> = {
  "/p0": 9, "/p1": 1, "/p2": 2, "/p3": 2, "/p4": 0, "/p5": 0, "/p6": 0, "/p7": 0, "/p8": 0, "/p9": 0,
};

describe("link facts on the page listing", () => {
  it("pages_query carries the four fields with the derived values", async () => {
    const rows = byPath((await tool("pages_query", { crawlId: judgedId }))["items"] as Item[]);
    for (const [path, inlinks] of Object.entries(EXPECT_INLINKS)) {
      expect(rows.get(path)?.["inlinksInternal"], path).toBe(inlinks);
    }
    expect(rows.get("/p0")).toMatchObject({ outlinksInternal: 3, outlinksExternal: 2, linkScore: 100 });
    expect(rows.get("/p5")).toMatchObject({ outlinksInternal: 1, outlinksExternal: 1 });
    expect(rows.get("/p7")?.["outlinksExternal"]).toBe(5);
    for (const row of rows.values()) {
      expect(Number.isInteger(row["linkScore"])).toBe(true);
      expect(row).not.toHaveProperty("linkScoreRaw");
    }
  });

  it("the route answers exactly what the tool answers", async () => {
    const viaRoute = await http(`/crawls/${judgedId}/pages`);
    const viaTool = await tool("pages_query", { crawlId: judgedId });
    expect(viaRoute).toEqual(viaTool);
  });

  it("the pages JSONL export carries the fields", async () => {
    const res = await http(`/crawls/${judgedId}/export?dataset=pages`);
    const text = gunzipSync(await readFile(String(res["path"]))).toString("utf8");
    const rows = byPath(text.trim().split("\n").map((l) => JSON.parse(l) as Item));
    expect(rows.get("/p0")).toMatchObject({
      inlinksInternal: 9, outlinksInternal: 3, outlinksExternal: 2, linkScore: 100,
    });
    expect(rows.get("/p4")?.["inlinksInternal"]).toBe(0);
  });

  it("a crawl judged before 29c lists nulls, never zeros", async () => {
    const rows = byPath((await tool("pages_query", { crawlId: legacyId }))["items"] as Item[]);
    for (const row of rows.values()) {
      expect(row).toMatchObject({
        inlinksInternal: null, outlinksInternal: null, outlinksExternal: null, linkScore: null,
      });
    }
  });
});

describe("link facts in the internal_urls CSV", () => {
  it("has the four columns after clickDepth, and a row reads correctly", async () => {
    const stream = await service.prepareCsvExport(LOCAL_TENANT, judgedId, { view: "internal_urls" });
    const out: string[] = [];
    for await (const record of stream.records()) out.push(record);
    const header = out.find((l) => l.startsWith("url,"));
    if (header === undefined) throw new Error("no header row in the internal_urls CSV");
    expect(header).toContain(
      "clickDepth,inlinks,outlinksInternal,outlinksExternal,linkScore,pageType",
    );
    const cols = header.trim().split(",");
    const row = out.find((l) => l.startsWith(url("/p0")))?.trim().split(",");
    if (row === undefined) throw new Error("no /p0 row in the internal_urls CSV");
    const at = (name: string): string => row[cols.indexOf(name)] ?? "";
    expect([at("inlinks"), at("outlinksInternal"), at("outlinksExternal"), at("linkScore")]).toEqual([
      "9", "3", "2", "100",
    ]);
  });
});

describe("the link-counts section of crawl_overview", () => {
  const entries = (o: CrawlOverview): Record<string, number> => {
    const s = o.sections.find((x) => x.id === "link-counts");
    if (s === undefined) throw new Error("no link-counts section");
    for (const e of s.entries) expect(e.percent).toBeNull();
    return Object.fromEntries(s.entries.map((e) => [e.label, e.value]));
  };

  it("holds the exact p50, p90 and max of the fixture, after click-depth", async () => {
    const o = await service.crawlOverview(LOCAL_TENANT, judgedId);
    expect(entries(o)).toEqual({
      "inlinks p50": 0, "inlinks p90": 2, "inlinks max": 9,
      "outlinks (internal) p50": 1, "outlinks (internal) p90": 3, "outlinks (internal) max": 3,
      "outlinks (external) p50": 0, "outlinks (external) p90": 2, "outlinks (external) max": 5,
    });
    const ids = o.sections.map((s) => s.id);
    expect(ids.indexOf("link-counts")).toBe(ids.indexOf("click-depth") + 1);
    expect(o.notMeasured.map((n) => n.id)).not.toContain("link-counts");
  });

  it("is absent and named in notMeasured on a crawl judged before 29c", async () => {
    const o = await service.crawlOverview(LOCAL_TENANT, legacyId);
    expect(o.sections.map((s) => s.id)).not.toContain("link-counts");
    expect(o.notMeasured).toContainEqual({
      id: "link-counts",
      reason: "judged before link counts existed; re-run the rules",
    });
    expect(NOT_MEASURED_REASONS["link-counts"]).toBe(
      "judged before link counts existed; re-run the rules",
    );
  });
});

describe("the crawl_overview tool description", () => {
  it("names link-counts and its not-measured case", async () => {
    const listed = await client.listTools();
    const description = listed.tools.find((t) => t.name === "crawl_overview")?.description ?? "";
    expect(description).toContain("link-counts");
    expect(description).toContain("judged before link counts existed");
  });
});

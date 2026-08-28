/**
 * The MCP surface, exercised through a real client over the SDK's in-memory
 * transport.
 *
 * Nothing here calls a tool handler directly. Every assertion goes through
 * `Client.callTool`, over a linked transport pair, because the things this task
 * is responsible for — that a tool's schema is closed, that a misspelled filter
 * is refused rather than ignored, that a refusal arrives as a tool error with
 * the same `{error}` body the HTTP transport sends, that a crawl really starts
 * in the server process — are properties of the server, not of a function.
 *
 * TWO FIXTURES, on purpose. The *live* crawl is started through `crawl_start`
 * against a 127.0.0.1 fixture site and driven all the way through
 * `crawl_render` and `crawl_rules`, because "a crawl runs in this process" is
 * exactly what a transport test cannot fake. The *seeded* crawl carries known
 * `issues`, `metrics` and `pages` rows, because the query tools' assertions are
 * about ordering, filtering and cursors — which a real crawl would supply less
 * predictably and far more slowly (the same division as test/api/query.test.ts).
 *
 * `allowPrivate` is not a tool argument at any value, and these tests still
 * crawl 127.0.0.1: it is supplied where the trust actually is, in
 * `createMcpServer`'s construction config, by the process that holds the
 * database handle. That is the process-trust seam the MCP transport rests on —
 * see the header of src/api/mcp.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, metrics, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import { loadMcpConfig } from "../../src/api/config.js";
import { START_CRAWL_FIELDS } from "../../src/api/service.js";

const SEEDED_SITE = "http://mcp-query.example";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title>` +
    `<meta name="description" content="a fixture page for the MCP tests"></head>` +
    `<body><h1>${title}</h1>${body}</body></html>`
  );
}

let db: Db;
let siteServer: Server;
let site: string;
let exportDir: string;

/** The server under test, and a client speaking to it in this process. */
let mcp: AriadneMcpServer;
let client: Client;
const serverLog: string[] = [];

/** A second server whose allowlist is empty — the read-only posture. */
let closedMcp: AriadneMcpServer;
let closedClient: Client;

const createdCrawls: string[] = [];
/** The crawl started through `crawl_start`, crawled, rendered and judged. */
let liveCrawlId = "";
/** The crawl whose issue/metric/page rows the query tools read. */
let seededCrawlId = "";

interface ToolAnswer {
  isError: boolean;
  /** The single text block, parsed. Tool answers are always JSON. */
  body: Record<string, unknown>;
  /** The raw text, for the assertions about what did NOT cross the wire. */
  text: string;
  /** Every content block, so "exactly one, and it is text" is assertable. */
  blocks: { type: string }[];
}

async function callWith(
  target: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const result = (await target.callTool({ name, arguments: args })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const blocks = result.content ?? [];
  const first = blocks[0];
  const text = first?.text ?? "";
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // A non-JSON answer is a finding, not a crash: the assertions that care
    // read `text` (the SDK's own schema refusals are plain text by design).
  }
  return { isError: result.isError === true, body, text, blocks };
}

function call(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  return callWith(client, name, args);
}

/** The answer, or a failure that says which tool refused and why. */
async function ok(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const answer = await call(name, args);
  if (answer.isError) throw new Error(`${name} refused: ${answer.text}`);
  return answer.body;
}

function items(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body["items"];
  if (!Array.isArray(value)) throw new Error(`no items in ${JSON.stringify(body)}`);
  return value as Record<string, unknown>[];
}

/** Poll a crawl through the surface until it stops moving. */
async function settle(crawlId: string, deadlineMs = 30_000): Promise<Record<string, unknown>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const detail = await ok("crawl_status", { crawlId });
    const status = detail["status"];
    if (status !== "queued" && status !== "running") return detail;
    if (Date.now() > until) throw new Error(`settle: crawl ${crawlId} still '${String(status)}'`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function seedCrawl(row: { id: string; status: string }): Promise<string> {
  await db.insert(crawls).values({
    id: row.id,
    siteUrl: `${SEEDED_SITE}/`,
    config: { siteUrl: `${SEEDED_SITE}/` },
    rulesetVersion: "0.0.0-test",
    status: row.status,
  });
  createdCrawls.push(row.id);
  return row.id;
}

async function seedPage(
  crawlId: string,
  p: { slug: string; pageType: string | null; statusCode: number; indexable: boolean | null },
): Promise<string> {
  const id = `${crawlId}_page_${p.slug}`;
  await db.insert(pages).values({
    id,
    crawlId,
    url: `${SEEDED_SITE}/${p.slug}`,
    urlNormalised: `${SEEDED_SITE}/${p.slug}`,
    pageType: p.pageType,
    statusCode: p.statusCode,
    fetchClass: p.statusCode >= 500 ? "server_error" : "ok",
    depth: 1,
    discoveredVia: "link",
    isIndexable: p.indexable,
    wordCount: 200,
    rendered: false,
    title: `title of ${p.slug}`,
  });
  return id;
}

async function seedIssue(
  crawlId: string,
  row: { ruleId: string; severity: string; pageId?: string | null; pageUrl: string | null; dedupeKey: string },
): Promise<void> {
  await db.insert(issues).values({
    crawlId,
    ruleId: row.ruleId,
    pageId: row.pageId ?? null,
    severity: row.severity,
    rulesetVersion: "0.0.0-test",
    dedupeKey: row.dedupeKey,
    details: { pageUrl: row.pageUrl },
  });
}

/**
 * A server whose database fails in one named way, with its own client.
 *
 * The tenant-safety assertion needs an error the surface cannot produce on its
 * own. A `Proxy` over the real handle supplies exactly one: every method is
 * forwarded except the one named here, which throws. Nothing is mocked and the
 * code under test is the real path (the same rig as test/api/http.test.ts).
 */
async function riggedServer(broken: Record<string, () => never>): Promise<{
  mcp: AriadneMcpServer;
  client: Client;
  log: string[];
}> {
  const log: string[] = [];
  const rigged = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === "string" && prop in broken) return broken[prop];
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Db;

  const server = createMcpServer({
    db: rigged,
    config: { allowedDomains: ["127.0.0.1"], log: (line) => log.push(line) },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const riggedClient = new Client({ name: "ariadne-test-rigged", version: "0.0.1" });
  await server.connect(serverSide);
  await riggedClient.connect(clientSide);
  return { mcp: server, client: riggedClient, log };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-mcp-export-"));

  siteServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
      return;
    }
    if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${site}/</loc></url><url><loc>${site}/a</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    const bodies: Record<string, string> = {
      "/": html("home", `<a href="/a">a</a><a href="/b">b</a>`),
      "/a": html("page a", `<a href="/b">b</a><p>some words for the analyzer to count</p>`),
      "/b": html("page b", `<p>the third page, linked from both of the others</p>`),
    };
    const body = bodies[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("not found", "<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const address = siteServer.address();
  site = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  mcp = createMcpServer({
    db,
    config: {
      allowedDomains: ["127.0.0.1"],
      // PROCESS TRUST, NOT WIRE TRUST. See the module header.
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      exportDir,
      log: (line) => serverLog.push(line),
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  closedMcp = createMcpServer({
    db,
    config: { allowedDomains: [], exportDir, log: (line) => serverLog.push(line) },
  });
  const [closedClientSide, closedServerSide] = InMemoryTransport.createLinkedPair();
  closedClient = new Client({ name: "ariadne-test-closed", version: "0.0.1" });
  await closedMcp.connect(closedServerSide);
  await closedClient.connect(closedClientSide);

  // The seeded crawl: known rows, so ordering, filters and cursors are exact.
  seededCrawlId = await seedCrawl({ id: `crawl_mcp_seed_${Date.now()}`, status: "finished" });
  const product = await seedPage(seededCrawlId, {
    slug: "p1", pageType: "product", statusCode: 200, indexable: true,
  });
  await seedPage(seededCrawlId, {
    slug: "b1", pageType: "blog", statusCode: 500, indexable: null,
  });
  await seedIssue(seededCrawlId, {
    ruleId: "http.server-error", severity: "critical", pageUrl: `${SEEDED_SITE}/b1`,
    dedupeKey: `${SEEDED_SITE}/b1`,
  });
  for (let i = 1; i <= 3; i += 1) {
    await seedIssue(seededCrawlId, {
      ruleId: "links.orphan", severity: "warning", pageUrl: `${SEEDED_SITE}/o${i}`,
      dedupeKey: `${SEEDED_SITE}/o${i}`,
    });
  }
  await seedIssue(seededCrawlId, {
    ruleId: "title.missing", severity: "warning", pageId: product,
    pageUrl: `${SEEDED_SITE}/p1`, dedupeKey: `${SEEDED_SITE}/p1`,
  });
  await db.insert(metrics).values([
    { crawlId: seededCrawlId, metricId: "redirect.volume", scope: "site", scopeValue: "", value: { ratioPct: 12 } },
    { crawlId: seededCrawlId, metricId: "content.metrics-by-type", scope: "page_type", scopeValue: "product", value: { words: 800 } },
  ]);

  // The live crawl: started through the tool, run in this process.
  const accepted = await ok("crawl_start", { siteUrl: `${site}/`, maxPages: 5 });
  liveCrawlId = String(accepted["crawlId"]);
  createdCrawls.push(liveCrawlId);
  await settle(liveCrawlId);
}, 90_000);

afterAll(async () => {
  await client.close();
  await closedClient.close();
  await mcp.close();
  await closedMcp.close();
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  rmSync(exportDir, { recursive: true, force: true });
});

describe("the tool surface", () => {
  it("advertises exactly the eleven tools of the agent surface, each described", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      [
        "crawl_list", "crawl_mark_failed", "crawl_render", "crawl_rules", "crawl_start",
        "crawl_status", "export_crawl", "issue_urls", "issues_list", "metrics_get",
        "pages_query",
      ].sort(),
    );
    for (const tool of listed.tools) {
      expect(tool.description ?? "", `${tool.name} has no description`).not.toBe("");
      // The pagination contract is on every tool that paginates, because an
      // agent reads one tool's description, not the server's instructions.
      if (tool.name.endsWith("_list") || tool.name === "pages_query" || tool.name === "issue_urls") {
        expect(tool.description, `${tool.name} does not state the pagination contract`)
          .toContain("nextCursor");
      }
    }
  });

  it("closes every input schema and describes every field", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as {
        type: string;
        additionalProperties?: boolean;
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.type).toBe("object");
      // The `checkQuery` / `parseStartCrawlInput` discipline, in schema form: a
      // filter nobody knows is refused rather than dropped, so an agent that
      // misspells one is told instead of being handed the unfiltered answer.
      expect(schema.additionalProperties, `${tool.name} accepts unknown arguments`).toBe(false);
      for (const [field, spec] of Object.entries(schema.properties ?? {})) {
        expect(spec.description ?? "", `${tool.name}.${field} is undescribed`).not.toBe("");
      }
    }
  });

  it("advertises exactly the crawl-start fields the service accepts", async () => {
    // The drift guard. `START_CRAWL_FIELDS` is the wire's vocabulary; a field
    // added there and forgotten here would be one the HTTP surface accepts and
    // the agent surface cannot see.
    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === "crawl_start")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(START_CRAWL_FIELDS).sort());
    expect(schema.required).toEqual(["siteUrl"]);
  });

  it("tells the reader that an empty answer may mean 'not measured yet'", async () => {
    // THE HARD-RULE-1 FAILURE AT THE TRANSPORT. A finished-but-unjudged crawl
    // answers `{items: []}` on the read tools, and an agent that skips
    // crawl_rules and quotes "no metrics measured" into a client report has
    // written a rule that always passes — from the outside. The tools that can
    // be read that way say so in their own descriptions, because an agent reads
    // the tool it is calling and not the server's instructions.
    const listed = await client.listTools();
    for (const name of ["metrics_get", "issue_urls", "pages_query"]) {
      const description = listed.tools.find((t) => t.name === name)?.description ?? "";
      expect(description, `${name} lets an empty answer read as 'nothing found'`).toContain(
        "NOT MEASURED YET",
      );
    }
    // issues_list carries the same warning in its own words: it is the triage
    // view *of a judged crawl*.
    expect(listed.tools.find((t) => t.name === "issues_list")?.description ?? "").toContain(
      "judged crawl",
    );
  });

  it("refuses an argument nobody allowed, naming it", async () => {
    const answer = await call("issues_list", { crawlId: seededCrawlId, serverity: "critical" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("serverity");
  });

  it("answers with one text block of compact JSON and no prose", async () => {
    const answer = await call("crawl_status", { crawlId: liveCrawlId });
    expect(answer.isError).toBe(false);
    expect(answer.blocks).toHaveLength(1);
    expect(answer.blocks[0]?.type).toBe("text");
    expect(answer.text.startsWith("{")).toBe(true);
    expect(answer.body["crawlId"]).toBe(liveCrawlId);
  });
});

describe("crawl_start", () => {
  it("accepted the crawl, ran it in this process, and it finished", () => {
    expect(liveCrawlId).toMatch(/^crawl_/);
  });

  it("refuses a host the allowlist does not name, and says the allowlist refused it", async () => {
    const answer = await call("crawl_start", { siteUrl: "https://not-allowed.example/" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("not-allowed.example");
    expect(String(answer.body["error"])).toContain("allowlist");
  });

  it("refuses a legacy host the allowlist does not name", async () => {
    const answer = await call("crawl_start", {
      siteUrl: `${site}/`,
      legacyHosts: ["victim.example"],
    });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("victim.example");
  });

  it("refuses allowPrivate as an argument at any value", async () => {
    const answer = await call("crawl_start", { siteUrl: `${site}/`, allowPrivate: true });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("allowPrivate");
  });

  it("refuses every crawl when the allowlist is empty, and still answers queries", async () => {
    const refused = await callWith(closedClient, "crawl_start", { siteUrl: `${site}/` });
    expect(refused.isError).toBe(true);
    expect(String(refused.body["error"])).toContain("allowlist is empty");

    const listing = await callWith(closedClient, "crawl_list", { limit: 1 });
    expect(listing.isError).toBe(false);
    expect(Array.isArray(listing.body["items"])).toBe(true);
  });
});

describe("crawl_status / crawl_list", () => {
  it("reports the finished crawl with its frontier and lease counts", async () => {
    const detail = await ok("crawl_status", { crawlId: liveCrawlId });
    expect(detail["status"]).toBe("finished");
    expect(Number(detail["pagesCrawled"])).toBeGreaterThanOrEqual(3);
    expect(detail["queuePosition"]).toBeNull();
    expect(detail["liveLeases"]).toBe(0);
    expect(typeof detail["frontier"]).toBe("object");
    // A fixture site nobody blocks: the field is present and zero, not absent.
    expect(detail["blockedPages"]).toBe(0);
    // Reported by the gate even though nothing escalated it: this crawl ran at
    // perHostDelayMs 0, and 0 is a real spacing rather than "unknown".
    expect(detail["hostSpacingMs"]).toBe(0);
  });

  it("counts the crawl's blocked pages", async () => {
    const crawlId = await seedCrawl({
      id: `crawl_mcp_blocked_${Date.now()}`,
      status: "finished",
    });
    for (const [slug, fetchClass] of [
      ["blocked-1", "blocked"],
      ["blocked-2", "blocked"],
      ["fine", "ok"],
      ["gone", "client_error"],
    ] as const) {
      await db.insert(pages).values({
        id: `${crawlId}_${slug}`,
        crawlId,
        url: `${SEEDED_SITE}/${slug}`,
        urlNormalised: `${SEEDED_SITE}/${slug}`,
        statusCode: fetchClass === "blocked" ? 429 : 200,
        fetchClass,
        depth: 1,
        discoveredVia: "link",
        rendered: false,
      });
    }

    const detail = await ok("crawl_status", { crawlId });
    expect(detail["blockedPages"]).toBe(2);
    // A seeded row no crawl loop ever ran: null means "never reported", which
    // is a different fact from a spacing of 0.
    expect(detail["hostSpacingMs"]).toBeNull();
  });

  it("refuses a crawl id nothing knows", async () => {
    const answer = await call("crawl_status", { crawlId: "crawl_missing" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no such crawl");
  });

  it("lists crawls newest first and hands back a cursor that continues the listing", async () => {
    const first = await ok("crawl_list", { limit: 1 });
    expect(items(first)).toHaveLength(1);
    expect(typeof first["nextCursor"]).toBe("string");

    const second = await ok("crawl_list", { limit: 1, cursor: String(first["nextCursor"]) });
    expect(items(second)).toHaveLength(1);
    expect(items(second)[0]?.["crawlId"]).not.toBe(items(first)[0]?.["crawlId"]);
  });

  it("refuses a limit outside the contract rather than clamping it", async () => {
    const answer = await call("crawl_list", { limit: 0 });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("limit must be an integer");
  });
});

describe("crawl_render", () => {
  it("runs the pass over the finished crawl and answers with counts, not a page list", async () => {
    const summary = await ok("crawl_render", { crawlId: liveCrawlId });
    expect(summary["crawlId"]).toBe(liveCrawlId);
    const selection = summary["selection"] as Record<string, unknown>;
    expect(typeof selection["selected"]).toBe("number");
    expect(Number(summary["rendered"]) + Number(summary["failures"])).toBe(selection["selected"]);
    expect(summary["unrendered"]).toBe(0);
    // A page list is an export, not a tool answer (obligation 1).
    expect(JSON.stringify(summary)).not.toContain(`${site}/a`);
  }, 90_000);

  it("refuses a crawl id nothing knows", async () => {
    const answer = await call("crawl_render", { crawlId: "crawl_missing" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no such crawl");
  });
});

describe("crawl_rules", () => {
  it("judges the finished crawl and answers with the run summary", async () => {
    const summary = await ok("crawl_rules", { crawlId: liveCrawlId });
    expect(Number(summary["pagesScanned"])).toBeGreaterThanOrEqual(3);
    expect(typeof summary["findings"]).toBe("number");
    expect(typeof summary["byRule"]).toBe("object");
    expect(typeof summary["byMetric"]).toBe("object");
  }, 90_000);

  it("refuses a crawl that has not stopped moving", async () => {
    const id = await seedCrawl({ id: `crawl_mcp_running_${Date.now()}`, status: "running" });
    const answer = await call("crawl_rules", { crawlId: id });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("has stopped");
  });
});

describe("crawl_mark_failed", () => {
  it("closes a crawl whose worker is gone, and answers with the crawl detail", async () => {
    const id = await seedCrawl({ id: `crawl_mcp_orphan_${Date.now()}`, status: "running" });
    const detail = await ok("crawl_mark_failed", { crawlId: id });
    expect(detail["crawlId"]).toBe(id);
    expect(detail["status"]).toBe("failed");
  });

  it("refuses a crawl that is already closed, naming the status it is in", async () => {
    const answer = await call("crawl_mark_failed", { crawlId: seededCrawlId });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("'finished'");
  });
});

describe("issues_list / issue_urls", () => {
  it("groups findings by rule, orders them by severity, and joins the registry's copy", async () => {
    const body = await ok("issues_list", { crawlId: seededCrawlId });
    const groups = items(body);
    expect(groups.map((g) => g["ruleId"])).toEqual([
      "http.server-error", "links.orphan", "title.missing",
    ]);
    const orphan = groups.find((g) => g["ruleId"] === "links.orphan");
    expect(orphan?.["count"]).toBe(3);
    expect(orphan?.["category"]).toBe("links");
    expect(orphan?.["checkIds"]).toEqual(["CHECK-32"]);
    expect(String(orphan?.["title"] ?? "")).not.toBe("");
    expect(body["nextCursor"]).toBeNull();
  });

  it("filters by checkId, the way a checklist walk asks", async () => {
    const body = await ok("issues_list", { crawlId: seededCrawlId, checkId: "CHECK-35" });
    expect(items(body).map((g) => g["ruleId"])).toEqual(["title.missing"]);
  });

  it("passes a cursor straight through: one row a page, in the same order", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let hop = 0; hop < 10; hop += 1) {
      const page: Record<string, unknown> = await ok("issues_list", {
        crawlId: seededCrawlId,
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      const rows = items(page);
      expect(rows).toHaveLength(1);
      seen.push(String(rows[0]?.["ruleId"]));
      const next = page["nextCursor"];
      if (next === null) break;
      cursor = String(next);
    }
    expect(seen).toEqual(["http.server-error", "links.orphan", "title.missing"]);
  });

  it("refuses a checkId no rule in this ruleset claims", async () => {
    const answer = await call("issues_list", { crawlId: seededCrawlId, checkId: "CHECK-999" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("CHECK-999");
  });

  it("lists one rule's findings URL by URL, with the rule's own evidence", async () => {
    const body = await ok("issue_urls", { crawlId: seededCrawlId, ruleId: "links.orphan" });
    const rows = items(body);
    expect(rows.map((r) => r["url"])).toEqual([
      `${SEEDED_SITE}/o1`, `${SEEDED_SITE}/o2`, `${SEEDED_SITE}/o3`,
    ]);
    expect(typeof rows[0]?.["evidence"]).toBe("object");
  });

  it("refuses a ruleId this ruleset does not define", async () => {
    const answer = await call("issue_urls", { crawlId: seededCrawlId, ruleId: "not.a.rule" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("not.a.rule");
  });
});

describe("metrics_get", () => {
  it("answers the measured numbers with their copy joined", async () => {
    const body = await ok("metrics_get", { crawlId: seededCrawlId });
    const rows = items(body);
    expect(rows.map((r) => r["metricId"])).toEqual([
      "content.metrics-by-type", "redirect.volume",
    ]);
    expect(rows[1]?.["value"]).toEqual({ ratioPct: 12 });
    expect(String(rows[1]?.["explanation"] ?? "")).not.toBe("");
  });

  it("filters by scope", async () => {
    const body = await ok("metrics_get", { crawlId: seededCrawlId, scope: "page_type" });
    expect(items(body).map((r) => r["scopeValue"])).toEqual(["product"]);
  });

  it("refuses a metricId this ruleset does not define", async () => {
    const answer = await call("metrics_get", { crawlId: seededCrawlId, metricId: "no.such.metric" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no.such.metric");
  });
});

describe("pages_query", () => {
  it("answers the crawled pages, slim and ordered by URL", async () => {
    const body = await ok("pages_query", { crawlId: seededCrawlId });
    const rows = items(body);
    expect(rows.map((r) => r["url"])).toEqual([`${SEEDED_SITE}/b1`, `${SEEDED_SITE}/p1`]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "depth", "fetchClass", "fetchReason", "indexable", "pageType", "renderError",
      "rendered", "renderedWordCount", "statusCode", "url", "wordCount",
    ]);
  });

  it("filters by pageType and statusCode", async () => {
    const byType = await ok("pages_query", { crawlId: seededCrawlId, pageType: "product" });
    expect(items(byType).map((r) => r["url"])).toEqual([`${SEEDED_SITE}/p1`]);

    const byStatus = await ok("pages_query", { crawlId: seededCrawlId, statusCode: 500 });
    expect(items(byStatus).map((r) => r["url"])).toEqual([`${SEEDED_SITE}/b1`]);
  });

  it("refuses a status code that is not an HTTP status", async () => {
    const answer = await call("pages_query", { crawlId: seededCrawlId, statusCode: 999 });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("statusCode");
  });
});

describe("export_crawl", () => {
  it("writes the dataset to a file and answers with the path and the count", async () => {
    const body = await ok("export_crawl", { crawlId: seededCrawlId, dataset: "issues" });
    expect(body["dataset"]).toBe("issues");
    expect(String(body["path"]).startsWith(exportDir)).toBe(true);
    expect(body["rows"]).toBe(5);
    expect(Number(body["bytes"])).toBeGreaterThan(0);
    // The contents stay in the file: a tool answer is a path and a count.
    expect(JSON.stringify(body)).not.toContain("links.orphan");
  });

  it("refuses a dataset that is not one of the three", async () => {
    const answer = await call("export_crawl", { crawlId: seededCrawlId, dataset: "everything" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("everything");
  });
});

describe("failure containment", () => {
  it("turns an unexpected throw into a tool error with a correlation id, keeping the stack in the log", async () => {
    const rig = await riggedServer({
      select: () => {
        throw new Error("boom from /srv/ariadne/internal/secret.ts");
      },
    });
    try {
      const answer = await callWith(rig.client, "crawl_status", { crawlId: "crawl_anything" });
      expect(answer.isError).toBe(true);
      expect(answer.body["error"]).toBe("internal error");
      const correlationId = String(answer.body["correlationId"]);
      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);

      // Nothing about the inside of the process reached the caller.
      expect(answer.text).not.toContain("boom");
      expect(answer.text).not.toContain("secret.ts");
      expect(answer.text).not.toContain("at ");

      // And all of it reached the log, under that id.
      const logged = rig.log.find((line) => line.includes(correlationId));
      expect(logged, "no log line carried the correlation id").toBeDefined();
      expect(logged).toContain("boom from /srv/ariadne/internal/secret.ts");
      expect(logged).toContain("at "); // the stack, not just the message
      expect(logged).toContain("crawl_status");
    } finally {
      await rig.client.close();
      await rig.mcp.close();
    }
  });
});

describe("the stdio entrypoint", () => {
  it("exits when the client hangs up: EOF on stdin is a shutdown, not a hang", async () => {
    // On stdio the client's death arrives as EOF and as nothing else — no
    // signal reaches a child whose parent simply exited, and the SDK's
    // transport does not subscribe to the stream's end. A server that stayed up
    // would hold the pool, and could still be fetching a real site for a client
    // that is gone (rule 9). This is the wiring, not the protocol: the spawn is
    // real, the crawl is not.
    const child = spawn(process.execPath, ["node_modules/.bin/tsx", "src/api/mcp-serve.ts"], {
      cwd: new URL("../../", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: databaseUrl(), ARIADNE_ALLOWED_DOMAINS: "127.0.0.1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const until = Date.now() + 30_000;
      while (!stderr.includes("serving on stdio")) {
        if (child.exitCode !== null) throw new Error(`mcp:serve exited early — ${stderr}`);
        if (Date.now() > until) throw new Error(`mcp:serve never booted — ${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }

      child.stdin.end();
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`still running after EOF — ${stderr}`)), 20_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(exit).toBe(0);
      expect(stderr).toContain("the client hung up");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 60_000);
});

describe("boot configuration", () => {
  it("refuses to start without a database", () => {
    expect(() => loadMcpConfig({})).toThrow(/DATABASE_URL must be set/);
  });

  it("asks for no bearer token: an stdio client is the process that started this one", () => {
    const config = loadMcpConfig({
      DATABASE_URL: "postgres://x",
      ARIADNE_ALLOWED_DOMAINS: "example.com,*.example.org",
    });
    expect(config.allowedDomains).toEqual(["example.com", "*.example.org"]);
    expect(Object.keys(config).sort()).toEqual(["allowedDomains", "databaseUrl"]);
  });

  it("still reads the allowlist, and an empty one is a posture rather than an error", () => {
    expect(loadMcpConfig({ DATABASE_URL: "postgres://x" }).allowedDomains).toEqual([]);
  });
});

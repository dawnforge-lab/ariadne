/**
 * Gate 27b's two contract checks over the real transports (Phase 27b T6).
 *
 *  1. EVERY TRANSPORT ACCEPTS AND REFUSES THE SAME FIELDS. The test walks the
 *     JSON Schema `config_schema` publishes, builds one valid and one or more
 *     invalid bodies per field from it, and drives each through `POST /crawls`
 *     and MCP `crawl_start`: both accept or both refuse, and a refusal's text
 *     names the field on both. Not identical bytes — MCP refuses a body that
 *     does not fit the tool's schema in the SDK, before the handler, with the
 *     schema's own message and the path appended.
 *  2. `config_validate` AND `crawl_start` AGREE ON EVERY REFUSAL. The same
 *     table plus the refusals only the service can make (the allowlist, the URL
 *     policy, the crawl loop's own ranges): `POST /config/validate` says
 *     `valid: false` exactly when `POST /crawls` refuses, its first error's
 *     message is the refusal's message, and its code maps to the status. On a
 *     valid body, `effective` is what the started crawl stored (plan Ruling 1:
 *     the row's `config_jsonb`, judgement aside).
 *
 * NOTHING IS FETCHED for an accepted body. Each server first starts a crawl of
 * a slow local site and waits for it to run, so every crawl accepted after it
 * is QUEUED behind it; the test cancels each one at once (queued → cancelled,
 * `crawl_cancel`, Task 4), and the queue never reaches it.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

const TOKEN = "test-token-transport-parity-0123456789";
const PAGE_DELAY_MS = 100;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let db: Db;
let exportDir: string;
let renderDir: string;
let siteServer: Server;
let site: string;
let api: ApiServer;
let base: string;
let mcp: AriadneMcpServer;
let client: Client;
const createdCrawls: string[] = [];
const blockers: { http: string; mcp: string } = { http: "", mcp: "" };

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

interface ToolAnswer {
  isError: boolean;
  text: string;
  /** The parsed JSON, or null for an SDK refusal (plain text). */
  body: Record<string, unknown> | null;
}

async function tool(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content[0]?.text;
  if (text === undefined) throw new Error(`${name} answered with no content`);
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { isError: result.isError === true, text, body };
}

async function statusOf(id: string): Promise<string> {
  const rows = await db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, id));
  const row = rows[0];
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row.status;
}

async function untilStatus(id: string, predicate: (status: string) => boolean): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await statusOf(id);
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`crawl ${id} stuck at ${status}`);
    await sleep(20);
  }
}

/** Cancel a crawl this test just had accepted; it must still be queued. */
async function cancelQueuedHttp(id: string): Promise<void> {
  createdCrawls.push(id);
  const res = await call("POST", `/crawls/${id}/cancel`);
  expect(res.status, `cancel ${id}: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body["status"]).toBe("cancelled");
}

async function cancelQueuedMcp(id: string): Promise<void> {
  createdCrawls.push(id);
  const answer = await tool("crawl_cancel", { crawlId: id });
  expect(answer.isError, answer.text).toBe(false);
  expect(answer.body?.["status"]).toBe("cancelled");
}

// --------------------------------------------------------------- the bodies

interface JsonSchema {
  type?: string;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  default?: unknown;
}

interface Case {
  name: string;
  body: Record<string, unknown>;
  /** The name a refusal's text must carry on both transports. */
  field: string;
}

/** The schema's own type for a property, looking through `anyOf` with null. */
function typed(spec: JsonSchema): JsonSchema {
  if (spec.anyOf === undefined) return spec;
  const branch = spec.anyOf.find((s) => s.type !== "null");
  if (branch === undefined) throw new Error("an anyOf with only null in it");
  return branch;
}

/** A value of the wrong JSON type for `spec`. */
function wrongType(spec: JsonSchema): unknown {
  switch (typed(spec).type) {
    case "integer":
    case "number":
    case "boolean":
    case "array":
    case "object":
      return "not-this-type";
    case "string":
      return 17;
    default:
      throw new Error(`no wrong-type value for schema type ${String(typed(spec).type)}`);
  }
}

/** The valid value for a field: its published default, or a fixture. */
function validValue(field: string, spec: JsonSchema): unknown {
  if (spec.default !== undefined) return spec.default;
  const fixtures: Record<string, unknown> = {
    siteUrl: `${site}/`,
    legacyHosts: ["localhost"],
    sitemapUrls: [`${site}/sitemap.xml`],
    judgement: { rules: { "title.too-long": { priority: "low" } }, thresholds: { SLOW_MS: 800 } },
    // Phase 27c. `urls` is only valid beside `mode: "list"` (`COMPANIONS`).
    urls: [`${site}/p/1`, `${site}/p/2`],
    requestHeaders: { "x-parity": "parity-header-value" },
    httpAuth: { username: "parity-user", password: "parity-password" },
    cookies: [{ name: "sid", value: "parity-cookie" }],
  };
  if (!(field in fixtures)) throw new Error(`no fixture for '${field}', which has no default`);
  return fixtures[field];
}

/** The fields a valid value of one field needs beside it: a list is a list crawl's. */
const COMPANIONS: Record<string, Record<string, unknown>> = { urls: { mode: "list" } };

/**
 * The table, built by walking the published schema. A field gets one valid
 * body, a wrong-type body, and an out-of-range body for every bound the schema
 * publishes (`minimum`, a `maximum` below the safe-integer ceiling zod writes
 * for every integer, `maxItems`). The judgement's thresholds are walked the
 * same way, one level down.
 */
async function buildCases(): Promise<{ valid: Case[]; invalid: Case[] }> {
  const res = await call("GET", "/config/schema");
  expect(res.status).toBe(200);
  const schema = res.body["schema"] as JsonSchema;
  const props = schema.properties ?? {};
  const seed = `${site}/`;
  const valid: Case[] = [];
  const invalid: Case[] = [];

  const bounds = (spec: JsonSchema): unknown[] => {
    const t = typed(spec);
    const out: unknown[] = [];
    if (t.minimum !== undefined) out.push(t.minimum - 1);
    if (t.maximum !== undefined && t.maximum < Number.MAX_SAFE_INTEGER) out.push(t.maximum + 1);
    if (t.maxItems !== undefined) {
      out.push(Array.from({ length: t.maxItems + 1 }, (_u, i) => `${site}/s-${i}.xml`));
    }
    return out;
  };

  for (const [field, spec] of Object.entries(props)) {
    valid.push({
      name: `${field}: valid`,
      body: { siteUrl: seed, ...COMPANIONS[field], [field]: validValue(field, spec) },
      field,
    });
    invalid.push({
      name: `${field}: wrong type`,
      body: { siteUrl: seed, [field]: wrongType(spec) },
      field,
    });
    for (const bad of bounds(spec)) {
      invalid.push({ name: `${field}: out of range`, body: { siteUrl: seed, [field]: bad }, field });
    }
  }

  const thresholds = props["judgement"]?.properties?.["thresholds"]?.properties ?? {};
  expect(Object.keys(thresholds).length).toBe(20);
  for (const [name, spec] of Object.entries(thresholds)) {
    for (const bad of [wrongType(spec), ...bounds(spec)]) {
      invalid.push({
        name: `judgement.thresholds.${name}: ${JSON.stringify(bad)}`,
        body: { siteUrl: seed, judgement: { thresholds: { [name]: bad } } },
        field: name,
      });
    }
  }

  invalid.push(
    { name: "an unknown field", body: { siteUrl: seed, bogus: 1 }, field: "key 2 in the order sent" },
    { name: "allowPrivate", body: { siteUrl: seed, allowPrivate: true }, field: "allowPrivate" },
    {
      name: "a rule id the ruleset does not have",
      body: { siteUrl: seed, judgement: { rules: { "no.such-rule": { disabled: true } } } },
      field: "judgement",
    },
  );
  return { valid, invalid };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-parity-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-parity-render-"));

  // An endless slow tree, so each server's blocker crawl is running for as long
  // as the test needs it to be.
  siteServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const m = /^\/p\/(\d+)$/.exec(path);
    if (path !== "/" && m === null) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const n = m === null ? 0 : Number(m[1]);
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p/${n * 10 + i + 1}">p</a>`).join("");
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><head><title>Slow ${n}</title></head><body>${links}</body></html>`);
    }, PAGE_DELAY_MS);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;

  // `169.254.169.254` is allowlisted so the URL policy, not the allowlist, is
  // what refuses a sitemap there: the metadata address is refused even under
  // the test-only `allowPrivate`.
  const config: ServiceConfig = {
    allowedDomains: ["127.0.0.1", "localhost", "169.254.169.254"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: () => {},
  };
  api = createApiServer({ db, config: { ...config, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  mcp = createMcpServer({ db, config: { ...config, tenant: LOCAL_TENANT } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-transport-parity", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  const blocker = { siteUrl: `${site}/`, maxPages: 100_000, maxConcurrency: 1 };
  const viaHttp = await call("POST", "/crawls", blocker);
  if (viaHttp.status !== 202) throw new Error(`blocker: ${viaHttp.status} ${JSON.stringify(viaHttp.body)}`);
  blockers.http = String(viaHttp.body["crawlId"]);
  const viaMcp = await tool("crawl_start", blocker);
  if (viaMcp.isError) throw new Error(`blocker: ${viaMcp.text}`);
  blockers.mcp = String(viaMcp.body?.["crawlId"]);
  createdCrawls.push(blockers.http, blockers.mcp);
  await untilStatus(blockers.http, (s) => s === "running");
  await untilStatus(blockers.mcp, (s) => s === "running");
}, 60_000);

afterAll(async () => {
  if (blockers.http !== "") await call("POST", `/crawls/${blockers.http}/cancel`);
  if (blockers.mcp !== "") await tool("crawl_cancel", { crawlId: blockers.mcp });
  for (const id of [blockers.http, blockers.mcp]) {
    if (id !== "") await untilStatus(id, (s) => s !== "running" && s !== "queued");
  }
  await client.close();
  await mcp.close();
  await api.close();
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
}, 60_000);

describe("contract clause 1: both transports accept and refuse the same fields", () => {
  it("walks the published schema and drives every body through POST /crawls and crawl_start", async () => {
    const { valid, invalid } = await buildCases();
    expect(valid.length).toBe(24);

    for (const c of valid) {
      const viaHttp = await call("POST", "/crawls", c.body);
      expect(viaHttp.status, `${c.name} over HTTP: ${JSON.stringify(viaHttp.body)}`).toBe(202);
      expect(viaHttp.body["queuePosition"], c.name).toBeGreaterThanOrEqual(1);
      await cancelQueuedHttp(String(viaHttp.body["crawlId"]));

      const viaMcp = await tool("crawl_start", c.body);
      expect(viaMcp.isError, `${c.name} over MCP: ${viaMcp.text}`).toBe(false);
      expect(viaMcp.body?.["queuePosition"], c.name).toBeGreaterThanOrEqual(1);
      await cancelQueuedMcp(String(viaMcp.body?.["crawlId"]));
    }

    for (const c of invalid) {
      const viaHttp = await call("POST", "/crawls", c.body);
      expect([400, 403], `${c.name} over HTTP: ${viaHttp.status}`).toContain(viaHttp.status);
      expect(String(viaHttp.body["error"]), `${c.name} over HTTP`).toContain(c.field);

      const viaMcp = await tool("crawl_start", c.body);
      expect(viaMcp.isError, `${c.name} over MCP was accepted`).toBe(true);
      expect(viaMcp.text, `${c.name} over MCP`).toContain(c.field);
    }
  }, 120_000);
});

describe("contract clause 2: config_validate and crawl_start agree on every refusal", () => {
  it("answers valid: false exactly when POST /crawls refuses, with its message and status", async () => {
    const { valid, invalid } = await buildCases();
    const seed = `${site}/`;
    const serviceOnly: Case[] = [
      { name: "a host off the allowlist", body: { siteUrl: "https://not-allowed.example/" }, field: "" },
      { name: "a legacy host off the allowlist", body: { siteUrl: seed, legacyHosts: ["victim.example"] }, field: "" },
      {
        name: "a sitemap the URL policy refuses",
        body: { siteUrl: seed, sitemapUrls: ["http://169.254.169.254/s.xml"] },
        field: "",
      },
      { name: "a render budget the crawl loop refuses", body: { siteUrl: seed, renderBudgetPct: 0 }, field: "" },
      { name: "a siteUrl that is not http(s)", body: { siteUrl: "ftp://example.com/x" }, field: "" },
      {
        name: "findingCap at both levels, disagreeing",
        body: { siteUrl: seed, findingCap: 100, judgement: { findingCap: 200 } },
        field: "",
      },
    ];
    const expectedCodes: Record<string, string> = {
      "a host off the allowlist": "not_allowed",
      "a legacy host off the allowlist": "not_allowed",
      "a sitemap the URL policy refuses": "url_policy",
      "a render budget the crawl loop refuses": "invalid",
    };

    for (const c of [...invalid, ...serviceOnly]) {
      const checked = await call("POST", "/config/validate", c.body);
      expect(checked.status, c.name).toBe(200);
      expect(checked.body["valid"], c.name).toBe(false);
      expect(checked.body["effective"], c.name).toBeNull();
      const errors = checked.body["errors"] as { path: string; code: string; message: string }[];
      const firstError = errors[0];
      if (firstError === undefined) throw new Error(`${c.name}: invalid with no errors`);
      if (c.name in expectedCodes) expect(firstError.code, c.name).toBe(expectedCodes[c.name]);

      const started = await call("POST", "/crawls", c.body);
      const forbidden = firstError.code === "not_allowed" || firstError.code === "url_policy";
      expect(started.status, `${c.name}: ${JSON.stringify(started.body)}`).toBe(forbidden ? 403 : 400);
      expect(started.body["error"], c.name).toBe(firstError.message);
    }

    for (const c of valid) {
      const checked = await call("POST", "/config/validate", c.body);
      expect(checked.status, c.name).toBe(200);
      expect(checked.body["valid"], `${c.name}: ${JSON.stringify(checked.body["errors"])}`).toBe(true);
      expect(checked.body["errors"], c.name).toEqual([]);
      const { judgement, ...effective } = checked.body["effective"] as Record<string, unknown>;

      const started = await call("POST", "/crawls", c.body);
      expect(started.status, c.name).toBe(202);
      const id = String(started.body["crawlId"]);
      await cancelQueuedHttp(id);
      const rows = await db
        .select({ config: crawls.config, judgement: crawls.judgement })
        .from(crawls)
        .where(eq(crawls.id, id));
      expect(rows[0]?.config, c.name).toEqual(effective);
      // The judgement the validate answer reports is the parsed block the start
      // stored, or null on both sides when the body carried none.
      expect(rows[0]?.judgement ?? null, c.name).toEqual(judgement ?? null);
    }
  }, 120_000);

  it("is a 200 for any JSON, and a 400 only for a body that is not JSON", async () => {
    const empty = await call("POST", "/config/validate");
    expect(empty.status).toBe(200);
    expect(empty.body["valid"]).toBe(false);
    expect((empty.body["errors"] as { message: string }[])[0]?.message).toBe(
      "request body must be a JSON object",
    );

    const res = await fetch(`${base}/config/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local", "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("answers the same over MCP: config_validate and config_schema", async () => {
    const checked = await tool("config_validate", { config: { siteUrl: `${site}/`, maxPages: 0 } });
    expect(checked.isError, checked.text).toBe(false);
    expect(checked.body?.["valid"]).toBe(false);
    const viaHttp = await call("POST", "/config/validate", { siteUrl: `${site}/`, maxPages: 0 });
    expect(checked.body).toEqual(viaHttp.body);

    const schema = await tool("config_schema", {});
    expect(schema.isError, schema.text).toBe(false);
    expect(schema.body).toEqual((await call("GET", "/config/schema")).body);
  });
});

describe("a list crawl over both transports (27c)", () => {
  it("accepts the same list body on both, with equal effective", async () => {
    const body = {
      siteUrl: `${site}/`,
      mode: "list",
      urls: [`${site}/p/1`, `${site}/p/2?b=2&a=1`, `${site}/p/2?a=1&b=2#x`, `${site}/p/3`],
      exclude: ["*/private/*"],
      maxRedirectHops: 5,
    };
    const viaHttp = await call("POST", "/config/validate", body);
    const viaMcp = await tool("config_validate", { config: body });
    expect(viaMcp.isError, viaMcp.text).toBe(false);
    expect(viaHttp.body["valid"], JSON.stringify(viaHttp.body["errors"])).toBe(true);
    expect(viaMcp.body?.["effective"]).toEqual(viaHttp.body["effective"]);
    expect(viaHttp.body["effective"]).toMatchObject({
      mode: "list",
      listUrlCount: 3,
      listDuplicates: 1,
      maxPages: 6,
      exclude: ["*/private/*"],
      maxRedirectHops: 5,
    });
    expect(viaHttp.body["effective"]).not.toHaveProperty("urls");

    const startedHttp = await call("POST", "/crawls", body);
    expect(startedHttp.status, JSON.stringify(startedHttp.body)).toBe(202);
    expect(startedHttp.body).toMatchObject({ listUrlCount: 3, listDuplicates: 1 });
    await cancelQueuedHttp(String(startedHttp.body["crawlId"]));
    const startedMcp = await tool("crawl_start", body);
    expect(startedMcp.isError, startedMcp.text).toBe(false);
    expect(startedMcp.body).toMatchObject({ listUrlCount: 3, listDuplicates: 1 });
    await cancelQueuedMcp(String(startedMcp.body?.["crawlId"]));
  });
});

describe("the issues overview over both transports (27d)", () => {
  it("GET /crawls/:id/overview/issues deep-equals the MCP issues_overview result", async () => {
    // A finished, one-page crawl judged through the HTTP rules route; nothing is fetched.
    const id = `crawl_parity_overview_${randomUUID()}`;
    createdCrawls.push(id);
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: "https://parity-overview.example/",
      config: { siteUrl: "https://parity-overview.example/", maxPages: 10, userAgent: "AriadneBot-test" },
      discovery: mkDiscovery(),
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 1,
    });
    await db.insert(pages).values(
      mkPage({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url: "https://parity-overview.example/",
        urlNormalised: "https://parity-overview.example/",
        depth: 0,
        clickDepth: 0,
        discoveredVia: "seed",
      }),
    );
    const judged = await call("POST", `/crawls/${id}/rules`);
    expect(judged.status, JSON.stringify(judged.body)).toBe(200);

    for (const includeZero of [false, true]) {
      const viaHttp = await call("GET", `/crawls/${id}/overview/issues?includeZero=${includeZero}`);
      expect(viaHttp.status, JSON.stringify(viaHttp.body)).toBe(200);
      const viaMcp = await tool("issues_overview", { crawlId: id, includeZero });
      expect(viaMcp.isError, viaMcp.text).toBe(false);
      expect(viaMcp.body).toEqual(viaHttp.body);
      expect((viaHttp.body["rows"] as unknown[]).length).toBeGreaterThan(0);
    }
  });
});

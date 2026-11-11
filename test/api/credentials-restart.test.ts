/**
 * Phase 27c T9: credentials across the API lifecycle — a restart empties the
 * process's map, so `crawl_resume` and `crawl_render` refuse
 * `CREDENTIALS_REQUIRED` until the values are sent again; `crawl_config_set`
 * takes them while the crawl is paused, into memory only; and a cancel or a
 * delete drops them (Deviation 9).
 *
 * Over the wire, against a real `node:http` site whose `/auth/` area answers
 * 401 without HTTP Basic credentials. A RESTART is the real thing: the API
 * server is closed and a new one is built on the same database, so its map is
 * empty exactly as a new process's would be.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

const TOKEN = "test-token-credentials-restart-0123456789";
const PAGE_DELAY_MS = 60;

/** The secret values: none may appear in any answer, row or log line. */
const USERNAME = "user-S3CRET";
const PASSWORD = "pw-S3CRET";
const COOKIE_VALUE = "cookie-S3CRET";
const HEADER_VALUE = "hdr-S3CRET";
const BASIC = Buffer.from(`${USERNAME}:${PASSWORD}`, "utf8").toString("base64");
const SECRETS = [USERNAME, PASSWORD, COOKIE_VALUE, HEADER_VALUE, BASIC, "S3CRET"];
const AUTH = { username: USERNAME, password: PASSWORD };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectNoSecret(text: string, where: string): void {
  for (const secret of SECRETS) expect(text, `${where} carries '${secret}'`).not.toContain(secret);
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
const serverLog: string[] = [];
const createdCrawls: string[] = [];

interface Res {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content.map((c) => c.text).join("\n");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { isError: result.isError === true, text, body };
}

/** This server's in-memory credentials, the one place a value lives. */
function held(): { has(id: string): boolean; get(id: string): unknown } {
  return ((s) => ({ has: (id: string) => s.has(id), get: (id: string) => s.current(id) }))((api.service as unknown as { credentials: import("../../src/api/credential-store.js").CredentialStore }).credentials);
}

async function newApi(): Promise<ApiServer> {
  const server = createApiServer({ db, config: { ...serviceConfig(), token: TOKEN } });
  base = `http://127.0.0.1:${(await server.listen(0)).port}`;
  return server;
}

function serviceConfig(): ServiceConfig {
  return {
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: (line) => serverLog.push(line),
  };
}

/** The restart: this process's server goes, a new one comes up on the same database. */
async function restart(): Promise<void> {
  await api.close();
  api = await newApi();
}

async function detail(id: string): Promise<Record<string, unknown>> {
  const res = await call("GET", `/crawls/${id}`);
  if (res.status !== 200) throw new Error(`GET /crawls/${id}: ${res.status} ${res.text}`);
  return res.body;
}

async function until(
  what: string,
  id: string,
  predicate: (body: Record<string, unknown>) => boolean,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await detail(id);
    if (predicate(body)) return body;
    if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${String(body["status"])})`);
    await sleep(20);
  }
}

const settled = (b: Record<string, unknown>): boolean => b["status"] !== "queued" && b["status"] !== "running";

async function start(body: Record<string, unknown>): Promise<string> {
  const res = await call("POST", "/crawls", { maxConcurrency: 1, ...body });
  if (res.status !== 202) throw new Error(`start: ${res.status} ${res.text}`);
  const id = String(res.body["crawlId"]);
  createdCrawls.push(id);
  return id;
}

/** Rows the crawl has written: pages, and frontier rows by state. */
async function written(id: string): Promise<{ pages: number; frontier: string }> {
  const p = await db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.crawlId, id));
  const f = await db
    .select({ state: frontier.state, n: sql<number>`count(*)::int` })
    .from(frontier)
    .where(eq(frontier.crawlId, id))
    .groupBy(frontier.state)
    .orderBy(frontier.state);
  return { pages: p[0]?.n ?? 0, frontier: JSON.stringify(f) };
}

/** A paused row no server holds, whose stored config says which credentials it needs. */
async function seedPaused(
  credentialShape: Record<string, unknown> | null,
  status = "paused",
): Promise<string> {
  const id = `crawl_credentials_${randomUUID()}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: `${site}/auth/`,
    config: {
      siteUrl: `${site}/auth/`,
      maxPages: 30,
      maxDepth: 5,
      userAgent: "AriadneBot/0.1 (test)",
      perHostDelayMs: 0,
      maxConcurrency: 1,
      probeHosts: false,
      mode: "spider",
      exclude: [],
      include: [],
      ...(credentialShape === null ? {} : { credentialShape }),
    },
    discovery: mkDiscovery(),
    rulesetVersion: "0.0.0-test",
    status,
    ...(status === "paused" ? { pauseReason: "request" } : {}),
  });
  createdCrawls.push(id);
  return id;
}

async function storedConfig(id: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ config: crawls.config }).from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row.config as Record<string, unknown>;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-credentials-restart-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-credentials-restart-render-"));

  // A large header limit: a maximal credential set (20 headers and a 50-cookie
  // Cookie header of ~1 KiB each) must reach the site, past Node's 16 KiB default.
  siteServer = createServer({ maxHeaderSize: 1024 * 1024 }, (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    // THE GATED AREA: an endless tree that answers 401 without Basic credentials.
    const auth = /^\/auth\/(\d*)$/.exec(path);
    if (auth !== null) {
      if (req.headers["authorization"] !== `Basic ${BASIC}`) {
        res.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Basic realm="fixture"' });
        res.end("credentials required");
        return;
      }
      const n = auth[1] === "" ? 0 : Number(auth[1]);
      const links = Array.from({ length: 3 }, (_, i) => `<a href="/auth/${n * 3 + i + 1}">a</a>`).join("");
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html lang="en"><head><title>Gated ${n}</title>` +
            `<meta name="description" content="a gated fixture page"></head>` +
            `<body><h1>Gated ${n}</h1>${links}</body></html>`,
        );
      }, PAGE_DELAY_MS);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    // An open endless slow tree: a blocker that holds the queue.
    const slow = /^\/slow\/(\d*)$/.exec(path);
    if (slow !== null) {
      const n = slow[1] === "" ? 0 : Number(slow[1]);
      const links = Array.from({ length: 10 }, (_, i) => `<a href="/slow/${n * 10 + i + 1}">s</a>`).join("");
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="en"><head><title>Slow ${n}</title></head><body>${links}</body></html>`);
      }, 100);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;

  api = await newApi();
  mcp = createMcpServer({ db, config: serviceConfig() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-credentials-restart", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
}, 60_000);

afterAll(async () => {
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

describe("after a restart, a crawl that needed credentials is refused until they are sent again", () => {
  it("crawl_resume and crawl_render refuse CREDENTIALS_REQUIRED and write nothing; a resume with them finishes with no 401 row", async () => {
    const id = await start({ siteUrl: `${site}/auth/`, maxPages: 30, httpAuth: AUTH });
    await until("running with pages", id, (b) => b["status"] === "running" && (b["frontier"] as { done: number }).done >= 1);
    expect((await call("POST", `/crawls/${id}/pause`)).status).toBe(202);
    await until("paused", id, (b) => b["status"] === "paused");

    await restart();
    expect(held().has(id)).toBe(false);
    const restartedAt = serverLog.length;
    const before = await written(id);

    const resumed = await call("POST", `/crawls/${id}/resume`);
    expect(resumed.status, resumed.text).toBe(409);
    expect(resumed.body["code"]).toBe("CREDENTIALS_REQUIRED");
    expect(String(resumed.body["error"])).toContain(id);
    expect(String(resumed.body["error"])).toContain("httpAuth");

    const rendered = await call("POST", `/crawls/${id}/render`);
    expect(rendered.status, rendered.text).toBe(409);
    expect(rendered.body["code"]).toBe("CREDENTIALS_REQUIRED");
    expect(String(rendered.body["error"])).toContain("httpAuth");

    // The MCP server is another process's service with an empty map: the same refusal.
    const viaTool = await tool("crawl_resume", { crawlId: id });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.body["code"]).toBe("CREDENTIALS_REQUIRED");
    const renderTool = await tool("crawl_render", { crawlId: id });
    expect(renderTool.isError).toBe(true);
    expect(renderTool.body["code"]).toBe("CREDENTIALS_REQUIRED");

    // Credentials of another shape are a bad request, naming the names only.
    const wrongShape = await call("POST", `/crawls/${id}/resume`, { cookies: [{ name: "sid", value: COOKIE_VALUE }] });
    expect(wrongShape.status, wrongShape.text).toBe(400);
    expect(wrongShape.body["code"]).toBe("VALIDATION");
    expect(String(wrongShape.body["error"])).toContain("httpAuth");
    expect(String(wrongShape.body["error"])).toContain("sid");
    // The redaction marker is not a value.
    const marker = await call("POST", `/crawls/${id}/resume`, {
      httpAuth: { username: USERNAME, password: "[redacted]" },
    });
    expect(marker.status, marker.text).toBe(400);
    expect(String(marker.body["error"])).toContain("[redacted]");
    // An unknown field is refused, not ignored.
    expect((await call("POST", `/crawls/${id}/resume`, { reclaimLeases: true })).status).toBe(400);

    await sleep(300);
    expect((await detail(id))["status"]).toBe("paused");
    expect(await written(id)).toEqual(before);
    expect(held().has(id)).toBe(false);
    expect(serverLog.slice(restartedAt).filter((line) => line.includes(id))).toEqual([]);

    const ok = await call("POST", `/crawls/${id}/resume`, { httpAuth: AUTH });
    expect(ok.status, ok.text).toBe(202);
    const final = await until("finished", id, settled);
    expect(final["status"]).toBe("finished");
    expect(final["pagesCrawled"]).toBe(30);
    const refused = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(and(eq(pages.crawlId, id), sql`(${pages.fetchClass} = 'client_error' or ${pages.statusCode} = 401)`));
    expect(refused[0]?.n).toBe(0);

    for (const text of [resumed.text, rendered.text, viaTool.text, renderTool.text, wrongShape.text, marker.text, ok.text]) {
      expectNoSecret(text, "a resume/render answer");
    }
    expectNoSecret(JSON.stringify(await storedConfig(id)), "config_jsonb");
    expectNoSecret(serverLog.join("\n"), "the server log");
  }, 120_000);

  it("crawl_render on a finished crawl after a restart: refused without them, renders the gated page with them", async () => {
    const id = await start({ siteUrl: `${site}/auth/`, maxPages: 4, httpAuth: AUTH });
    expect((await until("finished", id, settled))["status"]).toBe("finished");
    await restart();

    const refused = await call("POST", `/crawls/${id}/render`, { urls: [`${site}/auth/`] });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body["code"]).toBe("CREDENTIALS_REQUIRED");

    const res = await call("POST", `/crawls/${id}/render`, { urls: [`${site}/auth/`], httpAuth: AUTH });
    expect(res.status, res.text).toBe(200);
    expect(res.body["rendered"]).toBe(1);
    expect(res.body["failures"]).toBe(0);
    // Kept for the next pass (Deviation 9: until delete or cancel).
    expect(held().has(id)).toBe(true);
    expect((await call("POST", `/crawls/${id}/render`, { urls: [`${site}/auth/`] })).status).toBe(200);
    expectNoSecret(res.text, "the render answer");
    expectNoSecret(serverLog.join("\n"), "the server log");
  }, 120_000);

  it("crawl_resume and crawl_render publish the three credential fields as secrets over MCP", async () => {
    const { tools } = await client.listTools();
    for (const name of ["crawl_resume", "crawl_render"]) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, Record<string, unknown>> };
      for (const field of ["requestHeaders", "httpAuth", "cookies"]) {
        expect(schema.properties[field], `${name}.${field}`).toBeDefined();
        expect(schema.properties[field]?.["x-ariadne-secret"], `${name}.${field}`).toBe(true);
      }
      // An invalid value is refused by the tool's own schema, quoting no value.
      const refused = await tool(name, {
        crawlId: "crawl_nobody",
        httpAuth: { username: `${USERNAME}:x`, password: PASSWORD },
        cookies: [{ name: "sid", value: `${COOKIE_VALUE};x` }],
      });
      expect(refused.isError, name).toBe(true);
      expectNoSecret(refused.text, `${name}'s refusal`);
    }
  });
});

describe("crawl_config_set takes credentials while the crawl is paused, into memory only", () => {
  const shape = (headers: string[], httpAuth: boolean, cookies: string[]) => ({
    requestHeaderNames: headers,
    httpAuth,
    cookieNames: cookies,
  });

  it("replaces the held values and the stored shape; the row holds names, never a value", async () => {
    const id = await seedPaused(shape([], true, []));
    const res = await call("PATCH", `/crawls/${id}/config`, {
      crawl: { httpAuth: AUTH, cookies: [{ name: "sid", value: COOKIE_VALUE }], requestHeaders: { "X-Tenant": HEADER_VALUE } },
    });
    expect(res.status, res.text).toBe(200);
    expectNoSecret(res.text, "the crawl_config_set answer");
    const crawl = res.body["crawl"] as Record<string, unknown>;
    expect(crawl["httpAuth"]).toBe("[redacted]");
    expect(crawl["requestHeaders"]).toEqual({ "x-tenant": "[redacted]" });
    expect(crawl["cookies"]).toEqual([{ name: "sid", value: "[redacted]" }]);
    expect(crawl).not.toHaveProperty("credentialShape");
    expect((await storedConfig(id))["credentialShape"]).toEqual(shape(["x-tenant"], true, ["sid"]));
    expectNoSecret(JSON.stringify(await storedConfig(id)), "config_jsonb");
    expect(held().get(id)).toEqual({
      httpAuth: AUTH,
      cookies: [{ name: "sid", value: COOKIE_VALUE }],
      requestHeaders: { "X-Tenant": HEADER_VALUE },
    });

    // An empty list drops that kind; the others are kept from memory.
    const dropped = await call("PATCH", `/crawls/${id}/config`, { crawl: { cookies: [], requestHeaders: {} } });
    expect(dropped.status, dropped.text).toBe(200);
    expect((await storedConfig(id))["credentialShape"]).toEqual(shape([], true, []));
    expect(held().get(id)).toEqual({ httpAuth: AUTH });
    const view = dropped.body["crawl"] as Record<string, unknown>;
    expect(view).not.toHaveProperty("cookies");
    expect(view).not.toHaveProperty("requestHeaders");
    expectNoSecret(serverLog.join("\n"), "the server log");
  });

  it("refuses values it cannot complete, a partial redaction, an invalid value without quoting it, and a running crawl", async () => {
    const id = await seedPaused(shape([], true, ["sid"]));
    const before = await storedConfig(id);

    // Nothing held (as after a restart) and the patch leaves the cookie out.
    const incomplete = await call("PATCH", `/crawls/${id}/config`, { crawl: { httpAuth: AUTH } });
    expect(incomplete.status, incomplete.text).toBe(409);
    expect(incomplete.body["code"]).toBe("CREDENTIALS_REQUIRED");
    expect(String(incomplete.body["error"])).toContain("sid");
    // ...and sending the cookie back redacted does not supply it either.
    const echoed = await call("PATCH", `/crawls/${id}/config`, {
      crawl: { httpAuth: AUTH, cookies: [{ name: "sid", value: "[redacted]" }] },
    });
    expect(echoed.status, echoed.text).toBe(409);
    expect(echoed.body["code"]).toBe("CREDENTIALS_REQUIRED");

    const partial = await call("PATCH", `/crawls/${id}/config`, {
      crawl: { requestHeaders: { "x-a": "[redacted]", "x-b": HEADER_VALUE } },
    });
    expect(partial.status, partial.text).toBe(400);
    expect(String(partial.body["error"])).toContain("[redacted]");

    const invalid = await call("PATCH", `/crawls/${id}/config`, {
      crawl: { httpAuth: { username: `${USERNAME}:x`, password: PASSWORD } },
    });
    expect(invalid.status, invalid.text).toBe(400);
    expect(String(invalid.body["error"])).toContain("httpAuth.username");

    const running = await seedPaused(shape([], true, []), "running");
    const busy = await call("PATCH", `/crawls/${running}/config`, { crawl: { httpAuth: AUTH } });
    expect(busy.status, busy.text).toBe(409);
    expect(String(busy.body["error"])).toContain("whenPaused");
    expect(held().has(running)).toBe(false);

    for (const r of [incomplete, echoed, partial, invalid, busy]) expectNoSecret(r.text, "a refusal");
    expect(await storedConfig(id)).toEqual(before);
    expect(held().has(id)).toBe(false);
    expect((await db.select({ at: crawls.scopeChangedAt }).from(crawls).where(eq(crawls.id, id)))[0]?.at).toBeNull();
  });

  it("checks an exclude or include sent to crawl_config_set as a start does: a foreign host, too many, too long", async () => {
    const id = await seedPaused(null);
    const foreign = await call("PATCH", `/crawls/${id}/config`, { crawl: { exclude: ["https://typo.example/*"] } });
    expect(foreign.status, foreign.text).toBe(400);
    expect(String(foreign.body["error"])).toContain("exclude");
    expect(String(foreign.body["error"])).toContain("typo.example");
    const many = await call("PATCH", `/crawls/${id}/config`, {
      crawl: { include: Array.from({ length: 101 }, (_, i) => `*/p/${i}`) },
    });
    expect(many.status, many.text).toBe(400);
    expect(String(many.body["error"])).toContain("the limit is 100");
    const long = await call("PATCH", `/crawls/${id}/config`, { crawl: { exclude: [`*/${"a".repeat(511)}`] } });
    expect(long.status, long.text).toBe(400);
    expect(String(long.body["error"])).toContain("the limit is 512");
    expect(await storedConfig(id)).toMatchObject({ exclude: [], include: [] });

    const ok = await call("PATCH", `/crawls/${id}/config`, { crawl: { exclude: [`${site}/auth/9*`], maxRedirectHops: 3 } });
    expect(ok.status, ok.text).toBe(200);
    expect(await storedConfig(id)).toMatchObject({ exclude: [`${site}/auth/9*`], maxRedirectHops: 3 });
    expect(typeof (ok.body["crawl"] as Record<string, unknown>)["scopeChangedAt"]).toBe("string");
  });
});

describe("a cancel or a delete drops the credentials (Deviation 9)", () => {
  it("cancelling a queued crawl, cancelling a paused one, deleting one, and a running crawl that ends cancelled", async () => {
    const blocker = await start({ siteUrl: `${site}/slow/`, maxPages: 100_000 });
    await until("the blocker runs", blocker, (b) => b["status"] === "running");

    const queued = await start({ siteUrl: `${site}/auth/`, maxPages: 5, httpAuth: AUTH });
    expect((await detail(queued))["status"]).toBe("queued");
    expect(held().has(queued)).toBe(true);
    expect((await call("POST", `/crawls/${queued}/cancel`)).status).toBe(200);
    expect(held().has(queued)).toBe(false);

    const paused = await start({ siteUrl: `${site}/auth/`, maxPages: 5, httpAuth: AUTH });
    expect((await call("POST", `/crawls/${paused}/pause`)).status).toBe(200);
    expect(held().has(paused)).toBe(true);
    expect((await call("POST", `/crawls/${paused}/cancel`)).status).toBe(200);
    expect(held().has(paused)).toBe(false);
    const render = await call("POST", `/crawls/${paused}/render`);
    expect(render.status, render.text).toBe(409);
    expect(render.body["code"]).toBe("CREDENTIALS_REQUIRED");

    const deleted = await start({ siteUrl: `${site}/auth/`, maxPages: 5, httpAuth: AUTH });
    expect((await call("POST", `/crawls/${deleted}/pause`)).status).toBe(200);
    expect(held().has(deleted)).toBe(true);
    expect((await call("DELETE", `/crawls/${deleted}?confirm=${deleted}`)).status).toBe(200);
    expect(held().has(deleted)).toBe(false);

    expect([200, 202]).toContain((await call("POST", `/crawls/${blocker}/cancel`)).status);
    await until("the blocker closes", blocker, settled);

    const running = await start({ siteUrl: `${site}/auth/`, maxPages: 1000, httpAuth: AUTH });
    await until("running", running, (b) => b["status"] === "running");
    expect(held().has(running)).toBe(true);
    expect((await call("POST", `/crawls/${running}/cancel`)).status).toBe(202);
    expect((await until("cancelled", running, settled))["status"]).toBe("cancelled");
    // The runner drops the entry once the loop has returned, just after the row closes.
    for (let i = 0; i < 100 && held().has(running); i += 1) await sleep(20);
    expect(held().has(running)).toBe(false);
  }, 120_000);
});

/** Pages of the crawl the gate refused (a 401 or a client_error row). */
async function refusedRows(id: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(eq(pages.crawlId, id), sql`(${pages.fetchClass} = 'client_error' or ${pages.statusCode} = 401)`));
  return rows[0]?.n ?? 0;
}

/** Pages of the crawl the gate let through. */
async function okRows(id: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(eq(pages.crawlId, id), eq(pages.statusCode, 200)));
  return rows[0]?.n ?? 0;
}

describe("27c T9 fix 1", () => {
  it("a maximal credential set is re-supplied over HTTP after a restart (1 MiB cap); a 64 KiB route still 413s", async () => {
    const maximal = {
      requestHeaders: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`x-h${i}`, `${HEADER_VALUE}-${String(i).padStart(2, "0")}`.padEnd(1024, "h")]),
      ),
      httpAuth: AUTH,
      cookies: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, value: `${COOKIE_VALUE}${i}`.padEnd(1024, "c") })),
    };
    expect(JSON.stringify(maximal).length).toBeGreaterThan(64 * 1024);

    const id = await start({ siteUrl: `${site}/auth/`, maxPages: 30, ...maximal });
    await until("running with pages", id, (b) => b["status"] === "running" && (b["frontier"] as { done: number }).done >= 1);
    expect((await call("POST", `/crawls/${id}/pause`)).status).toBe(202);
    await until("paused", id, (b) => b["status"] === "paused");
    await restart();

    // PATCH /config takes the whole set too (replacing what is held, i.e. nothing).
    const patched = await call("PATCH", `/crawls/${id}/config`, { crawl: maximal });
    expect(patched.status, patched.text.slice(0, 300)).toBe(200);
    expect(held().get(id)).toEqual(maximal);
    await restart();

    const resumed = await call("POST", `/crawls/${id}/resume`, maximal);
    expect(resumed.status, resumed.text.slice(0, 300)).toBe(202);
    expect((await until("finished", id, settled))["status"]).toBe("finished");
    expect(await refusedRows(id)).toBe(0);
    expect(await okRows(id)).toBe(30);

    const capped = await call("POST", `/crawls/${id}/fail`, { pad: "x".repeat(100 * 1024) });
    expect(capped.status).toBe(413);
    expect(String(capped.body["error"])).toContain(String(64 * 1024));
    for (const r of [patched, resumed]) expectNoSecret(r.text, "an answer");
    expectNoSecret(serverLog.join("\n"), "the server log");
  }, 120_000);

  it("a refused render leaves the held credentials as they were: a later resume without them still gets through", async () => {
    const id = await start({ siteUrl: `${site}/auth/`, maxPages: 30, httpAuth: AUTH });
    await until("running with pages", id, (b) => b["status"] === "running" && (b["frontier"] as { done: number }).done >= 1);
    expect((await call("POST", `/crawls/${id}/pause`)).status).toBe(202);
    await until("paused", id, (b) => b["status"] === "paused");

    const wrong = { username: USERNAME, password: "mistyped-S3CRET" };
    const refused = await call("POST", `/crawls/${id}/render`, { urls: [`${site}/auth/never-crawled`], httpAuth: wrong });
    expect(refused.status, refused.text).toBe(400);
    expectNoSecret(refused.text, "the render refusal");
    expect(held().get(id)).toEqual({ httpAuth: AUTH });

    const resumed = await call("POST", `/crawls/${id}/resume`);
    expect(resumed.status, resumed.text).toBe(202);
    expect((await until("finished", id, settled))["status"]).toBe("finished");
    expect(await refusedRows(id)).toBe(0);
    expect(await okRows(id)).toBe(30);
  }, 120_000);

  it("httpAuth null removes Basic auth from the held values and the stored shape", async () => {
    const id = await seedPaused({ requestHeaderNames: [], httpAuth: true, cookieNames: ["sid"] });
    const filled = await call("PATCH", `/crawls/${id}/config`, {
      crawl: { httpAuth: AUTH, cookies: [{ name: "sid", value: COOKIE_VALUE }] },
    });
    expect(filled.status, filled.text).toBe(200);

    const removed = await call("PATCH", `/crawls/${id}/config`, { crawl: { httpAuth: null } });
    expect(removed.status, removed.text).toBe(200);
    expect((await storedConfig(id))["credentialShape"]).toEqual({ requestHeaderNames: [], httpAuth: false, cookieNames: ["sid"] });
    expect(held().get(id)).toEqual({ cookies: [{ name: "sid", value: COOKIE_VALUE }] });
    expect(removed.body["crawl"]).not.toHaveProperty("httpAuth");
    expect((removed.body["crawl"] as Record<string, unknown>)["cookies"]).toEqual([{ name: "sid", value: "[redacted]" }]);

    // Removing what is not there is no change; the other kinds keep refusing null.
    expect((await call("PATCH", `/crawls/${id}/config`, { crawl: { httpAuth: null } })).status).toBe(200);
    const nulled = await call("PATCH", `/crawls/${id}/config`, { crawl: { cookies: null } });
    expect(nulled.status).toBe(400);
    expect(String(nulled.body["error"])).toContain("no unset");

    // The last kind gone, the shape goes with it, and nothing is held.
    expect((await call("PATCH", `/crawls/${id}/config`, { crawl: { cookies: [] } })).status).toBe(200);
    expect(await storedConfig(id)).not.toHaveProperty("credentialShape");
    expect(held().has(id)).toBe(false);

    // On a running crawl a removal is a change, refused while it runs.
    const running = await seedPaused({ requestHeaderNames: [], httpAuth: true, cookieNames: [] }, "running");
    const busy = await call("PATCH", `/crawls/${running}/config`, { crawl: { httpAuth: null } });
    expect(busy.status).toBe(409);
    expect(String(busy.body["error"])).toContain("whenPaused");
    expectNoSecret(filled.text + removed.text, "the answers");
  });

  it("credentials added with crawl_config_set while paused are used by the resumed run", async () => {
    const blocker = await start({ siteUrl: `${site}/slow/`, maxPages: 100_000 });
    await until("the blocker runs", blocker, (b) => b["status"] === "running");
    const id = await start({ siteUrl: `${site}/auth/`, maxPages: 10 });
    expect((await call("POST", `/crawls/${id}/pause`)).status).toBe(200);
    expect([200, 202]).toContain((await call("POST", `/crawls/${blocker}/cancel`)).status);
    await until("the blocker closes", blocker, settled);

    const set = await call("PATCH", `/crawls/${id}/config`, { crawl: { httpAuth: AUTH } });
    expect(set.status, set.text).toBe(200);
    expect((set.body["crawl"] as Record<string, unknown>)["httpAuth"]).toBe("[redacted]");
    expect((await call("POST", `/crawls/${id}/resume`)).status).toBe(202);
    expect((await until("finished", id, settled))["status"]).toBe("finished");
    expect(await refusedRows(id)).toBe(0);
    expect(await okRows(id)).toBe(10);
    expectNoSecret(JSON.stringify(await storedConfig(id)), "config_jsonb");
  }, 120_000);
});

describe("crawl_config_set refuses a scope pattern that can never match (27c final wave I1)", () => {
  it("a path rule without its leading '*', and an origin admission never admits for the site", async () => {
    const id = await seedPaused(null);
    const before = await storedConfig(id);
    const port = new URL(site).port;
    for (const [key, pattern, says] of [
      ["exclude", "/cart*", "'*/cart*'"],
      ["include", `127.0.0.1:${port}/auth/*`, "leading '*'"],
      // An http site on a non-default port is never upgraded to https.
      ["exclude", `https://127.0.0.1:${port}/auth/9*`, `https://127.0.0.1:${port}`],
    ] as const) {
      const res = await call("PATCH", `/crawls/${id}/config`, { crawl: { [key]: [pattern] } });
      expect(res.status, res.text).toBe(400);
      expect(res.body["code"]).toBe("VALIDATION");
      expect(String(res.body["error"])).toContain(`${key} pattern '${pattern}'`);
      expect(String(res.body["error"])).toContain("never match");
      expect(String(res.body["error"])).toContain(says);
    }
    expect(await storedConfig(id)).toEqual(before);
  });
});

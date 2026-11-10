/**
 * Phase 27c T8: the API side of list mode, scope patterns, credentials and the
 * two limits — start-body validation, accepting a list crawl (`list_urls`
 * rows), the 1 MiB body cap on two routes, and the one promise every other
 * assertion here serves: A SECRET NEVER LEAVES. Not in a refusal, not in
 * `config_validate`'s `effective`, not in `crawl_status`, not in
 * `crawl_config_get`, not in `config_jsonb`, not in a log line.
 *
 * Two servers. Server A's queue is held by a blocker crawl of an endless slow
 * tree, so every crawl it accepts afterwards stays QUEUED and nothing is
 * fetched for it; the test cancels each one. Server B's queue is free, and runs
 * one list crawl of credential-gated pages end to end, which is how the test
 * knows the credentials reach the crawl loop (`runQueued`) and not only the map.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, listUrls, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import { LIST_MAX_URLS } from "../../src/api/config-schema.js";
import type { ServiceConfig } from "../../src/api/config.js";

const TOKEN = "test-token-scope-start-0123456789";
const PAGE_DELAY_MS = 100;

/** The secret values: none may appear in any answer, row or log line. */
const HEADER_VALUE = "hdr-S3CRET-value";
const USERNAME = "user-S3CRET";
const PASSWORD = "pw-S3CRET";
const COOKIE_VALUE = "cookie-S3CRET";
const BASIC = Buffer.from(`${USERNAME}:${PASSWORD}`, "utf8").toString("base64");
const SECRETS = [HEADER_VALUE, USERNAME, PASSWORD, COOKIE_VALUE, BASIC, "S3CRET"];

const CREDENTIALS = {
  requestHeaders: { "X-Tenant": HEADER_VALUE },
  httpAuth: { username: USERNAME, password: PASSWORD },
  cookies: [{ name: "sid", value: COOKIE_VALUE }],
};

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
let apiA: ApiServer;
let baseA: string;
let apiB: ApiServer;
let baseB: string;
let mcp: AriadneMcpServer;
let client: Client;
let blocker = "";
const serverLog: string[] = [];
const createdCrawls: string[] = [];
/** The credential headers each gated request arrived with, by path. */
const gateSeen = new Map<string, IncomingHttpHeaders>();

interface Res {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

async function call(base: string, method: string, path: string, body?: unknown, raw?: string): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const a = (method: string, path: string, body?: unknown, raw?: string) => call(baseA, method, path, body, raw);

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: content.map((c) => c.text).join("\n") };
}

async function statusOf(id: string): Promise<string> {
  const rows = await db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, id));
  const row = rows[0];
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row.status;
}

async function untilStatus(id: string, predicate: (status: string) => boolean): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await statusOf(id);
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`crawl ${id} stuck at ${status}`);
    await sleep(20);
  }
}

/** Accept a body on server A, which must leave it queued; returns the id. */
async function acceptQueued(body: Record<string, unknown>): Promise<{ id: string; res: Res }> {
  const res = await a("POST", "/crawls", body);
  expect(res.status, res.text.slice(0, 500)).toBe(202);
  const id = String(res.body["crawlId"]);
  createdCrawls.push(id);
  expect(await statusOf(id)).toBe("queued");
  return { id, res };
}

async function cancel(id: string): Promise<void> {
  const res = await a("POST", `/crawls/${id}/cancel`);
  expect(res.status, res.text).toBe(200);
}

/** A list of `count` distinct URLs on the site, each padded to `pad` characters of query. */
function listOf(count: number, pad: number): string[] {
  return Array.from({ length: count }, (_u, i) => `${site}/p/${i}?pad=${"x".repeat(pad)}`);
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-scope-start-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-scope-start-render-"));

  siteServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path.startsWith("/gate/")) {
      gateSeen.set(path, req.headers);
      const ok =
        req.headers["x-tenant"] === HEADER_VALUE &&
        req.headers["authorization"] === `Basic ${BASIC}` &&
        req.headers["cookie"] === `sid=${COOKIE_VALUE}`;
      res.writeHead(ok ? 200 : 401, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><head><title>Gate ${path}</title></head><body>ok</body></html>`);
      return;
    }
    // An endless slow tree: the blocker crawl that holds server A's queue.
    const m = /^\/slow\/(\d+)$/.exec(path);
    if (path === "/slow/" || m !== null) {
      const n = m === null ? 0 : Number(m[1]);
      const links = Array.from({ length: 10 }, (_, i) => `<a href="/slow/${n * 10 + i + 1}">s</a>`).join("");
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="en"><head><title>Slow ${n}</title></head><body>${links}</body></html>`);
      }, PAGE_DELAY_MS);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><title>Page ${path}</title></head><body>p</body></html>`);
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;

  const config: ServiceConfig = {
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: (line) => serverLog.push(line),
  };
  apiA = createApiServer({ db, config: { ...config, token: TOKEN } });
  baseA = `http://127.0.0.1:${(await apiA.listen(0)).port}`;
  apiB = createApiServer({ db, config: { ...config, token: TOKEN } });
  baseB = `http://127.0.0.1:${(await apiB.listen(0)).port}`;
  mcp = createMcpServer({ db, config });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-scope-start", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  const started = await a("POST", "/crawls", { siteUrl: `${site}/slow/`, maxPages: 100_000, maxConcurrency: 1 });
  if (started.status !== 202) throw new Error(`blocker: ${started.status} ${started.text}`);
  blocker = String(started.body["crawlId"]);
  createdCrawls.push(blocker);
  await untilStatus(blocker, (s) => s === "running");
}, 60_000);

afterAll(async () => {
  if (blocker !== "") {
    await a("POST", `/crawls/${blocker}/cancel`);
    await untilStatus(blocker, (s) => s !== "running" && s !== "queued");
  }
  await client.close();
  await mcp.close();
  await apiA.close();
  await apiB.close();
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
}, 60_000);

describe("the list's size and the body cap", () => {
  it("refuses a list of 10,001 URLs", async () => {
    const res = await a("POST", "/crawls", { siteUrl: `${site}/`, mode: "list", urls: listOf(LIST_MAX_URLS + 1, 0) });
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("VALIDATION");
    expect(String(res.body["error"])).toContain("urls");
    expect(String(res.body["error"])).toContain(String(LIST_MAX_URLS));
  });

  it("413s a 1.5 MiB body to POST /crawls, and accepts 900 KiB carrying 10,000 URLs", async () => {
    const big = JSON.stringify({ siteUrl: `${site}/`, mode: "list", urls: listOf(LIST_MAX_URLS, 140) });
    expect(big.length).toBeGreaterThan(1.5 * 1024 * 1024);
    const tooLarge = await a("POST", "/crawls", undefined, big);
    expect(tooLarge.status).toBe(413);
    expect(String(tooLarge.body["error"])).toContain(String(1024 * 1024));

    const body = { siteUrl: `${site}/`, mode: "list", urls: listOf(LIST_MAX_URLS, 55) };
    const text = JSON.stringify(body);
    expect(text.length).toBeGreaterThan(850 * 1024);
    expect(text.length).toBeLessThan(1024 * 1024);

    const checked = await a("POST", "/config/validate", undefined, text);
    expect(checked.status).toBe(200);
    expect(checked.body["valid"], JSON.stringify(checked.body["errors"])).toBe(true);
    expect(checked.body["effective"]).toMatchObject({ mode: "list", listUrlCount: LIST_MAX_URLS, maxPages: 2 * LIST_MAX_URLS });

    const res = await a("POST", "/crawls", undefined, text);
    expect(res.status, res.text.slice(0, 300)).toBe(202);
    const id = String(res.body["crawlId"]);
    createdCrawls.push(id);
    expect(res.body).toMatchObject({ status: "queued", listUrlCount: LIST_MAX_URLS, listDuplicates: 0 });
    const rows = await db
      .select({ position: listUrls.position, url: listUrls.url })
      .from(listUrls)
      .where(eq(listUrls.crawlId, id))
      .orderBy(asc(listUrls.position));
    expect(rows).toHaveLength(LIST_MAX_URLS);
    expect(rows[0]).toEqual({ position: 0, url: body.urls[0] });
    expect(rows[LIST_MAX_URLS - 1]).toEqual({ position: LIST_MAX_URLS - 1, url: body.urls[LIST_MAX_URLS - 1] });
    await cancel(id);
  }, 60_000);

  it("still 413s a 100 KiB body to POST /crawls/:id/rules", async () => {
    const res = await a("POST", `/crawls/${blocker}/rules`, { pad: "x".repeat(100 * 1024) });
    expect(res.status).toBe(413);
    expect(String(res.body["error"])).toContain(String(64 * 1024));
  });
});

describe("what a start refuses", () => {
  it("refuses an off-site URL, an excluded listed URL, an excluded seed, a typo'd host and maxPages below the list", async () => {
    const seed = `${site}/`;
    const cases: Array<{ name: string; body: Record<string, unknown>; path: string; code: string; says: string[] }> = [
      {
        name: "a listed URL on another site",
        body: { siteUrl: seed, mode: "list", urls: [`${site}/p/1`, "https://other.example/x"] },
        path: "urls",
        code: "invalid",
        says: ["other.example", "span"],
      },
      {
        name: "an excluded listed URL",
        body: { siteUrl: seed, mode: "list", urls: [`${site}/private/a`], exclude: ["*/private/*"] },
        path: "urls",
        code: "invalid",
        says: [`${site}/private/a`, "*/private/*"],
      },
      {
        name: "a listed URL no include pattern admits",
        body: { siteUrl: seed, mode: "list", urls: [`${site}/blog/a`], include: ["*/shop/*"] },
        path: "urls",
        code: "invalid",
        says: [`${site}/blog/a`, "include"],
      },
      {
        name: "an excluded seed",
        body: { siteUrl: seed, exclude: [`${site}/*`] },
        path: "exclude",
        code: "invalid",
        says: [`${site}/*`, "seed"],
      },
      {
        name: "a pattern naming typo.example",
        body: { siteUrl: seed, exclude: ["https://typo.example/*"] },
        path: "exclude",
        code: "invalid",
        says: ["typo.example"],
      },
      {
        name: "maxPages below the list",
        body: { siteUrl: seed, mode: "list", urls: [`${site}/p/1`, `${site}/p/2`, `${site}/p/3`], maxPages: 2 },
        path: "maxPages",
        code: "out_of_range",
        says: ["maxPages", "3"],
      },
      {
        name: "mode list without urls",
        body: { siteUrl: seed, mode: "list" },
        path: "urls",
        code: "invalid",
        says: ["urls"],
      },
      {
        name: "urls without mode list",
        body: { siteUrl: seed, urls: [`${site}/p/1`] },
        path: "urls",
        code: "invalid",
        says: ["mode"],
      },
      {
        name: "an empty sitemapUrls on a list crawl",
        body: { siteUrl: seed, mode: "list", urls: [`${site}/p/1`], sitemapUrls: [] },
        path: "sitemapUrls",
        code: "invalid",
        says: ["sitemapUrls"],
      },
    ];
    for (const c of cases) {
      const checked = await a("POST", "/config/validate", c.body);
      expect(checked.body["valid"], c.name).toBe(false);
      const first = (checked.body["errors"] as { path: string; code: string; message: string }[])[0];
      expect(first?.path, c.name).toBe(c.path);
      expect(first?.code, c.name).toBe(c.code);
      for (const phrase of c.says) expect(first?.message, `${c.name}: ${first?.message}`).toContain(phrase);

      const res = await a("POST", "/crawls", c.body);
      expect(res.status, c.name).toBe(400);
      expect(res.body, c.name).toEqual({ error: first?.message, code: "VALIDATION" });
    }
  });

  it("refuses a listed URL the URL policy refuses, as FORBIDDEN", async () => {
    // Over the crawl's own maxUrlLength: url-policy's `too_long`.
    const long = `${site}/p/${"y".repeat(400)}`;
    const body = { siteUrl: `${site}/`, mode: "list", urls: [long], maxUrlLength: 256 };
    const checked = await a("POST", "/config/validate", body);
    const first = (checked.body["errors"] as { path: string; code: string; message: string }[])[0];
    expect(first).toMatchObject({ path: "urls", code: "url_policy" });
    expect(first?.message).toContain("too_long");
    const res = await a("POST", "/crawls", body);
    expect(res.status).toBe(403);
    expect(res.body["code"]).toBe("FORBIDDEN");
  });
});

describe("a list with duplicates", () => {
  it("collapses two spellings of one URL, counts it, and stores the distinct URLs in order", async () => {
    const urls = [`${site}/p/b?y=2&x=1`, `${site}/p/a`, `${site}/p/b?x=1&y=2#top`, `${site}/p/c`];
    const { id, res } = await acceptQueued({ siteUrl: `${site}/`, mode: "list", urls });
    expect(res.body).toMatchObject({ listUrlCount: urls.length - 1, listDuplicates: 1 });
    const rows = await db
      .select({ position: listUrls.position, url: listUrls.url })
      .from(listUrls)
      .where(eq(listUrls.crawlId, id))
      .orderBy(asc(listUrls.position));
    expect(rows).toEqual([
      { position: 0, url: `${site}/p/b?x=1&y=2` },
      { position: 1, url: `${site}/p/a` },
      { position: 2, url: `${site}/p/c` },
    ]);
    const [row] = await db.select({ config: crawls.config }).from(crawls).where(eq(crawls.id, id));
    expect(row?.config).toMatchObject({ mode: "list", listUrlCount: 3, listDuplicates: 1, maxPages: 6 });
    expect(row?.config).not.toHaveProperty("urls");
    await cancel(id);
  });
});

describe("the secret never leaves", () => {
  it("refuses an invalid credential set with a body that quotes no secret, on both transports", async () => {
    const body = {
      siteUrl: `${site}/`,
      ...CREDENTIALS,
      requestHeaders: { "X-Tenant": `${HEADER_VALUE}\nX-Injected: 1` },
    };
    const res = await a("POST", "/crawls", body);
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("VALIDATION");
    expect(String(res.body["error"])).toContain("X-Tenant");
    expectNoSecret(res.text, "the HTTP refusal");

    const checked = await a("POST", "/config/validate", body);
    expect(checked.body["valid"]).toBe(false);
    expectNoSecret(checked.text, "config_validate's refusal");

    const viaTool = await tool("crawl_start", body);
    expect(viaTool.isError).toBe(true);
    expectNoSecret(viaTool.text, "crawl_start's refusal");
    const validated = await tool("config_validate", { config: body });
    expectNoSecret(validated.text, "MCP config_validate's refusal");

    // A cookie value and a password the rules refuse, too.
    for (const bad of [
      { cookies: [{ name: "sid", value: `${COOKIE_VALUE};x` }] },
      { httpAuth: { username: `${USERNAME}:x`, password: PASSWORD } },
    ]) {
      const refused = await a("POST", "/crawls", { siteUrl: `${site}/`, ...bad });
      expect(refused.status).toBe(400);
      expectNoSecret(refused.text, JSON.stringify(Object.keys(bad)));
    }
    expectNoSecret(serverLog.join("\n"), "the server log");
  });

  it("accepts a valid set and shows no value in crawl_status, effective, crawl_config_get, the row or the log", async () => {
    const body = { siteUrl: `${site}/`, ...CREDENTIALS };
    const checked = await a("POST", "/config/validate", body);
    expect(checked.body["valid"], checked.text).toBe(true);
    expectNoSecret(checked.text, "config_validate's effective");
    const shape = { requestHeaderNames: ["x-tenant"], httpAuth: true, cookieNames: ["sid"] };
    expect(checked.body["effective"]).toMatchObject({ credentialShape: shape });
    for (const key of ["requestHeaders", "httpAuth", "cookies", "credentials"]) {
      expect(checked.body["effective"], key).not.toHaveProperty(key);
    }

    const { id, res } = await acceptQueued(body);
    expectNoSecret(res.text, "the 202");
    const status = await a("GET", `/crawls/${id}`);
    expect(status.status).toBe(200);
    expectNoSecret(status.text, "crawl_status");
    const config = await a("GET", `/crawls/${id}/config`);
    expect(config.status, config.text).toBe(200);
    expectNoSecret(config.text, "crawl_config_get");

    const [row] = await db.select({ config: crawls.config }).from(crawls).where(eq(crawls.id, id));
    expectNoSecret(JSON.stringify(row?.config), "config_jsonb");
    expect((row?.config as Record<string, unknown>)["credentialShape"]).toEqual(shape);
    await cancel(id);
    expectNoSecret(serverLog.join("\n"), "the server log");
  });

  it("takes a credential in a crawl_config_set patch into memory, never into the row (27c T9)", async () => {
    const { id } = await acceptQueued({ siteUrl: `${site}/` });
    const res = await a("PATCH", `/crawls/${id}/config`, { crawl: { requestHeaders: { "x-tenant": HEADER_VALUE } } });
    expect(res.status, res.text).toBe(200);
    expectNoSecret(res.text, "the patch answer");
    const [row] = await db.select({ config: crawls.config }).from(crawls).where(eq(crawls.id, id));
    expectNoSecret(JSON.stringify(row?.config), "config_jsonb after the patch");
    await cancel(id);
  });
});

describe("the credentials reach the crawl", () => {
  it("runs a list crawl of gated pages with them, and every listed page answers 200", async () => {
    const urls = [`${site}/gate/one`, `${site}/gate/two`];
    const res = await call(baseB, "POST", "/crawls", { siteUrl: `${site}/`, mode: "list", urls, ...CREDENTIALS });
    expect(res.status, res.text).toBe(202);
    const id = String(res.body["crawlId"]);
    createdCrawls.push(id);
    expect(await untilStatus(id, (s) => s !== "queued" && s !== "running")).toBe("finished");

    const rows = await db
      .select({ url: pages.url, statusCode: pages.statusCode })
      .from(pages)
      .where(eq(pages.crawlId, id))
      .orderBy(asc(pages.url));
    expect(rows.filter((r) => urls.includes(r.url))).toEqual([
      { url: `${site}/gate/one`, statusCode: 200 },
      { url: `${site}/gate/two`, statusCode: 200 },
    ]);
    expect(gateSeen.get("/gate/one")?.["x-tenant"]).toBe(HEADER_VALUE);
    const [row] = await db.select({ config: crawls.config }).from(crawls).where(eq(crawls.id, id));
    expectNoSecret(JSON.stringify(row?.config), "config_jsonb after the run");
    expectNoSecret(serverLog.join("\n"), "the server log after the run");
  }, 60_000);
});

describe("a scope pattern that can never match (27c final wave I1)", () => {
  it("refuses a path rule without its leading '*' and an http pattern on an https site, on both transports", async () => {
    const port = new URL(site).port;
    const cases: Array<{ name: string; body: Record<string, unknown>; path: string; says: string[] }> = [
      {
        name: "a path rule with no leading '*'",
        body: { siteUrl: `${site}/`, exclude: ["/cart*"] },
        path: "exclude",
        says: ["/cart*", "never match", "'*/cart*'"],
      },
      {
        name: "a host-and-path rule with no scheme",
        body: { siteUrl: `${site}/`, include: ["*/p/*", `127.0.0.1:${port}/*`] },
        path: "include",
        says: [`127.0.0.1:${port}/*`, "leading '*'"],
      },
      {
        name: "an http pattern on an https site",
        body: { siteUrl: `https://127.0.0.1:${port}/`, exclude: [`http://127.0.0.1:${port}/blog/*`] },
        path: "exclude",
        says: [`http://127.0.0.1:${port}`, "never match"],
      },
    ];
    for (const c of cases) {
      const checked = await a("POST", "/config/validate", c.body);
      expect(checked.body["valid"], c.name).toBe(false);
      const first = (checked.body["errors"] as { path: string; code: string; message: string }[])[0];
      expect(first?.path, `${c.name}: ${checked.text}`).toBe(c.path);
      expect(first?.code, c.name).toBe("invalid");
      for (const phrase of c.says) expect(first?.message, `${c.name}: ${first?.message}`).toContain(phrase);

      const res = await a("POST", "/crawls", c.body);
      expect(res.status, c.name).toBe(400);
      expect(res.body, c.name).toEqual({ error: first?.message, code: "VALIDATION" });

      const viaTool = await tool("crawl_start", c.body);
      expect(viaTool.isError, c.name).toBe(true);
      expect(viaTool.text, c.name).toContain("never match");
      const validated = await tool("config_validate", { config: c.body });
      expect(validated.text, c.name).toContain("never match");
    }
  });
});

describe("a secret smuggled into a credential NAME (27c final wave M13)", () => {
  it("is never echoed: each refusal names the position, on HTTP and MCP, start, validate, set and resume", async () => {
    const probes: Array<{ fields: Record<string, unknown>; says: string }> = [
      { fields: { cookies: [{ name: "session=S3CRET", value: "" }] }, says: "cookies[0].name" },
      { fields: { requestHeaders: { "Authorization: Bearer S3CRET": "" } }, says: "requestHeaders entry 1" },
      { fields: { httpAuth: { username: "u", password: "p", "x-S3CRET": "" } }, says: "httpAuth has an unknown field (key 3" },
    ];
    const { id } = await acceptQueued({ siteUrl: `${site}/` });
    for (const { fields, says } of probes) {
      const name = JSON.stringify(fields);
      const body = { siteUrl: `${site}/`, ...fields };
      const started = await a("POST", "/crawls", body);
      expect(started.status, name).toBe(400);
      expect(String(started.body["error"]), name).toContain(says);
      const answers: Array<[string, string]> = [
        ["POST /crawls", started.text],
        ["POST /config/validate", (await a("POST", "/config/validate", body)).text],
        ["PATCH config", (await a("PATCH", `/crawls/${id}/config`, { crawl: fields })).text],
        ["POST resume", (await a("POST", `/crawls/${id}/resume`, fields)).text],
      ];
      const viaStart = await tool("crawl_start", body);
      expect(viaStart.isError, name).toBe(true);
      expect(viaStart.text, name).toContain(says);
      answers.push(["MCP crawl_start", viaStart.text]);
      answers.push(["MCP config_validate", (await tool("config_validate", { config: body })).text]);
      const viaSet = await tool("crawl_config_set", { crawlId: id, crawl: fields });
      expect(viaSet.isError, name).toBe(true);
      answers.push(["MCP crawl_config_set", viaSet.text]);
      const viaResume = await tool("crawl_resume", { crawlId: id, ...fields });
      expect(viaResume.isError, name).toBe(true);
      answers.push(["MCP crawl_resume", viaResume.text]);
      for (const [where, text] of answers) {
        expect(text, `${where} ${name}`).not.toContain("S3CRET");
      }
    }
    expectNoSecret(serverLog.join("\n"), "the server log");
    await cancel(id);
  });
});

describe("what a list crawl did not measure, on every listing (27c final wave M16)", () => {
  it("issues_list and metrics_get name a skipped rule in notMeasured, on HTTP and MCP, and never read it as clean", async () => {
    const res = await call(baseB, "POST", "/crawls", { siteUrl: `${site}/`, mode: "list", urls: [`${site}/p/1`, `${site}/p/2`] });
    expect(res.status, res.text).toBe(202);
    const id = String(res.body["crawlId"]);
    createdCrawls.push(id);
    expect(await untilStatus(id, (s) => s !== "queued" && s !== "running")).toBe("finished");
    const judged = await call(baseB, "POST", `/crawls/${id}/rules`);
    expect(judged.status, judged.text).toBe(200);

    // A skipped finding rule and a skipped metric: no sitemap read, so the
    // needsSitemaps rules are skipped beside the needsSpider ones.
    const issues = await a("GET", `/crawls/${id}/issues?ruleId=links.orphan`);
    expect(issues.status, issues.text).toBe(200);
    expect(issues.body["items"]).toEqual([]);
    const notMeasured = issues.body["notMeasured"] as string[];
    for (const ruleId of ["links.orphan", "inlinks.distribution", "sitemap.invalid"]) {
      expect(notMeasured, ruleId).toContain(ruleId);
    }
    expect(notMeasured).not.toContain("links.broken-internal");
    expect([...notMeasured].sort()).toEqual(notMeasured);
    expect(issues.body["disabledRules"]).toEqual([]);
    const viaIssues = JSON.parse((await tool("issues_list", { crawlId: id, ruleId: "links.orphan" })).text) as Record<string, unknown>;
    expect(viaIssues["items"]).toEqual([]);
    expect(viaIssues["notMeasured"]).toEqual(notMeasured);

    const metrics = await a("GET", `/crawls/${id}/metrics?metricId=inlinks.distribution`);
    expect(metrics.status, metrics.text).toBe(200);
    expect(metrics.body["items"]).toEqual([]);
    expect(metrics.body["notMeasured"]).toEqual(notMeasured);
    const viaMetrics = JSON.parse((await tool("metrics_get", { crawlId: id, metricId: "inlinks.distribution" })).text) as Record<string, unknown>;
    expect(viaMetrics["items"]).toEqual([]);
    expect(viaMetrics["notMeasured"]).toEqual(notMeasured);

    // The overview lists no skipped rule as a zero row, and names them.
    const overview = await a("GET", `/crawls/${id}/overview/issues?includeZero=true`);
    expect(overview.status, overview.text).toBe(200);
    expect(overview.body["notMeasured"]).toEqual(notMeasured);
    const rowIds = (overview.body["rows"] as { ruleId: string }[]).map((r) => r.ruleId);
    for (const ruleId of notMeasured) expect(rowIds, ruleId).not.toContain(ruleId);
    expect(rowIds).toContain("crawl.list-mode");

    // A rule-scoped table of a skipped rule is refused, as a disabled one is.
    const urls = await a("GET", `/crawls/${id}/issues/links.orphan/urls`);
    expect(urls.status, urls.text).toBe(409);
    expect(String(urls.body["error"])).toContain("not measured");
    expect(String(urls.body["error"])).toContain("crawl.list-mode");
    // One metric's table says why it is empty: nobody measured it.
    const table = await a("GET", `/crawls/${id}/metrics/inlinks.distribution`);
    expect(table.status, table.text).toBe(200);
    expect(String(table.body["note"])).toContain("not measured");

    // The issues export names them too.
    const exported = await a("GET", `/crawls/${id}/export?dataset=issues`);
    expect(exported.status, exported.text).toBe(200);
    expect(exported.body["notMeasured"]).toEqual(notMeasured);

    // A spider crawl measures everything: an empty list, never absent.
    const spider = await a("GET", `/crawls/${blocker}/issues`);
    expect(spider.body["notMeasured"]).toEqual([]);
  }, 60_000);
});

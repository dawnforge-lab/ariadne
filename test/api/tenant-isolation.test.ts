/**
 * The tenant sentinel (Phase 28a T3): no route or tool is left unscoped.
 *
 * COVERAGE IS DRIVEN BY ENUMERATION. The union of `SCOPED_CASES`,
 * `GLOBAL_ROUTES` and `GLOBAL_TOOLS` must equal every route `buildRoutes()`
 * declares plus every name in `TOOL_NAMES`, so a route or tool added later
 * without a case here fails by name. Every scoped case, made as `beta` against
 * `acme`'s crawl, must answer exactly as it does against a crawl that does not
 * exist, and must change nothing of `acme`'s.
 *
 * "Same timing class" is deliberately not measured (plan Deviation 3).
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, links, metrics, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, routeSignatures, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, TOOL_NAMES, type AriadneMcpServer } from "../../src/api/mcp.js";
import { parseTenant, type TenantId } from "../../src/tenant.js";

const TOKEN = "test-token-isolation-0123456789abcdef";
const RUN = randomUUID().slice(0, 8);
const ACME: TenantId = parseTenant(`acme-${RUN}`);
const BETA: TenantId = parseTenant(`beta-${RUN}`);
const BETA_ONLY_HOST = "beta-only.example";

interface HttpCase {
  method: string;
  path: string;
  body?: unknown;
}
type HttpBuilder = (crawlId: string, otherCrawlId: string) => HttpCase;
type ToolBuilder = (crawlId: string, otherCrawlId: string) => Record<string, unknown>;

/**
 * Routes and tools that are NOT scoped to a crawl, and why. Nothing else may be
 * added here without a reason a reviewer would accept.
 */
const GLOBAL_ROUTES: ReadonlySet<string> = new Set([
  "GET /config/schema", // static JSON schema
  "POST /config/validate", // dry run of a body; reads no crawl
  "POST /crawls", // creates a crawl FOR the caller
  "GET /crawls", // the caller's own listing, asserted separately below
]);
const GLOBAL_TOOLS: ReadonlySet<string> = new Set(["config_schema", "config_validate", "crawl_start", "crawl_list"]);

const crawlRoute =
  (method: string, suffix: string, body?: unknown): HttpBuilder =>
  (c) => ({ method, path: `/crawls/${c}${suffix}`, ...(body === undefined ? {} : { body }) });

const SCOPED_ROUTES: Record<string, HttpBuilder> = {
  "GET /crawls/:id": crawlRoute("GET", ""),
  "DELETE /crawls/:id": (c) => ({ method: "DELETE", path: `/crawls/${c}?confirm=${c}` }),
  "POST /crawls/:id/fail": crawlRoute("POST", "/fail"),
  "POST /crawls/:id/resume": crawlRoute("POST", "/resume"),
  "POST /crawls/:id/pause": crawlRoute("POST", "/pause"),
  "POST /crawls/:id/cancel": crawlRoute("POST", "/cancel"),
  "POST /crawls/:id/render": crawlRoute("POST", "/render"),
  "POST /crawls/:id/rules": crawlRoute("POST", "/rules"),
  "GET /crawls/:id/config": crawlRoute("GET", "/config"),
  "PATCH /crawls/:id/config": crawlRoute("PATCH", "/config", { judgement: { rules: null } }),
  "GET /crawls/:id/issues": crawlRoute("GET", "/issues"),
  "GET /crawls/:id/issues/:ruleId/urls": crawlRoute("GET", "/issues/title.missing/urls"),
  "GET /crawls/:id/issues/:ruleId/inlinks": crawlRoute("GET", "/issues/links.broken-internal/inlinks"),
  "GET /crawls/:id/metrics": crawlRoute("GET", "/metrics"),
  "GET /crawls/:id/overview/issues": crawlRoute("GET", "/overview/issues"),
  "GET /crawls/:id/overview/crawl": crawlRoute("GET", "/overview/crawl"),
  "GET /crawls/:id/metrics/:metricId": crawlRoute("GET", "/metrics/site.health"),
  "GET /crawls/:id/pages": crawlRoute("GET", "/pages"),
  "GET /crawls/:id/robots": crawlRoute("GET", "/robots"),
  "GET /crawls/:id/export": crawlRoute("GET", "/export?dataset=pages"),
  // Exercised WITH crawlId (ruling R1): the catalog resolves the crawl's ruleset.
  "GET /rules": (c) => ({ method: "GET", path: `/rules?crawlId=${c}` }),
  "GET /compare": (c, o) => ({ method: "GET", path: `/compare?baseCrawlId=${c}&headCrawlId=${o}` }),
  "GET /compare/urls": (c, o) => ({
    method: "GET",
    path: `/compare/urls?baseCrawlId=${c}&headCrawlId=${o}&ruleId=title.missing&set=new`,
  }),
};

const only = (crawlId: string): Record<string, unknown> => ({ crawlId });
const SCOPED_TOOLS: Record<string, ToolBuilder> = {
  crawl_status: only,
  crawl_mark_failed: only,
  crawl_resume: only,
  crawl_pause: only,
  crawl_cancel: only,
  crawl_delete: (c) => ({ crawlId: c, confirm: c }),
  crawl_render: only,
  crawl_rules: only,
  crawl_config_get: only,
  crawl_config_set: (c) => ({ crawlId: c, judgement: { rules: null } }),
  robots_get: only,
  issues_list: only,
  issues_overview: only,
  crawl_overview: only,
  issue_urls: (c) => ({ crawlId: c, ruleId: "title.missing" }),
  issue_inlinks: (c) => ({ crawlId: c, ruleId: "links.broken-internal" }),
  metrics_get: only,
  metric_table: (c) => ({ crawlId: c, metricId: "site.health" }),
  pages_query: only,
  export_crawl: (c) => ({ crawlId: c, dataset: "pages" }),
  rules_catalog: only,
  crawl_compare: (c, o) => ({ baseCrawlId: c, headCrawlId: o }),
  compare_urls: (c, o) => ({ baseCrawlId: c, headCrawlId: o, ruleId: "title.missing", set: "new" }),
};

/** Every `METHOD /path` and every tool name that is scoped, with its request builder. */
const SCOPED_CASES: Record<string, HttpBuilder | ToolBuilder> = { ...SCOPED_ROUTES, ...SCOPED_TOOLS };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let exportDir: string;
let renderDir: string;
let siteServer: Server;
let site: string;
let api: ApiServer;
let base: string;
let betaMcp: AriadneMcpServer;
let betaClient: Client;
let acmeCrawl: string;
let acmeOther: string;
let betaCrawl: string;
const createdCrawls: string[] = [];

interface Answer {
  status: number;
  body: unknown;
}

async function http(tenant: string, c: HttpCase): Promise<Answer> {
  const res = await fetch(`${base}${c.path}`, {
    method: c.method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-ariadne-tenant": tenant,
      ...(c.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as unknown) };
}

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<Answer> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const first = content[0];
  if (first === undefined) throw new Error(`${name} answered with no content`);
  // `status` carries the tool's error flag: 0 ok, 1 tool error.
  return { status: result.isError === true ? 1 : 0, body: JSON.parse(first.text) as unknown };
}

function substituted(answer: Answer, from: string, to: string): Answer {
  return JSON.parse(JSON.stringify(answer).split(from).join(to)) as Answer;
}

async function settle(tenant: TenantId, crawlId: string): Promise<void> {
  const until = Date.now() + 30_000;
  for (;;) {
    const res = await http(tenant, { method: "GET", path: `/crawls/${crawlId}` });
    const status = (res.body as Record<string, unknown>)["status"];
    if (status === "finished") return;
    if (status === "failed" || status === "cancelled") throw new Error(`crawl ${crawlId} ended ${String(status)}`);
    if (Date.now() > until) throw new Error(`crawl ${crawlId} still ${String(status)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startAs(tenant: TenantId): Promise<string> {
  const started = await http(tenant, {
    method: "POST",
    path: "/crawls",
    body: { siteUrl: `${site}/`, maxPages: 5, maxConcurrency: 1 },
  });
  expect(started.status).toBe(202);
  const id = String((started.body as Record<string, unknown>)["crawlId"]);
  createdCrawls.push(id);
  await settle(tenant, id);
  return id;
}

/** Everything about a crawl a refused command could have touched. */
async function snapshot(crawlId: string): Promise<unknown> {
  const count = async (table: typeof pages | typeof issues | typeof metrics | typeof links): Promise<number> => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.crawlId, crawlId));
    return row?.n ?? -1;
  };
  const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
  return {
    row,
    pages: await count(pages),
    issues: await count(issues),
    metrics: await count(metrics),
    links: await count(links),
  };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-isolation-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-isolation-renders-"));

  siteServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const page = (title: string, body: string): string =>
      `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
    res.writeHead(path === "/" || path === "/a" ? 200 : 404, { "content-type": "text/html" });
    if (path === "/") res.end(page("Home page of the isolation fixture", `<a href="/a">A</a><a href="/gone">Gone</a>`));
    else if (path === "/a") res.end(page("Page A of the isolation fixture", `<a href="/">Home</a>`));
    else res.end("missing");
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const address = siteServer.address();
  site = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  const service = {
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: () => undefined,
  };
  api = createApiServer({ db, config: { ...service, token: TOKEN } });
  const bound = await api.listen(0);
  base = `http://127.0.0.1:${bound.port}`;
  betaMcp = createMcpServer({ db, config: { ...service, tenant: BETA } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  betaClient = new Client({ name: "ariadne-test-isolation", version: "0.0.1" });
  await betaMcp.connect(serverSide);
  await betaClient.connect(clientSide);

  // acme: a finished, judged crawl with findings, metrics and pages, plus a
  // second crawl of the same site for the compare cases.
  acmeCrawl = await startAs(ACME);
  const judged = await http(ACME, { method: "POST", path: `/crawls/${acmeCrawl}/rules` });
  expect(judged.status).toBe(200);
  acmeOther = await startAs(ACME);

  // beta's own crawl, of another site: were a foreign id ever resolved, a
  // compare refusal would say "different sites" and name acme's host.
  betaCrawl = `crawl_${randomUUID()}`;
  await db.insert(crawls).values({
    id: betaCrawl,
    tenantId: BETA,
    siteUrl: `http://${BETA_ONLY_HOST}/`,
    config: { siteUrl: `http://${BETA_ONLY_HOST}/` },
    rulesetVersion: "0.0.0-test",
    status: "finished",
  });
  createdCrawls.push(betaCrawl);
}, 120_000);

afterAll(async () => {
  await betaClient.close();
  await betaMcp.close();
  await api.close();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
  await closeFetchAgents();
  await closeDb(db);
});

describe("coverage: every route and tool is scoped or explicitly global", () => {
  const signatures = routeSignatures().map((r) => `${r.method} ${r.path}`);

  it("enumerates the routes and tools it is checking", () => {
    expect(signatures.length).toBeGreaterThan(20);
    expect(TOOL_NAMES.length).toBeGreaterThan(20);
  });

  it.each(signatures)("route %s has a scoped case or is global", (signature) => {
    const scoped = Object.hasOwn(SCOPED_CASES, signature);
    const global = GLOBAL_ROUTES.has(signature);
    expect(scoped || global, `${signature} has no tenancy case: add it to SCOPED_ROUTES or GLOBAL_ROUTES`).toBe(true);
    expect(scoped && global, `${signature} is both scoped and global`).toBe(false);
  });

  it.each([...TOOL_NAMES])("tool %s has a scoped case or is global", (name) => {
    const scoped = Object.hasOwn(SCOPED_CASES, name);
    const global = GLOBAL_TOOLS.has(name);
    expect(scoped || global, `tool ${name} has no tenancy case: add it to SCOPED_TOOLS or GLOBAL_TOOLS`).toBe(true);
    expect(scoped && global, `tool ${name} is both scoped and global`).toBe(false);
  });

  it("has no case or global entry for a route or tool that does not exist", () => {
    const known = new Set<string>([...signatures, ...TOOL_NAMES]);
    const declared = [...Object.keys(SCOPED_CASES), ...GLOBAL_ROUTES, ...GLOBAL_TOOLS];
    expect(declared.filter((name) => !known.has(name))).toEqual([]);
  });

  it("keeps the global lists to exactly the ruled set", () => {
    expect([...GLOBAL_ROUTES].sort()).toEqual(
      ["GET /config/schema", "GET /crawls", "POST /config/validate", "POST /crawls"].sort(),
    );
    expect([...GLOBAL_TOOLS].sort()).toEqual(["config_schema", "config_validate", "crawl_list", "crawl_start"]);
  });
});

describe("a foreign crawl answers exactly like a missing one, and a refusal writes nothing", () => {
  it("has fixtures worth protecting: pages, findings and metrics", async () => {
    const snap = (await snapshot(acmeCrawl)) as { pages: number; issues: number; metrics: number };
    expect(snap.pages).toBeGreaterThan(0);
    expect(snap.issues).toBeGreaterThan(0);
    expect(snap.metrics).toBeGreaterThan(0);
  });

  it.each(Object.keys(SCOPED_ROUTES))("HTTP %s", async (signature) => {
    const build = SCOPED_ROUTES[signature] as HttpBuilder;
    const before = await snapshot(acmeCrawl);
    const missing = `crawl_${randomUUID()}`;
    const foreign = await http(BETA, build(acmeCrawl, acmeOther));
    const absent = await http(BETA, build(missing, acmeOther));
    expect(foreign.status).toBe(404);
    expect(substituted(foreign, acmeCrawl, missing)).toEqual(absent);
    expect(await snapshot(acmeCrawl)).toEqual(before);
  });

  it.each(Object.keys(SCOPED_TOOLS))("MCP %s", async (name) => {
    const build = SCOPED_TOOLS[name] as ToolBuilder;
    const before = await snapshot(acmeCrawl);
    const missing = `crawl_${randomUUID()}`;
    const foreign = await tool(betaClient, name, build(acmeCrawl, acmeOther));
    const absent = await tool(betaClient, name, build(missing, acmeOther));
    expect(foreign.status).toBe(1);
    expect(foreign.body).toMatchObject({ code: "NOT_FOUND" });
    expect(substituted(foreign, acmeCrawl, missing)).toEqual(absent);
    expect(await snapshot(acmeCrawl)).toEqual(before);
  });

  it("lists only the caller's own crawls, over HTTP and MCP", async () => {
    const ids = (answer: Answer): string[] =>
      (answer.body as { items: { crawlId: string }[] }).items.map((item) => item.crawlId);
    const asBeta = ids(await http(BETA, { method: "GET", path: "/crawls?limit=200" }));
    expect(asBeta).toContain(betaCrawl);
    expect(asBeta).not.toContain(acmeCrawl);
    expect(asBeta).not.toContain(acmeOther);
    const viaMcp = ids(await tool(betaClient, "crawl_list", { limit: 200 }));
    expect(viaMcp).toContain(betaCrawl);
    expect(viaMcp).not.toContain(acmeCrawl);
    const asAcme = ids(await http(ACME, { method: "GET", path: "/crawls?limit=200" }));
    expect(asAcme).toContain(acmeCrawl);
    expect(asAcme).not.toContain(betaCrawl);
  });
});

describe("compare, three ways", () => {
  // Whichever half is acme's, the answer is the foreign-id 404 and never
  // "different sites" naming acme's host.
  const ways: [string, () => [string, string]][] = [
    ["acme's own pair, as beta", () => [acmeCrawl, acmeOther]],
    ["beta's own base, acme's head", () => [betaCrawl, acmeCrawl]],
    ["acme's base, beta's own head", () => [acmeCrawl, betaCrawl]],
  ];

  it.each(ways)("HTTP: %s", async (_label, ids) => {
    const [b, h] = ids();
    const missing = `crawl_${randomUUID()}`;
    // The half that is refused first: base when acme's, else the head.
    const foreignId = b === acmeCrawl ? acmeCrawl : h;
    const swap = (id: string): string => (id === foreignId ? missing : id);
    for (const path of [
      (x: string, y: string) => `/compare?baseCrawlId=${x}&headCrawlId=${y}`,
      (x: string, y: string) => `/compare/urls?baseCrawlId=${x}&headCrawlId=${y}&ruleId=title.missing&set=new`,
    ]) {
      const foreign = await http(BETA, { method: "GET", path: path(b, h) });
      const absent = await http(BETA, { method: "GET", path: path(swap(b), swap(h)) });
      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ code: "NOT_FOUND" });
      expect(JSON.stringify(foreign)).not.toContain("127.0.0.1");
      expect(substituted(foreign, foreignId, missing)).toEqual(absent);
    }
  });

  it.each(ways)("MCP: %s", async (_label, ids) => {
    const [b, h] = ids();
    const missing = `crawl_${randomUUID()}`;
    const foreignId = b === acmeCrawl ? acmeCrawl : h;
    const swap = (id: string): string => (id === foreignId ? missing : id);
    for (const [name, extra] of [
      ["crawl_compare", {}],
      ["compare_urls", { ruleId: "title.missing", set: "new" }],
    ] as const) {
      const foreign = await tool(betaClient, name, { baseCrawlId: b, headCrawlId: h, ...extra });
      const absent = await tool(betaClient, name, { baseCrawlId: swap(b), headCrawlId: swap(h), ...extra });
      expect(foreign.status).toBe(1);
      expect(foreign.body).toMatchObject({ code: "NOT_FOUND" });
      expect(JSON.stringify(foreign)).not.toContain("127.0.0.1");
      expect(substituted(foreign, foreignId, missing)).toEqual(absent);
    }
  });
});

describe("ownership precedes the in-process busy refusals", () => {
  // The service's holds are private sets with no public seam; holding a crawl
  // busy without racing a real run means reaching in. This is the one place a
  // test does, and it only adds and removes acme's crawl id.
  const holds = (): { judging: Set<string>; rendering: Set<string> } =>
    api.service as unknown as { judging: Set<string>; rendering: Set<string> };

  const busyCases: [string, (id: string) => HttpCase][] = [
    ["POST /crawls/:id/rules", (id) => ({ method: "POST", path: `/crawls/${id}/rules` })],
    ["POST /crawls/:id/render", (id) => ({ method: "POST", path: `/crawls/${id}/render` })],
    [
      "PATCH /crawls/:id/config (judgement)",
      (id) => ({ method: "PATCH", path: `/crawls/${id}/config`, body: { judgement: { rules: null } } }),
    ],
    [
      "PATCH /crawls/:id/config (crawl)",
      (id) => ({ method: "PATCH", path: `/crawls/${id}/config`, body: { crawl: { maxPages: 3 } } }),
    ],
    ["POST /crawls/:id/cancel", (id) => ({ method: "POST", path: `/crawls/${id}/cancel` })],
    ["POST /crawls/:id/resume", (id) => ({ method: "POST", path: `/crawls/${id}/resume` })],
    ["DELETE /crawls/:id", (id) => ({ method: "DELETE", path: `/crawls/${id}?confirm=${id}` })],
  ];

  it.each(["judging", "rendering"] as const)(
    "while acme's crawl is held in `%s`, beta still gets the missing answer",
    async (hold) => {
      const set = holds()[hold];
      set.add(acmeCrawl);
      try {
        // Sanity: the hold is real. Acme itself is refused 409 by it.
        const own = await http(ACME, { method: "POST", path: `/crawls/${acmeCrawl}/cancel` });
        expect(own.status).toBe(409);

        const before = await snapshot(acmeCrawl);
        const missing = `crawl_${randomUUID()}`;
        for (const [label, build] of busyCases) {
          const foreign = await http(BETA, build(acmeCrawl));
          const absent = await http(BETA, build(missing));
          expect(foreign.status, label).toBe(404);
          expect(substituted(foreign, acmeCrawl, missing), label).toEqual(absent);
        }
        expect(await snapshot(acmeCrawl)).toEqual(before);
      } finally {
        set.delete(acmeCrawl);
      }
    },
  );
});

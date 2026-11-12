/**
 * Tenancy over both transports (Phase 28a T2): every crawl is owned by one
 * tenant, the HTTP surface reads the caller's tenant from `X-Ariadne-Tenant`
 * (after the bearer check, before routing), the MCP surface is one tenant per
 * process (`ARIADNE_TENANT`), and a crawl outside the caller's tenant answers
 * exactly like a crawl that does not exist.
 *
 * Over the wire: a real HTTP server crawling a small `node:http` site, and a
 * real MCP server on a linked in-memory transport. The tenants are suffixed per
 * run so a leftover row from an earlier run can never satisfy an assertion.
 */
import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import { loadMcpConfig } from "../../src/api/config.js";
import { parseTenant, type TenantId } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

const TOKEN = "test-token-tenancy-0123456789abcdef";
const RUN = randomUUID().slice(0, 8);
const ACME: TenantId = parseTenant(`acme-${RUN}`);
const BETA: TenantId = parseTenant(`beta-${RUN}`);

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
let port: number;
let mcp: AriadneMcpServer;
let client: Client;
const createdCrawls: string[] = [];
const serverLog: string[] = [];

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function as(
  tenant: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-ariadne-tenant": tenant,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/**
 * A request with exactly the header lines given — `fetch` would fold a repeated
 * header into one line and normalise whitespace, which is the thing under test.
 */
function raw(headers: Record<string, string | string[]>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "GET", path: "/crawls", headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const first = content[0];
  if (first === undefined) throw new Error(`${name} answered with no content`);
  return { isError: result.isError === true, body: JSON.parse(first.text) as Record<string, unknown> };
}

async function settle(tenant: TenantId, crawlId: string): Promise<void> {
  const until = Date.now() + 30_000;
  for (;;) {
    const res = await as(tenant, "GET", `/crawls/${crawlId}`);
    const status = res.body["status"];
    if (status === "finished") return;
    if (status === "failed" || status === "cancelled") throw new Error(`crawl ${crawlId} ended ${String(status)}`);
    if (Date.now() > until) throw new Error(`crawl ${crawlId} still ${String(status)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startAs(tenant: TenantId): Promise<string> {
  const started = await as(tenant, "POST", "/crawls", { siteUrl: `${site}/`, maxPages: 5, maxConcurrency: 1 });
  expect(started.status).toBe(202);
  const id = String(started.body["crawlId"]);
  createdCrawls.push(id);
  await settle(tenant, id);
  return id;
}

function listedIds(body: Record<string, unknown>): string[] {
  return (body["items"] as { crawlId: string }[]).map((item) => item.crawlId);
}

/** `body`, serialised with every occurrence of `from` replaced by `to`. */
function substituted(body: unknown, from: string, to: string): unknown {
  return JSON.parse(JSON.stringify(body).split(from).join(to));
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-tenancy-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-tenancy-renders-"));

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
    if (path === "/") res.end(page("Home page of the tenancy fixture", `<a href="/a">A</a>`));
    else if (path === "/a") res.end(page("Page A of the tenancy fixture", `<a href="/">Home</a>`));
    else res.end("missing");
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const address = siteServer.address();
  site = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  const service = {
    credentialKeys: TEST_CREDENTIAL_KEYS,
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: (line: string) => serverLog.push(line),
  };
  api = createApiServer({ db, config: { ...service, token: TOKEN } });
  const bound = await api.listen(0);
  port = bound.port;
  base = `http://127.0.0.1:${bound.port}`;
  mcp = createMcpServer({ db, config: { ...service, tenant: ACME } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-tenancy", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
}, 60_000);

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
  await closeFetchAgents();
  await closeDb(db);
});

describe("the tenant header", () => {
  it("is required after a valid token: no header is 400 TENANT_REQUIRED", async () => {
    const res = await raw({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ code: "TENANT_REQUIRED" });
  });

  it("treats a header of one space as absent (Node trims OWS): 400 TENANT_REQUIRED", async () => {
    const res = await raw({ authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": " " });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ code: "TENANT_REQUIRED" });
  });

  it("refuses the header sent twice as INVALID_TENANT, quoting neither value", async () => {
    const res = await raw({ authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": ["acme", "beta"] });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ code: "INVALID_TENANT" });
    expect(res.text).not.toContain("acme");
    expect(res.text).not.toContain("beta");
  });

  it("is checked after the token: no token and no header is 401", async () => {
    const res = await raw({});
    expect(res.status).toBe(401);
  });

  it("is checked before routing: a refused tenant on an unknown route is 400, not 404", async () => {
    const res = await fetch(`${base}/no/such/route`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "TENANT_REQUIRED" });
  });
});

describe("a crawl outside the caller's tenant", () => {
  let acmeCrawl: string;

  beforeAll(async () => {
    acmeCrawl = await startAs(ACME);
  }, 60_000);

  it("is stored with the caller's tenant", async () => {
    const rows = await db.select({ tenantId: crawls.tenantId }).from(crawls).where(eq(crawls.id, acmeCrawl));
    expect(rows).toEqual([{ tenantId: ACME }]);
  });

  it("is absent from another tenant's listing and present in its own", async () => {
    expect(listedIds((await as(BETA, "GET", "/crawls")).body)).not.toContain(acmeCrawl);
    expect(listedIds((await as(ACME, "GET", "/crawls")).body)).toContain(acmeCrawl);
  });

  it("answers GET /crawls/:id exactly like a crawl that does not exist", async () => {
    const missing = `crawl_${randomUUID()}`;
    const foreign = await as(BETA, "GET", `/crawls/${acmeCrawl}`);
    const absent = await as(BETA, "GET", `/crawls/${missing}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body["code"]).toBe("NOT_FOUND");
    expect(substituted(foreign, acmeCrawl, missing)).toEqual(absent);
  });

  it.each<[string, string, unknown?]>([
    ["GET", "/issues"],
    ["GET", "/issues/title.missing/urls"],
    ["GET", "/issues/links.broken-internal/inlinks"],
    ["GET", "/overview/issues"],
    ["GET", "/overview/crawl"],
    ["GET", "/metrics"],
    ["GET", "/metrics/site.health"],
    ["GET", "/pages"],
    ["GET", "/robots"],
    ["GET", "/config"],
    ["PATCH", "/config", { judgement: { rules: null } }],
    ["GET", "/export?dataset=pages"],
    ["GET", "/export?format=csv&view=pages"],
    ["POST", "/rules"],
    ["POST", "/render"],
    ["POST", "/fail"],
    ["POST", "/pause"],
    ["POST", "/cancel"],
    ["POST", "/resume"],
  ])("answers %s /crawls/:id%s like a missing crawl", async (method, suffix, body) => {
    const missing = `crawl_${randomUUID()}`;
    const foreign = await as(BETA, method, `/crawls/${acmeCrawl}${suffix}`, body);
    const absent = await as(BETA, method, `/crawls/${missing}${suffix}`, body);
    expect(foreign.status).toBe(404);
    expect(substituted(foreign, acmeCrawl, missing)).toEqual(absent);
  });

  it("is refused by the rules catalog like a missing crawl", async () => {
    const missing = `crawl_${randomUUID()}`;
    const foreign = await as(BETA, "GET", `/rules?crawlId=${acmeCrawl}`);
    const absent = await as(BETA, "GET", `/rules?crawlId=${missing}`);
    expect(foreign.status).toBe(404);
    expect(substituted(foreign, acmeCrawl, missing)).toEqual(absent);
  });

  it("is a missing crawl to compare, never a different site", async () => {
    // Beta's own crawl of ANOTHER site: were the foreign id resolved, the
    // refusal would be "different sites" and would name acme's host.
    const betaCrawl = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id: betaCrawl,
      tenantId: BETA,
      siteUrl: "http://beta-only.example/", hostKey: hostKeyOf("http://beta-only.example/"),
      config: { siteUrl: "http://beta-only.example/" },
      rulesetVersion: "0.0.0-test",
      status: "finished",
    });
    createdCrawls.push(betaCrawl);
    const missing = `crawl_${randomUUID()}`;
    for (const path of [
      `/compare?baseCrawlId=${acmeCrawl}&headCrawlId=${betaCrawl}`,
      `/compare/urls?baseCrawlId=${acmeCrawl}&headCrawlId=${betaCrawl}&ruleId=title.missing&set=new`,
    ]) {
      const foreign = await as(BETA, "GET", path);
      const absent = await as(BETA, "GET", path.replace(acmeCrawl, missing));
      expect(foreign.status).toBe(404);
      expect(foreign.body["code"]).toBe("NOT_FOUND");
      expect(JSON.stringify(foreign.body)).not.toContain("127.0.0.1");
      expect(substituted(foreign, acmeCrawl, missing)).toEqual(absent);
    }
  });

  it("writes an export under <exportDir>/<tenant>/, and only its owner deletes it", async () => {
    const exported = await as(ACME, "GET", `/crawls/${acmeCrawl}/export?dataset=pages`);
    expect(exported.status).toBe(200);
    const path = String(exported.body["path"]);
    expect(path.startsWith(join(exportDir, ACME) + sep)).toBe(true);
    expect(await exists(path)).toBe(true);

    const foreign = await as(BETA, "DELETE", `/crawls/${acmeCrawl}?confirm=${acmeCrawl}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body["code"]).toBe("NOT_FOUND");
    expect(await exists(path)).toBe(true);

    const owned = await as(ACME, "DELETE", `/crawls/${acmeCrawl}?confirm=${acmeCrawl}`);
    expect(owned.status).toBe(200);
    expect(owned.body["files"]).toMatchObject({ exports: 1 });
    expect(await exists(path)).toBe(false);
  });
});

describe("the MCP transport", () => {
  it("refuses an invalid ARIADNE_TENANT at boot without quoting it", () => {
    let message = "";
    try {
      loadMcpConfig({ DATABASE_URL: "postgres://x", ARIADNE_TENANT: ".x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("ARIADNE_TENANT");
    expect(message).not.toContain(".x");
  });

  it("refuses an unset ARIADNE_TENANT at boot, naming the variable", () => {
    expect(() => loadMcpConfig({ DATABASE_URL: "postgres://x" })).toThrow(/ARIADNE_TENANT/);
  });

  it("reads a valid ARIADNE_TENANT", () => {
    expect(loadMcpConfig({ DATABASE_URL: "postgres://x", ARIADNE_TENANT: "acme" }).tenant).toBe("acme");
  });

  it("crawl_list lists only the server's tenant's crawls", async () => {
    const acmeCrawl = await startAs(ACME);
    const betaCrawl = await startAs(BETA);
    const listed = await tool("crawl_list", { limit: 200 });
    expect(listed.isError).toBe(false);
    const ids = listedIds(listed.body);
    expect(ids).toContain(acmeCrawl);
    expect(ids).not.toContain(betaCrawl);
    const owners = await db.select({ tenantId: crawls.tenantId }).from(crawls).where(inArray(crawls.id, ids));
    expect(new Set(owners.map((o) => o.tenantId))).toEqual(new Set([ACME]));

    const status = await tool("crawl_status", { crawlId: betaCrawl });
    expect(status.isError).toBe(true);
    expect(status.body["code"]).toBe("NOT_FOUND");
  }, 60_000);
});

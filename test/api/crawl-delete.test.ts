/**
 * `crawl_delete` (Phase 27b T5): every row of a crawl across every table, plus
 * its files, behind a `confirm` echo of the crawl id.
 *
 * Over the wire: a real HTTP server, a real MCP server on a linked in-memory
 * transport, and two real crawls of a small `node:http` site — judged,
 * exported and rendered in a real browser — so "the rows are gone" is measured
 * against rows a real crawl wrote. The table list the assertions walk comes
 * from `information_schema`, not from the constant under test.
 *
 * What a CSV export is NOT: it streams to the client and writes no file, so
 * the only export file a real call leaves in `exportDir` is the JSONL one. The
 * CSV-named file and the stray temp file the delete must also take are written
 * by the test, in the exact names `service.ts` gives them.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, listUrls } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import { CRAWL_CHILD_TABLES, deleteCrawlFiles } from "../../src/api/crawl-delete.js";
import { ApiService, slug } from "../../src/api/service.js";
import { ServiceError } from "../../src/api/errors.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

const TOKEN = "test-token-crawl-delete-0123456789abcdef";

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
let mcp: AriadneMcpServer;
let client: Client;
let service: ApiService;
const createdCrawls: string[] = [];
const serverLog: string[] = [];

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string): Promise<Res> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local" } });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function post(path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const first = content[0];
  if (first === undefined) throw new Error(`${name} answered with no content`);
  return { isError: result.isError === true, body: JSON.parse(first.text) as Record<string, unknown> };
}

/** The tables carrying a `crawl_id`, read from the database itself. */
async function schemaCrawlTables(): Promise<string[]> {
  const result = await db.execute(
    sql`select distinct table_name from information_schema.columns
        where column_name = 'crawl_id' and table_schema = 'public'`,
  );
  return result.rows.map((r) => String((r as { table_name: string }).table_name)).sort();
}

/** Rows per `crawl_id` table for one crawl, from the schema's own table list. */
async function rowCounts(crawlId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await schemaCrawlTables()) {
    // The identifier comes from information_schema, not from a caller.
    const result = await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)} where crawl_id = ${crawlId}`,
    );
    counts[table] = Number((result.rows[0] as { n: number }).n);
  }
  const own = await db.execute(sql`select count(*)::int as n from crawls where id = ${crawlId}`);
  counts["crawls"] = Number((own.rows[0] as { n: number }).n);
  return counts;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function exportFilesOf(crawlId: string): Promise<string[]> {
  return (await readdir(join(exportDir, "local"))).filter((n) => n.startsWith(`${slug(crawlId)}-`));
}

async function settle(crawlId: string): Promise<void> {
  const until = Date.now() + 30_000;
  for (;;) {
    const res = await call("GET", `/crawls/${crawlId}`);
    const status = res.body["status"];
    if (status === "finished") return;
    if (status === "failed" || status === "cancelled") throw new Error(`crawl ${crawlId} ended ${String(status)}`);
    if (Date.now() > until) throw new Error(`crawl ${crawlId} still ${String(status)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Crawl the site, judge it, export JSONL, render one page; plus the two hand-made export files. */
async function fullCrawl(): Promise<string> {
  const started = await post("/crawls", { siteUrl: `${site}/`, maxPages: 20, maxConcurrency: 1 });
  expect(started.status).toBe(202);
  const id = String(started.body["crawlId"]);
  createdCrawls.push(id);
  await settle(id);
  expect((await post(`/crawls/${id}/rules`)).status).toBe(200);
  const exported = await call("GET", `/crawls/${id}/export?dataset=issues`);
  expect(exported.status).toBe(200);
  const rendered = await post(`/crawls/${id}/render`, { urls: [`${site}/a`] });
  expect(rendered.status).toBe(200);
  await writeFile(join(exportDir, "local", `${slug(id)}-pages.csv`), "url\n");
  await writeFile(join(exportDir, "local", `${slug(id)}-issues.jsonl.gz.tmp-1-abc`), "x");
  return id;
}

/** A crawls row written straight into the database. */
async function seedCrawl(row: {
  status: string;
  controlRequest?: string | null;
  pauseReason?: string | null;
}): Promise<string> {
  const id = `crawl_del_${createdCrawls.length}_${randomUUID().slice(0, 8)}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: "http://seeded.example/",
    config: {
      siteUrl: "http://seeded.example/",
      maxPages: 10,
      maxDepth: 3,
      userAgent: "AriadneBot/0.1 (test)",
      perHostDelayMs: 0,
      maxConcurrency: 2,
    },
    rulesetVersion: "0.0.0-test",
    status: row.status,
    ...(row.controlRequest === undefined ? {} : { controlRequest: row.controlRequest }),
    ...(row.pauseReason === undefined ? {} : { pauseReason: row.pauseReason }),
  });
  createdCrawls.push(id);
  return id;
}

async function seedLease(crawlId: string): Promise<void> {
  await db.insert(frontier).values({
    crawlId,
    url: "http://seeded.example/leased",
    state: "leased",
    depth: 0,
    discoveredVia: "seed",
    leaseId: "worker_live",
    leasedUntil: new Date(Date.now() + 60_000),
  });
}

async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error("expected a ServiceError, the call answered");
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-delete-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-delete-renders-"));

  siteServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const page = (title: string, body: string): string =>
      `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
    res.writeHead(path === "/" || path === "/a" || path === "/b" ? 200 : 404, { "content-type": "text/html" });
    if (path === "/") res.end(page("Home page of the delete fixture", `<a href="/a">A</a> <a href="/b">B</a>`));
    else if (path === "/a") res.end(page("Page A of the delete fixture", `<a href="/">Home</a>`));
    else if (path === "/b") res.end(page("Page B of the delete fixture", `<a href="/">Home</a>`));
    else res.end("missing");
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const address = siteServer.address();
  site = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  const config = {
    token: TOKEN,
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: (line: string) => serverLog.push(line),
  };
  api = createApiServer({ db, config });
  const bound = await api.listen(0);
  base = `http://127.0.0.1:${bound.port}`;
  mcp = createMcpServer({ db, config: { ...config, tenant: LOCAL_TENANT } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-delete", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
  service = new ApiService(db, { allowedDomains: [], exportDir, renderDir, log: () => {} });
}, 60_000);

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await new Promise<void>((r) => siteServer.close(() => r()));
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
  await closeFetchAgents();
  await closeDb(db);
});

describe("CRAWL_CHILD_TABLES", () => {
  it("is exactly the tables with a crawl_id column, in the brief's order", async () => {
    const named = CRAWL_CHILD_TABLES.map((t) => getTableName(t));
    expect(new Set(named)).toEqual(new Set((await schemaCrawlTables()).filter((t) => t !== "crawls")));
    expect(named).toEqual([
      "issues",
      "metrics",
      "links",
      "page_resources",
      "structured_data",
      "hreflang",
      "url_params",
      "sitemap_hreflang",
      "sitemap_memberships",
      "sitemap_urls",
      "resources",
      "pages",
      "frontier",
      "list_urls",
    ]);
  });
});

describe("crawl_delete over real crawls", () => {
  it("removes every row and file of one crawl and leaves a second untouched", async () => {
    const doomed = await fullCrawl();
    const kept = await fullCrawl();

    const before = await rowCounts(doomed);
    expect(before["pages"]).toBeGreaterThan(0);
    expect(before["links"]).toBeGreaterThan(0);
    expect(before["issues"]).toBeGreaterThan(0);
    const doomedRenderFiles = (await walk(join(renderDir, doomed))).length;
    expect(doomedRenderFiles).toBeGreaterThan(0);
    const doomedExports = await exportFilesOf(doomed);
    expect(doomedExports).toHaveLength(3);

    const keptRows = await rowCounts(kept);
    const keptRenders = await walk(join(renderDir, kept));
    const keptExports = await exportFilesOf(kept);

    // A crawl that is somebody's comparison base is deletable too.
    const compared = await call("GET", `/compare?baseCrawlId=${doomed}&headCrawlId=${kept}`);
    expect(compared.status).toBe(200);

    const deleted = await call("DELETE", `/crawls/${doomed}?confirm=${doomed}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body["crawlId"]).toBe(doomed);
    expect(deleted.body["files"]).toEqual({ renders: doomedRenderFiles, exports: 3 });
    expect(deleted.body["rows"]).toEqual(before);
    expect((deleted.body["rows"] as Record<string, number>)["crawls"]).toBe(1);

    // Nothing left, by a query built from the schema.
    const after = await rowCounts(doomed);
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);
    await expect(readdir(join(renderDir, doomed))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await exportFilesOf(doomed)).toEqual([]);

    // No soft delete.
    expect((await call("GET", `/crawls/${doomed}`)).status).toBe(404);
    const listed = await call("GET", "/crawls?limit=200");
    const ids = (listed.body["items"] as { crawlId: string }[]).map((c) => c.crawlId);
    expect(ids).not.toContain(doomed);
    expect(ids).toContain(kept);
    expect((await call("GET", `/compare?baseCrawlId=${doomed}&headCrawlId=${kept}`)).status).toBe(404);

    // The other crawl is untouched.
    expect(await rowCounts(kept)).toEqual(keptRows);
    expect(await walk(join(renderDir, kept))).toEqual(keptRenders);
    expect(await exportFilesOf(kept)).toEqual(keptExports);
  }, 120_000);

  it("answers the same body over MCP", async () => {
    const id = await seedCrawl({ status: "finished" });
    const out = await tool("crawl_delete", { crawlId: id, confirm: id });
    expect(out.isError).toBe(false);
    expect(out.body["crawlId"]).toBe(id);
    expect(out.body["files"]).toEqual({ renders: 0, exports: 0 });
    const rows = out.body["rows"] as Record<string, number>;
    expect(rows["crawls"]).toBe(1);
    expect(Object.keys(rows).sort()).toEqual([...(await schemaCrawlTables()), "crawls"].sort());
    expect((await call("GET", `/crawls/${id}`)).status).toBe(404);

    const wrong = await tool("crawl_delete", { crawlId: "crawl_x", confirm: "crawl_y" });
    expect(wrong.isError).toBe(true);
    expect(String(wrong.body["error"])).toContain("confirm must repeat the crawl id");
  });
});

describe("crawl_delete refusals", () => {
  it("refuses a missing or different confirm, then an unknown crawl, in that order", async () => {
    const id = await seedCrawl({ status: "finished" });
    const before = await rowCounts(id);
    for (const path of [`/crawls/${id}`, `/crawls/${id}?confirm=other`, `/crawls/${id}?confirm=`]) {
      const res = await call("DELETE", path);
      expect(res.status).toBe(400);
      expect(String(res.body["error"])).toContain("confirm must repeat the crawl id");
    }
    expect(await rowCounts(id)).toEqual(before);
    // Wrong confirm wins over an unknown crawl; an unknown crawl with a right confirm is 404.
    expect((await call("DELETE", "/crawls/crawl_nope?confirm=x")).status).toBe(400);
    expect((await call("DELETE", "/crawls/crawl_nope?confirm=crawl_nope")).status).toBe(404);
  });

  it("refuses a queued and a running crawl, naming the status", async () => {
    for (const status of ["queued", "running"]) {
      const id = await seedCrawl({ status });
      const before = await rowCounts(id);
      const res = await call("DELETE", `/crawls/${id}?confirm=${id}`);
      expect(res.status).toBe(409);
      expect(String(res.body["error"])).toContain(status);
      expect(await rowCounts(id)).toEqual(before);
    }
  });

  it("refuses a pending control request", async () => {
    const id = await seedCrawl({ status: "paused", pauseReason: "request", controlRequest: "cancel" });
    const before = await rowCounts(id);
    const res = await call("DELETE", `/crawls/${id}?confirm=${id}`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("cancel request pending");
    expect(await rowCounts(id)).toEqual(before);
  });

  it("refuses while rules or a render pass hold the crawl on this server", async () => {
    const id = await seedCrawl({ status: "finished" });
    const before = await rowCounts(id);
    const holds = service as unknown as { judging: Set<string>; rendering: Set<string> };
    holds.judging.add(id);
    try {
      const err = await refusal(service.deleteCrawl(LOCAL_TENANT, id, id));
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toContain("crawl_delete");
      expect(err.message).toContain("rules are running");
    } finally {
      holds.judging.delete(id);
    }
    holds.rendering.add(id);
    try {
      const err = await refusal(service.deleteCrawl(LOCAL_TENANT, id, id));
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toContain("a render pass is running");
    } finally {
      holds.rendering.delete(id);
    }
    expect(await rowCounts(id)).toEqual(before);
  });

  it("refuses while a worker holds a live lease, naming the count", async () => {
    const id = await seedCrawl({ status: "paused", pauseReason: "request" });
    await seedLease(id);
    const before = await rowCounts(id);
    const res = await call("DELETE", `/crawls/${id}?confirm=${id}`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("1 unexpired lease");
    expect(await rowCounts(id)).toEqual(before);
  });
});

describe("crawl_delete file failures", () => {
  it("throws after the commit, naming the rows as gone and every path left on disk", async () => {
    if (process.getuid?.() === 0) throw new Error("this test cannot run as root: chmod 0555 would not deny the unlink");
    const id = await seedCrawl({ status: "finished" });
    const stuck = join(exportDir, `${slug(id)}-pages.csv`);
    await writeFile(stuck, "url\n");
    // A directory that cannot be written to refuses the unlink of what is in it.
    const locked = await mkdtemp(join(tmpdir(), "ariadne-delete-locked-"));
    await mkdir(join(locked, "local"), { recursive: true });
    const lockedService = new ApiService(db, { allowedDomains: [], exportDir: locked, renderDir, log: () => {} });
    const lockedFile = join(locked, "local", `${slug(id)}-issues.jsonl.gz`);
    await writeFile(lockedFile, "x");
    await chmod(join(locked, "local"), 0o555);
    try {
      const error = await lockedService.deleteCrawl(LOCAL_TENANT, id, id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ServiceError);
      const message = (error as Error).message;
      expect(message).toContain("its database rows are deleted");
      expect(message).toContain(lockedFile);
      expect(message).not.toContain(stuck);
    } finally {
      await chmod(join(locked, "local"), 0o755);
      await rm(locked, { recursive: true, force: true });
      await rm(stuck, { force: true });
    }
    const gone = await rowCounts(id);
    for (const [table, n] of Object.entries(gone)) expect(n, table).toBe(0);
  });
});

describe("crawl_delete's file step: unreadable directories and containment (27b final M9)", () => {
  it("an unreadable render or export directory is wrapped: the rows are gone, and the directory is left on disk", async () => {
    if (process.getuid?.() === 0) throw new Error("this test cannot run as root: chmod 0000 would not deny the read");
    const root = await mkdtemp(join(tmpdir(), "ariadne-delete-unreadable-"));
    const renders = join(root, "renders");
    const exports = join(root, "exports");
    const id = `crawl_unreadable_${randomUUID()}`;
    const renderRoot = join(renders, id);
    await mkdir(join(renderRoot, "nested"), { recursive: true });
    await mkdir(exports, { recursive: true });
    await chmod(join(renderRoot, "nested"), 0o000);
    await chmod(exports, 0o000);
    try {
      const error = await deleteCrawlFiles(id, slug(id), renders, exports, LOCAL_TENANT).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`crawl ${id}`);
      expect(message).toContain("its database rows are deleted");
      expect(message).toContain(renderRoot);
      expect(message).toContain(exports);
      expect(message).toContain("EACCES");
    } finally {
      await chmod(join(renderRoot, "nested"), 0o755);
      await chmod(exports, 0o755);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a crawl id that would resolve outside the render directory, before removing anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "ariadne-delete-contain-"));
    const renders = join(root, "renders");
    const outside = join(root, "outside");
    await mkdir(renders, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "x");
    try {
      for (const id of ["../outside", "..", ""]) {
        const error = await deleteCrawlFiles(id, "x", renders, join(root, "exports"), LOCAL_TENANT).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, JSON.stringify(id)).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("outside the render directory");
      }
      expect(await readdir(outside)).toEqual(["keep.txt"]);
      expect(await readdir(renders)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("crawl_delete removes list_urls (27c T1)", () => {
  it("removes a crawl's list_urls rows and not a sibling's", async () => {
    const doomed = await seedCrawl({ status: "finished" });
    const kept = await seedCrawl({ status: "finished" });
    for (const id of [doomed, kept]) {
      await db.insert(listUrls).values([
        { crawlId: id, position: 0, url: "http://seeded.example/a" },
        { crawlId: id, position: 1, url: "http://seeded.example/b" },
      ]);
    }
    const deleted = await call("DELETE", `/crawls/${doomed}?confirm=${doomed}`);
    expect(deleted.status).toBe(200);
    expect((deleted.body["rows"] as Record<string, number>)["list_urls"]).toBe(2);
    const left = await db.select().from(listUrls).where(eq(listUrls.crawlId, doomed));
    expect(left).toEqual([]);
    const sibling = await db.select().from(listUrls).where(eq(listUrls.crawlId, kept));
    expect(sibling).toHaveLength(2);
  });
});

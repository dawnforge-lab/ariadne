/**
 * The render link (Phase 28c T2): a render pass with `renderHtmlDir: null`
 * keeps no documents, and `crawl_status.renderDocuments` says which kind of
 * pass a crawl had (C7: derived from `pages.rendered_html_path`).
 *
 * A real crawl of a three-page `node:http` site through the API, a real
 * Chromium for the pass (the same prerequisite as test/crawl/renderer.test.ts).
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { runRenderLink } from "../../src/crawl/render/render-link.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

const TOKEN = "test-token-render-link-0123456789";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title>` +
    `<meta name="description" content="a fixture page for the render link"></head>` +
    `<body><h1>${title}</h1>${body}</body></html>`
  );
}

let db: Db;
let siteServer: Server;
let site: string;
let api: ApiServer;
let base: string;
let renderDir: string;
const created: string[] = [];

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "x-ariadne-tenant": "local",
    authorization: `Bearer ${TOKEN}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function crawlSite(): Promise<string> {
  const started = await call("POST", "/crawls", { siteUrl: `${site}/`, maxPages: 5 });
  expect(started.status).toBe(202);
  const id = String(started.body["crawlId"]);
  created.push(id);
  const until = Date.now() + 25_000;
  for (;;) {
    const res = await call("GET", `/crawls/${id}`);
    const status = res.body["status"];
    if (status !== "queued" && status !== "running") {
      expect(status).toBe("finished");
      return id;
    }
    if (Date.now() > until) throw new Error(`crawl ${id} still '${String(status)}'`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  siteServer = createServer((req, res) => {
    const origin = site;
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\n`);
      return;
    }
    const bodies: Record<string, string> = {
      "/": html("home", `<a href="${origin}/a">a</a><a href="${origin}/b">b</a>`),
      "/a": html("page a", `<a href="${origin}/b">b</a><p>some words for the analyzer to count</p>`),
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
  const addr = siteServer.address();
  site = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;

  renderDir = await mkdtemp(join(tmpdir(), "ariadne-render-link-"));
  api = createApiServer({
    db,
    config: {
      credentialKeys: TEST_CREDENTIAL_KEYS,
      token: TOKEN,
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      renderDir,
      log: () => {},
    },
  });
  const bound = await api.listen(0);
  base = `http://127.0.0.1:${bound.port}`;
}, 60_000);

afterAll(async () => {
  await api.close();
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await closeFetchAgents();
  await rm(renderDir, { recursive: true, force: true });
  await new Promise<void>((r) => siteServer.close(() => r()));
});

describe("a render with no documents directory", () => {
  it("renders, writes no file and leaves rendered_html_path null; crawl_status says 'not kept'", async () => {
    const id = await crawlSite();
    expect((await call("GET", `/crawls/${id}`)).body["renderDocuments"]).toBe("not kept");

    const summary = await runRenderLink(db, new CredentialVault(db, TEST_CREDENTIAL_KEYS), id, {
      renderHtmlDir: null,
      allowPrivate: true,
      hostAllowed: () => true,
      log: () => {},
      where: "chain",
    });
    expect(summary.rendered).toBeGreaterThan(0);

    const rendered = await db
      .select({ path: pages.renderedHtmlPath })
      .from(pages)
      .where(and(eq(pages.crawlId, id), eq(pages.rendered, true)));
    expect(rendered.length).toBe(summary.rendered);
    for (const row of rendered) expect(row.path).toBeNull();
    // Neither the server's root nor the pass's cwd-relative default was written to.
    expect(existsSync(join(renderDir, id))).toBe(false);
    expect(existsSync(join(process.cwd(), "renders", id))).toBe(false);

    expect((await call("GET", `/crawls/${id}`)).body["renderDocuments"]).toBe("not kept");
  }, 90_000);

  it("crawl_status answers 'kept' after a pass with a directory", async () => {
    const id = await crawlSite();
    const res = await call("POST", `/crawls/${id}/render`);
    expect(res.status).toBe(200);
    expect(Number(res.body["rendered"])).toBeGreaterThan(0);
    expect(existsSync(join(renderDir, id))).toBe(true);
    expect((await call("GET", `/crawls/${id}`)).body["renderDocuments"]).toBe("kept");
  }, 90_000);
});

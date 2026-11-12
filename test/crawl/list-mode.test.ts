/**
 * Phase 27c Task 6: list mode. A list crawl fetches the URLs stored in
 * `list_urls` at depth 0, follows redirects but no link, and reads no sitemap
 * unless `sitemapUrls` was given.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, listUrls, pages, sitemapUrls } from "../../src/db/schema.js";
import { setControlRequest } from "../../src/crawl/control.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import {
  parseStoredConfig,
  resumeCrawl,
  runCrawl,
  storableConfig,
  validateCrawlConfig,
  type CrawlConfig,
  type CrawlSummary,
} from "../../src/crawl/loop.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(what: string, predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

let db: Db;
let server: Server;
let base: string;
let requested: string[] = [];
const createdCrawls: string[] = [];
const heldPaths = new Set<string>();
const heldResponses = new Set<ServerResponse>();

function page(title: string, hrefs: string[] = []): string {
  return (
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>` +
    hrefs.map((h) => `<a href="${h}">link</a>`).join(" ") +
    `</body></html>`
  );
}

function sitemap(...locs: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    locs.map((l) => `<url><loc>${base}${l}</loc></url>`).join("") +
    `</urlset>`
  );
}

function site(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requested.push(path);
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nDisallow: /blocked/\nSitemap: ${base}/sm-declared.xml\n`);
      return;
    }
    if (path === "/sm-declared.xml" || path === "/sm-supplied.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(sitemap(path === "/sm-declared.xml" ? "/sm/one" : "/sm/two"));
      return;
    }
    if (path === "/l/redirect") {
      res.writeHead(301, { location: "/l/target" });
      res.end();
      return;
    }
    if (heldPaths.has(path)) {
      heldResponses.add(res);
      res.on("close", () => heldResponses.delete(res));
      return;
    }
    const known: Record<string, string> = {
      "/": page("Home", ["/unlisted"]),
      "/l/ok": page("Ok", ["/unlisted"]),
      "/l/target": page("Target"),
      "/unlisted": page("Unlisted"),
      "/sm/one": page("One"),
      "/sm/two": page("Two"),
    };
    const body = known[path] ?? (/^\/p\/\d$/.test(path) ? page(`P ${path}`) : undefined);
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Not found</title><p>nothing here</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
}

function cfg(urls: string[], overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: `${base}/`,
    maxPages: 100,
    maxDepth: 10,
    userAgent: "AriadneBot-list-test",
    perHostDelayMs: 0,
    maxConcurrency: 1,
    allowPrivate: true,
    probeHosts: false,
    fetchResources: false,
    recheckMinGapMs: 50,
    mode: "list",
    listUrlCount: urls.length,
    ...overrides,
  };
}

/** What the API's `startCrawl` does: the row and the listed URLs, then the queue's claim. */
async function createListCrawl(urls: string[], config: CrawlConfig): Promise<string> {
  const id = `crawl_list_${Math.random().toString(36).slice(2)}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: config.siteUrl, hostKey: hostKeyOf(config.siteUrl),
    config: storableConfig(config),
    rulesetVersion: RULESET_VERSION,
    status: "queued",
  });
  createdCrawls.push(id);
  await db
    .insert(listUrls)
    .values(urls.map((url, position) => ({ crawlId: id, position, url: `${base}${url}` })));
  return id;
}

async function runList(urls: string[], overrides: Partial<CrawlConfig> = {}): Promise<CrawlSummary> {
  const config = cfg(urls, overrides);
  const id = await createListCrawl(urls, config);
  requested = [];
  return resumeCrawl(db, id, { config, expectStatus: "queued" });
}

async function rowsOf(crawlId: string): Promise<Map<string, typeof pages.$inferSelect>> {
  const rows = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
  return new Map(rows.map((r) => [r.url.slice(base.length), r]));
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  server = site();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await closeFetchAgents();
  for (const res of heldResponses) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("list mode", () => {
  it("fetches every listed URL at depth 0 and follows redirects but no link", async () => {
    const summary = await runList(["/l/ok", "/l/missing", "/l/redirect", "/blocked/x"], {
      maxPages: 8,
    });
    expect(summary.status).toBe("finished");
    const rows = await rowsOf(summary.crawlId);

    expect(rows.get("/l/ok")?.fetchClass).toBe("ok");
    expect(rows.get("/l/missing")?.fetchClass).toBe("client_error");
    expect(rows.get("/l/redirect")?.fetchClass).toBe("redirect");
    expect(rows.get("/blocked/x")?.fetchClass).toBe("disallowed");
    for (const path of ["/l/ok", "/l/missing", "/l/redirect", "/blocked/x"]) {
      expect(rows.get(path)?.depth, path).toBe(0);
      expect(rows.get(path)?.discoveredVia, path).toBe("list");
    }
    // The redirect's target is fetched, at the source's depth.
    expect(rows.get("/l/target")?.fetchClass).toBe("ok");
    expect(rows.get("/l/target")?.depth).toBe(0);
    expect(rows.get("/l/target")?.discoveredVia).toBe("redirect");

    // The link is recorded, never followed.
    expect(rows.has("/unlisted")).toBe(false);
    expect(requested).not.toContain("/unlisted");
    const recorded = await db.select().from(links).where(eq(links.crawlId, summary.crawlId));
    expect(recorded.some((l) => l.targetUrl === `${base}/unlisted`)).toBe(true);
  });

  it("does not request a siteUrl that is not in the list (robots.txt it does)", async () => {
    const summary = await runList(["/l/ok"]);
    const rows = await rowsOf(summary.crawlId);
    expect(rows.has("/")).toBe(false);
    expect(requested).toContain("/robots.txt");
    expect(requested).not.toContain("/");
  });

  it("walks no sitemap without sitemapUrls and says it did not", async () => {
    const summary = await runList(["/l/ok"]);
    expect(requested).not.toContain("/sm-declared.xml");
    expect(requested).not.toContain("/sm-supplied.xml");
    expect(summary.sitemapsRead).toBe(false);
    const [row] = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    const discovery = row?.discovery as Record<string, unknown>;
    expect(discovery["sitemapsRead"]).toBe(false);
    // robots.txt's declaration is still reported as declared.
    expect(discovery["sitemapSources"]).toEqual([`${base}/sm-declared.xml`]);
    expect(discovery["suppliedSitemaps"]).toEqual([]);
  });

  it("walks the declared and the supplied sitemaps with sitemapUrls, and queues no entry", async () => {
    const summary = await runList(["/l/ok"], { sitemapUrls: [`${base}/sm-supplied.xml`] });
    expect(requested).toContain("/sm-declared.xml");
    expect(requested).toContain("/sm-supplied.xml");
    expect(summary.sitemapsRead).toBe(true);
    const entries = await db.select().from(sitemapUrls).where(eq(sitemapUrls.crawlId, summary.crawlId));
    expect(entries.map((e) => e.url.slice(base.length)).sort()).toEqual(["/sm/one", "/sm/two"]);
    const rows = await rowsOf(summary.crawlId);
    expect(rows.has("/sm/one")).toBe(false);
    expect(rows.has("/sm/two")).toBe(false);
    expect(requested).not.toContain("/sm/one");
    expect(requested).not.toContain("/sm/two");
    const [row] = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    expect((row?.discovery as Record<string, unknown>)["sitemapsRead"]).toBe(true);
  });

  it("stores mode and listUrlCount, and validateCrawlConfig refuses a list without a count", async () => {
    expect(() => validateCrawlConfig(cfg([], { listUrlCount: undefined }))).toThrow(/listUrlCount/);
    expect(() => validateCrawlConfig(cfg([], { listUrlCount: 0 }))).toThrow(/listUrlCount/);
    expect(() => validateCrawlConfig(cfg(["/a"]))).not.toThrow();
    const summary = await runList(["/l/ok"]);
    const [row] = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    const stored = parseStoredConfig(row?.config, summary.crawlId);
    expect(stored.mode).toBe("list");
    expect(stored.listUrlCount).toBe(1);
  });

  it("resumes a paused list crawl fetching each remaining listed URL once", async () => {
    const urls = ["/p/1", "/p/2", "/p/3", "/p/4", "/p/5"];
    const config = cfg(urls);
    const id = await createListCrawl(urls, config);
    requested = [];
    heldPaths.add("/p/3");
    const run = resumeCrawl(db, id, { config, expectStatus: "queued" });
    run.catch(() => undefined);
    await until("/p/3 in flight", () => requested.includes("/p/3"));
    expect(await setControlRequest(db, id, "pause")).toBe(true);
    expect((await run).status).toBe("paused");
    const before = await rowsOf(id);
    expect([...before.keys()].sort()).toEqual(["/p/1", "/p/2"]);

    heldPaths.delete("/p/3");
    requested = [];
    const resumed = await resumeCrawl(db, id, { config });
    expect(resumed.status).toBe("finished");
    const after = await rowsOf(id);
    expect([...after.keys()].sort()).toEqual(urls);
    for (const path of urls) expect(after.get(path)?.fetchClass, path).toBe("ok");
    for (const path of urls) {
      expect(requested.filter((p) => p === path).length, path).toBe(
        path === "/p/1" || path === "/p/2" ? 0 : 1,
      );
    }
  });
});

describe("list mode, the final wave (27c M8)", () => {
  it("runCrawl refuses mode list before a row exists: only the API creates a list crawl", async () => {
    const before = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.siteUrl, `${base}/`));
    requested = [];
    await expect(runCrawl(db, LOCAL_TENANT, cfg(["/p/1"]))).rejects.toThrow(/mode "list"/);
    const after = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.siteUrl, `${base}/`));
    expect(after.length).toBe(before.length);
    expect(requested).toEqual([]);
  });

  it("throws when the list_urls rows it read are not listUrlCount, before any page is fetched", async () => {
    // Two URLs promised, one stored: a short table, never a quietly short crawl.
    const config = cfg(["/p/1", "/p/2"]);
    const id = await createListCrawl(["/p/1"], config);
    requested = [];
    const error = await resumeCrawl(db, id, { config, expectStatus: "queued" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(id);
    expect((error as Error).message).toContain("listUrlCount");
    expect((error as Error).message).toMatch(/read 1 .*2/);
    expect(requested).not.toContain("/p/1");
    expect((await rowsOf(id)).size).toBe(0);
  });
});

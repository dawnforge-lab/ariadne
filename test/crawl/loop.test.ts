import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages, sitemapUrls } from "../../src/db/schema.js";
import { frontierCounts } from "../../src/crawl/frontier.js";
import { runCrawl, resumeCrawl, type CrawlConfig } from "../../src/crawl/loop.js";
import { closeFetchAgents } from "../../src/crawl/http.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * The brief's fixture site:
 *   /                -> /a, /b, /admin/secret (robots-disallowed), an external link
 *   /a               -> /c
 *   /b               -> 301 to /c
 *   /c               -> /missing
 *   /missing         -> 404
 *   /d               -> reachable only from the sitemap
 *   /admin/secret    -> served, but must never be fetched
 */
let siteServer: Server;
let base: string;

/** A site whose robots.txt only ever 503s: unreachable, complete disallow. */
let flakyServer: Server;
let flaky: string;

/** A site whose robots.txt disallows everything. */
let closedServer: Server;
let closed: string;

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

let db: Db;
const createdCrawls: string[] = [];

async function crawl(config: CrawlConfig, signal?: AbortSignal) {
  const summary = await runCrawl(db, config, signal);
  createdCrawls.push(summary.crawlId);
  return summary;
}

beforeAll(async () => {
  siteServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end(
        ["User-agent: *", "Disallow: /admin", `Sitemap: ${base}/sitemap.xml`, ""].join("\n"),
      );
      return;
    }
    if (path === "/sitemap.xml") {
      res.setHeader("content-type", "application/xml");
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${base}/</loc><lastmod>2026-08-01</lastmod></url>` +
          `<url><loc>${base}/d</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    if (path === "/b") {
      res.writeHead(301, { location: `${base}/c` });
      res.end();
      return;
    }
    if (path === "/missing") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("<p>gone</p>"));
      return;
    }

    const bodies: Record<string, string> = {
      "/": html(
        `<a href="/a">a</a><a href="/b">b</a>` +
          `<a href="/admin/secret">secret</a>` +
          `<a href="https://external.example/x">external</a>`,
      ),
      "/a": html(`<a href="/c">c</a>`),
      "/c": html(`<a href="/missing">missing</a>`),
      "/d": html(`<p>sitemap only</p>`),
      "/admin/secret": html(`<p>secret</p>`),
    };
    const body = bodies[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  base = await listen(siteServer);

  flakyServer = createServer((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("nope");
  });
  flaky = await listen(flakyServer);

  closedServer = createServer((req, res) => {
    if ((req.url ?? "") === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nDisallow: /\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html("<p>should never be fetched</p>"));
  });
  closed = await listen(closedServer);

  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  await new Promise<void>((r) => flakyServer.close(() => r()));
  await new Promise<void>((r) => closedServer.close(() => r()));
});

function config(overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: base,
    maxPages: 100,
    maxDepth: 10,
    userAgent: "AriadneBot-test",
    perHostDelayMs: 0,
    maxConcurrency: 4,
    allowPrivate: true,
    ...overrides,
  };
}

describe("runCrawl", () => {
  it("crawls the site to completion", async () => {
    const summary = await crawl(config());

    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    expect(byUrl.get(`${base}/b`)?.fetchClass).toBe("redirect"); // hop is its own row
    expect(byUrl.get(`${base}/c`)?.fetchClass).toBe("ok"); // redirect target crawled
    expect(byUrl.get(`${base}/missing`)?.fetchClass).toBe("client_error");
    expect(byUrl.has(`${base}/admin/secret`)).toBe(false); // robots respected
    expect([...byUrl.keys()].every((u) => u.startsWith(base))).toBe(true); // same-origin
    expect(summary.frontier.pending).toBe(0);

    // The seed, /a, /b, /c, /missing and the sitemap-only /d — and nothing else.
    expect([...byUrl.keys()].sort()).toEqual(
      [`${base}/`, `${base}/a`, `${base}/b`, `${base}/c`, `${base}/d`, `${base}/missing`].sort(),
    );
    expect(summary.status).toBe("finished");
    expect(summary.pagesCrawled).toBe(6);
    expect(summary.frontier.done).toBe(6);
    expect(summary.frontier.failed).toBe(0);
    expect(summary.writer.pages).toBe(6);

    // Provenance is recorded per URL, and the redirect target is its own row
    // discovered by the redirect (or the link from /a — whichever won the race).
    expect(byUrl.get(`${base}/`)?.discoveredVia).toBe("seed");
    expect(byUrl.get(`${base}/d`)?.discoveredVia).toBe("sitemap");
    expect(byUrl.get(`${base}/a`)?.depth).toBe(1);

    // The crawls row is closed out.
    const crawlRow = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    expect(crawlRow[0]?.status).toBe("finished");
    expect(crawlRow[0]?.pagesCrawled).toBe(6);
    expect(crawlRow[0]?.finishedAt).not.toBeNull();
  });

  it("records external links without fetching them", async () => {
    const summary = await crawl(config());
    const external = await db
      .select()
      .from(links)
      .where(
        and(
          eq(links.crawlId, summary.crawlId),
          eq(links.targetUrl, "https://external.example/x"),
        ),
      );
    expect(external).toHaveLength(1);
    expect(external[0]?.isInternal).toBe(false);

    const fetched = await db
      .select()
      .from(pages)
      .where(and(eq(pages.crawlId, summary.crawlId), eq(pages.url, "https://external.example/x")));
    expect(fetched).toEqual([]);
  });

  it("persists sitemap entries and crawls sitemap-only URLs", async () => {
    const summary = await crawl(config());
    const rows = await db
      .select()
      .from(sitemapUrls)
      .where(eq(sitemapUrls.crawlId, summary.crawlId));
    expect(rows.map((r) => r.url).sort()).toEqual([`${base}/`, `${base}/d`]);
    expect(rows.find((r) => r.url === `${base}/`)?.lastmod).toBe("2026-08-01");
    expect(summary.discovery.sitemapEntries).toBe(2);
  });

  it("respects maxPages", async () => {
    const summary = await crawl(config({ maxPages: 2 }));
    expect(summary.pagesCrawled).toBeLessThanOrEqual(2);
    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    expect(rows.length).toBeLessThanOrEqual(2);
  });

  it("abort signal stops the loop and releases nothing into limbo", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    // Paced so the abort lands mid-crawl rather than after it.
    const summary = await crawl(config({ perHostDelayMs: 40 }), ac.signal);

    const counts = await frontierCounts(db, summary.crawlId);
    expect(counts.leased).toBe(0); // graceful shutdown released leases
    expect(counts.pending).toBeGreaterThan(0); // and left work to resume
    expect(summary.status).toBe("cancelled");

    const crawlRow = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    expect(crawlRow[0]?.status).toBe("cancelled");
  });

  it("refuses to crawl a site whose robots.txt is unreachable", async () => {
    const summary = await crawl(config({ siteUrl: flaky }));
    expect(summary.status).toBe("failed");
    expect(summary.pagesCrawled).toBe(0);
    expect(summary.note).toMatch(/robots\.txt unreachable/);
    expect(summary.robots.outcome).toBe("unreachable");

    const crawlRow = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    expect(crawlRow[0]?.status).toBe("failed");
    expect((await frontierCounts(db, summary.crawlId)).pending).toBe(0);
  });

  it("says why a robots-closed site produced no pages", async () => {
    const summary = await crawl(config({ siteUrl: closed }));
    expect(summary.status).toBe("finished");
    expect(summary.pagesCrawled).toBe(0);
    expect(summary.robots.outcome).toBe("read");
    expect(summary.note).toMatch(/nothing to crawl/);
    expect(summary.frontier).toEqual({ pending: 0, leased: 0, done: 0, failed: 0 });
  });

  it("lets our own errors kill the run, and marks the crawl failed", async () => {
    // A user agent that cannot be a header value is our bug, not the site's:
    // fetch-page rethrows it rather than classifying it (build plan rule 7).
    const before = await db.select().from(crawls).where(eq(crawls.siteUrl, base));
    const known = new Set(before.map((r) => r.id));

    await expect(runCrawl(db, config({ userAgent: "bad\nagent" }))).rejects.toThrow(
      /invalid user-agent header/i,
    );

    const after = await db.select().from(crawls).where(eq(crawls.siteUrl, base));
    const created = after.filter((r) => !known.has(r.id));
    expect(created).toHaveLength(1);
    // The row is closed out as failed, not left `running` for ever.
    expect(created[0]?.status).toBe("failed");
    createdCrawls.push(created[0]!.id);
  });
});

describe("resumeCrawl", () => {
  it("continues a cancelled crawl instead of restarting it", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const first = await crawl(config({ perHostDelayMs: 40 }), ac.signal);
    expect(first.status).toBe("cancelled");
    expect(first.pagesCrawled).toBeLessThan(6);

    const resumed = await resumeCrawl(db, first.crawlId, {
      config: config({ perHostDelayMs: 0 }),
    });

    expect(resumed.crawlId).toBe(first.crawlId);
    expect(resumed.status).toBe("finished");
    expect(resumed.frontier.pending).toBe(0);
    expect(resumed.pagesCrawled).toBe(6);
    // Pages crawled before the abort were not re-fetched: one row per URL.
    const rows = await db.select().from(pages).where(eq(pages.crawlId, first.crawlId));
    expect(rows).toHaveLength(6);
    // The resumed run only wrote the pages the first run had not.
    expect(resumed.writer.pages).toBe(6 - first.pagesCrawled);
  });
});

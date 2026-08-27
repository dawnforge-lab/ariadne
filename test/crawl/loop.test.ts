import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, links, pages, sitemapUrls } from "../../src/db/schema.js";
import { frontierCounts, leaseBatch } from "../../src/crawl/frontier.js";
import { PageWriter } from "../../src/crawl/persist.js";
import {
  runCrawl,
  resumeCrawl,
  type CrawlConfig,
  type DiscoveryEvidence,
  type NotFoundProbeSample,
} from "../../src/crawl/loop.js";
import type { HostProbeResult } from "../../src/crawl/host-probe.js";
import { hostProbeStarts } from "../../src/crawl/parse/url-utils.js";
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

/**
 * A site whose home page links to a *variant spelling* of its own origin —
 * the `www.` host, which `isSameOrigin` admits into the crawl and which this
 * server answers on too. robots.txt disallows /admin, and the disallowed
 * links are written on the variant. robots-parser answers `undefined` for a
 * foreign origin, so without the rewrite in RobotsInfo.isAllowed those URLs
 * would be crawled under no rules at all (build plan rule 9).
 */
let variantServer: Server;
let variant: string;
/** The `www.` spelling of `variant`, synthesised once the port is known. */
let variantWww: string;

/**
 * A site that resets connections:
 *   /flappy        -> resets twice, then serves a page (the retry succeeds)
 *   /always-broken -> resets for ever (the retries are spent)
 * Both are linked from `/`, and robots.txt 404s (absent -> allow all).
 */
let brokenServer: Server;
let broken: string;
let flappyHits = 0;
let alwaysBrokenHits = 0;

/**
 * A site whose catch-all answers 200 with the same "not found" template for
 * every unknown URL — the soft-404 site the known-404 probe exists to catch.
 * robots.txt 404s (absent -> allow all) so the crawl itself is ordinary.
 */
let soft404Server: Server;
let soft404: string;

/**
 * Set by the poison test: the next `/` request deletes the running crawl row
 * out from under the loop, which makes the handler's enqueue *and* the
 * writer's flush fail with foreign-key violations.
 */
let poisonNextPage = false;

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

/**
 * Listen on every interface and address the site by name, so both `localhost`
 * and its `www.` variant reach this server. `www.localhost` resolves (to ::1
 * here), which is what makes the robots-variant test honest: if the gate lets
 * the variant spelling through, it really is fetched and really does produce a
 * page row.
 */
async function listenByName(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://localhost:${port}`;
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
  siteServer = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (poisonNextPage && path === "/") {
      poisonNextPage = false;
      // Deleting the crawl cascades to its frontier rows, so the very next
      // enqueue and the writer's page insert both violate a foreign key.
      await db
        .delete(crawls)
        .where(and(eq(crawls.siteUrl, base), eq(crawls.status, "running")));
    }
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

  variantServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nDisallow: /admin\n");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // The disallowed links carry the www. spelling of this very origin.
      res.end(
        html(
          `<a href="/ok">ok</a>` +
            `<a href="${variantWww}/admin/x">variant secret</a>` +
            `<a href="${variantWww}/admin/y">variant secret 2</a>`,
        ),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html(`<p>${path}</p>`));
  });
  variant = await listenByName(variantServer);
  variantWww = variant.replace("http://", "http://www.");

  brokenServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/flappy") {
      flappyHits += 1;
      // Two resets, then a real page: the URL is only crawlable on its third
      // attempt, which is exactly what the requeue path exists for.
      if (flappyHits <= 2) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html("<p>up at last</p>"));
      return;
    }
    if (path === "/always-broken") {
      alwaysBrokenHits += 1;
      req.socket.destroy();
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(`<a href="/flappy">f</a><a href="/always-broken">b</a>`));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no");
  });
  broken = await listen(brokenServer);

  soft404Server = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no robots here");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(`<p>the home page of a site that never 404s</p>`));
      return;
    }
    // Everything else: 200, with the same apologetic template every time.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html(`<h1>Sorry</h1><p>This page cannot be found. Try the home page.</p>`));
  });
  soft404 = await listen(soft404Server);

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
  await new Promise<void>((r) => brokenServer.close(() => r()));
  await new Promise<void>((r) => variantServer.close(() => r()));
  await new Promise<void>((r) => soft404Server.close(() => r()));
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
    // Every entry also carries the frontier key the sitemap rules join on.
    // These two `<loc>`s are already in normal form, so the pair matches — what
    // is asserted is that the column is written at all, never left at its
    // pre-Phase-4 default.
    expect(rows.map((r) => r.urlNormalised).sort()).toEqual([`${base}/`, `${base}/d`]);
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

  it("stops enqueueing links at maxDepth", async () => {
    const summary = await crawl(config({ maxDepth: 1 }));
    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    // /c is depth 1 and its link to /missing is never enqueued: at depth ===
    // maxDepth a page is crawled but not expanded.
    expect(byUrl.has(`${base}/c`)).toBe(true);
    expect(byUrl.has(`${base}/missing`)).toBe(false);
    expect([...byUrl.keys()].sort()).toEqual(
      [`${base}/`, `${base}/a`, `${base}/b`, `${base}/c`, `${base}/d`].sort(),
    );
    expect(rows.every((r) => r.depth <= 1)).toBe(true);
    // A redirect target is the same depth, not a step deeper, so /b -> /c is
    // still followed from a depth-1 page.
    expect(byUrl.get(`${base}/c`)?.depth).toBe(1);
    expect(summary.frontier.pending).toBe(0);
  });

  it("retries a transient failure and records the attempt that settles it", async () => {
    flappyHits = 0;
    alwaysBrokenHits = 0;
    const summary = await crawl(config({ siteUrl: broken }));

    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    // Reset twice, then served: the row is the *third* attempt's outcome, not
    // the first failure that happened to be written first.
    expect(flappyHits).toBe(3);
    expect(byUrl.get(`${broken}/flappy`)?.fetchClass).toBe("ok");

    // Reset for ever: three attempts, then one row carrying the failure.
    expect(alwaysBrokenHits).toBe(3);
    expect(byUrl.get(`${broken}/always-broken`)?.fetchClass).toBe("network_error");

    // The frontier agrees: the retried URL is done, the exhausted one failed.
    expect(summary.frontier.done).toBe(2); // / and /flappy
    expect(summary.frontier.failed).toBe(1); // /always-broken
    expect(summary.frontier.pending).toBe(0);
    expect(rows).toHaveLength(3);
  });

  it("applies robots rules to same-site origin variants", async () => {
    // Probe off: this is the one fixture addressed by name rather than by IP,
    // so the host probe would synthesise `www.localhost` and ask the system
    // resolver about it. The suite does not put made-up names on the wire —
    // the probe's own tests inject a resolver instead.
    const summary = await crawl(config({ siteUrl: variant, probeHosts: false }));

    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    // The www. spelling of /admin/x is same-origin by our own rule, so it is a
    // URL this crawl would otherwise fetch. robots disallows /admin: it must
    // not be fetched under either spelling, and must not even be enqueued.
    expect(rows.map((r) => r.url).sort()).toEqual([`${variant}/`, `${variant}/ok`].sort());

    const queued = await db
      .select()
      .from(frontier)
      .where(eq(frontier.crawlId, summary.crawlId));
    expect(queued.filter((r) => r.url.includes("www."))).toEqual([]);

    // Nothing was attempted and then lost: a variant URL that slipped the gate
    // would show up here as a DNS failure rather than an absence.
    expect(summary.frontier.failed).toBe(0);
    expect(summary.frontier.pending).toBe(0);
    expect(summary.pagesCrawled).toBe(2);

    // The link rows still record what the page pointed at — the fact is kept,
    // only the fetch is refused.
    const linkRows = await db
      .select()
      .from(links)
      .where(and(eq(links.crawlId, summary.crawlId), eq(links.targetUrl, `${variantWww}/admin/x`)));
    expect(linkRows).toHaveLength(1);
  });

  it("says why a robots-closed site produced no pages", async () => {
    const summary = await crawl(config({ siteUrl: closed }));
    expect(summary.status).toBe("finished");
    expect(summary.pagesCrawled).toBe(0);
    expect(summary.robots.outcome).toBe("read");
    expect(summary.note).toMatch(/nothing to crawl/);
    expect(summary.frontier).toEqual({
      pending: 0, leased: 0, done: 0, failed: 0, renderPending: 0,
    });
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

  it("surfaces the loop's error and the shutdown's error together", async () => {
    // Deleting the crawl mid-flight breaks two things at once: the seed page's
    // enqueue (a frontier FK violation, inside the loop) and the writer's
    // buffered page rows (a pages FK violation, during shutdown). Neither may
    // hide the other.
    poisonNextPage = true;
    let thrown: unknown = null;
    try {
      // The host probe is off for this one: it fetches `/` before the crawl
      // does, so it would spring the trap before there is a loop to break.
      await runCrawl(db, config({ probeHosts: false }));
    } catch (error) {
      thrown = error;
    }
    poisonNextPage = false;

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    const text = aggregate.errors.map((e) => String((e as Error).message ?? e)).join("\n");
    expect(text).toMatch(/frontier/); // the loop's error survived
    expect(text).toMatch(/pages/); // and so did the flush's
  });
});

/**
 * The crawl-level evidence the query rules read instead of fetching anything
 * themselves (hard rule 3). Every assertion here is about a `crawls` column
 * that a rule will later be the only consumer of.
 */
describe("crawl-level evidence", () => {
  async function crawlRow(crawlId: string) {
    const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    if (row === undefined) throw new Error(`no crawls row for ${crawlId}`);
    return row;
  }

  it("stores what discovery found, robots.txt verbatim included", async () => {
    const summary = await crawl(config());
    const row = await crawlRow(summary.crawlId);
    const discovery = row.discovery as DiscoveryEvidence;

    expect(discovery.robots.outcome).toBe("read");
    expect(discovery.robots.raw).toContain("Disallow: /admin");
    expect(discovery.robots.raw).toContain(`Sitemap: ${base}/sitemap.xml`);
    expect(discovery.robots.crawlDelaySec).toBeNull();
    expect(discovery.robots.note).toBeNull();
    // `raw` is a 500KB prefix; a rule re-parsing it must know whether it is
    // reading the whole file or the start of one.
    expect(discovery.robots.truncated).toBe(false);
    expect(discovery.sitemapSources).toEqual([`${base}/sitemap.xml`]);
    expect(discovery.docsFetched).toBe(1);
    expect(discovery.truncation.failures).toEqual([]);
  });

  it("records discovery even when robots.txt refuses the crawl", async () => {
    const summary = await crawl(config({ siteUrl: flaky }));
    const row = await crawlRow(summary.crawlId);
    const discovery = row.discovery as DiscoveryEvidence;
    expect(discovery.robots.outcome).toBe("unreachable");
    expect(discovery.robots.raw).toBeNull();
    // A crawl that never ran cannot have sampled a 404: it says so.
    const probe = row.notfoundProbe as { skipped?: string };
    expect(probe.skipped).toMatch(/robots/i);
  });

  it("probes a URL that cannot exist, and records the 404 it got", async () => {
    const summary = await crawl(config());
    const probe = (await crawlRow(summary.crawlId)).notfoundProbe as NotFoundProbeSample;
    expect(probe.probeUrl).toMatch(
      new RegExp(`^${base}/__ariadne-404-probe-[0-9a-f-]{36}$`),
    );
    expect(probe.statusCode).toBe(404);
    expect(probe.fetchClass).toBe("client_error");
    // No HTML was kept for a 404, so there is no template to fingerprint.
    expect(probe.simhash).toBeNull();
    expect(probe.wordCount).toBeNull();

    // The probe is not a page: it never enters the frontier or the pages table.
    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    expect(rows.some((r) => r.url.includes("__ariadne-404-probe-"))).toBe(false);
    expect(summary.pagesCrawled).toBe(6);
  });

  it("fingerprints the template of a site that answers 200 for everything", async () => {
    const summary = await crawl(config({ siteUrl: soft404 }));
    const probe = (await crawlRow(summary.crawlId)).notfoundProbe as NotFoundProbeSample;
    expect(probe.statusCode).toBe(200);
    expect(probe.fetchClass).toBe("ok");
    expect(probe.wordCount).toBeGreaterThan(0);
    // Stored as the signed decimal string pages.simhash is compared against.
    expect(probe.simhash).toMatch(/^-?\d+$/);
  });

  it("says why the probe was skipped on a site that yielded no pages", async () => {
    const summary = await crawl(config({ siteUrl: closed }));
    expect(summary.pagesCrawled).toBe(0);
    const probe = (await crawlRow(summary.crawlId)).notfoundProbe as { skipped?: string };
    expect(probe.skipped).toMatch(/no pages/i);
  });

  it("walks the host variants before the crawl starts", async () => {
    const summary = await crawl(config());
    const probe = (await crawlRow(summary.crawlId)).hostProbe as HostProbeResult;
    expect(probe.variants.map((v) => v.start)).toEqual(hostProbeStarts(base));
    // The fixture is addressed by IP, so there is no www spelling to invent —
    // two starts, and no name this suite has to ask a real resolver about.
    expect(probe.variants.map((v) => v.start)).toEqual([
      `${base}/`,
      `${base.replace("http://", "https://")}/`,
    ]);

    const apex = probe.variants.find((v) => v.start === `${base}/`);
    expect(apex?.hops[0]?.statusCode).toBe(200);
    expect(apex?.final).toBe(`${base}/`);
  });

  it("leaves the host probe null when the caller turns it off", async () => {
    const summary = await crawl(config({ probeHosts: false }));
    expect((await crawlRow(summary.crawlId)).hostProbe).toBeNull();
  });

  it("refuses a legacy host it cannot read, before the crawl row exists", async () => {
    const before = await db.select().from(crawls).where(eq(crawls.siteUrl, base));
    await expect(
      runCrawl(db, config({ legacyHosts: ["not a host"] })),
    ).rejects.toThrow(/legacyHosts/);
    const after = await db.select().from(crawls).where(eq(crawls.siteUrl, base));
    // Nothing was created: a config we cannot read is not a crawl that ran.
    expect(after).toHaveLength(before.length);
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

  it("re-fetches a URL whose page row a hard kill left in the buffer", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const first = await crawl(config({ perHostDelayMs: 40 }), ac.signal);
    expect(first.status).toBe("cancelled");

    // The worker that gets killed: it leases a URL, fetches it, buffers the
    // page row — and the process dies before the buffer is flushed. Dropping
    // the writer with rows still in it is what a SIGKILL does to them.
    const doomed = await leaseBatch(db, first.crawlId, "worker_killed", 1, 600);
    const lost = doomed[0];
    if (lost === undefined) throw new Error("expected the cancelled crawl to leave work");
    const writer = new PageWriter(db, first.crawlId);
    await writer.addPage(
      lost,
      {
        url: lost.url,
        statusCode: 200,
        fetchClass: "ok",
        contentType: "text/html",
        redirectUrl: null,
        body: null,
        htmlBytes: 32,
        responseTimeMs: 1,
        canonicalHeader: null,
        xRobotsTag: null,
        disallowedReason: null,
      },
      null,
      { complete: true },
    );

    // Nothing durable, and — this is the fix — nothing marked done either. The
    // crawl still owes this URL, so the evidence is recoverable by re-fetching
    // it rather than lost behind a frontier row claiming the work was finished.
    const buffered = await db
      .select()
      .from(pages)
      .where(and(eq(pages.crawlId, first.crawlId), eq(pages.url, lost.url)));
    expect(buffered).toEqual([]);
    const owed = await db
      .select({ state: frontier.state })
      .from(frontier)
      .where(and(eq(frontier.crawlId, first.crawlId), eq(frontier.url, lost.url)));
    expect(owed[0]?.state).toBe("leased");

    // A fresh loop over the same crawl. `reclaimLeases` is the crash-resume
    // path: the dead worker's lease is released rather than waited out.
    const resumed = await resumeCrawl(db, first.crawlId, {
      config: config({ perHostDelayMs: 0 }),
      reclaimLeases: true,
    });

    expect(resumed.status).toBe("finished");
    const rows = await db.select().from(pages).where(eq(pages.crawlId, first.crawlId));
    // The lost URL was crawled again, and the site's page set is whole — one
    // row per URL, because the (crawl, url) conflict still absorbs re-crawls.
    expect(rows.map((r) => r.url)).toContain(lost.url);
    expect(rows).toHaveLength(6);
    expect(await frontierCounts(db, first.crawlId)).toMatchObject({
      pending: 0,
      leased: 0,
      done: 6,
    });
  });
});

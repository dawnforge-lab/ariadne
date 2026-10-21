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
  parseStoredConfig,
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
 *   /e               -> listed only by /sitemap-extra.xml, which robots.txt does
 *                       NOT declare: the page a crawl reaches only when the
 *                       client hands it the undeclared sitemap (P8-T3)
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
 * A site that throttles:
 *   /always-429 -> 429 for ever (the retries are spent, one blocked row)
 *   /flaky-403  -> 403 twice, then a real page (the third attempt lands)
 * Both are linked from `/`, and robots.txt 404s (absent -> allow all). This is
 * the Shopify/Cloudflare shape: a token bucket that refuses a burst and serves
 * the same URL happily once the crawler has slowed down.
 */
let throttleServer: Server;
let throttle: string;
let always429Hits = 0;
let flaky403Hits = 0;
/**
 * Opt-in hook the throttle site awaits on every `/always-429` request. Null for
 * every test but the per-host write-cadence one, which uses it to read the
 * persisted spacing map MID-CRAWL — the only way to observe that a non-widest
 * host's escalation is written within a batch and not merely at close.
 */
let onAlways429: (() => Promise<void>) | null = null;

/**
 * A site whose catch-all answers 200 with the same "not found" template for
 * every unknown URL — the soft-404 site the known-404 probe exists to catch.
 * robots.txt 404s (absent -> allow all) so the crawl itself is ordinary.
 */
let soft404Server: Server;
let soft404: string;

/**
 * A site whose pages answer with a `content-encoding` we never advertised.
 * The commonest real shape is a CDN that ignores `accept-encoding` and serves
 * brotli regardless — a deterministic non-answer, and the reason
 * `unsupported_encoding` must stay out of the retry bucket. robots.txt 404s
 * (absent -> allow all) so the crawl itself is ordinary.
 */
let brotliServer: Server;
let brotli: string;
/** Every non-robots path the brotli site was asked for, in order. */
let brotliHits: string[] = [];

/**
 * A site with a PAGE-level 5xx — the only fixture here that has one, and the
 * only shape INSERTION 3c asks a second question about:
 *   /       -> /boom-a, /boom-b
 *   /boom-a -> 500 for ever
 *   /boom-b -> 500 for ever
 * robots.txt 404s (absent -> allow all) so the crawl itself is ordinary.
 */
let boomServer: Server;
let boom: string;
/**
 * Every request to a `/boom` path, counted across the whole crawl: the page
 * loop's two (a server error is not in `RETRYABLE`, so it asks each once) and
 * then the recheck pass's. That makes hit 3 a KNOWN moment inside the pass.
 */
let boomHits = 0;
/**
 * Fired with the running count on each `/boom` request. The abort-during-recheck
 * case cancels from INSIDE the pass with it, which is the only way to stop at a
 * known row rather than at a hoped-for moment.
 */
let onBoomHit: ((n: number) => void) | null = null;

/**
 * One server answering on TWO gate hosts: its apex spelling (`localhost:PORT`)
 * and its `www.` variant (`www.localhost:PORT`). `isSameOrigin` admits the
 * variant into the crawl (same port, www<->apex hostname), but the gate keys by
 * `new URL(url).host` — which carries the hostname — so the two spellings are
 * two DISTINCT gate hosts that escalate independently. That is the only way the
 * main loop reaches a second gate host (a cross-PORT link is external and never
 * fetched); it is exactly the `www`/apex variant §3.1 of docs/gates/phase-13.md
 * named as the reachability of the stale-map hole.
 *
 * The apex host is throttled once on `/slow-a` (one 429 -> one escalation) and
 * the www host twice on `/slow-b` (two 429s -> two escalations), so with a 40 ms
 * base they earn 80 ms and 160 ms respectively — two real hosts at two real
 * distinct spacings, retiring the synthetic single-origin seed the per-host
 * resume test used to stand a second host in with (P14-T2). robots.txt 404s
 * (absent -> allow all).
 */
let twoHostServer: Server;
let twoHost: string;
/** The `www.` spelling of `twoHost`, synthesised once the port is known. */
let twoHostWww: string;
let slowAHits = 0;
let slowBHits = 0;

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
    // A sitemap no `Sitemap:` line points at. The engine never probes for it —
    // it is read only when a crawl is started with `sitemapUrls`.
    if (path === "/sitemap-extra.xml") {
      res.setHeader("content-type", "application/xml");
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${base}/e</loc><lastmod>2026-08-20</lastmod></url>` +
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
      // Linked from nowhere and listed only by the undeclared sitemap.
      "/e": html(`<p>undeclared sitemap only</p>`),
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

  throttleServer = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (path === "/always-429") {
      always429Hits += 1;
      if (onAlways429 !== null) await onAlways429();
      res.writeHead(429, { "content-type": "text/html", "retry-after": "0" });
      res.end("<html>slow down</html>");
      return;
    }
    if (path === "/flaky-403") {
      flaky403Hits += 1;
      if (flaky403Hits <= 2) {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<html>nope</html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html("<p>served once we slowed down</p>"));
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(`<a href="/always-429">a</a><a href="/flaky-403">f</a>`));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no");
  });
  throttle = await listen(throttleServer);

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

  brotliServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no robots here");
      return;
    }
    brotliHits.push(path);
    // A coding we never asked for. The bytes are irrelevant: we cannot decode
    // the label, so we never look at them.
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
    res.end(Buffer.from([0x1b, 0x00, 0x00, 0x00]));
  });
  brotli = await listen(brotliServer);

  boomServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no robots here");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(`<a href="/boom-a">a</a><a href="/boom-b">b</a>`));
      return;
    }
    if (path.startsWith("/boom")) {
      boomHits += 1;
      onBoomHit?.(boomHits);
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(html("<p>boom</p>"));
      return;
    }
    // The known-404 probe's URL lands here, and must not be counted as a boom.
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(html("<p>gone</p>"));
  });
  boom = await listen(boomServer);

  // Listened BY NAME so both `localhost` and `www.localhost` reach it — the two
  // gate hosts the two-host resume test crawls. `req.headers.host` tells the two
  // spellings apart; each throttles its own path a different number of times.
  twoHostServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no robots here");
      return;
    }
    const isWww = (req.headers.host ?? "").startsWith("www.");
    if (!isWww) {
      // The apex host: its home links to /slow-a (staying on this host) and to
      // the www home (crossing to the second gate host).
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html(`<a href="/slow-a">a</a><a href="${twoHostWww}/">www</a>`));
        return;
      }
      if (path === "/slow-a") {
        slowAHits += 1;
        if (slowAHits <= 1) {
          res.writeHead(429, { "content-type": "text/html", "retry-after": "0" });
          res.end("<html>slow down</html>");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html("<p>apex served once it backed off</p>"));
        return;
      }
    } else {
      // The www host: its home links to /slow-b (staying on this host).
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html(`<a href="/slow-b">b</a>`));
        return;
      }
      if (path === "/slow-b") {
        slowBHits += 1;
        if (slowBHits <= 2) {
          res.writeHead(429, { "content-type": "text/html", "retry-after": "0" });
          res.end("<html>slow down</html>");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html("<p>www served once it backed off</p>"));
        return;
      }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no");
  });
  twoHost = await listenByName(twoHostServer);
  twoHostWww = twoHost.replace("http://", "http://www.");

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
  throttleServer.closeAllConnections();
  await new Promise<void>((r) => throttleServer.close(() => r()));
  await new Promise<void>((r) => variantServer.close(() => r()));
  brotliServer.closeAllConnections();
  await new Promise<void>((r) => brotliServer.close(() => r()));
  await new Promise<void>((r) => soft404Server.close(() => r()));
  await new Promise<void>((r) => boomServer.close(() => r()));
  twoHostServer.closeAllConnections();
  await new Promise<void>((r) => twoHostServer.close(() => r()));
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

    // INSERTION 3c ran and found nothing to ask about — this site has no 5xx —
    // so it cost no request and no wall time, and the crawl says a pass IS on
    // record. That distinction is the whole reason `recheck_pass_at` exists
    // beside a count that is 0 here and 0 on a crawl nobody ever rechecked.
    expect(summary.recheck).toMatchObject({ rechecked: 0, capped: false, aborted: false });
    expect(crawlRow[0]?.recheckPassAt).not.toBeNull();
    expect(crawlRow[0]?.recheckPassCount).toBe(0);
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

  /**
   * The client-supplied sitemap (P8-T3). The engine refuses to guess at
   * `/sitemap.xml`, so a document the site publishes and never declares is
   * reachable exactly one way: somebody names it at crawl start.
   */
  it("walks a sitemap the client supplied that robots.txt never declares", async () => {
    const summary = await crawl(config({ sitemapUrls: [`${base}/sitemap-extra.xml`] }));

    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    const e = rows.find((r) => r.url === `${base}/e`);
    // Fetched, and recorded as a sitemap discovery rather than a link: nothing
    // on this site links to /e.
    expect(e?.fetchClass).toBe("ok");
    expect(e?.discoveredVia).toBe("sitemap");

    // And the entry is in `sitemap_urls` with the document it came from, with
    // the normalised spelling the sitemap rules join to `pages.url` on — a
    // supplied document's entries are evidence on exactly the same terms as a
    // declared one's.
    const entries = await db
      .select()
      .from(sitemapUrls)
      .where(eq(sitemapUrls.crawlId, summary.crawlId));
    const supplied = entries.find((r) => r.url === `${base}/e`);
    expect(supplied?.sitemapSource).toBe(`${base}/sitemap-extra.xml`);
    expect(supplied?.urlNormalised).toBe(`${base}/e`);
    expect(supplied?.lastmod).toBe("2026-08-20");
    // The declared document was walked too — supplying one adds, never replaces.
    expect(entries.map((r) => r.url).sort()).toEqual(
      [`${base}/`, `${base}/d`, `${base}/e`].sort(),
    );
  });

  it("walks a supplied sitemap the site already declares exactly once", async () => {
    // The client re-states what robots.txt says, in a spelling of their own.
    // Two names, one document: the origin gets one request, not two.
    const summary = await crawl(
      config({ sitemapUrls: [`${base}/sitemap.xml#gid=0`] }),
    );
    expect(summary.discovery.truncation.docsFetched).toBe(1);
    expect(summary.discovery.sitemapEntries).toBe(2);
    expect(summary.discovery.truncation.failures).toEqual([]);
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

    // INSERTION 3c did not run, and says so by being null rather than by
    // returning a summary of nothing (the `resources: null` precedent). An
    // abort means stop asking servers for things, and the recheck pass is all
    // asking — so `crawls.recheck_pass_at` stays null too: no complete pass is
    // on record, and a reader must not take a cancelled crawl's silence for
    // "the 5xx evidence was re-verified".
    expect(summary.recheck).toBeNull();
    expect(crawlRow[0]?.recheckPassAt).toBeNull();
    expect(crawlRow[0]?.recheckPassCount).toBe(0);
  });

  it("abort DURING the recheck pass cancels the crawl and stamps a count but no time", async () => {
    // The other half of the case above: there, the signal fired before INSERTION
    // 3c and the pass never ran (`recheck: null`). Here it fires with the pass IN
    // FLIGHT, which is the wiring the loop does by hand — the count stamped
    // whatever happened, the time withheld, and the pass's own `aborted` folded
    // into the crawl's status before the resource pass reads it.
    const ac = new AbortController();
    boomHits = 0;
    // A 5xx is not in the loop's `RETRYABLE` set, so the page crawl asks each of
    // the two broken pages exactly once: hit 3 is the RECHECK's first request,
    // and the abort lands between the row it is settling and the row after it.
    onBoomHit = (n) => {
      if (n === 3) ac.abort();
    };
    let summary;
    try {
      summary = await crawl(
        // The test-only gap (P17-T5), so the pass reaches its first row in
        // milliseconds rather than after a real minute.
        config({ siteUrl: boom, recheckMinGapMs: 50 }),
        ac.signal,
      );
    } finally {
      onBoomHit = null;
    }

    // Two by the crawl, one by the pass, and nothing after the signal fired.
    expect(boomHits).toBe(3);
    expect(summary.status).toBe("cancelled");
    // The pass RAN, unlike the case above, and says what it settled before it
    // was stopped.
    expect(summary.recheck).toMatchObject({ rechecked: 1, capped: false, aborted: true });
    // And its abort is the crawl's: the resource pass is the next thing that
    // would talk to this site, and it never ran (`resources: null`).
    expect(summary.resources).toBeNull();

    const [row] = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    expect(row?.status).toBe("cancelled");
    // THE ASYMMETRY, which is the whole reason both columns exist: the COUNT is
    // stamped whatever happened, so an aborted pass says what it actually did;
    // the TIME is stamped only by a pass that COMPLETED, so no reader can take
    // this crawl's silence for "the 5xx evidence was re-verified".
    expect(row?.recheckPassCount).toBe(1);
    expect(row?.recheckPassAt).toBeNull();

    // One row settled, one left exactly as the crawl wrote it — both nulls,
    // nothing decided, and no `recheck-cap`: that is the resume's work list.
    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    const errors = rows.filter((r) => r.fetchClass === "server_error");
    expect(errors).toHaveLength(2);
    const settled = errors.filter((r) => r.recheckFetchClass !== null);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.recheckFetchClass).toBe("server_error");
    expect(settled[0]?.recheckStatusCode).toBe(500);
    const untouched = errors.filter((r) => r.recheckFetchClass === null);
    expect(untouched).toHaveLength(1);
    expect(untouched[0]?.recheckReason).toBeNull();
    expect(untouched[0]?.recheckAt).toBeNull();
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
    // The test-only recheck gap: since Phase 23 the `network_error` row below is
    // re-asked at crawl end, and the real 60 s floor would be waited for.
    const summary = await crawl(config({ siteUrl: broken, recheckMinGapMs: 50 }));

    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    // Reset twice, then served: the row is the *third* attempt's outcome, not
    // the first failure that happened to be written first.
    expect(flappyHits).toBe(3);
    expect(byUrl.get(`${broken}/flappy`)?.fetchClass).toBe("ok");

    // Reset for ever: three attempts, then one row carrying the failure — and
    // since Phase 23 ONE more request, the recheck pass's, whose answer sits
    // beside the first observation rather than replacing it.
    expect(alwaysBrokenHits).toBe(4);
    expect(byUrl.get(`${broken}/always-broken`)?.fetchClass).toBe("network_error");
    expect(byUrl.get(`${broken}/always-broken`)?.recheckFetchClass).toBe("network_error");

    // The frontier agrees: the retried URL is done, the exhausted one failed.
    expect(summary.frontier.done).toBe(2); // / and /flappy
    expect(summary.frontier.failed).toBe(1); // /always-broken
    expect(summary.frontier.pending).toBe(0);
    expect(rows).toHaveLength(3);
  });

  it("retries a block under widening spacing instead of ending the page", async () => {
    always429Hits = 0;
    flaky403Hits = 0;
    // A real per-host delay, so the escalation has something to double. Kept
    // tiny: what is under test is the ratchet, not the wall clock.
    const started = Date.now();
    const summary = await crawl(config({ siteUrl: throttle, perHostDelayMs: 5 }));
    const elapsed = Date.now() - started;

    const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    // Throttled twice, then served: a 429 is no longer a permanent verdict on
    // the URL, and only the settling attempt is written.
    expect(flaky403Hits).toBe(3);
    expect(byUrl.get(`${throttle}/flaky-403`)?.fetchClass).toBe("ok");

    // Throttled for ever: three paced attempts, then ONE classified row.
    expect(always429Hits).toBe(3);
    const blockedRow = byUrl.get(`${throttle}/always-429`);
    expect(blockedRow?.fetchClass).toBe("blocked");
    expect(blockedRow?.statusCode).toBe(429);
    // The row says what happened AND how hard the engine had backed off by the
    // time it gave up — the number an operator needs to decide whether to
    // re-crawl slower or stop and call the site's owner.
    const reason = blockedRow?.fetchReason ?? "";
    expect(reason).toContain("blocked (429)");
    expect(reason).toContain("3 attempts");
    expect(reason).toMatch(/spacing reached \d+ms/);

    // The frontier agrees: the retried URL is done, the exhausted one failed.
    expect(summary.frontier.done).toBe(2); // / and /flaky-403
    expect(summary.frontier.failed).toBe(1); // /always-429
    expect(summary.frontier.pending).toBe(0);
    expect(rows).toHaveLength(3);

    // Five blocks on one host at a 5ms base is 10+20+40+80+160ms of ratchet —
    // real spacing, and nowhere near a stalled crawl. The upper bound is what
    // says the escalation is capped and does not compound per request.
    expect(elapsed).toBeLessThan(30_000);
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
    // Nobody handed this crawl a sitemap: present and empty, which is what
    // "the walk read only what robots.txt declared" looks like.
    expect(discovery.suppliedSitemaps).toEqual([]);
    expect(discovery.docsFetched).toBe(1);
    expect(discovery.truncation.failures).toEqual([]);
  });

  /**
   * The provenance of the documents the walk read. Two lists, never one: a
   * supplied sitemap folded into `sitemapSources` would make `sitemap.missing`
   * (CHECK-06) go quiet about a robots.txt that still declares nothing.
   */
  it("records which sitemaps robots.txt declared and which the client supplied", async () => {
    const summary = await crawl(config({ sitemapUrls: [`${base}/sitemap-extra.xml`] }));
    const discovery = (await crawlRow(summary.crawlId)).discovery as DiscoveryEvidence;

    expect(discovery.sitemapSources).toEqual([`${base}/sitemap.xml`]);
    expect(discovery.suppliedSitemaps).toEqual([`${base}/sitemap-extra.xml`]);
    // Both documents were read; neither list is the whole of the walk.
    expect(discovery.docsFetched).toBe(2);
    expect(discovery.truncation.failures).toEqual([]);
  });

  it("keeps both provenances for a document that was declared and supplied", async () => {
    const summary = await crawl(config({ sitemapUrls: [`${base}/sitemap.xml`] }));
    const discovery = (await crawlRow(summary.crawlId)).discovery as DiscoveryEvidence;

    // The same document in both lists. It was declared AND it was supplied,
    // and either fact alone would be a smaller, less true answer — while the
    // walk still fetched it once (docsFetched).
    expect(discovery.sitemapSources).toEqual([`${base}/sitemap.xml`]);
    expect(discovery.suppliedSitemaps).toEqual([`${base}/sitemap.xml`]);
    expect(discovery.docsFetched).toBe(1);
  });

  it("refuses a supplied sitemap it cannot read, before the crawl row exists", async () => {
    const before = await db.select().from(crawls).where(eq(crawls.siteUrl, base));
    await expect(
      runCrawl(db, config({ sitemapUrls: ["/sitemap.xml"] })),
    ).rejects.toThrow(/sitemapUrls/);
    const after = await db.select().from(crawls).where(eq(crawls.siteUrl, base));
    expect(after).toHaveLength(before.length);
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

  // THE POLITENESS RATCHET ACROSS A RESUME (P12-T3, rule 9).
  //
  // `crawls.host_spacing_ms` is a finding, not a setting: it was written because
  // the site pushed back and the engine listened. A resume that rebuilt its gate
  // from `perHostDelayMs` alone would go back to hitting that host at the
  // configured pace and would overwrite the evidence with the base on its first
  // `recordSpacing`, so the operator could not even see that it had happened —
  // which is the same defect `renderPaceMs` fixed for the render pass in Phase 6.
  it("resumes at the spacing the crawl earned, not the one it was configured with", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const first = await crawl(config({ perHostDelayMs: 40 }), ac.signal);
    expect(first.status).toBe("cancelled");

    // What the first run would have written had the site refused it: the column
    // is set directly because the fixture site never blocks, and the number is
    // the only thing the resume can read the ratchet out of.
    await db.update(crawls).set({ hostSpacingMs: 250 }).where(eq(crawls.id, first.crawlId));

    const resumed = await resumeCrawl(db, first.crawlId, {
      config: config({ perHostDelayMs: 0 }),
    });
    expect(resumed.status).toBe("finished");

    const [row] = await db.select().from(crawls).where(eq(crawls.id, first.crawlId));
    expect(row?.hostSpacingMs).toBeGreaterThanOrEqual(250);
  });

  // THE PER-HOST RATCHET ACROSS A RESUME (P13-T3, rule 9).
  //
  // `crawls.host_spacing_jsonb` is the SAME finding as `host_spacing_ms`, split
  // per host so a resume re-enters each host at ITS OWN earned spacing instead of
  // at the single crawl-wide widest. The crown pattern of the test above, now
  // reading the map: the number is written to the column directly (the fixture
  // never blocks), the resume folds it in per host, and it survives the round
  // trip — the map is re-persisted at close. This single mapped host is the
  // cheap map-round-trip companion; the genuine two-host divergence (two real
  // gate hosts earning different spacings from real pushback, each resuming at
  // its own) is the test below, and the gate-level unit is politeness.test.ts's
  // "re-enters each host at ITS OWN earned spacing".
  it("resumes each host at its own earned spacing from the per-host map", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const first = await crawl(config({ perHostDelayMs: 40 }), ac.signal);
    expect(first.status).toBe("cancelled");

    const host = new URL(base).host;
    // What the first run would have written for this host had the site refused
    // it: the per-host map beside the crawl-wide number.
    await db
      .update(crawls)
      .set({ hostSpacingMs: 250, hostSpacingJsonb: { [host]: 250 } })
      .where(eq(crawls.id, first.crawlId));

    const resumed = await resumeCrawl(db, first.crawlId, {
      config: config({ perHostDelayMs: 0 }),
    });
    expect(resumed.status).toBe("finished");

    const [row] = await db.select().from(crawls).where(eq(crawls.id, first.crawlId));
    // The host re-entered its own 250 (config floor was 0), and the map is
    // re-persisted rather than dropped on the resume.
    expect(row?.hostSpacingJsonb?.[host]).toBeGreaterThanOrEqual(250);
    expect(row?.hostSpacingMs).toBeGreaterThanOrEqual(250);
  });

  // THE PER-HOST RATCHET, PROVEN ON TWO REAL GATE HOSTS (P14-T2, rule 9).
  //
  // The test above seeds ONE host's earned spacing directly, because its fixture
  // is single-origin — a stand-in the per-host map's whole reason for existing
  // (divergence between hosts) could not be shown against. This one earns it for
  // real: a crawl that genuinely visits two distinct gate hosts, each throttled
  // a different number of times, so each earns its OWN spacing from real 429s and
  // the map records the divergence with no synthetic seed.
  //
  // The two hosts are the apex and `www.` spellings of one server (§3.1 of
  // docs/gates/phase-13.md: the only second gate host the main loop can reach,
  // since a cross-port link is external). The apex is refused once on /slow-a
  // (one escalation: 40 -> 80 ms); the www host twice on /slow-b (two: 40 -> 160
  // ms). A resume rebuilds the gate from the map, and each host re-enters its own
  // number — the pre-0015 behaviour would have seeded BOTH at the crawl-wide
  // widest (160), so the apex staying at 80 is the proof it did not inherit the
  // www host's spacing (migration 0015).
  it("earns two real hosts' distinct spacings and resumes each at its own", async () => {
    slowAHits = 0;
    slowBHits = 0;
    const hostA = new URL(twoHost).host;
    const hostB = new URL(twoHostWww).host;

    const first = await crawl(
      config({ siteUrl: twoHost, perHostDelayMs: 40, probeHosts: false }),
    );
    expect(first.status).toBe("finished");

    // Both hosts were really fetched — the crawl crossed from apex to www.
    const rows = await db.select().from(pages).where(eq(pages.crawlId, first.crawlId));
    const fetchedHosts = new Set(rows.map((r) => new URL(r.url).host));
    expect(fetchedHosts.has(hostA)).toBe(true);
    expect(fetchedHosts.has(hostB)).toBe(true);

    // The map records BOTH hosts at DIFFERENT earned spacings, and the crawl-wide
    // column is the widest of the two.
    const [earned] = await db.select().from(crawls).where(eq(crawls.id, first.crawlId));
    expect(earned?.hostSpacingJsonb?.[hostA]).toBe(80);
    expect(earned?.hostSpacingJsonb?.[hostB]).toBe(160);
    expect(earned?.hostSpacingMs).toBe(160);

    // Resume: the gate is rebuilt from the per-host map, so each host re-enters
    // ITS OWN earned spacing. Config floor is 0, so nothing lifts either host;
    // the apex holding 80 while the www host holds 160 is the divergence.
    const resumed = await resumeCrawl(db, first.crawlId, {
      config: config({ siteUrl: twoHost, perHostDelayMs: 0, probeHosts: false }),
    });
    expect(resumed.status).toBe("finished");

    const [row] = await db.select().from(crawls).where(eq(crawls.id, first.crawlId));
    expect(row?.hostSpacingJsonb?.[hostA]).toBe(80);
    expect(row?.hostSpacingJsonb?.[hostB]).toBe(160);
  });

  // A pre-0015 row has a null map, and the resume must fall back to the
  // crawl-wide `host_spacing_ms` exactly as it did before per-host existed —
  // honest degradation, never a fabricated split.
  it("falls back to the crawl-wide spacing when the per-host map is null (pre-0015)", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const first = await crawl(config({ perHostDelayMs: 40 }), ac.signal);
    expect(first.status).toBe("cancelled");

    // The crawl-wide number only — no map, as a row written before 0015 carries.
    await db
      .update(crawls)
      .set({ hostSpacingMs: 250, hostSpacingJsonb: null })
      .where(eq(crawls.id, first.crawlId));

    const resumed = await resumeCrawl(db, first.crawlId, {
      config: config({ perHostDelayMs: 0 }),
    });
    expect(resumed.status).toBe("finished");

    const [row] = await db.select().from(crawls).where(eq(crawls.id, first.crawlId));
    expect(row?.hostSpacingMs).toBeGreaterThanOrEqual(250);
  });

  // THE RULE-9 HOLE THE FIX-ROUND CLOSES (P13-T3). A host already IN the per-host
  // map, resumed BELOW the crawl-wide widest, can escalate WITHOUT moving the
  // widest — so a map write keyed on the widest alone would never re-persist it,
  // and a hard kill before the close write would seed the next resume at the
  // STALE lower value: that host re-entering FASTER than it earned. The write
  // must fire when the HOST moves, not only the widest. Observed mid-crawl,
  // because a clean close writes the full map either way — the discriminator is
  // whether the escalation reaches the row DURING the crawl, which is what a
  // hard kill would rely on.
  it("re-persists a non-widest host's escalation mid-crawl, not only at close", async () => {
    const originHost = new URL(throttle).host;

    // A cancelled first run, only to mint a resumable crawl row + frontier.
    const preAborted = new AbortController();
    preAborted.abort();
    const first = await crawl(
      config({ siteUrl: throttle, perHostDelayMs: 40, probeHosts: false }),
      preAborted.signal,
    );
    expect(first.status).toBe("cancelled");

    // The prior run's finding: some OTHER host earned the crawl-wide widest
    // 10_000 ms (the fallback), while this origin earned only its 40 ms base —
    // re-entered here BELOW the widest.
    await db
      .update(crawls)
      .set({ hostSpacingMs: 10_000, hostSpacingJsonb: { [originHost]: 40 } })
      .where(eq(crawls.id, first.crawlId));

    // Read the origin's persisted spacing on every `/always-429` hit. The
    // retries are requests served AFTER the first escalation's batch-boundary
    // write, so with the fix they observe the escalated value and without it the
    // seeded 40 for ever (the widest never moves, so a widest-keyed write never
    // fires mid-crawl).
    const observed: number[] = [];
    onAlways429 = async () => {
      const [r] = await db
        .select({ m: crawls.hostSpacingJsonb })
        .from(crawls)
        .where(eq(crawls.id, first.crawlId));
      const v = r?.m?.[originHost];
      if (typeof v === "number") observed.push(v);
    };
    try {
      const resumed = await resumeCrawl(db, first.crawlId, {
        config: config({ siteUrl: throttle, perHostDelayMs: 40, probeHosts: false }),
      });
      expect(resumed.status).toBe("finished");
    } finally {
      onAlways429 = null;
    }

    // The origin escalated (40 → 80 → …) while staying under the 10_000 widest,
    // and its move reached the row within a batch — not just at close.
    expect(Math.max(0, ...observed)).toBeGreaterThanOrEqual(80);
    // And the final row carries at least what the host earned, so a further
    // resume re-enters it no faster than the site allowed (rule 9).
    const [row] = await db.select().from(crawls).where(eq(crawls.id, first.crawlId));
    expect(row?.hostSpacingJsonb?.[originHost]).toBeGreaterThanOrEqual(80);
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
        retryAfterMs: null,
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

/**
 * `unsupported_encoding` is an ANSWER, not a failed attempt.
 *
 * It was originally classified `network_error`, which is in loop's TRANSIENT
 * set — so every page of a CDN that ignores `accept-encoding` was fetched three
 * times for three identical undecodable replies. Triple the load on someone
 * else's origin for no information, which is exactly what rule 9 forbids and
 * what TRANSIENT's own docblock says the set is for.
 */
describe("unsupported_encoding is not retried", () => {
  it("fetches an undecodable page once and records why", async () => {
    brotliHits = [];
    const summary = await crawl(config({ siteUrl: brotli, probeHosts: false }));

    const rows = await db
      .select()
      .from(pages)
      .where(and(eq(pages.crawlId, summary.crawlId), eq(pages.url, `${brotli}/`)));
    const row = rows[0];
    expect(row?.fetchClass).toBe("unsupported_encoding");
    // Persisted, so the row is actionable rather than an unexplained failure.
    expect(row?.fetchReason).toBe("unsupported content-encoding (br)");

    // ONE fetch of the page, not MAX_ATTEMPTS. This is the whole point of the
    // class. (The other hit is the known-404 probe on the way out, which asks
    // for a URL that does not exist and is not a retry of anything.)
    expect(brotliHits.filter((path) => path === "/")).toEqual(["/"]);
    const state = await db
      .select({ state: frontier.state, attempts: frontier.attempts })
      .from(frontier)
      .where(and(eq(frontier.crawlId, summary.crawlId), eq(frontier.url, `${brotli}/`)));
    expect(state[0]?.attempts).toBe(1);
    // And it is `done`: we have our answer, poor as it is. A `failed` row would
    // invite a resume to ask again.
    expect(state[0]?.state).toBe("done");
  });
});

/**
 * Build-plan §7 "before the first real-site crawl", item 3.
 *
 * `allowPrivate` is a test-only escape hatch. The defect these pin is that it
 * used to be written into `crawls.config_jsonb` with everything else, so every
 * resume of that crawl — days later, from a row nobody reads — silently
 * switched it back on. A dangerous setting that carries itself forward without
 * anyone re-stating the intent is the silent fallback hard rule 7 forbids.
 */
describe("the test-only config fields are not persisted", () => {
  it("is stripped from the config the crawls row stores", async () => {
    const summary = await crawl(config());
    const rows = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    const stored = rows[0]?.config as Record<string, unknown>;

    // Gone entirely, not stored as false: the row should not carry the field
    // at all, so nobody reading it can mistake it for a decision.
    expect(stored).not.toHaveProperty("allowPrivate");
    // …and nothing else was lost on the way out.
    expect(stored).toMatchObject({
      siteUrl: base,
      maxPages: 100,
      maxDepth: 10,
      userAgent: "AriadneBot-test",
      perHostDelayMs: 0,
      maxConcurrency: 4,
    });
  });

  /**
   * `recheckMinGapMs` is the second test-only field and it is stripped by the
   * same function for a reason of its own (P17-T5).
   *
   * The floor under the gap between the two 5xx observations is the CLAIM THE
   * EVIDENCE MAKES — "still broken a minute later" — and the knob exists only so
   * a loop-driven test does not sit out that minute. A row that carried it would
   * make the shortened claim DURABLE: every resume of this crawl, months later,
   * in a process nobody is watching, would re-ask its server errors a fifth of a
   * second after seeing them and report the answer as if a minute had passed.
   * That is the silent fallback hard rule 7 forbids, one field over from the one
   * the strip was written for.
   *
   * Asserted on the stored blob AND through `parseStoredConfig`, because the
   * strip and the closed read-back field set are two independent walls and
   * either one going missing is the same defect.
   */
  it("strips the test-only recheck gap from the stored config, and never reads it back", async () => {
    const summary = await crawl(config({ recheckMinGapMs: 200 }));
    const rows = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    const stored = rows[0]?.config as Record<string, unknown>;

    // Gone entirely, not stored as 60000: the row should not carry the field at
    // all, so nobody reading it can mistake it for a decision somebody took.
    expect(stored).not.toHaveProperty("recheckMinGapMs");
    expect(stored).not.toHaveProperty("allowPrivate");
    // …and the strip took only the two test-only fields.
    expect(stored).toMatchObject({
      siteUrl: base,
      maxPages: 100,
      maxDepth: 10,
      userAgent: "AriadneBot-test",
      perHostDelayMs: 0,
      maxConcurrency: 4,
    });

    // The second wall: a row that carried it anyway — written by an older
    // process, or edited by hand — must not be the thing that shortens a
    // resume's gap. The closed field set does not read it.
    const revived = parseStoredConfig({ ...stored, recheckMinGapMs: 1 }, summary.crawlId);
    expect(revived.recheckMinGapMs).toBeUndefined();
  });

  /**
   * The supplied sitemap list is a FIRST-CLASS config field, not a start-time
   * argument: a resume must walk the same documents the first run did, or it
   * would report the difference as the site's.
   */
  it("carries the supplied sitemaps through the stored config and back", async () => {
    const summary = await crawl(config({ sitemapUrls: [`${base}/sitemap-extra.xml`] }));
    const rows = await db.select().from(crawls).where(eq(crawls.id, summary.crawlId));
    const stored = rows[0]?.config as Record<string, unknown>;

    // The allowPrivate strip took only allowPrivate.
    expect(stored).not.toHaveProperty("allowPrivate");
    expect(stored["sitemapUrls"]).toEqual([`${base}/sitemap-extra.xml`]);
    // And the closed field set reads it back rather than dropping it.
    expect(parseStoredConfig(stored, summary.crawlId).sitemapUrls).toEqual([
      `${base}/sitemap-extra.xml`,
    ]);
  });

  it("refuses a stored sitemapUrls of the wrong shape rather than resuming without it", async () => {
    const summary = await crawl(config());
    expect(() =>
      parseStoredConfig({ ...config(), sitemapUrls: "one.xml" }, summary.crawlId),
    ).toThrow(/sitemapUrls is not an array of strings/);
  });

  it("does not come back on a resume that does not re-assert it", async () => {
    const first = await crawl(config());
    expect(first.pagesCrawled).toBeGreaterThan(0);

    // No `config` — so the resume runs on what the row holds, and the row does
    // not hold the escape hatch. The fixture server is on 127.0.0.1, so
    // url-policy now refuses its robots.txt, which is complete disallow
    // (RFC 9309 §2.3.1.4) and a `failed` crawl rather than a quiet no-op.
    const resumed = await resumeCrawl(db, first.crawlId, { reclaimLeases: true });
    expect(resumed.status).toBe("failed");
    expect(resumed.note).toMatch(/robots\.txt unreachable/);
    expect(resumed.note).toMatch(/refused by URL policy/);
  });

  it("comes back when the caller re-asserts it in the resume config", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const first = await crawl(config({ perHostDelayMs: 40 }), ac.signal);
    expect(first.status).toBe("cancelled");

    // The same resume, with the hatch re-stated at the call site — explicit,
    // in the open, and scoped to this call. That is the whole contract.
    const resumed = await resumeCrawl(db, first.crawlId, {
      config: config({ perHostDelayMs: 0 }),
      reclaimLeases: true,
    });
    expect(resumed.status).toBe("finished");
  });

  it("ignores an allowPrivate left in a stored config by an older writer", async () => {
    const summary = await crawl(config());
    // A row as the pre-strip code would have written it — or as a hand edit
    // would. Reading it back must not be the thing that turns the hatch on.
    const stored = { ...(config() as unknown as Record<string, unknown>), allowPrivate: true };
    await db
      .update(crawls)
      .set({ config: stored })
      .where(eq(crawls.id, summary.crawlId));

    const resumed = await resumeCrawl(db, summary.crawlId, { reclaimLeases: true });
    expect(resumed.status).toBe("failed");
    expect(resumed.note).toMatch(/robots\.txt unreachable/);
  });
});

/**
 * Phase 27d Task 4: a pause or cancel stops the crawl while it is still in the
 * host probe or the sitemap discovery walk, within the spec's stop target —
 * `CONTROL_POLL_MS` (1 s) + 1 s, from the `control_request` write to the row's
 * terminal status.
 *
 * Every fixture stall is far beyond that bound (a 5 s probe answer, 3 s
 * sitemap children, 15 s pages), so no test can pass by the fixture finishing
 * on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";

import { ApiService } from "../../src/api/service.js";
import { CONTROL_POLL_MS, setControlRequest } from "../../src/crawl/control.js";
import { discover, DiscoveryAbortedError, type SitemapSink } from "../../src/crawl/discovery.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import {
  resumeCrawl,
  runCrawl,
  type CrawlConfig,
  type CrawlSummary,
  type LoopTestHooks,
} from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages, sitemapMemberships, sitemapUrls } from "../../src/db/schema.js";

/** The spec's stop target: one poll interval, plus one second for the close. */
const STOP_TARGET_MS = CONTROL_POLL_MS + 1_000;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` every 10 ms until it holds, or throw naming what never happened. */
async function until(
  what: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

let db: Db;
const createdCrawls: string[] = [];
const servers: Server[] = [];
/** Responses a fixture is still holding, destroyed at teardown. */
const held = new Set<ServerResponse>();

/** Answer `res` after `ms`, unless the client has gone by then. */
function answerLater(res: ServerResponse, ms: number, answer: () => void): void {
  held.add(res);
  const timer = setTimeout(() => {
    held.delete(res);
    answer();
  }, ms);
  res.on("close", () => {
    clearTimeout(timer);
    held.delete(res);
  });
}

function html(res: ServerResponse, title: string, links: string[] = []): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><title>${title}</title></head><body>` +
      links.map((href) => `<a href="${href}">${href}</a>`).join(" ") +
      `</body></html>`,
  );
}

function xml(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "application/xml" });
  res.end(body);
}

function urlset(locs: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("") +
    `</urlset>`
  );
}

interface Site {
  base: string;
  /** Every request path the site has seen, in order. */
  seen: string[];
}

async function site(handler: (req: IncomingMessage, res: ServerResponse, base: string) => void): Promise<Site> {
  const s: Site = { base: "", seen: [] };
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    s.seen.push(path);
    handler(req, res, s.base);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return s;
}

function path(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

/**
 * THE PROBE SITE. Its home page answers after 5 s, so the host probe's first
 * hop (`http://127.0.0.1:<port>/`) is in flight for 5 s.
 */
let probeSite: Site;

/**
 * THE INDEX SITE. robots.txt declares a sitemap index of two children, each of
 * which answers after 3 s.
 */
let indexSite: Site;

/**
 * THE FLUSH-HEAVY SITE. robots.txt declares one sitemap of HEAVY_LOCS `<loc>`s,
 * a document that arrives in several chunks and so is flushed several times;
 * every page it lists answers at once.
 */
let heavySite: Site;
const HEAVY_LOCS = 10_000;
let heavyXml = "";

/**
 * THE SLOW-PAGE SITE. A two-URL sitemap that is read at once, and pages that
 * answer after 15 s: a stop that lands once discovery is over finds the seed's
 * fetch in flight, never finished.
 */
let slowPageSite: Site;

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  probeSite = await site((req, res) => {
    const p = path(req);
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    answerLater(res, 5_000, () => html(res, "late home"));
  });

  indexSite = await site((req, res, base) => {
    const p = path(req);
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap-index.xml\n`);
      return;
    }
    if (p === "/sitemap-index.xml") {
      xml(
        res,
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<sitemap><loc>${base}/sm-1.xml</loc></sitemap>` +
          `<sitemap><loc>${base}/sm-2.xml</loc></sitemap>` +
          `</sitemapindex>`,
      );
      return;
    }
    const child = /^\/sm-(\d)\.xml$/.exec(p);
    if (child !== null) {
      answerLater(res, 3_000, () => xml(res, urlset([`${base}/c${child[1]}`])));
      return;
    }
    html(res, `page ${p}`);
  });

  heavySite = await site((req, res, base) => {
    const p = path(req);
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/heavy.xml\n`);
      return;
    }
    if (p === "/heavy.xml") {
      xml(res, heavyXml);
      return;
    }
    html(res, `page ${p}`, p === "/" ? ["/p/1", "/p/2"] : []);
  });
  const heavyLocs: string[] = [];
  for (let n = 1; n <= HEAVY_LOCS; n += 1) heavyLocs.push(`${heavySite.base}/p/${n}`);
  heavyXml = urlset(heavyLocs);

  slowPageSite = await site((req, res, base) => {
    const p = path(req);
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
      return;
    }
    if (p === "/sitemap.xml") {
      xml(res, urlset([`${base}/a`, `${base}/b`]));
      return;
    }
    answerLater(res, 15_000, () => html(res, `late ${p}`));
  });
});

afterAll(async () => {
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  for (const res of held) res.destroy();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

function config(s: Site, overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: `${s.base}/`,
    maxPages: 3,
    maxDepth: 3,
    userAgent: "AriadneBot-stop-early-test",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    probeHosts: false,
    allowPrivate: true,
    fetchResources: false,
    ...overrides,
  };
}

/** The id of the crawl of `siteUrl` this test just started (`runCrawl` has not returned). */
async function newCrawlOf(siteUrl: string): Promise<string> {
  let id: string | null = null;
  await until(`a new crawl row for ${siteUrl}`, async () => {
    const rows = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.siteUrl, siteUrl));
    const fresh = rows.filter((r) => !createdCrawls.includes(r.id));
    if (fresh.length > 1) throw new Error(`two new crawls of ${siteUrl} at once`);
    id = fresh[0]?.id ?? null;
    return id !== null;
  });
  if (id === null) throw new Error("unreachable");
  const crawlId: string = id;
  createdCrawls.push(crawlId);
  return crawlId;
}

async function crawlRow(id: string) {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row;
}

async function frontierRows(id: string) {
  return db.select().from(frontier).where(eq(frontier.crawlId, id));
}

async function pageRows(id: string) {
  return db.select().from(pages).where(eq(pages.crawlId, id));
}

async function sitemapUrlSet(id: string): Promise<string[]> {
  const rows = await db.select({ url: sitemapUrls.url }).from(sitemapUrls).where(eq(sitemapUrls.crawlId, id));
  return rows.map((r) => r.url).sort();
}

async function membershipCount(id: string): Promise<number> {
  const rows = await db
    .select({ url: sitemapMemberships.url })
    .from(sitemapMemberships)
    .where(eq(sitemapMemberships.crawlId, id));
  return rows.length;
}

/**
 * Write `request` for the running crawl `id` and resolve with the time it took
 * the row to reach `terminal` — the spec's measure of a stop.
 */
async function requestAndMeasure(id: string, request: "pause" | "cancel", setAt?: number): Promise<number> {
  const terminal = request === "pause" ? "paused" : "cancelled";
  let at = setAt;
  if (at === undefined) {
    at = Date.now();
    expect(await setControlRequest(db, id, request)).toBe(true);
  }
  await until(`the row to read ${terminal}`, async () => (await crawlRow(id)).status === terminal, 20_000);
  return Date.now() - at;
}

/** Run a crawl with its rejection observed, so a stop test never leaves one unhandled. */
function start(cfg: CrawlConfig, hooks?: LoopTestHooks): Promise<CrawlSummary> {
  const run = runCrawl(db, cfg, undefined, hooks);
  run.catch(() => undefined);
  return run;
}

/**
 * The crawl id for a hook: the run may reach the hook before `newCrawlOf` has
 * read the row, so the hook awaits the id rather than racing for it.
 */
function deferredId(): { promise: Promise<string>; resolve: (id: string) => void } {
  let resolve!: (id: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("a stop during the host probe", () => {
  it("pause: paused within the stop target, no discovery evidence and no frontier rows", async () => {
    const before = probeSite.seen.filter((p) => p === "/").length;
    const run = start(config(probeSite, { probeHosts: true }));
    const id = await newCrawlOf(`${probeSite.base}/`);
    await until("the probe's first hop in flight", () => probeSite.seen.filter((p) => p === "/").length > before);

    const latencyMs = await requestAndMeasure(id, "pause");
    console.log(`pause during probe: ${latencyMs} ms`);
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.pauseReason).toBe("request");
    expect(summary.robots).toBeNull();
    expect(summary.discovery).toBeNull();
    expect(summary.sitemapsRead).toBeNull();

    const row = await crawlRow(id);
    expect(row.status).toBe("paused");
    expect(row.pauseReason).toBe("request");
    expect(row.controlRequest).toBeNull();
    expect(row.discovery).toBeNull();
    expect(row.hostProbe).toBeNull();
    expect(row.notfoundProbe).toEqual({
      skipped: "crawl stopped (paused or cancelled) before the known-404 probe",
    });
    expect(await frontierRows(id)).toEqual([]);
    // Nothing was asked of robots.txt: the stop came first.
    expect(probeSite.seen).not.toContain("/robots.txt");
  }, 30_000);

  it("cancel: cancelled within the stop target, and the status read says it never ran", async () => {
    const before = probeSite.seen.filter((p) => p === "/").length;
    const run = start(config(probeSite, { probeHosts: true }));
    const id = await newCrawlOf(`${probeSite.base}/`);
    await until("the probe's first hop in flight", () => probeSite.seen.filter((p) => p === "/").length > before);

    const latencyMs = await requestAndMeasure(id, "cancel");
    console.log(`cancel during probe: ${latencyMs} ms`);
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("cancelled");
    expect(summary.note).toBe("cancelled; 0 URL(s) were never fetched");

    const row = await crawlRow(id);
    expect(row.cancelledAt).not.toBeNull();
    expect(row.discovery).toBeNull();
    expect(await frontierRows(id)).toEqual([]);

    // The 27b never-ran wording (Ruling 11): no count of URLs never fetched,
    // because nothing was seen, and the rules refuse a crawl that never ran.
    const service = new ApiService(db, { allowedDomains: ["127.0.0.1"], log: () => {} });
    const detail = await service.getCrawl(id);
    expect(detail.status).toBe("cancelled");
    expect(detail.neverFetched).toBeNull();
    await expect(service.runRulesForCrawl(id)).rejects.toThrow(/never ran \(it was cancelled before discovery\)/);
  }, 30_000);
});

describe("a stop during the sitemap walk", () => {
  it("pause: paused within the stop target, no sitemap entries enqueued, no discovery evidence", async () => {
    const before = indexSite.seen.filter((p) => p.startsWith("/sm-")).length;
    const run = start(config(indexSite));
    const id = await newCrawlOf(`${indexSite.base}/`);
    await until("a sitemap child in flight", () => indexSite.seen.filter((p) => p.startsWith("/sm-")).length > before);

    const latencyMs = await requestAndMeasure(id, "pause");
    console.log(`pause during the sitemap walk: ${latencyMs} ms`);
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.discovery).toBeNull();
    const row = await crawlRow(id);
    expect(row.discovery).toBeNull();
    expect(row.notfoundProbe).toEqual({
      skipped: "crawl stopped (paused or cancelled) before the known-404 probe",
    });
    expect(await frontierRows(id)).toEqual([]);
    expect(await sitemapUrlSet(id)).toEqual([]);
    // The walk stopped at the child in flight: the second was never asked for.
    expect(indexSite.seen.filter((p) => p.startsWith("/sm-")).length - before).toBe(1);
  }, 30_000);
});

describe("a stop while a sitemap's rows are being flushed (Review Focus 2)", () => {
  let pausedId: string;

  it("pause during a mid-document flush: paused within the stop target, the document cut short", async () => {
    let flushes = 0;
    let setAt: number | undefined;
    const known = deferredId();
    const hooks: LoopTestHooks = {
      // The second flush of the heavy document: rows are written, the
      // document's clocks are paused, and the body is still arriving.
      onSitemapFlush: async (stop) => {
        flushes += 1;
        if (flushes !== 2) return;
        const crawlId = await known.promise;
        setAt = Date.now();
        expect(await setControlRequest(db, crawlId, "pause")).toBe(true);
        // Held inside the flush until the poll has turned the request into an
        // abort, so the abort provably lands while the rows are being written.
        await until("the stop signal", () => stop.aborted, 5_000);
      },
    };
    const run = start(config(heavySite), hooks);
    const crawlId = await newCrawlOf(`${heavySite.base}/`);
    known.resolve(crawlId);
    pausedId = crawlId;
    await until("the flush hook's request", () => setAt !== undefined);

    const latencyMs = await requestAndMeasure(crawlId, "pause", setAt);
    console.log(`pause during a flush: ${latencyMs} ms`);
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("paused");
    const row = await crawlRow(crawlId);
    expect(row.discovery).toBeNull();
    expect(await frontierRows(crawlId)).toEqual([]);
    expect(await sitemapUrlSet(crawlId)).toEqual([]);
    // Cut short mid-document: some memberships were flushed, not all.
    const staged = await membershipCount(crawlId);
    expect(staged).toBeGreaterThan(0);
    expect(staged).toBeLessThan(HEAVY_LOCS);
  }, 30_000);

  it("the resumed crawl's discovery equals an uninterrupted crawl's", async () => {
    const resumed = await resumeCrawl(db, pausedId, { config: config(heavySite) });
    expect(resumed.status).toBe("finished");

    const whole = await runCrawl(db, config(heavySite));
    createdCrawls.push(whole.crawlId);
    expect(whole.status).toBe("finished");

    // Nothing in the evidence is timing-dependent: it compares whole.
    const resumedRow = await crawlRow(pausedId);
    const wholeRow = await crawlRow(whole.crawlId);
    expect(resumedRow.discovery).not.toBeNull();
    expect(resumedRow.discovery).toEqual(wholeRow.discovery);

    const resumedUrls = await sitemapUrlSet(pausedId);
    expect(resumedUrls).toHaveLength(HEAVY_LOCS);
    expect(resumedUrls).toEqual(await sitemapUrlSet(whole.crawlId));
    expect(await membershipCount(pausedId)).toBe(await membershipCount(whole.crawlId));
  }, 120_000);
});

describe("a pause right after discovery (Review Focus 1)", () => {
  it("a request written as discovery returns: paused within the stop target, no page fetched", async () => {
    let setAt: number | undefined;
    const known = deferredId();
    const run = start(config(slowPageSite), {
      afterDiscovery: async () => {
        const crawlId = await known.promise;
        setAt = Date.now();
        expect(await setControlRequest(db, crawlId, "pause")).toBe(true);
      },
    });
    const crawlId = await newCrawlOf(`${slowPageSite.base}/`);
    known.resolve(crawlId);
    await until("the hook's request", () => setAt !== undefined);

    const latencyMs = await requestAndMeasure(crawlId, "pause", setAt);
    console.log(`pause written as discovery returns: ${latencyMs} ms`);
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(await pageRows(crawlId)).toEqual([]);
    const states = (await frontierRows(crawlId)).map((r) => r.state);
    expect(states.every((s) => s === "pending")).toBe(true);
  }, 30_000);

  it("a request the poll has already seen when discovery returns: no evidence written, nothing enqueued", async () => {
    let setAt: number | undefined;
    const known = deferredId();
    const run = start(config(slowPageSite), {
      afterDiscovery: async (stop) => {
        const crawlId = await known.promise;
        setAt = Date.now();
        expect(await setControlRequest(db, crawlId, "pause")).toBe(true);
        await until("the stop signal", () => stop.aborted, 5_000);
      },
    });
    const crawlId = await newCrawlOf(`${slowPageSite.base}/`);
    known.resolve(crawlId);
    await until("the hook's request", () => setAt !== undefined);

    const latencyMs = await requestAndMeasure(crawlId, "pause", setAt);
    console.log(`pause seen as discovery returns: ${latencyMs} ms`);
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.discovery).toBeNull();
    const row = await crawlRow(crawlId);
    expect(row.discovery).toBeNull();
    expect(await frontierRows(crawlId)).toEqual([]);
    expect(await sitemapUrlSet(crawlId)).toEqual([]);
    expect(await pageRows(crawlId)).toEqual([]);
  }, 30_000);
});

describe("discover honours the caller's signal", () => {
  const nullSink: SitemapSink = {
    membership: () => undefined,
    alternate: () => undefined,
    flush: async () => undefined,
  };

  function opts(signal: AbortSignal, overrides: Record<string, unknown> = {}) {
    return {
      userAgent: "AriadneBot-stop-early-test",
      allowPrivate: true,
      perHostDelayMs: 0,
      sink: nullSink,
      signal,
      ...overrides,
    };
  }

  it("an abort mid-document throws DiscoveryAbortedError, never a time-limited or failed document", async () => {
    const controller = new AbortController();
    const before = indexSite.seen.filter((p) => p.startsWith("/sm-")).length;
    const walk = discover(`${indexSite.base}/`, opts(controller.signal, { walkBudgetMs: 60_000 }));
    walk.catch(() => undefined);
    await until("a sitemap child in flight", () => indexSite.seen.filter((p) => p.startsWith("/sm-")).length > before);
    const at = Date.now();
    controller.abort();
    await expect(walk).rejects.toBeInstanceOf(DiscoveryAbortedError);
    expect(Date.now() - at).toBeLessThan(500);
  });

  it("an abort during the pacing sleep between documents throws at once", async () => {
    const controller = new AbortController();
    const before = indexSite.seen.filter((p) => p === "/sitemap-index.xml").length;
    const robotsBefore = indexSite.seen.filter((p) => p === "/robots.txt").length;
    // A 10 s spacing: the walk sleeps before the index, robots.txt having just
    // been read.
    const walk = discover(`${indexSite.base}/`, opts(controller.signal, { perHostDelayMs: 10_000 }));
    walk.catch(() => undefined);
    await until("robots.txt read", () => indexSite.seen.filter((p) => p === "/robots.txt").length > robotsBefore);
    await sleep(100);
    const at = Date.now();
    controller.abort();
    await expect(walk).rejects.toBeInstanceOf(DiscoveryAbortedError);
    expect(Date.now() - at).toBeLessThan(500);
    expect(indexSite.seen.filter((p) => p === "/sitemap-index.xml").length).toBe(before);
  });

  it("an already-aborted signal makes no request at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const seen = indexSite.seen.length;
    await expect(discover(`${indexSite.base}/`, opts(controller.signal))).rejects.toBeInstanceOf(
      DiscoveryAbortedError,
    );
    expect(indexSite.seen.length).toBe(seen);
  });
});

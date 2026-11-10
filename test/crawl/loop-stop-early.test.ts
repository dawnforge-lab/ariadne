/**
 * Phase 27d Task 4: a pause or cancel stops the crawl while it is still in the
 * host probe, the sitemap discovery walk, or the seeding that follows it,
 * within the spec's stop target — `CONTROL_POLL_MS` (1 s) + 1 s, from the
 * `control_request` write to the row's terminal status.
 *
 * Every fixture stall is far beyond that bound (a 5 s probe answer, 3 s
 * sitemap children, 15 s pages), so no test can pass by the fixture finishing
 * on its own. A stop that must land between two batches of work is placed
 * there by a test hook, which writes the request and then holds until the
 * run's stop signal has fired.
 *
 * Measured latencies are not printed; set STOP_LATENCY_LOG to a file path to
 * have them written there as JSON when the file finishes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type DiscoveryEvidence,
  type LoopTestHooks,
} from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages, resources, sitemapMemberships, sitemapUrls } from "../../src/db/schema.js";
import { deriveSitemapHreflang } from "../../src/rules/derive/sitemap-hreflang.js";
import { hreflangIntegrityRules } from "../../src/rules/query/hreflang-integrity.js";
import { hreflangRules } from "../../src/rules/query/hreflang.js";
import type { Finding } from "../../src/rules/registry/types.js";

/** The spec's stop target: one poll interval, plus one second for the close. */
const STOP_TARGET_MS = CONTROL_POLL_MS + 1_000;

/** Every stop latency this file measured, by test, for STOP_LATENCY_LOG. */
const latencies: Record<string, number> = {};

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

function robots(res: ServerResponse, sitemaps: string[]): void {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`User-agent: *\nAllow: /\n${sitemaps.map((s) => `Sitemap: ${s}\n`).join("")}`);
}

interface Site {
  base: string;
  /** Every request path the site has seen, in order. */
  seen: string[];
}

async function site(handler: (req: IncomingMessage, res: ServerResponse, base: string) => void): Promise<Site> {
  const s: Site = { base: "", seen: [] };
  const server = createServer((req, res) => {
    s.seen.push(path(req));
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

/** How many times `s` has been asked for a path `match` accepts. */
function hits(s: Site, match: (p: string) => boolean): number {
  return s.seen.filter(match).length;
}

const isChild = (p: string): boolean => p.startsWith("/sm-");

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
 * every page answers at once. Also the seeding fixture: HEAVY_LOCS entries
 * are many batches of `sitemap_urls` rows and many frontier lookup chunks.
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

/**
 * THE HREFLANG SITE. Two sitemaps. The first says `/a` has a French alternate
 * `/b`, and `/b` does not name `/a` back — `hreflang.missing-return-link` on a
 * whole read. The second answers at once, or after 3 s while `hreflangSlow` is
 * set, which is how a RESUMED crawl is stopped in the middle of its re-walk.
 */
let hreflangSite: Site;
let hreflangSlow = false;

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  probeSite = await site((req, res) => {
    if (path(req) === "/robots.txt") return robots(res, []);
    answerLater(res, 5_000, () => html(res, "late home"));
  });

  indexSite = await site((req, res, base) => {
    const p = path(req);
    if (p === "/robots.txt") return robots(res, [`${base}/sitemap-index.xml`]);
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
    if (p === "/robots.txt") return robots(res, [`${base}/heavy.xml`]);
    if (p === "/heavy.xml") return xml(res, heavyXml);
    html(res, `page ${p}`, p === "/" ? ["/p/1", "/p/2"] : []);
  });
  const heavyLocs: string[] = [];
  for (let n = 1; n <= HEAVY_LOCS; n += 1) heavyLocs.push(`${heavySite.base}/p/${n}`);
  heavyXml = urlset(heavyLocs);

  slowPageSite = await site((req, res, base) => {
    const p = path(req);
    if (p === "/robots.txt") return robots(res, [`${base}/sitemap.xml`]);
    if (p === "/sitemap.xml") return xml(res, urlset([`${base}/a`, `${base}/b`]));
    answerLater(res, 15_000, () => html(res, `late ${p}`));
  });

  hreflangSite = await site((req, res, base) => {
    const p = path(req);
    if (p === "/robots.txt") return robots(res, [`${base}/sitemap.xml`, `${base}/sitemap-2.xml`]);
    if (p === "/sitemap.xml") {
      xml(
        res,
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
          `xmlns:xhtml="http://www.w3.org/1999/xhtml">` +
          `<url><loc>${base}/a</loc>` +
          `<xhtml:link rel="alternate" hreflang="en" href="${base}/a"/>` +
          `<xhtml:link rel="alternate" hreflang="fr" href="${base}/b"/></url>` +
          `<url><loc>${base}/b</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    if (p === "/sitemap-2.xml") {
      const answer = (): void => xml(res, urlset([`${base}/c`]));
      if (hreflangSlow) answerLater(res, 3_000, answer);
      else answer();
      return;
    }
    html(res, `page ${p}`, p === "/" ? ["/a", "/b", "/c"] : []);
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
  const logTo = process.env["STOP_LATENCY_LOG"];
  if (logTo !== undefined && logTo !== "") writeFileSync(logTo, JSON.stringify(latencies));
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

async function frontierUrlSet(id: string): Promise<string[]> {
  return (await frontierRows(id)).map((r) => r.url).sort();
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

/** The row's discovery evidence, which the test expects to be on record. */
async function evidenceOf(id: string): Promise<DiscoveryEvidence> {
  const discovery = (await crawlRow(id)).discovery as DiscoveryEvidence | null;
  if (discovery === null) throw new Error(`crawl ${id} holds no discovery evidence`);
  return discovery;
}

/**
 * Wait for the row to reach the terminal status `request` leads to, and record
 * the time from `setAt` (the `control_request` write) — the spec's measure of a
 * stop. Without `setAt`, the request is written here first.
 */
async function measureStop(
  name: string,
  id: string,
  request: "pause" | "cancel",
  setAt?: number,
): Promise<number> {
  const terminal = request === "pause" ? "paused" : "cancelled";
  let at = setAt;
  if (at === undefined) {
    at = Date.now();
    expect(await setControlRequest(db, id, request)).toBe(true);
  }
  await until(`the row to read ${terminal}`, async () => (await crawlRow(id)).status === terminal, 20_000);
  const latencyMs = Date.now() - at;
  latencies[name] = latencyMs;
  return latencyMs;
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

/**
 * A hook body that writes `request` for the crawl, records when, and holds
 * until the run's stop signal has fired — so the stop provably lands at the
 * point the hook was called from.
 */
function stopHere(
  known: { promise: Promise<string> },
  request: "pause" | "cancel",
  stamp: (at: number) => void,
): (stop: AbortSignal) => Promise<void> {
  return async (stop) => {
    const crawlId = await known.promise;
    stamp(Date.now());
    expect(await setControlRequest(db, crawlId, request)).toBe(true);
    await until("the stop signal", () => stop.aborted, 5_000);
  };
}

/**
 * Hooks that pause a run at its first page slot, written without waiting: the
 * seeding is over by then, so the frontier holds every URL the run seeded, and
 * the pause ends the run within a poll interval rather than after HEAVY_LOCS
 * pages.
 */
function pauseAtFirstSlot(known: { promise: Promise<string> }): LoopTestHooks {
  let asked = false;
  return {
    onGrant: () => {
      if (asked) return;
      asked = true;
      void known.promise.then((crawlId) => setControlRequest(db, crawlId, "pause"));
    },
  };
}

/** The frontier an uninterrupted seeding of `s` leaves (paused at its first slot). */
async function uninterruptedSeeding(s: Site, cfg: CrawlConfig): Promise<{ id: string; urls: string[] }> {
  const known = deferredId();
  const run = start(cfg, pauseAtFirstSlot(known));
  const id = await newCrawlOf(`${s.base}/`);
  known.resolve(id);
  expect((await run).status).toBe("paused");
  return { id, urls: await frontierUrlSet(id) };
}

describe("a stop during the host probe", () => {
  it("pause: paused within the stop target, no discovery evidence and no frontier rows", async () => {
    const before = hits(probeSite, (p) => p === "/");
    const run = start(config(probeSite, { probeHosts: true }));
    const id = await newCrawlOf(`${probeSite.base}/`);
    await until("the probe's first hop in flight", () => hits(probeSite, (p) => p === "/") > before);

    expect(await measureStop("pause during probe", id, "pause")).toBeLessThanOrEqual(STOP_TARGET_MS);

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
    const before = hits(probeSite, (p) => p === "/");
    const run = start(config(probeSite, { probeHosts: true }));
    const id = await newCrawlOf(`${probeSite.base}/`);
    await until("the probe's first hop in flight", () => hits(probeSite, (p) => p === "/") > before);

    expect(await measureStop("cancel during probe", id, "cancel")).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("cancelled");
    expect(summary.note).toBe("cancelled; 0 URL(s) were never fetched");

    const row = await crawlRow(id);
    expect(row.cancelledAt).not.toBeNull();
    expect(row.discovery).toBeNull();
    expect(await frontierRows(id)).toEqual([]);
    await expectNeverRan(id);
  }, 30_000);
});

/**
 * The 27b never-ran wording on the status read (Ruling 11): no count of URLs
 * never fetched, because nothing was seen, and the rules refuse a crawl that
 * never ran.
 */
async function expectNeverRan(id: string): Promise<void> {
  const service = new ApiService(db, { allowedDomains: ["127.0.0.1"], log: () => {} });
  const detail = await service.getCrawl(id);
  expect(detail.status).toBe("cancelled");
  expect(detail.neverFetched).toBeNull();
  await expect(service.runRulesForCrawl(id)).rejects.toThrow(/never ran \(it was cancelled before discovery\)/);
}

describe("a stop during the sitemap walk", () => {
  it("pause: paused within the stop target, no sitemap entries enqueued, no discovery evidence", async () => {
    const before = hits(indexSite, isChild);
    const run = start(config(indexSite));
    const id = await newCrawlOf(`${indexSite.base}/`);
    await until("a sitemap child in flight", () => hits(indexSite, isChild) > before);

    expect(await measureStop("pause during walk", id, "pause")).toBeLessThanOrEqual(STOP_TARGET_MS);

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
    expect(hits(indexSite, isChild) - before).toBe(1);
  }, 30_000);

  it("cancel: cancelled within the stop target, and the status read says it never ran", async () => {
    const before = hits(indexSite, isChild);
    const run = start(config(indexSite));
    const id = await newCrawlOf(`${indexSite.base}/`);
    await until("a sitemap child in flight", () => hits(indexSite, isChild) > before);

    expect(await measureStop("cancel during walk", id, "cancel")).toBeLessThanOrEqual(STOP_TARGET_MS);

    const summary = await run;
    expect(summary.status).toBe("cancelled");
    const row = await crawlRow(id);
    expect(row.cancelledAt).not.toBeNull();
    expect(row.discovery).toBeNull();
    expect(await frontierRows(id)).toEqual([]);
    expect(await sitemapUrlSet(id)).toEqual([]);
    await expectNeverRan(id);
  }, 30_000);

  it("a control poll that fails mid-walk closes the crawl failed on the poll failure alone, never paused", async () => {
    const before = hits(indexSite, isChild);
    const run = start(config(indexSite));
    const id = await newCrawlOf(`${indexSite.base}/`);
    await until("a sitemap child in flight", () => hits(indexSite, isChild) > before);
    // A value this engine never writes: the watcher's next poll fails on it.
    await db.update(crawls).set({ controlRequest: "stop" }).where(eq(crawls.id, id));

    const error = await run.then(
      () => {
        throw new Error("the run resolved");
      },
      (e: unknown) => e,
    );
    expect(String((error as Error).message)).toMatch(/"stop"/);
    const row = await crawlRow(id);
    expect(row.status).toBe("failed");
    expect(row.pauseReason).toBeNull();
    expect(row.failureReason).toMatch(/"stop"/);
    expect(row.discovery).toBeNull();
    // Failed, so the stopped close's 404 sentence was never written.
    expect(row.notfoundProbe).toBeNull();
    expect(await frontierRows(id)).toEqual([]);
    // The walk stopped at the child in flight, as a pause would have.
    expect(hits(indexSite, isChild) - before).toBe(1);
  }, 30_000);
});

describe("a stop while a sitemap's rows are being flushed (Review Focus 2)", () => {
  it("pause during a mid-document flush closes within the stop target, and the resumed walk equals an uninterrupted one", async () => {
    let flushes = 0;
    let setAt: number | undefined;
    const known = deferredId();
    const hold = stopHere(known, "pause", (at) => (setAt = at));
    const run = start(config(heavySite), {
      // The second flush of the heavy document: rows are written, the
      // document's clocks are paused, and the body is still arriving.
      onSitemapFlush: async (stop) => {
        flushes += 1;
        if (flushes === 2) await hold(stop);
      },
    });
    const pausedId = await newCrawlOf(`${heavySite.base}/`);
    known.resolve(pausedId);
    await until("the flush hook's request", () => setAt !== undefined);

    expect(await measureStop("pause during a flush", pausedId, "pause", setAt)).toBeLessThanOrEqual(
      STOP_TARGET_MS,
    );

    expect((await run).status).toBe("paused");
    expect((await crawlRow(pausedId)).discovery).toBeNull();
    expect(await frontierRows(pausedId)).toEqual([]);
    expect(await sitemapUrlSet(pausedId)).toEqual([]);
    // Cut short mid-document: some memberships were flushed, not all.
    const staged = await membershipCount(pausedId);
    expect(staged).toBeGreaterThan(0);
    expect(staged).toBeLessThan(HEAVY_LOCS);

    // Resume to the end, then compare with a crawl that was never interrupted.
    const resumed = await resumeCrawl(db, pausedId, { config: config(heavySite) });
    expect(resumed.status).toBe("finished");
    const whole = await runCrawl(db, config(heavySite));
    createdCrawls.push(whole.crawlId);
    expect(whole.status).toBe("finished");

    // Nothing in the evidence is timing-dependent: it compares whole.
    const resumedEvidence = await evidenceOf(pausedId);
    expect(resumedEvidence).toEqual(await evidenceOf(whole.crawlId));
    const resumedUrls = await sitemapUrlSet(pausedId);
    expect(resumedUrls).toHaveLength(HEAVY_LOCS);
    expect(resumedUrls).toEqual(await sitemapUrlSet(whole.crawlId));
    expect(await membershipCount(pausedId)).toBe(await membershipCount(whole.crawlId));
  }, 120_000);
});

describe("a stop during the seeding after discovery (ruling R9)", () => {
  // Room for every entry and the seed, so the frontier lookup runs every chunk.
  const seedingConfig = (): CrawlConfig =>
    config(heavySite, { maxPages: HEAVY_LOCS + 1, maxConcurrency: 4 });

  async function stopInStage(
    name: string,
    stage: "sitemap_urls" | "frontier",
  ): Promise<{ id: string; latencyMs: number }> {
    let batches = 0;
    let setAt: number | undefined;
    const known = deferredId();
    const hold = stopHere(known, "pause", (at) => (setAt = at));
    const run = start(seedingConfig(), {
      onSeedingBatch: async (at, stop) => {
        if (at !== stage) return;
        batches += 1;
        if (batches === 3) await hold(stop);
      },
    });
    const id = await newCrawlOf(`${heavySite.base}/`);
    known.resolve(id);
    await until("the seeding hook's request", () => setAt !== undefined);
    const latencyMs = await measureStop(name, id, "pause", setAt);
    expect((await run).status).toBe("paused");
    return { id, latencyMs };
  }

  async function resumeSeeding(id: string): Promise<string[]> {
    const known = deferredId();
    known.resolve(id);
    const resumed = await resumeCrawl(db, id, { config: seedingConfig(), testHooks: pauseAtFirstSlot(known) });
    expect(resumed.status).toBe("paused");
    return frontierUrlSet(id);
  }

  it("pause while sitemap_urls is written: closes within the stop target, before any evidence; the resume seeds what an uninterrupted crawl does", async () => {
    const { id, latencyMs } = await stopInStage("pause while writing sitemap_urls", "sitemap_urls");
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    // Stopped between two batches: some rows, not all, and no evidence beside
    // them claiming the whole sitemap.
    const written = (await sitemapUrlSet(id)).length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(HEAVY_LOCS);
    expect((await crawlRow(id)).discovery).toBeNull();
    expect(await frontierRows(id)).toEqual([]);
    expect(await pageRows(id)).toEqual([]);

    const resumedUrls = await resumeSeeding(id);
    const whole = await uninterruptedSeeding(heavySite, seedingConfig());
    expect(resumedUrls).toHaveLength(HEAVY_LOCS + 1);
    expect(resumedUrls).toEqual(whole.urls);
    expect(await sitemapUrlSet(id)).toEqual(await sitemapUrlSet(whole.id));
    expect(await evidenceOf(id)).toEqual(await evidenceOf(whole.id));
  }, 120_000);

  it("pause while the frontier is seeded: closes within the stop target with the frontier partial; the resume seeds what an uninterrupted crawl does", async () => {
    const { id, latencyMs } = await stopInStage("pause while seeding the frontier", "frontier");
    expect(latencyMs).toBeLessThanOrEqual(STOP_TARGET_MS);

    // The evidence and `sitemap_urls` were whole before the seeding began; the
    // frontier holds only the chunks looked up before the stop, and no page
    // was leased.
    expect((await evidenceOf(id)).docsFetched).toBe(1);
    expect(await sitemapUrlSet(id)).toHaveLength(HEAVY_LOCS);
    const seeded = (await frontierRows(id)).length;
    expect(seeded).toBeGreaterThan(0);
    expect(seeded).toBeLessThan(HEAVY_LOCS + 1);
    expect(await pageRows(id)).toEqual([]);

    const resumedUrls = await resumeSeeding(id);
    const whole = await uninterruptedSeeding(heavySite, seedingConfig());
    expect(resumedUrls).toHaveLength(HEAVY_LOCS + 1);
    expect(resumedUrls).toEqual(whole.urls);
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

    expect(await measureStop("pause written as discovery returns", crawlId, "pause", setAt)).toBeLessThanOrEqual(
      STOP_TARGET_MS,
    );

    expect((await run).status).toBe("paused");
    // The stop was the page loop's to see: the frontier was seeded (so this is
    // not the post-discovery check's close), and its page fetch was cut off.
    const rows = await frontierRows(crawlId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
    expect(await pageRows(crawlId)).toEqual([]);
  }, 30_000);

  it("a request the poll has already seen when discovery returns: no evidence written, nothing enqueued", async () => {
    let setAt: number | undefined;
    const known = deferredId();
    const run = start(config(slowPageSite), {
      afterDiscovery: stopHere(known, "pause", (at) => (setAt = at)),
    });
    const crawlId = await newCrawlOf(`${slowPageSite.base}/`);
    known.resolve(crawlId);
    await until("the hook's request", () => setAt !== undefined);

    expect(await measureStop("pause seen as discovery returns", crawlId, "pause", setAt)).toBeLessThanOrEqual(
      STOP_TARGET_MS,
    );

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.discovery).toBeNull();
    expect((await crawlRow(crawlId)).discovery).toBeNull();
    expect(await frontierRows(crawlId)).toEqual([]);
    expect(await sitemapUrlSet(crawlId)).toEqual([]);
    expect(await pageRows(crawlId)).toEqual([]);
  }, 30_000);
});

describe("a resumed crawl stopped during its re-walk (ruling R8)", () => {
  const MARKER = "hreflang.declarations-incomplete";
  const RETURN_LINK = "hreflang.missing-return-link";
  const ABSENCE_RULES = [
    RETURN_LINK,
    "hreflang.missing-self-reference",
    "hreflang.missing-x-default",
    "hreflang.self-only",
  ];
  const byId = new Map([...hreflangRules, ...hreflangIntegrityRules].map((r) => [r.id, r]));

  /** The four absence rules and the marker over the crawl as it stands. */
  async function judge(crawlId: string): Promise<Record<string, Finding[]>> {
    await deriveSitemapHreflang(db, crawlId);
    const out: Record<string, Finding[]> = {};
    for (const id of [...ABSENCE_RULES, MARKER]) {
      const r = byId.get(id);
      if (r === undefined) throw new Error(`no rule '${id}'`);
      out[id] = await r.run(db, crawlId);
    }
    return out;
  }

  it("marks the kept evidence interrupted: the absence rules refuse, the marker names it, and a complete walk clears it", async () => {
    const cfg = config(hreflangSite, { maxPages: 10 });
    hreflangSlow = false;
    const first = await runCrawl(db, cfg);
    createdCrawls.push(first.crawlId);
    expect(first.status).toBe("finished");
    const id = first.crawlId;
    // The baseline: read whole, /a's French alternate is not named back.
    const whole = await judge(id);
    expect(whole[RETURN_LINK]!.length).toBeGreaterThan(0);
    expect(whole[MARKER]).toEqual([]);
    expect((await evidenceOf(id)).truncation.interrupted).toBeUndefined();

    // The re-walk: the first sitemap is read again, the second is in flight.
    hreflangSlow = true;
    const before = hits(hreflangSite, (p) => p === "/sitemap-2.xml");
    const resumed = resumeCrawl(db, id, { config: cfg });
    resumed.catch(() => undefined);
    await until("the second sitemap in flight", () => hits(hreflangSite, (p) => p === "/sitemap-2.xml") > before);
    expect(await measureStop("pause during a re-walk", id, "pause")).toBeLessThanOrEqual(STOP_TARGET_MS);
    expect((await resumed).status).toBe("paused");

    expect((await evidenceOf(id)).truncation.interrupted).toBe(true);
    const cut = await judge(id);
    for (const ruleId of ABSENCE_RULES) expect(cut[ruleId], ruleId).toEqual([]);
    expect(cut[MARKER]).toHaveLength(1);
    const marker = cut[MARKER]![0]!;
    expect(marker.evidence.interrupted).toBe(true);
    expect(String(marker.evidence.reason)).toMatch(/\(interrupted\)/);

    // Resumed to the end: the complete walk rewrites the evidence, and the
    // rules judge again.
    hreflangSlow = false;
    const finished = await resumeCrawl(db, id, { config: cfg });
    expect(finished.status).toBe("finished");
    expect((await evidenceOf(id)).truncation.interrupted).toBeUndefined();
    const again = await judge(id);
    expect(again[RETURN_LINK]!.length).toBe(whole[RETURN_LINK]!.length);
    expect(again[MARKER]).toEqual([]);
  }, 60_000);

  /** A finished crawl of the hreflang site, whose evidence a resume will keep. */
  async function finishedHreflangCrawl(cfg: CrawlConfig): Promise<string> {
    hreflangSlow = false;
    const first = await runCrawl(db, cfg);
    createdCrawls.push(first.crawlId);
    expect(first.status).toBe("finished");
    expect((await evidenceOf(first.crawlId)).truncation.interrupted).toBeUndefined();
    return first.crawlId;
  }

  /** The rejection `run` settles with; a resolution is the test failing. */
  async function rejectionOf(run: Promise<unknown>): Promise<Error> {
    return run.then(
      () => {
        throw new Error("the run resolved");
      },
      (e: unknown) => e as Error,
    );
  }

  it("(R10) a control poll that fails mid re-walk: the row closes failed, and the kept evidence is marked interrupted", async () => {
    const cfg = config(hreflangSite, { maxPages: 10 });
    const id = await finishedHreflangCrawl(cfg);

    hreflangSlow = true;
    const before = hits(hreflangSite, (p) => p === "/sitemap-2.xml");
    const resumed = resumeCrawl(db, id, { config: cfg });
    resumed.catch(() => undefined);
    await until("the second sitemap in flight", () => hits(hreflangSite, (p) => p === "/sitemap-2.xml") > before);
    // A value this engine never writes: the watcher's next poll fails on it.
    await db.update(crawls).set({ controlRequest: "stop" }).where(eq(crawls.id, id));

    const error = await rejectionOf(resumed);
    expect(error.message).toMatch(/"stop"/);
    const row = await crawlRow(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toMatch(/"stop"/);
    expect((await evidenceOf(id)).truncation.interrupted).toBe(true);
    // Failed and still judgeable: the absence rules refuse on the mark.
    const cut = await judge(id);
    for (const ruleId of ABSENCE_RULES) expect(cut[ruleId], ruleId).toEqual([]);
    expect(cut[MARKER]![0]!.evidence.interrupted).toBe(true);
    hreflangSlow = false;
  }, 60_000);

  it("(R10) a non-abort error out of the re-walk: the original error is the failure, and the kept evidence is marked interrupted", async () => {
    const cfg = config(hreflangSite, { maxPages: 10 });
    const id = await finishedHreflangCrawl(cfg);

    // The sink's flush fails on the re-walk's first document: discovery's own
    // failure (a `ReaderFault`), thrown out of `discover` as itself.
    const resumed = resumeCrawl(db, id, {
      config: cfg,
      testHooks: {
        onSitemapFlush: async () => {
          throw new Error("injected sitemap sink failure");
        },
      },
    });
    resumed.catch(() => undefined);

    const error = await rejectionOf(resumed);
    expect(error.message).toBe("injected sitemap sink failure");
    const row = await crawlRow(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("injected sitemap sink failure");
    expect((await evidenceOf(id)).truncation.interrupted).toBe(true);
  }, 60_000);
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
    const before = hits(indexSite, isChild);
    const walk = discover(`${indexSite.base}/`, opts(controller.signal, { walkBudgetMs: 60_000 }));
    walk.catch(() => undefined);
    await until("a sitemap child in flight", () => hits(indexSite, isChild) > before);
    const at = Date.now();
    controller.abort();
    await expect(walk).rejects.toBeInstanceOf(DiscoveryAbortedError);
    expect(Date.now() - at).toBeLessThan(500);
  });

  it("an abort during the pacing sleep between documents throws at once", async () => {
    const controller = new AbortController();
    const before = hits(indexSite, (p) => p === "/sitemap-index.xml");
    const robotsBefore = hits(indexSite, (p) => p === "/robots.txt");
    // A 10 s spacing: the walk sleeps before the index, robots.txt having just
    // been read.
    const walk = discover(`${indexSite.base}/`, opts(controller.signal, { perHostDelayMs: 10_000 }));
    walk.catch(() => undefined);
    await until("robots.txt read", () => hits(indexSite, (p) => p === "/robots.txt") > robotsBefore);
    await sleep(100);
    const at = Date.now();
    controller.abort();
    await expect(walk).rejects.toBeInstanceOf(DiscoveryAbortedError);
    expect(Date.now() - at).toBeLessThan(500);
    expect(hits(indexSite, (p) => p === "/sitemap-index.xml")).toBe(before);
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

/**
 * Phase 27d Task 5 (27b Ruling 4): a stop during the recheck pass or the
 * resource pass aborts the request in flight. Its row stays unwritten, and a
 * resume asks again. The 15 s stall is far beyond the stop target, so no test
 * can pass by the fixture answering on its own.
 */
describe("a stop during the recheck and resource passes", () => {
  let recheckSite: Site;
  let resourceSite: Site;
  /** While set, the page's second request / the asset's requests hang 15 s. */
  let recheckHang = true;
  let assetHang = true;

  beforeAll(async () => {
    recheckSite = await site((req, res) => {
      const p = path(req);
      if (p === "/robots.txt") return robots(res, []);
      if (p === "/bad") {
        const nth = hits(recheckSite, (q) => q === "/bad");
        if (nth === 1) {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("first look: down");
          return;
        }
        if (recheckHang) return answerLater(res, 15_000, () => html(res, "late bad"));
        return html(res, "recovered");
      }
      html(res, `page ${p}`, p === "/" ? ["/bad"] : []);
    });

    resourceSite = await site((req, res) => {
      const p = path(req);
      if (p === "/robots.txt") return robots(res, []);
      if (p === "/slow.png") {
        if (assetHang) return answerLater(res, 15_000, () => xml(res, "late"));
        res.writeHead(200, { "content-type": "image/png", "content-length": "3" });
        res.end("png");
        return;
      }
      if (p === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><title>home</title></head><body>` +
            `<img src="/slow.png" alt="x"></body></html>`,
        );
        return;
      }
      html(res, `page ${p}`);
    });
  });

  async function badRow(id: string) {
    const rows = await db.select().from(pages).where(eq(pages.crawlId, id));
    const row = rows.find((r) => r.url.endsWith("/bad"));
    if (row === undefined) throw new Error("the /bad page has no row");
    return row;
  }

  it("recheck: a pause aborts the request in flight, leaves the recheck columns null, and a resume rechecks", async () => {
    recheckHang = true;
    const cfg = config(recheckSite, { recheckMinGapMs: 50 });
    const before = hits(recheckSite, (p) => p === "/bad");
    const run = start(cfg);
    const id = await newCrawlOf(`${recheckSite.base}/`);
    // The first look is the 503; the second, the recheck, is the one that hangs.
    await until("the recheck in flight", () => hits(recheckSite, (p) => p === "/bad") >= before + 2);

    expect(await measureStop("pause during recheck", id, "pause")).toBeLessThanOrEqual(STOP_TARGET_MS);
    expect((await run).status).toBe("paused");

    const cut = await badRow(id);
    expect(cut.fetchClass).toBe("server_error");
    expect(cut.recheckFetchClass).toBeNull();
    expect(cut.recheckStatusCode).toBeNull();
    expect(cut.recheckAt).toBeNull();

    recheckHang = false;
    const resumed = await resumeCrawl(db, id, { config: cfg });
    expect(resumed.status).toBe("finished");
    const done = await badRow(id);
    expect(done.recheckFetchClass).toBe("ok");
    expect(done.recheckStatusCode).toBe(200);
  }, 60_000);

  it("resources: a pause aborts the request in flight, writes no row for it, and a resume fetches it", async () => {
    assetHang = true;
    const cfg = config(resourceSite, { fetchResources: true });
    const before = hits(resourceSite, (p) => p === "/slow.png");
    const run = start(cfg);
    const id = await newCrawlOf(`${resourceSite.base}/`);
    await until("the asset in flight", () => hits(resourceSite, (p) => p === "/slow.png") > before);

    expect(await measureStop("pause during resources", id, "pause")).toBeLessThanOrEqual(STOP_TARGET_MS);
    expect((await run).status).toBe("paused");

    const unasked = await db.select().from(resources).where(eq(resources.crawlId, id));
    expect(unasked).toHaveLength(1);
    expect(unasked[0]!.fetchClass).toBeNull();
    expect(unasked[0]!.statusCode).toBeNull();

    assetHang = false;
    const resumed = await resumeCrawl(db, id, { config: cfg });
    expect(resumed.status).toBe("finished");
    const fetched = await db.select().from(resources).where(eq(resources.crawlId, id));
    expect(fetched[0]!.fetchClass).toBe("ok");
    expect(fetched[0]!.statusCode).toBe(200);
  }, 60_000);
});

/**
 * THE RENDER PASS, MEASURED, NOT CHANGED (27d Task 5). A pause cannot reach a
 * render pass: it moves only `queued` and `running` crawls, and a render pass
 * refuses those, so the crawl it works on is `finished` (or `failed`) and
 * `crawl_pause` answers 409; so does `crawl_cancel`, for the same status, and
 * `refuseWhileBusy` (27b: "neither can be interrupted") covers a paused one. No
 * stop latency to measure and no render fix: the 27b refusal stands, and
 * this test pins both refusals while a page is in the browser.
 */
describe("a stop during the render pass", () => {
  let renderSite: Site;
  let renderHang = false;
  let renderDir: string;

  beforeAll(async () => {
    renderDir = mkdtempSync(join(tmpdir(), "ariadne-render-stop-"));
    renderSite = await site((req, res) => {
      const p = path(req);
      if (p === "/robots.txt") return robots(res, []);
      if (renderHang) return answerLater(res, 4_000, () => html(res, "late home"));
      html(res, `page ${p}`);
    });
  });

  afterAll(() => {
    rmSync(renderDir, { recursive: true, force: true });
  });

  it("crawl_pause and crawl_cancel are refused while a page renders, so there is no render stop to time", async () => {
    renderHang = false;
    const first = await runCrawl(db, config(renderSite, { maxPages: 1 }));
    createdCrawls.push(first.crawlId);
    expect(first.status).toBe("finished");

    const service = new ApiService(db, {
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      renderDir,
      log: () => {},
    });
    renderHang = true;
    const before = hits(renderSite, (p) => p === "/");
    const rendering = service.renderCrawl(first.crawlId);
    rendering.catch(() => undefined);
    await until("the page in the browser", () => hits(renderSite, (p) => p === "/") > before, 30_000);

    await expect(service.pauseCrawl(first.crawlId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.cancelCrawl(first.crawlId)).rejects.toThrow(/is .finished.: only a queued, running or paused crawl can be cancelled/);
    renderHang = false;
    await rendering;
  }, 90_000);
});

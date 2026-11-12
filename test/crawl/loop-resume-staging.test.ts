/**
 * Phase 28a Task 4 (27d ruling R17, carried): a resumed crawl's sitemap re-walk
 * clears the staging an earlier walk left — `sitemap_memberships` and
 * `sitemap_hreflang` — only when a walk replaces it.
 *
 *  - A re-walk that reads the site again replaces both tables, so a URL the
 *    site has since dropped from its sitemap is no longer a member.
 *  - A resume that finds robots.txt unreachable walks nothing (complete
 *    disallow, `discover`), so the earlier walk's staging and its evidence stay
 *    as they were; only the evidence's `robots` key is the new outcome.
 *
 * Every test owns one fixture site whose sitemap and robots.txt it can change
 * between runs. The stop tests of the re-walk (the interrupted mark, rulings
 * R8/R10) live in loop-stop-early.test.ts and are unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { setControlRequest } from "../../src/crawl/control.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import {
  resumeCrawl,
  runCrawl,
  type CrawlConfig,
  type CrawlSummary,
  type DiscoveryEvidence,
  type LoopTestHooks,
  markEvidenceInterrupted,
} from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, sitemapHreflang, sitemapMemberships, sitemapUrls } from "../../src/db/schema.js";
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

/**
 * A fixture site whose sitemap and robots.txt a test changes between runs.
 *
 * robots.txt declares one sitemap, `/sitemap.xml`, which lists `listed` (paths)
 * — `/a` with alternates `en` → `/a` and `fr` → `/b` whenever it is listed, so
 * the walk stages hreflang rows. While `robotsDown` is set, robots.txt answers
 * 503 to every request: unreachable, a complete disallow. While `sitemapDown`
 * is set, `/sitemap.xml` answers 500: the walk completes having read no
 * document, so it never flushes the sink. Pages answer after `pageDelayMs`
 * (0: at once), so a pause written at the first page slot finds that page in
 * flight rather than the crawl already finished.
 */
interface MutableSite {
  base: string;
  listed: string[];
  robotsDown: boolean;
  sitemapDown: boolean;
  pageDelayMs: number;
}

function path(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

function sitemapXml(s: MutableSite): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
    `xmlns:xhtml="http://www.w3.org/1999/xhtml">` +
    s.listed
      .map((p) => {
        const alternates =
          p === "/a"
            ? `<xhtml:link rel="alternate" hreflang="en" href="${s.base}/a"/>` +
              `<xhtml:link rel="alternate" hreflang="fr" href="${s.base}/b"/>`
            : "";
        return `<url><loc>${s.base}${p}</loc>${alternates}</url>`;
      })
      .join("") +
    `</urlset>`
  );
}

async function mutableSite(listed: string[]): Promise<MutableSite> {
  const s: MutableSite = { base: "", listed, robotsDown: false, sitemapDown: false, pageDelayMs: 0 };
  const server = createServer((req, res: ServerResponse) => {
    const p = path(req);
    if (p === "/robots.txt") {
      if (s.robotsDown) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("down");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${s.base}/sitemap.xml\n`);
      return;
    }
    if (p === "/sitemap.xml") {
      if (s.sitemapDown) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("down");
        return;
      }
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(sitemapXml(s));
      return;
    }
    const answer = (): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>page ${p}</title></head><body>page ${p}</body></html>`);
    };
    if (s.pageDelayMs === 0) return answer();
    const timer = setTimeout(answer, s.pageDelayMs);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return s;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

function config(s: MutableSite, overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: `${s.base}/`,
    maxPages: 10,
    maxDepth: 3,
    userAgent: "AriadneBot-resume-staging-test",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    probeHosts: false,
    allowPrivate: true,
    fetchResources: false,
    ...overrides,
  };
}

/** The one crawl of `s` (every test owns its site, so there is never a second). */
async function crawlIdOf(s: MutableSite): Promise<string> {
  const rows = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.siteUrl, `${s.base}/`));
  if (rows.length !== 1) throw new Error(`expected one crawl of ${s.base}/, found ${rows.length}`);
  return rows[0]!.id;
}

async function crawlRow(id: string) {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row;
}

/** The row's discovery evidence, which the test expects to be on record. */
async function evidenceOf(id: string): Promise<DiscoveryEvidence> {
  const discovery = (await crawlRow(id)).discovery as DiscoveryEvidence | null;
  if (discovery === null) throw new Error(`crawl ${id} holds no discovery evidence`);
  return discovery;
}

/** The paths `sitemap_memberships` holds for the crawl, sorted. */
async function memberPaths(s: MutableSite, id: string): Promise<string[]> {
  const rows = await db
    .select({ url: sitemapMemberships.url })
    .from(sitemapMemberships)
    .where(eq(sitemapMemberships.crawlId, id));
  return rows.map((r) => r.url.slice(s.base.length)).sort();
}

async function stagingCounts(id: string): Promise<{ memberships: number; hreflang: number }> {
  const memberships = await db.$count(sitemapMemberships, eq(sitemapMemberships.crawlId, id));
  const hreflang = await db.$count(sitemapHreflang, eq(sitemapHreflang.crawlId, id));
  return { memberships, hreflang };
}

/**
 * Hooks that pause the run at its first page slot: its walk is over and its
 * evidence written, so the paused row stands for "a crawl paused after its
 * walk". The request is written without waiting; the page loop sees it.
 */
function pauseAtFirstSlot(s: MutableSite): LoopTestHooks {
  let asked = false;
  return {
    onGrant: () => {
      if (asked) return;
      asked = true;
      void crawlIdOf(s).then((id) => setControlRequest(db, id, "pause"));
    },
  };
}

/** A finished crawl of `s`, registered for teardown. */
async function finishedCrawl(s: MutableSite): Promise<string> {
  const first = await runCrawl(db, LOCAL_TENANT, config(s));
  createdCrawls.push(first.crawlId);
  expect(first.status).toBe("finished");
  return first.crawlId;
}

describe("a resumed walk replaces the staging (R17)", () => {
  it("(a) a URL the site has since dropped from its sitemap is no longer a member after the resumed walk", async () => {
    const s = await mutableSite(["/a", "/b"]);
    s.pageDelayMs = 15_000;
    const first: CrawlSummary = await runCrawl(db, LOCAL_TENANT, config(s), undefined, pauseAtFirstSlot(s));
    createdCrawls.push(first.crawlId);
    expect(first.status).toBe("paused");
    const id = first.crawlId;
    expect(await memberPaths(s, id)).toEqual(["/a", "/b"]);

    s.listed = ["/a"];
    s.pageDelayMs = 0;
    const resumed = await resumeCrawl(db, id, { config: config(s) });
    expect(resumed.status).toBe("finished");

    expect(await memberPaths(s, id)).toEqual(["/a"]);
    // The walk's evidence counts what is staged, and the staging is the walk's.
    const evidence = await evidenceOf(id);
    expect(evidence.sitemapFacts?.memberships).toBe(1);
    expect(evidence.truncation.interrupted).toBeUndefined();
    expect((await stagingCounts(id)).hreflang).toBe(evidence.sitemapFacts?.hreflangRows);
  }, 60_000);

  it("(e) a resumed walk that completes without staging a row (its sitemap answers 500) replaces the staging with nothing", async () => {
    const s = await mutableSite(["/a", "/b"]);
    const id = await finishedCrawl(s);
    expect(await stagingCounts(id)).toEqual({ memberships: 2, hreflang: 2 });

    // robots.txt still reads and still declares the sitemap; the document
    // fails, so the walk completes having flushed nothing — the clear is the
    // crawl's own call after `discover` returns, not the sink's.
    s.sitemapDown = true;
    const resumed = await resumeCrawl(db, id, { config: config(s) });
    expect(resumed.status).toBe("finished");

    expect(await stagingCounts(id)).toEqual({ memberships: 0, hreflang: 0 });
    const evidence = await evidenceOf(id);
    expect(evidence.robots.outcome).toBe("read");
    expect(evidence.sitemapFacts).toEqual(
      expect.objectContaining({ memberships: 0, hreflangRows: 0 }),
    );
    expect(evidence.truncation.failures.map((f) => f.url)).toEqual([`${s.base}/sitemap.xml`]);
    expect(evidence.truncation.interrupted).toBeUndefined();
  }, 60_000);
});

describe("a resume that finds robots.txt unreachable walks nothing, and replaces nothing (R17)", () => {
  it("(b) the earlier walk's staging and evidence stand; only the robots-derived keys are this read's, and the crawl closes failed", async () => {
    const s = await mutableSite(["/a", "/b"]);
    const id = await finishedCrawl(s);
    const before = await stagingCounts(id);
    expect(before.memberships).toBe(2);
    expect(before.hreflang).toBe(2);
    const kept = await evidenceOf(id);
    expect(kept.robots.outcome).toBe("read");
    expect(kept.sitemapSources).toEqual([`${s.base}/sitemap.xml`]);

    s.robotsDown = true;
    const resumed = await resumeCrawl(db, id, { config: config(s) });

    expect(resumed.status).toBe("failed");
    expect(resumed.note).toMatch(/robots\.txt unreachable/);
    const row = await crawlRow(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toMatch(/robots\.txt unreachable/);

    expect(await stagingCounts(id)).toEqual(before);
    const after = await evidenceOf(id);
    // Every key the walk wrote, unchanged — no `interrupted` mark among them.
    const { robots: _keptRobots, sitemapSources: _keptSources, ...keptWalk } = kept;
    const { robots: newRobots, sitemapSources: newSources, ...afterWalk } = after;
    expect(afterWalk).toEqual(keptWalk);
    expect(after.truncation.interrupted).toBeUndefined();
    // The keys robots.txt decides are this read's (ruling R5): an unreachable
    // file declared no `Sitemap:` line, so the earlier file's are not kept.
    expect(newSources).toEqual([]);
    expect(newRobots.outcome).toBe("unreachable");
    expect(newRobots.note).toMatch(/robots\.txt unreachable/);
    expect(newRobots.note).toBe(resumed.note);
  }, 60_000);

  it("(d) with no evidence on the row, the whole evidence is written and a stopped walk's partial staging is cleared with it", async () => {
    const s = await mutableSite(["/a", "/b"]);
    // A fresh crawl paused inside its walk, after its first flush: staging on
    // the row, and no evidence (a stop in the walk writes none).
    let asked = false;
    const first = await runCrawl(db, LOCAL_TENANT, config(s), undefined, {
      onSitemapFlush: async (stop) => {
        if (asked) return;
        asked = true;
        expect(await setControlRequest(db, await crawlIdOf(s), "pause")).toBe(true);
        await until("the stop signal", () => stop.aborted, 5_000);
      },
    });
    createdCrawls.push(first.crawlId);
    expect(first.status).toBe("paused");
    const id = first.crawlId;
    expect((await crawlRow(id)).discovery).toBeNull();
    expect((await stagingCounts(id)).memberships).toBeGreaterThan(0);

    s.robotsDown = true;
    const resumed = await resumeCrawl(db, id, { config: config(s) });
    expect(resumed.status).toBe("failed");

    // The whole evidence, as on any crawl refused before its first walk, and
    // staging that agrees with it: none.
    const evidence = await evidenceOf(id);
    expect(evidence.robots.outcome).toBe("unreachable");
    expect(evidence.sitemapFacts).toEqual(
      expect.objectContaining({ memberships: 0, hreflangRows: 0 }),
    );
    expect(evidence.truncation.interrupted).toBeUndefined();
    expect(await stagingCounts(id)).toEqual({ memberships: 0, hreflang: 0 });
  }, 60_000);
});

describe("the write-ahead interrupted mark (28a T5)", () => {
  async function insertCrawl(discovery: unknown): Promise<string> {
    const id = randomUUID();
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: "http://mark.invalid/", hostKey: hostKeyOf("http://mark.invalid/"),
      config: {},
      rulesetVersion: "test",
      status: "completed",
      discovery: discovery as never,
    });
    createdCrawls.push(id);
    return id;
  }

  it("lands on legacy evidence that has no truncation object", async () => {
    const id = await insertCrawl({ robots: { outcome: "ok" } });
    await markEvidenceInterrupted(db, id);
    const row = await crawlRow(id);
    const d = row.discovery as unknown as Record<string, any>;
    expect(d.truncation.interrupted).toBe(true);
    expect(d.robots).toEqual({ outcome: "ok" });
  });

  it("keeps the other truncation keys when the object exists", async () => {
    const id = await insertCrawl({ truncation: { sitemapUrlsCapped: true, extra: 3 } });
    await markEvidenceInterrupted(db, id);
    const d = (await crawlRow(id)).discovery as unknown as Record<string, any>;
    expect(d.truncation).toEqual({ sitemapUrlsCapped: true, extra: 3, interrupted: true });
  });
});

describe("a resumed walk sweeps the sitemap entries the site no longer lists (28b T1)", () => {
  /** The paths `sitemap_urls` holds for the crawl, sorted. */
  async function entryPaths(s: MutableSite, id: string): Promise<string[]> {
    const rows = await db
      .select({ url: sitemapUrls.url })
      .from(sitemapUrls)
      .where(eq(sitemapUrls.crawlId, id));
    return rows.map((r) => r.url.slice(s.base.length)).sort();
  }

  it("(a) a URL the site dropped is no longer a sitemap entry after the whole resumed walk", async () => {
    const s = await mutableSite(["/a", "/b"]);
    s.pageDelayMs = 15_000;
    const first = await runCrawl(db, LOCAL_TENANT, config(s), undefined, pauseAtFirstSlot(s));
    createdCrawls.push(first.crawlId);
    expect(first.status).toBe("paused");
    const id = first.crawlId;
    expect(await entryPaths(s, id)).toEqual(["/a", "/b"]);

    s.listed = ["/a"];
    s.pageDelayMs = 0;
    const resumed = await resumeCrawl(db, id, { config: config(s) });
    expect(resumed.status).toBe("finished");

    expect(await entryPaths(s, id)).toEqual(["/a"]);
  }, 60_000);

  it("(b) a resumed persist stopped between batches removes nothing", async () => {
    const many = Array.from({ length: 600 }, (_, i) => `/p${i}`);
    const s = await mutableSite(many);
    const id = await finishedCrawl(s);
    expect(await db.$count(sitemapUrls, eq(sitemapUrls.crawlId, id))).toBe(600);

    // The site now lists 550 of them: two batches (500 + 50), so a completed
    // persist would sweep the 50 dropped rows. The resume is stopped after the
    // first batch, so the sweep never runs and all 600 earlier rows stand.
    s.listed = many.slice(0, 550);
    let asked = false;
    const stopped = await resumeCrawl(db, id, {
      config: config(s),
      testHooks: {
        onSeedingBatch: async (stage, stop) => {
          if (stage !== "sitemap_urls" || asked) return;
          asked = true;
          expect(await setControlRequest(db, id, "pause")).toBe(true);
          await until("the stop signal", () => stop.aborted, 5_000);
        },
      },
    });
    expect(stopped.status).toBe("paused");
    expect(asked).toBe(true);
    expect(await db.$count(sitemapUrls, eq(sitemapUrls.crawlId, id))).toBe(600);
  }, 60_000);
});

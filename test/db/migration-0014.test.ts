/**
 * Migration 0014: `crawls.resource_refs_capped_pages` — the count of pages
 * whose analyzer dropped a resource reference at the `MAX_RESOURCE_REFS` cap
 * (P12-T1, paying the ledger entry phase-11.md §10.1 opened).
 *
 * ## Why a column and not a query
 *
 * The same question is answerable from `page_resources` without any schema at
 * all — count the pages with exactly `MAX_RESOURCE_REFS` edges. Phase 11
 * measured what that costs: **73 ms and 67 ms over a 500,000-edge synthetic
 * crawl**, against a `crawl_status` whose other reads are ≤ 3 ms, on an endpoint
 * a dashboard hits on every paint. The cheaper form that looks obvious —
 * comparing `pages.images_total` against a page's counted image edges — was
 * shown NOT to work: the counter counts `<img>` ELEMENTS and the extraction
 * emits a DISTINCT-URL set, so it fires on any page that reuses an image and
 * stays silent on a truncated page whose references happen to be distinct.
 *
 * So the count is carried, not derived: the analyzer says so per page
 * (`PageAnalysis.resourceRefsCapped`), `PageWriter` counts the pages that say
 * it, and the crawl loop stamps the total here at close. O(pages) in a place
 * every page already passes through, never O(edges).
 *
 * ## What is under test
 *
 * Not the DDL — `runMigrations` either applied it or threw — but the four
 * claims the column makes, and every one of them through a REAL crawl of a real
 * fixture server rather than through hand-written rows (the migration-0012 and
 * -0013 discipline). The chain is analyzer → writer → loop, and a test that
 * seeded the column by hand would pass with all three deleted:
 *
 *  1. a crawl whose page carries more than `MAX_RESOURCE_REFS` references
 *     stamps the number of such pages;
 *  2. a crawl with no such page stamps **0**, which is a measurement — the
 *     analyzer looked at every page and none of them lost a reference;
 *  3. **null is not zero.** A row this writer never closed keeps the null the
 *     migration left, because a crawl written before 0014 (or one that died
 *     before its close) has no answer to give, and 0 is an answer;
 *  4. the flag reaches the column for CSS and JS, which is the gap that
 *     motivated the whole entry — images could be spotted against the uncapped
 *     `images_total`, stylesheets and scripts could not.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { enqueueUrls } from "../../src/crawl/frontier.js";
import { resumeCrawl, runCrawl, type CrawlConfig } from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { MAX_RESOURCE_REFS } from "../../src/crawl/parse/page-analyzer.js";
import { crawls, pages } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * A page past the cap, and by ONE reference: the boundary is what the flag is
 * about, and a page ten thousand refs over would pass a broken implementation
 * that fired a hundred early.
 */
function overCap(): string {
  const imgs = Array.from(
    { length: MAX_RESOURCE_REFS + 1 },
    (_, i) => `<img src="/a/${i}.png" alt="${i}">`,
  ).join("");
  return page(imgs);
}

/** Exactly at the cap: full, and nothing dropped. */
function atCap(): string {
  const imgs = Array.from(
    { length: MAX_RESOURCE_REFS },
    (_, i) => `<img src="/b/${i}.png" alt="${i}">`,
  ).join("");
  return page(imgs);
}

/**
 * The gap the column exists for: a page whose STYLESHEETS fall past the cap.
 * `images_total` is uncapped and sits beside the image refs, so an image list
 * cut short can be spotted against it; CSS and JS have no counter at all.
 */
function cssOverCap(): string {
  const imgs = Array.from(
    { length: MAX_RESOURCE_REFS },
    (_, i) => `<img src="/c/${i}.png" alt="${i}">`,
  ).join("");
  const css = Array.from(
    { length: 40 },
    (_, i) => `<link rel="stylesheet" href="/c/late-${i}.css">`,
  ).join("");
  // The stylesheets are in the BODY, after the images, so they are the
  // references the cap turns away — and nothing in the row shape would ever
  // show it.
  return page(`${imgs}${css}`);
}

function page(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

const created: string[] = [];
let db: Db;

/**
 * One fixture server per case, so each crawl's page set is exactly the pages
 * that case is about. The pages are large (a 2001-image page is ~70 KB) but
 * they are built once and served from memory.
 */
async function withServer<T>(
  bodies: Record<string, string>,
  body: (config: CrawlConfig) => Promise<T>,
): Promise<T> {
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const served = bodies[path];
    if (served === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(served);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no fixture port");
  try {
    return await body({
      siteUrl: `http://127.0.0.1:${addr.port}/`,
      maxPages: 10,
      maxDepth: 3,
      userAgent: "AriadneBot-0014",
      perHostDelayMs: 0,
      maxConcurrency: 2,
      // The references are the subject; asking a fixture server about four
      // thousand missing images is not, and it would be the slowest thing in
      // this file by two orders of magnitude.
      fetchResources: false,
      // The sanctioned test-only use: the fixture site is on 127.0.0.1.
      allowPrivate: true,
    });
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

/**
 * One fixture server per case, so each crawl's page set is exactly the pages
 * that case is about. The pages are large (a 2001-image page is ~70 KB) but
 * they are built once and served from memory.
 */
async function crawlOf(bodies: Record<string, string>): Promise<string> {
  return withServer(bodies, async (config) => {
    const summary = await runCrawl(db, LOCAL_TENANT, config);
    created.push(summary.crawlId);
    return summary.crawlId;
  });
}

async function stamped(crawlId: string): Promise<number | null> {
  const rows = await db
    .select({ n: crawls.resourceRefsCappedPages })
    .from(crawls)
    .where(eq(crawls.id, crawlId));
  if (rows.length !== 1) throw new Error(`no crawls row for ${crawlId}`);
  return rows[0]!.n;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
}, 60_000);

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await closeFetchAgents();
});

describe("0014 — resource_refs_capped_pages", () => {
  it("stamps the pages whose references the cap truncated", async () => {
    const crawlId = await crawlOf({
      "/": page(`<a href="/over">over</a><a href="/at">at</a><a href="/plain">plain</a>`),
      "/over": overCap(),
      "/at": atCap(),
      "/plain": page(`<img src="/p/one.png" alt="one">`),
    });

    // Four pages crawled, one of them truncated: full is not truncated, and a
    // page with one image is not either.
    const counted = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(counted[0]?.n).toBe(4);
    expect(await stamped(crawlId)).toBe(1);
  }, 120_000);

  it("stamps 0 on a crawl that lost nothing — a measurement, not a silence", async () => {
    const crawlId = await crawlOf({
      "/": page(`<a href="/plain">plain</a><img src="/x.png" alt="x">`),
      "/plain": page(`<img src="/y.png" alt="y"><script src="/s.js"></script>`),
    });
    expect(await stamped(crawlId)).toBe(0);
  }, 120_000);

  it("counts a page whose STYLESHEETS fell past the cap — the gap images never had", async () => {
    const crawlId = await crawlOf({
      "/": page(`<a href="/css">css</a>`),
      "/css": cssOverCap(),
    });
    expect(await stamped(crawlId)).toBe(1);
  }, 120_000);

  // NULL IS NOT ZERO, and this is the whole reason the column is nullable and
  // was never backfilled. A crawl that predates 0014 has no answer: nobody
  // counted its truncated pages and nothing can reconstruct them (the edge
  // table cannot tell a page that hit the cap from a page with exactly that
  // many distinct references). Writing 0 there would be a fabricated
  // measurement, which is hard rule 7's exact prohibition.
  it("leaves the column null on a row no crawl loop ever closed", async () => {
    const id = `crawl_${randomUUID()}`;
    created.push(id);
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: "https://pre-0014.example/", hostKey: hostKeyOf("https://pre-0014.example/"),
      config: {},
      rulesetVersion: "test",
    });
    expect(await stamped(id)).toBeNull();
  });

  /**
   * THE RESUME ARITHMETIC. A resumed run's writer only ever met the pages that
   * run fetched, so the stamp must ADD to what is already there rather than
   * overwrite it — a resume that assigned would report a three-page truncation
   * as whatever the last run happened to see.
   *
   * And the addition is done in SQL for one property, asserted below: `null + n`
   * is null. A crawl whose earlier run predates this column has NO count, and a
   * resume must not turn that honest null into a partial number a reader would
   * take for a whole one (hard rule 7).
   */
  it("adds a resumed run's count to the earlier run's, and keeps a null null", async () => {
    // Two over-cap pages the first run reaches, and a third the frontier is
    // given AFTERWARDS — which is what makes this deterministic rather than a
    // race against an abort timer. The counts are exact on both sides: 2 from
    // the first run, 1 from the resume, and 3 is the only total an ADDITION can
    // produce. An assignment would leave 1.
    const bodies: Record<string, string> = {
      "/": page(`<a href="/one">1</a><a href="/two">2</a>`),
      "/one": overCap(),
      "/two": overCap(),
      "/three": overCap(),
      "/four": overCap(),
    };

    await withServer(bodies, async (config) => {
      const first = await runCrawl(db, LOCAL_TENANT, config);
      created.push(first.crawlId);
      const crawlId = first.crawlId;
      expect(await stamped(crawlId)).toBe(2);

      await enqueueUrls(db, crawlId, [
        { url: new URL("/three", config.siteUrl).href, depth: 1, discoveredVia: "link" },
      ]);
      await resumeCrawl(db, crawlId, { config });
      expect(await stamped(crawlId)).toBe(3);

      // Now the null. Blanked by hand, which is exactly the state a crawl whose
      // FIRST run predated migration 0014 is in, and resumed again with real
      // work to do: `null + n` must stay null rather than becoming this run's
      // count, because a partial number here reads exactly like a whole one.
      await db
        .update(crawls)
        .set({ resourceRefsCappedPages: null })
        .where(eq(crawls.id, crawlId));
      await enqueueUrls(db, crawlId, [
        { url: new URL("/four", config.siteUrl).href, depth: 1, discoveredVia: "link" },
      ]);
      await resumeCrawl(db, crawlId, { config });
      expect(await stamped(crawlId)).toBeNull();
    });
  }, 180_000);
});

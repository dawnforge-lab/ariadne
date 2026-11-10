/**
 * Phase 27c Task 4: frontier admission under a crawl scope.
 *
 *  - `exclude` / `include` patterns refuse URLs at admission (after url-policy,
 *    before robots), and a refused URL is an `excluded` page row, never a
 *    request; the rows share `maxBlockedUrls` with robots-blocked rows.
 *  - `maxRedirectHops` caps a redirect chain per chain (Deviation 12).
 *  - `maxUrlLength` refuses a long URL before it reaches the frontier.
 *  - A resume whose stored scope changed re-files the unfetched frontier.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages } from "../../src/db/schema.js";
import { setControlRequest } from "../../src/crawl/control.js";
import { enqueueUrls, frontierCounts } from "../../src/crawl/frontier.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import {
  CRAWL_DEFAULTS,
  parseStoredConfig,
  refileOutOfScope,
  resumeCrawl,
  type RefileLimits,
  runCrawl,
  validateCrawlConfig,
  type CrawlConfig,
  type CrawlSummary,
} from "../../src/crawl/loop.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(what: string, predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

let db: Db;
let server: Server;
let base: string;
/** Every path the fixture was asked for, robots.txt and the 404 probe included. */
let requested: string[] = [];
const createdCrawls: string[] = [];

/** Paths that hang until a test releases them (the resume tests' pause point). */
const heldPaths = new Set<string>();
const heldResponses = new Set<ServerResponse>();

/** A path long enough that `${base}${LONG_PATH}` is 400 characters. */
let LONG_PATH = "";

/**
 * The fixture site. Each test seeds its own entry page:
 *   /            -> /a, /b1
 *   /inc/        -> /keep/1, /other
 *   /bud/        -> /blocked/1 (robots), /bx/1, /bx/2
 *   /both/       -> /blocked/2 (robots AND excluded)
 *   /chain/      -> /r/0;  /r/n -> 301 /r/n+1 (n < 12); /r/12 -> 301 /end
 *   /short/      -> /h/0;  /h/0 -> /h/1 -> /h/2 -> /hend (3 hops)
 *   /long/       -> LONG_PATH
 *   /res/        -> /x/0, /hold;  /x/0 -> /x/1, /x/2;  /hold hangs until released
 *   /wid/        -> /x/1, /hold2 (hangs until released)
 *   /redir/      -> /go;  /go -> 301 /nope/1
 *   /smseed/     -> nothing; /sm.xml (supplied) lists /sm/keep and /sm/nope/1
 */
const LINKS: Record<string, string[]> = {
  "/": ["/a", "/b1"],
  "/a": [],
  "/b1": [],
  "/inc/": ["/keep/1", "/other"],
  "/keep/1": [],
  "/other": [],
  "/bud/": ["/blocked/1", "/bx/1", "/bx/2"],
  "/bx/1": [],
  "/bx/2": [],
  "/blocked/1": [],
  "/both/": ["/blocked/2"],
  "/blocked/2": [],
  "/chain/": ["/r/0"],
  "/end": [],
  "/short/": ["/h/0"],
  "/hend": [],
  "/long/": [], // filled in once LONG_PATH is known
  "/res/": ["/x/0", "/hold"],
  "/x/0": ["/x/1", "/x/2"],
  "/x/1": [],
  "/x/2": [],
  "/wid/": ["/x/1", "/hold2"],
  "/redir/": ["/go"],
  "/xochain/": ["/xo/0"],
  "/nope/1": [],
  "/smseed/": [],
  "/sm/keep": [],
  "/sm/nope/1": [],
};

function html(path: string, links: string[]): string {
  return (
    `<!doctype html><html><head><title>Page ${path.slice(0, 40)}</title></head><body>` +
    `<h1>${path.slice(0, 40)}</h1>` +
    links.map((href) => `<a href="${href}">link</a>`).join(" ") +
    `</body></html>`
  );
}

function site(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requested.push(path);
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /blocked/\n");
      return;
    }
    const chain = /^\/r\/(\d+)$/.exec(path);
    if (chain !== null) {
      const n = Number(chain[1]);
      res.writeHead(301, { location: n < 12 ? `/r/${n + 1}` : "/end" });
      res.end();
      return;
    }
    const hop = /^\/h\/(\d)$/.exec(path);
    if (hop !== null) {
      const n = Number(hop[1]);
      res.writeHead(301, { location: n < 2 ? `/h/${n + 1}` : "/hend" });
      res.end();
      return;
    }
    // A two-hop chain whose last hop leaves the origin (127.0.0.1 -> localhost).
    if (path === "/xo/0") {
      res.writeHead(301, { location: "/xo/1" });
      res.end();
      return;
    }
    if (path === "/xo/1") {
      res.writeHead(301, { location: base.replace("127.0.0.1", "localhost") + "/elsewhere" });
      res.end();
      return;
    }
    if (path === "/go") {
      res.writeHead(301, { location: "/nope/1" });
      res.end();
      return;
    }
    if (path === "/sm.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${base}/sm/keep</loc></url>` +
          `<url><loc>${base}/sm/nope/1</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    if (heldPaths.has(path)) {
      heldResponses.add(res);
      res.on("close", () => heldResponses.delete(res));
      return;
    }
    const links = path === "/hold" || path === "/hold2" || path === LONG_PATH ? [] : LINKS[path];
    if (links === undefined) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Not found</title><p>nothing here</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html(path, links));
  });
}

function cfg(seedPath: string, overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: `${base}${seedPath}`,
    maxPages: 100,
    maxDepth: 10,
    userAgent: "AriadneBot-scope-test",
    perHostDelayMs: 0,
    maxConcurrency: 4,
    allowPrivate: true,
    probeHosts: false,
    fetchResources: false,
    recheckMinGapMs: 50,
    ...overrides,
  };
}

async function crawl(config: CrawlConfig): Promise<CrawlSummary> {
  requested = [];
  const summary = await runCrawl(db, config);
  createdCrawls.push(summary.crawlId);
  return summary;
}

async function rowsOf(crawlId: string): Promise<Map<string, typeof pages.$inferSelect>> {
  const rows = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
  return new Map(rows.map((r) => [r.url.slice(base.length), r]));
}

async function crawlRow(id: string) {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  server = site();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  LONG_PATH = "/l/" + "x".repeat(400 - base.length - 3);
  LINKS["/long/"] = [LONG_PATH];
});

afterAll(async () => {
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  for (const res of heldResponses) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("scope admission", () => {
  it("writes an excluded row for a URL an exclude pattern matches, never requests it, and stamps excluded_dropped 0", async () => {
    const summary = await crawl(cfg("/", { exclude: ["*/b*"] }));
    expect(summary.status).toBe("finished");
    const rows = await rowsOf(summary.crawlId);

    expect(rows.get("/a")?.fetchClass).toBe("ok");
    const b1 = rows.get("/b1");
    expect(b1?.fetchClass).toBe("excluded");
    expect(b1?.fetchReason).toBe("crawl scope: matches exclude pattern '*/b*'");
    expect(b1?.statusCode).toBeNull();
    expect(b1?.discoveredVia).toBe("link");
    expect(requested).not.toContain("/b1");

    const row = await crawlRow(summary.crawlId);
    expect(row.excludedDropped).toBe(0);
    expect(row.robotsBlockedDropped).toBe(0);
    // Stored, so a resume runs under the same scope.
    expect((row.config as Record<string, unknown>)["exclude"]).toEqual(["*/b*"]);
  });

  it("refuses a link no include pattern matches, and admits the seed itself", async () => {
    const summary = await crawl(cfg("/inc/", { include: ["*/keep/*"] }));
    const rows = await rowsOf(summary.crawlId);

    expect(rows.get("/inc/")?.fetchClass).toBe("ok");
    expect(rows.get("/keep/1")?.fetchClass).toBe("ok");
    const other = rows.get("/other");
    expect(other?.fetchClass).toBe("excluded");
    expect(other?.fetchReason).toBe("crawl scope: matches no include pattern");
    expect(requested).not.toContain("/other");
  });

  it("shares maxBlockedUrls between excluded and robots-blocked rows, the overflow counted in the two dropped columns", async () => {
    const summary = await crawl(
      cfg("/bud/", { exclude: ["*/bx/*"], maxBlockedUrls: 2, maxConcurrency: 1 }),
    );
    const rows = [...(await rowsOf(summary.crawlId)).values()];
    const neverRequested = rows.filter(
      (r) =>
        r.fetchClass === "excluded" ||
        (r.fetchClass === "disallowed" && (r.fetchReason ?? "").startsWith("robots.txt: ")),
    );
    expect(neverRequested).toHaveLength(2);

    const row = await crawlRow(summary.crawlId);
    expect((row.excludedDropped ?? NaN) + (row.robotsBlockedDropped ?? NaN)).toBe(1);
    for (const path of ["/bx/1", "/bx/2", "/blocked/1"]) expect(requested).not.toContain(path);
  });

  it("checks the scope before robots: a URL both refuse is excluded", async () => {
    const summary = await crawl(cfg("/both/", { exclude: ["*/blocked/*"] }));
    const rows = await rowsOf(summary.crawlId);
    const both = rows.get("/blocked/2");
    expect(both?.fetchClass).toBe("excluded");
    expect(both?.fetchReason).toBe("crawl scope: matches exclude pattern '*/blocked/*'");
  });
});

describe("the redirect cap", () => {
  it("follows a chain to maxRedirectHops and names the cap on the last hop it fetched", async () => {
    const summary = await crawl(cfg("/chain/", { maxRedirectHops: 10 }));
    const rows = await rowsOf(summary.crawlId);

    for (let n = 0; n <= 10; n += 1) {
      expect(rows.get(`/r/${n}`)?.fetchClass, `/r/${n}`).toBe("redirect");
    }
    expect(rows.has("/r/11")).toBe(false);
    expect(rows.has("/end")).toBe(false);
    expect(requested).not.toContain("/r/11");
    const last = rows.get("/r/10");
    expect(last?.fetchReason).toContain("maxRedirectHops is 10");
    expect(last?.redirectUrl).toBe(`${base}/r/11`);
    // Hops below the cap carry no reason.
    expect(rows.get("/r/9")?.fetchReason).toBeNull();

    const [hops] = await db
      .select({ redirectHops: frontier.redirectHops })
      .from(frontier)
      .where(and(eq(frontier.crawlId, summary.crawlId), eq(frontier.url, `${base}/r/10`)));
    expect(hops?.redirectHops).toBe(10);
  });

  it("does not name the cap on a redirect at the cap whose target leaves the origin", async () => {
    const summary = await crawl(cfg("/xochain/", { maxRedirectHops: 1 }));
    const rows = await rowsOf(summary.crawlId);
    expect(rows.get("/xo/0")?.fetchClass).toBe("redirect");
    const last = rows.get("/xo/1");
    expect(last?.fetchClass).toBe("redirect");
    expect(last?.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/elsewhere$/);
    expect(last?.fetchReason).toBeNull();
  });

  it("follows a 3-hop chain to its target under the default cap", async () => {
    expect(CRAWL_DEFAULTS.maxRedirectHops).toBe(10);
    const summary = await crawl(cfg("/short/"));
    const rows = await rowsOf(summary.crawlId);
    for (const path of ["/h/0", "/h/1", "/h/2"]) {
      expect(rows.get(path)?.fetchClass, path).toBe("redirect");
      expect(rows.get(path)?.fetchReason, path).toBeNull();
    }
    expect(rows.get("/hend")?.fetchClass).toBe("ok");
  });
});

describe("the URL length limit", () => {
  it("never requests or queues a link longer than maxUrlLength, and records it as an excluded row", async () => {
    expect(`${base}${LONG_PATH}`).toHaveLength(400);
    expect(CRAWL_DEFAULTS.maxUrlLength).toBe(2500);
    const summary = await crawl(cfg("/long/", { maxUrlLength: 300 }));
    expect(requested).not.toContain(LONG_PATH);
    const queued = await db
      .select()
      .from(frontier)
      .where(and(eq(frontier.crawlId, summary.crawlId), eq(frontier.url, `${base}${LONG_PATH}`)));
    expect(queued).toHaveLength(0);
    const row = (await rowsOf(summary.crawlId)).get(LONG_PATH);
    expect(row?.fetchClass).toBe("excluded");
    expect(row?.fetchReason).toBe(
      "crawl scope: longer than maxUrlLength (400 characters; the limit is 300)",
    );
    expect(row?.statusCode).toBeNull();
  });

  it("requests the same link under the default limit", async () => {
    const summary = await crawl(cfg("/long/"));
    expect(requested).toContain(LONG_PATH);
    expect((await rowsOf(summary.crawlId)).get(LONG_PATH)?.fetchClass).toBe("ok");
  });
});

describe("the re-filter on resume", () => {
  it("re-files pending URLs a changed scope refuses as excluded rows before any lease, leaving fetched ones alone", async () => {
    heldPaths.add("/hold");
    requested = [];
    // Two at a time, so the seed's two links (/x/0, /hold) are one batch:
    // /x/0 answers and queues /x/1 and /x/2, while /hold keeps the batch open.
    const run = runCrawl(db, cfg("/res/", { maxConcurrency: 2 }));
    run.catch(() => undefined);
    let id = "";
    await until("the crawl row", async () => {
      const rows = await db
        .select({ id: crawls.id })
        .from(crawls)
        .where(eq(crawls.siteUrl, `${base}/res/`));
      const fresh = rows.filter((r) => !createdCrawls.includes(r.id));
      if (fresh.length === 1) id = fresh[0]!.id;
      return id !== "";
    });
    createdCrawls.push(id);
    await until("/hold in flight with /x/1 and /x/2 queued", async () => {
      if (!requested.includes("/hold")) return false;
      const queued = await db
        .select({ url: frontier.url, state: frontier.state })
        .from(frontier)
        .where(eq(frontier.crawlId, id));
      const pending = queued.filter((r) => r.state === "pending").map((r) => r.url);
      return pending.includes(`${base}/x/1`) && pending.includes(`${base}/x/2`);
    });
    expect(await setControlRequest(db, id, "pause")).toBe(true);
    const paused = await run;
    expect(paused.status).toBe("paused");
    expect(requested).not.toContain("/x/1");
    expect(requested).not.toContain("/x/2");
    expect((await rowsOf(id)).get("/x/0")?.fetchClass).toBe("ok");

    const stored = (await crawlRow(id)).config as Record<string, unknown>;
    await db
      .update(crawls)
      .set({ config: { ...stored, exclude: ["*/x/*"] } })
      .where(eq(crawls.id, id));
    // A dead worker's lease on /x/2, run out: the pause returned only its own
    // worker's leases, and `leaseBatch` would hand this one out at once.
    await db
      .update(frontier)
      .set({
        state: "leased",
        leaseId: "worker_dead",
        leasedUntil: sql`now() - interval '1 minute'`,
      })
      .where(and(eq(frontier.crawlId, id), eq(frontier.url, `${base}/x/2`)));

    heldPaths.delete("/hold");
    requested = [];
    const config = { ...parseStoredConfig((await crawlRow(id)).config, id), allowPrivate: true };
    expect(config.exclude).toEqual(["*/x/*"]);
    const resumed = await resumeCrawl(db, id, { config });
    expect(resumed.status).toBe("finished");

    const rows = await rowsOf(id);
    for (const path of ["/x/1", "/x/2"]) {
      expect(rows.get(path)?.fetchClass, path).toBe("excluded");
      expect(rows.get(path)?.fetchReason, path).toBe("crawl scope: matches exclude pattern '*/x/*'");
      expect(rows.get(path)?.depth, path).toBe(2);
      expect(rows.get(path)?.discoveredVia, path).toBe("link");
      expect(requested).not.toContain(path);
    }
    expect(rows.get("/x/0")?.fetchClass).toBe("ok");
    expect(rows.get("/hold")?.fetchClass).toBe("ok");
    const left = await db
      .select({ url: frontier.url })
      .from(frontier)
      .where(eq(frontier.crawlId, id));
    expect(left.map((r) => r.url)).not.toContain(`${base}/x/1`);
    expect(left.map((r) => r.url)).not.toContain(`${base}/x/2`);
    expect((await crawlRow(id)).excludedDropped).toBe(0);
  });
});

describe("refileOutOfScope", () => {
  const allowAll: RefileLimits["robots"] = {
    outcome: "read",
    isAllowed: () => true,
    matchingRule: () => null,
  };
  const limits = (budget: number, over: Partial<RefileLimits> = {}): RefileLimits => ({
    blockedBudget: budget,
    maxPages: 100,
    maxUrlLength: 2500,
    robots: allowAll,
    ...over,
  });

  async function seededCrawl(): Promise<string> {
    const id = `crawl_refile_${Math.random().toString(36).slice(2)}`;
    await db.insert(crawls).values({
      id,
      siteUrl: "https://refile.example/",
      config: {},
      rulesetVersion: RULESET_VERSION,
      status: "paused",
    });
    createdCrawls.push(id);
    await enqueueUrls(db, id, [
      { url: "https://refile.example/keep", depth: 1, discoveredVia: "link" },
      { url: "https://refile.example/drop/1", depth: 1, discoveredVia: "link" },
      { url: "https://refile.example/drop/2", depth: 2, discoveredVia: "sitemap" },
      { url: "https://refile.example/drop/3", depth: 3, discoveredVia: "redirect" },
    ]);
    return id;
  }

  it("writes refused pending rows up to the budget, counts the rest, and deletes them all from the frontier", async () => {
    const id = await seededCrawl();
    const result = await refileOutOfScope(db, id, { exclude: ["*/drop/*"], include: [] }, limits(2));
    expect(result).toEqual({ refiled: 2, dropped: 1, readmitted: 0, reblocked: 0, unroomed: 0 });

    const rows = await db.select().from(pages).where(eq(pages.crawlId, id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.fetchClass).toBe("excluded");
      expect(row.fetchReason).toBe("crawl scope: matches exclude pattern '*/drop/*'");
      expect(row.url).toMatch(/\/drop\/\d$/);
    }
    const left = await db.select({ url: frontier.url }).from(frontier).where(eq(frontier.crawlId, id));
    expect(left.map((r) => r.url)).toEqual(["https://refile.example/keep"]);
    expect((await frontierCounts(db, id)).pending).toBe(1);
  });

  it("refiles under an include list, and changes nothing for an empty scope", async () => {
    const id = await seededCrawl();
    expect(await refileOutOfScope(db, id, { exclude: [], include: [] }, limits(10))).toEqual({
      refiled: 0,
      dropped: 0,
      readmitted: 0,
      reblocked: 0,
      unroomed: 0,
    });
    expect((await frontierCounts(db, id)).pending).toBe(4);

    const result = await refileOutOfScope(
      db,
      id,
      { exclude: [], include: ["*/keep"] },
      limits(10),
    );
    expect(result).toEqual({ refiled: 3, dropped: 0, readmitted: 0, reblocked: 0, unroomed: 0 });
    const rows = await db.select().from(pages).where(eq(pages.crawlId, id));
    expect(new Set(rows.map((r) => r.fetchReason))).toEqual(
      new Set(["crawl scope: matches no include pattern"]),
    );
    expect(new Map(rows.map((r) => [r.url, r.discoveredVia]))).toEqual(
      new Map([
        ["https://refile.example/drop/1", "link"],
        ["https://refile.example/drop/2", "sitemap"],
        ["https://refile.example/drop/3", "redirect"],
      ]),
    );
  });

  it("with no budget left, counts every refused row and writes none", async () => {
    const id = await seededCrawl();
    expect(
      await refileOutOfScope(db, id, { exclude: ["*/drop/*"], include: [] }, limits(0)),
    ).toEqual({ refiled: 0, dropped: 3, readmitted: 0, reblocked: 0, unroomed: 0 });
    expect(await db.select().from(pages).where(eq(pages.crawlId, id))).toHaveLength(0);
    expect((await frontierCounts(db, id)).pending).toBe(1);
  });

  it("re-files a dead worker's expired lease, and leaves a live lease alone", async () => {
    const id = await seededCrawl();
    await db
      .update(frontier)
      .set({ state: "leased", leaseId: "worker_dead", leasedUntil: sql`now() - interval '1 minute'` })
      .where(and(eq(frontier.crawlId, id), eq(frontier.url, "https://refile.example/drop/1")));
    await db
      .update(frontier)
      .set({ state: "leased", leaseId: "worker_live", leasedUntil: sql`now() + interval '1 hour'` })
      .where(and(eq(frontier.crawlId, id), eq(frontier.url, "https://refile.example/drop/2")));

    const result = await refileOutOfScope(db, id, { exclude: ["*/drop/*"], include: [] }, limits(10));
    expect(result.refiled).toBe(2);
    const rows = await db.select({ url: pages.url }).from(pages).where(eq(pages.crawlId, id));
    expect(rows.map((r) => r.url).sort()).toEqual([
      "https://refile.example/drop/1",
      "https://refile.example/drop/3",
    ]);
    const left = await db
      .select({ url: frontier.url, state: frontier.state })
      .from(frontier)
      .where(eq(frontier.crawlId, id));
    expect(new Map(left.map((r) => [r.url, r.state]))).toEqual(
      new Map([
        ["https://refile.example/keep", "pending"],
        ["https://refile.example/drop/2", "leased"],
      ]),
    );
  });

  /** A crawl whose `/drop/*` URLs are excluded rows, and only `/keep` is queued. */
  async function excludedCrawl(): Promise<string> {
    const id = await seededCrawl();
    await refileOutOfScope(db, id, { exclude: ["*/drop/*"], include: [] }, limits(10));
    return id;
  }

  it("re-admits excluded rows the scope now admits: back in the frontier, pending, row deleted", async () => {
    const id = await excludedCrawl();
    const result = await refileOutOfScope(db, id, { exclude: [], include: [] }, limits(10));
    expect(result).toEqual({ refiled: 0, dropped: 0, readmitted: 3, reblocked: 0, unroomed: 0 });
    expect(await db.select().from(pages).where(eq(pages.crawlId, id))).toHaveLength(0);
    const back = await db
      .select({
        url: frontier.url,
        state: frontier.state,
        depth: frontier.depth,
        via: frontier.discoveredVia,
        hops: frontier.redirectHops,
      })
      .from(frontier)
      .where(eq(frontier.crawlId, id));
    expect(back.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: "https://refile.example/drop/1", state: "pending", depth: 1, via: "link", hops: 0 },
      { url: "https://refile.example/drop/2", state: "pending", depth: 2, via: "sitemap", hops: 0 },
      { url: "https://refile.example/drop/3", state: "pending", depth: 3, via: "redirect", hops: 0 },
      { url: "https://refile.example/keep", state: "pending", depth: 1, via: "link", hops: 0 },
    ]);
  });

  it("with no frontier room, deletes the excluded row and stamps frontier_capped", async () => {
    const id = await excludedCrawl();
    // One frontier row (/keep) held, so maxPages 2 leaves room for one.
    const result = await refileOutOfScope(
      db,
      id,
      { exclude: [], include: [] },
      limits(10, { maxPages: 2 }),
    );
    expect(result).toEqual({ refiled: 0, dropped: 0, readmitted: 1, reblocked: 0, unroomed: 2 });
    expect(await db.select().from(pages).where(eq(pages.crawlId, id))).toHaveLength(0);
    expect((await frontierCounts(db, id)).pending).toBe(2);
    expect((await crawlRow(id)).frontierCapped).toBe(true);
  });

  it("re-classes a re-admitted URL robots.txt disallows as a robots-blocked row, never queued", async () => {
    const id = await excludedCrawl();
    const robots: RefileLimits["robots"] = {
      outcome: "read",
      isAllowed: (url) => !url.endsWith("/drop/1"),
      matchingRule: (url) => (url.endsWith("/drop/1") ? "Disallow: /drop/1" : null),
    };
    const result = await refileOutOfScope(
      db,
      id,
      { exclude: [], include: [] },
      limits(10, { robots }),
    );
    expect(result).toEqual({ refiled: 0, dropped: 0, readmitted: 2, reblocked: 1, unroomed: 0 });
    const rows = await db.select().from(pages).where(eq(pages.crawlId, id));
    expect(rows.map((r) => [r.url, r.fetchClass, r.fetchReason])).toEqual([
      ["https://refile.example/drop/1", "disallowed", "robots.txt: Disallow: /drop/1"],
    ]);
    const queued = await db.select({ url: frontier.url }).from(frontier).where(eq(frontier.crawlId, id));
    expect(queued.map((r) => r.url)).not.toContain("https://refile.example/drop/1");
  });

  it("keeps an excluded row longer than maxUrlLength: that refusal is the length, not a pattern", async () => {
    const id = await excludedCrawl();
    const result = await refileOutOfScope(
      db,
      id,
      { exclude: [], include: [] },
      // "https://refile.example/drop/N" is 29 characters.
      limits(10, { maxUrlLength: 28 }),
    );
    expect(result.readmitted).toBe(0);
    expect(await db.select().from(pages).where(eq(pages.crawlId, id))).toHaveLength(3);
  });
});

describe("scope admission, the other discovery kinds", () => {
  it("records a redirect target the scope refuses as an excluded row discovered via redirect", async () => {
    const summary = await crawl(cfg("/redir/", { exclude: ["*/nope/*"] }));
    const rows = await rowsOf(summary.crawlId);
    expect(rows.get("/go")?.fetchClass).toBe("redirect");
    const target = rows.get("/nope/1");
    expect(target?.fetchClass).toBe("excluded");
    expect(target?.discoveredVia).toBe("redirect");
    expect(target?.fetchReason).toBe("crawl scope: matches exclude pattern '*/nope/*'");
    expect(requested).not.toContain("/nope/1");
  });

  it("skips a sitemap entry the scope refuses: no row and no request (Deviation 8)", async () => {
    const summary = await crawl(
      cfg("/smseed/", { exclude: ["*/nope/*"], sitemapUrls: [`${base}/sm.xml`] }),
    );
    const rows = await rowsOf(summary.crawlId);
    expect(requested).toContain("/sm.xml");
    expect(rows.get("/sm/keep")?.fetchClass).toBe("ok");
    expect(rows.has("/sm/nope/1")).toBe(false);
    expect(requested).not.toContain("/sm/nope/1");
    expect((await crawlRow(summary.crawlId)).excludedDropped).toBe(0);
  });
});

describe("the re-filter on resume, widening", () => {
  it("re-admits an excluded URL the cleared scope admits, and fetches it to an ok row", async () => {
    heldPaths.add("/hold2");
    requested = [];
    const run = runCrawl(db, cfg("/wid/", { exclude: ["*/x/*"], maxConcurrency: 2 }));
    run.catch(() => undefined);
    let id = "";
    await until("the crawl row", async () => {
      const rows = await db
        .select({ id: crawls.id })
        .from(crawls)
        .where(eq(crawls.siteUrl, `${base}/wid/`));
      const fresh = rows.filter((r) => !createdCrawls.includes(r.id));
      if (fresh.length === 1) id = fresh[0]!.id;
      return id !== "";
    });
    createdCrawls.push(id);
    await until("/hold2 in flight with /x/1 excluded", async () => {
      if (!requested.includes("/hold2")) return false;
      return (await rowsOf(id)).get("/x/1")?.fetchClass === "excluded";
    });
    expect(await setControlRequest(db, id, "pause")).toBe(true);
    expect((await run).status).toBe("paused");
    expect(requested).not.toContain("/x/1");

    const stored = (await crawlRow(id)).config as Record<string, unknown>;
    const { exclude: _cleared, ...widened } = stored;
    await db.update(crawls).set({ config: widened }).where(eq(crawls.id, id));

    heldPaths.delete("/hold2");
    requested = [];
    const config = { ...parseStoredConfig((await crawlRow(id)).config, id), allowPrivate: true };
    expect(config.exclude).toBeUndefined();
    expect((await resumeCrawl(db, id, { config })).status).toBe("finished");

    expect(requested).toContain("/x/1");
    const x1 = (await rowsOf(id)).get("/x/1");
    expect(x1?.fetchClass).toBe("ok");
    expect(x1?.depth).toBe(1);
    expect(x1?.discoveredVia).toBe("link");
  });
});

describe("scope config validation and storage", () => {
  const valid = (): CrawlConfig => ({
    siteUrl: "https://example.com/",
    maxPages: 10,
    maxDepth: 3,
    userAgent: "AriadneBot-scope-test",
    perHostDelayMs: 0,
    maxConcurrency: 1,
  });

  it("accepts the bounds of maxRedirectHops (1–20) and maxUrlLength (256–2,500)", () => {
    for (const maxRedirectHops of [1, 20]) {
      expect(() => validateCrawlConfig({ ...valid(), maxRedirectHops })).not.toThrow();
    }
    for (const maxUrlLength of [256, 2500]) {
      expect(() => validateCrawlConfig({ ...valid(), maxUrlLength })).not.toThrow();
    }
  });

  it("refuses maxRedirectHops and maxUrlLength out of range or fractional", () => {
    for (const maxRedirectHops of [0, 21, 1.5]) {
      expect(() => validateCrawlConfig({ ...valid(), maxRedirectHops })).toThrow(
        /maxRedirectHops must be an integer from 1 to 20/,
      );
    }
    for (const maxUrlLength of [255, 2501, 300.5]) {
      expect(() => validateCrawlConfig({ ...valid(), maxUrlLength })).toThrow(
        /maxUrlLength must be an integer from 256 to 2500/,
      );
    }
  });

  it("refuses more than 100 patterns, a pattern over 512 characters, and an empty pattern", () => {
    const many = Array.from({ length: 101 }, (_, i) => `*/p${i}/*`);
    expect(() => validateCrawlConfig({ ...valid(), exclude: many })).toThrow(
      /exclude holds 101 patterns; the limit is 100/,
    );
    expect(() => validateCrawlConfig({ ...valid(), include: ["*" + "a".repeat(512)] })).toThrow(
      /include pattern is 513 characters; the limit is 512/,
    );
    expect(() => validateCrawlConfig({ ...valid(), exclude: [""] })).toThrow(
      /exclude pattern is empty/,
    );
    expect(() =>
      validateCrawlConfig({ ...valid(), exclude: Array.from({ length: 100 }, () => "*/x/*") }),
    ).not.toThrow();
  });

  it("reads the four fields back off a stored config, and refuses a stored value of the wrong shape naming the crawl", () => {
    const stored = {
      ...valid(),
      exclude: ["*/a/*"],
      include: ["*/b/*"],
      maxRedirectHops: 5,
      maxUrlLength: 400,
    };
    const read = parseStoredConfig(stored, "crawl_shape");
    expect(read.exclude).toEqual(["*/a/*"]);
    expect(read.include).toEqual(["*/b/*"]);
    expect(read.maxRedirectHops).toBe(5);
    expect(read.maxUrlLength).toBe(400);

    expect(() => parseStoredConfig({ ...stored, exclude: "*/a/*" }, "crawl_shape")).toThrow(
      /crawl crawl_shape: stored config.exclude is not an array of strings/,
    );
    expect(() => parseStoredConfig({ ...stored, include: [1] }, "crawl_shape")).toThrow(
      /crawl crawl_shape: stored config.include is not an array of strings/,
    );
    expect(() => parseStoredConfig({ ...stored, maxRedirectHops: "5" }, "crawl_shape")).toThrow(
      /crawl crawl_shape: stored config.maxRedirectHops is not a number/,
    );
    expect(() => parseStoredConfig({ ...stored, maxUrlLength: null }, "crawl_shape")).toThrow(
      /crawl crawl_shape: stored config.maxUrlLength is not a number/,
    );
  });
});

describe("refileOutOfScope, the final wave (27c)", () => {
  const allowAll: RefileLimits["robots"] = {
    outcome: "read",
    isAllowed: () => true,
    matchingRule: () => null,
  };
  const limits = (blockedBudget: number, over: Partial<RefileLimits> = {}): RefileLimits => ({
    blockedBudget,
    maxPages: 100,
    maxUrlLength: 2500,
    robots: allowAll,
    ...over,
  });

  /** `/drop/1..3` as excluded rows (by a first re-filter), `/keep`, `/x/1`, `/x/2` pending. */
  async function crawlWithExcludedRows(): Promise<string> {
    const id = `crawl_refile_fw_${Math.random().toString(36).slice(2)}`;
    await db.insert(crawls).values({
      id,
      siteUrl: "https://refile.example/",
      config: {},
      rulesetVersion: RULESET_VERSION,
      status: "paused",
    });
    createdCrawls.push(id);
    await enqueueUrls(db, id, [
      { url: "https://refile.example/keep", depth: 1, discoveredVia: "link" },
      { url: "https://refile.example/drop/1", depth: 1, discoveredVia: "link" },
      { url: "https://refile.example/drop/2", depth: 1, discoveredVia: "link" },
      { url: "https://refile.example/drop/3", depth: 1, discoveredVia: "link" },
    ]);
    await refileOutOfScope(db, id, { exclude: ["*/drop/*"], include: [] }, limits(10));
    await enqueueUrls(db, id, [
      { url: "https://refile.example/x/1", depth: 2, discoveredVia: "link" },
      { url: "https://refile.example/x/2", depth: 2, discoveredVia: "link" },
    ]);
    return id;
  }

  it("measures the forward budget after the backward pass, so budget the backward pass frees is spent (M4)", async () => {
    // Budget 3, three excluded rows on record: nothing left — until the
    // narrow-then-widen edit re-admits the three /drop/ rows, which frees it.
    const id = await crawlWithExcludedRows();
    const result = await refileOutOfScope(db, id, { exclude: ["*/x/*"], include: [] }, limits(3));
    expect(result).toEqual({ refiled: 2, dropped: 0, readmitted: 3, reblocked: 0, unroomed: 0 });
    const rows = await db.select({ url: pages.url, fetchClass: pages.fetchClass }).from(pages).where(eq(pages.crawlId, id));
    expect(rows.map((r) => [r.url, r.fetchClass]).sort()).toEqual([
      ["https://refile.example/x/1", "excluded"],
      ["https://refile.example/x/2", "excluded"],
    ]);
  });

  it("counts the rows already on record against the budget when nothing is re-admitted (M4)", async () => {
    const id = await crawlWithExcludedRows();
    const result = await refileOutOfScope(
      db,
      id,
      { exclude: ["*/drop/*", "*/x/*"], include: [] },
      limits(4),
    );
    expect(result).toEqual({ refiled: 1, dropped: 1, readmitted: 0, reblocked: 0, unroomed: 0 });
  });

  it("gives the backward pass the room the forward pass frees in the frontier (M4)", async () => {
    // Frontier: /keep, /x/1, /x/2. maxPages 4 — the forward pass removes /x/1
    // and /x/2, so three /drop/ rows fit beside /keep.
    const id = await crawlWithExcludedRows();
    const result = await refileOutOfScope(
      db,
      id,
      { exclude: ["*/x/*"], include: [] },
      limits(10, { maxPages: 4 }),
    );
    expect(result).toEqual({ refiled: 2, dropped: 0, readmitted: 3, reblocked: 0, unroomed: 0 });
  });

  it("makes a robots line holding U+0000 storable when it re-classes a row (M2)", async () => {
    const id = await crawlWithExcludedRows();
    const robots: RefileLimits["robots"] = {
      outcome: "read",
      isAllowed: (url) => !url.endsWith("/drop/1"),
      matchingRule: (url) => (url.endsWith("/drop/1") ? "Disallow: /drop/\u00001" : null),
    };
    const result = await refileOutOfScope(db, id, { exclude: [], include: [] }, limits(10, { robots }));
    expect(result.reblocked).toBe(1);
    const [row] = await db
      .select({ fetchClass: pages.fetchClass, fetchReason: pages.fetchReason })
      .from(pages)
      .where(and(eq(pages.crawlId, id), eq(pages.url, "https://refile.example/drop/1")));
    expect(row).toEqual({ fetchClass: "disallowed", fetchReason: "robots.txt: Disallow: /drop/␀1" });
  });
});

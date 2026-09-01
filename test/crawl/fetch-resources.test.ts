/**
 * The resource fetch pass, driven against real HTTP servers.
 *
 * Everything here is end-to-end from the `resources` table outwards: rows are
 * seeded exactly as `PageWriter` leaves them (fetch_class null, "seen, not yet
 * asked"), the pass is handed the SAME `HostGate` the page crawl used, and the
 * assertions are the rows it wrote plus the request log the servers kept. The
 * request log is the politeness evidence — a test that only read the rows could
 * not tell one HEAD from a HEAD and a GET, and could not see a resource that was
 * refused being fetched anyway.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, resources } from "../../src/db/schema.js";
import { HostGate } from "../../src/crawl/politeness.js";
import { runCrawl } from "../../src/crawl/loop.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import type { RobotsInfo } from "../../src/crawl/discovery.js";
import {
  fetchCrawlResources,
  RESOURCE_CAP_REASON,
  type ResourcePassSummary,
} from "../../src/crawl/resources/fetch-resources.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;

/** One line per request a fixture server answered. */
interface Hit {
  method: string;
  path: string;
  at: number;
}

interface AssetServer {
  base: string;
  host: string;
  hits: Hit[];
  close(): Promise<void>;
}

/**
 * The origin's asset server: one file of every shape the pass has to tell
 * apart.
 *
 * `/no-length.css` answers a HEAD with no `content-length` (a chunked
 * response), which is the only honest way to make a server that cannot say how
 * big a file is; `/head-405.js` refuses HEAD outright, which several CDNs and
 * most naive frameworks do.
 */
const BIG_BYTES = 2 * 1024 * 1024 + 7;

/**
 * The third-party image the origin's one HTML page carries, filled in once the
 * plain third-party host is listening (its port is not known before that). Read
 * at request time, so the ordering is the servers' start order and not a
 * module-load race.
 */
let crawlHostImage = "";

async function startAssetServer(): Promise<AssetServer> {
  const hits: Hit[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push({ method: req.method ?? "?", path, at: Date.now() });
    const head = req.method === "HEAD";

    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/") {
      // The one HTML page on this server: what the crawl-wiring case crawls.
      // It references three files of its own and one on a third-party host.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><title>Assets</title>` +
          `<link rel="stylesheet" href="/b.css"></head><body><h1>Assets</h1>` +
          `<img src="/a.png" alt="a" width="10" height="10">` +
          `<img src="${crawlHostImage}" alt="badge" width="10" height="10">` +
          `<script src="/head-405.js"></script></body></html>`,
      );
      return;
    }
    if (path === "/a.png") {
      const body = Buffer.alloc(1234, 7);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(body.length),
        "cache-control": "public, max-age=600",
        expires: "Wed, 21 Oct 2026 07:28:00 GMT",
      });
      res.end(head ? undefined : body);
      return;
    }
    if (path === "/b.css") {
      const body = Buffer.from("body{color:red}");
      res.writeHead(200, {
        "content-type": "text/css",
        "content-length": String(body.length),
      });
      res.end(head ? undefined : body);
      return;
    }
    if (path === "/no-length.css") {
      // No content-length, no cache headers: the HEAD cannot answer the size
      // question, so the pass must spend one GET counting the body.
      res.writeHead(200, { "content-type": "text/css" });
      if (head) {
        res.end();
        return;
      }
      res.end("a".repeat(4096));
      return;
    }
    if (path === "/head-405.js") {
      if (head) {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      const body = Buffer.from("console.log(1)");
      res.writeHead(200, {
        "content-type": "application/javascript",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }
    if (path === "/big.png") {
      // Larger than fetch-page's 1MiB body cap, chunked, so a counted GET that
      // buffered or capped would report the wrong number.
      res.writeHead(200, { "content-type": "image/png" });
      if (head) {
        res.end();
        return;
      }
      const chunk = Buffer.alloc(64 * 1024, 3);
      let written = 0;
      while (written + chunk.length <= BIG_BYTES) {
        res.write(chunk);
        written += chunk.length;
      }
      res.end(Buffer.alloc(BIG_BYTES - written, 3));
      return;
    }
    if (path === "/missing.png") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(head ? undefined : "no");
      return;
    }
    if (path === "/boom.png") {
      res.writeHead(500, { "content-type": "text/html" });
      res.end(head ? undefined : "no");
      return;
    }
    if (path === "/hop.png") {
      res.writeHead(302, { location: "/a.png" });
      res.end();
      return;
    }
    if (path === "/hop-to-metadata.png") {
      // The hop a page cannot see and the policy must: an ordinary-looking
      // asset URL whose Location points at the metadata service.
      res.writeHead(302, { location: "http://169.254.169.254/pixel.png" });
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(head ? undefined : "?");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    host: `127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

/**
 * A third-party asset host: a different origin (a different port is a different
 * `host`, which is what the gate, the robots cache and the host census all key
 * on). `robotsBody` is its own robots.txt — the rules of ITS host, which are not
 * the crawl's.
 */
async function startThirdPartyHost(robotsBody: string): Promise<AssetServer> {
  const hits: Hit[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push({ method: req.method ?? "?", path, at: Date.now() });
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(robotsBody);
      return;
    }
    const body = Buffer.alloc(99, 1);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(body.length),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    host: `127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

/** A host that resets every connection: the dead host of behaviour 6. */
async function startDeadHost(): Promise<AssetServer> {
  const hits: Hit[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method ?? "?", path: req.url ?? "/", at: Date.now() });
    res.socket?.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    host: `127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

let assets: AssetServer;
/** Disallows `/nope/`, and asks for a second between requests. */
let third: AssetServer;
/** A second third-party host with no rules of its own beyond allow-all. */
let plain: AssetServer;
let dead: AssetServer;

/** An allow-all robots stand-in for the crawl origin, as `discover` returns. */
function allowAllRobots(): RobotsInfo {
  return {
    fetched: true,
    outcome: "read",
    status: 200,
    attempts: 1,
    isAllowed: () => true,
    crawlDelaySec: null,
    sitemapUrls: [],
    raw: "User-agent: *\nAllow: /\n",
    truncated: false,
    note: null,
  };
}

async function seedCrawl(siteUrl: string): Promise<string> {
  const crawlId = `crawl_res_${randomUUID()}`;
  await db.insert(crawls).values({
    id: crawlId,
    siteUrl,
    config: { siteUrl },
    rulesetVersion: "0.7.0",
    status: "finished",
  });
  return crawlId;
}

async function seedResources(
  crawlId: string,
  refs: { url: string; kind?: string }[],
): Promise<void> {
  await db
    .insert(resources)
    .values(refs.map((ref) => ({ crawlId, url: ref.url, kind: ref.kind ?? "image" })));
}

async function rowsOf(crawlId: string) {
  return db
    .select()
    .from(resources)
    .where(eq(resources.crawlId, crawlId))
    .orderBy(resources.url);
}

async function rowFor(crawlId: string, url: string) {
  const rows = await db
    .select()
    .from(resources)
    .where(and(eq(resources.crawlId, crawlId), eq(resources.url, url)));
  const row = rows[0];
  if (row === undefined) throw new Error(`no resources row for ${url}`);
  return row;
}

/** The pass, with the arguments every case shares. */
async function runPass(
  crawlId: string,
  siteUrl: string,
  overrides: Partial<Parameters<typeof fetchCrawlResources>[2]> = {},
): Promise<ResourcePassSummary> {
  return fetchCrawlResources(db, crawlId, {
    siteUrl,
    userAgent: "AriadneBot-resource-test",
    gate: new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null }),
    originRobots: allowAllRobots(),
    allowPrivate: true,
    maxConcurrency: 4,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function hitsFor(server: AssetServer, path: string): Hit[] {
  return server.hits.filter((hit) => hit.path === path);
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  assets = await startAssetServer();
  third = await startThirdPartyHost("User-agent: *\nDisallow: /nope/\nCrawl-delay: 1\n");
  plain = await startThirdPartyHost("User-agent: *\nAllow: /\n");
  crawlHostImage = `${plain.base}/badge.png`;
  dead = await startDeadHost();
}, 60_000);

afterAll(async () => {
  await assets.close();
  await third.close();
  await plain.close();
  await dead.close();
  await closeFetchAgents();
  await closeDb(db);
});

beforeEach(() => {
  assets.hits.length = 0;
  third.hits.length = 0;
  plain.hits.length = 0;
  dead.hits.length = 0;
});

// ---------------------------------------------------------------------------
// 1. url-policy on every URL, before any network (hard rule 5)
// ---------------------------------------------------------------------------

describe("the URL policy runs on read, not on write", () => {
  it("refuses a reserved address and a non-http scheme without asking anyone", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      // The metadata service: refused even under allowPrivate, which is the
      // floor the test-only hatch cannot lift.
      { url: "http://169.254.169.254/pixel.png" },
      // `resources.url` is stored unvetted — the analyzer drops these, but the
      // column is not the analyzer's promise, and the pass is the one place the
      // policy can be the wall it claims to be.
      { url: "ftp://example.com/logo.png" },
      { url: `${assets.base}/a.png` },
    ]);

    const summary = await runPass(crawlId, assets.base);

    const metadata = await rowFor(crawlId, "http://169.254.169.254/pixel.png");
    expect(metadata.fetchClass).toBe("refused");
    expect(metadata.fetchReason).toContain("169.254.169.254");
    expect(metadata.statusCode).toBeNull();

    const scheme = await rowFor(crawlId, "ftp://example.com/logo.png");
    expect(scheme.fetchClass).toBe("refused");
    expect(scheme.fetchReason).toContain("scheme");

    // The one legitimate URL still got its fetch: a refusal is per row.
    expect((await rowFor(crawlId, `${assets.base}/a.png`)).fetchClass).toBe("ok");
    expect(summary.failed).toBe(2);
    expect(summary.fetched).toBe(1);
  });

  it("refuses a redirect hop into reserved space", async () => {
    const crawlId = await seedCrawl(assets.base);
    const url = `${assets.base}/hop-to-metadata.png`;
    await seedResources(crawlId, [{ url }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, url);
    // The URL as written was fine; the hop was not. Every hop is revalidated,
    // which is the only reading of hard rule 5 that survives a redirect.
    expect(row.fetchClass).toBe("refused");
    expect(row.fetchReason).toContain("169.254.169.254");
    // And the row still says where the refusal happened: on the hop, not on
    // the URL the page wrote.
    expect(row.fetchReason).toContain("followed 1 redirect");
  });
});

// ---------------------------------------------------------------------------
// 2. HEAD first; one counted GET when HEAD cannot answer
// ---------------------------------------------------------------------------

describe("HEAD first, and exactly one GET when it must", () => {
  it("takes the size from content-length and issues no GET", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/a.png` }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, `${assets.base}/a.png`);
    expect(row.fetchClass).toBe("ok");
    expect(row.statusCode).toBe(200);
    expect(row.bytes).toBe(1234);
    expect(row.bytesSource).toBe("header");
    expect(row.contentType).toContain("image/png");
    expect(row.cacheControl).toBe("public, max-age=600");
    expect(row.expires).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(row.fetchedAt).not.toBeNull();
    expect(row.fetchMs).not.toBeNull();

    expect(hitsFor(assets, "/a.png").map((hit) => hit.method)).toEqual(["HEAD"]);
  });

  it("counts a body the HEAD could not size, and says the bytes were counted", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/no-length.css`, kind: "css" }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, `${assets.base}/no-length.css`);
    expect(row.fetchClass).toBe("ok");
    expect(row.bytes).toBe(4096);
    expect(row.bytesSource).toBe("counted");
    expect(hitsFor(assets, "/no-length.css").map((hit) => hit.method)).toEqual([
      "HEAD",
      "GET",
    ]);
  });

  it("falls back to one GET when the server refuses HEAD", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/head-405.js`, kind: "js" }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, `${assets.base}/head-405.js`);
    expect(row.fetchClass).toBe("ok");
    expect(row.statusCode).toBe(200);
    expect(row.bytes).toBe("console.log(1)".length);
    expect(row.bytesSource).toBe("counted");
    expect(hitsFor(assets, "/head-405.js").map((hit) => hit.method)).toEqual([
      "HEAD",
      "GET",
    ]);
  });

  it("counts a body far larger than the page reader's cap without holding it", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/big.png` }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, `${assets.base}/big.png`);
    // 2MiB+7: a reader that buffered would have hit fetch-page's 1MiB cap and
    // reported that number instead.
    expect(row.bytes).toBe(BIG_BYTES);
    expect(row.bytesSource).toBe("counted");
  });

  it("classifies a 404 and a 500 with the page vocabulary", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/missing.png` },
      { url: `${assets.base}/boom.png` },
    ]);

    const summary = await runPass(crawlId, assets.base);

    expect((await rowFor(crawlId, `${assets.base}/missing.png`)).fetchClass).toBe(
      "client_error",
    );
    expect((await rowFor(crawlId, `${assets.base}/boom.png`)).fetchClass).toBe(
      "server_error",
    );
    expect(summary.failed).toBe(2);
    expect(summary.fetched).toBe(0);
  });

  it("follows a redirect and records the file it landed on", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/hop.png` }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, `${assets.base}/hop.png`);
    expect(row.fetchClass).toBe("ok");
    expect(row.bytes).toBe(1234);
    expect(row.fetchReason).toContain("/a.png");
    expect(hitsFor(assets, "/hop.png").map((hit) => hit.method)).toEqual(["HEAD"]);
    expect(hitsFor(assets, "/a.png").map((hit) => hit.method)).toEqual(["HEAD"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-host queues at the crawl's spacing, and the ratchet the pages earned
// ---------------------------------------------------------------------------

describe("per-host spacing, shared with the page crawl", () => {
  it("spaces one host's requests and lets a second host run alongside", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/a.png` },
      { url: `${assets.base}/b.css`, kind: "css" },
      { url: `${plain.base}/one.png` },
      { url: `${plain.base}/two.png` },
    ]);

    const gate = new HostGate({ perHostDelayMs: 120, robotsCrawlDelaySec: null });
    const startedAt = Date.now();
    await runPass(crawlId, assets.base, { gate });
    const elapsed = Date.now() - startedAt;

    const originHits = assets.hits.filter((hit) => hit.path !== "/robots.txt");
    expect(originHits.length).toBe(2);
    expect(originHits[1]!.at - originHits[0]!.at).toBeGreaterThanOrEqual(100);
    const plainAssets = plain.hits.filter((hit) => hit.path !== "/robots.txt");
    expect(plainAssets.length).toBe(2);
    expect(plainAssets[1]!.at - plainAssets[0]!.at).toBeGreaterThanOrEqual(100);

    // Two hosts, each on its own queue: the origin spends two spacings and the
    // third-party host three (its robots.txt takes a slot too). One shared
    // queue would be five, serialised — a crawl that grew resource fetching
    // and got slower for every host at once.
    expect(elapsed).toBeLessThan(120 * 5);
  });

  it("keeps the spacing a host earned during the page crawl", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/a.png` },
      { url: `${assets.base}/b.css`, kind: "css" },
    ]);

    const gate = new HostGate({ perHostDelayMs: 60, robotsCrawlDelaySec: null });
    // What the page crawl would have done on a 429: the host's spacing doubles,
    // and the ratchet never winds back inside a crawl.
    gate.report(assets.host, {
      fetchClass: "blocked",
      statusCode: 429,
      retryAfterMs: null,
      url: `${assets.base}/some-page`,
    });
    expect(gate.spacingMs(assets.host)).toBe(120);

    await runPass(crawlId, assets.base, { gate });

    const originHits = assets.hits.filter((hit) => hit.path !== "/robots.txt");
    expect(originHits.length).toBe(2);
    expect(originHits[1]!.at - originHits[0]!.at).toBeGreaterThanOrEqual(100);
  });

  it("honours a third-party host's own crawl-delay as a floor on that host", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${third.base}/one.png` }]);

    const gate = new HostGate({ perHostDelayMs: 10, robotsCrawlDelaySec: null });
    await runPass(crawlId, assets.base, { gate });

    // The CDN asked for a second between requests; the crawl was configured for
    // 10ms. The site's number wins on the site's host, and only there.
    expect(gate.spacingMs(third.host)).toBe(1000);
    expect(gate.spacingMs(assets.host)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 4. robots.txt per host
// ---------------------------------------------------------------------------

describe("robots.txt, per host, fetched once", () => {
  it("refuses a disallowed third-party asset and never requests it", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${third.base}/nope/secret.png` },
      { url: `${third.base}/one.png` },
      { url: `${third.base}/two.png` },
    ]);

    const summary = await runPass(crawlId, assets.base);

    const denied = await rowFor(crawlId, `${third.base}/nope/secret.png`);
    expect(denied.fetchClass).toBe("robots_denied");
    expect(denied.fetchReason).toContain("robots.txt");
    expect(hitsFor(third, "/nope/secret.png")).toEqual([]);

    // One robots.txt for the host, not one per resource.
    expect(hitsFor(third, "/robots.txt").length).toBe(1);
    expect(summary.fetched).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("uses the crawl origin's already-loaded robots and asks it for nothing", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/a.png` }]);

    await runPass(crawlId, assets.base, {
      originRobots: {
        ...allowAllRobots(),
        isAllowed: (url: string) => !url.includes("/a.png"),
      },
    });

    const row = await rowFor(crawlId, `${assets.base}/a.png`);
    expect(row.fetchClass).toBe("robots_denied");
    // The origin's robots.txt was read by discovery; the pass must not re-read it.
    expect(hitsFor(assets, "/robots.txt")).toEqual([]);
    expect(hitsFor(assets, "/a.png")).toEqual([]);
  });

  it("treats an unreachable third-party robots.txt as a complete disallow", async () => {
    const crawlId = await seedCrawl(assets.base);
    const url = `${dead.base}/one.png`;
    await seedResources(crawlId, [{ url }]);

    await runPass(crawlId, assets.base, { robotsRetryBackoffMs: 1 });

    const row = await rowFor(crawlId, url);
    expect(row.fetchClass).toBe("robots_denied");
    expect(row.fetchReason).toContain("unreachable");
    // Nothing but robots.txt was ever asked for.
    expect(dead.hits.every((hit) => hit.path === "/robots.txt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The caps, loudly
// ---------------------------------------------------------------------------

describe("the caps say so", () => {
  it("stops at maxResources and marks the rest resource-cap", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/a.png` },
      { url: `${assets.base}/b.css`, kind: "css" },
      { url: `${assets.base}/c.png` },
      { url: `${assets.base}/d.png` },
    ]);

    const summary = await runPass(crawlId, assets.base, { maxResources: 2 });

    expect(summary.seen).toBe(4);
    expect(summary.skipped).toBe(2);
    expect(summary.cappedByResources).toBe(true);

    const rows = await rowsOf(crawlId);
    const capped = rows.filter((row) => row.fetchReason === RESOURCE_CAP_REASON);
    expect(capped.length).toBe(2);
    // A capped row is UNFETCHED, not failed: the null still means "seen, not
    // yet asked", and the reason says who stopped short of asking.
    expect(capped.every((row) => row.fetchClass === null)).toBe(true);
    expect(assets.hits.filter((hit) => hit.method === "HEAD").length).toBe(2);
  });

  it("stops at maxResourceHosts and never touches the host it refused", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/a.png` },
      { url: `${third.base}/one.png` },
    ]);

    const summary = await runPass(crawlId, assets.base, { maxResourceHosts: 1 });

    expect(summary.cappedByHosts).toBe(true);
    expect(summary.hosts).toBe(1);

    // WHICH host wins is the work list's order, which is URL order, which on a
    // loopback fixture is port order — so the assertion is about the shape and
    // not about which of the two servers happened to sort first.
    const rows = await rowsOf(crawlId);
    const capped = rows.filter((row) => row.fetchReason === RESOURCE_CAP_REASON);
    expect(capped.length).toBe(1);
    expect(capped[0]!.fetchClass).toBeNull();
    expect(rows.filter((row) => row.fetchClass === "ok").length).toBe(1);
    // Not even its robots.txt: a host over the cap is a host we do not talk to.
    const refusedHost = new URL(capped[0]!.url).host;
    const silent = refusedHost === assets.host ? assets : third;
    expect(silent.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. A dead host is parked, not retried for ever
// ---------------------------------------------------------------------------

describe("a dead host is parked", () => {
  it("stops asking after three consecutive fetch errors", async () => {
    const crawlId = await seedCrawl(dead.base);
    await seedResources(
      crawlId,
      Array.from({ length: 6 }, (_, i) => ({ url: `${dead.base}/${i}.png` })),
    );

    // The dead host is the crawl ORIGIN here, so its robots comes from
    // discovery and the pass spends every request on the resources themselves.
    //
    // One worker, deliberately: "three consecutive errors" is a statement about
    // settled fetches, and N workers can have N requests in flight when the
    // third settles. The pass re-checks the park after acquiring the host's
    // slot, so the overshoot is bounded by the workers on that host — but a
    // test that asserted an exact count under concurrency would be asserting a
    // race.
    const summary = await runPass(crawlId, dead.base, { maxConcurrency: 1 });

    expect(dead.hits.length).toBe(3);
    const rows = await rowsOf(crawlId);
    expect(rows.every((row) => row.fetchClass === "fetch_error")).toBe(true);
    const parked = rows.filter((row) => (row.fetchReason ?? "").includes("parked"));
    expect(parked.length).toBe(3);
    expect(summary.failed).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Resumable the frontier's way: an interrupted pass leaves nulls
// ---------------------------------------------------------------------------

describe("the pass is resumable, and asks only nulls", () => {
  it("re-running it asks nothing and changes nothing", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/a.png` },
      { url: `${assets.base}/b.css`, kind: "css" },
    ]);

    const first = await runPass(crawlId, assets.base);
    expect(first.fetched).toBe(2);
    const before = await rowsOf(crawlId);
    assets.hits.length = 0;

    const second = await runPass(crawlId, assets.base);
    expect(second.fetched).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.skipped).toBe(0);
    expect(assets.hits).toEqual([]);
    expect(await rowsOf(crawlId)).toEqual(before);
  });

  it("picks up exactly the rows an interrupted pass left null", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/a.png` },
      { url: `${assets.base}/b.css`, kind: "css" },
    ]);
    // What an interruption leaves: one row asked, one row not.
    await db
      .update(resources)
      .set({ fetchClass: "ok", statusCode: 200, bytes: 11, bytesSource: "header" })
      .where(and(eq(resources.crawlId, crawlId), eq(resources.url, `${assets.base}/a.png`)));

    const summary = await runPass(crawlId, assets.base);

    expect(summary.fetched).toBe(1);
    expect(assets.hits.map((hit) => hit.path)).toEqual(["/b.css"]);
    // The row the first run wrote is untouched.
    expect((await rowFor(crawlId, `${assets.base}/a.png`)).bytes).toBe(11);
  });

  it("re-asks a row a cap left unfetched when the cap is lifted", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/a.png` },
      { url: `${assets.base}/b.css`, kind: "css" },
    ]);

    const capped = await runPass(crawlId, assets.base, { maxResources: 1 });
    expect(capped.skipped).toBe(1);

    const second = await runPass(crawlId, assets.base);
    expect(second.fetched).toBe(1);
    const rows = await rowsOf(crawlId);
    expect(rows.every((row) => row.fetchClass === "ok")).toBe(true);
    expect(rows.every((row) => row.fetchReason === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The crawl loop's wiring: after the pages, before the row closes
// ---------------------------------------------------------------------------

describe("the crawl runs the pass itself", () => {
  it("fetches a crawled page's resources before the crawl row is closed", async () => {
    const summary = await runCrawl(db, {
      siteUrl: assets.base,
      maxPages: 5,
      maxDepth: 2,
      userAgent: "AriadneBot-resource-test",
      perHostDelayMs: 0,
      maxConcurrency: 2,
      // Four chains of host-variant probing prove nothing here and cost four
      // more requests at a server this test is counting requests to.
      probeHosts: false,
      allowPrivate: true,
    });

    expect(summary.status).toBe("finished");
    const pass = summary.resources;
    if (pass === null) throw new Error("the crawl reported no resource pass");
    // The page's four references: three of its own and the third-party badge.
    expect(pass.seen).toBe(4);
    expect(pass.fetched).toBe(4);
    expect(pass.skipped).toBe(0);
    expect(pass.hosts).toBe(2);

    const rows = await rowsOf(summary.crawlId);
    expect(rows.map((row) => row.kind).sort()).toEqual(["css", "image", "image", "js"]);
    expect(rows.every((row) => row.fetchClass === "ok")).toBe(true);

    // THE ORDER, asserted rather than asserted-in-a-comment: every resource was
    // fetched while the crawl was still running. A pass that ran after
    // `closeCrawl` would be work happening on someone's server after the record
    // said the crawl had finished.
    const crawlRow = (await db.select().from(crawls).where(eq(crawls.id, summary.crawlId)))[0];
    if (crawlRow === undefined) throw new Error("the crawl row vanished");
    const finishedAt = crawlRow.finishedAt;
    if (finishedAt === null) throw new Error("a finished crawl with no finishedAt");
    for (const row of rows) {
      expect(row.fetchedAt).not.toBeNull();
      expect(row.fetchedAt!.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
    }
  });

  it("does not ask a single server anything once the crawl is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const summary = await runCrawl(
      db,
      {
        siteUrl: assets.base,
        maxPages: 5,
        maxDepth: 2,
        userAgent: "AriadneBot-resource-test",
        perHostDelayMs: 0,
        maxConcurrency: 2,
        probeHosts: false,
        allowPrivate: true,
      },
      controller.signal,
    );

    expect(summary.status).toBe("cancelled");
    // Null is "the pass did not run", which is not "there were no resources" —
    // an abort means stop asking servers for things, and this pass is all
    // asking. The nulls it left are the resume's work list.
    expect(summary.resources).toBeNull();
  });
});

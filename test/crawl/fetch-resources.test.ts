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
import { ApiService } from "../../src/api/service.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pageResources, resources } from "../../src/db/schema.js";
import { HostGate } from "../../src/crawl/politeness.js";
import { runCrawl } from "../../src/crawl/loop.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import type { RobotsInfo } from "../../src/crawl/discovery.js";
import {
  fetchCrawlResources,
  RESOURCE_CAP_REASON,
  RESOURCE_FETCH_CLASSES,
  RESOURCE_OFF_REASON,
  RESOURCE_ROBOTS_DENIED_CLASS,
  RESOURCE_ROBOTS_UNREACHABLE_CLASS,
  type ResourcePassSummary,
} from "../../src/crawl/resources/fetch-resources.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

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

/**
 * Requests in flight across EVERY fixture server, and the high-water mark. The
 * pass's worker count is not observable from a row, so the servers count it:
 * `/slow.png` holds its response open, and two hosts holding one each at the
 * same moment is a pass running two workers.
 */
let inFlight = 0;
let maxInFlight = 0;

/** How long `/slow.png` holds a response open. */
const SLOW_MS = 60;

/**
 * Called with the path of every request the ORIGIN asset server answers. The
 * abort cases use it to fire a signal from inside the pass, which is the only
 * way to cancel at a known moment rather than at a hoped-for one.
 */
let onAssetHit: ((path: string) => void) | null = null;

/** `/slow.png`, on any of the servers: held open, counted, then answered. */
function serveSlow(req: IncomingMessage, res: ServerResponse): void {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  setTimeout(() => {
    inFlight -= 1;
    const body = Buffer.alloc(64, 5);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(body.length),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }, SLOW_MS);
}

async function startAssetServer(): Promise<AssetServer> {
  const hits: Hit[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push({ method: req.method ?? "?", path, at: Date.now() });
    const head = req.method === "HEAD";
    onAssetHit?.(path);

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
    if (path === "/slow.png") {
      serveSlow(req, res);
      return;
    }
    if (path === "/window" || path === "/abort") {
      // Two pages for the two wiring cases. `/window` sends the crawl at a pair
      // of 503s (which collapse the concurrency window) and points at a slow
      // asset on each of two hosts; `/abort` points at two assets on this one.
      const refs =
        path === "/window"
          ? `<a href="/boom-a">a</a><a href="/boom-b">b</a>` +
            `<img src="/slow.png" alt="s" width="10" height="10">` +
            `<img src="${plain.base}/slow.png" alt="t" width="10" height="10">`
          : `<img src="/abort-1.png" alt="1" width="10" height="10">` +
            `<img src="/abort-2.png" alt="2" width="10" height="10">`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><title>t</title></head>` +
          `<body><h1>t</h1>${refs}</body></html>`,
      );
      return;
    }
    if (path === "/boom-a" || path === "/boom-b") {
      // A bare 503: back-pressure to the window, and not enough of a streak to
      // escalate the host's spacing (see HostGate.report).
      res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
      res.end(head ? undefined : "<!doctype html><title>503</title><p>later</p>");
      return;
    }
    if (path === "/abort-1.png" || path === "/abort-2.png") {
      const body = Buffer.alloc(12, 9);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(body.length),
      });
      res.end(head ? undefined : body);
      return;
    }
    // A chain of servers that refuse HEAD and answer GET with a redirect: two
    // requests per URL, so the per-row request budget runs out before the
    // redirect cap does.
    const loop405 = /^\/loop405-(\d+)\.png$/.exec(path);
    if (loop405 !== null) {
      if (head) {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      res.writeHead(302, { location: `/loop405-${Number(loop405[1]) + 1}.png` });
      res.end();
      return;
    }
    // A plain redirect chain, deeper than MAX_RESOURCE_REDIRECTS.
    const chain = /^\/chain-(\d+)\.png$/.exec(path);
    if (chain !== null) {
      res.writeHead(302, { location: `/chain-${Number(chain[1]) + 1}.png` });
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
    if (path === "/slow.png") {
      serveSlow(req, res);
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
    matchingRule: () => null,
    crawlDelaySec: null,
    sitemapUrls: [],
    raw: "User-agent: *\nAllow: /\n",
    truncated: false,
    note: null,
  };
}

/**
 * Every crawl row this file creates, deleted in `afterAll`.
 *
 * THE FILE OWNS ITS ROWS (P13-T1). Until this list existed, this was the ONLY
 * file in the suite that created crawl rows and never deleted them, and it was
 * the whole of the leak the Phase 12 gate measured at 33 rows a full run
 * (`docs/gates/phase-12.md` §10.6, §11) — 28 seeded rows and 5 the crawl loop
 * created, once each. Nothing here is deleted by matching a pattern: a teardown
 * that swept `site_url like '127.0.0.1%'` would be a cleanup that decides for
 * itself what belongs to it, which is the shape hard rule 7 forbids.
 */
const createdCrawls: string[] = [];

async function seedCrawl(siteUrl: string): Promise<string> {
  const crawlId = `crawl_res_${randomUUID()}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id: crawlId,
    siteUrl,
    config: { siteUrl },
    rulesetVersion: "0.7.0",
    status: "finished",
  });
  createdCrawls.push(crawlId);
  return crawlId;
}

/**
 * `runCrawl`, with the row it creates tracked — the loop names its own crawl,
 * so the id is only knowable from the summary it returns (the same wrapper
 * `test/crawl/loop.test.ts` uses, for the same reason).
 */
async function crawl(
  config: Parameters<typeof runCrawl>[2],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof runCrawl>>> {
  const summary = await runCrawl(db, LOCAL_TENANT, config, signal);
  createdCrawls.push(summary.crawlId);
  return summary;
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
  // Every child row cascades off the crawl id, so one delete per crawl is the
  // whole teardown. Deleting by id and nothing else: see `createdCrawls`.
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
});

beforeEach(() => {
  assets.hits.length = 0;
  third.hits.length = 0;
  plain.hits.length = 0;
  dead.hits.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  onAssetHit = null;
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

  it("stops counting at the byte ceiling and says the number is a floor", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/big.png` }]);

    // The production ceiling is 16MiB and streaming that through a fixture
    // server to prove one branch would be the only slow test in the file.
    await runPass(crawlId, assets.base, { maxCountedBytes: 4096 });

    const row = await rowFor(crawlId, `${assets.base}/big.png`);
    expect(row.fetchClass).toBe("ok");
    expect(row.bytesSource).toBe("counted");
    // Whatever had arrived when the socket was destroyed: at least the ceiling,
    // nowhere near the file.
    expect(row.bytes).toBeGreaterThan(4096);
    expect(row.bytes).toBeLessThan(BIG_BYTES);
    expect(row.fetchReason).toBe("body exceeded the 4096-byte counting cap; bytes is a floor");
  });

  it("spends a bounded number of requests on one row, however the server behaves", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/loop405-1.png`, kind: "js" }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, `${assets.base}/loop405-1.png`);
    expect(row.fetchClass).toBe("fetch_error");
    expect(row.fetchReason).toContain("7-request budget");
    // Two requests per URL (a refused HEAD and a redirecting GET), stopped at
    // seven — three-and-a-half URLs, not an unbounded conversation.
    expect(assets.hits.filter((hit) => hit.path.startsWith("/loop405-")).length).toBe(7);
  });

  it("gives up on a redirect chain deeper than the hop limit", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [{ url: `${assets.base}/chain-1.png` }]);

    await runPass(crawlId, assets.base);

    const row = await rowFor(crawlId, `${assets.base}/chain-1.png`);
    expect(row.fetchClass).toBe("fetch_error");
    expect(row.fetchReason).toContain("more than 5 redirects");
    // Six HEADs: the hop that exceeded the limit is counted, not taken.
    expect(assets.hits.filter((hit) => hit.path.startsWith("/chain-")).length).toBe(6);
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
    // The EXACT string, not a substring: a reason built by concatenating an
    // empty first half is how a row ends up saying "; followed 1 redirect…",
    // which reads like a message with its first clause lost.
    expect(row.fetchReason).toBe(`followed 1 redirect to ${assets.base}/a.png`);
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

describe("the worker count it was given is the worker count it runs", () => {
  it("holds one request open at a time when told one", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/slow.png` },
      { url: `${plain.base}/slow.png` },
    ]);

    await runPass(crawlId, assets.base, { maxConcurrency: 1 });

    // Two different hosts, so per-host spacing serialises nothing here: one in
    // flight at a time is the WORKER count and nothing else.
    expect(maxInFlight).toBe(1);
  });

  it("runs both hosts at once when told more", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/slow.png` },
      { url: `${plain.base}/slow.png` },
    ]);

    await runPass(crawlId, assets.base, { maxConcurrency: 4 });

    expect(maxInFlight).toBe(2);
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

  /**
   * THE SPLIT (P12-T1). An unreachable robots.txt is a complete disallow
   * (RFC 9309 §2.3.1.4), so the BEHAVIOUR is identical to a forbidding one: no
   * request is made. What is not identical is the SENTENCE — "they said no" and
   * "we could not ask" are different facts about a client's site, and until this
   * task both landed in `robots_denied` with only the prose reason to tell them
   * apart. Phase 11 refused to split them by matching that prose (a reworded
   * error string would zero the count silently) and ledgered the fix:
   * `RobotsInfo.outcome` is a CLOSED VOCABULARY already in hand at the deny
   * site, so the class comes off the discriminant (phase-11.md §10.2).
   */
  it("classes an unreachable third-party robots.txt apart from a forbidding one", async () => {
    const crawlId = await seedCrawl(assets.base);
    const url = `${dead.base}/one.png`;
    await seedResources(crawlId, [{ url }]);

    await runPass(crawlId, assets.base, { robotsRetryBackoffMs: 1 });

    const row = await rowFor(crawlId, url);
    expect(row.fetchClass).toBe(RESOURCE_ROBOTS_UNREACHABLE_CLASS);
    expect(row.fetchClass).not.toBe(RESOURCE_ROBOTS_DENIED_CLASS);
    // The reason is unchanged and still per-row: the class is a second, cheaper
    // way to ask the same question, never a replacement for the sentence.
    expect(row.fetchReason).toContain("unreachable");
    // The disallow is still complete — nothing but robots.txt was ever asked
    // for. A new class must not become a new permission.
    expect(dead.hits.every((hit) => hit.path === "/robots.txt")).toBe(true);
  });

  it("keeps `robots_denied` for a file the robots file actually forbade", async () => {
    const crawlId = await seedCrawl(assets.base);
    const forbidden = `${third.base}/nope/secret.png`;
    const unreachable = `${dead.base}/two.png`;
    await seedResources(crawlId, [{ url: forbidden }, { url: unreachable }]);

    await runPass(crawlId, assets.base, { robotsRetryBackoffMs: 1 });

    // Both are refusals and both count as `failed`; the two rows say WHICH
    // refusal, which is the whole point of the split.
    expect((await rowFor(crawlId, forbidden)).fetchClass).toBe(RESOURCE_ROBOTS_DENIED_CLASS);
    expect((await rowFor(crawlId, unreachable)).fetchClass).toBe(
      RESOURCE_ROBOTS_UNREACHABLE_CLASS,
    );
  });

  /**
   * THE CHAIN, END TO END (P13-T1, retiring `docs/gates/phase-12.md` §2.2's
   * ledgered seam).
   *
   * Until this case, the two halves of the split were proved on two different
   * crawls: the cases above show the PASS writes the two classes, and the
   * partition tests in `test/api/query.test.ts` and `test/api/mcp.test.ts` show
   * the SURFACE serves them — off rows a fixture inserted by hand. Nothing
   * carried a real pass through to a served number, so the Phase 12 gate made
   * that join itself, by reading `crawl_status` off a crawl §2.1's pass had
   * produced and printing the block into the document. A join made by a human
   * once is not a join the suite keeps making.
   *
   * So: one crawl, the real pass against the two robots hosts plus one file on
   * each side of the `ok` / `failed` line, and then the served block read back
   * through `ApiService.getCrawl` — which is exactly what the `crawl_status`
   * tool and `GET /crawls/:id` return.
   *
   * The fourth resource is why the two robots counts are proved to be SUBSETS
   * rather than the whole of `failed`: with only the two robots rows, `failed`
   * and `robotsDenied + robotsUnreachable` are the same number and a surface
   * that had confused the two would still pass.
   */
  it("serves the two robots counts off a crawl the real pass produced", async () => {
    const crawlId = await seedCrawl(assets.base);
    const forbidden = `${third.base}/nope/secret.png`;
    const unreachable = `${dead.base}/served.png`;
    await seedResources(crawlId, [
      { url: forbidden },
      { url: unreachable },
      { url: `${assets.base}/missing.png` },
      { url: `${assets.base}/a.png` },
    ]);

    const summary = await runPass(crawlId, assets.base, { robotsRetryBackoffMs: 1 });
    expect(summary.aborted).toBe(false);

    const service = new ApiService(db, { allowedDomains: ["127.0.0.1"], log: () => {} });
    try {
      const detail = await service.getCrawl(LOCAL_TENANT, crawlId);
      const census = detail.resources;

      // The two facts, side by side, on a crawl nothing seeded a `fetch_class`
      // onto: every class in this block was written by the pass.
      expect(census.robotsDenied).toBe(1);
      expect(census.robotsUnreachable).toBe(1);

      // The partition the block promises, on the same read.
      expect(census.seen).toBe(4);
      expect(census.fetched).toBe(1);
      expect(census.failed).toBe(3);
      expect(census.skipped).toBe(0);
      expect(census.fetched + census.failed + census.skipped).toBe(census.seen);
      expect(census.capped).toBe(false);

      // Both robots counts live INSIDE `failed`, and do not exhaust it.
      expect(census.robotsDenied + census.robotsUnreachable).toBeLessThan(census.failed);
    } finally {
      await service.close();
    }

    // And the rows underneath say the same thing, so a served number that
    // stopped matching the database would fail here rather than drift.
    expect((await rowFor(crawlId, forbidden)).fetchClass).toBe(RESOURCE_ROBOTS_DENIED_CLASS);
    expect((await rowFor(crawlId, unreachable)).fetchClass).toBe(
      RESOURCE_ROBOTS_UNREACHABLE_CLASS,
    );
  });

  // The vocabulary itself, pinned: `robots_unreachable` is a member, and the two
  // exported constants are the two spellings the readers outside this module
  // use. A rename that missed one would leave a reader's SQL comparing against a
  // class nothing writes — the failure mode the constants exist to prevent.
  it("names the new class in the closed vocabulary the readers share", () => {
    expect(RESOURCE_FETCH_CLASSES).toContain(RESOURCE_ROBOTS_UNREACHABLE_CLASS);
    expect(RESOURCE_FETCH_CLASSES).toContain(RESOURCE_ROBOTS_DENIED_CLASS);
    expect(RESOURCE_ROBOTS_UNREACHABLE_CLASS).not.toBe(RESOURCE_ROBOTS_DENIED_CLASS);
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
// An abort stops the asking, and says so
// ---------------------------------------------------------------------------

describe("a cancel stops the pass where it stands", () => {
  it("stops asking within one row, and decides nothing about the rest", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/abort-1.png` },
      { url: `${assets.base}/abort-2.png` },
    ]);

    const controller = new AbortController();
    // Fired from inside the pass, by the server answering the first resource:
    // the only way to cancel at a known moment rather than a hoped-for one.
    onAssetHit = (path) => {
      if (path === "/abort-1.png") controller.abort();
    };

    const summary = await runPass(crawlId, assets.base, {
      maxConcurrency: 1,
      signal: controller.signal,
    });

    expect(summary.aborted).toBe(true);
    // The request in flight is aborted, not awaited (27b Ruling 4, 27d): no row, no fetch.
    expect([summary.fetched, summary.skipped]).toEqual([0, 2]);
    // The next row was never asked — not at the next batch boundary, which at a
    // real crawl's spacing would be an hour of asking after the caller stopped.
    expect(hitsFor(assets, "/abort-2.png")).toEqual([]);

    const untouched = await rowFor(crawlId, `${assets.base}/abort-2.png`);
    expect(untouched.fetchClass).toBeNull();
    // And NO reason on either row: a cap decided something about the row it
    // stopped at, an abort decided nothing at all.
    expect((await rowsOf(crawlId)).every((r) => r.fetchClass === null && r.fetchReason === null)).toBe(true);
    expect(summary.cappedByResources).toBe(false);
  });

  // THE TWO STOPS AT ONCE (P12-T2, review C-1). The budget cap is claimed for a
  // whole slice BEFORE any of it is asked about, so `cappedByResources` can be
  // true while the abort arrives inside that same slice. The closing statement
  // used to stamp `resource-cap` on every undecided row regardless — over rows
  // an abort left, which is exactly what this module's header and that
  // statement's own comment both promise it does not do.
  //
  // The shapes it produced were wrong in two directions: a row nobody stopped
  // short of asking about was labelled as one a budget did, and (with a small
  // enough budget and an abort early in the slice) a whole crawl of rows could
  // carry `resource-cap` with nothing decided at all — a census the rule layer
  // has to be able to read as "interrupted" rather than "budgeted away".
  it("marks nothing when the abort lands inside a capped batch", async () => {
    const crawlId = await seedCrawl(assets.base);
    await seedResources(crawlId, [
      { url: `${assets.base}/abort-1.png` },
      { url: `${assets.base}/abort-2.png` },
      { url: `${assets.base}/a.png` },
      { url: `${assets.base}/c.png` },
    ]);

    const controller = new AbortController();
    onAssetHit = (path) => {
      if (path === "/a.png" || path === "/abort-1.png") controller.abort();
    };

    // Budget 2 against four rows: the slice is claimed, the flag is set, and
    // the first request in it fires the abort.
    const summary = await runPass(crawlId, assets.base, {
      maxConcurrency: 1,
      maxResources: 2,
      signal: controller.signal,
    });

    expect(summary.aborted).toBe(true);
    expect(summary.cappedByResources).toBe(true);

    const rows = await rowsOf(crawlId);
    const decided = rows.filter((row) => row.fetchClass !== null);
    // None: the request that fired the signal was aborted in flight (27d); nothing after it asked.
    expect(decided.length).toBe(0);
    // And every row the abort left keeps BOTH nulls. A reason here would be a
    // budget taking credit for a stop the caller made.
    for (const row of rows.filter((r) => r.fetchClass === null)) {
      expect(row.fetchReason, row.url).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The crawl loop's wiring: after the pages, before the row closes
// ---------------------------------------------------------------------------

describe("the crawl runs the pass itself", () => {
  it("fetches a crawled page's resources before the crawl row is closed", async () => {
    const summary = await crawl({
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

  it("hands the pass the window the page crawl settled at, not the ceiling", async () => {
    const summary = await crawl({
      // Two 503 pages behind this one: enough back-pressure to halve a window
      // of 2 down to 1 before the pass starts.
      siteUrl: `${assets.base}/window`,
      maxPages: 5,
      maxDepth: 1,
      userAgent: "AriadneBot-resource-test",
      perHostDelayMs: 0,
      maxConcurrency: 2,
      probeHosts: false,
      allowPrivate: true,
      // A MINUTE OF THIS TEST WOULD NOT BE THIS TEST. The two 503s that collapse
      // the window are `server_error` page rows, so the loop's INSERTION 3c
      // re-asks them — and would wait out the real `MIN_RECHECK_GAP_MS` first
      // (P17). The test-only knob (`CrawlConfig.recheckMinGapMs`, P17-T5) drops
      // that floor to 200ms: what is under test here is the window the resource
      // pass inherits, and the recheck is only standing in front of it.
      recheckMinGapMs: 200,
    });

    expect(summary.status).toBe("finished");
    const pass = summary.resources;
    if (pass === null) throw new Error("the crawl reported no resource pass");
    // One slow asset on each of two hosts, so a two-worker pass would overlap
    // them and a one-worker pass cannot.
    expect(pass.seen).toBe(2);
    expect(pass.hosts).toBe(2);
    // THE CLAIM: the collapsed window bounds the pass. Passing
    // `config.maxConcurrency` here instead would read 2 — a site that just
    // asked us to slow down getting its full concurrency back for its images.
    expect(maxInFlight).toBe(1);
  });

  it("closes the crawl cancelled when the signal fires inside the pass", async () => {
    const controller = new AbortController();
    onAssetHit = (path) => {
      if (path === "/abort-1.png") controller.abort();
    };

    const summary = await crawl(
      {
        siteUrl: `${assets.base}/abort`,
        maxPages: 5,
        maxDepth: 1,
        userAgent: "AriadneBot-resource-test",
        perHostDelayMs: 0,
        maxConcurrency: 1,
        probeHosts: false,
        allowPrivate: true,
      },
      controller.signal,
    );

    // The pages were all fetched and the abort arrived during the resource
    // pass. A crawl that closed `finished` on a flag computed before the pass
    // would be claiming a resource census it does not have.
    expect([summary.status, summary.pauseReason]).toEqual(["paused", "shutdown"]);
    expect(summary.resources?.aborted).toBe(true);
    expect(summary.note).toContain("paused (shutdown)");
    expect(hitsFor(assets, "/abort-2.png")).toEqual([]);

    const row = (await db.select().from(crawls).where(eq(crawls.id, summary.crawlId)))[0];
    expect([row?.status, row?.pauseReason]).toEqual(["paused", "shutdown"]);
    // The row it never reached is the resume's work list: null, no reason.
    const untouched = await rowFor(summary.crawlId, `${assets.base}/abort-2.png`);
    expect(untouched.fetchClass).toBeNull();
    expect(untouched.fetchReason).toBeNull();
  });

  // THE OPERATOR'S OFF SWITCH (P11-T4). Two claims, and the second is the one
  // that makes the first legible: nothing is asked, AND the rows say who decided
  // that. A pass that simply did not run leaves rows indistinguishable from an
  // interrupted one, and a reader of a silent `images.oversized` would have no
  // way to tell "nobody weighed anything" from "nothing is heavy".
  it("asks nobody anything when the operator turned resource fetching off", async () => {
    const summary = await crawl({
      siteUrl: assets.base,
      maxPages: 5,
      maxDepth: 2,
      userAgent: "AriadneBot-resource-test",
      perHostDelayMs: 0,
      maxConcurrency: 2,
      probeHosts: false,
      allowPrivate: true,
      fetchResources: false,
    });

    expect(summary.status).toBe("finished");
    // Null is "no pass ran", exactly as on an abort. What the operator chose is
    // on the crawl's config and on every row; the summary has no field for a
    // pass that was never started.
    expect(summary.resources).toBeNull();

    // The analyzer's census is untouched: the references are still evidence,
    // and recording them costs nobody a request.
    const rows = await rowsOf(summary.crawlId);
    expect(rows.map((row) => row.kind).sort()).toEqual(["css", "image", "image", "js"]);
    expect(rows.every((row) => row.fetchClass === null)).toBe(true);
    expect(rows.every((row) => row.fetchReason === RESOURCE_OFF_REASON)).toBe(true);

    // And nothing reached a socket: not the origin's own files, not the third
    // party's, not even a robots.txt on the asset host.
    for (const path of ["/a.png", "/b.css", "/head-405.js"]) {
      expect(hitsFor(assets, path), path).toEqual([]);
    }
    expect(hitsFor(plain, "/badge.png")).toEqual([]);
  });

  it("does not ask a single server anything once the crawl is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const summary = await crawl(
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

    expect([summary.status, summary.pauseReason]).toEqual(["paused", "shutdown"]);
    // Null is "the pass did not run", which is not "there were no resources" —
    // an abort means stop asking servers for things, and this pass is all
    // asking. The nulls it left are the resume's work list.
    expect(summary.resources).toBeNull();
  });
});

/**
 * A share image (`og:image` / `twitter:image`) is a `resources` row with NO
 * `page_resources` edge (Phase 26b deviation 3): no page loads it, so it must
 * not count toward page weight or mixed content. `social.image-broken` still
 * judges its status and bytes, so the pass has to ask about it exactly as it
 * asks about a file a page loads. The work list reads `resources` alone; this
 * pins that an edge-less row gets the same verdict as an edge-backed one.
 */
describe("a share image with no page_resources edge is fetched like any other row", () => {
  it("writes the same status, bytes and class for an og-only row as for a page-loaded one", async () => {
    const crawlId = await seedCrawl(assets.base);
    const loaded = `${assets.base}/a.png`;
    // The same file under a second spelling, so both rows get the same answer.
    const ogOnly = `${assets.base}/a.png?share=1`;
    const ogMissing = `${assets.base}/missing.png`;
    await seedResources(crawlId, [{ url: loaded }, { url: ogOnly }, { url: ogMissing }]);
    await db.insert(pageResources).values({ crawlId, pageId: "page_loader", resourceUrl: loaded });

    await runPass(crawlId, assets.base);

    const pick = (row: Awaited<ReturnType<typeof rowFor>>) => ({
      fetchClass: row.fetchClass,
      statusCode: row.statusCode,
      bytes: row.bytes,
      bytesSource: row.bytesSource,
      contentType: row.contentType,
    });
    const loadedRow = pick(await rowFor(crawlId, loaded));
    expect(loadedRow).toEqual({
      fetchClass: "ok",
      statusCode: 200,
      bytes: 1234,
      bytesSource: "header",
      contentType: "image/png",
    });
    expect(pick(await rowFor(crawlId, ogOnly))).toEqual(loadedRow);
    const missing = await rowFor(crawlId, ogMissing);
    expect(missing.statusCode).toBe(404);
    expect(missing.fetchedAt).not.toBeNull();
    expect(hitsFor(assets, "/missing.png").map((hit) => hit.method)).toEqual(["HEAD"]);
  });
});

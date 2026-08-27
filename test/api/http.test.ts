/**
 * The HTTP surface, exercised against a real server on an ephemeral port.
 *
 * Nothing here calls a handler directly. Every assertion goes over a socket
 * through `fetch`, because the things this task is actually responsible for —
 * that an unauthenticated caller cannot learn which routes exist, that a body
 * field nobody allowed is refused, that a crawl really runs in the server
 * process and really queues behind another one — are properties of the server,
 * not of a function.
 *
 * THE ONE THING THE WIRE CANNOT CARRY, and why these tests can still crawl:
 * `allowPrivate` is refused as a request field at any value (build-plan §7 item
 * 3, and Task 1's persistence strip). The suite still has to crawl a 127.0.0.1
 * fixture server, so it is supplied where the trust actually is — in
 * `createApiServer`'s construction config, by the process that holds the
 * database handle and the token. That is the same process-trust seam the MCP
 * transport will use. See `ApiServerConfig.crawlDefaults`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { isHostAllowed, loadApiConfig, parseAllowedDomains } from "../../src/api/config.js";

const TOKEN = "test-token-0123456789abcdef";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title>` +
    `<meta name="description" content="a fixture page for the API tests"></head>` +
    `<body><h1>${title}</h1>${body}</body></html>`
  );
}

let db: Db;
/** The site the API crawls: three pages, a sitemap, permissive robots. */
let siteServer: Server;
let site: string;
/** The same site bound on every interface, so `www.localhost` reaches it. */
let namedServer: Server;
let named: string;

/** The server under test: allowlist with an exact host and a wildcard. */
let api: ApiServer;
let base: string;
/** A second server whose allowlist is empty — the read-only posture. */
let closedApi: ApiServer;
let closedBase: string;

const createdCrawls: string[] = [];
const serverLog: string[] = [];

/** The crawl `beforeAll` runs through the API; render and rules reuse it. */
let fixtureCrawlId = "";
let fixtureAccepted: Record<string, unknown> = {};
let fixtureFinal: Record<string, unknown> = {};

interface Res {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; raw?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? `Bearer ${TOKEN}` : opts.token;
  if (token !== null) headers["authorization"] = token;
  let payload: string | undefined;
  if (opts.raw !== undefined) payload = opts.raw;
  else if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  if (payload !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: res.headers,
  };
}

/** Poll a crawl until it stops moving. Returns its final detail. */
async function settle(crawlId: string, deadlineMs = 25_000): Promise<Record<string, unknown>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const res = await call("GET", `/crawls/${crawlId}`);
    if (res.status !== 200) throw new Error(`settle: GET returned ${res.status}`);
    const status = res.body["status"];
    if (status !== "queued" && status !== "running") return res.body;
    if (Date.now() > until) throw new Error(`settle: crawl ${crawlId} still '${String(status)}'`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startCrawl(body: Record<string, unknown>): Promise<Res> {
  const res = await call("POST", "/crawls", { body });
  const id = res.body["crawlId"];
  if (typeof id === "string") createdCrawls.push(id);
  return res;
}

/** A `crawls` row written straight into the database, for the lifecycle guards. */
async function seedCrawl(row: {
  status: string;
  siteUrl?: string;
  discovery?: unknown;
}): Promise<string> {
  const id = `crawl_seed_${createdCrawls.length}_${Date.now()}`;
  await db.insert(crawls).values({
    id,
    siteUrl: row.siteUrl ?? "http://seeded.example/",
    config: {
      siteUrl: row.siteUrl ?? "http://seeded.example/",
      maxPages: 10,
      maxDepth: 3,
      userAgent: "AriadneBot/0.1 (test)",
      perHostDelayMs: 0,
      maxConcurrency: 2,
    },
    rulesetVersion: "0.0.0-test",
    status: row.status,
    ...(row.discovery === undefined ? {} : { discovery: row.discovery }),
  });
  createdCrawls.push(id);
  return id;
}

/** The minimum `discovery_jsonb` the render endpoint needs to pace itself. */
const DISCOVERY = {
  robots: { outcome: "absent", crawlDelaySec: null, note: null, raw: null, truncated: false },
  sitemapSources: [],
  truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 0 },
  docsFetched: 0,
};

async function seedLease(
  crawlId: string,
  opts: { state: string; expiresInMs: number; url?: string },
): Promise<void> {
  await db.insert(frontier).values({
    crawlId,
    url: opts.url ?? `http://seeded.example/${opts.state}`,
    state: opts.state,
    depth: 0,
    discoveredVia: "seed",
    leaseId: "worker_gone",
    leasedUntil: new Date(Date.now() + opts.expiresInMs),
  });
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const path = req.url ?? "/";
    const origin = path.startsWith("/named") ? named : site;
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
      return;
    }
    if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${origin}/</loc></url><url><loc>${origin}/a</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    const bodies: Record<string, string> = {
      "/": html("home", `<a href="/a">a</a><a href="/b">b</a>`),
      "/a": html("page a", `<a href="/b">b</a><p>some words for the analyzer to count</p>`),
      "/b": html("page b", `<p>the third page, linked from both of the others</p>`),
    };
    const body = bodies[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("not found", "<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };

  siteServer = createServer(handler);
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const siteAddr = siteServer.address();
  site = `http://127.0.0.1:${typeof siteAddr === "object" && siteAddr !== null ? siteAddr.port : 0}`;

  // Bound by name, on every interface, so the `*.localhost` allowlist entry has
  // a host it can actually match (an IP literal has no `www.` spelling).
  namedServer = createServer(handler);
  await new Promise<void>((r) => namedServer.listen(0, r));
  const namedAddr = namedServer.address();
  named = `http://localhost:${typeof namedAddr === "object" && namedAddr !== null ? namedAddr.port : 0}`;

  api = createApiServer({
    db,
    config: {
      token: TOKEN,
      allowedDomains: ["127.0.0.1", "*.localhost"],
      // PROCESS TRUST, NOT WIRE TRUST. See the module header.
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      log: (line) => serverLog.push(line),
    },
  });
  const bound = await api.listen(0);
  base = `http://127.0.0.1:${bound.port}`;

  closedApi = createApiServer({
    db,
    config: { token: TOKEN, allowedDomains: [], log: (line) => serverLog.push(line) },
  });
  const closedBound = await closedApi.listen(0);
  closedBase = `http://127.0.0.1:${closedBound.port}`;

  // The crawl the render and rules endpoints are exercised against, run through
  // the API itself rather than by calling `runCrawl` — the point of the task is
  // that a crawl starts in the server process.
  const accepted = await startCrawl({ siteUrl: `${site}/`, maxPages: 5 });
  if (accepted.status !== 202) {
    throw new Error(`fixture crawl was not accepted: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
  fixtureAccepted = accepted.body;
  fixtureCrawlId = String(accepted.body["crawlId"]);
  fixtureFinal = await settle(fixtureCrawlId);
}, 60_000);

afterAll(async () => {
  await api.close();
  await closedApi.close();
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  await new Promise<void>((r) => namedServer.close(() => r()));
});

describe("authentication", () => {
  it("refuses a request with no Authorization header", async () => {
    const res = await call("GET", "/crawls", { token: null });
    expect(res.status).toBe(401);
    expect(String(res.body["error"])).toContain("missing Authorization header");
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("refuses a scheme that is not Bearer", async () => {
    const res = await call("GET", "/crawls", { token: "Basic dXNlcjpwYXNz" });
    expect(res.status).toBe(401);
    expect(String(res.body["error"])).toContain("Bearer");
  });

  it("refuses a wrong token", async () => {
    const res = await call("GET", "/crawls", { token: "Bearer not-the-token-at-all-x" });
    expect(res.status).toBe(401);
    expect(res.body["error"]).toBe("invalid API token");
  });

  it("checks the token before routing, so an anonymous caller cannot map the surface", async () => {
    const res = await call("GET", "/does-not-exist", { token: null });
    expect(res.status).toBe(401);
  });

  it("admits the configured token", async () => {
    const res = await call("GET", "/crawls");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body["items"])).toBe(true);
  });
});

describe("routing and body handling", () => {
  it("404s an unknown route for an authenticated caller", async () => {
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    expect(String(res.body["error"])).toContain("no route for GET");
  });

  it("405s a known path with the wrong method, naming what is allowed", async () => {
    const res = await call("GET", `/crawls/${fixtureCrawlId}/fail`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("400s a body that is not JSON", async () => {
    const res = await call("POST", "/crawls", { raw: "{not json" });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("request body is not valid JSON");
  });

  it("413s a body over the cap instead of holding it", async () => {
    // Over the cap, under the drain ceiling: the bytes are read and dropped so
    // the caller can be told what went wrong, rather than reset mid-write.
    const res = await call("POST", "/crawls", { raw: `{"siteUrl":"${"x".repeat(70_000)}"}` });
    expect(res.status).toBe(413);
    expect(String(res.body["error"])).toContain("exceeds");
  });

  it("hangs up on a body past the drain ceiling rather than reading it out of politeness", async () => {
    await expect(
      call("POST", "/crawls", { raw: `{"siteUrl":"${"x".repeat(2_000_000)}"}` }),
    ).rejects.toThrow();
  });

  it("refuses a body on a route that takes none", async () => {
    const res = await call("POST", `/crawls/${fixtureCrawlId}/fail`, { body: { force: true } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("takes no request body");
  });
});

describe("crawl-start validation", () => {
  it("refuses allowPrivate at any value, saying why", async () => {
    for (const value of [true, false]) {
      const res = await call("POST", "/crawls", { body: { siteUrl: `${site}/`, allowPrivate: value } });
      expect(res.status).toBe(400);
      expect(String(res.body["error"])).toContain("allowPrivate is not accepted over the API");
    }
  });

  it("refuses an unknown field by name rather than ignoring it", async () => {
    const res = await call("POST", "/crawls", { body: { siteUrl: `${site}/`, maxpages: 3 } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("unknown field 'maxpages'");
  });

  it("refuses a field of the wrong type", async () => {
    const res = await call("POST", "/crawls", { body: { siteUrl: `${site}/`, maxPages: "5" } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("must be a finite number");
  });

  it("requires siteUrl", async () => {
    const res = await call("POST", "/crawls", { body: { maxPages: 5 } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("siteUrl is required");
  });

  it("refuses a siteUrl that is not http(s)", async () => {
    const res = await call("POST", "/crawls", { body: { siteUrl: "ftp://example.com/x" } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("not an http(s) URL");
  });

  it("surfaces the crawl loop's own range checks as a 400", async () => {
    const res = await call("POST", "/crawls", { body: { siteUrl: `${site}/`, maxPages: 0 } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("maxPages");
  });
});

describe("domain allowlist", () => {
  it("matches exactly, and a wildcard matches subdomains but not the apex", () => {
    const list = ["example.com", "*.example.org"];
    expect(isHostAllowed("example.com", list)).toBe(true);
    expect(isHostAllowed("EXAMPLE.com.", list)).toBe(true);
    expect(isHostAllowed("www.example.com", list)).toBe(false);
    expect(isHostAllowed("notexample.com", list)).toBe(false);
    expect(isHostAllowed("a.example.org", list)).toBe(true);
    expect(isHostAllowed("a.b.example.org", list)).toBe(true);
    expect(isHostAllowed("example.org", list)).toBe(false);
    expect(isHostAllowed("evil-example.org", list)).toBe(false);
    expect(isHostAllowed("anything", [])).toBe(false);
  });

  it("parses the env list and refuses a malformed entry rather than dropping it", () => {
    expect(parseAllowedDomains("Example.com, *.example.org ,")).toEqual([
      "example.com",
      "*.example.org",
    ]);
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(() => parseAllowedDomains("https://example.com")).toThrow(/bare host/);
    expect(() => parseAllowedDomains("*")).toThrow(/every host/);
    expect(() => parseAllowedDomains("a.*.com")).toThrow(/leading/);
  });

  it("403s a host that is not on the list, naming it", async () => {
    const res = await call("POST", "/crawls", { body: { siteUrl: "https://not-allowed.example/" } });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("not-allowed.example");
    expect(String(res.body["error"])).toContain("allowlist");
    // The allowlist's own contents are never listed back to the caller.
    expect(String(res.body["error"])).not.toContain("127.0.0.1");
  });

  it("403s the apex when only the wildcard is listed", async () => {
    const apex = new URL(named);
    const res = await call("POST", "/crawls", { body: { siteUrl: `http://localhost:${apex.port}/` } });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("localhost");
  });

  it("accepts a subdomain the wildcard covers", async () => {
    const port = new URL(named).port;
    const res = await startCrawl({ siteUrl: `http://www.localhost:${port}/`, maxPages: 1 });
    expect(res.status).toBe(202);
    // Let it reach a terminal state before the next test measures the queue.
    // Whether it crawls or fails is this machine's DNS to say; the allowlist
    // verdict is what this test is about.
    await settle(String(res.body["crawlId"]));
  });

  it("refuses every crawl when the allowlist is empty, but still answers queries", async () => {
    const started = await fetch(`${closedBase}/crawls`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ siteUrl: `${site}/` }),
    });
    expect(started.status).toBe(403);
    expect(String(((await started.json()) as Record<string, unknown>)["error"])).toContain("empty");

    const listed = await fetch(`${closedBase}/crawls`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(listed.status).toBe(200);
  });
});

describe("crawl lifecycle", () => {
  it("accepts a crawl, runs it in the server process, and reports it as finished", () => {
    expect(fixtureAccepted["status"]).toBe("queued");
    expect(fixtureAccepted["queuePosition"]).toBe(0);
    expect(String(fixtureAccepted["crawlId"])).toMatch(/^crawl_/);

    expect(fixtureFinal["status"]).toBe("finished");
    expect(Number(fixtureFinal["pagesCrawled"])).toBeGreaterThanOrEqual(3);
    expect(fixtureFinal["siteUrl"]).toBe(`${site}/`);
    expect(fixtureFinal["finishedAt"]).not.toBeNull();
    expect(fixtureFinal["queuePosition"]).toBeNull();
    expect(fixtureFinal["liveLeases"]).toBe(0);
    const counts = fixtureFinal["frontier"] as Record<string, number>;
    expect(counts["done"]).toBeGreaterThanOrEqual(3);
  });

  it("never lets allowPrivate reach the crawl row, even though the crawl used it", async () => {
    const rows = await db.select().from(crawls).where(eq(crawls.id, fixtureCrawlId));
    const stored = rows[0]?.config as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect("allowPrivate" in stored).toBe(false);
    expect(stored["maxPages"]).toBe(5);
    // The process-trust defaults DID apply to the run: this crawl reached a
    // 127.0.0.1 fixture, which the URL policy refuses without the flag.
    expect(stored["probeHosts"]).toBe(false);
  });

  it("404s an unknown crawl", async () => {
    const res = await call("GET", "/crawls/crawl_nope");
    expect(res.status).toBe(404);
    expect(String(res.body["error"])).toContain("crawl_nope");
  });

  it("queues a second crawl behind the first instead of running both", async () => {
    const first = await startCrawl({ siteUrl: `${site}/`, maxPages: 3, perHostDelayMs: 400 });
    const second = await startCrawl({ siteUrl: `${site}/`, maxPages: 3, perHostDelayMs: 400 });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body["queuePosition"]).toBe(0);
    expect(second.body["queuePosition"]).toBe(1);

    const secondId = String(second.body["crawlId"]);
    const waiting = await call("GET", `/crawls/${secondId}`);
    expect(waiting.body["status"]).toBe("queued");
    expect(Number(waiting.body["queuePosition"])).toBeGreaterThanOrEqual(1);

    const firstFinal = await settle(String(first.body["crawlId"]));
    const secondFinal = await settle(secondId);
    expect(firstFinal["status"]).toBe("finished");
    expect(secondFinal["status"]).toBe("finished");
    expect(secondFinal["queuePosition"]).toBeNull();
  });

  it("leaves a queued row from another process alone: visible, unheld, unstarted", async () => {
    const orphan = await seedCrawl({ status: "queued" });
    const first = await call("GET", `/crawls/${orphan}`);
    expect(first.body["status"]).toBe("queued");
    // Null, not a number: no process is holding this work. It is not lost (the
    // row and its config stand) and it is not silently started.
    expect(first.body["queuePosition"]).toBeNull();

    await new Promise((r) => setTimeout(r, 300));
    const later = await call("GET", `/crawls/${orphan}`);
    expect(later.body["status"]).toBe("queued");
  });
});

describe("POST /crawls/:id/fail", () => {
  it("closes a running crawl whose leases have all expired", async () => {
    const id = await seedCrawl({ status: "running" });
    await seedLease(id, { state: "leased", expiresInMs: -60_000 });

    const res = await call("POST", `/crawls/${id}/fail`);
    expect(res.status).toBe(200);
    expect(res.body["status"]).toBe("failed");
    expect(res.body["finishedAt"]).not.toBeNull();
  });

  it("409s a running crawl that still holds an unexpired crawl lease", async () => {
    const id = await seedCrawl({ status: "running" });
    await seedLease(id, { state: "leased", expiresInMs: 60_000 });

    const res = await call("POST", `/crawls/${id}/fail`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("unexpired lease");
  });

  it("409s a crawl a render pass is holding — a render lease is a live lease too", async () => {
    const id = await seedCrawl({ status: "running" });
    await seedLease(id, { state: "render_pending", expiresInMs: 60_000 });

    const res = await call("POST", `/crawls/${id}/fail`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("unexpired lease");
  });

  it("409s a crawl that is not running, naming the status it is in", async () => {
    const res = await call("POST", `/crawls/${fixtureCrawlId}/fail`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("'finished'");
  });

  it("404s an unknown crawl", async () => {
    const res = await call("POST", "/crawls/crawl_missing/fail");
    expect(res.status).toBe(404);
  });
});

describe("POST /crawls/:id/render", () => {
  it("404s an unknown crawl", async () => {
    const res = await call("POST", "/crawls/crawl_missing/render");
    expect(res.status).toBe(404);
  });

  it("409s a live crawl with the render driver's own message", async () => {
    const id = await seedCrawl({ status: "running", discovery: DISCOVERY });
    const res = await call("POST", `/crawls/${id}/render`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("still marked 'running'");
  });

  it("409s a queued crawl: it has not run, and it would start under the pass", async () => {
    const id = await seedCrawl({ status: "queued", discovery: DISCOVERY });
    const res = await call("POST", `/crawls/${id}/render`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("'queued'");
  });

  it("409s a crawl with no discovery evidence rather than rendering it at an unknown pace", async () => {
    const id = await seedCrawl({ status: "failed" });
    const res = await call("POST", `/crawls/${id}/render`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("discovery evidence");
  });

  it("runs the pass over the finished crawl and returns counts, not a page list", async () => {
    const res = await call("POST", `/crawls/${fixtureCrawlId}/render`);
    expect(res.status).toBe(200);
    expect(res.body["crawlId"]).toBe(fixtureCrawlId);
    const selection = res.body["selection"] as Record<string, unknown>;
    expect(typeof selection["selected"]).toBe("number");
    expect(typeof selection["budget"]).toBe("number");
    expect(Number(res.body["rendered"]) + Number(res.body["failures"])).toBe(selection["selected"]);
    expect(res.body["unrendered"]).toBe(0);
  }, 60_000);
});

describe("POST /crawls/:id/rules", () => {
  it("404s an unknown crawl", async () => {
    const res = await call("POST", "/crawls/crawl_missing/rules");
    expect(res.status).toBe(404);
  });

  it("409s a crawl that is still in flight", async () => {
    const id = await seedCrawl({ status: "running" });
    const res = await call("POST", `/crawls/${id}/rules`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("has stopped");
  });

  it("runs the rules over the finished crawl and returns the summary", async () => {
    const res = await call("POST", `/crawls/${fixtureCrawlId}/rules`);
    expect(res.status).toBe(200);
    expect(Number(res.body["pagesScanned"])).toBeGreaterThanOrEqual(3);
    expect(typeof res.body["findings"]).toBe("number");
    expect(typeof res.body["byRule"]).toBe("object");
    expect(typeof res.body["byMetric"]).toBe("object");
  }, 60_000);
});

describe("GET /crawls", () => {
  it("pages deterministically and hands back a usable cursor", async () => {
    const first = await call("GET", "/crawls?limit=1");
    expect(first.status).toBe(200);
    const firstItems = first.body["items"] as Record<string, unknown>[];
    expect(firstItems).toHaveLength(1);
    expect(typeof first.body["nextCursor"]).toBe("string");

    const second = await call("GET", `/crawls?limit=1&cursor=${encodeURIComponent(String(first.body["nextCursor"]))}`);
    expect(second.status).toBe(200);
    const secondItems = second.body["items"] as Record<string, unknown>[];
    expect(secondItems).toHaveLength(1);
    expect(secondItems[0]?.["crawlId"]).not.toBe(firstItems[0]?.["crawlId"]);
  });

  it("pages across two crawls whose timestamps differ only in microseconds", async () => {
    // `timestamptz` keeps microseconds; a JS `Date` does not. A cursor built
    // from the parsed Date compares `.123000` against a row stored at
    // `.123111` and drops it — a crawl that is simply never listed. Both rows
    // are dated in 2099 so they sort ahead of every other crawl in the shared
    // test database, which makes the assertion exact regardless of what else
    // is running.
    const later = `crawl_micro_late_${Date.now()}`;
    const earlier = `crawl_micro_early_${Date.now()}`;
    await db.execute(sql`
      insert into crawls (id, site_url, config_jsonb, ruleset_version, status, started_at)
      values (${later}, 'http://micro.example/', '{}'::jsonb, '0.0.0-test', 'failed',
              '2099-01-01T00:00:00.123999Z'),
             (${earlier}, 'http://micro.example/', '{}'::jsonb, '0.0.0-test', 'failed',
              '2099-01-01T00:00:00.123111Z')`);
    createdCrawls.push(later, earlier);

    const first = await call("GET", "/crawls?limit=1");
    expect((first.body["items"] as Record<string, unknown>[])[0]?.["crawlId"]).toBe(later);
    const second = await call(
      "GET",
      `/crawls?limit=1&cursor=${encodeURIComponent(String(first.body["nextCursor"]))}`,
    );
    expect((second.body["items"] as Record<string, unknown>[])[0]?.["crawlId"]).toBe(earlier);
  });

  it("400s a limit outside the contract and a cursor it did not issue", async () => {
    expect((await call("GET", "/crawls?limit=0")).status).toBe(400);
    expect((await call("GET", "/crawls?limit=201")).status).toBe(400);
    expect((await call("GET", "/crawls?limit=abc")).status).toBe(400);
    const bad = await call("GET", "/crawls?cursor=not-a-cursor");
    expect(bad.status).toBe(400);
    expect(String(bad.body["error"])).toContain("cursor");
  });
});

describe("boot configuration", () => {
  it("refuses to produce a config without a token", () => {
    expect(() => loadApiConfig({ DATABASE_URL: "postgres://x" })).toThrow(
      /ARIADNE_API_TOKEN must be set/,
    );
  });

  it("refuses a token short enough to guess", () => {
    expect(() => loadApiConfig({ ARIADNE_API_TOKEN: "short", DATABASE_URL: "postgres://x" })).toThrow(
      /at least 16 characters/,
    );
  });

  it("refuses to start without a database", () => {
    expect(() => loadApiConfig({ ARIADNE_API_TOKEN: TOKEN })).toThrow(/DATABASE_URL must be set/);
  });

  it("reads the token, the allowlist and the port", () => {
    const config = loadApiConfig({
      ARIADNE_API_TOKEN: TOKEN,
      DATABASE_URL: "postgres://x",
      ARIADNE_ALLOWED_DOMAINS: "example.com,*.example.org",
      ARIADNE_API_PORT: "9123",
    });
    expect(config.token).toBe(TOKEN);
    expect(config.allowedDomains).toEqual(["example.com", "*.example.org"]);
    expect(config.port).toBe(9123);
  });
});

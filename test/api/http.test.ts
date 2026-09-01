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
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { isHostAllowed, loadApiConfig, parseAllowedDomains } from "../../src/api/config.js";
import { MAX_SUPPLIED_SITEMAPS, MIN_PER_HOST_DELAY_MS } from "../../src/api/service.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";

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
/**
 * Where every server in this file keeps the render pass's serialised
 * documents. A temp directory, made in `beforeAll` and removed in `afterAll`:
 * the render endpoint writes a real file per rendered page, and the default
 * root is `renders/` under the process's cwd — the repository.
 */
let renderDir: string;

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
  opts: { token?: string | null; body?: unknown; raw?: string; base?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? `Bearer ${TOKEN}` : opts.token;
  if (token !== null) headers["authorization"] = token;
  let payload: string | undefined;
  if (opts.raw !== undefined) payload = opts.raw;
  else if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  if (payload !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${opts.base ?? base}${path}`, {
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

/** Wait for something to become true, or say what never happened. */
async function waitFor(
  what: string,
  predicate: () => boolean,
  deadlineMs = 15_000,
): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`waitFor: ${what} never happened`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Rig {
  api: ApiServer;
  base: string;
  log: string[];
}

/**
 * A database method that works for a while and then does not.
 *
 * `failAfter: 1` lets the first call through to the REAL database and throws on
 * every one after it. An unconditional thrower cannot reach a failure that
 * happens after the response headers are on the wire — it fails before there is
 * a response at all — and that failure is the entire rule-7 argument for the
 * streaming CSV route. This is the only way to stand where it stands.
 */
interface FlakyMethod {
  failAfter: number;
  throws: () => never;
}

/**
 * A server whose database fails in one named way.
 *
 * The things this file has to prove about failure — that a broken queue runner
 * does not take the process down, that an unexpected throw becomes a 500 with a
 * correlation id and nothing else, and that a failure PAST the headers tears
 * the response rather than truncating it — all need an error the API cannot
 * produce on its own. A `Proxy` over the real `Db` supplies exactly one: every
 * method is forwarded and bound to the real handle except the one named here,
 * which throws either always (`broken`) or after N successful calls (`flaky`).
 * Nothing is stubbed, nothing is mocked, and the code under test is the real
 * path.
 */
async function riggedServer(
  broken: Record<string, () => never>,
  flaky: Record<string, FlakyMethod> = {},
): Promise<Rig> {
  const log: string[] = [];
  const calls = new Map<string, number>();
  const rigged = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === "string" && prop in broken) return broken[prop];
      const value = Reflect.get(target, prop) as unknown;
      const bound =
        typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      const rig = typeof prop === "string" ? flaky[prop] : undefined;
      if (rig === undefined || typeof bound !== "function") return bound;
      const name = prop as string;
      return (...args: unknown[]) => {
        const nth = (calls.get(name) ?? 0) + 1;
        calls.set(name, nth);
        return nth > rig.failAfter ? rig.throws() : bound(...args);
      };
    },
  }) as Db;

  const api = createApiServer({
    db: rigged,
    config: {
      token: TOKEN,
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      // See `renderDir` in the main server below: a suite that renders must say
      // where the documents go, or they land in the repository.
      renderDir,
      log: (line) => log.push(line),
    },
  });
  const bound = await api.listen(0);
  return { api, base: `http://127.0.0.1:${bound.port}`, log };
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

  renderDir = await mkdtemp(join(tmpdir(), "ariadne-http-renders-"));
  api = createApiServer({
    db,
    config: {
      token: TOKEN,
      allowedDomains: ["127.0.0.1", "*.localhost"],
      // PROCESS TRUST, NOT WIRE TRUST. See the module header.
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      // WHERE THE RENDER PASS PUTS ITS DOCUMENTS, and it is not optional for a
      // test that renders. `POST /crawls/:id/render` writes one HTML file per
      // rendered page; without this the server's default puts them in
      // `renders/` under the repository, which is exactly what this suite did
      // until the field existed — twelve stray crawl directories in a working
      // tree, indistinguishable from a real pass's evidence.
      renderDir,
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
  await rm(renderDir, { recursive: true, force: true });
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

  // The floor the MCP tool descriptions promise, enforced on the field as it
  // arrives over the wire. Refused rather than clamped: raising it silently
  // would answer a request nobody made. The server's own
  // `crawlDefaults.perHostDelayMs: 0` is untouched by this — that is the
  // construction-trust path, and it is how the fixture crawls above run at all.
  it("refuses a perHostDelayMs under the politeness floor rather than raising it", async () => {
    for (const value of [0, 10, MIN_PER_HOST_DELAY_MS - 1]) {
      const res = await call("POST", "/crawls", {
        body: { siteUrl: `${site}/`, perHostDelayMs: value },
      });
      expect(res.status, `perHostDelayMs ${value}`).toBe(400);
      expect(String(res.body["error"])).toContain(`${MIN_PER_HOST_DELAY_MS}ms`);
    }
  });

  // The floor stops exactly where it says it does. Asked of the read-only
  // server so the assertion costs no crawl: validation runs before the
  // allowlist, so a 403 naming the allowlist is proof the value got past the
  // floor, and the case above proves a smaller one does not.
  it("lets a perHostDelayMs at the floor through validation", async () => {
    const res = await call("POST", "/crawls", {
      base: closedBase,
      body: { siteUrl: `${site}/`, perHostDelayMs: MIN_PER_HOST_DELAY_MS },
    });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("allowlist");
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

  // Both halves of this were silent: the entry looked accepted and matched
  // nothing, which is the one failure mode the whole parse exists to prevent.
  it("strips the trailing root dot so a dotted entry matches, rather than matching nothing", () => {
    // The needle is normalised, so the entry has to be too, or the two never
    // meet. Deduped against the dotless spelling, because they are one entry.
    expect(parseAllowedDomains("example.com., *.example.org., example.com")).toEqual([
      "example.com",
      "*.example.org",
    ]);
    const list = parseAllowedDomains("example.com.");
    expect(isHostAllowed("example.com", list)).toBe(true);
    expect(isHostAllowed("example.com.", list)).toBe(true);
    // A segment of nothing but dots is not punctuation to skip over: it is an
    // entry that names no host, and it is refused as the operator wrote it.
    expect(() => parseAllowedDomains(".")).toThrow(/'\.' names no host/);
  });

  it("refuses a non-ASCII entry and names its punycode spelling", () => {
    // The needle comes out of `new URL().hostname`, which is punycode, so a
    // Unicode entry permits exactly nothing while looking permissive.
    expect(new URL("https://münchen.de/").hostname).toBe("xn--mnchen-3ya.de");
    expect(() => parseAllowedDomains("münchen.de")).toThrow(/xn--mnchen-3ya\.de/);
    expect(() => parseAllowedDomains("münchen.de")).toThrow(/not ASCII/);
    // The wildcard keeps its label in the suggested spelling.
    expect(() => parseAllowedDomains("*.münchen.de")).toThrow(/\*\.xn--mnchen-3ya\.de/);
    // And the punycode spelling the message hands back is one that works.
    expect(isHostAllowed("münchen.de", parseAllowedDomains("xn--mnchen-3ya.de"))).toBe(false);
    expect(
      isHostAllowed(new URL("https://münchen.de/").hostname, parseAllowedDomains("xn--mnchen-3ya.de")),
    ).toBe(true);
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

  // `legacyHosts` is the second way a crawl names a host, and for a while it was
  // the unguarded one. The host probe fetches every entry's origin root BEFORE
  // any robots.txt has been read (host-probe.ts: "the only fetches in the
  // crawler not covered by robots.txt"), so an allowlist that checked only
  // `siteUrl` let an authorised caller point a branded crawler anywhere.
  it("403s a legacy host nobody allowlisted, naming it and saying why it matters", async () => {
    const res = await call("POST", "/crawls", {
      body: { siteUrl: `${site}/`, legacyHosts: ["victim.example"] },
    });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("victim.example");
    expect(String(res.body["error"])).toContain("robots.txt");
  });

  it("gates a legacy host even when the probe is switched off", async () => {
    // Nothing would be fetched — but the entry is written to the crawl row, and
    // a resume that turns probing on would fetch a host this server never
    // authorised. The row must not carry it.
    const res = await call("POST", "/crawls", {
      body: { siteUrl: `${site}/`, probeHosts: false, legacyHosts: ["victim.example"] },
    });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("victim.example");
  });

  it("400s a malformed legacyHosts entry at accept time, not mid-crawl", async () => {
    const res = await call("POST", "/crawls", {
      body: { siteUrl: `${site}/`, legacyHosts: ["not a host"] },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("legacyHosts");
  });

  it("accepts an allowlisted legacy host, and does not gate the site's own spellings", async () => {
    // `www.localhost` as the seed means the probe's own family includes the
    // apex `localhost`, which `*.localhost` does NOT cover — and it must not be
    // refused, because that family IS the site (isSameOrigin admits it). The
    // legacy host is the extra one, and it is on the list in its own right.
    const port = new URL(named).port;
    const res = await startCrawl({
      siteUrl: `http://www.localhost:${port}/`,
      maxPages: 1,
      legacyHosts: ["old.localhost"],
    });
    expect(res.status).toBe(202);
    const detail = await settle(String(res.body["crawlId"]));
    // And the crawl says which extra hosts it was given. Without this echo the
    // legacy-redirect check (CHECK-15) is unreadable: no finding could mean the
    // redirects are fine, or that nobody ever named a legacy domain.
    expect(detail["legacyHosts"]).toEqual(["old.localhost"]);
  });

  // `sitemapUrls` is the third way a request names something to fetch, and it
  // is fetched by the discovery walk before a single page is. The allowlist
  // posture is `legacyHosts`': the site's own spellings are authorised by the
  // crawl, everything else must be on the list in its own right.
  it("403s a supplied sitemap on a host nobody allowlisted, naming it", async () => {
    const res = await call("POST", "/crawls", {
      body: { siteUrl: `${site}/`, sitemapUrls: ["https://victim.example/sitemap.xml"] },
    });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("victim.example");
    expect(String(res.body["error"])).toContain("sitemapUrls");
  });

  it("400s a sitemapUrls entry that is not an absolute URL, at accept time", async () => {
    // A relative path is the mistake somebody makes reading it off a CMS. The
    // walk resolves nothing, so this would otherwise be a walk failure the
    // operator reads as the site's.
    const res = await call("POST", "/crawls", {
      body: { siteUrl: `${site}/`, sitemapUrls: ["/sitemap.xml"] },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("sitemapUrls");
    expect(String(res.body["error"])).toContain("/sitemap.xml");
  });

  it("400s a sitemapUrls list longer than the server's limit rather than trimming it", async () => {
    const many = Array.from(
      { length: MAX_SUPPLIED_SITEMAPS + 1 },
      (_unused, i) => `${site}/sitemap-${i}.xml`,
    );
    const res = await call("POST", "/crawls", {
      body: { siteUrl: `${site}/`, sitemapUrls: many },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain(String(MAX_SUPPLIED_SITEMAPS));
  });

  it("accepts a supplied sitemap on the site's own host, and echoes it", async () => {
    const res = await startCrawl({
      siteUrl: `${site}/`,
      maxPages: 2,
      sitemapUrls: [`${site}/sitemap.xml`],
    });
    expect(res.status).toBe(202);
    const detail = await settle(String(res.body["crawlId"]));
    // The echo, beside legacyHosts and for the same reason: "no sitemap
    // declared" beside an empty list is a crawl to re-run with the document,
    // not a report to write.
    expect(detail["sitemapUrls"]).toEqual([`${site}/sitemap.xml`]);
  });

  // `findingCap` is the one wire field where NULL IS A VALUE: it says "list
  // everything", which is a different instruction from omitting the field ("the
  // engine's defaults"). Both have to cross the wire, and everything else has to
  // be refused at accept time rather than by a rules run hours later.
  it("400s a findingCap that is neither a positive integer nor null", async () => {
    for (const bad of [0, -1, 1.5, "none"]) {
      const res = await call("POST", "/crawls", {
        body: { siteUrl: `${site}/`, findingCap: bad },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(String(res.body["error"])).toContain("findingCap");
    }
  });

  it("accepts findingCap: null, stores it, and echoes it on the detail", async () => {
    const res = await startCrawl({ siteUrl: `${site}/`, maxPages: 1, findingCap: null });
    expect(res.status).toBe(202);
    const crawlId = String(res.body["crawlId"]);
    const detail = await settle(crawlId);
    // The row is what the rules run reads (`storedFindingCap`)…
    const rows = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect((rows[0]!.config as Record<string, unknown>)["findingCap"]).toBeNull();
    // …and the detail is how the caller confirms it took. The skills tell an
    // agent to set this for client work, so a setting nothing can confirm would
    // be a setting nobody could trust.
    expect(detail["findingCap"]).toBeNull();
  });

  // The three cases the stored config can be in collapse onto the two values a
  // reader gets, and the interesting one is ABSENT: nobody chose, so the crawl
  // will be judged at the engine's default and the default is what is reported.
  it("reports the default finding cap for a crawl that named none", async () => {
    const res = await startCrawl({ siteUrl: `${site}/`, maxPages: 1 });
    expect(res.status).toBe(202);
    const detail = await settle(String(res.body["crawlId"]));
    expect(detail["findingCap"]).toBe(URL_FINDING_CAP);
  });

  it("echoes a stated finding cap on the detail", async () => {
    const res = await startCrawl({ siteUrl: `${site}/`, maxPages: 1, findingCap: 25 });
    expect(res.status).toBe(202);
    const detail = await settle(String(res.body["crawlId"]));
    expect(detail["findingCap"]).toBe(25);
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
    // A fixture site nobody blocks: present and zero, not absent.
    expect(fixtureFinal["blockedPages"]).toBe(0);
    // The gate reported its spacing even though nothing ever escalated it — the
    // crawl ran at perHostDelayMs 0, and 0 is a real answer, not "unknown".
    expect(fixtureFinal["hostSpacingMs"]).toBe(0);
    // A finished crawl NOBODY HAS JUDGED. The marker is null and the findings
    // count is zero, and the pair is the honest reading: not "this site is
    // clean" — nothing has looked at it yet. (The rules describe below runs
    // over this same crawl and the marker moves.)
    expect(fixtureFinal["rulesRunAt"]).toBeNull();
    expect(fixtureFinal["findingsCount"]).toBe(0);
    // Nobody named a legacy domain for this crawl: present and empty.
    expect(fixtureFinal["legacyHosts"]).toEqual([]);
    // …and nobody handed it a sitemap either. Same reading: the engine never
    // probes for an undeclared one, so an empty list is "nobody has supplied
    // it yet", never "the site has none".
    expect(fixtureFinal["sitemapUrls"]).toEqual([]);
  });

  it("counts the crawl's blocked pages on the status body", async () => {
    const crawlId = await seedCrawl({ status: "finished" });
    for (const [slug, fetchClass] of [
      ["blocked-1", "blocked"],
      ["blocked-2", "blocked"],
      ["fine", "ok"],
      ["gone", "client_error"],
    ] as const) {
      await db.insert(pages).values({
        id: `${crawlId}_${slug}`,
        crawlId,
        url: `http://seeded.example/${slug}`,
        urlNormalised: `http://seeded.example/${slug}`,
        statusCode: fetchClass === "blocked" ? 429 : 200,
        fetchClass,
        depth: 1,
        discoveredVia: "link",
        rendered: false,
      });
    }

    const res = await fetch(`${base}/crawls/${crawlId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["blockedPages"]).toBe(2);
    // A seeded row no crawl loop ever ran: null means "never reported", which
    // is a different fact from a spacing of 0.
    expect(body["hostSpacingMs"]).toBeNull();
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

  // A queued row nobody holds was the gap this endpoint left open: visible in
  // `GET /crawls`, `queuePosition: null` — work a dead process accepted and
  // nothing will ever run — and until now not closeable either, because the
  // endpoint asked for 'running'. The process-truth test is the same one the
  // running case makes: this server refuses to close work IT is holding.
  it("closes a queued row no process is holding", async () => {
    const id = await seedCrawl({ status: "queued" });
    const res = await call("POST", `/crawls/${id}/fail`);
    expect(res.status).toBe(200);
    expect(res.body["status"]).toBe("failed");
    expect(res.body["finishedAt"]).not.toBeNull();
  });

  it("409s a queued crawl this server is holding in its own queue", async () => {
    // Two crawls with a per-host delay: the second waits behind the first, in
    // THIS process's queue, so its row is 'queued' and `queuePosition` is a
    // number. That is live work, not an orphan.
    const first = await startCrawl({ siteUrl: `${site}/`, maxPages: 3, perHostDelayMs: 400 });
    const second = await startCrawl({ siteUrl: `${site}/`, maxPages: 3, perHostDelayMs: 400 });
    const secondId = String(second.body["crawlId"]);

    const res = await call("POST", `/crawls/${secondId}/fail`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("this server");

    await settle(String(first.body["crawlId"]));
    await settle(secondId);
  }, 60_000);

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

    // AND THE DOCUMENTS LANDED WHERE THE SERVER WAS TOLD (P8-T1 fix round 1).
    // The pass writes one HTML file per rendered page, and where they go is a
    // SERVER property — `ServiceConfig.renderDir`, absolutised at construction
    // — never a request field. Before it was plumbed, this endpoint used the
    // pass's cwd-relative default and this very suite left twelve crawl
    // directories in the repository. Asserted from the page rows rather than by
    // listing the directory, so what is checked is the pointer a reader
    // actually follows.
    const rows = await db
      .select({ path: pages.renderedHtmlPath })
      .from(pages)
      .where(and(eq(pages.crawlId, fixtureCrawlId), eq(pages.rendered, true)));
    expect(rows.length).toBe(Number(res.body["rendered"]));
    for (const row of rows) {
      expect(row.path, "every rendered page keeps its document").not.toBeNull();
      // Under this server's configured root, and ABSOLUTE — the stored pointer
      // has to mean the same thing to a reader standing somewhere else.
      expect(row.path!.startsWith(`${renderDir}/`)).toBe(true);
      expect(isAbsolute(row.path!)).toBe(true);
      expect(existsSync(row.path!), `${row.path!} exists on disk`).toBe(true);
    }
  }, 60_000);
});

/**
 * P8-T2 — the agent names the pages.
 *
 * ON ITS OWN CRAWL, deliberately. An explicit pass REPLACES the automatic
 * selection and leaves a record of itself on the crawl row, so running one over
 * `fixtureCrawlId` would change what every later test in this file reads about
 * that crawl's rendering. A second crawl of the same three-page fixture costs a
 * second and keeps the two stories separate.
 *
 * `renderMaxPages: 2` is set at crawl start so the cap has something to bite on:
 * the site has three pages, so a list naming all three is over it.
 */
describe("POST /crawls/:id/render with a named list", () => {
  let namedCrawlId = "";

  beforeAll(async () => {
    const accepted = await startCrawl({ siteUrl: `${site}/`, maxPages: 5, renderMaxPages: 2 });
    expect(accepted.status).toBe(202);
    namedCrawlId = String(accepted.body["crawlId"]);
    await settle(namedCrawlId);
  }, 60_000);

  it("renders exactly the pages named, and records that it was told to", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, {
      // `/a` twice: a repeated URL is one page, not two, and it must not be
      // counted against the cap either.
      body: { urls: [`${site}/a`, `${site}/b`, `${site}/a`] },
    });
    expect(res.status).toBe(200);

    const selection = res.body["selection"] as Record<string, unknown>;
    expect(selection["mode"]).toBe("explicit");
    expect(selection["selected"]).toBe(2);
    // Null, not zero. No budget was computed and nothing was suspected — see
    // RenderSelection.mode. A zero here would read as an automatic selection
    // that found nothing worth rendering.
    expect(selection["budget"]).toBeNull();
    expect(selection["suspects"]).toBeNull();
    expect(selection["sampled"]).toBeNull();
    expect(selection["truncated"]).toBeNull();
    expect(Number(res.body["rendered"]) + Number(res.body["failures"])).toBe(2);
    expect(res.body["unrendered"]).toBe(0);

    // The pages rendered are the pages named, and nothing else. The home page
    // is what the AUTOMATIC selection would have reached first on this crawl,
    // so its absence is the property under test.
    const rendered = await db
      .select({ url: pages.url })
      .from(pages)
      .where(and(eq(pages.crawlId, namedCrawlId), eq(pages.rendered, true)));
    expect(rendered.map((r) => r.url).sort()).toEqual([`${site}/a`, `${site}/b`]);

    // And the record the coverage metric reads long afterwards: without it,
    // `render.coverage` would recompute the automatic decision and describe a
    // selection that never happened.
    //
    // MIGRATION 0012 MOVED THIS PIN: through Phase 8 the record was a
    // `renderUrls` key the pass patched into `config_jsonb`; it is now
    // `crawls.render_urls_jsonb`, and the crawl's stored config is untouched by
    // the render pass — which is the second half of what is asserted here,
    // because `storableConfig` is the only writer of that blob again.
    const [row] = await db
      .select({ config: crawls.config, renderUrls: crawls.renderUrlsJsonb })
      .from(crawls)
      .where(eq(crawls.id, namedCrawlId));
    expect(row!.renderUrls).toEqual([`${site}/a`, `${site}/b`]);
    expect(Object.keys(row!.config as Record<string, unknown>)).not.toContain("renderUrls");
  }, 60_000);

  it("400s a URL this crawl never fetched, naming it, rather than fetching it", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, {
      body: { urls: [`${site}/a`, `${site}/never-crawled`] },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain(`${site}/never-crawled`);
    expect(String(res.body["error"])).toContain("already fetched");
  });

  it("400s a list longer than the crawl's renderMaxPages instead of trimming it", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, {
      body: { urls: [`${site}/`, `${site}/a`, `${site}/b`] },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("renderMaxPages of 2");
  });

  it("403s a host the URL policy refuses, whoever asked for it", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, {
      // Link-local: refused even under the test-only allowPrivate hatch, which
      // this server has on. Hard rule 5 applies to a URL a client supplies.
      body: { urls: ["http://169.254.169.254/latest/meta-data"] },
    });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("URL policy");
  });

  it("403s a host outside the site's family and outside the allowlist", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, {
      body: { urls: ["http://192.168.7.7/somewhere"] },
    });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("crawl allowlist");
  });

  it("400s an empty list rather than rendering nothing and calling it a pass", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, { body: { urls: [] } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("empty list");
  });

  it("400s a body field it does not know rather than ignoring the instruction", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, {
      body: { pages: [`${site}/a`] },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("unknown field 'pages'");
  });

  it("400s urls that is not an array of strings", async () => {
    const res = await call("POST", `/crawls/${namedCrawlId}/render`, {
      body: { urls: `${site}/a` },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("must be an array of strings");
  });
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
    // Before: this crawl has never been judged, and the surface says so.
    const before = await call("GET", `/crawls/${fixtureCrawlId}`);
    expect(before.body["rulesRunAt"]).toBeNull();
    // Never judged, and the page count is already there: `pagesScanned`
    // describes the crawl's `pages` rows, not a run over them.
    expect(Number(before.body["pagesScanned"])).toBeGreaterThanOrEqual(3);

    const res = await call("POST", `/crawls/${fixtureCrawlId}/rules`);
    expect(res.status).toBe(200);
    expect(Number(res.body["pagesScanned"])).toBeGreaterThanOrEqual(3);
    expect(typeof res.body["findings"]).toBe("number");
    expect(typeof res.body["byRule"]).toBe("object");
    expect(typeof res.body["byMetric"]).toBe("object");

    // After: the marker is a timestamp, and the findings count on the detail is
    // the same number the run reported — the invariant `runRules` states about
    // itself (`count(issues where crawl_id) == summary.findings`), asked of the
    // surface instead of of the table.
    //
    // BOTH FIELDS OFF ONE RESPONSE, and one statement behind it: the pair is
    // what an agent interprets ("0 beside a timestamp" is a clean site), so the
    // two must describe the same snapshot. See `getCrawl`, and the
    // statement-level assertion in test/api/query.test.ts.
    const after = await call("GET", `/crawls/${fixtureCrawlId}`);
    const stamp = after.body["rulesRunAt"];
    expect(typeof stamp).toBe("string");
    expect(Number.isNaN(Date.parse(String(stamp)))).toBe(false);
    expect(Date.parse(String(stamp))).toBeGreaterThan(Date.parse(String(fixtureFinal["startedAt"])));
    expect(after.body["findingsCount"]).toBe(res.body["findings"]);
    // The same equality for the page count: the run counts its cursor's
    // iterations, the detail counts the rows the cursor walked, and the crawl's
    // `pages` rows did not move in between.
    expect(after.body["pagesScanned"]).toBe(res.body["pagesScanned"]);
    expect(before.body["pagesScanned"]).toBe(res.body["pagesScanned"]);
  }, 60_000);

  // A rules run REWRITES the crawl's issues — it deletes them at the top and
  // writes its own. Two runs over one crawl at once therefore interleave a
  // delete into the middle of the other's inserts, and the table is left
  // holding part of each: two judgements with nothing to tell them apart. The
  // second caller is refused rather than served.
  it("409s a second rules run while one is already judging the same crawl", async () => {
    const [a, b] = await Promise.all([
      call("POST", `/crawls/${fixtureCrawlId}/rules`),
      call("POST", `/crawls/${fixtureCrawlId}/rules`),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(String(refused.body["error"])).toContain("already being judged");

    // And the refusal is not sticky: the hold is released when the run ends,
    // so the crawl can be judged again straight afterwards.
    const after = await call("POST", `/crawls/${fixtureCrawlId}/rules`);
    expect(after.status).toBe(200);
  }, 120_000);
});

describe("GET /crawls/:id/robots", () => {
  it("hands back the robots.txt this crawl actually read, out of its stored evidence", async () => {
    const res = await call("GET", `/crawls/${fixtureCrawlId}/robots`);
    expect(res.status).toBe(200);
    expect(res.body["crawlId"]).toBe(fixtureCrawlId);
    expect(res.body["robotsUrl"]).toBe(`${site}/robots.txt`);
    expect(res.body["outcome"]).toBe("read");
    // The fixture server's own file, byte for byte — read at crawl time, not
    // re-fetched now. Nothing else on the surface carries this text.
    expect(res.body["raw"]).toBe(`User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
    expect(res.body["truncated"]).toBe(false);
    // The file declares no Crawl-delay, which is null rather than 0.
    expect(res.body["crawlDelaySec"]).toBeNull();
    expect(res.body["sitemapSources"]).toEqual([`${site}/sitemap.xml`]);
    // Nobody handed this crawl a sitemap, so the supplied half is present and
    // empty — the two lists together are "which sitemaps did this crawl read".
    expect(res.body["suppliedSitemaps"]).toEqual([]);
    // The agent the crawl identified as: the groups in this file that bound it.
    expect(String(res.body["userAgent"])).toContain("AriadneBot");
  });

  it("names the sitemaps the client supplied beside the ones robots.txt declared", async () => {
    const started = await startCrawl({
      siteUrl: `${site}/`,
      maxPages: 2,
      // The same document robots.txt declares, re-stated by the caller: it is
      // both declared and supplied, and the evidence says both.
      sitemapUrls: [`${site}/sitemap.xml`],
    });
    expect(started.status).toBe(202);
    const crawlId = String(started.body["crawlId"]);
    await settle(crawlId);

    const res = await call("GET", `/crawls/${crawlId}/robots`);
    expect(res.status).toBe(200);
    expect(res.body["sitemapSources"]).toEqual([`${site}/sitemap.xml`]);
    expect(res.body["suppliedSitemaps"]).toEqual([`${site}/sitemap.xml`]);
  });

  it("409s a crawl that never completed discovery, and 404s one nothing knows", async () => {
    const id = await seedCrawl({ status: "failed" });
    const missing = await call("GET", `/crawls/${id}/robots`);
    expect(missing.status).toBe(409);
    expect(String(missing.body["error"])).toContain("discovery evidence");

    expect((await call("GET", "/crawls/crawl_missing/robots")).status).toBe(404);
  });

  it("409s discovery evidence it cannot read rather than answering with half of it", async () => {
    // A row whose robots blob says its text is a prefix — with a non-boolean in
    // the flag that says so. Read permissively, `truncated` would be falsy and
    // the answer would present a 500KB prefix as the whole file.
    const id = await seedCrawl({
      status: "finished",
      discovery: {
        robots: { outcome: "read", crawlDelaySec: null, note: null, raw: "User-agent: *", truncated: "yes" },
        sitemapSources: [],
        truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 0 },
        docsFetched: 0,
      },
    });
    const res = await call("GET", `/crawls/${id}/robots`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("robots.truncated");
  });
});

describe("the judged-state marker across a re-judge", () => {
  it("clears the previous run's stamp and leaves this run's, rather than keeping the old one", async () => {
    // A crawl carrying a stamp from a run that happened long ago, with a
    // finding to match. The re-judge deletes that finding and stamps its own
    // time; if the delete and the clear were not one step, a reader could see
    // the old timestamp over the new run's half-written table.
    const id = await seedCrawl({ status: "finished", discovery: DISCOVERY });
    const before = new Date("2020-01-01T00:00:00.000Z");
    await db.update(crawls).set({ rulesRunAt: before }).where(eq(crawls.id, id));

    const stale = await call("GET", `/crawls/${id}`);
    expect(stale.body["rulesRunAt"]).toBe(before.toISOString());

    const run = await call("POST", `/crawls/${id}/rules`);
    expect(run.status).toBe(200);

    const after = await call("GET", `/crawls/${id}`);
    const stamp = Date.parse(String(after.body["rulesRunAt"]));
    expect(Number.isNaN(stamp)).toBe(false);
    expect(stamp).toBeGreaterThan(before.getTime());
    expect(after.body["findingsCount"]).toBe(run.body["findings"]);
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

describe("failure containment", () => {
  // THE ONE FAILURE THAT HAPPENS AFTER THE HEADERS, and the whole rule-7
  // argument for the streaming export route.
  //
  // Once `200 text/csv` is on the wire there is no status left to send, so a
  // database that dies half way through the rows leaves two choices: end the
  // response, which hands the client a SHORT CSV that parses cleanly and reads
  // as the whole export — a client concluding their site has fewer broken links
  // than it does — or destroy the connection, which every HTTP client reports as
  // a transport error. The route destroys.
  //
  // Untested, that is one `res.end()` away from silently becoming the first
  // behaviour with the suite still green, which is why this test exists and why
  // `riggedServer` grew a `flaky` mode to reach it: the first `execute` returns
  // the real rows and the one after it throws, which is a failure that can only
  // occur once the header and a row are already written.
  it("tears the response when a CSV export fails mid-stream, rather than truncating the file", async () => {
    const crawlId = await seedCrawl({ status: "finished" });
    for (const slug of ["a", "b", "c"]) {
      await db.insert(pages).values({
        id: `${crawlId}_${slug}`,
        crawlId,
        url: `http://seeded.example/${slug}`,
        urlNormalised: `http://seeded.example/${slug}`,
        statusCode: 200,
        fetchClass: "ok",
        depth: 1,
        discoveredVia: "link",
        rendered: false,
      });
    }

    const rig = await riggedServer(
      {},
      {
        execute: {
          // One batch of rows comes back for real; the loop's next round trip —
          // the one that would have ended the file — does not.
          failAfter: 1,
          throws: () => {
            throw new Error("database is unavailable (test rig)");
          },
        },
      },
    );

    try {
      const res = await fetch(
        `${rig.base}/crawls/${crawlId}/export?format=csv&view=internal_urls`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      // The status and the headers are real: they were sent before anything
      // failed, which is precisely the situation under test.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      // No length, so a truncated body is detectable at all.
      expect(res.headers.get("content-length")).toBeNull();

      let body: string | null = null;
      let transportError: unknown = null;
      try {
        body = await res.text();
      } catch (error) {
        transportError = error;
      }

      // THE ASSERTION THAT MATTERS: the client cannot read this as a complete
      // response. `res.end()` in place of `res.destroy()` would deliver a
      // four-line CSV here — header plus three pages — that every parser in the
      // world would accept as the export.
      expect(
        transportError,
        `the client received a complete-looking CSV: ${JSON.stringify(body)}`,
      ).not.toBeNull();
      expect(body).toBeNull();

      // And the failure is not silent on our side either: a correlation id in
      // the log, the stack with it, and nothing about either on the wire.
      const line = rig.log.find((l) => l.includes("csv export failed mid-stream"));
      expect(line, "the export tore the socket and said nothing").toBeDefined();
      expect(line).toContain("internal_urls");
      expect(line).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    } finally {
      await rig.api.close();
    }
  });

  it("survives a queue runner that cannot even record its own failure", async () => {
    // The queue's promise is held by nobody until `close()`. `runQueued` catches
    // the crawl's errors, but its catch writes to the database — so a database
    // that is gone makes the catch throw too, and in Node 22 an unhandled
    // rejection ends the process. One bad crawl would take the server with it.
    const rig = await riggedServer({
      update: () => {
        throw new Error("database is unavailable (test rig)");
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const res = await call("POST", "/crawls", {
        base: rig.base,
        body: { siteUrl: `${site}/`, maxPages: 1 },
      });
      expect(res.status).toBe(202);
      const crawlId = String(res.body["crawlId"]);
      createdCrawls.push(crawlId);

      // Wait on the line BOTH worlds produce — the crawl's own failure — so
      // that the assertions below are reached whether or not the fix is in
      // place. Waiting on the fix's own log line instead would fail this test
      // on a missing message and never demonstrate the fatal part.
      await waitFor("the crawl reported that it threw", () =>
        rig.log.some((line) => line.includes("threw —")),
      );
      // Give a rejection its turn to go unhandled before we look for one.
      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled, "the queue left a rejection for nobody to handle").toEqual([]);

      // And the failure is not silent: the runner says it could not record it.
      expect(
        rig.log.some((line) => line.includes("the queue runner itself failed")),
        "the runner swallowed its own failure",
      ).toBe(true);

      // And the honest consequence, read through a working connection: the row
      // is still 'queued', because the update that would have closed it is the
      // thing that failed. Visible, not silently lost.
      const rows = await db.select().from(crawls).where(eq(crawls.id, crawlId));
      expect(rows[0]?.status).toBe("queued");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rig.api.close();
    }
  });

  it("turns an unexpected throw into a 500 with a correlation id, and keeps the stack in the log", async () => {
    const rig = await riggedServer({
      select: () => {
        throw new Error("boom from /srv/ariadne/internal/secret.ts");
      },
    });
    try {
      const res = await call("GET", "/crawls/crawl_anything", { base: rig.base });
      expect(res.status).toBe(500);
      expect(res.body["error"]).toBe("internal error");
      const correlationId = String(res.body["correlationId"]);
      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);

      // Nothing about the inside of the process crossed the wire.
      const wire = JSON.stringify(res.body);
      expect(wire).not.toContain("boom");
      expect(wire).not.toContain("secret.ts");
      expect(wire).not.toContain("at ");

      // And all of it reached the log, under that id.
      const logged = rig.log.find((line) => line.includes(correlationId));
      expect(logged, "no log line carried the correlation id").toBeDefined();
      expect(logged).toContain("boom from /srv/ariadne/internal/secret.ts");
      expect(logged).toContain("at "); // the stack, not just the message
      expect(logged).toContain("/crawls/crawl_anything");
    } finally {
      await rig.api.close();
    }
  });

  it("maps a render-pass DEFECT to 500, not to the 409 its message prefix once bought", async () => {
    // The exact error the reviewer named: `runRenderPass` throws this
    // `RangeError` for a bad renderConcurrency, and its message begins
    // `runRenderPass: ` like every guard's does. Under the old prefix match it
    // became "the crawl is busy, try later" — advice to retry OUR bug. It is
    // injected here rather than provoked because the service never passes
    // renderConcurrency, which is precisely why nothing else can catch this.
    const rig = await riggedServer({
      execute: () => {
        throw new RangeError(
          "runRenderPass: renderConcurrency must be an integer ≥ 1, got 0",
        );
      },
    });
    try {
      const id = await seedCrawl({ status: "finished", discovery: DISCOVERY });
      const res = await call("POST", `/crawls/${id}/render`, { base: rig.base });
      expect(res.status).toBe(500);
      expect(res.body["error"]).toBe("internal error");
      expect(typeof res.body["correlationId"]).toBe("string");
    } finally {
      await rig.api.close();
    }
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

  it("reads the token, the allowlist, the port and both output directories", () => {
    const config = loadApiConfig({
      ARIADNE_API_TOKEN: TOKEN,
      DATABASE_URL: "postgres://x",
      ARIADNE_ALLOWED_DOMAINS: "example.com,*.example.org",
      ARIADNE_API_PORT: "9123",
      ARIADNE_RENDER_DIR: "/srv/ariadne/renders",
      ARIADNE_EXPORT_DIR: "/srv/ariadne/exports",
    });
    expect(config.token).toBe(TOKEN);
    expect(config.allowedDomains).toEqual(["example.com", "*.example.org"]);
    expect(config.port).toBe(9123);
    // WHERE THE RENDER PASS PUTS ITS DOCUMENTS is an operator's choice from
    // P8-T1, because it is the one output of this server that grows on its own:
    // a file per rendered page, forever, wherever the process was started.
    // Unlike `crawlDefaults` it is safe to read from the environment — it names
    // where our own output lands, never what the server may do.
    expect(config.renderDir).toBe("/srv/ariadne/renders");
    // The exports directory joined it in P8-T6 on the same argument, measured:
    // the Phase 8 gate's deliverable run left one crawl's 384KB export in the
    // repository because this variable did not exist. On a billed audit the
    // export is the normal path, not the exception.
    expect(config.exportDir).toBe("/srv/ariadne/exports");
  });

  it("leaves both output directories undefined when nothing names them", () => {
    // Unset is not an error and is not a path this function invents: it means
    // "use the default", and each default (`renders/` and `exports/` under the
    // cwd) is named once, in `ServiceConfig`, where the service applies it.
    const config = loadApiConfig({ ARIADNE_API_TOKEN: TOKEN, DATABASE_URL: "postgres://x" });
    expect(config.renderDir).toBeUndefined();
    expect(config.exportDir).toBeUndefined();
  });
});

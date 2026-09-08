/**
 * `allowAnyPublicHost`: the open-allowlist posture, and the line it does NOT cross.
 *
 * The demo entrypoint's whole point is "type any URL", which the crawl-trigger
 * allowlist exists to forbid. So the posture is a second process-trust seam
 * beside `crawlDefaults` — code-level, never wired to env or wire — and the
 * thing that has to be proven is not that it opens the allowlist (one boolean),
 * but that it opens ONLY the allowlist: `isUrlAllowed` (hard rule 5, the SSRF
 * perimeter) still answers on every URL, and `allowPrivate` still comes from
 * `crawlDefaults` alone.
 *
 * Three servers make that a comparison rather than an assertion. `openBase`
 * carries the posture AND the test suite's usual `allowPrivate` seam, so the
 * loopback fixture is crawlable; `openNoPrivateBase` carries the posture and
 * NOTHING else, which is the demo's real shape and the server that shows
 * loopback still refused; `controlBase` carries neither, which is today's
 * refuse-everything behaviour, unmoved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { loadApiConfig } from "../../src/api/config.js";

const TOKEN = "test-token-0123456789abcdef";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
/**
 * The site the postures are pointed at: two pages, a sitemap, permissive
 * robots. Bound on every interface rather than on 127.0.0.1, so the SAME
 * server also answers as `www.localhost` — the second host the sitemapUrls
 * test needs, since a URL on the site's own host never reaches the allowlist
 * gate at all (`checkAddedHosts` skips the site's own family).
 */
let siteServer: Server;
let site: string;
let otherHost: string;

/** Posture on, `allowPrivate` on: the server that can crawl the fixture. */
let openApi: ApiServer;
let openBase: string;
/** Posture on, nothing else: the demo's real shape. */
let openNoPrivateApi: ApiServer;
let openNoPrivateBase: string;
/** Neither: an empty allowlist as it behaves today. */
let controlApi: ApiServer;
let controlBase: string;

const createdCrawls: string[] = [];
const serverLog: string[] = [];

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Poll a crawl until it stops moving. Returns its final detail. */
async function settle(
  base: string,
  crawlId: string,
  deadlineMs = 25_000,
): Promise<Record<string, unknown>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const res = await call(base, "GET", `/crawls/${crawlId}`);
    if (res.status !== 200) throw new Error(`settle: GET returned ${res.status}`);
    const status = res.body["status"];
    if (status !== "queued" && status !== "running") return res.body;
    if (Date.now() > until) throw new Error(`settle: crawl ${crawlId} still '${String(status)}'`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startCrawl(base: string, body: Record<string, unknown>): Promise<Res> {
  const res = await call(base, "POST", "/crawls", body);
  const id = res.body["crawlId"];
  if (typeof id === "string") createdCrawls.push(id);
  return res;
}

/**
 * A cancelled `crawls` row written straight into the database, on a host no
 * allowlist names and no resolver answers for.
 */
async function seedCancelledCrawl(siteUrl: string): Promise<string> {
  const id = `crawl_seed_${createdCrawls.length}_${Date.now()}`;
  await db.insert(crawls).values({
    id,
    siteUrl,
    config: {
      siteUrl,
      maxPages: 10,
      maxDepth: 3,
      userAgent: "AriadneBot/0.1 (test)",
      perHostDelayMs: 0,
      maxConcurrency: 2,
    },
    rulesetVersion: "0.0.0-test",
    status: "cancelled",
  });
  createdCrawls.push(id);
  return id;
}

/** What `loadApiConfig` insists on, and nothing else. */
function minimalEnv(): NodeJS.ProcessEnv {
  return {
    ARIADNE_API_TOKEN: TOKEN,
    DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/unused",
  };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  siteServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${site}/</loc></url><url><loc>${site}/two</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="en"><head><title>open posture fixture</title>` +
        `<meta name="description" content="fixture"></head>` +
        `<body><h1>fixture</h1><a href="/two">two</a></body></html>`,
    );
  });
  await new Promise<void>((r) => siteServer.listen(0, r));
  const addr = siteServer.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  site = `http://127.0.0.1:${port}`;
  otherHost = `http://www.localhost:${port}`;

  openApi = createApiServer({
    db,
    config: {
      token: TOKEN,
      allowedDomains: [],
      allowAnyPublicHost: true,
      // PROCESS TRUST, NOT WIRE TRUST — the seam the whole suite uses, so the
      // loopback fixture is crawlable. It is a SECOND, separate decision from
      // the posture above, which is the point of `openNoPrivateApi` below.
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      log: (line) => serverLog.push(line),
    },
  });
  const openBound = await openApi.listen(0);
  openBase = `http://127.0.0.1:${openBound.port}`;

  openNoPrivateApi = createApiServer({
    db,
    config: {
      token: TOKEN,
      allowedDomains: [],
      allowAnyPublicHost: true,
      log: (line) => serverLog.push(line),
    },
  });
  const openNoPrivateBound = await openNoPrivateApi.listen(0);
  openNoPrivateBase = `http://127.0.0.1:${openNoPrivateBound.port}`;

  controlApi = createApiServer({
    db,
    config: { token: TOKEN, allowedDomains: [], log: (line) => serverLog.push(line) },
  });
  const controlBound = await controlApi.listen(0);
  controlBase = `http://127.0.0.1:${controlBound.port}`;
}, 60_000);

afterAll(async () => {
  await openApi.close();
  await openNoPrivateApi.close();
  await controlApi.close();
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
});

describe("the allowAnyPublicHost posture", () => {
  it("accepts a host no allowlist names when the posture is set", async () => {
    const res = await startCrawl(openBase, { siteUrl: `${site}/`, maxPages: 5 });
    expect(res.status).toBe(202);
    // Settled so the row is complete and the cleanup is orderly.
    const done = await settle(openBase, String(res.body["crawlId"]));
    expect(done["status"]).toBe("finished");
  }, 40_000);

  it("still refuses everything on an empty allowlist without the posture", async () => {
    const res = await startCrawl(controlBase, { siteUrl: `${site}/` });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("allowlist is empty");
  });

  it("the posture does not touch url-policy: loopback is refused with the policy's own reason", async () => {
    const res = await startCrawl(openNoPrivateBase, { siteUrl: "http://127.0.0.1:9/" });
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("refused by the URL policy");
    expect(String(res.body["error"])).not.toContain("allowlist");
  });

  it("legacyHosts and sitemapUrls pass the allowlist gate under the posture", async () => {
    const res = await startCrawl(openBase, {
      siteUrl: `${site}/`,
      maxPages: 5,
      legacyHosts: ["www.localhost"],
      sitemapUrls: [`${otherHost}/sitemap.xml`],
    });
    // Without the posture these hosts are the 403: neither is the site's own
    // family, so each has to be on the allowlist in its own right.
    expect(res.status).toBe(202);
    await settle(openBase, String(res.body["crawlId"]));
  }, 40_000);

  it("the resume gate answers the policy question, not the allowlist question", async () => {
    // A seeded cancelled crawl on a host nobody allowlisted: under the posture
    // the allowlist gate passes and the URL POLICY is what answers. Without the
    // posture the same request dies at the allowlist. One row, two servers, two
    // different 403 texts — the posture changes WHICH gate refuses, not whether
    // one does.
    //
    // The seeded target is loopback and the open server here is the one WITHOUT
    // `allowPrivate`, because the policy's verdict is about a URL's shape and
    // its addresses: a name that resolves to nothing (`seeded.example`) is
    // allowed at accept time and refused at fetch time, so it would sail past
    // this gate and be answered by the crawl's own state instead.
    const id = await seedCancelledCrawl("http://127.0.0.1:9/");
    const open = await call(openNoPrivateBase, "POST", `/crawls/${id}/resume`);
    expect(open.status).toBe(403);
    expect(String(open.body["error"])).toContain("URL policy");
    expect(String(open.body["error"])).not.toContain("allowlist");
    const control = await call(controlBase, "POST", `/crawls/${id}/resume`);
    expect(control.status).toBe(403);
    expect(String(control.body["error"])).toContain("allowlist");
  });

  it("loadApiConfig can never set the posture from the environment", () => {
    const cfg = loadApiConfig({
      ...minimalEnv(),
      ARIADNE_ALLOW_ANY_PUBLIC_HOST: "true",
    });
    expect("allowAnyPublicHost" in cfg).toBe(false);
  });
});

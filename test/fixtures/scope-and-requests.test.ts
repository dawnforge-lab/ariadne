/**
 * Phase 27c T10: the gate's clauses, end to end through the API, against the
 * shared fixture site's gated areas (`/auth/*`, `/cookie-gated`,
 * `/header-gated`, the 12-hop `/chain/*`).
 *
 *  - each gate answers with its credential and refuses without it;
 *  - a credential never crosses to another host (`localhost` is not in
 *    127.0.0.1's site family);
 *  - the redirect cap names itself, and a raised cap reaches the end;
 *  - a list crawl of the fixture hub's own links classifies every listed URL
 *    and `crawl.list-mode` names what it did not measure;
 *  - the secret scan: after a crawl with all three credential kinds and a
 *    render pass, no secret is in any text/varchar/jsonb column of the crawl's
 *    tables or in the server's log.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, getTableName, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { CRAWL_CHILD_TABLES } from "../../src/api/crawl-delete.js";
import { buildRegistry } from "../../src/rules/index.js";
import { allFixtures } from "./fixture.js";
import { CHAIN_LENGTH, startFixtureApp, type FixtureApp } from "./app.js";
import { startAssetHost, type AssetHost } from "./assets.js";
import { startOffsiteHost, type OffsiteHost } from "./pages/render-p5.js";

const TOKEN = "test-token-scope-and-requests-0123456789";

/** Distinctive secrets for the scan's own fixture server: none matches page text. */
const SCAN_USER = "scan-user-Zq7";
const SCAN_PASSWORD = "scan-pw-Zq7";
const SCAN_COOKIE = "scan-cookie-Zq7";
const SCAN_HEADER = "scan-header-Zq7";
const SCAN_BASIC = Buffer.from(`${SCAN_USER}:${SCAN_PASSWORD}`, "utf8").toString("base64");
const SCAN_SECRETS = [SCAN_USER, SCAN_PASSWORD, SCAN_COOKIE, SCAN_HEADER, SCAN_BASIC, "Zq7"];

const DEFAULT_CREDENTIALS = {
  httpAuth: { username: "ariadne", password: "fixture" },
  cookies: [{ name: "session", value: "ok" }],
  requestHeaders: { "x-fixture-key": "k1" },
};

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let db: Db;
let exportDir: string;
let renderDir: string;
let app: FixtureApp;
let scanApp: FixtureApp;
let assetHost: AssetHost;
let offsite: OffsiteHost;
let api: ApiServer;
let base: string;
const serverLog: string[] = [];
const createdCrawls: string[] = [];

interface Res {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function until(id: string, timeoutMs = 170_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await call("GET", `/crawls/${id}`);
    if (res.status !== 200) throw new Error(`GET /crawls/${id}: ${res.status} ${res.text}`);
    const status = res.body["status"];
    if (status !== "queued" && status !== "running") return res.body;
    if (Date.now() > deadline) throw new Error(`crawl ${id} still ${String(status)}`);
    await sleep(25);
  }
}

/** Start a crawl, wait for it, and answer its id; a crawl that did not finish is a loud error. */
async function crawl(body: Record<string, unknown>): Promise<string> {
  const res = await call("POST", "/crawls", { maxConcurrency: 1, ...body });
  if (res.status !== 202) throw new Error(`start: ${res.status} ${res.text}`);
  const id = String(res.body["crawlId"]);
  createdCrawls.push(id);
  const settled = await until(id);
  if (settled["status"] !== "finished") {
    throw new Error(`crawl ${id} ended ${String(settled["status"])}: ${JSON.stringify(settled)}`);
  }
  return id;
}

async function rowsOf(id: string): Promise<Map<string, { fetchClass: string; statusCode: number | null; reason: string | null }>> {
  const rows = await db
    .select({
      url: pages.url,
      fetchClass: pages.fetchClass,
      statusCode: pages.statusCode,
      reason: pages.fetchReason,
    })
    .from(pages)
    .where(eq(pages.crawlId, id));
  return new Map(rows.map((r) => [r.url, { fetchClass: r.fetchClass, statusCode: r.statusCode, reason: r.reason }]));
}

function gatedUrls(origin: string): string[] {
  return [`${origin}/auth/area`, `${origin}/cookie-gated`, `${origin}/header-gated`];
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-scope-requests-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-scope-requests-render-"));
  // Both before the app: the hub and a render fixture read these origins on
  // every request and throw if they are not up (the harness does the same).
  offsite = await startOffsiteHost();
  assetHost = await startAssetHost();
  app = await startFixtureApp(allFixtures());
  scanApp = await startFixtureApp([], {
    basic: `${SCAN_USER}:${SCAN_PASSWORD}`,
    cookie: SCAN_COOKIE,
    header: SCAN_HEADER,
  });
  api = createApiServer({
    db,
    config: {
      token: TOKEN,
      allowedDomains: ["127.0.0.1"],
      // `recheckMinGapMs`: the site serves a 5xx, whose recheck would otherwise
      // wait out a real minute (the harness sets the same, for the same reason).
      crawlDefaults: { allowPrivate: true, perHostDelayMs: 0, recheckMinGapMs: 200 },
      exportDir,
      renderDir,
      log: (line) => serverLog.push(line),
    },
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
}, 60_000);

afterAll(async () => {
  await api.close();
  await closeFetchAgents();
  await app.close();
  await scanApp.close();
  await assetHost.close();
  await offsite.close();
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
}, 60_000);

describe("each gate: credentials open it, their absence is a classified refusal", () => {
  it("a list crawl of the three gated URLs with credentials gives three ok rows", async () => {
    const urls = gatedUrls(app.base);
    const id = await crawl({ siteUrl: `${app.base}/`, mode: "list", urls, ...DEFAULT_CREDENTIALS });
    const rows = await rowsOf(id);
    for (const url of urls) {
      const row = rows.get(url);
      expect(row, url).toBeDefined();
      expect(row?.fetchClass, url).toBe("ok");
      expect(row?.statusCode, url).toBe(200);
    }
  });

  // A 401 or 403 is the fetch layer's `blocked` class (a WAF's answer reads the
  // same), so each refused URL is retried with the politeness back-off before
  // its row is final: these crawls are slow on purpose and run side by side.
  it("without a gate's credential that URL is a blocked 401/403 row and the other two are ok", async () => {
    const urls = gatedUrls(app.base);
    const { httpAuth, cookies, requestHeaders } = DEFAULT_CREDENTIALS;
    const withoutBasic = { cookies, requestHeaders };
    const withoutCookie = { httpAuth, requestHeaders };
    const withoutHeader = { httpAuth, cookies };
    const ids = await Promise.all(
      [{}, withoutBasic, withoutCookie, withoutHeader].map((creds) =>
        crawl({ siteUrl: `${app.base}/`, mode: "list", urls, ...creds }),
      ),
    );
    const [none, noBasic, noCookie, noHeader] = await Promise.all(ids.map((id) => rowsOf(id)));
    const refusal = [401, 403, 403];
    const blocked = (rows: Awaited<ReturnType<typeof rowsOf>> | undefined, i: number) => {
      const row = rows?.get(urls[i] ?? "");
      expect(row?.fetchClass, `${urls[i]} blocked`).toBe("blocked");
      expect(row?.statusCode, `${urls[i]} status`).toBe(refusal[i]);
    };
    const open = (rows: Awaited<ReturnType<typeof rowsOf>> | undefined, i: number) => {
      expect(rows?.get(urls[i] ?? "")?.fetchClass, `${urls[i]} ok`).toBe("ok");
    };
    for (let i = 0; i < 3; i++) blocked(none, i);
    blocked(noBasic, 0);
    open(noBasic, 1);
    open(noBasic, 2);
    blocked(noCookie, 1);
    open(noCookie, 0);
    open(noCookie, 2);
    blocked(noHeader, 2);
    open(noHeader, 0);
    open(noHeader, 1);
  }, 300_000);
});

describe("credentials do not cross to another host", () => {
  it("/auth/to-legacy redirects to localhost: the target is not fetched with authorization, cookie or the custom header", async () => {
    const mark = app.gatedRequests.length;
    const id = await crawl({
      siteUrl: `${app.base}/`,
      mode: "list",
      urls: [`${app.base}/auth/to-legacy`],
      ...DEFAULT_CREDENTIALS,
    });
    const rows = await rowsOf(id);
    // The redirect is a classified row, and nothing followed it off the site family.
    const source = rows.get(`${app.base}/auth/to-legacy`);
    expect(source?.fetchClass).toBe("redirect");
    expect([...rows.keys()].some((u) => u.startsWith(app.legacyBase))).toBe(false);

    const seen = app.gatedRequests.slice(mark);
    // The source was asked for, with its credentials, on its own host.
    const own = seen.filter((r) => r.host === new URL(app.base).host);
    expect(own.length).toBeGreaterThan(0);
    expect(own.some((r) => r.authorization !== null)).toBe(true);
    // Nothing reached the other name at all: the crawl does not follow a
    // redirect off the site family. That a request which DOES reach another
    // host carries none of them is proved on the wire by test/crawl/
    // credentials.test.ts "sends none of them to another host: a resource,
    // its robots.txt, a legacy host's probe, a redirect hop" (27c final wave M10).
    const legacyHost = new URL(app.legacyBase).host;
    expect(seen.filter((r) => r.host === legacyHost)).toEqual([]);
  });
});

describe("the redirect cap", () => {
  it("a list crawl of /chain/0 stops at /chain/10 and says maxRedirectHops is 10", async () => {
    const id = await crawl({ siteUrl: `${app.base}/`, mode: "list", urls: [`${app.base}/chain/0`], maxPages: 30 });
    const rows = await rowsOf(id);
    for (let n = 0; n <= 10; n++) {
      expect(rows.get(`${app.base}/chain/${n}`)?.fetchClass, `/chain/${n}`).toBe("redirect");
    }
    expect(rows.has(`${app.base}/chain/11`)).toBe(false);
    expect(rows.has(`${app.base}/chain/end`)).toBe(false);
    expect(rows.get(`${app.base}/chain/10`)?.reason).toContain("maxRedirectHops is 10");
  });

  it("with maxRedirectHops 20 the same list reaches /chain/end", async () => {
    const id = await crawl({
      siteUrl: `${app.base}/`,
      mode: "list",
      urls: [`${app.base}/chain/0`],
      maxPages: 30,
      maxRedirectHops: 20,
    });
    const rows = await rowsOf(id);
    for (let n = 0; n <= CHAIN_LENGTH; n++) {
      expect(rows.get(`${app.base}/chain/${n}`)?.fetchClass, `/chain/${n}`).toBe("redirect");
    }
    expect(rows.get(`${app.base}/chain/end`)).toMatchObject({ fetchClass: "ok", statusCode: 200 });
    for (const row of rows.values()) expect(row.reason ?? "").not.toContain("maxRedirectHops");
  });
});

describe("a list crawl of the fixture site", () => {
  it("classifies every URL the hub links, and crawl.list-mode names what was not measured", async () => {
    const hub = await fetch(`${app.base}/`).then((r) => r.text());
    const listed = [
      ...new Set(
        [...hub.matchAll(/<a href="([^"]+)"/g)].map((m) => {
          const url = normalizeUrl((m[1] ?? "").replaceAll("&amp;", "&"), `${app.base}/`);
          if (url === null) throw new Error(`hub link ${String(m[1])} does not normalise`);
          return url;
        }),
      ),
    ];
    expect(listed.length).toBeGreaterThan(50);

    const id = await crawl({ siteUrl: `${app.base}/`, mode: "list", urls: listed, maxConcurrency: 8 });
    const rows = await rowsOf(id);
    expect(
      listed.filter((url) => !rows.has(url)),
      `listed URLs with no row (${rows.size} rows for ${listed.length} listed)`,
    ).toEqual([]);

    const rules = await call("POST", `/crawls/${id}/rules`);
    expect(rules.status, rules.text).toBe(200);

    const registry = buildRegistry().all();
    const needsSpider = registry.filter((r) => r.needsSpider === true).map((r) => r.id);
    expect(needsSpider.length).toBeGreaterThan(0);

    const [marker] = await db
      .select({ details: issues.details })
      .from(issues)
      .where(and(eq(issues.crawlId, id), eq(issues.ruleId, "crawl.list-mode")));
    expect(marker, "crawl.list-mode wrote no finding").toBeDefined();
    const evidence = marker?.details as { notMeasured: string[]; partiallyMeasured: string[] };
    for (const ruleId of needsSpider) expect(evidence.notMeasured, ruleId).toContain(ruleId);
    // No `sitemapUrls` was given, so no sitemap was read and those rules are named too.
    const needsSitemaps = registry.filter((r) => r.needsSitemaps === true).map((r) => r.id);
    for (const ruleId of needsSitemaps) expect(evidence.notMeasured, ruleId).toContain(ruleId);
    const partial = registry.filter((r) => r.listPartial === true).map((r) => r.id);
    for (const ruleId of partial) expect(evidence.partiallyMeasured, ruleId).toContain(ruleId);

    // The graph is missing, and no rule that needs it fired because of that.
    const fired = await db
      .selectDistinct({ ruleId: issues.ruleId })
      .from(issues)
      .where(and(eq(issues.crawlId, id), inArray(issues.ruleId, needsSpider)));
    expect(fired.map((r) => r.ruleId)).toEqual([]);
  }, 180_000);
});

describe("the secret scan", () => {
  it("after a crawl with all three credential kinds and a render pass, no secret is in any stored column or the log", async () => {
    const urls = gatedUrls(scanApp.base);
    const credentials = {
      httpAuth: { username: SCAN_USER, password: SCAN_PASSWORD },
      cookies: [{ name: "session", value: SCAN_COOKIE }],
      requestHeaders: { "x-fixture-key": SCAN_HEADER },
    };
    const id = await crawl({
      siteUrl: `${scanApp.base}/`,
      mode: "list",
      urls,
      ...credentials,
    });
    const rows = await rowsOf(id);
    for (const url of urls) expect(rows.get(url)?.fetchClass, url).toBe("ok");

    const rendered = await call("POST", `/crawls/${id}/render`, { urls, ...credentials });
    expect(rendered.status, rendered.text).toBe(200);
    expect(rendered.body["rendered"]).toBe(urls.length);
    for (const secret of SCAN_SECRETS) expect(rendered.text, "the render answer").not.toContain(secret);

    // Every text, varchar and jsonb column of every crawl table, from the catalog.
    const names = [...CRAWL_CHILD_TABLES.map((t) => getTableName(t)), "crawls"];
    const columns = await db.execute(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = current_schema()
        and table_name in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
        and data_type in ('text', 'character varying', 'jsonb', 'ARRAY')
    `);
    const found = columns.rows as { table_name: string; column_name: string }[];
    expect(new Set(found.map((c) => c.table_name))).toEqual(new Set(names));
    for (const { table_name, column_name } of found) {
      const idColumn = table_name === "crawls" ? "id" : "crawl_id";
      for (const secret of SCAN_SECRETS) {
        const hit = await db.execute(sql`
          select count(*)::int as n
          from ${sql.identifier(table_name)}
          where ${sql.identifier(idColumn)} = ${id}
            and ${sql.identifier(column_name)}::text like ${`%${secret}%`}
        `);
        expect((hit.rows[0] as { n: number }).n, `${table_name}.${column_name} holds '${secret}'`).toBe(0);
      }
    }

    expect(serverLog.length).toBeGreaterThan(0);
    const log = serverLog.join("\n");
    for (const secret of SCAN_SECRETS) expect(log, "the server log").not.toContain(secret);
  }, 120_000);
});

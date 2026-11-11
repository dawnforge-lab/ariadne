/**
 * Phase 27c Task 5: credentials on the wire.
 *
 *  - `credentialHeadersFor` hands the custom headers, Basic auth and one
 *    `Cookie` header to a URL in the crawl's site family, and nothing to any
 *    other host.
 *  - `credentialError` refuses a malformed credential set, naming the field and
 *    the header or cookie NAME, never a value.
 *  - Over a real two-host fixture (`127.0.0.1` and `localhost` on one server):
 *    every request to the site carries them — the host probe, robots.txt, the
 *    sitemap, the pages, the recheck, the known-404 probe, a same-host
 *    resource — and every request to the other host carries none of them: a
 *    resource, its robots.txt, a legacy host's probe, and a sitemap redirect
 *    hop that crosses over.
 *  - The values are never stored: the crawl's rows hold none of them.
 *  - A crawl whose shape says it needs credentials and that has none is
 *    refused before its first request (`CredentialsMissingError`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import {
  CredentialsMissingError,
  MAX_COOKIES,
  MAX_CREDENTIAL_VALUE_BYTES,
  MAX_REQUEST_HEADERS,
  credentialError,
  credentialFieldError,
  credentialHeadersFor,
  credentialShapeError,
  redactionMarkerError,
  sameShape,
  shapeOf,
  type CrawlCredentials,
} from "../../src/crawl/credentials.js";
import {
  parseStoredConfig,
  resumeCrawl,
  runCrawl,
  storableConfig,
  type CrawlConfig,
} from "../../src/crawl/loop.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

// The secret values. Each is distinctive, so a scan for it cannot match
// anything else a crawl writes.
const HEADER_SECRET = "hdr-s3cret-7f1c";
const USERNAME = "usr-s3cret-2b9a";
const PASSWORD = "pwd-s3cret-8d4e";
const COOKIE_SECRET = "ck-s3cret-5a6f";
const SECRETS = [HEADER_SECRET, USERNAME, PASSWORD, COOKIE_SECRET];
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
const COOKIE_LINE = `session=${COOKIE_SECRET}; theme=dark`;

const CREDS: CrawlCredentials = {
  requestHeaders: { "X-Tenant": HEADER_SECRET },
  httpAuth: { username: USERNAME, password: PASSWORD },
  cookies: [
    { name: "session", value: COOKIE_SECRET },
    { name: "theme", value: "dark" },
  ],
};

describe("credentialHeadersFor", () => {
  it("sends all three kinds to the site family and nothing to another host", () => {
    expect(credentialHeadersFor("https://www.ex.com/a", "https://ex.com/", CREDS)).toEqual({
      "X-Tenant": HEADER_SECRET,
      authorization: BASIC,
      cookie: COOKIE_LINE,
    });
    expect(credentialHeadersFor("https://cdn.other.com/a", "https://ex.com/", CREDS)).toEqual({});
  });

  it("sends nothing over a scheme the site does not use, and nothing when no credentials were given", () => {
    // An https site's credentials never ride a plain-http request.
    expect(credentialHeadersFor("http://ex.com/a", "https://ex.com/", CREDS)).toEqual({});
    expect(credentialHeadersFor("https://ex.com/a", "https://ex.com/", undefined)).toEqual({});
  });
});

describe("shapeOf / sameShape", () => {
  it("records the names and whether auth was given, never a value", () => {
    const shape = shapeOf(CREDS);
    expect(shape).toEqual({
      requestHeaderNames: ["x-tenant"],
      httpAuth: true,
      cookieNames: ["session", "theme"],
    });
    expect(JSON.stringify(shape)).not.toMatch(/s3cret/);
    expect(shapeOf({})).toBeNull();
    expect(shapeOf({ requestHeaders: {}, cookies: [] })).toBeNull();
  });

  it("compares header names case-insensitively and in any order", () => {
    const a = shapeOf({ requestHeaders: { "X-A": "1", "x-b": "2" } });
    const b = shapeOf({ requestHeaders: { "x-b": "9", "x-a": "8" } });
    expect(sameShape(a, b)).toBe(true);
    expect(sameShape(a, shapeOf({ requestHeaders: { "x-a": "1" } }))).toBe(false);
    expect(sameShape(a, null)).toBe(false);
    expect(sameShape(null, null)).toBe(true);
  });
});

describe("credentialError", () => {
  const refused = [
    "host",
    "user-agent",
    "accept",
    "accept-encoding",
    "content-length",
    "connection",
    "transfer-encoding",
    "te",
    "upgrade",
    "cookie",
    "authorization",
    "proxy-anything",
  ];
  for (const name of refused) {
    it(`refuses the header name '${name}'`, () => {
      const error = credentialError({ requestHeaders: { [name]: "v-s3cret" } }, "crawl");
      expect(error).not.toBeNull();
      expect(error).toContain(name);
      expect(error).not.toContain("v-s3cret");
    });
  }

  it("refuses Proxy-Authorization, whatever its case", () => {
    const error = credentialError({ requestHeaders: { "Proxy-Authorization": "Basic v-s3cret" } }, "crawl");
    expect(error).toContain("Proxy-Authorization");
    expect(error).not.toContain("v-s3cret");
  });

  it("refuses a header value with CR LF, naming the header and not the value", () => {
    const error = credentialError(
      { requestHeaders: { "X-Tenant": "v-s3cret\r\nX-Injected: 1" } },
      "crawl",
    );
    expect(error).toContain("crawl.requestHeaders");
    expect(error).toContain("X-Tenant");
    expect(error).not.toContain("v-s3cret");
    expect(error).not.toContain("X-Injected");
  });

  it("refuses a header name that is not an HTTP token, and a value past the byte limit", () => {
    expect(credentialError({ requestHeaders: { "X Tenant": "v" } }, "crawl")).toContain("token");
    const long = "v-s3cret" + "x".repeat(MAX_CREDENTIAL_VALUE_BYTES);
    const error = credentialError({ requestHeaders: { "X-Long": long } }, "crawl");
    expect(error).toContain("X-Long");
    expect(error).not.toContain("v-s3cret");
  });

  it(`refuses ${MAX_REQUEST_HEADERS + 1} headers`, () => {
    const headers = Object.fromEntries(
      Array.from({ length: MAX_REQUEST_HEADERS + 1 }, (_, i) => [`x-h${i}`, "v"]),
    );
    expect(credentialError({ requestHeaders: headers }, "crawl")).toMatch(/limit is 20/);
    const ok = Object.fromEntries(
      Array.from({ length: MAX_REQUEST_HEADERS }, (_, i) => [`x-h${i}`, "v"]),
    );
    expect(credentialError({ requestHeaders: ok }, "crawl")).toBeNull();
  });

  it(`refuses ${MAX_COOKIES + 1} cookies`, () => {
    const cookies = Array.from({ length: MAX_COOKIES + 1 }, (_, i) => ({ name: `c${i}`, value: "v" }));
    expect(credentialError({ cookies }, "crawl")).toMatch(/limit is 50/);
    expect(credentialError({ cookies: cookies.slice(0, MAX_COOKIES) }, "crawl")).toBeNull();
  });

  it("refuses a username holding ':', without quoting it", () => {
    const error = credentialError({ httpAuth: { username: "u-s3cret:x", password: "p" } }, "crawl");
    expect(error).toContain("crawl.httpAuth.username");
    expect(error).not.toContain("u-s3cret");
  });

  it("refuses a cookie value with ';', ',' or whitespace, naming the cookie and not the value", () => {
    for (const value of ["v-s3cret;x=1", "v-s3cret,x", "v-s3cret x", "v-s3cret\u0001"]) {
      const error = credentialError({ cookies: [{ name: "session", value }] }, "crawl");
      expect(error).toContain("session");
      expect(error).not.toContain("v-s3cret");
    }
    expect(credentialError({ cookies: [{ name: "a b", value: "v" }] }, "crawl")).toContain("token");
  });

  it("refuses a malformed set and accepts a well-formed one", () => {
    expect(credentialError("nope", "crawl")).toContain("crawl");
    // An unknown key is named by position, never quoted (27c final wave M13).
    expect(credentialError({ extra: 1 }, "crawl")).toContain("unknown field (key 1");
    expect(credentialError({ httpAuth: { username: "u" } }, "crawl")).toContain("password");
    expect(credentialError({ cookies: [{ name: "a" }] }, "crawl")).toContain("cookies");
    expect(credentialError(CREDS, "crawl")).toBeNull();
  });

  it("no message it returns contains the offending value", () => {
    const secret = "zz-s3cret-zz";
    const cases: unknown[] = [
      { requestHeaders: { "X-A": `${secret}\n` } },
      { requestHeaders: { "X-A": `${secret}\u0000` } },
      { requestHeaders: { "X-A": secret.repeat(200) } },
      { requestHeaders: { "X-A": 7 } },
      { httpAuth: { username: `${secret}:`, password: secret } },
      { httpAuth: { username: secret, password: secret.repeat(200) } },
      { cookies: [{ name: "c", value: `${secret};` }] },
      { cookies: [{ name: "c", value: secret.repeat(200) }] },
    ];
    for (const c of cases) {
      const error = credentialError(c, "crawl");
      expect(error).not.toBeNull();
      expect(error).not.toContain(secret);
      expect(error).not.toContain("zz-s3");
    }
  });
});

// ---------------------------------------------------------------------------
// The two-host fixture: one server, reached as 127.0.0.1 (the site) and as
// localhost (another host). Every request it answers is recorded, headers and
// all, so the assertions read what actually crossed the wire.
// ---------------------------------------------------------------------------

interface Recorded {
  host: string;
  path: string;
  headers: IncomingHttpHeaders;
}

let db: Db;
let server: Server;
/** The site: `http://127.0.0.1:<port>`. */
let base: string;
/** The other host: `http://localhost:<port>`. */
let other: string;
let recorded: Recorded[] = [];
const createdCrawls: string[] = [];

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}

function site(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    recorded.push({ host, path, headers: req.headers });
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(
        host === "127.0.0.1"
          ? `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`
          : "User-agent: *\nAllow: /\n",
      );
      return;
    }
    if (path === "/sitemap.xml") {
      // A redirect hop that leaves the site family: discovery follows it, and
      // the hop to localhost must carry nothing.
      res.writeHead(301, { location: `${other}/sitemap-real.xml` });
      res.end();
      return;
    }
    if (path === "/sitemap-real.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${base}/from-sitemap</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    if (path === "/" && host === "127.0.0.1") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // The site tries to make the crawl stateful. It must not succeed.
        "set-cookie": "tracker=from-the-site; Path=/",
      });
      res.end(
        page(
          "Home",
          `<a href="/p2">two</a> <a href="/err">err</a>` +
            `<img src="/same.png" alt="same"> <img src="${other}/far.png" alt="far">`,
        ),
      );
      return;
    }
    if (path === "/p2" || path === "/from-sitemap" || path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(path, ""));
      return;
    }
    if (path === "/err") {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Error", ""));
      return;
    }
    if (path === "/same.png" || path === "/far.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": "0" });
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Not found", ""));
  });
}

function cfg(overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: `${base}/`,
    maxPages: 50,
    maxDepth: 5,
    userAgent: "AriadneBot-credentials-test",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    allowPrivate: true,
    probeHosts: false,
    recheckMinGapMs: 50,
    ...overrides,
  };
}

/** Every crawl-scoped table's rows for `crawlId`, as text, plus the crawl row. */
async function crawlText(crawlId: string): Promise<string> {
  const { rows: tables } = await db.execute<{ t: string }>(sql`
    select distinct c.table_name as t
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_name = c.table_name and tb.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'crawl_id'
      and tb.table_type = 'BASE TABLE'
  `);
  expect(tables.length).toBeGreaterThan(5);
  const parts: string[] = [];
  for (const { t } of tables) {
    const { rows } = await db.execute<{ body: string }>(
      sql`select coalesce(string_agg(row_to_json(x)::text, E'\n'), '') as body from ${sql.identifier(t)} x where x.crawl_id = ${crawlId}`,
    );
    parts.push(rows[0]?.body ?? "");
  }
  const { rows: own } = await db.execute<{ body: string }>(
    sql`select row_to_json(x)::text as body from crawls x where x.id = ${crawlId}`,
  );
  expect(own.length).toBe(1);
  parts.push(own[0]!.body);
  return parts.join("\n");
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  server = site();
  // No host: both 127.0.0.1 and localhost reach it (the `listenByName` precedent).
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
});

afterAll(async () => {
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("credentials on the wire", () => {
  let crawlId: string;

  beforeAll(async () => {
    recorded = [];
    const summary = await runCrawl(
      db,
      LOCAL_TENANT,
      cfg({
        probeHosts: true,
        legacyHosts: [other],
        credentials: CREDS,
        credentialShape: shapeOf(CREDS)!,
      }),
    );
    createdCrawls.push(summary.crawlId);
    crawlId = summary.crawlId;
    expect(summary.status).toBe("finished");
  }, 60_000);

  function on(host: string, path: string): Recorded[] {
    return recorded.filter((r) => r.host === host && r.path === path);
  }

  it("sends all three on the page fetch, robots.txt, the sitemap, the recheck, the 404 probe and a same-host resource", () => {
    const paths = ["/", "/robots.txt", "/sitemap.xml", "/p2", "/from-sitemap", "/err", "/same.png"];
    for (const path of paths) {
      const hits = on("127.0.0.1", path);
      expect(hits.length, `requests for ${path}`).toBeGreaterThan(0);
    }
    // The recheck asked /err a second time.
    expect(on("127.0.0.1", "/err").length).toBe(2);
    expect(recorded.some((r) => r.host === "127.0.0.1" && r.path.startsWith("/__ariadne-404-probe-"))).toBe(true);

    const site = recorded.filter((r) => r.host === "127.0.0.1");
    for (const r of site) {
      expect(r.headers["x-tenant"], r.path).toBe(HEADER_SECRET);
      expect(r.headers.authorization, r.path).toBe(BASIC);
      expect(r.headers.cookie, r.path).toBe(COOKIE_LINE);
      // Identity is not negotiable (rule 9).
      expect(r.headers["user-agent"], r.path).toBe("AriadneBot-credentials-test");
    }
  });

  it("sends none of them to another host: a resource, its robots.txt, a legacy host's probe, a redirect hop", () => {
    for (const path of ["/far.png", "/robots.txt", "/sitemap-real.xml", "/"]) {
      expect(on("localhost", path).length, `localhost requests for ${path}`).toBeGreaterThan(0);
    }
    const elsewhere = recorded.filter((r) => r.host !== "127.0.0.1");
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const r of elsewhere) {
      expect(r.headers["x-tenant"], r.path).toBeUndefined();
      expect(r.headers.authorization, r.path).toBeUndefined();
      expect(r.headers.cookie, r.path).toBeUndefined();
    }
  });

  it("does not send the site's Set-Cookie back on the next page", () => {
    const p2 = on("127.0.0.1", "/p2");
    expect(p2.length).toBeGreaterThan(0);
    for (const r of p2) expect(r.headers.cookie).toBe(COOKIE_LINE);
    expect(recorded.some((r) => (r.headers.cookie ?? "").includes("tracker"))).toBe(false);
  });

  it("records the credential headers redacted, and stores no secret value anywhere", async () => {
    const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(row!.requestHeaders).toMatchObject({
      "user-agent": "AriadneBot-credentials-test",
      "X-Tenant": "[redacted]",
      authorization: "[redacted]",
      cookie: "[redacted]",
    });
    const config = row!.config as Record<string, unknown>;
    expect(config["credentials"]).toBeUndefined();
    expect(config["credentialShape"]).toEqual(shapeOf(CREDS));

    const text = await crawlText(crawlId);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain(Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64"));
  });

  it("strips credentials from the stored config and never reads them back", () => {
    const stored = storableConfig(cfg({ credentials: CREDS, credentialShape: shapeOf(CREDS)! }));
    expect("credentials" in stored).toBe(false);
    const parsed = parseStoredConfig({ ...stored, credentials: CREDS }, "crawl_x");
    expect(parsed.credentials).toBeUndefined();
    expect(parsed.credentialShape).toEqual(shapeOf(CREDS));
  });

  it("refuses to resume without the credentials the row says it needs, and changes nothing", async () => {
    const [before] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    recorded = [];
    await expect(resumeCrawl(db, crawlId)).rejects.toBeInstanceOf(CredentialsMissingError);
    // A config override that omits them is refused too: the row decides.
    const { credentialShape: _shape, ...withoutShape } = parseStoredConfig(before!.config, crawlId);
    await expect(
      resumeCrawl(db, crawlId, { config: { ...withoutShape, allowPrivate: true } }),
    ).rejects.toBeInstanceOf(CredentialsMissingError);
    // And credentials of another shape are not the ones it needs.
    await expect(
      resumeCrawl(db, crawlId, {
        config: {
          ...parseStoredConfig(before!.config, crawlId),
          allowPrivate: true,
          credentials: { cookies: [{ name: "session", value: "v" }] },
        },
      }),
    ).rejects.toBeInstanceOf(CredentialsMissingError);
    expect(recorded).toEqual([]);
    const [after] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(after!.status).toBe(before!.status);
  });
});

describe("a crawl that needs credentials and has none", () => {
  it("throws CredentialsMissingError naming the fields, makes no request and writes no row", async () => {
    recorded = [];
    const siteUrl = `${base}/needs-auth/`;
    const error = await runCrawl(db, LOCAL_TENANT, cfg({ siteUrl, credentialShape: shapeOf(CREDS)! })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CredentialsMissingError);
    const message = (error as Error).message;
    expect(message).toContain("x-tenant");
    expect(message).toContain("httpAuth");
    expect(message).toContain("session");
    expect(recorded).toEqual([]);
    const rows = await db.select().from(crawls).where(eq(crawls.siteUrl, siteUrl));
    expect(rows).toEqual([]);
  });

  it("refuses credentials supplied without a shape to store", async () => {
    recorded = [];
    await expect(runCrawl(db, LOCAL_TENANT, cfg({ credentials: CREDS }))).rejects.toThrow(/credentialShape/);
    expect(recorded).toEqual([]);
  });
});

// undici refuses both names at send time, so a crawl that carried one would
// fail on its first request; refused at validation instead (27c T8 ruling).
describe("the header names undici refuses to send", () => {
  it("refuses the header name 'expect', whatever its case, without quoting the value", () => {
    for (const name of ["expect", "Expect"]) {
      const error = credentialError({ requestHeaders: { [name]: "100-v-s3cret" } }, "crawl");
      expect(error, name).toContain(name);
      expect(error, name).toContain("refused");
      expect(error, name).not.toContain("v-s3cret");
    }
  });

  it("refuses the header name 'keep-alive', whatever its case, without quoting the value", () => {
    for (const name of ["keep-alive", "Keep-Alive"]) {
      const error = credentialError({ requestHeaders: { [name]: "timeout=5-v-s3cret" } }, "crawl");
      expect(error, name).toContain(name);
      expect(error, name).toContain("refused");
      expect(error, name).not.toContain("v-s3cret");
    }
  });
});

// 27c T9 (Task 5 review): an override config stating a SMALLER shape than the
// row's must not be the way a crawl that needed more resumes with less.
describe("resumeCrawl: the row's stored shape decides", () => {
  it("refuses an override whose credentialShape differs from the row's, naming the crawl, before any request", async () => {
    const crawlId = `crawl_credentials_shape_${Date.now()}`;
    const stored = storableConfig(cfg({ credentialShape: shapeOf(CREDS)! }));
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id: crawlId,
      siteUrl: stored.siteUrl, hostKey: hostKeyOf(stored.siteUrl),
      config: stored,
      rulesetVersion: "test",
      status: "paused",
      pauseReason: "request",
    });
    createdCrawls.push(crawlId);
    recorded = [];
    const smaller: CrawlCredentials = { httpAuth: { username: USERNAME, password: PASSWORD } };
    const error = await resumeCrawl(db, crawlId, {
      config: { ...cfg(), credentials: smaller, credentialShape: shapeOf(smaller)! },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(crawlId);
    expect((error as Error).message).toContain("credentialShape");
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    expect(recorded).toEqual([]);
    const [after] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(after!.status).toBe("paused");
  });
});

describe("credential validation, the final wave (27c)", () => {
  it("refuses a sec- header name, whatever its case, beside proxy- (M5)", () => {
    for (const name of ["sec-ch-ua", "Sec-Fetch-Mode", "sec-anything"]) {
      const error = credentialError({ requestHeaders: { [name]: "v-s3cret" } }, "crawl");
      expect(error, name).toContain(name);
      expect(error, name).toContain("refused");
      expect(error, name).not.toContain("v-s3cret");
    }
    // A name that merely contains "sec" is a header like any other.
    expect(credentialError({ requestHeaders: { "x-sec-token": "v" } }, "crawl")).toBeNull();
  });

  it("never quotes a mis-shaped name or an unknown key: it names the position (M13)", () => {
    const probes: Array<[keyof CrawlCredentials, unknown, string]> = [
      ["cookies", [{ name: "session=S3CRET", value: "" }], "cookies[0].name"],
      ["cookies", [{ name: "ok", value: "v" }, { name: "a", value: "b", "x=S3CRET": "" }], "cookies[1]"],
      ["requestHeaders", { "x-ok": "v", "Authorization: Bearer S3CRET": "" }, "requestHeaders entry 2"],
      ["httpAuth", { username: "u", password: "p", "S3CRET": "" }, "httpAuth"],
    ];
    for (const [field, value, says] of probes) {
      const error = credentialFieldError(field, value);
      expect(error, says).not.toBeNull();
      expect(error, says).toContain(says);
      expect(error, says).not.toContain("S3CRET");
    }
    expect(credentialFieldError("httpAuth", { username: "u", password: "p", "S3CRET": "" })).toContain(
      "key 3",
    );
    const top = credentialError({ requestHeaders: {}, "S3CRET": 1 }, "crawl");
    expect(top).toContain("key 2");
    expect(top).not.toContain("S3CRET");
    // A redaction marker under a mis-shaped name is named by position too.
    const marked = redactionMarkerError("requestHeaders", { "Authorization: Bearer S3CRET": "[redacted]" });
    expect(marked).toContain("requestHeaders entry 1");
    expect(marked).not.toContain("S3CRET");
    const cookie = redactionMarkerError("cookies", [{ name: "session=S3CRET", value: "[redacted]" }]);
    expect(cookie).toContain("cookies[0]");
    expect(cookie).not.toContain("S3CRET");
  });

  it("checks a stored shape's keys and names as the value validators do (M7)", () => {
    const ok = { requestHeaderNames: ["x-tenant"], httpAuth: true, cookieNames: ["sid"] };
    expect(credentialShapeError(ok, "shape")).toBeNull();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...ok, extra: 1 }, "unknown field"],
      [{ ...ok, requestHeaderNames: ["x tenant"] }, "shape.requestHeaderNames[0]"],
      [{ ...ok, requestHeaderNames: ["user-agent"] }, "refused"],
      [{ ...ok, requestHeaderNames: ["sec-ch-ua"] }, "refused"],
      [{ ...ok, requestHeaderNames: ["x-a", "X-A"] }, "twice"],
      [{ ...ok, cookieNames: ["sid", "sid"] }, "twice"],
      [{ ...ok, cookieNames: ["a=b"] }, "shape.cookieNames[0]"],
    ];
    for (const [shape, says] of cases) {
      const error = credentialShapeError(shape, "shape");
      expect(error, JSON.stringify(shape)).toContain(says);
    }
    expect(credentialShapeError({ ...ok, cookieNames: ["a=S3CRET"] }, "shape")).not.toContain("S3CRET");
  });
});

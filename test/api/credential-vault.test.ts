/**
 * Phase 28b T2: the credential vault — AES-256-GCM in `crawl_credentials`,
 * which replaced the in-memory `CredentialStore` (27c/27d).
 *
 * First the vault against the real database: the round trip, the associated
 * data (another crawl's ciphertext, a flipped byte, a replayed generation),
 * the keys (a previous key decrypts, an unknown one does not), the boot
 * parser, removal and the retention sweep. Then the service: a credential
 * change commits with its config (the 27d R17 same-shape window, closed), a
 * refused change leaves the stored copy as it was, and a queued crawl whose
 * copy is unreadable is paused `credentials_unreadable` before any request.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawlCredentials, crawls, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import {
  CredentialVault,
  parseCredentialKeys,
  parseCredentialRetentionDays,
  type CredentialKeys,
} from "../../src/crawl/credential-vault.js";
import type { CrawlCredentials } from "../../src/crawl/credentials.js";
import { LOCAL_TENANT, parseTenant } from "../../src/tenant.js";
import { otherKey, TEST_CREDENTIAL_KEY, TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

const TOKEN = "test-token-credential-vault-0123456789";
const OLD_VALUE = "old-hdr-S3CRET";
const NEW_VALUE = "new-hdr-S3CRET";
const VALUES: CrawlCredentials = {
  requestHeaders: { "X-Fixture-Key": OLD_VALUE },
  httpAuth: { username: "user-S3CRET", password: "pw-S3CRET" },
  cookies: [{ name: "sid", value: "cookie-S3CRET" }],
};

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
const createdCrawls: string[] = [];

/** A crawl row with nothing but what the vault and the sweep read. */
async function seedCrawl(
  status = "paused",
  finishedAt: Date | null = null,
  tenant = LOCAL_TENANT,
): Promise<string> {
  const id = `crawl_vault_${randomUUID()}`;
  await db.insert(crawls).values({
    id,
    tenantId: tenant,
    siteUrl: "https://vault.test/",
    config: { siteUrl: "https://vault.test/" },
    rulesetVersion: "0.0.0-test",
    status,
    ...(status === "paused" ? { pauseReason: "request" } : {}),
    finishedAt,
  });
  createdCrawls.push(id);
  return id;
}

async function writeVia(vault: CredentialVault, crawlId: string, creds: CrawlCredentials = VALUES): Promise<number> {
  return await db.transaction(async (tx) => await vault.write(tx, LOCAL_TENANT, crawlId, creds));
}

async function rowOf(crawlId: string) {
  const [row] = await db.select().from(crawlCredentials).where(eq(crawlCredentials.crawlId, crawlId));
  return row;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
}, 60_000);

afterAll(async () => {
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await closeDb(db);
}, 60_000);

describe("CredentialVault: the round trip", () => {
  it("write then read gives the same values, and nothing of them is in the row in clear", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const id = await seedCrawl();
    expect(await vault.read(id)).toEqual({ kind: "none" });
    const generation = await writeVia(vault, id);
    expect(generation).toBe(1);
    expect(await vault.read(id)).toEqual({ kind: "ok", credentials: VALUES, generation: 1 });

    const row = await rowOf(id);
    expect(row?.keyId).toBe(TEST_CREDENTIAL_KEY.id);
    expect(row?.tenantId).toBe(LOCAL_TENANT);
    expect(row?.generation).toBe(1);
    expect(row?.nonce.length).toBe(12);
    const clear = Buffer.from(JSON.stringify(VALUES), "utf8");
    // The tag is 16 bytes on top of a ciphertext as long as the plaintext.
    expect(row?.ciphertext.length).toBe(clear.length + 16);
    for (const secret of [OLD_VALUE, "user-S3CRET", "pw-S3CRET", "cookie-S3CRET", "S3CRET"]) {
      expect(row?.ciphertext.includes(Buffer.from(secret, "utf8")), secret).toBe(false);
    }
  });

  it("every write draws a fresh nonce and bumps the crawl's generation", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const id = await seedCrawl();
    await writeVia(vault, id);
    const first = await rowOf(id);
    expect(await writeVia(vault, id)).toBe(2);
    const second = await rowOf(id);
    expect(second?.nonce.equals(first?.nonce ?? Buffer.alloc(0))).toBe(false);
    const [crawl] = await db.select({ g: crawls.credentialGeneration }).from(crawls).where(eq(crawls.id, id));
    expect(crawl?.g).toBe(2);
  });

  it("refuses to write for a crawl of another tenant, or no credentials at all, naming no value", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const id = await seedCrawl("paused", null, parseTenant("someone-else"));
    await expect(writeVia(vault, id)).rejects.toThrow(/no crawl .* of this tenant/);
    expect(await rowOf(id)).toBeUndefined();
    const mine = await seedCrawl();
    await expect(writeVia(vault, mine, {})).rejects.toThrow(/no credentials to write/);
    const bad = writeVia(vault, mine, { requestHeaders: { "x-a": "line\nbreak-S3CRET" } });
    await expect(bad).rejects.toThrow(/refusing to write invalid credentials/);
    await bad.catch((error: unknown) => expect(String(error)).not.toContain("S3CRET"));
  });

  it("remove deletes the row, on the database or in a transaction", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const id = await seedCrawl();
    await writeVia(vault, id);
    await vault.remove(db, id);
    expect(await vault.read(id)).toEqual({ kind: "none" });
    await writeVia(vault, id);
    await db.transaction(async (tx) => vault.remove(tx, id));
    expect(await rowOf(id)).toBeUndefined();
    // A later write keeps counting: a removed generation is never reused.
    expect(await writeVia(vault, id)).toBe(3);
  });
});

describe("CredentialVault: the associated data", () => {
  it("a row's nonce and ciphertext copied onto another crawl's row do not authenticate", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const a = await seedCrawl();
    const b = await seedCrawl();
    await writeVia(vault, a);
    await writeVia(vault, b, { requestHeaders: { "x-other": "other-S3CRET" } });
    const source = await rowOf(a);
    // Same generation (1) on both: only the crawl id in the associated data differs.
    await db
      .update(crawlCredentials)
      .set({ nonce: source!.nonce, ciphertext: source!.ciphertext })
      .where(eq(crawlCredentials.crawlId, b));
    expect(await vault.read(b)).toEqual({ kind: "unreadable", reason: "auth-failed" });
    expect((await vault.read(a)).kind).toBe("ok");
  });

  it("one flipped byte of the ciphertext does not authenticate", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const id = await seedCrawl();
    await writeVia(vault, id);
    const row = await rowOf(id);
    const flipped = Buffer.from(row!.ciphertext);
    flipped[3] = (flipped[3] ?? 0) ^ 0x01;
    await db.update(crawlCredentials).set({ ciphertext: flipped }).where(eq(crawlCredentials.crawlId, id));
    expect(await vault.read(id)).toEqual({ kind: "unreadable", reason: "auth-failed" });
    // The tag itself, too.
    const tag = Buffer.from(row!.ciphertext);
    tag[tag.length - 1] = (tag[tag.length - 1] ?? 0) ^ 0x80;
    await db.update(crawlCredentials).set({ ciphertext: tag }).where(eq(crawlCredentials.crawlId, id));
    expect(await vault.read(id)).toEqual({ kind: "unreadable", reason: "auth-failed" });
  });

  it("an earlier generation's ciphertext replayed onto the row does not authenticate, generation column and all", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    const id = await seedCrawl();
    await writeVia(vault, id);
    const old = await rowOf(id);
    expect(await writeVia(vault, id, { ...VALUES, requestHeaders: { "X-Fixture-Key": NEW_VALUE } })).toBe(2);

    await db
      .update(crawlCredentials)
      .set({ nonce: old!.nonce, ciphertext: old!.ciphertext })
      .where(eq(crawlCredentials.crawlId, id));
    expect(await vault.read(id)).toEqual({ kind: "unreadable", reason: "auth-failed" });

    await db
      .update(crawlCredentials)
      .set({ nonce: old!.nonce, ciphertext: old!.ciphertext, generation: old!.generation })
      .where(eq(crawlCredentials.crawlId, id));
    expect(await vault.read(id)).toEqual({ kind: "unreadable", reason: "auth-failed" });
  });
});

describe("CredentialVault: the keys", () => {
  const k1 = otherKey("k1", 0x11);
  const k2 = otherKey("k2", 0x22);

  it("a row written under k1 is read by a vault whose current key is k2 and previous k1, and re-written under k2", async () => {
    const id = await seedCrawl();
    await writeVia(new CredentialVault(db, { current: k1 }), id);
    const rotated = new CredentialVault(db, { current: k2, previous: k1 });
    expect(await rotated.read(id)).toEqual({ kind: "ok", credentials: VALUES, generation: 1 });
    // The next write re-encrypts under the current key.
    await writeVia(rotated, id);
    expect((await rowOf(id))?.keyId).toBe("k2");
    expect((await new CredentialVault(db, { current: k2 }).read(id)).kind).toBe("ok");
  });

  it("with only k2 it is unknown-key, and a k2 vault never mistakes k1's bytes for its own", async () => {
    const id = await seedCrawl();
    await writeVia(new CredentialVault(db, { current: k1 }), id);
    expect(await new CredentialVault(db, { current: k2 }).read(id)).toEqual({ kind: "unreadable", reason: "unknown-key" });
    // A key id reused for other bytes: the tag refuses it.
    const impostor = new CredentialVault(db, { current: { id: "k1", key: k2.key } });
    expect(await impostor.read(id)).toEqual({ kind: "unreadable", reason: "auth-failed" });
  });

  it("refuses a malformed key at construction, naming the field", () => {
    expect(() => new CredentialVault(db, { current: { id: "k", key: Buffer.alloc(31) } })).toThrow(
      /credentialKeys\.current\.key must be a Buffer of exactly 32 bytes/,
    );
    expect(() => new CredentialVault(db, { current: { id: "a:b", key: Buffer.alloc(32) } })).toThrow(
      /credentialKeys\.current\.id/,
    );
    expect(() => new CredentialVault(db, { current: k1, previous: { id: "k1", key: k2.key } })).toThrow(
      /same id/,
    );
  });
});

describe("parseCredentialKeys", () => {
  const good = Buffer.alloc(32, 0x5a).toString("base64");
  const refusals: [string, string | undefined][] = [
    ["unset", undefined],
    ["empty", "   "],
    ["missing ':'", `k1${good}`],
    ["non-base64", "k1:not*base64*at*all*but-long-enough-to-be-a-key=="],
    ["a 31-byte key", `k1:${Buffer.alloc(31, 0x5a).toString("base64")}`],
    ["a 33-byte key", `k1:${Buffer.alloc(33, 0x5a).toString("base64")}`],
    ["an empty id", `:${good}`],
  ];
  for (const [what, value] of refusals) {
    it(`refuses ${what}, naming ARIADNE_CREDENTIALS_KEY and not the value`, () => {
      let message = "";
      try {
        parseCredentialKeys(value === undefined ? {} : { ARIADNE_CREDENTIALS_KEY: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("ARIADNE_CREDENTIALS_KEY");
      if (value !== undefined && value.trim() !== "") {
        expect(message).not.toContain(value);
        const [, keyPart] = value.split(":");
        if (keyPart !== undefined && keyPart !== "") expect(message).not.toContain(keyPart);
      }
    });
  }

  it("reads <id>:<base64>, and an optional previous key with another id", () => {
    const keys: CredentialKeys = parseCredentialKeys({
      ARIADNE_CREDENTIALS_KEY: `k2:${good}`,
      ARIADNE_CREDENTIALS_KEY_PREVIOUS: `k1:${Buffer.alloc(32, 1).toString("base64")}`,
    });
    expect(keys.current.id).toBe("k2");
    expect(keys.current.key.equals(Buffer.alloc(32, 0x5a))).toBe(true);
    expect(keys.previous?.id).toBe("k1");
    expect(parseCredentialKeys({ ARIADNE_CREDENTIALS_KEY: `k2:${good}`, ARIADNE_CREDENTIALS_KEY_PREVIOUS: "" }).previous).toBeUndefined();
  });

  it("refuses a malformed previous key or one with the current key's id, naming that variable", () => {
    const value = `k1:${Buffer.alloc(16).toString("base64")}`;
    expect(() =>
      parseCredentialKeys({ ARIADNE_CREDENTIALS_KEY: `k2:${good}`, ARIADNE_CREDENTIALS_KEY_PREVIOUS: value }),
    ).toThrow(/ARIADNE_CREDENTIALS_KEY_PREVIOUS's key decodes to 16 bytes/);
    expect(() =>
      parseCredentialKeys({ ARIADNE_CREDENTIALS_KEY: `k2:${good}`, ARIADNE_CREDENTIALS_KEY_PREVIOUS: `k2:${good}` }),
    ).toThrow(/ARIADNE_CREDENTIALS_KEY_PREVIOUS has the same id/);
  });

  it("ARIADNE_CREDENTIALS_RETENTION_DAYS defaults to 30 and must otherwise be a positive integer", () => {
    expect(parseCredentialRetentionDays({})).toBe(30);
    expect(parseCredentialRetentionDays({ ARIADNE_CREDENTIALS_RETENTION_DAYS: "7" })).toBe(7);
    for (const bad of ["0", "-3", "1.5", "seven", "1e3"]) {
      expect(() => parseCredentialRetentionDays({ ARIADNE_CREDENTIALS_RETENTION_DAYS: bad }), bad).toThrow(
        /ARIADNE_CREDENTIALS_RETENTION_DAYS must be a positive whole number/,
      );
    }
  });
});

describe("CredentialVault.sweepExpired", () => {
  it("removes a crawl's row 31 days after it finished, keeps one at 29 days, and keeps a paused crawl's", async () => {
    const vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
    // The real clock: a crawl another suite is running now finished (if at all)
    // today, so the sweep cannot reach it.
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const old = await seedCrawl("finished", new Date(now.getTime() - 31 * day));
    const recent = await seedCrawl("finished", new Date(now.getTime() - 29 * day));
    const failed = await seedCrawl("failed", new Date(now.getTime() - 31 * day));
    const paused = await seedCrawl("paused", new Date(now.getTime() - 400 * day));
    for (const id of [old, recent, failed, paused]) await writeVia(vault, id);

    const swept = await vault.sweepExpired(now, 30);
    // Other suites' rows may be swept too; these two must be among them.
    expect(swept).toBeGreaterThanOrEqual(2);
    expect(await rowOf(old)).toBeUndefined();
    expect(await rowOf(failed)).toBeUndefined();
    expect(await rowOf(recent)).toBeDefined();
    expect(await rowOf(paused)).toBeDefined();
    await expect(vault.sweepExpired(now, 0)).rejects.toThrow(/retentionDays must be a positive whole number/);
  });
});

// ------------------------------------------------------------------ the service

let gated: Server;
let gatedBase: string;
/** Every request the gated site saw: its path and the credential header's value. */
const gatedSeen: { path: string; key: string | undefined }[] = [];
let blocker: Server;
let blockerBase: string;
let api: ApiServer;
let base: string;
let seam: (phase: "written") => Promise<void> = async () => {};
const serverLog: string[] = [];

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, text, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function start(body: Record<string, unknown>): Promise<string> {
  const res = await call("POST", "/crawls", { maxConcurrency: 1, ...body });
  if (res.status !== 202) throw new Error(`start: ${res.status} ${res.text}`);
  const id = String(res.body["crawlId"]);
  createdCrawls.push(id);
  return id;
}

async function detail(id: string): Promise<Record<string, unknown>> {
  const res = await call("GET", `/crawls/${id}`);
  if (res.status !== 200) throw new Error(`GET /crawls/${id}: ${res.status} ${res.text}`);
  return res.body;
}

async function until(what: string, id: string, predicate: (b: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const body = await detail(id);
    if (predicate(body)) return body;
    if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${String(body["status"])})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settled = (b: Record<string, unknown>): boolean => b["status"] !== "queued" && b["status"] !== "running";

/** A queued crawl of the gated site, held in the queue by a running blocker. */
async function queuedBehindBlocker(credentials: CrawlCredentials): Promise<{ id: string; hold: string }> {
  const hold = await start({ siteUrl: `${blockerBase}/slow/`, maxPages: 100_000 });
  await until("the blocker runs", hold, (b) => b["status"] === "running");
  const id = await start({ siteUrl: `${gatedBase}/hdr/`, maxPages: 4, ...credentials });
  expect((await detail(id))["status"]).toBe("queued");
  return { id, hold };
}

async function release(hold: string): Promise<void> {
  expect([200, 202]).toContain((await call("POST", `/crawls/${hold}/cancel`)).status);
  await until("the blocker closes", hold, settled);
}

/** The gated pages' requests since `gatedSeen` was last cleared (one crawl of it runs at a time). */
function gatedPages(): { path: string; key: string | undefined }[] {
  return gatedSeen.filter((r) => r.path.startsWith("/hdr/"));
}

describe("the service writes and reads through the vault", () => {
  beforeAll(async () => {
    gated = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      gatedSeen.push({ path, key: headerOf(req.headers, "x-fixture-key") });
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      const hdr = /^\/hdr\/(\d*)$/.exec(path);
      if (hdr !== null) {
        const key = headerOf(req.headers, "x-fixture-key");
        if (key !== OLD_VALUE && key !== NEW_VALUE) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("credentials required");
          return;
        }
        const n = hdr[1] === "" ? 0 : Number(hdr[1]);
        const links = Array.from({ length: 3 }, (_, i) => `<a href="/hdr/${n * 3 + i + 1}">a</a>`).join("");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="en"><head><title>Gated ${n}</title></head><body><h1>Gated ${n}</h1>${links}</body></html>`);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((r) => gated.listen(0, "127.0.0.1", () => r()));
    const gatedAddress = gated.address();
    if (gatedAddress === null || typeof gatedAddress === "string") throw new Error("gated site bound oddly");
    gatedBase = `http://127.0.0.1:${gatedAddress.port}`;

    blocker = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      const slow = /^\/slow\/(\d*)$/.exec(path);
      const n = slow?.[1] === undefined || slow[1] === "" ? 0 : Number(slow[1]);
      const links = Array.from({ length: 10 }, (_, i) => `<a href="/slow/${n * 10 + i + 1}">s</a>`).join("");
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="en"><head><title>Slow ${n}</title></head><body>${links}</body></html>`);
      }, 100);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const blockerAddress = blocker.address();
    if (blockerAddress === null || typeof blockerAddress === "string") throw new Error("blocker bound oddly");
    blockerBase = `http://127.0.0.1:${blockerAddress.port}`;

    api = createApiServer({
      db,
      config: {
        allowedDomains: ["127.0.0.1"],
        crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
        token: TOKEN,
        credentialKeys: TEST_CREDENTIAL_KEYS,
        afterConfigWrite: (phase) => seam(phase),
        log: (line) => serverLog.push(line),
      },
    });
    base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  }, 60_000);

  afterAll(async () => {
    await api.close();
    await closeFetchAgents();
    await new Promise<void>((r) => gated.close(() => r()));
    await new Promise<void>((r) => blocker.close(() => r()));
  }, 60_000);

  it("start writes the row in its transaction; the row holds no value in clear", async () => {
    const { id, hold } = await queuedBehindBlocker({ requestHeaders: { "X-Fixture-Key": OLD_VALUE } });
    const read = await new CredentialVault(db, TEST_CREDENTIAL_KEYS).read(id);
    expect(read).toEqual({ kind: "ok", credentials: { requestHeaders: { "X-Fixture-Key": OLD_VALUE } }, generation: 1 });
    expect((await rowOf(id))?.ciphertext.includes(Buffer.from(OLD_VALUE))).toBe(false);
    expect((await call("POST", `/crawls/${id}/cancel`)).status).toBe(200);
    expect(await rowOf(id)).toBeUndefined();
    await release(hold);
  }, 120_000);

  it("crawl_config_set changing a header's value keeps the shape, and the runner that claims the crawl next sends the new value (27d R17, closed)", async () => {
    gatedSeen.length = 0;
    const { id, hold } = await queuedBehindBlocker({ requestHeaders: { "X-Fixture-Key": OLD_VALUE } });
    const set = await call("PATCH", `/crawls/${id}/config`, { crawl: { requestHeaders: { "X-Fixture-Key": NEW_VALUE } } });
    expect(set.status, set.text).toBe(200);
    expect(set.text).not.toContain(NEW_VALUE);
    // The same shape: one header, the same name.
    const [row] = await db.select({ config: crawls.config, g: crawls.credentialGeneration }).from(crawls).where(eq(crawls.id, id));
    expect((row?.config as Record<string, unknown>)["credentialShape"]).toEqual({
      requestHeaderNames: ["x-fixture-key"],
      httpAuth: false,
      cookieNames: [],
    });
    expect(row?.g).toBe(2);

    await release(hold);
    const done = await until("finished", id, settled);
    expect(done["status"], JSON.stringify(done)).toBe("finished");
    const [ok] = await db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.crawlId, id));
    expect(ok?.n).toBe(4);
    const seen = gatedPages();
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.every((r) => r.key === NEW_VALUE), JSON.stringify(seen.map((r) => r.key === NEW_VALUE))).toBe(true);
  }, 120_000);

  it("a config change that throws before its commit leaves the stored copy as it was, and the crawl runs with it", async () => {
    gatedSeen.length = 0;
    const { id, hold } = await queuedBehindBlocker({ requestHeaders: { "X-Fixture-Key": OLD_VALUE } });
    seam = async () => {
      seam = async () => {};
      throw new Error("the config write failed (test)");
    };
    const set = await call("PATCH", `/crawls/${id}/config`, { crawl: { requestHeaders: { "X-Fixture-Key": NEW_VALUE } } });
    expect(set.status).toBeGreaterThanOrEqual(500);
    expect(set.text).not.toContain(NEW_VALUE);
    const read = await new CredentialVault(db, TEST_CREDENTIAL_KEYS).read(id);
    expect(read).toEqual({ kind: "ok", credentials: { requestHeaders: { "X-Fixture-Key": OLD_VALUE } }, generation: 1 });

    await release(hold);
    expect((await until("finished", id, settled))["status"]).toBe("finished");
    const seen = gatedPages();
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.every((r) => r.key === OLD_VALUE)).toBe(true);
  }, 120_000);

  for (const [what, corrupt] of [
    [
      "fails authentication",
      async (id: string) => {
        const row = await rowOf(id);
        const flipped = Buffer.from(row!.ciphertext);
        flipped[0] = (flipped[0] ?? 0) ^ 0xff;
        await db.update(crawlCredentials).set({ ciphertext: flipped }).where(eq(crawlCredentials.crawlId, id));
      },
    ],
    [
      "names a key this server does not hold",
      async (id: string) => {
        await db.update(crawlCredentials).set({ keyId: "rotated-away" }).where(eq(crawlCredentials.crawlId, id));
      },
    ],
  ] as const) {
    it(`a queued crawl whose stored copy ${what} is paused credentials_unreadable before any request; a resume with the values runs it`, async () => {
      const { id, hold } = await queuedBehindBlocker({ requestHeaders: { "X-Fixture-Key": OLD_VALUE } });
      await corrupt(id);
      gatedSeen.length = 0;
      const logFrom = serverLog.length;

      await release(hold);
      const paused = await until("paused", id, (b) => b["status"] === "paused");
      expect(paused["pauseReason"]).toBe("credentials_unreadable");
      expect(gatedSeen, "a request reached the site").toEqual([]);
      const [row] = await db.select({ pauseReason: crawls.pauseReason, pages: crawls.pagesCrawled }).from(crawls).where(eq(crawls.id, id));
      expect(row).toEqual({ pauseReason: "credentials_unreadable", pages: 0 });
      const logged = serverLog.slice(logFrom).filter((l) => l.includes(id)).join("\n");
      expect(logged).toContain("credentials_unreadable");
      expect(logged).not.toContain("S3CRET");

      const refused = await call("POST", `/crawls/${id}/resume`);
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body["code"]).toBe("CREDENTIALS_REQUIRED");
      expect(String(refused.body["error"])).toContain("x-fixture-key");
      const render = await call("POST", `/crawls/${id}/render`);
      expect(render.status, render.text).toBe(409);
      expect(render.body["code"]).toBe("CREDENTIALS_REQUIRED");
      expect(gatedSeen).toEqual([]);

      // Re-supplied, the values overwrite the row and the crawl runs.
      const ok = await call("POST", `/crawls/${id}/resume`, { requestHeaders: { "X-Fixture-Key": NEW_VALUE } });
      expect(ok.status, ok.text).toBe(202);
      expect((await rowOf(id))?.keyId).toBe(TEST_CREDENTIAL_KEY.id);
      expect((await until("finished", id, settled))["status"]).toBe("finished");
      const seen = gatedPages();
      expect(seen.length).toBeGreaterThanOrEqual(4);
      expect(seen.every((r) => r.key === NEW_VALUE)).toBe(true);
      for (const r of [refused, render, ok]) expect(r.text).not.toContain("S3CRET");
    }, 120_000);
  }

  it("a queued crawl whose stored copy is gone is paused the same way", async () => {
    const { id, hold } = await queuedBehindBlocker({ requestHeaders: { "X-Fixture-Key": OLD_VALUE } });
    await db.delete(crawlCredentials).where(eq(crawlCredentials.crawlId, id));
    gatedSeen.length = 0;
    await release(hold);
    const paused = await until("paused", id, (b) => b["status"] === "paused");
    expect(paused["pauseReason"]).toBe("credentials_unreadable");
    expect(gatedSeen).toEqual([]);
  }, 120_000);
});

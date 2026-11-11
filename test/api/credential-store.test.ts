/**
 * Phase 27d T7 (closing 27c M9): the credential store holds a changed shape
 * beside the old one while `crawl_config_set` commits, so a queue runner that
 * dequeues inside that window runs with the values of the shape its row states.
 *
 * Unit tests of the store, then the service: the race, held open
 * DETERMINISTICALLY by the TEST-ONLY `afterConfigWrite` seam (no timing), and
 * the rollback.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { CredentialStore } from "../../src/api/credential-store.js";
import { shapeOf, type CrawlCredentials } from "../../src/crawl/credentials.js";

const TOKEN = "test-token-credential-store-0123456789";
const BASIC = Buffer.from("user-S3CRET:pw-S3CRET", "utf8").toString("base64");
const A: CrawlCredentials = { httpAuth: { username: "user-S3CRET", password: "pw-S3CRET" } };
const B: CrawlCredentials = { ...A, requestHeaders: { "x-extra": "extra-S3CRET" } };
const shapeA = shapeOf(A);
const shapeB = shapeOf(B);

describe("CredentialStore", () => {
  it("holds a staged entry beside the current one, each found by its own shape", () => {
    const store = new CredentialStore();
    store.set("c", A);
    store.stage("c", B);
    expect(store.get("c", shapeA)).toBe(A);
    expect(store.get("c", shapeB)).toBe(B);
    expect(store.get("c", null)).toBeUndefined();
    expect(store.get("other", shapeA)).toBeUndefined();
  });

  it("settle(true) keeps only the staged entry", () => {
    const store = new CredentialStore();
    store.set("c", A);
    store.stage("c", B)(true);
    expect(store.get("c", shapeA)).toBeUndefined();
    expect(store.get("c", shapeB)).toBe(B);
  });

  it("settle(false) keeps only what was held", () => {
    const store = new CredentialStore();
    store.set("c", A);
    store.stage("c", B)(false);
    expect(store.get("c", shapeA)).toBe(A);
    expect(store.get("c", shapeB)).toBeUndefined();
    expect(store.has("c")).toBe(true);
  });

  it("a staged removal (null) leaves nothing once settled true, and the old entry once settled false", () => {
    const store = new CredentialStore();
    store.set("c", A);
    store.stage("c", null)(true);
    expect(store.has("c")).toBe(false);
    store.set("c", A);
    store.stage("c", null)(false);
    expect(store.get("c", shapeA)).toBe(A);
  });

  it("staging with nothing held, then settling false, leaves nothing", () => {
    const store = new CredentialStore();
    store.stage("c", B)(false);
    expect(store.has("c")).toBe(false);
  });

  it("set replaces every entry, delete drops them, settling twice is loud", () => {
    const store = new CredentialStore();
    store.set("c", A);
    const settle = store.stage("c", B);
    store.set("c", A);
    expect(store.get("c", shapeB)).toBeUndefined();
    settle(false);
    store.delete("c");
    expect(store.has("c")).toBe(false);
    expect(() => settle(false)).toThrow(/settled twice/);
  });
});

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let siteServer: Server;
let site: string;
let api: ApiServer;
let base: string;
let seam: (phase: "written" | "committed") => Promise<void> = async () => {};
const createdCrawls: string[] = [];

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

interface Internals {
  credentials: CredentialStore;
  runQueued(entry: { crawlId: string; resuming: boolean }, signal: AbortSignal): Promise<void>;
}

/** The service's private store and runner, reached the way the other suites reach `credentials`. */
function internals(): Internals {
  return api.service as unknown as Internals;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  siteServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const auth = /^\/auth\/(\d*)$/.exec(path);
    if (auth !== null) {
      if (req.headers["authorization"] !== `Basic ${BASIC}`) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("credentials required");
        return;
      }
      const n = auth[1] === "" ? 0 : Number(auth[1]);
      const links = Array.from({ length: 3 }, (_, i) => `<a href="/auth/${n * 3 + i + 1}">a</a>`).join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><head><title>Gated ${n}</title></head><body><h1>Gated ${n}</h1>${links}</body></html>`);
      return;
    }
    const slow = /^\/slow\/(\d*)$/.exec(path);
    if (slow !== null) {
      const n = slow[1] === "" ? 0 : Number(slow[1]);
      const links = Array.from({ length: 10 }, (_, i) => `<a href="/slow/${n * 10 + i + 1}">s</a>`).join("");
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="en"><head><title>Slow ${n}</title></head><body>${links}</body></html>`);
      }, 100);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;
  api = createApiServer({
    db,
    config: {
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      token: TOKEN,
      afterConfigWrite: (phase) => seam(phase),
    },
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
}, 60_000);

afterAll(async () => {
  await api.close();
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await closeDb(db);
}, 60_000);

/** A queued crawl of shape A: a blocker holds the queue, so the pump never dequeues it. */
async function queuedWithA(): Promise<{ id: string; blocker: string }> {
  const blocker = await start({ siteUrl: `${site}/slow/`, maxPages: 100_000 });
  await until("the blocker runs", blocker, (b) => b["status"] === "running");
  const id = await start({ siteUrl: `${site}/auth/`, maxPages: 4, httpAuth: { username: "user-S3CRET", password: "pw-S3CRET" } });
  expect((await detail(id))["status"]).toBe("queued");
  return { id, blocker };
}

async function release(blocker: string): Promise<void> {
  expect([200, 202]).toContain((await call("POST", `/crawls/${blocker}/cancel`)).status);
  await until("the blocker closes", blocker, (b) => b["status"] !== "running" && b["status"] !== "queued");
}

describe("a queued crawl whose credentials change while the change commits (27c M9)", () => {
  it("dequeued inside the commit window, it runs with the credentials of the shape its row states", async () => {
    const { id, blocker } = await queuedWithA();
    seam = async (phase) => {
      if (phase !== "committed") return;
      // The row states shape B; the store has not settled. This is the queue
      // runner dequeuing the crawl in the gap.
      seam = async () => {};
      await internals().runQueued({ crawlId: id, resuming: false }, new AbortController().signal);
    };
    const set = await call("PATCH", `/crawls/${id}/config`, { crawl: { requestHeaders: { "x-extra": "extra-S3CRET" } } });
    expect(set.status, set.text).toBe(200);
    const closed = await detail(id);
    expect(closed["status"], JSON.stringify(closed)).toBe("finished");
    expect(JSON.stringify(closed)).not.toContain("another shape");
    const [ok] = await db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.crawlId, id));
    expect(ok?.n).toBe(4);
    // Settled: only the new entry is held.
    expect(internals().credentials.get(id, shapeA)).toBeUndefined();
    expect(internals().credentials.get(id, shapeB)).toEqual(B);
    await release(blocker);
  }, 120_000);

  it("a config write that throws leaves the crawl holding A, and B gone", async () => {
    const { id, blocker } = await queuedWithA();
    seam = async (phase) => {
      if (phase !== "written") return;
      seam = async () => {};
      throw new Error("the config write failed (test)");
    };
    const set = await call("PATCH", `/crawls/${id}/config`, { crawl: { requestHeaders: { "x-extra": "extra-S3CRET" } } });
    expect(set.status).toBeGreaterThanOrEqual(500);
    expect(internals().credentials.get(id, shapeA)).toEqual(A);
    expect(internals().credentials.get(id, shapeB)).toBeUndefined();
    const [row] = await db.select({ config: crawls.config }).from(crawls).where(eq(crawls.id, id));
    expect((row?.config as Record<string, unknown>)["credentialShape"]).toEqual(shapeA);
    // The old values still run the crawl.
    await release(blocker);
    const done = await until("finished", id, (b) => b["status"] === "finished" || b["status"] === "failed");
    expect(done["status"], JSON.stringify(done)).toBe("finished");
  }, 120_000);
});

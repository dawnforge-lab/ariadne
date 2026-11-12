/**
 * Crawl events and `crawl_history` (Phase 28c Task 1).
 *
 * The lifecycle kinds are written by two triggers — `ariadne_crawl_event()` on
 * `crawls` and `ariadne_job_event()` on `jobs` (migration 0046) — so every
 * writer of a crawl's or a job's status is covered without an event call at
 * each site (call C1). The application writes only the schedule kinds, through
 * `recordEvent`. This file holds the two lists together (d), checks every row
 * it causes against the detail allowlist (e), and walks a real crawl's history
 * through pause, resume, finish and a rules run (a, b — gate clause 2), and a
 * reaper's pause and requeues (c).
 *
 * (c) enqueues UNPINNED crawl jobs (a requeue's), so it holds the pool lock
 * (test/helpers/pool-lock.ts) and deletes its crawls before releasing it.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawlEvents, crawls, instances, jobs } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { storableConfig } from "../../src/crawl/loop.js";
import { EXTRACTION_VERSION } from "../../src/crawl/versions.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import {
  APP_EVENT_KINDS,
  EVENT_DETAIL_KEYS,
  EVENT_KINDS,
  listEvents,
  recordEvent,
  type CrawlEvent,
} from "../../src/events/events.js";
import { claimNextJob, enqueueJob } from "../../src/worker/jobs.js";
import { registerInstance } from "../../src/worker/instance.js";
import { reapOnce } from "../../src/worker/reaper.js";
import { timingWith } from "../../src/worker/timing.js";
import { LOCAL_TENANT, parseTenant } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { acquirePoolLock } from "../helpers/pool-lock.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const TOKEN = "test-token-crawl-events-0123456789abcdef";
/** Every page of the slow site answers after this long. */
const PAGE_DELAY_MS = 100;
/** The crawl (a) runs: long enough that a pause lands mid-run (the loop polls every second). */
const MAX_PAGES = 40;
/** The reaper tests' clock (as test/worker/reaper.test.ts). */
const TIGHT = timingWith({ heartbeat: 50, deadAfter: 300, reapEvery: 100, claimPoll: 50 });

let db: Db;
let exportDir: string;
let renderDir: string;
let siteServer: Server;
let site: string;
let mcp: AriadneMcpServer;
let client: Client;
let api: ApiServer;
let base: string;
const createdCrawls: string[] = [];
const createdInstances: string[] = [];
/** Every crawl whose event rows (e) checks against the allowlist. */
const observedCrawls: string[] = [];

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${JSON.stringify(value)})`);
    await sleep(20);
  }
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const first = content[0];
  if (first === undefined) throw new Error(`${name} answered with no content`);
  return { isError: result.isError === true, body: JSON.parse(first.text) as Record<string, unknown> };
}

async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await tool(name, args);
  if (answer.isError) throw new Error(`${name}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** The whole history through `crawl_history`, three events a page, so the cursor is exercised. */
async function history(crawlId: string): Promise<CrawlEvent[]> {
  const all: CrawlEvent[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = (await ok("crawl_history", {
      crawlId,
      limit: 3,
      ...(cursor === null ? {} : { cursor }),
    })) as unknown as { items: CrawlEvent[]; nextCursor: string | null };
    expect(page.items.length).toBeLessThanOrEqual(3);
    all.push(...page.items);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}

async function crawlStatus(crawlId: string): Promise<Record<string, unknown>> {
  return ok("crawl_status", { crawlId });
}

/** The event rows of `crawlIds`, straight from the table. */
async function rowsOf(crawlIds: readonly string[]): Promise<(typeof crawlEvents.$inferSelect)[]> {
  return db.select().from(crawlEvents).where(inArray(crawlEvents.crawlId, [...crawlIds])).orderBy(asc(crawlEvents.id));
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-events-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-events-render-"));

  // An endless tree of slow pages (as test/api/lifecycle.test.ts): a crawl of
  // it is still running when the test pauses it.
  siteServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const m = /^\/p\/(\d+)$/.exec(path);
    if (path !== "/" && m === null) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const n = m === null ? 0 : Number(m[1]);
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p/${n * 10 + i + 1}">p${n * 10 + i + 1}</a>`).join("");
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><title>Events page ${n}</title></head>` +
          `<body><h1>Events page ${n}</h1>${links}</body></html>`,
      );
    }, PAGE_DELAY_MS);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;

  const config = {
    credentialKeys: TEST_CREDENTIAL_KEYS,
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    exportDir,
    renderDir,
    log: () => {},
  };
  mcp = createMcpServer({ db, config: { ...config, tenant: LOCAL_TENANT } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-events", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
  api = createApiServer({ db, config: { ...config, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
}, 60_000);

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  if (createdInstances.length > 0) await db.delete(instances).where(inArray(instances.id, createdInstances));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
}, 60_000);

describe("(a, b) a crawl's history through pause, resume, finish and a rules run", () => {
  let crawlId: string;

  it("(a) reads queued, claimed, started, paused{request}, resumed{auto:false}, claimed, started, finished{pagesCrawled} — gate clause 2", async () => {
    const started = await ok("crawl_start", { siteUrl: `${site}/`, maxPages: MAX_PAGES, maxConcurrency: 1 });
    crawlId = String(started["crawlId"]);
    createdCrawls.push(crawlId);
    observedCrawls.push(crawlId);

    await until(
      "the crawl is running with pages in",
      () => crawlStatus(crawlId),
      // `pagesCrawled` is written at the close; the frontier counts pages as they land.
      (b) => b["status"] === "running" && Number((b["frontier"] as Record<string, unknown>)["done"]) >= 2,
    );
    await ok("crawl_pause", { crawlId });
    await until("the crawl paused", () => crawlStatus(crawlId), (b) => b["status"] === "paused");
    await ok("crawl_resume", { crawlId });
    const done = await until(
      "the resumed crawl finished",
      () => crawlStatus(crawlId),
      (b) => b["status"] !== "queued" && b["status"] !== "running",
    );
    expect(done["status"]).toBe("finished");
    const pagesCrawled = Number(done["pagesCrawled"]);
    expect(pagesCrawled).toBe(MAX_PAGES);

    const events = await history(crawlId);
    const instanceId = await mcp.service.instanceId();
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      ["queued", {}],
      ["claimed", { instanceId, role: "all" }],
      ["started", {}],
      ["paused", { reason: "request" }],
      ["resumed", { auto: false }],
      ["claimed", { instanceId, role: "all" }],
      ["started", {}],
      ["finished", { pagesCrawled }],
    ]);
    for (const e of events) {
      expect(e.crawlId).toBe(crawlId);
      expect(e.scheduleId).toBeNull();
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    }
    // Oldest first, by id and so by time.
    const ids = events.map((e) => BigInt(e.id));
    expect([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))).toEqual(ids);

    // The route answers the same events.
    const res = await fetch(`${base}/crawls/${crawlId}/history?limit=200`, {
      headers: { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": LOCAL_TENANT },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: events, nextCursor: null });
  }, 120_000);

  it("(b) crawl_rules on the finished crawl adds rules_started then rules_finished{outcome:'done'}", async () => {
    const before = await history(crawlId);
    await ok("crawl_rules", { crawlId });
    const after = await history(crawlId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((e) => [e.kind, e.detail])).toEqual([
      ["rules_started", {}],
      ["rules_finished", { outcome: "done" }],
    ]);
  }, 120_000);

  it("refuses a cursor it did not issue and a limit out of range, by name", async () => {
    const badCursor = await tool("crawl_history", { crawlId, cursor: "not-a-cursor" });
    expect(badCursor.isError).toBe(true);
    expect(badCursor.body).toMatchObject({ code: "VALIDATION", error: "cursor is not a cursor this server issued" });
    const forged = await tool("crawl_history", {
      crawlId,
      cursor: Buffer.from(JSON.stringify(["-1"]), "utf8").toString("base64url"),
    });
    expect(forged.isError).toBe(true);
    expect(forged.body).toMatchObject({ code: "VALIDATION" });
    const badLimit = await tool("crawl_history", { crawlId, limit: 0 });
    expect(badLimit.isError).toBe(true);
    expect(badLimit.body).toMatchObject({ code: "VALIDATION" });
  });
});

describe("(c) the reaper: worker_lost without a paused beside it, and its requeues resumed{auto:true}", () => {
  /** A one-connection database, so the session the reaper's transactions used is the one read after. */
  let single: Db;
  let singlePool: pg.Pool;

  beforeAll(() => {
    singlePool = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
    single = Object.assign(drizzle(singlePool, { schema }), { $pool: singlePool });
  });

  afterAll(async () => {
    await singlePool.end();
  });

  async function deadInstance(): Promise<string> {
    const id = await registerInstance(db, "worker");
    createdInstances.push(id);
    await db.execute(sql`update instances set heartbeat_at = now() - interval '1 hour' where id = ${id}`);
    return id;
  }

  async function seedCrawl(fields: Partial<typeof crawls.$inferInsert> & { status: string }): Promise<string> {
    const id = `crawl_events_${randomUUID()}`;
    const siteUrl = `https://events-${randomUUID()}.example/`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl,
      hostKey: hostKeyOf(siteUrl),
      config: storableConfig({
        siteUrl,
        maxPages: 10,
        maxDepth: 3,
        userAgent: "AriadneBot-events-test",
        perHostDelayMs: 0,
        maxConcurrency: 1,
        probeHosts: false,
      }),
      rulesetVersion: RULESET_VERSION,
      ...fields,
    });
    createdCrawls.push(id);
    observedCrawls.push(id);
    return id;
  }

  async function seedCrawlJob(crawlId: string, fields: Partial<typeof jobs.$inferInsert> & { status: string }): Promise<void> {
    await db.insert(jobs).values({
      id: `job_${randomUUID()}`,
      tenantId: LOCAL_TENANT,
      crawlId,
      kind: "crawl",
      rulesetVersion: RULESET_VERSION,
      extractionVersion: EXTRACTION_VERSION,
      ...fields,
    });
  }

  const reap = (only: readonly string[]) =>
    reapOnce(single, {
      now: new Date(),
      timing: TIGHT,
      vault: new CredentialVault(db, TEST_CREDENTIAL_KEYS),
      // A century: this tick sweeps no other suite's credentials.
      retentionDays: 36_500,
      onlyInstances: only,
    });

  const kindsOf = async (crawlId: string): Promise<[string, unknown][]> =>
    (await rowsOf([crawlId])).map((r) => [r.kind, r.detail]);

  it("worker_lost and shutdown requeues are auto; the flag does not outlive the reaper's transaction", async () => {
    const lock = await acquirePoolLock(databaseUrl());
    const seeded: string[] = [];
    try {
      // A worker-pool crawl whose worker died mid-run.
      const d = await deadInstance();
      const lost = await seedCrawl({ status: "running" });
      seeded.push(lost);
      await seedCrawlJob(lost, { status: "running", claimedBy: d, claimedAt: new Date(), heartbeatAt: new Date() });

      // A worker-pool crawl a deploy paused (Ruling R17: requeued without counting).
      const i = await deadInstance();
      const shutdown = await seedCrawl({ status: "paused", pauseReason: "shutdown", finishedAt: new Date() });
      seeded.push(shutdown);
      await seedCrawlJob(shutdown, { status: "abandoned", claimedBy: i, finishedAt: new Date() });

      expect(await reap([d, i])).toMatchObject({ abandonedJobs: 1, pausedCrawls: 1, requeuedCrawls: 2 });

      // Inserted running (`started`), then the reaper's close and requeue.
      expect(await kindsOf(lost)).toEqual([
        ["started", {}],
        ["worker_lost", {}],
        ["resumed", { auto: true }],
      ]);
      expect((await kindsOf(lost)).some(([kind]) => kind === "paused")).toBe(false);
      expect(await crawlRowOf(lost)).toMatchObject({ status: "queued", autoResumeCount: 1 });

      // Inserted paused (`paused{shutdown}`), then requeued — auto, though the count did not rise.
      expect(await kindsOf(shutdown)).toEqual([
        ["paused", { reason: "shutdown" }],
        ["resumed", { auto: true }],
      ]);
      expect(await crawlRowOf(shutdown)).toMatchObject({ status: "queued", autoResumeCount: 0 });

      // The same session, a later transaction that is not the reaper's: not auto.
      await single.transaction(async (tx) => {
        await tx
          .update(crawls)
          .set({ status: "paused", pauseReason: "request", finishedAt: new Date() })
          .where(eq(crawls.id, shutdown));
        await tx.update(crawls).set({ status: "queued", pauseReason: null, finishedAt: null }).where(eq(crawls.id, shutdown));
      });
      expect((await kindsOf(shutdown)).slice(-2)).toEqual([
        ["paused", { reason: "request" }],
        ["resumed", { auto: false }],
      ]);
    } finally {
      // The requeues' unpinned jobs go with their crawls, before the pool is anyone else's.
      if (seeded.length > 0) await db.delete(crawls).where(inArray(crawls.id, seeded));
      await lock.release();
    }
  });
});

async function crawlRowOf(id: string): Promise<typeof crawls.$inferSelect> {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl ${id}`);
  return row;
}

describe("(d, e) the kind lists and the detail allowlist", () => {
  it("(d) the triggers write exactly the lifecycle kinds of EVENT_KINDS, and the application exactly the rest", async () => {
    const result = await db.execute<{ proname: string; prosrc: string }>(
      sql`select proname, prosrc from pg_proc where proname in ('ariadne_crawl_event', 'ariadne_job_event')`,
    );
    expect(result.rows.map((r) => r.proname).sort()).toEqual(["ariadne_crawl_event", "ariadne_job_event"]);
    const written = new Set<string>();
    for (const row of result.rows) {
      for (const m of row.prosrc.matchAll(/v_kind\s*:=\s*'([a-z_]+)'/g)) written.add(m[1] as string);
    }
    const lifecycle = EVENT_KINDS.filter((k) => !(APP_EVENT_KINDS as readonly string[]).includes(k));
    expect([...written].sort()).toEqual([...lifecycle].sort());
    for (const kind of EVENT_KINDS) {
      const byTrigger = written.has(kind);
      const byApp = (APP_EVENT_KINDS as readonly string[]).includes(kind);
      expect(byTrigger !== byApp, `${kind} is written by exactly one of the triggers and recordEvent`).toBe(true);
    }
    expect(Object.keys(EVENT_DETAIL_KEYS).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it("(e) every event row (a) to (c) wrote has detail keys within EVENT_DETAIL_KEYS[kind]", async () => {
    expect(observedCrawls.length).toBeGreaterThanOrEqual(3);
    const rows = await rowsOf(observedCrawls);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect((EVENT_KINDS as readonly string[]).includes(row.kind), `kind ${row.kind}`).toBe(true);
      const allowed = EVENT_DETAIL_KEYS[row.kind as (typeof EVENT_KINDS)[number]];
      for (const key of Object.keys(row.detail)) {
        expect(allowed, `${row.kind} carries ${key}`).toContain(key);
      }
    }
  });
});

describe("(f) recordEvent and listEvents by schedule", () => {
  const SECRET = "sk_live_28c_event_SENTINEL";

  it("writes an application event, and listEvents reads it by schedule id", async () => {
    const scheduleId = `sched_${randomUUID()}`;
    try {
      await recordEvent(db, {
        tenant: LOCAL_TENANT,
        crawlId: null,
        scheduleId,
        kind: "schedule_skipped",
        detail: { reason: "overlap", crawlId: "crawl_x" },
      });
      const page = await listEvents(db, { tenant: LOCAL_TENANT, scheduleId }, {});
      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        kind: "schedule_skipped",
        scheduleId,
        crawlId: null,
        detail: { reason: "overlap", crawlId: "crawl_x" },
      });
      // Another tenant's read of the same schedule id finds nothing.
      const other = await listEvents(db, { tenant: parseTenant(`other-${randomUUID().slice(0, 8)}`), scheduleId }, {});
      expect(other.items).toEqual([]);
    } finally {
      await db.delete(crawlEvents).where(eq(crawlEvents.scheduleId, scheduleId));
    }
  });

  it("throws on a detail key outside the allowlist, naming the kind and the key's position, never the key", async () => {
    const scheduleId = `sched_${randomUUID()}`;
    let caught: unknown;
    try {
      await recordEvent(db, {
        tenant: LOCAL_TENANT,
        crawlId: null,
        scheduleId,
        kind: "schedule_fired",
        detail: { crawlId: "crawl_x", [SECRET]: "value" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("schedule_fired");
    expect(message).toContain("key 2 in the order sent");
    expect(message).not.toContain(SECRET);
    // Nothing was written.
    expect(await db.select().from(crawlEvents).where(eq(crawlEvents.scheduleId, scheduleId))).toEqual([]);
  });

  it("refuses a lifecycle kind: the triggers write those", async () => {
    await expect(
      recordEvent(db, {
        tenant: LOCAL_TENANT,
        crawlId: null,
        scheduleId: null,
        kind: "finished" as "schedule_fired",
        detail: {},
      }),
    ).rejects.toThrow(/'finished' is written by the database's triggers/);
  });
});

describe("the claim's event cannot deadlock a crawl row held FOR UPDATE", () => {
  // `crawl_cancel`, `crawl_delete` and `crawl_config_set` hold the crawl row
  // FOR UPDATE and then write its jobs. The claim's `claimed` event takes the
  // row's key-share lock (its foreign key) while the claim holds the job row:
  // a claim that waited for that lock would close a cycle. It skips the crawl.
  it("a claim skips a queued job whose crawl another transaction holds FOR UPDATE, and the holder settles the job", async () => {
    const siteUrl = `https://events-lock-${randomUUID()}.example/`;
    const crawlId = `crawl_events_lock_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id: crawlId,
      siteUrl,
      hostKey: hostKeyOf(siteUrl),
      config: { siteUrl },
      rulesetVersion: RULESET_VERSION,
      status: "queued",
    });
    createdCrawls.push(crawlId);
    const pinnedTo = `test-pin-${randomUUID()}`;
    const jobId = await enqueueJob(db, { tenant: LOCAL_TENANT, crawlId, kind: "crawl", pinnedTo });

    const holder = new pg.Client({ connectionString: databaseUrl() });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from crawls where id = $1 for update", [crawlId]);
      const claim = claimNextJob(db, { instanceId: pinnedTo, kinds: ["crawl"], pinnedTo });
      const outcome = await Promise.race([claim, sleep(5_000).then(() => "blocked" as const)]);
      expect(outcome).toBeNull();
      // The cancel's own settle, under its lock: not blocked by a claim.
      await holder.query("update jobs set status = 'abandoned', finished_at = now() where id = $1", [jobId]);
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job?.status).toBe("abandoned");
    expect((await rowsOf([crawlId])).map((r) => r.kind)).toEqual(["queued"]);
  }, 30_000);
});

/**
 * `crawl_pause` and `crawl_cancel` (Phase 27b T4), and resume, render and
 * judge around them.
 *
 * Over the wire: a real HTTP server on an ephemeral port, a real MCP server
 * over a linked in-memory transport, and a real crawl of a slow `node:http`
 * site, so a crawl is still `running` when a test asks it to stop and a second
 * crawl really waits in the queue behind it.
 *
 * THE TWO SEAMS, as in judgement-config.test.ts: `runRules` and
 * `runRenderPass` are the real functions, run unchanged, except that while a
 * test holds a gate they wait on a promise the test controls before they
 * start. That is what lets "refused while the rules / a render pass are
 * running" be asserted without a race.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { ClaimLostError, resumeCrawl } from "../../src/crawl/loop.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, TOOL_NAMES, type AriadneMcpServer } from "../../src/api/mcp.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";

/** Test-controlled holds on a rules run and on a render pass (module header). */
const gates = vi.hoisted(() => ({
  rules: { hold: null as Promise<void> | null, entered: null as (() => void) | null },
  render: { hold: null as Promise<void> | null, entered: null as (() => void) | null },
}));

vi.mock("../../src/rules/run.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/rules/run.js")>();
  return {
    ...real,
    runRules: async (...args: Parameters<typeof real.runRules>) => {
      if (gates.rules.hold !== null) {
        gates.rules.entered?.();
        await gates.rules.hold;
      }
      return await real.runRules(...args);
    },
  };
});

vi.mock("../../src/crawl/render/run-render.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/crawl/render/run-render.js")>();
  return {
    ...real,
    runRenderPass: async (...args: Parameters<typeof real.runRenderPass>) => {
      if (gates.render.hold !== null) {
        gates.render.entered?.();
        await gates.render.hold;
      }
      return await real.runRenderPass(...args);
    },
  };
});

const TOKEN = "test-token-lifecycle-0123456789abcdef";
/** Every page of the slow site answers after this long. */
const PAGE_DELAY_MS = 100;

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
let siteServer: Server;
let site: string;
let api: ApiServer;
let base: string;
let mcp: AriadneMcpServer;
let client: Client;
const serverLog: string[] = [];
const createdCrawls: string[] = [];

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string | null } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers["authorization"] = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const first = content[0];
  if (first === undefined) throw new Error(`${name} answered with no content`);
  return { isError: result.isError === true, body: JSON.parse(first.text) as Record<string, unknown> };
}

const pause = (id: string): Promise<Res> => call("POST", `/crawls/${id}/pause`);
const cancel = (id: string): Promise<Res> => call("POST", `/crawls/${id}/cancel`);
const resume = (id: string): Promise<Res> => call("POST", `/crawls/${id}/resume`);
const detail = async (id: string): Promise<Record<string, unknown>> => {
  const res = await call("GET", `/crawls/${id}`);
  if (res.status !== 200) throw new Error(`GET /crawls/${id}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

interface StoredControl {
  status: string;
  controlRequest: string | null;
  pauseReason: string | null;
  cancelledAt: Date | null;
  failureReason: string | null;
}

async function stored(id: string): Promise<StoredControl> {
  const rows = await db
    .select({
      status: crawls.status,
      controlRequest: crawls.controlRequest,
      pauseReason: crawls.pauseReason,
      cancelledAt: crawls.cancelledAt,
      failureReason: crawls.failureReason,
    })
    .from(crawls)
    .where(eq(crawls.id, id));
  const row = rows[0];
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row;
}

async function frontierRows(id: string): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(frontier).where(eq(frontier.crawlId, id));
  return rows[0]?.n ?? 0;
}

/** Poll the crawl through the surface until the predicate holds. */
async function until(
  what: string,
  id: string,
  predicate: (body: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await detail(id);
    if (predicate(body)) return body;
    if (Date.now() > deadline) throw new Error(`never happened: ${what} (last: ${String(body["status"])})`);
    await sleep(20);
  }
}

/** Start a crawl of the slow site over HTTP. */
async function start(maxPages = 400): Promise<{ id: string; queuePosition: number }> {
  const res = await call("POST", "/crawls", {
    body: { siteUrl: `${site}/`, maxPages, maxConcurrency: 1 },
  });
  if (res.status !== 202) throw new Error(`start: ${res.status} ${JSON.stringify(res.body)}`);
  const id = String(res.body["crawlId"]);
  createdCrawls.push(id);
  return { id, queuePosition: Number(res.body["queuePosition"]) };
}

/** A running crawl, and a second one waiting behind it in this server's queue. */
async function runningAndWaiting(): Promise<{ running: string; waiting: string }> {
  const a = await start();
  await until("the first crawl is running", a.id, (b) => b["status"] === "running");
  const b = await start();
  expect(b.queuePosition).toBe(1);
  expect((await stored(b.id)).status).toBe("queued");
  return { running: a.id, waiting: b.id };
}

/** Cancel a running crawl and wait for the loop to close it, so the runner is idle again. */
async function stopRunning(id: string): Promise<void> {
  const res = await cancel(id);
  expect([200, 202]).toContain(res.status);
  await until("the crawl closed", id, (b) => b["status"] !== "running" && b["status"] !== "queued");
}

/** A row nobody in this file's servers holds, in the shape a crawl of the slow site has. */
async function seedRow(
  status: string,
  extra: Partial<typeof crawls.$inferInsert> = {},
): Promise<string> {
  const id = `crawl_lifecycle_${randomUUID()}`;
  await db.insert(crawls).values({
    id,
    siteUrl: `${site}/`,
    config: {
      siteUrl: `${site}/`,
      maxPages: 3,
      maxDepth: 3,
      userAgent: "AriadneBot/0.1 (test)",
      perHostDelayMs: 0,
      maxConcurrency: 1,
      probeHosts: false,
    },
    rulesetVersion: "0.0.0-test",
    status,
    ...extra,
  });
  createdCrawls.push(id);
  return id;
}

/** A paused crawl with evidence to judge and render, and one URL still owed. */
async function seedPausedJudgeable(): Promise<string> {
  const id = await seedRow("paused", {
    pauseReason: "request",
    discovery: mkDiscovery(),
    pagesCrawled: 1,
    finishedAt: new Date(),
  });
  const url = `${site}/`;
  await db.insert(pages).values(
    mkPage({ id: `page_${randomUUID()}`, crawlId: id, url, urlNormalised: url, depth: 0, clickDepth: 0, discoveredVia: "seed" }),
  );
  await db.insert(frontier).values({ crawlId: id, url: `${site}/owed`, state: "pending", depth: 1, discoveredVia: "link" });
  return id;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-lifecycle-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-lifecycle-render-"));

  // THE SLOW SITE. An endless tree: every page answers after PAGE_DELAY_MS and
  // links to ten more, so a crawl of it at concurrency 1 is still running
  // whenever a test needs it to be, and stops only when asked or at maxPages.
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
        `<!doctype html><html lang="en"><head><title>Slow page ${n}</title>` +
          `<meta name="description" content="a slow fixture page"></head>` +
          `<body><h1>Slow page ${n}</h1>${links}</body></html>`,
      );
    }, PAGE_DELAY_MS);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;

  api = await newApi();

  mcp = createMcpServer({ db, config: { allowedDomains: [], exportDir, renderDir, log: () => {} } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-lifecycle", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
}, 60_000);

async function newApi(): Promise<ApiServer> {
  const server = createApiServer({
    db,
    config: {
      token: TOKEN,
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      exportDir,
      renderDir,
      log: (line) => serverLog.push(line),
    },
  });
  base = `http://127.0.0.1:${(await server.listen(0)).port}`;
  return server;
}

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
}, 60_000);

describe("the control table: queued", () => {
  // Review Focus 3.1: a pause takes the crawl out of THIS server's queue in the
  // same step that moves the row, so the runner cannot start it afterwards.
  it("pause on a queued crawl is immediate, takes it out of the queue, and it never starts", async () => {
    const { running, waiting } = await runningAndWaiting();

    const res = await pause(waiting);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crawlId: waiting, status: "paused", controlRequested: null, immediate: true });
    expect(await stored(waiting)).toMatchObject({
      status: "paused",
      pauseReason: "request",
      controlRequest: null,
      cancelledAt: null,
    });
    expect((await detail(waiting))["queuePosition"]).toBeNull();

    // The crawl ahead of it ends, the runner goes looking for the next one, and
    // there is none.
    await stopRunning(running);
    await sleep(500);
    expect((await stored(waiting)).status).toBe("paused");
    expect(await frontierRows(waiting)).toBe(0);
    expect(serverLog.some((line) => line.includes(`crawl ${waiting} starting`))).toBe(false);
    expect(serverLog.some((line) => line.includes(`crawl ${waiting} resuming`))).toBe(false);
  }, 60_000);

  it("cancel on a queued crawl is immediate, final, and takes it out of the queue", async () => {
    const { running, waiting } = await runningAndWaiting();

    const res = await cancel(waiting);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crawlId: waiting, status: "cancelled", controlRequested: null, immediate: true });
    const row = await stored(waiting);
    expect(row).toMatchObject({ status: "cancelled", pauseReason: null, controlRequest: null });
    expect(row.cancelledAt).not.toBeNull();
    expect((await detail(waiting))["queuePosition"]).toBeNull();

    await stopRunning(running);
    await sleep(500);
    expect((await stored(waiting)).status).toBe("cancelled");
    expect(await frontierRows(waiting)).toBe(0);
  }, 60_000);

  // Review Focus 3.2: a queued row this server does not hold is decided by the
  // compare-and-swap alone, and a runner that later reaches it skips it.
  it("an orphan queued crawl is paused by the CAS alone, and the queue runner skips it", async () => {
    const id = await seedRow("queued");
    const res = await pause(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crawlId: id, status: "paused", controlRequested: null, immediate: true });

    // The runner's own path, as if this server had held the crawl all along.
    const runner = api.service as unknown as {
      runQueued(entry: { crawlId: string; resuming: boolean }, signal: AbortSignal): Promise<void>;
    };
    await runner.runQueued({ crawlId: id, resuming: false }, new AbortController().signal);
    expect(serverLog).toContain(`api: crawl ${id} left the queue state ('paused') before it ran; not started`);
    expect(await stored(id)).toMatchObject({ status: "paused", pauseReason: "request", failureReason: null });
    expect(await frontierRows(id)).toBe(0);

    // And the loop's claim, which is the runner's second line of defence.
    const lost = await resumeCrawl(db, id, { expectStatus: "queued" }).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ClaimLostError);
    expect((lost as ClaimLostError).status).toBe("paused");
    expect((await stored(id)).status).toBe("paused");
  });
});

describe("the control table: running", () => {
  it("pause on a running crawl is a request (202); the loop closes it paused; then pause 409s and cancel is immediate", async () => {
    const a = await start();
    await until("running", a.id, (b) => b["status"] === "running");

    const res = await pause(a.id);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ crawlId: a.id, status: "running", controlRequested: "pause", immediate: false });

    await until("paused", a.id, (b) => b["status"] === "paused");
    expect(await stored(a.id)).toMatchObject({ status: "paused", pauseReason: "request", controlRequest: null });

    const again = await pause(a.id);
    expect(again.status).toBe(409);
    expect(String(again.body["error"])).toContain("already paused");

    const cancelled = await cancel(a.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ crawlId: a.id, status: "cancelled", controlRequested: null, immediate: true });
    const row = await stored(a.id);
    expect(row).toMatchObject({ status: "cancelled", pauseReason: null, controlRequest: null });
    expect(row.cancelledAt).not.toBeNull();
  }, 60_000);

  it("cancel on a running crawl is a request (202); the loop closes it cancelled; then both 409", async () => {
    const a = await start();
    await until("running", a.id, (b) => b["status"] === "running");

    const res = await cancel(a.id);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ crawlId: a.id, status: "running", controlRequested: "cancel", immediate: false });

    await until("cancelled", a.id, (b) => b["status"] === "cancelled");
    for (const refused of [await pause(a.id), await cancel(a.id)]) {
      expect(refused.status).toBe(409);
      expect(String(refused.body["error"])).toContain("'cancelled'");
    }
  }, 60_000);

  // The rows with a request already pending, on a `running` row nobody holds:
  // the commands read and write the column, not this process's memory, so an
  // orphan is the deterministic way to stand in that state.
  it("with a pause pending: pause is 202 unchanged, cancel outranks it (202)", async () => {
    const id = await seedRow("running", { controlRequest: "pause" });
    const same = await pause(id);
    expect(same.status).toBe(202);
    expect(same.body).toEqual({ crawlId: id, status: "running", controlRequested: "pause", immediate: false });
    expect((await stored(id)).controlRequest).toBe("pause");

    const upgraded = await cancel(id);
    expect(upgraded.status).toBe(202);
    expect(upgraded.body).toEqual({ crawlId: id, status: "running", controlRequested: "cancel", immediate: false });
    expect((await stored(id)).controlRequest).toBe("cancel");
  });

  it("with a cancel pending: pause 409s, cancel is 202 unchanged", async () => {
    const id = await seedRow("running", { controlRequest: "cancel" });
    const refused = await pause(id);
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toContain("a cancel is already pending");
    expect((await stored(id)).controlRequest).toBe("cancel");

    const same = await cancel(id);
    expect(same.status).toBe(202);
    expect(same.body).toEqual({ crawlId: id, status: "running", controlRequested: "cancel", immediate: false });
    expect((await stored(id)).controlRequest).toBe("cancel");
  });
});

describe("the control table: settled", () => {
  it("finished, failed and cancelled crawls refuse both, naming the status", async () => {
    for (const status of ["finished", "failed", "cancelled"]) {
      const id = await seedRow(status, status === "cancelled" ? { cancelledAt: new Date() } : {});
      for (const res of [await pause(id), await cancel(id)]) {
        expect(res.status, `${status}`).toBe(409);
        expect(String(res.body["error"])).toContain(`'${status}'`);
      }
      expect((await stored(id)).status).toBe(status);
    }
  });

  it("404s a crawl nobody has, refuses a body, and checks the token", async () => {
    for (const verb of ["pause", "cancel"]) {
      expect((await call("POST", `/crawls/crawl_missing/${verb}`)).status).toBe(404);
      const id = await seedRow("queued");
      expect((await call("POST", `/crawls/${id}/${verb}`, { body: { now: true } })).status).toBe(400);
      expect((await call("POST", `/crawls/${id}/${verb}`, { token: null })).status).toBe(401);
      expect((await stored(id)).status).toBe("queued");
    }
  });
});

describe("crawl_resume around pause and cancel", () => {
  it("refuses a cancelled crawl: a cancel is final", async () => {
    const id = await seedRow("cancelled", { cancelledAt: new Date(), discovery: mkDiscovery() });
    await db.insert(frontier).values({ crawlId: id, url: `${site}/owed`, state: "pending", depth: 1, discoveredVia: "link" });
    const res = await resume(id);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("cancelled");
    expect(String(res.body["error"])).toContain("final");
    expect((await stored(id)).status).toBe("cancelled");
  });

  // A pause that landed while the crawl was still queued: it never ran, so it
  // owes the whole crawl, and resuming it must not be "nothing to resume".
  it("resumes a paused crawl: 202, queued, pause_reason cleared", async () => {
    const { running, waiting } = await runningAndWaiting();
    expect((await pause(waiting)).status).toBe(200);
    await stopRunning(running);

    const res = await resume(waiting);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ crawlId: waiting, status: "queued" });
    const row = await stored(waiting);
    expect(row.pauseReason).toBeNull();
    expect(["queued", "running"]).toContain(row.status);

    await until("it runs", waiting, (b) => b["status"] === "running");
    await stopRunning(waiting);
  }, 60_000);

  it("refuses resume and cancel while a rules run holds the crawl", async () => {
    const id = await seedPausedJudgeable();
    let release!: () => void;
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    gates.rules.hold = new Promise<void>((r) => {
      release = r;
    });
    gates.rules.entered = entered;
    const run = call("POST", `/crawls/${id}/rules`);
    try {
      await inFlight;
      const resumed = await resume(id);
      expect(resumed.status).toBe(409);
      expect(String(resumed.body["error"])).toContain("crawl_resume");
      expect(String(resumed.body["error"])).toContain("rules are running");
      const cancelled = await cancel(id);
      expect(cancelled.status).toBe(409);
      expect(String(cancelled.body["error"])).toContain("crawl_cancel");
      expect(String(cancelled.body["error"])).toContain("rules are running");
      expect((await stored(id)).status).toBe("paused");
    } finally {
      gates.rules.hold = null;
      gates.rules.entered = null;
      release();
    }
    expect((await run).status).toBe(200);
  }, 60_000);
});

describe("the render guard", () => {
  it("a second render, a cancel and a resume are refused while a render pass runs on a paused crawl", async () => {
    const id = await seedPausedJudgeable();
    let release!: () => void;
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    gates.render.hold = new Promise<void>((r) => {
      release = r;
    });
    gates.render.entered = entered;
    const first = call("POST", `/crawls/${id}/render`);
    try {
      await inFlight;
      const second = await call("POST", `/crawls/${id}/render`);
      expect(second.status).toBe(409);
      expect(String(second.body["error"])).toContain("a render pass is running");

      const cancelled = await cancel(id);
      expect(cancelled.status).toBe(409);
      expect(String(cancelled.body["error"])).toContain("crawl_cancel");
      expect(String(cancelled.body["error"])).toContain("a render pass is running");

      const resumed = await resume(id);
      expect(resumed.status).toBe(409);
      expect(String(resumed.body["error"])).toContain("a render pass is running");
      expect((await stored(id)).status).toBe("paused");
    } finally {
      gates.render.hold = null;
      gates.render.entered = null;
      release();
    }
    expect((await first).status).toBe(200);
    // Released: the next pass is not refused by a hold nobody has.
    const after = await cancel(id);
    expect(after.status).toBe(200);
  }, 120_000);
});

describe("a restart (gate clause 4)", () => {
  it("a paused crawl stays paused across a restart, nothing starts it, and crawl_resume finishes it", async () => {
    const a = await start(40);
    // `pagesCrawled` is written when a run closes; the frontier counts live.
    await until(
      "running with pages",
      a.id,
      (b) => b["status"] === "running" && (b["frontier"] as { done: number }).done >= 1,
    );
    expect((await pause(a.id)).status).toBe(202);
    await until("paused", a.id, (b) => b["status"] === "paused");
    const owed = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(frontier)
      .where(and(eq(frontier.crawlId, a.id), eq(frontier.state, "pending")));
    expect(owed[0]?.n ?? 0).toBeGreaterThan(0);

    await api.close();
    const restartedAt = serverLog.length;
    api = await newApi();

    await sleep(500);
    expect(serverLog.slice(restartedAt).filter((line) => line.includes(a.id))).toEqual([]);
    const after = await detail(a.id);
    expect(after["status"]).toBe("paused");
    expect(after["pauseReason"]).toBe("request");
    expect(after["queuePosition"]).toBeNull();

    const res = await resume(a.id);
    expect(res.status).toBe(202);
    const final = await until("finished", a.id, (b) => b["status"] === "finished", 60_000);
    expect(final["pauseReason"]).toBeNull();
    expect(final["pagesCrawled"]).toBe(40);
  }, 120_000);
});

describe("crawl_mark_failed", () => {
  it("clears a pending cancel on the running orphan it retires", async () => {
    const id = await seedRow("running", { controlRequest: "cancel" });
    const res = await call("POST", `/crawls/${id}/fail`);
    expect(res.status).toBe(200);
    expect(await stored(id)).toMatchObject({ status: "failed", controlRequest: null });
  });
});

describe("MCP: crawl_pause and crawl_cancel", () => {
  it("are on the tool list", () => {
    expect(TOOL_NAMES).toContain("crawl_pause");
    expect(TOOL_NAMES).toContain("crawl_cancel");
  });

  it("answer the bodies HTTP answers, for a queued crawl", async () => {
    const overMcp = await seedRow("queued");
    const overHttp = await seedRow("queued");
    const strip = (body: Record<string, unknown>): Record<string, unknown> => ({ ...body, crawlId: "<id>" });

    const mcpPause = await tool("crawl_pause", { crawlId: overMcp });
    const httpPause = await pause(overHttp);
    expect(mcpPause.isError).toBe(false);
    expect(mcpPause.body).toEqual({ crawlId: overMcp, status: "paused", controlRequested: null, immediate: true });
    expect(strip(mcpPause.body)).toEqual(strip(httpPause.body));

    const mcpAgain = await tool("crawl_pause", { crawlId: overMcp });
    const httpAgain = await pause(overHttp);
    expect(mcpAgain.isError).toBe(true);
    expect(httpAgain.status).toBe(409);
    expect(String(mcpAgain.body["error"]).replaceAll(overMcp, "<id>")).toBe(
      String(httpAgain.body["error"]).replaceAll(overHttp, "<id>"),
    );

    const mcpCancel = await tool("crawl_cancel", { crawlId: overMcp });
    const httpCancel = await cancel(overHttp);
    expect(mcpCancel.isError).toBe(false);
    expect(mcpCancel.body).toEqual({ crawlId: overMcp, status: "cancelled", controlRequested: null, immediate: true });
    expect(strip(mcpCancel.body)).toEqual(strip(httpCancel.body));
  });

  it("describe a request, not an outcome, and crawl_status / crawl_resume name paused and the cancel rule", async () => {
    const listed = await client.listTools();
    const text = (name: string): string => listed.tools.find((t) => t.name === name)?.description ?? "";
    for (const name of ["crawl_pause", "crawl_cancel"]) {
      expect(text(name), name).toContain("poll crawl_status");
    }
    expect(text("crawl_status")).toContain("paused");
    expect(text("crawl_resume")).toContain("paused");
    expect(text("crawl_resume")).toContain("final");
  });
});

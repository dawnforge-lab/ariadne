import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import {
  CONTROL_POLL_MS,
  readControlRequest,
  readPauseReason,
  setControlRequest,
} from "../../src/crawl/control.js";
import { frontierCounts } from "../../src/crawl/frontier.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import {
  ClaimLostError,
  resumeCrawl,
  runCrawl,
  storableConfig,
  type CrawlConfig,
  type CrawlSummary,
} from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages, resources } from "../../src/db/schema.js";
import { startFixtureApp, type FixtureApp } from "../fixtures/app.js";
import { startAssetHost, type AssetHost } from "../fixtures/assets.js";
import { allFixtures } from "../fixtures/fixture.js";
import { startOffsiteHost, type OffsiteHost } from "../fixtures/pages/render-p5.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

describe("control readers", () => {
  it("readControlRequest passes null and the two requests, refuses anything else naming the crawl", () => {
    expect(readControlRequest(null, "crawl_a")).toBeNull();
    expect(readControlRequest("pause", "crawl_a")).toBe("pause");
    expect(readControlRequest("cancel", "crawl_a")).toBe("cancel");
    expect(() => readControlRequest("stop", "crawl_a")).toThrow(/crawl_a.*"stop"/);
    expect(() => readControlRequest(undefined, "crawl_a")).toThrow(/crawl_a/);
  });

  it("readPauseReason passes null and the two reasons, refuses anything else naming the crawl", () => {
    expect(readPauseReason(null, "crawl_b")).toBeNull();
    expect(readPauseReason("request", "crawl_b")).toBe("request");
    expect(readPauseReason("shutdown", "crawl_b")).toBe("shutdown");
    expect(() => readPauseReason("later", "crawl_b")).toThrow(/crawl_b.*"later"/);
  });
});

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` every 10 ms until it holds, or throw naming what never happened. */
async function until(what: string, predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

let db: Db;
const createdCrawls: string[] = [];

/**
 * The id of the crawl of `siteUrl` this test just started, read off the table
 * because `runCrawl` has not returned yet: the one row for that site this file
 * has not already recorded.
 */
async function newCrawlOf(siteUrl: string): Promise<string> {
  let id: string | null = null;
  await until(`a new crawl row for ${siteUrl}`, async () => {
    const rows = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.siteUrl, siteUrl));
    const fresh = rows.filter((r) => !createdCrawls.includes(r.id));
    if (fresh.length > 1) throw new Error(`two new crawls of ${siteUrl} at once`);
    id = fresh[0]?.id ?? null;
    return id !== null;
  });
  if (id === null) throw new Error("unreachable");
  const crawlId: string = id;
  createdCrawls.push(crawlId);
  return crawlId;
}


/**
 * THE STALL SITE. Forty pages that each answer after 50 ms, plus `/stall`,
 * which never answers until `stallAnswers` is flipped.
 *
 *   /        -> /p2 /p3 /p4 /p5
 *   /p2      -> /stall, /p6 … /p40
 *   others   -> nothing
 *
 * `/stall` hangs off `/p2` rather than off the seed so the frontier has five
 * `done` rows BEFORE it is leased: the batch that holds it cannot settle while
 * it hangs, and a stall in the seed's batch would keep `done` below five (the
 * writer flushes at the batch boundary) until its 20 s deadline. Each test
 * waits for the server to have SEEN the `/stall` request, so the control
 * request provably lands with a fetch in flight.
 */
let stallServer: Server;
let stallBase: string;
let stallAnswers = false;
let stallRequests = 0;
const heldStalls = new Set<ServerResponse>();

const PAGE_COUNT = 40;

function stallSite(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/stall") {
      stallRequests += 1;
      if (stallAnswers) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><head><title>Stall</title></head><body><p>late</p></body></html>");
        return;
      }
      heldStalls.add(res);
      res.on("close", () => heldStalls.delete(res));
      return;
    }
    let links: string[] | null = null;
    if (path === "/") links = ["/p2", "/p3", "/p4", "/p5"];
    else if (path === "/p2") {
      links = ["/stall"];
      for (let n = 6; n <= PAGE_COUNT; n += 1) links.push(`/p${n}`);
    } else {
      const m = /^\/p(\d+)$/.exec(path);
      if (m !== null && Number(m[1]) >= 3 && Number(m[1]) <= PAGE_COUNT) links = [];
    }
    if (links === null) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Not found</title><p>nothing here</p>");
      return;
    }
    const body =
      `<!doctype html><html><head><title>Page ${path}</title></head><body>` +
      `<h1>${path}</h1>` +
      links.map((href) => `<a href="${href}">${href}</a>`).join(" ") +
      `</body></html>`;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    }, 50);
  });
}

function stallConfig(overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: `${stallBase}/`,
    maxPages: 100,
    maxDepth: 10,
    userAgent: "AriadneBot-control-test",
    perHostDelayMs: 0,
    maxConcurrency: 4,
    probeHosts: false,
    allowPrivate: true,
    ...overrides,
  };
}

/**
 * Start a crawl of the stall site and resolve once `/stall` is in flight with at
 * least five URLs done — the moment every control test acts at. Returns the
 * crawl id (read off the row, since `runCrawl` has not returned) and the run.
 */
async function startStalled(signal?: AbortSignal): Promise<{ id: string; run: Promise<CrawlSummary> }> {
  stallAnswers = false;
  const before = stallRequests;
  const run = runCrawl(db, LOCAL_TENANT, stallConfig(), signal);
  run.catch(() => undefined); // asserted by the caller; never left unhandled
  const crawlId = await newCrawlOf(`${stallBase}/`);
  await until(
    "/stall in flight with five URLs done",
    async () => stallRequests > before && (await frontierCounts(db, crawlId)).done >= 5,
  );
  return { id: crawlId, run };
}

async function crawlRow(id: string) {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl row ${id}`);
  return row;
}

async function stallFrontierRow(id: string) {
  const [row] = await db
    .select()
    .from(frontier)
    .where(and(eq(frontier.crawlId, id), eq(frontier.url, `${stallBase}/stall`)));
  if (row === undefined) throw new Error("no frontier row for /stall");
  return row;
}

/**
 * THE EPILOGUE SITE (Review Focus 1). Five pages, sixty image references
 * between them, every image answering after 400 ms — a resource pass slow
 * enough that a pause lands in the middle of it.
 */
let imageServer: Server;
let imageBase: string;
const IMAGE_COUNT = 60;

function imageSite(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const img = /^\/img\/(\d+)\.png$/.exec(path);
    if (img !== null) {
      setTimeout(() => {
        const body = Buffer.alloc(64, 1);
        res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
        res.end(req.method === "HEAD" ? undefined : body);
      }, 400);
      return;
    }
    const page = path === "/" ? 1 : Number(/^\/q(\d+)$/.exec(path)?.[1] ?? NaN);
    if (!(page >= 1 && page <= 5)) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Not found</title><p>nothing here</p>");
      return;
    }
    const links = page === 1 ? ["/q2", "/q3", "/q4", "/q5"] : [];
    const images: string[] = [];
    for (let n = (page - 1) * 12 + 1; n <= page * 12; n += 1) images.push(`/img/${n}.png`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>Q ${page}</title></head><body>` +
        links.map((href) => `<a href="${href}">${href}</a>`).join(" ") +
        images.map((src) => `<img src="${src}" alt="i" width="8" height="8">`).join("") +
        `</body></html>`,
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  stallServer = stallSite();
  stallBase = await listen(stallServer);
  imageServer = imageSite();
  imageBase = await listen(imageServer);
});

afterAll(async () => {
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  for (const res of heldStalls) res.destroy();
  stallServer.closeAllConnections();
  await new Promise<void>((r) => stallServer.close(() => r()));
  imageServer.closeAllConnections();
  await new Promise<void>((r) => imageServer.close(() => r()));
});

describe("pause and resume", () => {
  it("pauses on a request within one poll interval, aborting the stalled fetch, and resumes to the same crawl", async () => {
    const { id, run } = await startStalled();

    const setAt = Date.now();
    expect(await setControlRequest(db, id, "pause")).toBe(true);
    await until("the row to read paused", async () => (await crawlRow(id)).status === "paused", 10_000);
    const latencyMs = Date.now() - setAt;
    console.log(`pause latency: ${latencyMs} ms (poll ${CONTROL_POLL_MS} ms)`);
    // The abort reached `/stall`: without it the batch would hang until the
    // 20 s fetch deadline.
    expect(latencyMs).toBeLessThanOrEqual(CONTROL_POLL_MS + 2_000);

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.pauseReason).toBe("request");
    expect(summary.note).toMatch(/^paused \(request\); the frontier still holds \d+ pending URL\(s\)$/);

    const row = await crawlRow(id);
    expect(row.status).toBe("paused");
    expect(row.pauseReason).toBe("request");
    expect(row.controlRequest).toBeNull();
    expect(row.cancelledAt).toBeNull();
    expect(row.finishedAt).not.toBeNull();

    // The aborted fetch is not a failure: no failed frontier row, no page row,
    // and its attempt is refunded.
    const failed = await db
      .select()
      .from(frontier)
      .where(and(eq(frontier.crawlId, id), eq(frontier.state, "failed")));
    expect(failed).toEqual([]);
    const stallPages = await db
      .select()
      .from(pages)
      .where(and(eq(pages.crawlId, id), eq(pages.url, `${stallBase}/stall`)));
    expect(stallPages).toEqual([]);
    const stallRow = await stallFrontierRow(id);
    expect(stallRow.state).toBe("pending");
    expect(stallRow.attempts).toBe(0);

    // Resume, with /stall now answering at once.
    stallAnswers = true;
    const resumed = await resumeCrawl(db, id, { config: stallConfig() });
    expect(resumed.status).toBe("finished");
    expect(resumed.pauseReason).toBeNull();
    const after = await crawlRow(id);
    expect(after.status).toBe("finished");
    expect(after.pauseReason).toBeNull();
    expect(after.controlRequest).toBeNull();

    const counts = await db.execute<{ total: number; distinct: number }>(sql`
      select count(*)::int as total, count(distinct url)::int as distinct
      from pages where crawl_id = ${id}`);
    expect(counts.rows[0]).toEqual({ total: PAGE_COUNT + 1, distinct: PAGE_COUNT + 1 });
  }, 60_000);
});

describe("a pause under a long per-host spacing (Ruling 2)", () => {
  it("does not wait out the queued host slots before it pauses", async () => {
    stallAnswers = false;
    // One host, 2 s apart, four wide: the batch after the seed has its
    // handlers queued on the gate at +2 s, +4 s, +6 s and +8 s. Without the
    // signal reaching `HostGate.acquire` the pause would land after the last.
    const config = stallConfig({ perHostDelayMs: 2_000, maxConcurrency: 4 });
    const run = runCrawl(db, LOCAL_TENANT, config);
    run.catch(() => undefined);
    const id = await newCrawlOf(`${stallBase}/`);
    await until("the seed to be done", async () => (await frontierCounts(db, id)).done >= 1);

    const setAt = Date.now();
    expect(await setControlRequest(db, id, "pause")).toBe(true);
    await until("the row to read paused", async () => (await crawlRow(id)).status === "paused", 15_000);
    const latencyMs = Date.now() - setAt;
    console.log(`paced pause latency: ${latencyMs} ms (poll ${CONTROL_POLL_MS} ms, spacing 2000 ms)`);
    expect(latencyMs).toBeLessThanOrEqual(CONTROL_POLL_MS + 2_000);

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.pauseReason).toBe("request");
    const failed = await db
      .select()
      .from(frontier)
      .where(and(eq(frontier.crawlId, id), eq(frontier.state, "failed")));
    expect(failed).toEqual([]);
    const leased = await db
      .select()
      .from(frontier)
      .where(and(eq(frontier.crawlId, id), eq(frontier.state, "leased")));
    expect(leased).toEqual([]);
  }, 60_000);
});

describe("cancel", () => {
  it("cancels within one poll interval, skips the epilogue passes, still infers templates, and is final", async () => {
    const { id, run } = await startStalled();

    const setAt = Date.now();
    expect(await setControlRequest(db, id, "cancel")).toBe(true);
    await until("the row to read cancelled", async () => (await crawlRow(id)).status === "cancelled", 10_000);
    const latencyMs = Date.now() - setAt;
    console.log(`cancel latency: ${latencyMs} ms (poll ${CONTROL_POLL_MS} ms)`);
    expect(latencyMs).toBeLessThanOrEqual(CONTROL_POLL_MS + 2_000);

    const summary = await run;
    expect(summary.status).toBe("cancelled");
    expect(summary.pauseReason).toBeNull();
    expect(summary.resources).toBeNull();
    expect(summary.recheck).toBeNull();
    expect(summary.note).toMatch(/^cancelled; \d+ URL\(s\) were never fetched$/);

    const row = await crawlRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.cancelledAt).not.toBeNull();
    expect(row.pauseReason).toBeNull();
    expect(row.controlRequest).toBeNull();
    expect(row.notfoundProbe).toMatchObject({ skipped: expect.any(String) });
    expect(row.templateInferenceJsonb).not.toBeNull();

    const failed = await db
      .select()
      .from(frontier)
      .where(and(eq(frontier.crawlId, id), eq(frontier.state, "failed")));
    expect(failed).toEqual([]);

    await expect(resumeCrawl(db, id, { config: stallConfig() })).rejects.toThrow(/is cancelled.*final/);
    expect((await crawlRow(id)).status).toBe("cancelled");
  }, 60_000);

  it("setControlRequest touches only a running crawl", async () => {
    const id = `crawl_ctl_${Date.now()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: `${stallBase}/`, hostKey: hostKeyOf(`${stallBase}/`),
      config: storableConfig(stallConfig()),
      rulesetVersion: "test",
      status: "paused",
      pauseReason: "request",
    });
    createdCrawls.push(id);
    expect(await setControlRequest(db, id, "cancel")).toBe(false);
    expect((await crawlRow(id)).controlRequest).toBeNull();
  });
});

describe("a shutdown is a pause", () => {
  it("the run's own signal with no request closes paused / shutdown", async () => {
    const ac = new AbortController();
    const { id, run } = await startStalled(ac.signal);
    ac.abort();
    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.pauseReason).toBe("shutdown");
    const row = await crawlRow(id);
    expect(row.status).toBe("paused");
    expect(row.pauseReason).toBe("shutdown");
    expect(row.cancelledAt).toBeNull();
    expect((await stallFrontierRow(id)).state).toBe("pending");
  }, 60_000);

  it("a pause request then the signal closes paused / request (Review Focus 5)", async () => {
    const ac = new AbortController();
    const { id, run } = await startStalled(ac.signal);
    expect(await setControlRequest(db, id, "pause")).toBe(true);
    ac.abort();
    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.pauseReason).toBe("request");
    const row = await crawlRow(id);
    expect(row.pauseReason).toBe("request");
    expect(row.controlRequest).toBeNull();
  }, 60_000);

  it("a cancel request then the signal closes cancelled", async () => {
    const ac = new AbortController();
    const { id, run } = await startStalled(ac.signal);
    expect(await setControlRequest(db, id, "cancel")).toBe(true);
    ac.abort();
    const summary = await run;
    expect(summary.status).toBe("cancelled");
    expect(summary.pauseReason).toBeNull();
    const row = await crawlRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.cancelledAt).not.toBeNull();
    expect(row.pauseReason).toBeNull();
    expect(row.controlRequest).toBeNull();
  }, 60_000);
});

describe("a failed control poll", () => {
  it("ends the run failed with the poll's error, never paused (rule 7)", async () => {
    const { id, run } = await startStalled();
    // A value this engine never writes: the reader throws naming the crawl.
    await db.update(crawls).set({ controlRequest: "stop" }).where(eq(crawls.id, id));

    await expect(run).rejects.toThrow(new RegExp(`${id}.*"stop"`));
    const row = await crawlRow(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toContain('"stop"');
    expect(row.controlRequest).toBeNull();
    expect(row.pauseReason).toBeNull();
    // The abort it caused still put the stalled fetch back, not into `failed`.
    expect((await stallFrontierRow(id)).state).toBe("pending");
  }, 60_000);
});

describe("a pause during the resource pass (Review Focus 1)", () => {
  it("closes paused with resources unasked, and the resume asks them", async () => {
    const config: CrawlConfig = {
      siteUrl: `${imageBase}/`,
      maxPages: 20,
      maxDepth: 3,
      userAgent: "AriadneBot-control-test",
      perHostDelayMs: 0,
      maxConcurrency: 4,
      probeHosts: false,
      allowPrivate: true,
    };
    const run = runCrawl(db, LOCAL_TENANT, config);
    run.catch(() => undefined);
    const crawlId = await newCrawlOf(`${imageBase}/`);

    await until("the first resource to be classified", async () => {
      const rows = await db
        .select({ url: resources.url })
        .from(resources)
        .where(and(eq(resources.crawlId, crawlId), isNotNull(resources.fetchClass)))
        .limit(1);
      return rows.length > 0;
    });
    expect(await setControlRequest(db, crawlId, "pause")).toBe(true);

    const summary = await run;
    expect(summary.status).toBe("paused");
    expect(summary.pauseReason).toBe("request");
    expect(summary.resources?.aborted).toBe(true);
    const unasked = await db
      .select({ url: resources.url })
      .from(resources)
      .where(and(eq(resources.crawlId, crawlId), isNull(resources.fetchClass)));
    expect(unasked.length).toBeGreaterThan(0);

    const resumed = await resumeCrawl(db, crawlId, { config });
    expect(resumed.status).toBe("finished");
    const all = await db.select().from(resources).where(eq(resources.crawlId, crawlId));
    expect(all).toHaveLength(IMAGE_COUNT);
    expect(all.filter((r) => r.fetchClass === null)).toEqual([]);
  }, 60_000);
});

describe("the claim", () => {
  it("a resume that expects 'queued' and finds 'paused' throws ClaimLostError and changes nothing", async () => {
    const id = `crawl_claim_${Date.now()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: `${stallBase}/`, hostKey: hostKeyOf(`${stallBase}/`),
      config: storableConfig(stallConfig()),
      rulesetVersion: "test",
      status: "paused",
      pauseReason: "request",
      finishedAt: new Date(),
    });
    createdCrawls.push(id);
    const before = await crawlRow(id);

    const error = await resumeCrawl(db, id, { config: stallConfig(), expectStatus: "queued" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ClaimLostError);
    expect((error as ClaimLostError).status).toBe("paused");
    expect((error as ClaimLostError).crawlId).toBe(id);
    expect(await crawlRow(id)).toEqual(before);
  });

  it("a resume that expects 'queued' and finds 'cancelled' throws ClaimLostError, not the final-cancel Error (Ruling 3)", async () => {
    const id = `crawl_claim_c_${Date.now()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: `${stallBase}/`, hostKey: hostKeyOf(`${stallBase}/`),
      config: storableConfig(stallConfig()),
      rulesetVersion: "test",
      status: "cancelled",
      cancelledAt: new Date(),
      finishedAt: new Date(),
    });
    createdCrawls.push(id);
    const before = await crawlRow(id);

    const error = await resumeCrawl(db, id, { config: stallConfig(), expectStatus: "queued" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ClaimLostError);
    expect((error as ClaimLostError).status).toBe("cancelled");
    expect(await crawlRow(id)).toEqual(before);

    // Without expectStatus a cancelled crawl is still the plain final-cancel Error.
    const plain = await resumeCrawl(db, id, { config: stallConfig() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(plain).not.toBeInstanceOf(ClaimLostError);
    expect(String((plain as Error).message)).toMatch(/is cancelled.*final/);
  });

  it("a resume that expects 'queued' of a crawl that does not exist is a plain Error, not a lost claim", async () => {
    const error = await resumeCrawl(db, `crawl_missing_${Date.now()}`, {
      config: stallConfig(),
      expectStatus: "queued",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ClaimLostError);
    expect(String((error as Error).message)).toMatch(/no crawl/);
  });
});

describe("pause/resume equivalence on the fixture site (gate 27b clause 1)", () => {
  let app: FixtureApp;
  let offsite: OffsiteHost;
  let assetHost: AssetHost;

  beforeAll(async () => {
    offsite = await startOffsiteHost();
    assetHost = await startAssetHost();
    app = await startFixtureApp(allFixtures());
  });

  afterAll(async () => {
    await closeFetchAgents();
    if (app !== undefined) await app.close();
    if (offsite !== undefined) await offsite.close();
    if (assetHost !== undefined) await assetHost.close();
  });

  function fixtureConfig(): CrawlConfig {
    return {
      siteUrl: app.base,
      maxPages: 500,
      maxDepth: 10,
      userAgent: "AriadneBot-fixture",
      perHostDelayMs: 0,
      maxConcurrency: 8,
      legacyHosts: [app.legacyBase],
      allowPrivate: true,
      recheckMinGapMs: 200,
    };
  }

  async function pageSet(id: string): Promise<string[]> {
    const rows = await db
      .select({ url: pages.url, fetchClass: pages.fetchClass })
      .from(pages)
      .where(eq(pages.crawlId, id));
    return rows.map((r) => `${r.url} ${r.fetchClass}`).sort();
  }

  it("a crawl paused once done >= 10 and resumed ends with the uninterrupted crawl's pages and fetch classes", async () => {
    const a = await runCrawl(db, LOCAL_TENANT, fixtureConfig());
    createdCrawls.push(a.crawlId);
    expect(a.status).toBe("finished");

    const run = runCrawl(db, LOCAL_TENANT, fixtureConfig());
    run.catch(() => undefined);
    const bId = await newCrawlOf(app.base);
    await until("crawl B to have ten URLs done", async () => (await frontierCounts(db, bId)).done >= 10, 60_000);
    expect(await setControlRequest(db, bId, "pause")).toBe(true);
    const paused = await run;
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("request");
    expect(paused.frontier.pending).toBeGreaterThan(0);

    const resumed = await resumeCrawl(db, bId, { config: fixtureConfig() });
    expect(resumed.status).toBe("finished");

    const setA = await pageSet(a.crawlId);
    const setB = await pageSet(bId);
    expect(setA.length).toBeGreaterThan(10);
    expect(setB).toEqual(setA);
  }, 240_000);
});

/**
 * THE AFTER-CLOSE FAULT (27b final M3). `frontierCounts` is the real function,
 * unchanged, except that while a test arms it for a crawl id it throws ONCE,
 * on its first call after that crawl's row has left `running` — which is
 * `summarise`, the first read after the close. One-shot, so `execute`'s own
 * failed-close path reads the frontier normally and its UPDATE is what the
 * test watches. Hoisted, like every `vi.mock`, so it sits at the end of the
 * file without moving any line above it.
 */
const afterClose = vi.hoisted(() => ({ armed: null as string | null, fired: false }));

vi.mock("../../src/crawl/frontier.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/crawl/frontier.js")>();
  const { crawls: crawlsTable } = await import("../../src/db/schema.js");
  const { eq: eqOp } = await import("drizzle-orm");
  return {
    ...real,
    frontierCounts: async (...args: Parameters<typeof real.frontierCounts>) => {
      const [database, crawlId] = args;
      if (afterClose.armed === crawlId && !afterClose.fired) {
        const [row] = await database
          .select({ status: crawlsTable.status })
          .from(crawlsTable)
          .where(eqOp(crawlsTable.id, crawlId));
        if (row !== undefined && row.status !== "running") {
          afterClose.fired = true;
          throw new Error(`injected fault: frontierCounts after crawl ${crawlId} closed '${row.status}'`);
        }
      }
      return await real.frontierCounts(...args);
    },
  };
});

describe("a failure after a stopped close (27b final M3)", () => {
  it("does not re-close a cancelled crawl failed: the row stays cancelled, and the original error still surfaces", async () => {
    const { id, run } = await startStalled();
    afterClose.armed = id;
    afterClose.fired = false;
    try {
      expect(await setControlRequest(db, id, "cancel")).toBe(true);
      const error = await run.then(
        () => {
          throw new Error("the run resolved; the injected fault never fired");
        },
        (e: unknown) => e,
      );
      expect(afterClose.fired).toBe(true);
      expect(error).toBeInstanceOf(AggregateError);
      const message = String((error as Error).message);
      expect(message).toContain(id);
      const inner = (error as AggregateError).errors.map((e: unknown) => String((e as Error).message));
      expect(inner.some((m) => m.includes("injected fault"))).toBe(true);
      expect(inner.some((m) => m.includes("already") && m.includes("cancelled"))).toBe(true);

      const row = await crawlRow(id);
      expect(row.status).toBe("cancelled");
      expect(row.cancelledAt).not.toBeNull();
      expect(row.failureReason).toBeNull();
    } finally {
      afterClose.armed = null;
    }
  }, 60_000);
});

describe("a robots-unreachable close while the control poll has failed (27b final M7)", () => {
  let robotsDown: Server;
  let robotsDownBase: string;

  beforeAll(async () => {
    // robots.txt answers 503 after 800 ms, every try: three tries put the
    // unreachable verdict well after the watcher's first failed poll.
    robotsDown = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("down");
      }, 800);
    });
    robotsDownBase = await listen(robotsDown);
  });

  afterAll(async () => {
    robotsDown.closeAllConnections();
    await new Promise<void>((r) => robotsDown.close(() => r()));
  });

  it("keeps the robots note in the failure reason beside the poll failure", async () => {
    // The poll fails once discovery has concluded robots.txt unreachable: a
    // poll that fails DURING the walk stops it (27d), and no note exists then.
    let known!: (crawlId: string) => void;
    const crawlIdKnown = new Promise<string>((resolve) => (known = resolve));
    const run = runCrawl(db, LOCAL_TENANT, stallConfig({ siteUrl: `${robotsDownBase}/` }), undefined, {
      afterDiscovery: async (stop) => {
        // A value this engine never writes: the watcher's next poll fails on it.
        await db.update(crawls).set({ controlRequest: "stop" }).where(eq(crawls.id, await crawlIdKnown));
        await until("the failed poll to stop the run", () => stop.aborted, 10_000);
      },
    });
    run.catch(() => undefined); // asserted below; never left unhandled
    const id = await newCrawlOf(`${robotsDownBase}/`);
    known(id);

    const error = await run.then(
      () => {
        throw new Error("the run resolved");
      },
      (e: unknown) => e,
    );
    const message = String((error as Error).message);
    expect(message).toContain("robots.txt unreachable");
    const row = await crawlRow(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toContain("robots.txt unreachable");
    expect(row.failureReason).toContain("control poll");
    expect(error).toBeInstanceOf(AggregateError);
    const inner = (error as AggregateError).errors.map((e: unknown) => String((e as Error).message));
    expect(inner.some((m) => m.includes('"stop"'))).toBe(true);
  }, 60_000);
});

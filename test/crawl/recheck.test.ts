/**
 * The 5xx re-verification pass, driven against a real HTTP server (P17-T2,
 * §5.3 of docs/superpowers/specs/2026-09-08-5xx-recheck-design.md).
 *
 * Its own small `node:http` fixture rather than the shared fixture app, in the
 * `test/db/migration-0013.test.ts` style, because the one page shape this pass
 * exists for is a FLAPPING one — 503 to the crawl, 200 to the second look — and
 * a stateful route in the shared app would change what every other file's crawl
 * sees.
 *
 * Rows are seeded exactly as `PageWriter` leaves them (a `server_error` row with
 * a `fetched_at` and four null recheck columns) rather than crawled, for the
 * `test/crawl/fetch-resources.test.ts` reason and one of this pass's own: the
 * loop's own INSERTION 3c runs at the real `MIN_RECHECK_GAP_MS`, so a file that
 * drove `runCrawl` for each case would wait a real minute per case. The pass's
 * TEST-ONLY `minGapMs` is what keeps this file fast, and the end-to-end claim
 * the seeding cannot make — that a real crawl asks a 5xx page exactly one more
 * time and a healthy page not at all — is asserted in
 * `test/db/migration-0016.test.ts`, which drives the whole loop.
 *
 * The per-path request counter is the politeness and budget evidence: a test
 * that only read the rows could not see a row that was refused being fetched
 * anyway, nor a capped row being asked about.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { RobotsInfo } from "../../src/crawl/discovery.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { HostGate, type HostOutcome } from "../../src/crawl/politeness.js";
import {
  recheckServerErrors,
  RECHECK_CAP_REASON,
  type RecheckPassSummary,
} from "../../src/crawl/recheck/recheck-server-errors.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

let db: Db;
let server: Server;
let base: string;
let host = "";

/** Every request the fixture answered, in order. */
const hits: { path: string; at: number }[] = [];

/**
 * Fired with each request's path as it arrives. The abort cases use it to
 * cancel from INSIDE the pass, which is the only way to stop at a known row
 * rather than at a hoped-for moment.
 */
let onHit: ((path: string) => void) | null = null;

function hitCount(path: string): number {
  return hits.filter((hit) => hit.path === path).length;
}

/** The crawl rows this file created. It owns them; nothing sweeps by pattern. */
const createdCrawls: string[] = [];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push({ path, at: Date.now() });
    onHit?.(path);

    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    // THE FLAPPING PAGE this pass exists for. The 503 half of the flap is the
    // SEEDED ROW — it is exactly what `PageWriter` left behind when the crawl
    // saw it, and re-asking that row is the whole point — so what the fixture
    // owes is the second half: the site, recovered, answering the second look.
    // The stateful version of this route lives in test/db/migration-0016.test.ts,
    // where a real crawl takes the first look for itself.
    if (path === "/flaky") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("<p>better now</p>"));
      return;
    }
    // Confirmed-broken, however often it is asked.
    if (path.startsWith("/broken")) {
      res.writeHead(500, { "content-type": "text/html" });
      res.end(html("<p>boom</p>"));
      return;
    }
    if (path === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("<p>fine</p>"));
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end(html("<p>gone</p>"));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address() as AddressInfo | null;
  if (addr === null) throw new Error("no fixture port");
  base = `http://127.0.0.1:${addr.port}`;
  host = `127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await new Promise<void>((ok) => server.close(() => ok()));
  await closeFetchAgents();
});

beforeEach(() => {
  hits.length = 0;
  onHit = null;
});

function allowAllRobots(): RobotsInfo {
  return {
    fetched: true,
    outcome: "read",
    status: 200,
    attempts: 1,
    isAllowed: () => true,
    crawlDelaySec: null,
    sitemapUrls: [],
    raw: "User-agent: *\nAllow: /\n",
    truncated: false,
    note: null,
  };
}

async function seedCrawl(): Promise<string> {
  const crawlId = `crawl_recheck_${randomUUID()}`;
  await db.insert(crawls).values({
    id: crawlId,
    siteUrl: base,
    config: { siteUrl: base },
    rulesetVersion: "0.12.0",
    status: "finished",
  });
  createdCrawls.push(crawlId);
  return crawlId;
}

interface SeedPage {
  path: string;
  fetchClass: string;
  statusCode: number;
  /** Seconds ago the first observation was taken. Controls the walk's order. */
  agoSec?: number;
}

/** Rows in the shape `PageWriter` leaves them: fetched once, never rechecked. */
async function seedPages(crawlId: string, seeds: SeedPage[]): Promise<void> {
  await db.insert(pages).values(
    seeds.map((seed, index) => ({
      id: `page_${crawlId}_${index}`,
      crawlId,
      url: `${base}${seed.path}`,
      urlNormalised: `${base}${seed.path}`,
      fetchClass: seed.fetchClass,
      statusCode: seed.statusCode,
      depth: 0,
      discoveredVia: "seed",
      fetchedAt: new Date(Date.now() - (seed.agoSec ?? 0) * 1000),
    })),
  );
}

async function rowFor(crawlId: string, path: string) {
  const rows = await db
    .select()
    .from(pages)
    .where(and(eq(pages.crawlId, crawlId), eq(pages.url, `${base}${path}`)));
  const row = rows[0];
  if (row === undefined) throw new Error(`no pages row for ${path}`);
  return row;
}

/**
 * The gate the pass is handed, recording what it was told. `gate.report` after
 * every request is a politeness obligation no row can show, so the gate itself
 * is the witness.
 */
class RecordingGate extends HostGate {
  readonly reports: { host: string; outcome: HostOutcome }[] = [];

  override report(host: string, outcome: HostOutcome): void {
    this.reports.push({ host, outcome });
    super.report(host, outcome);
  }
}

/** The pass, with the arguments every case shares. */
async function runPass(
  crawlId: string,
  overrides: Partial<Parameters<typeof recheckServerErrors>[2]> = {},
): Promise<RecheckPassSummary> {
  return recheckServerErrors(db, crawlId, {
    userAgent: "AriadneBot-recheck-test",
    gate: new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null }),
    robots: allowAllRobots(),
    allowPrivate: true,
    timeoutMs: 5_000,
    // TEST ONLY, and the reason this file runs in seconds: the real floor is 60
    // seconds and it is the claim the evidence makes, not a tuning knob.
    minGapMs: 50,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1-4. What the second observation says, and who gets asked at all
// ---------------------------------------------------------------------------

describe("the second observation", () => {
  it("records a cleared 5xx without touching the first observation", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [{ path: "/flaky", fetchClass: "server_error", statusCode: 503 }]);

    const summary = await runPass(crawlId);

    const row = await rowFor(crawlId, "/flaky");
    // THE CENSUS IS UNTOUCHED. `fetch_class` is what every cohort in this engine
    // is cut from, so the row still says what the crawl saw.
    expect(row.fetchClass).toBe("server_error");
    expect(row.statusCode).toBe(503);
    // And the second look sits beside it.
    expect(row.recheckFetchClass).toBe("ok");
    expect(row.recheckStatusCode).toBe(200);
    expect(row.recheckAt).not.toBeNull();
    // A recheck that simply worked has nothing to say.
    expect(row.recheckReason).toBeNull();
    expect(summary).toMatchObject({
      rechecked: 1,
      confirmed: 0,
      cleared: 1,
      inconclusive: 0,
      capped: false,
      aborted: false,
    });
  });

  it("records a confirmed 5xx as the server error it still is", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [{ path: "/broken", fetchClass: "server_error", statusCode: 500 }]);

    const summary = await runPass(crawlId);

    const row = await rowFor(crawlId, "/broken");
    expect(row.recheckFetchClass).toBe("server_error");
    expect(row.recheckStatusCode).toBe(500);
    expect(row.recheckAt).not.toBeNull();
    expect(summary).toMatchObject({ rechecked: 1, confirmed: 1, cleared: 0, inconclusive: 0 });
  });

  it("asks nobody but the server errors, and asks each of them once", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/ok", fetchClass: "ok", statusCode: 200 },
      { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      { path: "/flaky", fetchClass: "server_error", statusCode: 503 },
    ]);

    await runPass(crawlId);

    // A healthy page and a 404 are ANSWERS. Nothing about them is unknown, so
    // nothing is re-asked and their recheck columns stay in the null contract's
    // first row: nobody asked.
    for (const path of ["/ok", "/gone"]) {
      const row = await rowFor(crawlId, path);
      expect(row.recheckFetchClass, path).toBeNull();
      expect(row.recheckStatusCode, path).toBeNull();
      expect(row.recheckReason, path).toBeNull();
      expect(row.recheckAt, path).toBeNull();
      expect(hitCount(path), path).toBe(0);
    }
    // ONE more request for the 5xx row, and one only: no retries (a timeout on
    // the recheck is a `timeout` row, not a second attempt).
    expect(hitCount("/flaky")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Politeness: the gate the page crawl used, and what it is told
// ---------------------------------------------------------------------------

describe("politeness", () => {
  it("spaces its requests on the shared gate and reports every one of them", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/broken-a", fetchClass: "server_error", statusCode: 500, agoSec: 2 },
      { path: "/broken-b", fetchClass: "server_error", statusCode: 500, agoSec: 1 },
    ]);

    // THE PAGE CRAWL'S GATE, with a real spacing on it. The pass takes the
    // instance, never a new one, so the host's queue is the queue the pages
    // stood in.
    const gate = new RecordingGate({ perHostDelayMs: 120, robotsCrawlDelaySec: null });
    await runPass(crawlId, { gate });

    const asked = hits.filter((hit) => hit.path.startsWith("/broken"));
    expect(asked.length).toBe(2);
    // One spacing apart, with the epsilon a wall-clock assertion needs.
    expect(asked[1]!.at - asked[0]!.at).toBeGreaterThanOrEqual(100);

    // Every request, told to the gate in the page vocabulary — which is what
    // makes a 503 on recheck escalate this host for the resource pass that
    // shares the gate.
    expect(gate.reports.length).toBe(2);
    for (const report of gate.reports) {
      expect(report.host).toBe(host);
      expect(report.outcome.fetchClass).toBe("server_error");
      expect(report.outcome.statusCode).toBe(500);
    }
  });

  it("keeps the spacing a host earned during the page crawl", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/broken-a", fetchClass: "server_error", statusCode: 500, agoSec: 2 },
      { path: "/broken-b", fetchClass: "server_error", statusCode: 500, agoSec: 1 },
    ]);

    const gate = new HostGate({ perHostDelayMs: 60, robotsCrawlDelaySec: null });
    // What the page crawl would have done on a 429: the host's spacing doubles,
    // and the ratchet never winds back inside a crawl.
    gate.report(host, {
      fetchClass: "blocked",
      statusCode: 429,
      retryAfterMs: null,
      url: `${base}/some-page`,
    });
    expect(gate.spacingMs(host)).toBe(120);

    await runPass(crawlId, { gate });

    const asked = hits.filter((hit) => hit.path.startsWith("/broken"));
    expect(asked.length).toBe(2);
    expect(asked[1]!.at - asked[0]!.at).toBeGreaterThanOrEqual(100);
  });

  it("waits out the minimum gap from each row's own first observation", async () => {
    const crawlId = await seedCrawl();
    // Seeded as fetched RIGHT NOW, so the whole gap is still owed.
    await seedPages(crawlId, [{ path: "/broken", fetchClass: "server_error", statusCode: 500 }]);

    const startedAt = Date.now();
    await runPass(crawlId, { minGapMs: 400 });
    const askedAt = hits.find((hit) => hit.path === "/broken")?.at;

    expect(askedAt).toBeDefined();
    // The gap is the measurement the finding quotes, so it is paid before the
    // request rather than reported after it.
    expect(askedAt! - startedAt).toBeGreaterThanOrEqual(350);
  });
});

// ---------------------------------------------------------------------------
// 6. Cancel
// ---------------------------------------------------------------------------

describe("cancel", () => {
  it("leaves both nulls on every row when the signal fired before the pass", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/broken-a", fetchClass: "server_error", statusCode: 500 },
      { path: "/broken-b", fetchClass: "server_error", statusCode: 500 },
    ]);

    const ac = new AbortController();
    ac.abort();
    const summary = await runPass(crawlId, { signal: ac.signal });

    expect(summary.aborted).toBe(true);
    expect(summary.rechecked).toBe(0);
    expect(hits.length).toBe(0);
    for (const path of ["/broken-a", "/broken-b"]) {
      const row = await rowFor(crawlId, path);
      // BOTH nulls: an abort decided nothing, so it says nothing — not even a
      // reason. That is what tells it apart from the cap below.
      expect(row.recheckFetchClass, path).toBeNull();
      expect(row.recheckReason, path).toBeNull();
      expect(row.recheckAt, path).toBeNull();
    }
  });

  it("stops within the row when the signal fires mid-pass", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/broken-a", fetchClass: "server_error", statusCode: 500, agoSec: 2 },
      { path: "/broken-b", fetchClass: "server_error", statusCode: 500, agoSec: 1 },
    ]);

    const ac = new AbortController();
    onHit = (path) => {
      if (path === "/broken-a") ac.abort();
    };
    const summary = await runPass(crawlId, { signal: ac.signal, minGapMs: 200 });

    expect(summary.aborted).toBe(true);
    // The row in flight when the signal fired is still settled — it was already
    // asked, and throwing away an answer we have would be the silent loss hard
    // rule 7 forbids. The row after it was never asked.
    expect(summary.rechecked).toBe(1);
    expect(hitCount("/broken-b")).toBe(0);
    const second = await rowFor(crawlId, "/broken-b");
    expect(second.recheckFetchClass).toBeNull();
    expect(second.recheckReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. The cap
// ---------------------------------------------------------------------------

describe("the cap", () => {
  it("stamps the rows it stopped short of, and asks about none of them", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/broken-a", fetchClass: "server_error", statusCode: 500, agoSec: 2 },
      { path: "/broken-b", fetchClass: "server_error", statusCode: 500, agoSec: 1 },
    ]);

    const summary = await runPass(crawlId, { maxRechecks: 1 });

    expect(summary).toMatchObject({ rechecked: 1, capped: true, aborted: false });
    const first = await rowFor(crawlId, "/broken-a");
    expect(first.recheckFetchClass).toBe("server_error");

    const second = await rowFor(crawlId, "/broken-b");
    // The null contract's second row: THE PASS DECIDED NOT TO ASK, AND SAYS WHY.
    expect(second.recheckFetchClass).toBeNull();
    expect(second.recheckAt).toBeNull();
    expect(second.recheckReason).toBe(RECHECK_CAP_REASON);
    expect(hitCount("/broken-b")).toBe(0);
  });

  it("re-asks a capped row on the next pass, overwriting the reason", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/broken-a", fetchClass: "server_error", statusCode: 500, agoSec: 2 },
      { path: "/broken-b", fetchClass: "server_error", statusCode: 500, agoSec: 1 },
    ]);

    await runPass(crawlId, { maxRechecks: 1 });
    const summary = await runPass(crawlId);

    // A capped row is still null, so it is still on the work list.
    expect(summary.rechecked).toBe(1);
    const second = await rowFor(crawlId, "/broken-b");
    expect(second.recheckFetchClass).toBe("server_error");
    expect(second.recheckStatusCode).toBe(500);
    // The reason the cap wrote is gone: the row was asked, and a `recheck-cap`
    // that outlived the asking would be a lie about this crawl's evidence.
    expect(second.recheckReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Hard rule 5
// ---------------------------------------------------------------------------

describe("url-policy, on every URL, every time", () => {
  it("refuses a row whose URL now points somewhere the policy forbids", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [{ path: "/broken", fetchClass: "server_error", statusCode: 500 }]);
    // The row is edited underneath the pass, which is the real shape of the
    // risk: `pages.url` was vetted when it was ENQUEUED, and the policy is
    // DNS-dependent — a hostname vetted three hours ago may now resolve into
    // RFC1918 space. 169.254.169.254 is the floor `allowPrivate` cannot lift.
    await db
      .update(pages)
      .set({ url: "http://169.254.169.254/broken" })
      .where(and(eq(pages.crawlId, crawlId), eq(pages.url, `${base}/broken`)));

    const summary = await runPass(crawlId);

    const rows = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    const row = rows[0]!;
    // A REFUSAL IS A DECIDED OUTCOME, not an absence: the class is written, and
    // the reason is the policy's own words.
    expect(row.recheckFetchClass).toBe("disallowed");
    expect(row.recheckStatusCode).toBeNull();
    expect(row.recheckReason).toContain("169.254.169.254");
    expect(row.recheckAt).not.toBeNull();
    // No answer ABOUT THE PAGE, so it clears nothing.
    expect(summary).toMatchObject({ rechecked: 1, inconclusive: 1, cleared: 0, confirmed: 0 });
    expect(hits.length).toBe(0);
  });

  it("refuses a row robots.txt no longer allows, without asking", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [{ path: "/broken", fetchClass: "server_error", statusCode: 500 }]);

    const summary = await runPass(crawlId, {
      robots: { ...allowAllRobots(), isAllowed: () => false },
    });

    const row = await rowFor(crawlId, "/broken");
    expect(row.recheckFetchClass).toBe("disallowed");
    expect(row.recheckReason).toContain("robots.txt");
    expect(summary).toMatchObject({ rechecked: 1, inconclusive: 1 });
    expect(hits.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Resume
// ---------------------------------------------------------------------------

describe("resume", () => {
  it("asks only the rows the interrupted pass never reached", async () => {
    const crawlId = await seedCrawl();
    await seedPages(crawlId, [
      { path: "/broken-a", fetchClass: "server_error", statusCode: 500, agoSec: 2 },
      { path: "/broken-b", fetchClass: "server_error", statusCode: 500, agoSec: 1 },
    ]);

    const ac = new AbortController();
    onHit = (path) => {
      if (path === "/broken-a") ac.abort();
    };
    const first = await runPass(crawlId, { signal: ac.signal, minGapMs: 200 });
    expect(first.aborted).toBe(true);
    expect(first.rechecked).toBe(1);

    onHit = null;
    hits.length = 0;
    const second = await runPass(crawlId);

    // THE WORK LIST IS THE NULL COLUMN, so the resume asks exactly what the
    // interrupted run never reached and re-asks nothing it settled.
    expect(second.rechecked).toBe(1);
    expect(hitCount("/broken-a")).toBe(0);
    expect(hitCount("/broken-b")).toBe(1);
    expect((await rowFor(crawlId, "/broken-b")).recheckFetchClass).toBe("server_error");
  });
});

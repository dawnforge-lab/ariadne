/**
 * Migration 0016: the two observations — `pages.fetched_at` plus the four
 * `recheck_*` columns, and `crawls.recheck_pass_at` / `recheck_pass_count`
 * (P17-T1), and the pass that fills them (P17-T2).
 *
 * What is under test is not the DDL (`runMigrations` either applied it or
 * threw) but the claims the columns make, and they are driven through a REAL
 * crawl of a real fixture server rather than through hand-written rows. That is
 * the migration-0013 discipline and it is load-bearing here: `fetched_at` is
 * stamped by `PageWriter` on the hot path, so a test that inserted rows by hand
 * would still pass with the stamp deleted.
 *
 *  1. `fetched_at` is non-null on EVERY page row, and inside the crawl's own
 *     started_at..finished_at window — a timestamp from some other moment is
 *     the failure this pins, because the recheck pass computes the gap between
 *     the two observations from it;
 *  2. the four recheck columns are null on every NON-5xx row — the null
 *     contract's first row, NOBODY ASKED — and carry the second observation on
 *     the two rows the pass asked about;
 *  3. the invariant `recheck_at IS NULL` <=> `recheck_fetch_class IS NULL`
 *     holds over the whole table, now with rows on both sides of it;
 *  4. the crawl carries a stamped `recheck_pass_at` and a `recheck_pass_count`
 *     of 2 — the pair whose null-versus-zero is the whole reason
 *     `recheck_pass_at` exists beside a NOT NULL DEFAULT 0 counter;
 *  5. the cascade, which every column on these two tables depends on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PASS HALF (§5.4 of the design, P17-T2) is what makes this file slow: the
 * loop's INSERTION 3c runs at the real `MIN_RECHECK_GAP_MS`, so this crawl —
 * which is otherwise a second's work — waits out the minute the evidence
 * claims. That is deliberate and it is the point of driving the WHOLE LOOP
 * here: the pass's test-only `minGapMs` override cannot reach it, so what this
 * file proves is the wiring at production numbers. The pass's own nine cases,
 * which do use the override, are `test/crawl/recheck.test.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { runCrawl, type CrawlConfig, type CrawlSummary } from "../../src/crawl/loop.js";
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

/**
 * How many times each path was asked for: the evidence that the pass asks a 5xx
 * row exactly ONE more time and asks a healthy row not at all. The crawl itself
 * does not retry a server error (`RETRYABLE` in src/crawl/loop.ts holds timeout,
 * network_error and blocked, and no 5xx), so a second hit on a 5xx path is the
 * pass's and nobody else's.
 */
const hits = new Map<string, number>();

let db: Db;
let server: Server;
let base: string;
let crawlId = "";
let passSummary: CrawlSummary["recheck"] = null;
let startedAt: Date | null = null;
let finishedAt: Date | null = null;
const created: string[] = [];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  server = createServer((req, res) => {
    const path = req.url ?? "";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(`<a href="/ok">ok</a><a href="/broken">broken</a><a href="/flaky">flaky</a>`));
      return;
    }
    if (path === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("<p>fine</p>"));
      return;
    }
    // Confirmed-broken: 500 every time.
    if (path === "/broken") {
      res.writeHead(500, { "content-type": "text/html" });
      res.end(html("<p>boom</p>"));
      return;
    }
    // The flapping page the pass is built for: 503 on the crawl's look, 200 on
    // any later one. The crawl sees only the 503, because a server error is not
    // in the loop's RETRYABLE set — so the 200 belongs to the recheck.
    if (path === "/flaky") {
      const n = hits.get(path) ?? 1;
      if (n === 1) {
        res.writeHead(503, { "content-type": "text/html" });
        res.end(html("<p>try later</p>"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("<p>better now</p>"));
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end(html("<p>gone</p>"));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no fixture port");
  base = `http://127.0.0.1:${addr.port}`;

  const config: CrawlConfig = {
    siteUrl: `${base}/`,
    maxPages: 10,
    maxDepth: 3,
    userAgent: "AriadneBot-0016",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    // The sanctioned test-only use: the fixture site is on 127.0.0.1.
    allowPrivate: true,
  };
  const summary = await runCrawl(db, config);
  crawlId = summary.crawlId;
  created.push(crawlId);

  const [row] = await db
    .select({ startedAt: crawls.startedAt, finishedAt: crawls.finishedAt })
    .from(crawls)
    .where(eq(crawls.id, crawlId));
  startedAt = row?.startedAt ?? null;
  finishedAt = row?.finishedAt ?? null;
  passSummary = summary.recheck;
  // A minute of it is `MIN_RECHECK_GAP_MS`, paid once across the oldest-first
  // walk however many 5xx rows there are. See the header.
}, 180_000);

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await new Promise<void>((ok) => server.close(() => ok()));
  await closeFetchAgents();
});

async function pageRows() {
  return db
    .select({
      url: pages.url,
      fetchClass: pages.fetchClass,
      statusCode: pages.statusCode,
      fetchedAt: pages.fetchedAt,
      recheckFetchClass: pages.recheckFetchClass,
      recheckStatusCode: pages.recheckStatusCode,
      recheckReason: pages.recheckReason,
      recheckAt: pages.recheckAt,
    })
    .from(pages)
    .where(eq(pages.crawlId, crawlId))
    .orderBy(pages.url);
}

describe("0016 — the two observations", () => {
  it("crawled the fixture and classified the two server errors", async () => {
    // The premise every case below rests on: if the fixture stopped producing a
    // 5xx row, claim 2 would pass vacuously.
    const rows = await pageRows();
    const byUrl = new Map(rows.map((r) => [r.url, r]));
    expect([...byUrl.keys()]).toEqual([
      `${base}/`,
      `${base}/broken`,
      `${base}/flaky`,
      `${base}/ok`,
    ]);
    expect(byUrl.get(`${base}/broken`)?.fetchClass).toBe("server_error");
    expect(byUrl.get(`${base}/broken`)?.statusCode).toBe(500);
    expect(byUrl.get(`${base}/flaky`)?.fetchClass).toBe("server_error");
    expect(byUrl.get(`${base}/flaky`)?.statusCode).toBe(503);
    // A 5xx is not retried by the loop, so the crawl asked each exactly once —
    // and the recheck pass asked each of them exactly once more. A healthy page
    // is an ANSWER and is never re-asked.
    expect(hits.get("/broken")).toBe(2);
    expect(hits.get("/flaky")).toBe(2);
    expect(hits.get("/ok")).toBe(1);
  });

  it("stamps fetched_at on every page row, inside the crawl's own window", async () => {
    const rows = await pageRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(startedAt).not.toBeNull();
    expect(finishedAt).not.toBeNull();
    for (const row of rows) {
      // Every row, the 5xx ones included: the stamp is the writer's, not the
      // successful fetch's.
      expect(row.fetchedAt, row.url).not.toBeNull();
      expect(row.fetchedAt!.getTime(), row.url).toBeGreaterThanOrEqual(startedAt!.getTime());
      expect(row.fetchedAt!.getTime(), row.url).toBeLessThanOrEqual(finishedAt!.getTime());
    }
  });

  it("leaves all four recheck columns null on a page nobody asked about", async () => {
    // The null contract's first row, and it is NOT "the page is fine": these
    // are the rows the pass never had a question about, because a 200 and a 404
    // are both answers.
    const rows = await pageRows();
    const unasked = rows.filter((row) => row.fetchClass !== "server_error");
    expect(unasked.length).toBeGreaterThan(0);
    for (const row of unasked) {
      expect(row.recheckFetchClass, row.url).toBeNull();
      expect(row.recheckStatusCode, row.url).toBeNull();
      expect(row.recheckReason, row.url).toBeNull();
      expect(row.recheckAt, row.url).toBeNull();
    }
  });

  it("writes the second observation beside the first, never over it", async () => {
    const rows = await pageRows();
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    // The page that recovered. `fetch_class` STILL SAYS `server_error`: it is
    // the census every cohort in this engine is cut from, and a row flipped to
    // `ok` would be an `ok` page with no title, no words and no links.
    const flaky = byUrl.get(`${base}/flaky`);
    expect(flaky?.fetchClass).toBe("server_error");
    expect(flaky?.statusCode).toBe(503);
    expect(flaky?.recheckFetchClass).toBe("ok");
    expect(flaky?.recheckStatusCode).toBe(200);
    expect(flaky?.recheckAt).not.toBeNull();
    expect(flaky?.recheckReason).toBeNull();

    // The page that did not.
    const broken = byUrl.get(`${base}/broken`);
    expect(broken?.fetchClass).toBe("server_error");
    expect(broken?.recheckFetchClass).toBe("server_error");
    expect(broken?.recheckStatusCode).toBe(500);
    expect(broken?.recheckAt).not.toBeNull();

    // The second observation was taken AFTER the first, by at least the gap the
    // pass promises — the number the finding's `gapSeconds` is computed from.
    for (const row of [flaky, broken]) {
      expect(row?.recheckAt!.getTime()).toBeGreaterThanOrEqual(
        row!.fetchedAt!.getTime() + 60_000,
      );
    }

    // And the run said the same thing the rows do.
    expect(passSummary).toMatchObject({
      rechecked: 2,
      confirmed: 1,
      cleared: 1,
      inconclusive: 0,
      capped: false,
      aborted: false,
    });
  });

  it("holds recheck_at IS NULL <=> recheck_fetch_class IS NULL over the table", async () => {
    // Asked as SQL rather than in TypeScript because it is a claim about the
    // TABLE, not about the rows one test happened to select — and because it is
    // the query the pass must keep true for every row it settles. With the pass
    // wired in there are now rows on BOTH sides of it: two settled, the rest
    // untouched.
    const [row] = await db
      .select({ violations: sql<number>`count(*)::int` })
      .from(pages)
      .where(
        sql`${pages.crawlId} = ${crawlId}
            and (${pages.recheckAt} is null) <> (${pages.recheckFetchClass} is null)`,
      );
    expect(row?.violations).toBe(0);
  });

  it("stamps recheck_pass_at and recheck_pass_count on the crawl", async () => {
    // The null-versus-zero pair. The count is NOT NULL DEFAULT 0, so a 0 alone
    // cannot say whether nothing was rechecked or nobody looked; the time beside
    // it is what says a complete pass is on record — which is the only thing
    // that can answer "was the 5xx evidence re-verified" on a crawl that had no
    // server errors at all.
    const [row] = await db
      .select({ at: crawls.recheckPassAt, count: crawls.recheckPassCount })
      .from(crawls)
      .where(eq(crawls.id, crawlId));
    expect(row?.at).not.toBeNull();
    expect(row?.at!.getTime()).toBeLessThanOrEqual(finishedAt!.getTime());
    expect(row?.count).toBe(2);
  });

  it("cascades from the crawl delete, columns and all", async () => {
    const id = created.shift()!;
    const count = async () => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.crawlId, id));
      return rows[0]?.n ?? 0;
    };
    expect(await count()).toBeGreaterThan(0);
    await db.delete(crawls).where(eq(crawls.id, id));
    expect(await count()).toBe(0);
  });
});

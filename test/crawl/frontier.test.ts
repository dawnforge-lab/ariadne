import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier } from "../../src/db/schema.js";
import {
  completeUrls,
  enqueueUrls,
  failUrl,
  frontierCounts,
  leaseBatch,
  releaseLeases,
} from "../../src/crawl/frontier.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://s.example";
const seed = (url: string, depth = 0, discoveredVia = "seed") => ({
  url,
  depth,
  discoveredVia,
});

describe("frontier", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
    });
    createdCrawls.push(id);
    return id;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
    await closeDb(db);
  });

  it("enqueue is idempotent per (crawl, url)", async () => {
    const crawlId = await newCrawl();
    const n1 = await enqueueUrls(db, crawlId, [seed(`${SITE}/a`)]);
    const n2 = await enqueueUrls(db, crawlId, [
      { url: `${SITE}/a`, depth: 3, discoveredVia: "link" },
    ]);
    expect(n1).toBe(1);
    expect(n2).toBe(0);

    // The first enqueue's depth and provenance stand; a conflict changes nothing.
    const rows = await db.select().from(frontier).where(eq(frontier.crawlId, crawlId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]?.discoveredVia).toBe("seed");
  });

  it("collapses duplicates inside one batch and counts only real inserts", async () => {
    const crawlId = await newCrawl();
    const inserted = await enqueueUrls(db, crawlId, [
      seed(`${SITE}/dup`),
      seed(`${SITE}/dup`),
      seed(`${SITE}/other`),
    ]);
    expect(inserted).toBe(2);
    expect((await frontierCounts(db, crawlId)).pending).toBe(2);
  });

  it("enqueues a whole sitemap's worth of URLs in one call", async () => {
    // Above Postgres's 65,535-parameter ceiling at four parameters a row
    // (16,383 rows). One statement per call used to fail here, which is what a
    // 50k-URL sitemap hands the crawl loop on its very first enqueue.
    const crawlId = await newCrawl();
    const many = Array.from({ length: 20_000 }, (_, i) => seed(`${SITE}/bulk/${i}`, 0, "sitemap"));
    expect(await enqueueUrls(db, crawlId, many)).toBe(20_000);
    expect((await frontierCounts(db, crawlId)).pending).toBe(20_000);

    // Dedupe still holds across the chunk boundary, not merely inside one.
    expect(await enqueueUrls(db, crawlId, many)).toBe(0);
  });

  it("enqueueing nothing is a no-op, not a malformed insert", async () => {
    const crawlId = await newCrawl();
    expect(await enqueueUrls(db, crawlId, [])).toBe(0);
  });

  it("lease marks rows and a second leaser gets nothing", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/b`)]);
    const l1 = await leaseBatch(db, crawlId, "w1", 10, 60);
    const l2 = await leaseBatch(db, crawlId, "w2", 10, 60);
    expect(l1.length).toBeGreaterThan(0);
    expect(l2).toEqual([]);
    expect(l1[0]).toEqual({
      url: `${SITE}/b`,
      depth: 0,
      discoveredVia: "seed",
      attempts: 1,
      redirectHops: 0,
    });
    expect((await frontierCounts(db, crawlId)).leased).toBe(1);
  });

  it("leases shallow URLs first, oldest first within a depth", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [{ url: `${SITE}/deep`, depth: 5, discoveredVia: "link" }]);
    await enqueueUrls(db, crawlId, [{ url: `${SITE}/shallow`, depth: 1, discoveredVia: "link" }]);
    const leased = await leaseBatch(db, crawlId, "w1", 1, 60);
    expect(leased.map((u) => u.url)).toEqual([`${SITE}/shallow`]);
  });

  it("an expired lease is re-leasable (crash resume)", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/c`)]);
    await leaseBatch(db, crawlId, "dead-worker", 10, 0); // leaseSeconds 0 -> instantly stale
    const again = await leaseBatch(db, crawlId, "w2", 10, 60);
    expect(again.map((u) => u.url)).toContain(`${SITE}/c`);
    // The re-lease is a second attempt on the same row, and says so.
    expect(again[0]?.attempts).toBe(2);
  });

  it("completeUrls marks done and clears the lease", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/e`)]);
    await leaseBatch(db, crawlId, "w1", 10, 60);
    expect(await completeUrls(db, crawlId, [`${SITE}/e`])).toBe(1);

    const counts = await frontierCounts(db, crawlId);
    expect(counts).toEqual({ pending: 0, leased: 0, done: 1, failed: 0, renderPending: 0 });
    const rows = await db.select().from(frontier).where(eq(frontier.crawlId, crawlId));
    expect(rows[0]?.leaseId).toBeNull();
    expect(rows[0]?.leasedUntil).toBeNull();
    // A done row is never leased again.
    expect(await leaseBatch(db, crawlId, "w2", 10, 60)).toEqual([]);
  });

  it("completeUrls completes a whole flush's worth of URLs in one call", async () => {
    // Well past the 65,535-parameter ceiling read as an IN list, so the
    // chunking is exercised rather than assumed. A URL this crawl never had is
    // in the list too: it updates nothing, and is counted as nothing.
    const crawlId = await newCrawl();
    const urls = Array.from({ length: 2_500 }, (_, i) => `${SITE}/bulk/${i}`);
    await enqueueUrls(db, crawlId, urls.map((url) => seed(url, 1, "link")));
    await leaseBatch(db, crawlId, "w1", 2_500, 60);

    expect(await completeUrls(db, crawlId, [...urls, `${SITE}/never-seen`])).toBe(2_500);
    expect(await frontierCounts(db, crawlId)).toEqual({
      pending: 0,
      leased: 0,
      done: 2_500,
      failed: 0,
      renderPending: 0,
    });
  });

  it("completing nothing is a no-op, not a malformed statement", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/untouched`)]);
    expect(await completeUrls(db, crawlId, [])).toBe(0);
    expect((await frontierCounts(db, crawlId)).pending).toBe(1);
  });

  it("completeUrls never reaches another crawl's identical URL", async () => {
    const mine = await newCrawl();
    const theirs = await newCrawl();
    await enqueueUrls(db, mine, [seed(`${SITE}/shared`)]);
    await enqueueUrls(db, theirs, [seed(`${SITE}/shared`)]);

    expect(await completeUrls(db, mine, [`${SITE}/shared`])).toBe(1);
    expect((await frontierCounts(db, theirs)).pending).toBe(1);
  });

  it("failUrl requeues until maxAttempts then marks failed", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/d`)]);
    await leaseBatch(db, crawlId, "w1", 10, 60);
    await failUrl(db, crawlId, `${SITE}/d`, { requeue: true, maxAttempts: 2 });
    expect((await frontierCounts(db, crawlId)).pending).toBeGreaterThan(0);
    await leaseBatch(db, crawlId, "w1", 10, 60);
    await failUrl(db, crawlId, `${SITE}/d`, { requeue: true, maxAttempts: 2 });
    expect((await frontierCounts(db, crawlId)).failed).toBeGreaterThan(0);
  });

  it("failUrl with requeue false fails on the first attempt", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/f`)]);
    await leaseBatch(db, crawlId, "w1", 10, 60);
    await failUrl(db, crawlId, `${SITE}/f`, { requeue: false, maxAttempts: 3 });
    expect((await frontierCounts(db, crawlId)).failed).toBe(1);
  });

  it("releaseLeases returns one worker's live leases to pending", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/g1`), seed(`${SITE}/g2`)]);
    await leaseBatch(db, crawlId, "mine", 1, 60);
    await leaseBatch(db, crawlId, "theirs", 1, 60);

    expect(await releaseLeases(db, crawlId, "mine")).toBe(1);
    const counts = await frontierCounts(db, crawlId);
    expect(counts).toEqual({ pending: 1, leased: 1, done: 0, failed: 0, renderPending: 0 });

    // null means "every lease in this crawl" — the operator-driven reclaim.
    expect(await releaseLeases(db, crawlId, null)).toBe(1);
    expect((await frontierCounts(db, crawlId)).leased).toBe(0);
  });

  it("releaseLeases refunds the attempt only when asked", async () => {
    const crawlId = await newCrawl();
    const urls = ["r1", "r2", "r3"].map((p) => `${SITE}/${p}`);
    await enqueueUrls(db, crawlId, urls.map((u) => seed(u)));
    const rowsOf = async () =>
      (await db.execute(sql`select state, attempts from frontier where crawl_id = ${crawlId}`)).rows as {
        state: string;
        attempts: number;
      }[];

    await leaseBatch(db, crawlId, "w", 3, 60);
    expect((await rowsOf()).every((r) => r.attempts === 1)).toBe(true);
    expect(await releaseLeases(db, crawlId, "w")).toBe(3);
    expect((await rowsOf()).every((r) => r.attempts === 1)).toBe(true);

    await leaseBatch(db, crawlId, "w", 3, 60); // attempts 2
    expect(await releaseLeases(db, crawlId, "w", { refundAttempt: true })).toBe(3);
    expect((await rowsOf()).every((r) => r.state === "pending" && r.attempts === 1)).toBe(true);
  });

  it("a refund never takes attempts below zero", async () => {
    const crawlId = await newCrawl();
    await enqueueUrls(db, crawlId, [seed(`${SITE}/z`)]);
    await leaseBatch(db, crawlId, "w", 1, 60);
    await db.execute(sql`update frontier set attempts = 0 where crawl_id = ${crawlId}`);
    await releaseLeases(db, crawlId, "w", { refundAttempt: true });
    const r = await db.execute(sql`select attempts from frontier where crawl_id = ${crawlId}`);
    expect((r.rows[0] as { attempts: number }).attempts).toBe(0);
  });

  it("counts are per crawl", async () => {
    const a = await newCrawl();
    const b = await newCrawl();
    await enqueueUrls(db, a, [seed(`${SITE}/x`)]);
    expect((await frontierCounts(db, b)).pending).toBe(0);
    // The same URL is a separate row under a separate crawl.
    expect(await enqueueUrls(db, b, [seed(`${SITE}/x`)])).toBe(1);
  });
});

describe("frontier redirect hops (27c T1)", () => {
  let db: Db;
  const created: string[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("leases an item enqueued with redirectHops 3 at 3, and one enqueued without it at 0", async () => {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ tenantId: LOCAL_TENANT, id, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    created.push(id);
    await enqueueUrls(db, id, [
      { url: `${SITE}/hopped`, depth: 0, discoveredVia: "redirect", redirectHops: 3 },
      seed(`${SITE}/plain`, 1),
    ]);
    const leased = await leaseBatch(db, id, "w1", 10, 60);
    const hops = new Map(leased.map((l) => [l.url, l.redirectHops]));
    expect(hops.get(`${SITE}/hopped`)).toBe(3);
    expect(hops.get(`${SITE}/plain`)).toBe(0);
  });
});

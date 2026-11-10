/**
 * scripts/prune-test-crawls.ts (27d T10): the host test, and the prune against a
 * real database. The seeded crawls carry ids unique to this file and the prune
 * is scoped to them (`onlyIds`), so a parallel test file's crawls — which are
 * on loopback hosts too — are never touched.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier } from "../../src/db/schema.js";
import { ApiService } from "../../src/api/service.js";
import { TRIAGE } from "../../src/rules/registry/triage.js";
import { isTestHost, pruneTestCrawls } from "../../scripts/prune-test-crawls.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

describe("isTestHost", () => {
  it.each([
    "http://127.0.0.1:35807",
    "http://127.4.5.6/",
    "http://www.localhost:42275/",
    "http://localhost:3000/",
    "http://seeded.example/",
    "http://a.b.test/",
    "http://x.invalid/",
    "http://example/",
    "http://[::1]:8080/",
    "http://[0:0:0:0:0:0:0:1]:8080/",
    "http://127.255.255.254/",
    "http://LOCALHOST:3000/",
    "http://foo.example/",
  ])("is true for %s", (url) => {
    expect(isTestHost(url)).toBe(true);
  });

  it.each([
    "https://lavishalice.com/",
    "https://www.hurtigruten.com/en/",
    "https://example.com/",
    "https://notlocalhost.com/",
    "http://128.0.0.1/",
    "https://test.com/",
    // A trailing-dot FQDN fails closed: not matched, so never deleted by mistake.
    "http://localhost.:80/",
  ])("is false for %s", (url) => {
    expect(isTestHost(url)).toBe(false);
  });

  it("throws on a site_url that is not a URL, rather than guessing", () => {
    expect(() => isTestHost("not a url")).toThrow();
  });
});

describe("performance.slow-response triage", () => {
  it("maps to SF's PageSpeed Document Request Latency issue", () => {
    expect(TRIAGE["performance.slow-response"]?.sfIssue).toBe("PageSpeed: Document Request Latency");
  });
});

describe("pruneTestCrawls", () => {
  let db: Db;
  let service: ApiService;
  let fixtureLive: string;
  let fixtureDone: string;
  let real: string;
  let leasedLive: string;
  let expiredLeases: string;
  const lines: string[] = [];

  async function seed(siteUrl: string, status: string): Promise<string> {
    const id = `crawl_prune_${randomUUID().slice(0, 8)}`;
    await db.insert(crawls).values({
      id,
      siteUrl,
      config: { siteUrl, secret: "do-not-print" },
      rulesetVersion: "0.0.0-test",
      status,
    });
    await db.insert(frontier).values({ crawlId: id, url: `${siteUrl}p`, state: "pending", depth: 0, discoveredVia: "seed" });
    return id;
  }

  const count = async (id: string): Promise<number> =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(crawls).where(eq(crawls.id, id)))[0]!.n;
  const frontierRows = async (id: string): Promise<number> =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(frontier).where(eq(frontier.crawlId, id)))[0]!.n;

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
    service = new ApiService(db, { allowedDomains: [], log: () => {} });
    fixtureLive = await seed("http://127.0.0.1:35807/", "running");
    fixtureDone = await seed("http://seeded.example/", "finished");
    real = await seed("https://lavishalice.com/", "running");
    leasedLive = await seed("http://localhost:3000/", "running");
    await db.insert(frontier).values({
      crawlId: leasedLive, url: "http://localhost:3000/l", state: "leased", depth: 0, discoveredVia: "seed",
      leaseId: "w", leasedUntil: new Date(Date.now() + 60_000),
    });
    expiredLeases = await seed("http://www.localhost:3000/", "running");
    await db.insert(frontier).values({
      crawlId: expiredLeases, url: "http://www.localhost:3000/l", state: "leased", depth: 0, discoveredVia: "seed",
      leaseId: "w", leasedUntil: new Date(Date.now() - 60_000),
    });
  });

  afterAll(async () => {
    for (const id of [fixtureLive, fixtureDone, real, leasedLive, expiredLeases]) {
      await db.delete(frontier).where(eq(frontier.crawlId, id));
      await db.delete(crawls).where(eq(crawls.id, id));
    }
    await service.close();
    await closeDb(db);
  });

  const only = (): ReadonlySet<string> => new Set([fixtureLive, fixtureDone, real, leasedLive, expiredLeases]);

  it("a dry run lists the fixture crawls only, with totals, and changes nothing", async () => {
    lines.length = 0;
    const result = await pruneTestCrawls(db, service, { confirm: false, onlyIds: only() }, (l) => lines.push(l));
    expect(result.matched).toBe(4);
    expect(result.liveSkipped).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain(`${fixtureLive} running http://127.0.0.1:35807/ 0`);
    expect(text).toContain(`${fixtureDone} finished http://seeded.example/ 0`);
    expect(text).toContain(`${leasedLive} running http://localhost:3000/ live, skipped`);
    expect(text).not.toContain(real);
    expect(text).not.toContain("do-not-print");
    expect(await count(fixtureLive)).toBe(1);
    for (const id of [fixtureLive, fixtureDone, real, leasedLive, expiredLeases]) {
      expect(await frontierRows(id)).toBeGreaterThan(0);
    }
    const [row] = await db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, fixtureLive));
    expect(row?.status).toBe("running");
  });

  it("--confirm cancels the dead live row, deletes the fixture crawls and their children, keeps the real one", async () => {
    const result = await pruneTestCrawls(db, service, { confirm: true, onlyIds: only() }, () => {});
    expect(result.deleted).toBe(3);
    expect(result.cancelled).toBe(2);
    expect(result.liveSkipped).toBe(1);
    expect(await count(expiredLeases)).toBe(0);
    expect(await frontierRows(expiredLeases)).toBe(0);
    // The crawl with an unexpired lease: row, frontier and status untouched.
    expect(await count(leasedLive)).toBe(1);
    expect(await frontierRows(leasedLive)).toBe(2);
    const [live] = await db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, leasedLive));
    expect(live?.status).toBe("running");
    expect(await count(fixtureLive)).toBe(0);
    expect(await count(fixtureDone)).toBe(0);
    expect(await frontierRows(fixtureLive)).toBe(0);
    expect(await frontierRows(fixtureDone)).toBe(0);
    expect(await count(real)).toBe(1);
    expect(await frontierRows(real)).toBe(1);
  });

  it("a lease taken after the up-front check but before the cancel leaves the crawl intact and reported live", async () => {
    const racing = await seed("http://racing.localhost:3000/", "running");
    try {
      const out: string[] = [];
      const result = await pruneTestCrawls(
        db,
        service,
        {
          confirm: true,
          onlyIds: new Set([racing]),
          beforeCancel: async (id) => {
            await db.insert(frontier).values({
              crawlId: id, url: "http://racing.localhost:3000/l", state: "leased", depth: 0, discoveredVia: "seed",
              leaseId: "w", leasedUntil: new Date(Date.now() + 60_000),
            });
          },
        },
        (l) => out.push(l),
      );
      expect(result.deleted).toBe(0);
      expect(result.cancelled).toBe(0);
      expect(result.liveSkipped).toBe(1);
      expect(out.join("\n")).toContain(`${racing} running http://racing.localhost:3000/ live, skipped`);
      expect(await count(racing)).toBe(1);
      expect(await frontierRows(racing)).toBe(2);
      const [row] = await db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, racing));
      expect(row?.status).toBe("running");
    } finally {
      await db.delete(frontier).where(eq(frontier.crawlId, racing));
      await db.delete(crawls).where(eq(crawls.id, racing));
    }
  });

  it("clears a pending request on a failed or paused crawl before deleting; the dry run flags it and changes nothing", async () => {
    const failed = await seed("http://127.0.0.1:40655/", "failed");
    const paused = await seed("http://paused.localhost:3000/", "paused");
    const pausedCancel = await seed("http://paused2.localhost:3000/", "paused");
    await db.update(crawls).set({ controlRequest: "cancel" }).where(eq(crawls.id, failed));
    await db.update(crawls).set({ controlRequest: "pause" }).where(eq(crawls.id, paused));
    await db.update(crawls).set({ controlRequest: "cancel" }).where(eq(crawls.id, pausedCancel));
    const ids = [failed, paused, pausedCancel];
    const reqOf = async (id: string): Promise<string | null> =>
      (await db.select({ r: crawls.controlRequest }).from(crawls).where(eq(crawls.id, id)))[0]!.r;
    try {
      const out: string[] = [];
      const dry = await pruneTestCrawls(db, service, { confirm: false, onlyIds: new Set(ids) }, (l) => out.push(l));
      expect(dry.matched).toBe(3);
      const text = out.join("\n");
      expect(text).toContain(`${failed} failed http://127.0.0.1:40655/ 0 request pending (cancel)`);
      expect(text).toContain(`${paused} paused http://paused.localhost:3000/ 0 request pending (pause)`);
      expect(text).toContain(`${pausedCancel} paused http://paused2.localhost:3000/ 0 request pending (cancel)`);
      for (const id of ids) expect(await count(id)).toBe(1);
      expect(await reqOf(failed)).toBe("cancel");
      expect(await reqOf(paused)).toBe("pause");

      const result = await pruneTestCrawls(db, service, { confirm: true, onlyIds: new Set(ids) }, () => {});
      expect(result.deleted).toBe(3);
      expect(result.cancelled).toBe(0);
      expect(result.liveSkipped).toBe(0);
      for (const id of ids) {
        expect(await count(id)).toBe(0);
        expect(await frontierRows(id)).toBe(0);
      }
    } finally {
      for (const id of ids) {
        await db.delete(frontier).where(eq(frontier.crawlId, id));
        await db.delete(crawls).where(eq(crawls.id, id));
      }
    }
  });

  it("a failed crawl with a pending request and an unexpired lease is left alone and reported live", async () => {
    const id = await seed("http://leasedfail.localhost:3000/", "failed");
    await db.update(crawls).set({ controlRequest: "cancel" }).where(eq(crawls.id, id));
    await db.insert(frontier).values({
      crawlId: id, url: "http://leasedfail.localhost:3000/l", state: "leased", depth: 0, discoveredVia: "seed",
      leaseId: "w", leasedUntil: new Date(Date.now() + 60_000),
    });
    try {
      const result = await pruneTestCrawls(db, service, { confirm: true, onlyIds: new Set([id]) }, () => {});
      expect(result.deleted).toBe(0);
      expect(result.liveSkipped).toBe(1);
      expect(await count(id)).toBe(1);
      const [row] = await db.select({ r: crawls.controlRequest }).from(crawls).where(eq(crawls.id, id));
      expect(row?.r).toBe("cancel");
    } finally {
      await db.delete(frontier).where(eq(frontier.crawlId, id));
      await db.delete(crawls).where(eq(crawls.id, id));
    }
  });
});

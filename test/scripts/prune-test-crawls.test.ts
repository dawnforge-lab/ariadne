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
  ])("is true for %s", (url) => {
    expect(isTestHost(url)).toBe(true);
  });

  it.each([
    "https://lavishalice.com/",
    "https://www.hurtigruten.com/en/",
    "https://example.com/",
    "https://notlocalhost.com/",
    "http://128.0.0.1/",
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
  });

  afterAll(async () => {
    for (const id of [fixtureLive, fixtureDone, real]) {
      await db.delete(frontier).where(eq(frontier.crawlId, id));
      await db.delete(crawls).where(eq(crawls.id, id));
    }
    await service.close();
    await closeDb(db);
  });

  const only = (): ReadonlySet<string> => new Set([fixtureLive, fixtureDone, real]);

  it("a dry run lists the fixture crawls only, with totals, and changes nothing", async () => {
    lines.length = 0;
    const result = await pruneTestCrawls(db, service, { confirm: false, onlyIds: only() }, (l) => lines.push(l));
    expect(result.matched).toBe(2);
    const text = lines.join("\n");
    expect(text).toContain(`${fixtureLive} running http://127.0.0.1:35807/ 0`);
    expect(text).toContain(`${fixtureDone} finished http://seeded.example/ 0`);
    expect(text).not.toContain(real);
    expect(text).not.toContain("do-not-print");
    expect(await count(fixtureLive)).toBe(1);
    const [row] = await db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, fixtureLive));
    expect(row?.status).toBe("running");
  });

  it("--confirm cancels the dead live row, deletes the fixture crawls and their children, keeps the real one", async () => {
    const result = await pruneTestCrawls(db, service, { confirm: true, onlyIds: only() }, () => {});
    expect(result.deleted).toBe(2);
    expect(result.cancelled).toBe(1);
    expect(await count(fixtureLive)).toBe(0);
    expect(await count(fixtureDone)).toBe(0);
    expect(await frontierRows(fixtureLive)).toBe(0);
    expect(await frontierRows(fixtureDone)).toBe(0);
    expect(await count(real)).toBe(1);
    expect(await frontierRows(real)).toBe(1);
  });
});

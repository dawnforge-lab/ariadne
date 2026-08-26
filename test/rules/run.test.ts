import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, issues, pages } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import { runRules } from "../../src/rules/run.js";
import { Registry, RULESET_VERSION } from "../../src/rules/registry/registry.js";
import type { PageRecord, PageRule } from "../../src/rules/registry/types.js";
import { mkPage } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://runner.example";

describe("buildRegistry", () => {
  it("registers every rule of the Phase 2 table exactly once", () => {
    const ids = buildRegistry().all().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("title.missing");
    expect(ids).toContain("http.server-error");
    expect(ids).toContain("hreflang.invalid-code");
    expect(ids.length).toBe(28);
  });

  it("registers both kinds the runner drives", () => {
    const registry = buildRegistry();
    expect(registry.byKind("page").length).toBeGreaterThan(0);
    expect(registry.byKind("query").length).toBeGreaterThan(0);
  });
});

describe("runRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ id, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    createdCrawls.push(id);
    return id;
  }

  /**
   * A pages row built from the shared clean defaults, so a row differs from
   * "no rule fires on it" only in the signals this test names.
   */
  function mkRow(crawlId: string, path: string, overrides: Partial<PageRecord> = {}): PageRecord {
    const url = `${SITE}${path}`;
    return mkPage({
      id: `page_${randomUUID()}`,
      crawlId,
      url,
      urlNormalised: url,
      canonicalHtml: url,
      ...overrides,
    });
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("writes one issues row per finding, is idempotent, and leaves a clean page alone", async () => {
    const crawlId = await newCrawl();
    const clean = mkRow(crawlId, "/clean");
    const untitled = mkRow(crawlId, "/untitled", { title: null });
    const broken = mkRow(crawlId, "/broken", { fetchClass: "server_error", statusCode: 503 });
    await db.insert(pages).values([clean, untitled, broken]);
    await db.insert(hreflang).values([
      {
        crawlId,
        pageId: untitled.id,
        hreflangCode: "en-gb",
        targetUrl: `${SITE}/untitled`,
        targetPageId: null,
        source: "html",
      },
      {
        crawlId,
        pageId: untitled.id,
        hreflangCode: "english-uk",
        targetUrl: `${SITE}/uk`,
        targetPageId: null,
        source: "html",
      },
    ]);

    const registry = buildRegistry();
    const summary = await runRules(db, crawlId, registry);
    const rows = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
    const byRule = new Map<string, number>();
    for (const r of rows) byRule.set(r.ruleId, (byRule.get(r.ruleId) ?? 0) + 1);

    expect(byRule.get("title.missing")).toBe(1);
    expect(byRule.get("http.server-error")).toBe(1);
    expect(byRule.get("hreflang.invalid-code")).toBe(1);
    expect(summary.findings).toBe(rows.length);
    expect(summary.pagesScanned).toBe(3);

    // The summary's bookkeeping only ever names rules the registry holds.
    const registered = new Set(registry.all().map((r) => r.id));
    for (const id of Object.keys(summary.byRule)) expect(registered.has(id), id).toBe(true);
    expect(Object.fromEntries(byRule)).toEqual(summary.byRule);

    // A page rule stamps the page it fired on, and the details carry the URL.
    const titleRow = rows.find((r) => r.ruleId === "title.missing")!;
    expect(titleRow.pageId).toBe(untitled.id);
    expect(titleRow.severity).toBe(
      registry.all().find((r) => r.id === "title.missing")!.severity,
    );
    expect(titleRow.details).toMatchObject({ pageUrl: `${SITE}/untitled` });

    // Idempotence: a second run adds no rows — the dedupe index absorbs it.
    await runRules(db, crawlId, registry);
    const again = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
    expect(again.length).toBe(rows.length);

    // A clean page contributes nothing.
    expect(rows.every((r) => r.pageId !== clean.id)).toBe(true);
  });

  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    await db.insert(pages).values([mkRow(other, "/untitled", { title: null })]);
    const mine = await newCrawl();
    await db.insert(pages).values([mkRow(mine, "/clean")]);

    const summary = await runRules(db, mine, buildRegistry());
    expect(summary.pagesScanned).toBe(1);
    expect(summary.findings).toBe(0);
    expect(await db.select().from(issues).where(eq(issues.crawlId, mine))).toHaveLength(0);
  });

  it("aborts loudly, naming the rule, when a rule throws", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean")]);

    const exploding: PageRule = {
      kind: "page",
      id: "test.exploding",
      checkIds: ["CHECK-01"],
      category: "test",
      severity: "info",
      title: "Exploding test rule",
      explanation: "A rule that throws, so the runner's failure path can be observed.",
      howToFix: "Do not ship it.",
      rulesetVersion: RULESET_VERSION,
      run: () => {
        throw new Error("boom");
      },
    };
    const registry = new Registry();
    registry.register(exploding);

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/test\.exploding/);
  });
});

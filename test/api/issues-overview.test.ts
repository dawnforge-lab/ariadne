/**
 * The Issues Overview (Phase 27a T8): one row per rule, the crawl's judgement
 * applied, as JSON and as the `issues_overview` CSV view from one builder.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ApiService, ServiceError } from "../../src/api/service.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, metrics, pages } from "../../src/db/schema.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://issues-overview.example";
const LONG_TITLE = "A page title written well past the sixty characters a result shows";
const CSV_HEADER =
  "Issue Name,Issue Type,Issue Priority,Severity,URLs,% of Judged,Description,How To Fix,Rule Id,Check Ids";

let db: Db;
let service: ApiService;
let exportDir: string;
const runId = randomUUID();
const crawlId = `crawl_issues_overview_${runId}`;
const unjudgedId = `crawl_issues_overview_unjudged_${runId}`;
const staleRuleId = `crawl_issues_overview_stale_${runId}`;
const malformedId = `crawl_issues_overview_malformed_${runId}`;
const MANY_URLS = "sitemap.uncrawled";
const NO_URL = "links.orphan-skipped";
const extraCrawls = [unjudgedId, staleRuleId, malformedId];

async function seedCrawl(id: string, paths: string[]): Promise<void> {
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: `${SITE}/`, hostKey: hostKeyOf(`${SITE}/`),
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: paths.length,
  });
  await db.insert(pages).values(
    paths.map((path, i) => {
      const url = `${SITE}${path}`;
      return mkPage({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url,
        urlNormalised: url,
        ...(i === 0 ? { depth: 0, clickDepth: 0, discoveredVia: "seed" } : {}),
        ...(path === "/long" ? { title: LONG_TITLE } : {}),
        ...(path === "/no-meta"
          ? { title: "A second perfectly reasonable title", metaDescription: null }
          : {}),
      });
    }),
  );
}

async function setJudgement(block: unknown): Promise<void> {
  await db.update(crawls).set({ judgement: block }).where(eq(crawls.id, crawlId));
}

/** Every distinct URL `issue_urls` lists for a rule, paged to the end. */
async function issueUrlsDistinct(ruleId: string): Promise<number> {
  const urls = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await service.listIssueUrls(LOCAL_TENANT, crawlId, ruleId, {
      limit: 2,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.items) urls.add(item.url ?? "");
    if (page.nextCursor === null) return urls.size;
    cursor = page.nextCursor;
  }
}

async function csvLines(): Promise<string[]> {
  const stream = await service.prepareCsvExport(LOCAL_TENANT, crawlId, { view: "issues_overview" });
  const out: string[] = [];
  for await (const record of stream.records()) out.push(record);
  return out;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-issues-overview-"));
  service = new ApiService(db, { credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], exportDir, log: () => {} });

  await seedCrawl(crawlId, ["/", "/long", "/no-meta"]);
  await service.runRulesForCrawl(LOCAL_TENANT, crawlId);

  // Site-wide findings shaped as the real ones are: `page_id` null, the URL in
  // `details.pageUrl`. Three distinct URLs over four findings (one URL twice),
  // and a rule whose only finding names no URL at all.
  await db
    .delete(issues)
    .where(and(eq(issues.crawlId, crawlId), inArray(issues.ruleId, [MANY_URLS, NO_URL])));
  await db.insert(issues).values([
    ...["/a", "/b", "/c", "/c"].map((path, i) => ({
      crawlId,
      ruleId: MANY_URLS,
      pageId: null,
      severity: "info",
      dedupeKey: `seed-${i}`,
      details: { pageUrl: `${SITE}${path}` },
    })),
    {
      crawlId,
      ruleId: NO_URL,
      pageId: null,
      severity: "info",
      dedupeKey: "seed-0",
      details: {},
    },
  ]);

  await seedCrawl(unjudgedId, ["/"]);

  await seedCrawl(staleRuleId, ["/"]);
  await service.runRulesForCrawl(LOCAL_TENANT, staleRuleId);
  await db.insert(issues).values({
    crawlId: staleRuleId,
    ruleId: "no.such-rule",
    pageId: null,
    severity: "info",
    dedupeKey: "k",
    details: {},
  });

  await seedCrawl(malformedId, ["/"]);
  await service.runRulesForCrawl(LOCAL_TENANT, malformedId);
}, 60_000);

afterAll(async () => {
  await service.close();
  for (const id of [crawlId, ...extraCrawls]) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  rmSync(exportDir, { recursive: true, force: true });
});

describe("issues_overview rows", () => {
  it("counts each rule's distinct URLs as issue_urls lists them, for every rule", async () => {
    await setJudgement({});
    const overview = await service.issuesOverview(LOCAL_TENANT, crawlId, {});
    expect(overview.rows.length).toBeGreaterThan(2);
    for (const row of overview.rows) {
      expect(row.urls, row.ruleId).toBe(await issueUrlsDistinct(row.ruleId));
    }
  });

  it("counts a page rule's URLs and agrees with issues_list on it", async () => {
    const overview = await service.issuesOverview(LOCAL_TENANT, crawlId, {});
    const list = await service.listIssues(LOCAL_TENANT, crawlId, { limit: 200 });
    const row = overview.rows.find((r) => r.ruleId === "title.too-long");
    expect(row?.urls).toBe(1);
    expect(row?.urls).toBe(list.items.find((g) => g.ruleId === "title.too-long")?.count);
  });

  it("counts every distinct URL of a site-wide rule, not one", async () => {
    const overview = await service.issuesOverview(LOCAL_TENANT, crawlId, {});
    const row = overview.rows.find((r) => r.ruleId === MANY_URLS);
    expect(row?.urls).toBe(3);
    expect(await issueUrlsDistinct(MANY_URLS)).toBe(3);
    // issues_list counts FINDINGS: four, over three URLs.
    const list = await service.listIssues(LOCAL_TENANT, crawlId, { limit: 200 });
    expect(list.items.find((g) => g.ruleId === MANY_URLS)?.count).toBe(4);
  });

  it("counts a site-wide finding that names no URL as one", async () => {
    const overview = await service.issuesOverview(LOCAL_TENANT, crawlId, {});
    expect(overview.rows.find((r) => r.ruleId === NO_URL)?.urls).toBe(1);
    expect(await issueUrlsDistinct(NO_URL)).toBe(1);
  });

  it("takes pagesJudged from the stored site.health metric and computes the percentage", async () => {
    const overview = await service.issuesOverview(LOCAL_TENANT, crawlId, {});
    const total = (
      await db.execute<{ t: number }>(sql`
        select (value_jsonb->>'urlsTotal')::int as t from metrics
         where crawl_id = ${crawlId} and metric_id = 'site.health'`)
    ).rows[0]?.t;
    expect(total).toBeGreaterThan(0);
    expect(overview.pagesJudged).toBe(total);
    for (const row of overview.rows) {
      expect(row.percentOfJudged).toBe(Math.round((row.urls / (total ?? 1)) * 1000) / 10);
    }
  });

  it("orders by type, priority, urls descending, then rule id", async () => {
    await setJudgement({
      rules: {
        "title.too-long": { type: "issue", priority: "high" },
        "meta-description.missing": { type: "issue", priority: "high" },
        "title.missing": { type: "warning", priority: "high" },
      },
    });
    const { rows } = await service.issuesOverview(LOCAL_TENANT, crawlId, { includeZero: true });
    const rank = { issue: 0, warning: 1, opportunity: 2 } as const;
    const prio = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      const cmp =
        rank[a.type] - rank[b.type] || prio[a.priority] - prio[b.priority] || b.urls - a.urls;
      expect(cmp <= 0, `${a.ruleId} before ${b.ruleId}`).toBe(true);
      if (cmp === 0) expect(a.ruleId < b.ruleId).toBe(true);
    }
    const idx = (id: string) => rows.findIndex((r) => r.ruleId === id);
    const tooLong = rows[idx("title.too-long")]!;
    expect(tooLong.typeOverridden).toBe(true);
    expect(tooLong.priorityOverridden).toBe(true);
    expect(tooLong.urls).toBeGreaterThan(0);
    expect(rows[idx("meta-description.missing")]!.urls).toBeGreaterThan(0);
    // Both fired issue/high rules sit before the warning/high override.
    expect(Math.max(idx("title.too-long"), idx("meta-description.missing"))).toBeLessThan(
      idx("title.missing"),
    );
    await setJudgement({});
  });

  it("leaves a disabled rule out and names it", async () => {
    await setJudgement({ rules: { "title.too-long": { disabled: true } } });
    const overview = await service.issuesOverview(LOCAL_TENANT, crawlId, { includeZero: true });
    expect(overview.rows.find((r) => r.ruleId === "title.too-long")).toBeUndefined();
    expect(overview.disabledRules).toEqual(["title.too-long"]);
    await setJudgement({});
  });

  it("includeZero adds zero rows for rules that did not fire, never a metric", async () => {
    const fired = new Set((await service.issuesOverview(LOCAL_TENANT, crawlId, {})).rows.map((r) => r.ruleId));
    const full = await service.issuesOverview(LOCAL_TENANT, crawlId, { includeZero: true });
    const zero = full.rows.filter((r) => r.urls === 0);
    expect(zero.length).toBeGreaterThan(0);
    for (const row of zero) {
      expect(fired.has(row.ruleId)).toBe(false);
      expect(row.percentOfJudged).toBe(0);
    }
    expect(full.rows.find((r) => r.ruleId === "site.health")).toBeUndefined();
    expect(full.rows.length).toBe(fired.size + zero.length);
  });
});

describe("issues_overview refusals", () => {
  it("refuses an unjudged crawl with CONFLICT", async () => {
    await expect(service.issuesOverview(LOCAL_TENANT, unjudgedId, {})).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("refuses a stored finding of a rule the registry lacks, as issues_list does", async () => {
    const asList = await service.listIssues(LOCAL_TENANT, staleRuleId, {}).catch((e: unknown) => e);
    expect(asList).toBeInstanceOf(ServiceError);
    const error = await service.issuesOverview(LOCAL_TENANT, staleRuleId, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("CONFLICT");
    expect((error as ServiceError).message).toContain("no.such-rule");
  });

  it("answers pagesJudged null (and percentOfJudged null) with no site.health row", async () => {
    await db.delete(metrics).where(eq(metrics.crawlId, malformedId));
    const overview = await service.issuesOverview(LOCAL_TENANT, malformedId, {});
    expect(overview.pagesJudged).toBeNull();
    expect(overview.rows.length).toBeGreaterThan(0);
    for (const row of overview.rows) expect(row.percentOfJudged).toBeNull();
  });

  it("throws on a malformed site.health row rather than reading it as null", async () => {
    await db.insert(metrics).values({
      crawlId: malformedId,
      metricId: "site.health",
      scope: "site",
      scopeValue: "",
      value: { urlsTotal: "lots" },
    });
    await expect(service.issuesOverview(LOCAL_TENANT, malformedId, {})).rejects.toThrow(/urlsTotal/);
  });
});

describe("issues_overview CSV", () => {
  it("has the exact header and the JSON's rows in the JSON's order", async () => {
    await setJudgement({});
    const overview = await service.issuesOverview(LOCAL_TENANT, crawlId, {});
    const lines = await csvLines();
    expect(lines[0]).toBe(`${CSV_HEADER}\r\n`);
    expect(lines.length - 1).toBe(overview.rows.length);
    // Rule Id is the second-to-last column; no rule id needs quoting.
    const ruleIds = lines.slice(1).map((line) => /,([a-z0-9.\-]+),[^,]*\r\n$/.exec(line)?.[1]);
    expect(ruleIds).toEqual(overview.rows.map((r) => r.ruleId));
  });

  it("writes an empty % of Judged cell when pagesJudged is null", async () => {
    await db.delete(metrics).where(eq(metrics.crawlId, crawlId));
    const lines = await csvLines();
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line).toMatch(/,\d+,,/);
  });
});

describe("a list crawl names what it did not measure as {id, reason} (27d)", () => {
  const listId = `crawl_issues_overview_list_${runId}`;
  const SPIDER_REASON = "a list crawl follows no links, so this rule's evidence was not gathered";
  const SITEMAP_REASON = "a list crawl read no sitemap, so this rule's evidence was not gathered";

  it("reads one shape on issues_list, issues_overview, metrics and the issues export", async () => {
    extraCrawls.push(listId);
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id: listId,
      siteUrl: `${SITE}/`, hostKey: hostKeyOf(`${SITE}/`),
      config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test", mode: "list" },
      discovery: { ...mkDiscovery(), sitemapsRead: false },
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 1,
    });
    await db.insert(pages).values(
      mkPage({
        id: `page_${randomUUID()}`,
        crawlId: listId,
        url: `${SITE}/`,
        urlNormalised: `${SITE}/`,
        depth: 0,
        clickDepth: 0,
        discoveredVia: "seed",
      }),
    );
    await service.runRulesForCrawl(LOCAL_TENANT, listId);

    const overview = await service.issuesOverview(LOCAL_TENANT, listId, { includeZero: true });
    const nm = overview.notMeasured;
    expect(nm.find((n) => n.id === "links.orphan")).toEqual({ id: "links.orphan", reason: SPIDER_REASON });
    expect(nm.find((n) => n.id === "sitemap.invalid")).toEqual({ id: "sitemap.invalid", reason: SITEMAP_REASON });
    expect(nm.map((n) => n.id)).toEqual(nm.map((n) => n.id).sort());
    for (const n of nm) expect(Object.keys(n).sort()).toEqual(["id", "reason"]);

    expect((await service.listIssues(LOCAL_TENANT, listId, {})).notMeasured).toEqual(nm);
    expect((await service.listMetrics(LOCAL_TENANT, listId, {})).notMeasured).toEqual(nm);
    const exported = await service.exportCrawl(LOCAL_TENANT, listId, { dataset: "issues" });
    expect(exported.notMeasured).toEqual(nm);
  });
});

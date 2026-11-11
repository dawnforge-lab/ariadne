/**
 * Phase 27c Task 7: the rules on a LIST crawl, and `crawl.list-mode`.
 *
 * A list crawl fetched only the URLs it was given and followed no link. The
 * rules that need the whole site (`needsSpider`) or a sitemap read
 * (`needsSitemaps`, when none was made) are not run, and one marker names them.
 * Rows are built directly and judged through `runRules`, the only caller that
 * knows a crawl's mode.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, metrics, pages } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import {
  defineRule,
  Registry,
  RuleDefinitionError,
  type RuleDefinition,
} from "../../src/rules/registry/registry.js";
import type { QueryRule } from "../../src/rules/registry/types.js";
import { runRules } from "../../src/rules/run.js";
import { mkDiscovery, mkHostProbe } from "./mk-discovery.js";
import { mkPage } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://listed.example";

/** The brief's `needsSpider` list, verbatim, plus the one rule flagged beyond it. */
const NEEDS_SPIDER = [
  "links.orphan",
  "links.orphan-skipped",
  "structure.deep-page",
  "links.only-from-non-indexable",
  "canonical.unlinked",
  "hreflang.unlinked-target",
  "pagination.next-not-linked",
  "pagination.next-target-uncrawled",
  "sitemap.uncrawled",
  "pages.not-in-sitemap",
  "schema.none-on-site",
  "schema.breadcrumb-absent",
  "inlinks.distribution",
  "inlinks.extremes",
  "inlinks.sources-by-type",
  "structure.depth-distribution",
  "structure.click-depth-distribution",
  // Beyond the brief: its finding is "an alternate URL the crawl did not fetch",
  // which on a list crawl is every alternate the list did not name.
  "hreflang.alternates-not-crawled",
];
const NEEDS_SITEMAPS = [
  "sitemap.invalid",
  "sitemap.non-200",
  "sitemap.redirected",
  "sitemap.non-indexable",
  "sitemap.over-50k-urls",
  "sitemap.url-too-long",
  "sitemap.oversized",
  "sitemap.url-in-multiple",
  "sitemap.cross-host-loc",
  "sitemap.lastmod-invalid",
  "robots.blocks-sitemap-urls",
  "hreflang.source-conflict",
  "sitemap.structure",
];

/**
 * Rules that still RUN on a list crawl but judge only the targets the list
 * fetched (listed URLs and their redirect targets). Audited against the
 * principle "the answer depends on the response of a URL a list crawl fetches
 * only if it is listed or a redirect target". `redirect.chain` / `redirect.loop`
 * are not here (list mode follows same-origin redirects, so a chain is read in
 * full) and neither is `url.normalisation-variants` (it reports pages that were
 * fetched and judges no unfetched target's response).
 */
const LIST_PARTIAL = [
  "links.broken-internal",
  "links.to-server-error",
  "canonical.non-200-target",
  "canonical.non-indexable-target",
  "canonical.chain",
  "hreflang.missing-return-link",
  "hreflang.non-indexable-target",
  "hreflang.inconsistent-return-code",
  "pagination.non-indexable-target",
  "pagination.sequence-error",
  "pagination.loop",
];

describe("list-mode flags on the ruleset", () => {
  const all = buildRegistry().all();
  const flagged = (flag: "needsSpider" | "needsSitemaps" | "listPartial"): string[] =>
    all.filter((r) => r[flag] === true).map((r) => r.id).sort();

  it("flags exactly the listed rules", () => {
    expect(flagged("needsSpider")).toEqual([...NEEDS_SPIDER].sort());
    expect(flagged("needsSitemaps")).toEqual([...NEEDS_SITEMAPS].sort());
    expect(flagged("listPartial")).toEqual([...LIST_PARTIAL].sort());
    // Never both: a rule either runs on a list crawl or it does not.
    for (const r of all) {
      if (r.listPartial === true) {
        expect(r.needsSpider, r.id).toBeUndefined();
        expect(r.needsSitemaps, r.id).toBeUndefined();
      }
    }
  });

  it("defines crawl.list-mode as an unflagged CHECK-83 info marker", () => {
    const rule = all.find((r) => r.id === "crawl.list-mode")!;
    expect(rule).toMatchObject({
      kind: "query",
      checkIds: ["CHECK-83"],
      severity: "info",
      category: "links",
      type: "warning",
      priority: "low",
    });
    expect(rule.marker).toBeTruthy();
    expect(rule.needsSpider).toBeUndefined();
    expect(rule.needsSitemaps).toBeUndefined();
    expect(rule.listPartial).toBeUndefined();
    expect(rule.columns?.map((c) => c.key)).toEqual([
      "notMeasured",
      "partiallyMeasured",
      "sitemapsRead",
    ]);
  });

  it("refuses the flags on crawl.list-mode itself, and only there among markers", () => {
    const list = all.find((r) => r.id === "crawl.list-mode") as QueryRule;
    for (const flag of ["needsSpider", "needsSitemaps", "listPartial"] as const) {
      expect(() => defineRule<QueryRule>({ ...list, [flag]: true }), flag).toThrow(
        RuleDefinitionError,
      );
    }
    // `links.orphan-skipped` is a marker and needs the spider.
    const orphanSkipped = all.find((r) => r.id === "links.orphan-skipped")!;
    expect(orphanSkipped.marker).toBeTruthy();
    expect(orphanSkipped.needsSpider).toBe(true);
    // listPartial beside a not-run flag is a contradiction.
    const partial = all.find((r) => r.id === "canonical.chain") as QueryRule;
    for (const flag of ["needsSpider", "needsSitemaps"] as const) {
      expect(() => defineRule<QueryRule>({ ...partial, [flag]: true }), flag).toThrow(
        /listPartial is refused beside/,
      );
    }
    // A flag is `true` or absent.
    expect(() =>
      defineRule<QueryRule>({ ...list, id: "x.y", needsSpider: false as unknown as true }),
    ).toThrow(/must be true/);
  });
});

describe("runRules on a list crawl", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(opts: {
    mode?: unknown;
    sitemapsRead?: unknown;
    discovery?: unknown;
  }): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      config: {
        maxPages: 10_000,
        userAgent: "AriadneBot-test",
        ...(opts.mode === undefined ? {} : { mode: opts.mode }),
      },
      discovery:
        opts.discovery !== undefined
          ? (opts.discovery as never)
          : {
              ...mkDiscovery(),
              ...(opts.sitemapsRead === undefined ? {} : { sitemapsRead: opts.sitemapsRead }),
            },
      hostProbe: mkHostProbe(SITE),
      rulesetVersion: "test",
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPage(
    crawlId: string,
    path: string,
    overrides: Partial<ReturnType<typeof mkPage>> = {},
  ): Promise<void> {
    const url = `${SITE}${path}`;
    await db.insert(pages).values(
      mkPage({
        id: `page_${randomUUID()}`,
        crawlId,
        url,
        urlNormalised: url,
        canonicalHtml: url,
        title: `A page about ${path} and its own clean heading`,
        ...overrides,
      }),
    );
  }

  async function ruleIds(crawlId: string): Promise<string[]> {
    const rows = await db.select({ ruleId: issues.ruleId }).from(issues).where(eq(issues.crawlId, crawlId));
    return rows.map((r) => r.ruleId);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("runs none of the flagged rules and names them all when no sitemap was read", async () => {
    const crawlId = await newCrawl({ mode: "list", sitemapsRead: false });
    // Listed pages sit at depth 0 with no inlink: on a spider crawl these two
    // would be orphans, and the crawl's depth metrics would have rows.
    await addPage(crawlId, "/a", { depth: 0, discoveredVia: "list" });
    await addPage(crawlId, "/b", { depth: 0, discoveredVia: "list" });

    const summary = await runRules(db, crawlId, buildRegistry());

    const ids = await ruleIds(crawlId);
    for (const id of [...NEEDS_SPIDER, ...NEEDS_SITEMAPS]) {
      expect(ids, id).not.toContain(id);
      expect(summary.byRule[id], id).toBeUndefined();
      expect(summary.byMetric[id], id).toBeUndefined();
    }
    const metricRows = await db
      .select({ metricId: metrics.metricId })
      .from(metrics)
      .where(eq(metrics.crawlId, crawlId));
    const written = new Set(metricRows.map((m) => m.metricId));
    for (const id of [...NEEDS_SPIDER, ...NEEDS_SITEMAPS]) expect(written.has(id), id).toBe(false);

    const marker = await db
      .select()
      .from(issues)
      .where(eq(issues.crawlId, crawlId));
    const listMode = marker.filter((r) => r.ruleId === "crawl.list-mode");
    expect(listMode).toHaveLength(1);
    expect(listMode[0]!.pageId).toBeNull();
    expect(listMode[0]!.severity).toBe("info");
    expect(listMode[0]!.details).toMatchObject({
      pageUrl: null,
      notMeasured: [...NEEDS_SPIDER, ...NEEDS_SITEMAPS].sort(),
      partiallyMeasured: [...LIST_PARTIAL].sort(),
      sitemapsRead: false,
    });
    // The metric rules that ARE measurable still ran.
    expect(summary.byMetric["site.health"]).toBeDefined();
  });

  it("names only the spider rules, and runs the sitemap rules, when a sitemap was read", async () => {
    const crawlId = await newCrawl({ mode: "list", sitemapsRead: true });
    await addPage(crawlId, "/a", { depth: 0, discoveredVia: "list" });

    const summary = await runRules(db, crawlId, buildRegistry());

    const rows = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
    const listMode = rows.filter((r) => r.ruleId === "crawl.list-mode");
    expect(listMode).toHaveLength(1);
    expect(listMode[0]!.details).toMatchObject({
      notMeasured: [...NEEDS_SPIDER].sort(),
      partiallyMeasured: [...LIST_PARTIAL].sort(),
      sitemapsRead: true,
    });
    for (const id of NEEDS_SPIDER) expect(rows.map((r) => r.ruleId), id).not.toContain(id);
    // `sitemap.structure` is a needsSitemaps metric: it ran.
    expect(summary.byMetric["sitemap.structure"]).toBeDefined();
  });

  // Non-execution proved directly, not by the absence of findings: every
  // flagged rule's `run` is wrapped in a spy and the run is driven through a
  // registry built from the wrapped rules (`runRules` takes the registry).
  function spiedRegistry(calls: Set<string>): Registry {
    const registry = new Registry();
    for (const rule of buildRegistry().all()) {
      const run = rule.run as (...args: unknown[]) => unknown;
      registry.register({
        ...rule,
        run: (...args: unknown[]) => {
          calls.add(rule.id);
          return run(...args);
        },
      } as RuleDefinition);
    }
    return registry;
  }
  const byFlag = (flag: "needsSpider" | "needsSitemaps" | "listPartial"): string[] =>
    buildRegistry().all().filter((r) => r[flag] === true).map((r) => r.id);

  it("never calls a needsSpider or needsSitemaps rule on a list crawl with no sitemap read, and calls every listPartial rule", async () => {
    const crawlId = await newCrawl({ mode: "list", sitemapsRead: false });
    await addPage(crawlId, "/a", { depth: 0, discoveredVia: "list" });
    const calls = new Set<string>();
    await runRules(db, crawlId, spiedRegistry(calls));
    for (const id of [...byFlag("needsSpider"), ...byFlag("needsSitemaps")]) {
      expect(calls.has(id), `${id} must not run`).toBe(false);
    }
    for (const id of byFlag("listPartial")) expect(calls.has(id), `${id} must run`).toBe(true);
    expect(calls.has("crawl.list-mode")).toBe(true);
  });

  it("calls every needsSitemaps rule, and no needsSpider rule, when a sitemap was read", async () => {
    const crawlId = await newCrawl({ mode: "list", sitemapsRead: true });
    await addPage(crawlId, "/a", { depth: 0, discoveredVia: "list" });
    const calls = new Set<string>();
    await runRules(db, crawlId, spiedRegistry(calls));
    for (const id of byFlag("needsSitemaps")) expect(calls.has(id), `${id} must run`).toBe(true);
    for (const id of byFlag("needsSpider")) expect(calls.has(id), `${id} must not run`).toBe(false);
  });

  it("calls every flagged rule on a spider crawl", async () => {
    const crawlId = await newCrawl({ mode: "spider" });
    await addPage(crawlId, "/", { depth: 0, discoveredVia: "seed" });
    const calls = new Set<string>();
    await runRules(db, crawlId, spiedRegistry(calls));
    for (const id of [...byFlag("needsSpider"), ...byFlag("needsSitemaps"), ...byFlag("listPartial")]) {
      expect(calls.has(id), `${id} must run`).toBe(true);
    }
  });

  it("reads an absent sitemapsRead as true", async () => {
    const crawlId = await newCrawl({ mode: "list" });
    await addPage(crawlId, "/a", { depth: 0, discoveredVia: "list" });
    await runRules(db, crawlId, buildRegistry());
    const rows = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
    const listMode = rows.find((r) => r.ruleId === "crawl.list-mode")!;
    expect(listMode.details).toMatchObject({
      sitemapsRead: true,
      notMeasured: [...NEEDS_SPIDER].sort(),
      partiallyMeasured: [...LIST_PARTIAL].sort(),
    });
  });

  it("still judges the listed pages: a duplicate title across two listed URLs is reported", async () => {
    const crawlId = await newCrawl({ mode: "list", sitemapsRead: false });
    const title = "Shared title for the two listed pages here";
    await addPage(crawlId, "/one", { depth: 0, discoveredVia: "list", title });
    await addPage(crawlId, "/two", { depth: 0, discoveredVia: "list", title });
    await runRules(db, crawlId, buildRegistry());
    expect(await ruleIds(crawlId)).toContain("title.duplicate");
  });

  it("writes no crawl.list-mode on a spider crawl, and every flagged rule runs", async () => {
    const crawlId = await newCrawl({ mode: "spider" });
    // The seed, and a page nothing links to: links.orphan's finding.
    await addPage(crawlId, "/", { depth: 0, discoveredVia: "seed" });
    await addPage(crawlId, "/lonely", { depth: 1, discoveredVia: "link" });

    const summary = await runRules(db, crawlId, buildRegistry());

    const ids = await ruleIds(crawlId);
    expect(ids).not.toContain("crawl.list-mode");
    expect(ids).toContain("links.orphan");
    for (const id of ["inlinks.distribution", "structure.depth-distribution", "sitemap.structure"]) {
      expect(summary.byMetric[id], id).toBeDefined();
    }
  });

  it("treats a crawl with no mode as a spider crawl", async () => {
    const crawlId = await newCrawl({});
    await addPage(crawlId, "/", { depth: 0, discoveredVia: "seed" });
    await runRules(db, crawlId, buildRegistry());
    expect(await ruleIds(crawlId)).not.toContain("crawl.list-mode");
  });

  it("throws, naming the crawl, on a stored mode or sitemapsRead of any other shape", async () => {
    const badMode = await newCrawl({ mode: "sideways" });
    await expect(runRules(db, badMode, buildRegistry())).rejects.toThrow(
      new RegExp(`${badMode}.*mode`),
    );
    const badRead = await newCrawl({ mode: "list", sitemapsRead: "yes" });
    await expect(runRules(db, badRead, buildRegistry())).rejects.toThrow(
      new RegExp(`${badRead}.*sitemapsRead`),
    );
    const noDiscovery = await newCrawl({ mode: "list", discovery: null });
    await expect(runRules(db, noDiscovery, buildRegistry())).rejects.toThrow(
      new RegExp(`${noDiscovery}.*discovery`),
    );
  });
});

/**
 * The Crawl Overview (Phase 27a T9): sectioned GROUP BY counts over a crawl,
 * as JSON and as the `crawl_overview` CSV view from one builder. A section the
 * crawl could not measure is named in `notMeasured`, never zero-filled.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import pg from "pg";

import { csvRecord } from "../../src/api/csv.js";
import { createApiServer } from "../../src/api/http.js";
import type { CrawlOverview, OverviewSection } from "../../src/api/overview.js";
import { ApiService } from "../../src/api/service.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, issues, pages, resources, sitemapUrls } from "../../src/db/schema.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://crawl-overview.example";
const SLOW = "performance.slow-response";

let db: Db;
let service: ApiService;
let exportDir: string;
const runId = randomUUID();
const crawlId = `crawl_crawl_overview_${runId}`;
const unjudgedId = `crawl_crawl_overview_unjudged_${runId}`;
const renderedId = `crawl_crawl_overview_rendered_${runId}`;
const renderedUnjudgedId = `crawl_crawl_overview_rendered_unjudged_${runId}`;
const unknownRuleId = `crawl_crawl_overview_unknown_${runId}`;
const racedId = `crawl_crawl_overview_raced_${runId}`;
const allCrawls = [crawlId, unjudgedId, renderedId, renderedUnjudgedId, unknownRuleId, racedId];

type Seed = { path: string } & Partial<PageRecord>;

async function seedCrawl(
  id: string,
  seeds: Seed[],
  extra: { judgement?: unknown; pagesCrawled?: number; renderPassCount?: number } = {},
): Promise<void> {
  await db.insert(crawls).values({
    id,
    siteUrl: `${SITE}/`,
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: extra.pagesCrawled ?? seeds.length,
    renderPassCount: extra.renderPassCount ?? 0,
    // What every crawl loop since migration 0020 writes at its start; null is a
    // crawl that predates the counter, tested on its own below.
    robotsBlockedDropped: 0,
    ...(extra.judgement === undefined ? {} : { judgement: extra.judgement }),
  });
  await db.insert(pages).values(
    seeds.map(({ path, ...overrides }, i) => {
      const url = `${SITE}${path}`;
      return mkPage({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url,
        urlNormalised: url,
        ...(i === 0 ? { depth: 0, clickDepth: 0, discoveredVia: "seed" } : {}),
        ...overrides,
      });
    }),
  );
}

async function overview(id: string = crawlId): Promise<CrawlOverview> {
  return await service.crawlOverview(id);
}

function section(o: CrawlOverview, id: string): OverviewSection {
  const found = o.sections.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no section '${id}' in the overview`);
  return found;
}

function entry(o: CrawlOverview, sectionId: string, label: string): { value: number; percent: number | null } {
  const found = section(o, sectionId).entries.find((e) => e.label === label);
  if (found === undefined) throw new Error(`no entry '${label}' in section '${sectionId}'`);
  return { value: found.value, percent: found.percent };
}

const sum = (s: OverviewSection): number => s.entries.reduce((n, e) => n + e.value, 0);

async function pageCount(id: string): Promise<number> {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from pages where crawl_id = ${id}`,
  );
  return r.rows[0]!.n;
}

async function csvLines(id: string = crawlId): Promise<string[]> {
  const stream = await service.prepareCsvExport(id, { view: "crawl_overview" });
  const out: string[] = [];
  for await (const record of stream.records()) out.push(record);
  return out;
}

const NOT_JUDGED = (p: Seed): Seed => ({ ...p, isIndexable: false, canonicalHtml: null });

/**
 * A page the render pass finished, its post-JavaScript columns equal to the
 * clean page's raw ones, so no render-diff rule has anything to say.
 */
function RENDERED(path: string): Seed {
  const clean = mkPage({ url: `${SITE}${path}` });
  return {
    path,
    rendered: true,
    renderedWordCount: clean.wordCount,
    renderedLinkCount: 20,
    renderedNavLinkCount: clean.navLinkCount,
    renderedFooterLinkCount: clean.footerLinkCount,
    renderedFilterLinkCount: 0,
    renderedAnalyzerWordCount: clean.wordCount,
    renderedRenderableWordCount: clean.renderableWordCount,
    renderedTitle: clean.title,
    renderedH1Count: clean.h1Count,
    renderedCanonical: clean.canonicalHtml,
    renderedRobotsMeta: null,
    renderedMetaDescription: clean.metaDescription,
    renderedH1Text: clean.h1Text,
    renderedTagsRead: true,
  };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-crawl-overview-"));
  service = new ApiService(db, { allowedDomains: [], exportDir, log: () => {} });

  // The judged, unrendered fixture: six response-time edges, a PDF, a 404 and a
  // robots-blocked row (never requested, so no response time).
  await seedCrawl(
    crawlId,
    [
      { path: "/", responseTimeMs: 249 },
      { path: "/a", responseTimeMs: 250 },
      { path: "/b", responseTimeMs: 999 },
      { path: "/c", responseTimeMs: 1000 },
      { path: "/d", responseTimeMs: 1999 },
      { path: "/e", responseTimeMs: 2000 },
      NOT_JUDGED({
        path: "/file.pdf",
        fetchClass: "non_html",
        contentType: "application/pdf",
        responseTimeMs: 100,
        title: null,
      }),
      NOT_JUDGED({ path: "/missing", fetchClass: "client_error", statusCode: 404, responseTimeMs: 120 }),
      NOT_JUDGED({
        path: "/private",
        fetchClass: "disallowed",
        fetchReason: "robots.txt: Disallow: /private",
        statusCode: null,
        contentType: null,
        responseTimeMs: null,
        title: null,
      }),
    ],
    { judgement: { thresholds: { SLOW_MS: 800 } }, pagesCrawled: 8 },
  );
  await db.update(crawls).set({ robotsBlockedDropped: 3 }).where(eq(crawls.id, crawlId));
  await db.insert(frontier).values([
    ...["/", "/a", "/b", "/c", "/d", "/e", "/file.pdf", "/missing"].map((path) => ({
      crawlId,
      url: `${SITE}${path}`,
      state: "done",
      depth: 1,
      discoveredVia: "link",
    })),
    { crawlId, url: `${SITE}/later`, state: "pending", depth: 2, discoveredVia: "link" },
  ]);
  await db.insert(sitemapUrls).values({
    crawlId,
    url: `${SITE}/a`,
    urlNormalised: `${SITE}/a`,
    sitemapSource: `${SITE}/sitemap.xml`,
  });
  await db.insert(resources).values([
    { crawlId, url: `${SITE}/i1.png`, kind: "image" },
    { crawlId, url: `${SITE}/i2.png`, kind: "image" },
    { crawlId, url: `${SITE}/s.css`, kind: "css" },
    { crawlId, url: `${SITE}/app.js`, kind: "js" },
  ]);
  await service.runRulesForCrawl(crawlId);

  await seedCrawl(unjudgedId, [{ path: "/" }]);

  await seedCrawl(
    renderedId,
    [RENDERED("/"), { path: "/x" }],
    { renderPassCount: 1 },
  );
  await service.runRulesForCrawl(renderedId);

  await seedCrawl(
    renderedUnjudgedId,
    [RENDERED("/"), { path: "/x" }],
    { renderPassCount: 1 },
  );

  await seedCrawl(unknownRuleId, [{ path: "/" }]);
  await service.runRulesForCrawl(unknownRuleId);

  await seedCrawl(racedId, [{ path: "/" }, { path: "/slow", responseTimeMs: 5000 }]);
  await service.runRulesForCrawl(racedId);
  await db.insert(issues).values({
    crawlId: unknownRuleId,
    ruleId: "no.such-rule",
    pageId: null,
    severity: "info",
    dedupeKey: "k",
    details: {},
  });
}, 60_000);

afterAll(async () => {
  await service.close();
  for (const id of allCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  rmSync(exportDir, { recursive: true, force: true });
});

describe("crawl_overview on a judged, unrendered crawl", () => {
  it("lists the measured sections in order and names render as not measured", async () => {
    const o = await overview();
    expect(o.crawlId).toBe(crawlId);
    expect(o.sections.map((s) => s.id)).toEqual([
      "urls",
      "fetch-class",
      "status-class",
      "content",
      "indexability",
      "click-depth",
      "discovery",
      "response-time",
      "issues-grid",
    ]);
    expect(o.notMeasured).toEqual([{ id: "render", reason: "no render pass ran" }]);
    expect(o.judgementStale).toEqual({ stale: false, reasons: [] });
  });

  it("takes every urls entry from the crawl_status field it names", async () => {
    const o = await overview();
    const detail = await service.getCrawl(crawlId);
    const f = detail.frontier;
    const encountered =
      f.pending + f.leased + f.done + f.failed + f.renderPending + detail.robotsBlocked.recorded;
    expect(section(o, "urls").entries.map((e) => e.label)).toEqual([
      "Encountered",
      "Fetched",
      "Not fetched (frontier)",
      "Blocked by robots.txt (stored)",
      "Blocked by robots.txt (dropped)",
    ]);
    expect(entry(o, "urls", "Encountered")).toEqual({ value: encountered, percent: 100 });
    expect(encountered).toBe(10);
    expect(entry(o, "urls", "Fetched").value).toBe(detail.pagesCrawled);
    expect(entry(o, "urls", "Fetched").percent).toBe(80);
    expect(entry(o, "urls", "Not fetched (frontier)").value).toBe(f.pending + f.leased);
    expect(entry(o, "urls", "Blocked by robots.txt (stored)").value).toBe(
      detail.robotsBlocked.recorded,
    );
    // Discoveries, not URLs: not a subset of Encountered, so no percent.
    expect(entry(o, "urls", "Blocked by robots.txt (dropped)")).toEqual({
      value: detail.robotsBlocked.dropped,
      percent: null,
    });
  });

  it("sums fetch-class, status-class and indexability to the pages row count", async () => {
    const o = await overview();
    const n = await pageCount(crawlId);
    expect(n).toBe(9);
    expect(sum(section(o, "fetch-class"))).toBe(n);
    expect(entry(o, "fetch-class", "ok").value).toBe(6);
    expect(section(o, "status-class").entries.map((e) => e.label)).toEqual([
      "2xx",
      "3xx",
      "4xx",
      "5xx",
      "No response",
    ]);
    expect(sum(section(o, "status-class"))).toBe(n);
    expect(entry(o, "status-class", "4xx").value).toBe(1);
    expect(entry(o, "status-class", "No response").value).toBe(1);
    expect(sum(section(o, "indexability"))).toBe(n);
    expect(section(o, "indexability").entries[0]!.label).toBe("Indexable");
    expect(entry(o, "indexability", "Indexable").value).toBe(6);
    expect(entry(o, "indexability", "Client Error").value).toBe(1);
    expect(entry(o, "indexability", "Blocked by robots.txt").value).toBe(1);
    expect(entry(o, "indexability", "Not HTML").value).toBe(1);
    expect(entry(o, "fetch-class", "ok").percent).toBe(66.7);
  });

  it("splits content into HTML, non-HTML and resources, each against its own subtotal", async () => {
    const o = await overview();
    const entries = section(o, "content").entries;
    const html = entries.filter((e) => e.label.startsWith("HTML: "));
    expect(html.reduce((n, e) => n + e.value, 0)).toBe(6);
    expect(html.reduce((n, e) => n + (e.percent ?? 0), 0)).toBeCloseTo(100, 0);
    expect(entry(o, "content", "Non-HTML: PDF")).toEqual({ value: 1, percent: 100 });
    expect(entry(o, "content", "Resource: Image")).toEqual({ value: 2, percent: 50 });
    expect(entry(o, "content", "Resource: CSS")).toEqual({ value: 1, percent: 25 });
    expect(entry(o, "content", "Resource: JavaScript")).toEqual({ value: 1, percent: 25 });
    // Groups in order: HTML, then non-HTML, then resources.
    const groups = entries.map((e) => e.label.split(": ")[0]);
    expect(groups).toEqual([...groups].sort((a, b) =>
      ["HTML", "Non-HTML", "Resource"].indexOf(a!) - ["HTML", "Non-HTML", "Resource"].indexOf(b!),
    ));
  });

  it("buckets click depth 0..9, 10+ and Unreachable over every page", async () => {
    const o = await overview();
    const s = section(o, "click-depth");
    expect(s.entries.map((e) => e.label)).toEqual([
      "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10+", "Unreachable",
    ]);
    expect(sum(s)).toBe(await pageCount(crawlId));
    expect(entry(o, "click-depth", "0").value).toBe(1);
  });

  it("counts discovery per discovered_via and in-sitemap against the pages", async () => {
    const o = await overview();
    expect(entry(o, "discovery", "seed").value).toBe(1);
    expect(entry(o, "discovery", "link").value).toBe(8);
    expect(entry(o, "discovery", "In a sitemap").value).toBe(1);
    expect(entry(o, "discovery", "Not in a sitemap").value).toBe(8);
  });

  it("lands each response time in exactly one [lo, hi) bucket and counts Over SLOW_MS with >", async () => {
    const o = await overview();
    expect(section(o, "response-time").entries.map((e) => [e.label, e.value])).toEqual([
      ["Under 250 ms", 3], // 249, plus the PDF (100) and the 404 (120)
      ["250–500 ms", 1], // 250
      ["500–1000 ms", 1], // 999
      ["1000–2000 ms", 2], // 1000, 1999
      ["2000+ ms", 1], // 2000
      ["No response time", 1], // the robots-blocked row
      ["Over SLOW_MS (800 ms)", 4], // 999, 1000, 1999, 2000
    ]);
  });

  it("grids the findings by type x priority, after the disabled filter", async () => {
    const o = await overview();
    const grid = section(o, "issues-grid");
    expect(grid.entries.map((e) => e.label)).toEqual([
      "issue/high", "issue/medium", "issue/low",
      "warning/high", "warning/medium", "warning/low",
      "opportunity/high", "opportunity/medium", "opportunity/low",
    ]);
    const stored = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from issues where crawl_id = ${crawlId}`,
    );
    expect(sum(grid)).toBe(stored.rows[0]!.n);
  });

  it("applies a retype to the grid immediately, and a disable drops the rule's findings", async () => {
    const slow = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from issues where crawl_id = ${crawlId} and rule_id = ${SLOW}`);
    const slowCount = slow.rows[0]!.n;
    expect(slowCount).toBe(4);
    const before = await overview();
    try {
      await db
        .update(crawls)
        .set({ judgement: { thresholds: { SLOW_MS: 800 }, rules: { [SLOW]: { type: "issue" } } } })
        .where(eq(crawls.id, crawlId));
      const after = await overview();
      // slow-response defaults to warning / medium.
      expect(entry(after, "issues-grid", "issue/medium").value).toBe(
        entry(before, "issues-grid", "issue/medium").value + slowCount,
      );
      expect(entry(after, "issues-grid", "warning/medium").value).toBe(
        entry(before, "issues-grid", "warning/medium").value - slowCount,
      );

      await db
        .update(crawls)
        .set({ judgement: { thresholds: { SLOW_MS: 800 }, rules: { [SLOW]: { disabled: true } } } })
        .where(eq(crawls.id, crawlId));
      const disabled = await overview();
      expect(sum(section(disabled, "issues-grid"))).toBe(
        sum(section(before, "issues-grid")) - slowCount,
      );
    } finally {
      await db
        .update(crawls)
        .set({ judgement: { thresholds: { SLOW_MS: 800 } } })
        .where(eq(crawls.id, crawlId));
    }
  });
});

describe("crawl_overview on other crawls", () => {
  it("still answers the crawl-level sections on an unjudged crawl", async () => {
    const o = await overview(unjudgedId);
    expect(o.notMeasured.map((n) => n.id)).toEqual(["click-depth", "render", "issues-grid"]);
    expect(o.notMeasured[0]!.reason).toBe(
      "click depth is derived by the rules run; run crawl_rules",
    );
    expect(o.sections.map((s) => s.id)).toEqual([
      "urls", "fetch-class", "status-class", "content", "indexability", "discovery", "response-time",
    ]);
    // An unjudged crawl's SLOW_MS is the current block's: the default here.
    expect(section(o, "response-time").entries.at(-1)!.label).toBe("Over SLOW_MS (1500 ms)");
  });

  it("measures render on a rendered crawl from pages and the stored render.coverage", async () => {
    const o = await overview(renderedId);
    expect(o.notMeasured).toEqual([]);
    expect(section(o, "render").entries).toEqual([
      { label: "Pages rendered", value: 1, percent: 50 },
      { label: "Render coverage (ran)", value: 1, percent: 50 },
    ]);
  });

  it("names render coverage as not measured on a rendered crawl no rules run judged", async () => {
    const o = await overview(renderedUnjudgedId);
    expect(section(o, "render").entries).toEqual([
      { label: "Pages rendered", value: 1, percent: 50 },
    ]);
    expect(o.notMeasured).toContainEqual({
      id: "render-coverage",
      reason: "render coverage is a rules-run metric; run crawl_rules",
    });
  });

  it("names an uncounted robots overflow (pre-0020 crawl) instead of writing 0", async () => {
    await db.update(crawls).set({ robotsBlockedDropped: null }).where(eq(crawls.id, unjudgedId));
    try {
      const o = await overview(unjudgedId);
      expect(section(o, "urls").entries.map((e) => e.label)).not.toContain(
        "Blocked by robots.txt (dropped)",
      );
      expect(o.notMeasured[0]!.id).toBe("robots-blocked-dropped");
    } finally {
      await db.update(crawls).set({ robotsBlockedDropped: 0 }).where(eq(crawls.id, unjudgedId));
    }
  });

  it("refuses a stored finding of a rule the ruleset lacks (409)", async () => {
    await expect(overview(unknownRuleId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("answers NOT_FOUND for an unknown crawl", async () => {
    await expect(overview(`crawl_nope_${runId}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serves the same answer at GET /crawls/:id/overview/crawl", async () => {
    const api = createApiServer({
      db,
      config: { token: "t", allowedDomains: [], exportDir, log: () => {} },
    });
    const { port } = await api.listen(0);
    try {
      const get = (id: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/crawls/${id}/overview/crawl`, {
          headers: { authorization: "Bearer t" },
        });
      const res = await get(crawlId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(await overview());
      expect((await get(`crawl_nope_${runId}`)).status).toBe(404);
    } finally {
      await api.close();
    }
  });
});

/**
 * A `crawl_rules` re-run's first commit (run.ts) is `delete issues` together
 * with `rules_run_at = null`. An overview must see that pair as ONE state: a
 * judgement view read before it beside `issues` rows read after it reports a
 * measured zero, where the truth is "not judged".
 *
 * DETERMINISTIC INTERLEAVING: the service under test runs on a `Db` whose
 * `transaction` first commits exactly that state on the pool, then opens the
 * real transaction. Any read made BEFORE the overview's snapshot opens (the
 * pre-fix judgement view) saw the judged crawl; every read inside it sees the
 * reset. An overview that reads everything inside its snapshot answers
 * "not measured" (Crawl Overview) or refuses (Issues Overview), never zeros.
 */
describe("the overviews read the judgement inside their snapshot", () => {
  let raced: ApiService;
  let armed = false;

  beforeAll(() => {
    const resetLikeARulesRun = async (): Promise<void> => {
      await db.transaction(async (tx) => {
        await tx.delete(issues).where(eq(issues.crawlId, racedId));
        await tx
          .update(crawls)
          .set({ rulesRunAt: null, rulesJudgedWith: null })
          .where(eq(crawls.id, racedId));
      });
    };
    const rigged = new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        const bound =
          typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        if (prop !== "transaction" || typeof bound !== "function") return bound;
        return async (...args: unknown[]) => {
          if (armed) {
            armed = false;
            await resetLikeARulesRun();
          }
          return await bound(...args);
        };
      },
    }) as Db;
    raced = new ApiService(rigged, { allowedDomains: [], exportDir, log: () => {} });
  });

  afterAll(async () => {
    await raced.close();
  });

  it("crawl_overview names issues-grid and click-depth as not measured, never zeros", async () => {
    expect((await service.getCrawl(racedId)).rulesRunAt).not.toBeNull();
    armed = true;
    const o = await raced.crawlOverview(racedId);
    expect(armed).toBe(false); // the reset really landed mid-call
    expect(o.sections.map((s) => s.id)).not.toContain("issues-grid");
    expect(o.notMeasured.map((n) => n.id)).toEqual(
      expect.arrayContaining(["click-depth", "issues-grid"]),
    );
  });

  it("issues_overview refuses the crawl as unjudged rather than listing no rows", async () => {
    await service.runRulesForCrawl(racedId);
    expect((await service.issuesOverview(racedId, {})).rows.length).toBeGreaterThan(0);
    armed = true;
    await expect(raced.issuesOverview(racedId, {})).rejects.toMatchObject({ code: "CONFLICT" });
    expect(armed).toBe(false);
  });
});

describe("crawl_overview CSV", () => {
  it("has the exact header and one row per JSON entry, then the not-measured rows", async () => {
    const o = await overview();
    const lines = await csvLines();
    expect(lines[0]).toBe("Section,Label,Value,Percent\r\n");
    const expected: string[] = [];
    for (const s of o.sections) {
      for (const e of s.entries) {
        expected.push(
          csvRecord([s.id, e.label, String(e.value), e.percent === null ? "" : String(e.percent)]),
        );
      }
    }
    for (const n of o.notMeasured) {
      expected.push(csvRecord([n.id, `Not measured: ${n.reason}`, "", ""]));
    }
    expect(lines.slice(1)).toEqual(expected);
  });

  it("answers an unjudged crawl too", async () => {
    const lines = await csvLines(unjudgedId);
    expect(lines).toContain(
      "click-depth,Not measured: click depth is derived by the rules run; run crawl_rules,,\r\n",
    );
  });
});

/**
 * A transaction holds ONE pg client, and pg 8 queues a second `query()` issued
 * while the first is in flight, warns that the queueing is deprecated, and pg 9
 * removes it. The overview reads `crawl_status`'s detail inside its snapshot,
 * so those reads must be issued one at a time there (27a T10 fix).
 *
 * The deprecation is a `util.deprecate` notice, which Node prints ONCE per
 * process: a listener alone would miss it if an earlier test in the same worker
 * had already triggered it. So the test also watches the client directly and
 * fails on any query issued while another is in flight on the same client.
 */
describe("crawl_overview on one pg client", () => {
  it("never issues a query while another is in flight on its client, and emits no warning", async () => {
    const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const original = proto.query;
    const inFlight = new WeakMap<object, number>();
    const overlaps: string[] = [];
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(`${w.name}: ${w.message}`);
    };
    proto.query = function (this: object, ...args: unknown[]): unknown {
      const n = inFlight.get(this) ?? 0;
      if (n > 0) {
        const first = args[0];
        const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
        overlaps.push(String(text).slice(0, 80));
      }
      inFlight.set(this, n + 1);
      const done = (): void => {
        inFlight.set(this, (inFlight.get(this) ?? 1) - 1);
      };
      const last = args.at(-1);
      if (typeof last === "function") {
        args[args.length - 1] = (...cb: unknown[]): unknown => {
          done();
          return (last as (...a: unknown[]) => unknown)(...cb);
        };
        return original.apply(this, args);
      }
      const result = original.apply(this, args);
      if (result instanceof Promise) return result.finally(done);
      done();
      return result;
    };
    process.on("warning", onWarning);
    try {
      await overview(crawlId);
      await overview(renderedId);
      await overview(unjudgedId);
      await csvLines();
    } finally {
      proto.query = original;
      process.off("warning", onWarning);
    }
    expect(overlaps).toEqual([]);
    expect(warnings.filter((w) => w.includes("already executing a query"))).toEqual([]);
  });
});

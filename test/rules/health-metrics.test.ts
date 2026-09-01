/**
 * `site.health` — the rollup Talos draws a gauge from (P10-T2).
 *
 * Every other metric test in this directory hand-derives numbers about a SITE
 * from rows describing that site. This one hand-derives numbers about a
 * JUDGEMENT: the pages go in, the `issues` rows that judge them go in beside
 * them, and what is asserted is which bucket each page lands in and that the
 * buckets add up.
 *
 * Two of the cases here are about what must NOT reach a bucket — a finding that
 * names no page, and a finding on a page outside the auditable census — and one
 * is about the cap: a capped run is driven end to end through `runRules` so the
 * metric counts the findings that RUN actually wrote, rather than a listing
 * nobody has.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, pages } from "../../src/db/schema.js";
import { healthMetrics, SEVERITY_ORDER } from "../../src/rules/metric/health-metrics.js";
import { linkGraphRules } from "../../src/rules/query/link-graph.js";
import { Registry } from "../../src/rules/registry/registry.js";
import type { Metric, Severity } from "../../src/rules/registry/types.js";
import { runRules } from "../../src/rules/run.js";
import { mkDiscovery } from "./mk-discovery.js";
import { CLEAN_META, mkPage } from "./mk-page.js";
import {
  databaseUrl,
  dropCrawls,
  expectRefusesUnknownCrawl,
  metricLookup,
  newMetricCrawl,
} from "./metric-db.js";

const SITE = "https://health-metrics.example";
const url = (path: string): string => `${SITE}${path}`;

const rule = metricLookup(healthMetrics, "healthMetrics");
const HEALTH = "site.health";

describe("healthMetrics metadata", () => {
  it("is one metric, filed under a check it does not claim to answer", () => {
    expect(healthMetrics.map((r) => [r.id, r.checkIds, r.category, r.severity, r.kind])).toEqual([
      // CHECK-32 is a FILING decision — the checklist has no check for a
      // site-wide judgement rollup, and its Evaluation Principle 2 says a crawl
      // summary answers no check at all. See the rule's module header.
      [HEALTH, ["CHECK-32"], "crawl", "info", "metric"],
    ]);
    for (const r of healthMetrics) {
      expect(r.title.length).toBeGreaterThan(5);
      expect(r.explanation.length).toBeGreaterThan(40);
      expect(r.howToFix.length).toBeGreaterThan(30);
      expect(r.rulesetVersion).toBeTruthy();
    }
  });

  it("ranks severities worst-first, which is what makes `min` the worst one", () => {
    // The list IS the ranking: the SQL builds `when 'critical' then 1 …` from
    // it in order. A reordering here silently re-labels every bucket, so the
    // order is pinned rather than left to the file it lives in.
    expect(SEVERITY_ORDER).toEqual(["critical", "warning", "info"]);
  });
});

interface PageSpec {
  path: string;
  statusCode?: number;
  fetchClass?: string;
  /** The severities this page's findings carry, one issue row each. */
  findings?: Severity[];
}

describe("site.health against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  const newCrawl = async (): Promise<string> =>
    newMetricCrawl(db, SITE, createdCrawls, {
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      discovery: mkDiscovery() as unknown as Record<string, unknown>,
    });

  /** Pages, and the issue rows judging them, exactly as `runRules` writes both. */
  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      pageType: "content",
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: true,
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);

    const found = specs.flatMap((s, i) =>
      (s.findings ?? []).map((severity, n) => ({
        crawlId,
        ruleId: `test.${severity}-${String(n)}`,
        pageId: rows[i]!.id,
        severity,
        rulesetVersion: "test",
        dedupeKey: `${s.path}#${String(n)}`,
        details: { pageUrl: url(s.path) },
      })),
    );
    if (found.length > 0) await db.insert(issues).values(found);
  }

  /** A finding that names no page: the sitemap, robots and host rules' shape. */
  async function addSiteFinding(crawlId: string, severity: Severity): Promise<void> {
    await db.insert(issues).values({
      crawlId,
      ruleId: "test.site-level",
      pageId: null,
      severity,
      rulesetVersion: "test",
      dedupeKey: `site#${severity}`,
      details: { pageUrl: null },
    });
  }

  /** One page's id, scoped to its crawl — the URLs repeat across the file. */
  async function pageId(crawlId: string, path: string): Promise<string> {
    const rows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.crawlId, crawlId), eq(pages.url, url(path))));
    expect(rows, `one pages row for ${path}`).toHaveLength(1);
    return rows[0]!.id;
  }

  async function health(crawlId: string): Promise<Record<string, unknown>> {
    const rows: Metric[] = await rule(HEALTH).run(db, crawlId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metricId).toBe(HEALTH);
    expect(rows[0]!.scope).toBe("site");
    expect(rows[0]!.scopeValue).toBe("");
    return rows[0]!.value;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await dropCrawls(db, createdCrawls);
    await closeDb(db);
  });

  it("refuses a crawl id nothing knows", async () => {
    // Zero pages aggregate to an empty census and a null ratio, which is also
    // the honest answer for a crawl that fetched nothing. Two facts, one shape
    // (hard rule 7).
    await expectRefusesUnknownCrawl(db, healthMetrics);
  });

  /**
   * THE CRAWL UNDER TEST, and every number below is read off it.
   *
   *   /crit-and-warn   200  critical + warning   -> critical
   *   /crit-only       200  critical             -> critical
   *   /warn-and-info   200  warning + info       -> warning only
   *   /warn-only       200  warning              -> warning only
   *   /info-only       200  info                 -> info only
   *   /clean-1         200  (none)               -> clean
   *   /clean-2         200  (none)               -> clean
   *
   * 7 auditable pages: 2 critical, 2 warning-only, 1 info-only, 2 clean.
   */
  const MIXED: PageSpec[] = [
    { path: "/crit-and-warn", findings: ["critical", "warning"] },
    { path: "/crit-only", findings: ["critical"] },
    { path: "/warn-and-info", findings: ["warning", "info"] },
    { path: "/warn-only", findings: ["warning"] },
    { path: "/info-only", findings: ["info"] },
    { path: "/clean-1" },
    { path: "/clean-2" },
  ];

  it("counts a page once, at the worst severity it carries", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, MIXED);

    expect(await health(crawlId)).toEqual({
      urlsTotal: 7,
      // `/crit-and-warn` carries two findings and is one page, in the critical
      // bucket: the warning beside the critical changes nothing.
      urlsWithCritical: 2,
      urlsWithWarningOnly: 2,
      urlsWithInfoOnly: 1,
      urlsClean: 2,
      // 2/7 = 0.285714… -> four decimal places.
      cleanRatio: 0.2857,
      pagesNotAuditable: 0,
    });
  });

  it("partitions the census exactly, whatever the mix", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, MIXED);
    const v = await health(crawlId);
    const sum =
      Number(v["urlsWithCritical"]) +
      Number(v["urlsWithWarningOnly"]) +
      Number(v["urlsWithInfoOnly"]) +
      Number(v["urlsClean"]);
    // Asserted here as well as inside the rule (which throws on a mismatch)
    // because this is the property a gauge is drawn from: four slices of one
    // pie, no page in two of them and none in none of them.
    expect(sum).toBe(Number(v["urlsTotal"]));
    expect(sum).toBe(7);
  });

  it("reports every page clean, at a ratio of one, when nothing was found", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/a" }, { path: "/b" }, { path: "/c" }]);

    expect(await health(crawlId)).toEqual({
      urlsTotal: 3,
      urlsWithCritical: 0,
      urlsWithWarningOnly: 0,
      urlsWithInfoOnly: 0,
      urlsClean: 3,
      cleanRatio: 1,
      pagesNotAuditable: 0,
    });
  });

  it("answers an empty census with a null ratio rather than a clean sheet", async () => {
    const crawlId = await newCrawl();
    // A crawl of nothing but redirects: no auditable page, so there is no
    // denominator. A ratio of 1 would say every page is clean and a ratio of 0
    // would say none is; both are claims about pages that do not exist.
    await addPages(crawlId, [
      { path: "/r1", statusCode: 301, fetchClass: "redirect" },
      { path: "/r2", statusCode: 301, fetchClass: "redirect" },
    ]);

    expect(await health(crawlId)).toEqual({
      urlsTotal: 0,
      urlsWithCritical: 0,
      urlsWithWarningOnly: 0,
      urlsWithInfoOnly: 0,
      urlsClean: 0,
      cleanRatio: null,
      pagesNotAuditable: 2,
    });
  });

  it("lets no site-level finding poison a page bucket", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/a" }, { path: "/b" }]);
    // `sitemap.missing`, `robots.missing` and the host rules write findings
    // with a null page id: they accuse the SITE. A rollup that let one of them
    // land in a bucket would report a page as faulty that nothing said anything
    // about — and a critical one would empty the clean bucket on a site whose
    // every page is fine.
    await addSiteFinding(crawlId, "critical");
    await addSiteFinding(crawlId, "warning");

    expect(await health(crawlId)).toEqual({
      urlsTotal: 2,
      urlsWithCritical: 0,
      urlsWithWarningOnly: 0,
      urlsWithInfoOnly: 0,
      urlsClean: 2,
      cleanRatio: 1,
      pagesNotAuditable: 0,
    });
  });

  it("keeps the pages it cannot judge out of the buckets and says how many there are", async () => {
    const crawlId = await newCrawl();
    // A 404 and a redirect carry findings of their own — `http.server-error`,
    // the redirect rules — and they are not pages whose CONTENT was judged, so
    // they are outside the census. `pagesNotAuditable` is what stops that
    // exclusion being invisible: a crawl of 7 pages reporting a census of 2
    // says so on the row.
    //
    // BOTH HALVES OF `isAuditable` are exercised, because either alone lets a
    // page in that the rules never judged: `/asset.pdf` answered 200 and is not
    // HTML, `/no-content` was fetched fine and answered 204.
    await addPages(crawlId, [
      { path: "/ok-1", findings: ["warning"] },
      { path: "/ok-2" },
      { path: "/gone", statusCode: 404, fetchClass: "client_error", findings: ["critical"] },
      { path: "/boom", statusCode: 500, fetchClass: "server_error", findings: ["critical"] },
      { path: "/moved", statusCode: 301, fetchClass: "redirect", findings: ["warning"] },
      { path: "/asset.pdf", statusCode: 200, fetchClass: "non_html", findings: ["info"] },
      { path: "/no-content", statusCode: 204, fetchClass: "ok" },
    ]);

    expect(await health(crawlId)).toEqual({
      urlsTotal: 2,
      // The two criticals are on non-auditable pages: neither reaches a bucket.
      urlsWithCritical: 0,
      urlsWithWarningOnly: 1,
      urlsWithInfoOnly: 0,
      urlsClean: 1,
      cleanRatio: 0.5,
      pagesNotAuditable: 5,
    });
  });

  it("counts a noindex 200 page, which the other metrics' cohort excludes", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/a" }, { path: "/noindex" }]);
    await db
      .update(pages)
      .set({ isIndexable: false })
      .where(and(eq(pages.crawlId, crawlId), eq(pages.url, url("/noindex"))));
    await db.insert(issues).values({
      crawlId,
      ruleId: "test.noindex",
      pageId: await pageId(crawlId, "/noindex"),
      severity: "warning",
      rulesetVersion: "test",
      dedupeKey: "/noindex",
      details: { pageUrl: url("/noindex") },
    });

    // `cohortFilter` — what every other metric measures — would drop this page
    // for not being indexable, and its finding would then belong to no
    // denominator at all. The buckets would stop partitioning anything.
    expect(await health(crawlId)).toEqual({
      urlsTotal: 2,
      urlsWithCritical: 0,
      urlsWithWarningOnly: 1,
      urlsWithInfoOnly: 0,
      urlsClean: 1,
      cleanRatio: 0.5,
      pagesNotAuditable: 0,
    });
  });

  it("refuses to place a severity its ranking does not know", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/a" }]);
    await db.insert(issues).values({
      crawlId,
      ruleId: "test.unranked",
      pageId: await pageId(crawlId, "/a"),
      severity: "catastrophic",
      rulesetVersion: "test",
      dedupeKey: "/a",
      details: { pageUrl: url("/a") },
    });

    // A severity outside the ranking maps to null, which is the same shape as
    // "no finding at all" — so this page would be reported CLEAN while an
    // issues row accused it. The metric stops instead (hard rules 1 and 7).
    await expect(rule(HEALTH).run(db, crawlId)).rejects.toThrow(/catastrophic/);
  });
});

/**
 * The cap case, run end to end.
 *
 * A capped run writes FEWER issue rows, on purpose: the listing rules stop at
 * the cap and record the exact total in a note. This metric counts the rows,
 * so a capped run's clean bucket is larger — the pages past the cap carry no
 * finding to be bucketed by. That is the correct answer (the metric describes
 * the judgement that exists, not one nobody ran), and it is also the reason the
 * copy says the ratio is of REPORTED findings. Both halves are asserted here.
 */
describe("site.health over a capped run", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  /** `links.orphan` and the rollup: the smallest registry that proves the point. */
  const registry = new Registry();
  for (const r of linkGraphRules) if (r.id === "links.orphan") registry.register(r);
  for (const r of healthMetrics) registry.register(r);

  async function newCrawl(config: Record<string, unknown>): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config,
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery() as unknown as Record<string, unknown>,
    });
    createdCrawls.push(id);
    return id;
  }

  /** The seed, plus `n` indexable 200 pages nothing links to: one orphan each. */
  async function addOrphans(crawlId: string, n: number): Promise<void> {
    const rows = [
      mkPage({
        id: `page_${randomUUID()}`,
        crawlId,
        url: `${SITE}/`,
        urlNormalised: SITE,
        depth: 0,
        discoveredVia: "seed",
      }),
    ];
    for (let i = 0; i < n; i++) {
      const u = `${SITE}/o/${String(i).padStart(4, "0")}`;
      rows.push(
        mkPage({
          id: `page_${randomUUID()}`,
          crawlId,
          url: u,
          urlNormalised: u,
          canonicalHtml: u,
          title: `A page about ${String(i).padStart(4, "0")}`,
          metaDescription: `${CLEAN_META} About ${String(i)}.`,
        }),
      );
    }
    await db.insert(pages).values(rows);
  }

  async function siteRow(crawlId: string): Promise<Record<string, unknown>> {
    const rows: Metric[] = await metricLookup(healthMetrics, "healthMetrics")(HEALTH).run(
      db,
      crawlId,
    );
    return rows[0]!.value;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await dropCrawls(db, createdCrawls);
    await closeDb(db);
  });

  it("buckets the findings the capped run wrote, and no others", async () => {
    const capped = await newCrawl({ maxPages: 500, findingCap: 3 });
    const uncapped = await newCrawl({ maxPages: 500, findingCap: null });
    await addOrphans(capped, 9);
    await addOrphans(uncapped, 9);

    const cappedRun = await runRules(db, capped, registry);
    const uncappedRun = await runRules(db, uncapped, registry);
    // The cap did what it says: 3 orphan findings against 9.
    expect(cappedRun.byRule["links.orphan"]).toBe(3);
    expect(uncappedRun.byRule["links.orphan"]).toBe(9);

    // Ten auditable pages either way (the seed plus nine). `links.orphan` is a
    // warning, so every page it named is in the warning-only bucket.
    expect(await siteRow(capped)).toEqual({
      urlsTotal: 10,
      urlsWithCritical: 0,
      urlsWithWarningOnly: 3,
      urlsWithInfoOnly: 0,
      // THE SIX PAGES PAST THE CAP ARE COUNTED CLEAN. They are orphans; the run
      // simply did not list them, and this metric reports the judgement on
      // disk. The truncation note on the third finding is what says the listing
      // was cut, and the copy is what says this ratio is then a floor.
      urlsClean: 7,
      cleanRatio: 0.7,
      pagesNotAuditable: 0,
    });
    expect(await siteRow(uncapped)).toEqual({
      urlsTotal: 10,
      urlsWithCritical: 0,
      urlsWithWarningOnly: 9,
      urlsWithInfoOnly: 0,
      urlsClean: 1,
      cleanRatio: 0.1,
      pagesNotAuditable: 0,
    });
  });

  it("recomputes with the judgement, since the runner drives it every pass", async () => {
    const crawlId = await newCrawl({ maxPages: 500, findingCap: 2 });
    await addOrphans(crawlId, 9);

    await runRules(db, crawlId, registry);
    expect((await siteRow(crawlId))["urlsClean"]).toBe(8);
    // Re-judged uncapped: the rows are rewritten, and so is the rollup. A
    // metric that accumulated instead of recomputing would still be reporting
    // the first run's clean count.
    await runRules(db, crawlId, registry, { findingCap: null });
    expect((await siteRow(crawlId))["urlsClean"]).toBe(1);
  });
});

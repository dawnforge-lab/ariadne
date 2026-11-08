/**
 * Threshold overrides reach the rules (Phase 27a T3).
 *
 * A crawl's stored judgement block carries threshold overrides; `runRules`
 * builds one `JudgementContext` from it and every page, query and metric rule
 * reads its thresholds from that context. Table-driven, one row per overridable
 * threshold a rule consumes: a case that does NOT fire at the defaults and DOES
 * fire under the override, and the reverse (fires at the defaults, silent once
 * the threshold is moved the other way). Evidence that quotes the threshold
 * quotes the override's value.
 *
 * Then the two properties a per-run context has that a module constant would
 * not: two concurrent runs of two crawls cannot see each other's thresholds, and
 * `site.health` leaves out findings of rules the crawl's judgement disables
 * while the findings themselves are still stored.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  crawls,
  issues,
  links,
  metrics,
  pageResources,
  pages,
  resources,
} from "../../src/db/schema.js";
import { DEFAULT_THRESHOLDS, type ThresholdName } from "../../src/rules/judgement.js";
import { directiveRules } from "../../src/rules/page/directives.js";
import { onPageRules } from "../../src/rules/page/on-page.js";
import { pixelWidthRules } from "../../src/rules/page/pixel-width.js";
import { technicalRules } from "../../src/rules/page/technical.js";
import { contentRules } from "../../src/rules/query/content.js";
import { linkGraphRules } from "../../src/rules/query/link-graph.js";
import { linkHygieneRules } from "../../src/rules/query/link-hygiene.js";
import { redirectRules } from "../../src/rules/query/redirects.js";
import { resourceRules } from "../../src/rules/query/resources.js";
import { healthMetrics } from "../../src/rules/metric/health-metrics.js";
import {
  Registry,
  RULESET_VERSION,
  type RuleDefinition,
  type TriageLookup,
} from "../../src/rules/registry/registry.js";
import { triageRow } from "../../src/rules/registry/triage.js";
import type {
  AnyRule,
  Finding,
  JudgementContext,
  PageRecord,
  PageRule,
  QueryRule,
} from "../../src/rules/registry/types.js";
import { runRules } from "../../src/rules/run.js";
import { serpWidth } from "../../src/rules/serp-width.js";
import { mkDiscovery } from "./mk-discovery.js";
import { CLEAN_META, CLEAN_TITLE, mkPage } from "./mk-page.js";

const syntheticTriage =
  (id: string): TriageLookup =>
  (ruleId) =>
    ruleId === id ? { type: "warning", priority: "low" } : triageRow(ruleId);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function find<T extends AnyRule>(rules: T[], id: string): T {
  const found = rules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rule '${id}'`);
  return found;
}

/** The context of a crawl with these overrides. */
function ctxWith(
  overrides: Partial<Record<ThresholdName, number>>,
  disabled: string[] = [],
): JudgementContext {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
    disabledRules: new Set(disabled),
  };
}

// ---------------------------------------------------------------------------
// Page rules
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const FETCHED = new Date("2026-09-08T12:00:00.000Z");
const expiring = (days: number): PageRecord =>
  mkPage({
    fetchedAt: FETCHED,
    robotsMeta: `unavailable_after: ${new Date(FETCHED.getTime() + days * DAY_MS).toUTCString()}`,
  });

const pageRulesById = [...onPageRules, ...technicalRules, ...directiveRules, ...pixelWidthRules];

const widthOf = (text: string, kind: "title" | "description"): number => {
  const w = serpWidth(text, kind);
  if (w === null) throw new Error(`'${text}' is not measurable`);
  return w;
};
const TITLE_W = widthOf(CLEAN_TITLE, "title");
const META_W = widthOf(CLEAN_META, "description");
const WIDE_TITLE = "W".repeat(60);
const WIDE_META = "W".repeat(90);
const NARROW = "ii";

interface PageRow {
  /** The threshold under test (the row's name). */
  name: ThresholdName;
  rule: string;
  /** Silent at the defaults. */
  quiet: PageRecord;
  /** The override that makes `quiet` fire. */
  raise: number;
  /** Fires at the defaults. */
  loud: PageRecord;
  /** The override that silences `loud`. */
  relax: number;
  /** The evidence key that quotes the threshold, when the rule quotes it. */
  evidence?: string;
}

const PAGE_ROWS: PageRow[] = [
  { name: "TITLE_MIN", rule: "title.too-short", quiet: mkPage(), raise: 45, loud: mkPage({ title: "Short title here ok" }), relax: 10, evidence: "min" },
  { name: "TITLE_MAX", rule: "title.too-long", quiet: mkPage({ title: "T".repeat(55) }), raise: 50, loud: mkPage({ title: "T".repeat(65) }), relax: 80, evidence: "max" },
  { name: "META_MIN", rule: "meta-description.too-short", quiet: mkPage(), raise: 120, loud: mkPage({ metaDescription: "m".repeat(60) }), relax: 50, evidence: "min" },
  { name: "META_MAX", rule: "meta-description.too-long", quiet: mkPage({ metaDescription: "m".repeat(120) }), raise: 110, loud: mkPage({ metaDescription: "m".repeat(170) }), relax: 200, evidence: "max" },
  { name: "H1_MAX", rule: "headings.h1-too-long", quiet: mkPage({ h1Text: "h".repeat(35) }), raise: 30, loud: mkPage({ h1Text: "h".repeat(80) }), relax: 90, evidence: "max" },
  { name: "H2_MAX", rule: "h2.too-long", quiet: mkPage({ h2Text: "h".repeat(40) }), raise: 30, loud: mkPage({ h2Text: "h".repeat(80) }), relax: 90, evidence: "max" },
  {
    name: "URL_MAX",
    rule: "url.too-long",
    quiet: mkPage({ url: `https://example.com/${"a".repeat(90)}` }),
    raise: 100,
    loud: mkPage({ url: `https://example.com/${"a".repeat(130)}` }),
    relax: 200,
    evidence: "max",
  },
  { name: "SLOW_MS", rule: "performance.slow-response", quiet: mkPage({ responseTimeMs: 1000 }), raise: 500, loud: mkPage({ responseTimeMs: 2000 }), relax: 3000, evidence: "threshold" },
  { name: "UNAVAILABLE_AFTER_WARN_DAYS", rule: "directives.unavailable-after", quiet: expiring(45), raise: 60, loud: expiring(20), relax: 10 },
  // The pixel rules: widths are measured, so the bounds are built from them.
  { name: "TITLE_PX_MAX", rule: "title.pixel-too-long", quiet: mkPage(), raise: TITLE_W - 1, loud: mkPage({ title: WIDE_TITLE }), relax: widthOf(WIDE_TITLE, "title") + 1, evidence: "max" },
  { name: "TITLE_PX_MIN", rule: "title.pixel-too-short", quiet: mkPage(), raise: TITLE_W + 1, loud: mkPage({ title: NARROW }), relax: 1, evidence: "min" },
  { name: "META_PX_MAX", rule: "meta-description.pixel-too-long", quiet: mkPage(), raise: META_W - 1, loud: mkPage({ metaDescription: WIDE_META }), relax: widthOf(WIDE_META, "description") + 1, evidence: "max" },
  { name: "META_PX_MIN", rule: "meta-description.pixel-too-short", quiet: mkPage(), raise: META_W + 1, loud: mkPage({ metaDescription: NARROW }), relax: 1, evidence: "min" },
];

describe("page rules read their thresholds from the context", () => {
  it("covers every overridable threshold a page rule consumes", () => {
    expect(PAGE_ROWS.map((r) => r.name).sort()).toEqual(
      [
        "TITLE_MIN", "TITLE_MAX", "META_MIN", "META_MAX", "H1_MAX", "H2_MAX", "URL_MAX",
        "SLOW_MS", "UNAVAILABLE_AFTER_WARN_DAYS",
        "TITLE_PX_MAX", "TITLE_PX_MIN", "META_PX_MAX", "META_PX_MIN",
      ].sort(),
    );
  });

  it.each(PAGE_ROWS.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const r: PageRule = find(pageRulesById, row.rule);

    // The preconditions that make the rest mean something: at the defaults the
    // quiet page is quiet, the loud page is loud, with and without a context.
    expect(r.run(row.quiet), "quiet at defaults").toEqual([]);
    expect(r.run(row.quiet, ctxWith({})), "quiet at explicit defaults").toEqual([]);
    expect(r.run(row.loud), "loud at defaults").toHaveLength(1);

    const raised = r.run(row.quiet, ctxWith({ [row.name]: row.raise }));
    expect(raised, "fires under the override").toHaveLength(1);
    if (row.evidence !== undefined) {
      expect(raised[0]!.evidence[row.evidence], "evidence quotes the override").toBe(row.raise);
    }

    expect(r.run(row.loud, ctxWith({ [row.name]: row.relax })), "silent once relaxed").toEqual([]);
  });

  it("does not let one threshold move another rule", () => {
    // TITLE_MAX moves `title.too-long` and nothing about the meta description.
    const page = mkPage({ title: "T".repeat(55), metaDescription: "m".repeat(120) });
    const ctx = ctxWith({ TITLE_MAX: 50 });
    expect(find(pageRulesById, "title.too-long").run(page, ctx)).toHaveLength(1);
    expect(find(pageRulesById, "meta-description.too-long").run(page, ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Query rules, and the runner
// ---------------------------------------------------------------------------

describe("query rules, the runner and site.health against the database", () => {
  let db: Db;
  const created: string[] = [];
  const SITE = "https://thresholds.example";
  const url = (path: string): string => `${SITE}${path}`;

  async function newCrawl(
    judgement: unknown = null,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 10_000, userAgent: "AriadneBot-test" },
      discovery: mkDiscovery(),
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 3,
      judgement,
      ...extra,
    });
    created.push(id);
    return id;
  }

  async function addPage(crawlId: string, path: string, over: Partial<PageRecord> = {}): Promise<string> {
    const full = url(path);
    const id = `page_${randomUUID()}`;
    await db.insert(pages).values(
      mkPage({
        id,
        crawlId,
        url: full,
        urlNormalised: normalizeUrl(full) ?? full,
        canonicalHtml: full,
        ...over,
      }),
    );
    return id;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  const run = (rule: QueryRule, crawlId: string, overrides: Partial<Record<ThresholdName, number>>) =>
    rule.run(db, crawlId, undefined, ctxWith(overrides));

  // -- one row per query-rule threshold ------------------------------------

  interface QueryRow {
    name: ThresholdName;
    rule: QueryRule;
    /** Seeds a crawl in which the rule is silent at the defaults and fires under `raise`. */
    seedQuiet: (crawlId: string) => Promise<void>;
    raise: number;
    /** Seeds a crawl in which the rule fires at the defaults and is silent under `relax`. */
    seedLoud: (crawlId: string) => Promise<void>;
    relax: number;
    /** Where the finding quotes the threshold, when it does. */
    evidence?: string;
  }

  const redirect = (path: string, to: string): Partial<PageRecord> => ({
    fetchClass: "redirect",
    statusCode: 301,
    redirectUrl: url(to),
    redirectUrlNormalised: normalizeUrl(url(to)) ?? url(to),
  });

  async function addChain(crawlId: string, paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length - 1; i++) {
      await addPage(crawlId, paths[i]!, redirect(paths[i]!, paths[i + 1]!));
    }
    await addPage(crawlId, paths[paths.length - 1]!);
  }

  async function addImage(crawlId: string, bytes: number): Promise<void> {
    const pageId = await addPage(crawlId, "/gallery");
    await db.insert(resources).values({
      crawlId,
      url: url("/img/hero.png"),
      kind: "image",
      shareImage: false,
      fetchClass: "ok",
      fetchReason: null,
      statusCode: 200,
      contentType: "image/png",
      bytes,
      bytesSource: "header",
      cacheControl: "public, max-age=3600",
      expires: null,
    });
    await db.insert(pageResources).values({ crawlId, pageId, resourceUrl: url("/img/hero.png") });
  }

  async function addOutlinks(
    crawlId: string,
    count: number,
    kind: "internal" | "external",
  ): Promise<void> {
    const pageId = await addPage(crawlId, "/hub");
    const rows = Array.from({ length: count }, (_, i) => ({
      crawlId,
      sourcePageId: pageId,
      targetUrl: kind === "internal" ? url(`/t/${i}`) : `https://ext${i}.example/`,
      targetPageId: null,
      anchor: "a descriptive anchor",
      ariaLabel: null,
      nameHint: null,
      nameHintSource: null,
      rel: null,
      isInternal: kind === "internal",
      isNofollow: false,
      position: i,
    }));
    await db.insert(links).values(rows);
  }

  const QUERY_ROWS: QueryRow[] = [
    {
      name: "DEEP_DEPTH",
      rule: find(linkGraphRules, "structure.deep-page"),
      seedQuiet: async (c) => void (await addPage(c, "/d", { clickDepth: 4 })),
      raise: 3,
      seedLoud: async (c) => void (await addPage(c, "/d", { clickDepth: 6 })),
      relax: 8,
      evidence: "threshold",
    },
    {
      name: "THIN_WORDS",
      rule: find(contentRules, "content.thin"),
      seedQuiet: async (c) => void (await addPage(c, "/t", { mainWordCount: 200 })),
      raise: 250,
      seedLoud: async (c) => void (await addPage(c, "/t", { mainWordCount: 100 })),
      relax: 50,
      evidence: "threshold",
    },
    {
      name: "SOFT_404_WORDS",
      rule: find(contentRules, "content.soft-404"),
      seedQuiet: async (c) =>
        void (await addPage(c, "/s", { hasSoft404Phrases: true, renderableWordCount: 400 })),
      raise: 500,
      seedLoud: async (c) =>
        void (await addPage(c, "/s", { hasSoft404Phrases: true, renderableWordCount: 200 })),
      relax: 100,
    },
    {
      name: "IMAGE_WEIGHT_WARN",
      rule: find(resourceRules, "images.oversized"),
      seedQuiet: (c) => addImage(c, 50_000),
      raise: 40_000,
      seedLoud: (c) => addImage(c, 150_000),
      relax: 200_000,
      evidence: "threshold",
    },
    {
      name: "CHAIN_HOPS",
      rule: find(redirectRules, "redirect.chain"),
      seedQuiet: (c) => addChain(c, ["/a", "/b"]),
      raise: 1,
      seedLoud: (c) => addChain(c, ["/a", "/b", "/c"]),
      relax: 3,
    },
    {
      name: "HIGH_INTERNAL_OUTLINKS",
      rule: find(linkHygieneRules, "links.high-outlinks"),
      seedQuiet: (c) => addOutlinks(c, 12, "internal"),
      raise: 10,
      seedLoud: (c) => addOutlinks(c, 1001, "internal"),
      relax: 2000,
      evidence: "max",
    },
    {
      name: "HIGH_EXTERNAL_OUTLINKS",
      rule: find(linkHygieneRules, "links.high-outlinks"),
      seedQuiet: (c) => addOutlinks(c, 8, "external"),
      raise: 5,
      seedLoud: (c) => addOutlinks(c, 11, "external"),
      relax: 20,
      evidence: "max",
    },
  ];

  it("covers every overridable threshold a query rule consumes", () => {
    expect(QUERY_ROWS.map((r) => r.name).sort()).toEqual(
      [
        "DEEP_DEPTH", "THIN_WORDS", "SOFT_404_WORDS", "IMAGE_WEIGHT_WARN", "CHAIN_HOPS",
        "HIGH_INTERNAL_OUTLINKS", "HIGH_EXTERNAL_OUTLINKS",
      ].sort(),
    );
    // And with the page rows, every one of the 20 except the ones a rule does
    // not consume: none. (TITLE_*/META_*/H*/URL/SLOW/PX/UNAVAILABLE are the
    // page rows above.)
    expect(QUERY_ROWS.length + PAGE_ROWS.length).toBe(20);
  });

  it.each(QUERY_ROWS.map((r) => [r.name, r] as const))("%s", { timeout: 60_000 }, async (_n, row) => {
    const quiet = await newCrawl();
    await row.seedQuiet(quiet);
    expect(await run(row.rule, quiet, {}), "quiet at defaults").toEqual([]);
    expect(await row.rule.run(db, quiet), "quiet with no context").toEqual([]);
    const raised = await run(row.rule, quiet, { [row.name]: row.raise });
    expect(raised, "fires under the override").toHaveLength(1);
    if (row.evidence !== undefined) {
      expect(raised[0]!.evidence[row.evidence], "evidence quotes the override").toBe(row.raise);
    }

    const loud = await newCrawl();
    await row.seedLoud(loud);
    expect(await run(row.rule, loud, {}), "loud at defaults").toHaveLength(1);
    expect(await run(row.rule, loud, { [row.name]: row.relax }), "silent once relaxed").toEqual([]);
  });

  // -- two runs, two crawls --------------------------------------------------

  /**
   * THE PROPERTY A MODULE-LEVEL THRESHOLD WOULD NOT HAVE (finding-cap.test.ts's
   * concurrency test, one knob over). Two `runRules` calls over two crawls with
   * different stored `TITLE_MAX`, started together, each held open at a query
   * rule until both have arrived: each rule invocation must see its own crawl's
   * threshold, and each crawl's `title.too-long` rows must match it. Without the
   * rendezvous the runs could complete one after the other and a module variable
   * would pass.
   */
  it("keeps two concurrent runs of different crawls on their own thresholds", { timeout: 180_000 }, async () => {
    const a = await newCrawl({ thresholds: { TITLE_MAX: 50 } });
    const b = await newCrawl({ thresholds: { TITLE_MAX: 70 } });
    for (const crawlId of [a, b]) {
      await addPage(crawlId, "/t55", { title: "T".repeat(55) });
      await addPage(crawlId, "/t65", { title: "T".repeat(65) });
      await addPage(crawlId, "/t75", { title: "T".repeat(75) });
    }

    let release!: () => void;
    const bothHere = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const seen = new Map<string, number | undefined>();
    const spy: RuleDefinition<QueryRule> = {
      kind: "query",
      id: "test.threshold-spy",
      checkIds: ["CHECK-01"],
      category: "technical",
      severity: "info",
      title: "Threshold spy",
      explanation: "Records the TITLE_MAX its run was given, so two runs can be compared.",
      howToFix: "Do not ship it.",
      rulesetVersion: RULESET_VERSION,
      columns: [],
      run: async (_db, crawlId, _caps, ctx): Promise<Finding[]> => {
        seen.set(crawlId, ctx?.thresholds.TITLE_MAX);
        waiting += 1;
        if (waiting >= 2) release();
        await bothHere;
        return [];
      },
    };
    const registry = new Registry(syntheticTriage(spy.id));
    registry.register(spy);
    registry.register(find(onPageRules, "title.too-long"));
    const timer = setTimeout(release, 20_000);

    const [ra, rb] = await Promise.all([runRules(db, a, registry), runRules(db, b, registry)]);
    clearTimeout(timer);

    expect(seen.get(a)).toBe(50);
    expect(seen.get(b)).toBe(70);
    expect(ra.byRule["title.too-long"]).toBe(3);
    expect(rb.byRule["title.too-long"]).toBe(1);
    for (const [crawlId, max] of [[a, 50], [b, 70]] as const) {
      const rows = await db
        .select()
        .from(issues)
        .where(and(eq(issues.crawlId, crawlId), eq(issues.ruleId, "title.too-long")));
      expect(rows.length).toBe(crawlId === a ? 3 : 1);
      for (const r of rows) expect((r.details as { max: number }).max).toBe(max);
    }
  });

  it("applies a stored override at the next run and the defaults without one", { timeout: 60_000 }, async () => {
    const crawlId = await newCrawl();
    await addPage(crawlId, "/t55", { title: "T".repeat(55) });
    const registry = new Registry();
    registry.register(find(onPageRules, "title.too-long"));

    expect((await runRules(db, crawlId, registry)).byRule["title.too-long"] ?? 0).toBe(0);
    await db
      .update(crawls)
      .set({ judgement: { thresholds: { TITLE_MAX: 50 } } })
      .where(eq(crawls.id, crawlId));
    expect((await runRules(db, crawlId, registry)).byRule["title.too-long"]).toBe(1);
  });

  // -- site.health ------------------------------------------------------------

  async function healthOf(crawlId: string): Promise<Record<string, unknown>> {
    const rows = await db
      .select()
      .from(metrics)
      .where(and(eq(metrics.crawlId, crawlId), eq(metrics.metricId, "site.health")));
    expect(rows).toHaveLength(1);
    return rows[0]!.value as Record<string, unknown>;
  }

  it("site.health skips findings of disabled rules, which are still stored", { timeout: 60_000 }, async () => {
    const registry = new Registry();
    registry.register(find(onPageRules, "title.too-long"));
    registry.register(find(healthMetrics, "site.health"));

    const enabled = await newCrawl();
    const disabled = await newCrawl({ rules: { "title.too-long": { disabled: true } } });
    for (const crawlId of [enabled, disabled]) {
      // Three judged pages whose only finding is `title.too-long`.
      for (const p of ["/a", "/b", "/c"]) await addPage(crawlId, p, { title: "T".repeat(70) });
    }

    await runRules(db, enabled, registry);
    await runRules(db, disabled, registry);

    // The control: with the rule enabled the three pages are not clean.
    expect(await healthOf(enabled)).toMatchObject({ urlsTotal: 3, urlsClean: 0, urlsWithInfoOnly: 3 });
    // Disabled: counted clean, and the rows are all still in the table.
    expect(await healthOf(disabled)).toMatchObject({ urlsTotal: 3, urlsClean: 3, urlsWithInfoOnly: 0 });
    const stored = await db
      .select()
      .from(issues)
      .where(and(eq(issues.crawlId, disabled), eq(issues.ruleId, "title.too-long")));
    expect(stored).toHaveLength(3);
  });

  it("site.health run directly honours the context's disabled set", { timeout: 60_000 }, async () => {
    const crawlId = await newCrawl();
    const id = await addPage(crawlId, "/a", { title: "T".repeat(70) });
    await db.insert(issues).values({
      crawlId,
      ruleId: "title.too-long",
      pageId: id,
      severity: "info",
      rulesetVersion: "test",
      dedupeKey: url("/a"),
      details: {},
    });
    const health = find(healthMetrics, "site.health");
    const value = (rows: Awaited<ReturnType<typeof health.run>>) => rows[0]!.value;
    expect(value(await health.run(db, crawlId))).toMatchObject({ urlsClean: 0 });
    expect(value(await health.run(db, crawlId, ctxWith({}, ["title.too-long"])))).toMatchObject({
      urlsClean: 1,
    });
    // An unrelated disabled rule changes nothing.
    expect(value(await health.run(db, crawlId, ctxWith({}, ["title.missing"])))).toMatchObject({
      urlsClean: 0,
    });
  });
});

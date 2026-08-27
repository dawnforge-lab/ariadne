import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  crawls,
  hreflang,
  issues,
  metrics,
  pages,
  structuredData,
  urlParams,
} from "../../src/db/schema.js";
import { metricRow } from "../../src/rules/helpers.js";
import { buildRegistry } from "../../src/rules/index.js";
import { PAGE_BATCH, runRules } from "../../src/rules/run.js";
import { Registry, RULESET_VERSION } from "../../src/rules/registry/registry.js";
import type { Metric, MetricRule, PageRecord, PageRule } from "../../src/rules/registry/types.js";
import { mkDiscovery, mkHostProbe } from "./mk-discovery.js";
import { mkPage } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://runner.example";

describe("buildRegistry", () => {
  it("registers every rule of the phase tables exactly once", () => {
    const ids = buildRegistry().all().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("title.missing");
    expect(ids).toContain("http.server-error");
    expect(ids).toContain("hreflang.invalid-code");
    // Phase 2's 28 page and hreflang rules, plus the Phase 3 redirect,
    // link/canonical-target, orphan, hreflang-join, pagination, robots,
    // sitemap, URL-hygiene, host and content query rules.
    expect(ids).toContain("redirect.loop");
    expect(ids).toContain("links.broken-internal");
    expect(ids).toContain("links.orphan");
    expect(ids).toContain("pagination.next-not-linked");
    expect(ids).toContain("robots.blocks-sitemap-urls");
    expect(ids).toContain("sitemap.missing");
    expect(ids).toContain("url.normalisation-variants");
    expect(ids).toContain("host.http-serves-200");
    expect(ids).toContain("content.near-duplicate");
    expect(ids).toContain("schema.product-incomplete");
    // And Phase 4's metric rules.
    expect(ids).toContain("inlinks.distribution");
    expect(ids).toContain("structure.depth-distribution");
    expect(ids).toContain("content.metrics-by-type");
    expect(ids).toContain("content.template-similarity");
    expect(ids).toContain("hreflang.coverage");
    expect(ids).toContain("url.param-volumes");
    expect(ids).toContain("redirect.volume");
    expect(ids).toContain("sitemap.structure");
    expect(ids.length).toBe(74);
  });

  it("registers every kind the runner drives", () => {
    const registry = buildRegistry();
    expect(registry.byKind("page").length).toBeGreaterThan(0);
    expect(registry.byKind("query").length).toBeGreaterThan(0);
    expect(registry.byKind("metric").length).toBeGreaterThan(0);
  });
});

describe("runRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  /**
   * A crawl row that looks like one that ran to completion: a page cap it did
   * not reach, and no frontier rows. `links.orphan` refuses to judge an
   * incomplete crawl and writes a skipped finding instead, so a crawl row
   * without a readable `maxPages` would add that finding to every case below.
   *
   * The discovery evidence is here for the same reason as `maxPages`: the
   * robots and sitemap rules read it, refuse a row that has none, and report
   * a site whose robots.txt declares no sitemap. The default `mkDiscovery` is
   * the healthy site — robots.txt read whole, one declared sitemap, nothing
   * truncated — so those rules stay silent and each assertion below is about
   * the page rule it names.
   *
   * The host probe is here for the third time for the same reason: a null
   * `host_probe_jsonb` means the probe never ran, and `host.probe-skipped`
   * says so on every crawl row that leaves it out. `mkHostProbe` is the site
   * whose spellings all redirect into one canonical host, so the host rules
   * are silent too.
   */
  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 10_000, userAgent: "AriadneBot-test" },
      discovery: mkDiscovery(),
      hostProbe: mkHostProbe(SITE),
      rulesetVersion: "test",
    });
    createdCrawls.push(id);
    return id;
  }

  /**
   * A pages row built from the shared clean defaults, so a row differs from
   * "no rule fires on it" only in the signals this test names.
   *
   * The content fingerprints are per-URL rather than `mkPage`'s shared clean
   * values, and for the same reason `/clean` is the seed: two rows carrying one
   * `content_hash` and one `simhash` ARE duplicates of each other, so the
   * content rules would report the clean page correctly and "a clean page
   * contributes nothing" would stop being true for a reason that has nothing to
   * do with the page. Derived from the URL, so they stay deterministic, and
   * from a hash, so no two of them land within the near-duplicate band.
   */
  function mkRow(crawlId: string, path: string, overrides: Partial<PageRecord> = {}): PageRecord {
    const url = `${SITE}${path}`;
    const digest = createHash("sha256").update(url).digest("hex");
    return mkPage({
      id: `page_${randomUUID()}`,
      crawlId,
      url,
      urlNormalised: url,
      canonicalHtml: url,
      contentHash: digest,
      simhash: BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`)),
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
    // The clean page is the crawl's seed. `links.orphan` reports an indexable
    // page with no inbound links, and a synthetic crawl has no `links` rows at
    // all — so a clean page that was not the seed would fire it, and "a clean
    // page contributes nothing" would stop being true for a reason that has
    // nothing to do with the page.
    const clean = mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" });
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

    // Every written row is stamped with the ruleset that produced it, so a
    // finding read back months later can be traced to the rules of its day.
    for (const r of rows) expect(r.rulesetVersion, r.ruleId).toBe(RULESET_VERSION);

    // Idempotence: a second run adds no rows — the dedupe index absorbs it.
    await runRules(db, crawlId, registry);
    const again = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
    expect(again.length).toBe(rows.length);

    // A clean page contributes nothing.
    expect(rows.every((r) => r.pageId !== clean.id)).toBe(true);
  });

  it("streams past the page batch: every page of a PAGE_BATCH + 1 crawl is scanned once", async () => {
    const crawlId = await newCrawl();
    const total = PAGE_BATCH + 1; // forces the id cursor to iterate a second time
    const rows_ = Array.from({ length: total }, (_, i) =>
      mkRow(crawlId, `/untitled-${String(i).padStart(4, "0")}`, { title: null }),
    );
    // Chunked so one INSERT never approaches Postgres' bind-parameter limit.
    for (let i = 0; i < rows_.length; i += 100) {
      await db.insert(pages).values(rows_.slice(i, i + 100));
    }

    const summary = await runRules(db, crawlId, buildRegistry());
    expect(summary.pagesScanned).toBe(total);
    expect(summary.byRule["title.missing"]).toBe(total);

    const written = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
    expect(written.filter((r) => r.ruleId === "title.missing")).toHaveLength(total);
    // No page is read twice and none is skipped: one row per (rule, dedupe key),
    // and the pages that fired are exactly the pages inserted.
    expect(new Set(written.map((r) => `${r.ruleId}\n${r.dedupeKey}`)).size).toBe(written.length);
    expect(
      new Set(written.filter((r) => r.ruleId === "title.missing").map((r) => r.pageId)),
    ).toEqual(new Set(rows_.map((r) => r.id)));
  });

  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    await db.insert(pages).values([mkRow(other, "/untitled", { title: null })]);
    const mine = await newCrawl();
    // The seed, for the reason given above: an indexable page nothing links to
    // is an orphan, and "a clean crawl produces nothing" has to mean the rules
    // read the right crawl, not that this page is unreachable.
    await db.insert(pages).values([mkRow(mine, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const summary = await runRules(db, mine, buildRegistry());
    expect(summary.pagesScanned).toBe(1);

    // The one finding is about the CRAWL, not about the page: a synthetic crawl
    // stores no `structured_data` rows, and `schema.none-on-site` reports a site
    // that publishes no JSON-LD once, site-scoped. Named exactly rather than
    // tolerated as a count, so a page rule that started firing on the clean page
    // — the thing this test is about — still fails here.
    const written = await db.select().from(issues).where(eq(issues.crawlId, mine));
    expect(written.map((r) => r.ruleId)).toEqual(["schema.none-on-site"]);
    expect(written[0]!.pageId).toBeNull();
    expect(summary.findings).toBe(1);
  });

  // The derivation phase. It is part of the run rather than a step a caller
  // has to remember, so a crawl judged by `runRules` always has a current
  // parameter inventory beside its findings — and the summary says how much was
  // written, because a phase that reported nothing would be a phase nobody
  // would notice had stopped running.
  it("derives the crawl's url_params inventory and field presence, saying how much it wrote", async () => {
    const crawlId = await newCrawl();
    const listing = mkRow(crawlId, "/list?colour=red&utm_source=news", {
      depth: 0,
      discoveredVia: "seed",
    });
    await db.insert(pages).values([
      mkRow(crawlId, "/", { depth: 0, discoveredVia: "seed" }),
      listing,
    ]);
    await db.insert(structuredData).values([
      {
        crawlId,
        pageId: listing.id,
        schemaType: "Product",
        raw: { "@type": "Product", name: "A product with nothing else" },
      },
    ]);

    const summary = await runRules(db, crawlId, buildRegistry());
    expect(summary.derived).toEqual({
      "deriveUrlParams.params": 2,
      "deriveFieldPresence.blocks": 1,
    });

    const rows = await db.select().from(urlParams).where(eq(urlParams.crawlId, crawlId));
    expect(
      Object.fromEntries(rows.map((r) => [r.paramName, r.isTracking])),
    ).toEqual({ colour: false, utm_source: true });

    // The derivation runs BEFORE the query rules, which is what lets
    // `schema.product-incomplete` read a presence blob it did not compute — the
    // ordering the runner's `derivations` list exists to guarantee.
    const blocks = await db
      .select()
      .from(structuredData)
      .where(eq(structuredData.crawlId, crawlId));
    expect(blocks[0]!.fieldPresence).toMatchObject({
      required: { name: true, image: false, offers: false },
    });
    expect(summary.byRule["schema.product-incomplete"]).toBe(1);

    // Re-running the whole runner is safe, inventory included: the derivation
    // rebuilds its rows rather than adding to them.
    const again = await runRules(db, crawlId, buildRegistry());
    expect(again.derived).toEqual(summary.derived);
    expect(await db.select().from(urlParams).where(eq(urlParams.crawlId, crawlId))).toHaveLength(
      rows.length,
    );
  });

  // Planner statistics, and why this is a test rather than a comment: the
  // Phase 4 gate disclosed that the rules run had usable statistics only
  // because autovacuum happened to analyze mid-crawl. Nothing about that is
  // observable from a run's output — a planner working from "0 rows" produces
  // the same findings, slowly — so the only way the ANALYZE can be known to
  // still be there is to watch Postgres record it.
  //
  // The exclusion of `metrics` from the list is deliberate (no rule reads it)
  // but deliberately NOT asserted here: autovacuum may analyze any table at
  // any moment, so "this table was not analyzed" is not a property a test can
  // hold without becoming flaky. The runner's own comment carries that half.
  it("analyzes the tables the rules read before it reads them", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const analyzedAt = async (): Promise<Record<string, number>> => {
      const { rows } = await db.execute<{ relname: string; last_analyze: string | null }>(
        sql`select relname, last_analyze from pg_stat_user_tables
            where relname in ('pages', 'links', 'sitemap_urls', 'url_params', 'hreflang', 'issues')`,
      );
      return Object.fromEntries(
        rows.map((r) => [r.relname, r.last_analyze === null ? 0 : Date.parse(r.last_analyze)]),
      );
    };

    const before = await analyzedAt();
    await runRules(db, crawlId, buildRegistry());
    const after = await analyzedAt();

    for (const table of ["pages", "links", "sitemap_urls", "url_params", "hreflang", "issues"]) {
      expect(after[table], `${table} has no pg_stat row`).toBeDefined();
      expect(
        after[table]! > (before[table] ?? 0),
        `${table} was not analyzed by the run`,
      ).toBe(true);
    }
  });

  // A crawl id nothing knows produces no pages, which is indistinguishable
  // from a crawl that found nothing: the run would "succeed" over an empty
  // table and report zero findings. Refuse it instead (hard rule 7).
  it("refuses an unknown crawl id, naming it", async () => {
    const missing = `crawl_${randomUUID()}`;
    await expect(runRules(db, missing, buildRegistry())).rejects.toThrow(missing);
  });

  it("aborts loudly, naming the rule, when a rule throws", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean")]);

    const exploding: PageRule = {
      kind: "page",
      id: "test.exploding",
      checkIds: ["CHECK-01"],
      category: "technical",
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

  /**
   * A metric rule built for a test: the registry metadata a rule cannot ship
   * without, wrapped around a body the test controls. Real metric rules exist
   * now (the link-graph four), but what is under test here is the PHASE — the
   * delete-then-insert, the validation, the abort — so it is driven through
   * stubs whose rows the test chooses, not through a rule with its own SQL.
   */
  function mkMetricRule(id: string, run: MetricRule["run"]): MetricRule {
    return {
      kind: "metric",
      id,
      checkIds: ["CHECK-01"],
      category: "technical",
      severity: "info",
      title: `Test metric ${id}`,
      explanation: "A stub metric rule, registered so the runner's metric phase can be observed.",
      howToFix: "A metric is a number, not a fault — there is nothing to fix.",
      rulesetVersion: RULESET_VERSION,
      run,
    };
  }

  /** The crawl's metric rows, keyed by their composite primary key. */
  async function readMetrics(crawlId: string): Promise<Record<string, unknown>> {
    const rows = await db.select().from(metrics).where(eq(metrics.crawlId, crawlId));
    return Object.fromEntries(
      rows.map((r) => [`${r.metricId}|${r.scope}|${r.scopeValue}`, r.value]),
    );
  }

  // The metrics-vs-issues asymmetry, which is the whole reason the metric phase
  // deletes before it inserts. An issue is evidence: it happened, and a re-run
  // adds nothing (the dedupe index absorbs it). A metric is recomputed state:
  // the crawl's current answer, and last run's answer is not evidence of
  // anything once this run has produced its own. A cohort that stopped existing
  // must therefore stop having a row — an upsert alone could refresh the
  // survivors but never remove the departed.
  it("writes a metric rule's rows, refreshes them, and drops a cohort that stopped being emitted", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    let emitted: Metric[] = [
      metricRow({ id: "test.cohorts" }, { scope: "site", value: { pages: 2 } }),
      metricRow(
        { id: "test.cohorts" },
        { scope: "page_type", scopeValue: "product", value: { pages: 1 } },
      ),
      metricRow(
        { id: "test.cohorts" },
        { scope: "page_type", scopeValue: "blog", value: { pages: 1 } },
      ),
    ];
    const registry = new Registry();
    registry.register(mkMetricRule("test.cohorts", async () => emitted));

    const first = await runRules(db, crawlId, registry);
    expect(first.metrics).toBe(3);
    expect(first.byMetric).toEqual({ "test.cohorts": 3 });
    expect(await readMetrics(crawlId)).toEqual({
      "test.cohorts|site|": { pages: 2 },
      "test.cohorts|page_type|product": { pages: 1 },
      "test.cohorts|page_type|blog": { pages: 1 },
    });

    // A re-run over the same crawl: the site row's value is replaced rather
    // than kept or duplicated, and `blog` — a cohort this run does not emit —
    // is gone rather than left behind as a claim about pages nothing counted.
    emitted = [
      metricRow({ id: "test.cohorts" }, { scope: "site", value: { pages: 5 } }),
      metricRow(
        { id: "test.cohorts" },
        { scope: "page_type", scopeValue: "product", value: { pages: 5 } },
      ),
    ];
    const second = await runRules(db, crawlId, registry);
    expect(second.metrics).toBe(2);
    expect(second.byMetric).toEqual({ "test.cohorts": 2 });
    expect(await readMetrics(crawlId)).toEqual({
      "test.cohorts|site|": { pages: 5 },
      "test.cohorts|page_type|product": { pages: 5 },
    });

    // A rule that emits nothing at all still clears its own rows — and the
    // summary names it with a zero, so "the rule ran and found nothing" is
    // distinguishable from "the rule never ran".
    emitted = [];
    const third = await runRules(db, crawlId, registry);
    expect(third.metrics).toBe(0);
    expect(third.byMetric).toEqual({ "test.cohorts": 0 });
    expect(await readMetrics(crawlId)).toEqual({});
  });

  // The phase order: page rules, derivations, query rules, then metrics. A
  // metric summarises what the run found, so it has to run last — one that ran
  // before the query rules would report a crawl's issue counts as they stood
  // halfway through judging it.
  it("runs the metric phase after the issue-writing phases", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([
      mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" }),
      mkRow(crawlId, "/untitled", { title: null }),
    ]);

    const registry = buildRegistry();
    registry.register(
      mkMetricRule("test.issue-count", async (dbArg, id) => {
        const rows = await dbArg.select().from(issues).where(eq(issues.crawlId, id));
        return [metricRow({ id: "test.issue-count" }, { scope: "site", value: { n: rows.length } })];
      }),
    );

    const summary = await runRules(db, crawlId, registry);
    const written = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
    // A page rule and a QUERY rule both fired, so the count the metric read is
    // one the query phase had already contributed to — which is what makes this
    // an ordering assertion rather than a count of page findings.
    expect(summary.byRule["title.missing"]).toBe(1);
    expect(summary.byRule["links.orphan"]).toBeGreaterThan(0);
    expect(written.length).toBeGreaterThan(0);
    expect(summary.findings).toBe(written.length);
    // The stub's row, asserted on its own key: `buildRegistry()` now ships
    // real metric rules too, and their rows are in this map beside it. What
    // this test is about is the ORDER — the stub counted the issues AFTER the
    // page and query phases had written them.
    expect((await readMetrics(crawlId))["test.issue-count|site|"]).toEqual({
      n: written.length,
    });
  });

  it("aborts loudly naming the metric rule that threw, keeping earlier rules' rows", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const registry = new Registry();
    registry.register(
      mkMetricRule("test.first-metric", async () => [
        metricRow({ id: "test.first-metric" }, { scope: "site", value: { pages: 1 } }),
      ]),
    );
    registry.register(
      mkMetricRule("test.exploding-metric", () => {
        throw new Error("boom");
      }),
    );

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/test\.exploding-metric/);

    // Each metric rule owns its own transaction, so the rule that finished
    // before the failure keeps what it wrote: its rows are this crawl's current
    // answer for that metric, and rolling them back would replace a true number
    // with a missing one because a different rule is broken.
    expect(await readMetrics(crawlId)).toEqual({ "test.first-metric|site|": { pages: 1 } });
  });

  // A cohort row is "the answer for THIS group of pages". Without a name, the
  // group is unidentifiable — and the empty string is already taken: it is what
  // a site-scoped row stores. Two nameless cohorts would collide on the primary
  // key with each other and with the site row.
  it("refuses a page_type row with no scope value, naming the rule", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const registry = new Registry();
    registry.register(
      mkMetricRule("test.nameless-cohort", async () => [
        { metricId: "test.nameless-cohort", scope: "page_type", scopeValue: "", value: { n: 1 } },
      ]),
    );

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/test\.nameless-cohort/);
    // Validated before anything is written: the rule's whole set is refused,
    // not the bad row alone.
    expect(await readMetrics(crawlId)).toEqual({});
  });

  // The same refusal for the scope that is not a cohort of pages: a
  // `sitemap_doc` row names one sitemap document, and a nameless one identifies
  // no document while colliding with the site row's key. Asserted separately
  // from the `page_type` case because the check is what makes a NEW scope safe
  // to add — a scope the runner validated only by name would accept the
  // nameless row it is there to refuse.
  it("refuses a sitemap_doc row with no scope value, and stores a named one", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const nameless = new Registry();
    nameless.register(
      mkMetricRule("test.nameless-doc", async () => [
        { metricId: "test.nameless-doc", scope: "sitemap_doc", scopeValue: "", value: { n: 1 } },
      ]),
    );
    await expect(runRules(db, crawlId, nameless)).rejects.toThrow(/test\.nameless-doc/);
    expect(await readMetrics(crawlId)).toEqual({});

    // And the row the scope exists for, through the runner and back out of the
    // table: a document URL in `scope_value`, where a `page_type` value would
    // have been a template name.
    const named = new Registry();
    named.register(
      mkMetricRule("test.docs", async () => [
        metricRow({ id: "test.docs" }, { scope: "site", value: { docs: 1 } }),
        metricRow(
          { id: "test.docs" },
          {
            scope: "sitemap_doc",
            scopeValue: "https://example.com/sitemap-products.xml",
            value: { urls: 3 },
          },
        ),
      ]),
    );
    expect((await runRules(db, crawlId, named)).byMetric).toEqual({ "test.docs": 2 });
    expect(await readMetrics(crawlId)).toEqual({
      "test.docs|site|": { docs: 1 },
      "test.docs|sitemap_doc|https://example.com/sitemap-products.xml": { urls: 3 },
    });
  });

  // The symmetric defect: one site per crawl means a site row that names
  // something keys a SECOND site row, and the crawl answers the same question
  // twice with nothing to say which answer is the site's. `metricRow`'s
  // discriminated union makes it unrepresentable; this is the JS boundary.
  it("refuses a site row that carries a scope value, naming the rule", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const registry = new Registry();
    registry.register(
      mkMetricRule("test.named-site", async () => [
        { metricId: "test.named-site", scope: "site", scopeValue: "product", value: { n: 1 } },
      ]),
    );

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/test\.named-site/);
    expect(await readMetrics(crawlId)).toEqual({});
  });

  // `metricRow` makes this unreachable from a rule that uses it; the runner
  // checks anyway, because the delete that keeps metrics from going stale is
  // `metric_id = <rule id>` — a row filed under another id would never be
  // recomputed and never removed.
  it("refuses a row filed under a metric id that is not the rule's own", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const registry = new Registry();
    registry.register(
      mkMetricRule("test.mislabelled", async () => [
        { metricId: "test.some-other-metric", scope: "site", scopeValue: "", value: { n: 1 } },
      ]),
    );

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/test\.mislabelled/);
    expect(await readMetrics(crawlId)).toEqual({});
  });

  // Where the transactional guarantee actually lives. The delete and the
  // inserts share one transaction precisely so a failed write cannot leave the
  // crawl with the previous answer erased and no new one — which is the state
  // "delete, then fail" would produce.
  it("rolls the delete back when the insert fails, keeping the previous answer", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    let emitted: Metric[] = [
      metricRow({ id: "test.rollback" }, { scope: "site", value: { pages: 1 } }),
    ];
    const registry = new Registry();
    registry.register(mkMetricRule("test.rollback", async () => emitted));

    await runRules(db, crawlId, registry);
    expect(await readMetrics(crawlId)).toEqual({ "test.rollback|site|": { pages: 1 } });

    // Two answers for one cohort. The composite primary key refuses the second
    // rather than letting one of them silently win — a rule that computed a
    // cohort twice is a defect, and the defect is what must surface.
    emitted = [
      metricRow(
        { id: "test.rollback" },
        { scope: "page_type", scopeValue: "product", value: { pages: 2 } },
      ),
      metricRow(
        { id: "test.rollback" },
        { scope: "page_type", scopeValue: "product", value: { pages: 3 } },
      ),
    ];
    await expect(runRules(db, crawlId, registry)).rejects.toThrow(
      /rule 'test\.rollback' failed to write its 2 metric rows/,
    );

    // The delete rolled back with the insert: the crawl still holds the answer
    // the previous run computed, not an empty space where a metric used to be.
    expect(await readMetrics(crawlId)).toEqual({ "test.rollback|site|": { pages: 1 } });
  });

  // A rule that returns a non-array is a rule defect, and it has to fail the
  // way every other rule defect fails — named. Left unchecked it would surface
  // as a bare "is not iterable" TypeError naming nothing.
  it("refuses a metric rule that returns something other than an array, naming it", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const registry = new Registry();
    registry.register(
      mkMetricRule("test.returns-null", (async () => null) as unknown as MetricRule["run"]),
    );

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/test\.returns-null/);
    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/null rather than an array/);
    expect(await readMetrics(crawlId)).toEqual({});
  });

  // A registry with no metric rules still reports the phase, so a run's summary
  // has the same shape whether or not any metric ran.
  //
  // Built by SUBTRACTION from the shipped ruleset, because that ruleset now
  // registers metric rules: the case this asserts is a registry someone
  // assembles without them, not the engine's own.
  it("reports an empty metric phase when no metric rule is registered", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean", { depth: 0, discoveredVia: "seed" })]);

    const noMetrics = new Registry();
    for (const rule of buildRegistry().all()) {
      if (rule.kind !== "metric") noMetrics.register(rule);
    }
    expect(noMetrics.byKind("metric")).toHaveLength(0);

    const summary = await runRules(db, crawlId, noMetrics);
    expect(summary.metrics).toBe(0);
    expect(summary.byMetric).toEqual({});
  });
});

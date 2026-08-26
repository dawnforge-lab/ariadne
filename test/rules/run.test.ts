import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, issues, pages, structuredData, urlParams } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import { PAGE_BATCH, runRules } from "../../src/rules/run.js";
import { Registry, RULESET_VERSION } from "../../src/rules/registry/registry.js";
import type { MetricRule, PageRecord, PageRule } from "../../src/rules/registry/types.js";
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
    expect(ids.length).toBe(64);
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

  it("refuses to run a registry containing a metric rule", async () => {
    const crawlId = await newCrawl();
    await db.insert(pages).values([mkRow(crawlId, "/clean")]);

    // Metric rules are a registry kind the runner has no loop for. Running the
    // registry anyway would quietly skip it, so the runner must refuse.
    const metric: MetricRule = {
      kind: "metric",
      id: "test.metric",
      checkIds: ["CHECK-01"],
      category: "technical",
      severity: "info",
      title: "A metric rule the runner cannot drive",
      explanation: "A stub metric rule, registered only to prove the runner rejects it.",
      howToFix: "Extend the runner.",
      rulesetVersion: RULESET_VERSION,
      run: async () => [],
    };
    const registry = new Registry();
    registry.register(metric);

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(
      "runRules does not drive metric rules yet — extend the runner before registering metric rules",
    );
  });
});

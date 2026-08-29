/**
 * The link-graph rules, against a real database.
 *
 * Rows are inserted directly (the link-targets pattern): what is under test is
 * what the rules make of the link graph, the frontier and the crawl row the
 * crawler left behind, not the crawling.
 *
 * The gate is as much the subject as the finding. `links.orphan` is the one
 * rule in the ruleset whose verdict is only meaningful over a COMPLETE crawl —
 * "nothing links to this page" and "we never fetched the page that links to it"
 * look identical from the database — so half these tests are about the crawl
 * refusing to answer, loudly, rather than about orphans.
 *
 * `structure.deep-page` lives here too, and its suite runs the REAL `click_depth`
 * derivation over a graph built in the test rather than writing the column by
 * hand: the number the rule reads is the number a breadth-first search over
 * `links` produced, which is the whole of what moving the rule off discovery
 * depth was for.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, links, pages, sitemapUrls } from "../../src/db/schema.js";
import { deriveClickDepth } from "../../src/rules/derive/click-depth.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { DEEP_DEPTH, linkGraphRules } from "../../src/rules/query/link-graph.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { normalised, writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://orphans.example";
const MAX_PAGES = 500;

const byId = new Map(linkGraphRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in linkGraphRules`);
  return r;
}

describe("linkGraphRules metadata", () => {
  // Two ids for one check, plus the depth rule that reads the same graph. Copy
  // is looked up by rule id, so the finding that says the check could not run
  // cannot share an id with the finding that says a page has no inbound links —
  // it would be rendered under that page's title.
  it("defines the orphan rule, its skipped twin and the deep-page rule", () => {
    expect(linkGraphRules.map((r) => r.id).sort()).toEqual([
      "links.orphan",
      "links.orphan-skipped",
      "structure.deep-page",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(linkGraphRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "links.orphan": [["CHECK-32"], "warning", "links"],
      // Info: a statement about the crawl, not a fault found on the site.
      "links.orphan-skipped": [["CHECK-32"], "info", "links"],
      // Moved from `technicalRules` in Phase 9, carrying its id, its check, its
      // severity and its category unchanged: the same rule, reading the column
      // that means what its copy always claimed.
      "structure.deep-page": [["CHECK-31"], "info", "technical"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of linkGraphRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    // The whole point of the split: the two findings do not share client-facing
    // copy.
    expect(titles.size).toBe(linkGraphRules.length);
  });
});

let db: Db;
const createdCrawls: string[] = [];

interface PageSpec extends IndexabilitySpec {
  path: string;
  depth?: number;
  discoveredVia?: string;
  /**
   * `pages.click_depth` as stored, for the cases that are about what the RULE
   * makes of the column rather than about the search that fills it. Absent
   * leaves the column null — which is what a crawl looks like before the
   * derivation runs, and what an unreachable page looks like after it.
   */
  clickDepth?: number;
}

/**
 * A crawl row that looks finished: a page cap the crawl did not reach, and
 * no frontier rows at all. The gate tests are the ones that make it look
 * unfinished, one condition at a time.
 */
async function newCrawl(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `crawl_${randomUUID()}`;
  await db.insert(crawls).values({
    id,
    siteUrl: SITE,
    config: { maxPages: MAX_PAGES },
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: 3,
    ...overrides,
  });
  createdCrawls.push(id);
  return id;
}

async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
  const rows = specs.map((s) => ({
    id: `page_${randomUUID()}`,
    crawlId,
    url: `${SITE}${s.path}`,
    urlNormalised: `${SITE}${s.path}`.toLowerCase().replace(/\/$/, ""),
    fetchClass: s.fetchClass ?? "ok",
    statusCode: s.statusCode === undefined ? 200 : s.statusCode,
    isIndexable: writerIndexable(s),
    robotsMeta: s.robotsMeta ?? null,
    xRobotsTag: s.xRobotsTag ?? null,
    depth: s.depth ?? 1,
    clickDepth: s.clickDepth ?? null,
    discoveredVia: s.discoveredVia ?? "link",
  }));
  await db.insert(pages).values(rows);
  return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
}

async function addLink(
  crawlId: string,
  fromId: string,
  targetPath: string,
  isInternal = true,
): Promise<void> {
  await db.insert(links).values({
    crawlId,
    sourcePageId: fromId,
    targetUrl: `${SITE}${targetPath}`,
    targetPageId: null,
    anchor: "read this",
    rel: null,
    isInternal,
    isNofollow: false,
    position: 0,
  });
}

const url = (path: string): string => `${SITE}${path}`;

/** The seed row every crawl has: depth 0, discovered as the seed. */
const SEED: PageSpec = { path: "/", depth: 0, discoveredVia: "seed" };

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
});

describe("links.orphan against the database", () => {
  async function orphans(crawlId: string): Promise<Finding[]> {
    return rule("links.orphan").run(db, crawlId);
  }

  async function skips(crawlId: string): Promise<Finding[]> {
    return rule("links.orphan-skipped").run(db, crawlId);
  }

  it("is silent on a complete crawl where every page has an inbound link", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [SEED, { path: "/a" }, { path: "/b" }]);
    await addLink(crawlId, ids.get("/")!, "/a");
    await addLink(crawlId, ids.get("/a")!, "/b");

    expect(await orphans(crawlId)).toHaveLength(0);
    // And the check ran: nothing was skipped.
    expect(await skips(crawlId)).toHaveLength(0);
  });

  it("reports an indexable 200 page nothing links to, with its discovery evidence", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [SEED, { path: "/linked" }, { path: "/lonely" }]);
    await addLink(crawlId, ids.get("/")!, "/linked");

    const found = await orphans(crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "links.orphan",
      severity: "warning",
      pageId: ids.get("/lonely"),
      pageUrl: url("/lonely"),
      dedupeKey: url("/lonely"),
    });
    expect(found[0]!.evidence).toEqual({
      inSitemap: false,
      discoveredVia: "link",
    });
  });

  // The seed is where the crawl started. Nothing on the site has to link to it
  // for it to be reachable, and reporting the homepage as an orphan on every
  // crawl would be the always-fires twin of a rule that always passes.
  it("never reports the crawl seed", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [SEED]);

    expect(await orphans(crawlId)).toHaveLength(0);
  });

  // A page listed in the sitemap and linked from nowhere IS the finding — the
  // sitemap is how a crawler found it, not how a reader would. `inSitemap`
  // says which kind of orphan it is rather than excusing it.
  it("reports a sitemap-only page and says so in the evidence", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      SEED,
      { path: "/from-sitemap", discoveredVia: "sitemap" },
    ]);
    await db.insert(sitemapUrls).values({
      crawlId,
      url: url("/from-sitemap"),
      urlNormalised: normalised(url("/from-sitemap")),
      sitemapSource: `${SITE}/sitemap.xml`,
      lastmod: null,
    });

    const found = await orphans(crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.pageUrl).toBe(url("/from-sitemap"));
    expect(found[0]!.evidence).toEqual({ inSitemap: true, discoveredVia: "sitemap" });
  });

  // A page linking to itself — a logo linking home, a self-referential
  // breadcrumb, a "back to top" rewritten to the canonical URL — would satisfy
  // its own inbound-link test and disappear from this rule. It is still an
  // orphan: nothing ELSE on the site can reach it.
  it("still reports a page whose only inbound link is its own", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      SEED,
      { path: "/from-sitemap", discoveredVia: "sitemap" },
    ]);
    await db.insert(sitemapUrls).values({
      crawlId,
      url: url("/from-sitemap"),
      urlNormalised: normalised(url("/from-sitemap")),
      sitemapSource: `${SITE}/sitemap.xml`,
      lastmod: null,
    });
    await addLink(crawlId, ids.get("/from-sitemap")!, "/from-sitemap");

    const found = await orphans(crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/from-sitemap")]);
  });

  // `inSitemap` reads `sitemap_urls.url_normalised`, so a crawl whose sitemap
  // rows predate that column would label every orphan `inSitemap: false` — a
  // quiet falsehood inside the evidence of a finding that still fires. Refused
  // instead, by the same gate the sitemap rules open with.
  it("refuses a crawl whose sitemap rows predate url_normalised", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [SEED, { path: "/from-sitemap", discoveredVia: "sitemap" }]);
    // The shape migration 0006 left behind: published spelling, column default.
    await db.insert(sitemapUrls).values({
      crawlId,
      url: url("/from-sitemap"),
      sitemapSource: `${SITE}/sitemap.xml`,
      lastmod: null,
    });

    await expect(orphans(crawlId)).rejects.toThrow(/no normalised spelling.*Re-crawl the site/s);
    await expect(orphans(crawlId)).rejects.toThrow(crawlId);
  });

  it("says nothing about pages that are not indexable 200s", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      SEED,
      { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      { path: "/moved", fetchClass: "redirect", statusCode: 301 },
      { path: "/boom", fetchClass: "server_error", statusCode: 503 },
      { path: "/asset.pdf", fetchClass: "non_html" },
      { path: "/noindexed", robotsMeta: "noindex" },
    ]);

    expect(await orphans(crawlId)).toHaveLength(0);
  });

  // The link rows are what the rule joins on, and `target_url` is the same
  // `normalizeUrl` output `pages.url` is — so a link to the page counts however
  // it was flagged, and a link to a different URL does not.
  it("counts any inbound link row, and only one that names the page's URL", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      SEED,
      { path: "/pointed-at" },
      { path: "/near-miss" },
    ]);
    await addLink(crawlId, ids.get("/")!, "/pointed-at");
    await addLink(crawlId, ids.get("/")!, "/near-miss-typo");

    const found = await orphans(crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/near-miss")]);
  });

  // A site whose navigation this crawl cannot follow — JavaScript menus, or a
  // large sitemap linked from nowhere — orphans a page per page, so the rule
  // is capped like every other URL-scoped rule rather than mirroring the site
  // into the findings table.
  it("caps the findings and says so on the last one", async () => {
    const crawlId = await newCrawl();
    const total = URL_FINDING_CAP + 1;
    const lonely = Array.from({ length: total }, (_, i) => `/lonely-${String(i).padStart(4, "0")}`);
    await addPages(crawlId, [SEED, ...lonely.map((path) => ({ path }))]);

    const found = await orphans(crawlId);
    expect(found).toHaveLength(URL_FINDING_CAP);
    // Ordered by URL, so the cap takes a deterministic slice.
    expect(found.map((f) => f.pageUrl)).toEqual(lonely.slice(0, URL_FINDING_CAP).map(url));
    // The count is exact: the cap bounds what is listed, never what is known.
    expect(found[found.length - 1]!.evidence).toMatchObject({
      truncated: { reported: URL_FINDING_CAP, total },
    });
    expect(found[0]!.evidence).not.toHaveProperty("truncated");
  });

  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    await addPages(other, [SEED, { path: "/lonely" }]);

    const mine = await newCrawl();
    const mineIds = await addPages(mine, [SEED, { path: "/linked" }]);
    await addLink(mine, mineIds.get("/")!, "/linked");

    expect(await orphans(mine)).toHaveLength(0);
    expect(await orphans(other)).toHaveLength(1);
  });

  describe("the completeness gate", () => {
    /**
     * The gate's whole point: the same page set that produces an orphan finding
     * on a complete crawl must produce the skipped finding — and no orphan
     * findings at all — on an incomplete one.
     */
    async function withAnOrphan(crawlId: string): Promise<void> {
      await addPages(crawlId, [SEED, { path: "/lonely" }]);
    }

    /**
     * A gated crawl: the skipped rule writes exactly one site-scoped finding
     * naming the reason, and the orphan rule writes nothing at all. Both halves
     * are asserted every time — a skip that did not silence the orphan check
     * would report the crawl's blind spot as the site's fault anyway.
     */
    async function expectGated(crawlId: string, matching: RegExp): Promise<Finding> {
      const found = await skips(crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "links.orphan-skipped",
        // Info, not warning: it is a statement about the crawl, not a fault
        // found on the site.
        severity: "info",
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
      });
      expect(String(found[0]!.evidence.skipped)).toMatch(matching);
      expect(await orphans(crawlId), "the orphan check must not run when gated").toHaveLength(0);
      return found[0]!;
    }

    it("skips, loudly, when the frontier still holds pending URLs", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values({
        crawlId,
        url: url("/never-fetched"),
        state: "pending",
        depth: 1,
        discoveredVia: "link",
      });

      const found = await expectGated(crawlId, /pending/i);
      expect(found.evidence).toMatchObject({ pending: 1, leased: 0, failed: 0 });
    });

    // A lease outstanding when the crawl stopped is a URL nobody finished:
    // the same blind spot as a pending one, and silently treating it as done
    // would be the fallback this codebase does not do.
    it("skips when the frontier holds a lease nobody released", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values({
        crawlId,
        url: url("/in-flight"),
        state: "leased",
        depth: 1,
        discoveredVia: "link",
      });

      await expectGated(crawlId, /leased/i);
    });

    // A failed URL is a BOUNDED, countable blind spot, unlike a queue that
    // never drained. Muting CHECK-32 for the whole site because one URL timed
    // out would hide every real orphan behind one fetch failure, so the check
    // runs and each finding carries the count.
    it("runs the check when the frontier drained but some URLs failed, with a caveat", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values([
        {
          crawlId,
          url: url("/gave-up"),
          state: "failed",
          depth: 1,
          discoveredVia: "link",
        },
        {
          crawlId,
          url: url("/also-gave-up"),
          state: "failed",
          depth: 1,
          discoveredVia: "link",
        },
      ]);

      expect(await skips(crawlId)).toHaveLength(0);
      const found = await orphans(crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("warning");
      expect(found[0]!.evidence).toEqual({
        inSitemap: false,
        discoveredVia: "link",
        caveat: { failedPages: 2 },
      });
    });

    it("does not skip, and adds no caveat, on a frontier whose rows are all done", async () => {
      const crawlId = await newCrawl();
      await withAnOrphan(crawlId);
      await db.insert(frontier).values({
        crawlId,
        url: url("/lonely"),
        state: "done",
        depth: 1,
        discoveredVia: "link",
      });

      expect(await skips(crawlId)).toHaveLength(0);
      const found = await orphans(crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("warning");
      expect(found[0]!.evidence).not.toHaveProperty("caveat");
    });

    it("skips when the crawl stopped at its page cap", async () => {
      const crawlId = await newCrawl({ pagesCrawled: MAX_PAGES });
      await withAnOrphan(crawlId);

      const found = await expectGated(crawlId, new RegExp(String(MAX_PAGES)));
      expect(found.evidence).toMatchObject({
        pagesCrawled: MAX_PAGES,
        maxPages: MAX_PAGES,
      });
    });

    // Without a page cap on the crawl row there is no way to know whether the
    // crawl ran to completion or stopped early, and assuming it completed
    // would be a guess dressed up as a finding.
    it("skips when the crawl config records no page cap", async () => {
      const crawlId = await newCrawl({ config: {} });
      await withAnOrphan(crawlId);

      await expectGated(crawlId, /maxPages/);
    });

    // Every rule in the file, the depth rule included: a crawl id nothing knows
    // must not read as a site with no orphans and no buried pages.
    it("every link-graph rule throws, naming the crawl, when there is no crawl row", async () => {
      const missing = `crawl_${randomUUID()}`;
      for (const r of linkGraphRules) {
        await expect(r.run(db, missing), r.id).rejects.toThrow(missing);
      }
    });
  });
});

/**
 * `structure.deep-page`, against the column that means what its copy claims.
 *
 * The graph is built and then walked by the REAL derivation (`deriveClickDepth`)
 * in every case where the number under test is a click path. Writing
 * `click_depth` by hand would test the rule's SQL against a number nothing in
 * the engine produces; running the search tests the seam the Phase 8 gate found
 * broken — a rule reading discovery depth on a site whose sitemap made discovery
 * depth meaningless.
 *
 * The two hand-written cases say so in their names: they are about what the rule
 * makes of a column already filled in (indexability, the cap), not about the
 * search.
 */
describe("structure.deep-page against the database", () => {
  async function deep(crawlId: string): Promise<Finding[]> {
    return rule("structure.deep-page").run(db, crawlId);
  }

  /** `click_depth` as the derivation left it, for one path. */
  async function clickDepthOf(crawlId: string, path: string): Promise<number | null> {
    const rows = await db
      .select({ clickDepth: pages.clickDepth })
      .from(pages)
      .where(and(eq(pages.crawlId, crawlId), eq(pages.url, url(path))));
    const row = rows[0];
    if (row === undefined) throw new Error(`no page row for ${path}`);
    return row.clickDepth;
  }

  /**
   * A chain the seed links into: `/<prefix>1` … `/<prefix>N`, each rung linking
   * only the next one, so a rung's click depth is its number.
   */
  async function addChain(
    crawlId: string,
    prefix: string,
    length: number,
    spec: Omit<PageSpec, "path"> = {},
  ): Promise<string[]> {
    const paths = Array.from({ length }, (_, i) => `/${prefix}${i + 1}`);
    const ids = await addPages(crawlId, [SEED, ...paths.map((path) => ({ path, ...spec }))]);
    await addLink(crawlId, ids.get("/")!, paths[0]!);
    for (let i = 0; i + 1 < paths.length; i += 1) {
      await addLink(crawlId, ids.get(paths[i]!)!, paths[i + 1]!);
    }
    return paths;
  }

  it("fires on the rung the link search puts past the threshold, and not on the one at it", async () => {
    const crawlId = await newCrawl();
    const paths = await addChain(crawlId, "c", DEEP_DEPTH + 1);
    const derived = await deriveClickDepth(db, crawlId);
    // The search reached the last rung: the silence below is the threshold, not
    // a chain the derivation failed to walk.
    expect(derived.maxDepth).toBe(DEEP_DEPTH + 1);
    expect(await clickDepthOf(crawlId, `/c${DEEP_DEPTH}`)).toBe(DEEP_DEPTH);

    const found = await deep(crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url(`/c${DEEP_DEPTH + 1}`)]);
    expect(found[0]!).toMatchObject({
      ruleId: "structure.deep-page",
      severity: "info",
      pageUrl: url(paths[DEEP_DEPTH]!),
      dedupeKey: url(paths[DEEP_DEPTH]!),
    });
    expect(found[0]!.pageId).toBeTruthy();
    // The evidence names the column it read. `depth` was the old spelling and
    // the old number; nothing may report the two under one key.
    expect(found[0]!.evidence).toEqual({ clickDepth: DEEP_DEPTH + 1, threshold: DEEP_DEPTH });
  });

  // THE CASE THAT KEPT THIS RULE SILENT THROUGH TWO REAL AUDITS. Every sitemap
  // entry is enqueued as a seed, so a page the sitemap lists arrives in `pages`
  // at discovery depth 0 or 1 however buried it is — and the old page rule,
  // reading `depth`, said nothing about 356 such pages on lavishalice.
  it("fires on a sitemap-discovered page whose discovery depth is shallow and click path long", async () => {
    const crawlId = await newCrawl();
    const paths = await addChain(crawlId, "s", DEEP_DEPTH + 2, {
      depth: 1,
      discoveredVia: "sitemap",
    });
    await deriveClickDepth(db, crawlId);

    const buried = paths.slice(DEEP_DEPTH);
    const found = await deep(crawlId);
    // Deepest first, so the worst page is the one an action plan reads first.
    expect(found.map((f) => f.pageUrl)).toEqual([...buried].reverse().map(url));
    expect(found.map((f) => f.evidence)).toEqual([
      { clickDepth: DEEP_DEPTH + 2, threshold: DEEP_DEPTH },
      { clickDepth: DEEP_DEPTH + 1, threshold: DEEP_DEPTH },
    ]);

    // And the reading the rule used to take says nothing at all: every one of
    // these pages is at discovery depth 1.
    const discovered = await db
      .select({ depth: pages.depth, url: pages.url })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    expect(discovered.filter((r) => r.url !== url("/")).map((r) => r.depth)).toEqual(
      paths.map(() => 1),
    );
  });

  // A page no chain of internal links reaches is `links.orphan`'s finding, and
  // reporting the same cause under a second rule is the consolidation defect the
  // action-plan skill exists to undo. Null is excluded, never read as infinitely
  // deep.
  it("says nothing about a page the link graph never reaches — that is the orphan's finding", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [SEED, { path: "/island", discoveredVia: "sitemap" }]);
    await db.insert(sitemapUrls).values({
      crawlId,
      url: url("/island"),
      urlNormalised: normalised(url("/island")),
      sitemapSource: `${SITE}/sitemap.xml`,
      lastmod: null,
    });
    await deriveClickDepth(db, crawlId);
    expect(await clickDepthOf(crawlId, "/island")).toBeNull();

    expect(await deep(crawlId)).toHaveLength(0);
    // …and the rule whose finding it IS reports it, so the silence above is a
    // boundary between two rules rather than a page nobody speaks for.
    const orphaned = await rule("links.orphan").run(db, crawlId);
    expect(orphaned.map((f) => f.pageUrl)).toEqual([url("/island")]);
  });

  // A page not competing for the index is not competing for link equity either,
  // so burying it is not a fault. Hand-written depths: this is about the rule's
  // indexability filter, not about the search.
  it("is silent on a deep page that is not indexable, and not on the one beside it", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      SEED,
      { path: "/buried-noindex", clickDepth: 8, robotsMeta: "noindex" },
      { path: "/buried-404", clickDepth: 8, fetchClass: "client_error", statusCode: 404 },
      { path: "/buried-redirect", clickDepth: 8, fetchClass: "redirect", statusCode: 301 },
      { path: "/buried-indexable", clickDepth: 8 },
    ]);

    const found = await deep(crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/buried-indexable")]);
    expect(found[0]!.evidence).toEqual({ clickDepth: 8, threshold: DEEP_DEPTH });
  });

  // Deepest first and capped like every other URL-scoped rule, with the exact
  // total surviving the cap: a site whose whole catalogue sits nine clicks down
  // produces a finding per page, and a findings table that mirrors the site is
  // not a problem statement.
  it("orders deepest first, caps the listing and reports the exact total", async () => {
    const crawlId = await newCrawl();
    const many = Array.from(
      { length: URL_FINDING_CAP },
      (_, i) => `/buried-${String(i).padStart(4, "0")}`,
    );
    await addPages(crawlId, [
      SEED,
      // Lexically last, deepest: it must come FIRST, which only ordering by
      // click depth can do.
      { path: "/zz-deepest", clickDepth: 9 },
      ...many.map((path) => ({ path, clickDepth: 6 })),
    ]);

    const found = await deep(crawlId);
    expect(found).toHaveLength(URL_FINDING_CAP);
    expect(found.map((f) => f.pageUrl)).toEqual([
      url("/zz-deepest"),
      ...many.slice(0, URL_FINDING_CAP - 1).map(url),
    ]);
    expect(found[found.length - 1]!.evidence).toMatchObject({
      truncated: { reported: URL_FINDING_CAP, total: URL_FINDING_CAP + 1 },
    });
    expect(found[0]!.evidence).not.toHaveProperty("truncated");
  });

  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    await addPages(other, [SEED, { path: "/buried", clickDepth: 7 }]);

    const mine = await newCrawl();
    await addPages(mine, [SEED, { path: "/shallow", clickDepth: 2 }]);

    expect(await deep(mine)).toHaveLength(0);
    expect(await deep(other)).toHaveLength(1);
  });
});

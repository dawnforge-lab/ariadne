/**
 * PR #24 review (rulings R20 and R21): hreflang declarations this crawl did not
 * read in full.
 *
 * Absence-based hreflang rules read "no row" as "not declared". That is only
 * true when the declarations were read whole. Two things cut them short:
 *
 *  - the sitemap walk (a staging cap, the entry, document or depth cap, an
 *    oversized document): the four absence-based rules then refuse, and the
 *    marker `hreflang.declarations-incomplete` speaks for them. A sitemap
 *    document that FAILED fires the marker too but silences nothing (R21):
 *    `sitemap.invalid` already reports it;
 *  - the per-source cap of `MAX_HREFLANG_PAIRS` pairs: a set that reached it is
 *    never a declarer for the self-reference, x-default and self-only rules,
 *    and never a target that "does not return the link".
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { MAX_HREFLANG_PAIRS } from "../../src/crawl/parse/page-analyzer.js";
import type { DiscoveryEvidence } from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, pages, sitemapHreflang } from "../../src/db/schema.js";
import { deriveSitemapHreflang } from "../../src/rules/derive/sitemap-hreflang.js";
import { hreflangRules } from "../../src/rules/query/hreflang.js";
import { hreflangIntegrityRules } from "../../src/rules/query/hreflang-integrity.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://complete.example";
const url = (path: string): string => `${SITE}${path}`;

const MARKER = "hreflang.declarations-incomplete";
const RETURN_LINK = "hreflang.missing-return-link";
const SELF_REFERENCE = "hreflang.missing-self-reference";
const X_DEFAULT = "hreflang.missing-x-default";
const SELF_ONLY = "hreflang.self-only";
/** The four rules that read an absence, and refuse a cut-short sitemap walk. */
const ABSENCE_RULES = [RETURN_LINK, SELF_REFERENCE, X_DEFAULT, SELF_ONLY];

const byId = new Map([...hreflangRules, ...hreflangIntegrityRules].map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}'`);
  return r;
}

describe("hreflang.declarations-incomplete metadata", () => {
  it("is an info marker in the hreflang category claiming CHECK-24", () => {
    const r = rule(MARKER);
    expect(r.kind).toBe("query");
    expect(r.severity).toBe("info");
    expect(r.category).toBe("hreflang");
    expect(r.checkIds).toEqual(["CHECK-24"]);
    expect(r.marker).toBeDefined();
    expect(r.columns.map((c) => c.key)).toEqual([
      "reason",
      "hreflangLimited",
      "entryLimited",
      "docLimited",
      "depthLimited",
      "timeLimited",
      "interrupted",
      "sitemapDocsFailed",
      "sitemapDocsOversized",
      "alternatesCapped",
      "possiblyCappedPages",
    ]);
  });

  it("names no single cause in its static sentence: the finding's reason does (R23)", () => {
    const sentence = rule(MARKER).marker!;
    expect(sentence).not.toMatch(/fix the failing sitemaps/i);
    expect(sentence).toMatch(/Reason/);
  });
});

describe("hreflang.declarations-incomplete against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  /** `discovery`: undefined writes a null column (a crawl before discovery evidence). */
  async function newCrawl(discovery?: DiscoveryEvidence): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
      discovery: discovery ?? null,
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(
    crawlId: string,
    specs: Array<
      | string
      | { path: string; statusCode?: number; canonicalHtml?: string; overlongHreflang?: number }
    >,
  ): Promise<Map<string, string>> {
    const normalised = specs.map((s) => (typeof s === "string" ? { path: s } : s));
    const rows = normalised.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      fetchClass: "ok",
      statusCode: s.statusCode ?? 200,
      isIndexable: (s.statusCode ?? 200) === 200,
      canonicalHtml: s.canonicalHtml ?? null,
      // An extraction-3 page writes all three counts; null is a v2 row.
      overlongUrls:
        s.overlongHreflang === undefined
          ? null
          : { links: 0, resources: 0, hreflang: s.overlongHreflang },
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [normalised[i]!.path, r.id]));
  }

  async function addHreflang(
    crawlId: string,
    pageId: string,
    declarations: Array<[code: string, target: string]>,
    source = "html",
  ): Promise<void> {
    await db.insert(hreflang).values(
      declarations.map(([code, target]) => ({
        crawlId,
        pageId,
        hreflangCode: code,
        targetUrl: target,
        targetPageId: null,
        source,
      })),
    );
  }

  /**
   * Stage sitemap alternates for `path` as discovery writes them, `copies`
   * times each (one per sitemap document listing it), then derive the
   * `hreflang` rows from them as the rule pipeline does (distinct pairs).
   */
  async function stageSitemap(
    crawlId: string,
    path: string,
    declarations: Array<[code: string, target: string]>,
    copies: number,
  ): Promise<void> {
    const rows = Array.from({ length: copies }, (_, c) =>
      declarations.map(([code, target]) => ({
        crawlId,
        url: url(path),
        urlNormalised: url(path),
        hreflangCode: code,
        targetUrl: target,
        sitemapSource: url(`/sitemap-${c}.xml`),
      })),
    ).flat();
    await db.insert(sitemapHreflang).values(rows);
    await deriveSitemapHreflang(db, crawlId);
  }

  async function run(id: string, crawlId: string): Promise<Finding[]> {
    return rule(id).run(db, crawlId);
  }

  /** A marker finding's evidence, its `reason` set aside for the tests that read it. */
  function withoutReason(finding: Finding): Record<string, unknown> {
    const { reason, ...facts } = finding.evidence;
    expect(typeof reason).toBe("string");
    return facts;
  }

  /** The marker's single finding's evidence, without `reason`. */
  async function markerFacts(crawlId: string): Promise<Record<string, unknown>> {
    const found = await run(MARKER, crawlId);
    expect(found).toHaveLength(1);
    return withoutReason(found[0]!);
  }

  async function markerReason(crawlId: string): Promise<string> {
    const found = await run(MARKER, crawlId);
    expect(found).toHaveLength(1);
    return String(found[0]!.evidence.reason);
  }

  /** `n` declarations from one page, none of them naming `exclude`. */
  const many = (n: number, prefix: string): Array<[string, string]> =>
    Array.from({ length: n }, (_, i) => [`en-${String(i).padStart(3, "0")}`, url(`/${prefix}-${i}`)]);

  /**
   * A site that trips all four absence rules when its declarations are read
   * whole: `/a` names `/b` and `/c` from its sitemap entry, not itself and no
   * x-default, and neither names `/a` back; `/s` names only itself.
   */
  async function seedAbsences(crawlId: string): Promise<void> {
    const ids = await addPages(crawlId, ["/a", "/b", "/c", "/s"]);
    await addHreflang(crawlId, ids.get("/a")!, [["fr", url("/b")], ["de", url("/c")]], "sitemap");
    await addHreflang(crawlId, ids.get("/s")!, [["en", url("/s")]]);
  }

  async function absenceCounts(crawlId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const id of ABSENCE_RULES) counts[id] = (await run(id, crawlId)).length;
    return counts;
  }

  const ALL_FIRE = { [RETURN_LINK]: 2, [SELF_REFERENCE]: 1, [X_DEFAULT]: 1, [SELF_ONLY]: 1 };
  const NONE_FIRE = { [RETURN_LINK]: 0, [SELF_REFERENCE]: 0, [X_DEFAULT]: 0, [SELF_ONLY]: 0 };

  const CLEAN = {
    hreflangLimited: false,
    entryLimited: false,
    docLimited: false,
    depthLimited: false,
    timeLimited: false,
    interrupted: false,
    sitemapDocsFailed: 0,
    sitemapDocsOversized: 0,
    alternatesCapped: 0,
    possiblyCappedPages: 0,
  };

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("(v) a clean Phase 26c crawl: no marker, and the four rules run", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    await seedAbsences(crawlId);
    expect(await run(MARKER, crawlId)).toEqual([]);
    expect(await absenceCounts(crawlId)).toEqual(ALL_FIRE);
  });

  it("(i) staged sitemap hreflang cut at the staging cap: the four refuse, the marker speaks", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapFacts: { hreflangLimited: true } }));
    await seedAbsences(crawlId);
    expect(await absenceCounts(crawlId)).toEqual(NONE_FIRE);
    const marker = await run(MARKER, crawlId);
    expect(marker).toHaveLength(1);
    expect(marker[0]!.pageId).toBeNull();
    expect(marker[0]!.pageUrl).toBeNull();
    expect(marker[0]!.dedupeKey).toBe("site");
    expect(marker[0]!.severity).toBe("info");
    expect(withoutReason(marker[0]!)).toEqual({ ...CLEAN, hreflangLimited: true });
  });

  it("(i) control: the same crawl read whole reports the return link", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapFacts: { hreflangLimited: false } }));
    await seedAbsences(crawlId);
    const found = await run(RETURN_LINK, crawlId);
    expect(found.map((f) => f.evidence.target).sort()).toEqual([url("/b"), url("/c")]);
    expect(await run(MARKER, crawlId)).toEqual([]);
  });

  it.each([
    ["entryLimited", mkDiscovery({ truncation: { entryLimited: true } }), { entryLimited: true }],
    ["docLimited", mkDiscovery({ truncation: { docLimited: true } }), { docLimited: true }],
    [
      "depthLimited",
      mkDiscovery({ truncation: { depthLimited: true, depthLimitedDocs: 2 } }),
      { depthLimited: true },
    ],
    [
      "an oversized document",
      mkDiscovery({
        truncation: { oversizedDocsSkipped: 1 },
        sitemapFacts: {
          oversizedDocs: [{ url: url("/big.xml"), bytesRead: 52_428_801, urlsKept: 9 }],
        },
      }),
      { sitemapDocsOversized: 1 },
    ],
  ])("(ii) %s cuts the walk short: the marker fires and the four rules refuse", async (_label, discovery, flags) => {
    const crawlId = await newCrawl(discovery);
    await seedAbsences(crawlId);
    expect(await absenceCounts(crawlId)).toEqual(NONE_FIRE);
    const marker = await run(MARKER, crawlId);
    expect(marker).toHaveLength(1);
    expect(withoutReason(marker[0]!)).toEqual({ ...CLEAN, ...flags });
  });

  it("(ii) a failed sitemap document fires the marker and silences nothing (R21)", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({
        truncation: { failures: [{ url: url("/broken.xml"), reason: "HTTP 404" }] },
      }),
    );
    await seedAbsences(crawlId);
    expect(await absenceCounts(crawlId)).toEqual(ALL_FIRE);
    const marker = await run(MARKER, crawlId);
    expect(marker).toHaveLength(1);
    expect(withoutReason(marker[0]!)).toEqual({ ...CLEAN, sitemapDocsFailed: 1 });
  });

  it("a sitemap <url> that lost alternates past the per-URL cap fires the marker and silences nothing (R22)", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapFacts: { alternatesCapped: 3 } }));
    await seedAbsences(crawlId);
    expect(await absenceCounts(crawlId)).toEqual(ALL_FIRE);
    const marker = await run(MARKER, crawlId);
    expect(marker).toHaveLength(1);
    expect(withoutReason(marker[0]!)).toEqual({ ...CLEAN, alternatesCapped: 3 });
  });

  it("(iii) a declarer at the pair cap is not judged for its self-reference or x-default", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/p"]);
    // MAX_HREFLANG_PAIRS pairs, none naming /p and none an x-default: had they
    // been read whole, both rules would fire on it.
    await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS, "alt"));
    expect(await run(SELF_REFERENCE, crawlId)).toEqual([]);
    expect(await run(X_DEFAULT, crawlId)).toEqual([]);
    const marker = await run(MARKER, crawlId);
    expect(marker).toHaveLength(1);
    expect(withoutReason(marker[0]!)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("(iii) control: one pair under the cap is judged", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/p"]);
    await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS - 1, "alt"));
    expect(await run(SELF_REFERENCE, crawlId)).toHaveLength(1);
    expect(await run(X_DEFAULT, crawlId)).toHaveLength(1);
    expect(await run(MARKER, crawlId)).toEqual([]);
  });

  it("(iii) a self-only block at the pair cap is not judged", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/s"]);
    await addHreflang(
      crawlId,
      ids.get("/s")!,
      Array.from({ length: MAX_HREFLANG_PAIRS }, (): [string, string] => ["en", url("/s")]),
    );
    expect(await run(SELF_ONLY, crawlId)).toEqual([]);
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("(iii) a TARGET at the pair cap is never reported as not returning the link", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/q", "/t", "/u"]);
    await addHreflang(crawlId, ids.get("/q")!, [
      ["en", url("/q")],
      ["fr", url("/t")],
      ["de", url("/u")],
      ["x-default", url("/q")],
    ]);
    // /t reached the cap without naming /q; /u is one short of it.
    await addHreflang(crawlId, ids.get("/t")!, many(MAX_HREFLANG_PAIRS, "t"));
    await addHreflang(crawlId, ids.get("/u")!, many(MAX_HREFLANG_PAIRS - 1, "u"));
    const found = await run(RETURN_LINK, crawlId);
    expect(found.filter((f) => f.pageUrl === url("/q")).map((f) => f.evidence.target)).toEqual([
      url("/u"),
    ]);
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("counts a page once however many of its sources reached the cap, any status, never a canonicalised one (R23)", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, [
      "/two",
      { path: "/gone", statusCode: 404 },
      { path: "/variant", canonicalHtml: url("/two") },
    ]);
    await addHreflang(crawlId, ids.get("/two")!, many(MAX_HREFLANG_PAIRS, "h"), "html");
    await addHreflang(crawlId, ids.get("/two")!, many(MAX_HREFLANG_PAIRS, "k"), "header");
    // A 404 at the cap is skipped as a target, so it is counted (R23 item 2);
    // a page canonicalised elsewhere is never a declarer or a target.
    await addHreflang(crawlId, ids.get("/gone")!, many(MAX_HREFLANG_PAIRS, "g"));
    await addHreflang(crawlId, ids.get("/variant")!, many(MAX_HREFLANG_PAIRS, "v"));
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 2 });
  });

  it("(R23) stored HTML rows plus over-long hreflang targets at the cap: possibly capped", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    // 195 stored + 5 over-long refused = 200 cap slots taken.
    const ids = await addPages(crawlId, [{ path: "/p", overlongHreflang: 5 }]);
    await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS - 5, "alt"));
    expect(await run(SELF_REFERENCE, crawlId)).toEqual([]);
    expect(await run(X_DEFAULT, crawlId)).toEqual([]);
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("(R23) control: 194 stored plus 5 over-long is under the cap and judged", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, [{ path: "/p", overlongHreflang: 5 }]);
    await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS - 6, "alt"));
    expect(await run(SELF_REFERENCE, crawlId)).toHaveLength(1);
    expect(await run(X_DEFAULT, crawlId)).toHaveLength(1);
    expect(await run(MARKER, crawlId)).toEqual([]);
  });

  it("(R23) the over-long count applies to the Link header source too", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, [{ path: "/p", overlongHreflang: 5 }]);
    await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS - 5, "alt"), "header");
    expect(await run(SELF_REFERENCE, crawlId)).toEqual([]);
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("(R23) a sitemap set of 200 staged rows deriving to fewer (duplicates): possibly capped", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    await addPages(crawlId, ["/p"]);
    // 100 distinct pairs, each listed by two sitemap documents: 200 staged, 100 derived.
    await stageSitemap(crawlId, "/p", many(MAX_HREFLANG_PAIRS / 2, "alt"), 2);
    const derived = await db.select().from(hreflang).where(eq(hreflang.crawlId, crawlId));
    expect(derived).toHaveLength(MAX_HREFLANG_PAIRS / 2);
    expect(await run(SELF_REFERENCE, crawlId)).toEqual([]);
    expect(await run(X_DEFAULT, crawlId)).toEqual([]);
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("(R23) control: 199 staged sitemap rows are under the cap and judged", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    await addPages(crawlId, ["/p"]);
    const pairs = many(MAX_HREFLANG_PAIRS / 2, "alt");
    await stageSitemap(crawlId, "/p", pairs, 1);
    await stageSitemap(crawlId, "/p", pairs.slice(1), 1);
    const staged = await db
      .select()
      .from(sitemapHreflang)
      .where(eq(sitemapHreflang.crawlId, crawlId));
    expect(staged).toHaveLength(MAX_HREFLANG_PAIRS - 1);
    expect(await run(SELF_REFERENCE, crawlId)).toHaveLength(1);
    expect(await run(X_DEFAULT, crawlId)).toHaveLength(1);
    expect(await run(MARKER, crawlId)).toEqual([]);
  });

  it("(R23) a 404 target whose Link-header set is at the cap is skipped and counted", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/q", { path: "/t", statusCode: 404 }, { path: "/u", statusCode: 404 }]);
    await addHreflang(crawlId, ids.get("/q")!, [
      ["en", url("/q")],
      ["fr", url("/t")],
      ["de", url("/u")],
      ["x-default", url("/q")],
    ]);
    // /t's header reached the cap without naming /q; /u's is one short of it.
    await addHreflang(crawlId, ids.get("/t")!, many(MAX_HREFLANG_PAIRS, "t"), "header");
    await addHreflang(crawlId, ids.get("/u")!, many(MAX_HREFLANG_PAIRS - 1, "u"), "header");
    const found = await run(RETURN_LINK, crawlId);
    expect(found.filter((f) => f.pageUrl === url("/q")).map((f) => f.evidence.target)).toEqual([
      url("/u"),
    ]);
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("(R23) a target that stored no pair because all 200 were over-long is skipped and counted", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, [
      "/q",
      { path: "/t", overlongHreflang: MAX_HREFLANG_PAIRS },
      "/u",
    ]);
    await addHreflang(crawlId, ids.get("/q")!, [
      ["en", url("/q")],
      ["fr", url("/t")],
      ["de", url("/u")],
      ["x-default", url("/q")],
    ]);
    const found = await run(RETURN_LINK, crawlId);
    expect(found.filter((f) => f.pageUrl === url("/q")).map((f) => f.evidence.target)).toEqual([
      url("/u"),
    ]);
    expect(await markerFacts(crawlId)).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("(R23) throws on an extraction-3 over-long count without its hreflang key", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/p"]);
    await db
      .update(pages)
      // A defect in the write, which the type would refuse: cast past it.
      .set({ overlongUrls: { links: 0, resources: 0 } as never })
      .where(eq(pages.id, ids.get("/p")!));
    await addHreflang(crawlId, ids.get("/p")!, many(3, "alt"));
    await expect(run(MARKER, crawlId)).rejects.toThrow(/hreflang/);
    await expect(run(SELF_REFERENCE, crawlId)).rejects.toThrow(/hreflang/);
  });

  describe("(R23) the reason names only the triggers that fired", () => {
    it("a page at the pair cap alone: no sitemap wording", async () => {
      const crawlId = await newCrawl(mkDiscovery());
      const ids = await addPages(crawlId, ["/p"]);
      await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS, "alt"));
      const reason = await markerReason(crawlId);
      expect(reason).toMatch(new RegExp(`1 page lists ${MAX_HREFLANG_PAIRS} or more`));
      // Nothing about a sitemap that failed, was cut short or lost alternates.
      expect(reason).not.toMatch(/could not be read|only partly read|fix the|kept for one URL/i);
    });

    it("a failed sitemap alone names the failure and the finding that lists it", async () => {
      const crawlId = await newCrawl(
        mkDiscovery({
          truncation: {
            failures: [
              { url: url("/a.xml"), reason: "HTTP 404" },
              { url: url("/b.xml"), reason: "HTTP 500" },
            ],
          },
        }),
      );
      const reason = await markerReason(crawlId);
      expect(reason).toMatch(/2 sitemaps could not be read/);
      expect(reason).toMatch(/Sitemaps: Sitemap could not be read/);
      expect(reason).not.toMatch(/only partly read/);
      expect(reason).not.toMatch(/or more alternates/);
    });

    it("a cut-short walk alone says which checks did not run, and no failure", async () => {
      const crawlId = await newCrawl(mkDiscovery({ truncation: { entryLimited: true } }));
      const reason = await markerReason(crawlId);
      expect(reason).toMatch(/only partly read/);
      expect(reason).toMatch(/were not checked/);
      expect(reason).not.toMatch(/could not be read/);
    });

    it("alternates past the per-URL cap alone", async () => {
      const crawlId = await newCrawl(mkDiscovery({ sitemapFacts: { alternatesCapped: 1 } }));
      const reason = await markerReason(crawlId);
      expect(reason).toMatch(new RegExp(`1 sitemap alternate past the ${MAX_HREFLANG_PAIRS} kept`));
      expect(reason).not.toMatch(/could not be read/);
      expect(reason).not.toMatch(/only partly read/);
    });

    it("every trigger at once: each wording appears", async () => {
      const crawlId = await newCrawl(
        mkDiscovery({
          truncation: { docLimited: true, failures: [{ url: url("/a.xml"), reason: "HTTP 404" }] },
          sitemapFacts: { alternatesCapped: 4 },
        }),
      );
      const ids = await addPages(crawlId, ["/p", "/r"]);
      await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS, "p"));
      await addHreflang(crawlId, ids.get("/r")!, many(MAX_HREFLANG_PAIRS, "r"));
      const reason = await markerReason(crawlId);
      expect(reason).toMatch(/only partly read/);
      expect(reason).toMatch(/1 sitemap could not be read/);
      expect(reason).toMatch(/4 sitemap alternates past/);
      expect(reason).toMatch(new RegExp(`2 pages list ${MAX_HREFLANG_PAIRS} or more`));
    });
  });

  it("does not add up sources: under the cap in each is not at the cap", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/split"]);
    // HTML and header are capped per source (each kept its own 200), so 199 +
    // 199 is two sets under the cap, not one over it.
    await addHreflang(crawlId, ids.get("/split")!, many(MAX_HREFLANG_PAIRS - 1, "h"), "html");
    await addHreflang(crawlId, ids.get("/split")!, many(MAX_HREFLANG_PAIRS - 1, "k"), "header");
    expect(await run(MARKER, crawlId)).toEqual([]);
    expect(await run(SELF_REFERENCE, crawlId)).toHaveLength(1);
  });

  it("(iv) a crawl from before Phase 26c judges only the pair cap, its sitemap facts null", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapFacts: null }));
    const ids = await addPages(crawlId, ["/p"]);
    await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS, "alt"));
    expect(await markerFacts(crawlId)).toEqual({
      hreflangLimited: null,
      entryLimited: null,
      docLimited: null,
      depthLimited: null,
      timeLimited: null,
      interrupted: null,
      sitemapDocsFailed: null,
      sitemapDocsOversized: null,
      alternatesCapped: null,
      possiblyCappedPages: 1,
    });
    expect(await run(SELF_REFERENCE, crawlId)).toEqual([]);
  });

  it("(iv) a crawl from before Phase 26c with every set under the cap: silent, and the rules run", async () => {
    // Its truncation says the walk was cut short, which the 26c facts would
    // read as cut-short sitemap hreflang; an older crawl staged none to cut.
    const crawlId = await newCrawl(
      mkDiscovery({ sitemapFacts: null, truncation: { entryLimited: true } }),
    );
    await seedAbsences(crawlId);
    expect(await run(MARKER, crawlId)).toEqual([]);
    expect(await absenceCounts(crawlId)).toEqual(ALL_FIRE);
  });

  it("is silent on a crawl with no discovery evidence and nothing at the cap", async () => {
    const crawlId = await newCrawl();
    await seedAbsences(crawlId);
    expect(await run(MARKER, crawlId)).toEqual([]);
    expect(await absenceCounts(crawlId)).toEqual(ALL_FIRE);
  });

  it("throws for a crawl that does not exist", async () => {
    await expect(run(MARKER, "crawl_nonexistent")).rejects.toThrow(/no such crawl/);
  });

  it("throws on a 26c crawl whose truncation lacks a cap flag, never reading it as false", async () => {
    const discovery = mkDiscovery();
    const { docLimited: _dropped, ...truncation } = discovery.truncation;
    const crawlId = await newCrawl({
      ...discovery,
      truncation: truncation as DiscoveryEvidence["truncation"],
    });
    await expect(run(MARKER, crawlId)).rejects.toThrow(/docLimited/);
    await expect(run(RETURN_LINK, crawlId)).rejects.toThrow(/docLimited/);
  });

  // Phase 27d: the walk's time budget.
  it("(27d) a walk cut short by its time budget refuses the four rules and the marker names timeLimited", async () => {
    const crawlId = await newCrawl(mkDiscovery({ truncation: { timeLimited: true } }));
    await seedAbsences(crawlId);
    expect(await absenceCounts(crawlId)).toEqual(NONE_FIRE);
    const found = await run(MARKER, crawlId);
    expect(found).toHaveLength(1);
    expect(withoutReason(found[0]!)).toEqual({ ...CLEAN, timeLimited: true });
    const reason = String(found[0]!.evidence.reason);
    expect(reason).toMatch(/timeLimited/);
    // Only the time budget fired: the size / entry / nesting sentence is not said.
    expect(reason).not.toMatch(/size, entry, file-count or nesting limit/);
  });

  it("(27d) a pre-27d truncation without timeLimited reads as false", async () => {
    const discovery = mkDiscovery();
    const { timeLimited: _dropped, ...truncation } = discovery.truncation;
    const crawlId = await newCrawl({
      ...discovery,
      truncation: truncation as DiscoveryEvidence["truncation"],
    });
    await seedAbsences(crawlId);
    expect(await run(MARKER, crawlId)).toEqual([]);
    expect(await absenceCounts(crawlId)).toEqual(ALL_FIRE);
  });

  it("(27d) a non-boolean timeLimited is a loud error, not false", async () => {
    const discovery = mkDiscovery();
    const crawlId = await newCrawl({
      ...discovery,
      truncation: { ...discovery.truncation, timeLimited: "yes" } as unknown as DiscoveryEvidence["truncation"],
    });
    await expect(run(MARKER, crawlId)).rejects.toThrow(/timeLimited/);
  });

  // Phase 27d ruling R8: a resumed crawl stopped during its re-walk.
  it("(27d) an interrupted re-walk refuses the four rules and the marker names interrupted", async () => {
    const discovery = mkDiscovery();
    const crawlId = await newCrawl({
      ...discovery,
      truncation: { ...discovery.truncation, interrupted: true },
    });
    await seedAbsences(crawlId);
    expect(await absenceCounts(crawlId)).toEqual(NONE_FIRE);
    const found = await run(MARKER, crawlId);
    expect(found).toHaveLength(1);
    expect(withoutReason(found[0]!)).toEqual({ ...CLEAN, interrupted: true });
    const reason = String(found[0]!.evidence.reason);
    expect(reason).toMatch(/stopped or failed.*\(interrupted\)/);
    // Only the interruption fired: neither the limit nor the time sentence is said.
    expect(reason).not.toMatch(/size, entry, file-count or nesting limit/);
    expect(reason).not.toMatch(/timeLimited/);
  });

  it("(27d) interrupted: false, or no key at all, is not cut short", async () => {
    const discovery = mkDiscovery();
    const crawlId = await newCrawl({
      ...discovery,
      truncation: { ...discovery.truncation, interrupted: false },
    });
    await seedAbsences(crawlId);
    expect(await run(MARKER, crawlId)).toEqual([]);
    expect(await absenceCounts(crawlId)).toEqual(ALL_FIRE);
  });

  it("(27d) a non-boolean interrupted is a loud error, not false", async () => {
    const discovery = mkDiscovery();
    const crawlId = await newCrawl({
      ...discovery,
      truncation: { ...discovery.truncation, interrupted: 1 } as unknown as DiscoveryEvidence["truncation"],
    });
    await expect(run(MARKER, crawlId)).rejects.toThrow(/interrupted/);
    await expect(run(RETURN_LINK, crawlId)).rejects.toThrow(/interrupted/);
  });
});

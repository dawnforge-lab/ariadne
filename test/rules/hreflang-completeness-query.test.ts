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
import { crawls, hreflang, pages } from "../../src/db/schema.js";
import { hreflangRules } from "../../src/rules/query/hreflang.js";
import { hreflangIntegrityRules } from "../../src/rules/query/hreflang-integrity.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";

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
      "hreflangLimited",
      "entryLimited",
      "docLimited",
      "depthLimited",
      "sitemapDocsFailed",
      "sitemapDocsOversized",
      "possiblyCappedPages",
    ]);
  });
});

describe("hreflang.declarations-incomplete against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  /** `discovery`: undefined writes a null column (a crawl before discovery evidence). */
  async function newCrawl(discovery?: DiscoveryEvidence): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
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
    specs: Array<string | { path: string; statusCode?: number; canonicalHtml?: string }>,
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

  async function run(id: string, crawlId: string): Promise<Finding[]> {
    return rule(id).run(db, crawlId);
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
    sitemapDocsFailed: 0,
    sitemapDocsOversized: 0,
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
    expect(marker[0]!.evidence).toEqual({ ...CLEAN, hreflangLimited: true });
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
    expect(marker[0]!.evidence).toEqual({ ...CLEAN, ...flags });
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
    expect(marker[0]!.evidence).toEqual({ ...CLEAN, sitemapDocsFailed: 1 });
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
    expect(marker[0]!.evidence).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
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
    expect((await run(MARKER, crawlId))[0]!.evidence).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
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
    expect((await run(MARKER, crawlId))[0]!.evidence).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("counts a page once however many of its sources reached the cap, and only judged declarers", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, [
      "/two",
      { path: "/gone", statusCode: 404 },
      { path: "/variant", canonicalHtml: url("/two") },
    ]);
    await addHreflang(crawlId, ids.get("/two")!, many(MAX_HREFLANG_PAIRS, "h"), "html");
    await addHreflang(crawlId, ids.get("/two")!, many(MAX_HREFLANG_PAIRS, "s"), "sitemap");
    await addHreflang(crawlId, ids.get("/gone")!, many(MAX_HREFLANG_PAIRS, "g"));
    await addHreflang(crawlId, ids.get("/variant")!, many(MAX_HREFLANG_PAIRS, "v"));
    expect((await run(MARKER, crawlId))[0]!.evidence).toEqual({ ...CLEAN, possiblyCappedPages: 1 });
  });

  it("does not add up sources: under the cap in each is not at the cap", async () => {
    const crawlId = await newCrawl(mkDiscovery());
    const ids = await addPages(crawlId, ["/split"]);
    await addHreflang(crawlId, ids.get("/split")!, many(MAX_HREFLANG_PAIRS - 1, "h"), "html");
    await addHreflang(crawlId, ids.get("/split")!, many(MAX_HREFLANG_PAIRS - 1, "s"), "sitemap");
    expect(await run(MARKER, crawlId)).toEqual([]);
    expect(await run(SELF_REFERENCE, crawlId)).toHaveLength(1);
  });

  it("(iv) a crawl from before Phase 26c judges only the pair cap, its sitemap facts null", async () => {
    const crawlId = await newCrawl(mkDiscovery({ sitemapFacts: null }));
    const ids = await addPages(crawlId, ["/p"]);
    await addHreflang(crawlId, ids.get("/p")!, many(MAX_HREFLANG_PAIRS, "alt"));
    expect((await run(MARKER, crawlId))[0]!.evidence).toEqual({
      hreflangLimited: null,
      entryLimited: null,
      docLimited: null,
      depthLimited: null,
      sitemapDocsFailed: null,
      sitemapDocsOversized: null,
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
});

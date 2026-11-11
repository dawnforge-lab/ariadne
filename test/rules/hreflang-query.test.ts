import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, pages, sitemapHreflang } from "../../src/db/schema.js";
import { deriveSitemapHreflang } from "../../src/rules/derive/sitemap-hreflang.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { ALTERNATE_HOST_CAP, HREFLANG_PAGE_BATCH, hreflangRules } from "../../src/rules/query/hreflang.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://hreflang.example";

const byId = new Map(hreflangRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in hreflangRules`);
  return r;
}

describe("hreflangRules metadata", () => {
  it("defines exactly the six hreflang rules of the Phase 2, 3 and 19 tables, and the PR #24 marker", () => {
    expect(hreflangRules.map((r) => r.id).sort()).toEqual([
      "hreflang.alternates-not-crawled",
      "hreflang.declarations-incomplete",
      "hreflang.invalid-code",
      "hreflang.missing-return-link",
      "hreflang.missing-self-reference",
      "hreflang.missing-x-default",
      "hreflang.non-indexable-target",
    ]);
  });

  it("claims exactly the checklist ids the tables assign", () => {
    expect(Object.fromEntries(hreflangRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "hreflang.invalid-code": ["CHECK-25"],
      "hreflang.missing-x-default": ["CHECK-25"],
      "hreflang.missing-return-link": ["CHECK-24"],
      // The other half of reciprocity: one check, two faults.
      "hreflang.missing-self-reference": ["CHECK-24"],
      "hreflang.non-indexable-target": ["CHECK-26"],
      // Both checks that read a FETCHED alternate: neither can be answered for
      // a URL nobody requested.
      "hreflang.alternates-not-crawled": ["CHECK-24", "CHECK-26"],
      // PR #24 review: the declarations not read in full, which the
      // absence-based halves of CHECK-24 depend on.
      "hreflang.declarations-incomplete": ["CHECK-24"],
    });
  });

  it("carries the severities the tables assign", () => {
    expect(Object.fromEntries(hreflangRules.map((r) => [r.id, r.severity]))).toEqual({
      "hreflang.invalid-code": "critical",
      "hreflang.missing-x-default": "info",
      "hreflang.missing-return-link": "critical",
      "hreflang.missing-self-reference": "warning",
      "hreflang.non-indexable-target": "critical",
      // A NOT MEASURED marker reports a hole in OUR evidence, never a fault of
      // the site, so it can only be info.
      "hreflang.alternates-not-crawled": "info",
      "hreflang.declarations-incomplete": "info",
    });
  });

  // The marker flag is the single source of truth for "which rules are
  // markers" (RuleMeta.marker), and the identifier guard derives the checklist
  // obligations from it. Exactly two rules here carry it.
  it("flags the two markers, and nothing else in this family", () => {
    expect(hreflangRules.filter((r) => r.marker !== undefined).map((r) => r.id)).toEqual([
      "hreflang.alternates-not-crawled",
      "hreflang.declarations-incomplete",
    ]);
    const marker = rule("hreflang.alternates-not-crawled").marker!;
    // A reason names the cause AND what would answer the check (Phase 19 §6).
    expect(marker).toMatch(/not requested by this crawl/);
    expect(marker).toMatch(/crawl those domains/);
    // And it claims no cause the finding cannot establish: an alternate this
    // crawl never fetched is not evidence that it sits on another domain — a
    // same-host alternate that robots.txt disallowed reads identically.
    expect(marker).not.toMatch(/other domains/);
  });

  it("every rule is a query rule carrying copy and a ruleset version", () => {
    for (const r of hreflangRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.category, r.id).toBe("hreflang");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });
});

describe("hreflangRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    /** A declared canonical, as the analyzer stored it — absolute or relative. */
    canonicalHtml?: string;
    canonicalHeader?: string;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
    });
    createdCrawls.push(id);
    return id;
  }

  /**
   * One page row per spec, returning the page ids by path. A bare string is a
   * healthy indexable 200; a spec says what the fetch actually was, and
   * `is_indexable` is derived from it exactly as the writer derives it.
   */
  async function addPages(
    crawlId: string,
    specs: Array<string | PageSpec>,
  ): Promise<Map<string, string>> {
    const normalised = specs.map((s) => (typeof s === "string" ? { path: s } : s));
    const rows = normalised.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`,
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: writerIndexable(s),
      canonicalHtml: s.canonicalHtml ?? null,
      canonicalHeader: s.canonicalHeader ?? null,
      robotsMeta: s.robotsMeta ?? null,
      xRobotsTag: s.xRobotsTag ?? null,
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

  const url = (path: string): string => `${SITE}${path}`;

  async function findings(id: string, crawlId: string): Promise<Finding[]> {
    return rule(id).run(db, crawlId);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
    await closeDb(db);
  });

  it("no rule fires on a crawl with no hreflang declarations at all", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/alone"]);
    for (const r of hreflangRules) {
      expect(await r.run(db, crawlId), r.id).toHaveLength(0);
    }
  });

  it("no rule fires on a well-formed hreflang cluster", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, ["/en", "/en-gb"]);
    const cluster: Array<[string, string]> = [
      ["en", url("/en")],
      ["en-gb", url("/en-gb")],
      ["x-default", url("/en")],
    ];
    await addHreflang(crawlId, ids.get("/en")!, cluster);
    await addHreflang(crawlId, ids.get("/en-gb")!, cluster);
    for (const r of hreflangRules) {
      expect(await r.run(db, crawlId), r.id).toHaveLength(0);
    }
  });

  describe("hreflang.invalid-code", () => {
    it("reports exactly the codes that are not language, language-region or x-default", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/one", "/two"]);
      await addHreflang(crawlId, ids.get("/one")!, [
        ["en-gb", `${SITE}/en-gb`], // valid: language + 2-alpha region
        ["de", `${SITE}/de`], // valid: bare language
        ["en-150", `${SITE}/en-150`], // valid: language + 3-digit UN region
        ["X-Default", `${SITE}/`], // valid: the one special value, any case
        ["english-uk", `${SITE}/uk`], // invalid: not a language subtag
      ]);
      await addHreflang(crawlId, ids.get("/two")!, [
        ["zz-qqqq", `${SITE}/zz`], // invalid: region is neither 2-alpha nor 3-digit
        ["fr", `${SITE}/fr`], // valid
      ]);

      const found = await findings("hreflang.invalid-code", crawlId);
      expect(found.map((f) => f.evidence.code).sort()).toEqual(["english-uk", "zz-qqqq"]);
      const one = found.find((f) => f.evidence.code === "english-uk")!;
      expect(one.ruleId).toBe("hreflang.invalid-code");
      expect(one.severity).toBe(rule("hreflang.invalid-code").severity);
      expect(one.pageId).toBe(ids.get("/one"));
      expect(one.pageUrl).toBe(`${SITE}/one`);
      expect(one.evidence).toEqual({
        code: "english-uk",
        targetUrl: `${SITE}/uk`,
        occurrences: 1,
        sources: ["html"],
      });
      expect(one.dedupeKey).toBe(`${SITE}/one#english-uk`);
      expect(found.find((f) => f.evidence.code === "zz-qqqq")!.dedupeKey).toBe(
        `${SITE}/two#zz-qqqq`,
      );
    });

    // The analyzer stores the attribute verbatim, so a code the author padded
    // with a space reaches the rule padded. It is a valid code either way.
    it("does not fire on a valid code carrying surrounding whitespace", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/padded"]);
      await addHreflang(crawlId, ids.get("/padded")!, [["en-GB ", `${SITE}/en-gb`]]);

      expect(await findings("hreflang.invalid-code", crawlId)).toHaveLength(0);
    });

    it("reports the trimmed code, in the evidence and the dedupe key", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/padded-bad"]);
      await addHreflang(crawlId, ids.get("/padded-bad")!, [["english-uk ", `${SITE}/uk`]]);

      const found = await findings("hreflang.invalid-code", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence.code).toBe("english-uk");
      expect(found[0]!.dedupeKey).toBe(`${SITE}/padded-bad#english-uk`);
    });

    // The `hreflang` table has no unique constraint, and nothing upstream
    // enforces one: a template that emits its alternates block twice, or a code
    // declared both in the HTML and in the sitemap, puts two rows on one page
    // for one code. Ungrouped, each row became a finding, both findings carried
    // the same `dedupeKey`, and the run died on the `issues_dedupe` unique
    // index — one page's malformed template taking the whole judgement down.
    it("reports one finding per (page, code) when a code is declared twice on one page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/twice"]);
      await addHreflang(crawlId, ids.get("/twice")!, [
        ["english-uk", `${SITE}/uk`],
        ["english-uk ", `${SITE}/uk-alt`],
      ]);

      const found = await findings("hreflang.invalid-code", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.dedupeKey).toBe(`${SITE}/twice#english-uk`);
      expect(found[0]!.evidence).toMatchObject({
        code: "english-uk",
        occurrences: 2,
        targetUrls: [`${SITE}/uk`, `${SITE}/uk-alt`],
      });
    });

    it("names both sources when one code arrives from the HTML and the sitemap", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/two-sources"]);
      const pageId = ids.get("/two-sources")!;
      await db.insert(hreflang).values([
        {
          crawlId,
          pageId,
          hreflangCode: "en_GB",
          targetUrl: `${SITE}/en-gb`,
          targetPageId: null,
          source: "html",
        },
        {
          crawlId,
          pageId,
          hreflangCode: "en_GB",
          targetUrl: `${SITE}/en-gb`,
          targetPageId: null,
          source: "sitemap",
        },
      ]);

      const found = await findings("hreflang.invalid-code", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({
        code: "en_GB",
        occurrences: 2,
        sources: ["html", "sitemap"],
      });
      // One target, declared twice: no `targetUrls` list, because there is no
      // second URL for it to hold.
      expect(found[0]!.evidence["targetUrls"]).toBeUndefined();
    });

    // Phase 26c: `sources` is written on every finding, so a code that only
    // the sitemap or a Link header declares says where to fix it.
    it("names the one source when a code arrives from the sitemap alone", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/sitemap-only"]);
      await addHreflang(crawlId, ids.get("/sitemap-only")!, [["en_GB", url("/en-gb")]], "sitemap");

      const found = await findings("hreflang.invalid-code", crawlId);
      expect(found.map((f) => f.evidence.sources)).toEqual([["sitemap"]]);
    });

    // Final review I6: the rule reads the table in page-id batches. A page's
    // rows never split across two batches, so a crawl one page past the batch
    // size gives the findings one unbounded read would.
    it("reads in page batches and gives the same findings across a batch boundary", async () => {
      const crawlId = await newCrawl();
      const paths = Array.from({ length: HREFLANG_PAGE_BATCH + 1 }, (_, i) => `/batch-${i}`);
      const ids = await addPages(crawlId, paths);
      await db.insert(hreflang).values(
        paths.flatMap((path) => [
          // Two rows of one invalid code per page, from two sources, and a valid one.
          { crawlId, pageId: ids.get(path)!, hreflangCode: "english-uk", targetUrl: url(`${path}/uk`), targetPageId: null, source: "html" },
          { crawlId, pageId: ids.get(path)!, hreflangCode: "english-uk ", targetUrl: url(`${path}/uk`), targetPageId: null, source: "sitemap" },
          { crawlId, pageId: ids.get(path)!, hreflangCode: "en", targetUrl: url(path), targetPageId: null, source: "html" },
        ]),
      );

      const found = await findings("hreflang.invalid-code", crawlId);
      expect(found).toHaveLength(HREFLANG_PAGE_BATCH + 1);
      expect(found.map((f) => f.dedupeKey).sort()).toEqual(paths.map((p) => `${url(p)}#english-uk`).sort());
      for (const f of found) {
        expect(f.evidence).toEqual({
          code: "english-uk",
          targetUrl: `${f.pageUrl}/uk`,
          occurrences: 2,
          sources: ["html", "sitemap"],
        });
      }
    });

    // Ruling R14: a declaring page that serves no content is not judged.
    it("is silent on a 301 declarer with an invalid code, and fires on a 200 one", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/moved", fetchClass: "redirect", statusCode: 301 },
        { path: "/gone", fetchClass: "ok", statusCode: 404 },
        "/served",
      ]);
      for (const path of ["/moved", "/gone", "/served"]) {
        await addHreflang(crawlId, ids.get(path)!, [["english-uk", url("/uk")]], "header");
      }

      const found = await findings("hreflang.invalid-code", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/served")]);
      expect(found[0]!.evidence).toEqual({
        code: "english-uk",
        targetUrl: url("/uk"),
        occurrences: 1,
        sources: ["header"],
      });
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, ["/foreign"]);
      await addHreflang(other, otherIds.get("/foreign")!, [["nonsense-code", `${SITE}/x`]]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/mine"]);
      await addHreflang(mine, mineIds.get("/mine")!, [["en", `${SITE}/mine`]]);

      expect(await findings("hreflang.invalid-code", mine)).toHaveLength(0);
      expect(await findings("hreflang.invalid-code", other)).toHaveLength(1);
    });
  });

  /**
   * The per-SET rule. A missing x-default is a property of one declaration set
   * — the cluster a page names — not of the crawl, so the finding lands on a
   * URL and a site with two clusters, one of them complete, reports one
   * finding rather than none.
   */
  describe("hreflang.missing-x-default", () => {
    const setKey = (targets: string[]): string =>
      createHash("sha256").update([...targets].sort().join("\n")).digest("hex");

    it("fires on a set of two or more targets with no x-default, keyed by the set", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/fr/a", "/b"]);
      await addHreflang(crawlId, ids.get("/a")!, [
        ["en", url("/a")],
        ["fr", url("/fr/a")],
      ]);
      // A single declaration is not a cluster: there is nothing to fall back
      // from, so it is not a missing fallback.
      await addHreflang(crawlId, ids.get("/b")!, [["en", url("/b")]]);

      const found = await findings("hreflang.missing-x-default", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "hreflang.missing-x-default",
        severity: "info",
        // Lexically first of the set's members — a cluster has no one page that
        // owns it, so the finding is attached deterministically rather than to
        // whichever page happened to be read first.
        pageId: ids.get("/a"),
        pageUrl: url("/a"),
        dedupeKey: setKey([url("/a"), url("/fr/a")]),
      });
      expect(found[0]!.evidence).toEqual({
        targets: [url("/a"), url("/fr/a")],
        setSize: 2,
      });
    });

    // Two pages of one cluster declare the same alternates. That is one cluster
    // missing one x-default, and reporting it once per page would bill a single
    // fix as several.
    it("writes ONE finding for two pages that declare the same set", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/de"]);
      const cluster: Array<[string, string]> = [
        ["en", url("/en")],
        ["de", url("/de")],
      ];
      await addHreflang(crawlId, ids.get("/en")!, cluster);
      await addHreflang(crawlId, ids.get("/de")!, cluster);

      const found = await findings("hreflang.missing-x-default", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageUrl).toBe(url("/de"));
      expect(found[0]!.evidence).toEqual({
        targets: [url("/de"), url("/en")],
        setSize: 2,
      });
    });

    it("writes one finding per DISTINCT set", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/one-en", "/one-fr", "/two-en", "/two-fr"]);
      await addHreflang(crawlId, ids.get("/one-en")!, [
        ["en", url("/one-en")],
        ["fr", url("/one-fr")],
      ]);
      await addHreflang(crawlId, ids.get("/two-en")!, [
        ["en", url("/two-en")],
        ["fr", url("/two-fr")],
      ]);

      const found = await findings("hreflang.missing-x-default", crawlId);
      expect(found.map((f) => f.pageUrl).sort()).toEqual([url("/one-en"), url("/two-en")]);
      expect(new Set(found.map((f) => f.dedupeKey)).size).toBe(2);
    });

    it("is silent when the set names an x-default, whatever its case or padding", async () => {
      for (const code of ["x-default", "X-Default", " x-default "]) {
        const crawlId = await newCrawl();
        const ids = await addPages(crawlId, ["/a"]);
        await addHreflang(crawlId, ids.get("/a")!, [
          ["en", url("/a")],
          [code, url("/")],
        ]);
        expect(await findings("hreflang.missing-x-default", crawlId), code).toHaveLength(0);
      }
    });

    // A cluster with a fallback and one without are two sets, and the complete
    // one must not silence the incomplete one — which is exactly what the old
    // site-scoped shape did.
    it("reports the incomplete cluster even when another cluster has an x-default", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/good-en", "/good-fr", "/bad-en", "/bad-fr"]);
      await addHreflang(crawlId, ids.get("/good-en")!, [
        ["en", url("/good-en")],
        ["fr", url("/good-fr")],
        ["x-default", url("/good-en")],
      ]);
      await addHreflang(crawlId, ids.get("/bad-en")!, [
        ["en", url("/bad-en")],
        ["fr", url("/bad-fr")],
      ]);

      const found = await findings("hreflang.missing-x-default", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/bad-en")]);
    });

    // The target list is the set's identity, so two declarations naming the
    // same URL are one member and a two-declaration page can still be a set of
    // one.
    it("counts distinct targets, not declarations", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a"]);
      await addHreflang(crawlId, ids.get("/a")!, [
        ["en", url("/a")],
        ["en-gb", url("/a")],
      ]);

      expect(await findings("hreflang.missing-x-default", crawlId)).toHaveLength(0);
    });

    // The accumulator here holds one target LIST per distinct cluster, which
    // grows with the site on a shop that ships a cluster per product. The scan
    // stops once it has seen one more cluster than it may list, so the count
    // it can report is a lower bound — `atLeast`, never `total`: what it did
    // not scan it cannot claim to have counted.
    it("caps the listed clusters and reports a lower bound, not a total", async () => {
      const crawlId = await newCrawl();
      const clusters = URL_FINDING_CAP + 20;
      const paths = Array.from(
        { length: clusters },
        (_, i) => `/set-${String(i).padStart(4, "0")}`,
      );
      const ids = await addPages(crawlId, paths);
      for (const [i, path] of paths.entries()) {
        await addHreflang(crawlId, ids.get(path)!, [
          ["en", url(path)],
          ["fr", `https://fr.example/set-${String(i).padStart(4, "0")}`],
        ]);
      }

      const found = await findings("hreflang.missing-x-default", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, atLeast: URL_FINDING_CAP + 1 },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, ["/a", "/b"]);
      await addHreflang(other, otherIds.get("/a")!, [
        ["en", url("/a")],
        ["fr", url("/b")],
      ]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/a"]);
      await addHreflang(mine, mineIds.get("/a")!, [["en", url("/a")]]);

      expect(await findings("hreflang.missing-x-default", mine)).toHaveLength(0);
      expect(await findings("hreflang.missing-x-default", other)).toHaveLength(1);
    });
  });

  describe("hreflang.missing-return-link", () => {
    it("is silent on a reciprocal pair", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      const cluster: Array<[string, string]> = [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ];
      await addHreflang(crawlId, ids.get("/en")!, cluster);
      await addHreflang(crawlId, ids.get("/fr")!, cluster);

      expect(await findings("hreflang.missing-return-link", crawlId)).toHaveLength(0);
    });

    it("fires once per declaration whose target does not point back", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ]);
      // The French page names only itself: no return link to the English one.
      await addHreflang(crawlId, ids.get("/fr")!, [["fr", url("/fr")]]);

      const found = await findings("hreflang.missing-return-link", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "hreflang.missing-return-link",
        severity: rule("hreflang.missing-return-link").severity,
        pageId: ids.get("/en"),
        pageUrl: url("/en"),
        dedupeKey: `${url("/en")}→${url("/fr")}`,
      });
      expect(found[0]!.evidence).toEqual({
        target: url("/fr"),
        targetHasHreflang: true,
        sources: ["html"],
      });
    });

    it("fires when the target was crawled and declares no hreflang at all", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ]);

      const found = await findings("hreflang.missing-return-link", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        target: url("/fr"),
        targetHasHreflang: false,
        sources: ["html"],
      });
    });

    // Phase 26c: every source counts both ways. The return link may be stated
    // only in the sitemap (the derivation ties it to the page), and the
    // declaration the finding is about names the sources that made it.
    it("is satisfied by a return link the sitemap states", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ]);
      // The French page's own HTML names only itself; its sitemap entry names
      // the English page back.
      await addHreflang(crawlId, ids.get("/fr")!, [["fr", url("/fr")]]);
      await db.insert(sitemapHreflang).values(
        [
          ["en", url("/en")],
          ["fr", url("/fr")],
        ].map(([code, target]) => ({
          crawlId,
          url: url("/fr"),
          urlNormalised: url("/fr"),
          hreflangCode: code!,
          targetUrl: target!,
          sitemapSource: url("/sitemap.xml"),
        })),
      );
      expect(await findings("hreflang.missing-return-link", crawlId)).toHaveLength(1);

      await deriveSitemapHreflang(db, crawlId);
      expect(await findings("hreflang.missing-return-link", crawlId)).toHaveLength(0);
    });

    it("names every source that declared the one-way alternate", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [["fr", url("/fr")]], "html");
      await addHreflang(crawlId, ids.get("/en")!, [["fr", `${url("/fr")}#top`]], "header");
      await addHreflang(crawlId, ids.get("/en")!, [["en", url("/en")]], "sitemap");

      const found = await findings("hreflang.missing-return-link", crawlId);
      expect(found.map((f) => f.evidence)).toEqual([
        { target: url("/fr"), targetHasHreflang: false, sources: ["header", "html"] },
      ]);
    });

    // Unknown is not evidence: a target this crawl never fetched says nothing
    // about what it declares.
    it("is silent when the target was never crawled", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")],
        ["fr", "https://fr.example/bonjour"],
      ]);

      expect(await findings("hreflang.missing-return-link", crawlId)).toHaveLength(0);
    });

    // One finding per (page, alternate) pair, so a cluster wired one way round
    // is O(pages × languages) findings. The scan itself runs to the end of the
    // walk — the count is exact — and only the listing stops. Shared with
    // `hreflang.non-indexable-target`: both read this file's declaration scan.
    it("caps the findings and says how many pairs there really are", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 1;
      const targets = Array.from(
        { length: total },
        (_, i) => `/alt-${String(i).padStart(4, "0")}`,
      );
      const ids = await addPages(crawlId, ["/hub", ...targets]);
      // The hub names every alternate; not one of them names the hub back.
      await addHreflang(
        crawlId,
        ids.get("/hub")!,
        targets.map((path) => ["fr", url(path)] as [string, string]),
      );

      const found = await findings("hreflang.missing-return-link", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, ["/en", "/fr"]);
      await addHreflang(other, otherIds.get("/en")!, [["fr", url("/fr")]]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/en", "/fr"]);
      await addHreflang(mine, mineIds.get("/en")!, [["fr", url("/fr")]]);
      await addHreflang(mine, mineIds.get("/fr")!, [["en", url("/en")]]);

      expect(await findings("hreflang.missing-return-link", mine)).toHaveLength(0);
      expect(await findings("hreflang.missing-return-link", other)).toHaveLength(1);
    });
  });

  describe("hreflang.non-indexable-target", () => {
    it("fires when the alternate points at a redirect", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/en",
        { path: "/fr", fetchClass: "redirect", statusCode: 301 },
      ]);
      await addHreflang(crawlId, ids.get("/en")!, [["fr", url("/fr")]]);

      const found = await findings("hreflang.non-indexable-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "hreflang.non-indexable-target",
        severity: rule("hreflang.non-indexable-target").severity,
        pageId: ids.get("/en"),
        pageUrl: url("/en"),
        dedupeKey: `${url("/en")}→${url("/fr")}`,
      });
      expect(found[0]!.evidence).toEqual({
        target: url("/fr"),
        targetFetchClass: "redirect",
        targetIndexable: false,
        sources: ["html"],
      });
    });

    it("fires when the alternate points at a noindexed 200", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", { path: "/fr", robotsMeta: "noindex" }]);
      await addHreflang(crawlId, ids.get("/en")!, [["fr", url("/fr")]]);

      const found = await findings("hreflang.non-indexable-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        target: url("/fr"),
        targetFetchClass: "ok",
        targetIndexable: false,
        sources: ["html"],
      });
    });

    // `is_indexable` is false for a 404 as it is for a noindex, so an
    // ungated test of it would file a dead alternate under copy about "the
    // exclusion" — a directive that page never carried. The crawl's own
    // evidence about the 404 is what reports it; this rule stays silent.
    it("is silent when the alternate points at a page that is gone", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/en",
        { path: "/fr", fetchClass: "client_error", statusCode: 404 },
      ]);
      await addHreflang(crawlId, ids.get("/en")!, [["fr", url("/fr")]]);

      expect(await findings("hreflang.non-indexable-target", crawlId)).toHaveLength(0);
    });

    // The same silence for the other shapes `is_indexable` is false on: a
    // server error and a WAF block are faults the crawl reports as themselves.
    it("is silent on a blocked or erroring alternate", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/en",
        { path: "/fr", fetchClass: "server_error", statusCode: 503 },
        { path: "/de", fetchClass: "blocked", statusCode: 403 },
      ]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["fr", url("/fr")],
        ["de", url("/de")],
      ]);

      expect(await findings("hreflang.non-indexable-target", crawlId)).toHaveLength(0);
    });

    it("is silent on an indexable target, and on one that was never crawled", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["fr", url("/fr")],
        ["de", "https://de.example/hallo"],
      ]);

      expect(await findings("hreflang.non-indexable-target", crawlId)).toHaveLength(0);
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, ["/en", { path: "/fr", robotsMeta: "noindex" }]);
      await addHreflang(other, otherIds.get("/en")!, [["fr", url("/fr")]]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/en", "/fr"]);
      await addHreflang(mine, mineIds.get("/en")!, [["fr", url("/fr")]]);

      expect(await findings("hreflang.non-indexable-target", mine)).toHaveLength(0);
      expect(await findings("hreflang.non-indexable-target", other)).toHaveLength(1);
    });
  });

  /**
   * Phase 19 §4. Search engines read hreflang on the canonical, so a page that
   * hands its signals to another URL is not a version of anything: its
   * annotations are not evaluated, and it is not a member of anyone else's
   * cluster either. Both `hreflang.missing-return-link` findings on the crawl
   * that motivated this were parameter variants inheriting their template's
   * block — the block names the base URL, and the base URL, correctly, does not
   * name a tracking variant back.
   */
  describe("pages canonicalised elsewhere", () => {
    it("reports no missing return link for a variant that inherits the template's block", async () => {
      const crawlId = await newCrawl();
      const variants = ["/en?product-type=dress", "/en?srsltid=AfmBOo"];
      const ids = await addPages(crawlId, [
        "/en",
        "/fr",
        // The two shapes the real crawl found: a filter parameter and a Google
        // tracking parameter, each canonicalised to the base URL.
        ...variants.map((path) => ({ path, canonicalHtml: url("/en") })),
      ]);
      const cluster: Array<[string, string]> = [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ];
      for (const path of ["/en", "/fr", ...variants]) {
        await addHreflang(crawlId, ids.get(path)!, cluster);
      }

      expect(await findings("hreflang.missing-return-link", crawlId)).toHaveLength(0);
    });

    // The exhaustive form of the claim: one canonicalised page carrying one of
    // every fault this file knows how to report, and every rule silent. A rule
    // added to `hreflangRules` without the exclusion fails here rather than in
    // whichever crawl meets a parameter variant first.
    it("is invisible to every rule in the family, whatever it declares", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/variant?utm=1", canonicalHtml: url("/base") },
        "/base",
        { path: "/de", robotsMeta: "noindex" },
        "/uk",
      ]);
      // An invalid code, a target that does not point back, a non-indexable
      // target, no x-default, and no self-reference — five findings, from a
      // page nobody is asked to rank.
      await addHreflang(crawlId, ids.get("/variant?utm=1")!, [
        ["english-uk", url("/uk")],
        ["en", url("/base")],
        ["de", url("/de")],
      ]);

      for (const r of hreflangRules) {
        expect(await r.run(db, crawlId), r.id).toHaveLength(0);
      }
    });

    // The other side of the same rule: a canonicalised page is not a cluster
    // MEMBER either, so nothing is demanded of it and nothing is reported about
    // it here. What is wrong with that page is reported on that page, by the
    // canonical rules.
    it("is no member of anyone else's cluster, even when it is noindexed", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/en",
        { path: "/fr", canonicalHtml: url("/fr-base"), robotsMeta: "noindex" },
        "/fr-base",
      ]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ]);

      expect(await findings("hreflang.missing-return-link", crawlId)).toHaveLength(0);
      expect(await findings("hreflang.non-indexable-target", crawlId)).toHaveLength(0);
    });
  });

  // Phase 26c: a declaration also arrives from a `Link` header on ANY
  // classified response and from a sitemap entry tied to whatever page row its
  // loc matched. A redirect, a 404 or a robots-blocked row serves no version
  // anyone can rank, so it declares no cluster for the join rules or the
  // x-default rule to judge, exactly as `missing-self-reference` already reads it.
  describe("declaring pages that serve no content", () => {
    it("are silent in missing-return-link, non-indexable-target and missing-x-default", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/ok",
        { path: "/moved", fetchClass: "redirect", statusCode: 301 },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
        { path: "/blocked", fetchClass: "disallowed", statusCode: null },
        // The alternates: /fr names nobody back, /redir is a redirect.
        "/fr",
        { path: "/redir", fetchClass: "redirect", statusCode: 301 },
      ]);
      await db
        .update(pages)
        .set({ fetchReason: "robots.txt: Disallow: /blocked" })
        .where(eq(pages.id, ids.get("/blocked")!));
      // Each declarer names itself, /fr and /redir, and no x-default: a
      // missing return link, a non-indexable alternate and a missing fallback
      // on a page that served content.
      const block = (self: string): Array<[string, string]> => [
        ["en", url(self)],
        ["fr", url("/fr")],
        ["de", url("/redir")],
      ];
      await addHreflang(crawlId, ids.get("/moved")!, block("/moved"), "header");
      await addHreflang(crawlId, ids.get("/gone")!, block("/gone"), "header");
      await db.insert(sitemapHreflang).values(
        block("/blocked").map(([code, target]) => ({
          crawlId,
          url: url("/blocked"),
          urlNormalised: url("/blocked"),
          hreflangCode: code,
          targetUrl: target,
          sitemapSource: url("/sitemap.xml"),
        })),
      );
      expect(await deriveSitemapHreflang(db, crawlId)).toEqual({ rows: 3 });

      for (const id of [
        "hreflang.missing-return-link",
        "hreflang.non-indexable-target",
        "hreflang.missing-x-default",
      ]) {
        expect(await findings(id, crawlId), id).toHaveLength(0);
      }

      // The same block on a 200 still fires all three.
      await addHreflang(crawlId, ids.get("/ok")!, block("/ok"), "header");
      expect(
        (await findings("hreflang.missing-return-link", crawlId)).map((f) => [
          f.pageUrl,
          f.evidence.target,
        ]),
      ).toEqual([
        [url("/ok"), url("/fr")],
        [url("/ok"), url("/redir")],
      ]);
      expect(
        (await findings("hreflang.non-indexable-target", crawlId)).map((f) => [
          f.pageUrl,
          f.evidence.target,
        ]),
      ).toEqual([[url("/ok"), url("/redir")]]);
      expect(
        (await findings("hreflang.missing-x-default", crawlId)).map((f) => f.evidence.targets),
      ).toEqual([[url("/fr"), url("/ok"), url("/redir")]]);
    });
  });

  describe("hreflang.missing-self-reference", () => {
    it("fires on a page whose declared set leaves the page itself out", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/en-gb", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en-gb", url("/en-gb")],
        ["fr", url("/fr")],
      ]);

      const found = await findings("hreflang.missing-self-reference", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "hreflang.missing-self-reference",
        severity: rule("hreflang.missing-self-reference").severity,
        pageId: ids.get("/en"),
        pageUrl: url("/en"),
        dedupeKey: url("/en"),
      });
      // No `pageUrl` in the evidence: the runner already stamps it on every
      // finding's details blob, so carrying it here would be the same string
      // twice.
      expect(found[0]!.evidence).toEqual({
        codes: ["en-gb", "fr"],
        targets: [url("/en-gb"), url("/fr")],
        sources: ["html"],
      });
    });

    it("reads every source: a self-reference the sitemap states is one", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [["fr", url("/fr")]], "html");
      await addHreflang(crawlId, ids.get("/en")!, [["en", url("/en")]], "sitemap");
      await addHreflang(crawlId, ids.get("/fr")!, [["en", url("/en")]], "header");

      const found = await findings("hreflang.missing-self-reference", crawlId);
      expect(found.map((f) => [f.pageUrl, f.evidence])).toEqual([
        [url("/fr"), { codes: ["en"], targets: [url("/en")], sources: ["header"] }],
      ]);
    });

    it("is silent on a page that names itself among its alternates", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ]);

      expect(await findings("hreflang.missing-self-reference", crawlId)).toHaveLength(0);
    });

    // Both sides of the comparison go through `targetKey`, so a self-reference
    // written with a fragment is still a self-reference.
    it("accepts a self-reference declared in a spelling normalisation settles", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", `${url("/en")}#top`],
        ["fr", url("/fr")],
      ]);

      expect(await findings("hreflang.missing-self-reference", crawlId)).toHaveLength(0);
    });

    // The claim is about a page that serves a version someone could rank. A 404
    // carrying an inherited alternates block is reported as a 404.
    it("is silent on a page that did not answer 200", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
        "/fr",
      ]);
      await addHreflang(crawlId, ids.get("/gone")!, [["fr", url("/fr")]]);

      expect(await findings("hreflang.missing-self-reference", crawlId)).toHaveLength(0);
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, ["/en", "/fr"]);
      await addHreflang(other, otherIds.get("/en")!, [["fr", url("/fr")]]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/en", "/fr"]);
      await addHreflang(mine, mineIds.get("/en")!, [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ]);

      expect(await findings("hreflang.missing-self-reference", mine)).toHaveLength(0);
      expect(await findings("hreflang.missing-self-reference", other)).toHaveLength(1);
    });
  });

  /**
   * The NOT MEASURED marker. `hreflang.missing-return-link` reads back-links
   * only from targets that have a `pages` row, which on a multi-market site is
   * a minority of the cluster; the silence over the rest used to read as "the
   * return links are fine". One site-scoped finding says how big that gap is.
   */
  describe("hreflang.alternates-not-crawled", () => {
    it("fires once, grouped by target host, ordered by how many alternates each holds", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/en-2"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")], // fetched: not part of the gap
        ["fr", "https://fr.example/a"],
        ["de", "https://de.example/a"],
        ["de-at", "https://de.example/b"],
      ]);
      await addHreflang(crawlId, ids.get("/en-2")!, [
        ["en", url("/en-2")],
        ["de", "https://de.example/c"],
      ]);

      const found = await findings("hreflang.alternates-not-crawled", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "hreflang.alternates-not-crawled",
        severity: "info",
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
      });
      expect(found[0]!.evidence).toEqual({
        total: 4,
        hosts: [
          // `alternates` is distinct unfetched URLs on the host; `pages` is how
          // many pages of this crawl name at least one of them.
          { host: "de.example", alternates: 3, pages: 2 },
          { host: "fr.example", alternates: 1, pages: 1 },
        ],
      });
    });

    it("is silent when every declared alternate was fetched", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr"]);
      const cluster: Array<[string, string]> = [
        ["en", url("/en")],
        ["fr", url("/fr")],
      ];
      await addHreflang(crawlId, ids.get("/en")!, cluster);
      await addHreflang(crawlId, ids.get("/fr")!, cluster);

      expect(await findings("hreflang.alternates-not-crawled", crawlId)).toHaveLength(0);
    });

    // The same exclusion the rules apply: a page canonicalised elsewhere
    // declares nothing anyone acts on, so its alternates are not a gap in this
    // crawl's evidence.
    it("counts nothing declared by a page canonicalised elsewhere", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/en",
        { path: "/en?utm=1", canonicalHtml: url("/en") },
      ]);
      await addHreflang(crawlId, ids.get("/en")!, [["en", url("/en")]]);
      await addHreflang(crawlId, ids.get("/en?utm=1")!, [
        ["en", url("/en")],
        ["fr", "https://fr.example/a"],
      ]);

      expect(await findings("hreflang.alternates-not-crawled", crawlId)).toHaveLength(0);
    });

    it("counts nothing declared by a page that did not answer 200", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);
      await addHreflang(crawlId, ids.get("/gone")!, [["fr", "https://fr.example/a"]]);

      expect(await findings("hreflang.alternates-not-crawled", crawlId)).toHaveLength(0);
    });

    // A target `normalizeUrl` refuses is still an alternate nobody fetched. It
    // has no host to group under, so it groups under its scheme rather than
    // disappearing from the count.
    it("groups an alternate that is not a web address under its scheme", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en"]);
      await addHreflang(crawlId, ids.get("/en")!, [
        ["en", url("/en")],
        ["fr", "mailto:bonjour@example.com"],
      ]);

      const found = await findings("hreflang.alternates-not-crawled", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        total: 1,
        hosts: [{ host: "mailto:", alternates: 1, pages: 1 }],
      });
    });

    // The list is capped; the COUNT behind it is not. `hostsTruncated`, not
    // `truncated`: the latter is what a capped listing of findings writes, and
    // one evidence object must not spell two different facts the same way.
    it("caps the host list and says how many hosts there really are", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en"]);
      const hosts = Array.from(
        { length: ALTERNATE_HOST_CAP + 1 },
        (_, i) => `h${String(i).padStart(2, "0")}.example`,
      );
      await addHreflang(
        crawlId,
        ids.get("/en")!,
        hosts.map((host) => ["fr", `https://${host}/a`] as [string, string]),
      );

      const found = await findings("hreflang.alternates-not-crawled", crawlId);
      expect(found).toHaveLength(1);
      const evidence = found[0]!.evidence as {
        total: number;
        hosts: { host: string }[];
        hostsTruncated: unknown;
      };
      expect(evidence.total).toBe(ALTERNATE_HOST_CAP + 1);
      expect(evidence.hosts).toHaveLength(ALTERNATE_HOST_CAP);
      // Every host holds one alternate, so the tie-break is the host name: the
      // listed fifty are deterministic rather than whatever Postgres returned.
      expect(evidence.hosts.map((h) => h.host)).toEqual(hosts.slice(0, ALTERNATE_HOST_CAP));
      expect(evidence.hostsTruncated).toEqual({
        reported: ALTERNATE_HOST_CAP,
        total: ALTERNATE_HOST_CAP + 1,
      });
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, ["/en"]);
      await addHreflang(other, otherIds.get("/en")!, [["fr", "https://fr.example/a"]]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/en"]);
      await addHreflang(mine, mineIds.get("/en")!, [["en", url("/en")]]);

      expect(await findings("hreflang.alternates-not-crawled", mine)).toHaveLength(0);
      expect(await findings("hreflang.alternates-not-crawled", other)).toHaveLength(1);
    });
  });
});

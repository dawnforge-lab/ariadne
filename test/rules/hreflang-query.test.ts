import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, pages } from "../../src/db/schema.js";
import { hreflangRules } from "../../src/rules/query/hreflang.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

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
  it("defines exactly the four hreflang rules of the Phase 2 and Phase 3 tables", () => {
    expect(hreflangRules.map((r) => r.id).sort()).toEqual([
      "hreflang.invalid-code",
      "hreflang.missing-return-link",
      "hreflang.missing-x-default",
      "hreflang.non-indexable-target",
    ]);
  });

  it("claims exactly the checklist ids the tables assign", () => {
    expect(Object.fromEntries(hreflangRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "hreflang.invalid-code": ["CHECK-25"],
      "hreflang.missing-x-default": ["CHECK-25"],
      "hreflang.missing-return-link": ["CHECK-24"],
      "hreflang.non-indexable-target": ["CHECK-26"],
    });
  });

  it("carries the severities the tables assign", () => {
    expect(Object.fromEntries(hreflangRules.map((r) => [r.id, r.severity]))).toEqual({
      "hreflang.invalid-code": "warning",
      "hreflang.missing-x-default": "info",
      "hreflang.missing-return-link": "warning",
      "hreflang.non-indexable-target": "warning",
    });
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
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
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
  ): Promise<void> {
    await db.insert(hreflang).values(
      declarations.map(([code, target]) => ({
        crawlId,
        pageId,
        hreflangCode: code,
        targetUrl: target,
        targetPageId: null,
        source: "html",
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
      expect(one.severity).toBe("warning");
      expect(one.pageId).toBe(ids.get("/one"));
      expect(one.pageUrl).toBe(`${SITE}/one`);
      expect(one.evidence).toMatchObject({
        code: "english-uk",
        targetUrl: `${SITE}/uk`,
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
        severity: "warning",
        pageId: ids.get("/en"),
        pageUrl: url("/en"),
        dedupeKey: `${url("/en")}→${url("/fr")}`,
      });
      expect(found[0]!.evidence).toEqual({
        target: url("/fr"),
        targetHasHreflang: true,
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
      expect(found[0]!.evidence).toEqual({ target: url("/fr"), targetHasHreflang: false });
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
        severity: "warning",
        pageId: ids.get("/en"),
        pageUrl: url("/en"),
        dedupeKey: `${url("/en")}→${url("/fr")}`,
      });
      expect(found[0]!.evidence).toEqual({
        target: url("/fr"),
        targetFetchClass: "redirect",
        targetIndexable: false,
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
      });
    });

    it("fires when the alternate points at a page that is gone", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/en",
        { path: "/fr", fetchClass: "client_error", statusCode: 404 },
      ]);
      await addHreflang(crawlId, ids.get("/en")!, [["fr", url("/fr")]]);

      const found = await findings("hreflang.non-indexable-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ targetFetchClass: "client_error" });
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
      const otherIds = await addPages(other, [
        "/en",
        { path: "/fr", fetchClass: "client_error", statusCode: 404 },
      ]);
      await addHreflang(other, otherIds.get("/en")!, [["fr", url("/fr")]]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/en", "/fr"]);
      await addHreflang(mine, mineIds.get("/en")!, [["fr", url("/fr")]]);

      expect(await findings("hreflang.non-indexable-target", mine)).toHaveLength(0);
      expect(await findings("hreflang.non-indexable-target", other)).toHaveLength(1);
    });
  });
});

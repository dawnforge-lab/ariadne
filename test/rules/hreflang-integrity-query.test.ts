/**
 * The hreflang integrity rules (`hreflang.inconsistent-return-code`,
 * `hreflang.multiple-entries`, `hreflang.self-only`, `hreflang.unlinked-target`,
 * `hreflang.html-lang-mismatch` and, from Phase 26c, `hreflang.source-conflict`),
 * against a real database.
 *
 * Rows are inserted directly, as in hreflang-query.test.ts: what is under test
 * is what the rules make of the declarations and the link graph the crawler
 * stored. Every test opens its own crawl and the afterAll deletes them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, links, pages } from "../../src/db/schema.js";
import type { DiscoveryEvidence } from "../../src/crawl/loop.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import {
  hreflangIntegrityRules,
  ONLY_IN_CODES_CAP,
} from "../../src/rules/query/hreflang-integrity.js";
import { SAMPLE_SOURCES } from "../../src/rules/query/link-targets.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://integrity.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(hreflangIntegrityRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in hreflangIntegrityRules`);
  return r;
}

describe("hreflangIntegrityRules metadata", () => {
  it("defines exactly the six integrity rules", () => {
    expect(hreflangIntegrityRules.map((r) => r.id).sort()).toEqual([
      "hreflang.html-lang-mismatch",
      "hreflang.inconsistent-return-code",
      "hreflang.multiple-entries",
      "hreflang.self-only",
      "hreflang.source-conflict",
      "hreflang.unlinked-target",
    ]);
  });

  it("claims CHECK-24, the severities and the category the table assigns", () => {
    expect(
      Object.fromEntries(
        hreflangIntegrityRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]]),
      ),
    ).toEqual({
      "hreflang.html-lang-mismatch": [["CHECK-25"], "info", "hreflang"],
      "hreflang.inconsistent-return-code": [["CHECK-24"], "warning", "hreflang"],
      "hreflang.multiple-entries": [["CHECK-24"], "warning", "hreflang"],
      "hreflang.self-only": [["CHECK-24"], "info", "hreflang"],
      "hreflang.source-conflict": [["CHECK-24"], "warning", "hreflang"],
      "hreflang.unlinked-target": [["CHECK-24"], "info", "hreflang"],
    });
  });

  it("every rule is a query rule carrying copy and a ruleset version", () => {
    for (const r of hreflangIntegrityRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });
});

describe("hreflangIntegrityRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    canonicalHtml?: string;
    htmlLang?: string | null;
    extractionVersion?: number | null;
  }

  /**
   * A crawl row. Without `discovery` it carries none, as these tests always
   * have; `source-conflict` needs the Phase 26c `sitemapFacts` to judge at all.
   */
  async function newCrawl(discovery: DiscoveryEvidence | null = null): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
      discovery,
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(
    crawlId: string,
    specs: Array<string | PageSpec>,
  ): Promise<Map<string, string>> {
    const normalised = specs.map((s) => (typeof s === "string" ? { path: s } : s));
    const rows = normalised.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: writerIndexable(s),
      canonicalHtml: s.canonicalHtml ?? null,
      robotsMeta: s.robotsMeta ?? null,
      xRobotsTag: s.xRobotsTag ?? null,
      htmlLang: s.htmlLang === undefined ? null : s.htmlLang,
      extractionVersion: s.extractionVersion === undefined ? null : s.extractionVersion,
      depth: 1,
      discoveredVia: "link",
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(pages).values(rows.slice(i, i + 500));
    }
    return new Map(rows.map((r, i) => [normalised[i]!.path, r.id]));
  }

  async function declare(
    crawlId: string,
    ids: Map<string, string>,
    from: string,
    declarations: Array<[code: string, target: string]>,
    source = "html",
  ): Promise<void> {
    await db.insert(hreflang).values(
      declarations.map(([code, target]) => ({
        crawlId,
        pageId: ids.get(from)!,
        hreflangCode: code,
        targetUrl: target.startsWith("http") ? target : url(target),
        targetPageId: null,
        source,
      })),
    );
  }

  async function link(
    crawlId: string,
    ids: Map<string, string>,
    from: string,
    target: string,
    isInternal = true,
  ): Promise<void> {
    await db.insert(links).values({
      crawlId,
      sourcePageId: ids.get(from)!,
      targetUrl: target.startsWith("http") ? target : url(target),
      targetPageId: null,
      anchor: "read this",
      rel: null,
      isInternal,
      isNofollow: false,
      position: 0,
    });
  }

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
    for (const r of hreflangIntegrityRules) {
      expect(await r.run(db, crawlId), r.id).toHaveLength(0);
    }
  });

  it("no rule fires on a well-formed, linked hreflang cluster", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, ["/en", "/fr"]);
    const cluster: Array<[string, string]> = [
      ["en", "/en"],
      ["fr", "/fr"],
      ["x-default", "/en"],
    ];
    await declare(crawlId, ids, "/en", cluster);
    await declare(crawlId, ids, "/fr", cluster);
    await link(crawlId, ids, "/en", "/fr");
    await link(crawlId, ids, "/fr", "/en");
    for (const r of hreflangIntegrityRules) {
      expect(await r.run(db, crawlId), r.id).toHaveLength(0);
    }
  });

  describe("hreflang.inconsistent-return-code", () => {
    it("fires on A when B returns A under a code other than the one A names itself by", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/a"],
        ["fr", "/b"],
      ]);
      await declare(crawlId, ids, "/b", [
        ["en-gb", "/a"],
        ["fr", "/b"],
      ]);
      const found = await findings("hreflang.inconsistent-return-code", crawlId);
      expect(found).toHaveLength(1);
      const f = found[0]!;
      expect(f.ruleId).toBe("hreflang.inconsistent-return-code");
      expect(f.severity).toBe("warning");
      expect(f.pageId).toBe(ids.get("/a"));
      expect(f.pageUrl).toBe(url("/a"));
      expect(f.evidence).toEqual({
        hreflang: ["fr"],
        target: url("/b"),
        returnCode: ["en-gb"],
        selfCode: ["en"],
        sources: ["html"],
      });
      expect(f.dedupeKey).toBe(`${url("/a")}→${url("/b")}`);
    });

    it("compares codes case-insensitively and ignores padding", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [
        ["en-GB", "/a"],
        ["fr", "/b"],
      ]);
      await declare(crawlId, ids, "/b", [
        [" en-gb ", "/a"],
        ["FR", "/b"],
      ]);
      expect(await findings("hreflang.inconsistent-return-code", crawlId)).toHaveLength(0);
    });

    it("does not read x-default as a language code on either side", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/a"],
        ["fr", "/b"],
        ["x-default", "/a"],
      ]);
      await declare(crawlId, ids, "/b", [
        ["en", "/a"],
        ["fr", "/b"],
        ["x-default", "/a"],
      ]);
      expect(await findings("hreflang.inconsistent-return-code", crawlId)).toHaveLength(0);
    });

    it("makes no judgement when A has no self-reference (missing-self-reference owns that)", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [["fr", "/b"]]);
      await declare(crawlId, ids, "/b", [
        ["en-gb", "/a"],
        ["fr", "/b"],
      ]);
      expect(await findings("hreflang.inconsistent-return-code", crawlId)).toHaveLength(0);
    });

    it("makes no judgement when B does not return A, or B was never crawled", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/a"],
        ["fr", "/b"],
        ["de", "/never-crawled"],
      ]);
      await declare(crawlId, ids, "/b", [["fr", "/b"]]);
      expect(await findings("hreflang.inconsistent-return-code", crawlId)).toHaveLength(0);
    });

    it("matches a target spelled with a fragment, a host in capitals or a bare origin", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/a#top"],
        ["fr", "https://INTEGRITY.example"],
      ]);
      await declare(crawlId, ids, "/", [["en-gb", "/a?"]]);
      const found = await findings("hreflang.inconsistent-return-code", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ target: url("/"), returnCode: ["en-gb"] });
    });

    it("skips a declaring page canonicalised elsewhere and a non-auditable one", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/elsewhere") },
        "/b",
        { path: "/c", fetchClass: "client_error", statusCode: 404 },
      ]);
      for (const from of ["/a", "/c"]) {
        await declare(crawlId, ids, from, [
          ["en", from],
          ["fr", "/b"],
        ]);
      }
      await declare(crawlId, ids, "/b", [
        ["en-gb", "/a"],
        ["en-gb", "/c"],
        ["fr", "/b"],
      ]);
      expect(await findings("hreflang.inconsistent-return-code", crawlId)).toHaveLength(0);
    });

    it("reads every source: a return code stated in the sitemap or a header counts", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [["en", "/a"]], "header");
      await declare(crawlId, ids, "/a", [["fr", "/b"]], "sitemap");
      await declare(crawlId, ids, "/b", [["en-gb", "/a"], ["fr", "/b"]], "sitemap");
      const found = await findings("hreflang.inconsistent-return-code", crawlId);
      expect(found.map((f) => f.evidence)).toEqual([
        {
          hreflang: ["fr"],
          target: url("/b"),
          returnCode: ["en-gb"],
          selfCode: ["en"],
          sources: ["sitemap"],
        },
      ]);
    });

    it("reads en_GB and en-gb as one code", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [["en_GB", "/a"], ["fr", "/b"]]);
      await declare(crawlId, ids, "/b", [["en-gb", "/a"], ["fr", "/b"]]);
      expect(await findings("hreflang.inconsistent-return-code", crawlId)).toHaveLength(0);
    });

    it("caps what it lists and reports the exact total", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 3;
      const specs = ["/hub"];
      for (let i = 0; i < total; i += 1) specs.push(`/p-${String(i).padStart(4, "0")}`);
      const ids = await addPages(crawlId, specs);
      // The hub names itself `en` and returns every page under `en-gb`, while
      // every page names itself `en`: each page disagrees with the hub.
      await declare(crawlId, ids, "/hub", [
        ["en", "/hub"],
        ...specs.slice(1).map((p) => ["en-gb", p] as [string, string]),
      ]);
      for (const path of specs.slice(1)) {
        await declare(crawlId, ids, path, [
          ["en", path],
          ["de", "/hub"],
        ]);
      }
      const found = await findings("hreflang.inconsistent-return-code", crawlId);
      // Every page fires against the hub (hub returns page as en-gb, page is en);
      // the hub fires against none (pages return it as de, the hub is en: they
      // disagree too), so the total is pages + hub.
      expect(found).toHaveLength(URL_FINDING_CAP);
      const last = found[found.length - 1]!.evidence as { truncated?: { total: number } };
      expect(last.truncated).toEqual({ reported: URL_FINDING_CAP, total: total * 2 });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
    });
  });

  describe("hreflang.multiple-entries", () => {
    it("fires once per (page, code) listing two different targets, targets sorted", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/b"],
        ["en", "/a"],
        ["fr", "/b"],
      ]);
      const found = await findings("hreflang.multiple-entries", crawlId);
      expect(found).toHaveLength(1);
      const f = found[0]!;
      expect(f.severity).toBe("warning");
      expect(f.pageId).toBe(ids.get("/a"));
      expect(f.evidence).toEqual({
        hreflang: "en",
        targets: [url("/a"), url("/b")],
        sources: ["html"],
      });
      expect(f.dedupeKey).toBe(`${url("/a")}#en`);
    });

    it("counts codes case-insensitively: en-GB and en-gb are one code", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [
        ["en-GB", "/a"],
        ["en-gb ", "/b"],
      ]);
      const found = await findings("hreflang.multiple-entries", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ hreflang: "en-gb" });
    });

    it("does not call spellings of one URL two targets", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/a"],
        ["en", "/a#section"],
        ["en", "https://INTEGRITY.example/a"],
        ["en", "/a?"],
        ["fr", "https://integrity.example"],
        ["fr", "https://integrity.example/"],
        ["de", "/q?b=2&a=1"],
        ["de", "/q?a=1&b=2"],
      ]);
      expect(await findings("hreflang.multiple-entries", crawlId)).toHaveLength(0);
    });

    it("does not fire when one URL carries several codes", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/a"],
        ["x-default", "/a"],
        ["en-gb", "/a"],
      ]);
      expect(await findings("hreflang.multiple-entries", crawlId)).toHaveLength(0);
    });

    it("skips a canonicalised-elsewhere and a non-auditable declarer", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/elsewhere") },
        { path: "/b", fetchClass: "server_error", statusCode: 500 },
      ]);
      for (const from of ["/a", "/b"]) {
        await declare(crawlId, ids, from, [
          ["en", "/x"],
          ["en", "/y"],
        ]);
      }
      expect(await findings("hreflang.multiple-entries", crawlId)).toHaveLength(0);
    });

    // Deviation 5: one source giving a code two URLs is this rule's finding;
    // two sources giving it one URL each disagree with each other, and that is
    // `hreflang.source-conflict`'s, so one defect never fires both.
    it("counts targets within one source: one target in each of two sources does not fire", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a"]);
      await declare(crawlId, ids, "/a", [["de", "/x"]], "html");
      await declare(crawlId, ids, "/a", [["de", "/y"]], "sitemap");
      await declare(crawlId, ids, "/a", [["de", "/z"]], "header");
      expect(await findings("hreflang.multiple-entries", crawlId)).toHaveLength(0);
    });

    it("fires on two targets for one code in one non-HTML source, naming that source", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a"]);
      await declare(crawlId, ids, "/a", [["de", "/x"]], "html");
      await declare(crawlId, ids, "/a", [["de", "/x"], ["DE", "/y"], ["de ", "/y#top"]], "sitemap");
      const found = await findings("hreflang.multiple-entries", crawlId);
      expect(found.map((f) => [f.dedupeKey, f.evidence])).toEqual([
        [`${url("/a")}#de`, { hreflang: "de", targets: [url("/x"), url("/y")], sources: ["sitemap"] }],
      ]);
    });

    it("files one finding per (page, code) when two sources each list two targets", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a"]);
      await declare(crawlId, ids, "/a", [["de", "/x"], ["de", "/y"]], "html");
      await declare(crawlId, ids, "/a", [["de", "/y"], ["de", "/z"]], "header");
      const found = await findings("hreflang.multiple-entries", crawlId);
      expect(found.map((f) => f.evidence)).toEqual([
        { hreflang: "de", targets: [url("/x"), url("/y"), url("/z")], sources: ["header", "html"] },
      ]);
    });

    it("caps what it lists and reports the exact total", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 2;
      const specs: string[] = [];
      for (let i = 0; i < total; i += 1) specs.push(`/m-${String(i).padStart(4, "0")}`);
      const ids = await addPages(crawlId, specs);
      for (const path of specs) {
        await declare(crawlId, ids, path, [
          ["en", "/x"],
          ["en", "/y"],
        ]);
      }
      const found = await findings("hreflang.multiple-entries", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
    });
  });

  describe("hreflang.self-only", () => {
    it("fires on a page whose every declaration names itself, codes sorted", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/solo"]);
      await declare(crawlId, ids, "/solo", [
        ["x-default", "/solo"],
        ["en", "/solo#top"],
      ]);
      const found = await findings("hreflang.self-only", crawlId);
      expect(found).toHaveLength(1);
      const f = found[0]!;
      expect(f.severity).toBe("info");
      expect(f.pageId).toBe(ids.get("/solo"));
      expect(f.evidence).toEqual({ hreflang: ["en", "x-default"], sources: ["html"] });
      expect(f.dedupeKey).toBe(url("/solo"));
    });

    it("does not fire when any declaration names another page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await declare(crawlId, ids, "/a", [
        ["en", "/a"],
        ["fr", "/b"],
      ]);
      expect(await findings("hreflang.self-only", crawlId)).toHaveLength(0);
    });

    it("does not fire on a page with no declarations, or one declaring only elsewhere", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/none", "/other"]);
      await declare(crawlId, ids, "/other", [["fr", "/none"]]);
      expect(await findings("hreflang.self-only", crawlId)).toHaveLength(0);
    });

    it("skips a canonicalised-elsewhere and a non-auditable page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/elsewhere") },
        { path: "/b", fetchClass: "redirect", statusCode: 301 },
      ]);
      await declare(crawlId, ids, "/a", [["en", "/a"]]);
      await declare(crawlId, ids, "/b", [["en", "/b"]]);
      expect(await findings("hreflang.self-only", crawlId)).toHaveLength(0);
    });

    it("reads every source: a sitemap row naming another page means the page names one", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a"]);
      await declare(crawlId, ids, "/a", [["en", "/a"]], "html");
      await declare(crawlId, ids, "/a", [["fr", "/b"]], "sitemap");
      expect(await findings("hreflang.self-only", crawlId)).toHaveLength(0);
    });

    it("names every source that declared only the page itself", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a"]);
      await declare(crawlId, ids, "/a", [["en", "/a"]], "html");
      await declare(crawlId, ids, "/a", [["en", "/a"]], "sitemap");
      const found = await findings("hreflang.self-only", crawlId);
      expect(found.map((f) => f.evidence)).toEqual([{ hreflang: ["en"], sources: ["html", "sitemap"] }]);
    });

    it("caps what it lists and reports the exact total", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 2;
      const specs: string[] = [];
      for (let i = 0; i < total; i += 1) specs.push(`/s-${String(i).padStart(4, "0")}`);
      const ids = await addPages(crawlId, specs);
      for (const path of specs) await declare(crawlId, ids, path, [["en", path]]);
      const found = await findings("hreflang.self-only", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
    });
  });

  describe("hreflang.unlinked-target", () => {
    it("fires once on the target, with the declaring pages and their exact count", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/fr", "/de"]);
      await declare(crawlId, ids, "/en", [["de", "/de"]]);
      await declare(crawlId, ids, "/fr", [["de", "/de"]]);
      await link(crawlId, ids, "/en", "/fr");
      const found = await findings("hreflang.unlinked-target", crawlId);
      expect(found).toHaveLength(1);
      const f = found[0]!;
      expect(f.severity).toBe("info");
      expect(f.pageId).toBe(ids.get("/de"));
      expect(f.pageUrl).toBe(url("/de"));
      expect(f.evidence).toEqual({ sources: [url("/en"), url("/fr")], sourceCount: 2 });
      expect(f.dedupeKey).toBe(url("/de"));
    });

    it("does not fire when another page links the target", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/de", "/menu"]);
      await declare(crawlId, ids, "/en", [["de", "/de"]]);
      await link(crawlId, ids, "/menu", "/de");
      expect(await findings("hreflang.unlinked-target", crawlId)).toHaveLength(0);
    });

    it("counts a link from the declaring page itself", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/de"]);
      await declare(crawlId, ids, "/en", [["de", "/de"]]);
      await link(crawlId, ids, "/en", "/de");
      expect(await findings("hreflang.unlinked-target", crawlId)).toHaveLength(0);
    });

    it("does not count the target's link to itself, or a non-internal link row", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/de", "/ext"]);
      await declare(crawlId, ids, "/en", [["de", "/de"]]);
      await link(crawlId, ids, "/de", "/de");
      await link(crawlId, ids, "/ext", "/de", false);
      expect(await findings("hreflang.unlinked-target", crawlId)).toHaveLength(1);
    });

    it("does not treat a page's own self-reference as a declaring source", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/solo"]);
      await declare(crawlId, ids, "/solo", [["en", "/solo"]]);
      expect(await findings("hreflang.unlinked-target", crawlId)).toHaveLength(0);
    });

    it("never judges a target the crawl did not fetch as a page, or could not read", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        "/en",
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
        { path: "/moved", fetchClass: "redirect", statusCode: 301 },
        { path: "/canon", canonicalHtml: url("/elsewhere") },
      ]);
      await declare(crawlId, ids, "/en", [
        ["fr", "/gone"],
        ["de", "/moved"],
        ["es", "/canon"],
        ["it", "/never-crawled"],
        ["pt", "https://other.example/pt"],
      ]);
      expect(await findings("hreflang.unlinked-target", crawlId)).toHaveLength(0);
    });

    it("matches the target by its match key: a fragment or host in capitals still names it", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/en", "/de"]);
      await declare(crawlId, ids, "/en", [["de", "https://INTEGRITY.example/de#x"]]);
      const found = await findings("hreflang.unlinked-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageUrl).toBe(url("/de"));
    });

    it("ignores declarations from a page canonicalised elsewhere or not fetched", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/en", canonicalHtml: url("/elsewhere") },
        { path: "/404", fetchClass: "client_error", statusCode: 404 },
        "/de",
      ]);
      await declare(crawlId, ids, "/en", [["de", "/de"]]);
      await declare(crawlId, ids, "/404", [["de", "/de"]]);
      expect(await findings("hreflang.unlinked-target", crawlId)).toHaveLength(0);
    });

    it("samples at most SAMPLE_SOURCES declaring pages and counts all of them", async () => {
      const crawlId = await newCrawl();
      const n = SAMPLE_SOURCES + 4;
      const specs = ["/de"];
      for (let i = 0; i < n; i += 1) specs.push(`/s-${String(i).padStart(2, "0")}`);
      const ids = await addPages(crawlId, specs);
      for (const path of specs.slice(1)) await declare(crawlId, ids, path, [["de", "/de"]]);
      const found = await findings("hreflang.unlinked-target", crawlId);
      expect(found).toHaveLength(1);
      const sources = found[0]!.evidence.sources as string[];
      expect(sources).toHaveLength(SAMPLE_SOURCES);
      expect(sources).toEqual(specs.slice(1, SAMPLE_SOURCES + 1).map(url));
      expect(found[0]!.evidence.sourceCount).toBe(n);
    });

    it("samples each target's own declarers when two targets share them", async () => {
      const crawlId = await newCrawl();
      const n = SAMPLE_SOURCES + 3;
      const specs = ["/de", "/fr"];
      for (let i = 0; i < n; i += 1) specs.push(`/s-${String(i).padStart(2, "0")}`);
      const ids = await addPages(crawlId, specs);
      const declarers = specs.slice(2);
      // Every declarer names both targets.
      for (const path of declarers) {
        await declare(crawlId, ids, path, [
          ["de", "/de"],
          ["fr", "/fr"],
        ]);
      }
      // /fr also declares /de: it is a source for /de but never for itself.
      await declare(crawlId, ids, "/fr", [["de", "/de"]]);
      const found = await findings("hreflang.unlinked-target", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/de"), url("/fr")]);
      const [de, fr] = found;
      const sortedUrls = [...declarers.map(url), url("/fr")].sort();
      expect(de!.evidence.sourceCount).toBe(n + 1);
      expect(de!.evidence.sources).toEqual(sortedUrls.slice(0, SAMPLE_SOURCES));
      expect(fr!.evidence.sourceCount).toBe(n);
      expect(fr!.evidence.sources).toEqual(declarers.map(url).slice(0, SAMPLE_SOURCES));
    });

    it("caps what it lists and reports the exact total of targets", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 2;
      const specs = ["/en"];
      for (let i = 0; i < total; i += 1) specs.push(`/t-${String(i).padStart(4, "0")}`);
      const ids = await addPages(crawlId, specs);
      await declare(
        crawlId,
        ids,
        "/en",
        specs.slice(1).map((p) => ["xx", p] as [string, string]),
      );
      const found = await findings("hreflang.unlinked-target", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
    });

    it("lists everything when the crawl asks for no cap", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 2;
      const specs = ["/en"];
      for (let i = 0; i < total; i += 1) specs.push(`/u-${String(i).padStart(4, "0")}`);
      const ids = await addPages(crawlId, specs);
      await declare(
        crawlId,
        ids,
        "/en",
        specs.slice(1).map((p) => ["xx", p] as [string, string]),
      );
      const found = await rule("hreflang.unlinked-target").run(db, crawlId, {
        listing: null,
      } as Parameters<QueryRule["run"]>[2]);
      expect(found).toHaveLength(total);
      expect(found.some((f) => "truncated" in f.evidence)).toBe(false);
    });
  });

  describe("hreflang.source-conflict", () => {
    const run = (crawlId: string) => findings("hreflang.source-conflict", crawlId);
    const V3 = { extractionVersion: 3 };
    /** A Phase 26c crawl: v3 pages and a discovery that recorded `sitemapFacts`. */
    const newV3Crawl = () => newCrawl(mkDiscovery());

    it("fires when the HTML and the sitemap give one code different URLs", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [{ path: "/en/", ...V3 }]);
      await declare(crawlId, ids, "/en/", [["en", "/en/"], ["de", "/de/"]], "html");
      await declare(crawlId, ids, "/en/", [["en", "/en/"], ["de", "/de-de/"]], "sitemap");
      const found = await run(crawlId);
      expect(found).toHaveLength(1);
      const f = found[0]!;
      expect(f.ruleId).toBe("hreflang.source-conflict");
      expect(f.severity).toBe("warning");
      expect(f.pageId).toBe(ids.get("/en/"));
      expect(f.pageUrl).toBe(url("/en/"));
      expect(f.evidence).toEqual({
        code: "de",
        bySource: [
          { source: "html", targets: [url("/de/")] },
          { source: "sitemap", targets: [url("/de-de/")] },
        ],
        conflictingCodes: 1,
        onlyIn: [],
      });
      expect(f.dedupeKey).toBe(url("/en/"));
    });

    it("is silent when the header and the HTML name the same targets, however spelled", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [{ path: "/en", ...V3 }]);
      await declare(crawlId, ids, "/en", [["en", "/en"], ["de", "/de"]], "html");
      await declare(
        crawlId,
        ids,
        "/en",
        [["EN", "/en#top"], ["de", "https://INTEGRITY.example/de"]],
        "header",
      );
      expect(await run(crawlId)).toHaveLength(0);
    });

    // Deviation 4: Google unions the sources, so a code one source lists and
    // another omits is not a disagreement.
    it("is silent when the sitemap lists a code the HTML lacks", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [{ path: "/en", ...V3 }]);
      await declare(crawlId, ids, "/en", [["en", "/en"], ["de", "/de"]], "html");
      await declare(crawlId, ids, "/en", [["en", "/en"], ["de", "/de"], ["fr", "/fr"]], "sitemap");
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("is silent on a page annotated by one source, whatever it says", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [{ path: "/en", ...V3 }]);
      await declare(crawlId, ids, "/en", [["en", "/en"], ["de", "/de"], ["de", "/de-de"]], "sitemap");
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("lists the codes only one source gives, with the first conflicting code and the count", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [{ path: "/en", ...V3 }]);
      await declare(
        crawlId,
        ids,
        "/en",
        [["en", "/en"], ["de", "/de"], ["fr", "/fr"], ["es", "/es"]],
        "html",
      );
      await declare(
        crawlId,
        ids,
        "/en",
        [["en", "/en"], ["de", "/de-de"], ["fr", "/fr-fr"], ["it", "/it"]],
        "sitemap",
      );
      await declare(crawlId, ids, "/en", [["fr", "/fr"], ["nl", "/nl"]], "header");
      const found = await run(crawlId);
      expect(found.map((f) => f.evidence)).toEqual([
        {
          code: "de",
          bySource: [
            { source: "html", targets: [url("/de")] },
            { source: "sitemap", targets: [url("/de-de")] },
          ],
          conflictingCodes: 2,
          onlyIn: [
            { source: "header", codes: ["nl"] },
            { source: "html", codes: ["es"] },
            { source: "sitemap", codes: ["it"] },
          ],
        },
      ]);
    });

    it("compares single-target sources, codes normalised, x-default included", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [
        { path: "/a", ...V3 },
        { path: "/b", ...V3 },
        { path: "/c", ...V3 },
      ]);
      // /a: de_DE and de-de are one code. The HTML gives it two URLs and the
      // sitemap one of them: that is the HTML's ambiguity, multiple-entries'
      // finding, and it never fires this rule as well (deviation 5).
      await declare(crawlId, ids, "/a", [["de_DE", "/de"], ["de-de", "/de-2"]], "html");
      await declare(crawlId, ids, "/a", [["DE-DE", "/de"]], "sitemap");
      // /b: the fallback disagrees and nothing else does.
      await declare(crawlId, ids, "/b", [["x-default", "/b"]], "html");
      await declare(crawlId, ids, "/b", [["x-default", "/"]], "header");
      // /c: the same code spelled two ways, one URL each, and they differ.
      await declare(crawlId, ids, "/c", [["de_DE", "/de"]], "html");
      await declare(crawlId, ids, "/c", [["DE-DE", "/de-2"]], "sitemap");
      const found = await run(crawlId);
      expect(found.map((f) => [f.pageUrl, f.evidence])).toEqual([
        [
          url("/b"),
          {
            code: "x-default",
            bySource: [
              { source: "header", targets: [url("/")] },
              { source: "html", targets: [url("/b")] },
            ],
            conflictingCodes: 1,
            onlyIn: [],
          },
        ],
        [
          url("/c"),
          {
            code: "de-de",
            bySource: [
              { source: "html", targets: [url("/de")] },
              { source: "sitemap", targets: [url("/de-2")] },
            ],
            conflictingCodes: 1,
            onlyIn: [],
          },
        ],
      ]);
    });

    // Deviation 5, both ways round: an ambiguous source beside a single-target
    // one is one defect, and only multiple-entries reports it.
    it("is silent when one source gives a code {a,b} and another {a}", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [
        { path: "/x", ...V3 },
        { path: "/y", ...V3 },
      ]);
      await declare(crawlId, ids, "/x", [["de", "/de"], ["de", "/de-2"]], "html");
      await declare(crawlId, ids, "/x", [["de", "/de"]], "sitemap");
      await declare(crawlId, ids, "/y", [["de", "/de"]], "html");
      await declare(crawlId, ids, "/y", [["de", "/de"], ["de", "/de-2"]], "header");
      expect(await run(crawlId)).toHaveLength(0);
      expect(
        (await findings("hreflang.multiple-entries", crawlId)).map((f) => [
          f.pageUrl,
          f.evidence.sources,
        ]),
      ).toEqual([
        [url("/x"), ["html"]],
        [url("/y"), ["header"]],
      ]);
    });

    it("never counts a row stored twice as a second source or a second target", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [{ path: "/en", ...V3 }]);
      await declare(crawlId, ids, "/en", [["de", "/de"], ["de", "/de"]], "html");
      await declare(crawlId, ids, "/en", [["de", "/de"], ["de", "/de"]], "sitemap");
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("caps the codes it lists per source and says how many there were", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [{ path: "/en", ...V3 }]);
      const extra = Array.from(
        { length: ONLY_IN_CODES_CAP + 2 },
        (_, i) =>
          `x${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`,
      );
      await declare(crawlId, ids, "/en", [["de", "/de"]], "html");
      await declare(
        crawlId,
        ids,
        "/en",
        [["de", "/de-de"], ...extra.map((c) => [c, `/${c}`] as [string, string])],
        "sitemap",
      );
      const [f] = await run(crawlId);
      expect(f!.evidence.onlyIn).toEqual([
        { source: "sitemap", codes: [...extra].sort().slice(0, ONLY_IN_CODES_CAP) },
      ]);
      expect(f!.evidence.onlyInTruncated).toEqual({
        reported: ONLY_IN_CODES_CAP,
        total: ONLY_IN_CODES_CAP + 2,
      });
    });

    it("skips a page canonicalised elsewhere and one that did not answer 200", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/elsewhere"), ...V3 },
        { path: "/b", fetchClass: "client_error", statusCode: 404, ...V3 },
      ]);
      for (const from of ["/a", "/b"]) {
        await declare(crawlId, ids, from, [["de", "/de"]], "html");
        await declare(crawlId, ids, from, [["de", "/de-de"]], "sitemap");
      }
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("is silent on a crawl with any page below extraction 3 (the marker speaks)", async () => {
      const crawlId = await newV3Crawl();
      const ids = await addPages(crawlId, [
        { path: "/en", ...V3 },
        { path: "/old", extractionVersion: 2 },
      ]);
      await declare(crawlId, ids, "/en", [["de", "/de"]], "html");
      await declare(crawlId, ids, "/en", [["de", "/de-de"]], "sitemap");
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("is silent on a crawl whose discovery recorded no sitemap facts (the marker speaks)", async () => {
      for (const discovery of [null, mkDiscovery({ sitemapFacts: null })]) {
        const crawlId = await newCrawl(discovery);
        const ids = await addPages(crawlId, [{ path: "/en", ...V3 }]);
        await declare(crawlId, ids, "/en", [["de", "/de"]], "html");
        await declare(crawlId, ids, "/en", [["de", "/de-de"]], "header");
        expect(await run(crawlId)).toHaveLength(0);
      }
    });

    it("caps what it lists and reports the exact total", async () => {
      const crawlId = await newV3Crawl();
      const total = URL_FINDING_CAP + 2;
      const specs: PageSpec[] = [];
      for (let i = 0; i < total; i += 1) {
        specs.push({ path: `/c-${String(i).padStart(4, "0")}`, ...V3 });
      }
      const ids = await addPages(crawlId, specs);
      for (const { path } of specs) {
        await declare(crawlId, ids, path, [["de", "/de"]], "html");
        await declare(crawlId, ids, path, [["de", "/de-de"]], "sitemap");
      }
      const found = await run(crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
    });
  });

  describe("hreflang.html-lang-mismatch", () => {
    const run = (crawlId: string) => findings("hreflang.html-lang-mismatch", crawlId);
    const V2 = { extractionVersion: 2 };

    it("fires when lang=de and the self hreflang is en, with both in the evidence", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a", htmlLang: "de", ...V2 }]);
      await declare(crawlId, ids, "/a", [["en", "/a"], ["x-default", "/a"]]);
      const found = await run(crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        htmlLang: "de",
        hreflangCodes: ["en"],
        sources: ["html"],
      });
    });

    it("is silent when only the region differs (en-US against en-gb)", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a", htmlLang: "en-US", ...V2 }]);
      await declare(crawlId, ids, "/a", [["en-gb", "/a"]]);
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("splits the primary subtag on _ as well as - (lang=en_US against en-us)", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", htmlLang: "en_US", ...V2 },
        { path: "/b", htmlLang: "en", ...V2 },
        { path: "/c", htmlLang: "de_DE", ...V2 },
      ]);
      await declare(crawlId, ids, "/a", [["en-us", "/a"]]);
      await declare(crawlId, ids, "/b", [["en_GB", "/b"]]);
      await declare(crawlId, ids, "/c", [["en_GB", "/c"]]);
      const found = await run(crawlId);
      expect(found.map((f) => f.evidence)).toEqual([
        { htmlLang: "de_DE", hreflangCodes: ["en-gb"], sources: ["html"] },
      ]);
    });

    it("is silent when any self code shares the language", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a", htmlLang: "fr", ...V2 }]);
      await declare(crawlId, ids, "/a", [["en", "/a"], ["fr-CA", "/a"]]);
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("never compares x-default, and a page naming only x-default has no code", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a", htmlLang: "de", ...V2 }]);
      await declare(crawlId, ids, "/a", [["x-default", "/a"]]);
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("is silent on a page with no lang", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a", htmlLang: null, ...V2 }]);
      await declare(crawlId, ids, "/a", [["en", "/a"]]);
      expect(await run(crawlId)).toHaveLength(0);
    });

    it("ignores the code a page gives another page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", htmlLang: "de", ...V2 },
        { path: "/b", htmlLang: "de", ...V2 },
      ]);
      await declare(crawlId, ids, "/a", [["de", "/a"], ["en", "/b"]]);
      expect(await run(crawlId)).toHaveLength(0);
    });

    // A self code from the sitemap or the Link header is the same claim about
    // the page's language as one from its HTML, and search engines act on it.
    it("reads a self code declared in the sitemap or a Link header", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", htmlLang: "de", ...V2 },
        { path: "/b", htmlLang: "de", ...V2 },
      ]);
      await declare(crawlId, ids, "/a", [["en", "/a"]], "sitemap");
      await declare(crawlId, ids, "/b", [["en", "/b"]], "header");
      await declare(crawlId, ids, "/b", [["en", "/b"]], "html");
      const found = await run(crawlId);
      expect(found.map((f) => [f.pageUrl, f.evidence])).toEqual([
        [url("/a"), { htmlLang: "de", hreflangCodes: ["en"], sources: ["sitemap"] }],
        [url("/b"), { htmlLang: "de", hreflangCodes: ["en"], sources: ["header", "html"] }],
      ]);
    });

    it("is silent on a crawl with any page below extraction 2 (the marker speaks)", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", htmlLang: "de", ...V2 },
        { path: "/old", extractionVersion: 1 },
      ]);
      await declare(crawlId, ids, "/a", [["en", "/a"]]);
      expect(await run(crawlId)).toHaveLength(0);
    });
  });

  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    const otherIds = await addPages(other, ["/solo"]);
    await declare(other, otherIds, "/solo", [["en", "/solo"]]);
    const mine = await newCrawl();
    await addPages(mine, ["/solo"]);
    expect(await findings("hreflang.self-only", mine)).toHaveLength(0);
    expect(await findings("hreflang.self-only", other)).toHaveLength(1);
  });
});

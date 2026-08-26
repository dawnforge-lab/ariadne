import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, pages } from "../../src/db/schema.js";
import { hreflangRules } from "../../src/rules/query/hreflang.js";
import type { QueryRule } from "../../src/rules/registry/types.js";

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
  it("defines exactly the two hreflang rules of the Phase 2 table", () => {
    expect(hreflangRules.map((r) => r.id).sort()).toEqual([
      "hreflang.invalid-code",
      "hreflang.missing-x-default",
    ]);
  });

  it("claims exactly the checklist ids the table assigns", () => {
    expect(Object.fromEntries(hreflangRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "hreflang.invalid-code": ["CHECK-25"],
      "hreflang.missing-x-default": ["CHECK-25"],
    });
  });

  it("carries the severities the table assigns", () => {
    expect(Object.fromEntries(hreflangRules.map((r) => [r.id, r.severity]))).toEqual({
      "hreflang.invalid-code": "warning",
      "hreflang.missing-x-default": "info",
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

  /** One page row per path, returning the page ids by path. */
  async function addPages(crawlId: string, paths: string[]): Promise<Map<string, string>> {
    const rows = paths.map((path) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${path}`,
      urlNormalised: `${SITE}${path}`,
      fetchClass: "ok",
      statusCode: 200,
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [paths[i]!, r.id]));
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

  it("neither rule fires on a crawl with no hreflang declarations at all", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/alone"]);
    for (const r of hreflangRules) {
      expect(await r.run(db, crawlId), r.id).toHaveLength(0);
    }
  });

  it("neither rule fires on a well-formed hreflang cluster", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, ["/en"]);
    await addHreflang(crawlId, ids.get("/en")!, [
      ["en", `${SITE}/en`],
      ["en-gb", `${SITE}/en-gb`],
      ["es-419", `${SITE}/es-419`],
      ["fil", `${SITE}/fil`],
      ["x-default", `${SITE}/`],
    ]);
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

      const findings = await rule("hreflang.invalid-code").run(db, crawlId);
      expect(findings.map((f) => f.evidence.code).sort()).toEqual(["english-uk", "zz-qqqq"]);
      const one = findings.find((f) => f.evidence.code === "english-uk")!;
      expect(one.ruleId).toBe("hreflang.invalid-code");
      expect(one.severity).toBe("warning");
      expect(one.pageId).toBe(ids.get("/one"));
      expect(one.pageUrl).toBe(`${SITE}/one`);
      expect(one.evidence).toMatchObject({
        code: "english-uk",
        targetUrl: `${SITE}/uk`,
      });
      expect(one.dedupeKey).toBe(`${SITE}/one#english-uk`);
      expect(findings.find((f) => f.evidence.code === "zz-qqqq")!.dedupeKey).toBe(
        `${SITE}/two#zz-qqqq`,
      );
    });

    // The analyzer stores the attribute verbatim, so a code the author padded
    // with a space reaches the rule padded. It is a valid code either way.
    it("does not fire on a valid code carrying surrounding whitespace", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/padded"]);
      await addHreflang(crawlId, ids.get("/padded")!, [["en-GB ", `${SITE}/en-gb`]]);

      expect(await rule("hreflang.invalid-code").run(db, crawlId)).toHaveLength(0);
    });

    it("reports the trimmed code, in the evidence and the dedupe key", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/padded-bad"]);
      await addHreflang(crawlId, ids.get("/padded-bad")!, [["english-uk ", `${SITE}/uk`]]);

      const findings = await rule("hreflang.invalid-code").run(db, crawlId);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.evidence.code).toBe("english-uk");
      expect(findings[0]!.dedupeKey).toBe(`${SITE}/padded-bad#english-uk`);
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, ["/foreign"]);
      await addHreflang(other, otherIds.get("/foreign")!, [["nonsense-code", `${SITE}/x`]]);

      const mine = await newCrawl();
      const mineIds = await addPages(mine, ["/mine"]);
      await addHreflang(mine, mineIds.get("/mine")!, [["en", `${SITE}/mine`]]);

      expect(await rule("hreflang.invalid-code").run(db, mine)).toHaveLength(0);
      expect(await rule("hreflang.invalid-code").run(db, other)).toHaveLength(1);
    });
  });

  describe("hreflang.missing-x-default", () => {
    it("fires once for the site when declarations exist but none is x-default", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ["/a", "/b"]);
      await addHreflang(crawlId, ids.get("/a")!, [
        ["en", `${SITE}/a`],
        ["fr", `${SITE}/fr/a`],
      ]);
      await addHreflang(crawlId, ids.get("/b")!, [["en", `${SITE}/b`]]);

      const findings = await rule("hreflang.missing-x-default").run(db, crawlId);
      expect(findings).toHaveLength(1);
      expect(findings[0]!).toMatchObject({
        ruleId: "hreflang.missing-x-default",
        pageId: null,
        pageUrl: null,
        severity: "info",
        dedupeKey: "site",
      });
      expect(findings[0]!.evidence).toEqual({ declarations: 3 });
    });

    it("is silent when one x-default exists anywhere in the crawl, whatever its case", async () => {
      // The padded form counts too: the analyzer stores the attribute verbatim,
      // and a stray space must not report the whole site as lacking a fallback.
      for (const code of ["x-default", "X-Default", " x-default "]) {
        const crawlId = await newCrawl();
        const ids = await addPages(crawlId, ["/a", "/fallback"]);
        await addHreflang(crawlId, ids.get("/a")!, [["en", `${SITE}/a`]]);
        await addHreflang(crawlId, ids.get("/fallback")!, [[code, `${SITE}/`]]);
        expect(await rule("hreflang.missing-x-default").run(db, crawlId), code).toHaveLength(0);
      }
    });
  });
});

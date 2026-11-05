/**
 * The security rules, against a real database (Phase 26a).
 *
 * Rows are inserted directly: what is under test is what the rules make of
 * `pages.response_headers`, `pages.extraction_version` and `page_resources`, not
 * the crawling. The fixture site is plain HTTP, so every HTTPS case lives here
 * (see `SKIP_HARNESS_CLAIMS` in test/fixtures/harness.test.ts).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pageResources, pages } from "../../src/db/schema.js";
import type { StoredResponseHeaders } from "../../src/crawl/response-headers.js";
import { DEFAULT_RULE_CAPS } from "../../src/rules/query/crawl-evidence.js";
import { BROKEN_SAMPLE_RESOURCES } from "../../src/rules/query/resources.js";
import { missingSecurityHeaders, securityRules } from "../../src/rules/query/security.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const HTTPS_SITE = "https://secure.example";
const HTTP_SITE = "http://plain.example";

const byId = new Map(securityRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in securityRules`);
  return r;
}

/** Headers of a page that passes every check. */
function fullHeaders(): StoredResponseHeaders {
  return {
    values: {
      "strict-transport-security": ["max-age=31536000"],
      "content-security-policy": ["default-src 'self'"],
      "x-content-type-options": ["nosniff"],
      "x-frame-options": ["DENY"],
      "referrer-policy": ["strict-origin-when-cross-origin"],
    },
    truncated: [],
  };
}

function headers(overrides: Record<string, string[] | null>): StoredResponseHeaders {
  const h = fullHeaders();
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete h.values[name];
    else h.values[name] = value;
  }
  return h;
}

describe("securityRules metadata", () => {
  it("defines the five security rules", () => {
    expect(securityRules.map((r) => r.id).sort()).toEqual([
      "security.headers-missing",
      "security.headers-not-recorded",
      "security.hsts-missing",
      "security.http-url",
      "security.mixed-content",
    ]);
  });

  it("claims the checklist ids, severities and categories the plan assigns", () => {
    expect(
      Object.fromEntries(securityRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "security.hsts-missing": [["CHECK-84"], "warning", "technical"],
      "security.headers-missing": [["CHECK-84"], "info", "technical"],
      "security.headers-not-recorded": [["CHECK-84"], "info", "technical"],
      "security.http-url": [["CHECK-14"], "warning", "host"],
      "security.mixed-content": [["CHECK-85"], "warning", "technical"],
    });
  });

  it("only the not-recorded rule is a marker", () => {
    expect(securityRules.filter((r) => r.marker !== undefined).map((r) => r.id)).toEqual([
      "security.headers-not-recorded",
    ]);
  });
});

describe("missingSecurityHeaders", () => {
  it("returns nothing missing when every header is present", () => {
    expect(missingSecurityHeaders(fullHeaders())).toEqual({ missing: [], referrerPolicy: null });
  });

  it("lists everything, in order, on an empty page", () => {
    expect(missingSecurityHeaders({ values: {}, truncated: [] })).toEqual({
      missing: [
        "content-security-policy",
        "x-content-type-options",
        "frame-protection",
        "referrer-policy",
      ],
      referrerPolicy: null,
    });
  });

  it("does not count a report-only CSP", () => {
    const h = headers({
      "content-security-policy": null,
      "content-security-policy-report-only": ["default-src 'self'"],
    });
    expect(missingSecurityHeaders(h).missing).toContain("content-security-policy");
  });

  it("accepts nosniff in any case and rejects any other value", () => {
    expect(
      missingSecurityHeaders(headers({ "x-content-type-options": ["NOSNIFF"] })).missing,
    ).toEqual([]);
    expect(
      missingSecurityHeaders(headers({ "x-content-type-options": ["sniff"] })).missing,
    ).toEqual(["x-content-type-options"]);
  });

  it("takes frame protection from X-Frame-Options or from a CSP frame-ancestors", () => {
    const viaCsp = headers({
      "x-frame-options": null,
      "content-security-policy": ["default-src 'self'; frame-ancestors 'self'"],
    });
    expect(missingSecurityHeaders(viaCsp).missing).not.toContain("frame-protection");
    expect(
      missingSecurityHeaders(headers({ "x-frame-options": null })).missing,
    ).toEqual(["frame-protection"]);
    expect(
      missingSecurityHeaders(headers({ "x-frame-options": ["ALLOW-FROM https://a.example"] }))
        .missing,
    ).toEqual(["frame-protection"]);
    expect(
      missingSecurityHeaders(headers({ "x-frame-options": ["sameorigin"] })).missing,
    ).toEqual([]);
  });

  it("reads every occurrence of a repeated Referrer-Policy and applies the last recognised token", () => {
    // CDN safe, app unsafe: the combined header ends on unsafe-url.
    expect(
      missingSecurityHeaders(
        headers({ "referrer-policy": ["strict-origin-when-cross-origin", "unsafe-url"] }),
      ),
    ).toEqual({ missing: ["referrer-policy"], referrerPolicy: "unsafe-url" });
    // And the reverse is safe, not an accusation.
    expect(
      missingSecurityHeaders(
        headers({ "referrer-policy": ["unsafe-url", "strict-origin-when-cross-origin"] }),
      ),
    ).toEqual({ missing: [], referrerPolicy: null });
    // An unrecognised token does not displace the last recognised one.
    expect(
      missingSecurityHeaders(headers({ "referrer-policy": ["no-referrer, unsafe-url, bogus"] })),
    ).toEqual({ missing: ["referrer-policy"], referrerPolicy: "unsafe-url" });
    expect(
      missingSecurityHeaders(headers({ "referrer-policy": ["no-referrer, bogus"] })),
    ).toEqual({ missing: [], referrerPolicy: null });
    // Nothing recognised is no policy at all.
    expect(missingSecurityHeaders(headers({ "referrer-policy": ["bogus"] }))).toEqual({
      missing: ["referrer-policy"],
      referrerPolicy: null,
    });
  });

  it("takes frame-ancestors from any CSP occurrence, not just the first", () => {
    const h = headers({
      "x-frame-options": null,
      "content-security-policy": ["default-src 'self'", "frame-ancestors 'none'"],
    });
    expect(missingSecurityHeaders(h).missing).toEqual([]);
  });

  it("does not claim frame protection is missing from a CSP cut at the storage cap", () => {
    const cut = headers({
      "x-frame-options": null,
      "content-security-policy": ["default-src 'self'; script-src a b c"],
    });
    cut.truncated = ["content-security-policy"];
    expect(missingSecurityHeaders(cut).missing).toEqual([]);
    // A whole policy with no frame-ancestors still reports it.
    const whole = headers({
      "x-frame-options": null,
      "content-security-policy": ["default-src 'self'"],
    });
    expect(missingSecurityHeaders(whole).missing).toEqual(["frame-protection"]);
  });

  it("judges Referrer-Policy on an unsafe last token as well as on absence", () => {
    expect(missingSecurityHeaders(headers({ "referrer-policy": ["unsafe-url"] }))).toEqual({
      missing: ["referrer-policy"],
      referrerPolicy: "unsafe-url",
    });
    // The browser applies the last understood policy, so the last token decides.
    expect(
      missingSecurityHeaders(headers({ "referrer-policy": ["no-referrer, unsafe-url"] })),
    ).toEqual({ missing: ["referrer-policy"], referrerPolicy: "unsafe-url" });
    expect(
      missingSecurityHeaders(headers({ "referrer-policy": ["unsafe-url, no-referrer"] })),
    ).toEqual({ missing: [], referrerPolicy: null });
    expect(missingSecurityHeaders(headers({ "referrer-policy": null }))).toEqual({
      missing: ["referrer-policy"],
      referrerPolicy: null,
    });
  });
});

describe("securityRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec {
    url: string;
    extractionVersion?: number | null;
    headers?: StoredResponseHeaders | null;
    statusCode?: number;
    fetchClass?: string;
  }

  async function newCrawl(siteUrl: string): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ id, siteUrl, config: {}, rulesetVersion: "test" });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: s.url,
      urlNormalised: s.url.toLowerCase().replace(/\/$/, ""),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode ?? 200,
      extractionVersion: s.extractionVersion === undefined ? 1 : s.extractionVersion,
      responseHeaders: s.headers === undefined ? fullHeaders() : s.headers,
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r) => [r.url, r.id]));
  }

  async function run(id: string, crawlId: string, listing?: number | null): Promise<Finding[]> {
    const caps = listing === undefined ? undefined : { ...DEFAULT_RULE_CAPS, listing };
    return rule(id).run(db, crawlId, caps);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  describe("a crawl written before Phase 25 (review focus 1)", () => {
    it("files the marker and no header findings, never a clean result", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(crawl, [
        { url: `${HTTPS_SITE}/a`, extractionVersion: null, headers: null },
        { url: `${HTTPS_SITE}/b`, extractionVersion: null, headers: null },
      ]);
      expect(await run("security.hsts-missing", crawl)).toEqual([]);
      expect(await run("security.headers-missing", crawl)).toEqual([]);
      const marker = await run("security.headers-not-recorded", crawl);
      expect(marker).toHaveLength(1);
      expect(marker[0]).toMatchObject({
        ruleId: "security.headers-not-recorded",
        severity: "info",
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
        evidence: { pagesNotRecorded: 2, pagesRecorded: 0 },
      });
    });

    it("files the marker on a mixed crawl and judges none of it", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(crawl, [
        { url: `${HTTPS_SITE}/old`, extractionVersion: null, headers: null },
        { url: `${HTTPS_SITE}/new`, headers: { values: {}, truncated: [] } },
      ]);
      expect(await run("security.hsts-missing", crawl)).toEqual([]);
      expect(await run("security.headers-missing", crawl)).toEqual([]);
      const marker = await run("security.headers-not-recorded", crawl);
      expect(marker.map((f) => f.evidence)).toEqual([
        { pagesNotRecorded: 1, pagesRecorded: 1 },
      ]);
    });

    it("stays quiet when there is no HTTPS page to have judged", async () => {
      const crawl = await newCrawl(HTTP_SITE);
      await addPages(crawl, [
        { url: `${HTTP_SITE}/a`, extractionVersion: null, headers: null },
      ]);
      expect(await run("security.headers-not-recorded", crawl)).toEqual([]);
    });
  });

  describe("a current crawl", () => {
    it("the marker is silent", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(crawl, [{ url: `${HTTPS_SITE}/a` }]);
      expect(await run("security.headers-not-recorded", crawl)).toEqual([]);
    });

    it("hsts-missing files one finding per HTTPS page without HSTS", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [
        { url: `${HTTPS_SITE}/with` },
        { url: `${HTTPS_SITE}/without`, headers: headers({ "strict-transport-security": null }) },
        // Not a 200, so not judged.
        {
          url: `${HTTPS_SITE}/gone`,
          statusCode: 404,
          headers: headers({ "strict-transport-security": null }),
        },
      ]);
      const found = await run("security.hsts-missing", crawl);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        ruleId: "security.hsts-missing",
        severity: "warning",
        pageId: ids.get(`${HTTPS_SITE}/without`),
        pageUrl: `${HTTPS_SITE}/without`,
        dedupeKey: `${HTTPS_SITE}/without`,
        evidence: {},
      });
    });

    it("hsts-missing refuses an HTTPS 200 with no stored headers rather than reading it as missing", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(crawl, [{ url: `${HTTPS_SITE}/odd`, headers: null }]);
      await expect(run("security.hsts-missing", crawl)).rejects.toThrow(/no stored response headers/);
      await expect(run("security.headers-missing", crawl)).rejects.toThrow(
        /no stored response headers/,
      );
    });

    it("a null-headers HTTPS 200 throws even when it sits past the listing cap", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(crawl, [
        { url: `${HTTPS_SITE}/a`, headers: { values: {}, truncated: [] } },
        { url: `${HTTPS_SITE}/b`, headers: { values: {}, truncated: [] } },
        { url: `${HTTPS_SITE}/z`, headers: null },
      ]);
      await expect(run("security.hsts-missing", crawl, 1)).rejects.toThrow(
        /no stored response headers/,
      );
      await expect(run("security.headers-missing", crawl, 1)).rejects.toThrow(
        /no stored response headers/,
      );
    });

    it("headers-missing names which headers, and the unsafe referrer value", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(crawl, [
        { url: `${HTTPS_SITE}/clean` },
        {
          url: `${HTTPS_SITE}/bare`,
          headers: headers({
            "content-security-policy": null,
            "x-frame-options": null,
            "referrer-policy": ["unsafe-url"],
          }),
        },
      ]);
      const found = await run("security.headers-missing", crawl);
      expect(found.map((f) => [f.pageUrl, f.evidence])).toEqual([
        [
          `${HTTPS_SITE}/bare`,
          {
            missing: ["content-security-policy", "frame-protection", "referrer-policy"],
            referrerPolicy: "unsafe-url",
          },
        ],
      ]);
    });

    it("headers-missing leaves referrerPolicy out when the header was simply absent", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(crawl, [
        { url: `${HTTPS_SITE}/a`, headers: headers({ "referrer-policy": null }) },
      ]);
      const found = await run("security.headers-missing", crawl);
      expect(found.map((f) => f.evidence)).toEqual([{ missing: ["referrer-policy"] }]);
    });

    it("headers-missing counts past the listing cap and says so", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      await addPages(
        crawl,
        [3, 1, 2].map((n) => ({
          url: `${HTTPS_SITE}/p${n}`,
          headers: headers({ "referrer-policy": null }),
        })),
      );
      const found = await run("security.headers-missing", crawl, 2);
      expect(found.map((f) => f.pageUrl)).toEqual([`${HTTPS_SITE}/p1`, `${HTTPS_SITE}/p2`]);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: 2, total: 3 },
      });
    });

    it("an http page on an http site fires nothing from any security rule", async () => {
      const crawl = await newCrawl(HTTP_SITE);
      const ids = await addPages(crawl, [
        { url: `${HTTP_SITE}/a`, headers: { values: {}, truncated: [] } },
      ]);
      await db.insert(pageResources).values({
        crawlId: crawl,
        pageId: ids.get(`${HTTP_SITE}/a`)!,
        resourceUrl: "http://plain.example/x.jpg",
      });
      for (const r of securityRules) expect(await run(r.id, crawl), r.id).toEqual([]);
    });

    it("an http page on an https site files security.http-url", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [
        { url: `${HTTPS_SITE}/a` },
        { url: "http://secure.example/legacy" },
        // An HTTP URL that never answered 200 is not judged.
        { url: "http://secure.example/missing", statusCode: 404 },
      ]);
      const found = await run("security.http-url", crawl);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        ruleId: "security.http-url",
        severity: "warning",
        pageId: ids.get("http://secure.example/legacy"),
        pageUrl: "http://secure.example/legacy",
        evidence: {},
      });
    });

    it("http-url throws for a crawl that does not exist", async () => {
      await expect(run("security.http-url", `crawl_${randomUUID()}`)).rejects.toThrow(/no crawl/);
    });

    it("mixed-content counts the http resources of an https page, one finding per page", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [
        { url: `${HTTPS_SITE}/mixed` },
        { url: `${HTTPS_SITE}/clean` },
      ]);
      const mixed = ids.get(`${HTTPS_SITE}/mixed`)!;
      const clean = ids.get(`${HTTPS_SITE}/clean`)!;
      await db.insert(pageResources).values([
        { crawlId: crawl, pageId: mixed, resourceUrl: "http://x.example/a.jpg" },
        { crawlId: crawl, pageId: mixed, resourceUrl: "https://x.example/b.jpg" },
        { crawlId: crawl, pageId: clean, resourceUrl: "https://x.example/b.jpg" },
      ]);
      const found = await run("security.mixed-content", crawl);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        ruleId: "security.mixed-content",
        severity: "warning",
        pageId: mixed,
        pageUrl: `${HTTPS_SITE}/mixed`,
        evidence: { insecureCount: 1, sample: ["http://x.example/a.jpg"] },
      });
    });

    it("mixed-content samples at most the broken-resource limit, ordered", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [{ url: `${HTTPS_SITE}/many` }]);
      const total = BROKEN_SAMPLE_RESOURCES + 3;
      const urls = Array.from(
        { length: total },
        (_, i) => `http://x.example/${String(i).padStart(2, "0")}.js`,
      );
      await db.insert(pageResources).values(
        [...urls].reverse().map((resourceUrl) => ({
          crawlId: crawl,
          pageId: ids.get(`${HTTPS_SITE}/many`)!,
          resourceUrl,
        })),
      );
      const found = await run("security.mixed-content", crawl);
      expect(found[0]!.evidence).toEqual({
        insecureCount: total,
        sample: urls.slice(0, BROKEN_SAMPLE_RESOURCES),
      });
    });

    it("mixed-content does not judge an http page on an http site", async () => {
      const crawl = await newCrawl(HTTP_SITE);
      const ids = await addPages(crawl, [{ url: `${HTTP_SITE}/a` }]);
      await db.insert(pageResources).values({
        crawlId: crawl,
        pageId: ids.get(`${HTTP_SITE}/a`)!,
        resourceUrl: "http://x.example/a.jpg",
      });
      expect(await run("security.mixed-content", crawl)).toEqual([]);
    });
  });
});

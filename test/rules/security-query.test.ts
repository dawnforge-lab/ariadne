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
import { crawls, links, pageResources, pages } from "../../src/db/schema.js";
import type { FetchResult } from "../../src/crawl/fetch-page.js";
import type { InsecureRefs } from "../../src/crawl/parse/page-facts.js";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import { PageWriter } from "../../src/crawl/persist.js";
import type { StoredResponseHeaders } from "../../src/crawl/response-headers.js";
import { DEFAULT_RULE_CAPS } from "../../src/rules/query/crawl-evidence.js";
import { BROKEN_SAMPLE_RESOURCES } from "../../src/rules/query/resources.js";
import { missingSecurityHeaders, securityRules } from "../../src/rules/query/security.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

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

describe("security.headers-not-recorded: no silent zero (PR #22 review)", () => {
  it("throws when the cohort count returns no row, rather than reading it as zero", async () => {
    // A count without `group by` always returns one row, so an empty result is
    // a broken driver or query, never an empty cohort. Replayed answers: the
    // coverage census says a page predates Phase 25, then the cohort count
    // comes back empty.
    const answers = [{ rows: [{ at_or_above: 0, below: 1 }] }, { rows: [] }];
    const fake = {
      execute: async () => {
        const next = answers.shift();
        if (next === undefined) throw new Error("unexpected query");
        return next;
      },
    } as unknown as Db;
    await expect(rule("security.headers-not-recorded").run(fake, "crawl_x")).rejects.toThrow(
      /aggregate returned no row/,
    );
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
    insecureRefs?: InsecureRefs | null;
  }

  async function newCrawl(siteUrl: string): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ tenantId: LOCAL_TENANT, id, siteUrl, hostKey: hostKeyOf(siteUrl), config: {}, rulesetVersion: "test" });
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
      insecureRefs: s.insecureRefs === undefined ? null : s.insecureRefs,
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

    it("hsts-missing treats max-age=0 and an absent or unparseable max-age as missing, and says why", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const sts = (v: string) => headers({ "strict-transport-security": [v] });
      await addPages(crawl, [
        { url: `${HTTPS_SITE}/zero`, headers: sts("max-age=0") },
        { url: `${HTTPS_SITE}/zero-quoted`, headers: sts('Max-Age="0"; includeSubDomains') },
        { url: `${HTTPS_SITE}/no-age`, headers: sts("includeSubDomains") },
        { url: `${HTTPS_SITE}/junk`, headers: sts("max-age=soon") },
        { url: `${HTTPS_SITE}/good`, headers: sts("includeSubDomains; max-age=300") },
      ]);
      const found = await run("security.hsts-missing", crawl);
      const byUrl = new Map(found.map((f) => [f.pageUrl, f.evidence]));
      const zero = { hstsProblem: "max-age is 0, which tells browsers to drop HSTS" };
      const noAge = { hstsProblem: "no valid max-age directive" };
      expect(byUrl.get(`${HTTPS_SITE}/zero`)).toEqual(zero);
      expect(byUrl.get(`${HTTPS_SITE}/zero-quoted`)).toEqual(zero);
      expect(byUrl.get(`${HTTPS_SITE}/no-age`)).toEqual(noAge);
      expect(byUrl.get(`${HTTPS_SITE}/junk`)).toEqual(noAge);
      expect(byUrl.has(`${HTTPS_SITE}/good`)).toBe(false);
      expect(found).toHaveLength(4);
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

    describe("security.http-url (internal links to http: on an https: site)", () => {
      /**
       * Write one crawled page the way the crawl loop does: the analyzer reads
       * the HTML (it resolves and normalises every `<a href>` and drops
       * duplicates) and `PageWriter` stores the page row and its `links` rows,
       * computing `is_internal` itself. Nothing about a link row is hand-made.
       */
      async function crawlPage(
        crawlId: string,
        url: string,
        hrefs: string[],
        fetch: Partial<FetchResult> = {},
      ): Promise<string> {
        const html = `<html><head><title>t</title></head><body>${hrefs
          .map((h) => `<a href="${h}">x</a>`)
          .join("")}</body></html>`;
        const writer = new PageWriter(db, crawlId);
        const result: FetchResult = {
          url,
          statusCode: 200,
          fetchClass: "ok",
          contentType: "text/html; charset=utf-8",
          redirectUrl: null,
          body: html,
          htmlBytes: html.length,
          responseTimeMs: 10,
          retryAfterMs: null,
          canonicalHeader: null,
          xRobotsTag: null,
          platformHint: null,
          responseHeaders: null,
          headerHreflang: [],
          disallowedReason: null,
          ...fetch,
        };
        const pageId = await writer.addPage(
          { url, depth: 1, discoveredVia: "link" },
          result,
          analyzePage(html, url),
          { complete: false },
        );
        await writer.flush();
        return pageId;
      }

      it("files the linking page with the exact count and a sorted sample of its http: targets", async () => {
        const crawl = await newCrawl(HTTPS_SITE);
        const linking = await crawlPage(crawl, `${HTTPS_SITE}/a`, [
          "http://secure.example/legacy",
          "http://www.secure.example/b",
          "http://SECURE.example/a?z=1&y=2",
          // Duplicate of the first: the analyzer keeps one row per target.
          "http://secure.example/legacy#frag",
          // Not the site's host, not http, not a downgrade: none counts.
          "http://other.example/x",
          "http://secure.example.evil.example/x",
          "https://secure.example/fine",
          "/relative",
        ]);
        await crawlPage(crawl, `${HTTPS_SITE}/clean`, ["https://secure.example/a"]);
        const found = await run("security.http-url", crawl);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          ruleId: "security.http-url",
          severity: "warning",
          pageId: linking,
          pageUrl: `${HTTPS_SITE}/a`,
          dedupeKey: `${HTTPS_SITE}/a`,
          evidence: {
            httpTargetCount: 3,
            sample: [
              "http://secure.example/a?y=2&z=1",
              "http://secure.example/legacy",
              "http://www.secure.example/b",
            ],
          },
        });
      });

      it("does not rely on links.is_internal, which the crawler writes false for an http: target", async () => {
        const crawl = await newCrawl(HTTPS_SITE);
        await crawlPage(crawl, `${HTTPS_SITE}/a`, ["http://secure.example/legacy"]);
        const stored = await db
          .select({ isInternal: links.isInternal })
          .from(links)
          .where(eq(links.crawlId, crawl));
        expect(stored).toEqual([{ isInternal: false }]);
        expect(await run("security.http-url", crawl)).toHaveLength(1);
      });

      it("samples at most the sample limit, sorted, with the exact count", async () => {
        const crawl = await newCrawl(HTTPS_SITE);
        const total = BROKEN_SAMPLE_RESOURCES + 3;
        const urls = Array.from(
          { length: total },
          (_, i) => `http://secure.example/${String(i).padStart(2, "0")}`,
        );
        await crawlPage(crawl, `${HTTPS_SITE}/many`, [...urls].reverse());
        const found = await run("security.http-url", crawl);
        expect(found.map((f) => f.evidence)).toEqual([
          { httpTargetCount: total, sample: urls.slice(0, BROKEN_SAMPLE_RESOURCES) },
        ]);
      });

      it("judges only pages fetched OK with a 200", async () => {
        const crawl = await newCrawl(HTTPS_SITE);
        await crawlPage(crawl, `${HTTPS_SITE}/gone`, ["http://secure.example/x"], {
          statusCode: 404,
          fetchClass: "client_error",
        });
        expect(await run("security.http-url", crawl)).toEqual([]);
      });

      it("caps the listing at caps.listing and reports the exact total", async () => {
        const crawl = await newCrawl(HTTPS_SITE);
        for (const n of [3, 1, 2]) {
          await crawlPage(crawl, `${HTTPS_SITE}/p${n}`, ["http://secure.example/old"]);
        }
        const found = await run("security.http-url", crawl, 2);
        expect(found.map((f) => f.pageUrl)).toEqual([`${HTTPS_SITE}/p1`, `${HTTPS_SITE}/p2`]);
        expect(found[found.length - 1]!.evidence).toMatchObject({
          truncated: { reported: 2, total: 3 },
        });
      });

      it("does not key on an http: page row: an http: page with no http: link files nothing", async () => {
        const crawl = await newCrawl(HTTPS_SITE);
        await addPages(crawl, [{ url: `${HTTPS_SITE}/a` }, { url: "http://secure.example/legacy" }]);
        expect(await run("security.http-url", crawl)).toEqual([]);
      });

      it("files nothing on an http: site, where http: links are the site itself", async () => {
        const crawl = await newCrawl(HTTP_SITE);
        await crawlPage(crawl, `${HTTP_SITE}/a`, ["http://plain.example/b"]);
        expect(await run("security.http-url", crawl)).toEqual([]);
      });

      it("throws for a crawl that does not exist", async () => {
        await expect(run("security.http-url", `crawl_${randomUUID()}`)).rejects.toThrow(
          /no crawl/,
        );
      });
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

    it("mixed-content leaves out an http page, its http edges and http iframes included", async () => {
      // Pages of one crawl on both schemes: only the https page is the cohort.
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [
        { url: `${HTTPS_SITE}/secure` },
        {
          url: `${HTTP_SITE}/plain`,
          extractionVersion: 2,
          insecureRefs: refs({ iframe: 1, sample: [{ kind: "iframe", url: "http://x.example/f" }] }),
        },
      ]);
      const secure = ids.get(`${HTTPS_SITE}/secure`)!;
      const plain = ids.get(`${HTTP_SITE}/plain`)!;
      await db.insert(pageResources).values([
        { crawlId: crawl, pageId: secure, resourceUrl: "http://x.example/s.js" },
        { crawlId: crawl, pageId: plain, resourceUrl: "http://x.example/a.jpg" },
        { crawlId: crawl, pageId: plain, resourceUrl: "http://x.example/b.jpg" },
      ]);
      const found = await run("security.mixed-content", crawl);
      expect(found.map((f) => [f.pageUrl, f.evidence])).toEqual([
        [`${HTTPS_SITE}/secure`, { insecureCount: 1, sample: ["http://x.example/s.js"] }],
      ]);
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

    const refs = (o: Partial<InsecureRefs>): InsecureRefs => ({
      iframe: 0,
      media: 0,
      formAction: 0,
      forms: 0,
      sample: [],
      ...o,
    });

    it("mixed-content fires on a v2 https page with only an http iframe, byKind.iframe 1", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [
        {
          url: `${HTTPS_SITE}/framed`,
          extractionVersion: 2,
          insecureRefs: refs({ iframe: 1, sample: [{ kind: "iframe", url: "http://x.example/f" }] }),
        },
        { url: `${HTTPS_SITE}/clean`, extractionVersion: 2, insecureRefs: refs({}) },
        // A form action is a form-insecure matter, not mixed content.
        {
          url: `${HTTPS_SITE}/form`,
          extractionVersion: 2,
          insecureRefs: refs({
            formAction: 1,
            forms: 1,
            sample: [{ kind: "form", url: "http://x.example/p" }],
          }),
        },
      ]);
      const found = await run("security.mixed-content", crawl);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        pageId: ids.get(`${HTTPS_SITE}/framed`),
        evidence: {
          insecureCount: 1,
          sample: ["http://x.example/f"],
          byKind: { resources: 0, iframe: 1, media: 0 },
        },
      });
    });

    it("mixed-content adds resources, iframes and media, merging and capping the sample", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [
        {
          url: `${HTTPS_SITE}/all`,
          extractionVersion: 2,
          insecureRefs: refs({
            iframe: 1,
            media: 2,
            sample: [
              { kind: "media", url: "http://x.example/m1.mp4" },
              { kind: "iframe", url: "http://x.example/a-frame" },
              { kind: "media", url: "http://x.example/m2.mp4" },
              { kind: "form", url: "http://x.example/not-counted" },
            ],
          }),
        },
      ]);
      const resourceUrls = Array.from(
        { length: BROKEN_SAMPLE_RESOURCES },
        (_, i) => `http://x.example/r${String(i).padStart(2, "0")}.js`,
      );
      await db.insert(pageResources).values(
        resourceUrls.map((resourceUrl) => ({
          crawlId: crawl,
          pageId: ids.get(`${HTTPS_SITE}/all`)!,
          resourceUrl,
        })),
      );
      const found = await run("security.mixed-content", crawl);
      expect(found).toHaveLength(1);
      const sorted = [
        "http://x.example/a-frame",
        "http://x.example/m1.mp4",
        "http://x.example/m2.mp4",
        ...resourceUrls,
      ].sort();
      expect(found[0]!.evidence).toEqual({
        insecureCount: BROKEN_SAMPLE_RESOURCES + 3,
        sample: sorted.slice(0, BROKEN_SAMPLE_RESOURCES),
        byKind: { resources: BROKEN_SAMPLE_RESOURCES, iframe: 1, media: 2 },
      });
    });

    it("mixed-content on a v1 https page is exactly the 0.20.0 result: no byKind key", async () => {
      const crawl = await newCrawl(HTTPS_SITE);
      const ids = await addPages(crawl, [{ url: `${HTTPS_SITE}/old` }]);
      await db.insert(pageResources).values({
        crawlId: crawl,
        pageId: ids.get(`${HTTPS_SITE}/old`)!,
        resourceUrl: "http://x.example/a.jpg",
      });
      const found = await run("security.mixed-content", crawl);
      expect(found).toHaveLength(1);
      expect(JSON.stringify(found[0]!.evidence)).toBe(
        '{"insecureCount":1,"sample":["http://x.example/a.jpg"]}',
      );
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

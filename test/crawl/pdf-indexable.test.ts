/**
 * A PDF is indexable unless its headers say otherwise (Phase 29d, Task 5a;
 * owner ruling 2026-11-24, plan ruling R1).
 *
 * Four parts, one per claim the change makes:
 *  - `isPdf` (src/crawl/robots-directives.ts) and its SQL twin `IS_PDF`
 *    (src/rules/helpers.ts) read one content type the same way;
 *  - `PageWriter` stamps `is_indexable` true on a 200 PDF with no noindex in
 *    `X-Robots-Tag`, and false on every other non-HTML answer;
 *  - `indexabilityOf` and `INDEXABILITY_STATUS_SQL` — the two standard columns
 *    on every finding row and the Crawl Overview's partition — report it the
 *    same way the stamp does;
 *  - THE READER AUDIT: over one crawl holding an indexable PDF beside indexable
 *    HTML, each reader that means "an indexable HTML page" ignores the PDF, and
 *    each reader that means "an indexable document" counts it.
 *
 * The reader-audit rows are inserted directly (the link-graph pattern), with the
 * stamp the writer now writes; the persist cases above them are what prove the
 * writer writes it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, sitemapUrls } from "../../src/db/schema.js";
import { PageWriter } from "../../src/crawl/persist.js";
import type { FetchResult } from "../../src/crawl/fetch-page.js";
import { isDocumentOk, isPdf } from "../../src/crawl/robots-directives.js";
import { selectRenderSet } from "../../src/crawl/render/select.js";
import {
  DOCUMENT_OK,
  indexabilityOf,
  INDEXABILITY_STATUS_SQL,
  IS_PDF,
} from "../../src/rules/helpers.js";
import { canonicalRules } from "../../src/rules/page/canonical.js";
import { indexabilityRules } from "../../src/rules/page/indexability.js";
import { contentRules } from "../../src/rules/query/content.js";
import { fieldDuplicateRules } from "../../src/rules/query/field-duplicates.js";
import { linkTargetRules } from "../../src/rules/query/link-targets.js";
import { sitemapRules } from "../../src/rules/query/sitemap.js";
import { healthMetrics } from "../../src/rules/metric/health-metrics.js";
import type { PageRecord, QueryRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage, normalised } from "../rules/mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://pdf-indexable.example";
const url = (path: string): string => `${SITE}${path}`;

let db: Db;
const createdCrawls: string[] = [];

async function newCrawl(): Promise<string> {
  const id = `crawl_${randomUUID()}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: SITE,
    hostKey: hostKeyOf(SITE),
    config: { maxPages: 500, userAgent: "AriadneBot-test" },
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: 1,
    discovery: mkDiscovery(),
  });
  createdCrawls.push(id);
  return id;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
});

// ------------------------------------------------------------ isPdf / IS_PDF

describe("isPdf and IS_PDF read a content type the same way", () => {
  const CORPUS: (string | null)[] = [
    "application/pdf",
    "Application/PDF;x=1",
    "application/PDF; charset=binary",
    "application/pdf ; name=a.pdf",
    "text/html",
    "text/html; charset=utf-8",
    "application/pdfx",
    "application/x-pdf",
    "image/png",
    "application/msword",
    "",
    null,
  ];

  it("agrees row for row, and the corpus holds both answers", async () => {
    const rows = CORPUS.map((v, i) => sql`(${i}::int, ${v}::text)`);
    const res = await db.execute<{ i: number; pdf: boolean }>(
      sql`select v.i, ${sql.raw(IS_PDF("v.c"))} as pdf from (values ${sql.join(rows, sql`, `)}) v(i, c)`,
    );
    const got = new Map(res.rows.map((r) => [Number(r.i), r.pdf]));
    CORPUS.forEach((v, i) => {
      expect(got.get(i), JSON.stringify(v)).toBe(isPdf(v));
    });
    expect(isPdf("application/pdf")).toBe(true);
    expect(isPdf("Application/PDF;x=1")).toBe(true);
    expect(isPdf("text/html")).toBe(false);
    expect(isPdf(null)).toBe(false);
    expect(isPdf("application/pdfx")).toBe(false);
  });
});

// ------------------------------------------------------------------ persist

describe("PageWriter stamps a PDF's is_indexable from its headers", () => {
  function fetchOf(target: string, over: Partial<FetchResult>): FetchResult {
    return {
      url: target,
      statusCode: 200,
      fetchClass: "non_html",
      contentType: "application/pdf",
      redirectUrl: null,
      body: null,
      htmlBytes: 2048,
      responseTimeMs: 40,
      retryAfterMs: null,
      canonicalHeader: null,
      xRobotsTag: null,
      platformHint: null,
      responseHeaders: null,
      headerHreflang: [],
      disallowedReason: null,
      ...over,
    };
  }

  it("stores a plain 200 PDF indexable and every other shape not", async () => {
    const crawlId = await newCrawl();
    const writer = new PageWriter(db, crawlId);
    const shapes: Array<[string, Partial<FetchResult>, boolean]> = [
      ["/plain.pdf", {}, true],
      ["/charset.pdf", { contentType: "application/PDF; charset=binary" }, true],
      ["/noindex.pdf", { xRobotsTag: "noindex" }, false],
      ["/none.pdf", { xRobotsTag: "none" }, false],
      ["/gone.pdf", { statusCode: 404, fetchClass: "client_error" }, false],
      ["/report.doc", { contentType: "application/msword" }, false],
      ["/photo.png", { contentType: "image/png" }, false],
    ];
    for (const [path, over] of shapes) {
      await writer.addPage(
        { url: url(path), depth: 1, discoveredVia: "link" },
        fetchOf(url(path), over),
        null,
        { complete: true },
      );
    }
    await writer.flush();

    const rows = await db
      .select({ url: pages.url, isIndexable: pages.isIndexable })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    const stamp = new Map(rows.map((r) => [r.url, r.isIndexable]));
    for (const [path, , expected] of shapes) {
      expect(stamp.get(url(path)), path).toBe(expected);
    }
  });
});

// ----------------------------------------------- the two standard columns

describe("indexabilityOf and INDEXABILITY_STATUS_SQL report a PDF as the stamp does", () => {
  const ELSEWHERE = "https://example.com/other";
  const pdf = (over: Partial<PageRecord>): PageRecord =>
    mkPage({
      url: "https://example.com/doc.pdf",
      fetchClass: "non_html",
      contentType: "application/pdf",
      canonicalHtml: null,
      robotsMeta: null,
      title: null,
      ...over,
    });

  const CASES: Array<[string, PageRecord, string]> = [
    ["plain 200 PDF", pdf({ isIndexable: true }), ""],
    ["PDF with a parameterised type", pdf({ contentType: "Application/PDF;x=1", isIndexable: true }), ""],
    ["PDF noindexed by header", pdf({ xRobotsTag: "noindex", isIndexable: false }), "Noindex"],
    ["PDF with header none", pdf({ xRobotsTag: "none", isIndexable: false }), "Noindex"],
    ["PDF canonicalised by Link header", pdf({ canonicalHeader: ELSEWHERE, isIndexable: true }), "Canonicalised"],
    ["206 PDF", pdf({ statusCode: 206, isIndexable: false }), "Not HTML"],
    ["404 PDF", pdf({ fetchClass: "client_error", statusCode: 404, isIndexable: false }), "Client Error"],
    ["Word document", pdf({ contentType: "application/msword", isIndexable: false }), "Not HTML"],
    ["image", pdf({ contentType: "image/png", isIndexable: false }), "Not HTML"],
  ];

  it("indexabilityOf: Indexable for a plain PDF, Noindex for a header noindex, Not HTML for Word", () => {
    for (const [why, page, status] of CASES) {
      expect(indexabilityOf(page).status, why).toBe(status);
      expect(indexabilityOf(page).indexability, why).toBe(
        status === "" ? "Indexable" : "Non-Indexable",
      );
    }
  });

  it("indexabilityOf refuses a PDF whose stamp contradicts its headers", () => {
    expect(() => indexabilityOf(pdf({ isIndexable: false }))).toThrow(/is_indexable/);
    expect(() => indexabilityOf(pdf({ xRobotsTag: "noindex", isIndexable: true }))).toThrow(
      /is_indexable/,
    );
  });

  it("INDEXABILITY_STATUS_SQL says what indexabilityOf says", async () => {
    const values = CASES.map(
      ([, p], i) =>
        sql`(${String(i)}::int, ${p.url}::text, ${p.fetchClass}::text, ${p.statusCode}::int, ${p.contentType}::text, ${p.robotsMeta}::text, ${p.xRobotsTag}::text, ${p.canonicalHtml}::text, ${p.canonicalHeader}::text)`,
    );
    const result = await db.execute<{ status: string }>(sql`
      select ${INDEXABILITY_STATUS_SQL("p")} as status
      from (values ${sql.join(values, sql`, `)})
        as p(i, url, fetch_class, status_code, content_type, robots_meta, x_robots_tag, canonical_html, canonical_header)
      order by p.i`);
    expect(result.rows.map((r) => r.status)).toEqual(CASES.map(([, , status]) => status));
  });
});

// --------------------------------------------------------------- reader audit

describe("the reader audit: a crawl with an indexable PDF beside indexable HTML", () => {
  const TITLE = "One title for the page and the PDF";
  const META = "One description for the page and the PDF, written once.";
  const HASH = "c".repeat(64);

  interface Row {
    path: string;
    fetchClass?: string;
    statusCode?: number;
    contentType?: string;
    xRobotsTag?: string;
    canonical?: string;
    isIndexable: boolean;
    title?: string;
    metaDescription?: string;
    contentHash?: string;
  }

  /**
   * - `/page` and `/doc.pdf` share a title, a description and a content hash:
   *   if any HTML-only reader let the PDF in, it would pair the two.
   * - `/hidden.pdf` is a 200 PDF noindexed by its header; `/report.doc` a 200
   *   Word file. Both stamped false, as the writer stamps them.
   * - `/to-hidden` and `/to-plain` canonicalise to the two PDFs.
   */
  const ROWS: Row[] = [
    { path: "/page", isIndexable: true, title: TITLE, metaDescription: META, contentHash: HASH },
    {
      path: "/doc.pdf",
      fetchClass: "non_html",
      contentType: "application/pdf",
      isIndexable: true,
      title: TITLE,
      metaDescription: META,
      contentHash: HASH,
    },
    {
      path: "/hidden.pdf",
      fetchClass: "non_html",
      contentType: "application/pdf",
      xRobotsTag: "noindex",
      isIndexable: false,
    },
    { path: "/report.doc", fetchClass: "non_html", contentType: "application/msword", isIndexable: false },
    { path: "/to-hidden", canonical: url("/hidden.pdf"), isIndexable: true },
    { path: "/to-plain", canonical: url("/doc.pdf"), isIndexable: true },
  ];

  let crawlId: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    crawlId = await newCrawl();
    const rows = ROWS.map((r) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(r.path),
      urlNormalised: normalised(url(r.path)),
      pageType: "content",
      fetchClass: r.fetchClass ?? "ok",
      statusCode: r.statusCode ?? 200,
      contentType: r.contentType ?? "text/html; charset=utf-8",
      xRobotsTag: r.xRobotsTag ?? null,
      isIndexable: r.isIndexable,
      // A self canonical on HTML unless one is given; none on a PDF.
      canonicalHtml: r.canonical ?? (r.fetchClass === "non_html" ? null : url(r.path)),
      title: r.title ?? null,
      metaDescription: r.metaDescription ?? null,
      contentHash: r.contentHash ?? null,
      depth: 1,
      discoveredVia: "sitemap",
    }));
    await db.insert(pages).values(rows);
    rows.forEach((r, i) => ids.set(ROWS[i]!.path, r.id));
    await db.insert(sitemapUrls).values(
      ["/page", "/doc.pdf", "/hidden.pdf", "/report.doc"].map((path) => ({
        crawlId,
        url: url(path),
        urlNormalised: normalised(url(path)),
        sitemapSource: `${SITE}/sitemap.xml`,
        seenAt: new Date(),
        lastmod: null,
      })),
    );
  });

  const queryRule = (rules: QueryRule[], id: string): QueryRule => {
    const r = rules.find((x) => x.id === id);
    if (r === undefined) throw new Error(`no rule '${id}'`);
    return r;
  };
  const named = (findings: { pageUrl: string | null }[]): (string | null)[] =>
    findings.map((f) => f.pageUrl);

  async function pageRecord(path: string): Promise<PageRecord> {
    const [row] = await db.select().from(pages).where(eq(pages.id, ids.get(path)!));
    if (row === undefined) throw new Error(`no row for ${path}`);
    return row as PageRecord;
  }

  // HTML-only readers: each ignores the PDF.

  it("render selection never picks the PDF", async () => {
    const chosen = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderMaxPages: 100,
      renderSamplePerType: 100,
    });
    expect(chosen.selected).toContain(url("/page"));
    expect(chosen.selected).not.toContain(url("/doc.pdf"));
    expect(chosen.selected.filter((u) => /\.(pdf|doc)$/.test(u))).toEqual([]);
  });

  it("duplicate titles and descriptions do not pair the PDF with the page", async () => {
    expect(await queryRule(fieldDuplicateRules, "title.duplicate").run(db, crawlId)).toEqual([]);
    expect(
      await queryRule(fieldDuplicateRules, "meta-description.duplicate").run(db, crawlId),
    ).toEqual([]);
  });

  it("content rules do not pair the PDF with the page", async () => {
    expect(await queryRule(contentRules, "content.exact-duplicate").run(db, crawlId)).toEqual([]);
  });

  it("page-level indexability and canonical rules say nothing about a PDF", async () => {
    const plain = await pageRecord("/doc.pdf");
    const hidden = await pageRecord("/hidden.pdf");
    expect(plain.isIndexable).toBe(true);
    for (const rule of [...canonicalRules, ...indexabilityRules]) {
      expect(rule.run(plain), `${rule.id} on the plain PDF`).toEqual([]);
      expect(rule.run(hidden), `${rule.id} on the noindexed PDF`).toEqual([]);
    }
  });

  // Document readers: each counts the PDF.

  it("sitemap.non-indexable flags the noindexed PDF and not the indexable one or the Word file", async () => {
    const found = await queryRule(sitemapRules, "sitemap.non-indexable").run(db, crawlId);
    expect(named(found)).toEqual([url("/hidden.pdf")]);
    expect(found[0]!.evidence).toMatchObject({ reason: "noindex", xRobotsTag: "noindex" });
  });

  it("canonical.non-indexable-target flags a canonical to the noindexed PDF, not to the indexable one", async () => {
    const found = await queryRule(linkTargetRules, "canonical.non-indexable-target").run(
      db,
      crawlId,
    );
    expect(named(found)).toEqual([url("/to-hidden")]);
    expect(found[0]!.evidence).toMatchObject({
      resolvedTo: url("/hidden.pdf"),
      targetXRobotsTag: "noindex",
    });
  });

  it("the Crawl Overview's indexability partition counts the PDF as Indexable", async () => {
    const result = await db.execute<{ url: string; status: string }>(sql`
      select p.url, ${INDEXABILITY_STATUS_SQL("p")} as status
        from pages p where p.crawl_id = ${crawlId}`);
    const status = new Map(result.rows.map((r) => [r.url, r.status]));
    expect(status.get(url("/doc.pdf"))).toBe("");
    expect(status.get(url("/hidden.pdf"))).toBe("Noindex");
    expect(status.get(url("/report.doc"))).toBe("Not HTML");
    expect(status.get(url("/page"))).toBe("");
  });

  it("site.health judges the indexable PDF and sets the noindexed one aside (owner ruling 2026-11-25)", async () => {
    const health = healthMetrics.find((r) => r.id === "site.health")!;
    const [row] = await health.run(db, crawlId);
    // Judged: /page and /doc.pdf (the two /to-* pages canonicalise elsewhere);
    // /hidden.pdf is noindexed by its header; only the Word file is not judged.
    expect(row!.value).toMatchObject({
      urlsTotal: 2,
      urlsCanonicalised: 2,
      urlsNoindex: 1,
      pagesNotAuditable: 1,
      urlsPdf: 1,
    });
  });
});

// ------------------------------------------- fix round 1 (Task 5a review)

describe("DOCUMENT_OK and isDocumentOk decide the same rows", () => {
  const CORPUS: Array<[string, string, number | null, string | null]> = [
    ["ok 200", "ok", 200, "text/html; charset=utf-8"],
    ["ok 204", "ok", 204, "text/html"],
    ["ok null status", "ok", null, null],
    ["pdf 200", "non_html", 200, "application/pdf"],
    ["pdf with parameters", "non_html", 200, "Application/PDF; charset=binary"],
    ["pdf 206", "non_html", 206, "application/pdf"],
    ["non_html null content type", "non_html", 200, null],
    ["word 200", "non_html", 200, "application/msword"],
    ["image 200", "non_html", 200, "image/png"],
    ["404 pdf", "client_error", 404, "application/pdf"],
    ["too large", "too_large", 200, "text/html"],
    ["redirect", "redirect", 301, "application/pdf"],
  ];

  it("agrees row for row, and the corpus holds both answers", async () => {
    const rows = CORPUS.map(
      ([, fetchClass, statusCode, contentType], i) =>
        sql`(${i}::int, ${fetchClass}::text, ${statusCode}::int, ${contentType}::text)`,
    );
    const res = await db.execute<{ i: number; ok: boolean }>(sql`
      select p.i, ${DOCUMENT_OK("p")} as ok
      from (values ${sql.join(rows, sql`, `)}) p(i, fetch_class, status_code, content_type)`);
    const got = new Map(res.rows.map((r) => [Number(r.i), r.ok]));
    let yes = 0;
    CORPUS.forEach(([why, fetchClass, statusCode, contentType], i) => {
      const js = isDocumentOk({ fetchClass, statusCode, contentType });
      if (js) yes += 1;
      expect(got.get(i), why).toBe(js);
    });
    expect(yes).toBe(3);
  });
});

describe("the sitemap rules over documents", () => {
  async function addRows(
    crawlId: string,
    rows: Array<{
      path: string;
      fetchClass?: string;
      contentType?: string;
      xRobotsTag?: string;
      canonicalHeader?: string;
      isIndexable: boolean;
    }>,
  ): Promise<void> {
    await db.insert(pages).values(
      rows.map((r) => ({
        id: `page_${randomUUID()}`,
        crawlId,
        url: url(r.path),
        urlNormalised: normalised(url(r.path)),
        fetchClass: r.fetchClass ?? "non_html",
        statusCode: 200,
        contentType: r.contentType ?? "application/pdf",
        xRobotsTag: r.xRobotsTag ?? null,
        isIndexable: r.isIndexable,
        canonicalHtml: r.fetchClass === "ok" ? url(r.path) : null,
        canonicalHeader: r.canonicalHeader ?? null,
        depth: 1,
        discoveredVia: "link",
      })),
    );
  }

  async function listInSitemap(crawlId: string, paths: string[]): Promise<void> {
    await db.insert(sitemapUrls).values(
      paths.map((path) => ({
        crawlId,
        url: url(path),
        urlNormalised: normalised(url(path)),
        sitemapSource: `${SITE}/sitemap.xml`,
        seenAt: new Date(),
        lastmod: null,
      })),
    );
  }

  const rule = (id: string): QueryRule => {
    const r = sitemapRules.find((x) => x.id === id);
    if (r === undefined) throw new Error(`no rule '${id}'`);
    return r;
  };

  it("pages.not-in-sitemap reports an indexable PDF the sitemap omits, not a noindexed PDF or a Word file", async () => {
    const crawlId = await newCrawl();
    await addRows(crawlId, [
      { path: "/listed", fetchClass: "ok", contentType: "text/html", isIndexable: true },
      { path: "/unlisted.pdf", isIndexable: true },
      { path: "/hidden.pdf", xRobotsTag: "noindex", isIndexable: false },
      { path: "/report.doc", contentType: "application/msword", isIndexable: false },
      // Canonicalised elsewhere by its Link header: belongs out of a sitemap.
      { path: "/copy.pdf", canonicalHeader: url("/unlisted.pdf"), isIndexable: true },
    ]);
    await listInSitemap(crawlId, ["/listed"]);

    const found = await rule("pages.not-in-sitemap").run(db, crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/unlisted.pdf")]);
  });

  it("sitemap.non-indexable reports a listed PDF canonicalised by its Link header as canonicalised", async () => {
    const crawlId = await newCrawl();
    await addRows(crawlId, [
      { path: "/doc.pdf", isIndexable: true },
      { path: "/copy.pdf", canonicalHeader: url("/doc.pdf"), isIndexable: true },
    ]);
    await listInSitemap(crawlId, ["/doc.pdf", "/copy.pdf"]);

    const found = await rule("sitemap.non-indexable").run(db, crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/copy.pdf")]);
    expect(found[0]!.evidence).toMatchObject({ reason: "canonicalised", xRobotsTag: null });
  });
});

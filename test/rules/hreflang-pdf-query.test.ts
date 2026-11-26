import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, pages } from "../../src/db/schema.js";
import { hreflangRules } from "../../src/rules/query/hreflang.js";
import { hreflangIntegrityRules } from "../../src/rules/query/hreflang-integrity.js";
import type { Finding } from "../../src/rules/registry/types.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { writerIndexable } from "./mk-page.js";

// Phase 29d Task 5b: a 200 non-HTML response whose `Link` header carries
// alternates is a declarer, so its own set is judged like a page's. A target
// that is a PDF is judged by its indexability, which Task 5a made true for a
// plain 200 PDF.

const SITE = "https://hreflang-pdf.example";
const PDF = "application/pdf";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

interface Spec {
  path: string;
  fetchClass?: string;
  statusCode?: number;
  contentType?: string;
  xRobotsTag?: string;
}

describe("a PDF's hreflang set is judged", () => {
  let db: Db;
  const createdCrawls: string[] = [];
  const url = (path: string): string => `${SITE}${path}`;

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      hostKey: hostKeyOf(SITE),
      config: {},
      rulesetVersion: "test",
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: Spec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode ?? 200,
      contentType: s.contentType ?? null,
      isIndexable: writerIndexable(s),
      xRobotsTag: s.xRobotsTag ?? null,
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function declare(
    crawlId: string,
    pageId: string,
    declarations: Array<[string, string]>,
    source: "html" | "header",
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

  async function findings(id: string, crawlId: string): Promise<Finding[]> {
    const r = [...hreflangRules, ...hreflangIntegrityRules].find((x) => x.id === id);
    if (!r) throw new Error(`no rule '${id}'`);
    return r.run(db, crawlId);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("a PDF that declares an alternate with no return link gets missing-return-link", async () => {
    const crawlId = await newCrawl();
    const pdf = { fetchClass: "non_html", contentType: PDF };
    const ids = await addPages(crawlId, [
      { path: "/doc.pdf", ...pdf },
      { path: "/de/doc.pdf", ...pdf },
    ]);
    await declare(
      crawlId,
      ids.get("/doc.pdf")!,
      [
        ["en", url("/doc.pdf")],
        ["de", url("/de/doc.pdf")],
      ],
      "header",
    );
    await declare(crawlId, ids.get("/de/doc.pdf")!, [["de", url("/de/doc.pdf")]], "header");

    const found = await findings("hreflang.missing-return-link", crawlId);
    expect(found.map((f) => [f.pageUrl, f.evidence.target])).toEqual([
      [url("/doc.pdf"), url("/de/doc.pdf")],
    ]);
  });

  it("a PDF with X-Robots-Tag noindex is a non-indexable target", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/en" },
      { path: "/de.pdf", fetchClass: "non_html", contentType: PDF, xRobotsTag: "noindex" },
    ]);
    await declare(
      crawlId,
      ids.get("/en")!,
      [
        ["en", url("/en")],
        ["de", url("/de.pdf")],
      ],
      "html",
    );

    const found = await findings("hreflang.non-indexable-target", crawlId);
    expect(found.map((f) => [f.pageUrl, f.evidence.target, f.evidence.targetIndexable])).toEqual([
      [url("/en"), url("/de.pdf"), false],
    ]);
  });

  it("a plain 200 PDF is an indexable target", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/en" },
      { path: "/de.pdf", fetchClass: "non_html", contentType: PDF },
    ]);
    await declare(
      crawlId,
      ids.get("/en")!,
      [
        ["en", url("/en")],
        ["de", url("/de.pdf")],
      ],
      "html",
    );

    expect(await findings("hreflang.non-indexable-target", crawlId)).toHaveLength(0);
  });

  it("an invalid code in a PDF's Link header is reported", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/doc.pdf", fetchClass: "non_html", contentType: PDF },
    ]);
    await declare(crawlId, ids.get("/doc.pdf")!, [["english", url("/doc.pdf")]], "header");

    const found = await findings("hreflang.invalid-code", crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/doc.pdf")]);
  });

  it("a PDF whose Link header names only itself gets hreflang.self-only", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/doc.pdf", fetchClass: "non_html", contentType: PDF },
    ]);
    await declare(crawlId, ids.get("/doc.pdf")!, [["en", url("/doc.pdf")]], "header");

    const found = await findings("hreflang.self-only", crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/doc.pdf")]);
  });

  it("a 404 PDF is not a declarer", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/gone.pdf", fetchClass: "non_html", statusCode: 404, contentType: PDF },
      { path: "/de.pdf", fetchClass: "non_html", contentType: PDF },
    ]);
    await declare(
      crawlId,
      ids.get("/gone.pdf")!,
      [
        ["en", url("/gone.pdf")],
        ["de", url("/de.pdf")],
        ["english", url("/x.pdf")],
      ],
      "header",
    );

    for (const r of [...hreflangRules, ...hreflangIntegrityRules]) {
      expect(await r.run(db, crawlId), r.id).toHaveLength(0);
    }
  });
});

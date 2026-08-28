/**
 * The query surface: issues, metrics, pages, export.
 *
 * The crawl here is SEEDED rather than run. Every endpoint under test is a read
 * over `issues`, `metrics` and `pages`, and what has to be pinned is the shape
 * of the answer — the grouping, the ordering, the filter refusals, the cursor
 * round trip, and what does NOT cross the wire. A real crawl would supply the
 * same rows less predictably and far more slowly; `test/api/http.test.ts`
 * already proves the crawl path end to end.
 *
 * The rule ids seeded below are REAL registry ids, and that is load-bearing:
 * the responses join their client-facing copy (title, category, checkIds) from
 * the registry at read time rather than duplicating it into the API layer, so a
 * made-up id would be a row the surface refuses rather than a row with blank
 * copy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { chmodSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, metrics, pages } from "../../src/db/schema.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";

const TOKEN = "test-token-0123456789abcdef";
const SITE = "http://query.example";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let api: ApiServer;
let base: string;
let exportDir: string;
const serverLog: string[] = [];

/** The crawl every query test reads. */
let crawlA = "";
/**
 * A second crawl holding rows for the same rules — the isolation control, and
 * the crawl whose rules CAPPED their listings (the truncation-note fixture).
 */
let crawlB = "";
/** A crawl holding rows for ids this ruleset no longer defines. */
let crawlC = "";
/** A crawl the export is run over twice, to prove the file is replaced. */
let crawlD = "";

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(path: string, opts: { token?: string | null } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? `Bearer ${TOKEN}` : opts.token;
  if (token !== null) headers["authorization"] = token;
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

function items(res: Res): Record<string, unknown>[] {
  const value = res.body["items"];
  if (!Array.isArray(value)) throw new Error(`no items in ${JSON.stringify(res.body)}`);
  return value as Record<string, unknown>[];
}

/** Walk a listing one row at a time, following its cursors to the end. */
async function walk(path: string, limit = 1): Promise<Record<string, unknown>[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let hop = 0; hop < 200; hop += 1) {
    const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const res: Res = await call(`${path}${sep}limit=${limit}${suffix}`);
    if (res.status !== 200) throw new Error(`walk: ${res.status} ${JSON.stringify(res.body)}`);
    out.push(...items(res));
    const next = res.body["nextCursor"];
    if (next === null || next === undefined) return out;
    cursor = String(next);
  }
  throw new Error("walk: listing did not end");
}

async function seedCrawl(id: string): Promise<void> {
  await db.insert(crawls).values({
    id,
    siteUrl: `${SITE}/`,
    config: { siteUrl: `${SITE}/` },
    rulesetVersion: "0.0.0-test",
    status: "finished",
  });
}

interface SeedPage {
  slug: string;
  pageType: string | null;
  statusCode: number;
  isIndexable: boolean | null;
  rendered: boolean;
  depth: number;
  wordCount: number | null;
  contentHash?: string;
}

async function seedPage(crawlId: string, p: SeedPage): Promise<string> {
  const id = `${crawlId}_page_${p.slug}`;
  await db.insert(pages).values({
    id,
    crawlId,
    url: `${SITE}/${p.slug}`,
    urlNormalised: `${SITE}/${p.slug}`,
    pageType: p.pageType,
    statusCode: p.statusCode,
    fetchClass: p.statusCode >= 500 ? "server_error" : "ok",
    depth: p.depth,
    discoveredVia: p.depth === 0 ? "seed" : "link",
    isIndexable: p.isIndexable,
    wordCount: p.wordCount,
    rendered: p.rendered,
    title: `title of ${p.slug}`,
    metaDescription: `description of ${p.slug}`,
    ...(p.contentHash === undefined ? {} : { contentHash: p.contentHash }),
  });
  return id;
}

async function seedIssue(
  crawlId: string,
  row: {
    ruleId: string;
    severity: string;
    pageId?: string | null;
    pageUrl: string | null;
    dedupeKey: string;
    evidence?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(issues).values({
    crawlId,
    ruleId: row.ruleId,
    pageId: row.pageId ?? null,
    severity: row.severity,
    rulesetVersion: "0.0.0-test",
    dedupeKey: row.dedupeKey,
    details: { pageUrl: row.pageUrl, ...(row.evidence ?? {}) },
  });
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-export-"));

  const stamp = Date.now();
  crawlA = `crawl_query_a_${stamp}`;
  crawlB = `crawl_query_b_${stamp}`;
  crawlC = `crawl_query_c_${stamp}`;
  crawlD = `crawl_query_d_${stamp}`;
  for (const id of [crawlA, crawlB, crawlC, crawlD]) await seedCrawl(id);

  const product1 = await seedPage(crawlA, {
    slug: "p1", pageType: "product", statusCode: 200, isIndexable: true,
    rendered: true, depth: 0, wordCount: 800,
  });
  const product2 = await seedPage(crawlA, {
    slug: "p2", pageType: "product", statusCode: 200, isIndexable: false,
    rendered: false, depth: 1, wordCount: 120,
  });
  const blog = await seedPage(crawlA, {
    slug: "b1", pageType: "blog", statusCode: 500, isIndexable: null,
    rendered: false, depth: 2, wordCount: null,
  });
  await seedPage(crawlA, {
    slug: "x", pageType: null, statusCode: 200, isIndexable: true,
    rendered: false, depth: 3, wordCount: 40,
    // A column no projection selects. If a serializer ever spreads a row
    // instead of naming its fields, this string appears on the wire.
    contentHash: "LEAK-CONTENT-HASH-MARKER",
  });

  // critical, category 'crawl', CHECK-12
  await seedIssue(crawlA, {
    ruleId: "http.server-error", severity: "critical", pageId: blog,
    pageUrl: `${SITE}/b1`, dedupeKey: `${SITE}/b1`, evidence: { statusCode: 500 },
  });
  // warning, category 'links', CHECK-32 — seven rows, so the sample cap bites.
  for (let i = 1; i <= 7; i += 1) {
    await seedIssue(crawlA, {
      ruleId: "links.orphan", severity: "warning", pageId: null,
      pageUrl: `${SITE}/o${i}`, dedupeKey: `${SITE}/o${i}`,
      evidence: { inSitemap: i % 2 === 0, discoveredVia: "sitemap" },
    });
  }
  // warning, category 'on-page', CHECK-35 — one product page and one blog page,
  // which is what the pageType filter separates.
  await seedIssue(crawlA, {
    ruleId: "title.missing", severity: "warning", pageId: product1,
    pageUrl: `${SITE}/p1`, dedupeKey: `${SITE}/p1`,
  });
  await seedIssue(crawlA, {
    ruleId: "title.missing", severity: "warning", pageId: blog,
    pageUrl: `${SITE}/b1`, dedupeKey: `${SITE}/b1`,
  });
  // warning, category 'sitemap' — a site-wide finding: no page, no URL.
  await seedIssue(crawlA, {
    ruleId: "sitemap.missing", severity: "warning", pageId: null, pageUrl: null,
    dedupeKey: "site", evidence: { reason: "robots.txt declares no Sitemap: line" },
  });
  // info, category 'url', CHECK-27
  await seedIssue(crawlA, {
    ruleId: "url.parameter-pages-indexable", severity: "info", pageId: product2,
    pageUrl: `${SITE}/p2`, dedupeKey: `${SITE}/p2`, evidence: { param: "sort" },
  });

  // The isolation control: the same rule, a different crawl. It doubles as the
  // UNCAPPED control below — nothing it wrote carries a truncation note, so its
  // count is the whole truth and the group must say nothing about caps.
  await seedIssue(crawlB, {
    ruleId: "title.missing", severity: "warning", pageId: null,
    pageUrl: `${SITE}/other`, dedupeKey: `${SITE}/other`,
  });

  // Two capped rules, in the two shapes a cap can honestly take. The note sits
  // on the LAST finding, which is where `noteOnLast` puts it, and the fixture
  // reproduces the gate site's own numbers: links.orphan listed 200 of 222
  // orphans (exact), content.near-duplicate listed 500 of a number it never
  // counted (lower bound), at 1/100 scale.
  for (let i = 1; i <= 3; i += 1) {
    await seedIssue(crawlB, {
      ruleId: "links.orphan", severity: "warning", pageId: null,
      pageUrl: `${SITE}/capped${i}`, dedupeKey: `${SITE}/capped${i}`,
      evidence: i === 3 ? { truncated: { reported: 3, total: 222 } } : {},
    });
  }
  for (let i = 1; i <= 2; i += 1) {
    await seedIssue(crawlB, {
      ruleId: "content.near-duplicate", severity: "warning", pageId: null,
      pageUrl: `${SITE}/dupe${i}`, dedupeKey: `${SITE}/dupe${i}`,
      evidence: i === 2 ? { truncated: { reported: 2, atLeast: 3 } } : {},
    });
  }

  // A crawl judged by a ruleset this one is not: ids nothing here defines.
  // Their copy cannot be joined, and the surface says so rather than answering
  // with blank titles.
  await seedIssue(crawlC, {
    ruleId: "retired.rule", severity: "warning", pageId: null,
    pageUrl: `${SITE}/retired`, dedupeKey: `${SITE}/retired`,
  });

  // The export-churn crawl: one finding now, a second one added mid-test.
  await seedIssue(crawlD, {
    ruleId: "title.missing", severity: "warning", pageId: null,
    pageUrl: `${SITE}/d1`, dedupeKey: `${SITE}/d1`,
  });

  await db.insert(metrics).values([
    { crawlId: crawlA, metricId: "redirect.volume", scope: "site", scopeValue: "", value: { ratioPct: 12 } },
    { crawlId: crawlA, metricId: "inlinks.distribution", scope: "site", scopeValue: "", value: { median: 4 } },
    { crawlId: crawlA, metricId: "content.metrics-by-type", scope: "page_type", scopeValue: "product", value: { words: 800 } },
    { crawlId: crawlA, metricId: "content.metrics-by-type", scope: "page_type", scopeValue: "blog", value: { words: 300 } },
    { crawlId: crawlB, metricId: "redirect.volume", scope: "site", scopeValue: "", value: { ratioPct: 99 } },
    { crawlId: crawlC, metricId: "retired.metric", scope: "site", scopeValue: "", value: { n: 1 } },
  ]);

  api = createApiServer({
    db,
    config: {
      token: TOKEN,
      // Empty on purpose: this server may not start a crawl, and every query
      // below still answers (the read-only posture).
      allowedDomains: [],
      exportDir,
      log: (line) => serverLog.push(line),
    },
  });
  const bound = await api.listen(0);
  base = `http://127.0.0.1:${bound.port}`;
}, 60_000);

afterAll(async () => {
  await api.close();
  for (const id of [crawlA, crawlB, crawlC, crawlD]) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  rmSync(exportDir, { recursive: true, force: true });
});

describe("GET /crawls/:id/issues", () => {
  it("groups by rule, orders by severity then rule id, and joins the registry's copy", async () => {
    const res = await call(`/crawls/${crawlA}/issues`);
    expect(res.status).toBe(200);
    const groups = items(res);
    expect(groups.map((g) => g["ruleId"])).toEqual([
      "http.server-error",
      "links.orphan",
      "sitemap.missing",
      "title.missing",
      "url.parameter-pages-indexable",
    ]);
    expect(groups.map((g) => g["severity"])).toEqual([
      "critical", "warning", "warning", "warning", "info",
    ]);

    const orphan = groups.find((g) => g["ruleId"] === "links.orphan");
    expect(orphan?.["count"]).toBe(7);
    expect(orphan?.["category"]).toBe("links");
    expect(orphan?.["checkIds"]).toEqual(["CHECK-32"]);
    expect(orphan?.["title"]).toBe("Page has no internal links pointing to it");
    // The sample is a sample: five at most, and the same five every time.
    expect(orphan?.["sampleUrls"]).toEqual([
      `${SITE}/o1`, `${SITE}/o2`, `${SITE}/o3`, `${SITE}/o4`, `${SITE}/o5`,
    ]);

    // A site-wide finding has no URL to sample, and says so with an empty list
    // rather than with a null the caller has to guess at.
    const sitemap = groups.find((g) => g["ruleId"] === "sitemap.missing");
    expect(sitemap?.["sampleUrls"]).toEqual([]);
    expect(sitemap?.["count"]).toBe(1);

    // Another crawl's rows are another crawl's.
    expect(groups.find((g) => g["ruleId"] === "title.missing")?.["count"]).toBe(2);
  });

  it("filters by severity, ruleId, checkId, category and pageType", async () => {
    const severity = await call(`/crawls/${crawlA}/issues?severity=warning`);
    expect(severity.status).toBe(200);
    expect(items(severity).map((g) => g["ruleId"])).toEqual([
      "links.orphan", "sitemap.missing", "title.missing",
    ]);

    const rule = await call(`/crawls/${crawlA}/issues?ruleId=links.orphan`);
    expect(items(rule)).toHaveLength(1);
    expect(items(rule)[0]?.["count"]).toBe(7);

    const check = await call(`/crawls/${crawlA}/issues?checkId=CHECK-35`);
    expect(items(check).map((g) => g["ruleId"])).toEqual(["title.missing"]);

    const category = await call(`/crawls/${crawlA}/issues?category=url`);
    expect(items(category).map((g) => g["ruleId"])).toEqual(["url.parameter-pages-indexable"]);

    // pageType reaches through the finding's page: one of the two
    // `title.missing` rows is on a product page, the other on a blog page.
    const productType = await call(`/crawls/${crawlA}/issues?pageType=product`);
    expect(items(productType).map((g) => g["ruleId"])).toEqual([
      "title.missing", "url.parameter-pages-indexable",
    ]);
    expect(items(productType)[0]?.["count"]).toBe(1);

    // Two filters compose: the blog page carries a critical finding as well,
    // and `severity=warning` is what leaves it out.
    const combined = await call(`/crawls/${crawlA}/issues?severity=warning&pageType=blog`);
    expect(items(combined).map((g) => g["ruleId"])).toEqual(["title.missing"]);
  });

  it("400s a filter value it does not know, naming the field", async () => {
    for (const [query, field] of [
      ["severity=urgent", "severity"],
      ["ruleId=no.such.rule", "ruleId"],
      ["checkId=CHECK-99", "checkId"],
      ["checkId=nonsense", "checkId"],
      ["category=vibes", "category"],
      ["pageType=nosuchtype", "pageType"],
    ] as const) {
      const res = await call(`/crawls/${crawlA}/issues?${query}`);
      expect(res.status, `${query} should be a 400`).toBe(400);
      expect(String(res.body["error"])).toContain(field);
    }
  });

  it("400s a check or rule that only the metric side claims, pointing at /metrics", async () => {
    // CHECK-08 is claimed by exactly one rule in this ruleset, and it is a
    // METRIC rule (`sitemap.structure`). Findings never carry a metric id, so
    // this filter's answer is structurally empty — and an empty page would read
    // as "the sitemap is fine", which is a verdict nobody reached.
    const check = await call(`/crawls/${crawlA}/issues?checkId=CHECK-08`);
    expect(check.status).toBe(400);
    expect(String(check.body["error"])).toContain("CHECK-08");
    expect(String(check.body["error"])).toContain("/metrics");

    const rule = await call(`/crawls/${crawlA}/issues?ruleId=sitemap.structure`);
    expect(rule.status).toBe(400);
    expect(String(rule.body["error"])).toContain("metric rule");

    const slice = await call(`/crawls/${crawlA}/issues/sitemap.structure/urls`);
    expect(slice.status).toBe(400);
    expect(String(slice.body["error"])).toContain("metric rule");
  });

  it("409s a crawl whose rows name a rule this ruleset does not define", async () => {
    // Copy is joined at read time, so a crawl judged by another ruleset cannot
    // be rendered — and it is refused with the fix rather than answered with
    // blank titles.
    const stale = await call(`/crawls/${crawlC}/issues`);
    expect(stale.status).toBe(409);
    expect(String(stale.body["error"])).toContain("retired.rule");
    expect(String(stale.body["error"])).toContain("re-run the rules");

    const staleMetrics = await call(`/crawls/${crawlC}/metrics`);
    expect(staleMetrics.status).toBe(409);
    expect(String(staleMetrics.body["error"])).toContain("retired.metric");
  });

  it("400s a filter combination that can select no rule rather than answering with nothing", async () => {
    const res = await call(`/crawls/${crawlA}/issues?ruleId=links.orphan&category=on-page`);
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("links.orphan");
  });

  it("pages deterministically, one group at a time, with no repeats and no gaps", async () => {
    const all = await walk(`/crawls/${crawlA}/issues`);
    expect(all.map((g) => g["ruleId"])).toEqual([
      "http.server-error",
      "links.orphan",
      "sitemap.missing",
      "title.missing",
      "url.parameter-pages-indexable",
    ]);
  });

  it("400s a limit outside the contract and a cursor it did not issue", async () => {
    expect((await call(`/crawls/${crawlA}/issues?limit=0`)).status).toBe(400);
    expect((await call(`/crawls/${crawlA}/issues?limit=201`)).status).toBe(400);
    const bad = await call(`/crawls/${crawlA}/issues?cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
    expect(String(bad.body["error"])).toContain("cursor");
  });

  it("404s an unknown crawl", async () => {
    expect((await call("/crawls/crawl_missing/issues")).status).toBe(404);
  });

  it("says so when a rule's listing was capped, in the shape the cap allows", async () => {
    const groups = items(await call(`/crawls/${crawlB}/issues`));

    // An EXACT cap: three rows listed, 222 orphans found. Quoting `count` here
    // is what the Phase 6 gate's auditor was instructed to do, and it
    // understates the site's problem by two orders of magnitude.
    const orphan = groups.find((g) => g["ruleId"] === "links.orphan");
    expect(orphan?.["count"]).toBe(3);
    expect(orphan?.["truncated"]).toBe(true);
    expect(orphan?.["total"]).toBe(222);
    expect(orphan).not.toHaveProperty("atLeast");

    // A LOWER BOUND: the rule stopped looking, so it can say what it saw and
    // nothing about what exists. `total` must NOT appear — a number in that
    // field is a promise this rule cannot keep.
    const dupes = groups.find((g) => g["ruleId"] === "content.near-duplicate");
    expect(dupes?.["count"]).toBe(2);
    expect(dupes?.["truncated"]).toBe(true);
    expect(dupes?.["atLeast"]).toBe(3);
    expect(dupes).not.toHaveProperty("total");

    // And an UNCAPPED rule says nothing at all: absence is what means "this
    // count is the whole number", so a stray flag here would be as wrong as a
    // missing one above.
    const titles = groups.find((g) => g["ruleId"] === "title.missing");
    expect(titles?.["count"]).toBe(1);
    expect(titles).not.toHaveProperty("truncated");
    expect(titles).not.toHaveProperty("total");
    expect(titles).not.toHaveProperty("atLeast");

    // The same crawl's rules under a filter: no filter may hide a cap, because
    // silence reads as "count is the total".
    const filtered = items(await call(`/crawls/${crawlB}/issues?ruleId=links.orphan`));
    expect(filtered[0]?.["truncated"]).toBe(true);
    expect(filtered[0]?.["total"]).toBe(222);
  });

  it("500s a truncation note it cannot read rather than dropping it", async () => {
    // A note that names no magnitude is a rule defect. Dropping it would answer
    // with a bare `count`, which a reader is entitled to take as the total — the
    // silent fallback hard rule 7 forbids, and the precise untruth this field
    // was added to prevent. So it is loud, and the detail stays in the log.
    const broken = `crawl_query_broken_${Date.now()}`;
    await seedCrawl(broken);
    try {
      await seedIssue(broken, {
        ruleId: "links.orphan", severity: "warning", pageId: null,
        pageUrl: `${SITE}/b`, dedupeKey: `${SITE}/b`,
        evidence: { truncated: { reported: 1 } },
      });
      const res = await call(`/crawls/${broken}/issues`);
      expect(res.status).toBe(500);
      expect(res.body["error"]).toBe("internal error");
      expect(typeof res.body["correlationId"]).toBe("string");
      expect(serverLog.some((line) => line.includes("links.orphan"))).toBe(true);
    } finally {
      await db.delete(crawls).where(eq(crawls.id, broken));
    }
  });
});

describe("GET /crawls/:id/issues/:ruleId/urls", () => {
  it("returns the URL slice with the evidence as stored, ordered by url", async () => {
    const res = await call(`/crawls/${crawlA}/issues/links.orphan/urls`);
    expect(res.status).toBe(200);
    const rows = items(res);
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r["url"])).toEqual([
      `${SITE}/o1`, `${SITE}/o2`, `${SITE}/o3`, `${SITE}/o4`,
      `${SITE}/o5`, `${SITE}/o6`, `${SITE}/o7`,
    ]);
    const first = rows[0]?.["evidence"] as Record<string, unknown>;
    expect(first["discoveredVia"]).toBe("sitemap");
    expect(first["inSitemap"]).toBe(false);
    // The wrapper is a closed shape: url and evidence, nothing else.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["evidence", "url"]);
  });

  it("never leaks a column the projection did not name", async () => {
    const res = await call(`/crawls/${crawlA}/issues/links.orphan/urls`);
    // `dedupe_key` is the sort key and is deliberately not part of the answer.
    expect(JSON.stringify(res.body)).not.toContain("dedupeKey");
    expect(JSON.stringify(res.body)).not.toContain("dedupe_key");
    expect(JSON.stringify(res.body)).not.toContain("rulesetVersion");
  });

  it("carries a finding with no page as a null url rather than dropping it", async () => {
    const res = await call(`/crawls/${crawlA}/issues/sitemap.missing/urls`);
    const rows = items(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["url"]).toBeNull();
    expect((rows[0]?.["evidence"] as Record<string, unknown>)["reason"]).toContain("Sitemap:");
  });

  it("pages deterministically through the slice", async () => {
    const walked = await walk(`/crawls/${crawlA}/issues/links.orphan/urls`, 2);
    expect(walked.map((r) => r["url"])).toEqual([
      `${SITE}/o1`, `${SITE}/o2`, `${SITE}/o3`, `${SITE}/o4`,
      `${SITE}/o5`, `${SITE}/o6`, `${SITE}/o7`,
    ]);
  });

  it("400s a rule id no ruleset defines, and 404s an unknown crawl", async () => {
    const bad = await call(`/crawls/${crawlA}/issues/no.such.rule/urls`);
    expect(bad.status).toBe(400);
    expect(String(bad.body["error"])).toContain("no.such.rule");
    expect((await call("/crawls/crawl_missing/issues/links.orphan/urls")).status).toBe(404);
  });

  it("answers with an empty page for a rule that found nothing on this crawl", async () => {
    // A real rule that simply did not fire is not an error: the caller asked a
    // question with an answer, and the answer is "none".
    const res = await call(`/crawls/${crawlA}/issues/redirect.loop/urls`);
    expect(res.status).toBe(200);
    expect(items(res)).toEqual([]);
    expect(res.body["nextCursor"]).toBeNull();
  });
});

describe("GET /crawls/:id/metrics", () => {
  it("returns the stored value with the registry's copy joined", async () => {
    const res = await call(`/crawls/${crawlA}/metrics`);
    expect(res.status).toBe(200);
    const rows = items(res);
    expect(rows.map((r) => `${String(r["metricId"])}/${String(r["scopeValue"])}`)).toEqual([
      "content.metrics-by-type/blog",
      "content.metrics-by-type/product",
      "inlinks.distribution/",
      "redirect.volume/",
    ]);
    const volume = rows.find((r) => r["metricId"] === "redirect.volume");
    expect(volume?.["scope"]).toBe("site");
    expect(volume?.["value"]).toEqual({ ratioPct: 12 });
    expect(volume?.["title"]).toBe("How much of the crawl was redirects");
    expect(typeof volume?.["explanation"]).toBe("string");
    expect(volume?.["checkIds"]).toEqual(["CHECK-10"]);
    expect(volume?.["category"]).toBe("redirects");
  });

  it("filters by metricId, scope and scopeValue", async () => {
    const byId = await call(`/crawls/${crawlA}/metrics?metricId=content.metrics-by-type`);
    expect(items(byId)).toHaveLength(2);

    const byScope = await call(`/crawls/${crawlA}/metrics?scope=site`);
    expect(items(byScope).map((r) => r["metricId"])).toEqual([
      "inlinks.distribution", "redirect.volume",
    ]);

    const byValue = await call(`/crawls/${crawlA}/metrics?scopeValue=blog`);
    expect(items(byValue)).toHaveLength(1);
    expect(items(byValue)[0]?.["value"]).toEqual({ words: 300 });
  });

  it("400s an unknown metricId, scope or scopeValue", async () => {
    for (const [query, field] of [
      ["metricId=no.such.metric", "metricId"],
      ["scope=galaxy", "scope"],
      ["scopeValue=nosuchcohort", "scopeValue"],
    ] as const) {
      const res = await call(`/crawls/${crawlA}/metrics?${query}`);
      expect(res.status, `${query} should be a 400`).toBe(400);
      expect(String(res.body["error"])).toContain(field);
    }
  });

  it("pages deterministically and 404s an unknown crawl", async () => {
    const walked = await walk(`/crawls/${crawlA}/metrics`);
    expect(walked.map((r) => `${String(r["metricId"])}/${String(r["scopeValue"])}`)).toEqual([
      "content.metrics-by-type/blog",
      "content.metrics-by-type/product",
      "inlinks.distribution/",
      "redirect.volume/",
    ]);
    expect((await call("/crawls/crawl_missing/metrics")).status).toBe(404);
  });
});

describe("GET /crawls/:id/pages", () => {
  it("returns a slim projection and nothing else", async () => {
    const res = await call(`/crawls/${crawlA}/pages`);
    expect(res.status).toBe(200);
    const rows = items(res);
    expect(rows.map((r) => r["url"])).toEqual([
      `${SITE}/b1`, `${SITE}/p1`, `${SITE}/p2`, `${SITE}/x`,
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "depth", "fetchClass", "fetchReason", "indexable", "pageType", "rendered",
      "renderError", "renderedWordCount", "statusCode", "url", "wordCount",
    ].sort());
    // The column nobody selected stays where it is.
    expect(JSON.stringify(res.body)).not.toContain("LEAK-CONTENT-HASH-MARKER");
    // …and so does everything else the row carries but the projection omits.
    expect(JSON.stringify(res.body)).not.toContain("description of p1");
  });

  it("filters by pageType, statusCode, indexable and rendered", async () => {
    const byType = await call(`/crawls/${crawlA}/pages?pageType=product`);
    expect(items(byType).map((r) => r["url"])).toEqual([`${SITE}/p1`, `${SITE}/p2`]);

    // A page the crawler could not type is a cohort of its own, named by the
    // same sentinel the metric cohorts use.
    const untyped = await call(`/crawls/${crawlA}/pages?pageType=${encodeURIComponent("(untyped)")}`);
    expect(items(untyped).map((r) => r["url"])).toEqual([`${SITE}/x`]);

    const byStatus = await call(`/crawls/${crawlA}/pages?statusCode=500`);
    expect(items(byStatus).map((r) => r["url"])).toEqual([`${SITE}/b1`]);

    const indexable = await call(`/crawls/${crawlA}/pages?indexable=true`);
    expect(indexable.status).toBe(200);
    expect(items(indexable).map((r) => r["url"])).toEqual([`${SITE}/p1`, `${SITE}/x`]);

    const notIndexable = await call(`/crawls/${crawlA}/pages?indexable=false`);
    expect(items(notIndexable).map((r) => r["url"])).toEqual([`${SITE}/p2`]);

    const rendered = await call(`/crawls/${crawlA}/pages?rendered=true`);
    expect(items(rendered).map((r) => r["url"])).toEqual([`${SITE}/p1`]);
  });

  it("400s a filter value it does not know rather than answering with an empty page", async () => {
    for (const [query, field] of [
      ["pageType=nosuchtype", "pageType"],
      ["statusCode=99", "statusCode"],
      ["statusCode=abc", "statusCode"],
      ["indexable=yes", "indexable"],
      ["rendered=1", "rendered"],
    ] as const) {
      const res = await call(`/crawls/${crawlA}/pages?${query}`);
      expect(res.status, `${query} should be a 400`).toBe(400);
      expect(String(res.body["error"])).toContain(field);
    }
  });

  it("pages deterministically by url and 404s an unknown crawl", async () => {
    const walked = await walk(`/crawls/${crawlA}/pages`);
    expect(walked.map((r) => r["url"])).toEqual([
      `${SITE}/b1`, `${SITE}/p1`, `${SITE}/p2`, `${SITE}/x`,
    ]);
    expect((await call("/crawls/crawl_missing/pages")).status).toBe(404);
  });
});

describe("GET /crawls/:id/export", () => {
  function lines(path: string): Record<string, unknown>[] {
    const text = gunzipSync(readFileSync(path)).toString("utf8");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("writes gzipped JSONL to disk and answers with a path and a count, never the rows", async () => {
    const res = await call(`/crawls/${crawlA}/export`);
    expect(res.status).toBe(200);
    expect(res.body["dataset"]).toBe("issues");
    expect(res.body["rows"]).toBe(12);
    expect(Object.keys(res.body).sort()).toEqual(["bytes", "dataset", "path", "rows"]);

    // One file per (crawl, dataset), named for the pair rather than for the
    // moment: a caller can find yesterday's export without a listing, and an
    // agent looping over /export does not fill a disk.
    const path = String(res.body["path"]);
    expect(path).toBe(join(exportDir, `${crawlA}-issues.jsonl.gz`));

    const rows = lines(path);
    expect(rows).toHaveLength(12);
    const orphan = rows.find((r) => r["ruleId"] === "links.orphan");
    expect(orphan?.["severity"]).toBe("warning");
    expect(orphan?.["category"]).toBe("links");
    expect(orphan?.["checkIds"]).toEqual(["CHECK-32"]);
    expect(typeof orphan?.["title"]).toBe("string");
    expect(typeof orphan?.["url"]).toBe("string");
    expect(orphan?.["evidence"]).toBeTypeOf("object");
  });

  it("exports the pages and metrics datasets too", async () => {
    const pagesExport = await call(`/crawls/${crawlA}/export?dataset=pages`);
    expect(pagesExport.status).toBe(200);
    expect(pagesExport.body["rows"]).toBe(4);
    expect(lines(String(pagesExport.body["path"])).map((r) => r["url"])).toEqual([
      `${SITE}/b1`, `${SITE}/p1`, `${SITE}/p2`, `${SITE}/x`,
    ]);

    const metricsExport = await call(`/crawls/${crawlA}/export?dataset=metrics`);
    expect(metricsExport.body["rows"]).toBe(4);
    expect(lines(String(metricsExport.body["path"]))[0]?.["metricId"]).toBe(
      "content.metrics-by-type",
    );
  });

  it("400s a dataset it does not have, and 404s an unknown crawl", async () => {
    const bad = await call(`/crawls/${crawlA}/export?dataset=everything`);
    expect(bad.status).toBe(400);
    expect(String(bad.body["error"])).toContain("dataset");
    expect((await call("/crawls/crawl_missing/export")).status).toBe(404);
  });

  it("replaces the file on a re-export instead of accumulating copies", async () => {
    const first = await call(`/crawls/${crawlD}/export`);
    expect(first.status).toBe(200);
    expect(first.body["rows"]).toBe(1);

    await seedIssue(crawlD, {
      ruleId: "title.missing", severity: "warning", pageId: null,
      pageUrl: `${SITE}/d2`, dedupeKey: `${SITE}/d2`,
    });

    const second = await call(`/crawls/${crawlD}/export`);
    expect(second.body["path"]).toBe(first.body["path"]);
    expect(second.body["rows"]).toBe(2);

    // One file for this crawl, and it holds the SECOND export's rows — not the
    // first's, and not a concatenation of both.
    const mine = readdirSync(exportDir).filter((name) => name.startsWith(crawlD));
    expect(mine).toEqual([`${crawlD}-issues.jsonl.gz`]);
    expect(lines(String(second.body["path"])).map((r) => r["url"])).toEqual([
      `${SITE}/d1`, `${SITE}/d2`,
    ]);
  });

  it("survives a write that fails, leaves no temp file, and keeps serving", async () => {
    // The write side fails on its own schedule while this method is parked in a
    // database await. Before the fix, `pipeline()`'s rejection had no handler at
    // the moment it rejected — an unhandled rejection, which ends the process in
    // Node 22. A full disk would have taken the API server down with it.
    //
    // Root ignores the permission bits, so a root run would prove nothing. It is
    // an error rather than a skip: a test that passes without testing anything
    // is the silent fallback this repo does not allow.
    const uid = process.getuid?.();
    if (uid === 0) throw new Error("this test cannot run as root: chmod would not deny the write");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    chmodSync(exportDir, 0o500); // read and traverse, but nothing may be created
    try {
      const res = await call(`/crawls/${crawlA}/export?dataset=pages`);
      expect(res.status).toBe(500);
      expect(res.body["error"]).toBe("internal error");
      expect(typeof res.body["correlationId"]).toBe("string");
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled, "the export left a rejection for nobody to handle").toEqual([]);
    } finally {
      chmodSync(exportDir, 0o700);
      process.off("unhandledRejection", onUnhandled);
    }

    // The server is still there, and the export still works — with no temp
    // file left behind by the failed attempt.
    const after = await call(`/crawls/${crawlA}/export?dataset=pages`);
    expect(after.status).toBe(200);
    expect(after.body["rows"]).toBe(4);
    expect(readdirSync(exportDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

describe("unknown query parameters", () => {
  it("refuses a typo'd filter instead of answering the question nobody asked", async () => {
    // Both of these used to come back 200 with the WHOLE listing — a caller
    // reading `?serverity=critical` as "these are the critical findings" and
    // `?indexible=true` as "these are the indexable pages". A filter the server
    // silently drops is a wrong answer with a success code on it.
    const severity = await call(`/crawls/${crawlA}/issues?serverity=critical`);
    expect(severity.status).toBe(400);
    expect(String(severity.body["error"])).toContain("serverity");
    expect(String(severity.body["error"])).toContain("severity");

    const indexable = await call(`/crawls/${crawlA}/pages?indexible=true`);
    expect(indexable.status).toBe(400);
    expect(String(indexable.body["error"])).toContain("indexible");
    expect(String(indexable.body["error"])).toContain("indexable");
  });

  it("holds on every listing, including the ones with no filters at all", async () => {
    for (const path of [
      `/crawls/${crawlA}/issues?nope=1`,
      `/crawls/${crawlA}/issues/links.orphan/urls?severity=warning`,
      `/crawls/${crawlA}/metrics?pageType=product`,
      `/crawls/${crawlA}/pages?checkId=CHECK-35`,
      `/crawls/${crawlA}/export?limit=5`,
      `/crawls/${crawlA}?limit=5`,
    ]) {
      const res = await call(path);
      expect(res.status, `${path} should be a 400`).toBe(400);
      expect(String(res.body["error"])).toContain("unknown query parameter");
    }
  });

  it("still accepts every parameter each listing does document", async () => {
    const issues = await call(
      `/crawls/${crawlA}/issues?severity=warning&category=links&checkId=CHECK-32&ruleId=links.orphan&limit=5`,
    );
    expect(issues.status).toBe(200);
    const pages = await call(
      `/crawls/${crawlA}/pages?pageType=product&statusCode=200&indexable=true&rendered=true&limit=5`,
    );
    expect(pages.status).toBe(200);
  });
});

describe("the query surface is behind the same token as the rest", () => {
  it("401s every query route without a credential", async () => {
    for (const path of [
      `/crawls/${crawlA}/issues`,
      `/crawls/${crawlA}/issues/links.orphan/urls`,
      `/crawls/${crawlA}/metrics`,
      `/crawls/${crawlA}/pages`,
      `/crawls/${crawlA}/export`,
    ]) {
      expect((await call(path, { token: null })).status).toBe(401);
    }
  });
});

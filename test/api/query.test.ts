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
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, metrics, pages } from "../../src/db/schema.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { ROBOTS_OUTCOMES } from "../../src/crawl/discovery.js";
import { buildRegistry } from "../../src/rules/index.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";

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
/**
 * The surface-exposure crawl: a stored `legacyHosts`, a discovery blob with a
 * real robots.txt in it, and pages spanning the fetch-class and discovery
 * vocabularies. Its own crawl so the listings above keep their exact rows.
 */
let crawlE = "";

/**
 * The comparison fixtures — six crawls whose only job is to make one cross-crawl
 * diff exact and every refusal reachable.
 *
 * `cmpBase` and `cmpHead` are the same site judged twice under the same ruleset
 * and the same (uncapped) finding cap: the clean pair, where `comparable` is
 * true and every count is arithmetic nobody has to caveat. The other four each
 * break exactly one thing, so a caveat that appears can only have come from the
 * difference it is named for.
 */
let cmpBase = "";
let cmpHead = "";
/** Same site, same cap, a DIFFERENT ruleset — and one rule's severity moved. */
let cmpOld = "";
/** Same site, same ruleset, a different finding cap (absent, so the 200 default). */
let cmpCapped = "";
/** Another site entirely: the cross-site refusal, and the site filter's control. */
let cmpOther = "";
/** The `www` spelling of `cmpOther`'s site — one site by the engine's definition. */
let cmpWww = "";
/** Same site as the pair, never judged: `rules_run_at` null with rows in the table. */
let cmpUnjudged = "";
/**
 * Same site, same cap, findings from TWO ruleset versions — a crawl judged
 * across a change, or half re-judged. No single version describes it.
 */
let cmpMixed = "";
/**
 * TWO judged crawls whose findings carry the pre-stamp empty ruleset version.
 *
 * The pair exists because `"" === ""` is the one way two sides can *agree* on
 * having recorded nothing at all. Before the guard they came back
 * `comparable: true` with no caveat — the strongest answer the surface has,
 * produced from the total absence of evidence.
 */
let cmpUnstampedA = "";
let cmpUnstampedB = "";

/** The ruleset the comparison pair's findings are stamped with. */
const CMP_RULESET = "0.9.0-test";
/** The ruleset `cmpOld` was judged by — one version behind, deliberately. */
const CMP_OLD_RULESET = "0.8.0-test";
/** The other site the compare fixtures use. Its own host, so nothing else matches it. */
const OTHER_SITE = "http://compare-other.example";

/** The robots.txt `crawlE` read, as the discovery evidence stores it. */
const ROBOTS_TEXT = "User-agent: *\nDisallow: /admin\nCrawl-delay: 2\nSitemap: http://query.example/sitemap.xml\n";

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

async function seedCrawl(
  id: string,
  opts: {
    config?: Record<string, unknown>;
    discovery?: unknown;
    judged?: boolean;
    /** Defaults to `SITE` — the compare fixtures are the only rows that move it. */
    siteUrl?: string;
  } = {},
): Promise<void> {
  await db.insert(crawls).values({
    id,
    siteUrl: opts.siteUrl ?? `${SITE}/`,
    config: opts.config ?? { siteUrl: `${SITE}/` },
    rulesetVersion: "0.0.0-test",
    status: "finished",
    ...(opts.discovery === undefined ? {} : { discovery: opts.discovery }),
    // `judged` stamps `rules_run_at`, which is the ONLY thing that says a rules
    // pass completed over this crawl. The seeded rows below are written by hand
    // either way; the marker is what makes an empty rule "ran and found
    // nothing" rather than "nobody has looked".
    ...(opts.judged === true ? { rulesRunAt: new Date("2026-08-30T09:00:00.000Z") } : {}),
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
  /** Defaults to the status code's class, as a real crawl's row would carry. */
  fetchClass?: string;
  /** Defaults to the depth's usual origin: the seed at 0, a link below it. */
  discoveredVia?: string;
  renderableWordCount?: number | null;
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
    fetchClass: p.fetchClass ?? (p.statusCode >= 500 ? "server_error" : "ok"),
    depth: p.depth,
    discoveredVia: p.discoveredVia ?? (p.depth === 0 ? "seed" : "link"),
    isIndexable: p.isIndexable,
    wordCount: p.wordCount,
    ...(p.renderableWordCount === undefined
      ? {}
      : { renderableWordCount: p.renderableWordCount }),
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
    /**
     * The ruleset stamped on the ROW — what a comparison reads to decide
     * whether the two sides were judged by the same rules. Defaults to the one
     * every other fixture uses.
     */
    rulesetVersion?: string;
  },
): Promise<void> {
  await db.insert(issues).values({
    crawlId,
    ruleId: row.ruleId,
    pageId: row.pageId ?? null,
    severity: row.severity,
    rulesetVersion: row.rulesetVersion ?? "0.0.0-test",
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
  crawlE = `crawl_query_e_${stamp}`;
  for (const id of [crawlA, crawlD]) await seedCrawl(id);
  // JUDGED, and the two of them for different reasons. crawlB is the catalog's
  // fired-state fixture: a completed pass is what makes a rule with no rows a
  // real clean rather than an unasked question. crawlC is judged so that its
  // rows for a retired rule id are reached at all — an unjudged crawl answers
  // `fired: null` without ever reading a count.
  for (const id of [crawlB, crawlC]) await seedCrawl(id, { judged: true });

  // The surface-exposure crawl. Its config carries the two legacy domains the
  // crawl was told about (CHECK-15's evidence is unreadable without them), and
  // its discovery blob carries the robots.txt the crawl obeyed.
  await seedCrawl(crawlE, {
    config: {
      siteUrl: `${SITE}/`,
      userAgent: "AriadneBot/0.1 (query-test)",
      legacyHosts: ["old.query.example", "legacy.query.example"],
    },
    discovery: {
      robots: {
        outcome: "read",
        crawlDelaySec: 2,
        note: null,
        raw: ROBOTS_TEXT,
        truncated: false,
      },
      sitemapSources: [`${SITE}/sitemap.xml`],
      truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 1 },
      docsFetched: 1,
    },
  });
  // The fetch-class and discovery cohorts, one page each: what a blocked-page
  // question and an orphan cross-check actually select on.
  await seedPage(crawlE, {
    slug: "home", pageType: "home", statusCode: 200, isIndexable: true, rendered: false,
    depth: 0, wordCount: 900, renderableWordCount: 640, discoveredVia: "seed",
  });
  await seedPage(crawlE, {
    slug: "blocked", pageType: null, statusCode: 429, isIndexable: null, rendered: false,
    depth: 1, wordCount: null, fetchClass: "blocked", discoveredVia: "link",
  });
  await seedPage(crawlE, {
    slug: "only-in-sitemap", pageType: "product", statusCode: 200, isIndexable: true,
    rendered: false, depth: 1, wordCount: 300, renderableWordCount: 300,
    discoveredVia: "sitemap",
  });
  await seedPage(crawlE, {
    slug: "moved", pageType: null, statusCode: 301, isIndexable: false, rendered: false,
    depth: 1, wordCount: null, fetchClass: "redirect", discoveredVia: "link",
  });
  await seedPage(crawlE, {
    slug: "target", pageType: "product", statusCode: 200, isIndexable: true, rendered: false,
    depth: 2, wordCount: 120, renderableWordCount: 90, discoveredVia: "redirect",
  });

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

  // ------------------------------------------------------- the compare fixtures
  cmpBase = `crawl_cmp_base_${stamp}`;
  cmpHead = `crawl_cmp_head_${stamp}`;
  cmpOld = `crawl_cmp_old_${stamp}`;
  cmpCapped = `crawl_cmp_capped_${stamp}`;
  cmpOther = `crawl_cmp_other_${stamp}`;
  cmpWww = `crawl_cmp_www_${stamp}`;
  cmpUnjudged = `crawl_cmp_unjudged_${stamp}`;
  cmpMixed = `crawl_cmp_mixed_${stamp}`;
  cmpUnstampedA = `crawl_cmp_unstamped_a_${stamp}`;
  cmpUnstampedB = `crawl_cmp_unstamped_b_${stamp}`;

  // `findingCap: null` on both halves of the pair, so the ONLY caveat the clean
  // comparison could raise is one this fixture did not put there.
  const uncapped = { siteUrl: `${SITE}/`, findingCap: null };
  for (const id of [cmpBase, cmpHead, cmpOld]) {
    await seedCrawl(id, { judged: true, config: uncapped });
  }
  // No `findingCap` key at all: the engine's 200 default, which is what makes
  // this crawl differ from the pair in exactly one way.
  await seedCrawl(cmpCapped, { judged: true });
  await seedCrawl(cmpOther, { judged: true, siteUrl: `${OTHER_SITE}/`, config: uncapped });
  await seedCrawl(cmpWww, { judged: true, siteUrl: `http://www.compare-other.example/`, config: uncapped });
  // Rows in the table and no marker: the shape a rules pass that died part-way
  // leaves behind, and the shape the reference crawl `crawl_2af4daf1` is in.
  await seedCrawl(cmpUnjudged, { config: uncapped });
  for (const id of [cmpMixed, cmpUnstampedA, cmpUnstampedB]) {
    await seedCrawl(id, { judged: true, config: uncapped });
  }

  const cmpIssue = (
    crawlId: string,
    ruleId: string,
    severity: string,
    slug: string | null,
    extra: { dedupeKey?: string; rulesetVersion?: string; evidence?: Record<string, unknown> } = {},
  ): Promise<void> =>
    seedIssue(crawlId, {
      ruleId,
      severity,
      pageId: null,
      pageUrl: slug === null ? null : `${SITE}/${slug}`,
      dedupeKey: extra.dedupeKey ?? (slug === null ? "site" : `${SITE}/${slug}`),
      rulesetVersion: extra.rulesetVersion ?? CMP_RULESET,
      ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
    });

  // BASE. title.missing on a,b,c; five orphans; one site-wide finding; one info.
  for (const slug of ["a", "b", "c"]) await cmpIssue(cmpBase, "title.missing", "warning", slug);
  for (let i = 1; i <= 5; i += 1) await cmpIssue(cmpBase, "links.orphan", "warning", `o${i}`);
  await cmpIssue(cmpBase, "sitemap.missing", "warning", null);
  await cmpIssue(cmpBase, "title.too-long", "info", "t1");

  // HEAD. title.missing moved on by one page (a resolved, d new, b and c
  // persisting); the orphans are gone; five new missing descriptions; and a rule
  // that fired THREE TIMES ON ONE PAGE, which is the multi-finding collapse.
  for (const slug of ["b", "c", "d"]) await cmpIssue(cmpHead, "title.missing", "warning", slug);
  for (let i = 1; i <= 5; i += 1) {
    await cmpIssue(cmpHead, "meta-description.missing", "warning", `m${i}`);
  }
  for (let i = 1; i <= 3; i += 1) {
    // The dedupe keys are content hashes, which is what several real rules use
    // and precisely why the diff joins on the URL instead.
    await cmpIssue(cmpHead, "content.exact-duplicate", "warning", "dup", {
      dedupeKey: `hash-of-some-content-${i}`,
    });
  }
  await cmpIssue(cmpHead, "title.too-long", "info", "t1");

  // OLD RULESET. Two rules, one of them recorded at a severity this ruleset does
  // not use for it — the cross-severity case.
  for (const slug of ["a", "b"]) {
    await cmpIssue(cmpOld, "title.missing", "critical", slug, { rulesetVersion: CMP_OLD_RULESET });
  }
  await cmpIssue(cmpOld, "links.orphan", "warning", "o1", { rulesetVersion: CMP_OLD_RULESET });

  // CAPPED. The same ruleset as the pair, one rule, and a truncation note on it:
  // the per-rule flag that says WHICH rule the cap actually cut.
  await cmpIssue(cmpCapped, "title.missing", "warning", "a", {
    evidence: { truncated: { reported: 1, total: 200 } },
  });

  // The unjudged crawl holds rows, so its refusal cannot be mistaken for "there
  // is nothing there".
  await cmpIssue(cmpUnjudged, "title.missing", "warning", "a");

  // MIXED. One crawl, two ruleset versions on its rows — the state a crawl is in
  // when a judgement was made across a ruleset change, or half re-run. Uncapped
  // like the pair, so the mixed caveat is the only one that can fire.
  for (const slug of ["a", "b"]) await cmpIssue(cmpMixed, "title.missing", "warning", slug);
  await cmpIssue(cmpMixed, "links.orphan", "warning", "o1", {
    rulesetVersion: CMP_OLD_RULESET,
  });

  // UNSTAMPED. `issues.ruleset_version` defaults to the empty string for rows
  // written before the stamp existed (schema.ts), and the empty string is not a
  // version — two of these agree on nothing.
  for (const id of [cmpUnstampedA, cmpUnstampedB]) {
    await cmpIssue(id, "title.missing", "warning", "a", { rulesetVersion: "" });
  }

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
  for (const id of [
    crawlA, crawlB, crawlC, crawlD, crawlE,
    cmpBase, cmpHead, cmpOld, cmpCapped, cmpOther, cmpWww, cmpUnjudged,
    cmpMixed, cmpUnstampedA, cmpUnstampedB,
  ]) {
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
      // Both depths: `depth` is where the crawler's frontier found the URL,
      // `clickDepth` is how many internal links from the home page it takes to
      // get there (null when nothing reaches it). CHECK-31 asks for the second
      // per page, so the projection carries it.
      "clickDepth", "depth", "discoveredVia", "fetchClass", "fetchReason", "indexable",
      "pageType", "rendered", "renderError", "renderableWordCount", "renderedWordCount",
      // The rendered side of `content.csr-dependent` since P8-T1, published so
      // an agent can check the rule COULD have fired before reading its silence
      // as a pass. `renderedWordCount` beside it is the browser's innerText and
      // is now evidence only — two instruments, both on the wire, named apart.
      "renderedRenderableWordCount",
      "statusCode", "url", "wordCount",
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

  // The two filters the audit could not ask for until now. Blocked pages were
  // a number on the crawl detail with no way to list the URLs behind it, and
  // "which pages did only the sitemap know about" — the orphan cross-check —
  // had no filter at all. Both are closed vocabularies owned by the crawl
  // layer, so both are validated against it rather than passed to SQL.
  it("filters by fetchClass and discoveredVia, and by both at once", async () => {
    const blocked = await call(`/crawls/${crawlE}/pages?fetchClass=blocked`);
    expect(items(blocked).map((r) => r["url"])).toEqual([`${SITE}/blocked`]);

    const ok = await call(`/crawls/${crawlE}/pages?fetchClass=ok`);
    expect(items(ok).map((r) => r["url"])).toEqual([
      `${SITE}/home`, `${SITE}/only-in-sitemap`, `${SITE}/target`,
    ]);

    const sitemapOnly = await call(`/crawls/${crawlE}/pages?discoveredVia=sitemap`);
    expect(items(sitemapOnly).map((r) => r["url"])).toEqual([`${SITE}/only-in-sitemap`]);

    const viaLink = await call(`/crawls/${crawlE}/pages?discoveredVia=link`);
    expect(items(viaLink).map((r) => r["url"])).toEqual([`${SITE}/blocked`, `${SITE}/moved`]);

    // The filters intersect, as every other pair on this listing does.
    const both = await call(`/crawls/${crawlE}/pages?fetchClass=redirect&discoveredVia=link`);
    expect(items(both).map((r) => r["url"])).toEqual([`${SITE}/moved`]);

    // And a cohort that exists in one vocabulary but not in this crawl is an
    // empty page rather than a refusal: the value is real, the crawl has none.
    const timeouts = await call(`/crawls/${crawlE}/pages?fetchClass=timeout`);
    expect(timeouts.status).toBe(200);
    expect(items(timeouts)).toEqual([]);
  });

  it("carries both word counts, so the number a reader quotes is the one they can see", async () => {
    const res = await call(`/crawls/${crawlE}/pages?pageType=home`);
    const row = items(res)[0];
    expect(row?.["url"]).toBe(`${SITE}/home`);
    // The HTML's whole count, and the count minus the markup-hidden words. The
    // surface used to publish only the first, which on a page like this is 260
    // words nobody sees.
    expect(row?.["wordCount"]).toBe(900);
    expect(row?.["renderableWordCount"]).toBe(640);
    expect(row?.["discoveredVia"]).toBe("seed");

    // Null is "never measured" — a crawl that predates the column — and it is
    // carried as null rather than collapsed onto wordCount, which counts
    // something else.
    const blocked = await call(`/crawls/${crawlE}/pages?fetchClass=blocked`);
    expect(items(blocked)[0]?.["renderableWordCount"]).toBeNull();

    // The projection is still the allowlist: nothing else came with them.
    expect(JSON.stringify(res.body)).not.toContain("description of home");
  });

  it("400s a filter value it does not know rather than answering with an empty page", async () => {
    for (const [query, field] of [
      ["pageType=nosuchtype", "pageType"],
      ["statusCode=99", "statusCode"],
      ["statusCode=abc", "statusCode"],
      ["indexable=yes", "indexable"],
      ["rendered=1", "rendered"],
      ["fetchClass=blocke", "fetchClass"],
      ["fetchClass=200", "fetchClass"],
      ["discoveredVia=crawl", "discoveredVia"],
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

describe("GET /crawls/:id/robots", () => {
  it("answers with the robots.txt the crawl read, and the metadata that makes it readable", async () => {
    const res = await call(`/crawls/${crawlE}/robots`);
    expect(res.status).toBe(200);
    expect(res.body["crawlId"]).toBe(crawlE);
    // Derived from the crawl's own seed: the URL the crawler asked for.
    expect(res.body["robotsUrl"]).toBe(`${SITE}/robots.txt`);
    expect(res.body["outcome"]).toBe("read");
    // The body, verbatim — this is the file the findings were judged against,
    // not whatever the site serves today.
    expect(res.body["raw"]).toBe(ROBOTS_TEXT);
    expect(res.body["truncated"]).toBe(false);
    expect(res.body["crawlDelaySec"]).toBe(2);
    expect(res.body["note"]).toBeNull();
    expect(res.body["sitemapSources"]).toEqual([`${SITE}/sitemap.xml`]);
    // This crawl's evidence carries no supplied list — it was written before a
    // client could hand the crawl a sitemap. Absent reads as empty, which is
    // the only thing it can honestly mean.
    expect(res.body["suppliedSitemaps"]).toEqual([]);
    // The groups in the file that governed this crawl.
    expect(res.body["userAgent"]).toBe("AriadneBot/0.1 (query-test)");

    // The wrapper is a closed shape, even though the body inside it is the
    // site's own public document: the blob it comes out of holds the sitemap
    // walk's counters too, and none of them are here.
    expect(Object.keys(res.body).sort()).toEqual([
      "crawlDelaySec", "crawlId", "note", "outcome", "raw", "robotsUrl",
      "sitemapSources", "suppliedSitemaps", "truncated", "userAgent",
    ]);
  });

  // THE VOCABULARY IS THE CRAWL LAYER'S, NOT A COPY. `parseRobots` validates
  // the stored outcome, so a fourth outcome added to `ROBOTS_OUTCOMES` and not
  // mirrored into the API would make every new crawl's evidence unreadable —
  // robots_get and the render path refusing rows that are perfectly sound. The
  // list is imported rather than restated, here and in the service.
  it("accepts every outcome the crawl layer can record", async () => {
    const ids: string[] = [];
    try {
      for (const outcome of ROBOTS_OUTCOMES) {
        const id = `crawl_query_robots_${outcome}_${Date.now()}`;
        ids.push(id);
        await seedCrawl(id, {
          config: { siteUrl: `${SITE}/` },
          discovery: {
            // `read` is the only outcome that stores text; the other two are a
            // note about why there is none.
            robots: {
              outcome,
              crawlDelaySec: null,
              note: outcome === "read" ? null : `robots.txt ${outcome}`,
              raw: outcome === "read" ? ROBOTS_TEXT : null,
              truncated: false,
            },
            sitemapSources: [],
            truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 0 },
            docsFetched: 0,
          },
        });

        const res = await call(`/crawls/${id}/robots`);
        expect(res.status, `outcome '${outcome}' should be readable`).toBe(200);
        expect(res.body["outcome"]).toBe(outcome);
        expect(res.body["raw"]).toBe(outcome === "read" ? ROBOTS_TEXT : null);
      }
    } finally {
      for (const id of ids) await db.delete(crawls).where(eq(crawls.id, id));
    }
  });

  it("409s an outcome no crawl of ours writes rather than passing it through", async () => {
    const id = `crawl_query_robots_bogus_${Date.now()}`;
    try {
      await seedCrawl(id, {
        config: { siteUrl: `${SITE}/` },
        discovery: {
          robots: { outcome: "maybe", crawlDelaySec: null, note: null, raw: null, truncated: false },
          sitemapSources: [],
          truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 0 },
          docsFetched: 0,
        },
      });
      const res = await call(`/crawls/${id}/robots`);
      expect(res.status).toBe(409);
      expect(String(res.body["error"])).toContain("robots.outcome");
    } finally {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
  });

  it("409s a crawl with no discovery evidence rather than reporting 'no robots.txt'", async () => {
    // crawlA never completed discovery. "We have no record" and "the site has
    // no robots.txt" are different facts, and only one of them is true here.
    const res = await call(`/crawls/${crawlA}/robots`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("discovery evidence");
  });

  it("404s an unknown crawl and takes no query parameters", async () => {
    expect((await call("/crawls/crawl_missing/robots")).status).toBe(404);
    const extra = await call(`/crawls/${crawlE}/robots?limit=5`);
    expect(extra.status).toBe(400);
    expect(String(extra.body["error"])).toContain("unknown query parameter");
  });
});

describe("GET /crawls/:id — the fields an audit checks itself against", () => {
  it("echoes the legacy hosts the crawl was configured with, and an empty list when there were none", async () => {
    const withHosts = await call(`/crawls/${crawlE}`);
    expect(withHosts.status).toBe(200);
    expect(withHosts.body["legacyHosts"]).toEqual([
      "old.query.example",
      "legacy.query.example",
    ]);

    // Present and empty, not absent: "no legacy domain was named" is an answer,
    // and a missing field would leave a reader unable to tell it from a
    // surface that does not report the setting at all.
    const without = await call(`/crawls/${crawlA}`);
    expect(without.body["legacyHosts"]).toEqual([]);
  });

  it("reports rulesRunAt null and the live findings count on an unjudged crawl", async () => {
    const res = await call(`/crawls/${crawlA}`);
    // These rows were seeded, not judged: no rules run has ever completed over
    // this crawl, and the marker says so even though the issues table is full.
    expect(res.body["rulesRunAt"]).toBeNull();

    const rows = await db.select().from(issues).where(eq(issues.crawlId, crawlA));
    expect(res.body["findingsCount"]).toBe(rows.length);
    expect(Number(res.body["findingsCount"])).toBeGreaterThan(0);

    // A crawl with no findings at all: zero, beside a null marker, is "nobody
    // has looked" rather than "this site is clean".
    const clean = await call(`/crawls/${crawlE}`);
    expect(clean.body["findingsCount"]).toBe(0);
    expect(clean.body["rulesRunAt"]).toBeNull();
  });

  // pagesScanned DESCRIBES THE CRAWL, NOT A RUN — which is the whole reason it
  // is worth having. It counts the `pages` rows, and a rules run's page cursor
  // iterates every one of them with no filter, so the number is answerable
  // before anybody judges the crawl and stays true afterwards. Neither of these
  // two crawls has ever been judged, and both report it.
  it("reports the pages a rules run would scan, on crawls nobody has judged", async () => {
    for (const id of [crawlA, crawlE]) {
      const res = await call(`/crawls/${id}`);
      const rows = await db.select({ id: pages.id }).from(pages).where(eq(pages.crawlId, id));
      expect(rows.length, `${id} seeds no pages, so this proves nothing`).toBeGreaterThan(0);
      expect(res.body["pagesScanned"], `${id} misreports its page count`).toBe(rows.length);
      expect(res.body["rulesRunAt"]).toBeNull();
    }
  });

  // ONE STATEMENT, ONE SNAPSHOT. rulesRunAt and findingsCount describe each
  // other — an agent is told to read `findingsCount: 0` beside a timestamp as
  // "looked, found nothing" — and a rules run clears the marker and deletes the
  // crawl's issues in a single transaction. Read on two pool connections, a
  // crawl-row read landing just before that commit and a count landing just
  // after would compose `{rulesRunAt: <the previous run's stamp>,
  // findingsCount: 0}`: a state that never existed, reported as a clean site.
  // The race is not deterministically reproducible, so what is asserted is the
  // property that removes it — the count comes out of the crawl-row statement.
  it("reads the marker and the findings count from one statement, not two snapshots", async () => {
    const pool = db.$pool as unknown as { query: (...args: unknown[]) => unknown };
    const original = pool.query.bind(pool);
    const statements: string[] = [];
    pool.query = (...args: unknown[]) => {
      const first = args[0];
      statements.push(
        typeof first === "string" ? first : String((first as { text?: unknown })?.text ?? ""),
      );
      return original(...args);
    };

    let res: Res;
    try {
      res = await call(`/crawls/${crawlA}`);
    } finally {
      pool.query = original;
    }
    expect(res.status).toBe(200);

    // Exactly one statement of the whole request touches `issues`…
    const touchingIssues = statements.filter((sql) => /\bissues\b/.test(sql));
    expect(touchingIssues).toHaveLength(1);
    // …and it is the one that reads the crawl row, marker included.
    expect(touchingIssues[0]).toMatch(/\bcrawls\b/);
    expect(touchingIssues[0]).toMatch(/rules_run_at/);
    // The page count rides the SAME statement, for the same reason and not to
    // save a round trip: `pagesScanned` beside `rulesRunAt` is read as "judged
    // over N pages", so a torn read would let a crawl report a marker from
    // before a re-crawl against a page count from after it. (`pages_crawled` is
    // a different column and does not match this: `_` is a word character.)
    expect(touchingIssues[0]).toMatch(/\bpages\b/);

    // AND BOTH CORRELATIONS ARE QUALIFIED. An unqualified `where "crawl_id" =
    // "id"` binds BOTH names in the subquery's own scope, so the correlation
    // silently becomes `pages.crawl_id = pages.id` and the count is 0 on every
    // crawl — which reads as "nothing there" rather than as an error. The page
    // count was written that way first and counted zero; the findings count
    // has always been written that way and is correct only because `issues`
    // has no `id` column for the inner scope to capture. This pins the
    // qualification instead of the accident.
    expect(touchingIssues[0]).toMatch(/"issues"\."crawl_id" = "crawls"\."id"/);
    expect(touchingIssues[0]).toMatch(/"pages"\."crawl_id" = "crawls"\."id"/);
  });

  it("reports the stamp a completed rules run leaves, as an ISO timestamp", async () => {
    const stamped = new Date("2026-08-28T10:11:12.000Z");
    await db.update(crawls).set({ rulesRunAt: stamped }).where(eq(crawls.id, crawlE));
    const res = await call(`/crawls/${crawlE}`);
    expect(res.body["rulesRunAt"]).toBe(stamped.toISOString());
    await db.update(crawls).set({ rulesRunAt: null }).where(eq(crawls.id, crawlE));
  });
});

/**
 * The rule catalog: the checklist a dashboard renders before it has a finding
 * to show, and the same checklist with one crawl's fired state joined onto it.
 *
 * EVERY EXPECTATION ABOUT HOW MANY RULES THERE ARE IS DERIVED FROM
 * `buildRegistry()`, never written as a number. The registry is what the
 * endpoint walks, so a hardcoded 85 here would be a second, staler statement of
 * the ruleset's size that the next rule to be added would have to be taught
 * about. `test/rules/coverage.test.ts` owns the exact-count pins; this file
 * owns the SHAPE and the SEMANTICS.
 */
describe("GET /rules", () => {
  const registry = buildRegistry();

  function rulesOf(res: Res): Record<string, unknown>[] {
    const value = res.body["rules"];
    if (!Array.isArray(value)) throw new Error(`no rules in ${JSON.stringify(res.body)}`);
    return value as Record<string, unknown>[];
  }

  function byId(res: Res): Map<string, Record<string, unknown>> {
    return new Map(rulesOf(res).map((rule) => [String(rule["id"]), rule]));
  }

  it("answers the whole ruleset with its client-facing copy and no fired state", async () => {
    const res = await call("/rules");
    expect(res.status).toBe(200);
    expect(res.body["rulesetVersion"]).toBe(RULESET_VERSION);

    const rules = rulesOf(res);
    expect(rules).toHaveLength(registry.all().length);
    expect(rules.map((r) => String(r["id"])).sort()).toEqual(
      registry.all().map((r) => r.id).sort(),
    );
    for (const kind of ["page", "query", "metric"] as const) {
      expect(rules.filter((r) => r["kind"] === kind), `${kind} rules`).toHaveLength(
        registry.byKind(kind).length,
      );
    }

    for (const rule of rules) {
      const id = String(rule["id"]);
      // The copy is the whole point of the skeleton: a checklist rendered with
      // blank rows is a checklist nobody can read.
      for (const field of ["title", "explanation", "howToFix", "category"] as const) {
        expect(String(rule[field] ?? ""), `${id} has no ${field}`).not.toBe("");
      }
      expect(["critical", "warning", "info"]).toContain(rule["severity"]);
      expect(["page", "query", "metric"]).toContain(rule["kind"]);
      expect(Array.isArray(rule["checkIds"])).toBe(true);
      expect((rule["checkIds"] as string[]).length, `${id} claims no check`).toBeGreaterThan(0);
      // ABSENT, not null: nobody named a crawl, so there is no fired state to
      // report — which is a different sentence from "this crawl was never
      // judged" (null) and from "this rule found nothing" ({count: 0}).
      expect(rule, `${id} carries a fired state nobody asked for`).not.toHaveProperty("fired");
    }
  });

  it("orders the catalog the way issues_list orders its groups", async () => {
    const rules = rulesOf(await call("/rules"));
    const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    const keys = rules.map((r) => [rank[String(r["severity"])] ?? 9, String(r["id"])] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    expect(keys).toEqual(sorted);
  });

  it("joins a judged crawl's fired state, and counts a clean rule as zero", async () => {
    const res = await call(`/rules?crawlId=${crawlB}`);
    expect(res.status).toBe(200);
    const rules = byId(res);
    expect(rules.size).toBe(registry.all().length);

    // A rule that fired carries its exact row count…
    expect(rules.get("title.missing")?.["fired"]).toEqual({ count: 1 });
    // …and a rule that did not fire carries a zero, which on a JUDGED crawl is
    // a real measurement: the rule ran over this site and found nothing.
    expect(rules.get("http.server-error")?.["fired"]).toEqual({ count: 0 });

    // The counts are the crawl's whole findings table, redistributed: they sum
    // to the number crawl_status reports, so a dashboard can render the
    // checklist and the total from one answer without them disagreeing.
    const total = [...rules.values()].reduce(
      (n, rule) => n + Number((rule["fired"] as Record<string, unknown>)["count"]),
      0,
    );
    const detail = await call(`/crawls/${crawlB}`);
    expect(detail.body["findingsCount"]).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it("marks a metric rule's structural zero apart from a real clean", async () => {
    // A metric rule measures rather than finds: it writes no issues on ANY
    // crawl, so its count is 0 by construction. In the bare `{count: 0}` shape
    // that is indistinguishable from a rule that ran and found nothing, and a
    // dashboard would render "passed" against a rule that never had a verdict
    // to give. The issues routes refuse to answer for these rules at all
    // (`findingRule`); the catalog lists the whole ruleset and cannot refuse,
    // so it says which kind of zero this is — on the payload, not only in a
    // tool description a UI author never reads.
    const rules = byId(await call(`/rules?crawlId=${crawlB}`));
    const metricIds = registry.byKind("metric").map((r) => r.id);
    expect(metricIds.length).toBeGreaterThan(0);
    for (const id of metricIds) {
      expect(rules.get(id)?.["fired"], `${id} is not marked`).toEqual({
        count: 0,
        measuresOnly: true,
      });
    }
    // The flag is the metric rules' and nobody else's — least of all the rules
    // whose zero IS the measurement it must not be confused with.
    for (const [id, rule] of rules) {
      if (metricIds.includes(id)) continue;
      expect(rule["fired"], `${id} claims to be a metric`).not.toHaveProperty("measuresOnly");
    }
  });

  it("says fired null on a crawl nobody has judged, however many rows it holds", async () => {
    // crawlA's issues table is full — seeded, never judged. THE DISTINCTION IS
    // THE POINT: null is "never measured", {count: 0} is "measured, clean", and
    // no code path may blur them.
    const rows = await db.select().from(issues).where(eq(issues.crawlId, crawlA));
    expect(rows.length).toBeGreaterThan(0);
    const detail = await call(`/crawls/${crawlA}`);
    expect(detail.body["rulesRunAt"]).toBeNull();

    const rules = rulesOf(await call(`/rules?crawlId=${crawlA}`));
    expect(rules).toHaveLength(registry.all().length);
    for (const rule of rules) {
      expect(rule, `${String(rule["id"])} lost its fired key`).toHaveProperty("fired");
      expect(rule["fired"], `${String(rule["id"])} reported a count on an unjudged crawl`).toBeNull();
    }
  });

  it("marks a capped rule's count as a floor, agreeing with issues_list", async () => {
    const rules = byId(await call(`/rules?crawlId=${crawlB}`));
    // Both truncation shapes a rule can honestly write reduce to the same claim
    // here: the count is what the rule LISTED, not how many cases exist.
    expect(rules.get("links.orphan")?.["fired"]).toEqual({ count: 3, atLeast: true });
    expect(rules.get("content.near-duplicate")?.["fired"]).toEqual({ count: 2, atLeast: true });
    // An uncapped rule says nothing: no flag means the count IS the number.
    expect(rules.get("title.missing")?.["fired"]).not.toHaveProperty("atLeast");

    // And the flag is read off the same note issues_list reads, which is where
    // the magnitude itself lives.
    const groups = items(await call(`/crawls/${crawlB}/issues`));
    const orphan = groups.find((g) => g["ruleId"] === "links.orphan");
    expect(orphan?.["count"]).toBe(3);
    expect(orphan?.["truncated"]).toBe(true);
    expect(orphan?.["total"]).toBe(222);
  });

  it("404s a crawl id nothing knows rather than answering the skeleton", async () => {
    const res = await call("/rules?crawlId=crawl_nope");
    expect(res.status).toBe(404);
    expect(String(res.body["error"])).toContain("crawl_nope");
  });

  it("400s a query parameter this route does not take", async () => {
    const res = await call("/rules?category=links");
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("category");
  });

  it("409s a crawl holding rows for a rule this ruleset no longer defines", async () => {
    // The same refusal issues_list makes, for the same reason: the count would
    // otherwise be silently dropped from the catalog and the totals would stop
    // adding up, with nothing saying why.
    const res = await call(`/rules?crawlId=${crawlC}`);
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("retired.rule");
  });

  it("reads the marker and the counts from one statement, and groups once", async () => {
    const pool = db.$pool as unknown as { query: (...args: unknown[]) => unknown };
    const original = pool.query.bind(pool);
    const statements: string[] = [];
    pool.query = (...args: unknown[]) => {
      const first = args[0];
      statements.push(
        typeof first === "string" ? first : String((first as { text?: unknown })?.text ?? ""),
      );
      return original(...args);
    };
    let res: Res;
    try {
      res = await call(`/rules?crawlId=${crawlB}`);
    } finally {
      pool.query = original;
    }
    expect(res.status).toBe(200);

    // ONE statement touches `issues` — one grouped count for the whole catalog,
    // never a query per rule (85 round trips for one dashboard paint) — and it
    // is the one that reads the marker, so "judged" and "how many" describe the
    // same instant (the crawl-detail read makes the same argument).
    const touchingIssues = statements.filter((sql) => /\bissues\b/.test(sql));
    expect(touchingIssues).toHaveLength(1);
    expect(touchingIssues[0]).toMatch(/rules_run_at/);
    expect(touchingIssues[0]).toMatch(/group by/i);
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

/**
 * The site filter on the crawl listing — the "project history" a date picker is
 * built on, and the first half of the compare surface.
 *
 * The assertions are all about the FAMILY: the engine treats the apex and `www`
 * spellings of a host as one site everywhere else (`hostProbeStarts` probes all
 * four, `checkAddedHosts` refuses to call any of them an added host), so a
 * filter that matched the stored string would answer "no crawls" for a site
 * crawled last week under the other spelling.
 */
describe("GET /crawls?siteUrl=", () => {
  async function idsFor(siteUrl: string): Promise<string[]> {
    const res = await call(`/crawls?siteUrl=${encodeURIComponent(siteUrl)}&limit=200`);
    expect(res.status).toBe(200);
    return items(res).map((row) => String(row["crawlId"]));
  }

  it("narrows the listing to one site, and leaves the other site's crawls out", async () => {
    const ids = await idsFor(`${OTHER_SITE}/`);
    expect(ids.sort()).toEqual([cmpOther, cmpWww].sort());
    expect(ids).not.toContain(cmpBase);
  });

  it("matches the apex and www spellings, both schemes, in either direction", async () => {
    // Every one of these is the SAME SITE by the crawler's own definition, and
    // each finds both crawls — including the one seeded under the other
    // spelling, which is the whole point.
    for (const spelling of [
      `http://compare-other.example/`,
      `https://compare-other.example/`,
      `http://www.compare-other.example/`,
      `https://www.compare-other.example/deep/page?a=1#frag`,
    ]) {
      expect((await idsFor(spelling)).sort(), spelling).toEqual([cmpOther, cmpWww].sort());
    }
  });

  it("refuses a siteUrl that is not an http(s) URL rather than dropping the filter", async () => {
    // The failure this guards is silent: a dropped filter answers with EVERY
    // crawl the engine holds, which on a multi-tenant deployment is other
    // people's site list arriving as the answer to a mistyped host.
    for (const bad of ["compare-other.example", "ftp://compare-other.example/", "not a url"]) {
      const res = await call(`/crawls?siteUrl=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(String(res.body["error"]), bad).toContain("siteUrl");
    }
  });

  it("pages the filtered listing with the same cursor contract", async () => {
    const walked = await walk(`/crawls?siteUrl=${encodeURIComponent(`${OTHER_SITE}/`)}`, 1);
    expect(walked.map((row) => String(row["crawlId"])).sort()).toEqual([cmpOther, cmpWww].sort());
  });
});

/**
 * The cross-crawl diff.
 *
 * The fixtures are built so that every number below is derivable by hand from
 * the `beforeAll` block: three `title.missing` URLs on each side sharing two,
 * five orphans that went away, five descriptions that appeared, and one rule
 * that fired three times on one page. Nothing here reads a count off the
 * implementation.
 */
describe("GET /compare", () => {
  async function compare(baseCrawlId: string, headCrawlId: string): Promise<Res> {
    return await call(
      `/compare?baseCrawlId=${encodeURIComponent(baseCrawlId)}&headCrawlId=${encodeURIComponent(headCrawlId)}`,
    );
  }

  function rulesOf(res: Res): Record<string, unknown>[] {
    const value = res.body["rules"];
    if (!Array.isArray(value)) throw new Error(`no rules in ${JSON.stringify(res.body)}`);
    return value as Record<string, unknown>[];
  }

  function ruleRow(res: Res, ruleId: string): Record<string, unknown> {
    const row = rulesOf(res).find((r) => r["ruleId"] === ruleId);
    if (row === undefined) throw new Error(`no row for ${ruleId}`);
    return row;
  }

  function caveatCodes(res: Res): string[] {
    return (res.body["caveats"] as { code: string }[]).map((c) => c.code);
  }

  it("answers both sides, comparable, and the rules in issues_list's order", async () => {
    const res = await compare(cmpBase, cmpHead);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(true);
    expect(res.body["caveats"]).toEqual([]);

    expect(res.body["base"]).toEqual({
      crawlId: cmpBase,
      siteUrl: `${SITE}/`,
      rulesRunAt: "2026-08-30T09:00:00.000Z",
      rulesetVersions: [CMP_RULESET],
      findingCap: null,
      findingsCount: 10,
    });
    expect(res.body["head"]).toEqual({
      crawlId: cmpHead,
      siteUrl: `${SITE}/`,
      rulesRunAt: "2026-08-30T09:00:00.000Z",
      rulesetVersions: [CMP_RULESET],
      findingCap: null,
      findingsCount: 12,
    });

    // Every rule with findings in EITHER crawl, warnings before the info rule,
    // alphabetical inside a severity.
    expect(rulesOf(res).map((r) => r["ruleId"])).toEqual([
      "content.exact-duplicate",
      "links.orphan",
      "meta-description.missing",
      "sitemap.missing",
      "title.missing",
      "title.too-long",
    ]);
  });

  it("counts new, resolved and persisting from the URLs, not the rows", async () => {
    const res = await compare(cmpBase, cmpHead);

    // The three-way case: /a resolved, /d new, /b and /c still there.
    expect(ruleRow(res, "title.missing")).toEqual({
      ruleId: "title.missing",
      severity: "warning",
      category: "on-page",
      checkIds: ["CHECK-35"],
      title: "Missing title tag",
      baseCount: 3, headCount: 3, baseUrls: 3, headUrls: 3,
      new: 1, resolved: 1, persisting: 2,
      baseTruncated: false, headTruncated: false,
    });
    // Gone entirely.
    expect(ruleRow(res, "links.orphan")).toMatchObject({
      baseCount: 5, headCount: 0, baseUrls: 5, headUrls: 0,
      new: 0, resolved: 5, persisting: 0,
    });
    // Appeared entirely.
    expect(ruleRow(res, "meta-description.missing")).toMatchObject({
      baseCount: 0, headCount: 5, baseUrls: 0, headUrls: 5,
      new: 5, resolved: 0, persisting: 0,
    });
  });

  // THE IDENTITY DECISION, AS A NUMBER. Three findings on one page, each with
  // its own content-hash dedupe key, are ONE thing to a diff joined on the page
  // URL. A diff joined on `dedupe_key` would call this three new problems, and
  // would call the same three "resolved and re-appeared" the moment the site
  // edited a word of the duplicated text.
  it("collapses a rule that fired three times on one page to one URL", async () => {
    const row = ruleRow(await compare(cmpBase, cmpHead), "content.exact-duplicate");
    expect(row).toMatchObject({
      baseCount: 0, headCount: 3, baseUrls: 0, headUrls: 1,
      new: 1, resolved: 0, persisting: 0,
    });
  });

  // A site-wide finding has no page URL at all, so it can only compare by
  // whether the rule fired — which is what the empty key does for it.
  it("compares a site-wide finding by rule presence", async () => {
    expect(ruleRow(await compare(cmpBase, cmpHead), "sitemap.missing")).toMatchObject({
      baseCount: 1, headCount: 0, baseUrls: 1, headUrls: 0,
      new: 0, resolved: 1, persisting: 0,
    });
  });

  it("holds the two arithmetic invariants on every row", async () => {
    for (const row of rulesOf(await compare(cmpBase, cmpHead))) {
      const n = (key: string): number => Number(row[key]);
      expect(n("headUrls"), `${String(row["ruleId"])} headUrls`).toBe(n("new") + n("persisting"));
      expect(n("baseUrls"), `${String(row["ruleId"])} baseUrls`).toBe(
        n("resolved") + n("persisting"),
      );
      // And the row counts are never below the URL counts, because a URL that
      // appears at all appears on at least one row.
      expect(n("headCount")).toBeGreaterThanOrEqual(n("headUrls"));
      expect(n("baseCount")).toBeGreaterThanOrEqual(n("baseUrls"));
    }
  });

  it("reconciles findingsCount with the per-rule counts on both sides", async () => {
    const res = await compare(cmpBase, cmpHead);
    const sum = (key: string): number =>
      rulesOf(res).reduce((total, row) => total + Number(row[key]), 0);
    expect(sum("baseCount")).toBe(Number((res.body["base"] as Record<string, unknown>)["findingsCount"]));
    expect(sum("headCount")).toBe(Number((res.body["head"] as Record<string, unknown>)["findingsCount"]));
  });

  // A RULESET MISMATCH IS NOT A REFUSAL. This is the shape the real data is in
  // today, and the engine's job is to state the caveat and hand over the
  // numbers — the consumer decides whether to draw the Change column.
  it("returns the counts with comparable false when the rulesets differ", async () => {
    const res = await compare(cmpBase, cmpOld);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(false);

    const caveat = (res.body["caveats"] as { code: string; message: string }[]).find(
      (c) => c.code === "ruleset-mismatch",
    );
    expect(caveat, "no ruleset-mismatch caveat").toBeDefined();
    // BOTH versions named — a caveat that says "the rulesets differ" without
    // saying which is a caveat nobody can act on.
    expect(caveat?.message).toContain(CMP_RULESET);
    expect(caveat?.message).toContain(CMP_OLD_RULESET);
    // And the precedent, cited so a reader can go and read what it cost last time.
    expect(caveat?.message).toContain("phase-8");

    // The counts came anyway.
    expect(ruleRow(res, "title.missing")).toMatchObject({ baseCount: 3, headCount: 2 });
  });

  // The cross-severity case: the head's reading is the one reported, and the
  // move is named rather than smoothed over.
  it("reports the head severity when a rule's severity moved, and says so", async () => {
    const res = await compare(cmpBase, cmpOld);
    expect(ruleRow(res, "title.missing")).toMatchObject({ severity: "critical" });

    const caveat = (res.body["caveats"] as { code: string; message: string }[]).find(
      (c) => c.code === "severity-changed",
    );
    expect(caveat?.message).toContain("title.missing");
    expect(caveat?.message).toContain("warning");
    expect(caveat?.message).toContain("critical");

    // The severity-changed rule sorts by its HEAD severity, so it is first.
    expect(rulesOf(res)[0]?.["ruleId"]).toBe("title.missing");
  });

  // The other reason two counts of one site can differ for no reason the site
  // is responsible for — and it is INDEPENDENT of the ruleset. On the reference
  // pair both are true at once, and a reader told only about the ruleset would
  // read `links.orphan` 200 -> 243 as forty-three new orphans.
  it("names a finding-cap difference on its own, and which rule the cap cut", async () => {
    const res = await compare(cmpBase, cmpCapped);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(false);
    // ONLY the cap caveat: the rulesets agree, so nothing else may fire.
    expect(caveatCodes(res)).toEqual(["finding-cap-differs"]);
    const caveat = (res.body["caveats"] as { message: string }[])[0];
    expect(caveat?.message).toContain("uncapped");
    expect(caveat?.message).toContain("200");

    expect(res.body["base"]).toMatchObject({ findingCap: null });
    expect(res.body["head"]).toMatchObject({ findingCap: 200 });
    // And the per-rule flag that says the cap actually bit HERE.
    expect(ruleRow(res, "title.missing")).toMatchObject({
      baseTruncated: false,
      headTruncated: true,
    });
  });

  // BOTH REASONS AT ONCE, which is the shape the real reference pair is in
  // (0.5.0 capped at 200 against 0.7.0 uncapped). Neither check may hide the
  // other: a reader told only about the ruleset would attribute a count that
  // moved because the cap moved to a change in the rules.
  it("names the ruleset AND the cap when both differ", async () => {
    const res = await compare(cmpCapped, cmpOld);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(false);
    expect(caveatCodes(res)).toContain("ruleset-mismatch");
    expect(caveatCodes(res)).toContain("finding-cap-differs");
  });

  // A crawl judged across a ruleset change, or half re-judged: no single version
  // describes what looked at it, so there is nothing to compare the other side
  // against — and saying which version it "is" would be picking one arbitrarily.
  it("names a side holding findings from more than one ruleset", async () => {
    const res = await compare(cmpBase, cmpMixed);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(false);
    expect(caveatCodes(res)).toEqual(["ruleset-mixed"]);

    const caveat = (res.body["caveats"] as { message: string }[])[0];
    expect(caveat?.message).toContain(cmpMixed);
    // Both versions named: a caveat that says "more than one" without saying
    // which is a caveat nobody can act on.
    expect(caveat?.message).toContain(CMP_RULESET);
    expect(caveat?.message).toContain(CMP_OLD_RULESET);
    // The side that is fine is NOT accused.
    expect(caveat?.message).not.toContain(cmpBase);

    // The counts still came, as they do for every caveat.
    expect(res.body["head"]).toMatchObject({
      rulesetVersions: [CMP_OLD_RULESET, CMP_RULESET].sort(),
    });
  });

  // THE EMPTY STRING IS NOT A VERSION, and two of them are not agreement.
  //
  // `issues.ruleset_version` defaults to "" for rows written before the stamp
  // existed — deliberately not backfilled, because a version nobody can check is
  // a claim rather than a record. Comparing two such crawls used to reduce to
  // `"" === ""` and answer `comparable: true` with an empty caveat list: the
  // strongest answer this surface has, from the total absence of evidence. It is
  // `findingsCount: 0` on an unjudged crawl read as "the site is clean", one
  // field over.
  it("refuses to read two unstamped sides as agreement", async () => {
    const res = await compare(cmpUnstampedA, cmpUnstampedB);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(false);
    expect(caveatCodes(res)).toEqual(["ruleset-unrecorded"]);

    const caveat = (res.body["caveats"] as { message: string }[])[0];
    // BOTH sides named, and named as unstamped rather than as empty — these
    // crawls do hold findings, so "wrote no findings" would be false of them.
    expect(caveat?.message).toContain(cmpUnstampedA);
    expect(caveat?.message).toContain(cmpUnstampedB);
    expect(caveat?.message).toContain("before the ruleset stamp existed");
    expect(caveat?.message).not.toContain("wrote no findings");
    // And the spelling that makes an empty version readable in a sentence.
    expect(caveat?.message).toContain("(unstamped)");

    // The counts are still there — this is a caveat, not a refusal.
    expect(res.body["base"]).toMatchObject({ rulesetVersions: [""], findingsCount: 1 });
    expect((res.body["rules"] as unknown[]).length).toBe(1);
  });

  it("raises the same caveat when only one side is unstamped", async () => {
    const res = await compare(cmpBase, cmpUnstampedA);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(false);
    // NOT ruleset-mismatch: "0.9.0-test vs (unstamped)" would report a version
    // change between a version and a non-answer.
    expect(caveatCodes(res)).toEqual(["ruleset-unrecorded"]);
    const caveat = (res.body["caveats"] as { message: string }[])[0];
    expect(caveat?.message).toContain(cmpUnstampedA);
    expect(caveat?.message).not.toContain(cmpBase);
  });

  it("says so when a judged side wrote no findings at all", async () => {
    const res = await compare(cmpOther, cmpWww);
    expect(res.status).toBe(200);
    expect(res.body["comparable"]).toBe(false);
    expect(caveatCodes(res)).toEqual(["ruleset-unrecorded"]);
    expect(res.body["rules"]).toEqual([]);
    expect(res.body["base"]).toMatchObject({ rulesetVersions: [], findingsCount: 0 });
  });

  it("refuses two crawls of different sites, naming both hosts", async () => {
    const res = await compare(cmpBase, cmpOther);
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("query.example");
    expect(String(res.body["error"])).toContain("compare-other.example");
  });

  // The apex/www family, on the compare side of the seam: these are two crawls
  // of ONE site and the refusal must not fire.
  it("does not refuse the apex and www spellings of one site", async () => {
    expect((await compare(cmpOther, cmpWww)).status).toBe(200);
  });

  it("refuses a crawl nobody has judged, naming which one", async () => {
    const asHead = await compare(cmpBase, cmpUnjudged);
    expect(asHead.status).toBe(400);
    expect(String(asHead.body["error"])).toContain(cmpUnjudged);
    expect(String(asHead.body["error"])).not.toContain(cmpBase);
    expect(String(asHead.body["error"])).toContain("rulesRunAt");

    // Either side, and the refusal is about the crawl rather than the position.
    const asBase = await compare(cmpUnjudged, cmpBase);
    expect(asBase.status).toBe(400);
    expect(String(asBase.body["error"])).toContain(cmpUnjudged);
  });

  // THE ORDER OF THE REFUSALS IS ITSELF A GUARANTEE. A caller who names another
  // tenant's crawl learns that it is another site and nothing else — not
  // whether it has been judged, which is a fact about that tenant's work.
  it("refuses a cross-site pair for the site, never for the judged state", async () => {
    const res = await compare(cmpUnjudged, cmpOther);
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("different sites");
    // The crawl id itself carries the word, so the assertion is on the SENTENCE
    // the judged check would have produced.
    expect(String(res.body["error"])).not.toContain("has never been judged");
  });

  // A row this engine did not write. Every `site_url` it writes went through
  // `normalizeUrl`, so this state means the row came from somewhere else — and
  // the one answer that must NOT be given is "these are different sites", which
  // would refuse a legitimate comparison for a reason nobody could act on.
  it("409s a crawl whose site URL is not a URL, rather than calling it another site", async () => {
    const broken = `crawl_cmp_broken_${Date.now()}`;
    await db.execute(sql`
      insert into crawls (id, site_url, config_jsonb, ruleset_version, status, rules_run_at)
      values (${broken}, 'not a url at all', '{}'::jsonb, '0.0.0-test', 'finished', now())`);
    try {
      const res = await compare(cmpBase, broken);
      expect(res.status).toBe(409);
      expect(String(res.body["error"])).toContain("not a URL");
      expect(String(res.body["error"])).not.toContain("different sites");
    } finally {
      await db.delete(crawls).where(eq(crawls.id, broken));
    }
  });

  it("refuses a crawl compared with itself", async () => {
    const res = await compare(cmpBase, cmpBase);
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain(cmpBase);
  });

  it("404s a crawl id nothing knows, naming it", async () => {
    const res = await compare(cmpBase, "crawl_nothing_knows_this");
    expect(res.status).toBe(404);
    expect(String(res.body["error"])).toContain("crawl_nothing_knows_this");
  });

  it("400s a missing crawl id by name rather than 404ing an empty one", async () => {
    for (const query of [
      `?headCrawlId=${cmpHead}`,
      `?baseCrawlId=${cmpBase}`,
      `?baseCrawlId=&headCrawlId=${cmpHead}`,
    ]) {
      const res = await call(`/compare${query}`);
      expect(res.status, query).toBe(400);
      expect(String(res.body["error"]), query).toContain("CrawlId");
    }
  });

  it("refuses a query parameter it does not know", async () => {
    const res = await call(`/compare?baseCrawlId=${cmpBase}&headCrawlId=${cmpHead}&ruleId=x`);
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("unknown query parameter");
  });
});

describe("GET /compare/urls", () => {
  function path(ruleId: string, set: string, extra = ""): string {
    return (
      `/compare/urls?baseCrawlId=${encodeURIComponent(cmpBase)}` +
      `&headCrawlId=${encodeURIComponent(cmpHead)}` +
      `&ruleId=${encodeURIComponent(ruleId)}&set=${encodeURIComponent(set)}${extra}`
    );
  }

  it("lists the three sets, and each is the set the summary counted", async () => {
    const urls = async (ruleId: string, set: string): Promise<unknown[]> =>
      items(await call(path(ruleId, set))).map((row) => row["url"]);

    expect(await urls("title.missing", "new")).toEqual([`${SITE}/d`]);
    expect(await urls("title.missing", "resolved")).toEqual([`${SITE}/a`]);
    expect(await urls("title.missing", "persisting")).toEqual([`${SITE}/b`, `${SITE}/c`]);
    // Three rows, one page: one URL.
    expect(await urls("content.exact-duplicate", "new")).toEqual([`${SITE}/dup`]);
  });

  it("answers a site-wide finding with url null", async () => {
    expect(items(await call(path("sitemap.missing", "resolved")))).toEqual([{ url: null }]);
  });

  // THE PAGINATION CONTRACT, walked to the end: the cursor must terminate, and
  // the rows it produced must be exactly what the summary said there were.
  it("pages to a null cursor, and the walk equals the summary's count", async () => {
    const walked = await walk(path("meta-description.missing", "new"), 2);
    expect(walked.map((row) => row["url"])).toEqual([1, 2, 3, 4, 5].map((i) => `${SITE}/m${i}`));

    const summary = await call(
      `/compare?baseCrawlId=${encodeURIComponent(cmpBase)}&headCrawlId=${encodeURIComponent(cmpHead)}`,
    );
    const row = (summary.body["rules"] as Record<string, unknown>[]).find(
      (r) => r["ruleId"] === "meta-description.missing",
    );
    expect(walked).toHaveLength(Number(row?.["new"]));
  });

  it("answers an empty set with an empty page and a null cursor", async () => {
    const res = await call(path("links.orphan", "new"));
    expect(res.status).toBe(200);
    expect(items(res)).toEqual([]);
    expect(res.body["nextCursor"]).toBeNull();
  });

  it("refuses a set it does not know, naming the three it does", async () => {
    const res = await call(path("title.missing", "gone"));
    expect(res.status).toBe(400);
    for (const set of ["new", "resolved", "persisting"]) {
      expect(String(res.body["error"])).toContain(set);
    }
  });

  it("refuses a rule this ruleset does not define, and a metric rule", async () => {
    const unknown = await call(path("not.a.rule", "new"));
    expect(unknown.status).toBe(400);
    expect(String(unknown.body["error"])).toContain("not.a.rule");

    const metric = await call(path("redirect.volume", "new"));
    expect(metric.status).toBe(400);
    expect(String(metric.body["error"])).toContain("metric");
  });

  // The drill-down enforces the SAME guards as the summary. A refusal the
  // summary makes and the drill-down does not is the whole guard with a hole in
  // it — a caller could read another tenant's URLs one rule at a time.
  it("makes the same refusals as the summary", async () => {
    const cross = await call(
      `/compare/urls?baseCrawlId=${cmpBase}&headCrawlId=${cmpOther}&ruleId=title.missing&set=new`,
    );
    expect(cross.status).toBe(400);
    expect(String(cross.body["error"])).toContain("different sites");

    const unjudged = await call(
      `/compare/urls?baseCrawlId=${cmpBase}&headCrawlId=${cmpUnjudged}&ruleId=title.missing&set=new`,
    );
    expect(unjudged.status).toBe(400);
    expect(String(unjudged.body["error"])).toContain(cmpUnjudged);

    const missing = await call(
      `/compare/urls?baseCrawlId=${cmpBase}&headCrawlId=crawl_nope&ruleId=title.missing&set=new`,
    );
    expect(missing.status).toBe(404);
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
      `/crawls/${crawlA}/pages?pageType=product&statusCode=200&indexable=true&rendered=true` +
        `&fetchClass=ok&discoveredVia=seed&limit=5`,
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
      `/crawls/${crawlE}/robots`,
      `/crawls/${crawlA}/export`,
    ]) {
      expect((await call(path, { token: null })).status).toBe(401);
    }
  });
});

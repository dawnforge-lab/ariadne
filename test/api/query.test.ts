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
import {
  crawls, issues, links, metrics, pageResources, pages, resources,
} from "../../src/db/schema.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { CSV_VIEWS, CSV_VIEW_DEFS, csvRecord } from "../../src/api/csv.js";
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
 * The CSV fixture: hostile titles, hostile anchors, a redirect chain, a redirect
 * loop, a 3xx with no usable target, one broken internal link, and 1,200 filler
 * links so the links-derived views cross the export batch more than twice.
 */
let crawlF = "";

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

/** A title a spreadsheet would execute. It is a page's own text, so it can be. */
const HOSTILE_TITLE = "=SUM(1+1)";
/** A title carrying all three characters RFC 4180 makes a quoting question. */
const QUOTED_TITLE = 'He said "hi", then\nleft';
/** An anchor text carrying the classic CSV-injection payload. */
const HOSTILE_ANCHOR = `=cmd|' /C calc'!A0`;
/**
 * A `Cache-Control` a spreadsheet would execute. The header is the SERVER's
 * text, so the resources view's cells are attacker-controlled exactly as a
 * title is — a column of headers is not a column of safe values.
 */
const HOSTILE_CACHE_CONTROL = "@SUM(1+1)";
/** How many filler links the CSV fixture carries, past the four real ones. */
const FILLER_LINKS = 1200;

async function call(path: string, opts: { token?: string | null } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? `Bearer ${TOKEN}` : opts.token;
  if (token !== null) headers["authorization"] = token;
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

interface CsvRes {
  status: number;
  headers: Headers;
  text: string;
  /** The parsed records, header row included. */
  records: string[][];
  /** How many body chunks the client actually read off the socket. */
  chunks: number;
}

/**
 * Fetch a CSV export and PARSE it.
 *
 * Parsed rather than string-matched on purpose: an assertion against
 * `text.includes(...)` would pass on a file no spreadsheet can open. This
 * parser is a deliberately independent RFC 4180 reader — quotes doubled inside
 * quotes, records ended by CRLF outside them — so a writer that emitted, say,
 * an unbalanced quote would come back here as a mis-parsed row rather than as a
 * substring that happens to be present.
 *
 * The chunk count is read as it arrives, which is what makes the streaming
 * claim checkable: a response materialised into one buffer server-side arrives
 * as one chunk however long it is.
 */
async function callCsv(path: string): Promise<CsvRes> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let chunks = 0;
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  return { status: res.status, headers: res.headers, text, records: parseCsv(text), chunks };
}

function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      records.push(row);
      row = [];
      cell = "";
      i += 2;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    records.push(row);
  }
  return records;
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
  /** Defaults to `title of <slug>`; the CSV fixtures write hostile ones. */
  title?: string;
  /** A redirect target, as the server spelled it and as the frontier keys it. */
  redirectUrl?: string;
  redirectUrlNormalised?: string;
  clickDepth?: number | null;
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
    title: p.title ?? `title of ${p.slug}`,
    metaDescription: `description of ${p.slug}`,
    ...(p.contentHash === undefined ? {} : { contentHash: p.contentHash }),
    ...(p.redirectUrl === undefined ? {} : { redirectUrl: p.redirectUrl }),
    ...(p.redirectUrlNormalised === undefined
      ? {}
      : { redirectUrlNormalised: p.redirectUrlNormalised }),
    ...(p.clickDepth === undefined ? {} : { clickDepth: p.clickDepth }),
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

  // ----------------------------------------------------------- the CSV fixture
  crawlF = `crawl_query_f_${stamp}`;
  await seedCrawl(crawlF, { judged: true });

  const csvHome = await seedPage(crawlF, {
    slug: "csv-home", pageType: "home", statusCode: 200, isIndexable: true, rendered: false,
    depth: 0, wordCount: 500, clickDepth: 0,
  });
  // The two hostile titles. Both are a page's OWN text — whatever the site put
  // in its <title> — which is exactly why the guard and the quoting exist.
  await seedPage(crawlF, {
    slug: "csv-formula", pageType: "product", statusCode: 200, isIndexable: true,
    rendered: false, depth: 1, wordCount: 300, clickDepth: 1, title: HOSTILE_TITLE,
  });
  await seedPage(crawlF, {
    slug: "csv-quoted", pageType: "product", statusCode: 200, isIndexable: true,
    rendered: false, depth: 1, wordCount: 300, clickDepth: 1, title: QUOTED_TITLE,
  });
  // A 4xx target, with no click depth: nothing reaches it as a page.
  await seedPage(crawlF, {
    slug: "csv-gone", pageType: null, statusCode: 404, isIndexable: null, rendered: false,
    depth: 1, wordCount: null, fetchClass: "client_error",
  });
  // A two-hop chain: r1 -> r2 -> end.
  await seedPage(crawlF, {
    slug: "csv-r1", pageType: null, statusCode: 301, isIndexable: false, rendered: false,
    depth: 1, wordCount: null, fetchClass: "redirect",
    redirectUrl: `${SITE}/csv-r2`, redirectUrlNormalised: `${SITE}/csv-r2`,
  });
  await seedPage(crawlF, {
    slug: "csv-r2", pageType: null, statusCode: 302, isIndexable: false, rendered: false,
    depth: 2, wordCount: null, fetchClass: "redirect",
    redirectUrl: `${SITE}/csv-end`, redirectUrlNormalised: `${SITE}/csv-end`,
  });
  const csvEnd = await seedPage(crawlF, {
    slug: "csv-end", pageType: "product", statusCode: 200, isIndexable: true, rendered: false,
    depth: 3, wordCount: 400, clickDepth: 2,
  });
  // A loop with no way out, and a 3xx whose Location the engine could not use.
  await seedPage(crawlF, {
    slug: "csv-loop-a", pageType: null, statusCode: 301, isIndexable: false, rendered: false,
    depth: 1, wordCount: null, fetchClass: "redirect",
    redirectUrl: `${SITE}/csv-loop-b`, redirectUrlNormalised: `${SITE}/csv-loop-b`,
  });
  await seedPage(crawlF, {
    slug: "csv-loop-b", pageType: null, statusCode: 301, isIndexable: false, rendered: false,
    depth: 2, wordCount: null, fetchClass: "redirect",
    redirectUrl: `${SITE}/csv-loop-a`, redirectUrlNormalised: `${SITE}/csv-loop-a`,
  });
  await seedPage(crawlF, {
    slug: "csv-dead", pageType: null, statusCode: 302, isIndexable: false, rendered: false,
    depth: 1, wordCount: null, fetchClass: "redirect",
  });

  await db.insert(links).values([
    {
      crawlId: crawlF, sourcePageId: csvHome, targetUrl: `${SITE}/csv-gone`,
      targetPageId: null, anchor: "Broken, right?", rel: null, isInternal: true, position: 0,
    },
    {
      crawlId: crawlF, sourcePageId: csvHome, targetUrl: `${SITE}/csv-end`,
      targetPageId: null, anchor: HOSTILE_ANCHOR, rel: null, isInternal: true, position: 1,
    },
    {
      crawlId: crawlF, sourcePageId: csvHome, targetUrl: `${SITE}/csv-r1`,
      targetPageId: null, anchor: null, rel: null, isInternal: true, position: 2,
    },
    {
      crawlId: crawlF, sourcePageId: csvHome, targetUrl: "https://external.example/",
      targetPageId: null, anchor: "external", rel: null, isInternal: false, position: 3,
    },
    ...Array.from({ length: FILLER_LINKS }, (_, i) => ({
      crawlId: crawlF, sourcePageId: csvHome, targetUrl: `${SITE}/csv-quoted`,
      targetPageId: null, anchor: `anchor ${i}`, rel: null, isInternal: true, position: 4 + i,
    })),
  ]);

  // ------------------------------------------------- the resource fixture
  //
  // Six files, one of every shape the surfaces have to tell apart: a file the
  // pass weighed, a file the server said was gone, a file a cap never reached,
  // a file whose host was DOWN while the pass ran, a file whose host FORBADE
  // us, and a file whose own CACHE HEADER is hostile text (a server chooses
  // that string, and it lands in a spreadsheet cell like any other). Between
  // them they make `fetched + failed + skipped == seen` non-trivial, put a row
  // on each side of the robots split (P12-T1 — the two robots classes are
  // separate counts now, not one count and a sentence), and give `capped`
  // something true to say.
  await db.insert(resources).values([
    {
      crawlId: crawlF, url: `${SITE}/a.png`, kind: "image", fetchClass: "ok",
      fetchReason: null, statusCode: 200, contentType: "image/png",
      bytes: 120_000, bytesSource: "header", cacheControl: "public, max-age=600",
      expires: null, fetchedAt: new Date(), fetchMs: 12,
    },
    {
      crawlId: crawlF, url: `${SITE}/b.css`, kind: "css", fetchClass: "client_error",
      fetchReason: null, statusCode: 404, contentType: "text/html",
      bytes: null, bytesSource: null, cacheControl: null, expires: null,
      fetchedAt: new Date(), fetchMs: 9,
    },
    {
      // Seen, not asked — and the reason says which of the four silences it is.
      crawlId: crawlF, url: `${SITE}/c.js`, kind: "js", fetchClass: null,
      fetchReason: "resource-cap", statusCode: null, contentType: null,
      bytes: null, bytesSource: null, cacheControl: null, expires: null,
      fetchedAt: null, fetchMs: null,
    },
    {
      // WE COULD NOT ASK: the host was down, which RFC 9309 §2.3.1.4 makes a
      // complete disallow. The reason has always said so; since P12-T1 the
      // CLASS does too, so a count no longer has to parse the sentence.
      crawlId: crawlF, url: "https://cdn.example/d.png", kind: "image",
      fetchClass: "robots_unreachable",
      fetchReason: "robots.txt unreachable (503): complete disallow",
      statusCode: null, contentType: null, bytes: null, bytesSource: null,
      cacheControl: null, expires: null, fetchedAt: new Date(), fetchMs: null,
    },
    {
      // THEY SAID NO: the file's own host read us its rules and this URL is
      // forbidden by them. Same behaviour as the row above, different fact.
      crawlId: crawlF, url: "https://cdn.example/e.png", kind: "image",
      fetchClass: "robots_denied",
      fetchReason: "robots.txt (cdn.example) disallows this URL",
      statusCode: null, contentType: null, bytes: null, bytesSource: null,
      cacheControl: null, expires: null, fetchedAt: new Date(), fetchMs: null,
    },
    {
      crawlId: crawlF, url: `${SITE}/hostile.css`, kind: "css", fetchClass: "ok",
      fetchReason: null, statusCode: 200, contentType: "text/css",
      bytes: 4096, bytesSource: "counted", cacheControl: HOSTILE_CACHE_CONTROL,
      expires: null, fetchedAt: new Date(), fetchMs: 30,
    },
  ]);
  await db.insert(pageResources).values([
    // The image two pages carry: one row in `resources`, two edges, and a
    // `referencingPages` of 2 — the whole reason the tables are split.
    { crawlId: crawlF, pageId: csvHome, resourceUrl: `${SITE}/a.png` },
    { crawlId: crawlF, pageId: csvEnd, resourceUrl: `${SITE}/a.png` },
    { crawlId: crawlF, pageId: csvHome, resourceUrl: `${SITE}/b.css` },
    { crawlId: crawlF, pageId: csvHome, resourceUrl: `${SITE}/c.js` },
    { crawlId: crawlF, pageId: csvHome, resourceUrl: "https://cdn.example/d.png" },
    { crawlId: crawlF, pageId: csvHome, resourceUrl: "https://cdn.example/e.png" },
    { crawlId: crawlF, pageId: csvHome, resourceUrl: `${SITE}/hostile.css` },
  ]);

  await seedIssue(crawlF, {
    ruleId: "title.missing", severity: "warning", pageId: null,
    pageUrl: `${SITE}/csv-formula`, dedupeKey: `${SITE}/csv-formula`,
  });
  await seedIssue(crawlF, {
    ruleId: "redirect.chain", severity: "warning", pageId: null,
    pageUrl: `${SITE}/csv-r1`, dedupeKey: `${SITE}/csv-r1`,
    evidence: {
      chain: [`${SITE}/csv-r1`, `${SITE}/csv-r2`, `${SITE}/csv-end`],
      length: 2, finalStatus: 200, chainTruncated: false,
    },
  });
  await seedIssue(crawlF, {
    ruleId: "links.orphan", severity: "warning", pageId: null,
    pageUrl: `${SITE}/csv-quoted`, dedupeKey: `${SITE}/csv-quoted`,
    evidence: { inSitemap: false, discoveredVia: "sitemap", note: "n".repeat(400) },
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
  for (const id of [
    crawlA, crawlB, crawlC, crawlD, crawlE, crawlF,
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

  // THE RESOURCE COVERAGE BLOCK (P11-T4). It is the evidence CHECK-83 is
  // answered from, so what it has to get right is the arithmetic AND the two
  // splits a single "failed" number would hide.
  it("counts the resource census off the database, partitioned exactly", async () => {
    const res = await call(`/crawls/${crawlF}`);
    expect(res.status).toBe(200);
    expect(res.body["resources"]).toEqual({
      seen: 6,
      fetched: 2,
      failed: 3,
      skipped: 1,
      // TWO subsets of `failed`, and the reason they are two (P12-T1). An
      // unreachable robots.txt is a complete disallow, so a host that was down
      // behaves exactly like a host that forbids us — and it is not the same
      // fact about the client's site. Until this phase both landed in
      // `robotsDenied` and only each row's `fetchReason` said which; the split
      // is now taken off `RobotsInfo.outcome`, a closed vocabulary, never off
      // the sentence.
      robotsDenied: 1,
      robotsUnreachable: 1,
      // One row carries `resource-cap`, so a cap really did stop the pass short.
      capped: true,
    });
    // The partition, asserted rather than left to the literals above: a count
    // that drifted would otherwise only be wrong by a number nobody could check
    // against anything. THE ARITHMETIC DID NOT MOVE when the robots split
    // landed — both robots classes are subsets of `failed`, so the three-way
    // partition is exactly what it was, and this line is what says so.
    const r = res.body["resources"] as Record<string, number>;
    expect(r["fetched"]! + r["failed"]! + r["skipped"]!).toBe(r["seen"]);
    // And the subsets are subsets: neither robots count may exceed `failed`,
    // and together they must not exceed it either.
    expect(r["robotsDenied"]! + r["robotsUnreachable"]!).toBeLessThanOrEqual(r["failed"]!);

    const counted = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from resources where crawl_id = ${crawlF}`,
    );
    expect(r["seen"]).toBe(counted.rows[0]?.n ?? -1);
  });

  // ZERO IS A MEASUREMENT AND THE BLOCK IS NEVER ABSENT. A crawl written before
  // migration 0013 answers five zeroes and `capped: false` — which is not "this
  // site references no files", and `resources.not-recorded` is the finding that
  // says so. A missing block would leave a consumer unable to tell the two apart
  // at all.
  it("answers the block on a crawl that holds no resource rows at all", async () => {
    const res = await call(`/crawls/${crawlA}`);
    expect(res.body["resources"]).toEqual({
      seen: 0, fetched: 0, failed: 0, skipped: 0,
      robotsDenied: 0, robotsUnreachable: 0, capped: false,
    });
  });

  /**
   * THE CAP-EXCEEDED COUNTER (P12-T1, migration 0014), and the null that is not
   * a zero.
   *
   * It sits OUTSIDE the `resources` block on purpose. Everything in that block
   * is counted live off the `resources` table in one statement, and this is
   * neither: it counts PAGES, not files, and it is a value a crawl STAMPED when
   * it closed. Putting it inside would have made the block's own contract false
   * — the field name says pages and the block says files — and would have hidden
   * a stamped number among live ones.
   */
  it("reports the cap-exceeded page count a crawl stamped, and null when none did", async () => {
    // A crawl no loop ever closed under 0014 has no answer. Null is that, and
    // it is emphatically not 0: 0 means the analyzer read every page and none
    // of them lost a reference.
    const before = await call(`/crawls/${crawlA}`);
    expect(before.status).toBe(200);
    expect(before.body["resourceRefsCappedPages"]).toBeNull();

    await db
      .update(crawls)
      .set({ resourceRefsCappedPages: 3 })
      .where(eq(crawls.id, crawlA));
    try {
      const after = await call(`/crawls/${crawlA}`);
      expect(after.body["resourceRefsCappedPages"]).toBe(3);
    } finally {
      await db
        .update(crawls)
        .set({ resourceRefsCappedPages: null })
        .where(eq(crawls.id, crawlA));
    }
  });

  // THE OFF SWITCH, ECHOED. `fetchResources` is resolved the way `findingCap`
  // is: absent means the engine's default, which is true. Without the echo,
  // `fetched: 0` on a crawl nobody asked about would be indistinguishable from a
  // pass that ran and found nothing to weigh.
  it("echoes whether the crawl asked about its files, resolving an absent key to true", async () => {
    const dflt = await call(`/crawls/${crawlA}`);
    expect(dflt.body["fetchResources"]).toBe(true);

    const id = `crawl_query_res_off_${Date.now()}`;
    try {
      await seedCrawl(id, { config: { siteUrl: `${SITE}/`, fetchResources: false } });
      const off = await call(`/crawls/${id}`);
      expect(off.body["fetchResources"]).toBe(false);
    } finally {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
  });

  // A stored value of the wrong SHAPE is a refusal, never a guess: `"false"` is
  // truthy, so guessing would report "this crawl asked the site about its files"
  // about a crawl that did not. The same ruling `configStringList` makes one
  // field along, and the same one `parseStoredConfig` makes on a resume.
  it("409s a stored fetchResources that is not a boolean rather than reading it as true", async () => {
    const id = `crawl_query_res_bad_${Date.now()}`;
    try {
      await seedCrawl(id, { config: { siteUrl: `${SITE}/`, fetchResources: "false" } });
      const res = await call(`/crawls/${id}`);
      expect(res.status).toBe(409);
      expect(String(res.body["error"])).toContain("fetchResources");
    } finally {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
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
 * The CSV half of the export surface: seven views, streamed as `text/csv`.
 *
 * These are the files the dashboard's "Bulk export" block hands a human, and
 * the properties under test are the ones a human's spreadsheet will decide:
 * the file parses, its header is always there, a page's own text can never
 * become a formula, and the row count equals the source the view claims to be.
 *
 * The rows themselves are read through an independent RFC 4180 parser
 * (`parseCsv`), so an assertion here is about a file a spreadsheet can open and
 * not about a substring that happens to be present.
 */
describe("GET /crawls/:id/export?format=csv", () => {
  const registry = buildRegistry();
  const rules = new Map(registry.all().map((rule) => [rule.id, rule]));

  /** Everything but the header row. */
  function rows(res: CsvRes): string[][] {
    return res.records.slice(1);
  }

  function column(res: CsvRes, name: string): string[] {
    const index = (res.records[0] ?? []).indexOf(name);
    if (index === -1) throw new Error(`no '${name}' column in ${JSON.stringify(res.records[0])}`);
    return rows(res).map((row) => row[index] ?? "");
  }

  function rowWhere(res: CsvRes, name: string, value: string): string[] {
    const index = (res.records[0] ?? []).indexOf(name);
    const found = rows(res).find((row) => row[index] === value);
    if (found === undefined) throw new Error(`no row with ${name}=${value}`);
    return found;
  }

  it("answers text/csv, unbuffered, with a filename a browser can save", async () => {
    const res = await callCsv(`/crawls/${crawlF}/export?format=csv&view=anchor_texts`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain(`${crawlF}-anchor_texts.csv`);
    // NO CONTENT-LENGTH. A length would mean the server knew the size before it
    // wrote a byte, which it can only know by holding the whole file — the one
    // thing hard rule 3 forbids for a links-derived view.
    expect(res.headers.get("content-length")).toBeNull();
  });

  // THE STREAMING CLAIM, MEASURED AT THE CLIENT. A response built in memory and
  // then written arrives as one chunk however large it is; this file is 1,204
  // rows and comes back in several, which means rows were on the wire while the
  // database was still being read.
  it("starts the response before the last row is read", async () => {
    const res = await callCsv(`/crawls/${crawlF}/export?format=csv&view=anchor_texts`);
    expect(res.chunks).toBeGreaterThan(1);
    expect(res.records[0]).toEqual(["source", "target", "text"]);
  });

  it("writes each view's header, always, and the row a caller came for", async () => {
    const issuesCsv = await callCsv(`/crawls/${crawlF}/export?format=csv&view=issues`);
    expect(issuesCsv.records[0]).toEqual([
      "ruleId", "severity", "category", "checkIds", "url", "title", "evidence",
    ]);
    const chain = rowWhere(issuesCsv, "ruleId", "redirect.chain");
    const chainRule = rules.get("redirect.chain");
    expect(chain[1]).toBe("warning");
    expect(chain[2]).toBe(chainRule?.category);
    expect(chain[3]).toBe(chainRule?.checkIds.join("|"));
    expect(chain[4]).toBe(`${SITE}/csv-r1`);
    expect(chain[5]).toBe(chainRule?.title);
    // The evidence is FLATTENED, deterministically and in sorted key order —
    // never the raw JSON blob, which is what a cell cannot hold usefully.
    expect(chain[6]).toBe(
      `chain=${SITE}/csv-r1|${SITE}/csv-r2|${SITE}/csv-end; ` +
        "chainTruncated=false; finalStatus=200; length=2",
    );
    expect(chain[6]).not.toContain("{");

    const internal = await callCsv(`/crawls/${crawlF}/export?format=csv&view=internal_urls`);
    expect(internal.records[0]).toEqual([
      "url", "status", "fetchClass", "indexable", "clickDepth", "pageType", "title",
    ]);
    expect(rowWhere(internal, "url", `${SITE}/csv-end`)).toEqual([
      `${SITE}/csv-end`, "200", "ok", "true", "2", "product", "title of csv-end",
    ]);
    // An empty cell is "the engine has no value", never a zero: this page has
    // no click depth because nothing links to it.
    expect(rowWhere(internal, "url", `${SITE}/csv-gone`)).toEqual([
      `${SITE}/csv-gone`, "404", "client_error", "", "", "", "title of csv-gone",
    ]);

    const broken = await callCsv(`/crawls/${crawlF}/export?format=csv&view=links_to_4xx`);
    expect(broken.records[0]).toEqual(["source", "target", "status", "anchorText"]);
    expect(rows(broken)).toEqual([
      [`${SITE}/csv-home`, `${SITE}/csv-gone`, "404", "Broken, right?"],
    ]);

    const anchors = await callCsv(`/crawls/${crawlF}/export?format=csv&view=anchor_texts`);
    expect(rowWhere(anchors, "target", `${SITE}/csv-r1`)).toEqual([
      `${SITE}/csv-home`, `${SITE}/csv-r1`, "",
    ]);

    const issueUrls = await callCsv(
      `/crawls/${crawlF}/export?format=csv&view=issue_urls&ruleId=links.orphan`,
    );
    expect(issueUrls.records[0]).toEqual(["ruleId", "url", "evidence"]);
    expect(rows(issueUrls)).toHaveLength(1);
    expect(issueUrls.records[1]?.[1]).toBe(`${SITE}/csv-quoted`);
    // The long value is clipped and SAYS it was; the full evidence stays on
    // issue_urls' JSON answer.
    expect(issueUrls.records[1]?.[2]).toContain("discoveredVia=sitemap");
    expect(issueUrls.records[1]?.[2]).toContain("…");
  });

  it("walks a redirect path per redirecting page, and says what it could not resolve", async () => {
    const res = await callCsv(`/crawls/${crawlF}/export?format=csv&view=redirects`);
    expect(res.records[0]).toEqual(["source", "chain", "target", "hops"]);
    expect(rows(res)).toHaveLength(5);

    expect(rowWhere(res, "source", `${SITE}/csv-r1`)).toEqual([
      `${SITE}/csv-r1`,
      `${SITE}/csv-r1|${SITE}/csv-r2|${SITE}/csv-end`,
      `${SITE}/csv-end`,
      "2",
    ]);
    // Per REDIRECTING PAGE, not per chain head: the middle hop has its own row,
    // because that is the URL somebody puts in a rewrite rule.
    expect(rowWhere(res, "source", `${SITE}/csv-r2`)).toEqual([
      `${SITE}/csv-r2`, `${SITE}/csv-r2|${SITE}/csv-end`, `${SITE}/csv-end`, "1",
    ]);
    // A loop is visible as a chain that comes back to a URL it already visited.
    expect(rowWhere(res, "source", `${SITE}/csv-loop-a`)).toEqual([
      `${SITE}/csv-loop-a`,
      `${SITE}/csv-loop-a|${SITE}/csv-loop-b|${SITE}/csv-loop-a`,
      `${SITE}/csv-loop-a`,
      "2",
    ]);
    // A 3xx with no usable Location: an empty target is "this engine does not
    // know where this goes", which is the truth and not a guess.
    expect(rowWhere(res, "source", `${SITE}/csv-dead`)).toEqual([
      `${SITE}/csv-dead`, `${SITE}/csv-dead`, "", "0",
    ]);
  });

  // ONE ROW PER FILE, and the columns that stop an empty cell being read as a
  // verdict. This is the view an audit opens to answer "what is this site made
  // of", and every one of its four unfetched spellings means something
  // different from "broken".
  it("writes one row per referenced file, with the class that makes an empty status readable", async () => {
    const res = await callCsv(`/crawls/${crawlF}/export?format=csv&view=resources`);
    expect(res.records[0]).toEqual([
      "url", "kind", "fetchClass", "status", "bytes", "bytesSource",
      "contentType", "cacheControl", "fetchReason", "referencingPages",
    ]);

    // A file the pass weighed, carried by TWO pages and appearing ONCE: the
    // whole reason `resources` and `page_resources` are separate tables.
    expect(rowWhere(res, "url", `${SITE}/a.png`)).toEqual([
      `${SITE}/a.png`, "image", "ok", "200", "120000", "header",
      "image/png", "public, max-age=600", "", "2",
    ]);
    // The server answered, and what it said was 404. Empty bytes here is "a
    // file we could not have has no weight to report".
    expect(rowWhere(res, "url", `${SITE}/b.css`)).toEqual([
      `${SITE}/b.css`, "css", "client_error", "404", "", "", "text/html", "", "", "1",
    ]);
    // SEEN, NOT ASKED. Empty class, empty status, and a reason naming the cap —
    // the row a reader would otherwise count as a file that is fine.
    expect(rowWhere(res, "url", `${SITE}/c.js`)).toEqual([
      `${SITE}/c.js`, "js", "", "", "", "", "", "", "resource-cap", "1",
    ]);
    // The two robots cases, told apart by CLASS since P12-T1 and still carrying
    // the sentence that says which host and why. The class is the cheap answer
    // a count can be built on; the reason is the one a person reads.
    expect(rowWhere(res, "url", "https://cdn.example/d.png")).toEqual([
      "https://cdn.example/d.png", "image", "robots_unreachable", "", "", "", "", "",
      "robots.txt unreachable (503): complete disallow", "1",
    ]);
    expect(rowWhere(res, "url", "https://cdn.example/e.png")).toEqual([
      "https://cdn.example/e.png", "image", "robots_denied", "", "", "", "", "",
      "robots.txt (cdn.example) disallows this URL", "1",
    ]);
    // `counted` beside `header` on the row above: a measurement and a claim,
    // told apart in the file rather than added together in a report.
    expect(rowWhere(res, "url", `${SITE}/hostile.css`)[5]).toBe("counted");
  });

  // THE GUARD IS THE POINT OF THE WHOLE FILE. A crawled title is attacker text
  // and this file opens in Excel at a client's desk.
  it("never lets a crawled string become a formula", async () => {
    const internal = await callCsv(`/crawls/${crawlF}/export?format=csv&view=internal_urls`);
    // The PARSED cell still reads as the site wrote it, plus the apostrophe
    // that stops the spreadsheet evaluating it.
    expect(rowWhere(internal, "url", `${SITE}/csv-formula`)[6]).toBe(`'${HOSTILE_TITLE}`);
    // And the raw bytes carry no unguarded formula opener at the start of a cell.
    expect(internal.text).toContain(`,'${HOSTILE_TITLE}`);
    expect(internal.text).not.toContain(`,${HOSTILE_TITLE}`);

    const anchors = await callCsv(`/crawls/${crawlF}/export?format=csv&view=anchor_texts`);
    expect(rowWhere(anchors, "target", `${SITE}/csv-end`)[2]).toBe(`'${HOSTILE_ANCHOR}`);

    // And on the newest view, whose hostile text arrives in a RESPONSE HEADER
    // rather than in a page's body — the guard is uniform because the inventory
    // of "which columns hold attacker text" is the thing that goes stale.
    const files = await callCsv(`/crawls/${crawlF}/export?format=csv&view=resources`);
    expect(rowWhere(files, "url", `${SITE}/hostile.css`)[7]).toBe(`'${HOSTILE_CACHE_CONTROL}`);
    expect(files.text).toContain(`,'${HOSTILE_CACHE_CONTROL}`);
    expect(files.text).not.toContain(`,${HOSTILE_CACHE_CONTROL}`);
  });

  it("quotes a cell holding a comma, a quote or a newline, and stays parseable", async () => {
    const internal = await callCsv(`/crawls/${crawlF}/export?format=csv&view=internal_urls`);
    // One RECORD, spanning two lines, holding the title verbatim: the parser
    // round-trips it, which is the property a spreadsheet needs.
    expect(rowWhere(internal, "url", `${SITE}/csv-quoted`)[6]).toBe(QUOTED_TITLE);
    expect(internal.text).toContain(`"He said ""hi"", then\nleft"`);
    // Every record has the same width, which a mis-quoted newline would break.
    for (const row of internal.records) expect(row).toHaveLength(7);
  });

  // ROW COUNTS EQUAL THE SOURCE. A view that silently dropped rows — a keyset
  // that skipped a batch boundary, a join that lost a row — is a file a client
  // reads as "these are all of them".
  it("exports exactly as many rows as the source holds", async () => {
    const status = await call(`/crawls/${crawlF}`);
    const findingsCount = Number(status.body["findingsCount"]);
    expect(findingsCount).toBe(3);

    const issuesCsv = await callCsv(`/crawls/${crawlF}/export?format=csv&view=issues`);
    expect(rows(issuesCsv)).toHaveLength(findingsCount);

    const linkCount = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from links where crawl_id = ${crawlF}`,
    );
    const anchors = await callCsv(`/crawls/${crawlF}/export?format=csv&view=anchor_texts`);
    expect(rows(anchors)).toHaveLength(linkCount.rows[0]?.n ?? -1);
    expect(rows(anchors)).toHaveLength(FILLER_LINKS + 4);

    const pageCount = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pages where crawl_id = ${crawlF}`,
    );
    const internal = await callCsv(`/crawls/${crawlF}/export?format=csv&view=internal_urls`);
    expect(rows(internal)).toHaveLength(pageCount.rows[0]?.n ?? -1);

    // The resources view against BOTH of its sources: one row per `resources`
    // row (never per edge — seven edges, six files), and the referencing counts
    // summing to the edge table.
    const fileCount = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from resources where crawl_id = ${crawlF}`,
    );
    const edgeCount = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from page_resources where crawl_id = ${crawlF}`,
    );
    const files = await callCsv(`/crawls/${crawlF}/export?format=csv&view=resources`);
    expect(rows(files)).toHaveLength(fileCount.rows[0]?.n ?? -1);
    expect(rows(files)).toHaveLength(6);
    expect(
      column(files, "referencingPages").reduce((sum, n) => sum + Number(n), 0),
    ).toBe(edgeCount.rows[0]?.n ?? -1);

    // No duplicates across the batch boundaries either: 1,204 links is three
    // batches, and a keyset that compared on the wrong column would repeat a
    // page of rows rather than lose one.
    // 1,200 distinct fillers plus the four real anchors, one of which is the
    // empty cell an image link leaves behind.
    expect(new Set(column(anchors, "text")).size).toBe(FILLER_LINKS + 4);
  });

  // THE KEYSET, WALKED. Reading a view one row at a time must produce exactly
  // the file a full-batch read produces: same rows, same order, nothing skipped
  // at a boundary and nothing repeated. This is the memory contract's
  // behavioural half — `test/api/csv.test.ts` pins the SQL that makes it true.
  it("reads every view through a cursor that can be walked one row at a time", async () => {
    const ctx = {
      rule: (ruleId: string) => {
        const rule = rules.get(ruleId);
        if (rule === undefined) throw new Error(`no rule ${ruleId}`);
        return rule;
      },
      evidence: (value: unknown) => value as Record<string, unknown>,
    };

    for (const view of CSV_VIEWS) {
      const def = CSV_VIEW_DEFS[view];
      const ruleId = def.needsRuleId ? "links.orphan" : null;
      let cursor = [...def.start];
      const walked: string[][] = [];
      for (let hop = 0; hop < 2000; hop += 1) {
        const batch = await db.execute<Record<string, unknown>>(
          def.query(crawlF, cursor, 1, ruleId),
        );
        const row = batch.rows[0];
        if (row === undefined) break;
        // Through the SAME writer the export uses, then back through the
        // parser: this test is about the cursor — which rows, in which order —
        // and not about the escaping, which the unit suite pins on its own.
        walked.push(parseCsv(csvRecord(def.cells(row, ctx)))[0] ?? []);
        cursor = def.next(row);
      }

      const query = ruleId === null ? "" : `&ruleId=${ruleId}`;
      const res = await callCsv(`/crawls/${crawlF}/export?format=csv&view=${view}${query}`);
      expect(walked, `${view} walks to a different file one row at a time`).toEqual(rows(res));
      expect(walked.length, `${view} walked no rows`).toBeGreaterThan(0);
    }
  }, 30_000);

  it("refuses a view, a format or a rule it cannot answer, naming what it took", async () => {
    const badView = await call(`/crawls/${crawlF}/export?format=csv&view=everything`);
    expect(badView.status).toBe(400);
    expect(String(badView.body["error"])).toContain("anchor_texts");

    const badFormat = await call(`/crawls/${crawlF}/export?format=xlsx`);
    expect(badFormat.status).toBe(400);
    expect(String(badFormat.body["error"])).toContain("csv");

    // The two vocabularies do not mix: `dataset` is the JSONL half's word and
    // `view` is the CSV half's, and a caller who used both was thinking of one
    // thing and asking for another.
    const mixed = await call(`/crawls/${crawlF}/export?format=csv&dataset=issues`);
    expect(mixed.status).toBe(400);
    expect(String(mixed.body["error"])).toContain("dataset");

    const viewOnJsonl = await call(`/crawls/${crawlF}/export?view=issues`);
    expect(viewOnJsonl.status).toBe(400);
    expect(String(viewOnJsonl.body["error"])).toContain("format=csv");

    const noRule = await call(`/crawls/${crawlF}/export?format=csv&view=issue_urls`);
    expect(noRule.status).toBe(400);
    expect(String(noRule.body["error"])).toContain("ruleId");

    const strayRule = await call(
      `/crawls/${crawlF}/export?format=csv&view=issues&ruleId=title.missing`,
    );
    expect(strayRule.status).toBe(400);
    expect(String(strayRule.body["error"])).toContain("issue_urls");

    const unknownRule = await call(
      `/crawls/${crawlF}/export?format=csv&view=issue_urls&ruleId=no.such.rule`,
    );
    expect(unknownRule.status).toBe(400);
    expect(String(unknownRule.body["error"])).toContain("no.such.rule");

    // A metric rule writes no findings at all: answering with a header and no
    // rows would read as 'this rule found nothing'.
    const metricRule = await call(
      `/crawls/${crawlF}/export?format=csv&view=issue_urls&ruleId=redirect.volume`,
    );
    expect(metricRule.status).toBe(400);
    expect(String(metricRule.body["error"])).toContain("measures");

    expect((await call("/crawls/crawl_missing/export?format=csv&view=issues")).status).toBe(404);
  });

  it("leaves the JSONL default exactly as it was", async () => {
    const implicit = await call(`/crawls/${crawlF}/export`);
    const explicit = await call(`/crawls/${crawlF}/export?format=jsonl.gz`);
    expect(implicit.status).toBe(200);
    expect(implicit.body).toEqual({
      dataset: "issues",
      path: join(exportDir, `${crawlF}-issues.jsonl.gz`),
      rows: 3,
      bytes: implicit.body["bytes"],
    });
    expect(explicit.body).toEqual(implicit.body);
    // No `format` key on the JSONL answer: the shape a caller already parses is
    // untouched by this task.
    expect(Object.keys(implicit.body).sort()).toEqual(["bytes", "dataset", "path", "rows"]);
  });

  // THE REFUSAL THAT IS NOT ABOUT THE REQUEST, and the one that could only
  // arrive too late. `crawlC` holds findings for a rule id this ruleset no
  // longer defines; the issues view joins every row's copy out of the registry,
  // and `ruleFor` refuses a row it cannot join rather than writing blank titles
  // into a client's spreadsheet. Left to fire inside the generator that refusal
  // lands AFTER the header — a 200 and a torn socket, where every JSON surface
  // answers this same crawl a clean 409.
  it("refuses a crawl holding a retired rule's findings BEFORE the header, not mid-stream", async () => {
    const res = await callCsv(`/crawls/${crawlC}/export?format=csv&view=issues`);
    expect(res.status).toBe(409);
    // A JSON refusal, which means no CSV headers were ever sent.
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.text).toContain("retired.rule");
    expect(res.text).toContain("re-run the rules");
    // The same crawl, the same sentence, on the surface that already had it.
    const issues = await call(`/crawls/${crawlC}/issues`);
    expect(issues.status).toBe(409);

    // And the views that never touch the registry still answer for that crawl:
    // the refusal is about the findings, not about the crawl.
    const pagesCsv = await callCsv(`/crawls/${crawlC}/export?format=csv&view=internal_urls`);
    expect(pagesCsv.status).toBe(200);
    expect(pagesCsv.records[0]?.[0]).toBe("url");
  });

  // The route only ever reaches the streaming half with format=csv, so this is
  // asked of the service directly: a caller that streams a format which writes
  // a file is told, rather than being handed the CSV it did not ask for.
  it("refuses to stream a format that writes a file", async () => {
    await expect(
      api.service.prepareCsvExport(crawlF, { format: "jsonl.gz" }),
    ).rejects.toThrow(/writes a file/);
  });

  it("writes a header even for a view with no rows, so an empty file still says what it is", async () => {
    const res = await callCsv(`/crawls/${crawlA}/export?format=csv&view=links_to_4xx`);
    expect(res.status).toBe(200);
    expect(res.records).toEqual([["source", "target", "status", "anchorText"]]);
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
    // And the claim the precedent taught us, IN THE MESSAGE'S OWN WORDS. It
    // used to cite `docs/gates/phase-8.md §7.2` by name; a caveat is a payload
    // string a tenant-facing dashboard renders, so the citation moved into the
    // code and the meaning stayed here (the Phase 10 tenant-safety sweep).
    expect(caveat?.message).toContain("not row-comparable");
    expect(caveat?.message).toMatch(/read each side as its own report/);

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

/**
 * THE TENANT-SAFETY SWEEP, AS A TEST (Talos obligation 6, Phase 10 Task 5).
 *
 * The sweep itself is a grep over the surfaces this phase added, and a grep is
 * a thing somebody did once. What is asserted here is the property the grep was
 * looking for, over the LIVE answers: nothing an Ariadne response carries names
 * anything inside the process — no filesystem path, no repository document, no
 * connection string, no stack frame.
 *
 * It covers answers AND refusals, because a refusal is the response most likely
 * to be built from a caught error, and it covers the CSV bytes because a
 * spreadsheet is a response too. It found one real thing when it was written:
 * the `ruleset-mismatch` caveat cited `docs/gates/phase-8.md §7.2` at the
 * tenant — see `rulesetCaveat`.
 *
 * **THE PATH LIST BELOW IS HAND-ENUMERATED, AND THAT IS ITS ONE WEAKNESS.**
 * Nothing derives it from the route table, so a route added later is not swept
 * until somebody adds it here — the count assertion only stops the list
 * SHRINKING silently. A new surface owes this test a line.
 */
describe("nothing inside the process reaches a caller", () => {
  /** Markers that would mean an internal detail escaped into a payload. */
  function internals(text: string): string[] {
    const found: string[] = [];
    const patterns: [string, RegExp][] = [
      ["a stack frame", /\n\s+at /],
      ["an absolute path", /(^|[^\w])\/(home|usr|srv|var|tmp|root)\//],
      ["this export directory", new RegExp(exportDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
      ["a node_modules path", /node_modules/],
      ["a source file", /\bsrc\/[\w./-]+\.(ts|js)\b/],
      ["a repository document", /\b(docs|skills)\/[\w./-]+\.md\b/],
      ["a database URL", /postgres(ql)?:\/\//],
      ["a private host", /\b(localhost|127\.0\.0\.1|::1)\b/],
    ];
    for (const [what, pattern] of patterns) if (pattern.test(text)) found.push(what);
    return found;
  }

  it("carries no path, no document and no stack in any answer this phase added", async () => {
    const answers: [string, string][] = [];
    const record = async (path: string): Promise<void> => {
      const res = await call(path);
      answers.push([path, JSON.stringify(res.body)]);
    };

    // The four new surfaces, in both their answering and their refusing states.
    await record("/rules");
    await record(`/rules?crawlId=${crawlB}`);
    await record(`/rules?crawlId=${crawlA}`);
    await record("/rules?crawlId=crawl_nope");
    await record(`/rules?crawlId=${crawlC}`); // 409: a retired rule id
    await record(`/crawls?siteUrl=${encodeURIComponent(OTHER_SITE)}`);
    await record("/crawls?siteUrl=not-a-url");
    await record(`/compare?baseCrawlId=${cmpBase}&headCrawlId=${cmpOld}`);
    await record(`/compare?baseCrawlId=${cmpBase}&headCrawlId=${cmpOther}`);
    await record(`/compare?baseCrawlId=${cmpBase}&headCrawlId=${cmpUnjudged}`);
    await record(`/compare?baseCrawlId=${cmpBase}&headCrawlId=${cmpBase}`);
    await record(
      `/compare/urls?baseCrawlId=${cmpBase}&headCrawlId=${cmpHead}&ruleId=title.missing&set=new`,
    );
    await record(
      `/compare/urls?baseCrawlId=${cmpBase}&headCrawlId=${cmpHead}&ruleId=title.missing&set=moved`,
    );
    await record(`/crawls/${crawlF}/export?format=csv&view=everything`);
    // Phase 11's answers, honouring this list's grow-with-the-surface rule. The
    // crawl detail is here because it gained a block built from `fetch_reason`
    // strings — a URL policy's refusal, a robots note, the fetch layer's own
    // description of a timeout — and those are the sentences most likely to
    // carry a hostname or a path out of the process (`ruleset-mismatch`'s
    // citation of a gate document is the precedent this sweep caught).
    await record(`/crawls/${crawlF}`);
    await record(`/crawls/${crawlF}/export?format=csv&view=resources&ruleId=links.orphan`);

    // Not vacuous: the sweep only means something if the answers are real.
    expect(answers).toHaveLength(16);
    for (const [path, text] of answers) {
      expect(text.length, `${path} answered nothing`).toBeGreaterThan(2);
      expect(internals(text), `${path} leaked`).toEqual([]);
    }
  });

  it("holds for the CSV bytes, which are a response like any other", async () => {
    for (const view of [
      "issues", "internal_urls", "anchor_texts", "redirects", "resources",
    ] as const) {
      const res = await callCsv(`/crawls/${crawlF}/export?format=csv&view=${view}`);
      expect(res.status).toBe(200);
      expect(res.records.length, `${view} exported nothing`).toBeGreaterThan(1);
      expect(internals(res.text), `${view} leaked`).toEqual([]);
    }
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

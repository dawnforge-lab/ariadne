/**
 * The MCP surface, exercised through a real client over the SDK's in-memory
 * transport.
 *
 * Nothing here calls a tool handler directly. Every assertion goes through
 * `Client.callTool`, over a linked transport pair, because the things this task
 * is responsible for — that a tool's schema is closed, that a misspelled filter
 * is refused rather than ignored, that a refusal arrives as a tool error with
 * the same `{error}` body the HTTP transport sends, that a crawl really starts
 * in the server process — are properties of the server, not of a function.
 *
 * TWO FIXTURES, on purpose. The *live* crawl is started through `crawl_start`
 * against a 127.0.0.1 fixture site and driven all the way through
 * `crawl_render` and `crawl_rules`, because "a crawl runs in this process" is
 * exactly what a transport test cannot fake. The *seeded* crawl carries known
 * `issues`, `metrics` and `pages` rows, because the query tools' assertions are
 * about ordering, filtering and cursors — which a real crawl would supply less
 * predictably and far more slowly (the same division as test/api/query.test.ts).
 *
 * `allowPrivate` is not a tool argument at any value, and these tests still
 * crawl 127.0.0.1: it is supplied where the trust actually is, in
 * `createMcpServer`'s construction config, by the process that holds the
 * database handle. That is the process-trust seam the MCP transport rests on —
 * see the header of src/api/mcp.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  crawls, frontier, issues, metrics, pageResources, pages, resources,
} from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { loadMcpConfig } from "../../src/api/config.js";
import { CSV_VIEWS, EXPORT_FORMATS } from "../../src/api/csv.js";
import {
  COMPARE_SETS,
  EXPORT_DATASETS,
  MIN_PER_HOST_DELAY_MS,
  START_CRAWL_FIELDS,
} from "../../src/api/service.js";
import { FETCH_CLASSES } from "../../src/crawl/fetch-page.js";
import { DISCOVERED_VIA } from "../../src/crawl/frontier.js";
import { METRIC_SCOPES } from "../../src/rules/registry/types.js";
import { buildRegistry } from "../../src/rules/index.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";

const SEEDED_SITE = "http://mcp-query.example";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title>` +
    `<meta name="description" content="a fixture page for the MCP tests"></head>` +
    `<body><h1>${title}</h1>${body}</body></html>`
  );
}

let db: Db;
let siteServer: Server;
let site: string;
/**
 * A site with enough SLOW referenced files to be killed in the middle of its
 * resource pass — the P11 harness-kill (docs/gates/phase-11.md §5) made
 * deliberate. Three pages carrying `RESUME_ASSETS` images between them, each
 * image answered after `ASSET_DELAY_MS`, so the pass takes seconds and a test
 * that stops the server after the FIRST file lands leaves the rest genuinely
 * unasked: null `fetch_class`, no reason, which is the resume's work list.
 */
let resumeServer: Server;
let resumeSite: string;
const RESUME_ASSETS = 24;
const ASSET_DELAY_MS = 120;
let exportDir: string;
/**
 * Where every server in this file keeps the render pass's serialised
 * documents. `crawl_render` writes a real HTML file per rendered page, and the
 * default root is `renders/` under the process's cwd — the repository. Made in
 * `beforeAll`, removed in `afterAll`, exactly as `exportDir` is.
 */
let renderDir: string;

/** The server under test, and a client speaking to it in this process. */
let mcp: AriadneMcpServer;
let client: Client;
const serverLog: string[] = [];

/** A second server whose allowlist is empty — the read-only posture. */
let closedMcp: AriadneMcpServer;
let closedClient: Client;

const createdCrawls: string[] = [];
/** The crawl started through `crawl_start`, crawled, rendered and judged. */
let liveCrawlId = "";
/** The crawl whose issue/metric/page rows the query tools read. */
let seededCrawlId = "";
/**
 * The surface-exposure crawl: a stored `legacyHosts`, a discovery blob with a
 * robots.txt in it, and pages spanning the fetch-class and discovery
 * vocabularies. Its own crawl, so the listings above keep their exact rows.
 */
let surfaceCrawlId = "";
/**
 * A JUDGED crawl — `rules_run_at` stamped — with known findings. It is the
 * catalog's fired-state fixture: everything about `rules_catalog` that is not
 * about the registry is about the difference between a crawl that has been
 * judged and one that has not, and `seededCrawlId` above is the unjudged half.
 */
let catalogCrawlId = "";
/**
 * The comparison pair: two judged crawls of one site, differing in the ruleset
 * their findings are stamped with, so ONE call exercises the counts, the
 * `comparable: false` answer and the caveat that explains it — the shape the
 * three lavishalice crawls are actually in.
 */
let cmpBaseId = "";
let cmpHeadId = "";
/** A crawl of another site: the cross-site refusal, and the site filter's control. */
let cmpOtherId = "";
const CMP_SITE = "http://mcp-compare.example";

/** The robots.txt `surfaceCrawlId` read, as the discovery evidence stores it. */
const SEEDED_ROBOTS = "User-agent: *\nDisallow: /cart\nCrawl-delay: 3\n";

interface ToolAnswer {
  isError: boolean;
  /** The single text block, parsed. Tool answers are always JSON. */
  body: Record<string, unknown>;
  /** The raw text, for the assertions about what did NOT cross the wire. */
  text: string;
  /** Every content block, so "exactly one, and it is text" is assertable. */
  blocks: { type: string }[];
}

async function callWith(
  target: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const result = (await target.callTool({ name, arguments: args })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const blocks = result.content ?? [];
  const first = blocks[0];
  const text = first?.text ?? "";
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // A non-JSON answer is a finding, not a crash: the assertions that care
    // read `text` (the SDK's own schema refusals are plain text by design).
  }
  return { isError: result.isError === true, body, text, blocks };
}

function call(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  return callWith(client, name, args);
}

/** The answer, or a failure that says which tool refused and why. */
async function ok(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const answer = await call(name, args);
  if (answer.isError) throw new Error(`${name} refused: ${answer.text}`);
  return answer.body;
}

function items(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body["items"];
  if (!Array.isArray(value)) throw new Error(`no items in ${JSON.stringify(body)}`);
  return value as Record<string, unknown>[];
}

/** Poll a crawl through the surface until it stops moving. */
async function settle(crawlId: string, deadlineMs = 30_000): Promise<Record<string, unknown>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const detail = await ok("crawl_status", { crawlId });
    const status = detail["status"];
    if (status !== "queued" && status !== "running") return detail;
    if (Date.now() > until) throw new Error(`settle: crawl ${crawlId} still '${String(status)}'`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function seedCrawl(row: {
  id: string;
  status: string;
  config?: Record<string, unknown>;
  discovery?: unknown;
  /** Stamp `rules_run_at`: the only thing that says a rules pass completed. */
  judged?: boolean;
  /** Defaults to `SEEDED_SITE`; only the compare fixtures move it. */
  siteUrl?: string;
}): Promise<string> {
  await db.insert(crawls).values({
    id: row.id,
    siteUrl: row.siteUrl ?? `${SEEDED_SITE}/`,
    config: row.config ?? { siteUrl: `${SEEDED_SITE}/` },
    rulesetVersion: "0.0.0-test",
    status: row.status,
    ...(row.discovery === undefined ? {} : { discovery: row.discovery }),
    ...(row.judged === true ? { rulesRunAt: new Date("2026-08-30T09:00:00.000Z") } : {}),
  });
  createdCrawls.push(row.id);
  return row.id;
}

async function seedPage(
  crawlId: string,
  p: {
    slug: string;
    pageType: string | null;
    statusCode: number;
    indexable: boolean | null;
    fetchClass?: string;
    discoveredVia?: string;
    renderableWordCount?: number | null;
  },
): Promise<string> {
  const id = `${crawlId}_page_${p.slug}`;
  await db.insert(pages).values({
    id,
    crawlId,
    url: `${SEEDED_SITE}/${p.slug}`,
    urlNormalised: `${SEEDED_SITE}/${p.slug}`,
    pageType: p.pageType,
    statusCode: p.statusCode,
    fetchClass: p.fetchClass ?? (p.statusCode >= 500 ? "server_error" : "ok"),
    depth: 1,
    discoveredVia: p.discoveredVia ?? "link",
    isIndexable: p.indexable,
    wordCount: 200,
    ...(p.renderableWordCount === undefined
      ? {}
      : { renderableWordCount: p.renderableWordCount }),
    rendered: false,
    title: `title of ${p.slug}`,
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
    /** The stamp a comparison reads to decide whether two sides agree. */
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

/**
 * A server whose database fails in one named way, with its own client.
 *
 * The tenant-safety assertion needs an error the surface cannot produce on its
 * own. A `Proxy` over the real handle supplies exactly one: every method is
 * forwarded except the one named here, which throws. Nothing is mocked and the
 * code under test is the real path (the same rig as test/api/http.test.ts).
 */
async function riggedServer(broken: Record<string, () => never>): Promise<{
  mcp: AriadneMcpServer;
  client: Client;
  log: string[];
}> {
  const log: string[] = [];
  const rigged = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === "string" && prop in broken) return broken[prop];
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Db;

  const server = createMcpServer({
    db: rigged,
    config: { allowedDomains: ["127.0.0.1"], renderDir, log: (line) => log.push(line) },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const riggedClient = new Client({ name: "ariadne-test-rigged", version: "0.0.1" });
  await server.connect(serverSide);
  await riggedClient.connect(clientSide);
  return { mcp: server, client: riggedClient, log };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-mcp-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-mcp-renders-"));

  siteServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
      return;
    }
    if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${site}/</loc></url><url><loc>${site}/a</loc></url>` +
          `</urlset>`,
      );
      return;
    }
    const bodies: Record<string, string> = {
      "/": html("home", `<a href="/a">a</a><a href="/b">b</a>`),
      "/a": html("page a", `<a href="/b">b</a><p>some words for the analyzer to count</p>`),
      "/b": html("page b", `<p>the third page, linked from both of the others</p>`),
    };
    const body = bodies[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("not found", "<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const address = siteServer.address();
  site = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  // The resumable site. Its images are the only slow thing about it, and they
  // are slow on purpose: the pass has to still be running when the test stops
  // the server.
  resumeServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path.startsWith("/img/")) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/png", "content-length": "8" });
        res.end("PNGSTUB0");
      }, ASSET_DELAY_MS);
      return;
    }
    const imgs = (from: number, count: number): string =>
      Array.from({ length: count }, (_, i) => `<img src="/img/${from + i}.png" alt="x">`).join("");
    const per = RESUME_ASSETS / 3;
    const bodies: Record<string, string> = {
      "/": html("home", `<a href="/a">a</a><a href="/b">b</a>${imgs(0, per)}`),
      "/a": html("page a", `<a href="/b">b</a><p>words for the analyzer</p>${imgs(per, per)}`),
      "/b": html("page b", `<p>the third page</p>${imgs(per * 2, per)}`),
    };
    const body = bodies[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("not found", "<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => resumeServer.listen(0, "127.0.0.1", r));
  const resumeAddress = resumeServer.address();
  resumeSite = `http://127.0.0.1:${
    typeof resumeAddress === "object" && resumeAddress !== null ? resumeAddress.port : 0
  }`;

  mcp = createMcpServer({
    db,
    config: {
      allowedDomains: ["127.0.0.1"],
      // PROCESS TRUST, NOT WIRE TRUST. See the module header.
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      exportDir,
      renderDir,
      log: (line) => serverLog.push(line),
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  closedMcp = createMcpServer({
    db,
    config: { allowedDomains: [], exportDir, renderDir, log: (line) => serverLog.push(line) },
  });
  const [closedClientSide, closedServerSide] = InMemoryTransport.createLinkedPair();
  closedClient = new Client({ name: "ariadne-test-closed", version: "0.0.1" });
  await closedMcp.connect(closedServerSide);
  await closedClient.connect(closedClientSide);

  // The seeded crawl: known rows, so ordering, filters and cursors are exact.
  seededCrawlId = await seedCrawl({ id: `crawl_mcp_seed_${Date.now()}`, status: "finished" });
  const product = await seedPage(seededCrawlId, {
    slug: "p1", pageType: "product", statusCode: 200, indexable: true,
  });
  await seedPage(seededCrawlId, {
    slug: "b1", pageType: "blog", statusCode: 500, indexable: null,
  });
  await seedIssue(seededCrawlId, {
    ruleId: "http.server-error", severity: "critical", pageUrl: `${SEEDED_SITE}/b1`,
    dedupeKey: `${SEEDED_SITE}/b1`,
  });
  // The third orphan row carries a truncation note, as a capped rule's last
  // finding does: this crawl's `links.orphan` listed 3 of 222, and the MCP
  // transport has to carry that difference like the HTTP one does.
  for (let i = 1; i <= 3; i += 1) {
    await seedIssue(seededCrawlId, {
      ruleId: "links.orphan", severity: "warning", pageUrl: `${SEEDED_SITE}/o${i}`,
      dedupeKey: `${SEEDED_SITE}/o${i}`,
      evidence: i === 3 ? { truncated: { reported: 3, total: 222 } } : {},
    });
  }
  await seedIssue(seededCrawlId, {
    ruleId: "title.missing", severity: "warning", pageId: product,
    pageUrl: `${SEEDED_SITE}/p1`, dedupeKey: `${SEEDED_SITE}/p1`,
  });
  // The surface-exposure crawl: what robots_get reads, what the two new page
  // filters select on, and the crawl whose config names legacy domains.
  surfaceCrawlId = await seedCrawl({
    id: `crawl_mcp_surface_${Date.now()}`,
    status: "finished",
    config: {
      siteUrl: `${SEEDED_SITE}/`,
      userAgent: "AriadneBot/0.1 (mcp-test)",
      legacyHosts: ["old.mcp-query.example"],
      // A sitemap this site publishes and never declares, handed to the crawl
      // at start. It is echoed on crawl_status and recorded in the evidence.
      sitemapUrls: [`${SEEDED_SITE}/sitemap-extra.xml`],
    },
    discovery: {
      robots: {
        outcome: "read",
        crawlDelaySec: 3,
        note: null,
        raw: SEEDED_ROBOTS,
        truncated: false,
      },
      sitemapSources: [`${SEEDED_SITE}/sitemap.xml`],
      suppliedSitemaps: [`${SEEDED_SITE}/sitemap-extra.xml`],
      truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 2 },
      docsFetched: 2,
    },
  });
  await seedPage(surfaceCrawlId, {
    slug: "home", pageType: "home", statusCode: 200, indexable: true,
    discoveredVia: "seed", renderableWordCount: 140,
  });
  await seedPage(surfaceCrawlId, {
    slug: "blocked", pageType: null, statusCode: 429, indexable: null,
    fetchClass: "blocked", discoveredVia: "link",
  });
  const surfaceHome = await seedPage(surfaceCrawlId, {
    slug: "only-in-sitemap", pageType: "product", statusCode: 200, indexable: true,
    discoveredVia: "sitemap", renderableWordCount: 200,
  });
  // Three referenced files, one on each side of the coverage block's splits: a
  // file the pass weighed, a file robots.txt put out of reach, and a file a cap
  // never reached. Without them `crawl_status`'s resources block and the
  // resources CSV view would be compared across the two transports as three
  // zeroes and a header row — an equality of nothing.
  await db.insert(resources).values([
    {
      crawlId: surfaceCrawlId, url: `${SEEDED_SITE}/theme.css`, kind: "css",
      fetchClass: "ok", statusCode: 200, contentType: "text/css", bytes: 8_192,
      bytesSource: "header", cacheControl: "public, max-age=31536000",
      fetchedAt: new Date(), fetchMs: 11,
    },
    {
      // A host that was DOWN while the pass ran — a complete disallow we could
      // not ask about (P12-T1's `robots_unreachable`).
      crawlId: surfaceCrawlId, url: "https://cdn.mcp-query.example/hero.png",
      kind: "image", fetchClass: "robots_unreachable",
      fetchReason: "robots.txt unreachable (503): complete disallow",
      fetchedAt: new Date(),
    },
    {
      // A host that FORBADE it. Same behaviour, different fact, and now a
      // different class — so the agent transport has a file on each side of the
      // split too.
      crawlId: surfaceCrawlId, url: "https://cdn.mcp-query.example/banned.png",
      kind: "image", fetchClass: "robots_denied",
      fetchReason: "robots.txt (cdn.mcp-query.example) disallows this URL",
      fetchedAt: new Date(),
    },
    {
      crawlId: surfaceCrawlId, url: `${SEEDED_SITE}/app.js`, kind: "js",
      fetchClass: null, fetchReason: "resource-cap",
    },
  ]);
  await db.insert(pageResources).values([
    { crawlId: surfaceCrawlId, pageId: surfaceHome, resourceUrl: `${SEEDED_SITE}/theme.css` },
    { crawlId: surfaceCrawlId, pageId: surfaceHome, resourceUrl: "https://cdn.mcp-query.example/hero.png" },
    { crawlId: surfaceCrawlId, pageId: surfaceHome, resourceUrl: "https://cdn.mcp-query.example/banned.png" },
    { crawlId: surfaceCrawlId, pageId: surfaceHome, resourceUrl: `${SEEDED_SITE}/app.js` },
  ]);

  // The judged crawl: the same kind of rows, plus the marker. Its `title.missing`
  // is exact and its `links.orphan` was capped, so the catalog has both a
  // trustworthy count and a floor to report — and `http.server-error`, which
  // wrote nothing here, is the real clean.
  catalogCrawlId = await seedCrawl({
    id: `crawl_mcp_catalog_${Date.now()}`,
    status: "finished",
    judged: true,
  });
  await seedIssue(catalogCrawlId, {
    ruleId: "title.missing", severity: "warning", pageUrl: `${SEEDED_SITE}/t1`,
    dedupeKey: `${SEEDED_SITE}/t1`,
  });
  for (let i = 1; i <= 3; i += 1) {
    await seedIssue(catalogCrawlId, {
      ruleId: "links.orphan", severity: "warning", pageUrl: `${SEEDED_SITE}/c${i}`,
      dedupeKey: `${SEEDED_SITE}/c${i}`,
      evidence: i === 3 ? { truncated: { reported: 3, total: 222 } } : {},
    });
  }

  // The comparison pair. Base: three missing titles and two orphans, judged at
  // 0.9.0-test. Head: one title resolved, one new, one still there, the orphans
  // gone, and a rule that fired twice on ONE page — judged at 0.8.0-test, so the
  // answer must carry the counts AND the mismatch caveat.
  cmpBaseId = await seedCrawl({ id: `crawl_mcp_cmp_base_${Date.now()}`, status: "finished", judged: true });
  cmpHeadId = await seedCrawl({ id: `crawl_mcp_cmp_head_${Date.now()}`, status: "finished", judged: true });
  cmpOtherId = await seedCrawl({
    id: `crawl_mcp_cmp_other_${Date.now()}`,
    status: "finished",
    judged: true,
    siteUrl: `${CMP_SITE}/`,
  });
  for (const slug of ["a", "b", "c"]) {
    await seedIssue(cmpBaseId, {
      ruleId: "title.missing", severity: "warning", pageUrl: `${SEEDED_SITE}/${slug}`,
      dedupeKey: `${SEEDED_SITE}/${slug}`, rulesetVersion: "0.9.0-test",
    });
  }
  for (let i = 1; i <= 3; i += 1) {
    await seedIssue(cmpBaseId, {
      ruleId: "links.orphan", severity: "warning", pageUrl: `${SEEDED_SITE}/o${i}`,
      dedupeKey: `${SEEDED_SITE}/o${i}`, rulesetVersion: "0.9.0-test",
    });
  }
  for (const slug of ["b", "c", "d"]) {
    await seedIssue(cmpHeadId, {
      ruleId: "title.missing", severity: "warning", pageUrl: `${SEEDED_SITE}/${slug}`,
      dedupeKey: `${SEEDED_SITE}/${slug}`, rulesetVersion: "0.8.0-test",
    });
  }
  for (let i = 1; i <= 2; i += 1) {
    await seedIssue(cmpHeadId, {
      ruleId: "content.exact-duplicate", severity: "warning", pageUrl: `${SEEDED_SITE}/dup`,
      dedupeKey: `content-hash-${i}`, rulesetVersion: "0.8.0-test",
    });
  }

  await db.insert(metrics).values([
    { crawlId: seededCrawlId, metricId: "redirect.volume", scope: "site", scopeValue: "", value: { ratioPct: 12 } },
    { crawlId: seededCrawlId, metricId: "content.metrics-by-type", scope: "page_type", scopeValue: "product", value: { words: 800 } },
  ]);

  // The live crawl: started through the tool, run in this process.
  const accepted = await ok("crawl_start", { siteUrl: `${site}/`, maxPages: 5 });
  liveCrawlId = String(accepted["crawlId"]);
  createdCrawls.push(liveCrawlId);
  await settle(liveCrawlId);
}, 90_000);

afterAll(async () => {
  await client.close();
  await closedClient.close();
  await mcp.close();
  await closedMcp.close();
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  await new Promise<void>((r) => resumeServer.close(() => r()));
  rmSync(exportDir, { recursive: true, force: true });
  rmSync(renderDir, { recursive: true, force: true });
});

describe("the tool surface", () => {
  it("advertises exactly the sixteen tools of the agent surface, each described", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      [
        "compare_urls", "crawl_compare", "crawl_list", "crawl_mark_failed", "crawl_render",
        "crawl_resume", "crawl_rules", "crawl_start", "crawl_status", "export_crawl",
        "issue_urls", "issues_list", "metrics_get", "pages_query", "robots_get",
        "rules_catalog",
      ].sort(),
    );
    for (const tool of listed.tools) {
      expect(tool.description ?? "", `${tool.name} has no description`).not.toBe("");
      // The pagination contract is on every tool that paginates, because an
      // agent reads one tool's description, not the server's instructions.
      if (
        tool.name.endsWith("_list") ||
        tool.name === "pages_query" ||
        tool.name === "issue_urls" ||
        tool.name === "compare_urls"
      ) {
        expect(tool.description, `${tool.name} does not state the pagination contract`)
          .toContain("nextCursor");
      }
    }
  });

  it("closes every input schema and describes every field", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as {
        type: string;
        additionalProperties?: boolean;
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.type).toBe("object");
      // The `checkQuery` / `parseStartCrawlInput` discipline, in schema form: a
      // filter nobody knows is refused rather than dropped, so an agent that
      // misspells one is told instead of being handed the unfiltered answer.
      expect(schema.additionalProperties, `${tool.name} accepts unknown arguments`).toBe(false);
      for (const [field, spec] of Object.entries(schema.properties ?? {})) {
        expect(spec.description ?? "", `${tool.name}.${field} is undescribed`).not.toBe("");
      }
    }
  });

  // THE SECOND SURFACE AN AGENT READS, and until this test it was unpinned.
  //
  // The tool description gets a `declaredFields` pin; a FIELD description got
  // only "is not empty" — and that is how `compare_urls.set` shipped with
  // "resolved (head only)" in it, rendered by a join() separator that pasted one
  // set's parenthetical after every name. Non-empty it certainly was.
  //
  // A field description cannot be checked for truth in general. What CAN be
  // checked is that a field which enumerates a closed vocabulary names every
  // member of it — the drift this catches is a value added to the server's list
  // and never mentioned to the agent, which reads as "that value is not
  // accepted". The direction claims that broke here are pinned as claims, in the
  // compare block, because only a pinned sentence can catch an inverted one.
  it("names every member of the closed vocabulary each field enumerates", async () => {
    const listed = await client.listTools();
    const fieldDescription = (tool: string, field: string): string => {
      const schema = listed.tools.find((t) => t.name === tool)?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      const found = schema?.properties?.[field]?.description;
      if (found === undefined) throw new Error(`${tool}.${field} has no description`);
      return found;
    };

    const enumerated: [string, string, readonly string[]][] = [
      ["compare_urls", "set", COMPARE_SETS],
      ["export_crawl", "dataset", EXPORT_DATASETS],
      ["export_crawl", "format", EXPORT_FORMATS],
      ["export_crawl", "view", CSV_VIEWS],
      ["metrics_get", "scope", METRIC_SCOPES],
      ["pages_query", "fetchClass", FETCH_CLASSES],
      ["pages_query", "discoveredVia", DISCOVERED_VIA],
    ];
    for (const [tool, field, vocabulary] of enumerated) {
      const text = fieldDescription(tool, field);
      expect(vocabulary.length).toBeGreaterThan(0);
      for (const value of vocabulary) {
        expect(text, `${tool}.${field} does not name '${value}'`).toContain(value);
      }
    }
  });

  it("advertises exactly the crawl-start fields the service accepts", async () => {
    // The drift guard. `START_CRAWL_FIELDS` is the wire's vocabulary; a field
    // added there and forgotten here would be one the HTTP surface accepts and
    // the agent surface cannot see.
    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === "crawl_start")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(START_CRAWL_FIELDS).sort());
    expect(schema.required).toEqual(["siteUrl"]);
  });

  it("tells the reader that an empty answer may mean 'not measured yet'", async () => {
    // THE HARD-RULE-1 FAILURE AT THE TRANSPORT. A finished-but-unjudged crawl
    // answers `{items: []}` on the read tools, and an agent that skips
    // crawl_rules and quotes "no metrics measured" into a client report has
    // written a rule that always passes — from the outside. The tools that can
    // be read that way say so in their own descriptions, because an agent reads
    // the tool it is calling and not the server's instructions.
    const listed = await client.listTools();
    for (const name of ["metrics_get", "issue_urls", "pages_query"]) {
      const description = listed.tools.find((t) => t.name === name)?.description ?? "";
      expect(description, `${name} lets an empty answer read as 'nothing found'`).toContain(
        "NOT MEASURED YET",
      );
    }
    // issues_list carries the same warning in its own words: it is the triage
    // view *of a judged crawl*.
    expect(listed.tools.find((t) => t.name === "issues_list")?.description ?? "").toContain(
      "judged crawl",
    );

    // AND THE WARNING NOW NAMES THE CHECK. "Confirm the rules ran" used to have
    // no field behind it — an agent could only infer it. rulesRunAt is that
    // field, so the tools that raise the doubt say where to resolve it.
    for (const name of ["metrics_get", "issue_urls"]) {
      const description = listed.tools.find((t) => t.name === name)?.description ?? "";
      expect(description, `${name} raises the doubt without naming the check`).toContain(
        "rulesRunAt",
      );
    }
    // And the tool that answers it names the three fields it gained.
    const status = listed.tools.find((t) => t.name === "crawl_status")?.description ?? "";
    for (const field of ["rulesRunAt", "findingsCount", "pagesScanned", "legacyHosts", "sitemapUrls"]) {
      expect(status, `crawl_status does not name ${field}`).toContain(field);
    }
  });

  // THE CSV FILE IS OPENED BY A HUMAN, and the agent that produced it is the
  // one who has to warn them. Four claims about a file nobody can inspect from
  // inside a chat, pinned as claims: what the row count counts, what the
  // evidence column is, why some cells start with an apostrophe, and that the
  // file is on the server rather than in the answer.
  it("describes the shape of the CSV it writes, not just that it writes one", async () => {
    const listed = await client.listTools();
    const description = listed.tools.find((t) => t.name === "export_crawl")?.description ?? "";
    for (const claim of [
      "header",
      "key=value",
      "apostrophe",
      "text/csv",
      // The two views whose name is wider than their contents. An agent that
      // quotes links_to_4xx as "the broken links" or counts redirects rows as
      // chains has misreported the site from a file that is itself correct.
      "INTERNAL links only",
      "one row per REDIRECTING PAGE",
      // The third of them, added with the resources view: one row per FILE, off
      // the SERVED HTML, so an empty export is "the server sent no references"
      // and an empty status is not a broken file.
      "one row per FILE",
      "the SERVED HTML points at",
      "Read its fetchClass column before its status",
    ]) {
      expect(description, `export_crawl does not say '${claim}'`).toContain(claim);
    }
    // Every view is named in the tool's own text, not only in the field schema:
    // an agent choosing a view reads the description first.
    for (const view of CSV_VIEWS) {
      expect(description, `export_crawl does not name the ${view} view`).toContain(view);
    }
  });

  it("refuses an argument nobody allowed, naming it", async () => {
    const answer = await call("issues_list", { crawlId: seededCrawlId, serverity: "critical" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("serverity");
  });

  it("answers with one text block of compact JSON and no prose", async () => {
    const answer = await call("crawl_status", { crawlId: liveCrawlId });
    expect(answer.isError).toBe(false);
    expect(answer.blocks).toHaveLength(1);
    expect(answer.blocks[0]?.type).toBe("text");
    expect(answer.text.startsWith("{")).toBe(true);
    expect(answer.body["crawlId"]).toBe(liveCrawlId);
  });
});

describe("crawl_start", () => {
  it("accepted the crawl, ran it in this process, and it finished", () => {
    expect(liveCrawlId).toMatch(/^crawl_/);
  });

  it("refuses a host the allowlist does not name, and says the allowlist refused it", async () => {
    const answer = await call("crawl_start", { siteUrl: "https://not-allowed.example/" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("not-allowed.example");
    expect(String(answer.body["error"])).toContain("allowlist");
  });

  it("refuses a legacy host the allowlist does not name", async () => {
    const answer = await call("crawl_start", {
      siteUrl: `${site}/`,
      legacyHosts: ["victim.example"],
    });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("victim.example");
  });

  // The same gate on the other field that names something to fetch. The
  // discovery walk reads every supplied document before a page is crawled.
  it("refuses a supplied sitemap on a host the allowlist does not name", async () => {
    const answer = await call("crawl_start", {
      siteUrl: `${site}/`,
      sitemapUrls: ["https://victim.example/sitemap.xml"],
    });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("victim.example");
    expect(String(answer.body["error"])).toContain("sitemapUrls");
  });

  it("refuses a supplied sitemap that is not an absolute URL, naming the entry", async () => {
    const answer = await call("crawl_start", {
      siteUrl: `${site}/`,
      sitemapUrls: ["sitemap.xml"],
    });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("sitemapUrls");
    expect(String(answer.body["error"])).toContain("sitemap.xml");
  });

  // The agent-facing half of `findingCap`. The schema accepts a number OR null,
  // and null is the billed-audit setting rather than an omission — an agent that
  // sends it must get the whole picture, and an agent that sends nonsense must
  // be told at accept time rather than by a rules run hours later.
  it("refuses a findingCap that is neither a positive integer nor null", async () => {
    for (const bad of [0, -1, 1.5]) {
      const answer = await call("crawl_start", { siteUrl: `${site}/`, findingCap: bad });
      expect(answer.isError, JSON.stringify(bad)).toBe(true);
      expect(String(answer.body["error"] ?? answer.text)).toContain("findingCap");
    }
  });

  it("accepts findingCap: null over the agent surface, and crawl_status confirms it", async () => {
    const answer = await call("crawl_start", {
      siteUrl: `${site}/`,
      maxPages: 1,
      findingCap: null,
    });
    expect(answer.isError ?? false).toBe(false);
    const crawlId = String(answer.body["crawlId"]);
    createdCrawls.push(crawlId);
    expect(crawlId).toMatch(/^crawl_/);
    // The agent that set it must be able to read it back: the cap lives on the
    // crawl row and `crawl_rules` has no argument to restate it, so this is the
    // only way to know a billed audit was actually started as one.
    const detail = await ok("crawl_status", { crawlId });
    expect(detail["findingCap"]).toBeNull();
  });

  // THE OFF SWITCH, ROUND TRIP, over the agent transport (P11-T4). Same four
  // seams the HTTP suite walks — the field table, the effective config, the
  // stored `config_jsonb` a resume reads back, and the resolved echo — asserted
  // here because an agent that turned the pass off has no other way to learn
  // that it took, and because the MCP schema is a SECOND declaration of the
  // field: a boolean advertised on one transport and dropped on the other is
  // how a quietly smaller API appears.
  it("accepts fetchResources: false, stores it, and crawl_status confirms it", async () => {
    const answer = await call("crawl_start", {
      siteUrl: `${site}/`,
      maxPages: 1,
      fetchResources: false,
    });
    expect(answer.isError ?? false).toBe(false);
    const crawlId = String(answer.body["crawlId"]);
    createdCrawls.push(crawlId);

    const detail = await settle(crawlId);
    const rows = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect((rows[0]!.config as Record<string, unknown>)["fetchResources"]).toBe(false);
    expect(detail["fetchResources"]).toBe(false);
    const cov = detail["resources"] as Record<string, number>;
    expect(cov["fetched"]).toBe(0);
    expect(cov["skipped"]).toBe(cov["seen"]);
  });

  it("stores nothing when nobody names it, and reports the default true", async () => {
    const answer = await call("crawl_start", { siteUrl: `${site}/`, maxPages: 1 });
    expect(answer.isError ?? false).toBe(false);
    const crawlId = String(answer.body["crawlId"]);
    createdCrawls.push(crawlId);
    const detail = await settle(crawlId);
    const rows = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect((rows[0]!.config as Record<string, unknown>)["fetchResources"]).toBeUndefined();
    expect(detail["fetchResources"]).toBe(true);
  });

  it("refuses a fetchResources that is not a boolean", async () => {
    // Refused by the SDK's schema validator before the handler runs, which is
    // the same wall an argument typo meets — the field is declared `boolean`.
    for (const bad of ["false", 0]) {
      const answer = await call("crawl_start", { siteUrl: `${site}/`, fetchResources: bad });
      expect(answer.isError, JSON.stringify(bad)).toBe(true);
      expect(answer.text).toContain("fetchResources");
    }
  });

  // The floor `crawl_start`'s description promises, on the transport it
  // promises it to. Both transports share `parseStartCrawlInput`, so this is
  // the same guard the HTTP suite asserts — checked here because a claim in a
  // tool description is a claim to the agent reading it.
  it("refuses a perHostDelayMs under the politeness floor, naming the floor", async () => {
    const answer = await call("crawl_start", { siteUrl: `${site}/`, perHostDelayMs: 0 });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain(`${MIN_PER_HOST_DELAY_MS}ms`);
  });

  it("refuses allowPrivate as an argument at any value", async () => {
    const answer = await call("crawl_start", { siteUrl: `${site}/`, allowPrivate: true });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("allowPrivate");
  });

  it("refuses every crawl when the allowlist is empty, and still answers queries", async () => {
    const refused = await callWith(closedClient, "crawl_start", { siteUrl: `${site}/` });
    expect(refused.isError).toBe(true);
    expect(String(refused.body["error"])).toContain("allowlist is empty");

    const listing = await callWith(closedClient, "crawl_list", { limit: 1 });
    expect(listing.isError).toBe(false);
    expect(Array.isArray(listing.body["items"])).toBe(true);
  });
});

describe("crawl_status / crawl_list", () => {
  it("reports the finished crawl with its frontier and lease counts", async () => {
    const detail = await ok("crawl_status", { crawlId: liveCrawlId });
    expect(detail["status"]).toBe("finished");
    expect(Number(detail["pagesCrawled"])).toBeGreaterThanOrEqual(3);
    expect(detail["queuePosition"]).toBeNull();
    expect(detail["liveLeases"]).toBe(0);
    expect(typeof detail["frontier"]).toBe("object");
    // A fixture site nobody blocks: the field is present and zero, not absent.
    expect(detail["blockedPages"]).toBe(0);
    // Reported by the gate even though nothing escalated it: this crawl ran at
    // perHostDelayMs 0, and 0 is a real spacing rather than "unknown".
    expect(detail["hostSpacingMs"]).toBe(0);
    // Crawled but NOT YET JUDGED — crawl_rules runs further down this file. The
    // marker is null and the findings count is zero, and the pair says "nobody
    // has looked" rather than "this site is clean".
    expect(detail["rulesRunAt"]).toBeNull();
    expect(detail["findingsCount"]).toBe(0);
    // No legacy domain was named for this crawl: present and empty.
    expect(detail["legacyHosts"]).toEqual([]);
    // Nor was a sitemap handed to it. Same reading: this engine never probes
    // for an undeclared sitemap, so an empty list is "nobody supplied one".
    expect(detail["sitemapUrls"]).toEqual([]);
    // And no finding cap was named, so the crawl will be judged at the engine's
    // default and the default is what is reported. `null` here would mean
    // uncapped, which is a different crawl.
    expect(detail["findingCap"]).toBe(200);
  });

  it("echoes the legacy hosts and the supplied sitemaps a crawl was configured with", async () => {
    // Without these, two checks have no denominator: no legacy-redirect finding
    // could mean the redirects are fine or that nobody named a legacy domain,
    // and "robots.txt declares no sitemap" reads differently depending on
    // whether anybody has yet handed the crawl the document.
    const detail = await ok("crawl_status", { crawlId: surfaceCrawlId });
    expect(detail["legacyHosts"]).toEqual(["old.mcp-query.example"]);
    expect(detail["sitemapUrls"]).toEqual([`${SEEDED_SITE}/sitemap-extra.xml`]);
  });

  it("counts the crawl's blocked pages", async () => {
    const crawlId = await seedCrawl({
      id: `crawl_mcp_blocked_${Date.now()}`,
      status: "finished",
    });
    for (const [slug, fetchClass] of [
      ["blocked-1", "blocked"],
      ["blocked-2", "blocked"],
      ["fine", "ok"],
      ["gone", "client_error"],
    ] as const) {
      await db.insert(pages).values({
        id: `${crawlId}_${slug}`,
        crawlId,
        url: `${SEEDED_SITE}/${slug}`,
        urlNormalised: `${SEEDED_SITE}/${slug}`,
        statusCode: fetchClass === "blocked" ? 429 : 200,
        fetchClass,
        depth: 1,
        discoveredVia: "link",
        rendered: false,
      });
    }

    const detail = await ok("crawl_status", { crawlId });
    expect(detail["blockedPages"]).toBe(2);
    // A seeded row no crawl loop ever ran: null means "never reported", which
    // is a different fact from a spacing of 0.
    expect(detail["hostSpacingMs"]).toBeNull();
  });

  // THE RESOURCE COVERAGE BLOCK, over the agent transport. Both halves: the
  // numbers, and the crawl-level echo that says whether anybody asked at all.
  it("answers the resource census and whether the crawl asked for it", async () => {
    const detail = await ok("crawl_status", { crawlId: surfaceCrawlId });
    expect(detail["resources"]).toEqual({
      seen: 4, fetched: 1, failed: 2, skipped: 1,
      // The two robots counts, apart (P12-T1). Both are subsets of `failed`, so
      // the partition below is untouched by the split.
      robotsDenied: 1, robotsUnreachable: 1, capped: true,
    });
    // Nobody turned it off, so the resolved default is reported — which is what
    // makes `fetched: 1` readable as a measurement rather than as a decision.
    expect(detail["fetchResources"]).toBe(true);
    // Stamped, not counted — and null here because this crawl's rows were
    // seeded rather than crawled, so no loop ever closed it under 0014. Null is
    // "nobody counted"; 0 would be "we counted and it was none".
    expect(detail["resourceRefsCappedPages"]).toBeNull();

    // A crawl holding no resource rows answers the block all the same: zeroes
    // are a measurement, and an absent block would leave "this crawl was written
    // before the tables existed" indistinguishable from "this site has no files".
    const bare = await ok("crawl_status", { crawlId: seededCrawlId });
    expect(bare["resources"]).toEqual({
      seen: 0, fetched: 0, failed: 0, skipped: 0,
      robotsDenied: 0, robotsUnreachable: 0, capped: false,
    });
  });

  // THE DESCRIPTION, AT BOTH LAYERS. An agent reads the tool's description for
  // what the answer means and the field's for what it may send, and a number
  // whose meaning is only in this repository's source is a number that gets
  // quoted wrongly to a client.
  it("tells an agent what the resource numbers mean, and what they do not", async () => {
    const listedStatus = await client.listTools();
    const text = listedStatus.tools.find((t) => t.name === "crawl_status")?.description ?? "";
    expect(text, "crawl_status has no description").not.toBe("");
    for (const field of [
      "seen", "fetched", "failed", "skipped", "robotsDenied", "robotsUnreachable",
      "capped", "resourceRefsCappedPages",
    ]) {
      expect(text, `crawl_status's description does not name '${field}'`).toContain(field);
    }
    // The arithmetic a consumer may rely on.
    expect(text).toContain("fetched + failed + skipped = seen");
    // Where the numbers come from, which is the T2 warning made public: a
    // resumed pass reports fetching nothing and the DATABASE is the truth.
    expect(text).toContain("COUNTED OFF THE DATABASE");
    // The two readings a bare count would hide.
    expect(text).toContain("SEEN BUT NOT ASKED");
    expect(text).toContain("not a count of broken files");
    // The robots trap, and the split that answers it (P12-T1). An unreachable
    // robots.txt is still a complete disallow — the behaviour is identical — but
    // the two are now separate counts rather than one count and a sentence, so
    // the description has to say which is which.
    expect(text).toContain("unreachable robots.txt is a complete disallow");
    expect(text).toContain("fetchReason");
    expect(text).toContain("they said no");
    expect(text).toContain("we could not ask");
    // The cap-exceeded counter, with the null that is not a zero — the field
    // most likely to be rendered as "0 pages truncated" on a crawl nobody
    // counted.
    expect(text).toContain("null is not zero");
    expect(text).toContain("a floor");
    // And the off switch's echo, with both readings of a zero spelled out.
    expect(text).toContain("fetchResources");
    expect(text).toContain("false beside fetched 0");

    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === "crawl_start")?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    const field = schema?.properties?.["fetchResources"]?.description ?? "";
    expect(field, "crawl_start does not describe fetchResources").not.toBe("");
    // Defaults on, and the one thing turning it off does NOT do.
    expect(field).toContain("Defaults to true");
    expect(field).toContain("resources.seen");
    // And the sentence that stops a silent rule being read as a clean site.
    expect(field).toContain("nothing was weighed");
  });

  it("refuses a crawl id nothing knows", async () => {
    const answer = await call("crawl_status", { crawlId: "crawl_missing" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no such crawl");
  });

  it("lists crawls newest first and hands back a cursor that continues the listing", async () => {
    const first = await ok("crawl_list", { limit: 1 });
    expect(items(first)).toHaveLength(1);
    expect(typeof first["nextCursor"]).toBe("string");

    const second = await ok("crawl_list", { limit: 1, cursor: String(first["nextCursor"]) });
    expect(items(second)).toHaveLength(1);
    expect(items(second)[0]?.["crawlId"]).not.toBe(items(first)[0]?.["crawlId"]);
  });

  it("refuses a limit outside the contract rather than clamping it", async () => {
    const answer = await call("crawl_list", { limit: 0 });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("limit must be an integer");
  });
});

describe("crawl_render", () => {
  it("runs the pass over the finished crawl and answers with counts, not a page list", async () => {
    const summary = await ok("crawl_render", { crawlId: liveCrawlId });
    expect(summary["crawlId"]).toBe(liveCrawlId);
    const selection = summary["selection"] as Record<string, unknown>;
    expect(typeof selection["selected"]).toBe("number");
    expect(Number(summary["rendered"]) + Number(summary["failures"])).toBe(selection["selected"]);
    expect(summary["unrendered"]).toBe(0);
    // A page list is an export, not a tool answer (obligation 1).
    expect(JSON.stringify(summary)).not.toContain(`${site}/a`);
  }, 90_000);

  it("refuses a crawl id nothing knows", async () => {
    const answer = await call("crawl_render", { crawlId: "crawl_missing" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no such crawl");
  });

  /**
   * P8-T2 — the same explicit mode over the OTHER transport.
   *
   * On its own crawl for the reason the HTTP suite gives: an explicit pass
   * replaces the automatic selection and records itself on the crawl row, so
   * running one over `liveCrawlId` would rewrite what the tests after this one
   * read about that crawl's rendering.
   */
  describe("with a named list", () => {
    let namedCrawlId = "";

    beforeAll(async () => {
      const accepted = await ok("crawl_start", {
        siteUrl: `${site}/`,
        maxPages: 5,
        renderMaxPages: 2,
      });
      namedCrawlId = String(accepted["crawlId"]);
      createdCrawls.push(namedCrawlId);
      await settle(namedCrawlId);
    }, 60_000);

    it("advertises the urls parameter, so an agent can find it", async () => {
      const tools = await client.listTools();
      const render = tools.tools.find((t) => t.name === "crawl_render");
      expect(Object.keys(render?.inputSchema.properties ?? {}).sort()).toEqual([
        "crawlId",
        "urls",
      ]);
    });

    it("renders the pages the agent named and says the selection was explicit", async () => {
      const summary = await ok("crawl_render", {
        crawlId: namedCrawlId,
        urls: [`${site}/a`, `${site}/b`],
      });
      const selection = summary["selection"] as Record<string, unknown>;
      expect(selection["mode"]).toBe("explicit");
      expect(selection["selected"]).toBe(2);
      // Null rather than zero — see RenderSelection.mode. The four numbers
      // describe a decision that was not taken here.
      expect(selection["budget"]).toBeNull();
      expect(selection["suspects"]).toBeNull();
      expect(Number(summary["rendered"]) + Number(summary["failures"])).toBe(2);
      // Still counts, never a page list (obligation 1) — a named list going in
      // does not license one coming back.
      expect(JSON.stringify(summary)).not.toContain(`${site}/a`);
    }, 90_000);

    it("refuses a URL this crawl never fetched, by name, rather than fetching it", async () => {
      const answer = await call("crawl_render", {
        crawlId: namedCrawlId,
        urls: [`${site}/a`, `${site}/never-crawled`],
      });
      expect(answer.isError).toBe(true);
      expect(String(answer.body["error"])).toContain(`${site}/never-crawled`);
    });

    it("refuses a list longer than the crawl's renderMaxPages instead of trimming", async () => {
      const answer = await call("crawl_render", {
        crawlId: namedCrawlId,
        urls: [`${site}/`, `${site}/a`, `${site}/b`],
      });
      expect(answer.isError).toBe(true);
      expect(String(answer.body["error"])).toContain("renderMaxPages of 2");
    });

    it("refuses a host outside the site's family and outside the allowlist", async () => {
      const answer = await call("crawl_render", {
        crawlId: namedCrawlId,
        urls: ["http://192.168.7.7/somewhere"],
      });
      expect(answer.isError).toBe(true);
      expect(String(answer.body["error"])).toContain("crawl allowlist");
    });
  });
});

describe("crawl_rules", () => {
  it("judges the finished crawl, answers with the run summary, and marks it judged", async () => {
    const before = await ok("crawl_status", { crawlId: liveCrawlId });
    expect(before["rulesRunAt"]).toBeNull();
    // Unjudged, and it still reports the pages a run would scan: the field
    // describes the crawl.
    expect(Number(before["pagesScanned"])).toBeGreaterThanOrEqual(3);

    const summary = await ok("crawl_rules", { crawlId: liveCrawlId });
    expect(Number(summary["pagesScanned"])).toBeGreaterThanOrEqual(3);

    // THE DESCRIPTION IS PINNED TO THE ANSWER THIS CALL JUST RETURNED, because
    // an unpinned description is how a lie survives: this tool's said the
    // summary carries an `elapsedMs` — Phase 6 divergence D-4, fixed where the
    // crawl skill's fenced block is compared field for field and missed here,
    // where nothing compared anything — and it named four of the six fields
    // that are actually returned. Asserted against `Object.keys` of the real
    // summary rather than a restated list, so a seventh field cannot be added
    // to `RunSummary` and left undocumented.
    const rules = (await client.listTools()).tools.find((t) => t.name === "crawl_rules");
    const rulesDescription = rules?.description ?? "";
    expect(Object.keys(summary).sort()).toEqual([
      "byMetric", "byRule", "derived", "findings", "metrics", "pagesScanned",
    ]);
    for (const field of Object.keys(summary)) {
      expect(rulesDescription, `crawl_rules does not name ${field}`).toContain(field);
    }
    // And the field it does NOT return is named nowhere in the description —
    // not even to deny it, because a denial is a string an agent can misread.
    expect(rulesDescription).not.toContain("elapsedMs");
    expect(typeof summary["findings"]).toBe("number");
    expect(typeof summary["byRule"]).toBe("object");
    expect(typeof summary["byMetric"]).toBe("object");

    // The marker an agent checks before reading an empty answer as "clean", and
    // the count the issues listing sums to — read off ONE answer, from one
    // statement, because the pair is what gets interpreted (see `getCrawl`).
    const after = await ok("crawl_status", { crawlId: liveCrawlId });
    expect(Number.isNaN(Date.parse(String(after["rulesRunAt"])))).toBe(false);
    expect(after["findingsCount"]).toBe(summary["findings"]);

    // AND THE PAGE COUNT IS THE RUN'S OWN, THROUGH THE TRANSPORT. The audit
    // skill fills `crawl.rulesRun.pagesScanned` from crawl_status for a crawl
    // somebody else judged, so this equality is the thing that entitles it to:
    // the run counted its cursor's iterations, the status counts the rows that
    // cursor walked, and they are one number rather than two that usually agree.
    expect(after["pagesScanned"]).toBe(summary["pagesScanned"]);
    // Before and after the judgement, unchanged — `pages` rows are immutable
    // once the crawl has stopped, which is what makes the derivation sound.
    expect(before["pagesScanned"]).toBe(after["pagesScanned"]);
  }, 90_000);

  it("refuses a crawl that has not stopped moving", async () => {
    const id = await seedCrawl({ id: `crawl_mcp_running_${Date.now()}`, status: "running" });
    const answer = await call("crawl_rules", { crawlId: id });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("has stopped");
  });

  /**
   * P12-T4 — `render.coverage` on the other transport, both values of the field
   * the Phase 11 audit asked for (docs/gates/phase-11.md §6.3).
   *
   * `liveCrawlId` was rendered by the `crawl_render` describe above and judged
   * by the test above, so it is the `ran` side; the seeded crawl beside it was
   * never rendered by anything, which is the side that used to be
   * indistinguishable — its four selection numbers are recomputed and look
   * exactly like a record of a pass.
   */
  it("says over the wire whether a render pass ran, not just how many pages it left", async () => {
    const coverage = async (crawlId: string): Promise<Record<string, unknown>> => {
      const body = await ok("metrics_get", { crawlId, metricId: "render.coverage" });
      const rows = items(body);
      expect(rows, `no render.coverage row for ${crawlId}`).toHaveLength(1);
      return rows[0]!["value"] as Record<string, unknown>;
    };

    const rendered = await coverage(liveCrawlId);
    expect(rendered["renderPassEvidence"]).toBe("ran");
    expect(Number(rendered["pagesRendered"])).toBeGreaterThan(0);

    const id = await seedCrawl({
      id: `crawl_mcp_norender_${Date.now()}`,
      status: "finished",
      // The whole rules run happens here, and `robots.missing` reads the
      // crawl's robots evidence rather than assuming it absent.
      discovery: {
        robots: { outcome: "absent", crawlDelaySec: null, note: null, raw: null, truncated: false },
        sitemapSources: [],
        suppliedSitemaps: [],
        truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 0 },
        docsFetched: 0,
      },
    });
    await seedPage(id, { slug: "nr1", pageType: "product", statusCode: 200, indexable: true });
    await seedPage(id, { slug: "nr2", pageType: "product", statusCode: 200, indexable: true });
    await ok("crawl_rules", { crawlId: id });

    const unrendered = await coverage(id);
    // The pair that was missing: nothing ran, and the selection numbers are
    // still answered — as the plan they are, not as a history.
    expect(unrendered["renderPassEvidence"]).toBe("none");
    expect(unrendered["pagesRendered"]).toBe(0);
    expect(unrendered["selectionMode"]).toBe("auto");
    expect(Number(unrendered["selectionSelected"])).toBeGreaterThan(0);
  }, 60_000);
});

describe("crawl_mark_failed", () => {
  it("closes a crawl whose worker is gone, and answers with the crawl detail", async () => {
    const id = await seedCrawl({ id: `crawl_mcp_orphan_${Date.now()}`, status: "running" });
    const detail = await ok("crawl_mark_failed", { crawlId: id });
    expect(detail["crawlId"]).toBe(id);
    expect(detail["status"]).toBe("failed");
  });

  it("refuses a crawl that is already closed, naming the status it is in", async () => {
    const answer = await call("crawl_mark_failed", { crawlId: seededCrawlId });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("'finished'");
  });
});

/**
 * `crawl_resume` — the move the Phase 11 gate crawl needed and did not have.
 *
 * The crown test here does the thing the gate did by accident: it runs a real
 * crawl of a real (fixture) site, stops the server in the middle of the resource
 * pass, and finishes the crawl over the wire. The equality against a never-killed
 * control is asserted in test/api/http.test.ts, which owns the same fixture
 * shape; this file's job is that the TOOL reaches the same place.
 */
describe("crawl_resume", () => {
  /**
   * A second server on the same database, so a crawl can be started on one
   * process and killed with it — which is exactly what happened to the gate
   * crawl — and then resumed by a process that never held it.
   */
  async function killableServer(): Promise<{ mcp: AriadneMcpServer; client: Client }> {
    const server = createMcpServer({
      db,
      config: {
        allowedDomains: ["127.0.0.1"],
        crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
        exportDir,
        renderDir,
        log: (line) => serverLog.push(line),
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "ariadne-test-killable", version: "0.0.1" });
    await server.connect(serverSide);
    await c.connect(clientSide);
    return { mcp: server, client: c };
  }

  /**
   * A crawl row on an ALLOWLISTED host with a config a resume can actually
   * read.
   *
   * The file's other seeded crawls are on `mcp-query.example`, which is not on
   * this server's allowlist and carries a config with none of the five required
   * fields — so every one of them is refused by check (1) or the config read,
   * long before the guard a lease or an empty frontier is supposed to trip. A
   * refusal test that cannot reach its own refusal proves nothing.
   */
  async function seedResumable(suffix: string, status: string): Promise<string> {
    const id = `crawl_mcp_resume_${suffix}_${Date.now()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: `${resumeSite}/`,
      config: {
        siteUrl: `${resumeSite}/`,
        maxPages: 10,
        maxDepth: 3,
        userAgent: "AriadneBot/0.1 (mcp-test)",
        perHostDelayMs: 0,
        maxConcurrency: 2,
        probeHosts: false,
      },
      rulesetVersion: "0.0.0-test",
      status,
    });
    createdCrawls.push(id);
    return id;
  }

  /** Poll until the predicate holds, or say what never happened. */
  async function until(
    what: string,
    predicate: (detail: Record<string, unknown>) => boolean,
    crawlId: string,
    deadlineMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const stop = Date.now() + deadlineMs;
    for (;;) {
      const detail = await ok("crawl_status", { crawlId });
      if (predicate(detail)) return detail;
      if (Date.now() > stop) throw new Error(`never happened: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function resources(
    detail: Record<string, unknown>,
  ): { seen: number; fetched: number; skipped: number } {
    return detail["resources"] as { seen: number; fetched: number; skipped: number };
  }

  it("finishes a crawl a server was killed in the middle of, and keeps its earned spacing", async () => {
    const { mcp: killable, client: killableClient } = await killableServer();
    const accepted = await callWith(killableClient, "crawl_start", {
      siteUrl: `${resumeSite}/`,
      maxPages: 10,
    });
    expect(accepted.isError).toBe(false);
    const crawlId = String(accepted.body["crawlId"]);
    createdCrawls.push(crawlId);

    // Wait until the resource pass is demonstrably running — one file weighed,
    // twenty-three still to ask about — and then take the server away. This is
    // the harness kill of docs/gates/phase-11.md §5, on purpose this time.
    const midPass = await until(
      "the resource pass had weighed a file",
      (d) => resources(d).fetched >= 1,
      crawlId,
    );
    expect(resources(midPass).seen).toBe(RESUME_ASSETS);
    expect(resources(midPass).fetched).toBeLessThan(RESUME_ASSETS);
    await killableClient.close();
    await killable.close();

    // What the kill left: the graceful abort path, which decides NOTHING about
    // the rows it did not reach. That is the property the resume rests on.
    const killed = await ok("crawl_status", { crawlId });
    expect(killed["status"]).toBe("cancelled");
    expect(resources(killed).skipped).toBeGreaterThan(0);

    // The spacing the crawl "earned" — written straight to the column because
    // the fixture site never blocks, and the column is the only thing a resume
    // can read the ratchet out of (rule 9).
    await db.update(crawls).set({ hostSpacingMs: 50 }).where(eq(crawls.id, crawlId));

    const resumed = await ok("crawl_resume", { crawlId });
    // crawl_start's answer, because it is the same crawl continuing.
    expect(resumed).toEqual({ crawlId, status: "queued", queuePosition: 0 });

    const final = await settle(crawlId, 60_000);
    expect(final["status"]).toBe("finished");
    expect(final["frontier"]).toMatchObject({ pending: 0, leased: 0 });
    // Every file the crawl saw was asked about — the 786 rows the gate crawl
    // needed a database script for.
    expect(resources(final).seen).toBe(RESUME_ASSETS);
    expect(resources(final).fetched).toBe(RESUME_ASSETS);
    expect(resources(final).skipped).toBe(0);
    // And the politeness the crawl earned survived the kill: the resumed run
    // paced at the ratchet, and did not overwrite it with the configured floor.
    expect(final["hostSpacingMs"]).toBeGreaterThanOrEqual(50);
  }, 120_000);

  // THE SECOND SURFACE AN AGENT READS, pinned as claims rather than as
  // "is not empty". These are the sentences most likely to rot: the doctrine
  // that keeps a resumed pass's summary out of a report, the refusal list an
  // agent decides its next move from, and the three costs a resume actually has
  // (a fresh discovery, a re-granted resource budget, a crawl-wide spacing).
  it("tells an agent what a resume costs, what it unjudges, and how it is refused", async () => {
    const listed = await client.listTools();
    const text = listed.tools.find((t) => t.name === "crawl_resume")?.description ?? "";
    expect(text, "crawl_resume has no description").not.toBe("");

    // It is the same crawl, and the answer shape says so.
    expect(text).toContain("THE SAME CRAWL");
    expect(text).toContain("{crawlId, status, queuePosition}");
    // The P11-T4 render-from-DB doctrine, with the numbers that made it real.
    expect(text).toContain("POLL crawl_status FOR WHAT IT FOUND");
    expect(text).toContain("784 and 1,995");
    expect(text).toContain("The database is the truth");
    // What it costs: the re-run discovery, the per-RUN resource budget, and the
    // spacing widening. Each is a request somebody's server answers.
    expect(text).toContain("re-reads robots.txt");
    expect(text).toContain("budgets per RUN, not per crawl");
    expect(text).toContain("never faster than the one it");
    // The judged marker, which is the surface's load-bearing sentence.
    expect(text).toContain("rulesRunAt is cleared");
    // Every refusal, so an agent can tell "wait" from "ask the operator".
    for (const refusal of [
      "no such crawl",
      "already holding it",
      "unexpired lease",
      "nothing owed",
      "allowlist",
      "state changed while the call was checking it",
    ]) {
      expect(text, `crawl_resume's description does not name '${refusal}'`).toContain(refusal);
    }
    // And the work that is NOT a resume's.
    expect(text).toContain("that is crawl_render");
  });

  it("refuses a crawl id nobody has", async () => {
    const answer = await call("crawl_resume", { crawlId: "crawl_no_such_thing" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no such crawl");
  });

  it("refuses a crawl a live worker still holds a lease on", async () => {
    const id = await seedResumable("leased", "running");
    await db.insert(frontier).values({
      crawlId: id,
      url: `${resumeSite}/leased`,
      state: "leased",
      depth: 0,
      discoveredVia: "seed",
      leaseId: "another_worker",
      leasedUntil: new Date(Date.now() + 60_000),
    });
    const answer = await call("crawl_resume", { crawlId: id });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("unexpired lease(s)");
    // The refusal is about a WORKER, not about the status: the row still says
    // running, and nothing was queued.
    expect((await ok("crawl_status", { crawlId: id }))["status"]).toBe("running");
  });

  it("refuses a settled crawl with nothing owed, naming everything it counted", async () => {
    const id = await seedResumable("done", "finished");
    const answer = await call("crawl_resume", { crawlId: id });
    expect(answer.isError).toBe(true);
    const error = String(answer.body["error"]);
    expect(error).toContain("nothing left to resume");
    expect(error).toContain("pending frontier row(s)");
    expect(error).toContain("lease has expired");
    expect(error).toContain("resource row(s) still unasked");
  });

  it("refuses a crawl whose site has left the allowlist, naming the host", async () => {
    // The empty-allowlist server: the read-only posture, which must refuse a
    // resume for the same reason it refuses a start. A crawl accepted earlier is
    // not standing permission (Talos obligation 2, hard rule 5).
    const answer = await callWith(closedClient, "crawl_resume", { crawlId: liveCrawlId });
    expect(answer.isError).toBe(true);
    const error = String(answer.body["error"]);
    expect(error).toContain("127.0.0.1");
    expect(error).toContain("allowlist");
  });

  it("refuses to put a second worker on a crawl this server is already holding", async () => {
    const accepted = await ok("crawl_start", { siteUrl: `${resumeSite}/`, maxPages: 10 });
    const crawlId = String(accepted["crawlId"]);
    createdCrawls.push(crawlId);
    const answer = await call("crawl_resume", { crawlId });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("already held by this server");
    await settle(crawlId, 60_000);
  }, 120_000);
});

describe("issues_list / issue_urls", () => {
  it("groups findings by rule, orders them by severity, and joins the registry's copy", async () => {
    const body = await ok("issues_list", { crawlId: seededCrawlId });
    const groups = items(body);
    expect(groups.map((g) => g["ruleId"])).toEqual([
      "http.server-error", "links.orphan", "title.missing",
    ]);
    const orphan = groups.find((g) => g["ruleId"] === "links.orphan");
    expect(orphan?.["count"]).toBe(3);
    expect(orphan?.["category"]).toBe("links");
    expect(orphan?.["checkIds"]).toEqual(["CHECK-32"]);
    expect(String(orphan?.["title"] ?? "")).not.toBe("");
    expect(body["nextCursor"]).toBeNull();
  });

  it("carries a capped rule's real magnitude, and says nothing where nothing capped", async () => {
    const groups = items(await ok("issues_list", { crawlId: seededCrawlId }));
    const orphan = groups.find((g) => g["ruleId"] === "links.orphan");
    expect(orphan?.["count"]).toBe(3);
    expect(orphan?.["truncated"]).toBe(true);
    expect(orphan?.["total"]).toBe(222);

    const titles = groups.find((g) => g["ruleId"] === "title.missing");
    expect(titles).not.toHaveProperty("truncated");
  });

  it("tells an agent what a capped count means, in the tool's own description", async () => {
    const listed = await client.listTools();
    const description = listed.tools.find((t) => t.name === "issues_list")?.description ?? "";
    expect(description).toContain("truncated");
    expect(description).toContain("atLeast");
  });

  it("filters by checkId, the way a checklist walk asks", async () => {
    const body = await ok("issues_list", { crawlId: seededCrawlId, checkId: "CHECK-35" });
    expect(items(body).map((g) => g["ruleId"])).toEqual(["title.missing"]);
  });

  it("passes a cursor straight through: one row a page, in the same order", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let hop = 0; hop < 10; hop += 1) {
      const page: Record<string, unknown> = await ok("issues_list", {
        crawlId: seededCrawlId,
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      const rows = items(page);
      expect(rows).toHaveLength(1);
      seen.push(String(rows[0]?.["ruleId"]));
      const next = page["nextCursor"];
      if (next === null) break;
      cursor = String(next);
    }
    expect(seen).toEqual(["http.server-error", "links.orphan", "title.missing"]);
  });

  it("refuses a checkId no rule in this ruleset claims", async () => {
    const answer = await call("issues_list", { crawlId: seededCrawlId, checkId: "CHECK-999" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("CHECK-999");
  });

  it("lists one rule's findings URL by URL, with the rule's own evidence", async () => {
    const body = await ok("issue_urls", { crawlId: seededCrawlId, ruleId: "links.orphan" });
    const rows = items(body);
    expect(rows.map((r) => r["url"])).toEqual([
      `${SEEDED_SITE}/o1`, `${SEEDED_SITE}/o2`, `${SEEDED_SITE}/o3`,
    ]);
    expect(typeof rows[0]?.["evidence"]).toBe("object");
  });

  it("refuses a ruleId this ruleset does not define", async () => {
    const answer = await call("issue_urls", { crawlId: seededCrawlId, ruleId: "not.a.rule" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("not.a.rule");
  });
});

/**
 * The rule catalog over MCP: the same answer the HTTP surface gives, because it
 * is the same service call. What is tested HERE and nowhere else is the tool —
 * that it exists, that its schema is closed, and that its description tells a
 * reader the one thing the shape cannot say for itself: what a null means.
 *
 * The counts are derived from `buildRegistry()`, never written down. See the
 * same note in test/api/query.test.ts.
 */
describe("rules_catalog", () => {
  const registry = buildRegistry();

  function rulesOf(body: Record<string, unknown>): Record<string, unknown>[] {
    const value = body["rules"];
    if (!Array.isArray(value)) throw new Error(`no rules in ${JSON.stringify(body)}`);
    return value as Record<string, unknown>[];
  }

  async function description(): Promise<string> {
    const listed = await client.listTools();
    return listed.tools.find((t) => t.name === "rules_catalog")?.description ?? "";
  }

  it("answers the whole ruleset with its copy, and no fired state", async () => {
    const body = await ok("rules_catalog");
    expect(body["rulesetVersion"]).toBe(RULESET_VERSION);
    const rules = rulesOf(body);
    expect(rules).toHaveLength(registry.all().length);
    for (const kind of ["page", "query", "metric"] as const) {
      expect(rules.filter((r) => r["kind"] === kind), `${kind} rules`).toHaveLength(
        registry.byKind(kind).length,
      );
    }
    for (const rule of rules) {
      for (const field of ["title", "explanation", "howToFix"] as const) {
        expect(String(rule[field] ?? ""), `${String(rule["id"])} has no ${field}`).not.toBe("");
      }
      expect((rule["checkIds"] as string[]).length).toBeGreaterThan(0);
      expect(rule).not.toHaveProperty("fired");
    }
  });

  it("joins a judged crawl's fired state, zero included, summing to findingsCount", async () => {
    const rules = rulesOf(await ok("rules_catalog", { crawlId: catalogCrawlId }));
    const byId = new Map(rules.map((r) => [String(r["id"]), r]));
    expect(byId.get("title.missing")?.["fired"]).toEqual({ count: 1 });
    expect(byId.get("http.server-error")?.["fired"]).toEqual({ count: 0 });
    // A capped rule's count is a floor and says so.
    expect(byId.get("links.orphan")?.["fired"]).toEqual({ count: 3, atLeast: true });

    const total = rules.reduce(
      (n, rule) => n + Number((rule["fired"] as Record<string, unknown>)["count"]),
      0,
    );
    const detail = await ok("crawl_status", { crawlId: catalogCrawlId });
    expect(detail["findingsCount"]).toBe(total);
    expect(total).toBe(4);
  });

  // A METRIC RULE'S ZERO IS NOT A CLEAN CHECK. It measures rather than finds
  // and writes no issues on any crawl, so `{count: 0}` alone — the same shape a
  // rule that genuinely found nothing uses — would have a dashboard render
  // "passed" against a rule that never had a verdict to give. issue_urls
  // refuses to answer for these rules at all; the catalog cannot refuse (it
  // lists the whole ruleset), so it says which kind of zero this is.
  it("marks a metric rule's structural zero, and leaves the real cleans alone", async () => {
    const rules = rulesOf(await ok("rules_catalog", { crawlId: catalogCrawlId }));
    const metrics = rules.filter((r) => r["kind"] === "metric");
    expect(metrics.length).toBe(registry.byKind("metric").length);
    expect(metrics.length).toBeGreaterThan(0);
    for (const rule of metrics) {
      expect(rule["fired"], `${String(rule["id"])} is not marked`).toEqual({
        count: 0,
        measuresOnly: true,
      });
    }
    // Rules that DO find carry no such flag — including the ones that found
    // nothing, whose zero is the measurement the flag must not be confused with.
    for (const rule of rules.filter((r) => r["kind"] !== "metric")) {
      expect(rule["fired"], `${String(rule["id"])} claims to be a metric`).not.toHaveProperty(
        "measuresOnly",
      );
    }
  });

  it("answers fired null on a crawl nobody has judged, rows or no rows", async () => {
    const detail = await ok("crawl_status", { crawlId: seededCrawlId });
    expect(detail["rulesRunAt"]).toBeNull();
    expect(Number(detail["findingsCount"])).toBeGreaterThan(0);

    const rules = rulesOf(await ok("rules_catalog", { crawlId: seededCrawlId }));
    expect(rules).toHaveLength(registry.all().length);
    for (const rule of rules) {
      expect(rule["fired"], `${String(rule["id"])} counted an unjudged crawl`).toBeNull();
    }
  });

  it("refuses a crawl id nothing knows", async () => {
    const answer = await call("rules_catalog", { crawlId: "crawl_missing" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no such crawl");
  });

  // THE DESCRIPTION PIN. An unfenced description rots: the shape changes and
  // the sentence an agent (or a UI author) reads keeps describing the old one.
  it("names every field it actually answers with, and states null-vs-zero", async () => {
    const text = await description();
    const rules = rulesOf(await ok("rules_catalog", { crawlId: catalogCrawlId }));
    const fields = new Set<string>(["rulesetVersion", "rules"]);
    for (const rule of rules) {
      for (const key of Object.keys(rule)) fields.add(key);
      const fired = rule["fired"];
      if (fired !== null && typeof fired === "object") {
        for (const key of Object.keys(fired)) fields.add(key);
      }
    }
    // The live answer carries both truncation states and the metric
    // discriminator, so these are in here because rules actually reported them
    // — not because they were listed by hand.
    expect(fields.has("atLeast")).toBe(true);
    expect(fields.has("measuresOnly")).toBe(true);
    for (const field of fields) {
      expect(text, `rules_catalog's description does not name '${field}'`).toContain(field);
    }

    // And the distinction the shape cannot make on its own: null is "never
    // been judged", zero is "ran and found nothing", and the field that tells
    // them apart is named so a reader can go and check it.
    expect(text).toContain("never been judged");
    expect(text).toContain("found nothing");
    expect(text).toContain("rulesRunAt");

    // THE FIELD-NAME LOOP ABOVE IS NOT ENOUGH ON ITS OWN: it is satisfied by
    // ordinary English, so the paragraph that carries the metric rules'
    // explanation could be deleted and every assertion so far would still
    // pass. These pin the sentence itself — the same claim `findingRule`
    // refuses issues_list with, in the words the payload flag is named for.
    expect(text).toContain("metric");
    expect(text).toContain("measures rather than finds");
    expect(text).toContain("0 on EVERY judged");
    // And the honest size, so an agent can decide before spending the context.
    expect(text).toMatch(/\d+KB/);
  });
});

/**
 * The cross-crawl diff over MCP: the same service call the HTTP surface makes,
 * so what is tested HERE is the tool — that both halves exist, that their
 * schemas are closed, that a refusal arrives as a tool error, and that the
 * descriptions say the two things the shape cannot say for itself: what counts
 * as the same finding across two crawls, and what `comparable: false` means.
 *
 * The set arithmetic itself is pinned in test/api/query.test.ts against a larger
 * fixture; duplicating it here would be two copies of one assertion.
 */
describe("crawl_compare / compare_urls", () => {
  async function description(name: string): Promise<string> {
    const listed = await client.listTools();
    return listed.tools.find((t) => t.name === name)?.description ?? "";
  }

  function ruleRow(body: Record<string, unknown>, ruleId: string): Record<string, unknown> {
    const rows = body["rules"] as Record<string, unknown>[];
    const row = rows.find((r) => r["ruleId"] === ruleId);
    if (row === undefined) throw new Error(`no row for ${ruleId} in ${JSON.stringify(rows)}`);
    return row;
  }

  it("answers the counts and the caveat when the two rulesets differ", async () => {
    const body = await ok("crawl_compare", { baseCrawlId: cmpBaseId, headCrawlId: cmpHeadId });
    expect(body["comparable"]).toBe(false);
    expect((body["caveats"] as { code: string }[]).map((c) => c.code)).toContain("ruleset-mismatch");
    expect(body["base"]).toMatchObject({ rulesetVersions: ["0.9.0-test"], findingsCount: 6 });
    expect(body["head"]).toMatchObject({ rulesetVersions: ["0.8.0-test"], findingsCount: 5 });

    // The counts arrived anyway — the mismatch is a statement, not a refusal.
    expect(ruleRow(body, "title.missing")).toMatchObject({
      baseCount: 3, headCount: 3, new: 1, resolved: 1, persisting: 2,
    });
    // Two rows, one page, one URL: the per-URL collapse, over the transport.
    expect(ruleRow(body, "content.exact-duplicate")).toMatchObject({
      headCount: 2, headUrls: 1, new: 1,
    });
  });

  it("hands back the URLs behind a count, paginated to a null cursor", async () => {
    const args = {
      baseCrawlId: cmpBaseId, headCrawlId: cmpHeadId, ruleId: "links.orphan", set: "resolved",
    };
    // Walked one row at a time to the end, because "the cursor terminates" and
    // "the walk is the whole set" are the two halves of the pagination contract
    // and neither is visible from a single page.
    const walked: unknown[] = [];
    let cursor: string | null = null;
    for (let hop = 0; hop < 10; hop += 1) {
      const page: Record<string, unknown> = await ok("compare_urls", {
        ...args, limit: 1, ...(cursor === null ? {} : { cursor }),
      });
      walked.push(...items(page).map((row) => row["url"]));
      const next = page["nextCursor"];
      if (next === null) break;
      cursor = String(next);
    }
    expect(walked).toEqual([1, 2, 3].map((i) => `${SEEDED_SITE}/o${i}`));

    // And the walk is exactly what the summary said it would be.
    const summary = await ok("crawl_compare", { baseCrawlId: cmpBaseId, headCrawlId: cmpHeadId });
    expect(walked).toHaveLength(Number(ruleRow(summary, "links.orphan")["resolved"]));
  });

  it("refuses a cross-site pair and an unjudged crawl as tool errors", async () => {
    const cross = await call("crawl_compare", { baseCrawlId: cmpBaseId, headCrawlId: cmpOtherId });
    expect(cross.isError).toBe(true);
    expect(String(cross.body["error"])).toContain("different sites");

    // `seededCrawlId` has findings and no marker — the unjudged shape.
    const unjudged = await call("crawl_compare", { baseCrawlId: cmpBaseId, headCrawlId: seededCrawlId });
    expect(unjudged.isError).toBe(true);
    expect(String(unjudged.body["error"])).toContain(seededCrawlId);
  });

  it("narrows crawl_list to one site, matching the apex and www spellings", async () => {
    const body = await ok("crawl_list", { siteUrl: `http://www.mcp-compare.example/`, limit: 50 });
    expect(items(body).map((row) => row["crawlId"])).toEqual([cmpOtherId]);

    const bad = await call("crawl_list", { siteUrl: "mcp-compare.example" });
    expect(bad.isError).toBe(true);
    expect(String(bad.body["error"])).toContain("siteUrl");
  });

  // THE DESCRIPTION PIN, in the house shape: every field the live answer
  // actually carries has to be named, so a shape that grows cannot leave the
  // sentence an agent reads describing the old one.
  it("names every field it answers with, and both caveat codes it produced", async () => {
    const text = await description("crawl_compare");
    const body = await ok("crawl_compare", { baseCrawlId: cmpBaseId, headCrawlId: cmpHeadId });

    const fields = new Set<string>(Object.keys(body));
    for (const key of ["base", "head"] as const) {
      for (const field of Object.keys(body[key] as Record<string, unknown>)) fields.add(field);
    }
    for (const row of body["rules"] as Record<string, unknown>[]) {
      for (const field of Object.keys(row)) fields.add(field);
    }
    for (const caveat of body["caveats"] as Record<string, unknown>[]) {
      for (const field of Object.keys(caveat)) fields.add(field);
    }
    // The live answer really did carry the URL denominators and the truncation
    // flags, so these are in the set because rows reported them.
    for (const field of ["baseUrls", "headUrls", "baseTruncated", "persisting"]) {
      expect(fields.has(field), `the live answer did not carry ${field}`).toBe(true);
    }
    for (const field of fields) {
      expect(text, `crawl_compare's description does not name '${field}'`).toContain(field);
    }

    // EVERY CAVEAT CODE, whether or not this fixture produced it: a code a UI
    // must switch on and cannot find in the description is an unrenderable
    // state.
    for (const code of [
      "ruleset-mismatch", "ruleset-unrecorded", "ruleset-mixed",
      "finding-cap-differs", "severity-changed",
    ]) {
      expect(text, `crawl_compare's description does not name '${code}'`).toContain(code);
    }
  });

  // THE FIELD-NAME LOOP IS NOT ENOUGH ON ITS OWN — it is satisfied by ordinary
  // English. These pin the two claims the shape cannot make for itself.
  it("states the identity rule and what comparable does not promise", async () => {
    const text = await description("crawl_compare");
    // What "the same finding" means across two crawls, and what it costs.
    expect(text).toContain("(rule, page URL)");
    expect(text).toContain("COLLAPSES TO PER-URL PRESENCE");
    expect(text).toContain("headUrls = new + persisting");
    // A site-wide finding has no URL and says so.
    expect(text).toContain("url null");
    // `comparable: false` is a statement, not a refusal; `true` is not a promise.
    expect(text).toContain("STATEMENT, NOT A REFUSAL");
    expect(text).toContain("comparable true is the weaker claim");
    // And the three refusals, named where an agent will read them.
    expect(text).toContain("different sites");
    expect(text).toContain("never been judged");

    const urls = await description("compare_urls");
    for (const set of ["new", "resolved", "persisting"]) expect(urls).toContain(set);
    expect(urls).toContain("url is null");
  });

  // WHERE EACH FIELD OF A ROW COMES FROM. severity is read off the rows and
  // category/checkIds/title are the CURRENT ruleset's copy — an asymmetry that
  // is invisible in the payload and matters most on the comparison across two
  // rulesets, which is what this tool is for.
  it("says which of a row's fields are the crawl's and which are today's copy", async () => {
    const text = await description("crawl_compare");
    expect(text).toContain("severity is");
    expect(text).toContain("read off the ROWS");
    expect(text).toContain("CURRENT ruleset's copy");
    for (const field of ["category", "checkIds", "title"]) expect(text).toContain(field);
    expect(text).toContain("today's");
  });

  // THE FIELD DESCRIPTION THAT INVERTS THE ANSWER IF IT IS WRONG.
  //
  // `set` is the one argument where swapping two words swaps what the tool
  // means, and it shipped saying "resolved (head only)" — a `join()` separator
  // pasting one set's parenthetical after every name. The generic sweep above
  // cannot see that (every name WAS present); only pinning the claim can.
  it("tells an agent which side each set belongs to, in the right direction", async () => {
    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === "compare_urls")?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    const text = schema?.properties?.["set"]?.description ?? "";

    expect(text).toContain("new is URLs only the HEAD crawl has");
    expect(text).toContain("resolved is URLs only the BASE crawl had");
    expect(text).toContain("persisting is URLs both carry");
    // And the shape of the bug itself, so the join() artefact cannot come back
    // in any spelling that attaches a side to the wrong set.
    expect(text).not.toMatch(/resolved[^.]{0,20}\bhead\b/i);
    expect(text).not.toMatch(/\bnew\b[^.]{0,20}\bbase\b/i);
  });
});

describe("metrics_get", () => {
  it("answers the measured numbers with their copy joined", async () => {
    const body = await ok("metrics_get", { crawlId: seededCrawlId });
    const rows = items(body);
    expect(rows.map((r) => r["metricId"])).toEqual([
      "content.metrics-by-type", "redirect.volume",
    ]);
    expect(rows[1]?.["value"]).toEqual({ ratioPct: 12 });
    expect(String(rows[1]?.["explanation"] ?? "")).not.toBe("");
  });

  it("filters by scope", async () => {
    const body = await ok("metrics_get", { crawlId: seededCrawlId, scope: "page_type" });
    expect(items(body).map((r) => r["scopeValue"])).toEqual(["product"]);
  });

  it("refuses a metricId this ruleset does not define", async () => {
    const answer = await call("metrics_get", { crawlId: seededCrawlId, metricId: "no.such.metric" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("no.such.metric");
  });
});

describe("pages_query", () => {
  it("answers the crawled pages, slim and ordered by URL", async () => {
    const body = await ok("pages_query", { crawlId: seededCrawlId });
    const rows = items(body);
    expect(rows.map((r) => r["url"])).toEqual([`${SEEDED_SITE}/b1`, `${SEEDED_SITE}/p1`]);
    // `clickDepth` sits beside `depth` and answers the other depth question —
    // clicks from the home page, null when no link path reaches the page —
    // which an agent needs per page: the click-depth metric gives percentiles,
    // and CHECK-31 asks for buckets and for the URLs in them.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "clickDepth", "depth", "discoveredVia", "fetchClass", "fetchReason", "indexable",
      "pageType", "renderError", "renderableWordCount", "rendered", "renderedWordCount",
      // See the same assertion in test/api/query.test.ts: the analyzer's count
      // over the post-JavaScript DOM, which is the column the CSR rule reads.
      "renderedRenderableWordCount",
      "statusCode", "url", "wordCount",
    ].sort());
  });

  it("filters by pageType and statusCode", async () => {
    const byType = await ok("pages_query", { crawlId: seededCrawlId, pageType: "product" });
    expect(items(byType).map((r) => r["url"])).toEqual([`${SEEDED_SITE}/p1`]);

    const byStatus = await ok("pages_query", { crawlId: seededCrawlId, statusCode: 500 });
    expect(items(byStatus).map((r) => r["url"])).toEqual([`${SEEDED_SITE}/b1`]);
  });

  it("filters by fetchClass and discoveredVia, the two questions the audit could not ask", async () => {
    const blocked = await ok("pages_query", { crawlId: surfaceCrawlId, fetchClass: "blocked" });
    expect(items(blocked).map((r) => r["url"])).toEqual([`${SEEDED_SITE}/blocked`]);

    const sitemapOnly = await ok("pages_query", {
      crawlId: surfaceCrawlId,
      discoveredVia: "sitemap",
    });
    expect(items(sitemapOnly).map((r) => r["url"])).toEqual([`${SEEDED_SITE}/only-in-sitemap`]);

    // A real value this crawl has no row for is an empty page, not a refusal.
    const timeouts = await ok("pages_query", { crawlId: surfaceCrawlId, fetchClass: "timeout" });
    expect(items(timeouts)).toEqual([]);
  });

  it("carries both word counts and how each page was found", async () => {
    const rows = items(await ok("pages_query", { crawlId: surfaceCrawlId, pageType: "home" }));
    const home = rows[0];
    expect(home?.["url"]).toBe(`${SEEDED_SITE}/home`);
    expect(home?.["wordCount"]).toBe(200);
    // The count with the markup-hidden words removed — the number a thin-content
    // judgement is made on, and the one the surface used not to publish at all.
    expect(home?.["renderableWordCount"]).toBe(140);
    expect(home?.["discoveredVia"]).toBe("seed");

    // Null is "never measured", carried as null rather than folded into
    // wordCount, which counts something else.
    const blocked = items(await ok("pages_query", { crawlId: surfaceCrawlId, fetchClass: "blocked" }));
    expect(blocked[0]?.["renderableWordCount"]).toBeNull();
  });

  it("refuses a status code that is not an HTTP status", async () => {
    const answer = await call("pages_query", { crawlId: seededCrawlId, statusCode: 999 });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("statusCode");
  });

  it("refuses a fetch class and a discovery kind the crawler cannot write", async () => {
    const badClass = await call("pages_query", { crawlId: surfaceCrawlId, fetchClass: "blocke" });
    expect(badClass.isError).toBe(true);
    expect(String(badClass.body["error"])).toContain("fetchClass");
    // The refusal names the vocabulary, so the typo is one round trip from fixed.
    expect(String(badClass.body["error"])).toContain("blocked");

    const badVia = await call("pages_query", { crawlId: surfaceCrawlId, discoveredVia: "crawl" });
    expect(badVia.isError).toBe(true);
    expect(String(badVia.body["error"])).toContain("discoveredVia");
    expect(String(badVia.body["error"])).toContain("sitemap");
  });
});

describe("robots_get", () => {
  it("answers with the robots.txt the crawl read, verbatim, plus what makes it readable", async () => {
    const body = await ok("robots_get", { crawlId: surfaceCrawlId });
    expect(body["crawlId"]).toBe(surfaceCrawlId);
    expect(body["robotsUrl"]).toBe(`${SEEDED_SITE}/robots.txt`);
    expect(body["outcome"]).toBe("read");
    expect(body["raw"]).toBe(SEEDED_ROBOTS);
    expect(body["truncated"]).toBe(false);
    expect(body["crawlDelaySec"]).toBe(3);
    expect(body["note"]).toBeNull();
    expect(body["sitemapSources"]).toEqual([`${SEEDED_SITE}/sitemap.xml`]);
    // The provenance of the walk's other document: this one was handed to the
    // crawl, not declared by the file. Two lists, because a supplied sitemap
    // folded into the declared ones would be a claim about robots.txt.
    expect(body["suppliedSitemaps"]).toEqual([`${SEEDED_SITE}/sitemap-extra.xml`]);
    expect(body["userAgent"]).toBe("AriadneBot/0.1 (mcp-test)");
    // The wrapper is closed: the sitemap walk's counters live in the same blob
    // and none of them are here.
    expect(Object.keys(body).sort()).toEqual([
      "crawlDelaySec", "crawlId", "note", "outcome", "raw", "robotsUrl",
      "sitemapSources", "suppliedSitemaps", "truncated", "userAgent",
    ]);
  });

  it("answers an empty supplied list for a crawl whose evidence predates the field", async () => {
    // A discovery blob written before a client could supply a sitemap. Absent
    // is EMPTY here and that is a fact, not a fallback: nobody could have
    // supplied one. The endpoint answers rather than refusing.
    const id = await seedCrawl({
      id: `crawl_mcp_presupply_${Date.now()}`,
      status: "finished",
      config: { siteUrl: `${SEEDED_SITE}/`, userAgent: "AriadneBot/0.1 (mcp-test)" },
      discovery: {
        robots: { outcome: "read", crawlDelaySec: null, note: null, raw: SEEDED_ROBOTS, truncated: false },
        sitemapSources: [`${SEEDED_SITE}/sitemap.xml`],
        truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 1 },
        docsFetched: 1,
      },
    });
    const body = await ok("robots_get", { crawlId: id });
    expect(body["suppliedSitemaps"]).toEqual([]);
  });

  it("refuses a supplied-sitemap list of the wrong shape rather than reading it as none", async () => {
    // "Nobody supplied a sitemap" is a claim about how the crawl was run. A
    // blob this engine did not write must not be read into one.
    const id = await seedCrawl({
      id: `crawl_mcp_badsupply_${Date.now()}`,
      status: "finished",
      config: { siteUrl: `${SEEDED_SITE}/`, userAgent: "AriadneBot/0.1 (mcp-test)" },
      discovery: {
        robots: { outcome: "read", crawlDelaySec: null, note: null, raw: SEEDED_ROBOTS, truncated: false },
        sitemapSources: [],
        suppliedSitemaps: `${SEEDED_SITE}/sitemap-extra.xml`,
        truncation: { failures: [], oversizedDocsSkipped: 0, entryLimited: false, docsFetched: 0 },
        docsFetched: 0,
      },
    });
    const answer = await call("robots_get", { crawlId: id });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("suppliedSitemaps");
  });

  it("reads the live crawl's own file, which the crawler fetched rather than this tool", async () => {
    const body = await ok("robots_get", { crawlId: liveCrawlId });
    expect(body["outcome"]).toBe("read");
    expect(String(body["raw"])).toContain("User-agent: *");
    const sources = body["sitemapSources"];
    expect(Array.isArray(sources) && sources.length > 0).toBe(true);
  });

  it("refuses a crawl with no discovery evidence, and one nothing knows", async () => {
    // The seeded crawl never completed discovery: "we have no record" must not
    // be served as "the site has no robots.txt".
    const noEvidence = await call("robots_get", { crawlId: seededCrawlId });
    expect(noEvidence.isError).toBe(true);
    expect(String(noEvidence.body["error"])).toContain("discovery evidence");

    const unknown = await call("robots_get", { crawlId: "crawl_missing" });
    expect(unknown.isError).toBe(true);
    expect(String(unknown.body["error"])).toContain("no such crawl");
  });
});

describe("export_crawl", () => {
  it("writes the dataset to a file and answers with the path and the count", async () => {
    const body = await ok("export_crawl", { crawlId: seededCrawlId, dataset: "issues" });
    expect(body["dataset"]).toBe("issues");
    expect(String(body["path"]).startsWith(exportDir)).toBe(true);
    expect(body["rows"]).toBe(5);
    expect(Number(body["bytes"])).toBeGreaterThan(0);
    // The contents stay in the file: a tool answer is a path and a count.
    expect(JSON.stringify(body)).not.toContain("links.orphan");
  });

  it("refuses a dataset that is not one of the three", async () => {
    const answer = await call("export_crawl", { crawlId: seededCrawlId, dataset: "everything" });
    expect(answer.isError).toBe(true);
    expect(String(answer.body["error"])).toContain("everything");
  });
});

/**
 * The CSV half of the same tool.
 *
 * An MCP client has no browser to stream a download into, so it gets what the
 * JSONL half gives it: a file under the server's export directory, and a path
 * and a count in the answer. The HTTP transport streams the identical rows —
 * `test/api/query.test.ts` owns the content and the injection guard; this file
 * owns the file-writing contract and what the tool TELLS an agent.
 */
describe("export_crawl — the CSV views", () => {
  function read(body: Record<string, unknown>): string {
    return readFileSync(String(body["path"]), "utf8");
  }

  it("writes a CSV under the export directory and answers with the path and the row count", async () => {
    const body = await ok("export_crawl", { crawlId: seededCrawlId, format: "csv" });
    expect(body["format"]).toBe("csv");
    expect(body["view"]).toBe("issues");
    expect(String(body["path"]).startsWith(exportDir)).toBe(true);
    expect(String(body["path"]).endsWith("-issues.csv")).toBe(true);
    // The same five findings the JSONL export writes, and the header is not one
    // of them: a row count that included it would be off by one everywhere a
    // caller compared it against findingsCount.
    expect(body["rows"]).toBe(5);
    const text = read(body);
    expect(text.split("\r\n")[0]).toBe("ruleId,severity,category,checkIds,url,title,evidence");
    expect(text.trimEnd().split("\r\n")).toHaveLength(6);
    // A path and a count, never the contents (the JSONL half's contract).
    expect(JSON.stringify(body)).not.toContain("links.orphan");
  });

  it("names the rule in the file it writes for one rule's findings", async () => {
    const body = await ok("export_crawl", {
      crawlId: seededCrawlId, format: "csv", view: "issue_urls", ruleId: "links.orphan",
    });
    expect(body["ruleId"]).toBe("links.orphan");
    expect(body["rows"]).toBe(3);
    expect(String(body["path"])).toContain("issue_urls-links.orphan");
    expect(read(body).split("\r\n")[0]).toBe("ruleId,url,evidence");
  });

  it("writes the links-derived views of a real crawl", async () => {
    const anchors = await ok("export_crawl", {
      crawlId: liveCrawlId, format: "csv", view: "anchor_texts",
    });
    expect(Number(anchors["rows"])).toBeGreaterThan(0);
    expect(read(anchors).split("\r\n")[0]).toBe("source,target,text");

    const pagesCsv = await ok("export_crawl", {
      crawlId: liveCrawlId, format: "csv", view: "internal_urls",
    });
    expect(read(pagesCsv).split("\r\n")[0]).toBe(
      "url,status,fetchClass,indexable,clickDepth,pageType,title",
    );
  });

  it("keeps the two formats' vocabularies apart, and says which word belongs where", async () => {
    const badView = await call("export_crawl", {
      crawlId: seededCrawlId, format: "csv", view: "everything",
    });
    expect(badView.isError).toBe(true);
    expect(String(badView.body["error"])).toContain("everything");

    const mixed = await call("export_crawl", {
      crawlId: seededCrawlId, format: "csv", dataset: "pages",
    });
    expect(mixed.isError).toBe(true);
    expect(String(mixed.body["error"])).toContain("dataset");

    // A view without the format is a caller who thinks they asked for CSV.
    const viewOnly = await call("export_crawl", { crawlId: seededCrawlId, view: "anchor_texts" });
    expect(viewOnly.isError).toBe(true);
    expect(String(viewOnly.body["error"])).toContain("format=csv");

    const noRule = await call("export_crawl", {
      crawlId: seededCrawlId, format: "csv", view: "issue_urls",
    });
    expect(noRule.isError).toBe(true);
    expect(String(noRule.body["error"])).toContain("ruleId");
  });
});

/**
 * ONE SURFACE, TWO TRANSPORTS — asserted rather than assumed.
 *
 * Both transports call the same `ApiService`, so the claim that a tool and its
 * route answer with the same shape has always been an argument about the code
 * rather than a property anybody checked. `docs/talos-surface.md` states it as a
 * contract to Talos — every shape in that document is written once and claimed
 * for both — and a contract nothing tests is a sentence.
 *
 * WHAT WOULD BREAK IT is not a service change (both would move together) but a
 * transport that shapes an answer on its way out: an HTTP route that wraps a
 * listing, an MCP handler that adds a field, a route that hands the service a
 * different default. Each of those is invisible in the other transport's own
 * suite, which is why this compares the two REAL answers over the wire rather
 * than two calls into the service.
 *
 * Both servers are built over the same database handle and the same export
 * directory, so the only difference between the two answers can be the
 * transport itself.
 */
describe("the two transports answer with one shape", () => {
  const TOKEN = "cross-transport-token-0123456789abcdef";
  let http: ApiServer;
  let httpBase = "";

  beforeAll(async () => {
    http = createApiServer({
      db,
      config: {
        token: TOKEN,
        allowedDomains: ["127.0.0.1"],
        exportDir,
        renderDir,
        log: (line) => serverLog.push(line),
      },
    });
    const address = await http.listen(0, "127.0.0.1");
    httpBase = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await http.close();
  });

  async function get(path: string): Promise<{ status: number; text: string; body: unknown }> {
    const res = await fetch(`${httpBase}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    return { status: res.status, text, body };
  }

  /**
   * One question, asked twice. The route and the tool are written out in full
   * rather than derived from each other: a mapping that generated the path from
   * the tool name would pass even if both were wrong in the same way.
   */
  interface Pair {
    tool: string;
    args: Record<string, unknown>;
    path: string;
    /** A property of the answer that must be true, so equality is not equality of nothing. */
    substantial: (body: Record<string, unknown>) => boolean;
  }

  function pairs(): Pair[] {
    const rows = (body: Record<string, unknown>): unknown[] =>
      Array.isArray(body["items"]) ? (body["items"] as unknown[]) : [];
    return [
      {
        tool: "rules_catalog",
        args: {},
        path: "/rules",
        substantial: (b) => (b["rules"] as unknown[]).length > 50,
      },
      {
        tool: "rules_catalog",
        args: { crawlId: catalogCrawlId },
        path: `/rules?crawlId=${catalogCrawlId}`,
        // The judged projection: some rule fired, and the fired state is on the row.
        substantial: (b) =>
          (b["rules"] as Record<string, unknown>[]).some(
            (r) => ((r["fired"] as { count?: number } | null)?.count ?? 0) > 0,
          ),
      },
      {
        tool: "rules_catalog",
        args: { crawlId: seededCrawlId },
        path: `/rules?crawlId=${seededCrawlId}`,
        // The unjudged projection: fired is null on every row, on both transports.
        substantial: (b) =>
          (b["rules"] as Record<string, unknown>[]).every((r) => r["fired"] === null),
      },
      {
        tool: "crawl_status",
        args: { crawlId: seededCrawlId },
        path: `/crawls/${seededCrawlId}`,
        substantial: (b) => b["crawlId"] === seededCrawlId,
      },
      {
        // The SAME tool on a crawl that carries resource rows. The pair above
        // compares a crawl whose whole resources block is zeroes, which would
        // let a transport drop or rename any of its numbers and still agree;
        // this one has a file on each side of every split it makes, the two
        // robots classes included (P12-T1).
        tool: "crawl_status",
        args: { crawlId: surfaceCrawlId },
        path: `/crawls/${surfaceCrawlId}`,
        substantial: (b) => {
          const r = b["resources"] as Record<string, number> | undefined;
          return (
            r !== undefined &&
            r["seen"] === 4 &&
            r["robotsDenied"] === 1 &&
            r["robotsUnreachable"] === 1
          );
        },
      },
      {
        tool: "crawl_list",
        args: { siteUrl: `http://www.mcp-compare.example/`, limit: 50 },
        path: `/crawls?siteUrl=${encodeURIComponent("http://www.mcp-compare.example/")}&limit=50`,
        substantial: (b) => rows(b).length > 0,
      },
      {
        tool: "issues_list",
        args: { crawlId: seededCrawlId },
        path: `/crawls/${seededCrawlId}/issues`,
        substantial: (b) => rows(b).length > 0,
      },
      {
        tool: "issue_urls",
        args: { crawlId: seededCrawlId, ruleId: "links.orphan" },
        path: `/crawls/${seededCrawlId}/issues/links.orphan/urls`,
        substantial: (b) => rows(b).length > 0,
      },
      {
        tool: "metrics_get",
        args: { crawlId: seededCrawlId },
        path: `/crawls/${seededCrawlId}/metrics`,
        substantial: (b) => rows(b).length > 0,
      },
      {
        tool: "pages_query",
        args: { crawlId: surfaceCrawlId },
        path: `/crawls/${surfaceCrawlId}/pages`,
        substantial: (b) => rows(b).length > 0,
      },
      {
        tool: "robots_get",
        args: { crawlId: surfaceCrawlId },
        path: `/crawls/${surfaceCrawlId}/robots`,
        substantial: (b) => typeof b["raw"] === "string",
      },
      {
        tool: "crawl_compare",
        args: { baseCrawlId: cmpBaseId, headCrawlId: cmpHeadId },
        path: `/compare?baseCrawlId=${cmpBaseId}&headCrawlId=${cmpHeadId}`,
        substantial: (b) =>
          (b["rules"] as unknown[]).length > 0 && (b["caveats"] as unknown[]).length > 0,
      },
      {
        tool: "compare_urls",
        args: {
          baseCrawlId: cmpBaseId, headCrawlId: cmpHeadId, ruleId: "title.missing", set: "new",
        },
        path:
          `/compare/urls?baseCrawlId=${cmpBaseId}&headCrawlId=${cmpHeadId}` +
          `&ruleId=title.missing&set=new`,
        substantial: (b) => rows(b).length > 0,
      },
    ];
  }

  it("answers the same JSON for the same question, route by tool", async () => {
    // This pair list is hand-enumerated, like the internals sweep's path list
    // (query.test.ts): a NEW read tool must be added here or it ships with no
    // cross-transport guarantee, and the count pin below is what makes a
    // silently deleted pair fail rather than shrink the loop.
    expect(pairs()).toHaveLength(13);
    for (const pair of pairs()) {
      const viaTool = await ok(pair.tool, pair.args);
      const viaHttp = await get(pair.path);
      expect(viaHttp.status, `${pair.path} did not answer 200`).toBe(200);
      // NOT a shape comparison: the whole value, keys and numbers alike. A
      // transport that renamed a field, dropped one, or answered a different
      // default page size fails here.
      expect(viaHttp.body, `${pair.tool} and ${pair.path} disagree`).toEqual(viaTool);
      expect(
        pair.substantial(viaTool),
        `${pair.tool} answered something too empty to compare`,
      ).toBe(true);
    }
  });

  it("refuses in the same words, whichever transport asked", async () => {
    // The refusal sentence is the service's, so both transports must carry it
    // verbatim — an agent and a dashboard reading different explanations of the
    // same 'no' is the same defect as two different answers.
    const cases: { tool: string; args: Record<string, unknown>; path: string; status: number }[] = [
      {
        tool: "rules_catalog",
        args: { crawlId: "crawl_nothing_knows_this" },
        path: "/rules?crawlId=crawl_nothing_knows_this",
        status: 404,
      },
      {
        tool: "crawl_compare",
        args: { baseCrawlId: cmpBaseId, headCrawlId: cmpOtherId },
        path: `/compare?baseCrawlId=${cmpBaseId}&headCrawlId=${cmpOtherId}`,
        status: 400,
      },
      {
        tool: "crawl_compare",
        args: { baseCrawlId: cmpBaseId, headCrawlId: seededCrawlId },
        path: `/compare?baseCrawlId=${cmpBaseId}&headCrawlId=${seededCrawlId}`,
        status: 400,
      },
      {
        tool: "compare_urls",
        args: {
          baseCrawlId: cmpBaseId, headCrawlId: cmpHeadId, ruleId: "title.missing", set: "moved",
        },
        path:
          `/compare/urls?baseCrawlId=${cmpBaseId}&headCrawlId=${cmpHeadId}` +
          `&ruleId=title.missing&set=moved`,
        status: 400,
      },
      {
        tool: "export_crawl",
        args: { crawlId: seededCrawlId, format: "csv", view: "everything" },
        path: `/crawls/${seededCrawlId}/export?format=csv&view=everything`,
        status: 400,
      },
    ];

    for (const c of cases) {
      const viaTool = await call(c.tool, c.args);
      const viaHttp = await get(c.path);
      expect(viaTool.isError, `${c.tool} did not refuse`).toBe(true);
      expect(viaHttp.status, `${c.path} did not answer ${c.status}`).toBe(c.status);
      expect(viaHttp.body).toEqual({ error: viaTool.body["error"] });
      // And neither spelling of the refusal carries anything from inside the
      // process (obligation 6): no stack frame, no path, no directory.
      for (const text of [viaTool.text, viaHttp.text]) {
        expect(text).not.toContain("    at ");
        expect(text).not.toContain(exportDir);
        expect(text).not.toContain("node_modules");
      }
    }
  });

  it("streams the bytes the other transport writes to a file", async () => {
    // The one place the two transports genuinely differ — an MCP client has no
    // download to stream into, so it gets a file — and the difference must be
    // where the bytes GO and nothing else.
    const written = await ok("export_crawl", {
      crawlId: seededCrawlId, format: "csv", view: "issues",
    });
    const file = readFileSync(String(written["path"]), "utf8");
    const streamed = await get(`/crawls/${seededCrawlId}/export?format=csv&view=issues`);

    expect(streamed.status).toBe(200);
    expect(streamed.text).toBe(file);
    // Not vacuously equal: a header and the crawl's five findings.
    expect(file.trimEnd().split("\r\n")).toHaveLength(6);
    // The MCP answer says where the file is; the HTTP answer IS the file.
    expect(Object.keys(written).sort()).toEqual(["bytes", "format", "path", "rows", "view"]);
    expect(streamed.body).toBeNull();
  });

  // The same claim for the view P11-T4 added. A new view is a new pair of code
  // paths — the tool's file writer and the route's chunked stream — and the one
  // that ships wrong is the one nobody compared.
  it("streams the resources view byte for byte, as it writes it", async () => {
    const written = await ok("export_crawl", {
      crawlId: surfaceCrawlId, format: "csv", view: "resources",
    });
    const file = readFileSync(String(written["path"]), "utf8");
    const streamed = await get(`/crawls/${surfaceCrawlId}/export?format=csv&view=resources`);

    expect(streamed.status).toBe(200);
    expect(streamed.text).toBe(file);
    // A header and the crawl's four files, with the empty cells that make an
    // unfetched row readable rather than absent.
    const lines = file.trimEnd().split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      "url,kind,fetchClass,status,bytes,bytesSource,contentType,cacheControl," +
        "fetchReason,referencingPages",
    );
    expect(written["rows"]).toBe(4);
    expect(file).toContain(",resource-cap,1");
    // Both robots classes reach the file the client opens, so the split is
    // readable per row and not only as two counts.
    expect(file).toContain(",robots_unreachable,");
    expect(file).toContain(",robots_denied,");
  });
});

describe("failure containment", () => {
  it("turns an unexpected throw into a tool error with a correlation id, keeping the stack in the log", async () => {
    const rig = await riggedServer({
      select: () => {
        throw new Error("boom from /srv/ariadne/internal/secret.ts");
      },
    });
    try {
      const answer = await callWith(rig.client, "crawl_status", { crawlId: "crawl_anything" });
      expect(answer.isError).toBe(true);
      expect(answer.body["error"]).toBe("internal error");
      const correlationId = String(answer.body["correlationId"]);
      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);

      // Nothing about the inside of the process reached the caller.
      expect(answer.text).not.toContain("boom");
      expect(answer.text).not.toContain("secret.ts");
      expect(answer.text).not.toContain("at ");

      // And all of it reached the log, under that id.
      const logged = rig.log.find((line) => line.includes(correlationId));
      expect(logged, "no log line carried the correlation id").toBeDefined();
      expect(logged).toContain("boom from /srv/ariadne/internal/secret.ts");
      expect(logged).toContain("at "); // the stack, not just the message
      expect(logged).toContain("crawl_status");
    } finally {
      await rig.client.close();
      await rig.mcp.close();
    }
  });
});

describe("the stdio entrypoint", () => {
  it("exits when the client hangs up: EOF on stdin is a shutdown, not a hang", async () => {
    // On stdio the client's death arrives as EOF and as nothing else — no
    // signal reaches a child whose parent simply exited, and the SDK's
    // transport does not subscribe to the stream's end. A server that stayed up
    // would hold the pool, and could still be fetching a real site for a client
    // that is gone (rule 9). This is the wiring, not the protocol: the spawn is
    // real, the crawl is not.
    const child = spawn(process.execPath, ["node_modules/.bin/tsx", "src/api/mcp-serve.ts"], {
      cwd: new URL("../../", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: databaseUrl(), ARIADNE_ALLOWED_DOMAINS: "127.0.0.1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const until = Date.now() + 30_000;
      while (!stderr.includes("serving on stdio")) {
        if (child.exitCode !== null) throw new Error(`mcp:serve exited early — ${stderr}`);
        if (Date.now() > until) throw new Error(`mcp:serve never booted — ${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }

      child.stdin.end();
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`still running after EOF — ${stderr}`)), 20_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(exit).toBe(0);
      expect(stderr).toContain("the client hung up");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 60_000);
});

describe("boot configuration", () => {
  it("refuses to start without a database", () => {
    expect(() => loadMcpConfig({})).toThrow(/DATABASE_URL must be set/);
  });

  it("asks for no bearer token: an stdio client is the process that started this one", () => {
    const config = loadMcpConfig({
      DATABASE_URL: "postgres://x",
      ARIADNE_ALLOWED_DOMAINS: "example.com,*.example.org",
    });
    expect(config.allowedDomains).toEqual(["example.com", "*.example.org"]);
    // The whole shape, not a sample: what this config DOES NOT carry is the
    // point of the assertion, and a token quietly appearing in it would be the
    // trust model changing without anybody saying so. `renderDir` joined the
    // set in P8-T1 and `exportDir` in P8-T6 — both name where this server keeps
    // its own output, which is an operator's filesystem choice and not a
    // credential.
    expect(Object.keys(config).sort()).toEqual([
      "allowedDomains",
      "databaseUrl",
      "exportDir",
      "renderDir",
    ]);
    // Unset means "use the default", which the service names — not a path this
    // function invents. See `parseOutputDir`.
    expect(config.renderDir).toBeUndefined();
    expect(config.exportDir).toBeUndefined();
  });

  it("still reads the allowlist, and an empty one is a posture rather than an error", () => {
    expect(loadMcpConfig({ DATABASE_URL: "postgres://x" }).allowedDomains).toEqual([]);
  });

  // ARIADNE_RENDER_DIR, both readings. An empty string is the same answer as an
  // unset variable — "use the default" — because a shell that exports an empty
  // value has said nothing, and treating it as a path would put a crawl's
  // evidence at the filesystem root.
  it("reads ARIADNE_RENDER_DIR, and treats empty and unset alike", () => {
    expect(
      loadMcpConfig({ DATABASE_URL: "postgres://x", ARIADNE_RENDER_DIR: "/srv/ariadne/renders" })
        .renderDir,
    ).toBe("/srv/ariadne/renders");
    expect(
      loadMcpConfig({ DATABASE_URL: "postgres://x", ARIADNE_RENDER_DIR: "   " }).renderDir,
    ).toBeUndefined();
  });

  // ARIADNE_EXPORT_DIR reads the shell exactly as its twin does, and that is
  // the assertion: one `parseOutputDir` serves both, so the two settings cannot
  // drift apart on what an empty value means.
  it("reads ARIADNE_EXPORT_DIR, and treats empty and unset alike", () => {
    expect(
      loadMcpConfig({ DATABASE_URL: "postgres://x", ARIADNE_EXPORT_DIR: "/srv/ariadne/exports" })
        .exportDir,
    ).toBe("/srv/ariadne/exports");
    expect(
      loadMcpConfig({ DATABASE_URL: "postgres://x", ARIADNE_EXPORT_DIR: "   " }).exportDir,
    ).toBeUndefined();
  });

  // The two are independent: naming one must not move the other. Without this
  // an entrypoint that read a single variable into both fields would pass every
  // test above.
  it("keeps the two output directories independent", () => {
    const onlyExport = loadMcpConfig({
      DATABASE_URL: "postgres://x",
      ARIADNE_EXPORT_DIR: "/srv/ariadne/exports",
    });
    expect(onlyExport.exportDir).toBe("/srv/ariadne/exports");
    expect(onlyExport.renderDir).toBeUndefined();
    const onlyRender = loadMcpConfig({
      DATABASE_URL: "postgres://x",
      ARIADNE_RENDER_DIR: "/srv/ariadne/renders",
    });
    expect(onlyRender.renderDir).toBe("/srv/ariadne/renders");
    expect(onlyRender.exportDir).toBeUndefined();
  });
});

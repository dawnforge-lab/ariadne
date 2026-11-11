/**
 * Migration 0013: `resources` and `page_resources` — the two tables that let the
 * crawler remember what the pages point at (P11-T1).
 *
 * What is under test is not the DDL (`runMigrations` either applied it or threw)
 * but the four claims the tables make, and all four are driven through a REAL
 * crawl of a real fixture server rather than through hand-written rows. That is
 * the migration-0012 discipline and it is load-bearing here: the refs are
 * produced by the analyzer, carried on `PageAnalysis` and written by
 * `PageWriter`, so a test that inserted rows by hand would still pass with the
 * whole chain deleted.
 *
 *  1. a crawled page's references land as `resources` rows, one per distinct
 *     URL, with the kind the MARKUP declared;
 *  2. the fetch columns are the FETCH PASS's, and by the end of a crawl it has
 *     filled them (P11-T2). The claim this case made while T1 stood alone — that
 *     every row is still null, "seen, not yet asked" — is now the writer's
 *     claim rather than the crawl's, and it is pinned on the writer in
 *     test/crawl/persist.test.ts. What a null still means has not moved: a
 *     resource nobody asked about is unknown, never fine and never broken;
 *  3. two pages sharing an image produce ONE resource row and TWO edges, which
 *     is the entire reason the fan-out is a separate table;
 *  4. a resource is NOT a crawl target: the frontier is unchanged by them, so
 *     the page count is the page count and no image was fetched as a page.
 *
 * Plus the cascade, which is the property every sibling table already has and
 * the only one a `delete from crawls` depends on.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { runCrawl, type CrawlConfig } from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pageResources, pages, resources } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/** The shared image both content pages reference — claim 3's subject. */
const SHARED_IMG = "/assets/shared.png";

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title>
    <link rel="stylesheet" href="/assets/site.css">
    <link rel="icon" href="/favicon.ico">
    </head><body>${body}</body></html>`;
}

let db: Db;
let server: Server;
let base: string;
let crawlId = "";
const created: string[] = [];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  server = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const bodies: Record<string, string> = {
      "/": html(`<a href="/a">a</a><a href="/b">b</a>`),
      // Both content pages carry the same image; /a adds a script and a
      // srcset whose FIRST candidate is the only one that counts.
      "/a": html(
        `<img src="${SHARED_IMG}" srcset="/assets/a-480.png 480w, /assets/a-960.png 960w" alt="a">
         <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="inline">
         <script src="/assets/app.js"></script>`,
      ),
      "/b": html(`<img src="${SHARED_IMG}" alt="b">`),
    };
    const body = bodies[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no fixture port");
  base = `http://127.0.0.1:${addr.port}`;

  const config: CrawlConfig = {
    siteUrl: `${base}/`,
    maxPages: 10,
    maxDepth: 3,
    userAgent: "AriadneBot-0013",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    // The sanctioned test-only use: the fixture site is on 127.0.0.1.
    allowPrivate: true,
  };
  const summary = await runCrawl(db, LOCAL_TENANT, config);
  crawlId = summary.crawlId;
  created.push(crawlId);
}, 60_000);

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await new Promise<void>((ok) => server.close(() => ok()));
  await closeFetchAgents();
});

describe("0013 — resources", () => {
  it("records one row per distinct URL, with the kind the markup declared", async () => {
    const rows = await db
      .select({ url: resources.url, kind: resources.kind })
      .from(resources)
      .where(eq(resources.crawlId, crawlId))
      .orderBy(resources.url);
    expect(rows).toEqual([
      { url: `${base}/assets/a-480.png`, kind: "image" },
      { url: `${base}/assets/app.js`, kind: "js" },
      // Three pages declare it and it is one file.
      { url: `${base}/assets/shared.png`, kind: "image" },
      { url: `${base}/assets/site.css`, kind: "css" },
    ]);
    // The closed list, from the other side: the favicon every page links is
    // NOT a resource this phase collects, and neither is the second srcset
    // candidate or the data: URI.
    const urls = rows.map((r) => r.url);
    expect(urls).not.toContain(`${base}/favicon.ico`);
    expect(urls).not.toContain(`${base}/assets/a-960.png`);
  });

  it("hands the fetch columns to the resource pass, which fills them", async () => {
    // T1 asserted these were still null after a crawl, because nothing fetched
    // yet. A crawl now runs the resource fetch pass before it closes its row
    // (P11-T2, loop.ts INSERTION 3b), so the END STATE of a crawl is
    // asked-and-answered. The null that means "seen, not yet asked" is the
    // state between the page writer and the pass, and it is pinned where it
    // belongs — on the writer itself, in test/crawl/persist.test.ts.
    //
    // This server serves pages and no assets, so every reference is a 404. That
    // is the honest answer for these rows and the one the broken-resource rule
    // (P11-T3) will read — and it is emphatically not a null.
    const rows = await db
      .select({
        url: resources.url,
        fetchClass: resources.fetchClass,
        statusCode: resources.statusCode,
        bytes: resources.bytes,
        fetchedAt: resources.fetchedAt,
      })
      .from(resources)
      .where(eq(resources.crawlId, crawlId));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.fetchClass, row.url).toBe("client_error");
      expect(row.statusCode, row.url).toBe(404);
      // A resource we could not have is a resource with no weight to report.
      expect(row.bytes, row.url).toBeNull();
      expect(row.fetchedAt, row.url).not.toBeNull();
    }
  });

  it("gives the shared image ONE row and TWO edges, one per referencing page", async () => {
    const edges = await db
      .select({ url: pageResources.resourceUrl, pageUrl: pages.url })
      .from(pageResources)
      .innerJoin(pages, eq(pages.id, pageResources.pageId))
      .where(eq(pageResources.crawlId, crawlId))
      .orderBy(pages.url);
    const shared = edges.filter((e) => e.url === `${base}/assets/shared.png`);
    expect(shared.map((e) => e.pageUrl)).toEqual([`${base}/a`, `${base}/b`]);

    // The stylesheet is on all three pages; the script only on /a.
    const css = edges.filter((e) => e.url === `${base}/assets/site.css`);
    expect(css.map((e) => e.pageUrl)).toEqual([`${base}/`, `${base}/a`, `${base}/b`]);
    const js = edges.filter((e) => e.url === `${base}/assets/app.js`);
    expect(js.map((e) => e.pageUrl)).toEqual([`${base}/a`]);
  });

  it("does not make a resource a crawl target", async () => {
    // The frontier follows anchors. An image that entered it would be fetched
    // as a page, counted as one, and (being an image) classified `non_html` —
    // a whole class of noise the split exists to avoid.
    const rows = await db
      .select({ url: pages.url })
      .from(pages)
      .where(eq(pages.crawlId, crawlId))
      .orderBy(pages.url);
    expect(rows.map((r) => r.url)).toEqual([`${base}/`, `${base}/a`, `${base}/b`]);
  });

  it("keeps the image COUNTERS beside the refs, both exact", async () => {
    // Two facts, not one: /a carries two <img> elements (one of them a data:
    // URI that is no resource at all) and contributes two image resources (its
    // src and the first srcset candidate). Neither number is derivable from
    // the other, which is why both are written.
    const [row] = await db
      .select({ total: pages.imagesTotal })
      .from(pages)
      .where(sql`${pages.crawlId} = ${crawlId} and ${pages.url} = ${`${base}/a`}`);
    expect(row!.total).toBe(2);
    const refs = await db
      .select({ url: pageResources.resourceUrl })
      .from(pageResources)
      .innerJoin(pages, eq(pages.id, pageResources.pageId))
      .where(sql`${pageResources.crawlId} = ${crawlId} and ${pages.url} = ${`${base}/a`}`);
    expect(refs.map((r) => r.url).sort()).toEqual([
      `${base}/assets/a-480.png`,
      `${base}/assets/app.js`,
      `${base}/assets/shared.png`,
      `${base}/assets/site.css`,
    ]);
  });

  it("cascades from the crawl delete, like every sibling table", async () => {
    const id = created.shift()!;
    const count = async (table: typeof resources | typeof pageResources) => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.crawlId, id));
      return rows[0]?.n ?? 0;
    };
    expect(await count(resources)).toBeGreaterThan(0);
    expect(await count(pageResources)).toBeGreaterThan(0);

    await db.delete(crawls).where(eq(crawls.id, id));
    expect(await count(resources)).toBe(0);
    expect(await count(pageResources)).toBe(0);
  });
});

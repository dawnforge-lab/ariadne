/**
 * Migration 0012: the three schema debts the Phase 8 gate ledgered (§15), and
 * the code that makes each new column the ONE source of its fact.
 *
 * What is under test here is not the DDL — `runMigrations` either applied it or
 * threw — but the three claims the columns make:
 *
 *  1. an explicit render pass records its URL list in
 *     `crawls.render_urls_jsonb` and does not touch `config_jsonb`, which
 *     `storableConfig` is the only writer of again;
 *  2. a crawl whose template inference ran carries
 *     `crawls.template_inference_jsonb` — the 196 -> 13 fact that lived in a log
 *     line through Phase 8 — and a crawl this pass never reached carries NULL,
 *     which is the whole point of the column (docs/gates/phase-8.md §7.2);
 *  3. the three partial expression indexes exist with the predicate the
 *     duplicate rules' cohort is spelled with. The planner uses a partial index
 *     only when the query's WHERE implies the index's, so that predicate is a
 *     textual coupling between `INDEXABLE` (src/rules/query/field-duplicates.ts)
 *     and `src/db/schema.ts` — and a coupling nothing checks is a coupling that
 *     breaks silently, as a slow query rather than a failure.
 *
 * The render half drives the REAL pass against a real Chromium over a real
 * fixture server, for the reason the harness does: the column is written by the
 * pass, and a test that wrote it by hand would pass with the writer deleted.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { parseStoredConfig, runCrawl, type CrawlConfig } from "../../src/crawl/loop.js";
import { derivePageType, inferPageTemplates } from "../../src/crawl/page-type.js";
import { runRenderPass } from "../../src/crawl/render/run-render.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

let db: Db;
let server: Server;
let base: string;
let renderRoot: string;
const created: string[] = [];

/** The crawl both halves of the render story run over: three pages, one host. */
let crawlId = "";
let config: CrawlConfig;

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
      "/a": html(`<p>a</p>`),
      "/b": html(`<p>b</p>`),
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

  config = {
    siteUrl: `${base}/`,
    maxPages: 10,
    maxDepth: 3,
    userAgent: "AriadneBot-0012",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    // The sanctioned test-only use: the fixture site is on 127.0.0.1.
    allowPrivate: true,
  };
  const summary = await runCrawl(db, LOCAL_TENANT, config);
  crawlId = summary.crawlId;
  created.push(crawlId);

  renderRoot = await mkdtemp(join(tmpdir(), "ariadne-0012-renders-"));
}, 60_000);

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await new Promise<void>((ok) => server.close(() => ok()));
  await rm(renderRoot, { recursive: true, force: true });
  await closeFetchAgents();
});

describe("0012 — crawls.render_urls_jsonb", () => {
  /**
   * The property the migration exists for. Before it, this list was a
   * `renderUrls` key the pass patched into `config_jsonb` with `jsonb_set` —
   * which made the render pass a second writer of a blob `storableConfig`
   * owned, and imposed a standing "never rewrite the whole config" rule on
   * every future writer. Both halves are asserted: the list lands in the
   * column, and the config comes back byte-for-byte what the crawl stored.
   */
  it("records an explicit pass's list in the column and leaves config_jsonb alone", async () => {
    const [before] = await db
      .select({ config: crawls.config })
      .from(crawls)
      .where(eq(crawls.id, crawlId));

    const named = [`${base}/a`];
    const summary = await runRenderPass(db, crawlId, {
      ...config,
      renderHtmlDir: renderRoot,
      renderUrls: named,
    });
    expect(summary.selection.mode).toBe("explicit");

    const [row] = await db
      .select({ config: crawls.config, renderUrls: crawls.renderUrlsJsonb })
      .from(crawls)
      .where(eq(crawls.id, crawlId));
    expect(row!.renderUrls).toEqual(named);
    expect(row!.config).toEqual(before!.config);
    expect(Object.keys(row!.config as Record<string, unknown>)).not.toContain("renderUrls");
  }, 120_000);

  /**
   * A crawl rendered from a list and then rendered automatically must stop
   * saying "explicit": every pass overwrites the record, so the column always
   * describes the LAST selection. NULL, not an empty array — an empty list
   * would read as "somebody named no pages", which is not what happened.
   *
   * The list it overwrites is set HERE rather than inherited from the test
   * above: a case that depends on a sibling's write passes for the wrong
   * reason when that sibling breaks, and this one would then be asserting that
   * NULL stayed NULL.
   */
  it("an automatic pass writes NULL over the earlier list", async () => {
    await db
      .update(crawls)
      .set({ renderUrlsJsonb: [`${base}/a`] })
      .where(eq(crawls.id, crawlId));

    const summary = await runRenderPass(db, crawlId, {
      ...config,
      renderHtmlDir: renderRoot,
    });
    expect(summary.selection.mode).toBe("auto");

    const [row] = await db
      .select({ renderUrls: crawls.renderUrlsJsonb })
      .from(crawls)
      .where(eq(crawls.id, crawlId));
    expect(row!.renderUrls).toBeNull();
  }, 120_000);

  /**
   * The closed field set in `parseStoredConfig` is what stops a row that
   * (illegitimately) still carries the legacy key — written before 0012, or
   * edited by hand — from leaking it into a later pass's `CrawlConfig`. It held
   * through Phase 8 and it is what the migration relies on for any row it did
   * not reach; pinned rather than assumed.
   */
  it("parseStoredConfig ignores a legacy renderUrls key on a stored row", () => {
    const parsed = parseStoredConfig(
      {
        siteUrl: "https://example.com/",
        maxPages: 500,
        maxDepth: 5,
        userAgent: "AriadneBot-0012",
        perHostDelayMs: 1000,
        maxConcurrency: 4,
        renderUrls: ["https://example.com/a"],
      },
      "crawl_legacy",
    );
    expect(parsed).not.toHaveProperty("renderUrls");
    expect(parsed.siteUrl).toBe("https://example.com/");
  });
});

describe("0012 — crawls.template_inference_jsonb", () => {
  /**
   * The collapse that gave the column its reason: 196 URL shapes over 551
   * pages, most of them singletons. `retyped > 0` and `shapesBefore >
   * typesAfter` are the case the log line used to carry, and the marker is the
   * same numbers in a place a reader a week later can find.
   */
  it("stamps what a collapsing pass did, in the shape the column documents", async () => {
    const id = `crawl_${randomUUID()}`;
    created.push(id);
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: "https://example.com",
      config: { maxPages: 1000 },
      rulesetVersion: "test",
      status: "finished",
    });
    // Eight product URLs under one shape each: singletons until the population
    // says otherwise, which is exactly what the collapse is for.
    const paths = ["/products/a", "/products/b", "/products/c", "/products/d",
                   "/products/e", "/products/f", "/products/g", "/products/h"];
    await db.insert(pages).values(
      paths.map((path) => ({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url: `https://example.com${path}`,
        urlNormalised: `https://example.com${path}`,
        pageType: derivePageType(`https://example.com${path}`),
        statusCode: 200,
        fetchClass: "ok",
        depth: 1,
        discoveredVia: "link",
      })),
    );

    const before = await db
      .select({ marker: crawls.templateInferenceJsonb })
      .from(crawls)
      .where(eq(crawls.id, id));
    // NULL until the pass runs — the state every pre-Phase-8 row is in, and the
    // one the column exists to tell apart from "ran and collapsed nothing".
    expect(before[0]!.marker).toBeNull();

    const result = await inferPageTemplates(db, id);
    expect(result.pagesRetyped).toBeGreaterThan(0);

    const [row] = await db
      .select({ marker: crawls.templateInferenceJsonb })
      .from(crawls)
      .where(eq(crawls.id, id));
    const marker = row!.marker as Record<string, unknown>;
    expect(Object.keys(marker).sort()).toEqual(["at", "retyped", "shapesBefore", "typesAfter"]);
    expect(marker["shapesBefore"]).toBe(result.typesBefore);
    expect(marker["typesAfter"]).toBe(result.typesAfter);
    expect(marker["retyped"]).toBe(result.pagesRetyped);
    expect(Number(marker["shapesBefore"])).toBeGreaterThan(Number(marker["typesAfter"]));
    expect(Number(marker["retyped"])).toBeGreaterThan(0);
    // ISO-8601 from the Node clock, the same one `closeCrawl` stamps
    // `finished_at` from.
    expect(new Date(String(marker["at"])).toISOString()).toBe(marker["at"]);
  });

  /**
   * THE HALF THAT WOULD OTHERWISE BE INVISIBLE. A crawl whose types were
   * already templates collapses nothing, and through Phase 8 that was
   * indistinguishable from a crawl the pass never ran over. It is a marker with
   * `retyped: 0`, not a NULL.
   */
  it("stamps a pass that had nothing to collapse, rather than leaving NULL", async () => {
    const [row] = await db
      .select({ marker: crawls.templateInferenceJsonb })
      .from(crawls)
      .where(eq(crawls.id, crawlId));
    const marker = row!.marker as Record<string, unknown>;
    expect(Object.keys(marker).sort()).toEqual(["at", "retyped", "shapesBefore", "typesAfter"]);
    expect(marker["retyped"]).toBe(0);
    expect(Number(marker["shapesBefore"])).toBeGreaterThanOrEqual(
      Number(marker["typesAfter"]),
    );
  });
});

describe("0012 — the duplicate-group indexes", () => {
  /**
   * The textual coupling, checked. `INDEXABLE` (src/rules/query/field-
   * duplicates.ts) and these three predicates must stay spelled identically:
   * Postgres uses a partial index only when it can prove the query's WHERE
   * implies the index's, and a predicate that drifts does not raise — it
   * silently stops being used, which is how the 10.4 ms/group the Phase 8 gate
   * measured would come back.
   */
  it("exist, partial, on the grouped expression, over the rules' cohort", async () => {
    const res = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where tablename = 'pages' and indexname like 'pages_dupe_%'`);
    const defs = new Map(res.rows.map((r) => [r.indexname, r.indexdef]));
    for (const [name, column] of [
      ["pages_dupe_title", "title"],
      ["pages_dupe_meta_description", "meta_description"],
      ["pages_dupe_h1_text", "h1_text"],
    ] as const) {
      const def = defs.get(name);
      expect(def, `missing index ${name}`).toBeDefined();
      // THE WHOLE KEY LIST, IN ORDER, not just its members. `crawl_id` first
      // for the equality, the grouped expression second so `group by
      // btrim(<field>)` is answerable from it, and `url` THIRD so the sample
      // lateral's `order by p2.url limit 20` is read off the index instead of
      // sorted — which is where the measured 0.338 -> 0.009 ms per group came
      // from. Any other order still contains all three names and would satisfy
      // a membership check while losing the sort avoidance silently.
      expect(def).toContain(`USING btree (crawl_id, btrim(${column}), url)`);
      // The cohort, verbatim from the rules' INDEXABLE, as Postgres normalises
      // it (`is_indexable = true` spelled out, `'ok'::text` cast).
      expect(def).toContain(
        `WHERE ((fetch_class = 'ok'::text) AND (status_code = 200) AND ` +
          `(is_indexable = true) AND (${column} IS NOT NULL))`,
      );
    }
  });
});

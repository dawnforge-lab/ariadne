/**
 * The known-404 probe is contained: it may fail without failing the crawl.
 *
 * The probe is the last thing `runToCompletion` does, after every page has been
 * fetched, written and committed. A throw from it — the analyzer choking on a
 * template, the `crawls` update losing its connection — used to propagate out
 * of `runCrawl`, and `execute` would then mark a crawl that had done all of its
 * work `failed`. That is a lie about the pages in the table.
 *
 * So the invocation is wrapped, and the failure is written down where the
 * probe's own decisions are written down (`{ skipped }`, hard rule 7). What is
 * NOT allowed is log-and-continue: if the skip cannot be recorded either, the
 * crawl has lost the ability to say what it knows and the error surfaces
 * through the loop's own failure aggregation.
 *
 * The analyzer is mocked here rather than a body crafted to break it: what is
 * under test is the containment, and the poison has to be certain.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { runCrawl, type CrawlConfig } from "../../src/crawl/loop.js";

/** The message the mocked analyzer throws for the probe URL, and only for it. */
const POISON = "poisoned analyzer: the probe body blew up";

vi.mock("../../src/crawl/parse/page-analyzer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/crawl/parse/page-analyzer.js")>();
  return {
    ...actual,
    analyzePage: (html: string, url: string) => {
      if (url.includes("__ariadne-404-probe-")) throw new Error(POISON);
      return actual.analyzePage(html, url);
    },
  };
});

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

/**
 * A site that answers 200 with HTML for every URL, so the probe reaches the
 * analyzer at all: a 404 carries no template and never gets that far.
 */
let siteServer: Server;
let base: string;

let db: Db;
const createdCrawls: string[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

function config(overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    siteUrl: base,
    maxPages: 20,
    maxDepth: 2,
    userAgent: "AriadneBot-test",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    allowPrivate: true,
    // The host probe is a different fetch with different evidence; this file is
    // about the 404 probe only.
    probeHosts: false,
    ...overrides,
  };
}

beforeAll(async () => {
  siteServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nothing here");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(`<a href="/a">a</a>`));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html(`<p>every URL answers</p>`));
  });
  base = await listen(siteServer);

  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
});

async function crawlRow(crawlId: string) {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
  if (row === undefined) throw new Error(`no crawls row for ${crawlId}`);
  return row;
}

describe("known-404 probe containment", () => {
  it("finishes the crawl and records why the probe produced no sample", async () => {
    const summary = await runCrawl(db, config());
    createdCrawls.push(summary.crawlId);

    // The crawl did its work; the probe is an epilogue, not a verdict on it.
    expect(summary.status).toBe("finished");
    expect(summary.pagesCrawled).toBeGreaterThan(0);

    const row = await crawlRow(summary.crawlId);
    expect(row.status).toBe("finished");
    const probe = row.notfoundProbe as { skipped?: string };
    // The reason, in the shape the soft-404 rule already reads: a skip that
    // says why, never a null and never a half-written sample.
    expect(probe.skipped).toBe(`probe failed: ${POISON}`);
  });

  /**
   * Both halves poisoned: the probe throws, and the write that would record the
   * throw throws too. Nothing is left to write the fact down with, so the crawl
   * must NOT report success — the error goes into the same aggregation the loop
   * and the shutdown use, and comes out of `runCrawl`.
   */
  it("refuses to swallow a probe failure it cannot even record", async () => {
    const poisonedWrite = new Error("poisoned write: the crawls update failed");
    const poisoned = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver) as unknown;
        return (table: Parameters<Db["update"]>[0]) => {
          const builder = target.update(table);
          return new Proxy(builder, {
            get(b, p, r) {
              if (p !== "set") return Reflect.get(b, p, r) as unknown;
              return (values: Record<string, unknown>) =>
                values["notfoundProbe"] === undefined
                  ? b.set(values)
                  : { where: () => Promise.reject(poisonedWrite) };
            },
          });
        };
      },
    }) as Db;

    const error = await runCrawl(poisoned, config()).then(
      () => null,
      (e: unknown) => e,
    );
    // No summary comes back, so the row is found by what it is: this site's
    // crawl that ended `failed`.
    const rows = await db.select().from(crawls).where(eq(crawls.siteUrl, base));
    for (const row of rows) if (!createdCrawls.includes(row.id)) createdCrawls.push(row.id);

    expect(error).toBeInstanceOf(AggregateError);
    const errors = (error as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe(POISON);
    expect(errors[1]).toBe(poisonedWrite);

    // And the row says failed: a crawl that threw is not a crawl that finished.
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(1);
  });
});

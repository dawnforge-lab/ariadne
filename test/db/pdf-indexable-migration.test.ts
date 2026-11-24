/**
 * Migration 0061: stored PDFs are indexable unless their headers say otherwise
 * (Phase 29d, Task 5a; ruling R1). Before it, `PageWriter` stamped every
 * `non_html` row false; the migration rewrites a stored 200 PDF with no noindex
 * in `X-Robots-Tag` to true, from the stored status, content type and header.
 *
 * Two claims:
 *  - the migration's predicate IS the helpers' SQL (`IS_PDF`, `SAYS_NOINDEX`),
 *    copied verbatim, so the rewrite of old crawls and the rules' reading of
 *    the same columns cannot drift;
 *  - run over the shapes the writer meets, it flips the plain 200 PDF (and a
 *    parameterised type) and nothing else, and an HTML row is untouched.
 *
 * Runs the migration's own SQL file inside one transaction that is always
 * rolled back (the migration-0054 pattern), because the UPDATE is unscoped and
 * other test files share this database.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { IS_PDF, SAYS_NOINDEX } from "../../src/rules/helpers.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/** Thrown at the end of the transaction to roll it back; anything else is a failure. */
class RollBack extends Error {}

const FILE = readFileSync(
  new URL("../../drizzle/0061_pdf_indexable.sql", import.meta.url),
  "utf8",
);

let db: Db;

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(db);
});

describe("0061 — a stored PDF is indexable unless its headers say otherwise", () => {
  it("spells its predicate with the helpers' SQL, verbatim", () => {
    expect(FILE).toContain(IS_PDF("content_type"));
    expect(FILE).toContain(`NOT ${SAYS_NOINDEX("x_robots_tag")}`);
    expect(FILE).toContain("fetch_class = 'non_html'");
    expect(FILE).toContain("status_code = 200");
  });

  it("flips only the plain 200 PDFs, leaves HTML untouched, rolled back", async () => {
    const tag = randomUUID();
    const crawlId = `crawl_0061_${tag}`;
    const site = "https://m61.example";
    const shapes: Array<{
      path: string;
      fetchClass: string;
      statusCode: number;
      contentType: string;
      xRobotsTag: string | null;
      before: boolean;
      after: boolean;
    }> = [
      { path: "/plain.pdf", fetchClass: "non_html", statusCode: 200, contentType: "application/pdf", xRobotsTag: null, before: false, after: true },
      { path: "/charset.pdf", fetchClass: "non_html", statusCode: 200, contentType: "application/PDF; charset=binary", xRobotsTag: null, before: false, after: true },
      { path: "/noindex.pdf", fetchClass: "non_html", statusCode: 200, contentType: "application/pdf", xRobotsTag: "noindex", before: false, after: false },
      { path: "/none.pdf", fetchClass: "non_html", statusCode: 200, contentType: "application/pdf", xRobotsTag: "none", before: false, after: false },
      { path: "/gone.pdf", fetchClass: "client_error", statusCode: 404, contentType: "application/pdf", xRobotsTag: null, before: false, after: false },
      { path: "/report.doc", fetchClass: "non_html", statusCode: 200, contentType: "application/msword", xRobotsTag: null, before: false, after: false },
      { path: "/photo.png", fetchClass: "non_html", statusCode: 200, contentType: "image/png", xRobotsTag: null, before: false, after: false },
      // HTML, both ways: the migration reads neither.
      { path: "/page", fetchClass: "ok", statusCode: 200, contentType: "text/html", xRobotsTag: null, before: true, after: true },
      { path: "/hidden", fetchClass: "ok", statusCode: 200, contentType: "text/html", xRobotsTag: "noindex", before: false, after: false },
    ];
    let asserted = false;

    const outcome = await db
      .transaction(async (tx) => {
        await tx.insert(crawls).values({
          id: crawlId,
          tenantId: LOCAL_TENANT,
          siteUrl: site,
          hostKey: "m61.example",
          config: { maxPages: 10 },
          rulesetVersion: "test",
        });
        await tx.insert(pages).values(
          shapes.map((s) => ({
            id: `page_${randomUUID()}`,
            crawlId,
            url: `${site}${s.path}`,
            urlNormalised: `${site}${s.path}`,
            fetchClass: s.fetchClass,
            statusCode: s.statusCode,
            contentType: s.contentType,
            xRobotsTag: s.xRobotsTag,
            isIndexable: s.before,
            depth: 1,
            discoveredVia: "link",
          })),
        );

        await tx.execute(sql.raw(FILE));

        const read = async (): Promise<Map<string, boolean | null>> => {
          const rows = await tx
            .select({ url: pages.url, isIndexable: pages.isIndexable })
            .from(pages)
            .where(eq(pages.crawlId, crawlId));
          return new Map(rows.map((r) => [r.url, r.isIndexable]));
        };
        const stamp = await read();
        for (const s of shapes) expect(stamp.get(`${site}${s.path}`), s.path).toBe(s.after);

        // Idempotent: a second application changes nothing.
        await tx.execute(sql.raw(FILE));
        expect(await read()).toEqual(stamp);

        asserted = true;
        throw new RollBack("roll back the unscoped rewrite");
      })
      .catch((error: unknown) => {
        if (error instanceof RollBack) return error;
        throw error;
      });

    expect(outcome).toBeInstanceOf(RollBack);
    expect(asserted).toBe(true);
    const left = await db.select({ id: crawls.id }).from(crawls).where(eq(crawls.id, crawlId));
    expect(left).toEqual([]);
  });
});

/**
 * INDEXABILITY_STATUS_SQL against `indexabilityOf`, row for row.
 *
 * The rows go through `values`, as the CANONICALISED_ELSEWHERE pin in
 * helpers.test.ts does: the expression reads seven columns of an aliased
 * `pages` and needs no crawl. Every `IndexabilityStatus` member except the
 * empty one must occur, so the parity is not vacuous, and the edge rows sit on
 * the precedence boundaries where two conditions hold at once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { FETCH_CLASSES } from "../../src/crawl/fetch-page.js";
import {
  hasNoindex,
  indexabilityOf,
  INDEXABILITY_STATUS_SQL,
  type IndexabilityStatus,
} from "../../src/rules/helpers.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
import { mkPage } from "./mk-page.js";

const ELSEWHERE = "https://example.com/other";

interface Row {
  why: string;
  over: Partial<PageRecord>;
}

/** The writer's stamp: a 200, fetched ok, no noindex on either channel. */
function stamped(over: Partial<PageRecord>): PageRecord {
  const page = mkPage(over);
  return {
    ...page,
    isIndexable: page.fetchClass === "ok" && page.statusCode === 200 && !hasNoindex(page),
  };
}

const ROWS: Row[] = [
  { why: "indexable", over: {} },
  { why: "indexable, no canonical", over: { canonicalHtml: null } },
  { why: "redirect", over: { fetchClass: "redirect", statusCode: 301 } },
  { why: "client error", over: { fetchClass: "client_error", statusCode: 404 } },
  { why: "server error", over: { fetchClass: "server_error", statusCode: 503 } },
  { why: "blocked", over: { fetchClass: "blocked", statusCode: 403 } },
  { why: "blocked 200 challenge", over: { fetchClass: "blocked", statusCode: 200 } },
  { why: "disallowed", over: { fetchClass: "disallowed", statusCode: null } },
  { why: "excluded by crawl settings", over: { fetchClass: "excluded", statusCode: null } },
  { why: "timeout", over: { fetchClass: "timeout", statusCode: null } },
  { why: "network error", over: { fetchClass: "network_error", statusCode: null } },
  { why: "non html", over: { fetchClass: "non_html", statusCode: 200 } },
  { why: "too large", over: { fetchClass: "too_large", statusCode: 200 } },
  { why: "unsupported encoding", over: { fetchClass: "unsupported_encoding", statusCode: 200 } },
  { why: "ok 204", over: { statusCode: 204 } },
  { why: "ok null status", over: { statusCode: null } },
  { why: "noindex meta", over: { robotsMeta: "noindex" } },
  { why: "noindex header", over: { xRobotsTag: "noindex, nofollow" } },
  { why: "noindex mixed case in a list", over: { robotsMeta: "max-snippet:-1, NoIndex, follow" } },
  { why: "none shorthand", over: { robotsMeta: "none" } },
  { why: "none with spaces and commas", over: { xRobotsTag: "nofollow , None ,max-snippet:0" } },
  { why: "bot-prefixed noindex", over: { robotsMeta: "googlebot: noindex" } },
  { why: "nonevent is not none", over: { robotsMeta: "nonevent" } },
  { why: "nofollow only", over: { robotsMeta: "nofollow" } },
  { why: "blank robots", over: { robotsMeta: "   ", xRobotsTag: "" } },
  { why: "canonicalised", over: { canonicalHtml: ELSEWHERE } },
  { why: "canonicalised by header", over: { canonicalHtml: null, canonicalHeader: ELSEWHERE } },
  { why: "html canonical self beats header elsewhere", over: { canonicalHeader: ELSEWHERE } },
  { why: "empty html canonical falls to header", over: { canonicalHtml: "", canonicalHeader: ELSEWHERE } },
  { why: "self canonical with fragment and host case", over: { canonicalHtml: "https://EXAMPLE.com/page#top" } },
  // Precedence boundaries: two conditions at once.
  { why: "noindex + canonicalised: noindex wins", over: { robotsMeta: "noindex", canonicalHtml: ELSEWHERE } },
  { why: "header none + canonicalised: noindex wins", over: { xRobotsTag: "none", canonicalHtml: ELSEWHERE } },
  { why: "redirect + noindex + canonical: redirect wins", over: { fetchClass: "redirect", statusCode: 301, robotsMeta: "noindex", canonicalHtml: ELSEWHERE } },
  { why: "client error + canonical: client error wins", over: { fetchClass: "client_error", statusCode: 404, canonicalHtml: ELSEWHERE } },
  { why: "blocked 503: blocked, not server error", over: { fetchClass: "blocked", statusCode: 503 } },
  { why: "non_html + noindex: Not HTML wins", over: { fetchClass: "non_html", robotsMeta: "noindex" } },
  { why: "ok 204 + noindex: Not HTML wins", over: { statusCode: 204, robotsMeta: "noindex" } },
  { why: "ok 206 + canonicalised: Not HTML wins", over: { statusCode: 206, canonicalHtml: ELSEWHERE } },
  { why: "disallowed + noindex: robots.txt wins", over: { fetchClass: "disallowed", statusCode: null, robotsMeta: "noindex" } },
];

describe("INDEXABILITY_STATUS_SQL agrees with indexabilityOf", () => {
  let db: Db;

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
    db = createDb(url);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  /** The seven columns the expression reads, typed so a NULL has a type. */
  async function sqlStatuses(pages: PageRecord[]): Promise<string[]> {
    const values = pages.map(
      (p, i) =>
        sql`(${String(i)}::int, ${p.url}::text, ${p.fetchClass}::text, ${p.statusCode}::int, ${p.robotsMeta}::text, ${p.xRobotsTag}::text, ${p.canonicalHtml}::text, ${p.canonicalHeader}::text)`,
    );
    const result = await db.execute<{ status: string }>(sql`
      select ${INDEXABILITY_STATUS_SQL("p")} as status
      from (values ${sql.join(values, sql`, `)})
        as p(i, url, fetch_class, status_code, robots_meta, x_robots_tag, canonical_html, canonical_header)
      order by p.i`);
    return result.rows.map((r) => r.status);
  }

  it("returns what indexabilityOf returns, row for row", async () => {
    const pages = ROWS.map((r) => stamped(r.over));
    const said = await sqlStatuses(pages);
    expect(said).toHaveLength(ROWS.length);
    ROWS.forEach((r, i) => {
      expect(said[i], r.why).toBe(indexabilityOf(pages[i]!).status);
    });
  });

  it("covers every status but the empty one, and every fetch class", () => {
    const pages = ROWS.map((r) => stamped(r.over));
    const seen = new Set<IndexabilityStatus>(pages.map((p) => indexabilityOf(p).status));
    for (const status of [
      "Noindex",
      "Canonicalised",
      "Redirected",
      "Client Error",
      "Server Error",
      "Blocked by robots.txt",
      "Excluded by crawl settings",
      "Blocked by bot protection",
      "No Response",
      "Not HTML",
    ] satisfies IndexabilityStatus[]) {
      expect(seen.has(status), status).toBe(true);
    }
    expect(seen.has("")).toBe(true);
    expect(new Set(pages.map((p) => p.fetchClass))).toEqual(new Set(FETCH_CLASSES));
  });

  it("errors loudly on a fetch_class it has never met, as indexabilityOf does", async () => {
    const odd = { ...mkPage({}), fetchClass: "mystery" } as unknown as PageRecord;
    expect(() => indexabilityOf(odd)).toThrow(/unknown fetch_class 'mystery'/);
    await expect(sqlStatuses([odd])).rejects.toThrow(/mystery/);
  });

  it("abstains only toward Indexable where it cannot resolve a canonical", async () => {
    // A relative canonical: SQL has no base URL (CANONICALISED_ELSEWHERE's
    // documented abstention), so the page counts as indexable rather than
    // being silenced.
    const page = stamped({ canonicalHtml: "/other" });
    expect(indexabilityOf(page).status).toBe("Canonicalised");
    expect(await sqlStatuses([page])).toEqual([""]);
  });
});

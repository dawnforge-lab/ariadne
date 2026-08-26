/**
 * The redirect graph rules, against a real database.
 *
 * Rows are inserted directly rather than crawled: the shapes these rules exist
 * for — a loop with no entry point, a chain that runs past the hop cap — are
 * awkward or slow to serve over HTTP, and what is under test here is the walk,
 * not the crawler. The fixture harness is where the two meet.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { MAX_REDIRECT_HOPS, redirectRules } from "../../src/rules/query/redirects.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://redirects.example";

const byId = new Map(redirectRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in redirectRules`);
  return r;
}

describe("redirectRules metadata", () => {
  it("defines exactly the two redirect rules of the Phase 3 table", () => {
    expect(redirectRules.map((r) => r.id).sort()).toEqual(["redirect.chain", "redirect.loop"]);
  });

  it("claims CHECK-10 with the severities the table assigns", () => {
    expect(
      Object.fromEntries(redirectRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "redirect.chain": [["CHECK-10"], "warning", "redirects"],
      "redirect.loop": [["CHECK-10"], "critical", "redirects"],
    });
  });

  it("every rule is a query rule carrying copy and a ruleset version", () => {
    for (const r of redirectRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });
});

describe("redirectRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ id, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    createdCrawls.push(id);
    return id;
  }

  /** A redirect page: `path` 301s to `to` (a path on the same site). */
  function hop(path: string, to: string): PageSpec {
    return { path, fetchClass: "redirect", statusCode: 301, redirectUrl: `${SITE}${to}` };
  }
  /** A page that answers for itself. */
  function ok(path: string, statusCode = 200): PageSpec {
    return { path, fetchClass: statusCode === 200 ? "ok" : "client_error", statusCode };
  }

  interface PageSpec {
    path: string;
    fetchClass: string;
    statusCode: number;
    redirectUrl?: string;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`.toLowerCase().replace(/\/$/, ""),
      fetchClass: s.fetchClass,
      statusCode: s.statusCode,
      redirectUrl: s.redirectUrl ?? null,
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  const url = (path: string): string => `${SITE}${path}`;

  async function findings(id: string, crawlId: string): Promise<Finding[]> {
    return rule(id).run(db, crawlId);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("neither rule fires on a crawl with no redirects at all", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [ok("/a"), ok("/b")]);
    for (const r of redirectRules) expect(await r.run(db, crawlId), r.id).toHaveLength(0);
  });

  describe("redirect.chain", () => {
    it("reports a three-hop chain once, at its head, with the walked URLs in order", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [hop("/a", "/b"), hop("/b", "/c"), ok("/c")]);

      const found = await findings("redirect.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "redirect.chain",
        pageId: ids.get("/a"),
        pageUrl: url("/a"),
        severity: "warning",
        dedupeKey: url("/a"),
      });
      expect(found[0]!.evidence).toEqual({
        chain: [url("/a"), url("/b"), url("/c")],
        length: 2,
        finalStatus: 200,
        truncated: false,
      });
      expect(await findings("redirect.loop", crawlId)).toHaveLength(0);
    });

    // One hop is a redirect, not a chain: the trailing-slash pattern every CMS
    // ships (/x 301s to /x/) would otherwise be reported on every page.
    it("is silent on a single redirect that lands straight on a 200", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [hop("/one", "/two"), ok("/two")]);
      expect(await findings("redirect.chain", crawlId)).toHaveLength(0);
    });

    it("reports the final status when the chain ends on an error page", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [hop("/e1", "/e2"), hop("/e2", "/gone"), ok("/gone", 404)]);

      const found = await findings("redirect.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ finalStatus: 404, length: 2 });
    });

    // The last hop's target was never crawled, so there is no page row for it.
    // It is still a hop, and naming it is the whole value of the evidence.
    it("carries an uncrawled tail into the chain, with no final status to report", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [hop("/u1", "/u2"), hop("/u2", "/never-crawled")]);

      const found = await findings("redirect.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        chain: [url("/u1"), url("/u2"), url("/never-crawled")],
        length: 2,
        finalStatus: null,
        truncated: false,
      });
    });

    it("stops at the hop cap and says the chain was truncated", async () => {
      const crawlId = await newCrawl();
      const specs: PageSpec[] = [];
      const total = MAX_REDIRECT_HOPS + 3;
      for (let i = 0; i < total; i += 1) specs.push(hop(`/deep-${i}`, `/deep-${i + 1}`));
      specs.push(ok(`/deep-${total}`));
      await addPages(crawlId, specs);

      // One finding, at the real head. The hops past the cap are not a second
      // chain starting at hop eleven, and must not be reported as one.
      const found = await findings("redirect.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageUrl).toBe(url("/deep-0"));
      expect(found[0]!.evidence).toMatchObject({
        length: MAX_REDIRECT_HOPS,
        truncated: true,
        finalStatus: null,
      });
      // The walked hops plus the one the cap stopped us following.
      expect(found[0]!.evidence.chain).toHaveLength(MAX_REDIRECT_HOPS + 1);
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      await addPages(other, [hop("/x", "/y"), hop("/y", "/z"), ok("/z")]);
      const mine = await newCrawl();
      await addPages(mine, [ok("/clean")]);

      expect(await findings("redirect.chain", mine)).toHaveLength(0);
      expect(await findings("redirect.chain", other)).toHaveLength(1);
    });
  });

  describe("redirect.loop", () => {
    it("reports a cycle reached from a head, and reports it as a loop, not a chain", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [hop("/f", "/d"), hop("/d", "/e"), hop("/e", "/d")]);

      const found = await findings("redirect.loop", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "redirect.loop",
        severity: "critical",
        // The finding belongs to the first URL inside the cycle, not to the
        // head that merely points into it.
        pageId: ids.get("/d"),
        pageUrl: url("/d"),
      });
      expect(found[0]!.evidence).toEqual({ cycle: [url("/d"), url("/e"), url("/d")] });

      // A walk that ends in a cycle is a loop, and only a loop: reporting it as
      // a chain as well would double-bill the same broken path.
      expect(await findings("redirect.chain", crawlId)).toHaveLength(0);
    });

    // The regression that matters: nothing outside the pair points at either
    // member, so neither is a chain head and the head walk never visits them.
    it("finds a headless two-page cycle, once", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [hop("/g", "/h"), hop("/h", "/g")]);

      const found = await findings("redirect.loop", crawlId);
      expect(found).toHaveLength(1);
      const cycle = found[0]!.evidence.cycle as string[];
      expect(new Set(cycle)).toEqual(new Set([url("/g"), url("/h")]));
      expect([ids.get("/g"), ids.get("/h")]).toContain(found[0]!.pageId);
      expect(await findings("redirect.chain", crawlId)).toHaveLength(0);
    });

    it("finds a page that redirects to itself", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [hop("/self", "/self")]);

      const found = await findings("redirect.loop", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageId).toBe(ids.get("/self"));
      expect(found[0]!.evidence).toEqual({ cycle: [url("/self"), url("/self")] });
    });

    // Two heads feeding one cycle is one broken loop, not two.
    it("reports one finding per cycle however many heads reach it", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        hop("/head-1", "/m"),
        hop("/head-2", "/n"),
        hop("/m", "/n"),
        hop("/n", "/m"),
      ]);

      const found = await findings("redirect.loop", crawlId);
      expect(found).toHaveLength(1);
      expect(new Set(found[0]!.evidence.cycle as string[])).toEqual(
        new Set([url("/m"), url("/n")]),
      );
    });

    it("keys different cycles apart", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        hop("/p", "/q"),
        hop("/q", "/p"),
        hop("/r", "/s"),
        hop("/s", "/r"),
      ]);

      const found = await findings("redirect.loop", crawlId);
      expect(found).toHaveLength(2);
      expect(new Set(found.map((f) => f.dedupeKey)).size).toBe(2);
    });
  });
});

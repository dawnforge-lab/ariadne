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
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { MAX_REDIRECT_HOPS, redirectRules } from "../../src/rules/query/redirects.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { normalised } from "./mk-page.js";

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
      // The published `Location` and the spelling the walk joins on, exactly as
      // `PageWriter` stores the pair.
      redirectUrlNormalised: s.redirectUrl === undefined ? null : normalised(s.redirectUrl),
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
        chainTruncated: false,
      });
      expect(await findings("redirect.loop", crawlId)).toHaveLength(0);
    });

    // A `Location` may carry a fragment, or spell its query string in another
    // order, and the crawler normalises it before fetching — so the page row
    // for the target is keyed without the fragment and with the parameters
    // sorted. The walk follows `redirect_url_normalised`, which is the same
    // spelling, so the chain continues through the hop instead of stopping
    // dead at a URL nothing matches and reading as a two-page path.
    it("walks through a Location carrying a fragment and unsorted parameters", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/f1", fetchClass: "redirect", statusCode: 301, redirectUrl: url("/f2#top") },
        {
          path: "/f2",
          fetchClass: "redirect",
          statusCode: 301,
          redirectUrl: url("/f3?b=2&a=1"),
        },
        ok("/f3?a=1&b=2"),
      ]);

      const found = await findings("redirect.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({ pageId: ids.get("/f1"), pageUrl: url("/f1") });
      expect(found[0]!.evidence).toEqual({
        chain: [url("/f1"), url("/f2"), url("/f3?a=1&b=2")],
        length: 2,
        finalStatus: 200,
        chainTruncated: false,
      });
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
        chainTruncated: false,
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
        chainTruncated: true,
        finalStatus: null,
      });
      // The walked hops plus the one the cap stopped us following.
      expect(found[0]!.evidence.chain).toHaveLength(MAX_REDIRECT_HOPS + 1);
    });

    // A migration that chained every old URL through an intermediate hop makes
    // O(pages) chains, so the findings list is capped like every other
    // URL-scoped rule's. The walk itself still visits every head, so the count
    // behind the cap is exact.
    it("caps the findings and says how many chains there really are", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 1;
      const specs: PageSpec[] = [];
      for (let i = 0; i < total; i += 1) {
        const n = String(i).padStart(4, "0");
        specs.push(hop(`/c-${n}-head`, `/c-${n}-mid`), hop(`/c-${n}-mid`, `/c-${n}-end`));
        specs.push(ok(`/c-${n}-end`));
      }
      await addPages(crawlId, specs);

      const found = await findings("redirect.chain", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      // WHICH two hundred is not left to the query plan: the walk is ordered by
      // head, so the cap takes the first heads in URL order. Without this the
      // same crawl re-judged would append a different arbitrary two hundred and
      // the issues table would grow past the cap run over run.
      const heads = Array.from({ length: total }, (_, i) =>
        url(`/c-${String(i).padStart(4, "0")}-head`),
      ).sort();
      expect(found.map((f) => f.pageUrl)).toEqual(heads.slice(0, URL_FINDING_CAP));
      // And re-running it lists exactly the same ones.
      const again = await findings("redirect.chain", crawlId);
      expect(again.map((f) => f.pageUrl)).toEqual(found.map((f) => f.pageUrl));
      // The truncation note and the chain's own hop-cap flag are different
      // facts and now have different names: this list was cut short, these
      // chains were not.
      expect(found[found.length - 1]!.evidence).toMatchObject({
        chainTruncated: false,
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
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

    // The walk stops one step short of taking the edge that closes the loop, so
    // the row comes back with `is_cycle` false and a target that is already in
    // the chain. Without the closing test this is a truncated chain — a warning
    // where the truth is that nobody can reach the content at all.
    it("finds a cycle that closes exactly at the hop cap", async () => {
      const crawlId = await newCrawl();
      // Three hops in, then a seven-page ring: ten pages, the cap exactly.
      const specs: PageSpec[] = [];
      for (let i = 0; i < MAX_REDIRECT_HOPS - 1; i += 1) {
        specs.push(hop(`/c-${i}`, `/c-${i + 1}`));
      }
      specs.push(hop(`/c-${MAX_REDIRECT_HOPS - 1}`, "/c-3"));
      await addPages(crawlId, specs);

      const loops = await findings("redirect.loop", crawlId);
      expect(loops).toHaveLength(1);
      expect(loops[0]!.severity).toBe("critical");
      expect(loops[0]!.pageUrl).toBe(url("/c-3"));
      expect(loops[0]!.evidence.cycle).toEqual([
        url("/c-3"), url("/c-4"), url("/c-5"), url("/c-6"),
        url("/c-7"), url("/c-8"), url("/c-9"), url("/c-3"),
      ]);
      // And it is not also billed as a chain.
      expect(await findings("redirect.chain", crawlId)).toHaveLength(0);
    });

    // A ring with more members than the cap cannot be closed by any walk, so
    // the engine cannot call it a loop. What it must not do is say nothing: the
    // seeds are reported as truncated chains, deduped by coverage.
    it("reports a ring longer than the hop cap as unresolved rather than dropping it", async () => {
      const crawlId = await newCrawl();
      const ring = MAX_REDIRECT_HOPS + 2;
      const name = (i: number): string => `/ring-${String(i % ring).padStart(2, "0")}`;
      await addPages(
        crawlId,
        Array.from({ length: ring }, (_, i) => hop(name(i), name(i + 1))),
      );

      // No walk can close a 12-member ring in 10 hops, so there is no loop to
      // claim — but the paths are visible, not silently discarded.
      expect(await findings("redirect.loop", crawlId)).toHaveLength(0);
      const chains = await findings("redirect.chain", crawlId);
      // Two 10-hop windows cover the twelve members: the first seed in URL
      // order, then the first member its window did not reach.
      expect(chains).toHaveLength(2);
      for (const f of chains) {
        expect(f.evidence.chainTruncated).toBe(true);
        expect(f.evidence.length).toBe(MAX_REDIRECT_HOPS);
        expect(f.evidence.finalStatus).toBeNull();
      }
      expect(chains.map((f) => f.pageUrl)).toEqual([url("/ring-00"), url("/ring-10")]);
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

    // The same cap as the chain scan, over the other accumulator: distinct
    // cycles are still counted whole, only the listing stops.
    it("caps the findings and says how many distinct loops there really are", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 1;
      const specs: PageSpec[] = [];
      for (let i = 0; i < total; i += 1) {
        const n = String(i).padStart(4, "0");
        specs.push(hop(`/l-${n}-a`, `/l-${n}-b`), hop(`/l-${n}-b`, `/l-${n}-a`));
      }
      await addPages(crawlId, specs);

      const found = await findings("redirect.loop", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      // Ordered by head like the chain scan, so the cap keeps the first cycles
      // in URL order — each reported at its own lexically first member, which
      // is the `-a` page of the pair.
      const first = Array.from({ length: total }, (_, i) =>
        url(`/l-${String(i).padStart(4, "0")}-a`),
      ).sort();
      expect(found.map((f) => f.pageUrl)).toEqual(first.slice(0, URL_FINDING_CAP));
      const again = await findings("redirect.loop", crawlId);
      expect(again.map((f) => f.pageUrl)).toEqual(found.map((f) => f.pageUrl));
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
    });
  });
});

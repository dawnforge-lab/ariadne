/**
 * The rel=next / rel=prev rules, against a real database.
 *
 * Rows are inserted directly (the link-targets pattern). `rel_next` is stored
 * verbatim — the analyzer keeps the attribute as authored — so resolving it
 * against the page URL is the rules' own job, and these tests declare relative
 * and absolute forms of the same target to pin that.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { PAGINATION_BATCH, paginationRules } from "../../src/rules/query/pagination.js";
import { PAGINATION_WALK_MAX } from "../../src/rules/thresholds.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://paginated.example";

const byId = new Map(paginationRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in paginationRules`);
  return r;
}

describe("paginationRules metadata", () => {
  it("defines exactly the six pagination rules: the Phase 3 three and Phase 26a's three", () => {
    expect(paginationRules.map((r) => r.id).sort()).toEqual([
      "pagination.canonical-to-other",
      "pagination.loop",
      "pagination.next-not-linked",
      "pagination.next-target-uncrawled",
      "pagination.non-indexable-target",
      "pagination.sequence-error",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(paginationRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "pagination.next-target-uncrawled": [["CHECK-22"], "info", "url"],
      "pagination.next-not-linked": [["CHECK-22"], "warning", "url"],
      "pagination.canonical-to-other": [["CHECK-23"], "info", "url"],
      "pagination.non-indexable-target": [["CHECK-22", "CHECK-23"], "warning", "url"],
      "pagination.loop": [["CHECK-22"], "warning", "url"],
      "pagination.sequence-error": [["CHECK-22"], "info", "url"],
    });
  });

  it("every rule is a query rule carrying copy and a ruleset version", () => {
    for (const r of paginationRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });
});

describe("paginationRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    /** Pins the row id, for a test that needs two pages in different batches. */
    id?: string;
    canonicalHtml?: string;
    relNext?: string;
    relPrev?: string;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ id, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: s.id ?? `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`.toLowerCase().replace(/\/$/, ""),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      canonicalHtml: s.canonicalHtml ?? null,
      isIndexable: writerIndexable(s),
      robotsMeta: s.robotsMeta ?? null,
      xRobotsTag: s.xRobotsTag ?? null,
      relNext: s.relNext ?? null,
      relPrev: s.relPrev ?? null,
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLink(crawlId: string, fromId: string, targetPath: string): Promise<void> {
    await db.insert(links).values({
      crawlId,
      sourcePageId: fromId,
      targetUrl: `${SITE}${targetPath}`,
      targetPageId: null,
      anchor: "next page",
      rel: null,
      isInternal: true,
      isNofollow: false,
      position: 0,
    });
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

  // The series every rule here is measured against: page 1 links to page 2,
  // both are crawled, and page 2 canonicalises to itself.
  it("no rule fires on a healthy, self-canonical, linked series", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/blog", canonicalHtml: url("/blog"), relNext: "/blog?page=2" },
      {
        path: "/blog?page=2",
        canonicalHtml: url("/blog?page=2"),
        relPrev: "/blog",
      },
    ]);
    await addLink(crawlId, ids.get("/blog")!, "/blog?page=2");

    for (const r of paginationRules) expect(await r.run(db, crawlId), r.id).toHaveLength(0);
  });

  it("no rule fires on a crawl with no rel=next or rel=prev at all", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/plain", canonicalHtml: url("/other") }]);

    for (const r of paginationRules) expect(await r.run(db, crawlId), r.id).toHaveLength(0);
  });

  describe("pagination.next-target-uncrawled", () => {
    it("fires when the resolved rel=next names a URL with no pages row", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/blog", canonicalHtml: url("/blog"), relNext: "/blog?page=2" },
      ]);

      const found = await findings("pagination.next-target-uncrawled", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "pagination.next-target-uncrawled",
        severity: "info",
        pageId: ids.get("/blog"),
        pageUrl: url("/blog"),
        dedupeKey: url("/blog"),
      });
      // The declaration verbatim, with what it resolved to beside it.
      expect(found[0]!.evidence).toEqual({
        relNext: "/blog?page=2",
        resolvedTo: url("/blog?page=2"),
      });

      // Nothing to say about linking: there is no target page to look for
      // inbound links to.
      expect(await findings("pagination.next-not-linked", crawlId)).toHaveLength(0);
    });

    it("resolves rel=next against the page URL, absolute or relative", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/rel", relNext: "/rel/2" },
        { path: "/abs", relNext: url("/abs/2") },
        { path: "/rel/2" },
        { path: "/abs/2" },
      ]);
      // Both targets exist, so the uncrawled rule is silent for both — which is
      // only true if the relative form resolved.
      expect(await findings("pagination.next-target-uncrawled", crawlId)).toHaveLength(0);
    });

    // A rel=next we cannot turn into a URL at all has no page row either, and
    // dropping it would be a declaration the engine read and said nothing
    // about. It is reported here, flagged for what it is.
    it("reports an unresolvable rel=next as unparseable rather than dropping it", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/broken-next", relNext: "javascript:void(0)" }]);

      const found = await findings("pagination.next-target-uncrawled", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        relNext: "javascript:void(0)",
        resolvedTo: null,
        unparseable: true,
      });
    });

    // Both halves of the batched scan's contract: it reads past the first
    // batch (the exact count proves it), and it stops *listing* at the
    // findings cap — a paginated archive is O(pages) rel=next declarations,
    // and a crawl that stops short of the series' end fires on every one of
    // them.
    it("walks every page, not just the first batch, and caps what it lists", async () => {
      const crawlId = await newCrawl();
      const total = PAGINATION_BATCH + 5;
      await addPages(
        crawlId,
        Array.from({ length: total }, (_, i) => ({
          path: `/p-${String(i).padStart(4, "0")}`,
          relNext: `/never-crawled-${String(i).padStart(4, "0")}`,
        })),
      );

      const found = await findings("pagination.next-target-uncrawled", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      await addPages(other, [{ path: "/blog", relNext: "/blog?page=2" }]);

      const mine = await newCrawl();
      await addPages(mine, [{ path: "/blog", relNext: "/blog?page=2" }, { path: "/blog?page=2" }]);

      expect(await findings("pagination.next-target-uncrawled", mine)).toHaveLength(0);
      expect(await findings("pagination.next-target-uncrawled", other)).toHaveLength(1);
    });
  });

  describe("pagination.next-not-linked", () => {
    it("fires when the crawled rel=next target has no inbound link rows", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/blog", canonicalHtml: url("/blog"), relNext: "/blog?page=2" },
        { path: "/blog?page=2", canonicalHtml: url("/blog?page=2"), relPrev: "/blog" },
      ]);

      const found = await findings("pagination.next-not-linked", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "pagination.next-not-linked",
        severity: "warning",
        // The finding belongs to the page that declared the rel=next, which is
        // where the missing link would have to be added.
        pageId: ids.get("/blog"),
        pageUrl: url("/blog"),
        dedupeKey: url("/blog"),
      });
      expect(found[0]!.evidence).toEqual({
        relNext: "/blog?page=2",
        resolvedTo: url("/blog?page=2"),
      });

      // The target was crawled, so the other rule has nothing to say.
      expect(await findings("pagination.next-target-uncrawled", crawlId)).toHaveLength(0);
    });

    // A paginated page renders the whole pagination control, current page
    // included, so page 2 almost always carries an anchor to page 2. Counting
    // that as an inbound link would answer "can a reader reach page 2?" with a
    // link only a reader already on page 2 can see — and would silence the rule
    // on exactly the sites it exists for.
    it("fires when the target's only inbound link is its own", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/blog", relNext: "/blog?page=2" },
        { path: "/blog?page=2", relPrev: "/blog" },
      ]);
      await addLink(crawlId, ids.get("/blog?page=2")!, "/blog?page=2");

      const found = await findings("pagination.next-not-linked", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/blog")]);
    });

    it("is silent once any page links to the target", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/blog", relNext: "/blog?page=2" },
        { path: "/blog?page=2" },
        { path: "/elsewhere" },
      ]);
      await addLink(crawlId, ids.get("/elsewhere")!, "/blog?page=2");

      expect(await findings("pagination.next-not-linked", crawlId)).toHaveLength(0);
    });
  });

  describe("pagination.canonical-to-other", () => {
    it("fires on a page 2+ whose canonical points at another URL", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/blog", canonicalHtml: url("/blog") },
        { path: "/blog?page=2", canonicalHtml: "/blog", relPrev: "/blog" },
      ]);
      await addLink(crawlId, ids.get("/blog")!, "/blog?page=2");

      const found = await findings("pagination.canonical-to-other", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "pagination.canonical-to-other",
        severity: "info",
        pageId: ids.get("/blog?page=2"),
        pageUrl: url("/blog?page=2"),
        dedupeKey: url("/blog?page=2"),
      });
      expect(found[0]!.evidence).toEqual({
        canonical: "/blog",
        resolvedTo: url("/blog"),
        relPrev: "/blog",
      });
    });

    // Either strategy is defensible and the agent judges which; a paginated
    // page that canonicalises to itself is the other one, and it fires nothing.
    it("is silent on a self-canonical page 2", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/blog?page=2", canonicalHtml: url("/blog?page=2"), relPrev: "/blog" },
      ]);

      expect(await findings("pagination.canonical-to-other", crawlId)).toHaveLength(0);
    });

    // Page 1 of a series has no rel=prev. Its canonical pointing elsewhere is
    // `canonical.points-elsewhere`'s business, not a pagination finding.
    it("is silent on a page with no rel=prev, however its canonical points", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/blog", canonicalHtml: url("/somewhere-else") }]);

      expect(await findings("pagination.canonical-to-other", crawlId)).toHaveLength(0);
    });

    it("is silent when the page declares no canonical at all", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/blog?page=2", relPrev: "/blog" }]);

      expect(await findings("pagination.canonical-to-other", crawlId)).toHaveLength(0);
    });
  });

  describe("pagination.non-indexable-target", () => {
    it("fires on a rel=next that resolves to a crawled 404", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/blog", relNext: "/blog?page=2" },
        { path: "/blog?page=2", fetchClass: "client_error", statusCode: 404 },
      ]);

      const found = await findings("pagination.non-indexable-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "pagination.non-indexable-target",
        severity: "warning",
        pageId: ids.get("/blog"),
        pageUrl: url("/blog"),
        dedupeKey: `${url("/blog")}\nnext`,
      });
      expect(found[0]!.evidence).toEqual({
        rel: "next",
        target: url("/blog?page=2"),
        targetStatus: 404,
        targetNoindex: false,
      });
    });

    it("fires on a rel=next at a 200 page that says noindex", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/blog", relNext: "/blog?page=2" },
        { path: "/blog?page=2", robotsMeta: "noindex, follow", relPrev: "/blog" },
      ]);

      const found = await findings("pagination.non-indexable-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        rel: "next",
        target: url("/blog?page=2"),
        targetStatus: 200,
        targetNoindex: true,
      });
    });

    it("reads rel=prev too, and reports next and prev as two findings of one page", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/blog?page=1", xRobotsTag: "noindex" },
        { path: "/blog?page=2", relPrev: "/blog?page=1", relNext: "/blog?page=3" },
        { path: "/blog?page=3", fetchClass: "server_error", statusCode: 500 },
      ]);

      const found = await findings("pagination.non-indexable-target", crawlId);
      expect(found).toHaveLength(2);
      expect(
        found.map((f) => [f.pageUrl, f.dedupeKey, (f.evidence as { rel: string }).rel]).sort(),
      ).toEqual([
        [url("/blog?page=2"), `${url("/blog?page=2")}\nnext`, "next"],
        [url("/blog?page=2"), `${url("/blog?page=2")}\nprev`, "prev"],
      ]);
    });

    it("leaves uncrawled and robots-blocked targets to next-target-uncrawled", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", relNext: "/never-crawled" },
        { path: "/b", relNext: "/blocked" },
      ]);
      await db.insert(pages).values({
        id: `page_${randomUUID()}`,
        crawlId,
        url: url("/blocked"),
        urlNormalised: url("/blocked"),
        fetchClass: "disallowed",
        fetchReason: "robots.txt: Disallow: /blocked",
        statusCode: null,
        depth: 1,
        discoveredVia: "link",
      });

      expect(await findings("pagination.non-indexable-target", crawlId)).toHaveLength(0);
    });

    it("is silent on a healthy series", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/blog", relNext: "/blog?page=2" },
        { path: "/blog?page=2", relPrev: "/blog" },
      ]);
      expect(await findings("pagination.non-indexable-target", crawlId)).toHaveLength(0);
    });
  });

  describe("pagination.loop", () => {
    const ring = (n: number, prefix = "/loop"): PageSpec[] =>
      Array.from({ length: n }, (_, i) => ({
        path: `${prefix}-${i + 1}`,
        relNext: `${prefix}-${((i + 1) % n) + 1}`,
      }));

    // Review Focus 4: terminates, and reports each member once.
    it("reports a 3-cycle once per member page, with one cycle shared by all", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, ring(3));

      const found = await findings("pagination.loop", crawlId);
      expect(found).toHaveLength(3);
      expect(found.map((f) => f.pageUrl).sort()).toEqual([
        url("/loop-1"),
        url("/loop-2"),
        url("/loop-3"),
      ]);
      for (const f of found) {
        expect(f).toMatchObject({
          ruleId: "pagination.loop",
          severity: "warning",
          pageId: ids.get(f.pageUrl!.slice(SITE.length)),
          dedupeKey: f.pageUrl,
        });
        const { cycle, cycleLength } = f.evidence as { cycle: string[]; cycleLength: number };
        expect([...cycle].sort()).toEqual([url("/loop-1"), url("/loop-2"), url("/loop-3")]);
        expect(cycleLength).toBe(3);
        // Walk order, from the page itself.
        expect(cycle[0]).toBe(f.pageUrl);
      }
      const loop1 = found.find((f) => f.pageUrl === url("/loop-1"))!;
      expect((loop1.evidence as { cycle: string[] }).cycle).toEqual([
        url("/loop-1"),
        url("/loop-2"),
        url("/loop-3"),
      ]);
    });

    it("reports a page whose rel=next names itself", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/self", relNext: "/self" }]);
      const found = await findings("pagination.loop", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({ cycle: [url("/self")], cycleLength: 1 });
    });

    it("reports the members of a loop and not the pages that lead into it", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/lead", relNext: "/loop-1" }, ...ring(3)]);
      const found = await findings("pagination.loop", crawlId);
      expect(found.map((f) => f.pageUrl).sort()).toEqual([
        url("/loop-1"),
        url("/loop-2"),
        url("/loop-3"),
      ]);
    });

    it("is silent on a straight series, and on one that ends uncrawled", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/s-1", relNext: "/s-2" },
        { path: "/s-2", relNext: "/s-3", relPrev: "/s-1" },
        { path: "/s-3", relNext: "/s-4", relPrev: "/s-2" },
      ]);
      expect(await findings("pagination.loop", crawlId)).toHaveLength(0);
    });

    // The edge set the walk reads covers the whole crawl, so a cycle whose
    // members fall in different batches is still found.
    it("finds a cycle whose members sit in different batches", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        ...Array.from({ length: PAGINATION_BATCH + 5 }, (_, i) => ({
          path: `/fill-${String(i).padStart(4, "0")}`,
          relNext: `/fill-never-${i}`,
        })),
        { id: "page_00-first", path: "/far-1", relNext: "/far-2" },
        { id: "page_8-middle", path: "/far-2", relNext: "/far-3" },
        { id: "page_zz-last", path: "/far-3", relNext: "/far-1" },
      ]);
      const found = await findings("pagination.loop", crawlId);
      expect(found.map((f) => f.pageUrl).sort()).toEqual([
        url("/far-1"),
        url("/far-2"),
        url("/far-3"),
      ]);
    });

    it("quotes at most 20 urls, the same 20 on every member, with the true length", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, ring(25));
      const found = await findings("pagination.loop", crawlId);
      expect(found).toHaveLength(25);
      const sets = new Set(
        found.map((f) => JSON.stringify([...(f.evidence as { cycle: string[] }).cycle].sort())),
      );
      expect(sets.size).toBe(1);
      for (const f of found) {
        const e = f.evidence as { cycle: string[]; cycleLength: number };
        expect(e.cycle).toHaveLength(20);
        expect(e.cycleLength).toBe(25);
      }
    });

    it("lists at most the cap and notes the exact total", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, ring(3));
      const found = await rule("pagination.loop").run(db, crawlId, { listing: 2 });
      expect(found).toHaveLength(2);
      expect(found[1]!.evidence).toMatchObject({ truncated: { reported: 2, total: 3 } });
    });

    it("does not recognise a cycle longer than the walk limit", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, ring(PAGINATION_WALK_MAX + 2));
      expect(await findings("pagination.loop", crawlId)).toHaveLength(0);
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      await addPages(other, ring(3));
      const mine = await newCrawl();
      await addPages(mine, [{ path: "/loop-1", relNext: "/loop-2" }, { path: "/loop-2" }]);
      expect(await findings("pagination.loop", mine)).toHaveLength(0);
      expect(await findings("pagination.loop", other)).toHaveLength(3);
    });

    it("two runs at once do not see each other's edges", async () => {
      const a = await newCrawl();
      await addPages(a, ring(3));
      const b = await newCrawl();
      await addPages(b, ring(4));
      const [fa, fb] = await Promise.all([
        findings("pagination.loop", a),
        findings("pagination.loop", b),
      ]);
      expect([fa.length, fb.length]).toEqual([3, 4]);
    });
  });

  describe("pagination.sequence-error", () => {
    it("is silent on a straight 3-page series with correct prevs", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/s-1", relNext: "/s-2" },
        { path: "/s-2", relNext: "/s-3", relPrev: "/s-1" },
        { path: "/s-3", relPrev: url("/s-2") },
      ]);
      expect(await findings("pagination.sequence-error", crawlId)).toHaveLength(0);
    });

    it("fires on page 1 when page 2 has no rel=prev", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/s-1", relNext: "/s-2" },
        { path: "/s-2", relNext: "/s-3" },
        { path: "/s-3", relPrev: "/s-2" },
      ]);
      const found = await findings("pagination.sequence-error", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "pagination.sequence-error",
        severity: "info",
        pageId: ids.get("/s-1"),
        pageUrl: url("/s-1"),
        dedupeKey: url("/s-1"),
      });
      expect(found[0]!.evidence).toEqual({ next: url("/s-2"), nextsPrev: null });
    });

    it("fires when the next page's rel=prev names a different page, quoted as authored", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/s-1", relNext: "/s-2" },
        { path: "/s-2", relPrev: "/elsewhere" },
      ]);
      const found = await findings("pagination.sequence-error", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({ next: url("/s-2"), nextsPrev: "/elsewhere" });
    });

    it("fires when the next page's rel=prev will not resolve", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/s-1", relNext: "/s-2" },
        { path: "/s-2", relPrev: "javascript:void(0)" },
      ]);
      expect(await findings("pagination.sequence-error", crawlId)).toHaveLength(1);
    });

    it("leaves an uncrawled or non-200 next page to the other rules", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", relNext: "/never-crawled" },
        { path: "/b", relNext: "/gone" },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);
      expect(await findings("pagination.sequence-error", crawlId)).toHaveLength(0);
    });

    it("walks every page, not just the first batch, and caps what it lists", async () => {
      const crawlId = await newCrawl();
      const total = PAGINATION_BATCH + 5;
      const specs: PageSpec[] = [];
      for (let i = 0; i < total; i++) {
        specs.push({ path: `/q-${i}`, relNext: `/r-${i}` }, { path: `/r-${i}` });
      }
      await addPages(crawlId, specs);
      const found = await findings("pagination.sequence-error", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
    });
  });

  // Every rule here reads signals the analyzer only produces for an HTML 200,
  // and is gated the same way the canonical and on-page rules are.
  it("no rule speaks for a page that is not a 200 OK page", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/dead",
        fetchClass: "client_error",
        statusCode: 404,
        canonicalHtml: url("/blog"),
        relNext: "/never-crawled",
        relPrev: "/blog",
      },
    ]);

    for (const r of paginationRules) expect(await r.run(db, crawlId), r.id).toHaveLength(0);
  });
});

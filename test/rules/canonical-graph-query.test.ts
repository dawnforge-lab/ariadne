/**
 * The canonical-graph rules (`canonical.chain`, `canonical.unlinked`), against
 * a real database.
 *
 * Rows are inserted directly, as in link-targets-query.test.ts: what is under
 * test is what the rules make of the canonical declarations and the link graph
 * the crawler stored. Every test opens its own crawl and the afterAll deletes
 * them, so the suite leaves zero net crawl rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { canonicalGraphRules } from "../../src/rules/query/canonical-graph.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { CANONICAL_BATCH } from "../../src/rules/query/link-targets.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { CANONICAL_MAX_HOPS } from "../../src/rules/thresholds.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://graph.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(canonicalGraphRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in canonicalGraphRules`);
  return r;
}

describe("canonicalGraphRules metadata", () => {
  it("defines exactly the two canonical-graph rules", () => {
    expect(canonicalGraphRules.map((r) => r.id).sort()).toEqual([
      "canonical.chain",
      "canonical.unlinked",
    ]);
  });

  it("claims the checklist ids, severities and category the table assigns", () => {
    expect(
      Object.fromEntries(
        canonicalGraphRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]]),
      ),
    ).toEqual({
      "canonical.chain": [["CHECK-17", "CHECK-19"], "warning", "canonical"],
      "canonical.unlinked": [["CHECK-17"], "info", "canonical"],
    });
  });

  it("every rule is a query rule carrying copy and a ruleset version", () => {
    for (const r of canonicalGraphRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("pins the hop limit the copy and the walk share", () => {
    expect(CANONICAL_MAX_HOPS).toBe(10);
  });
});

describe("canonicalGraphRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    canonicalHtml?: string;
    canonicalHeader?: string;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ tenantId: LOCAL_TENANT, id, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path).toLowerCase().replace(/\/$/, ""),
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      canonicalHtml: s.canonicalHtml ?? null,
      canonicalHeader: s.canonicalHeader ?? null,
      isIndexable: writerIndexable(s),
      robotsMeta: s.robotsMeta ?? null,
      xRobotsTag: s.xRobotsTag ?? null,
      depth: 1,
      discoveredVia: "link",
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(pages).values(rows.slice(i, i + 500));
    }
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLink(
    crawlId: string,
    ids: Map<string, string>,
    from: string,
    target: string,
    isInternal = true,
  ): Promise<void> {
    await db.insert(links).values({
      crawlId,
      sourcePageId: ids.get(from)!,
      targetUrl: target.startsWith("http") ? target : url(target),
      targetPageId: null,
      anchor: "read this",
      rel: null,
      isInternal,
      isNofollow: false,
      position: 0,
    });
  }

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

  it("neither rule fires on a clean, self-canonical, well-linked crawl", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/a", canonicalHtml: url("/a") },
      { path: "/b", canonicalHtml: url("/b") },
    ]);
    await addLink(crawlId, ids, "/a", "/b");
    for (const r of canonicalGraphRules) expect(await r.run(db, crawlId), r.id).toHaveLength(0);
  });

  describe("canonical.chain", () => {
    it("reports A -> B -> C against A, with the hops starting at the target", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/b") },
        { path: "/b", canonicalHtml: url("/c") },
        { path: "/c", canonicalHtml: url("/c") },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "canonical.chain",
        severity: "warning",
        pageId: ids.get("/a"),
        pageUrl: url("/a"),
        dedupeKey: url("/a"),
      });
      expect(found[0]!.evidence).toEqual({
        canonical: url("/b"),
        hops: [url("/b"), url("/c")],
        loop: false,
      });
    });

    it("resolves relative canonicals before walking: /b -> /c is still a chain", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", canonicalHtml: "/b" },
        { path: "/b", canonicalHtml: "/c" },
        { path: "/c", canonicalHtml: "/c" },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageUrl).toBe(url("/a"));
      // The evidence keeps the value as authored; the hops are resolved URLs.
      expect(found[0]!.evidence).toEqual({
        canonical: "/b",
        hops: [url("/b"), url("/c")],
        loop: false,
      });
    });

    it("sees through a fragment, and reads a header canonical when the HTML has none", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", canonicalHtml: `${url("/b")}#top` },
        { path: "/b", canonicalHeader: url("/c") },
        { path: "/c", canonicalHtml: url("/c") },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/a")]);
      expect(found[0]!.evidence).toMatchObject({ hops: [url("/b"), url("/c")] });
    });

    it("lists a three-step chain from every page that starts one", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/b") },
        { path: "/b", canonicalHtml: url("/c") },
        { path: "/c", canonicalHtml: url("/d") },
        { path: "/d", canonicalHtml: url("/d") },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found.map((f) => [f.pageUrl, f.evidence.hops])).toEqual([
        [url("/a"), [url("/b"), url("/c"), url("/d")]],
        [url("/b"), [url("/c"), url("/d")]],
      ]);
    });

    it("is silent on a single hop, a missing target, and a target that is not a 200 page", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/one", canonicalHtml: url("/one-target") },
        { path: "/one-target", canonicalHtml: url("/one-target") },
        // The target was never crawled.
        { path: "/to-nowhere", canonicalHtml: url("/never-fetched") },
        // The target answered 404; `canonical.non-200-target` owns that.
        { path: "/to-404", canonicalHtml: url("/gone") },
        { path: "/gone", fetchClass: "client_error", statusCode: 404, canonicalHtml: url("/x") },
        // The target redirects.
        { path: "/to-redirect", canonicalHtml: url("/moved") },
        { path: "/moved", fetchClass: "redirect", statusCode: 301, canonicalHtml: url("/x") },
      ]);
      expect(await findings("canonical.chain", crawlId)).toHaveLength(0);
    });

    it("ignores a source that is not a 200 page, and a canonical that does not resolve", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/src404", fetchClass: "client_error", statusCode: 404, canonicalHtml: url("/b") },
        { path: "/junk", canonicalHtml: "http://" },
        { path: "/b", canonicalHtml: url("/c") },
        { path: "/c", canonicalHtml: url("/c") },
      ]);
      expect(await findings("canonical.chain", crawlId)).toHaveLength(0);
    });

    it("stops at a hop that is not a 200 page, does not list it, and names it as the unresolved next URL", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/b") },
        { path: "/b", canonicalHtml: url("/gone") },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        canonical: url("/b"),
        hops: [url("/b")],
        loop: false,
        unresolvedNext: url("/gone"),
      });
    });

    it("names a next URL the crawl never fetched the same way", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/b") },
        { path: "/b", canonicalHtml: url("/never-fetched") },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({
        hops: [url("/b")],
        unresolvedNext: url("/never-fetched"),
      });
    });

    // The accepted limit: a cycle longer than CANONICAL_MAX_HOPS is cut by the
    // cap before it can revisit anything, so it is a long chain, not a loop.
    it("reports a cycle longer than the hop limit as hopLimitReached, not as a loop", async () => {
      const crawlId = await newCrawl();
      const n = CANONICAL_MAX_HOPS + 2;
      const name = (i: number): string => `/c${String(i).padStart(2, "0")}`;
      await addPages(
        crawlId,
        Array.from({ length: n }, (_, i) => ({
          path: name(i),
          canonicalHtml: url(name((i + 1) % n)),
        })),
      );
      const found = await findings("canonical.chain", crawlId);
      expect(found).toHaveLength(n);
      for (const f of found) {
        expect(f.evidence, f.pageUrl ?? "").toMatchObject({ loop: false, hopLimitReached: true });
        expect((f.evidence.hops as string[]).length).toBe(CANONICAL_MAX_HOPS);
      }
    });

    // Review Focus 4: a cycle terminates. Each member is reported once, as a
    // loop, and never as a chain that ran into the hop limit.
    it("reports a three-page loop once per member, as a loop and not a hop-limit chain", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/b") },
        { path: "/b", canonicalHtml: url("/c") },
        { path: "/c", canonicalHtml: url("/a") },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/a"), url("/b"), url("/c")]);
      for (const f of found) {
        expect(f.evidence.loop, f.pageUrl ?? "").toBe(true);
        expect(f.evidence, f.pageUrl ?? "").not.toHaveProperty("hopLimitReached");
      }
      expect(found[0]!.evidence.hops).toEqual([url("/b"), url("/c")]);
    });

    it("reports a two-page loop, and a tail that runs into a loop it is not part of", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", canonicalHtml: url("/b") },
        { path: "/b", canonicalHtml: url("/a") },
        { path: "/tail", canonicalHtml: url("/a") },
      ]);
      const found = await findings("canonical.chain", crawlId);
      expect(found.map((f) => [f.pageUrl, f.evidence.loop])).toEqual([
        [url("/a"), true],
        [url("/b"), true],
        [url("/tail"), true],
      ]);
    });

    it("stops a chain longer than the hop limit at the limit, and says so", async () => {
      const crawlId = await newCrawl();
      // q00 ... q12: thirteen pages, the last self-canonical, so q00 is twelve
      // hops from the end and q02 is exactly CANONICAL_MAX_HOPS.
      const n = CANONICAL_MAX_HOPS + 3;
      const name = (i: number): string => `/q${String(i).padStart(2, "0")}`;
      await addPages(
        crawlId,
        Array.from({ length: n }, (_, i) => ({
          path: name(i),
          canonicalHtml: url(name(Math.min(i + 1, n - 1))),
        })),
      );
      const found = await findings("canonical.chain", crawlId);
      const byUrl = new Map(found.map((f) => [f.pageUrl as string, f.evidence]));

      expect((byUrl.get(url(name(0)))!.hops as string[]).length).toBe(CANONICAL_MAX_HOPS);
      expect(byUrl.get(url(name(0)))).toMatchObject({ loop: false, hopLimitReached: true });
      // q01 is eleven hops from the end: still over the limit.
      expect(byUrl.get(url(name(1)))).toMatchObject({ loop: false, hopLimitReached: true });
      // q02 is exactly ten hops from the end, which the walk completes.
      const complete = byUrl.get(url(name(2)))!;
      expect((complete.hops as string[]).length).toBe(CANONICAL_MAX_HOPS);
      expect(complete.loop).toBe(false);
      expect(complete).not.toHaveProperty("hopLimitReached");
      // Everything that starts a chain is listed: q00 ... q10. q11 points at
      // the self-canonical q12, which is one hop and not a chain.
      expect(found).toHaveLength(n - 2);
    });

    it("walks every page, not just the first batch, and caps what it lists with the exact total", async () => {
      const crawlId = await newCrawl();
      const total = CANONICAL_BATCH + 5;
      const specs: PageSpec[] = [
        { path: "/mid", canonicalHtml: url("/end") },
        { path: "/end", canonicalHtml: url("/end") },
      ];
      for (let i = 0; i < total; i += 1) {
        specs.push({ path: `/p-${String(i).padStart(4, "0")}`, canonicalHtml: url("/mid") });
      }
      await addPages(crawlId, specs);

      const found = await findings("canonical.chain", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
      const again = await findings("canonical.chain", crawlId);
      expect(again.map((f) => f.pageUrl)).toEqual(found.map((f) => f.pageUrl));
    });

    it("lists everything when the crawl asks for no cap", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 3;
      const specs: PageSpec[] = [
        { path: "/mid", canonicalHtml: url("/end") },
        { path: "/end", canonicalHtml: url("/end") },
      ];
      for (let i = 0; i < total; i += 1) {
        specs.push({ path: `/u-${String(i).padStart(4, "0")}`, canonicalHtml: url("/mid") });
      }
      await addPages(crawlId, specs);
      const found = await rule("canonical.chain").run(db, crawlId, {
        listing: null,
      } as Parameters<QueryRule["run"]>[2]);
      expect(found).toHaveLength(total);
      expect(found.some((f) => "truncated" in f.evidence)).toBe(false);
    });
  });

  describe("canonical.unlinked", () => {
    it("fires on the source when its canonical target has no internal inlink", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/dup", canonicalHtml: url("/main") },
        { path: "/main", canonicalHtml: url("/main") },
      ]);
      const found = await findings("canonical.unlinked", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "canonical.unlinked",
        severity: "info",
        pageId: ids.get("/dup"),
        pageUrl: url("/dup"),
        dedupeKey: url("/dup"),
      });
      expect(found[0]!.evidence).toEqual({ canonical: url("/main"), resolvedTo: url("/main") });
    });

    it("is silent when another page links the target", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/dup", canonicalHtml: url("/main") },
        { path: "/main", canonicalHtml: url("/main") },
        { path: "/hub" },
      ]);
      await addLink(crawlId, ids, "/hub", "/main");
      expect(await findings("canonical.unlinked", crawlId)).toHaveLength(0);
    });

    it("counts the canonicalised page's own link to the target as a link", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/dup", canonicalHtml: url("/main") },
        { path: "/main", canonicalHtml: url("/main") },
      ]);
      await addLink(crawlId, ids, "/dup", "/main");
      expect(await findings("canonical.unlinked", crawlId)).toHaveLength(0);
    });

    it("counts a page linked only from itself as unlinked", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/dup", canonicalHtml: url("/main") },
        { path: "/main", canonicalHtml: url("/main") },
      ]);
      await addLink(crawlId, ids, "/main", "/main");
      const found = await findings("canonical.unlinked", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/dup")]);
    });

    it("does not count an external link, or a link to a different URL", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/dup", canonicalHtml: url("/main") },
        { path: "/main", canonicalHtml: url("/main") },
        { path: "/hub" },
      ]);
      await addLink(crawlId, ids, "/hub", "/main", false);
      await addLink(crawlId, ids, "/hub", "/main-2");
      expect(await findings("canonical.unlinked", crawlId)).toHaveLength(1);
    });

    it("resolves a relative canonical, and judges a noindex source (the cohort is auditable, not judged)", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/dup", canonicalHtml: "/main", robotsMeta: "noindex" },
        { path: "/main", canonicalHtml: "/main" },
      ]);
      const found = await findings("canonical.unlinked", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({ canonical: "/main", resolvedTo: url("/main") });
    });

    it("is silent when the target was never crawled, is not a 200 page, or the source is not", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/to-nowhere", canonicalHtml: url("/never-fetched") },
        { path: "/to-404", canonicalHtml: url("/gone") },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
        { path: "/src404", fetchClass: "client_error", statusCode: 404, canonicalHtml: url("/t") },
        { path: "/t", canonicalHtml: url("/t") },
        { path: "/self", canonicalHtml: url("/self") },
        { path: "/junk", canonicalHtml: "http://" },
      ]);
      expect(await findings("canonical.unlinked", crawlId)).toHaveLength(0);
    });

    it("walks every page, not just the first batch, and caps what it lists with the exact total", async () => {
      const crawlId = await newCrawl();
      const total = CANONICAL_BATCH + 5;
      const specs: PageSpec[] = [{ path: "/main", canonicalHtml: url("/main") }];
      for (let i = 0; i < total; i += 1) {
        specs.push({ path: `/p-${String(i).padStart(4, "0")}`, canonicalHtml: url("/main") });
      }
      await addPages(crawlId, specs);

      const found = await findings("canonical.unlinked", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      const again = await findings("canonical.unlinked", crawlId);
      expect(again.map((f) => f.pageUrl)).toEqual(found.map((f) => f.pageUrl));
    });
  });
});

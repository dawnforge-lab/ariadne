/**
 * The link- and canonical-target rules, against a real database.
 *
 * Rows are inserted directly (the hreflang-query pattern): what is under test
 * is what the rules make of the link graph and the canonical declarations the
 * crawler stored, not the crawling.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import {
  CANONICAL_BATCH,
  linkTargetRules,
  SAMPLE_SOURCES,
} from "../../src/rules/query/link-targets.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://targets.example";

const byId = new Map(linkTargetRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in linkTargetRules`);
  return r;
}

describe("linkTargetRules metadata", () => {
  it("defines exactly the three link/canonical target rules of the Phase 3 table", () => {
    expect(linkTargetRules.map((r) => r.id).sort()).toEqual([
      "canonical.non-200-target",
      "canonical.non-indexable-target",
      "links.broken-internal",
    ]);
  });

  it("claims the checklist ids and severities the table assigns", () => {
    expect(
      Object.fromEntries(linkTargetRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "links.broken-internal": [["CHECK-11"], "warning", "links"],
      "canonical.non-200-target": [["CHECK-19"], "warning", "canonical"],
      "canonical.non-indexable-target": [["CHECK-19"], "warning", "canonical"],
    });
  });

  it("every rule is a query rule carrying copy and a ruleset version", () => {
    for (const r of linkTargetRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });
});

describe("linkTargetRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    canonicalHtml?: string;
    canonicalHeader?: string;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ id, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`.toLowerCase().replace(/\/$/, ""),
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
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLinks(
    crawlId: string,
    from: string[],
    ids: Map<string, string>,
    target: string,
    isInternal = true,
  ): Promise<void> {
    await db.insert(links).values(
      from.map((path, i) => ({
        crawlId,
        sourcePageId: ids.get(path)!,
        targetUrl: target.startsWith("http") ? target : `${SITE}${target}`,
        targetPageId: null,
        anchor: "read this",
        rel: null,
        isInternal,
        isNofollow: false,
        position: i,
      })),
    );
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

  it("no rule fires on a clean, self-canonical, well-linked crawl", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/a", canonicalHtml: url("/a") },
      { path: "/b", canonicalHtml: url("/b") },
    ]);
    await addLinks(crawlId, ["/a"], ids, "/b");
    for (const r of linkTargetRules) expect(await r.run(db, crawlId), r.id).toHaveLength(0);
  });

  describe("links.broken-internal", () => {
    it("reports one finding per broken TARGET, counting every inlink to it", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/s1" },
        { path: "/s2" },
        { path: "/s3" },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);
      await addLinks(crawlId, ["/s1", "/s2", "/s3"], ids, "/gone");

      const found = await findings("links.broken-internal", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "links.broken-internal",
        severity: "warning",
        // The finding belongs to the broken target: one fix, one row, however
        // many pages link to it.
        pageId: ids.get("/gone"),
        pageUrl: url("/gone"),
        dedupeKey: url("/gone"),
      });
      expect(found[0]!.evidence).toEqual({
        targetUrl: url("/gone"),
        statusCode: 404,
        inlinkCount: 3,
        sampleSources: [url("/s1"), url("/s2"), url("/s3")],
      });
    });

    it("counts every inlink but samples at most ten sources", async () => {
      const crawlId = await newCrawl();
      const sources = Array.from({ length: 14 }, (_, i) => `/src-${String(i).padStart(2, "0")}`);
      const ids = await addPages(crawlId, [
        ...sources.map((path) => ({ path })),
        { path: "/dead", fetchClass: "client_error", statusCode: 410 },
      ]);
      await addLinks(crawlId, sources, ids, "/dead");

      const found = await findings("links.broken-internal", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence.inlinkCount).toBe(14);
      expect(found[0]!.evidence.sampleSources).toHaveLength(SAMPLE_SOURCES);
      expect(found[0]!.evidence.statusCode).toBe(410);
    });

    it("ignores links flagged external, and links to targets that answer", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/src" },
        { path: "/fine" },
        { path: "/external-404", fetchClass: "client_error", statusCode: 404 },
      ]);
      await addLinks(crawlId, ["/src"], ids, "/fine");
      await addLinks(crawlId, ["/src"], ids, "/external-404", false);

      expect(await findings("links.broken-internal", crawlId)).toHaveLength(0);
    });

    // A 5xx is a server fault, not a broken link; `http.server-error` reports
    // it against the page itself. This rule speaks only to 4xx targets.
    it("does not fire on a link to a server error", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/src" },
        { path: "/boom", fetchClass: "server_error", statusCode: 503 },
      ]);
      await addLinks(crawlId, ["/src"], ids, "/boom");

      expect(await findings("links.broken-internal", crawlId)).toHaveLength(0);
    });

    // O(broken targets) is O(pages) on a site that 404s a whole section, so
    // the rule is capped like every other URL-scoped rule. The count behind
    // the cap counts distinct TARGETS, which is the unit of the finding.
    it("caps the findings and says so on the last one", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 1;
      const dead = Array.from({ length: total }, (_, i) => `/dead-${String(i).padStart(4, "0")}`);
      const ids = await addPages(crawlId, [
        { path: "/src" },
        ...dead.map((path) => ({ path, fetchClass: "client_error", statusCode: 404 })),
      ]);
      for (const path of dead) await addLinks(crawlId, ["/src"], ids, path);

      const found = await findings("links.broken-internal", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      // Sorted by target, so the cap takes a deterministic slice.
      expect(found.map((f) => f.pageUrl)).toEqual(dead.slice(0, URL_FINDING_CAP).map(url));
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
    });

    it("reads only its own crawl", async () => {
      const other = await newCrawl();
      const otherIds = await addPages(other, [
        { path: "/src" },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);
      await addLinks(other, ["/src"], otherIds, "/gone");

      const mine = await newCrawl();
      const mineIds = await addPages(mine, [{ path: "/src" }, { path: "/ok" }]);
      await addLinks(mine, ["/src"], mineIds, "/ok");

      expect(await findings("links.broken-internal", mine)).toHaveLength(0);
      expect(await findings("links.broken-internal", other)).toHaveLength(1);
    });
  });

  describe("canonical.non-200-target", () => {
    it("fires when the effective canonical resolves to a crawled 404", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/points-at-404", canonicalHtml: url("/gone") },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);

      const found = await findings("canonical.non-200-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: "canonical.non-200-target",
        severity: "warning",
        pageId: ids.get("/points-at-404"),
        pageUrl: url("/points-at-404"),
        dedupeKey: url("/points-at-404"),
      });
      expect(found[0]!.evidence).toEqual({
        canonical: url("/gone"),
        resolvedTo: url("/gone"),
        targetStatus: 404,
        targetFetchClass: "client_error",
      });

      // The two rules are disjoint. `is_indexable` is false on this 404 — the
      // writer sets it false for every non-200 — so a rule testing that flag
      // alone would report the same fault twice, the second time with copy
      // about a robots directive the page never carried.
      expect(await findings("canonical.non-indexable-target", crawlId)).toHaveLength(0);
    });

    it("fires on a canonical that points at a redirect", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/points-at-redirect", canonicalHtml: "/moved" },
        {
          path: "/moved",
          fetchClass: "redirect",
          statusCode: 301,
        },
      ]);

      const found = await findings("canonical.non-200-target", crawlId);
      expect(found).toHaveLength(1);
      // The relative declaration is reported verbatim, resolved beside it.
      expect(found[0]!.evidence).toMatchObject({
        canonical: "/moved",
        resolvedTo: url("/moved"),
        targetStatus: 301,
        targetFetchClass: "redirect",
      });
      expect(await findings("canonical.non-indexable-target", crawlId)).toHaveLength(0);
    });

    // The crawl got no HTTP answer from the target at all, so it knows nothing
    // about whether that URL serves a page — the same silence an uncrawled
    // target gets. A fetch that could not complete is the crawl summary's
    // report, not a canonical finding.
    it("is silent when the target fetch produced no status code", async () => {
      const crawlId = await newCrawl();
      for (const fetchClass of ["timeout", "network_error"]) {
        const crawl = await newCrawl();
        await addPages(crawl, [
          { path: "/points-at-dead-host", canonicalHtml: url("/unreachable") },
          { path: "/unreachable", fetchClass, statusCode: null },
        ]);
        expect(await findings("canonical.non-200-target", crawl), fetchClass).toHaveLength(0);
        expect(await findings("canonical.non-indexable-target", crawl), fetchClass).toHaveLength(0);
      }
      expect(await findings("canonical.non-200-target", crawlId)).toHaveLength(0);
    });

    // The target DID return 200; it just was not HTML. Reporting it under "does
    // not return 200" would be a false statement about the response, and its
    // `is_indexable` false is a consequence of not being an HTML page rather
    // than of any robots directive — so the indexability rule stays quiet too.
    it("is silent when the target returned 200 but was not HTML", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/points-at-pdf", canonicalHtml: url("/brochure.pdf") },
        { path: "/brochure.pdf", fetchClass: "non_html", statusCode: 200 },
      ]);

      expect(await findings("canonical.non-200-target", crawlId)).toHaveLength(0);
      expect(await findings("canonical.non-indexable-target", crawlId)).toHaveLength(0);
    });

    // Unknown is not evidence: a canonical for a URL the crawl never fetched
    // says nothing about whether that URL answers.
    it("is silent when the canonical target was never crawled", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/points-away", canonicalHtml: url("/never-crawled") }]);

      expect(await findings("canonical.non-200-target", crawlId)).toHaveLength(0);
      expect(await findings("canonical.non-indexable-target", crawlId)).toHaveLength(0);
    });

    // The canonical of a page that itself 404s is not a finding about the
    // canonical — every other canonical rule is gated the same way.
    it("is silent when the declaring page is not a 200 OK page", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/dead", fetchClass: "client_error", statusCode: 404, canonicalHtml: url("/dead") },
      ]);

      expect(await findings("canonical.non-200-target", crawlId)).toHaveLength(0);
    });

    it("reads the HTTP header canonical when the HTML declares none", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/header-only", canonicalHeader: url("/gone") },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ]);

      const found = await findings("canonical.non-200-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ canonical: url("/gone"), targetStatus: 404 });
    });

    // Both halves of the batched scan's contract in one crawl: it reads past
    // the first batch (the count proves it), and it stops *listing* at the
    // findings cap while still counting what it saw. A template that
    // canonicalises a whole section at a dead URL is O(pages) findings
    // otherwise.
    it("walks every page, not just the first batch, and caps what it lists", async () => {
      const crawlId = await newCrawl();
      const total = CANONICAL_BATCH + 5;
      const specs: PageSpec[] = [
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
      ];
      for (let i = 0; i < total; i += 1) {
        specs.push({ path: `/p-${String(i).padStart(4, "0")}`, canonicalHtml: url("/gone") });
      }
      await addPages(crawlId, specs);

      const found = await findings("canonical.non-200-target", crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      // The exact total is what says the scan ran to the end of the last
      // batch rather than stopping when the list filled up.
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
      expect(found[0]!.evidence).not.toHaveProperty("truncated");
      // Re-judging the same crawl lists the same two hundred. It has to: the
      // issues table is appended under `onConflictDoNothing`, so a cap that
      // kept an arbitrary two hundred each run would grow the table past the
      // cap it exists to enforce.
      const again = await findings("canonical.non-200-target", crawlId);
      expect(again.map((f) => f.pageUrl)).toEqual(found.map((f) => f.pageUrl));
    });

    // Which two hundred, stated in full — the batch boundary is out of the way
    // here (fewer declaring pages than `CANONICAL_BATCH`), so the whole listing
    // comes from one batch and the order is the declaring URL's, not the
    // target lookup's row order.
    it("keeps the lexically first pages when one batch overflows the cap", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 1;
      const paths = Array.from({ length: total }, (_, i) => `/q-${String(i).padStart(4, "0")}`);
      expect(total).toBeLessThan(CANONICAL_BATCH);
      await addPages(crawlId, [
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
        ...paths.map((path) => ({ path, canonicalHtml: url("/gone") })),
      ]);

      const found = await findings("canonical.non-200-target", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual(
        [...paths].sort().slice(0, URL_FINDING_CAP).map(url),
      );
      expect(found[found.length - 1]!.evidence).toMatchObject({
        truncated: { reported: URL_FINDING_CAP, total },
      });
    });
  });

  describe("canonical.non-indexable-target", () => {
    it("fires when the canonical resolves to a page marked noindex", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/points-at-noindex", canonicalHtml: url("/noindexed") },
        {
          path: "/noindexed",
          robotsMeta: "noindex, follow",
          xRobotsTag: "noindex",
        },
      ]);

      const found = await findings("canonical.non-indexable-target", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        pageId: ids.get("/points-at-noindex"),
        pageUrl: url("/points-at-noindex"),
        dedupeKey: url("/points-at-noindex"),
      });
      expect(found[0]!.evidence).toEqual({
        canonical: url("/noindexed"),
        resolvedTo: url("/noindexed"),
        targetRobotsMeta: "noindex, follow",
        targetXRobotsTag: "noindex",
      });

      // The target is a 200 OK page, so the status rule has nothing to say.
      expect(await findings("canonical.non-200-target", crawlId)).toHaveLength(0);
    });

    // `is_indexable` is false for every 404, redirect, 5xx and non-HTML
    // response, not only for a noindex directive, so this rule needs the
    // target to be a 200 OK page before the flag means what its copy says.
    it("fires only on a target that answers 200, whatever else is false", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/at-404", canonicalHtml: url("/gone") },
        { path: "/at-5xx", canonicalHtml: url("/boom") },
        { path: "/at-redirect", canonicalHtml: url("/moved") },
        { path: "/at-noindex", canonicalHtml: url("/noindexed") },
        { path: "/gone", fetchClass: "client_error", statusCode: 404 },
        { path: "/boom", fetchClass: "server_error", statusCode: 503 },
        { path: "/moved", fetchClass: "redirect", statusCode: 301 },
        { path: "/noindexed", robotsMeta: "noindex" },
      ]);

      const found = await findings("canonical.non-indexable-target", crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/at-noindex")]);
      // The other three are the status rule's, once each.
      expect((await findings("canonical.non-200-target", crawlId)).map((f) => f.pageUrl).sort())
        .toEqual([url("/at-404"), url("/at-5xx"), url("/at-redirect")].sort());
    });

    it("is silent for a page that canonicalises to itself while being noindex", async () => {
      // `directive.canonical-noindex-conflict` owns that page; this rule is
      // about pointing OTHER pages' signals at a URL that cannot receive them.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        {
          path: "/self-noindex",
          canonicalHtml: url("/self-noindex"),
          robotsMeta: "noindex",
        },
      ]);

      expect(await findings("canonical.non-indexable-target", crawlId)).toHaveLength(0);
    });
  });
});

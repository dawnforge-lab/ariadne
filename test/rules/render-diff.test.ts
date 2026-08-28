/**
 * The render diff rules, against a real database.
 *
 * Rows are inserted directly (the link-graph and url-hygiene pattern): what is
 * under test is what the rules make of the two sets of counts already stored —
 * the analyzer's, from the bytes the server sent, and the render pass's, from a
 * real DOM. Nothing here renders anything, and nothing needs to: a rule reads
 * the database (hard rule 3), so the browser's contribution to these tests is a
 * number in a column.
 *
 * EVERY RENDERED FIXTURE CARRIES ALL FIVE RENDER COUNTS, because that is what
 * the render pass writes — `rendered = true` and five numbers, or `rendered =
 * false` with an error and no numbers (`RenderResult`, src/crawl/render/
 * renderer.ts). Filling them all has a second use here: the three rules share
 * one crawl, so a fixture written for one of them is also a page the other two
 * must stay silent about, and the exact-URL assertions below are what says they
 * did.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import {
  CSR_MIN_ADDED_WORDS,
  CSR_WORD_MULTIPLE,
  FILTER_RENDERED_MIN,
  NAV_RAW_MAX,
  NAV_RENDERED_MIN,
  NAV_RENDERED_MULTIPLE,
  renderDiffRules,
} from "../../src/rules/query/render-diff.js";
import type { QueryRule } from "../../src/rules/registry/types.js";
import { databaseUrl } from "./metric-db.js";

const SITE = "https://render.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(renderDiffRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in renderDiffRules`);
  return r;
}

describe("renderDiffRules metadata", () => {
  it("defines the three rules of the plan's table", () => {
    expect(renderDiffRules.map((r) => r.id).sort()).toEqual([
      "content.csr-dependent",
      "filters.js-only",
      "nav.js-only",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(renderDiffRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      // Critical: the page's own substance is not in the response.
      "content.csr-dependent": [["CHECK-01"], "critical", "content"],
      // Critical for the same reason at the site's scale — the routes onward
      // from the page are not in the response either.
      "nav.js-only": [["CHECK-34"], "critical", "technical"],
      // Warning: a facet space that is not crawlable is a decision to make
      // rather than a fault, and either answer to it can be the right one.
      "filters.js-only": [["CHECK-02"], "warning", "url"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of renderDiffRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    expect(titles.size).toBe(renderDiffRules.length);
  });

  // The thresholds are the rule, so they are pinned as values rather than left
  // to the assertions below to imply. The hand-derived boundaries in this file
  // are computed FROM these numbers; if one moves, the arithmetic in the
  // comments stops describing the rule and this fails first.
  it("pins the thresholds the boundary cases below are derived from", () => {
    expect(CSR_WORD_MULTIPLE).toBe(2);
    expect(CSR_MIN_ADDED_WORDS).toBe(150);
    expect(NAV_RAW_MAX).toBe(5);
    expect(NAV_RENDERED_MIN).toBe(10);
    expect(NAV_RENDERED_MULTIPLE).toBe(2);
    expect(FILTER_RENDERED_MIN).toBe(5);
  });
});

describe("the render diff rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  /**
   * A page as the two passes left it.
   *
   * The defaults are a page NO rule fires on — 400 words in the HTML and 400 in
   * the DOM, a twenty-link navigation present in both — for `mk-page.ts`'s
   * reason: a fixture overrides exactly the signal it is about, and an assertion
   * cannot then be satisfied by an unrelated default.
   */
  interface PageSpec {
    path: string;
    rendered?: boolean;
    renderError?: string | null;
    wordCount?: number | null;
    /**
     * Defaults to `wordCount`: a page with no markup-hidden chrome, where the
     * two raw counts are the same number. That default is what keeps every
     * boundary case below reading as it always did — the arithmetic is now
     * done in this column, and on a page with nothing hidden the column holds
     * the same value it used to. `/csr-hidden-chrome` is the case where they
     * differ, and it is the one that proves which column the rule reads.
     */
    renderableWordCount?: number | null;
    renderedWordCount?: number | null;
    navLinkCount?: number;
    footerLinkCount?: number;
    renderedNavLinkCount?: number | null;
    renderedFooterLinkCount?: number | null;
    renderedFilterLinkCount?: number | null;
    /** Absolute or site-relative targets stored as this page's outgoing links. */
    linkTargets?: string[];
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => {
      const full = url(s.path);
      const normalised = normalizeUrl(full);
      if (normalised === null) throw new Error(`${full} does not normalise`);
      const rendered = s.rendered ?? true;
      return {
        id: `page_${randomUUID()}`,
        crawlId,
        url: full,
        urlNormalised: normalised,
        fetchClass: "ok",
        statusCode: 200,
        isIndexable: true,
        depth: 1,
        discoveredVia: "link",
        title: "A perfectly reasonable page title here",
        htmlBytes: 40_000,
        wordCount: s.wordCount === undefined ? 400 : s.wordCount,
        renderableWordCount:
          s.renderableWordCount === undefined
            ? s.wordCount === undefined
              ? 400
              : s.wordCount
            : s.renderableWordCount,
        navLinkCount: s.navLinkCount ?? 12,
        footerLinkCount: s.footerLinkCount ?? 8,
        rendered,
        // A page nobody rendered stores null in all five, whatever a spec says:
        // there is no such row as an unrendered page with counts, and building
        // one would test a shape the writer cannot produce.
        renderedWordCount: rendered ? (s.renderedWordCount === undefined ? 400 : s.renderedWordCount) : null,
        renderedLinkCount: rendered ? 20 : null,
        renderedNavLinkCount: rendered
          ? s.renderedNavLinkCount === undefined
            ? 12
            : s.renderedNavLinkCount
          : null,
        renderedFooterLinkCount: rendered
          ? s.renderedFooterLinkCount === undefined
            ? 8
            : s.renderedFooterLinkCount
          : null,
        renderedFilterLinkCount: rendered
          ? s.renderedFilterLinkCount === undefined
            ? 0
            : s.renderedFilterLinkCount
          : null,
        renderError: s.renderError ?? null,
      };
    });
    await db.insert(pages).values(rows);

    for (const [i, spec] of specs.entries()) {
      const targets = spec.linkTargets ?? [];
      if (targets.length === 0) continue;
      await db.insert(links).values(
        targets.map((target, position) => ({
          crawlId,
          sourcePageId: rows[i]!.id,
          targetUrl: target.startsWith("http") ? target : url(target),
          targetPageId: null,
          isInternal: true,
          position,
        })),
      );
    }
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  /** The paths one rule reported, in the order the rule returned them. */
  async function firedPaths(ruleId: string, crawlId: string): Promise<string[]> {
    const findings = await rule(ruleId).run(db, crawlId);
    for (const f of findings) expect(f.ruleId, "finding identity").toBe(ruleId);
    return findings.map((f) => (f.pageUrl ?? "").slice(SITE.length));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  // CONTENT.CSR-DEPENDENT. Both arms must hold, and RAW HERE IS THE RENDERABLE
  // COUNT since Phase 7 — the words the page's markup does not hide, which is
  // the only raw number comparable with an `innerText` measurement:
  //   rendered >= 2 * greatest(renderable, 1)   and   rendered - renderable >= 150
  //
  //   /csr-both-exact   raw 100, rendered 250: 250 >= 200 ✓, 150 >= 150 ✓  FIRES
  //   /csr-under-floor  raw 100, rendered 249: 249 >= 200 ✓, 149 >= 150 ✗  silent
  //   /csr-under-ratio  raw 200, rendered 399: 199 >= 150 ✓, 399 >= 400 ✗  silent
  //   /csr-empty-shell  raw   0, rendered 150: 150 >= 2·1 ✓, 150 >= 150 ✓  FIRES
  //   /csr-shell-under  raw   0, rendered 149: 149 >= 2·1 ✓, 149 >= 150 ✗  silent
  //
  // None of these five pages hides anything, so their renderable count IS their
  // word count and every boundary above is the same arithmetic it always was —
  // re-derived rather than assumed: the column moved, the numbers did not.
  //
  // The last two are what `greatest(renderable_word_count, 1)` is for: without
  // it the ratio arm of a zero-word page would read `rendered >= 0`, true of
  // every page ever rendered, and the floor would be doing all the work alone.
  it("content.csr-dependent fires on both arms and stops one word short of either", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/csr-both-exact", wordCount: 100, renderedWordCount: 250 },
      { path: "/csr-under-floor", wordCount: 100, renderedWordCount: 249 },
      { path: "/csr-under-ratio", wordCount: 200, renderedWordCount: 399 },
      { path: "/csr-empty-shell", wordCount: 0, renderedWordCount: 150 },
      { path: "/csr-shell-under", wordCount: 0, renderedWordCount: 149 },
    ]);

    expect(await firedPaths("content.csr-dependent", crawlId)).toEqual([
      "/csr-both-exact",
      "/csr-empty-shell",
    ]);
    // And the other two rules have nothing to say about any of them: every one
    // of these pages carries the default navigation on both sides and no filter
    // links at all.
    expect(await firedPaths("nav.js-only", crawlId)).toEqual([]);
    expect(await firedPaths("filters.js-only", crawlId)).toEqual([]);
  });

  it("content.csr-dependent quotes every count and the difference between them", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/csr-evidence", wordCount: 12, renderedWordCount: 840 },
    ]);
    const findings = await rule("content.csr-dependent").run(db, crawlId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.pageId).toBe(ids.get("/csr-evidence"));
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.dedupeKey).toBe(url("/csr-evidence"));
    expect(findings[0]!.evidence).toEqual({
      rawWordCount: 12,
      renderableWordCount: 12,
      renderedWordCount: 840,
      addedWords: 828,
    });
  });

  it("content.csr-dependent compares the renderable count, not the raw one", async () => {
    // The lavishalice shape: 1,000 words in the HTML of which 740 are hidden
    // chrome, and a browser that shows 900.
    //
    //   against the RAW count:        900 >= 2·1000 ✗ — silent (the false
    //                                 negative the diagnosis predicted)
    //   against the RENDERABLE count: 900 >= 2·260  ✓ and 900 − 260 = 640 >= 150
    //                                 ✓ — FIRES
    //
    // And the reverse shape proves the change is not a licence to fire: a page
    // whose renderable count is high is silent even though most of its HTML is
    // chrome, because a reader can already see what the browser shows.
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/csr-hidden-chrome", wordCount: 1000, renderableWordCount: 260, renderedWordCount: 900 },
      { path: "/csr-visible-copy", wordCount: 1000, renderableWordCount: 900, renderedWordCount: 900 },
    ]);

    expect(await firedPaths("content.csr-dependent", crawlId)).toEqual(["/csr-hidden-chrome"]);

    const findings = await rule("content.csr-dependent").run(db, crawlId);
    expect(findings[0]!.evidence).toEqual({
      rawWordCount: 1000,
      renderableWordCount: 260,
      renderedWordCount: 900,
      addedWords: 640,
    });
  });

  // NAV.JS-ONLY. Three conditions over the two sums:
  //   raw < 5,  rendered >= 10,  rendered >= 2 * (raw + 1)
  //
  //   /nav-boundary   raw 4 (4+0), rendered 10 (10+0): 4 < 5 ✓, 10 >= 10 ✓,
  //                   10 >= 2·5 = 10 ✓                                  FIRES
  //   /nav-under-min  raw 4,       rendered  9:  9 >= 10 ✗              silent
  //   /nav-raw-at-max raw 5 (3+2), rendered 20:  5 < 5 ✗                silent
  //   /nav-shell      raw 0,       rendered 10 (6+4): all three ✓       FIRES
  //
  // `/nav-boundary` is where the third condition and the second coincide, which
  // is the arithmetic the rule's docblock states: over `raw < 5`, `2(raw + 1)`
  // peaks at exactly `NAV_RENDERED_MIN`, so no page passes the first two
  // conditions and fails the third. Pinned here rather than left as a claim.
  it("nav.js-only fires at the boundary and stops one link short of it", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/nav-boundary",
        navLinkCount: 4,
        footerLinkCount: 0,
        renderedNavLinkCount: 10,
        renderedFooterLinkCount: 0,
      },
      {
        path: "/nav-under-min",
        navLinkCount: 4,
        footerLinkCount: 0,
        renderedNavLinkCount: 9,
        renderedFooterLinkCount: 0,
      },
      {
        path: "/nav-raw-at-max",
        navLinkCount: 3,
        footerLinkCount: 2,
        renderedNavLinkCount: 20,
        renderedFooterLinkCount: 0,
      },
      {
        path: "/nav-shell",
        navLinkCount: 0,
        footerLinkCount: 0,
        renderedNavLinkCount: 6,
        renderedFooterLinkCount: 4,
      },
    ]);

    expect(await firedPaths("nav.js-only", crawlId)).toEqual(["/nav-boundary", "/nav-shell"]);
    expect(await firedPaths("content.csr-dependent", crawlId)).toEqual([]);
    expect(await firedPaths("filters.js-only", crawlId)).toEqual([]);
  });

  // The margin the rule is built on, asserted rather than described.
  //
  // The raw side undercounts by one per `<a href>` left unclosed across a nav or
  // footer boundary (the adoption agency reconstruction — see the rule's
  // docblock and the `nav_link_count` column comment). A page with NO
  // JavaScript navigation whose tokenizer count is `r` therefore renders `r + k`
  // for `k` such anchors, and the rule misreads it only when
  // `k >= max(r + 2, 10 - r)` — which is 6 at its cheapest, at r = 4.
  //
  // Both cases below are that page: malformed HTML, no JS navigation at all.
  //   /margin-floor-3  r = 4, k = 3 → rendered 7:  7 >= 10 ✗   silent
  //   /margin-k-5      r = 4, k = 5 → rendered 9:  9 >= 10 ✗   silent
  //   /margin-k-6      r = 4, k = 6 → rendered 10: the cheapest false positive
  //                                   available — FIRES, and the test says so
  //                                   rather than pretending the rule is exact.
  it("nav.js-only tolerates the tokenizer's undercount to six unclosed anchors", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/margin-floor-3",
        navLinkCount: 4,
        footerLinkCount: 0,
        renderedNavLinkCount: 7,
        renderedFooterLinkCount: 0,
      },
      {
        path: "/margin-k-5",
        navLinkCount: 4,
        footerLinkCount: 0,
        renderedNavLinkCount: 9,
        renderedFooterLinkCount: 0,
      },
      {
        path: "/margin-k-6",
        navLinkCount: 4,
        footerLinkCount: 0,
        renderedNavLinkCount: 10,
        renderedFooterLinkCount: 0,
      },
    ]);

    // A realistic floor of two or three unclosed anchors is nowhere near it, and
    // five is still silent: the margin is a factor of two on the pessimistic
    // end of that floor, not a hair's breadth.
    expect(await firedPaths("nav.js-only", crawlId)).toEqual(["/margin-k-6"]);
  });

  it("nav.js-only quotes both halves of both sides and the sums it compared", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/nav-evidence",
        navLinkCount: 1,
        footerLinkCount: 1,
        renderedNavLinkCount: 24,
        renderedFooterLinkCount: 9,
      },
    ]);
    const findings = await rule("nav.js-only").run(db, crawlId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.evidence).toEqual({
      rawNavLinks: 1,
      rawFooterLinks: 1,
      rawLinks: 2,
      renderedNavLinks: 24,
      renderedFooterLinks: 9,
      renderedLinks: 33,
    });
  });

  // FILTERS.JS-ONLY. The rendered floor, and a raw side of exactly zero.
  //
  //   /filters-fires      no links at all,             rendered 5  FIRES
  //   /filters-under      no links at all,             rendered 4  silent
  //   /filters-raw-query  one link `/list?colour=red`, rendered 5  silent
  //   /filters-raw-facet  one link `/facet-a`,         rendered 5  silent
  //   /filters-plain-link one link `/about`,           rendered 5  FIRES
  //
  // The last two are the two arms of the predicate, tested apart: `?` in the
  // target, and the /filter|facet|sort/i match on a target that carries no query
  // string at all. `/about` is the control that keeps the gate from being "this
  // page has no outgoing links" — a page can link plenty and still expose no
  // route into its facets.
  it("filters.js-only fires only when the raw side has no filter link at all", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/filters-fires", renderedFilterLinkCount: 5 },
      { path: "/filters-under", renderedFilterLinkCount: 4 },
      {
        path: "/filters-raw-query",
        renderedFilterLinkCount: 5,
        linkTargets: ["/list?colour=red"],
      },
      { path: "/filters-raw-facet", renderedFilterLinkCount: 5, linkTargets: ["/facet-a"] },
      { path: "/filters-plain-link", renderedFilterLinkCount: 5, linkTargets: ["/about"] },
    ]);

    expect(await firedPaths("filters.js-only", crawlId)).toEqual([
      "/filters-fires",
      "/filters-plain-link",
    ]);
    expect(await firedPaths("content.csr-dependent", crawlId)).toEqual([]);
    expect(await firedPaths("nav.js-only", crawlId)).toEqual([]);
  });

  // The regex arm is case-insensitive (`~*`) and matches anywhere in the target,
  // which is what `/filter|facet|sort/i.test(a.href)` does on the rendered side.
  // Spelled apart from the case above so a change to either operator fails on a
  // test that names it.
  it("filters.js-only matches the raw predicate case-insensitively, anywhere in the target", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/filters-upper", renderedFilterLinkCount: 9, linkTargets: ["/Sort-By-Price"] },
      { path: "/filters-mid", renderedFilterLinkCount: 9, linkTargets: ["/shop/facets/colour"] },
      { path: "/filters-none", renderedFilterLinkCount: 9, linkTargets: ["/shop/colour"] },
    ]);
    expect(await firedPaths("filters.js-only", crawlId)).toEqual(["/filters-none"]);
  });

  it("filters.js-only quotes both sides, the raw one proved zero by the gate", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/filters-evidence", renderedFilterLinkCount: 42 }]);
    const findings = await rule("filters.js-only").run(db, crawlId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.evidence).toEqual({ rawFilterLinks: 0, renderedFilterLinks: 42 });
  });

  // The gate that makes all three rules honest: a page the render pass never
  // reached is NOT AUDITED, and that is not the same as passing. Both shapes of
  // unrendered row are here — never selected, and selected but failed — and each
  // carries raw numbers that would fire loudly if the rendered side existed.
  it("no rule fires on a page that was not rendered, however bad its raw numbers", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/never-selected",
        rendered: false,
        wordCount: 3,
        navLinkCount: 0,
        footerLinkCount: 0,
      },
      {
        path: "/render-failed",
        rendered: false,
        renderError: "navigation timeout after 15000ms",
        wordCount: 3,
        navLinkCount: 0,
        footerLinkCount: 0,
      },
    ]);

    for (const id of ["content.csr-dependent", "nav.js-only", "filters.js-only"]) {
      expect(await firedPaths(id, crawlId), id).toEqual([]);
    }

    // …and the silence is not vacuous: the same raw numbers with a rendered side
    // beside them fire all three, so what the assertion above observed is the
    // `rendered` gate and nothing else.
    const rendered = await newCrawl();
    await addPages(rendered, [
      {
        path: "/rendered-twin",
        wordCount: 3,
        renderedWordCount: 900,
        navLinkCount: 0,
        footerLinkCount: 0,
        renderedNavLinkCount: 20,
        renderedFooterLinkCount: 5,
        renderedFilterLinkCount: 7,
      },
    ]);
    for (const id of ["content.csr-dependent", "nav.js-only", "filters.js-only"]) {
      expect(await firedPaths(id, rendered), id).toEqual(["/rendered-twin"]);
    }
  });

  // THE RULING: a rendered page with a null count column is a writer defect, and
  // it stops the rule rather than being skipped. Skipping is what SQL does on
  // its own — `null >= 2 * null` is NULL and a WHERE clause drops it exactly as
  // it drops a false — so the page would be audited by nothing and read as clean
  // by everything (hard rule 7).
  //
  // One crawl per case, because the guard scans every rendered page of the crawl
  // and a bad row would otherwise stop the rules the case is not about.
  it("throws, naming page and column, on a rendered page with a null count", async () => {
    const cases: [string, string, PageSpec][] = [
      [
        "content.csr-dependent",
        "rendered_word_count",
        { path: "/bad-rendered-words", renderedWordCount: null },
      ],
      [
        // The raw side of the same comparison, which since Phase 7 is the
        // RENDERABLE count. An ok/200 HTML page crawled by this engine always
        // carries one, so a null here loses the page the same way — and on an
        // older crawl it means the whole crawl cannot be judged, which the
        // message says and this refusal is what makes visible.
        "content.csr-dependent",
        "renderable_word_count",
        { path: "/bad-raw-words", renderableWordCount: null },
      ],
      [
        "nav.js-only",
        "rendered_nav_link_count",
        { path: "/bad-rendered-nav", renderedNavLinkCount: null },
      ],
      [
        "nav.js-only",
        "rendered_footer_link_count",
        { path: "/bad-rendered-footer", renderedFooterLinkCount: null },
      ],
      [
        "filters.js-only",
        "rendered_filter_link_count",
        { path: "/bad-rendered-filters", renderedFilterLinkCount: null },
      ],
    ];

    for (const [ruleId, column, spec] of cases) {
      const crawlId = await newCrawl();
      await addPages(crawlId, [spec]);
      await expect(rule(ruleId).run(db, crawlId), `${ruleId}/${column}`).rejects.toThrow(
        new RegExp(`${ruleId.replace(".", "\\.")}.*${url(spec.path)}.*${column}`, "s"),
      );
    }
  });

  // A rendered page missing SEVERAL of a rule's columns is named once, with all
  // of them: the message is a repair instruction, and one column at a time would
  // make it a queue.
  it("names every missing column of the page it stops on", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/bad-both-nav", renderedNavLinkCount: null, renderedFooterLinkCount: null },
    ]);
    await expect(rule("nav.js-only").run(db, crawlId)).rejects.toThrow(
      /rendered_nav_link_count, rendered_footer_link_count/,
    );
  });

  // A rule that reads a column it does not need would start throwing for a
  // defect it has no stake in. Each rule guards its own inputs (the
  // crawl-evidence discipline), so a null filter count is `filters.js-only`'s
  // problem and nobody else's.
  it("each rule guards only the columns it reads", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/bad-filters-only", renderedFilterLinkCount: null }]);
    await expect(rule("filters.js-only").run(db, crawlId)).rejects.toThrow(/rendered_filter/);
    expect(await firedPaths("content.csr-dependent", crawlId)).toEqual([]);
    expect(await firedPaths("nav.js-only", crawlId)).toEqual([]);
  });

  // A crawl id nothing knows scans no pages, which is indistinguishable from a
  // site with no render problem at all (the `runRules` precedent, hard rule 7).
  it("every rule refuses a crawl id nothing knows", async () => {
    const missing = `crawl_${randomUUID()}`;
    for (const r of renderDiffRules) {
      await expect(r.run(db, missing), r.id).rejects.toThrow(/no such crawl/);
    }
  });

  // One crawl's pages are not another's — the whole file inserts into one
  // database, and a rule missing its `crawl_id` predicate would pass every
  // assertion above while reporting the neighbouring crawl's pages.
  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    await addPages(other, [{ path: "/other-shell", wordCount: 0, renderedWordCount: 500 }]);
    const mine = await newCrawl();
    await addPages(mine, [{ path: "/mine-clean" }]);
    expect(await firedPaths("content.csr-dependent", mine)).toEqual([]);
    expect(await firedPaths("content.csr-dependent", other)).toEqual(["/other-shell"]);
  });
});

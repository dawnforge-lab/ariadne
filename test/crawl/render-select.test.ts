/**
 * Render selection, against a real database.
 *
 * EVERY NUMBER BELOW IS HAND-DERIVED from the site described above the
 * assertion — the page count, the budget arithmetic, which page trips which
 * suspicion trigger, and the exact order the selection comes back in. A test
 * whose expectation was copied from the output would assert only that the query
 * is deterministic; these assert that it is right (the phase-4 metric-test
 * discipline, applied to a selection instead of a statistic).
 *
 * Rows are inserted directly rather than crawled: what is under test is the SQL
 * that chooses a render set, not the crawl that produced the pages.
 *
 * The suspicion sites are built so that EACH SUSPECT PAGE TRIPS EXACTLY ONE
 * TRIGGER, with a near-miss page sitting on the other side of every threshold.
 * That is what makes "trigger 3 fires" a claim about trigger 3 rather than
 * about the disjunction.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, links, pages } from "../../src/db/schema.js";
import {
  completeUrls,
  enqueueUrls,
  failUrl,
  frontierCounts,
  leaseBatch,
  leaseRenderUrls,
  releaseRenderLeases,
} from "../../src/crawl/frontier.js";
import {
  RENDER_DEFAULTS,
  renderSelectionStats,
  selectRenderSet,
  SUSPICION,
  type RenderSelection,
} from "../../src/crawl/render/select.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://render-select.example";
const url = (path: string): string => `${SITE}${path}`;

/**
 * A page row, described by what makes it interesting. Every default is a value
 * no suspicion trigger fires on, so a spec states exactly the one signal it is
 * about — `mk-page.ts`'s "clean page" idea, for the two columns and two
 * thresholds this selection reads.
 */
interface PageSpec {
  path: string;
  pageType?: string | null;
  fetchClass?: string;
  statusCode?: number | null;
  wordCount?: number | null;
  htmlBytes?: number | null;
  title?: string | null;
  frameworkMarkers?: string[];
  depth?: number;
  isIndexable?: boolean;
  /** false = the page makes no outgoing link at all (suspicion trigger 2). */
  outlinks?: boolean;
}

describe("selectRenderSet", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    return id;
  }

  /** Insert the pages and one outgoing link per page that has any. */
  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      pageType: s.pageType === undefined ? "content" : s.pageType,
      fetchClass: s.fetchClass ?? "ok",
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: s.isIndexable ?? true,
      wordCount: s.wordCount === undefined ? 400 : s.wordCount,
      htmlBytes: s.htmlBytes === undefined ? 40_000 : s.htmlBytes,
      title: s.title === undefined ? "A perfectly reasonable page title" : s.title,
      frameworkMarkers: s.frameworkMarkers ?? [],
      depth: s.depth ?? 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);

    const linkRows = rows
      .filter((_, i) => specs[i]!.outlinks !== false)
      .map((r, i) => ({
        crawlId,
        sourcePageId: r.id,
        targetUrl: url("/somewhere-else"),
        targetPageId: null,
        anchor: "onwards",
        rel: null,
        isInternal: true,
        isNofollow: false,
        position: i,
      }));
    if (linkRows.length > 0) await db.insert(links).values(linkRows);
  }

  /** The crawl's frontier as `url -> state`, so a whole pass can be asserted. */
  async function frontierState(crawlId: string): Promise<Record<string, string>> {
    const rows = await db
      .select({ url: frontier.url, state: frontier.state })
      .from(frontier)
      .where(eq(frontier.crawlId, crawlId));
    return Object.fromEntries(rows.map((r) => [r.url, r.state]));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("pins the budget defaults the whole phase is calibrated against", () => {
    expect(RENDER_DEFAULTS).toEqual({
      renderBudgetPct: 5,
      renderMaxPages: 500,
      renderSamplePerType: 3,
    });
    // The four suspicion thresholds, in the units the spec states them in.
    expect(SUSPICION).toEqual({
      thinWordCount: 50,
      thinHtmlBytes: 51_200,
      titlelessHtmlBytes: 25_600,
    });
  });

  /**
   * THE SUSPICION SITE. Thirteen pages: six suspects, four near-misses that sit
   * one unit on the safe side of a threshold, and three pages outside the
   * `ok`/200 class that WOULD be suspects if the class filter were missing.
   *
   *   path           why it is (or is not) a suspect
   *   /healthy       nothing: 400 words, 40KB, titled, no markers, links out
   *   /thin          T1: word_count 49 < 50 AND html_bytes 51201 > 51200
   *   /thin-edge     no: word_count 50 is not < 50 (51201 bytes)
   *   /thin-edge2    no: html_bytes 51200 is not > 51200 (49 words)
   *   /dead-end      T2: makes no outgoing link
   *   /titleless     T3: title null AND html_bytes 25601 > 25600
   *   /title-empty   T3: title '' counts as titleless (25601 bytes)
   *   /title-edge    no: html_bytes 25600 is not > 25600 (title null)
   *   /framework     T4: framework_markers ["__NEXT_DATA__"]
   *   /noindex       T4, and NOT INDEXABLE — deliberately still selected
   *   /gone          excluded: 404, though it is titleless and links nowhere
   *   /redir         excluded: 301, though it links nowhere
   *   /ok-204        excluded: fetch_class ok but status 204, links nowhere
   */
  const SUSPICION_SITE: PageSpec[] = [
    { path: "/healthy" },
    { path: "/thin", wordCount: 49, htmlBytes: 51_201 },
    { path: "/thin-edge", wordCount: 50, htmlBytes: 51_201 },
    { path: "/thin-edge2", wordCount: 49, htmlBytes: 51_200 },
    { path: "/dead-end", outlinks: false },
    { path: "/titleless", title: null, htmlBytes: 25_601 },
    { path: "/title-empty", title: "", htmlBytes: 25_601 },
    { path: "/title-edge", title: null, htmlBytes: 25_600 },
    { path: "/framework", frameworkMarkers: ["__NEXT_DATA__"] },
    { path: "/noindex", frameworkMarkers: ["window.__NUXT__"], isIndexable: false },
    { path: "/gone", fetchClass: "client_error", statusCode: 404, title: null,
      htmlBytes: 30_000, outlinks: false },
    { path: "/redir", fetchClass: "redirect", statusCode: 301, outlinks: false },
    { path: "/ok-204", statusCode: 204, outlinks: false },
  ];

  it("selects every suspect, one trigger at a time, and nothing healthy", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, SUSPICION_SITE);

    // Sample off (0 per type) so what comes back is the suspects and only them.
    // Budget 100% of 13 pages = ceil(13.0) = 13, far above the 6 suspects.
    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderSamplePerType: 0,
    });

    expect(result).toEqual<RenderSelection>({
      selected: [
        url("/dead-end"), // T2
        url("/framework"), // T4
        url("/noindex"), // T4, noindex
        url("/thin"), // T1
        url("/title-empty"), // T3
        url("/titleless"), // T3
      ],
      budget: 13,
      suspects: 6,
      sampled: 0,
      truncated: false,
    });
  });

  it("puts every selected URL into the frontier as render_pending", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/framework", frameworkMarkers: ["__NEXT_DATA__"], depth: 4 },
      { path: "/dead-end", outlinks: false, depth: 2 },
      { path: "/healthy" },
    ]);
    // One of the two already has a frontier row, `done`, from the crawl pass.
    await enqueueUrls(db, crawlId, [
      { url: url("/framework"), depth: 4, discoveredVia: "sitemap" },
    ]);
    await db
      .update(frontier)
      .set({ state: "done" })
      .where(and(eq(frontier.crawlId, crawlId), eq(frontier.url, url("/framework"))));

    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderSamplePerType: 0,
    });
    expect(result.selected).toEqual([url("/dead-end"), url("/framework")]);

    const rows = await db
      .select()
      .from(frontier)
      .where(eq(frontier.crawlId, crawlId))
      .orderBy(frontier.url);
    expect(rows.map((r) => [r.url, r.state, r.depth, r.discoveredVia])).toEqual([
      // No frontier row existed: one is inserted, carrying the page's own depth
      // and `render` as its provenance.
      [url("/dead-end"), "render_pending", 2, "render"],
      // A row DID exist: it moves state and keeps the crawl's depth and
      // provenance, because the first discovery of a URL owns those.
      [url("/framework"), "render_pending", 4, "sitemap"],
    ]);
    // The healthy page was never selected, so it never gained a row.
    expect(rows).toHaveLength(2);
  });

  /**
   * The frontier row a double fetch leaves behind: `failed` with its retries
   * spent, beside a page row that is a perfectly good ok/200.
   *
   * The sequence is the real one, run through the real functions rather than
   * hand-set — an expired lease lets two workers hold the same URL; worker 1
   * writes the page row and completes the URL; worker 2 then finishes its own
   * attempt, spends the last retry and calls `failUrl`, which overwrites `done`
   * with `failed`. The evidence exists and the frontier disagrees.
   *
   * The selection reads the PAGE row, so it promotes that row like any other.
   * This pins both halves of why that is right: the page is selected, and it
   * still cannot be crawled again.
   */
  it("promotes a failed row whose page row is a good 200, and never re-crawls it", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/crashed", frameworkMarkers: ["__NEXT_DATA__"], depth: 2 },
    ]);

    await enqueueUrls(db, crawlId, [
      { url: url("/crashed"), depth: 2, discoveredVia: "link" },
    ]);
    await leaseBatch(db, crawlId, "worker-1", 1, 60);
    // Worker 1 commits its page row and the completion together.
    expect(await completeUrls(db, crawlId, [url("/crashed")])).toBe(1);
    // Worker 2, holding the same URL off an expired lease, spends its last
    // retry and overwrites `done` with `failed`.
    await failUrl(db, crawlId, url("/crashed"), { requeue: false, maxAttempts: 1 });
    expect(await frontierCounts(db, crawlId)).toEqual({
      pending: 0, leased: 0, done: 0, failed: 1, renderPending: 0,
    });

    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderSamplePerType: 0,
    });
    expect(result.selected).toEqual([url("/crashed")]);

    const rows = await db
      .select()
      .from(frontier)
      .where(eq(frontier.crawlId, crawlId));
    expect(rows.map((r) => [r.state, r.depth, r.discoveredVia, r.attempts])).toEqual([
      // Promoted, its crawl-pass provenance intact and its spent attempts
      // reset — the render pass is a fresh attempt budget.
      ["render_pending", 2, "link", 0],
    ]);

    // And the promotion did not hand the URL back to the crawl: `render_pending`
    // matches neither of leaseBatch's two state disjuncts.
    expect(await leaseBatch(db, crawlId, "worker-3", 10, 60)).toEqual([]);
  });

  /**
   * THE SAMPLE SITE. Twelve healthy pages — no suspect among them — in three
   * cohorts, one of which is assembled from two spellings of "no page type":
   *
   *   page_type   pages                        size  sampled (3 lowest by url)
   *   product     /p/1 /p/2 /p/3 /p/4 /p/5     5     /p/1 /p/2 /p/3
   *   blog        /b/1 /b/2 /b/3 /b/4          4     /b/1 /b/2 /b/3
   *   (untyped)   /u/1 /u/2 (null), /u/3 ('')  3     /u/1 /u/2 /u/3
   *
   * The empty string joins the nulls rather than forming a cohort of its own:
   * `coalesce(nullif(page_type, ''), '(untyped)')`, the metric layer's UNTYPED
   * convention (src/rules/metric/cohort.ts).
   *
   * Budget 100% of 12 = 12, above the 9 sampled, so nothing is capped here.
   * What the three DIFFERENT cohort sizes pin is the order the seats come back
   * in: largest template first (product 5, then blog 4, then untyped 3), URL
   * within a template. Nine seats for nine candidates, so no cut happens — this
   * is the ordering on its own, with the budget held out of the way.
   */
  const SAMPLE_SITE: PageSpec[] = [
    ...[1, 2, 3, 4, 5].map((i) => ({ path: `/p/${i}`, pageType: "product" })),
    ...[1, 2, 3, 4].map((i) => ({ path: `/b/${i}`, pageType: "blog" })),
    { path: "/u/1", pageType: null },
    { path: "/u/2", pageType: null },
    { path: "/u/3", pageType: "" },
  ];

  it("samples three pages per page type, merging both spellings of untyped", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, SAMPLE_SITE);

    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderSamplePerType: 3,
    });

    expect(result).toEqual<RenderSelection>({
      selected: [
        // product (5 pages) — the largest template, so it is seated first.
        url("/p/1"), url("/p/2"), url("/p/3"),
        // blog (4).
        url("/b/1"), url("/b/2"), url("/b/3"),
        // (untyped) (3).
        url("/u/1"), url("/u/2"), url("/u/3"),
      ],
      budget: 12,
      suspects: 0,
      sampled: 9,
      truncated: false,
    });
  });

  /**
   * THE GATE SITE — the shape the first real-site crawl actually had, shrunk.
   *
   * lavishalice.com produced 196 page types over 551 pages: two or three real
   * templates plus ~170 collection URLs that `derivePageType` left as singleton
   * types of their own. 176 candidates competed for 28 seats, and because the
   * cut was taken in URL order every seat went to `/apps/*` and
   * `/collections/a-b*` — **zero of the 211 `/products/:slug` pages rendered**,
   * so the four JavaScript rules came back empty for the biggest template on an
   * e-commerce site and looked like a pass.
   *
   * Here: twenty singleton `/collections/*` types and one twelve-page
   * `/products/:slug` type, and the paths are chosen so that alphabetical order
   * puts every singleton ahead of every product. Five seats.
   *
   *   old ordering (tier, url)             → c00 c01 c02 c03 c04, 0 products
   *   new ordering (tier, type_size, url)  → p01 p02 p03, then c00 c01
   */
  const GATE_SITE: PageSpec[] = [
    ...Array.from({ length: 20 }, (_, i) => {
      const n = String(i).padStart(2, "0");
      return { path: `/collections/c${n}`, pageType: `collection:c${n}` };
    }),
    ...Array.from({ length: 12 }, (_, i) => ({
      path: `/products/p${String(i + 1).padStart(2, "0")}`,
      pageType: "/products/:slug",
    })),
  ];

  it("spends its seats on the biggest template, not on the front of the alphabet", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, GATE_SITE);

    // 32 pages, budget capped to 5. Candidates: 3 from the product type + 1
    // from each of the 20 singletons = 23, none of them a suspect — exactly the
    // gate's predicament (176 candidates, 28 seats, `suspects: 0`).
    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderMaxPages: 5,
      renderSamplePerType: 3,
    });

    expect(result).toEqual<RenderSelection>({
      selected: [
        // The 12-page template first, all three of its sampled pages — this is
        // the whole point: three renders that answer for twelve pages.
        url("/products/p01"), url("/products/p02"), url("/products/p03"),
        // Then the size-1 types, which tie on size and fall back to URL.
        url("/collections/c00"), url("/collections/c01"),
      ],
      budget: 5,
      suspects: 0,
      sampled: 23,
      truncated: true,
    });

    // The regression this pins, stated as the claim it is: the largest template
    // is represented at all. Under the alphabetical cut this count was 0.
    const products = result.selected.filter((u) => u.includes("/products/"));
    expect(products).toHaveLength(3);
  });

  it("returns the identical selection and stats on a re-run", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, SUSPICION_SITE);
    const cfg = { renderBudgetPct: 100, renderSamplePerType: 3 };

    const first = await selectRenderSet(db, crawlId, cfg);
    const stateAfterFirst = await frontierState(crawlId);
    const second = await selectRenderSet(db, crawlId, cfg);

    expect(second).toEqual(first);
    // And the frontier is where it was: a re-run moves no row, adds no row.
    expect(await frontierState(crawlId)).toEqual(stateAfterFirst);
    expect(Object.values(stateAfterFirst).every((s) => s === "render_pending")).toBe(true);
  });

  /**
   * THE BUDGET SITE. Twelve pages, all typed `content`, five of them suspects:
   *
   *   /h/1 … /h/7   healthy
   *   /s/1 … /s/5   framework markers → suspects
   *
   * One cohort, so the 3-per-type sample takes the three lowest URLs of all
   * twelve — `/h/1 /h/2 /h/3` ('h' sorts before 's'). Candidates are therefore
   * 5 suspects + 3 sample-only = 8, and the budget is what decides how many of
   * those eight are actually rendered.
   *
   * One cohort also means every candidate carries the same `type_size`, so the
   * cut's middle key ties and the order is tier then URL throughout. That is
   * deliberate: this site is about the BUDGET, and the template-size ordering
   * is pinned separately by the gate site above.
   */
  const BUDGET_SITE: PageSpec[] = [
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => ({ path: `/h/${i}` })),
    ...[1, 2, 3, 4, 5].map((i) => ({
      path: `/s/${i}`,
      frameworkMarkers: ["__NEXT_DATA__"],
    })),
  ];

  it("caps at the budget, prefers suspects, and says it truncated", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, BUDGET_SITE);

    // budget = min(ceil(12 * 100/100), 4) = 4. Eight candidates, four seats,
    // suspects first: /s/1 … /s/4. The fifth suspect and all three sample rows
    // are cut, and `truncated` is how a reader learns that.
    const capped = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderMaxPages: 4,
      renderSamplePerType: 3,
    });
    expect(capped).toEqual<RenderSelection>({
      selected: [url("/s/1"), url("/s/2"), url("/s/3"), url("/s/4")],
      budget: 4,
      suspects: 5,
      sampled: 3,
      truncated: true,
    });
    expect(await frontierState(crawlId)).toEqual({
      [url("/s/1")]: "render_pending",
      [url("/s/2")]: "render_pending",
      [url("/s/3")]: "render_pending",
      [url("/s/4")]: "render_pending",
    });

    // Seven seats: every suspect, then the two lowest-URL sample rows.
    const wider = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderMaxPages: 7,
      renderSamplePerType: 3,
    });
    expect(wider).toEqual<RenderSelection>({
      selected: [
        url("/s/1"), url("/s/2"), url("/s/3"), url("/s/4"), url("/s/5"),
        url("/h/1"), url("/h/2"),
      ],
      budget: 7,
      suspects: 5,
      sampled: 3,
      truncated: true,
    });

    // And a narrower re-selection DEMOTES the rows it no longer names: a
    // render_pending row left standing from a wider run would be rendered by
    // the pass and quietly break the budget this run just set.
    const narrower = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderMaxPages: 2,
      renderSamplePerType: 3,
    });
    expect(narrower.selected).toEqual([url("/s/1"), url("/s/2")]);
    expect(await frontierState(crawlId)).toEqual({
      [url("/s/1")]: "render_pending",
      [url("/s/2")]: "render_pending",
      [url("/s/3")]: "done",
      [url("/s/4")]: "done",
      [url("/s/5")]: "done",
      [url("/h/1")]: "done",
      [url("/h/2")]: "done",
    });
  });

  it("recomputes the same stats afterwards, without touching the frontier", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, BUDGET_SITE);
    const cfg = { renderBudgetPct: 100, renderMaxPages: 4, renderSamplePerType: 3 };

    const selected = await selectRenderSet(db, crawlId, cfg);
    const before = await frontierState(crawlId);

    // `render.coverage` (P5-T5) has to quote the sampling story after the pass
    // has run and the selection object is long gone. These are the same four
    // numbers, from the same CTEs, and asking for them changes nothing.
    const stats = await renderSelectionStats(db, crawlId, cfg);
    expect(stats).toEqual({
      budget: selected.budget,
      suspects: selected.suspects,
      sampled: selected.sampled,
      truncated: selected.truncated,
    });
    expect(stats).toEqual({ budget: 4, suspects: 5, sampled: 3, truncated: true });
    expect(await frontierState(crawlId)).toEqual(before);
  });

  it("takes the percentage when it is the smaller of the two bounds", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, BUDGET_SITE);

    // budget = min(ceil(12 * 25/100), 500) = min(3, 500) = 3.
    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 25,
      renderSamplePerType: 3,
    });
    expect(result.budget).toBe(3);
    expect(result.selected).toEqual([url("/s/1"), url("/s/2"), url("/s/3")]);
    expect(result.truncated).toBe(true);
  });

  it("counts every crawled URL in the percentage, not only the renderable ones", async () => {
    const crawlId = await newCrawl();
    // Two renderable pages and eighteen 404s: 20 rows, so 25% is 5 seats even
    // though only two pages could ever fill them.
    await addPages(crawlId, [
      { path: "/a", frameworkMarkers: ["__NEXT_DATA__"] },
      { path: "/b", frameworkMarkers: ["__NEXT_DATA__"] },
      ...Array.from({ length: 18 }, (_, i) => ({
        path: `/gone/${i}`,
        fetchClass: "client_error",
        statusCode: 404,
        outlinks: false,
      })),
    ]);

    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 25,
      renderSamplePerType: 0,
    });
    expect(result.budget).toBe(5);
    expect(result.selected).toEqual([url("/a"), url("/b")]);
    expect(result.truncated).toBe(false);
  });

  it("reports an empty selection rather than nothing at all", async () => {
    const crawlId = await newCrawl();
    const result = await selectRenderSet(db, crawlId, {});
    expect(result).toEqual<RenderSelection>({
      selected: [],
      budget: 0,
      suspects: 0,
      sampled: 0,
      truncated: false,
    });
  });

  it("refuses a crawl id nothing knows", async () => {
    await expect(selectRenderSet(db, `crawl_${randomUUID()}`, {})).rejects.toThrow(
      /no such crawl/,
    );
  });

  it("refuses a render config that is out of range", async () => {
    const crawlId = await newCrawl();
    const bad: Record<string, unknown>[] = [
      { renderBudgetPct: 0 },
      { renderBudgetPct: 101 },
      { renderMaxPages: 0 },
      { renderMaxPages: 1.5 },
      { renderSamplePerType: -1 },
      { renderSamplePerType: 2.5 },
    ];
    for (const cfg of bad) {
      await expect(selectRenderSet(db, crawlId, cfg), JSON.stringify(cfg)).rejects.toThrow(
        RangeError,
      );
    }
  });
});

describe("the render pass's frontier state", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: {},
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    return id;
  }

  /** Two suspect pages plus a crawl-pass URL still waiting to be fetched. */
  async function primed(): Promise<string> {
    const crawlId = await newCrawl();
    await db.insert(pages).values(
      ["/one", "/two"].map((path) => ({
        id: `page_${randomUUID()}`,
        crawlId,
        url: url(path),
        urlNormalised: url(path),
        pageType: "content",
        fetchClass: "ok",
        statusCode: 200,
        isIndexable: true,
        wordCount: 400,
        htmlBytes: 40_000,
        title: "A title",
        frameworkMarkers: ["__NEXT_DATA__"],
        depth: 1,
        discoveredVia: "link",
      })),
    );
    await enqueueUrls(db, crawlId, [
      { url: url("/still-pending"), depth: 1, discoveredVia: "link" },
    ]);
    const result = await selectRenderSet(db, crawlId, {
      renderBudgetPct: 100,
      renderSamplePerType: 0,
    });
    expect(result.selected).toEqual([url("/one"), url("/two")]);
    return crawlId;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("counts render_pending separately from the crawl's four states", async () => {
    const crawlId = await primed();
    expect(await frontierCounts(db, crawlId)).toEqual({
      pending: 1,
      leased: 0,
      done: 0,
      failed: 0,
      renderPending: 2,
    });
  });

  it("is invisible to the crawl pass's lease, before and after a render lease", async () => {
    const crawlId = await primed();

    // The crawl-pass lease sees exactly the one genuinely-pending URL, and asks
    // for far more than that.
    const crawlBatch = await leaseBatch(db, crawlId, "crawl-worker", 10, 60);
    expect(crawlBatch.map((r) => r.url)).toEqual([url("/still-pending")]);

    // Now lease the render set and let its lease expire. A render row NEVER
    // enters state 'leased', so the crawl pass's expired-lease reclaim
    // (`state = 'leased' and leased_until < now()`) cannot reach it either.
    const rendered = await leaseRenderUrls(db, crawlId, "render-worker", 10, 60);
    expect(rendered.map((r) => r.url)).toEqual([url("/one"), url("/two")]);
    expect(rendered.map((r) => r.attempts)).toEqual([1, 1]);
    await db.execute(sql`
      update frontier set leased_until = now() - interval '1 hour'
      where crawl_id = ${crawlId} and state = 'render_pending'`);

    expect(await leaseBatch(db, crawlId, "crawl-worker-2", 10, 60)).toEqual([]);
  });

  it("leases a render row once, and again only once its deadline has passed", async () => {
    const crawlId = await primed();

    const first = await leaseRenderUrls(db, crawlId, "r1", 10, 600);
    expect(first.map((r) => r.url)).toEqual([url("/one"), url("/two")]);
    // Held: a second worker gets nothing while the deadline stands.
    expect(await leaseRenderUrls(db, crawlId, "r2", 10, 600)).toEqual([]);

    await db.execute(sql`
      update frontier set leased_until = now() - interval '1 second'
      where crawl_id = ${crawlId} and state = 'render_pending'`);
    const second = await leaseRenderUrls(db, crawlId, "r2", 10, 600);
    expect(second.map((r) => r.url)).toEqual([url("/one"), url("/two")]);
    // The attempt count is the row's own, incremented as it is leased.
    expect(second.map((r) => r.attempts)).toEqual([2, 2]);
  });

  it("releases its own render leases without touching the crawl's", async () => {
    const crawlId = await primed();
    await leaseBatch(db, crawlId, "crawl-worker", 10, 600);
    await leaseRenderUrls(db, crawlId, "r1", 1, 600);

    expect(await releaseRenderLeases(db, crawlId, "someone-else")).toBe(0);
    expect(await releaseRenderLeases(db, crawlId, "r1")).toBe(1);

    // The released row is leasable again immediately, alongside the one that
    // was never leased; the crawl worker's lease is untouched.
    expect((await leaseRenderUrls(db, crawlId, "r2", 10, 600)).map((r) => r.url)).toEqual([
      url("/one"),
      url("/two"),
    ]);
    expect(await frontierCounts(db, crawlId)).toEqual({
      pending: 0,
      leased: 1,
      done: 0,
      failed: 0,
      renderPending: 2,
    });
  });

  it("rejects a render lease of nothing", async () => {
    const crawlId = await primed();
    await expect(leaseRenderUrls(db, crawlId, "r1", 0, 60)).rejects.toThrow(RangeError);
    await expect(leaseRenderUrls(db, crawlId, "r1", 5, -1)).rejects.toThrow(RangeError);
  });
});

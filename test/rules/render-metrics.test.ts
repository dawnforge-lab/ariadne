/**
 * `render.coverage`, against a real database.
 *
 * Every number in this file is hand-derived from the six-page site built below
 * — the suspicion triggers each page does or does not carry, the per-type sample
 * the selection takes, and the budget the crawl's own config works out to —
 * rather than copied from what the SQL produced, which would assert only that
 * the query is deterministic.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { RENDER_DEFAULTS, RENDER_URLS_KEY, SUSPICION } from "../../src/crawl/render/select.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { renderMetrics } from "../../src/rules/metric/render-metrics.js";
import {
  databaseUrl,
  dropCrawls,
  expectRefusesUnknownCrawl,
  metricLookup,
  metricRowsByScope,
  newMetricCrawl,
} from "./metric-db.js";

const SITE = "https://coverage.example";
const url = (path: string): string => `${SITE}${path}`;
const rule = metricLookup(renderMetrics, "renderMetrics");

describe("renderMetrics metadata", () => {
  it("defines the coverage metric, scoped to the site and evidencing CHECK-01", () => {
    expect(renderMetrics.map((r) => r.id)).toEqual(["render.coverage"]);
    const r = rule("render.coverage");
    expect(r.kind).toBe("metric");
    // A metric states what was counted and accuses nobody, so `metricRule`
    // gives it `info` and offers no other choice.
    expect(r.severity).toBe("info");
    expect(r.checkIds).toEqual(["CHECK-01"]);
    expect(r.category).toBe("crawl");
    expect(r.title.length).toBeGreaterThan(5);
    expect(r.explanation.length).toBeGreaterThan(40);
  });
});

describe("render.coverage against the database", () => {
  let db: Db;
  const created: string[] = [];

  /**
   * A crawled page, described by the suspicion triggers it carries.
   *
   * The defaults are a page the selection has NO reason to suspect: a
   * normal-sized document with a title, plenty of words, no framework marker —
   * and `addPages` gives every page an outgoing link, because "links nowhere" is
   * itself a trigger and would otherwise make the whole site suspect.
   */
  interface PageSpec {
    path: string;
    pageType: string;
    /** A hydration marker in the raw HTML — the framework trigger. */
    frameworkMarkers?: string[];
    wordCount?: number;
    /**
     * What the thin suspicion trigger reads (Phase 7). Undefined means "the
     * same as `wordCount`" — the shape of a page whose markup hides nothing,
     * which is what these fixtures are — so the selection arithmetic below is
     * the same arithmetic it was before the trigger changed column.
     */
    renderableWordCount?: number | null;
    htmlBytes?: number;
    rendered?: boolean;
    renderError?: string | null;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    const rows = specs.map((s) => {
      const full = url(s.path);
      const normalised = normalizeUrl(full);
      if (normalised === null) throw new Error(`${full} does not normalise`);
      const rendered = s.rendered ?? false;
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
        pageType: s.pageType,
        title: "A perfectly reasonable page title here",
        wordCount: s.wordCount ?? 400,
        renderableWordCount:
          s.renderableWordCount === undefined ? (s.wordCount ?? 400) : s.renderableWordCount,
        htmlBytes: s.htmlBytes ?? 40_000,
        frameworkMarkers: s.frameworkMarkers ?? [],
        rendered,
        renderedWordCount: rendered ? 400 : null,
        renderedLinkCount: rendered ? 20 : null,
        renderedNavLinkCount: rendered ? 12 : null,
        renderedFooterLinkCount: rendered ? 8 : null,
        renderedFilterLinkCount: rendered ? 0 : null,
        renderError: s.renderError ?? null,
      };
    });
    await db.insert(pages).values(rows);
    await db.insert(links).values(
      rows.map((r) => ({
        crawlId,
        sourcePageId: r.id,
        targetUrl: url("/"),
        targetPageId: null,
        isInternal: true,
        position: 0,
      })),
    );
  }

  /**
   * THE SITE, six pages, and what the selection makes of it.
   *
   * Page types and suspicion:
   *   /a1  type a  framework marker            SUSPECT
   *   /a2  type a  10 words in 60,000 bytes    SUSPECT (thin: < 50 RENDERABLE
   *                                          words in > 50KB — this page hides
   *                                          nothing, so its renderable count
   *                                          is its word count)
   *   /a3  type a  clean
   *   /a4  type a  clean
   *   /b1  type b  clean
   *   /b2  type b  clean
   *
   * The per-type sample takes `renderSamplePerType` pages of each type in URL
   * order. Candidates are the union, a page that is both counted once on the
   * suspect side (`min(tier)`).
   */
  const SITE_PAGES: PageSpec[] = [
    { path: "/a1", pageType: "a", frameworkMarkers: ["__NEXT_DATA__"] },
    { path: "/a2", pageType: "a", wordCount: 10, htmlBytes: 60_000 },
    { path: "/a3", pageType: "a" },
    { path: "/a4", pageType: "a" },
    { path: "/b1", pageType: "b" },
    { path: "/b2", pageType: "b" },
  ];

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await dropCrawls(db, created);
    await closeDb(db);
  });

  // The thresholds the derivations below depend on. Pinned as values so a
  // change to the selection's calibration fails here rather than making the
  // arithmetic in the comments quietly wrong.
  it("pins the selection constants the hand-derivations use", () => {
    expect(RENDER_DEFAULTS).toEqual({
      renderBudgetPct: 5,
      renderMaxPages: 500,
      renderSamplePerType: 3,
    });
    expect(SUSPICION.thinWordCount).toBe(50);
    expect(SUSPICION.thinHtmlBytes).toBe(50 * 1024);
  });

  /**
   * A crawl configured with none of the three render knobs, which is the
   * commonest row: the pass ran on the resolved defaults.
   *
   *   budget  = min(ceil(6 × 5 / 100), 500) = min(ceil(0.3), 500) = min(1, 500) = 1
   *   sample  = 3 per type, in URL order:  a → a1, a2, a3;  b → b1, b2
   *   suspects = {a1, a2}                                          → 2
   *   sampled  = {a3, b1, b2}   (a1 and a2 are already suspects)   → 3
   *   total    = 5, budget 1, so truncated = true and selected = min(1, 5) = 1
   *
   * The evidence side is deliberately NOT consistent with that: two pages carry
   * render evidence — one rendered, one failed — against a budget of one. That
   * is the shape the rule refuses to assert away, and it is a real one: a crawl
   * re-selected under a smaller budget keeps the earlier pass's rendered columns
   * on pages this selection does not name.
   */
  it("counts both sides of a crawl configured with the default knobs", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
    });
    await addPages(
      crawlId,
      SITE_PAGES.map((p) =>
        p.path === "/a1"
          ? { ...p, rendered: true }
          : p.path === "/a2"
            ? { ...p, renderError: "navigation timeout after 15000ms" }
            : p,
      ),
    );

    const rows = await metricRowsByScope(db, rule("render.coverage"), crawlId);
    expect(Object.keys(rows)).toEqual(["site|"]);
    expect(rows["site|"]).toEqual({
      pagesCrawled: 6,
      // P8-T2: which decision chose these pages. Automatic here — no URL
      // list is on the crawl row.
      selectionMode: "auto",
      selectionBudget: 1,
      selectionSuspects: 2,
      selectionSampled: 3,
      selectionSelected: 1,
      selectionTruncated: true,
      pagesRendered: 1,
      renderFailures: 1,
    });
  });

  /**
   * The same six pages under the crawl's OWN knobs, which is what says the
   * config is read from the row rather than taken from the ambient defaults.
   *
   *   renderBudgetPct 50, renderMaxPages 2, renderSamplePerType 1
   *   budget  = min(ceil(6 × 50 / 100), 2) = min(3, 2) = 2
   *   sample  = 1 per type, in URL order:  a → a1;  b → b1
   *   suspects = {a1, a2}                       → 2
   *   sampled  = {b1}   (a1 is already a suspect) → 1
   *   total    = 3, budget 2, so truncated = true and selected = min(2, 3) = 2
   *
   * Every number but `pagesCrawled` differs from the case above, over an
   * identical site: the config is the only input that moved.
   */
  it("reads the render knobs from the crawl's own config, not from the defaults", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: {
        userAgent: "AriadneBot-test",
        maxPages: 500,
        renderBudgetPct: 50,
        renderMaxPages: 2,
        renderSamplePerType: 1,
      },
    });
    await addPages(crawlId, SITE_PAGES);

    const rows = await metricRowsByScope(db, rule("render.coverage"), crawlId);
    expect(rows["site|"]).toEqual({
      pagesCrawled: 6,
      // P8-T2: which decision chose these pages. Automatic here — no URL
      // list is on the crawl row.
      selectionMode: "auto",
      selectionBudget: 2,
      selectionSuspects: 2,
      selectionSampled: 1,
      selectionSelected: 2,
      selectionTruncated: true,
      pagesRendered: 0,
      renderFailures: 0,
    });
  });

  /**
   * A budget wide enough for every candidate: `truncated` goes false and
   * `selectionSelected` becomes the candidate total rather than the budget.
   *
   *   renderBudgetPct 100, renderMaxPages 500, sample 3 (default)
   *   budget   = min(ceil(6 × 100 / 100), 500) = 6
   *   suspects = 2, sampled = 3, total = 5 ≤ 6 → truncated false, selected 5
   *
   * Note `selected` is 5 and not 6: the budget is seats, not a quota, and the
   * two pages nothing suspected and no sample reached (`/a4`) are simply not
   * candidates.
   */
  it("reports an untruncated selection when the budget covers every candidate", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: { userAgent: "AriadneBot-test", maxPages: 500, renderBudgetPct: 100 },
    });
    await addPages(crawlId, SITE_PAGES);

    const rows = await metricRowsByScope(db, rule("render.coverage"), crawlId);
    expect(rows["site|"]).toEqual({
      pagesCrawled: 6,
      // P8-T2: which decision chose these pages. Automatic here — no URL
      // list is on the crawl row.
      selectionMode: "auto",
      selectionBudget: 6,
      selectionSuspects: 2,
      selectionSampled: 3,
      selectionSelected: 5,
      selectionTruncated: false,
      pagesRendered: 0,
      renderFailures: 0,
    });
  });

  // A crawl with no pages: every number is zero and the row still exists. The
  // alternative — no row — would leave a reader unable to tell "nothing was
  // rendered" from "the metric did not run" (hard rule 7).
  it("writes its row for a crawl with no pages at all", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created);
    const rows = await metricRowsByScope(db, rule("render.coverage"), crawlId);
    expect(rows["site|"]).toEqual({
      pagesCrawled: 0,
      // P8-T2: which decision chose these pages. Automatic here — no URL
      // list is on the crawl row.
      selectionMode: "auto",
      selectionBudget: 0,
      selectionSuspects: 0,
      selectionSampled: 0,
      selectionSelected: 0,
      selectionTruncated: false,
      pagesRendered: 0,
      renderFailures: 0,
    });
  });

  /**
   * P8-T2. THE EXPLICIT SELECTION, and the whole reason `selectionMode` exists.
   *
   * The same six pages, the same default knobs — so the AUTOMATIC decision over
   * this crawl is the first case in this file, `budget 1 / suspects 2 /
   * sampled 3 / selected 1 / truncated true`. None of that happened. The render
   * pass was handed three URLs, and the record of that is the `renderUrls` list
   * the pass wrote onto the crawl's config (`RENDER_URLS_KEY`).
   *
   * So every automatic number is NULL, and the numbers it would have reported
   * are named here to make the point: reporting them, or reporting zeroes in
   * their place, would describe a decision that was never taken.
   */
  it("reports an explicit selection as explicit, with the automatic numbers null", async () => {
    const named = [url("/a3"), url("/b1"), url("/b2")];
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: {
        userAgent: "AriadneBot-test",
        maxPages: 500,
        [RENDER_URLS_KEY]: named,
      },
    });
    await addPages(
      crawlId,
      SITE_PAGES.map((p) => (named.includes(url(p.path)) ? { ...p, rendered: true } : p)),
    );

    const rows = await metricRowsByScope(db, rule("render.coverage"), crawlId);
    expect(rows["site|"]).toEqual({
      pagesCrawled: 6,
      selectionMode: "explicit",
      // Null, not 1 — the budget the automatic decision would have had — and
      // not 0 either, which reads as "a budget of none".
      selectionBudget: null,
      // Null, not 2. `/a1` and `/a2` are still suspicious pages; nothing asked.
      selectionSuspects: null,
      selectionSampled: null,
      // The list's length, and that is the whole derivation: every entry was
      // checked against this crawl's pages before the pass ran.
      selectionSelected: 3,
      selectionTruncated: null,
      pagesRendered: 3,
      renderFailures: 0,
    });
  });

  // An explicit list of one is still an explicit list. Worth its own case
  // because `selectionSelected: 1` is also what the automatic decision reports
  // on this site — the two rows are told apart by the mode and by nothing else.
  it("does not mistake a one-page list for the automatic budget of one", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: { userAgent: "AriadneBot-test", maxPages: 500, [RENDER_URLS_KEY]: [url("/a3")] },
    });
    await addPages(crawlId, SITE_PAGES);

    const rows = await metricRowsByScope(db, rule("render.coverage"), crawlId);
    expect(rows["site|"]).toMatchObject({
      selectionMode: "explicit",
      selectionSelected: 1,
      selectionBudget: null,
    });
  });

  // An explicit NULL is what an automatic pass writes over an earlier list, and
  // it must read as the automatic selection rather than as an empty one.
  it("reads a null URL list as the automatic selection it is", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: { userAgent: "AriadneBot-test", maxPages: 500, [RENDER_URLS_KEY]: null },
    });
    await addPages(crawlId, SITE_PAGES);

    const rows = await metricRowsByScope(db, rule("render.coverage"), crawlId);
    expect(rows["site|"]).toMatchObject({
      selectionMode: "auto",
      selectionBudget: 1,
      selectionSuspects: 2,
      selectionSelected: 1,
    });
  });

  // A shape this rule cannot read stops it, for the same reason a non-numeric
  // knob does and with a sharper consequence: guessing "automatic" would be a
  // claim about HOW the pages were chosen, made from a value nobody can read.
  it("refuses a stored URL list that is not an array of strings", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: { userAgent: "AriadneBot-test", maxPages: 500, [RENDER_URLS_KEY]: "/a3" },
    });
    await expect(rule("render.coverage").run(db, crawlId)).rejects.toThrow(
      /config\.renderUrls is neither null nor an array of strings/,
    );
  });

  // A stored knob that is not a number stops the metric, naming the crawl and
  // the key. Without this it would reach `resolveRenderConfig` and be reported
  // as a range problem — the loop's own ruling, from the other end of the same
  // column (`resumeCrawl` refuses the same row).
  it("refuses a config whose render knobs are not numbers", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: { userAgent: "AriadneBot-test", maxPages: 500, renderMaxPages: "500" },
    });
    await expect(rule("render.coverage").run(db, crawlId)).rejects.toThrow(
      /config\.renderMaxPages is string, not a number/,
    );
  });

  // …and a nonsense NUMBER is refused too, by the selection's own range check:
  // the metric describes a selection, so a config no selection could have run
  // under is a metric with nothing to describe.
  it("refuses a config whose render budget is out of range", async () => {
    const crawlId = await newMetricCrawl(db, SITE, created, {
      config: { userAgent: "AriadneBot-test", maxPages: 500, renderBudgetPct: 0 },
    });
    await expect(rule("render.coverage").run(db, crawlId)).rejects.toThrow(/renderBudgetPct/);
  });

  it("refuses a crawl id nothing knows", async () => {
    await expectRefusesUnknownCrawl(db, renderMetrics);
  });

  it("reads only its own crawl", async () => {
    const other = await newMetricCrawl(db, SITE, created);
    await addPages(other, SITE_PAGES);
    const mine = await newMetricCrawl(db, SITE, created);
    const rows = await metricRowsByScope(db, rule("render.coverage"), mine);
    expect(rows["site|"]).toMatchObject({ pagesCrawled: 0, selectionSuspects: 0 });
  });
});

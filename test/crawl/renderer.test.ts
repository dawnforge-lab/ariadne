/**
 * The render pass, driven by a real Chromium against a real HTTP server.
 *
 * NOTHING HERE IS MOCKED. The browser is the browser, the site is a
 * `node:http` server on 127.0.0.1, the database is the dev Postgres, and the
 * third-party origin is a *second* server whose request log is the evidence
 * that a blocked request never left the machine. A stubbed browser would
 * assert that our stub calls our code; the whole point of this pass is what a
 * real engine does with a real page's JavaScript.
 *
 * The fixture site here is deliberately NOT the shared fixture app
 * (test/fixtures/app.ts): that site belongs to the end-to-end harness, whose
 * render pages arrive in T6. These pages exist to make one renderer behaviour
 * observable each, with every count hand-derived from the markup below.
 *
 * Timing: the renderer's real settle is 3s and its real navigation timeout is
 * 15s. Both are configuration. The SETTLE is driven down (500ms) everywhere,
 * because every page here finishes its script in single-digit milliseconds and
 * a settle only ever ends by expiring. The NAVIGATION TIMEOUT is not: it is
 * left at the production 15s for every test but the one that renders `/hang`,
 * which gets its own renderer at 1s. A shortened navigation timeout is a
 * DEADLINE ON A REAL PAGE ANSWERING, and applying it to tests that are not
 * about deadlines is how a loaded machine fails a test that has nothing wrong
 * with it — the hazard the final review named, alongside the settle margin
 * below that a loaded machine actually did lose. The DEFAULTS themselves are
 * pinned as constants, once, rather than paid for in every test.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages } from "../../src/db/schema.js";
import {
  completeUrls,
  enqueueUrls,
  frontierCounts,
  leaseBatch,
  leaseRenderUrls,
} from "../../src/crawl/frontier.js";
import { selectRenderSet } from "../../src/crawl/render/select.js";
import {
  PageRenderer,
  RENDERER_DEFAULTS,
  writeRenderResult,
  type RenderResult,
} from "../../src/crawl/render/renderer.js";
import { RENDER_PASS_DEFAULTS, runRenderPass } from "../../src/crawl/render/run-render.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * Test settle: long enough for an injected script, short enough to be free.
 *
 * THE MARGIN ARITHMETIC, because this number lost a race once. The slowest
 * script on this fixture site is the redirect timer, armed for
 * `REDIRECT_DELAY_MS` (5ms) — so the settle must outlast a 5ms timer under
 * whatever load the suite is running against. 500ms is a **100× margin**. The
 * previous pairing was 20ms against a 150ms settle (7.5×), and run B of the
 * final review lost it: the settle expired before the browser's timer fired,
 * and the redirect assertions failed on a machine, not on a bug.
 */
const SETTLE_MS = 500;
/**
 * Navigation timeout for the ONE test that renders `/hang` — the page that
 * answers headers and then nothing. That test can only end by waiting this out,
 * so it is 1s rather than the production 15s, and it is applied by that test's
 * own renderer. Nothing else in this file shortens the navigation timeout: see
 * the module header.
 */
const NAV_TIMEOUT_MS = 1_000;

// ---------------------------------------------------------------------------
// The fixture site. Every count asserted below is derived from this markup.
// ---------------------------------------------------------------------------

/**
 * `/csr`: raw HTML carries a two-word body; a script writes the rest. The raw
 * document has 2 words ("Loading now") and 0 anchors; the rendered DOM has 6
 * anchors — 2 in <nav>, 2 in <footer>, 2 loose — of which 3 look like filters
 * (`?sort=`, `?page=2`, `/facet/blue`) and 3 do not.
 *
 * THE WORD COUNT, DERIVED: 12 words in the injected paragraph, plus 3 for the
 * anchors. Three, not six, and the reason is `innerText` rather than a
 * tokenizer — two adjacent inline anchors with no whitespace between them
 * render as ONE text run, so `<a>a</a><a>b</a>` is the single word "ab". That
 * is what a reader sees on the page, which is what this column is for.
 */
const CSR_TEXT_WORDS = 12;
const CSR_ANCHOR_WORDS = 3;
const CSR_RENDERED_WORDS = CSR_TEXT_WORDS + CSR_ANCHOR_WORDS;
function csrHtml(): string {
  return `<!doctype html><html lang="en"><head><title>CSR</title></head>
<body><div id="app">Loading now</div>
<script>
document.getElementById('app').textContent = 'one two three four five six seven eight nine ten eleven twelve';
document.body.insertAdjacentHTML('beforeend',
  '<nav><a href="/a">a</a><a href="/b?sort=asc">b</a></nav>' +
  '<footer><a href="/c">c</a><a href="/d?page=2">d</a></footer>' +
  '<a href="/e">e</a><a href="/facet/blue">f</a>');
</script>
</body></html>`;
}

/**
 * How long after parsing the redirect pages wait before sending themselves on.
 *
 * Near-immediate rather than zero, and the reason is the renderer's contract:
 * the pass waits for `domcontentloaded` and THEN settles, so a navigation that
 * started before the first of those would abort the very `page.goto` being
 * awaited — a different failure from the one these fixtures are for. A timer
 * cannot preempt the parser's own task, so any delay at all is enough for
 * ordering; 5ms is the smallest that is also obviously enough. Against
 * `SETTLE_MS` (500ms) that is a 100× margin — see `SETTLE_MS`.
 */
const REDIRECT_DELAY_MS = 5;

/** `/js-redirect`: a page that sends itself somewhere else after paint. */
function jsRedirectHtml(target: string): string {
  return `<!doctype html><html lang="en"><head><title>Off we go</title></head>
<body><p>Redirecting</p><script>setTimeout(function(){location.replace(${JSON.stringify(
    target,
  )});}, ${REDIRECT_DELAY_MS});</script></body></html>`;
}

/**
 * `/third-party`: four subresources, one of each combination that matters —
 * another origin's script and image (both aborted as third-party), this site's
 * own image (aborted as paint-only) and this site's own script (allowed, and it
 * appends a word, which is how the test proves it ran).
 */
function thirdPartyHtml(otherOrigin: string): string {
  return `<!doctype html><html lang="en"><head><title>Third party</title>
<script src="${otherOrigin}/tracker.js"></script>
<script src="/own.js" defer></script></head>
<body><p>one two three</p><img src="${otherOrigin}/pixel.png" alt="pixel" width="1" height="1">
<img src="/own.png" alt="ours" width="1" height="1"></body></html>`;
}

/** `/static/{n}`: three same-host pages, for the politeness spacing test. */
function staticHtml(n: string): string {
  return `<!doctype html><html lang="en"><head><title>Static ${n}</title></head>
<body><p>page ${n} body text</p><a href="/a">a</a></body></html>`;
}

interface Site {
  base: string;
  /** Arrival time (ms) of every document request, in order. */
  hits: Array<{ path: string; at: number }>;
  close(): Promise<void>;
}

async function startSite(otherOrigin: () => string): Promise<Site> {
  const hits: Array<{ path: string; at: number }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push({ path, at: Date.now() });
    const html = (body: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    if (path === "/csr") return html(csrHtml());
    if (path === "/js-redirect") return html(jsRedirectHtml(`${siteBase(server)}/csr`));
    if (path === "/offsite-redirect") return html(jsRedirectHtml(`${otherOrigin()}/elsewhere`));
    if (path === "/third-party") return html(thirdPartyHtml(otherOrigin()));
    if (path.startsWith("/static/")) return html(staticHtml(path.slice("/static/".length)));
    if (path === "/own.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(0));
      return;
    }
    if (path === "/own.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      // A fourth word, appended only if this file was fetched AND executed.
      res.end("document.body.insertAdjacentHTML('beforeend', '<p>four</p>');");
      return;
    }
    if (path === "/hang") {
      // Headers, then silence: the navigation never reaches domcontentloaded.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><head><title>Hang</title>");
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>404</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: siteBase(server),
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

function siteBase(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** The other origin: it answers everything, and records that it was asked. */
async function startThirdParty(): Promise<Site> {
  const hits: Array<{ path: string; at: number }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ path: (req.url ?? "/").split("?")[0] ?? "/", at: Date.now() });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from somewhere else");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: siteBase(server),
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

describe("PageRenderer", () => {
  let site: Site;
  let third: Site;
  let renderer: PageRenderer;
  const blocked: string[] = [];

  beforeAll(async () => {
    third = await startThirdParty();
    site = await startSite(() => third.base);
    renderer = await PageRenderer.launch({
      origin: site.base,
      userAgent: "AriadneBot/0.1 (render test)",
      perHostDelayMs: 0,
      // No `navigationTimeoutMs`: the production 15s. Every page this renderer
      // is pointed at answers, so the timeout is never meant to be reached and
      // shortening it would only add a way to fail under load.
      settleMs: SETTLE_MS,
      allowPrivate: true,
      onRequestBlocked: (url) => blocked.push(url),
    });
  }, 120_000);

  afterAll(async () => {
    await renderer.close();
    await site.close();
    await third.close();
  });

  it("pins the production navigation timeout and settle", () => {
    expect(RENDERER_DEFAULTS.navigationTimeoutMs).toBe(15_000);
    expect(RENDERER_DEFAULTS.settleMs).toBe(3_000);
  });

  it("measures the DOM a browser builds, not the bytes the server sent", async () => {
    const result = await renderer.render(`${site.base}/csr`);

    expect(result.error).toBeNull();
    expect(result.rendered).toBe(true);
    // The raw document body carried 2 words ("Loading now"); the browser sees
    // 15. That delta is exactly what CHECK-01 exists to find.
    expect(result.wordCount).toBe(CSR_RENDERED_WORDS);
    expect(result.linkCount).toBe(6);
    expect(result.navLinkCount).toBe(2);
    expect(result.footerLinkCount).toBe(2);
    // `/b?sort=asc` and `/d?page=2` (a `?`) and `/facet/blue` (the word).
    expect(result.filterLinkCount).toBe(3);
    expect(result.redirectUrl).toBeNull();
  });

  it("records where a page sent itself with JavaScript", async () => {
    // Margin: the fixture's timer is armed for 5ms and the settle is 500ms, so
    // the browser has 100× the timer's own delay to fire it in (see SETTLE_MS).
    const result = await renderer.render(`${site.base}/js-redirect`);

    expect(result.error).toBeNull();
    expect(result.rendered).toBe(true);
    expect(result.redirectUrl).toBe(`${site.base}/csr`);
    // The measurement is of the page the browser ended on.
    expect(result.wordCount).toBe(CSR_RENDERED_WORDS);
  });

  it("blocks third-party and paint-only requests, and renders the page anyway", async () => {
    blocked.length = 0;
    const beforeThird = third.hits.length;
    const beforeSite = site.hits.length;

    const result = await renderer.render(`${site.base}/third-party`);

    expect(result.error).toBeNull();
    expect(result.rendered).toBe(true);

    // 1. THIRD PARTY: the other origin was never asked. Not "we ignored the
    // response" — the request never left the machine.
    expect(third.hits.length).toBe(beforeThird);
    expect(blocked.sort()).toEqual([`${third.base}/pixel.png`, `${third.base}/tracker.js`]);
    expect(result.blockedRequests).toBe(2);

    // 2. PAINT-ONLY, SAME ORIGIN: the site's own image is aborted too. It
    // cannot move a word count or an anchor count, and every one skipped is one
    // fewer request in the burst a browser makes at a client's server.
    const paths = site.hits.slice(beforeSite).map((h) => h.path);
    expect(paths).not.toContain("/own.png");
    expect(result.skippedPaintRequests).toBe(1);

    // 3. DOM-BUILDING, SAME ORIGIN: the site's own script is allowed, and the
    // word it appends is the proof it both arrived and ran. Blocking these
    // would make every client-rendered page look empty — the exact defect this
    // pass exists to detect.
    expect(paths).toContain("/own.js");
    expect(result.wordCount).toBe(4);
  });

  it("blocks an off-site navigation and records it as the redirect", async () => {
    // Same 5ms-against-500ms margin as the same-origin redirect above.
    const before = third.hits.length;

    const result = await renderer.render(`${site.base}/offsite-redirect`);

    // The other origin was never asked, and the page it wanted is recorded.
    expect(third.hits.length).toBe(before);
    expect(result.redirectUrl).toBe(`${third.base}/elsewhere`);
    // Chromium is left on its own error surface, so there is no DOM of this
    // site's to measure: a failed render carrying a redirect, not a render.
    expect(result.rendered).toBe(false);
    expect(result.error).toBe(`off-site navigation: ${third.base}/elsewhere`);
    expect(result.wordCount).toBeNull();
  });

  it("classifies a URL the policy refuses, without opening a page", async () => {
    const result = await renderer.render("http://169.254.169.254/latest/meta-data/");

    expect(result.rendered).toBe(false);
    expect(result.error).toMatch(/^policy refusal: /);
    expect(result.error).toContain("169.254.169.254");
    expect(result.wordCount).toBeNull();
  });

  it("classifies a navigation that never finishes as a timeout", async () => {
    // THE ONE TEST THAT SHORTENS THE NAVIGATION TIMEOUT, and it gets its own
    // browser to do it in. `/hang` sends headers and then goes quiet, so this
    // test can only end by waiting the timeout out: 1s here rather than the
    // production 15s the shared renderer above keeps. The cost is one extra
    // Chromium launch; the alternative — the shared renderer at 1s — puts a 1s
    // deadline on every OTHER test's real navigation, which is a way for a busy
    // machine to fail a test about anything but timeouts.
    const hangRenderer = await PageRenderer.launch({
      origin: site.base,
      userAgent: "AriadneBot/0.1 (render test)",
      perHostDelayMs: 0,
      navigationTimeoutMs: NAV_TIMEOUT_MS,
      settleMs: SETTLE_MS,
      allowPrivate: true,
    });
    try {
      const result = await hangRenderer.render(`${site.base}/hang`);

      expect(result.rendered).toBe(false);
      expect(result.error).toBe(
        `timeout: navigation did not reach domcontentloaded within ${NAV_TIMEOUT_MS}ms`,
      );
      expect(result.wordCount).toBeNull();
      expect(result.redirectUrl).toBeNull();
    } finally {
      await hangRenderer.close();
    }
  });

  it("classifies a navigation the server refuses to answer", async () => {
    const result = await renderer.render(`${site.base}/404`);

    // A 404 is still a document: the browser renders the error page, and the
    // render pass records what it saw. The selection never offers one (T3
    // filters to ok/200), so this only pins that nothing throws.
    expect(result.rendered).toBe(true);
    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The pass driver, against the database.
// ---------------------------------------------------------------------------

describe("runRenderPass", () => {
  let db: Db;
  let site: Site;
  let third: Site;
  const createdCrawls: string[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
    third = await startThirdParty();
    site = await startSite(() => third.base);
  }, 120_000);

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
    await site.close();
    await third.close();
  });

  function passConfig(overrides: Record<string, unknown> = {}): Parameters<typeof runRenderPass>[2] {
    return {
      siteUrl: site.base,
      userAgent: "AriadneBot/0.1 (render pass test)",
      perHostDelayMs: 0,
      // These sites are 1-3 pages: the production 5% budget would round down to
      // a single seat and the test would be asserting the budget, not the pass.
      renderBudgetPct: 100,
      allowPrivate: true,
      settleMs: SETTLE_MS,
      // No `navigationTimeoutMs`: the pass gets the production 15s. Only the
      // `/hang` test below overrides it, because only that test is about a
      // navigation deadline — see the module header.
      renderConcurrency: 2,
      ...overrides,
    } as Parameters<typeof runRenderPass>[2];
  }

  /**
   * A crawl with page rows for `paths`, each one a suspect (no outgoing links)
   * so the whole set is selected. Rows are inserted rather than crawled: what
   * is under test is the pass, not the crawler that fed it.
   */
  async function newCrawl(paths: string[]): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: site.base,
      config: {},
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    await db.insert(pages).values(
      paths.map((path) => ({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url: `${site.base}${path}`,
        urlNormalised: `${site.base}${path}`,
        pageType: "content",
        fetchClass: "ok",
        statusCode: 200,
        isIndexable: true,
        wordCount: 2,
        htmlBytes: 1_000,
        title: "A page",
        depth: 1,
        discoveredVia: "link",
      })),
    );
    // Every page is `done` in the frontier, which is what a crawled URL is —
    // and what `selectRenderSet` promotes out of.
    const urls = paths.map((path) => `${site.base}${path}`);
    await enqueueUrls(
      db,
      id,
      urls.map((url) => ({ url, depth: 1, discoveredVia: "link" })),
    );
    await completeUrls(db, id, urls);
    return id;
  }

  async function pageRow(crawlId: string, path: string) {
    const rows = await db
      .select()
      .from(pages)
      .where(and(eq(pages.crawlId, crawlId), eq(pages.url, `${site.base}${path}`)));
    return rows[0]!;
  }

  it("pins the pass defaults", () => {
    expect(RENDER_PASS_DEFAULTS.renderConcurrency).toBe(4);
  });

  it("refuses to run while the crawl is still live", async () => {
    const crawlId = await newCrawl(["/csr"]);
    // A URL the crawl has not reached yet, leased by the worker still crawling.
    // Selecting now would upsert `render_pending` over rows that worker owns.
    await enqueueUrls(db, crawlId, [
      { url: `${site.base}/still-crawling`, depth: 1, discoveredVia: "link" },
    ]);
    const leased = await leaseBatch(db, crawlId, "worker-crawl", 1, 60);
    expect(leased.length).toBe(1);

    await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow(/live crawl/i);
    // And it refused BEFORE selecting: nothing moved.
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(0);
  });

  it("refuses to run while another render pass holds leases", async () => {
    const crawlId = await newCrawl(["/csr", "/static/8"]);
    // The other pass: it selected, and its worker is holding a URL. Note that
    // this leaves NO row in state 'leased' — a render lease does not change
    // state — so the live-crawl check above cannot see this at all.
    await selectRenderSet(db, crawlId, { renderBudgetPct: 100 });
    const held = await leaseRenderUrls(db, crawlId, "other-render-worker", 1, 600);
    expect(held.length).toBe(1);
    expect((await frontierCounts(db, crawlId)).leased).toBe(0);

    await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow(
      /another render pass/i,
    );
    // The other pass's rows are exactly where it left them.
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(2);

    // An EXPIRED render lease is a dead worker's, and reclaiming it is the
    // resume mechanism — so it must not keep the guard shut forever.
    await db.execute(sql`
      update frontier set leased_until = now() - interval '1 hour'
      where crawl_id = ${crawlId} and leased_until is not null`);
    const summary = await runRenderPass(db, crawlId, passConfig());
    expect(summary.rendered).toBe(2);
  });

  it("refuses to run while the crawl row still says running", async () => {
    const crawlId = await newCrawl(["/csr"]);
    // No lease outstanding — a live crawl between batches, or one that died
    // mid-run and was never resumed or marked failed. Its frontier is in
    // flight either way, and its next lease would take rows we promoted.
    await db.update(crawls).set({ status: "running" }).where(eq(crawls.id, crawlId));

    await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow(/'running'/);
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(0);
  });

  it("renders a finished crawl that stopped at maxPages with URLs still queued", async () => {
    const crawlId = await newCrawl(["/csr"]);
    // What a capped crawl looks like: `finished`, with the frontier it never
    // got to still `pending`. On a real site this is the NORMAL outcome, so
    // refusing a queued frontier would refuse most crawls there are — the
    // guard asks whether the crawl stopped, not whether it drained.
    await enqueueUrls(db, crawlId, [
      { url: `${site.base}/never-reached`, depth: 1, discoveredVia: "link" },
    ]);
    expect((await frontierCounts(db, crawlId)).pending).toBe(1);

    const summary = await runRenderPass(db, crawlId, passConfig());

    expect(summary.rendered).toBe(1);
    expect((await pageRow(crawlId, "/csr")).rendered).toBe(true);
    // The URL the crawl never reached is left exactly where it was: the render
    // pass selects out of `pages`, and that URL has no page row.
    const counts = await frontierCounts(db, crawlId);
    expect(counts.pending).toBe(1);
    expect(counts.renderPending).toBe(0);
  });

  it("renders the selection, writes the columns and settles the frontier", async () => {
    const crawlId = await newCrawl(["/csr", "/js-redirect"]);

    const summary = await runRenderPass(db, crawlId, passConfig());

    expect(summary.rendered).toBe(2);
    expect(summary.failures).toBe(0);
    expect(summary.selection.selected.sort()).toEqual(
      [`${site.base}/csr`, `${site.base}/js-redirect`].sort(),
    );

    const csr = await pageRow(crawlId, "/csr");
    expect(csr.rendered).toBe(true);
    expect(csr.renderedWordCount).toBe(CSR_RENDERED_WORDS);
    expect(csr.renderedLinkCount).toBe(6);
    expect(csr.renderedNavLinkCount).toBe(2);
    expect(csr.renderedFooterLinkCount).toBe(2);
    expect(csr.renderedFilterLinkCount).toBe(3);
    expect(csr.renderedRedirectUrl).toBeNull();
    expect(csr.renderError).toBeNull();

    const redirected = await pageRow(crawlId, "/js-redirect");
    expect(redirected.renderedRedirectUrl).toBe(`${site.base}/csr`);

    const counts = await frontierCounts(db, crawlId);
    expect(counts.renderPending).toBe(0);
    expect(counts.done).toBe(2);

    const crawl = (await db.select().from(crawls).where(eq(crawls.id, crawlId)))[0]!;
    expect(crawl.renderPassCount).toBe(2);
  });

  it("records a failed render as evidence and never retries it", async () => {
    const crawlId = await newCrawl(["/hang"]);

    // The other half of the `/hang` pair, and the only pass in this file that
    // shortens the navigation timeout: this URL never answers, so the pass can
    // only get its failure by waiting the deadline out.
    const summary = await runRenderPass(
      db,
      crawlId,
      passConfig({ navigationTimeoutMs: NAV_TIMEOUT_MS }),
    );

    expect(summary.rendered).toBe(0);
    expect(summary.failures).toBe(1);

    const row = await pageRow(crawlId, "/hang");
    expect(row.rendered).toBe(false);
    expect(row.renderError).toMatch(/^timeout: /);
    expect(row.renderedWordCount).toBeNull();

    const frontierRows = await db
      .select()
      .from(frontier)
      .where(and(eq(frontier.crawlId, crawlId), eq(frontier.url, `${site.base}/hang`)));
    expect(frontierRows[0]!.state).toBe("done");
    // One lease, one attempt, no retry loop: the failure is the record.
    expect(frontierRows[0]!.attempts).toBe(1);
  });

  it("spaces same-host navigations by the configured per-host delay", async () => {
    // WARM-UP, and it is load-bearing.
    //
    // The measured gaps are between server-side ARRIVALS, so anything sitting
    // between acquiring the host gate and the request reaching the socket lands
    // inside a gap: gap = delay + (latency of the later navigation - latency of
    // the earlier one). That latency is not symmetric. A browser's FIRST
    // navigation pays to spin up its first renderer process and page in
    // Chromium's libraries; the ones after it do not. So the first arrival
    // slipped late, the second was on time, the gap between them came out
    // ~950ms, and under load this flaked about one run in three.
    //
    // The Phase 5 ruling stands and the tolerance below must NOT be widened: it
    // guards a ~57ms bug and a wider margin would hide it. The asymmetry is the
    // thing to remove, so FOUR pages are rendered and the first arrival is
    // discarded as the warm-up. It has to be a page in THIS pass, not a
    // separate one: `runRenderPass` launches its own browser, so a warm-up in
    // another pass leaves this browser's first navigation still cold (measured:
    // it bought ~15ms of the ~50ms needed).
    //
    // Which of the four is the warm-up is not fixed — three workers race for
    // the gate — and it does not need to be: they are the same page, so
    // dropping arrival[0] drops the cold one whichever URL it was. The two gaps
    // that remain are between warm navigations, and both still see the ~57ms
    // bug, which was paid on every render rather than only the first.
    const paths = ["/static/1", "/static/2", "/static/3", "/static/4"];
    const crawlId = await newCrawl(paths);
    const before = site.hits.length;
    // A SECOND OF DELAY AGAINST 50ms OF TOLERANCE, deliberately. The bug this
    // test exists to catch — acquiring the gate before launching the context,
    // so our own setup was spent out of the site's spacing — cost ~57ms and
    // slipped under a 400ms/50ms margin. The regression has to be impossible to
    // hide in timer noise, so the signal is 20x the noise.
    const delayMs = 1_000;
    const epsilonMs = 50;

    await runRenderPass(db, crawlId, passConfig({ perHostDelayMs: delayMs, renderConcurrency: 3 }));

    // Measured at the SERVER, not in the renderer: what politeness means is
    // when the request arrived, not when we decided to make it.
    const arrivals = site.hits
      .slice(before)
      .filter((h) => h.path.startsWith("/static/"))
      .map((h) => h.at);
    expect(arrivals.length).toBe(4);
    // arrivals[0] is the warm-up. Every gap asserted is warm-to-warm.
    expect(arrivals[2]! - arrivals[1]!).toBeGreaterThanOrEqual(delayMs - epsilonMs);
    expect(arrivals[3]! - arrivals[2]!).toBeGreaterThanOrEqual(delayMs - epsilonMs);
  });

  it("leaves its selection alone when the pass is aborted before it starts", async () => {
    const crawlId = await newCrawl(["/csr", "/static/9"]);
    const signal = AbortSignal.abort();

    const summary = await runRenderPass(db, crawlId, passConfig(), { signal });

    expect(summary.rendered).toBe(0);
    expect(summary.failures).toBe(0);
    // The honest count of what the abort left behind, not a rounding error.
    expect(summary.unrendered).toBe(2);
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(2);
    // No lease outlives the pass: a resumed pass may start immediately.
    const rows = await db.select().from(frontier).where(eq(frontier.crawlId, crawlId));
    expect(rows.every((r) => r.leasedUntil === null)).toBe(true);
  });

  it("refuses to write a render result for a page row that is not there", async () => {
    const crawlId = await newCrawl(["/csr"]);
    const ghost: RenderResult = {
      url: `${site.base}/not-a-page`,
      rendered: true,
      wordCount: 1,
      linkCount: 0,
      navLinkCount: 0,
      footerLinkCount: 0,
      filterLinkCount: 0,
      redirectUrl: null,
      error: null,
      blockedRequests: 0,
      skippedPaintRequests: 0,
    };

    await expect(writeRenderResult(db, crawlId, ghost)).rejects.toThrow(/no page row/i);
  });
});

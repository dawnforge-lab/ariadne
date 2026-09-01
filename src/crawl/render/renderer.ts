/**
 * The browser half of the render pass: one URL in, one measured DOM out.
 *
 * The crawl pass reads bytes with a streaming tokenizer and never builds a DOM
 * (hard rule 4). That is the right trade for 50,000 URLs and the wrong one for
 * the handful of pages whose content only exists after JavaScript has run — so
 * this file is the deliberate exception, kept behind a budgeted selection
 * (src/crawl/render/select.ts) and a driver that never lets more than
 * `renderConcurrency` browser contexts exist at once (run-render.ts).
 *
 * Four things this module is strict about, because each of them is a hard rule
 * standing behind it:
 *
 *  - **url-policy on every navigation (rule 5).** `isUrlAllowed` runs before a
 *    context is even created, and again inside the route handler for any
 *    document the page navigates *itself* to. A refusal is a classified
 *    `render_error`, never a skipped URL.
 *  - **Politeness (rule 9), in two halves.** Every navigation passes through a
 *    `HostGate`, so the render pass spaces its hits on a host exactly as the
 *    crawl does — that is why the gate is the renderer's own and not something
 *    a caller may forget to wire. But a browser is a burstier client than a
 *    fetch: the gate spaces the *documents*, and each document is still a burst
 *    of subresource requests the gate never sees. So the second half is the
 *    route handler aborting the same-origin requests that cannot affect the
 *    measurement — `image`, `media`, `font` (`PAINT_ONLY_RESOURCES`). What
 *    remains of the burst is script, stylesheet and xhr/fetch, which a
 *    client-rendered page needs to build the DOM at all; that residual is
 *    bounded by the site's own code and is measured at the phase-5 gate.
 *  - **No third-party traffic.** Route interception aborts every request whose
 *    origin is not the crawl's. We are auditing one site; pulling a client's
 *    analytics, ad and font vendors into the record would be both impolite and
 *    non-deterministic. A blocked request never fails the render: the page is
 *    measured as the site's own bytes render it.
 *  - **No silent fallbacks (rule 7).** A timeout, a navigation error and a
 *    policy refusal are three different classified strings on the page row, and
 *    every one of them leaves `rendered = false` with the five measurement
 *    columns null. "Rendered and empty" and "never rendered" stay different
 *    facts.
 *
 * THE DOM IS MEASURED TWICE, BY TWO DIFFERENT INSTRUMENTS, and the two answers
 * are kept in two families of columns that no rule may mix (see the family
 * blocks on `pages` in src/db/schema.ts):
 *
 *  1. **`MEASURE_SCRIPT`, in the page** (P5-T4): `innerText` and
 *     `querySelectorAll` — what a READER sees, which no tokenizer can compute
 *     without doing layout.
 *  2. **`analyzeHtml`, over the serialised post-JS DOM** (P8-T1): the SAME
 *     streaming analyzer the crawl ran over the bytes the server sent.
 *
 * **WHY THE SECOND ONE EXISTS, in one paragraph, because it is the whole of
 * Phase 8 Task 1.** A diff is a subtraction, and a subtraction is only
 * meaningful between two answers to the same question. Comparing the analyzer's
 * `renderable_word_count` against `innerText` was not that: the analyzer cannot
 * cascade CSS (hard rules 2 and 4), so every word a stylesheet hides is on the
 * raw side of the subtraction and on neither side of the rendered one. The
 * Phase 7 gate measured what that costs on a real Shopify theme
 * (docs/gates/phase-7.md §4.2): a **near-constant 425-word offset** across 28
 * rendered pages — one block of class-hidden chrome, identical on a 196-word
 * page and on an 1,137-word one — which made `content.csr-dependent`'s firing
 * condition arithmetically unreachable on that crawl whatever the site did
 * (§4.9). **That chrome markup is present in BOTH documents.** It is in the
 * bytes the server sent and it is in the DOM the browser built; only the
 * *renderer* knows it is invisible. So measuring both documents with the SAME
 * instrument puts the chrome on both sides of the subtraction, where it
 * cancels, and what is left is the text JavaScript added — which is what the
 * rule was always about.
 *
 * The serialised HTML crosses the process seam ONCE, is analysed and written to
 * disk, and is not held: RAM stays O(concurrency × page size), never O(URLs),
 * which is the memory contract (rule 6) applied to a browser. The file written
 * is byte-identical to the string the numbers were computed from, so an auditor
 * who disbelieves a finding can re-run the analyzer over the evidence itself.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, errors as playwrightErrors, type Browser, type Route } from "playwright";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { HostGate } from "../politeness.js";
import { analyzeHtml, type RawPageAnalysis } from "../parse/page-analyzer.js";
import { isSameOrigin, normalizeUrl } from "../parse/url-utils.js";
import { isUrlAllowed } from "../url-policy.js";

/**
 * The two waits, as production runs them.
 *
 * `domcontentloaded` rather than `load` or `networkidle`: `load` waits on every
 * image and font, and `networkidle` never arrives on a page with a polling
 * script or an open websocket — both would turn a slow ad script into a
 * timeout. The fixed settle after it is what a client-rendered page actually
 * needs (parse, hydrate, first paint of the real content), and it is a wait
 * rather than a heuristic because "the app is finished" is not a signal the DOM
 * exposes.
 */
export const RENDERER_DEFAULTS = {
  navigationTimeoutMs: 15_000,
  settleMs: 3_000,
} as const;

/**
 * Same-origin request types this pass aborts: they decide how the page LOOKS,
 * never what it SAYS. Nothing here can move `innerText` or an `a[href]` count,
 * so nothing here can change a single column this pass writes — and each one
 * skipped is one fewer request in the burst a browser makes at a client's
 * server. Anything that can build DOM (script, stylesheet, xhr, fetch,
 * document) is deliberately absent.
 */
const PAINT_ONLY_RESOURCES: ReadonlySet<string> = new Set(["image", "media", "font"]);

export interface RendererOptions {
  /** The crawl's own origin. Every request to another one is aborted. */
  origin: string;
  /**
   * The directory this pass writes serialised post-JS documents into — one
   * `<sha256(url)>.html` per rendered page. **The caller creates it**
   * (`runRenderPass` does, once, before the browser launches); the renderer
   * writes into it and records the path.
   *
   * REQUIRED, and deliberately not optional-with-a-default. An optional
   * directory is an invitation to render a whole site and keep none of the
   * documents the findings were computed from, which is the silent half of a
   * fallback (rule 7). A caller that means "somewhere temporary" says so.
   */
  htmlDir: string;
  /** The crawl's branded UA, so a site sees one client, not two (rule 9). */
  userAgent: string;
  /** Minimum spacing between two navigations to one host. */
  perHostDelayMs: number;
  /** robots.txt `Crawl-delay`, honoured exactly as the crawl honours it. */
  robotsCrawlDelaySec?: number | null;
  /** Wait for `domcontentloaded`. Default 15s. */
  navigationTimeoutMs?: number;
  /** Fixed wait after `domcontentloaded`, for the app to paint. Default 3s. */
  settleMs?: number;
  /**
   * TEST ONLY, and the same flag `CrawlConfig.allowPrivate` is: it admits a
   * 127.0.0.1 fixture server to url-policy. Never wire it to an API field.
   */
  allowPrivate?: boolean;
  /** Told about every aborted request. Bounded work only — this is a hot path. */
  onRequestBlocked?: (url: string) => void;
}

/**
 * One render's evidence, in the shape the page row stores it.
 *
 * `rendered: false` and a non-null `error` always travel together, and when
 * they do every count is null — see the module header. `redirectUrl` is the
 * exception that may accompany either: a page that sent itself off-site is a
 * fact worth keeping even when the render that discovered it could not finish.
 */
export interface RenderResult {
  /** The URL asked for — the frontier/page key, not `page.url()`. */
  url: string;
  rendered: boolean;
  // --- family 1: `MEASURE_SCRIPT`, in the page (P5-T4) --------------------
  wordCount: number | null;
  linkCount: number | null;
  navLinkCount: number | null;
  footerLinkCount: number | null;
  filterLinkCount: number | null;
  // --- family 2: `analyzeHtml`, over the serialised DOM (P8-T1) -----------
  /**
   * `analyzeHtml(serialisedDom).wordCount` — every word the post-JS DOM's
   * markup carries, on exactly the terms `pages.word_count` carries them
   * (templates excluded, script/style/noscript/svg subtrees skipped).
   */
  analyzerWordCount: number | null;
  /**
   * …and the same analysis's `renderableWordCount`: that count minus what the
   * DOM's own MARKUP hides. The comparable partner of `renderable_word_count`,
   * and the rendered side of `content.csr-dependent` since P8-T1.
   */
  renderableWordCount: number | null;
  /** The post-JS `<title>`, as the analyzer collapsed it. */
  title: string | null;
  /** `<h1>` elements in the post-JS DOM. */
  h1Count: number | null;
  /** The first post-JS `<link rel=canonical>` href, or null if there is none. */
  canonical: string | null;
  /**
   * Where the serialised document was written — an ABSOLUTE path, because the
   * driver absolutises the directory before the renderer sees it (see
   * `runRenderPass`) and this value is stored for a reader who will be standing
   * somewhere else.
   *
   * Non-null on every successful render and null on every failed one. There is
   * no third shape: a document we could not keep is not a failed render either,
   * it is a pass that stops (see `writeSerialisedDom`).
   */
  htmlPath: string | null;
  /**
   * Where the page navigated itself to, if that is not where it started.
   *
   * FOR THE RULE THAT READS THIS (`redirect.js`, CHECK-10, P5-T5): it is set on
   * FAILED renders too, and that is the commonest case rather than an edge one.
   * A page that sends itself to another origin has its navigation aborted here
   * (we record where it wanted to go and do not follow it), which leaves
   * Chromium on its own error surface with no DOM of this site's to measure —
   * so the row is `rendered = false`, `render_error = 'off-site navigation: …'`,
   * and `rendered_redirect_url` set. **The rule must gate on
   * `rendered_redirect_url is not null` (with `fetch_class = 'ok'`), NEVER on
   * `rendered = true`**: a non-null redirect URL is itself the render evidence,
   * and gating on `rendered` would silently drop every off-site JS redirect —
   * the most serious shape of the defect the check exists to find.
   */
  redirectUrl: string | null;
  /** Why a render that was attempted produced nothing. Null on success. */
  error: string | null;
  /** Third-party requests aborted. Diagnostic; not stored on the page row. */
  blockedRequests: number;
  /**
   * Same-origin subresources aborted because they only affect paint (images,
   * media, fonts). Diagnostic; not stored on the page row.
   */
  skippedPaintRequests: number;
}

/** What `MEASURE_SCRIPT` hands back. Counts only — no HTML crosses the seam. */
interface Measurement {
  wordCount: number;
  linkCount: number;
  navLinkCount: number;
  footerLinkCount: number;
  filterLinkCount: number;
}

/**
 * The in-page measurement, as a string because this project has no `dom` lib
 * (tsconfig `types: ["node"]`) and adding one to typecheck five selectors would
 * put browser globals in every server file.
 *
 * THE FILTER-LINK PREDICATE IS SPELLED IN TWO PLACES AND MUST STAY IDENTICAL:
 * here, over `HTMLAnchorElement.href` (the DOM's *resolved* href), and in
 * `filters.js-only` (src/rules/query/render-diff.ts, P5-T5) over
 * `links.target_url`, which is the crawl's resolved href. An anchor is a filter
 * link when its resolved href contains `?` OR matches /filter|facet|sort/i.
 * Change one and the rule compares two different questions and fires on the
 * difference between them, not on the site.
 *
 * `innerText` rather than `textContent`: it is the rendered text — it excludes
 * `display:none` copy and script bodies, which is what a search engine reads
 * and what the raw-side `word_count` is meant to be compared against. A page
 * with no `<body>` measures zero rather than throwing; that is a real document
 * (an XML response rendered by the browser), not a failure.
 */
const MEASURE_SCRIPT = `(() => {
  const body = document.body;
  const text = body === null ? "" : body.innerText;
  const words = text.split(/\\s+/).filter((w) => w.length > 0);
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const isFilter = (a) => a.href.indexOf("?") !== -1 || /filter|facet|sort/i.test(a.href);
  return {
    wordCount: words.length,
    linkCount: anchors.length,
    navLinkCount: document.querySelectorAll("nav a[href]").length,
    footerLinkCount: document.querySelectorAll("footer a[href]").length,
    filterLinkCount: anchors.filter(isFilter).length,
  };
})()`;

/**
 * The file one render's serialised DOM is kept in.
 *
 * `sha256(url)` rather than the URL itself: a page URL is not a filename — it
 * carries `/`, `?`, `%`, unicode and no length bound — and every scheme that
 * *escapes* one into a filename either collides (two URLs, one file, and the
 * evidence of one of them silently gone) or is unreadable anyway. A hash is
 * neither: it is fixed-width, collision-free at any crawl size this engine will
 * see, and it is reproducible, so an auditor holding a URL can find its file
 * with one `sha256sum`. The mapping back is the `rendered_html_path` column and
 * the page row beside it.
 */
export function renderedHtmlFilename(url: string): string {
  return `${createHash("sha256").update(url, "utf8").digest("hex")}.html`;
}

/**
 * Write one serialised document beside its measurements, or THROW.
 *
 * THE RULING, and it is the taxonomy this file already has rather than a new
 * one: **a failed write is an ENVIRONMENT failure, not something the site did.**
 * `ENOSPC`, `EACCES`, a directory somebody deleted under a running pass — none
 * of them is evidence about a page, and the module header's own line covers the
 * class exactly: a `render_error` records "what a SITE did to a render", and
 * anything that is our machine's fault "must stop the pass rather than mark a
 * site unrenderable". A full disk is the browser-is-gone case wearing different
 * boots.
 *
 * The two shapes this rejects, and why each is worse:
 *
 *  - **A null path beside `rendered = true`** is hard rule 7's silent fallback
 *    wearing a nullable column's clothes: every reader downstream takes the row
 *    for a complete render and none ever learns the evidence is missing.
 *  - **A classified `render_error`** — which this function used to return — is
 *    an engine defect in site-evidence clothing, and it costs more than a
 *    mislabel. `runWorker` writes the classified row and COMPLETES the frontier
 *    URL in the same transaction, so the URL is consumed by a render that
 *    produced nothing keepable, `render.coverage` counts it as a site-side
 *    `renderFailure`, and a re-run has to re-navigate every one of them. A throw
 *    leaves the URL `render_pending` and unconsumed: the pass stops, the
 *    operator fixes the disk, and the re-run picks up exactly what was left —
 *    with no polite navigations spent on evidence that was thrown away.
 *
 * A PLAIN `Error`, deliberately, and never a `RenderPassRefusal`: a refusal
 * means "wait and try again, this crawl is busy" and maps to a 409. This is a
 * 500, because it is ours.
 *
 * The measurements are computed from the same string this writes, so a file on
 * disk is always the document its row's numbers came from.
 */
async function writeSerialisedDom(dir: string, url: string, html: string): Promise<string> {
  const path = join(dir, renderedHtmlFilename(url));
  try {
    await writeFile(path, html, "utf8");
    return path;
  } catch (error) {
    throw new Error(
      `render evidence not written: could not save the rendered DOM of ${url} to ${path} ` +
        `(${firstLine(error)}) — this is the render pass's own environment failing, not ` +
        "the site, so the pass stops with the URL still unrendered rather than recording " +
        "a page it cannot show you the document for",
      { cause: error },
    );
  }
}

/**
 * A launched browser plus the policy every render through it obeys.
 *
 * One instance per pass, `renderConcurrency` contexts live at any moment — and
 * a context per render rather than a context per worker, so no cookie, no
 * storage entry and no service worker from one page can change what the next
 * one renders. Contexts are cheap; a shared session's contamination is not.
 */
export class PageRenderer {
  private constructor(
    private readonly browser: Browser,
    private readonly opts: Required<
      Omit<RendererOptions, "onRequestBlocked" | "robotsCrawlDelaySec" | "allowPrivate">
    > & {
      allowPrivate: boolean;
      onRequestBlocked: ((url: string) => void) | null;
    },
    private readonly gate: HostGate,
  ) {}

  static async launch(options: RendererOptions): Promise<PageRenderer> {
    const navigationTimeoutMs = options.navigationTimeoutMs ?? RENDERER_DEFAULTS.navigationTimeoutMs;
    const settleMs = options.settleMs ?? RENDERER_DEFAULTS.settleMs;
    if (!Number.isFinite(navigationTimeoutMs) || navigationTimeoutMs <= 0) {
      throw new RangeError(
        `PageRenderer: navigationTimeoutMs must be > 0, got ${navigationTimeoutMs}`,
      );
    }
    if (!Number.isFinite(settleMs) || settleMs < 0) {
      throw new RangeError(`PageRenderer: settleMs must be ≥ 0, got ${settleMs}`);
    }
    // Parsed here so a malformed origin fails at launch rather than on the
    // first request, where it would read as "everything is third-party".
    new URL(options.origin);

    const gate = new HostGate({
      perHostDelayMs: options.perHostDelayMs,
      robotsCrawlDelaySec: options.robotsCrawlDelaySec ?? null,
    });
    const browser = await chromium.launch({ headless: true });
    return new PageRenderer(
      browser,
      {
        origin: options.origin,
        htmlDir: options.htmlDir,
        userAgent: options.userAgent,
        perHostDelayMs: options.perHostDelayMs,
        navigationTimeoutMs,
        settleMs,
        allowPrivate: options.allowPrivate === true,
        onRequestBlocked: options.onRequestBlocked ?? null,
      },
      gate,
    );
  }

  /** The spacing this renderer actually honours: max(config, robots), capped. */
  effectiveDelayMs(): number {
    return this.gate.effectiveDelayMs();
  }

  /**
   * Render one URL and measure what the browser built.
   *
   * NEVER THROWS FOR ANYTHING THE SITE DID. A refused URL, a dead host, a page
   * that never finishes loading — each comes back as a `RenderResult` carrying
   * a classified `error`, because the pass records failures rather than
   * skipping URLs (rule 7). It DOES throw for anything that is OURS: a browser
   * that is gone, our own instruments failing on a document the browser
   * successfully built, a disk that will not take the evidence. Those must stop
   * the pass rather than mark a site unrenderable.
   *
   * THE BODY IS IN TWO PHASES AND THE SPLIT IS THAT DISTINCTION, made
   * structural rather than left to a comment (P8-T1 fix round 1). Phase 1 is
   * everything a SITE participates in — the gate, the navigation, the settle,
   * where the browser ended up, and the in-page measurement — and it is the
   * only code the classifying `catch` wraps. Phase 2 is our own reading of a
   * document the browser already built: serialise, analyse, write. It sits
   * OUTSIDE that catch, so a defect in it propagates instead of arriving in the
   * database as `render_error: navigation error: …` — a bug of ours wearing
   * site-evidence clothes, which is what it did before this split and which
   * `render.coverage` would have counted as the site's failure.
   */
  async render(url: string): Promise<RenderResult> {
    const verdict = await isUrlAllowed(url, { allowPrivate: this.opts.allowPrivate });
    if (!verdict.allowed) {
      return failure(url, `policy refusal: ${verdict.reason ?? "refused"}`, null, 0, 0);
    }

    const context = await this.browser.newContext({
      userAgent: this.opts.userAgent,
      // A desktop viewport, fixed: a responsive site serves a different DOM at
      // a different width, and a render whose word count depended on an
      // unstated viewport would not be evidence of anything.
      viewport: { width: 1280, height: 900 },
    });

    // Mutated by the route handler, read after the navigation settles.
    let blocked = 0;
    let skipped = 0;
    /** Where the page tried to send itself, off this origin. */
    let offSite: string | null = null;
    /** A navigation this pass refused on policy grounds. */
    let refusedNavigation: string | null = null;

    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const target = request.url();

      // A DOCUMENT the page navigates itself to is evidence, not a subresource:
      // it is the JS redirect CHECK-10 exists to find. It still goes through
      // url-policy (rule 5) and it still does not leave the site — we record
      // where the page wanted to go and refuse to follow it, because another
      // origin's DOM is not this page's evidence and crawling it was never
      // budgeted.
      if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
        const allowed = await isUrlAllowed(target, { allowPrivate: this.opts.allowPrivate });
        if (!allowed.allowed) {
          refusedNavigation = `${target} (${allowed.reason ?? "refused"})`;
          await route.abort("blockedbyclient");
          return;
        }
        if (!isSameOrigin(target, this.opts.origin)) {
          offSite = target;
          blocked += 1;
          this.opts.onRequestBlocked?.(target);
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
        return;
      }

      if (!isSameOrigin(target, this.opts.origin)) {
        blocked += 1;
        this.opts.onRequestBlocked?.(target);
        await route.abort("blockedbyclient");
        return;
      }

      // SAME-ORIGIN, BUT PAINT-ONLY. An image, a video and a font cannot change
      // `innerText` or the anchor counts — they change what the page LOOKS like,
      // and this pass measures what it SAYS. Aborting them is the other half of
      // politeness: one navigation is otherwise a burst of dozens of requests at
      // the client's own server, which is precisely the shape that got us
      // throttled at yellow.com.mt (rule 9). Script, stylesheet, xhr and fetch
      // stay allowed — a client-rendered page needs all four to build the DOM
      // this pass exists to measure — so a residual burst remains, bounded by
      // the site's own code and measured at the phase-5 gate.
      if (PAINT_ONLY_RESOURCES.has(request.resourceType())) {
        skipped += 1;
        await route.abort("blockedbyclient");
        return;
      }

      await route.continue();
    });

    const page = await context.newPage();
    try {
      // ---------------------------------------------------------------------
      // PHASE 1 — what the SITE does. Everything in this inner try is
      // classified rather than thrown, because every way it can fail is a fact
      // about the page (rule 7). It ends either by returning a classified
      // `RenderResult` or by handing phase 2 the document it built.
      // ---------------------------------------------------------------------
      let navigated: { finalUrl: string; measured: Measurement };
      try {
        // The gate is acquired HERE, not before the context: launching a
        // context takes tens of milliseconds and a slot claimed before it would
        // be partly spent on our own setup, so two renders of one host would
        // arrive closer together than the configured delay (rule 9).
        await this.gate.acquire(new URL(url).hostname);

        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.opts.navigationTimeoutMs,
        });
        if (this.opts.settleMs > 0) await page.waitForTimeout(this.opts.settleMs);

        // WHERE THE BROWSER ENDED UP decides whether there is anything to
        // measure. A navigation this pass aborted — off-site, or policy-refused
        // — leaves Chromium on its own `chrome-error://` surface, and measuring
        // that would report the browser's error page as the site's rendered
        // DOM. It is a failed render carrying a redirect, not a render (rule 7).
        const finalUrl = page.url();
        if (!isHttpUrl(finalUrl)) {
          if (refusedNavigation !== null) {
            return failure(url, `policy refusal: ${refusedNavigation}`, null, blocked, skipped);
          }
          if (offSite !== null) {
            return failure(url, `off-site navigation: ${offSite}`, offSite, blocked, skipped);
          }
          return failure(
            url,
            `navigation error: browser ended on ${finalUrl}`,
            null,
            blocked,
            skipped,
          );
        }

        // IN PHASE 1 RATHER THAN PHASE 2, deliberately, even though it is one
        // of our own instruments: `page.evaluate` runs INSIDE the document, so
        // the way it fails in practice is a page navigating away underneath it
        // ("Execution context was destroyed"), which is the site doing
        // something and is right to classify.
        navigated = { finalUrl, measured: (await page.evaluate(MEASURE_SCRIPT)) as Measurement };
      } catch (error) {
        // Order matters: a page that redirected itself before it finished
        // loading aborts its own navigation, and "we stopped it" is a truer
        // classification than the `net::ERR_ABORTED` the browser reports for it.
        if (refusedNavigation !== null) {
          return failure(url, `policy refusal: ${refusedNavigation}`, null, blocked, skipped);
        }
        if (offSite !== null) {
          return failure(url, `off-site navigation: ${offSite}`, offSite, blocked, skipped);
        }
        if (error instanceof playwrightErrors.TimeoutError) {
          return failure(
            url,
            `timeout: navigation did not reach domcontentloaded within ${this.opts.navigationTimeoutMs}ms`,
            null,
            blocked,
            skipped,
          );
        }
        return failure(url, `navigation error: ${firstLine(error)}`, null, blocked, skipped);
      }
      const { finalUrl, measured } = navigated;

      // ---------------------------------------------------------------------
      // PHASE 2 — what WE do to a document the browser already built. Outside
      // the classifier above: a throw here is an engine defect or an
      // environment failure, and either must stop the pass rather than be
      // recorded against the site (see this method's docblock).
      // ---------------------------------------------------------------------
      //
      // THE SECOND INSTRUMENT. `page.content()` is `document.documentElement.
      // outerHTML` with the document's doctype prepended — the same
      // serialisation, plus the one line a saved file needs to reopen as the
      // document it was. It crosses the seam once, is analysed here in the
      // render worker (`analyzeHtml` is pure and does not fetch — hard rule 2)
      // and is written to disk; nothing retains it, so the cost is
      // O(concurrency × page size).
      //
      // `finalUrl`, not `url`, is what the analysis resolves against: this is a
      // measurement OF THE DOCUMENT THE BROWSER ENDED ON, exactly as family 1
      // above is (the same reason the same page's `rendered_word_count` reports
      // the destination of a JavaScript redirect).
      let serialised: string;
      let analysis: RawPageAnalysis;
      try {
        serialised = await page.content();
        analysis = analyzeHtml(serialised, finalUrl);
      } catch (error) {
        // Re-thrown with the real cause named, because the bare message a
        // tokenizer or a serialiser produces says nothing about which URL it
        // was reading. It stays a plain `Error`: this is a 500, not a "the
        // crawl is busy" refusal (see `mapRenderPassError`).
        throw new Error(
          `render measurement failed on ${url}: the browser built a document and the ` +
            `engine could not read it (${firstLine(error)}) — this is our defect, not ` +
            "the site's, so it stops the pass instead of being recorded as a render error",
          { cause: error },
        );
      }
      const htmlPath = await writeSerialisedDom(this.opts.htmlDir, url, serialised);

      return {
        url,
        rendered: true,
        wordCount: measured.wordCount,
        linkCount: measured.linkCount,
        navLinkCount: measured.navLinkCount,
        footerLinkCount: measured.footerLinkCount,
        filterLinkCount: measured.filterLinkCount,
        analyzerWordCount: analysis.wordCount,
        renderableWordCount: analysis.renderableWordCount,
        title: analysis.title,
        h1Count: analysis.headingCounts[0],
        canonical: analysis.canonicalHtml,
        // `analysis.resourceRefs` IS PRODUCED HERE AND DELIBERATELY DROPPED
        // (P11-T1). The `resources` table holds the SERVED HTML's references;
        // an asset a client-rendered page injects at runtime appears in this
        // analysis and in no table, so on a CSR site the resource census is a
        // floor rather than the page's real asset list. That is a scoping
        // decision, not an oversight — a post-JS reference is a different fact
        // from a served one and deserves its own column before it is stored —
        // and it is written down in both places so a reader of either finds it
        // (see the `resources` docblock in src/db/schema.ts).
        htmlPath,
        // `offSite` first: when the page tried to leave and we stopped it, the
        // URL it asked for is the redirect — `page.url()` is still where it
        // started, which would report "no redirect" for the very case CHECK-10
        // is about.
        redirectUrl: offSite ?? navigatedTo(url, finalUrl),
        error: null,
        blockedRequests: blocked,
        skippedPaintRequests: skipped,
      };
    } finally {
      // Closing the context closes its pages and releases the browser's memory
      // for them. Without it a pass is O(URLs) contexts and the memory contract
      // is gone by page 200.
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/** A render that produced no measurement, in the one shape all of them share. */
function failure(
  url: string,
  error: string,
  redirectUrl: string | null,
  blockedRequests: number,
  skippedPaintRequests: number,
): RenderResult {
  return {
    url,
    rendered: false,
    wordCount: null,
    linkCount: null,
    navLinkCount: null,
    footerLinkCount: null,
    filterLinkCount: null,
    analyzerWordCount: null,
    renderableWordCount: null,
    title: null,
    h1Count: null,
    canonical: null,
    htmlPath: null,
    redirectUrl,
    error,
    blockedRequests,
    skippedPaintRequests,
  };
}

/**
 * Where the page ended up, when that is not where it was sent.
 *
 * Compared through `normalizeUrl` — the frontier's key authority — so a browser
 * re-spelling a URL (a sorted query string, a lowercased host, a dropped
 * fragment) is not reported as a redirect. A URL either side cannot normalise
 * is compared verbatim rather than treated as equal: an unparseable final URL
 * is a fact, not a match.
 */
function navigatedTo(requested: string, final: string): string | null {
  if (requested === final) return null;
  const a = normalizeUrl(requested);
  const b = normalizeUrl(final);
  if (a !== null && b !== null && a === b) return null;
  return final;
}

/**
 * Whether a URL is a page the site served. `chrome-error://chromewebdata/` and
 * `about:blank` are the browser talking about itself, and neither is evidence.
 */
function isHttpUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? message).trim();
}

/**
 * Write one render onto its page row.
 *
 * THE UPDATE IS THE ASSERTION. The selection only ever names pages that exist
 * (T3 selects out of the `pages` table itself), so a render whose page row is
 * missing means the row was deleted under a live pass or the frontier and the
 * page table have diverged — either way the pass stops rather than dropping a
 * measurement on the floor (rule 7). `zero rows updated` is the only signal
 * Postgres gives us for that, so it is checked, not assumed.
 *
 * BOTH MEASUREMENT FAMILIES are written together with `rendered`, so no reader
 * ever sees `rendered = true` with null measurements — and no reader ever sees
 * one family filled and the other empty, which would be a page measured by half
 * an instrument.
 */
export async function writeRenderResult(
  db: Pick<Db, "execute">,
  crawlId: string,
  result: RenderResult,
): Promise<void> {
  const res = await db.execute(sql`
    update pages set
      rendered = ${result.rendered},
      rendered_word_count = ${result.wordCount},
      rendered_link_count = ${result.linkCount},
      rendered_nav_link_count = ${result.navLinkCount},
      rendered_footer_link_count = ${result.footerLinkCount},
      rendered_filter_link_count = ${result.filterLinkCount},
      rendered_analyzer_word_count = ${result.analyzerWordCount},
      rendered_renderable_word_count = ${result.renderableWordCount},
      rendered_title = ${result.title},
      rendered_h1_count = ${result.h1Count},
      rendered_canonical = ${result.canonical},
      rendered_html_path = ${result.htmlPath},
      rendered_redirect_url = ${result.redirectUrl},
      render_error = ${result.error}
    where crawl_id = ${crawlId} and url = ${result.url}
    returning id`);

  if (res.rows.length !== 1) {
    throw new Error(
      `writeRenderResult: no page row for '${result.url}' in crawl ${crawlId} ` +
        `(${res.rows.length} rows updated)`,
    );
  }
}

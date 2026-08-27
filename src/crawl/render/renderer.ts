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
 *  - **Politeness (rule 9).** Every navigation passes through a `HostGate`, so
 *    the render pass spaces its hits on a host exactly as the crawl does. A
 *    browser is a burstier client than a fetch — one navigation can be a dozen
 *    subresource requests — which is why the gate is the renderer's own and not
 *    something a caller may forget to wire.
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
 * The DOM is measured once, by a single in-page expression (`MEASURE_SCRIPT`),
 * and nothing but counts crosses back — no HTML, no link list. That is the
 * memory contract (rule 6) applied to a browser: RAM is O(concurrency), never
 * O(page size × URLs).
 */
import { chromium, errors as playwrightErrors, type Browser, type Route } from "playwright";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { HostGate } from "../politeness.js";
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

export interface RendererOptions {
  /** The crawl's own origin. Every request to another one is aborted. */
  origin: string;
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
  wordCount: number | null;
  linkCount: number | null;
  navLinkCount: number | null;
  footerLinkCount: number | null;
  filterLinkCount: number | null;
  /** Where the page navigated itself to, if that is not where it started. */
  redirectUrl: string | null;
  /** Why a render that was attempted produced nothing. Null on success. */
  error: string | null;
  /** Third-party requests aborted. Diagnostic; not stored on the page row. */
  blockedRequests: number;
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
 * `filters.js-only` (src/rules/page|query/render-diff.ts, P5-T5) over
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
   * skipping URLs (rule 7). It DOES throw if the browser itself is gone, which
   * is our bug and must stop the pass rather than mark a site unrenderable.
   */
  async render(url: string): Promise<RenderResult> {
    const verdict = await isUrlAllowed(url, { allowPrivate: this.opts.allowPrivate });
    if (!verdict.allowed) {
      return failure(url, `policy refusal: ${verdict.reason ?? "refused"}`, null, 0);
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
      await route.continue();
    });

    const page = await context.newPage();
    try {
      // The gate is acquired HERE, not before the context: launching a context
      // takes tens of milliseconds and a slot claimed before it would be partly
      // spent on our own setup, so two renders of one host would arrive closer
      // together than the configured delay (rule 9).
      await this.gate.acquire(new URL(url).hostname);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.navigationTimeoutMs,
      });
      if (this.opts.settleMs > 0) await page.waitForTimeout(this.opts.settleMs);

      // WHERE THE BROWSER ENDED UP decides whether there is anything to
      // measure. A navigation this pass aborted — off-site, or policy-refused —
      // leaves Chromium on its own `chrome-error://` surface, and measuring
      // that would report the browser's error page as the site's rendered DOM.
      // It is a failed render carrying a redirect, not a render (rule 7).
      const finalUrl = page.url();
      if (!isHttpUrl(finalUrl)) {
        if (refusedNavigation !== null) {
          return failure(url, `policy refusal: ${refusedNavigation}`, null, blocked);
        }
        if (offSite !== null) {
          return failure(url, `off-site navigation: ${offSite}`, offSite, blocked);
        }
        return failure(url, `navigation error: browser ended on ${finalUrl}`, null, blocked);
      }

      const measured = (await page.evaluate(MEASURE_SCRIPT)) as Measurement;
      return {
        url,
        rendered: true,
        wordCount: measured.wordCount,
        linkCount: measured.linkCount,
        navLinkCount: measured.navLinkCount,
        footerLinkCount: measured.footerLinkCount,
        filterLinkCount: measured.filterLinkCount,
        // `offSite` first: when the page tried to leave and we stopped it, the
        // URL it asked for is the redirect — `page.url()` is still where it
        // started, which would report "no redirect" for the very case CHECK-10
        // is about.
        redirectUrl: offSite ?? navigatedTo(url, finalUrl),
        error: null,
        blockedRequests: blocked,
      };
    } catch (error) {
      // Order matters: a page that redirected itself before it finished loading
      // aborts its own navigation, and "we stopped it" is a truer classification
      // than the `net::ERR_ABORTED` the browser reports for it.
      if (refusedNavigation !== null) {
        return failure(url, `policy refusal: ${refusedNavigation}`, null, blocked);
      }
      if (offSite !== null) {
        return failure(url, `off-site navigation: ${offSite}`, offSite, blocked);
      }
      if (error instanceof playwrightErrors.TimeoutError) {
        return failure(
          url,
          `timeout: navigation did not reach domcontentloaded within ${this.opts.navigationTimeoutMs}ms`,
          null,
          blocked,
        );
      }
      return failure(url, `navigation error: ${firstLine(error)}`, null, blocked);
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
): RenderResult {
  return {
    url,
    rendered: false,
    wordCount: null,
    linkCount: null,
    navLinkCount: null,
    footerLinkCount: null,
    filterLinkCount: null,
    redirectUrl,
    error,
    blockedRequests,
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
 * The five counts are written together with `rendered`, so no reader ever sees
 * `rendered = true` with null measurements.
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

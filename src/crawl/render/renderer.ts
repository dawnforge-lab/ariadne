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
 * Five things this module is strict about, because each of them is a hard rule
 * standing behind it:
 *
 *  - **url-policy on every navigation (rule 5).** `isUrlAllowed` runs before a
 *    page is even opened, and again inside the interception for every
 *    document request after it — a document the page navigates *itself* to,
 *    every redirect hop of the one we asked for, and every iframe's. A refused
 *    top-level navigation is a classified `render_error`, never a skipped
 *    URL; a refused iframe is failed and counted as blocked.
 *  - **Politeness (rule 9): every same-origin request is paced (Phase 24a).**
 *    The renderer owns a `HostGate`, seeded from the crawl's own per-host state
 *    (`crawls.host_spacing_jsonb`, through `HostGate.restore`), so a host that
 *    earned 4 s during the crawl is rendered at 4 s, on the same ratchet level,
 *    with the same recovery count and lock. EVERY request the page makes to the
 *    site's own origin that actually goes to the network — the document, each
 *    script, stylesheet, xhr, fetch, a same-origin iframe, a redirect hop, a
 *    worker's import — waits for that gate before it is released, and every
 *    answer is reported back into it (`gate.report`), so a 429 on a theme
 *    asset escalates the host exactly as a 429 on a page does and is counted in
 *    the throttle record the pass writes back. The gate is keyed by each
 *    request's OWN host (`gateKey`), the key the crawl loop uses, so a `www.`
 *    page waits on — and reports into — what the crawl earned on `www.` even
 *    when the crawl was given the apex. An answer that arrives after its render
 *    was shut, for a request released before, is still reported: it was on the
 *    wire, and a late 429 is the site speaking. Because every request waits,
 *    the navigation budget the pass hands this class grows with the spacing
 *    (`renderNavigationBudgetMs` in run-render.ts); a page that cannot finish
 *    inside it is `timeout under pacing (…)`. Until 24a the gate spaced the
 *    DOCUMENTS only and each document was an unpaced burst of subresources;
 *    lavishalice serves its theme same-origin under `/cdn/shop/…`, so that
 *    burst landed on the very host the crawl had been asked to treat gently.
 *    What is still aborted, unpaced and uncounted: paint-only requests
 *    (`Image`, `Media`, `Font` — `PAINT_ONLY_RESOURCES`), which cannot move a
 *    measurement, and every third-party request (below).
 *  - **The HTTP cache is kept, the session is not.** A render worker reuses
 *    one browser context across URLs, so a theme's scripts are fetched once
 *    per worker rather than once per page; between URLs its cookies,
 *    permissions and the origin's storage are cleared (see `release`), so a
 *    consent cookie set by page N cannot change page N+1's DOM. A request the
 *    cache will answer is not paced (see `FreshnessLedger`) — it never reaches
 *    the site.
 *  - **No third-party traffic, fail-closed (rules 5 and 9).** Two layers,
 *    each measured against a real Chromium (renderer.test.ts):
 *     1. INTERCEPTED — the `Fetch` domain on the render's own page session
 *        pauses every request of the page, its iframes (same- and
 *        cross-origin documents) and its dedicated workers, redirect hops
 *        included. Each is failed unless it is same-origin, not paint-only,
 *        and (documents) allowed by url-policy; what survives is paced.
 *     2. FENCED — the browser's proxy is a local listener that drops every
 *        connection (`NetworkFence`), with ONE exception: `http(s)://` to the
 *        crawl's origin AT ITS PORT (pinned even when it is the default one —
 *        a port-less rule would exempt every port), in every spelling
 *        `isSameOrigin` admits (`originVariants`: `www.` and apex, and
 *        https:443 beside an http:80 origin). So whatever the
 *        interception cannot see still reaches no other host or port: a
 *        WebSocket to ANY host (the origin included — the exception is
 *        scheme-qualified), a speculation-rules prefetch of another origin,
 *        a request from any target never attached to.
 *     3. PINNED — each of the origin's hostname spellings resolves, for the
 *        whole pass, to the one address url-policy approved for it at launch
 *        (`resolveApprovedAddress`, `--host-resolver-rules`), and every other
 *        name to nothing. A DNS answer that changes mid-pass cannot move the
 *        origin somewhere else. The crawl's own hostname must be approved or
 *        the launch fails; the other spelling, if refused, is left out of the
 *        fence's exemption and the pin, its pages fail as a classified
 *        `policy refusal`, and `unpinnedHosts()` says so. See
 *        `browserNetworkSwitches`.
 *    DISABLED, because their requests are outside a page's interception:
 *    popups (`--block-new-web-contents`), service workers (`serviceWorkers:
 *    "block"`), shared workers (`--disable-shared-workers`), prerendering
 *    (`Page.setPrerenderingAllowed`). WHAT REMAINS, stated rather than hidden:
 *    a speculation-rules PREFETCH of a same-origin URL is neither
 *    interceptable nor switchable off in this Chromium build (tested:
 *    `--disable-features=Prerender2,SpeculationRules,PrefetchProxy`,
 *    `--disable-blink-features=SpeculationRules`); it reaches the origin
 *    unpaced, is counted in `unpacedNetworkRequests`, is reported to the
 *    gate, and claims a slot after the fact. Chrome caps them per page. A
 *    blocked request never fails the render: the page is measured as the
 *    site's own bytes render it.
 *  - **No silent fallbacks (rule 7).** A timeout, a navigation error and a
 *    policy refusal are three different classified strings on the page row, and
 *    every one of them leaves `rendered = false` with the five measurement
 *    columns null. "Rendered and empty" and "never rendered" stay different
 *    facts.
 *  - **Render evidence (Phase 25).** Every render that opened a page carries
 *    what the page itself reported going wrong (`RenderResult.console`,
 *    `pages.render_console`): its console errors and warnings, its uncaught
 *    exceptions and the requests the SITE failed, capped by
 *    `RenderConsoleCollector` (console-capture.ts). Failed renders keep what
 *    was captured before they failed — a page that throws and then times out
 *    is where it matters most. The renderer's own aborts are never failures,
 *    only the `blockedByRenderer` counts.
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
import { createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";

import {
  chromium,
  errors as playwrightErrors,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { classifyStatus, parseRetryAfter } from "../fetch-page.js";
import { headerValue, type HeaderBag } from "../http.js";
import { HostGate, type HostSpacingEntry, type HostThrottle } from "../politeness.js";
import { RENDER_CAPTURE_VERSION } from "../versions.js";
import { RenderConsoleCollector, type RenderConsole } from "./console-capture.js";
import { analyzeHtml, type RawPageAnalysis } from "../parse/page-analyzer.js";
import { hostnameSpellings, isSameOrigin, normalizeUrl } from "../parse/url-utils.js";
import {
  isUrlAllowed,
  resolveApprovedAddress,
  UrlPolicyError,
  type AddressResolver,
} from "../url-policy.js";

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
 * skipped is one fewer request at a client's server, and one fewer paced slot
 * the render has to wait for. Anything that can build DOM (script, stylesheet,
 * xhr, fetch, document) is deliberately absent. Spelled as the DevTools
 * protocol's `Network.ResourceType`, which is what the interception reads.
 */
const PAINT_ONLY_RESOURCES: ReadonlySet<string> = new Set(["Image", "Media", "Font"]);

/**
 * What is cleared between two URLs rendered in one context, as
 * `Storage.clearDataForOrigin`'s `storageTypes` list — every per-origin store a
 * page can write and read back, and NOT the HTTP cache.
 *
 * WHY THIS METHOD, and why it keeps the cache: Chromium keeps the HTTP cache
 * outside this list altogether (it is `Network.clearBrowserCache`, a different
 * command), and `cache_storage` here is the Cache API a page's own script
 * writes into — page state, so it goes. The alternative the plan offered, a
 * blank same-origin page running `localStorage.clear()` and deleting the
 * IndexedDB databases, is one more same-origin navigation per URL (a paced
 * request at the client's server for nothing) and misses every store the
 * script did not name. `sessionStorage` is not in the list because it has no
 * storage type: it belongs to a top-level browsing context, and every render
 * opens a new page. Cookies are cleared here for the origin AND by
 * `context.clearCookies()` for everything, because a cookie is the one store
 * a server can write from a response header.
 */
const ISOLATION_STORAGE_TYPES = [
  "cookies",
  "local_storage",
  "indexeddb",
  "websql",
  "file_systems",
  "service_workers",
  "cache_storage",
  "shared_storage",
  "storage_buckets",
].join(",");

/**
 * How many URLs one context's `FreshnessLedger` remembers. A constant, so the
 * ledger is O(concurrency) like everything else the pass holds (rule 6) — a
 * theme's assets are a few dozen URLs, and an entry pushed out early only
 * means its next request is paced, which is the polite direction.
 */
const FRESHNESS_LEDGER_CAPACITY = 2_048;

/**
 * How close to its expiry a cached response stops being predicted fresh. The
 * browser and this ledger read the same headers a few milliseconds apart; the
 * margin keeps a response that is about to go stale on the paced side.
 */
const FRESHNESS_MARGIN_MS = 5_000;

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
  /** Minimum spacing between two requests to one host: the configured base. */
  perHostDelayMs: number;
  /** robots.txt `Crawl-delay`, honoured exactly as the crawl honours it. */
  robotsCrawlDelaySec?: number | null;
  /**
   * `crawls.host_spacing_ms` — the crawl-wide widest spacing — for a host the
   * per-host state below does not name. `HostGate.earnedSpacingMs`, verbatim.
   */
  earnedSpacingMs?: number | null;
  /**
   * `crawls.host_spacing_jsonb`, as stored: the per-host spacing, ratchet level,
   * recovery count, lock and throttle counters the crawl earned. Handed to
   * `HostGate.restore`, which accepts the pre-24a `{host: ms}` map and the 24a
   * shape and throws on anything else (rule 7) — so `launch` throws too, naming
   * the column, rather than rendering a host at a pace it already refused.
   * Null or absent: nothing to restore.
   */
  hostSpacing?: unknown;
  /**
   * Wait for `domcontentloaded`. Default 15s here; the render pass hands it
   * `renderNavigationBudgetMs` (run-render.ts): 15 s + 30 × the spacing, at
   * most 120 s, at least a platform profile's 60 s. Every paced request the document
   * needs before that event is inside this budget, so a page with k uncached
   * same-origin render-blocking assets needs about k × spacing of it.
   */
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
  /** TEST ONLY — see `RenderTestFaults`. Never wire it to an API field. */
  testFaults?: RenderTestFaults;
  /**
   * The resolver the origin's address is approved through before it is
   * pinned. Defaults to url-policy's DoH resolver; injected by tests so they
   * stay offline (an IP-literal origin resolves nothing).
   */
  resolve?: AddressResolver;
}

/**
 * One render's evidence, in the shape the page row stores it.
 *
 * `rendered: false` and a non-null `error` always travel together, and when
 * they do every count is null — see the module header. `redirectUrl` is the
 * exception that may accompany either: a page that sent itself off-site is a
 * fact worth keeping even when the render that discovered it could not finish.
 * `console` is the other: what the page reported before its render failed is
 * kept beside the failure.
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
  /** The first post-JS `<meta name=robots>` content, verbatim, or null if there is none (P23-T6). */
  robotsMeta: string | null;
  /** The first post-JS meta description, trimmed, or null if there is none (P23-T6). */
  metaDescription: string | null;
  /** The first post-JS `<h1>`'s text as `h1_text` stores it, or null if there is none (P23-T6). */
  h1Text: string | null;
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
  /**
   * Requests the fence aborted: another origin's (an off-site top-level
   * navigation included), same-origin requests to a spelling not pinned at
   * launch, and frame documents url-policy refused. Stored only inside
   * `console`, as `blockedByRenderer.thirdParty` — one count, not split.
   */
  blockedRequests: number;
  /**
   * Same-origin subresources aborted because they only affect paint (images,
   * media, fonts). Stored only inside `console`, as
   * `blockedByRenderer.sameOriginAssets`.
   */
  skippedPaintRequests: number;
  /**
   * Same-origin requests this render released through the host gate — the
   * document included. Each one waited for its slot. Diagnostic; summed into
   * `RenderPassSummary.requests`.
   */
  pacedRequests: number;
  /** Same-origin responses the HTTP cache answered: no request reached the site. */
  cachedResponses: number;
  /**
   * Same-origin requests that reached the site although no gate slot was
   * claimed for them, counted rather than assumed away: a request the ledger
   * predicted the cache would answer and the browser fetched anyway (its URL
   * is then never predicted again in that context, so at most once per URL),
   * and a speculation-rules prefetch the browser sends on its own account
   * (module header), which claims a slot after the fact.
   */
  unpacedNetworkRequests: number;
  /**
   * What the page reported going wrong (Phase 25), as `pages.render_console`
   * stores it: console errors and warnings, uncaught exceptions, the requests
   * the site failed, and the renderer's own aborts as counts.
   *
   * Non-null on EVERY render that opened a page — failed ones included, with
   * whatever was captured before the failure — and zero counts when the page
   * reported nothing ("looked, found nothing" is a fact). Null only when the
   * render was refused before a browser page opened (`NO_TRAFFIC`): nothing
   * was looked at.
   */
  console: RenderConsole | null;
}

/**
 * The request counters and the render evidence every `RenderResult` carries,
 * success or failure.
 */
type TrafficEvidence = Pick<
  RenderResult,
  | "blockedRequests"
  | "skippedPaintRequests"
  | "pacedRequests"
  | "cachedResponses"
  | "unpacedNetworkRequests"
  | "console"
>;

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
 * One reusable browser context, what it has learned about its own cache, and
 * the blank page its state is cleared through.
 *
 * A worker renders URL after URL in the same context (see `PageRenderer`), so
 * the context's HTTP cache — and the ledger that predicts it — outlive a page.
 * Nothing else does: see `release`.
 */
interface ContextSlot {
  context: BrowserContext;
  ledger: FreshnessLedger;
  /**
   * An `about:blank` page that lives as long as the context and never
   * navigates, so it makes no request. Its session is the one storage is
   * cleared through: the rendered page is CLOSED before its origin's storage
   * is cleared (see `release`), and a closed page has no session left.
   */
  janitor: CDPSession;
}

/**
 * Which same-origin URLs this context's HTTP cache will answer without asking
 * the site — so that a request for one is released WITHOUT waiting for a gate
 * slot.
 *
 * WHY A PREDICTION AT ALL. The interception sees a request before the browser
 * consults its cache, and nothing in the DevTools protocol says, at that
 * moment, whether the cache will answer it. Pacing every request regardless
 * would be polite and pointless: a theme's thirty cached scripts would cost
 * thirty spacings per page while none of them reached the site, and the
 * navigation budget (§3.4.4: about k × spacing for k UNCACHED assets) would be
 * spent on our own disk. So the ledger records what the browser was told: a
 * same-origin `GET` that came back `200` from the network with an explicit
 * `Cache-Control: max-age` (minus `Age`), no `no-store` or `no-cache`, and a
 * `Vary` that is absent or exactly `Accept-Encoding` (anything else keys the
 * cache on a request header we cannot see). Until that lifetime runs out (less
 * `FRESHNESS_MARGIN_MS`) a request for the same URL is predicted to be a cache
 * hit. Heuristic freshness (`Last-Modified` without `max-age`) is never
 * predicted: the browser's own arithmetic for it is not ours to guess.
 *
 * A WRONG PREDICTION IS COUNTED, AND NEVER REPEATED. The response says where it
 * came from (`fromDiskCache`). A predicted request that went to the network
 * anyway — the cache evicted it, or the page fetched it with `cache:
 * "no-store"` / `"reload"`, which the paused request's headers do not show — is
 * `RenderResult.unpacedNetworkRequests`, its outcome is still reported to the
 * gate, and its URL goes on this context's never-predict list: every later
 * request for it is paced, however cacheable its next response looks. So one
 * URL can reach the site unpaced at most once per context.
 *
 * Both maps are bounded at `FRESHNESS_LEDGER_CAPACITY` entries, oldest out
 * first (rule 6). A URL pushed off the never-predict list could be mispredicted
 * once more — one unpaced request, counted — and is listed again at once.
 */
class FreshnessLedger {
  private readonly freshUntil = new Map<string, number>();
  private readonly neverPredict = new Set<string>();

  /** Whether a request for `url` is predicted to be answered from the cache. */
  isFresh(url: string, now: number): boolean {
    if (this.neverPredict.has(url)) return false;
    const until = this.freshUntil.get(url);
    if (until === undefined) return false;
    if (until > now) return true;
    this.freshUntil.delete(url);
    return false;
  }

  /** A network response for `url`: remember its lifetime, or forget the URL. */
  record(url: string, headers: HeaderBag, now: number): void {
    this.freshUntil.delete(url);
    if (this.neverPredict.has(url)) return;
    const lifetimeMs = freshLifetimeMs(headers);
    if (lifetimeMs === null) return;
    this.freshUntil.set(url, now + lifetimeMs);
    evictOldest(this.freshUntil);
  }

  /** A prediction for `url` was wrong: never predict it again in this context. */
  mispredicted(url: string): void {
    this.freshUntil.delete(url);
    this.neverPredict.delete(url);
    this.neverPredict.add(url);
    evictOldest(this.neverPredict);
  }
}

function evictOldest(store: Map<string, unknown> | Set<string>): void {
  if (store.size <= FRESHNESS_LEDGER_CAPACITY) return;
  const oldest = store.keys().next().value;
  if (oldest !== undefined) store.delete(oldest);
}

/**
 * How long a response may be served from the browser's cache without asking,
 * from its own headers — or null when it may not be predicted at all (see
 * `FreshnessLedger`). Exported for its unit test.
 */
export function freshLifetimeMs(headers: HeaderBag): number | null {
  const cacheControl = headerValue(headers, "cache-control");
  if (cacheControl === null) return null;
  const vary = headerValue(headers, "vary");
  if (vary !== null) {
    const keys = vary
      .split(/[,\n]/)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== "");
    if (keys.some((v) => v !== "accept-encoding")) return null;
  }
  let maxAgeSec: number | null = null;
  // The protocol joins a repeated header with a newline, so both separate.
  for (const raw of cacheControl.toLowerCase().split(/[,\n]/)) {
    const directive = raw.trim();
    if (directive === "no-store" || directive === "no-cache") return null;
    const match = /^max-age\s*=\s*"?(\d+)"?$/.exec(directive);
    if (match !== null) maxAgeSec = Number(match[1]);
  }
  if (maxAgeSec === null || !Number.isFinite(maxAgeSec)) return null;
  const ageRaw = headerValue(headers, "age");
  const ageSec = ageRaw !== null && /^\d+$/.test(ageRaw.trim()) ? Number(ageRaw.trim()) : 0;
  const lifetimeMs = (maxAgeSec - ageSec) * 1000 - FRESHNESS_MARGIN_MS;
  return lifetimeMs > 0 ? lifetimeMs : null;
}

/** The slice of `Fetch.requestPaused` the interception reads. */
interface PausedRequest {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string> };
  resourceType: string;
  frameId: string;
  networkId?: string;
  redirectedRequestId?: string;
}

/** The slice of a `Network.Response` the gate and the ledger read. */
interface NetworkResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  fromServiceWorker?: boolean;
}

/**
 * The browser refused a command for a paused request because the request no
 * longer exists: the page dropped it (it navigated, or a script aborted it)
 * while it waited for its slot. That is the page's doing, not ours.
 */
const REQUEST_GONE = /Invalid InterceptionId/i;

/**
 * Every request ONE render makes, intercepted, paced and accounted for.
 *
 * Built on the DevTools protocol's `Fetch` domain on the render's own page
 * session, not on Playwright's `route()`: Playwright disables the browser's
 * HTTP cache for any context or page that has a route (its own documented
 * "enabling routing disables http cache"), which would make the shared cache
 * this pass is built around impossible. What this sees, and what it cannot, is
 * in the module header; the network fence (`PageRenderer.launch`) is what
 * stops what it cannot see from reaching anyone but the origin.
 *
 * THE PACING IS SERIAL PER RENDER. A parser that meets thirty `<script>` tags
 * pauses thirty requests at once; were each to call `gate.acquire` on arrival,
 * thirty future slots would be claimed in one tick — and a render that then
 * timed out would leave those claims standing in the gate, holding the NEXT
 * page's document back by thirty spacings for requests nobody will send. So
 * requests queue here and ONE pump claims one slot, waits for it, releases the
 * request, and claims the next: at most one claim per render is ever
 * outstanding, which is what bounds the render lease (see
 * `renderLeaseSeconds` in run-render.ts). The release does not wait for the
 * response, so at zero spacing the requests still go out together.
 *
 * FAIL-CLOSED. A paused request is released (`Fetch.continueRequest`) in
 * exactly one place, `release`, and only while the render is OPEN. The moment
 * the render ends (`shut`) or a protocol command of ours fails, the render is
 * shut: every queued request is failed (`Fetch.failRequest`), a request that
 * pauses after that is failed on arrival, and one that was waiting on its slot
 * or on url-policy is failed when it wakes — never continued. The session is
 * never detached while its page is open (a detached interceptor lets its
 * paused requests go): the page is closed first and the session dies with it.
 *
 * Errors in a handler are OURS (a protocol command the browser refused for a
 * live request), and are kept in `failure` for `render` to throw — never
 * swallowed and never turned into a site's `render_error`. The one refusal
 * that is the page's doing is `REQUEST_GONE`.
 */
class RenderTraffic {
  blocked = 0;
  skipped = 0;
  paced = 0;
  cached = 0;
  unpacedNetwork = 0;
  /** Where the page tried to send itself, off this origin. */
  offSite: string | null = null;
  /** A navigation this pass refused on policy grounds. */
  refusedNavigation: string | null = null;
  /** The first error a handler hit that was ours. `render` throws it. */
  failure: Error | null = null;

  /** False from `shut()` on: nothing is released again, everything is failed. */
  private open = true;
  /**
   * EVERY request paused and not yet answered with a command — queued, waiting
   * on url-policy, waiting on its slot, or between. `shut` fails all of them:
   * a paused request left unanswered when its page closes is let go by the
   * browser (measured), so "not released" must mean "failed", never "left".
   */
  private readonly pending = new Map<string, PausedRequest>();
  /** Rejects with `failure` the moment it is set; `render` races its waits on it. */
  readonly broken: Promise<never>;
  private breakWith: (error: Error) => void = () => undefined;
  /** Network ids of requests the browser sent as speculation (never paused). */
  private readonly speculative = new Set<string>();
  /** Until the first document request has been seen: the goto's own. */
  private firstDocument = true;
  private readonly queue: PausedRequest[] = [];
  private pumping = false;
  /**
   * Every network id this render paused — so a response for a request that
   * was NEVER paused (one the interception cannot see) is recognised as such.
   * Per render, freed with it: O(one page's requests).
   */
  private readonly pausedIds = new Set<string>();
  /** Network ids released WITHOUT a slot because the ledger predicted a cache hit. */
  private readonly predicted = new Set<string>();
  /** Network ids the browser says its memory cache served (`requestServedFromCache`). */
  private readonly servedFromCache = new Set<string>();
  /**
   * Requests released to the network and not yet answered: network id → URL
   * and method. Per render, freed with it — O(one page's requests).
   */
  private readonly inFlight = new Map<string, { url: string; method: string }>();
  /**
   * Network ids of this render's TOP-LEVEL document requests (the goto's, its
   * redirect hops, a navigation the page made itself). Their status is the
   * page's own — already on the row — so they are never failed requests.
   */
  private readonly documentIds = new Set<string>();
  /** What the page reported going wrong — see console-capture.ts. Per render. */
  private readonly reported = new RenderConsoleCollector();

  constructor(
    private readonly cdp: CDPSession,
    private readonly gate: HostGate,
    private readonly origin: string,
    /** The origin spellings the browser can reach; anything else is failed here. */
    private readonly pinnedHosts: ReadonlySet<string>,
    private readonly mainFrameId: string,
    /** The URL `render` navigates to, as the browser will spell it. */
    private readonly requestedUrl: string,
    private readonly ledger: FreshnessLedger,
    private readonly allowPrivate: boolean,
    private readonly onRequestBlocked: ((url: string) => void) | null,
    private readonly testFaults: RenderTestFaults | null,
  ) {
    this.broken = new Promise<never>((_, reject) => {
      this.breakWith = reject;
    });
    // Raced, not always awaited: a render that ends before anything broke
    // must not leave an unhandled rejection behind.
    this.broken.catch(() => undefined);
  }

  /** Wire the listeners and turn interception on. Call before the navigation. */
  async start(): Promise<void> {
    this.cdp.on("Fetch.requestPaused", (event) => {
      this.guard(this.onPaused(event as unknown as PausedRequest));
    });
    this.cdp.on("Network.responseReceived", (event) => {
      const e = event as unknown as { requestId: string; response: NetworkResponse };
      this.onResponse(e.requestId, e.response);
    });
    this.cdp.on("Network.requestWillBeSent", (event) => {
      const e = event as unknown as {
        requestId: string;
        type?: string;
        request: { url: string };
        redirectResponse?: NetworkResponse;
      };
      // A redirect hop's answer arrives here, not as a `responseReceived`.
      if (e.redirectResponse !== undefined) this.onResponse(e.requestId, e.redirectResponse);
      // A speculation-rules prefetch is sent by the browser itself, outside
      // the interception (module header): never paused, and announced only
      // here. Counted the moment it is announced and given a slot.
      else if (e.type === "Prefetch") this.onSpeculative(e.requestId, e.request.url);
    });
    this.cdp.on("Network.requestServedFromCache", (event) => {
      this.servedFromCache.add((event as unknown as { requestId: string }).requestId);
    });
    this.cdp.on("Network.loadingFailed", (event) => {
      const e = event as unknown as {
        requestId: string;
        errorText: string;
        canceled?: boolean;
        blockedReason?: string;
      };
      this.onFailed(e.requestId, e.errorText, e.canceled === true, e.blockedReason);
    });
    this.cdp.on("Network.loadingFinished", (event) => {
      this.inFlight.delete((event as unknown as { requestId: string }).requestId);
    });
    // THE PAGE'S OWN CONSOLE, through `Runtime` on this session rather than
    // Playwright's `console` event: Playwright also surfaces the browser's
    // `Log` entries there, and those include a "Failed to load resource:
    // net::ERR_BLOCKED_BY_CLIENT" line for every request WE abort — our
    // blocking dressed as the site's console. `consoleAPICalled` is only what
    // the page's script logged.
    this.cdp.on("Runtime.consoleAPICalled", (event) => {
      const e = event as unknown as { type: string; args: RemoteObject[] };
      if (!this.open) return;
      const level = consoleLevel(e.type);
      if (level === null) return;
      this.reported.addConsole(level, e.args.map(remoteText).join(" "));
    });
    this.cdp.on("Runtime.exceptionThrown", (event) => {
      const d = (event as unknown as { exceptionDetails: ExceptionDetails }).exceptionDetails;
      if (!this.open) return;
      // `text` is the runtime's label ("Uncaught", "Uncaught (in promise)");
      // the exception itself is the page's value, its stack the page's URLs.
      this.reported.addException(
        d.exception === undefined ? d.text : `${d.text} ${remoteText(d.exception)}`,
      );
    });
    await this.cdp.send("Network.enable");
    await this.cdp.send("Runtime.enable");
    // A prerendered page is a page this session does not intercept. The
    // speculation-rules PREFETCH that may precede it cannot be switched off in
    // this build (module header); it is fenced to the origin and counted.
    await this.cdp.send("Page.setPrerenderingAllowed", { isAllowed: false });
    await this.cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  }

  /**
   * The render is over, or broke: fail everything still queued, and from now
   * on fail whatever pauses. Idempotent. Awaited by `render` before the page
   * is closed, so nothing it held is let go by the close.
   */
  async shut(): Promise<void> {
    this.open = false;
    this.queue.length = 0;
    // EVERY held request is tried, whatever the one before it did: a failure
    // to fail one is not a reason to leave the rest paused for the close to
    // let go. The errors are collected and thrown after.
    const errors: unknown[] = [];
    for (const event of [...this.pending.values()]) {
      try {
        await this.fail(event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `render interception: ${errors.length} held requests could not be failed`);
    }
  }

  /**
   * Stop the page running script before it is closed, so its `pagehide` and
   * `unload` handlers — and its timers — never get to ask for anything. A
   * keepalive fetch or a beacon sent from `pagehide` is handed to the browser
   * process as the page dies, where a closing page's interception no longer
   * reaches it (measured); the only reliable way to fail it is never to let
   * it be made.
   */
  async silence(): Promise<void> {
    await this.cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
  }

  /** The counters, and a snapshot of what the page reported so far. */
  evidence(): TrafficEvidence {
    return {
      blockedRequests: this.blocked,
      skippedPaintRequests: this.skipped,
      pacedRequests: this.paced,
      cachedResponses: this.cached,
      unpacedNetworkRequests: this.unpacedNetwork,
      console: this.reported.snapshot({ thirdParty: this.blocked, sameOriginAssets: this.skipped }),
    };
  }

  private guard(work: Promise<void>): void {
    work.catch((error: unknown) => {
      if (!this.open && this.failure === null) {
        // The render ended under it and the page is going: a command that
        // failed on a closing target is not news. Anything else after shut
        // is still ours, and still recorded.
        if (isTargetClosed(error)) return;
      }
      if (this.failure === null) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.breakWith(this.failure);
      }
      // FAIL-CLOSED: one broken command shuts the render, so no request it
      // was holding can be released by whatever happens next.
      void this.shut().catch(() => undefined);
    });
  }

  private async onPaused(event: PausedRequest): Promise<void> {
    if (event.networkId !== undefined) this.pausedIds.add(event.networkId);
    this.pending.set(event.requestId, event);
    if (!this.open) {
      await this.fail(event);
      return;
    }
    const target = event.request.url;

    // EVERY DOCUMENT goes through url-policy (rule 5): the top-level one we
    // navigated to, each of its redirect hops, a page sending itself somewhere
    // (the JS redirect CHECK-10 exists to find), and every iframe's.
    if (event.resourceType === "Document") {
      const topLevel = event.frameId === this.mainFrameId;
      if (topLevel && event.networkId !== undefined) this.documentIds.add(event.networkId);
      // The goto's own request is the URL `render` put through url-policy a
      // moment ago; asking again would only put a lookup between its slot and
      // its request.
      const asked =
        topLevel &&
        this.firstDocument &&
        event.redirectedRequestId === undefined &&
        target === this.requestedUrl;
      this.firstDocument = false;
      const allowed = asked
        ? { allowed: true as const, reason: null }
        : await isUrlAllowed(target, { allowPrivate: this.allowPrivate });
      if (!this.open) {
        await this.fail(event);
        return;
      }
      if (!allowed.allowed) {
        if (topLevel) this.refusedNavigation = `${target} (${allowed.reason ?? "refused"})`;
        else this.blocked += 1;
        await this.fail(event);
        return;
      }
      // A top-level document does not leave the site: we record where the
      // page wanted to go and refuse to follow it, because another origin's
      // DOM is not this page's evidence and crawling it was never budgeted.
      if (topLevel && isSameOrigin(target, this.origin) && !this.pinned(target)) {
        // Our origin by `isSameOrigin`, but a spelling that was not approved
        // at launch: refused, as the start of `render` refuses it.
        this.refusedNavigation = `${target} (host not approved for this pass)`;
        await this.fail(event);
        return;
      }
      if (topLevel && !isSameOrigin(target, this.origin)) {
        this.offSite = target;
        this.blocked += 1;
        this.onRequestBlocked?.(target);
        await this.fail(event);
        return;
      }
    }

    if (!isSameOrigin(target, this.origin) || !this.pinned(target)) {
      this.blocked += 1;
      this.onRequestBlocked?.(target);
      await this.fail(event);
      return;
    }

    // SAME-ORIGIN, BUT PAINT-ONLY. An image, a video and a font cannot change
    // `innerText` or the anchor counts — they change what the page LOOKS like,
    // and this pass measures what it SAYS. Aborted, so they are neither sent
    // nor paced.
    if (PAINT_ONLY_RESOURCES.has(event.resourceType)) {
      this.skipped += 1;
      await this.fail(event);
      return;
    }

    if (event.request.method === "GET" && this.ledger.isFresh(target, Date.now())) {
      if (event.networkId !== undefined) this.predicted.add(event.networkId);
      await this.release(event);
      return;
    }

    this.queue.push(event);
    if (!this.pumping) this.guard(this.pump());
  }

  private pinned(url: string): boolean {
    return this.pinnedHosts.has(new URL(url).hostname.toLowerCase());
  }

  /** One slot claimed at a time — see the class docblock. */
  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      for (;;) {
        if (!this.open) return;
        const next = this.queue.shift();
        if (next === undefined) return;
        // EACH REQUEST'S OWN HOST, not the origin's: `isSameOrigin` admits
        // both `www.` and the apex, and the crawl earned its state under
        // whichever one it actually fetched (`HostGate` keys by `URL.host`).
        await this.gate.acquire(gateKey(next.request.url));
        if (!this.open) {
          // Woke into a shut render: this request is failed, not released.
          await this.fail(next);
          return;
        }
        this.paced += 1;
        await this.release(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Let a paused request go to the browser's network stack (and its cache) —
   * the ONE place that ever happens, and only while the render is open. A shut
   * render fails it instead.
   */
  private async release(event: PausedRequest): Promise<void> {
    if (!this.open) {
      await this.fail(event);
      return;
    }
    const injected = this.testFaults?.failRelease?.(event.request.url) ?? null;
    if (injected !== null) throw injected;
    if (!this.pending.delete(event.requestId)) return; // already answered (failed by shut)
    if (event.networkId !== undefined) {
      this.inFlight.set(event.networkId, { url: event.request.url, method: event.request.method });
    }
    this.testFaults?.onRelease?.(event.request.url, Date.now());
    await this.command("Fetch.continueRequest", { requestId: event.requestId });
  }

  private async fail(event: PausedRequest): Promise<void> {
    if (!this.pending.delete(event.requestId)) return; // already answered
    await this.command("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    });
  }

  private async command(method: "Fetch.continueRequest" | "Fetch.failRequest", params: object) {
    try {
      // The protocol's typed overloads want a literal method name per call;
      // both commands here take `{requestId, …}` and answer nothing.
      await (this.cdp.send as (m: string, p: object) => Promise<unknown>)(method, params);
    } catch (error) {
      if (REQUEST_GONE.test(error instanceof Error ? error.message : String(error))) return;
      // A failRequest on a target that is closing has nothing left to fail.
      if (method === "Fetch.failRequest" && !this.open && isTargetClosed(error)) return;
      throw error;
    }
  }

  /**
   * An answer for one request: from the cache (counted, and nothing else — the
   * site was not asked) or from the site (reported to the gate, and to the
   * ledger). In the PAGE vocabulary, by the same `classifyStatus` table the
   * crawl and the resource pass use, so a 429 or a `Retry-After` on a script is
   * the same statement about the host as one on a page. No body is read, so a
   * 503 is not checked for challenge markers — the resource pass's reading,
   * and the honest one.
   *
   * A NETWORK answer for a request this render never paused is a request the
   * interception could not see — in practice a speculation-rules prefetch
   * (module header). It is counted in `unpacedNetwork`, reported like any
   * other answer, and it claims a gate slot after the fact, so the next paced
   * request still waits a spacing behind it.
   */
  private onResponse(requestId: string, response: NetworkResponse): void {
    if (!isHttpUrl(response.url)) return;
    const sent = this.inFlight.get(requestId);
    this.inFlight.delete(requestId);
    // A SHUT RENDER STILL HEARS ITS OWN REQUESTS. One released before `shut`
    // is on the wire whatever happens to the page, and its answer is the
    // site's statement about the host: a late 429 is reported into the gate
    // like any other. Everything else — counts already taken, the ledger, a
    // claim for a request never paused — is this render's bookkeeping and
    // stops at `shut`.
    if (!this.open) {
      const cachedLate =
        response.fromDiskCache === true ||
        response.fromPrefetchCache === true ||
        response.fromServiceWorker === true ||
        this.servedFromCache.delete(requestId);
      if (sent !== undefined && !cachedLate && isSameOrigin(response.url, this.origin)) {
        this.reportAnswer(response);
      }
      return;
    }
    // THE SITE FAILED A REQUEST WE SENT: a status of 400 or above on one this
    // render released (a 404 never fires `loadingFailed`). Not the top-level
    // document — its status is the page's own, on the row already.
    if (sent !== undefined && response.status >= 400 && !this.documentIds.has(requestId)) {
      this.reported.addFailedRequest(sent.url, response.status, `http ${response.status}`);
    }
    const fromCache =
      response.fromDiskCache === true ||
      response.fromPrefetchCache === true ||
      response.fromServiceWorker === true ||
      this.servedFromCache.delete(requestId);
    const wasPredicted = this.predicted.delete(requestId);
    if (fromCache) {
      this.cached += 1;
      return;
    }
    if (!isSameOrigin(response.url, this.origin)) return;
    const unseen = !this.pausedIds.has(requestId) && !this.speculative.has(requestId);
    if (wasPredicted || unseen) {
      this.unpacedNetwork += 1;
      if (wasPredicted) this.ledger.mispredicted(response.url);
      if (unseen) this.guard(this.gate.acquire(gateKey(response.url)));
    }

    const headers = this.reportAnswer(response);
    if (!wasPredicted && response.status === 200 && sent?.method === "GET") {
      this.ledger.record(response.url, headers, Date.now());
    }
  }

  /**
   * Report one network answer from the site into the gate, under the host
   * that answered it, in the page vocabulary. The caller has already ruled
   * out a cached answer and another origin's. Returns the lower-cased headers.
   */
  private reportAnswer(response: NetworkResponse): HeaderBag {
    const headers = lowerCaseHeaders(response.headers);
    const fetchClass = classifyStatus(response.status, headers, "");
    const throttled =
      fetchClass === "blocked" || (fetchClass === "server_error" && response.status === 503);
    this.gate.report(gateKey(response.url), {
      fetchClass,
      statusCode: response.status,
      retryAfterMs: throttled ? parseRetryAfter(headerValue(headers, "retry-after")).ms : null,
      url: response.url,
    });
    return headers;
  }

  /**
   * A request the browser sent on its own account (a speculation-rules
   * prefetch): same-origin ones reached the site without a slot, so they are
   * counted and claim one after the fact; another origin's never left the
   * fence.
   */
  private onSpeculative(requestId: string, url: string): void {
    // After shut the render's counts are already taken; a prefetch announced
    // then claims nothing in its name.
    if (!this.open) return;
    if (!isHttpUrl(url) || !isSameOrigin(url, this.origin)) return;
    if (this.pausedIds.has(requestId) || this.speculative.has(requestId)) return;
    this.speculative.add(requestId);
    this.unpacedNetwork += 1;
    this.guard(this.gate.acquire(gateKey(url)));
  }

  /**
   * A request we released that never got an answer. Reported as
   * `network_error` — not pushback, and not clean either, so it restarts the
   * host's recovery count exactly as a crawl fetch's would. A cancellation (the
   * page closed or dropped it) and our own `BlockedByClient` are not answers
   * from the site and are not reported.
   *
   * What IS reported is also the page's failed request (`render_console`), under
   * Chromium's net error name — a classification, never transport text — unless
   * it is the top-level document, whose failure is the render's own error.
   */
  private onFailed(
    requestId: string,
    errorText: string,
    canceled: boolean,
    blockedReason: string | undefined,
  ): void {
    const sent = this.inFlight.get(requestId);
    this.inFlight.delete(requestId);
    this.predicted.delete(requestId);
    if (!this.open || sent === undefined || canceled || blockedReason !== undefined) return;
    if (errorText === "net::ERR_BLOCKED_BY_CLIENT" || errorText === "net::ERR_ABORTED") return;
    if (!this.documentIds.has(requestId)) this.reported.addFailedRequest(sent.url, null, errorText);
    this.gate.report(gateKey(sent.url), {
      fetchClass: "network_error",
      statusCode: null,
      retryAfterMs: null,
      url: sent.url,
    });
  }
}

/**
 * The `HostGate` key for a request: its own `URL.host` (hostname and any
 * explicit port), the key the crawl loop uses, so a host's earned state is
 * found under the same spelling it was earned under.
 */
function gateKey(url: string): string {
  return new URL(url).host;
}

/**
 * The level a `Runtime.consoleAPICalled` type is kept at, or null when it is
 * not kept. A failed `console.assert` arrives as its own type, `assert`, and is
 * an error the page reported — kept as `error`. `log`, `info`, `debug` and the
 * rest are not kept.
 */
function consoleLevel(type: string): "error" | "warning" | null {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning") return "warning";
  return null;
}

/** The slice of a `Runtime.RemoteObject` a console line is written from. */
interface RemoteObject {
  type: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

/** The slice of `Runtime.ExceptionDetails` an exception entry is written from. */
interface ExceptionDetails {
  text: string;
  exception?: RemoteObject;
}

/**
 * One console argument or thrown value as text, the way DevTools prints it: a
 * string as itself, anything else by the runtime's own description (an Error's
 * is its message and the page's stack). Format specifiers (`%s`) are not
 * applied; the arguments are joined with a space.
 */
function remoteText(o: RemoteObject): string {
  if (o.type === "string") return String(o.value);
  if (o.unserializableValue !== undefined) return o.unserializableValue;
  if (o.description !== undefined) return o.description;
  if (o.type === "undefined") return "undefined";
  return JSON.stringify(o.value) ?? String(o.value);
}

/**
 * Why `url` cannot be rendered by a browser whose network is pinned to
 * `pinnedHosts`, or null when it can.
 */
function unpinnedReason(
  url: string,
  pinnedHosts: ReadonlySet<string>,
  unpinned: readonly UnpinnedHost[],
): string | null {
  const host = new URL(url).hostname.toLowerCase();
  if (pinnedHosts.has(host)) return null;
  const known = unpinned.find((u) => u.host === host);
  return known === undefined
    ? `${host} is not a spelling of this crawl's origin the render pass can reach`
    : `${host} was not approved for this pass (${known.reason})`;
}

/** A URL as the browser puts it on the wire: parsed, serialised, without its fragment. */
function requestUrlOf(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

/** The browser or Playwright telling us the page, context or session is gone. */
function isTargetClosed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /closed|detached|Target page|No target with given id|Session with given id not found/i.test(
    message,
  );
}

function lowerCaseHeaders(headers: Record<string, string>): HeaderBag {
  const out: HeaderBag = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/**
 * TEST ONLY — fault injection for the fail-closed guarantee, the way
 * `allowPrivate` is the fixture-server escape hatch. Never wire it to an API
 * field.
 */
export interface RenderTestFaults {
  /**
   * Called just before a paused request would be released. An `Error`
   * returned is thrown in place of the release, exactly where a protocol
   * command the browser refused would throw.
   */
  failRelease?: (url: string) => Error | null;
  /**
   * Told each time a paused request is actually released — just before its
   * `Fetch.continueRequest` — with `Date.now()`, the clock the host gate
   * spaces slots on. Observes only; it changes nothing about the release. A
   * suite measures pacing here, where the gate imposes it, rather than at the
   * server, where each request's own trip through Chromium's network stack
   * adds jitter that is not the gate's.
   */
  onRelease?: (url: string, atMs: number) => void;
  /**
   * Awaited between the traffic's `shut` and the page's close, so a suite can
   * hold the window in which an answer to a request released BEFORE the shut
   * arrives after it (it must still be reported to the gate).
   */
  holdAfterShut?: () => Promise<void>;
}

/** Where the network fence listens. */
const FENCE_HOST = "127.0.0.1";

/**
 * The network fence: a local TCP listener every proxied connection is sent to
 * and dropped at. The browser runs with it as its proxy for EVERYTHING except
 * http(s) to the crawl's own origin's approved hostnames AT THEIR PORTS
 * (`browserNetworkSwitches`), so a request the `Fetch` interception
 * cannot see — a WebSocket (any host, the origin included: the bypass is
 * scheme-qualified, so `ws://` to the origin is proxied), a speculation-rules
 * prefetch to another host, a request from any target this renderer never
 * attached to — never reaches any host but the origin. A dropped connection
 * fails the request on the browser side; it is counted here.
 */
class NetworkFence {
  connections = 0;

  private constructor(private readonly server: Server) {}

  static async open(): Promise<NetworkFence> {
    let fence: NetworkFence | null = null;
    const server = createTcpServer((socket) => {
      if (fence !== null) fence.connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, FENCE_HOST, () => resolve());
    });
    fence = new NetworkFence(server);
    return fence;
  }

  /** The Chromium switches that put every connection but the origin's through it. */
  port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

/**
 * The Chromium switches that confine the browser's network to ONE place: the
 * crawl's origin, at the address url-policy approved for it. Exported for its
 * unit test.
 *
 *  - `--proxy-server` — every connection goes to the fence (`NetworkFence`),
 *    which drops it…
 *  - `--proxy-bypass-list` — …except `http(s)://<origin host>:<port>`.
 *    `<-loopback>` first: Chromium otherwise sends loopback addresses direct,
 *    and 127.0.0.1 is precisely where an SSRF aims. The rule names the scheme
 *    (so `ws://` to the origin is fenced) AND THE EFFECTIVE PORT, always: a
 *    rule without a port matches every port of the host, and
 *    `new URL("https://shop.com").host` has none, so a default-port origin
 *    would otherwise exempt `shop.com:22` and every other port from the
 *    fence. IPv6 hosts keep their brackets (`URL.hostname` has them).
 *  - `--host-resolver-rules` — the origin's NAME resolves to the approved
 *    address and nothing else, for the whole pass: a DNS answer that changes
 *    mid-pass (rebinding: public at the check, private at the connect) is
 *    never asked for. Every other name resolves to nothing (`~NOTFOUND`) — a
 *    second wall behind the fence, since nothing else should be resolved by
 *    the browser at all. The catch-all excludes the fence's own address and
 *    an IP-literal origin (which needs no mapping), because Chromium's `*`
 *    matches literals as well.
 */
export function browserNetworkSwitches(opts: {
  origin: string;
  fencePort: number;
  /**
   * Every hostname spelling of the origin that url-policy approved, with the
   * address it is pinned to (`resolveApprovedAddress`). An IP-literal
   * hostname carries itself. A spelling absent from this list is fenced.
   */
  pinned: ReadonlyArray<{ hostname: string; address: string }>;
}): string[] {
  const { schemePorts } = originVariants(opts.origin);
  const bypass: string[] = [];
  const maps: string[] = [];
  const excludes: string[] = [FENCE_HOST];
  for (const { hostname, address } of opts.pinned) {
    for (const { protocol, port } of schemePorts) bypass.push(`${protocol}//${hostname}:${port}`);
    if (isIpLiteralHostname(hostname)) {
      // Chromium's EXCLUDE wants the bare address (measured: a bracketed
      // IPv6 literal is not excluded); the bypass rule keeps the brackets.
      excludes.push(hostname.replace(/^\[(.*)\]$/, "$1"));
    } else {
      maps.push(`MAP ${hostname} ${address.includes(":") ? `[${address}]` : address}`);
    }
  }
  // `MAP *` matches IP literals too (measured: a 127.0.0.1 origin failed
  // with ERR_NAME_NOT_RESOLVED), so the fence's own address and a literal
  // origin are EXCLUDEd from the catch-all.
  const resolverRules = [...maps, "MAP * ~NOTFOUND", ...excludes.map((e) => `EXCLUDE ${e}`)];
  return [
    `--proxy-server=http://${FENCE_HOST}:${opts.fencePort}`,
    `--proxy-bypass-list=${["<-loopback>", ...bypass].join(";")}`,
    `--host-resolver-rules=${resolverRules.join(",")}`,
  ];
}

/**
 * The spellings of the crawl's own origin the fence exempts and the pin
 * resolves: the crawl's hostname first, then its `www.`/apex twin
 * (`hostnameSpellings`, the crawler's one definition of "the same site"), with
 * the origin's own scheme and effective port, and https:443 as well when the
 * origin is http:80 (the upgrade `isSameOrigin` allows).
 *
 * This is NARROWER than `isSameOrigin`, deliberately, and the gap is the
 * interception's to close, not the fence's. `isSameOrigin` compares hostnames
 * modulo one leading `www.` without asking what the hostname is, so for a
 * `www.` origin it also admits `www.www.<host>` — a name nobody owns, which is
 * not listed here and never resolved (resolving it would put a made-up name on
 * the wire; `hostnameSpellings` says the same of `www.<ip>`, which the WHATWG
 * URL parser refuses outright as a hostname, so `isSameOrigin` never sees it).
 * A URL on `www.www.<host>` passes `isSameOrigin`, is not pinned, and so fails
 * as a classified `policy refusal` (`unpinnedReason`: "not a spelling of this
 * crawl's origin the render pass can reach") — the same path as a spelling
 * url-policy refused, never a request the fence silently drops. `isSameOrigin`
 * itself is not narrowed: sites redirect between the spellings it admits and
 * the crawl's boundary must keep admitting them. Exported for its unit test,
 * which pins the omission.
 */
export function originVariants(origin: string): {
  hostnames: string[];
  schemePorts: Array<{ protocol: string; port: string }>;
} {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError(`originVariants: origin must be http(s), got ${origin}`);
  }
  const host = parsed.hostname.toLowerCase();
  // Own spelling first: the launch requires it and tolerates the twin.
  // `hostnameSpellings` answers apex-first and knows an IP literal has no twin.
  const hostnames = [host, ...hostnameSpellings(host).filter((twin) => twin !== host && twin !== "")];
  const port = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
  const schemePorts = [{ protocol: parsed.protocol, port }];
  if (parsed.protocol === "http:" && port === "80") schemePorts.push({ protocol: "https:", port: "443" });
  return { hostnames, schemePorts };
}

function isIpLiteralHostname(hostname: string): boolean {
  return /^\[.*\]$/.test(hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** A spelling of the origin that could not be approved, and why. */
export interface UnpinnedHost {
  host: string;
  /** The sentence a caller may be shown (`resolveApprovedAddress`'s message). */
  reason: string;
  /**
   * The resolver's own message behind a `reason` of `<host> could not be
   * resolved` (`UrlPolicyError.cause`), else null. FOR THE SERVER LOG ONLY:
   * the API projects it away before the summary is answered.
   */
  detail: string | null;
}

/**
 * A launched browser plus the policy every render through it obeys.
 *
 * One instance per pass. A render takes an idle CONTEXT from the pool (or opens
 * one), renders in a fresh PAGE of it, and gives the context back once it is
 * clean — so the pool holds at most as many contexts as renders have ever run
 * at once, which `runRenderPass` bounds at `renderConcurrency` (rule 6). What a
 * reused context carries from one URL to the next is its HTTP cache and
 * nothing else: cookies, permissions and the origin's storage are cleared
 * after the page is closed and again before the next one navigates (`release`,
 * `clearState`), `sessionStorage` and the JS heap die with the page, and
 * service workers never start. A context that cannot be shown clean is closed
 * rather than reused.
 */
export class PageRenderer {
  private readonly idle: ContextSlot[] = [];
  private readonly originHost: string;

  private constructor(
    private readonly browser: Browser,
    private readonly fence: NetworkFence,
    /** The hostname spellings the browser can reach (pinned and exempt from the fence). */
    private readonly pinnedHosts: ReadonlySet<string>,
    private readonly unpinned: readonly UnpinnedHost[],
    private readonly opts: Required<
      Omit<
        RendererOptions,
        | "onRequestBlocked"
        | "robotsCrawlDelaySec"
        | "allowPrivate"
        | "earnedSpacingMs"
        | "hostSpacing"
        | "testFaults"
        | "resolve"
      >
    > & {
      allowPrivate: boolean;
      onRequestBlocked: ((url: string) => void) | null;
      testFaults: RenderTestFaults | null;
    },
    private readonly gate: HostGate,
  ) {
    this.originHost = new URL(opts.origin).host;
  }

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
      earnedSpacingMs: options.earnedSpacingMs ?? null,
    });
    // SEEDED FROM THE CRAWL (§3.4.1): the render pass is the same crawler
    // talking to the same host minutes later, and it re-enters each host where
    // the crawl left it — spacing, ratchet level, recovery count and lock.
    if (options.hostSpacing !== null && options.hostSpacing !== undefined) {
      try {
        gate.restore(options.hostSpacing);
      } catch (error) {
        throw new Error(
          `PageRenderer: stored host_spacing_jsonb cannot be restored: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    // THE ORIGIN'S ADDRESSES, approved once and pinned (see
    // `browserNetworkSwitches`), for every hostname spelling the
    // interception admits (`originVariants`). A host with several A records
    // is pinned to the first approved IPv4 for the whole pass: every answer
    // was checked, one is used. The crawl's OWN hostname must be approved — a
    // resolution failure or a blocked answer there stops the launch (a
    // `UrlPolicyError`, which the API maps to a 409). The other spelling may
    // fail url-policy: it is then left out of the pin and the bypass (so it
    // is fenced), a render of a URL on it is a classified `policy refusal`,
    // and the omission is in `unpinnedHosts()` and the pass summary. Only a
    // `UrlPolicyError` is that kind of failure — a refused address, no record,
    // a resolver that could not answer. Anything else the resolver throws is a
    // defect of ours (rule 7) and fails the launch, as it would on the
    // crawl's own hostname.
    const policyOpts = {
      allowPrivate: options.allowPrivate === true,
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    };
    const [primary, ...others] = originVariants(options.origin).hostnames;
    const pinned = [
      { hostname: primary!, address: await resolveApprovedAddress(primary!, policyOpts) },
    ];
    const unpinned: UnpinnedHost[] = [];
    for (const hostname of others) {
      try {
        pinned.push({ hostname, address: await resolveApprovedAddress(hostname, policyOpts) });
      } catch (error) {
        if (!(error instanceof UrlPolicyError)) throw error;
        unpinned.push({
          host: hostname,
          reason: firstLine(error),
          detail: error.cause === undefined ? null : firstLine(error.cause),
        });
      }
    }
    const fence = await NetworkFence.open();
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          // `window.open` answers null and no popup is ever created: a popup
          // is a page this renderer did not open, outside its interception.
          "--block-new-web-contents",
          // A shared worker's own requests are outside a page's interception
          // (measured), so there are none.
          "--disable-shared-workers",
          ...browserNetworkSwitches({ origin: options.origin, fencePort: fence.port(), pinned }),
        ],
      });
    } catch (error) {
      await fence.close();
      throw error;
    }
    return new PageRenderer(
      browser,
      fence,
      new Set(pinned.map((p) => p.hostname)),
      unpinned,
      {
        origin: options.origin,
        htmlDir: options.htmlDir,
        userAgent: options.userAgent,
        perHostDelayMs: options.perHostDelayMs,
        navigationTimeoutMs,
        settleMs,
        allowPrivate: options.allowPrivate === true,
        onRequestBlocked: options.onRequestBlocked ?? null,
        testFaults: options.testFaults ?? null,
      },
      gate,
    );
  }

  /**
   * The spacing in force for the crawl's origin right now: the seeded state
   * (base × ratchet level) once the crawl's own record has been restored, and
   * whatever the render's own responses have done to it since.
   */
  effectiveDelayMs(): number {
    return this.gate.spacingMs(this.originHost);
  }

  /** The gate's per-host state, for `crawls.host_spacing_jsonb` (`HostGate.snapshot`). */
  throttleSnapshot(): Record<string, HostSpacingEntry> {
    return this.gate.snapshot();
  }

  /** What each host did to this renderer's pace (`HostGate.throttleRecord`). */
  throttleRecord(): Record<string, HostThrottle> {
    return this.gate.throttleRecord();
  }

  /** The widest spacing any host has reached, seeded peak included. */
  maxSpacingMs(): number {
    return this.gate.maxSpacingMs();
  }

  /** `HostGate.spacingGeneration`: moves whenever any host's spacing does. */
  spacingGeneration(): number {
    return this.gate.spacingGeneration();
  }

  /**
   * The origin's spellings that could not be approved at launch and are
   * therefore fenced for the whole pass, each with its reason. Empty when
   * every spelling was approved.
   */
  unpinnedHosts(): UnpinnedHost[] {
    return this.unpinned.map((u) => ({ ...u }));
  }

  /** Connections the network fence dropped: requests the interception could not see. */
  fencedConnections(): number {
    return this.fence.connections;
  }

  /**
   * Render one URL and measure what the browser built.
   *
   * NEVER THROWS FOR ANYTHING THE SITE DID. A refused URL, a dead host, a page
   * that never finishes loading — each comes back as a `RenderResult` carrying
   * a classified `error`, because the pass records failures rather than
   * skipping URLs (rule 7). It DOES throw for anything that is OURS: a browser
   * that is gone, our own instruments failing on a document the browser
   * successfully built, a disk that will not take the evidence, a protocol
   * command the interception could not issue. Those must stop the pass rather
   * than mark a site unrenderable.
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
      return failure(url, `policy refusal: ${verdict.reason ?? "refused"}`, null, NO_TRAFFIC);
    }
    const unpinned = unpinnedReason(url, this.pinnedHosts, this.unpinned);
    if (unpinned !== null) return failure(url, `policy refusal: ${unpinned}`, null, NO_TRAFFIC);

    const slot = this.idle.pop() ?? (await this.openSlot());
    let page: Page;
    let traffic: RenderTraffic;
    try {
      // Cleared again HERE, not only after the last page closed: DOM storage
      // a closing renderer was still committing may land after that clear.
      await this.clearState(slot);
      page = await slot.context.newPage();
      const cdp = await slot.context.newCDPSession(page);
      const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      traffic = new RenderTraffic(
        cdp,
        this.gate,
        this.opts.origin,
        this.pinnedHosts,
        tree.frameTree.frame.id,
        requestUrlOf(url),
        slot.ledger,
        this.opts.allowPrivate,
        this.opts.onRequestBlocked,
        this.opts.testFaults,
      );
      await traffic.start();
    } catch (error) {
      // Setting up our own instruments failed: the context is in an unknown
      // state and the error is ours. Neither is reused nor recorded.
      await slot.context.close();
      throw error;
    }
    let crashed = false;
    page.on("crash", () => {
      crashed = true;
    });

    try {
      // ---------------------------------------------------------------------
      // PHASE 1 — what the SITE does. Everything in this inner try is
      // classified rather than thrown, because every way it can fail is a fact
      // about the page (rule 7). It ends either by returning a classified
      // `RenderResult` or by handing phase 2 the document it built.
      // ---------------------------------------------------------------------
      let navigated: { finalUrl: string; measured: Measurement };
      try {
        // The DOCUMENT's wait is spent HERE, after the page and its
        // interception exist (that setup is ours and must not be spent out of
        // the site's spacing, rule 9) and BEFORE `goto`, so it is not charged
        // to the navigation budget. Its slot is CLAIMED in the interception,
        // beside the request, like every other request's: a slot claimed here
        // would be followed by our own navigation latency, which the site would
        // see as a shorter gap before the document's first asset. (Another
        // worker may claim the slot in between; the document then waits for
        // the next one inside the budget, bounded as `renderLeaseSeconds`
        // says.)
        // The document's OWN host (a `www.` page waits on `www.`'s state, not
        // the apex's), as every request in the interception is keyed.
        const wait = this.gate.msUntilFree(gateKey(url));
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

        // Raced against `traffic.broken`: a protocol command of ours that
        // failed has shut the render, and waiting out the navigation budget
        // for requests it will now never release would only delay the throw.
        await Promise.race([
          page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: this.opts.navigationTimeoutMs,
          }),
          traffic.broken,
        ]);
        if (this.opts.settleMs > 0) {
          await Promise.race([page.waitForTimeout(this.opts.settleMs), traffic.broken]);
        }
        if (traffic.failure !== null) throw traffic.failure;

        // WHERE THE BROWSER ENDED UP decides whether there is anything to
        // measure. A navigation this pass aborted — off-site, or policy-refused
        // — leaves Chromium on its own `chrome-error://` surface, and measuring
        // that would report the browser's error page as the site's rendered
        // DOM. It is a failed render carrying a redirect, not a render (rule 7).
        const finalUrl = page.url();
        if (!isHttpUrl(finalUrl)) {
          const stopped = stoppedNavigation(url, traffic);
          if (stopped !== null) return stopped;
          return failure(
            url,
            `navigation error: browser ended on ${finalUrl}`,
            null,
            traffic.evidence(),
          );
        }

        // IN PHASE 1 RATHER THAN PHASE 2, deliberately, even though it is one
        // of our own instruments: `page.evaluate` runs INSIDE the document, so
        // the way it fails in practice is a page navigating away underneath it
        // ("Execution context was destroyed"), which is the site doing
        // something and is right to classify.
        navigated = { finalUrl, measured: (await page.evaluate(MEASURE_SCRIPT)) as Measurement };
      } catch (error) {
        // Ours first: a protocol command the interception could not issue
        // shut the render, and whatever failed after it is our defect, not
        // the site's.
        if (traffic.failure !== null) throw traffic.failure;
        // Order matters: a page that redirected itself before it finished
        // loading aborts its own navigation, and "we stopped it" is a truer
        // classification than the `net::ERR_ABORTED` the browser reports for it.
        const stopped = stoppedNavigation(url, traffic);
        if (stopped !== null) return stopped;
        if (error instanceof playwrightErrors.TimeoutError) {
          // UNDER PACING: the budget was spent at the site's pace, so the count
          // of requests that waited for a slot is the first thing a reader
          // needs to tell a slow site from a heavily paced one (§3.4.4).
          return failure(
            url,
            `timeout under pacing (${traffic.paced} requests paced): navigation did not ` +
              `reach domcontentloaded within ${this.opts.navigationTimeoutMs}ms`,
            null,
            traffic.evidence(),
          );
        }
        return failure(url, `navigation error: ${firstLine(error)}`, null, traffic.evidence());
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
      if (traffic.failure !== null) throw traffic.failure;

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
        robotsMeta: analysis.robotsMeta,
        metaDescription: analysis.metaDescription,
        h1Text: analysis.h1Text,
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
        redirectUrl: traffic.offSite ?? navigatedTo(url, finalUrl),
        error: null,
        ...traffic.evidence(),
      };
    } finally {
      // Shut FIRST — every queued request failed, every later one failed on
      // arrival — and only then close the page, so nothing the page asks for
      // while it unloads is released, and nothing it held is let go by the
      // close. Then the state is cleared through the janitor.
      // The page is released even if the shut threw — closed and cleaned
      // either way — and then the shut's error surfaces.
      try {
        await traffic.shut();
        await this.opts.testFaults?.holdAfterShut?.();
      } finally {
        await this.release(slot, page, traffic, crashed);
      }
    }
  }

  async close(): Promise<void> {
    // Closing the browser closes every context the pool still holds.
    this.idle.length = 0;
    try {
      await this.browser.close();
    } finally {
      await this.fence.close();
    }
  }

  private async openSlot(): Promise<ContextSlot> {
    const context = await this.browser.newContext({
      userAgent: this.opts.userAgent,
      // A desktop viewport, fixed: a responsive site serves a different DOM at
      // a different width, and a render whose word count depended on an
      // unstated viewport would not be evidence of anything.
      viewport: { width: 1280, height: 900 },
      // A service worker is a client outside the page's interception, and one
      // registered by page N would answer page N+1's requests from ITS cache.
      // None controls a first load anyway, so blocking them changes no DOM.
      serviceWorkers: "block",
    });
    try {
      const janitorPage = await context.newPage();
      const janitor = await context.newCDPSession(janitorPage);
      return { context, ledger: new FreshnessLedger(), janitor };
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  /** Clear the origin's storage, every cookie and every permission in the slot's context. */
  private async clearState(slot: ContextSlot): Promise<void> {
    await slot.janitor.send("Storage.clearDataForOrigin", {
      origin: this.opts.origin,
      storageTypes: ISOLATION_STORAGE_TYPES,
    });
    await slot.context.clearCookies();
    await slot.context.clearPermissions();
  }

  /**
   * Put a context back in the pool, CLEAN, or close it.
   *
   * The page is CLOSED FIRST — after its traffic was shut and its script
   * execution switched off (`silence`), so its timers, `pagehide` and `unload`
   * handlers never run again and anything already asked for is failed. Only then is the state cleared, through the slot's
   * janitor page (`clearState`): the origin's storage (`ISOLATION_STORAGE_TYPES`
   * — the HTTP cache is not among them), every cookie, every permission.
   * Clearing BEFORE the close would leave the page a window in which an
   * unload handler or an interval could write state the next page inherits.
   *
   * A page that CRASHED has nothing left to close cleanly; that is something
   * the site's page did, it already came back as a classified render, and the
   * context is closed rather than reused — the next render opens a fresh one,
   * with an empty cache, which costs requests but never isolation. A close or
   * a clear that fails otherwise is ours, and throws.
   */
  private async release(
    slot: ContextSlot,
    page: Page,
    traffic: RenderTraffic,
    crashed: boolean,
  ): Promise<void> {
    if (crashed) {
      await slot.context.close();
      return;
    }
    try {
      await traffic.silence();
      await page.close();
      await this.clearState(slot);
    } catch (error) {
      await slot.context.close();
      throw new Error(
        `render isolation failed: could not clear the browser context after rendering ` +
          `(${firstLine(error)}) — the next page would inherit this one's state, so the ` +
          "pass stops instead",
        { cause: error },
      );
    }
    this.idle.push(slot);
  }
}

/**
 * The render of a page whose top-level navigation THIS PASS stopped — refused
 * by url-policy, or sent off-site — or null when it stopped none.
 */
function stoppedNavigation(url: string, traffic: RenderTraffic): RenderResult | null {
  if (traffic.refusedNavigation !== null) {
    return failure(url, `policy refusal: ${traffic.refusedNavigation}`, null, traffic.evidence());
  }
  if (traffic.offSite !== null) {
    const offSite = traffic.offSite;
    return failure(url, `off-site navigation: ${offSite}`, offSite, traffic.evidence());
  }
  return null;
}

/** A render refused before a browser page opened: nothing sent, nothing looked at. */
const NO_TRAFFIC: TrafficEvidence = {
  blockedRequests: 0,
  skippedPaintRequests: 0,
  pacedRequests: 0,
  cachedResponses: 0,
  unpacedNetworkRequests: 0,
  console: null,
};

/** A render that produced no measurement, in the one shape all of them share. */
function failure(
  url: string,
  error: string,
  redirectUrl: string | null,
  evidence: TrafficEvidence,
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
    robotsMeta: null,
    metaDescription: null,
    h1Text: null,
    htmlPath: null,
    redirectUrl,
    error,
    ...evidence,
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
 *
 * `rendered_tags_read` (P23-T6) is TRUE exactly when `rendered` is, and null
 * otherwise: it is how a reader tells this pass's null robots meta, description
 * or H1 text ("the DOM had none") from a pre-0022 row's ("nobody read it").
 * Derived here rather than carried on `RenderResult` because it is a fact
 * about which writer stored the row, not about the page.
 *
 * `render_version` (Phase 25) is stamped on EVERY row this writer writes, a
 * pre-browser refusal included, for the same reason: it says which render
 * capture wrote the row, so its `render_console` null ("nothing was looked
 * at") is never read as a pre-25 row's null ("nobody captured it").
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
      rendered_robots_meta = ${result.robotsMeta},
      rendered_meta_description = ${result.metaDescription},
      rendered_h1_text = ${result.h1Text},
      rendered_tags_read = ${result.rendered ? true : null},
      rendered_html_path = ${result.htmlPath},
      rendered_redirect_url = ${result.redirectUrl},
      render_error = ${result.error},
      render_console = ${result.console === null ? null : JSON.stringify(result.console)}::jsonb,
      render_version = ${RENDER_CAPTURE_VERSION}
    where crawl_id = ${crawlId} and url = ${result.url}
    returning id`);

  if (res.rows.length !== 1) {
    throw new Error(
      `writeRenderResult: no page row for '${result.url}' in crawl ${crawlId} ` +
        `(${res.rows.length} rows updated)`,
    );
  }
}

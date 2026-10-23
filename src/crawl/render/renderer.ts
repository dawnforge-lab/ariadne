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
 *    top-level document request after it — a document the page navigates
 *    *itself* to, and every redirect hop of the one we asked for. A refusal is
 *    a classified `render_error`, never a skipped URL.
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
 *    the throttle record the pass writes back. Until 24a the gate spaced the
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
 *  - **No third-party traffic.** Interception fails every request whose origin
 *    is not the crawl's — from the page, its iframes and its workers — and the
 *    browser runs with popups and service workers disabled, so no window or
 *    worker escapes the interception. We are auditing one site; pulling a
 *    client's analytics, ad and font vendors into the record would be both
 *    impolite and non-deterministic. A blocked request never fails the render:
 *    the page is measured as the site's own bytes render it.
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
   * Wait for `domcontentloaded`. Default 15s; 60s under a platform profile
   * (the caller, run-render.ts, decides). Every paced request the document
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
  /** Third-party requests aborted. Diagnostic; not stored on the page row. */
  blockedRequests: number;
  /**
   * Same-origin subresources aborted because they only affect paint (images,
   * media, fonts). Diagnostic; not stored on the page row.
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
   * Same-origin responses that came from the NETWORK although no gate slot was
   * claimed for them: a request the ledger predicted the cache would answer and
   * the browser fetched anyway (evicted, or re-validated). Each is a request
   * that reached the site unpaced, so it is counted rather than assumed away;
   * its URL leaves the ledger, so it is paced next time.
   */
  unpacedNetworkRequests: number;
}

/** The request counters every `RenderResult` carries, success or failure. */
type TrafficCounts = Pick<
  RenderResult,
  | "blockedRequests"
  | "skippedPaintRequests"
  | "pacedRequests"
  | "cachedResponses"
  | "unpacedNetworkRequests"
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
 * One reusable browser context, and what it has learned about its own cache.
 *
 * A worker renders URL after URL in the same context (see `PageRenderer`), so
 * the context's HTTP cache — and the ledger that predicts it — outlive a page.
 * Nothing else does: see `release`.
 */
interface ContextSlot {
  context: BrowserContext;
  ledger: FreshnessLedger;
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
 * `Cache-Control: max-age` (minus `Age`), and no `no-store`, `no-cache` or
 * `Vary: *`. Until that lifetime runs out (less `FRESHNESS_MARGIN_MS`) a
 * request for the same URL is predicted to be a cache hit. Heuristic freshness
 * (`Last-Modified` without `max-age`) is never predicted: the browser's own
 * arithmetic for it is not ours to guess.
 *
 * A WRONG PREDICTION IS COUNTED, NOT HIDDEN. The response says where it came
 * from (`fromDiskCache`). A predicted request that went to the network anyway
 * — the cache evicted it, or the page asked with `cache: "reload"` in a way the
 * request headers did not show — is `RenderResult.unpacedNetworkRequests`, its
 * outcome is still reported to the gate, and its URL leaves the ledger so the
 * next request for it is paced.
 *
 * Bounded at `FRESHNESS_LEDGER_CAPACITY` entries, oldest out first (rule 6).
 */
class FreshnessLedger {
  private readonly freshUntil = new Map<string, number>();

  /** Whether a request for `url` is predicted to be answered from the cache. */
  isFresh(url: string, now: number): boolean {
    const until = this.freshUntil.get(url);
    if (until === undefined) return false;
    if (until > now) return true;
    this.freshUntil.delete(url);
    return false;
  }

  /** A network response for `url`: remember its lifetime, or forget the URL. */
  record(url: string, headers: HeaderBag, now: number): void {
    this.freshUntil.delete(url);
    const lifetimeMs = freshLifetimeMs(headers);
    if (lifetimeMs === null) return;
    this.freshUntil.set(url, now + lifetimeMs);
    if (this.freshUntil.size > FRESHNESS_LEDGER_CAPACITY) {
      const oldest = this.freshUntil.keys().next().value;
      if (oldest !== undefined) this.freshUntil.delete(oldest);
    }
  }

  forget(url: string): void {
    this.freshUntil.delete(url);
  }
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
  if (vary !== null && vary.split(",").some((v) => v.trim() === "*")) return null;
  let maxAgeSec: number | null = null;
  for (const raw of cacheControl.toLowerCase().split(",")) {
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
 * this pass is built around impossible. `Fetch` interception on the page
 * session sees the page's requests, its iframes' and its dedicated workers',
 * and leaves the cache alone; service workers and popups — the two clients
 * it would not see — are disabled at the context and the browser
 * (`serviceWorkers: "block"`, `--block-new-web-contents`).
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

  private done = false;
  /** The goto's own document request, whose slot `render` already claimed. */
  private documentPreAcquired = true;
  private readonly queue: PausedRequest[] = [];
  private pumping = false;
  /** Network ids released WITHOUT a slot because the ledger predicted a cache hit. */
  private readonly predicted = new Set<string>();
  /**
   * Requests released to the network and not yet answered: network id → URL
   * and method. Per render, freed with it — O(one page's requests).
   */
  private readonly inFlight = new Map<string, { url: string; method: string }>();

  constructor(
    private readonly cdp: CDPSession,
    private readonly gate: HostGate,
    private readonly host: string,
    private readonly origin: string,
    private readonly mainFrameId: string,
    private readonly ledger: FreshnessLedger,
    private readonly allowPrivate: boolean,
    private readonly onRequestBlocked: ((url: string) => void) | null,
  ) {}

  /** Wire the listeners and turn interception on. Call before the navigation. */
  async start(): Promise<void> {
    this.cdp.on("Fetch.requestPaused", (event) => {
      this.guard(this.onPaused(event as unknown as PausedRequest));
    });
    this.cdp.on("Network.responseReceived", (event) => {
      const e = event as unknown as { requestId: string; response: NetworkResponse };
      this.onResponse(e.requestId, e.response);
    });
    // A redirect hop's answer arrives here, not as a `responseReceived`.
    this.cdp.on("Network.requestWillBeSent", (event) => {
      const e = event as unknown as { requestId: string; redirectResponse?: NetworkResponse };
      if (e.redirectResponse !== undefined) this.onResponse(e.requestId, e.redirectResponse);
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
    await this.cdp.send("Network.enable");
    await this.cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  }

  /** The render is over: nothing more is released, claimed or reported. */
  finish(): void {
    this.done = true;
  }

  counts(): TrafficCounts {
    return {
      blockedRequests: this.blocked,
      skippedPaintRequests: this.skipped,
      pacedRequests: this.paced,
      cachedResponses: this.cached,
      unpacedNetworkRequests: this.unpacedNetwork,
    };
  }

  private guard(work: Promise<void>): void {
    work.catch((error: unknown) => {
      if (this.done) return; // the render ended under it; the page is going
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    });
  }

  private async onPaused(event: PausedRequest): Promise<void> {
    if (this.done) return;
    const target = event.request.url;

    // A TOP-LEVEL DOCUMENT is evidence, not a subresource: the request we
    // navigated to, one of its redirect hops, or a page sending itself
    // somewhere (the JS redirect CHECK-10 exists to find). It goes through
    // url-policy (rule 5) and it does not leave the site — we record where the
    // page wanted to go and refuse to follow it, because another origin's DOM
    // is not this page's evidence and crawling it was never budgeted.
    if (event.resourceType === "Document" && event.frameId === this.mainFrameId) {
      const allowed = await isUrlAllowed(target, { allowPrivate: this.allowPrivate });
      if (!allowed.allowed) {
        this.refusedNavigation = `${target} (${allowed.reason ?? "refused"})`;
        await this.fail(event);
        return;
      }
      if (!isSameOrigin(target, this.origin)) {
        this.offSite = target;
        this.blocked += 1;
        this.onRequestBlocked?.(target);
        await this.fail(event);
        return;
      }
      if (this.documentPreAcquired && event.redirectedRequestId === undefined) {
        this.documentPreAcquired = false;
        await this.release(event);
        return;
      }
      this.enqueue(event);
      return;
    }

    if (!isSameOrigin(target, this.origin)) {
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

    if (predictable(event) && this.ledger.isFresh(target, Date.now())) {
      if (event.networkId !== undefined) this.predicted.add(event.networkId);
      await this.release(event);
      return;
    }

    this.enqueue(event);
  }

  private enqueue(event: PausedRequest): void {
    this.queue.push(event);
    if (!this.pumping) this.guard(this.pump());
  }

  /** One slot claimed at a time — see the class docblock. */
  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      for (;;) {
        if (this.done) return;
        const next = this.queue.shift();
        if (next === undefined) return;
        await this.gate.acquire(this.host);
        if (this.done) return;
        this.paced += 1;
        await this.release(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Let a paused request go to the browser's network stack (and its cache). */
  private async release(event: PausedRequest): Promise<void> {
    if (event.networkId !== undefined) {
      this.inFlight.set(event.networkId, { url: event.request.url, method: event.request.method });
    }
    await this.command("Fetch.continueRequest", { requestId: event.requestId });
  }

  private async fail(event: PausedRequest): Promise<void> {
    await this.command("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    });
  }

  private async command(method: "Fetch.continueRequest" | "Fetch.failRequest", params: object) {
    if (this.done) return;
    try {
      // The protocol's typed overloads want a literal method name per call;
      // both commands here take `{requestId, …}` and answer nothing.
      await (this.cdp.send as (m: string, p: object) => Promise<unknown>)(method, params);
    } catch (error) {
      if (this.done) return;
      if (REQUEST_GONE.test(error instanceof Error ? error.message : String(error))) return;
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
   */
  private onResponse(requestId: string, response: NetworkResponse): void {
    if (this.done || !isHttpUrl(response.url)) return;
    const sent = this.inFlight.get(requestId);
    this.inFlight.delete(requestId);
    const fromCache =
      response.fromDiskCache === true ||
      response.fromPrefetchCache === true ||
      response.fromServiceWorker === true;
    const wasPredicted = this.predicted.delete(requestId);
    if (fromCache) {
      this.cached += 1;
      return;
    }
    if (!isSameOrigin(response.url, this.origin)) return;
    if (wasPredicted) {
      this.unpacedNetwork += 1;
      this.ledger.forget(response.url);
    }

    const headers = lowerCaseHeaders(response.headers);
    const fetchClass = classifyStatus(response.status, headers, "");
    const throttled =
      fetchClass === "blocked" || (fetchClass === "server_error" && response.status === 503);
    this.gate.report(this.host, {
      fetchClass,
      statusCode: response.status,
      retryAfterMs: throttled ? parseRetryAfter(headerValue(headers, "retry-after")).ms : null,
      url: response.url,
    });
    if (response.status === 200 && sent?.method === "GET") {
      this.ledger.record(response.url, headers, Date.now());
    }
  }

  /**
   * A request we released that never got an answer. Reported as
   * `network_error` — not pushback, and not clean either, so it restarts the
   * host's recovery count exactly as a crawl fetch's would. A cancellation (the
   * page closed or dropped it) and our own `BlockedByClient` are not answers
   * from the site and are not reported.
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
    if (this.done || sent === undefined || canceled || blockedReason !== undefined) return;
    if (errorText === "net::ERR_BLOCKED_BY_CLIENT" || errorText === "net::ERR_ABORTED") return;
    this.gate.report(this.host, {
      fetchClass: "network_error",
      statusCode: null,
      retryAfterMs: null,
      url: sent.url,
    });
  }
}

/** A request the cache may answer: a plain `GET` that did not ask to bypass it. */
function predictable(event: PausedRequest): boolean {
  if (event.request.method !== "GET") return false;
  const headers = lowerCaseHeaders(event.request.headers);
  const cacheControl = headerValue(headers, "cache-control") ?? "";
  const pragma = headerValue(headers, "pragma") ?? "";
  return !/no-cache|no-store|max-age=0/i.test(cacheControl) && !/no-cache/i.test(pragma);
}

function lowerCaseHeaders(headers: Record<string, string>): HeaderBag {
  const out: HeaderBag = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
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
 * before it is reused (`release`), `sessionStorage` and the JS heap die with
 * the page, and service workers never start. A context that cannot be shown
 * clean is closed rather than reused.
 */
export class PageRenderer {
  private readonly idle: ContextSlot[] = [];
  private readonly originHost: string;

  private constructor(
    private readonly browser: Browser,
    private readonly opts: Required<
      Omit<
        RendererOptions,
        "onRequestBlocked" | "robotsCrawlDelaySec" | "allowPrivate" | "earnedSpacingMs" | "hostSpacing"
      >
    > & {
      allowPrivate: boolean;
      onRequestBlocked: ((url: string) => void) | null;
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
    // `--block-new-web-contents`: `window.open` answers null and no popup is
    // ever created. A popup is a page this renderer did not open, so its
    // requests would be outside the interception.
    const browser = await chromium.launch({ headless: true, args: ["--block-new-web-contents"] });
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

    const slot = this.idle.pop() ?? (await this.openSlot());
    let page: Page;
    let cdp: CDPSession;
    let traffic: RenderTraffic;
    try {
      page = await slot.context.newPage();
      cdp = await slot.context.newCDPSession(page);
      const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      traffic = new RenderTraffic(
        cdp,
        this.gate,
        this.originHost,
        this.opts.origin,
        tree.frameTree.frame.id,
        slot.ledger,
        this.opts.allowPrivate,
        this.opts.onRequestBlocked,
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
        // The DOCUMENT's slot is claimed HERE, after the page and its
        // interception exist (that setup is ours and must not be spent out of
        // the site's spacing, rule 9) and BEFORE `goto`, so the wait for it is
        // not charged to the navigation budget. Every later request of the
        // page claims its own slot inside the interception.
        await this.gate.acquire(new URL(url).host);
        traffic.paced += 1;

        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.opts.navigationTimeoutMs,
        });
        if (this.opts.settleMs > 0) await page.waitForTimeout(this.opts.settleMs);
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
            traffic.counts(),
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
        // leaves a request paused for ever, and the timeout that follows is
        // our defect, not the site's.
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
            traffic.counts(),
          );
        }
        return failure(url, `navigation error: ${firstLine(error)}`, null, traffic.counts());
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
        ...traffic.counts(),
      };
    } finally {
      traffic.finish();
      await this.release(slot, page, cdp, crashed);
    }
  }

  async close(): Promise<void> {
    // Closing the browser closes every context the pool still holds.
    this.idle.length = 0;
    await this.browser.close();
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
    return { context, ledger: new FreshnessLedger() };
  }

  /**
   * Put a context back in the pool, CLEAN, or close it.
   *
   * Clean means: the origin's storage cleared through the page's own session
   * (`ISOLATION_STORAGE_TYPES` — the HTTP cache is not among them), the page
   * closed (its `sessionStorage` and heap with it), every cookie and every
   * granted permission in the context cleared. Only then is the context reused.
   *
   * A page that CRASHED, or that is already closed, has no session to clear
   * storage through. That is something the site's page did, it already came
   * back as a classified render, and the context is closed rather than reused
   * — the next render opens a fresh one, with an empty cache, which costs
   * requests but never isolation. A clearing command that fails on a LIVE page
   * is ours, and throws.
   */
  private async release(
    slot: ContextSlot,
    page: Page,
    cdp: CDPSession,
    crashed: boolean,
  ): Promise<void> {
    if (crashed || page.isClosed()) {
      await slot.context.close();
      return;
    }
    try {
      await cdp.send("Storage.clearDataForOrigin", {
        origin: this.opts.origin,
        storageTypes: ISOLATION_STORAGE_TYPES,
      });
      await cdp.detach();
      await page.close();
      await slot.context.clearCookies();
      await slot.context.clearPermissions();
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
    return failure(url, `policy refusal: ${traffic.refusedNavigation}`, null, traffic.counts());
  }
  if (traffic.offSite !== null) {
    const offSite = traffic.offSite;
    return failure(url, `off-site navigation: ${offSite}`, offSite, traffic.counts());
  }
  return null;
}

const NO_TRAFFIC: TrafficCounts = {
  blockedRequests: 0,
  skippedPaintRequests: 0,
  pacedRequests: 0,
  cachedResponses: 0,
  unpacedNetworkRequests: 0,
};

/** A render that produced no measurement, in the one shape all of them share. */
function failure(
  url: string,
  error: string,
  redirectUrl: string | null,
  counts: TrafficCounts,
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
    ...counts,
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

/**
 * The Phase 5 render pages: fixtures that only mean something once a browser
 * has run their JavaScript.
 *
 * Every other page in this collection is judged from the bytes the server sent.
 * These seven are judged from the DIFFERENCE between those bytes and the DOM a
 * real Chromium builds from them, which is the whole subject of the render pass
 * (src/crawl/render/) and of the four rules it feeds:
 *
 *   /render/csr-content        content.csr-dependent  (CHECK-01)
 *   /render/js-nav             nav.js-only            (CHECK-34)
 *   /render/js-filters         filters.js-only        (CHECK-02)
 *   /render/js-redirect        redirect.js            (CHECK-10), same origin
 *   /render/js-redirect-offsite redirect.js           (CHECK-10), another origin
 *   /render/target             — the first redirect's destination
 *   /render/healthy            — the control for all four
 *
 * Four properties this file holds itself to, three of them inherited from the
 * Phase 2 and Phase 3 authored files and one new:
 *
 *  1. **The JavaScript is inline `<script>` and nothing else.** The render pass
 *     aborts every third-party request and every same-origin request whose type
 *     is paint-only (`image`, `media`, `font`), so an external stylesheet or an
 *     image could not be part of what these pages prove. Script is one of the
 *     four types the renderer deliberately allows, so a `<script>` element in
 *     the document is the only delivery mechanism whose behaviour here is the
 *     behaviour production would see.
 *  2. **Prose is written fresh for each page.** Pages built from one paragraph
 *     with a word changed are near-duplicates of each other and
 *     `content.near-duplicate` says so — see the Phase 3 file's own paragraph.
 *     The harness pins the site's whole near-duplicate pair set, so a lazy
 *     seventh page here would fail there rather than pass quietly.
 *  3. **`expectedIssues` is complete, not a floor** (`exact: true`).
 *  4. **NO PAGE HERE RENDERS A RAW `<a href>` EXCEPT `/render/healthy`.** That
 *     is not tidiness, it is what makes six of these pages *suspects* in the
 *     render selection (a page that links nowhere is one of the four suspicion
 *     triggers, src/crawl/render/select.ts) and therefore seated in the render
 *     budget's first tier. `/render/healthy` is the deliberate exception: it
 *     carries a link to ITSELF, which is a `links` row — so it trips no
 *     suspicion — and which no inbound-link count can see, because every
 *     link-graph query in this engine excludes a page's link to itself (the
 *     `links.orphan` lesson). It reaches the render pass through the per-type
 *     sample instead, which is what a "rendered and found nothing" page is for.
 *
 * THE SECOND HOST. `/render/js-redirect-offsite` needs somewhere off this
 * origin to send the browser, and the renderer's contract for that case is a
 * FAILED render carrying a redirect URL (`rendered = false`, `render_error =
 * 'off-site navigation: …'`, `rendered_redirect_url` set) — the shape
 * `redirect.js` exists to catch and the reason it does not gate on `rendered`.
 * `startOffsiteHost` below is that origin: a second `node:http` server on its
 * own port, which is a different origin from the fixture site's even though
 * both are on the loopback. It is never crawled and never linked — the URL
 * appears only inside a `<script>`, where no link extractor looks.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Fixture } from "../fixture.js";
import { article, lorem, serve } from "../render.js";

const RENDER = "render";

// ---------------------------------------------------------------------------
// The second origin
// ---------------------------------------------------------------------------

/** The running off-site server, or null before `startOffsiteHost` is called. */
let offsite: { base: string; server: Server } | null = null;

export interface OffsiteHost {
  /** Origin, no trailing slash. A different origin from the fixture site's. */
  base: string;
  close(): Promise<void>;
}

/**
 * Start the second origin `/render/js-redirect-offsite` sends the browser to.
 *
 * Must be running before the fixture app serves that page — the handler reads
 * `offsiteRedirectTarget()` on every request and throws if the host is not up,
 * rather than serving a page that quietly redirects nowhere (hard rule 7).
 */
export async function startOffsiteHost(): Promise<OffsiteHost> {
  if (offsite !== null) {
    throw new Error("startOffsiteHost: the off-site host is already running");
  }
  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    // Nothing asserts about this body: the render pass aborts the navigation
    // before the request is made, and the whole point of the fixture is that
    // this server is never asked. It answers anyway, so that a test which
    // stopped blocking would show up as a *changed* result rather than as a
    // connection error that could be read as the block working.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end("<!doctype html><title>Another site</title><p>You should not be here.</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  offsite = { base, server };
  return {
    base,
    close: async () => {
      offsite = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/** The exact URL the off-site fixture's script navigates to. */
export function offsiteRedirectTarget(): string {
  if (offsite === null) {
    throw new Error(
      "offsiteRedirectTarget: the off-site host is not running — call startOffsiteHost() " +
        "before starting the fixture app, or /render/js-redirect-offsite would serve a " +
        "redirect to nowhere and the fixture would prove nothing",
    );
  }
  return `${offsite.base}/promotions`;
}

// ---------------------------------------------------------------------------
// /render/csr-content — content.csr-dependent (CHECK-01)
// ---------------------------------------------------------------------------

/**
 * How many words the injected paragraph carries. `lorem` emits exactly this
 * many space-separated words, so the rendered word count is derivable rather
 * than measured: it is this number plus the shell's own visible words.
 *
 * The text is inside a `<script>` string literal, so it contributes NOTHING to
 * the raw side — the analyzer's text accumulator skips `script`, `style`,
 * `noscript` and `svg` subtrees, and `contentHash` and `simhash` read that same
 * accumulator. That is also why re-using `lorem` here cannot make this page a
 * near-duplicate of anything: no two raw texts are involved.
 *
 * **250 UNTIL PHASE 8, 200 NOW, AND THE CHANGE IS THE POINT** — see
 * `CSR_CHROME_WORDS` below for the arithmetic it belongs to.
 */
const CSR_INJECTED_WORDS = 200;

/**
 * The page's CSS-hidden chrome: a region-and-currency popover the theme ships
 * on every page, collapsed. Exactly 100 words, and the number is load-bearing.
 *
 * **THIS BLOCK IS WHAT MAKES THIS FIXTURE PROVE THE PHASE 8 CANCELLATION.** It
 * is hidden by a CLASS, in a stylesheet, which is the one kind of hiding the
 * analyzer cannot see (hard rules 2 and 4: it does not fetch and it does not
 * cascade). So it is counted as renderable text on the raw side AND on the
 * rendered side, and a reader sees none of it — which is exactly the shape the
 * Phase 7 gate measured at a near-constant 425 words on a real Shopify theme
 * (docs/gates/phase-7.md §4.2) and exactly the shape that made
 * `content.csr-dependent` unable to fire there at all (§4.9).
 *
 * The whole page's arithmetic, which is what the harness pins end to end:
 *
 *   shell copy (h1 + one sentence)                     S = 32
 *   this popover, hidden by a CLASS                    C = 100
 *   the account drawer, hidden by the `hidden` ATTRIBUTE D = 40
 *   the paragraph the script writes into `#app`        J = 200
 *
 *   word_count                     = S + C + D     = 172
 *   renderable_word_count          = S + C         = 132   (markup-hidden D out)
 *   rendered_analyzer_word_count   = S + C + D + J = 372
 *   rendered_renderable_word_count = S + C + J     = 332
 *   rendered_word_count (innerText)= S + J         = 232   (C and D both hidden)
 *
 *  - **The rule as it is now** compares the two renderable counts: 332 ≥ 2 × 132
 *    = 264 ✓ and 332 − 132 = 200 ≥ 150 ✓ — it FIRES, and `addedWords` is
 *    exactly J. The 100 words of chrome are on both sides of the subtraction and
 *    cancel to nothing: that identity IS the proof, and it is why the evidence
 *    the harness pins reads 200 and not 300 or 100.
 *  - **The comparison Phase 8 retired** put `innerText` on the rendered side:
 *    232 ≥ 264 ✗ and 232 − 132 = 100 ≥ 150 ✗ — SILENT ON BOTH ARMS. A page that
 *    ships a shell and paints two hundred words of catalogue would have gone
 *    unreported, which is the false negative §4.9 found in the field, reproduced
 *    here in forty lines of markup.
 *
 * **`content.thin` NO LONGER FIRES HERE, and the change is Phase 19 §11's.** The
 * floor read `renderable_word_count` — 132, under 150 — until the amendment
 * moved it onto `main_word_count`, the words the page has of its OWN: the text
 * inside `<main>` (this fixture's whole body, like every fixture's) minus any
 * `<nav>`, `<header>`, `<footer>` or `<aside>` subtree. The popover and the
 * drawer are neither; they are divs, so both counts are in, and the page's own
 * content is 172 words — over the floor.
 *
 * THE TRADE IS REAL AND IS WORTH STATING RATHER THAN GLOSSING: `main_word_count`
 * does not exclude markup-hidden text (see page-analyzer.ts — the main stream
 * uses the `bodyText` rules deliberately, so a hamming distance between two
 * pages cannot depend on which of them hides a dialog), so a page whose shipped
 * words are largely in drawers reads as fuller than a reader would call it. What
 * the amendment bought for that is the case it was written for: on a real
 * templated site EVERY page cleared the old floor on ~900 words of visible
 * header, menu and footer, and the rule fired on nothing at all. Visible chrome
 * is the common shape and hidden chrome the rare one. This page's real finding
 * is `content.csr-dependent`, which says the sharper thing anyway: the content
 * arrives with the JavaScript.
 */
export const CSR_CHROME_WORDS = 100;

/** …and the drawer the markup hides outright. Exactly 40 words. */
const CSR_DRAWER_WORDS = 40;

const CSR_CHROME_TEXT =
  "Choose where you are shopping from and the prices below will change to " +
  "match. Deliveries to addresses inside the United Kingdom leave our warehouse " +
  "on the same working day when an order is placed before noon. Parcels " +
  "travelling to the European Union clear customs in Rotterdam and usually " +
  "arrive within four working days. Shoppers in the United States and Canada " +
  "are billed in dollars at the rate our payment provider publishes each " +
  "morning. Australian and New Zealand addresses are served from the same " +
  "warehouse and take longer. Every price shown includes the tax the " +
  "destination country requires us to collect.";

const CSR_DRAWER_TEXT =
  "Sign in to see the orders you have placed, the addresses you have saved and " +
  "the payment methods this account remembers. None of this panel is visible to " +
  "anybody until somebody presses the small account button sitting in the header.";

const csrContent: Fixture = {
  path: "/render/csr-content",
  category: RENDER,
  name: "Content that only exists after JavaScript runs",
  // One finding, since Phase 19 §11 moved the thin floor onto the page's own
  // content: 172 words of it, over the 150-word floor, because `main_word_count`
  // counts the 40 words this page's markup hides (the docblock above works the
  // arithmetic and says what that trade buys). `content.csr-dependent` is the
  // finding that matters here and it is unaffected.
  expectedIssues: ["content.csr-dependent"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The catalogue that arrives with the JavaScript",
      metaDescription:
        "A shell page whose visible copy is written into the DOM by a script, so the HTML a crawler reads holds almost none of what a reader sees.",
      // The stylesheet is INLINE and one declaration long, for the renderer's
      // own reasons: the render pass aborts nothing that can build DOM but a
      // linked stylesheet would make this fixture's claim depend on a second
      // request completing, and the claim is about counting, not about loading.
      headExtra: '<style>.chrome-popover { display: none }</style>',
      bodyHtml: `<h1>The catalogue is still loading</h1>
<p>Everything a reader sees below this sentence is written into the page by a script, so the markup the server sent says very little on its own.</p>
<div class="chrome-popover" id="region-picker"><p>${CSR_CHROME_TEXT}</p></div>
<div hidden id="account-drawer"><p>${CSR_DRAWER_TEXT}</p></div>
<div id="app"></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"page":"/render/csr-content","buildId":"fixture"}</script>
<script>
document.getElementById('app').innerHTML =
  '<p>' + ${JSON.stringify(lorem(CSR_INJECTED_WORDS))} + '</p>';
</script>`,
    })),
};

/**
 * The fixture's own arithmetic, exported so the harness pins the numbers this
 * file DERIVES rather than numbers somebody typed twice.
 *
 * `CSR_SHELL_WORDS` is counted from the markup above: the `<h1>` is five words
 * and the sentence under it is twenty-seven.
 */
export const CSR_SHELL_WORDS = 32;
export const CSR_EXPECTED = {
  /** `pages.word_count` — every word the response body carries. */
  wordCount: CSR_SHELL_WORDS + CSR_CHROME_WORDS + CSR_DRAWER_WORDS,
  /** `pages.renderable_word_count` — minus what the MARKUP hides. */
  renderableWordCount: CSR_SHELL_WORDS + CSR_CHROME_WORDS,
  /** `pages.rendered_analyzer_word_count` — the same analyzer, post-JS DOM. */
  renderedAnalyzerWordCount:
    CSR_SHELL_WORDS + CSR_CHROME_WORDS + CSR_DRAWER_WORDS + CSR_INJECTED_WORDS,
  /** `pages.rendered_renderable_word_count` — the rule's rendered side. */
  renderedRenderableWordCount: CSR_SHELL_WORDS + CSR_CHROME_WORDS + CSR_INJECTED_WORDS,
  /** `pages.rendered_word_count` — the browser's `innerText`, no longer a verdict. */
  renderedWordCount: CSR_SHELL_WORDS + CSR_INJECTED_WORDS,
  /** What the rule reports, and the whole of the cancellation claim. */
  addedWords: CSR_INJECTED_WORDS,
} as const;

// ---------------------------------------------------------------------------
// /render/js-nav — nav.js-only (CHECK-34)
// ---------------------------------------------------------------------------

/**
 * The navigation the script builds: twelve `<nav>` links and four `<footer>`
 * links, all pointing at pages this site really serves.
 *
 * TWELVE AND FOUR, DERIVED. `nav.js-only` fires when the raw nav+footer count
 * is under `NAV_RAW_MAX` (5), the rendered one is at or above
 * `NAV_RENDERED_MIN` (10), and the rendered one is at least twice the raw one
 * plus one. The raw document below contains no `<nav>`, no `<footer>` and no
 * anchor at all, so its side is 0 — comfortably under 5 — and 16 clears 10 with
 * six links to spare, which is the margin the rule's header asks for against
 * the tokenizer's one-directional undercount of anchors left unclosed across a
 * container boundary. This page closes every tag it opens, so that undercount
 * is zero here and the margin is spent on nothing.
 *
 * NOT ONE OF THESE HREFS MAY LOOK LIKE A FILTER. `filters.js-only` reads the
 * same rendered DOM, and an anchor whose resolved href contains `?` or matches
 * /filter|facet|sort/i counts towards ITS threshold — five would make this page
 * fire that rule too, which would be a fixture proving two things by accident.
 */
const JS_NAV_LINKS = [
  ["/control", "Home"],
  ["/kitchen-sink", "Everything"],
  ["/perf/slow-response", "Patience"],
  ["/structure/orphan", "Alone"],
  ["/content/thin-content", "Brief"],
  ["/head/missing-h1", "Headless"],
  ["/head/multiple-h1", "Two heads"],
  ["/index/canonicalized", "Folded"],
  ["/authored/lorem", "Draft"],
  ["/authored3/reviews", "Praise"],
  ["/deep/1", "Down"],
  ["/render/healthy", "Well"],
] as const;

const JS_FOOTER_LINKS = [
  ["/render/target", "Destination"],
  ["/control", "Home again"],
  ["/authored3/paged-1", "Page one"],
  ["/structure/no-outgoing-links", "Dead end"],
] as const;

function anchorsScript(container: string, links: readonly (readonly [string, string])[]): string {
  const html = links.map(([href, text]) => `<a href="${href}">${text}</a>`).join(" ");
  return `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(
    `<${container}>${html}</${container}>`,
  )});`;
}

/**
 * THE HEAD AND HEADING THIS PAGE'S SCRIPT REWRITES (P23-T6). The same script
 * that builds the menu also retitles the page, replaces its description and
 * rewords its `<h1>` — the three on-page divergences — so the page carries
 * `render.title-changed`, `render.meta-description-changed` and
 * `render.h1-changed` beside `nav.js-only` rather than a new page shifting
 * the harness censuses. The H1 keeps its word count (six words before and
 * after), so no word-count reading on either side moves.
 */
export const JS_NAV_RENDERED_TITLE = "The menu this page builds in the browser";
export const JS_NAV_RENDERED_DESCRIPTION =
  "A script writes this page's menu, its title, this description and its heading after load.";
export const JS_NAV_RENDERED_H1 = "The menu arrives with the script";

const jsNav: Fixture = {
  path: "/render/js-nav",
  category: RENDER,
  name: "Navigation that only exists after JavaScript runs",
  expectedIssues: [
    "nav.js-only",
    "render.title-changed",
    "render.meta-description-changed",
    "render.h1-changed",
  ],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page whose menu is assembled in the browser",
      metaDescription:
        "The article is in the HTML but the navigation is not: a script builds the header menu and the footer links after the page has already been parsed.",
      bodyHtml: `${article({
        h1: "The menu is not in the markup",
        lede: "A crawler that reads this document sees an article with no way out of it.",
        withImage: false,
        sections: [
          {
            h2: "What the server sends",
            body: "The response body carries a heading, three sections of prose and nothing else. There is no header menu in it, no footer, and not one anchor element anywhere in the document, so a crawler that reads the bytes and stops there finds this page to be a dead end with no route onward to any other part of the site.",
          },
          {
            h2: "What the browser builds",
            body: "A script at the end of the body writes a sixteen-link menu into the document: twelve entries across the top of the page and four more along the bottom. To a person the page looks perfectly ordinary. To anything that does not execute the script, every one of those sixteen destinations is invisible and the internal link graph of the whole site is missing a node.",
          },
          {
            h2: "Why the difference matters",
            body: "Menus are how importance travels through a site. When the menu exists only after a script runs, the pages it points at lose the one signal that told a search engine which of them the site considers central, and a crawler budgeting its time on a large site may never reach them at all. Rendering the page is the only way to see that the menu was ever there.",
          },
        ],
      })}
<script>
${anchorsScript("nav", JS_NAV_LINKS)}
${anchorsScript("footer", JS_FOOTER_LINKS)}
document.title = ${JSON.stringify(JS_NAV_RENDERED_TITLE)};
document.querySelector('meta[name="description"]').setAttribute('content', ${JSON.stringify(
        JS_NAV_RENDERED_DESCRIPTION,
      )});
document.querySelector('h1').textContent = ${JSON.stringify(JS_NAV_RENDERED_H1)};
</script>`,
    })),
};

// ---------------------------------------------------------------------------
// /render/js-filters — filters.js-only (CHECK-02)
// ---------------------------------------------------------------------------

/**
 * The eight facet links the script adds. Each carries a query string, which is
 * the first arm of the filter predicate the renderer and the rule both spell
 * (`?` in the resolved href, or /filter|facet|sort/i anywhere in it) — and eight
 * clears `FILTER_RENDERED_MIN` (5) by three.
 *
 * THE RAW SIDE MUST BE EXACTLY ZERO, and "zero" is asked of the `links` table
 * rather than of the markup. `links.target_url` is deduplicated, filtered to
 * http(s) and fragment-stripped, so the safest way to guarantee no row matches
 * is for the page to render no anchor at all — which is what the product grid
 * below does. Its tiles are `<div>`s: a collection page whose only route into
 * its own facets is JavaScript, which is precisely the crawl-budget defect
 * CHECK-02 asks about.
 */
const JS_FILTER_FACETS = [
  "colour-blue",
  "colour-green",
  "size-small",
  "size-large",
  "price-under-fifty",
  "price-over-fifty",
  "in-stock",
  "on-offer",
] as const;

/**
 * THE DIRECTIVES THIS PAGE'S SCRIPT CHANGES (P23-T6). The served HTML carries
 * no robots meta and a self-referencing canonical; the script adds a noindex
 * and points the canonical at another page — the two directive divergences,
 * `render.noindex-changed` and `render.canonical-changed`, on the page whose
 * facets already only exist in the browser. Neither touches an anchor, so the
 * filter-link counts on both sides are what they were.
 */
export const JS_FILTERS_RENDERED_ROBOTS = "noindex, follow";
export const JS_FILTERS_RENDERED_CANONICAL = "/render/healthy";

const jsFilters: Fixture = {
  path: "/render/js-filters",
  category: RENDER,
  name: "Faceted navigation that only exists after JavaScript runs",
  expectedIssues: ["filters.js-only", "render.noindex-changed", "render.canonical-changed"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A collection page with no links into its facets",
      metaDescription:
        "The product grid is server-rendered but every filter is added by a script, so a crawler sees a collection with no way to reach any of its refinements.",
      bodyHtml: `${article({
        h1: "A collection whose filters are invisible to a crawler",
        lede: "The grid below is in the HTML. The eight refinements above it are not.",
        withImage: false,
        sections: [
          {
            h2: "The grid the server renders",
            body: "Twelve tiles arrive in the response body, each one naming a product and its price. They are plain blocks of markup rather than links, because on this template a tile becomes clickable only once the storefront script has attached its handlers, which is a pattern common enough in headless commerce that it is worth having a fixture for.",
          },
          {
            h2: "The refinements the script adds",
            body: "After the page is parsed, a script inserts a row of eight refinement links above the grid: two colours, two sizes, two price bands, a stock filter and an offers filter. Every one of them is an ordinary anchor with a query string, and every one of them is a URL a crawler would happily follow if it had ever been told the URL existed.",
          },
          {
            h2: "What it costs",
            body: "A faceted collection whose facets are only reachable by script is a collection a search engine sees one page of. Nothing behind the refinements is discoverable, so none of it competes for anything, and the site owner concludes that the category simply does not rank rather than that nothing ever found it. Serving the same eight anchors in the HTML costs nothing and fixes it outright.",
          },
        ],
      })}
<div class="grid">
<div class="tile">Blue enamel mug, twelve pounds</div>
<div class="tile">Green enamel mug, twelve pounds</div>
<div class="tile">Small canvas tote, eighteen pounds</div>
<div class="tile">Large canvas tote, twenty four pounds</div>
<div class="tile">Cotton apron, twenty two pounds</div>
<div class="tile">Linen tea towel, nine pounds</div>
<div class="tile">Stoneware bowl, sixteen pounds</div>
<div class="tile">Stoneware plate, fourteen pounds</div>
<div class="tile">Cast iron trivet, twenty eight pounds</div>
<div class="tile">Wooden spoon set, eleven pounds</div>
<div class="tile">Glass storage jar, thirteen pounds</div>
<div class="tile">Copper measuring cups, thirty pounds</div>
</div>
<script>
document.body.insertAdjacentHTML('afterbegin', ${JSON.stringify(
        `<div class="facets">${JS_FILTER_FACETS.map(
          (facet) => `<a href="/render/js-filters?filter=${facet}">${facet}</a>`,
        ).join(" ")}</div>`,
      )});
document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(
        `<meta name="robots" content="${JS_FILTERS_RENDERED_ROBOTS}">`,
      )});
document.querySelector('link[rel="canonical"]').setAttribute('href', ${JSON.stringify(
        JS_FILTERS_RENDERED_CANONICAL,
      )});
</script>`,
    })),
};

// ---------------------------------------------------------------------------
// /render/js-redirect + /render/target — redirect.js (CHECK-10), same origin
// ---------------------------------------------------------------------------

/**
 * The delay before either redirect fires, in milliseconds.
 *
 * Not zero, and the reason is the renderer's contract rather than realism: the
 * pass waits for `domcontentloaded` and THEN settles. A navigation started
 * before the first of those aborts the very `page.goto` the pass is awaiting,
 * which is a different (and less interesting) failure than the one these two
 * fixtures are for. A timer cannot preempt the parser's own task, so any delay
 * at all buys that ordering: five milliseconds is the smallest that is also
 * obviously enough.
 *
 * AND NEAR-IMMEDIATE RATHER THAN "COMFORTABLE", because comfort was measured
 * against the wrong thing. The number that matters is the margin against the
 * harness's settle (`RENDER_SETTLE_MS`, 500ms): at 5ms that is **100×**, where
 * 30ms against a 300ms settle was 10× — and a 7.5× margin of the same shape is
 * what lost the race under load in test/crawl/renderer.test.ts during the
 * phase-5 review. The settle only ever ends by expiring, so it is free to be
 * wide; the timer is the thing that must be certain to have fired.
 */
const REDIRECT_DELAY_MS = 5;

function redirectScript(target: string): string {
  return `<script>
setTimeout(function () { location.href = ${JSON.stringify(target)}; }, ${REDIRECT_DELAY_MS});
</script>`;
}

const jsRedirect: Fixture = {
  path: "/render/js-redirect",
  category: RENDER,
  name: "A 200 page that redirects itself with JavaScript",
  expectedIssues: ["redirect.js"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "A page that sends itself somewhere else",
      metaDescription:
        "This URL answers two hundred with a full page of copy and then moves the browser to another address as soon as its script runs.",
      bodyHtml: `${article({
        h1: "Two hundred, and then somewhere else",
        lede: "Nothing in the response headers says this page is a redirect, because it is not one.",
        withImage: false,
        sections: [
          {
            h2: "What the HTTP layer sees",
            body: "The server answers this address with a status of two hundred and a complete document. There is no location header, no three hundred and one, and nothing at all for a crawler to classify as a redirect. As far as the fetch layer is concerned this is simply a live page with content on it, and it is recorded as one.",
          },
          {
            h2: "What a person sees",
            body: "A moment after the page is parsed, a script moves the browser to another address on the same site. Nobody reads a word of the copy above. To a visitor this is a redirect in every sense that matters, and to a search engine it is a page whose content is asserted to be here and delivered somewhere else entirely.",
          },
          {
            h2: "Why it needs its own rule",
            body: "The redirect rules in this engine all read the fetch class, so none of them can see this at all. Only a render can, and only by noticing that the browser finished somewhere other than where it was sent. That is the whole of the evidence, and it is why the check is worth the cost of a browser.",
          },
        ],
      })}
${redirectScript(`${new URL(self).origin}/render/target`)}`,
    })),
};

const redirectTarget: Fixture = {
  path: "/render/target",
  category: RENDER,
  name: "The page the JavaScript redirect lands on",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The address the redirect actually delivers",
      metaDescription:
        "A perfectly ordinary page which happens to be where the JavaScript redirect fixture sends the browser once its script has run.",
      bodyHtml: article({
        h1: "Where the browser ends up",
        lede: "This page has nothing wrong with it. Its only job is to be somewhere else.",
        withImage: false,
        sections: [
          {
            h2: "Its part in the fixture",
            body: "One other page on this site moves the browser here with a script. That makes this address the destination recorded against the redirect, and the reason the render of that other page measures a document which is not the document it asked for. Nothing about this page causes any of that; it simply happens to be the address chosen.",
          },
          {
            h2: "Why it is deliberately dull",
            body: "A destination with problems of its own would muddle the evidence. If this page were thin, or missing a heading, the finding recorded against the page that redirects here would sit beside findings that belong to neither of them, and reading the fixture would mean untangling which was which before anything could be concluded from it.",
          },
          {
            h2: "What it is long enough for",
            body: "The prose here runs past the thin-content threshold on purpose, because a destination that fired a content finding of its own would put a second row in the issues table for a page whose entire purpose is to be unremarkable. Length is the cheapest way to buy that silence, so the page says the same thing three times at a comfortable pace and stops.",
          },
        ],
      }),
    })),
};

// ---------------------------------------------------------------------------
// /render/js-redirect-offsite — redirect.js (CHECK-10), another origin
// ---------------------------------------------------------------------------

const jsRedirectOffsite: Fixture = {
  path: "/render/js-redirect-offsite",
  category: RENDER,
  name: "A 200 page that sends the browser to another origin",
  // The page a rendered=true gate would have lost. Its render FAILS — the pass
  // aborts the off-site navigation and Chromium is left on its own error
  // surface with no DOM of this site's to measure — so the three diff rules
  // (which all open with `rendered = true`) correctly say nothing about it, and
  // `redirect.js`, which gates on the redirect URL instead, still speaks.
  expectedIssues: ["redirect.js"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that leaves the site as soon as it loads",
      metaDescription:
        "This address answers two hundred, then moves the browser to a different origin, which no rule reading the fetch layer could notice.",
      bodyHtml: `${article({
        h1: "The page that leaves the site",
        lede: "A script here sends the visitor to another origin before they have read anything.",
        withImage: false,
        sections: [
          {
            h2: "What is recorded",
            body: "The crawl fetches this address, gets a status of two hundred and a full document, and stores it as a live page like any other. The render pass then loads it in a browser, watches the script ask for an address on a different origin, and refuses to follow: another site is not this audit's evidence and was never budgeted for.",
          },
          {
            h2: "What refusing costs",
            body: "Refusing the navigation leaves the browser with no document of ours to measure, so the render is recorded as a failure with the address it wanted written beside it. That is the honest row. A pass which followed the link would report another company's page as the content of this one, and a pass which said nothing would lose the finding altogether.",
          },
          {
            h2: "Why this is the serious shape",
            body: "A page which quietly hands its visitors to another domain is worth knowing about whether it was a marketing decision nobody wrote down or a compromise nobody noticed. It is also the shape which is hardest to see, because every layer above the browser reports a healthy page with content on it and no redirect anywhere in sight.",
          },
        ],
      })}
${redirectScript(offsiteRedirectTarget())}`,
    })),
};

// ---------------------------------------------------------------------------
// /render/healthy — the control for the four render rules
// ---------------------------------------------------------------------------

const renderHealthy: Fixture = {
  path: "/render/healthy",
  category: RENDER,
  name: "Server-rendered page (must fire nothing after a render)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that says the same thing twice over",
      metaDescription:
        "Everything a reader sees on this page is already in the HTML, so rendering it in a browser adds nothing at all and every render rule stays quiet.",
      bodyHtml: `${article({
        h1: "The same page before and after the script runs",
        lede: "There is no script. That is the entire claim this page makes.",
        sections: [
          {
            h2: "Why a silent page belongs here",
            body: "Four rules in this engine compare what a server sent against what a browser built. Each of them can be proved to speak by a page engineered to provoke it, and none of them is proved to hold its tongue by such a page. This one is the other half of the argument: it is rendered by the same browser as its four noisy neighbours and the issues table has nothing to say about it.",
          },
          {
            h2: "How it stays quiet",
            body: "The copy is in the markup, so the rendered word count matches the count taken from the bytes. There is no menu built after the fact, so both navigation counts are zero. Nothing here looks like a filter, and no script moves the browser anywhere, so the address the render finishes on is the address it was given.",
          },
          {
            h2: "The link to itself",
            body: "One anchor on this page points back at this page. That is enough to keep it out of the render selection's suspect tier, which treats a page linking nowhere as a page whose markup may be incomplete, and it changes no inbound link count anywhere in the engine, because every link-graph query here refuses to count a page's link to itself.",
          },
        ],
      })}
<p>The one anchor: <a href="/render/healthy">this page, again</a>.</p>`,
    })),
};

/** The Phase 5 render fixtures, in the order the hub and the sitemap list them. */
export const renderFixtures: Fixture[] = [
  csrContent,
  jsNav,
  jsFilters,
  jsRedirect,
  redirectTarget,
  jsRedirectOffsite,
  renderHealthy,
];

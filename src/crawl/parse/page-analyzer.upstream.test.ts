/**
 * Adapted from open-seo (MIT), src/server/lib/audit/page-analyzer.test.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 * Changes: imports rewritten to this repo's paths; the cheerio oracle is
 * extended to compute the fields Ariadne added (canonicalCount, headingCounts,
 * hasAmp, image counters, link position, title/metaDescription null-vs-empty)
 * and to drop the fields Ariadne removed (per-image records and the
 * url/statusCode/responseTimeMs/redirectUrl passthroughs); `rel` matching in
 * the oracle is case-insensitive, which is what css-select already did and
 * what the port now matches. The cap test tracks the build plan's caps (links
 * 2000, headingOrder 500) and asserts that the scalar counters do NOT
 * saturate. New cases at the end cover the added fields against the oracle.
 *
 * Task 6 moved the oracle twice more, both times because the DOM
 * implementation it encodes was wrong and the port deliberately diverged:
 *  - Visible text is collected by walking the DOM and treating every
 *    non-inline element boundary as whitespace, instead of `.text()`, which
 *    concatenates text nodes and merges words across `</h1><p>` in minified
 *    markup. See the header of page-analyzer.ts.
 *  - `link[rel]` is matched as a token list (`~=` semantics) rather than as a
 *    whole value, so `rel="next prefetch"` is a next link.
 * The oracle shares `INLINE_TEXT_TAGS` with the port: the parity claim is
 * about walking the tree the same way, not about re-deriving the tag table.
 *
 * Phase 2 (P2-T2) added `hasViewport` and `imagesMissingDimensions`, both of
 * which ARE DOM reads and so are modelled here — the viewport meta through the
 * hand-folded `byAttr`, the missing dimensions in the same `img` walk as the
 * alt counter. Its third field, `hasLoremIpsum`, is stripped with the Task 6
 * additions: it is a derivation of `bodyText`, which the oracle already models,
 * not a separate DOM read. Phase 3's `hasSoft404Phrases` is stripped for the
 * same reason and on the same line.
 *
 * The fields Task 6 added (rel next/prev, domSize, textRatio, hreflang pairs,
 * structuredData, contentHash, simhash) are NOT part of the parity surface —
 * they have no upstream DOM implementation to be held to, and `domSize` has no
 * DOM equivalent at all, since parse5 synthesises html/head/body elements the
 * tokenizer never sees as open-tag events. They are covered directly in
 * test/crawl/analyzer-extensions.test.ts; `expectParity` strips them.
 *
 * Phase 5 (P5-T2) added `navLinkCount`, `footerLinkCount` and
 * `frameworkMarkers`, and all three are modelled here rather than stripped:
 * they are DOM reads whose specification IS the selector (`nav a[href]`,
 * `footer a[href]`, an attribute or an id presence), and the render pass runs
 * those selectors in a real browser to produce the numbers CHECK-34 compares
 * these against. Parity holds on every malformed case tried here save one, and
 * that one is PINNED rather than fixed: an `<a href>` left open across a
 * container boundary is reconstructed inside the container by the tree
 * builder's adoption agency algorithm, so the DOM holds an anchor the token
 * stream never contained. See "the one divergence" test at the end.
 *
 * Phase 7 (P7-T1) moved the oracle twice, and the first of the two is the
 * interesting one:
 *  - `<template>` was ALREADY excluded here and included by the port. cheerio's
 *    parse5 tree puts template content under a fragment node whose `name` is
 *    undefined, and `collectVisibleText` returns on exactly that, so the DOM
 *    side has always agreed with the browser: template text is in no document.
 *    No fixture in this repo carried a `<template>`, so the two sides never met
 *    on one and the divergence went unmeasured until the lavishalice.com
 *    diagnosis found 482 words of it on one product page. The port now excludes
 *    it too, and this file names `template` in NON_CONTENT_TAGS so the
 *    exclusion is a stated rule on both sides rather than an accident of how
 *    parse5 represents a fragment. **The exclusion is of the TEXT and of
 *    nothing else**: the fragment is invisible to a tree WALK and perfectly
 *    visible to a SELECTOR, so `$('h1')`, `$('a[href]')`, `$('title')`,
 *    `$('img')` and `$('link[rel]')` all reach into a template — and the port
 *    keeps agreeing with them, which is what the four cases at the bottom of
 *    this file pin. Whether template elements SHOULD count as page elements
 *    is a live question and neither side answers it here; both answer it the
 *    same way, which is all a parity oracle is for.
 *  - `renderableWordCount` IS on the parity surface, because it is a DOM read
 *    rather than a `bodyText` derivation: it asks four questions about
 *    ATTRIBUTES (`hidden`, an inline `display:none`, `<dialog open>`,
 *    `<details open>`) and the oracle asks the same four of the same elements.
 *    THE LIMITATION IS SHARED AND DELIBERATE, and the port's header states it
 *    in the same words: this is markup-only. Neither side loads a stylesheet,
 *    so neither sees a class that hides its element, and the number is a floor
 *    on the correction rather than an emulation of `innerText`. A parity test
 *    over CSS-hidden markup would agree on the wrong answer, which is why the
 *    limitation is written down instead of tested around.
 *
 * Cheerio is a devDependency and appears here only: it is the parity oracle,
 * never a crawl-path parser.
 */
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  analyzeHtml,
  FRAMEWORK_MARKERS,
  INLINE_TEXT_TAGS,
  type RawPageAnalysis,
} from "./page-analyzer.js";
import { normalizeUrl, isSameOrigin } from "./url-utils.js";

/** The Task 6 additions, which the oracle does not model. */
const EXTENSION_FIELDS = [
  "relNext",
  "relPrev",
  "domSize",
  "textRatio",
  "hreflang",
  "structuredData",
  "structuredDataParseErrors",
  "contentHash",
  "simhash",
  // Derivations of bodyText, like the two hashes above them.
  "hasLoremIpsum",
  "hasSoft404Phrases",
  // A derivation of `h1s[0]`, which IS compared: if the h1 list matches, the
  // first entry's collapsed and capped form matches too. Modelling it here
  // would be the oracle re-deriving the port's own arithmetic rather than
  // holding it to a DOM.
  "h1Text",
  // P11-T1's resource references. Upstream had no such extraction and there is
  // no DOM implementation to be held to: the field's specification is the
  // CLOSED LIST in the port's header (which attributes count, which are
  // deliberately left out, and that `srcset` is read to its first candidate),
  // and an oracle re-deriving that list from the same prose would only be a
  // second copy of the decision rather than a reference for it. The Task 6
  // additions are stripped on exactly this reasoning; the cases live in
  // test/crawl/resource-refs.test.ts, where the absences are asserted too.
  "resourceRefs",
  // P12-T1's truncation flag, stripped for the same reason and one more: it is
  // a statement about the port's OWN cap, which the oracle does not have and
  // must not grow (a cheerio reference that reimplemented MAX_RESOURCE_REFS
  // would be pinning the port against a copy of itself).
  "resourceRefsCapped",
] as const;

type UpstreamShape = Omit<RawPageAnalysis, (typeof EXTENSION_FIELDS)[number]>;

/**
 * Subtrees this file's two TEXT WALKS stop at. `template` is named rather than
 * left to parse5's fragment representation; see the header.
 *
 * Deliberately NOT the same set as the port's `NON_CONTENT_TAGS`, which is back
 * to four names because it is read at element level as well. This one is only
 * ever consulted by `collectVisibleText` and `collectRenderableText`, so the
 * fifth name belongs here and the port spends a separate counter to say the
 * same thing without touching its element extractions.
 */
const NON_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg", "template"]);

/**
 * The bits of a domhandler node this walk needs. Declared structurally so the
 * oracle does not import from cheerio's own dependency.
 */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

/**
 * Visible text, DOM-side: every non-inline element boundary is whitespace,
 * inline elements are transparent, non-content subtrees contribute nothing.
 */
function collectVisibleText(node: DomNode, out: string[]): void {
  if (node.type === "text") {
    out.push(node.data ?? "");
    return;
  }
  const name = node.name?.toLowerCase();
  if (name === undefined) return;
  if (NON_CONTENT_TAGS.has(name)) return;
  const boundary = !INLINE_TEXT_TAGS.has(name);
  if (boundary) out.push(" ");
  for (const child of node.children ?? []) collectVisibleText(child, out);
  if (boundary) out.push(" ");
}

/**
 * The port's `markupHidden`, asked of a DOM element instead of a token's
 * attributes. Same four questions, same order, same deliberate blindness to
 * anything a stylesheet says.
 */
function markupHidden(name: string, attribs: Record<string, string>): boolean {
  if ("hidden" in attribs) return true;
  const style = attribs["style"];
  if (style !== undefined && /display\s*:\s*none/i.test(style)) return true;
  return name === "dialog" && !("open" in attribs);
}

/**
 * The renderable text, DOM-side: `collectVisibleText` with the hidden-surface
 * rule applied to text nodes only. Boundaries are pushed for every non-inline
 * element whether or not it is hidden, exactly as the port emits them into both
 * of its streams — the two counts must differ in text and never in structure,
 * or their difference would not be a number of words.
 */
function collectRenderableText(
  node: DomNode,
  out: string[],
  hidden: boolean,
  closedDetails: boolean,
  summary: boolean,
): void {
  if (node.type === "text") {
    // A closed `<details>` still renders its summary; everything else in it is
    // hidden. The port answers this with a stack and a counter and reaches the
    // same verdict, including on a `<summary>` nested deeper than a browser
    // would render (both count it).
    if (!hidden && !(closedDetails && !summary)) out.push(node.data ?? "");
    return;
  }
  const name = node.name?.toLowerCase();
  if (name === undefined) return;
  if (NON_CONTENT_TAGS.has(name)) return;
  const attribs = node.attribs ?? {};
  const boundary = !INLINE_TEXT_TAGS.has(name);
  if (boundary) out.push(" ");
  const nextHidden = hidden || markupHidden(name, attribs);
  const nextClosedDetails =
    closedDetails || (name === "details" && !("open" in attribs));
  const nextSummary = summary || name === "summary";
  for (const child of node.children ?? []) {
    collectRenderableText(child, out, nextHidden, nextClosedDetails, nextSummary);
  }
  if (boundary) out.push(" ");
}

/** The DOM reference implementation — the logic the tokenizer replaced. */
function analyzeHtmlWithCheerio(html: string, pageUrl: string): UpstreamShape {
  const $ = cheerio.load(html);

  // css-select case-folds `rel` values but NOT `name` / `property` / `type`
  // (verified: meta[name="description"] misses name="Description"). The port
  // case-folds all of them, so the oracle does the attribute match by hand
  // rather than by selector wherever that difference bites.
  const fold = (value: string | undefined) => value?.trim().toLowerCase();
  const byAttr = (tag: string, attr: string, wanted: string) =>
    $(`${tag}[${attr}]`).filter((_, el) => fold($(el).attr(attr)) === wanted);
  // `rel` is a token list — `[rel~="canonical"]`, not `[rel="canonical"]`.
  const relTokens = (value: string | undefined) =>
    (fold(value) ?? "").split(/\s+/);
  const byRel = (tag: string, token: string) =>
    $(`${tag}[rel]`).filter((_, el) =>
      relTokens($(el).attr("rel")).includes(token),
    );

  const titleEl = $("title").first();
  const title = titleEl.length ? titleEl.text().trim() : null;

  const descEl = byAttr("meta", "name", "description").first();
  const metaDescription = descEl.length
    ? (descEl.attr("content")?.trim() ?? "")
    : null;

  const canonicalEls = byRel("link", "canonical");
  const canonicalHtml = canonicalEls.length
    ? (canonicalEls.first().attr("href") ?? null)
    : null;

  const robotsMeta =
    byAttr("meta", "name", "robots").first().attr("content") ?? null;
  const ogTitle =
    byAttr("meta", "property", "og:title").first().attr("content") ?? null;
  const ogDescription =
    byAttr("meta", "property", "og:description").first().attr("content") ??
    null;
  const ogImage =
    byAttr("meta", "property", "og:image").first().attr("content") ?? null;

  const h1s: string[] = [];
  $("h1").each((_, el) => {
    h1s.push($(el).text().trim());
  });

  const headingOrder: number[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag =
      "tagName" in el && typeof el.tagName === "string"
        ? el.tagName.toLowerCase()
        : null;
    if (tag) {
      const level = parseInt(tag.charAt(1), 10);
      if (!isNaN(level)) headingOrder.push(level);
    }
  });
  const headingCounts: [number, number, number, number, number, number] = [
    $("h1").length,
    $("h2").length,
    $("h3").length,
    $("h4").length,
    $("h5").length,
    $("h6").length,
  ];

  const textParts: string[] = [];
  const bodyEl = $("body")[0] as unknown as DomNode | undefined;
  if (bodyEl) collectVisibleText(bodyEl, textParts);
  const bodyText = textParts.join("").replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  const renderableParts: string[] = [];
  if (bodyEl) collectRenderableText(bodyEl, renderableParts, false, false, false);
  const renderableText = renderableParts.join("").replace(/\s+/g, " ").trim();
  const renderableWordCount = renderableText ? renderableText.split(/\s+/).length : 0;

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let imagesMissingDimensions = 0;
  $("img").each((_, el) => {
    imagesTotal += 1;
    if ($(el).attr("alt") === undefined) imagesMissingAlt += 1;
    if ($(el).attr("width") === undefined || $(el).attr("height") === undefined) {
      imagesMissingDimensions += 1;
    }
  });

  const linksByTarget = new Map<string, RawPageAnalysis["links"][number]>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (/^(javascript:|mailto:|tel:|#)/.test(href)) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved) return;
    if (linksByTarget.has(resolved)) return;
    if (linksByTarget.size >= 2_000) return;
    const anchor = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200);
    const rel = fold($(el).attr("rel")) ?? null;
    linksByTarget.set(resolved, {
      href: resolved,
      anchor,
      rel,
      nofollow: (rel ?? "").split(/\s+/).includes("nofollow"),
      isInternal: isSameOrigin(resolved, pageUrl),
      position: linksByTarget.size,
    });
  });

  const hasStructuredData =
    byAttr("script", "type", "application/ld+json").length > 0;

  const hreflangTags: string[] = [];
  $("link[rel][hreflang]").each((_, el) => {
    if (!relTokens($(el).attr("rel")).includes("alternate")) return;
    const hreflang = $(el).attr("hreflang");
    if (hreflang) hreflangTags.push(hreflang);
  });

  const hasViewport = byAttr("meta", "name", "viewport").length > 0;

  // The Phase 5 captures, and the reason they belong on the parity surface:
  // both are literally `document.querySelectorAll('nav a[href]').length` and
  // its footer twin — the numbers the render pass reads in a real browser and
  // compares these against — so the selector IS the specification, and the
  // depth counters in the port have to agree with it on nesting and on
  // malformed markup or CHECK-34 compares two different questions.
  const navLinkCount = $("nav a[href]").length;
  const footerLinkCount = $("footer a[href]").length;
  const frameworkMarkers = FRAMEWORK_MARKERS.filter((marker) =>
    marker === "__NEXT_DATA__"
      ? // An id: matched verbatim, and by attribute rather than by `#id`
        // selector so no CSS escaping question enters the oracle.
        $("script[id]").filter((_, el) => $(el).attr("id") === "__NEXT_DATA__")
          .length > 0
      : $(`[${marker}]`).length > 0,
  );

  const hasAmp =
    byRel("link", "amphtml").length > 0 ||
    $("html").attr("amp") !== undefined ||
    $("html").attr("⚡") !== undefined;

  return {
    title,
    metaDescription,
    canonicalHtml,
    canonicalCount: canonicalEls.length,
    robotsMeta,
    ogTitle,
    ogDescription,
    ogImage,
    headingCounts,
    headingOrder: headingOrder.slice(0, 500),
    wordCount,
    renderableWordCount,
    imagesTotal,
    imagesMissingAlt,
    imagesMissingDimensions,
    hasAmp,
    hasViewport,
    navLinkCount,
    footerLinkCount,
    frameworkMarkers,
    links: Array.from(linksByTarget.values()),
    bodyText,
    h1s,
    hasStructuredData,
    hreflangTags,
  };
}

const PAGE_URL = "https://example.com/blog/post";

function expectParity(html: string) {
  const {
    relNext: _relNext,
    relPrev: _relPrev,
    domSize: _domSize,
    textRatio: _textRatio,
    hreflang: _hreflang,
    structuredData: _structuredData,
    structuredDataParseErrors: _structuredDataParseErrors,
    contentHash: _contentHash,
    simhash: _simhash,
    hasLoremIpsum: _hasLoremIpsum,
    hasSoft404Phrases: _hasSoft404Phrases,
    h1Text: _h1Text,
    resourceRefs: _resourceRefs,
    resourceRefsCapped: _resourceRefsCapped,
    ...streamed
  } = analyzeHtml(html, PAGE_URL);
  const reference = analyzeHtmlWithCheerio(html, PAGE_URL);
  expect(streamed).toEqual(reference);
}

describe("analyzeHtml parity with the DOM reference", () => {
  it("matches on a full, well-formed document", () => {
    expectParity(`<!DOCTYPE html>
      <html><head>
        <title> The  Title </title>
        <meta name="description" content="  A description.  ">
        <meta name="robots" content="index, follow">
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Desc">
        <meta property="og:image" content="/og.png">
        <link rel="canonical" href="https://example.com/blog/post">
        <link rel="alternate" hreflang="en" href="/en">
        <link rel="alternate" hreflang="de" href="/de">
        <script type="application/ld+json">{"@type":"Article"}</script>
      </head><body>
        <h1>Main <em>Heading</em></h1>
        <h2>Sub</h2><h3>Deep</h3><h2>Sub 2</h2>
        <p>Some visible body text with <strong>bold words</strong> here.</p>
        <script>ignored();</script>
        <style>.x{}</style>
        <svg><title>icon</title><text>svg text</text></svg>
        <noscript><img src="/ns.png"><p>noscript text</p></noscript>
        <img src="/a.png" alt="A picture">
        <img src="/b.png" alt="">
        <img src="/c.png">
        <img alt="no src">
        <a href="/relative">Relative <span>link</span></a>
        <a href="https://example.com/relative">Duplicate target</a>
        <a href="https://other.example/x" rel="NoFollow sponsored">External</a>
        <a href="mailto:x@example.com">Mail</a>
        <a href="#frag">Fragment</a>
        <a href="javascript:void(0)">JS</a>
        <a href="/empty-anchor"><img src="/img-link.png" alt=""></a>
      </body></html>`);
  });

  it("matches on documents with no head, body, or title", () => {
    expectParity(
      `<h1>Bare fragment</h1><p>Just text and a <a href="/x">link</a>.</p>`,
    );
  });

  it("matches on an empty document", () => {
    expectParity("");
  });

  it("matches on a document with only a head", () => {
    expectParity(
      `<html><head><title>Head only</title><meta name="description" content="d"></head></html>`,
    );
  });

  it("matches with duplicate metas and titles (first wins)", () => {
    expectParity(`<html><head>
      <title>First</title><title>Second</title>
      <meta name="description" content="first desc">
      <meta name="description" content="second desc">
      <link rel="canonical" href="/first"><link rel="canonical" href="/second">
      </head><body><p>text</p></body></html>`);
  });

  it("matches on unclosed and misnested tags", () => {
    expectParity(`<html><body>
      <h1>Unclosed heading
      <p>Paragraph <b>bold <i>both</b> italic?</i>
      <a href="/one">first <a href="/two">second</a>
      <div>trailing text`);
  });

  it("matches on entity-heavy content", () => {
    expectParity(`<html><head><title>A &amp; B &lt;C&gt;</title></head>
      <body><h1>Caf&eacute; &quot;menu&quot;</h1>
      <p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>
      <a href="/x?a=1&amp;b=2">Query &amp; anchor</a></body></html>`);
  });

  it("matches heading order across nesting", () => {
    expectParity(`<body><h3>three</h3><div><h1>one</h1><section><h2>two</h2>
      <h6>six</h6></section></div><h4>four</h4></body>`);
  });

  it("matches word counts with whitespace-heavy markup", () => {
    expectParity(`<body>
      <p>
        one
        two    three
      </p>
      <ul><li>four</li><li>five</li></ul>
    </body>`);
  });

  // Ariadne additions, held to the same oracle.
  it("matches on a present-but-empty title and description", () => {
    expectParity(
      `<html><head><title></title><meta name="description" content=""></head><body><p>x</p></body></html>`,
    );
  });

  it("matches on mixed-case rel values", () => {
    expectParity(`<html><head>
      <link rel="Canonical" href="/c">
      <link rel="AMPHTML" href="/amp/">
      <link rel="ALTERNATE" hreflang="fr" href="/fr">
      </head><body><a href="/x" rel="NOFOLLOW">x</a></body></html>`);
  });

  it("matches on mixed-case meta name/property and script type", () => {
    expectParity(`<html><head>
      <meta name="Description" content="Present, not missing.">
      <meta name="Robots" content="noindex">
      <meta property="OG:title" content="OG Title">
      <meta property="og:Description" content="OG Desc">
      <meta property="OG:IMAGE" content="/og.png">
      <script type="Application/LD+JSON">{"@type":"Article"}</script>
      </head><body><p>x</p></body></html>`);
  });

  it("matches on an AMP root element", () => {
    expectParity(`<html amp><head><title>AMP</title></head><body><p>a</p></body></html>`);
  });

  it("matches on multi-token rel values", () => {
    expectParity(`<html><head>
      <link rel="canonical shortlink" href="/c">
      <link rel="prefetch AMPHTML" href="/amp/">
      <link rel="alternate stylesheet" hreflang="fr" href="/fr">
      </head><body><a href="/x" rel="nofollow noopener">x</a></body></html>`);
  });

  it("matches word counts across minified block boundaries", () => {
    expectParity(
      `<body><h1>Bare fragment</h1><p>three more words</p><ul><li>a</li><li>b</li></ul><div>c</div></body>`,
    );
  });

  it("matches when inline elements and stripped subtrees sit inside a word", () => {
    expectParity(
      `<body><p>un<em>believ</em>able <b>bold</b><span>ed</span>, al<script>ignored()</script>pha<br>tail</p></body>`,
    );
  });

  it("matches on the viewport meta and images missing dimensions", () => {
    expectParity(`<html><head>
      <meta name=" Viewport " content="width=device-width, initial-scale=1">
      </head><body>
      <img src="/a.png" width="10" height="10" alt="both">
      <img src="/b.png" width="10" alt="width only">
      <img src="/c.png" height="10" alt="height only">
      <img src="/d.png" alt="neither">
      <img src="/e.png" width="" height="" alt="present but empty">
      </body></html>`);
  });

  // The Phase 5 (P5-T2) captures. Held to the oracle rather than covered only
  // by hand-counted cases because the DOM selector is what the render pass
  // will run in a real browser: if the tokenizer and `querySelectorAll`
  // disagree about a malformed page, CHECK-34 compares two numbers that were
  // never answering the same question. Where they DO disagree — one case, an
  // open `<a>` crossing a container boundary — the disagreement is pinned by
  // its own test below rather than asserted away.
  it("matches nav and footer link counts, container by container", () => {
    expectParity(`<html><body>
      <nav><a href="/a">A</a><a href="/b">B</a><a>no href</a><a href="">empty</a></nav>
      <footer><a href="/c">C</a><a href="mailto:x@y.test">mail</a></footer>
      <a href="/outside">outside</a>
      </body></html>`);
  });

  it("matches a nav nested inside a footer, which counts for both", () => {
    expectParity(
      `<html><body><footer><nav><a href="/x">x</a></nav><a href="/y">y</a></footer></body></html>`,
    );
  });

  it("matches when a footer close implicitly closes an open nav", () => {
    expectParity(
      `<html><body><footer><nav><a href="/x">x</a></footer><a href="/after">after</a></body></html>`,
    );
  });

  it("matches nested navs and a stray close tag", () => {
    expectParity(
      `<html><body></nav><nav><a href="/1">1</a><nav><a href="/2">2</a></nav><a href="/3">3</a></nav></body></html>`,
    );
  });

  it("matches the framework markers, each one and all of them", () => {
    expectParity(
      `<html ng-app="shopApp"><body><div data-reactroot=""><p>x</p></div>
       <script id="__NEXT_DATA__" type="application/json">{"page":"/"}</script></body></html>`,
    );
    expectParity(`<html><body><div id="root"></div><script id="app">{}</script></body></html>`);
    expectParity(`<html><body><script id="__next_data__">{}</script></body></html>`);
  });

  it("matches when every canonical is counted", () => {
    expectParity(`<html><head>
      <link rel="canonical" href="/a"><link rel="canonical" href="/b">
      <link rel="canonical" href="/c"></head><body><p>x</p></body></html>`);
  });
});

/**
 * The one place the tokenizer and the DOM genuinely disagree, asserted in both
 * directions so it cannot move without a test failing.
 *
 * `<a href="/x"><nav><a href="/y">y</a></nav></a>`: the outer anchor is still
 * open when `<nav>` starts, which puts it in the tree builder's list of ACTIVE
 * FORMATTING ELEMENTS. The adoption agency algorithm then reconstructs it
 * inside the `<nav>`, so a browser's DOM holds TWO anchors in there — one of
 * which corresponds to no start tag in the byte stream. A streaming tokenizer
 * has no such list and no tree correction (hard rule 4: no DOM on the hot
 * path), so it counts the one anchor it was actually handed.
 *
 * The direction is fixed and the size is bounded: the raw count is UNDER the
 * rendered one by exactly 1 per unclosed `<a>` crossing a container boundary,
 * and never over. That is what makes it a tolerable known error rather than an
 * unknown one — CHECK-34 must not treat a difference of 1 as evidence of
 * JavaScript-only navigation (see the analyzer's header and the
 * `nav_link_count` comment in src/db/schema.ts).
 */
describe("a permanent divergence from the DOM: an open <a> crossing a container (the other class: script/style/svg text in captures — see the T1 ledger)", () => {
  const count = (html: string) => {
    const $ = cheerio.load(html);
    const streamed = analyzeHtml(html, PAGE_URL);
    return {
      streamedNav: streamed.navLinkCount,
      domNav: $("nav a[href]").length,
      streamedFooter: streamed.footerLinkCount,
      domFooter: $("footer a[href]").length,
    };
  };

  it("undercounts a nav by one when an open anchor is reconstructed inside it", () => {
    expect(count(`<html><body><a href="/x"><nav><a href="/y">y</a></nav></a></body></html>`))
      .toMatchObject({ streamedNav: 1, domNav: 2 });
  });

  it("does the same when the outer anchor is never closed at all", () => {
    expect(count(`<html><body><a href="/x"><nav><a href="/y">y</a></nav></body></html>`))
      .toMatchObject({ streamedNav: 1, domNav: 2 });
  });

  it("does the same for a footer", () => {
    expect(count(`<html><body><a href="/x"><footer><a href="/y">y</a></footer></a></body></html>`))
      .toMatchObject({ streamedFooter: 1, domFooter: 2 });
  });

  it("agrees again once the outer anchor is closed before the container", () => {
    // The same markup, well formed: no active formatting element to
    // reconstruct, so nothing is cloned and the two counts meet.
    expect(count(`<html><body><a href="/x">x</a><nav><a href="/y">y</a></nav></body></html>`))
      .toMatchObject({ streamedNav: 1, domNav: 1 });
  });
});

/**
 * The Phase 7 surfaces, held to the DOM like every other DOM read.
 *
 * `expectParity` compares the whole shape, so each case below asserts BOTH the
 * template exclusion and `renderableWordCount` at once — which is the point:
 * the port and the oracle have to agree about which text is in the document and
 * which text the markup hides, on the same markup, or the two numbers a render
 * diff subtracts are answers to different questions.
 */
describe("hidden surfaces and template content, against the DOM", () => {
  it("agrees that template text is in no document", () => {
    expectParity(
      `<html><body><p>one two three</p><template><p>four five six</p></template></body></html>`,
    );
  });

  it("agrees on a template holding block markup", () => {
    expectParity(
      `<html><body><template><article><h2>a b</h2><p>c d</p></article></template><p>e</p></body></html>`,
    );
  });

  it("agrees on the hidden attribute", () => {
    expectParity(`<html><body><p>a b</p><div hidden><p>c d e</p></div></body></html>`);
  });

  it("agrees on an inline display:none", () => {
    expectParity(
      `<html><body><p>a b</p><div style="color:red;display: none"><p>c d</p></div></body></html>`,
    );
  });

  it("agrees on a closed dialog and an open one", () => {
    expectParity(`<html><body><dialog><p>a b</p></dialog><p>c</p></body></html>`);
    expectParity(`<html><body><dialog open><p>a b</p></dialog><p>c</p></body></html>`);
  });

  it("agrees on a closed details, summary included", () => {
    expectParity(
      `<html><body><details><summary>Size guide</summary><p>a b c</p></details></body></html>`,
    );
    expectParity(
      `<html><body><details open><summary>Size guide</summary><p>a b c</p></details></body></html>`,
    );
  });

  it("agrees on nested and malformed hidden markup", () => {
    expectParity(`<html><body><div hidden><div>a b</div></div><p>c</p></body></html>`);
    expectParity(`<html><body><div hidden><span hidden>a</span> b</div><p>c</p></body></html>`);
    expectParity(`<html><body><p>un<span hidden>x</span>believable</p></body></html>`);
    expectParity(
      `<html><body><section hidden><details><summary>s</summary><p>a</p></details></section><p>b</p></body></html>`,
    );
  });

  // THE FIVE CASES THE TEXT EXCLUSION MUST NOT TOUCH. A `<template>` hides its
  // content from a tree walk and from nothing else, so every element the DOM
  // oracle's selectors reach inside one has to read the same on both sides.
  // Each of these was a live divergence for the length of one review round,
  // when `template` was suppressed as a whole rather than as text.
  it("agrees about an h1 inside a template, which must not shadow the real one", () => {
    // The sharp one. `h1s` is compared here, and `h1Text` is `h1s[0]`, so a
    // port that captured an empty string for the phantom heading would put ""
    // in the column Task 2's rule reads — silently, on every templated page.
    expectParity(
      `<html><body><template><h1>Phantom heading</h1></template><h1>Real heading</h1></body></html>`,
    );
    expectParity(`<html><body><template><h1>Phantom heading</h1></template></body></html>`);
  });

  it("agrees about an anchor inside a template, text and all", () => {
    // The anchor becomes a `links` row on both sides; only its ANCHOR TEXT was
    // at risk, and anchor text is what an internal-link report quotes.
    expectParity(
      `<html><body><template><a href="/x">anchor text</a></template><a href="/y">real</a></body></html>`,
    );
  });

  it("agrees about a title inside a template", () => {
    // cheerio's `$('title').first()` reaches into the fragment, so a document
    // whose only title sits in a template HAS that title as far as the oracle
    // is concerned — and a port that returned null would report
    // `title.missing` on a page the DOM says has one.
    expectParity(
      `<html><head><template><title>Template title</title></template></head><body><p>x</p></body></html>`,
    );
    expectParity(
      `<html><head><title>Real title</title><template><title>Template title</title></template></head><body><p>x</p></body></html>`,
    );
  });

  it("agrees about images, canonicals and metas inside a template", () => {
    expectParity(
      `<html><head><template><link rel="canonical" href="/c">` +
        `<meta name="description" content="template description"></template></head>` +
        `<body><template><img src="/a.png"><img src="/b.png" alt="b" width="1" height="1">` +
        `</template><p>real copy</p></body></html>`,
    );
  });

  it("agrees on a page carrying all four surfaces at once", () => {
    expectParity(
      `<html><body><h1>Visible heading here</h1><p>Visible copy.</p>` +
        `<template><p>template copy</p></template>` +
        `<nav hidden><a href="/a">drawer link</a></nav>` +
        `<div style="display:none"><p>picker copy</p></div>` +
        `<details><summary>Size guide</summary><p>accordion copy</p></details>` +
        `</body></html>`,
    );
  });
});

describe("analyzeHtml extraction caps", () => {
  it("caps links at 2000 and heading order at 500 while counters stay exact", () => {
    const links = Array.from(
      { length: 2_100 },
      (_, i) => `<a href="/p/${i}">link ${i}</a>`,
    ).join("");
    const images = Array.from(
      { length: 1_100 },
      (_, i) => `<img src="/i/${i}.png">`,
    ).join("");
    const headings = Array.from({ length: 600 }, () => `<h2>h</h2>`).join("");
    const analysis = analyzeHtml(
      `<body>${links}${images}${headings}</body>`,
      "https://example.com/",
    );
    expect(analysis.links).toHaveLength(2_000);
    expect(analysis.headingOrder).toHaveLength(500);
    // Counters are scalars: they cost nothing to keep exact, so they are.
    expect(analysis.imagesTotal).toBe(1_100);
    expect(analysis.imagesMissingAlt).toBe(1_100);
    expect(analysis.headingCounts[1]).toBe(600);
  });
});

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
 * Cheerio is a devDependency and appears here only: it is the parity oracle,
 * never a crawl-path parser.
 */
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  analyzeHtml,
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
] as const;

type UpstreamShape = Omit<RawPageAnalysis, (typeof EXTENSION_FIELDS)[number]>;

/** Subtrees the DOM implementation removed before reading text. */
const NON_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg"]);

/**
 * The bits of a domhandler node this walk needs. Declared structurally so the
 * oracle does not import from cheerio's own dependency.
 */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
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
    imagesTotal,
    imagesMissingAlt,
    imagesMissingDimensions,
    hasAmp,
    hasViewport,
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

  it("matches when every canonical is counted", () => {
    expectParity(`<html><head>
      <link rel="canonical" href="/a"><link rel="canonical" href="/b">
      <link rel="canonical" href="/c"></head><body><p>x</p></body></html>`);
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

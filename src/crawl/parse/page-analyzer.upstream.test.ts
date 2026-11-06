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
 * Phase 19 (P19-T1) put the main-content pair ON the parity surface and, less
 * obviously, `placeholderSnippet` with it:
 *  - `mainWordCount` and `mainSimhash` are DOM reads in the strongest sense
 *    this file recognises — WHICH SUBTREE the text comes from is the whole
 *    question, and the oracle answers it by walking for the first `<main>` and
 *    otherwise by walking the body — declining, in BOTH walks, to descend into
 *    `CHROME_TAGS`. Two things are shared with the port rather than re-derived,
 *    on the `INLINE_TEXT_TAGS` precedent: the four chrome names (a tag table)
 *    and `simhash64` (a hash of the text, not a reading of the tree). What is
 *    NOT shared is where the text comes from, which is the claim.
 *  - `placeholderSnippet` is a `bodyText` derivation, so by this file's own
 *    rule — the one that strips `hasLoremIpsum` and `contentHash` — it could
 *    have been stripped too. It is kept because it is ARITHMETIC (a window
 *    opening at the match, pulled back to a whole word) rather than a
 *    predicate, and a second
 *    implementation of a windowing rule catches an off-by-one that a boolean
 *    never could. The oracle's copy is written from the field's contract, not
 *    from the port's code.
 *
 * Phase 26b (P26b-T2) put its head facts ON the parity surface, each computed
 * here by the selector that defines it: `htmlLang` (`html[lang]`),
 * `titleCount` (`title` not under `svg`), `metaDescriptionCount`,
 * `robotsMetas`, `metaRefresh` (through the shared `parseRefresh`, on the
 * `simhash64` precedent: arithmetic over an attribute, not a tree read),
 * `h2Text` (`$("h2").first()`, as `h1s` is read) and the whole `social` set,
 * which rides the outside-head walk because tree order is document order and
 * that walk already knows which side of the head each element is on. The
 * oracle moved once more: `robotsMeta` is now every `meta[name=robots]`
 * content joined with ", " (deviation 4), as the port now reads it.
 * `socialImageRefs` is stripped, on `resourceRefs`' reasoning. Ruling R6 moved
 * the oracle twice more, in step with the port: a robots content identical (after
 * trim) to one already joined is dropped, and one meta naming two social tags
 * (`name=twitter:title property=og:title`) is recorded as both.
 *
 * Phase 26b (P26b-T3) put the body facts on the parity surface, each by the
 * selector that defines it: `anchorCounts` over `$("a")` (every anchor element,
 * href or not), `relNextCount` / `relPrevCount` as `link[rel~=next|prev]`
 * counts, `insecureRefs` by a document-order walk over the closed list of
 * frame, media and form sites (a `<source>` only under a `<video>`/`<audio>`),
 * and the three image alt facts in the same `img` walk as the alt counter. The
 * oracle moved once more: an anchor's text is now its text nodes with each
 * `img`'s trimmed, non-empty `alt` folded in where the image sits, as the port
 * now reads it.
 *
 * Cheerio is a devDependency and appears here only: it is the parity oracle,
 * never a crawl-path parser.
 */
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  analyzeHtml,
  CHROME_TAGS,
  FRAMEWORK_MARKERS,
  INLINE_TEXT_TAGS,
  type RawPageAnalysis,
} from "./page-analyzer.js";
import { simhash64 } from "./simhash.js";
import { normalizeUrl, isSameOrigin } from "./url-utils.js";
import {
  ALT_TEXT_LONG_CHARS,
  H2_TEXT_MAX,
  HTML_LANG_MAX,
  IMAGE_SAMPLE_MAX,
  IMAGE_SAMPLE_SRC_MAX,
  INSECURE_SAMPLE_MAX,
  parseRefresh,
  ROBOTS_META_BOTS,
  ROBOTS_META_CONTENT_MAX,
  ROBOTS_METAS_MAX,
  SOCIAL_TEXT_MAX,
  SOCIAL_URL_MAX,
  type InsecureRefKind,
  type InsecureRefs,
  type SocialTag,
} from "./page-facts.js";

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
  // P23-T5's closer. NOT a DOM read: the tree records where the head's
  // children are, not what ended it, and an explicit `</head>` leaves no trace
  // in it at all. The five outside-head FLAGS beside it are DOM reads and are
  // modelled below; the closer is held to the oracle where the oracle can see
  // it (the first node of the body) in test/crawl/page-analyzer.test.ts.
  "headClosedBy",
  // Phase 26b's social image refs, stripped on `resourceRefs`' reasoning: the
  // field's specification is the port's own (resolution by `normalizeUrl`, the
  // resource skip rules, the port's cap of four), not a DOM read. The SOCIAL
  // SET they come from is on the parity surface below. Covered in
  // test/crawl/analyzer-extensions.test.ts.
  "socialImageRefs",
] as const;

/** The ten social tags `PageAnalysis.social` reads, as the oracle lists them. */
const SOCIAL_TAG_NAMES: readonly string[] = [
  "og:title", "og:description", "og:image", "og:url", "og:type", "og:site_name",
  "twitter:card", "twitter:title", "twitter:description", "twitter:image",
] satisfies SocialTag[];

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
 * The main content, DOM-side, in two halves that mirror the port's two
 * candidate streams:
 *  - `findMain` returns the first `<main>` the WALK reaches — a walk, not
 *    `$("main").first()`, because a selector reaches into a `<template>` (and
 *    every other subtree this file's text walks stop at) and the port's
 *    tokenizer deliberately does not claim a `<main>` that is in no rendered
 *    document. The two sides have to be looking for the same element before
 *    they can be compared on its text.
 *  - `collectContentText` is `collectVisibleText` that declines to descend into
 *    a chrome subtree and pushes ONE separator where it does — which is exactly
 *    what the port's `chromeDepth` bracket produces on the other side, so
 *    words on either side of a `<nav>` never merge on either.
 */
function findMain(node: DomNode): DomNode | null {
  const name = node.name?.toLowerCase();
  if (name !== undefined) {
    if (NON_CONTENT_TAGS.has(name)) return null;
    if (name === "main") return node;
  }
  for (const child of node.children ?? []) {
    const found = findMain(child);
    if (found !== null) return found;
  }
  return null;
}

function collectContentText(node: DomNode, out: string[]): void {
  if (node.type === "text") {
    out.push(node.data ?? "");
    return;
  }
  const name = node.name?.toLowerCase();
  if (name === undefined) return;
  if (NON_CONTENT_TAGS.has(name)) return;
  if (CHROME_TAGS.has(name)) {
    out.push(" ");
    return;
  }
  const boundary = !INLINE_TEXT_TAGS.has(name);
  if (boundary) out.push(" ");
  for (const child of node.children ?? []) collectContentText(child, out);
  if (boundary) out.push(" ");
}

/**
 * The quotation opening at the first "lorem ipsum", written from the contract
 * in `PageAnalysis.placeholderSnippet`: up to 160 characters of the visible
 * text STARTING AT the match — nothing before it — a whole word at the cut
 * end, and the whole remainder when it is shorter than the window.
 */
function placeholderSnippet(text: string): string | null {
  const at = text.search(/lorem ipsum/i);
  if (at < 0) return null;
  // Everything from the match onwards is the candidate; the head is never cut.
  const rest = text.slice(at);
  if (rest.length <= 160) return rest.trim();
  const words = rest.slice(0, 160).split(" ");
  // The far edge is the only cut one, so it is the only one that may hold half
  // a word.
  words.pop();
  const trimmed = words.join(" ").trim();
  return /lorem ipsum/i.test(trimmed) ? trimmed : rest.slice(0, 160).trim();
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

  // Phase 26b, deviation 4: EVERY robots meta's content, joined — Google
  // combines them. An element with no `content` contributes nothing, so a
  // page whose only robots meta has none still reads null, as before. Ruling
  // R6: a content identical after trim to an earlier one adds nothing; the
  // first spelling is the one kept.
  const robotsContents = byAttr("meta", "name", "robots")
    .toArray()
    .flatMap((el) => {
      const content = $(el).attr("content");
      return content === undefined ? [] : [content];
    })
    .filter((content, i, all) => all.findIndex((c) => c.trim() === content.trim()) === i);
  const robotsMeta = robotsContents.length === 0 ? null : robotsContents.join(", ");
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

  // ---- Phase 26b head facts, each the selector its field is defined by ----
  const langAttr = $("html").attr("lang")?.trim();
  const htmlLang =
    langAttr === undefined || langAttr === "" ? null : langAttr.slice(0, HTML_LANG_MAX);
  // A `<title>` under an `<svg>` is the svg's, never the document's.
  const titleCount = $("title").filter((_, el) => $(el).parents("svg").length === 0).length;
  const metaDescriptionCount = byAttr("meta", "name", "description").length;
  const botNames: readonly string[] = ROBOTS_META_BOTS;
  const robotsMetas = $("meta[name]")
    .toArray()
    .flatMap((el) => {
      const name = fold($(el).attr("name"));
      if (name === undefined || !botNames.includes(name)) return [];
      return [{ name, content: ($(el).attr("content") ?? "").slice(0, ROBOTS_META_CONTENT_MAX) }];
    })
    .slice(0, ROBOTS_METAS_MAX);
  const refreshEl = $("meta[http-equiv][content]")
    .filter((_, el) => fold($(el).attr("http-equiv")) === "refresh")
    .first();
  const refreshContent = refreshEl.attr("content");
  // `parseRefresh` is shared rather than re-derived, on the `simhash64`
  // precedent: it is arithmetic over the attribute, not a reading of the tree.
  const metaRefresh =
    refreshContent === undefined ? null : parseRefresh(refreshContent, pageUrl);
  const h2El = $("h2").first();
  const h2Text = h2El.length
    ? h2El.text().replace(/\s+/g, " ").trim().slice(0, H2_TEXT_MAX)
    : null;

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

  // The main-content stream: inside the first `<main>` the walk finds, else the
  // whole body — and `collectContentText` either way, so chrome is removed
  // inside a `<main>` as well. Real themes put a `<footer>` in there (spec §11).
  const mainEl = bodyEl ? findMain(bodyEl) : null;
  const mainParts: string[] = [];
  if (mainEl !== null) collectContentText(mainEl, mainParts);
  else if (bodyEl) collectContentText(bodyEl, mainParts);
  const mainText = mainParts.join("").replace(/\s+/g, " ").trim();
  const mainWordCount = mainText === "" ? null : mainText.split(/\s+/).length;

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let imagesMissingDimensions = 0;
  // Phase 26b's alt facts ride the same walk, written from their contracts.
  let imagesEmptyAlt = 0;
  let imagesAltTooLong = 0;
  const imagesMissingAltSample: string[] = [];
  $("img").each((_, el) => {
    imagesTotal += 1;
    const alt = $(el).attr("alt");
    if (alt === undefined) {
      imagesMissingAlt += 1;
      imagesMissingAltSample.push(($(el).attr("src") ?? "").slice(0, IMAGE_SAMPLE_SRC_MAX));
    } else if (alt.trim() === "") {
      imagesEmptyAlt += 1;
    } else if (alt.trim().length > ALT_TEXT_LONG_CHARS) {
      imagesAltTooLong += 1;
    }
    if ($(el).attr("width") === undefined || $(el).attr("height") === undefined) {
      imagesMissingDimensions += 1;
    }
  });

  // Every anchor ELEMENT, href or not — the port counts `<a>` start tags, and
  // the two agree wherever the tree builder adds no anchor (the pinned
  // divergence at the end of this file is the case where it does).
  const anchorCounts = { noHref: 0, javascript: 0, hashOnly: 0, emptyHref: 0, unsafeBlank: 0 };
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (href === undefined) {
      const role = fold($(el).attr("role"));
      if ($(el).attr("onclick") !== undefined || role === "link" || role === "button") {
        anchorCounts.noHref += 1;
      }
      return;
    }
    const isJavascript = /^\s*javascript:/i.test(href);
    if (href.trim() === "") anchorCounts.emptyHref += 1;
    else if (isJavascript) anchorCounts.javascript += 1;
    else if (["#", "#!"].includes(href.trim())) anchorCounts.hashOnly += 1;
    const rel = relTokens($(el).attr("rel"));
    if (
      fold($(el).attr("target")) === "_blank" &&
      !isJavascript &&
      !rel.includes("noopener") &&
      !rel.includes("noreferrer")
    ) {
      anchorCounts.unsafeBlank += 1;
    }
  });

  // The insecure references: a tree walk, so the sample is in document order,
  // with an in-media flag for `<source>`.
  const insecureRefs: InsecureRefs = { iframe: 0, media: 0, formAction: 0, forms: 0, sample: [] };
  const insecure = (kind: InsecureRefKind, value: string | undefined) => {
    if (value === undefined) return;
    const resolved = normalizeUrl(value, pageUrl);
    if (resolved === null || !resolved.startsWith("http:")) return;
    if (kind === "iframe") insecureRefs.iframe += 1;
    else if (kind === "media") insecureRefs.media += 1;
    else insecureRefs.formAction += 1;
    insecureRefs.sample.push({ kind, url: resolved });
  };
  const walkInsecure = (node: DomNode, inMedia: boolean) => {
    const name = node.type === "tag" ? node.name?.toLowerCase() : undefined;
    const attribs = node.attribs ?? {};
    if (name === "iframe") insecure("iframe", attribs["src"]);
    if (name === "video") {
      insecure("media", attribs["src"]);
      insecure("media", attribs["poster"]);
    }
    if (name === "audio" || name === "track" || name === "embed") insecure("media", attribs["src"]);
    if (name === "source" && inMedia) insecure("media", attribs["src"]);
    if (name === "object") insecure("media", attribs["data"]);
    if (name === "form") {
      insecureRefs.forms += 1;
      insecure("form", attribs["action"]);
    }
    for (const child of node.children ?? []) {
      walkInsecure(child, inMedia || name === "video" || name === "audio");
    }
  };
  walkInsecure($.root()[0] as unknown as DomNode, false);
  insecureRefs.sample = insecureRefs.sample.slice(0, INSECURE_SAMPLE_MAX);
  const imagesMissingAltSampleCapped = imagesMissingAltSample.slice(0, IMAGE_SAMPLE_MAX);

  // `.text()` with every image's trimmed, non-empty `alt` read where the image
  // sits: an image link's alt is its anchor text (Phase 26b). Every other node
  // contributes what `.text()` gives it, so the anchors with no image agree
  // with the oracle's earlier reading exactly.
  const anchorText = (node: DomNode): string => {
    if (node.type === "text") return node.data ?? "";
    const alt = node.type === "tag" && node.name === "img" ? node.attribs?.["alt"]?.trim() : undefined;
    return (alt ?? "") + (node.children ?? []).map(anchorText).join("");
  };

  const linksByTarget = new Map<string, RawPageAnalysis["links"][number]>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (/^(javascript:|mailto:|tel:|#)/.test(href)) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved) return;
    if (linksByTarget.has(resolved)) return;
    if (linksByTarget.size >= 2_000) return;
    const anchor = anchorText(el as unknown as DomNode)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
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

  // P23-T5: the outside-head flags, read off the tree. Walked DOWN from the
  // root noting the head element on the way, because template content hangs
  // off its template's children with no parent pointer back, so an upward
  // `parents('head')` would call a template's canonical in the head "outside".
  // A `<title>` under an `<svg>` is the svg's, never the document's.
  // The four single-element flags are FIRST-OCCURRENCE (fix round 1): the
  // first such element in tree order decides, inside or outside. The hreflang
  // field counts every alternate outside.
  let titleOutsideHead: boolean | undefined;
  let metaDescriptionOutsideHead: boolean | undefined;
  let robotsOutsideHead: boolean | undefined;
  let canonicalOutsideHead: boolean | undefined;
  let hreflangOutsideHeadCount = 0;
  // Phase 26b: the social set rides the same walk, because tree order is
  // document order and the walk already knows which side of the head each
  // element is on. Written from `PageAnalysis.social`'s contract: Open Graph
  // from `property=` then `name=`, X from `name=` then `property=` (the latter
  // flagged), first trimmed value per tag, every element counted, a tag with
  // two distinct trimmed values conflicting.
  const socialValues = new Map<string, string[]>();
  let socialOutsideHead = false;
  let xViaProperty = false;
  const isSocial = (value: string | undefined): value is string =>
    value !== undefined && SOCIAL_TAG_NAMES.includes(value);
  const walkOutsideHead = (node: DomNode, inHead: boolean, inSvg: boolean) => {
    const isElement =
      node.type === "tag" || node.type === "script" || node.type === "style";
    const name = isElement ? node.name?.toLowerCase() : undefined;
    if (name !== undefined) {
      const attribs = node.attribs ?? {};
      const rel = relTokens(attribs["rel"]);
      const outside = !inHead;
      if (name === "meta") {
        const metaName = fold(attribs["name"]);
        const property = fold(attribs["property"]);
        // Ruling R6: every DISTINCT social tag the element names, by either
        // attribute; a twitter tag named only by `property=` is flagged.
        const tags = new Set([property, metaName].filter(isSocial));
        for (const tag of tags) {
          if (tag !== metaName && tag.startsWith("twitter:")) xViaProperty = true;
          if (outside) socialOutsideHead = true;
          const values = socialValues.get(tag) ?? [];
          values.push(attribs["content"]?.trim() ?? "");
          socialValues.set(tag, values);
        }
      }
      if (name === "title" && !inSvg) titleOutsideHead ??= outside;
      if (name === "meta" && fold(attribs["name"]) === "description") {
        metaDescriptionOutsideHead ??= outside;
      }
      if (name === "meta" && fold(attribs["name"]) === "robots") robotsOutsideHead ??= outside;
      if (name === "link" && rel.includes("canonical")) canonicalOutsideHead ??= outside;
      if (outside && name === "link" && rel.includes("alternate") && attribs["hreflang"]) {
        hreflangOutsideHeadCount += 1;
      }
    }
    for (const child of node.children ?? []) {
      walkOutsideHead(child, inHead || name === "head", inSvg || name === "svg");
    }
  };
  walkOutsideHead($.root()[0] as unknown as DomNode, false, false);

  let social: RawPageAnalysis["social"] = null;
  if (socialValues.size > 0) {
    const og: Record<string, string> = {};
    const x: Record<string, string> = {};
    const counts: Record<string, number> = {};
    const conflicting: string[] = [];
    for (const [tag, values] of socialValues) {
      const [group, key] = tag.split(":") as [string, string];
      const isUrl = tag === "og:url" || tag === "og:image" || tag === "twitter:image";
      const first = values[0]!.slice(0, isUrl ? SOCIAL_URL_MAX : SOCIAL_TEXT_MAX);
      (group === "og" ? og : x)[key] = first;
      counts[tag] = values.length;
      if (new Set(values).size > 1) conflicting.push(tag);
    }
    social = {
      og,
      x,
      counts,
      conflicting: conflicting.sort(),
      outsideHead: socialOutsideHead,
      xViaProperty,
    } as RawPageAnalysis["social"];
  }

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
    mainWordCount,
    // Null with the count, never a hash of the empty string: "nothing to
    // fingerprint" is the pair's shared meaning.
    mainSimhash: mainWordCount === null ? null : simhash64(mainText),
    placeholderSnippet: placeholderSnippet(bodyText),
    imagesTotal,
    imagesMissingAlt,
    imagesMissingDimensions,
    hasAmp,
    hasViewport,
    navLinkCount,
    footerLinkCount,
    frameworkMarkers,
    // Absent is not outside: a page with no such element says false.
    titleOutsideHead: titleOutsideHead ?? false,
    metaDescriptionOutsideHead: metaDescriptionOutsideHead ?? false,
    robotsOutsideHead: robotsOutsideHead ?? false,
    canonicalOutsideHead: canonicalOutsideHead ?? false,
    hreflangOutsideHeadCount,
    htmlLang,
    social,
    h2Text,
    titleCount,
    metaDescriptionCount,
    robotsMetas,
    metaRefresh,
    anchorCounts,
    relNextCount: byRel("link", "next").length,
    relPrevCount: byRel("link", "prev").length,
    insecureRefs,
    imagesEmptyAlt,
    imagesAltTooLong,
    imagesMissingAltSample: imagesMissingAltSampleCapped,
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
    headClosedBy: _headClosedBy,
    socialImageRefs: _socialImageRefs,
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

/**
 * The Phase 19 main-content surfaces, against the DOM.
 *
 * `expectParity` compares the whole shape, so every case here asserts the
 * `<main>`-versus-fallback choice, the chrome exclusion, the word count, the
 * fingerprint over the chosen text and the placeholder quotation at once — on
 * markup where the tokenizer and a tree could plausibly disagree about which
 * subtree the text came from, which is the only question this pair asks.
 */
describe("the main-content stream, against the DOM", () => {
  /** Chrome the way a real theme carries it: the same block on every page. */
  const CHROME =
    `<header><p>${"brand tagline ".repeat(20)}</p></header>` +
    `<nav><ul><li><a href="/a">shop all</a></li><li><a href="/b">new in</a></li>` +
    `<li><p>${"menu column ".repeat(60)}</p></li></ul></nav>` +
    `<aside><p>${"you may also like ".repeat(30)}</p></aside>` +
    `<footer><p>${"terms delivery returns ".repeat(40)}</p></footer>`;
  /** The page's own copy: the ~150 words the chrome above buries. */
  const CONTENT = `<h1>A dress</h1><p>${"a sentence about this one product ".repeat(25)}</p>`;

  it("agrees on a page that declares its main content", () => {
    expectParity(`<html><body>${CHROME}<main>${CONTENT}</main></body></html>`);
  });

  it("agrees on a page with no <main>, where chrome is most of the words", () => {
    expectParity(`<html><body>${CHROME}<div id="content">${CONTENT}</div></body></html>`);
  });

  it("agrees on a page that is nothing but chrome", () => {
    expectParity(`<html><body>${CHROME}</body></html>`);
  });

  it("agrees on an empty <main> beside a body full of chrome", () => {
    expectParity(`<html><body>${CHROME}<main>   </main></body></html>`);
  });

  it("agrees on a nested <main> — invalid HTML, and one element's text", () => {
    expectParity(
      `<html><body><main><p>outer copy</p><main><p>inner copy</p></main><p>after</p></main></body></html>`,
    );
  });

  it("agrees that the FIRST <main> is the one measured", () => {
    expectParity(
      `<html><body><main><p>the first main</p></main><main><p>the second main</p></main></body></html>`,
    );
  });

  it("agrees on chrome INSIDE a <main> — it is furniture there too", () => {
    // Inverted by the §11 amendment: this used to assert that a `<nav>` inside
    // a `<main>` counted as content. The evidence said otherwise.
    expectParity(
      `<html><body><header><p>site chrome</p></header>` +
        `<main><nav><a href="/x">in-article nav</a></nav><p>article copy</p></main></body></html>`,
    );
    const { mainWordCount } = analyzeHtml(
      `<html><body><header><p>site chrome</p></header>` +
        `<main><nav><a href="/x">in-article nav</a></nav><p>article copy</p></main></body></html>`,
      PAGE_URL,
    );
    expect(mainWordCount).toBe(2);
  });

  it("agrees that chrome inside a <main> is excluded — the theme's footer", () => {
    // The defect in miniature: a Shopify theme's `<main>` holds the newsletter
    // block and the footer navigation, so an otherwise empty page fingerprinted
    // 105 words of footer. The main content here is the heading and the
    // paragraph — 5 words — and NOT the 100 words of `<footer>` beside them.
    const html =
      `<html><body><main><h1>A dress</h1><p>only these words</p>` +
      `<footer><p>${"terms delivery returns and ".repeat(25)}</p></footer></main></body></html>`;
    expectParity(html);
    const { mainWordCount, wordCount } = analyzeHtml(html, PAGE_URL);
    expect(mainWordCount).toBe(5);
    // The whole-text stream still sees all of it — this is a main-content rule,
    // not a change to `wordCount`.
    expect(wordCount).toBe(105);
  });

  it("agrees on a <main> that is nothing but chrome — nothing to fingerprint", () => {
    // The empty-template-page case: a `/pages/*` with no copy of its own, whose
    // `<main>` carries only the theme's newsletter block. Null, never 0.
    const html = `<html><body><main><footer><p>${"terms delivery returns and ".repeat(25)}</p></footer></main></body></html>`;
    expectParity(html);
    const { mainWordCount, mainSimhash } = analyzeHtml(html, PAGE_URL);
    expect(mainWordCount).toBeNull();
    expect(mainSimhash).toBeNull();
  });

  it("agrees on a <main> INSIDE a <footer> — enclosing chrome is not descended into", () => {
    // Malformed, and real. Both sides start at the `<main>`, so the `<footer>`
    // around it is irrelevant; only chrome BELOW the `<main>` is excluded.
    expectParity(
      `<html><body><footer><main><p>the page copy</p>` +
        `<nav><p>an in-main menu</p></nav></main></footer></body></html>`,
    );
  });

  it("agrees on a <template> inside a <main>", () => {
    expectParity(
      `<html><body><main><p>real copy</p><template><p>a card the JS clones</p></template>` +
        `<p>more real copy</p></main></body></html>`,
    );
  });

  it("agrees that a <main> inside a <template> is not the page's main", () => {
    // A selector reaches it and neither text walk does: the fallback measures
    // the body, and the template's words are in neither number.
    expectParity(
      `<html><body><template><main><p>a cloned layout</p></main></template>` +
        `<nav><p>chrome</p></nav><p>the page's own copy</p></body></html>`,
    );
  });

  it("agrees on chrome that nests, and on a stray close tag between", () => {
    expectParity(
      `<html><body><footer><nav><a href="/a">a</a></nav>footer copy</footer></nav>` +
        `<p>body copy after a stray close</p></body></html>`,
    );
  });

  it("agrees on text pressed directly against a chrome boundary", () => {
    // No element between the words and the `<nav>`: this is where a missing
    // separator would silently merge "before" and "after" into one word.
    expectParity(`<html><body>before<nav><p>menu</p></nav>after</body></html>`);
  });

  it("agrees on a page whose only text is inside hidden markup", () => {
    // The main-content stream does NOT apply the hidden rule, so it counts
    // these words while `renderableWordCount` does not — on both sides.
    expectParity(`<html><body><div hidden><p>hidden copy in no main</p></div></body></html>`);
  });

  it("agrees on the placeholder quotation in a card excerpt", () => {
    expectParity(
      `<html><body>${CHROME}<main><h1>A post</h1>` +
        `<p class="excerpt">Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>` +
        `<p>${"the real body copy of the post ".repeat(20)}</p></main></body></html>`,
    );
  });

  it("agrees when the placeholder is split by a line break", () => {
    expectParity(`<html><body><p>Lorem\n  ipsum dolor sit amet.</p></body></html>`);
  });

  it("agrees on a short page whose whole text is the quotation", () => {
    expectParity(`<html><body><p>Lorem ipsum dolor.</p></body></html>`);
  });
});

/**
 * Phase 26b's head facts and social set against the selectors they are
 * defined by. `socialImageRefs` is stripped (see EXTENSION_FIELDS); the social
 * set it comes from is compared whole.
 */
describe("the Phase 26b head facts and social set, against the DOM", () => {
  it("agrees on a complete, consistent social set", () => {
    expectParity(`<!doctype html><html lang="en"><head><title>T</title>
      <meta property="og:title" content="T"><meta property="og:type" content="website">
      <meta property="og:url" content="https://example.com/blog/post">
      <meta property="og:image" content="https://example.com/i.png">
      <meta property="og:site_name" content="Site"><meta property="og:description" content="D">
      <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="T">
      <meta name="twitter:description" content="D"><meta name="twitter:image" content="/x.png">
      </head><body><h2>Sub</h2><p>x</p></body></html>`);
  });

  it("agrees on repeated, conflicting, name= and property= social tags", () => {
    expectParity(`<html><head>
      <meta property="og:title" content=" a "><meta name="og:title" content="a">
      <meta property="og:title" content="b"><meta property="twitter:card" content="summary">
      <meta name="twitter:title" property="og:title" content="c">
      <meta property="og:image"><meta property="OG:IMAGE" content="/i.png">
      </head><body><p>x</p></body></html>`);
  });

  it("agrees on social tags after the head ends, in a template and in a noscript", () => {
    expectParity(`<html><head><meta property="og:title" content="t">
      <template><meta property="og:type" content="article"></template>
      <noscript><meta property="og:url" content="/ns"></noscript>
      </head><body><div>x</div><meta name="twitter:card" content="summary"></body></html>`);
    expectParity(`<html><head><img src="/pixel.gif"><meta property="og:title" content="t"></head><body></body></html>`);
  });

  it("agrees on a page with no social tag at all", () => {
    expectParity(`<html><head><title>t</title></head><body><p>x</p></body></html>`);
  });

  it("agrees on robots metas: every robots content joined, the bot-specific ones listed", () => {
    expectParity(`<html><head>
      <meta name="robots" content="index"><meta name="Robots" content="noarchive">
      <meta name="robots"><meta name="GoogleBot" content="noindex">
      <meta name="bingbot"><meta name="robotsx" content="noindex">
      </head><body><p>x</p><meta name="robots" content="nofollow"></body></html>`);
  });

  it("agrees on the meta refresh, the first one only", () => {
    expectParity(`<html><head><meta http-equiv="REFRESH">
      <meta http-equiv="Refresh" content="3; URL='/next'"><meta http-equiv="refresh" content="0">
      </head><body><p>x</p></body></html>`);
  });

  it("agrees on lang, counts and the first h2", () => {
    expectParity(`<html lang=" de-AT "><head><title>a</title><title>b</title>
      <meta name="description" content="1"><meta name="DESCRIPTION" content="2">
      </head><body><svg><title>icon</title></svg><h2>  First  <em>sub</em> </h2><h2>second</h2></body></html>`);
    expectParity(`<html lang=""><body><h2></h2></body></html>`);
    expectParity(`<p>a fragment with no html tag</p>`);
  });

  it("agrees on ruling R6: repeated robots contents collapse, one meta naming two tags is both", () => {
    expectParity(`<html><head>
      <meta name="robots" content="index"><meta name="robots" content=" index ">
      <meta name="robots" content="noarchive"><meta name="robots" content="index">
      <meta name="twitter:title" property="og:title" content="both">
      <meta name="og:description" property="twitter:description" content="crossed">
      <meta name="twitter:card" property="twitter:card" content="summary">
      </head><body><p>x</p><meta name="robots" content="noindex"></body></html>`);
  });
});

/**
 * Phase 26b's body facts (Task 3) against the selectors they are defined by:
 * `a` start tags for the anchor counts, `img` for the alt facts,
 * `link[rel~=next|prev]` for the counts, the closed media/frame/form list for
 * the insecure references, and anchor text with `img[alt]` folded in.
 */
describe("the Phase 26b body facts, against the DOM", () => {
  it("agrees on anchors that are not links", () => {
    expectParity(`<html><body>
      <a name="top"></a><a id="x">y</a><a onclick="go()">a</a><a role="LINK">b</a><a role="tab">t</a>
      <a href="#section">s</a><a href="#">h</a><a href=" #! ">b</a>
      <a href=" JavaScript:void(0)">j</a><a href="">e</a><a href="   ">e2</a>
      <a target="_BLANK" rel="noopener" href="/x">x</a><a target="_blank" href="/y">y</a>
      <a target="_blank" rel="NoReferrer nofollow" href="/z">z</a>
      <a target="_blank" href="javascript:void(0)">jb</a><a target="_blank">nb</a>
      <noscript><a href="#">ns</a></noscript>
      </body></html>`);
  });

  it("agrees on image alt folded into anchor text", () => {
    expectParity(`<html><body>
      <a href="/logo"><img src="a.png" alt="Logo"></a>
      <a href="/none"><img src="b.png"></a>
      <a href="/mixed">Visit <img src="c.png" alt="  our shop "> now</a>
      <a href="/blank"><img src="d.png" alt="  "></a>
      <img src="loose.png" alt="Loose"><a href="/after">After</a>
      </body></html>`);
  });

  it("agrees on rel next/prev counts", () => {
    expectParity(`<html><head><link rel="next" href="/2"><link rel="NEXT" href="/3">
      <link rel="prev"><link rel="prev prefetch" href="/0"><link rel="nextx" href="/n">
      </head><body><p>x</p></body></html>`);
  });

  it("agrees on insecure references, their order and the sample cap", () => {
    expectParity(`<html><body>
      <iframe src="http://x.test/a"></iframe><iframe src="https://x.test/s"></iframe>
      <video src="http://m.test/1" poster="http://m.test/2"><source src="http://m.test/3">
        <track src="http://m.test/4"></video>
      <audio><source src="/rel.mp3"><source src="http://m.test/5"></audio>
      <picture><source src="http://m.test/pic"></picture><source src="http://m.test/loose">
      <embed src="http://m.test/6"><object data="http://m.test/7"></object>
      <form action="http://x.test/post"></form><form action="/ok"></form><form></form>
      <form action="javascript:void(0)"></form>
      <iframe src="http://x.test/8"></iframe><iframe src="http://x.test/9"></iframe>
      <iframe src="http://x.test/10"></iframe><iframe src="http://x.test/11"></iframe>
      <noscript><iframe src="http://gtm.test/ns"></iframe></noscript>
      </body></html>`);
  });

  it("agrees on the image alt facts and the missing-alt sample", () => {
    const imgs = Array.from({ length: 12 }, (_, i) => `<img src="/i${i}.png">`).join("");
    expectParity(`<html><body>
      <img src="/e.png" alt=""><img src="/e2.png" alt="  "><img data-src="/lazy.png">
      <img src="/long.png" alt="${"a".repeat(101)}"><img src="/ok.png" alt="${"b".repeat(100)}">
      <img src="/${"s".repeat(600)}">${imgs}
      <noscript><img src="/ns.png"></noscript>
      </body></html>`);
  });
});

/**
 * Adapted from open-seo (MIT), src/server/lib/audit/page-analyzer.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 *
 * The streaming tokenizer, its state machine and every subtlety it encodes
 * (title-inside-svg, noscript-as-raw-text, implicitly-closed nested anchors,
 * body-vs-fallback text scoping, present-but-empty alt) are upstream's and are
 * carried over unchanged. Changes, each explained at its site below:
 *  - Upstream's `PageAnalysis` type lived in src/server/lib/audit/types.ts
 *    (a fifth file, read at the same sha). Rather than absorb that module —
 *    most of it is Lighthouse/persistence shapes Ariadne does not share — the
 *    two types this file needs (`PageAnalysis`, `PageLink`) are declared here.
 *    Ariadne's `PageAnalysis` is the shape the build plan specifies, not
 *    upstream's; `analyzeHtml` keeps producing upstream's richer result under
 *    the name `RawPageAnalysis` and `analyzePage` is the facade over it.
 *  - Dropped upstream's `statusCode` / `responseTimeMs` / `redirectUrl` /
 *    `url` passthrough parameters: they are fetch-layer facts the analyzer
 *    never reads, and Ariadne's crawl loop owns them.
 *  - Per-image records are no longer accumulated. The build plan wants images
 *    counted, not stored, so `imagesTotal` / `imagesMissingAlt` are counters.
 *    That also removes upstream's image cap and the count saturation it caused.
 *  - Added `canonicalCount`, `headingCounts`, `hasAmp` (the `pages` row wants
 *    all three) and a per-link `position`.
 *  - `rel` values are lowercased before they are matched. Upstream compared
 *    `attribs["rel"] === "canonical"` case-sensitively while its cheerio
 *    oracle matched case-insensitively (css-select treats `rel` as one of
 *    HTML's case-insensitive attribute values), so `rel="Canonical"` silently
 *    diverged. HTML link types are case-insensitive; lowercasing (and, on the
 *    same token-value reasoning as below, trimming) is correct and restores
 *    parity.
 *  - The same case-folding is applied to `<meta>` `name` / `property` and to
 *    `<script type>`, which upstream also compared case-sensitively:
 *    `name="Description"` was read as "no description at all", turning a
 *    present tag into a false "missing" audit fact — the worst kind of defect
 *    this engine can produce. HTML metadata names and MIME types are both
 *    ASCII case-insensitive, and the surrounding whitespace of a token-valued
 *    attribute is not part of the token, so the values are trimmed too.
 *    Unlike `rel`, css-select does NOT case-fold `name` / `property` / `type`
 *    (verified: `meta[name="description"]` misses `name="Description"`), so
 *    here the port deliberately diverges from raw css-select and the parity
 *    oracle case-folds by hand to match. That divergence is the point: the
 *    oracle encodes the old DOM implementation, and the old DOM
 *    implementation was wrong about this.
 *  - Head fields are now strictly first-element-wins. Upstream's `??=` meant a
 *    `<link rel=canonical>` with no href left `canonical` null and let a later
 *    canonical win, which the DOM oracle would not. A `undefined` = not-seen
 *    sentinel makes the first element authoritative either way.
 *  - Caps are the build plan's: links 2000 (upstream 1000), headingOrder 500
 *    (upstream uncapped). Heading *counts* stay uncapped.
 *  - `title` and `metaDescription` are `string | null`, where null means the
 *    element was absent and "" means it was present and empty — upstream
 *    collapsed both to "". The distinction is a real audit signal.
 *
 * Task 6 (P1-T3) then extended the analyzer with the checklist fields upstream
 * never had — rel next/prev, dom size, text ratio, hreflang pairs, JSON-LD
 * capture, content hash and simhash — all inside the same single pass. Two of
 * its changes touch absorbed behaviour rather than adding to it:
 *  - Element boundaries are whitespace. Upstream joined text nodes with no
 *    separator, so minified markup (`</h1><p>`) merged the last word of one
 *    block into the first word of the next and undercounted every such page.
 *    Non-inline element boundaries now emit a separator, matching what a
 *    browser renders; inline elements (`<em>`, `<b>`, …) and stripped
 *    subtrees (`<script>`) do not, so `un<em>believ</em>able` stays one word.
 *    `wordCount`, `textRatio`, `contentHash` and `simhash` all read this one
 *    accumulator. This is a deliberate divergence from the old DOM
 *    implementation (cheerio's `.text()` concatenates exactly as upstream
 *    did); the parity oracle walks the DOM the same way so the suite still
 *    holds the port to a reference, and named tests pin the new behaviour.
 *  - `<link rel>` is matched as a token list, not as a whole value. `rel` is
 *    space-separated by spec (`rel="next prefetch"`), and a DOM `relList` /
 *    css-select `[rel~=…]` match reads it that way; the whole-value compare
 *    upstream used silently missed every multi-token link. Canonical,
 *    alternate/hreflang and amphtml came along to token matching with
 *    next/prev; the oracle was moved to `~=` semantics to match.
 *
 * Phase 2 (P2-T2) added three more signals the page rules need, all inside the
 * same pass: `hasViewport` (a `<meta name=viewport>`, folded like every other
 * meta name), `imagesMissingDimensions` (counted beside the alt counter, one
 * count per image whichever attribute is absent) and `hasLoremIpsum`, derived
 * at the end from the visible-text accumulator — the same one `wordCount`,
 * `contentHash` and `simhash` read, so a lorem-ipsum string inside a script,
 * style or noscript subtree cannot raise the flag. The first two are on the
 * parity surface and the oracle computes them; `hasLoremIpsum` is not, for the
 * same reason `contentHash` and `simhash` are not — it is a derivation of
 * `bodyText`, which the oracle already holds the port to, not a separate piece
 * of DOM reading.
 *
 * Phase 3 (P3-T2) added `hasSoft404Phrases` on exactly the same footing as
 * `hasLoremIpsum`: same visible-text accumulator, same end-of-parse
 * derivation, same exclusion from the parity surface (it is a `bodyText`
 * derivation, not a DOM read, so `EXTENSION_FIELDS` strips it). It exists
 * because the soft-404 rule (CHECK-16) needs a phrase signal it can read in
 * SQL, and the crawl is the only place the page's text is ever in memory.
 *
 * Phase 5 (P5-T2) added the render pass's raw-HTML baseline, again inside the
 * same pass: `navLinkCount` / `footerLinkCount` (depth counters, built on the
 * `titleDepth` idiom) and `frameworkMarkers`. Unlike the two text derivations
 * above, all three ARE DOM reads — `nav a[href]`, `footer a[href]`, and three
 * attribute/id presences — so they stay ON the parity surface and the oracle
 * computes them with those very selectors. That is load-bearing rather than
 * tidy: the render pass runs `document.querySelectorAll('nav a[href]').length`
 * in a real browser and CHECK-34 compares its answer with this one, so the
 * tokenizer has to agree with the selector about nesting and about malformed
 * markup, or the check compares two different questions.
 */
import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { normalizeUrl, isSameOrigin } from "./url-utils.js";
import { simhash64 } from "./simhash.js";

/** A link as the `links` table wants it. */
export interface PageLink {
  /** Absolute, normalized target URL (see url-utils `normalizeUrl`). */
  href: string;
  anchor: string;
  /** Raw `rel` attribute, lowercased; null when the attribute was absent. */
  rel: string | null;
  nofollow: boolean;
  /**
   * 0-based rank among the unique links kept for this page, in the document
   * order of each target's first occurrence. Not a raw `<a>` element index:
   * duplicate targets, skipped protocols and unparseable hrefs never consume
   * a position, so the sequence is always dense.
   */
  position: number;
}

/** One `<link rel=alternate hreflang=…>` target: both halves, or nothing. */
export interface HreflangPair {
  /** The `hreflang` attribute verbatim (BCP47-ish; not normalised here). */
  code: string;
  /** The `href` attribute verbatim — unresolved, as written in the page. */
  href: string;
}

/** One JSON-LD node lifted out of a `<script type="application/ld+json">`. */
export interface StructuredDataBlock {
  /** `@type`, or the first entry when `@type` is an array; else "unknown". */
  type: string;
  /** The parsed node itself, untouched. */
  raw: unknown;
}

/** Data extracted from a single page's HTML. */
export interface PageAnalysis {
  title: string | null;
  metaDescription: string | null;
  /** First `<link rel=canonical>` href; extras are counted, not stored. */
  canonicalHtml: string | null;
  canonicalCount: number;
  robotsMeta: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  /** h1..h6 occurrence counts, uncapped. */
  headingCounts: [number, number, number, number, number, number];
  /** Heading levels in document order, capped at MAX_HEADING_ORDER. */
  headingOrder: number[];
  wordCount: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  /**
   * `<img>` elements missing a `width` or a `height` attribute (either one
   * absent counts the image once). The layout-shift signal: a browser cannot
   * reserve space for an image whose intrinsic box it is not told.
   */
  imagesMissingDimensions: number;
  hasAmp: boolean;
  /** A `<meta name=viewport>` was declared — the mobile-readiness signal. */
  hasViewport: boolean;
  /**
   * The page's visible text contains "lorem ipsum" — placeholder copy that
   * shipped. Read off the same accumulator as `wordCount`, so script, style,
   * noscript and svg subtrees cannot trigger it.
   */
  hasLoremIpsum: boolean;
  /**
   * The page's visible text contains one of `SOFT_404_PHRASES` — the wording a
   * "not found" page uses when it forgot to say 404 in its status line. On its
   * own it is not a finding (a blog post about 404 errors says these words
   * too); the rule pairs it with a thin body and the site's own 404 template.
   * Read off the same accumulator as `wordCount`, so a phrase inside a script,
   * style, noscript or svg subtree cannot raise it.
   */
  hasSoft404Phrases: boolean;
  /**
   * Anchors carrying an `href` attribute inside a `<nav>` — the raw-HTML half
   * of CHECK-34 (navigation that only exists once JavaScript has run). Counted
   * on exactly the terms `document.querySelectorAll('nav a[href]').length`
   * would report, because that is what the render pass reads on the same page
   * and the two numbers are compared: any `href` value counts (`href=""`
   * included), any protocol counts (a `mailto:` nav link is still a nav link,
   * even though it never becomes a `links` row), and an anchor inside nested
   * containers counts once for each container it is in.
   */
  navLinkCount: number;
  /** The same count for `<footer>`; see `navLinkCount`. */
  footerLinkCount: number;
  /**
   * Which of `FRAMEWORK_MARKERS` the raw HTML carries, in that constant's
   * order (a set with a stable spelling, not document order). The tell of
   * which framework shipped the page — NOT a claim that the page needs
   * JavaScript to be readable, which only the render pass can answer.
   */
  frameworkMarkers: string[];
  links: PageLink[];
  /** First `<link rel=next>` href; null when absent or href-less. */
  relNext: string | null;
  /** First `<link rel=prev>` href; null when absent or href-less. */
  relPrev: string | null;
  /** Open-tag tokenizer events — the page's element count as parsed. */
  domSize: number;
  /** Visible-text bytes / HTML bytes, clamped to 0..1. */
  textRatio: number;
  /** `rel=alternate` targets in document order, capped at MAX_HREFLANG_PAIRS. */
  hreflang: HreflangPair[];
  /** JSON-LD nodes in document order, capped at MAX_STRUCTURED_DATA_BLOCKS. */
  structuredData: StructuredDataBlock[];
  /**
   * JSON-LD blocks that produced nothing: invalid JSON, or larger than the
   * per-block buffer cap. Counted rather than swallowed — a page whose
   * structured data does not parse is an audit finding, not an empty list.
   */
  structuredDataParseErrors: number;
  /** sha256 (hex) of the normalised visible text — exact-duplicate key. */
  contentHash: string;
  /**
   * 64-bit simhash of the same text — near-duplicate key. Unsigned range;
   * persistence stores `BigInt.asIntN(64, simhash)` (see simhash.ts).
   */
  simhash: bigint;
}

/**
 * Everything the tokenizer extracts, including the fields `PageAnalysis` does
 * not surface. `bodyText` and `h1s` are the parity suite's business and
 * nothing else's; `hasStructuredData` and `hreflangTags` are upstream's
 * coarse forms of what the facade now carries as `structuredData` and
 * `hreflang`, kept so the absorbed behaviour stays under the oracle.
 */
export interface RawPageAnalysis extends PageAnalysis {
  bodyText: string;
  h1s: string[];
  hasStructuredData: boolean;
  hreflangTags: string[];
  links: RawPageLink[];
}

export interface RawPageLink extends PageLink {
  isInternal: boolean;
}

const SKIPPED_LINK_PROTOCOLS = /^(javascript:|mailto:|tel:|#)/;
/** Subtrees whose text is not visible content. */
const NON_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg"]);
/**
 * Elements that do not break a word. Everything else — blocks, `<br>`, `<img>`,
 * list items, table cells — puts whitespace between the text on either side of
 * it, which is what a browser renders and what upstream's separator-less
 * concatenation got wrong. Shared with the parity oracle, which walks the DOM
 * by the same rule.
 */
export const INLINE_TEXT_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "data", "del", "dfn",
  "em", "font", "i", "ins", "kbd", "label", "mark", "nobr", "q", "rp", "rt",
  "ruby", "s", "samp", "small", "span", "strike", "strong", "sub", "sup",
  "time", "tt", "u", "var", "wbr",
]);
const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};
const MAX_ANCHOR_CHARS = 200;
/**
 * Per-page caps on the extracted collections. Crawler-trap and mega-menu pages
 * can carry thousands of links per page, and pages sit in memory in persist
 * batches — uncapped collections break the O(concurrency) memory contract.
 * Counts derived from these arrays saturate at the cap on such pages; the
 * scalar counters (images, headings) do not and stay exact.
 */
const MAX_EXTRACTED_LINKS = 2_000;
const MAX_HEADING_ORDER = 500;
const MAX_HREFLANG_PAIRS = 200;
const MAX_STRUCTURED_DATA_BLOCKS = 50;
/**
 * Per-block buffer cap for JSON-LD text, in characters. A block over this is
 * never buffered, never parsed, and counted as a failure — the alternative is
 * letting one page with a megabyte of embedded JSON set the crawl's memory
 * high-water mark. Kept blocks retain references into their parsed document,
 * so the worst case a page can hold is roughly this cap times the block cap.
 */
const MAX_LD_JSON_CHARS = 100_000;
/** How far into nested arrays / `@graph` the JSON-LD node walk will go. */
const MAX_LD_JSON_DEPTH = 5;
/**
 * Placeholder copy, matched against the visible text (never the raw HTML — a
 * lorem-ipsum string in a script or a CSS comment is not shipped copy).
 * The accumulator collapses whitespace, so the two words are always one space
 * apart here even when an element boundary separates them in the markup.
 */
const LOREM_IPSUM = /lorem ipsum/i;
/**
 * The wording of a "not found" page, matched against the visible text on the
 * same terms as LOREM_IPSUM (never the raw HTML, and whitespace is already
 * collapsed, so a phrase split across an element boundary still matches).
 *
 * Phrases, never a bare "404": product codes, room numbers, years and error
 * *documentation* all contain it, and this flag feeds a rule that calls a
 * 200-status page broken. A false positive here is a false finding there, so
 * the list buys precision with the cost of missing a page whose only signal is
 * the number — which the template fingerprint in `notfound_probe_jsonb`
 * catches instead.
 *
 * Exported so the test suite pins the list itself rather than a sample of it.
 */
export const SOFT_404_PHRASES = [
  "page not found",
  "page cannot be found",
  "page can't be found",
  "404 error",
  "error 404",
  "404 not found",
  "no longer available",
  "nothing was found",
  "this page doesn't exist",
  "this page does not exist",
] as const;
/**
 * The phrase list as one alternation, LOREM_IPSUM's twin in form as well as in
 * use. Typographic apostrophes are folded into the character class: "this page
 * doesn’t exist" is the same sentence as "this page doesn't exist", and a list
 * that only knew the ASCII form would silently miss most real copy. The
 * phrases contain nothing else a regex reads specially.
 */
const SOFT_404_PATTERN = new RegExp(
  SOFT_404_PHRASES.map((phrase) => phrase.replace(/'/g, "['‘’]")).join("|"),
  "i",
);

/**
 * The client-rendered-framework tells, each one a thing that is in the HTML
 * because a framework put it there:
 *  - `__NEXT_DATA__` — Next.js' hydration payload, a `<script>` with that id.
 *    An id, so matched case-sensitively and verbatim.
 *  - `data-reactroot` — React's server-rendered root attribute.
 *  - `ng-app` — the AngularJS bootstrap attribute.
 * The last two are attributes on any element; htmlparser2 lowercases attribute
 * names, and both are already lowercase, so the `in attribs` test is exact.
 *
 * Exported so the test suite (and any consumer reading `frameworkMarkers`)
 * pins the list itself rather than a sample of it — the SOFT_404_PHRASES
 * precedent. The order here is the order the field reports.
 */
export const FRAMEWORK_MARKERS = ["__NEXT_DATA__", "data-reactroot", "ng-app"] as const;

interface OpenAnchor {
  href: string;
  rel: string | null;
  text: string[];
}

/**
 * Flatten a parsed JSON-LD document into its nodes: arrays and `@graph`
 * containers expand to one entry per node. A container that is itself typed
 * (`{"@type":…,"@graph":[…]}`) counts as a node too.
 */
function collectLdJsonNodes(value: unknown, out: unknown[], depth: number): void {
  if (depth > MAX_LD_JSON_DEPTH || out.length >= MAX_STRUCTURED_DATA_BLOCKS) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectLdJsonNodes(entry, out, depth + 1);
    return;
  }
  // Scalars and null are not JSON-LD nodes: valid JSON, nothing to record.
  if (typeof value !== "object" || value === null) return;
  const node = value as Record<string, unknown>;
  const graph = node["@graph"];
  if (graph !== undefined) {
    if ("@type" in node) out.push(node);
    collectLdJsonNodes(graph, out, depth + 1);
    return;
  }
  out.push(value);
}

/** `@type` of a JSON-LD node — first entry when it is an array. */
function ldJsonType(node: unknown): string {
  if (typeof node !== "object" || node === null) return "unknown";
  const type = (node as Record<string, unknown>)["@type"];
  if (typeof type === "string" && type.trim() !== "") return type;
  if (Array.isArray(type)) {
    const first = type.find(
      (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
    );
    if (first !== undefined) return first;
  }
  return "unknown";
}

/**
 * Analyze an HTML string and extract every SEO-relevant signal the tokenizer
 * can see. Prefer `analyzePage`; this is the wide result the parity suite
 * compares against a DOM oracle and that Task 6 will widen the facade onto.
 *
 * Deliberately NOT a DOM parser: a DOM costs ~5-10x the HTML's size per page
 * and, at crawl concurrency, is the dominant OOM cause. The tokenizer keeps
 * only the accumulated text and the extracted fields in memory.
 */
export function analyzeHtml(html: string, pageUrl: string): RawPageAnalysis {
  // Upstream accumulated the title into a `string | null`; the parts array
  // plus a sawTitle flag says the same thing without the += churn, and keeps
  // "present but empty" distinguishable from "absent".
  const titleParts: string[] = [];
  let sawTitle = false;
  let titleDepth = 0;
  let titleDone = false;
  // parse5 (the old DOM path) treats <noscript> content as raw text when
  // scripting is enabled; skip element extraction inside it to match.
  let noscriptDepth = 0;
  // `undefined` = the element was never seen, so the next one is the first and
  // wins; `null` = seen without a usable attribute.
  let metaDescription: string | null | undefined;
  let canonical: string | null | undefined;
  let robotsMeta: string | null | undefined;
  let ogTitle: string | null | undefined;
  let ogDescription: string | null | undefined;
  let ogImage: string | null | undefined;
  let canonicalCount = 0;
  let hasStructuredData = false;
  let hasAmp = false;
  let hasViewport = false;
  const hreflangTags: string[] = [];
  let relNext: string | null | undefined;
  let relPrev: string | null | undefined;
  const hreflang: HreflangPair[] = [];
  let domSize = 0;

  // JSON-LD is buffered one block at a time: the tokenizer hands its text over
  // in pieces, and only the closing </script> says the block is complete.
  const structuredData: StructuredDataBlock[] = [];
  let structuredDataParseErrors = 0;
  let inLdJson = false;
  let ldJsonParts: string[] = [];
  let ldJsonChars = 0;
  let ldJsonOversize = false;

  const h1s: string[] = [];
  const headingOrder: number[] = [];
  const headingCounts = [0, 0, 0, 0, 0, 0];
  let openH1: string[] | null = null;

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let imagesMissingDimensions = 0;
  const linksByTarget = new Map<string, RawPageLink>();
  let openAnchor: OpenAnchor | null = null;

  // `nav a[href]` / `footer a[href]`, counted with depth counters the way
  // `titleDepth` is: incremented on the open tag, decremented on the close,
  // and an anchor counted while a counter is positive. Depths rather than
  // booleans because the containers nest — a <nav> inside a <nav> that closes
  // must not take the outer one down with it — and the decrements are guarded
  // so a stray close tag (a real thing in real HTML) cannot drive a counter
  // negative and silence every anchor after it. htmlparser2 emits the implied
  // close of an open <nav> when a `</footer>` pops it, which is what the HTML
  // parsing spec does too, so malformed nesting lands where a browser puts it.
  let navDepth = 0;
  let footerDepth = 0;
  let navLinkCount = 0;
  let footerLinkCount = 0;

  // Which of FRAMEWORK_MARKERS the document carried. A set of at most three
  // short strings, so it costs nothing against the memory contract, and it
  // keeps the marker's name in one place — the constant — rather than in a
  // boolean whose mapping back to a name has to be maintained.
  const markersSeen = new Set<string>();

  // Visible text: prefer text inside an explicit <body>; when the document
  // never opens one (fragments), fall back to all non-head text. Both
  // exclude NON_CONTENT_TAGS subtrees.
  let suppressDepth = 0;
  let bodyDepth = 0;
  let headDepth = 0;
  let sawBody = false;
  const bodyParts: string[] = [];
  const fallbackParts: string[] = [];

  const handleMetaTag = (attribs: Record<string, string>) => {
    const content = attribs["content"];
    const name = attribs["name"]?.trim().toLowerCase();
    const property = attribs["property"]?.trim().toLowerCase();
    if (name === "description") {
      if (metaDescription === undefined) metaDescription = content?.trim() ?? "";
    } else if (name === "robots") {
      if (robotsMeta === undefined) robotsMeta = content ?? null;
    } else if (name === "viewport") {
      // Presence is the whole signal; the content string is the agent's
      // business, not the evidence layer's.
      hasViewport = true;
    } else if (property === "og:title") {
      if (ogTitle === undefined) ogTitle = content ?? null;
    } else if (property === "og:description") {
      if (ogDescription === undefined) ogDescription = content ?? null;
    } else if (property === "og:image") {
      if (ogImage === undefined) ogImage = content ?? null;
    }
  };

  const handleLinkTag = (attribs: Record<string, string>) => {
    const rel = attribs["rel"]?.trim().toLowerCase();
    if (!rel) return;
    // `rel` is a space-separated token list: rel="next prefetch" is a next
    // link. Whole-value matching missed those; `~=` semantics do not.
    const tokens = rel.split(/\s+/);
    const href = attribs["href"];
    if (tokens.includes("canonical")) {
      if (canonical === undefined) canonical = href ?? null;
      canonicalCount += 1;
    }
    const code = attribs["hreflang"];
    if (tokens.includes("alternate") && code) {
      hreflangTags.push(code);
      // A pair with no href names no target, so it is not a pair. The code
      // itself survives on the raw `hreflangTags` list.
      if (href !== undefined && hreflang.length < MAX_HREFLANG_PAIRS) {
        hreflang.push({ code, href });
      }
    }
    if (tokens.includes("amphtml")) hasAmp = true;
    if (tokens.includes("next") && relNext === undefined) relNext = href ?? null;
    if (tokens.includes("prev") && relPrev === undefined) relPrev = href ?? null;
  };

  /**
   * Finish the JSON-LD block the tokenizer was buffering. Never throws: a
   * block that will not parse is counted, not guessed at and not fatal.
   */
  const flushLdJson = () => {
    const text = ldJsonParts.join("");
    const oversize = ldJsonOversize;
    inLdJson = false;
    ldJsonParts = [];
    ldJsonChars = 0;
    ldJsonOversize = false;
    if (oversize) {
      structuredDataParseErrors += 1;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      structuredDataParseErrors += 1;
      return;
    }
    const nodes: unknown[] = [];
    collectLdJsonNodes(parsed, nodes, 0);
    for (const node of nodes) {
      if (structuredData.length >= MAX_STRUCTURED_DATA_BLOCKS) break;
      structuredData.push({ type: ldJsonType(node), raw: node });
    }
  };

  /**
   * Emit an element boundary into the visible-text accumulator. Runs under the
   * same scoping rules as `ontext`, and collapses runs so a tag-dense page does
   * not grow the accumulator with separators.
   */
  const emitTextBoundary = () => {
    if (suppressDepth > 0 || titleDepth > 0) return;
    const parts =
      bodyDepth > 0 ? bodyParts : headDepth === 0 ? fallbackParts : null;
    if (parts === null) return;
    if (parts.length === 0 || parts[parts.length - 1] === " ") return;
    parts.push(" ");
  };

  const isTextBoundary = (name: string) =>
    !INLINE_TEXT_TAGS.has(name) && !NON_CONTENT_TAGS.has(name);

  const closeAnchor = () => {
    if (!openAnchor) return;
    const { href, rel, text } = openAnchor;
    openAnchor = null;
    if (linksByTarget.size >= MAX_EXTRACTED_LINKS) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved || linksByTarget.has(resolved)) return;
    const anchor = text
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ANCHOR_CHARS);
    linksByTarget.set(resolved, {
      href: resolved,
      anchor,
      rel,
      nofollow: (rel ?? "").split(/\s+/).includes("nofollow"),
      isInternal: isSameOrigin(resolved, pageUrl),
      position: linksByTarget.size,
    });
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        domSize += 1;
        if (NON_CONTENT_TAGS.has(name)) {
          suppressDepth += 1;
        }
        if (name === "noscript") noscriptDepth += 1;
        if (noscriptDepth > 0) return;
        switch (name) {
          case "title":
            // Ignore <title> inside <svg> — only the document title counts.
            if (!titleDone && suppressDepth === 0) {
              titleDepth += 1;
              sawTitle = true;
            }
            break;
          case "head":
            headDepth += 1;
            break;
          case "body":
            bodyDepth += 1;
            sawBody = true;
            break;
          case "html":
            // An AMP page marks its root element with `amp` or `⚡`; a page
            // that merely *has* an AMP twin links to it with rel=amphtml.
            // Either is enough for pages.has_amp.
            if ("amp" in attribs || "⚡" in attribs) hasAmp = true;
            break;
          case "meta":
            handleMetaTag(attribs);
            break;
          case "link":
            handleLinkTag(attribs);
            break;
          case "img":
            imagesTotal += 1;
            if (!("alt" in attribs)) imagesMissingAlt += 1;
            // One image, one count: missing either attribute is the same
            // layout-shift defect and must not be double-counted.
            if (!("width" in attribs) || !("height" in attribs)) {
              imagesMissingDimensions += 1;
            }
            break;
          case "nav":
            navDepth += 1;
            break;
          case "footer":
            footerDepth += 1;
            break;
          case "script":
            // An id is case-sensitive and is not a token list: compared
            // verbatim, unlike `rel` / `type` / meta names above.
            if (attribs["id"] === "__NEXT_DATA__") markersSeen.add("__NEXT_DATA__");
            if (
              attribs["type"]?.trim().toLowerCase() === "application/ld+json"
            ) {
              hasStructuredData = true;
              inLdJson = true;
              ldJsonParts = [];
              ldJsonChars = 0;
              ldJsonOversize = false;
            }
            break;
          case "a": {
            // `a[href]`, before the link extraction below narrows it: the
            // attribute's presence is the whole test, so an empty value and a
            // `mailto:` both count here while neither becomes a `links` row.
            if ("href" in attribs) {
              if (navDepth > 0) navLinkCount += 1;
              if (footerDepth > 0) footerLinkCount += 1;
            }
            // HTML forbids nested <a>; browsers implicitly close the open
            // one, and the tokenizer has no tree correction, so mirror that.
            closeAnchor();
            const href = attribs["href"];
            if (href && !SKIPPED_LINK_PROTOCOLS.test(href)) {
              openAnchor = {
                href,
                rel: attribs["rel"]?.trim().toLowerCase() ?? null,
                text: [],
              };
            }
            break;
          }
        }
        // Framework attributes live on whatever element the framework chose
        // (<html>, <body>, a wrapper div), so they are read off every open tag
        // rather than from a case above.
        if ("data-reactroot" in attribs) markersSeen.add("data-reactroot");
        if ("ng-app" in attribs) markersSeen.add("ng-app");
        const headingLevel = HEADING_LEVELS[name];
        if (headingLevel !== undefined) {
          headingCounts[headingLevel - 1] =
            (headingCounts[headingLevel - 1] ?? 0) + 1;
          if (headingOrder.length < MAX_HEADING_ORDER) {
            headingOrder.push(headingLevel);
          }
          if (headingLevel === 1 && openH1 === null) openH1 = [];
        }
        if (isTextBoundary(name)) emitTextBoundary();
      },
      ontext(text) {
        // JSON-LD lives inside a suppressed subtree, so it is buffered before
        // the visible-text scoping rules get a say.
        if (inLdJson && !ldJsonOversize) {
          ldJsonChars += text.length;
          if (ldJsonChars > MAX_LD_JSON_CHARS) {
            ldJsonOversize = true;
            ldJsonParts = [];
          } else {
            ldJsonParts.push(text);
          }
        }
        if (suppressDepth > 0) return;
        if (titleDepth > 0) {
          titleParts.push(text);
          return;
        }
        if (openH1) openH1.push(text);
        if (openAnchor) openAnchor.text.push(text);
        if (bodyDepth > 0) {
          bodyParts.push(text);
        } else if (headDepth === 0) {
          fallbackParts.push(text);
        }
      },
      onclosetag(name) {
        if (NON_CONTENT_TAGS.has(name) && suppressDepth > 0) {
          suppressDepth -= 1;
        }
        if (name === "noscript" && noscriptDepth > 0) {
          noscriptDepth -= 1;
          return;
        }
        if (noscriptDepth > 0) return;
        if (isTextBoundary(name)) emitTextBoundary();
        if (name === "script" && inLdJson) flushLdJson();
        if (name === "title" && titleDepth > 0) {
          titleDepth -= 1;
          if (titleDepth === 0) titleDone = true;
        }
        if (name === "nav" && navDepth > 0) navDepth -= 1;
        if (name === "footer" && footerDepth > 0) footerDepth -= 1;
        if (name === "head" && headDepth > 0) headDepth -= 1;
        if (name === "body" && bodyDepth > 0) bodyDepth -= 1;
        if (name === "a") closeAnchor();
        if (name === "h1" && openH1) {
          h1s.push(openH1.join("").trim());
          openH1 = null;
        }
      },
    },
    // Defaults (non-XML mode): lowercased tag/attribute names, decoded
    // entities — matching what the DOM-based implementation saw.
  );
  parser.write(html);
  parser.end();
  // A document that ends inside a JSON-LD script still owes us its block.
  if (inLdJson) flushLdJson();

  const rawText = (sawBody ? bodyParts : fallbackParts).join("");
  const bodyText = rawText.replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  const title: string | null = sawTitle ? titleParts.join("").trim() : null;

  // Bytes, not characters, on both sides: the ratio is about wire weight.
  // Clamped because a text-only fragment is legitimately all text, and
  // entity decoding can nudge a pathological page a hair over 1.
  const htmlBytes = Buffer.byteLength(html);
  const textRatio =
    htmlBytes === 0 ? 0 : Math.min(1, Buffer.byteLength(bodyText) / htmlBytes);

  return {
    title,
    metaDescription: metaDescription ?? null,
    canonicalHtml: canonical ?? null,
    canonicalCount,
    robotsMeta: robotsMeta ?? null,
    ogTitle: ogTitle ?? null,
    ogDescription: ogDescription ?? null,
    ogImage: ogImage ?? null,
    headingCounts: [
      headingCounts[0] ?? 0,
      headingCounts[1] ?? 0,
      headingCounts[2] ?? 0,
      headingCounts[3] ?? 0,
      headingCounts[4] ?? 0,
      headingCounts[5] ?? 0,
    ],
    headingOrder,
    wordCount,
    imagesTotal,
    imagesMissingAlt,
    imagesMissingDimensions,
    hasAmp,
    hasViewport,
    hasLoremIpsum: LOREM_IPSUM.test(bodyText),
    hasSoft404Phrases: SOFT_404_PATTERN.test(bodyText),
    navLinkCount,
    footerLinkCount,
    // The constant's order, not document order: the field is a set, and a set
    // with a stable spelling is one a SQL comparison can be written against.
    frameworkMarkers: FRAMEWORK_MARKERS.filter((marker) => markersSeen.has(marker)),
    links: Array.from(linksByTarget.values()),
    relNext: relNext ?? null,
    relPrev: relPrev ?? null,
    domSize,
    textRatio,
    hreflang,
    structuredData,
    structuredDataParseErrors,
    contentHash: createHash("sha256").update(bodyText).digest("hex"),
    simhash: simhash64(bodyText),
    bodyText,
    h1s,
    hasStructuredData,
    hreflangTags,
  };
}

/**
 * The facade the crawl loop and the rule engine consume: the build plan's
 * `PageAnalysis`, nothing wider.
 */
export function analyzePage(html: string, url: string): PageAnalysis {
  const raw = analyzeHtml(html, url);
  return {
    title: raw.title,
    metaDescription: raw.metaDescription,
    canonicalHtml: raw.canonicalHtml,
    canonicalCount: raw.canonicalCount,
    robotsMeta: raw.robotsMeta,
    ogTitle: raw.ogTitle,
    ogDescription: raw.ogDescription,
    ogImage: raw.ogImage,
    headingCounts: raw.headingCounts,
    headingOrder: raw.headingOrder,
    wordCount: raw.wordCount,
    imagesTotal: raw.imagesTotal,
    imagesMissingAlt: raw.imagesMissingAlt,
    imagesMissingDimensions: raw.imagesMissingDimensions,
    hasAmp: raw.hasAmp,
    hasViewport: raw.hasViewport,
    hasLoremIpsum: raw.hasLoremIpsum,
    hasSoft404Phrases: raw.hasSoft404Phrases,
    navLinkCount: raw.navLinkCount,
    footerLinkCount: raw.footerLinkCount,
    frameworkMarkers: raw.frameworkMarkers,
    links: raw.links.map(({ href, anchor, rel, nofollow, position }) => ({
      href,
      anchor,
      rel,
      nofollow,
      position,
    })),
    relNext: raw.relNext,
    relPrev: raw.relPrev,
    domSize: raw.domSize,
    textRatio: raw.textRatio,
    hreflang: raw.hreflang,
    structuredData: raw.structuredData,
    structuredDataParseErrors: raw.structuredDataParseErrors,
    contentHash: raw.contentHash,
    simhash: raw.simhash,
  };
}

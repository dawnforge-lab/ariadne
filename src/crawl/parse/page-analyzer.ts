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
  hasAmp: boolean;
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
  const linksByTarget = new Map<string, RawPageLink>();
  let openAnchor: OpenAnchor | null = null;

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
            break;
          case "script":
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
    hasAmp,
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
    hasAmp: raw.hasAmp,
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

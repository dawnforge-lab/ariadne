/**
 * The page facts Phase 26b extracts (extraction version 2): shapes, caps and the
 * one parser that is not a tokenizer callback.
 *
 * Every fact is collected by the streaming tokenizer as state (hard rule 4) and
 * every one is capped (hard rule 6), so per-page memory stays O(1) in page size
 * beyond the caps below. The one exception is `SocialFacts.imageRefs`: two
 * resolved share-image URLs that must equal their `resources` rows' keys, so
 * they are bounded as those keys are, by the body (see the field). The `pages` columns that store them are migration 0026;
 * null in a column means "not measured" (a row written before extraction 2).
 *
 * Every page-derived string among them goes through `storableCap`
 * (src/crawl/storable-text.ts) on its way in: no U+0000, no lone surrogate, and
 * every cap cut on a code-point boundary, so a hostile page cannot make the
 * page-row insert throw.
 */
import { storableCap } from "../storable-text.js";

export type SocialTag =
  | "og:title" | "og:description" | "og:image" | "og:url" | "og:type" | "og:site_name"
  | "twitter:card" | "twitter:title" | "twitter:description" | "twitter:image";

export type SocialFacts = {
  /** First value of each Open Graph tag, raw, capped. */
  og: Partial<Record<"title" | "description" | "image" | "url" | "type" | "site_name", string>>;
  /** First value of each X (twitter:) tag, raw, capped. */
  x: Partial<Record<"card" | "title" | "description" | "image", string>>;
  /** Elements seen per tag. */
  counts: Partial<Record<SocialTag, number>>;
  /** Tags seen with two or more distinct trimmed values, sorted. */
  conflicting: SocialTag[];
  /** Any social tag met with the head closed. */
  outsideHead: boolean;
  /** A twitter:* tag given as property= rather than name=. */
  xViaProperty: boolean;
  /**
   * The address of each JUDGED share image (the first `og:image`, the first
   * `twitter:image`), resolved once, at analysis, from its WHOLE value: the
   * exact key of the `resources` row the crawler wrote for it. Null when the
   * tag is absent or its first value does not start with `http:` or `https:`
   * (any case: a relative value, another scheme, empty), or is one
   * `normalizeUrl` refuses; no `resources` row is written for it, and
   * `social.image-broken` judges it `relative` / `invalid` from the stored
   * value (PR #23 review). `social.image-broken`
   * looks rows up by this string and never re-resolves the capped `og.image` /
   * `x.image`, so a share image over `SOCIAL_URL_MAX` still finds its row and
   * the two sides cannot drift (final review I1).
   *
   * The one uncapped string in the page facts: it must equal its row's key
   * byte for byte, so it is bounded exactly as `resources.url` is, by the page
   * body; two per page at most. `normalizeUrl` output is ASCII, so storable.
   *
   * Phase 26c: a resolved address over `INDEXED_URL_MAX` is null here too (no
   * `resources` row can be keyed by it), and `imageRefTooLong` says why.
   */
  imageRefs: { og: string | null; x: string | null };
  /**
   * Phase 26c (extraction 3): whether each judged share image resolved to an
   * address over `INDEXED_URL_MAX`, so it has no ref and no `resources` row;
   * `social.image-broken` reports it as `too-long`. Always present on a social
   * object extraction 3 wrote, false for an absent or unresolvable image; a
   * v2 object lacks the key and is judged as Phase 26b judged it (ruling R3).
   */
  imageRefTooLong: { og: boolean; x: boolean };
};

/** Bot-specific robots metas only (not plain "robots"); `name` is lower-cased. */
export type RobotsMetaEntry = { name: string; content: string };

/**
 * A `<meta http-equiv=refresh>`; `target` is resolved absolute (cut at
 * `REFRESH_TARGET_MAX`), or null.
 */
export type RefreshFact = { raw: string; delaySeconds: number | null; target: string | null };

export type AnchorCounts = {
  noHref: number;
  javascript: number;
  hashOnly: number;
  emptyHref: number;
  unsafeBlank: number;
};

export type InsecureRefKind = "iframe" | "media" | "form";
export type InsecureRefs = {
  iframe: number;
  media: number;
  formAction: number;
  forms: number;
  sample: { kind: InsecureRefKind; url: string }[];
};

/**
 * References a page made that were over `INDEXED_URL_MAX` (extraction 3):
 * counted per kind, never stored. `pages.overlong_urls`. Each is a count of
 * REFERENCES (one per `<a>`, resource site or hreflang `<link>` refused), not
 * of distinct URLs: keeping the refused URLs to dedupe them is what this
 * avoids. Bounded by the per-page caps, which a refused reference consumes
 * like a kept one (`links` 2,000, `resources` `MAX_RESOURCE_REFS`, `hreflang`
 * 200). Share images are not counted here: `SocialFacts.imageRefTooLong`.
 */
export type OverlongUrls = { links: number; resources: number; hreflang: number };

export type HtmlStructure = {
  htmlTags: number;
  headTags: number;
  bodyTags: number;
  headBeforeBody: boolean | null;
  closedEarly: {
    tag: string;
    snippet: string;
    inNoscript: boolean;
    /**
     * Owner call O3 (2026-11-07): the head tags AFTER the candidate, and before
     * the first explicit `<body>`, that a parser closing the head at the
     * candidate moves into the body: `base`, a `title` outside `<svg>`, `meta`
     * (any `<meta>` without `itemprop`), and `link rel=<token>` for a `<link>`
     * with a head-only rel (its first token that is not body-ok, lower-cased).
     * Document order, each entry once, at most `HEAD_LOST_MAX`, each cut at
     * `HEAD_SNIPPET_MAX` through `storableCap`. An explicit `<body>` or
     * `</head>` confirms the candidate but is never lost, so `[]` is an early
     * close that loses nothing today. A version-2 row written before O3 has no
     * `lost` key at all; the rules that read it throw "re-crawl".
     */
    lost: string[];
  } | null;
};

export const SOCIAL_TEXT_MAX = 300;
/** Applies to `og.url`, `og.image` and `x.image`. */
export const SOCIAL_URL_MAX = 1024;
export const ROBOTS_METAS_MAX = 10;
export const ROBOTS_META_CONTENT_MAX = 512;
export const REFRESH_RAW_MAX = 512;
/** `metaRefresh.target` (resolved absolute) is cut here (ruling R16). */
export const REFRESH_TARGET_MAX = 1024;
/**
 * `insecureRefs.sample` keeps at most this many references PER KIND (iframe,
 * media, form), so at most three times this in all, in document order.
 */
export const INSECURE_SAMPLE_MAX = 10;
/** Each `insecureRefs.sample[].url` is cut here; the counters use the whole URL. */
export const INSECURE_SAMPLE_URL_MAX = 1024;
export const IMAGE_SAMPLE_MAX = 10;
export const IMAGE_SAMPLE_SRC_MAX = 512;
export const HEAD_SNIPPET_MAX = 200;
/** `htmlStructure.closedEarly.lost` keeps at most this many tags (owner call O3). */
export const HEAD_LOST_MAX = 10;
/**
 * A link's `aria-label` (`links.aria_label`, migration 0028; owner call O1) is
 * trimmed and cut here, on a code point, through `storableCap`.
 */
export const ARIA_LABEL_MAX = 200;
export const HTML_LANG_MAX = 64;
export const H2_TEXT_MAX = 300;
/** Alts longer than this are counted at extraction; a change needs an extraction bump. */
export const ALT_TEXT_LONG_CHARS = 100;

export const ROBOTS_META_BOTS = [
  "googlebot", "googlebot-news", "googlebot-image", "googlebot-video", "bingbot",
  "msnbot", "slurp", "yandex", "baiduspider", "duckduckbot", "applebot",
] as const;

/** ASCII whitespace as the HTML Standard defines it: TAB, LF, FF, CR, SPACE. */
const isAsciiWhitespace = (c: string | undefined): boolean =>
  c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
const isAsciiDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
/** What the URL parser strips from both ends of its input: C0 controls and space. */
const URL_PARSER_TRIM = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

/**
 * Parse a `<meta http-equiv=refresh content=…>` value, or a `Refresh` header,
 * by the HTML Standard's "shared declarative refresh steps" exactly (ruling
 * R19, which replaces R5's URL rule):
 *
 * 1. Skip ASCII whitespace and collect ASCII digits as the delay. No digits
 *    and no `.` next means the value is not a refresh at all (`abc`); no
 *    digits before a `.` is a delay of 0 (`.5`).
 * 2. A following run of digits and `.` is IGNORED, so the delay is the
 *    integer part (`1.5.3` is 1).
 * 3. If anything is left, it must start with `;`, `,` or ASCII whitespace, or
 *    the value is not a refresh (`5abc` has no delay and no target). Then
 *    whitespace, one optional `;` or `,`, whitespace.
 * 4. The URL string is the remainder. A leading `url` (any case), optional
 *    whitespace and `=` are consumed only when ALL are there; on the first
 *    mismatch the remainder is parsed whole, so `0; urlredirect.html` names
 *    `urlredirect.html` and `0; URL /next` names `URL /next`. After `=` (or
 *    when the remainder does not start with `u`), whitespace and one optional
 *    quote are skipped, and a quoted string is cut at the same quote.
 *
 * Conventions kept from before: no URL part, or a URL string the URL parser
 * reads as empty (nothing but C0 controls and spaces), gives `target: null`,
 * a reload timer, which `redirect.meta-refresh` treats as silent; a URL string
 * `new URL` refuses gives `target: null`; `raw` is cut at `REFRESH_RAW_MAX`
 * and the resolved target at `REFRESH_TARGET_MAX`; an invalid `baseUrl`
 * throws. Only ASCII whitespace is skipped, never JavaScript's wider `\s`.
 */
export function parseRefresh(value: string, baseUrl: string): RefreshFact {
  const raw = storableCap(value, REFRESH_RAW_MAX);
  const base = new URL(baseUrl);
  const notRefresh: RefreshFact = { raw, delaySeconds: null, target: null };
  let pos = 0;
  const skipWhitespace = (): void => {
    while (isAsciiWhitespace(value[pos])) pos += 1;
  };

  // Step 1: the delay.
  skipWhitespace();
  const timeStart = pos;
  while (isAsciiDigit(value[pos])) pos += 1;
  const timeString = value.slice(timeStart, pos);
  if (timeString === "" && value[pos] !== ".") return notRefresh;
  const delaySeconds = timeString === "" ? 0 : Number(timeString);

  // Step 2: digits and dots after it are ignored.
  while (isAsciiDigit(value[pos]) || value[pos] === ".") pos += 1;

  // Step 3: the separator.
  if (pos < value.length) {
    const c = value[pos];
    if (c !== ";" && c !== "," && !isAsciiWhitespace(c)) return notRefresh;
    skipWhitespace();
    if (value[pos] === ";" || value[pos] === ",") pos += 1;
    skipWhitespace();
  }
  if (pos >= value.length) return { raw, delaySeconds, target: null };

  // Step 4: the URL string.
  let urlString = value.slice(pos);
  parse: {
    if (value[pos] === "u" || value[pos] === "U") {
      pos += 1;
      if (value[pos] !== "r" && value[pos] !== "R") break parse;
      pos += 1;
      if (value[pos] !== "l" && value[pos] !== "L") break parse;
      pos += 1;
      skipWhitespace();
      if (value[pos] !== "=") break parse;
      pos += 1;
      skipWhitespace();
    }
    // The quote step.
    const quote = value[pos] === "'" || value[pos] === '"' ? value[pos]! : "";
    if (quote !== "") pos += 1;
    urlString = value.slice(pos);
    if (quote !== "") {
      const close = urlString.indexOf(quote);
      if (close !== -1) urlString = urlString.slice(0, close);
    }
  }

  // Parse.
  if (urlString.replace(URL_PARSER_TRIM, "") === "") return { raw, delaySeconds, target: null };
  let href: string;
  try {
    href = new URL(urlString, base).href;
  } catch {
    return { raw, delaySeconds, target: null };
  }
  return { raw, delaySeconds, target: storableCap(href, REFRESH_TARGET_MAX) };
}

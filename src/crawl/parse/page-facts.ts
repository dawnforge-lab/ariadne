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
   * tag is absent or its first value names no fetchable file (empty, `data:`,
   * `javascript:`, `#`, or one `normalizeUrl` refuses). `social.image-broken`
   * looks rows up by this string and never re-resolves the capped `og.image` /
   * `x.image`, so a share image over `SOCIAL_URL_MAX` still finds its row and
   * the two sides cannot drift (final review I1).
   *
   * The one uncapped string in the page facts: it must equal its row's key
   * byte for byte, so it is bounded exactly as `resources.url` is, by the page
   * body; two per page at most. `normalizeUrl` output is ASCII, so storable.
   */
  imageRefs: { og: string | null; x: string | null };
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

export type HtmlStructure = {
  htmlTags: number;
  headTags: number;
  bodyTags: number;
  headBeforeBody: boolean | null;
  closedEarly: { tag: string; snippet: string; inNoscript: boolean } | null;
};

export const SOCIAL_TEXT_MAX = 300;
/** Applies to `og.url`, `og.image` and `x.image`. */
export const SOCIAL_URL_MAX = 1024;
export const ROBOTS_METAS_MAX = 10;
export const ROBOTS_META_CONTENT_MAX = 512;
export const REFRESH_RAW_MAX = 512;
/** `metaRefresh.target` (resolved absolute) is cut here (ruling R16). */
export const REFRESH_TARGET_MAX = 1024;
export const INSECURE_SAMPLE_MAX = 10;
/** Each `insecureRefs.sample[].url` is cut here; the counters use the whole URL. */
export const INSECURE_SAMPLE_URL_MAX = 1024;
export const IMAGE_SAMPLE_MAX = 10;
export const IMAGE_SAMPLE_SRC_MAX = 512;
export const HEAD_SNIPPET_MAX = 200;
export const HTML_LANG_MAX = 64;
export const H2_TEXT_MAX = 300;
/** Alts longer than this are counted at extraction; a change needs an extraction bump. */
export const ALT_TEXT_LONG_CHARS = 100;

export const ROBOTS_META_BOTS = [
  "googlebot", "googlebot-news", "googlebot-image", "googlebot-video", "bingbot",
  "msnbot", "slurp", "yandex", "baiduspider", "duckduckbot", "applebot",
] as const;

/**
 * Parse a `<meta http-equiv=refresh content=…>` value per the HTML refresh
 * algorithm: leading digits (optional fraction) are the delay. A separator
 * (`;`, `,` or whitespace) is REQUIRED before a URL part (`5abc` has no URL).
 * The URL part is `url`, optional whitespace and `=` (any case), then an
 * optional quote; a part that starts `url` without `=` has no URL (`urlfoo`),
 * while a part that does not start with `url` is a bare URL (`0; /next`). A
 * quoted URL ends at its closing quote, an unquoted one at the end, trimmed.
 * The target is resolved against `baseUrl`; an invalid `baseUrl` throws, and
 * only the target's own failure to resolve gives `target: null`.
 */
export function parseRefresh(value: string, baseUrl: string): RefreshFact {
  const raw = storableCap(value, REFRESH_RAW_MAX);
  const base = new URL(baseUrl);
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)/.exec(value);
  if (!m) return { raw, delaySeconds: null, target: null };
  const delaySeconds = Number(m[1]);
  const after = value.slice(m[0].length);
  const sep = /^(?:\s*[;,]\s*|\s+)/.exec(after);
  if (!sep) return { raw, delaySeconds, target: null };
  let rest = after.slice(sep[0].length);
  if (/^url/i.test(rest)) {
    const eq = /^url\s*=\s*/i.exec(rest);
    if (!eq) return { raw, delaySeconds, target: null };
    rest = rest.slice(eq[0].length);
  }
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1);
    rest = close === -1 ? rest.slice(1) : rest.slice(1, close);
  }
  rest = rest.trim();
  if (rest === "") return { raw, delaySeconds, target: null };
  try {
    return { raw, delaySeconds, target: storableCap(new URL(rest, base).href, REFRESH_TARGET_MAX) };
  } catch {
    return { raw, delaySeconds, target: null };
  }
}

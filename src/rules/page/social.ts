/**
 * The social page rules (Phase 26b, CHECK-87): what a page's Open Graph and X
 * (Twitter) tags say about how a shared link will look.
 *
 * They read `pages.social` (`SocialFacts`, src/crawl/parse/page-facts.ts): the
 * first trimmed value of each tag, the conflicting tags, the outside-head flag
 * and whether an X tag was given as `property=`. Nothing here parses HTML or
 * fetches (hard rules 2 and 4).
 *
 * NULL IS TWO THINGS, AND `extraction_version` SAYS WHICH. On a row extraction
 * 2 wrote, a null `social` means the page carries no social tag at all, which
 * is exactly what `social.og-incomplete` and `social.x-incomplete` report. On a
 * row an earlier extraction wrote, the column was never measured. So those two
 * rules fire only on a v2 row (ruling R2), and the other two need a non-null
 * column; every one is silent on a v1 row, for which `extraction.not-recorded`
 * speaks (hard rules 1 and 7).
 *
 * AN EMPTY VALUE IS A MISSING VALUE. `<meta property="og:image" content="">`
 * is present and says nothing a platform can use, so `present` treats `""` as
 * absent (values are stored trimmed).
 *
 * THE JUDGED COHORT (`isJudged`): a share preview matters on a page meant to be
 * in the index as itself, as a title does.
 */
import type { SocialFacts, SocialTag } from "../../crawl/parse/page-facts.js";
import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import { finding, isJudged, pageRule, resolveEffectiveCanonical } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";
import { OG_REQUIRED } from "../thresholds.js";

const CHECKS = ["CHECK-87"];
const CATEGORY = "on-page" as const;

/**
 * The recorded `og:` tags the Open Graph protocol defines as arrays, which
 * `social.og-multiple` never reports (ruling R15). Of the tags `SocialFacts`
 * records, `og:image` is one, and so is `og:image:secure_url` (Phase 26c), the
 * https twin of each `og:image` in a gallery: repeating it is the protocol's
 * array, not a conflict. Its other `og:image:*` properties are not recorded.
 */
const OG_ARRAY_TAGS: ReadonlySet<SocialTag> = new Set<SocialTag>([
  "og:image",
  "og:image:secure_url",
]);

/** The extraction that measured `social`; below it a null means "not measured". */
const SOCIAL_EXTRACTION = 2;
/** The extraction that records `og:image:secure_url`; below it the key is absent, not empty. */
const SECURE_URL_EXTRACTION = 3;

function recordedV2(p: PageRecord): boolean {
  return p.extractionVersion !== null && p.extractionVersion >= SOCIAL_EXTRACTION;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** The Open Graph group of a v2 row, or null when the page has no social tag. */
function ogOf(social: SocialFacts | null): SocialFacts["og"] | null {
  return social === null ? null : social.og;
}

export const socialRules: PageRule[] = [
  // `missing` lists every required tag that is absent or empty, in
  // `OG_REQUIRED` order; `none` says the page carries no Open Graph tag at all
  // (no `social`, or only X tags), the spec's "none at all is reported as
  // missing".
  pageRule(
    "social.og-incomplete",
    CHECKS,
    CATEGORY,
    "info",
    [
      { key: "missing", label: "Missing OG Tags" },
      { key: "none", label: "No OG Tags" },
    ],
    (p, self) => {
      if (!isJudged(p) || !recordedV2(p)) return [];
      const og = ogOf(p.social);
      const missing = OG_REQUIRED.filter((key) => og === null || !present(og[key])).map(
        (key) => `og:${key}`,
      );
      if (missing.length === 0) return [];
      return [finding(self, p, { missing, none: og === null || Object.keys(og).length === 0 })];
    },
  ),

  // A tag seen twice with two different values: a platform takes one, and
  // which one is theirs to decide. Only the `og:` tags are this rule's, and
  // not `og:image` (ruling R15): the Open Graph protocol makes it an array
  // (a gallery's images, first preferred), so several values are not a
  // conflict. The fact still records it; the rule exempts it.
  pageRule(
    "social.og-multiple",
    CHECKS,
    CATEGORY,
    "info",
    [{ key: "tags", label: "Conflicting Tags" }],
    (p, self) => {
      if (!isJudged(p) || p.social === null) return [];
      const tags = p.social.conflicting.filter(
        (tag) => tag.startsWith("og:") && !OG_ARRAY_TAGS.has(tag),
      );
      return tags.length > 0 ? [finding(self, p, { tags })] : [];
    },
  ),

  // `og:url` is the address a share is counted against. It should be the
  // page's canonical: on a judged page that is its self-canonical or, with
  // none declared (or one that does not resolve), its own URL. Both sides go
  // through `normalizeUrl`, so a fragment, a host's case or a relative og:url
  // that resolves here is not a difference; a trailing slash on a path is,
  // because it is to `normalizeUrl`. An og:url that will not resolve at all
  // fires: it names nowhere. An absent or empty one is og-incomplete's.
  pageRule(
    "social.og-url-mismatch",
    CHECKS,
    CATEGORY,
    "info",
    [
      { key: "ogUrl", label: "OG URL" },
      { key: "canonical", label: "Canonical" },
    ],
    (p, self) => {
      if (!isJudged(p) || p.social === null) return [];
      const ogUrl = p.social.og.url;
      if (!present(ogUrl)) return [];
      // `??` is the rule's definition, not a fallback: no canonical (or one
      // that does not resolve) means the page itself is the canonical.
      const canonical = resolveEffectiveCanonical(p)?.resolved ?? normalizeUrl(p.url);
      if (canonical === null) {
        throw new Error(`social.og-url-mismatch: page URL ${p.url} does not normalise`);
      }
      return normalizeUrl(ogUrl, p.url) === canonical
        ? []
        : [finding(self, p, { ogUrl, canonical })];
    },
  ),

  // The X card set: a `twitter:card`, and a title, `twitter:title` or the
  // `og:title` X falls back to. `viaProperty` is an X tag written as
  // `property=`, which X ignores; the stored values cannot say which tag was
  // written that way, so `missing` is computed from what was stored and the
  // flag stands beside it.
  pageRule(
    "social.x-incomplete",
    CHECKS,
    CATEGORY,
    "info",
    [
      { key: "missing", label: "Missing X Tags" },
      { key: "viaProperty", label: "Given as property=" },
    ],
    (p, self) => {
      if (!isJudged(p) || !recordedV2(p)) return [];
      const s = p.social;
      const missing: string[] = [];
      if (s === null || !present(s.x.card)) missing.push("twitter:card");
      if (s === null || (!present(s.x.title) && !present(s.og.title))) {
        missing.push("twitter:title");
      }
      const viaProperty = s !== null && s.xViaProperty;
      return missing.length > 0 || viaProperty ? [finding(self, p, { missing, viaProperty })] : [];
    },
  ),

  // A share image served over http from an https page. No browser loads an
  // og:image, so this is not mixed content; it is a share preview a platform
  // that insists on https may drop, and `og:image:secure_url` is the tag that
  // names the https address. It fires only on extraction 3, the first to
  // record that tag: on an older row its absence would be "not measured", and
  // the rule would invent a defect (hard rule 1). Both schemes are read
  // case-insensitively, as the share image's own address is.
  pageRule(
    "social.image-insecure",
    CHECKS,
    CATEGORY,
    "info",
    [
      { key: "ogImage", label: "OG Image" },
      { key: "secureUrl", label: "OG Image Secure URL" },
    ],
    (p, self) => {
      if (!isJudged(p) || p.social === null) return [];
      if (p.extractionVersion === null || p.extractionVersion < SECURE_URL_EXTRACTION) return [];
      if (!/^https:/i.test(p.url)) return [];
      const ogImage = p.social.og.image;
      if (ogImage === undefined || !/^http:/i.test(ogImage)) return [];
      const secureUrl = p.social.og["image:secure_url"];
      if (secureUrl !== undefined && /^https:/i.test(secureUrl)) return [];
      return [
        finding(self, p, secureUrl === undefined ? { ogImage } : { ogImage, secureUrl }),
      ];
    },
  ),
];

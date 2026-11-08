import type { OverlongUrls } from "../../crawl/parse/page-facts.js";
import { INDEXED_URL_MAX } from "../../crawl/parse/url-utils.js";
import { finding, isJudged, pageRule, present } from "../helpers.js";
import type { PageRule } from "../registry/types.js";
import {
  TITLE_MIN,
  TITLE_MAX,
  META_MIN,
  META_MAX,
  H1_MAX,
  H2_MAX,
  URL_MAX,
  HEADING_MAX_STEP,
} from "../thresholds.js";

/** Verdict thresholds live in `../thresholds.js`; re-exported so every existing import still resolves. */
export {
  TITLE_MIN,
  TITLE_MAX,
  META_MIN,
  META_MAX,
  H1_MAX,
  H2_MAX,
  URL_MAX,
  HEADING_MAX_STEP,
} from "../thresholds.js";

const CATEGORY = "on-page";

/** The extraction that measured `overlong_urls`; below it the column is null, "not measured". */
const OVERLONG_EXTRACTION = 3;

/** Equal after whitespace collapse and trim, ignoring case. */
function sameText(a: string, b: string): boolean {
  const norm = (v: string): string => v.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * EVERY RULE IN THIS FILE IS GATED ON `isJudged` (Phase 22 §1), not on
 * `isAuditable`: a page that is noindexed or that canonicalises to another URL
 * is not a page a search engine ranks, so a missing title, a duplicate
 * description or a broken heading outline on it is the other URL's problem or
 * nobody's. `site.health` counts both exclusions so the silence is visible.
 * One exception, Phase 26c's `url.reference-too-long`: see its comment.
 */

/**
 * The one rule in this file that is about the page's BODY rather than its head.
 * It reports under `content`, beside the cross-page content rules
 * (`content.soft-404`, `content.exact-duplicate`, `content.near-duplicate`,
 * `content.thin`), because the report groups by category and a client reading
 * the content section should find every content finding in it — placeholder
 * copy and a duplicate page are the same conversation, and the fact that one is
 * decided from a single row and the other from a join is our implementation
 * detail, not theirs.
 *
 * `content.placeholder` stays in this file: it reads a `PageRecord` and nothing
 * else, which is what makes a page rule. `content.thin` and
 * `content.thin-skipped` were beside it until Phase 19 §11 moved the
 * thin-content floor onto `main_word_count`, whose null cannot be read from one
 * row; both now live in src/rules/query/content.ts with the census that reads
 * it, and `THIN_WORDS` moved with them.
 */
const CONTENT = "content";

/**
 * The index of the first heading that is more than one level below the heading
 * before it (an h3 straight after an h1). Returns -1 when the outline steps
 * down one level at a time; going back up is not a skip.
 */
function firstLevelSkip(order: number[]): number {
  for (let i = 1; i < order.length; i++) {
    if (order[i]! - order[i - 1]! > HEADING_MAX_STEP) return i;
  }
  return -1;
}

export const onPageRules: PageRule[] = [
  pageRule(
    "title.missing",
    ["CHECK-35"],
    CATEGORY,
    "critical",
    [{ key: "title", label: "Title 1" }],
    (p, self) =>
      isJudged(p) && !present(p.title) ? [finding(self, p, { title: p.title })] : [],
  ),

  pageRule(
    "title.too-short",
    ["CHECK-35"],
    CATEGORY,
    "info",
    [
      { key: "title", label: "Title 1" },
      { key: "length", label: "Title 1 Length" },
      { key: "min", label: "Minimum Length" },
    ],
    (p, self) =>
      isJudged(p) && present(p.title) && p.title.length < TITLE_MIN
        ? [finding(self, p, { title: p.title, length: p.title.length, min: TITLE_MIN })]
        : [],
  ),

  pageRule(
    "title.too-long",
    ["CHECK-35"],
    CATEGORY,
    "info",
    [
      { key: "title", label: "Title 1" },
      { key: "length", label: "Title 1 Length" },
      { key: "max", label: "Maximum Length" },
    ],
    (p, self) =>
      isJudged(p) && present(p.title) && p.title.length > TITLE_MAX
        ? [finding(self, p, { title: p.title, length: p.title.length, max: TITLE_MAX })]
        : [],
  ),

  pageRule(
    "meta-description.missing",
    ["CHECK-36"],
    CATEGORY,
    "warning",
    [{ key: "metaDescription", label: "Meta Description 1" }],
    (p, self) =>
      isJudged(p) && !present(p.metaDescription)
        ? [finding(self, p, { metaDescription: p.metaDescription })]
        : [],
  ),

  pageRule(
    "meta-description.too-short",
    ["CHECK-36"],
    CATEGORY,
    "info",
    [
      { key: "metaDescription", label: "Meta Description 1" },
      { key: "length", label: "Meta Description 1 Length" },
      { key: "min", label: "Minimum Length" },
    ],
    (p, self) =>
      isJudged(p) && present(p.metaDescription) && p.metaDescription.length < META_MIN
        ? [
            finding(self, p, {
              metaDescription: p.metaDescription,
              length: p.metaDescription.length,
              min: META_MIN,
            }),
          ]
        : [],
  ),

  pageRule(
    "meta-description.too-long",
    ["CHECK-36"],
    CATEGORY,
    "info",
    [
      { key: "metaDescription", label: "Meta Description 1" },
      { key: "length", label: "Meta Description 1 Length" },
      { key: "max", label: "Maximum Length" },
    ],
    (p, self) =>
      isJudged(p) && present(p.metaDescription) && p.metaDescription.length > META_MAX
        ? [
            finding(self, p, {
              metaDescription: p.metaDescription,
              length: p.metaDescription.length,
              max: META_MAX,
            }),
          ]
        : [],
  ),

  pageRule(
    "headings.h1-missing",
    ["CHECK-37"],
    CATEGORY,
    "warning",
    [{ key: "h1Count", label: "H1 Count" }],
    (p, self) =>
      isJudged(p) && p.h1Count === 0 ? [finding(self, p, { h1Count: p.h1Count })] : [],
  ),

  pageRule(
    "headings.h1-multiple",
    ["CHECK-37"],
    CATEGORY,
    "info",
    [{ key: "h1Count", label: "H1 Count" }],
    (p, self) =>
      isJudged(p) && p.h1Count > 1 ? [finding(self, p, { h1Count: p.h1Count })] : [],
  ),

  pageRule(
    "headings.level-skip",
    ["CHECK-37"],
    CATEGORY,
    "info",
    [
      { key: "skipAt", label: "Skips At" },
      { key: "headingOrder", label: "Heading Order" },
    ],
    (p, self) => {
      if (!isJudged(p) || p.headingOrder === null) return [];
      // `skipAt` indexes into `headingOrder`: the position of the heading that
      // skipped a level. Only the first skip is reported — one finding per page.
      const skipAt = firstLevelSkip(p.headingOrder);
      return skipAt === -1
        ? []
        : [finding(self, p, { headingOrder: p.headingOrder, skipAt })];
    },
  ),

  pageRule(
    "headings.h1-too-long",
    ["CHECK-37"],
    CATEGORY,
    "info",
    [
      { key: "h1Text", label: "H1-1" },
      { key: "length", label: "H1-1 Length" },
      { key: "max", label: "Maximum Length" },
    ],
    // `h1Text` is the analyzer's capped text (300 characters), so a longer H1
    // reports 300; null (no H1, or a pre-Phase-7 row) is silent.
    (p, self) =>
      isJudged(p) && present(p.h1Text) && p.h1Text.length > H1_MAX
        ? [finding(self, p, { h1Text: p.h1Text, length: p.h1Text.length, max: H1_MAX })]
        : [],
  ),

  pageRule(
    "h2.missing",
    ["CHECK-37"],
    CATEGORY,
    "info",
    [{ key: "h2Count", label: "H2 Count" }],
    // `h2_count` predates extraction 2, so this judges every crawl (deviation 1).
    (p, self) =>
      isJudged(p) && p.h2Count === 0 ? [finding(self, p, { h2Count: p.h2Count })] : [],
  ),

  pageRule(
    "h2.too-long",
    ["CHECK-37"],
    CATEGORY,
    "info",
    [
      { key: "h2Text", label: "H2-1" },
      { key: "length", label: "H2-1 Length" },
      { key: "max", label: "Maximum Length" },
    ],
    // `h2Text` is the first H2's collapsed, capped text; null (no H2, or a v1
    // row) is silent.
    (p, self) =>
      isJudged(p) && present(p.h2Text) && p.h2Text.length > H2_MAX
        ? [finding(self, p, { h2Text: p.h2Text, length: p.h2Text.length, max: H2_MAX })]
        : [],
  ),

  pageRule(
    "title.multiple",
    ["CHECK-35"],
    CATEGORY,
    "warning",
    [{ key: "titleCount", label: "Title Elements" }],
    // Null is a row extraction 1 wrote: not measured, and silent.
    (p, self) =>
      isJudged(p) && p.titleCount !== null && p.titleCount > 1
        ? [finding(self, p, { titleCount: p.titleCount })]
        : [],
  ),

  pageRule(
    "meta-description.multiple",
    ["CHECK-36"],
    CATEGORY,
    "warning",
    [{ key: "metaDescriptionCount", label: "Meta Description Elements" }],
    (p, self) =>
      isJudged(p) && p.metaDescriptionCount !== null && p.metaDescriptionCount > 1
        ? [finding(self, p, { metaDescriptionCount: p.metaDescriptionCount })]
        : [],
  ),

  pageRule(
    "title.same-as-h1",
    ["CHECK-35"],
    CATEGORY,
    "info",
    [
      { key: "title", label: "Title 1" },
      { key: "h1Text", label: "H1-1" },
    ],
    // Whitespace collapsed, trimmed, case-insensitive. Both columns predate
    // extraction 2, so every crawl is judged (deviation 1).
    (p, self) =>
      isJudged(p) && present(p.title) && present(p.h1Text) && sameText(p.title, p.h1Text)
        ? [finding(self, p, { title: p.title, h1Text: p.h1Text })]
        : [],
  ),

  pageRule(
    "url.too-long",
    ["CHECK-28"],
    "url",
    "info",
    [
      { key: "length", label: "URL Length" },
      { key: "max", label: "Maximum Length" },
    ],
    (p, self) =>
      isJudged(p) && p.url.length > URL_MAX
        ? [finding(self, p, { length: p.url.length, max: URL_MAX })]
        : [],
  ),

  /**
   * References this page made that are too long to index (Phase 26c): links,
   * files and hreflang targets whose resolved URL is over `INDEXED_URL_MAX`.
   * The crawler counted them and stored none (`pages.overlong_urls`), so
   * nothing behind them was crawled or checked.
   *
   * THE ONE RULE IN THIS FILE NOT GATED ON `isJudged`. An over-long reference
   * was never followed whatever the page's index status, and the column says
   * itself when there is something to judge: it is written on every row whose
   * response was classified (the analyzer's counts, plus the `Link` header's
   * hreflang targets on any row, a PDF included: Task 6), null where no
   * response was classified. A v2 row (null, never measured)
   * is silent; `extraction.not-recorded` speaks for it. A v3 count object
   * missing a key is a defect in the write, and loud: re-crawl.
   */
  pageRule(
    "url.reference-too-long",
    ["CHECK-28"],
    "url",
    "warning",
    [
      { key: "links", label: "Links Over Limit" },
      { key: "resources", label: "Files Over Limit" },
      { key: "hreflang", label: "Hreflang Targets Over Limit" },
      { key: "max", label: "Maximum Length" },
    ],
    (p, self) => {
      if (p.extractionVersion === null || p.extractionVersion < OVERLONG_EXTRACTION) return [];
      const counts = p.overlongUrls;
      if (counts === null) return [];
      for (const key of ["links", "resources", "hreflang"] as const) {
        // jsonb is not checked against the type.
        if (typeof (counts as Partial<OverlongUrls>)[key] !== "number") {
          throw new Error(
            `${self.id}: page ${p.url} has overlong_urls without '${key}' ` +
              `(extraction ${p.extractionVersion}); re-crawl`,
          );
        }
      }
      if (counts.links + counts.resources + counts.hreflang === 0) return [];
      return [
        finding(self, p, {
          links: counts.links,
          resources: counts.resources,
          hreflang: counts.hreflang,
          max: INDEXED_URL_MAX,
        }),
      ];
    },
  ),

  /**
   * Placeholder copy still in the live page, WITH THE SENTENCE IT SITS IN
   * (Phase 19 §3).
   *
   * The finding used to carry `{wordCount}` and nothing else, and the crawl that
   * provoked the phase showed what that costs: it fired on three blog posts of a
   * thousand words each, all of them genuinely carrying "lorem ipsum" — in the
   * post's excerpt and its `description` meta, shown on the listing page and in
   * every related-post card. A true finding, and a reader given a URL and a word
   * count had no way to find the words. `snippet` is the analyzer's quotation of
   * up to 160 characters around the first match, so the evidence names the thing
   * it is about.
   *
   * `snippet` is `null` on a pre-0018 row: the flag was stored, the quotation
   * was not, and the text is gone. The evidence SAYS null rather than omitting
   * the key or inventing a sentence — the finding is still true and still worth
   * reporting, and a reader meeting a null learns the honest thing, which is
   * that this crawl cannot show them where. There is no marker here for the same
   * reason: nothing is unmeasured. The check ran, the answer is yes, and only
   * the quotation is missing.
   */
  pageRule(
    "content.placeholder",
    ["CHECK-40"],
    CONTENT,
    "critical",
    [
      { key: "snippet", label: "Placeholder Text" },
      { key: "wordCount", label: "Word Count" },
    ],
    (p, self) =>
      isJudged(p) && p.hasLoremIpsum
        ? [finding(self, p, { wordCount: p.wordCount, snippet: p.placeholderSnippet })]
        : [],
  ),
];

import { finding, isJudged, pageRule, present } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

/**
 * Thresholds. Exported because the client-facing copy quotes them and a test
 * asserts the prose against these constants: change one here and the copy test
 * fails until the sentence is changed with it.
 */
export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const META_MIN = 70;
export const META_MAX = 155;
export const H1_MAX = 70;
/** Measured on the stored `url` string, as crawled, not a normalised form. */
export const URL_MAX = 115;
/**
 * The largest step a heading outline may take downwards: H2 to H3 is 1 and
 * fine, H2 to H4 is 2 and is the skip `headings.level-skip` reports. Exported
 * because the client-facing title states the number and the copy rubric pins
 * the two together (Phase 19 §7).
 */
export const HEADING_MAX_STEP = 1;

const CATEGORY = "on-page";

/**
 * EVERY RULE IN THIS FILE IS GATED ON `isJudged` (Phase 22 §1), not on
 * `isAuditable`: a page that is noindexed or that canonicalises to another URL
 * is not a page a search engine ranks, so a missing title, a duplicate
 * description or a broken heading outline on it is the other URL's problem or
 * nobody's. `site.health` counts both exclusions so the silence is visible.
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

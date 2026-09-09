import { finding, isAuditable, pageRule, present } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

/**
 * Thresholds. Exported because the client-facing copy quotes them and a test
 * asserts the prose against these constants: change one here and the copy test
 * fails until the sentence is changed with it.
 */
export const TITLE_MIN = 10;
export const TITLE_MAX = 60;
export const META_MIN = 70;
export const META_MAX = 160;
export const THIN_WORDS = 150;

const CATEGORY = "on-page";

/**
 * The two rules in this file that are about the page's BODY rather than its
 * head. They report under `content`, beside the cross-page content rules
 * (`content.soft-404`, `content.exact-duplicate`, `content.near-duplicate`),
 * because the report groups by category and a client reading the content
 * section should find every content finding in it — a thin page and a duplicate
 * page are the same conversation, and the fact that one is decided from a
 * single row and the other from a join is our implementation detail, not theirs.
 *
 * They stay in this file: they read a `PageRecord` and nothing else, which is
 * what makes a page rule, and moving them would only put the same code under a
 * different name.
 */
const CONTENT = "content";

/**
 * The index of the first heading that is more than one level below the heading
 * before it (an h3 straight after an h1). Returns -1 when the outline steps
 * down one level at a time; going back up is not a skip.
 */
function firstLevelSkip(order: number[]): number {
  for (let i = 1; i < order.length; i++) {
    if (order[i]! - order[i - 1]! > 1) return i;
  }
  return -1;
}

export const onPageRules: PageRule[] = [
  pageRule("title.missing", ["CHECK-35"], CATEGORY, "critical", (p, self) =>
    isAuditable(p) && !present(p.title) ? [finding(self, p, { title: p.title })] : [],
  ),

  pageRule("title.too-short", ["CHECK-35"], CATEGORY, "info", (p, self) =>
    isAuditable(p) && present(p.title) && p.title.length < TITLE_MIN
      ? [finding(self, p, { title: p.title, length: p.title.length, min: TITLE_MIN })]
      : [],
  ),

  pageRule("title.too-long", ["CHECK-35"], CATEGORY, "info", (p, self) =>
    isAuditable(p) && present(p.title) && p.title.length > TITLE_MAX
      ? [finding(self, p, { title: p.title, length: p.title.length, max: TITLE_MAX })]
      : [],
  ),

  pageRule("meta-description.missing", ["CHECK-36"], CATEGORY, "warning", (p, self) =>
    isAuditable(p) && !present(p.metaDescription)
      ? [finding(self, p, { metaDescription: p.metaDescription })]
      : [],
  ),

  pageRule("meta-description.too-short", ["CHECK-36"], CATEGORY, "info", (p, self) =>
    isAuditable(p) && present(p.metaDescription) && p.metaDescription.length < META_MIN
      ? [
          finding(self, p, {
            metaDescription: p.metaDescription,
            length: p.metaDescription.length,
            min: META_MIN,
          }),
        ]
      : [],
  ),

  pageRule("meta-description.too-long", ["CHECK-36"], CATEGORY, "info", (p, self) =>
    isAuditable(p) && present(p.metaDescription) && p.metaDescription.length > META_MAX
      ? [
          finding(self, p, {
            metaDescription: p.metaDescription,
            length: p.metaDescription.length,
            max: META_MAX,
          }),
        ]
      : [],
  ),

  pageRule("headings.h1-missing", ["CHECK-37"], CATEGORY, "warning", (p, self) =>
    isAuditable(p) && p.h1Count === 0 ? [finding(self, p, { h1Count: p.h1Count })] : [],
  ),

  pageRule("headings.h1-multiple", ["CHECK-37"], CATEGORY, "info", (p, self) =>
    isAuditable(p) && p.h1Count > 1 ? [finding(self, p, { h1Count: p.h1Count })] : [],
  ),

  pageRule("headings.level-skip", ["CHECK-37"], CATEGORY, "info", (p, self) => {
    if (!isAuditable(p) || p.headingOrder === null) return [];
    // `skipAt` indexes into `headingOrder`: the position of the heading that
    // skipped a level. Only the first skip is reported — one finding per page.
    const skipAt = firstLevelSkip(p.headingOrder);
    return skipAt === -1
      ? []
      : [finding(self, p, { headingOrder: p.headingOrder, skipAt })];
  }),

  /**
   * The thin-content floor, read off `renderable_word_count` and NOT off
   * `word_count` (Phase 7, P7-T1).
   *
   * The two columns answer different questions. `word_count` is how many words
   * the server sent; `renderable_word_count` is how many of those the page's
   * own markup does not say are hidden. A floor exists to ask "is there enough
   * here for a reader", so it has to read the second: the diagnosis behind the
   * change found a real home page whose honest visible content was 281 words
   * while its raw count said 1,139, because ~740 words of mega-menu, currency
   * picker and closed accordion ship on every page of that site. The error is
   * near-constant per template, so it is worst exactly where this rule matters
   * most — on the thinnest pages.
   *
   * Both numbers travel in the evidence. An action plan that says "94 words a
   * reader can reach, out of 830 in the HTML" is a sentence someone can act
   * on; either number alone invites the wrong fix.
   */
  pageRule("content.thin", ["CHECK-40", "CHECK-13"], CONTENT, "warning", (p, self) =>
    isAuditable(p) &&
    p.isIndexable === true &&
    p.renderableWordCount !== null &&
    p.renderableWordCount < THIN_WORDS
      ? [
          finding(self, p, {
            renderableWordCount: p.renderableWordCount,
            wordCount: p.wordCount,
            threshold: THIN_WORDS,
          }),
        ]
      : [],
  ),

  /**
   * The page `content.thin` could not judge, said out loud.
   *
   * A row with a `word_count` and no `renderable_word_count` was written by a
   * pre-Phase-7 analyzer: the page WAS read, and the column the floor now needs
   * did not exist yet. There are exactly two honest things to do with it, and
   * falling back to `word_count` is neither — that column measures a different
   * quantity (see the rule above), so a fallback would answer the thin-content
   * question with a number that is four times the truth on a chrome-heavy site
   * and would do it silently, on old crawls only, where nobody would look.
   *
   * So the page is SKIPPED and the skip is a finding, on the
   * `robots.check-skipped` / `links.orphan-skipped` precedent: its own id, its
   * own copy, `info` severity, and the crawl named as the reason. Re-crawling
   * is the fix, because a word count cannot be recomputed from a database that
   * does not store the HTML.
   *
   * The guard is `word_count !== null` and not `isAuditable` alone, and that is
   * the whole precision of this rule: a 200 that served a PDF has no analysis
   * and stores null in BOTH columns, which is not a skipped check — it is a
   * page with no text evidence, which `content.thin` was always silent about.
   */
  pageRule(
    "content.thin-skipped",
    ["CHECK-40", "CHECK-13"],
    CONTENT,
    "info",
    (p, self) =>
      isAuditable(p) &&
      p.isIndexable === true &&
      p.wordCount !== null &&
      p.renderableWordCount === null
        ? [finding(self, p, { wordCount: p.wordCount, threshold: THIN_WORDS })]
        : [],
    "the page the corrected thin-content floor cannot judge",
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
  pageRule("content.placeholder", ["CHECK-40"], CONTENT, "critical", (p, self) =>
    isAuditable(p) && p.hasLoremIpsum
      ? [finding(self, p, { wordCount: p.wordCount, snippet: p.placeholderSnippet })]
      : [],
  ),
];

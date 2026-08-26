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
  pageRule("title.missing", ["CHECK-35"], CATEGORY, "warning", (p, self) =>
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

  pageRule("content.thin", ["CHECK-40", "CHECK-13"], CONTENT, "warning", (p, self) =>
    isAuditable(p) && p.isIndexable === true && p.wordCount !== null && p.wordCount < THIN_WORDS
      ? [finding(self, p, { wordCount: p.wordCount, threshold: THIN_WORDS })]
      : [],
  ),

  pageRule("content.placeholder", ["CHECK-40"], CONTENT, "warning", (p, self) =>
    isAuditable(p) && p.hasLoremIpsum ? [finding(self, p, { wordCount: p.wordCount })] : [],
  ),
];

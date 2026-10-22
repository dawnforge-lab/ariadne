import { finding, isAuditable, isJudged, pageRule } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";

/**
 * The outside-head family (Phase 23 T5, study §4.1): head elements that appear
 * AFTER the point where the HTML tree builder ended the `<head>` — at `</head>`,
 * at `<body>`, or implicitly at the first element a head does not allow or the
 * first non-whitespace text. The analyzer runs that state machine over the token
 * stream (src/crawl/parse/page-analyzer.ts, module header's Phase 23 block) and
 * writes five flags and the closer (migration 0021).
 *
 * NULL IS NOT MEASURED. Every flag is null on a pre-0021 row, and both rules
 * fire only on an explicit `true` (or a positive count), so an old crawl
 * re-judged here is silent rather than clean-by-default.
 *
 * The extracted VALUES are not touched: `canonical_html`, `robots_meta`,
 * `title` and the hreflang pairs are still the first occurrence anywhere in the
 * document. Whether a canonical outside the head should stop counting as the
 * page's canonical is a verdict on indexability and waits for an owner ruling;
 * these rules report the placement and nothing else.
 */

/**
 * The "Closed By" column. Null on a 0021 row means `</head>` closed the head
 * explicitly (or it never closed, in which case nothing is outside it and no
 * finding is written), so the column shows that end tag rather than a blank.
 */
function closedBy(p: PageRecord): string {
  return p.headClosedBy ?? "</head>";
}

/** The directives outside the head, in a fixed order, as one column value. */
function directivesOutside(p: PageRecord): string[] {
  const out: string[] = [];
  if (p.canonicalOutsideHead === true) out.push("canonical");
  if (p.robotsOutsideHead === true) out.push("robots");
  const hreflang = p.hreflangOutsideHeadCount;
  if (hreflang !== null && hreflang > 0) out.push(`hreflang (${hreflang})`);
  return out;
}

function tagsOutside(p: PageRecord): string[] {
  const out: string[] = [];
  if (p.titleOutsideHead === true) out.push("title");
  if (p.metaDescriptionOutsideHead === true) out.push("meta description");
  return out;
}

const COLUMNS = [
  { key: "elements", label: "Elements Outside Head" },
  { key: "headClosedBy", label: "Closed By" },
] as const;

export const headRules: PageRule[] = [
  // THE FETCHED-OK COHORT (`isAuditable`), like `canonical.*` and
  // `indexability.*`, and NOT `isJudged`: a robots meta or a canonical outside
  // the head is exactly the kind of thing that makes a page non-indexable or
  // canonicalised elsewhere, so the judged cohort would hide the pages this
  // rule exists to report.
  pageRule(
    "head.directives-outside-head",
    ["CHECK-18", "CHECK-04", "CHECK-24"],
    "indexability",
    "critical",
    COLUMNS,
    (p, self) => {
      if (!isAuditable(p)) return [];
      const elements = directivesOutside(p);
      return elements.length > 0
        ? [finding(self, p, { elements: elements.join(", "), headClosedBy: closedBy(p) })]
        : [];
    },
  ),

  // THE JUDGED COHORT (`isJudged`), with the other title and description rules:
  // where a title sits matters on a page that is meant to be in the index.
  pageRule(
    "head.tags-outside-head",
    ["CHECK-35", "CHECK-36"],
    "on-page",
    "warning",
    COLUMNS,
    (p, self) => {
      if (!isJudged(p)) return [];
      const elements = tagsOutside(p);
      return elements.length > 0
        ? [finding(self, p, { elements: elements.join(", "), headClosedBy: closedBy(p) })]
        : [];
    },
  ),
];

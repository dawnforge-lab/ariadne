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
 * FIRST OCCURRENCE: the title, description, robots and canonical flags are true
 * only when the FIRST such tag in the document — the one the stored value is
 * read from — came after the head ended. A correct in-head canonical followed by
 * a stray body copy is not reported here (`canonical.multiple` reports the
 * copy). The hreflang column is a count of every alternate outside the head.
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
 * The "Closed By" column, spelled for a reader (controller ruling, fix round
 * 1): an element closer in angle brackets (`<img>`, `<div>`, `<body>`), the
 * text closer as `text`, and an end tag as written (`</html>`). Null on a 0021
 * row means `</head>` closed the head explicitly (or it never closed, in which
 * case nothing is outside it and no finding is written), so the column shows
 * that end tag rather than a blank. The stored column keeps the analyzer's
 * spelling (`img`, `#text`); this is display only.
 */
export function closedByLabel(stored: string | null): string {
  if (stored === null) return "</head>";
  if (stored === "#text") return "text";
  if (stored.startsWith("</")) return stored;
  return `<${stored}>`;
}

function closedBy(p: PageRecord): string {
  return closedByLabel(p.headClosedBy);
}

/** The directives outside the head, in a fixed order, as one column value. */
function directivesOutside(p: PageRecord): string[] {
  const out: string[] = [];
  if (p.canonicalOutsideHead === true) out.push("canonical");
  if (p.robotsOutsideHead === true) out.push("meta robots");
  const hreflang = p.hreflangOutsideHeadCount;
  if (hreflang !== null && hreflang > 0) out.push(`hreflang (${hreflang})`);
  return out;
}

function tagsOutside(p: PageRecord): string[] {
  const out: string[] = [];
  if (p.titleOutsideHead === true) out.push("title");
  if (p.metaDescriptionOutsideHead === true) out.push("meta description");
  // Phase 26b: ANY Open Graph or X tag met after the head ended. Null `social`
  // (a v1 row, or a v2 page with no social tag) adds nothing.
  if (p.social?.outsideHead === true) out.push("social");
  return out;
}

const COLUMNS = [
  { key: "elements", label: "Elements Outside Head" },
  { key: "headClosedBy", label: "Closed By" },
  // Phase 26b: the element the analyzer recorded as ending the head early, on a
  // v2 row that has one. Absent on a v1 row and where nothing closed it early.
  { key: "headClosedEarly", label: "Head Closed By (element)", optional: true },
] as const;

/** The optional `headClosedEarly` evidence: present only when the analyzer named a closer. */
function closedEarlyEvidence(p: PageRecord): { headClosedEarly?: { tag: string; snippet: string } } {
  const closed = p.htmlStructure?.closedEarly;
  return closed === null || closed === undefined
    ? {}
    : { headClosedEarly: { tag: closed.tag, snippet: closed.snippet } };
}

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
        ? [finding(self, p, { elements: elements.join(", "), headClosedBy: closedBy(p), ...closedEarlyEvidence(p) })]
        : [];
    },
  ),

  // THE JUDGED COHORT (`isJudged`), with the other title and description rules:
  // where a title sits matters on a page that is meant to be in the index.
  // CHECK-87 since Phase 26b: social tags outside the head are this rule's
  // finding, and "tags placed in the head" is part of that check.
  pageRule(
    "head.tags-outside-head",
    ["CHECK-35", "CHECK-36", "CHECK-87"],
    "on-page",
    "warning",
    COLUMNS,
    (p, self) => {
      if (!isJudged(p)) return [];
      const elements = tagsOutside(p);
      return elements.length > 0
        ? [finding(self, p, { elements: elements.join(", "), headClosedBy: closedBy(p), ...closedEarlyEvidence(p) })]
        : [];
    },
  ),
];

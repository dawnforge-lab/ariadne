import { finding, isJudged, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";
import { SLOW_MS } from "../thresholds.js";

/** Verdict thresholds live in `../thresholds.js`; re-exported so every existing import still resolves. */
export { SLOW_MS } from "../thresholds.js";

/**
 * All four report under one heading. `RuleCategory` is the report's grouping,
 * not a per-rule label: a "mobile" category with one rule in it is a section of
 * one, and the client-facing question these four answer is the same one — how
 * the page is built and served.
 *
 * `structure.deep-page` used to be the fifth. It left for src/rules/query/
 * link-graph.ts in Phase 9, keeping the category so the report is unchanged:
 * the depth it reports is `pages.click_depth`, which a derivation writes AFTER
 * the page cursor has run, so a page rule could only ever read last run's value
 * or null.
 */
const CATEGORY = "technical";

/**
 * ALL FOUR ARE GATED ON `isJudged` (Phase 22 §1): a missing viewport, an
 * undescribed image or a slow response on a page that is noindexed or
 * canonicalised elsewhere is a fact about a URL nothing ranks. The template it
 * came from is reported through the judged pages that share it.
 */

/**
 * The bonus technical rules: signals the analyzer already extracts that trace
 * to checklist items outside the 47 crawl-derived checks. Each one states a
 * fact about the page — an absent tag, a count, a measured number — and leaves
 * the judgement to the agent, which is why three of the four are `info`.
 */
export const technicalRules: PageRule[] = [
  // Fires only on the absence of the tag. Nothing here inspects the contents of
  // a viewport that does exist, and the copy must not claim otherwise.
  pageRule(
    "mobile.viewport-missing",
    ["CHECK-52"],
    CATEGORY,
    "critical",
    [],
    (p, self) =>
      isJudged(p) && !p.hasViewport ? [finding(self, p, {})] : [],
  ),

  // A count of <img> elements missing a width or height attribute. CSS may
  // already be reserving the space, so this is the attribute's absence, not
  // proven layout shift — `imagesTotal` rides along so the report can say
  // "3 of 8" rather than a bare number.
  pageRule(
    "images.missing-dimensions",
    ["CHECK-49"],
    CATEGORY,
    "info",
    [
      { key: "imagesMissingDimensions", label: "Images Missing Dimensions" },
      { key: "imagesTotal", label: "Images" },
    ],
    (p, self) =>
      isJudged(p) && p.imagesMissingDimensions > 0
        ? [
            finding(self, p, {
              imagesMissingDimensions: p.imagesMissingDimensions,
              imagesTotal: p.imagesTotal,
            }),
          ]
        : [],
  ),

  // An absent alt attribute — not an empty one, which is the correct value for
  // a decorative image and is counted as present by the analyzer.
  pageRule(
    "images.missing-alt",
    ["CHECK-49"],
    CATEGORY,
    "warning",
    [
      { key: "imagesMissingAlt", label: "Images Missing Alt Text" },
      { key: "imagesTotal", label: "Images" },
    ],
    (p, self) =>
      isJudged(p) && p.imagesMissingAlt > 0
        ? [finding(self, p, { imagesMissingAlt: p.imagesMissingAlt, imagesTotal: p.imagesTotal })]
        : [],
  ),

  // One measurement of one fetch, from this machine, on this crawl. A null is
  // an unrecorded timing, not a fast one: firing on it would be reporting a
  // number the crawl does not have.
  pageRule(
    "performance.slow-response",
    ["CHECK-50"],
    CATEGORY,
    "warning",
    [
      { key: "responseTimeMs", label: "Response Time (ms)" },
      { key: "threshold", label: "Threshold (ms)" },
    ],
    (p, self) =>
      isJudged(p) && p.responseTimeMs !== null && p.responseTimeMs > SLOW_MS
        ? [finding(self, p, { responseTimeMs: p.responseTimeMs, threshold: SLOW_MS })]
        : [],
  ),
];

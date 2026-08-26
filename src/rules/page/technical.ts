import { finding, isAuditable, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

/**
 * Thresholds. Exported because the client-facing copy quotes them and a test
 * asserts the prose against these constants: change one here and the copy test
 * fails until the sentence is changed with it.
 */
/** Time to first byte, in ms, above which the response is reported as slow. */
export const SLOW_MS = 1500;
/** Click depth from the seed above which the page is reported as buried. */
export const DEEP_DEPTH = 5;

/**
 * The bonus technical rules: signals the analyzer already extracts that trace
 * to checklist items outside the 47 crawl-derived checks. Each one states a
 * fact about the page — an absent tag, a count, a measured number — and leaves
 * the judgement to the agent, which is why four of the five are `info`.
 */
export const technicalRules: PageRule[] = [
  // Fires only on the absence of the tag. Nothing here inspects the contents of
  // a viewport that does exist, and the copy must not claim otherwise.
  pageRule("mobile.viewport-missing", ["CHECK-52"], "mobile", "warning", (p, self) =>
    isAuditable(p) && !p.hasViewport ? [finding(self, p, {})] : [],
  ),

  // A count of <img> elements missing a width or height attribute. CSS may
  // already be reserving the space, so this is the attribute's absence, not
  // proven layout shift — `imagesTotal` rides along so the report can say
  // "3 of 8" rather than a bare number.
  pageRule("images.missing-dimensions", ["CHECK-49"], "images", "info", (p, self) =>
    isAuditable(p) && p.imagesMissingDimensions > 0
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
  pageRule("images.missing-alt", ["CHECK-49"], "images", "info", (p, self) =>
    isAuditable(p) && p.imagesMissingAlt > 0
      ? [finding(self, p, { imagesMissingAlt: p.imagesMissingAlt, imagesTotal: p.imagesTotal })]
      : [],
  ),

  // One measurement of one fetch, from this machine, on this crawl. A null is
  // an unrecorded timing, not a fast one: firing on it would be reporting a
  // number the crawl does not have.
  pageRule("performance.slow-response", ["CHECK-50"], "performance", "info", (p, self) =>
    isAuditable(p) && p.responseTimeMs !== null && p.responseTimeMs > SLOW_MS
      ? [finding(self, p, { responseTimeMs: p.responseTimeMs, threshold: SLOW_MS })]
      : [],
  ),

  // Depth is the shortest path the crawl actually took from its seed, so it is
  // relative to where the crawl started rather than to the site's home page.
  pageRule("structure.deep-page", ["CHECK-31"], "structure", "info", (p, self) =>
    isAuditable(p) && p.depth > DEEP_DEPTH
      ? [finding(self, p, { depth: p.depth, threshold: DEEP_DEPTH })]
      : [],
  ),
];

import { finding, isAuditable, isJudged, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";
import { IMAGE_ALT_MAX, SLOW_MS } from "../thresholds.js";

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
 * EVERY RULE HERE EXCEPT `security.form-insecure` IS GATED ON `isJudged` (Phase 22 §1;
 * the form rule is a fault of any auditable page, so it uses `isAuditable`): a missing viewport, an
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
      // The raw `src` of the first images with no alt (26b). Absent on a v1 row,
      // whose sample column is null: "not recorded", never an empty list.
      { key: "sample", label: "Images Missing Alt (sample)", optional: true },
    ],
    (p, self) =>
      isJudged(p) && p.imagesMissingAlt > 0
        ? [
            finding(self, p, {
              imagesMissingAlt: p.imagesMissingAlt,
              imagesTotal: p.imagesTotal,
              ...(p.imagesMissingAltSample !== null ? { sample: p.imagesMissingAltSample } : {}),
            }),
          ]
        : [],
  ),

  // `alt=""` (after trimming) is the right value for a decorative image, so
  // this is a count to review, not a fault: info, and a v1 row (null) is silent.
  pageRule(
    "images.empty-alt",
    ["CHECK-49"],
    CATEGORY,
    "info",
    [
      { key: "imagesEmptyAlt", label: "Images With Empty Alt Text" },
      { key: "imagesTotal", label: "Images" },
    ],
    (p, self) =>
      isJudged(p) && p.imagesEmptyAlt !== null && p.imagesEmptyAlt > 0
        ? [finding(self, p, { imagesEmptyAlt: p.imagesEmptyAlt, imagesTotal: p.imagesTotal })]
        : [],
  ),

  // The threshold is applied at extraction (`ALT_TEXT_LONG_CHARS`), so `max`
  // here is the value the stored count was taken against.
  pageRule(
    "images.alt-too-long",
    ["CHECK-49"],
    CATEGORY,
    "info",
    [
      { key: "imagesAltTooLong", label: "Images With Over-long Alt Text" },
      { key: "max", label: "Alt Text Limit (characters)" },
    ],
    (p, self) =>
      isJudged(p) && p.imagesAltTooLong !== null && p.imagesAltTooLong > 0
        ? [finding(self, p, { imagesAltTooLong: p.imagesAltTooLong, max: IMAGE_ALT_MAX })]
        : [],
  ),

  // A form on an HTTP page, or a form on an HTTPS page that posts to an http:
  // action. Both send what the visitor types in the clear. The cohort is every
  // auditable page (a form is a fault whether or not the page ranks), and a v1
  // row (null `insecureRefs`) is silent: the extraction marker speaks.
  pageRule(
    "security.form-insecure",
    ["CHECK-85"],
    CATEGORY,
    "warning",
    [
      { key: "pageScheme", label: "Page Scheme" },
      { key: "formAction", label: "Forms With HTTP Action", optional: true },
      { key: "forms", label: "Forms" },
      { key: "sample", label: "Insecure Form Actions (sample)", optional: true },
    ],
    (p, self) => {
      if (!isAuditable(p) || p.insecureRefs === null) return [];
      const refs = p.insecureRefs;
      const https = p.url.startsWith("https:");
      const http = p.url.startsWith("http:");
      const fires = (https && refs.formAction > 0) || (http && refs.forms > 0);
      if (!fires) return [];
      const formSample = refs.sample.filter((e) => e.kind === "form").map((e) => e.url);
      return [
        finding(self, p, {
          pageScheme: https ? "https" : "http",
          ...(refs.formAction > 0 ? { formAction: refs.formAction } : {}),
          forms: refs.forms,
          ...(formSample.length > 0 ? { sample: formSample } : {}),
        }),
      ];
    },
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

import { Registry } from "./registry/registry.js";
import { contentMetrics } from "./metric/content-metrics.js";
import { crawlMetrics } from "./metric/crawl-metrics.js";
import { healthMetrics } from "./metric/health-metrics.js";
import { hreflangMetrics } from "./metric/hreflang-metrics.js";
import { linkMetrics } from "./metric/link-metrics.js";
import { renderMetrics } from "./metric/render-metrics.js";
import { urlMetrics } from "./metric/url-metrics.js";
import { onPageRules } from "./page/on-page.js";
import { statusRules } from "./page/status.js";
import { canonicalRules } from "./page/canonical.js";
import { indexabilityRules } from "./page/indexability.js";
import { technicalRules } from "./page/technical.js";
import { contentRules } from "./query/content.js";
import { fieldDuplicateRules } from "./query/field-duplicates.js";
import { hostRules } from "./query/host.js";
import { hreflangRules } from "./query/hreflang.js";
import { linkGraphRules } from "./query/link-graph.js";
import { linkTargetRules } from "./query/link-targets.js";
import { paginationRules } from "./query/pagination.js";
import { redirectRules } from "./query/redirects.js";
import { renderDiffRules } from "./query/render-diff.js";
import { renderRedirectRules } from "./query/render-redirect.js";
import { robotsRules } from "./query/robots.js";
import { sitemapRules } from "./query/sitemap.js";
import { structuredDataRules } from "./query/structured-data.js";
import { urlHygieneRules } from "./query/url-hygiene.js";

/**
 * The ruleset: every rule the engine ships, registered in one place.
 *
 * `register` runs `defineRule` on each rule, so a malformed rule or a rule
 * missing client-facing copy throws here — at build time, before a crawl —
 * rather than producing a finding no one can read.
 */
export function buildRegistry(): Registry {
  const r = new Registry();
  for (const rule of [
    ...onPageRules,
    ...statusRules,
    ...canonicalRules,
    ...indexabilityRules,
    ...technicalRules,
    ...hreflangRules,
    ...redirectRules,
    ...linkTargetRules,
    ...linkGraphRules,
    ...paginationRules,
    ...robotsRules,
    ...sitemapRules,
    ...urlHygieneRules,
    ...hostRules,
    ...contentRules,
    // The field-level duplicates: one title, one meta description or one H1
    // shared across pages. Query-kind like the content duplicates beside them,
    // and for the same reason — "is this value unique on this site" is a
    // question about the crawl, which no page rule is handed.
    ...fieldDuplicateRules,
    ...structuredDataRules,
    // The render pass's query rules: the three diffs between the raw HTML and
    // the rendered DOM, and the JavaScript redirect. Registered here with the
    // other query rules because that is what they are — they read stored
    // columns and nothing else; the render pass that filled those columns is a
    // separate stage of the crawl (src/crawl/render), not part of a rule.
    ...renderDiffRules,
    ...renderRedirectRules,
    // The metric kind. Registered in the same list because a rule is a rule to
    // the registry — the runner is what tells the kinds apart, driving these
    // last, after everything that writes evidence.
    ...linkMetrics,
    ...contentMetrics,
    ...hreflangMetrics,
    ...urlMetrics,
    ...crawlMetrics,
    ...renderMetrics,
    // The health rollup, last among the metrics because it is the only one that
    // measures the RUN rather than the site: it counts the findings the rules
    // above it have just written. The runner drives the metric phase after both
    // finding phases, so those rows are complete by the time it counts them —
    // the same phase-order coupling `redirect.volume` documents.
    ...healthMetrics,
  ]) {
    r.register(rule);
  }
  return r;
}

import { Registry } from "./registry/registry.js";
import { contentMetrics } from "./metric/content-metrics.js";
import { hreflangMetrics } from "./metric/hreflang-metrics.js";
import { linkMetrics } from "./metric/link-metrics.js";
import { onPageRules } from "./page/on-page.js";
import { statusRules } from "./page/status.js";
import { canonicalRules } from "./page/canonical.js";
import { indexabilityRules } from "./page/indexability.js";
import { technicalRules } from "./page/technical.js";
import { contentRules } from "./query/content.js";
import { hostRules } from "./query/host.js";
import { hreflangRules } from "./query/hreflang.js";
import { linkGraphRules } from "./query/link-graph.js";
import { linkTargetRules } from "./query/link-targets.js";
import { paginationRules } from "./query/pagination.js";
import { redirectRules } from "./query/redirects.js";
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
    ...structuredDataRules,
    // The metric kind. Registered in the same list because a rule is a rule to
    // the registry — the runner is what tells the kinds apart, driving these
    // last, after everything that writes evidence.
    ...linkMetrics,
    ...contentMetrics,
    ...hreflangMetrics,
  ]) {
    r.register(rule);
  }
  return r;
}

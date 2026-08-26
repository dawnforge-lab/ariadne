import { Registry } from "./registry/registry.js";
import { onPageRules } from "./page/on-page.js";
import { statusRules } from "./page/status.js";
import { canonicalRules } from "./page/canonical.js";
import { indexabilityRules } from "./page/indexability.js";
import { technicalRules } from "./page/technical.js";
import { hreflangRules } from "./query/hreflang.js";
import { linkTargetRules } from "./query/link-targets.js";
import { redirectRules } from "./query/redirects.js";

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
  ]) {
    r.register(rule);
  }
  return r;
}

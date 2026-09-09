import {
  effectiveCanonical,
  finding,
  isAuditable,
  pageRule,
  present,
  resolveCanonical,
  resolveEffectiveCanonical,
} from "../helpers.js";
import type { PageRule } from "../registry/types.js";
import { hasNoindex } from "./indexability.js";

/**
 * Re-exported at the address it was defined at until Phase 19. The resolution
 * itself now lives in `src/rules/helpers.ts`, beside `isCanonicalisedElsewhere`
 * — the exclusion the content and hreflang rules apply before they judge a page
 * at all — so that "where does this page canonicalise to?" has one answer for
 * the rule that REPORTS it and the rules that act on it. The three query rules
 * that import it from here keep working unchanged.
 */
export { resolveEffectiveCanonical, type CanonicalTarget } from "../helpers.js";

const CATEGORY = "canonical";

export const canonicalRules: PageRule[] = [
  pageRule("canonical.missing", ["CHECK-16"], CATEGORY, "warning", (p, self) =>
    isAuditable(p) && p.isIndexable === true && effectiveCanonical(p) === null
      ? [finding(self, p, {})]
      : [],
  ),

  // Two findings in one rule, because both are the same client question ("why
  // is this page not canonicalising to itself?"): a canonical for another URL,
  // and a canonical we could not resolve to a URL at all. The malformed case
  // carries `unparseable` so the report can say which it is.
  pageRule("canonical.points-elsewhere", ["CHECK-17"], CATEGORY, "info", (p, self) => {
    if (!isAuditable(p)) return [];
    const target = resolveEffectiveCanonical(p);
    if (target === null) return [];
    if (target.resolved === null)
      return [
        finding(self, p, { canonical: target.canonical, resolvedTo: null, unparseable: true }),
      ];
    return target.pointsElsewhere
      ? [finding(self, p, { canonical: target.canonical, resolvedTo: target.resolved })]
      : [];
  }),

  // `canonicalCount` counts every <link rel=canonical> the HTML declared;
  // `canonicalHtml` is the first one, which is the one we audit everywhere else
  // — reported as `kept` so the finding says which of the several that was.
  pageRule("canonical.multiple", ["CHECK-18"], CATEGORY, "critical", (p, self) =>
    isAuditable(p) && p.canonicalCount > 1
      ? [finding(self, p, { canonicalCount: p.canonicalCount, kept: p.canonicalHtml })]
      : [],
  ),

  pageRule("canonical.html-header-conflict", ["CHECK-18"], CATEGORY, "critical", (p, self) => {
    const { canonicalHtml: html, canonicalHeader: header } = p;
    if (!isAuditable(p) || !present(html) || !present(header)) return [];
    // A value that does not resolve falls back to its literal text rather than
    // to null, so two different malformed declarations stay two declarations
    // instead of collapsing into "no conflict".
    const htmlKey = resolveCanonical(html, p.url) ?? html;
    const headerKey = resolveCanonical(header, p.url) ?? header;
    return htmlKey !== headerKey
      ? [finding(self, p, { htmlCanonical: html, headerCanonical: header })]
      : [];
  }),

  // Hosts are compared literally, so `www.example.com` and `example.com` are
  // different hosts here and this fires. That is deliberate: the rule states
  // the fact and the agent judges whether the site treats the two as one.
  pageRule("canonical.cross-domain", ["CHECK-20"], CATEGORY, "warning", (p, self) => {
    if (!isAuditable(p)) return [];
    const target = resolveEffectiveCanonical(p);
    if (target === null || target.resolved === null) return [];
    const canonicalHost = new URL(target.resolved).hostname;
    const pageHost = new URL(p.url).hostname.toLowerCase();
    return canonicalHost !== pageHost
      ? [finding(self, p, { canonicalHost, pageHost })]
      : [];
  }),

  // Contradictory instructions: the canonical asks to consolidate this page's
  // signals into another URL, the noindex asks to drop the page entirely. A
  // canonical that does not resolve is not known to point anywhere, so it is
  // not a contradiction — `canonical.points-elsewhere` reports the malformation.
  pageRule("directive.canonical-noindex-conflict", ["CHECK-21"], CATEGORY, "critical", (p, self) => {
    if (!isAuditable(p) || !hasNoindex(p)) return [];
    const target = resolveEffectiveCanonical(p);
    return target !== null && target.pointsElsewhere
      ? [
          finding(self, p, {
            canonical: target.canonical,
            robotsMeta: p.robotsMeta,
            xRobotsTag: p.xRobotsTag,
          }),
        ]
      : [];
  }),
];

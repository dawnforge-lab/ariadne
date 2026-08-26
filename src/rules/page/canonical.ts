import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import { finding, isAuditable, pageRule, present } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";
import { hasNoindex } from "./indexability.js";

const CATEGORY = "canonical";

/**
 * The canonical the page effectively declares. The HTML `<link rel=canonical>`
 * wins over the HTTP `Link` header because that is the order search engines
 * apply when both are present; `canonical.html-header-conflict` is what reports
 * the disagreement, so the other rules can work from one value.
 *
 * `present` is what "declares" means here: `<link rel=canonical href="">`
 * reaches the database as an empty string, and an empty href names no URL.
 */
function effectiveCanonical(page: PageRecord): string | null {
  if (present(page.canonicalHtml)) return page.canonicalHtml;
  return present(page.canonicalHeader) ? page.canonicalHeader : null;
}

/**
 * Where a declared canonical actually points, as a comparable key, or `null`
 * when the value is not a URL we can resolve at all. Relative values resolve
 * against the page URL first, so `/x` on `https://example.com/page` is
 * `https://example.com/x` — the same resolution a browser and a crawler do.
 *
 * `normalizeUrl` is the one authority for URL identity in this codebase, and
 * both sides of every comparison below go through it, so a fragment, a
 * hostname's case or query-parameter order is never mistaken for a difference.
 */
function resolveCanonical(canonical: string, pageUrl: string): string | null {
  return normalizeUrl(canonical, pageUrl);
}

interface CanonicalTarget {
  /** The declared value, verbatim, for the evidence. */
  canonical: string;
  /** The normalized target, or null when the declared value does not parse. */
  resolved: string | null;
  /** True when the canonical resolves to a URL that is not this page. */
  pointsElsewhere: boolean;
}

function canonicalTarget(page: PageRecord): CanonicalTarget | null {
  const canonical = effectiveCanonical(page);
  if (canonical === null) return null;
  const resolved = resolveCanonical(canonical, page.url);
  const pageNormalized = normalizeUrl(page.url);
  return {
    canonical,
    resolved,
    pointsElsewhere: resolved !== null && resolved !== pageNormalized,
  };
}

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
    const target = canonicalTarget(p);
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
  pageRule("canonical.multiple", ["CHECK-18"], CATEGORY, "warning", (p, self) =>
    isAuditable(p) && p.canonicalCount > 1
      ? [finding(self, p, { canonicalCount: p.canonicalCount, kept: p.canonicalHtml })]
      : [],
  ),

  pageRule("canonical.html-header-conflict", ["CHECK-18"], CATEGORY, "warning", (p, self) => {
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
  pageRule("canonical.cross-domain", ["CHECK-20"], CATEGORY, "info", (p, self) => {
    if (!isAuditable(p)) return [];
    const target = canonicalTarget(p);
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
  pageRule("directive.canonical-noindex-conflict", ["CHECK-21"], CATEGORY, "warning", (p, self) => {
    if (!isAuditable(p) || !hasNoindex(p)) return [];
    const target = canonicalTarget(p);
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

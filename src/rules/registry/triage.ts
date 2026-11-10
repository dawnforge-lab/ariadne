/**
 * Triage: the issue type and priority of every rule that finds (Phase 27a,
 * docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md).
 *
 * Severity (critical / warning / info) is the engine's fact about a rule and
 * keeps its Phase 16 meaning. Type and priority are the reader's axes, in
 * Screaming Frog's vocabulary, which practitioners already read:
 *
 *  - Issue means a defect to fix.
 *  - Warning means a human must check it, because it may be fine.
 *  - Opportunity means nothing is broken, but changing it would help.
 *
 *  Priority is the expected effect of the fix on the pages hit:
 *  - high: crawled, indexed or served correctly;
 *  - medium: how they rank or appear;
 *  - low: hygiene.
 *
 * HOW THE ROWS WERE ASSIGNED:
 *
 *  1. A rule that corresponds to a Screaming Frog issue names it in `sfIssue`,
 *     SF's exact Issue Name, and takes that issue's Issue Type and Issue
 *     Priority as its reference, read from a black-box SF Issues Overview
 *     export that stays in the git-ignored SDD workspace, as the 26a
 *     calibration's exports did. `scripts/triage-vs-sf.ts` prints the
 *     comparison.
 *  2. A rule with no SF counterpart is assigned from the rubric above.
 *  3. Where the rubric disagrees with SF on a mapped rule, SF's value stands
 *     unless the rule's own semantics differ from SF's issue. Then the row
 *     keeps `sfIssue`, carries our value, and says why in a
 *     `// differs from SF:` comment.
 *  4. NOT MEASURED markers are warning / low and name no SF issue: a check that
 *     could not run is something to look at, not a defect on the site.
 *     `defineRule` refuses any other triage on a marker.
 *
 * Metric rules produce no findings and have no row; `defineRule` refuses one
 * that does. A rule that finds and has no row fails registry load, the way
 * missing copy does. One row per page and query rule, ordered by rule id; a new
 * rule adds its row as part of the rule.
 *
 * Type and priority are NOT stored per finding: they are joined from here (plus
 * a crawl's overrides) at read time, so an override takes effect without
 * re-running the rules.
 */
import type { IssueType, Priority } from "./types.js";

/** A rule's default judgement: what the finding is, and what fixing it is worth. */
export interface Triage {
  type: IssueType;
  priority: Priority;
}

/** One row of the table: the judgement, and the Screaming Frog issue it was referenced against. */
export interface TriageRow extends Triage {
  /** Screaming Frog's exact Issue Name, when the rule corresponds to one. */
  sfIssue?: string;
}

/**
 * How `defineRule` reads the table. A parameter so the registry's checks can be
 * exercised on synthetic rules without editing `TRIAGE`; production passes
 * `triageRow`.
 */
export type TriageLookup = (ruleId: string) => Triage | undefined;

const MARKER: TriageRow = { type: "warning", priority: "low" };

export const TRIAGE: Readonly<Record<string, Readonly<TriageRow>>> = {
  "canonical.chain": { type: "issue", priority: "high" },
  "canonical.cross-domain": { type: "warning", priority: "high" },
  "canonical.fragment": { type: "issue", priority: "high", sfIssue: "Canonicals: Contains Fragment URL" },
  "canonical.html-header-conflict": { type: "issue", priority: "high", sfIssue: "Canonicals: Multiple Conflicting" },
  "canonical.missing": { type: "warning", priority: "medium", sfIssue: "Canonicals: Missing" },
  "canonical.multiple": { type: "warning", priority: "low", sfIssue: "Canonicals: Multiple" },
  "canonical.non-200-target": { type: "issue", priority: "high", sfIssue: "Canonicals: Non-Indexable Canonical" },
  "canonical.non-indexable-target": { type: "issue", priority: "high", sfIssue: "Canonicals: Non-Indexable Canonical" },
  "canonical.points-elsewhere": { type: "warning", priority: "high", sfIssue: "Canonicals: Canonicalised" },
  "canonical.relative": { type: "warning", priority: "low", sfIssue: "Canonicals: Canonical Is Relative" },
  "canonical.unlinked": { type: "warning", priority: "medium", sfIssue: "Canonicals: Unlinked" },
  // differs from SF: ours fires only when rendering at least doubles the page's
  // words, so the main content depends on rendering (indexing), not on any
  // content JavaScript adds.
  "content.csr-dependent": { type: "warning", priority: "high", sfIssue: "JavaScript: Contains JavaScript Content" },
  "content.exact-duplicate": { type: "issue", priority: "high", sfIssue: "Content: Exact Duplicates" },
  "content.near-duplicate": { type: "warning", priority: "medium", sfIssue: "Content: Near Duplicates" },
  "content.near-duplicate-skipped": MARKER,
  "content.placeholder": { type: "warning", priority: "high", sfIssue: "Content: Lorem Ipsum Placeholder" },
  "content.soft-404": { type: "warning", priority: "high", sfIssue: "Content: Soft 404 Pages" },
  "content.thin": { type: "opportunity", priority: "medium", sfIssue: "Content: Low Content Pages" },
  "content.thin-skipped": MARKER,
  "crawl.blocked": MARKER,
  "crawl.list-mode": MARKER,
  "crawl.unreadable-encoding": MARKER,
  "directive.canonical-noindex-conflict": { type: "issue", priority: "high" },
  "directives.bot-conflict": { type: "warning", priority: "high" },
  "directives.restrictive": { type: "warning", priority: "low", sfIssue: "Directives: NoSnippet" },
  // differs from SF: ours fires only on a date already past, within 30 days, or
  // unreadable, the cases where the page is about to leave the index (or stays
  // when its author expected it to leave); SF lists every unavailable_after.
  "directives.unavailable-after": { type: "warning", priority: "high", sfIssue: "Directives: Unavailable_After" },
  "extraction.not-recorded": MARKER,
  "filters.js-only": { type: "warning", priority: "medium", sfIssue: "JavaScript: Contains JavaScript Links" },
  "h1.duplicate-skipped": MARKER,
  "h1.duplicate-text": { type: "opportunity", priority: "low", sfIssue: "H1: Duplicate" },
  "h2.duplicate": { type: "opportunity", priority: "low", sfIssue: "H2: Duplicate" },
  "h2.missing": { type: "warning", priority: "low", sfIssue: "H2: Missing" },
  "h2.too-long": { type: "opportunity", priority: "low", sfIssue: "H2: Over 70 Characters" },
  "head.directives-outside-head": { type: "issue", priority: "high", sfIssue: "Directives: Outside <head>" },
  // differs from SF: one rule covers the title, the meta description and the
  // social tags (SF: high, medium and low); what is lost is how the page appears
  // in results and when shared, not whether it is indexed.
  "head.tags-outside-head": { type: "issue", priority: "medium", sfIssue: "Page Titles: Outside <head>" },
  "headings.h1-missing": { type: "issue", priority: "medium", sfIssue: "H1: Missing" },
  "headings.h1-multiple": { type: "warning", priority: "medium", sfIssue: "H1: Multiple" },
  "headings.h1-too-long": { type: "opportunity", priority: "low", sfIssue: "H1: Over 70 Characters" },
  "headings.level-skip": { type: "warning", priority: "low", sfIssue: "H2: Non-Sequential" },
  "host.duplicate-host-200": { type: "issue", priority: "high" },
  "host.http-serves-200": { type: "issue", priority: "high", sfIssue: "Security: HTTP URLs" },
  "host.legacy-host-reachable": { type: "issue", priority: "high" },
  "host.probe-skipped": MARKER,
  "hreflang.alternates-not-crawled": MARKER,
  "hreflang.declarations-incomplete": MARKER,
  "hreflang.html-lang-mismatch": { type: "warning", priority: "medium", sfIssue: "Hreflang: Mismatch with HTML Lang Attribute" },
  "hreflang.inconsistent-return-code": { type: "issue", priority: "high", sfIssue: "Hreflang: Inconsistent Language & Region Return Links" },
  "hreflang.invalid-code": { type: "issue", priority: "high", sfIssue: "Hreflang: Incorrect Language & Region Codes" },
  "hreflang.missing-return-link": { type: "issue", priority: "high", sfIssue: "Hreflang: Missing Return Links" },
  "hreflang.missing-self-reference": { type: "warning", priority: "low", sfIssue: "Hreflang: Missing Self Reference" },
  "hreflang.missing-x-default": { type: "warning", priority: "low", sfIssue: "Hreflang: Missing X-Default" },
  "hreflang.multiple-entries": { type: "issue", priority: "high", sfIssue: "Hreflang: Multiple Entries" },
  "hreflang.non-indexable-target": { type: "issue", priority: "high", sfIssue: "Hreflang: Non-200 hreflang URLs" },
  "hreflang.self-only": { type: "issue", priority: "high", sfIssue: "Hreflang: Self Reference Only" },
  "hreflang.source-conflict": { type: "issue", priority: "high" },
  "hreflang.unlinked-target": { type: "issue", priority: "medium", sfIssue: "Hreflang: Unlinked hreflang URLs" },
  // differs from SF: ours fires only when head tags follow the early close and
  // are read as body content (a lost canonical, robots or title is a defect);
  // SF lists every invalid element in the head.
  "html.head-closed-early": { type: "issue", priority: "high", sfIssue: "Validation: Invalid HTML Elements in <head>" },
  // differs from SF: the same early close with no head tag after it, so nothing
  // is lost today; a latent hazard, not a page served wrongly.
  "html.head-closed-early-harmless": { type: "warning", priority: "low", sfIssue: "Validation: Invalid HTML Elements in <head>" },
  "html.structure-invalid": { type: "issue", priority: "high", sfIssue: "Validation: Missing <head> Tag" },
  "http.no-response": { type: "issue", priority: "high", sfIssue: "Response Codes: Internal No Response" },
  // differs from SF: the URL answered on re-check, so the failure was
  // intermittent and may not recur; a human checks it.
  "http.no-response-transient": { type: "warning", priority: "high", sfIssue: "Response Codes: Internal No Response" },
  "http.server-error": { type: "issue", priority: "high", sfIssue: "Response Codes: Internal Server Error (5xx)" },
  // differs from SF: the 5xx cleared on re-check, so the failure was
  // intermittent and may not recur; a human checks it.
  "http.server-error-transient": { type: "warning", priority: "high", sfIssue: "Response Codes: Internal Server Error (5xx)" },
  "images.alt-too-long": { type: "opportunity", priority: "low", sfIssue: "Images: Alt Text Over 100 Characters" },
  // differs from SF: an empty alt is correct on a decorative image and wrong on
  // one that carries meaning, and the rule (as its copy says) cannot tell the
  // two apart, so a human checks it.
  "images.empty-alt": { type: "warning", priority: "low", sfIssue: "Images: Missing Alt Text" },
  "images.legacy-format": { type: "opportunity", priority: "medium", sfIssue: "PageSpeed: Improve Image Delivery" },
  "images.missing-alt": { type: "issue", priority: "low", sfIssue: "Images: Missing Alt Attribute" },
  "images.missing-dimensions": { type: "opportunity", priority: "low", sfIssue: "Images: Missing Size Attributes" },
  "images.oversized": { type: "opportunity", priority: "medium", sfIssue: "Images: Over 100 kB" },
  "indexability.meta-header-conflict": { type: "issue", priority: "high" },
  "indexability.nofollow": { type: "warning", priority: "high", sfIssue: "Directives: Nofollow" },
  "indexability.noindex": { type: "warning", priority: "high", sfIssue: "Directives: Noindex" },
  "links.aria-label-only": { type: "warning", priority: "low" },
  "links.broken-internal": { type: "issue", priority: "high", sfIssue: "Response Codes: Internal Client Error (4xx)" },
  "links.empty-href": { type: "issue", priority: "low" },
  "links.high-outlinks": { type: "warning", priority: "low", sfIssue: "Links: Pages With High Internal Outlinks" },
  "links.internal-nofollow": { type: "warning", priority: "low", sfIssue: "Links: Internal Nofollow Outlinks" },
  "links.localhost": { type: "issue", priority: "high", sfIssue: "Links: Outlinks To Localhost" },
  "links.no-anchor-text": { type: "opportunity", priority: "low", sfIssue: "Links: Internal Outlinks With No Anchor Text" },
  "links.non-descriptive-anchor": { type: "opportunity", priority: "low", sfIssue: "Links: Non-Descriptive Anchor Text In Internal Outlinks" },
  "links.only-from-non-indexable": { type: "warning", priority: "high", sfIssue: "Links: Non-Indexable Page Inlinks Only" },
  "links.orphan": { type: "issue", priority: "medium", sfIssue: "Sitemaps: Orphan URLs" },
  "links.orphan-skipped": MARKER,
  "links.to-server-error": { type: "issue", priority: "high", sfIssue: "Response Codes: Internal Server Error (5xx)" },
  "links.uncrawlable": { type: "warning", priority: "high", sfIssue: "Links: Pages With Uncrawlable Internal Outlinks" },
  "links.unsafe-target-blank": { type: "warning", priority: "low", sfIssue: "Security: Unsafe Cross-Origin Links" },
  "meta-description.duplicate": { type: "opportunity", priority: "low", sfIssue: "Meta Description: Duplicate" },
  "meta-description.missing": { type: "opportunity", priority: "low", sfIssue: "Meta Description: Missing" },
  "meta-description.multiple": { type: "issue", priority: "medium", sfIssue: "Meta Description: Multiple" },
  "meta-description.pixel-too-long": { type: "opportunity", priority: "low", sfIssue: "Meta Description: Over 985 Pixels" },
  "meta-description.pixel-too-short": { type: "opportunity", priority: "low", sfIssue: "Meta Description: Below 400 Pixels" },
  "meta-description.too-long": { type: "opportunity", priority: "low", sfIssue: "Meta Description: Over 155 Characters" },
  "meta-description.too-short": { type: "opportunity", priority: "low", sfIssue: "Meta Description: Below 70 Characters" },
  "mobile.viewport-missing": { type: "issue", priority: "high", sfIssue: "Mobile: Viewport Not Set" },
  // differs from SF: ours fires only when the site's navigation (nav and
  // footer links) exists only after rendering, so a crawler reading the
  // response finds almost no way onward (crawling), not on any JavaScript link.
  "nav.js-only": { type: "warning", priority: "high", sfIssue: "JavaScript: Contains JavaScript Links" },
  "page.html-too-large": { type: "issue", priority: "high", sfIssue: "Validation: HTML Document Over 2MB" },
  "pages.not-in-sitemap": { type: "issue", priority: "medium", sfIssue: "Sitemaps: URLs not in Sitemap" },
  "pagination.canonical-to-other": { type: "warning", priority: "high", sfIssue: "Canonicals: Canonicalised" },
  "pagination.loop": { type: "issue", priority: "low", sfIssue: "Pagination: Pagination Loop" },
  "pagination.multiple": { type: "issue", priority: "low", sfIssue: "Pagination: Multiple Pagination URLs" },
  "pagination.next-not-linked": { type: "issue", priority: "high", sfIssue: "Pagination: Pagination URL Not in Anchor Tag" },
  "pagination.next-target-uncrawled": { type: "warning", priority: "low" },
  "pagination.non-indexable-target": { type: "warning", priority: "high", sfIssue: "Pagination: Non-Indexable" },
  "pagination.sequence-error": { type: "issue", priority: "low", sfIssue: "Pagination: Sequence Error" },
  "performance.slow-response": { type: "warning", priority: "medium", sfIssue: "PageSpeed: Document Request Latency" },
  "redirect.chain": { type: "warning", priority: "medium", sfIssue: "Response Codes: Internal Redirect Chain" },
  "redirect.js": { type: "warning", priority: "low", sfIssue: "Response Codes: Internal Redirection (JavaScript)" },
  "redirect.loop": { type: "issue", priority: "high", sfIssue: "Response Codes: Internal Redirect Loop" },
  "redirect.meta-refresh": { type: "warning", priority: "low", sfIssue: "Response Codes: Internal Redirection (Meta Refresh)" },
  "render.canonical-changed": { type: "issue", priority: "high", sfIssue: "JavaScript: Canonical Mismatch" },
  "render.h1-changed": { type: "warning", priority: "medium", sfIssue: "JavaScript: H1 Updated by JavaScript" },
  "render.meta-description-changed": { type: "warning", priority: "medium", sfIssue: "JavaScript: Meta Description Updated by JavaScript" },
  // differs from SF: ours reports both directions (noindex removed by
  // JavaScript, or added by it), and either one decides whether the page is
  // indexed, depending on which reading a search engine acts on.
  "render.noindex-changed": { type: "issue", priority: "high", sfIssue: "JavaScript: Noindex Only in Original HTML" },
  "render.title-changed": { type: "warning", priority: "medium", sfIssue: "JavaScript: Page Title Updated by JavaScript" },
  "resources.all-unknown": MARKER,
  "resources.bad-content-type": { type: "warning", priority: "low", sfIssue: "Security: Bad Content Type" },
  "resources.broken": { type: "issue", priority: "high" },
  "resources.not-fetched": MARKER,
  "resources.not-recorded": MARKER,
  "resources.partial-unknown": MARKER,
  "resources.uncached": { type: "opportunity", priority: "medium", sfIssue: "PageSpeed: Use Efficient Cache Lifetimes" },
  "robots.blocks-internal-urls": { type: "warning", priority: "high", sfIssue: "Response Codes: Internal Blocked by Robots.txt" },
  "robots.blocks-sitemap-urls": { type: "issue", priority: "high" },
  "robots.check-skipped": MARKER,
  "robots.missing": { type: "opportunity", priority: "low" },
  "schema.breadcrumb-absent": { type: "opportunity", priority: "low" },
  "schema.none-on-site": { type: "opportunity", priority: "low", sfIssue: "Structured Data: Missing" },
  "schema.product-incomplete": { type: "issue", priority: "high", sfIssue: "Structured Data: Rich Result Validation Errors" },
  "schema.self-serving-reviews": { type: "warning", priority: "low" },
  "security.form-insecure": { type: "issue", priority: "high", sfIssue: "Security: Form URL Insecure" },
  "security.headers-missing": { type: "warning", priority: "low", sfIssue: "Security: Missing Content-Security-Policy Header" },
  "security.headers-not-recorded": MARKER,
  "security.hsts-missing": { type: "warning", priority: "low", sfIssue: "Security: Missing HSTS Header" },
  "security.http-url": { type: "issue", priority: "high", sfIssue: "Security: HTTP URLs" },
  "security.mixed-content": { type: "issue", priority: "high", sfIssue: "Security: Mixed Content" },
  "sitemap.cross-host-loc": { type: "issue", priority: "medium" },
  "sitemap.invalid": { type: "issue", priority: "high" },
  "sitemap.lastmod-invalid": { type: "issue", priority: "low" },
  "sitemap.missing": { type: "opportunity", priority: "low" },
  "sitemap.non-200": { type: "issue", priority: "medium", sfIssue: "Sitemaps: Non-Indexable URLs in Sitemap" },
  "sitemap.non-indexable": { type: "issue", priority: "medium", sfIssue: "Sitemaps: Non-Indexable URLs in Sitemap" },
  "sitemap.over-50k-urls": { type: "issue", priority: "high", sfIssue: "Sitemaps: XML Sitemap with over 50k URLs" },
  "sitemap.oversized": { type: "issue", priority: "high", sfIssue: "Sitemaps: XML Sitemap over 50MB" },
  "sitemap.redirected": { type: "issue", priority: "medium", sfIssue: "Sitemaps: Non-Indexable URLs in Sitemap" },
  "sitemap.uncrawled": { type: "warning", priority: "low" },
  "sitemap.url-in-multiple": { type: "warning", priority: "low", sfIssue: "Sitemaps: URLs in Multiple Sitemaps" },
  "sitemap.url-too-long": { type: "issue", priority: "low" },
  "social.image-broken": { type: "issue", priority: "low", sfIssue: "Social: Non-200 OG Image URL" },
  "social.image-insecure": { type: "warning", priority: "low" },
  "social.og-duplicate": { type: "warning", priority: "low", sfIssue: "Social: Duplicate OG Title" },
  "social.og-incomplete": { type: "opportunity", priority: "low", sfIssue: "Social: Missing OG Tags" },
  "social.og-multiple": { type: "warning", priority: "low", sfIssue: "Social: Multiple OG Tags" },
  "social.og-url-mismatch": { type: "warning", priority: "low", sfIssue: "Social: Non-Canonical OG URL" },
  "social.x-incomplete": { type: "opportunity", priority: "low", sfIssue: "Social: Missing X Cards" },
  "structure.deep-page": { type: "opportunity", priority: "medium", sfIssue: "Links: Pages With High Crawl Depth" },
  "title.duplicate": { type: "opportunity", priority: "medium", sfIssue: "Page Titles: Duplicate" },
  "title.missing": { type: "issue", priority: "high", sfIssue: "Page Titles: Missing" },
  "title.multiple": { type: "issue", priority: "high", sfIssue: "Page Titles: Multiple" },
  "title.pixel-too-long": { type: "opportunity", priority: "medium", sfIssue: "Page Titles: Over 561 Pixels" },
  "title.pixel-too-short": { type: "opportunity", priority: "medium", sfIssue: "Page Titles: Below 200 Pixels" },
  "title.same-as-h1": { type: "opportunity", priority: "low", sfIssue: "Page Titles: Same as H1" },
  "title.too-long": { type: "opportunity", priority: "medium", sfIssue: "Page Titles: Over 60 Characters" },
  "title.too-short": { type: "opportunity", priority: "medium", sfIssue: "Page Titles: Below 30 Characters" },
  // differs from SF: ours lists only internal search pages that are INDEXABLE,
  // which is a question of what gets indexed; SF lists every internal search URL.
  "url.internal-search": { type: "warning", priority: "high", sfIssue: "URL: Internal Search" },
  "url.multiple-slashes": { type: "issue", priority: "low", sfIssue: "URL: Multiple Slashes" },
  "url.non-ascii": { type: "warning", priority: "low", sfIssue: "URL: Non ASCII Characters" },
  "url.normalisation-variants": { type: "issue", priority: "high" },
  // differs from SF: ours lists only parameter URLs that return 200, carry no
  // noindex and canonicalise to themselves, the ones that enter the index beside
  // their parameter-free page; SF lists every parameter URL.
  "url.parameter-pages-indexable": { type: "warning", priority: "high", sfIssue: "URL: Parameters" },
  "url.reference-too-long": { type: "issue", priority: "low" },
  "url.repetitive-path": { type: "warning", priority: "low", sfIssue: "URL: Repetitive Path" },
  "url.spaces": { type: "issue", priority: "low", sfIssue: "URL: Contains Space" },
  "url.too-long": { type: "opportunity", priority: "low", sfIssue: "URL: Over 115 Characters" },
  "url.tracking-params-internal": { type: "warning", priority: "low", sfIssue: "URL: GA Tracking Parameters" },
  "url.underscores": { type: "opportunity", priority: "low", sfIssue: "URL: Underscores" },
  "url.uppercase": { type: "warning", priority: "low", sfIssue: "URL: Uppercase" },
};

/** The table's row for a rule, or undefined. Own keys only: `toString` is not a rule. */
export const triageRow: TriageLookup = (ruleId) => {
  if (!Object.hasOwn(TRIAGE, ruleId)) return undefined;
  const { type, priority } = TRIAGE[ruleId]!;
  return { type, priority };
};

/** A rule's default judgement. Throws on a miss, naming the rule, as `copyFor` does. */
export function triageFor(ruleId: string): Triage {
  const row = triageRow(ruleId);
  if (!row) throw new Error(`no triage for rule '${ruleId}' — add it to src/rules/registry/triage.ts`);
  return row;
}

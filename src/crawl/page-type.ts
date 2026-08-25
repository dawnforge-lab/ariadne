/**
 * `page_type` derivation: the bucket every page-type-scoped metric and every
 * "this template is broken, not this page" finding groups by.
 *
 * Two sources, in order:
 *  1. Client patterns — substring matches against the pathname, first match
 *     wins. This is how a site says "/products/ means product" in words the
 *     rule engine can group by, and it always beats the guess.
 *  2. The detected URL template from the absorbed url-utils
 *     (`/blog/2024/my-great-post` -> `/blog/:id/:slug`), used verbatim as the
 *     type. Upstream's conventions are kept as-is, including the slug rule
 *     that leaves two-part segments literal — see `detectUrlTemplate`.
 *
 * Original to Ariadne; `detectUrlTemplate` is OpenSEO's (see url-utils.ts).
 */
import { detectUrlTemplate } from "./parse/url-utils.js";

export interface PageTypePattern {
  /** Matched as a plain substring of the pathname — not a glob, not a regex. */
  pattern: string;
  pageType: string;
}

/**
 * The page type for one absolute URL.
 *
 * Throws on a URL that will not parse. Callers hand this URLs that already
 * passed url-policy and the frontier, so an unparseable one is a defect
 * upstream of here and must surface as one rather than as a bogus bucket.
 */
export function derivePageType(
  url: string,
  clientPatterns?: PageTypePattern[],
): string {
  // Patterns match the path only: a "/products/" in a query string or in the
  // host is not a product page, and matching the whole URL would say it was.
  const { pathname } = new URL(url);
  if (clientPatterns !== undefined) {
    for (const { pattern, pageType } of clientPatterns) {
      if (pathname.includes(pattern)) return pageType;
    }
  }
  return detectUrlTemplate(pathname);
}

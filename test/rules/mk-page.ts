import type { PageRecord } from "../../src/rules/registry/types.js";

/**
 * The clean page: every column of `pages` filled with a value that no rule
 * fires on, so a test overrides exactly the one signal it is about and the
 * assertion cannot be confused by an unrelated default.
 *
 * Deliberately shared by every page-rule test file rather than restated per
 * file: a new nullable column added to `pages` must be answered here once, and
 * "clean" must mean the same thing in every rule's test.
 */
export const CLEAN_TITLE = "A perfectly reasonable page title here"; // 38 chars
export const CLEAN_META =
  "A clear and honest summary of what this page covers, written to earn the click from a search result."; // 100 chars

export function mkPage(overrides: Partial<PageRecord> = {}): PageRecord {
  const url = "https://example.com/page";
  return {
    id: "page_clean",
    crawlId: "crawl_test",
    url,
    urlNormalised: url,
    pageType: "content",
    statusCode: 200,
    fetchClass: "ok",
    contentType: "text/html; charset=utf-8",
    redirectUrl: null,
    depth: 2,
    discoveredVia: "link",
    title: CLEAN_TITLE,
    metaDescription: CLEAN_META,
    canonicalHtml: url,
    canonicalHeader: null,
    canonicalCount: 1,
    robotsMeta: null,
    xRobotsTag: null,
    isIndexable: true,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h2Count: 2,
    h3Count: 1,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1, 2, 3],
    wordCount: 400,
    textRatio: 0.4,
    contentHash: "0".repeat(64),
    simhash: 1234567890123456789n,
    structuredDataParseErrors: 0,
    responseTimeMs: 200,
    htmlBytes: 40_000,
    domSize: 800,
    imagesTotal: 5,
    imagesMissingAlt: 0,
    imagesMissingDimensions: 0,
    hasAmp: false,
    hasViewport: true,
    hasLoremIpsum: false,
    relNext: null,
    relPrev: null,
    rendered: false,
    renderedWordCount: null,
    renderedLinkCount: null,
    ...overrides,
  };
}

import { describe, expect, it } from "vitest";
import * as T from "../../src/rules/thresholds.js";
import * as onPage from "../../src/rules/page/on-page.js";
import * as technical from "../../src/rules/page/technical.js";
import * as linkGraph from "../../src/rules/query/link-graph.js";
import * as redirects from "../../src/rules/query/redirects.js";
import * as content from "../../src/rules/query/content.js";
import * as renderDiff from "../../src/rules/query/render-diff.js";
import * as structuredData from "../../src/rules/query/structured-data.js";
import * as resources from "../../src/rules/query/resources.js";
import * as crawlMetrics from "../../src/rules/metric/crawl-metrics.js";

describe("thresholds", () => {
  it("pins every verdict threshold at its Phase 25 value", () => {
    expect({ ...T }).toEqual({
      TITLE_MIN: 30,
      TITLE_MAX: 60,
      META_MIN: 70,
      META_MAX: 155,
      H1_MAX: 70,
      URL_MAX: 115,
      HEADING_MAX_STEP: 1,
      SLOW_MS: 1500,
      DEEP_DEPTH: 5,
      CHAIN_HOPS: 2,
      MAX_REDIRECT_HOPS: 10,
      SOFT_404_WORDS: 300,
      THIN_WORDS: 150,
      NEAR_DUPLICATE_HAMMING: 3,
      NEAR_DUPLICATE_MIN_MAIN_WORDS: 50,
      TEMPLATE_HAMMING: 4,
      CSR_WORD_MULTIPLE: 2,
      CSR_MIN_ADDED_WORDS: 150,
      NAV_RAW_MAX: 5,
      NAV_RENDERED_MIN: 10,
      NAV_RENDERED_MULTIPLE: 2,
      FILTER_RENDERED_MIN: 5,
      BREADCRUMB_PAGE_FLOOR: 5,
      NONE_PAGE_FLOOR: 1,
      IMAGE_WEIGHT_WARN: 100_000,
      SITEMAP_URL_CAP: 50_000,
      UNSAFE_REFERRER_POLICIES: ["unsafe-url", "no-referrer-when-downgrade"],
      UNAVAILABLE_AFTER_WARN_DAYS: 30,
      RESTRICTIVE_DIRECTIVES: ["nosnippet", "max-snippet:0", "max-image-preview:none", "noimageindex"],
      CANONICAL_MAX_HOPS: 10,
      PAGINATION_WALK_MAX: 500,
      NON_DESCRIPTIVE_ANCHORS: [
        "click here", "click", "here", "read more", "more", "learn more", "find out more",
        "continue reading", "continue", "see more", "view more", "more info",
        "more information", "details", "this page", "this", "link", "go", "website",
      ],
      HIGH_INTERNAL_OUTLINKS: 1000,
      HIGH_EXTERNAL_OUTLINKS: 100,
      INTERNAL_SEARCH_PARAMS: ["s", "q", "query", "search", "keyword", "keywords"],
      INTERNAL_SEARCH_PATH: /(?:^|\/)search(?:\/|$)/i,
    });
  });

  it("the owning modules re-export the same binding", () => {
    expect(onPage.TITLE_MAX).toBe(T.TITLE_MAX);
    expect(technical.SLOW_MS).toBe(T.SLOW_MS);
    expect(linkGraph.DEEP_DEPTH).toBe(T.DEEP_DEPTH);
    expect(redirects.CHAIN_HOPS).toBe(T.CHAIN_HOPS);
    expect(redirects.MAX_REDIRECT_HOPS).toBe(T.MAX_REDIRECT_HOPS);
    expect(content.THIN_WORDS).toBe(T.THIN_WORDS);
    expect(renderDiff.NAV_RAW_MAX).toBe(T.NAV_RAW_MAX);
    expect(structuredData.NONE_PAGE_FLOOR).toBe(T.NONE_PAGE_FLOOR);
    expect(resources.IMAGE_WEIGHT_WARN).toBe(T.IMAGE_WEIGHT_WARN);
    expect(crawlMetrics.SITEMAP_URL_CAP).toBe(T.SITEMAP_URL_CAP);
  });
});

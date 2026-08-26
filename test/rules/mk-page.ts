import { expect } from "vitest";
import type { PageRecord, PageRule } from "../../src/rules/registry/types.js";

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
    hasSoft404Phrases: false,
    relNext: null,
    relPrev: null,
    rendered: false,
    renderedWordCount: null,
    renderedLinkCount: null,
    ...overrides,
  };
}

/**
 * Look a rule up by id in one rule array, failing loudly when it is absent.
 * Every page-rule test file drives its rules through this rather than indexing
 * the array by position, so renaming or reordering a rule breaks the test that
 * names it instead of silently testing a different rule.
 */
export function ruleLookup(rules: PageRule[], arrayName: string): (id: string) => PageRule {
  const byId = new Map(rules.map((r) => [r.id, r]));
  return (id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`no rule '${id}' in ${arrayName}`);
    return r;
  };
}

/**
 * The six fetch shapes that are not "an HTML 200 we can read". Redirects and
 * errors are the status rules' subject; every rule guarded by `isAuditable`
 * must stay silent on all of them, including the two that look like a success
 * and are not (a non-HTML body, and a 204 with no body at all).
 */
export const NON_OK_FETCHES: Partial<PageRecord>[] = [
  { fetchClass: "redirect", statusCode: 301 },
  { fetchClass: "client_error", statusCode: 404 },
  { fetchClass: "server_error", statusCode: 503 },
  { fetchClass: "blocked", statusCode: 403 },
  { fetchClass: "non_html", statusCode: 200 },
  { fetchClass: "ok", statusCode: 204 },
];

/**
 * Assert that a set of `isAuditable`-guarded rules is silent on every non-200
 * fetch shape — and that the sweep means something.
 *
 * `brokenShapes` are page overrides that fire the rules when the fetch *was* a
 * 200. The precondition below asserts their union fires every rule in `rules`,
 * so a sweep cannot pass because the shapes stopped triggering anything: the
 * only reason for the silence it then observes is the fetch class.
 */
export function expectSilentOnNonOkFetches(
  rules: PageRule[],
  brokenShapes: Partial<PageRecord>[],
): void {
  const fired = new Set(
    brokenShapes.flatMap((shape) =>
      rules.filter((r) => r.run(mkPage(shape)).length > 0).map((r) => r.id),
    ),
  );
  for (const r of rules) {
    expect(fired.has(r.id), `${r.id}: no broken shape fires it, the sweep would be vacuous`)
      .toBe(true);
  }

  for (const shape of brokenShapes) {
    for (const nonOk of NON_OK_FETCHES) {
      for (const r of rules) {
        expect(
          r.run(mkPage({ ...shape, ...nonOk })),
          `${r.id} ${nonOk.fetchClass}/${nonOk.statusCode}`,
        ).toHaveLength(0);
      }
    }
  }
}

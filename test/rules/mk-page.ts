import { expect } from "vitest";
import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
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
    // A page that worked has nothing to explain. See pages.fetch_reason.
    fetchReason: null,
    contentType: "text/html; charset=utf-8",
    redirectUrl: null,
    redirectUrlNormalised: null,
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
    h1Text: "A perfectly reasonable page heading",
    wordCount: 400,
    // The clean page has some hidden chrome, like every real page, and plenty
    // of visible words all the same: 380 clears THIN_WORDS, so `content.thin`
    // is silent for the reason it is meant to be. A test about the floor
    // overrides THIS column — the raw count is not what the rule reads.
    renderableWordCount: 380,
    // Not null: a null here is "this row predates Phase 7", which is a
    // different page from a clean one and is what `content.thin-skipped`
    // reports. The clean page is a page a current crawl wrote.
    clickDepth: 2,
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
    navLinkCount: 12,
    footerLinkCount: 8,
    frameworkMarkers: [],
    rendered: false,
    renderedWordCount: null,
    renderedLinkCount: null,
    // Null is "this page was never rendered" — the clean page is a raw-HTML
    // crawl's row, so every render-side column is null and no rule may read
    // that as a rendered page whose counts happened to be zero.
    renderedNavLinkCount: null,
    renderedFooterLinkCount: null,
    renderedFilterLinkCount: null,
    // The second measurement family (P8-T1): the same analyzer over the
    // serialised post-JavaScript DOM. Null for the same reason as the five
    // above and one more of its own — a null here also means "no Phase-8 render
    // pass wrote this row", which is the gate `content.csr-dependent` refuses a
    // pre-P8 crawl on.
    renderedAnalyzerWordCount: null,
    renderedRenderableWordCount: null,
    renderedTitle: null,
    renderedH1Count: null,
    renderedCanonical: null,
    renderedHtmlPath: null,
    renderedRedirectUrl: null,
    renderError: null,
    // The two observations (migration 0016). The clean page was fetched once,
    // by a current crawl, so it carries a `fetched_at` — a null there is "this
    // row predates 0016", which is a different page from a clean one.
    fetchedAt: new Date("2026-09-08T12:00:00.000Z"),
    // NOBODY ASKED: the clean page is not a server error, so no recheck pass
    // ever had a reason to look at it. All four move together — see the null
    // contract on pages.recheck_fetch_class — and a test about the recheck
    // overrides the class and the time as a PAIR.
    recheckFetchClass: null,
    recheckStatusCode: null,
    recheckReason: null,
    recheckAt: null,
    ...overrides,
  };
}

/**
 * The `pages` columns `is_indexable` is derived from. The query-rule DB tests
 * describe their rows with specs of this shape and let `writerIndexable` fill
 * the flag in, rather than stating it themselves.
 */
export interface IndexabilitySpec {
  fetchClass?: string;
  /** Null for a fetch that got no HTTP answer at all (timeout, network error). */
  statusCode?: number | null;
  robotsMeta?: string;
  xRobotsTag?: string;
}

/**
 * `is_indexable` exactly as `PageWriter` computes it (see `isIndexable` in
 * src/crawl/persist.ts): a plain boolean, true only for a 200 OK with no
 * noindex directive. Derived rather than passed in, so no test can insert a
 * combination the crawler could never write and then assert a rule's behaviour
 * on it.
 *
 * Shared by every query-rule DB test that inserts `pages` rows directly —
 * three of them now — so "what the writer would have stored" is answered once.
 */
export function writerIndexable(s: IndexabilitySpec): boolean {
  const noindex = (v: string | undefined): boolean => /\bnoindex\b|\bnone\b/i.test(v ?? "");
  return (
    (s.statusCode ?? 200) === 200 &&
    (s.fetchClass ?? "ok") === "ok" &&
    !noindex(s.robotsMeta) &&
    !noindex(s.xRobotsTag)
  );
}

/**
 * The frontier key of a URL — `normalizeUrl`, the crawler's own function, not a
 * re-implementation of it.
 *
 * The join columns the crawl layer writes beside a published spelling
 * (`sitemap_urls.url_normalised`, `pages.redirect_url_normalised`) are computed
 * with exactly this, so a DB test that inserts rows directly stores what a
 * crawl would have stored. A URL that will not normalise throws here rather
 * than becoming an empty string no join could match, which would be a test
 * quietly asserting a rule's silence.
 */
export function normalised(value: string): string {
  const url = normalizeUrl(value);
  if (url === null) throw new Error(`test URL will not normalise: ${value}`);
  return url;
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

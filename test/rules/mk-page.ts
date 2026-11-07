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
  // THE OVERRIDDEN URL IS THE CLEAN PAGE'S URL, and the canonical below follows
  // it (Phase 22). A test that overrides `url` alone used to get a page whose
  // canonical named the DEFAULT address — which since the judged cohort means
  // "canonicalised elsewhere", and a page in that state is invisible to every
  // on-page, technical and content rule. "Clean" has to keep meaning clean
  // whichever address the test gives the page, or a rule would look silent
  // because of a default nobody wrote.
  const url = overrides.url ?? "https://example.com/page";
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
    h2Count: 1,
    h3Count: 1,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1, 2, 3],
    h1Text: "A perfectly reasonable page heading",
    wordCount: 400,
    // The clean page has some hidden chrome, like every real page, and plenty
    // of visible words all the same. It is what `content.soft-404`'s length
    // ceiling reads; `content.thin`'s floor reads `mainWordCount` below, since
    // Phase 19 §11.
    renderableWordCount: 380,
    // Not null: a null here is "this row predates Phase 7", which is a
    // different page from a clean one — `content.csr-dependent` refuses a
    // crawl of them. The clean page is a page a current crawl wrote.
    clickDepth: 2,
    textRatio: 0.4,
    contentHash: "0".repeat(64),
    simhash: 1234567890123456789n,
    // The main-content pair (migration 0018). The clean page is a page a
    // current crawl wrote, so both are set: it has content of its own, and less
    // of it than `word_count`, because it has chrome like every real page. A
    // null in either is "this row predates 0018", which is the crawl
    // `content.near-duplicate-skipped` and `content.thin-skipped` report — a
    // test about that gate overrides BOTH, since they are one measurement
    // written twice. 250 clears `THIN_WORDS`, so `content.thin` is silent on
    // the clean page for the reason it is meant to be.
    mainSimhash: 987654321098765432n,
    mainWordCount: 250,
    // Null because `hasLoremIpsum` is false. The two are one observation:
    // a test that sets the flag sets the quotation with it.
    placeholderSnippet: null,
    // Where the head ended (migration 0021). The clean page is a current
    // crawl's row: `</head>` closed it (null closer) and nothing came after.
    // A test about the pre-0021 null overrides all five flags.
    headClosedBy: null,
    titleOutsideHead: false,
    metaDescriptionOutsideHead: false,
    robotsOutsideHead: false,
    canonicalOutsideHead: false,
    hreflangOutsideHeadCount: 0,
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
    // P23-T6 (migration 0022): the three more values the render pass reads
    // from the post-JS DOM, and the flag that says it read them. Null for the
    // same reason as every render column above — this page was never rendered.
    renderedRobotsMeta: null,
    renderedMetaDescription: null,
    renderedH1Text: null,
    renderedTagsRead: null,
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
    // The clean page was written by the current extraction, with the five
    // security headers a clean HTTPS page sends (`security.*`, 26a), so none of
    // them is worth a finding; never rendered, so no render stamp or console.
    responseHeaders: {
      values: {
        "strict-transport-security": ["max-age=31536000"],
        "content-security-policy": ["default-src 'self'"],
        "x-content-type-options": ["nosniff"],
        "x-frame-options": ["DENY"],
        "referrer-policy": ["strict-origin-when-cross-origin"],
      },
      truncated: [],
    },
    // Extraction 3 (Phase 26c): a clean page carries a clean value for every
    // 26b and 26c fact, so no later rule fires on it. A v1 row (every new column
    // null) is `mkV1Page`.
    extractionVersion: 3,
    htmlLang: "en",
    social: {
      og: {
        title: "A perfectly reasonable share title",
        type: "website",
        image: `${url}/share.png`,
        url,
      },
      x: { card: "summary_large_image", title: "A perfectly reasonable share title" },
      counts: {
        "og:title": 1, "og:type": 1, "og:image": 1, "og:url": 1,
        "twitter:card": 1, "twitter:title": 1,
      },
      conflicting: [],
      outsideHead: false,
      xViaProperty: false,
      imageRefs: { og: `${url}/share.png`, x: null },
      imageRefTooLong: { og: false, x: false },
    },
    h2Text: "A short section heading",
    titleCount: 1,
    metaDescriptionCount: 1,
    robotsMetas: [],
    metaRefresh: null,
    anchorCounts: { noHref: 0, javascript: 0, hashOnly: 0, emptyHref: 0, unsafeBlank: 0 },
    insecureRefs: { iframe: 0, media: 0, formAction: 0, forms: 0, sample: [] },
    imagesEmptyAlt: 0,
    imagesAltTooLong: 0,
    imagesMissingAltSample: [],
    relNextCount: 0,
    relPrevCount: 0,
    htmlStructure: {
      htmlTags: 1, headTags: 1, bodyTags: 1, headBeforeBody: true, closedEarly: null,
    },
    // Always an object on a v3 row the analyzer wrote; zeros on a clean page.
    overlongUrls: { links: 0, resources: 0, hreflang: 0 },
    renderVersion: null,
    renderConsole: null,
    ...overrides,
  };
}

/**
 * A page row written by extraction 1: every Phase 26b column is null ("not
 * measured"). For the v1-silence tests: a v2 rule must say nothing on it.
 */
export function mkV1Page(overrides: Partial<PageRecord> = {}): PageRecord {
  return mkPage({
    extractionVersion: 1,
    htmlLang: null,
    social: null,
    h2Text: null,
    titleCount: null,
    metaDescriptionCount: null,
    robotsMetas: null,
    metaRefresh: null,
    anchorCounts: null,
    insecureRefs: null,
    imagesEmptyAlt: null,
    imagesAltTooLong: null,
    imagesMissingAltSample: null,
    relNextCount: null,
    relPrevCount: null,
    htmlStructure: null,
    overlongUrls: null,
    ...overrides,
  });
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
 * The two shapes a fetched, 200-answering page can be in and still not be
 * JUDGED (Phase 22 §1): it tells search engines to keep it out of the index, or
 * it hands its signals to another URL.
 *
 * The noindex shape sets BOTH the directive and the stored flag, because that
 * is what a crawl writes: `isIndexable` is `PageWriter`'s stamp of the same two
 * robots channels (src/crawl/persist.ts), and a row carrying one without the
 * other is a contradiction `indexabilityOf` refuses out loud.
 */
export const NOT_JUDGED_200S: Partial<PageRecord>[] = [
  { robotsMeta: "noindex, follow", isIndexable: false },
  { xRobotsTag: "noindex", isIndexable: false },
  { canonicalHtml: "https://example.com/somewhere-else" },
  { canonicalHtml: null, canonicalHeader: "https://example.com/somewhere-else" },
];

/**
 * `expectSilentOnNonOkFetches` for the judged cohort: assert that a set of
 * `isJudged`-guarded rules says nothing about a 200 that is noindexed or
 * canonicalised elsewhere — with the same vacuity guard, so the silence can
 * only come from the cohort and not from shapes that stopped firing.
 */
export function expectSilentOnNotJudged(
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
    for (const notJudged of NOT_JUDGED_200S) {
      for (const r of rules) {
        expect(
          r.run(mkPage({ ...shape, ...notJudged })),
          `${r.id} ${JSON.stringify(notJudged)}`,
        ).toHaveLength(0);
      }
    }
  }
}

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

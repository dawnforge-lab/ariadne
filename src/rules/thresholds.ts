/**
 * Every verdict threshold the rule engine applies, in one module.
 *
 * Values are unchanged from where they were first defined; each constant keeps
 * the docblock it was written with. The owning rule modules re-export these
 * bindings, so existing imports (the copy, the tests) resolve as before.
 * Batch sizes, sample caps and display caps are not thresholds and stay beside
 * the code that uses them.
 */

// ---- from src/rules/page/on-page.ts
/**
 * Thresholds. Exported because the client-facing copy quotes them and a test
 * asserts the prose against these constants: change one here and the copy test
 * fails until the sentence is changed with it.
 */
export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const META_MIN = 70;
export const META_MAX = 155;
export const H1_MAX = 70;
/** Measured on the stored `pages.url`, which is `normalizeUrl` output: the URL as the crawler normalised it, not the raw link text. */
export const URL_MAX = 115;
/**
 * The largest step a heading outline may take downwards: H2 to H3 is 1 and
 * fine, H2 to H4 is 2 and is the skip `headings.level-skip` reports. Exported
 * because the client-facing title states the number and the copy rubric pins
 * the two together (Phase 19 §7).
 */
export const HEADING_MAX_STEP = 1;

// ---- from src/rules/page/technical.ts
/**
 * Thresholds. Exported because the client-facing copy quotes them and a test
 * asserts the prose against these constants: change one here and the copy test
 * fails until the sentence is changed with it.
 */
/** Time to first byte, in ms, above which the response is reported as slow. */
export const SLOW_MS = 1500;

// ---- from src/rules/query/link-graph.ts
/**
 * Click depth above which a page is reported as buried — hops along internal
 * links from the home page, not hops through the crawler's frontier.
 *
 * Exported because the client-facing copy quotes the number and a test asserts
 * the prose against this constant: change it here and the copy test fails until
 * the sentence is changed with it. It moved from src/rules/page/technical.ts
 * with the rule (Phase 9).
 */
export const DEEP_DEPTH = 5;

// ---- from src/rules/query/redirects.ts
/**
 * How many pages one walk may visit. A redirect graph is a functional graph —
 * one target per page — so the only way to walk forever is a cycle, and the
 * cycle test below already stops those. The cap is here for the other case: a
 * chain long enough that reporting every hop helps nobody, and that would make
 * the recursive CTE's intermediate rows grow with the site.
 *
 * A chain cut short by the cap is reported with `chainTruncated: true`
 * rather than silently presented as if it ended there.
 */
export const MAX_REDIRECT_HOPS = 10;
/** A chain is worth reporting from this many redirect hops up. */
export const CHAIN_HOPS = 2;

// ---- from src/rules/query/content.ts
/**
 * Below this, a page carrying "page not found" wording is reported as one.
 *
 * Deliberately generous — well above `THIN_WORDS` — because the phrase alone is
 * not the finding. An article ABOUT broken links contains the same words and
 * runs to a thousand of them; a 404 rendered into the site's shell rarely
 * clears three hundred. Exported because the client-facing copy quotes it.
 */
export const SOFT_404_WORDS = 300;
/**
 * How close to the site's own 404 template a page may sit before it is one.
 *
 * Four bits out of sixty-four. A template rendered around different breadcrumbs
 * or a different `<title>` moves a handful of bits; genuinely different pages
 * sit thirty-odd apart (see the corpus assertions in the test), so the band
 * between the two is wide and nothing lives in it.
 */
export const TEMPLATE_HAMMING = 4;
/** How close two pages may sit before they are near-duplicates of each other. */
export const NEAR_DUPLICATE_HAMMING = 3;
/**
 * How much MAIN content a page must have of its own before it can be one half of
 * a near-duplicate pair. Both sides must clear it.
 *
 * Fifty words is the floor under which the question stops being answerable
 * rather than a judgement about quality. A simhash over a couple of dozen words
 * is dominated by a handful of tokens, so two pages carrying nothing but a
 * heading and a sentence land inside three bits of each other whenever the
 * heading pattern repeats — and on a templated site that is every empty
 * category, every out-of-stock product and every tag archive. Those pages are a
 * real problem and they have a rule: `content.thin`, below in this file, reports
 * them at a floor of `THIN_WORDS` words of their own. Reporting them a second
 * time as duplicates of one another says nothing new and buries the pages that
 * genuinely have near-identical content.
 *
 * It sits BELOW `THIN_WORDS` on purpose, and the gap is the point: a page
 * between 50 and 150 main words is thin AND can still be shown to be a copy of
 * another page, which is a sharper finding than either alone. Only below fifty
 * does the fingerprint stop carrying enough of the page to compare.
 */
export const NEAR_DUPLICATE_MIN_MAIN_WORDS = 50;
/**
 * The thin-content floor: below this many words of its OWN content, an
 * indexable page is reported (CHECK-40, CHECK-13).
 *
 * MOVED HERE FROM src/rules/page/on-page.ts with the rule (Phase 19 §11), so
 * the floor and the floor beneath it — `NEAR_DUPLICATE_MIN_MAIN_WORDS`, whose
 * docblock argues the gap between them — are one file apart no longer.
 * Exported because the client-facing copy quotes the number and
 * test/rules/copy.test.ts asserts the sentence against this constant.
 *
 * The number did not move in Phase 19; the QUANTITY it is applied to did. It
 * used to be `renderable_word_count` (the words the page's markup does not
 * hide) and is now `main_word_count` (the words that are not header,
 * navigation, sidebar or footer). On the crawl that provoked the amendment,
 * 35 pages have fewer than 150 words of their own and NOT ONE has fewer than
 * 150 renderable words — every page carries ~900 words of chrome — so the rule
 * fired on nothing at all while a third of the site's `/pages/*` URLs were
 * empty templates. That is the always-passes shape hard rule 1 forbids, and
 * the column is what was wrong with it.
 */
export const THIN_WORDS = 150;

// ---- from src/rules/query/render-diff.ts
/**
 * How many times the raw word count the rendered one must reach before the page
 * counts as client-side rendered.
 *
 * Doubling, rather than "more words after rendering": every page gains a few
 * words in a browser — a cookie banner, a live search box, a lazily inserted
 * breadcrumb — and a rule that fired on those would fire on every page of every
 * modern site. Twice the text is a different claim: most of what the page says
 * was not in the HTML.
 */
export const CSR_WORD_MULTIPLE = 2;
/**
 * …and the absolute floor beneath the ratio, in words.
 *
 * The ratio alone is unusable at the small end: an eight-word shell that
 * renders sixteen words has doubled and is still a page with nothing on it,
 * while `2 × 0` is satisfied by any page at all. 150 words is roughly a short
 * paragraph of real body copy — enough that "the content arrives with the
 * JavaScript" is a statement about the page's substance rather than about its
 * furniture. Both conditions must hold.
 */
export const CSR_MIN_ADDED_WORDS = 150;
/**
 * Raw nav + footer links BELOW this and the page's navigation is, as far as the
 * HTML says, not there. Exclusive: a page with exactly five is not reported.
 */
export const NAV_RAW_MAX = 5;
/** …and rendered nav + footer links AT OR ABOVE this is a real navigation. */
export const NAV_RENDERED_MIN = 10;
/** …and the ratio between the two sides. See `navJsOnlyFindings` for the margin. */
export const NAV_RENDERED_MULTIPLE = 2;
/**
 * Filter-looking links a rendered page must expose before a raw side of zero is
 * worth reporting. Five is a facet block; one or two is a sort control, which is
 * not the crawl-budget story CHECK-02 asks about.
 */
export const FILTER_RENDERED_MIN = 5;

// ---- from src/rules/query/structured-data.ts
/**
 * How many indexable 200 pages a site needs before "nothing here marks up a
 * breadcrumb trail" is worth saying.
 *
 * A five-page brochure site has no hierarchy to describe, and telling its owner
 * to add breadcrumb markup would be advice about a navigation structure they do
 * not have. Exported because the client-facing copy quotes it and the test
 * drives the floor from it rather than from a literal.
 */
export const BREADCRUMB_PAGE_FLOOR = 5;
/**
 * How many indexable 200 pages a crawl needs before "this site publishes no
 * structured data" is a statement about the site rather than about the crawl.
 *
 * One. The bar is deliberately at the bottom — the check is whether a site uses
 * structured data at all, and a single page is enough to have an answer — but it
 * is not zero: a crawl that read nothing has seen no markup and no absence of
 * markup either. See `noneOnSiteFindings` for what the floor does and does not
 * distinguish.
 */
export const NONE_PAGE_FLOOR = 1;

// ---- from src/rules/query/resources.ts
/**
 * The weight at which an image is worth reporting: 100,000 bytes.
 *
 * The checklist's own line — CHECK-49 evaluates `WARN if >100KB images on key
 * pages` — so the constant is the check's number rather than one we chose, and
 * the copy quotes it (the `DEEP_DEPTH` contract: change one, change both, and
 * `test/rules/copy.test.ts` fails until you do).
 *
 * Decimal 100,000 rather than 102,400: the checklist says 100KB in the sense a
 * client and a CDN dashboard mean it, and transferred bytes are what the pass
 * measured. The comparison is STRICTLY greater, so a file of exactly this size
 * is not reported — a threshold a rule fires ON is a threshold nobody can meet.
 */
export const IMAGE_WEIGHT_WARN = 100_000;

// ---- from src/rules/metric/crawl-metrics.ts
/**
 * The sitemaps protocol's per-document limit: 50,000 `<url>` entries. A
 * document past it is one search engines may read only the first 50,000 entries
 * of, which is why it is a column of this metric rather than a matter of taste.
 */
export const SITEMAP_URL_CAP = 50_000;

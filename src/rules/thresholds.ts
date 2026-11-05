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
/**
 * Time to first byte, in ms, above which the response is reported as slow.
 *
 * Not calibrated: Screaming Frog 25.1 has no response-time issue at its
 * default configuration (none in its Issues Overview or its tab filters; the
 * one latency item needs the PageSpeed API), so there is no boundary to read.
 * Its measured times on the 250 … 3,000 ms ladder match ours to within a few
 * milliseconds (docs/gates/phase-26a-calibration.md).
 */
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
 *
 * Not calibrated: Screaming Frog's crawl depths on the 1 … 10 chain match
 * ours exactly, but its "Pages With High Crawl Depth" filter came back empty
 * at every depth, consistent with its post-crawl analysis being off at the
 * configuration it starts with (docs/gates/phase-26a-calibration.md). Kept.
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

// ---- from src/rules/query/security.ts
/**
 * The `Referrer-Policy` values that send the full URL, query string included, to
 * a destination that is not the site's own, or to a less secure one: `unsafe-url`
 * always, `no-referrer-when-downgrade` to every https origin. A header that
 * names one of these is judged the same as an absent header, since it leaks what
 * the browser's own default (`strict-origin-when-cross-origin`) would not.
 *
 * When a header lists several policies the browser applies the LAST one it
 * understands, so the rule compares the last token.
 */
export const UNSAFE_REFERRER_POLICIES = ["unsafe-url", "no-referrer-when-downgrade"] as const;

// ---- from src/rules/page/directives.ts
/**
 * How far past a page's fetch an `unavailable_after` date may lie before the
 * page is reported. A date inside the window means the page leaves the index
 * within a month of the crawl that saw it, which is soon enough that nobody
 * should be finding out from a traffic drop. The comparison is strictly less
 * than, against the page's own `fetched_at` and not the wall clock, so
 * re-judging an old crawl gives the same answer.
 */
export const UNAVAILABLE_AFTER_WARN_DAYS = 30;

/**
 * The robots tokens that restrict how a result may look without removing the
 * page from the index: no snippet, no image preview, no image indexing. Each is
 * matched as a whole token, and `max-snippet:0` exactly, so `max-snippet:-1`
 * (no limit) and `max-snippet:50` do not count.
 */
export const RESTRICTIVE_DIRECTIVES = [
  "nosnippet",
  "max-snippet:0",
  "max-image-preview:none",
  "noimageindex",
] as const;

// ---- from src/rules/query/canonical-graph.ts
/**
 * How many canonical hops `canonical.chain` follows from a page before it
 * stops and says so (`hopLimitReached`). A chain of ten is already far past what
 * a search engine is documented to follow, and the walk costs one query per
 * hop per batch, so the limit is also what bounds the work. A cycle that is
 * longer than this is not recognised as a cycle: the walk stops at the limit
 * first.
 */
export const CANONICAL_MAX_HOPS = 10;

// ---- from src/rules/query/pagination.ts
/**
 * How many `rel=next` steps `pagination.loop` follows from a page before it
 * stops. A page is in a loop when the walk comes back to it inside this many
 * steps, so a loop longer than the limit is not recognised: the walk stops
 * first. Long archives exist, so the limit bounds the work and is not a claim
 * about series length: the walk starts from every page of the crawl, so its
 * cost is at most pages times this limit.
 */
export const PAGINATION_WALK_MAX = 500;

// ---- from src/rules/query/link-hygiene.ts
/**
 * Anchor texts `links.non-descriptive-anchor` calls generic: English, lower
 * case, compared after the anchor is trimmed, lower-cased and its runs of
 * whitespace are collapsed to one space. The whole anchor must equal an entry,
 * so "read more about pricing" is not generic and "Read  More" is. Other
 * languages are not judged: a list of generic phrases in a language the rule
 * has no entries for would be a claim the rule cannot back.
 */
export const NON_DESCRIPTIVE_ANCHORS = [
  "click here",
  "click",
  "here",
  "read more",
  "more",
  "learn more",
  "find out more",
  "continue reading",
  "continue",
  "see more",
  "view more",
  "more info",
  "more information",
  "details",
  "this page",
  "this",
  "link",
  "go",
  "website",
] as const;

/**
 * Distinct internal link targets on one page above which
 * `links.high-outlinks` fires. Strictly greater: a page with exactly this many
 * is not reported.
 *
 * Confirmed, not moved: Screaming Frog flags the ladder rung with 1,001
 * distinct internal targets and not the one with 1,000, the same boundary as
 * the starting value.
 * calibrated against Screaming Frog 25.1 defaults, 2026-11-05 (docs/gates/phase-26a-calibration.md)
 */
export const HIGH_INTERNAL_OUTLINKS = 1000;

/**
 * Distinct external link targets on one page above which `links.high-outlinks`
 * fires. Strictly greater: a page with exactly this many is not reported.
 *
 * Moved from the starting value of 100: Screaming Frog flags the ladder rung
 * with 11 distinct external targets and not the one with 10 (every count from
 * 11 to 25 is on the ladder and every one is flagged).
 * calibrated against Screaming Frog 25.1 defaults, 2026-11-05 (docs/gates/phase-26a-calibration.md)
 */
export const HIGH_EXTERNAL_OUTLINKS = 10;

/**
 * Query keys `url.internal-search` reads as a site search, compared whole and
 * case-sensitively: `?S=` and `?search_tips=` are other parameters.
 */
export const INTERNAL_SEARCH_PARAMS = ["s", "q", "query", "search", "keyword", "keywords"] as const;

/**
 * A path segment that is exactly `search`, case-insensitively: `/search`,
 * `/en/Search/shoes`, not `/search-tips` or `/researching`.
 */
export const INTERNAL_SEARCH_PATH = /(?:^|\/)search(?:\/|$)/i;

// ---- from src/rules/query/sitemap-entries.ts
/**
 * The longest `<loc>` Google accepts in a sitemap: 2,048 characters. The
 * sitemaps protocol allows less than that nowhere, and a longer entry is one a
 * search engine may drop or truncate. Compared in characters, strictly greater,
 * so an entry of exactly this length is not reported.
 */
export const SITEMAP_LOC_MAX = 2048;

/**
 * The W3C date-time profile the sitemaps protocol names for `<lastmod>`: a
 * year, a year and month, a date, or a date with a time that carries a zone
 * designator (`Z` or `+hh:mm`), with optional seconds and fractional seconds.
 * A date-time with no zone designator is not in the profile.
 *
 * One anchored pattern, tested in Postgres with `~` (a JS source string is a
 * valid POSIX ARE for these constructs). It checks the SHAPE and the month,
 * day, hour and minute ranges; whether the day exists in that month (30
 * February) is the database's own `timestamptz` parse, in the rule.
 */
export const W3C_DATETIME =
  /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?)?)?$/;

// ---- from src/rules/page/pixel-width.ts
/**
 * The pixel bounds of a search-result title and description, measured by
 * `serpWidth` (20px and 14px Arial, the font a result is drawn in). The
 * client-facing copy quotes them, so a change here fails the copy test until
 * the sentence is changed with it.
 *
 * All four are strict: a value exactly on a bound is not reported.
 *
 * Confirmed, not moved. Screaming Frog names these four numbers in its own
 * filters (Over 561 / Below 200 Pixels, Over 985 / Below 400 Pixels), and its
 * ladder boundaries agree in its own measure: descriptions 985 not flagged and
 * 986 flagged, 397 flagged and 400 not; titles 558 not flagged and 562
 * flagged, 199 flagged and 203 not. Its DESCRIPTION widths match `serpWidth`
 * within 2 px; its TITLE widths run 0–12 px wider than ours on the ladder's
 * strings, so a title within a few pixels of a bound can be flagged by one
 * tool and not the other. That is the measurement, not the bound, and the
 * table stays ours (spec: measured by us, nothing copied).
 * calibrated against Screaming Frog 25.1 defaults, 2026-11-05 (docs/gates/phase-26a-calibration.md)
 */
export const TITLE_PX_MAX = 561;
export const TITLE_PX_MIN = 200;
export const META_PX_MAX = 985;
export const META_PX_MIN = 400;

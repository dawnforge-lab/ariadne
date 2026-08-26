/**
 * Issue copy adapted from:
 *  - seonaut (MIT), translations/translation.en.yaml
 *    @ 880b312c28fab8b0bf7fe4f9449dc4746dbb82ff (ERROR_* titles + _DESC explanations)
 *  - open-seo (MIT), src/shared/audit-issues.ts
 *    @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070 (severity, explanation, howToFix descriptors)
 * Changes: keyed by Ariadne rule ids; overlapping issues keep the richer text
 * (per docs/crawl-audit-build-plan.md P2-T2); howToFix authored where neither
 * upstream provides one.
 *
 * Every string here is client-facing: it reaches a report or an action plan
 * verbatim. Two standing constraints on edits:
 *
 *  1. Say only what the rule actually detects. The rule tables in
 *     docs/superpowers/plans/2026-08-25-phase-2-page-rules.md are the contract;
 *     copy that promises more than the analyzer measures is a defect, not a
 *     flourish. Three that have bitten us are marked inline below
 *     (content.placeholder, images.missing-dimensions, mobile.viewport-missing).
 *  2. Thresholds quoted in prose must match the constants in the rules
 *     (title 10-60, meta description 70-160, thin content 150 words, slow
 *     response 1500ms, deep page depth 5). Change one, change both.
 */

export interface IssueCopy {
  title: string;
  explanation: string;
  howToFix: string;
}

export const ISSUE_COPY: Record<string, IssueCopy> = {
  // ---------------------------------------------------------------- on-page
  "title.missing": {
    title: "Missing title tag",
    explanation:
      "The page has no title tag. The title is one of the strongest on-page relevance signals and the headline shown in search results; without one, search engines write their own from page text, usually badly.",
    howToFix:
      "Add a unique, descriptive title of roughly 30-60 characters that names the page's main topic and, where it reads naturally, the brand.",
  },
  "title.too-short": {
    title: "Title too short",
    explanation:
      "The title is under 10 characters. Titles that short are almost always too generic to describe the page or to earn a click, and they waste the most valuable text you control in the search result.",
    howToFix:
      "Expand the title into a descriptive phrase of roughly 30-60 characters stating what the page offers, rather than a single word or a bare brand name.",
  },
  "title.too-long": {
    title: "Title too long",
    explanation:
      "The title is over 60 characters. Long titles do not hurt relevance, but search results truncate them, so the ending is cut off mid-phrase and any message you put at the end is lost.",
    howToFix:
      "Shorten the title to 60 characters or fewer, front-loading the words that matter most and moving boilerplate such as the site name to the end (or dropping it).",
  },
  "meta-description.missing": {
    title: "Missing meta description",
    explanation:
      "The page has no meta description. It is not a ranking factor, but search engines use it for the snippet under the link; with none, they assemble a snippet from page text, which is often less compelling and depresses click-through rate.",
    howToFix:
      "Add a meta description of 70-160 characters that summarises the page and gives a reason to click. Write one per page rather than repeating a site-wide default.",
  },
  "meta-description.too-short": {
    title: "Meta description too short",
    explanation:
      "The meta description is under 70 characters. Short descriptions waste the snippet space search results give you, and search engines frequently ignore them in favour of text pulled from the page.",
    howToFix:
      "Expand the description to 70-160 characters covering what the page is about and why the reader should open it.",
  },
  "meta-description.too-long": {
    title: "Meta description too long",
    explanation:
      "The meta description is over 160 characters, so search engines will truncate the snippet and the closing sentence will not be read.",
    howToFix:
      "Trim the description to 160 characters or fewer, keeping the core message and the call to action in the first sentence.",
  },
  "headings.h1-missing": {
    title: "Missing H1 heading",
    explanation:
      "The page has no H1. The H1 states the main topic for both readers and search engines, and it is the first landmark screen-reader users jump to; without one, the page's subject has to be inferred from weaker signals.",
    howToFix:
      "Add a single H1 that states the page's main topic, consistent with the title tag. If the visual headline is already there but marked up as a div or a styled span, change the element rather than adding a second heading.",
  },
  "headings.h1-multiple": {
    title: "Multiple H1 headings",
    explanation:
      "The page has more than one H1, which dilutes the main-topic signal and usually points to a templating mistake, such as a logo and a headline both marked up as H1.",
    howToFix:
      "Keep one H1 for the page's main heading and demote the rest to H2 or H3. Elements that are not headings at all, such as a logo, should use a non-heading element.",
  },
  "headings.level-skip": {
    title: "Heading levels skip",
    explanation:
      "The heading hierarchy jumps a level, for example an H4 directly under an H2. The outline is how assistive technology and content parsers understand the structure of a page, and a skipped level breaks that outline.",
    howToFix:
      "Adjust the heading levels so they descend one step at a time. Where a level was skipped for the sake of a smaller font, fix the styling instead of the heading level.",
  },
  "content.thin": {
    title: "Thin content",
    explanation:
      "This indexable page has fewer than 150 words of visible text. Thin pages rarely rank on their own, weigh on how the site is assessed as a whole, and on a JavaScript-rendered site often mean the real content never reached the HTML a crawler sees.",
    howToFix:
      "Expand the page with content that answers the query it targets, consolidate it into a stronger page, or mark it noindex if it exists for another reason. If the copy is there for a browser but not in the HTML, server-render or pre-render it.",
  },
  "content.placeholder": {
    // Accuracy: the analyzer matches the literal phrase "lorem ipsum" in
    // visible text. It is not a general placeholder detector — do not let this
    // copy imply that "TBC", "TODO" or dummy names are covered.
    title: "Placeholder text in page content",
    explanation:
      'The page\'s visible text contains the phrase "lorem ipsum", which almost always means unfinished template copy shipped to production. Search engines index it, readers see it, and it undermines trust in everything else on the page.',
    howToFix:
      "Replace the placeholder with the real copy, or unpublish the page until the copy exists. It is worth grepping the CMS for the same phrase, as placeholder text usually ships in batches.",
  },

  // ----------------------------------------------------------------- status
  "http.server-error": {
    title: "Server error (5xx)",
    explanation:
      "The URL returned a 5xx server error instead of a page, so nobody, crawlers included, can read it. Search engines that repeatedly see server errors slow their crawling of the site and eventually drop the affected pages from the index.",
    howToFix:
      "Check the server and application logs for this URL and fix the underlying error. If the page is genuinely gone, return a 404 or 410, or redirect it to the closest live page, rather than leaving it erroring.",
  },
  "crawl.blocked": {
    title: "Crawler was blocked",
    explanation:
      "The site answered with a bot challenge or an access denial (a 401, 403, 429, or a challenge interstitial) instead of the page. We report that honestly rather than treating the page as broken, but it could not be audited, and search engine crawlers may hit the same wall.",
    howToFix:
      'Allowlist the user agent this crawl sent ("AriadneBot" unless it was overridden) in your WAF or bot-protection settings, then re-run the crawl. If the block is deliberate and applies to search engine crawlers too, confirm that these URLs are meant to be unreachable.',
  },

  // -------------------------------------------------------------- canonical
  "canonical.missing": {
    title: "No canonical URL declared",
    explanation:
      "This indexable page declares no canonical URL — not in the HTML head, not in the HTTP Link header. Search engines then pick a canonical themselves, and on sites that generate URL variants (parameters, trailing slashes, www and apex) they regularly pick the wrong one and split the page's signals across duplicates.",
    howToFix:
      "Add a self-referencing canonical with the page's absolute preferred URL, ideally from the template so every page in this section gets one.",
  },
  "canonical.points-elsewhere": {
    title: "Canonicalised to another URL",
    explanation:
      "The page declares a different URL as its canonical, which tells search engines to index that URL and not this one. That is correct for parameter and syndicated variants, and a real problem when the page was meant to rank on its own.",
    howToFix:
      "If this page should rank, point its canonical at itself. If the canonical is intentional, check that the target returns a 200 and is itself canonical. A canonical value we could not resolve to a URL at all is malformed and should be replaced with an absolute URL.",
  },
  "canonical.multiple": {
    title: "Multiple canonical tags",
    explanation:
      "The page declares more than one canonical URL. Search engines cannot tell which one is meant and commonly ignore all of them, choosing their own preferred version instead.",
    howToFix:
      "Leave exactly one canonical declaration on the page. Duplicates usually come from a template and a plugin (or an SEO module) each emitting one, so remove it at whichever layer should not own it.",
  },
  "canonical.html-header-conflict": {
    title: "Conflicting canonical signals",
    explanation:
      "The page declares one canonical URL in its HTML and a different one in its HTTP Link header. Contradictory signals are usually discarded, leaving the search engine to choose a canonical on its own.",
    howToFix:
      "Decide which URL is canonical and declare it in one place only — the HTML head is the usual choice — then remove or align the other declaration.",
  },
  "canonical.cross-domain": {
    title: "Canonical points to another host",
    explanation:
      "The canonical URL is on a different host from the page. That is deliberate for syndicated content, and a serious error when it is not: it hands the page's ranking signals to another host and asks search engines to drop this URL. Note that www and apex count as different hosts here.",
    howToFix:
      "Confirm the cross-host canonical is intended. If it is not, point the canonical at this page on this host. If the difference is only www versus apex, fix the canonical to match the host you actually serve and redirect the other.",
  },
  "directive.canonical-noindex-conflict": {
    title: "Canonical and noindex conflict",
    explanation:
      "The page carries a noindex directive while also canonicalising to a different URL. The two instructions contradict each other: the canonical says to consolidate signals into another page, the noindex says to drop this one entirely. Search engines resolve the contradiction however they see fit, so the outcome is unpredictable.",
    howToFix:
      "Pick one intent. To consolidate into the canonical target, remove the noindex. To keep the page out of the index, remove the canonical (or make it self-referencing) and leave the noindex.",
  },

  // ----------------------------------------------------------- indexability
  "indexability.noindex": {
    title: "Page is noindex",
    explanation:
      "The page tells search engines not to index it, through a robots meta tag or an X-Robots-Tag header. That is often intentional for admin, thank-you, and filtered pages — this is a statement of fact, not an error.",
    howToFix:
      "No action is needed if the exclusion is deliberate. If the page is meant to rank, remove the noindex directive from wherever it is set and request re-indexing.",
  },
  "indexability.meta-header-conflict": {
    title: "Robots meta and header disagree",
    explanation:
      "The robots meta tag and the X-Robots-Tag header both apply to this page and give different indexing instructions. Search engines resolve conflicting robots directives by taking the most restrictive one, so the page is very likely treated as noindex whichever source was meant to win.",
    howToFix:
      "Set the robots directive in one place only. Decide whether the page should be indexed, apply that in the template or the server config, and remove the other declaration.",
  },

  // --------------------------------------------------------------- hreflang
  "hreflang.invalid-code": {
    title: "Invalid hreflang code",
    explanation:
      "An hreflang declaration on this page uses a value that is not a valid language or language-region code. Search engines discard annotations they cannot parse, so the alternate it points at is ignored and the wrong language version can be served.",
    howToFix:
      'Use a valid code: a two- or three-letter language, optionally followed by a region — "en", "en-gb", "es-419". Region codes are countries, not languages, and "x-default" is the only special value.',
  },
  "hreflang.missing-x-default": {
    title: "No x-default hreflang declared",
    explanation:
      'This crawl found hreflang annotations, but none of them declares "x-default". The x-default value names the version to serve when a visitor matches no other language or region, and without it those visitors are matched by guesswork.',
    howToFix:
      'Add an "x-default" hreflang pointing at the fallback version — usually the international or language-selector page — to the same hreflang cluster that carries the other annotations.',
  },

  // -------------------------------------------------------------- technical
  "mobile.viewport-missing": {
    // Accuracy: the rule fires only when no viewport meta tag exists. It says
    // nothing about whether an existing one is configured sensibly.
    title: "Missing viewport meta tag",
    explanation:
      "The page has no viewport meta tag. Mobile browsers then lay the page out at a default desktop width and zoom it out to fit, so text is small, tap targets are cramped, and responsive CSS never takes effect.",
    howToFix:
      'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head, normally in the site-wide template so every page inherits it.',
  },
  "images.missing-dimensions": {
    // Accuracy: this counts images whose width or height ATTRIBUTE is absent.
    // An empty attribute counts as present, and CSS aspect-ratio can already
    // be reserving the space — so describe the missing attribute, and do not
    // assert that layout shift is actually happening.
    title: "Images missing width or height attributes",
    explanation:
      "One or more images on the page are missing a width or height attribute. Without dimensions in the HTML, the browser cannot reserve space for the image before it loads, and the page can shift under the reader as images arrive — unless the space is already reserved in CSS.",
    howToFix:
      "Set width and height attributes on img elements to the image's intrinsic pixel dimensions; CSS can still resize it. An equivalent aspect-ratio in CSS also reserves the space, so verify against the rendered page before treating this as a defect.",
  },
  "images.missing-alt": {
    title: "Images missing alt text",
    explanation:
      "One or more images on the page have no alt attribute. Alt text is what screen-reader users get in place of the image and it is the main way search engines understand what an image shows, so a missing attribute is both an accessibility failure and a lost signal.",
    howToFix:
      'Give every meaningful image alt text describing what it conveys. Use an empty alt ("") for purely decorative ones — that is the correct value, and it is not the same as omitting the attribute.',
  },
  "performance.slow-response": {
    title: "Slow server response",
    explanation:
      "The HTML response took more than 1500ms to arrive. Every downstream loading metric starts from that number, so a slow first byte delays everything the reader sees, and on large sites it directly reduces how much a search engine crawls per visit.",
    howToFix:
      "Look at server and database time for this route rather than at the front end: serving cached or statically generated HTML usually fixes it. Rule out a cold cache or an unwarmed instance by re-testing before investing in the route.",
  },
  "structure.deep-page": {
    title: "Page is deep in the site structure",
    explanation:
      "The page sits more than 5 links deep from where the crawl started. Depth is one of the ways crawlers and readers judge importance: deep pages get crawled less often, receive less internal link equity, and are harder to browse to.",
    howToFix:
      "Link to the page from higher-level pages — a hub, a category, or navigation — so the path to it is shorter. If it is not important enough to link from higher up, the honest answer may be to consolidate or remove it.",
  },
};

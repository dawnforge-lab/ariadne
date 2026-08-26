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
    // Accuracy: multiple H1s are valid HTML and are not a ranking problem.
    // Report the outline and the likely templating accident — do not claim a
    // diluted signal or a penalty.
    title: "Multiple H1 headings",
    explanation:
      "The page has more than one H1. That is valid HTML and can be deliberate in a sectioned document, but on most templates it is an accident — a logo and a headline both marked up as H1 — and it leaves the outline with no single heading that names the page's subject.",
    howToFix:
      "If the extra H1s are accidental, keep one for the page's main heading and demote the rest to H2 or H3; elements that are not headings at all, such as a logo, should use a non-heading element. If the sectioning is deliberate, no change is needed.",
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

  // The two canonical-TARGET rules below are query rules: they judge the page
  // the canonical points at, which only a look at the other page's crawl row
  // can answer. Both stay silent when that URL was never crawled — the copy
  // must not imply we checked a URL we never fetched.
  "canonical.non-200-target": {
    title: "Canonical points to a URL that does not return 200",
    explanation:
      "This page's canonical URL was crawled and did not answer with a 200 OK — it redirects, errors, or is not there. A canonical asks search engines to consolidate this page's ranking signals into that URL, so when the target does not serve a page, the consolidation has nowhere to land and both URLs can end up out of the index.",
    howToFix:
      "Point the canonical at the URL that actually serves the content with a 200. If the target redirects, canonicalise straight to its destination rather than to the redirect; if it has gone, canonicalise the page to itself or to the closest live replacement.",
  },
  "canonical.non-indexable-target": {
    title: "Canonical points to a page excluded from the index",
    explanation:
      "This page's canonical URL was crawled and answers normally, but it tells search engines not to index it (a noindex in its robots meta tag or X-Robots-Tag header). The page is asking for its signals to be consolidated into a URL that has opted out of the index, so neither URL is left as an indexable home for the content.",
    howToFix:
      "Decide which URL should rank. If it is the target, remove the noindex from it. If it is this page, point the canonical at itself and leave the other page excluded.",
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

  // ---------------------------------------------------------------- redirects
  "redirect.chain": {
    title: "Redirect chain",
    explanation:
      "This URL redirects to another URL that redirects again, so reaching the destination takes several round trips instead of one. Every hop costs the visitor time and the crawler a request, and chains are fragile: remove a middle hop and the whole path breaks. Search engines follow a limited number of hops before giving up on the URL entirely.",
    howToFix:
      "Repoint the first redirect straight at the final destination, so one hop replaces the chain, and do the same for any other rule that feeds into it. Then update the internal links, sitemap entries and canonicals that still name the old URL, so most visits skip the redirect altogether.",
  },
  "redirect.loop": {
    title: "Redirect loop",
    explanation:
      "Following this URL's redirects comes back to a URL already visited, so the redirects never resolve. Nobody can reach the content: browsers stop with a redirect error, and search engines drop the URLs involved. Loops usually come from two rules fighting each other — a trailing-slash rule against an HTTPS or locale rule, for example — or from a page redirecting to itself.",
    howToFix:
      "Trace the rules that generate each hop in the loop and decide which URL is the destination, then make every other URL redirect to it directly and stop it redirecting onward. Test the entry URL with redirects followed to confirm it now ends on a 200.",
  },

  // -------------------------------------------------------------------- links
  "links.broken-internal": {
    title: "Internal links point to a URL that returns an error",
    explanation:
      "Pages on this site link to a URL that answered with a 4xx error, so every one of those links is a dead end. Visitors who click get an error page, and the crawler spends a request on nothing and passes no value on to a working page. This is reported once for the broken target, with a count of how many pages link to it and a sample of them, because the fix is at the target, not on each linking page.",
    howToFix:
      "If the URL should exist, restore it or redirect it to its replacement. If it should not, update the links to point at the right page — or remove them. Fixing the target once repairs every link listed here.",
  },
  // This rule speaks for two outcomes: a page with no inbound links, and the
  // crawl declining to answer at all (an unfinished crawl cannot tell an orphan
  // from a page whose linking pages were never fetched). The copy has to cover
  // the finding, not the skip — the skipped finding carries its reason in its
  // own evidence.
  "links.orphan": {
    title: "Page has no internal links pointing to it",
    explanation:
      "This indexable page was crawled, and no other page on the site links to it. Search engines find and weigh pages largely through internal links, so an orphan is crawled rarely, receives no link equity from the rest of the site, and cannot be reached by anyone browsing. A page listed in the sitemap but linked from nowhere is still an orphan: the sitemap tells a crawler the URL exists, not that the page matters.",
    howToFix:
      "Link to the page from somewhere it belongs — a hub or category page, the navigation, or a related article — so both readers and crawlers have a path to it. If nothing on the site has a reason to link to it, that is the answer to whether the page should stay: consolidate it into a page that does earn links, or remove it.",
  },

  // --------------------------------------------------------------- hreflang
  "hreflang.invalid-code": {
    title: "Invalid hreflang code",
    explanation:
      "An hreflang declaration on this page uses a value that is not a valid language or language-region code. Search engines discard annotations they cannot parse, so the alternate it points at is ignored and the wrong language version can be served.",
    howToFix:
      'Use a valid code: a two- or three-letter language, optionally followed by a region — "en", "en-gb", "es-419". Region codes are countries, not languages, and "x-default" is the only special value.',
  },
  // Per SET, not per site and not per page: the finding names one cluster of
  // alternates, reported once however many pages declare it. The copy must not
  // say "this page" or "this site".
  "hreflang.missing-x-default": {
    title: "Hreflang cluster declares no x-default",
    explanation:
      'This set of hreflang alternates names two or more versions of the page and none of them is "x-default". The x-default value names the version to serve when a visitor matches no other language or region, and without it those visitors are matched by guesswork — usually landing on whichever version the search engine considers primary rather than the one you would have chosen.',
    howToFix:
      'Add an "x-default" alternate to this cluster, pointing at the fallback version — usually the international English page or a language selector. The annotation belongs on every page in the cluster, alongside the alternates already there, so it is normally a one-line change in the template that generates them.',
  },
  "hreflang.missing-return-link": {
    title: "Hreflang alternate does not point back",
    explanation:
      "This page names another page as its language alternate, that page was crawled, and it does not name this one in return. Hreflang annotations are only honoured when they are reciprocal: a one-way annotation is discarded, so the alternate is ignored and visitors keep being served the wrong language version.",
    howToFix:
      "Make the annotations symmetrical. Every page in a cluster should declare the same full set of alternates, including itself, so each version confirms the others. Generating the block once from a single mapping and rendering it on every page in the cluster is what stops this recurring.",
  },
  "hreflang.non-indexable-target": {
    title: "Hreflang alternate points to a page search engines cannot serve",
    explanation:
      "This page names a language alternate whose URL was crawled and either redirects or is excluded from the index. An hreflang cluster is a set of pages a search engine can choose between, so an alternate that does not serve a page at its own URL cannot be chosen, and the annotation naming it is dropped along with the version it was meant to offer.",
    howToFix:
      "Point the annotation at the URL that actually serves that language version with a 200, rather than at a redirect to it. If the target is deliberately excluded from the index, it does not belong in the cluster — remove the annotation, or remove the exclusion if the page was meant to rank.",
  },

  // ------------------------------------------------------------- pagination
  // Accuracy note for all three: Google stopped using rel=next/rel=prev as a
  // discovery or consolidation signal in 2019. The copy may say the markup
  // documents the series and that the HTML links are what crawlers follow; it
  // must not claim the annotations themselves still consolidate pages.
  "pagination.next-target-uncrawled": {
    title: "Next page in the series was not crawled",
    explanation:
      "This page declares a rel=next pointing at the following page of the series, and this crawl has no record of that URL. Most often the series simply runs past the edge of the crawl, which is not a fault; the other explanations are a stale rel=next left behind after the series shrank, or a value that is not a usable URL at all. This is a statement about what the crawl saw, not a verdict.",
    howToFix:
      "Nothing to do if the crawl was bounded and the series continues past it. If the URL is wrong or the page it names no longer exists, correct the rel=next in the template that generates the series so it names the page that follows.",
  },
  "pagination.next-not-linked": {
    title: "Later page of a series is reachable only through rel=next",
    explanation:
      "This page's rel=next names a page that was crawled, and no page on the site has an HTML link to it. Crawlers follow links; rel=next has not been used for discovery since 2019, so a series wired together only by these annotations leaves its later pages with no path in and no internal link equity, however many items they hold.",
    howToFix:
      "Render real anchor links for the pagination — next, previous, and the page numbers — rather than relying on rel=next or on a script that builds the links after load. Where the pagination is a JavaScript control, make sure a crawlable link with an href ships in the HTML alongside it.",
  },
  "pagination.canonical-to-other": {
    title: "Paginated page canonicalises to another URL",
    explanation:
      "This page is part of a series — it declares a rel=prev — and its canonical names a different URL, usually the first page. That is a deliberate choice with a real cost either way: consolidating the series onto page 1 asks search engines to ignore everything the later pages list, while a self-referencing canonical keeps them indexable at the price of near-duplicate listing pages. Which is right depends on whether the deeper pages hold content worth finding on its own.",
    howToFix:
      "Decide what the deeper pages are for. If their items should be findable, canonicalise each page to itself and let the series be indexed. If the series exists only to browse a single collection, keep the canonical on page 1 and make sure the items themselves are reachable and indexable through their own pages.",
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
      "This indexable page sits more than 5 links deep from where the crawl started. Depth is one of the ways crawlers and readers judge importance: deep pages get crawled less often, receive less internal link equity, and are harder to browse to. Pages excluded from the index are not reported here — their depth costs nothing.",
    howToFix:
      "Link to the page from higher-level pages — a hub, a category, or navigation — so the path to it is shorter. If it is not important enough to link from higher up, the honest answer may be to consolidate or remove it.",
  },
};

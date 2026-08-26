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
  // Two rule ids for one check, because copy is looked up by rule id: the
  // orphan finding and the statement that the check could not be run are
  // different things to tell a client, and rendering the second under the
  // first's title would be a lie.
  "links.orphan": {
    title: "Page has no internal links pointing to it",
    explanation:
      "This indexable page was crawled, and no other page on the site links to it — a link the page makes to itself does not count. Search engines find and weigh pages largely through internal links, so an orphan is crawled rarely, receives no link equity from the rest of the site, and cannot be reached by anyone browsing. A page listed in the sitemap but linked from nowhere is still an orphan: the sitemap tells a crawler the URL exists, not that the page matters. Where the crawl could not fetch some URLs, the finding carries a caveat naming how many: their outgoing links were never read, so one of them may link here.",
    howToFix:
      "Link to the page from somewhere it belongs — a hub or category page, the navigation, or a related article — so both readers and crawlers have a path to it. If nothing on the site has a reason to link to it, that is the answer to whether the page should stay: consolidate it into a page that does earn links, or remove it. If the finding carries a caveat about failed URLs, confirm those pages before acting on it.",
  },
  "links.orphan-skipped": {
    title: "Orphan-page check could not be run on this crawl",
    explanation:
      "The check for pages with no internal links needs a crawl that reached every URL it knew about, because \"nothing links to this page\" and \"the page that links to it was never fetched\" look identical afterwards. This crawl did not finish that way — the finding names the reason, which is either URLs left unfetched or a crawl stopped at its configured page limit — so the check was not run rather than reporting the crawl's own limits as faults on the site.",
    howToFix:
      "Re-run or resume the crawl so the queue drains: raise the page limit if the crawl stopped at its cap, and give it a wider limit than the site's known page count. Once a crawl completes with an empty queue, the orphan check runs on its own.",
  },

  // -------------------------------------------------------------- robots.txt
  // Three ids for one check, and the third is the reason the split exists:
  // "we could not read your robots.txt well enough to judge it" cannot be
  // rendered under either of the other two titles without saying something
  // untrue. Accuracy note for `robots.missing`: the rule fires only when the
  // site ANSWERED that there is no robots.txt (a 4xx). It must not be worded
  // as though a server error also means the file is absent.
  "robots.missing": {
    title: "Site has no robots.txt",
    explanation:
      "The site answered the request for /robots.txt with a not-found response, so there is no robots.txt. That is valid and means crawlers may fetch everything, which is often exactly right for a small site. What is lost is the file's other job: it is where search engines look for the sitemap declaration, and where you would exclude anything that should not be crawled.",
    howToFix:
      "Add a robots.txt at the site root if you have anything to say in it — at minimum a Sitemap: line pointing at your sitemap, which is how crawlers find it without being told. Leave the crawling rules permissive unless there is a section that genuinely should not be fetched; blocking pages here does not keep them out of the index.",
  },
  "robots.blocks-sitemap-urls": {
    title: "robots.txt blocks URLs the sitemap lists",
    explanation:
      "The site's robots.txt disallows URLs that its own sitemap publishes, so the two files contradict each other: the sitemap invites crawlers to these pages and robots.txt forbids fetching them. A blocked URL cannot be read, so it is not indexed on its own merits — at best it appears as a bare URL with no title or description. The finding names the URL and the line of robots.txt that blocks it, judged for the user agent this crawl identified as.",
    howToFix:
      "Decide which file is right. If the pages should be found, narrow or remove the Disallow rule that covers them. If they should not, take them out of the sitemap — and if the aim is to keep them out of the index rather than out of the crawl, use a noindex directive on the page instead, which only works if crawlers are allowed to fetch it.",
  },
  "robots.check-skipped": {
    title: "robots.txt checks could not be run on this crawl",
    explanation:
      "The checks that read the contents of robots.txt — whether it blocks URLs the sitemap lists, and whether it declares a sitemap — need the whole file. This crawl does not have it: either the file is larger than the 500KB this crawler reads, so what was stored is a prefix, or the server never served it. Concluding from a partial file would mean reporting every rule past the cut-off as absent, so the checks did not run rather than reporting an answer this crawl cannot stand behind.",
    howToFix:
      "If robots.txt is over 500KB, that is itself worth fixing: search engines apply their own size limits and ignore whatever falls past them, so the rules at the end of the file are not being honoured either. Cut it down to the directives that matter. If the file could not be fetched at all, fix the server error and re-run the crawl.",
  },

  // ----------------------------------------------------------------- sitemap
  // Accuracy note for `sitemap.missing`: this engine does not guess at
  // /sitemap.xml. The only sitemaps it knows about are the ones robots.txt
  // declares, so the copy says "not declared in robots.txt" and must never say
  // "the site has no sitemap" — the site may well have one nobody points at.
  "sitemap.missing": {
    title: "No sitemap is declared in robots.txt",
    explanation:
      "The site's robots.txt contains no Sitemap: line, so nothing tells a crawler where the sitemap is. The site may still have one — this is a statement about the declaration, not about the file — but a sitemap that is never announced is one search engines have to be told about by hand, and one that no crawler, including this one, can find on its own. A declared sitemap is the cheapest way to tell search engines which URLs you consider canonical and how recently each changed.",
    howToFix:
      "Publish a sitemap if there is not one, then add a Sitemap: line to robots.txt naming its absolute URL. Submit it in Search Console as well: the declaration makes it discoverable, the submission makes its coverage reportable.",
  },
  "sitemap.invalid": {
    title: "A sitemap document could not be read",
    explanation:
      "One or more of the sitemap documents this site declares could not be parsed: the finding lists each one with the reason — a server error, a response that is not XML at all (usually an HTML error page served with a 200), or a document whose root element is neither urlset nor sitemapindex. URLs in a document that cannot be read are invisible to search engines exactly as they are to this crawl.",
    howToFix:
      "Open each URL listed and check what actually comes back. A sitemap must be well-formed XML with a urlset or sitemapindex root, served with a 200 and an XML content type. Where a sitemap index names shards that no longer exist, remove those entries rather than leaving them to error.",
  },
  "sitemap.non-200": {
    title: "Sitemap lists a URL that does not return 200",
    explanation:
      "This URL is published in the site's sitemap and answered with something other than a 200 when it was fetched — the finding carries the status. A sitemap is a list of URLs you are asking search engines to index, so an error page in it wastes crawl budget on a URL that cannot be indexed and, in quantity, reduces how much a crawler trusts the file.",
    howToFix:
      "Restore the page if the URL should work, or remove the entry if it should not. Sitemaps that are generated should be generated from the same source of truth as the pages themselves, so a removed page leaves the sitemap in the same deploy.",
  },
  "sitemap.redirected": {
    title: "Sitemap lists a URL that redirects",
    explanation:
      "This URL is published in the site's sitemap and redirects somewhere else. It is not an error, but it is the wrong URL to publish: a sitemap should name the destination — the canonical URL that answers with a 200 — so crawlers reach it in one request instead of two, and so the file agrees with the canonical tags on the pages themselves.",
    howToFix:
      "Replace the entry with the URL it redirects to. Where a whole class of entries redirects the same way — an http to https upgrade, or a trailing-slash rule — the sitemap generator is emitting the wrong form and fixing it there corrects every entry at once.",
  },
  "sitemap.non-indexable": {
    title: "Sitemap lists a page excluded from the index",
    explanation:
      "This URL is published in the site's sitemap and the page it serves tells search engines not to index it, through a robots meta tag or an X-Robots-Tag header. The two are direct contradictions: the sitemap asks for the page to be indexed and the page refuses. Search engines follow the page, so the entry achieves nothing except making the sitemap a less reliable signal.",
    howToFix:
      "Decide which is right. If the page should rank, remove the noindex directive; if it should not, remove it from the sitemap. Filtered, paginated and thank-you pages usually belong in the second group.",
  },
  // Accuracy: two shapes, one statement. The finding covers a URL the crawl
  // never attempted AND one it attempted without getting any HTTP answer back;
  // `attempted` in the evidence says which. Copy that named only the first
  // would be false of half the findings.
  "sitemap.uncrawled": {
    title: "Sitemap lists a URL this crawl did not reach",
    explanation:
      "This URL is published in the site's sitemap and this crawl has no usable record of it. Either it was never fetched — a page limit, a depth limit, or a URL robots.txt disallows — or the request was made and no response came back at all: a timeout, a connection failure, or an address the crawler refused to connect to. The evidence says which, and names the failure where there was one. This is reported as information rather than as a defect, because the first case is usually a limit of the crawl; the second is worth confirming, since a URL you publish that does not answer is one a search engine cannot index either.",
    howToFix:
      "Check the evidence first. If the URL was never attempted, see whether it is reachable by following links from the homepage and whether robots.txt allows it — a URL reachable only through the sitemap needs internal links — and re-run the crawl with a higher page limit if it simply stopped short. If the attempt failed, request the URL yourself and fix whatever did not answer.",
  },
  "pages.not-in-sitemap": {
    title: "Indexable page is not listed in the sitemap",
    explanation:
      "This page was crawled, returns a 200 and is open to indexing, and the site's sitemap does not list it. The sitemap is how a site states which URLs it considers worth indexing, so a page missing from it is discovered only by links — slower to be found, slower to be re-crawled after a change, and absent from the coverage reporting a submitted sitemap gives you. Some absences are deliberate; this is reported as information for that reason.",
    howToFix:
      "Add the page to the sitemap, or fix the generator that should have added it — sitemaps built from a stale export drift from the site with every release. If the page is deliberately excluded from the sitemap but still indexable, make sure that is a decision someone made rather than an oversight.",
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

  // -------------------------------------------------------------------- url
  "url.normalisation-variants": {
    // Accuracy: the rule fires only when EVERY URL in the group answered 200.
    // A spelling that redirects to another is the fix, not the fault, and this
    // copy must not be rendered over one.
    title: "The same page served under several URLs",
    explanation:
      "More than one URL on this site answers with the same page: the addresses differ only in capitalisation or a trailing slash, and each of them returns a page of its own instead of redirecting to a single version. Search engines treat each spelling as a separate URL, so the links and ranking signals pointing at one page are split between them, and which version gets indexed is left to the crawler.",
    howToFix:
      "Pick one spelling as canonical and make the site emit only that one in its links, its sitemap and its canonical tags. Redirect the other spellings to it with a 301 so the versions already indexed and linked consolidate onto the URL you chose.",
  },
  "url.tracking-params-internal": {
    title: "Internal links carry campaign tracking parameters",
    explanation:
      "Internal links on this site point at a URL tagged with campaign or ad-click parameters (utm_source, gclid and the like). Those tags belong on links coming from outside: used internally they create a second, tagged URL for a page that search engines may crawl and index, and they overwrite the original traffic source in analytics so the visit is re-attributed to a campaign it did not come from.",
    howToFix:
      "Strip the tracking parameters from internal links and point them at the clean URL. Where the tags exist to measure an internal promotion, use an analytics feature meant for that — internal campaign or content-group tracking — rather than the parameters reserved for external campaigns.",
  },
  "url.parameter-pages-indexable": {
    title: "Parameterised URL invites indexing of itself",
    explanation:
      "This URL carries query parameters, returns a 200, is not excluded from the index, and names itself as its own canonical. On a filterable listing that is how a handful of pages becomes thousands of near-identical indexable URLs, one per combination of filters, each competing with the clean page. It is sometimes the right call — a search or feed page that should rank — which is why this is a statement to check rather than a fault.",
    howToFix:
      "Decide which parameter combinations deserve to be pages. For the ones that do not, canonicalise the variant to the clean URL and keep it out of the sitemap and the internal links. Parameters that only reorder or narrow the same set of items — sort, view, session — should not produce indexable URLs at all.",
  },

  // ------------------------------------------------------------------- host
  "host.http-serves-200": {
    title: "The site answers over plain http",
    explanation:
      "One of the site's spellings serves a page over http rather than redirecting to https. Browsers mark the plaintext version as not secure, its traffic can be read and altered in transit, and search engines can index it as a separate URL — so the site competes with itself and the secure version loses part of its link equity.",
    howToFix:
      "Redirect every http URL to its https equivalent with a single 301, preserving the path and the query string, and serve HSTS on the https response so browsers stop asking for the insecure version at all.",
  },
  "host.duplicate-host-200": {
    title: "Both www and non-www serve the site",
    explanation:
      "The www and the bare-domain spellings of this site both answer with a page in their own right, with no redirect between them. Every URL on the site therefore exists twice, and links, rankings and crawl budget are split between two hosts that serve identical content.",
    howToFix:
      "Choose one host as canonical and 301-redirect the other to it, keeping the path and query string intact. Update internal links, the sitemap and the canonical tags to the chosen host, and confirm both spellings resolve to it in Search Console.",
  },
  "host.legacy-host-reachable": {
    title: "A former domain still serves its own site",
    explanation:
      "A domain the site used to live on still answers with a page instead of redirecting to the current one. The old site stays indexable alongside the new one, the two compete for the same queries, and every link earned on the old domain stops short of the site it was meant to point at. It is occasionally deliberate — a brand kept separate on purpose — which is why this is reported as something to confirm.",
    howToFix:
      "If the domain is genuinely retired, 301-redirect it to the matching URL on the live site, page by page rather than everything to the homepage, and keep the redirects in place indefinitely. If it is meant to stay a separate site, make sure it is not serving the same content.",
  },
  "host.probe-skipped": {
    title: "Host variants were not checked",
    explanation:
      "This crawl did not probe the site's other spellings, so nothing here says whether the http version redirects, whether www and the bare domain both serve the site, or whether a former domain is still reachable. That is a limit of this crawl rather than a finding about the site: the probe is skipped when a crawl is started with host probing turned off.",
    howToFix:
      "Re-run the crawl with host probing enabled to answer these checks. In the meantime the same questions can be answered by hand: request each spelling of the domain and follow the redirects, confirming they all end on the canonical https host.",
  },

  // ---------------------------------------------------------------- content
  "content.soft-404": {
    // Accuracy: two independent signals, and EITHER can fire this on its own —
    // wording plus a short page, or a body that matches what the site serves
    // for a URL that does not exist. Copy implying both are required, or that
    // the page was proved missing, would misdescribe the rule.
    title: "Soft 404 (a missing page answering 200)",
    explanation:
      'This page answers with a 200 OK, but it looks like a "page not found" rather than a page. Either signal alone is enough for us to say so: its visible text carries not-found wording and the page is under 300 words, or its content is within a few bits of the body this site served for a URL that cannot exist. Search engines treat these as errors anyway, so the URL is crawled repeatedly, kept out of the index, and the crawl budget spent on it is wasted.',
    howToFix:
      "Decide what the URL should be. If the content is genuinely gone, return a real 404 or 410 status rather than a 200, or 301-redirect it to the closest live page. If it is a real page that happens to be short or to mention the phrase, expand it so it stops resembling the error template — and check what links to it, because a soft 404 usually means something is generating URLs that were never meant to exist.",
  },
  "content.exact-duplicate": {
    title: "Identical content at more than one URL",
    explanation:
      "These URLs return exactly the same visible text. A search engine picks one of them to keep and drops the others, and the links and ranking signals that should have gone to a single page are split between copies that compete with each other. It is also crawl budget spent fetching the same page repeatedly.",
    howToFix:
      "Pick the URL that should rank and point the others at it: a rel=canonical on the copies, or a 301 redirect where the duplicates should not exist at all. On templated sites, look for what created them — a print version, a parameter, a category path as well as a flat one — and fix the pattern rather than the individual pages.",
  },
  "content.near-duplicate": {
    // Accuracy: this is a similarity measurement (a hamming distance between
    // two 64-bit content fingerprints), not a plagiarism, scraping or
    // copy-theft finding, and near-duplicate pages carry no ranking penalty.
    // Do not let this copy imply any of that.
    title: "Near-duplicate content",
    explanation:
      "These two pages are almost the same text. We compare a fingerprint of each page's visible words, and these two differ by at most three bits out of sixty-four — in practice, pages that differ only in boilerplate, a product name or a location. Search engines group pages this similar and show one of them, so a set of near-identical pages tends to rank as one page rather than as many.",
    howToFix:
      "Decide whether these should be one page or several. If they exist to cover variations of the same subject, consolidate them into a single stronger page and redirect the rest. If they must stay separate — locations, product variants — give each one substantive content that only applies to it, rather than a template with a few words swapped.",
  },

  // -------------------------------------------------------- structured data
  //
  // Accuracy, for all four: the crawler reads JSON-LD and nothing else. A site
  // marking itself up in microdata or RDFa is invisible to these rules, so no
  // copy here may say a site "has no structured data" flatly — the claim is
  // always about the JSON-LD this crawl found.
  "schema.none-on-site": {
    title: "No JSON-LD structured data anywhere on the site",
    explanation:
      "This crawl found no JSON-LD on any page. Structured data is how a page states in machine-readable form what it is — a product, an article, an organisation, a recipe — and it is what search engines and AI assistants read when they build a rich result or answer a question by citing a source. Without it, everything about the site has to be inferred from its prose. Note that only JSON-LD is read here: markup embedded as microdata or RDFa would not appear in this crawl.",
    howToFix:
      "Add JSON-LD to the templates that matter most first: an Organization (or LocalBusiness) block on the homepage, and the type that describes the money pages — Product on product pages, Article on editorial, FAQPage where you genuinely answer questions. Validate each template with Google's Rich Results Test, and keep the markup generated from the same data the page displays so the two cannot drift apart.",
  },
  "schema.product-incomplete": {
    // Accuracy: the presence blob behind this finding is the UNION across the
    // page's Product blocks, so a field named here is missing from all of them.
    // Copy saying "your Product block" (singular) would misdescribe a page that
    // carries several.
    title: "Product markup is missing required fields",
    explanation:
      "No Product block on this page provides every field a product rich result needs. Google will not show the price, availability or rating snippet for a product whose markup is incomplete, so the listing falls back to a plain blue link while competitors' show the price. The fields listed with this finding are the ones missing from all of the page's Product markup, not from one block of it — note that an offers block counts only when it carries a price or a priceSpecification.",
    howToFix:
      "Fill in the missing required fields on the product template — name, image and a priced offers block — generating them from the same product data the page renders, so a product with no image or no price in the catalogue shows the same gap in both places. Add the recommended fields where you honestly have them (description, sku, brand, and ratings or reviews you actually collect), then confirm the page passes Google's Rich Results Test.",
  },
  "schema.breadcrumb-absent": {
    title: "No breadcrumb markup anywhere on the site",
    explanation:
      "This site has more than 5 indexable pages and no page carries BreadcrumbList markup in its JSON-LD. Breadcrumb markup is what lets a search result show the path to a page — Home › Shoes › Trail — instead of a bare URL, and it tells search engines how the sections of the site relate to each other. On a site of any depth that hierarchy otherwise has to be guessed from URLs and links.",
    howToFix:
      "Add a BreadcrumbList block to the templates that sit below the homepage — categories, subcategories, product and article pages — listing each step with its position, name and URL, ending at the current page. Generate the trail from the same navigation data the visible breadcrumbs use, so the markup and what a visitor sees never disagree.",
  },
  "schema.self-serving-reviews": {
    // Accuracy: this is a policy statement about which reviews Google shows,
    // not a claim that the reviews are fake or that the site is penalised.
    title: "A business rates itself in its own markup",
    explanation:
      "This page's Organization or LocalBusiness markup carries a rating or reviews about the business itself. Google's review-snippet policy treats ratings an entity publishes about itself as self-serving and ignores them, so the stars never appear in search results even though the markup is technically valid. It is not a penalty and the reviews may be perfectly genuine — the markup simply does not earn a rich result where it is.",
    howToFix:
      "Move the ratings to something a review can legitimately be about: Product, Service, Book, Course, Recipe and similar types all support review snippets, so a rating on the page for what you sell counts where the same rating on your company block does not. Keep the customer reviews visible on the page either way, and let independent review platforms carry the business-level rating.",
  },
};

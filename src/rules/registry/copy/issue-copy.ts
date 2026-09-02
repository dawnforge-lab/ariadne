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
 * The file carries the METRIC rules' copy too, at the bottom, under its own
 * heading: a metric's title labels a table rather than naming a fault, but the
 * lookup is by rule id and there is one of those per rule kind, so one map
 * serves all three. The heading states how the three fields are read there.
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
  "title.duplicate": {
    // Accuracy: this is exact equality between two stored titles after
    // trimming, over indexable 200 pages only. It is not a similarity measure —
    // two titles differing by one word are not grouped — and duplicate titles
    // carry no ranking penalty. Do not let this copy imply either.
    title: "The same title on more than one page",
    explanation:
      "These pages all carry the same title, word for word. The finding names the shared title, how many indexable pages were found carrying it, and up to twenty of those URLs in alphabetical order — the count is the whole group, the list is a sample of it. Only pages that returned 200 and are indexable are compared, since a page kept out of the index competes with nothing. A repeated title is almost always a template writing the same string for every item in a section: the pages then look identical in a search result, none of them says what makes it different, and the search engine has to choose between them on other signals.",
    howToFix:
      "Fix the template rather than the pages. Build the title from the fields that actually differ between them — the product or article name, the variant, the location, the page number — and keep the shared part short and at the end. Where the pages really are the same page at several URLs, that is a duplicate-content problem instead: canonicalise or redirect them, and the titles stop repeating on their own.",
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
  "meta-description.duplicate": {
    // Same accuracy constraint as `title.duplicate` above: exact equality after
    // trimming, indexable 200s only, and no penalty claim.
    title: "The same meta description on more than one page",
    explanation:
      "These pages all carry the same meta description, word for word. The finding names the shared description, how many indexable pages were found carrying it, and up to twenty of those URLs in alphabetical order — the count is the whole group, the list is a sample of it. Only pages that returned 200 and are indexable are compared. A description is the sales line under the title in a result, so a shared one means several of your results say exactly the same thing about pages that are not the same, and the search engine is more likely to discard it and write a snippet from the page text instead.",
    howToFix:
      "Write the description from the page's own content, in the template: what this item is, what makes it different, and a reason to click. A generic site-wide sentence is worse than none at all, because it fills the one line you control with words that describe nothing. If a section genuinely has nothing distinct to say per page, it is usually better to leave the description off those pages and let the search engine build a snippet than to repeat one.",
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
  "h1.duplicate-text": {
    // Accuracy, twice over. Exact equality after trimming, like the two rules
    // above — and the compared value is the FIRST H1 only, as the analyzer
    // stored it. Copy claiming anything about a page's other headings would be
    // describing data this rule never sees.
    title: "The same H1 heading on more than one page",
    explanation:
      "These pages all open with the same H1 heading, word for word. The finding names the shared heading, how many indexable pages were found carrying it, and up to twenty of those URLs in alphabetical order — the count is the whole group, the list is a sample of it. Only pages that returned 200 and are indexable are compared, and only each page's first H1 is read. The H1 is the headline a reader sees and the strongest statement a page makes about its own subject, so a set of pages sharing one is a set of pages claiming to be about the same thing.",
    howToFix:
      "Give each page a headline that names what is actually on it, generated from the same fields that make the pages different in the first place. A shared H1 usually comes from a layout that puts the section or brand name in the heading slot and the real headline in a styled div below it: if that is what happened, swap the two so the element and the words agree.",
  },
  "h1.duplicate-skipped": {
    title: "Duplicate-heading check could not be run on this crawl",
    explanation:
      "Comparing headings across a site needs the text of each page's first H1, and this crawl did not record it: the pages here carry H1 elements, and not one of them has any heading text stored against it. That is what a crawl performed before the engine started reading heading text looks like. The check was therefore left unrun rather than reported as clean, because a site with no duplicate headings and a crawl that never read any heading produce exactly the same empty result, and only one of them is good news. The finding says how many indexable pages the crawl held, how many of them carry an H1 element, and how many have heading text stored — the last of which is zero, which is the reason this is here.",
    howToFix:
      "Re-crawl the site. The heading text is captured while each page is being read and cannot be recovered afterwards from what was stored, and any crawl from this version of the engine onwards records it for every page.",
  },
  "content.thin": {
    // Accuracy: the count this rule reads excludes text the page's own markup
    // hides, and does NOT exclude text hidden by a stylesheet — the crawler
    // does not load CSS. The prose says "the markup hides" for that reason;
    // do not widen it to a claim about everything a visitor cannot see.
    title: "Thin content",
    explanation:
      "This indexable page carries fewer than 150 words a reader can actually reach. Text the page's own markup hides is left out of that count — a menu drawer, a closed accordion, a block marked as not displayed, or a template a script clones later — because none of it is on the page a visitor is shown. The finding quotes both numbers, so a page that ships plenty of words and shows very few is visible as exactly that. Thin pages rarely rank on their own, weigh on how the site is assessed as a whole, and on a JavaScript-rendered site often mean the real content never reached the HTML a crawler sees.",
    howToFix:
      "Expand the page with content that answers the query it targets, consolidate it into a stronger page, or mark it noindex if it exists for another reason. If the two numbers are far apart, the copy exists but is behind something a reader has to open, so bring the substance into the visible page rather than into a drawer. If the copy is there for a browser but not in the HTML, server-render or pre-render it.",
  },
  "content.thin-skipped": {
    title: "Thin-content check could not be run on this page",
    explanation:
      "The thin-content check counts the words a reader can reach, which means it has to know which parts of the page the markup hides. This page was crawled before the engine recorded that, so the number the check needs does not exist for it — only the older count of every word in the HTML, which includes hidden menus, accordions and templates and is often several times larger. The page was therefore left unjudged rather than judged on the wrong number, which on a site with heavy hidden chrome would have called a thin page healthy.",
    howToFix:
      "Re-crawl the site. The count is taken while the page is being read, so it cannot be worked out afterwards from what was stored, and any crawl from this version of the engine onwards records it for every page.",
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
      "No robots.txt declares a sitemap for this site: either the file carries no Sitemap: line, or the site serves no robots.txt at all. Nothing tells a crawler where the sitemap is. The site may still have one — this is a statement about the declaration, not about the file — but a sitemap that is never announced is one search engines have to be told about by hand, and one that no crawler, including this one, can find on its own. A declared sitemap is the cheapest way to tell search engines which URLs you consider canonical and how recently each changed.",
    howToFix:
      "Publish a sitemap if there is not one, then add a Sitemap: line naming its absolute URL to robots.txt — creating robots.txt too if the site serves none. Submit the sitemap in Search Console as well: the declaration makes it discoverable, the submission makes its coverage reportable.",
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
      "Read the status before deciding. A 404 or 410 means the page is gone: restore it if the URL should work, or remove the entry if it should not. A 401, 403 or 429 is an access control or a bot block rather than a missing page — allowlist the crawler in your WAF or bot-protection settings and re-check, because deleting a sitemap entry for a page that is merely defended fixes nothing. Sitemaps that are generated should be generated from the same source of truth as the pages themselves, so a removed page leaves the sitemap in the same deploy.",
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
  // Accuracy: THREE shapes, one statement. The finding covers a URL the crawl
  // stopped short of, a URL on another host that the crawl was never going to
  // attempt, and one it attempted without getting any HTTP answer back;
  // `attempted` and `offOrigin` in the evidence say which. Copy that named only
  // the first two causes would be false of every off-origin entry, and that is
  // the case that has to be named rather than left implied: a page limit, a
  // robots disallow and a failed request are all untrue of a URL the frontier
  // skipped by design, so copy naming only those sends an operator after three
  // causes, none of them the reason. A supplied or declared sitemap listing
  // another host is an ordinary case, not a pathological one.
  // The fields are named in prose rather than spelled — this text reaches a
  // client in a report, and the rest of the copy names shapes the same way.
  "sitemap.uncrawled": {
    title: "Sitemap lists a URL this crawl did not reach",
    explanation:
      "This URL is published in the site's sitemap and this crawl has no usable record of it, for one of three reasons. It may be a URL on this site that the crawl stopped short of — a page limit, a depth limit, or a URL robots.txt disallows. It may be a URL outside the boundary this crawl was given — usually one on another host, and equally one on another port or served over plain HTTP by a site crawled over HTTPS: entries outside the crawl's own origin are not fetched by design, so no limit was reached and nothing was measured about them. Or the request may have been made and no response came back at all: a timeout, a connection failure, or an address the crawler refused to connect to. The evidence says which — it marks the off-origin entries, and it says whether a fetch was attempted and what it ran into. This is reported as information rather than as a defect: the first two cases are facts about this crawl rather than faults on the site, and the third is worth confirming, since a URL you publish that does not answer is one a search engine cannot index either.",
    howToFix:
      "Check the evidence first, because the three cases have different answers. An entry marked as off-origin needs nothing changed about the crawl — the URL is outside the origin this crawl was pointed at, so it was never going to be visited — and the only question is whether it belongs in the file: verify that the sitemap is this site's and that the other spelling is one the site genuinely serves pages from, then either leave these entries alone or take them out of the sitemap. Where the whole file is on another host and its entries are not, nothing is wrong at all. If the URL is on this site and no fetch was attempted, see whether it is reachable by following links from the homepage and whether robots.txt allows it — a URL reachable only through the sitemap needs internal links — and re-run the crawl with a higher page limit if it simply stopped short. If the attempt failed, request the URL yourself and fix whatever did not answer.",
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
      "Following internal links from the home page, the shortest route to this indexable page is more than 5 links deep. Depth is one of the ways crawlers and readers judge importance: deep pages get crawled less often, receive less internal link equity, and are harder to browse to. Being listed in the sitemap does not shorten that route. Pages excluded from the index are not reported here — their depth costs nothing — and a page with no link path at all is reported as an orphan instead.",
    howToFix:
      "Link to the page from shallower hub pages — a category, a landing page, or navigation — so that fewer clicks from the home page reach it. If it is not important enough to link from higher up, the honest answer may be to consolidate or remove it.",
  },

  // ------------------------------------------------------------------ resources
  //
  // The files the pages point at — images, stylesheets, scripts — as the
  // resource fetch pass found them. Two standing constraints on every string in
  // this group, both of them about what the evidence is rather than about tone:
  //
  //  1. **These are the SERVED HTML's references.** Assets a site injects with
  //     JavaScript are not in the table these rules read, so no copy here may
  //     say "the page loads" where it means "the HTML references".
  //  2. **An unfetched resource is unknown, never clean and never broken.** Each
  //     of these findings carries a count of the references the pass could not
  //     decide about, and each explanation says what that number means, because
  //     a partial answer read as a complete one is worse than no answer.
  "resources.broken": {
    // Accuracy: the rule fires on `client_error`/`server_error` only — a server
    // answered and did not give us the file. A request that timed out, one our
    // own policy refused, one robots.txt disallowed and one whose host could not
    // tell us its robots rules at all are UNKNOWN and are counted separately;
    // copy calling any of them broken would accuse a client of our silence.
    title: "The page references files that could not be loaded",
    explanation:
      "This page points at one or more files — images, stylesheets or scripts — that the server answered with an error instead of the file. The finding says how many, and lists up to ten of them with the status each one returned and, where the server gave a reason, that reason beside it: a status of 200 with a refusal reason next to it is a bot-protection challenge answering in place of the file, which is a different problem from a 404 and needs the reason to be read at all. Only files the server actually answered are counted here. A reference the crawl never got to ask about, one our own policy refused, one the site's robots.txt disallowed, one whose host could not tell us its rules at all because its robots.txt was unreachable while the crawl ran, and one whose request never completed are all reported as unknown instead, with their own count on the finding, because none of them is evidence that anything is wrong. The unreachable case is worth separating in your head from the rest: it usually means a third party's server was briefly down, not that anything about this site is misconfigured. What the reader sees depends on the file: a missing image leaves a gap, a missing stylesheet leaves the page unstyled, and a missing script leaves whatever it did undone. Only files named in the HTML the server sent are checked, so assets a script fetches later are outside this finding entirely.",
    howToFix:
      "Take the listed URLs and request them yourself. A 404 usually means a file was renamed or deleted while a template kept the old path, and the fix is in the template rather than on the page. A 5xx means the file exists and its server is failing, which is worth checking before anything else. A status with a refusal reason beside it means bot protection answered instead of the file, so the file is probably fine for a browser and the thing to change is the protection rule — the same allowlist question a blocked page raises. Where the unknown count is high, the resource pass did not finish or was not allowed to ask, and re-running the crawl is what turns those into answers.",
  },
  "images.oversized": {
    // Accuracy: this is the TRANSFERRED size the server reported or we counted.
    // Nothing here decodes an image, so no claim about dimensions, compression
    // quality or how large the file is relative to its layout box.
    title: "Image file is heavier than 100,000 bytes",
    explanation:
      "This image transfers more than 100,000 bytes — the 100KB line the audit checklist uses — and the finding names the file, its size, how that size was established, how many pages of this crawl reference it, and up to ten of those pages. The size is what the connection carries, taken either from the size the server declared or from counting the bytes of one download, and the finding says which: a declared size is the server's claim and a counted one is our measurement. The file is the unit here, not the page: one heavy image used by a template is one thing to fix however many pages carry it, which is why the count of referencing pages sits beside it. Nothing here opens the image, so this says nothing about its dimensions or how well it is compressed — only that this many bytes cross the wire every time a page carrying it is loaded on an empty cache. Only images named in the HTML the server sent are weighed, and only the ones the crawl actually got an answer for: an image a script loads later, or one the crawl never got to ask about, is unknown rather than fine.",
    howToFix:
      "Start with the images the most pages reference, since that is where the bytes are actually being spent. Re-export at the size the layout actually displays rather than at the size it was uploaded, compress it, and serve a modern format where the browser accepts one. Where a large file is deliberate — a photographer's portfolio, a print-quality download — the fix is to stop shipping it in the page: link to it, or serve a small rendition in the markup and load the full file on demand.",
  },
  "images.legacy-format": {
    // Accuracy: a format is a CHOICE and this is info, never a defect. The type
    // compared is the one the SERVER SENT, not the URL's extension, so a CDN
    // already negotiating WebP from a .jpg path is correctly silent.
    title: "Heavy image served as PNG or JPEG",
    explanation:
      "This image is over 100,000 bytes and the server sent it as a PNG or a JPEG. Both formats predate WebP and AVIF, which typically carry the same picture in a good deal fewer bytes, so a heavy file in one of them is a candidate for conversion. It is not a fault: a format is a choice, PNG is the right answer for screenshots and flat graphics with sharp edges, and some pipelines produce nothing else. Only images already past the weight line are named, because converting a small file saves nothing worth the work. The type compared is the one the server actually sent rather than the file extension, so a site whose CDN already negotiates a modern format for the same URL is silent here even where the path still ends in .jpg. Only images named in the HTML the server sent are looked at, and only the ones the crawl actually got an answer for: an image a script loads later, or one the crawl never got to ask about, is unknown rather than fine.",
    howToFix:
      "Treat this as a shortlist rather than a task list. Where the images are photographs, adding WebP or AVIF renditions and letting the browser pick — a picture element, or content negotiation at the CDN — is usually the single largest byte saving available on a page. Keep the PNG or JPEG as the fallback rather than replacing it, since that is what makes the change safe, and leave alone the images whose format is doing a job the newer ones do not do better.",
  },
  "resources.uncached": {
    // Accuracy: the crawl reads `Cache-Control` and `Expires` and nothing else.
    // It cannot see a CDN's own edge caching or an ETag-based revalidation, so
    // no copy here may say the files are re-downloaded every time.
    title: "Fetched files carry no caching headers",
    explanation:
      "Some of the files this crawl fetched came back with neither a Cache-Control nor an Expires header, so nothing in the response tells a browser how long it may keep them. The finding counts them, says how many files were fetched altogether, and lists up to twenty of the ones with no header. Files the crawl never asked about — because the resource pass did not reach them, our own policy refused them, robots.txt disallowed them, their host's robots.txt was unreachable while the crawl ran, or the request failed — are counted separately as unknown and are not part of the uncached number: a file nobody asked for has no missing header. Two headers is all this reads, so a CDN doing its own edge caching, or a server revalidating with an ETag, is invisible here — what the finding says is that the response itself gave no instruction, which is the part a browser on a repeat visit acts on. Only files named in the HTML the server sent are asked for at all, so assets a script loads later are outside this count.",
    howToFix:
      "Set a long max-age on the assets whose URL changes when their content does — anything with a content hash in its filename can safely be cached for a year — and a short one, or a revalidation instruction, on the rest. This is normally a few lines in the web server, the CDN or the framework's static-file configuration rather than a change to the site, and it is one of the cheapest improvements available for repeat visitors.",
  },
  "resources.not-recorded": {
    title: "Resource checks could not be run on this crawl",
    explanation:
      "The checks about images, stylesheets and scripts — broken files, image weight, image format, caching headers, and the page-weight table beside them — all read the files a crawl recorded from each page's HTML. This crawl recorded none, and its pages did carry images, which is what a crawl performed before the engine started reading resources looks like. The checks were therefore left unrun rather than reported as clean, because a site whose files are all healthy and a crawl that never looked produce exactly the same silence, and only one of them is good news. The finding says how many resource records this crawl holds, which is none, how many of its pages counted at least one image, and how many pages it read in all.",
    howToFix:
      "Re-crawl the site. The references are read while each page is being parsed and the files are asked about afterwards, so neither can be recovered from what was stored, and any crawl from this version of the engine onwards records both.",
  },
  "resources.not-fetched": {
    // Accuracy: this reports a CRAWL, never a site — and, unlike its sibling,
    // never a gap in what was recorded. The census exists and is real; what is
    // missing is the asking. Copy that read as "no resources were found" would
    // describe the opposite crawl.
    title: "The site's files were listed but never asked about",
    explanation:
      "This crawl recorded every image, stylesheet and script the pages it read point at — everything named in the HTML the server sent, which is a real census and the only one a crawl can take — and it requested none of them. So nothing here says whether any of those files is missing, oversized, in a dated format, or served without caching instructions, and the page-weight table beside these checks counts each page's HTML and nothing else. The finding says which of two things happened: the crawl was started with the resource fetch turned off (fetchResources: false), which is a decision an operator takes — a client who asked us not to touch their servers, or a re-crawl that only needed the page census; or the fetch pass sent no request at all, which is a crawl interrupted before it started asking. It also says how many files were recorded and how many of them went unasked, which on this crawl are the same number, and how many pages were read. Either way the silence of the resource checks is a limit of this crawl rather than a clean bill of health for the site.",
    howToFix:
      "Re-run the crawl with the resource fetch left on — it is on by default — or resume the interrupted one, which asks about the files it never reached. Nothing about the files can be recovered from what is stored: the census records which URLs the pages point at, not what a server would say about them.",
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
      'This page answers with a 200 OK, but it looks like a "page not found" rather than a page. Either signal alone is enough for us to say so: its visible text carries not-found wording and the page shows under 300 words a reader can reach (text the markup hides, such as a menu drawer or a closed accordion, is left out of that count, so a short error message inside a full site shell still reads as short), or its content is within a few bits of the body this site served for a URL that cannot exist. Search engines treat these as errors anyway, so the URL is crawled repeatedly, kept out of the index, and the crawl budget spent on it is wasted.',
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
      "No Product block on this page provides every field a product rich result needs. Google will not show the price, availability or rating snippet for a product whose markup is incomplete, so the listing falls back to a plain blue link while competitors' show the price. The fields listed with this finding are the ones missing from all of the page's Product markup, not from one block of it — note that an offers block counts only when it carries a price or a priceSpecification, and that a field written as offers.priceCurrency is one that belongs inside the offer rather than beside it. A product identifier counts under gtin whichever length of GTIN it is written as, and mpn is listed separately because a manufacturer part number is a different identifier rather than another spelling of the same one.",
    howToFix:
      "Fill in the missing required fields on the product template — name, image and a priced offers block — generating them from the same product data the page renders, so a product with no image or no price in the catalogue shows the same gap in both places. Then add the recommended fields you honestly hold: a currency and an availability inside the offer, a GTIN or manufacturer part number for Google Shopping, the description, sku and brand, ratings or reviews you actually collect, and the attributes shoppers search by where the product has them — colour, material and size. Confirm the page passes Google's Rich Results Test afterwards.",
  },
  "schema.breadcrumb-absent": {
    title: "No breadcrumb markup anywhere on the site",
    explanation:
      "This site has at least 5 indexable pages and no page carries BreadcrumbList markup in its JSON-LD. Breadcrumb markup is what lets a search result show the path to a page — Home › Shoes › Trail — instead of a bare URL, and it tells search engines how the sections of the site relate to each other. On a site of any depth that hierarchy otherwise has to be guessed from URLs and links.",
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

  // ------------------------------------------------------------ render diffs
  //
  // The four rules that compare what the HTML said with what a browser showed
  // after the page's JavaScript ran. Two standing accuracy constraints on this
  // group, both of them things the crawl cannot know and the copy must not
  // imply:
  //
  //  1. It never says "search engines cannot see this". Google renders, with a
  //     delay and a budget nobody outside Google can measure. What these rules
  //     establish is that the content is not in the first response, which is a
  //     cost and a risk rather than an invisibility.
  //  2. It never speaks for pages nobody rendered. Every one of these findings
  //     is about the page it names, measured in a real browser; the share of the
  //     site that was measured at all is `render.coverage`'s subject.
  "content.csr-dependent": {
    title: "Page content only appears after JavaScript runs",
    explanation:
      "Rendering this page in a real browser produced at least twice as many words as its HTML contains, and at least 150 words more. The finding names both counts and the difference between them. That means the substance of the page is assembled by JavaScript rather than served in the response: the first thing a crawler receives is a shell, and the text a visitor reads arrives afterwards. Search engines do render pages, but on their own schedule and their own budget, so content that is only in the rendered result is indexed later than content in the HTML and sometimes not at all.",
    howToFix:
      "Serve the page's main content in the first HTML response — server-side rendering, static generation or a prerendered snapshot for the templates that matter commercially. The client-side app can still take over afterwards; what changes is that the words exist before it does. Where a full change of rendering strategy is out of reach, prioritise by template: the pages that earn traffic first, the interactive parts of the site last.",
  },
  "nav.js-only": {
    title: "Navigation links only exist after JavaScript runs",
    explanation:
      "The HTML of this page carries fewer than 5 links inside its nav and footer, while rendering it in a browser produced at least 10 — and at least twice as many as the HTML held. The finding names the nav and footer counts on each side, and the totals it compared. The site's own navigation is therefore built by JavaScript: a crawler reading the response finds almost no way onward from this page, so the pages the menu leads to are discovered late, through other links, or not at all. Where the navigation is the main route into a section, that section depends entirely on rendering happening.",
    howToFix:
      "Render the primary navigation and the footer server-side, as ordinary anchors with real href attributes, and let JavaScript enhance them rather than create them. A menu that opens with script is fine; a menu whose links exist only once script has run is not. Check the result by loading the page with JavaScript disabled: the links that matter for discovery should still be there and still be clickable.",
  },
  "filters.js-only": {
    title: "Filter and sort links only exist after JavaScript runs",
    explanation:
      "This page's HTML contains no links that look like filters — no address carrying a query string, and none whose address mentions filter, facet or sort — while rendering it in a browser produced at least 5 of them. The finding names both sides. The faceted navigation is therefore assembled by JavaScript, which cuts two ways: the filtered views are not reachable by a crawler reading the response, so any of them worth ranking is invisible; and if rendering does reach them, a facet space that was never designed to be crawled can expand into far more URLs than the site has pages.",
    howToFix:
      "Decide first whether the filtered views should be indexed at all. Where a filter produces a page worth ranking — a colour, a size, a location people actually search for — give it a real link with a real URL that returns that view on its own. Where it does not, keep the facets out of the crawl deliberately rather than accidentally: a canonical to the unfiltered listing, or a robots.txt rule for the parameter, so the decision is recorded rather than resting on whether a crawler runs JavaScript that day.",
  },
  "redirect.js": {
    title: "Page redirects itself with JavaScript",
    explanation:
      "This URL answered a plain 200 over HTTP and then sent the browser somewhere else once its JavaScript ran. The finding names the URL asked for and the URL it navigated to. Nothing in the HTTP response says a redirect happened, so to anything reading the response this is a live page — links to it pass no signal onward, and a search engine has to render the page before it learns the content is elsewhere. Where the destination is on another site, the render was stopped at that point and the finding says so, which is why some of these carry a render error beside the destination.",
    howToFix:
      "Replace the script with a server-side redirect: a 301 where the move is permanent, a 302 where it is not. That way the redirect is in the response header, every client sees it without executing anything, and the ranking signals of the old URL are passed to the new one. Where the redirect is conditional — a language or country choice — serve the chosen page directly from the server for that request rather than bouncing the browser after it has loaded.",
  },

  // ------------------------------------------------------------------ metrics
  //
  // A metric's copy answers three different questions from an issue's, and the
  // fields are reused rather than renamed so one lookup serves every rule kind:
  //
  //   title       — the LABEL OF THE TABLE the metric renders as.
  //   explanation — WHAT THE NUMBERS MEAN: what was counted, over which pages,
  //                 and what was deliberately excluded. A reader who quotes the
  //                 table must be able to say what it measured from this text
  //                 alone.
  //   howToFix    — HOW TO READ AND ACT ON IT. A metric is not a fault, so
  //                 there is nothing to repair; what belongs here is which end
  //                 of the table to look at first and what a number there
  //                 implies.
  //
  // Same accuracy rule as everywhere above, and it bites harder here: a number
  // reaches a client as a fact. Say what was measured, not what it suggests.
  // The list caps quoted in words below are the rules' own constants
  // (`EXTREMES_LIST_CAP`, `SOURCE_TYPE_CAP` in src/rules/metric/link-metrics.ts)
  // and the copy test pins them.
  "inlinks.distribution": {
    title: "Internal links per page",
    explanation:
      "How many other pages link to each of this site's indexable pages, summarised as a distribution: how many pages were measured, the smallest and largest number of inbound links, the mean, the quartiles, and the 95th percentile — the level only the best-linked one page in twenty reaches. A page is counted once per linking page, so being named in both the header and the footer of one page is one inbound link; a link a page makes to itself is not counted at all. Pages nothing links to are included as zero rather than dropped — they are what the bottom of the table is about. Only pages that returned 200 and are indexable are measured. The site row covers all of them; each other row is one page type, with pages the crawler could not assign a template to grouped under (untyped).",
    howToFix:
      "Read the bottom quartile first: those pages are barely supported by the site's own linking, and a page with no inbound links at all is one search engines will rarely recrawl. Then compare the per-type rows with the site row — a template whose median sits well below the site's is a template the internal linking has forgotten. The top of the distribution shows where internal link equity is concentrated, which is usually the cheapest place to add a link to a page from the bottom.",
  },
  "inlinks.extremes": {
    title: "Most and least linked pages",
    explanation:
      "The twenty indexable pages with the fewest inbound internal links and the twenty with the most, each with its count, so the ends of the distribution can be quoted as URLs rather than as numbers. Inbound links are counted exactly as in the internal-links-per-page table: one per linking page, never a page's link to itself. Ties are broken by URL, so the same crawl always names the same pages. On a site with fewer than twenty indexable pages both lists name every page, in opposite orders.",
    howToFix:
      "Check the bottom list against what the site is there to sell or rank: a commercially important page in that list is the finding, while an archive or a filter page there is expected. The top list says where the site's internal linking currently points — usually a navigation block — and those pages are the cheapest place to add a link to something from the bottom list.",
  },
  "inlinks.sources-by-type": {
    title: "Where each template's inbound links come from",
    explanation:
      "For each type of page on the site, how many internal links reach it from each other type — category pages linking to products, blog posts linking to categories, and so on. Links are counted once per pair of pages, and a page's link to itself is not counted. Destinations are indexable pages that returned 200; the linking side is every page the crawl read, because a page kept out of the index still passes a link. Pages the crawler could not assign a template to appear as (untyped) on either side. Where a type is linked to from more than twenty-five other types, the remainder are summed into a single (other) entry — written in brackets so that a template a site really has named 'other' keeps its own entry beside it. A type shown with no sources receives no internal links from anywhere on this site.",
    howToFix:
      "Read each row as a sentence about the site's structure — 'product pages are linked to by category pages and by nothing else'. A commercially important type reached from only one other type depends entirely on that template being crawled; a type with no sources at all is reachable only from the sitemap or from outside. Where editorial pages link to nothing commercial, that is an internal linking opportunity rather than a fault to repair.",
  },
  "structure.depth-distribution": {
    title: "Discovery depth: how the crawler first reached each page",
    explanation:
      "How far into the crawl each indexable page was first found, summarised as a distribution: how many pages were measured, the shallowest and deepest, the mean, the quartiles, and the 95th percentile — the depth only the deepest one page in twenty was found past. This is a measurement of the CRAWL, not of the site: the crawler starts from the site's URL and from every address the sitemap publishes, so a page listed in the sitemap is recorded at depth 0 whether or not a single link on the site points at it. On a site whose sitemap covers everything this table is therefore mostly zeroes, and that flatness is itself the finding — it says the pages were found by being published in a file, not by being linked to. For how many clicks from the home page a page actually is, read the click depth table beside this one. Only pages that returned 200 and are indexable are measured. The site row covers all of them; each other row is one page type, with pages the crawler could not assign a template to grouped under (untyped).",
    howToFix:
      "Compare this table with the click depth table. Where discovery depth is far shallower than click depth, the sitemap is doing the work the internal linking should do: the pages are being found because they are published in a file, and a search engine that weighs them by how the site links to them will weigh them at nearly nothing. Where the two agree, the crawl found the site the way a visitor would.",
  },
  "structure.click-depth-distribution": {
    title: "Click depth from the home page",
    explanation:
      "How many clicks from the home page each indexable page sits — the shortest chain of internal links that reaches it — summarised as a distribution: how many pages were measured, the shallowest and deepest, the mean, the quartiles, and the 95th percentile, the depth only the deepest one page in twenty is buried past. The home page itself is 0. Alongside them is the number that matters most: how many pages NO chain of links reaches at all, counted separately as unreachable rather than being given a depth of zero. Those are the pages that exist only in the sitemap or only in a search engine's memory — the worst case in the table, worse than the deepest page in it, because nothing on the site leads to them. The count covers every page in the cohort, the unreachable ones included, and the statistics beside it describe only the pages that have a depth. Links are followed as the site publishes them: internal links only, and a link that lands on a redirect leads no further, so a page reachable only through a redirect is counted as unreachable and the redirect is the thing to fix. Only pages that returned 200 and are indexable are measured — a buried noindex page costs nothing. The site row covers all of them; each other row is one page type, with pages the crawler could not assign a template to grouped under (untyped).",
    howToFix:
      "Start with the unreachable pages: a page no link path reaches receives no internal link equity, is crawled rarely, and depends entirely on the sitemap being read. Give each one a home — a category, a hub, a related-products block — or, where the page should not exist, remove it from the sitemap. Then read the upper quartiles: pages deep in the structure are crawled less often and compete from behind, so a template whose median depth is high is one to shorten the path to with a hub or a navigation entry, rather than treating each deep page individually.",
  },
  "content.metrics-by-type": {
    title: "Word count and text density by template",
    explanation:
      "How much text this site's indexable pages carry, as three distributions: the word count of the page's text, the renderable word count — the same text minus the parts the page's own markup hides, such as a menu drawer, a closed accordion or a template a script clones later — and the text ratio, the share of the page's HTML that is text rather than markup. The text ratio counts the hidden parts as text, unlike the renderable count beside it, so a template with a lot of hidden chrome reads as denser than it is. Each is summarised the same way: how many pages were measured, the shortest and longest, the mean, the quartiles, and the 95th percentile — the level only the largest one page in twenty reaches. The three counts are the pages that actually carry each measure, so a page the parser recorded no word count for is absent from the word-count column and still present in the text-ratio one. Only pages that returned 200 and are indexable are measured. The site row covers all of them; each other row is one page type, with pages the crawler could not assign a template to grouped under (untyped).",
    howToFix:
      "Compare each template's row with the site row and with what the template is for: a product listing legitimately carries less text than an article, so the number to read is the spread inside one template rather than the difference between two. The gap between the word count and the renderable word count is the template's furniture — a template shipping 900 words and showing 200 carries 700 words of hidden chrome on every one of its pages, which inflates every other length measure taken of it. A template whose lower quartile sits far below its median has a tail of pages carrying much less than the rest — those are the pages to look at first. A low text ratio says the page is mostly markup, which is a rendering and template question rather than an editorial one.",
  },
  "content.template-similarity": {
    // The plan's naming ruling: this table is about TEMPLATE SIMILARITY. The
    // copy test asserts the other word never appears here — a measurement of
    // how alike two pages are must not be labelled with a verdict on which
    // parts of them are worth reading.
    title: "How alike the pages inside each template are",
    explanation:
      "For each type of page, how similar its pages are to each other, measured between every pair as the number of bits by which their content fingerprints differ — 0 means the two read as the same text, 64 means they share nothing. The table gives the mean distance, the quartiles, and the percentage of pairs within 3 bits and within 8 bits of each other. Comparing every pair of a large template would be quadratic, so the pairs are sampled: the first 200 pages of each type, taken in page-id order, which is effectively arbitrary and always the same for a given crawl. The row states how many of the type's pages carry a fingerprint, how many of those were sampled and how many pairs that was, so a number over a sample is never mistaken for a number over the whole template. A page the crawl recorded no fingerprint for is outside this table on both counts — neither compared nor counted — and a type with fewer than two fingerprinted pages has no pair to compare and gets no row at all.",
    howToFix:
      "Read each row against what the template is: a set of location or filter pages sitting a couple of bits apart is pages that differ only in a name, while a set of articles doing the same is a signal worth investigating. A high percentage within 3 bits says most of the type's pages are interchangeable to a search engine, which is a consolidation question — fewer pages, or more that is genuinely specific to each. A wide spread inside one type usually means the type is really two, and the templates are worth separating before either is judged.",
  },
  "hreflang.coverage": {
    title: "Share of pages declaring hreflang",
    explanation:
      "How many of this site's indexable pages publish at least one hreflang declaration, out of how many were measured, and that as a percentage rounded to one decimal place. A page counts once however many alternates it names, and declarations from the page's HTML, its HTTP headers and the sitemap all count — this is about which pages take part in the international setup at all, not about whether the sets they name are complete, which the hreflang findings cover separately. Only pages that returned 200 and are indexable are counted. The site row covers all of them; each other row is one page type, with pages the crawler could not assign a template to grouped under (untyped). A row with no measured pages shows no percentage rather than zero.",
    howToFix:
      "On a site with no international presence, low coverage here is expected and says nothing. Where the site does serve more than one language or country, read the per-template rows: coverage that is high on one template and near zero on another is the usual shape, and it means a template was left out of whatever generates the tags rather than that the site lacks alternates. Pair this with the hreflang findings — a template with high coverage and many missing return links is a different job from one with no coverage at all.",
  },
  "url.param-volumes": {
    title: "Query parameters across the site's URLs",
    explanation:
      "The shape of this site's parameter space: how many distinct parameter names the crawl found, how many of those are tracking parameters — the campaign tags and ad-click ids analytics adds, such as utm_source, gclid and fbclid — and the twenty parameters carrying the most URLs, each with the number of URLs it appears on and whether it is one of the tracking ones. The list is ordered by that count, largest first, with ties broken by name so the same crawl always names the same twenty; the total beside it says how many parameters there are altogether. Beneath them are how many crawled pages carry a query string at all, and how many of those returned 200 and are indexable. A URL is counted once per parameter it carries, so a URL repeating one parameter twice counts once, and the page counts cover every URL the crawl fetched whatever its status, which is the same set the parameter counts were taken from.",
    howToFix:
      "Read the indexable count against the total: parameterised URLs that are indexable are the ones competing with the pages they were filtered from, and they are what a faceted-navigation decision is about. Then read the top of the list — a parameter on tens of thousands of URLs is a filter or a sort control generating crawl surface, while a tracking parameter appearing at all means campaign-tagged links are being crawled as pages. Neither is automatically wrong: a single-filter URL can be the best landing page a site has for the query it matches, so the question each parameter asks is whether its URLs are worth indexing, and the answer belongs in the canonical and robots handling for that parameter rather than in a blanket rule.",
  },
  "redirect.volume": {
    title: "How much of the crawl was redirects",
    explanation:
      "How many of the URLs this crawl requested answered with a redirect, out of how many pages were fetched in total, and that as a percentage rounded to one decimal place. Every page the crawl read counts in the total, whatever it answered, because a redirect is a share of what was fetched rather than of what was indexable. Each redirecting URL counts once, so a link that redirects and appears in the footer of every page is one redirecting URL here, not one per page. Beside it is the number of internal links pointing at one of those redirecting URLs, which is the same fact counted the other way round: that one footer link is a single redirecting URL and one redirect inlink from every page of the site. Beside them are how many redirect chains and how many redirect loops the audit found on this crawl — the same chains and loops the redirect findings list, counted in full even where that list was capped at the first 200. A crawl with no pages shows no percentage rather than zero.",
    howToFix:
      "The percentage is the crawl-budget number: every redirect is a request that returns no content, so a site spending a tenth of its crawl on them is a site whose pages are being fetched less often than they could be. The inlink count is what tells you how much of that is worth chasing: a handful of redirecting URLs with thousands of links into them is a template change, while the same URLs with one link each are a tidy-up. Read them beside the chains and loops, which are faults rather than overhead — a loop returns nothing at all, and a chain multiplies the cost of every link into it. Where the share is high and the chains are few, the fix is usually in the links themselves rather than in the redirect rules: point internal links, sitemap entries and navigation at the destination URL, so the redirect stays available for outside traffic and stops being walked on every crawl.",
  },
  "sitemap.structure": {
    title: "What the site's sitemap is made of",
    explanation:
      "How this site's sitemap entries are distributed across sitemap documents. The site row gives the number of documents that contributed at least one entry, the total number of entries stored across them, how many documents were fetched and then dropped whole for being too large to read, how many documents carry more than the 50,000 entries the sitemaps protocol allows in one file, and whether the crawl's own entry cap stopped collection — when it did, every count here is a floor rather than a total. Each other row is one sitemap document, named by the URL it was fetched from, with how many entries it contributed and whether that is past 50,000. An entry listed in several documents is counted once, under the first document it was found in, and a sitemap index carries no entries of its own so it appears only through its children. The largest 50 documents are listed; the document count in the site row says how many there are in total.",
    howToFix:
      "Read the document list as the maintenance story: a site of any size whose entries all sit in one document has no way to see which section of the site is stale, and no way to submit or diagnose one part of it separately. Splitting by content type — products, collections, articles, pages — costs nothing and makes the sitemap a tool rather than a formality. A document past 50,000 entries has to be split whatever else is true, since the entries past the limit are not read. A document dropped for its size is entries this crawl never saw at all, so treat the numbers here as incomplete until it is split and re-crawled.",
  },
  "render.coverage": {
    title: "How much of the crawl was rendered in a browser",
    explanation:
      "How much of this crawl was opened a second time in a real browser, and what the selection that chose those pages had to work with. Rendering is expensive, so it is never run over a whole site: the numbers here are what makes the JavaScript findings quotable, because they say how large the sample behind them was. The first number is how many pages the crawl read in total. Then the selection mode, which says who chose the pages and governs everything after it: automatic, meaning the engine picked them from the crawl's own evidence, or explicit, meaning an auditor named the pages worth a browser. Then the selection, in the order it was made: the budget, how many pages the render pass was allowed to open, which is a percentage of the crawl capped by an absolute ceiling; how many candidates were suspects, pages whose HTML looked incomplete — a long document with almost no words in it, a page with no title, a page carrying a front-end framework marker, or a page that links nowhere; how many were sampled, pages taken from each template regardless of suspicion so that a template nothing looked wrong about is still represented, with a page that is both counted once as a suspect; how many were selected in the end, which is the budget or the number of candidates, whichever is smaller; and whether the selection was truncated, meaning a candidate was dropped for want of a seat, in which case the number selected is the budget rather than the need. On an explicit selection those four are empty rather than zero, because no automatic decision was taken: there was no budget, nothing was suspected, nothing was sampled and nothing was cut, and the number selected is simply the length of the list. Last, what came of it: how many pages are recorded as rendered, and how many render failures were recorded, a render that was attempted and produced nothing, kept as a row rather than dropped. Those last two need not add up to the number selected, and a difference is not an error: a crawl selected more than once keeps the earlier pass's rendered pages, which were measured even though this selection does not name them.",
    howToFix:
      "Read this table before quoting any of the JavaScript findings, and read the two sides of it against each other. Read the mode first: an automatic selection is a sample of the site and the numbers beside it say how it was drawn, while an explicit one is a list somebody chose, so what it covers is a question about that list and not about a budget. Pages rendered against pages crawled is the sample size: a handful of renders over a large site means the findings are examples of a problem rather than a count of it, and the absence of a finding says nothing about the pages nobody opened. A truncated selection means the budget, not the site, decided where the pass stopped — raise it and re-run if the sample looks too thin to argue from. Suspects far above the budget is itself a signal worth quoting: it means a large part of the site looks, from its HTML alone, like it is not the whole page. Render failures are worth a look on their own, since a page a browser could not finish loading is a page a search engine may struggle with too.",
  },
  "site.health": {
    title: "Pages carrying a finding, by worst severity",
    explanation:
      "How this crawl's own findings spread across the pages it judged. The first number is how many auditable pages there are: pages the crawler fetched OK that answered 200 with HTML. Then four counts, each page appearing in exactly one of them, at the WORST severity it carries — a page with a critical finding and three warnings is counted once, as critical: how many pages carry a critical finding, how many carry a warning and no critical, how many carry only informational findings, and how many carry no finding of any severity. The four add up to the auditable page count exactly. Last is the clean ratio, the pages carrying no finding divided by the auditable pages, to four decimal places; it is empty rather than zero or one when the crawl has no auditable pages at all, since a ratio of nothing describes nothing. THE FOUR COUNTS ARE THE AUTHORITY AND THE RATIO IS A CONVENIENCE: four decimal places is not enough of them on a large crawl, where one clean page in fifty thousand rounds to 0.0000 and one page carrying a finding in fifty thousand rounds to 1.0000 — neither of which means what it appears to. Work any percentage out from the counts rather than from the ratio, whatever the size of the crawl. Alongside them is how many pages the crawl fetched that this census leaves out — everything else: redirects, pages that answered 4xx or 5xx, requests that failed or were refused, responses that were not HTML such as a PDF or an image, and any other status that is not 200. The counts above are about pages whose content could be read, and the rest of them are not all covered elsewhere either: the redirect table counts the redirects and the status findings judge the error responses, but a 200 that was not HTML is counted by neither, which is the other reason this number is here. Add the two together and you have every page of the crawl. Findings that name no page — the sitemap, robots.txt and host-level ones — are about the site rather than about any page, so they appear in none of these counts. THE RATIO IS OF REPORTED FINDINGS, which matters on a crawl whose findings were capped: a capped run stops listing at its cap and records the exact total in a note beside the last finding it wrote, so pages past the cap carry no finding row and are counted here as clean. On such a run the clean ratio is a floor of what is known rather than a fact about the site — the count of findings, not this table, is where the magnitude is. An uncapped run has no such note and no such caveat. THE CHECK THIS TABLE CARRIES IS THE ONE IT IS ABOUT: how far the audit's judgement reached over this site, which is the engine-coverage check the audit answers before any other. Read it there and nowhere else — it is evidence about the crawl, so no verdict on any other check may be reached from it, and anything grouping rules by check should show it under coverage rather than beside a finding about the site. There is no grade here, no label and no threshold: what counts as healthy belongs to whoever reads it, and this table gives them the numbers to decide with.",
    howToFix:
      "Read the four counts as the shape of the work rather than as a score. The critical count is where a client's attention goes first, and it is a count of PAGES, not of findings, so it says how much of the site is affected while the issue listing says how many things are wrong on it. Read the clean count next to the auditable count: a site whose pages are nearly all clean has a short, specific list, while a site where almost every page carries a warning usually has a handful of TEMPLATE-level causes behind it — one missing meta description on a template is one finding per page it renders. That is why the per-rule counts are the better guide to effort: this table says how widely the judgement spread, the issue listing says what it was. Check whether the run was capped before quoting the ratio anywhere a client will read it, and quote the pages left out of the census alongside it, since a crawl of mostly redirects can show a comfortable ratio over the few pages that were readable.",
  },
  "page.weight": {
    title: "Page weight by template",
    explanation:
      "How many bytes each of this site's pages is made of: the HTML the server sent, plus the images, stylesheets and scripts that page's HTML points at, as measured by asking the server for each file. Five measures per row — the total weight of a page, its HTML on its own, and its image, stylesheet and script bytes separately — each summarised the same way: how many pages were measured, the smallest and largest, the mean, the quartiles, and the 95th percentile, the weight only the heaviest one page in twenty carries. The count is per measure — how many pages actually carry that number — so a page whose HTML size was never recorded is absent from the total-weight and HTML columns, where it would otherwise read as a weightless page, and present in the three resource columns, where what it references is known. Alongside them are three numbers about the evidence itself: how many file references these pages make in total, how many of those files were actually weighed, and how many pages reference at least one file that was not — and where any were not, the row is flagged as a floor. TWO BOUNDS SIT AROUND THESE NUMBERS AND NEITHER OF THEM IS A GUESS. They are a CEILING, because an image offering both a fallback and a set of responsive renditions contributes both files to the sum while a browser downloads one of them, so a responsive template can be counted close to twice over. They are also a FLOOR whenever a file went unweighed — never asked about, refused by our own policy, disallowed by the site's robots.txt, a request that failed, or a file the server sent without a size — since a file with no size adds nothing to the sum. So the honest reading is a range: no more than the total shown once the double-counted renditions are allowed for, and no less than it once the unweighed files are. THE COUNTS ARE THE AUTHORITY: the references-and-weighed pair is what says how much of the page a given row actually saw, and a row whose weighed count is well under its referenced count is describing a fraction of a page. Only files named in the HTML the server sent are counted at all, so a site that injects its images or scripts with JavaScript will show far less weight here than a browser downloads, and that gap is a fact about how the site is built rather than a light page. Only pages that returned 200 and are indexable are measured. The site row covers all of them; each other row is one page type, with pages the crawler could not assign a template to grouped under (untyped).",
    howToFix:
      "Read the script column against the page-weight column first, since that is the ratio a slow template usually turns out to be: a type whose median script weight is a large share of its total is a type whose speed is a build question rather than an editorial one. Then read the image column's upper quartile and 95th percentile against its median — a template whose heaviest pages carry several times the bytes of its typical ones has a handful of unoptimised uploads rather than a systemic problem, and the oversized-image findings name them. Compare each type with the site row before drawing a conclusion about it: a product page legitimately carries more image weight than an article. And check the referenced-and-weighed pair before quoting any of it to a client, because a row that weighed a fraction of what it referenced is a floor with a large unknown above it, and the number to quote there is how much was measured rather than how much the page weighs.",
  },
};

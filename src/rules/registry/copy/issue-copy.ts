/**
 * Client-facing copy for every rule: the title, the description and the fix a
 * site owner reads in a report, an action plan or the demo page.
 *
 * Written in Phase 20 in the register of an SEO tool, not a chat: the owner's
 * instruction (docs/superpowers/specs/2026-09-10-reports-and-copy-design.md
 * §1). The shape follows the Screaming Frog Issues Overview — an area, a
 * condition, one to three sentences on what the rows are and why it matters,
 * one or two imperative sentences on the fix — with the vocabulary
 * practitioners use (indexable, canonicalised, noindex, 4xx, crawl budget,
 * return link). The words are ours; the register is theirs.
 *
 * Provenance of the ORIGINAL entries this file replaced: seonaut (MIT,
 * translations/translation.en.yaml @ 880b312c28fab8b0bf7fe4f9449dc4746dbb82ff)
 * and open-seo (MIT, src/shared/audit-issues.ts @
 * c469a48ae90ab58413b198fe3d1ac1aa90a9b070), adapted in Phase 2 and rewritten
 * in Phases 16–19. None of that text survives here.
 *
 * Two standing constraints on every edit:
 *
 *  1. Say only what the rule detects. The rule source is the contract; copy
 *     that promises more than the analyser measures is a defect.
 *  2. Thresholds in prose match the constants in the rules (title 30–60,
 *     meta description 70–155, H1 70, URL 115, thin content 150 words,
 *     near-duplicate 3 of 64 bits and 50 own words, soft 404 300 words, slow
 *     response 1500 ms, deep page 5, images 100,000 bytes, redirect chain 2
 *     hops). Change one, change both; test/rules/copy.test.ts pins them.
 *
 * Metric rules describe a TABLE: the title names it, the description says
 * what the columns are, the fix says how to read it.
 */

export interface IssueCopy {
  title: string;
  explanation: string;
  howToFix: string;
}

export const ISSUE_COPY: Record<string, IssueCopy> = {
  // ------------------------------------------------------------- canonicals
  "canonical.cross-domain": {
    title: "Canonicals: Canonical points to another host",
    explanation:
      "Pages whose canonical URL is on a different host, www and non-www included. A cross-host canonical hands the page's ranking signals to that host and asks search engines to drop this URL, which is right for syndicated content and wrong for everything else.",
    howToFix:
      "Confirm the cross-host canonical is intended. If not, point the canonical at this page on this host; if the only difference is www versus non-www, fix the canonical to the host you serve and redirect the other.",
  },
  "canonical.html-header-conflict": {
    title: "Canonicals: Conflicting canonical in HTML and HTTP header",
    explanation:
      "Pages that declare one canonical URL in the HTML head and a different one in the HTTP Link header. Search engines discard contradictory canonicals and choose their own.",
    howToFix:
      "Declare the canonical in one place only, normally the HTML head, and remove or align the other.",
  },
  "canonical.missing": {
    title: "Canonicals: Missing canonical",
    explanation:
      "Indexable pages with no canonical URL in the HTML head or the HTTP Link header. Without one, search engines choose the canonical themselves and often pick a parameter, trailing-slash or www variant instead of the URL you want indexed.",
    howToFix:
      "Add a self-referencing canonical with the page's absolute preferred URL, generated in the template so every page in the section gets one.",
  },
  "canonical.multiple": {
    title: "Canonicals: Multiple canonical tags",
    explanation:
      "Pages with more than one rel=canonical link element in the HTML, whether or not they name the same URL; the HTTP Link header is not counted. Search engines cannot tell which is meant and usually ignore all of them.",
    howToFix:
      "Leave exactly one canonical on the page. Duplicates usually come from a theme and a plugin each emitting one; remove it at the layer that should not own it.",
  },
  "canonical.non-200-target": {
    title: "Canonicals: Canonical points to a non-200 URL",
    explanation:
      "Pages whose canonical URL was crawled and did not return 200: a redirect, a 4xx or a 5xx. Signals consolidate into a URL that does not serve a page, so both URLs can drop out of the index.",
    howToFix:
      "Point the canonical at the URL that serves the content with a 200. If the target redirects, canonicalise to its destination; if it is gone, canonicalise to the page itself or to the closest live replacement.",
  },
  "canonical.relative": {
    title: "Canonicals: Canonical is a relative URL",
    explanation:
      "Pages whose canonical link element gives a path such as /page instead of a full address with scheme and host. Search engines resolve it against whatever address served the page, so a copy on a staging host, a mirror or a cache names itself as the original.",
    howToFix:
      "Write the canonical as an absolute URL with the preferred scheme and host, generated in the template so every page carries one.",
  },
  "canonical.fragment": {
    title: "Canonicals: Canonical contains a fragment",
    explanation:
      "Pages whose canonical URL ends in a # fragment. Search engines index addresses without the fragment, so the canonical names a URL that does not exist as written and may be ignored.",
    howToFix:
      "Remove the fragment from the canonical and point it at the clean address of the page.",
  },
  "canonical.chain": {
    title: "Canonicals: Canonical chain or loop (followed up to 10 hops)",
    explanation:
      "Pages whose canonical target is itself canonicalised to another URL, so the signals have to pass through more than one page. The Canonical Chain column lists the URLs from the one this page's canonical names onward, in order; Loop is true when the chain comes back to a page already on it, Hop Limit Reached when it was still going after 10 hops and the walk stopped, and Next URL Not Crawled As 200 names where it was heading when it reached a page the crawl has no 200 for. Search engines may stop following a chain, and a loop gives them no final page at all.",
    howToFix:
      "Point the canonical straight at the last URL of the chain, the one that canonicalises to itself (or, if the chain ends at an address that does not answer 200, at the live page that should hold the content). For a loop, decide which page should be the original and make it canonical to itself.",
  },
  "canonical.unlinked": {
    title: "Canonicals: Canonical target has no internal links",
    explanation:
      "Pages whose canonical points at a crawled page that no other page on the site links to; a link from the page to itself does not count. Search engines treat a canonical as a hint, and a target with no links in is easy to overrule or to never find.",
    howToFix:
      "Link to the canonical target from the site's navigation or content, or choose a canonical that is part of the site's link structure.",
  },
  "canonical.non-indexable-target": {
    title: "Canonicals: Canonical points to a noindex page",
    explanation:
      "Pages whose canonical URL was crawled and carries noindex in its robots meta tag or X-Robots-Tag header. The page asks search engines to consolidate into a URL that refuses indexing, so neither URL is left as an indexable home for the content.",
    howToFix:
      "Decide which URL should rank. Remove the noindex from the target, or point the canonical at the page itself and leave the target excluded.",
  },
  "canonical.points-elsewhere": {
    title: "Canonicals: Canonicalised",
    explanation:
      "Pages whose canonical names a different URL, so search engines index that URL instead of this one; correct for parameter and syndicated variants, a problem when the page was meant to rank on its own. A canonical that could not be parsed as a URL is listed with Unparseable set and points nowhere.",
    howToFix:
      "If the page should rank, make the canonical self-referencing. If the canonical is intentional, check that its target returns 200 and is itself canonical. Replace an unparseable canonical with an absolute URL.",
  },
  "directive.canonical-noindex-conflict": {
    title: "Canonicals: Canonical and noindex on the same page",
    explanation:
      "Pages that carry noindex and also canonicalise to a different URL. The canonical asks search engines to consolidate into another page; the noindex asks them to drop this one. Which instruction wins is undefined.",
    howToFix:
      "Pick one intent. To consolidate, remove the noindex; to keep the page out of the index, remove the canonical or make it self-referencing.",
  },

  // ---------------------------------------------------------------- content
  "content.csr-dependent": {
    title: "Rendering: Main content only in rendered HTML",
    explanation:
      "Pages where the rendered page has at least twice the renderable words of the HTML response, and at least 150 more (markup-hidden text is excluded on both sides). The content is assembled by JavaScript, so crawlers receive a shell first and the text only after rendering, which search engines do later and on a budget. Only pages the render run opened can be checked.",
    howToFix:
      "Serve the main content in the HTML response: server-side rendering, static generation or a pre-rendered snapshot, starting with the templates that earn traffic.",
  },
  "content.exact-duplicate": {
    title: "Content: Exact duplicates",
    explanation:
      "Groups of indexable, self-canonical pages that return identical visible text; each row gives the exact page count and up to 20 of the URLs. Hreflang alternates are not exempt: two locale versions with byte-identical text means the translation is missing. Search engines index one copy and drop the rest, and the links and signals meant for one page are split between copies.",
    howToFix:
      "Pick the URL that should rank and canonicalise or 301 the copies to it. On templated sites fix the pattern that creates them: a print view, a parameter, a second path to the same page; for identical locale versions, translate the page.",
  },
  "content.metrics-by-type": {
    title: "Content: Word count by template",
    explanation:
      "For the site and for each page template: word count, renderable word count (the same text minus markup-hidden parts) and text ratio (visible-text bytes as a share of HTML bytes), each as count, min, max, mean, quartiles and 95th percentile over indexable, self-canonical 200 pages. Pages without a template are grouped as (untyped).",
    howToFix:
      "Compare each template with the site row and with the template's purpose; a listing carries less text than an article. A large gap between word count and renderable word count is hidden template chrome on every page of that template.",
  },
  "content.near-duplicate": {
    title: "Content: Near duplicates (main content within 3 of 64 fingerprint bits)",
    explanation:
      "Indexable, self-canonical pages whose main content is near-identical to at least one other such page: fingerprints within 3 bits of 64, compared on the content area with header, navigation, sidebar and footer excluded, both pages carrying at least 50 words of their own. Pages that declare each other as hreflang alternates are not compared with each other. Each page is listed once with how many near duplicates it has (exact up to 200) and the closest five; search engines group pages this similar and show one.",
    howToFix:
      "Merge near-duplicate pages into one stronger page and redirect the rest, or give each page substantive content of its own. Canonicalise filtered and parameterised variants to the base page.",
  },
  "content.near-duplicate-skipped": {
    title: "Content: Near duplicates not checked on this crawl",
    explanation:
      "No page in this crawl carries a main-content fingerprint, so pages could not be compared; the check was left unrun rather than reported clean.",
    howToFix:
      "Re-crawl the site. The fingerprint is recorded for every page with main content on crawls from this version onwards.",
  },
  "content.placeholder": {
    title: "Content: Lorem ipsum placeholder text",
    explanation:
      "Indexable, self-canonical pages whose visible text contains \"lorem ipsum\". The row quotes up to 160 characters of visible text from the match (empty on crawls taken before the quote was recorded). Search engines index it and visitors see it.",
    howToFix:
      "Replace the quoted text with real copy or unpublish the page. Check excerpts, summaries and descriptions as well as the body, and search the CMS for the phrase: placeholder text usually sits in the same field on several records.",
  },
  "content.soft-404": {
    title: "Content: Soft 404 (not-found wording under 300 words, or the not-found template)",
    explanation:
      "Pages returning 200 that look like an error page, whatever their directives or canonical say: not-found wording with fewer than 300 renderable words, or content within 4 of 64 fingerprint bits of the site's real not-found page. Search engines treat them as errors, keep them out of the index and keep re-crawling them.",
    howToFix:
      "Return a real 404 or 410 for content that is gone, or 301 to the closest live page. If the page is genuine, expand it so it no longer resembles the error template, and check what links to it.",
  },
  "content.template-similarity": {
    title: "Content: Similarity within each template",
    explanation:
      "For each page template, how alike its pages are: mean fingerprint distance in bits (0 identical, 64 unrelated), quartiles, and the share of pairs within 3 and within 8 bits, over a sample of up to 200 fingerprinted pages per template chosen arbitrarily but stably. Each row states how many pages carry a fingerprint, how many were sampled and how many pairs were compared; a template with fewer than two fingerprinted pages has no row.",
    howToFix:
      "Consolidate a template whose share within 3 bits is high, or give each page content of its own; a wide spread means the template is really two.",
  },
  "content.thin": {
    title: "Content: Low content pages (under 150 words of own content)",
    explanation:
      "Indexable, self-canonical pages with fewer than 150 words of their own content: the text inside the page's main area, or the whole body where none is marked, in both cases with header, navigation, sidebar and footer excluded. Each row shows own words beside the whole-document word count; a page with no own text shows 0.",
    howToFix:
      "Add content that answers the page's query, consolidate the page into a stronger one, or noindex it if it exists for another reason. If own words are far below the document total, check that the template's content field is being filled for this record.",
  },
  "content.thin-skipped": {
    title: "Content: Low content pages not checked on this crawl",
    explanation:
      "No page in this crawl carries a count of its own content, so no page could be judged thin; the check was left unrun rather than reported clean, because the whole-document word count would call an empty page healthy on a site with heavy shared chrome.",
    howToFix:
      "Re-crawl the site. The count is recorded for every page with main content on crawls from this version onwards.",
  },

  // ------------------------------------------------------------------ crawl
  "crawl.blocked": {
    title: "Response codes: Blocked by bot protection (not audited)",
    explanation:
      "URLs that answered the crawler with an access denial or a bot challenge (401, 403, 429, a challenge page served on a 503, or a Cloudflare cf-mitigated header on any status) instead of the page; the Block Reason column names which, and the Indexability Status column reads Blocked by bot protection whatever status code the challenge carried. Nothing on them could be checked. This describes how the crawl was received, not the page; whether search engine crawlers meet the same block is a separate question.",
    howToFix:
      "Allowlist the crawler's user agent (AriadneBot unless overridden) in the WAF or bot-protection settings and crawl again. If the block is deliberate and applies to search engines too, confirm those URLs are meant to be unreachable.",
  },
  "crawl.unreadable-encoding": {
    title: "Crawl: Page served in an unreadable compression format (not audited)",
    explanation:
      "URLs that answered with a content-encoding the crawler did not ask for and cannot decode, so nothing on them was checked; the Encoding column names the format. Servers should only use a compression format the client lists in its Accept-Encoding header.",
    howToFix:
      "Check the server or CDN compression settings for these URLs and serve them gzip-compressed or uncompressed when gzip is the only format requested.",
  },
  "http.no-response": {
    title: "Response codes: Internal no response",
    explanation:
      "Internal URLs that gave no HTTP response at all: the request timed out, or the connection or DNS lookup failed. Each is requested a second time at the end of the crawl where the re-check budget allows; the row says whether the failure was confirmed, no second request was made because robots.txt or the crawler's policy refused it (inconclusive), the re-check budget ran out or the host stopped answering altogether (capped), or no second look was made (not run). A URL that does not answer cannot be crawled or indexed, and links to it lead visitors nowhere.",
    howToFix:
      "Request the URL from outside your network and check the server, firewall and DNS for it. If it should not exist, remove the internal links pointing to it.",
  },
  "http.no-response-transient": {
    title: "Response codes: Intermittent no response (answered on re-check)",
    explanation:
      "Internal URLs that gave no HTTP response during the crawl and did answer when requested again at the end of it; the Recheck Status Code column shows the second answer. A 200 there means the URL recovered; a 4xx, 5xx or redirect means it is broken in a different way. Timeouts and dropped connections make search engines slow their crawling of the whole site.",
    howToFix:
      "Read the server, proxy and CDN logs around the crawl time; the row gives the seconds between the two requests. Check for overloaded workers, rate limits and connection limits that fail under load.",
  },
  "http.server-error": {
    title: "Response codes: Internal server error (5xx)",
    explanation:
      "URLs that returned a 5xx server error. Each was requested a second time at the end of the crawl; the row says whether the error was confirmed, the second request got no answer about the page (timeout, network error, a bot block, or not made because robots.txt or the crawler's policy refused it: inconclusive), the re-check budget ran out (capped) or no second look was made (not run). Repeated 5xx responses slow crawling of the whole site and eventually drop the URLs from the index.",
    howToFix:
      "Check the server and application logs for the URL around the crawl time and fix the error. If the page is gone, return 404 or 410, or 301 to the closest live page.",
  },
  "http.server-error-transient": {
    title: "Response codes: Intermittent server error (5xx cleared on re-check)",
    explanation:
      "URLs that returned a 5xx during the crawl and a non-5xx response when requested again at the end of it; the Recheck Status Code column shows what the second request got. A 200 there means the page recovered; a 4xx or a redirect means the URL is broken in a different way, not fixed. An intermittent 5xx makes search engines back off the whole site and shows visitors an error page during the outage.",
    howToFix:
      "Read the application, proxy, load balancer and CDN logs around the crawl time; the row gives the seconds between the two requests. Restarts, deploys, exhausted connection pools and upstream timeouts are the usual causes.",
  },
  "page.html-too-large": {
    title: "Response codes: HTML over 2 MB",
    explanation:
      "Internal HTML pages that returned a 2xx status with a body larger than 2 MB (2,097,152 bytes) once decompressed. Nothing on them was checked, because the crawler stops reading at 2 MB; search engines also stop reading HTML at a size limit, so content and links past it may never be indexed.",
    howToFix:
      "Cut the HTML below 2 MB: move inline scripts, styles and embedded JSON into external files, paginate long lists and remove repeated markup.",
  },
  "render.coverage": {
    title: "Rendering: Browser render coverage",
    explanation:
      "How much of the crawl was rendered in a browser: pages crawled, whether a render run happened or the last one could not start (with the reason in Render Launch Error), the selection mode (automatic or explicit), the render budget, how many pages looked incomplete from their HTML, how many were sampled site-wide, how many were selected, whether the selection was truncated, and how many pages rendered or failed. In explicit mode the budget, suspect, sample and truncation numbers are empty; when no render run happened, the selection numbers show what a run would choose.",
    howToFix:
      "Read this before quoting any rendering finding. If no run happened, the rendering findings are silent because nothing was measured. If the last run could not start, the pages it selected are still waiting to be rendered: pages an earlier run rendered still count, and everything else is unmeasured until a run succeeds. Rendered against crawled is the sample size; a truncated selection means the budget, not the site, decided where the run stopped.",
  },
  "robots.blocks-internal-urls": {
    title: "Robots.txt: Internal URLs blocked by robots.txt",
    explanation:
      "Internal URLs linked from crawled pages that robots.txt disallows for the crawler's user agent; they were not requested. Each URL is listed once with the Disallow line that matches it and the number of pages linking to it. A blocked URL cannot be read, so at best it is indexed as a bare URL with no title or description, and the links pointing at it lead nowhere a search engine can follow.",
    howToFix:
      "Confirm each Disallow is intended. If the pages should be found, narrow or remove the rule; if they should not, remove the internal links to them, and use noindex rather than robots.txt where the aim is to keep a page out of the index.",
  },
  "robots.blocks-sitemap-urls": {
    title: "Robots.txt: Sitemap URLs blocked by robots.txt",
    explanation:
      "URLs listed in the sitemap that robots.txt disallows for the crawler's user agent; the row shows the URL and, where it can be named, the Disallow line. A blocked URL cannot be read, so at best it is indexed as a bare URL with no title or description.",
    howToFix:
      "If the pages should be found, narrow or remove the Disallow rule. If they should not, remove them from the sitemap; to keep them out of the index rather than the crawl, use noindex on the page instead.",
  },
  "robots.check-skipped": {
    title: "Robots.txt: Robots.txt checks not run on this crawl",
    explanation:
      "The robots.txt was truncated at the 500 KB read, could not be fetched, or was fetched empty, so the sitemap-blocking and sitemap-declaration checks were left unrun rather than answered from an incomplete file.",
    howToFix:
      "If robots.txt is over 500 KB, cut it down: search engines apply their own size limits and ignore rules past them. If it could not be fetched, fix the server and crawl again.",
  },
  "robots.missing": {
    title: "Robots.txt: No robots.txt",
    explanation:
      "The site returned a not-found response for /robots.txt. Crawlers then fetch everything, which is valid, but there is nowhere to declare the sitemap or exclude sections that should not be crawled.",
    howToFix:
      "Add a robots.txt at the site root with at least a Sitemap: line pointing at the XML sitemap. Keep crawling rules permissive unless a section genuinely should not be fetched.",
  },
  "site.health": {
    title: "Site: Pages by worst finding severity",
    explanation:
      "Of the pages the audit judges (200, HTML, indexable, self-canonical), how many carry a critical finding, how many a warning and no critical, how many only informational findings, and how many none, each page counted once at its worst severity, with the clean ratio; beside them, the 200 pages set aside as noindex or as canonicalised to another URL, and the other recorded URLs (redirects, errors, blocked by bot protection or by robots.txt, failed, non-HTML). The four buckets plus the two set-aside counts plus the other URLs add up to every URL the crawl recorded; the paginated count is not part of that sum, because those pages (pages 2 onwards of a series) are judged pages left out of the duplicate title, meta description and H1 checks only. Site-wide findings appear in none of the counts, on a capped run pages past the cap count as clean, and this table is the evidence for the engine-coverage check, not a finding about the site.",
    howToFix:
      "Read the counts as the shape of the work, not as a score: the critical count says how much of the site is affected, and the issue list says what is wrong. Read the set-aside counts to know how much of the site the audit judged; work percentages out from the counts, and check whether the run was capped before quoting the ratio.",
  },

  // ------------------------------------------------------------------ hosts
  "host.duplicate-host-200": {
    title: "URL: www and non-www both serve the site",
    explanation:
      "Both the https www and https non-www hosts return pages with no redirect between them. Every URL exists twice, and links, rankings and crawl budget are split across two hosts serving the same content.",
    howToFix:
      "Choose one host and 301 the other to it, path and query intact. Update internal links, the sitemap and canonical tags to the chosen host.",
  },
  "host.http-serves-200": {
    title: "Security: HTTP URLs served without redirect to HTTPS",
    explanation:
      "Host variants whose redirect chain ends on an HTTP URL returning 200; the Address column is the variant that was requested and the row shows the hops. Browsers flag the page as not secure and search engines can index the HTTP version as a separate URL that competes with the secure one.",
    howToFix:
      "301 every HTTP URL to its HTTPS equivalent in a single hop, preserving path and query, and send an HSTS header on the HTTPS response.",
  },
  "host.legacy-host-reachable": {
    title: "URL: Former domain still serves its own site",
    explanation:
      "A domain the site previously used still returns pages instead of redirecting to the current site. The old site stays indexable, competes for the same queries, and links earned on it stop short of the live site.",
    howToFix:
      "301 the retired domain to the matching URL on the live site, page by page, and keep the redirects indefinitely. If the domain is meant to stay separate, make sure it does not serve the same content.",
  },
  "host.probe-skipped": {
    title: "URL: Host variants not checked on this crawl",
    explanation:
      "This crawl has no host-check record: host checks were off, or the crawl ended before they ran. Whether the HTTP, www, non-www and former-domain variants redirect to the canonical HTTPS host is unknown for this crawl.",
    howToFix:
      "Re-run the crawl with host checks on. Meanwhile, request each host variant by hand and follow the redirects to confirm they end on the canonical HTTPS host.",
  },

  // --------------------------------------------------------------- security
  "security.headers-missing": {
    title: "Security: Protective response headers missing or unsafe",
    explanation:
      "HTTPS pages that send no enforced Content-Security-Policy, no X-Content-Type-Options: nosniff, no frame protection (X-Frame-Options or a CSP frame-ancestors directive) or no safe Referrer-Policy; the Missing Headers column names which. A Referrer-Policy of unsafe-url or no-referrer-when-downgrade counts as unsafe because it sends the full address to other sites. These headers do not affect rankings directly; they limit what a hijacked script, a framing site or a link click can do to your visitors.",
    howToFix:
      "Add the missing headers at the server or CDN so every response carries them. Start with X-Content-Type-Options: nosniff and Referrer-Policy: strict-origin-when-cross-origin, add frame protection, then roll out a Content-Security-Policy in report-only mode before enforcing it.",
  },
  "security.headers-not-recorded": {
    title: "Security: Security headers not checked on this crawl",
    explanation:
      "Some or all pages in this crawl were stored without their response headers, so no page could be judged on HSTS or the other protective headers; the check was left unrun rather than reported clean. The Pages Without Recorded Headers column counts the pages affected.",
    howToFix:
      "Re-crawl the site. Response headers are recorded for every page on crawls from this version onwards.",
  },
  "security.hsts-missing": {
    title: "Security: HTTPS page without HSTS header",
    explanation:
      "HTTPS pages that send no Strict-Transport-Security header. Without it a browser still tries plain HTTP first on a visitor's first request, which leaves a window for a downgrade or interception on an untrusted network.",
    howToFix:
      "Send Strict-Transport-Security on every HTTPS response, for example max-age=31536000; includeSubDomains. Start with a short max-age, confirm nothing on the host still needs HTTP, then raise it.",
  },
  "security.http-url": {
    title: "Security: Page served over HTTP on an HTTPS site",
    explanation:
      "Pages whose address starts with http:// on a site that was crawled over https://, and that answered 200. Visitors get a not-secure warning and search engines can index the HTTP address as a duplicate of the secure one.",
    howToFix:
      "301 each HTTP address to its HTTPS equivalent, and change the internal links, canonicals and sitemap entries that still point at the HTTP address.",
  },
  "security.mixed-content": {
    title: "Security: HTTPS page loading HTTP resources",
    explanation:
      "HTTPS pages that reference images, scripts or stylesheets with an http:// address; the row shows how many and lists up to 10 of them. Browsers block or warn about these files, so a page can lose its scripts or styles or show a not-secure warning even though it was served securely. Only img src, stylesheet and script references in the HTML response are checked.",
    howToFix:
      "Change each listed address to https://, or to a path on your own host, and check that the file is served over HTTPS. Where a template or CMS field produces the address, fix it there.",
  },

  // --------------------------------------------------------------- hreflang
  "hreflang.alternates-not-crawled": {
    title: "Hreflang: Alternate URLs not crawled",
    explanation:
      "Hreflang alternates declared by pages in this crawl whose URLs were not fetched, grouped by host with the number of URLs and of declaring pages. The return-link and indexability checks cover fetched URLs only, so nothing is known about these. A host outside the crawl's start URL is not crawled by design; an uncrawled alternate on the crawled host was excluded by robots.txt or a crawl limit.",
    howToFix:
      "Add the alternate domains as extra start URLs so one crawl covers the whole international set, or crawl each domain and read the results together. For an uncrawled alternate on the crawled domain, check the robots.txt rule or crawl limit that excluded it.",
  },
  "hreflang.coverage": {
    title: "Hreflang: Share of pages declaring hreflang",
    explanation:
      "For the site and for each template: how many indexable, self-canonical 200 pages declare at least one hreflang alternate (HTML, HTTP header or sitemap), how many were measured, and the percentage. A page counts once regardless of how many alternates it names.",
    howToFix:
      "Read coverage against the site: on a single-language site low coverage is expected, and on an international site a template near zero beside others near 100% has been left out of the hreflang generator.",
  },
  "hreflang.invalid-code": {
    title: "Hreflang: Invalid language or region code",
    explanation:
      "Pages with an hreflang value that is not in language or language-region form (en, en-gb, es-419); whether the code exists is not checked. Search engines ignore annotations they cannot parse, so the alternate is not served.",
    howToFix:
      "Use a valid ISO 639-1 language code, optionally with an ISO 3166-1 region: en, en-gb, es-419. x-default is the only special value.",
  },
  "hreflang.missing-return-link": {
    title: "Hreflang: Missing return link",
    explanation:
      "Pages that name an alternate which was crawled and does not name this page back. Hreflang is only honoured when reciprocal, so the one-way annotation is ignored. Pages canonicalised to another URL are ignored as declarers and as alternates; alternates that were not crawled are reported separately as not checked.",
    howToFix:
      "Make the annotations reciprocal: every page in the set declares the same full list of alternates, itself included. Generate the block from one language-to-URL mapping and render it on every page in the set.",
  },
  "hreflang.missing-self-reference": {
    title: "Hreflang: Missing self-reference",
    explanation:
      "Pages that declare hreflang alternates without including their own URL; pages canonicalised to another URL are ignored. Search engines discard a set that omits the page it is on, so none of the listed versions are connected. URLs are compared ignoring host case, query order and fragments.",
    howToFix:
      "Add an alternate for the page's own URL with its language and region code. Generate the whole set from one mapping and render the identical block on every version.",
  },
  "hreflang.inconsistent-return-code": {
    title: "Hreflang: Return link uses a different code than the page itself",
    explanation:
      "Pages that list a crawled alternate which links back to them under a different language code than the page uses for itself, such as en-gb in the return link and en in the page's own entry. Pages with no entry for their own URL, alternates that do not link back and alternates that were not crawled are not judged here, and x-default is ignored on both sides. Search engines may discard a set whose pages disagree about which language a page is.",
    howToFix:
      "Give each page one code and write it the same way in every version's block. Generate the whole set from one mapping and render the identical block on every version.",
  },
  "hreflang.multiple-entries": {
    title: "Hreflang: Same code listed for different URLs",
    explanation:
      "Pages whose hreflang block gives one language code to two or more different URLs; spellings of one URL that differ only by fragment, host case or query order count as one. Search engines cannot tell which URL the code stands for and may ignore both. Only the block on the page is read, and the alternates are not fetched.",
    howToFix:
      "Keep one URL per code and remove the stale or duplicate entry. Generate the block from one mapping so a code cannot be added twice.",
  },
  "hreflang.self-only": {
    title: "Hreflang: Block names only the page itself",
    explanation:
      "Pages whose hreflang block lists only the page's own URL, so no other version is named; pages canonicalised to another URL are ignored. The block is valid but connects nothing, which usually means the other versions were left out of the template.",
    howToFix:
      "Add the other language versions to the block, or remove the block if the page has no alternate versions.",
  },
  "hreflang.unlinked-target": {
    title: "Hreflang: Alternate has no internal links",
    explanation:
      "Crawled pages that other pages name as hreflang alternates but that no other page on the site links to; a link from the page to itself does not count. Search engines treat hreflang as a hint and not as a link, so an alternate that is only annotated is hard to discover. The Declaring Pages column lists up to 10 of the pages that name it and the count is exact; alternates the crawl did not fetch are not judged.",
    howToFix:
      "Link each alternate from its own section's navigation, a language switcher or a related-pages list.",
  },
  "hreflang.missing-x-default": {
    title: "Hreflang: Missing x-default",
    explanation:
      "Hreflang sets (one per declaring page) with two or more versions and no x-default. Visitors who match no listed language or region are sent to whichever version the search engine guesses.",
    howToFix:
      "Add an x-default alternate pointing at the fallback version, usually the international English page or a language selector, on every page in the set.",
  },
  "hreflang.non-indexable-target": {
    title: "Hreflang: Alternate points to a redirect or noindex URL",
    explanation:
      "Pages that name an alternate which was crawled and either redirects or is noindex; alternates that returned 4xx or 5xx are not reported here. An alternate that cannot be served at its own URL cannot be chosen, and the annotation is dropped.",
    howToFix:
      "Point the annotation at the URL that serves that language version with a 200. If the target is deliberately excluded from the index, remove the annotation.",
  },

  // ----------------------------------------------------------- indexability
  "indexability.meta-header-conflict": {
    title: "Directives: Robots meta and X-Robots-Tag conflict",
    explanation:
      "Pages where one of the robots meta tag and the X-Robots-Tag header says noindex and the other does not. Search engines take the most restrictive directive, so the page is treated as noindex.",
    howToFix:
      "Set the robots directive in one place, template or server configuration, and remove the other.",
  },
  "indexability.noindex": {
    title: "Directives: Noindex",
    explanation:
      "Pages with noindex (or none) in the robots meta tag or the X-Robots-Tag header; the Directive Source column says which. Often intentional for admin, thank-you and filtered pages; listed for review, not as an error.",
    howToFix:
      "No action if the exclusion is deliberate. If the page should rank, remove the noindex and request re-indexing.",
  },
  "indexability.nofollow": {
    title: "Directives: Nofollow",
    explanation:
      "Pages with nofollow (or none) in the robots meta tag or the X-Robots-Tag header; the Directive Source column says which. Search engines are told to ignore every link on the page, so the pages it links to get no internal equity from it and may not be discovered through it.",
    howToFix:
      "Remove nofollow from the robots meta tag and the header so the page's links are followed. Leave it only if the page is deliberately closed off, such as a login or user-generated page.",
  },
  "directives.restrictive": {
    title: "Directives: Snippet or image preview restricted",
    explanation:
      "Pages carrying nosnippet, max-snippet:0, max-image-preview:none or noimageindex in the robots meta tag or the X-Robots-Tag header; the Restrictive Directives column lists which. The page stays indexed but results show no text excerpt, no large image preview or no images from it, which usually costs clicks. These are often left over from a template copied from another site.",
    howToFix:
      "Remove the directive if the restriction is not intended. To limit rather than forbid a preview, use a value such as max-snippet:160 or max-image-preview:large.",
  },
  "directives.unavailable-after": {
    title: "Directives: unavailable_after date within 30 days",
    explanation:
      "Pages whose unavailable_after directive names a date that had passed or fell within 30 days of the crawl, or a date search engines cannot read. A page leaves the index once the date passes, and a date that cannot be parsed is ignored, so the page stays indexed when its author expected it to leave. The Days From Fetch column counts the days from the crawl to the date; negative means already past.",
    howToFix:
      "Remove the directive if the page should stay indexed, or move the date well beyond 30 days. If the date cannot be read, rewrite it in a standard format such as 2027-01-31T00:00:00Z.",
  },

  // ------------------------------------------------------------------ links
  "inlinks.distribution": {
    title: "Links: Inlinks per page by template",
    explanation:
      "For the site and for each template: the number of unique internal inlinks per indexable, self-canonical 200 page, as count, min, max, mean, quartiles and 95th percentile. A page counts once per linking page; self-links are not counted; pages with no inlinks count as 0.",
    howToFix:
      "Read the bottom quartile first: those pages are barely supported by internal linking. A template whose median sits well below the site's has been left out of the linking.",
  },
  "inlinks.extremes": {
    title: "Links: Most and least linked pages",
    explanation:
      "The 20 indexable, self-canonical pages with the fewest unique internal inlinks and the 20 with the most, each with its count. Ties are broken by URL.",
    howToFix:
      "Check the least-linked list against the pages that matter commercially; those are the ones to link from the most-linked pages, which are usually navigation hubs.",
  },
  "inlinks.sources-by-type": {
    title: "Links: Inlink sources by template",
    explanation:
      "For each destination template, how many unique internal links reach it from each source template; the 25 largest sources per destination are kept and the rest summed into (other), and pages without a template appear as (untyped) on both sides. Destinations are indexable, self-canonical 200 pages; sources are every crawled page.",
    howToFix:
      "Read each row as a sentence about site structure: a commercial template reached from only one source template depends entirely on that template being crawled; one with no sources is reachable only from the sitemap.",
  },
  "links.broken-internal": {
    title: "Response codes: Internal client error (4xx)",
    explanation:
      "Internal links to URLs that return a 4xx, most often 404 not found or 410 gone. URLs that answered 401, 403 or 429 are reported under Response codes: Blocked by bot protection instead. Each broken URL is listed once with the number of pages linking to it and up to 10 of them; visitors and crawlers reach a dead end and no link value passes.",
    howToFix:
      "Restore the page or 301 it to the closest live URL, then update or remove the links pointing at it. When many pages link to the same URL the link is in a template; fix it there once.",
  },
  "links.orphan": {
    title: "Links: Orphan pages",
    explanation:
      "Indexable, self-canonical pages that were crawled and that no other page links to; self-links do not count, the start URL is excluded, and a page in the sitemap but linked from nowhere is still an orphan. Orphans are crawled rarely and receive no internal link value. Where the crawl could not fetch some URLs, the row says how many, since one of them could link here.",
    howToFix:
      "Link to the page from a hub, category, navigation or related content. If nothing on the site has a reason to link to it, consolidate or remove it.",
  },
  "links.orphan-skipped": {
    title: "Links: Orphan pages not checked on this crawl",
    explanation:
      "The check needs a crawl that reached every URL it knew about and a recorded page limit to compare against; this crawl left URLs unfetched, stopped at its page limit, or stored no page limit. A page nothing appears to link to may be linked from a page that was never fetched, so the check was left unrun rather than reporting the crawl's own limits as orphans.",
    howToFix:
      "Re-run or resume the crawl so the queue drains, with a page limit above the site's page count.",
  },
  "links.to-server-error": {
    title: "Response codes: Internal server error (5xx) linked internally",
    explanation:
      "Internal links to URLs that returned a 5xx on the crawl's first request: 500 internal server error, 502 bad gateway, 503 service unavailable, 504 gateway timeout. Each URL is listed once with the number of pages linking to it and up to 10 of them. The URL's own server-error row says whether the re-check at the end of the crawl confirmed the error, found it cleared, or was not made.",
    howToFix:
      "Fix the server error at the target first, using the application, proxy and CDN logs around the crawl time. If the URL is retired, return 404 or 410 or 301 it, then update the links.",
  },

  // ---------------------------------------------------------------- on-page
  "h1.duplicate-skipped": {
    title: "H1: Duplicate H1 not checked on this crawl",
    explanation:
      "This crawl stored no H1 text although its judged pages carry H1 elements, which is what a crawl taken before H1 text was recorded looks like. Duplicate H1s could not be detected; the check was left unrun rather than reported clean.",
    howToFix:
      "Re-crawl the site. H1 text is recorded on every crawl from this version onwards.",
  },
  "h1.duplicate-text": {
    title: "H1: Duplicate",
    explanation:
      "Groups of indexable, self-canonical pages whose first H1 is identical. Pages that declare each other as hreflang alternates count as one page, and pages 2 onwards of a paginated series (those declaring rel=prev) are left out; each row names the H1, the number of distinct pages, up to 20 of their URLs (one per hreflang set), how many alternates were folded in and how many paginated pages were set aside across the site. Pages with the same H1 claim to be about the same thing.",
    howToFix:
      "Generate the H1 from the fields that make each page different. Where a layout puts the section name in the H1 and the real headline in a styled div, swap them.",
  },
  "head.directives-outside-head": {
    title: "Directives: Canonical, robots or hreflang outside <head>",
    explanation:
      "Pages whose canonical link, robots meta tag or hreflang links appear after the <head> has ended, either at </head> or where an element that is not allowed in the head (an image, a div, visible text) closed it early; the Closed By column names that element. Search engines read these directives only from the head and may ignore them here, so the page can be indexed under a URL, a language or an indexing state you did not choose.",
    howToFix:
      "Move the tags into the <head> above any other markup, and remove or move the element named in Closed By out of the head; it is usually a tracking pixel, an injected banner or a stray text node from a plugin.",
  },
  "head.tags-outside-head": {
    title: "Page titles: Title or meta description outside <head>",
    explanation:
      "Indexable, self-canonical pages whose title or meta description appears after the <head> has ended, either at </head> or where an element that is not allowed in the head closed it early; the Closed By column names that element. Search engines may ignore a title or description outside the head and write their own.",
    howToFix:
      "Move the title and meta description into the <head> above any other markup, and remove or move the element named in Closed By out of the head.",
  },
  "headings.h1-missing": {
    title: "H1: Missing",
    explanation:
      "Indexable, self-canonical pages whose HTML response has no H1. The H1 states the page's main topic for search engines and is the first landmark screen-reader users jump to.",
    howToFix:
      "Add one H1 that states the page's main topic, consistent with the title. If the visual headline is a styled div or span, change the element rather than adding a second heading.",
  },
  "headings.h1-multiple": {
    title: "H1: Multiple",
    explanation:
      "Indexable, self-canonical pages with more than one H1. Valid HTML, but on most templates an accident such as a logo and a headline both marked up as H1, leaving no single heading that names the page's subject.",
    howToFix:
      "Keep one H1 for the main heading and demote the rest to H2 or H3; mark up a logo with a non-heading element.",
  },
  "headings.h1-too-long": {
    title: "H1: Over 70 characters",
    explanation:
      "Indexable, self-canonical pages whose first H1 is longer than 70 characters; H1 text over 300 characters is reported as 300. A long H1 is usually a sentence of body copy marked up as a heading, which dilutes the one heading that names the page's subject.",
    howToFix:
      "Shorten the H1 to the page's subject in 70 characters or fewer and move the rest into the paragraph below it.",
  },
  "headings.level-skip": {
    title: "Headings: Non-sequential levels (skip of more than 1)",
    explanation:
      "Indexable, self-canonical pages whose headings step down more than one level, such as an H4 directly under an H2; the row shows the first skip. Assistive technology and parsers read the heading outline, and a skipped level breaks it.",
    howToFix:
      "Make heading levels descend one step at a time. Where a level was skipped for a smaller font, fix the CSS instead.",
  },
  "meta-description.duplicate": {
    title: "Meta description: Duplicate",
    explanation:
      "Groups of indexable, self-canonical pages with an identical meta description. Pages that declare each other as hreflang alternates count as one page, and pages 2 onwards of a paginated series (those declaring rel=prev) are left out; each row names the description, the number of distinct pages, up to 20 of their URLs (one per hreflang set), how many alternates were folded in and how many paginated pages were set aside across the site. Duplicate descriptions are replaced by search engines with text from the page.",
    howToFix:
      "Write the description in the template from fields that differ per page. Where a section has nothing distinct to say, leave the description off rather than repeating one.",
  },
  "meta-description.missing": {
    title: "Meta description: Missing",
    explanation:
      "Indexable, self-canonical pages whose HTML response has no meta description, or an empty one. Search engines then build the snippet from page text, which is less compelling and lowers click-through rate.",
    howToFix:
      "Add a unique meta description of 70 to 155 characters that summarises the page and gives a reason to click.",
  },
  "meta-description.too-long": {
    title: "Meta description: Over 155 characters",
    explanation:
      "Indexable, self-canonical pages whose meta description exceeds 155 characters. Search results cut descriptions by pixel width, so the closing words are lost.",
    howToFix:
      "Trim the description to 155 characters or fewer, keeping the core message and the reason to click in the first sentence.",
  },
  "meta-description.too-short": {
    title: "Meta description: Below 70 characters",
    explanation:
      "Indexable, self-canonical pages whose meta description is under 70 characters. Short descriptions waste the snippet space and are frequently replaced by search engines with text from the page.",
    howToFix:
      "Expand the description to 70 to 155 characters. Where a whole section is short, build it in the template from fields that differ per page.",
  },
  "title.duplicate": {
    title: "Page titles: Duplicate",
    explanation:
      "Groups of indexable, self-canonical pages with an identical title. Pages that declare each other as hreflang alternates count as one page, and pages 2 onwards of a paginated series (those declaring rel=prev) are left out; each row names the title, the number of distinct pages, up to 20 of their URLs (one per hreflang set), how many alternates were folded in and how many paginated pages were set aside across the site. Duplicate titles make pages indistinguishable in search results and are typically a template writing the same string for every item.",
    howToFix:
      "Build the title in the template from the fields that differ between pages (product, article, location, page number) with the shared part short and last. If the pages are the same page at several URLs, canonicalise or redirect the copies.",
  },
  "title.missing": {
    title: "Page titles: Missing",
    explanation:
      "Indexable, self-canonical pages whose HTML response has no title tag, or an empty one. The title is a primary relevance signal and the headline of the search result; without one, search engines write their own from page text.",
    howToFix:
      "Add a unique, descriptive title naming the page's main topic (30 to 60 characters is the usual target), generated in the template from the fields that differ per page.",
  },
  "title.too-long": {
    title: "Page titles: Over 60 characters",
    explanation:
      "Indexable, self-canonical pages whose title exceeds 60 characters. Search results cut titles by pixel width, so long titles lose their ending and a title under 60 characters can still be cut.",
    howToFix:
      "Shorten the title to 60 characters or fewer, front-loading the important words and moving or dropping the site name.",
  },
  "title.too-short": {
    title: "Page titles: Below 30 characters",
    explanation:
      "Indexable, self-canonical pages whose title is under 30 characters. A title this short rarely says what the page is about and who it is for, and leaves most of the space in a search result unused.",
    howToFix:
      "Expand the title to a descriptive phrase of 30 to 60 characters: the page's subject first, then what sets it apart, then the brand. Where a whole section is short, add the missing part in the template.",
  },

  // -------------------------------------------------------------- redirects
  "redirect.chain": {
    title: "Redirects: Redirect chain (2 or more hops)",
    explanation:
      "URLs that redirect to a URL that redirects again; the row lists the chain and the final status. Chains are followed up to 10 hops; a chain marked truncated is longer than that and may be a loop. Each hop costs a request, chains break when a middle hop is removed, and search engines stop following after a limited number of hops.",
    howToFix:
      "Point the first redirect straight at the final destination, then update internal links, sitemap entries and canonicals that still name the old URL.",
  },
  "redirect.js": {
    title: "Redirects: JavaScript redirect",
    explanation:
      "Pages that returned a 2xx HTML response and then navigated elsewhere once JavaScript ran in the render run; the row shows the destination and whether the render completed (a render stopped by an off-site destination is the commonest shape). The HTTP response shows no redirect, so links to the URL pass no signal onward and search engines must render the page to learn the content has moved. Only pages the render run opened can be checked.",
    howToFix:
      "Replace the script with a server-side 301 (permanent) or 302 (temporary). For conditional redirects such as language or country selection, serve the chosen page directly for that request.",
  },
  "redirect.loop": {
    title: "Redirects: Redirect loop",
    explanation:
      "URLs whose redirects return to a URL already visited, so they never resolve. Browsers stop with an error and search engines drop the URLs. Usually two rules fighting, such as a trailing-slash rule against an HTTPS or locale rule.",
    howToFix:
      "Trace the rules behind each hop, decide the destination URL, and make every other URL redirect to it directly. Test the entry URL with redirects followed until it ends on a 200.",
  },
  "redirect.volume": {
    title: "Redirects: Redirect volume",
    explanation:
      "How many crawled URLs returned a redirect, out of all fetched URLs and as a percentage; how many internal links point at a redirecting URL; and how many redirect chains and loops the crawl found. Each redirecting URL counts once.",
    howToFix:
      "The percentage is the crawl-budget cost; the inlink count says how much of it is worth fixing. Point internal links, sitemap entries and navigation at destination URLs so the redirects stop being crawled on every visit.",
  },

  // --------------------------------------------------------------- sitemaps
  "pages.not-in-sitemap": {
    title: "Sitemaps: Indexable URLs not in sitemap",
    explanation:
      "Indexable, self-canonical 200 pages that were crawled and are not listed in any sitemap; a canonicalised page belongs out of the sitemap and is not reported. They are discovered only through links and are missing from sitemap coverage reporting. Some omissions are deliberate.",
    howToFix:
      "Add the pages to the sitemap, or fix the generator that should have included them. Confirm any deliberate exclusion is a decision rather than an oversight.",
  },
  "sitemap.cross-host-loc": {
    title: "Sitemaps: URL on another host or scheme than its sitemap",
    explanation:
      "Sitemap entries whose scheme or host (www and port included) differs from both the sitemap document that lists them and the crawled site. The sitemaps protocol only lets a document list URLs on its own host unless the other host's robots.txt declares it, so search engines may ignore these; a document elsewhere listing the crawled site's own URLs is that allowed exception and is not reported. The row gives the document and the URL.",
    howToFix:
      "Move each entry into a sitemap on its own host, or correct the generator that is writing the wrong host or scheme (often http against https, or www against the bare domain).",
  },
  "sitemap.invalid": {
    title: "Sitemaps: Sitemap could not be read",
    explanation:
      "Sitemap documents that could not be read: a 4xx or 5xx, no response, a document over the size limit, an unsupported encoding, a non-XML response such as an HTML page served with 200, or a root element that is neither urlset nor sitemapindex. Up to 50 failures are listed and the count is exact. Their URLs are invisible to search engines.",
    howToFix:
      "Request each listed sitemap URL and check the response. A sitemap must be well-formed XML with a urlset or sitemapindex root, served with 200 and an XML content type; remove index entries pointing at sitemaps that no longer exist.",
  },
  "sitemap.lastmod-invalid": {
    title: "Sitemaps: Invalid lastmod date",
    explanation:
      "Sitemap entries whose lastmod is not a W3C date or date-time (YYYY, YYYY-MM, YYYY-MM-DD, or a date-time with a Z or hh:mm zone), or is dated after the crawl began. The row gives the value and which of the two it is: format or future. Search engines ignore a lastmod they cannot trust.",
    howToFix:
      "Output lastmod in W3C format with a zone, and set it to the date the page content last changed, never to the time the sitemap was generated.",
  },
  "sitemap.missing": {
    title: "Sitemaps: No sitemap declared in robots.txt",
    explanation:
      "No robots.txt Sitemap: line was found, or the site has no robots.txt. The site may still have a sitemap, but crawlers cannot discover it on their own.",
    howToFix:
      "Publish an XML sitemap and add a Sitemap: line with its absolute URL to robots.txt. Submit it in Search Console as well.",
  },
  "sitemap.non-200": {
    title: "Sitemaps: Sitemap URLs returning 4xx or 5xx",
    explanation:
      "URLs listed in the sitemap that returned a 4xx or 5xx status when crawled, including 401, 403 and 429 answers to the crawler; the row shows the status code. Redirecting URLs and URLs that got no response are reported separately. Sitemaps should only list indexable, canonical URLs; error URLs waste crawl budget and lower search engines' trust in the file.",
    howToFix:
      "Remove 404 and 410 URLs from the sitemap or restore the pages, and fix a 5xx at the server. For 401, 403 and 429, allowlist the crawler in the bot protection and re-check before deleting the entry. Generate the sitemap from the same source as the pages.",
  },
  "sitemap.non-indexable": {
    title: "Sitemaps: Sitemap URLs that are noindex or canonicalised",
    explanation:
      "URLs listed in the sitemap whose page returns 200 and is either noindex (robots meta tag or X-Robots-Tag header) or canonicalised to another URL; the Reason column says which, noindex first where both apply. A sitemap should list only the URLs you want indexed, and these pages ask for the opposite.",
    howToFix:
      "Remove noindex if the page should rank, otherwise remove the URL from the sitemap. For a canonicalised URL, list the canonical target instead. Filtered, paginated and thank-you pages usually belong out of the sitemap.",
  },
  "sitemap.over-50k-urls": {
    title: "Sitemaps: Sitemap over 50,000 URLs",
    explanation:
      "A sitemap document that lists more than 50,000 URLs, the protocol limit per document; entries past it are not read. The row gives the document and its entry count, a lower bound because a URL listed in two documents is counted once and the crawl stops reading at its entry cap, which can fall before a document's end. No finding is therefore not proof that every document is under the limit.",
    howToFix:
      "Split the sitemap into several documents of 50,000 URLs or fewer and list them in a sitemap index.",
  },
  "sitemap.redirected": {
    title: "Sitemaps: Sitemap URLs that redirect",
    explanation:
      "URLs listed in the sitemap that redirect. A sitemap should name the destination URL that returns 200, so crawlers reach it in one request and the file agrees with the canonical tags.",
    howToFix:
      "Replace each entry with the URL it redirects to. Where a whole class redirects the same way (HTTP to HTTPS, trailing slash), fix the sitemap generator.",
  },
  "sitemap.structure": {
    title: "Sitemaps: Sitemap structure",
    explanation:
      "How sitemap entries are distributed across sitemap documents: how many documents contributed at least one unique entry, total entries, documents dropped for size, documents over the 50,000-entry limit, whether the crawl's entry cap stopped collection (every count is then a floor and the 50,000 check may miss), and the largest 50 documents with their entry counts. An entry in several documents is counted once.",
    howToFix:
      "Split sitemaps by content type so stale sections can be seen and submitted separately. Split any document over 50,000 entries; entries past the limit are not read.",
  },
  "sitemap.url-too-long": {
    title: "Sitemaps: URL over 2,048 characters",
    explanation:
      "Sitemap entries whose URL is longer than 2,048 characters. Search engines may drop or truncate entries that long. The row gives the start of the URL and its length.",
    howToFix:
      "Shorten the URL or remove the entry. A very long address is usually a filter or session parameter that should not be in the sitemap.",
  },
  "sitemap.uncrawled": {
    title: "Sitemaps: URLs in sitemap not crawled",
    explanation:
      "URLs listed in the sitemap that this crawl has no usable record of: on this site but not reached (page or depth limit, robots.txt), outside the crawl's origin (another host, port or scheme, not fetched by design), or requested with no usable response. The row says which.",
    howToFix:
      "Off-origin entries need nothing unless they do not belong in this site's sitemap. For on-site URLs, check they are linked from the site and allowed by robots.txt, and re-run with a higher page limit if the crawl stopped short. Request a URL that got no response yourself.",
  },

  // -------------------------------------------------------- structured data
  "schema.breadcrumb-absent": {
    title: "Structured data: No BreadcrumbList markup on the site",
    explanation:
      "The site has at least 5 indexable, self-canonical pages and no page carries BreadcrumbList JSON-LD. Breadcrumb markup lets search results show the path to a page and tells search engines how sections relate.",
    howToFix:
      "Add a BreadcrumbList block to every template below the home page, generated from the same navigation data as the visible breadcrumbs.",
  },
  "schema.none-on-site": {
    title: "Structured data: No JSON-LD on the site",
    explanation:
      "No page in the crawl carries JSON-LD. Structured data states in machine-readable form what a page is, and is what search engines and AI assistants read to build rich results and cite sources. Only JSON-LD is read; microdata and RDFa are not detected.",
    howToFix:
      "Add JSON-LD to the templates that matter most: Organization on the home page, Product on product pages, Article on editorial, FAQPage where questions are answered. Validate with the Rich Results Test.",
  },
  "schema.product-incomplete": {
    title: "Structured data: Product markup missing required fields",
    explanation:
      "Indexable, self-canonical pages whose Product markup, taken across all its Product blocks, lacks a field a product rich result needs; each row lists the missing fields. An offers block counts only with a price or priceSpecification; gtin, ean and any GTIN length count as a GTIN, and mpn is counted separately.",
    howToFix:
      "Fill in name, image and a priced offers block from the product data the page renders, then add currency, availability, a GTIN and an MPN where they exist, description, SKU and brand. Confirm the page in the Rich Results Test.",
  },
  "schema.self-serving-reviews": {
    title: "Structured data: Self-serving reviews on Organization or LocalBusiness markup",
    explanation:
      "Indexable, self-canonical pages whose markup typed exactly Organization or LocalBusiness carries a rating or reviews about the business itself. Google's review snippet policy treats these as self-serving and does not show the stars.",
    howToFix:
      "Move the ratings to the type they are about (Product, Service, Course, Recipe) and let independent review platforms carry the business-level rating.",
  },

  // ----------------------------------------------------------------- images
  "images.legacy-format": {
    title: "Images: Over 100,000 bytes served as PNG or JPEG",
    explanation:
      "Images over 100,000 bytes whose server-sent content type is PNG or JPEG, listed per file with size, size source, content type, the number of referencing pages and up to 10 of them. WebP and AVIF usually carry the same picture in far fewer bytes. Only img src references in the HTML response that the server answered successfully are checked.",
    howToFix:
      "Add WebP or AVIF renditions for photographs and let the browser choose via a picture element or CDN negotiation, keeping the original as fallback. Leave PNG where sharp-edged graphics need it.",
  },
  "images.missing-alt": {
    title: "Images: Missing alt text",
    explanation:
      "Indexable, self-canonical pages with images that have no alt attribute; each row shows how many of the page's images. Alt text is what screen readers announce and the main way search engines understand an image. Only img elements in the HTML response are counted.",
    howToFix:
      "Give every meaningful image alt text describing what it conveys, and an empty alt (alt=\"\") to purely decorative images.",
  },
  "images.missing-dimensions": {
    title: "Images: Missing size attributes",
    explanation:
      "Indexable, self-canonical pages with images that lack a width or a height attribute; each row shows how many of the page's images. Without dimensions the browser cannot reserve space, and the layout shifts as images load unless CSS reserves it. Only img elements in the HTML response are counted, and an attribute that exists but is empty counts as present.",
    howToFix:
      "Set width and height attributes to the image's intrinsic pixel dimensions, or set an aspect-ratio in CSS. Verify against the rendered page before treating it as a defect.",
  },
  "images.oversized": {
    title: "Images: Over 100,000 bytes",
    explanation:
      "Images that transfer more than 100,000 bytes, listed per file with size, how the size was established (server-declared or measured), content type, the number of referencing pages and up to 10 of them. Only img src references in the HTML response that the server answered successfully are weighed; CSS backgrounds and later srcset renditions are not, and dimensions and compression are not examined.",
    howToFix:
      "Start with the images referenced by the most pages. Re-export at the displayed size, compress, and serve a modern format. Link to files that must stay large instead of embedding them.",
  },

  // -------------------------------------------------------------- technical
  "mobile.viewport-missing": {
    title: "Mobile: Missing viewport tag",
    explanation:
      "Indexable, self-canonical pages with no viewport meta tag. Mobile browsers lay them out at desktop width and zoom out, so text is small, tap targets cramped and responsive CSS never applies.",
    howToFix:
      "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to the head in the site-wide template.",
  },
  "nav.js-only": {
    title: "Rendering: Navigation links only in rendered HTML",
    explanation:
      "Pages whose HTML response carries fewer than 5 links in nav and footer while the rendered page has at least 10 and more than twice as many. The navigation is built by JavaScript, so a crawler reading the response finds almost no way onward. Only pages the render run opened can be checked.",
    howToFix:
      "Render the primary navigation and footer server-side as anchors with real href attributes and let JavaScript enhance them. Check by loading the page with JavaScript disabled.",
  },
  "page.weight": {
    title: "Performance: Page weight by template",
    explanation:
      "For the site and for each template: total page weight, HTML bytes, and image, stylesheet and script bytes, each as count, min, max, mean, quartiles and 95th percentile over indexable, self-canonical 200 pages, with how many file references the pages make, how many of those were weighed, and how many pages have an unweighed file; rows with unweighed files are flagged as a floor. Totals are a ceiling where responsive image renditions are all counted. Only img src, stylesheet and script references in the HTML response are counted.",
    howToFix:
      "Read script bytes against total weight first; a template whose median script weight is a large share of the total is a build problem. Compare templates with the site row, and check the weighed count against the referenced count before quoting a figure.",
  },
  "performance.slow-response": {
    title: "Performance: Response time over 1500 ms",
    explanation:
      "Indexable, self-canonical pages that took more than 1500 ms to start responding, measured once from the crawler. Time to first byte delays everything the reader sees and reduces how much a search engine crawls per visit. A cold cache or a busy moment shows up the same as a slow route.",
    howToFix:
      "Re-test to rule out a cold cache, then reduce server and database time for the route; serve cached or statically generated HTML where possible.",
  },
  "resources.all-unknown": {
    title: "Resources: No file answered usably on this crawl",
    explanation:
      "Every image, stylesheet and script the crawl recorded was refused by the crawler's own policy, disallowed by robots.txt, behind a robots.txt that could not be fetched, or got no response; the row gives the counts per state. Broken-file, image and caching checks found nothing to judge and page weight counts HTML only.",
    howToFix:
      "Crawl again once the block has cleared. A wall of unreachable-robots or failed requests usually means a CDN or bot protection was blocking the crawler during the window.",
  },
  "resources.broken": {
    title: "Resources: Files returning an error (4xx, 5xx or a bot challenge)",
    explanation:
      "Pages that reference images, stylesheets or scripts which the server answered with an error, listed with up to 10 files and their status codes; a 200 with a refusal reason beside it is a bot-protection challenge answering in place of the file. Files that were not asked about, were refused or disallowed, or got no response are counted as unknown, not broken. Only img src, stylesheet and script references in the HTML response are checked.",
    howToFix:
      "Request the listed files. A 404 is usually a renamed or deleted file behind a stale template path; a 5xx is the file server failing; a refusal reason is bot protection to allowlist.",
  },
  "resources.not-fetched": {
    title: "Resources: Files listed but not requested on this crawl",
    explanation:
      "The crawl recorded every image, stylesheet and script the pages reference and requested none of them: the file check was turned off, the crawl was interrupted before it started, or the resource budget was used up first. Nothing is known about whether any file is broken, oversized, in a dated format or uncached.",
    howToFix:
      "Re-run the crawl with the file check on (the default), or resume the interrupted crawl.",
  },
  "resources.bad-content-type": {
    title: "Resources: File served with the wrong content type",
    explanation:
      "Stylesheets, scripts or images that answered 200 with a content type that contradicts what the page calls them, such as a stylesheet sent as text/html; the row shows the file, the type it was sent as and how many pages reference it. Browsers ignore a stylesheet sent with the wrong type and, where the response also carries X-Content-Type-Options: nosniff, block a script sent with one, so the page can lose its styling or behaviour even though the request succeeded. Files that returned an error are reported as broken, not here.",
    howToFix:
      "Configure the server or CDN to send text/css for stylesheets, a JavaScript type such as text/javascript for scripts and an image/* type for images. Check that the URL does not return an error or login page that happens to answer 200.",
  },
  "resources.not-recorded": {
    title: "Resources: File checks not run on this crawl",
    explanation:
      "The crawl recorded no image, stylesheet or script references although its pages carry images, so the file checks were left unrun rather than reported clean.",
    howToFix:
      "Re-crawl the site. References and file responses are recorded on every crawl from this version onwards.",
  },
  "resources.partial-unknown": {
    title: "Resources: Files partly requested, none answered usably",
    explanation:
      "Only some of the files the crawl recorded were tried, and every one tried was refused by the crawler's own policy, disallowed by robots.txt, behind a robots.txt that could not be fetched, or got no response; the row gives both counts. The file checks found nothing to judge; this is an interrupted or throttled crawl, not a verdict on the site.",
    howToFix:
      "Re-run the crawl so every file is tried afresh. Read which state most files landed in first: unreachable-robots or failed requests point at a CDN or bot protection blocking the crawler.",
  },
  "resources.uncached": {
    title: "Resources: Files without cache headers",
    explanation:
      "Files fetched with neither Cache-Control nor Expires, so browsers are not told how long to keep them; each row counts them and lists up to 20. Files never asked about, refused, disallowed, behind an unreachable robots.txt or without a response are counted as unknown. Only those two headers are read, so edge caching or ETag revalidation is not detected, and only img src, stylesheet and script references in the HTML response are checked, third-party hosts included.",
    howToFix:
      "Set a long max-age on assets whose URL changes with their content (hashed filenames can be cached for a year) and a short max-age or revalidation on the rest, in the web server, CDN or framework static-file configuration; third-party files are their host's to fix.",
  },
  "structure.click-depth-distribution": {
    title: "Links: Click depth by template",
    explanation:
      "For the site and for each template: the shortest link path from the home page to each indexable, self-canonical 200 page, as count, min, max, mean, quartiles and 95th percentile, plus how many pages no link path reaches. Internal links only; a link landing on a redirect leads no further.",
    howToFix:
      "Start with the unreachable pages and give each a home in a category, hub or related block, or remove it from the sitemap. Shorten the path to templates whose median depth is high with a hub or navigation entry.",
  },
  "structure.deep-page": {
    title: "Links: Crawl depth over 5",
    explanation:
      "Indexable, self-canonical pages whose shortest internal link path from the home page is more than 5 links. Deep pages are crawled less often, receive less internal link value and are harder to reach. Pages with no link path from the home page have no depth and are not in this report.",
    howToFix:
      "Link to the page from a category, landing page or navigation entry closer to the home page. If it is not worth linking from higher up, consolidate or remove it.",
  },
  "structure.depth-distribution": {
    title: "Crawl: Discovery depth by template",
    explanation:
      "For the site and for each template: how deep into the crawl each indexable, self-canonical 200 page was first found, as count, min, max, mean, quartiles and 95th percentile. Sitemap URLs are discovered at depth 0, so this measures the crawl, not the site's link structure; read click depth for that.",
    howToFix:
      "Compare with the click depth table. Discovery depth far shallower than click depth means the sitemap is doing the work internal linking should do.",
  },

  // -------------------------------------------------------------------- url
  "filters.js-only": {
    title: "Rendering: Filter links only in rendered HTML",
    explanation:
      "Pages whose HTML response contains no filter links (no query-string URLs, and no filter, facet or sort anywhere in a link URL) while the rendered page has at least 5. Faceted navigation built by JavaScript is invisible to a crawler reading the response, and if rendered can expand into far more URLs than the site has pages. Only pages the render run opened can be checked.",
    howToFix:
      "Give filtered views worth ranking a real link with a real URL that serves that view. Keep the rest out of the crawl deliberately with a canonical to the unfiltered listing or a robots.txt rule for the parameter.",
  },
  "render.noindex-changed": {
    title: "Rendering: Noindex differs between HTML and rendered page",
    explanation:
      "Pages rendered in a browser whose noindex state changes once JavaScript runs: noindex in the HTML and removed by the script, or added by it. Only the pages chosen for rendering are checked. A search engine that sees noindex in the HTML may never render the page, and one that renders it acts on the final state, so the page's indexing depends on which one reads it.",
    howToFix:
      "Set the robots directive in the server-side HTML to the value you want and stop scripts from changing it.",
  },
  "render.canonical-changed": {
    title: "Rendering: Canonical differs between HTML and rendered page",
    explanation:
      "Pages rendered in a browser whose canonical URL changes once JavaScript runs, including a canonical that only one of the two versions has. Only the pages chosen for rendering are checked. Search engines receive two different canonical signals and may choose either, or neither.",
    howToFix:
      "Serve the correct canonical in the server-side HTML and stop scripts from adding, removing or rewriting it.",
  },
  "render.title-changed": {
    title: "Rendering: Title changed by JavaScript",
    explanation:
      "Pages rendered in a browser whose title is different once JavaScript runs, or exists only in one of the two versions. Only the pages chosen for rendering are checked. Search engines may show either title.",
    howToFix:
      "Serve the final title in the server-side HTML so both versions match.",
  },
  "render.meta-description-changed": {
    title: "Rendering: Meta description changed by JavaScript",
    explanation:
      "Pages rendered in a browser whose meta description is different once JavaScript runs, or exists only in one of the two versions. Only the pages chosen for rendering are checked. Search engines may show either description, or write their own.",
    howToFix:
      "Serve the final meta description in the server-side HTML so both versions match.",
  },
  "render.h1-changed": {
    title: "Rendering: H1 changed by JavaScript",
    explanation:
      "Pages rendered in a browser whose first H1 is different once JavaScript runs, or exists only in one of the two versions. Only the pages chosen for rendering are checked. A heading that appears only after rendering is read late, or not at all, by crawlers that index the HTML first.",
    howToFix:
      "Serve the final H1 in the server-side HTML so both versions match.",
  },
  "pagination.canonical-to-other": {
    title: "Pagination: Paginated page canonicalised to another URL",
    explanation:
      "Pages in a series (they declare rel=prev) whose canonical names a different URL, shown in the row. Consolidating onto page 1 asks search engines to ignore what the later pages list; a self-referencing canonical keeps them indexable at the cost of near-duplicate listings.",
    howToFix:
      "If the items on deeper pages should be findable, canonicalise each page to itself. If the series only browses one collection, keep the canonical on page 1 and make sure the items have indexable pages of their own.",
  },
  "pagination.next-not-linked": {
    title: "Pagination: Next page linked only by rel=next",
    explanation:
      "Pages whose rel=next names a crawled page that no page links to with an HTML anchor. Search engines have not used rel=next for discovery since 2019, so the later pages have no crawl path and no internal link value.",
    howToFix:
      "Render real anchor links for next, previous and page numbers in the HTML, alongside any JavaScript pagination control.",
  },
  "pagination.next-target-uncrawled": {
    title: "Pagination: Next page not crawled",
    explanation:
      "Pages whose rel=next names a URL this crawl has no record of; the Unparseable column marks a value that is not a usable URL. The series may simply run past the edge of the crawl, or the rel=next is stale after the series shrank.",
    howToFix:
      "Nothing if the crawl was bounded and the series continues. If the URL is wrong or gone, correct the rel=next in the template that generates the series.",
  },
  "pagination.non-indexable-target": {
    title: "Pagination: Next or previous page not indexable",
    explanation:
      "Pages whose rel=next or rel=prev names a crawled page that does not return 200, is a bot-protection block or carries noindex; the Link Type column says which end of the series, and Target Fetch Result says why a target without a status failed. A series that points at an error page or a noindexed page is broken for search engines at that step. Targets the crawl never fetched are reported under Next page not crawled instead.",
    howToFix:
      "Point rel=next and rel=prev at working, indexable pages. If the target was removed, end the series at the last live page; if the noindex is wrong, remove it.",
  },
  "pagination.loop": {
    title: "Pagination: Next pages form a loop",
    explanation:
      "Pages that are part of a cycle of rel=next links, so that following next from the page leads back to it; the Pagination Loop column lists the URLs in order and Pages In Loop gives the full count. A series that loops has no last page. Loops longer than 500 pages are not detected.",
    howToFix:
      "Fix the template that writes rel=next so the last page of the series declares none, and no page names itself or an earlier page.",
  },
  "pagination.sequence-error": {
    title: "Pagination: Next page does not point back",
    explanation:
      "Pages whose rel=next names a crawled page that has no rel=prev, or one that names a different page; the row quotes that rel=prev as written. Each page of a series should name its neighbours both ways, and a pair that disagrees usually means one template generates the two links differently. Next pages that were not crawled or did not return 200 are left to the other pagination checks.",
    howToFix:
      "Make rel=prev on each page name the page whose rel=next names it, or drop rel=prev everywhere if the site does not use it.",
  },
  "url.normalisation-variants": {
    title: "URL: Same page served at several URLs (case or trailing slash)",
    explanation:
      "URLs that differ only in capitalisation or a trailing slash and each return a page instead of redirecting to one version; each row gives the exact count and up to 10 of the variants. Search engines treat each spelling as a separate URL and split the signals between them.",
    howToFix:
      "Pick one spelling, emit only that one in links, sitemap and canonicals, and 301 the other spellings to it.",
  },
  "url.param-volumes": {
    title: "URL: Parameters",
    explanation:
      "The site's query parameters: how many distinct parameter names were found, how many are tracking parameters (utm_source, gclid, fbclid and similar), the 20 parameters on the most URLs with their counts, and how many crawled URLs carry a query string and how many of those are indexable.",
    howToFix:
      "Read the indexable count against the total: indexable parameter URLs compete with the pages they were filtered from. Decide per parameter whether its URLs deserve indexing and record it in the canonical and robots handling.",
  },
  "url.parameter-pages-indexable": {
    title: "URL: Parameter URL indexable and self-canonical",
    explanation:
      "URLs with query parameters that return 200, carry no noindex and declare a canonical to themselves; parameter pages with no canonical are not included. On a filterable listing this is how a few pages become thousands of near-identical indexable URLs. Occasionally intended, for a search or feed page that should rank.",
    howToFix:
      "Canonicalise parameter combinations that should not be pages to the clean URL and keep them out of the sitemap and internal links. Sort, view and session parameters should never produce indexable URLs.",
  },
  "url.too-long": {
    title: "URL: Over 115 characters",
    explanation:
      "Indexable, self-canonical pages whose URL is longer than 115 characters. Long URLs are truncated in search results, are hard to share and usually carry parameters, session values or repeated folders that should not be there.",
    howToFix:
      "Shorten the URL to the words that describe the page, drop needless folders and parameters, and 301 the old URL to the new one.",
  },
  "url.uppercase": {
    title: "URL: Upper-case letters in the path",
    explanation:
      "Indexable pages whose URL path contains a capital letter; the row gives the path. Paths are case-sensitive on most servers, so /About and /about can each answer and split the page's signals between them.",
    howToFix:
      "Use lower-case paths, 301 the capitalised spelling to the lower-case one and link only to the lower-case form.",
  },
  "url.underscores": {
    title: "URL: Underscores in the path",
    explanation:
      "Indexable pages whose URL path contains an underscore; the row gives the path. Search engines read a hyphen as a word separator and an underscore as a joining character, so a path of underscores is read as one long word.",
    howToFix:
      "Separate the words of the path with hyphens, 301 the old URL to the new one and update the links that point at it.",
  },
  "url.non-ascii": {
    title: "URL: Non-ASCII characters in the path",
    explanation:
      "Indexable pages whose URL path holds characters outside basic ASCII, shown encoded as in the crawl (%C3%A9 for an accented e). Search engines handle them, but they are copied and shared in a form people cannot read, and links often break in transit.",
    howToFix:
      "Prefer plain ASCII words in the path, such as cafe for an accented spelling, and 301 the old URL to the new one. Keep the characters only where the page's language needs them.",
  },
  "url.spaces": {
    title: "URL: Spaces in the path",
    explanation:
      "Indexable pages whose URL path holds a space (shown as %20); the row gives the path. A space is unsafe in a link and is lost when the address is copied or wrapped in text.",
    howToFix:
      "Replace spaces in the path with hyphens, 301 the old URL to the new one and update the links that point at it.",
  },
  "url.multiple-slashes": {
    title: "URL: Double slash in the path",
    explanation:
      "Indexable pages whose URL path holds two slashes in a row; the row gives the path. Many servers answer /a//b and /a/b with the same page, so the page exists at two addresses and a link template is joining paths with a slash too many.",
    howToFix:
      "Fix the template that builds the link so it joins paths with a single slash, and 301 the double-slash address to the single-slash one.",
  },
  "url.repetitive-path": {
    title: "URL: Repeated folders in the path",
    explanation:
      "Indexable pages whose URL path repeats a folder or a run of folders straight after itself, as in /shop/shop/ or /a/b/a/b/; the row quotes the repeated part. It usually means a relative link or a rewrite rule is stacking a folder onto the path, which can generate an endless run of addresses.",
    howToFix:
      "Find the relative link or rewrite rule that adds the folder and correct it, then 301 the repeating address to the clean one.",
  },
  "url.internal-search": {
    title: "URL: Internal search results indexable",
    explanation:
      "Indexable pages that look like the site's own search results, because the path has a search folder or the query carries a search parameter (s, q, query, search, keyword or keywords); the row gives the path and the parameter. Search results are an unbounded set of thin pages, and one URL exists for every phrase anyone typed.",
    howToFix:
      "Add noindex to search results or block them in robots.txt, and keep them out of the sitemap and out of internal links. If one search page is meant to rank, give it a fixed address and its own content.",
  },
  "url.tracking-params-internal": {
    title: "URL: Internal links with tracking parameters",
    explanation:
      "Internal links pointing at URLs tagged with campaign or ad-click parameters (utm_source, gclid and similar). They create a second crawlable URL per page and overwrite the visit's real traffic source in analytics.",
    howToFix:
      "Strip tracking parameters from internal links and point them at the clean URL. Measure internal promotions with the analytics feature built for it.",
  },
  "links.internal-nofollow": {
    title: "Links: Internal links marked nofollow",
    explanation:
      "Pages with internal links that carry rel=nofollow. Search engines may not follow such a link or pass link value through it, so the page it points at is starved of the internal links it depends on. Each row gives the number of nofollow links on the page and up to 10 of their targets.",
    howToFix:
      "Remove rel=nofollow from internal links to pages that should rank. Keep it only on links you do not want to vouch for, such as links in user submitted content.",
  },
  "links.only-from-non-indexable": {
    title: "Links: Indexable page linked only from non-indexable pages",
    explanation:
      "Indexable, self-canonical pages whose internal links all come from pages that are not indexable themselves (noindex, canonicalised to another URL, or not a 200). Search engines may give such links little or no weight, so the page is close to an orphan. Each row gives the number of pages linking to it and up to 10 of them.",
    howToFix:
      "Link to the page from at least one indexable page, such as a category, hub or related content block.",
  },
  "links.localhost": {
    title: "Links: Links to a private or loopback address",
    explanation:
      "Pages with an external link whose host is the machine itself (a loopback name or address), a private or reserved IP address, or an internal-only name such as .local or .internal. These links work only on the author's own machine or network, so visitors and crawlers reach nothing; they are usually left over from development. Links to the site's own host are not judged, and each row lists up to 10 of the targets and why the first one is not public.",
    howToFix:
      "Replace each link with the live public URL of the page it should point at, or remove it.",
  },
  "links.non-descriptive-anchor": {
    title: "Links: Internal links with generic anchor text",
    explanation:
      "Pages with internal links whose whole anchor text is a generic English phrase such as click here, read more or learn more. The anchor is what tells visitors and search engines what the target is about, and these phrases tell them nothing. Each row gives the number of such links and up to 10 of the phrases; anchors in other languages are not judged.",
    howToFix:
      "Replace each generic anchor with words that describe the page it points at, such as the name of the product or the question the page answers.",
  },
  "links.high-outlinks": {
    title: "Links: Over 1,000 internal or 100 external links",
    explanation:
      "Pages that link to more than 1,000 different internal URLs or more than 100 different external URLs. Link value is shared between the links on a page, so every extra link dilutes the rest, and a crawler may stop reading a very long page. The row gives both counts and the limit that was crossed.",
    howToFix:
      "Cut the list down to the links a visitor needs, and move long lists into paginated or category pages that each carry a manageable number.",
  },
};

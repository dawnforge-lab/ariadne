# Severity recalibration — design (Phase 16)

Date: 2026-09-08. Owner-approved 2026-09-08 as proposed (all nine borderline calls kept as written, including `crawl.blocked` → critical).
Decision context: the owner found the Errors band read as a system-health panel (4 critical rules, all "mechanically broken") while the real audit lived in Warnings. Alternatives considered and rejected: renaming the enum to Critical/High/Medium/Low (same axis, four boxes, no calibration gain) and a Screaming-Frog-style second `priority` axis (puts a second judgement call in the engine; spec and Talos seam say severity-in-context is the agent's). Chosen: recalibrate the existing three-value enum against a written rubric. Follow-ups not designed here: 5xx re-verification at crawl end, and presenting metrics/markers separately from Notices downstream.

## The problem being fixed

Today 4 of 95 rules are `critical`, and all four say "this page is mechanically
broken" (`http.server-error`, `redirect.loop`, `content.csr-dependent`,
`nav.js-only`). Everything a practitioner would call a real audit finding sits
in `warning`. The demo page maps `critical` to Errors and `warning` to
Warnings, so the Errors band reads as a system-health panel and the Warnings
band carries the whole audit. That is the opposite of what a reader trained on
Ahrefs and Semrush expects.

Decided and out of scope: renaming the enum, adding a priority axis. The enum
stays `critical | warning | info` and the band labels stay Errors / Warnings /
Notices. What changes is which rules go in which band.

Also unchanged: `docs/talos-integration.md` section 6 stands. The engine still
emits facts and the consuming agent still decides severity in context. What the
engine's severity is, is a default reading of the finding's consequence with no
knowledge of the site's commercial shape. Recalibrating that default does not
move judgement into the engine; it makes the default one a practitioner would
recognise.

---

## 1. Rubric

A future rule author classifies a new rule by answering the questions below in
order and stopping at the first that says yes.

**`critical` (Errors) - the page cannot be indexed, served or trusted as
intended, or a visitor reaches something that is not the page.** Ask: if this
finding is left alone, does a page that should rank fail to rank at all, does a
visitor land on something broken, or does the site hand the search engine a
contradiction that the search engine resolves against the site? Five families
qualify. (a) Broken responses: 5xx, a page a crawler is refused, a redirect that
never resolves, a 200 that is really a not-found page. (b) Indexing directives
that point at nothing, contradict each other, or contradict the site's own
sitemap. (c) Content the crawler cannot see at all because it is assembled after
the response. (d) Duplication that forces the search engine to choose which URL
survives - the same text at several URLs, the same site at two hosts, the same
page at several spellings. (e) A page that is unusable on the device the search
engine indexes with. Fix these first, in this order, before anything else in the
report.

**`warning` (Warnings) - the page is reachable, indexable and unique, and a
ranking or crawl signal is missing, wasted or degraded.** Ask: does the page
still work and still get indexed, while something about it is measurably weaker
than it should be, or the crawl budget spent to reach it is larger than it needs
to be? This is also the band for findings whose severity genuinely depends on
intent the engine cannot see - a canonical to another host, a JavaScript-only
filter UI, a near-duplicate pair - because a warning is the engine saying "a
human must look at this", which is exactly true. If you find yourself writing
"this is critical when it is unintentional", the answer is `warning`.

**`info` (Notices) - nothing on the site is asserted to be broken.** Four
kinds live here and nothing else. (a) Measurements: every metric rule. (b)
Markers: the "could not be checked" family. (c) Statements of deliberate
configuration - a noindex, a canonical pointing elsewhere, a paginated page
canonicalising to page one - where the fact is neutral and only the agent knows
whether it was meant. (d) Hygiene nits with no established crawl or ranking
consequence: a title over 60 characters, a skipped heading level, a heavy PNG.
The test for (d) is whether you can name the consequence in terms of indexing,
ranking or crawl budget. If the honest answer is "it is untidy", it is a notice.

### Two classes that are fixed by construction

**Metric rules are always `info`.** `metricRule` in `src/rules/helpers.ts` takes
no severity parameter and hard-codes `"info"`; the comment there says why - a
metric states what was counted and accuses the site of nothing. All 14 metric
rules are `info` and this proposal changes none of them. This is structure, not
a judgement call, and a future rule author has no lever to pull.

**Markers are always `info`.** The 9 rules carrying `RuleMeta.marker`
(`content.thin-skipped`, `h1.duplicate-skipped`, `links.orphan-skipped`,
`robots.check-skipped`, `host.probe-skipped`, `resources.not-recorded`,
`resources.not-fetched`, `resources.all-unknown`, `resources.partial-unknown`)
report a hole in *our* evidence, never a fact about the site. Promoting one
would let a limitation of the run masquerade as a fault of the site, which is
the stub-rule failure the spec warns about. A handful of non-marker rules behave
the same way and stay `info` for the same reason: `sitemap.uncrawled` and
`pagination.next-target-uncrawled` are ambiguous by construction.

Metrics and markers together are 23 of the 44 proposed notices. Showing them in
their own place rather than mixed into a Notices list is a real readability
problem, and it is a downstream concern - the demo page, the report skills,
Talos - not an engine change. The engine has the information to support it
already: `kind === "metric"` and the presence of `marker` are both on the
registry row. Out of scope here.

### The transient 5xx caveat

`http.server-error` stays `critical`. A 5xx seen once during a crawl may be a
blip rather than a broken page, and that is a real source of false Errors on a
busy site. The fix planned for it is a re-verification pass at crawl end that
re-requests every 5xx URL and stamps the evidence `confirmed` or not, so the
agent can separate a persistent server error from a transient one. That is a
separate piece of work with its own crawl-loop and evidence-shape decisions and
is deliberately not designed here. Until it lands, a 5xx is reported as an
Error, which is the right default: under-reporting a broken page is the worse
mistake.

---

## 2. Full rule table (95 rows)

Sorted by category, then id. `changed?` is against the live 0.11.0 severity.
Analogue levels marked "(verified)" were read from the vendor's own pages during
this research: the Ahrefs help-centre issue collection
(`help.ahrefs.com/en/collections/1539899-issues`), whose article titles carry
the level word, and the Semrush issues list
(`semrush.com/kb/542-site-audit-issues-list`), which groups all 101 of its
issues under Errors / Warnings / Notices headings. Anything not marked verified
is from memory and flagged as such. Screaming Frog's High / Medium / Low issue
priority was used as a tie-breaker from memory only; its own list was not
fetched.

| # | id | kind | category | current | PROPOSED | changed? | Ahrefs / Semrush analogue and level | rationale |
|---|---|---|---|---|---|---|---|---|
| 1 | `canonical.cross-domain` | page | canonical | info | **warning** | **yes** | Ahrefs `Canonical points to external page` (Notice-class, from memory); Semrush none | Handing a page's signals to another host de-indexes it when unintentional, and the intentional case (syndication) is real, so it needs review rather than a measurement row. |
| 2 | `canonical.html-header-conflict` | page | canonical | warning | **critical** | **yes** | Semrush `Pages with multiple canonical URLs` - Error (verified) | Two contradictory canonicals are discarded, so the URL that gets indexed is chosen by the search engine and not by the site. |
| 3 | `canonical.missing` | page | canonical | warning | **warning** | no | Ahrefs `Duplicate pages without canonical` - Error (verified); plain missing canonical: none | A missing canonical only bites on a site that generates URL variants; alone it is a weakened signal, not a broken one, and the duplicate rules carry the case where it actually costs an index slot. |
| 4 | `canonical.multiple` | page | canonical | warning | **critical** | **yes** | Semrush `Pages with multiple canonical URLs` - Error (verified) | Search engines commonly ignore every canonical on the page and pick their own, so the site has lost control of which URL is indexed. |
| 5 | `canonical.non-200-target` | query | canonical | warning | **critical** | **yes** | Ahrefs `Canonical points to 4XX` / `Canonical points to 5XX` / `Canonical points to redirect` - Errors (verified); Semrush `Pages with a broken canonical link` - Error (verified) | The page asks for its signals to be consolidated into a URL that serves nothing; both reference tools call this an error and the owner named it. |
| 6 | `canonical.non-indexable-target` | query | canonical | warning | **critical** | **yes** | Semrush `Pages with a broken canonical link` - Error (verified); Ahrefs `Hreflang to non-canonical` family - Error (verified) | Consolidating into a noindexed URL takes the whole cluster out of the index, which is the same consequence class as a canonical pointing at a 404. |
| 7 | `canonical.points-elsewhere` | page | canonical | info | **info** | no | Ahrefs `Canonical from HTTP to HTTPS` - Notice (verified) | A statement of deliberate configuration: correct for parameter and syndicated variants, and only the agent knows which page was meant to rank. |
| 8 | `directive.canonical-noindex-conflict` | page | canonical | warning | **critical** | **yes** | Semrush `Pages blocked by X-Robots-Tag: noindex` - Notice (verified) for plain noindex; the conflict case: none | Two contradictory indexing directives on one page: Google resolves toward the restrictive one, so the page leaves the index and its consolidation never happens. |
| 9 | `content.csr-dependent` | query | content | critical | **critical** | no | Ahrefs `JavaScript broken` - Error (verified) | Unchanged. The substance of the page does not exist in the response a crawler reads, which is the definition of not being indexable as intended. |
| 10 | `content.exact-duplicate` | query | content | warning | **critical** | **yes** | Semrush `Pages with duplicate content issues` - Error (verified); Ahrefs `Duplicate pages without canonical` - Error (verified) | Identical text at several URLs means the search engine keeps one and drops the rest, so pages that should rank do not; both reference tools call it an error and the owner named it. |
| 11 | `content.metrics-by-type` | metric | content | info | **info** | no | none (measurement) | Metric rule: `metricRule` takes no severity and counts rather than accuses, so `info` is structural, not a judgement. |
| 12 | `content.near-duplicate` | query | content | warning | **warning** | no | Semrush `Pages with duplicate content issues` - Error (verified) | A three-bit fingerprint distance legitimately covers product variants and location pages, so unlike the exact case this needs the agent's read of the site before it is called broken. |
| 13 | `content.placeholder` | page | content | warning | **critical** | **yes** | none | Lorem ipsum in production is a page that was never finished being shipped to readers and to the index; nothing else in the catalog is a clearer 'this must not be live'. |
| 14 | `content.soft-404` | query | content | warning | **critical** | **yes** | Ahrefs `404 page` - Error (verified); Semrush `Pages returning 4XX status code` - Error (verified) | A not-found page lying about its status is a broken page a user reaches and a wasted index slot, and it is worse than an honest 404 because nothing self-corrects; the owner named it. |
| 15 | `content.template-similarity` | metric | content | info | **info** | no | none (measurement) | Metric rule: a distribution of pairwise fingerprint distances, structurally `info`. |
| 16 | `content.thin` | page | content | warning | **warning** | no | Semrush `Pages with a low word count` - Warning (verified) | The page is indexable and unique; it competes worse than it could. Exactly the reference level. |
| 17 | `content.thin-skipped` | page | content | info | **info** | no | none (marker) | Marker: a statement about this crawl's evidence, not about the site. Markers never leave `info`. |
| 18 | `crawl.blocked` | page | crawl | warning | **critical** | **yes** | Ahrefs `403 Forbidden` - Error (verified); Semrush `Pages couldn't be crawled` - Error (verified); Semrush `Pages that were blocked from crawling` - Notice (verified, robots case only) | A 401/403/429/challenge means no crawler read the page, so it cannot be indexed on its merits; the robots-disallow case that Semrush files as a Notice is a different rule here. |
| 19 | `http.server-error` | page | crawl | critical | **critical** | no | Ahrefs `500 page` - Error (verified); Semrush `Pages returning 5XX status code` - Error (verified) | Unchanged. Nobody, crawlers included, can read the page. See the transient-5xx note in the rubric. |
| 20 | `render.coverage` | metric | crawl | info | **info** | no | none (measurement) | Metric rule: says how much of the crawl was rendered, structurally `info`. |
| 21 | `robots.blocks-sitemap-urls` | query | crawl | warning | **critical** | **yes** | Semrush `Format errors in Robots.txt file` - Error (verified); Semrush `Issues with blocked internal resources in robots.txt` - Warning (verified) | The site's own sitemap is its statement that these URLs should be indexed and its own robots.txt forbids fetching them; those pages cannot rank at all until one of the two files changes. |
| 22 | `robots.check-skipped` | query | crawl | info | **info** | no | none (marker) | Marker: robots.txt could not be read by this crawl. Never leaves `info`. |
| 23 | `robots.missing` | query | crawl | info | **info** | no | Semrush `Robots.txt not found` - Notice (verified) | Valid and often correct for a small site; the reference tool agrees this is a nudge. |
| 24 | `site.health` | metric | crawl | info | **info** | no | none (measurement) | Metric rule: the crawl's own coverage census, structurally `info`. |
| 25 | `host.duplicate-host-200` | query | host | warning | **critical** | **yes** | Semrush `Pages with a WWW resolve issue` - Error (verified) | Every URL on the site exists twice with no redirect between them, splitting links and rankings across the whole property; the reference tool calls it an error and the owner named it. |
| 26 | `host.http-serves-200` | query | host | warning | **critical** | **yes** | Semrush `Non-secure pages` and `No redirect or canonical to HTTPS homepage from HTTP version` - both Errors (verified) | Browsers mark it not secure, the plaintext copy can be indexed as a second site, and both reference errors point at exactly this condition. |
| 27 | `host.legacy-host-reachable` | query | host | info | **warning** | **yes** | Semrush `Pages with a WWW resolve issue` - Error (verified, adjacent) | Same duplicate-whole-site consequence as the www case, but the host is not the audited property and 'former domain' is an inference, so it wants review rather than a first-fix slot. |
| 28 | `host.probe-skipped` | query | host | info | **info** | no | none (marker) | Marker: host probing was off for this crawl. Never leaves `info`. |
| 29 | `hreflang.coverage` | metric | hreflang | info | **info** | no | none (measurement) | Metric rule: share of pages declaring hreflang, structurally `info`. |
| 30 | `hreflang.invalid-code` | query | hreflang | warning | **critical** | **yes** | Ahrefs `Hreflang annotation invalid` - Error (verified); Semrush `Issues with hreflang values` - Error (verified) | An unparseable annotation is discarded outright, so the wrong language version is served; both reference tools call it an error and the owner named it. |
| 31 | `hreflang.missing-return-link` | query | hreflang | warning | **critical** | **yes** | Ahrefs `Missing reciprocal hreflang (no return-tag)` - Error (verified); Semrush `Issues with incorrect hreflang links` - Error (verified) | Hreflang is only honoured when reciprocal, so a one-way annotation is thrown away entirely and the cluster does not work. |
| 32 | `hreflang.missing-x-default` | query | hreflang | info | **info** | no | none | x-default is optional in Google's own documentation; unmatched visitors are matched by guesswork, which costs nothing in the index. |
| 33 | `hreflang.non-indexable-target` | query | hreflang | warning | **critical** | **yes** | Ahrefs `Hreflang to broken page` and `Hreflang to non-canonical` - both Errors (verified) | An alternate that redirects or is noindexed cannot be the page a search engine swaps in, so the cluster is broken for that language. |
| 34 | `indexability.meta-header-conflict` | page | indexability | warning | **critical** | **yes** | Semrush `Pages blocked by X-Robots-Tag: noindex` - Notice (verified) for the plain case; the conflict case: none | Conflicting robots directives resolve to the most restrictive, so the page is almost certainly noindexed by accident: it cannot be indexed as intended. |
| 35 | `indexability.noindex` | page | indexability | info | **info** | no | Semrush `Pages blocked by X-Robots-Tag: noindex` - Notice (verified) | Deliberate on admin, thank-you and filtered pages; a statement of fact the agent contextualises, exactly as the reference tool treats it. |
| 36 | `inlinks.distribution` | metric | links | info | **info** | no | none (measurement) | Metric rule: internal links per page as a distribution, structurally `info`. |
| 37 | `inlinks.extremes` | metric | links | info | **info** | no | none (measurement) | Metric rule: the two ends of that distribution as URLs, structurally `info`. |
| 38 | `inlinks.sources-by-type` | metric | links | info | **info** | no | none (measurement) | Metric rule: a template-to-template link matrix, structurally `info`. |
| 39 | `links.broken-internal` | query | links | warning | **critical** | **yes** | Semrush `Broken internal links` - Error (verified); Ahrefs `Page has links to broken page` and `404 page` - Errors (verified) | Visitors hit an error page and the crawl spends requests on nothing; both reference tools call it an error and the owner named it. |
| 40 | `links.orphan` | query | links | warning | **warning** | no | Ahrefs `Orphan page` - Error (verified); Semrush `Orphaned pages` - Notice (verified) | The references disagree and the finding is sensitive to crawl shape (this rule already ships a skipped marker for the untrustworthy case), so the middle band is the honest one. |
| 41 | `links.orphan-skipped` | query | links | info | **info** | no | none (marker) | Marker: the crawl did not finish in a shape where orphanhood is decidable. Never leaves `info`. |
| 42 | `h1.duplicate-skipped` | query | on-page | info | **info** | no | none (marker) | Marker: no heading text was stored by this crawl. Never leaves `info`. |
| 43 | `h1.duplicate-text` | query | on-page | warning | **warning** | no | Semrush `Pages with duplicate H1 and title tags` - Warning (verified) | A shared H1 across genuinely distinct pages costs relevance, not indexation; where it signals real duplication, `content.exact-duplicate` already fires at critical. |
| 44 | `headings.h1-missing` | page | on-page | warning | **warning** | no | Ahrefs `H1 tag missing or empty` - Warning (verified); Semrush `Pages without an h1 heading` - Warning (verified) | Both references agree exactly: the page still indexes, its subject is inferred from weaker signals. |
| 45 | `headings.h1-multiple` | page | on-page | info | **info** | no | Semrush `Pages with more than one H1 tag` - Notice (verified) | Valid HTML, frequently deliberate, and the reference tool files it as a notice. |
| 46 | `headings.level-skip` | page | on-page | info | **info** | no | none | Accessibility and outline hygiene with no established crawl or ranking consequence. |
| 47 | `meta-description.duplicate` | query | on-page | warning | **warning** | no | Semrush `Pages with duplicate meta descriptions` - Error (verified) | Held at warning against the reference: a shared description costs snippet quality, and Google rewrites most snippets anyway, so it never costs an index slot. |
| 48 | `meta-description.missing` | page | on-page | warning | **warning** | no | Ahrefs `Meta description tag missing or empty` - Error (verified); Semrush `Pages without meta descriptions` - Warning (verified) | The references split; the description is not a ranking factor and Google assembles a snippet regardless, so the page ranks and only click-through suffers. |
| 49 | `meta-description.too-long` | page | on-page | info | **info** | no | Semrush `Pages with too much text within the title tags` family - Warning (verified) | A truncated snippet tail is a cosmetic loss; keeping length nits out of Warnings is what keeps that band meaningful. |
| 50 | `meta-description.too-short` | page | on-page | info | **info** | no | Semrush `Pages without enough text within the title tags` family - Warning (verified) | Same reasoning as too-long: wasted snippet space, no crawl or index consequence. |
| 51 | `title.duplicate` | query | on-page | warning | **warning** | no | Semrush `Issues with duplicate title tags` - Error (verified) | Held at warning against the reference: where duplicate titles mean duplicate pages, `content.exact-duplicate` and `url.normalisation-variants` already fire at critical, and on genuinely distinct pages a shared title costs relevance only. |
| 52 | `title.missing` | page | on-page | warning | **critical** | **yes** | Semrush `Pages don't have title tags` - Error (verified); Ahrefs classifies missing titles as an error (reported, article title says 'issue') | The strongest on-page relevance signal and the search-result headline are both absent, so the search engine writes its own; the owner named it and the reference tool agrees. |
| 53 | `title.too-long` | page | on-page | info | **info** | no | Semrush `Pages with too much text within the title tags` - Warning (verified) | Truncation in the SERP, no loss of relevance; held in Notices deliberately so Warnings stay about degraded signals. |
| 54 | `title.too-short` | page | on-page | info | **info** | no | Semrush `Pages without enough text within the title tags` - Warning (verified) | A short title is a missed opportunity rather than a defect; same reasoning as too-long. |
| 55 | `redirect.chain` | query | redirects | warning | **warning** | no | Ahrefs `Redirect chain` - Error (verified); Semrush `Redirect chains and loops` - Error (verified) | Held at warning against both references: the destination is still reached, so this is wasted crawl budget and latency, not a broken page. The loop, which is genuinely broken, is a separate rule already at critical. |
| 56 | `redirect.js` | query | redirects | warning | **critical** | **yes** | Semrush `Pages with a meta refresh tag` - Error (verified) | Nothing in the HTTP response says a redirect happened, so a crawler indexes the body of a URL that is not the page the visitor lands on: the URL is not served as intended. |
| 57 | `redirect.loop` | query | redirects | critical | **critical** | no | Ahrefs `Redirect loop` - Error (verified); Semrush `Redirect chains and loops` - Error (verified) | Unchanged. Nobody reaches the content and search engines drop the URLs involved. |
| 58 | `redirect.volume` | metric | redirects | info | **info** | no | none (measurement) | Metric rule: share of the crawl that answered with a redirect, structurally `info`. |
| 59 | `pages.not-in-sitemap` | query | sitemap | info | **info** | no | Semrush `Orphaned pages (in sitemap)` - Notice (verified, adjacent) | Discovery is slower, nothing is broken, and a page absent from the sitemap is often deliberate. |
| 60 | `sitemap.invalid` | query | sitemap | warning | **critical** | **yes** | Semrush `Format errors in sitemap.xml files` - Error (verified) | A sitemap document that cannot be parsed delivers none of the URLs it holds, so the site's whole discovery statement is silently void. |
| 61 | `sitemap.missing` | query | sitemap | warning | **warning** | no | Semrush `Sitemap.xml not indicated in robots.txt` and `Sitemap.xml not found` - both Warnings (verified) | The site is still fully crawlable through links; both reference conditions sit at exactly this level. |
| 62 | `sitemap.non-200` | query | sitemap | warning | **critical** | **yes** | Ahrefs `4xx page in sitemap` and `5xx page in sitemap` - Errors (verified); Semrush `Incorrect pages found in sitemap.xml` - Error (verified) | This rule fires only on 4xx/5xx (redirects are split off into `sitemap.redirected`), so every finding is the site inviting crawlers to a URL that serves nothing. |
| 63 | `sitemap.non-indexable` | query | sitemap | warning | **critical** | **yes** | Ahrefs `Noindex page in sitemap` - Error (verified) | A direct self-contradiction: the sitemap asks for indexing and the page refuses it, and Google treats repeated contradictions as a reason to trust the sitemap less. |
| 64 | `sitemap.redirected` | query | sitemap | warning | **warning** | no | Ahrefs `3xx redirect in sitemap` - Error (verified) | Held at warning against the reference: the URL still resolves to a real page in one extra hop, so this is the wrong URL published rather than a broken one, which is what the rule's own copy says. |
| 65 | `sitemap.structure` | metric | sitemap | info | **info** | no | none (measurement) | Metric rule: how sitemap entries spread across documents, structurally `info`. |
| 66 | `sitemap.uncrawled` | query | sitemap | info | **info** | no | none | Ambiguous by construction (crawl limit, off-site URL, or a stale entry), so it is evidence for the agent rather than an accusation. |
| 67 | `schema.breadcrumb-absent` | query | structured-data | info | **info** | no | none | An absent enhancement, not a defect: the pages index and rank without it. |
| 68 | `schema.none-on-site` | query | structured-data | info | **info** | no | Semrush `Invalid structured data items` - Error (verified, different condition) | Having no structured data at all costs rich results and AI-answer eligibility; neither reference tool flags absence, only invalidity. |
| 69 | `schema.product-incomplete` | query | structured-data | warning | **warning** | no | Semrush `Invalid structured data items` - Error (verified) | Held at warning: the listing still appears as a plain blue link, so what is lost is an enhancement, not the page. |
| 70 | `schema.self-serving-reviews` | query | structured-data | info | **info** | no | none | Google ignores the markup; the page is unaffected and the fix is to stop expecting stars. |
| 71 | `images.legacy-format` | query | technical | info | **info** | no | none | A conversion candidate, explicitly not a fault: PNG and JPEG are valid and sometimes correct. |
| 72 | `images.missing-alt` | page | technical | info | **warning** | **yes** | Semrush `Images without alt attributes` - Warning (verified) | An accessibility failure plus a lost image-search signal on a page that otherwise works: exactly the reference level, and above a measurement. |
| 73 | `images.missing-dimensions` | page | technical | info | **info** | no | none | Layout-shift hygiene that CSS commonly already solves, which the rule's own copy acknowledges. |
| 74 | `images.oversized` | query | technical | warning | **warning** | no | Semrush `Pages with slow load speed` - Error (verified, adjacent) | A concrete weight cost on a page that still loads and indexes. |
| 75 | `mobile.viewport-missing` | page | technical | warning | **critical** | **yes** | Semrush `Pages with no viewport tag` and `Missing the viewport width value` - both Errors (verified) | Under mobile-first indexing the page is unusable on the device Google evaluates it with, and the reference tool has two separate errors for this one condition. |
| 76 | `nav.js-only` | query | technical | critical | **critical** | no | Ahrefs `JavaScript broken` - Error (verified, adjacent) | Unchanged. The site's discovery graph does not exist in the HTML, so pages behind the nav are not found. |
| 77 | `page.weight` | metric | technical | info | **info** | no | none (measurement) | Metric rule: bytes per page by template, structurally `info`. |
| 78 | `performance.slow-response` | page | technical | info | **warning** | **yes** | Semrush `Pages with slow load speed` - Error (verified) | Over 1500ms to first byte delays everything downstream and cuts crawl throughput; a degraded signal on a working page, so warning rather than the reference's error. |
| 79 | `resources.all-unknown` | query | technical | info | **info** | no | none (marker) | Marker: every resource this crawl asked about landed in an unknown class. Never leaves `info`. |
| 80 | `resources.broken` | query | technical | warning | **warning** | no | Semrush `Issues with broken internal JavaScript and CSS files` - Error (verified); Ahrefs `CSS broken` - Warning, `JavaScript broken` - Error (verified) | One rule covers images, CSS and JS together, so its worst case and its mildest share a row; the middle band is honest and the evidence names which files. |
| 81 | `resources.not-fetched` | query | technical | info | **info** | no | none (marker) | Marker: resources were catalogued and never requested. Never leaves `info`. |
| 82 | `resources.not-recorded` | query | technical | info | **info** | no | none (marker) | Marker: this crawl recorded no resources at all. Never leaves `info`. |
| 83 | `resources.partial-unknown` | query | technical | info | **info** | no | none (marker) | Marker: a partial resource pass whose decided rows were all unknown. Never leaves `info`. |
| 84 | `resources.uncached` | query | technical | info | **info** | no | Semrush `Issues with uncached JavaScript and CSS files` - Warning (verified) | Held at info: caching headers cost repeat-visit speed only, and `performance.slow-response` and `page.weight` already carry the user-facing performance story. |
| 85 | `structure.click-depth-distribution` | metric | technical | info | **info** | no | none (measurement) | Metric rule: click depth from the home page as a distribution, structurally `info`. |
| 86 | `structure.deep-page` | query | technical | info | **info** | no | Semrush `Pages that need more than 3 clicks to be reached` - Notice (verified) | The reference tool agrees: depth is a priority signal, not a defect. |
| 87 | `structure.depth-distribution` | metric | technical | info | **info** | no | none (measurement) | Metric rule: discovery depth as a distribution, structurally `info`. |
| 88 | `filters.js-only` | query | url | warning | **warning** | no | Ahrefs `JavaScript broken` - Error (verified, adjacent) | Unlike `nav.js-only`, JS-only facets are frequently deliberate and often desirable because they keep filter combinations out of the index; the finding is evidence to weigh, not a first fix. |
| 89 | `pagination.canonical-to-other` | query | url | info | **info** | no | Ahrefs `Canonical from HTTP to HTTPS` - Notice (verified, adjacent) | A deliberate architectural choice with a genuine cost either way, so only the agent can call it wrong. |
| 90 | `pagination.next-not-linked` | query | url | warning | **warning** | no | Ahrefs `Orphan page` - Error (verified, adjacent); Semrush `Orphaned pages` - Notice (verified) | Effectively orphaned later pages, so it is pegged to `links.orphan` and stays in the same band. |
| 91 | `pagination.next-target-uncrawled` | query | url | info | **info** | no | none | Most often the series simply runs past the edge of the crawl, which is a fact about the run. |
| 92 | `url.normalisation-variants` | query | url | warning | **critical** | **yes** | Semrush `Pages with duplicate content issues` - Error (verified); Semrush `Pages with a WWW resolve issue` - Error (verified, adjacent) | Case and trailing-slash spellings each serving 200 is the same defect as the www duplicate at URL scale: every affected page competes with itself and none of the copies gets the whole signal. |
| 93 | `url.param-volumes` | metric | url | info | **info** | no | none (measurement) | Metric rule: the site's parameter inventory, structurally `info`. |
| 94 | `url.parameter-pages-indexable` | query | url | info | **warning** | **yes** | Semrush `Pages with too many parameters in their URLs` - Warning (verified) | A self-canonicalling parameter URL is the classic index-bloat generator, which is a degraded crawl budget rather than a measurement; the reference tool sits at this level. |
| 95 | `url.tracking-params-internal` | query | url | warning | **warning** | no | Semrush `Pages with too many parameters in their URLs` - Warning (verified) | Internal campaign tags create a crawlable second URL for a page that already exists; wasted crawl, page still fine. |

---

## 3. Change summary

**Promotions, `warning` to `critical` - 24 rules**

| category | rules |
|---|---|
| canonical | `canonical.html-header-conflict`, `canonical.multiple`, `canonical.non-200-target`, `canonical.non-indexable-target`, `directive.canonical-noindex-conflict` |
| content | `content.exact-duplicate`, `content.placeholder`, `content.soft-404` |
| crawl | `crawl.blocked`, `robots.blocks-sitemap-urls` |
| host | `host.duplicate-host-200`, `host.http-serves-200` |
| hreflang | `hreflang.invalid-code`, `hreflang.missing-return-link`, `hreflang.non-indexable-target` |
| indexability | `indexability.meta-header-conflict` |
| links | `links.broken-internal` |
| on-page | `title.missing` |
| redirects | `redirect.js` |
| sitemap | `sitemap.invalid`, `sitemap.non-200`, `sitemap.non-indexable` |
| technical | `mobile.viewport-missing` |
| url | `url.normalisation-variants` |

**Promotions, `info` to `warning` - 5 rules**

`canonical.cross-domain`, `host.legacy-host-reachable`, `images.missing-alt`,
`performance.slow-response`, `url.parameter-pages-indexable`.

**Demotions - 0 rules.** Nothing currently at `critical` moves down, and nothing
at `warning` moves to `info`. The four existing criticals are all correct under
the rubric; they were never the problem, there were just too few of them. The
existing `warning` band contained no rule that fails the warning test - its
problem was that it also contained everything that should have been above it.

**Totals**

| | critical | warning | info | total |
|---|---|---|---|---|
| current (0.11.0) | 4 | 42 | 49 | 95 |
| proposed (0.12.0) | **28** | **23** | **44** | 95 |
| delta | +24 | -19 | -5 | 0 |

29 of 95 rules change; 66 stay as they are.

### Sanity check on the shape

The brief's target was roughly 15-25 critical and 25-35 warning. This lands at
28 / 23 / 44 - critical slightly over, warning slightly under. Both are
explained by one structural fact and one deliberate choice.

The structural fact: 23 of our 95 rules are metrics and markers, which no
commercial tool ships as issues at all. Excluding them leaves 72 judgement-
bearing rules, of which 28 are Errors - 39%. Semrush's own published list is 41
Errors out of 101 issues, 41%. Ahrefs's help-centre issue collection is
similarly Error-heavy. So the proposed Errors share is marginally *below* the
closest reference tool's, measured on comparable populations. 28 is not
over-promotion; it is what an SEO audit tool's Errors band actually looks like.

The deliberate choice: length and cosmetic nits (`title.too-long`,
`title.too-short`, `meta-description.too-long`, `meta-description.too-short`,
`headings.h1-multiple`, `headings.level-skip`, `resources.uncached`) are held in
Notices where Semrush puts several of them in Warnings. That is what keeps the
Warnings band at 23 rather than 30. It is intentional: the owner's complaint is
that Warnings carried everything, and the cure is not to refill it from below.
If the owner wants the Warnings band nearer 30, promoting those seven is the
single lever, and each is independently flippable.

Also worth stating plainly: **rule counts are not finding counts.** Twenty-eight
critical rules do not mean twenty-eight red rows in the demo. On a healthy site
most fire zero times; on a broken one a handful fire thousands of times. The
band shape a client sees is driven by which rules fire, not by how many exist.

---

## 4. Borderline calls

Nine rules where reasonable practitioners disagree. My call is the proposal's;
the alternative is the flip.

**1. `content.placeholder` - proposed `critical`, alternative `warning`.**
Neither reference tool has this issue at all, so there is nothing to calibrate
against. My call: lorem ipsum shipped to production is the single clearest
"this page should not be live" signal an audit can produce, and it damages trust
in everything around it. Against: the page indexes fine and ranks fine; strictly
it is a content defect, not an indexing one. Flip to `warning` if the owner
reads the Errors band as strictly mechanical.

**2. `crawl.blocked` - proposed `critical`, alternative `warning`.** Ahrefs's
`403 Forbidden` is an Error (verified) and Semrush's `Pages couldn't be crawled`
is an Error (verified), which supports critical. Against: this rule also fires
on 429, and a 429 can be *our* politeness failure rather than the site's fault -
CLAUDE.md rule 9 is explicit that being throttled is our bug. Reporting our own
rate-limiting as a site Error would be wrong. My call: promote anyway, because a
page no crawler can fetch cannot be indexed, and the evidence carries the status
so the agent can tell 403 from 429. Cleaner alternative if the owner dislikes
this: split the rule so 401/403/challenge are critical and 429 is a warning -
but that is a rule change, not a severity change, and belongs in its own ticket.

**3. `redirect.chain` - proposed `warning` (unchanged), alternative
`critical`.** Both references disagree with me: Ahrefs `Redirect chain` is an
Error (verified) and Semrush `Redirect chains and loops` is an Error (verified).
My call: they lump chains and loops into one issue and we do not - our loop is
already critical. A two-hop chain reaches its destination; it costs latency and
crawl budget, which is the warning definition word for word. Flip to `critical`
if the owner wants reference parity over rubric purity.

**4. `title.duplicate` - proposed `warning` (unchanged), alternative
`critical`.** Semrush `Issues with duplicate title tags` is an Error (verified).
My call: where duplicate titles indicate duplicate pages, `content.exact-
duplicate` and `url.normalisation-variants` already fire at critical on the same
URLs, so promoting this would double-count the same defect in the Errors band.
On genuinely distinct pages a shared title costs relevance, not an index slot.
Flip if the owner wants Errors to match Semrush issue-for-issue.

**5. `meta-description.duplicate` and `meta-description.missing` - proposed
`warning` (unchanged), alternative `critical`.** Semrush calls duplicates an
Error (verified); Ahrefs calls missing an Error (verified, from the article
slug). My call: the meta description is not a ranking factor and Google rewrites
the majority of snippets regardless, so neither condition costs an index slot or
a ranking position - only click-through. That is the warning definition. Flip
both together or neither.

**6. `links.orphan` - proposed `warning` (unchanged), alternative `critical`.**
The references split cleanly: Ahrefs `Orphan page` is an Error (verified),
Semrush `Orphaned pages` is a Notice (verified). My call: split the difference
at warning, and note that our finding is sensitive to crawl shape - this rule
already ships `links.orphan-skipped` for the case where orphanhood is not
decidable, which is an admission that the finding is conditional. Flip to
critical if the owner sides with Ahrefs. Note `pagination.next-not-linked` is
deliberately pegged to whatever this one is and should move with it.

**7. `sitemap.redirected` - proposed `warning` (unchanged), alternative
`critical`.** Ahrefs `3xx redirect in sitemap` is an Error (verified). My call:
the rule's own client-facing copy says "It is not an error, but it is the wrong
URL to publish" - promoting it would put the engine at odds with its own
sentence. The URL resolves to a real page in one extra hop. Flip only if the
copy is edited at the same time.

**8. `host.legacy-host-reachable` - proposed `warning` (was `info`),
alternative `critical`.** The consequence is identical to
`host.duplicate-host-200`, which I am promoting to critical: a whole second copy
of the site, indexable, competing, absorbing backlinks that never reach the
live property. My call is one band lower because the host in question is not the
audited property, and "this is a *former* domain of theirs" is an inference the
engine makes rather than a fact it observes. Flip to critical if the owner
trusts the legacy-host detection.

**9. `robots.blocks-sitemap-urls` - proposed `critical`, alternative
`warning`.** My call: the sitemap is the site's own written statement that these
URLs should be indexed, and its own robots.txt forbids fetching them, so those
pages cannot rank at all until one of the two files changes; a site
contradicting itself in machine-readable form is the clearest Error there is.
Against: the sitemap may simply be stale, and the block deliberate - in which
case the fix is to regenerate the sitemap, which is small. Flip to `warning` if
the owner has seen this fire mostly on stale sitemaps.

---

## 5. Implementation notes for the engineers

### Where the severity literals live

Two shapes, and both are grep-able. **Nothing computes a severity at runtime** -
every rule's severity is a literal at definition time and the value flows into
findings through `RuleIdentity`. I checked: there is no conditional severity
anywhere in `src/rules`, and `metricRule` cannot take one at all.

*Page rules* - the severity is the 4th positional argument to `pageRule(id,
checkIds, category, severity, run)`:

| file | rules changing |
|---|---|
| `src/rules/page/canonical.ts` | `canonical.multiple` (line ~95), `canonical.html-header-conflict` (~101), `canonical.cross-domain` (~117), `directive.canonical-noindex-conflict` (~132) |
| `src/rules/page/indexability.ts` | `indexability.meta-header-conflict` (~55) |
| `src/rules/page/on-page.ts` | `title.missing` (~45), `content.placeholder` (~179) |
| `src/rules/page/status.ts` | `crawl.blocked` (~22) |
| `src/rules/page/technical.ts` | `mobile.viewport-missing` (~35), `images.missing-alt` (~56), `performance.slow-response` (~65) |

*Query rules* - the severity is on a module-level `RuleIdentity` const near the
top of the file, and the `defineRule` body reads it back as `X.severity`. Edit
the const only; the `defineRule` reference needs no change.

| file | consts changing |
|---|---|
| `src/rules/query/content.ts` | `SOFT_404` (line 62), `EXACT` (63) |
| `src/rules/query/host.ts` | `HTTP_200` (36), `DUPLICATE` (37), `LEGACY` (38) |
| `src/rules/query/hreflang.ts` | `INVALID_CODE` (39), `RETURN_LINK` (41), `NON_INDEXABLE` (42) |
| `src/rules/query/link-targets.ts` | `BROKEN` (245), `NON_200` (246), `NON_INDEXABLE` (247) |
| `src/rules/query/redirects.ts` | none - but note `CHAIN` and `LOOP` (391-392) are `export`ed and imported elsewhere; neither changes |
| `src/rules/query/render-redirect.ts` | `JS_REDIRECT` (42) |
| `src/rules/query/robots.ts` | `BLOCKS` (44) |
| `src/rules/query/sitemap.ts` | `INVALID` (78), `NON_200` (79), `NON_INDEXABLE` (81) |
| `src/rules/query/url-hygiene.ts` | `VARIANTS` (40), `PARAM_PAGES` (42) |

Line numbers are from the phase-15 worktree at the time of writing; grep
`severity` in each file rather than trusting them.

### Copy in `issue-copy.ts`

I grepped `src/rules/registry/copy/issue-copy.ts` for severity words. **No copy
entry for any changed rule names its own severity in prose**, so no `title`,
`explanation` or `howToFix` needs editing for the promotions. Two hits exist and
both are `site.health`'s own copy (lines ~890-894), which describes the health
table's severity buckets in general terms ("a page with a critical finding and
three warnings is counted once, as critical"). That prose stays true after the
recalibration and needs no change.

One caveat the owner should decide on: `sitemap.redirected`'s explanation
contains the sentence "It is not an error, but it is the wrong URL to publish".
If borderline call 7 is flipped to `critical`, that sentence must be edited in
the same commit or the engine contradicts itself in client-facing text.
`test/rules/copy.test.ts` will not catch that; a human must.

### `RULESET_VERSION`

`src/rules/registry/registry.ts` line 94: `0.11.0` to `0.12.0`. The comment
block above it records what each bump changed and why a re-judged crawl can
differ; add an entry in that style. The important property to state there is
that this bump changes **no finding's existence and no evidence** - the same
crawl re-judged at 0.12.0 produces the identical set of findings with 29 rules'
`severity` column moved. That is the cleanest ruleset bump the file has had, and
saying so helps whoever reads `test/api/query.test.ts`'s cross-ruleset severity
machinery later.

### Tests that assert severities

Two patterns. The first is a **per-family registry snapshot** - an
`Object.fromEntries(xRules.map(r => [r.id, r.severity]))` or `[r.id,
[r.checkIds, r.severity, r.category]]` compared against a literal object. These
must be updated for every changed rule in their family:

`test/rules/canonical.test.ts:48`, `test/rules/technical.test.ts:50`,
`test/rules/hreflang-query.test.ts:47`, `test/rules/robots-query.test.ts:56`,
`test/rules/render-diff.test.ts:68`, `test/rules/url-hygiene-query.test.ts:50`,
`test/rules/content-query.test.ts:119`,
`test/rules/link-targets-query.test.ts:50`,
`test/rules/structured-data-query.test.ts:83`,
`test/rules/health-metrics.test.ts:46`.

The second is **per-finding assertions**, `expect(f[0]!.severity).toBe(...)` or a
`severity:` key inside an expected-finding object literal. These need touching
only where the rule changed:

`test/rules/canonical.test.ts` (lines ~83, 138, 251, 277, 350, 401),
`test/rules/on-page.test.ts` (~124, 174, 223, 271, 383),
`test/rules/status.test.ts` (~69), `test/rules/technical.test.ts` (~81, 99, 125,
145), `test/rules/indexability.test.ts` (~141),
`test/rules/content-query.test.ts` (~257, 491, 600),
`test/rules/host-query.test.ts` (~173, 228, 294),
`test/rules/hreflang-query.test.ts` (~191, 495, 587),
`test/rules/link-targets-query.test.ts` (~168, 277),
`test/rules/robots-query.test.ts` (~192), `test/rules/sitemap-query.test.ts`
(~171, 241), `test/rules/render-redirect.test.ts` (~41, 196),
`test/rules/url-hygiene-query.test.ts` (~179, 255, 397).

Three files need checking but probably no change:

- `test/rules/run.test.ts:265` reads `title.missing`'s severity **from the
  registry** rather than hard-coding it, so it follows the change for free. Good
  pattern; prefer it when touching the others.
- `test/api/query.test.ts` mostly inserts `issues` rows with explicit severities
  as fixtures, which are independent of the registry and stay valid. The one
  live coupling is line ~1852, `expect(orphan?.["severity"]).toBe("warning")`
  for `links.orphan` - unchanged in this proposal, so it passes. If borderline
  call 6 is flipped, that line moves too. Lines 1672 and 1686 only assert
  membership of the enum and an ordering rank; both are agnostic.
- `test/rules/helpers.test.ts:52` builds a synthetic identity `{ id:
  "links.broken-internal", severity: "critical" }` as a fixture. It does not
  consult the registry, so it is unaffected - and after this change it happens
  to agree with reality, which is a nice accident and not something to rely on.

`test/demo/flow.test.ts:227` asserts only that each band's severity is one of
the three enum values, and line 226 states the band split IS engine severity
with no priority logic in the page. Both remain true. Line 373 is a fixture
issue row. **No demo change is required** - the recalibration flows into the
Errors band automatically, which is the whole point.

`test/fixtures/harness.test.ts:1818-1832` derives worst-severity-per-page from
the live registry and compares it to `site.health`'s output. It is
severity-agnostic by construction, but it runs against the real fixture site, so
its *expected counts* may move if a fixture page's worst severity changes from
warning to critical. Run it and read the diff; do not assume it is clean.

### Prose in the checklist and docs

`skills/ariadne-audit/checklist.md` names rule severities inline in about 64
places, in the form ``` `rule.id` (warning) ```. Of those, **24 name a rule this
proposal promotes** and must be edited in the same commit or the checklist -
which CLAUDE.md rule 10 calls the living authority - will disagree with the
registry. There is no CI check tying those parentheticals to the registry, so
this is a manual sweep. Grep pattern that finds all of them:

```
grep -no '`[a-z0-9.-]*` (critical)\|`[a-z0-9.-]*` (warning)\|`[a-z0-9.-]*` (info)' skills/ariadne-audit/checklist.md
```

Also in the checklist: line ~102 maps checklist verdicts to engine severities
("FAIL | `FAIL` | `critical` or `warning` - the engine's severity for the rule,
or yours in context"). That mapping is unaffected and stays as written. Line
~397 and ~450 describe `content.csr-dependent` (critical) and `filters.js-only`
(warning) in prose; neither changes.

Docs are almost clean. `docs/talos-surface.md` lines ~800-803 name
`resources.not-recorded` and `resources.not-fetched` as `(info)` - both
unchanged. `docs/gates/phase-7.md` has severity words in captured gate output;
that is a historical record of a run and must **not** be retro-edited.
`docs/crawl-audit-engine-spec.md` describes the enum and the rule contract but
names no individual rule's severity, so it needs no edit - though it is the
natural home for the rubric in section 1 of this document if the owner wants the
rubric checked in rather than living in the build plan.

### `site.health` and what the rollup now means

No change to `src/rules/metric/health-metrics.ts` is proposed and none is
needed. `SEVERITY_ORDER` already ranks all three values and throws on an
unranked one; the enum is not changing, so the guard is untouched. The metric
counts pages by the worst severity each carries, and that logic is
severity-value-agnostic.

But the **meaning** of the rollup shifts, and it shifts a lot. `urlsCritical`
today means "pages that are mechanically broken" and is near zero on most sites;
after this change it means "pages carrying a first-fix SEO defect" and on a
typical client site it will be a large fraction of the auditable population. A
site whose every page is missing a title tag goes from 0% critical to 100%
critical with no change in the site. Consequences to handle downstream, none of
them engine work:

- Any dashboard, gauge or trend line drawing on `urlsCritical` is not comparable
  across the 0.11.0/0.12.0 boundary. `docs/talos-surface.md` notes Talos draws a
  gauge from this metric; whoever builds it needs the ruleset version beside the
  number.
- `test/rules/coverage.test.ts:151-155` comments on exactly this - that a rule
  moving without a severity change is a MOVE, and that the health metric is what
  Talos gauges from. Worth re-reading before touching anything there.
- Historical crawls in the dev database keep their stored severities. That is
  correct and by design: `issues.severity` is what the ruleset said at judge
  time, and `test/api/query.test.ts` already has the cross-ruleset machinery for
  reporting a rule whose severity moved. Nothing needs backfilling. Do not
  backfill.

### Suggested commit shape

One commit, not 29. The change is a single coherent recalibration and splitting
it makes the checklist sweep and the test updates land out of step with the
registry, which is a broken intermediate state. Order inside it: severity
literals, then `RULESET_VERSION` plus its comment entry, then the test
snapshots, then the checklist sweep. `npx tsc --noEmit` will catch nothing here
(the enum is unchanged), so the tests are the whole safety net - run the full
suite including the Chromium-dependent fixture harness before claiming green.

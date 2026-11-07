/**
 * Adapted from open-seo (MIT), src/server/lib/audit/page-analyzer.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 *
 * The streaming tokenizer, its state machine and every subtlety it encodes
 * (title-inside-svg, noscript-as-raw-text, implicitly-closed nested anchors,
 * body-vs-fallback text scoping, present-but-empty alt) are upstream's and are
 * carried over unchanged. Changes, each explained at its site below:
 *  - Upstream's `PageAnalysis` type lived in src/server/lib/audit/types.ts
 *    (a fifth file, read at the same sha). Rather than absorb that module —
 *    most of it is Lighthouse/persistence shapes Ariadne does not share — the
 *    two types this file needs (`PageAnalysis`, `PageLink`) are declared here.
 *    Ariadne's `PageAnalysis` is the shape the build plan specifies, not
 *    upstream's; `analyzeHtml` keeps producing upstream's richer result under
 *    the name `RawPageAnalysis` and `analyzePage` is the facade over it.
 *  - Dropped upstream's `statusCode` / `responseTimeMs` / `redirectUrl` /
 *    `url` passthrough parameters: they are fetch-layer facts the analyzer
 *    never reads, and Ariadne's crawl loop owns them.
 *  - Per-image records are no longer accumulated. The build plan wants images
 *    counted, not stored, so `imagesTotal` / `imagesMissingAlt` are counters.
 *    That also removes upstream's image cap and the count saturation it caused.
 *  - Added `canonicalCount`, `headingCounts`, `hasAmp` (the `pages` row wants
 *    all three) and a per-link `position`.
 *  - `rel` values are lowercased before they are matched. Upstream compared
 *    `attribs["rel"] === "canonical"` case-sensitively while its cheerio
 *    oracle matched case-insensitively (css-select treats `rel` as one of
 *    HTML's case-insensitive attribute values), so `rel="Canonical"` silently
 *    diverged. HTML link types are case-insensitive; lowercasing (and, on the
 *    same token-value reasoning as below, trimming) is correct and restores
 *    parity.
 *  - The same case-folding is applied to `<meta>` `name` / `property` and to
 *    `<script type>`, which upstream also compared case-sensitively:
 *    `name="Description"` was read as "no description at all", turning a
 *    present tag into a false "missing" audit fact — the worst kind of defect
 *    this engine can produce. HTML metadata names and MIME types are both
 *    ASCII case-insensitive, and the surrounding whitespace of a token-valued
 *    attribute is not part of the token, so the values are trimmed too.
 *    Unlike `rel`, css-select does NOT case-fold `name` / `property` / `type`
 *    (verified: `meta[name="description"]` misses `name="Description"`), so
 *    here the port deliberately diverges from raw css-select and the parity
 *    oracle case-folds by hand to match. That divergence is the point: the
 *    oracle encodes the old DOM implementation, and the old DOM
 *    implementation was wrong about this.
 *  - Head fields are now strictly first-element-wins. Upstream's `??=` meant a
 *    `<link rel=canonical>` with no href left `canonical` null and let a later
 *    canonical win, which the DOM oracle would not. A `undefined` = not-seen
 *    sentinel makes the first element authoritative either way.
 *  - Caps are the build plan's: links 2000 (upstream 1000), headingOrder 500
 *    (upstream uncapped). Heading *counts* stay uncapped.
 *  - `title` and `metaDescription` are `string | null`, where null means the
 *    element was absent and "" means it was present and empty — upstream
 *    collapsed both to "". The distinction is a real audit signal.
 *
 * Task 6 (P1-T3) then extended the analyzer with the checklist fields upstream
 * never had — rel next/prev, dom size, text ratio, hreflang pairs, JSON-LD
 * capture, content hash and simhash — all inside the same single pass. Two of
 * its changes touch absorbed behaviour rather than adding to it:
 *  - Element boundaries are whitespace. Upstream joined text nodes with no
 *    separator, so minified markup (`</h1><p>`) merged the last word of one
 *    block into the first word of the next and undercounted every such page.
 *    Non-inline element boundaries now emit a separator, matching what a
 *    browser renders; inline elements (`<em>`, `<b>`, …) and stripped
 *    subtrees (`<script>`) do not, so `un<em>believ</em>able` stays one word.
 *    `wordCount`, `textRatio`, `contentHash` and `simhash` all read this one
 *    accumulator. This is a deliberate divergence from the old DOM
 *    implementation (cheerio's `.text()` concatenates exactly as upstream
 *    did); the parity oracle walks the DOM the same way so the suite still
 *    holds the port to a reference, and named tests pin the new behaviour.
 *  - `<link rel>` is matched as a token list, not as a whole value. `rel` is
 *    space-separated by spec (`rel="next prefetch"`), and a DOM `relList` /
 *    css-select `[rel~=…]` match reads it that way; the whole-value compare
 *    upstream used silently missed every multi-token link. Canonical,
 *    alternate/hreflang and amphtml came along to token matching with
 *    next/prev; the oracle was moved to `~=` semantics to match.
 *
 * Phase 2 (P2-T2) added three more signals the page rules need, all inside the
 * same pass: `hasViewport` (a `<meta name=viewport>`, folded like every other
 * meta name), `imagesMissingDimensions` (counted beside the alt counter, one
 * count per image whichever attribute is absent) and `hasLoremIpsum`, derived
 * at the end from the visible-text accumulator — the same one `wordCount`,
 * `contentHash` and `simhash` read, so a lorem-ipsum string inside a script,
 * style or noscript subtree cannot raise the flag. The first two are on the
 * parity surface and the oracle computes them; `hasLoremIpsum` is not, for the
 * same reason `contentHash` and `simhash` are not — it is a derivation of
 * `bodyText`, which the oracle already holds the port to, not a separate piece
 * of DOM reading.
 *
 * Phase 3 (P3-T2) added `hasSoft404Phrases` on exactly the same footing as
 * `hasLoremIpsum`: same visible-text accumulator, same end-of-parse
 * derivation, same exclusion from the parity surface (it is a `bodyText`
 * derivation, not a DOM read, so `EXTENSION_FIELDS` strips it). It exists
 * because the soft-404 rule (CHECK-16) needs a phrase signal it can read in
 * SQL, and the crawl is the only place the page's text is ever in memory.
 *
 * Phase 5 (P5-T2) added the render pass's raw-HTML baseline, again inside the
 * same pass: `navLinkCount` / `footerLinkCount` (depth counters, built on the
 * `titleDepth` idiom) and `frameworkMarkers`. Unlike the two text derivations
 * above, all three ARE DOM reads — `nav a[href]`, `footer a[href]`, and three
 * attribute/id presences — so they stay ON the parity surface and the oracle
 * computes them with those very selectors. That is load-bearing rather than
 * tidy: the render pass runs `document.querySelectorAll('nav a[href]').length`
 * in a real browser and CHECK-34 compares its answer with this one, so the
 * tokenizer has to agree with the selector about nesting and about every
 * malformed case tried, or the check compares two different questions.
 *
 * Phase 7 (P7-T1) corrected what the text accumulator counts, and added a
 * second accumulator beside it. Both come from the lavishalice.com render
 * diagnosis (`audits/lavishalice.com/render-diagnosis.md`), which measured a
 * product page at 1,413 raw words against 335 rendered ones and attributed
 * every missing word:
 *  - **`<template>` text leaves the visible-text accumulators, which CHANGES
 *    `word_count`.** This is the one semantic change this file has ever made
 *    to a number already in the database, and it is a bug fix rather than a
 *    redefinition: a real parser puts template content in an inert
 *    `DocumentFragment` that is in no document, is rendered under no CSS and
 *    is indexed by nothing, so text inside a `<template>` was never content
 *    and counting it was never right. On the diagnosed product page it was
 *    482 of 1,413 words — 34% of a PDP's "content", which is exactly the page
 *    type a thin-content or duplicate-content rule cares about most. The
 *    parity oracle was already right here and nobody noticed: cheerio's
 *    parse5 tree puts template children under a fragment node the oracle's
 *    TEXT WALK skips, so the two sides silently disagreed on any page
 *    carrying a template. They now agree by both excluding it.
 *
 *    THE BLAST RADIUS IS EXACTLY THE SIX DERIVATIONS OF THAT ACCUMULATOR —
 *    `wordCount`, `textRatio`, `contentHash`, `simhash`, `hasLoremIpsum` and
 *    `hasSoft404Phrases`, every one of them a reading of `bodyText` — plus
 *    `renderableWordCount`, which is new and template-free by construction.
 *    Nothing else moves. `<template>` is tracked by its own depth counter
 *    and NOT by `NON_CONTENT_TAGS` precisely so that stays true: the element
 *    extractions, and the element TEXT they capture (the first `<h1>`'s
 *    words, an anchor's words, the document title), are untouched, because
 *    the oracle's selectors reach template content and this file must agree
 *    with them about it. See `TEMPLATE_TAG`.
 *  - **`renderableWordCount`** is a SECOND count over the same visible-text
 *    stream, additionally dropping text inside markup that says the element is
 *    not displayed: a `hidden` attribute, an inline `style` containing
 *    `display:none`, a `<dialog>` without `open`, and the non-`<summary>`
 *    content of a `<details>` without `open`. `word_count` keeps its old
 *    meaning (every word the HTML carries, template excepted) and the new
 *    column is what the render diff and the thin-content floor read, because
 *    those two ask "how much can a reader see" and the raw number answers
 *    "how much did the server send".
 *
 * WHAT `renderableWordCount` IS NOT, stated here and in the parity oracle
 * because a number this easy to over-trust needs its limits written down: it
 * is MARKUP-ONLY, and it is not an emulation of `innerText`. A class that
 * hides its element through a stylesheet is invisible to a tokenizer that
 * never fetches, let alone cascades, CSS — by design (hard rules 2 and 4) —
 * so the ~740 words of per-page chrome the diagnosis attributed to theme CSS
 * on that site are still counted here. This is the honest markup-only FLOOR of
 * the correction: `renderableWordCount <= wordCount` always, and the gap that
 * remains against a rendered `innerText` count is CSS-hidden text, which is
 * evidence rather than error. The one false positive the rule can produce is a
 * `style` attribute whose `display:none` is overridden later in the same
 * string (`style="display:none;display:block"`), which this counts as hidden;
 * matching the attribute string is deliberate, since anything better is a CSS
 * parser.
 *
 * Phase 11 (P11-T1) added `resourceRefs` — the URLs of the images, stylesheets
 * and scripts the page points at — off the same walk that already counted
 * images. THE COUNTERS STAY, and both exist because they answer different
 * questions: `imagesTotal` / `imagesMissingAlt` / `imagesMissingDimensions` are
 * cheap scalar facts ABOUT THE PAGE (uncapped, one integer each, readable
 * without a join), while a ref is a fact about a FILE — one row per distinct URL
 * per crawl — that the resource fetch pass then asks a server for. A count
 * cannot be fetched and a ref list cannot be summed per page in SQL as cheaply;
 * deriving either from the other would cost the thing the other is for.
 *
 * The extraction is a CLOSED LIST of five attribute sites, and it is closed in
 * the strong sense that a test asserts the absences:
 *   `<img src>`, `<img srcset>` (first candidate), `<source src>` and
 *   `<source srcset>` INSIDE a `<picture>`, `<script src>`,
 *   `<link rel=stylesheet href>`.
 * NOT: inline `style` `url()`, `@import` inside a `<style>` body (both need CSS
 * parsing, which this file does not do and the phase stores no bodies for),
 * `preload` / `prefetch` / `preconnect` hints, favicons, fonts, `<source>`
 * inside `<video>` / `<audio>` (media is out of the owner's scope for this
 * phase), and — the one exclusion that is about POLITENESS rather than scope —
 * an ALTERNATE stylesheet (`rel="alternate stylesheet"`, in either token order).
 * A browser fetches one of those only if a reader selects that style, so asking
 * for it would spend a request against a client's server on a file no page load
 * requests, and would weigh the page by bytes no visitor downloads. Every URL on
 * this list is one a polite fetcher will later request from somebody's server,
 * so widening it is a decision, never a tidy-up.
 *
 * Four rules the refs follow, each with its reason:
 *  - **Resolution is `normalizeUrl`**, the same function the link extraction
 *    uses and the same one the frontier keys pages by: absolute against the page
 *    URL, http(s) only, fragment stripped, query params sorted, hostname
 *    lowercased. One resolution semantics for everything this engine fetches.
 *  - **A ref that names no resource is dropped**: a `data:` URI (the bytes are
 *    already here), `javascript:`, a fragment-only reference, an empty or
 *    whitespace-only attribute, and anything `normalizeUrl` refuses. These are
 *    not failures to report (hard rule 7 is about work that failed, not about
 *    markup that never named a file) — they are markup that points at nothing
 *    fetchable.
 *  - **One entry per URL per page**, first kind wins, on the `linksByTarget`
 *    idiom. The per-page map is O(page) and capped; the CROSS-page dedup is the
 *    `resources` table's unique index and is never a set in memory (hard rule 6).
 *  - **`srcset` is read to its FIRST candidate only.** A candidate list is a set
 *    of renditions of one image and the fetch pass is asking "how heavy is this
 *    image", not "how many variants exist"; fetching all of them would multiply
 *    the request count against a client's CDN for an answer nobody asked for.
 *    First rather than largest because a `w`/`x` descriptor is a claim about
 *    intent, not a measurement, and picking by it would mean trusting the markup
 *    to rank files by weight. The candidate is taken the way the HTML spec's
 *    parser does — skip leading whitespace and commas, take up to the next
 *    whitespace, strip trailing commas — so a comma INSIDE a URL (Cloudinary's
 *    `w_100,h_200`) survives, which splitting on commas would not.
 *
 * Phase 19 (P19-T1) added a THIRD text stream beside those two, and a quotation
 * from the first. Both come from the audit-accuracy diagnosis of a real crawl
 * (docs/superpowers/specs/2026-09-09-audit-accuracy-pass-design.md §2 and §3),
 * which measured a site whose smallest page carries 916 words and whose median
 * carries 1,064 — about 900 of them the same header, navigation and footer on
 * every page. A `simhash` over the whole visible text says two pages with 150
 * words of their own are the same page, which is exactly what it said: 500
 * near-duplicate findings, 237 of them across unrelated templates.
 *  - **`mainWordCount` / `mainSimhash`** are the same two derivations over the
 *    page's MAIN CONTENT rather than over everything it renders. What "main
 *    content" means here is one rule with a fallback, decided at the END of the
 *    parse: the visible text inside the FIRST `<main>` element when the
 *    document has one, and otherwise the visible text of the body — and in
 *    BOTH cases MINUS every `<nav>`, `<header>`, `<footer>` and `<aside>`
 *    subtree, including the ones inside that `<main>`. Both candidate streams
 *    are accumulated DURING the one pass and the choice is made after it,
 *    because the fallback cannot be known to be needed until the document has
 *    ended without a `<main>`. That keeps the file's one promise — one
 *    tokenizer pass, no tree, O(text) — and costs two more arrays of pointers
 *    into strings the body accumulator already holds.
 *  - CHROME IS EXCLUDED INSIDE `<main>` TOO, and the reason is evidence rather
 *    than reasoning. The first cut of this stream kept it ("a document that
 *    says where its content is has said so about the nav in it"); the re-crawl
 *    at 0018 (`crawl_9278877e`, 547 pages) then produced 500 capped
 *    near-duplicate pairs, every one between pages whose main word count was
 *    105 to 107. This Shopify theme puts its newsletter block and its footer
 *    navigation INSIDE `<main>` — one `<footer>` landmark per `<main>` — so the
 *    "main content" of an empty `/pages/*` page was its heading plus 105 words
 *    of footer, identical on 79 pages. The rule is therefore the same on both
 *    sides of the fallback: chrome is furniture wherever it sits, and a page
 *    whose `<main>` holds nothing but chrome has no main content at all
 *    (`null`, below). See the spec's §11 amendment.
 *  - "The first `<main>`" is the first one the ORACLE'S WALK would reach, which
 *    is what makes the two sides comparable: a `<main>` inside a `<template>`,
 *    a `<script>`, an `<svg>` or a `<noscript>` is not it, because the DOM
 *    reference never walks into those subtrees either. A `<main>` nested inside
 *    that first one is invalid HTML and is counted as part of it (the depth
 *    idiom below), never as a second candidate.
 *  - The main stream uses the `bodyText` accumulator's rules and NOT
 *    `renderableWordCount`'s markup-hidden exclusion. The fingerprint is over
 *    the main content AS SERVED — that is the thing two templates share or do
 *    not share — and adding a second, differently-scoped exclusion to it would
 *    make a hamming distance between two pages depend on which of them hides a
 *    dialog. `renderableWordCount` answers a different question and keeps it.
 *  - Both outputs are `null` when the chosen stream has NO words: an empty
 *    `<main>`, or a body that is nothing but chrome. Null is "nothing to
 *    fingerprint", never `0` — a rule must be able to tell a page it could not
 *    measure from a page it measured at zero.
 *  - **`placeholderSnippet`** is the EVIDENCE for `hasLoremIpsum`, which fired
 *    on three 1,000-word blog posts whose only placeholder copy was an excerpt
 *    and a meta description, and reported `{wordCount}` — a true finding a
 *    reader could do nothing with. It is up to 160 characters of the visible
 *    text STARTING AT the first match — the sentence the placeholder opens,
 *    not a window around it — cut back to a whole word at the far end, and
 *    null exactly when `hasLoremIpsum` is false. Starting at the match rather
 *    than centring on it is itself an evidence lesson from the same crawl: a
 *    centred window on a blog listing page spent half its 160 characters on
 *    the header chrome that precedes the article excerpt ("£ NZD $ USD $ Help
 *    Center … Cart … Your bag is empty") and quoted only the first few words
 *    of the placeholder sentence a reader was being sent to find. Derived
 *    at the end of the parse from `bodyText`, like the flag itself, so it costs
 *    no second look at the document.
 *
 * Phase 23 (P23-T5, study §4.1) taught the pass WHERE THE HEAD ENDS, which is
 * not where `</head>` is written. A browser's tree builder (and a search
 * engine's, which is the same algorithm) closes the head at the first token a
 * head may not hold, and everything after that is in the body whatever the
 * markup says: a tracking `<img>` injected at the top of the head pushes the
 * canonical, the robots meta and the hreflang links below it out of the head.
 * Three modes stand in for the HTML Living Standard's insertion modes
 * (§13.2.6.4):
 *  - **head** — "initial", "before html", "before head" and "in head" folded
 *    into one: the head is open from the first byte, implied or not, so a
 *    document with no `<head>` tag keeps a leading canonical in it. Whitespace
 *    text, comments, the doctype and a leading byte-order mark change nothing.
 *    `HEAD_ALLOWED` start tags stay; `<head>` and `<html>` are absorbed. The
 *    head closes EXPLICITLY at a non-implied `</head>` (→ afterHead,
 *    `headClosedBy` null) and IMPLICITLY at any other start tag — `<body>`
 *    included — or at non-whitespace text (→ body, `headClosedBy` the tag name
 *    or `#text`). `</html>` and `</body>` are "anything else" too and record
 *    `</html>`. A stray `</p>` (which htmlparser2 hands over as an implied
 *    `<p>`) is ignored, as the tree builder ignores that end tag; a stray `</br>`
 *    is read as `<br>`, as the tree builder reads it, and closes the head.
 *  - **afterHead** — "after head": whitespace stays; `AFTER_HEAD_REOPENS` start
 *    tags are put BACK into the head (a canonical between `</head>` and `<body>`
 *    is inside it in the DOM, so it is not flagged); everything else, `<body>`
 *    and `<noscript>` included, opens the body.
 *  - **body** — terminal. A second `<head>` is ignored by the tree builder and
 *    here alike.
 * `HEAD_CONTAINERS` (title, script, style, noframes, noscript, template) opened
 * in either head mode suspend the machine until they close: their content is
 * RCDATA, raw text (`<noscript>` with scripting on, which is how parse5, the
 * cheerio oracle and Googlebot all parse it), or a template fragment — none of
 * it ends the head, and text inside a `<title>` is not a closing text node.
 * Implied closes are ignored: they are htmlparser2's own tree repair (it closes
 * the head when `<body>` opens, and everything at EOF), and the token that
 * caused one is read on its own event. An `<svg>` or `<math>` in the head ends
 * it like any other disallowed tag, as it does in parse5.
 *
 * The four single-element flags are FIRST-OCCURRENCE flags (controller ruling,
 * fix round 1): `titleOutsideHead`, `metaDescriptionOutsideHead`,
 * `robotsOutsideHead` and `canonicalOutsideHead` are true only when the FIRST
 * non-svg `<title>`, `<meta name=description>`, `<meta name=robots>` or
 * `<link rel=canonical>` in the document — the one the value is read from —
 * arrives in body mode. A correct in-head canonical followed by a body
 * duplicate is false here; `canonical.multiple` reports the duplicate.
 * `hreflangOutsideHeadCount` stays a count of every `<link rel=alternate
 * hreflang>` in body mode. All five are set in the SAME code paths that capture
 * the values, so the `<noscript>` exclusion and the template inclusion are the
 * ones the values already have, and the oracle's selectors agree. THE VALUES DO
 * NOT MOVE: the canonical, robots meta, title and hreflang pairs are still the
 * first occurrence anywhere. Whether an outside-head canonical should stop
 * being the page's canonical is an indexability verdict waiting on an owner
 * ruling.
 *
 * KNOWN LIMITS, all from one htmlparser2 behaviour: it drops an end tag whose
 * element is not open.
 *  - A `</head>` with no `<head>` open is invisible; the head then ends at
 *    whatever opens the body, usually `<body>` (closer `body` where the tree
 *    builder would say explicit). Head tags between the two land in the head on
 *    both sides, so only the closer's name differs, never a flag.
 *  - A stray `</body>` in the head (no `<body>` can be open there), and a stray
 *    `</html>` with no `<html>` open, are invisible too. The tree builder reads
 *    either as "anything else" and ends the head; here the head stays open, so
 *    a canonical (or robots, title, description, hreflang) after one is
 *    reported INSIDE where parse5 says outside. A rare false negative, never a
 *    false positive. Pinned in test/crawl/page-analyzer.test.ts.
 *
 * ONE KNOWN, PERMANENT DIVERGENCE, and it is a property of the port rather
 * than a defect in it. An `<a href>` left open across a container boundary —
 * `<a href="/x"><nav><a href="/y">y</a></nav></a>` — makes the DOM report 2
 * for `nav a[href]` where this counts 1. The outer anchor is in the tree
 * builder's list of active formatting elements, so the adoption agency
 * algorithm RECONSTRUCTS it inside the `<nav>`: the browser genuinely holds an
 * anchor element the token stream never contained. Counting it would require
 * the tree correction a DOM does and this file exists not to do (hard rule 4),
 * so the divergence is pinned by a named test in the parity file rather than
 * fixed, and it bounds the comparison: a raw nav/footer count can be UNDER the
 * rendered one by 1 per unclosed `<a>` crossing a container boundary, and
 * never over. CHECK-34's threshold must tolerate ±1 for that reason (Task 5 —
 * the same note is on `pages.nav_link_count` in src/db/schema.ts).
 *
 * Phase 26b (P26b-T2, extraction version 2) added head facts and the social
 * set, all as tokenizer state in the same pass and all capped (shapes and caps
 * in page-facts.ts). Metas inside `<noscript>` stay ignored, as every meta is.
 *  - `htmlLang`: the FIRST `<html>` start tag's `lang`, trimmed and capped.
 *  - `social`: the Open Graph and X tags, read in `handleMetaTag` beside the
 *    existing chain rather than inside it (one element may carry a `name` the
 *    chain matches and a social `property`). Open Graph is read from
 *    `property=` or `name=`; `twitter:*` from `name=`, or from `property=`,
 *    which X ignores and so raises `xViaProperty`. The first value of each tag
 *    is trimmed and capped; every element is counted; a tag seen with two
 *    distinct trimmed values is `conflicting` (compared uncapped, capped once
 *    at the end); `outsideHead` is any social tag met in body mode. Null only
 *    when the page has no social tag. `ogTitle` / `ogDescription` / `ogImage`
 *    (the legacy `og_*` columns) are filled from the same path (PR #23
 *    review): the FIRST element whose `property` OR `name` is the tag, its
 *    `content` untrimmed (null when it has none), as before. Before, they read
 *    `property=` only from the meta else-if chain, so `<meta name=og:title>`
 *    and `<meta name=description property=og:description>` (the chain matched
 *    `description` first) left them null while `social.og` had them, and
 *    `social.og-duplicate`, which groups those columns, missed the groups the
 *    page rules saw. On an extraction-1 row they keep the old meaning.
 *  - `socialImageRefs`: the two JUDGED share images only, the first `og:image`
 *    and the first `twitter:image`, each resolved once (`shareImageRef`:
 *    `normalizeUrl` of the whole value, only when it is absolute http(s)) and
 *    stored as `social.imageRefs`; deduped, at most two (final review I1) —
 *    and deliberately NOT through `addResource`. A browser never loads a share
 *    image, so these become `resources` rows with no `page_resources` edge
 *    (deviation 3): no page weight, no mixed content, no `resources.broken`.
 *  - `h2Text`: the first `<h2>`, collected exactly as `h1Text` is.
 *  - `titleCount` (non-svg `<title>` elements) and `metaDescriptionCount`.
 *  - `robotsMetas`: the bot-specific robots metas (`ROBOTS_META_BOTS`), in
 *    document order, capped.
 *  - `metaRefresh`: the `<meta http-equiv=refresh>` a browser acts on (the first non-empty one that parses; failing that, the first refused one), through
 *    `parseRefresh`.
 * ONE EXISTING FIELD CHANGES MEANING (deviation 4): `robotsMeta` is now every
 * `<meta name=robots>` content joined with ", ", not the first one's. Google
 * combines repeated robots metas, and reading only the first missed a later
 * `noindex` — `isIndexable` (persist.ts) reads this field and now sees it.
 * `robotsOutsideHead` stays a first-element flag. Ruling R6 then refined two
 * of these: a robots content identical (after trim) to one already kept is
 * dropped before the join (first-seen order and spelling kept, every distinct
 * directive survives), and one meta naming two social tags (`name=twitter:title
 * property=og:title`) records both.
 *
 * Phase 26b (P26b-T3) added the body facts, in the same pass, every one a
 * counter or a sample capped at ten (caps in page-facts.ts). `<noscript>`
 * content stays invisible to all of them, as to every element read here.
 *  - `anchorCounts`, over EVERY `<a>` start tag, including the ones that never
 *    open a link: `noHref` (no `href` attribute AND `onclick`, or `role`
 *    `link`/`button` — a bookmark is not a link, deviation 5); `emptyHref`
 *    (`href` blank after trim); `javascript` (`/^\s*javascript:/i`);
 *    `hashOnly` (trimmed href exactly `#` or `#!`; `#section` is in-page
 *    navigation); `unsafeBlank` (`target=_blank`, an href that is not
 *    `javascript:`, and neither `noopener` nor `noreferrer` among the `rel`
 *    tokens, and an href that resolves (`normalizeUrl` against the page) to
 *    an origin other than the page's, by exact `URL.origin` compare, so a
 *    subdomain or a `www.` variant counts while a same-origin link and an
 *    href that does not resolve do not: owner call O2, 2026-11-07, since
 *    reverse tabnabbing needs another origin). The first three are exclusive;
 *    `unsafeBlank` is orthogonal.
 *  - ANCHOR TEXT NOW INCLUDES IMAGE ALT: an `<img>` inside an open anchor
 *    pushes its trimmed, non-empty `alt` into the anchor's text, as a text
 *    node would, with a space either side so it is a word of its own
 *    (`Home<img alt=Logo>` is "Home Logo"). `links.anchor` on a v2 row
 *    carries it; the oracle agrees.
 *  - `PageLink.ariaLabel` (owner call O1, 2026-11-07; `links.aria_label`,
 *    migration 0028): the `aria-label` of the SAME element that supplies the
 *    link row's anchor, the first `<a>` start tag to resolve to that target
 *    (`closeAnchor`: first one wins). Trimmed, cut at `ARIA_LABEL_MAX` through
 *    `storableCap`, null when absent or blank. It never enters the anchor.
 *  - `relNextCount` / `relPrevCount`: every `<link rel~=next|prev>`, href or
 *    not. The first-only `relNext` / `relPrev` are unchanged.
 *  - `insecureRefs`: references that resolve (`normalizeUrl`) to `http:` —
 *    `iframe` (`<iframe src>`), `media` (`<video src|poster>`, `<audio src>`,
 *    `<source src>` inside a `<video>`/`<audio>` (a `mediaDepth` counter, on
 *    `pictureDepth`'s idiom), `<track src>`, `<embed src>`, `<object data>`)
 *    and `formAction` (`<form action>`); `forms` counts every `<form>`. The
 *    sample keeps the first `INSECURE_SAMPLE_MAX` of each kind, in document
 *    order. A sampled URL is cut at `INSECURE_SAMPLE_URL_MAX`; the counters see
 *    it whole. Recorded
 *    on every page whatever its scheme; the rules decide by the page's.
 *  - `imagesEmptyAlt`, `imagesAltTooLong` (trimmed alt over
 *    `ALT_TEXT_LONG_CHARS`, applied here, deviation 10) and
 *    `imagesMissingAltSample` (raw `src` of the first images with no `alt`),
 *    all in the existing `img` case beside `imagesMissingAlt`.
 *
 * Phase 26b (P26b-T4) added `htmlStructure`, in the same pass and as scalars
 * (shape and cap in page-facts.ts). Every start tag the tokenizer emits is read,
 * `<noscript>` and `<template>` content included.
 *  - `htmlTags` / `headTags` / `bodyTags`: EXPLICIT start tags only.
 *    htmlparser2 implies none of the three; an `isImplied` open is not counted.
 *  - `headBeforeBody`: whether the first explicit `<head>` precedes the first
 *    explicit `<body>`; null when either is absent.
 *  - `closedEarly` (deviation 6): the first CANDIDATE met while the head
 *    machine is in head mode — a start tag outside `HEAD_ALLOWED` (the token
 *    `headClosedBy` names; a stray `</br>` included, a stray `</p>` not), a
 *    start tag inside a head `<noscript>` that is ALSO outside `HEAD_ALLOWED`
 *    (ruling R12b: the same test as outside it; `inNoscript: true`), or non-whitespace text (`#text`, snippet the text
 *    trimmed of HTML whitespace). A start tag's snippet is its source,
 *    `html.slice(startIndex, endIndex + 1)`, cut at `HEAD_SNIPPET_MAX` before it
 *    is copied. `<body>` is NEVER a candidate: it is where a head is meant to
 *    end (ruling R8 (a)). The candidate is reported only if a later token is
 *    evidence the head was meant to go on, and is null otherwise, so a valid
 *    document that omits `</head>` and starts its body is not flagged. Ruling
 *    R8 (b) narrowed deviation 6's evidence list to elements that only belong
 *    in a head, because a body may legitimately hold the others: an explicit
 *    `</head>`; an explicit `<body>`; `<base>`; a `<title>` outside `<svg>`; a
 *    `<meta>` without `itemprop` (microdata metas are body content); a `<link>`
 *    with at least one `rel` token that is not body-ok (`BODY_OK_LINK_RELS`; a
 *    link with no or blank `rel` is body-ok). `<style>` is not evidence: it is
 *    allowed in a body. The head-noscript read is BESIDE the Phase 23 machine,
 *    not in it: a head noscript's children stay invisible to `headClosedBy`,
 *    `headMode` and every outside-head flag, exactly as before.
 *  - `closedEarly.lost` (owner call O3, 2026-11-07): the head-only tags of the
 *    evidence list above (`base`, a non-svg `title`, `meta` without
 *    `itemprop`, `link rel=<first head-only token>`) met AFTER the candidate
 *    and before the first explicit `<body>`: what a parser closing the head at
 *    the candidate moves into the body. Document order, deduped, capped at
 *    `HEAD_LOST_MAX`. `<body>` and `</head>` confirm but are never lost, so
 *    a tracking pixel's `<noscript><img>` last in the head is an early close
 *    with `lost: []`. A `<template>`'s content is neither evidence nor lost:
 *    a start tag inside one neither confirms the candidate nor joins `lost`
 *    (`structureOnOpenTag` reads both at `templateDepth === 0`), since
 *    template content is in no document's head.
 *
 * EVERY PHASE 26b STRING IS MADE STORABLE where it is capped, by the one shared
 * `storableCap` (src/crawl/storable-text.ts, also the render console's):
 * U+0000 becomes U+2400, a lone surrogate U+FFFD, and the cap cuts on a
 * code-point boundary, so a hostile page cannot make the page-row insert throw.
 * That covers the html-structure snippet (tag and text), every `social` value,
 * `robotsMetas` contents, the joined `robotsMeta`, `metaRefresh` (in
 * `parseRefresh`), `htmlLang`, `h2Text`, the insecure sample URLs and the
 * missing-alt sample. Storability itself is the WRITER's: ruling R10 put
 * `storableDeep` at persist.ts's one buffering boundary, which also covers the
 * pre-26b strings (`title`, `metaDescription`, `h1Text`, the og trio, link
 * anchors, JSON-LD, …). It is applied here as well only so these caps cut on a
 * code point. The pre-26b caps (`h1Text`, the placeholder window, …) still
 * cut UTF-16 units: a half pair left at their edge reaches the writer and is
 * stored as U+FFFD, never as a failed insert.
 *
 * Phase 26c (P26c-T2, extraction version 3) keeps every reference out of the
 * index it cannot fit. A resolved URL over `INDEXED_URL_MAX` (url-utils.ts) is
 * a btree entry Postgres refuses, so one such `src` made the whole page's
 * insert throw in 26b. Each reference site now measures the URL its row would
 * hold, after resolving, with `fitsIndex`:
 *  - a link (`closeAnchor`, after `normalizeUrl`) and a resource
 *    (`addResource`, after `normalizeUrl`) over the limit are dropped and
 *    counted in `overlongUrls.links` / `.resources`;
 *  - an hreflang pair is measured by `hreflangTarget`, the resolution the
 *    writer stores (`new URL(...).href`, not `normalizeUrl`: the target column
 *    keeps fragment and parameter order), and counted in `.hreflang`;
 *  - a share image resolved by `shareImage` gets a null ref and
 *    `social.imageRefTooLong` set, so it has no `resources` row.
 * A refused reference takes a slot under its kind's existing cap (links 2,000,
 * `MAX_RESOURCE_REFS`, `MAX_HREFLANG_PAIRS`) exactly as a kept one does, so a
 * hostile page of refused URLs cannot make the pass resolve without bound. The
 * counts are of references, not distinct URLs: deduping would mean keeping the
 * refused strings. `url.reference-too-long` reports the counts; `url-policy`'s
 * `too_long` refusal keeps the same URLs off every fetch path.
 * Phase 26c (P26c-T6) exports `MAX_HREFLANG_PAIRS` so the hreflang pairs of a
 * `Link` header (fetch-page.ts) are capped at the same 200; nothing here reads
 * the header.
 * Phase 26c (P26c-T4) also records `og:image:secure_url` as one more social
 * tag (`SOCIAL_SLOTS`: first value, count, conflict, capped at
 * `SOCIAL_URL_MAX`); it is a plain fact, not a judged share image.
 * Phase 26c (P26c-T5) records a link's wider name, `PageLink.nameHint` and
 * `nameHintSource` (`links.name_hint` / `name_hint_source`), as tokenizer state
 * on `OpenAnchor`, and only for a link whose anchor is empty and whose own
 * `aria-label` is null. Precedence, highest first, approximating the
 * accessible-name order: the `<a>`'s `aria-labelledby` (the trimmed id list,
 * unresolved, since resolving ids needs the whole document: deviation 8); the
 * first non-blank `aria-label` on an element opened inside the link; the first
 * non-blank text of a `<title>` inside an `<svg>` inside the link (whitespace
 * collapsed); the `<a>`'s `title`. Each is trimmed and cut at `ARIA_LABEL_MAX`
 * through `storableCap`; only the winner is stored. The svg title is read in
 * `ontext` above the `suppressDepth` return, by its own per-anchor state, so it
 * never reaches the anchor text, and `titleCount` / `titleOutsideHead` /
 * `titleDepth` keep their svg guard. `<noscript>` content names nothing.
 */
import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { fitsIndex, normalizeUrl, isSameOrigin } from "./url-utils.js";
import { simhash64 } from "./simhash.js";
import { storableCap } from "../storable-text.js";
import {
  ALT_TEXT_LONG_CHARS,
  ARIA_LABEL_MAX,
  H2_TEXT_MAX,
  HEAD_LOST_MAX,
  HEAD_SNIPPET_MAX,
  HTML_LANG_MAX,
  IMAGE_SAMPLE_MAX,
  IMAGE_SAMPLE_SRC_MAX,
  INSECURE_SAMPLE_MAX,
  INSECURE_SAMPLE_URL_MAX,
  parseRefresh,
  ROBOTS_META_BOTS,
  ROBOTS_META_CONTENT_MAX,
  ROBOTS_METAS_MAX,
  SOCIAL_TEXT_MAX,
  SOCIAL_URL_MAX,
  type AnchorCounts,
  type HtmlStructure,
  type InsecureRefKind,
  type InsecureRefs,
  type OverlongUrls,
  type RefreshFact,
  type RobotsMetaEntry,
  type SocialFacts,
  type SocialTag,
} from "./page-facts.js";

/** Where a link's `nameHint` came from (Phase 26c), highest precedence first. */
export type NameHintSource = "aria-labelledby" | "inner-aria-label" | "svg-title" | "title";

/** A link as the `links` table wants it. */
export interface PageLink {
  /** Absolute, normalized target URL (see url-utils `normalizeUrl`). */
  href: string;
  anchor: string;
  /**
   * The `aria-label` of the element that supplied `anchor` (the first `<a>` to
   * this target), trimmed and cut at `ARIA_LABEL_MAX` through `storableCap`;
   * null when the attribute is absent or blank (owner call O1). Never folded
   * into `anchor`: search engines read visible text and image alt as anchor
   * text, not `aria-label`.
   */
  ariaLabel: string | null;
  /**
   * Phase 26c: the link's wider name, recorded only when `anchor` is empty AND
   * `ariaLabel` is null; otherwise null. The first of, in order: the `<a>`'s
   * `aria-labelledby` (the id list as written, unresolved: deviation 8), the
   * first non-blank `aria-label` on an element inside the link, the first
   * non-blank text of a `<title>` inside an `<svg>` inside the link (whitespace
   * collapsed), and the `<a>`'s `title`. Trimmed and cut at `ARIA_LABEL_MAX`
   * through `storableCap`. Only the winner is kept; null when none names it.
   */
  nameHint: string | null;
  /** Where `nameHint` came from; null exactly when `nameHint` is. */
  nameHintSource: NameHintSource | null;
  /** Raw `rel` attribute, lowercased; null when the attribute was absent. */
  rel: string | null;
  nofollow: boolean;
  /**
   * 0-based rank among the unique links kept for this page, in the document
   * order of each target's first occurrence. Not a raw `<a>` element index:
   * duplicate targets, skipped protocols and unparseable hrefs never consume
   * a position, so the sequence is always dense.
   */
  position: number;
}

/** One `<link rel=alternate hreflang=…>` target: both halves, or nothing. */
export interface HreflangPair {
  /** The `hreflang` attribute verbatim (BCP47-ish; not normalised here). */
  code: string;
  /** The `href` attribute verbatim — unresolved, as written in the page. */
  href: string;
}

/**
 * What a resource IS, for this engine: the three classes the owner scoped for
 * Phase 11. Fonts, media and favicons are deliberately absent — a kind is what
 * the fetch pass will go and ask for, so the union is the scope.
 */
export type ResourceKind = "image" | "css" | "js";

/** One resource this page points at. See the module header's Phase 11 block. */
export interface ResourceRef {
  /** Absolute, normalized (`normalizeUrl`) — the spelling `resources.url` holds. */
  url: string;
  kind: ResourceKind;
}

/** One JSON-LD node lifted out of a `<script type="application/ld+json">`. */
export interface StructuredDataBlock {
  /** `@type`, or the first entry when `@type` is an array; else "unknown". */
  type: string;
  /** The parsed node itself, untouched. */
  raw: unknown;
}

/** Data extracted from a single page's HTML. */
export interface PageAnalysis {
  title: string | null;
  metaDescription: string | null;
  /** First `<link rel=canonical>` href; extras are counted, not stored. */
  canonicalHtml: string | null;
  canonicalCount: number;
  robotsMeta: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  /** h1..h6 occurrence counts, uncapped. */
  headingCounts: [number, number, number, number, number, number];
  /** Heading levels in document order, capped at MAX_HEADING_ORDER. */
  headingOrder: number[];
  /**
   * The first `<h1>`'s text, whitespace-collapsed and capped at
   * MAX_H1_TEXT_CHARS. Null means the page has no `<h1>` at all; `""` means it
   * has one and it is empty — the same present-but-blank distinction `title`
   * and `metaDescription` carry, and for the same reason.
   *
   * A derivation of `h1s[0]`, which the parity oracle already holds this file
   * to; the heading COUNT is what the existing rules read, and this is the
   * heading's WORDS, for the rule that compares an h1 with the title.
   */
  h1Text: string | null;
  wordCount: number;
  /**
   * `wordCount` minus the words no visitor can read WITHOUT CSS: everything
   * inside an element carrying `hidden`, an inline `display:none`, a `<dialog>`
   * that is not `open`, or the non-`<summary>` body of a `<details>` that is
   * not `open`. Always `<= wordCount` — the two streams share every element
   * boundary and differ only in which text nodes reach them, so dropping text
   * can merge two words but never split one.
   *
   * MARKUP-ONLY, and the module header says what that costs: class-based and
   * stylesheet-driven hiding is invisible here by design, so this is a floor on
   * the correction rather than an `innerText` equivalent. The render pass's
   * `rendered_word_count` is the number that sees CSS; the difference between
   * the two is the site's CSS-hidden chrome, which is evidence.
   */
  renderableWordCount: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  /**
   * `<img>` elements missing a `width` or a `height` attribute (either one
   * absent counts the image once). The layout-shift signal: a browser cannot
   * reserve space for an image whose intrinsic box it is not told.
   */
  imagesMissingDimensions: number;
  hasAmp: boolean;
  /** A `<meta name=viewport>` was declared — the mobile-readiness signal. */
  hasViewport: boolean;
  /**
   * The page's visible text contains "lorem ipsum" — placeholder copy that
   * shipped. Read off the same accumulator as `wordCount`, so script, style,
   * noscript and svg subtrees cannot trigger it.
   */
  hasLoremIpsum: boolean;
  /**
   * The page's visible text contains one of `SOFT_404_PHRASES` — the wording a
   * "not found" page uses when it forgot to say 404 in its status line. On its
   * own it is not a finding (a blog post about 404 errors says these words
   * too); the rule pairs it with a thin body and the site's own 404 template.
   * Read off the same accumulator as `wordCount`, so a phrase inside a script,
   * style, noscript or svg subtree cannot raise it.
   */
  hasSoft404Phrases: boolean;
  /**
   * Anchors carrying an `href` attribute inside a `<nav>` — the raw-HTML half
   * of CHECK-34 (navigation that only exists once JavaScript has run). Counted
   * on exactly the terms `document.querySelectorAll('nav a[href]').length`
   * would report, because that is what the render pass reads on the same page
   * and the two numbers are compared: any `href` value counts (`href=""`
   * included), any protocol counts (a `mailto:` nav link is still a nav link,
   * even though it never becomes a `links` row), and an anchor inside nested
   * containers counts once for each container it is in.
   */
  navLinkCount: number;
  /** The same count for `<footer>`; see `navLinkCount`. */
  footerLinkCount: number;
  /**
   * Which of `FRAMEWORK_MARKERS` the raw HTML carries, in that constant's
   * order (a set with a stable spelling, not document order). The tell of
   * which framework shipped the page — NOT a claim that the page needs
   * JavaScript to be readable, which only the render pass can answer.
   */
  frameworkMarkers: string[];
  links: PageLink[];
  /**
   * The images, stylesheets and scripts this page references, in document
   * order, one entry per distinct URL, capped at MAX_RESOURCE_REFS. The closed
   * extraction list, the drops, the `srcset` rule and the resolution semantics
   * are all in the module header's Phase 11 block.
   *
   * NOT a replacement for `imagesTotal` and its siblings, which stay exact and
   * uncapped: a count is a page fact, a ref is a file the fetch pass will ask a
   * server about (header, same block).
   */
  resourceRefs: ResourceRef[];
  /**
   * True when this page carried a resource reference the `MAX_RESOURCE_REFS`
   * cap dropped — the truncation saying so on the page instead of leaving the
   * short list to be read as the whole list (P12-T1, phase-11.md §10.1).
   *
   * WHAT IT MEANS EXACTLY: at least one reference was dropped UNEXAMINED. Past
   * the cap the extraction stops resolving, so it cannot know whether the
   * dropped reference was a new URL or a repeat of one already in the list —
   * and this reports what it knows rather than the stronger claim. A page whose
   * 2001st reference repeats its first raises it too, and that is the honest
   * reading: we did not look.
   *
   * False on a page holding exactly `MAX_RESOURCE_REFS` refs and no more —
   * full is not truncated.
   *
   * The gap it closes is specifically CSS and JS. `imagesTotal` sits beside the
   * image refs and is uncapped, so an image list cut short can be spotted
   * against it; stylesheets and scripts have no counter at all, so their
   * truncation was invisible in the data. `PageWriter` counts the pages that
   * raise this and the crawl loop stamps the total on
   * `crawls.resource_refs_capped_pages`.
   */
  resourceRefsCapped: boolean;
  /** First `<link rel=next>` href; null when absent or href-less. */
  relNext: string | null;
  /** First `<link rel=prev>` href; null when absent or href-less. */
  relPrev: string | null;
  /** Open-tag tokenizer events — the page's element count as parsed. */
  domSize: number;
  /** Visible-text bytes / HTML bytes, clamped to 0..1. */
  textRatio: number;
  /** `rel=alternate` targets in document order, capped at MAX_HREFLANG_PAIRS. */
  hreflang: HreflangPair[];
  /** JSON-LD nodes in document order, capped at MAX_STRUCTURED_DATA_BLOCKS. */
  structuredData: StructuredDataBlock[];
  /**
   * JSON-LD blocks that produced nothing: invalid JSON, or larger than the
   * per-block buffer cap. Counted rather than swallowed — a page whose
   * structured data does not parse is an audit finding, not an empty list.
   */
  structuredDataParseErrors: number;
  /** sha256 (hex) of the normalised visible text — exact-duplicate key. */
  contentHash: string;
  /**
   * 64-bit simhash of the same text — near-duplicate key. Unsigned range;
   * persistence stores `BigInt.asIntN(64, simhash)` (see simhash.ts).
   */
  simhash: bigint;
  /**
   * `simhash` over the page's MAIN CONTENT instead of over everything it
   * renders: the visible text inside the first `<main>` when the document has
   * one, else the body's visible text — in either case with the `<nav>`,
   * `<header>`, `<footer>` and `<aside>` subtrees removed, the ones inside the
   * `<main>` included. Same unsigned range and the same signed spelling in the
   * database as `simhash`.
   *
   * NULL WHEN THERE IS NOTHING TO FINGERPRINT — an empty `<main>`, a `<main>`
   * holding only chrome, or a body that is nothing but chrome — and never `0`.
   * See the module header's Phase 19 block for the choice rule and for why this
   * stream does not apply `renderableWordCount`'s markup-hidden exclusion.
   */
  mainSimhash: bigint | null;
  /** Words in the text `mainSimhash` was taken over; null on the same terms. */
  mainWordCount: number | null;
  /**
   * Up to 160 characters of the visible text STARTING AT the FIRST "lorem
   * ipsum" match — the evidence for `hasLoremIpsum`, which without it reports
   * a page and no quotation. Nothing that precedes the match is quoted: the
   * reader wants the sentence the placeholder sits in, and on a real page the
   * text before it is header chrome. Whole word at the cut end, whitespace
   * already collapsed (it is a slice of `bodyText`), trimmed; the whole
   * remainder of the text when that is shorter than the window.
   *
   * Null exactly when `hasLoremIpsum` is false: the two are one observation
   * reported twice, and a rule may rely on that.
   */
  placeholderSnippet: string | null;
  /**
   * What ended the `<head>` IMPLICITLY: the tag name of the first element the
   * HTML tree builder does not allow in a head (`img`, `div`, `svg`, `body`,
   * a stray `</br>` read as `br`), `#text` for the first non-whitespace text,
   * or `</html>` for that end tag. NULL when the head was closed EXPLICITLY by
   * `</head>` — and also when it never closed at all (a document that is all
   * head), where nothing can be outside it. See the module header's Phase 23
   * block for the state machine.
   */
  headClosedBy: string | null;
  /**
   * The FIRST non-svg `<title>` (the one `title` is read from) came after the
   * head ended. A body duplicate of an in-head title does not raise it; this
   * and the three flags below are first-occurrence flags.
   */
  titleOutsideHead: boolean;
  /** The first `<meta name=description>` came after the head ended. */
  metaDescriptionOutsideHead: boolean;
  /** The first `<meta name=robots>` came after the head ended. */
  robotsOutsideHead: boolean;
  /** The first `<link rel=canonical>` came after the head ended. */
  canonicalOutsideHead: boolean;
  /**
   * `<link rel=alternate hreflang=…>` elements (non-empty `hreflang`, any or no
   * `href` — the `hreflangTags` condition) after the head ended. Uncapped.
   */
  hreflangOutsideHeadCount: number;
  // ---- Phase 26b (extraction version 2); shapes and caps in page-facts.ts ----
  /**
   * The FIRST `<html>` start tag's `lang`, trimmed and capped at
   * `HTML_LANG_MAX`. Null when that tag has no `lang`, a blank one, or the
   * document has no `<html>` tag at all.
   */
  htmlLang: string | null;
  /**
   * The Open Graph and X (`twitter:`) tags. Null ONLY when the page carries no
   * social tag at all; see the module header's Phase 26b block for how each
   * part is read.
   */
  social: SocialFacts | null;
  /**
   * The non-null `social.imageRefs` (the first `og:image`, then the first
   * `twitter:image`, each resolved by `shareImageRef`), deduped, so at most
   * `MAX_SOCIAL_IMAGE_REFS`. NOT resource refs: a browser
   * never loads them, so they become `resources` rows with no `page_resources`
   * edge (deviation 3). A value that is not absolute http(s) (relative, another
   * scheme, empty) or that `normalizeUrl` refuses is skipped here and stays,
   * raw, in `social`; so is one that resolves over `INDEXED_URL_MAX` (Phase
   * 26c, `social.imageRefTooLong`).
   */
  socialImageRefs: string[];
  /** The first `<h2>`'s text, collected exactly as `h1Text` is; capped at `H2_TEXT_MAX`. */
  h2Text: string | null;
  /** `<title>` elements outside `<svg>`. A count, never null. */
  titleCount: number;
  /** `<meta name=description>` elements. A count, never null. */
  metaDescriptionCount: number;
  /**
   * The bot-specific robots metas (`ROBOTS_META_BOTS`, `name` lower-cased), in
   * document order, at most `ROBOTS_METAS_MAX`, content capped at
   * `ROBOTS_META_CONTENT_MAX`. Plain `robots` is `robotsMeta`'s.
   */
  robotsMetas: RobotsMetaEntry[];
  /** The `<meta http-equiv=refresh>` a browser acts on (first non-empty one that parses, else the first refused one), through `parseRefresh`. */
  metaRefresh: RefreshFact | null;
  /**
   * The `<a>` start tags outside `<noscript>` that fall into each link-hygiene
   * kind (Phase 26b, T3; the module header has each definition). Never null.
   */
  anchorCounts: AnchorCounts;
  /** Every `<link rel~=next>`, with or without `href`. `relNext` is the first. */
  relNextCount: number;
  /** Every `<link rel~=prev>`, with or without `href`. `relPrev` is the first. */
  relPrevCount: number;
  /**
   * Frame, media and form references that resolve (`normalizeUrl`) to an
   * `http:` URL, on every page whatever its own scheme (the rules decide by
   * the page's scheme), with every `<form>` counted and the first
   * `INSECURE_SAMPLE_MAX` references OF EACH KIND sampled (at most three times
   * that in all), in document order, each sampled URL cut at
   * `INSECURE_SAMPLE_URL_MAX`.
   */
  insecureRefs: InsecureRefs;
  /** `<img>` with an `alt` that is empty after trim. */
  imagesEmptyAlt: number;
  /** `<img>` whose trimmed `alt` is longer than `ALT_TEXT_LONG_CHARS`. */
  imagesAltTooLong: number;
  /**
   * The raw `src` of the first `IMAGE_SAMPLE_MAX` images `imagesMissingAlt`
   * counts, in document order, each capped at `IMAGE_SAMPLE_SRC_MAX`; `""` for
   * one with no `src`, so the sample is exactly the first such images.
   */
  imagesMissingAltSample: string[];
  /**
   * The document's explicit `<html>` / `<head>` / `<body>` start tags, the
   * order of the first head and body, and what closed the head early, if
   * anything did (Phase 26b, T4; deviation 6). Never null; see the module
   * header's T4 block for each part.
   */
  htmlStructure: HtmlStructure;
  // ---- Phase 26c (extraction version 3) ----
  /**
   * References whose resolved URL is over `INDEXED_URL_MAX`, counted per kind
   * and kept out of `links`, `resourceRefs` and `hreflang` (Phase 26c; the
   * module header's Phase 26c block). Never null; zeros on a page with none.
   */
  overlongUrls: OverlongUrls;
}

/**
 * Everything the tokenizer extracts, including the fields `PageAnalysis` does
 * not surface. `bodyText` and `h1s` are the parity suite's business and
 * nothing else's; `hasStructuredData` and `hreflangTags` are upstream's
 * coarse forms of what the facade now carries as `structuredData` and
 * `hreflang`, kept so the absorbed behaviour stays under the oracle.
 */
export interface RawPageAnalysis extends PageAnalysis {
  bodyText: string;
  h1s: string[];
  hasStructuredData: boolean;
  hreflangTags: string[];
  links: RawPageLink[];
}

export interface RawPageLink extends PageLink {
  isInternal: boolean;
}

const SKIPPED_LINK_PROTOCOLS = /^(javascript:|mailto:|tel:|#)/;
/**
 * Resource references that name no fetchable file. `data:` carries its own
 * bytes (and is case-insensitive as a scheme, which the link twin above does not
 * have to care about because no page writes `MAILTO:`); `javascript:` is code;
 * a leading `#` is a fragment of THIS page, which `normalizeUrl` would happily
 * resolve back to the page's own URL and so cannot be left to it. Everything
 * else non-http(s) — `blob:`, `about:`, `mailto:` on an `<img>` — dies in
 * `normalizeUrl`, which returns null for any other scheme.
 */
const SKIPPED_RESOURCE_PROTOCOLS = /^(data:|javascript:|#)/i;
/** An absolute http(s) address, any case: the only share image a platform can fetch. */
const ABSOLUTE_HTTP = /^https?:/i;
/**
 * The `resources` key of one share image (Phase 26b): its trimmed, UNCAPPED
 * value resolved by `normalizeUrl`, or null unless the value starts with
 * `http:` or `https:` (any case). A platform fetches a share image from the
 * address as written, so `social.image-broken` reports a value with no scheme
 * as `relative` and any other scheme as `invalid` from the stored value and
 * never reads a fetch of it; resolving and fetching it would spend politeness
 * and the resource cap on a row no rule reads (PR #23 review). An http(s)
 * value `normalizeUrl` refuses is null too, and the rule calls it `invalid`.
 * The one place a share image is resolved: the analyzer stores the result in
 * `SocialFacts.imageRefs` and queues it as a `resources` row, and
 * `social.image-broken` reads the stored string back rather than resolving
 * again (final review I1). Exported so a test can seed exactly what the
 * analyzer would have stored.
 *
 * Phase 26c: a resolved address over `INDEXED_URL_MAX` is no key at all (the
 * `resources` btree refuses it), so `ref` is null and `tooLong` is true; the
 * analyzer stores the pair as `imageRefs` / `imageRefTooLong`.
 */
export function shareImage(
  value: string,
  pageUrl: string,
): { ref: string | null; tooLong: boolean } {
  if (!ABSOLUTE_HTTP.test(value)) return { ref: null, tooLong: false };
  const resolved = normalizeUrl(value, pageUrl);
  if (resolved !== null && !fitsIndex(resolved)) return { ref: null, tooLong: true };
  return { ref: resolved, tooLong: false };
}

/** `shareImage`'s ref alone: the `resources` key the analyzer stores, or null. */
export function shareImageRef(value: string, pageUrl: string): string | null {
  return shareImage(value, pageUrl).ref;
}

/**
 * The `hreflang.target_url` the writer stores for one `<link rel=alternate
 * hreflang>` href: resolved against the page with `new URL(...).href`, fragment
 * and parameter order kept, which is not `normalizeUrl`'s spelling. Null when it
 * will not resolve; the writer counts those (`hreflangUnresolved`). The one
 * definition, read by the analyzer to measure a target against
 * `INDEXED_URL_MAX` and by persist.ts to write it, so the length checked is the
 * length stored.
 */
export function hreflangTarget(href: string, pageUrl: string): string | null {
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}
/**
 * The start tags the tree builder's "in head" insertion mode keeps in the head
 * (HTML Living Standard §13.2.6.4.4). Anything else — and `<body>` is anything
 * else — ends it. See the module header's Phase 23 block.
 */
const HEAD_ALLOWED = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "title",
  "noscript",
  "noframes",
  "style",
  "script",
  "template",
  "head",
  "html",
]);
/**
 * Of `HEAD_ALLOWED`, the elements whose CONTENT never ends the head: RCDATA
 * (`title`), raw text (`script`, `style`, `noframes`, and `noscript` with
 * scripting enabled), and `template`, whose content is a separate fragment.
 * htmlparser2 tokenizes `noscript`, `noframes` and `template` content as
 * markup, so a `<div>` inside one reaches `onopentag` and must be ignored.
 */
const HEAD_CONTAINERS = new Set(["title", "noscript", "noframes", "style", "script", "template"]);
/**
 * The start tags the "after head" insertion mode (§13.2.6.4.6) puts BACK into
 * the head: between `</head>` and `<body>` a canonical is still a head
 * element. `noscript` is not on this list — after `</head>` it opens the body.
 */
const AFTER_HEAD_REOPENS = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "noframes",
  "script",
  "style",
  "template",
  "title",
]);
/**
 * The HTML "body-ok" link types: a `<link>` whose `rel` tokens are all among
 * these may sit in a body, so it is no evidence the head was meant to continue
 * (ruling R8 (b), narrowing deviation 6). Any other token makes the link
 * head-only evidence.
 */
const BODY_OK_LINK_RELS = new Set([
  "stylesheet",
  "preload",
  "prefetch",
  "modulepreload",
  "pingback",
  "dns-prefetch",
  "preconnect",
  "prerender",
]);
/** Text that is not ASCII whitespace as HTML defines it (tab, LF, FF, CR, space). */
const NON_HTML_WHITESPACE = /[^\t\n\f\r ]/;
/** Tab, LF, FF, CR and space: ASCII whitespace as HTML defines it. */
const isHtmlWhitespace = (code: number) =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
/** Subtrees whose text is not visible content. */
const NON_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg"]);
/**
 * `<template>` is a fifth subtree whose text is not page text — its content is
 * in no rendered document — and it is tracked SEPARATELY from the four above
 * rather than added to them, which is the whole of the distinction this file
 * draws about it.
 *
 * `NON_CONTENT_TAGS` does two jobs: it suppresses text accumulation AND it is
 * read at element level (the `<title>`-inside-`<svg>` guard). A `<template>`
 * belongs in the first job and NOT the second. Its text is in no document, so
 * no word count may include it; but htmlparser2 emits its elements as ordinary
 * open tags, the DOM oracle's selectors match them (cheerio's parse5 tree puts
 * template children under a fragment that `$('h1')`, `$('a[href]')` and
 * `$('title')` all still reach), and every element-level extraction in this
 * file — heading counts, image counts, link rows, canonical, the document
 * title — has always counted them. WHETHER IT SHOULD is a real question and an
 * open one; it is not this task's question, and answering it by accident,
 * through a set membership, would have silently emptied three text captures:
 * the first `<h1>`'s text (`h1Text`, and first-h1-wins means a phantom
 * template heading would SHADOW the real one), every template anchor's text in
 * the persisted `links` rows, and the document title of a page whose `<title>`
 * sits inside a template. All three are on the parity surface and all three
 * would have diverged from the DOM oracle in one direction only.
 *
 * So: one counter, one job. Template text reaches the element captures exactly
 * as it did before Phase 7 and reaches neither word-count accumulator.
 */
const TEMPLATE_TAG = "template";
/**
 * The page furniture the main-content stream leaves out — in the fallback and
 * inside a `<main>` alike, because real themes put a `<footer>` in there (see
 * the module header's Phase 19 block). Four element names, and no
 * heuristics beside them: a `class="site-header"` div is chrome to a reader and
 * is not chrome to this file, because guessing from class names is a different
 * (and much less honest) instrument than reading the elements HTML defines for
 * the purpose.
 *
 * Tracked by ONE depth counter, on the `navDepth` idiom, and note that
 * `navDepth` and `footerDepth` stay where they are: those two count anchors for
 * CHECK-34 and are read at element level, this one gates a text accumulator.
 * Merging them would tie a link count to a word count.
 *
 * Exported so the parity oracle names the same four rather than a copy of them.
 */
export const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
/**
 * An inline `display:none`, matched against the `style` ATTRIBUTE STRING.
 *
 * Not a CSS parser and not a cascade: the whole hidden-surface rule this file
 * implements is markup-only (module header), and a robust match on the one
 * declaration that removes an element from the flow is as far as a tokenizer
 * can honestly go. `display : none !important` matches; `display:none` later
 * overridden inside the same attribute matches too, which is the rule's one
 * false-positive shape and is documented rather than guessed around.
 */
const DISPLAY_NONE = /display\s*:\s*none/i;
/**
 * Elements that do not break a word. Everything else — blocks, `<br>`, `<img>`,
 * list items, table cells — puts whitespace between the text on either side of
 * it, which is what a browser renders and what upstream's separator-less
 * concatenation got wrong. Shared with the parity oracle, which walks the DOM
 * by the same rule.
 */
export const INLINE_TEXT_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "data", "del", "dfn",
  "em", "font", "i", "ins", "kbd", "label", "mark", "nobr", "q", "rp", "rt",
  "ruby", "s", "samp", "small", "span", "strike", "strong", "sub", "sup",
  "time", "tt", "u", "var", "wbr",
]);
const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};
const MAX_ANCHOR_CHARS = 200;
/**
 * Cap on `h1Text`. An `<h1>` holding a page's whole first paragraph is a real
 * (if unfortunate) shape, and the column exists to be compared with a title —
 * 300 characters is five times the longest title any rule tolerates, so the cap
 * can only ever truncate text that was already past every question asked of it.
 */
const MAX_H1_TEXT_CHARS = 300;
/**
 * Per-page caps on the extracted collections. Crawler-trap and mega-menu pages
 * can carry thousands of links per page, and pages sit in memory in persist
 * batches — uncapped collections break the O(concurrency) memory contract.
 * Counts derived from these arrays saturate at the cap on such pages; the
 * scalar counters (images, headings) do not and stay exact.
 */
const MAX_EXTRACTED_LINKS = 2_000;
/**
 * The same cap on the same reasoning for `resourceRefs`, which sits in a persist
 * batch exactly as the links do. A gallery page with more than this many
 * distinct assets loses the tail of the list.
 *
 * THE TRUNCATION USED TO BE VISIBLE ONLY FOR IMAGES, and P12-T1 closed that.
 * `imagesTotal` does not saturate, so an image list cut short can be spotted
 * against it — but CSS and JS have NO counter beside them, so a page whose
 * stylesheets and scripts fell past the cap lost them silently. The page now
 * says so itself, on `PageAnalysis.resourceRefsCapped`, which `PageWriter`
 * counts and the crawl loop stamps onto `crawls.resource_refs_capped_pages`.
 * The count is a WRITER's counter rather than a query over the edge table for
 * the reason phase-11.md §10.1 measured: deriving it in SQL costs a scan of
 * every reference the crawl holds (73 ms over 500,000 edges, against a
 * `crawl_status` whose other reads are ≤ 3 ms).
 *
 * Exported so the suite pins the constant rather than a copy of its value
 * (the SOFT_404_PHRASES precedent).
 */
export const MAX_RESOURCE_REFS = 2_000;
/**
 * Social image refs kept per page (Phase 26b): one per JUDGED share image, the
 * first `og:image` and the first `twitter:image` — exactly what
 * `social.image-broken` reads. Open Graph allows `og:image` to repeat (a
 * gallery), but an alternate no rule judges would be a request spent against
 * somebody's server for nothing (final review I1), and it could crowd out the
 * twitter:image that is judged. The bound holds by construction (one ref per
 * tag); the constant names it. Exported so the suite pins the constant rather
 * than a copy of its value.
 */
export const MAX_SOCIAL_IMAGE_REFS = 2;
/** Where each social tag's first value lands in `SocialFacts`, and its cap. */
type SocialSlot =
  | { group: "og"; key: keyof SocialFacts["og"]; cap: number }
  | { group: "x"; key: keyof SocialFacts["x"]; cap: number };
/**
 * The closed list of social tags, keyed by the lower-cased tag name. A
 * `Record` over `SocialTag`, so a tag added to the union without a slot here
 * fails to compile rather than going silently unread.
 */
const SOCIAL_SLOTS: Record<SocialTag, SocialSlot> = {
  "og:title": { group: "og", key: "title", cap: SOCIAL_TEXT_MAX },
  "og:description": { group: "og", key: "description", cap: SOCIAL_TEXT_MAX },
  "og:image": { group: "og", key: "image", cap: SOCIAL_URL_MAX },
  "og:image:secure_url": { group: "og", key: "image:secure_url", cap: SOCIAL_URL_MAX },
  "og:url": { group: "og", key: "url", cap: SOCIAL_URL_MAX },
  "og:type": { group: "og", key: "type", cap: SOCIAL_TEXT_MAX },
  "og:site_name": { group: "og", key: "site_name", cap: SOCIAL_TEXT_MAX },
  "twitter:card": { group: "x", key: "card", cap: SOCIAL_TEXT_MAX },
  "twitter:title": { group: "x", key: "title", cap: SOCIAL_TEXT_MAX },
  "twitter:description": { group: "x", key: "description", cap: SOCIAL_TEXT_MAX },
  "twitter:image": { group: "x", key: "image", cap: SOCIAL_URL_MAX },
};
const isSocialTag = (value: string | undefined): value is SocialTag =>
  value !== undefined && Object.hasOwn(SOCIAL_SLOTS, value);
const ROBOTS_META_BOT_NAMES: ReadonlySet<string> = new Set(ROBOTS_META_BOTS);
const MAX_HEADING_ORDER = 500;
/** Exported (P26c-T6): fetch-page.ts caps the `Link` header's pairs at the same number. */
export const MAX_HREFLANG_PAIRS = 200;
const MAX_STRUCTURED_DATA_BLOCKS = 50;
/**
 * Per-block buffer cap for JSON-LD text, in characters. A block over this is
 * never buffered, never parsed, and counted as a failure — the alternative is
 * letting one page with a megabyte of embedded JSON set the crawl's memory
 * high-water mark. Kept blocks retain references into their parsed document,
 * so the worst case a page can hold is roughly this cap times the block cap.
 */
const MAX_LD_JSON_CHARS = 100_000;
/** How far into nested arrays / `@graph` the JSON-LD node walk will go. */
const MAX_LD_JSON_DEPTH = 5;
/**
 * The deepest array/object nesting a JSON-LD block may have (ruling R11). A
 * deeper block is refused as a parse error, before `JSON.parse` sees it: its
 * nodes would reach the writer's recursive storability walk and the driver's
 * `JSON.stringify` (both recursive), and real JSON-LD is a handful of levels
 * deep. Below `STORABLE_MAX_DEPTH` (storable-text.ts) by design.
 */
export const MAX_LD_JSON_NESTING = 64;
/**
 * Placeholder copy, matched against the visible text (never the raw HTML — a
 * lorem-ipsum string in a script or a CSS comment is not shipped copy).
 * The accumulator collapses whitespace, so the two words are always one space
 * apart here even when an element boundary separates them in the markup.
 */
const LOREM_IPSUM = /lorem ipsum/i;
/**
 * How much text `placeholderSnippet` quotes. 160 characters is a meta
 * description's own upper bound and about a sentence and a half of prose —
 * enough for a reader to recognise the sentence on the page and short enough to
 * sit in a finding's evidence beside the URL.
 */
const PLACEHOLDER_SNIPPET_CHARS = 160;

/**
 * The sentence `hasLoremIpsum` fired on, quoted out of the visible text.
 *
 * `text` is `bodyText`: already whitespace-collapsed and trimmed, so there is
 * no normalisation left to do and a match cannot straddle markup this never
 * sees. THE WINDOW STARTS AT THE MATCH — zero characters before it, up to 160
 * after — and is then pulled back to a whole word at the cut end, because a
 * snippet that ends mid-word reads as a corruption of the page rather than a
 * quotation from it. Shorter than the cap is the normal outcome; when the text
 * from the match to its end is shorter than the cap it is returned whole.
 *
 * Starting at the match is the point of the field. A window centred on it
 * spends half its budget on whatever precedes the placeholder, which on a real
 * page is the header, the currency picker and the cart — and the sentence the
 * reader was sent to find is cut off after a few words.
 *
 * The one guard: if trimming to a whole word would cut the match itself out of
 * the quotation — the match's own tail sitting inside a token longer than the
 * window — the untrimmed window is returned instead. A snippet that does not
 * contain what it is evidence for is worse than a ragged one.
 */
function placeholderSnippetOf(text: string): string | null {
  const match = LOREM_IPSUM.exec(text);
  if (match === null) return null;
  const from = text.slice(match.index);
  if (from.length <= PLACEHOLDER_SNIPPET_CHARS) return from.trim();
  const window = from.slice(0, PLACEHOLDER_SNIPPET_CHARS);
  // The far edge is the only cut one, so it is the only one that can hold half
  // a word; the near edge is the match itself.
  const tailCut = window.lastIndexOf(" ");
  const trimmed = (tailCut === -1 ? window : window.slice(0, tailCut)).trim();
  return LOREM_IPSUM.test(trimmed) ? trimmed : window.trim();
}
/**
 * The wording of a "not found" page, matched against the visible text on the
 * same terms as LOREM_IPSUM (never the raw HTML, and whitespace is already
 * collapsed, so a phrase split across an element boundary still matches).
 *
 * Phrases, never a bare "404": product codes, room numbers, years and error
 * *documentation* all contain it, and this flag feeds a rule that calls a
 * 200-status page broken. A false positive here is a false finding there, so
 * the list buys precision with the cost of missing a page whose only signal is
 * the number — which the template fingerprint in `notfound_probe_jsonb`
 * catches instead.
 *
 * Exported so the test suite pins the list itself rather than a sample of it.
 */
export const SOFT_404_PHRASES = [
  "page not found",
  "page cannot be found",
  "page can't be found",
  "404 error",
  "error 404",
  "404 not found",
  "no longer available",
  "nothing was found",
  "this page doesn't exist",
  "this page does not exist",
] as const;
/**
 * The phrase list as one alternation, LOREM_IPSUM's twin in form as well as in
 * use. Typographic apostrophes are folded into the character class: "this page
 * doesn’t exist" is the same sentence as "this page doesn't exist", and a list
 * that only knew the ASCII form would silently miss most real copy. The
 * phrases contain nothing else a regex reads specially.
 */
const SOFT_404_PATTERN = new RegExp(
  SOFT_404_PHRASES.map((phrase) => phrase.replace(/'/g, "['‘’]")).join("|"),
  "i",
);

/**
 * The client-rendered-framework tells, each one a thing that is in the HTML
 * because a framework put it there:
 *  - `__NEXT_DATA__` — Next.js' hydration payload, a `<script>` with that id.
 *    An id, so matched case-sensitively and verbatim.
 *  - `data-reactroot` — React's server-rendered root attribute.
 *  - `ng-app` — the AngularJS bootstrap attribute.
 * The last two are attributes on any element; htmlparser2 lowercases attribute
 * names, and both are already lowercase, so the `in attribs` test is exact.
 *
 * Exported so the test suite (and any consumer reading `frameworkMarkers`)
 * pins the list itself rather than a sample of it — the SOFT_404_PHRASES
 * precedent. The order here is the order the field reports.
 */
export const FRAMEWORK_MARKERS = ["__NEXT_DATA__", "data-reactroot", "ng-app"] as const;

interface OpenAnchor {
  href: string;
  rel: string | null;
  ariaLabel: string | null;
  text: string[];
  // ---- Phase 26c: the wider name's candidates, each read as `ariaLabelOf` ----
  /** The `<a>`'s own `aria-labelledby` (the id list) and `title`. */
  labelledBy: string | null;
  title: string | null;
  /** The first non-blank `aria-label` on an element opened inside the link. */
  innerAriaLabel: string | null;
  /** `<svg>` elements open inside the link: a `<title>` is read only under one. */
  svgDepth: number;
  /** The text of the `<svg><title>` being read; null while none is open. */
  svgTitleParts: string[] | null;
  /** The first `<svg><title>` whose text is not blank, collapsed and capped. */
  svgTitle: string | null;
}

/** An `aria-label` as `PageLink.ariaLabel` stores it: trimmed, capped, null when blank. */
function ariaLabelOf(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? null : storableCap(trimmed, ARIA_LABEL_MAX);
}

/** The winning wider name of a closed anchor (Phase 26c; `PageLink.nameHint`). */
function nameHintOf(
  anchor: OpenAnchor,
): { nameHint: string | null; nameHintSource: NameHintSource | null } {
  if (anchor.labelledBy !== null) {
    return { nameHint: anchor.labelledBy, nameHintSource: "aria-labelledby" };
  }
  if (anchor.innerAriaLabel !== null) {
    return { nameHint: anchor.innerAriaLabel, nameHintSource: "inner-aria-label" };
  }
  if (anchor.svgTitle !== null) return { nameHint: anchor.svgTitle, nameHintSource: "svg-title" };
  if (anchor.title !== null) return { nameHint: anchor.title, nameHintSource: "title" };
  return { nameHint: null, nameHintSource: null };
}

/**
 * The deepest `{` / `[` nesting in a JSON text, read without parsing it and
 * without recursion: one pass, string literals (and their escapes) skipped.
 * The text may not be valid JSON; `JSON.parse` decides that afterwards. Ruling
 * R11 refuses a block deeper than `MAX_LD_JSON_NESTING`.
 */
function jsonNestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1; // backslash: skip the escaped unit
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > max) max = depth;
    } else if (c === 0x7d || c === 0x5d) {
      depth -= 1;
    }
  }
  return max;
}

/**
 * Flatten a parsed JSON-LD document into its nodes: arrays and `@graph`
 * containers expand to one entry per node. A container that is itself typed
 * (`{"@type":…,"@graph":[…]}`) counts as a node too.
 */
function collectLdJsonNodes(value: unknown, out: unknown[], depth: number): void {
  if (depth > MAX_LD_JSON_DEPTH || out.length >= MAX_STRUCTURED_DATA_BLOCKS) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectLdJsonNodes(entry, out, depth + 1);
    return;
  }
  // Scalars and null are not JSON-LD nodes: valid JSON, nothing to record.
  if (typeof value !== "object" || value === null) return;
  const node = value as Record<string, unknown>;
  const graph = node["@graph"];
  if (graph !== undefined) {
    if ("@type" in node) out.push(node);
    collectLdJsonNodes(graph, out, depth + 1);
    return;
  }
  out.push(value);
}

/**
 * The FIRST candidate URL of a `srcset`, or undefined when there is none.
 *
 * The HTML spec's srcset parser, reduced to its first iteration: skip leading
 * whitespace and commas, collect characters up to the next whitespace, then
 * remove any trailing commas (which the spec calls a parse error and still
 * accepts). Splitting the attribute on commas instead would be wrong for every
 * URL that contains one — `/i/w_100,h_200/a.png` is one file, not two — and a
 * URL can never contain unescaped whitespace, so the whitespace split is exact.
 *
 * Why only the first: see the module header's Phase 11 block. A candidate list
 * is renditions of one image, and asking a client's CDN for all of them would
 * multiply the request count for an answer nobody wants.
 */
function firstSrcsetCandidate(srcset: string): string | undefined {
  const rest = srcset.replace(/^[\s,]+/, "");
  if (rest === "") return undefined;
  const token = rest.split(/\s+/, 1)[0] ?? "";
  const url = token.replace(/,+$/, "");
  return url === "" ? undefined : url;
}

/** `@type` of a JSON-LD node — first entry when it is an array. */
function ldJsonType(node: unknown): string {
  if (typeof node !== "object" || node === null) return "unknown";
  const type = (node as Record<string, unknown>)["@type"];
  if (typeof type === "string" && type.trim() !== "") return type;
  if (Array.isArray(type)) {
    const first = type.find(
      (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
    );
    if (first !== undefined) return first;
  }
  return "unknown";
}

/**
 * Analyze an HTML string and extract every SEO-relevant signal the tokenizer
 * can see. Prefer `analyzePage`; this is the wide result the parity suite
 * compares against a DOM oracle and that Task 6 will widen the facade onto.
 *
 * Deliberately NOT a DOM parser: a DOM costs ~5-10x the HTML's size per page
 * and, at crawl concurrency, is the dominant OOM cause. The tokenizer keeps
 * only the accumulated text and the extracted fields in memory.
 */
export function analyzeHtml(html: string, pageUrl: string): RawPageAnalysis {
  // The page's own origin, for `unsafeBlank`'s cross-origin test (O2). An
  // invalid page URL throws here, loudly: every caller hands a fetched URL.
  const pageOrigin = new URL(pageUrl).origin;
  // Upstream accumulated the title into a `string | null`; the parts array
  // plus a sawTitle flag says the same thing without the += churn, and keeps
  // "present but empty" distinguishable from "absent".
  const titleParts: string[] = [];
  let sawTitle = false;
  let titleDepth = 0;
  let titleDone = false;
  // parse5 (the old DOM path) treats <noscript> content as raw text when
  // scripting is enabled; skip element extraction inside it to match.
  let noscriptDepth = 0;
  // `undefined` = the element was never seen, so the next one is the first and
  // wins; `null` = seen without a usable attribute.
  let metaDescription: string | null | undefined;
  let canonical: string | null | undefined;
  let ogTitle: string | null | undefined;
  let ogDescription: string | null | undefined;
  let ogImage: string | null | undefined;
  let canonicalCount = 0;
  let hasStructuredData = false;
  let hasAmp = false;
  let hasViewport = false;
  const hreflangTags: string[] = [];
  let relNext: string | null | undefined;
  let relPrev: string | null | undefined;
  const hreflang: HreflangPair[] = [];
  let domSize = 0;

  // PHASE 26b HEAD FACTS (module header). Every one is O(1) in page size: a
  // fixed number of capped strings, or a counter.
  // `undefined` = no `<html>` start tag seen yet, the first-element sentinel.
  let htmlLang: string | null | undefined;
  let titleCount = 0;
  let metaDescriptionCount = 0;
  // Every `<meta name=robots>` content, joined at the end (deviation 4). The
  // list is O(page) in principle, as the hreflang codes are; robots metas are
  // a handful on any real page.
  const robotsContents: string[] = [];
  // The trimmed contents already in `robotsContents` (ruling R6's dedupe).
  const robotsSeen = new Set<string>();
  let sawRobotsMeta = false;
  const robotsMetas: RobotsMetaEntry[] = [];
  let metaRefresh: RefreshFact | undefined;
  // The social set. `socialFirst` holds each tag's first TRIMMED value
  // UNCAPPED while the parse runs — at most ten strings the tokenizer already
  // allocated — so a later value that differs only past the cap is still
  // seen to conflict; the caps are applied once, at the end.
  const socialFirst = new Map<SocialTag, string>();
  const socialCounts = new Map<SocialTag, number>();
  const socialConflicting = new Set<SocialTag>();
  let socialOutsideHead = false;
  let xViaProperty = false;
  // The judged share images' refs (`shareImageRef` of each tag's FIRST value,
  // whole, never capped), set when that first value is met; null while the tag
  // is unseen, which is also what an absent tag stores.
  const socialImageRef: SocialFacts["imageRefs"] = { og: null, x: null };
  // Phase 26c: set beside the ref, from the same `shareImage` call.
  const socialImageRefTooLong: SocialFacts["imageRefTooLong"] = { og: false, x: false };

  // JSON-LD is buffered one block at a time: the tokenizer hands its text over
  // in pieces, and only the closing </script> says the block is complete.
  const structuredData: StructuredDataBlock[] = [];
  let structuredDataParseErrors = 0;
  let inLdJson = false;
  let ldJsonParts: string[] = [];
  let ldJsonChars = 0;
  let ldJsonOversize = false;

  const h1s: string[] = [];
  const headingOrder: number[] = [];
  const headingCounts = [0, 0, 0, 0, 0, 0];
  let openH1: string[] | null = null;
  // The first `<h2>` only (Phase 26b), on `openH1`'s footing: opened by the
  // heading block below, fed by `ontext` under the same gates, closed on
  // `</h2>`. `h2Done` retires it so a second h2 is never captured.
  let openH2: string[] | null = null;
  let h2Done = false;
  let h2Text: string | null = null;

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let imagesMissingDimensions = 0;
  const linksByTarget = new Map<string, RawPageLink>();
  let openAnchor: OpenAnchor | null = null;

  // PHASE 26b BODY FACTS (T3; module header). Counters, plus two samples
  // capped at ten entries each: O(1) in page size.
  const anchorCounts: AnchorCounts = {
    noHref: 0,
    javascript: 0,
    hashOnly: 0,
    emptyHref: 0,
    unsafeBlank: 0,
  };
  let relNextCount = 0;
  let relPrevCount = 0;
  let imagesEmptyAlt = 0;
  let imagesAltTooLong = 0;
  const imagesMissingAltSample: string[] = [];
  const insecureRefs: InsecureRefs = { iframe: 0, media: 0, formAction: 0, forms: 0, sample: [] };
  // Open `<video>` / `<audio>` elements: a `<source>` is a media reference only
  // inside one, told apart without a tree on `pictureDepth`'s idiom.
  let mediaDepth = 0;
  // The sample is capped PER KIND, so one kind filling its share never leaves
  // a counted kind with no sample; each kind's count is its counter's value.
  const noteInsecure = (kind: InsecureRefKind, raw: string | undefined) => {
    if (raw === undefined) return;
    const resolved = normalizeUrl(raw, pageUrl);
    if (resolved === null || !resolved.startsWith("http:")) return;
    let counted: number;
    if (kind === "iframe") counted = ++insecureRefs.iframe;
    else if (kind === "media") counted = ++insecureRefs.media;
    else counted = ++insecureRefs.formAction;
    if (counted <= INSECURE_SAMPLE_MAX) {
      insecureRefs.sample.push({ kind, url: storableCap(resolved, INSECURE_SAMPLE_URL_MAX) });
    }
  };
  /** One `<a>` start tag into `anchorCounts` (definitions in the module header). */
  const countAnchor = (attribs: Record<string, string>) => {
    const href = attribs["href"];
    if (href === undefined) {
      // Deviation 5: a bookmark (`<a name>`, `<a id>`) is not a link. Only an
      // href-less anchor that behaves like one is counted.
      const role = attribs["role"]?.trim().toLowerCase();
      if ("onclick" in attribs || role === "link" || role === "button") {
        anchorCounts.noHref += 1;
      }
      return;
    }
    const trimmed = href.trim();
    const isJavascript = /^\s*javascript:/i.test(href);
    if (trimmed === "") anchorCounts.emptyHref += 1;
    else if (isJavascript) anchorCounts.javascript += 1;
    else if (trimmed === "#" || trimmed === "#!") anchorCounts.hashOnly += 1;
    if (attribs["target"]?.trim().toLowerCase() === "_blank" && !isJavascript) {
      const rel = (attribs["rel"] ?? "").trim().toLowerCase().split(/\s+/);
      if (!rel.includes("noopener") && !rel.includes("noreferrer") && isCrossOrigin(href)) {
        anchorCounts.unsafeBlank += 1;
      }
    }
  };
  /**
   * Owner call O2 (2026-11-07): whether `href` resolves to an origin other than
   * the page's. Exact `URL.origin` comparison, NOT `isSameOrigin`: a subdomain
   * and a `www.` variant are other origins to the browser, and reverse
   * tabnabbing is a browser question. An href `normalizeUrl` refuses is false.
   */
  const isCrossOrigin = (href: string): boolean => {
    const resolved = normalizeUrl(href, pageUrl);
    return resolved !== null && new URL(resolved).origin !== pageOrigin;
  };

  // The page's resource references, keyed by resolved URL so one page says one
  // thing about one file. O(page) and capped, like `linksByTarget` — the
  // crawl-wide dedup is the `resources` table's unique index and never a set
  // here (hard rule 6). `<source>` is only a resource site inside a `<picture>`,
  // which the depth counter answers on the `navDepth` idiom.
  const resourceRefs = new Map<string, ResourceRef>();
  // Raised the first time the cap turns a reference away. The check below stays
  // where it is — BEFORE the resolve — because that is what keeps a mega-gallery
  // page from paying a URL parse per reference past the cap, and the flag is
  // worded for exactly that: a reference dropped unexamined, which is all this
  // position can honestly claim. See `PageAnalysis.resourceRefsCapped`.
  let resourceRefsCapped = false;
  // Phase 26c: references refused for being over `INDEXED_URL_MAX`, per kind.
  // Each refusal takes a slot under its kind's cap, as a kept reference does,
  // so a page of refused URLs cannot make the pass resolve without bound.
  let overlongLinks = 0;
  let overlongResources = 0;
  let overlongHreflang = 0;
  let pictureDepth = 0;
  const addResource = (raw: string | undefined, kind: ResourceKind) => {
    if (raw === undefined) return;
    const value = raw.trim();
    // Before the cap check, deliberately: a `data:` URI or a `javascript:` href
    // is not a resource at all, so turning one away is not a truncation.
    if (value === "" || SKIPPED_RESOURCE_PROTOCOLS.test(value)) return;
    if (resourceRefs.size + overlongResources >= MAX_RESOURCE_REFS) {
      resourceRefsCapped = true;
      return;
    }
    const resolved = normalizeUrl(value, pageUrl);
    if (resolved === null) return;
    // Phase 26c: no `resources` row can hold it; counted, never stored.
    if (!fitsIndex(resolved)) {
      overlongResources += 1;
      return;
    }
    // First kind wins, as the first anchor wins for a link target: one URL
    // referenced as both a script and an image is one file, and its kind is
    // whichever the document named first.
    if (resourceRefs.has(resolved)) return;
    resourceRefs.set(resolved, { url: resolved, kind });
  };

  // `nav a[href]` / `footer a[href]`, counted with depth counters the way
  // `titleDepth` is: incremented on the open tag, decremented on the close,
  // and an anchor counted while a counter is positive. Depths rather than
  // booleans because the containers nest — a <nav> inside a <nav> that closes
  // must not take the outer one down with it — and the decrements are guarded
  // so a stray close tag (a real thing in real HTML) cannot drive a counter
  // negative and silence every anchor after it. htmlparser2 emits the implied
  // close of an open <nav> when a `</footer>` pops it, which is what the HTML
  // parsing spec does too, so malformed nesting lands where a browser puts it.
  let navDepth = 0;
  let footerDepth = 0;
  let navLinkCount = 0;
  let footerLinkCount = 0;

  // Which of FRAMEWORK_MARKERS the document carried. A set of at most three
  // short strings, so it costs nothing against the memory contract, and it
  // keeps the marker's name in one place — the constant — rather than in a
  // boolean whose mapping back to a name has to be maintained.
  const markersSeen = new Set<string>();

  // Visible text: prefer text inside an explicit <body>; when the document
  // never opens one (fragments), fall back to all non-head text. Both
  // exclude NON_CONTENT_TAGS subtrees, and both exclude `<template>` content —
  // which is counted by `templateDepth` rather than by `suppressDepth`, so that
  // it reaches the element captures the way it always has. See TEMPLATE_TAG.
  let suppressDepth = 0;
  let templateDepth = 0;
  let bodyDepth = 0;
  let headDepth = 0;
  let sawBody = false;
  const bodyParts: string[] = [];
  const fallbackParts: string[] = [];

  // The renderable stream: the same two accumulators, minus the text inside
  // markup-hidden elements. Element boundaries are emitted into BOTH streams
  // identically — the two differ in which text nodes reach them and in nothing
  // else — which is what makes `renderableWordCount <= wordCount` a property
  // rather than a hope: dropping text can merge two words, never split one.
  //
  // MEMORY. These arrays hold references to the very same strings the body
  // accumulators hold, not copies of them, so the cost of the second stream is
  // one pointer per text node and one transient join at the end. O(page), like
  // the first stream, so the memory contract is untouched.
  const renderableBodyParts: string[] = [];
  const renderableFallbackParts: string[] = [];

  // THE TWO MAIN-CONTENT CANDIDATES (P19-T1), accumulated together and chosen
  // between at the end of the parse — which is the only place the choice can be
  // made, since "this document has no <main>" is not knowable until it ends.
  //  - `main*Parts` take the text inside the first `<main>` MINUS the
  //    CHROME_TAGS subtrees within it — themes put a `<footer>` in there and it
  //    is furniture wherever it sits (module header, Phase 19).
  //  - `content*Parts` take the body's text minus the same CHROME_TAGS
  //    subtrees, for the document that declares no `<main>` at all.
  // Both mirror the body/fallback split above for the same reason it exists —
  // a fragment with no `<body>` must be measured on the same terms by every
  // stream or the four numbers would not be about one text. Like the renderable
  // pair, these hold references to the strings the body accumulator already
  // holds: one pointer per text node, so O(page) and the memory contract is
  // untouched.
  const mainBodyParts: string[] = [];
  const mainFallbackParts: string[] = [];
  const contentBodyParts: string[] = [];
  const contentFallbackParts: string[] = [];
  // The chosen `<main>`, identified by the `elementDepth` it opened at rather
  // than by a counter, exactly as `hiddenOpenedAt` identifies a hidden element:
  // a nested `<main>` (invalid HTML, and real) closes at a deeper depth and so
  // cannot end the outer one, and a stray `</main>` matches nothing.
  //
  // FIRST-MAIN-WINS, and "first" means the first one the DOM oracle's text walk
  // would reach: `mainOpenedAt` is only ever set from inside the switch below,
  // which `noscript` returns before, and only when no suppressed subtree
  // (`<script>`, `<style>`, `<svg>`) and no `<template>` is open. A `<main>` in
  // any of those is in no rendered document, contributes no text on either
  // side, and must not shadow the real one. `mainSeen` is the flag the
  // end-of-parse choice reads; `mainDone` retires the first main so a second
  // sibling `<main>` is not appended to it.
  let mainOpenedAt: number | null = null;
  let mainSeen = false;
  let mainDone = false;
  // The chrome depth the chosen `<main>` opened AT, so the main stream's gate
  // is "no chrome has opened since", not "no chrome is open". The oracle starts
  // its walk at the `<main>` element itself and so never sees the chrome
  // ENCLOSING it — a `<main>` inside a `<footer>` is malformed, and real, and
  // its text is still that page's main content on both sides. Only the chrome
  // the walk would meet on its way DOWN is excluded.
  let chromeDepthAtMain = 0;
  // Chrome subtrees, one counter over the four names (see CHROME_TAGS).
  // Incremented and decremented on the tag name alone — never on a condition —
  // so the counter cannot drift when the element sits inside a suppressed or
  // template subtree, which is what a text gate must never do.
  let chromeDepth = 0;
  // Markup-hidden tracking, on the `titleDepth` / `navDepth` idiom and for the
  // same reasons — containers nest, and malformed markup must not be able to
  // silence the rest of the document. Two of the three are STACKS OF ELEMENT
  // DEPTHS rather than plain counters, because unlike `<nav>` the condition is
  // not readable from the closing tag: `onclosetag` is handed a name and no
  // attributes, so "was the element that is closing the one that was hidden?"
  // has to be answered by the depth it opened at.
  //
  // `elementDepth` counts every open tag and every close tag htmlparser2 emits,
  // including the implied closes it synthesises (a `<p>` closed by the next
  // `<p>`, everything still open at EOF) and the immediate close of a void
  // element. A stray `</div>` with no open `<div>` produces no event at all, so
  // the counter stays balanced; the guard below is belt and braces.
  let elementDepth = 0;
  const hiddenOpenedAt: number[] = [];
  const closedDetailsOpenedAt: number[] = [];
  // A `<summary>` is the ONE thing a closed `<details>` still renders, so it is
  // un-hidden inside one. A name counter is enough here (the tag identifies
  // itself on the way out) and it deliberately does not check that the summary
  // is the details' own first child, which is the only shape a browser
  // actually renders: a `<summary>` buried deeper inside a closed `<details>`
  // is counted here and hidden there. That direction over-counts renderable
  // text, which is the safe direction for a floor.
  let summaryDepth = 0;
  /** Is text arriving now inside markup that says it is not displayed? */
  const renderableHidden = (): boolean =>
    hiddenOpenedAt.length > 0 ||
    (closedDetailsOpenedAt.length > 0 && summaryDepth === 0);
  /**
   * Does this element's own markup say it is not displayed? Attributes only —
   * `hidden` in any form (including `hidden="until-found"`, which a browser
   * does reveal on find; treating it as hidden keeps the rule to one question
   * about one attribute), an inline `display:none`, and a `<dialog>` that is
   * not `open`. `<details>` is handled separately: it hides all of itself
   * except its summary, which is not a thing this predicate can express.
   */
  const markupHidden = (name: string, attribs: Record<string, string>): boolean => {
    if ("hidden" in attribs) return true;
    const style = attribs["style"];
    if (style !== undefined && DISPLAY_NONE.test(style)) return true;
    return name === "dialog" && !("open" in attribs);
  };

  // WHERE THE HEAD ENDS (Phase 23 T5; module header). Three modes, named for
  // the tree builder's insertion modes they stand in for: "head" covers
  // "initial", "before html", "before head" and "in head" (the head is open,
  // implicitly or not, from the first byte); "afterHead" is "after head",
  // entered by an explicit `</head>`; "body" is everything after. The machine
  // only ever moves forward — a second `<head>` is ignored by the tree builder
  // and here alike. `headContainerDepth` counts the HEAD_CONTAINERS open while
  // the head is, so a `<div>` in a `<noscript>` or a `<template>` is not read
  // as ending it.
  let headMode: "head" | "afterHead" | "body" = "head";
  let headClosedBy: string | null = null;
  let headContainerDepth = 0;
  let titleOutsideHead = false;
  let metaDescriptionOutsideHead = false;
  let robotsOutsideHead = false;
  let canonicalOutsideHead = false;
  let hreflangOutsideHeadCount = 0;
  // A decoder strips a leading byte-order mark before any parser sees the text
  // (fetch's TextDecoder does); this is for callers who hand over a raw string.
  // It can only sit in the first text event, which it necessarily is.
  let bomPending = html.charCodeAt(0) === 0xfeff;

  // HTML STRUCTURE (Phase 26b T4; module header). Scalars only: three counters,
  // the first of head/body, and one candidate whose snippet is capped when it
  // is taken, so the state is O(1) in page size whatever the document holds.
  let htmlTags = 0;
  let headTags = 0;
  let bodyTags = 0;
  let firstOfHeadBody: "head" | "body" | null = null;
  // The first closed-early candidate (deviation 6), and whether a later token
  // confirmed the head was meant to go on (narrowed by ruling R8). Read
  // together at the end.
  let earlyCandidate: Omit<NonNullable<HtmlStructure["closedEarly"]>, "lost"> | null = null;
  let earlyConfirmed = false;
  // Owner call O3: the head tags after the candidate that an early close moves
  // into the body, deduped and capped at HEAD_LOST_MAX (O(1)), collected until
  // the first explicit `<body>` (after it, a tag is in the body whatever closed
  // the head). Read with the candidate at the end.
  const earlyLost: string[] = [];
  let earlyLostDone = false;
  // Open `<svg>` elements, so an svg `<title>` is not read as head evidence
  // (R8). Its own counter: `suppressDepth` also counts script/style/noscript.
  let structureSvgDepth = 0;
  // A `<noscript>` opened in head mode with no other container around it is
  // open. Its children are invisible to the head machine (they ride
  // `headContainerDepth`) and STAY invisible to it; this flag only lets the
  // candidate see them.
  let inHeadNoscript = false;
  const takeCandidate = (tag: string, snippet: string, inNoscript: boolean) => {
    if (earlyCandidate !== null) return;
    earlyCandidate = { tag, snippet, inNoscript };
  };
  /** The confirmed candidate with what it loses (O3), or null. Read once, at the end. */
  const closedEarlyFact = (): HtmlStructure["closedEarly"] =>
    earlyConfirmed && earlyCandidate !== null ? { ...earlyCandidate, lost: [...earlyLost] } : null;
  /**
   * The current start tag's source, made storable and cut at the cap. The
   * slice takes one unit past the cap so a cut through a surrogate pair is
   * seen and the whole pair dropped; the copy stays O(cap).
   */
  const tagSnippet = (start: number, end: number) =>
    storableCap(html.slice(start, Math.min(end + 1, start + HEAD_SNIPPET_MAX + 1)), HEAD_SNIPPET_MAX);

  const headOnOpenTag = (name: string, isImplied: boolean, start: number, end: number) => {
    if (headMode === "body") return;
    if (headContainerDepth > 0) {
      // A non-head child of a head `<noscript>` is a candidate (deviation 6),
      // read here without touching the machine: it stays suspended. RULING
      // R12b: the test is `HEAD_ALLOWED`, the same as outside the noscript.
      // With scripting off, the "in head noscript" insertion mode keeps
      // `link`/`meta`/`style`/`noframes`/`basefont`/`bgsound` in the head. It
      // pops the noscript for any other head tag (`title`, `base`, `script`,
      // `template`) and reprocesses that tag in the head, and it ignores
      // `head`/`noscript`. None of these closes the head, so only a tag the
      // head cannot hold is a candidate. Only the noscript's OWN content is
      // read (`headContainerDepth === 1`). Inside a nested container, a
      // `<template>`'s fragment or a `<noframes>`' raw text, nothing is in the
      // head at all. The stray-`</p>` exemption below applies here too.
      if (
        inHeadNoscript &&
        headContainerDepth === 1 &&
        !(isImplied && name === "p") &&
        !HEAD_ALLOWED.has(name)
      ) {
        takeCandidate(name, tagSnippet(start, end), true);
      }
      if (HEAD_CONTAINERS.has(name)) headContainerDepth += 1;
      return;
    }
    // A stray `</p>` reaches us as an implied `<p></p>` pair; the tree builder
    // ignores that end tag in both head modes. (A stray `</br>` is the other
    // implied open htmlparser2 synthesises, and the tree builder does read it
    // as a `<br>` — which ends the head — so it falls through.)
    if (isImplied && name === "p") return;
    if (headMode === "head") {
      if (HEAD_ALLOWED.has(name)) {
        if (HEAD_CONTAINERS.has(name)) headContainerDepth += 1;
        if (name === "noscript") inHeadNoscript = true;
        return;
      }
      headClosedBy = name;
      headMode = "body";
      // `<body>` is where a head is meant to end, so it is never an early
      // close; every other tag that ends the head here is a candidate.
      if (name !== "body") takeCandidate(name, tagSnippet(start, end), false);
      return;
    }
    // "after head": `<html>` merges into the root and a second `<head>` is
    // ignored; the head elements go back into the head; anything else, and
    // `<body>` itself, opens the body.
    if (name === "html" || name === "head") return;
    if (AFTER_HEAD_REOPENS.has(name)) {
      if (HEAD_CONTAINERS.has(name)) headContainerDepth += 1;
      return;
    }
    headMode = "body";
  };
  const headOnCloseTag = (name: string, isImplied: boolean) => {
    if (headMode === "body") return;
    if (headContainerDepth > 0) {
      if (HEAD_CONTAINERS.has(name)) headContainerDepth -= 1;
      if (headContainerDepth === 0) inHeadNoscript = false;
      return;
    }
    // Implied closes are htmlparser2's tree repair (it closes the head itself
    // when `<body>` opens, and everything at EOF), not markup: the element that
    // caused them is read on its own event.
    if (isImplied) return;
    if (name === "head" && headMode === "head") {
      headMode = "afterHead";
    } else if (name === "html" || name === "body") {
      // `</html>` (and `</body>`) act as "anything else" in both head modes.
      if (headMode === "head") headClosedBy = `</${name}>`;
      headMode = "body";
    }
  };
  const headOnText = (text: string) => {
    let probe = text;
    if (bomPending) {
      bomPending = false;
      probe = text.slice(1);
    }
    if (headMode === "body" || headContainerDepth > 0) return;
    if (!NON_HTML_WHITESPACE.test(probe)) return;
    if (headMode === "head") {
      headClosedBy = "#text";
      // Trimmed of HTML whitespace only, so the text that made it a candidate
      // (a non-breaking space included) is what the snippet shows. Linear by
      // construction: one forward search for the first non-whitespace unit,
      // one backward scan for the last, and a slice of at most the cap plus
      // one unit (so a pair straddling the cap is seen and dropped whole).
      // Never a trimming regex: `[ws]+$` backtracks quadratically on a long
      // inner whitespace run (review C1).
      const start = probe.search(NON_HTML_WHITESPACE);
      let end = probe.length;
      while (end > start && isHtmlWhitespace(probe.charCodeAt(end - 1))) end -= 1;
      takeCandidate(
        "#text",
        storableCap(probe.slice(start, Math.min(end, start + HEAD_SNIPPET_MAX + 1)), HEAD_SNIPPET_MAX),
        false,
      );
    }
    headMode = "body";
  };
  /**
   * The counts, the order, and the evidence that confirms a candidate, read
   * from every explicit start tag BEFORE the head machine sees it, so the
   * token that becomes the candidate can never confirm itself.
   */
  const structureOnOpenTag = (
    name: string,
    attribs: Record<string, string>,
    isImplied: boolean,
  ) => {
    if (isImplied) return;
    if (name === "html") htmlTags += 1;
    else if (name === "head") headTags += 1;
    else if (name === "body") bodyTags += 1;
    if ((name === "head" || name === "body") && firstOfHeadBody === null) firstOfHeadBody = name;
    // Template content is never in the head (or the body): a tag inside a
    // `<template>` neither shows the head was meant to go on nor is lost by an
    // early close. `templateDepth` counts this tag's own `<template>` only after
    // this call, so the template element itself is judged as a tag.
    if (
      earlyCandidate !== null &&
      !earlyConfirmed &&
      templateDepth === 0 &&
      isHeadEvidence(name, attribs)
    ) {
      earlyConfirmed = true;
    }
    if (earlyCandidate !== null && !earlyLostDone && templateDepth === 0) {
      if (name === "body") {
        earlyLostDone = true;
      } else {
        const lost = headOnlyTag(name, attribs);
        if (lost !== null && earlyLost.length < HEAD_LOST_MAX && !earlyLost.includes(lost)) {
          earlyLost.push(lost);
        }
      }
    }
    if (name === "svg") structureSvgDepth += 1;
  };
  /**
   * Ruling R8 (b): the start tags that only belong in a head, and so show a
   * head that was meant to go on. Everything a body may legitimately hold
   * (a microdata `<meta itemprop>`, a stylesheet or preload `<link>`, a
   * `<style>`, an svg `<title>`) is not evidence.
   */
  const isHeadEvidence = (name: string, attribs: Record<string, string>): boolean =>
    name === "body" || headOnlyTag(name, attribs) !== null;
  /**
   * The head-only start tags of ruling R8 (b), named as `closedEarly.lost`
   * records them (owner call O3): `base`, `title` outside `<svg>`, `meta`
   * without `itemprop`, and `link rel=<first token that is not body-ok>`. Null
   * for everything a body may hold, `<body>` included: it is evidence (see
   * `isHeadEvidence`) but never a lost tag. The token is page text, so it is
   * made storable and the entry cut at `HEAD_SNIPPET_MAX`.
   */
  const headOnlyTag = (name: string, attribs: Record<string, string>): string | null => {
    switch (name) {
      case "base":
        return "base";
      case "title":
        return structureSvgDepth === 0 ? "title" : null;
      case "meta":
        return "itemprop" in attribs ? null : "meta";
      case "link": {
        // No `rel`, or a blank one, is body-ok.
        const rel = attribs["rel"];
        if (rel === undefined) return null;
        const token = rel
          .toLowerCase()
          .split(/[\t\n\f\r ]+/)
          .find((t) => t !== "" && !BODY_OK_LINK_RELS.has(t));
        return token === undefined ? null : storableCap(`link rel=${token}`, HEAD_SNIPPET_MAX);
      }
      default:
        return null;
    }
  };
  /**
   * An ORPHAN `</head>` (no `<head>` open) is never evidence here: htmlparser2
   * drops an end tag whose element is not open, so no event arrives. For
   * example, `<title>t</title><div>x</div></head>` reports null. This is the
   * Phase 23 known limit again, here as a rare false negative.
   */
  const structureOnCloseTag = (name: string, isImplied: boolean) => {
    // Implied or not: an svg htmlparser2 closes at its parent's end is closed.
    if (name === "svg" && structureSvgDepth > 0) structureSvgDepth -= 1;
    if (!isImplied && name === "head" && earlyCandidate !== null) earlyConfirmed = true;
  };

  /**
   * The social tags one element names (Phase 26b). Open Graph is read from
   * `property=` or `name=` (both are in the wild); X from `name=`, or from
   * `property=`, which X does not read and so is recorded as `xViaProperty`.
   * Each DISTINCT tag the element names is recorded once (ruling R6):
   * `<meta name=twitter:title property=og:title>` is both og:title and
   * twitter:title, while `<meta name=og:title property=og:title>` is og:title
   * once.
   */
  const handleSocialTag = (
    name: string | undefined,
    property: string | undefined,
    content: string | undefined,
  ) => {
    if (isSocialTag(property)) {
      // Named by `name=` as well, a twitter tag is where X reads it.
      if (property.startsWith("twitter:") && name !== property) xViaProperty = true;
      recordSocialTag(property, content);
    }
    if (isSocialTag(name) && name !== property) recordSocialTag(name, content);
  };

  const recordSocialTag = (tag: SocialTag, content: string | undefined) => {
    if (headMode === "body") socialOutsideHead = true;
    socialCounts.set(tag, (socialCounts.get(tag) ?? 0) + 1);
    // A tag with no `content` is present and empty, as a `<meta
    // name=description>` without one is.
    const value = content?.trim() ?? "";
    const first = socialFirst.get(tag);
    if (first === undefined) {
      socialFirst.set(tag, value);
      // The legacy og columns read the element the social set reads: the
      // first whose `property` OR `name` is the tag, the value untrimmed as
      // the columns always stored it, null when there is no `content`
      // (PR #23 review; the module header's Phase 26b block).
      if (tag === "og:title") ogTitle = content ?? null;
      if (tag === "og:description") ogDescription = content ?? null;
      if (tag === "og:image") ogImage = content ?? null;
      // Only the FIRST value of each image tag is judged, so only it is
      // resolved: into a slot of its own, never a resource ref (deviation 3,
      // and the header).
      if (tag === "og:image") {
        ({ ref: socialImageRef.og, tooLong: socialImageRefTooLong.og } = shareImage(value, pageUrl));
      }
      if (tag === "twitter:image") {
        ({ ref: socialImageRef.x, tooLong: socialImageRefTooLong.x } = shareImage(value, pageUrl));
      }
    } else if (first !== value) socialConflicting.add(tag);
  };

  const handleMetaTag = (attribs: Record<string, string>) => {
    const content = attribs["content"];
    const name = attribs["name"]?.trim().toLowerCase();
    const property = attribs["property"]?.trim().toLowerCase();
    // Phase 26b: the social set and the refresh are read beside the chain
    // below, never inside it — an element carrying `name=description` and
    // `property=og:description` is both, and the chain's first match must not
    // hide the second.
    handleSocialTag(name, property, content);
    // The refresh a browser acts on (HTML Standard, meta refresh): an empty
    // `content` returns before the steps, and a value the steps refuse leaves
    // the document free to refresh, so a LATER valid one wins. The first refused
    // value is kept until one parses, as evidence that the page tried.
    if (
      (metaRefresh === undefined || metaRefresh.delaySeconds === null) &&
      content !== undefined &&
      content !== "" &&
      attribs["http-equiv"]?.trim().toLowerCase() === "refresh"
    ) {
      const parsed = parseRefresh(content, pageUrl);
      if (metaRefresh === undefined || parsed.delaySeconds !== null) metaRefresh = parsed;
    }
    if (name === "description") {
      metaDescriptionCount += 1;
      // FIRST OCCURRENCE: the flag says the description the value is read
      // from sits outside the head; a body duplicate of an in-head one is not.
      if (metaDescription === undefined) {
        metaDescription = content?.trim() ?? "";
        metaDescriptionOutsideHead = headMode === "body";
      }
    } else if (name === "robots") {
      // EVERY robots meta's content, joined at the end (deviation 4): Google
      // combines repeated robots metas, so a `noindex` in the second one is a
      // `noindex`. The outside-head flag stays about the FIRST element.
      if (!sawRobotsMeta) {
        sawRobotsMeta = true;
        robotsOutsideHead = headMode === "body";
      }
      // Ruling R6: a content identical (after trim) to one already kept adds
      // nothing to the directives, so it is dropped; first-seen order and the
      // first spelling stay, and every distinct content survives.
      if (content !== undefined && !robotsSeen.has(content.trim())) {
        robotsSeen.add(content.trim());
        robotsContents.push(content);
      }
    } else if (name !== undefined && ROBOTS_META_BOT_NAMES.has(name)) {
      if (robotsMetas.length < ROBOTS_METAS_MAX) {
        // No `content` is present and empty, as for the description: the
        // element is a fact even when it directs nothing.
        robotsMetas.push({
          name,
          content: storableCap(content ?? "", ROBOTS_META_CONTENT_MAX),
        });
      }
    } else if (name === "viewport") {
      // Presence is the whole signal; the content string is the agent's
      // business, not the evidence layer's.
      hasViewport = true;
    }
  };

  const handleLinkTag = (attribs: Record<string, string>) => {
    const rel = attribs["rel"]?.trim().toLowerCase();
    if (!rel) return;
    // `rel` is a space-separated token list: rel="next prefetch" is a next
    // link. Whole-value matching missed those; `~=` semantics do not.
    const tokens = rel.split(/\s+/);
    const href = attribs["href"];
    if (tokens.includes("canonical")) {
      // First occurrence, as for the metas: a duplicate canonical in the body
      // after a correct one in the head is `canonical.multiple`'s finding.
      if (canonical === undefined) {
        canonical = href ?? null;
        canonicalOutsideHead = headMode === "body";
      }
      canonicalCount += 1;
    }
    const code = attribs["hreflang"];
    if (tokens.includes("alternate") && code) {
      if (headMode === "body") hreflangOutsideHeadCount += 1;
      hreflangTags.push(code);
      // A pair with no href names no target, so it is not a pair. The code
      // itself survives on the raw `hreflangTags` list.
      if (href !== undefined && hreflang.length + overlongHreflang < MAX_HREFLANG_PAIRS) {
        // Phase 26c: measured as the writer will store it (`hreflangTarget`).
        // An href that will not resolve is kept for the writer to count.
        const target = hreflangTarget(href, pageUrl);
        if (target !== null && !fitsIndex(target)) overlongHreflang += 1;
        else hreflang.push({ code, href });
      }
    }
    // A stylesheet, matched as a token (`rel="preload stylesheet"` is one) and
    // only with an href — a `<link rel=stylesheet>` naming no file references
    // no resource. `icon`, `preload`, `prefetch` and `preconnect` are NOT on
    // the list, and neither is an ALTERNATE stylesheet: see the module header's
    // closed list for both, and for why the alternate is a politeness question
    // rather than a taxonomy one.
    if (tokens.includes("stylesheet") && !tokens.includes("alternate")) {
      addResource(href, "css");
    }
    if (tokens.includes("amphtml")) hasAmp = true;
    if (tokens.includes("next") && relNext === undefined) relNext = href ?? null;
    if (tokens.includes("prev") && relPrev === undefined) relPrev = href ?? null;
    // Every one, href or not (Phase 26b): the first-only reads above stay.
    if (tokens.includes("next")) relNextCount += 1;
    if (tokens.includes("prev")) relPrevCount += 1;
  };

  /**
   * Finish the JSON-LD block the tokenizer was buffering. Never throws: a
   * block that will not parse is counted, not guessed at and not fatal.
   */
  const flushLdJson = () => {
    const text = ldJsonParts.join("");
    const oversize = ldJsonOversize;
    inLdJson = false;
    ldJsonParts = [];
    ldJsonChars = 0;
    ldJsonOversize = false;
    if (oversize) {
      structuredDataParseErrors += 1;
      return;
    }
    // Ruling R11: too deep is refused like too big, counted and not stored.
    if (jsonNestingDepth(text) > MAX_LD_JSON_NESTING) {
      structuredDataParseErrors += 1;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      structuredDataParseErrors += 1;
      return;
    }
    const nodes: unknown[] = [];
    collectLdJsonNodes(parsed, nodes, 0);
    for (const node of nodes) {
      if (structuredData.length >= MAX_STRUCTURED_DATA_BLOCKS) break;
      structuredData.push({ type: ldJsonType(node), raw: node });
    }
  };

  /**
   * Emit an element boundary into the visible-text accumulator. Runs under the
   * same scoping rules as `ontext`, and collapses runs so a tag-dense page does
   * not grow the accumulator with separators.
   */
  const pushBoundary = (parts: string[]) => {
    if (parts.length === 0 || parts[parts.length - 1] === " ") return;
    parts.push(" ");
  };
  const emitTextBoundary = () => {
    if (suppressDepth > 0 || templateDepth > 0 || titleDepth > 0) return;
    const inBody = bodyDepth > 0;
    if (!inBody && headDepth > 0) return;
    pushBoundary(inBody ? bodyParts : fallbackParts);
    // Not gated on `renderableHidden`: a hidden element's boundaries are still
    // boundaries. See the accumulators' comment — identical structure, less
    // text, is what keeps the two counts comparable.
    pushBoundary(inBody ? renderableBodyParts : renderableFallbackParts);
    // The two main-content candidates take a boundary only where they take
    // text, and BOTH are now chrome-gated. The gate reads `chromeDepth` as it
    // stands, and the two handlers bracket it deliberately: a `<nav>` has
    // already INCREMENTED it when its opening boundary is emitted (skipped) and
    // has already DECREMENTED it when its closing one is (taken), so a chrome
    // subtree contributes exactly one separator to either stream — the same one
    // the oracle's walk pushes where it declines to descend. Words on either
    // side of a `<nav>` therefore never merge, which is the only thing this has
    // to get right.
    if (mainOpenedAt !== null && chromeDepth === chromeDepthAtMain) {
      pushBoundary(inBody ? mainBodyParts : mainFallbackParts);
    }
    if (chromeDepth === 0) {
      pushBoundary(inBody ? contentBodyParts : contentFallbackParts);
    }
  };

  // `<template>` joins the stripped subtrees here as well: the oracle's DOM
  // walk stops at the element and pushes no separator around it, so neither
  // does this. The two streams must agree about structure or the whitespace
  // either side of a template block would differ between them.
  const isTextBoundary = (name: string) =>
    !INLINE_TEXT_TAGS.has(name) && !NON_CONTENT_TAGS.has(name) && name !== TEMPLATE_TAG;

  const closeAnchor = () => {
    if (!openAnchor) return;
    const closing = openAnchor;
    const { href, rel, ariaLabel, text } = closing;
    openAnchor = null;
    if (linksByTarget.size + overlongLinks >= MAX_EXTRACTED_LINKS) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved) return;
    // Phase 26c: no `links` row can hold it; counted, never stored, and it
    // takes no position, so the sequence stays dense.
    if (!fitsIndex(resolved)) {
      overlongLinks += 1;
      return;
    }
    if (linksByTarget.has(resolved)) return;
    const anchor = text
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ANCHOR_CHARS);
    // Phase 26c: the wider name only for a link its text and its own
    // aria-label leave unnamed.
    const hint =
      anchor === "" && ariaLabel === null
        ? nameHintOf(closing)
        : { nameHint: null, nameHintSource: null };
    linksByTarget.set(resolved, {
      href: resolved,
      anchor,
      ariaLabel,
      ...hint,
      rel,
      nofollow: (rel ?? "").split(/\s+/).includes("nofollow"),
      isInternal: isSameOrigin(resolved, pageUrl),
      position: linksByTarget.size,
    });
  };

  const parser = new Parser(
    {
      onopentag(name, attribs, isImplied) {
        domSize += 1;
        // The head machine reads every open tag, above the noscript return:
        // a `<noscript>` in the head is a container it has to see open. The
        // structure facts read it first (see `structureOnOpenTag`), and the
        // machine gets the token's source span for a candidate's snippet.
        structureOnOpenTag(name, attribs, isImplied);
        headOnOpenTag(name, isImplied, parser.startIndex, parser.endIndex);
        // Hidden-surface bookkeeping first, and unconditionally: the
        // `noscript` early return below skips the rest of this handler, and
        // `onclosetag` has the mirror of it, so anything that must stay
        // balanced has to happen above both.
        elementDepth += 1;
        if (markupHidden(name, attribs)) {
          hiddenOpenedAt.push(elementDepth);
        } else if (name === "details" && !("open" in attribs)) {
          // A hidden `<details>` is already on the stack above; it hides its
          // summary too, and the harder rule must not also claim it.
          closedDetailsOpenedAt.push(elementDepth);
        }
        if (name === "summary") summaryDepth += 1;
        if (NON_CONTENT_TAGS.has(name)) {
          suppressDepth += 1;
        }
        // Counted apart from the four above, and counted BEFORE the noscript
        // return below so its close (which is handled just as early) can never
        // be missed. Only the text accumulators read it.
        if (name === TEMPLATE_TAG) templateDepth += 1;
        // Chrome, counted on the name alone and above the noscript return so
        // its close (handled just as early) can never be missed — the
        // `templateDepth` precedent exactly. Only the main-content stream reads
        // it.
        if (CHROME_TAGS.has(name)) chromeDepth += 1;
        if (name === "noscript") noscriptDepth += 1;
        if (noscriptDepth > 0) return;
        // Phase 26c: an element inside an open link may name it. Below the
        // noscript return, so `<noscript>` content names nothing, as its text
        // is no anchor; never the `<a>` itself, which closes this one below.
        if (openAnchor && name !== "a") {
          if (openAnchor.innerAriaLabel === null) {
            openAnchor.innerAriaLabel = ariaLabelOf(attribs["aria-label"]);
          }
          if (name === "svg") openAnchor.svgDepth += 1;
          else if (
            name === "title" &&
            openAnchor.svgDepth > 0 &&
            openAnchor.svgTitle === null &&
            openAnchor.svgTitleParts === null
          ) {
            openAnchor.svgTitleParts = [];
          }
        }
        switch (name) {
          case "title":
            // Ignore <title> inside <svg> — only the document title counts.
            // The outside-head flag is about the FIRST document title, the one
            // `title` is read from, under the same svg guard.
            if (!sawTitle && suppressDepth === 0) titleOutsideHead = headMode === "body";
            // Every document title, under the same svg guard (Phase 26b).
            if (suppressDepth === 0) titleCount += 1;
            if (!titleDone && suppressDepth === 0) {
              titleDepth += 1;
              sawTitle = true;
            }
            break;
          case "head":
            headDepth += 1;
            break;
          case "body":
            bodyDepth += 1;
            sawBody = true;
            break;
          case "html":
            // An AMP page marks its root element with `amp` or `⚡`; a page
            // that merely *has* an AMP twin links to it with rel=amphtml.
            // Either is enough for pages.has_amp.
            if ("amp" in attribs || "⚡" in attribs) hasAmp = true;
            // The FIRST `<html>` start tag decides `htmlLang`, lang or not.
            if (htmlLang === undefined) {
              const lang = attribs["lang"]?.trim();
              htmlLang =
                lang === undefined || lang === "" ? null : storableCap(lang, HTML_LANG_MAX);
            }
            break;
          case "meta":
            handleMetaTag(attribs);
            break;
          case "link":
            handleLinkTag(attribs);
            break;
          case "img": {
            imagesTotal += 1;
            const alt = attribs["alt"];
            if (alt === undefined) {
              imagesMissingAlt += 1;
              // Phase 26b: which images, raw, so the finding can name them.
              if (imagesMissingAltSample.length < IMAGE_SAMPLE_MAX) {
                imagesMissingAltSample.push(storableCap(attribs["src"] ?? "", IMAGE_SAMPLE_SRC_MAX));
              }
            } else {
              const trimmedAlt = alt.trim();
              if (trimmedAlt === "") imagesEmptyAlt += 1;
              else if (trimmedAlt.length > ALT_TEXT_LONG_CHARS) imagesAltTooLong += 1;
              // An image link's alt is its anchor text (Phase 26b): pushed
              // where a text node's words would be, spaced off on both sides
              // so it never glues to them ("Home" + "Logo" is "Home Logo",
              // final review I2); `closeAnchor` collapses and trims.
              if (openAnchor && trimmedAlt !== "") openAnchor.text.push(` ${trimmedAlt} `);
            }
            // One image, one count: missing either attribute is the same
            // layout-shift defect and must not be double-counted.
            if (!("width" in attribs) || !("height" in attribs)) {
              imagesMissingDimensions += 1;
            }
            // The refs ride the same walk as the counters above and neither
            // moves the other: see the module header's Phase 11 block for why
            // both facts exist. `src` and the first `srcset` candidate are two
            // different files — the fallback and the first rendition — so an
            // element carrying both contributes both, and the per-URL map
            // collapses them when they are in fact one.
            addResource(attribs["src"], "image");
            const srcset = attribs["srcset"];
            if (srcset !== undefined) {
              addResource(firstSrcsetCandidate(srcset), "image");
            }
            break;
          }
          case "picture":
            pictureDepth += 1;
            break;
          case "video":
            mediaDepth += 1;
            noteInsecure("media", attribs["src"]);
            noteInsecure("media", attribs["poster"]);
            break;
          case "audio":
            mediaDepth += 1;
            noteInsecure("media", attribs["src"]);
            break;
          case "track":
          case "embed":
            noteInsecure("media", attribs["src"]);
            break;
          case "object":
            noteInsecure("media", attribs["data"]);
            break;
          case "iframe":
            noteInsecure("iframe", attribs["src"]);
            break;
          case "form":
            insecureRefs.forms += 1;
            noteInsecure("form", attribs["action"]);
            break;
          case "source": {
            // Inside a <video> / <audio> it names media: an insecure-reference
            // site only (Phase 26b), never a resource ref.
            if (mediaDepth > 0) noteInsecure("media", attribs["src"]);
            // A resource ref ONLY inside a <picture>. The same element inside
            // <video> / <audio> names media, which is out of this phase's owner
            // scope, and a depth counter is how the two are told apart without
            // a tree.
            if (pictureDepth === 0) break;
            addResource(attribs["src"], "image");
            const sourceSrcset = attribs["srcset"];
            if (sourceSrcset !== undefined) {
              addResource(firstSrcsetCandidate(sourceSrcset), "image");
            }
            break;
          }
          case "main":
            // The first `<main>` a rendered document has, and the switch is
            // where it is claimed rather than the block above precisely so the
            // three subtrees that are in no document cannot claim it: the
            // `noscript` return sits above this, and the two guards name the
            // other two. `elementDepth` is the identity, not a counter — see
            // `mainOpenedAt`.
            if (
              !mainDone &&
              mainOpenedAt === null &&
              suppressDepth === 0 &&
              templateDepth === 0
            ) {
              mainOpenedAt = elementDepth;
              mainSeen = true;
              // Read AFTER this element's own increment would have happened —
              // `main` is not a chrome name, so `chromeDepth` here is exactly
              // the chrome open around the `<main>`, which the stream ignores.
              chromeDepthAtMain = chromeDepth;
            }
            break;
          case "nav":
            navDepth += 1;
            break;
          case "footer":
            footerDepth += 1;
            break;
          case "script":
            // An id is case-sensitive and is not a token list: compared
            // verbatim, unlike `rel` / `type` / meta names above.
            if (attribs["id"] === "__NEXT_DATA__") markersSeen.add("__NEXT_DATA__");
            // Any `<script src>` is an external script, whatever its `type`:
            // a module, a classic script and a `text/template` with a src all
            // cost a request. An inline script has no src and is no resource.
            addResource(attribs["src"], "js");
            if (
              attribs["type"]?.trim().toLowerCase() === "application/ld+json"
            ) {
              hasStructuredData = true;
              inLdJson = true;
              ldJsonParts = [];
              ldJsonChars = 0;
              ldJsonOversize = false;
            }
            break;
          case "a": {
            // `a[href]`, before the link extraction below narrows it: the
            // attribute's presence is the whole test, so an empty value and a
            // `mailto:` both count here while neither becomes a `links` row.
            if ("href" in attribs) {
              if (navDepth > 0) navLinkCount += 1;
              if (footerDepth > 0) footerLinkCount += 1;
            }
            // Every `<a>` start tag, including those that never open below
            // (no href, `javascript:`, `#…`): Phase 26b's anchor counts.
            countAnchor(attribs);
            // HTML forbids nested <a>; browsers implicitly close the open
            // one, and the tokenizer has no tree correction, so mirror that.
            closeAnchor();
            const href = attribs["href"];
            if (href && !SKIPPED_LINK_PROTOCOLS.test(href)) {
              openAnchor = {
                href,
                rel: attribs["rel"]?.trim().toLowerCase() ?? null,
                ariaLabel: ariaLabelOf(attribs["aria-label"]),
                text: [],
                labelledBy: ariaLabelOf(attribs["aria-labelledby"]),
                title: ariaLabelOf(attribs["title"]),
                innerAriaLabel: null,
                svgDepth: 0,
                svgTitleParts: null,
                svgTitle: null,
              };
            }
            break;
          }
        }
        // Framework attributes live on whatever element the framework chose
        // (<html>, <body>, a wrapper div), so they are read off every open tag
        // rather than from a case above.
        if ("data-reactroot" in attribs) markersSeen.add("data-reactroot");
        if ("ng-app" in attribs) markersSeen.add("ng-app");
        const headingLevel = HEADING_LEVELS[name];
        if (headingLevel !== undefined) {
          headingCounts[headingLevel - 1] =
            (headingCounts[headingLevel - 1] ?? 0) + 1;
          if (headingOrder.length < MAX_HEADING_ORDER) {
            headingOrder.push(headingLevel);
          }
          if (headingLevel === 1 && openH1 === null) openH1 = [];
          if (headingLevel === 2 && openH2 === null && !h2Done) openH2 = [];
        }
        if (isTextBoundary(name)) emitTextBoundary();
      },
      ontext(text) {
        // Before every scoping rule below: text the head machine must see may
        // sit anywhere, and the machine has its own container depth.
        headOnText(text);
        // JSON-LD lives inside a suppressed subtree, so it is buffered before
        // the visible-text scoping rules get a say.
        if (inLdJson && !ldJsonOversize) {
          ldJsonChars += text.length;
          if (ldJsonChars > MAX_LD_JSON_CHARS) {
            ldJsonOversize = true;
            ldJsonParts = [];
          } else {
            ldJsonParts.push(text);
          }
        }
        // Phase 26c: an icon's `<svg><title>` sits inside a suppressed subtree
        // (`svg` is a NON_CONTENT_TAG), so it is read before the return below.
        // It is never anchor text and never the document title: `titleDepth`,
        // `titleCount` and `titleOutsideHead` keep their own svg guard.
        if (openAnchor?.svgTitleParts && noscriptDepth === 0) openAnchor.svgTitleParts.push(text);
        if (suppressDepth > 0) return;
        if (titleDepth > 0) {
          titleParts.push(text);
          return;
        }
        if (openH1) openH1.push(text);
        if (openH2) openH2.push(text);
        if (openAnchor) openAnchor.text.push(text);
        // THE TEMPLATE GATE, and its position is the point: every capture
        // above it sees template text (the DOM oracle's selectors do too, so
        // an `<h1>`, an `<a>` or a `<title>` inside a template reads exactly as
        // it did before Phase 7), and neither accumulator below it does.
        if (templateDepth > 0) return;
        const hidden = renderableHidden();
        // The two main-content candidates ride the same gate as the two
        // accumulators above them and take the SAME text nodes — no
        // markup-hidden exclusion, deliberately: this fingerprint is of the
        // main content as served (module header, Phase 19).
        // Chrome is dropped from BOTH candidates: `inMain` is "inside the
        // chosen `<main>` and under no chrome opened since it", `inChrome` is
        // the fallback's plain form of the same question.
        const inMain = mainOpenedAt !== null && chromeDepth === chromeDepthAtMain;
        const inChrome = chromeDepth > 0;
        if (bodyDepth > 0) {
          bodyParts.push(text);
          if (!hidden) renderableBodyParts.push(text);
          if (inMain) mainBodyParts.push(text);
          if (!inChrome) contentBodyParts.push(text);
        } else if (headDepth === 0) {
          fallbackParts.push(text);
          if (!hidden) renderableFallbackParts.push(text);
          if (inMain) mainFallbackParts.push(text);
          if (!inChrome) contentFallbackParts.push(text);
        }
      },
      onclosetag(name, isImplied) {
        // The head machine's mirror of its open-tag hook, above the noscript
        // returns for the same reason.
        structureOnCloseTag(name, isImplied);
        headOnCloseTag(name, isImplied);
        // The mirror of `onopentag`'s first block, in the same position and
        // for the same reason. An element is popped by the DEPTH it opened at,
        // never by its name: `<div hidden><div>…</div></div>` closes an inner
        // element of the same name first, and a name match would un-hide the
        // rest of the outer one.
        if (hiddenOpenedAt[hiddenOpenedAt.length - 1] === elementDepth) {
          hiddenOpenedAt.pop();
        }
        if (closedDetailsOpenedAt[closedDetailsOpenedAt.length - 1] === elementDepth) {
          closedDetailsOpenedAt.pop();
        }
        if (name === "summary" && summaryDepth > 0) summaryDepth -= 1;
        // The chosen `<main>` ends at the depth it opened at, and nowhere else:
        // read BEFORE the decrement, like the two pops above and for the same
        // reason. `mainDone` retires it so a later sibling `<main>` — invalid,
        // but a thing pages do — cannot append itself to the first one's text.
        if (name === "main" && mainOpenedAt === elementDepth) {
          mainOpenedAt = null;
          mainDone = true;
        }
        if (elementDepth > 0) elementDepth -= 1;
        if (NON_CONTENT_TAGS.has(name) && suppressDepth > 0) {
          suppressDepth -= 1;
        }
        // Above the noscript returns below, where its increment is: a `<nav>`
        // inside a `<noscript>` must not leave this counter stuck open, which
        // would empty the main-content stream for the rest of the document.
        if (CHROME_TAGS.has(name) && chromeDepth > 0) chromeDepth -= 1;
        if (name === TEMPLATE_TAG && templateDepth > 0) templateDepth -= 1;
        if (name === "noscript" && noscriptDepth > 0) {
          noscriptDepth -= 1;
          return;
        }
        if (noscriptDepth > 0) return;
        if (isTextBoundary(name)) emitTextBoundary();
        if (name === "script" && inLdJson) flushLdJson();
        if (name === "title" && titleDepth > 0) {
          titleDepth -= 1;
          if (titleDepth === 0) titleDone = true;
        }
        if (name === "nav" && navDepth > 0) navDepth -= 1;
        if (name === "picture" && pictureDepth > 0) pictureDepth -= 1;
        if ((name === "video" || name === "audio") && mediaDepth > 0) mediaDepth -= 1;
        if (name === "footer" && footerDepth > 0) footerDepth -= 1;
        if (name === "head" && headDepth > 0) headDepth -= 1;
        if (name === "body" && bodyDepth > 0) bodyDepth -= 1;
        // Phase 26c: the open-tag hook's mirror, below the noscript returns as
        // that hook is below its own.
        if (openAnchor) {
          if (name === "title" && openAnchor.svgTitleParts !== null) {
            openAnchor.svgTitle = ariaLabelOf(openAnchor.svgTitleParts.join("").replace(/\s+/g, " "));
            openAnchor.svgTitleParts = null;
          } else if (name === "svg" && openAnchor.svgDepth > 0) {
            openAnchor.svgDepth -= 1;
          }
        }
        if (name === "a") closeAnchor();
        if (name === "h1" && openH1) {
          h1s.push(openH1.join("").trim());
          openH1 = null;
        }
        if (name === "h2" && openH2) {
          h2Text = storableCap(openH2.join("").replace(/\s+/g, " ").trim(), H2_TEXT_MAX);
          openH2 = null;
          h2Done = true;
        }
      },
    },
    // Defaults (non-XML mode): lowercased tag/attribute names, decoded
    // entities — matching what the DOM-based implementation saw.
  );
  parser.write(html);
  parser.end();
  // A document that ends inside a JSON-LD script still owes us its block.
  if (inLdJson) flushLdJson();

  const rawText = (sawBody ? bodyParts : fallbackParts).join("");
  const bodyText = rawText.replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  // The same three lines over the renderable stream, and the same body-vs-
  // fallback choice, so a fragment is measured on both sides or on neither.
  const renderableRaw = (sawBody ? renderableBodyParts : renderableFallbackParts).join("");
  const renderableText = renderableRaw.replace(/\s+/g, " ").trim();
  const renderableWordCount = renderableText ? renderableText.split(/\s+/).length : 0;
  // THE CHOICE, made here because here is where the document has ended: a page
  // that declared a `<main>` is measured inside it, and a page that declared
  // none is measured over its whole body. Chrome is out of both. Both were
  // accumulated during the one pass, so this costs a join and a compare.
  // Only the branch taken is joined: on a page that declared a `<main>` the
  // body-wide fallback was still accumulated (the choice cannot be made until
  // the document ends) but is never read, and joining it would be one string
  // built per page for nothing.
  const mainText = (
    mainSeen
      ? (sawBody ? mainBodyParts : mainFallbackParts).join("")
      : (sawBody ? contentBodyParts : contentFallbackParts).join("")
  )
    .replace(/\s+/g, " ")
    .trim();
  // Zero words is NOT a measurement of zero: an empty `<main>`, a `<main>` that
  // is nothing but chrome (the empty template page this amendment was written
  // for) and a body that is all chrome all mean "there is nothing here to
  // fingerprint", and a rule has to be able to tell that from a page it
  // measured at zero. See the field docs.
  const mainWordCount = mainText === "" ? null : mainText.split(/\s+/).length;
  const title: string | null = sawTitle ? titleParts.join("").trim() : null;
  const firstH1 = h1s[0];
  const h1Text =
    firstH1 === undefined
      ? null
      : firstH1.replace(/\s+/g, " ").trim().slice(0, MAX_H1_TEXT_CHARS);

  // Bytes, not characters, on both sides: the ratio is about wire weight.
  // Clamped because a text-only fragment is legitimately all text, and
  // entity decoding can nudge a pathological page a hair over 1.
  const htmlBytes = Buffer.byteLength(html);
  const textRatio =
    htmlBytes === 0 ? 0 : Math.min(1, Buffer.byteLength(bodyText) / htmlBytes);

  // The social set, capped here and only here (see `socialFirst`). Null only
  // when the page carried no social tag at all. `imageRefs` is NOT capped: it
  // is the key of a `resources` row (see the field), and `socialImageRefs` is
  // exactly its non-null values, deduped, og first.
  let social: SocialFacts | null = null;
  let socialImageRefs: string[] = [];
  if (socialCounts.size > 0) {
    const og: SocialFacts["og"] = {};
    const x: SocialFacts["x"] = {};
    for (const [tag, value] of socialFirst) {
      const slot = SOCIAL_SLOTS[tag];
      const capped = storableCap(value, slot.cap);
      if (slot.group === "og") og[slot.key] = capped;
      else x[slot.key] = capped;
    }
    social = {
      og,
      x,
      counts: Object.fromEntries(socialCounts),
      conflicting: [...socialConflicting].sort(),
      outsideHead: socialOutsideHead,
      xViaProperty,
      imageRefs: { ...socialImageRef },
      imageRefTooLong: { ...socialImageRefTooLong },
    };
    const { og: ogRef, x: xRef } = socialImageRef;
    socialImageRefs = [...new Set([ogRef, xRef].filter((ref) => ref !== null))];
  }

  return {
    title,
    metaDescription: metaDescription ?? null,
    canonicalHtml: canonical ?? null,
    canonicalCount,
    // Deviation 4: every robots meta, joined. Null when there was none — or
    // when none carried a `content`, which is what the first-only read said.
    // Made storable (no cap): the joined value is a 26b reading of the column.
    robotsMeta: robotsContents.length === 0 ? null : storableCap(robotsContents.join(", ")),
    ogTitle: ogTitle ?? null,
    ogDescription: ogDescription ?? null,
    ogImage: ogImage ?? null,
    headingCounts: [
      headingCounts[0] ?? 0,
      headingCounts[1] ?? 0,
      headingCounts[2] ?? 0,
      headingCounts[3] ?? 0,
      headingCounts[4] ?? 0,
      headingCounts[5] ?? 0,
    ],
    headingOrder,
    h1Text,
    wordCount,
    renderableWordCount,
    imagesTotal,
    imagesMissingAlt,
    imagesMissingDimensions,
    hasAmp,
    hasViewport,
    hasLoremIpsum: LOREM_IPSUM.test(bodyText),
    hasSoft404Phrases: SOFT_404_PATTERN.test(bodyText),
    navLinkCount,
    footerLinkCount,
    // The constant's order, not document order: the field is a set, and a set
    // with a stable spelling is one a SQL comparison can be written against.
    frameworkMarkers: FRAMEWORK_MARKERS.filter((marker) => markersSeen.has(marker)),
    links: Array.from(linksByTarget.values()),
    resourceRefs: Array.from(resourceRefs.values()),
    resourceRefsCapped,
    relNext: relNext ?? null,
    relPrev: relPrev ?? null,
    domSize,
    textRatio,
    hreflang,
    structuredData,
    structuredDataParseErrors,
    contentHash: createHash("sha256").update(bodyText).digest("hex"),
    simhash: simhash64(bodyText),
    mainSimhash: mainWordCount === null ? null : simhash64(mainText),
    mainWordCount,
    placeholderSnippet: placeholderSnippetOf(bodyText),
    headClosedBy,
    titleOutsideHead,
    metaDescriptionOutsideHead,
    robotsOutsideHead,
    canonicalOutsideHead,
    hreflangOutsideHeadCount,
    htmlLang: htmlLang ?? null,
    social,
    socialImageRefs,
    h2Text,
    titleCount,
    metaDescriptionCount,
    robotsMetas,
    metaRefresh: metaRefresh ?? null,
    anchorCounts,
    relNextCount,
    relPrevCount,
    insecureRefs,
    imagesEmptyAlt,
    imagesAltTooLong,
    imagesMissingAltSample,
    htmlStructure: {
      htmlTags,
      headTags,
      bodyTags,
      headBeforeBody: headTags > 0 && bodyTags > 0 ? firstOfHeadBody === "head" : null,
      // A candidate nothing confirmed is a document that simply started its
      // body without `</head>` (deviation 6, evidence narrowed by ruling R8):
      // not an early close.
      closedEarly: closedEarlyFact(),
    },
    overlongUrls: { links: overlongLinks, resources: overlongResources, hreflang: overlongHreflang },
    bodyText,
    h1s,
    hasStructuredData,
    hreflangTags,
  };
}

/**
 * The facade the crawl loop and the rule engine consume: the build plan's
 * `PageAnalysis`, nothing wider.
 */
export function analyzePage(html: string, url: string): PageAnalysis {
  const raw = analyzeHtml(html, url);
  return {
    title: raw.title,
    metaDescription: raw.metaDescription,
    canonicalHtml: raw.canonicalHtml,
    canonicalCount: raw.canonicalCount,
    robotsMeta: raw.robotsMeta,
    ogTitle: raw.ogTitle,
    ogDescription: raw.ogDescription,
    ogImage: raw.ogImage,
    headingCounts: raw.headingCounts,
    headingOrder: raw.headingOrder,
    h1Text: raw.h1Text,
    wordCount: raw.wordCount,
    renderableWordCount: raw.renderableWordCount,
    imagesTotal: raw.imagesTotal,
    imagesMissingAlt: raw.imagesMissingAlt,
    imagesMissingDimensions: raw.imagesMissingDimensions,
    hasAmp: raw.hasAmp,
    hasViewport: raw.hasViewport,
    hasLoremIpsum: raw.hasLoremIpsum,
    hasSoft404Phrases: raw.hasSoft404Phrases,
    navLinkCount: raw.navLinkCount,
    footerLinkCount: raw.footerLinkCount,
    frameworkMarkers: raw.frameworkMarkers,
    links: raw.links.map(({ href, anchor, ariaLabel, nameHint, nameHintSource, rel, nofollow, position }) => ({
      href,
      anchor,
      ariaLabel,
      nameHint,
      nameHintSource,
      rel,
      nofollow,
      position,
    })),
    // The refs are `{url, kind}` on both sides — no narrowing to do, and the
    // array is copied rather than shared so the facade's result cannot be
    // mutated through the raw one.
    resourceRefs: raw.resourceRefs.map(({ url, kind }) => ({ url, kind })),
    resourceRefsCapped: raw.resourceRefsCapped,
    relNext: raw.relNext,
    relPrev: raw.relPrev,
    domSize: raw.domSize,
    textRatio: raw.textRatio,
    hreflang: raw.hreflang,
    structuredData: raw.structuredData,
    structuredDataParseErrors: raw.structuredDataParseErrors,
    contentHash: raw.contentHash,
    simhash: raw.simhash,
    mainSimhash: raw.mainSimhash,
    mainWordCount: raw.mainWordCount,
    placeholderSnippet: raw.placeholderSnippet,
    headClosedBy: raw.headClosedBy,
    titleOutsideHead: raw.titleOutsideHead,
    metaDescriptionOutsideHead: raw.metaDescriptionOutsideHead,
    robotsOutsideHead: raw.robotsOutsideHead,
    canonicalOutsideHead: raw.canonicalOutsideHead,
    hreflangOutsideHeadCount: raw.hreflangOutsideHeadCount,
    htmlLang: raw.htmlLang,
    social: raw.social,
    socialImageRefs: [...raw.socialImageRefs],
    h2Text: raw.h2Text,
    titleCount: raw.titleCount,
    metaDescriptionCount: raw.metaDescriptionCount,
    robotsMetas: raw.robotsMetas,
    metaRefresh: raw.metaRefresh,
    anchorCounts: raw.anchorCounts,
    relNextCount: raw.relNextCount,
    relPrevCount: raw.relPrevCount,
    insecureRefs: raw.insecureRefs,
    imagesEmptyAlt: raw.imagesEmptyAlt,
    imagesAltTooLong: raw.imagesAltTooLong,
    imagesMissingAltSample: raw.imagesMissingAltSample,
    htmlStructure: raw.htmlStructure,
    overlongUrls: { ...raw.overlongUrls },
  };
}

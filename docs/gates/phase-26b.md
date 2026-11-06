# Phase 26b gate: the parser wave

Date: 2026-11-06. Spec: `docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md`
(the "Gate 26b" section). Plan: `docs/superpowers/plans/2026-11-06-phase-26b-parser-wave.md`.
Branch `worktree-phase-26b`, built on `4a993ef` (PR #22 merge). The gate crawl and the
re-judge ran on the code of `3fa2eb9` (Task 11) plus Task 12's copy and docs changes,
which touch no extraction and no verdict.

**Verdict: clauses 1–4 pass.** The 26 new rules bring the ruleset to 0.21.0 with 180 rules
(69 page / 97 query / 14 metric; 33 critical / 62 warning / 85 info; 15 markers) at
`EXTRACTION_VERSION` 2, migrations 0026 and 0027. Re-judging the stored Phase 25 crawl
(every page at version 1) gives `extraction.not-recorded` with `pagesNotRecorded` 602 and
nothing from any of the 22 version-2 rules; the 1,907 findings of the older rules are
unchanged. The lavishalice re-crawl peaked at **233.0 MB** RSS (budget 246.3 MB), and the
fifteen new columns average **1,091 bytes** a row (1,301 over the 505 OK pages; max 1,642;
budget 2,048). Seven new rules fire on it, and the hand-check against the live site found
**no false positive** (§4), so no rule changed. Ruling R14's copy change and the og-only
fetch check carried from Task 6 are done (§5, §6). The hand-check sent 17 GETs to the live
site, under the cap of 40, plus the gate's before and after probes.

## Gate clauses (spec "Gate 26b", plan Task 12)

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite green, 0 skipped; `tsc` clean | **pass**: 115 files / 3,177 tests, 0 failed, 0 skipped; `tsc` clean | §1 |
| 2 | a pre-bump crawl gets "not measured" from every 26b rule, never a pass (the stored v1 lavishalice crawl, no re-crawl) | **pass**: `extraction.not-recorded` `{pagesNotRecorded: 602, pagesRecorded: 0}`; 0 findings from the 22 version-2 rules; the three deviation-1 rules fire (571 findings), reviewed; the older rules' 1,907 findings and all 92 metric rows unchanged | §2 |
| 3 | lavishalice re-crawl, 600 pages: peak RSS ≤ 246.3 MB (Phase 25's 223.9 MB + 10%); new columns ≤ 2,048 bytes a row on average | **pass**: 238,640 kB = **233.0 MB**; **1,091.1 bytes** average over 602 rows (1,300.6 over the 505 OK rows), max 1,642 | §3 |
| 4 | each new rule's findings reviewed for false positives; `social.image-broken` re-checked with `fetchResources: false` | **pass**: 7 rules fire and 18 are silent, every silence explained; samples hand-checked against the live site (17 GETs); 0 false positives; `social.image-broken` silent (all 505 share images absolute) | §4 |

## 1. Clause 1: suite and types

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **115 files / 3,177 tests, 0 failed, 0 skipped** (171 s, 2026-11-06 22:49 UTC), the run after the last code edit of Task 12 (R14 copy, the og-only resource test, the version note). `3fa2eb9` ran 115 / 3,175; Task 12 added 2 tests |
| `npx tsc --noEmit` | clean |
| baseline at the branch point (`4a993ef`) | 104 files / 2,859 tests |
| phase delta | +11 files, +318 tests |
| ruleset | **0.21.0** (from 0.20.0; one bump for the phase; the note in `src/rules/registry/registry.ts` has items T1–T11 and a T12 item for R14) |
| registry | 180 rules: 69 page / 97 query / 14 metric; 33 critical / 62 warning / 85 info (71 info among the finding rules); 15 markers |
| `rules_catalog` | 180,444 bytes (15 markers at 2,274 bytes, 14 tables at 5,239), against 154,237 at 0.20.0 |

## 2. Clause 2: a pre-bump crawl is refused, on real data

**What was run.** The crawl is `crawl_11e15602-63c4-4aa4-8b94-fb3b65908f19`, the Phase 25
gate crawl of `https://lavishalice.com/`: 602 rows, every one at `extraction_version` 1,
`fetchResources: false`. A one-off script outside the committed tree
(`.superpowers/sdd/…/gate26b/rejudge.mts`) called `ApiService.runRulesForCrawl`, the path the
MCP `crawl_rules` tool takes, at about 22:28 UTC on 2026-11-06, on the tree of `3fa2eb9` plus
the R14 copy edit. It answered `{pagesScanned: 602, findings: 2479, metrics: 92}` in 5.8 s. No
page was fetched. The crawl's issues (1,907 rows at 0.20.0) and metrics (92 rows) were
snapshotted before the run and compared after it.

**Result.**

| | |
|---|---|
| `extraction.not-recorded` | **fired once**, `dedupeKey` "site", evidence `{pagesRecorded: 0, pagesNotRecorded: 602}`: the crawl's page count |
| the 22 version-2 rules (every new rule except the three below and the marker) | **0 findings** |
| `title.same-as-h1` (deviation 1) | 335 |
| `h2.missing` (deviation 1) | 233 |
| `social.og-duplicate` (deviation 1) | 3 |
| the older rules | the same 1,907 rows: rule, page, severity, key and evidence identical; only `ruleset_version` moved from 0.20.0 to 0.21.0 |
| metrics | all 92 rows byte-identical, `site.health` included: the new findings are info and landed on pages that already carried findings |

**The three deviation-1 rules, reviewed.** They read stored columns, so their findings were
checked against the same live pages as clause 4 (§4). The counts agree with the re-crawl's
(338 / 235 / 3). `title.same-as-h1`: lavishalice's collection, page and product titles
carry no brand suffix, so the title equals the H1 ("News" / "News", "Outlet Under £30" /
"Outlet Under £30", product names). True. `h2.missing`: the collection and content
templates have no H2 at all. Product pages have one (the product name) and are not listed.
True. `social.og-duplicate`: `/` and `/search` share the site's default og:description,
`/collections/outlet-under-30` and `-50` share one, and `/search` and `/pages/search` share
the og:title "Search". True.

## 3. Clause 3: the lavishalice re-crawl

One Node process, the Phase 25 recipe unchanged. The script calls `ApiService.startCrawl`,
polls `getCrawl` every 15 s, then calls `ApiService.renderCrawl` and
`ApiService.runRulesForCrawl`. RSS was sampled every 250 ms (`process.memoryUsage.rss()`), and
the process was wrapped in `/usr/bin/time -v`. The script, the log, `result.json` and
`time.txt` are in `.superpowers/sdd/2026-11-06-phase-26b-parser-wave/gate26b/`, outside the
committed tree.

Request: `{siteUrl: "https://lavishalice.com/", maxPages: 600, fetchResources: false}`, with
the render pass on and everything else an API default. The branded UA, robots.txt and the
per-host governor ran exactly as in Phase 25, and the Shopify profile applied unchanged. The
crawl ran once, with no retry.

Crawl: **`crawl_bf56097f-23ad-44ec-91dd-b8c09642f53c`**, 22:27:54 → 22:43:00 UTC
(2026-11-06), the render pass to 22:45:51, rules done 22:45:58. It is kept in the dev
database as evidence.

**Probe pair** (`curl -A "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)"
https://lavishalice.com/`): before, at 22:27:48 (6 s before the crawl), **200**; after, at
22:46:05 (7 s after the rules), **200**.

**Politeness.** `platform_profile_jsonb` applied `{"maxConcurrency": 1, "perHostDelayMs": 1000,
"renderConcurrency": 1, "navigationTimeoutMs": 60000}` at 22:27:58. The throttle record is
`{"responses429": 2, "retryAfterSeen": 0, "escalations": 2, "recoveries": 1,
"recoveryLocked": true, "peakSpacingMs": 2000, "finalSpacingMs": 2000}`, which is Phase 25's
2 / 2 / 1 and lock exactly. The frontier ended `{pending 0, leased 0, done 600, failed 0}`.

**Pages.** 602 rows, all at `extraction_version` 2: 505 ok/200, 93 redirect/301, 1
client_error/404, 1 non_html/200 (`/agents.md`) and 2 `disallowed` (robots.txt: `/account`
and a faceted `/collections/new-in?filter…` URL). The crawl ended at the cap
(`frontier_capped` true). `crawl_status.resources.seen` is 4,350. Of those, 418 are
share-image rows with no `page_resources` edge (deviation 3), and every row is `skipped`, as
`fetchResources: false` asks.

### 3.1 Peak RSS

| stage | peak RSS (sampled) |
|---|---|
| crawl + recheck (600 pages) | 225.9 MB (236,843,008 B) |
| render (21 pages, Chromium out of process) | 228.0 MB (239,050,752 B) |
| rules (602 pages scanned, 3,411 findings) | 233.0 MB (244,367,360 B) |
| **process peak, `time -v` Maximum resident set size** | **238,640 kB = 233.0 MB** |
| Phase 25's figure for the same request | 229,256 kB = 223.9 MB |
| budget (Phase 25 + 10%) | 246.3 MB |

**Met**, with 13.3 MB to spare. The phase added 9.2 MB (+4.1%) to the peak. The peak is in
the rules stage, which now runs 180 rules where Phase 25 ran 114. As in Phase 25, Chromium's
processes are not in the figure.

| | |
|---|---|
| crawl wall time | 15 m 06 s (906 s), against Phase 25's 15 m 33 s |
| crawl + render + rules, `time -v` elapsed | 18 m 05.7 s (Phase 25: 18 m 20.8 s) |
| render | `{rendered: 21, failures: 0, unrendered: 0, elapsedMs: 159433, requests: {paced: 59, fromCache: 283, unpacedNetwork: 0}}` |

### 3.2 Row size of the fifteen new columns

`rowsize.sql` in the gate directory sums `coalesce(pg_column_size(c), 0)` per row over
`html_lang`, `social`, `h2_text`, `title_count`, `meta_description_count`, `robots_metas`,
`meta_refresh`, `anchor_counts`, `insecure_refs`, `images_empty_alt`, `images_alt_too_long`,
`images_missing_alt_sample`, `rel_next_count`, `rel_prev_count` and `html_structure`.

| | |
|---|---|
| **average over all 602 rows** | **1,091.1 bytes** (budget 2,048) |
| average over the 505 OK rows | 1,300.6 bytes |
| **maximum** | **1,642 bytes** |
| minimum | 0 (the two `disallowed` rows, never requested) |
| total for the crawl | 656,822 bytes |

Per column (average over all rows / maximum): `social` 650.7 / 1,008; `anchor_counts` 108.7 /
132; `html_structure` 101.5 / 121; `images_missing_alt_sample` 94.5 / 363; `insecure_refs` 93.1 /
111; `h2_text` 15.7 / 49; `robots_metas` 4.2 / 5; the five integer counts 3.4 / 4 each;
`html_lang` 2.5 / 3; `meta_refresh` 0 (null on every row). `social` is most of it, because
every Shopify page carries a full Open Graph and X set: title, description, image, URL, type
and site name, plus the X card, title, description and image, and their counts.

## 4. Clause 4: false-positive review

`fp-counts.sql` counts the 26 new rules on the re-crawl. `handcheck/` holds the fetcher and an
inspector built on Python's stdlib `html.parser`, a second parser independent of the engine's,
so agreement is evidence rather than an echo. `live/` and `live2/` hold the fetched HTML.

**Live traffic.** GET only, one request at a time, the crawler's UA, 3 s apart: 15 pages from
22:47:27 to 22:48:14. Two product pages answered **429**, and the check did not press. One
retry of those two, 10 s apart at 22:50:52, got one 200 and one 429, and the check stopped
there. **17 requests in total**, under the cap of 40. The second product page was judged from
its stored row and from the first product page, which uses the same template.

### 4.1 Findings per rule

"Pages checked" is the number of fetched pages the verdict was compared against.

| rule | severity | count | pages checked | verdict |
|---|---|---:|---:|---|
| `title.same-as-h1` | info | 338 | 9 | true: the titles carry no brand suffix (`News` / `News`, `Outlet Under £30`, `AW26`, `About Us`, `GDPR Compliance`, `Search`, a product name). Pages whose H1 differs (`/` "Lavish Alice", `/pages/search` "Search Results") or is absent (`/pages/countdown`, the Klarna and privacy pages) are not listed |
| `h2.missing` | info | 235 | 12 | true: no `<h2>` in the served HTML of `/`, the collections, `/blogs/news`, the article, the content pages, `/search` or `/pages/search`. `/pages/gdpr-compliance` (4 H2s) and the product page (1) are not listed |
| `images.empty-alt` | info | 447 | 14 | true: 5–10 images with `alt=""` per page (the template's logo, icons and promo tiles). The live count is the engine's plus one on every page: a tracking pixel inside `<noscript>`, which the analyzer does not count as an image. Whether each image is decorative is the agent's call, as the copy says |
| `links.unsafe-target-blank` | info | 257 | 4 | true per the spec (`target=_blank` without `noopener` or `noreferrer`): the Klarna page has 13 links to `klarna.com`, the privacy policy 1 to `shopify.com`, the GDPR page 1, the product page 2 (`/pages/delivery` and `returns.lavishalice.com`). The counts match exactly. See §4.3 on same-origin links |
| `links.no-anchor-text` | info | 200 listed, **505** exact (`truncated.total`) | 14 | true per the spec: on every OK page the one internal target first linked with no text is `/apps/wishlist`, the header heart icon `<a class="wk-button" aria-label="Wishlist">`, which holds an SVG and no text or image alt. See §4.3 on `aria-label` |
| `social.og-duplicate` | info | 3 | 5 | true (§2) |
| `links.uncrawlable` | warning | 1 | 1 | true: `/pages/countdown` has 17 `<a href="#">`, matched exactly |
| `extraction.not-recorded` | info | 0 | | silent, correctly: all 602 rows are at version 2 |
| `social.og-incomplete` | info | 0 | 14 | silent: og:title, og:type, og:image and og:url are on every page. og:description is missing on some pages (`/blogs/news`, `/collections/aw26`, `/pages/search`), and the rule does not require it (the spec names four tags) |
| `social.x-incomplete` | info | 0 | 14 | silent: `<meta name="twitter:card" content="summary">` and twitter:title are on every page, written with `name=`; `xViaProperty` is false on all 505 rows |
| `social.og-multiple` | info | 0 | | silent: no Open Graph property is counted twice on any row |
| `social.og-url-mismatch` | info | 0 | 2 | silent: og:url equals the page URL on 451 rows. On the other 54 it equals the canonical, and those pages are canonicalised elsewhere, so they are not judged |
| `social.image-broken` | warning | 0 | | silent, correctly, with `fetchResources: false` (ruling R13): all 505 og:image and twitter:image values are absolute, so none is relative or invalid. Status and size were not asked, and `resources.not-fetched` fired (1). The og:image is `http:` while twitter:image and `og:image:secure_url` are `https:`, and no rule judges that (§4.3) |
| `title.multiple` | warning | 0 | 14 | silent: one `<title>` per page. Each page also has about 17 `<title>` elements inside inline `<svg>` icons, which the analyzer correctly does not count |
| `meta-description.multiple` | warning | 0 | 14 | silent: at most one description meta on every page |
| `h2.too-long` | info | 0 | | silent: the longest first H2 is 48 characters |
| `h2.duplicate` | info | 0 | | silent: the 16 repeated H2s are product names on `?country=` variants canonicalised to the base product, so only one page in each group is judged |
| `directives.bot-conflict` | warning | 0 | 14 | silent: no robots or bot-specific meta on any page |
| `redirect.meta-refresh` | warning | 0 | 14 | silent: no meta refresh and no `Refresh` header (`meta_refresh` is null on every row) |
| `hreflang.html-lang-mismatch` | info | 0 | | silent: `lang="en"` on all 505 OK pages, and the self hreflang codes are `en` (451) and `x-default`, which is never compared |
| `links.empty-href` | info | 0 | 14 | silent: no `href=""` on any page |
| `pagination.multiple` | info | 0 | | silent: at most one rel=next and one rel=prev per page (37 pages have rel=next) |
| `images.alt-too-long` | info | 0 | 14 | silent: no alt over 100 characters |
| `security.form-insecure` | warning | 0 | 14 | silent: every page is `https:` and every form action is relative (`/search`, `/cart/add`); 0 `http:` form actions recorded |
| `html.head-closed-early` | warning | 0 | 14 | silent: `closedEarly` is null on every row, and nothing in the Shopify head ends it |
| `html.structure-invalid` | info | 0 | 14 | silent: one explicit `<html>`, `<head>` and `<body>`, head first, on all 505 OK rows |

**Seven fire and eighteen are silent**, and every silence has a reason in the stored evidence
or the live HTML.

### 4.2 False positives

**None.** Every finding that was checked matches the live HTML. Where a rule reports a count
(`unsafeBlank`, `hashOnly`, `imagesEmptyAlt` once the `<noscript>` pixel is set aside), the
count equals the inspector's. No rule was changed.

### 4.3 True per the spec, worth the owner's attention

- **`links.no-anchor-text` and `aria-label`.** All 505 findings are one link, the wishlist
  icon, which has `aria-label="Wishlist"`. As specified ("internal link with no text and no
  image alt"), the rule does not read `aria-label`. Screen readers announce it, and search
  engines treat it inconsistently. Counting `aria-label` as anchor text would silence this
  site entirely.
- **`links.unsafe-target-blank` and same-origin links.** The spec counts every
  `target=_blank` without `noopener` or `noreferrer`. On product pages one of the two is
  same-origin (`https://lavishalice.com/pages/delivery`). Screaming Frog's equivalent filter
  counts cross-origin links only, so a calibration run would disagree on 254 product pages here.
- **An `http:` og:image on an `https:` site.** No 26b rule judges it. The
  `og:image:secure_url` is `https:`.
- `pagination.sequence-error`, a Phase 26a rule, fires 4 times here and 0 times on the
  Phase 25 crawl, because `/collections/garden-party?page=2` is now crawled and names
  `?page=1` as its prev. That is a change on the site, not an effect of 26b.

## 5. The og-only resource fetch (carried from Task 6's review)

Task 6's review asked whether the resource pass actually fetches a share image's
`resources` row, which has no `page_resources` edge (deviation 3), and writes its status
and bytes the same way as a row a page loads. It does.

- **Code read.** `fetchCrawlResources` (`src/crawl/resources/fetch-resources.ts`) builds its
  work list in `workList`: `select url from resources where crawl_id = ? and fetch_class is
  null`, keyset-paged by URL. It never reads `page_resources` and never reads `kind`; a
  `WorkItem` is a URL and nothing else. `writeVerdict` updates the row by `(crawl_id, url)`
  with `fetchClass`, `statusCode`, `contentType`, `bytes`, `bytesSource`, `cacheControl`,
  `expires`, `fetchedAt` and `fetchMs`. Nothing in the pass can tell an og-only row from a
  page-loaded one.
- **Test.** Every existing case in `test/crawl/fetch-resources.test.ts` already seeds rows
  with no `page_resources` edge at all. Task 12 adds one that compares the two directly,
  "writes the same status, bytes and class for an og-only row as for a page-loaded one":
  `/a.png` with a `page_resources` edge and `/a.png?share=1` without one get the identical
  `{fetchClass: "ok", statusCode: 200, bytes: 1234, bytesSource: "header", contentType:
  "image/png"}`, and an edge-less `/missing.png` gets 404 with a `fetchedAt`, from one HEAD.

## 6. Ruling R14: `html.structure-invalid` on a valid tagless document

The `<head>` and `<body>` start tags are optional in HTML. The rule keeps reporting a page
that leaves them out (spec: "missing or repeated"; Screaming Frog's validation filters do
the same), at info. Its copy no longer calls such a page invalid or broken. The title is now
"HTML: Head or body tag missing, repeated or out of order". The explanation says the tags
are optional, that without them nothing marks where the head ends, so one stray element
moves the head tags into the body, and the fix says to write explicit `<head>` and `<body>`
tags. CHECK-88 in `skills/ariadne-audit/checklist.md` says the same, and its Evaluate step
counts a page whose only problems are head-missing / body-missing as a PASS with a
recommendation; a repeated or misplaced tag is the FAIL. `test/rules/html-structure.test.ts`
"reports a valid tagless document as head-missing and body-missing, without calling it
invalid" runs `<!doctype html><title>x</title><p>hi` through the analyzer and the rule
(problems `["head-missing", "body-missing"]`, info) and checks the copy.
`test/rules/copy.test.ts` stays green.

## 7. Deviations from the plan and the spec, as built

The plan's eleven deviations from the spec, each as it shipped:

1. **Three rules judge old crawls too.** `title.same-as-h1`, `h2.missing` and
   `social.og-duplicate` read columns that predate the bump and judge every crawl. The
   other 22 non-marker rules are the ones a pre-bump crawl does not get (the plan's "other
   23" counted the marker; 25 rules + the marker = 26).
2. **`extraction.not-recorded`** (info, query, `marker`, category `crawl`) is the 26th rule.
   It fires once (`dedupeKey` "site") when any page is below version 2 and the crawl has an
   OK page, and claims CHECK-04, 10, 18, 22, 24, 25, 34, 35, 36, 37, 49, 85, 86, 87, 88. Page
   rules are silent on a null column; query rules open with `v2Gate` and refuse a mixed crawl
   whole.
3. **Share images join `resources`, not `page_resources`.** Every resource rule, metric and
   census marker that read `resources` without the edge table now counts only rows a page
   loads (`resources.bad-content-type`, `images.oversized`, `images.legacy-format`,
   `resources.uncached`, the four census markers). §5 confirms the resource pass fetches
   og-only rows like any other.
4. **`robots_meta` joins every `<meta name=robots>`** with ", " (identical contents collapse
   first, ruling R6); bot metas go to `robots_metas`.
5. **`links.uncrawlable`** counts an `<a>` without href only with `onclick` or a link/button
   role; `#`-only means exactly `#` or `#!`.
6. **Head closed early needs evidence the head was meant to continue**, narrowed by ruling R8
   (below).
7. **Two copy areas**, "Social" and "HTML".
8. **CHECK mappings**: social → new CHECK-87; `html.structure-invalid` → new CHECK-88; the
   three link-hygiene rows → CHECK-86; `security.form-insecure` → CHECK-85 ("Mixed content
   and insecure forms").
9. **`hreflang.html-lang-mismatch`** compares the primary language subtag only; `x-default`
   is never compared.
10. **The 100-character alt limit is applied at extraction** (`ALT_TEXT_LONG_CHARS`,
    re-exported as `IMAGE_ALT_MAX`).
11. **`SOCIAL_IMAGE_MAX_BYTES` = 5 MiB.**

Controller rulings made while building, each in the shipped code:

- **R1** The test helper's clean v2 page has one H2 and a title distinct from its H1, so it
  fires nothing.
- **R2** `social.og-incomplete` and `social.x-incomplete` fire on a v2 row whose `social` is
  null (no tags at all is "missing"); every other v2 page rule needs a non-null column.
- **R3** `resources.not-recorded` and `resources.not-fetched` claim CHECK-87.
- **R4** `pagination.multiple` lives in the new `src/rules/page/pagination.ts`.
- **R5** `parseRefresh` follows the HTML refresh algorithm strictly.
- **R6** Identical robots contents collapse before the join; one meta naming both an og and
  a twitter tag counts as both.
- **R7** **A second migration, 0027** (the plan said one): `title_count`,
  `meta_description_count`, `rel_next_count` and `rel_prev_count` widen from smallint to
  integer, unclamped, because a hostile page could overflow smallint and fail the page insert.
- **R8** An explicit `<body>` is never a head-closed-early candidate, and the evidence is only
  head-only content: an explicit `</head>` or `<body>`, `<base>`, `<title>` outside `<svg>`,
  `<meta>` without `itemprop`, a `<link>` whose rel is not all body-ok. `<style>` no longer
  confirms.
- **R9 / R10** Every page-derived string is made storable at the persist and writer boundary
  (`src/crawl/storable-text.ts`): U+0000 → U+2400, lone surrogate → U+FFFD, caps cut on code
  points. This fixed a pre-existing crawl-killing bug (a raw NUL in a title failed the pages
  insert, and a resume repeated it).
- **R11** A JSON-LD block nested deeper than 64 levels is a parse error, not stored;
  `storableDeep` throws past 100 levels. Crawl-level site text (`crawls.discovery`, robots.txt)
  goes through the same boundary.
- **R12 / R12b** Inside a head `<noscript>`, only a start tag outside `HEAD_ALLOWED` is a
  candidate (`<script>`, `<title>`, etc. are reprocessed in head and do not close it).
- **R13** `social.image-broken` lists `not-fetched` images only when the crawl's resource
  check ran; when it did not run, the rule judges relative / invalid / status / size only, and
  `resources.not-fetched` speaks once (it also fires on a crawl whose only rows are unasked
  share images).
- **R14** `html.structure-invalid` keeps firing on omitted optional tags, with copy that does
  not call the page broken (§6).


## 8. Parked and deferred

Minor review findings deferred during the build, none a gate blocker, for the owner or a
later phase:

- `<html><html lang=fr>` records a null `html_lang` (R6 minor 3, a named divergence).
- A nested `<form>` is counted (browsers ignore it); alt length counts UTF-16 units; an image
  alt joins the anchor text with no separator ("Home"+"Logo" → "HomeLogo").
- `<head><noscript><noscript><iframe>` gives a null `closedEarly` (the nested noscript is
  counted in depth); an orphan `</head>` is not counted (htmlparser2 drops it).
- Pre-26b string caps still cut mid-character (the half becomes U+FFFD); a NUL and a literal
  U+2400 in a jsonb key can collide.
- `resources.not-fetched`'s copy says "every image, stylesheet and script its pages point at",
  which is loose on a crawl whose only unasked rows are share images; CHECK-87's Evaluate
  reads the image half as NOT MEASURED whenever a resource marker fires, even where
  `social.image-broken` has real entries.
- `security.mixed-content`'s `insecure_refs.sample` is document-order and shared with forms,
  so ten `http:` forms and one iframe give `byKind.iframe` 1 with no iframe in the sample.
- `h2.duplicate` anchors a group on `min(url)`, which makes two template-sharing exact
  fixtures sort-order dependent.
- A `Refresh` header cut at the stored value cap is parsed as stored; a second `Refresh`
  header is ignored; `en_US` splits only on `-`.
- Test gaps named in review: a v1 non-OK page plus a v2 200 page for the marker; a
  cap/exact-total test for `hreflang.html-lang-mismatch`; non-null `relNext` with
  `relNextCount` 2; head-after-body combined with another problem.
- Task 11's commit (`3fa2eb9`) carries a "Sonnet 5.5" co-author trailer instead of the
  CLAUDE.md line.


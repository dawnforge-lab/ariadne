# Phase 23 gate: proven behaviour

Date: 2026-10-22. Owner, 2026-10-21: "how I can do it better looking at a
proven and tested crawler instead of relying on an agent to make assumptions",
then "create the plan and add the improvements and update the skills as well".
Spec: `docs/research/2026-10-21-screaming-frog-study.md` (§1 D1–D2, §2
thresholds, §4 items 1, 2, 5, §7 order 1–3 + pagination). Plan:
`docs/superpowers/plans/2026-10-21-phase-23-proven-behaviour.md`.

## Gate clauses

| # | clause | where it is proven |
|---|---|---|
| 1 | every new rule fires on its fixture page in the real-browser harness, and the harness coverage list grows by the new ids | §1 |
| 2 | the owner's reference site judged under 0.18.0, per-rule counts before/after | §2 |
| 3 | every new-rule finding on a fresh lavishalice crawl checked by hand against the live page | §3 |
| 4 | memory: peak RSS of the crawl process, with its page count | §4 |
| 5 | Review Focus 1–5, each cited to the test that pins it | §5 |
| 6 | the owner's `~/.claude/skills` edits, shown as diffs | §6 |
| 7 | full suite green, tsc clean, tree clean; counts recorded | §7 |
| 8 | ledger for Phase 24: the effective-value ruling, the empty-alt filter, every deferred minor and every ruling | §8 |

## What changed

Fourteen new rules, ruleset 0.17.0 → **0.18.0**, migrations 0020–0022:

| rule | kind | severity | category | study item |
|---|---|---|---|---|
| `http.no-response` | page | critical | crawl | D2 — timeout / network error, confirmed on a recheck ≥ 60 s later, or never rechecked (cap) |
| `http.no-response-transient` | page | warning | crawl | D2 — the recheck got an HTTP answer |
| `page.html-too-large` | page | critical | crawl | D2 — 2xx HTML body over 2 MiB; `MAX_BODY` 1 MiB → 2 MiB |
| `crawl.unreadable-encoding` | page | info, **marker** | crawl | D2 — content-encoding the crawler does not decode |
| `robots.blocks-internal-urls` | query | warning | crawl | D1 — internal URLs robots.txt disallows, recorded without fetching, with the matching line and inlinks |
| `headings.h1-too-long` | page | info | on-page | §2 — first H1 > 70 characters |
| `url.too-long` | page | info | url | §2 — URL > 115 characters |
| `head.directives-outside-head` | page | critical | indexability | §4 item 2 — canonical / robots meta / hreflang after the head closed (explicitly or implicitly) |
| `head.tags-outside-head` | page | warning | on-page | §4 item 2 — title / meta description after the head closed |
| `render.noindex-changed` | query | critical | indexability | §4 item 5 — raw vs rendered robots meta |
| `render.canonical-changed` | query | critical | canonical | §4 item 5 |
| `render.title-changed` | query | warning | on-page | §4 item 5 |
| `render.meta-description-changed` | query | warning | on-page | §4 item 5 |
| `render.h1-changed` | query | warning | on-page | §4 item 5 |

Threshold changes (study §2): `title.too-short` 10 → **30**,
`meta-description.too-long` 160 → **155**. The three field-duplicate rules
exclude pages declaring `rel=prev`, and `site.health` counts them as
"Paginated Pages Set Aside". The 5xx recheck pass also rechecks no-response
rows (own cap of 100, per-host breaker after three confirmed). The in-repo
`ariadne-*` skills and the owner's `sf-*` skills were updated (§6).

## 1. Fixtures (real browser)

`test/fixtures/harness.test.ts` crawls and renders the fixture site in
Chromium. Every new rule fires on a fixture page except one, which is exempt by
argument:

| rule | fixture |
|---|---|
| `http.no-response` | `/authored23/no-response` (a stateless connection reset; the recheck resets too) |
| `page.html-too-large` | `/authored23/too-large` |
| `crawl.unreadable-encoding` | `/authored23/brotli` |
| `robots.blocks-internal-urls` | `/private/linked` (disallowed in the fixture robots.txt, linked from a crawled page) |
| `headings.h1-too-long`, `url.too-long` | `/authored/img-no-dimensions-on-a-page-whose-address-and-heading-both-run-long-past-what-a-result-shows` |
| `head.directives-outside-head`, `head.tags-outside-head` | `/authored/no-viewport` (canonical closed out by a `<div>`; title and description after it) |
| `render.title-changed`, `render.meta-description-changed`, `render.h1-changed` | `/render/js-nav` |
| `render.noindex-changed`, `render.canonical-changed` | `/render/js-filters` |
| `http.no-response-transient` | **exempt** in `SKIP_HARNESS_CLAIMS`: it needs a URL whose answer flips between two requests, which the shared stateless app rules out. Covered by `test/crawl/recheck.test.ts` ("no-response rows", "the per-host breaker on no-response rows") and by the exclusivity guard over the whole `FetchClass` union in `test/rules/status.test.ts` ("the no-response pair partitions every recheck outcome"). |

The render rules are asserted field by field in the harness test "the render
pass reads robots, description and H1 from the DOM, and the divergence rules
compare them". The rendered-divergence rules are exempt from the harness's
`sampled` key check by name (ledger: key it by the exported ids).

## 2. The owner's reference site under 0.18.0

**The kept crawl was not re-judged in place.** Kept dev-DB crawls are
read-only (Global Constraints; controller ruling). Instead one fresh crawl of
`https://lavishalice.com/` was run under 0.18.0 with `crawl_b49eab7e`'s own
config (`maxPages` 600, `fetchResources` false, concurrency 16, per-host delay
1,000 ms, render knobs at their defaults) and the render pass on:

- `crawl_6b8a04f5-937d-4e2e-a7b2-8b768ce63518`: 554 pages fetched (479 HTML
  200, 73 × 301, 1 × 404, 1 non-HTML) + 2 robots-blocked rows recorded and not
  requested = 556 page rows, crawl 1,020 s; recheck pass ran with nothing to recheck (0 5xx, 0
  no-response); render pass 21 pages, 0 failures, 44.6 s (auto selection,
  budget 28, 21 sampled); rules pass 6.4 s, 556 pages scanned, 1,475 findings.
  Total wall time 17 min 53 s.

**A correction to the brief's premise:** `crawl_b49eab7e`'s stored findings
carry ruleset **0.16.0**, not 0.17.0 (`issues.ruleset_version`; rules run
2026-09-11, before Phase 22). Its column therefore spans two rulesets (Phase
22's judged cohort and Phase 23). The newest stored lavishalice judgement under
0.17.0 is `crawl_0d88567f` (629 pages, `maxPages` 20,000, `fetchResources`
**true**, rules run 2026-09-23), so it is shown as a second baseline.
`crawl_b49eab7e` was not rendered (`render_pass_count` 0). **All differences
also reflect site changes since those crawls** (2026-09-09 and 2026-09-10):
lavishalice has added collections, removed others, and changed its link
structure in the six weeks since.

| rule | b49eab7e (0.16.0, 547 pp) | 0d88567f (0.17.0, 629 pp, resources on) | fresh (0.18.0, 554 pp) | cause of the move, where known |
|---|---|---|---|---|
| title.too-short | 29 | 29 | **152** | Phase 23 threshold 10 → 30 (titles such as "AW26", "FAQs", "News", "Tops") |
| meta-description.too-long | 286 | 247 | **300** | Phase 23 threshold 160 → 155 |
| robots.blocks-internal-urls | — | — | **2** | Phase 23 new rule (§3) |
| title.duplicate | 47 | 2 | 1 | Phase 22 cohort; this crawl has **no** `rel=prev` page, so Phase 23's pagination exclusion moved nothing |
| meta-description.duplicate | 57 | 22 | 2 | as above |
| h1.duplicate-text | 56 | 27 | 0 | as above; checked: every repeated H1 here is a product and its `?country=` variants canonicalised to it, one judged page per group |
| pages.not-in-sitemap | 61 | 43 | 3 | Phase 22 cohort + site |
| canonical.points-elsewhere | 47 | 95 | 44 | site / crawl scope |
| content.near-duplicate | 89 | 121 | 93 | site |
| content.thin | 69 | 65 | 64 | site |
| content.placeholder | 4 | 4 | 1 | site |
| headings.h1-missing | 19 | 19 | 18 | site |
| headings.h1-multiple | 31 | 31 | 29 | site |
| headings.level-skip | 9 | 9 | 11 | site |
| hreflang.alternates-not-crawled | 1 | 1 | 1 | — |
| hreflang.non-indexable-target | 4 | 4 | 4 | — |
| images.missing-alt | 435 | 413 | 431 | site |
| images.missing-dimensions | 65 | 48 | 106 | site template change (24 shared pages went 0→2; 37 new pages); analyzer image code untouched |
| indexability.noindex | 4 | 4 | 4 | — |
| links.broken-internal | 91 | 91 | 0 | 90 of the 91 came from `/pages/avada-sitemap`, no longer linked or in the sitemap (site change); the 91st (`/collections/outlet-under-100` → `/collections/clutch-bags`) still exists but its target was never fetched because of the frontier stall (below): a probable 404 went unchecked |
| links.orphan | 39 | 37 | 80 | pre-existing frontier stall on capped crawls (below), not Phase 23 code: link targets were never enqueued, so pages they point to read as orphans |
| meta-description.missing | 65 | 74 | 75 | site |
| meta-description.too-short | 2 | 2 | 2 | — |
| pagination.next-target-uncrawled | 19 | 0 | 33 | pre-existing frontier stall on capped crawls (below), not Phase 23 code |
| performance.slow-response | 0 | 0 | 1 | network |
| redirect.chain | 1 | 1 | 0 | site |
| redirect.js | 0 | 0 | 2 | render on (`/?country=AT`, `/?country=GB`); b49eab7e was not rendered |
| resources.not-fetched | 1 | 0 | 1 | marker; `fetchResources` false as on b49eab7e |
| sitemap.non-200 | 5 | 9 | 1 | site |
| structure.deep-page | 0 | 3 | 6 | site |
| title.too-long | 17 | 20 | 8 | site (threshold unchanged at 60) |
| url.parameter-pages-indexable | 10 | 39 | 0 | site / crawl scope |
| images.legacy-format, images.oversized, resources.uncached, links.to-server-error, http.server-error-transient | 0 | 200 / 200 / 1 / 1 / 1 | 0 | resources off on b49eab7e and here; the 5xx was transient on 0d88567f |
| **findings in total** | **1,563** | **1,863** | **1,475** | |

**Attribution of the named moves (final review):**

- `pagination.next-target-uncrawled` 0 → 33 and `links.orphan` 37 → 80 were caused by the pre-existing frontier stall on capped crawls, not by Phase 23 code and not by site or crawl scope: the frontier stopped taking link targets about 15 s in (430 depth-0 and 124 depth-1 rows, none at depth 2); 3,475 distinct followable internal targets were never enqueued; the crawl ended at 554 of 600.
- `links.broken-internal` 91 → 0: 90 of the 91 came from `/pages/avada-sitemap`, no longer linked or in the sitemap (a site change). The 91st (`/collections/outlet-under-100` → `/collections/clutch-bags`) still exists but its target was never fetched because of the stall, so a probable 404 went unchecked.
- `images.missing-dimensions` 48 → 106: a site template change (24 shared pages went 0 → 2; 37 new pages); the analyzer image code is untouched.
- Proof that Phase 23 rules did not move them: a read-only re-judge of the stored rows of `crawl_b49eab7e` and `crawl_0d88567f` under 0.18.0 ran all 114 rules with 0 errors and gave identical counts for these four rules (script `/tmp/claude-1000/-home-eugen-dev-Workflows-ariadne/002c1ab6-3d41-46fc-8006-c1afc3e7c692/scratchpad/rejudge.mts`, connection forced `default_transaction_read_only=on`).

Every other new rule (`http.no-response`, `-transient`, `page.html-too-large`,
`crawl.unreadable-encoding`, `headings.h1-too-long`, `url.too-long`, both
`head.*`, all five `render.*`) produced **0** findings on this crawl; §3 says
why each zero is true.

`site.health` on the fresh crawl: judged 431, canonicalised set aside 44,
noindex set aside 4, paginated set aside 0, not auditable 77.

## 3. New-rule findings checked by hand

Checked 2026-10-22 against the live site with the crawler's UA
(`AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)`).

| rule | URL | evidence | live check | verdict |
|---|---|---|---|---|
| robots.blocks-internal-urls | `https://lavishalice.com/account` | `Disallow: /account`, 479 inlinks | robots.txt `User-agent: *` group has `Disallow: /account` (line 58); the only longer Allow is `/account/login`, which does not match `/account`. A live product page (`/products/abigail-wrap-blazer-mini-dress-in-teal-blue`) carries `href="/account"` twice (header); 479 = every HTML 200 page on the crawl. | **true** |
| robots.blocks-internal-urls | `https://lavishalice.com/collections/new-in?filter.p.m.lavishalice.colour_family=GREEN&filter.v.availability=1&sort_by=manual` | `Disallow: /collections/*filter*&*filter*`, 1 inlink | robots.txt line 82 carries that line. The live chartreuse story (`/blogs/stories/the-colour-story-chartreuse`) links `/collections/new-in?sort_by=manual&filter.p.m.lavishalice.colour_family=GREEN&filter.v.availability=1` (the stored URL has its query normalised); `filter…GREEN` `&` `filter.v…` matches the pattern. One linking page. | **true** |

Rules with no finding, and why the silence is true on this crawl:

| rule | finding count | check |
|---|---|---|
| `http.no-response`, `http.no-response-transient` | 0 | no `timeout` / `network_error` row on the crawl (fetch classes: 479 ok, 73 redirect, 2 disallowed, 1 client_error, 1 non_html); recheck `noResponse.pages` 0 |
| `page.html-too-large` | 0 | no `too_large` row (largest live page fetched by hand: 457,734 bytes) |
| `crawl.unreadable-encoding` | 0 | no `unsupported_encoding` row |
| `headings.h1-too-long` | 0 | longest first H1 on an HTML 200 is 56 characters |
| `url.too-long` | 0 | longest judged URL is 113 characters; the one URL over 115 (124, the GREEN filter URL) is a robots-blocked row, outside the judged cohort |
| `head.directives-outside-head`, `head.tags-outside-head` | 0 | on all 479 HTML 200 pages the head closed at an explicit `</head>` (`head_closed_by` null) and every outside flag is false (measured, not null). Oracle check by hand: cheerio/parse5 over the live product page and the live chartreuse story puts the canonical, the description, the title and all 7 hreflang alternates in `<head>` (the 17 body `<title>`s are SVG titles, which the analyzer does not read as document titles) |
| `render.*-changed` (five) | 0 | 21 pages rendered, 0 render errors, `rendered_tags_read` true on all 21; for every one the stored raw and rendered title, canonical, robots meta, meta description and H1 are identical strings (a stricter test than the rules' token / URL / whitespace-normalised comparison, so no rule could fire). Two of the 21 (`/?country=AT`, `/?country=GB`) are JS redirects and are excluded from the divergence rules by design; they are reported by `redirect.js` |

New-rule findings on the fresh crawl: **2, both true; 0 false.**

Observed while checking: after the crawl, Shopify answered `GET /` from the
crawler's UA with **429** (`local_rate_limited`, 18-byte body) while a browser
UA got 200; other paths answered 200 to the same UA. The crawl itself recorded
no `blocked` row and the home page as 200. This is the rate limiter remembering
the crawl for a few minutes, not a crawl-time block; recorded under politeness
(hard rule 9) for the owner, not acted on.

## 4. Memory

The fresh crawl ran as one Node process doing crawl → recheck → render →
rules through `ApiService` (the API's own entry), with `process.memoryUsage()`
sampled every 250 ms and the process wrapped in `/usr/bin/time -v`:

| stage | peak RSS |
|---|---|
| crawl + recheck (554 pages) | 236.0 MB |
| render (21 pages, Chromium out of process) | 297.7 MB |
| rules (556 pages scanned) | 297.0 MB |
| **process peak** (`time -v` maximum resident set) | **299.1 MB** (306,300 kB) |

That is under the 512 MB contract at 554 pages; Chromium's own processes are
not in that figure. It does **not** prove the O(concurrency) contract: the
2 MiB body cap (Task 2) and the blocked-row budget (Task 3) are argued in their
commits, and **a 50k-scale measurement (`scripts/gate-rules.ts` under
`--max-old-space-size=512`) remains owed** — the ruling of record is that a
polite single-site gate cannot reach 50k pages.

**Larger real-site measurement (owner's choice, 2026-10-22).** The owner asked
for a 50k-capped crawl of yellow.com.mt; its WAF answered this machine 403 for
any user agent (AriadneBot and a browser UA alike), so the crawl recorded one
`crawl.blocked` row and stopped — a client allowlist is needed before that
measurement can run. The owner then chose www.direct-fireplaces.com (Magento
behind Cloudflare), crawled with the Phase 23 code at the pre-fix `enqueue`
(before the capped-crawl link fix 1be838c), `maxPages` 50,000, per-host delay
1 s, resource checks off, render off, under `--max-old-space-size=512`:

| crawl | pages fetched | page rows | elapsed | per-host spacing at end | peak RSS |
|---|---|---|---|---|---|
| `crawl_dcf5d7da-49be-4ea5-84ee-4817c459bf79` | 3,131 (2,147 ok, 543 redirect, 441 4xx) | 5,154 (incl. 2,023 robots-blocked rows, never requested) | 13 h 50 m | 16,000 ms (adaptive back-off) | **155.9 MB**, reached at +72 s and flat for the rest of the run |

The site ran out of URLs well below the cap, so this is a ~5k-row real-site
figure, not 50k; a peak reached in the first minute and never exceeded over
5,154 rows is consistent with O(concurrency), but the 50k measurement is still
owed (yellow.com.mt once allowlisted, or another permitted site of that size).

## 5. Review Focus

| # | focus | pinned by |
|---|---|---|
| 1 | a robots.txt that disallows a huge URL space: blocked rows capped by their own budget, never spending `maxPages`, overflow counted on the crawl row | `test/crawl/loop.test.ts` › "robots-blocked internal URLs" › "caps blocked rows at their own budget, counts the overflow, and notes it on the finding" and "never spends maxPages on a blocked row, and defaults the blocked budget to maxPages"; the overflow's reading: `test/rules/robots-query.test.ts` › "says the list is incomplete when the crawl turned blocked URLs away" |
| 2 | documents with no explicit `<head>`/`<body>`; heads holding `<noscript>`, `<template>`, `<script>`, `<style>`, whitespace, comments — a correctly placed canonical never reported outside | `test/crawl/page-analyzer.test.ts` › "implicit head close: Review Focus #2 and the tree builder's other rules" › "whitespace, comments, script, style, noscript and a doctype never close the head", "a fragment with no <html>, <head> or <body> at all"; › "implicit head close: the brief's six cases" › "a document with no <head> tag at all keeps a leading canonical in the head", "an <img> inside a <noscript> in the head does not close it", "a <div> inside a <template> in the head does not close it". Each case is checked against the cheerio/parse5 DOM oracle (`oracle parity` assertion in the same file) |
| 3 | pages not rendered, or whose render failed: divergence rules silent, and "not rendered" never reads as "no divergence" | `test/rules/render-diff.test.ts` › "no divergence rule fires on an unrendered page or a failed render" (with the twin that fires all five once rendered); what was sampled stays `render.coverage`'s subject: `test/rules/render-metrics.test.ts` › "reads a failed render as proof a pass ran, with nothing rendered" and "answers none on a crawl nobody rendered, and still reports what a pass would choose" |
| 4 | pagination without `rel=prev`, and page 1 carrying only `rel=next`: neither excluded; only `rel=prev` pages are | `test/rules/field-duplicates.test.ts` › "paginated pages" › "%s: a series of three reports nothing", "%s: the same three without rel=prev are one group of 3", "%s: page 1 duplicating an unrelated page is still reported, and the exclusion is counted" (each × title / meta description / H1) |
| 5 | pre-0020 rows (all new columns null) — no new rule fires on a null | `test/rules/head.test.ts` › "is silent on a pre-0021 row: null is not measured, never 'inside'" and "is silent on a pre-0021 row"; `test/rules/render-diff.test.ts` › "a pre-0022 rendered row is silent for robots, description and H1, and judged on title and canonical", "a pre-Phase-8 rendered row is silent for title and canonical too", "render.h1-changed is silent when the raw H1 text was never measured"; `test/rules/robots-query.test.ts` › "reads a null overflow count (a crawl before 0020) as unmeasured, never as truncated"; `test/rules/on-page.test.ts` › "headings.h1-too-long boundary: 71 fires, 70 does not, null is silent". The status rules read `fetch_class`, which predates the phase. **The plan's second half is shown by a read-only re-judge** of the stored rows of `crawl_b49eab7e` and `crawl_0d88567f` under 0.18.0 (script `/tmp/claude-1000/-home-eugen-dev-Workflows-ariadne/002c1ab6-3d41-46fc-8006-c1afc3e7c692/scratchpad/rejudge.mts`, connection forced `default_transaction_read_only=on`): all 114 rules ran with 0 errors, and the counts of `links.broken-internal`, `links.orphan`, `pagination.next-target-uncrawled` and `images.missing-dimensions` were identical to the stored ones. |

## 6. The owner's `sf-*` skills

Edited by the controller on 2026-10-21 with `.bak-2026-10-21` copies beside
each file; the gate only reads them. `diff <file>.bak-2026-10-21 <file>`:

```diff
=== ~/.claude/skills/sf-cli/SKILL.md
32c32
< SF="/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher"
---
> SF="$(command -v screamingfrogseospider || echo "/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher")"  # Linux: /usr/bin/screamingfrogseospider; macOS: app bundle
121c121
< | Large images | `Images:Over X KB` |
---
> | Large images | `Images:Over X kB` |
168c168
< | Large image inlinks | `Images:Images Over X KB Inlinks` |
---
> | Large image inlinks | `Images:Images Over X kB Inlinks` |
221c221
< SF="/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher"
---
> SF="$(command -v screamingfrogseospider || echo "/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher")"  # Linux: /usr/bin/screamingfrogseospider; macOS: app bundle
337c337
< | **Large images** | `Images:Over X KB` | `Images:Images Over X KB Inlinks` | — |
---
> | **Large images** | `Images:Over X kB` | `Images:Images Over X kB Inlinks` | — |
=== ~/.claude/skills/sf-cli/REFERENCE.md
3c3
< **Source**: `--help` output from SF v21+ installed at `/Applications/Screaming Frog SEO Spider.app`, cross-referenced with official user guide and community documentation.
---
> **Source**: `--help` output from SF v21+ installed at `/Applications/Screaming Frog SEO Spider.app`; filter names re-verified against SF 24.1 `--help` on Linux (`/usr/bin/screamingfrogseospider`), 2026-10-21. SF 24 also ships a built-in MCP server (`--mcp-streamable-http-server`), not used by these skills, cross-referenced with official user guide and community documentation.
14c14
< SF="/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher"
---
> SF="$(command -v screamingfrogseospider || echo "/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher")"  # Linux: /usr/bin/screamingfrogseospider; macOS: app bundle
212c212
< Images:All | Images:Over X KB | Images:Missing Alt Text
---
> Images:All | Images:Over X kB | Images:Missing Alt Text
491c491
< Images:Images Over X KB Inlinks
---
> Images:Images Over X kB Inlinks
808,809c808,809
<    --export-tabs "Images:All,Images:Over X KB,Images:Missing Alt Text,Images:Missing Alt Attribute,Images:Missing Size Attributes,Images:Incorrectly Sized Images" \
<    --bulk-export "Images:All Image Inlinks,Images:Images Missing Alt Text Inlinks,Images:Images Missing Alt Attribute Inlinks,Images:Images Over X KB Inlinks,Images:Missing Size Attributes" \
---
>    --export-tabs "Images:All,Images:Over X kB,Images:Missing Alt Text,Images:Missing Alt Attribute,Images:Missing Size Attributes,Images:Incorrectly Sized Images" \
>    --bulk-export "Images:All Image Inlinks,Images:Images Missing Alt Text Inlinks,Images:Images Missing Alt Attribute Inlinks,Images:Images Over X kB Inlinks,Images:Missing Size Attributes" \
845c845
< 9. **X values**: Filters like `Images:Over X KB` or `Page Titles:Over X Characters` use the threshold configured in SF settings (or via `--config`). Default thresholds: titles 60 chars, meta desc 155 chars, images 100KB.
---
> 9. **X values**: Filters like `Images:Over X kB` or `Page Titles:Over X Characters` use the threshold configured in SF settings (or via `--config`). Default thresholds: titles 60 chars, meta desc 155 chars, images 100KB.
=== ~/.claude/skills/sf-audit/SKILL.md
29c29
< - SF CLI available at `/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher`
---
> - SF CLI available at `/usr/bin/screamingfrogseospider` (Linux) or `/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher` (macOS)
84c84
< SF="/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher"
---
> SF="$(command -v screamingfrogseospider || echo "/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher")"  # Linux: /usr/bin/screamingfrogseospider; macOS: app bundle
=== ~/.claude/skills/sf-audit/checklist.md
1001c1001
< - **CLI**: `--export-tabs "Page Titles:All,Page Titles:Missing,Page Titles:Duplicate,Page Titles:Over 60 Characters"`
---
> - **CLI**: `--export-tabs "Page Titles:All,Page Titles:Missing,Page Titles:Duplicate,Page Titles:Over X Characters"`
1164c1164
< - **CLI**: `--export-tabs "Content:Near Duplicates"` `--bulk-export "Content:Near Duplicates"` `--save-report "Content:Near Duplicates"`
---
> - **CLI**: `--export-tabs "Content:Near Duplicates"` `--bulk-export "Content:Near Duplicates"`
1407c1407
< - **CLI**: `--export-tabs "Images:Over X KB,Images:Missing Size Attributes"` `--bulk-export "Images:Images Over X KB Inlinks,Images:Missing Size Attributes"`
---
> - **CLI**: `--export-tabs "Images:Over X kB,Images:Missing Size Attributes"` `--bulk-export "Images:Images Over X kB Inlinks,Images:Missing Size Attributes"`
1666c1666
< SF="/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher"
---
> SF="$(command -v screamingfrogseospider || echo "/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher")"  # Linux: /usr/bin/screamingfrogseospider; macOS: app bundle
1671c1671
<   --export-tabs "Internal:HTML,…,Page Titles:Over 60 Characters,…,Images:Over X KB,…,Validation:All" \
---
>   --export-tabs "Internal:HTML,…,Page Titles:Over X Characters,…,Images:Over X kB,…,Validation:All" \
1676c1676
<   --bulk-export "Response Codes:Internal:Internal Client Error (4xx) Inlinks,…,Images:Images Over X KB Inlinks,…,Issues:All" \
---
>   --bulk-export "Response Codes:Internal:Internal Client Error (4xx) Inlinks,…,Images:Images Over X kB Inlinks,…,Issues:All" \
```

The two long lines at checklist.md 1671 and 1676 are elided with `…`; the
elided text is identical on both sides (the only changes are the two filter
names shown).

## 7. Verification

| | |
|---|---|
| `npm test` | **84 files / 2,342 tests, 0 failures** (161.6 s; run 2026-10-22 on 676fde5, with the gate crawl running against the same database) |
| `npx tsc --noEmit` | clean |
| `git status` | clean before the gate doc; the gate crawl's scripts and logs live outside the tree |
| migrations | 0000–0022 at the gate (23 files); 0023 (`crawls.frontier_capped`) added by the frontier-stall follow-up below |
| ruleset | **0.18.0** |
| rules | **114**: 33 page / 67 query / 14 metric; severity over all 114: 33 critical / 31 warning / 50 info (Phase 22: 100 = 28 / 25 / 47) |
| markers | **13** (Phase 22: 12; `crawl.unreadable-encoding` added) |

## 8. Ledger for Phase 24

### Pre-existing defects found by the final review (do first)

- **Frontier stall on capped crawls (pre-existing, hard rule 7):** every maxPages-600 lavishalice crawl ends ~50 rows short with link targets unfollowed (9278877e 547; b49eab7e 547 with 69 unfollowed; 6b8a04f5 554 with 3,475 unfollowed); 20k-cap crawls reach 625/629. The `frontierRows` reservation counter (loop.ts ~1204-1380) drifts ~46-53 above the real frontier row count; leak not found by reading. Fix: instrument against `select count(*)`, and give orphan/pagination rules a completeness signal (`skipReason` in link-graph.ts:112 cannot see it).
  **Fixed on this branch** (`fix(crawl): enqueue reserves frontier room only for URLs not already queued`). The counter did not leak: between calls it equals the row count. Near the cap, `enqueue` reserved room for each page's already-queued nav links first, the cap check tripped, and the new links behind them were skipped before the room came back. `enqueue` now looks up which candidates the frontier holds (one indexed query) and reserves room only for the rest. A capped crawl now reaches `pagesCrawled == maxPages`, so `skipReason` sees the cap and `links.orphan-skipped` fires (test/crawl/loop.test.ts, "a capped crawl fills its budget behind a site-wide nav"). Not re-measured on lavishalice. Follow-up: the residual reservation race can still end a crawl below `maxPages` with nothing pending, so `crawls.frontier_capped` (migration 0023) records the first new URL the cap turned away, and `skipReason` treats it as capped (ruleset 0.18.0 change-log item 7).
- **Politeness (hard rule 9):** after the gate crawl Shopify answered AriadneBot with 429 `local_rate_limited` on `/` (browser UA 200). Likely contributors: render-pass subresource loads under the branded UA, and the gate's hand checks right after the crawl. Investigate.
- The copy/label/test minors listed as "can wait" in the final review triage (the deferred-minors list below).

### Owner rulings needed

- **Effective canonical / robots when outside the head.** Values are still
  extracted as "first occurrence anywhere"; Phase 23 only reports placement.
  Whether a canonical or noindex found after the head closed should stop
  counting (as Google may ignore it) is a verdict on indexability and needs the
  owner. Beside it: a canonical, title or description inside a body
  `<template>` is flagged as outside the head although template content is
  inert (the `howToFix` advice is off for that case).
- **The empty-alt filter.** SF's "Missing Alt Text" (empty `alt=""`, Issue /
  Low) is a possible addition; the analyzer today counts only an absent `alt`
  (study §1 footnote). Not a defect.
- **Recorded:** after the gate crawl Shopify answered `/` with 429 to the
  crawler UA for a few minutes (§3). Not a crawl-time block; noted under hard
  rule 9.

### Rulings made this phase (binding; full text in the SDD ledger)

- Task 1 copy dissolved into per-task copy files written by the orchestrator (copy/rule bijection makes a copy-only commit red).
- Migrations per task: 0020 (T3), 0021 (T5), 0022 (T6).
- Categories: `head.directives-outside-head` indexability; `head.tags-outside-head` on-page; `render.noindex-changed` indexability; `render.canonical-changed` canonical; three `render.*` text rules on-page; no-response pair, `page.html-too-large`, `crawl.unreadable-encoding`, `robots.blocks-internal-urls` crawl; `headings.h1-too-long` on-page; `url.too-long` url (RuleCategory is closed; no "rendering").
- `headings.h1-too-long` → H1_MAX and `url.too-long` → URL_MAX added to THRESHOLD_IN_TITLE.
- `http.no-response` "inconclusive" = no second request was made (robots.txt or crawler policy refused it).
- Recheck: 5xx rows walked before no-response rows; no-response gets its own cap of 100 (5xx keeps 500); per-host breaker after 3 consecutive confirmed no-responses stamps the rest `host-unresponsive` (renders as capped).
- Memory measured at the gate, not argued (§4).
- `page.html-too-large` fires on any 2xx `too_large`; htmlBytes label "Bytes Read".
- Sitemap entries are not recorded as robots-blocked rows (`robots.blocks-sitemap-urls` already reports them).
- `head.directives-outside-head` cohort = fetched-OK, not judged (a misplaced directive is what can make a page non-judged).
- Outside-head flags mean "the FIRST occurrence of that tag is outside the head"; hreflang stays a count of alternates outside.
- Evidence spellings: "meta robots", "text", element closers in angle brackets beside `</head>`, `</html>`.
- `render.noindex-changed` compares META robots only (X-Robots-Tag cannot change by rendering).
- Extra column `rendered_tags_read` accepted (tells a script-removed tag from an unread one).
- The paginated labels are "Paginated (duplicate checks only)" (`site.health`) and "Paginated Pages Set Aside (Site-Wide)" (the duplicate rules).
- run.test ANALYZE flake fixed as its own task (7b) before the gate.
- `maxBlockedUrls` stays an engine config budget, not a `crawl_start` input (API allowlist closed, Talos seam).
- Gate: kept `crawl_b49eab7e` not re-judged in place; fresh crawl compared instead (§2). Memory recorded as peak RSS on the largest gate crawl; 50k owed (§4).

### Deferred minors (from the task reviews)

- T2: `host-unresponsive` rows count in `crawl_status` `noResponse.pending`; the breaker is visible only in the pass summary and the row reason — consider a `crawl_status` count.
- T2: stray over-long reflowed line at `src/crawl/recheck/recheck-server-errors.ts:~254`.
- T2: demo recheck line showed only 5xx counts; a noResponse line was added in Task 8 (label orchestrator-owned) — confirm on the demo.
- T3: the overflow count reaches no finding when `dropped > 0` and no recorded blocked row has inlinks (`noteOnLast` on an empty list) — only `crawl_status` shows it; needs a carrier and copy.
- T3: a redirect into a robots-blocked URL is recorded but reported by no rule; redirect-chain evidence quotes the blocked hop as visited.
- T3: `indexabilityOf` labels url-policy refusals "Blocked by robots.txt" (pre-existing); `ROBOTS_BLOCKED` now allows a distinct status.
- T3: no dedicated tests for the audit changes in `sitemap.uncrawled` `attempted:false`, the pagination `rel=next` lookup, hreflang `targetContext` / alternates-not-crawled, `url_params` inclusion.
- T3: layering — rules import `ROBOTS_BLOCKED_REASON_PREFIX` from `crawl/discovery.ts`; move to a leaf module. `render/select.ts` imports `rules/helpers`.
- T3: enqueue no longer early-returns when the frontier is full; the overflow UPDATE runs per page when the blocked budget is full.
- T3: the overflow `atLeast` floor counts redirect-only discoveries.
- T4: `url.too-long` homed under CHECK-28 (the checklist has no URL-length check); CHECK-30 is the alternative — settled in checklist text by Task 8, revisit if the checklist grows one.
- T5: misleading test name "a title inside an svg in the head…" (the svg is in the body) in `test/crawl/page-analyzer.test.ts`.
- T5: stray `</body>` / `</html>` false negatives (documented and pinned as KNOWN LIMIT tests).
- T5: canonical/title/description inside a body `<template>` flagged as outside (above, beside the effective-value ruling).
- T6: harness `sampled` exemption keyed by a name regex `/^render\.[a-z0-9-]+-changed$/` — use the five exported ids.
- T6: the JS-redirect exclusion also hides pages whose router `replaceState`-rewrites the URL (`redirect.js` still reports them) — docblock/ledger.
- T6: `canonicalKey` re-resolves against the page URL and ignores `<base href>` on the raw side (edge).
- T6: run.test ANALYZE flake from concurrent `runRules` callers — fixed in Task 7b.
- T7: `registry.ts:370` history comment quotes the old label name.
- T7b: the run.test ANALYZE test is coupled to `db.execute` and the exact statement form (fails loudly on a refactor).
- Gate: a 50k-scale RSS measurement under this ruleset is owed. (The kept-crawl re-judge, Review Focus 5 second half, is now shown: 0 errors, §5.)
- Final-review triage, "can wait": every deferred minor above (T2 to T7b, carried from the SDD ledger `progress.md`), plus the Task 9 wording minor (fixed in this wave).

### Carried from the plan's outline

Phase 24 (graph and international depth) and Phase 25 (signals and
calibration) as outlined at the foot of the plan.

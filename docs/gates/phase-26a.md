# Phase 26a gate: rules over existing data

Date: 2026-11-05. Spec: `docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md`
(the "Gate 26a" section). Plan: `docs/superpowers/plans/2026-11-05-phase-26a-rules-over-existing-data.md`.
Branch `worktree-phase-26a`, built on `47c26b5`. The first re-judge ran on `2c78017`'s code,
and the second (the numbers below) on `40dab51`, the `sitemap.lastmod-invalid` fix. The
suite and `tsc` ran on the commit that merges. Apart from `40dab51`, the Task 14 commits
are docs and one test comment.

**Verdict: clauses 1–4 pass.** The 40 new rules bring the ruleset to 0.20.0 with 154 rules
(49 page / 91 query / 14 metric). The stored lavishalice crawl was re-judged with no
re-crawl. Nine new rules fire there, with 635 findings, and the 1,270 findings of the
older rules came out byte-identical. The hand-check found **one false positive, and it is
fixed**: `sitemap.lastmod-invalid` judged "future" against the crawl's start, so on Shopify
all 205 product entries, stamped with the moment the sitemap was served, read as future.
The rule now judges against the end of the crawl, which every sitemap read precedes
(`40dab51`, §5.2), and fires on none of them. The
four HTTPS-only rules got their manual check on this HTTPS site (§5.3), and
`security.headers-not-recorded` stayed silent, as it must on a Phase 25 crawl. Live
traffic for the hand-check was 8 URLs, under the cap of 40.

## Gate clauses (spec "Gate 26a")

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite green, 0 skipped; `tsc` clean | **pass**: 104 files / 2,815 tests, 0 failed, 0 skipped; `tsc` clean | §1 |
| 2 | positive and negative tests per rule; a fixture page per rule, or a `SKIP_HARNESS_CLAIMS` entry with its reason | **pass**: 40 of 40 have DB or unit tests both ways; 34 fire on the fixture crawl; 6 joined `SKIP_HARNESS_CLAIMS` (16 → 22), each argued | §2 |
| 3 | calibration report against Screaming Frog | **pass**: `docs/gates/phase-26a-calibration.md`, 0 UNEXPLAINED / 0 MISMATCH, run with the SEO Spider's post-crawl analysis on; two thresholds moved (`HIGH_EXTERNAL_OUTLINKS` 100 → 10, owner confirmed; `DEEP_DEPTH` 5 → 3); every mapped filter calibrated except the HTTPS-only four | §3 |
| 4 | rules re-run over the stored lavishalice crawl (no re-crawl); each new rule's count reviewed against the site for false positives; the four HTTPS rules checked by hand | **pass**: 9 rules fire, 31 silent, every silence explained; samples hand-checked; 1 false positive found and fixed (`sitemap.lastmod-invalid`, 205 → 0); `security.headers-not-recorded` silent | §4, §5 |

## 1. Clause 1: suite and types

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **104 files / 2,815 tests, 0 failed, 0 skipped** (158 s, 2026-11-06 12:47 UTC), the run after the last edit of the post-crawl calibration (§3: `DEEP_DEPTH`, the hreflang probe, the script's analysis-aware reasons). Before it: **104 files / 2,806 tests, 0 failed, 0 skipped** (160 s, 2026-11-05 20:06 UTC). That was the run after the last edit of Task 14's fix round, on the tree of `40dab51` plus the docs and test-comment changes of the closing commit. Before the fix round, 104 files / 2,803 tests were green on `7ddab87`, and one earlier run on that commit had 1 failure, the pacing flake in §7. The fix round added 3 tests |
| `npx tsc --noEmit` | clean |
| baseline at the branch point (`47c26b5`) | 92 files / 2,502 tests (`.superpowers/sdd/…/baseline-test.log`) |
| phase delta | +12 files, +313 tests |
| ruleset | **0.20.0** (from 0.19.0; one bump for the phase, note in `src/rules/registry/registry.ts`) |
| rules | **154**: 49 page / 91 query / 14 metric (114 + 40). Finding rules split 33 critical / 54 warning / 53 info; the 40 new ones are 23 warning / 17 info |
| migrations | none in this phase (0000–0025 as Phase 25 left them); `EXTRACTION_VERSION` unchanged |

Three flakes from the known pacing family appeared during the phase's full runs. None is
caused by 26a. See §7.

## 2. Clause 2: tests per rule, and fixture coverage

**Both ways in the database.** Every new rule has a positive and a negative test against
Postgres or as a unit, in its owning file:

| family | rules | tests |
|---|---|---|
| security, served types | `security.hsts-missing`, `security.headers-missing`, `security.headers-not-recorded`, `security.http-url`, `security.mixed-content`, `resources.bad-content-type` | `test/rules/security-query.test.ts`, `test/rules/resources-query.test.ts` |
| directives | `indexability.nofollow`, `directives.restrictive`, `directives.unavailable-after` | `test/rules/directives.test.ts` |
| canonicals | `canonical.relative`, `canonical.fragment` (page); `canonical.chain`, `canonical.unlinked` (query) | `test/rules/canonical.test.ts`, `test/rules/canonical-graph-query.test.ts` |
| hreflang | `hreflang.inconsistent-return-code`, `hreflang.multiple-entries`, `hreflang.self-only`, `hreflang.unlinked-target` | `test/rules/hreflang-integrity-query.test.ts` |
| pagination | `pagination.non-indexable-target`, `pagination.loop`, `pagination.sequence-error` | `test/rules/pagination-query.test.ts` |
| links | `links.internal-nofollow`, `links.only-from-non-indexable`, `links.localhost`, `links.non-descriptive-anchor`, `links.high-outlinks` | `test/rules/link-hygiene-query.test.ts` |
| URL shape | `url.uppercase`, `url.underscores`, `url.non-ascii`, `url.spaces`, `url.multiple-slashes`, `url.repetitive-path`, `url.internal-search` | `test/rules/url-shape.test.ts` |
| sitemap entries | `sitemap.over-50k-urls`, `sitemap.url-too-long`, `sitemap.cross-host-loc`, `sitemap.lastmod-invalid` | `test/rules/sitemap-entries-query.test.ts` |
| pixel width | `title.pixel-too-long`, `title.pixel-too-short`, `meta-description.pixel-too-long`, `meta-description.pixel-too-short` | `test/rules/pixel-width.test.ts`, `test/rules/serp-width.test.ts` |

The review-focus cases from the plan are pinned there. A pre-Phase-25 crawl gives the
marker and never a clean header list. Directive tokens are bounded (`nofollowing`,
`max-snippet:-1` and `noimageindexer` do not fire). Relative canonicals and mixed-case
hreflang codes resolve before they are compared. Canonical and pagination cycles of any
length end the walk and are reported once per member. URL rules read the path only.

**On the fixture crawl.** New fixtures are in `test/fixtures/pages/authored-p26.ts`
(`exact: true`, built from the control recipe), and the threshold ladders are in
`test/fixtures/pages/calibration-p26.ts`. The harness assertion "every registered rule
speaks on this one crawl, save `SKIP_HARNESS_CLAIMS`" passes. So **34 of the 40 fire
on the fixture site**, and the `exact` fixtures and the control page carry the negative
side ("no rule fires on the control page", and every `exact` fixture fires exactly its
`expectedIssues`).

**`SKIP_HARNESS_CLAIMS` grew by six, from 16 to 22.** The brief expected six. Five came
from Task 3 and one from Task 10, and each has its paragraph in
`test/fixtures/harness.test.ts`:

| id | why no fixture page can fire it | proven by |
|---|---|---|
| `security.hsts-missing` | needs an HTTPS page fetched OK, and the fixture site is plain HTTP on 127.0.0.1 (deviation 1) | `security-query.test.ts`, and §5.3 on lavishalice |
| `security.headers-missing` | same | same |
| `security.http-url` | needs a crawl whose site URL is `https:` | same |
| `security.mixed-content` | needs an HTTPS page | same |
| `security.headers-not-recorded` | the marker for a crawl with pre-Phase-25 rows; the fixture crawl is current, so its condition is false by construction, and it also needs an HTTPS page | `security-query.test.ts`, which pins the marker, its silence on a current crawl and its silence on a crawl with no HTTPS page |
| `sitemap.over-50k-urls` | a 50,001-entry fixture sitemap would put 50,000 URLs into the fixture crawl's frontier; the threshold is the protocol's own limit, so nothing smaller fires it | `sitemap-entries-query.test.ts` (50,001 rows from `generate_series`, and silence at exactly the cap) |

The harness's prose comment at the claim test said "twenty-one", the count before Task
10. Task 14's fix round corrected it to twenty-two. The assertion reads the list, not the
comment.

## 3. Clause 3: calibration

The report is `docs/gates/phase-26a-calibration.md`, generated by `scripts/calibrate-sf.ts`.
It is a black-box Screaming Frog 25.1 run, headless, over the whole fixture site plus the
calibration ladders. It runs at the SEO Spider's starting configuration with ONE setting
changed: its post-crawl analysis is on (`--sf-config`, below). Every mapped filter is a
match or an explained divergence: 0 UNEXPLAINED and 0 MISMATCH.

- **How the analysis was switched on (reproducible).** The CLI cannot run the analysis
  and `--complete-post-crawl-actions` only finishes a paused crawl. The SEO Spider's MCP
  server (`--mcp-streamable-http-server`, bound to 127.0.0.1) returns its configuration
  as JSON (`sf_get_config_spider`, no category). That JSON, saved unchanged except for
  `crawlAnalysisConfig.autoAnalyse` `false` → `true`, under the ignored `sf-run/config/`,
  is passed with `scripts/calibrate-sf.ts --sf-config <file>`. The script refuses a path
  outside `sf-run/`, checks the SEO Spider's log says it loaded the file, and records the
  analysis setting from that log (`mAutoAnalyse=true`). Nothing was set over MCP, and the
  owner's SEO Spider settings were hashed before and after: unchanged. The config file is
  not committed.

- **Thresholds.** `HIGH_INTERNAL_OUTLINKS` 1000 and the four pixel bounds (561 / 200 /
  985 / 400) are confirmed by Screaming Frog's own boundaries. `SLOW_MS` is kept, because
  Screaming Frog has no response-time issue to read a boundary from. `THIN_WORDS` 150 is
  kept per the spec, because ours counts main-content words.
- **`DEEP_DEPTH` moved from 5 to 3.** With the analysis on, Screaming Frog flags the
  click-depth ladder from depth 4 and not at 3, and its crawl depths equal ours.
  `structure.deep-page` is an existing rule, so older crawls gain findings: on the
  lavishalice crawl, 18 pages are deeper than 3 links where 6 were deeper than 5
  (read-only count, before the rule's indexability filter; not re-judged). CHECK-31
  already fails key pages more than 3 clicks deep, so rule and checklist now agree. The
  absorbed `/deep/N` chain now reads the constant, so `/deep/4` … `/deep/7` fire.
- **`HIGH_EXTERNAL_OUTLINKS` moved from 100 to 10. This is a product call, flagged to
  the owner.** Screaming Frog flags a page with more than 10 distinct external targets.
  The brief said to take its boundary, but at 10 the finding is busy: on lavishalice it
  fires on a payment-provider page and on the privacy policy (§5.1). It is info
  severity, and the value is one constant in `src/rules/thresholds.ts`.
- **The six post-crawl filters, now calibrated.** Pagination Loop (3/3) and
  Non-Indexable Page Inlinks Only (1/1) match exactly. Canonicals:Unlinked matches on the
  canonical targets both tools judge (2 both; the 2,212 SF-only are the canonical trap,
  which Ariadne never fetches). Pages With High Crawl Depth matches after the move to 3
  (11 both; 2 SF-only trap URLs). Hreflang:Unlinked hreflang URLs: the one target is
  Ariadne-only because the SEO Spider does not crawl hreflang targets at this
  configuration (`crawlHreflang` false), so it never fetched the page. Crawl scope, not
  the rule.
- **`hreflang.self-only` and a self `x-default`: a definition difference for the
  controller.** A probe page whose one alternate (`en`) is itself is listed by both
  tools. The harness fixture, whose alternates `en` and `x-default` both name itself, is
  Ariadne-only: Screaming Frog does not count that page as self-reference only. Ours
  reports it because neither page names another version of itself. Recommendation: keep
  ours. The rule is unchanged.
- **Two carried notes.** First, Screaming Frog's title widths run 0–12 px wider than
  `serpWidth`, so near 561 px ours can under-report against it. We keep our own measured
  table, as the spec requires. Second, Screaming Frog also checks pagination sequence
  errors in the reverse direction; ours checks the direction the spec defines.
- The HTTPS-only rules cannot be calibrated on a plain-HTTP fixture site. Their manual
  check is §5.3.

## 4. Clause 4: the lavishalice re-judge

**What was run.** The crawl is `crawl_11e15602-63c4-4aa4-8b94-fb3b65908f19`: the Phase 25
gate crawl of `https://lavishalice.com/`, 602 rows, `fetchResources: false`, Shopify
profile, every row at `extraction_version` 1. It was kept in the dev database as
evidence. A one-off script outside the committed tree (`.superpowers/sdd/…/rejudge.mts`)
called `ApiService.runRulesForCrawl(crawlId)`, the path the MCP `crawl_rules` tool takes,
twice. The first run was at 2026-11-05 19:39:27 UTC on `2c78017`. It found the
`sitemap.lastmod-invalid` false positive of §5.2 and answered
`{pagesScanned: 602, findings: 2105, metrics: 92}`. The second run was at
2026-11-05 20:02:59 UTC on `40dab51`, after the fix, and answered
`{pagesScanned: 602, findings: 1905, metrics: 92}` in 5.2 s. No page was fetched for
either run. The crawl's issues and metrics were snapshotted before each run and compared
after it. Both runs use the default listing cap of 200 per rule. The tables below are the
second run.

### 4.1 The new rules: findings per rule

`reported` is the rows written. `total` is the rule's exact count where a truncation note
says it was capped.

| rule | severity | reported | total | hand-check verdict |
|---|---|---:|---:|---|
| `security.headers-missing` | info | 200 | **504** | true: every 200 page lacks `referrer-policy`, and nothing else is missing (§5.3) |
| `meta-description.pixel-too-long` | warning | 289 | 289 | true (§5.1) |
| `title.pixel-too-short` | info | 114 | 114 | true (§5.1) |
| `title.pixel-too-long` | warning | 17 | 17 | true (§5.1) |
| `links.non-descriptive-anchor` | info | 5 | 5 | true (§5.1) |
| `indexability.nofollow` | warning | 4 | 4 | true, and deliberate on the site (§5.1) |
| `links.high-outlinks` | info | 2 | 2 | true at the calibrated limit (§5.1) |
| `url.internal-search` | warning | 2 | 2 | true (§5.1) |
| `meta-description.pixel-too-short` | info | 2 | 2 | true (§5.1) |
| `security.hsts-missing` | warning | 0 | | silent, correctly: HSTS on 504 of 504 (§5.3) |
| `security.headers-not-recorded` | info | 0 | | silent, correctly: 602 of 602 rows at `extraction_version` 1 |
| `security.http-url` | warning | 0 | | silent, correctly: no `http:` page row; `http://` answers 301 (§5.3) |
| `security.mixed-content` | warning | 0 | | silent, correctly: 0 `http:` references among 52,998 `page_resources` rows (§5.3) |
| `resources.bad-content-type` | info | 0 | | not measured: all 3,837 resource rows are unfetched, and `resources.not-fetched` fired (1) and says so |
| `directives.restrictive` | warning | 0 | | silent: no snippet or image directive in any robots meta or `X-Robots-Tag` |
| `directives.unavailable-after` | warning | 0 | | silent: no `unavailable_after` anywhere |
| `canonical.relative` | info | 0 | | silent: 504 canonicals, all absolute |
| `canonical.fragment` | warning | 0 | | silent: no canonical contains `#` |
| `canonical.chain` | warning | 0 | | silent: the 57 pages canonicalised elsewhere name crawled targets, none of which canonicalises on |
| `canonical.unlinked` | info | 0 | | silent: every one of those targets has an internal inlink |
| `hreflang.inconsistent-return-code` | warning | 0 | | silent: every page declares the same seven codes; five name other ccTLD sites (`lavishalice.us`, `.au`, `.ie`, `.ae`, `.ca`), which are outside the crawl, and `en` / `x-default` name the page itself (447 pages) or, on the 57 canonicalised pages, their canonical (114 of 114 rows) |
| `hreflang.multiple-entries` | warning | 0 | | silent: no page lists one code for two targets |
| `hreflang.self-only` | info | 0 | | silent: seven targets per page |
| `hreflang.unlinked-target` | info | 0 | | silent: the crawled targets are the site's own linked pages |
| `pagination.non-indexable-target` | warning | 0 | | not reachable here: all 33 `rel=next` targets are uncrawled (`pagination.next-target-uncrawled` 33), and no page has `rel=prev` |
| `pagination.loop` | warning | 0 | | same |
| `pagination.sequence-error` | info | 0 | | same |
| `links.internal-nofollow` | warning | 0 | | silent: no link on the site carries `nofollow` |
| `links.only-from-non-indexable` | warning | 0 | | silent: an SQL recount (indexable 200 pages whose internal inlinks all come from non-indexable sources) finds 0 |
| `links.localhost` | warning | 0 | | silent: no external link to a loopback, private or `localhost` host |
| `url.uppercase` | info | 0 | | silent: the 152 URLs with a capital have it in the query (`?country=CA`), never the path |
| `url.underscores` | info | 0 | | silent: no underscore in any path |
| `url.non-ascii` | info | 0 | | silent: no non-ASCII escape in any URL |
| `url.spaces` | warning | 0 | | silent: no `%20` |
| `url.multiple-slashes` | warning | 0 | | silent: no `//` in any path |
| `url.repetitive-path` | warning | 0 | | silent: no immediately repeated segment |
| `sitemap.over-50k-urls` | warning | 0 | | silent: the largest document has 206 entries |
| `sitemap.url-too-long` | info | 0 | | silent: no `<loc>` over 2,048 characters |
| `sitemap.cross-host-loc` | warning | 0 | | silent: every `<loc>` is on `https://lavishalice.com/` |
| `sitemap.lastmod-invalid` | info | 0 | | silent after the fix: 440 entries carry a lastmod, all well-formed, none after the crawl ended. The first run reported 205 (200 listed), all false positives (§5.2) |

**Nine fire, thirty-one are silent**, and every silence has a reason drawn from the stored
evidence. The one rule this crawl cannot answer, `resources.bad-content-type`, is covered
by the marker that already claims CHECK-51 (`resources.not-fetched`). That is the
arrangement the plan made for it.

### 4.2 The existing rules, before and after

All 27 rules that fired at 0.19.0 fired again at 0.20.0 with the **same 1,270 findings,
byte-identical** (rule, dedupe key, page, severity and evidence compared row by row). Only
the `ruleset_version` stamp moved. Total findings went from 1,270 to 1,905 (+635, all from
the nine rules above). Between the first and second runs, only the 200
`sitemap.lastmod-invalid` rows changed, and they were removed. The other 1,905 rows are
byte-identical across both runs, and so are all 92 metric rows. The lastmod findings were
info-level and sat on pages that already had other findings, so `site.health` did not
move.

Of the 92 metric rows, 91 are byte-identical. The one that moved is `site.health`, whose
partition counts findings by severity:

| `site.health` | 0.19.0 | 0.20.0 |
|---|---:|---:|
| `urlsWithCritical` | 1 | 1 |
| `urlsWithWarningOnly` | 339 | 438 |
| `urlsWithInfoOnly` | 103 | 4 |
| `urlsClean` | 0 | 0 |
| `urlsTotal`, `pagesNotAuditable`, `urlsCanonicalised`, `urlsNoindex` | 443, 98, 57, 4 | unchanged |

**Reconciliation.** Exactly 99 pages moved from info-only to warning-only, and no page moved
any other way. The partition counts judged pages only: fetched OK, 200, indexable, and not
canonicalised elsewhere. Each moved page's worst finding was `info` under the 27 older
rules and is `warning` with the 26a rules added. Every one of the 99 is a judged page, and
each gained exactly one new warning rule:

| new warning rule the moved page gained | moved pages (distinct) |
|---|---:|
| `meta-description.pixel-too-long` alone | 98 |
| `title.pixel-too-long` alone | 1 |
| both | 0 |
| **total** | **99** (= 103 − 4 = 438 − 339) |

The other two 26a warning rules moved no page. `indexability.nofollow`'s 4 pages are the
noindexed `/search?q=` results. They sit outside the partition, in `urlsNoindex`, and
already carried a critical finding (`hreflang.non-indexable-target`). Both of
`url.internal-search`'s pages already had a warning (`content.thin`). Across the whole
crawl, the 26a warnings land on distinct pages as follows: `meta-description.pixel-too-long`
289, `title.pixel-too-long` 17 (2 of them also carry the description rule), `indexability.nofollow` 4 and
`url.internal-search` 2. Pages that already had a warning did not move. That accounts for
the gap between these counts and 99. The SQL is in the fix report (`task-14-report.md`,
fix round 1), over the stored issues: the per-page maximum severity across the 27 older
rule ids, set against the maximum across all ids. This is the additive ground the ruleset
bump records (`docs/talos-surface.md` §11).

## 5. Hand-check

**Method.** For each rule that fired, up to five findings were sampled and checked against
the stored evidence: `pages`, `links`, `hreflang`, `sitemap_urls` and `response_headers`.
A live fetch was used only where the evidence could not settle a question. Live traffic
followed the controller's politeness ruling (hard rule 9): **8 distinct URLs**, GET only,
one at a time, at least 2.5 s apart, `redirect: manual`, with the crawler's own
User-Agent from `src/crawl/loop.ts` (`AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)`).
The requests ran 19:48:07–19:48:27 UTC. Every one answered without a 429.

| # | URL | answer | used for |
|---|---|---|---|
| 1 | `https://lavishalice.com/` | 200 | security headers, meta referrer, `http:` references |
| 2 | `/collections/printed-dresses` | 200 | same |
| 3 | `/products/maxine-tailored-fit-flare-trousers-in-black` | 200 | same |
| 4 | `/pages/faqs` | 200 | same, plus the "here" anchors |
| 5 | `/blogs/news` | 200 | same |
| 6 | `http://lavishalice.com/` | 301 → `https://lavishalice.com/` | `security.http-url` |
| 7 | `/search?q=blazers` | 200, `X-Robots-Tag: noindex, nofollow` | `indexability.nofollow` |
| 8 | `/sitemap_products_1.xml?from=8318238458166&to=16162418524542` | 200 | `sitemap.lastmod-invalid` (§5.2) |

### 5.1 Rules that fired and were confirmed

- **`title.pixel-too-long` / `title.pixel-too-short` /
  `meta-description.pixel-too-long` / `meta-description.pixel-too-short`.** Five
  findings of each were sampled at random (two for the description-short rule, which
  has only two). Each stored string was measured again in Chromium as a whole string,
  using canvas `measureText` at 20 px / 14 px Arial, with kerning off and with kerning
  on. Every recomputed `serpWidth` equals the stored `pixelWidth`, and the whole-string,
  no-kerning width equals the per-glyph sum to 0.1 px. Kerning moves a string by at most
  1.5 px, and no sample changes side of its bound. Examples: the home title "Lavish Alice
  | Shop Womens Clothing & Accessories Online | UK" is 572.9 px against 561; the
  description on `/pages/covid-19-update`, "view our delivery information", is 177.4 px
  against 400. The five sampled product and collection descriptions run 1,893–2,016 px
  (the burgundy dresses one is 320 characters), so `meta-description.too-long` fires on
  them too. That is the pairing the report skill tells a reader to merge. **No false positive.** Against Screaming Frog
  this measure runs narrow, not wide (§3), so the direction of any error is under-report.
- **`links.non-descriptive-anchor` (5 of 5).** The `links` rows show the whole anchor
  "here" (twice "Here") on internal links: `/pages/faqs` → `/pages/delivery` and
  `/pages/returns`, `/pages/returns` → `/pages/contact-us` and `/pages/privacy-policy`, and
  one each on the giveaway terms, the returns tab and the terms and conditions. The
  "Here" link to `returns.lavishalice.com` is external and correctly not counted. Live
  `/pages/faqs` still has `<a href="/pages/delivery">here</a>` and
  `<a href="/pages/returns">here</a>`. **No false positive.**
- **`indexability.nofollow` (4 of 4).** These are `/search?q=blazers`, `jumpsuits`,
  `party+dress` and `midi+dress`. Each stores `X-Robots-Tag: noindex, nofollow` (source
  `header`), and the live fetch of `?q=blazers` sends the same header. The rule is
  right. The directive is Shopify's own on search results and is deliberate, which the
  rule's fix text allows for ("Leave it only if the page is deliberately closed off").
  The audit skill now says to judge it. **No false positive.**
- **`links.high-outlinks` (2 of 2).** `/pages/klarna-buy-now-pay-later-clothes` has 13
  distinct external targets and `/pages/privacy-policy` has 11, against the calibrated
  limit of 10. Both are correct at that limit. One of the privacy page's 11 is
  `http://www.lavishalice.com/`, the site's own `www` host over HTTP. It counts as
  external because `is_internal` is same-origin, which is also Screaming Frog's
  default for subdomains. Without it the page sits exactly at 10 and would not fire.
  Four more pages sit at exactly 10. This is the busy-threshold concern of §3 seen on a
  real site, not a rule defect. **No false positive.**
- **`url.internal-search` (2 of 2).** `/search` is the bare search page: indexable, title
  "Search", 4 words of its own, and linked from all 504 pages through the header's "Open
  search" link. `/pages/search` is a search results page served at a content path: title
  "Search", H1 "Search Results", 6 words of its own, indexable and **listed in the
  sitemap**. Both are what the rule exists to find. The `?q=` result pages are noindexed
  by header and correctly do not fire. **No false positive.**

### 5.2 `sitemap.lastmod-invalid`: a false positive, fixed

**What the first re-judge reported.** All 205 findings had `reason: "future"` and the same
`lastmod`, `2026-11-04T17:17:08+00:00`. They were every dated entry of
`sitemap_products_1.xml` (206 entries; one has no lastmod). The crawl started at
17:17:00.5 and ran discovery, which reads the sitemaps, in the seconds after. The live
fetch of the same document at 19:48:26.801 UTC (§5, row 8) returned **207 entries, every
one with `lastmod` 2026-11-05T19:48:26+00:00**, the second it was served. So Shopify stamps
every product's lastmod with the moment it generates the sitemap. At the moment it was
served, the value was "now", not the future.

**Why it was a false positive.** The rule judged "future" against `crawls.started_at`, but
a crawl reads its sitemaps after its row is created. Any value stamped between the start
and the read was reported as future, though it was not in the future when the site served
it. The controller ruled it a false positive.

**The fix** (`40dab51`, `fix(rules): sitemap lastmod is future only after the sitemap was
read (26a)`):

- "Future" is now judged against the time the sitemap was read.
- The crawl records no per-document fetch time. The discovery evidence (`discovery_jsonb`,
  read by `readCrawlEvidence`) holds outcomes and counts, no timestamps. So the reference
  is `crawls.finished_at`. Every sitemap a crawl reads is read before the crawl closes, so
  a value after `finished_at` was in the future when it was served.
- A crawl with lastmod values and no `finished_at` makes the rule throw, naming the crawl.
  It never falls back to `started_at` (hard rule 7). Every closed crawl has `finished_at`,
  because `closeCrawl` writes it with the status, and the rules refuse a running crawl. A
  crawl with no lastmod at all is not refused, because no verdict depends on the
  reference.
- A value inside the crawl's window is no longer judged. The rule cannot tell whether it
  was in the future when read, so it says nothing.
- The copy, the checklist, the ruleset note and both skills now say "dated after the crawl
  ended, so already in the future when the sitemap was read".
- Tests are in `test/rules/sitemap-entries-query.test.ts`:
  - "is silent on a lastmod stamped after the crawl began but before it ended" covers the
    lavishalice instants: at the start, 8 s after it and 1 s before the end are silent,
    while 1 s after the end and the next day fire. This test fails against the old
    reference (checked).
  - "throws, naming the crawl, when there are lastmod values and no finished_at".
  - "does not refuse a crawl with no finished_at when no entry carries a lastmod".

**After the fix,** the second re-judge reports 0 `sitemap.lastmod-invalid` findings. All 440
dated entries on lavishalice are well-formed and none is after 17:32:28.6, when the crawl
ended.

**What the rule no longer sees.** Shopify's habit of stamping every entry with the time the
sitemap was generated is a real weakness: a lastmod that always says "now" teaches search
engines to ignore it. But it is a different finding from "future", and it is not reported
in 26a. It is listed as a 26b candidate in §8.

### 5.3 The four HTTPS-only rules (deviation 1, checked by hand)

The fixture site cannot exercise these rules and Screaming Frog cannot calibrate them
(§2, §3). This is their check on a real HTTPS site.

- **`security.hsts-missing`: silent, correct.** Stored: `strict-transport-security:
  max-age=7889238` on 504 of 504 fetched-OK pages, and on every other answered row.
  Live: the same value on all 7 HTTPS answers.
- **`security.headers-missing`: 504 findings, all `missing: ["referrer-policy"]`,
  correct.** Stored on all 504: `content-security-policy: block-all-mixed-content;
  frame-ancestors 'none'; upgrade-insecure-requests;`, `x-content-type-options:
  nosniff`, `x-frame-options: DENY`, and no `referrer-policy`. The header is on the
  allowlist (`RESPONSE_HEADER_ALLOWLIST`), so its absence is a fact, not a gap in what
  was stored. Live, on 5 HTML pages: no `Referrer-Policy` header, and no
  `<meta name="referrer">` in the HTML, which would also set a policy and which the rule
  cannot see. So the evidence is right on every sampled page. A note for the owner: with
  no policy, today's browsers apply `strict-origin-when-cross-origin`, which is the value
  the fix recommends. The finding is therefore hardening rather than an exposure. That
  is the spec's definition ("no or unsafe `referrer-policy`") and Screaming Frog's
  ("Missing Secure Referrer-Policy Header"), and it is info severity. No change.
- **`security.http-url`: silent, correct.** The crawl has no `http:` page row, and live
  `http://lavishalice.com/` answers 301 to `https://lavishalice.com/`.
- **`security.mixed-content`: silent, correct.** 0 of 52,998 `page_resources` rows are
  `http:`. Live, on the 5 HTML pages, no `<img>`, `<script>` or `<link>` has an `http:`
  `src` or `href`. The site also sends `block-all-mixed-content` and
  `upgrade-insecure-requests`.
- **`security.headers-not-recorded`: silent, as required.** Every row is
  `extraction_version` 1, which is the Phase 25 evidence layer. A firing here would have
  been a bug. Its firing on a pre-25 crawl is pinned in `security-query.test.ts`.

### 5.4 False positives

**One false positive was found, and it is fixed: `sitemap.lastmod-invalid`, 205 findings on
the first re-judge, 0 after.** The cause was a reference instant earlier than the sitemap
read (§5.2). The fix is `40dab51`, with tests in the owning rule's test file.

The other nine rules that fire showed no false positive in the samples. Two carry a caveat,
and neither is a false positive:

1. `links.high-outlinks`: correct at 10, but the limit is busy on real pages (§3). This is
   the flagged product call.
2. `security.headers-missing` (referrer-policy only): correct by the spec, but it is
   hardening (§5.3).

**One observation outside the hand-check.** This site's `robots.txt`, stored in the crawl's
`discovery_jsonb`, carries comment lines addressed to AI agents. They were recorded as data
and not acted on.

## 6. Controller rulings this phase

The ledger is in `.superpowers/sdd/2026-11-05-phase-26a-rules-over-existing-data/progress.md`.
The binding ones:

- `security.hsts-missing` and `security.headers-missing` are query rules that refuse a
  crawl with any pre-25 row and fire the marker (deviation 2). Mixed crawls get the
  marker too.
- The JS content types follow the WHATWG "JavaScript MIME type essence" list, without
  "module".
- `unavailable_after` uses a weekday-aware RFC 1123 pattern, and the earliest of the meta
  and header dates is reported.
- A canonical cycle longer than `CANONICAL_MAX_HOPS` is reported `hopLimitReached`, not
  `loop`.
- Hreflang targets use the engine URL identity (`/a` ≠ `/a/`). `inconsistent-return-code`
  fires on disjoint code sets, with `x-default` excluded. `unlinked-target` ignores
  redirecting inlinks.
- `pagination.loop` is a depth-bounded walk without `CYCLE` (O(k²) path copies avoided).
  `sequence-error` fires when B has no `rel=prev` at all (Screaming Frog agrees, §3).
- `links.high-outlinks` is proven by a fixture with `HIGH_EXTERNAL_OUTLINKS + 1` external
  links. `links.localhost` keyset-batches hosts into a per-run temp table.
- `url.spaces` does not read `+` in a path as a space.
- `sitemap.cross-host-loc` is silent when a foreign-host document lists the crawled site's
  own URLs (a cross-submission).
- CHECK-08 left the metric-only list, and CHECK-84..86 stay outside `CRAWL_CHECK_IDS`.
- `HIGH_EXTERNAL_OUTLINKS` = 10 from the Screaming Frog run (owner confirmed).
  `DEEP_DEPTH` = 3 from the analysis-on run; the six post-crawl filters are calibrated
  (§3).
- Task 14 fix round: `sitemap.lastmod-invalid`'s `future` on lavishalice is a false
  positive. It is judged against the sitemap read time (the crawl's `finished_at`, since no
  per-document time is recorded), with a named error and no fallback when that time is
  missing. No new reason is added in 26a.
- Task 14: at most 40 live URLs, at least 2 s apart, the branded UA, GET only.

## 7. Known flakes (pre-existing pacing family, not caused by 26a)

Three timing tests each failed once under full-suite load during the phase, and passed
alone and on the next full run:

- `test/crawl/loop.test.ts`, describe "platform profile", "re-enters the recorded profile
  on a resume without asking again". It asserts a paced gap of at least 985 ms and saw
  982 ms once (Task 13).
- The same describe, "clamps mid-crawl off the seed fetch when the host probe is off,
  and records when" (`loop.test.ts:2220`, the same `minGap() >= 1000 - SLACK_MS`
  assertion). It saw 981 ms in this gate's first full run on `7ddab87`, 104 files /
  2,803 tests with 1 failed and 0 skipped. All 10 "platform profile" tests then passed
  run alone (`-t "platform profile"`, 43 s).
- `test/crawl/renderer.test.ts:1321`, inside "never predicts a URL twice once a prediction
  for it was wrong" (Task 10, and once unidentified in Task 11).

Evidence that 26a did not cause them:

- Neither test file was changed on this branch (`git diff main --stat` lists neither).
- The only `src/crawl/` change in 26a is `src/crawl/url-policy.ts` exporting two
  existing constants (`BLOCKED_HOSTS`, `BLOCKED_HOST_SUFFIXES`) with no behaviour change.
- `loop.test.ts` imports two rule modules, and the only 26a change in either
  (`link-graph.ts`) moved `DEEP_DEPTH` into `thresholds.ts` and re-exports it. The value
  later moved from 5 to 3 (§3), and pacing does not read it.
- Both are the load-sensitive tests the Phase 25 gate already listed on `main`: the
  renderer test by name ("about 2 of 36 loaded runs"), and "the platform-profile pacing
  cases in `loop.test.ts`".

The two `loop.test.ts` cases measure the gap between request ARRIVALS at the
fixture server, so scheduler delay on the earlier arrival under load shrinks the gap
the server sees, even though the gate released the requests 1,000 ms apart. Phase 25
fixed the same weakness in a renderer test (`caf9c40`) by asserting the gate's slot
guarantee instead of pairwise gaps. These two want the same fix. That is the flake
ticket Phase 25 asked for, and it is still open.

## 8. Owner follow-ups and deferred items

**Owner actions:**

- **Screaming Frog's crawl list.** The calibration left `ariadne-calibration-26a` entries
  (and `ariadne-trial`, `ariadne-trial-analysis`, `ariadne-mcp-trial`) in the SEO
  Spider's own crawl list. The agent was not allowed
  to delete them. They are the owner's to remove (`--delete-crawl <id>`).
- **Decision: `hreflang.self-only` with a self `x-default`** (§3). Screaming Frog does not
  list such a page; ours does. Recommendation: keep ours.
- **Decision: `DEEP_DEPTH` = 3** (§3). It follows Screaming Frog's boundary, widens an
  existing rule's findings on older crawls, and agrees with CHECK-31.
- **Dev database residue.** 113 crawl rows started 2026-11-05 17:20:34–17:21:29 UTC,
  7 of them still `running`, were left by an interrupted suite run during the phase.
  The whole dev database holds 8 `running` and 2 `queued` rows. It is the test
  database only. Nothing here deleted them.
- **Decision:** `HIGH_EXTERNAL_OUTLINKS` = 10 (§3).
- **26b candidate: sitemaps that stamp lastmod with their generation time.** Shopify's
  product sitemap gives every entry the instant it was served (§5.2). That makes lastmod
  useless to a search engine, and 26a no longer reports it, because "future" now means
  after the crawl ended. A 26b rule could report a document whose dated entries all share
  one instant inside the crawl's window, once per document. It would need its own id or
  reason and a ruleset bump.

**Deferred minors from the task reviews.** They are in the SDD ledger and none blocks the
gate. The ones with a correctness edge:

- `sitemap.lastmod-invalid` uses `pg_input_is_valid`, which needs Postgres 16. This is
  the first use. The minimum Postgres version for Talos deployment is not documented.
- `sitemap.cross-host-loc` would be silent, not loud, if `crawls.site_url` ever lacked
  `scheme://host`. It wants an assertion like `assertNormalisedSitemap` (rule 7).
- `directives.unavailable-after` parses zone-less dates in machine-local time
  (`Date.parse`), so results can skew by a few hours. UTC would be deterministic.
- `pagination.non-indexable-target` still counts non-HTML 200 targets as indexable.
- Pixel widths round to one decimal at the bounds (a blind spot under 0.05 px). The soft
  hyphen and zero-width characters measure 0.
- Test gaps: RFC 850 and ISO `unavailable_after` forms; truncation for three link rules;
  a NULL `is_indexable` source; the `/a` vs `/a/` and redirecting-inlink hreflang rulings.
- Stale comments: several derivation comments in `harness.test.ts` (the "twenty-one"
  exemption count is corrected), docblock pointers in `thresholds.ts`, and blank-line
  runs left by Task 1.

**Carried from earlier gates:** the 50k memory measurement (yellow.com.mt allowlist);
`crawl_status.pagesCrawled` reading 0 during a crawl; Shopify's blocked module showing
as an exception on every rendered page (Phase 25 §8); the flake ticket (§7).

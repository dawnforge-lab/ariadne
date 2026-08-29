# Phase 8 gate — the whole picture, and a measurement that cancels

**Date:** 2026-08-29
**Code:** branch `worktree-phase-8-full-picture`, base `12dd14d` (the Phase 7
branch head `c7f55c9` plus this phase's plan). The crawl, the render pass and the
rules ran at **`7e9c533`** with ruleset **0.6.0** and migrations 0000–0011. Ten
commits carry the phase:

| | |
|---|---|
| T1 symmetric render measurement | `43cf3fc`, `adfeb79` |
| T2 agent-directed rendering | `ed08f35`, `0adc6d2` |
| T3 client-supplied sitemap URLs | `4d86af1` |
| T4 full-picture caps | `44007a5`, `df116bf` |
| T5 template inference | `9fdaafa`, `7e9c533` |
| T6 part C, the export knob + the skill reconciliation | `e09351e` |

plus the commit that carries this file.

**Every number below was measured on the runs named here** — read off the HTTP API
during the run and quoted in the two task reports
(`.superpowers/sdd/2026-08-29-phase-8-full-picture/task-6a-report.md`,
`task-6b-report.md`), or re-queried from this crawl's own rows in the dev database
while this file was written. Where a figure in a task report was an approximation,
this file carries the queried number and says so (§7.2 is the one).
**`docs/gates/phase-6.md`, `docs/gates/phase-7.md` and
`audits/lavishalice.com/render-diagnosis.md` are untouched by this phase.**

**Verdict: PASSED.** A third crawl of the same site, a day after the second,
reproduced its 551 pages, 35,145 links and 438 sitemap URLs exactly, reproduced
nineteen of twenty-one rules' finding counts to the finding, and answered from
measurement the four questions Phase 7 recorded as open. The crawl was polite from
first contact to last: **zero blocked pages, zero fetch failures, zero back-off
escalations, zero manual interventions** — for the third crawl running. A
skills-only session then produced the full deliverable set from the API alone.

**The headline is one column of numbers.** Phase 7 found that
`renderableWordCount` and the browser's `innerText` differ by a fixed ~425-word
constant, which made `content.csr-dependent`'s comparison unreachable whatever the
site did. Phase 8 put both sides of that comparison through the same analyzer.
`renderedRenderable − renderable` is now **exactly 0 on ten of the fourteen
rendered pages**, the old constant reproduces beside it at 425–489 unchanged, and
the four pages where it is not zero are the four where the theme's JavaScript
actually writes text. The chrome did not go away; it stopped being counted on one
side only.

---

## What the gate is

The plan states Task 6 as a delta. Seven clauses, each answered below with its
measurement:

| | The plan asked | Answered |
|---|---|---|
| 1 | the cancellation proven on real pages, `renderedRenderable` vs `renderable` quoted | §2 — delta 0 on 10 of 14, the old constant reproduced beside it |
| 2 | `content.csr-dependent`'s comparison reachable | §3 — ratio 0.32–0.73 → 1.000–1.161; one page 27 words from the **floor** arm, with the 2× ratio arm still the binding one |
| 3 | the agent-directed render flow driven from the skill | §4 — 14 named URLs, 0 failures, `selectionMode: "explicit"` with four nulls |
| 4 | supplied-sitemap provenance visible | §5 — `sitemapSources` and `suppliedSitemaps` side by side, one document, six fetches |
| 5 | full listings: every orphan, the complete near-duplicate set, the uncapped cost | §6 — 243 and 16,789, 13.3× the findings for +0.6 s and ~2 MB |
| 6 | template count 196 → N | §7 — **13**, on the site that produced the complaint four phases running |
| 7 | the full deliverable set from the reconciled skills | §8 — 82 checks, three files, 57 API calls |

A gate that only records its passes teaches nothing, so the honest residuals get
more room than the successes: the thin floor still lies on the 537 pages nobody
rendered (§2.3), the corpus predicted twelve templates and the site produced
thirteen (§7.1), `structure.deep-page` is silent for the second audit running
(§11), and the metric table lost 938 rows in a way no version number records
(§7.2).

---

## The three audits, side by side

| | **audit 1** (P6) | **audit 2** (P7) | **audit 3 — this phase** | Why it moved |
|---|---|---|---|---|
| `crawlId` | `crawl_2af4daf1…` | `crawl_3f3ab847…` | **`crawl_02ff6f7a…`** | |
| Date | 2026-08-28 | 2026-08-28 | **2026-08-29** | |
| Ruleset | 0.4.0 | 0.5.0 | **0.6.0** | T1 re-sided `content.csr-dependent` |
| **Pages crawled** | 551 | 551 | **551** | the site is the same site |
| **Links recorded** | 35,145 | 35,145 | **35,145** | — |
| **Sitemap URLs** | 438 | 438 | **438** | — |
| **`blockedPages`** | 0 | 0 | **0** | politeness, third visit (§10) |
| Wall | 996.3 s | 1111.8 s | **1111.9 s** | 551 × 2000 ms = 1102 s; the Phase 7 crawl reproduced **to a tenth of a second** |
| Peak sampled RSS | ≈ 277 MB | ≈ 223 MB | **≈ 225 MB** | uncapped rules cost ~2 MB (§6.3) |
| **Findings** | 1,314 | 1,326 | **17,658** | `findingCap: null` — the cap was hiding 16,332 rows, not preventing them (§6) |
| **Metric rows** | 855 | 1,023 | **85** | the template collapse; 938 rows were one row per singleton URL shape (§7.2) |
| **Distinct `page_type`** | **196** | **196** (190 singletons) | **13** (0 singleton-only templates) | T5's population pass (§7.1) |
| **Pages rendered** | 38 rows / 2 passes | 28 / auto | **14 / explicit** | the agent named the list (§4) |
| Render selection mode | *(field did not exist)* | `auto` | **`explicit`**, budget/suspects/sampled/truncated all `null` | §4.2 |
| `rulesRunAt` | *(field did not exist)* | 21:55:35.006Z | **15:43:54.879Z** | |

**Three numbers moved and one did not, and the one that did not is the control.**
Pages, links and sitemap URLs are identical across all three audits eleven hours
and one day apart. That stability is what makes every difference in the table
attributable to the engine rather than to the site.

---

## 1. The crawl

Started 2026-08-29T15:21:44.994Z, finished 15:40:16.915Z, over HTTP on
`127.0.0.1:8787` with a fresh 48-character bearer token and
`ARIADNE_ALLOWED_DOMAINS='lavishalice.com,*.lavishalice.com'`. `runCrawl` was
never called directly. Request body, verbatim:

```json
{"siteUrl":"https://lavishalice.com/","maxPages":3000,"maxConcurrency":2,
 "perHostDelayMs":2000,"probeHosts":true,
 "sitemapUrls":["https://lavishalice.com/sitemap.xml"],"findingCap":null}
```

Eleven polls at ~120 s. **Every 120-second window moved `done` by exactly 60** —
one request per 2000 ms — for the whole run, with not one exception.
`hostSpacingMs` began at 2000 and ended at 2000; the ratchet never spoke. RSS was
flat at 218–225 MB, peaking at 225.0 MB. `pending` rose 297 → 334 at the
15:28:47 poll, which is depth-1 link discovery and the same shape both earlier
crawls showed.

Fetch outcomes and discovery, from `pages_query` paged in full (551 rows, 3 calls
at `limit: 200`), **identical to audit 2 in every cell**:

| `fetchClass` | count | | `discoveredVia` | count |
|---|---|---|---|---|
| `ok` | 443 | | `sitemap` | 437 |
| `client_error` | 97 | | `link` | 113 |
| `redirect` | 10 | | `seed` | 1 |
| `non_html` | 1 | | `redirect` | 0 |
| **`blocked`** | **0** | | | |

Origin health, over this crawl's own rows: n 551, min 86 ms, **p50 282**, p90 392,
p99 581, max 730, avg 284; avg HTML 310,522 bytes, max 488,079. Audit 2 measured
p50 291 and avg HTML 310,539 — the origin was fast, steady and marginally faster
again.

---

## 2. The symmetric measurement — the cancellation, on real pages (T1)

This is the phase's central claim and it is measured on a live Shopify theme, not
a fixture. Per CHECK-01's Record clause (added in T1's fix round), **the ratio is
quoted beside `addedWords`**. Re-queried from the crawl's rows while writing this
file:

| raw | renderable | rendered innerText | **rendered renderable** | **addedWords** | **ratio** | old gap (renderable − innerText) | page |
|---|---|---|---|---|---|---|---|
| 1138 | 770 | 281 | **770** | **0** | **1.000** | 489 | `/` |
| 989 | 621 | 196 | **621** | **0** | **1.000** | 425 | `/apps/wishlist` |
| 1111 | 743 | 308 | **743** | **0** | **1.000** | 435 | `/blogs/blog/docking-portside…` |
| 993 | 625 | 200 | **625** | **0** | **1.000** | 425 | `/collections/activewear` |
| 1072 | 704 | 279 | **704** | **0** | **1.000** | 425 | `/collections/bright-dresses` |
| 1203 | 835 | 408 | **835** | **0** | **1.000** | 427 | `/collections/knitted-separates` |
| 990 | 622 | 197 | **622** | **0** | **1.000** | 425 | `/pages/birthday` |
| 3888 | 3520 | 3095 | **3520** | **0** | **1.000** | 425 | `/pages/data-protection-policy…` |
| 1438 | 1070 | 645 | **1070** | **0** | **1.000** | 425 | `/pages/returns` |
| 992 | 624 | 199 | **624** | **0** | **1.000** | 425 | `/search` |
| 2124 | 1566 | 1126 | **1643** | **77** | **1.049** | 440 | `/products/lara-fluted-sleeve…` |
| 1337 | 797 | 341 | **874** | **77** | **1.097** | 456 | `/products/honey-one-shoulder…` |
| 1340 | 784 | 330 | **861** | **77** | **1.098** | 454 | `/products/abbie-pearl…` |
| 1327 | 764 | 336 | **887** | **123** | **1.161** | 428 | `/products/harper-square-neck…` |

Aggregate over the fourteen: `addedWords` min 0, max 123, mean 25.29; ratio min
1.000, max 1.161, mean 1.029; the old gap min 425, max 489, **mean 436.0**.

### 2.1 Read the last two columns together

- **The 425-word constant is still there and was not smoothed away.**
  `renderable − renderedInnerText` runs 425–489, mean 436.0, against Phase 7's
  425–489, mean 435.1 — reproduced to within a word on a crawl a day later, on a
  different page set. Nothing was widened and no threshold was moved.
- **It no longer touches the rule.** `renderedRenderable − renderable` is
  **exactly 0 on ten of the fourteen pages**, including `/apps/wishlist`, where
  the whole page is chrome and Phase 7 measured the constant at its purest. The
  chrome markup exists in both documents, the same analyzer counts it on both
  sides, and it cancels — **not approximately, identically.** Phase 7 §4.2 asked
  for a tolerance to be stated; on this pair the tolerance is zero.
- **The four products are the four pages where JavaScript actually wrote
  something**, and `addedWords` is exactly that quantity: 77, 77, 77, 123. Three
  products agreeing on 77 to the word is one template's script, measured.
- **`/products/abbie-pearl…` is the same document all three audits measured** —
  raw 1340, renderable 784, byte-identical to Phase 7 — and its rendered
  renderable is 861, `addedWords` 77.

### 2.2 The diagnosis it enabled

Because the three rendered **collection** pages show `addedWords: 0`, this audit
can say something Phase 7 could not: the collection grid does **not** inject
product links after JavaScript. The products are not hidden behind client-side
rendering; the links are genuinely absent from the markup. That is a narrower and
far more actionable finding than "the grid is JS-only", and it exists only because
the two sides became comparable. It changed what the deliverables recommend.

### 2.3 The residual, stated rather than buried

**The thin-floor caveat survives Phase 8 and must still be quoted.** The
cancellation is proven *on rendered pages*. **537 of the 551 pages were not
rendered**, and their `renderableWordCount` still carries the ~425 words of
class-hidden chrome that every thin rule reads. The site floor is still 621
against a reader's 196, and `content.thin` still fires 0 at its 150-word
threshold. Any sentence of the form "the engine sees a 621-word floor" needs the
same footnote it needed in Phase 7. Phase 8 gave fourteen pages a truthful pair;
it did not give the other 537 one.

---

## 3. `content.csr-dependent` — SKIP becomes a real PASS

**0 findings, and for the first time the arithmetic could have produced
otherwise.** The rule needs `rendered_renderable ≥ 2 × renderable` **and**
`rendered_renderable − renderable ≥ 150`.

| | Phase 7 (asymmetric) | **this crawl (symmetric)** |
|---|---|---|
| ratio range over rendered pages | **0.32 – 0.73** | **1.000 – 1.161** |
| against the ratio arm's 2.0 | structurally below 1 — **unreachable whatever the site did** | below 2, but **on the right side of 1** |
| best `addedWords` | n/a — the subtraction was meaningless | **123 of the 150 floor — 27 words short** |

Phase 7 recorded CHECK-01 as SKIP because the firing condition was
"arithmetically unreachable on this crawl whatever the site did". **That is no
longer true.** `/products/harper-square-neck-hourglass-blazer-in-black` came
within **27 words** of tripping the floor arm — but the floor is only half the
condition, and the ratio arm stayed the binding one: at 150 added words that page
would have shown 914 against a 2× requirement of 1,528, so it would not have
fired. Firing on *that* page needed `addedWords ≥ 764` — about **641 more words**,
not 27. The zero is now the honest report
of a server-rendered site — the answer CHECK-01 asks for — rather than a
comparison nothing could answer. **The skills-only session recorded CHECK-01 as a
PASS on exactly that reasoning, having verified the comparability itself before
granting it.**

`nav.js-only` (CHECK-34) and `filters.js-only` (CHECK-02) also fired 0. They stay
on the browser's counts by the argument written at their own docblocks.

**What changed is the sign of the comparison, not a near miss.** The ratio moved
onto the right side of 1, so the arithmetic can now produce a firing — the floor
arm came within 27 words of one, and the ratio arm was never close on any page
here. A site that *would* fire it remains unmeasured outside the fixture, which is
where the firing path is exercised end to end.

---

## 4. The agent-directed render pass (T2)

### 4.1 The list, and why it was that list

Chosen by the key-templates method the T2 skill section describes: cohort sizes
first, then a representative spread inside each real template, then the suspicious
one-offs. **14 URLs; the skill's arithmetic for a four-template site is 10–15.**
Representatives were picked by `renderableWordCount` spread — min, median, max —
rather than alphabetically, exactly as the skill asks.

| what | URLs |
|---|---|
| the home page | `/` |
| `/collections/:slug` min / median / max | `activewear` 625, `bright-dresses` 704, `knitted-separates` 835 |
| `/products/:slug` min / median / max | `harper-square-neck…` 764, `honey-one-shoulder…` 797, `lara-fluted-sleeve…` 1566 |
| the cross-audit anchor | `/products/abbie-pearl…` — the Phase 7 / render-diagnosis reproduction page, carried deliberately so all three audits compare on one document |
| `/pages/:slug` min / p75 / max | `birthday` 622, `returns` 1070, `data-protection-policy…` 3520 |
| `/blogs/blog/:slug` | one of the two — the cohort's two members are the twice-published article, byte-identical at 1111/743 |
| suspicious one-offs | `/apps/wishlist` (renderable 621, the lowest number on the site, on a wishlist app page) and `/search` (a results page with no results in its HTML) |

`/cart` was deliberately **not** rendered: robots.txt disallows `/cart/`, its
emptiness without JavaScript is expected rather than a finding, and it stands for
no template. Every URL was already a 200 page of this crawl — the pass re-visits,
it never fetches a URL for the first time.

### 4.2 What the pass did, and the four nulls

```json
{"rendered":14,"failures":0,"unrendered":0,"elapsedMs":30124,
 "selection":{"mode":"explicit","selected":14,
              "budget":null,"suspects":null,"sampled":null,"truncated":null}}
```

15:42:35.221Z → 15:43:05.372Z. **13 gaps × 2000 ms = 26 s of the 30.1 s** — the
pass paced itself at the crawl's spacing, as it has since the Phase 6 fix.

`render.coverage`, re-queried from the metrics table:

```json
{"pagesCrawled":551,"selectionMode":"explicit","selectionSelected":14,
 "selectionBudget":null,"selectionSuspects":null,"selectionSampled":null,
 "selectionTruncated":null,"pagesRendered":14,"renderFailures":0}
```

**Four nulls, not four zeroes**, exactly as the metric's contract states: no
automatic decision was taken, so there was no budget, nothing was suspected and
nothing was cut. **The null-versus-zero trap is live and the skills-only session
hit it deliberately**: a careless writer reads `selectionSuspects: null` as "no
page on this site looked incomplete", which is a claim about the site's HTML that
nothing measured. Both deliverables state the nulls and substitute the
templates-covered claim instead — 14 pages over 7 page types, with the six
single-page types that were not covered named.

**Cost, against the automatic alternative.** The automatic pass on this crawl
would have had a budget of `min(ceil(551 × 5/100), 500)` = **28** renders and
spent them across the type tail. 14 named renders covered all four templates with
a min/median/max spread inside three of them, plus two suspects, plus the
cross-audit anchor — **half the requests, and a coverage claim that can be stated
per template rather than per page.** That is the owner's "render-all is a waste of
resources" made arithmetic.

**One coverage claim is thinner than the others and is stated as such:** the
`/blogs/blog/:slug` cohort is two pages and one was rendered. Its twin is
byte-identical, so the render answers for both — but "four templates covered" is
not four equally-evidenced templates.

---

## 5. Supplied-sitemap provenance (T3)

The sitemap URL supplied at crawl start is the one **robots.txt already
declares**. That redundancy is the test, not an oversight: the two provenances
must stay apart while describing one document.

```json
{"outcome":"read","truncated":false,"crawlDelaySec":null,"note":null,
 "sitemapSources":["https://lavishalice.com/sitemap.xml"],
 "suppliedSitemaps":["https://lavishalice.com/sitemap.xml"],
 "raw": <3626 bytes>}
```

The raw body is 3,626 bytes, byte-identical to Phase 7's, so robots.txt has not
changed. **The redundancy cost the origin nothing:** `sitemap.structure` reports
`docs: 5, totalUrls: 438` — the index plus five shards, six fetches, the same six
Phase 7 made from the declared list alone. `startingSources` deduped on the
normalised spelling and the walk fetched the document once. `crawl_status` echoes
`sitemapUrls` beside `legacyHosts: []` on both transports' shared shape, and the
config row persists it (verified in the stored `config_jsonb`).

`sitemap.missing` did not fire, correctly — robots.txt *does* declare a sitemap
here. **The skill's warning that supplying a URL must not hide that finding is
untested by this crawl and stays untested**; it needs a site that declares none.
The half that *was* tested is the one that matters for trust: a document present
only in `suppliedSitemaps` would be one the site publishes and does not declare,
and the deliverables state which list carried which fact, so nobody downstream can
mistake a supplied document for a declared one.

---

## 6. Full-picture caps (T4)

`findingCap: null` was set at crawl start, echoed on the crawl row throughout, and
flowed into the rules run with no argument restating it.

```
POST /crawls/:id/rules  →  15:43:43.538Z → 15:43:54.885Z (11.3 s)
{"pagesScanned":551,"findings":17658,"metrics":85, …}
```

| ruleId | audit 2 (capped) | **this run (uncapped)** | |
|---|---|---|---|
| `content.near-duplicate` | 500 *(atLeast 501)* | **16,789** | **the number audit 2 could not state** |
| `links.orphan` | 200 *(total 243)* | **243** | complete, and it matches audit 2's `total` exactly |
| `meta-description.too-long` | 240 | 240 | |
| `meta-description.missing` | 107 | 107 | |
| `links.broken-internal` | 97 | 97 | |
| `title.too-long` | 61 | 61 | |
| `title.too-short` | 42 | 42 | |
| `headings.h1-missing` | 19 | 19 | |
| `images.missing-dimensions` | 11 | 11 | |
| `headings.level-skip` | 9 | 9 | |
| `meta-description.too-short` | 8 | 8 | |
| `pages.not-in-sitemap` | 6 | 6 | |
| `title.duplicate` | 5 | 5 | |
| `images.missing-alt` | 4 | 4 | |
| `h1.duplicate-text` | 4 | 4 | |
| `content.placeholder` | 3 | 3 | |
| `meta-description.duplicate` | 3 | 3 | |
| `canonical.points-elsewhere` | 2 | 2 | |
| `content.exact-duplicate` | 2 | 2 | |
| `hreflang.missing-return-link` | 2 | 2 | |
| `headings.h1-multiple` | 1 | 1 | |
| **total** | **1,326** | **17,658** | |

**Nineteen of the twenty-one rules reproduce audit 2 to the finding, and the
entire delta is the two rules a cap had been cutting.** 17,658 − 16,789 − 243 =
626; 1,326 − 500 − 200 = 626. The uncapped run added no finding that was not
already being counted and hidden.

### 6.1 The truncation contract in its strongest form

`GET /crawls/:id/issues?limit=50` returned all 21 rules and **not one carries a
truncation field**. Audit 2's listing carried exactly two notes. This one carries
zero, and that is the contract working in the direction that matters: **a note
means the list is incomplete; its absence means it is complete.** The skills-only
session's counts, `crawl_status.findingsCount` and `export_crawl`'s `rows` are
three independent numbers and all three read **17,658**.

The skill's insistence that completeness is inferred from **the absence of the
note, never from the cap setting**, did real work here and was followed: the
100,000-pair scan ceiling cannot be lifted by `findingCap`, so an uncapped run
*could* still carry an `atLeast`. It did not, and the findings file says so rather
than reasoning from `findingCap: null`.

### 6.2 The 100k pair ceiling did NOT bite — and its silence is the check

`NEAR_DUPLICATE_PAIR_CEILING` is 100,000 and `findingCap` cannot lift it (the
memory contract outranks the config — T4's ruling). This site produced **16,789
pairs, 17% of the ceiling**, so the scan completed and no `atLeast` note was
written. That absence is the evidence: had the ceiling bitten, the rule would have
reported 100,000 with `atLeast: 100,001`, and the listing would have been
indistinguishable in kind from a capped one. It did not, so the near-duplicate
picture on this site is genuinely whole.

### 6.3 The uncapped cost, measured

| | audit 2 (capped) | **this run (uncapped)** |
|---|---|---|
| findings written | 1,326 | **17,658** (13.3×) |
| `crawl_rules` wall | 10.7 s | **11.3 s** |
| peak RSS during the run | ≈ 223 MB | **≈ 225 MB** |

**Thirteen times the findings for 0.6 seconds and about 2 MB.** At 551 pages the
full picture is effectively free, which is the billing story the plan asked for.

Retrieving it is a different cost, and it was measured end to end through the API:

| listing | rows | calls at `limit: 200` | wall |
|---|---|---|---|
| `links.orphan` | 243 | 2 | 0.06 s |
| `content.near-duplicate` | **16,789** | **84** | **4.85 s** |

**84 calls is a real cost for an agent's context, and the export threshold is the
lever the skills already carry.** The skills-only session is the first run that
could test it at this magnitude, and it took the export path: **one
`export_crawl` call, 17,658 rows, 384,526 bytes**, in place of 84 paginated
reads. Its whole audit — 82 checks — cost **57 API calls**. The threshold works.

**One quality gain worth recording:** near-duplicate evidence now carries
collapsed template names. A sample row reads
`{"urlA":"https://lavishalice.com/","urlB":"…/collections/in-your-bridal-era","hamming":3,"pageTypeA":"/","pageTypeB":"/collections/:slug"}`
— in audit 2 `pageTypeB` would have been a singleton path meaning nothing.

### 6.4 What a `pageType` filter means on a pair rule

Queried both ways while writing this file, because the two answers differ and
somebody will eventually compare them:

| question | count |
|---|---|
| findings whose **own page** is `/collections/:slug` (what `issues_list {pageType}` returns) | **15,815** |
| pairs where **either side** is `/collections/:slug` | 16,219 |
| pairs where **both sides** are | 11,242 |
| distinct URLs across all 16,789 pairs | **311** |

The filter answers the first question, which is the right one — the finding is
filed against a page — and the skills already warn that cohort counts do not sum
to the total on a pair rule. 311 distinct URLs against 16,789 rows is the same
warning from the other side: **a pair row is not two pages**, and reading it as
one would have reported 33,578 affected URLs for a site that has 311.

---

## 7. Template inference (T5)

### 7.1 196 → 13

The completion log line, verbatim from the server's own stdout:

```
api: crawl crawl_02ff6f7a-203c-4771-805c-feede04aed11 finished — 551 page(s),
     196 URL shape(s) -> 13 page type(s), 185 retyped
```

**196 is the same 196 the Phase 6, 7 and 8-planning documents recorded** — Phase
7's fourth sighting, re-queried from both earlier crawls' rows for this file:
**audit 1 and audit 2 each carry 196 distinct `page_type` values**, and audit 2's
190 of them occur exactly once. Two crawls eleven hours apart agreeing on 196 is
what "the typing is a property of the URLs, not of the crawl" looks like as a
number. Audit 3's rows carry **13**, and none of the four real templates is a
singleton.

| page type | pages | ok/200 | what it is |
|---|---|---|---|
| `/collections/:slug` | **260** | 236 | real template |
| `/products/:slug` | **211** | 148 | real template |
| `/pages/:slug` | **69** | 50 | real template |
| `/blogs/blog/:slug` | 2 | 2 | real template, tiny cohort |
| `/` · `/agents.md` · `/apps/wishlist` · `/blogs/blog` · `/blogs/news` · `/blogs/news/dazzling-jewellery` · `/cart` · `/collections/new-in/products/:slug` · `/search` | 1 each | | the nine-entry tail |

The nine-entry tail is nine deliberate refusals, each traceable to `familyOf`'s
stated rules: four single-segment root routes have no family; `/blogs/blog` and
`/blogs/news` are a two-path family under `/blogs/:slug` (below `MIN_COHORT` 3, so
they keep their names); `/blogs/news/dazzling-jewellery` is the only member of
`/blogs/news/:slug`; `/apps/wishlist` is the only page under `/apps/`; and the
deep collections product URL is not collapsed one level up.

**Against T5's corpus reconstruction, which predicted 12:** `/products/:slug`
lands on **211, exactly** as predicted; `/collections/:slug` 260 against 275;
`/pages/:slug` 69 against 49; `/blogs/blog/:slug` 2 against 8. The thirteenth type
is `/blogs/news/dazzling-jewellery`, which the corpus folded into the blog
template's count. **The T5 report had already disclosed that the blog section of
the reconstruction was approximate** ("the exact spread of the tail was never
recorded, only its size and shape"), and this is that disclosure coming due — a
one-type miss on a 196-type problem. No action; recorded so the acceptance test's
authority is not overstated.

### 7.2 Metric rows 1,023 → 85, and the warning that must travel with it

Both crawls' metric tables were re-queried for this file. **The task report gave
five of these rows as "~197"; the measured number is 168.**

| metric | audit 2 rows | **this run** | why |
|---|---|---|---|
| `content.metrics-by-type` | 168 | **12** | **167 → 11 page-type rows**, plus the one site row that never moved. Eleven is the thirteen types minus the two with no indexable page (`/agents.md`, `/collections/new-in/products/:slug`); 167 was the 196 minus its 29 |
| `hreflang.coverage` | 168 | **12** | same shape, same arithmetic |
| `inlinks.distribution` | 168 | **12** | same |
| `structure.click-depth-distribution` | 168 | **12** | same |
| `structure.depth-distribution` | 168 | **12** | same |
| `inlinks.sources-by-type` | 167 | **11** | the same 167 → 11 page-type rows; this metric emits no site row |
| `content.template-similarity` | 6 | **4** | four real templates. Audit 2's extra two were `/collections/sale` and `/pages/email-signup` — two-page cohorts reported at meanHamming **0** and "100% within 3 bits". Re-queried, each was **one page counted twice**: `/collections/sale` beside `/collections/sale?product-type=dress`, and `/pages/email-signup` beside its `?srsltid=` variant. A metric row saying "this template is perfectly consistent" about a URL and its own query string is exactly the noise the collapse removes; both now sit inside `/collections/:slug` and `/pages/:slug` |
| `sitemap.structure` | 6 | 6 | one site row + one per sitemap document (5) — scoped to documents, not page types, so the collapse cannot touch it |
| `inlinks.extremes`, `redirect.volume`, `render.coverage`, `url.param-volumes` | 1 each | 1 each | site-scoped — unchanged |
| **total** | **1,023** | **85** | |

**This is not a loss of information; it is the same information becoming
readable.** Phase 7's D-2 complaint was that the per-template breakdown
CHECK-35/36/37 want is "unproducible by filtering on `pageType` unless the auditor
already knows the four ids". There are now four ids and they are the first four
rows of any by-type metric. Two examples that were not readable before:

- `inlinks.sources-by-type` for `/products/:slug` reads, in its entirety,
  **`{"/products/:slug": 82}`**. The product island — 148 indexable products that
  nothing outside the product template links to — is one line of one metric
  instead of an inference across 196 rows. That is CHECK-33b's whole evidence.
- `structure.click-depth-distribution` per type is now the finding rather than a
  haystack. Site row: `{count 443, min 0, median 1, max 6, mean 1.52,
  nullCount 356}` — reproduced exactly from audit 2. Per type:
  `/products/:slug` count 148 / **nullCount 148**; `/collections/:slug` 236 / 163;
  `/pages/:slug` 50 / 40. **Not one of the 148 indexable products is reachable by
  any chain of internal links from the home page**, for the second audit running —
  and this time the row that says so is one of twelve rather than one of 168.

> ### ⚠ NOT ROW-COMPARABLE ACROSS COMMIT `9fdaafa`
>
> **`crawl_3f3ab847` (audit 2) is not row-comparable to `crawl_02ff6f7a` on any
> `page_type`-scoped metric.** Commit `9fdaafa` changed what a `page_type` VALUE
> means: the same URL that typed as `/collections/sale` now types as
> `/collections/:slug`, so a cohort's *membership* changed and its statistics
> moved with it — `/collections/:slug` was 110 fingerprinted pages at meanHamming
> 4.37 and is now 236 at 4.21; `/pages/:slug` was 18 at 11.95 and is now 50 at
> 8.69. **Neither pair of numbers is wrong and neither is a regression.** The
> older row measured a subset that happened to share a URL shape; the newer one
> measures the template. Read audit 2's by-type rows as audit 2's *report*, never
> as rows beside these.
>
> This warning is keyed to the commit rather than to the ruleset on purpose:
> `RULESET_VERSION` stayed **0.6.0** through `9fdaafa` by the consistency argument
> the T5 reviewer confirmed — T3 and T4 also changed what rules see without
> bumping, and bumping here would redefine the constant as tracking crawler
> behaviour rather than verdict semantics. The cost of that decision is exactly
> this box: **a consumer diffing audit 2's metrics against audit 3's sees 938 rows
> vanish and no version number explains it.** This gate doc is the explanation.
> It is the same precedent Phase 7 set for `crawl_2af4daf1`.

---

## 8. The deliverable set — a skills-only session (part B)

A fresh session with **skills and the HTTP API only**: no `src/`, no `test/`, no
`docs/`, no git, no psql, no GSC/GA4/Ahrefs, no browser, no external requests.

| | |
|---|---|
| `audits/lavishalice.com-audit3/ariadne-findings.json` | 295,723 bytes · 82 checks · **25 PASS / 16 FAIL / 40 SKIP / 1 AGENT** |
| `audits/lavishalice.com-audit3/audit-report.md` | 84,516 bytes |
| `audits/lavishalice.com-audit3/action-plan.xlsx` | 218,147 bytes · Summary + **16 tabs · 3,457 rows** |
| API calls | **57**, zero writes |

`crawl_rules` was **not** re-run: `rulesRunAt` was already stamped (P6 backlog 17,
fixed in Phase 7 and now load-bearing), so `crawl.rulesRun` is `null` with the
required caveat naming the marker pair as the proof.

**Do Phase 8's features read fixed from the outside?** All four, plus the ruleset
0.6.0 columns:

| Feature | Verdict from the skills-only side |
|---|---|
| Uncapped listings | **Fixed.** 21 rules, zero truncation notes; every `issue_urls` walk returned exactly the count `issues_list` promised; three independent totals agree on 17,658. |
| Explicit-mode render coverage | **Fixed**, and the null-vs-zero trap is real and was avoided (§4.2). |
| Per-template filters | **Fixed, and now the cheap route.** 15 filtered `issues_list` calls, every count reconciled against an independent census. Orphans: collections 112 + products 109 + pages 21 + `/blogs/blog` 1 = **243** = the rule's total. An unknown cohort is refused by name. `(untyped)` occurred **zero** times, and both deliverables say the bucket was empty rather than inventing one. |
| Supplied-sitemap provenance | **Fixed.** CHECK-06 passes on both halves and the finding states which list carried which fact. |
| Symmetric render columns | **Fixed, and it changed a verdict** — CHECK-01 SKIP → PASS, with the sharpened diagnosis of §2.2. |

**The metrics sweep was one call.** On the 196-page-type crawl it would have been
many; 13 types over 551 URLs is what made it cheap. That is a measured effect of
T5 on the audit's cost, not an assumption.

**Three passes worth naming**, because they are ones the skills warn against
granting cheaply: CHECK-01 (§3); CHECK-13, which passes only because
`content.thin-skipped` did not fire *and* the census separates the two null shapes
(108 pages null in both columns = 97 404s + 10 301s + 1 non-HTML, which is not a
gap); and CHECK-34, scoped in its own finding so it cannot appear to rescue
CHECK-33b — the nav is real HTML and links sixteen collections, and the collection
grid's missing links to *products* are a different template.

**Seven of the sixteen FAILs have no finding rule behind them at all** — CHECK-03,
10, 22, 31, 33, 33b, 67 — answered by a metric, a `pages_query` census or the
stored robots.txt. That matches the Phase 7 proportion the action-plan skill's 1a
branch warns about, and it includes the two worst findings on the site. **A
pipeline that only opens tabs from `issue_urls` would have dropped them.**

**The 40 SKIPs are honest and get no commercial weighting.** Eleven are the
"engine clean, missing tool would still decide" class, each carrying the engine
half quoted as supporting evidence and none recorded as a pass. Both deliverables
say the plan was built without commercial context.

---

## 9. The engine fix this gate earned, and the skill reconciliation

### 9.1 `ARIADNE_EXPORT_DIR` (`e09351e`)

`export_crawl` wrote **384,526 bytes into the repository's own `exports/`** during
the skills-only run. Nothing broke — the directory is git-ignored and the server
was local — but the asymmetry is the defect: `renderDir` gained an operator knob
in T1 and `exportDir` did not, though `ServiceConfig` has carried the field since
Phase 6. **On a billed audit the export is the normal path, not the exception**
(an uncapped crawl passes the action-plan's 2,000-row switchover on its first
large rule, as this one did at 16,789), so exports accumulate wherever the process
was started.

Fixed to the `renderDir` precedent exactly: `ARIADNE_EXPORT_DIR` read by both
entrypoints, both printing the resolved destination at boot, one `parseOutputDir`
serving both variables so they cannot drift apart on what an empty shell value
means, and the two settings pinned as independent. The `ServiceConfig.exportDir`
docblock now names the variable and the measurement that earned it. **This closes
the P6-T4 ledgered minor.**

No test was writing into the repo's `exports/`: `test/api/query.test.ts` and
`test/api/mcp.test.ts` already build the directory with `mkdtemp` and remove it in
`afterAll`, and `test/api/http.test.ts` does not exercise the export path at all.
Verified before the fix rather than assumed.

### 9.2 The skill reconciliation (`e09351e`)

Fresh prose from part B's divergences; the identifier guard and the shape tests
are the net.

| Divergence | Resolution |
|---|---|
| **The same-remedy merge** (material) — click depth 356, orphans 243, product discovery 148 and pagination 4 were **four tabs describing one template change**, and 1d could not consolidate them: three were above the volume floor and one was in another section. | `ariadne-action-plan` 1d gains a same-remedy merge that ignores the floor and the section boundary, with a block per member inside and every merged check id on the tab's face. **The test is stated**: the `recommendation` texts must agree on the change, not merely on the theme — if the merged Fix column cannot be written as one instruction without losing a clause a member needed, they were never the same remedy. **1e's protections apply to the MERGED candidate** (highest priority, highest severity, summed count), so a merge can never cut a protected check by absorbing it. |
| **The 6–10 tab target** (material) — 17 candidates reached 1e; 5 `Critical`, 12 at or above the floor, 9 more `High`/`critical`; **exactly one was cuttable**. It was cut, at rank 16, and the workbook shipped 16 tabs. | The target is now stated honestly as **advisory on a FAIL-heavy uncapped audit, with the protections governing**, and the measured Phase 8 numbers are written into the skill. The Summary sheet states the tab count, the target, and that the protections left nothing further cuttable. Explicitly forbidden: reopening the cut to hit the number, and merging candidates that are not the same remedy to look tidier. |
| **The canonical-filename clause** (material) — the escape hatch was buried at the end of a paragraph arguing hard the other way, and an agent reading quickly would either rename against the request or follow it silently. | Promoted to its own line in **both** deliverable skills: the requester's name wins, the `{client}-` prefix is the default for when nobody said, and the name used is stated in the deliverable. |
| **CHECK-15 genuinely ambiguous** (minor but real) — one sentence said an unnamed legacy host is a SKIP; the check's own Evaluate line said PASS. Two auditors would have given the same crawl different verdicts. | **Resolved in the checklist, one reading stated and the other explicitly rejected.** PASS with the legacy/staging half recorded as NOT MEASURED, when no legacy host was named and the apex/www probe ran — the Evaluate line governs, and the probe measured the thing the check is named for. SKIP would file a site with one clean canonical host beside sites nobody looked at. **The SKIP sentence is rescoped** to the `host.probe-skipped` case: `probeHosts: false`, nothing probed, no verdict to give. |
| **The refusal lists read as exhaustive** (minor) — the checklist names CHECK-08/29/33/33b/38 as metric-only and CHECK-41 as claimed-by-no-rule, but CHECK-42, CHECK-47 and the whole CHECK-71…81 block answer the same way. | Both lists marked as examples, with the additional checks named. |
| **1d intake double-counts a cross-referenced rule** (minor) — CHECK-67 cited `title.duplicate` as context; `title.duplicate` claims CHECK-35 alone. The 1d tiebreak gave the right answer for the wrong reason. | 1a now defines intake against the **rule's own `checkIds`**: a rule that does not claim the check you are reading is a cross-reference, recorded on the citing check's Summary line and pointing at the tab that owns the rows. The distinction from 1d's genuine two-check case is spelled out. |
| **The stray `inspect.py` in the shared scratchpad** (environment, not a skill defect) — Python puts a script's own directory on `sys.path[0]`, so a builder run from the shared scratchpad shadowed the stdlib `inspect` and killed `import openpyxl` with `AttributeError: module 'inspect' has no attribute 'cleandoc'`. | Worked around during the run (a clean subdirectory); the stray file was deleted by the controller afterwards. Recorded because the failure is loud and its cause is not obvious. |
| **`crawl.rulesRun: null` reads as a defect three times over** (minor) — the field needs a defensive caveat in the findings file, another in the report and a third in the workbook. | **No change made.** The repetition is real but each caveat is doing its job for a different reader, and the honest fix is upstream: if `crawl_status` ever gained `pagesScanned`, the field could go away. Recorded in the backlog, not papered over. |

**Nothing in the five skills sent the skills-only session down a wrong path.**
Every trap they warn about was live on this site, and the traps earned their
paragraphs: `redirectInlinks` 898 against `ratioPct` 1.8 (898/551 = **163%** —
quoting the ratio would have passed CHECK-10 on the site's third-largest finding);
discovery `depth` median 0 / max 1 against `clickDepth` null on 356 of 443
(reporting the first would have said "97% of this site is one hop from the start"
about a site whose entire catalogue is unreachable); orphan products 109 against
products with no click depth **148** (reporting the orphan count would have
understated by 39).

---

## 10. Politeness

- **Zero blocked pages** — at every poll, at the end of the crawl, after the
  render pass, and confirmed independently by `fetchClass=blocked` returning 0
  rows.
- **Zero escalations.** `hostSpacingMs` began at 2000 and ended at 2000 against a
  30,000 ms ratchet cap. **The wall reproduced Phase 7's to a tenth of a second —
  1111.8 s → 1111.9 s** — which is the ratchet's silence stated as a number:
  551 × 2000 ms = 1102 s is the arithmetic, and the ~10 s over it is discovery
  plus the tail. Two crawls a day apart at the same settings differing by 0.1 s is
  a crawler that is not reacting to anything.
- **The render pass ran at 2000 ms too**: 30.1 s for 14 pages, 13 gaps.
- **Total requests this visit:** 551 crawl fetches + 14 renders + 1 robots.txt + 6
  sitemap documents + ~4 host-probe requests ≈ **576**, one every two seconds,
  over 21 minutes. Third visit in two days, owner-sanctioned.
- Settings were never raised mid-run, the user agent was never changed
  (`AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)`), nothing was
  re-crawled to go faster, and no disallowed path was requested — `/cart` was a
  good CSR suspect and was left alone because robots.txt disallows `/cart/`.
- **Across all three crawls: 0 blocked pages, 0 fetch failures, 0 back-off
  escalations, 0 manual interventions.**

---

## 11. Operator notes

**Where the render evidence went.** `ARIADNE_RENDER_DIR` was set to
`<worktree>/.superpowers/sdd/2026-08-29-phase-8-full-picture/renders`, and the
server said so on stdout at boot. The pass wrote
`renders/<crawlId>/<sha256>.html`.

| | |
|---|---|
| files | **14** (one per render, no failures) |
| disk | **5,308 KB (5.2 MB)** |
| per render | **≈ 379 KB** |
| the worktree's `renders/` | **does not exist** — never created by this run |

**The cost projection an operator needs:** at this page size an *automatic* pass
at its 500-page cap would leave **≈ 185 MB** on disk per crawl, and nothing
deletes it. **Retention is the operator's**; the `rendered_html_path` column makes
the evidence movable and the boot line makes the destination knowable before it
grows.

**A mid-pass disk failure ABORTS the pass.** That is T1's ruling — a write failure
is our defect wearing site-evidence clothes, so it throws rather than being
classified as a site-side render error. The consequence to know:
`render_pass_count` is then unwritten and the named URLs stay `render_pending`
rather than being consumed, which is the better frontier semantics but is not what
a reader of a half-finished pass would assume. **Untested here** — 14 of 14
succeeded.

**The gate script deliberately stays on the default `renders/`.** `scripts/gate-rules.ts`
constructs its render pass without a `renderDir`, so the 50k gate's documents land
under the repository's working directory. That is a deliberate carry from T1's fix
round, recorded here so nobody reads the "never created" line above as a claim
about the gate script: it is a claim about *this* run, which went through the API.

**The exports directory is now movable too** (§9.1), and the boot line names it.
The 384,526-byte export this gate produced was written before the fix existed and
is left where it landed.

---

## 12. Owner decisions, recorded

Three directions given on 2026-08-29, all carried into the plan and all honoured:

| Decision | How it shows up in this gate |
|---|---|
| **Render-all REJECTED** — "a waste of resources"; "probably needs a skill" | T2's explicit mode plus the key-templates skill section. Measured: **14 named renders against the automatic pass's 28-render budget**, covering four templates with a min/median/max spread, two suspects and the cross-audit anchor (§4.2). Half the requests, a better coverage claim. |
| **The near-duplicate threshold STAYS strict-3** — the SF-90%-parity widening was explained and declined ("we don't need to change") | Untouched. The threshold is not why this run found 16,789 pairs; the *cap* is (§6). It remains a small config job the day a client asks. |
| **Full picture rather than snapshots** for billed audits | `findingCap: null` on a real crawl: **17,658 findings for +0.6 s and ~2 MB** (§6.3). |
| **A third lavishalice crawl approved as the gate** | §1, §10. One more ~20-minute polite visit, zero blocks. |

Two rulings made during execution and recorded here because they shaped the
numbers above:

- **The 100,000-pair scan ceiling that `findingCap` cannot lift** (T4). The memory
  contract outranks the config: the committed pre-ceiling state breached hard rule
  6 at 2,000 degenerate pages (521 MB RSS). "At least 100k pairs" *is* the
  actionable full picture. It did not bite here (§6.2).
- **`RULESET_VERSION` stayed 0.6.0 through the template collapse** (T5). The
  reviewer confirmed the consistency argument; the cost is the warning box in
  §7.2.

---

## 13. The engine-defect list, item by item

The Phase 7 gate's list and the Phase 8 backlog it opened, re-checked against this
run.

| Item | Disposition, measured here |
|---|---|
| **P8 backlog 1** — CSS-aware suppression, or a per-crawl `chromeWords`, for the 425-word constant | **CLOSED BY BEING MOOTED, not built.** The constant is still 425–489 (mean 436.0) on the innerText pair and is now on neither side of any rule's subtraction: `renderedRenderable − renderable` = **0 on 10 of 14 pages** (§2). No CSS evaluation, no new column, no widening. |
| **P8 backlog 2** — the comparability answer for `content.csr-dependent` | **CLOSED.** ratio 0.32–0.73 → **1.000–1.161**; the arithmetic can now produce a firing, and a real product page came within **27 words** of the floor arm — the 2× ratio arm stayed the binding one there, so that page itself was ~641 words away. CHECK-01's evidence line is sound and its SKIP became a PASS (§3). |
| **P8 backlog 3** — `derivePageType`, fourth sighting | **CLOSED.** 196 URL shapes → **13 page types**, 185 retyped, on the site that produced the complaint four phases running (§7.1). |
| **D-1** — `count` capped, the skill said it was the total | **VERIFIED STABLE in its strongest form**: 21 rules, **zero** truncation notes, because the cap was lifted rather than because the mechanism was removed (§6.1). |
| **D-2 consequence** — the per-template breakdown unproducible without knowing the four ids | **CLOSED with it.** Four ids, the first four rows of every by-type metric; the product island is one line (§7.2). |
| **D-9 / CHECK-03** — robots' `Sitemap:` line and body | **VERIFIED STABLE**, and extended: `sitemapSources` now sits beside `suppliedSitemaps` (§5). |
| **P6 backlog 17 (third)** — no engine-side signal the rules had run | **VERIFIED STABLE, and load-bearing.** `rulesRunAt` + `findingsCount` both stamped; the skills-only session never ran `crawl_rules`. |
| **P6-T4 ledgered minor** — `export_crawl` has no configurable output directory | **CLOSED HERE** by `ARIADNE_EXPORT_DIR` (§9.1), earned by a measured 384,526-byte write into the repository. |
| **T1's own item** — the render path wrote into the repo's cwd, unconfigurable | **CLOSED AND DEMONSTRATED.** `ARIADNE_RENDER_DIR` put all 14 documents under the SDD workspace; the worktree's `renders/` was never created (§11). |
| **P6 backlog 15** — the action plan's cohort and cap heuristics | **SECOND EXERCISE, and the first at scale**: 16 tabs, 3,457 rows, a 16,789-row rule routed through the export threshold, and the cut's protections measured (§8, §9.2). The 1d/1e gaps it exposed are fixed rather than noted. |
| **thin-floor blindness** (CHECK-13/40 caveat) | **UNCHANGED, and the caveat must still be quoted.** Site floor still `renderableWordCount` 621 against a reader's 196; `content.thin` fires 0 at its 150 threshold. **537 unrendered pages still carry ~425 words of class-hidden chrome** in the number every thin rule reads (§2.3). |
| **P8 backlog 5** — `structure.deep-page` still reads discovery depth | **STILL OPEN, and sighted again.** CHECK-31 returns `[]` for the second audit running: a rule about deep pages, silent on a site with 356 unreachable ones. A one-rule follow-up — read `click_depth`. |
| **P8 backlog 4 / D-8** — a pages-considered count for a silent rule | **STILL OPEN.** Untouched. Four schema rules fired 0 and "complete markup everywhere" is still indistinguishable from "no markup anywhere". |
| **D-5** — `renderPassCount` holds the last pass's rendered count | **STILL OPEN.** Reads 14, unambiguous only because exactly one pass ran. |
| **C-2** — back-off leaves no durable trace | **STILL OPEN, and untested for the third time.** Nothing escalated, so there was nothing to log. Unclosed, not disproven. |
| **C-5** — per-render `blockedRequests` counted and thrown away | **STILL OPEN.** 14 renders, no stored blocked-request evidence. |
| **D-7** — the findings interface cannot express a scoped run | **STILL OPEN.** Not needed by this run. |
| **P6 backlog 16** — nothing checks a report's numbers against the crawl | **STILL OPEN.** The workbook's `Fix`-column verifier is the analogous check on the other deliverable and it held. |
| **P6 backlog 1, 2, 5, 6** — streaming metric rows; `hreflang.invalid-code` streaming; persisting the resolved render config; the browser tree's own bound | **CARRIED.** 85 metric rows and a 14-page render pass are not the measurements those items need. Item 5 moved sideways rather than forward: T2 stores `renderUrls` in `crawls.config_jsonb` with an amended input-doctrine docblock, and the move to a column is on the migration ledger. |

---

## 14. Coverage and the suite

| | |
|---|---|
| Suite | **1,421 tests, 62 files** (Phase 7 ended at 1,327 / 60) |
| `tsc --noEmit` | clean |
| Ruleset | **0.6.0**; migrations 0000–**0011** |
| Rules registered | **85 = 27 page + 46 query + 12 metric** — unchanged from Phase 7 |
| Checklist coverage | 47 crawl-derived checks: **44 claimed, 3 agent, 0 unclaimed** — unchanged |

**Phase 8 added no rules, and that is the shape of the phase.** Every one of its
five tasks changed what an existing rule *sees* — the render diff's second side,
the URLs a pass visits, the sitemaps discovery walks, the number of rows a listing
writes, the name a cohort carries — rather than adding a judgement. The plan ruled
`render.title-drift` and its siblings out for exactly this reason (YAGNI: the
symmetric columns exist as evidence, and rules follow when an audit needs them),
so the coverage pin is flat by design rather than by neglect.

The Phase 7 lesson about that pin still stands and is worth restating where a
reader will meet it: **a coverage pin proves that every check has a claimant; it
cannot prove that a claimant answers the check.**

---

## 15. Backlog

### Carried into Phase 9

1. **`structure.deep-page` reads discovery depth** (P8 backlog 5, second
   sighting). It returned `[]` again on a site with 356 unreachable pages. A
   one-rule follow-up: read `click_depth`.
2. **A pages-considered count for a silent rule** (D-8 / P6 backlog 3), so
   CHECK-44 can tell complete markup from no markup.
3. **The thin floor on unrendered pages** (§2.3). Phase 8 fixed the comparison for
   the pages a browser visited. The other 537 still carry the chrome, and the
   caveat travels with every thin number until something measures it site-wide.
4. **A site that fires `content.csr-dependent`.** The rule is reachable here — 27
   words from the floor arm on the closest page, though the 2× ratio arm remained
   the binding one and that page was ~641 words from firing. The firing path
   outside the fixture is still unmeasured (§3).
5. **A site that declares no sitemap**, to test that supplying one does not hide
   `sitemap.missing` (§5).
6. **`crawl_status.pagesScanned`**, which would let `crawl.rulesRun` and its three
   defensive caveats go away (§9.2).
7. ~~**Off-origin sitemap entries fire `sitemap.uncrawled` with copy naming three
   wrong causes and wrong fix advice** (ledgered in T3). The skill now invites
   CDN-hosted sitemaps, which makes the case ordinary: up to 200 misdescribed info
   findings per supplied cross-host sitemap. Honest fix: an `offOrigin` evidence
   flag or a copy clause.~~ **CLOSED in the final-review fix wave** — both, in the
   end: the rule now writes `offOrigin` on every `sitemap.uncrawled` finding,
   computed with the frontier's own `isSameOrigin` over the same string the loop
   gates on, and the copy names the off-origin case as a third cause with a remedy
   of its own. No firing condition, threshold or check id moved.
8. **Carried unchanged:** the politeness event log (C-2, still untested — nothing
   escalated for the third crawl running); render-pass `blockedRequests` evidence
   (C-5); the scoped-run field (D-7); `renderPassCount`'s name (D-5); streaming
   metric rows; `hreflang.invalid-code` streaming; the browser tree's own bound; a
   report-numbers checker; the two remaining Task 5 items from Phase 6's item 17;
   the `<br>`-merged `h1_text`; the template-ELEMENTS ruling; the plan-pinning /
   EXPLAIN mechanism; one-scan-for-three; the crawl-aging harness; the Talos `/2`
   note.

### The Phase 9 migration ledger

Three schema needs accumulated during this phase and were deliberately not taken,
because migration 0011 was consolidated in T1 and reopening it mid-phase was the
worse trade. **They belong in one migration, together:**

| Need | Task | Why it is owed |
|---|---|---|
| **Group-lateral functional indexes** | T4 | The three duplicate rules' group aggregates measured **10.4 ms per group at 20k pages**. Uncapped runs make the group count the site's, not 200. |
| **A render-selection column** | T2 | `renderUrls` lives in `crawls.config_jsonb` with an amended input-doctrine docblock. It records an input and no outcome rides on it, which is why the placement was accepted — but the column is the honest home. |
| **A collapsed-marker column** | T5 | **The 196 → 13 fact lives in a log line this document quotes and in no column.** A later reader of the `crawls` row cannot tell this crawl from a pre-Phase-8 one, which is exactly the ambiguity §7.2's warning box exists to work around. |

### The ledgered minors, by task

Recorded at review time, deferred deliberately, restated so they do not go quiet.

| Task | Minor | Disposition |
|---|---|---|
| T1 | spec-cascade `??`-vs-undefined adjacent spellings in the render-diff test builder; a five-vs-four prose count in the task report | **Carried**, both cosmetic. |
| T1 | phase-2 rethrow placement is tested structurally, not fault-injected | **Carried.** The property is proven by the disk-write neighbour; acceptable, and named rather than implied. |
| T2 | the over-cap remedy names an API operation that does not exist (there is no config PATCH — reword to shorten-or-recrawl) | **Carried.** |
| T2 | an uncrawled-URL 400 could name the crawled spelling via the `url_normalised` index — the predictable trailing-slash agent mistake | **Carried**, a follow-up. The exact-match-after-normalise refusal is deliberate. |
| T2 | unreachable `?? 0` in render metrics; the discovery-409-before-list-validation precedence nuance; a 7-vs-8 http count in the report | **Carried**, all three. |
| T3 | `checkRenderUrls` third family-posture copy; the own-family skip ignores port; supplied sitemap documents are fetched without a robots `isAllowed` check (a pre-existing mechanism newly client-reachable — a rule 9 ledger line); redirect hops policy-checked but not allowlist-checked past hop 1; the config echo keeps verbatim duplicates; `sitemapUrls` symbol ambiguity in `loop.ts` | **Carried**, all six. |
| T4 | dead caps params on the two one-finding structured-data rules; stale `run.ts` nondeterminism prose; inline `capsOr` in `sitemap.ts` ×2; the report overstates MCP string-case coverage | **Carried**, all four. |
| T4 | no end-to-end test for a `findingCap` **above** the ceiling (`Math.min` traced by hand — a coverage gap, not a bug); `RunOptions.findingCap` is a latent divergence seam if a future caller passes it | **Carried**, both. |
| T5 | the T2 skill's prose at two lines is more pessimistic than the engine now is (pre-collapse descriptions); the pairs array is materialised pre-slice (inside the contract, a lazy-batch nicety); an unsorted expected-key list; the `/:slug` parse-time-vs-refusal asymmetry | **Carried**, all four; the last is documented in the fold. |
| T5 | render coverage seats moved 71 → 68 when the one-off types collapsed | **Disclosed, both numbers quoted.** Not exercised here — this pass was explicit. |
| T6 | `crawl.rulesRun`'s three defensive caveats | **Carried** as backlog item 6 above rather than papered over (§9.2). |

---

## Machine

| | |
|---|---|
| CPU | Intel Core i5-6500 @ 3.20 GHz, 4 cores (no SMT) |
| RAM | 32 GB |
| Kernel | Linux 6.8.0-138-generic |
| Node | v22.23.2 |
| Postgres | 16, Docker container `ariadne-pg` on port 5440 |
| Suite | **1,421 tests, 62 files, 332.3 s wall** |
| `tsc --noEmit` | clean |

The wall figures in §1 are dominated by the per-host delay, and the response-time
table in §1 is the site's, not this machine's.

## CI

Unchanged by this phase: `ubuntu-latest`, a health-checked `postgres:16` service,
Node 22, a cached `npx playwright install --with-deps chromium` keyed on the
locked Playwright version, then `npm ci` → `npx tsc --noEmit` → `npm run
db:migrate` → `npm test`, on push to `main` and every pull request.

**First CI run on this branch: _pending_.** This branch is **stacked on the
unmerged Phase 7 PR #6**; PR #7 opens once #6 merges (or retargets), and the run
link is added here then — the same placeholder-then-fill the Phase 7 gate used.

The gate is not part of CI and cannot be: it crawls a third party's website with
their permission.

## Leftovers

**All three crawls stay in the dev database**, deliberately — every figure in
§§1–8 can be re-queried from their rows, and several in this document were:

| | `crawl_2af4daf1…` (audit 1) | `crawl_3f3ab847…` (audit 2) | `crawl_02ff6f7a…` (audit 3) |
|---|---|---|---|
| pages | 551 | 551 | 551 |
| links | 35,145 | 35,145 | 35,145 |
| issues | 1,314 | 1,326 | **17,658** |
| metrics | 855 | 1,023 | **85** |
| rows with render evidence | 38 | 28 | **14** |
| distinct `page_type` | 196 | 196 | **13** |

**Two warnings travel with these rows, and neither cancels the other.**
`crawl_2af4daf1` is not row-comparable to anything judged by ruleset 0.5.0 or
later (Phase 7's warning, unchanged and still true). **`crawl_3f3ab847` is not
row-comparable to `crawl_02ff6f7a` on any `page_type`-scoped metric**, for the
reason set out in §7.2's box and keyed to commit `9fdaafa`.

The render evidence for this gate is in the git-ignored task directory
(`.superpowers/sdd/2026-08-29-phase-8-full-picture/renders/`, 14 files, 5.2 MB),
the deliverables in the git-ignored `audits/lavishalice.com-audit3/`, and the
export in `exports/` where the pre-fix server put it.

The API server used for this gate has been **stopped** (port 8787 free).
`gate-server-info.md` in the git-ignored task directory still holds the token, the
allowlist, the render directory and the restart command if anything needs
re-reading.

Deleting any crawl cascades:

```sql
delete from crawls where id = 'crawl_02ff6f7a-203c-4771-805c-feede04aed11';
```

# Phase 7 gate — the second audit measures what the first one guessed

**Date:** 2026-08-28
**Code:** branch `worktree-phase-7-audit-fidelity`, base `1c9ca51`. The crawl,
the render pass and the rules ran at **`a53be5c`** with ruleset **0.5.0** and
migrations 0000–0010. Twelve commits carry the phase:

| | |
|---|---|
| T1 render measurement | `f078bf8`, `e4aec02` |
| T2 the six missing numbers | `845216e`, `670911a` |
| T3 the surface's own knowledge | `e2d0586`, `48fc3cf`, `990bb86` |
| T4 click depth | `fedb0ff`, `4d2c083` |
| T5 the identifier guard | `8bc7e3e`, `a53be5c` |
| T6 part C, the skill reconciliation | `084e0c9` |

plus the commit that carries this file.

**Every number below was measured on the runs named here** — read off the HTTP
API during the run and quoted in the two task reports
(`.superpowers/sdd/2026-08-28-phase-7-audit-fidelity/task-6a-report.md`,
`task-6b-report.md`), computed from the two stored findings files, or re-queried
from the crawl's own rows in the dev database while this file was written. Every
comparison against the first audit names which artefact it read: the first
audit's findings file (`audits/lavishalice.com/findings.json`), its report, or
`docs/gates/phase-6.md`. **`docs/gates/phase-6.md` and
`audits/lavishalice.com/render-diagnosis.md` are untouched by this phase.** Where
this phase measured one of their claims and found it wrong, the correction is
recorded *here*, with the arithmetic — §4.3 and §4.2 are the two.

**Verdict: PASSED.** A second crawl of the same site, eleven hours after the
first, reproduced the first audit's 1,314 findings **to the finding**, added
exactly the twelve the three new rules found, and answered from measurement four
questions the first audit had to guess at, reconstruct by hand, or record as NOT
MEASURED. A fresh skills-only session then re-walked all 82 checks and produced
the full deliverable set. The crawl was polite from first contact to last: **zero
blocked pages, zero fetch failures, zero back-off escalations.**

---

## What the gate is

The plan states it as a delta, and the delta is the whole test. Six clauses, each
answered below with its measurement:

| | The plan asked | Answered |
|---|---|---|
| 1 | `renderable_word_count` within a **stated tolerance** of `rendered_word_count` on the diagnosis's two named reproduction pages | §4.1–4.2 — the tolerance is stated and the prediction behind it is **falsified**, measured, not smoothed |
| 2 | the three duplicate rules fire with real numbers | §4.6 — 12 groups, and the first audit's prediction about *which* is also falsified |
| 3 | CHECK-31 answered from click depth, **the 437-at-depth-0 number must move** | §4.4 — it did not move, and that is the evidence: it is preserved as the discovery-depth artefact it always was, beside `nullCount 356` |
| 4 | the identifier guard green | §5.4 — green, and it caught zero stale identifiers, which is itself a finding |
| 5 | politeness unchanged or better | §6 — better: 2000 ms from page one, ratchet silent, 0 blocked |
| 6 | the first audit's engine-defect list re-checked item by item | §7 |

A gate that only records its passes teaches nothing, so the two honest negatives
(§4.2, §4.6) and the one place where this phase's own evidence corrects an
earlier document (§4.3) are given more room than the successes.

---

## The two runs, side by side

| | **first audit** | **this phase** |
|---|---|---|
| `crawlId` | `crawl_2af4daf1-b920-4cdf-a837-90ec05ed923f` | `crawl_3f3ab847-2139-40d9-a1f5-7f9a8d92f54b` |
| Started | 2026-08-28T10:31:02.140Z | 2026-08-28T21:34:07.870Z |
| Ruleset | 0.4.0 | **0.5.0** |
| `perHostDelayMs` at start | 1000 | **2000** (the platform table's Shopify row, written by the first crawl) |
| Wall | 996.3 s (16 min 36 s) | **1111.8 s (18 min 31.8 s)** |
| Pages crawled | 551 | **551** |
| Frontier at end | done 551, pending 0, leased 0, failed 0 | **identical** |
| Links recorded | 35,145 | **35,145** |
| Sitemap URLs | 438 | **438** |
| `blockedPages` | 0 | **0** |
| `hostSpacingMs` | 1000 → 2000, escalated ~page 100 | **2000 → 2000, never escalated** |
| Peak sampled RSS | ≈ 277 MB | **≈ 223 MB**, flat 216–223 |
| Pages rendered | 28 (38 rows after a second pass) | **28**, one pass, `pagesRendered` = `selectionSelected` |
| Findings | 1,314 | **1,326** |
| Metrics | 855 | **1,023** |
| `rulesRunAt` | *(field did not exist)* | **2026-08-28T21:55:35.006Z** |

The site is the same site: same page count, same link count, same sitemap size,
same origin behaviour (§1.2). That stability is what makes every difference below
attributable to the engine rather than to the weather.

**The 115 s of extra wall is arithmetic, not weather.** 551 × 2000 ms = 1102 s.
The first crawl bought its 16 min 36 s by spending its first ~100 pages at
1000 ms before the site told it otherwise. **The politer start cost 1 minute 55
seconds and removed the hundred-page question.**

---

## 1. The crawl

Started 2026-08-28T21:34:07.870Z, over the HTTP transport on `127.0.0.1:8787`
with `ARIADNE_ALLOWED_DOMAINS='lavishalice.com,*.lavishalice.com'` and a fresh
bearer token. `runCrawl` was never called directly.

```json
{"siteUrl":"https://lavishalice.com/","maxPages":3000,"maxConcurrency":2,
 "perHostDelayMs":2000,"probeHosts":true}
```

Default user agent, `AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)`.

### 1.1 The poll trajectory

Eleven polls. `rssMB` is the server process (tsx + node), sampled at each poll.

| Wall (UTC) | status | done | pending | leased | failed | blocked | `hostSpacingMs` | rssMB |
|---|---|---|---|---|---|---|---|---|
| 21:34:30 | running | 6 | 437 | 2 | 0 | 0 | **2000** | — |
| 21:35:16 | running | 30 | 413 | 2 | 0 | 0 | 2000 | 216 |
| 21:36:55 | running | 78 | 365 | 2 | 0 | 0 | 2000 | 219 |
| 21:38:55 | running | 138 | 305 | 2 | 0 | 0 | 2000 | 218 |
| 21:40:56 | running | 200 | 342 | 0 | 0 | 0 | 2000 | 218 |
| 21:42:56 | running | 260 | 287 | 2 | 0 | 0 | 2000 | 221 |
| 21:44:56 | running | 320 | 228 | 2 | 0 | 0 | 2000 | 219 |
| 21:46:56 | running | 380 | 169 | 2 | 0 | 0 | 2000 | 219 |
| 21:48:56 | running | 440 | 109 | 2 | 0 | 0 | 2000 | 220 |
| 21:50:57 | running | 500 | 49 | 2 | 0 | 0 | 2000 | 222 |
| 21:52:54 | **finished** | 551 | 0 | 0 | 0 | 0 | 2000 | 223 |

(The first poll's RSS sample named the wrong process; the sampler was pointed at
the server's pid from the second poll on. Nothing else in that row is affected.)

**Every 120-second window moved `done` by exactly 60** — one request per 2000 ms
— for the whole run, where the first crawl only reached that regime after its
escalation. `pending` rising 305 → 342 at 21:40:56 is depth-1 link discovery, the
same shape the first crawl showed. `pagesCrawled` sat at 0 for eighteen minutes,
as documented; `frontier.done` is the live number.

### 1.2 Fetch outcomes, discovery, and origin health

`pages_query` paged in full — 551 rows, 3 calls at `limit: 200`:

| `fetchClass` | count | | `discoveredVia` | count |
|---|---|---|---|---|
| `ok` | 443 | | `sitemap` | **437** |
| `client_error` | 97 | | `link` | 113 |
| `redirect` | 10 | | `seed` | 1 |
| `non_html` | 1 | | `redirect` | 0 |
| **`blocked`** | **0** | | | |

Both filters are new this phase, and both answer something the first audit could
not:

- **`fetchClass=blocked` returns 0 rows.** `blockedPages: 0` on the status row is
  now corroborated by the page table rather than believed.
- **All 97 internal 404s were discovered via `link`, none via `sitemap`.** That is
  the difference between "the sitemap is stale" and "the site's own navigation
  points at 97 dead collection and product URLs" — and it is one query.
- **437 of 551 URLs entered the frontier from the sitemap.** This is the mechanism
  behind the discovery-depth artefact of §4.4, stated as a number for the first
  time.

An invalid value is refused by name:
`{"error":"discoveredVia 'guess' is not a discovery kind (one of: seed, link, sitemap, redirect)"}`.

**Origin health**, re-queried from this crawl's own rows (the API exposes no
response-time surface, so this one figure is SQL over `crawl_3f3ab847`):

| n | min | p50 | p90 | p99 | max | avg | avg html bytes | max html bytes |
|---|---|---|---|---|---|---|---|---|
| 551 | 91 | **291** | 390 | 549 | 687 | 287 | 310,539 | 488,079 |

The first crawl measured p50 314, max 1039, avg html 310,529. **The origin was
fast and steady both times, and marginally faster under the slower crawl** — the
2000 ms start was not the engine nursing a struggling server, and nothing in the
site's behaviour asked for it.

---

## 2. The render pass

```json
{"rendered":28,"failures":0,"unrendered":0,"elapsedMs":58434,
 "selection":{"selected":28,"budget":28,"suspects":0,"sampled":176,"truncated":true}}
```

21:53:17.750Z → 21:54:16.217Z. 27 gaps × 2000 ms ≈ 54 s plus render time: **the
pass paced itself at the crawl's spacing**, as it has since the Phase 6 fix.

Composition — **products seated FIRST, on a fresh crawl, without a re-render**:

| page type | type_size | seats |
|---|---|---|
| `/products/:slug` | 148 | **3** |
| `/collections/:slug` | 110 | **3** |
| `/pages/:slug` | 18 | **3** |
| `/blogs/blog/:slug` | 2 | 2 |
| `/collections/sale` | 2 | 2 |
| `/pages/email-signup` | 2 | 2 |
| 13 singleton types (incl. `/`) | 1 | 1 each |

Identical to the Phase 6 **re-render** and to nothing the Phase 6 first pass
produced: `type_size desc` selection is now the behaviour of a first pass on a
fresh crawl, not a fix applied after someone noticed. Both of the diagnosis's
reproduction pages are in the sample — `/` as a singleton type, `abbie-pearl` as
one of the three product seats — which is why §4.1 could be measured at all.

`render.coverage` reports `pagesRendered 28` and `selectionSelected 28`. **The
Phase 6 asymmetry (28 vs 38) was an artefact of two passes over one crawl and
does not exist here.**

---

## 3. The rules

```
POST /crawls/:id/rules  →  21:55:24.276Z → 21:55:35.011Z (10.7 s)
{"pagesScanned":551,"findings":1326,"metrics":1023, …}
```

`crawl_status` afterwards: **`rulesRunAt: "2026-08-28T21:55:35.006Z"`,
`findingsCount: 1326`.** The marker stamps, and the pair answers the question
every empty listing raised in the first audit — where 28 PASSes had to lean on a
summary the agent happened to keep.

| ruleId | this run | first audit |
|---|---|---|
| `content.near-duplicate` | 500 | 500 |
| `meta-description.too-long` | 240 | 240 |
| `links.orphan` | 200 | 200 |
| `meta-description.missing` | 107 | 107 |
| `links.broken-internal` | 97 | 97 |
| `title.too-long` | 61 | 61 |
| `title.too-short` | 42 | 42 |
| `headings.h1-missing` | 19 | 19 |
| `images.missing-dimensions` | 11 | 11 |
| `headings.level-skip` | 9 | 9 |
| `meta-description.too-short` | 8 | 8 |
| `pages.not-in-sitemap` | 6 | 6 |
| `images.missing-alt` | 4 | 4 |
| `content.placeholder` | 3 | 3 |
| `canonical.points-elsewhere` | 2 | 2 |
| `content.exact-duplicate` | 2 | 2 |
| `hreflang.missing-return-link` | 2 | 2 |
| `headings.h1-multiple` | 1 | 1 |
| *subtotal, excluding the new rules* | **1,314** | **1,314** |
| **`title.duplicate`** | **5** | — (rule did not exist) |
| **`meta-description.duplicate`** | **3** | — |
| **`h1.duplicate-text`** | **4** | — |
| **total** | **1,326** | 1,314 |

**The old rules reproduced the first audit to the finding, on a crawl eleven
hours later.** 1,314 + 5 + 3 + 4 = 1,326: **the entire findings delta is the
three new duplicate rules**, and nothing else moved. Metrics 855 → 1,023, delta
+168, which is exactly `structure.click-depth-distribution`'s 168 rows.

The rules that fired zero and mean it: `content.thin` 0, `content.thin-skipped`
0, `h1.duplicate-skipped` 0, `content.csr-dependent` 0. The last three are the
new skip-gates saying *the column was there and the answer was no* — not *the
rule could not look*. `content.csr-dependent`'s zero has a caveat of its own
(§4.9).

`derived`: `deriveClickDepth` root 1, rootRedirects 0, reachable 94, unreachable
457, maxDepth 6, capped 0; `deriveFieldPresence` blocks 591; `deriveUrlParams`
params 2.

---

## 4. The delta measurements

### 4.1 The two reproduction pages — the triple counts

| page | `wordCount` (now / first audit) | `renderableWordCount` | `renderedWordCount` | renderable − rendered |
|---|---|---|---|---|
| `https://lavishalice.com/` | **1138** / 1139 | **770** | **281** | **489** |
| `…/products/abbie-pearl-embellished-mini-shift-dress-in-white` | **1340** / 1413 | **784** | **330** | **454** |

The other two rendered products, for shape: `abigail…` 1326 / 778 / 323 (gap
455), `adelaide…` 1335 / 792 / 333 (gap 459).

**Why `wordCount` itself moved, and why the two pages moved differently.** T1's
template exclusion is a semantic change to `word_count`, disclosed at the time
and repeated here: `<template>` subtrees are no longer counted, because their
text is in no DOM, under no CSS and in no index. The home page carries one word
inside a template, so it moved 1139 → 1138. The product page carries eight
template elements holding **73** tokenizer words, so it moved 1413 → 1340. Both
deltas are exactly the template content and nothing else (§4.3 verifies this on
the diagnosis's own saved bytes). The rendered numbers reproduce the diagnosis's
controlled experiment: home 281 exactly, product 330 against its 335 — a
five-word drift over eleven hours on a page carrying a live stock and price
widget.

`renderableWordCount` is the column that did not exist before this phase: the
same count minus the words the page's own markup hides.

### 4.2 The 425-word constant — the falsified prediction, stated plainly

The plan's fix shape, taken from `render-diagnosis.md`, predicted that after
template exclusion and markup-only hidden-surface suppression **the two sides
would "diverge only on CSS-hidden chrome"** — true — and framed that residual as
small enough that a render-diff rule could compare the columns directly. **That
prediction is falsified.**

Across all 28 rendered pages the gap `renderableWordCount − renderedWordCount` is
**min 425, max 489, mean 435.1**, and it is **exactly 425 on 19 of the 28
pages**. The nine exceptions are the home page (489), the three products
(454/455/459) and the five blog URLs (435–472).

```
/apps/wishlist              989 raw   621 renderable   196 rendered   gap 425
/collections/all            993       625              200            gap 425
/collections/bags          1144       776              351            gap 425
/pages/data-breach-policy  1930      1562             1137            gap 425
/                          1138       770              281            gap 489
/products/abbie-pearl      1340       784              330            gap 454
```

**The shape of the miss is more useful than the prediction would have been.** The
two sides no longer differ by a *ratio* that grows with the page — before the fix
the raw side ran 3.2–4.0× the rendered one — they differ by a **fixed per-site
offset of ~425 words**: one constant block of chrome, the same on a 196-word page
and on an 1,137-word page.

The arithmetic of what the fix bought, on `/apps/wishlist` where the whole page is
chrome: raw − rendered was **793** (the ~794 constant the diagnosis found in the
database); renderable − rendered is **425**. **The markup-only suppression caught
368 words, 46% of the constant.** What remains is CSS-*class*-driven hiding —
`md-max:hidden`, `sm:hidden`, `.hidden`, `x-popover`,
`header-sidebar#sidebar-menu` — invisible to any tokenizer that does not do
layout, exactly as the plan said it would be. The plan's own contingency applies:
*"if the gate shows it's insufficient, that is a finding for a future CSS-aware
pass, not a silent widening."* It is a finding, it is recorded, and nothing was
widened.

**The tolerance, stated as the gate requires.** On a Tailwind-class-hidden theme
`renderableWordCount` runs a **near-constant ~425 words above**
`renderedWordCount`. Any render-diff rule must be written against that offset,
not against equality. The residual bias still points the way it did before —
toward **false negatives** for `content.csr-dependent` — but the masking margin
has halved.

**What the thin-content floor did with it.** `content.thin` now reads
`renderableWordCount`, and the site-wide floor moved **990 → 621**
(`content.metrics-by-type` site row: `wordCount {min 989, median 1119, mean
1230.47}`; `renderableWordCount {min 621, median 749, mean 793.11}`). The rule
still fires 0 at its 150-word threshold, because 425 words of class-hidden chrome
remain in the number. **The Phase 6 caveat survives in reduced form and must
still be quoted**: the floor the engine can see is 621; the floor the reader sees
is 281. `content.thin-skipped` fired 0, so no page was silently unjudged.

### 4.3 A correction to the record: the `<template>` figure was 5.2%, not 34%

`audits/lavishalice.com/render-diagnosis.md` states, twice, that `<template>`
content on the product page is **"482 of 1413 words — 34% of the page's raw
`word_count`"**, and lists it as the certain half of the raw-side argument. That
document stays as it is — it is the record of what was believed when the fix was
planned. **The number in it is wrong, and this is where the correction lives.**

Re-measured offline against the **same saved bytes the diagnosis used**, with the
shipped analyzer and no new request to the site:

- `analyzeHtml(product.html).wordCount` = **1340**, identical to the crawl's
  stored value — so the page did not change and the crawl measured these bytes.
- Stripping every `<template>` subtree with cheerio and re-running the analyzer
  gives **1340 as well**: the exclusion is **complete**, `templateDepth` misses
  nothing.
- The page has 8 `<template>` elements; the streaming tokenizer's words inside
  them total **73** — 72 in `#quick-buy-content`, 1 in `#header-sidebar-template`
  — and 1413 − 1340 = 73 confirms it.
- The 482 came from the throwaway diagnostic `_diag/attribute.ts:57`,
  `templateWords += count(t.content.textContent)`, **with no script/style skip
  applied** (the SKIP set on line 15 governs the other walk, not this one). It
  counted the JavaScript and JSON inside the quick-buy template as page words.

**So the defect was real, the fix is complete and verified, and the magnitude in
the argument for it was inflated by 6.6×: 73 words, 5.2% of the product page's
raw count, not 482 and 34%.** It is corrected here because 34% is the figure a
reader would quote, and because a gate document that lets a measured number stand
against a re-measured one is not doing its job.

### 4.4 Click depth — the artefact contrast that is the gate evidence

Both metrics ran over the same 443-page indexable cohort.

| | `structure.depth-distribution` (discovery) | `structure.click-depth-distribution` (new) |
|---|---|---|
| count | 443 | 443 |
| min / median / max | 0 / **0** / 1 | 0 / **1** / **6** |
| p25 / p75 / p95 | 0 / 0 / 0 | 1 / 2 / 4 |
| mean | **0.01** | **1.52** |
| `nullCount` | *(field does not exist)* | **356** |
| claims | CHECK-32 | **CHECK-31** |

The plan asked for "the 437-at-depth-0 number to move". **It did not move, and
that is the finding.** The discovery table is byte-identical to the first
audit's — `{count 443, min 0, p25 0, median 0, p75 0, p95 0, max 1, mean 0.01}` —
because it was never wrong about what it measures. It is preserved, re-titled to
say what it actually measures (hops from a seed), stripped of its CHECK-31 claim,
and stood beside the measure CHECK-31 always meant. **The contrast between the two
rows is the evidence.** The mechanism now has a number attached to it: 437 of 551
URLs were `discoveredVia: sitemap`, and every sitemap URL is enqueued as a seed.

Full click-depth histogram over all 551 crawled pages:

| `clickDepth` | 0 | 1 | 2 | 3 | 4 | 5 | 6 | **null** |
|---|---|---|---|---|---|---|---|---|
| pages | 1 | 62 | 20 | 5 | 3 | 2 | 1 | **457** |

Per page type, over the indexable cohort — the finding of the phase:

| page type | count | `nullCount` | min | median | max |
|---|---|---|---|---|---|
| *(site)* | 443 | **356** | 0 | 1 | 6 |
| `/products/:slug` | 148 | **148** | — | — | — |
| `/collections/:slug` | 110 | **89** | 1 | 1 | 3 |
| `/pages/:slug` | 18 | **18** | — | — | — |

**Not one of the 148 indexable product pages is reachable by any chain of
internal links from the home page.** Neither is any `/pages/:slug`. 89 of 110
collections are not either. That is **356 of 443 indexable pages — 80.4%** — and
the old metric recorded every one of them at depth 0.

**What that did to the verdicts.** In the first audit **CHECK-31 was recorded
PASS**: counted off `depth`, 437 of 443 indexable pages sat at zero and the site
read as perfectly flat. It is now **FAIL, critical**. CHECK-33b was FAIL in both
audits, but in the first one its "sitemap only" tier was empty by construction —
the auditor reached the verdict another way — and it now reads 148 of 148
products directly off `clickDepth`. Two checks that were answerable only by
hand-rebuilding reachability are answered by the engine, and one of them was
answered *wrongly* before.

### 4.5 The corroboration chain — three surfaces, one site structure

The three numbers are a subset relation, not a disagreement, and each is now read
off a different surface:

- `links.orphan` reports **`{count: 200, truncated: true, total: 243}`** — pages
  with no internal inlink from anywhere in the crawl.
- `structure.click-depth-distribution` reports **`nullCount: 356`** over the
  indexable cohort (457 over all 551 rows) — pages no chain of links reaches from
  the home page.
- `pages_query` with `discoveredVia: sitemap` returns **437** URLs, **357** of
  which carry a null `clickDepth`.

Unreachable ⊇ sitemap-discovered-and-unreachable ⊇ orphaned: 356 ≥ 357-over-the-
whole-crawl's-indexable-share ≥ 243. An orphan has no inbound link at all; a
null-depth page may have inbound links from pages that are themselves
unreachable — the product cohort is exactly that case, an island of 82
product-to-product inlinks that nothing outside reaches. **The first audit had to
infer "at least 222 orphans" from an inlink median of zero.** Three independent
surfaces now agree, and no reconstruction is needed.

### 4.6 The three new duplicate rules — and the second falsified prediction

**The first audit predicted that the 148-product meta-description template would
produce a large duplicate group. It is falsified, and the reason is worth
stating: the products carry no meta description at all.**
`meta-description.missing` fired 107 times, and a null is not a duplicate. There
is no product-template group to find because there is no product template text.

What actually fired — twelve groups, every one a pair (`count: 2`):

| rule | groups | what they are |
|---|---|---|
| `title.duplicate` | **5** | the twice-published blog article; `/blogs/news/dazzling-jewellery` ↔ `/collections/jewellery`; `/collections/sale` ↔ its `?product-type=dress` variant; `/pages/email-signup` ↔ its `?srsltid` variant; `/pages/search` ↔ `/search` |
| `meta-description.duplicate` | **3** | `/` ↔ `/search`; `/collections/outlet-under-30` ↔ `/collections/outlet-under-50` (the same 60-word blurb); `/collections/sale` ↔ its parameter variant |
| `h1.duplicate-text` | **4** | the twice-published article; `/collections/knitted-dresses` ↔ `/collections/knitted-dresses-1`; and the two parameter variants above |

Three of the twelve are the parameter and canonical duplicates already known from
`content.exact-duplicate`. The rest is real editorial duplication the first audit
could only see as near-duplicate *fingerprints*: `knitted-dresses` vs `-1` and
`outlet-under-30` vs `-50` are now named as what they are. `h1.duplicate-skipped`
fired 0, so every H1 count on this crawl has an `h1_text` beside it — the skip
gate proves the answer is real rather than pre-Phase-7 silence.

**Twelve groups is a small number, and that is the honest result.** The rules
work; the prediction was wrong.

### 4.7 `redirect.volume` — `redirectInlinks`, and the finding audit 1 could not see

```json
{"totalPages":551,"redirectPages":10,"ratioPct":1.8,"chains":0,"loops":0,
 "redirectInlinks":898}
```

**Ten redirecting URLs; 898 internal links point at them — 163% of the URLs
crawled.** CHECK-10's Evaluate line reads *FAIL if total redirect inlinks exceed
10% of total URLs crawled*, so this is a critical crawl-budget finding and the
site's third-largest by volume.

The first audit recorded **CHECK-10 as PASS**. It could report only "10 redirects,
1.8% of the crawl" and had no way to say the site walks into them nearly nine
hundred times — the difference between a tidy-up and a template fix. That is the
whole argument for the field, measured: `ratioPct: 1.8` passes the check;
`redirectInlinks: 898` fails it decisively, and they are the same site.

**This is also the phase's one audit-*wrong* documentation divergence.** Both
skills still said total redirect inlinks were NOT MEASURED, four commits after the
field shipped, and the skills-only auditor had to override the instruction by
quoting the engine. Fixed in `084e0c9`; disposition in §5.3.

### 4.8 `robots_get` — the AI-crawler question, answered

`GET /crawls/:id/robots` returns `outcome: "read"`, `truncated: false`,
`crawlDelaySec: null`, `note: null`,
`sitemapSources: ["https://lavishalice.com/sitemap.xml"]`, the user agent matched
under, and **the full raw body** (3,626 bytes). What the file says, which the
first audit could not read:

- **There is no `GPTBot`, `ClaudeBot`, `Claude-User`, `PerplexityBot`, `CCBot`,
  `Google-Extended`, `Bytespider` or `Applebot-Extended` block anywhere in it.**
  Exactly two user-agent groups exist: `User-agent: *` and
  `User-agent: adsbot-google`. AI crawlers are therefore governed by
  `User-agent: * / Allow: /` — **permitted by default rather than by decision**.
  For CHECK-03's AI half that is the client finding: *the site has taken no
  position, in either direction*, and a business that has not decided whether AI
  assistants may read its catalogue has decided by omission.
- The file is agent-native in a different way: a header comment pointing at
  `https://lavishalice.com/agents.md`, a UCP discovery endpoint
  (`/.well-known/ucp`), a UCP/MCP endpoint (`/api/ucp/mcp`), a recommendation
  that personal-shopper agents install `https://shop.app/SKILL.md`, and an
  explicit **"Checkouts are for humans"** — no scripted form fills, no end-to-end
  agent flows that finalise payment without contemporaneous human approval.
- Crawl-trap discipline is real: `sort_by`, `+`/`%2B` facet joins, multi-`filter`
  combinations, `preview_theme_id`, `oseid` and `ls=` are disallowed, as are
  `/cart/`, `/checkout`, `/orders`, `/account`, `/services`, `/sf_*`, `/cart.js`
  and `/recommendations/products`.
- **We honoured all of it.** Public HTML only; no cart, checkout or account URL
  touched; no transaction attempted. `crawlDelaySec` is null, so the 2000 ms
  spacing was entirely our own choice — nothing in robots asked for it.

### 4.9 `content.csr-dependent` — an honest zero with a stated reason

**0 findings, and now for a defensible reason — with a caveat that is itself a
Phase 8 item.** The rule fires on `rendered ≥ 2 × renderable` AND
`rendered − renderable ≥ 150`. Computed by hand over all 28 rendered rows,
**0 pages satisfy it, and it is not close**: rendered/renderable runs **0.32 to
0.73**. Every rendered page has *fewer* visible words than its markup-visible
count, never twice as many. The site is server-rendered, so this is the same zero
as the first audit — but it now compares two numbers that answer the same
question about the same document.

**The caveat, which the skills-only auditor found independently and recorded as a
bug report about the rule:** given the 425-word constant on the renderable side,
the firing condition was **arithmetically unreachable on this crawl whatever the
site did**. Zero here is not "no client-side rendering"; it is a comparison
nothing could answer. It matters exactly where you would want the answer —
CHECK-33b found 100% of products with no HTML link path, the symptom a
client-side product grid produces, and CHECK-01 is the check that would have
confirmed it. Recorded as CHECK-01 SKIP with the arithmetic in the notes, which
is the right disposition; the comparability question goes to Phase 8 (§9).

### 4.10 Truncation fields on the wire

`GET /crawls/:id/issues?limit=50` returned all 21 rules; exactly two carry a
truncation field and nineteen carry none:

```
links.orphan            count 200   {truncated: true, total: 243}
content.near-duplicate  count 500   {truncated: true, atLeast: 501}
```

`total: 243` reproduces the Phase 6 post-fix spot-check exactly. **The
absence-carries-meaning contract holds on a fresh crawl**: nothing on this listing
needs reconstructing.

---

## 5. The audit — 82 checks by a skills-only agent

A fresh session, given **only `skills/` and the HTTP API** — no repository
source, no git, no psql, no browser, no GSC/GA4/Ahrefs, no external requests —
walked all 82 checks and produced the full deliverable set.

| File | Size |
|---|---|
| `audits/lavishalice.com-audit2/ariadne-findings.json` | 219 KB, 82 checks |
| `audits/lavishalice.com-audit2/audit-report.md` | 68 KB, 1,056 lines |
| `audits/lavishalice.com-audit2/action-plan.xlsx` | Summary + 16 tabs, 1,839 data rows |

**46 API calls in total**, against the first audit's 83: 1 `crawl_list`, 2
`crawl_status`, 1 unfiltered `issues_list`, 8 deliberate refusal probes, 6
`metrics_get` (cursors followed, 1,023 rows), 3 `pages_query` (the whole 551-row
census), 24 `issue_urls` (all 21 rules to `nextCursor: null`, every row count
matching its rule's `count`), 1 `robots_get`. `export_crawl` was not needed at
this size, and `crawl_rules` was **deliberately not run** — the marker made it
unnecessary, which is §5.3's divergence B.

### 5.1 The tally, and the honest explanation for it

Both tallies are computed from the two stored findings files.

| | audit 1 (whole file, 82) | audit 2 (whole file, 82) | | audit 1 (CHECK-03…46 + 33b, 45) | audit 2 (same 45) |
|---|---|---|---|---|---|
| PASS | 34 | **23** | | 26 | **21** |
| FAIL | 15 | **16** | | 12 | **14** |
| SKIP | 32 | **42** | | 6 | **9** |
| AGENT | 1 | **1** | | 1 | **1** |

*(These are the files. `docs/gates/phase-6.md`'s own in-scope table reads
28/11/3/3 over the same 45 — a four-check difference from the artefact it
describes, most visibly CHECK-41 and CHECK-42, which that document argues in
prose should be SKIP and counts in its table as AGENT. Phase 6's document stands
as written; this one reads the files.)*

**More FAILs because more is measured. More SKIPs because the policy got
stricter. Neither number is a quality judgement about the site, which did not
change.** Fourteen verdicts moved, every one for a reason that is named:

| Check | audit 1 → 2 | Why |
|---|---|---|
| CHECK-31 | PASS → **FAIL (critical)** | click depth: 356 of 443 unreachable. The first verdict was wrong, and the artefact is why (§4.4). |
| CHECK-10 | PASS → **FAIL (warning)** | `redirectInlinks` 898 = 163% of URLs (§4.7). |
| CHECK-03 | PASS → **FAIL (info)** | the robots body is readable: no AI-crawler decision exists (§4.8). |
| CHECK-01 | PASS → **SKIP** | the diff rule's firing condition was unreachable; a PASS asserted something nothing measured (§4.9). |
| CHECK-43, 45, 46, 50, 52, 57, 68, 70 | PASS/FAIL → **SKIP** | the hybrid policy of §5.2: engine silence narrows the check, only the browser half can answer it. |
| CHECK-66 | PASS → **SKIP** | N/A: not one `?variant=` URL was reached, so the check's PASS condition was never tested. |
| CHECK-04 | FAIL → **PASS** | **a judgement disagreement between two auditors, not an engine delta.** Both read the same rules (`indexability.noindex` 0, `indexability.meta-header-conflict` 0). Auditor 1 failed it on the *inverse* condition — five utility URLs indexable that should not be — where auditor 2 read that as CHECK-27/CHECK-67 territory and passed the noindex question. Recorded because the gate should not pretend two humans reading one checklist line will always land together. |

The 42 SKIPs are the honesty condition working, not the audit shirking: 27 are
browser-only, 11 are GSC/GA4/Ahrefs-only, and the rest are hybrids whose deciding
criterion needed a tool that was not there. **Every one is named individually in
the report's *Not audited* section with what it would take.**

### 5.2 The hybrid ruling, made once and written down

Nine checks landed in a class the skill did not route: the engine's *silence*
answers the check's pass condition while a browser-only criterion could still
fail it. `schema.breadcrumb-absent` is silent, so BreadcrumbList markup exists —
and "the markup matches the visible breadcrumb" is unverifiable.
`mobile.viewport-missing` is silent, so every page declares a viewport — and
whether the page is usable on a phone is a different question.

**The ruling: the categorical no-half-PASS sentence stands, and the class is now
named in the skill.** Verdict is SKIP with the engine half quoted in `notes` as
supporting evidence; engine silence NARROWS a hybrid check — it eliminates one way
to fail — and does not answer it. The alternative reading would have produced nine
more passes on questions nothing asked, on a site whose entire product catalogue
turned out to be unreachable. `084e0c9` writes it into §3.2 with the nine checks
named, so no future audit re-derives it.

### 5.3 Divergences — final disposition

Eleven, from the skills-only session. Every one is either fixed in `084e0c9` or
listed here as accepted with its reason.

| # | Divergence | Disposition |
|---|---|---|
| **A** | Both skills said total redirect inlinks were NOT MEASURED; `redirectInlinks` shipped in T2. **The one that makes an audit wrong** — an agent following the skill literally records the site's third-largest finding as unmeasured and passes CHECK-10. | **FIXED.** SKILL.md §2.4 and checklist CHECK-10 (Engine step 3, Analysis step 2, the crawl-budget line) read the field, with the 1.8%-vs-163% contrast as the worked example and the "never substitute `ratioPct`" warning kept. |
| **B** | `crawl.rulesRun` mandatory in the findings schema and unobtainable by the flow that produces it: Phase 1 says a judged crawl is auditable by whoever finds it, and `pagesScanned` exists only on the `crawl_rules` summary. | **FIXED, at the interface.** `rulesRun` is nullable with a **required caveat** naming the marker pair as the proof of judgement; both consumer skills now state that `rulesRunAt` is the gate. The auditor's invented shape is the shipped one. |
| **C** | `checklist.md`'s Evaluation Principle 4 still carried the pre-marker doctrine ("the only proof is the `crawl_rules` summary — run it yourself"), which T5's sweep missed. | **FIXED.** Rewritten to the `rulesRunAt` + `findingsCount` pair, with the summary kept as the per-rule breakdown rather than as the proof. |
| **D** | The action plan's intake had no door for a rule-less FAIL. Seven of sixteen failures — CHECK-03/10/22/31/33/33b/67 — are answered by a metric, a census or the stored robots.txt with no finding rows, and they include the site's two worst problems. | **FIXED.** §1a gains a third candidate class with its tab body built from the findings file's evidence `args` plus `pages_query`/`metrics_get`/`robots_get` reads, stated on the tab. |
| **E** | §1c could admit nothing and the Summary had no reason code for it (CHECK-33, CHECK-40). | **FIXED.** G0, the catch line: any FAIL with rows that G1–G5 decline reaches 1e marked *ungated*, and "admitted by no gate (G0)" joins the ledger vocabulary. |
| **F** | G5 reads a class-level `priority`, and it excluded live lorem ipsum (CHECK-40, 3 rows, warning, Medium) while CHECK-49 walked in on 15 rows. | **ADDRESSED BY G0, NOT BY CHANGING G5.** The candidate now reaches the ranking instead of vanishing; the observation that `priority` grades the check class rather than this instance is recorded in §1c so the next reader sees the hole's shape. Changing G5's input is a design change this phase did not make. |
| **G** | A diff rule can be silent because it is *vacuous*, and no skill warned about it (§4.9). | **FIXED on the skill side** — §2.4 now says a diff rule's silence is evidence only when its two columns are comparable, and `pages_query` publishes both so the auditor can check. **OPEN on the engine side:** the comparability question is a Phase 8 item. |
| **H** | CHECK-38's routing with no browser was ambiguous — the paragraph names 41 and 42 and never says what a metric-backed judgement check becomes. | **FIXED.** One paragraph: CHECK-38 keeps `AGENT` with the two metrics quoted and the unassessed half stated; what separates it from 41/42 is that those have no evidence at all. |
| **I** | §3.2's hybrid routing left the "engine clean, browser would decide" case unresolved — it moved 8 verdicts. | **FIXED** — see §5.2. |
| **J** | CHECK-44's "compare against how many pages the rule considered" is not executable: a silent rule publishes no considered count. | **FIXED as an instruction** (the ambiguity is now stated and the unexecutable comparison removed); **the missing count stays on the engine backlog** — Phase 6 item 3, still open. |
| **K** | Six smaller things. | **Five fixed:** the self-referential `inlinks.sources-by-type` map named as an island; a census recorded as an `observation` carrying its `tool`/`args`; the prefixed deliverable names made canonical; E1-vs-1a's double-exclusion of SKIPs resolved; path-matching checks told to take one `export_crawl` census at scale. **One accepted, not a skill defect:** the shared session scratchpad contained a stray `inspect.py` that shadows the standard library for anything run from that directory (`import openpyxl` died inside numpy). Environmental; the agent worked around it from a private subdirectory. Worth knowing for any future multi-agent session that runs Python. |

### 5.4 Do the Phase 6 divergences read fixed?

The skills-only session was asked to judge this from the instructions' side alone,
without reading the Phase 6 report. Its table, summarised:

**Yes, thirteen of them.** The judged-crawl marker settled every PASS from one
poll; the findings filename was found by both consumers on the first try;
CHECK-41/42 went to SKIP without hesitation; both truncated rules were reported as
"243 orphans, 200 listed" and "at least 501 pairs", never as totals; the three
duplicate rules were reported as groups *and* pages separately (5 titles / 10
pages, 3 descriptions / 6 pages, 4 H1s / 8 pages); the two `renderableWordCount`
null shapes were told apart correctly (108 rows null in *both* columns are exactly
the 97 404s + 10 redirects + 1 non-HTML, and zero rows had a `wordCount` with a
null renderable — so `content.thin-skipped`'s silence was right); `robots_get`
answered CHECK-03's contents half from stored evidence; `(untyped)` was reported
as **empty** rather than invented (196 types, 190 singletons, zero untyped); E4
was correctly disabled without Phase 0 so four small candidates went to the gates
on their merits; every one of the 16 candidates was protected from the cut, and
the Summary says the plan is bigger than the ten-tab target rather than cutting
quietly; every `Fix` cell is byte-identical to a `recommendation` in the findings
file, asserted by the workbook's own verifier; every metric explanation over 120
words was quoted to its first two sentences with the declared truncation marker.

**Mostly, one.** §3.2 exists and carried eleven checks — and did not resolve the
half-answered class, which is §5.2.

**Two could not be tested:** the `crawl_rules`-summary-as-evidence path (never
run, by design) and `export_crawl` (not needed at 551 pages).

**And the one that reads fixed most emphatically**, in the auditor's own framing:
counted off `depth` — 437 of 443 at zero — CHECK-33b would have passed on a site
whose entire catalogue is unreachable. It did not, because `clickDepth` answered
it directly.

### 5.5 The identifier guard

Green, and its first run **caught zero stale identifiers**. That is a finding
rather than an anticlimax: this phase's divergence class was **false claims and
omissions** — "the engine does not measure X" when it does, a paragraph of
superseded doctrine, a mandatory field with no route to it — and a guard that
reads backticked names cannot read a sentence. The four shape-equality tests it
ships beside (crawl_status, crawl_rules, robots_get, and the three query tools'
row shapes) close the half that *is* mechanical: a documented shape missing a
field it returns, which is exactly what Phase 6 divergence D-4 was. The guard's
docblock states the limit rather than claiming the class. It was also the
regression net for `084e0c9`'s edits, which is the second job it now does.

---

## 6. Politeness

- **Zero blocked pages** — at every poll, at the end of the crawl, after the
  render pass, and confirmed independently by `fetchClass=blocked` returning 0
  rows.
- **Zero escalations.** `hostSpacingMs` began at 2000 and ended at 2000 against a
  30,000 ms ratchet cap. **The ratchet's behaviour across the two crawls is the
  measurement**: started at 1000 ms, the same site pushed back and the engine
  doubled itself by page 100; started at 2000 ms, the site never had to say
  anything for 551 pages. The platform table's Shopify row — written from the
  first crawl — was tested the only way a claim like that can be, by starting
  there and watching the engine stay quiet.
- **The render pass ran at 2000 ms too**: 58.4 s for 28 pages, 27 gaps.
- **Total requests to the site this visit:** 551 crawl fetches + 28 renders + 1
  robots.txt + 6 sitemap documents + 4 host-probe requests ≈ **590**, one every
  two seconds, over 21 minutes. Second visit of the day, owner-sanctioned.
- Settings were never raised mid-run, the user agent was never changed, nothing
  was re-crawled to go faster, and no disallowed path was requested (§4.8).
- **Across both crawls: 0 blocked pages, 0 fetch failures, 0 manual
  interventions.**

---

## 7. The engine-defect list, item by item

The first audit's defect list and the Phase 6 gate's, re-checked against this run.

| Item | Disposition, measured here |
|---|---|
| **render-diagnosis** — raw and rendered word counts answer different questions; no rule may subtract them | **FIXED, and measured.** `renderableWordCount` ships beside `wordCount`; the two sides differ by a fixed ~425-word offset instead of a 3–4× ratio. `<template>` exclusion verified complete on the diagnosis's own bytes. Residual stated as a tolerance rather than erased (§4.1–4.3). |
| **D-1** — `count` capped and the skill said it was the total | **FIXED in P6, VERIFIED STABLE.** Two rules carry a truncation note, nineteen carry none (§4.10). |
| **D-3 / C-4**, P6 backlog 8 — `depth` is discovery depth; CHECK-31's sitemap-only bucket empty by construction | **FIXED HERE.** `structure.click-depth-distribution` with `nullCount`, `clickDepth` on `pages_query`. 356 of 443 unreachable; CHECK-31's first verdict was wrong and is now right (§4.4). |
| **D-9 half 1** — `legacyHosts` not echoed, CHECK-15 uninterpretable | **FIXED HERE.** `crawl_status` returns `legacyHosts: []` — "nobody named a legacy domain", distinguishable from "the legacy domain does not redirect". |
| **D-9 half 2** — robots' `Sitemap:` line not reported back | **FIXED HERE.** `robots_get` returns `sitemapSources` *and* the raw body containing the line. |
| **CHECK-03 contents half** — robots.txt unreadable after the crawl | **FIXED HERE.** Full raw body on the wire; the AI-crawler question answered with evidence (§4.8). |
| **P6 backlog 17 (third)** — no engine-side signal that the rules had run; 28 empty-listing PASSes leaned on a remembered summary | **FIXED HERE.** `rulesRunAt` + `findingsCount` on the crawl row; the second audit never ran `crawl_rules` at all. |
| **P6 backlog 12** — `crawl_status` should echo the crawl's own inputs | **FIXED HERE** (the `legacyHosts` row above). |
| **P6 backlog 14** — nothing enforces the skills against the code | **CLOSED by T5's guard**, with its limit stated: it reads identifiers, not claims (§5.5). |
| *new* — `redirect.volume` could not say how much of the site pointed at its redirects | **FIXED HERE.** `redirectInlinks: 898` against 10 redirecting URLs (§4.7). |
| **thin-floor blindness** (CHECK-13/40 caveat) | **PARTIALLY FIXED, stated honestly.** The rule reads `renderableWordCount`; the site-wide floor moved 990 → 621. It still fires 0 at 150 words because 425 words of class-hidden chrome remain. The caveat survives in reduced form and must still be quoted (§4.2). |
| **D-2**, P6 backlog 4 — `derivePageType` is the URL path, not a template | **STILL OPEN — not touched this phase. FOURTH SIGHTING**, same real-site number: 196 distinct page types over 551 pages, `/products/:slug` 211, `/collections/:slug` 115, `/pages/:slug` 29, and **190 types that occur exactly
once** (re-queried from this crawl's rows). The render selection's `type_size desc` keeps the templates covered *despite* the typing, so its remaining cost is exactly the per-template breakdown CHECK-35/36/37 want, unproducible by filtering on `pageType` unless the auditor already knows the four ids. |
| **D-5**, P6 backlog 13 — `renderPassCount` holds the last pass's rendered count | **STILL OPEN.** It reads 28 here, unambiguous only because exactly one pass ran. |
| **C-2**, P6 backlog 9 — back-off leaves no durable trace of what triggered it | **STILL OPEN, and untested by this crawl** — nothing escalated, so there was nothing to log. The gap is unclosed, not disproven. |
| **C-5**, P6 backlog 10 — per-render `blockedRequests` counted and thrown away | **STILL OPEN.** 28 renders, no stored blocked-request evidence. |
| **D-7**, P6 backlog 11 — findings interface cannot express a scoped run | **STILL OPEN.** This audit ran all 82 checks, so it did not need the field; a scoped one still would. |
| **D-8**, P6 backlog 3 — CHECK-44 has no pages-considered count | **STILL OPEN, and hit again** (§5.3 divergence J). All four schema rules fired 0, and "complete markup everywhere" is still indistinguishable from "no markup anywhere". |
| **P6 backlog 15** — the action plan's cohort and cap heuristics unexercised | **FIRST EXERCISED HERE**: 16 tabs, 1,839 data rows, lanes assigned by cohort concentration on a real site, no defect surfaced. One run is not a proof; it comes off the "never tested" list and stays on the watch list. |
| **P6 backlog 16** — nothing checks a report's numbers against the crawl | **STILL OPEN.** The workbook's `Fix`-column verifier is the analogous check on the other deliverable, and it held. |
| **P6 backlog 17 (first two)** — the HTTP path inside an MCP refusal; `recommendation` beyond the brief's shape | **STILL OPEN.** Untouched. |
| **P6 backlog 1, 2, 5, 6** — streaming metric rows; `hreflang.invalid-code` streaming; persisting the resolved render config; the browser tree's own bound | **CARRIED UNCHANGED.** 1,023 metric rows and a 28-page render pass are not the measurements those items need; item 6 stays owed to a phase that renders at scale. |
| **P6 backlog 7** — the `renderer.test.ts` spacing flake | **Closed in Phase 6.** No recurrence: 1,327 tests, no flake across this phase's runs. |

---

## 8. Coverage and the suite

| | |
|---|---|
| Suite | **1,327 tests, 60 files** |
| `tsc --noEmit` | clean |
| Ruleset | **0.5.0**; migrations 0000–0010 |
| Rules registered | **85 = 27 page + 46 query + 12 metric** (Phase 6 ended at 79 = 26 + 42 + 11) |
| Added this phase | `content.thin-skipped` (page); `title.duplicate`, `meta-description.duplicate`, `h1.duplicate-text`, `h1.duplicate-skipped` (query); `structure.click-depth-distribution` (metric) |
| Checklist coverage | 47 crawl-derived checks: **44 claimed, 3 agent, 0 unclaimed** — re-pinned from registry truth in T1, T2 and T4, as every phase since Phase 3 has done |

**Two claims moved without changing a total, and the coverage pin cannot show
it**, so it is written here as well as in the test: **CHECK-31 left
`structure.depth-distribution` and is claimed by
`structure.click-depth-distribution`**, and the metric that gave it up took
CHECK-32, which `links.orphan` already claimed. Claims are a set union, so both
edges are invisible in the arithmetic. The same union is why the duplicate gap
survived to production under a pin that said nothing was unclaimed: CHECK-35, 36
and 37 were already claimed by the *missing*-field rules, so answering them more
completely registered as no change at all. **A coverage pin proves that every
check has a claimant; it cannot prove that a claimant answers the check.** That
is this phase's lesson about its own CI query, and it belongs beside the numbers
rather than under them.

---

## 9. Backlog

### Added by this gate — the Phase 8 candidates

1. **CSS-aware suppression, or a per-crawl `chromeWords` figure, for the 425-word
   constant.** §4.2 is the measurement and the diagnosis's own secondary lever is
   the shape: text byte-identical across every page of a crawl, computable in SQL
   over content hashes. Until one of them exists, `content.thin` reads a number
   ~425 words above the truth on a class-hidden theme and its zero must be quoted
   with the caveat.
2. **The comparability answer for `content.csr-dependent`** (§4.9, divergence G).
   The engine question first: are `renderedWordCount` and `renderableWordCount`
   comparable at all, and if not, the rule is broken and so is CHECK-01's evidence
   line. This is the prerequisite for item 1 being worth doing at all — both are
   about the same asymmetry.
3. **`derivePageType` — fourth sighting** (§7). Template inference:
   `/products/p17` read the way `/blog/17` already is. Four phases of evidence,
   one of them a client-visible audit defect.
4. **A pages-considered count for a silent rule** (D-8 / P6 backlog 3), so
   CHECK-44 can tell complete markup from no markup.
5. **`structure.deep-page` still reads discovery depth** while co-claiming
   CHECK-31 with the metric that now answers it. It fired 0 on this crawl because
   discovery depth maxes at 1 — a rule about deep pages returning zero on a site
   with 356 unreachable ones. A one-rule follow-up: read `click_depth`.
6. **Carried unchanged from Phase 6:** the politeness event log (C-2 — still
   untested, nothing escalated); render-pass `blockedRequests` evidence (C-5); the
   scoped-run field (D-7); `renderPassCount`'s name (D-5); streaming metric rows;
   `hreflang.invalid-code` streaming; persisting the resolved render config; the
   browser tree's own bound; a report-numbers checker; the two remaining Task 5
   items from Phase 6's item 17.

### The ledgered minors, by task

Recorded at review time, deferred deliberately, restated so they do not go quiet.

| Task | Minor | Disposition |
|---|---|---|
| T1 | svg-breakout parity divergence pre-existing and undocumented — a second permanent port/oracle class beside open-`<a>` | **Carried.** Named in the ledger; the header should name it. |
| T1 | `h1_text` merges words across `<br>` ("BigSale") — matches cheerio, but T2 compares H1s against titles | **Carried**, with a column-comment line. Analyzer-capture fix. |
| T1 | report prose slip ("eight nulls") | **Closed** — prose only, corrected in the task report. |
| T1 | **Deeper ruling ledgered:** whether template ELEMENTS (headings, images, links, canonical, JSON-LD) should count as page elements at all — moves `links`, `heading_counts`, `images_*`, and needs the oracle moved with it | **Carried, and it is a phase's decision, not a fix round's.** This phase excluded template *text* only, deliberately. |
| T2 | grouping aggregate full-scans `pages` once per rule × 3 | **Carried.** The next move if the 50k gate shows it: one scan for all three — **not** a smaller cap. |
| T2 | no plan-pinning mechanism exists — a future edit could reintroduce the ordering dependency with every test green but slow | **Carried**, documented in prose with measured numbers (29.9 s → 3.2 s at 20k/2k groups). An EXPLAIN-based assertion is the real guard and the repo has no mechanism for one. |
| T2 | 200-group cap is weak as an action list; `<br>`-broken titles do not group; no case-difference negative pin; `h1.duplicate-skipped` is a second unfireable SKIP entry; pages-vs-urls evidence-key drift; run.test comment | **Carried**, all six. The third unfireable skip rule now justifies a crawl-aging harness ability. |
| T3 | render path refuses on evidence it does not use | **Carried** — defensible, disclosed, verified 0 affected rows. |
| T3 | `issues_list` sentinel un-repointed; export widened shape untested on the export path | **Carried.** Prose consistency and a cheap key-set pin, later. |
| T3 | two skill files state stale marker claims | **CLOSED by T5's sweep** — and a **third** stale paragraph survived it (divergence C), closed here. |
| T4 | `structure.deep-page` and its copy still call discovery depth "click depth" | **Promoted to a Phase 8 item** (§9 item 5) — this gate measured the consequence. |
| T4 | redirect-rows-null test comment claims an unenforced invariant; `capped` only in `RunSummary`; "nothing beside the link join" understates 20–40 s at 50k; positional boolean flag style | **Carried**, all four. `capped` was 0 here, so the ambiguity was not exercised. |
| T5 | cannot-fail classify test (a structurally-true assertion reads as coverage); tool-field message overstates per-tool checking | **Carried**, both disclosed in the docblock. |
| T5 | 1e's High-protection breadth — 40 of 82 checks are High, so the ten-tab target becomes advisory on a FAIL-heavy audit | **MEASURED HERE and behaving as designed.** All 16 candidates were protected, the cut could take nothing, and the Summary said the plan is bigger than the target — which is the outcome the rule wants. Consequence ledgered, escape hatch unused. |
| T5 | Concern-4's justification inaccurate (the gate doc never names `findings.json`) | **Closed** — the artifact is right for a different reason, stated. |
| T5 | additive schema with no version bump is right here, and becomes a bump when Talos reads the file | **Carried as a Talos-seam note.** `ariadne-findings/1` gained `rulesRunAt` and `findingsCount` additively this phase, and gains a nullable `rulesRun` in `084e0c9`. The first external consumer makes the next such change a `/2`. |

---

## Machine

| | |
|---|---|
| CPU | Intel Core i5-6500 @ 3.20GHz, 4 cores (no SMT) |
| RAM | 32 GB |
| Kernel | Linux 6.8.0-138-generic |
| Node | v22.23.2 |
| Postgres | 16, Docker container `ariadne-pg` on port 5440 |
| Suite | **1,327 tests, 60 files, 282.8 s wall** |
| `tsc --noEmit` | clean |

The wall figures in §1 are dominated by the per-host delay, and the response-time
table in §1.2 is the site's, not this machine's.

## CI

Unchanged by this phase: `ubuntu-latest`, a health-checked `postgres:16` service,
Node 22, a cached `npx playwright install --with-deps chromium` keyed on the
locked Playwright version, then `npm ci` → `npx tsc --noEmit` → `npm run
db:migrate` → `npm test`, on push to `main` and every pull request.

**First CI run on this branch: PR #6, `test` pass in 3m16s —
<https://github.com/dawnforge-lab/ariadne/actions/runs/33244250696/job/99078829150>.**

The gate is not part of CI and cannot be: it crawls a third party's website with
their permission.

## Leftovers

**Both crawls stay in the dev database**, deliberately — the comparison in §5.1
is computed from their two findings files, and every figure in §§1–4 can be
re-queried from the rows:

| | `crawl_2af4daf1-…` (first audit) | `crawl_3f3ab847-…` (this phase) |
|---|---|---|
| pages | 551 | 551 |
| links | 35,145 | 35,145 |
| sitemap URLs | 438 | 438 |
| issues | 1,314 | 1,326 |
| metrics | 855 | 1,023 |
| rows with render evidence | 38 | 28 |

**A warning that must travel with the first one: `crawl_2af4daf1` is not
row-comparable to anything judged by ruleset 0.5.0.** Four surfaces changed
semantics under it — the thin floor, the soft-404 ceiling, the CSR comparison and
the render selection — and its `renderable_word_count` is null on every row, which
is why `content.thin-skipped` exists. Read it as the first audit's *report*, not
as rows beside these.

The API server used for this gate has been **stopped** (port 8787 free).
`gate-server-info.md` in the git-ignored task directory still holds the token, the
allowlist and the restart command if anything needs re-reading.

Deleting either crawl cascades:

```sql
delete from crawls where id = 'crawl_3f3ab847-2139-40d9-a1f5-7f9a8d92f54b';
```

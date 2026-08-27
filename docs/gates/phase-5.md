# Phase 5 gate — the render pass, 47/47 claimed, and the whole pipeline at 50k

**Date:** 2026-08-27
**Code:** branch `worktree-phase-5-render` at `df9622f` (the last Phase 5 code
commit), plus the commit that adds the render phase to `scripts/gate-rules.ts`,
the fixture request counters, and this file. **Every number below was measured on
exactly that tree, in the run whose output is quoted verbatim** — the gate
script's new code only starts the fixture, calls `runCrawl`, `runRenderPass` and
`runRules`, and reads a stopwatch and `/proc`. A handful of figures come instead
from SQL over the rows *that run* wrote (the HTML byte total, the suspicion-trigger
breakdown, the raw-versus-rendered agreement, the filter-link firing rate, the
two `EXPLAIN ANALYZE` plans), and two come from a separate two-line measurement
that is named where it appears. The only numbers here from another phase sit in a
comparison column with that phase named. Nothing is carried over as if it were
this run's; that is the provenance lesson Phase 3's gate doc paid for, Phase 4's
obeyed, and this one obeys.

**Verdict:** PASSED. The render pass rendered **500 of 50,000 pages — 1.0%,
against a 5% ceiling** — and the whole pipeline (crawl *and* render *and* rules,
one process, three passes) peaked at **453.7 MB** against the 512 MB contract.

**5 rules** join the 74 Phase 4 left, taking the ruleset to **79** at
`RULESET_VERSION` **0.4.0**. The coverage pin falls from **3 unclaimed to 0**:
CHECK-01, CHECK-02 and CHECK-34 are claimed, `RENDER_CHECKS` is deleted, and
**44 of the 47 crawl-derived checks have a rule behind them while the other three
are the agent's judgement**. The full suite is **985 tests across 53 files,
green**, with `tsc --noEmit` clean.

## What the gate is

The build plan's Phase 5 gate asks whether a second, budgeted pass over a
finished crawl can drive a real browser at a *selection* of its pages, diff what
the browser saw against what the tokenizer read, and answer the three checks no
crawl-only engine can answer — **without breaking the memory contract and
without becoming a second crawl**. So it has two hard numbers, and everything
else is recorded:

| | | |
|---|---|---|
| **Peak RSS of the Node process** | **≤ 512 MB** | hard — non-zero exit. Build plan rule 6, unchanged since Phase 1, now stretched over three passes in one process. **453.7 MB** |
| **Pages the render pass may render** | **≤ 5% of crawled URLs** | hard — non-zero exit. Spec §5's budget, asserted on what the selection was *allowed* to render rather than on what it managed to. **500 of 50,000 = 1.0%**, ceiling 2,500 |
| Every wall time | recorded | first measurement of the render pass at scale, and see *A note on wall times* below |
| Browser process-tree RSS | recorded | the contract binds *this* process; Chromium is a child with its own address space |

## How to reproduce

```bash
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm run db:migrate
npx playwright install chromium
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne \
  node --max-old-space-size=512 --import tsx scripts/gate-rules.ts
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm test
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npx tsc --noEmit
```

**The gate lives in `scripts/gate-rules.ts` — extended, not duplicated.** Task 7
offered a choice between extending that script and writing a `gate-render.ts`
beside it, and this is the reasoning for the choice taken: the gate's only hard
memory number is the peak RSS of a process that does *all* of it, and there is
exactly one way to measure that — do all of it in one process. A second script
would have had to crawl 50,000 pages itself to have anything to render, and
would then be this file under another name; or it would have skipped the crawl,
and measured a render pass against a peak that no longer contained the crawler.
**The consequence is stated rather than hidden: `docs/gates/phase-4.md`'s
reproduction command now runs three phases, not two.** That document is
immutable and its numbers stand as the record of the tree they were measured on;
see *Supersessions* below.

The script serves the same deterministic 50,000-URL site Phases 1 and 4 used
(`test/gate/site-server.ts`), crawls it with Phase 1's gate config —
`maxConcurrency: 16`, `perHostDelayMs: 0` (the fixture's own robots.txt says
`Crawl-delay: 0`), `probeHosts` left at its default (on), `allowPrivate: true`
for the loopback fixture, `maxPages` given 10% headroom so the *site* ends the
crawl (Phase 1 finding 3) — then renders under that same config object, then
runs the real `runRules` over the crawl it just wrote. `GATE_PAGES=<n>` runs a
smaller version for development and is labelled loudly as not the gate;
`GATE_CRAWL_ID=<id>` runs the rule pass alone over a stored crawl and is
labelled the same way, because without the crawl in the same process there is no
whole-pipeline peak to report.

**One config object drives the crawl and the render.** `RenderPassConfig` is
satisfied structurally by a `CrawlConfig`, deliberately, so the render pass
inherits the crawl's user agent and its per-host spacing and a site cannot see
two differently-behaved clients from one audit (rule 9). The three render knobs
are left **unset** on purpose: the pass resolves `RENDER_DEFAULTS` and
`crawls.config_jsonb` records a crawl that named none of them, which is the shape
a default-configured production crawl has. What that shape exposes is disclosed
under *Disclosures* rather than engineered around for the gate.

**The fixture web server now closes after the render pass, not after the crawl.**
Phase 4 closed it the instant the crawl ended so that a rule reaching for the
network (hard rule 2) got a connection refused rather than a page. The render
pass *must* fetch — that is what it is — so the fixture stays up through it and
closes immediately after. The rule pass still faces a dead socket, which is the
property that was worth having.

**The fixture counts what it serves, in three integers.** `GateSite.served()` is
new this phase, and it is the only way to know that an abort inside the renderer
reached the *wire* rather than merely a counter inside the renderer. Three
counters (`html`, `meta`, `notFound`) are O(1) for any site size, so the module
header's rule — this fixture may never hold state keyed by URL, or the gate stops
measuring the crawler and starts measuring the fixture — is obeyed rather than
excepted.

## The gate run

```
PHASE 5 GATE — crawl + render + rules over 50,000 pages, peak RSS must stay under 512MB and the render pass under 5% of them
node v22.23.2, flags --max-old-space-size=512 --import tsx
ruleset         79 rules — 26 page, 42 query, 11 metric
fixture site    50,000 URLs, crawl budget 55,000

— crawl phase —
crawl id        crawl_661a5a7a-70e3-40c3-899a-6dd6b602df6b
status          finished
pages crawled   50,000
frontier        pending 0, leased 0, done 50000, failed 0
elapsed         1150.4s
throughput      43.5 pages/sec
peak RSS        272.6 MB (at +3s)

— render phase —
budget          500 of 50,000 URLs
candidates      0 suspect + 40004 sampled = 40004 (truncated to the budget)
selected        500
rendered        500
failures        0
unrendered      0
elapsed         399.2s
per render      798ms wall/render at concurrency 4 (≈3194ms per render latency)
peak RSS        271.7 MB (at +355s)
browser RSS     816.2 MB across 10 child process(es) at its peak — NOT gated, and an upper bound (shared pages counted once per process)
fixture served  500 requests during this phase — 500 html, 0 meta, 0 404
third-party     0 request(s) aborted

fixture         closed — the rule pass has no site to fetch from
pages rows      50,000
links rows      1,149,940

— rules phase —
pages scanned   50,000
findings        5,346
metric rows     200,023
wall total      158.0s
  page rules    6.3s  (4.0%)
  derivations   9.3s  (5.9%)
  query rules   69.0s  (43.7%)
  metric rules  66.1s  (41.9%)
  unaccounted   7.2s
peak RSS        453.7 MB (at +139s)
issues rows     5,346
metrics rows    200,023

— slowest 12 rules —
27.34s          hreflang.missing-return-link (query)
26.53s          hreflang.non-indexable-target (query)
21.14s          inlinks.sources-by-type (metric)
11.05s          inlinks.distribution (metric)
9.13s           inlinks.extremes (metric)
4.16s           canonical.non-200-target (query)
3.66s           canonical.non-indexable-target (query)
2.10s           content.template-similarity (metric)
1.66s           content.metrics-by-type (metric)
1.27s           content.exact-duplicate (query)
1.12s           structure.depth-distribution (metric)
1.08s           schema.product-incomplete (query)

— the two flagged rules —
0.07s           content.near-duplicate (rank 28 of 79)
2.10s           content.template-similarity (rank 8 of 79)

— metric rows per metric rule —
40003           content.metrics-by-type
1               content.template-similarity
40003           hreflang.coverage
40003           inlinks.distribution
1               inlinks.extremes
40002           inlinks.sources-by-type
1               redirect.volume
1               render.coverage
4               sitemap.structure
40003           structure.depth-distribution
1               url.param-volumes

— the render checks on this crawl —
0               content.csr-dependent (CHECK-01) findings
0               filters.js-only (CHECK-02) findings
0               nav.js-only (CHECK-34) findings
0               redirect.js (CHECK-10) findings
render.coverage {"pagesCrawled":50000,"pagesRendered":500,"renderFailures":0,"selectionBudget":500,"selectionSampled":40004,"selectionSelected":500,"selectionSuspects":0,"selectionTruncated":true}

phase peaks     crawl 272.6 MB, render 271.7 MB (+ browser 816.2 MB, not gated), rules 453.7 MB
PEAK RSS        453.7 MB across every phase (at +1688s), contract 512 MB

GATE PASSED
```

## A note on wall times, before any of them are read

**Every wall time on this run is roughly 1.75× Phase 4's, and it is the machine,
not the code.** The evidence for that claim is that the *outputs* are identical
to the row:

| | Phase 4 (2026-08-26) | Phase 5 (this run) |
|---|---|---|
| `links` rows | 1,149,940 | **1,149,940** |
| `sum(html_bytes)` | 783,899,244 | **783,899,244** |
| `hreflang` rows | 100,000 | **100,000** |
| `count(distinct page_type)` | 40,002 | **40,002** |
| findings | 5,346 | **5,346** |
| metric rows | 200,022 | **200,023** (+1 — `render.coverage`'s site row) |

Identical corpus, identical verdicts, and *both* independent phases slower by
about the same factor (crawl ×1.73, rules ×1.80). Measured on the machine
immediately after the run: load average **4.73 / 6.12 / 6.85** on four cores,
with a `qemu-system-x86` virtual machine holding 6.5 GB and taking 21% of a CPU,
another process pegging a whole core, and several browsers resident. Phase 4's
run had that machine to itself. This is exactly why wall times here are
**recorded and not gated**, and no wall figure below should be read as a
capability claim in either direction. Two components of the rules-phase increase
*are* attributable to code and are named in that section.

## The crawl half, against Phase 4

| | Phase 4 (2026-08-26) | Phase 5 (this run) |
|---|---|---|
| Pages crawled | 50,000 of 50,000 | 50,000 of 50,000 |
| Links written | 1,149,940 | **1,149,940** — identical, to the row |
| Elapsed | 666.6s | 1150.4s |
| Throughput | 75.0 pages/sec | 43.5 pages/sec |
| Peak RSS | 184.4 MB (at +604s) | **272.6 MB (at +3s)** |

The wall figure is the machine (above). **The RSS figure is not, and it is worth
being precise about**: the peak landed at **+3 seconds**, before the crawl had
done any real work, and never rose again across the following nineteen minutes.
That is the shape of a higher *floor*, not of a crawler that grew — the process
starts heavier and the crawl's working set never reaches the new baseline.

The cause is this phase's own import graph: `scripts/gate-rules.ts` now imports
`src/crawl/render/run-render.js`, which imports Playwright's client library at
module load. Measured separately, on this tree, with two two-line scripts that
import the gate's modules with and without that one line and print
`process.memoryUsage.rss()`:

| | run 1 | run 2 |
|---|---|---|
| crawl + rules + fixture modules | 122.3 MB | 137.5 MB |
| the same, **plus** `run-render.js` | 197.2 MB | 186.2 MB |

**Roughly 55–65 MB, paid at import, before a browser exists.** RAM is still
O(concurrency): the fixture, the config and the concurrency are unchanged, and
**747.6 MB of HTML** passed through a process that peaked under 280 MB —
`sum(html_bytes) = 783,899,244` over this crawl's 50,000 `pages` rows, 15,678
bytes a page, read out of the database afterwards rather than printed by the
script.

## The render pass — the phase's new measurement

### The budget, and what it selected

`min(ceil(50,000 × 5/100), renderMaxPages 500) = min(2,500, 500) = **500**`. Past
10,000 pages the absolute cap is what binds, which is the intent stated at
`RENDER_DEFAULTS`: the browser cost is the thing being bounded, not a ratio.

| | |
|---|---|
| budget | 500 seats |
| **suspects** | **0** |
| sampled | 40,004 |
| candidates | 40,004 — **truncated**, 39,504 candidates had no seat |
| selected | 500 |
| rendered | 500 |
| failures | 0 |
| left in `render_pending` | 0 |

**Zero suspects is the recalibration datum this phase promised.** The selection's
four suspicion triggers were asked of this crawl's own columns afterwards, and
every one of them is categorically zero rather than nearly zero:

| trigger | threshold | pages on this crawl |
|---|---|---|
| a long document with almost no words | `word_count < 50 AND html_bytes > 51,200` | **0** — every fixture page is ~15 KB with ~1,600 words |
| a titleless page big enough to have one | `title IS NULL OR '' AND html_bytes > 25,600` | **0** — every page carries a `<title>`, and none reaches 25 KB |
| a client-side framework's hydration marker | `jsonb_array_length(framework_markers) > 0` | **0** — the fixture serves no framework |
| a page that links nowhere | no `links` row with this `source_page_id` | **0** — every page renders 20 internal links plus 3 nav links |

So the whole candidate set came from the per-page-type sample, and its size is
the fixture's URL scheme talking: `derivePageType` reads `/blog/17` as
`/blog/:id` but cannot read `/products/p17` the same way, so there are **40,002
page types** on this site — 40,000 product singletons, `/blog/:id`, and `/`. The
sample takes up to `renderSamplePerType` (3) of each in URL order, which is
40,000 × 1 + 3 + 1 = **40,004** exactly. The budget then cut 98.75% of them.

What actually got rendered, read off the page rows afterwards: **1 home page, 3
blog pages, 496 product pages, spanning 498 distinct page types.** That is the
selection's URL ordering applied to a site with forty thousand cohorts, and it is
worth naming as a *limitation of the sample under this pathology*: a per-type
sample is meant to spread coverage across templates, and on a site where almost
every page is its own template it degenerates into "the first 500 URLs
alphabetically". The fix is not in the render pass — it is `derivePageType`, on
the backlog below.

**The suspicion thresholds remain first-calibration values, and this run does not
calibrate them.** A synthetic SSR site trips none of the four, so it tells us
what a *healthy* corpus does (nothing) and nothing about false-positive rates on
a real one. Phase 6 should re-read this section before moving a constant.

### Wall, and what a render costs

| | |
|---|---|
| wall | **399.2s** for 500 renders |
| throughput | 798 ms of wall per render at `renderConcurrency` 4 |
| per-render latency | ≈ 3,194 ms |

The two numbers are different questions and the script now labels them as such:
four workers each spend one navigation plus the fixed 3,000 ms settle
(`RENDERER_DEFAULTS.settleMs`), so a ~3.2 s latency divided four ways is a ~0.8 s
throughput. **The settle dominates**: on a loopback fixture the navigation itself
is milliseconds, so 3,194 ms of latency is 3,000 ms of deliberate waiting plus
~194 ms of context creation, navigation, measurement and teardown. A real origin
adds its own response time on top; it does not add a second settle.

### Memory: the gated number and the one beside it

| | |
|---|---|
| Node process, render phase | **271.7 MB** (at +355s) — inside the gate, and level with the crawl phase's floor |
| Chromium process tree | **816.2 MB** across 10 processes at its peak — **recorded, not gated** |

**The 512 MB contract binds the Node process** (build plan rule 6), and
`process.memoryUsage.rss()` reports exactly that — it cannot see Chromium, which
Playwright runs as a child with its own address space and its own
renderer/GPU/zygote children under it. Reporting only the gated number would let
this document say "the render pass cost nothing" about a pass that ran the better
part of a gigabyte of browser next door, so the browser tree is measured by
walking `/proc` every two seconds and summing each descendant's RSS.

**It is an upper bound, not a total.** RSS counts every resident page a process
maps, and Chromium's processes share a great deal — the binary, the zygote's
heap, shared memory buffers — so summing their RSS counts those pages once per
process. The honest reading of 816.2 MB is "no more than this". A true figure
would need PSS (`/proc/<pid>/smaps_rollup`), which costs a kernel page walk per
process per sample and is too expensive to run beside the thing being timed.

What the number *does* establish is the operational fact a deployment needs:
**this pass wants roughly a gigabyte of headroom outside the Node heap**, at
`renderConcurrency` 4, and that requirement scales with the concurrency knob and
not with the site. The Node side, meanwhile, is flat: 271.7 MB during the render
phase against a 272.6 MB crawl floor — the render pass adds essentially nothing
to the process the contract is about, which is the memory contract applied to a
browser (counts cross the seam, never HTML).

### Politeness, measured at the wire

The renderer aborts every third-party request and every same-origin `image`,
`media` and `font` (`PAINT_ONLY_RESOURCES`) — the second half of rule 9, because
a browser is a burstier client than a fetch and the gate spaces *documents*, not
subresources. The fixture's own counters say what arrived:

```
fixture served  500 requests during this phase — 500 html, 0 meta, 0 404
third-party     0 request(s) aborted
```

**500 renders, 500 requests. One request per render, and not one more.** Every
page of this fixture carries four `<img src="/media/…">` tags, which would 404
here if they arrived — 2,000 of them across this pass. The `notFound` counter is
**0**, so the paint block did not merely increment a counter inside the renderer;
those requests never reached the socket. No favicon request either: headless
Chromium does not fetch one.

**What this run does NOT measure, stated plainly.** The residual burst the
renderer cannot mitigate is `script`, `stylesheet` and `xhr`/`fetch` — the four
resource types a client-rendered page needs to build its DOM at all, which is
precisely why they are allowed through. **This fixture references none of them**:
its only `<script>` is an inline JSON-LD block and it links no stylesheet. So the
residual burst is *structurally unexercised* here, and 1.0 requests per render is
the floor rather than a typical figure. On a real client-rendered site one render
is a document plus its bundle plus its API calls, and the exposure — a burst at a
client's own server that the host gate does not space — remains open and
unquantified. That is the yellow.com.mt shape (see `docs/talos-integration.md`),
and the honest position is that we have removed the images and not the scripts.

### The render pass's own invariant

`rendered + failures == selected`, with nothing left in `render_pending` —
500 + 0 == 500, 0 left — is asserted by the gate script rather than trusted, and
`crawls.render_pass_count` is 500, the one column the pass persists.

## The rules half, against Phase 4

**Wall time is recorded, not gated.**

| phase | Phase 4 | Phase 5 (this run) | what it covers |
|---|---|---|---|
| page rules | 3.4s | 6.3s | 26 page rules × 50,000 pages, plus the page cursor's selects and the issue flushes |
| derivations | 5.3s | 9.3s | `deriveUrlParams` + `deriveFieldPresence` — **and now the post-derivation `ANALYZE url_params, structured_data`** |
| query rules | 45.7s | 69.0s | 42 query rules (38 in Phase 4), exact |
| metric rules | 33.3s | 66.1s | 11 metric rules (10 in Phase 4), exact |
| unaccounted | 0.0s | **7.2s** | the runner's preamble — **which now issues `ANALYZE` over seven tables** |
| **total** | **87.8s** | **158.0s** | |

Two of those increases are code rather than contention, and both are this
phase's own ANALYZE fold (P5-T2, discharging Phase 4's backlog item):

- **the 7.2s residual** is `ANALYZE pages, links, sitemap_urls, url_params,
  hreflang, issues, structured_data` at the top of the run, where Phase 4's
  residual was 0.0s;
- **part of the derivations figure** is the second `ANALYZE url_params,
  structured_data` after the derivation loop, which lands inside that bucket.

Seven seconds is what it costs to stop relying on autovacuum's timing, and Phase
4's disclosure — that its planner had statistics only because autovacuum happened
to analyze `pages` mid-crawl, "and that is luck" — is what bought it.

The metric phase's 66.1s is again wider than the eleven rules' own stopwatch sum,
for Phase 4's reason: the phase wall also contains the runner's per-rule
delete-then-insert transactions for the 200,023 metric rows this pass wrote,
which happen outside each rule's `run`. The process peak (453.7 MB) sits inside
that writing, as it did in Phase 4 — **+66.3 MB over Phase 4's 387.4 MB, of which
55–65 MB is the Playwright import's floor** (measured above). The metric phase's
own appetite is therefore roughly unchanged, and the pathology behind it —
40,003-row metrics held whole before the first insert — is unchanged and still on
the backlog.

**The two flagged rules.** `content.near-duplicate` came in at **0.07s** (rank 28
of 79) against Phase 4's 0.06s — the `LIMIT 501` cap doing its job on a fixture
whose uncapped join Phase 4 measured at 481,745 pairs in 23.6s.
`content.template-similarity` came in at **2.10s** (rank 8) against Phase 4's
1.48s, and emitted **one row** again, for the same reason: 39,999 of the 40,002
cohorts hold a single page and a single page has no pair. Its
linear-in-populated-types cost remains a risk this fixture cannot provoke.

## The four render checks, answered from this crawl's stored rows

All four fired **zero** findings, and that is the correct answer rather than a
silence:

| rule | check | findings | why |
|---|---|---|---|
| `content.csr-dependent` | CHECK-01 | 0 | no page's text arrives with JavaScript |
| `filters.js-only` | CHECK-02 | 0 | no page exposes faceted links only in the DOM |
| `nav.js-only` | CHECK-34 | 0 | no page's navigation is built by script |
| `redirect.js` | CHECK-10 | 0 | no page redirected itself in the browser |

**Zero CSR pages on a synthetic SSR site.** The fixture serves complete HTML with
no client-side rendering at all, so there is nothing for any of the four to find,
and a finding would be a bug. What makes that readable rather than ambiguous is
the metric printed beside them — `render.coverage`'s site row says 500 of 50,000
pages were measured, so "no CSR problems found" is qualified by "on 1% of the
site" instead of being inferred from an empty list. **The mechanism is proven on
the fixture harness, not here**: `test/fixtures/harness.test.ts` renders seven
purpose-built `/render/*` CSR pages through a real Chromium and pins each rule to
the exact page built for it (see the harness table below). This gate proves the
rules stay *silent at scale*; the harness proves they *fire*.

The gate crawl does supply one datum the harness cannot, and it is a strong one.
Across all **500** rendered pages, the streaming tokenizer's counts and
Chromium's DOM agreed **exactly**:

| | raw (tokenizer) | rendered (Chromium) | pages where they differ |
|---|---|---|---|
| word count | 1,585 – 1,608 | 1,585 – 1,608 | **0** (max delta 0) |
| nav links | 3 | 3 | **0** |
| footer links | 0 | 0 | **0** |
| filter links | 0 | 0 | **0** |

500 pages, four counts, zero disagreements. That is the parity claim
`page-analyzer.ts` makes — a streaming tokenizer reading the same document a
browser's tree builder does — held against a real browser at scale rather than
against `cheerio` in a unit test. (The one known divergence, an `<a href>` left
unclosed across a `<nav>`/`<footer>` boundary, needs malformed markup this
fixture does not serve; it is pinned separately in
`src/crawl/parse/page-analyzer.upstream.test.ts` and is what `nav.js-only`'s
threshold carries a margin for.)

### `filters.js-only`'s firing rate on this crawl

Named because the rule's false-negative direction was flagged at P5-T5 and is
worth a number: **one external anchor carrying a UTM parameter silences the rule
for that page**, because the raw side is a categorical `NOT EXISTS` over
`links.target_url` matching `?` or `/filter|facet|sort/i`.

On this crawl, measured afterwards: of the 500 rendered pages, **0** cleared the
DOM-side floor (`rendered_filter_link_count >= 5`) and **0** carried a raw filter
link. So the rule was silent on its *first* condition, not its second — the
fixture renders no anchor with a query string or a filter-ish path on either
side. **The false-negative direction is therefore untested by this run**, and the
exposure stands as reasoned rather than measured: a site whose facets are
JavaScript-only, but which happens to link out to one `?utm_source=` URL, is a
page this rule will not report. The direction is safe (a missed finding, never a
false one) and the containment is that the rendered-side count is in the evidence
blob of every finding that *does* fire.

### `assertRenderedColumns`, and what its guard costs

Three of the four rules open with `assertRenderedColumns` — the guard that
refuses a page marked `rendered = true` with a null count column, because SQL
would otherwise drop that row from an arithmetic comparison and every reader
downstream would take it for clean. P5-T5's report called it a full scan; the
plan on this crawl says something more precise. `EXPLAIN (ANALYZE, BUFFERS)` of
the exact statement the rule issues, run over the gate crawl afterwards:

```
Limit  (cost=0.41..62.03 rows=1 width=69) (actual time=37.645..37.646 rows=0 loops=1)
  Buffers: shared hit=35214
  ->  Index Scan using pages_crawl_url on pages p  (cost=0.41..33335.71 rows=541 width=69)
        Index Cond: (crawl_id = '…')
        Filter: (rendered AND ((word_count IS NULL) OR (rendered_word_count IS NULL)))
        Rows Removed by Filter: 50000
```

**Not a sequential scan — an index scan on `pages_crawl_url` that visits every
one of the crawl's 50,000 rows through the index**, because no index covers
`rendered` or the render count columns and the `LIMIT 1` can only stop early if a
violating row exists. When none does — the healthy case, every time — it reads
all of them. Measured cost: **37.7 ms warm** (35,214 buffers, all cache hits) and
**106.4 ms cold** (5,357 blocks read from disk, 3,701 written). Three guarded
rules, so **roughly 0.11 s per rules run at 50k**, against a 158 s pass: 0.07%.

Recorded rather than optimised. A partial index on `(crawl_id) WHERE rendered AND
rendered_word_count IS NULL` would make the check O(1), and it would also be an
index whose whole purpose is to be empty. At 0.11 s it does not earn one, and the
figure is written down here so that a future crawl an order of magnitude larger
has a baseline to compare against rather than a re-argument.

## Coverage — 44 claimed, 3 agent, 0 unclaimed

| | count | ids |
|---|---|---|
| Crawl-derived universe (`CRAWL_CHECK_IDS`) | 47 | checklist Pre-Crawl + sections 1–11 |
| Claimed at the end of Phase 4 | 41 | |
| **Newly claimed this phase** | **+3** | CHECK-01 (`content.csr-dependent`), CHECK-02 (`filters.js-only`), CHECK-34 (`nav.js-only`) |
| **Claimed total** | **44** | |
| `AGENT_CHECKS` — judgement, never a rule | 3 | 38, 41, 42 |
| **Unclaimed** | **0** | — |

`44 + 3 + 0 = 47`, asserted as arithmetic in `test/rules/coverage.test.ts`.
CHECK-10 also gained a rule this phase (`redirect.js`, the JavaScript redirect)
on an id the HTTP redirect rules already claimed — a set union, which changes the
ruleset count and not the coverage arithmetic.

**`RENDER_CHECKS` is deleted, and the pin is now empty.** It was the constant
that annotated CHECK-01/02/34 as "answerable only after a browser has run the
page's JavaScript", and it goes the way `METRIC_PENDING_CHECKS` went in Phase 4:
an annotation with nothing to annotate is a reason nobody needs. An empty pin is
a **stronger** assertion than the lists that preceded it — it says every
crawl-derived check either has a rule behind it or is one of the three
`AGENT_CHECKS`, and it fails the moment a check joins the universe without a
claimant. The contract that used to be an equality between the pin and a constant
now stands as its own test (*no crawl-derived check is unclaimed and
unexplained*), which is the assertion a future phase's new check has to trip.

### The ruleset — 79 rules (`RULESET_VERSION` 0.4.0)

| kind | count | change this phase |
|---|---|---|
| `page` | 26 | unchanged |
| `query` | 42 | **+4**: `content.csr-dependent`, `nav.js-only`, `filters.js-only`, `redirect.js` |
| `metric` | 11 | **+1**: `render.coverage` |

79 = 26 + 42 + 11, pinned from the registry rather than from the plan — whose own
authoring estimate of the page/query split for the three diff rules was wrong in
*both* of its candidate forms. That is the Phase 4 miscount lesson applied a
second time and vindicated a second time.

## What the harness asserts that a gate cannot

Wall clocks and RSS say nothing about whether the render pipeline is *correct*.
That lives in `test/fixtures/harness.test.ts`, which since P5-T6 runs the real
crawl, **the real render pass against a real Chromium**, and the real rule run
over one fixture site in `beforeAll` — the first time any harness in this project
has driven a browser. Status: **all green**, inside the 985-test suite.

| assertion | status |
|---|---|
| **The render pass spent the budget the fixture's own arithmetic predicts** — `render.coverage`'s site row pinned exactly (`pagesCrawled` 79, `selectionBudget` 79, `selectionSuspects` 60, `selectionSampled` 9, `selectionSelected` 69, `selectionTruncated` false, `pagesRendered` 68, `renderFailures` 1), every figure hand-derived from the fixture collection rather than copied from the SQL, and the same numbers asserted a second time off the `RenderPassSummary` the pass returned — which is what proves `renderSelectionStats` describes the selection that *happened* rather than one it would make today | PASS |
| **Each render rule fires on exactly the fixture built for it** — the exact SET of paths per rule (`content.csr-dependent` → `/render/csr-content`; `nav.js-only` → `/render/js-nav`; `filters.js-only` → `/render/js-filters`; `redirect.js` → both `/render/js-redirect` and `/render/js-redirect-offsite`), with `/render/healthy` as a control that was rendered by the same browser in the same pass and stayed silent — checked against its page row first, because "fired nothing" proves nothing about a page nobody rendered | PASS |
| **Every finding's evidence blob pinned against the markup that produced it** — CSR's 32 raw words against 282 rendered; NAV's 0 raw against 12 nav + 4 footer; FILTERS' categorical 0 against 8 | PASS |
| **The off-site redirect is a failed render that still carries its evidence** — `rendered = false`, `render_error = 'off-site navigation: …'`, `rendered_redirect_url` set, and `redirect.js` firing on it anyway. The row shape that rule's no-`rendered`-gate exists for, proved end to end against renderer-written rows for the first time | PASS |

The gate above is what those assertions cost at scale; the harness is what says
they mean anything.

## Disclosures carried into this record

Five, each of them a decision taken during this phase with its cost written down
rather than argued away.

### 1. Hard-kill durability: closed for `pages`, open for the child tables

P5-T1 closed Phase 1's oldest defect. The loop used to mark a frontier row `done`
once `PageWriter.addPage` had merely *buffered* the page row, so a SIGKILL lost up
to `batchSize - 1` rows per table while the frontier already recorded those URLs
as finished. Now the page insert and the frontier completion share one
transaction: **a URL is `done` only if its page row has committed, and a kill
between them costs a re-fetch rather than the page.**

**The residual is named as the recorded trade-off it is**, in the same words at
`src/crawl/persist.ts`'s header and at build plan §7. `links`, `hreflang` and
`structured_data` are still written outside that transaction, so a kill between
the page commit and the child inserts loses up to one leased batch of child rows
for pages the frontier now marks `done` — and unlike the page rows those are
**unrecoverable**: the URL is finished, no resume re-fetches it, and a page with
no link rows reads exactly like a page that genuinely had none. The rules cannot
tell the two apart. The window is one leased batch rather than one full buffer,
which is a smaller hole and not a closed one. Closing it means moving the child
inserts into the same transaction and accepting that a failing `links` insert
would then destroy the page row — the audit's primary fact sacrificed to protect
a secondary one. **This gate does not exercise it**: nothing was hard-killed.

### 2. A SIGKILLed crawl is unrenderable, and there is no surface to fix it

`runRenderPass` refuses a crawl whose row still says `running`, which is exactly
right — a live worker's next lease would take rows the pass had promoted, and a
crashed crawl's frontier is mid-flight. But a crawl killed outright stays
`running` **forever**, and no API marks it failed. The remedy today is a manual
`UPDATE crawls SET status = 'failed' WHERE id = '…'`. A `markCrawlFailed` helper
is named on the backlog; the refusal itself is correct and stays.

### 3. `render.coverage` resolves absent config keys from ambient defaults

The metric reads the crawl's own `config_jsonb` rather than the ambient
`RENDER_DEFAULTS` — deliberately, so a crawl configured with a 2% budget is not
described with a 5% one. But a crawl that stored **none** of the three keys is a
crawl the pass ran on the resolved defaults, and the metric reproduces that
resolution by resolving them again *today*.

This gate crawl is exactly that shape, verified from the row it wrote:

```json
{"siteUrl": "http://127.0.0.1:45127/", "maxDepth": 10, "maxPages": 55000,
 "userAgent": "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)",
 "allowPrivate": true, "maxConcurrency": 16, "perHostDelayMs": 0}
```

No `renderBudgetPct`, no `renderMaxPages`, no `renderSamplePerType`. The
coverage row it produced is correct — `selectionBudget: 500` is what the pass
actually used, in the same process, minutes earlier. **The drift is future-tense:
the day `RENDER_DEFAULTS` changes, this crawl's coverage row will describe a
selection that never happened**, silently, because the metric recomputes rather
than reads. The structural fix is to persist the *resolved* render config on the
`crawls` row at crawl start, so an old crawl's coverage is reproducible from the
crawl and not from today's constants. Backlogged, not done here — it is a schema
change with a migration behind it, and this phase already spent its migration.

### 4. The politeness residual is unexercised, not absent

See *Politeness, measured at the wire* above. 500 requests for 500 renders is the
floor, on a fixture that references no script, no stylesheet and no XHR endpoint.
The burst those four resource types make on a real client-rendered site is
allowed through by design — a CSR page needs them to build the DOM this pass
exists to measure — and remains unquantified.

### 5. `filters.js-only`'s false-negative direction is unexercised

See that rule's section above. Zero firings on this crawl came from the *DOM*
side of the comparison, so the raw-side `NOT EXISTS` — the half that one UTM'd
external anchor can silence — was never the deciding condition here.

## Supersessions — what this phase changes about Phase 4's record

`docs/gates/phase-4.md` is immutable; it records what was true when it was
written. Three of its statements are no longer current, and **this is where that
is said — that file is not edited.**

1. **Its coverage pin is superseded.** Phase 4 recorded "41 claimed, 3 agent, 3
   render (01, 02, 34 → Phase 5)" and quoted the assertion as
   `unclaimed === RENDER_CHECKS`, with the pin "asserted against the
   `RENDER_CHECKS` **constant** rather than a re-typed literal". That constant no
   longer exists: the three checks are claimed, `RENDER_CHECKS` is deleted, and
   the assertion is now `unclaimed === []`. Phase 4's own supersession of Phase
   3's `METRIC_PENDING_CHECKS` is thereby completed — both annotations are gone,
   each deleted by the phase that discharged it.
2. **Its ANALYZE backlog item is discharged.** Phase 4 disclosed that its rule
   pass had usable planner statistics only because autovacuum happened to analyze
   `pages` mid-crawl — "that is luck, and 0.06s must not be read as evidence that
   the question is closed" — and carried *"an explicit `ANALYZE` between the crawl
   and the rule pass"* to Phase 5's backlog. P5-T2 landed it as **two** statements
   in `runRules`, both loud by construction (no catch: a failed ANALYZE aborts the
   run rather than leaving it to judge a site on whatever plan it gets):
   - `ANALYZE pages, links, sitemap_urls, url_params, hreflang, issues,
     structured_data` before any rule reads a table — every table a rule or a
     derivation reads. `metrics` is deliberately absent: no rule reads it, the
     metric phase only writes it.
   - `ANALYZE url_params, structured_data` **again** after the derivation phase,
     and that one is not belt-and-braces. On a crawl's first rules run
     `url_params` is *empty* when the first statement runs, so the planner is not
     merely uninformed about that table — it is taught that the table holds
     nothing and it believes it; then `deriveUrlParams` writes a row per parameter
     and the URL-hygiene rules join it. `structured_data`'s `field_presence_jsonb`,
     which `deriveFieldPresence` has just rewritten, has the same seam.

   The cost is measured above: **7.2 s** of previously-0.0 s residual, plus part
   of the derivations bucket.
3. **Its reproduction command now runs three phases.** `scripts/gate-rules.ts`
   gained the render pass between the crawl and the rules, and the fixture's
   close moved to the far side of it. Phase 4's recorded output is the record of
   the tree it was measured on and is not reproducible from this one — which is
   the whole reason each gate document quotes its own run verbatim.

Phase 4's carried item — **a hard kill still loses buffered rows** — is *half*
discharged and half restated; see disclosure 1 for both halves.

## Backlog carried forward

Named here so that nothing in this document reads as more closed than it is.

1. **Streaming metric rows.** A metric rule returns its whole row set to the
   runner, which validates it as a set and inserts in batches of 500 — so RAM in
   the metric phase is O(rows a metric emits), not O(batch). Four rules emit
   40,003 rows each on this fixture, and that is where the process peak sits.
   Phase 4 measured it and carried the fix; it is still carried. The fix, when a
   real site needs it, is a streaming return rather than an array.
2. **`hreflang.invalid-code` streaming.** The same unbounded return in a *query*
   rule, named separately because it is a different kind with a different
   runner path.
3. **CHECK-44's required set.** The checklist calls `description`, `sku` and
   `brand` **required** and also names `url`, which `SCHEMA_PROFILES.Product`
   does not carry at all. They remain *recommended* (and `url` absent). Moving a
   field into `required` changes which pages get a finding and at what severity —
   a client-visible verdict change, not a profile widening.
4. **`derivePageType` heuristics.** It reads `/blog/17` as `/blog/:id` but cannot
   read `/products/p17` the same way, so on this fixture every product page is
   its own cohort: 40,002 page types on a 50,000-page site. Phase 4 recorded what
   that does to metric row counts; **this phase adds what it does to the render
   sample** — a per-type sample meant to spread across templates degenerates into
   the first 500 URLs in alphabetical order. That makes this the item with two
   phases' worth of evidence behind it.
5. **A `markCrawlFailed` surface.** Disclosure 2 above.
6. **Persisting the resolved render config.** Disclosure 3 above.

## Machine

| | |
|---|---|
| CPU | Intel Core i5-6500 @ 3.20GHz, 4 cores (no SMT) |
| RAM | 32 GB |
| Kernel | Linux 6.8.0-138-generic |
| Node | v22.23.2 |
| Chromium | 151.0.7922.34 (Playwright 1.62.1) |
| Postgres | 16.15, Docker container `ariadne-pg` on port 5440 |
| Load average during the run | 4.73 / 6.12 / 6.85, read immediately after it — see *A note on wall times* |
| Suite | 985 tests, 53 files, 215.0s wall |
| `tsc --noEmit` | clean |

The crawler, the fixture web server, Chromium and Postgres shared four cores with
an unrelated virtual machine and browsers belonging to the operator. Memory is
the figure the gate is about and it is not sensitive to that; every wall figure
is, and none of them should be read as a capability claim in either direction.

## CI

`.github/workflows/ci.yml` gained one thing this phase: a cached
`npx playwright install --with-deps chromium`, keyed on the exact `playwright`
version read out of `package-lock.json` — a `^1.62.1` key would serve a stale
browser after a patch bump, since each Playwright release pins its own Chromium
build. The install runs unconditionally, cache hit or miss, because a hit
restores the browser directory but not the system libraries `--with-deps`
installs. Otherwise unchanged: `ubuntu-latest`, a health-checked `postgres:16`
service, Node 22, then `npm ci` → `npx tsc --noEmit` → `npm run db:migrate` →
`npm test`, on push to `main` and every pull request.

**First CI run on this branch: pending the pull request.**

The gate script is not part of CI and is not meant to be — this run took
twenty-eight minutes and wants a machine, not a runner.

## Leftovers

The run leaves its rows in the dev database under crawl id
`crawl_661a5a7a-70e3-40c3-899a-6dd6b602df6b`, so every figure above can be
re-queried. `delete from crawls where id = '…'` cascades.

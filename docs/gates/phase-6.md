# Phase 6 gate — a real site audited end to end through the agent surface

**Date:** 2026-08-28
**Code:** branch `worktree-phase-6-agent-surface`. The crawl ran at `2a7d2c3`;
three fixes landed *during* the gate and are part of its record — `c1633c4`
(render selection + earned spacing), `2bddce5` (issues are recomputed state) and
`0dad08f` (capped counts tell the truth) — plus the commit that carries this file
and the skill reconciliation.

**Every number below was measured on the gate run named here**, either read off
the HTTP API during the run and quoted in the two task reports
(`.superpowers/sdd/2026-08-27-phase-6-agent-surface/task-7a-report.md`,
`task-7b-report.md`), or re-queried from the crawl's own rows in the dev database
while this file was written. Where a figure changed because a fix landed
mid-gate, both values appear with the commit between them. No figure is carried
in from Phase 5 except in a comparison column with that phase named. That is the
provenance discipline Phase 3's gate doc paid for and every gate doc since has
obeyed; `docs/gates/phase-5.md` is untouched by this phase.

**Verdict: PASSED.** A fresh agent session, given only the `ariadne-*` skills and
the network surface — **no repository access, no database, no git** — walked
checklist sections 1–11 against a real 551-page e-commerce site and produced a
findings file in which **all 45 in-scope checks carry a verdict backed by quoted
engine output or a named missing tool**. The crawl was polite from first contact
to last: **zero blocked pages, zero failures, zero manual intervention**, and the
engine's own back-off found the site's rate and held it.

---

## What the gate is

The build plan's Phase 6 gate asks one question: **can an agent complete
checklist sections 1–11 against a real site using only these tools?** Not "does
the API work" — that is a test — but whether the surface, the skills and the
rules together carry an auditor through a real site's mess without the auditor
reaching for the repository.

So the gate has an honesty condition built into its mechanics, and it was
obeyed: the crawl was driven by one session (part A), and the audit was walked by
a **fresh session with no repo access** (part B) whose only inputs were
`skills/README.md`, the four `ariadne-*` skill files, the checklist, the server's
connection details and the HTTP API. Every divergence that session hit between
what a skill promised and what the surface did is recorded below, because a gate
that only records the passes is a gate that teaches nothing.

There is no hard number this phase. Phase 5's memory contract is not re-asserted
here — a 551-page crawl does not test it — and the render budget was 5% by
construction. What this phase produces instead is the project's **first
real-site evidence**, and the value of it is in what it disagreed with.

---

## The site

| | |
|---|---|
| Site | `https://lavishalice.com/` |
| Permission | owner-supplied, granted 2026-08-28. The site was named by the controller at execution, which is the permission gate the plan required. |
| Platform | Shopify behind Cloudflare — `powered-by: Shopify`, `server: cloudflare`, `cf-ray: …-LHR`, `_shopify_y` / `_shopify_s` cookies, `cdn.shopify.com` preconnect. Row 1 of the crawl skill's platform table, identified from **two manual header fetches before any crawl**, which is what that table asks for. |
| Origin | edge `LHR`, origin `gcp-europe-west1` |
| First contact | the homepage answered **200 to `AriadneBot` on the first request** — no challenge, no block |
| `crawlId` | `crawl_2af4daf1-b920-4cdf-a837-90ec05ed923f` |
| Ruleset | `0.4.0` |

A real e-commerce site, roughly 550 pages, with a sitemap that covers nearly the
whole estate and an internal link graph that does not. It turned out to be a
better gate subject than a healthy site would have been.

---

## How it was driven

The HTTP transport, over a bearer token, on `127.0.0.1:8787`, with
`ARIADNE_ALLOWED_DOMAINS='lavishalice.com,*.lavishalice.com'`. **`runCrawl` was
never called directly**: every action in this document went over the wire.

| | |
|---|---|
| Part A (crawl, render, rules) | **17 API calls** — 1 start, 10 status polls, 1 render, 1 rules, 1 metrics read, 2 issues reads, 1 unauthenticated probe |
| Part B (the audit) | **83 API calls** — 1 `crawl_list`, 1 `crawl_status`, 1 `crawl_rules`, 2 unfiltered sweeps, 45 per-check `issues_list`, 18 `issue_urls` (paginated in full), 11 `metrics_get`, 4 `pages_query` |

Surface behaviour under real use: `GET /crawls` with no token → **401**; an
unknown query parameter → **400** naming it and listing the accepted ones; every
listing answered `{items, nextCursor}` in one shape. No 500, no crash, no
restart forced by a fault. The server was restarted three times, each time
deliberately, to load a fix.

---

## The crawl

Started 2026-08-28T10:31:02.140Z with the platform table's own settings:

```json
{"siteUrl":"https://lavishalice.com/","maxPages":3000,"maxConcurrency":2,
 "perHostDelayMs":1000,"probeHosts":true}
```

Default user agent, `AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)`.

### Final numbers

| | |
|---|---|
| Wall | 10:31:02.140Z → 10:47:38.415Z = **996.3 s (16 min 36 s)** |
| Pages crawled | **551** — the whole site; the 3,000-page cap was never approached |
| Throughput | **0.553 pages/s** overall; **0.5 pages/s** once settled |
| Frontier at the end | done 551, pending 0, leased 0, failed 0 — **fully drained** |
| `blockedPages` | **0**, at every poll and at the end |
| `hostSpacingMs` | **1000 → 2000**, earned early and held |
| Links recorded | **35,145** |
| Sitemap URLs | **438** |
| Peak sampled RSS | **≈ 277 MB** (283,436 kB), flat at 271–277 MB throughout |

The frontier draining matters for the audit and not only for tidiness: a crawl
that stops at its page cap makes CHECK-32 unanswerable
(`links.orphan-skipped` fires and says why). It drained, so the orphan finding is
a fact about the site rather than about our budget.

### The poll trajectory

Ten `crawl_status` polls, 120 s apart. `rssMB` is the whole server process
(tsx + node) sampled at each poll.

| Wall (BST) | status | done | pending | leased | failed | blocked | hostSpacingMs | pagesCrawled | rssMB |
|---|---|---|---|---|---|---|---|---|---|
| 11:31:15 | running | 8 | 435 | 2 | 0 | 0 | **1000** | 0 | 271 |
| 11:31:43 | running | 34 | 409 | 2 | 0 | 0 | **1000** | 0 | 277 |
| 11:33:43 | running | 134 | 309 | 2 | 0 | 0 | **2000** | 0 | 273 |
| 11:35:43 | running | 194 | 345 | 2 | 0 | 0 | 2000 | 0 | 273 |
| 11:37:43 | running | 254 | 293 | 2 | 0 | 0 | 2000 | 0 | 277 |
| 11:39:43 | running | 314 | 234 | 2 | 0 | 0 | 2000 | 0 | 272 |
| 11:41:44 | running | 374 | 175 | 2 | 0 | 0 | 2000 | 0 | 274 |
| 11:43:44 | running | 434 | 115 | 2 | 0 | 0 | 2000 | 0 | 272 |
| 11:45:44 | running | 494 | 55 | 2 | 0 | 0 | 2000 | 0 | 273 |
| 11:47:44 | **finished** | 551 | 0 | 0 | 0 | 0 | 2000 | 551 | 273 |

Three facts fall out of it.

1. **The engine backed off once, early, and then held.** Spacing doubled between
   the 11:31:43 and 11:33:43 polls — somewhere around page 100 — and never moved
   again for the remaining 85% of the crawl.
2. **From that point the pacing is exact.** Every 120 s window moved `done` by
   precisely 60. Sixty pages in 120 seconds is one request per 2000 ms. The
   per-host gate is doing what it claims, to the page.
3. **`pagesCrawled` sat at 0 for sixteen minutes** while `frontier.done` climbed.
   That column is written by `closeCrawl`, so it is a final answer and not a
   progress counter — recorded here because an operator watching it would
   reasonably conclude the crawl had hung. The skill now says so.

`pending` rising 309 → 345 at 11:35:43 is depth-1 link discovery, not a stall.

### Fetch outcomes

| fetch_class | status | count |
|---|---|---|
| ok | 200 | 443 |
| client_error | 404 | **97** |
| redirect | 301 | 10 |
| non_html | 200 | 1 |

The 97 internal 404s are all dead `/collections/*` URLs linked from live pages.
They are audit findings, not crawler failures, and `links.broken-internal` fired
exactly 97 times — the two numbers agreeing is a small piece of evidence that the
classification and the rule are reading the same crawl.

### Response times

| n | min | p50 | p90 | p99 | max | avg | avg html bytes | max html bytes |
|---|---|---|---|---|---|---|---|---|
| 551 | 92 | **314** | 430 | 623 | 1039 | 313 | 310,529 | 488,079 |

Worth reading beside the back-off: **the origin was fast and steady the whole
time**. The spacing escalation was a discrete early pushback event, not the
engine nursing a struggling server.

---

## Robots, the sitemap, and the host probe

- **robots.txt read** — `outcome: "read"`, `truncated: false`, `note: null`.
- **No `crawl-delay` directive** (`crawlDelaySec: null`). So the 2000 ms spacing
  is *entirely* the engine's own adaptive back-off, with nothing from robots
  competing for the number. That is a clean isolation of the Task 6b mechanism on
  a real site, and it is the reason the politeness reading below is unambiguous.
- **Sitemap discovered from robots** — `sitemapSources:
  ["https://lavishalice.com/sitemap.xml"]`, **6 documents fetched**, **438 URLs**
  stored. Nothing hit a limit: `docLimited` false, `depthLimited` false,
  `entryLimited` false, `oversizedDocsSkipped` 0, `malformedEntriesSkipped` 0,
  `failures` empty.
- The file is a modern Shopify robots — an `agents.md` pointer, a UCP/MCP
  endpoint, and an explicit "checkouts are for humans" instruction. We fetched
  public HTML only and never touched cart or checkout; the disallow rules were
  honoured.

### Build-plan §7 item 4 — the real-site half: **CLOSED**

Task 1 closed the fixture half of the robots origin-variant matrix and recorded
that the real-site half was owed at this gate. It is now discharged. All four
origin variants were probed and **all four converge on `https://lavishalice.com/`**:

| start | hops | final |
|---|---|---|
| `http://lavishalice.com/` | 301 → https apex | `https://lavishalice.com/` |
| `https://lavishalice.com/` | 200 | `https://lavishalice.com/` |
| `http://www.lavishalice.com/` | 301 → https www → 301 → https apex | `https://lavishalice.com/` |
| `https://www.lavishalice.com/` | 301 → https apex | `https://lavishalice.com/` |

One canonical host, HTTPS-only, www folded to apex, no chain longer than two
hops, no loop. The shape the fixture models is the shape this site serves. The
http→https *upgrade leg* is still only exercised on the default ports, which a
test server cannot bind — that limitation stands as Task 1 wrote it.

---

## The render pass — the miss, the fix, and what it bought

This is the part of the gate that found a real defect, and it found it by being
run against a site rather than a fixture.

### What went wrong the first time

The pass rendered 28 of 551 pages (the default 5% budget, `min(ceil(5% × 551),
500)`), 0 failures, 0 unrendered, 38.8 s wall. Clean numbers — and the sample was
useless for the checks it exists to answer.

`derivePageType` produced **196 distinct page types over 551 pages**. It collapsed
the big families correctly (`/products/:slug` 211, `/collections/:slug` 115,
`/pages/:slug` 29) and then left about **170 collection URLs each as its own
singleton type**. The per-type sampler offered 176 candidates for 28 seats, and
the budget cut was `order by tier asc, url asc` — **alphabetical**, with
`suspects: 0` meaning no priority tier protected anything. So the seats went:

```
/apps/wishlist, /blogs/…, /cart, /collections/activewear, /collections/all,
/collections/aw25 … /collections/bow-dresses   ← budget exhausted here
```

| page_type | pages | rendered (before the fix) |
|---|---|---|
| `/products/:slug` | **211** | **0** |
| `/collections/:slug` | 115 | 3 |
| `/pages/:slug` | **29** | **0** |
| ~170 singleton collection types | 1 each | 22 |

`content.csr-dependent`, `nav.js-only`, `filters.js-only` and `redirect.js` all
returned zero findings — and the honest reading of that zero was **"unanswered
for the 211-page product template"**, not "products are fine". On an e-commerce
site that is the template that matters most. Phase 5's gate had already recorded
that alphabetical truncation degenerates the sample on its 50k fixture; this run
is the same defect doing visible damage to a real audit.

### The fix

`c1633c4` — *render sample seats go to the largest templates first, and the
render pass keeps earned spacing*.

- The cut is now `order by tier asc, type_size desc, url asc`, where `type_size`
  is the count of renderable pages in the candidate's own page type. The argument
  is in the docblock: **a template's size is how much of the site its render
  answers for.** Three renders of a 211-page template buy evidence about 211
  pages; three renders of a one-off collection buy evidence about one. `url asc`
  remains the final tiebreak, so the selection is exactly as deterministic as it
  was. `type_size` is computed in the CTE that `selectRenderSet` and
  `renderSelectionStats` **share**, so the coverage metric cannot drift from the
  decision it reports.
- The same commit carried a second fix, found in the same run: `runRenderPass`
  paced from `cfg.perHostDelayMs` (the crawl's *configured* 1000 ms) and
  discarded `crawls.host_spacing_ms` (the 2000 ms the crawl **earned**). It now
  paces at `max(configured, earned)`. `host_spacing_ms` is a finding, not a
  setting — it was written because the site pushed back and the engine listened —
  and a later pass over the same host has no right to forget it.

One honest deviation from the ruling, recorded and accepted: `type_size desc`
applies within **both** tiers, so two suspects of different page types now sort
by template size rather than by URL. Tier 0 still wins outright over tier 1. It
is moot on this crawl (`suspects: 0`) and every existing suspect-ordering test is
unaffected because each fixture's pages share one page type.

### The re-render, same crawl, same budget

```json
{"rendered":28,"failures":0,"unrendered":0,"elapsedMs":58404,
 "selection":{"selected":28,"budget":28,"suspects":0,"sampled":176,"truncated":true}}
```

Same predicament — 176 candidates, 28 seats — decided differently:

| page type | type_size | seats | was |
|---|---|---|---|
| `/products/:slug` | 148 | **3** | **0** |
| `/collections/:slug` | 110 | **3** | 3 |
| `/pages/:slug` | 18 | **3** | **0** |
| `/blogs/blog/:slug` | 2 | 2 | 2 |
| `/collections/sale` | 2 | 2 | 0 |
| `/pages/email-signup` | 2 | 2 | 0 |
| 13 singleton types | 1 | 1 each | 22 |

(`type_size` counts *renderable* pages, which is why `/products/:slug` reads 148
and not 211: 63 product URLs answered 404.)

**Coverage: 28 of 551 = 5.1%**, budget unchanged, all three of the site's real
templates represented. The wall went 38.8 s → **58.4 s**, which is the second fix
visible on the wire: 27 gaps × 2000 ms ≈ 54 s plus render time. The site was hit
at exactly the rate it had asked for.

**Two coverage numbers, and they are not in conflict.** `render.coverage` reports
`selectionSelected: 28` and `pagesRendered: 38`, because 18 of the first pass's 28
pages are in the new selection too and the other 10 keep their `rendered_*`
columns: `selectRenderSet` demotes a superseded page's frontier row, it does not
erase its evidence. `render-metrics.ts` names this asymmetry in its header and
deliberately does not assert it away. **`selectionSelected` (28, 5.1%) is the
sampling story**; `pagesRendered` (38, 6.9%) is "page rows carrying render
evidence from any pass", which is what the auditor quoted, correctly, when
bounding CHECK-34.

What the product template now says, measured on three product pages:

| path | word_count | rendered_wc | raw_links | rendered_links | nav | rendered nav | footer | rendered footer | rendered_redirect_url |
|---|---|---|---|---|---|---|---|---|---|
| `/products/abbie-pearl-embellished-mini-shift-dress-in-white` | 1413 | 335 | 78 | 158 | 64 | **64** | 19 | **19** | null |
| `/products/abigail-wrap-blazer-mini-dress-in-teal-blue` | 1399 | 328 | 78 | 159 | 64 | **64** | 19 | **19** | null |
| `/products/adelaide-one-shoulder-fluted-midi-hem-dress-…-in-red` | 1420 | 338 | 78 | 158 | 64 | **64** | 19 | **19** | null |

Nav and footer counts identical raw and rendered: **the navigation is
server-rendered**, and `nav.js-only`'s zero is now an answer for the product
template instead of a silence. No JS redirect. The four render rules still return
zero findings — the same zero, meaning something different.

Two readings that must not be taken from this table, both recorded so nobody
takes them later:

- **`rendered_word_count` below `word_count` is definitional, not a regression.**
  The renderer measures `body.innerText` (visible text); the streaming parser
  tokenises the whole document including the collapsed mega-menu, `<noscript>`
  and template markup.
- **`raw_links` 78 vs `rendered_links` 158 is not "the browser found 80 more
  links".** The `links` table stores one row per distinct target; the browser
  counts every `a[href]` element.

**The narrow caveat that survives the fix.** The renderer aborts every request
whose origin is not the crawl's. On this site that split was favourable — the
theme's CSS and JS are served from `lavishalice.com/cdn/shop/t/81/assets/…`, the
*same host*, so the theme rendered normally — and what was blocked was genuinely
third-party (`cdn.shopify.com/extensions/…` app-extension assets, the
`advancedcommerce.services` search app, `googleadservices.com`). So: *"this
content is server-rendered"* is a safe conclusion from this evidence; *"there is
no JS-injected content"* is not, because a Shopify **app extension** would have
been blocked.

---

## The issues-accumulation defect, and what closed it

Found by re-running the rules after the re-render, which nobody had had reason to
do before on a crawl where a cap bit.

**The symptom.** The rules pass reported 500 `content.near-duplicate` findings —
the cap — both times. The `issues` table held **751**. Every other rule matched
its reported count exactly. Total rows 1565 against a run reporting 1314.

**The cause, precisely.** Phase 4's append-only `issues` design rested on an
assumption stated in its own comment: an issue is evidence, it happened, and a
re-run adds nothing because `onConflictDoNothing` over the `issues_dedupe` index
absorbs the repeat. That holds only while **every rule is deterministic**, and one
is not. `content.near-duplicate` lists at most 500 pairs and its query
deliberately has **no `ORDER BY`** — ordering would force the whole quadratic
join the cap exists to avoid — so it reports a fixed *number* of real pairs whose
*identity* is undefined. The second run's arbitrary 500 collided with nothing and
was simply added.

**Two readers were affected, not one.** `GET /crawls/:id/issues` reads the table,
so the audit would have quoted the inflated count. And `redirect.volume` counts
`issues` rows for `redirect.chain` / `redirect.loop`, so the inflation had a path
into a **metric**. It did not bite there — both those rules order their capped
listings, and this site has zero chains and zero loops — but the seam was open.

**The fix** (`2bddce5`): one delete of this crawl's issue rows at the top of the
run, after the `ANALYZE` and before the first rule writes. **An issue is
recomputed state, exactly as a metric is**: the crawl's judgement under the
ruleset that just ran, not a log of every judgement ever passed on it. Phase-level
rather than the metric phase's per-rule transaction, for an architectural reason
rather than a preference — the findings buffer batches *across* rules, so there is
no per-rule seam to wrap a transaction around, and half a seam is worse than none.
The cost is written into the code rather than left to be discovered: a run that
dies part-way leaves a prefix of its own findings and none of the previous run's,
which is a *coherent* state, and the run threw, so nothing reports it complete.

The insert lost its `onConflictDoNothing` with it. The delete owns idempotence
now, so the only remaining way to collide is one rule emitting the same
`dedupeKey` twice in a single run — a rule defect that must surface rather than be
quietly dropped. That is also what turns **`count(issues) == summary.findings`
into an invariant a reader can check** instead of a coincidence.

**Measured on this crawl:**

| | before | after |
|---|---|---|
| Summary findings | 1314 | **1314** |
| `issues` table rows | **1565** | **1314** |
| `content.near-duplicate` rows | **751** | **500** (= the cap, = the summary) |
| Severity split | 0 / 1181 / 384 | **0 critical / 930 warning / 384 info** |
| `metrics` rows | 855 | 855 |

Run a third time to prove it is stable rather than merely reset: still 1314. The
severity split returning to the first run's numbers is the independent check that
1314 is the *right* 1314.

---

## Capped counts: the audit's largest single error, and the fix

The auditor's highest-impact divergence (D-1) was not about a rule being wrong.
It was about the surface stating a number that the skill told it to read as
something it was not.

`ariadne-audit/SKILL.md` §2.2 said: *"`count` is the total; `sampleUrls` is
five."* On this crawl that was false for two rules, and **nothing in the response
said so**:

- `links.orphan` reported `count: 200` and `issue_urls` returned exactly 200
  rows. But `inlinks.distribution` put the median indexable page at **zero**
  inbound links over 443 pages, so the auditor reconstructed a floor: *at least
  222 pages are orphaned*.
- `content.near-duplicate` reported `count: 500` and returned exactly 500 rows,
  every one at hamming ≤ 3 — the list truncated at the tightest pairs.

The facts were already on disk. A capped rule stamps its magnitude onto its last
finding's evidence (`noteTruncation` / `noteAtLeastTruncation`) in two shapes:
`total` where it counted every case, `atLeast` where counting the rest would cost
exactly what the cap exists to save. Nothing lifted that onto the wire.

`0dad08f` lifts it. `listIssues` now adds `truncated: true` plus `total` **or**
`atLeast` to a capped group, and **absence carries meaning**: no field means the
count is the whole number. The note is validated rather than cast — a shape that
matches neither contract is loud, following the precedent `bb922bd` set when
`redirect.volume` refused a truncation note it could not read — and it is read
**rule-wide** so that no filter can *hide* a cap, because silence here reads as
"count is the total". Both transports carry it; the MCP tool description now
states the semantics an agent has to apply.

**The spot-check, measured against this gate crawl after the fix** (server
restarted on `0dad08f`, `GET /crawls/:id/issues?limit=25`):

```
links.orphan            count 200   {truncated: true, total: 243}
content.near-duplicate  count 500   {truncated: true, atLeast: 501}
…the other sixteen rules carry no truncation field at all
```

And through the checklist-walk path the auditor actually used,
`?checkId=CHECK-32`:

```json
{"ruleId":"links.orphan","checkIds":["CHECK-32"],"severity":"warning",
 "category":"links","title":"Page has no internal links pointing to it",
 "count":200,"sampleUrls":[…],"truncated":true,"total":243}
```

The auditor reconstructed "at least 222" from a metric. The engine's own answer is
**243, exactly** — and the next audit gets it without doing the reconstruction.

---

## The audit — sections 1–11 by a fresh agent

**45 checks** (CHECK-03 … CHECK-46, including CHECK-33b), **83 API calls**, one
findings file at the Phase 4 interface. Every one of the 45 carries a verdict
backed by quoted engine output or a named missing tool.

| Verdict | Count |
|---|---|
| PASS | **28** |
| FAIL | **11** |
| AGENT | **3** |
| SKIP | **3** |
| **Total** | **45** |

The findings file itself carries all 82 checks, as its interface demands; the 37
out-of-scope checks are `SKIP` with notes saying they were not attempted, so the
whole-file tally reads `pass 28 / fail 11 / skip 40 / agent 3`.

The rules run behind it: `pagesScanned 551, findings 1314, metrics 855`, **18
rules fired**, 11 metric ids emitted, **0 critical**. And
`GET /crawls/:id/issues?severity=critical` correctly answered
`{"items":[],"nextCursor":null}` — the filter is right and there genuinely are
none.

| n | rule | | n | rule |
|---|---|---|---|---|
| 500 | `content.near-duplicate` (capped, ≥501 seen) | | 9 | `headings.level-skip` |
| 240 | `meta-description.too-long` | | 8 | `meta-description.too-short` |
| 200 | `links.orphan` (capped, 243 total) | | 6 | `pages.not-in-sitemap` |
| 107 | `meta-description.missing` | | 4 | `images.missing-alt` |
| 97 | `links.broken-internal` | | 3 | `content.placeholder` |
| 61 | `title.too-long` | | 2 | `canonical.points-elsewhere` |
| 42 | `title.too-short` | | 2 | `hreflang.missing-return-link` |
| 19 | `headings.h1-missing` | | 2 | `content.exact-duplicate` |
| 11 | `images.missing-dimensions` | | 1 | `headings.h1-multiple` |

### The three problems the site actually has

Recorded because the gate is about whether the surface produces an *audit*, not a
list, and this is what the fresh session came out with:

1. **Discovery rests on the sitemap.** `links.orphan` reports **243 orphaned
   pages of 443 indexable** — the auditor, without the truncation field, had to
   reconstruct "at least 222" from `inlinks.distribution`'s median of zero, and
   the engine now states the number itself. Every one of the 200 rows it listed
   was `discoveredVia: sitemap`. The product cohort is linked only from other
   products (`inlinks.sources-by-type` → `{"/products/:slug": 82}`), and no
   crawlable pagination exists anywhere (`url.param-volumes` finds no `page`
   parameter across 551 URLs). CHECK-22, 32, 33 and 33b are one finding seen four
   ways.
2. **The collection estate is the weakest template on every axis.** 92.5% of
   collection pairs are within 8 bits (`content.template-similarity`, mean hamming
   4.93), 64 collections have no meta description, 42 titles are bare marketing
   names, and 112 of the 200 listed orphans are collections.
3. **One app page is doing real damage.** `/pages/avada-sitemap` sources **90 of
   the 97** broken internal links and is itself a heading-hierarchy defect.

### What the surface got right

A gate should say so, and the auditor recorded it:

- **Every refusal message matched the skill's quoted text verbatim**, including
  which checks refuse which way — confirmed by 45 individual calls. The five
  metric-only checks (CHECK-08, 29, 33, 33b, 38) refused with a pointer to
  `/metrics`; the two checks no rule claims (CHECK-41, 42) refused saying so.
  Those are exactly the checks the skill names.
- *"An empty answer is not a clean site"* was the single most valuable
  instruction in the skill: **28 of 45 verdicts are PASSes resting on empty
  listings**, and the `crawl_rules` summary is the only thing standing under them.
- `crawl_rules`' idempotency promise held.
- `render.coverage`'s long `explanation` field pre-empted the exact mistake the
  auditor was about to make (reading `pagesRendered` as the selection size).

---

## Divergences — disposition

The gate's honesty condition. Every divergence the two sessions recorded, and
what happened to it.

| # | Divergence | Disposition |
|---|---|---|
| **D-1** | `count` is capped for two rules and the skill said it was the total | **Fixed here** — `0dad08f`, `truncated`/`total`/`atLeast` on the wire; §2.2 rewritten around it |
| **C-1** | The render sample took its seats alphabetically and covered zero product pages | **Fixed here** — `c1633c4`, `type_size desc` |
| **C-3** | The render pass discarded the spacing the crawl earned | **Fixed here** — `c1633c4`, `max(configured, earned)` |
| **N-1** | Issues accumulated across rules runs where a cap bit; `redirect.volume` was downstream of it | **Fixed here** — `2bddce5`, issues are recomputed state |
| **D-4** | `crawl_rules` returns no `elapsedMs`, plus undocumented `derived` and `metrics`; the findings interface asked for `elapsedMs` | **Skill-fixed** — real shape documented in `ariadne-crawl` Step 4; `crawl.rulesRun` in `ariadne-audit` no longer asks for a field the surface will not give |
| **D-1 (skill half)** | The audit skill told the agent to quote a capped count | **Skill-fixed** — §2.2 states the three cases and what each licenses |
| **D-2** | `pageType` is the URL path, not a template: 196 types over 551 pages, and `(untyped)` never occurs | **Skill-fixed** (discover cohort ids first; report the empty bucket as empty; group by path segment where the checklist's per-template breakdown needs it) **+ backlog** — `derivePageType` heuristics |
| **D-3 / C-4** | `depth` is discovery depth: sitemap URLs are seeds, so 437 of 443 indexable pages read as depth 0 and CHECK-31 passes literally on a site half of which has no link path | **Skill-fixed** — caveat on the checklist's CHECK-31 Engine line and in the audit skill's §2.4, with the auditor's own rebuild method (`links.orphan` + `inlinks.sources-by-type` + `inlinks.distribution`) **+ backlog** — click depth as a field of its own |
| **D-5** | `renderPassCount` is the last pass's rendered-page count, not a count of passes | **Skill-fixed** (documented as a boolean gate; real coverage from `render.coverage`) **+ backlog** — the name |
| **D-6** | No verdict routing for a hybrid `Engine + DevTools` check whose engine half passes and whose deciding half is unavailable; and §3.1 said CHECK-41/42 are `AGENT` with no no-browser branch | **Skill-fixed** — new §3.2 writes down the routing policy the auditor had to invent, and §3.1 gains the branch: with no browser, CHECK-41/42 are **SKIP**, because a bare `AGENT` with empty notes is a check nobody did |
| **D-7** | The findings interface cannot express a scoped run: 37 out-of-scope SKIPs are indistinguishable from 3 real ones in `coverage` | **Backlog** — a `scope` field, or a verdict that is not `SKIP` |
| **D-8** | CHECK-44's Record line asks for a pages-considered count no listing exposes, so "complete markup everywhere" and "no markup anywhere" are indistinguishable | **Backlog** — joins the existing CHECK-44 required-set item |
| **D-9** | Two checks depend on crawl inputs the query surface does not report back: robots' `Sitemap:` line (CHECK-03/06) and `legacyHosts` (CHECK-15) | **Backlog** — `crawl_status` should echo what the crawl was told and what it read |
| **D-10** | The "two unfiltered sweeps" arithmetic is the opposite of what the surface rewards at this metric cardinality | **Skill-fixed** — §2.1 now says index by `metricId` when the sweep runs long |
| **D-11** | `limit` exists on every listing and neither skill mentioned it | **Skill-fixed** — §2.1 documents it with the real numbers (default 50, max 200) |
| **C-2** | The back-off left no durable trace of what triggered it | **Backlog** — see politeness below |
| **C-5** | `blockedRequests` per render is diagnostic and not stored | **Backlog** |

One tool failure unrelated to the surface, recorded for whoever scripts this next:
the first `crawl_rules` call was refused by the *harness*, not the server — a
compound `curl … ; python3 -c …` line tripped the worktree-isolation guard.
Split into single commands it worked. Chain nothing inside a worktree session.

---

## Politeness

The obligation this project takes most seriously, on its first real site.

- **The WAF never blocked us.** `blockedPages` was 0 at every poll, at the end of
  the crawl, and after both render passes. The engine has no automatic abort on
  blocked pages — the escalation ladder is the operator's, in the crawl skill's
  reaction table — and **none of its rungs was reached**: nothing to react to, and
  `hostSpacingMs` settled at 2000 ms of a 30,000 ms ratchet cap.
- **The engine escalated once, on its own initiative, and held.** 1000 → 2000 ms
  around page 100, unchanged for the remaining 85%. Settings were never raised,
  the user agent was never changed, and nothing was re-crawled to go faster.
- **The quiet 2000 ms is the design working, and it is invisible in
  `blockedPages`.** A URL that is blocked but succeeds within its three retries is
  never written as a blocked row. So *the engine absorbing pushback perfectly
  reads as `blockedPages: 0`*. `hostSpacingMs` is the honest signal that a site
  pushed back; `blockedPages` is the signal that the engine could not absorb it.
  The crawl skill's reaction table had no row for this — every row was keyed on
  `blockedPages` having risen — and now it does.
- **The render pass no longer forgets.** Before `c1633c4` it would have gone back
  to 1000 ms with the answer already in the database. It now runs at the earned
  2000 ms, which is what the 58.4 s wall says.
- **C-2, unresolved: the back-off left no durable evidence of what caused it.**
  The engine doubled its spacing, which means it saw either a 429 with a
  `Retry-After` or a streak of ≥3 pushback responses across ≥2 URLs. Nothing
  records which. `blockedPages` is 0, no page row was written because the retries
  succeeded, and the server log says nothing between "crawl starting" and the end.
  `crawls.host_spacing_ms = 2000` is the only surviving trace and it cannot say
  why. **For an engine whose first duty is to explain its own behaviour to a site
  owner, "we slowed down and we cannot tell you what you sent us" is a gap.** A
  counter of escalation events with their trigger class, or one log line per
  escalation, closes it. Named in the backlog below.

---

## Backlog

### Carried forward from Phase 5, unchanged

1. **Streaming metric rows.** A metric rule returns its whole row set to the
   runner. Untouched by this phase, and untested by it: 855 metric rows is not a
   memory question.
2. **`hreflang.invalid-code` streaming** — the same unbounded return in a query
   rule, on a different runner path.
3. **CHECK-44's required set** — `description`, `sku` and `brand` are
   *recommended* in `SCHEMA_PROFILES.Product` where the checklist calls them
   required, and `url` is absent entirely. **D-8 above joins this item**: there is
   also no pages-considered count, so a silent `schema.product-incomplete` cannot
   distinguish complete markup from no markup.
4. **`derivePageType` heuristics — THIRD sighting, and the first with real-site
   evidence.** Phase 4 recorded what singleton page types do to metric row counts;
   Phase 5 recorded what they do to the render sample on a 50k fixture; **this
   phase watched them do damage to an audit of a real site**: 196 types over 551
   pages, ~170 of them singletons, half the render seats spent on pages that exist
   once, `(untyped)` never occurring at all, and the per-template breakdown
   CHECK-35/36/37 demand not producible by filtering on `pageType` unless the
   auditor already knows the four template ids. The fix is template inference —
   `/products/p17` read the way `/blog/17` already is. Three phases of evidence
   now sit behind it, and one of them is a client-visible audit defect.
5. **Persisting the resolved render config.** Phase 5's disclosure 3.
6. **The browser tree's own bound.** Phase 5 asked Phase 6 to decide whether the
   Chromium process tree gets a gated ceiling and whether build-plan rule 6's
   wording is amended for a pipeline that spawns a browser. **This phase did not
   decide it.** A 28-page render pass is not the measurement that argument needs;
   it stays open, and it stays owed to a phase that renders at scale.
7. ~~**The `renderer.test.ts` spacing warm-up flake**~~ (Task 1 concern 1) —
   **CLOSED, fixed in this phase**, and this list said otherwise until now
   ("still pre-existing and still not from any change in this phase"), which
   was true of the *cause* and wrong about the *state*. The flake was real —
   `spaces same-host navigations by the configured per-host delay` failed 3 of
   ~9 full-suite runs at 931/944/948 against a 950ms floor — and Task 1's
   controller fold repaired it in `5c6fc96` without touching the 50ms tolerance
   the Phase 5 ruling protects. The mechanism was measured, not guessed: a
   browser's first navigation pays for Chromium's renderer-process spin-up, so
   arrival[0] slipped late and the first gap came out short. A warm-up pass on a
   separate crawl was tried first and **measured as insufficient** (960/974 —
   `runRenderPass` launches its own browser, so the timed pass's first
   navigation was still that browser's first). The fix that holds is a fourth
   page **in the same pass** with `arrivals[0]` discarded: three consecutive
   full-suite runs, worst asserted gap 989ms, 39ms of headroom. Nothing is owed
   to a later phase.

### Added by this gate

8. **Click depth as a field distinct from discovery depth.** `depth` counts hops
   from a seed and every sitemap URL is a seed, so a page with no HTML link path
   is recorded at depth 0 beside the home page. CHECK-31's block-capitals
   instruction — that sitemap-only pages "MUST appear in the distribution as *No
   depth (sitemap only)*" — is **unexecutable on this engine**: the bucket is
   empty by construction, and following the instruction literally returns PASS on
   a site where more than half the estate has no link path. CHECK-33b's tier 2 is
   empty for the same reason. The skills now carry the rebuild method; the engine
   should carry the field.
9. **A politeness event log.** C-2: record what triggered each back-off
   escalation — trigger class, URL, status, `Retry-After` — so the engine can
   explain its own pacing to a site owner after the fact.
10. **Render-pass escalation and blocked-request evidence.** C-5: `blockedRequests`
    is counted per render and thrown away, so nothing can say afterwards how much
    of a page was blocked. It did not matter here; it would matter on a site where
    an app extension owns the main content.
11. **A scoped-run field in the findings interface** (D-7): 37 out-of-scope SKIPs
    are today indistinguishable from 3 caused by a missing tool.
12. **`crawl_status` should echo the crawl's own inputs and robots reads** (D-9):
    `legacyHosts` as given, and whether robots.txt declared a `Sitemap:` line.
    Two checks are uninterpretable without them by an auditor who did not start
    the crawl.
13. **`renderPassCount` is misnamed** (D-5) — it holds the last pass's rendered
    count. Rename, or split into a pass count and a rendered count.

### Ledgered from Tasks 5 and 6, restated so they do not go quiet

14. **Nothing enforces the skills against the code.** They quote rule categories,
    tool names, field names, page-size constants and evidence shapes, and a rename
    breaks them silently. This gate is the argument for the test that Task 5
    proposed and Task 6 doubled: *every backticked identifier in `skills/**`
    exists in the registry or the service.* Four of this gate's divergences
    (D-4, D-5, D-10, D-11) are exactly what that test would have caught.
15. **The action-plan skill's 20-row cap and its 80% cohort-concentration rule**
    are heuristics that no fixture and no real site has yet exercised.
16. **Nothing checks that a report's numbers match the crawl it claims.** A small
    script re-reading a finished report's quoted counts against `issues_list`
    would make it checkable.
17. **Three carried from Task 5:** the HTTP path inside an MCP refusal message;
    the `recommendation` field going beyond the brief's shape; and the absence of
    any engine-side signal that the rules have run — which is why every one of
    this audit's 28 empty-listing PASSes has to lean on a summary the agent must
    remember to keep.

---

## For the final review: three commits made under gate conditions

Flagged rather than buried. `c1633c4` and `2bddce5` were **dispatched by the
controller mid-gate**, in response to defects part A found while the gate was
running, and `0dad08f` was dispatched the same way in response to part B's
highest-impact divergence. All three are real fixes with tests and a red-green
check where the defect was reproducible — but all three were written under gate
pressure rather than through a task's normal plan-and-review cycle, and two of
them touch code paths the phase had already reviewed and signed off:

- **`c1633c4`** changes the render selection's ordering — a Phase 5 decision — and
  changes what `runRenderPass` paces from. Its deviation from the ruling
  (`type_size desc` inside the suspect tier as well as the sample tier) is
  described above and was accepted; it deserves a second reader.
- **`2bddce5`** deletes rows. It reverses a Phase 4 design decision (append-only
  issues) and removes an `onConflictDoNothing` that was there for a reason that no
  longer holds. The partial-run state it accepts is argued in the code; that
  argument is the thing to check.
- **`0dad08f`** puts a rule's evidence on the wire for the first time and makes an
  *absent* field carry meaning. The rule-wide read is deliberate and has a stated
  consequence under a `pageType` filter; that trade is the thing to check.

---

## Machine

| | |
|---|---|
| CPU | Intel Core i5-6500 @ 3.20GHz, 4 cores (no SMT) |
| RAM | 32 GB |
| Kernel | Linux 6.8.0-138-generic |
| Node | v22.23.2 |
| Chromium | 151.0.7922.34 (Playwright 1.62.1), verified launching clean before the render pass |
| Postgres | 16, Docker container `ariadne-pg` on port 5440 |
| Suite | **1186 tests, 57 files, 213.9 s wall** |
| `tsc --noEmit` | clean |

The network is the variable this time rather than the CPU: every wall figure in
the crawl section is dominated by the per-host delay, and the response-time table
is the site's, not this machine's.

## CI

Unchanged by this phase: `ubuntu-latest`, a health-checked `postgres:16` service,
Node 22, a cached `npx playwright install --with-deps chromium` keyed on the
locked Playwright version, then `npm ci` → `npx tsc --noEmit` → `npm run
db:migrate` → `npm test`, on push to `main` and every pull request.

**First CI run on this branch: _to be recorded when the PR opens._**

The gate is not part of CI and cannot be: it crawls a third party's website with
their permission.

## Leftovers

The gate crawl's rows stay in the dev database under
`crawl_2af4daf1-b920-4cdf-a837-90ec05ed923f` — 551 pages, 35,145 links, 438
sitemap URLs, 1,314 issues, 855 metrics, 38 pages carrying render evidence (28
from the current selection). Every figure above can be re-queried from them.

The API server used for the gate has been **stopped** (port 8787 free, no
`ariadne api` process). `gate-server-info.md` in the git-ignored task directory
still holds the token, the allowlist and the restart command if anything needs
re-reading.

This crawl is three orders of magnitude smaller than Phase 5's, so it does not
carry Phase 5's warning about `ANALYZE` slowing the local suite: the full suite
ran in 213.9 s with these rows resident. Deleting it cascades:

```sql
delete from crawls where id = 'crawl_2af4daf1-b920-4cdf-a837-90ec05ed923f';
```

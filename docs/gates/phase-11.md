# Phase 11 gate — the resource pass, and the politeness it did not spend

Phase 11 taught the crawler to ask about the files a page is made of. The claim
it has to answer for is not that the numbers are interesting — they are, and
§4 says so — but that **a crawler which grew a whole second fetch pass stayed as
polite as the one that did not have it.**

It did, and the measurement is unusually clean. The page half of the gate crawl
ran at **2,021 ms per page** against the Phase 8 crawl's 2,018 — **1.002× per
page**, on the same site, at the same settings, four days apart. The resource
half then ran at **2,029 ms per row asked**, on the same governor, through the
same per-host queues: **62 of its 66 one-minute buckets hold exactly 30 requests**
on the origin, and the four that do not are named in §2.2. `blockedPages` finished at 0 and `hostSpacingMs`
finished at the 2,000 it started with. Peak sampled RSS was **221.2 MB** against
Phase 8's 225.0 — the pass streams and holds no set of URLs, and the number says
so.

What did grow is the wall clock, and it grew a lot: **4.65×**, from 18.5 minutes
to 86.2 minutes of work, for the same 557-page census plus 1,997 files. §3 is
about that number, because "only the wall time grows" is a sentence an operator's
budget feels.

---

## What the gate is

Four clauses, from the plan, each answered with its measurement.

| | The plan asked | Answered |
|---|---|---|
| 1 | every T1-T3 behaviour red-first tested; the fixture serves assets including a second-host listener | §9 — T1 red by absence (19+7+5), T2 and T3 red on a missing module then 10 and 19 per-guard mutation probes, T4 red per claim, T5 red on the unrepaired document plus six mutation classes |
| 2 | **the real crawl**: zero blocks, spacing evidence per host including CDN hosts, resource census complete or loudly capped | §2 — 0 blocks, spacing 2,000 ms flat on every host that had more than one file, and a census that is COMPLETE: 1,997 seen, 1,995 answered for, 0 unasked, no cap reached |
| 3 | audit 5 delivered with the new checks answered live; CHECK-83 answered first | §6, §7 — 83 checks, CHECK-83 answered before any finding was read, CHECK-48/49/50/51 answered from measurements for the first time on this site |
| 4 | full suite green, tsc clean, migrations 0000-0013, tree clean, reference crawls untouched (the gate crawl is a NEW row) | §13 — 1,707 tests / 70 files, tsc clean, 0013 the last migration, three reference crawls re-counted identical, one new row |

A gate that only records its passes teaches nothing, so the honest residuals get
their own room: the wall-time growth (§3), the interruption that proved the
resume path by accident (§5), a metric that publishes a selection for a pass that
never ran (§6.3), and four things measured and deliberately not shipped (§10).

---

## 1. The crawl

Started 2026-09-02T01:46:06.660Z, finished 03:15:36.744Z, over HTTP on
`127.0.0.1:8788` with a fresh 47-character bearer token and
`ARIADNE_ALLOWED_DOMAINS='lavishalice.com,*.lavishalice.com'`, with
`ARIADNE_RENDER_DIR` and `ARIADNE_EXPORT_DIR` pointed at a scratch directory.
`runCrawl` was never called directly. Request body, verbatim:

```json
{"siteUrl":"https://lavishalice.com/","maxPages":3000,"maxConcurrency":2,
 "perHostDelayMs":2000,"probeHosts":true,
 "sitemapUrls":["https://lavishalice.com/sitemap.xml"],"findingCap":null,
 "fetchResources":true}
```

`crawl_f0fc5096-8ff5-406e-a9d2-98c0555ffcee`. The settings are the ones Phases 7
and 8 proved on this site; `fetchResources: true` is the phase's new field and is
also its default, so this is the shape every crawl now takes.

| | audit 3 (P8) | audit 4 (P10) | **this crawl** |
|---|---|---|---|
| `crawlId` | `crawl_02ff6f7a…` | *(the same crawl, re-judged)* | **`crawl_f0fc5096…`** |
| Date | 2026-08-29 | 2026-09-01 (re-judge) | **2026-09-02** |
| Ruleset | 0.6.0 | 0.7.0 | **0.8.0** |
| Pages crawled | 551 | 551 | **557** |
| ok / 4xx / redirect / non-HTML | 443 / 97 / 10 / 1 | same | **444 / 102 / 10 / 1** |
| Links recorded | 35,145 | 35,145 | **34,780** |
| Sitemap URLs | 438 | 438 | **444** |
| Page types | 13 | 13 | **13** |
| **`blockedPages`** | 0 | 0 | **0** |
| **`hostSpacingMs`** | 2000 → 2000 | — | **2000 → 2000** |
| **Resource files seen** | — | — | **1,997** |
| Wall | 1,111.9 s | — | **5,370.1 s** (5,173.4 s working; §3) |
| Peak sampled RSS | ≈ 225 MB | — | **221.2 MB** |
| Findings | 17,658 | 17,659 | **13,617** |
| Metric rows | 85 | 85 | **98** |
| Pages rendered | 14 (explicit) | — | **0** (a decision; §6.2) |

**The site moved and the engine did not.** Six more pages, six more sitemap
URLs, 365 fewer links: this is a live retailer whose catalogue churns, which is
why the finding counts differ from audit 4's and why §6.4 attributes each
difference to the site or to the engine explicitly rather than leaving the reader
to guess.

Origin health over this crawl's own rows: n 444, min 182 ms, **p50 309**, p90
396, p99 511, max 887, mean 318; mean HTML 371,883 bytes, max 489,309. Audit 3
measured p50 282 and mean HTML 310,522 — the origin is as fast and the documents
are 20% heavier.

**On the RSS figure, precisely:** it is the API server process, sampled every 60 s
by the poller, and it peaked at 221.2 MB at 01:52:44 — mid page crawl, with the
resource census already 1,700 rows deep. The resumed segment of the pass ran in a
separate operator process (§5) whose memory was not sampled; what the number
above covers is the whole page crawl and the first 40 minutes of the resource
pass, in one process, which is the same shape Phase 8's 225.0 MB was measured on.

---

## 2. The politeness story — the phase's actual claim

The plan's arithmetic was a prediction: *"resource HEADs interleave into the same
host queue, so wall time grows but request rate per host does not."* This is that
prediction, measured on a client's live site.

### 2.1 The page half: 30 pages per minute, nineteen minutes running

`crawl_status` was polled every 60 s for the life of the crawl. Every full window
of the page half moved `frontier.done` by **exactly 30**:

| window | done | Δ | window (s) | ms/page | blocked | spacing |
|---|---|---|---|---|---|---|
| 01:47:44 | 44 | 30 | 60.14 | 2005 | 0 | 2000 |
| 01:48:44 | 74 | 30 | 60.10 | 2003 | 0 | 2000 |
| 01:49:44 | 104 | 30 | 60.10 | 2003 | 0 | 2000 |
| … | … | 30 | ~60.1 | 2003-2006 | 0 | 2000 |
| 02:03:46 | 524 | 30 | 60.09 | 2003 | 0 | 2000 |
| 02:04:46 | 556 | 32 | 60.13 | 1879 | 0 | 2000 |

**Seventeen consecutive full windows at exactly 30**, not one exception until the
frontier ran dry. The first window is partial (the crawl started 27 s into it) and
the last reads 32 because the frontier emptied inside it with pages already in
flight.

### 2.2 The resource half: 30 requests per minute, sixty-six minutes of asking

The pass records `fetched_at` per row, so this is off the crawl's own rows rather
than off the poller. Grouping the origin's 1,931 rows into one-minute buckets:

**66 buckets, not 69, and the denominator is worth stating first:** the origin's
rows span 02:07 to 03:15, and `02:46`, `02:47` and `02:48` hold no rows at all —
they are the outage (§5), so they are absent from the grouping rather than
counted as zeroes.

**62 of the 66 buckets hold exactly 30 rows.** The four that do not are named
rather than rounded away: `02:07` (22 — the pass's first minute on this host),
`02:45` (17 — the minute the server was stopped, §5), `03:14` (22) and `03:15`
(10 — the pass's last, partial minute). The 03:14 dip is the tail of the run,
where the last four third-party hosts were being worked beside the origin and the
two workers were split across queues. Outside those four named minutes: one
request every two seconds, for an hour, without a single exception.

Per host, from the same column — the gap between one host's consecutive
completions:

| host | rows | first | last | p50 gap | p95 gap | max |
|---|---|---|---|---|---|---|
| `lavishalice.com` | 1,931 | 02:07:16 | 03:15:34 | **2,012 ms** | 2,634 ms | 6,042 ms* |
| `cdn.shopify.com` | 57 | 02:04:54 | 02:07:12 | **2,001 ms** | 6,024 ms | 6,043 ms |
| nine other hosts | 1 each | — | — | n/a | n/a | n/a |

\* excluding the outage gap, which §5 explains. **The two outage numbers in this
document are both right and measure different things:** the origin's largest
row-to-row gap is **208.5 s** (last row before the stop 02:45:32.499Z → first row
after 02:49:01.027Z), which contains §3's **196.7 s** of downtime (the crawl row
closing 02:45:32.549Z → the resume starting 02:48:49.204Z) plus the ~12 s the
resumed run spent re-reading robots.txt and six sitemap documents before it asked
about a file again.

**Read the gap distribution correctly, and this is the one number in this
document that needs a caveat.** `fetched_at` is when a row COMPLETED, not when it
was dispatched; the gate spaces dispatch. With two workers on one host, a slow
request and a fast one can complete close together — 811 of the origin's 1,930
gaps are under 1,900 ms and the shortest is 6 ms — while the RATE stays exactly
one request per 2.02 s (1,930 gaps over 3,901 s of pass time). The minute buckets
above are the honest statement of the rate; the p50 corroborates it; the minimum
gap is an artefact of measuring completions, and it is recorded here rather than
omitted because a reader who queries that column will find it.

**A second measurement caveat, found while writing this.** `resources.fetch_ms`
is measured from the top of the row's work, which is BEFORE `gate.acquire`, so it
includes the row's wait for its host's turn: p50 3,990 ms on this crawl is
queue time plus service time, not server latency. Do not quote it as a response
time. (The column carries no docblock saying so; that is a documentation gap, not
a defect, and it is listed in §14.)

### 2.3 The third-party host census, with the robots outcomes split

Eleven hosts, against a `maxResourceHosts` of 20. The split of the two
`robots_denied` rows is done **in SQL on `fetch_reason`**, which is the form a
gate document may take and a served count may not (T2's disposition: a count that
prose-matched a reason sentence would zero itself silently the day somebody
reworded the string).

| host | seen | ok | robots forbade | robots unreachable | other | unasked |
|---|---|---|---|---|---|---|
| `lavishalice.com` | 1,931 | 1,930 | **1** | 0 | 0 | 0 |
| `cdn.shopify.com` | 57 | 57 | 0 | 0 | 0 | 0 |
| `shop.app` | 1 | 0 | **1** | 0 | 0 | 0 |
| `static.klaviyo.com` | 1 | 1 | 0 | 0 | 0 | 0 |
| `cdn-static.okendo.io` | 1 | 1 | 0 | 0 | 0 | 0 |
| `api.vennapps.com` | 1 | 1 | 0 | 0 | 0 | 0 |
| `d3hw6dc1ow8pp2.cloudfront.net` | 1 | 1 | 0 | 0 | 0 | 0 |
| `foursixty.com` | 1 | 1 | 0 | 0 | 0 | 0 |
| `player.vimeo.com` | 1 | 1 | 0 | 0 | 0 | 0 |
| `www.googleadservices.com` | 1 | 1 | 0 | 0 | 0 | 0 |
| `lavishalice-1.store-uk1.advancedcommerce.services` | 1 | 1 | 0 | 0 | 0 | 0 |

The query, recorded so the split is reproducible rather than asserted:

```sql
select split_part(url,'/',3) as host,
       count(*) filter (where fetch_class = 'robots_denied'
                          and fetch_reason like '%robots.txt%disallow%') as robots_forbade,
       count(*) filter (where fetch_class = 'robots_denied'
                          and fetch_reason not like '%robots.txt%disallow%') as robots_other
  from resources where crawl_id = $1 group by 1;
```

**Both refusals are FORBADE and neither is UNREACHABLE**, which is the outcome
this census exists to distinguish. Both rows are the same file — Shopify's
`/checkouts/internal/preloads.js`, once on the site's own host and once on
`shop.app` — and each host's own robots.txt disallows `/checkouts/`. The engine
read the site's rules and did not ask. That is the whole politeness posture in one
row: a script every page references, refused because the site said so.

Nine hosts contributed one file each, and each cost exactly one robots.txt fetch
and one HEAD. The robots-per-host cost the plan worried about is 9 requests
across the whole crawl.

### 2.4 What the site got asked for, in total

**About 2,650 requests over 89 minutes.** The exactly-known parts: **557** page
fetches, **1,995** resource rows answered for, and **34** second requests where a
HEAD carried no `Content-Length` (§4) — 2,586. The rest is a small estimate and is
marked as one: the resumed pass reported **805 requests for its 784 rows**, a 2.7%
overhead which on the whole pass is about 20 more; plus 11 robots.txt fetches (one
per host), 6 sitemap documents, the host probe's four chains, and the same
robots/sitemap/probe work again when the pass resumed (§5).

Against a site whose own robots.txt sets no `Crawl-delay`, at one request per two
seconds per host, from one branded user agent. Nothing was blocked, nothing was
throttled, and the spacing ratchet never spoke. For scale: the analyzer's
2,000-reference-per-page cap was nowhere near reached either — the heaviest page
on this site references **107** files and the mean is 87.

---

## 3. Wall-time honesty

The T2 disposition asked for this number specifically, because "only the wall
time grows" is a claim an operator's budget feels.

| | seconds | note |
|---|---|---|
| Phase 8 crawl (551 pages, no resources) | **1,111.9** | 2,018 ms/page |
| This crawl's page half (557 pages) | **1,125.8** | 2,021 ms/page — **1.002× per page** |
| This crawl's resource half | **4,244.2** | of which 196.7 s was the outage (§5) |
| — the pass's working time | 4,047.5 | **2,029 ms per row asked** |
| **This crawl, total** | **5,370.1** | 89.5 minutes |
| — working time | 5,173.4 | 86.2 minutes = **4.65×** Phase 8 |

**The rate is unchanged and the clock is 4.65× longer.** Both halves of that
sentence are the same fact: a resource pass at the page crawl's own spacing is
1,997 more requests, and 1,997 requests at 2 s each is 66 minutes whatever else is
true. Nothing here is a regression against the plan's prediction — it is the
prediction, priced.

**What makes it 4.65× rather than 2× on this particular site is where the assets
live.** 1,931 of the 1,997 files are on `lavishalice.com` itself, because Shopify
serves a store's images from the store's own domain. Per-host queues run in
parallel, so a site whose images sat on a CDN would have spent much of that hour
in two queues at once; this one could not. `cdn.shopify.com`'s 57 files took 2m18s
and then the origin worked alone for an hour.

**The operator-facing consequence, stated plainly:** a 3,000-page crawl of a site
like this one is now most of a working day rather than an hour. `fetchResources:
false` (T4's off switch) is the answer when a census of the pages is all that is
wanted, and it is why that switch was owed. Four honest ways to shorten the pass
are design questions rather than tuning, and they are Phase 12's (§14).

---

## 4. The resource census, and what it found

Complete: **1,997 seen, 1,995 answered for, 2 refused by robots.txt, 0 left
unasked, `capped: false`** against budgets of 10,000 files and 20 hosts. It cost
**at least 2,029 requests** for those 1,995 rows: every row is one HEAD, and 34 of
them needed a second request because the HEAD carried no `Content-Length` (below).
Per row the total is bounded at 7 — five redirect hops, a HEAD and one GET.

| kind | files | weighed | bytes | from `Content-Length` | counted by GET |
|---|---|---|---|---|---|
| image | 1,956 | 1,956 | 398,973,100 | 1,956 | 0 |
| js | 32 | 30 | 328,779 | 5 | 25 |
| css | 9 | 9 | 39,926 | 0 | 9 |

**The HEAD-first design earned its place and its fallback earned it too.** Every
image answered a HEAD with a `Content-Length` — 1,956 files sized without a single
body — while 34 of the 41 scripts and stylesheets did not, because they are served
compressed and chunked, and each cost one counted GET whose body was discarded as
it streamed. That is the split the design predicted, in the ratio it predicted.

`page_resources` holds **38,737 edges** over 444 pages, and `page.weight` reports
`resourcesWeighed: 37,849` of those — a floor by 888, which is the two
robots-disallowed scripts referenced from every page. Both bounds are on the
metric: `atLeast: true` for the floor, and the `src`+`srcset` ceiling in the copy.

What it says about the site is audit 5's business (§6), but one number belongs
here because it is the phase's own vindication: **the median page on this site is
3.09 MB and 77% of it is images, in a catalogue where 1,920 of 1,956 files are
JPEG and 36 are PNG — no WebP, no AVIF anywhere.** Before this phase the engine
could not have said any of that. Audit 4 recorded it as NOT MEASURED.

---

## 5. The interruption, and what it accidentally proved

At 02:45:32 the session harness stopped the API server, 40 minutes into the
resource pass. The server did what its own shutdown path says it does — *"a
running crawl is cancelled, not killed"* — and the row closed **`cancelled`**
with the frontier drained (557/557) and **786 resource rows still null**.

That is the four-null-states doctrine happening for real: those 786 rows carried
a null `fetch_class` and an empty `fetch_reason`, which §5.3 of
`docs/talos-surface.md` defines as *the pass was interrupted*, distinct from the
cap, from the operator's off switch, and from a crawl that predates 0013.

**It also priced T2's abort fix, live.** The last resource row before the stop was
written at **02:45:32.499Z** and the crawl row closed `cancelled` at
**02:45:32.549Z** — the pass stopped asking servers and the crawl finished closing
itself inside **50 ms**, which is what the
per-row signal check before `gate.acquire` was added for ("a cancel must stop
asking servers within one row, not seven minutes"). Without it the pass would have
kept fetching for as long as its current batch had rows.

**`resumeCrawl` finished them**, 02:48:49 → 03:15:36, and the row closed
`finished`. No page was fetched twice — the frontier had nothing pending — and
the only extra cost to the site was the host probe and discovery running again, a
dozen gated requests. This is the resumable-by-nulls behaviour T2 built and T4's
review verified in both directions, exercised on a live site by accident rather
than by design.

**And it demonstrated the T4 disposition that looked most theoretical.** The
resumed pass's own summary reports what IT did:

```json
{"seen":1997,"fetched":784,"failed":2,"skipped":0,"hosts":5,"requests":805,
 "cappedByResources":false,"cappedByHosts":false,"aborted":false}
```

784 fetched, 5 hosts. `crawl_status`, reading the database, reports **1,995
fetched across 11 hosts**. Both are true — one describes a process, the other the
crawl — and a surface that had rendered the summary would have told an auditor
that 1,213 files were never asked about. T4's ruling ("render resources from the
DB, never from a resumed pass's summary") is the reason `crawl_status` is right,
and this crawl is the first time the two numbers actually diverged.

**One consequence for operators, and it is the honest cost of the recovery:**
`resumeCrawl` is deliberately not on the network surface, so finishing an
interrupted pass takes a script with database access. That is a real gap for a
Talos-driven deployment and it is §14's fourth pointer.

---

## 6. Audit 5

Skills-only, through the HTTP surface, into
`audits/lavishalice.com-audit5/`: `ariadne-findings.json` (83 checks) and
`lavishalice.com-audit-report.md`. The action-plan workbook is the skills' own
on-request deliverable and was not produced.

| | audit 4 | **audit 5** |
|---|---|---|
| Crawl | `crawl_02ff6f7a` (0.7.0) | **`crawl_f0fc5096` (0.8.0)** |
| Checks | 82 | **83** |
| Pass | 25 | **21** |
| Fail | 16 | **20** |
| Skip | 40 | **41** |
| Agent | 1 | **1** |

### 6.1 CHECK-83 answered first, for the first time ever

The check T4 added was answered before a single finding was read, which is what
its own preamble demands. Its five questions, on this crawl: the crawl **finished**
with a drained frontier under a numeric budget; the rules ran at
03:19:16.032Z writing 13,617 findings over 557 pages; **nothing was cut** —
`findingCap: null` and not one of the 26 fired rules carries a truncation note;
**nothing was rendered** — `renderPassCount: 0`; and the resource census is
**complete** — 1,995 of 1,997 weighed, 0 unasked, no cap.

**It failed, on one clause, and the failure is correct.** The check's Evaluate
line says WARN if `renderPassCount` is 0, so the verdict is FAIL/warning and the
notes say the render pass is the only thing missing from an otherwise complete
evidence base. A check whose first real answer had been an unqualified PASS would
have taught nobody anything; this one names the gap in the audit's own evidence,
which is exactly the job it was written for.

All six NOT MEASURED markers are silent on this crawl, and CHECK-83 records that
too — which is what licenses reading every other silence in the audit as a
measurement.

### 6.2 The render decision, recorded

**No render pass was run, deliberately.** The brief for this task set the crawl as
the phase's whole site-contact budget and left `crawl_render` to the implementer's
judgement. The judgement: a render pass is a second conversation with a client's
servers, the four checks it answers (CHECK-01, CHECK-02, CHECK-34, and CHECK-10's
JavaScript half) are not the checks this phase is about, and a gate whose headline
is politeness should not spend politeness it does not need. The cost is recorded
rather than hidden: those four checks went PASS → SKIP against audit 4, and the
audit says so in `crawl.caveats` and in each check's notes, naming audit 4's
answers as standing for the crawl they were measured on.

### 6.3 A residual the audit found in the engine

`render.coverage` on a crawl with no render pass answers `{pagesRendered: 0,
selectionMode: "auto", selectionBudget: 28, selectionSampled: 18,
selectionSelected: 18}`. The last three describe the selection a pass WOULD make:
with no explicit list stored, the rule recomputes the automatic candidates. It is
defensible — `pagesRendered: 0` is right there — but "selectionSelected: 18" reads
as a record of something that happened, and it is not. The audit records it in a
caveat and in CHECK-01's notes. It is not a defect this phase introduced and not
one it fixed; it is on the list at §14.

### 6.4 The delta, attributed

**Seven checks moved verdict or severity**; CHECK-83 is new rather than moved,
and CHECK-51 stayed SKIP with its evidence transformed. Nine rows, seven moves —
and **every one is attributable, to one of three causes.**

| check | audit 4 | audit 5 | cause |
|---|---|---|---|
| CHECK-83 | *(did not exist)* | **FAIL** warning | **the engine** — T4 added the check |
| CHECK-48 | SKIP | **FAIL** warning | **the engine** — first resource evidence: 290 KB of JS per page, floors and ceilings stated |
| CHECK-49 | FAIL info | **FAIL** warning | **the engine** — 833 oversized files and zero modern formats, where audit 4 had only markup evidence |
| CHECK-50 | SKIP | **FAIL** info | **the engine** — caching measured: 1 uncached file of 1,995 |
| CHECK-51 | SKIP | SKIP | **the engine** — verdict unchanged, evidence transformed: the network half is now measured and clean, the console half is still unmeasurable |
| CHECK-01 | PASS | **SKIP** | **this audit's decision** — no render pass |
| CHECK-02 | PASS | **SKIP** | same |
| CHECK-34 | PASS | **SKIP** | same |
| CHECK-07 | PASS | **FAIL** warning | **the site** — five sitemap URLs became 404s in four days |

Seventy-five checks are unchanged in verdict and severity, which is the control:
the same site, the same engine, two crawls four days apart, and everything that
moved has a reason.

**Two verdicts were re-derived and matched audit 4's rather than differing.**
CHECK-09 (6 URLs not in the sitemap, 1.4%, against a 5% threshold) and CHECK-17
(2 canonicalised URLs, both targets correct) came out of the first draft as
low-severity fails; both checks' own Evaluate lines make them passes, audit 4 read
them that way, and the drafts were corrected. Recorded because an unexplained
verdict flip on identical data is precisely what a second audit is for.

---

## 7. The new checks, answered live

The four checks Phase 11 exists to make answerable, on a real site:

- **CHECK-48** — `page.weight` reports a median 290,088 bytes of JavaScript and
  31,455 of CSS per page, flat across 444 pages (285,335-315,877), which is one
  theme bundle shipped site-wide. Against a median page of 3,088,864 bytes that is
  9%. **The marker check the checklist demands ran first** — `issues_list` with
  `checkId: "CHECK-48"` returns `resources.not-recorded` 0 — which is what
  separates "a light site" from "a site nobody weighed", and is the reachability
  fix T3's review forced.
- **CHECK-49** — `images.oversized` 833 files and `images.legacy-format` the same
  833, out of 1,956 images totalling 398,973,100 bytes. **1,920 JPEG, 36 PNG, no
  WebP, no AVIF.** Both rules report one finding per FILE with its referencing
  pages, so the count is a list of jobs.
- **CHECK-50** — `resources.uncached` fired **once**: one file of 1,995 came back
  with neither `Cache-Control` nor `Expires`, and it is a third-party reviews
  widget's stylesheet. A near-clean sheet that is a measurement rather than a
  silence.
- **CHECK-51** — `resources.broken` did **not** fire across 1,995 files: nothing
  the served HTML declares answered 4xx or 5xx, and nothing answered 200 with a
  bot-protection reason in place of the file. The two robots refusals are counted
  as `unknownResources`, not as broken, which is the boundary T3 argued.

The CSV `resources` view was exported and read as part of the audit; the census
tables in §2.3 and §4 are that data.

---

## 8. The citation guard, and the saga that argued for it

`docs/talos-surface.md` is the document Talos codes against, and its claim to be
trusted is one sentence under its own heading: *"Each section names the tests
that hold it."* Eighty-five `file:line` citations carry that weight, and until
this task **nothing read them**. Every commit that inserted a test above one
moved it silently, and the document went on pointing confidently at whatever now
occupied the line.

The scale of the rot was measured, not guessed. T4 found and repaired **46 stale
citations** in one pass. Then:

| pass | what it did | what survived |
|---|---|---|
| T4 implementer | repaired 46 citations by hand | 4 still wrong |
| T4 reviewer | found the 4, argued the guard must be TITLE-anchored | 1 more |
| T4 fix round | fixed the 4 | the fix landed one of them on the WRONG LINE |
| controller closure (`0514673`) | found the mislanded fix AND a third survivor beside it | 0 |

**Every one of those survivors resolved.** The file existed, the line existed,
real test code sat on it. One landed on the closing lines of an `issues_list`
cursor walk while the sentence beside it described a description pin. That is the
whole argument for what the guard checks: *existing* is the one property a wrong
line number also has, so a checker that asks "does this line exist" passes all
five.

### 8.1 What it checks instead

A citation must name a TEST, and the document must say which test in the test's
own words:

1. **Anchored** — the cited line is the line an `it()` / `describe()` opens. A
   citation is then a test's identity rather than a byte offset. The cost is real
   and is stated in the guard: a pin that meant one assertion deep inside a long
   test now names the whole test. Line-granular precision is exactly what rotted.
2. **Attested** — immediately after the citation the document carries a VERBATIM
   fragment of that test's title in quotes (`…` elides; whitespace is flattened
   because the document wraps at 80 columns). No stemming, no synonyms, no prose
   matching: the words are the test's own or the suite is red.
3. **Identifying** — the fragment matches exactly ONE title in the cited file. A
   fragment two tests answer to is a hint, not a citation.

(2) and (3) together catch the T4 failure mode. A citation moved to another real
test fails on (2), and if the fragment somehow read out of both titles it would
fail (3). It cannot be repaired without retyping the other test's words into the
sentence — which puts the wrongness where a reader sees it, instead of in a number
where nobody does.

### 8.2 Red-first, on all six failure classes

Each mutation was applied to the real document, the guard run, and the document
restored:

| mutation | test that went red | message |
|---|---|---|
| `:1491` → `:1495` (a line inside the test) | anchors every citation to a test declaration | "that line opens no it()/describe(); the declaration above it is :1491 …" |
| **`:1491` → `:1523`** (a different REAL test — the T4 mode) | attests every citation … | "…is not in \"answers the block on a crawl that holds no resource rows at all\"; it reads out of :1491" |
| fragment → `"the census"` (absent from the title) | attests every citation … | "…is not in …" |
| fragment → `"census off the"` (present, 14 chars) | attests every citation … | "quotes 14 characters, under the 16 minimum" |
| fragment → `"refuses a crawl id nothing knows"` (three tests share that title) | quotes a fragment that identifies exactly one test | "also reads out of :1049, :1384" |
| `(13 tests)` → `(14 tests)` | counts the tests it claims a file or a block holds | "claims 14 tests, holds 13" |

The second row is the acceptance test the controller carried into this task, and
it is the only one of the six that the property "the line resolves" does not
catch.

### 8.3 What it repaired, and what it still cannot do

Twenty-three citations pointed INSIDE a test rather than at one, and writing an
attestation for each forced a reading of what the surrounding sentence claimed.
Several were wrong in the way T4's four were — `mcp.test.ts:983`, cited for
`limit` being refused rather than clamped, sat inside a test about what the
`crawl_status` description says about resource numbers; the correct pin is
`:1030`, whose title is "refuses a limit outside the contract rather than clamping
it". The document now carries all 85 with the anchor and the words.

Two limits, stated rather than hidden:

- **It cannot read the sentence.** It checks that the document and the test agree
  about WHICH TEST is cited, never that the test proves the prose. A citation
  whose title is quoted correctly beside a claim that test does not support passes
  here. What it removes is the class where the document is honest and the number
  is wrong — the class that survived two fix passes.
- **Gate documents and plan documents are OUT of scope, deliberately.** A gate
  document is a historical record of the tree at one commit and is never edited
  afterwards; its citations are correct about a past tree, and renumbering them to
  today's lines would falsify the record. `talos-surface.md` is the opposite kind
  of document — a living contract, rewritten every phase.

One arithmetic claim was found stale by the guard's own count check and removed
rather than corrected: §7 said "31 tests" of a range that holds 30 today, and the
two describes it spanned have prefix-related titles (`GET /compare`,
`GET /compare/urls`) so no fragment can identify the first. The counts that ARE
checkable — `test/rules/health-metrics.test.ts` (13) and `test/api/csv.test.ts`
(25) — stayed, and are now read off the files on every run.

---

## 9. How this phase's tests were proved — the honest accounting

The watch item the controller asked for is "which tasks were red-first", and the
answer is on the record in each task's own report rather than asserted here:

| task | proof style | evidence |
|---|---|---|
| T1 (see and remember) | **red-first by absence** | 19 analyzer cases failing on `expected undefined to deeply equal []`, then 7 persistence + 5 migration cases against a schema-in-place / writer-untouched tree |
| T2 (ask politely) | **red-first, then per-behaviour mutation** | the whole file red on `Cannot find module '…/fetch-resources.js'`; then 10 guards undone one at a time, each turning exactly its own cases red |
| T3 (judge) | **red-first, then 19 mutation probes** | both files red on missing modules; 19 probes, each exact — and two of them found REAL gaps before the shipped code was right |
| T4 (show) | **red-first per claim**, with one honest exception | the off switch, the CSV view and the CHECK-32→83 re-file were each written first and quoted red; the marker-boundary case **passed immediately** and the report says so rather than dressing it up — it pins a boundary that already held |
| T5 (prove) | **red-first** | the guard was written and run against the unrepaired document, and six mutation classes were demonstrated (§8.2) |

**The thing to watch, stated because the phase leaned on it:** a mutation probe
proves a test BINDS a guard; it does not prove the test was written first. T2 and
T3 both used it for their per-behaviour evidence, on top of a genuine
red-by-absence for the file as a whole. That is a good pattern and it is not the
same claim as TDD, so the distinction is recorded here rather than blurred into
"everything was red-first".

---

## 10. Stated limits, and what is ledgered rather than shipped

Four things this phase measured, decided against shipping, and wrote down. Each
one is a NOT MEASURED sentence somewhere a reader will meet it, not a silence.

### 10.1 The cap-exceeded counter — measured, and not landed (migration 0014)

The analyzer records at most **2,000 resource references per page** and drops the
rest. T1 handed the visibility question forward, T4 measured it, and the answer
was no:

- Deriving "how many pages hit the cap" costs a scan of every reference the crawl
  holds — **73 ms and 67 ms over a 500,000-edge synthetic crawl**, against a
  polling endpoint whose other reads are **≤ 3 ms**. That is a 20× cost on
  `crawl_status`, which a dashboard hits on every paint.
- Two cheaper forms were shown not to rescue it, and one is worth the record
  because it looks obvious: comparing `pages.images_total` against a page's
  counted image edges needs no scan at all, and **does not work** —
  `images_total` counts `<img>` ELEMENTS while the extraction emits a
  DISTINCT-URL set, so any page that reuses one image has more elements than
  edges with nothing truncated. It would fire on ordinary pages and stay silent on
  a truncated page whose references happen to be distinct. T1's handoff is
  answered in the negative rather than left open (`docs/talos-surface.md` §13).
- **A counter would need a column**, and Phase 11's one schema event was migration
  0013. **Ledgered as migration 0014: a cap-exceeded counter on `crawls`, written
  at close.**

Until then the limit is stated where it is read: `talos-surface.md` §13 and
CHECK-83's own "Also NOT MEASURED" bullet both say the analyzer drops references
past 2,000 silently and that `resources.seen` is a floor on such a page. **This
crawl did not approach it** — the heaviest page references 107 files, the mean 87,
so nothing on this site was truncated and the counter would have counted zero.

### 10.2 `robots_unreachable` — the split the census had to do in SQL (0015-adjacent)

An unreachable `robots.txt` is a complete disallow (RFC 9309 §2.3.1.4), so a CDN
that was down while the pass ran lands in exactly the same `robots_denied`
`fetch_class` as a CDN that forbids us. T4 refused to tell them apart by
prose-matching the reason sentence — a reworded error string would zero the count
silently — so the discrimination stays per-row in `fetch_reason`, and §2.3 does
the split in SQL as a recorded query, which is the honest form for a gate document
and not a form a served count may take.

The review found the option that removes the problem: `RobotsInfo.outcome` is a
CLOSED VOCABULARY already in hand at the deny site, so the class or the reason
could be derived from it rather than written as a sentence. **Ledgered,
0015-adjacent: a `robots_unreachable` class (or a constant-derived reason) plus a
`robotsUnreachable` count on `crawl_status`.**

### 10.3 The sibling marker — a 0.9.0 item, and why it is not a widening

`resources.not-recorded` fires when a crawl holds **no resource rows at all**. It
deliberately does not fire when the rows exist and are merely unasked — an
operator's `fetchResources: false` — because in that case the crawl DID record
what it saw, and `crawl_status` says so four ways.

The review's ruling stands and is restated because the version argument matters:
making the existing marker fire on the operator-off case would be a VERDICT
CHANGE and would need a ruleset bump. Adding a SIBLING —
`resources.not-fetched`, on the `host.probe-skipped` model — is additive, needs no
bump, and is the house's own precedent for reporting a crawl OPTION rather than
missing data. **Ledgered for 0.9.0 as a sibling marker, never as a widened
condition.** The boundary is pinned by a test meanwhile, so widening it later has
to be deliberate.

### 10.4 The small ones

- **`resources.bytes` is an integer** — a file over ~2.1 GB would overflow it.
  The `pages.html_bytes` precedent is the same, and the counted-GET ceiling
  (16 MiB) means nothing this pass measures approaches it. The largest file on the
  gate crawl is 2.71 MB. Noted, not fixed.
- **The marker guard hand-enumerates, and so does CHECK-83.** A seventh NOT
  MEASURED marker is three edits — the registry, the guard's `MARKERS` list, and
  CHECK-83's own family list — and nothing derives any of them from a query. The
  guard now says so in a comment beside the list (P11-T4's M-6, closed here).
- **`resources.fetch_ms` includes the host-queue wait** (§2.2). The column carries
  no comment saying so and it should; a reader who quotes its p50 as a server
  response time is 2 s wrong per row.

---

## 11. Watch items for CI

Two flakes are on the record from this phase, neither reproduced, neither treated
as fixed. Both belong in the first CI runs of PR #10.

1. **One unattributed full-suite failure (T3).** The run immediately after T3's
   mutation probes reported `1 failed` and the name was lost. It did not reproduce
   in **six** subsequent full runs (four by the implementer, two by the reviewer),
   and it has not reproduced in the **three** full runs this task made either — so
   0 of 9. The plausible cause is the probing method itself: in-place source
   mutation under live vitest workers, where a worker can read a file mid-edit.
   That is a property of the probe harness rather than of the shipped code — but
   nothing proves it, so it stays a watch item.
2. **`test/crawl/run.test.ts` timing (T2).** The resource pass lengthened that
   file's harness; it retries 4×. It has not flaked in any of this task's three
   full runs, and CI is where a slower machine would say otherwise.

---

## 12. Carried minors, restated

Nothing here blocks integration; all of it would otherwise be lost.

| id | what | where it stands |
|---|---|---|
| T1 M-4 | `resources.bytes` integer, ~2.1 GB ceiling | noted (§10.4) |
| T1 I-2 | `src` + `srcset` both emitted → `page.weight` is a CEILING | discharged in copy: the metric states both bounds, and `page_resources`' docblock binds it |
| T1 I-1 | the render pass's `resourceRefs` are deliberately ignored | discharged: the schema docblock and the renderer comment both say a JS-injected file is not in the census |
| T2 M-3 | robots keyed by host, not origin | comment states it |
| T3 minor | the marker guard's list is hand-written | comment added this task (§10.4) |
| T4 M-6 | a seventh marker is not forced into CHECK-83 | same comment |
| P10 | the docs citation guard | **closed** (§8) |

---

## 13. Verification

Run in this worktree, on the tree at the gate commit:

| | |
|---|---|
| Suite | **1,707 tests / 70 files, all passing** (~104-108 s), three full runs this task |
| Typecheck | `npx tsc --noEmit` clean |
| Migrations | 0000-0013; **0013 is the last**, and no DDL changed after T1 |
| Ruleset | 0.8.0, **92 rules** (86 at Phase 10) |
| Checklist | 83 checks; the coverage query green |
| Tree | clean at each commit; no crawl data committed — the database holds it |

**The reference crawls are untouched**, re-counted independently after the gate
crawl finished:

| crawl | ruleset | pages | links | sitemap URLs | issues | metrics | resources |
|---|---|---|---|---|---|---|---|
| `crawl_2af4daf1…` | 0.4.0 | 551 | 35,145 | 438 | 1,314 | 855 | 0 |
| `crawl_3f3ab847…` | 0.5.0 | 551 | 35,145 | 438 | 1,326 | 1,023 | 0 |
| `crawl_02ff6f7a…` | 0.6.0 | 551 | 35,145 | 438 | 17,659 | 85 | 0 |
| **`crawl_f0fc5096…`** | **0.8.0** | **557** | **34,780** | **444** | **13,617** | **98** | **1,997** |

Every figure in the first three rows matches what the Phase 8 and Phase 10 gate
documents recorded. The gate crawl is a fourth row and it stays in the dev
database. Four `lavishalice.com` crawls in a table that ended this phase holding
**1,585** rows, up from 139 at its start — the rest are fixtures the suite leaves
behind, **31 per full run** (measured twice by this task's reviewer, and the same
rate divides across targeted single-file runs). A fact about the suite, not about
any operator (`talos-surface.md` §13).

Commits, in order:

| commit | what |
|---|---|
| `92384ea` | the plan |
| `38fc317` → `baa7a30` | T1 — analyzer refs, migration 0013, persistence |
| `975ea76` → `44a0aaf` | T2 — the resource fetch pass |
| `cf292f9` → `863860e` | T3 — the rules, `page.weight`, the checklist |
| `83a99a7` → `0514673` | T4 — the surfaces, the off switch, CHECK-83 |
| `523af48` | T5 — the citation guard |
| `f295460` | T5 — three false claims the gate work found |
| *(this commit)* | T5 — this document |

---

## 14. Integration, and what Phase 12 inherits

**CI: _(PR #10, run link to be added when the branch is pushed on the owner's
word)_** — the phase-8/9/10 pattern: this line carries the green run's link.

Phase 12 pointers, in the order they will be met:

1. **Migration 0014** — the cap-exceeded counter (§10.1). The one measured,
   argued, ready-to-write schema change this phase left on the table.
2. **`robots_unreachable`** (§10.2) — a class or a constant-derived reason, plus
   the count on `crawl_status`, so the forbade/unreachable split stops being a SQL
   query somebody has to write.
3. **The 0.9.0 sibling marker** (§10.3) — `resources.not-fetched`, additive.
4. **A way to resume a crawl over the wire** (§5). The recovery path exists and
   works; it is reachable only from a script with database access. A Talos-driven
   deployment whose worker dies has no way to finish the pass, and the alternative
   — re-crawling — is the expensive, impolite one.
5. **The wall-time question** (§3). Resource fetching is politeness-bound, not
   bandwidth-bound, and on a site whose assets sit on its own origin the pass is a
   serial queue at the crawl delay. Nothing there is wrong; it is a number an
   operator must be told before they agree to it, and the honest ways to shorten
   it (a separate floor for HEAD-only asset requests, or asking only about the
   files some rule would judge) are design questions rather than tuning.
6. **Two small honesty fixes**: a comment on `resources.fetch_ms` saying it
   includes the queue wait (§10.4), and `render.coverage`'s selection fields on a
   crawl that rendered nothing (§6.3).
7. **Tenancy on `crawl_list`** — unchanged since Phase 9, still the pre-tenancy
   posture, still stated in `talos-surface.md` §9.3.

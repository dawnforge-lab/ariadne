---
name: ariadne-audit
description: >
  Run a full SEO & GEO audit against an Ariadne crawl: analytics context from GSC,
  GA4 and Ahrefs, then the 82-check checklist, with every crawl-derived check answered
  by quoting the engine and every judgement check answered by the agent. Produces a
  findings file the report and action-plan skills consume. Use this skill when the
  user says: "run the audit", "audit this site", "audit the crawl", "run the
  checklist", "what did the crawl find", "what are the issues", "evaluate the crawl",
  "SEO audit", "GEO audit", "work through the checks", "produce the audit findings".
  It needs a finished, judged Ariadne crawl — if there is none, it calls the
  ariadne-crawl skill first.
---

# Ariadne — the audit orchestrator

This skill walks `checklist.md` (same directory) end to end and writes a findings
file. The checklist is the authority on WHAT each check asks and how to judge it;
this file is the authority on the ORDER of the work and the shape of the output.

## The division of labour, which is the whole design

**The engine produces facts. You produce judgement.**

The crawl, the render pass and the rule run have already looked at every page of the
site. A rule states what it found — 128 sitemap URLs that are not indexable, 4,000
products with no HTML link path, a nav that only exists after JavaScript — and never
states what it means. Severity in this site's context, priority against this client's
commercial position, and the narrative that ties twelve findings into three problems:
those are yours, and nothing in the engine will produce them for you.

**The skill-side hard rule: never re-judge a claimed check by eyeball.** If the
checklist's **Engine** line names a rule or metric, the answer is the engine's output,
quoted. Do not open one page in a browser and grade the check on what that page
showed. One page is not a site, and a hand check that contradicts the engine is a bug
report about the rule — raise it as one — not a finding about the client.

**And the mirror of it: an empty answer is not a clean site.** `issues_list` and
`metrics_get` answer `{"items": []}` for a rule that found nothing AND for a crawl
nobody judged. **`crawl_status` settles which**: `rulesRunAt` is the timestamp of the
last COMPLETED rules pass — null means no complete pass is on record — and
`findingsCount` is how many findings that crawl holds. Read them as a pair, never
apart: a timestamp with `findingsCount: 0` is "looked, found nothing", a null with
any count at all is a pass that died part-way, and null with zero is "nobody has
looked". One `crawl_status` poll is the whole check, and it is on the crawl rather
than in your notes — the `crawl_rules` summary is still worth keeping for its
per-rule breakdown, and it is no longer the only evidence a pass happened.

## Prerequisites

- A running Ariadne server, MCP preferred (`npm run mcp:serve`), HTTP as the fallback
  (`npm run api:serve` with `ARIADNE_API_TOKEN`). See the `ariadne-crawl` skill.
- A crawl of the site that is `finished`, rendered if the site needs it, and JUDGED.
- GSC and GA4 MCP servers for Phase 0. Ahrefs MCP if the client has it.
- A browser MCP server for Phase 3.
- A working directory for this audit's output.

Missing pieces are named, not worked around: an audit that quietly skipped Phase 0
because GA4 was not connected is an audit that mis-prioritised everything downstream.

## The phases

```
Phase 0  Analytics context      GSC + GA4 + Ahrefs        CHECK-71 … CHECK-81
Phase 1  The crawl              ariadne-crawl             (no checks)
Phase 2  Engine-answered checks issues_list / metrics_get CHECK-01 … CHECK-46
Phase 3  Agent checks           browser + judgement       CHECK-38/41/42, 47 … 70
Phase 4  Findings assembly      the findings file         all of them
```

Phase 0 runs FIRST and Phase 1 can run beside it — the analytics work needs no crawl,
and a site losing 40% of its organic traffic has different priorities from one growing
steadily. That context is what turns a list of faults into an audit.

---

## Phase 0 — analytics context

Establish where the site stands before deciding what its technical faults cost. The
checklist's section 0 and section 15 carry the check definitions; this is the order
and the disposition.

1. **Identify the properties.** GSC `list_properties` and GA4
   `get_account_summaries`, matched to the domain. Record the property ids — every
   later query needs them, and picking the wrong property is a whole audit written
   about someone else's site.
2. **Run the section 0 checks** in order: CHECK-71 (organic traffic, segmented and
   trended), CHECK-72 (brand vs non-brand), CHECK-73 (top pages), CHECK-74 (query
   landscape and striking distance), CHECK-75 (conversions), CHECK-76 (AI referral
   traffic), CHECK-77 (indexation coverage — this one crosses GSC against the crawl,
   so it needs Phase 1), CHECK-78 (cannibalisation).
3. **Run the section 15 checks if Ahrefs is connected**: CHECK-79 (backlink profile
   and DR), CHECK-80 (AI citations and share of voice), CHECK-81 (unlinked mentions).

**Ahrefs is optional, and "optional" means SKIP, not silence.** If the Ahrefs MCP
server is not connected, record CHECK-79, CHECK-80 and CHECK-81 as `verdict: "SKIP"`
with `notes` naming the missing server. Brand Radar is a separate subscription tier:
if Site Explorer answers and Brand Radar does not, CHECK-79 is real and CHECK-80 and
CHECK-81 are SKIP. Never infer authority data from anything else.

Carry three things out of this phase into every later verdict: the traffic direction,
which page types earn the money, and which pages are already winning. A critical
finding on a page type with no traffic and no revenue is not the top of the plan.

---

## Phase 1 — the crawl

Use the **`ariadne-crawl`** skill. Either it starts a crawl, or you locate an existing
one with `crawl_list` and confirm it is fit to audit.

A crawl is fit to audit when:

- `status` is `finished` (`cancelled` and `failed` crawls can still be audited, but
  every count becomes a floor and the findings file must say so in `crawl.caveats`);
- the frontier drained — `pending` and `leased` at 0. A crawl that stopped at its page
  cap makes CHECK-32 unanswerable (`links.orphan-skipped` fires and says why);
- `renderPassCount` ≥ 1 if the site needs rendering. Without it, CHECK-01, CHECK-02,
  CHECK-34 and CHECK-10's JS-redirect half are SKIP, not PASS;
- **the rules have run — `crawl_status`'s `rulesRunAt` carries a timestamp.** That is
  the crawl's own record of a completed pass, so a crawl somebody else judged is as
  auditable as one you judged yourself. Null means no complete pass: run `crawl_rules`
  now. Running it again on a judged crawl is idempotent and re-judges with the current
  ruleset, which is what you do after upgrading the engine rather than re-crawling —
  and its summary, kept beside the marker, is the per-rule breakdown of what that pass
  wrote.

Record the crawl's shape before reading a single finding. It bounds every claim the
audit makes.

### Rendering key templates

If the crawl still needs its render pass, this is where the audit decides which pages
get a browser — and on a site you have just crawled, **you decide, the engine does
not**. Rendering everything is a waste of somebody's server and of the audit's time;
rendering whatever tripped a heuristic answers about the wrong pages. The method is in
the `ariadne-crawl` skill under the same heading; the short form:

1. `metrics_get` `content.metrics-by-type` — the cohort sizes. The big cohorts are the
   site's real templates, and a render of one of them answers for all of them.
2. `pages_query` — the URL patterns beside those sizes, so a cohort that is really one
   page with its own path is not mistaken for a template.
3. `crawl_render` with `urls`: the home page, 2-3 representatives of each real
   template, plus any one-off that looks like a shell (a large document with almost no
   words, no title, no outgoing links). **A four-template site is 10-15 renders**, not
   551.
4. `crawl_rules` — the diff rules only ever speak about pages the render pass covered,
   so this order is not negotiable.

`auto` — no `urls` — remains right for first contact with a site, or where the types
give you no clear templates at all.

**Then read what came back, and read the mode first.** `render.coverage`'s
`selectionMode` says which decision chose the pages. On an `explicit` pass
`selectionBudget`, `selectionSuspects`, `selectionSampled` and `selectionTruncated`
are **null**, not zero: no automatic decision was taken, so quoting them as "no
suspects found" would be a claim about the site's HTML that nobody made.
`selectionSelected` is then the length of your own list, and what it covers is a
question about that list — say which templates it stood for when you write the
coverage note.

Then read the four render rules, and read them against the columns they compare:
`pages_query` publishes `renderableWordCount` and `renderedRenderableWordCount`, the
two sides CHECK-01 measures, both produced by the same analyzer over the same page.
That is the comparability check §2.4 asks for, and on an explicit pass it is cheap —
you named the pages, so you know exactly which rows to read.

---

## Phase 2 — the engine-answered checks

The checklist's crawl-derived range is CHECK-01 to CHECK-46 (47 checks, counting
CHECK-33b). **45 of them have a rule behind them** — 44 with finding rules, plus
CHECK-38, whose two metric rules supply evidence and pass no verdict. Only CHECK-41
and CHECK-42 have no rule of any kind. Three of the 47 are judgement — CHECK-38,
CHECK-41 and CHECK-42 — and belong to Phase 3 whatever evidence exists for them.

### 2.1 Sweep first, then walk

Two unfiltered, paginated sweeps give you the whole picture before you commit to a
check, and the issues sweep is usually one call:

1. `issues_list` with no filter but `crawlId` — every rule that found something, with
   its `checkIds`, `severity`, `count` and five `sampleUrls`. Follow `nextCursor` to
   the end. Index the rows by check id.
2. `metrics_get` with no filter — every measured number, each with its own
   `checkIds`, `title` and `explanation`. Follow the cursors. Index by check id too.

**Every listing takes `limit`** — 50 by default, 200 maximum — and using it is the
difference between 3 calls and 12 on a 551-page census. Take the maximum on any sweep
you intend to read in full.

The metrics sweep is the one that does not stay cheap: metric rows are per page type,
and page types are per URL path (see §2.2), so a mid-sized site can produce hundreds
of rows. When the unfiltered sweep runs past two or three pages, index by
`metricId` instead — one call per metric id, plus `scope: "site"` for the site-wide
rows — which is both fewer calls and easier to quote. `metrics_get` has no `checkId`
filter, by design: a metric answers whatever checks name it, and it is the rows'
`checkIds` you index on.

Now walk the checklist in order. For each check, the sweep has already answered one
of three ways:

- **Rows for this check id** → read them, and pull the URL list with `issue_urls`
  where the check's Record line asks for one.
- **No rows, and the check is claimed by a finding rule** → candidate PASS. It is a
  PASS only because the crawl was judged; cite `crawl_status`'s `rulesRunAt` (and the
  `crawl_rules` summary, if you ran it) in the evidence.
- **No rows because the check is measured, not found** → the metrics sweep has it.
  Five checks are metric-only — CHECK-08, CHECK-29, CHECK-33, CHECK-33b and CHECK-38
  — and `issues_list` with their `checkId` is refused with a pointer to `metrics_get`
  rather than answered empty. That refusal is a useful thing to see once; it is not an
  error to work around. (CHECK-38's metrics are evidence for a judgement you still
  make yourself — see Phase 3.)

### 2.2 Reading the answers

- **Quote, don't paraphrase.** The `count`, the `sampleUrls`, the metric's `value` —
  these go into the findings file as they came back. A number you retyped is a number
  nobody can trace.
- **`count` is the rows the rule listed; `sampleUrls` is five of them.** Never report
  the sample as the extent of a problem — and do not assume the count is the extent
  either. Some rules stop listing at a cap, and a capped group says so:
  - `truncated: true` with **`total`** — the rule counted every case and listed some.
    `total` is the magnitude. Quote it: "243 orphaned pages, 200 listed".
  - `truncated: true` with **`atLeast`** — the rule stopped *looking*, so the number
    is what it SAW and the real one is unknown. Say "at least 501"; never round it
    into a total, and never quote it as one.
  - **no `truncated` field** — `count` is the whole number, and that absence is the
    only thing that licenses reporting it as one.

  On the Phase 6 gate site `links.orphan` answered `{count: 200, truncated: true,
  total: 243}` and `content.near-duplicate` `{count: 500, truncated: true, atLeast:
  501}`. Quoting the counts would have understated the first by 43 pages and stated
  the second as a fact nothing had counted. (Where a `pageType` filter is on, `count`
  is that cohort's rows while `total`/`atLeast` stay the whole rule's magnitude — the
  two are not two ends of one fraction.)

- **A BILLED AUDIT ASKS FOR THE WHOLE PICTURE, NOT A SNAPSHOT: pass
  `findingCap: null` to `crawl_start`.** The caps above are the default — 200
  findings per listing rule, 500 near-duplicate pairs — and they exist for a first
  look at an unknown site, where a bounded answer is the point. They are the wrong
  setting for work a client is paying for: "243 orphans, here are 200" is a list the
  client cannot work through to the end, and `atLeast: 501` cannot tell them whether
  the real number is 502 or 40,000.

  `findingCap: null` uncaps every listing rule and the pair reporting cap together.
  `findingCap: <n>` sets a number instead — and note that a stated number binds the
  pairs too, so `findingCap: 200` is not the same as omitting the field (which
  leaves pairs at 500).

  **Keep reading the `truncated` note, not the setting.** The rule above does not
  change: a note means the list is incomplete, and only its ABSENCE means it is
  complete. An uncapped run normally writes none — nothing truncated it — but
  "uncapped" is not a promise of "noteless". `content.near-duplicate` has a
  100,000-pair scan ceiling that `findingCap` cannot lift (it is the engine's memory
  contract, not a preference), so an uncapped run that reaches it carries an
  `atLeast` note like any other truncated listing. Never infer completeness from the
  crawl's `findingCap`; infer it from the absence of the note.

  **It is set at `crawl_start` and nowhere else.** `crawl_rules` has no cap argument:
  the choice lives on the crawl row so that re-judging the crawl months later
  produces the same listing. A billed audit started without it has to be re-started,
  not re-judged.

  **What it costs, measured** (synthetic 20,000-page site, 1,000 duplicate title /
  meta / h1 groups, 1,000 exact-duplicate content groups, 500 near-duplicate
  clusters, 15,000 orphans):

  | rule | default cap | uncapped |
  | --- | --- | --- |
  | `links.orphan` | 200 in 0.21s | 15,000 in 0.23s |
  | `title.duplicate` | 200 in 2.5s | 1,000 in 10.6s |
  | `meta-description.duplicate` | 200 in 3.0s | 1,000 in 13.7s |
  | `h1.duplicate-text` | 200 in 2.9s | 1,000 in 11.7s |
  | `content.exact-duplicate` | 200 in 4.5s | 1,000 in 18.4s |
  | `content.near-duplicate` | 500 in 0.02s | 3,000 in 0.20s |

  About a minute of extra wall time on a 20k crawl, at ~116MB RSS. That is the
  billing story: the whole picture is minutes, not hours.

  **The one ceiling `findingCap` cannot lift, and what to do when you meet it.**
  `content.near-duplicate` is the only rule whose cap bounds a *scan* rather than a
  listing, and on a site whose pages are near-identical in the thousands the pair
  count is quadratic. Left uncapped it broke the engine's 512MB memory contract at
  2,000 degenerate pages (521MB RSS), produced 3,268,808 pairs at 2.0GB at 5,000,
  and exhausted a 4GB heap at 20,000 — so the SCAN stops at **100,000 pairs** no
  matter what `findingCap` says, and writes `{reported: 100000, atLeast: 100001}`.
  Real sites are nowhere near that; the 20k table above is a badly templated one.
  If you do meet the ceiling, report it as what it is: **the site has no distinct
  content**, which is a finding in its own right and a far more useful sentence than
  an enumeration of a hundred thousand pairs. Quote the `atLeast`, say the scan
  stopped there, and take the magnitude from `content.template-similarity` and the
  duplicate-group rules rather than from the pair list.
- **Evidence shapes belong to their rules.** `issue_urls` returns `{url, evidence}`
  and the evidence's fields are whatever that rule wrote — read what it gives you
  rather than expecting a fixed set. `url` is null on a site-scoped finding (a fact
  about the crawl, not about a page).
- **Severity is the rule's opening bid.** `critical`, `warning`, `info` are what the
  rule asserts in the abstract. You may raise or lower it for this site — a `warning`
  on the templates that earn the revenue outranks a `critical` on a page type nobody
  visits — but say that you did, in `notes`.
- **Page-type cohorts are the crawl's own template detection.** `issues_list` and
  `pages_query` both take `pageType`, and metrics carry it as `scopeValue`. Prefer
  those cohorts to path guesses. `(untyped)` is the pages the crawl could not type:
  report it as its own bucket rather than folding it into a template.

  **Know what the detection actually produces before you filter on it.** A page type
  is derived from the URL path, and the crawl decides which paths are templates by
  looking at all of them together, once it has finished: a group of three or more
  pages sharing a path shape becomes one template (`/collections/:slug`), and a page
  with no such group keeps its own path as its type (`/cart`, `/about`). So expect a
  handful of `:slug` templates plus a short tail of one-off pages — the gate site's
  551 URLs, which used to type as 196 separate things, now read as its four real
  templates and a few named pages. A tail entry is a real page, not a failure to
  type; report it as the page it is.

  `(untyped)` is a different thing again, and on that site it occurred **zero**
  times — the bucket this file and the checklist both tell you to report may simply
  not exist on a given crawl. Say that it was empty rather than inventing one.

  Practical consequence: the cohort ids are still not guessable, so discover them
  first — one `metrics_get` scoped pass or a `pages_query` census — and filter on the
  ids you saw. The per-template breakdown the checklist asks for (CHECK-35 / 36 / 37:
  products, collections, blog, info pages, separately) is normally producible from
  those ids now; where a site's URLs genuinely do not separate that way, group by
  first path segment and SAY SO in `notes`.
- **A refusal names its field.** An unrecognised `severity`, `checkId`, `ruleId`,
  `category` or `pageType` is refused rather than answered with an unfiltered listing.
  Read the message; do not retry with a guess.
- **Two `pages_query` filters answer cross-checks nothing else can.** `fetchClass`
  separates the pages the site served from the ones it refused (`blocked`), dropped or
  disallowed — the census behind CHECK-05 and behind every "% of pages" denominator on
  a crawl that met a WAF. `discoveredVia` says how the crawler reached each URL —
  `seed`, `link`, `sitemap` or `redirect` — which is the other half of the orphan
  finding: a page whose only discovery was `sitemap` was linked from nowhere the crawl
  walked. Both are closed vocabularies and a value outside them is refused by name.
- **The robots.txt the crawl obeyed is readable.** `robots_get` returns the stored
  file — `raw` (the text as served, `truncated` when it is only the first 500KB),
  `outcome` (`read` / `absent` / `unreachable`), `crawlDelaySec`, `sitemapSources`,
  `suppliedSitemaps` (documents the crawl was handed at start rather than told about
  by the file) and the `userAgent` the crawl matched under. It is EVIDENCE, not a re-fetch: a file that
  has changed since the crawl is a fact about the site, and reading today's copy over
  the crawl's would hide it.
- **Large lists go to a file.** `export_crawl` writes `issues`, `pages` or `metrics`
  as gzipped JSONL and answers `{dataset, path, rows, bytes}`. Use it when you need
  every row; put the path in the findings file, not the rows.

### 2.3 Order of the walk

Follow the checklist's own sections — they group the calls naturally:

| Section | Checks | Mostly answered by |
|---------|--------|--------------------|
| Pre-Crawl | 01, 02 | render diff rules + `render.coverage` |
| 1. Crawlability & Robots | 03-05 | robots rules + `robots_get`; browser for pattern gaps |
| 2. Sitemaps | 06-09 | sitemap rules + `sitemap.structure` |
| 3. Redirects & Errors | 10-13 | redirect rules + `redirect.volume`, status rules |
| 4. Host & Protocol | 14-15 | host-probe rules |
| 5. Canonicals & Indexability | 16-21 | canonical + indexability rules |
| 6. Pagination | 22-23 | pagination rules; browser for JS-only controls |
| 7. Hreflang | 24-26 | hreflang rules + `hreflang.coverage` |
| 8. URL Parameters | 27-30 | `url.param-volumes` + URL hygiene rules |
| 9. Internal Linking | 31-34 | link metrics + orphan/nav rules |
| 10. On-Page SEO | 35-40 | on-page and content rules (38 is Phase 3) |
| 11. Structured Data | 43-46 | schema rules; browser for the opportunity matrix |

### 2.4 What the engine does not measure

Several checks ask for a number no rule produces. The checklist says so at each one.
Record those as NOT MEASURED in `notes` — never substitute a nearby number:

- H1 ↔ title **alignment** (CHECK-37) — the engine stores each page's first H1 text
  and compares headings only to each other, so whether a heading matches its title is
  still a sampled browser reading;
- image weight and format (CHECK-49); caching, compression and protocol (CHECK-50);
- Core Web Vitals (CHECK-47) — the engine measures response time and nothing else;
- GSC-only orphans (CHECK-32, CHECK-33b) — by definition outside a crawl.

**Four things a previous audit recorded as NOT MEASURED and the engine now measures.**
An audit that copies an older findings file forward will under-report all four:

- **Total redirect inlinks** (CHECK-10). `redirect.volume`'s site row carries
  `redirectInlinks` beside `redirectPages`: the number of internal LINKS whose target
  is one of the crawl's redirecting URLs. The two are different questions rather than
  two spellings of one — `redirectPages` counts the URLs that are wrong,
  `redirectInlinks` counts how often the site walks into them, and a template link
  that redirects is one redirect page and one inlink per page of the site. That
  second number is the crawl-budget figure CHECK-10's Evaluate line grades, and it is
  now on the wire, so **read the field rather than recording the check as unmeasured**.
  The old warning still holds: `ratioPct` is redirecting URLs ÷ URLs fetched and is
  not a substitute — on the Phase 7 gate site the two answered `ratioPct: 1.8` and
  `redirectInlinks: 898` against 551 URLs crawled, which is **163%**, well past
  CHECK-10's 10% FAIL threshold. Quoting the ratio would have passed the check on the
  site's third-largest finding.

- **Duplicate titles, meta descriptions and H1 headings** (CHECK-35, CHECK-36,
  CHECK-37). `title.duplicate`, `meta-description.duplicate` and `h1.duplicate-text`
  each report ONE FINDING PER DUPLICATED VALUE, not per page: the evidence carries the
  value itself, `count` (how many indexable pages share it — exact) and `pages` (up to
  20 of them). So `issues_list`'s `count` for these rules is the number of duplicate
  GROUPS, and the pages involved are the sum of the groups' own counts — quote both,
  and never read the group count as a page count. Capped at 200 GROUPS by default,
  with the usual `truncated`/`total` note; `findingCap` moves that number and
  `findingCap: null` removes it. What it never moves is the twenty URLs inside one
  finding — `count` is the group's exact size at every setting, so a group of five
  thousand pages stays one row saying "5,000, here are twenty" rather than becoming a
  five-thousand-element array. Uncapped means more findings, not fatter ones.
  `h1.duplicate-skipped` (info) is the honest silence: a
  pre-Phase-7 crawl stored no heading text, so the check is NOT MEASURED on it rather
  than clean, and a re-crawl is what answers it.
- **Words a visitor can actually see.** `pages_query` returns `renderableWordCount`
  beside `wordCount` — the same count minus the words the page's own markup hides
  (`hidden`, inline `display:none`, a closed `<dialog>` or `<details>`) — and it is
  the number `content.thin` judges on. Quote the renderable figure when you report
  thin content; the gap between the two is the template's furniture, and
  `content.metrics-by-type` carries both distributions per template so you can size
  it.

  **The two null shapes are different facts, and only one of them is a gap.** A
  `wordCount` with a NULL `renderableWordCount` is a row a pre-Phase-7 analyzer
  wrote: the page was read, the column the floor now needs did not exist yet, and
  the engine SAYS SO rather than falling back — `content.thin-skipped` (info) fires
  per page, on the `links.orphan-skipped` / `robots.check-skipped` precedent. That
  is NOT MEASURED, and a re-crawl is the fix, because a word count cannot be
  recomputed from a database that does not store the HTML. **Null in BOTH columns is
  not a skip at all**: the analyzer never produced text for that URL — a PDF, a 404,
  anything with no body to read — and `content.thin` was always silent about those.
  A re-crawl changes nothing there, and reporting it as unmeasured content would
  invent a gap.
- **Click depth**, immediately below.

**And two numbers that both measure a depth, one of which is not about the site.**

`depth` — `pages_query`'s `depth`, and the `structure.depth-distribution` metric — is
**discovery depth: hops from a seed**. Every sitemap URL is enqueued as a seed, so on
a site whose sitemap covers the estate, pages with no HTML link path whatsoever sit at
depth 0 beside the home page. The gate site read 437 of 443 indexable pages at depth 0
while the median page had **zero** inbound internal links. That number is still worth
reading, for what it actually says: how the CRAWL found the site. A distribution that
collapses to zero means the pages were found by reading a file rather than by
following links, which is site-wide orphan evidence and is where it is now filed
(CHECK-32). It is not an answer to "how deep is this site".

`clickDepth` — `pages_query`'s `clickDepth`, and the
`structure.click-depth-distribution` metric — is **the shortest chain of internal
links from the home page**, computed by the engine's own breadth-first search over the
link graph. 0 is the home page; **null means no chain of links reaches the page at
all**, and the metric counts those as `nullCount` beside the distribution. That is
CHECK-31's number, and the sitemap-only bucket the check has always demanded.

The history, because it explains the shape of the checklist: until Phase 7 the engine
had only discovery depth, and CHECK-31 had to be answered by rebuilding reachability
by hand from `links.orphan` and `inlinks.sources-by-type` and then recorded as passing
on its stated criteria while NOT MEASURED on its intent. **That hand-rebuild is
finished** — the engine computes the walk now. Use the metric and `clickDepth`, and
use `links.orphan` for what it is: the per-page verdict, cross-read against the
unreachable set (a page that is unreachable but not an orphan is an island, linked
only from other unreachable pages). CHECK-33b's "sitemap only" tier reads `clickDepth`
for the same reason — counted off `depth` it was empty by construction.

One gate on both: `clickDepth` is written by the RULES run, not by the crawl. Null on
every page means the rules have not run over this crawl, which `crawl_status`'s
`rulesRunAt` settles — a missing measurement, never a site with no internal links.

**And one more silence to distrust: a rule that compares two columns is only
evidence when the two are comparable.** `rulesRunAt` settles "did the rule run"; it
says nothing about whether the rule COULD have fired. `content.csr-dependent`
(CHECK-01) is the case this engine learned it on. Until ruleset 0.6.0 the rule
compared the browser's `renderedWordCount` against the markup-visible count, and on
a site whose markup carries a fixed block of CSS-class-hidden chrome the rendered
side is lower than the markup side on every page — the Phase 7 gate site ran 0.32
to 0.73, so the firing condition was unreachable whatever the site did. Zero
findings there was not "no client-side rendering"; it was a comparison nothing
could answer.

**Ruleset 0.6.0 fixed that particular one** by putting the same instrument on both
sides: the rule now reads `renderedRenderableWordCount` (the crawl's analyzer over
the post-JavaScript DOM) against `renderableWordCount`, so chrome present in both
documents cancels. **The habit survives the fix**, which is the point of keeping
this paragraph: the next unreachable comparison will be in some other rule, and
nothing but this check will find it.

`pages_query` publishes both of the columns that rule compares —
`renderableWordCount` and `renderedRenderableWordCount` — which is what makes this
checkable rather than theoretical: before you record a diff rule's silence as a
PASS, read the two columns on the pages the render pass covered and satisfy
yourself the rule had a way to fire.
Where it did not, the check is SKIP with the arithmetic in `notes` — and, per the
hard rule at the top of this file, it is a bug report about the rule rather than a
finding about the client. It matters most exactly where you want the answer: on the
gate site CHECK-33b found 100% of products with no HTML link path, the symptom a
client-side product grid produces, and CHECK-01 was the check that could not confirm
it.

---

## Phase 3 — the agent checks

Everything left is yours. Three of them sit inside the crawl-derived range and the
rest are the browser, analytics and judgement sections.

### 3.1 The three judgement checks

- **CHECK-38 — content quality and intent match.** Two metrics supply evidence and no
  verdict: `content.metrics-by-type` (word-count distribution per template) and
  `content.template-similarity` (how alike a template's pages are). Quote both, then
  do the work: five page types plus three to five blog articles, read rather than
  skimmed. A metric is not an opinion about quality and must not be reported as one.
- **CHECK-41 — E-E-A-T.** No rule of any kind claims it, and no metric evidences it.
  The browser work in the checklist IS the check. Record concrete observations —
  which About page, which author bios, which policy pages — not a score.
- **CHECK-42 — out-of-stock handling.** Same shape: `content.soft-404` is context if
  it fires; the verdict comes from looking at an OOS product.

Their verdict in the findings file is `AGENT`, with `notes` carrying what you found.
`AGENT` means the work was done and the judgement is recorded — it is not a polite
SKIP, and a bare `AGENT` with empty notes is a check nobody did.

**With no browser, CHECK-41 and CHECK-42 are `SKIP`, not `AGENT`.** Both are entirely
browser work: no rule claims them, `issues_list` refuses their check ids, and without
a browser there is nothing to have looked at. `AGENT` would assert that the work was
done. Record `verdict: "SKIP"` with `notes` naming the missing browser MCP server and
what it blocked — the same disposition as §3.3's browser sections, and the one the
Phase 6 gate's auditor arrived at by following this file's own honesty rule against
this paragraph's earlier wording.

**CHECK-38 goes the other way, and the contrast is the reason.** It keeps `AGENT`
with no browser, because two metrics DID answer part of it — quote
`content.metrics-by-type` and `content.template-similarity`, weigh them, and state
in `notes` that no page was read and the intent-match half is unassessed. `AGENT`
here asserts that a judgement was made on the evidence available, which is true;
`SKIP` would throw away work that was done. What separates it from CHECK-41 and
CHECK-42 is not how much of it a browser would have decided but whether ANY evidence
existed to judge: those two have none at all.

### 3.2 Hybrid checks: the engine half and the deciding half

Eleven of the in-scope checks are `Engine + DevTools` (03, 05, 22, 29, 30, 37, 39, 43,
44, 45, 46): the engine answers part of the question and a browser, GSC or Ahrefs
answers another part. Route them the same way every time, because a verdict that
depends on who ran the audit is not a verdict.

1. **Do the engine half and quote it.** Always. It is cheap and it is the part that
   scales past one page.
2. **Does the engine evidence resolve the check's own Evaluate criteria?** If yes,
   the verdict is the engine's — `PASS` or `FAIL` — and `notes` names every sub-step
   you did not perform, so the reader knows what the verdict does not cover.
3. **If the deciding criterion is one only the missing tool can answer**, the engine
   half cannot carry the verdict, and it downgrades by what is missing:
   - missing **judgement** (the evidence is in hand; nobody has weighed it) → `AGENT`,
     with the engine work quoted in `notes`;
   - missing **evidence** (the tool that would produce it was never available, so
     there was no work to do) → `SKIP`, naming the tool.

The distinction between the last two is the same one that separates MANUAL from SKIP
in the checklist: `AGENT` says a person looked, `SKIP` says nobody could. Never let a
half-answered hybrid check land on `PASS` — an engine half that passes is not the
check passing, and recording it as one is how a site gets a clean bill of health for a
question nothing asked.

**The case that looks like an exception and is not: engine clean, browser would
still decide.** A whole class of hybrids has an engine half whose SILENCE answers the
check's pass condition while a browser-only criterion could independently fail it.
`schema.breadcrumb-absent` does not fire, so BreadcrumbList markup exists on the site
— and "the markup matches the visible breadcrumb" is unverifiable without a browser.
`mobile.viewport-missing` does not fire, so every page declares a viewport — and
whether the page is actually usable on a phone is a different question. The engine
half is real evidence and it is not the verdict.

**The ruling, and it is categorical: the verdict is `SKIP`, with the engine half
quoted in `notes` as supporting evidence.** The test is one sentence — *if the
missing tool could still fail the check, it is not a pass* — so a hybrid whose tool
is absent can only FAIL (the engine found something) or be recorded as unaudited. It
never passes. What the engine's silence buys is NARROWER, and record it as what it
is: it eliminates one way the check could fail, which is worth writing down and is
not an answer to the check.

**The class is named so nobody re-derives it per audit.** On the Phase 7 gate site
nine checks landed here — CHECK-05, CHECK-43, CHECK-44, CHECK-45, CHECK-46,
CHECK-50, CHECK-52, CHECK-57, CHECK-68 and CHECK-70 — and they are most of the reason that
audit's SKIP count was 42. That number is the policy working. The alternative
reading, PASS-with-a-caveat, would have produced nine passes on questions nothing
asked, on a site whose entire product catalogue turned out to be unreachable.

This policy came out of the Phase 6 gate, where the auditor had to invent it mid-walk
because the skill routed only the pure cases; the paragraph above came out of the
Phase 7 one, where the auditor had to rule on the half-answered class the same way.
Both are written down so the next audit lands where those two did.

### 3.3 The browser and platform sections

Sections 12 (Performance & CWV), 13 (GEO / AI Visibility) and 14 (Shopify-specific)
are agent work with engine support where the checklist names it — CHECK-49, CHECK-50
and CHECK-52 have rules; CHECK-65 to CHECK-70 read the pages listing and the canonical
and content findings.

Before the first browser check, confirm the browser MCP server answers. If it does
not: name the checks it blocks, tell the user, and wait. Do not substitute a plain
HTTP fetch for a check that needs a rendered page — a fetch has no JavaScript, no
console and no layout, and a check answered from one is answered wrongly. If the user
says to continue without a browser, those checks are SKIP with the tool named.

### 3.4 Cross-reading

Several findings only mean something together, and this is where the audit stops being
a list:

- CHECK-01 (client-side rendering) with CHECK-33b (product discovery) and CHECK-31
  (depth): a JS-only product grid is why products have no depth and why the sitemap is
  carrying discovery on its own.
- CHECK-03 (robots patterns) with CHECK-27/CHECK-29 (parameter volumes): what gets
  through the robots rules is what the crawl surface is made of.
- CHECK-39 (near-duplicates) with CHECK-78 (cannibalisation from GSC): duplicate pairs
  and cannibalising query groups are usually the same pages seen twice.
- CHECK-73 (top pages) with everything: a fault on a page that earns is a different
  finding from the same fault on one that does not.

---

## Phase 4 — the findings file

Write ONE JSON file: `ariadne-findings.json` in the audit's working directory.

**The NAME is part of the interface too.** Both downstream skills open
`ariadne-findings.json` by that name, and it says whose findings these are in a client
folder that will also hold a crawl export, a report and a workbook. The Phase 6
deliverable run wrote `findings.json` and the two skills went looking for the other
spelling; if you meet a file under the old name, it is this shape and renaming it is
the fix.

**This shape is an interface, not an example.** The `ariadne-report` and
`ariadne-action-plan` skills read it verbatim; a field renamed here is a deliverable
broken there.

```json
{
  "schema": "ariadne-findings/1",
  "generatedAt": "2026-08-27T17:42:11.000Z",
  "site": {
    "siteUrl": "https://example.com",
    "client": "Example Ltd"
  },
  "crawl": {
    "crawlId": "crawl_0b316718-636a-42c9-abbb-738c46b77db6",
    "siteUrl": "https://example.com",
    "status": "finished",
    "startedAt": "2026-08-27T09:12:04.100Z",
    "finishedAt": "2026-08-27T10:48:55.902Z",
    "pagesCrawled": 4821,
    "renderPassCount": 1,
    "rulesetVersion": "0.4.0",
    "rulesRunAt": "2026-08-27T11:04:19.220Z",
    "findingsCount": 1902,
    "frontier": { "pending": 0, "leased": 0, "done": 4821, "failed": 3, "renderPending": 0 },
    "rulesRun": { "pagesScanned": 4821, "findings": 1902, "metrics": 855 },
    "render": { "mode": "auto", "rendered": 240, "failures": 2, "unrendered": 4581, "budget": 241, "truncated": false },
    "caveats": [
      "3 URLs failed to fetch; their checks are reported on 4818 pages, not 4821."
    ]
  },
  "checklist": {
    "path": "skills/ariadne-audit/checklist.md",
    "checksTotal": 82
  },
  "coverage": { "pass": 31, "fail": 24, "skip": 12, "agent": 15 },
  "checks": [
    {
      "checkId": "CHECK-07",
      "title": "Sitemap contains only indexable 200 URLs",
      "section": "2. Sitemaps",
      "priority": "High",
      "verdict": "FAIL",
      "severity": "warning",
      "owner": "engine",
      "notes": "128 of 4,102 sitemap URLs (3.1%) are non-indexable: 96 noindexed collection filters, 32 redirects to /collections/all.",
      "recommendation": "Regenerate the sitemap from indexable canonical URLs only; drop filtered collection URLs from it entirely.",
      "evidence": [
        {
          "kind": "finding",
          "tool": "issues_list",
          "args": { "crawlId": "crawl_0b31…", "checkId": "CHECK-07" },
          "ruleId": "sitemap.non-indexable",
          "severity": "warning",
          "count": 96,
          "sampleUrls": ["https://example.com/collections/x?filter.v.size=8"]
        },
        {
          "kind": "finding",
          "tool": "issue_urls",
          "args": { "crawlId": "crawl_0b31…", "ruleId": "sitemap.redirected" },
          "ruleId": "sitemap.redirected",
          "count": 32,
          "export": "/srv/ariadne/exports/crawl_0b31…-issues.jsonl.gz"
        },
        {
          "kind": "metric",
          "tool": "metrics_get",
          "args": { "crawlId": "crawl_0b31…", "metricId": "sitemap.structure" },
          "metricId": "sitemap.structure",
          "scope": "site",
          "scopeValue": "",
          "value": { "docs": 6, "totalUrls": 4102, "urlCapBreaches": 0, "entryCapReached": false, "oversizedDocsSkipped": 0 }
        }
      ]
    },
    {
      "checkId": "CHECK-41",
      "title": "E-E-A-T signals",
      "section": "10. On-Page SEO",
      "priority": "Medium",
      "verdict": "AGENT",
      "severity": "warning",
      "owner": "agent",
      "notes": "About page names no people and carries no credentials; 4 of 5 articles reviewed have no byline; no editorial policy page. Trust signals are present on PDPs (returns, contact, reviews).",
      "recommendation": "Add author identities and bios to editorial content; publish an editorial standards page; surface the company's people on the About page.",
      "evidence": [
        {
          "kind": "observation",
          "source": "browser",
          "summary": "Navigated /about and 5 articles; extracted in-content links and byline elements.",
          "urls": ["https://example.com/about", "https://example.com/blogs/journal/x"]
        }
      ]
    },
    {
      "checkId": "CHECK-80",
      "title": "AI citations and brand share of voice",
      "section": "15. Backlinks & Brand Authority (Ahrefs)",
      "priority": "High",
      "verdict": "SKIP",
      "severity": null,
      "owner": "analytics",
      "notes": "Ahrefs Brand Radar is not available on this account; no AI citation data was retrieved.",
      "recommendation": null,
      "evidence": [
        { "kind": "observation", "source": "ahrefs", "summary": "brand-radar-* tools not available on the connected subscription." }
      ]
    }
  ]
}
```

### Field rules

- **`checks` carries every check in the checklist, exactly once.** A check with no
  entry is indistinguishable from a check nobody ran. 82 entries, always.
- **`verdict`** is one of `PASS`, `FAIL`, `SKIP`, `AGENT`. The checklist's six
  statuses map onto them (see its Status Definitions table): WARN is a `FAIL` at a
  lower `severity`, N/A is a `SKIP` whose notes say why it does not apply, MANUAL is
  `AGENT`.
- **`severity`** is `critical`, `warning`, `info` or `null`. Null for `PASS` and
  `SKIP`. For `FAIL` it starts as the rule's severity and is yours to adjust in
  context — say so in `notes` when you do.
- **`owner`** is `engine` (a rule or metric answered it), `agent` (judgement or
  browser work) or `analytics` (GSC / GA4 / Ahrefs).
- **`notes`** is required for `FAIL`, `SKIP` and `AGENT`, and is where the human
  sentence lives. For `SKIP` it must name what was unavailable.
- **`recommendation`** is required for `FAIL` and `AGENT` where a fix exists, `null`
  otherwise. It is the fix in the client's terms — the action-plan skill turns these
  into work items.
- **`evidence`** is a non-empty array for every check, including passes. Three kinds:
  - `{"kind": "finding", "tool", "args", "ruleId", "severity", "count", "sampleUrls", "export"}`
    — a rule's output. `export` is optional and holds the path from `export_crawl`
    when the full list was written to disk.
  - `{"kind": "metric", "tool", "args", "metricId", "scope", "scopeValue", "value"}`
    — a metric's row, with `value` copied verbatim.
  - `{"kind": "observation", "source", "summary", "urls", "detail"}` — everything the
    agent saw: `source` is `browser`, `gsc`, `ga4`, `ahrefs` or `manual`. `urls` and
    `detail` are optional.

    **A census is an observation, and it carries its call.** Several of the
    strongest engine answers are not a rule's output and not a metric row: they are
    what a `pages_query` sweep or the `robots_get` body says when you read it
    yourself — click-depth buckets per template, a path match over the whole
    listing, the pair of pages that share a title. Record those as `observation`
    with `source: "manual"`, and add `tool` and `args` alongside `summary` so the
    call is reproducible exactly as it is on a `finding` entry. An observation
    nobody can re-run is the one evidence kind this file cannot check.
  A PASS reached because a rule found nothing carries a `finding` entry with
  `count: 0` and the `args` that were asked, so the reader can re-run the query.
- **`args` reproduces the call.** The point is that anybody can repeat it and get the
  same answer.
- **`crawl.rulesRun`** carries three scalars — `pagesScanned`, `findings`,
  `metrics` — and **you fill them for any judged crawl, whether or not you ran the
  pass.** The surface returns no `elapsedMs`; do not invent one, and do not leave a
  null in its place.

  Where each one comes from when you did NOT run `crawl_rules` yourself:

  - `pagesScanned` — `crawl_status`'s field of the same name. It is the crawl's page
    count, which is exactly what the rules pass scans, so it is the same number the
    summary would have reported.
  - `findings` — `crawl_status`'s `findingsCount`, the live count of the crawl's
    issue rows.
  - `metrics` — the number of rows your `metrics_get` sweep returned. You read every
    metric anyway; count what came back.

  When you DID run the pass, copy the summary's own three and expect them to agree
  with those fields — a disagreement is a finding about the engine, not a rounding
  difference, and it belongs in `crawl.caveats`.

  **Re-running `crawl_rules` to fill this field is still forbidden.** Phase 1 says a
  judged crawl is auditable by whoever finds it, and re-judging shared state to
  satisfy a schema is the wrong trade — which is the whole reason the three numbers
  are readable without a run.

  `"rulesRun": null` survives for ONE case: a crawl whose `rulesRunAt` is null, where
  there is no judgement to describe. Write the null and put one line in
  `crawl.caveats` saying so. That crawl is the refusal case anyway — a findings file
  whose passes rest on an unjudged crawl asserts nothing.
- **`crawl.rulesRunAt` and `crawl.findingsCount`** are copied from `crawl_status`, and
  they are what every PASS on an empty listing rests on. A findings file whose
  `rulesRunAt` is null is a file whose passes assert nothing — the report and the
  action plan are entitled to refuse it. Copy them even when you ran the rules
  yourself: a reader six weeks later has the crawl, not your session.
- **`crawl.caveats`** is where the evidence's limits go: a page cap reached, a render
  pass that covered a fraction, URLs that failed to fetch, a crawl that ended
  `cancelled`. Empty array when there are none — never absent.
- **`coverage`** counts the verdicts. It must sum to `checklist.checksTotal`.

### Before you hand it over

- Every check present, every `notes` written for the verdicts that need one.
- No verdict resting on an empty listing without a `rulesRunAt` timestamp behind it.
- No engine-claimed check whose verdict came from a browser instead.
- The counts in `coverage` add up.

Then say, in the conversation: the crawl's shape, the top few problems in plain
language, and where the findings file is. The report skill takes it from there;
the action-plan workbook exists only on request (see its own status paragraph).

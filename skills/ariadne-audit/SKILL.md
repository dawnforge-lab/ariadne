---
name: ariadne-audit
description: >
  Run a full SEO & GEO audit against an Ariadne crawl: analytics context from GSC,
  GA4 and Ahrefs, then the 83-check checklist, with every crawl-derived check answered
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

**The engine makes an opening bid, and it is yours to change.** Since ruleset 0.23.0
every finding rule carries `type` (`issue`, `warning` or `opportunity`) and
`priority` (`high`, `medium` or `low`) beside its `severity`. They are the RULE's
defaults: what that kind of finding usually is, and what fixing it is usually worth,
referenced against Screaming Frog's Issue Type and Issue Priority. They have not seen
this site any more than severity has. Treat them as the opening bid: where this site
says otherwise, record your reading on the crawl with `crawl_config_set` (for
example `{"judgement": {"rules": {"images.missing-dimensions": {"priority": "high"}}}}`),
and every surface — `issues_list`, `issues_overview`, the CSV views — then serves your value
with `typeOverridden` / `priorityOverridden` marking it as set by you. Severity cannot
be overridden: it is the engine's fact about the rule; adjust it in the findings file
with the reason in `notes`, as below.

**Disabling a rule is how "this does not apply here" is recorded.** When a rule's
findings are true but irrelevant to this site — `url.internal-search` on a site whose
search pages are deliberately crawlable, a pagination rule on a template the client
has retired — send `{"judgement": {"rules": {"<ruleId>": {"disabled": true}}}}` with
`crawl_config_set`, and say why in that check's `notes`. The findings stay stored;
every listing leaves them out and names the rule in `disabledRules`, `issue_urls` of
that rule is refused rather than answered empty, and removing the override
(`{"judgement": {"rules": {"<ruleId>": null}}}`) brings them back at once. The decision is visible,
reversible and on the crawl, not buried in your notes. Never disable a rule to make a
real defect disappear; a check whose findings you disabled is a `SKIP` with its
reason, or a `FAIL` you argue down, never a `PASS`.

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
  (`npm run api:serve` with `ARIADNE_API_TOKEN` and an `X-Ariadne-Tenant` header; `mcp:serve` needs `ARIADNE_TENANT`). See the `ariadne-crawl` skill.
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
Phase 2  Engine-answered checks issues_list / metrics_get CHECK-83 first, then
                                                          CHECK-01 … CHECK-46
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

- `status` is `finished` (`cancelled`, `paused` and `failed` crawls can still be
  audited, but every count becomes a floor and the findings file must say so in
  `crawl.caveats`). A `cancelled` crawl that ran is final, judgeable and partial:
  an agent stopped it, and `neverFetched` (the URLs still pending in the frontier)
  says how much of the site was never seen. State that number in the caveat. A
  crawl paused or cancelled while still queued never ran and is NOT auditable:
  `crawl_rules` refuses it (409, "never ran"), and its `neverFetched` is null
  (null: the crawl was cancelled before it ran; nothing was seen). Start a new
  crawl instead;
- the frontier drained — `pending` and `leased` at 0. A crawl that stopped at its page
  cap makes CHECK-32 unanswerable (`links.orphan-skipped` fires and says why);
- **it is a spider crawl, or you are not auditing the site.** A LIST crawl (`mode:
  "list"` in `crawl_config_get`, `listUrlCount` beside it) fetched only the URLs it was
  handed and followed no link. It carries one `crawl.list-mode` finding (info, CHECK-83),
  and that finding decides what the crawl can answer:
  - every rule id in its `notMeasured` evidence did NOT run (the listings name them as
    `{id, reason}`, below): the link graph, orphans,
    click depth, inlinks, sitemap coverage, unlinked canonical and hreflang targets,
    and, when `sitemapsRead` is false, every sitemap rule. Each check those rules claim
    is SKIP, never PASS, however clean its listing looks. The listings name them too:
    `issues_list`, `issues_overview`, `metrics_get` and the exports carry the same rules
    in `notMeasured`, each as `{id, reason}` (the reason says whether it needed the link
    graph or a sitemap), beside `disabledRules`, `issues_overview` never makes one a zero
    row, `issue_urls` of one is refused (409), and `metric_table`'s `note` says it was
    not measured;
  - every rule id in `partiallyMeasured` ran, but only against targets the list
    itself fetched (listed URLs and their redirect targets). Its findings are true; its
    silence about any other URL is not a pass, so a check it alone answers is SKIP
    unless the listing has findings;
  - the rules about the listed pages themselves (titles, meta, headings, status codes,
    duplicates within the list) ran normally. `links.broken-internal` also reports a
    listed URL that answered 4xx with no inlink (its `listed` column).
  A list crawl is the right tool for re-checking a known set of pages (last audit's
  failures, a redirect map), not for a full audit: say which in `crawl.caveats`, and
  run a spider crawl for anything site-wide;
- **you know what the crawl's scope fenced off.** `crawl_config_get` shows `exclude`
  and `include` (and `scopeChangedAt` when they changed mid-crawl). Every URL they
  refused is a `pages` row of fetch class `excluded` — read them with `pages_query`
  (`fetchClass: "excluded"`); `fetchReason` names the pattern — and
  `crawl_status.excludedDropped` counts those turned away once the budget was full. An
  excluded URL was never fetched, so it is neither a finding nor a pass: no rule judges
  it, no link to it is broken, and the "not crawled" sitemap, pagination and hreflang
  checks leave it out on purpose. State the patterns in `crawl.caveats` and scope
  every site-wide claim to "within the crawled scope";
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

**Then read what came back, and read the evidence field first.**
`render.coverage`'s `renderPassEvidence` says whether a render pass has left any
trace on this crawl at all — a rendered page, a failed render, a named list, a
stamped count, a page still waiting for a browser. On `none` everything after it
is the selection a pass WOULD make, so the JavaScript checks are NOT MEASURED and
the numbers are a quote for the work rather than a record of it. On `failed` the LAST
render pass could not start: `renderLaunchError` carries the reason, the pages it
selected are still pending and a later `crawl_render` retries them. Rows an earlier
pass rendered (`pagesRendered` or `renderFailures` above 0) are still that pass's
evidence and its findings stand; NOT MEASURED applies only to what no pass rendered,
and the JavaScript checks are wholly NOT MEASURED only when both counts are 0.
`failed` is never "rendered" and never "no render needed". **Then the
mode.** `selectionMode` says which decision chose the pages. On an `explicit` pass
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
CHECK-33b). **45 of them have a rule behind them** — 42 with finding rules, plus
the three metric-only checks (CHECK-29, CHECK-33b and CHECK-38), whose metric rules
supply evidence and pass no verdict. Only CHECK-41
and CHECK-42 have no rule of any kind. Three of the 47 are judgement — CHECK-38,
CHECK-41 and CHECK-42 — and belong to Phase 3 whatever evidence exists for them.

### 2.1 Sweep first, then walk

Two unfiltered, paginated sweeps give you the whole picture before you commit to a
check, and the issues sweep is usually one call:

1. `issues_list` with no filter but `crawlId` — every rule that found something, with
   its `checkIds`, `severity`, `type`, `priority`, `count` and five `sampleUrls`.
   Follow `nextCursor` to the end. Index the rows by check id. Read the answer's
   `disabledRules` too: a rule named there fired and was filtered out by the crawl's
   judgement, which is not the same as finding nothing. And `notMeasured` (`{id, reason}` items): on a list
   crawl, a rule named there never ran, so its empty listing is SKIP, not PASS (`[]`
   on a spider crawl). `issues_overview` is the same
   picture in one unpaginated call, one row per rule, ordered by type and then
   priority, with `urls` (distinct URLs) and `percentOfJudged` — a good first read,
   but it has no sample URLs and no check index of its own beyond `checkIds`.
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
  Three checks are metric-only — CHECK-29, CHECK-33b and CHECK-38
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
  total: 243}`: quoting the count would have understated it by 43 pages. Some rules
  can only give a lower bound (`atLeast` instead of `total`) because counting the
  rest would mean running the scan the cap exists to stop —
  `hreflang.alternates-not-crawled` is one — and there the number is not a
  magnitude, only a floor under one. (Where a `pageType` filter is on, `count`
  is that cohort's rows while `total`/`atLeast` stay the whole rule's magnitude — the
  two are not two ends of one fraction.)

- **A BILLED AUDIT ASKS FOR THE WHOLE PICTURE, NOT A SNAPSHOT: pass
  `findingCap: null` to `crawl_start`.** The cap above is the default — 200
  findings per listing rule — and it exists for a first look at an unknown site,
  where a bounded answer is the point. It is the wrong setting for work a client is
  paying for: "243 orphans, here are 200" is a list the client cannot work through
  to the end.

  `findingCap: null` uncaps every listing rule. `findingCap: <n>` sets a number
  instead, and it means the same number everywhere — there is one budget, not one
  per rule family.

  **Keep reading the `truncated` note, not the setting.** The rule above does not
  change: a note means the list is incomplete, and only its ABSENCE means it is
  complete. Never infer completeness from the crawl's `findingCap`; infer it from
  the absence of the note.

  **Set it at `crawl_start`; change it with `crawl_config_set`.** `crawl_rules` has no
  cap argument: the choice lives on the crawl row so that re-judging the crawl months
  later produces the same listing. A billed audit started without it does not need a
  re-crawl since Phase 27a: `crawl_config_set` with `{"judgement": {"findingCap": null}}` (null is
  uncapped there too — it is not "remove the key") and then `crawl_rules` re-judges it
  uncapped. Until that run, `crawl_status`'s `judgementStale` reads
  `{"stale": true, "reasons": ["findingCap"]}`: the stored listing is still the capped
  one.

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
  | `content.near-duplicate` | 200 in 0.61s | **2,000 pages** in 0.74s |

  About a minute of extra wall time on a 20k crawl, at ~116MB RSS. That is the
  billing story: the whole picture is minutes, not hours.

  The near-duplicate row counts PAGES, not pairs, and was re-measured on the
  page shape over the same synthetic cohort (500 clusters of four = the 3,000
  pairs the row used to quote) on a slower machine than the rows above it, so
  read it for its shape rather than against them. A site where thousands of
  pages share one template is the expensive case and it is bounded rather than
  cheap: each page's own partner count stops at 200, which turns a cohort of
  20,000 identical pages from ~16 minutes into ~99 seconds. `findingCap: null`
  does not lift that per-page count — it is a wall-clock bound, not a listing
  budget — so those pages read "200+" however the cap is set.

  **A site whose pages are near-identical in the thousands.**
  `content.near-duplicate` reports one finding per PAGE — `{mainWords,
  nearDuplicates, closest}`, where `closest` names up to five partners with their
  distances — so a cluster of 900 templated pages is 900 rows, not the 404,550
  pairs between them. `nearDuplicates` is exact up to 200; past that it reads 200
  with `nearDuplicatesAtLeast: true` beside it, and the only honest rendering is
  **"200+"** (counting every partner of every page of a cluster that size is the
  square the page shape exists to avoid — see the cost table above). Do not add
  the counts up either: every member of a cluster reports every other member, so
  the sum is roughly the square of the thing you want. Sort by
  `nearDuplicates`, take the cluster, and
  report it as what it is: **the site has no distinct content on that template**,
  which is a finding in its own right and a far more useful sentence than an
  enumeration. Size it with `content.template-similarity` and the duplicate-group
  rules beside it.

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
  a crawl that met a WAF — and, since Phase 27c, from the ones the crawl's own scope
  fenced off (`excluded`, never requested: leave them out of every denominator, as
  you would `disallowed`). A `blocked` 401 or 403 on a crawl started with credentials
  is a gate the credentials did not open: report it as an access problem of the crawl,
  not a site defect, until you have checked the credentials. `discoveredVia` says how
  the crawler reached each URL — `seed`, `link`, `sitemap`, `redirect` or (a list
  crawl) `list` — which is the other half of the orphan finding: a page whose only
  discovery was `sitemap` was linked from nowhere the crawl walked. Both are closed
  vocabularies and a value outside them is refused by name.
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
| Engine Coverage | 83 | `crawl_status` (incl. its `resources` block) + `site.health` + the NOT MEASURED markers — **answer this one FIRST** |
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
- image DIMENSIONS as rendered (CHECK-49) — the resource pass weighs every image and
  records its content type, so weight and format ARE measured now (see below), but
  nothing decodes a file, so whether one is over-compressed or larger than the box it
  is displayed in is still a browser reading; likewise responsive `srcset` sets;
- compression and protocol (CHECK-50) — caching IS measured for static files
  (`resources.uncached`), from `Cache-Control` and `Expires` only, and the HTML
  documents' own caching headers are still not stored;
- Core Web Vitals (CHECK-47) — the engine measures response time and nothing else;
- GSC-only orphans (CHECK-32, CHECK-33b) — by definition outside a crawl.

**Five things a previous audit recorded as NOT MEASURED and the engine now measures.**
An audit that copies an older findings file forward will under-report all five:

- **The files each page points at** (CHECK-48, CHECK-49, CHECK-50, CHECK-51). Since
  Phase 11 the crawl asks the site about every image, stylesheet and script its served
  HTML declares — HEAD first, metadata only — so `resources.broken`,
  `images.oversized`, `images.legacy-format`, `resources.uncached` and the
  `page.weight` metric all have real numbers behind them. **Read
  `crawl_status`'s `resources` block before quoting or not quoting any of them**
  (CHECK-83): on a crawl started with `fetchResources: false`, or one written before
  the tables existed, every one of those rules is silent because nothing was measured,
  and each case has its own marker — `resources.not-fetched` (info) for the first,
  `resources.not-recorded` (info) for the second, never both on one crawl. What stays
  unmeasured is stated at each check: no image is decoded, only the SERVED HTML's
  references are seen, and fonts, media and favicons are out of scope.

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
- **Words a visitor can actually see, and words the page can call its own.**
  `pages_query` returns `renderableWordCount` beside `wordCount` — the same count
  minus the words the page's own markup hides (`hidden`, inline `display:none`, a
  closed `<dialog>` or `<details>`) — and it is the number `content.soft-404`'s
  length ceiling is applied to. `content.thin` judges a third number, which it
  carries in its own evidence as `mainWords`: the words inside the page's `<main>`,
  or its body minus the `<nav>`, `<header>`, `<footer>` and `<aside>` subtrees. That
  is the count that survives a template — a page can ship 900 words and say 90 of
  them itself — so quote `mainWords` when you report thin content, with the
  whole-document count beside it as the size of the furniture.
  `content.metrics-by-type` carries the whole-document distributions per template so
  you can size that.

  **Zero is a finding; unmeasured is not.** A page whose body is nothing but
  navigation and footer is reported at `mainWords: 0` with `note: "no main-content
  text at all"` — the emptiest page the site serves, named rather than skipped. A
  crawl where NO page carries the count is a different thing: the check could not be
  run, `content.thin-skipped` (info) says so once for the crawl, and a re-crawl is
  the fix, because a word count cannot be recomputed from a database that does not
  store the HTML. While that marker fires, an empty thin list is not evidence of
  anything. And a page the analyzer never produced text for at all — a PDF, a 404,
  anything with no body to read — is not in either group: `content.thin` has always
  been silent about those, and reporting them as unmeasured content would invent a
  gap.
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

**Forty rules joined at ruleset 0.20.0, and they need no re-crawl.** They read what
the crawl already stored, so a crawl judged before 0.20.0 gets them from one
`crawl_rules` run. An audit that copies an older findings file forward will miss
every one of them. The checklist names each at its check, with its severity. By check:

- **CHECK-04, directives:** `indexability.nofollow`, `directives.restrictive` (the
  evidence names which snippet or image directive) and `directives.unavailable-after`.
  A `noindex, nofollow` header on internal search results fires
  `indexability.nofollow` correctly. Whether it is deliberate is your call, and the
  rule's fix says to leave it on pages that are meant to be closed off.
- **CHECK-07 and CHECK-08, sitemap entries:** `sitemap.url-too-long`,
  `sitemap.cross-host-loc`, `sitemap.lastmod-invalid` and `sitemap.over-50k-urls`.
  CHECK-08 is no longer metric-only. `sitemap.over-50k-urls`'s count is exact from
  ruleset 0.22.0 (it counts each document's listings); on a crawl from before Phase
  26c it is silent and `extraction.not-recorded` speaks. `sitemap.cross-host-loc` stays
  silent when a sitemap on another host lists the crawled site's own URLs, because that
  is a cross-submission the protocol allows. `sitemap.lastmod-invalid`'s `future` means
  dated after the crawl ENDED, so the value was already in the future when the sitemap
  was read. A value stamped while the crawl ran is not judged, so a sitemap that stamps
  every entry with the moment it was generated does not fire. If every lastmod in a
  document is one instant inside the crawl's `startedAt`–`finishedAt` window, that is
  worth a sentence in `notes`. The engine does not report it.
- **CHECK-14 and CHECK-84, CHECK-85, transport security:** `security.http-url`,
  `security.hsts-missing`, `security.headers-missing` (its Missing Headers column
  names which) and `security.mixed-content`. All four need a site crawled over HTTPS.
  The two header rules read response headers, which only crawls from Phase 25 on
  store. On an older crawl `security.headers-not-recorded` fires instead and both
  are silent, so CHECK-84 is NOT MEASURED there, never a PASS.
  `security.mixed-content` reads the same references as the resource pass, so
  `resources.not-recorded` makes it unanswerable the same way.
- **CHECK-16, CHECK-17 and CHECK-19, canonicals:** `canonical.relative`,
  `canonical.fragment`, `canonical.chain` (a revisit is `loop: true`, not a long
  chain) and `canonical.unlinked`.
- **CHECK-22 and CHECK-23, pagination:** `pagination.non-indexable-target`,
  `pagination.loop` and `pagination.sequence-error`. All three need the next page to
  have been crawled. When `pagination.next-target-uncrawled` fires on the same series,
  their silence there says nothing.
- **CHECK-24, hreflang:** `hreflang.inconsistent-return-code`,
  `hreflang.multiple-entries`, `hreflang.self-only` and `hreflang.unlinked-target`.
- **CHECK-30 and CHECK-67, URL shape:** `url.uppercase`, `url.underscores`,
  `url.non-ascii`, `url.spaces`, `url.multiple-slashes` and `url.repetitive-path` read
  the path only, never the query. `url.internal-search` fires on an indexable page
  whose path has a `search` segment or whose query has a search parameter. That
  includes the bare search page with no query, and a search app's results page
  served at a content path such as `/pages/search`. A search URL that is already
  noindexed does not fire, so the rule's silence on `?q=` pages can be the site doing
  the right thing.
- **CHECK-32, CHECK-33 and CHECK-86, links:** `links.only-from-non-indexable`,
  `links.internal-nofollow`, `links.high-outlinks`, `links.localhost` and
  `links.non-descriptive-anchor`. CHECK-33 is no longer metric-only either. The
  external limit in `links.high-outlinks` is 10 distinct targets, set from Screaming
  Frog's own boundary. A policy page with a dozen outbound references reaches it, so
  weigh the page before you call it a defect. `links.localhost` judges external links
  only: a site crawled on a private address does not report its own internal links.
  `links.non-descriptive-anchor` reads English phrases only.
- **CHECK-35 and CHECK-36, pixel width:** `title.pixel-too-long`,
  `title.pixel-too-short`, `meta-description.pixel-too-long` and
  `meta-description.pixel-too-short`, beside the character-count rules. Where both
  fire on one page, it is one defect: report it once and cite both ids. A value with a
  character outside the measured scripts (Latin, Greek, Cyrillic) is not pixel-judged,
  and its character rules still apply.
- **CHECK-51, served types:** `resources.bad-content-type`. It reads the resource
  pass, so on a `fetchResources: false` crawl it is silent and `resources.not-fetched`
  is the marker that says so.

**Twenty-eight rules joined at ruleset 0.21.0, and twenty-four of them need a
re-crawl.** They read page facts the crawler records only since Phase 26b (extraction
version 2): the document language, Open Graph and X tags, H2s, repeated titles and
descriptions, bot-specific robots metas, meta refresh, link shapes, insecure forms and
frames, image alt text, repeated pagination links and the head/body structure. Running
`crawl_rules` at 0.21.0 over a crawl written before that does not judge them.
`extraction.not-recorded` (info) fires once instead, with `pagesNotRecorded` and
`pagesRecorded`, and every check it claims is NOT MEASURED on that crawl, never a PASS.
The remedy is a re-crawl, not a re-run. Three of the rules, `title.same-as-h1`,
`h2.missing` and `social.og-duplicate`, read columns every crawl has, so they judge
old crawls too. On the Phase 25 gate crawl (602 pages, all written before the change)
the marker fired with `pagesNotRecorded` 602 and only those three added findings. By
check:

- **CHECK-04, directives:** `directives.bot-conflict` (a `googlebot`-style robots meta
  that contradicts the generic one: `stricter` when it says noindex or nofollow the
  generic one does not, `overridden` when it permits what the generic one restricts,
  which has no effect because engines obey the most restrictive; `none` counts as
  both noindex and nofollow). On a
  re-crawled page the generic robots value now joins every `<meta name="robots">`, so a
  `noindex` in a second robots meta makes the page non-indexable for every rule.
- **CHECK-10, redirects:** `redirect.meta-refresh`, a meta refresh or `Refresh` header
  that names a URL. A refresh that only reloads the page does not fire.
- **CHECK-18, CHECK-04 and CHECK-24, head integrity:** `html.head-closed-early`
  (warning). An element or text the head does not allow ended it, and head tags
  followed. The Closing Element column names it and Head Tags Lost lists the tags it
  pushed into the body; a tag-manager `<noscript><iframe>` in the head is the usual
  cause. `html.head-closed-early-harmless` (info) is the same early close with no head
  tag after it, so nothing is lost today: typically a tracking pixel's
  `<noscript><img>` last in the head. It is not a FAIL; record it as a risk for tags
  added later. `head.directives-outside-head` and `head.tags-outside-head` gain
  `headClosedEarly`, the element that pushed the tags out, when the early close lost
  tags.
- **CHECK-88, document structure:** `html.structure-invalid` (info). Problems that are
  only head-missing and body-missing mean the page leaves out the `<head>` and `<body>`
  tags, which HTML allows. That page is valid and not broken: record it as PASS with a
  recommendation to write explicit tags. A repeated or misplaced tag is a FAIL.
- **CHECK-22, pagination:** `pagination.multiple`, more than one rel=next or rel=prev.
- **CHECK-25, hreflang:** `hreflang.html-lang-mismatch` compares the primary language
  only (`en-US` and `en-gb` agree, `de` and `en` do not), and never `x-default`.
- **CHECK-34, links:** `links.uncrawlable`: a link with no href but an onclick or a link
  role, a `javascript:` href, or a bare `#` href. A named anchor (`<a name="top">`) and
  an in-page `#section` link are not counted.
- **CHECK-86, link hygiene:** `links.empty-href`, `links.unsafe-target-blank` (a
  new-tab link to another origin, a subdomain or `www.` variant included, without
  `noopener`; same-origin links are not counted), `links.no-anchor-text` (warning:
  internal links that nothing names, with no anchor text, no image alt, no
  `aria-label` and no wider name) and `links.aria-label-only` (info: internal links
  named only by attributes, an `aria-label` or a wider name (`aria-labelledby` as its
  ids, a label inside the link, an icon's `<svg><title>`, a `title`), listed with
  their source in `names`; search engines do not read these as anchor text; often
  fine for icon links such as cart, wishlist or account).
- **CHECK-35, CHECK-36 and CHECK-37, on-page:** `title.multiple`,
  `meta-description.multiple`, `title.same-as-h1`, `h2.missing`, `h2.too-long` and
  `h2.duplicate`.
- **CHECK-49, images:** `images.empty-alt` and `images.alt-too-long` (over 100
  characters, counted when the page is crawled, so a re-run cannot change it).
  `images.missing-alt` gains a sample of image addresses on a re-crawled page.
- **CHECK-85, insecure forms:** `security.form-insecure`, a form on an `http:` page or
  one that posts to `http:`. `security.mixed-content` now also counts `http:` iframes
  and media (its `byKind` evidence).
- **CHECK-87, social sharing tags:** `social.og-incomplete`, `social.x-incomplete`,
  `social.og-multiple`, `social.og-url-mismatch`, `social.og-duplicate` and
  `social.image-broken`. A share image is not loaded by the page, so it never counts
  toward page weight, mixed content or `resources.broken`. On a `fetchResources: false`
  crawl `social.image-broken` judges only relative or malformed image addresses, and
  `resources.not-fetched` says the images' status was not asked.

**Six rules joined at ruleset 0.22.0, and five of them need a crawl from Phase 26c
on** (the sixth, the marker `hreflang.declarations-incomplete`, reads part of its
answer on any crawl; see CHECK-24 below). The crawler now records extraction version 3 (over-long addresses, the
og:image:secure_url tag, a link's wider name, hreflang from the HTTP `Link` header)
and every sitemap listing and `xhtml:link` alternate. On an older crawl, a 26b crawl
included, `extraction.not-recorded` fires with `requiredVersion: 3` and
`sitemapFactsRecorded`, and every check it claims (CHECK-08 and CHECK-28 among them
now) is NOT MEASURED, never a PASS. The remedy is a re-crawl. By check:

- **CHECK-08, sitemap structure:** `sitemap.oversized` (warning) is a sitemap over the
  protocol's 50 MB uncompressed. The URLs read before the limit are kept and crawled,
  but search engines reject the whole file, so the fix is to split it.
  `sitemap.url-in-multiple` (info) is a URL listed in more than one sitemap document
  (a repeat inside one document does not count). It is crawled once; the finding is
  the redundancy, usually two generators, so report it once with the documents it
  names. `sitemap.structure` now carries `totalMemberships` beside `totalUrls`, and
  `docCountsExact`, `membershipLimited`, `hreflangLimited`, `overlongLocsSkipped` and
  `alternatesCapped` (sitemap alternates past 200 in one `<url>`, read and not
  recorded). If any cap is `true`, or `alternatesCapped` is above zero, say the
  sitemap counts (or its hreflang) are a floor.
- **CHECK-24, hreflang:** every hreflang rule now reads three sources, the page's
  HTML, its `Link` header and its sitemap entry's alternates, and judges what they say
  together, the way search engines do. Each finding that lists a declaration names
  its `sources`, so you can tell the client which file to fix.
  `hreflang.source-conflict` (warning) is one language code with different targets in
  two sources: the HTML says `de` is `/de/`, the sitemap says `/de-de/`. A code one
  source lists and another omits is not a conflict, because search engines union the
  sources; such codes are listed in `onlyIn` for context. `hreflang.multiple-entries`
  is now one code with several targets inside ONE source, so the two rules never
  report one defect twice. Only a declaring page that served HTML with a 200 is
  judged. A `Link` header on a PDF (or any non-HTML file) is recorded and counts
  as that file's return link when an HTML page names it, but the file's own
  declarations are never judged: a missing self-reference, an invalid code or a
  source conflict on a PDF produces no finding. Check those by hand if the site
  annotates its documents.
  `hreflang.declarations-incomplete` (info) is a NOT MEASURED marker: some hreflang
  was not read in full. Read its evidence (`reason` says which triggers fired)
  before writing any reciprocity verdict. If
  `hreflangLimited`, `entryLimited`, `docLimited`, `depthLimited`, `timeLimited` (the
  walk ran out of its 10 minutes) or `interrupted` (a resumed crawl was stopped or
  failed while re-reading its sitemaps) is `true`, or
  `sitemapDocsOversized` is above zero, the sitemap walk was cut short and
  `hreflang.missing-return-link`, `hreflang.missing-self-reference`,
  `hreflang.missing-x-default` and `hreflang.self-only` did not run: those parts of
  CHECK-24 and CHECK-25 are NOT MEASURED, never a PASS. If only `sitemapDocsFailed`
  or `alternatesCapped` is above zero, the rules ran but a sitemap could not be
  read (`sitemap.invalid` names it) or a sitemap entry listed more than 200
  alternates, so confirm a sample of missing return links against the live sitemap.
  `possiblyCappedPages` counts pages whose alternates in one source may have filled
  the 200 kept (over-long targets and sitemap duplicates take a place too), which
  those rules do not judge for an absence; check one by hand.
- **CHECK-28, URL length:** `url.reference-too-long` (warning) is a page carrying a
  link, file or hreflang target whose address is over 2,500 characters. The crawler
  cannot index such an address, so it counts it on the page and stores it nowhere:
  it is in no link, resource or hreflang listing, and the finding's counts are the
  only trace. A sitemap `<loc>` that long is counted by `sitemap.url-too-long` as one
  site finding with `skipped`, which also counts sitemap alternate targets that long
  and listings whose URL and sitemap URL together are over 2,500 characters.
- **CHECK-87, social sharing tags:** `social.image-insecure` (info) is an `https:`
  page whose `og:image` is `http:` with no `https:` og:image:secure_url. No browser
  loads a share image, so it is not mixed content: a platform that insists on https
  may drop the preview. `social.image-broken` gains the problem `too-long`.
- **CHECK-86, link hygiene:** `links.no-anchor-text` and `links.aria-label-only` read
  a link's wider name (above), so they too need a 26c crawl.

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
    "checksTotal": 83
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
          "value": { "docs": 6, "totalUrls": 4102, "totalMemberships": 4102, "urlCapBreaches": 0, "entryCapReached": false, "oversizedDocsSkipped": 0, "docCountsExact": true, "membershipLimited": false, "hreflangLimited": false, "overlongLocsSkipped": 0, "alternatesCapped": 0 }
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
  entry is indistinguishable from a check nobody ran. **83 entries** as the checklist
  stands (Phase 11 added CHECK-83) — and the authority is the checklist's own `###`
  headings, not this sentence: count them rather than trusting a number in a document
  the file it describes can outgrow.
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
  `cancelled` (give `neverFetched`; a null there means the crawl never ran, and such a
  crawl has no findings file), a list crawl (give `listUrlCount` and name the
  `crawl.list-mode` gaps), and the scope patterns with the `excluded` count and
  `excludedDropped`. Empty array when there are none — never absent.
- **`coverage`** counts the verdicts. It must sum to `checklist.checksTotal`.

### Before you hand it over

- Every check present, every `notes` written for the verdicts that need one.
- No verdict resting on an empty listing without a `rulesRunAt` timestamp behind it.
- No engine-claimed check whose verdict came from a browser instead.
- The counts in `coverage` add up.

Then say, in the conversation: the crawl's shape, the top few problems in plain
language, and where the findings file is. The report skill takes it from there;
the action-plan workbook exists only on request (see its own status paragraph).

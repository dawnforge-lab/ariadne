<!--
PROVENANCE — this file was imported, not authored here.

  Source        ~/.claude/skills/sf-audit/checklist.md
  Source sha256 7a4ca768166d9566cec4827812aaae4045e862e855c9329f54eea611b04f17e8
  Imported      2026-08-27 (Ariadne Phase 6, P6-T4)
  Origin        internal: the checklist is the owner's own work, carried into the
                repository it now belongs to. Not a third-party lift, so it has no
                entry in THIRD_PARTY_NOTICES.md.

WHAT CHANGED AT IMPORT — only where a check's "how" changed owner:

  1. Every `- **CLI**:` line (a Screaming Frog export command) became a
     `- **Engine**:` line naming the Ariadne tool call and the rule or metric ids
     that answer the check. Where the engine answers a check outright, its
     `**Requires**` tag says `Engine`.
  2. CHECK-01, CHECK-02 and CHECK-34 lost their JS-disabled DevTools recipes:
     the render pass answers them now, and the agent quotes `issues_list` /
     `metrics_get` instead of re-running the experiment in a browser.
  3. The tooling preamble (Execution Tiers, How to Use, Browser Tools), the
     Master Export Command and the Crawl Configuration Requirements were
     rewritten for the engine — SF's three CLI calls and its GUI settings are
     `crawl_start` fields and `export_crawl` datasets now.
  4. Two evaluation principles were re-pointed at engine output, and a fourth was
     added: never re-judge a claimed check by eyeball.

WHAT CHANGED AFTER IMPORT (the living authority's own change log):

  Phase 23 (ruleset 0.18.0, 2026-10-21) — engine paragraphs only; no check's id,
  title, priority, Evaluate criteria or Record list moved.
  - CHECK-12: five rules instead of two (`http.no-response`,
    `http.no-response-transient`, `page.html-too-large` join the 5xx pair).
  - CHECK-03: `robots.blocks-internal-urls`, the `robotsBlocked` status block and
    its `maxBlockedUrls` budget.
  - CHECK-05: `crawl.unreadable-encoding` marker.
  - CHECK-28: `url.too-long` filed here (the checklist has no URL-length check).
  - CHECK-35 / 36 / 37: title floor 30, meta description ceiling 155,
    `headings.h1-too-long`, rel=prev pages left out of the three duplicate rules.
  - CHECK-04 / 18 / 24 / 35 / 36: `head.directives-outside-head` and
    `head.tags-outside-head`. CHECK-04 / 18 / 24 also gain `html.head-closed-early`.
  - CHECK-01: the five `render.*-changed` rules, each also claiming its element's
    check.

WHAT DID NOT CHANGE, and must not: every CHECK id, every check's title, priority,
`**Evaluate**` criteria and `**Record**` list. The rule registry's `checkIds`
trace to the ids in this file and CI asserts the coverage.

THE SOURCE IS FROZEN. This was a one-time import, not a sync target: this file is
the living authority (CLAUDE.md hard rule 10). Fix a check HERE; never edit the
source and re-import.
-->

# SEO & GEO Audit Checklist — Agent Instructions

Master checklist for running a technical SEO & GEO audit. Each item has:
- **Engine**: the Ariadne tool call(s) that answer the check, and the rule or metric ids behind them
- **DevTools**: browser checks — JS execution, network, console, Lighthouse, DOM extraction
- **Visual**: browser checks — visual page assessment, layout, UX, content quality
- **GSC / GA4 / Ahrefs MCP**: analytics and authority queries
- **Evaluate**: Pass/Fail criteria and what to record
- **Requires**: Data sources needed (see Execution Tiers below)

The engine produces facts — findings, measured metrics, crawled pages — and no
judgement at all. The verdict on a check, its severity in this site's context and
the narrative around it are the agent's, and they are built by quoting engine
output rather than by re-deriving it.

## Execution Tiers — CRITICAL RULES

The **Requires** tag on each check lists data sources. These have strict execution expectations:

| Tier | Source | Expectation |
|------|--------|-------------|
| **Always execute** | Engine | Call the tool named in the check and quote what it answers |
| **Always execute** | DevTools | Run the JS in a browser on the pages the check names |
| **Always execute** | Visual | Navigate pages, take screenshots, assess visually |
| **Always execute** | GSC | Query via GSC MCP server |
| **Always execute** | GA4 | Query via GA4 MCP server |
| **Always execute** | Ahrefs MCP | Query via the Ahrefs MCP server |
| **Flag for human** | Manual | Only after completing ALL automatable steps above |

An **Engine** check is not a check you may skip because a browser was easier to
reach: the engine has already crawled the whole site, and a browser has seen one
page. The engine's answer is the site-wide one.

### Gate Rule

**You MUST attempt all DevTools and Visual steps defined in the checklist for a check
BEFORE marking anything as MANUAL.** The "Manual" tag means the *final subjective
verdict* may need human review — it does NOT mean you skip the automatable parts.

For example, CHECK-41 (E-E-A-T) requires `Visual + DevTools + Manual`:
- You MUST navigate to the About page, blog articles, and content pages (Visual)
- You MUST extract internal links and topic clustering data (DevTools)
- You MUST record concrete observations about what you found
- Only the final "is this E-E-A-T sufficient?" judgment is flagged for human review

### Status Definitions

| Status | Meaning |
|--------|---------|
| **PASS** | Check passed based on data and criteria |
| **FAIL** | Check failed — issue found with evidence |
| **WARN** | Potential issue — needs attention but not critical |
| **N/A** | Check not applicable to this site |
| **SKIP** | Tool not available or data not accessible (e.g., the Ahrefs MCP server is not connected) |
| **MANUAL** | Claude completed all automatable steps and recorded findings. Only the final subjective assessment needs human review. Must include what was found. |

**MANUAL is NOT the same as SKIP.** MANUAL means you did the work and recorded findings.
SKIP means you couldn't do the work. Never use MANUAL as an excuse to skip DevTools/Visual steps.

**How these land in the findings file.** The audit writes one machine-readable
record per check (see `SKILL.md`, Phase 4), whose `verdict` field carries four
values, so the six statuses above map onto them without losing anything:

| Status here | `verdict` | `severity` |
|-------------|-----------|------------|
| PASS | `PASS` | `null` |
| FAIL | `FAIL` | `critical` or `warning` — the engine's severity for the rule, or yours in context |
| WARN | `FAIL` | `warning` or `info` |
| N/A | `SKIP` | `null`, with `notes` saying why the check does not apply |
| SKIP | `SKIP` | `null`, with `notes` naming what was unavailable |
| MANUAL | `AGENT` | your severity, with `notes` carrying what you found |

## Evaluation Principles — NON-NEGOTIABLE

These apply to every check, every time. They are not overridden by CMS defaults, common
patterns, or assumptions about client intent.

### 1. Never assume intent. Evaluate on SEO merit only.
A configuration is not correct because it looks deliberate. A configuration is not correct
because it is a common Shopify/WordPress/Magento default. Ask one question only:
**Does this help or hurt organic performance?**

Examples of assumptions that are WRONG:
- "Blog index pages are noindexed — this is a common Shopify pattern, so it's probably fine" → WRONG
- "These pages are canonicalised — probably intentional" → WRONG
- "GA tracking parameters on internal links — likely set up by their marketing team" → WRONG

The correct approach: state what you found, state the SEO impact, state the fix. Do not
qualify findings with "this may be intentional" or "confirm with the client". If it has
a negative SEO impact, it is a finding regardless of intent.

### 2. Never answer a check from a crawl summary. Use the source the check names.
`crawl_status` reports how big the crawl was — pages crawled, frontier counts, whether
the render pass ran. Those numbers describe the crawl, not the site's SEO, and they are
filtered differently from every per-check query. A check names its own tool call and its
own filter; use that one.

Example: `crawl_status.pagesCrawled` is every URL the crawler fetched, including the
non-indexable, the redirects and the 404s. `pages_query` with `indexable: true` is a
different, smaller number. CHECK-31's depth distribution is a third. All three are
correct and only one answers each check.

### 3. Check what URLs actually are before drawing conclusions.
URL type detection on path segments alone causes false positives. Always check:
- Does `/cdn/shop/products/image.jpg` mean a product page? No — it is a CDN asset.
- Does `/collections/dresses/products/slug` mean a unique product? No — it is a
  Shopify collection-scoped duplicate of `/products/slug`.
- Does a large orphan count mean missing products? Maybe — but classify URL types
  first before reporting. The engine's own `pageType` cohorts (visible on
  `pages_query`, and the `scopeValue` of every page-type-scoped metric) are the
  crawl's template detection, not a path guess — prefer them, and say so when a
  cohort you care about lands in `(untyped)`.

### 4. Never re-judge a claimed check by eyeball.
If a check's **Engine** line names a rule or a metric, the engine has already
looked at every page on the site for it. Quote what it answers — the counts, the
sample URLs, the metric's value — and reach a verdict from that. Do not open one
page in a browser and grade the check on what that page showed: one page is not a
site, and a hand check that disagrees with the engine is a bug report about the
rule, not a finding about the client.

The inverse is equally binding. An empty listing from a crawl nobody judged is
NOT a clean site: `issues_list` and `metrics_get` answer `{"items": []}` both when
a rule found nothing and when `crawl_rules` never ran. **`crawl_status` settles
which, and one poll is the whole proof**: `rulesRunAt` is the timestamp of the last
COMPLETED rules pass (null means no complete pass is on record) and `findingsCount`
is how many findings that crawl holds. Read them as a pair — a timestamp with
`findingsCount: 0` is "looked, found nothing"; a null with any count is a pass that
died part-way; null with zero is "nobody has looked". Note that `rulesetVersion` is
NOT that proof: it is stamped when the crawl is accepted, not when it is judged.

So a crawl somebody else judged is as auditable as one you judged yourself, and you
do not re-run `crawl_rules` to prove a marker that is already on the row. Run it when
`rulesRunAt` is null, or deliberately to re-judge with a newer ruleset; its
`{pagesScanned, findings, byRule, byMetric}` summary is then the per-rule breakdown
of what that pass wrote, and it is worth keeping — but it is a breakdown, not the
evidence that a pass happened.

## Analytics Tools (MCP Servers)

Three MCP servers provide live API access to analytics and authority data. They are the
operator's to configure; the audit does not install them. If one is missing, say so and
mark its checks SKIP with the server named — never quietly substitute a guess.

1. **GSC MCP** (`gsc` server — 20 tools)
   - Search analytics: queries, pages, clicks, impressions, CTR, position
   - URL inspection: indexing status, crawl info, rich results
   - Sitemaps: submission status, coverage
   - Compare periods for trend analysis
   - Filter by country, device, search type, query, page

2. **GA4 MCP** (`ga4` server — 7 tools)
   - `run_report`: full GA4 reporting with dimensions, metrics, filters, pagination
   - `run_realtime_report`: live traffic data
   - `get_account_summaries`: list all properties to find the right one
   - `get_property_details`: property configuration
   - Use `sessionDefaultChannelGroup` dimension to segment by organic source
   - Use `sessionSource` / `sessionMedium` for granular source breakdown

3. **Ahrefs MCP** (namespace `mcp__a0369373-5739-4331-b4c9-ddad7f6442c0` — many tools)
   - Site Explorer: domain rating, referring domains, backlink stats, broken backlinks, anchor text
   - Brand Radar: AI citations, cited pages, share of voice, impressions, mentions
   - If this server is not connected, mark CHECK-79, CHECK-80, and CHECK-81 as SKIP

**Important**: At the start of the audit, use `list_properties` (GSC) and
`get_account_summaries` (GA4) to identify the correct property IDs for the domain
being audited. Store these for use throughout the checks.

## Browser Tools

The engine has no browser of its own except the render pass, which re-fetches a
budgeted sample of pages and stores what JavaScript added. Everything a browser is
still needed for — Lighthouse and Core Web Vitals, console and network errors,
mobile viewport behaviour, the look of a page, and the judgement checks — is the
agent's, and it needs a real browser driven by whichever browser MCP server the
operator has connected.

What a browser check needs from that server:

- navigate to a URL
- execute JavaScript on the loaded page (DOM extraction, schema parsing, link counting)
- read the page's text
- take a screenshot
- resize the viewport (mobile checks)

**Before the first browser check**, confirm the server answers. If it does not:

1. Do NOT mark the browser checks SKIP yet, and do NOT substitute a plain HTTP
   fetch for a check that needs a rendered page — a fetch has no JavaScript, no
   console and no layout, and a check answered from one is answered wrongly.
2. Tell the user which server is missing and what it blocks (name the checks).
3. Wait. If the user says to continue without it, mark exactly those checks SKIP
   with `notes` naming the missing tool.

Checks marked **DevTools** mean "execute the JavaScript below on the pages named,
in a real browser". Checks marked **Visual** mean "navigate, screenshot, and
assess what a person would see".

## How to Use

1. Crawl the site (see the `ariadne-crawl` skill), run the render pass, then run the rules
2. **Answer CHECK-83 first** — what the crawl covered, and what it could not. Every
   verdict below is a verdict about the evidence that check describes
3. Walk the checks below in order; for each **Engine** line, call the tool it names and quote the answer
4. Run the DevTools checks in a browser for what the crawl cannot see
5. Run the Visual checks for UX and content quality assessment
6. Record a verdict + evidence for every check, including the ones that passed
7. Output: the findings file (`SKILL.md`, Phase 4), which the report and action-plan skills read

---

## Engine Coverage

One check, and it is answered **before anything that reads a finding or a metric**
— which is what "How to Use" step 2 says and where the order actually binds. It is
not about the site: it is about the evidence every other check is about to be
answered from, and its verdict is the confidence interval around all of them.

### CHECK-83: Engine coverage and evidence completeness
- **Priority**: Critical | **Requires**: Engine
- **Engine**: `crawl_status` for the crawl you are auditing, read in full, plus
  `issues_list` for the NOT MEASURED markers. Six questions, in this order:
  1. **Did the crawl finish, or stop?** `status` is `finished`, `cancelled` or
     `failed`; `frontier.pending` and `frontier.leased` above zero on a closed crawl
     mean URLs were left unfetched. A crawl that hit `maxPages` finishes with a
     drained budget rather than a drained frontier, and `links.orphan-skipped`
     (CHECK-32) is the finding that fires when it did. `blockedPages` beside
     `hostSpacingMs` is the politeness pair: blocks with the spacing settled is a
     crawl that found the site's rate, blocks still rising is a crawl that did not
     see the whole site.
  2. **Did the rules run, and when?** `rulesRunAt` is the only answer — null means
     no complete pass is on record, and every empty listing below it is "nobody
     looked" rather than "nothing found". `rulesetVersion` on the crawl row is the
     ruleset at CRAWL time and is NOT necessarily the one that judged it; the
     judging version is stamped on the findings and reported by `crawl_compare`.
     `findingsCount` and `pagesScanned` are the pair every "N findings over M pages"
     sentence in the report is built from.
  3. **What was cut?** `findingCap` is what each listing rule was allowed to report:
     200 when nobody chose, `null` for a billed audit. Under a cap, `issues_list`
     groups carry `truncated` with `total` or `atLeast`, and a count is a floor
     rather than a magnitude. Quote the note, never the bare count.
  4. **How much was rendered?** `renderPassCount` ≥ 1 means a render pass happened;
     0 means only that the last pass rendered nothing, which a crawl nobody rendered
     also reports. `metrics_get` with `metricId: "render.coverage"` is the real
     coverage — `renderPassEvidence` says whether a pass ran at all, and the
     selection numbers say how the pages were chosen and how many seats the budget
     bought. On `renderPassEvidence: "none"` those numbers are what a pass WOULD
     choose, not what one chose. On `"failed"` the LAST render pass could not
     start: `renderLaunchError` says why, the pages it selected are still pending,
     and a later render pass retries them. Rows an earlier pass rendered
     (`pagesRendered` or `renderFailures` above 0) are still that pass's evidence
     and its findings stand; NOT MEASURED applies only to what no pass rendered,
     and to the whole check only when both counts are 0. `failed` is not
     "rendered" and not "no render needed". Every check that reads rendered evidence (CHECK-01, CHECK-02, CHECK-34,
     the JS half of CHECK-10) is answered over that sample and no further.
  5. **How much of the site's own weight was measured?** `crawl_status`'s
     `resources` block: `seen` is the distinct files the served HTML points at,
     `fetched` the files a server answered about, `failed` the ones it could not
     answer for, and `skipped` the ones nobody asked about at all —
     `fetched + failed + skipped = seen`, always. `fetchResources` says whether the
     crawl asked in the first place: `false` is an operator's decision and makes
     every resource check NOT MEASURED rather than clean. `capped: true` means a
     resource budget stopped the pass short — those budgets are per RUN, not per
     crawl, so a resumed crawl can weigh more files in total than
     `maxResources`. `robotsDenied` and
     `robotsUnreachable` are two subsets of `failed` and are served as two counts:
     `robotsDenied` is "they said no" (the host's robots.txt was read and forbids
     us) and `robotsUnreachable` is "we could not ask" (the host answered 5xx,
     timed out or failed at the network — a complete disallow all the same). Read
     the second as a fact about our evidence, usually a third party's CDN briefly
     down, not as the client's misconfiguration. Each row's `fetchReason` (the
     `resources` CSV view) names the host and the reason. **A crawl run before the
     two were split reports every robots refusal in `robotsDenied`.**
     `resourceRefsCappedPages` sits outside the block and counts PAGES, not files:
     how many pages carried more resource REFERENCES than the analyzer's cap keeps
     (2,000 per page). Non-zero means `seen` **may be** a floor on that many pages
     and those resource checks may be answered over a sample of their references —
     see the cap bullet below for why "may". **`null` means nobody counted** (a
     crawl older than the counter, or one whose process died before its first
     close), which is not `0`.
  6. **Was the 5xx evidence re-verified?** `crawl_status`'s `recheck` block. Every
     page whose first fetch was a server error is counted once there, as
     `serverErrors`, and four numbers partition that total: `confirmed` (looked
     at again, still a server error), `cleared` (looked at again, the site
     answered something else — these are the pages carrying
     `http.server-error-transient` (warning)),
     `inconclusive` (looked at again, no answer about the page: a timeout, a
     network failure, a bot block, or a request our own policy or the site's
     robots.txt refused) and `pending` (never looked at a second time). `capped`
     is true when a budget stopped the pass, and the rows it never reached are
     part of `pending`. `passAt` is the time a COMPLETE pass finished
     over this crawl; null there means no complete pass is on record and every
     server error in this crawl rests on a single observation. **A pending or
     capped row does not make CHECK-12 NOT MEASURED**: the error WAS observed and
     `http.server-error` (critical) is still the verdict — what is unknown is
     whether it persists, and that is the sentence the report owes the client.
- **The markers are part of this check, not a footnote.** `issues_list` with no
  filter, scanned for the NOT MEASURED family: `content.thin-skipped`,
  `h1.duplicate-skipped`, `links.orphan-skipped`, `robots.check-skipped`,
  `host.probe-skipped`, `resources.not-recorded`, `resources.not-fetched`,
  `resources.all-unknown`, `resources.partial-unknown`,
  `hreflang.alternates-not-crawled`, `content.near-duplicate-skipped`,
  `security.headers-not-recorded`, `extraction.not-recorded`,
  and the per-page `crawl.blocked` and `crawl.unreadable-encoding`. Each one
  is the engine saying a check below could not be answered on this crawl. The four
  resource markers are siblings and never more than one appears: `resources.not-recorded` means
  the crawl holds NO resource records, `resources.not-fetched` means it recorded them
  all and asked the site about none of them, `resources.all-unknown` means it
  asked about (or tried to reach) every file and every one landed in an unknown class
  — refused by our own policy, disallowed by a robots.txt, its host's robots.txt
  unreachable, or a request that never completed — and `resources.partial-unknown`
  means the pass reached only SOME of the files, got an unknown from every one it
  reached, and never asked about the rest, with no file coming back usable or broken.
  The third and fourth cases used to fall in a gap no marker covered — rows were
  decided (in whole or in part), so neither of the first two fired, and the resource
  rules were silent regardless; `resources.all-unknown` (P13-T2) and
  `resources.partial-unknown` (P14-T1) are the markers that now fire there, and
  `crawl_status.resources` is still the discriminator they put a name to — `fetched`
  at zero with `failed` carrying the census (`skipped` non-zero as well, for the
  partial case). List them
  here, and mark the checks they claim SKIP rather than PASS when you reach them.
- **Evaluate**:
  - FAIL if `rulesRunAt` is null — nothing below this line is answerable, and the
    audit stops until the rules have run
  - FAIL if the crawl is `cancelled` or `failed`, or left URLs unfetched: the site
    was not seen whole, and every "% of pages" figure is a floor
  - WARN if the run was capped (`findingCap` set and any group `truncated`), if
    `blockedPages` is non-zero, if `renderPassCount` is 0, or if resource coverage
    is partial (`fetchResources: false`, `capped: true`, or `skipped` above zero)
  - PASS only on a finished crawl, judged, uncapped or with no truncation note, with
    a render pass and a complete resource census
  - Record: crawl id, `status`, `rulesRunAt`, `rulesetVersion`, `findingsCount`,
    `pagesScanned`, `findingCap` and which rules were truncated, `renderPassCount`
    and the `render.coverage` numbers, the whole `resources` block with
    `fetchResources` beside it, and every NOT MEASURED marker that fired
- **The 2,000-reference cap, now counted rather than silent**: the analyzer records
  at most 2,000 resource REFERENCES per page and turns the rest away. That used to be
  invisible; `crawl_status.resourceRefsCappedPages` is the count of the crawl's pages
  it happened to. **Read the number precisely — it counts references turned away, not
  files lost.** Past the cap the analyzer stops resolving, so it cannot tell a new URL
  from a repeat of one it already holds: a page whose 2,001st reference duplicates its
  first is counted and lost nothing. So non-zero means the resource evidence **may be**
  a floor on that many pages, and the honest sentence for a report is "some of these
  pages point at files this crawl did not record", never "N pages are missing files".
  WHICH pages, and whether any file was really lost, are both NOT MEASURED: no surface
  answers either, because deriving them costs a scan of every reference the crawl
  holds. **`null` is not `0`** — a crawl older than the counter, or one whose process
  died before its first close, has no answer at all, and a report that prints "0 pages
  truncated" for it is stating a measurement nobody took.
- **`site.health` is filed here** (`metrics_get` with `metricId: "site.health"`):
  the partition of the crawl's auditable pages by the worst severity each carries,
  plus the pages the census leaves out. It is a rollup of the audit's own findings —
  a statement about how far the judgement reached, which is this check's subject
  (it also carries `urlsPaginated`: judged rel=prev pages left out of the three
  duplicate rules only, which is NOT part of the partition) —
  and Evaluation Principle 2 still applies: it is context for the coverage answer
  and never the verdict on any check below.

---

## Pre-Crawl Checks

These three were browser experiments run before the crawl, because nothing else
could answer them. **The engine's render pass answers them now**: it re-fetches a
budgeted sample of the crawl's pages in a real browser and stores what JavaScript
added, and three rules compare the two sides across the whole sample rather than
across the two pages a person had time to open.

They are therefore run AFTER the crawl, like every other engine check — and their
answers still inform crawl configuration, for the next crawl of this site (a site
that fails CHECK-01 needs a larger `renderBudgetPct`, and its link graph should be
read as provisional).

Their evidence exists only if the render pass ran. Confirm `crawl_status`
reports `renderPassCount` ≥ 1 before reading any of the three; if it is 0, these
checks are SKIP with `notes: "no render pass"`, not PASS.

### CHECK-01: Website rendering with JS disabled
- **Priority**: Critical | **Requires**: Engine (render pass)
- **Important**: Even if the site uses SSR (Server-Side Rendering), the question is what
  a crawler that does not run JavaScript can see. Some crawlers (including Googlebot in
  certain modes) crawl with JS disabled. Content and links must be accessible either way.
- **CRITICAL — the content that only exists after rendering**: the most damaging case on
  an e-commerce site is a collection page whose **product links** are absent from the raw
  HTML. Navigation and headings often pass an SSR eyeball test while the product grid is
  100% client-side, and the site then has no product discoverability without JS.
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-01"` — the rule is `content.csr-dependent`
     (critical). It fires on a rendered page whose rendered word count is at least
     twice its raw word count AND at least 150 words larger, which is the
     "most of what this page says arrived with the JavaScript" claim.

     **BOTH SIDES OF THAT COMPARISON ARE THE SAME INSTRUMENT (ruleset 0.6.0).**
     The rule reads `renderedRenderableWordCount` — the crawl's own analyzer run
     over the post-JavaScript DOM — against `renderableWordCount`, the same
     function over the bytes the server sent. It does NOT read
     `renderedWordCount` (the browser's `innerText`) any more. That change is
     what makes the rule able to fire on a theme carrying CSS-class-hidden
     chrome: the chrome is in both documents, so it lands on both sides of the
     subtraction and cancels. A finding from ruleset 0.5.0 or earlier used the
     older comparison and is not row-comparable with one from 0.6.0.
  2. `issue_urls` with `ruleId: "content.csr-dependent"` for the page list. Each
     row's evidence carries `{rawWordCount, renderableWordCount,
     renderedAnalyzerWordCount, renderedRenderableWordCount, addedWords}` — two
     readings of each document by one instrument, and the difference between the
     renderable pair. Quote these, per page type, in place of the old JS-on/JS-off
     counts. `addedWords` is the words JavaScript put on the page and nothing
     else.
  3. `metrics_get` with `metricId: "render.coverage"` for the denominator: how many
     pages were rendered out of how many crawled, the selection budget, and the
     render failures. A finding count means nothing without it. **Read
     `renderPassEvidence` first**: `none` means no render pass has left a trace on
     this crawl, so the selection numbers beside it describe a pass that WOULD run
     and CHECK-01 is NOT MEASURED rather than clean — say that instead of quoting
     them. `failed` means the LAST render pass could not start: report
     `renderLaunchError` and note its selected pages are still pending for a later
     pass. Rows an earlier pass rendered (`pagesRendered` or `renderFailures`
     above 0) remain that pass's evidence and the CHECK-01 findings on them
     stand; only what no pass rendered is NOT MEASURED — and when both counts are
     0, CHECK-01 as a whole is NOT MEASURED. Never read `failed` as "rendered" or
     as "no render needed". Then **read `selectionMode`** — `auto` means the engine sampled and the budget
     numbers describe how; `explicit` means an auditor named the pages, and
     `selectionBudget`, `selectionSuspects`, `selectionSampled` and
     `selectionTruncated` are null rather than zero, because no automatic decision
     was taken. Quoting a null as "no suspects" would be a claim about the site's
     HTML that nothing measured.
  4. `pages_query` with `rendered: true` to see which pages were covered, and which
     page types are represented. If a page type you care about was not covered, say
     so rather than generalising from the ones that were — and on an explicit pass
     say which templates your list stood for, since that is the whole of the
     coverage claim.
  5. The nav side of the same question is CHECK-34 (`nav.js-only`) and the facet
     side is CHECK-02 (`filters.js-only`). Read all three together before you
     conclude anything about crawlability without JS.
  6. **What JavaScript changed in the head and the heading.** Five more CHECK-01
     rules compare the HTML's value with the rendered page's, on rendered pages
     only: `render.noindex-changed` (critical) and `render.canonical-changed`
     (critical) — the directives; `render.title-changed` (warning),
     `render.meta-description-changed` (warning) and `render.h1-changed`
     (warning) — what a result shows. Each row's evidence is `{raw, rendered,
     sampled}`: the two values verbatim and `sampled: true`, because only the
     pages the render pass opened were compared — quote the denominator from
     `render.coverage` (step 3), never "no page changed". Noindex is compared as
     a directive (token order and `none` do not count as a change) and from the
     robots META only, since no script can change an `X-Robots-Tag` header; the
     canonical is compared as the URL it resolves to. A crawl rendered before
     ruleset 0.18.0 (Phase 23) has no rendered robots, description or H1, so
     those three rules are NOT MEASURED on it rather than clean.
- **Evaluate**:
  - Do NOT assume SSR means everything is fine — read the raw-vs-rendered numbers
  - PASS if the render diff found no CSR-dependent pages and no JS-only navigation, across a sample that covered every page type
  - WARN if navigation or key content is JS-dependent on some page types
  - FAIL if a page is essentially blank without JS (critical JS dependency: `addedWords` is most of `renderedRenderableWordCount`)
  - **FAIL if collection pages' product links are absent from raw HTML** — a crawler that does not render will miss most products, and Googlebot's initial crawl pass won't discover product URLs from collection pages. Products become entirely dependent on sitemap.xml for discovery. (Cross-read CHECK-33b: sitemap-only products are the same failure seen from the link graph.)
  - Record: raw vs rendered word counts per page type (from the finding evidence), **the `renderedRenderableWordCount` / `renderableWordCount` RATIO beside `addedWords`** on the rendered pages, **the nav and filter link counts from CHECK-34 and CHECK-02**, render coverage (rendered / crawled, the failures, and `selectionMode` with the templates the pass stood for), recommendation for the next crawl — which templates to name, or a `renderBudgetPct` if the next pass will be automatic
  - **Why the ratio and not only the delta.** Chrome that both documents carry cancels EXACTLY in `addedWords` (the 150-word arm) and does NOT cancel in the ratio arm, which reads `injected >= body + chrome`. So on a chrome-heavy theme the rule is still harder to trip than the thresholds alone suggest, and a zero is only a finding once you have looked at how close the ratio came. Quote it — a site whose rendered/renderable runs 1.6 across the board is a different story from one running 1.02, and only one of them is 'no client-side rendering'.

### CHECK-02: Filters / layered navigation — HTML or JS elements?
- **Priority**: High | **Requires**: Engine (render pass)
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-02"` — the rule is `filters.js-only`
     (warning). It fires on a rendered page whose raw HTML offered the crawler no
     filter, facet or sort link at all while the rendered DOM exposed several.
     The raw side is zero by construction, so the claim is categorical: every URL
     behind those facets is invisible to a crawler that does not run JavaScript.
  2. `issue_urls` with `ruleId: "filters.js-only"` — each row's evidence is
     `{rawFilterLinks: 0, renderedFilterLinks: N}`. Group the URLs by page type to
     see whether this is one template or the whole collection surface.
  3. For the other half of the question — filters that ARE crawlable, and the URL
     volume they create — read CHECK-27 and CHECK-29: `metrics_get` with
     `metricId: "url.param-volumes"` is the parameter census, and it counts what
     the crawl actually reached rather than what a page's controls suggest.
  4. Whether the filtered URLs are handled once they exist (canonical, noindex,
     robots) is CHECK-27, CHECK-29 and CHECK-03; do not answer it here.
- **Evaluate**:
  - PASS if filters are HTML links with proper canonical/noindex handling
  - WARN if filters are JS-only (hidden from crawlers — the facet URLs will not be discovered without rendering)
  - WARN if filters generate many crawlable URL variants (combinatorial explosion risk — inform CHECK-29 and CHECK-31)
  - Record: filter implementation type (HTML links / JS-only / hybrid) per page type, URL pattern generated, estimated URL volume, recommendation for the next crawl's include/exclude posture

---

## 0. Organic Performance Overview

Run this section FIRST — before any technical checks. It establishes the performance
baseline and context that informs priority decisions throughout the rest of the audit.
A site losing 40% organic traffic has very different priorities than one growing steadily.

**Prerequisites**: GSC and GA4 MCP servers must be connected. Use `list_properties` (GSC)
and `get_account_summaries` (GA4) to identify the correct property IDs for the domain.

### CHECK-71: Organic traffic overview — all sources, segmented by performance
- **Priority**: Critical | **Requires**: GA4
- **GA4 MCP**: Run these reports for the property:
  1. **Overall organic**: `run_report` with:
     - Dimensions: `sessionDefaultChannelGroup`
     - Metrics: `sessions`, `totalUsers`, `engagedSessions`, `engagementRate`, `averageSessionDuration`, `screenPageViewsPerSession`, `bounceRate`
     - Date range: last 90 days
     - Filter: `sessionDefaultChannelGroup` == "Organic Search"
  2. **Organic by source**: Same report but add dimension `sessionSource` to break down by Google, Bing, Yahoo, DuckDuckGo, other
  3. **Period comparison**: Run same report for prior 90 days and calculate % change
  4. **Monthly trend**: Run with dimension `yearMonth` + `sessionDefaultChannelGroup` filtered to organic, for last 12 months
- **Evaluate**:
  - Identify traffic direction: growing, stable, declining
  - Flag any source with >20% decline
  - Note which organic sources drive meaningful traffic vs negligible
  - Record: total organic sessions, users, engagement rate per source, trend direction, % change period-over-period

### CHECK-72: Brand vs non-brand performance
- **Priority**: Critical | **Requires**: GSC
- **GSC MCP**: Use `get_search_analytics` with:
  1. **Brand queries**: Filter queries containing brand name (and common misspellings)
     - `get_search_analytics(property, start_date, end_date, dimensions=["query"], row_limit=500)`
     - Post-process: split results into brand (contains brand term) vs non-brand
  2. **Period comparison**: `compare_search_periods` for brand vs non-brand splits
  3. **Brand by page**: `get_advanced_search_analytics` with dimensions `["query", "page"]` filtered to brand queries — which pages capture brand traffic?
- **Evaluate**:
  - Calculate brand vs non-brand ratio (healthy: non-brand > 60%)
  - Flag if brand traffic declining (reputation/awareness issue)
  - Flag if non-brand traffic declining (SEO visibility issue)
  - Identify brand queries going to wrong pages (homepage vs product)
  - Record: brand clicks/impressions/CTR/position, non-brand same, ratio, trend direction for both

### CHECK-73: Top pages by organic performance
- **Priority**: Critical | **Requires**: GSC + GA4
- **GSC MCP**: `get_search_analytics` with:
  - Dimensions: `["page"]`
  - Metrics: clicks, impressions, CTR, position
  - Row limit: 100 (top 100 pages)
  - Date range: last 90 days
- **GA4 MCP**: `run_report` with:
  - Dimensions: `landingPage`, `sessionDefaultChannelGroup`
  - Metrics: `sessions`, `engagementRate`, `conversions` (if available), `averageSessionDuration`
  - Filter: organic channel
- **Cross-reference**: Match GSC top pages with GA4 engagement data
- **Evaluate**:
  - Identify pages with high impressions but low CTR (title/description optimization opportunity)
  - Identify pages with high traffic but low engagement (content quality issue)
  - Identify pages with good engagement but low traffic (promotion/linking opportunity)
  - Flag any top page that has technical issues in the crawl data (4xx, redirect, noindex)
  - Record: top 20 pages table with clicks, impressions, CTR, position, sessions, engagement rate

### CHECK-74: Query landscape & ranking distribution
- **Priority**: High | **Requires**: GSC
- **GSC MCP**: `get_search_analytics` with:
  - Dimensions: `["query"]`
  - Row limit: 500
  - Date range: last 90 days
- **Analysis**:
  1. **Position buckets**: Group queries into 1-3, 4-10, 11-20, 21-50, 51+
  2. **Opportunity queries**: Position 4-20 with high impressions (striking distance)
  3. **Defending queries**: Position 1-3 — are these stable? Use `compare_search_periods`
  4. **Query intent mapping**: Categorise top queries as navigational, informational, transactional, commercial
  5. **Query gaps**: Cross-reference with page types — are there page types with no query coverage?
- **Evaluate**:
  - Healthy distribution: significant queries in positions 1-10
  - Flag if most queries are 20+ (low authority/relevance signals)
  - Identify top 10 striking-distance opportunities (position 4-15, high impressions)
  - Record: distribution table, top 10 opportunities, defending queries, intent breakdown

### CHECK-75: Conversions and events from organic
- **Priority**: High | **Requires**: GA4
- **GA4 MCP**: `run_report` with:
  1. **Conversion overview**:
     - Dimensions: `sessionDefaultChannelGroup`
     - Metrics: `conversions`, `purchaseRevenue` (if ecommerce), `ecommercePurchases`, `addToCarts`
     - Filter: organic channel
     - Date range: last 90 days
  2. **Conversion by landing page** (if conversions exist):
     - Dimensions: `landingPage`, `sessionDefaultChannelGroup`
     - Metrics: `conversions`, `sessions`, `engagementRate`
     - Filter: organic channel
  3. **Key events** (if no conversions configured):
     - Dimensions: `eventName`, `sessionDefaultChannelGroup`
     - Metrics: `eventCount`
     - Filter: organic channel
     - Look for: `purchase`, `add_to_cart`, `begin_checkout`, `sign_up`, `generate_lead`, `form_submit`, `file_download`, `scroll`, `click`
- **Evaluate**:
  - If conversions configured: calculate organic conversion rate vs site average
  - Flag if organic conversion rate is significantly below other channels
  - If no conversions: flag as a tracking gap — recommend setting up key events
  - Identify top converting landing pages — these are priority pages for technical health
  - Record: organic conversions, revenue (if applicable), conversion rate, top converting pages, key events list

### CHECK-76: AI & referral traffic from AI platforms
- **Priority**: High | **Requires**: GA4
- **GA4 MCP**: `run_report` with:
  1. **AI referral sources**:
     - Dimensions: `sessionSource`, `sessionMedium`
     - Metrics: `sessions`, `totalUsers`, `engagementRate`, `averageSessionDuration`, `conversions`
     - Filter: source contains any of: `chatgpt`, `openai`, `perplexity`, `claude`, `anthropic`, `gemini`, `copilot`, `bing` (copilot), `you.com`, `phind`, `kagi`
  2. **AI traffic trend**:
     - Same filter, add dimension `yearMonth`, date range last 6 months
  3. **AI landing pages**:
     - Dimensions: `landingPage`, `sessionSource`
     - Same AI source filter
     - Which pages are AI platforms sending users to?
- **Evaluate**:
  - Baseline: what % of total traffic comes from AI sources?
  - Trend: growing, stable, or nonexistent?
  - Which AI platforms send the most engaged traffic?
  - Which pages attract AI referrals? (these are "AI-visible" pages)
  - Record: AI traffic by source, trend, top landing pages, engagement comparison vs organic search

### CHECK-77: Indexation coverage — GSC vs crawl
- **Priority**: High | **Requires**: GSC + Engine
- **GSC MCP**:
  1. `get_performance_overview` — total indexed pages approximation from impression data
  2. `batch_url_inspection` — inspect 10 sample URLs across page types:
     - Homepage, 2-3 products, 1-2 collections, 1 blog post, 1 info page
     - Check: indexing state, crawl date, canonical, robots
  3. `check_indexing_issues` — if any sample URL shows issues, expand to more URLs
- **Cross-reference with the crawl**:
  - `pages_query` with `indexable: true` for the indexable page count (follow the
    cursors, or `export_crawl` with `dataset: "pages"` and count the rows)
  - Compare: total indexable pages from the crawl vs pages with impressions in GSC
  - Large gap = indexation problem (pages crawled but not indexed)
  - Pages whose indexability the crawl never settled come back `indexable: null` and
    match NEITHER filter — count them separately rather than folding them into either side
- **Evaluate**:
  - FAIL if key page types not indexed
  - WARN if >20% of indexable pages have zero impressions (potential indexation gap)
  - Record: indexed page count (GSC), indexable page count (crawl), gap %, sample URL inspection results

### CHECK-78: Keyword cannibalisation (data-driven)
- **Priority**: High | **Requires**: GSC
- **GSC MCP**: `get_advanced_search_analytics` with:
  - Dimensions: `["query", "page"]`
  - Row limit: 500
  - Date range: last 90 days
- **Analysis**:
  1. Group by query — find queries with 2+ ranking pages
  2. For each cannibalising query: compare CTR and position of competing pages
  3. Flag where the "wrong" page ranks higher (e.g., blog post outranking product page for transactional query)
  4. Check if competing pages have proper canonicals (CHECK-16/CHECK-17 findings)
- **Evaluate**:
  - WARN if >10 cannibalising query groups found
  - FAIL if cannibalisation affects high-volume queries (>100 impressions)
  - Record: cannibalising query count, top 10 by impact (impressions), competing URL pairs, recommended winner

---

## 1. Crawlability & Robots

### CHECK-03: robots.txt — reachable, valid, not over-blocking
- **Priority**: Critical | **Requires**: Engine + DevTools
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-03"`. Four rules can answer:
     - `robots.missing` (info) — the site answered 4xx for /robots.txt. The crawl
       treated that as allow-all, which is correct and is still worth reporting.
     - `robots.blocks-sitemap-urls` (critical) — URLs the site's own sitemap
       publishes and its own robots.txt forbids. `issue_urls` gives the list.
     - `robots.blocks-internal-urls` (warning) — INTERNAL URLs that crawled pages
       link to and the site's own robots.txt forbids. The crawl never requested them
       (the finding is about the link, not a fetch); each row quotes the matching
       robots.txt line, and `issue_inlinks` with
       `ruleId: "robots.blocks-internal-urls"` lists the pages that link to each.
       Read it with `crawl_status`'s `robotsBlocked: {recorded, dropped}`: blocked
       URLs are written down against their own budget (`maxBlockedUrls`, default
       `maxPages`, an engine setting rather than an API input), and a non-zero
       `dropped` counts discoveries turned away after it filled, so the list is
       incomplete and the finding count is a floor. `dropped: null` is a crawl
       from before it was counted, not zero. This is a sibling of
       `robots.blocks-sitemap-urls`, not a duplicate: that rule is about the sitemap
       line, this one about the link, and one URL can raise both.
     - `robots.check-skipped` (info) — the stored robots.txt could not be re-parsed
       (too large to read, or never served). This is a NOT MEASURED marker: the
       robots questions below are unanswered on this crawl, not answered clean.
  2. `issues_list` with `checkId: "CHECK-05"` (`crawl.blocked`) for pages the crawl
     was refused — a robots-shaped block that shows up as a fetch outcome.
  3. **`robots_get` — the file itself, as this crawl read it.** It answers
     `{crawlId, robotsUrl, outcome, raw, truncated, crawlDelaySec, note,
     sitemapSources, suppliedSitemaps, userAgent}`: `raw` is the text the crawl
     obeyed, `outcome` is `read` / `absent` / `unreachable` (and `unreachable` is NOT
     `absent` — a site that could not tell us its rules is a finding, not an
     allow-all), `truncated` means `raw` is only the first 500KB so anything
     concluded about a rule past that point is unsound, `sitemapSources` is the `Sitemap:` lines in declaration order
     (CHECK-06 reads it), `suppliedSitemaps` is the documents the crawl was HANDED at
     start rather than told about by the file — a sitemap listed only there is one the
     site publishes and does not declare, and CHECK-06 still fires — and `userAgent`
     is the UA whose groups actually governed the crawl. **Stored evidence, never
     re-fetched**: quote it rather than the live file, and if you also read the live
     file, report the difference as the fact about the site that it is.
- **The file's contents** (steps 1-4 read `robots_get`'s `raw`; a browser only if the
  crawl never stored one — `outcome: "unreachable"`):
  1. Read `raw` in full. Note `truncated` in the finding if it is set.
  2. Parse: User-agent blocks, Disallow rules, Sitemap lines, Crawl-delay. `robots_get`
     already extracts the last two as `sitemapSources` and `crawlDelaySec` — quote
     those rather than re-deriving them, and read the rest against `userAgent`, since
     a rule in a group the crawler never matched did not apply to it.
  3. Check for AI bot rules: GPTBot, ChatGPT-User, Google-Extended, ClaudeBot, Anthropic-AI, PerplexityBot, CCBot
  4. Flag any Disallow rules blocking important content paths (/collections/, /products/, /blogs/)
- **DevTools** (the part no stored text answers — testing URLs against the rules):
  1. **Pattern gap analysis** (MANDATORY): Don't just read the rules — test specific URL
     patterns against them to find gaps. Construct these test URLs and check each:
     - Single filter: `/collections/{name}?filter.v.size=UK+10` — blocked?
     - Filter + pagination: `/collections/{name}?filter.v.size=UK+10&page=2` — blocked?
     - Pagination only: `/collections/{name}?page=2` — blocked?
     - Single tag: `/blogs/{name}/tagged/{tag}` — blocked?
     - Tag + pagination: `/blogs/{name}/tagged/{tag}?page=2` — blocked?
     - Sort + pagination: `/collections/{name}?sort_by=price&page=2` — blocked?
     Present results as a table showing each test URL pattern and whether it's blocked or passes through.
  2. **Shopify-specific**: The default Shopify robots.txt blocks `*/collections/*filter*&*filter*`
     (two+ filters) but NOT single filter URLs. It blocks `*sort_by*` but doesn't block
     `?page=` pagination. Check if these gaps exist and flag the crawl surface they create.
- **Evaluate**:
  - FAIL if robots.txt returns non-200 — and say which kind, because the two do not
    mean the same thing: `robots_get`'s `outcome` is `absent` for a 4xx (the site says
    there are no rules, and crawling allow-all was correct) and `unreachable` for a
    5xx, a timeout or a refused URL (rules nobody could read)
  - FAIL if key content paths are blocked
  - WARN if no Sitemap: line declared — `sitemapSources` empty
  - WARN if single filter URLs or filter+pagination combinations pass through robots.txt rules
  - Record: blocked paths list, AI bot rules, sitemap declaration, blocked URL count from the engine, **pattern gap analysis table**

### CHECK-04: Meta robots & X-Robots-Tag directives
- **Priority**: Critical | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-04"`. Eight rules:
     - `indexability.noindex` (info) — every page the crawl found excluded from the
       index, whether by meta tag or by header.
     - `indexability.nofollow` (warning) — a page whose meta tag or header says
       `nofollow` or `none`, so engines ignore every link on it.
     - `directives.restrictive` (warning) — `nosnippet`, `max-snippet:0`,
       `max-image-preview:none` or `noimageindex`: the page is indexed but its
       result is stripped of text or images.
     - `directives.unavailable-after` (warning) — an unavailable_after date that
       had passed, falls within 30 days of the crawl, or cannot be parsed. Only
       ISO 8601, the RFC 822 / 850 / 1123 forms and asctime parse, with short or
       full month and day names and the US, UTC/GMT, BST, CET/CEST and EET/EEST zone
       names (`dateParsed: false` otherwise, never a guess); a zone-less ISO
       date-time and an asctime date are read as UTC and the evidence carries
       `assumedUtc: true`, so say the zone was assumed.
     - `indexability.meta-header-conflict` (critical) — a page whose robots meta and
       `X-Robots-Tag` header disagree. That is a directive the site cannot predict
       the outcome of, and it is a finding on its own.
     - `head.directives-outside-head` (critical) — a robots meta (or canonical, or
       hreflang) after the `<head>` ended, where search engines may not read it.
     - `html.head-closed-early` (warning) — names the element or text that ended the
       head early and the head tags after it (Head Tags Lost), so a robots meta among
       them is read as body content.
     - `html.head-closed-early-harmless` (info) — the same early close with no head
       tag after it, so nothing is lost today (typically a tracking pixel's
       `<noscript><img>` last in the head). Not a FAIL: record it as a risk for tags
       added later.
     - `directives.bot-conflict` (warning) — a bot-specific robots meta (`googlebot`,
       `bingbot`, ...) that contradicts the generic `robots` meta (absent means
       index, follow). Engines combine the two and obey the most restrictive, so a
       contradiction is either `stricter` (the bot meta says noindex or nofollow
       where the generic one does not: that engine is kept out) or `overridden`
       (the bot meta permits with `index` / `follow` / `all` what the generic one
       restricts: the permission has no effect). A bot meta that is silent on, or
       repeats, a generic directive is not one. Needs extraction version 2;
       `extraction.not-recorded` marks it NOT MEASURED.
     - `render.noindex-changed` (critical) — a rendered page whose noindex the
       JavaScript added or removed (rendered pages only; see CHECK-01 step 6).
  2. `issue_urls` with `ruleId: "indexability.noindex"` for the FULL list — this is
     the export the check's Record line asks for, one row per URL, each carrying
     `{source: "meta" | "header", robotsMeta, xRobotsTag}`. Follow the cursors: the
     list is the point, and a first page of 50 is not it.
  3. `pages_query` with `indexable: false` to see the same pages beside their type,
     status and depth — which is how you tell a deliberately excluded cart page from
     a noindexed blog index.
  This covers every page type the crawl reached, so there is no sampling to do and
  no browser to open.
- **Important — Don't just count noindexed pages, CHECK WHAT THEY ARE**: A report of
  "6 pages noindex — appropriate" is useless if you haven't verified what those 6 pages
  are. The blog index being noindexed is a critical issue but gets lost in a "6 pages"
  count. For every noindexed page, explicitly state the URL and whether the noindex is
  correct or incorrect.
- **Common Shopify mistakes to check**:
  - Blog index (`/blogs/journal`) noindexed — prevents discovery of articles
  - Paginated blog pages noindexed — prevents discovery of older articles
  - Collection pages with filters noindexed (may be intentional, but verify)
  - Policy pages noindexed (shipping, returns — these have organic value)
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - PASS if noindex/nofollow only on truly intended pages (account, cart, checkout, search internal)
  - **FAIL if blog index or blog paginated pages are noindexed** — this blocks article discovery
  - FAIL if important indexable pages have noindex
  - Record: noindex count, nofollow count, **full list of noindexed URLs with assessment
    of whether each is correct or incorrect**

### CHECK-05: Geo/IP redirects and bot blockers
- **Priority**: Critical | **Requires**: Engine + DevTools + Manual
- **Engine**: `issues_list` with `checkId: "CHECK-05"` — `crawl.blocked` (info)
  reports pages the crawler was refused rather than served (the fetch was classified
  `blocked`; the evidence carries the status code). This is a NOT MEASURED marker,
  not a site issue: it says how this crawl was received, and every check on those
  pages is unanswered on this crawl rather than clean. Whether search engines meet
  the same wall is this check's manual question; `issue_urls` gives the URLs.
  Report it against the user agent the crawl actually used (`robots_get`'s
  `userAgent`) — the claim is "this UA was blocked on these URLs", never "all bots are
  blocked".

  `crawl.unreadable-encoding` (info) is the same kind of NOT MEASURED marker under
  this check: the server answered in a content-encoding the crawler did not request
  and cannot decode (the evidence's `fetchReason` names it), so nothing on those
  pages was checked.

  **The census beside the finding**: `pages_query` with `fetchClass: "blocked"` lists
  every blocked page with its `statusCode` and a `fetchReason` naming how many
  attempts it took and what per-host spacing the engine had escalated to before it
  gave up. That is what separates "the site rate-limited a crawl that went in too
  fast" from "the site refuses this crawler", and only the second is a CHECK-05
  finding. `crawl_status`'s `blockedPages` and `hostSpacingMs` are the same story at
  crawl level — quote them when you report either.
- **DevTools** (geo behaviour, which needs a browser and a location):
  1. Navigate to homepage — note any redirect chain (final URL, status codes)
  2. Navigate to a product page — same check
  3. Check response headers for Vary: Accept-Language or geo-detection headers
  4. If Shopify Markets or multi-regional: test /en/, /es/, /fr/ prefixes directly
- **Evaluate**:
  - PASS if no forced geo-redirects detected
  - WARN if geo-detection headers present
  - Note: Full geo-testing requires VPN/proxy — flag for manual follow-up if geo logic detected
  - Record: redirect behavior, geo-detection headers

---

## 2. Sitemaps

### CHECK-06: Sitemap exists, in robots.txt, valid format
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-06"`. Two rules:
  - `sitemap.missing` (warning) — the crawl found no sitemap to read: robots.txt
    declared none and the conventional locations answered nothing.
  - `sitemap.invalid` (critical) — a declared sitemap document was fetched and could
    not be read as a sitemap (the commonest real case is a 200 that is HTML). It is
    ONE site-scoped finding, so `sampleUrls` is empty and `count` is 1 however many
    documents failed: read it with `issue_urls` on `ruleId: "sitemap.invalid"`, where
    `url` is null and the evidence carries `failures` (up to 50 documents) and
    `failureCount` (the true number).
  The sitemap's shape — index vs flat, how many child documents, how many entries
  each — is CHECK-08's metric; do not re-fetch the file to describe it.

  **The robots.txt half is `robots_get`'s `sitemapSources`**: the `Sitemap:` lines the
  file declared, in declaration order. Empty means the file declared none, which is
  the WARN below — and it is a different fact from "no sitemap exists", which is
  `sitemap.missing`. A site with a sitemap at the conventional location and no
  declaration fails this half and passes the other; say both.

  **`suppliedSitemaps` is how you get to say the second half at all.** The engine
  never probes for an undeclared sitemap, so a crawl that read none has no sitemap
  evidence — every CHECK-07 and CHECK-08 answer below would be a silence about a
  document nobody looked at. When `sitemapSources` is empty and `suppliedSitemaps`
  is empty too, the sitemap questions are NOT MEASURED: find the document (ask the
  owner, the CMS, Search Console) and re-crawl with `crawl_start`'s `sitemapUrls`,
  then judge. Supplying it does not settle this check — robots.txt still declares
  nothing, `sitemap.missing` still fires, and the one-line fix is still the site's.
- **Evaluate**:
  - FAIL if sitemap returns non-200 or robots.txt has no Sitemap: line
  - WARN if flat sitemap with >50k URLs
  - Record: sitemap type, child sitemap count, total URLs, robots.txt Sitemap line status

### CHECK-07: Sitemap contains only indexable 200 URLs
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-07"` — four rules, and each is one
  of the reasons the Record line asks you to break the count down by:
  - `sitemap.non-200` (critical) — a listed URL that did not answer 200
  - `sitemap.redirected` (warning) — a listed URL that redirects
  - `sitemap.non-indexable` (critical) — a listed URL the crawl judged non-indexable:
    it carries a noindex, or it canonicalises to another URL (the evidence's
    `reason` says which, `"noindex"` or `"canonicalised"`; a page that is both is
    reported once, as noindex)
  - `sitemap.uncrawled` (info) — a listed URL this crawl never reached: blocked by
    robots or outside the crawl's budget, off this crawl's origin (another host,
    port, or scheme — never attempted by design; the evidence's `offOrigin` flag
    marks these), or attempted and no response came back. NOT MEASURED, not clean.
  Three more rules read the entry itself, not the page it names:
  - `sitemap.url-too-long` (info) — a `<loc>` over 2,048 characters
  - `sitemap.cross-host-loc` (warning) — a `<loc>` whose scheme or host (www and port
    included) is neither its sitemap document's nor the crawled site's. A document on
    another host (a CDN) that lists the crawled site's own URLs is an allowed
    cross-submission and is not reported
  - `sitemap.lastmod-invalid` (info) — a `<lastmod>` that is not a W3C date or
    date-time (`reason: "format"`), or is dated after the crawl ended, so it was already
    in the future when the sitemap was read (`reason: "future"`; a date-only value on
    the crawl's own UTC day is not future)
  `issue_urls` per rule for the URL lists; `metrics_get` with
  `metricId: "sitemap.structure"` gives `totalUrls` for the denominator.
- **Evaluate**:
  - FAIL if non-indexable URLs > 0
  - WARN if `sitemap.cross-host-loc` (warning) > 0: entries on a host the sitemap may
    not speak for are ignored by search engines
  - INFO if `sitemap.url-too-long` (info) or `sitemap.lastmod-invalid` (info) > 0:
    the entry is malformed but the page is still listed. Do not PASS the check silently
    with either on file; name the count
  - Severity = non-indexable count / total sitemap URLs
  - Record: count, breakdown by reason (noindex, 3xx, 4xx, canonicalised)

### CHECK-08: Sitemap structure (large sites)
- **Priority**: Medium | **Requires**: Engine (metric and rule)
- **Engine**: `metrics_get` with `metricId: "sitemap.structure"` for the shape, and
  `issues_list` with `checkId: "CHECK-08"` for one finding rule:
  `sitemap.over-50k-urls` (warning), one site-scoped finding per sitemap document
  with more than 50,000 entries. Its count is a LOWER BOUND: a URL listed in two
  documents is stored, and counted, once, and the crawl's entry cap can stop reading
  before a document's end. No finding is not proof of a clean sitemap when
  `entryCapReached` is true. The metric's rows:
  - the `site` row: `{docs, totalUrls, urlCapBreaches, entryCapReached, oversizedDocsSkipped}`
  - one `sitemap_doc` row per document (`scopeValue` is the document's URL) with
    `{urls, breaches50k}` — the largest 50 are listed
  - `entryCapReached: true` means every count here is a FLOOR, not a total: say so
    rather than quoting the numbers flat
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the facts this check reads from extraction version 3: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - PASS if sitemaps split logically by type (products, collections, blog, pages)
  - WARN if single flat sitemap on site >5k URLs
  - WARN if `sitemap.over-50k-urls` (warning) > 0: a document over the 50,000-entry limit
    is not read past it. Quote the count as a floor when `entryCapReached` is true
  - Record: sitemap structure description

### CHECK-09: URLs not found in sitemaps
- **Priority**: High | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-09"` — `pages.not-in-sitemap` (info) is
     every indexable page the crawl found that the sitemap does not list.
     `issue_urls` for the list.
  2. `issues_list` with `checkId: "CHECK-32"` for the orphan count (`links.orphan`)
     — the other half of the same picture, and a different question: not in the
     sitemap vs not reachable by a link.
- **Evaluate**:
  - WARN if indexable pages not in sitemap > 5% of total
  - Record: missing URL count, orphan URL count, top page types missing

---

## 3. Redirects & Errors

### CHECK-10: Redirect chains, loops, JS redirects, and redirect volume
- **Priority**: Critical | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-10"` — four finding rules:
     - `redirect.chain` (warning) — a redirect that lands on another redirect
     - `redirect.loop` (critical) — a redirect that returns to a URL already in its chain
     - `redirect.js` (critical) — a redirect performed by JavaScript rather than by a
       3xx, found by the render pass (so it needs `renderPassCount` ≥ 1 to be measured)
     - `redirect.meta-refresh` (warning) — a `<meta http-equiv=refresh>` or `Refresh`
       header that names a URL (a refresh with no URL is not reported); the evidence
       says whether the page refreshes to itself. Needs extraction version 2;
       `extraction.not-recorded` marks it NOT MEASURED.
     `issue_urls` per rule for the hops and the URLs.
  2. `metrics_get` with `metricId: "redirect.volume"` — the site row carries
     `{redirectPages, redirectInlinks, totalPages, ratioPct, chains, loops}`: how
     much of what the crawl fetched was a redirect, how often the site links at
     those redirects, plus the exact chain and loop counts.
     `redirectPages` counts one row per redirecting URL, so a template link that
     redirects on every page of the site is ONE redirect page here.
  3. **`redirectInlinks` IS the total-redirect-inlink number the Analysis asks
     for.** It counts internal `links` rows whose target is one of those
     redirecting URLs — the same template link is one redirect page and one
     inlink per page of the site, so on a site with three redirecting nav items
     and ten thousand pages the pair reads `redirectPages: 3, redirectInlinks:
     30,000`. Quote it; it is the crawl-budget half of this check and the number
     the Evaluate line's 10% threshold is written against.
     **Still never substitute `ratioPct` for it**, which is a different ratio
     (redirecting URLs ÷ URLs fetched) and will understate a repeated template
     redirect by exactly the factor that makes it worth reporting. The Phase 7
     gate site is the worked example: `ratioPct: 1.8` beside `redirectInlinks:
     898` on 551 URLs crawled — 1.8% of the crawl was a redirect, and the site
     pointed at those ten URLs 898 times, **163% of the URLs crawled**. One of
     those numbers passes the check and the other fails it critically; the
     Evaluate line means the second.
- **Important — Total Redirect Volume Analysis**: Do NOT just count unique redirect URLs.
  A site can have only 31 unique redirect URLs but 550K+ total redirect inlinks if the same
  redirecting link is repeated across thousands of pages (e.g., a template element like a
  returns widget or footer link that redirects on every page). The **total redirect inlink
  count** is what impacts crawl budget, not the unique URL count.
- **Analysis**:
  1. Unique redirect URLs: `redirect.volume`'s `redirectPages`, with `ratioPct` as
     its share of the crawl
  2. **Total redirect inlinks**: `redirect.volume`'s `redirectInlinks`, measured.
     State it beside `redirectPages` ("10 redirecting URLs, linked at 898 times")
     and against `totalPages` as the crawl-budget percentage the Evaluate line
     grades — the arithmetic is `redirectInlinks ÷ totalPages`, written out, not
     `ratioPct`
  3. If a redirect appears as an inlink from most page types, a template-level
     redirect exists — the redirect findings' URLs, grouped by `pageType`, are the
     evidence available for that claim today
  4. Identify the top redirect destinations from the `redirect.chain` evidence (each
     finding carries its hops), and say how many URLs share a destination
  5. For the top offender(s): open one source page in a browser and find where the link
     lives in the template. Common culprits: returns/refund widgets, footer links, promo
     banners, policy links. (The engine names the link; naming the *template element* is
     browser work.)
  6. Crawl budget waste: state BOTH ratios and label each. Redirecting URLs ÷
     URLs crawled is `ratioPct`. The inlink-weighted one — `redirectInlinks` ÷
     `totalPages` — is the one the Evaluate line's 10% threshold grades, and it
     is the one that moves when a template link is repointed.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - FAIL if redirect chains > 0
  - CRITICAL if redirect loops found
  - WARN if JS redirects found
  - **FAIL if total redirect inlinks exceed 10% of total URLs crawled** — this indicates
    a systemic crawl budget waste from repeated redirecting links in page templates
  - Record: unique redirect URL count, **total redirect inlink count**, top redirect
    destinations by inlink volume, top anchor texts, source template identification,
    crawl budget waste %, chain count, loop count, JS redirect count, longest chain hops

### CHECK-11: Broken internal links (4xx)
- **Priority**: Critical | **Requires**: Engine + DevTools
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-11"` — TWO rules, split by status class:
     `links.broken-internal` (critical), an internal link whose target answered
     4xx (404, 410, 403, 401), and `links.to-server-error` (critical), an
     internal link whose target answered 5xx (500, 502, 503, 504) — the same
     finding shape, a different repair, and the failing page's own 5xx finding
     is CHECK-12's, so both firing on one URL is two facts rather than a
     duplicate.
  2. `issue_urls` with `ruleId: "links.broken-internal"` — the developer's list.
     Each row's evidence names the broken target and where the link was found, which
     is what the action plan hands over. Follow the cursors, or `export_crawl` with
     `dataset: "issues"` if the count is in the thousands. Repeat it with
     `ruleId: "links.to-server-error"` for the 5xx half.
  3. `pages_query` with `statusCode: 404` for the 4xx URLs themselves, beside their
     page type — a 404 nothing links to is a different problem from a linked one.
- **DevTools**: Spot-check 2-3 source pages to verify broken links in context
- **Evaluate**:
  - FAIL if 4xx > 0
  - Group by: broken page links vs broken image/asset links
  - Record: total broken URLs, source pages affected, breakdown by type (page, image, CSS), top affected source pages

### CHECK-12: 5xx server errors
- **Priority**: High | **Requires**: Engine
- **Engine**: five rules. `http.server-error` (critical) and `http.server-error-transient` (warning) split 5xx responses by the end-of-crawl re-check; `http.no-response` (critical) and `http.no-response-transient` (warning) do the same for URLs that timed out or failed to connect; `page.html-too-large` (critical) reports 2xx HTML over 2 MiB.
  `issues_list` with `checkId: "CHECK-12"`. Every page whose fetch was classified a
  server error carries exactly one of the first pair, and every page that got no
  HTTP response at all carries exactly one of the second:
  - `http.server-error` (critical) — the error was not cleared. One finding per
    page, with the status code in the evidence.
  - `http.server-error-transient` (warning) — the crawl looked again and the site
    answered with something that is not a 5xx, so the page failed once and serves
    now. Its evidence carries both status codes and the gap between them.
  - `http.no-response` (critical) — the request timed out or the connection failed,
    and the second look did not change that or was not made. There is no status code to quote; the evidence carries the same
    `recheck*` fields and `gapSeconds` as the 5xx rule.
  - `http.no-response-transient` (warning) — the second look got an HTTP answer of
    ANY kind (a 5xx or a bot block included: the URL responded), so the first
    failure was a blip rather than a dead URL.
  - `page.html-too-large` (critical) — a 2xx HTML response whose body went over the
    crawler's 2 MiB read cap. The page was NOT analysed — nothing on it was checked —
    so it is a finding about the page's size and a gap in this crawl's coverage of
    it. Evidence is `{statusCode, htmlBytes, limit}` (the bytes read when reading
    stopped, and the cap). This one has no re-check.

  `issue_urls` per rule for the lists. A 5xx or a timeout during a crawl can also be a
  rate-limit symptom: check the crawl's pacing before reporting a site-wide outage
  (the engine paces itself, but a fragile host can still tip).

  **The second look is the engine's, not yours.** Before a crawl closes it
  re-fetches every server error (5xx walked first, cap 500) and then every
  no-response URL (cap 100) exactly once more — at least a minute after the
  first attempt, through the same politeness gate, and it never overwrites the
  first observation. The `recheck` key in `http.server-error`'s evidence says
  which of four states the finding is in, and the wording of the report depends
  on it:
  - "confirmed" — the site answered a server error again. This is the one to
    report as a broken page.
  - "inconclusive" — the second request got no answer ABOUT THE PAGE: it timed
    out, failed at the network, was met by a bot block, or was refused before it
    was sent (our own URL policy, or the site's robots.txt on the second pass).
  - "capped" — the crawl held more server errors than the pass's budget, so this
    row was never asked about a second time; `recheckReason` carries the reason.
  - "not run" — no pass covered this row at all: a crawl older than the pass, or
    one cancelled before it reached here.

  `recheckStatusCode`, `recheckFetchClass`, `recheckReason` and `gapSeconds` carry
  the detail behind the word.

  **No-response rows have the same four words with a different partition**, counted
  in the `noResponse` block inside `crawl_status`'s `recheck` `{pages, confirmed, answered,
  inconclusive, pending}` (`confirmed + answered + inconclusive + pending = pages`;
  these rows are in none of the 5xx numbers). The pass has a per-host breaker: after
  three consecutive no-response rechecks on one host the rest of that host's
  no-response rows are not asked (`recheck: "capped"`, reason `host-unresponsive`).
  A host that gives no answer three times running is down or refusing us, and
  hammering it would be the engine's fault; report those as "never re-verified".

  **The ruling: a 5xx whose re-check did not run is still an Error.** The site
  answered "server error" once and nothing has contradicted it; the unknown is
  whether it PERSISTS, not whether it happened. So the finding stays
  `http.server-error` (critical) and there is no marker for the unverified case —
  `crawl_status`'s `recheck` block is what says so, counting those rows as
  `pending` (with `capped` true when a budget was what stopped the pass). Say it
  in the report in those words: N confirmed, M never re-verified.
- **Evaluate**:
  - FAIL if internal 5xx or no-response URLs > 0 that the re-check did not clear
    (confirmed, inconclusive, pending or capped), or any `page.html-too-large`
    (a page over 2 MiB of HTML is itself the defect)
  - WARN if the only server errors or no-response URLs seen were ones the re-check
    cleared: the site is not failing now, but it did, and an intermittent 5xx or
    timeout still costs crawl rate
  - Record: count per rule (all five), affected URLs, source pages, and for each URL
    the recheck state and the gap between the two observations; for
    `page.html-too-large`, the size evidence

### CHECK-13: Soft-404s and thin OK responses
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-13"` — three rules:
  - `content.soft-404` (critical) — a 200 response whose text reads as a
    not-found page
  - `content.thin` (warning) — a 200 page with too little content OF ITS OWN to
    serve any query (the same rule answers CHECK-40)
  - `content.thin-skipped` (info) — the NOT MEASURED marker for the crawl the thin
    check could not be run on, below
  `issue_urls` per rule; `pages_query` for the word counts beside page type, which
  is how the "% of indexable pages" in the Evaluate line is computed.

  **The thin floor judges the page's OWN content**, not every word the document
  carries: the text inside the page's `<main>`, or its body with the `<nav>`,
  `<header>`, `<footer>` and `<aside>` subtrees removed. Its evidence is
  `{mainWords, wordCount, threshold}` — the page's own words, the whole document's,
  and 150 — so a page that ships 830 words and says 94 of them itself reads as
  exactly that. Quote `mainWords`; the whole-document count beside it is context,
  not the verdict. `content.soft-404`'s length ceiling still reads
  `renderableWordCount` (the words the markup does not hide), which is a different
  question about a different page.

  A page with NO content of its own — a body that is nothing but navigation and
  footer — is reported at `mainWords: 0` with `note: "no main-content text at all"`.
  That is the emptiest page a site can serve and it is named, not passed over.
  **Null `wordCount` is a different thing and not a finding**: no text was ever
  extracted for that URL — a PDF, a 404, anything with no body — which `content.thin`
  has always been silent about.

  **`content.thin-skipped` is the NOT MEASURED marker** (`content.near-duplicate-
  skipped` / `h1.duplicate-skipped` precedent). It fires once, site-scoped, when the
  crawl holds auditable indexable pages and NOT ONE of them carries a main-content
  word count — a crawl taken before migration 0018 introduced it. Evidence
  `{indexablePages, threshold}`. The engine will not fall back to the whole-document
  count there, because that column measures something else; on a site whose pages
  each carry several hundred words of shared menus it calls an empty page healthy.
  **While it fires, an empty thin list is not a site without thin pages**: the check
  was not run and a re-crawl is the only thing that answers it.
- **Evaluate**:
  - FAIL if soft 404s > 0
  - WARN if low content pages > 10% of indexable pages
  - Record: soft 404 count, low content count and percentage, sample URLs by page type

---

## 4. Host & Protocol

### CHECK-14: HTTP to HTTPS canonical route
- **Priority**: High | **Requires**: Engine (host probe)
- **Engine**: `issues_list` with `checkId: "CHECK-14"` — two rules:
  - `host.http-serves-200` (critical) — a plaintext spelling of the site answered 200
    instead of redirecting to https. One finding per spelling that did.
  - `host.probe-skipped` (info) — the crawl ran with `probeHosts: false`, so nothing
    about the host variants was measured. SKIP the check on that evidence; do not
    read the absence of the first rule as a pass.
  The probe is the only part of a crawl that fetches before robots.txt is read, so
  it runs once per crawl and answers CHECK-14 and CHECK-15 together.
  A third rule reads the crawl's own links: `security.http-url` (warning) — an HTTPS
  page the crawl fetched OK (200) that links to an `http:` URL on the site's own host
  (with or without `www.`), on a site whose crawl started at `https:`. One finding per
  linking page; its HTTP URLs Linked column is the exact number of distinct `http:`
  targets and its sample lists up to 10, sorted. The crawl never fetches those `http:`
  URLs (they are outside an `https:` crawl's boundary), so whether each one redirects
  is the host probe's answer, not this rule's. A site crawled over `http:` produces none.
- **Evaluate**:
  - FAIL if `security.http-url` fires (internal links to HTTP URLs) or
    `host.http-serves-200` fires (http:// does not redirect to https://)
  - Record: number of linking pages and distinct HTTP URLs linked, redirect behavior

### CHECK-15: Primary host choice (www vs apex, legacy, staging)
- **Priority**: Medium | **Requires**: Engine (host probe)
- **Engine**: `issues_list` with `checkId: "CHECK-15"` — three rules:
  - `host.duplicate-host-200` (critical) — two spellings of the site (apex and www)
    both serve 200 over https, so the same content lives at two hosts
  - `host.legacy-host-reachable` (warning) — a host passed as `legacyHosts` at
    `crawl_start` still serves content instead of redirecting to the live site
  - `host.probe-skipped` (info) — as above: nothing was probed
  **Legacy and staging hosts are only checked if you named them.** Pass them as
  `legacyHosts` when starting the crawl (each one must be on the operator's
  allowlist in its own right — they are different sites by every definition the
  engine has).

  **When nobody named a legacy host, the check is a PASS with an unmeasured half —
  not a SKIP.** This sentence used to read "a host nobody named is a host nobody
  probed, which is a SKIP, not a pass", and two auditors reading it beside the
  Evaluate line below landed on different verdicts for the same crawl. The Evaluate
  line governs, and it asks one question: do the site's variants resolve to one
  canonical host? The apex/www/http probe answers exactly that, it runs on every
  crawl with `probeHosts` on, and its answer does not become unknown because a
  legacy domain was never mentioned. So: **probe ran, no `host.duplicate-host-200`,
  no legacy host named → PASS, and `notes` says the legacy/staging half was NOT
  MEASURED because no `legacyHosts` were supplied.** Put the missing number in the
  report's not-measured table like any other.

  The SKIP reading is rejected, and it is worth saying why rather than just
  dropping it: SKIP means nothing was measured, and here the probe measured the
  thing the check is named for. A SKIP would file a site with one clean canonical
  host beside sites nobody looked at. **The SKIP case is narrower and still
  stands: `host.probe-skipped` fired** — the crawl ran with `probeHosts: false`, so
  no variant was probed at all and there is no verdict to give. A named legacy host
  on a crawl whose probe was skipped is that same SKIP.
- **Evaluate**:
  - PASS if all variants redirect to one canonical host — including when no
    `legacyHosts` were named, with the legacy half recorded as NOT MEASURED
  - FAIL if multiple hosts resolve to live content
  - SKIP only if `host.probe-skipped` fired: nothing about any variant was measured
  - Record: canonical host, redirect behavior per variant, and whether any
    `legacyHosts` were supplied

### CHECK-84: Security headers on HTTPS pages
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-84"`. The check asks whether HTTPS
  pages carry the response headers a browser uses to protect the visitor:
  `Strict-Transport-Security` (HSTS), `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, frame protection (`X-Frame-Options` or a CSP
  `frame-ancestors`) and `Referrer-Policy`. The evidence is the response headers the
  crawl stored for each page; the engine reads them from the database and fetches
  nothing. Two limits to state whenever this is quoted: a plain-HTTP page is judged
  by the host and protocol checks, not here, and a crawl written before the evidence
  layer (Phase 25) stored no response headers at all, so for such a crawl the
  silence of the finding rules is NOT a pass. Three rules answer it:
  - `security.hsts-missing` (warning) — an HTTPS page whose
    `Strict-Transport-Security` does not protect it: the header is absent, its
    `max-age` is 0 (which tells browsers to drop HSTS), or it has no parseable
    `max-age`. A browser reads the first such header, so that one decides. One
    finding per page; the evidence key `hstsProblem` (HSTS Problem column) says which
    of the last two it was, and is absent when the header was simply not sent.
  - `security.headers-missing` (info) — an HTTPS page missing an enforced
    `Content-Security-Policy` (Report-Only does not count), `X-Content-Type-Options:
    nosniff`, frame protection, or a safe `Referrer-Policy`. The evidence names which
    are missing. `Referrer-Policy` is judged on an unsafe value (`unsafe-url`,
    `no-referrer-when-downgrade`) as well as on absence, and the evidence carries the
    unsafe value.
  - `security.headers-not-recorded` (info) — the NOT MEASURED marker: at least one
    page of the crawl was written without response headers (a crawl before Phase 25,
    or a crawl mixing old and new pages), so neither rule above judged anything.
- **Evaluate**:
  - PASS if every HTTPS page sends a protecting HSTS (max-age above 0) and the other four headers
  - WARN if `security.hsts-missing` fired
  - INFO if `security.headers-missing` fired: report which headers, and on how many pages
  - SKIP if `security.headers-not-recorded` fired, which it does when response headers
    are missing for ANY pages of the crawl, mixed crawls included; the remedy is a
    re-crawl
  - Record: per-header count of pages that send it, and the URLs that do not

### CHECK-85: Mixed content and insecure forms
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-85"`. The check asks whether an
  HTTPS page references any image, script or stylesheet over `http:`, which a browser
  blocks or downgrades (26b widens the check to iframes, media and forms). The evidence is the table of files each
  page points at (the page-resources table), read from the database; nothing is fetched. A
  page's own HTTP links to other pages are not mixed content and belong to CHECK-14.
  The crawl must have recorded the page's files for this to be answerable: when it
  recorded none, `resources.not-recorded` (info) is the NOT MEASURED marker, and the
  silence of the mixed-content finding says the crawl never recorded them rather
  than that the site is clean. The remedy is a re-crawl. Two rules answer it:
  `security.mixed-content` (warning) — an HTTPS page with at least one `http:`
  resource, iframe or media element. One finding per page, carrying the count and
  up to ten of the URLs; on a page crawled with extraction 2 the optional `byKind`
  splits the count into resources, iframes and media. `security.form-insecure`
  (warning) — a form on an `http:` page, or a form on an `https:` page whose action
  is `http:`; the evidence carries the page scheme, the form counts and up to ten of
  the insecure actions. It is silent on a page extracted before version 2.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - PASS if no HTTPS page references an `http:` image, script, stylesheet, iframe or media element, and no form posts to or is served over `http:`
  - FAIL if `security.mixed-content` or `security.form-insecure` fired
  - NOT MEASURED if `resources.not-recorded` fired
  - Record: the referencing pages, the `http:` URLs and how many there are per page

---

## 5. Canonicals & Indexability

### CHECK-16: Self-referential canonicals on indexable pages
- **Priority**: Critical | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-16"` — three rules:
  - `canonical.missing` (warning) — an indexable page with no canonical at all.
    `issue_urls` for the list, and group it by `pageType` (via `pages_query`) to say
    whether one template is responsible. Pages that self-canonicalise produce no
    finding — that is the pass.
  - `canonical.relative` (info) — the HTML canonical is a path with no scheme and
    host, so it resolves against whatever address served the page.
  - `canonical.fragment` (warning) — the canonical carries a `#fragment`, which
    search engines do not index as part of an address.
- **Evaluate**:
  - FAIL if indexable pages missing canonical > 0
  - Record: self-referencing count, missing count, missing URLs by page type

### CHECK-17: Canonicalised URLs audit
- **Priority**: Critical | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-17"` — three rules:
  - `canonical.points-elsewhere` (info) — every page whose canonical names a
    different URL. The engine reports the fact; whether each target is the RIGHT one
    is the judgement this check asks for, so read the list from `issue_urls` (source
    and target per row) and assess the patterns — do not report the count alone.
  - `canonical.chain` (warning) — the target is itself canonicalised to another URL;
    the evidence lists the hops, and says when the chain loops or was cut at the hop
    limit. Shared with CHECK-19.
  - `canonical.unlinked` (info) — the canonical target is a crawled page that no
    other page links to, filed on the page that names it.
- **Evaluate**:
  - Review canonical targets — are they correct?
  - WARN if canonicalised count is high relative to total pages
  - WARN if `canonical.chain` (warning) > 0: the signal does not land on the first
    target named
  - INFO if `canonical.unlinked` (info) > 0: a canonical target nothing links to;
    weigh it with the target review above
  - FAIL if canonical targets are wrong
  - Record: canonicalised count, canonical target patterns, incorrect targets

### CHECK-18: Conflicting canonical signals
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-18"` — four rules:
  - `canonical.multiple` (critical) — more than one canonical on the page
  - `canonical.html-header-conflict` (critical) — the HTML canonical and the
    `Link: rel=canonical` header name different URLs
  - `head.directives-outside-head` (critical) — a canonical, robots meta or hreflang
    link after the point the `<head>` ended (at `</head>`, or implicitly at an element
    a head does not allow); Closed By names the element. Shared with CHECK-04 and
    CHECK-24.
  - `html.head-closed-early` (warning) — the same early close seen from the document:
    the element or text that ended the head (Closing Element, Element Snippet, Inside
    noscript), reported when head tags followed it, which Head Tags Lost lists (`base`,
    `title`, `meta`, `link rel=…`). Shared with CHECK-04 and CHECK-24.
  - `html.head-closed-early-harmless` (info) — an early close with no head tag after
    it (an explicit `</head>` or `<body>` is the next head-relevant tag), so nothing is
    lost today; a canonical added after it later would be. Typically a tracking
    pixel's `<noscript><img>` last in the head. Shared with CHECK-04 and CHECK-24.
  - `render.canonical-changed` (critical) — a rendered page whose canonical the
    JavaScript added, removed or pointed elsewhere (rendered pages only; see CHECK-01
    step 6).
  `issue_urls` per rule; the evidence carries the competing targets.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - FAIL if multiple conflicting canonicals > 0
  - Record: count, affected URLs, conflicting targets

### CHECK-19: Canonical to non-200 / non-indexable target
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-19"` — three rules:
  - `canonical.non-200-target` (critical) — the canonical points at a URL that did
    not answer 200
  - `canonical.non-indexable-target` (critical) — it points at a page the crawl
    judged non-indexable
  - `canonical.chain` (warning) — the target canonicalises to yet another URL, so
    the signals do not land on the first page named (also under CHECK-17)
  All three join the canonical to the target's own crawled row, so a target the crawl
  never fetched produces no finding: check `pages_query` for the target URLs before
  reading a clean answer as "every canonical target is healthy".
- **Evaluate**:
  - FAIL if canonical points to non-200 or non-indexable target
  - WARN if `canonical.chain` (warning) > 0 and no target is non-200 or non-indexable:
    the target canonicalises onward, so the first page's signal is diluted
  - Record: count, affected URLs, target status codes

### CHECK-20: Cross-domain canonicals
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-20"` — `canonical.cross-domain`
  (warning): a page whose canonical points at another host. No post-processing: the
  rule does the host comparison, including the apex/www spellings the crawl treats
  as one site.
- **Evaluate**:
  - WARN if found (verify intentional)
  - Record: count, source/target domain pairs

### CHECK-21: Directive conflicts (canonical + noindex)
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-21"` —
  `directive.canonical-noindex-conflict` (critical): a page that is both noindexed
  and canonicalised somewhere else. The cross-reference is the rule's; there are no
  two lists to intersect by hand.
- **Evaluate**:
  - FAIL if conflict found (sends mixed signals to search engines)
  - Record: count, affected URLs

---

## 6. Pagination

### CHECK-22: Pagination is HTML-based and crawlable
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-22"` — five rules:
  - `pagination.next-not-linked` (warning) — the page declares `rel="next"`, the
    target was crawled, and NO page on the site links to it. `rel="next"` has not
    been a discovery signal since 2019, so a series wired this way is one whose
    later pages nothing but the sitemap can find.
  - `pagination.next-target-uncrawled` (info) — the declared `rel="next"` target was
    never fetched by this crawl (or would not resolve). NOT MEASURED beyond that
    point, not "the sequence ends here".
  - `pagination.non-indexable-target` (warning) — a `rel="next"` or `rel="prev"` whose
    target the crawl fetched and which is not a 200 or says noindex. It reads
    `rel="prev"` too, so it also answers CHECK-23; an uncrawled target stays with
    `pagination.next-target-uncrawled`.
  - `pagination.loop` (warning) — the page is in a `rel="next"` cycle (following next
    comes back to it), reported once per member page with the URLs in walk order. A loop
    longer than 500 pages is not detected.
  - `pagination.sequence-error` (info) — the page's `rel="next"` names a crawled 200 page
    whose `rel="prev"` is absent or names a different page. A series that omits
    `rel="prev"` everywhere fires on every page of it; say so rather than listing it.
  - `pagination.multiple` (info) — a page that declares more than one `rel="next"` or
    more than one `rel="prev"` link; the evidence carries both counts. Two templates
    or plugins have written the same tag. Silent on a page extracted before version 2.
  A JS-only "Load more" with no `rel="next"` at all leaves ALL FIVE rules silent — the
  engine cannot report a declaration nobody made. That is what the DevTools steps
  below are for, and it is why this check keeps them.
- **DevTools** — Check BOTH collection and blog pagination separately:
  1. **Collection pagination**:
     - Navigate to a large collection (e.g., `/collections/all-dresses`)
     - Check the **raw HTML source** (fetch, not rendered DOM) for pagination links:
       `<a href="...?page=2">` or numbered page links
     - If only a "View More" / "Load More" button exists — check if it's a JS-only
       button or an actual `<a href>` link. If JS-only, pagination is not crawlable.
     - Check if numbered page links (1, 2, 3...) exist in HTML — these help crawlers
       discover all paginated pages in one level instead of sequential crawling
  2. **Blog pagination**:
     - Navigate to the blog index (`/blogs/{name}`)
     - Same checks: are `?page=2`, `?page=3` links in HTML?
     - Check meta robots on the blog index AND paginated pages (cross-ref CHECK-04)
  3. **Product grid on paginated pages**: Navigate to page 2 of a collection.
     Are product links rendered in HTML or JS-only? (cross-ref CHECK-01)
     If page 2 also has a JS-only product grid, even if the pagination link itself
     is crawlable, the products on that page won't be discovered.
- **Important**: Paginated pages (page 2, 3, etc.) should be **indexable** — do NOT
  recommend noindexing paginated content. The correct approach is indexed pages with
  self-referencing canonicals. Noindexing pagination removes those pages and their
  linked content from the index.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - PASS if pagination links are HTML anchor tags and paginated pages are indexable
  - FAIL if JS-only (infinite scroll / "View More" button with no HTML link fallback)
  - FAIL if paginated pages are noindexed (this is incorrect — they should be indexed)
  - WARN if `pagination.non-indexable-target` (warning) or `pagination.loop` (warning)
    > 0: a series whose `rel` chain ends at an unusable page or never ends
  - INFO if `pagination.sequence-error` (info) > 0: say whether it is one series
    omitting `rel="prev"` everywhere or a genuine mismatch
  - **FAIL if no HTML numbered page links exist** — numbered pagination (1, 2, 3...)
    is far better for crawl efficiency than just next/previous sequential links.
    It allows crawlers to reach page 10 in one hop instead of 9 sequential hops.
  - Record: pagination type per section (collection vs blog), HTML crawlable status,
    JS-only elements identified, numbered pages present or absent,
    indexability of paginated pages

### CHECK-23: Canonical strategy for paginated pages
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-23"` —
  `pagination.canonical-to-other` (info): a page 2+ (it declares `rel="prev"`) whose
  canonical points somewhere else, normally back to page 1. The engine states which
  strategy the site chose and leaves the verdict to you, which is exactly what this
  check asks for: a self-canonicalising paginated page fires nothing.
  `pagination.non-indexable-target` (warning) also claims this check: a series step
  whose target is a non-200 or a noindexed page (see CHECK-22).
  Cross-read `issues_list` with `checkId: "CHECK-04"` for whether those same pages
  are noindexed — the two together are the "pagination is being hidden" finding.
- **DevTools** (rel=next/prev presence on a page the crawl typed, and the visible controls):
  1. Canonical tag — does it self-reference (`?page=2` canonicals to `?page=2`) or
     point back to page 1?
  2. Meta robots — is it indexed or noindexed?
  3. rel="next" / rel="prev" — are they present?
  
  Execute on a paginated page:
  ```javascript
  JSON.stringify({
    canonical: document.querySelector('link[rel="canonical"]')?.href,
    robots: document.querySelector('meta[name="robots"]')?.content,
    relNext: document.querySelector('link[rel="next"]')?.href,
    relPrev: document.querySelector('link[rel="prev"]')?.href,
    currentUrl: window.location.href
  })
  ```
- **Important**: The correct pagination setup is:
  - Each paginated page has a **self-referencing canonical** (page 2 canonicals to page 2)
  - Paginated pages are **indexed** (NOT noindexed)
  - rel="next" and rel="prev" help search engines understand the sequence
  - Noindexing pagination is wrong — it prevents discovery of content linked from those pages
  - Canonicalising page 2+ back to page 1 is wrong — it tells Google "only page 1 matters"
    and the products/articles on page 2+ won't be discovered via canonical signals
- **Evaluate**:
  - **FAIL if paginated pages canonical back to page 1** — this effectively tells search
    engines to ignore all paginated content, preventing discovery of products/articles
    beyond the first page
  - FAIL if paginated pages are noindexed
  - WARN if rel="next" / rel="prev" are missing
  - WARN if pagination sequence errors > 0
  - Record: canonical strategy per section (collection vs blog), self-referencing vs
    page-1 canonical, indexability status, rel next/prev presence, sequence error count

---

## 7. Hreflang

### CHECK-24: Complete hreflang sets with return links
- **Priority**: High | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-24"` — `hreflang.missing-return-link`
     (critical): page A names B, and B does not name A back. One finding per broken
     pair; `issue_urls` carries both sides.
  2. `metrics_get` with `metricId: "hreflang.coverage"` — the coverage half of this
     check, which the Important note below demands and a finding list cannot give:
     `{pagesWithHreflang, indexablePages, coveragePct}` for the site and for each
     page type (`scope: "page_type"`, `scopeValue` the cohort). A page type at 0%
     coverage while its siblings are at 100% is the gap to report.
  3. `issues_list` with `checkId: "CHECK-24"` — `hreflang.missing-self-reference`
     (warning): a page declares alternates and its own URL is not among them. The
     other half of reciprocity, and the half that needs no second page: a set that
     omits the page carrying it is discarded whole, so this is usually one template
     defect repeated across every page it renders. Evidence carries the declared
     codes and the URLs they name; it carries NO "own language" URL, because the
     engine stores no language for a page and naming one would be a guess.
     `head.directives-outside-head` (critical) also claims this check: hreflang links
     after the `<head>` ended, with their count.
     `html.head-closed-early` (warning) also claims it: the element that ended the head
     before those links, with the head tags lost. `html.head-closed-early-harmless`
     (info) is the early close that lost nothing.
  4. `issues_list` with `checkId: "CHECK-24"` — `hreflang.alternates-not-crawled`
     (info) is a NOT MEASURED marker, not a finding about the site: it fires once
     when declared alternates have no page in this crawl, with the count of
     unfetched alternate URLs per domain and how many pages name them. Off-domain
     alternates are the normal shape of an international site, so expect it on most
     of them. **When it is present, the return-link answer above covers only the
     alternates that were fetched** — mark this check SKIP for the rest rather than
     reading the silence as reciprocal.
  5. `issues_list` with `checkId: "CHECK-24"` — four integrity rules over the
     declarations in the page's HTML, each filed with the evidence that names the
     fix:
     - `hreflang.inconsistent-return-code` (warning) — page A lists B, B links back to
       A, and the code B uses for A differs from the code A uses for itself.
       `x-default` is not read as a language; a page with no self-reference is
       left to `hreflang.missing-self-reference`.
     - `hreflang.multiple-entries` (warning) — one page gives one code to two or
       more different URLs (spellings of one URL are not different).
     - `hreflang.self-only` (info) — every declaration names the page itself, so no
       alternate is named.
     - `hreflang.unlinked-target` (info) — a crawled alternate no other page links
       to, filed on the alternate with up to 10 declaring pages and the exact count.
- **Important**: Don't just check for hreflang errors — also assess **coverage**:
  1. How many internal indexable URLs have hreflang tags vs how many should?
  2. If the site has multiple language/market versions, ALL equivalent pages should have hreflang
  3. Cross-reference: total indexable internal pages vs total pages with hreflang — identify the gap
  4. Flag page types missing hreflang that should have it (e.g., products exist in multiple markets but only some have hreflang)
- **Every hreflang rule ignores a page canonicalised elsewhere.** A page whose
  declared canonical names another URL is asking for that URL to be treated as the
  real one, and search engines read hreflang on the canonical, so an inherited
  alternates block on a tracking-parameter variant is not judged at all. Its
  canonical is reported by CHECK-17 where it belongs.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - FAIL if missing return links > 0
  - FAIL if pages missing their own self-reference > 0
  - FAIL if significant coverage gap (many pages that should have hreflang don't)
  - WARN if hreflang only in sitemap (not in HTML)
  - WARN if `hreflang.inconsistent-return-code` (warning) or `hreflang.multiple-entries`
    (warning) > 0: the cluster disagrees with itself and a search engine may discard it
  - INFO if `hreflang.self-only` (info) or `hreflang.unlinked-target` (info) > 0:
    a set naming no alternate, or alternates nothing links to. Record the count; do
    not PASS the check clean with either on file
  - Record: total hreflang URLs, total indexable URLs, coverage %, missing return links, page types without hreflang that should have it, implementation method (HTML/sitemap/both)

### CHECK-25: Language-region codes and x-default
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-25"` — three rules:
  - `hreflang.invalid-code` (critical) — a declared code that is not a valid
    language, or language-region, value
  - `hreflang.missing-x-default` (info) — a cluster with no `x-default` member
  - `hreflang.html-lang-mismatch` (info) — a page whose `<html lang>` primary language
    differs from its own self-referencing hreflang codes (region is not compared)
  `issue_urls` per rule for the affected URLs and the codes they declared.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - FAIL if incorrect codes > 0
  - WARN if x-default or self-reference missing
  - Record: counts for each issue type

### CHECK-26: Hreflang to non-indexable or redirected URLs
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-26"` —
  `hreflang.non-indexable-target` (critical): an hreflang alternate that points at a
  page this crawl fetched and found either redirecting or excluded from the index by
  a noindex directive. An alternate that canonicalises to another URL is not a
  cluster member at all (see CHECK-24) and is reported by CHECK-17 instead.
  `issue_urls` gives the source/target pairs and the reason per row. A target the
  crawl never fetched cannot be judged and produces no finding — read it as
  unmeasured, not as sound, and read `hreflang.alternates-not-crawled` (info), the
  NOT MEASURED marker that says how many such targets there were and which domains
  they sit on, before recording a verdict here.
- **Evaluate**:
  - FAIL if hreflang targets are non-200, noindexed, or non-canonical
  - Record: non-200 count, noindex count, non-canonical count, affected URL pairs

---

## 8. URL Parameters

### CHECK-27: Parameter audit and canonical handling
- **Priority**: High | **Requires**: Engine
- **Engine**:
  1. `metrics_get` with `metricId: "url.param-volumes"` — the parameter census:
     `{totalParams, trackingParams, topParams: [{name, occurrences, isTracking}],
     parameterisedPages, parameterisedIndexablePages}`. The categorisation the
     Evaluate line asks for is yours to make from `topParams`; the counts are the
     engine's.
  2. `issues_list` with `checkId: "CHECK-27"` — `url.parameter-pages-indexable`
     (warning): parameterised URLs that are indexable, which is the "without proper
     canonicals" half. Cross-read CHECK-17 for where those canonicals point.
- **Evaluate**:
  - Categorise params: pagination (?page=), sort (?sort_by=), filter, variant (?variant=), search, tracking (utm_), currency
  - FAIL if parameterised URLs are indexable without proper canonicals
  - Record: parameter type breakdown, canonical coverage per type

### CHECK-28: Tracking parameters (utm, gclid, fbclid)
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-28"` —
  `url.tracking-params-internal` (warning): INTERNAL links carrying tracking
  parameters, which is how a site links itself into a parallel set of parameterised
  URLs. `issue_urls` for the list; `url.param-volumes`' `trackingParams` and the
  `isTracking` flag on `topParams` give the totals.
  `url.too-long` (info) lives under this check because the checklist has no
  URL-length check of its own: it is the one URL-shape rule, an indexable,
  self-canonical page whose stored URL is over 115 characters, which is usually a
  tracking or session parameter or a repeated folder.
  `url.reference-too-long` (warning) sits beside it: a page that links to, loads
  or names as an hreflang alternate an address over 2,500 characters (the one
  limit for every indexed URL). The crawl neither followed nor checked those
  references; the evidence counts them per kind (`links`, `resources`,
  `hreflang`, one per reference) with `max: 2500`. It reads the page whatever its
  index status. Over-long share images are `social.image-broken`'s `too-long`
  problem (CHECK-87).
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the facts this check reads from extraction version 3: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - FAIL if tracking param URLs are indexable without canonical to clean URL
  - Record: count, sample URLs

### CHECK-29: Faceted navigation — risk assessment AND opportunity
- **Priority**: High | **Requires**: Engine + DevTools + GSC
- **Engine**: `metrics_get` with `metricId: "url.param-volumes"` — this check is
  MEASURED, not found, so `issues_list` with `checkId: "CHECK-29"` is refused with a
  pointer to the metric rather than answered empty. The crawl surface the risk half
  asks about is `parameterisedPages` and `parameterisedIndexablePages`, and the
  filter families are the `topParams` names. Whether the facets are crawlable at all
  is CHECK-02; whether robots.txt catches them is CHECK-03.
- **Important — This is NOT just a risk check**: Faceted navigation is both a crawl budget
  risk AND a significant SEO opportunity. Blanket-blocking or canonicalising all filters
  to the base URL may be safe but also kills potential high-value landing pages.

  **Risk**: Unchecked, filters create thousands of thin, near-duplicate parameter URLs.
  **Opportunity**: Single-filter URLs like `/collections/dresses?filter.v.color=Red` could
  serve as the landing page for "red dresses" — a high-volume query. Canonicalising it
  away means you have no page specifically targeting that search intent.

- **DevTools**:
  1. Navigate to a collection page, use sort/filter controls
  2. Observe: does URL change? Are params added?
  3. Check canonical and robots directives on the filtered URL
  4. **Robots.txt wildcard gap analysis**: Cross-reference with CHECK-03 pattern testing.
     Specifically verify that these combinations are handled:
     - Single filter URL (e.g. `?filter.v.size=UK+10`) — blocked, noindexed, or canonicalised?
     - Single filter + pagination (`?filter.v.size=UK+10&page=2`) — blocked?
     - Single blog tag + pagination (`/blogs/journal/tagged/dresses?page=2`) — blocked?
     - Multiple filters (`?filter.v.size=UK+10&filter.v.color=Black`) — blocked?
  5. Calculate potential crawl surface: number of filter values × number of collections ×
     average pagination depth. Flag if this exceeds 10,000 potential URL combinations.
- **Opportunity assessment** (cross-reference with GSC data from CHECK-74):
  1. From CHECK-74, identify high-volume queries that map to filter values:
     - Colour queries: "red dresses", "black dresses", "burgundy dresses"
     - Size queries: "plus size dresses", "petite dresses"
     - Material queries: "satin dresses", "lace dresses"
     - Style queries: "backless dresses", "off-shoulder dresses"
  2. Check: does the site have a dedicated collection page for these, or are they only
     reachable via filters? If only via filters AND the filter URL is canonicalised away,
     there's no landing page for that query.
  3. **Recommendation options** (not a one-size-fits-all — present options):
     - **Option A: Static collections** — Create dedicated collection pages for high-volume
       filter values (e.g., `/collections/red-dresses` instead of `?filter.v.color=Red`).
       Best for SEO but requires manual creation and maintenance.
     - **Option B: Indexable single-filters** — Allow single-filter URLs to be indexed
       with self-referencing canonicals. Block multi-filter combinations. More automated
       but creates more URL surface to manage.
     - **Option C: Status quo** — Keep all filters canonicalised to base. Safest for crawl
       budget but misses keyword opportunity. Only recommend if the site already has
       dedicated collection pages covering all key filter values.
- **Evaluate**:
  - PASS if all filter combinations are handled AND high-volume queries have dedicated landing pages
  - WARN if filters are canonicalised to base but high-volume query opportunities are missed
  - FAIL if filter URLs are indexable without canonical creating crawl bloat
  - Record: current filter handling method, robots.txt gap analysis, **opportunity assessment
    — which high-volume queries lack a dedicated landing page**, recommended strategy option
  - Record: facet handling method (robots.txt, noindex, canonical, none), **specific patterns
    that pass through robots.txt**, estimated crawl surface size

### CHECK-30: Case and trailing-slash normalisation
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-30"` —
  `url.normalisation-variants` (critical): URLs the crawl reached in more than one
  spelling (case, trailing slash) where both answered 200 instead of one redirecting
  to the other. `issue_urls` gives the variant sets.
  Six page rules read the SHAPE of an indexable page's URL path (never its query or
  host): `url.uppercase` (info), `url.underscores` (info), `url.non-ascii` (info),
  `url.spaces` (warning: `%20` or a literal space; a `+` is not read), `url.multiple-slashes`
  (warning) and `url.repetitive-path` (warning: a folder or run of folders repeated
  straight after itself, which names the repeated part). A page whose path is
  percent-encoded non-ASCII is not an upper-case page: the hex digits are not read.
- **DevTools**: Test an uppercase URL — check if it 301s to lowercase. Test with/without trailing slash
- **Evaluate**:
  - PASS if single canonical version, variants redirect 301
  - FAIL if both versions resolve to 200 without canonical
  - WARN if `url.spaces` (warning), `url.multiple-slashes` (warning) or
    `url.repetitive-path` (warning) > 0: each makes a second spelling of a URL
  - INFO if `url.uppercase` (info), `url.underscores` (info) or `url.non-ascii` (info)
    > 0: style and consistency findings, not defects. Report the counts
  - Record: uppercase URL count, redirect behavior

---

## 9. Internal Linking

### CHECK-31: Crawl depth to key pages
- **Priority**: Critical | **Requires**: Engine
- **Engine**:
  1. `metrics_get` with `metricId: "structure.click-depth-distribution"` — CLICK
     depth: the shortest chain of internal links from the home page, computed by the
     engine's own breadth-first search over the `links` table. The shape is
     `{count, nullCount, min, p25, median, p75, p95, max, mean}` for the site and for
     each page type (`scope: "page_type"`). The home page is 0.
     - `count` is every page in the cohort (indexable 200s).
     - **`nullCount` is the no-depth bucket the check below demands** — the pages no
       chain of links reaches at all. They are NOT depth 0 and never were: a page
       listed only in the sitemap has no click depth, and this column is where it is
       counted. `count - nullCount` is the population the percentiles describe, so
       percentages over the whole cohort use `count` as the denominator and the
       unreachable pages appear as their own row.
     - Links are followed as published: internal links only, and a link that lands on
       a redirect leads no further — a page reachable only through a redirect is
       counted unreachable, and the redirect is the thing to fix (CHECK-10).
  2. `issues_list` with `checkId: "CHECK-31"` — `structure.deep-page` (info) names
     individual pages past the depth threshold. **It reads CLICK depth** (since
     ruleset 0.7.0 it is a query rule, running after the click-depth search), so its
     evidence is `{clickDepth, threshold}` and its list is the buried indexable pages
     rather than a lower bound. Pages with no click path at all are NOT in it — they
     have no depth to be past a threshold; they are the `nullCount` bucket in the
     distribution above, and where nothing links to them at all they are
     `links.orphan`'s finding (CHECK-32). A page in `nullCount` but not in
     `links.orphan` is the island step 4 asks about. Per-page depths come from
     `pages_query`, which reports `clickDepth` beside `depth`.
     **Read the caveat on each finding.** A click depth computed over an incomplete
     crawl is an UPPER BOUND — an unfetched page can only have removed a shorter
     route, never added one — so the evidence carries a caveat holding an
     `incompleteCrawl` reason (when the crawl did not demonstrably finish) and/or a
     `failedPages` count (URLs that could not be fetched). No caveat means the crawl
     drained its frontier under its cap and the depths are the site's own.
  3. `metrics_get` with `metricId: "structure.depth-distribution"` — DISCOVERY depth,
     kept as evidence about the CRAWL rather than about the site. It counts hops from
     a seed, and **every sitemap URL is a seed**, so a page with no HTML link path is
     recorded there at 0. Read it against the click-depth table: where discovery depth
     is far shallower than click depth, the sitemap is doing the work the internal
     linking should do. On the Phase 6 gate crawl this metric put 437 of 443 indexable
     pages at "depth 0" beside a median inbound link count of **zero** — which is the
     reading error this pair of metrics exists to make impossible.
  4. Cross-read the unreachable pages against `links.orphan` (CHECK-32). The two
     answer different questions and should broadly agree: an orphan has no inbound
     internal link at all, while an unreachable page may be linked only from other
     unreachable pages (an island). A page in `nullCount` but not in `links.orphan` is
     exactly that island, and it is worth naming as one.
- **Analysis**: the distribution is per indexable page — non-indexable pages
  (noindexed, canonicalised, blocked) are excluded, because their crawl depth is
  irrelevant. Present the buckets the table below asks for, with the percentiles from
  the metric beside them.
- **CRITICAL — Include pages with NO crawl depth**: Pages discovered via sitemap only
  (not via any HTML link) have no depth at all. They MUST appear in the distribution as
  "No depth (sitemap only)" — they are the worst case, worse than depth 5+, because they
  have zero link path from the homepage.

  The distribution must always show ALL indexable pages totalling 100%:
  ```
  | Crawl Depth              | Pages | % of All Indexable |
  |--------------------------|-------|--------------------|
  | No depth (sitemap only)  | X     | X%                 |  ← MUST INCLUDE THIS
  | Depth 0 (homepage)       | X     | X%                 |
  | Depth 1                  | X     | X%                 |
  | Depth 2                  | X     | X%                 |
  | Depth 3                  | X     | X%                 |
  | Depth 4                  | X     | X%                 |
  | Depth 5+                 | X     | X%                 |
  | TOTAL                    | X     | 100%               |
  ```

  **Do NOT calculate percentages using only pages that have a depth value.** That hides
  the sitemap-only pages and makes the distribution look healthier than it is. On one
  audit, this error made "41% at depth 4+" look like the main problem — when the real
  finding was 64% had no depth at all.

- **Evaluate**:
  - FAIL if key indexable page types (products, collections) are >3 clicks deep
  - **FAIL if >30% of indexable pages have no crawl depth** (sitemap-only discovery)
  - Cross-reference with CHECK-01 (JS dependency) and CHECK-33b (product discovery) —
    sitemap-only pages often indicate a JS-rendered link structure
  - Record: crawl depth distribution including no-depth bucket (indexable pages only),
    page types at each depth, % of indexable pages at depth >3, **% with no depth**

### CHECK-32: Orphan pages (no internal links)
- **Priority**: High | **Requires**: Engine + GSC
- **Engine**: `issues_list` with `checkId: "CHECK-32"` — three rules:
  - `links.orphan` (warning) — a page the crawl fetched that no other crawled page
    links to. `issue_urls` gives the list, and each row's evidence says how the page
    was discovered and whether the sitemap lists it, which is the SITEMAP breakdown
    the Analysis asks for.
  - `links.orphan-skipped` (info) — the crawl did not run to completion (URLs left
    unfetched, or a page cap reached), so "nothing links to this page" cannot be
    distinguished from "the page that links to it was never crawled". When this
    fires, CHECK-32 is SKIP with the reason quoted, NOT a clean orphan count.
  - `links.only-from-non-indexable` (warning) — an indexable page that other pages link
    to, none of which is indexable itself (noindex, canonicalised elsewhere, or not a
    200). It is the near-orphan: the page shows as linked in a crawl and the links
    count for little. A page nothing else links to is `links.orphan`'s, not this
    rule's; a page with even one indexable inlink fires neither.

  And the site-wide evidence beside those verdicts: `metrics_get` with
  `metricId: "structure.depth-distribution"` — DISCOVERY depth, how far into the
  crawl each page was first found. It passes no verdict; it is the shape the orphan
  findings make in aggregate. Every sitemap URL is enqueued as a starting point, so
  a distribution that collapses to zero says the crawl found this site's pages by
  reading a file rather than by following links — the site-wide shadow of the
  per-page fact `links.orphan` reports, and the number to quote when a client asks
  how widespread the orphaning is. Read it against
  `structure.click-depth-distribution` (CHECK-31): where discovery depth is far
  shallower than click depth, the sitemap is carrying the internal linking.
- **CRITICAL — two different orphan populations, and the engine sees one of them**:
  - **Crawl orphans** (the engine's): pages this crawl reached, with no inbound
    internal link from any other crawled page. Complete for what was crawled.
  - **GSC orphans**: URLs Google has impressions for that the crawl never reached at
    all. The engine cannot see these by definition — nothing links to them and it
    never fetched them. Get them from GSC (CHECK-77's inspection data) and report
    them as a separate tier, never merged into the engine's count without saying so.
  A total that silently mixes the two is the reporting error this section exists to
  prevent.

- **The cross-check the pages listing answers directly.** `pages_query` takes
  `discoveredVia` — `seed`, `link`, `sitemap` or `redirect` — which is how the CRAWLER
  reached each URL. Pages at `discoveredVia: "sitemap"` were never linked from
  anywhere the crawl walked, so that listing is the orphan finding's population read
  from the other side: the two should agree, and where they do not, the difference is
  informative (a page discovered by link whose only linker was later found
  unreachable is an island, not an orphan). Read it against `clickDepth: null` from
  CHECK-31 too — a page reachable by no chain of links at all.
- **Analysis**:
  1. Take the total crawl-orphan count from `issues_list`'s `count` for `links.orphan`
  2. Break down by source: the finding evidence separates sitemap-listed orphans from
     the rest, and `pages_query` with `discoveredVia: "sitemap"` counts the same
     population independently; the GSC tier comes from GSC
  3. **Break down by URL type — but classify carefully**. CDN asset URLs contain
     `/products/` in their path (e.g., `/cdn/shop/products/image.jpg`) and will
     false-positive as product pages if you match on `/products/` alone. Always
     exclude `/cdn/shop/` paths before classifying URL types. Use this order:
     1. CDN assets first: any URL containing `/cdn/shop/` → `cdn_asset`
     2. Then: `/products/` → product page
     3. Then: `/collections/` → collection page
     4. Then: `/blogs/` → blog
     5. Then: `/pages/` → page
  4. **Watch for Shopify collection-scoped product URLs**: Shopify generates two URL
     formats for every product — the canonical `/products/[slug]` and a
     collection-scoped `/collections/[name]/products/[slug]`. Google often indexes
     thousands of collection-scoped URLs as GSC orphans. These are NOT missing products —
     they are Shopify duplicate URLs that should canonical back to `/products/[slug]`.
     Always check: do the GSC product orphans follow the `/collections/.../products/`
     pattern? If so, flag as a Shopify canonical consolidation issue, not a discovery gap.
  5. The GSC orphan count reveals how many pages Google has indexed that have zero
     internal link path — these are the most vulnerable pages on the site
  6. Cross-reference with CHECK-01 and CHECK-33b: if the product grid is JS-dependent,
     the GSC orphan products are the ones Google found via sitemap but can't reach
     through HTML links
- **Evaluate**:
  - FAIL if orphan pages > 0 for important content
  - Severity is based on the **total orphan count across both tiers**, stated tier by tier
  - Do NOT answer this check from `crawl_status` counts — those describe the crawl, not
    the link graph (Evaluation Principle 2). `links.orphan`'s own count is the source
    of truth for the crawl tier.
  - Record: **total orphan count**, breakdown by source (crawl orphans vs GSC-only),
    breakdown by URL type (with CDN excluded), Shopify collection-scoped URL
    count if applicable, percentage of total known URLs

### CHECK-33: Unique inlinks distribution
- **Priority**: Medium | **Requires**: Engine (metrics and rules)
- **Engine**: two metrics, which measure, and two rules, which find. The inlink count
  is a measurement rather than a fault, so the metrics carry the distribution:
  - `inlinks.distribution` — `{count, min, p25, median, p75, p95, max, mean}` unique
    inlinks per indexable page, for the site and per page type (`scope: "page_type"`)
  - `inlinks.extremes` — the two ends as URLs: the under-linked bottom and the
    top-linked pages, ready to quote

  The two rules are per-page findings about the links a page carries, read with
  `issues_list` and `checkId: "CHECK-33"`:
  - `links.internal-nofollow` (warning) — a page with an internal link marked
    `rel="nofollow"`; the evidence counts them and samples the targets. An external
    nofollow is not judged.
  - `links.high-outlinks` (info) — a page linking to more distinct internal URLs than
    the internal limit, or more distinct external URLs than the external limit (the
    limits are in the rule's copy and are not added together). An unusually long link
    list dilutes what each link passes on.
- **Analysis**: This check must present actual numbers, not just pass/fail. From the two
  metrics above, present:
  1. Distribution summary: min, median, mean, max unique inlinks (site row)
  2. Pages with fewest inlinks — these are under-linked (`inlinks.extremes`)
  3. Pages with most inlinks — these receive most equity (`inlinks.extremes`)
  4. Per page type: the same distribution, from the `page_type` rows
  5. Flag important pages (high-traffic from CHECK-73) that have below-average inlinks
- **Evaluate**:
  - WARN if important pages have <3 unique inlinks
  - WARN if significant imbalance (some pages have 100+ inlinks, others have 1-2)
  - WARN if `links.internal-nofollow` (warning) > 0: internal links that withhold what
    they would pass on
  - INFO if `links.high-outlinks` (info) > 0: the external limit is a review
    threshold, so weigh the page before calling it a defect
  - Record: full inlinks distribution table, bottom 20 pages, top 20 pages, averages by page type

### CHECK-33b: Product discovery source analysis (e-commerce)
- **Priority**: Critical | **Requires**: Engine (metric) + GSC
- **Important**: This check reveals whether products are discoverable through the HTML link
  graph or depend entirely on the sitemap and JS rendering. It is one of the most impactful
  structural findings for e-commerce sites.
- **Engine**: `metrics_get` with `metricId: "inlinks.sources-by-type"` — one row per
  page-type cohort, whose value is `{sources: {<source page type>: <inlinks>}}`: which
  templates link into this one, and how many distinct page-to-page links they send.
  This check is MEASURED, so `issues_list` with `checkId: "CHECK-33b"` is refused
  with a pointer to the metric.
  - `{sources: {}}` on the product cohort is the finding: **nothing on the site links
    to products at all**.
  - **The self-referential case is not a pass, and it is the common one.** A product
    cohort whose sources map is `{"/products/:slug": 82}` — products linking only to
    products — is an ISLAND: the links exist, and nothing outside the cohort reaches
    them. Read the map for what links IN from other templates; a map with only the
    cohort's own type in it answers "nothing links to products" just as `{}` does.
    `clickDepth` is what proves it (the Phase 7 gate site: 148 of 148 products at
    `clickDepth: null` with 82 product-to-product inlinks), so cross-read the two
    rather than reading the map alone.
  - A cohort landing in `(untyped)` means the crawl could not type those pages — say
    so rather than reading the typed cohorts as the whole site.
- **CRITICAL — three populations, do not confuse them**:
  - **Orphan products** = products with zero internal inlinks from anywhere in the
    crawl (`links.orphan`, filtered to the product cohort). Smallest count, worst case.
  - **Products with no click depth** = products no HTML link path reaches from the
    homepage, a strictly larger set that includes products linked only from other
    sitemap-discovered pages. `pages_query` with `pageType: "product"` shows
    `clickDepth` per row; the ones with `clickDepth: null` are these.
    **Read `clickDepth`, never `depth`.** `depth` is DISCOVERY depth and every
    sitemap URL is enqueued as a seed, so `depth: null` is a set that is empty by
    construction — a tier counted that way is always zero and this check passes on
    a site whose entire catalogue is unreachable. `clickDepth` is null exactly when
    no chain of internal links reaches the page, and it is written by the rules run
    (`crawl_rules`): if it is null on EVERY page, the rules have not been run, which
    `crawl_status`'s `rulesRunAt` confirms — that is a missing measurement, not a
    site with no internal links.
  - **GSC-only products** = products Google knows and the crawl never reached. Only
    GSC has them.
  The correct number for "products not reachable via HTML" is the second. Reporting
  the orphan count instead under-reports the problem, sometimes by several times.
- **Analysis**: over the product cohort (`pages_query` with `pageType: "product"`, or
  `export_crawl` with `dataset: "pages"` on a large site):
  1. **Link-discovered products**: count products WITH a `clickDepth` value
  2. **Sitemap-only products**: count products with `clickDepth: null`
  3. **GSC-only products**: from GSC — URLs it has impressions for that do not appear
     in the crawl at all
  4. Present as a three-tier breakdown table:
     ```
     | Discovery Source            | Products | % of Total |
     |-----------------------------|----------|------------|
     | HTML links (with clickDepth)| X        | X%         |
     | Sitemap only (no clickDepth)| X        | X%         |
     | GSC only (not in crawl)     | X        | X%         |
     | TOTAL                       | X        | 100%       |
     ```
  5. Cross-reference with CHECK-01: if the product grid is JS-dependent, the "sitemap only"
     and "GSC only" tiers will be large — this confirms the JS rendering impact on real crawl data
  6. Cross-reference with `inlinks.sources-by-type`: an empty or tiny `sources` map on
     the product cohort says the same thing from the link graph's side
- **Evaluate**:
  - PASS if >80% of products have a click depth (reachable via HTML links)
  - WARN if 30-80% are sitemap/GSC-only
  - FAIL if >80% of products have no HTML link path (entirely dependent on sitemap for discovery)
  - Note: A "FAIL" here combined with a JS-dependent product grid (CHECK-01) means the site's
    product discoverability is fundamentally broken for any crawler that doesn't render JS,
    including Googlebot's initial crawl pass
  - Record: three-tier breakdown table, total products per tier, % distribution,
    cross-reference with CHECK-01 JS dependency finding

### CHECK-34: Navigation and key links in raw HTML
- **Priority**: Critical | **Requires**: Engine (render pass)
- **Engine**: `issues_list` with `checkId: "CHECK-34"` — `nav.js-only` (critical): a
  rendered page whose raw HTML carried almost no nav or footer links while the
  rendered DOM carried a real navigation. `issue_urls` gives the pages, each with
  `{rawNavLinks, rawFooterLinks, rawLinks, renderedNavLinks, renderedFooterLinks,
  renderedLinks}` — the counts this check's Record line asks for, on every page the
  render pass sampled rather than on the homepage alone.
  It needs `renderPassCount` ≥ 1; without a render pass this is SKIP, not PASS.
  Whether the nav contains the RIGHT links (key categories) is judgement — read the
  nav on one page in a browser for that, and say that is what you did.
- **Link elements a crawler cannot follow**: `links.uncrawlable` (warning) — a page
  with `<a>` elements that have no `href` (only with an `onclick` or `role="link"` /
  `role="button"`; a bookmark such as `<a name="top">` is not a link), a `javascript:`
  href, or a bare `#` / `#!` href. `#section` is in-page navigation and is not counted.
  The evidence is the three counts. A link written this way is not discovered through
  that element, so a target reached only through such links is a crawl-reach gap.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - PASS if main nav and footer links are in initial HTML
  - FAIL if key navigation is JS-only
  - Record: nav link count, footer link count, JS-dependency status

### CHECK-86: Link hygiene (private hosts, generic anchors)
- **Priority**: Low | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-86"`. The check asks whether the
  links a page carries are ones a visitor and a crawler can use: links that point at
  `localhost` or a private-network address (a staging or development leftover that
  works only on the author's machine) and links whose anchor text is generic ("click
  here", "read more") and so tells neither a visitor nor a search engine what the
  target is. The evidence is the `links` table, answered in SQL for the whole crawl,
  with `issue_urls` naming the source page and the target. Only external links are
  judged for private hosts: an internal link is the site itself. Two rules answer it:
  - `links.localhost` (warning) — a page with an external link whose host is
    `localhost`, a private or reserved IP address, or an internal-only name (`.local`,
    `.internal` and the like), decided by the same policy the crawler refuses to fetch
    with. A dotless intranet name is not reported, because that policy does not call it
    private.
  - `links.non-descriptive-anchor` (info) — a page with an INTERNAL link whose whole
    anchor is a generic English phrase ("click here", "read more", "learn more" and the
    rest of the list in the rule's thresholds). The judgement covers internal anchors
    only; anchors in other languages, and external anchors, are not judged.
  Four more rules answer the rest of the check:
  - `links.empty-href` (info) — a page with `<a href="">`, which points back at the
    page itself.
  - `links.unsafe-target-blank` (info) — a page with `target="_blank"` links to
    another origin that carry neither `noopener` nor `noreferrer` in `rel`. Only a
    cross-origin target counts (an exact origin compare, so a subdomain or a `www.`
    variant is another origin): reverse tabnabbing needs the opened page to be on
    another origin, and a same-origin new-tab link is not reported.
  - `links.no-anchor-text` (warning) — a page with an INTERNAL link that nothing names:
    its stored anchor is empty after whitespace is removed AND it has no `aria-label`
    (absent or blank) AND no wider name: no `aria-labelledby`, no `aria-label` on an
    element inside the link, no `<title>` in an `<svg>` inside it and no `title`
    attribute. The stored anchor includes the alt text of an image inside the
    link, so an image link with alt text is not textless and one without is. Only the
    first anchor per target is stored, so a target reached first by a textless link
    and later by a text link is listed too.
  - `links.aria-label-only` (info) — a page with an INTERNAL link whose anchor is empty
    but which is named by attributes: a non-blank `aria-label`, or a wider name (in
    order: `aria-labelledby`, recorded as the ids it points to and not the text they
    hold; an `aria-label` on an element inside the link; an icon's `<svg><title>`;
    the `title` attribute). The row lists the targets and their `names`, each with
    its source. These name the link for screen readers, but search engines document
    visible text and image alt as anchor text, not these attributes, so the link
    passes no anchor relevance. Often fine for icon links (cart, wishlist, account);
    where the target matters for search, the fix is visible text or an image alt.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2 (version 3 for `links.no-anchor-text` and `links.aria-label-only`, which read a link's wider name): on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - PASS if no link points at a private host and generic anchors are rare
  - WARN if any link points at `localhost` or a private address, any internal link has
    nothing that names it (`links.no-anchor-text`), or generic anchors are common
  - Record: source page, target URL and anchor text for each finding

### CHECK-87: Social sharing tags (Open Graph and X)
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-87"`. The check asks whether a page
  carries the Open Graph and X (Twitter) tags that decide how a shared link looks:
  a complete Open Graph set (title, type, image, url), an X card, tags that do not
  contradict each other, tags placed in the head, and a share image that loads. The
  evidence is the social tag set the crawler stored on each page; the image check
  reads the recorded fetch of the image. These facts exist only for crawls written by
  extraction version 2 or later: on an older crawl `extraction.not-recorded` (info) is the
  NOT MEASURED marker, and silence says the crawl never measured them, not that the
  site is clean. The remedy is a re-crawl. Eight rules answer it, all on judged pages
  (indexable, self-canonical):
  - `social.og-incomplete` (info): og:title, og:type, og:image or og:url missing or
    empty; evidence `{missing, none}`, `none` true when the page has no Open Graph
    tag at all.
  - `social.og-multiple` (info): an `og:` tag repeated with different values;
    evidence `{tags}`. `og:image` is never listed: Open Graph makes it an array (a
    gallery's images, first preferred), so several values are not a conflict.
  - `social.og-url-mismatch` (info): og:url resolves to another address than the
    page's canonical (its own URL when it declares none); evidence `{ogUrl,
    canonical}`. A trailing slash on a path is a different address.
  - `social.x-incomplete` (info): no `twitter:card`, a card with no title
    (`twitter:title`, or the `og:title` X falls back to), or X tags written as
    `property=`; evidence `{missing, viaProperty}`.
  - `social.og-duplicate` (info): one og:title or og:description on several pages,
    grouped exactly as CHECK-35's `title.duplicate` (hreflang alternates one page,
    rel=prev pages set aside); evidence `{field, value, count, pages,
    alternatesCollapsed, paginationExcluded}`. It reads columns older crawls have
    too, so it judges every crawl.
  - `social.image-broken` (warning): per page, the first og:image and the first
    twitter:image, each if relative or malformed, answered non-200, or over 5 MB;
    evidence `{images: [{tag, url, problem, statusCode?, bytes?, fetchClass?, max?}]}`.
    A `problem` of `too-long` (pages crawled since Phase 26c only) is an address
    over `max` (2,500) characters, which the crawl neither stored nor fetched. A
    `problem` of `not-fetched` appears only on a crawl whose file check ran, and means this
    image was skipped by it (a budget, no record) or its request got no answer
    (`fetchClass` says which): report it as NOT CHECKED for that image, never as
    broken and never as a pass. When the file check asked about nothing on the
    whole crawl, no image is listed for that reason; the marker below says it once.
  - `social.image-insecure` (info): an https page whose `og:image` is an `http:`
    address and whose og:image:secure_url is absent or not `https:`; evidence
    `{ogImage, secureUrl}` (`secureUrl` only when given). It is not mixed content, as
    no browser loads an og:image; a platform that insists on https may drop the
    preview. Pages crawled since Phase 26c only: it reads a tag older extractions did
    not record, so `extraction.not-recorded` speaks for an older crawl.
  - `head.tags-outside-head` (warning): `social` in its `elements` when any Open
    Graph or X tag came after the head ended.
- **Crawl-level markers**: `extraction.not-recorded` (info) as above, and for the
  image's status and size the file-check markers `resources.not-recorded` (info, no
  file recorded) and `resources.not-fetched` (info, files recorded and none
  requested). Share images are not files a page loads, so those markers count page
  files; on a crawl that recorded no page file and whose pages count no image,
  `resources.not-fetched` counts the unrequested share images instead, so a crawl
  with the file check off that recorded any file meets one of the two. On a crawl whose check ran,
  `social.image-broken`'s `not-fetched` entries name each share image it missed.
- **Evaluate**:
  - PASS if every judged page carries a complete, consistent, head-placed social set
    and its share image loads
  - FAIL if any rule listed under this check fired (a `social.image-broken` finding
    whose every image is `not-fetched` is NOT MEASURED for those images, not FAIL)
  - NOT MEASURED if `extraction.not-recorded` (info) fired; if
    `resources.not-recorded` (info) or `resources.not-fetched` (info) fired, only
    the share image's status, size and `not-fetched` part is NOT MEASURED: a
    `relative` or `invalid` image in `social.image-broken` is judged without a
    fetch and stays FAIL
  - Record: the pages with each gap and the tags that are missing or conflicting

### CHECK-88: HTML document structure
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-88"` — `html.structure-invalid`
  (info: not exactly one `<head>` or one `<body>` tag, or a `<head>` tag after the
  `<body>`; Problems lists which), read beside the early-close pair filed under
  CHECK-18: `html.head-closed-early` (warning: an element or text the head does not
  allow ended it while head tags followed; Closing Element names it and Head Tags
  Lost lists them) and `html.head-closed-early-harmless` (info: the same early close
  with no head tag after it, so nothing is lost today). The check asks whether the
  HTML document is shaped so a parser reads it as written: one `<html>`, one `<head>`
  before one `<body>`, and a `<head>` that is not closed early by an element that does
  not belong in it (which pushes the tags after it, including the title, canonical and
  robots tags, out of the head). The `<head>` and `<body>` start tags are optional in
  HTML, so a page that leaves them out is valid and is not broken; it is still reported
  (head-missing / body-missing, info) because without them nothing marks where the head
  ends and one stray element moves the head tags into the body. Recommend explicit
  tags; do not describe such a page as invalid. The evidence is the document structure the crawler
  recorded while parsing each page. These facts exist only for crawls written by
  extraction version 2 or later: on an older crawl `extraction.not-recorded` (info) is the
  NOT MEASURED marker. The remedy is a re-crawl.
- **Evaluate**:
  - PASS if every judged page has a single, correctly ordered html, head and body and
    its head is not closed early. A page whose only problems are head-missing /
    body-missing (tags left out, which HTML allows) passes; record the explicit-tag
    recommendation beside it
  - FAIL if `html.head-closed-early` fired, or `html.structure-invalid` fired with a
    repeated or misplaced tag (head-repeated, body-repeated, head-after-body).
    `html.head-closed-early-harmless` alone is not a FAIL: record the element and
    recommend moving it into the `<body>`
  - NOT MEASURED if `extraction.not-recorded` (info) fired
  - Record: the pages, the structural fault and, for an early close, the tag that
    ended the head

---

## 10. On-Page SEO

### CHECK-35: Title tags — unique, intent-led, not truncated
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-35"` — ten rules:
  `title.missing` (critical), `title.too-short` (info, under 30 characters),
  `title.too-long` (info, over 60) and `title.duplicate` (warning), plus
  `title.pixel-too-long` (warning, wider than 561 pixels) and
  `title.pixel-too-short` (info, narrower than 200 pixels), which measure the
  title in the search result's font and do not judge a title with a character
  outside the Latin, Greek and Cyrillic scripts (the character rules still apply
  to it), plus `title.multiple` (warning, more than one `<title>` element; judged
  only on a crawl extracted at version 2, `extraction.not-recorded` speaks for an older
  one) and `title.same-as-h1` (info, the title and the first H1 equal after collapsing
  whitespace and ignoring case; judges every crawl), plus `head.tags-outside-head` (warning, a title or meta
  description after the `<head>` ended; since 26b its `elements` also names
  `social` for Open Graph or X tags there, which is CHECK-87's half of the same
  finding, so a row naming only `social` is not a title fault) and `render.title-changed` (warning, a
  rendered page whose title JavaScript changed; see CHECK-01 step 6). Use `pageType` on `issues_list` to get each count per
  template cohort directly, which is what the per-page-type breakdown below needs;
  `issue_urls` gives the titles themselves in the evidence, which is where the
  template patterns and the samples come from.

  **`title.duplicate` reports one finding per DUPLICATED TITLE, not per page.** Its
  evidence is `{title, count, pages}` — the shared title, exactly how many indexable
  pages carry it, and up to 20 of their URLs. So `issues_list`'s `count` is the number
  of duplicate groups and the pages involved are the sum of the groups' own `count`s:
  report both ("48 titles shared by 612 pages"), never the group count as a page
  count. Capped at 200 groups, with the usual `truncated`/`total` note when the site
  has more. Equality is exact after trimming — two titles differing by one character
  are two groups here, and near-duplication is CHECK-39's question, not this one.

  **Pages 2+ of a paginated series are left out of the duplicate rules.** A judged
  page that declares `rel=prev` repeats its listing's title by construction, so the
  three field-duplicate rules (`title.duplicate`, `meta-description.duplicate`,
  `h1.duplicate-text`) skip it. It is counted, not hidden: every group carries
  `paginationExcluded`, and `site.health` has `urlsPaginated`. Quote that count
  beside a duplicate total, and do not read the omission as "paginated pages were
  clean" — the other rules still judge them.
- **Important — Analyse by Page Type, Not Just Global Counts**: Saying "99% of titles are
  over 60 chars" tells the client nothing useful. Different page types have different title
  templates, different keyword needs, and different SERP competition. The analysis must
  break down by page type and assess the template pattern, not just count the numbers.
- **Analysis**:
  1. **Global counts**: missing, duplicate, over-60. Quick baseline.
  2. **Break down by page type**: For each type (product, collection, blog, info page),
     separately report:
     - Title template pattern (e.g., `{Product Name} – Brand - UK`)
     - Average length, min/max
     - % over 60 chars
     - Sample of 5 actual titles with SERP truncation preview
  3. **Title template assessment per page type**:

     **Products**: Is the title template optimised for product search?
     - Does it front-load the descriptive keywords or bury them after an internal style name?
     - Does it include product type ("dress", "jumpsuit") in the visible 60 chars?
     - Is the colour/key attribute visible before truncation?
     - Example issue: `"Anavine   Black Round-Neck Mini Dress With..."` — "Anavine" is an
       internal style name that means nothing to searchers, wasting prime title space

     **Collections**: Does the title communicate what the collection sells?
     - A title like `"Satin – Club L London"` tells Google nothing — it should be
       `"Satin Dresses for Women | Club L London"` with keyword modifiers
     - Marketing/editorial collection names ("French Riviera", "On Rotation") are meaningless
       in search — does the title include the actual product category keyword?
     - Are high-volume target queries (from CHECK-74) reflected in the title?

     **Blog**: Does the title match search intent for the topic?
     - Is it a clickable headline or an internal editorial reference?

     **Info/policy pages**: Are they descriptive?

  4. **Brand suffix analysis**:
     - What's the suffix? How many chars does it consume?
     - Is it consistent across page types?
     - Recommendation: brand suffix should be under 12 chars (e.g., `"| Club L"`)
       to leave 48+ chars for the descriptive part

  5. **Whitespace/formatting check**: Look for embedded newlines, double spaces, or
     template whitespace in title strings. These inflate character counts and may display
     oddly in SERPs. Check the raw title string for `\n`, `\r`, or multiple consecutive spaces.

  6. **SERP simulation**: For the top 10 pages by organic clicks (from CHECK-73),
     show what Google actually displays at 60 chars. Flag if important keywords are
     being cut off.

- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - FAIL if missing titles > 0
  - FAIL if collection titles lack category keywords (just marketing names + brand)
  - WARN if duplicates > 5% or over-60-char > 50% of pages
  - WARN if product titles front-load internal style names instead of descriptive keywords
  - WARN if brand suffix > 15 chars (wasting SERP real estate)
  - WARN if `title.pixel-too-long` (warning) > 0: the title is cut in the result;
    quote the count beside the over-60 count, since the two rules overlap but differ
  - INFO if `title.pixel-too-short` (info) > 0: report it with the too-short count
  - Record: **per-page-type breakdown** with template pattern, samples, and SERP truncation
    preview. Missing count, duplicate count, over-60 count, brand suffix analysis,
    whitespace issues, top duplicate title groups, SERP simulation for top 10 pages

### CHECK-36: Meta descriptions — unique, compelling, and correct length
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-36"` — `meta-description.missing`
  (warning), `meta-description.too-short` (info), `meta-description.too-long` (info)
  and `meta-description.duplicate` (warning), plus `meta-description.multiple`
  (warning, more than one meta description element; judged only on a crawl extracted
  at version 2) and `meta-description.pixel-too-long`
  (warning, wider than 985 pixels) and `meta-description.pixel-too-short` (info,
  narrower than 400 pixels), which measure the description in the search result's
  font and do not judge one with a character outside the Latin, Greek and Cyrillic
  scripts, plus `head.tags-outside-head` (warning,
  a meta description or title after the `<head>` ended; `social` in its `elements`
  is CHECK-87's half, see CHECK-35) and
  `render.meta-description-changed` (warning, a rendered page whose description
  JavaScript changed; see CHECK-01 step 6). Filter by `pageType` for the per-type
  breakdown; `issue_urls` carries each description and its length, which is what the
  quality spot-check reads. The duplicate rule has CHECK-35's group shape exactly —
  one finding per shared description, evidence `{metaDescription, count, pages}` — so
  quote the group count and the page total together. The same rel=prev exclusion
  as CHECK-35 applies (`paginationExcluded` on each group). The length rules: too
  short is under 70 characters, too long is over 155. A template dumping one
  description across a whole cohort is a single group with a very large `count`, which
  is the shape the Analysis below calls a template-generated duplicate.
- **Analysis** (break down by page type, same as CHECK-35):
  1. **Missing count by page type**: Products, collections, blog, info pages separately.
     Blog and info pages often have the highest missing rate — report this specifically.
  2. **Length analysis by page type**: Check average, min, max length per type.
     - Meta descriptions over 155 chars will be truncated/rewritten by Google
     - Under 70 chars may be too short to be compelling
     - Flag if average length is >200 chars (means the template is dumping full product
       descriptions into the meta tag instead of a crafted SERP snippet)
  3. **Quality spot-check**: Read 5 sample descriptions per page type. Are they:
     - Crafted SERP copy that encourages clicks? Or auto-generated from product descriptions?
     - Containing a call to action or value proposition?
     - Within 70-155 char range for optimal SERP display?
     - Garbage content? (e.g., data tables, code, repeated text scraped from page body)
  4. **Duplicate analysis**: Group duplicates by page type. Template-generated duplicates
     (all products share the same description) are worse than coincidental duplicates.
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - WARN if missing > 10% for any page type
  - WARN if duplicates > 5%
  - WARN if `meta-description.pixel-too-long` (warning) > 0: Google cuts the snippet
    in the result; quote the count beside the over-155 count
  - INFO if `meta-description.pixel-too-short` (info) > 0: report it with the too-short count
  - **WARN if average length > 200 chars** (descriptions are being truncated — likely
    auto-generated from full product copy rather than crafted for SERPs)
  - FAIL if garbage content found in meta descriptions (data tables, code, foreign language dumps)
  - Record: **per-page-type breakdown** — missing count, average length, over-155 count,
    quality assessment with samples, duplicate groups

### CHECK-37: H1 and heading hierarchy
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-37"` — `headings.h1-missing`
  (warning), `headings.h1-multiple` (info), `headings.h1-too-long` (info, first H1
  over 70 characters), `headings.level-skip` (info),
  `h2.missing` (info, no H2 on the page; judges every crawl), `h2.too-long` (info, first
  H2 over 70 characters) and `h2.duplicate` (info, the first H2 shared across pages,
  grouped as `h1.duplicate-text` is; the last two need a crawl extracted at version 2),
  `h1.duplicate-text` (warning; rel=prev pages left out, see CHECK-35),
  `h1.duplicate-skipped` (info) and
  `render.h1-changed` (warning, a rendered page whose first H1 JavaScript changed;
  see CHECK-01 step 6). Filter by `pageType` for the per-template counts.

  **What the engine knows about heading TEXT, precisely.** It stores each page's
  FIRST H1 as text (collapsed, trimmed, capped at 300 characters) and compares those
  strings to each other: `h1.duplicate-text` reports one finding per shared heading,
  evidence `{h1Text, count, pages}`, group-shaped exactly as CHECK-35's duplicate rule
  is. Two consequences worth stating in the finding: a page with three H1s contributes
  only its first, so a duplicate among the others is invisible; and the text is not
  published per page anywhere else, so the H1 ↔ title alignment work in step 4 below
  is still a sampled browser reading rather than a query.

  **`h1.duplicate-skipped` is a NOT MEASURED marker, not a pass.** It fires when the
  crawl stored no heading text at all while its pages do carry H1 elements — a
  pre-Phase-7 crawl. Then the duplicate-heading question is unanswered on this crawl
  and the answer is a re-crawl; record it as such rather than as zero duplicates.
- **Analysis**:
  1. **Global counts**: missing, multiple, level skips and duplicate headings — all
     from `issues_list`. For the duplicates, report the group count and the pages they
     cover separately.
  2. **Break down multiple H1s by page type** with the `pageType` filter. If a whole
     cohort has the same H1 count above one, a template element is coded as an H1
     (e.g., a geo banner, promo bar, store selector). Confirm WHICH element in the
     browser — one page of the cohort is enough, because the engine has already told
     you the pattern is site-wide.
  3. **If a rogue template H1 is found — TRACE IT in the browser** (one page only):
     Navigate to any page and run this to get the element's DOM location for the dev fix:
     ```javascript
     Array.from(document.querySelectorAll('h1')).map(function(h) {
       return {
         text: h.textContent.trim().substring(0, 60),
         id: h.id,
         classes: h.className,
         parentClasses: h.parentElement?.className,
         grandparentClasses: h.parentElement?.parentElement?.className,
         visible: h.offsetHeight > 0
       };
     })
     ```
     Use this to tell the dev team:
     - **What element it is**: e.g., "geo-detection banner with class `.store-select__heading`"
     - **Which theme file**: class names map to Liquid templates
       (e.g., `.store-select` → `sections/store-selector.liquid`)
     - **The exact fix**: "Change `<h1 class="store-select__heading">` to `<div class="store-select__heading">`"
  4. **H1 ↔ Title alignment check**: For each page type, does the H1 match the title?
     The engine holds the titles (CHECK-35's evidence) and publishes H1 text only for
     the headings that DUPLICATE each other, so a page-by-page comparison is still a
     sampled browser reading — take 3-5 pages per page type from `pages_query`, read
     both, and say the sample size in the finding.
     They don't need to be identical, but they should reinforce the same topic/keyword.
     **Normalise whitespace before comparing** — collapse multiple spaces, strip newlines,
     and trim. Template whitespace differences (double space vs single space) are a
     formatting bug to flag separately, not a content mismatch.
     Flag if <50% alignment on any page type — it usually means the title template and H1
     template are pulling from different fields.
  5. **H1 keyword assessment** (same logic as CHECK-35 for titles):
     - Product H1s: do they include the product type keyword (dress, jumpsuit)?
     - Collection H1s: do they include the category keyword or just a marketing label?
     - Are H1s descriptive enough for search intent?
  6. **Full heading hierarchy check** (DevTools): On 2-3 page types, extract all headings
     (`h1,h2,h3,h4,h5,h6`) and check the logical structure:
     - Is there a clean H1 → H2 → H3 hierarchy?
     - Are headings used for non-heading elements (nav items as H3, promo text as H4)?
     - Are semantic sections properly headed?
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - FAIL if missing H1 > 0
  - **FAIL if a template element is incorrectly coded as H1 across all pages** — this is
    a single theme fix (change the tag from `<h1>` to `<div>`) and is always critical
  - WARN if multiple H1 > 5%
  - WARN if H1 ↔ title alignment < 50% on any page type
  - WARN if non-heading elements use heading tags (nav as H3, promo as H4)
  - Record: missing, multiple, duplicate counts, **H1-1 and H1-2 text for each page type**,
    H1 ↔ title alignment %, heading hierarchy assessment, specific template element
    identified if a non-heading is using H1/H2/H3 tags

### CHECK-38: Content quality and intent match
- **Priority**: High | **Requires**: Visual + DevTools + Engine (evidence only)
- **AGENT CHECK — the verdict is yours.** No rule judges this one: whether a page
  serves the intent it targets is not something a crawl settles, and a rule that
  claimed it would be a rule that always passes. Two metrics supply EVIDENCE and
  make no claim:
  - `metrics_get` with `metricId: "content.metrics-by-type"` — the word-count
    distribution per page type, so "the blog is thin" is a number rather than an
    impression
  - `metrics_get` with `metricId: "content.template-similarity"` — how alike the
    pages of each template are, which is where "every product description is the
    same paragraph" shows up
  Quote both, then judge. `issues_list` with `checkId: "CHECK-38"` is refused with the
  metric-only message — the two rules above are all this check has, and neither of
  them finds anything.
- **Visual**: Navigate to 5 key page types (homepage, product, collection, blog, info page). Visually assess:
  1. Content depth — is there substantial, useful content?
  2. Intent match — does the page serve the likely search intent (informational vs transactional)?
  3. Above-the-fold — what does the user see first? Is key content visible without scrolling?
  4. CTAs and conversion elements — clear and accessible?
  5. Take screenshot of each page type for the audit report
- **Blog/article quality** (important — don't rely on analytics data alone):
  1. Navigate to 3-5 random blog/article pages (not just top performers)
  2. Assess each article: depth of coverage, originality, usefulness, readability
  3. Check: is this clearly human-written expert content or generic/AI-generated filler?
  4. Check: does it answer the topic thoroughly or just skim the surface?
  5. Check: are there internal links to relevant products/services/resources?
  6. Note: thin blog content damages site-wide quality signals even if individual articles get low traffic
- **Evaluate**: Subjective — note content quality per page type, with specific blog quality assessment
- **Record**: qualitative assessment per page type, blog article quality sample (3-5 articles reviewed), screenshots

### CHECK-39: Near-duplicate content — root cause analysis
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-39"` — two rules and a marker:
  - `content.exact-duplicate` (critical) — pages whose body content is identical
  - `content.near-duplicate` (warning) — pages alike past the similarity threshold
  - `content.near-duplicate-skipped` (info) — the NOT MEASURED marker for the second
    of them, below
  `issue_urls` gives them: `content.near-duplicate` writes one finding per PAGE
  (`{mainWords, nearDuplicates, closest}` — `nearDuplicates` is how many other pages
  sit within the threshold of this one, exact up to 200 and a FLOOR above it, where
  `nearDuplicatesAtLeast: true` sits beside it and the honest reading is "200 or
  more"; `mainWords` is how much content this
  page has of its own, and `closest` names up to five of the partners, nearest first,
  as `{url, hamming, mainWords}`), and `content.exact-duplicate`
  one per identical group (`{contentHash, urls, count, pageTypes}`). For the
  template-level view, `metrics_get` with `metricId: "content.template-similarity"`
  says how alike each cohort's pages are on average — a cohort that is uniformly
  similar is root cause (b) or (d) below before you open a single page.
- **What the similarity is measured over, and who is left out.** The near-duplicate
  fingerprint is taken over each page's MAIN CONTENT — the text inside `<main>`, or
  the body with `<nav>`, `<header>`, `<footer>` and `<aside>` removed when there is
  no `<main>` — and not over the whole visible text. On a templated site the whole
  text is mostly furniture, and comparing it reports unrelated templates as
  near-identical; the crawl this came from produced 237 such pairs. Two further
  exclusions, both of which mean a REAL pair may be absent from the list rather than
  present in it: a page needs at least 50 words of its own before it is compared
  (below that the fingerprint is a handful of tokens and every near-empty page on a
  template matches every other — `content.thin` owns those pages), and a page whose
  declared canonical points at another URL is not compared at all, on either rule,
  because it has already handed its signals over.
- **`content.near-duplicate-skipped` is the NOT MEASURED marker** for the
  near-duplicate half of this check (`content.thin-skipped` / `h1.duplicate-skipped`
  precedent). It fires once, site-scoped, when the crawl holds auditable indexable
  pages and NOT ONE of them carries a main-content fingerprint — a crawl taken before
  migration 0018 introduced it. Evidence `{indexablePages, minMainWords}`. **While it
  fires, an empty near-duplicate list is not a clean site**: the check was not run and
  a re-crawl is the only thing that answers it. The exact-duplicate half is
  unaffected — it groups on the whole-text hash, which every crawl has — so its
  findings, or its silence, still stand. It does NOT fire on a current crawl where
  only SOME pages lack the fingerprint (a page with no main content is simply not a
  candidate, the same way a page the analyzer produced no `contentHash` for is not a
  candidate for the exact rule).
- **Important — Identify the CAUSE, Not Just the Count**: A near-duplicate report can have
  thousands of pages. Reporting "3K near-duplicate pages found" is useless without
  understanding WHY they're duplicates. The root cause determines the fix — and different
  causes need completely different solutions.
- **Analysis**:
  1. **Quantify the scale**: Total pages reported, how large each page's cluster is
     (`nearDuplicates`), similarity distribution (the `hamming` values in `closest`)
  2. **Classify pair types**: group each finding with the pages in its `closest` list,
     by URL type combination:
     - Product ↔ Product (most common on e-commerce)
     - Collection ↔ Collection
     - Collection ↔ Page
     - Page ↔ Page
     - Blog ↔ Collection
  3. **Identify root causes through browser comparison** (MANDATORY):
     Navigate to 2-3 pairs from each major pair type. For each pair:
     - Open both URLs side by side
     - Extract the product/page description text from each
     - Compare: what's identical? What differs? Is it just a colour/size word swap?
     - Check: is the unique content drowning in template boilerplate (nav, footer, shipping info)?

     **Common root causes to look for:**

     **a) Colour variants as separate URLs**: Same product in different colours gets its
     own URL with a copy-paste description where only the colour word changes. This is
     the most common cause on fashion/apparel sites. The fix is NOT to merge the URLs
     (colour variants should have separate pages for SEO) — the fix is to write unique
     descriptions per colour variant that go beyond swapping one word.

     **b) Template boilerplate domination**: Pages with very little unique content (empty
     collections, thin utility pages) appear as duplicates because the shared template
     (nav, footer, promo bar, cookie consent, delivery info) makes up 95%+ of the text.
     The fix is either adding unique content or noindexing genuinely empty pages.

     **c) Overlapping collections**: Multiple collections targeting similar themes
     (e.g., "burgundy dresses" vs "best-selling burgundy dresses") with the same products
     and no differentiating editorial copy. Fix: consolidate or add unique copy per collection.

     **d) Product template padding**: Product pages include large blocks of shared content
     (shipping info, returns policy, size guide) that dwarfs the unique product description.
     Fix: move shared content to expandable sections so the unique description is the
     bulk of the page's text. (The engine's similarity comparison reads the extracted
     body text, boilerplate included, so a template that dwarfs its unique copy is
     what `content.near-duplicate` will keep reporting until the copy changes.)

  4. **Present findings by root cause**, not just raw pairs:
     ```
     | Root Cause | Pairs | % | Example | Fix |
     |------------|-------|---|---------|-----|
     | Colour variant copy-paste | X | X% | Nobu Black ↔ Nobu Burgundy | Unique descriptions per variant |
     | Template boilerplate | X | X% | on-rotation ↔ studentbeans | Add unique content or noindex |
     | Overlapping collections | X | X% | burgundy ↔ best-selling burgundy | Consolidate or differentiate |
     ```

  5. **Cross-reference with CHECK-78** (data-driven cannibalisation from GSC) — near-duplicate
     content pairs often map to the same cannibalising query groups there
- **Evaluate**:
  - FAIL if colour variant pages have identical descriptions (only colour word differs)
  - WARN if >20% of near-duplicate pages are from template boilerplate domination
  - WARN if overlapping collections compete for the same queries
  - Record: total pairs, pair type breakdown, **root cause breakdown with examples**,
    browser comparison findings, recommended fix per root cause

### CHECK-40: Thin or placeholder content
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-40"` — `content.thin` (warning, the
  same rule CHECK-13 reads: fewer than 150 words of the page's OWN content, evidence
  `{mainWords, wordCount, threshold}`), `content.thin-skipped` (info, the same marker
  CHECK-13 reads: one site-scoped finding on a crawl where NO page carries a
  main-content word count, which is what a crawl taken before migration 0018 looks
  like — a re-crawl is the fix, and while it fires the thin list is not evidence of
  anything) and `content.placeholder` (critical: the literal
  phrase "lorem ipsum" left in live copy — no other placeholder wording is detected).
  `content.placeholder`'s evidence is `{wordCount, snippet}`, and **the snippet is the
  point**: quote it in the report rather than the URL alone. The finding is often not
  about the article body — the crawl this came from hit three 1,000-word posts whose
  placeholder text was the excerpt and the meta description, visible on the listing
  page and in every related-post card and nowhere on the post itself. `snippet` is
  null on a crawl taken before the engine quoted the match; the finding still stands,
  only the quotation is missing, and a re-crawl supplies it.
  `issue_urls` for all three; filter `issues_list` by
  `pageType` to say which templates the thin pages belong to, and read
  `content.metrics-by-type` for the distributions behind the threshold — it carries
  `wordCount`, `renderableWordCount` and `textRatio` per template. **The pair is the
  finding**: a template whose median word count is 900 and whose pages each say 100
  words of their own ships 800 words of furniture on every page, and the thin verdict
  was reached on the 100 (`mainWords` in the finding; the metric's medians are
  whole-document numbers and are the context around it, not the verdict).
- **Evaluate**:
  - FAIL if lorem ipsum > 0 (immediate fix needed)
  - WARN if low content > 10% of indexable pages
  - Record: lorem ipsum count + URLs, low content count by page type

### CHECK-41: E-E-A-T signals
- **Priority**: Medium | **Requires**: Visual + DevTools + Manual
- **AGENT CHECK — no engine evidence at all.** Nothing a crawl stores is evidence for
  E-E-A-T that a rule could summarise without also implying the verdict, so no rule of
  any kind claims this check. `issues_list` with `checkId: "CHECK-41"` is refused
  ("claimed by no rule"), and `metrics_get` has no `checkId` parameter at all — it
  filters by `metricId`, `scope` and `scopeValue`, and passing a `checkId` is rejected
  by the tool schema before the service sees it. There is no engine answer to look up.
  The work below is the whole check, and the findings record must carry what you
  actually saw, not a score with nothing under it.
- **Important**: E-E-A-T is not just about surface signals (badges, bios). It must be
  assessed through the actual content, site structure, and topical depth.
- **Experience & Expertise** (assess through content):
  1. Navigate to 3-5 key content pages (blog posts, guides, product descriptions)
  2. Does the content demonstrate first-hand experience with the topic?
  3. Does it show deep expertise (specific details, nuance, practical advice)?
  4. Are claims backed by evidence, data, or references?
  5. Check internal linking: do content pieces link to related topics forming topic clusters?
  6. Is there a coherent topical architecture (pillar pages → subtopics → related content)?
- **Authoritativeness** (assess through site structure):
  1. Navigate to About page — does it establish who is behind the content?
  2. Check for author bios with photos, credentials, and relevant experience
  3. Check for editorial standards or content policy pages
  4. Look for industry certifications, awards, partnerships
- **Trustworthiness** (assess through signals):
  1. Check for trust badges, security seals, customer reviews
  2. Check policy pages: shipping, returns, privacy, terms
  3. Check contact information: physical address, phone, email
- **Topic clustering** (DevTools):
  1. From a key content page, extract internal links: `Array.from(document.querySelectorAll('article a[href], .content a[href]')).map(a => a.href)`
  2. Do content pages link to related subtopics? Is there a hub-and-spoke pattern?
  3. Cross-reference with CHECK-33 (inlinks) — are topic cluster pages well-interlinked?
- **Evaluate**: Assess each E-E-A-T component separately. Especially important for YMYL topics.
- **Record**: Experience score (content depth), Expertise score (demonstrated knowledge), Authoritativeness score (credentials/recognition), Trustworthiness score (trust signals), topic clustering assessment

### CHECK-42: Expired/out-of-stock product handling
- **Priority**: Low | **Requires**: Visual + Engine (context only)
- **AGENT CHECK — the verdict is yours.** No rule claims it: "is this the right way
  to handle an out-of-stock product" is a strategy question, not a fact about the
  markup. For context, `issues_list` with `checkId: "CHECK-13"` (`content.soft-404`)
  shows pages that answer 200 while reading as gone, which is one bad OOS pattern —
  cite it if it fires, but the check is answered in the browser.
- **Visual**: Find an OOS product if possible — check: clear OOS message? Suggests alternatives? Add-to-cart disabled?
- **Evaluate**: Note OOS strategy. WARN if no clear strategy
- **Record**: OOS handling method observed

---

## 11. Structured Data

### CHECK-43: Schema markup audit — types, gaps, and opportunities
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-43"` — `schema.none-on-site` (info):
  the crawl stored no JSON-LD of any type, anywhere. That is the categorical case; a
  site with markup fires nothing here and is judged through its siblings —
  `schema.product-incomplete` (CHECK-44), `schema.breadcrumb-absent` (CHECK-45) and
  `schema.self-serving-reviews` (CHECK-46). Read all four before writing this check up.
  The engine extracts JSON-LD during the crawl, so there is no "validation was not
  enabled" case: if `schema.none-on-site` did not fire, the site published markup.
- **DevTools** (the per-page-type matrix and the opportunity assessment below need the
  documents themselves, which the query surface does not expose):
  - Execute on one page per page type: `JSON.stringify(Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => JSON.parse(s.textContent)['@type']))`
- **Important — Audit Issues AND Opportunities**: This check must cover three things:
  1. **Validation errors** in existing schema (what's broken)
  2. **Missing schema types** that should exist for this site profile (what's absent)
  3. **Missing fields** within existing schema types (what's incomplete)
  Do NOT only report errors. A site can have zero validation errors but still be missing
  high-impact schema types entirely. The opportunity assessment is often more valuable
  than the error list.
- **Analysis**:
  1. Extract JSON-LD from each page type (homepage, product, collection, blog, info page)
  2. Build a current state matrix:

     | Page Type | Schema Types Present | Key Fields |
     |-----------|---------------------|------------|
     | Homepage  | ? | ? |
     | Product   | ? | ? |
     | Collection| ? | ? |
     | Blog      | ? | ? |
     | Info/policy| ? | ? |

  3. Compare against the **expected schema for the site profile**. Use this reference
     table based on site type:

     **E-commerce (fashion/retail):**
     | Page Type | Expected Schema | Rich Result Eligible |
     |-----------|----------------|---------------------|
     | Homepage | Organization (NOT LocalBusiness unless physical stores) | Sitelinks search box, logo |
     | Product pages | Product + Offers + AggregateRating + BreadcrumbList | Product rich results, star ratings, price |
     | Collection pages | ItemList (listing products with position) + BreadcrumbList | Carousel/list results |
     | Blog/articles | Article or BlogPosting + BreadcrumbList | Article rich results |
     | FAQ/policy pages | FAQPage | FAQ accordion in SERPs |
     | Size guide | FAQPage or HowTo | Rich snippet |

     **Common mistakes to flag:**
     - LocalBusiness on every page (should be Organization unless physical retail)
     - LocalBusiness without `geo` property (causes validation errors on every page)
     - Product schema without GTIN/EAN (blocks Google Shopping eligibility)
     - Product without aggregateRating (misses star ratings in SERPs)
     - Collection pages with NO product-level schema (no ItemList)
     - BreadcrumbList with only 2 levels (should include category/collection level)
     - Article schema with non-ISO 8601 dates
     - Missing FAQ schema on high-traffic policy pages

  4. For **collection/category pages** specifically: check if there's an `ItemList` schema
     listing the products. This is a commonly missed opportunity — collection pages often
     have zero product schema even though they're the primary category landing pages.
     `ItemList` with `ListItem` elements (position, name, url, image) tells Google this
     is a product listing and can produce carousel results.

  5. Present findings as two sections:
     - **Issues**: Validation errors and incorrect schema (what needs fixing)
     - **Opportunities**: Missing schema types and fields (what should be added)

- **Evaluate**:
  - FAIL if validation errors > 0
  - WARN if high-impact schema types are missing for the site profile
  - Record: schema types per page type, validation errors, **opportunities matrix showing
    current vs recommended schema per page type**, specific missing fields

### CHECK-44: Product schema completeness
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-44"` — `schema.product-incomplete`
  (warning): a page carrying Product markup that is missing required or recommended
  fields. `issue_urls` names the missing fields PER PAGE in the evidence, across
  every product page the crawl reached — which is the field checklist below, answered
  at site scale instead of on the one product page a person opened.
  A product page with NO Product markup at all is the other half, **and the surface
  cannot answer it today.** A rule that found nothing is simply absent from
  `issues_list`; there is no pages-considered count beside it, so "every product's
  markup is complete" and "no product page carries Product markup at all" are
  indistinguishable from a silent `schema.product-incomplete`. Do not try to close
  the gap by comparing the product cohort's size against a number the surface does
  not publish. Where the site-scoped `schema.none-on-site` is also silent you know
  the crawl stored JSON-LD SOMEWHERE, which is weaker than it sounds and is not
  per-cohort. So: a silent rule here is `SKIP` with the ambiguity written out, and
  a browser reading of one product page settles it for that page — the missing
  count is on the engine backlog, not something to estimate around.
- **DevTools** (only for the structure the rule does not judge — the `offers` shape and
  the price format):
  1. Navigate to a product page the engine flagged
  2. Execute: `JSON.stringify(Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => JSON.parse(s.textContent)).filter(d => d['@type'] === 'Product')[0], null, 2)`
  3. The fields the engine checks for, so you can read its evidence against them:

     **Required fields** (must have):
     - name, description, image, url, sku, brand
     - offers: price, priceCurrency, availability, url

     **Recommended fields** (high impact if missing):
     - gtin / gtin13 / ean / mpn — product identifiers for Google Shopping
     - aggregateRating — enables star ratings in SERPs
     - review — individual reviews supporting the rating
     - color — critical for fashion/apparel (high-volume colour queries)
     - material — important for fashion (lace, satin, sequin = search terms)
     - size / pattern — additional product attributes

     **Nice-to-have fields**:
     - weight, width, height — shipping-relevant
     - itemCondition — new/used
     - category — Google product taxonomy

  4. Check the `offers` structure: is it a single Offer or array of Offers (one per
     variant/size)? An array with per-size availability is richer than a single offer.
  5. Check price format: must use decimal point (225.95) not comma (225,95)
- **Evaluate**:
  - FAIL if Product schema missing on product pages
  - FAIL if missing GTIN/identifiers (blocks Google Shopping features)
  - WARN if missing aggregateRating, color, material
  - Record: fields present/absent as a checklist, **specific field-level opportunities
    ranked by impact**

### CHECK-45: BreadcrumbList schema
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-45"` — `schema.breadcrumb-absent`
  (info): the crawl found no `BreadcrumbList` anywhere on this site. Site-scoped, so
  it is one finding rather than a page list, and its evidence carries the indexable
  page count it saw — the rule stays quiet on a site too small to have a hierarchy
  worth marking up.
- **DevTools**: If breadcrumbs DO exist, the accuracy half is a browser check — on a
  product/collection page, extract the BreadcrumbList JSON-LD and compare it to the
  visible breadcrumb
- **Evaluate**:
  - WARN if BreadcrumbList missing
  - FAIL if schema doesn't match visible breadcrumb
  - Record: presence, accuracy

### CHECK-46: Review & rating markup
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-46"` — `schema.self-serving-reviews`
  (info): pages publishing review or rating markup the site wrote about itself, which
  Google's guidelines exclude from rich results. `issue_urls` for the pages.
- **DevTools**: Where the markup exists and the rule is quiet, spot-check one product
  page for the Review/AggregateRating shape and its source attribution
- **Evaluate**:
  - Note presence/absence
  - WARN if self-serving reviews without third-party source
  - Record: review schema type, source, compliance

---

## 12. Performance & CWV

### CHECK-47: Core Web Vitals — LCP, INP, CLS
- **Priority**: High | **Requires**: DevTools
- **Engine**: NOT MEASURED. What the engine records about performance is response
  time per page (CHECK-50) and, since the resource pass, how many bytes each page is
  made of (CHECK-48 / CHECK-49) — no more than that: it does not call PageSpeed, does
  not collect CrUX field data and does not compute Core Web Vitals. Page weight is an
  input to LCP and not a measurement of it, so quoting `page.weight` here is context
  and never a verdict. This check is browser work in full, and if no browser is
  available it is SKIP — never PASS.
- **DevTools**: Run Lighthouse audit on 3-5 key page types (homepage, product, collection, blog, search)
- **Evaluate**:
  - Prefer CrUX field data (p75) if available; otherwise lab Lighthouse data
  - FAIL if any CWV "Poor" (LCP >4s, INP >500ms, CLS >0.25)
  - WARN if "Needs Improvement" (LCP 2.5-4s, INP 200-500ms, CLS 0.1-0.25)
  - Record: LCP, INP, CLS per page type

### CHECK-48: Render-blocking resources and JS bundle size
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `metrics_get` with `metricId: "page.weight"` — the script-byte
  distribution per page type, which is the BUNDLE SIZE half of this check, measured
  by asking the server for every script the served HTML declares rather than by
  reading one page in a browser. Read the row's `resourcesReferenced` and
  `resourcesWeighed` before quoting any of it: a row that weighed a fraction of what
  it referenced is a floor. The other half is NOT MEASURED and stays browser work —
  whether a script blocks rendering (nothing stored says async, defer or where in the
  document it sits) and how much of it goes unused (that needs coverage data from a
  running browser). Scripts a page loads with JavaScript are outside the measurement
  entirely, so on a client-rendered site the engine's number is a floor of a floor.
  **Call `issues_list` with `checkId: "CHECK-48"` before quoting the table**, and read
  its answer first: the two findings it can return are the resource family's NOT
  MEASURED markers, and exactly one of them can be present. `resources.not-recorded`
  (info) fires when the crawl holds no resource records at all; `resources.not-fetched`
  (info) fires when it recorded every file the pages point at and asked the site about
  none of them — its evidence says which of the three reasons applies: the operator's
  `fetchResources: false`, a pass that never sent a request, or a resource budget
  that claimed every row before anything was asked. Whichever it is, the
  `page.weight` row above is a table of HTML sizes and nothing else — a light-looking
  site that was never measured — and this check is NOT MEASURED on that crawl rather
  than passed. The remedy is a re-crawl, and each marker says so.
  **The window that once had no marker, now closed** (P13-T2): on a crawl where every
  file landed in an unknown class — refused by our own policy, disallowed by a
  robots.txt, its host's robots.txt unreachable while we crawled, or a request that
  never completed — rows WERE decided, so neither `resources.not-recorded` nor
  `resources.not-fetched` fires and the four judging rules are silent anyway.
  `resources.all-unknown` (info) is the marker that now fires there: its evidence
  carries the per-class census and names the dominant class, and
  `crawl_status.resources` is the discriminator it puts a name to — `fetched` at zero
  with `failed`, `robotsDenied` and `robotsUnreachable` carrying the census. When it
  is present this check is NOT MEASURED rather than PASS, and the remedy is a re-crawl.
  **And its narrower sibling, the last of the family** (P14-T1): a PARTIAL pass that
  reached only some of the files, got an unknown from every one it reached, and never
  asked about the rest — no `ok` row and no broken row — fires none of the other three
  markers either, because the rows exist, are not all null, and are not all decided.
  `resources.partial-unknown` (info) is the marker that now fires there, carrying the
  per-class census, the count of files the pass never reached, and the dominant class.
  When it is present this check is NOT MEASURED rather than PASS, and the remedy is a
  re-crawl or a resume.
- **DevTools**: Lighthouse audit — check "Eliminate render-blocking resources" and "Reduce unused JavaScript"
- **Evaluate**:
  - WARN if render-blocking resources > 3 or unused JS > 50%
  - Record: render-blocking list, unused JS percentage

### CHECK-49: Image optimisation and responsive images
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-49"` — eight rule ids can come back,
  six of them findings about the site and two about the crawl.
  `images.missing-dimensions` (info) and `images.missing-alt` (warning), page by page
  across the whole crawl, with `issue_urls` naming the pages and the offending
  images (on a page crawled with extraction 2, `images.missing-alt` also lists up to
  ten image addresses); `images.empty-alt` (info) for pages with `alt=""` images,
  which is right for decorative images and is a count to review, and
  `images.alt-too-long` (info) for alt text over 100 characters; and, since the resource pass, `images.oversized` (warning) for every image
  over the 100,000 bytes this check's own WARN line names, and `images.legacy-format`
  (info) for the heavy ones a server sent as PNG or JPEG. Both name the FILE and say
  how many pages carry it, which is what turns "oversized image count" into a list of
  jobs. `metrics_get` with `metricId: "page.weight"` gives the image-byte distribution
  per template beside them. Two limits to state whenever these are quoted: the crawl
  never decodes an image, so nothing here says whether one is over-compressed or
  larger than the box it is displayed in; and only images named in the HTML the
  server sent are weighed, so a client-rendered gallery is invisible to all of it.
  RESPONSIVE IMAGES are still browser work — `srcset` is read for its first candidate
  and nothing checks whether the set is sensible. The last two ids are the resource
  family's NOT MEASURED markers, and only one of them can be present:
  `resources.not-recorded` (info), which means the crawl recorded no files at all, and
  `resources.not-fetched` (info), which means it recorded them and asked about none.
  When either is there the silence of `images.oversized` and `images.legacy-format`
  says the crawl never asked rather than that the images are fine — the weight and
  format halves of this check are then NOT MEASURED and a re-crawl is what answers
  them. The two older findings are unaffected by either; they read the page's markup,
  not the files.
  **The window that once had no marker, now closed** (P13-T2): on a crawl where every
  file landed in an unknown class — refused by our own policy, disallowed by a
  robots.txt, its host's robots.txt unreachable while we crawled, or a request that
  never completed — rows WERE decided, so neither `resources.not-recorded` nor
  `resources.not-fetched` fires and the four judging rules are silent anyway.
  `resources.all-unknown` (info) is the marker that now fires there: its evidence
  carries the per-class census and names the dominant class, and
  `crawl_status.resources` is the discriminator it puts a name to — `fetched` at zero
  with `failed`, `robotsDenied` and `robotsUnreachable` carrying the census. When it
  is present this check is NOT MEASURED rather than PASS, and the remedy is a re-crawl.
  **And its narrower sibling, the last of the family** (P14-T1): a PARTIAL pass that
  reached only some of the files, got an unknown from every one it reached, and never
  asked about the rest — no `ok` row and no broken row — fires none of the other three
  markers either, because the rows exist, are not all null, and are not all decided.
  `resources.partial-unknown` (info) is the marker that now fires there, carrying the
  per-class census, the count of files the pass never reached, and the dominant class.
  When it is present the weight and format halves are NOT MEASURED rather than PASS, and
  the remedy is a re-crawl or a resume.
- **DevTools**: Check the network panel for image formats (WebP/AVIF vs PNG/JPG) and file
  sizes. Check srcset/sizes on product images
- **Crawl-level marker**: `extraction.not-recorded` (info) is the NOT MEASURED marker for the page facts this check reads from extraction version 2: on a crawl extracted before them (or one mixing old and new pages) the rules that read those facts did not run, so their part of this check is NOT MEASURED, never a pass. The remedy is a re-crawl.
- **Evaluate**:
  - WARN if >100KB images on key pages, no modern formats, or missing dimensions
  - Record: oversized image count, format breakdown, missing dimensions count

### CHECK-50: TTFB, caching, and compression
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-50"` — `performance.slow-response`
  (warning): pages whose response time crossed the threshold, with the measured time in
  the evidence. This is server response time over a whole crawl, which is a better
  sample than one browser load. Beside it, `resources.uncached` (info) answers the
  CACHING half for static files: one site-scoped finding counting the files the crawl
  fetched that came back with neither a `Cache-Control` nor an `Expires` header, with
  up to twenty of them named. Two headers is all that is stored, so a CDN's own edge
  caching and ETag revalidation are invisible, and the finding says the response gave
  no instruction rather than that the file is re-downloaded. The HTML documents' own
  caching headers are not stored at all — this is about the images, stylesheets and
  scripts. Either of the resource family's two NOT MEASURED markers can come back from
  the same call — `resources.not-recorded` (info) when the crawl holds no resource
  records, `resources.not-fetched` (info) when it holds them all and asked about none
  — and when one is present this crawl fetched no files at all, so a quiet
  `resources.uncached` says nothing about the site's caching and the answer is a
  re-crawl. COMPRESSION and PROTOCOL are still NOT MEASURED and stay browser work.
  **The window that once had no marker, now closed** (P13-T2): on a crawl where every
  file landed in an unknown class — refused by our own policy, disallowed by a
  robots.txt, its host's robots.txt unreachable while we crawled, or a request that
  never completed — rows WERE decided, so neither `resources.not-recorded` nor
  `resources.not-fetched` fires and the four judging rules are silent anyway.
  `resources.all-unknown` (info) is the marker that now fires there: its evidence
  carries the per-class census and names the dominant class, and
  `crawl_status.resources` is the discriminator it puts a name to — `fetched` at zero
  with `failed`, `robotsDenied` and `robotsUnreachable` carrying the census. When it
  is present this check is NOT MEASURED rather than PASS, and the remedy is a re-crawl.
  **And its narrower sibling, the last of the family** (P14-T1): a PARTIAL pass that
  reached only some of the files, got an unknown from every one it reached, and never
  asked about the rest — no `ok` row and no broken row — fires none of the other three
  markers either, because the rows exist, are not all null, and are not all decided.
  `resources.partial-unknown` (info) is the marker that now fires there, carrying the
  per-class census, the count of files the pass never reached, and the dominant class.
  When it is present the caching half is NOT MEASURED rather than PASS, and the remedy
  is a re-crawl or a resume.
- **DevTools**: Check the homepage's network panel for TTFB and response headers
  (Cache-Control, Content-Encoding, protocol)
- **Evaluate**:
  - WARN if TTFB >600ms, no compression, or no caching headers
  - Record: TTFB values, compression method, caching policy, protocol

### CHECK-51: JavaScript errors and broken network requests
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-51"` — `resources.broken` (warning):
  pages referencing an image, stylesheet or script the server answered with a 4xx or a
  5xx, which is the "failed network requests" half of this check, seen across every
  page of the crawl instead of the three a browser session opens. Each finding names
  up to ten of the files with the status each returned and the server's reason beside
  it — a 200 carrying a refusal reason is bot protection answering in place of the
  file, not a healthy asset — and carries an `unknownResources` count for the
  references the crawl could not decide about (never asked, refused by url-policy,
  disallowed by a robots.txt we read, blocked because the host's robots.txt was
  unreachable while the crawl ran, or a request that did not complete). None of those
  is a broken file, and a high unknown count means the answer here is partial.
  `crawl_status.resources` serves the two robots reasons as SEPARATE counts —
  `robotsDenied` ("they said no") and `robotsUnreachable` ("we could not ask") — so
  when the unknown count is high, read those before writing anything: a wall of
  `robotsUnreachable` is a host that was down during our window, not a decision
  anybody made about this site. The same call can
  return either of the family's NOT MEASURED markers, never both:
  `resources.not-recorded` (info) when the crawl holds no resource records, and
  `resources.not-fetched` (info) when it recorded every file and asked the site about
  none of them — `fetchResources: false`, a pass interrupted before its first
  request, or a budget that claimed every row unasked; its evidence names which.
  When one is present no broken file could have
  been found and the network half of this check is NOT MEASURED rather than clean —
  re-crawl to answer it. JAVASCRIPT ERRORS are NOT MEASURED whatever the crawl
  holds: nothing in a crawl records a console, and requests a script makes at runtime
  are not in the resource table either — both stay browser work.
  A second rule reads the same table: `resources.bad-content-type` (info) — a file the
  server answered 200 for whose content type contradicts what the page called it (a
  stylesheet not served as `text/css`, a script not served as JavaScript, an image
  not served as `image/*`). One finding per file, with the type it was sent as and up
  to ten referencing pages. Files that returned an error are `resources.broken`'s,
  not this rule's, and a page whose own body is not HTML is not judged here.
  **The window that once had no marker, now closed** (P13-T2): on a crawl where every
  file landed in an unknown class — refused by our own policy, disallowed by a
  robots.txt, its host's robots.txt unreachable while we crawled, or a request that
  never completed — rows WERE decided, so neither `resources.not-recorded` nor
  `resources.not-fetched` fires and the four judging rules are silent anyway.
  `resources.all-unknown` (info) is the marker that now fires there: its evidence
  carries the per-class census and names the dominant class, and
  `crawl_status.resources` is the discriminator it puts a name to — `fetched` at zero
  with `failed`, `robotsDenied` and `robotsUnreachable` carrying the census. When it
  is present this check is NOT MEASURED rather than PASS, and the remedy is a re-crawl.
  **And its narrower sibling, the last of the family** (P14-T1): a PARTIAL pass that
  reached only some of the files, got an unknown from every one it reached, and never
  asked about the rest — no `ok` row and no broken row — fires none of the other three
  markers either, because the rows exist, are not all null, and are not all decided.
  `resources.partial-unknown` (info) is the marker that now fires there, carrying the
  per-class census, the count of files the pass never reached, and the dominant class.
  When it is present the network half is NOT MEASURED rather than clean, and the remedy
  is a re-crawl or a resume.
- **DevTools**:
  1. Navigate to homepage, product, collection
  2. Check console: `list_console_messages` — filter errors
  3. Check network: `list_network_requests` — filter 4xx/5xx
- **Evaluate**:
  - WARN if JS errors on key pages
  - FAIL if errors affect critical functionality
  - Record: error types, affected pages, failed network requests

### CHECK-52: Mobile viewport, tap targets, sticky overlays
- **Priority**: Medium | **Requires**: Engine + DevTools + Visual
- **Engine**: `issues_list` with `checkId: "CHECK-52"` — `mobile.viewport-missing`
  (critical): pages with no viewport meta tag, across the crawl rather than on the two
  pages a browser check would reach. Tap targets and overlays are visual and stay below.
- **DevTools**: Resize to 375x812 and work through the visual checks
- **Visual**: Navigate homepage and product page on mobile viewport. Visually assess: tap target spacing, intrusive overlays (consent banners, chat widgets, promo bars), sticky elements blocking content
- **Evaluate**:
  - FAIL if viewport meta missing
  - WARN if intrusive overlays cover significant content
  - Record: viewport tag, overlay observations

---

## 13. GEO / AI Visibility

### CHECK-53: GA4 setup and AI traffic tracking
- **Priority**: Critical | **Requires**: GA4 + DevTools
- **DevTools**: Check GA4 presence: `!!document.querySelector('script[src*="googletagmanager"],script[src*="gtag"]')`
- **GA4 MCP**: `run_report` with:
  1. Check channel groupings: dimensions `sessionDefaultChannelGroup`, metrics `sessions` — verify organic channels are properly classified
  2. Check AI traffic: dimensions `sessionSource`, `sessionMedium`, metrics `sessions`, `engagementRate` — filter for AI sources (chatgpt, perplexity, claude, etc.)
  3. If AI traffic exists, cross-reference with CHECK-76 findings
- **Evaluate**:
  - FAIL if GA4 tag not present on site
  - WARN if no custom channel group for AI traffic (all AI traffic falling into "Referral")
  - Record: GA4 tag presence, channel groups list, AI traffic classification status, recommendation for AI channel setup if missing

### CHECK-54: Content modularisation for AI extraction
- **Priority**: High | **Requires**: DevTools + Visual
- **DevTools**:
  1. Navigate to 2-3 top content pages
  2. Execute: `Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(h => h.tagName + ': ' + h.textContent.trim())`
  3. Check for structured Q&A, lists, tables, definition-style content
- **Evaluate**:
  - PASS if clear headings, modular sections, entity-rich paragraphs
  - WARN if wall-of-text without structure
  - Record: heading structure quality, modular content patterns

### CHECK-55: Schema markup for AI context
- **Priority**: High | **Requires**: Engine + DevTools (cross-ref CHECK-43)
- **Evaluate**: From CHECK-43 — focus on AI-relevant types: Product, FAQ, HowTo, Organisation, Article
- **Record**: Reference CHECK-43, note AI-specific schema gaps

### CHECK-56: Entity mapping and topic graphs
- **Priority**: Medium | **Requires**: Manual + Visual
- **DevTools**: Check pillar page structure — do pillar pages link to subtopics and vice versa?
- **Evaluate**: Subjective — note topical authority structure
- **Record**: qualitative assessment

### CHECK-57: FAQ and help hub content
- **Priority**: Medium | **Requires**: DevTools + Engine
- **DevTools**: Navigate to FAQ/help/support pages if they exist. Check for structured Q&A format
- **Engine**: find the candidates first — `pages_query` (or `export_crawl` with
  `dataset: "pages"` on a large site) and look for /faq, /help, /support paths. The
  query surface has no URL filter, so match the paths yourself over the listing
  rather than guessing which pages exist
- **Evaluate**:
  - WARN if no FAQ content exists
  - Record: FAQ presence, format, FAQ schema (from CHECK-43)

### CHECK-58: OpenAI Shopping Feed (e-commerce)
- **Priority**: Medium | **Requires**: DevTools + Manual
- **DevTools**: Check if product feed exists (e.g. /products.json on Shopify, or dedicated feed URL)
- **Evaluate**: Note feed availability — full spec check is manual
- **Record**: feed URL if found, basic field check

### CHECK-59: Bing Webmaster Tools
- **Priority**: Medium | **Requires**: Manual
- **Record**: Flag for manual check — verify Bing WMT submission

### CHECK-60: LLM.txt and markdown options
- **Priority**: Low | **Requires**: DevTools
- **DevTools**:
  1. Navigate to `{domain}/llms.txt` — check if exists (200 vs 404)
  2. Navigate to `{domain}/.well-known/llms.txt`
  3. Navigate to `{domain}/llm.txt`
- **Evaluate**: Note presence/absence (emerging practice, not a failure)
- **Record**: which files exist, content summary if present

### CHECK-61: PDP clarity and policy pages
- **Priority**: Medium | **Requires**: Visual
- **DevTools**:
  1. Navigate to a product page — check for clear info (price, availability, shipping, returns)
  2. Navigate to shipping, returns, privacy policy pages — check completeness
- **Evaluate**:
  - WARN if key policy pages missing or thin
  - Record: policy pages found, completeness assessment


### CHECK-62: Google UCP (Universal Commerce Protocol) readiness
- **Priority**: High | **Requires**: DevTools + Manual
- **DevTools**:
  1. Check if Google Merchant Center product feed is available and current
  2. Check for structured product data accessible via API (variants, inventory, pricing)
  3. Check for identity linking support (loyalty/member benefits)
  4. For Shopify: check if Storefront MCP integration is active
  5. For others: check for REST/JSON catalog endpoints
- **Evaluate**:
  - Note: UCP is Google's open standard for agentic commerce (launched Jan 2026)
  - WARN if no product feed or catalog API exists (site invisible to AI shopping agents)
  - Record: feed availability, catalog API status, identity linking, platform integration status

### CHECK-63: OpenAI ACP (Agentic Commerce Protocol) readiness
- **Priority**: Medium | **Requires**: DevTools + Manual
- **DevTools**:
  1. Check if Stripe is the payment processor (simplifies ACP integration)
  2. Check for product feed endpoint (ACP requires gzip-compressed feed pushed to OpenAI)
  3. Verify product data completeness: title, description, price, availability, images, identifiers
  4. For Shopify: check if native ACP integration is available
- **Evaluate**:
  - Note: ACP is maintained by OpenAI + Stripe, powers ChatGPT Instant Checkout (US, expanding)
  - WARN if no checkout API or Stripe integration (blocks ChatGPT commerce)
  - Record: payment processor, feed availability, product data completeness, integration readiness

### CHECK-64: WebMCP and site-level MCP server implementation
- **Priority**: Medium | **Requires**: DevTools + Manual
- **DevTools**:
  1. Check if the site exposes MCP endpoints for AI agent interaction
  2. For Shopify: check Storefront MCP availability (Hydrogen Winter 2026+)
  3. Check for A2A (Agent-to-Agent) protocol support
  4. Navigate to `{domain}/.well-known/mcp.json` or similar discovery endpoint
- **Evaluate**:
  - Note: WebMCP is a browser-level standard allowing AI agents to interact with sites via structured tools
  - This enables any AI assistant to interact with the store (not platform-specific)
  - Record: MCP endpoint availability, tools exposed, A2A support, platform compatibility


---

## 14. Shopify-Specific (if applicable)

Skip this section if site is not on Shopify.

### CHECK-65: Collection-scoped vs root product URLs
- **Priority**: High | **Requires**: Engine
- **Engine**: `pages_query` (or `export_crawl` with `dataset: "pages"`) and filter the
  URLs yourself for the `/collections/*/products/*` pattern, reading `indexable` on
  each; then `issues_list` with `checkId: "CHECK-17"` (`canonical.points-elsewhere`)
  and `issue_urls` to see where those URLs' canonicals actually point
- **Evaluate**:
  - FAIL if both /collections/x/products/y AND /products/y are indexable
  - PASS if collection-scoped URLs canonical to root /products/y
  - Record: collection-scoped product URL count, canonical handling

### CHECK-66: Variant URLs (?variant=)
- **Priority**: High | **Requires**: Engine
- **Engine**: `metrics_get` with `metricId: "url.param-volumes"` — look for `variant`
  in `topParams` and read its occurrence count; then `issues_list` with
  `checkId: "CHECK-27"` (`url.parameter-pages-indexable`) for whether those URLs are
  indexable, and CHECK-17 for where their canonicals point
- **Evaluate**:
  - PASS if variant URLs canonical to main product
  - FAIL if variant URLs indexable without canonical
  - Record: variant URL count, canonical handling

### CHECK-67: Search and tag page explosion
- **Priority**: High | **Requires**: Engine
- **Engine**: `pages_query` with `indexable: true` (or the pages export) filtered to
  /search and /tagged paths for the indexable ones, `indexable: false` for the
  excluded ones, and `issues_list` with `checkId: "CHECK-03"` for what robots.txt
  blocks. Three lists, one question: are these pages in the index or out of it.
  `issues_list` with `checkId: "CHECK-67"` carries `url.internal-search` (warning):
  an indexable page whose path has a `search` segment or whose query has a key
  `s`, `q`, `query`, `search`, `keyword` or `keywords` (whole key, case-sensitive).
  It names the path and the parameter; a `/tagged` path is not read.
- **Evaluate**:
  - PASS if /search and /tagged noindexed or blocked
  - FAIL if indexable (creates bloat)
  - Record: /search count, /tagged count, indexability status

### CHECK-68: Markets geo logic and bot access
- **Priority**: High | **Requires**: Engine + DevTools (cross-ref CHECK-24 to CHECK-26)
- **Engine**: the same hreflang findings and coverage metric as CHECK-24–CHECK-26
- **DevTools**: Test market-specific URLs (/en/, /es/), verify content differs, hreflang correct
- **Evaluate**: Cross-reference hreflang findings
- **Record**: Reference hreflang results, market-specific observations

### CHECK-69: Theme bloat and app-injected scripts
- **Priority**: Medium | **Requires**: DevTools + Visual
- **Engine** (CONTEXT ONLY — no rule claims this check): `metrics_get` with
  `metricId: "page.weight"` carries a script-byte distribution per page type, which is
  a FLOOR on declared JavaScript: it counts the scripts the served HTML names and
  weighs the ones the crawl got an answer for. The app-injected scripts this check is
  about are precisely the ones outside that boundary — a script a tag manager or a
  storefront app adds at runtime is invisible to the crawl — so the number is a
  starting point for the browser work below and never an answer to it. Quote it as
  "at least this much JS before any app loads", or not at all.
- **DevTools**:
  1. Navigate to homepage
  2. Count scripts via Network tab, identify third-party app scripts
  3. Check total page weight and JS weight
  4. Lighthouse: "Reduce unused JavaScript"
- **Evaluate**:
  - WARN if total JS >500KB or >10 third-party scripts
  - Record: total JS size, script count, top third-party scripts

### CHECK-70: Collection page copy and editorial blocks
- **Priority**: Medium | **Requires**: Engine + Visual
- **Engine**: `issues_list` with `checkId: "CHECK-40"` and `pageType: "collection"`
  (`content.thin`) for the collections with no copy, plus `metrics_get` with
  `metricId: "content.metrics-by-type"` for the cohort's word-count range — which is
  exactly the "word count range" the Record line asks for
- **DevTools**: Navigate to 2-3 collection pages — check for unique editorial copy above/below product grid
- **Evaluate**:
  - WARN if collection pages have no unique copy
  - Record: collections with/without copy, word count range

---

## 15. Backlinks & Brand Authority (Ahrefs)

Skip this section if the Ahrefs MCP server is not connected. Mark all checks N/A if the
client does not have an Ahrefs subscription linked to the MCP server.

These checks run in Phase 0 alongside GSC and GA4 — they do not depend on the crawl.

### CHECK-79: Backlink profile and domain authority
- **Priority**: High | **Requires**: Ahrefs MCP
- **Ahrefs MCP**:
  1. `site-explorer-domain-rating` — get current Domain Rating (DR) for the root domain
  2. `site-explorer-domain-rating-history` — get DR trend over the past 12 months
  3. `site-explorer-backlinks-stats` — total backlinks, referring domains, dofollow vs nofollow split
  4. `site-explorer-referring-domains` — top 20 referring domains by DR, check for high-authority links
  5. `site-explorer-broken-backlinks` — external links pointing to 4xx/5xx pages on the site
  6. `site-explorer-anchors` — top 20 anchor texts, assess brand vs keyword ratio
- **Evaluate**:
  - FAIL if broken backlinks exist (lost link equity — reclaim by fixing destination or redirect)
  - WARN if DR trend is flat or declining over 12 months
  - WARN if anchor text profile is dominated by generic terms (low topical authority signal)
  - Record: current DR, referring domain count, broken backlink count + URLs, anchor text distribution (brand / keyword / naked URL / generic split)

### CHECK-80: AI citations and brand share of voice
- **Priority**: High | **Requires**: Ahrefs MCP (Brand Radar)
- **Note**: Brand Radar requires a separate Ahrefs subscription tier. If not available, mark as SKIP.
- **Ahrefs MCP**:
  1. `brand-radar-impressions-overview` — total impressions across AI platforms (ChatGPT, Perplexity, Gemini, Copilot)
  2. `brand-radar-sov-overview` — share of voice vs competitors in AI results
  3. `brand-radar-ai-responses` — sample AI-generated answers where the brand appears; note which queries trigger citations
  4. `brand-radar-cited-pages` — which site pages are being pulled into AI answers
  5. `brand-radar-cited-domains` — which external sources are being cited alongside the brand in AI responses
- **Evaluate**:
  - FAIL if brand has zero AI impressions on primary commercial queries (brand invisible to AI)
  - WARN if cited pages are not the most commercially important pages (e.g. homepage cited but no collection pages)
  - WARN if share of voice is significantly lower than key competitors
  - Record: total AI impressions, platform breakdown, top cited pages, top citing contexts, share of voice figure, competitor comparison if available

### CHECK-81: Unlinked brand mentions
- **Priority**: Medium | **Requires**: Ahrefs MCP (Brand Radar)
- **Note**: Brand Radar required. Mark as SKIP if not available.
- **Ahrefs MCP**:
  1. `brand-radar-mentions-overview` — total brand mentions across the web (linked + unlinked)
  2. `brand-radar-mentions-history` — mention volume trend over time
- **Evaluate**:
  - WARN if mention volume is growing but linking domains are flat (unlinked mention gap — link reclamation opportunity)
  - Record: total mentions, linked vs unlinked split, trend direction, top domains mentioning the brand without linking

---

## Reading a Crawl Out of the Engine

There is no export step to run before the checks: the crawl already holds the data,
and each check names the call that answers it. What follows is the shape of those
calls, so a check's one-line **Engine** entry is enough.

The tools are the MCP surface (`crawl_start`, `crawl_status`, `crawl_list`,
`crawl_resume`, `crawl_render`, `crawl_rules`, `crawl_mark_failed`, `robots_get`,
`issues_list`, `issue_urls`, `metrics_get`, `pages_query`, `export_crawl`). The HTTP
API exposes the same service — `GET /crawls/:id/issues`, `/metrics`, `/pages`,
`/robots`, `/issues/:ruleId/urls`, `/export` — and answers the same JSON, so an operator running
`npm run api:serve` instead of `npm run mcp:serve` changes the transport and nothing
else.

**Before reading any of it, check the crawl was judged.** `crawl_status` carries
`rulesRunAt` (when a rules pass last completed; null means none is on record) and
`findingsCount` (the findings that pass left). Every PASS this checklist reaches
through an empty listing rests on that timestamp.

**The query tools, and what each is for:**

| Tool | Answers | Use it for |
|------|---------|-----------|
| `issues_list` | one row per rule that found something: `{ruleId, checkIds, severity, category, title, count, sampleUrls}` | the verdict on a check, and its size |
| `issue_urls` | one row per finding: `{url, address, statusCode, indexability, indexabilityStatus, evidence}`, with the response's own `columns` saying how to print them | the report a developer gets: the URL, whether it is indexable and why not, and the rule's own evidence |
| `metrics_get` | `{metricId, scope, scopeValue, value, title, explanation, checkIds, category}` | every number a report quotes |
| `robots_get` | `{crawlId, robotsUrl, outcome, raw, truncated, crawlDelaySec, note, sitemapSources, suppliedSitemaps, userAgent}` | the robots.txt this crawl obeyed, as stored (CHECK-03, CHECK-06) |

**Filters that matter for a checklist walk:**

- `issues_list` takes `checkId` — this is how you walk this file. It also takes
  `severity`, `ruleId`, `category` and `pageType`, which intersect.
- `metrics_get` takes `metricId`, `scope` (`site`, `page_type`, `sitemap_doc`) and
  `scopeValue`.
- `pages_query` takes `pageType`, `statusCode`, `indexable`, `rendered`, `fetchClass`
  and `discoveredVia`. There is no URL filter: match paths yourself over the listing.
  Several checks are written as path matches — CHECK-57, CHECK-65, CHECK-66 and
  CHECK-67 among them — so each of those wants the WHOLE census, which is 3 calls at
  `limit: 200` on a 551-page crawl and 250 on a 50,000-page one. **Past a few
  thousand pages, take the census once with `export_crawl` (`dataset: "pages"`),
  index it locally, and answer every path-matching check off that one file** rather
  than paging the listing per check.
  Each row carries `depth` AND `clickDepth`, `wordCount` AND `renderableWordCount`,
  and `fetchReason` where the crawl has one to give — the pairs are two different
  measurements each, never one with a fallback.

**Every listing is paginated.** `{items, nextCursor}`; pass `nextCursor` back as
`cursor` with the SAME filters. `nextCursor: null` is the end. A first page is not
the answer to "how many" — `issues_list`'s `count` is.

**A refusal is not an empty answer.** A filter naming something this ruleset does not
define is refused BY NAME, so an empty page always means "nothing found" and never
"you asked wrong". Two refusals are routine and both are informative:

- `checkId 'CHECK-29' is claimed only by metric rules … it is measured, not found` —
  go to `metrics_get`. CHECK-29, CHECK-33b and CHECK-38 answer
  this way, **for example**: the list is a sample of the shape, not the closed set.
- `checkId 'CHECK-41' is claimed by no rule` — an agent check. There is no engine
  answer and there is not meant to be one. CHECK-41 is the standing example and
  **it is far from the only one** — CHECK-42, CHECK-47 and the whole CHECK-71…81
  analytics block answer the same way, as does every other check the coverage query
  records as agent-owned. Neither list above is exhaustive and neither is meant to
  be read as one: probe the check you are on, and take the refusal it gives you.

**When a crawl is large**, `export_crawl` writes one dataset (`issues`, `pages`,
`metrics`) to a gzipped JSONL file on the server and answers `{dataset, path, rows,
bytes}` — the path, never the contents. Use it when you need every row (the full
4xx list, a site-wide page census) rather than paging thousands of rows through a
context window. The file is for a human or a pipeline; the counts and the samples
are what belong in the audit. **The directory is the server's choice, never
yours**: it is `exports/` under the server's working directory unless the operator
set `ARIADNE_EXPORT_DIR`, and the answer's `path` is where the file actually
landed. Quote that path; do not construct one.

## Crawl Configuration Requirements

The crawl that feeds this checklist is configured at `crawl_start` (see the
`ariadne-crawl` skill for the full procedure). There is no GUI, no config file and
no per-check extraction switch: the crawler stores every field the rules read on
every crawl, so the settings below are about SIZE and REACH, not about coverage.

**What to set, and what it costs the checklist if you do not:**

| Field | Default | Why a check needs it |
|-------|---------|---------------------|
| `maxPages` | 500 | A cap the crawl hits leaves the frontier undrained, which makes CHECK-32 SKIP (`links.orphan-skipped`) and every "% of pages" figure a floor. Size it to the site. |
| `maxDepth` | unset | Truncating depth truncates CHECK-31's distribution and orphans everything past the cut. |
| `probeHosts` | on | Off means CHECK-14 and CHECK-15 are SKIP (`host.probe-skipped`) — the probe is the only evidence there is. |
| `fetchResources` | on | Off means the crawl records which files each page points at and asks the site about none of them, so CHECK-48, CHECK-49, CHECK-50 and CHECK-51 are SKIP (`resources.not-fetched`) and `page.weight` counts HTML alone. Turn it off only when the site's owner asked us not to touch their assets. |
| `legacyHosts` | none | The only way CHECK-15 can report a legacy host still serving content. Each entry must be on the operator's allowlist in its own right. |
| `renderBudgetPct` / `renderMaxPages` / `renderSamplePerType` | see the tool description | The render pass's sample. CHECK-01, CHECK-02, CHECK-34 and the JS-redirect half of CHECK-10 are measured over the pages it reaches and no others. |
| `perHostDelayMs` / `maxConcurrency` | polite defaults | Politeness, not throughput. Leave them alone unless the site's owner has asked for something specific; robots.txt's own `crawl-delay` wins when it is longer. |

**Then run the passes in order**: `crawl_render` (optional, but before the rules) and
`crawl_rules` (required — nothing below is answerable until the rules have run).

**Analytics and browser access are separate**, and neither is part of the crawl:
GSC, GA4 and Ahrefs are MCP servers the operator connects, and the browser checks
need a browser MCP server. A missing one is a SKIP with the tool named, never a
silent pass.

If the crawl is missing data a check needs — no render pass, a page cap reached, the
host probe off — say so in that check's findings record and recommend a re-crawl with
the field named. A gap that is written down is a gap the next crawl can close; a gap
that is quietly rounded to PASS is a wrong audit.

---
name: ariadne-report
description: >
  Turn a finished Ariadne audit into the written deliverable: a markdown report
  that quotes the engine's numbers verbatim, argues what they are worth on THIS
  site, and names every check that went unaudited. Use this skill when the user
  says: "write the audit report", "write the report", "turn the findings into a
  report", "produce the markdown deliverable", "write up the audit", "the report
  for the client", "document the audit findings", "we need the write-up". It
  reads the findings file the ariadne-audit skill wrote and the crawl behind it;
  without both it stops rather than writing from memory.
---

# Ariadne — the audit report

The audit produced a machine-shaped file of verdicts and evidence. This skill
turns it into the document a client reads: what the crawl covered, what is wrong,
what it is worth fixing, and what nobody measured.

## The one idea this skill exists for

**The engine's severity is a fact about a rule. The report's priority is an
argument about a site.**

A rule that says `critical` is stating what it always states — that class of fault
is serious in the abstract, on any site, before anyone knew whose site this is. It
has never seen the traffic, the revenue, the page types that earn or the roadmap.
The report has. So the report may put a `warning` that lands on every product page
above a `critical` on one orphaned legal page, and when it does, it says so, in
the same sentence, with the reason.

Two failures to avoid, and they are opposites:

- **Transcription.** Copying the engine's severities into a priority column and
  calling it an audit. Then the deliverable is a sorted list of rule outputs and
  the judgement layer is missing.
- **Laundering.** Quietly rewriting a severity so the report reads cleanly, with
  no trace that the engine said something else. Then the client cannot tell your
  argument from the engine's measurement, and neither can the next auditor.

Every finding in the report carries both numbers, and the difference between them
is a sentence, not a silence.

## Prerequisites

Three, and a missing one stops the work rather than shrinking it.

1. **The findings file.** `ariadne-findings.json`, written by the `ariadne-audit`
   skill, whose Phase 4 defines the shape. If there is no findings file there is
   no report: do not reconstruct an audit from a conversation, and do not write a
   report from `issues_list` alone — an unjudged list of rule output is exactly
   the deliverable this skill exists to not produce.
2. **A reachable server, holding the same crawl.** MCP preferred
   (`npm run mcp:serve`), HTTP as the fallback (see the `ariadne-crawl` skill's
   equivalence table). `crawl_status` on the findings file's `crawl.crawlId` must
   answer. The metric tables are read live, and any list the audit only sampled is
   read live too.
3. **A place to write it.** The audit's working directory, beside the findings
   file, unless the user names somewhere else.

**If the server does not answer**, say so and stop. The user may decide the report
is worth writing from the findings file alone — that is their call to make, not
yours to make quietly — and if they do, the report carries a line at the top of
the metrics section naming the crawl whose numbers could not be re-read. What
never happens is a metric table filled in from a number you remember.

## Step 1 — read the findings file, and check it

Read it and verify these before writing a word. Each one is a defect in the audit,
not something to work around:

- `schema` is `"ariadne-findings/1"`. Another value is a file this skill does not
  know how to read.
- `checks` has exactly `checklist.checksTotal` entries, each `checkId` once. A
  missing check is indistinguishable from a check nobody ran.
- `coverage.pass + fail + skip + agent` equals `checklist.checksTotal`.
- Every `FAIL`, `SKIP` and `AGENT` has `notes`. A bare verdict is not a finding.
- Every `FAIL` and `AGENT` that names a fix has a `recommendation`.
- `crawl.caveats` is present — an empty array is an answer, an absent field is not.
- `crawl.rulesRunAt` carries a timestamp. Null means the crawl was never judged to
  completion, so every PASS in the file rests on an empty listing that proves nothing:
  send it back rather than reporting a clean site.

Name what is wrong and send it back to the audit. A report written over a
half-filled findings file states things about a site that nobody checked.

Then read `crawl` before reading a single check. It bounds every number in the
document: `pagesCrawled` is the denominator of every percentage you will write,
`renderPassCount` decides whether four checks are answerable at all, `frontier`
says whether the crawl drained, and `caveats` is the list of sentences the report
owes the reader up front.

## Step 2 — quote the measured numbers

The engine's metrics are the report's quotable material, and the metric rules were
written to be quoted: each row comes back with its own `title`, its own
`explanation` of what it counted, and a `value` the service copies verbatim from
what the rule wrote.

Sweep them: `metrics_get` with `crawlId` and no other filter, following
`nextCursor` to the end. Each row is
`{metricId, scope, scopeValue, value, title, explanation, checkIds, category}`.

**Quote. Do not paraphrase.**

- `value` goes into the table as it came back. Its shape belongs to the metric —
  `structure.depth-distribution` answers `{count, min, max, mean, median, p25, p75, p95}`,
  `sitemap.structure` answers something else entirely — so the table's columns are
  the value's own keys, not a set you chose in advance.
- **The two depth metrics are two different claims, and only one is about the site.**
  `structure.depth-distribution` is DISCOVERY depth: hops from a seed, and every
  sitemap URL is a seed, so it describes how the CRAWL found the site.
  `structure.click-depth-distribution` is the shortest chain of internal links from
  the home page, with `nullCount` for the pages no chain reaches at all. A report that
  writes "97% of pages are one click from the home page" off the first metric has said
  something false about the site with a true number. Caption them by what they
  measure, and when both appear, say what the gap between them means: discovery far
  shallower than click depth is a sitemap carrying the internal linking.
- The metric's `title` is the table's caption. The `explanation` is what tells the
  client what the number counted; use it once, under the table, in the metric's own
  words. It is written for a reader, and rewriting it is how a precise statement
  about what was measured becomes a vague one.
- **Explanations are long, and trimming one is a declared act.** Quote it in full
  when it runs to 120 words or fewer. Past that, quote its first paragraph — or,
  where it is a single paragraph, its first two sentences — and follow the quote
  with the marker *(explanation truncated; full text ships with the finding)*.
  Never elide silently, never with a bare ellipsis, and never trim mid-sentence:
  a reader who cannot see that something was cut cannot ask for the rest, and the
  cut usually lands on the clause that says when the number is a floor rather than
  a total.
- `scope` and `scopeValue` are a column, never dropped. A `site` row and a
  `page_type` row are different claims, and a table that mixes them without saying
  which is which is a table nobody can act on. `(untyped)` is its own cohort — the
  pages the crawl could not assign a template to — and it is reported as itself,
  never folded into a template.
- **A number you derived is not a number that was measured.** Percentages, ratios
  and "up from last quarter" are yours; write the arithmetic beside them ("128 of
  4,102 sitemap URLs, 3.1%") so the two source numbers stay visible.
- **Thin content is reported on the words the page can call its own.**
  `content.thin` judges `mainWords` — the words inside the page's `<main>`, or its
  body minus the header, navigation, sidebar and footer — and carries the
  whole-document `wordCount` beside it. Quote `mainWords` in the finding; quote both
  when the gap is the story ("the template ships 900 words, 100 of them the page's
  own: 800 words of mega-menu and footer on every product page"), which
  `content.metrics-by-type` sizes per template with a whole-document distribution.
- An empty metrics sweep means the rules did not run, not that the site has
  nothing worth measuring. The findings file's `crawl.rulesRunAt` — copied there from
  `crawl_status` — is what distinguishes them, with `crawl.rulesRun`'s three scalars
  (`pagesScanned`, `findings`, `metrics`) sizing the pass beside it. There is no
  per-rule map in the findings file. If the sweep is empty and those say the crawl
  was judged, stop:
  the findings file and the crawl do not describe the same run.
- **`crawl.rulesRun` is filled for any judged crawl**, including one somebody else
  judged: its `pagesScanned` and `findings` come from `crawl_status` and its `metrics`
  from the audit's own metrics sweep, so the audit never re-judges shared state to
  fill a field. Quote `rulesRun.pagesScanned` as the pages the rules read.
  **`crawl.rulesRunAt` is still the gate, not `rulesRun`** — a null `rulesRunAt` is
  the refusal case and it stays one. A `rulesRun` of null on a file whose `rulesRunAt`
  carries a timestamp is an older findings file, written before those numbers were
  readable without a run: use `crawl.pagesCrawled` there and call it what it is, the
  pages the crawl fetched.

## Step 3 — severity in context

For every `FAIL` and every `AGENT` with a fix, decide what it is worth here. The
findings file already carries the auditor's `severity` (the rule's opening bid,
possibly already adjusted, with the reason in `notes`) and a `priority` from the
checklist. Your job is the ordering the client acts on.

What legitimately moves a finding up or down:

- **How much of the site it touches.** `count` against `crawl.pagesCrawled`. Ten
  URLs out of 12,000 is a task; 10 out of 40 is a template fault.
- **Which pages.** The page-type cohort is the crawl's own template detection —
  prefer it to a guess from the URL path. A fault on the templates Phase 0 named
  as the traffic and the revenue outranks the same fault elsewhere, and this is
  the single most common reason to disagree with a rule's severity.
- **Whether it blocks something absolutely.** Indexation, discovery, canonical
  consolidation and rich-result eligibility are binary in a way that word counts
  are not: a page nothing can reach earns nothing regardless of its quality.
- **Whether it compounds.** The audit's cross-readings are where several findings
  turn out to be one problem. Report the problem, not its three symptoms, and cite
  all three check ids against it.
- **What the fix costs.** A one-line template change and a 4,000-page content
  programme do not belong at the same position in a list the client reads as an
  order of work.

What never moves it: how a finding reads in a document, or how many findings a
severity band already holds.

**Ruleset 0.20.0 added forty rule ids, and several of them are the same problem
seen twice.** A findings file from a crawl judged at 0.20.0 or later can carry any
of them. They are grouped here by the problem a client reads:

- **One defect, two ids.** `title.pixel-too-long` and `title.too-long`,
  `title.pixel-too-short` and `title.too-short`, `meta-description.pixel-too-long`
  and `meta-description.too-long`, `meta-description.pixel-too-short` and
  `meta-description.too-short` each measure one field in two units. Where both fire
  on a page, write one finding citing both. Lead with the pixel width, because that
  is what the result page cuts on.
- **Transport security** (CHECK-14, CHECK-84, CHECK-85): `security.http-url`,
  `security.hsts-missing`, `security.headers-missing` and `security.mixed-content`.
  None of them is a ranking factor except `security.http-url`, which is also a
  duplicate-URL problem. Rank the rest by what they expose visitors to, and say so.
  `security.headers-not-recorded` is a marker: the check was not run on this crawl,
  which goes under "Not audited", never under findings.
- **Indexing directives** (CHECK-04): `indexability.nofollow`,
  `directives.restrictive` and `directives.unavailable-after`. A nofollow on pages
  the site closes on purpose, such as internal search results, is the site working
  as intended. Report it as context, not as a fix.
- **Canonical and pagination integrity** (CHECK-16, CHECK-17, CHECK-19, CHECK-22,
  CHECK-23): `canonical.relative`, `canonical.fragment`, `canonical.chain`,
  `canonical.unlinked`, `pagination.non-indexable-target`, `pagination.loop` and
  `pagination.sequence-error`. A chain and a loop are consolidation failures. A
  relative canonical is hygiene unless the site also serves on a second host.
- **Hreflang integrity** (CHECK-24): `hreflang.inconsistent-return-code`,
  `hreflang.multiple-entries`, `hreflang.self-only` and `hreflang.unlinked-target`.
  These compound with the older hreflang findings. Report the cluster as one
  problem.
- **Links** (CHECK-32, CHECK-33, CHECK-86): `links.only-from-non-indexable`,
  `links.internal-nofollow`, `links.high-outlinks`, `links.localhost` and
  `links.non-descriptive-anchor`. `links.localhost` reads external links only, and
  a hit is a development address leaking into production. It is worth a line on its
  own however few pages carry it. `links.high-outlinks` on the external side fires above 10 targets, so a
  policy or payment-provider page reaches it easily: weigh before reporting.
- **URL shape** (CHECK-30, CHECK-67): `url.uppercase`, `url.underscores`,
  `url.non-ascii`, `url.spaces`, `url.multiple-slashes`, `url.repetitive-path` and
  `url.internal-search`. The first six are hygiene for new URLs. Changing a live
  URL means a redirect and the risk that comes with it, so never recommend renaming
  ranking URLs for case or underscores alone. `url.internal-search` is an index
  bloat problem and ranks with the duplicate findings.
- **Sitemap entries** (CHECK-07, CHECK-08): `sitemap.over-50k-urls`,
  `sitemap.url-too-long`, `sitemap.cross-host-loc` and `sitemap.lastmod-invalid`.
  `sitemap.cross-host-loc` is silent for a sitemap on another host that lists the
  site's own URLs, which is an allowed cross-submission, so do not report one as a
  fault. `sitemap.lastmod-invalid`'s `future` means dated after the crawl ended, so the
  value was in the future when the sitemap was read. Report it as a lastmod no search
  engine can trust.
- **Served types** (CHECK-51): `resources.bad-content-type`. Rank it by what the
  file does: a stylesheet or script refused by the browser breaks the page, and an
  image sent with a wrong type usually does not.

**Ruleset 0.21.0 added twenty-six rule ids, and twenty-two of them need a
re-crawl.** They read page facts recorded only on crawls since Phase 26b. A findings
file from an older crawl judged at 0.21.0 carries `extraction.not-recorded` instead of
those findings. That is a marker: the checks it claims were not run on this crawl, so
they go under "Not audited" with a re-crawl as the next step, never under findings and
never as clean. Grouped by the problem a client reads:

- **Head and document structure** (CHECK-04, CHECK-18, CHECK-24, CHECK-88):
  `html.head-closed-early` explains `head.directives-outside-head` and
  `head.tags-outside-head` on the same page. Report one problem, the element that
  closed the head, and cite all three. `html.structure-invalid` whose only problems are
  head-missing and body-missing describes a page that leaves out optional tags. It is
  valid HTML: write it as a hardening recommendation (P4), never as a broken page.
- **Directives and refresh** (CHECK-04, CHECK-10): `directives.bot-conflict` means one
  search engine is told something the others are not (`stricter`), or a bot tag
  tries to lift a generic restriction it cannot lift (`overridden`). Rank it with the indexability
  findings. `redirect.meta-refresh` is a redirect done the slow way. Rank it with the
  redirect findings.
- **Social sharing** (CHECK-87): `social.og-incomplete`, `social.x-incomplete`,
  `social.og-multiple`, `social.og-url-mismatch`, `social.og-duplicate` and
  `social.image-broken`. None of them is a ranking factor. Rank them by how much of
  the site's traffic arrives through shared links, and say so.
- **Headings and titles** (CHECK-35, CHECK-36, CHECK-37): `title.multiple` and
  `meta-description.multiple` are template defects, so fix them once. `title.same-as-h1`,
  `h2.missing`, `h2.too-long` and `h2.duplicate` are content hygiene. A title equal to
  the H1 is a missed chance to vary the wording, not a fault.
- **Links and images** (CHECK-34, CHECK-49, CHECK-86): `links.uncrawlable` hides
  targets from discovery, so it ranks with the orphan findings. `links.empty-href`,
  `links.unsafe-target-blank`, `links.no-anchor-text`, `images.empty-alt` and
  `images.alt-too-long` are hygiene. An empty alt on a decorative image is correct, so
  weigh `images.empty-alt` by which images it names.
- **Forms, hreflang and pagination** (CHECK-85, CHECK-25, CHECK-22):
  `security.form-insecure` exposes what visitors type. Report it with the mixed-content
  findings. `hreflang.html-lang-mismatch` and `pagination.multiple` compound with the
  older hreflang and pagination findings.

**Write both numbers.** Every finding in the report shows the engine's severity as
it came and the report's priority as you argue it. When they differ, the reason
goes in the finding, in one sentence: *"The engine grades this `warning`; on this
site it is P1, because all 340 affected URLs are product pages and product is 71%
of organic entrances."*

The priority ladder, defined by what it means rather than by which severity fed it:

| Priority | What it means |
|----------|---------------|
| **P1** | Costing the site money or index coverage now. Starts this sprint. |
| **P2** | Real damage, bounded; scheduled inside the quarter. |
| **P3** | Worth doing, no urgency; goes in the backlog with a named owner. |
| **P4** | Watch. Correct as noticed, do not schedule. |

## Step 4 — the document

Markdown, one file, written beside the findings file:
`{client-or-domain}-audit-report.md`. **That prefixed name is the canonical one** —
the findings file is `ariadne-findings.json` on every audit, so the two deliverables
carry the client instead, and a folder holding two quarters' work stays readable. A
bare `audit-report.md` is the same document under a name that collides with the next
one.

**If the person who asked for the report named the file, use their name and say at
the top of the report which name you used.** The prefixed spelling is the default
for when nobody said, not a rule that outranks the request — a requester who asked
for `audit-report.md` and received the prefixed spelling instead has to go
looking for their own deliverable. Renaming against the request is the worse
failure of the two, and following it silently is the other one.

This is the shape; the words are yours.

```markdown
# SEO & GEO audit — {client} · {site}

| | |
|---|---|
| Site | {site.siteUrl} |
| Crawl | {crawl.crawlId}, {crawl.pagesCrawled} pages, {startedAt} → {finishedAt} |
| Ruleset | {crawl.rulesetVersion} |
| Checklist | {checklist.checksTotal} checks ({checklist.path}) |
| Report date | {generatedAt} |

## What this audit covers

{The crawl's reach, in prose: how many pages, whether the frontier drained,
whether a render pass ran and over how many pages, which analytics sources
answered. Then every entry in crawl.caveats, each as its own sentence. This
section exists so no number below has to carry its own disclaimer.}

| Verdict | Checks |
|---------|--------|
| Pass | {coverage.pass} |
| Fail | {coverage.fail} |
| Skipped / not audited | {coverage.skip} |
| Agent judgement | {coverage.agent} |

## Executive summary

{Five sentences on the state of the site. Then the three or four PROBLEMS — not
findings, problems: each one names the checks behind it and the numbers that
size it. Then the P1 list, as a preview of the recommendations section.}

## Where the site stands

{Phase 0. Organic traffic and direction, brand vs non-brand, the pages and
templates that earn, the query landscape, conversions, AI referrals, indexation
coverage, cannibalisation, and authority if Ahrefs answered. This section is why
the priorities below are what they are, so it comes before them.}

## Findings

### {checklist section, in the checklist's order}

**Passing:** CHECK-14, CHECK-16, CHECK-22 — {one clause each}.

#### CHECK-07 — Sitemap contains only indexable 200 URLs
**Verdict** FAIL · **Engine severity** warning · **Priority** P1

{What the engine found, quoted: rule ids, counts, the sample. Then what it means
here, and why the priority is what it is if it differs from the severity.}

**Recommendation.** {The fix, in the client's terms.}

## Measured numbers

{The metric tables, verbatim, grouped by what they describe. Each carries its
metric's title as the caption and its explanation beneath.}

## Not audited

{Every SKIP, and every check whose number the engine does not measure. Tables,
below.}

## Recommendations, in order

{P1 down to P4. Each: what to change, which checks it closes, how many URLs it
touches, who does the work, and what it should move.}

## Appendix A — evidence

{Per check: the tool calls that produced it, from the findings file's `args`.
The point is that a reader can re-run any claim in this document.}

## Appendix B — method
{The engine, the ruleset version, the checklist, and the division of labour:
the engine produced the facts, the auditor judged them.}
```

Two rules about proportion:

- **A pass is one clause, not a section.** Grouped at the top of its section:
  "Passing: CHECK-14, CHECK-16, CHECK-22." A report that spends a paragraph on
  each thing that is fine buries the things that are not.
- **URL lists do not belong here.** Quote the count, quote up to five example
  URLs, and point at where the full list lives: the web surface's exports, or
  the on-request action-plan workbook if the client asked for one. A report
  that lists 400 URLs has become a worse version of the surfaces designed for
  them.

## Step 5 — the checks nobody could answer

This section is the reason the report can be trusted, so it is never dropped for
length and never left implicit.

**A skipped check is named as unaudited. It is never quietly absent, and it is
never rounded up to a pass.** A reader who does not find CHECK-47 in the document
concludes the site's Core Web Vitals are fine. They were not measured.

Two tables:

```markdown
### Checks not audited

| Check | What it asks | Why it was not audited | What it would take |
|-------|--------------|------------------------|--------------------|
| CHECK-80 | AI citations, share of voice | Ahrefs Brand Radar not on this account | The Brand Radar tier |
| CHECK-01 | Content that only exists after rendering | No render pass on this crawl | A re-crawl with rendering |

### Numbers this audit does not have

| Check | The number it asks for | What we have instead |
|-------|------------------------|----------------------|
| CHECK-10 | Total inlinks to redirecting URLs | The count of redirecting URLs, not their inlinks |
| CHECK-47 | Core Web Vitals | Response time only |
```

Both tables come from the findings file: the first from every `SKIP` and its
`notes`, the second from the `notes` the audit wrote as NOT MEASURED. Filling
either one with a nearby number that is not the number asked for is the silent
fallback the whole engine is built to refuse.

An `AGENT` verdict is not a skip. The work was done and the judgement is in
`notes`; it belongs in Findings with the rest, marked as the auditor's judgement
rather than the engine's measurement.

## Step 6 — writing rules

1. **Numbers before opinions.** "128 of 4,102 sitemap URLs are not indexable"
   comes before "the sitemap needs regenerating". A recommendation with no number
   in front of it is advice, and the client can get advice anywhere.
2. **`count` is the total; `sampleUrls` is five.** Never present a sample as the
   extent of a problem, and never write "including" without saying of how many.
3. **Name the rule.** Findings cite the `ruleId` and the `checkId`. It costs a
   parenthesis and it makes every sentence checkable.
4. **Group by cause.** Broken links, redirect chains and 404s that all come from
   one discontinued product range are one problem with three symptoms. Say that,
   and the remedy is one project instead of three tickets.
5. **Say where a claim came from.** Engine, browser, GSC, GA4, Ahrefs — the
   evidence's `source` and `tool` are in the findings file; carry them across.
   A client comparing this report to their analytics needs to know which numbers
   are theirs.
6. **No fix text you invented.** The fix is the `recommendation` field the audit
   wrote. The query surface does not carry the registry's fix copy — `issues_list`
   returns a rule's `title` and nothing else — so a fix that is not in the findings
   file is a fix that came from you. If one is missing, go back to the audit; do
   not compose plausible remediation prose over a rule you have not read.
7. **Specific fixes, not categories of fix.** Not "improve internal linking" but
   "the 2,140 products with no HTML link path are reachable only from the sitemap;
   the collection grid renders its links in JavaScript (CHECK-34), so the fix is
   server-rendered pagination links in the grid template."
8. **British spelling, plain sentences, no scores.** A composite "SEO health
   score" is a number nobody can act on and nobody can check.

## Before you hand it over

- Every `FAIL` and `AGENT` from the findings file appears somewhere in Findings.
- Every `SKIP` appears in Not audited, with what would answer it.
- Every priority that disagrees with its engine severity says why, in the finding.
- Every metric table's numbers match a `metrics_get` row from THIS crawl.
- No URL list longer than five; no fix text without a `recommendation` behind it.
- The caveats from `crawl.caveats` are all in "What this audit covers".

Then, in the conversation: the coverage counts, the three or four problems in
plain language, the P1 list, and the file's path. The report is where a
standard audit ends. Mention, without pushing it, that the URL-level
spreadsheet exists on request — the `ariadne-action-plan` skill turns the same
findings file into a developer handoff workbook — but it is an on-request
deliverable, not a routine second half: the standing per-issue, per-URL view
of a crawl is the web surface's job (owner decision, 2026-09-01).

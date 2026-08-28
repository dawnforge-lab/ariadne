---
name: ariadne-action-plan
description: >
  Build the Excel action plan from a finished Ariadne audit: one tab per issue
  worth fixing, each tab the full URL list from the engine with the rule's own
  evidence as columns, sorted so the right team can pick it up. Use this skill
  when the user says: "build the action plan", "make the spreadsheet", "the
  Excel deliverable", "the dev handoff", "the fix list", "export the issues to
  Excel", "give the developers the URL list", "turn the findings into work
  items", "the xlsx". It needs the findings file from the ariadne-audit skill,
  the crawl behind it still on a reachable server, and python3 with openpyxl.
---

# Ariadne — the action plan

The report argues. This one assigns. Every row here is a URL somebody opens and a
change somebody makes, so the spreadsheet's whole job is to be complete, ordered,
and honest about what it left out.

## What the engine gives you and what it does not

`issues_list` answers `{ruleId, checkIds, severity, category, title, count,
sampleUrls}` per rule that found something. `issue_urls` answers `{url, evidence}`
per finding, paginated. That is the tab body, and it is a fact.

**There is no impact field, and there is not going to be one.** `severity` is the
rule's opinion in the abstract, formed before anyone knew whose site this is;
`count` is a fact; neither is a decision about whether this belongs in a work plan.
Whether an issue earns a tab is judgement, made here, from the severity, the
counts, the page-type cohorts and the commercial context the audit's Phase 0
established. The engine will not make it for you and should not.

**The fix text is not on the wire either.** `issues_list` returns a rule's `title`
and no remediation copy — the registry's explanation and how-to-fix text do not
cross this surface. The fix comes from the findings file's `recommendation` field,
written by the auditor per check. A rule with no recommendation behind it is not
ready to be a work item: go back to the audit and get one. Do not compose
remediation prose over a rule you have not read.

## Prerequisites

1. **The findings file.** `ariadne-findings.json` from the `ariadne-audit` skill
   (its Phase 4 defines the shape). Check `schema` is `"ariadne-findings/1"` and
   that `checks` is complete before reading anything out of it.
2. **A reachable server holding the same crawl.** MCP preferred
   (`npm run mcp:serve`), HTTP as the fallback (the `ariadne-crawl` skill has the
   equivalence table). `crawl_status` on the findings file's `crawl.crawlId` must
   answer. **It must be that crawl id**, not a newer crawl of the same site: the
   audit judged one state of the site and a spreadsheet that mixes two states
   hands developers URLs that were fixed and misses URLs that broke.
3. **python3 with openpyxl.**
   ```bash
   python3 -c "import openpyxl" 2>/dev/null || pip3 install --user openpyxl
   ```
   If the install fails, say so and stop. There is no CSV consolation prize — the
   deliverable is a workbook with tabs, and half of it is not a deliverable.
4. **Somewhere to write it**, normally beside the findings file.

Any of these missing is a stop, named out loud, with what would fix it.

## Step 1 — decide what goes in

Five stages, in this order. The order is the point: gates before exclusions
generate candidates you then take back out, and a cut before the merge hides work
that should have been consolidated instead of dropped. Two agents running these
five stages over one findings file build the same workbook.

```
1a intake (by CHECK) → 1b exclusions → 1c gates → 1d consolidation → 1e rank and cut
```

### 1a — Intake, keyed by check

Walk the findings file's `checks`. A check enters the pipeline when its `verdict`
is `FAIL` or `AGENT`. Two kinds of candidate come out:

- **Rule-backed candidates.** The check's `evidence` carries `finding` entries with
  a `count` above zero. Each named rule is a candidate, and its tab body is an
  `issue_urls` feed.
- **Check-level candidates.** An `AGENT` check whose evidence is `observation`
  entries and nothing else. There is no rule, so there is no `issue_urls` feed: the
  tab body is the observations — their `urls`, their `summary`, their `detail` —
  one row per URL observed, and the fix is the check's `recommendation` exactly as
  a rule-backed tab's is. CHECK-41 and CHECK-42 are the standing examples. A check
  nobody wrote a rule for is still work somebody does, and it does not get to
  disappear because the engine had nothing to say about it.

**The intake is keyed by check, and so is the ledger.** Every check that enters
here leaves through exactly one door: a tab of its own, a block inside a family
tab, or a line under *Considered, not included*. The same holds for every rule
inside a rule-backed check. If you cannot name the door a check went through, the
plan is not finished.

### 1b — Exclusions, applied before the gates

A candidate leaves here, and its reason is what the ledger records:

- **E1 — `verdict` is `SKIP`.** Nothing was measured, so there is nothing to
  action: the fix is a re-crawl or a connected data source, and the report says so.
- **E2 — no `recommendation`.** This is a stop rather than an exclusion. A `FAIL`
  or `AGENT` that needs a fix and carries no fix text is a hole in the audit: go
  back and get one. Do not write it yourself, and do not quietly drop the check.
- **E3 — the fix is a decision nobody has framed.** If the audit set out the
  options, this is a *Decide first* tab (Step 2). If it did not, the check stays in
  the report until somebody chooses, and comes back here once they have.
- **E4 — small.** All three of: engine `severity` is `info`; `count` <
  `max(10, 1% of crawl.pagesCrawled)`; and the affected pages are not on a page
  type Phase 0 named as traffic or revenue. **That is what "small" means in this
  skill** — the same floor G3 uses, so nothing can be both small and voluminous.

### 1c — Gates

Over what survived 1b. **A candidate needs one gate:**

- **G1 — graded critical in context.** The findings file's `severity` for the
  check is `critical`. That is the auditor's judgement, already made on this site.
- **G2 — it blocks something absolute.** Indexability, discovery, canonical
  consolidation, hreflang or rich-result eligibility: the `crawl`, `indexability`,
  `sitemap`, `canonical`, `hreflang`, `links`, `host` and `structured-data`
  categories, at any count above zero. A page nothing can reach earns nothing,
  whatever its quality.
- **G3 — volume.** `count` ≥ `max(10, 1% of crawl.pagesCrawled)`. On a 12,000-page
  crawl that is 120; on a 300-page site it is 10. The percentage keeps a big site
  from filling the plan with rounding error, and the floor of 10 keeps a small site
  from looking clean because it is small.
- **G4 — it lands where the money is.** Whatever the count, the affected pages are
  a page type Phase 0 named as traffic or revenue. Forty broken product pages
  outrank four hundred faults on a page type with no entrances.
- **G5 — the audit asked for it.** The check's `priority` is Critical or High in
  the findings file and the recommendation is a concrete change.

The gates generate candidates; they do not size the plan. G2 admits a category at
any count above zero, so on a tidy site it will hand you nine one-row candidates.
Sizing is 1d and 1e, and it happens after the gates rather than instead of them.

### 1d — Consolidation

Group the surviving candidates by the checklist `section` the findings file carries
on every check. Inside a section, every candidate whose row count is **below the
volume floor** (`max(10, 1% of crawl.pagesCrawled)`, the same number E4 and G3 use)
merges into one **family tab**, named for what the section is about rather than for
any rule in it: `Sitemap hygiene`, `Canonical hygiene`, `Hreflang hygiene`.
Candidates at or above the floor keep a tab of their own.

**The merge criterion, in one sentence: same checklist section, both below the
volume floor, remedies of the same kind.** Where a section's small candidates need
genuinely different work — regenerate a file versus rewrite copy — they fall in
different lanes, and the lane split in Step 2 separates them into
`Sitemap hygiene (platform)` and `Sitemap hygiene (pages)`.

**A rule claimed by two checks belongs to one tab.** `checkIds` is a list: on this
ruleset `content.thin` claims CHECK-40 and CHECK-13, so a check-keyed intake picks
it up twice and would hand the same 22 URLs to two teams — and both tabs would pass
their own row-count test while the plan double-counted the site. The rule goes to
the higher-ranked of the checks that admit it — Step 5's ranking with a check's
`count` read as the sum of its rules' counts, and the numerically lowest `checkId`
as the final tiebreak. (`ruleId` cannot break this tie: the contested rule is the
same rule on both sides, so every rule-level field is identical by construction.
CHECK-13 vs CHECK-40 with equal priority, severity and summed counts resolves to
CHECK-13.) The other check's line in the Summary index names the tab that owns
it instead of repeating its rows. If losing that rule leaves the other check with
no rules at all, it is not a tab — it is a cross-reference.

**A check's own rules merge by default, and the fix text is why.** The findings
file carries one `recommendation` per CHECK, not per rule, so four rules under
CHECK-07 would otherwise become four tabs with the identical Fix string — four
copies of one instruction, and a team that works them four times. The default is
one tab per check, named for the check's subject, with a block per rule inside it
(`sitemap.non-200`, `sitemap.non-indexable`, `sitemap.redirected` each a block
under one *Sitemap hygiene* tab). Regenerating the sitemap is one change and it
closes all three.

Split into per-rule tabs when the remedies genuinely differ, and there are three
pieces of evidence that flip it: the check's `notes` prescribe different work for
different rules; the rules land in different lanes (Step 2); or one rule alone is
at or above the volume floor while its siblings are trivial — a 4,000-row list and
a 2-row list are not one work item however alike their fixes read. When you split,
each tab's Fix column carries the check's recommendation plus the one clause that
distinguishes that rule, and the Summary's tab index shows them as siblings.

Inside a family tab, each merged rule or check is its own block: a block row naming
the rule id, its check ids, its count and its fix, then that block's header row and
its rows. The columns are the union across the family, so an evidence key one rule
writes and another does not is an empty cell, never a dropped column. Blocks are
ordered by Step 5's ranking.

A family of one is still a family tab, named for its section. Next quarter's
re-run then adds a second small rule to it without renaming the tab, which is what
"a re-run diffs cleanly" has to mean over time as well as within a run.

### 1e — Rank and cut

Rank every tab by Step 5's ordering and keep the top ten. Everything below the cut
goes to *Considered, not included* with its rank, its count and the reason "below
the cut at rank N".

Three protections. A candidate whose findings-file `priority` is `Critical` is
never cut. **Neither is one at or above the volume floor**: the target exists to
stop a workbook filling with one-row tabs, so a cut that drops a 23-row work item
while keeping a one-row family tab has inverted its own purpose — the cut may only
take below-floor candidates. And every cut candidate is recorded on its own line,
never "and 14 others".

When those protections leave more than ten tabs, the plan is bigger than the target
and the Summary sheet says so in a sentence. That is the honest outcome: the cut
does not get to decide quietly that a site has less wrong with it than it has.

Six to ten tabs is the target because a twenty-tab workbook is a database export,
and the team that receives one does the triage you were supposed to do.

**Nothing is dropped silently, and the claim is over checks.** Every check that
entered 1a, and every rule inside one, is either in a tab, in a family block, or on
the *Considered, not included* list with its count and a one-line reason. A finding
that vanishes between the audit and the deliverable is indistinguishable from a
finding nobody made — the failure the engine's no-silent-fallback rule exists to
prevent, applied to a spreadsheet.

## Step 2 — split by who does the work

<!--
  Structuring the plan around WHO ACTIONS EACH ROW, rather than around which
  check produced it, is a structural idea carried over from the sf-action-plan
  workflow this skill replaces. The idea is kept because it is a good one; the
  lanes below, their names, their tests and every word of this file are ours,
  and the SF-specific mechanics it relied on (link position, XPath columns) do
  not exist on this surface — see the honesty note at the end of this section.
-->

A tab that mixes a one-line template change with four hundred individual page
edits gets neither done. Three lanes:

| Lane | What it means | Who picks it up |
|------|---------------|-----------------|
| **Platform** | One change fixes every affected URL: a template, a config, robots.txt, a sitemap generator, a schema snippet. | Developers |
| **Page-by-page** | Each URL needs its own edit in the CMS: copy, a link in body content, a per-page field. | The content or marketing team |
| **Decide first** | The fix is a choice before it is a change: consolidate or differentiate, redirect or canonical, keep or retire. | The SEO lead, with the client |

When one rule's findings split across lanes, split the tab. `Redirects (platform)`
and `Redirects (pages)` each get worked; one merged tab stalls on its first
ambiguous row.

**How to assign a lane from Ariadne's data:**

- **Cohort concentration.** Call `issues_list` with `ruleId`, then again with
  `ruleId` + `pageType` per cohort. If ~80% or more of a rule's findings sit in one
  cohort, it is a template fault: platform. Spread thinly across many cohorts, a
  handful each, it is page-by-page work. The cohort names come from the metrics
  sweep's `page_type` rows (or `pages_query`) — `pageType` is validated against
  this crawl's own pages and a name it does not know is refused, so do not guess
  one. A site can carry fifty cohorts and one call each is fifty round trips:
  probe the templates Phase 0 named plus the largest few, and stop once the
  distribution is obvious.
- **Site-scoped findings are always platform.** `issue_urls` returns `url: null`
  for a fact about the crawl rather than about a page — a robots.txt pattern, a
  sitemap document, a host redirect. Nobody edits those page by page.
- **The rule's category is a strong prior.** The thirteen categories a rule can
  carry are `on-page`, `canonical`, `indexability`, `hreflang`, `technical`,
  `crawl`, `redirects`, `links`, `sitemap`, `url`, `host`, `content` and
  `structured-data`. Of those, `crawl`, `sitemap`, `canonical`, `hreflang`,
  `host`, `url` and `structured-data` faults are nearly always emitted by one
  template or one configuration: platform. `content`, and much of `on-page`, is
  written per page by people and is fixed the same way.
- **The recommendation's own verb.** "Regenerate the sitemap from…" is platform.
  "Rewrite the descriptions on…" is page-by-page. "Choose whether…" is decide-first.

**Which rows go where, when a tab splits.** The lane is decided for the rule and
then applied row by row, and the split follows the same evidence the inference did:
the rows in the cohort or cohorts that triggered the platform inference go to the
platform tab, and every remaining row goes to the pages tab. Nothing is duplicated
across the two and nothing is left out — the two tabs' row counts sum to the count
`issues_list` reported, and that is the completeness test for a split rule.

A row's cohort comes from the page type the evidence already carries where the rule
wrote one; otherwise from `pages_query` — filter by `pageType` for the cohorts you
care about and match on `url`, or list the pages once and index them locally, which
is the cheaper option when several rules split. A row whose URL is not in the pages
listing at all (a site-scoped finding, a sitemap URL the crawl never reached) goes
to the platform lane: nobody edits it page by page.

**The honest limit.** Ariadne does not record WHERE on a page a link sits. There is
no link-position or XPath column on this surface — the `links` table is never
loaded into memory and never crosses the wire, and `issue_urls` evidence is
whatever the rule itself wrote. So a lane is an inference from cohort
concentration and category, not an observation. Say so on the tab, in one line of
the description row, and make it easy for a developer to move a row to the other
lane rather than pretending the assignment is measured.

## Step 3 — fill a tab, and finish the list

For each tab's rule:

1. `issues_list {crawlId, ruleId}` — the authoritative `count`, the rule's `title`
   and its `checkIds`. Write the count down; it is the tab's completeness test.
2. `issue_urls {crawlId, ruleId, limit: 200}` — then follow `nextCursor`, passing
   it back as `cursor`, **until it comes back `null`**. The default page is 50 and
   the maximum is 200; always ask for 200.

**Pagination discipline.** The loop ends when the cursor ends, not when the list
feels long enough. When it ends, the rows you collected must equal the `count`
from step 1 — that equality is free and it catches a dropped page, a re-used
cursor and a crawl being re-judged underneath you. If they do not match, do not
ship the tab: say which number is which and find out why.

**When to stop paginating and export instead.**

- **`count` > 2,000** — more than ten full pages of round trips. Call
  `export_crawl {crawlId, dataset: "issues"}` once. It writes every finding on the
  crawl as gzipped JSONL and answers `{dataset, path, rows, bytes}`; read the file
  and keep the rows whose `ruleId` is yours. Export rows are
  `{ruleId, checkIds, severity, category, title, url, evidence}` — the same
  evidence, plus the rule's identity on every line.
- **But check where the file landed.** `export_crawl` writes on the SERVER's
  filesystem and hands back a server path. If the server is not on your machine,
  that path is not yours to read, and the answer is to paginate anyway and say in
  the tab how many rows you fetched.
- **Past ~5,000 rows a tab has stopped being a work list.** Nobody works through
  20,000 rows in Excel. Then the tab carries a deliberate slice — the affected
  page types with their counts, and the first N rows in the order below — and its
  description row says exactly that: how many rows are shown, what the total is,
  and the export path where the rest lives. A truncated tab that says it is
  truncated is a deliverable. One that does not is a lie about the size of the
  problem.

## Step 4 — columns

The tab body is the URL plus the rule's own evidence, flattened.

- **Column 1 is `URL`.** For a site-scoped finding (`url: null`) write
  `(site-wide)` and keep the evidence — those rows carry the whole finding.
- **Then every evidence key**, one column each. The evidence repeats the page URL
  as `pageUrl`; drop that one key, since column 1 already carries it. Take the
  union of keys across all of the rule's rows, sorted alphabetically, so two runs
  over the same crawl produce the same workbook.
- **Never drop a key** because most rows lack it, and never fill a blank with a
  zero or an "N/A" — a rule that recorded nothing there recorded nothing there.
  Leave the cell empty.
- **One further key may be collapsed, and only under a test.** Several rules write
  the finding's own URL again under `url` as well as `pageUrl` — the sitemap rules
  do. Drop such a key only when its value equals column 1 on EVERY row of that
  rule, and name the dropped key in the block header so the collapse is visible.
  Any row where it differs means it was never a duplicate: keep the column.
- **Nested values** — arrays and objects — go in as compact JSON in one cell. The
  evidence shape belongs to the rule, and flattening `headingOrder: [1,4,4]` into
  three columns invents a schema the rule never had.
- **Then the columns this skill adds**: `Lane`, `Fix` (the check's
  `recommendation`, verbatim from the findings file) and `Notes` (blank, for the
  team to work in — a spreadsheet people cannot write in comes back as an email).
- **Excel caps a cell at 32,767 characters.** A longer value is truncated with a
  visible marker and the tab points at the export path for the full text.

## Step 5 — build the workbook

**Deterministic order, because a re-run should diff cleanly.** Summary is always
sheet 1. Then the tabs, sorted by:

1. **the findings file's `priority`** — `Critical`, `High`, `Medium`, `Low`, in
   that rank; a check with no priority sorts last;
2. engine severity — critical, warning, info;
3. `count`, descending;
4. `ruleId`, ascending — the final tiebreak, so the order is total.

A family tab or a merged check ranks by its highest-ranked member, with its lowest
`ruleId` as the tiebreak. This is also the ranking 1e cuts against.

**The ordering never reads the report.** `priority` is a field in the findings
file, written by the audit, one of four known values. The report's P1–P4 ladder is
narrative — it is argued in prose, for a human, and parsing it back out of a
markdown document to sort a spreadsheet would make the workbook depend on how
somebody phrased a sentence. The two agree because both are arguing from the same
audit; only one of them is machine-readable, and it is the one that sorts tabs.

Lane is not part of the ordering. It is a column, a tab colour, and how the Summary
sheet groups its index — a developer wants the platform tabs together, and gets
them there, without the sheet order depending on a judgement call.

**Tab names** come from a fixed transformation, so the same findings file always
names its tabs the same way:

- a **rule tab** takes the rule id with `.` replaced by a space — `content thin`;
- a **check tab** (a check's rules merged, 1d) takes the check's subject —
  `Sitemap URLs`, and its check id in the Summary index rather than in the name;
- a **family tab** takes its section's subject plus `hygiene` —
  `Sitemap hygiene`;
- any tab split across lanes appends the lane in parentheses —
  `Sitemap hygiene (platform)`.

Then cut to Excel's 31-character limit — **cutting the subject, never the lane
suffix**: `Crawlability & Robots hygiene (platform)` and the same name with
`(pages)` truncate to the identical 31 characters, and a workbook builder that
silently renames the collision has just produced two tabs nobody can tell apart.
Excel forbids `[ ] : * ? / \` in a sheet name and demands uniqueness; when a
truncation still collides, append `-2`, `-3`, and put the full name in the
Summary's tab index where there is room for it.

**The Summary sheet** carries, in this order:

- what the document is, and the one sentence about lanes;
- the crawl it came from: `crawlId`, site, crawl dates, `pagesCrawled`,
  `rulesetVersion` — so a reader can tell how old the URLs are;
- the tab index, grouped by lane: tab name, lane, priority, engine severity, rule
  id(s), check ids, row count;
- **Considered, not included**: every check and every rule that entered 1a and got
  no tab and no family block, with its count and its one-line reason — an
  exclusion code from 1b, or "below the cut at rank N" from 1e;
- anything from `crawl.caveats` that bounds the row counts (a page cap reached, a
  partial render pass), because a developer reading a tab of 200 URLs deserves to
  know the crawl stopped at 500 pages;
- a pointer to the report for the argument behind the ordering.

**Each tab** opens with a description row a marketer can read without the audit
next to them: what the issue is, why it matters, what the fix is, who does it, and
— where it applies — that the lane is inferred from where the findings cluster.
Then the header row, then the data.

A sketch, not a template to fill in blindly:

```python
import json, openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

LANE_FILL = {                      # the lane is a colour and a column; the ORDER is Step 5's
    "platform": "FFC7CE",
    "pages": "C6EFCE",
    "decide": "FFEB9C",
}

def fit_tab_name(name):
    # Step 5's rule: past 31 chars, cut the SUBJECT, never the lane suffix —
    # "(platform)"/"(pages)" is what keeps two sibling tabs distinct.
    if len(name) <= 31:
        return name
    subject, sep, lane = name.rpartition(" (")
    if not sep:
        return name[:31]
    suffix = " (" + lane
    return subject[: 31 - len(suffix)] + suffix

def add_tab(wb, name, description, headers, rows, lane):
    ws = wb.create_sheet(title=fit_tab_name(name))
    ws.sheet_properties.tabColor = LANE_FILL[lane]
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(len(headers), 1))
    cell = ws.cell(row=1, column=1, value=description)
    cell.alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[1].height = 60
    for i, header in enumerate(headers, start=1):
        head = ws.cell(row=2, column=i, value=header)
        head.font = Font(bold=True)
        head.fill = PatternFill("solid", start_color="D9E1F2")
    for r, row in enumerate(rows, start=3):
        for c, value in enumerate(row, start=1):
            if isinstance(value, (dict, list)):        # the rule's shape, not ours to flatten
                value = json.dumps(value, separators=(",", ":"))
            if isinstance(value, str) and len(value) > 32_000:
                value = value[:32_000] + " …[truncated, see export]"
            ws.cell(row=r, column=c, value=value)
    ws.freeze_panes = "A3"
    for i, header in enumerate(headers, start=1):
        width = max([len(str(header))] + [len(str(row[i - 1] or "")) for row in rows[:200]])
        ws.column_dimensions[get_column_letter(i)].width = min(width + 2, 60)
```

Write the URL column as text. A hyperlink per row is a nicety; 5,000 of them make
a workbook Excel opens slowly, so hyperlink the first column only when the tab is
small enough to be worked by hand.

## Step 6 — hand it over

Save as `{client-or-domain}-action-plan.xlsx` beside the findings file, then say
in the conversation:

- where the file is;
- the tabs, grouped by lane, with row counts — so the client can see at a glance
  what is a developer sprint and what is a content task;
- the total URLs the plan covers;
- what was deliberately left out and why, in one line — the Summary sheet has the
  full list, but the omission is worth saying out loud;
- if any tab is truncated, which one, and what its real total is.

## Before you hand it over

- Every tab's row count equals the `count` `issues_list` reported for its rule (for
  a rule split across lanes, the two tabs' counts sum to it), or the tab says on
  its face that it is a slice and how big the whole is.
- Every tab's `Fix` column came from a `recommendation` in the findings file.
- Every check that entered 1a, and every rule inside one, is a tab, a family block,
  or a line under *Considered, not included*. There is no fourth place to go, and
  an `AGENT` check with no rule behind it is covered by that sentence too.
- Every URL in the workbook came from the crawl id in the findings file.
- The workbook opens, and the tabs are in the deterministic order above.

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

Walk the findings file's `checks`. A check contributes to the plan when its
`verdict` is `FAIL` or `AGENT`, it has a `recommendation`, and its evidence names
at least one rule with a non-zero `count`. Then, for each such rule, decide
whether it earns a tab.

**A rule earns a tab if it clears any one of these gates:**

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

**A rule does not earn a tab when** its fix is a decision rather than an action
(consolidate or differentiate? redirect or canonical?) with no decision yet made —
that belongs in the report, and comes back here once the client has chosen; when
its verdict is `SKIP` (nothing was measured, so there is nothing to action — the
fix is a re-crawl or a connected data source, and the report says so); or when it
is `info` severity, small, and off the templates that matter.

**Nothing is dropped silently.** Every rule with findings that did not get a tab is
listed on the Summary sheet under *Considered, not included*, with its count and a
one-line reason. A finding that vanishes between the audit and the deliverable is
indistinguishable from a finding nobody made — which is exactly the failure the
engine's no-silent-fallback rule exists to prevent, applied to a spreadsheet.

Aim for six to ten tabs. A twenty-tab workbook is a database export, and the team
that receives it does the triage you were supposed to do.

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

1. lane rank — Platform, Page-by-page, Decide first;
2. plan priority — P1 through P4 (the report's ladder, if a report exists;
   otherwise the findings file's `priority`);
3. engine severity — critical, warning, info;
4. `count`, descending;
5. `ruleId`, ascending — the final tiebreak, so the order is total.

**Tab names** are derived from the rule id by a fixed transformation, so the same
crawl always names its tabs the same way: take the rule id, replace `.` with ` `,
append the lane in parentheses where a rule split across lanes, and cut to Excel's
31-character limit. Excel also forbids `[ ] : * ? / \` in a sheet name and demands
uniqueness; when a truncation collides, append `-2`, `-3`.

**The Summary sheet** carries, in this order:

- what the document is, and the one sentence about lanes;
- the crawl it came from: `crawlId`, site, crawl dates, `pagesCrawled`,
  `rulesetVersion` — so a reader can tell how old the URLs are;
- the tab index: tab name, lane, priority, engine severity, rule id, check ids,
  row count;
- **Considered, not included**: every rule with findings that got no tab, its
  count and the reason;
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

LANE_FILL = {                      # lane, not severity: the sheet is sorted by who works it
    "platform": "FFC7CE",
    "pages": "C6EFCE",
    "decide": "FFEB9C",
}

def add_tab(wb, name, description, headers, rows, lane):
    ws = wb.create_sheet(title=name[:31])
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

- Every tab's row count equals the `count` `issues_list` reported for its rule, or
  the tab says on its face that it is a slice and how big the whole is.
- Every tab's `Fix` column came from a `recommendation` in the findings file.
- Every rule with findings is either a tab or a line under *Considered, not
  included*. There is no third place for one to go.
- Every URL in the workbook came from the crawl id in the findings file.
- The workbook opens, and the tabs are in the deterministic order above.

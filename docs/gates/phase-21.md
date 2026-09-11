# Phase 21 gate: metric tables

Date: 2026-09-11. Owner asked what the metrics section is; on hearing that the
demo showed the 14 measurement rules as raw rows of JSON, said "yes, do that" to
giving each metric the treatment findings got in Phase 20: a labelled table
per metric, one row per template, a CSV per table. Spec:
`docs/superpowers/specs/2026-09-11-metric-tables-design.md` (the column and
summary labels in its §2 are the orchestrator's client-facing text).

## Gate clauses

| # | clause | where it is proven |
|---|---|---|
| 1 | every metric rule declares its table; every stored value key is mapped by a column or a summary and every declared column resolves on a real crawl | `test/rules/metric-table.test.ts`; the harness (both directions, per metric); `defineRule` refuses a metric without a table |
| 2 | one shaping, served three ways: the route, the MCP tool `metric_table`, the `metric_table` CSV; the catalog exposes each metric's `table` | `test/api/query.test.ts`, `test/api/mcp.test.ts`, the CSV tests |
| 3 | the demo renders one labelled table per metric and invents no column or label | `test/demo/flow.test.ts` (all 67 declared labels asserted absent from the page source) |
| 4 | the two tables the owner would read first, on the reference crawl | §2 |
| 5 | full suite green, tsc clean; ruleset 0.16.0 on the one ground (labels) | §3 |

## 1. The model

`MetricRule.table` is plain data: one of four shapers (`perScope`,
`perScopeMeasure`, `expandList`, `expandMap`) with the column keys and the
labels. `shapeMetricTable` turns the stored `metrics` rows into
`{summary, columns, rows}` in one place; `GET /crawls/:id/metrics/:metricId`,
`metric_table` and the CSV serve that object. `expandMap` restores the rule's
own order (jsonb does not keep key order). A crawl that was judged and whose
metric wrote nothing gets `rows: []` with a served `note`; an unknown metric or
an unjudged crawl is a 404. The demo shows one block per metric in catalog
order (Site health first): title, description, how to read, the summary line,
the table in its scroll wrapper, a CSV download; a failed block shows its own
error box and the rest stay.

## 2. On the reference crawl

`crawl_b49eab7e` (lavishalice.com, 547 URLs), 2026-09-11, as the page prints
them:

**Site: Pages by worst finding severity**

| Scope | Pages Judged | With Critical | With Warning Only | With Info Only | Clean | Clean Ratio | URLs Not Judged |
|---|---|---|---|---|---|---|---|
| Site | 435 | 8 | 427 | 0 | 0 | 0 | 112 |

**Content: Word count by template** (first two of 36 rows)

| Template | Measure | Pages | Min | P25 | Median | Mean | P75 | P95 | Max |
|---|---|---|---|---|---|---|---|---|---|
| Site | Word Count | 431 | 543 | 800 | 835 | 1,009.4 | 1,099 | 1,853 | 4,138 |
| Site | Renderable Word Count | 431 | 352 | 471 | 511 | 720.0 | 808.5 | 1,579.5 | 3,251 |

The `url.param-volumes` block's summary line reads `Parameters Found: 5 ·
Tracking Parameters: 0 · URLs With Parameters: 61 · Indexable URLs With
Parameters: 57`, first row `_pos | 47 | No`. The CSV for that metric is headed
by the four summary labels then `Parameter, URLs, Tracking`.

## 3. Verification

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| Suite | **82 files / 2,143 tests, 0 failures** (orchestrator's run at 341e875) |
| Review | **[recorded before PR]** |

## 4. What the machine does NOT cover

- The stored values are unchanged; a table can only be as honest as its rule.
  Page weight on the reference crawl reads all zeros for images, CSS and JS
  because that crawl ran without the resource fetch, and the `Floor` column
  says so.
- The summary-as-leading-columns CSV convention repeats site scalars on every
  row; a spreadsheet reader sees them once per row, which is the honest shape
  for a flat file.

## 5. Integration

**[recorded at merge]**

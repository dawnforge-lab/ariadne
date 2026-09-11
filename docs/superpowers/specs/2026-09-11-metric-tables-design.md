# Metric tables: design (Phase 21)

Date: 2026-09-11. Owner, after asking what the metrics section is: "yes, do
that" to giving each metric table the same treatment findings got in Phase 20
(a real table per metric with labelled columns, one row per template, a CSV
per table). Column labels and the summary labels below are client-facing text
and are written here by the orchestrator; the implementer wires them.

## 1. The shape

One served object per metric on a crawl:

```
GET /crawls/:id/metrics/:metricId        (MCP: metric_table; CSV view: metric_table&metricId=…)
{
  metricId, title, explanation, howToFix,          // from the catalog copy
  summary: [{ label, value }] | [],                 // site-level scalars shown above the table
  columns: [{ key, label }],                        // in order; first column is the row's scope where rows are per scope
  rows: [{ [key]: string | number | boolean | null }]
}
```

Rows are shaped SERVER-SIDE in one place (`metricTable(crawlId, metricId)` in
the service) from the stored `metrics` rows, so the demo, the CSV and the MCP
tool agree; the demo invents nothing. A metric declares its table on its rule
definition (`MetricRule.table`), using one of four shapers; `defineRule`
refuses a metric rule without one and a non-metric rule with one.

Shapers:

- `perScope(columns)` — one row per stored row (site first, then the others in
  scope-value order); each column key is a dotted path into `value`.
- `perScopeMeasure(measures, columns)` — one row per stored row × measure;
  `measure` is a column; column keys are paths inside the measure's object.
- `expandList(field, columns, summary?)` — rows are the elements of
  `value[field]` on the site row (each element's keys are the column keys);
  the remaining site scalars become `summary`.
- `expandMap(field, keyLabel, valueLabel)` — rows are the entries of a map,
  one per stored row × entry (used once).

Numbers are served as numbers (the demo formats; the CSV writes them raw);
percentages are served as numbers with a label ending in "(%)"; booleans as
`true`/`false`; a value the metric did not write is `null` and prints empty.
`(untyped)` and `(other)` scope values print as they are.

## 2. The tables

Scope column label: `Template` for `page_type` rows, `Sitemap` for
`sitemap_doc` rows, and the site row prints `Site` in that column.

Distribution columns, in this order and with these labels, wherever a
distribution object appears: `count` → `Pages`, `min` → `Min`, `p25` → `P25`,
`median` → `Median`, `mean` → `Mean`, `p75` → `P75`, `p95` → `P95`, `max` →
`Max`.

| metric | shaper | columns (label ← key) |
|---|---|---|
| `site.health` | perScope | Scope, `Pages Judged` ← urlsTotal, `With Critical` ← urlsWithCritical, `With Warning Only` ← urlsWithWarningOnly, `With Info Only` ← urlsWithInfoOnly, `Clean` ← urlsClean, `Clean Ratio` ← cleanRatio, `URLs Not Judged` ← pagesNotAuditable |
| `content.metrics-by-type` | perScopeMeasure(wordCount → `Word Count`, renderableWordCount → `Renderable Word Count`, textRatio → `Text Ratio`) | Template, `Measure`, then the distribution columns |
| `content.template-similarity` | perScope | Template, `Pages Fingerprinted` ← pagesFingerprinted, `Pages Sampled` ← pagesSampled, `Pairs Compared` ← pairsSampled, `Mean Distance (bits)` ← meanHamming, `P25` ← p25, `Median` ← median, `P75` ← p75, `Within 3 Bits (%)` ← shareWithin3BitsPct, `Within 8 Bits (%)` ← shareWithin8BitsPct |
| `hreflang.coverage` | perScope | Template, `Indexable Pages` ← indexablePages, `Pages With Hreflang` ← pagesWithHreflang, `Coverage (%)` ← coveragePct |
| `inlinks.distribution` | perScope | Template, distribution columns |
| `inlinks.extremes` | expandList over a merged list: each of `top` and `bottom` with a `list` field added | `List` ← list (`Most linked` / `Least linked`), `Address` ← url, `Inlinks` ← inlinks |
| `inlinks.sources-by-type` | expandMap(sources) | `Destination Template` ← scope value, `Source Template` ← map key, `Links` ← map value |
| `page.weight` | perScopeMeasure(pageWeight → `Page Weight`, htmlBytes → `HTML`, imageBytes → `Images`, cssBytes → `CSS`, jsBytes → `JavaScript`) | Template, `Measure`, distribution columns (bytes), then `File References` ← resourcesReferenced, `Files Weighed` ← resourcesWeighed, `Pages With Unweighed Files` ← pagesWithUnmeasuredResources, `Floor` ← atLeast (repeated on each measure row of the scope) |
| `redirect.volume` | perScope | Scope, `Pages Fetched` ← totalPages, `Redirecting URLs` ← redirectPages, `Redirects (%)` ← ratioPct, `Inlinks To Redirects` ← redirectInlinks, `Redirect Chains` ← chains, `Redirect Loops` ← loops |
| `render.coverage` | perScope | Scope, `Pages Crawled` ← pagesCrawled, `Render Run` ← renderPassEvidence, `Selection Mode` ← selectionMode, `Render Budget` ← selectionBudget, `Suspect Pages` ← selectionSuspects, `Sampled Pages` ← selectionSampled, `Selected Pages` ← selectionSelected, `Selection Truncated` ← selectionTruncated, `Pages Rendered` ← pagesRendered, `Render Failures` ← renderFailures |
| `sitemap.structure` | perScope over both scopes | Sitemap (`Site` or the document URL), `Entries` ← totalUrls (site) / urls (document), `Over 50,000 Entries` ← urlCapBreaches (site, a count) / breaches50k (document, a boolean), `Documents` ← docs (site only), `Documents Dropped For Size` ← oversizedDocsSkipped (site only), `Entry Cap Reached` ← entryCapReached (site only) |
| `structure.click-depth-distribution` | perScope | Template, distribution columns, `Unreachable Pages` ← nullCount |
| `structure.depth-distribution` | perScope | Template, distribution columns |
| `url.param-volumes` | expandList(topParams) | `Parameter` ← name, `URLs` ← occurrences, `Tracking` ← isTracking; summary: `Parameters Found` ← totalParams, `Tracking Parameters` ← trackingParams, `URLs With Parameters` ← parameterisedPages, `Indexable URLs With Parameters` ← parameterisedIndexablePages |

Where a site-row and a template-row carry different keys for the same column
(`sitemap.structure`), the declaration maps both; a key absent on a row prints
empty.

## 3. Where it shows

- **API/MCP**: the route and tool above; `GET /crawls/:id/metrics` (the raw
  rows) stays as it is. The catalog exposes each metric rule's `table`
  declaration (columns and summary labels) the way it exposes `columns`.
- **CSV**: view `metric_table`, header = the labels, one row per table row,
  summary values written as a leading comment-free block? No: CSV has no
  place for a summary, so the summary labels become extra columns repeated on
  every row (documented), filename `<crawl>-<metricId>.csv`.
- **Demo**: the Metrics section becomes one block per metric in catalog order:
  the title as heading, the description, the summary as a line of
  `label: value` pairs, the table (scrolling in its own container, numbers
  formatted with thousands separators, percentages to one decimal, booleans
  as Yes/No, null empty), and a `Download CSV` link. The raw metric rows are
  no longer shown.

## 4. Not changed

The stored `metrics` rows, their values, the metric rules' predicates, the
copy (the titles and descriptions written in Phase 20 head each block). No
ruleset bump: the table declaration is presentation of stored values and adds
no client-facing sentence beyond the labels, which the catalog serves —
counted as a ground? Yes: labels are copy a client reads, so **0.15.0 →
0.16.0** on that one ground, stated in registry.ts.

## 5. Tasks

| task | who | files |
|---|---|---|
| T1 | opus | `MetricRule.table` + shapers + `defineRule` validation; every metric rule's declaration from §2; `metricTable` in the service; the route, the MCP tool, the CSV view; catalog exposure; tests (unit per shaper; API over the fixture crawl; harness: every metric's table renders without a null column that the rule writes); talos-surface |
| T2 | opus, after T1 | demo Metrics section; flow tests |
| T3 | orchestrator | ruleset 0.16.0, gate doc with two tables from the reference crawl, review, PR |

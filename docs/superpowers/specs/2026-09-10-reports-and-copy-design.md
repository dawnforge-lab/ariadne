# Reports with columns, and copy in SEO-tool register: design (Phase 20)

Date: 2026-09-10. Owner, reading `sitemap.non-200`'s text: "a lot of prose for
communicating a simple fact, plus ambiguous … could just simply say the sitemap
includes non indexable URLs, and when we display the URLs in the findings we
need to actually present the report exports not just the URL … the table should
show the URL, status code and if it's non indexable by status code the other
reason canonical, robots.txt, meta robots. … Texts rewritten for an SEO tool,
not for a chat, concise, direct, easy to understand and not ambiguous but also
using the well known SEO language. The reports must be actionable, not just a
list of URLs." Owner approved the register and the report model on three
samples ("go").

Reference: Screaming Frog's Issues Overview and per-issue exports, taken from
the owner's SimpleErb crawl with the CLI (Issue Name / Type / Priority /
Description / How To Fix; every per-issue export carries Address, Indexability,
Indexability Status plus the issue's own columns; inlinks exports carry Source,
Destination, Anchor, Status Code). Their texts are proprietary and are the
register, not the source.

## 1. Copy

Written by the orchestrator (owner: "do not let Opus 5 write user facing
texts"). Style:

- **Title** = `Area: Condition`, the area from a fixed list (Response codes,
  Sitemaps, Canonicals, Directives, Page titles, Meta description, H1,
  Headings, Content, Images, Links, Hreflang, Redirects, URL, Security,
  Structured data, Pagination, Site, Crawl, Resources, Mobile, Performance,
  Rendering), the condition stated with its threshold or status class.
- **Description** = one to three sentences: what the rows are, why it matters.
  SEO vocabulary as practitioners use it (indexable, canonicalised, noindex,
  4xx, crawl budget, return link). No hedging, no "we", no engine words.
- **How to fix** = one or two imperative sentences with the concrete action;
  the template-level fix where it applies.
- **Marker reason** = one sentence: what was not checked, why, what answers it.
- **Metric rules** = title "Area: Table name"; description says what each
  column is and how to read it in two or three sentences; fix = how to use it.
- Copy rubric test keeps the banned engine words and the threshold-in-title
  rule; the structure rules become: title matches `^[A-Z][^:]+: .+`, no
  trailing period, ≤ 80 chars; description 1–3 sentences; fix ≥ 1 imperative.

## 2. Reports: every finding is a table

### 2.1 The row

Every finding row served by `GET /crawls/:id/issues/:rule/urls` (and the
MCP `issue_urls`, and the `issue_urls` CSV view) carries, in order:

1. the **standard columns**, derived from the page row when the finding names
   a page (`page_id` not null): `address` (the URL), `statusCode`,
   `indexability` (`Indexable` | `Non-Indexable`), `indexabilityStatus`
   (`""` when indexable; else one of `Noindex`, `Canonicalised`, `Redirected`,
   `Client Error`, `Server Error`, `Blocked by bot protection` (added at review:
   a challenge is routinely served with a 200), `Blocked by robots.txt`, `No
   Response`, `Not HTML`), computed by ONE helper `indexabilityOf(page)` in
   `src/rules/helpers.ts` from `fetch_class`, `status_code`, `robots_meta` /
   `x_robots_tag`, the effective canonical (`isCanonicalisedElsewhere`) and
   `is_indexable`. When several apply the order above wins (a redirect is
   `Redirected` before anything else; a 200 with noindex is `Noindex`; a 200
   canonicalised elsewhere is `Canonicalised`). Site-scoped findings
   (`page_id` null) carry `address: null` and no standard columns.
2. the **rule's declared columns**: `RuleMeta.columns: ReadonlyArray<{key,
   label}>` where `key` names an evidence field, and `label` is the header a
   client sees (Screaming Frog's vocabulary where one exists: `Status Code`,
   `Inlinks`, `Title 1`, `Title 1 Length`, `Word Count`, `No. Near Duplicates`,
   `Closest Near Duplicate Match`, `Canonical Link Element`, `Meta Robots`,
   `hreflang`, `Expected Link`, `URL Not Returning Link`, `Source`, `Anchor`).
   `defineRule` refuses a column whose key the rule's evidence never writes
   (checked by the harness over the fixture crawl: every declared column of a
   rule that fired must appear in at least one of its rows) and a rule whose
   evidence has keys no column names except the `pageUrl` the writer adds —
   evidence is the report, so an undeclared key is a column nobody sees.
   Array-valued evidence (`sampleSources`, `closest`, `hosts`, `chain`) is
   rendered as a comma-joined cell in CSV and the demo, with the same
   `truncated` conventions the listing already has.

### 2.2 Where the columns show

- **API**: rows are `{address, statusCode, indexability, indexabilityStatus,
  ...evidence}`; the response also carries `columns: [{key, label}]` for the
  rule (standard first), so a client renders without a second call. The
  catalog (`GET /rules`, `rules_catalog`) exposes `columns` per rule.
- **CSV** `issue_urls`: header row = the labels; one row per finding; the
  filename `<crawl>-<rule>.csv`.
- **Demo**: "Show URLs" becomes a table with those headers; a "Download CSV"
  link beside it hits the CSV export for that rule (through the proxy).
- **Companion inlinks report** for the link rules (`links.broken-internal`,
  `links.to-server-error`): `GET /crawls/:id/issues/:rule/inlinks` — Source,
  Destination, Anchor, Status Code, one row per link from the `links` table
  (SQL, hard rule 3, cursor-paged) — and the `links_to_4xx` CSV view already
  has the shape; align its columns and add the 5xx twin.

### 2.3 Evidence gaps the columns expose

Where a rule's report needs a column its evidence does not carry, the evidence
gains it (a ruleset bump, 0.14.0 → 0.15.0, on the ground "evidence shape"):
`sitemap.non-indexable` gains the reason (the standard columns give it for
free); `title.*` / `meta-description.*` / `h1.*` carry the text and its length
already; `links.orphan` carries `discoveredVia`; `structure.deep-page` carries
`clickDepth`; `images.*` carry the resource and bytes. The implementer lists
every rule whose evidence has to change.

## 3. Not changed

Severities, the marker mechanism, the crawl, the fingerprint. The metric
tables' shapes (their copy changes; their rows do not).

## 4. Tasks

| task | who | files |
|---|---|---|
| T1 | opus | `indexabilityOf`; `RuleMeta.columns` + `defineRule` validation; every rule's `columns` declaration (labels from §2.1's vocabulary); listing rows with standard columns; catalog `columns`; CSV `issue_urls` with labels; MCP descriptions; `/inlinks` companion; harness column check; tests; talos-surface |
| T2 | orchestrator | all 100 entries of `issue-copy.ts` and every `marker` string; the rubric test's structure rules |
| T3 | opus, after T1 | demo table + CSV link + flow tests |
| T4 | orchestrator | ruleset 0.15.0, gate doc with the sitemap table from the reference crawl, review, PR |

T1 and T2 are disjoint (`issue-copy.ts` and `test/rules/copy.test.ts` are T2's
only; T1 does not touch them).

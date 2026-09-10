# Phase 20 gate: reports with columns, copy in SEO-tool register

Date: 2026-09-10. Owner, reading `sitemap.non-200`'s text: "a lot of prose for
communicating a simple fact, plus ambiguous … the table should show the URL,
status code and if it's non indexable by status code the other reason
canonical, robots.txt, meta robots … Texts rewritten for an SEO tool, not for a
chat … The reports must be actionable, not just a list of URLs." And: "do not
let Opus 5 write user facing texts." Spec:
`docs/superpowers/specs/2026-09-10-reports-and-copy-design.md`. Reference:
Screaming Frog's Issues Overview and per-issue exports, taken from the owner's
SimpleErb crawl with the CLI (41 issues; every per-issue export carries
Address, Indexability, Indexability Status plus the issue's own columns).

## Gate clauses

| # | clause | where it is proven |
|---|---|---|
| 1 | every client-facing string rewritten in the register the owner approved on three samples, by the orchestrator, not by an implementer model | `git log -1 --format=%an d77390b`; §1 |
| 2 | the copy rubric green over all 100 rules: `Area: Condition` titles from the area allowlist, ≤ 80 chars, 1–3 sentences, an imperative fix, thresholds from the rule constants, no engine words, every accuracy lesson from the previous test file carried forward at claim level | `test/rules/copy.test.ts` (94 tests) |
| 3 | every finding row carries Address, Status Code, Indexability, Indexability Status plus the rule's declared columns, on the API, the MCP tool, the CSV and the demo | §2; `test/api/query.test.ts`, `test/api/mcp.test.ts`, `test/demo/flow.test.ts`, the harness column check |
| 4 | the sitemap report on the reference crawl reads as the owner asked | §3 |
| 5 | full suite green, tsc clean; ruleset 0.15.0 | §4 |

## 1. The copy

100 entries and 12 marker reasons, written by hand against the rule sources.
Shape: `Area: Condition` (24 areas), one to three sentences on what the rows are
and why it matters, one or two imperatives on the fix, SEO vocabulary; metric
rules describe their table. Examples on the owner's own complaint:

- `sitemap.non-200` was "Sitemap lists a URL that does not return 200 / This
  URL is published in the site's sitemap and answered with something other
  than a 200 when it was fetched — the finding carries the status …" and is now
  **Sitemaps: Sitemap URLs returning 4xx or 5xx** / "URLs listed in the sitemap
  that returned a 4xx or 5xx status when crawled, including 401, 403 and 429
  answers to the crawler; the row shows the status code. Redirecting URLs and
  URLs that got no response are reported separately. …" (the first draft said
  "3xx, 4xx or 5xx" and "something other than 200"; the review showed a 3xx
  never reaches this rule, and the hedge was the owner's own complaint).
- `links.broken-internal`: **Response codes: Internal client error (4xx)** /
  "Internal links to URLs that return a 4xx, most often 404 not found or 410
  gone. URLs that answered 401, 403 or 429 are reported under Response codes:
  Blocked by bot protection instead. …" (the first draft listed 403 and 401 as
  members, an error inherited from the old text: those are `blocked`, never
  `client_error`).
- `content.near-duplicate`: **Content: Near duplicates (main content within 3 of
  64 fingerprint bits)**.

The rubric test replaced 1,855 lines that pinned sentences of the old prose
with 94 tests that pin claims (concept regexes), so the next rewrite does not
have to fight the test to say the same fact in different words.

## 2. The report model

`indexabilityOf(page)` derives Indexability and Indexability Status from the
page row with a fixed precedence (Redirected, Client Error, Server Error,
Blocked by bot protection, Blocked by robots.txt, No Response, Not HTML,
Noindex, Canonicalised; else Indexable) and checks itself against
`is_indexable` on every `ok` row. Every finding rule
declares `columns` (231 over 86 rules, 12 optional, three empty: their report is
the standard four); `defineRule` validates the declaration — keys and headings
both unique, and neither a key nor a heading the surface prints itself — the
static column test proves every declared key is named in its rule's own source,
and the harness proves every declared key is written and every written key
declared on the fixture crawl. Listings return `columns` with every page beside
rows carrying the standard four and the verbatim evidence; the catalog exposes
`columns`; the `issue_urls` CSV is headed by the labels and named
`crawl_<uuid>-<rule>.csv`;
`/issues/:rule/inlinks` (Source, Destination, Anchor, Status Code) serves the
two link rules with `links_to_4xx` / `links_to_5xx` CSV views. The demo builds
its table from `columns` and invents none (a static-parse test proves it),
with a CSV download per rule and an inlinks table for the link rules.

## 3. The sitemap report on the reference crawl

`crawl_b49eab7e` (lavishalice.com, 547 URLs), judged at 0.15.0 through the
branch's demo on 2026-09-10, `GET /issues/sitemap.non-200/urls`:

| Address | Status Code | Indexability | Indexability Status | Fetch Class |
|---|---|---|---|---|
| /products/anais-ombre-embellished-strapless-midi-dress-in-black | 404 | Non-Indexable | Client Error | client_error |
| /products/aubrey-high-neck-fluted-sleeve-micro-button-midi-dress-in-burgundy | 404 | Non-Indexable | Client Error | client_error |
| /products/mirabella-satin-floral-embellished-sequin-mini-tulip-dress-in-silver | 404 | Non-Indexable | Client Error | client_error |

The CSV export of the same rule is headed `Address, Status Code, Indexability,
Indexability Status, Fetch Class, Truncated`; `links_to_4xx` is headed
`Source, Destination, Anchor, Status Code`. A noindex entry reads
`Non-Indexable | Noindex` in the same two columns under **Sitemaps: Sitemap URLs
with noindex** (`sitemap.non-indexable`, whose predicate is `is_indexable =
false` on a 200), which is the "other reason" the owner asked for. A
CANONICALISED sitemap entry is not in any sitemap report at all: `is_indexable`
is true on it (the writer cannot see a canonical), so `sitemap.non-indexable`
does not fire, and no other sitemap rule asks the question — ledgered, not
claimed as covered.

## 4. Verification

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| Suite | **81 files / 2,103 tests, 0 failures** (orchestrator's run after the review wave) |
| Review | independent opus review of the whole branch: no blockers in the mechanics; 12 factual defects and ~50 should-fix items in the hand-written copy, every one re-checked against the rule source and corrected by the orchestrator (the most consequential: 401/403/429 never reach the 4xx link rule, a 3xx never reaches the sitemap non-200 rule, the render ratio is over renderable words, the recheck states, the duplicate cohorts, the sample caps); engineering fixes applied (Blocked by bot protection status, a static column-key test over all 231 columns, CSV/demo cell parity test, label collisions refused, catalog re-measured at 93,778 bytes); one reviewer claim refuted with evidence (the render-diff column labels were correct) |

## 5. What the machine does NOT cover

- The rubric test pins shape and claims; it cannot judge whether a sentence is
  true. The review (§4) checked every entry's facts against its rule source;
  the `// Accuracy` contract now lives in the test's `it` names.
- Screaming Frog's texts were read for register only; none of their wording is
  in this repository.
- `links_to_4xx`'s CSV header changed order (Source, Destination, Anchor,
  Status Code). A consumer that read it by position would move; none is known.

## 6. Integration

**[recorded at merge]**

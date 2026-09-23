# The judged cohort: design (Phase 22)

Date: 2026-09-23. Owner, reading the raelon.ca crawl: "duplicate content is
being reported on pages that are canonicalized or have the hreflang rules in
place … Same thing on structured data I see issues reported on canonicalised
pages. … if a page is indexable or not or it has other rules in place that
doesn't make it an error." Owner approved the three-part design below ("go"),
including removing informational findings from canonicalised pages.

## 0. Evidence (`crawl_f00d2271`, raelon.ca, 371 OK pages, bilingual en/fr)

163 of 371 OK pages are canonicalised elsewhere (Shopify collection paths to
`/products/x`, `?page=1` variants); all 371 declare reciprocal en/fr/x-default
hreflang. Only the two content-duplicate rules and the hreflang rules respect
the canonical today.

| rule | today | minus canonicalised | minus hreflang alternates too |
|---|---|---|---|
| title.duplicate | 79 groups | 5 | 0 |
| meta-description.duplicate | 78 | 12 | 8 |
| h1.duplicate-text | 83 | 15 | 9 |
| schema.product-incomplete | 40 | 10 | 10 |
| content.near-duplicate | 2 (the en/fr refund policy) | 2 | 0 |

## 1. One cohort: the judged page

**A judged page** is one the audit reports defects on as its own page:

```
fetch_class = 'ok' AND status_code = 200 AND is_indexable = true
AND NOT canonicalised elsewhere
```

One helper pair in `src/rules/helpers.ts`, replacing every inline spelling:
`isJudged(page)` (TypeScript) and `JUDGED(alias)` (SQL, composed from the
existing `FETCHED_OK` and `CANONICALISED_ELSEWHERE` twins plus
`is_indexable = true`). `isAuditable` / `FETCHED_OK` stay for the rules that
genuinely want "fetched OK" (below). `content.ts`'s private `AUDITABLE` and
every other file's inline `fetch_class = 'ok' and status_code = 200 [and
is_indexable]` become `JUDGED`.

**Rules that move to the judged cohort** (a canonicalised or noindex page
carries none of these; the defect belongs to the URL it defers to):

- on-page: title.missing / too-short / too-long / duplicate,
  meta-description.missing / too-short / too-long / duplicate,
  headings.h1-missing / h1-multiple / level-skip, h1.duplicate-text,
  content.placeholder
- content: content.thin, content.near-duplicate, content.exact-duplicate
  (already), content.soft-404 (a canonicalised soft 404 is still a soft 404 —
  KEEP on the fetched-OK cohort; see below)
- technical: images.missing-alt, images.missing-dimensions,
  mobile.viewport-missing, performance.slow-response
- structured data: schema.product-incomplete, schema.self-serving-reviews
  (page-scoped); the site-scoped `schema.none-on-site` /
  `schema.breadcrumb-absent` count judged pages
- links: links.orphan, structure.deep-page (an orphaned or deep canonicalised
  page is the base URL's problem)
- sitemap: pages.not-in-sitemap (a canonicalised page should NOT be in the
  sitemap; reporting it as missing is the inverse of right)
- url: url.parameter-pages-indexable already requires a self-canonical; the
  metrics' shared cohort (`metric/cohort.ts`) and `site.health`'s
  `urlsTotal` become judged pages

**Rules that keep their own cohort, on purpose:**

- the canonical rules (`canonical.*`, `directive.canonical-noindex-conflict`):
  their subject is the canonical
- `indexability.noindex`, `indexability.meta-header-conflict`: their subject
  is the directive
- the response-code rules (`http.server-error*`, `crawl.blocked`,
  `links.broken-internal`, `links.to-server-error`): a 404 is a 404
- `content.soft-404`: a 200 that is really a not-found is a fault whatever
  its canonical says (fetched OK + 200, indexable or not)
- the sitemap rules about sitemap entries (`sitemap.non-200`, `.redirected`,
  `.non-indexable`, `.uncrawled`, `robots.blocks-sitemap-urls`): their subject
  is the sitemap entry, and a canonicalised entry is precisely what
  `sitemap.non-indexable` should ALSO report — it gains the canonicalised case
  (the Phase 20 ledger item), title "Sitemaps: Sitemap URLs that are noindex or
  canonicalised", evidence `reason: "noindex" | "canonicalised"`, the Reason
  column
- the resource rules (`resources.*`, `images.oversized`,
  `images.legacy-format`): their subject is the file; the referencing-page
  sample stays as is
- render rules (`content.csr-dependent`, `nav.js-only`, `filters.js-only`,
  `redirect.js`): fetched OK; a canonicalised page rendered by the sample is
  still evidence about the template
- `url.normalisation-variants`, `url.tracking-params-internal`,
  `hreflang.*` (already canonical-aware), `pagination.*`

## 2. Hreflang alternates are one page for the duplicate rules

For `title.duplicate`, `meta-description.duplicate`, `h1.duplicate-text` and
`content.near-duplicate`: two judged pages that declare each other as
hreflang alternates with different language codes (reciprocal: A names B and
B names A, both rows in `hreflang`) are one member of a duplicate group. A
group collapses to the count of distinct hreflang clusters among its members;
below two, no finding. Evidence: `pages` lists one URL per cluster (the
lexically first) and a new `alternatesCollapsed: N` says how many URLs were
folded in. In SQL: a cluster key = the lexically-smallest URL among a page and
the alternates it declares that declare it back, computed in one CTE over
`hreflang` (hard rule 3), reused by the four rules.

`content.exact-duplicate` is NOT collapsed: byte-identical bodies across two
locales means the translation is missing, which is a real finding. Its copy
says so.

## 3. Nothing goes silent without a trace

- `site.health` gains `urlsCanonicalised` and `urlsNoindex` (fetched OK, 200,
  excluded from `urlsTotal` for that reason; the two are disjoint with
  **noindex** taking precedence, as in `indexabilityOf` — this clause read
  "canonicalised taking precedence" when it was written and was wrong about the
  helper, which resolves `Noindex` before `Canonicalised`; corrected in place
  during T1 so the spec names one vocabulary and not two, and
  `sitemap.non-indexable`'s `reason` follows the same order), columns
  `Canonicalised (set aside)` and `Noindex (set aside)`. `urlsTotal +
  urlsCanonicalised + urlsNoindex + pagesNotAuditable` = every fetched URL.
- The demo's summary line shows `judged N of M fetched (C canonicalised, X
  noindex set aside)` from the health row.
- Copy: every rule that moved says "Indexable, self-canonical pages …" or
  "judged pages" in its first sentence — the orchestrator writes those
  sentences (list them in the report; do not write them yourself).

## 4. Ruleset 0.17.0

Verdicts move on 26 rules (fewer findings on any site with canonicalised
pages or hreflang clusters); `sitemap.non-indexable` gains a case; no evidence
key is removed. Nothing backfilled.

## 5. Tasks

| task | who | files |
|---|---|---|
| T1 | opus | `isJudged` / `JUDGED`; every rule in §1 moved; metrics cohort + site.health columns; `sitemap.non-indexable` canonicalised case; tests per rule (a canonicalised page and a noindex page each produce no finding; the fixture harness expectations re-derived with a comment per change); the hreflang cluster CTE and its use in the four duplicate rules with tests (reciprocal pair collapses; one-way pair does not; same-language pair does not) |
| T2 | orchestrator | copy sentences, ruleset bump, gate doc with the raelon.ca before/after, review, PR |

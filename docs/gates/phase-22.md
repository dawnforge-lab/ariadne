# Phase 22 gate: the judged cohort

Date: 2026-09-23. Owner, reading the raelon.ca crawl: "duplicate content is
being reported on pages that are canonicalized or have the hreflang rules in
place … Same thing on structured data I see issues reported on canonicalised
pages … if a page is indexable or not or it has other rules in place that
doesn't make it an error." Spec:
`docs/superpowers/specs/2026-09-23-judged-cohort-design.md` (three parts,
owner-approved including the removal of informational findings from
canonicalised pages).

## Gate clauses

| # | clause | where it is proven |
|---|---|---|
| 1 | one cohort definition, used by every page-defect rule and the metrics: fetched OK, 200, indexable, not canonicalised elsewhere | `isJudged` / `JUDGED` in `src/rules/helpers.ts`; the values-table agreement test; grep of every rule module |
| 2 | no rule that moved fires on a fetched-200 page outside the cohort | the harness test over 26 rules × the fixture's 10 not-judged pages |
| 3 | reciprocal hreflang alternates count as one page in the four duplicate rules; exact-duplicate is not collapsed | `test/rules/field-duplicates.test.ts`, `test/rules/content-query.test.ts`; the fixture pair `/authored3/hreflang-a` and `-b` sharing a title and carrying no finding |
| 4 | the pages set aside are counted, never silent | `site.health`'s two new columns and the four-way partition, asserted in its test and in the harness |
| 5 | the motivating crawl re-judged shows the predicted deltas | §2 |
| 6 | full suite green, tsc clean; ruleset 0.17.0 | §3 |

## 1. What changed

A page defect is now reported only on a **judged** page. Twenty-six rules
moved (titles, meta descriptions, headings, placeholder, images, viewport,
slow response, thin, near-duplicate, orphan, deep page, sitemap absence, the
two page-scoped structured-data rules); the metrics' shared cohort and
`site.health`'s `urlsTotal` count the same pages. The rules whose subject is
the canonical, the directive, the response code, the sitemap entry, the file
or the rendered template keep fetched-OK on purpose, and each docblock says
why. `sitemap.non-indexable` gains the canonicalised case with a Reason
column. The three field-duplicate rules and near-duplicate fold reciprocal
hreflang alternates (both directions declared, different language codes, both
pages judged) into one member; `alternatesCollapsed` says how many.
Exact-duplicate is deliberately not collapsed: identical text across two
locales is a missing translation. Noindex wins over canonicalised wherever a
page is both, in the Indexability Status column, in `site.health`'s set-aside
counts and in the sitemap rule's reason — one vocabulary, three places.

## 2. The motivating crawl, re-judged

`crawl_f00d2271` (raelon.ca, 475 URLs, 371 fetched OK 200, bilingual en/fr
with reciprocal hreflang, 163 pages canonicalised to another URL):

| rule | 0.16.0 | 0.17.0 |
|---|---|---|
| title.duplicate | 79 | 0 |
| meta-description.duplicate | 78 | 8 |
| h1.duplicate-text | 83 | 9 |
| content.near-duplicate | 2 (the en/fr refund policy) | 0 |
| schema.product-incomplete | 40 | 10 |
| pages.not-in-sitemap | 181 | 18 |
| headings.level-skip | 252 | 138 |
| title.too-long | 219 | 134 |
| meta-description.too-long | 205 | 111 |
| images.missing-dimensions | 177 | 113 |
| findings in total | 1,955 | 1,166 |

`site.health`: judged 208, canonicalised set aside 163, noindex set aside 0,
other crawled URLs 104; 208 + 163 + 0 + 104 = 475.

On the lavishalice crawl (`crawl_0d88567f`, 629 URLs, 3,584 hreflang rows):
title.duplicate 86 → 2, meta-description.duplicate 106 → 22, h1.duplicate-text
111 → 27, pages.not-in-sitemap 138 → 43; the cluster CTE added no measurable
time to the rules pass.

## 3. Verification

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| Suite | **83 files / 2,201 tests, 0 failures** (orchestrator's run after the review wave) |
| Review | independent opus review: no blockers; one real defect — the hreflang cluster key was order-dependent for pages sharing a hub they did not declare each other through — fixed as a mutual-neighbourhood fold with the hub and chain topologies pinned, no count on either reference crawl moved; the living checklist, a doc example row, a harness comment and the sitemap rule's NULL handling aligned to noindex-first; the catalog re-measured at 101,010 bytes |

## 4. What the machine does NOT cover

- A canonicalised page whose canonical target was never crawled defers to a
  URL the audit cannot judge; its defects are reported nowhere. The
  `canonical.*` rules report the target's state where it was crawled.
- **Spec §3's demo summary line is not implemented.** The demo still prints
  `judged: N finding(s) over M page(s)` after the rules pass, not `judged N of M
  fetched (C canonicalised, X noindex set aside)`; the judged count and the two
  set-aside counts reach a reader through the `site.health` table on the same
  page and nowhere else. Recorded rather than built: the numbers are published
  and named, and the one-line restatement of them is a demo-surface change.
- Hreflang collapse is MUTUAL and nothing weaker: pages fold together only
  when their closed reciprocal neighbourhoods are identical, so a set declared
  from one side only, and a set whose members do not all name each other, are
  still reported as duplicates — and the hreflang rules say why the set is
  broken. (Reviewed at PR time: the first implementation keyed each page on the
  smallest URL one hop out, which let a page OUTSIDE the duplicate group decide
  the group's size. Fixed, with the hub and chain topologies pinned in
  test/rules/field-duplicates.test.ts; no count on either reference crawl
  moved.)
- Informational findings on set-aside pages are gone by the owner's choice;
  Screaming Frog would still list them under a non-indexable filter.

## 5. Integration

**[recorded at merge]**

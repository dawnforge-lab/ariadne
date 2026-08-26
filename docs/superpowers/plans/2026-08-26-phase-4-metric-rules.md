# Ariadne Phase 4: Metric Rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The metric layer — 9 metric rules producing quotable distribution/cohort tables in the `metrics` table (inlinks, depth, content, hreflang coverage, param volumes, redirect ratio, sitemap structure), the runner extension that drives them, the Phase 3 carried backlog discharged (normalization seam, accumulator sweep, probe containment, truncated-key rename, CHECK-44 widening), and a full-pipeline 50k scale measurement — ending with the coverage pin at exactly `RENDER_CHECKS` (01/02/34).

**Architecture:** Metric rules are `(db, crawlId) => Promise<Metric[]>` — pure SQL aggregation (percentiles via `percentile_cont`, cohorts via `GROUP BY page_type`), never loading tables into RAM. The runner gains a metric phase after query rules, upserting rows on the `metrics` table's composite PK — idempotent like issues. Metric values follow the spec §3 shape: `{ count, min, p25, median, p75, p95, max, mean }` for distributions, plus bounded top/bottom lists (20) and cohort rows per page type as separate `scope: "page_type"` metric rows.

**Tech Stack:** Existing stack. No new dependencies.

**Spec:** `docs/crawl-audit-engine-spec.md` §2 (`metrics` table), §3 (Metric contract), §4 metric rows; build plan §4 P4-T1…T7 + gate ("each metric renders as a table an agent can quote directly, with no post-processing needed to answer the checklist's 'Record:' lines"). Owner-approved design (2026-08-26 session): (1) normalization seam = second normalized columns, published spellings kept as evidence; (2) CHECK-38 evidence ships intra-page-type simhash similarity, explicitly labeled template similarity, never "boilerplate"; (3) CHECK-08 confirmed metric-kind (shard structure numbers); (4) CHECK-44 recommended set widens to the checklist's full list; (5) the 50k full-pipeline measurement is the phase's scale evidence.

## Global Constraints

- Node 22, TypeScript strict + isolatedModules; `npx tsc --noEmit` and `npm test` green at every commit; `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`, DB tests throw if unset.
- **Metric rules never load tables into RAM** — percentiles, counts, and cohorts are SQL; top/bottom lists are `ORDER BY … LIMIT 20` in SQL. **No metric row's jsonb may exceed a bounded size** (lists capped at 20, cohort rows are separate metric rows, never nested arrays of all pages).
- Metric rules carry registry copy (title = the table's label; explanation = what the numbers mean; howToFix = how to read/act — same `copyFor` discipline, no overpromising).
- Every rule keeps `checkIds` tracing; the phase ends with `METRIC_PENDING_CHECKS` deleted (its four ids claimed) and the coverage pin === `RENDER_CHECKS`.
- Established patterns are law: `queryFinding`-style single-sourcing (add the metric analog), validate-don't-cast evidence parsers, noteTruncation contracts, exact-set harness pins, drizzle-kit-only migrations, provenance where anything is absorbed (nothing is).
- Commit after each green cycle, conventional messages ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Normalization seam — second normalized columns (the ruled Phase 4 opener)

**Files:** Modify `src/db/schema.ts` (+migration 0006), `src/crawl/persist.ts`, `src/crawl/loop.ts` (sitemap persist), `src/rules/query/redirects.ts`, `src/rules/query/sitemap.ts`, `src/rules/query/link-graph.ts`, `src/rules/query/robots.ts`; tests throughout.

**Interfaces:** `pages` gains `redirect_url_normalised text` (null when no redirect or unresolvable-per-policy); `sitemap_urls` gains `url_normalised text notnull`. Writers populate via `normalizeUrl` (persist for pages; the loop's sitemap persist for sitemap_urls). The published spellings (`redirect_url`, `sitemap_urls.url`) stay untouched as evidence. Every join that previously matched a stored spelling against `pages.url` switches to the normalized column: the redirect walk's recursive join, the four sitemap⋈pages rules, `pages.not-in-sitemap`'s anti-join, orphan's `inSitemap` evidence, `robots.blocks-sitemap-urls`' entry list (evidence keeps the published `<loc>`). The `normalizationSensitive` evidence flags and their pinned harness test are REMOVED (the gap is closed — deleting the flag is the proof). Fixture: add a `<loc>` with a fragment + unsorted params for an existing page and assert it now joins (the case that used to false-positive).

- [x] Failing tests (the fragment-loc join case; redirect chain through a fragment Location) → migration 0006 (additive) → writers → joins → flag removal → full suite green → commit `feat: normalized join columns for stored URLs — seam closed (P4 opener)`.

---

### Task 2: Carried-backlog sweep — probe containment, accumulator caps, renames, comments

**Files:** Modify `src/crawl/loop.ts`, `src/rules/query/{link-targets,pagination,hreflang,redirects,robots}.ts`, `src/rules/query/crawl-evidence.ts` comments; tests.

- **Probe containment:** `probeKnownMissing`'s invocation gets its own try/catch — a probe-side throw (DB update, analyzePage) writes `{ skipped: "probe failed: <message>" }` into `notfound_probe_jsonb` (best-effort; if even that write fails, log-and-continue is NOT allowed — collect into the existing failures aggregation instead) and never converts a finished crawl to failed. Test: poison the probe path, assert crawls.status stays finished + the skipped shape.
- **Accumulator caps:** the batched-scan rules that accumulate unbounded findings arrays (`canonical.non-200-target`/`non-indexable-target`, the pagination trio, `hreflang.missing-return-link`/`non-indexable-target`/`missing-x-default`, `redirect.chain`/`loop`) each get the `URL_FINDING_CAP` treatment — stop accumulating at the cap, count the remainder (exact where the scan completes → `noteTruncation`; lower-bound where it stops early → `noteAtLeastTruncation`), one shared doc sentence per file. Tests: one cap case per file (not per rule — the mechanism is shared per scan).
- **Truncated-key rename:** `redirects.ts` chain evidence `truncated` → `chainTruncated`; `robots.ts` raw-truncated boolean → `robotsTruncated`; harness/gate-doc references updated.
- **Comment sweep:** crawl-evidence gate-uniformity overclaim fixed; `resumeCrawl` documents the host-probe re-run/overwrite; `hostProbeStarts` moved out of the fetch-stack module graph (the pure function relocates to url-utils or a pure module) so rules stop value-importing the fetch stack.

- [ ] TDD per item → full suite green → commit `fix: phase 3 carried backlog — probe containment, finding caps, truncation renames`.

---

### Task 3: The metric runner + registry support

**Files:** Modify `src/rules/run.ts`, `src/rules/helpers.ts`, `src/rules/registry/registry.ts` (delete `METRIC_PENDING_CHECKS` only in Task 7); create nothing new. Tests: `test/rules/run.test.ts`.

**Interfaces:** `runRules` replaces the metric-kind guard with a metric phase AFTER query rules: for each `byKind("metric")` rule, `await rule.run(db, crawlId)` → upsert rows into `metrics` on the composite PK `(crawl_id, metric_id, scope, scope_value)` via `onConflictDoUpdate` (re-runs refresh values — metrics are recomputed state, unlike append-only issues; document the asymmetry). A throwing metric rule aborts loudly naming itself (established shape). `RunSummary` gains `metrics: number` and `byMetric: Record<string, number>`. `helpers.ts` gains `metricRow(self: {id: string}, m: { scope: "site" | "page_type"; scopeValue?: string; value: Record<string, unknown> }): Metric` — metricId single-sourced (the `queryFinding` precedent; destructure, don't spread). A stale-metric guard: before the metric phase, `DELETE FROM metrics WHERE crawl_id = $1 AND metric_id = ANY(<registered ids>)`? NO — upsert covers refresh; but a metric that STOPS emitting a cohort row would leave a stale row. Ruling: the runner deletes each metric rule's rows for the crawl before inserting its fresh set, inside the same transaction per rule — recomputed state must not go stale (document this as the metrics-vs-issues asymmetry).

- [ ] Failing tests (metric rows land + refresh + stale-cohort removal + throwing-rule abort + summary counts; the old guard test flips to asserting the phase runs) → implement → full suite green → commit `feat: metric runner phase — recomputed-state upsert with stale-row removal`.

---

### Task 4: Link-graph metrics (CHECK-33, 33b, 31)

**Files:** Create `src/rules/metric/link-metrics.ts`; copy entries; registration. Tests: `test/rules/link-metrics.test.ts` (DB).

| metric id | checkIds | scope rows | value shape |
|---|---|---|---|
| `inlinks.distribution` | CHECK-33 | site + one per page_type | `{count, min, p25, median, p75, p95, max, mean}` over per-page distinct-inlink counts (`links` grouped by target, joined to indexable 200 pages; pages with zero inlinks count as 0 — left join, the orphan lesson) |
| `inlinks.extremes` | CHECK-33 | site | `{bottom: [{url, inlinks}×20], top: [{url, inlinks}×20]}` (SQL LIMIT, ties broken by url) |
| `inlinks.sources-by-type` | CHECK-33b | one per (target page_type) | `{sources: {<source page_type>: count, …}}` — inlink counts grouped by the SOURCE page's type (join links.source_page_id → pages.page_type), capped at 25 distinct source types with an `other` bucket |
| `structure.depth-distribution` | CHECK-31 | site + one per page_type | same percentile shape over `pages.depth` (indexable 200 only) |

`percentile_cont` over a lateral/CTE; every number SQL-computed; `page_type` null cohorts roll into a `"(untyped)"` scope_value (documented — template detection can yield null).

- [ ] TDD (hand-computable 12-page synthetic crawl: assert exact percentiles/means; zero-inlink page counted; cohort rows per type; the 25-type cap) → implement + copy → full suite green → commit `feat: link-graph metrics — inlinks, sources, depth (P4-T1..T3)`.

---

### Task 5: Content + hreflang metrics (CHECK-38 evidence, CHECK-24)

**Files:** Create `src/rules/metric/content-metrics.ts`, `src/rules/metric/hreflang-metrics.ts`; copy; registration. Tests: DB per file.

| metric id | checkIds | scope rows | value shape |
|---|---|---|---|
| `content.metrics-by-type` | CHECK-38 | site + one per page_type | percentile shape over `word_count` AND over `text_ratio` (two nested objects: `{wordCount: {...}, textRatio: {...}}`), indexable 200 only |
| `content.template-similarity` | CHECK-38 | one per page_type (≥2 pages) | `{pairsSampled, meanHamming, p25, median, p75, share≤3, share≤8}` over intra-type simhash pair distances — SAMPLED: per type, the pairs among the first 200 pages by id (cap the quadratic honestly, state `pairsSampled` and the sampling rule in the value + copy). Labeled template similarity — the copy MUST NOT say "boilerplate" (negative copy guard). Uses the band indexes only if trivially applicable; a bounded sample join is acceptable — document the choice. |
| `hreflang.coverage` | CHECK-24 | site + one per page_type | `{pagesWithHreflang, indexablePages, coveragePct}` (pct rounded 1dp, computed in SQL) |

- [ ] TDD (exact hand-computed values; the boilerplate negative guard; sampling-cap case) → implement + copy → full suite green → commit `feat: content + hreflang metrics (P4-T4, T5 — CHECK-38 evidence, CHECK-24)`.

---

### Task 6: URL, redirect, sitemap metrics + CHECK-44 widening (CHECK-29, 10, 08)

**Files:** Create `src/rules/metric/url-metrics.ts`, `src/rules/metric/crawl-metrics.ts`; modify `src/rules/derive/field-presence.ts` (profile widening) + `src/rules/query/structured-data.ts` copy/tests; copy; registration. Tests: DB per file.

| metric id | checkIds | scope rows | value shape |
|---|---|---|---|
| `url.param-volumes` | CHECK-29, CHECK-27 | site | `{totalParams, trackingParams, topParams: [{name, occurrences, isTracking}×20], parameterisedIndexablePages, parameterisedPages}` from `url_params` + pages (the derivation already ran — document the ordering dependency; the runner's phase order guarantees it) |
| `redirect.volume` | CHECK-10 | site | `{redirectPages, totalPages, ratioPct, chains, loops}` — chains/loops counted from the issues table's own rows for this crawl (`rule_id in (redirect.chain, redirect.loop)`) — reading issues is reading the database; document that this couples metric to the query phase having run (runner order guarantees) |
| `sitemap.structure` | CHECK-08 | site + one per sitemap source doc | site: `{docs, totalUrls, oversizedDocsSkipped, urlCapBreaches}`; per-doc (scope_value = source url, cap 50 docs): `{urls, breaches50k: boolean}` — from `sitemap_urls` grouped by source + discovery truncation evidence |

**CHECK-44 widening:** `SCHEMA_PROFILES.Product.recommended` gains the checklist's remaining names (`priceCurrency`, `availability`, `gtin`, `mpn`, `color`, `material`, `size` — verify the exact list against `~/.claude/skills/sf-audit/checklist.md` CHECK-44 before committing, cite the lines); `offers` sub-check unchanged; derivation tests + `schema.product-incomplete` copy updated (the gate-doc disclosure paragraph gets superseded in Task 8's gate doc).

- [ ] TDD → implement + copy → full suite green → commit `feat: url/redirect/sitemap metrics + CHECK-44 profile widening (P4-T6, T7, CHECK-08)`.

---

### Task 7: Coverage completion + harness metric assertions

**Files:** Modify `src/rules/registry/registry.ts` (delete `METRIC_PENDING_CHECKS`; `RENDER_CHECKS` stays), `test/rules/coverage.test.ts`, `test/fixtures/harness.test.ts`; fixture additions only if a metric needs one (the site already exercises every metric — verify).

- Coverage: claimed literal gains 08/29/33/33b (41 claimed + 3 agent + 3 render = 47); the equality assertion now pins the unclaimed list === `RENDER_CHECKS` alone; ruleset pin updates (64 → 73 = 26 page + 38 query + 9 metric).
- Harness: after `runRules`, read the `metrics` table — assert the exact metric-id set present; for three hand-computable metrics on the fixture site (`inlinks.distribution` site row, `hreflang.coverage` site row, `sitemap.structure` site row) assert the EXACT value jsonb against hand-derived fixture-site numbers (the quotability gate made mechanical). Site changes since the fixtures are exact-pinned: recompute honestly, don't fudge.
- [ ] TDD (the strict flips are the red) → full suite green → commit `test: phase 4 coverage — metric checks claimed, pin at render-three; harness quotes metrics`.

---

### Task 8: 50k full-pipeline scale measurement + gate record

**Files:** Create `scripts/gate-rules.ts`, `docs/gates/phase-4.md`; reuse `test/gate/site-server.ts` (Phase 1's synthetic 50k site).

- `scripts/gate-rules.ts`: start the site server (50k pages), `runCrawl` (probeHosts on, the Phase 1 gate config + `maxPages` headroom precedent), then `runRules` end-to-end (derivations + 38 query + 9 metric rules), sampling RSS throughout; print: crawl wall/RSS (compare to Phase 1's 169.5MB), rules-phase wall total + per-phase (derivations/query/metric), peak RSS during rules, issues row count, metrics row count. Exit non-zero if peak RSS > 512MB (the standing contract) — rule wall time is RECORDED, not gated (first measurement sets the baseline; the banding/terminal-selection numbers from Phase 3's ledger get their mandated re-measure here at real scale).
- `docs/gates/phase-4.md`: date, commit, the recorded numbers (measured THIS run — the Phase 3 provenance lesson), the 41/3/3 coverage state, ruleset 73, the quotability assertions' status, CHECK-08/44 dispositions, superseded disclosures noted, CI link "pending the first pull request".
- [ ] Run for real → record → full suite + typecheck green → commit `test: phase 4 gate — full pipeline at 50k, metrics quotable, recorded`.

---

## Self-Review (performed at authoring time)

- **Spec coverage:** P4-T1→Task 4 (inlinks), P4-T2→Task 4 (depth), P4-T3→Task 4 (sources), P4-T4→Task 5 (content), P4-T5→Task 5 (hreflang), P4-T6→Task 6 (facet/param), P4-T7→Task 6 (redirect ratio); CHECK-08→Task 6; gate→Tasks 7-8. Backlog: seam→Task 1, sweep→Task 2, metric runner→Task 3, CHECK-44→Task 6, perf re-measure→Task 8.
- **Check arithmetic:** claims added 08/29/33/33b (29 gains the metric claim beside its AGENT half; 33b is its own id) → 37+4=41 claimed +3 agent +3 render = wait: 29 is in METRIC_PENDING and not in AGENT_CHECKS (AGENT = 38/41/42); 41+3+3=47 ✓. CHECK-10/24/27/31/38 metric rules re-claim already-claimed ids (fine, sets union).
- **Type consistency:** `metricRow`, the runner's metric phase + summary fields, the four new metric files' exported arrays (`linkMetrics`, `contentMetrics`, `hreflangMetrics`, `urlMetrics`, `crawlMetrics` — Task 7 registers whatever Task 4-6 export; each task's commit registers its own array immediately so the harness metric-set assertion in Task 7 sees them), the normalized column names — each defined in its producing task.
- **Deliberate at-execution blanks:** metric copy text; the harness's exact hand-computed metric values; the CHECK-44 exact list (verified against the checklist at execution); Task 8's measured numbers. All pin-from-reality per precedent.
- **Known risks named:** template-similarity sampling keeps the quadratic bounded (200/type) — stated in value+copy; redirect.volume couples to the query phase's issues rows (runner order guarantees, documented); metric upsert-with-delete needs per-rule transactionality (Task 3 owns it); the 50k rules run is the first at scale — wall time recorded not gated.

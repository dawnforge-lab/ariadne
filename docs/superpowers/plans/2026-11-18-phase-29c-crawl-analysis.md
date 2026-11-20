# Phase 29c — Crawl analysis: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every judged crawl carries per-page link counts and an internal link score. Agents
can list the anchors each page receives, and can diff two crawls of one site field by field.
All of it is computed in SQL and holds the memory contract at 50k pages.

**Architecture:**
- **Two new derivations.** `deriveLinkCounts` and `deriveLinkScore` run in the rules run's
  derive step, next to `deriveClickDepth`. They write five new nullable `pages` columns, so
  any crawl gains them on a rules re-run.
- **Link score.** A power-iteration PageRank over session-private temporary work tables,
  inside one transaction, with one set-based statement per iteration.
- **Rules and metric.** `links.high-outlinks` reads the new columns. One metric
  (`links.score-distribution`) and one rule (`links.anchors-generic-only`) are added.
- **Surfaces.** The new facts reach `pages_query`, the pages CSV and `crawl_overview`. A new
  listing, `anchors_by_target`, gets a CSV twin. Two diff tools, `crawl_diff` and
  `crawl_diff_urls`, join both crawls on `pages.url` in one repeatable-read snapshot.

**Tech Stack:** TypeScript strict ESM, Node 22, Postgres 16 + drizzle-kit, vitest. There are
no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md`, sections §29c
and Gates §29c. The owner approved it on 2026-11-13 and said "let's go" on 2026-11-18.

## Global Constraints

### Hard rules and process
- Hard rules 1–10 (CLAUDE.md) bind every task. In particular:
  - every link and graph computation is SQL, and `links` is never loaded into Node (rule 3);
  - RAM stays O(concurrency) (rule 6);
  - a failed derivation, or a null where a fact must exist, is a loud error (rule 7);
  - rules carry `checkIds` (rule 10).
- **Migrations.**
  - Generate them with `npx drizzle-kit generate`, or `npx drizzle-kit generate --custom
    --name <name>` for a data migration.
  - Apply them with `npm run db:migrate`. Never hand-apply SQL.
  - The next number is `0059`.
- **Version.** `RULESET_VERSION` goes from `0.27.0` to `0.28.0`, one bump for the phase.
  - Task 3 makes the bump and opens `// 0.28.0: Phase 29c, crawl analysis.` in the registry
    changelog comment.
  - Later tasks append to that entry.
- **Nulls.**
  - New `pages` columns are nullable. Null means the crawl was not judged since 29c, i.e.
    not measured.
  - A rule or surface that needs the fact refuses null loudly. It never reads null as zero.
- **No tool parameters for the derivations.** Damping and iterations are named constants, as
  the spec fixes them (§29c).

### Pinned values (from the spec)
- **Link score:**
  - damping `0.85`;
  - at most `20` iterations;
  - stop after the first iteration whose L1 change (Σ|new − old|) is below `1e-6`;
  - graph: internal, followed, deduplicated source→target edges between `FETCHED_OK` pages;
  - a page with no edges out shares its weight with every page in each iteration.
- **Link score 0–100:** `round(100 · ln(raw / min) / ln(max / min))` over the crawl's graph
  pages, so 100 is the crawl's top page. When `max = min`, every page scores 100.
- **Generic anchors:** threshold `GENERIC_ANCHOR_MIN_INLINKS`, default `3`, range 1–1000,
  overridable per crawl.
- **Diff defaults, as request parameters:**

  | Parameter | Default | Range |
  |---|---|---|
  | `wordCountChangePct` | 20 | 1–1000 |
  | `inlinksChangePct` | 50 | 1–1000 |
  | `inlinksChangeMin` | 5 | 1–100000 |
  | `linkScoreChangePoints` | 10 | 1–100 |

  All are integers, echoed in every answer.
- **Gates:**
  - the derive step (both link derivations) takes ≤ 60 s at 50k;
  - the diff's first page answers in ≤ 5 s;
  - the local memory bound is 306.4 MB, and the 512 MB contract;
  - PageRank matches the hand-computed values within 1e-6.

### Standards, not Google (owner policy, 2026-11-16)
- Copy, evidence and docs name no Google product or policy.
- The score is called "link score" and described as "the share of internal link weight a
  page holds (random-surfer model, damping 0.85)".
- "PageRank" may appear in code comments only, as the algorithm's name.

### Ariadne reports facts
- The link score and link counts are evidence. No rule judges a low score.
- The diff is evidence for the agent and the report. It claims no checklist id.

### Surface discipline
- **New tools and routes.**
  - Enrol each in `TOOL_NAMES`, `SCOPED_TOOLS`/`SCOPED_ROUTES` (`test/api/tenant-isolation.test.ts`).
  - Update the mcp.test.ts "advertises exactly the … tools" list and its count words. That
    covers the `mcp.ts` header and `INSTRUCTIONS`: thirty-five becomes thirty-eight by
    Task 8.
  - Add each paginated tool to the `nextCursor` description condition.
- **A new CSV view** gets its own tenancy `describe`, as `structured_data_nodes` did.
- **Citations.** `docs/talos-surface.md` cites tests as `file:line` plus a quoted title
  fragment, and `test/skills/identifier-guard.test.ts` checks them.
  - Prefer new test files.
  - Any task that inserts lines above a cited test fixes the citations in the same commit.
  - Every task ends with `npx vitest run test/skills/identifier-guard.test.ts` green.
- **Surface docs** (`docs/talos-surface.md`, `docs/talos-integration.md`) change in the same
  task as the surface.
- **Commits.** Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
  ```
- **Databases.** Tests run on the dev DB `ariadne`. Gate runs happen only on a gate DB
  (`ariadne_gate29c`), which the controller creates with the owner's OK.

## Review Focus

1. **A crawl judged before 29c.** Its five columns are null.
   - A rules re-run must fill them.
   - Until then, `anchors_by_target` refuses with CONFLICT.
   - `crawl_diff` reports the link fields as *not comparable*, never *unchanged*.
   - `links.high-outlinks` never runs on null, because the derivation runs first in the
     same run. If it ever does, it throws.
   - Pinned in Tasks 1, 3, 6 and 7.
2. **Degenerate graphs.** These must not produce NaN, Infinity, `ln(0)` or division by zero:
   - no `FETCHED_OK` page;
   - one page;
   - every page with no edges out;
   - two disconnected components;
   - every page with an equal raw score.

   Pinned in Task 2.
3. **URL variants across crawls.** `/Page` and `/page`, or `/a` and `/a/`, are distinct
   `pages.url` values. The diff must pair each with itself and never report one as removed
   and the other as added because they share `url_normalised`. Pinned in Task 7.
4. **A rules run in flight during a diff.**
   - `runRules` clears `rules_run_at` in its first transaction, so a diff called mid-run
     must be refused as "never been judged" (the `comparePair` refusal).
   - It must not answer from half-written columns.
   - Pinned in Task 7.
5. **Anchor text that looks generic only after normalising.** Examples are `"  Click
   HERE "`, a non-breaking space, an anchor of only whitespace, and a null anchor.
   - These must classify exactly as `links.non-descriptive-anchor` and `links.no-anchor-text`
     normalise them, through the shared `NORMALISED_ANCHOR` SQL.
   - They must never use a second, drifting copy of that SQL.
   - Pinned in Task 4.

## Rulings made while planning (the spec is silent or would conflict)

- **R1. `inlinks_internal` is the definition `inlinks.distribution` already uses:** distinct
  `links.source_page_id` with `links.target_url = pages.url` and `source_page_id <> pages.id`.
  - Nofollow links count.
  - It is set on every `pages` row (0 when none), including non-OK targets, because a 404
    with inlinks is a fact worth listing.
  - Task 1 pins parity with `inlinkCohort` (`src/rules/metric/link-metrics.ts`).
- **R2. The outlink counts are exactly today's `links.high-outlinks` count.**
  - `outlinks_internal` and `outlinks_external` are `count(distinct target_url)` filtered by
    `is_internal`, self-links and nofollow included. So the rule's findings cannot change.
  - They are set on `FETCHED_OK` rows (0 when none) and stay null on every other row. Only
    analysed pages have outlinks.
- **R3. Link-score edges.**
  - Link-level `is_nofollow` excludes an edge.
  - Page-level `<meta name=robots content=nofollow>` does not, yet. That is an open item for
    the gate record, not a silent choice.
  - Self-loops are dropped.
  - Edges to a redirecting URL are dropped, because the target is not `FETCHED_OK`, as the
    spec's "between fetched-OK HTML pages" says.
  - Out-degree counts kept edges only.
- **R4. "Batched" means set-based.**
  - The work tables are `create temporary table … on commit drop` inside the derivation's
    one transaction: session-private, unlogged, and dropped even on failure.
  - Each iteration is one `insert … select` over the edge table. No per-row round trip
    reaches Node.
  - This replaces the spec's "unlogged per-run work table, batched". A temp table is
    unlogged by construction and needs no cleanup path. Recorded for the owner in the gate
    record.
- **R5. `link_score` is an `integer` 0–100,** and `link_score_raw` is `double precision`.
  - Both are null on rows outside the graph (non-OK).
  - In a judged crawl, a non-null `inlinks_internal` beside a null score means "not in the
    graph". That is a value, not a missing fact.
- **R6. `anchors_by_target`.**
  - **Rows.** One row per `pages` row with `inlinks_internal ≥ 1`, any fetch class, ordered
    by `url` and keyset-paged like every other listing.
  - **Anchors** are grouped by `NORMALISED_ANCHOR` (lower-cased, whitespace-collapsed,
    trimmed).
  - **Empty** means a normalised anchor that is `''` or null. An `aria-label` does not make
    an anchor non-empty here: this listing is about link *text*.
  - **`topAnchors`** are the 5 most frequent non-empty anchors, ties broken by text
    ascending.
  - **`genericShare`** is (empty + non-descriptive) ÷ inlinks, rounded to 4 places.
  - **Refusals.** It refuses with CONFLICT when the crawl is unjudged, or when any page's
    `inlinks_internal` is null (judged before 29c).
- **R7. `links.anchors-generic-only`.**
  - It fires on an indexable `FETCHED_OK` page with `inlinks_internal ≥
    GENERIC_ANCHOR_MIN_INLINKS`, where every inlink's anchor is empty or in
    `NON_DESCRIPTIVE_ANCHORS`.
  - Kind `query`, severity `info`, `checkIds: ["CHECK-86"]`, category `links`.
- **R8. `links.score-distribution`** uses the shared metric cohort (`cohortFilter`) and
  `DISTRIBUTION_COLUMNS`, scoped by site and by `page_type`, like `inlinks.distribution`.
  - It claims `CHECK-33`.
  - A cohort page with a null `link_score` is a thrown error (a `FETCHED_OK` page is always
    in the graph).
- **R9. The diff requires both crawls judged.** It reuses `comparePair`, including its
  "never been judged" refusal.
  - So `click_depth` null on a judged crawl means unreachable, a comparable value.
    `click_depth` exists since ruleset 0.7.0.
- **R10. Diff comparability.** A page pair is not comparable for a field when:
  - **Content fields** (title, meta description, H1, canonical, meta robots, word count,
    schema types): either side is not `fetch_class = 'ok'`. Nothing was parsed, and the
    status and fetch-class fields already report the change.
  - **Meta robots:** either side has `extraction_version < 2` or null. `robots_meta` changed
    meaning at extraction 2 (`src/crawl/versions.ts`).
  - **Schema types:** either side has `extraction_version < 4` or null. Microdata and RDFa
    joined at 4.
  - **Inlinks and link score:** either side's `inlinks_internal` is null (judged before 29c).
- **R11. Diff field definitions.**
  - **Exact fields** use `is distinct from`: status, fetch class, indexable, title, meta
    description, H1, meta robots, click depth.
  - **Canonical** is the pair (`canonical_html`, `canonical_header`), changed if either part
    is distinct.
  - **Schema types** is the sorted distinct `structured_data.schema_type` set per page.
  - **Word count** changed: `|h − b| · 100 > wordCountChangePct · b`.
  - **Inlinks** changed: `|h − b| ≥ inlinksChangeMin and |h − b| · 100 > inlinksChangePct · b`.
  - **Link score** changed: scored on one side only, or `|h − b| ≥ linkScoreChangePoints`.
  - **Added** means a URL only in head, **removed** a URL only in base.
- **R12. Planting the gate site** is opt-in by `GATE_PLANT=1`. A planted run is never the
  gate (`isGate` false). Indices, at 50k:
  - **titles:** `i % 500 === 250`, giving 100 pages. Only `<title>` changes, to
    `Retitled <original>`. Anchors and H1 stay as they are.
  - **statuses:** `i % 1000 === 500`, giving 50 pages that answer `410`.
  - **removed:** `i % 2000 === 1000`, giving 25 pages. No page links to them, no sitemap
    lists them, and the server answers 404.

## Owner amendments (2026-11-18)

The owner amended two rulings after this plan was written; the original lines above are unchanged.
- R3's open item (page-level nofollow) is closed: a page whose `robots_meta` or `x_robots_tag` says
  `nofollow` or `none` passes no link score (its outgoing edges are dropped; link counts are unchanged).
- R5 / Global Constraints' "max = min" is "equal within tolerance": every page scores 100 when
  `max - min <= 1e-9 * max` (`LINK_SCORE_EQUAL_TOLERANCE`).

## File map

| File | Responsibility |
|---|---|
| `src/rules/derive/link-counts.ts` (new) | `deriveLinkCounts`: the three counts |
| `src/rules/derive/link-score.ts` (new) | `deriveLinkScore`: PageRank and the 0–100 scale |
| `src/rules/run.ts` | registers both derivations; `RunSummary.derivedMs` |
| `src/db/schema.ts`, `drizzle/0059_*`, `drizzle/0060_generic_anchor_threshold.sql` | columns; threshold stamp rewrite |
| `src/rules/query/link-hygiene.ts` | `links.high-outlinks` reads columns; `links.anchors-generic-only` |
| `src/rules/metric/link-metrics.ts` | `links.score-distribution` |
| `src/rules/thresholds.ts`, `src/rules/threshold-table.ts` | `GENERIC_ANCHOR_MIN_INLINKS` |
| `src/api/service.ts`, `src/api/overview.ts`, `src/api/csv.ts` | page fields, overview section, CSV views, the new listings |
| `src/api/anchors.ts` (new) | anchors-by-target SQL and row shaping, shared by the tool and the CSV view |
| `src/api/crawl-diff.ts` (new) | `DIFF_FIELDS`: per-field comparable/changed/before/after SQL, threshold parsing |
| `src/api/mcp.ts`, `src/api/http.ts` | three tools, three routes |
| `test/gate/site-server.ts`, `scripts/gate-rules.ts`, `scripts/gate-diff.ts` (new), `scripts/gate-schedules.ts` | gate tooling |
| `docs/talos-surface.md`, `docs/talos-integration.md`, `skills/ariadne-audit/checklist.md` | docs |

---

### Task 1: Link-count columns and `deriveLinkCounts`

**Files:**
- Create: `src/rules/derive/link-counts.ts`
- Modify:
  - `src/db/schema.ts`. Add `inlinksInternal: integer("inlinks_internal")`,
    `outlinksInternal: integer("outlinks_internal")`,
    `outlinksExternal: integer("outlinks_external")`,
    `linkScoreRaw: doublePrecision("link_score_raw")` and
    `linkScore: integer("link_score")` beside `click_depth`. Each gets a comment on what
    null means (R1, R2, R5).
  - `drizzle/0059_*` (generated).
  - `src/rules/run.ts`:
    - append `deriveLinkCounts` to `derivations` after `deriveClickDepth`;
    - add `derivedMs: Record<string, number>` to `RunSummary`, the wall time of each
      derivation by function name, measured with `performance.now()`;
    - check every reader of `RunSummary` (events, the API) and either pass the field through
      or pin that it is internal.
- Test: `test/rules/derive-link-counts.test.ts` (new; builders copied from
  `test/rules/derive-click-depth.test.ts`)

**Interfaces:**
- Produces:
  - `deriveLinkCounts(db: Db, crawlId: string): Promise<LinkCountsDerivation>`, where
    `LinkCountsDerivation extends Record<string, number>` is `{pages, withInlinks,
    analysed}`;
  - the three count columns;
  - `summary.derived["deriveLinkCounts.*"]` and `summary.derivedMs.deriveLinkCounts`.

- [ ] **Step 1: Write the failing tests.**
  - **The fixture graph** has five pages:
    - home `/`, `/a`, `/b`, all OK;
    - `/gone`, a 404;
    - `/r`, a redirect.

    And these links:
    - `/`→`/a` twice (duplicate rows);
    - `/`→`/b` with nofollow;
    - `/a`→`/a` (self);
    - `/a`→`/gone`;
    - `/b`→`https://ext.example/`, external;
    - `/b`→`https://ext.example/` again;
    - `/b`→`/never-crawled`.
  - **Expected `inlinks_internal`:**
    - `/` 0, `/a` 1, `/b` 1;
    - `/gone` 1 (a non-OK row still counts);
    - `/r` 0.
  - **Expected outlinks:**
    - `/` internal 2, external 0;
    - `/a` internal 2 (self and `/gone` both count, R2), external 0;
    - `/b` internal 1 (`/never-crawled`), external 1.
    - `/gone` and `/r` stay null for both.
  - **Parity.** On the same crawl, every cohort page's `inlinks_internal` equals the `v`
    from `inlinkCohort`. Export it for the test if it is private, or assert against
    `inlinks.distribution`'s stored max and min.
  - **Re-run.** Set a page's columns to 99, re-derive, and the true values come back. A
    crawl with no links gives all 0 / null by R2.
  - **Errors.** An unknown crawl id throws `no such crawl`.
  - **Through `runRules`.** `summary.derived["deriveLinkCounts.pages"] === 5` and
    `summary.derivedMs.deriveLinkCounts >= 0`.
- [ ] **Step 2:** `npx vitest run test/rules/derive-link-counts.test.ts`. Expect a FAIL
  (module missing).
- [ ] **Step 3: Implement.**
  - Run `npx drizzle-kit generate`, then `npm run db:migrate`.
  - `deriveLinkCounts` runs in one `db.transaction`:
    1. a null-reset of all three columns for the crawl;
    2. one `update … from (aggregate)` for inlinks, with every row set to 0 first or by
       coalesce;
    3. one for outlinks over `FETCHED_OK` sources.
  - Use `FETCHED_OK` from `src/rules/helpers.ts`. Write no per-page parameters.
- [ ] **Step 4:** Run the new test and `test/rules/derive-click-depth.test.ts`. Expect a
  PASS. Then `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(rules): per-page link counts in the derive step (29c)`.

### Task 2: `deriveLinkScore` (internal link score)

**Files:**
- Create: `src/rules/derive/link-score.ts`
- Modify: `src/rules/run.ts` (append `deriveLinkScore` after `deriveLinkCounts`)
- Test: `test/rules/derive-link-score.test.ts` (new)

**Interfaces:**
- Consumes: `pages.link_score_raw`, `pages.link_score` (Task 1's migration).
- Produces:
  - `deriveLinkScore(db: Db, crawlId: string): Promise<LinkScoreDerivation>`, which is
    `{nodes, edges, dangling, iterations, converged}` (converged is 1 or 0);
  - the exported constants `LINK_SCORE_DAMPING = 0.85`, `LINK_SCORE_MAX_ITERATIONS = 20` and
    `LINK_SCORE_TOLERANCE = 1e-6`.

**Algorithm** (spec pins the numbers; R3, R4 and R5 pin the rest). All of it runs inside one
`db.transaction`:
1. **Null-reset** both columns for the crawl.
2. **Nodes.** `create temporary table ls_nodes (n int primary key, page_id text not null,
   outdeg int not null default 0) on commit drop`. Fill it from `pages` where `FETCHED_OK`,
   with `n = row_number() over (order by url)`. N is the row count. If N is 0, return all
   zeros.
3. **Edges.** `ls_edges (src int, dst int)`: the distinct `(src, dst)` over `links l` where
   `l.is_internal and not l.is_nofollow`.
   - Join the source node on `l.source_page_id`.
   - Join `pages t` on `t.crawl_id` and `t.url = l.target_url`, then the destination node on
     `t.id`.
   - Keep only `src <> dst`.
   - Set `outdeg`, then `analyze` both temp tables.
4. **Rank.** `ls_rank (n int primary key, v double precision)` starts at `1/N`.
5. **Iterate**, at most 20 times. Each iteration:
   - `dangling = Σ v where outdeg = 0`;
   - build `ls_next`, where `v' = (1−d)/N + d·dangling/N + d·Σ_{(s→p)} v_s/outdeg_s`;
   - read `delta = Σ|v' − v|`, then swap (truncate and refill, or alternate two tables);
   - stop after the iteration in which `delta < 1e-6`.
6. **Write back** in one `update pages … from ls_rank join ls_nodes`:
   - `link_score_raw = v`;
   - `link_score = case when max = min then 100 else round(100 * ln(v/min) / ln(max/min))
     end`.

- [ ] **Step 1: Write the failing tests.**
  - **The hand-computed graph.** Five `FETCHED_OK` pages A–E. After filtering, the edges
    are:
    - A→B, A→C, A→D;
    - B→C;
    - C→A;
    - E→C;
    - D has none.

    Add noise that the filter must drop:
    - a duplicate A→B row;
    - B→B (self);
    - A→F, where F is a 404;
    - E→A with nofollow (if kept, E's out-degree would become 2);
    - D→`https://ext.example/` (external);
    - C→R, where R is a redirect.

    F and R are not nodes. A separate test adds G, an OK page with no links in or out, as a
    sixth node.
  - **Expected `link_score_raw`**, the exact solution of the linear system, within `1e-6`:

    | Page | Exact | Decimal |
    |---|---|---|
    | A | 79080/241193 | 0.3278702118 |
    | B | 35713/241193 | 0.1480681446 |
    | C | 77380/241193 | 0.3208219144 |
    | D | 35713/241193 | 0.1480681446 |
    | E | 13307/241193 | 0.0551715846 |

    Also: Σ raw = 1 within 1e-9; `derived.iterations === 18`; `derived.converged === 1`.
  - **Expected `link_score`:** A 100, B 55, C 99, D 55, E 0. F and R are null.
  - **Degenerate cases.** For each of the following, the test asserts no NaN and that
    `iterations ≤ 20`:
    - no OK page: `nodes 0`, nothing written;
    - one page: raw 1, score 100;
    - all pages with no edges out (three pages, no links): raw 1/3 each, every score 100,
      converged at iteration 1;
    - two disconnected 2-cycles: equal raws, every score 100;
    - the graph with G added: it sums to 1, and E and G both score 0.
  - **Re-run.** Overwrite the scores with junk, re-derive, and the values come back
    identical.
- [ ] **Step 2:** Run. Expect a FAIL.
- [ ] **Step 3: Implement** to the algorithm above. The loop's statement count is bounded:
  it does not grow with N.
- [ ] **Step 4:** Run the test, then `npm test` and `npx tsc --noEmit`. Expect a PASS.
- [ ] **Step 5:** Commit `feat(rules): internal link score computed in SQL (29c)`.

### Task 3: `links.high-outlinks` reads the columns; `links.score-distribution`; 0.28.0

**Files:**
- Modify:
  - `src/rules/query/link-hygiene.ts` (`highOutlinkFindings`);
  - `src/rules/metric/link-metrics.ts` (add `links.score-distribution` to `linkMetrics`);
  - `src/rules/registry/registry.ts` (`RULESET_VERSION = "0.28.0"`, open
    `// 0.28.0: Phase 29c, crawl analysis.`, rule count line);
  - `src/rules/registry/copy/issue-copy.ts`;
  - `src/rules/registry/triage.ts`;
  - `test/rules/registry.test.ts` (version pin; counts 227 → 228, i.e. 72 page / 139 query /
    17 metric);
  - `test/rules/coverage.test.ts` (CHECK-33 claimant list).
- Test:
  - `test/rules/link-hygiene-query.test.ts` (append inside `describe("links.high-outlinks")`,
    at its end);
  - `test/rules/link-metrics.test.ts` (append).

**Interfaces:**
- Consumes: Task 1's columns and Task 2's `link_score`.
- Produces:
  - metric `links.score-distribution`, `checkIds: ["CHECK-33"]`, category `links`, rows
    `{scope:"site"}` and `{scope:"page_type", scopeValue}`, value `{count, min, p25, median,
    p75, p95, max, mean}` of `link_score`;
  - the copy names it "Link score distribution" and uses the R-copy wording from Global
    Constraints.

- [ ] **Step 1: Write the failing tests.**
  - **`links.high-outlinks` equivalence.** Every existing high-outlinks test still passes
    unchanged, once its setup runs the derivation (through `runRules`, or by calling
    `deriveLinkCounts` before the rule).
  - **A new high-outlinks test.** A `FETCHED_OK` page whose `outlinks_internal` is null when
    the rule runs makes the rule throw, with a message naming the derivation.
  - **The new metric.** Over a crawl with two templates:
    - the site row and both template rows carry the eight numbers of `link_score`;
    - a cohort page with null `link_score` makes the metric throw.
  - **Registry.** The version is `0.28.0` and the counts are as above.
- [ ] **Step 2:** Run. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - **The rule.** Its `select` reads `p.outlinks_internal` and `p.outlinks_external`; there
    is no `links` join, and the `having` becomes a `where`. Its evidence and limits are
    unchanged. A guard query (`… and p.outlinks_internal is null limit 1`) throws first.
  - **The metric** follows `inlinks.distribution`.
- [ ] **Step 4:** `npm test` (registry, copy, triage, coverage, threshold-guard,
  identifier-guard) and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(rules): high-outlinks reads the derived counts;
  links.score-distribution metric (29c, CHECK-33)`.

### Task 4: `GENERIC_ANCHOR_MIN_INLINKS` and `links.anchors-generic-only`

**Files:**
- Modify:
  - `src/rules/thresholds.ts` (`export const GENERIC_ANCHOR_MIN_INLINKS = 3`);
  - `src/rules/threshold-table.ts` (`GENERIC_ANCHOR_MIN_INLINKS: { min: 1, max: 1000,
    default: GENERIC_ANCHOR_MIN_INLINKS }`);
  - `src/rules/query/link-hygiene.ts` (new rule; export `NORMALISED_ANCHOR` if Task 6 needs
    it);
  - copy, triage, the registry changelog item, and counts (229: 72 / 140 / 17);
  - `skills/ariadne-audit/checklist.md`:
    - **CHECK-86:** the new rule, plus the `anchors_by_target` listing (named now; Task 6
      ships it);
    - **CHECK-33:** link counts, link score and `links.score-distribution`.
  - `test/fixtures/pages/authored-p29c.ts` (new) and `test/fixtures/fixture.ts`
    (`allFixtures()`).
  - Every other threshold pin test (`threshold-table.test.ts`, `thresholds-override.test.ts`).
- Create: `drizzle/0060_generic_anchor_threshold.sql`, via `npx drizzle-kit generate --custom
  --name generic_anchor_threshold`. It is modelled on `0058_image_oversize_threshold.sql`:
  `jsonb_set(…, '{thresholds}', '{"GENERIC_ANCHOR_MIN_INLINKS": 3}'::jsonb || …)` over every
  stored stamp.
- Test: `test/rules/anchors-generic-only.test.ts` (new)

**Interfaces:**
- Produces:
  - rule `links.anchors-generic-only`, with evidence `{inlinks, minInlinks, anchors:
    string[]}`. The anchors are distinct normalised values, up to the existing
    `SAMPLE_SOURCES` cap, with `""` for empty.
  - The copy says link *text* is judged and an aria-label is not read here. It points at
    `links.no-anchor-text` and `links.aria-label-only` for naming.

- [ ] **Step 1: Write the failing tests.**
  - **Fires once:** a page with 3 inlinks whose anchors are `"  Click HERE "`,
    `"read more"` and `""`.
  - **Does not fire** on:
    - the same page with 2 inlinks;
    - 3 inlinks where one anchor is `"Blue widgets"`;
    - a non-indexable page;
    - a 404 target.
  - **Override.** With the override `GENERIC_ANCHOR_MIN_INLINKS = 2`, the 2-inlink page fires.
  - **The null guard** throws, as in Task 3.
  - **Migration.** After `npm run db:migrate`, a stamp written before 0060 reads back with
    `GENERIC_ANCHOR_MIN_INLINKS: 3` (`readStamp`).
  - **Fixture.** `authored-p29c.ts` adds `/p29c/generic-target` (`exact: true`, expected
    `["links.anchors-generic-only"]`) and three hub pages that link to it only with "click
    here", "read more" and "here".
- [ ] **Step 2:** Run. Expect a FAIL.
- [ ] **Step 3: Implement.** The rule SQL uses the same `NORMALISED_ANCHOR` and
  `anchorList()` the non-descriptive rule uses. `null` and `''` count as empty.
- [ ] **Step 4:** Run `npx vitest run test/fixtures/harness.test.ts`.
  - Any existing `exact: true` page that now fires the rule is a true fact about that page.
    Add it to that page's expectations, with a one-line reason in the commit message.
  - Never narrow the rule to silence it.
  - Then run `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(rules): links.anchors-generic-only with an overridable minimum
  (29c, CHECK-86)`.

### Task 5: Link facts on `pages_query`, the pages CSV and `crawl_overview`

**Files:**
- Modify:
  - `src/api/service.ts`: `PAGE_FIELDS` gains `inlinksInternal`, `outlinksInternal`,
    `outlinksExternal` and `linkScore`; the `PageRow` interface follows. The raw score is
    not published (slim listing).
  - `src/api/mcp.ts` (`pages_query` description names the four fields);
  - `src/api/csv.ts`:
    - `internal_urls` header gains `inlinks, outlinksInternal, outlinksExternal, linkScore`
      after `clickDepth`;
    - its select and cells follow.
  - `src/api/overview.ts`. New section `link-counts`, judged crawls only, placed after
    `click-depth`.
    - **Entries**, over `FETCHED_OK` pages: `inlinks p50`, `inlinks p90`, `inlinks max`,
      `outlinks (internal) p50|p90|max`, `outlinks (external) p50|p90|max`. Percent is null
      and percentiles are `percentile_disc`, so they stay integers.
    - **Not measured.** When the crawl is judged but any `FETCHED_OK` page has null
      `inlinks_internal`, the section is omitted and `notMeasured` gains `{id:
      "link-counts", reason}`. The reason is a new `NOT_MEASURED_REASONS` entry: "judged
      before link counts existed; re-run the rules".
  - `test/api/surface-unchanged.test.ts`, `test/skills/identifier-guard.test.ts` inputs;
  - `docs/talos-surface.md`: §4.6 field list; §4.3b the new section; §12 the CSV header.
- Test: `test/api/link-facts.test.ts` (new), plus appended cases in
  `test/api/crawl-overview.test.ts` at its end.

- [ ] **Step 1: Write the failing tests.**
  - **Listing.** `pages_query`, the route and the JSONL export carry the four fields with
    the derived values.
  - **CSV.** The `internal_urls` CSV header and a row read correctly.
  - **Overview.** `crawl_overview` on a judged crawl has `link-counts` with the exact p50,
    p90 and max of a 10-page fixture.
  - **Overview, judged before 29c** (columns nulled by hand in the test): the section is
    absent and `notMeasured` names `link-counts`.
  - **Transport parity.** Route equals tool (append to the parity pairs if `pages_query` is
    not already there).
- [ ] **Step 2:** Run. Expect a FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test` (mcp.test.ts "names every field", csv.test.ts, the byte-parity
  CSV tests, identifier-guard) and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(api): link counts and link score on pages, the pages CSV and
  the crawl overview (29c)`.

### Task 6: `anchors_by_target` listing and CSV view

**Files:**
- Create: `src/api/anchors.ts`. It exports:
  - `anchorsByTargetSql(crawlId, cursor, limit, pageType?)`;
  - `AnchorsByTargetRow`;
  - `ANCHORS_TOP_N = 5`.
- Modify:
  - `src/api/service.ts`: `listAnchorsByTarget(tenant, crawlId, opts: {pageType?, limit?,
    cursor?}): Promise<Page<AnchorsByTargetRow>>` in a repeatable-read, read-only
    transaction.
  - `src/api/mcp.ts`: tool `anchors_by_target`, with `{crawlId, pageType?, limit?,
    cursor?}`.
  - `src/api/http.ts`: `GET /crawls/:id/anchors-by-target`, plus the route-table header
    comment.
  - `src/api/csv.ts`: view `anchors_by_target` with keyset `["url"]`. Header: `url,
    pageType, inlinks, distinctAnchors, emptyAnchors, nonDescriptiveAnchors, genericShare,
    topAnchors`. `topAnchors` is rendered as `text (n); text (n)`. Counts become 13 views
    and 10 keyset views.
  - The `export_crawl` description.
  - `test/api/tenant-isolation.test.ts` (route, tool, and a CSV-view describe).
  - `test/api/mcp.test.ts` (tool list and count; the `nextCursor` condition).
  - `docs/talos-surface.md` (new §4.6b; §12; the "How this document was produced" note);
  - `docs/talos-integration.md` (Cross-references: 29c).
- Test: `test/api/anchors-by-target.test.ts` (new)

**Interfaces:**
- `AnchorsByTargetRow` is `{url, pageType, inlinks, distinctAnchors, topAnchors: {text,
  count}[], emptyAnchors, nonDescriptiveAnchors, genericShare}` (R6).
- Refusals:
  - unknown or foreign crawl → NOT_FOUND;
  - unjudged, or judged before 29c → CONFLICT, "re-run the rules".

- [ ] **Step 1: Write the failing tests.**
  - **The fixture.** A target with 7 inlinks whose anchors are:
    - "Blue widgets" ×3;
    - "blue  WIDGETS" ×1;
    - "Red" ×1;
    - "click here" ×1;
    - "" ×1.
  - **Its expected row:**
    - `inlinks 7`, `distinctAnchors 4`;
    - `topAnchors [{blue widgets,4},{click here,1},{red,1}]`;
    - `emptyAnchors 1`, `nonDescriptiveAnchors 1`, `genericShare 0.2857`.
  - **Listing behaviour:**
    - a page with 0 inlinks is not listed;
    - paging by cursor returns every row exactly once;
    - the `pageType` filter works, `(untyped)` included.
  - **The CSV view** gives the same rows.
  - **Refusals:** the CONFLICT and NOT_FOUND cases above.
  - **Tenancy:** a `beta` tenant asking about `acme`'s crawl answers exactly like a
    nonexistent crawl.
- [ ] **Step 2:** Run. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - A single SQL statement with a lateral aggregate per target page over
    `links_crawl_target_url`.
  - Self-links are excluded, matching R1, so `inlinks` equals `inlinks_internal`. Pin that in
    the test.
- [ ] **Step 4:** `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(api): anchors_by_target listing and CSV view (29c, CHECK-86)`.

### Task 7: `crawl_diff` summary

**Files:**
- Create: `src/api/crawl-diff.ts`. It exports:
  - `DIFF_FIELDS`, an ordered array of `DiffField`. Each entry has `name`,
    `comparable(b, h): SQL`, `changed(b, h, t): SQL`, `before(b): SQL` and `after(h): SQL`,
    over the aliases `b` and `h` of `pages`, plus the schema-type set expressions.
  - `DIFF_FIELD_NAMES`: `status`, `fetchClass`, `indexable`, `title`, `metaDescription`,
    `h1`, `canonical`, `metaRobots`, `wordCount`, `schemaTypes`, `inlinks`, `clickDepth`,
    `linkScore`.
  - `DiffThresholds` and `parseDiffThresholds(raw): DiffThresholds`, with the defaults and
    ranges from Global Constraints. A value out of range or not an integer is a VALIDATION
    error that names it.
- Modify:
  - `src/api/service.ts`: `crawlDiff(tenant, baseCrawlId, headCrawlId, thresholds?):
    Promise<CrawlDiff>`. It runs in one repeatable-read, read-only transaction and calls
    `comparePair(tx, …)` first, so the refusals are identical to `crawl_compare`'s.
  - `src/api/mcp.ts`: tool `crawl_diff`, with `{baseCrawlId, headCrawlId,
    wordCountChangePct?, inlinksChangePct?, inlinksChangeMin?, linkScoreChangePoints?}`.
  - `src/api/http.ts`: `GET /diff`, with the same query names.
  - The tenant-isolation two-crawl builders, the mcp tool list and count.
  - `docs/talos-surface.md` (§7: a new 7.6 "Field diff"), `docs/talos-integration.md`.
- Test: `test/api/crawl-diff.test.ts` (new)

**Interfaces:**
- `CrawlDiff` has these fields:
  - `base` and `head`, each `{crawlId, siteUrl, rulesRunAt, pages}`;
  - `thresholds: DiffThresholds`;
  - `urls: {common, added, removed}`;
  - `fields: {field, changed, notComparable}[]`, in `DIFF_FIELD_NAMES` order.
- Task 8 consumes `DIFF_FIELDS`, `parseDiffThresholds` and the join SQL. Export the join as
  `diffJoinSql(baseId, headId)`: a `full join` of the two crawls' pages on `url`, plus each
  side's schema-type set as a lateral aggregate.

- [ ] **Step 1: Write the failing tests.** Build two judged crawls of one site by hand.
  - Set `rules_run_at` on both.
  - Write the stored facts directly: the link columns, `click_depth`, `extraction_version`,
    and the `structured_data` rows.
  - The diff reads stored facts only, so every field gets a known changed count and a known
    not-comparable count.
  - **Exact counts:**
    - one URL added, one removed;
    - status 200→410;
    - a title change;
    - a meta description, H1 and canonical-header change on one page each;
    - meta robots changed on a page whose base row is extraction 1, so it is not
      comparable;
    - word count 100→119 (unchanged at 20%) and 100→121 (changed);
    - schema types `[Product]`→`[Product, Offer]`;
    - inlinks 10→16 (changed: Δ 6 ≥ 5 and 60% > 50%) and 2→5 (unchanged: Δ 3 < 5);
    - click depth 2→null (unreachable, changed);
    - link score 40→49 (unchanged), 40→50 (changed), and a 404→200 page newly scored
      (changed).
  - **Thresholds.** With `wordCountChangePct: 10`, 100→119 counts. `wordCountChangePct: 0`
    and `"abc"` are VALIDATION.
  - **Review Focus 1.** A base crawl judged before 29c (null link columns): `inlinks` and
    `linkScore` are `changed 0, notComparable = common`.
  - **Review Focus 3.** `/Page` and `/page` both present in both crawls: added 0, removed 0.
  - **Review Focus 4.** With head's `rules_run_at` null, the call is refused "never been
    judged".
  - **Pairing and tenancy:**
    - two different sites → VALIDATION;
    - the same id twice → VALIDATION;
    - a foreign tenant → NOT_FOUND, like a nonexistent crawl.
  - **Transports.** Route equals tool.
- [ ] **Step 2:** Run. Expect a FAIL.
- [ ] **Step 3: Implement.** The summary is one SQL statement, with `count(*) filter
  (where …)` per field over `diffJoinSql`.
- [ ] **Step 4:** `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(api): crawl_diff, a field-level diff of two crawls of one site
  (29c)`.

### Task 8: `crawl_diff_urls`

**Files:**
- Modify:
  - `src/api/service.ts`: `listDiffUrls(tenant, baseCrawlId, headCrawlId, field, opts:
    {state?, limit?, cursor?} & Partial<DiffThresholds>): Promise<Page<DiffUrl> & {field,
    state, thresholds}>`.
  - `src/api/mcp.ts`: tool `crawl_diff_urls`.
  - `src/api/http.ts`: `GET /diff/urls`.
  - Tenancy, the mcp list and count (thirty-eight), the `nextCursor` condition.
  - `docs/talos-surface.md` (7.6 continued).
- Test: `test/api/crawl-diff.test.ts` (append)

**Interfaces:**
- `field` is one of `DIFF_FIELD_NAMES`, `added` or `removed`. Anything else is VALIDATION,
  listing the accepted names.
- `state` is `changed` (default) or `notComparable`. It is refused for `added` and
  `removed`.
- `DiffUrl` is `{url, before, after}`.
  - Values are as stored, so text is capped as stored.
  - `canonical` is `{html, header}`.
  - `schemaTypes` is a sorted array.
  - For `added` and `removed`, both values are null.
- Keyset on `url`, with `decodeCursor(cursor, 1)`.

- [ ] **Step 1: Write the failing tests.**
  - **Agreement with the summary.** On Task 7's crawls, for every field, the number of
    URLs paged through `changed` equals the summary's `changed`, and the same holds for
    `notComparable`.
  - **Values.** `before`/`after` read correctly for title, canonical, schema types and
    link score.
  - **Paging.** `limit: 1` pages each URL exactly once.
  - **Refusals.** A bad field or state is VALIDATION. Pairing refusals are as Task 7's.
  - **Tenancy.** As Task 7's.
- [ ] **Step 2:** Run. Expect a FAIL.
- [ ] **Step 3: Implement** over `diffJoinSql` and `DIFF_FIELDS`, with `where url > cursor
  order by url limit n+1`.
- [ ] **Step 4:** `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(api): crawl_diff_urls, the URLs behind each diff count (29c)`.

### Task 9: Gate tooling

**Files:**
- Modify:
  - `test/gate/site-server.ts`: a `plant` option, defaulting to `GATE_PLANT === "1"`, read
    like `sitemapHreflangSwitch`. It applies R12's three index sets, and `siteFixture`
    exposes `plantedSets(pages)`.
  - `test/gate/site-server.test.ts`:
    - planted titles change only `<title>`;
    - the status set answers 410;
    - removed pages are in no link and no sitemap, and answer 404;
    - every non-removed page is still reachable from `/` (a BFS over `linkTargets`).
  - `scripts/gate-rules.ts`:
    - print `summary.derivedMs` per derivation;
    - add `durationsMs.linkDerive` (the sum of `deriveLinkCounts` and `deriveLinkScore`);
    - on a gate run, fail when it exceeds `60_000`;
    - make `isGate` false when the site is planted.
  - `scripts/gate-schedules.ts`:
    - accept `GATE_DB_NAME`, which defaults to `ariadne_gate28c` and must start with
      `ariadne_gate`;
    - in clause 1c, beside `crawl_compare`, call `crawlDiff` on the first and tenth fired
      crawls;
    - expect every field `changed 0`, `notComparable 0`, and `added`/`removed` 0.
- Create: `scripts/gate-diff.ts`.
  - **Arguments:** `--base <crawlId> --head <crawlId> [--json-out p]`. The database name must
    start with `ariadne_gate`.
  - **Timing:** it times `crawlDiff` and the first `crawlDiffUrls` page for `title` (each
    must be ≤ `5_000` ms) and samples RSS.
  - **It asserts, by paging every URL:**
    - `removed` is exactly the planted removed URLs, and `added` is 0;
    - `title` changed is exactly the planted title URLs;
    - `status`, `fetchClass` and `indexable` changed are exactly the planted status URLs;
    - `metaDescription`, `h1`, `canonical`, `metaRobots`, `wordCount` and `schemaTypes`
      changed are 0.
  - **It records, without asserting:** `inlinks`, `clickDepth`, `linkScore`.
  - It prints `GATE PASSED (29c clause 3)` or the failures.
- Test: the site-server test above; `scripts/gate-diff.ts` gets a smoke run in Step 3.

- [ ] **Step 1:** Write the site-server tests. Run them; expect a FAIL.
- [ ] **Step 2:** Implement the plant, the `gate-rules` timing and the `gate-schedules`
  change. Make the site-server tests pass.
- [ ] **Step 3: Smoke on the dev DB at `GATE_PAGES=2500`.** R12's sets hold 5 titles,
  2 statuses and 1 removed at that size.
  - Run `gate-rules` twice, the second time with `GATE_PLANT=1`.
  - Then run `gate-diff --smoke --base … --head …`. `--smoke` lifts the gate-DB name guard
    and suppresses GATE PASSED. Declare the flag in `gate-diff.ts`.
  - Delete the smoke crawls afterwards through the API's crawl delete. They are rows this
    session created.
- [ ] **Step 4:** `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `test(gate): planted gate site, link-derive timing, gate-diff and the
  schedule-pair diff (29c)`.

### Task 10 (controller, not a subagent): gate run and record

This needs the owner's OK to create `ariadne_gate29c`.

1. **Database.** Create it with `npm run db:migrate`.
2. **Clause 1.** Run `gate-rules` at 50k and record the derivation times and the peaks.
   `linkDerive` must be ≤ 60 s, and the peak ≤ 306.4 MB local and ≤ 512 MB contract.
3. **Clause 2.** Task 2's test is the evidence.
4. **Clause 3.** Run `gate-rules` again with `GATE_PLANT=1`, then `gate-diff` over the two
   crawls.
5. **Clause 4.** Run `gate-schedules` with `GATE_DB_NAME=ariadne_gate29c`.
6. **Record.** Write `docs/gates/phase-29c.md`, shaped like `phase-29b.md`, with the open
   items (R3's page-level nofollow) and R4's deviation.
7. **Docs.** Set `CLAUDE.md` to "Phases 0–29c are shipped".

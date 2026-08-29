# Phase 7 — Audit Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the first real audit's engine-defect list (lavishalice.com, docs/gates/phase-6.md + the render diagnosis) into engine truth: honest word counts, the missing field-level duplicate rules, the query-surface exposure gaps, click depth, and the two promoted guards — gated by re-auditing lavishalice.com and proving the delta.

**Supersession note:** the build plan's original "Phase 7 — Reports" collapsed into Phase 6's ariadne-report/ariadne-action-plan skills (its gate — a real client site producing a full deliverable set with no manual data wrangling — was demonstrated 2026-08-28 on lavishalice.com). This phase takes the number, keeps the milestone spirit (a real site audited *truthfully* end to end), and notes the supersession here rather than editing the build plan's history.

**Architecture:** The raw-side measurement gains a second, honest column (`renderable_word_count`) beside the untouched evidence column; rules and metrics re-read the honest one. New field-level duplicate rules join the query phase. The API exposes what it already stores (robots raw, discoveredVia, fetchClass, legacyHosts, judged-state). Click depth is a computed metric over the links table. A CI test pins every engine identifier the skills quote.

**Evidence authority:** `docs/gates/phase-6.md` (the audit's divergences + dispositions), `audits/lavishalice.com/render-diagnosis.md` in this worktree (gitignored; the measured falsification of the CDN hypothesis and the `<template>`/hidden-chrome numbers — Task 1's implementer reads it first), `audits/lavishalice.com/audit-report.md` + `PRODUCTION-NOTES.md` (the run's skill divergences).

**Tech Stack:** unchanged (Node 22 TS strict ESM, htmlparser2 streaming, drizzle migration 0010, vitest, Postgres 16).

## Global Constraints

- All ten hard rules bind; specifically: no DOM on the crawl hot path (the hidden-surface suppression is markup-only, computed in the streaming tokenizer — `hidden` attribute, inline `style` containing `display:none`, `<dialog>`/`<details>` without `open`; NO CSS evaluation, and the docblock states that class-based hiding is invisible to it by design); `word_count`/`text_ratio` stay untouched as evidence (rules re-read the new column; changing stored evidence semantics silently is the forbidden move).
- `RULESET_VERSION` → `0.5.0` in the commit that changes verdict surfaces (new rules + re-read thresholds).
- Politeness for the gate re-crawl: the proven lavishalice settings (maxConcurrency 2, perHostDelayMs 2000 per the platform table's post-gate guidance — the ratchet earned 2000 last time; start there), maxPages 3000, the abort semantics from the phase-6 gate dispatch.
- Copy for every new id; copy column-coverage tests extended; identity helpers; validate-don't-cast; deterministic capped listings with truncation notes (the count==summary invariant and truncated/total surfacing now exist — new rules use them from birth).
- Migrations via drizzle-kit only (0010). Cursor-paginated listings per the established contract.
- Commits end with:
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Measurement truth — `<template>` exclusion + `renderable_word_count`

**Files:** Modify `src/crawl/parse/page-analyzer.ts`, `src/db/schema.ts` (+migration 0010), `src/crawl/persist.ts`, consumers: `src/rules/page/on-page.ts` (content.thin), `src/rules/query/render-diff.ts` (csr-dependent), `src/rules/metric/content-metrics.ts` (metrics-by-type); parity oracle `test/crawl/page-analyzer.upstream.test.ts`; tests throughout.

**Interfaces:**
- Read `audits/lavishalice.com/render-diagnosis.md` FIRST — it carries the measured numbers this task must make true (product page: 1,413 raw of which 482 are `<template>` content; ~740 words of markup/CSS-hidden chrome; rendered 335 was CORRECT).
- Analyzer: `template` joins the non-content tags (its content exists in no DOM under any CSS — same family as script/style; this corrects `word_count` itself, the one semantic change to existing evidence, argued in the docblock and disclosed in the gate doc: template text was never content, counting it was a bug not a definition). A NEW accumulator produces `renderableWordCount`: the same visible-text stream additionally suppressed inside elements carrying the `hidden` attribute, inline `display:none`, or `<dialog>`/`<details>` without `open` — depth-counter idiom (nav/footer precedent), htmlparser2 only. `PageAnalysis` gains `renderableWordCount: number`; parity oracle: cheerio-side computes the same markup-only rule (NOT CSS — assert the shared limitation in both).
- Schema 0010: `pages.renderable_word_count int` (nullable — null on pre-P7 crawls, the isAuditable gate; comment names the writer + the markup-only limitation).
- Consumers re-read: `content.thin`'s floor reads `renderable_word_count` (falls back loudly — a null on a pre-P7 crawl SKIPs the page with the established skip-copy pattern, never silently uses the old column); `content.csr-dependent` compares rendered against renderable (thresholds unchanged — re-derive the fixture arithmetic honestly); `content.metrics-by-type` gains renderable percentiles beside the existing ones (shape widened, copy updated, column-coverage test extended).
- The fixture site gains one page reproducing the diagnosis shape (template block + hidden drawer + closed details) with hand-computed word/renderable counts asserted through the full pipeline.

- [ ] TDD (template exclusion; each suppression trigger; nesting/malformed cases per the tokenizer's established test style; consumer re-reads incl. the null-SKIP; parity) → migration → full suite green → commit `fix: word counts stop counting what no visitor can read (P7-T1, render diagnosis)`.

---

### Task 2: Field-level duplicate rules + redirect inlinks

**Files:** Create `src/rules/query/field-duplicates.ts`; modify `src/rules/metric/crawl-metrics.ts` (redirect inlinks), registry copy, coverage tests; tests per file.

**Interfaces:**
- `title.duplicate` — groups of indexable pages sharing an exact trimmed title (≥2 pages); one finding per group, `dedupeKey` the title hash, evidence `{title, pages: [urls ≤ cap], count}` with truncation notes; severity warning, CHECK-35.
- `meta-description.duplicate` — same shape over meta descriptions, CHECK-36.
- `h1.duplicate-text` — same shape over first-H1 text, CHECK-37 (requires the analyzer to already capture H1 text — verify; if only counts exist, the analyzer gains `h1Text: string | null` (first H1's text) + persist + migration ride in 0010 — check BEFORE writing 0010 in Task 1; coordinate: Task 1 owns the migration, so THIS task's schema needs are declared there — the pre-flight scan must confirm 0010 carries both).
- `redirect.volume` value gains `redirectInlinks` — count of links rows whose target resolves (via `redirect_url_normalised`) to a redirecting page — the crawl-budget figure CHECK-10 asks for; copy + column-coverage updated.
- Coverage arithmetic re-pinned from registry truth; `RULESET_VERSION` → `0.5.0` here (first verdict-surface commit if Task 1 hasn't already bumped — ONE bump per phase: whichever task lands first bumps, the other verifies; the pre-flight scan assigns it).

- [ ] TDD with exact hand-computed groups (shared titles across types; near-identical-but-not-exact NOT grouped; the template-floor case from the audit) → full suite green → commit `feat: the duplicate numbers the checklist always asked for (P7-T2)`.

---

### Task 3: Surface exposure — robots raw, page filters, legacyHosts, judged-state

**Files:** Modify `src/api/service.ts`, `src/api/http.ts`, `src/api/mcp.ts`; tests both transports.

**Interfaces:**
- `GET /crawls/:id/robots` (+ MCP `robots_get`): the stored discovery evidence's raw robots body + fetch metadata (already persisted — exposure only; tenant-safe: it is the site's own public file).
- `pages_query` gains `fetchClass` and `discoveredVia` filters + both columns in the projection (closing the audit's blocked-pages and orphan-cross-check gaps).
- Crawl detail (`GET /crawls/:id` + `crawl_status`) gains: `legacyHosts` (echoed from the stored config — CHECK-15's semantics become checkable), `rulesRunAt` (timestamp written by runRules at completion — needs a `crawls.rules_run_at` column: declare in Task 1's 0010), `findingsCount` (live count). The skills' judged-crawl verification reads the marker instead of inferring.
- Tool descriptions updated; the NOT-MEASURED sentinel prose adjusted where the marker now answers it.

- [ ] TDD both transports (filter matrix additions, robots raw round-trip, marker null-vs-set on unjudged/judged, legacyHosts echo incl. empty) → full suite green → commit `feat: the surface answers what it always knew (P7-T3)`.

---

### Task 4: Click depth

**Files:** Create `src/rules/derive/click-depth.ts` (derivation phase — recursive CTE BFS over links from the home page, writing `pages.click_depth int` nullable — column declared in Task 1's 0010); modify `src/rules/metric/link-metrics.ts` (`structure.depth-distribution` reads click_depth; discovery depth stays as evidence with its own metric renamed honestly — decide: either two metrics (`structure.click-depth-distribution` new + old one's copy corrected to say discovery) or re-point the existing id and bump — the plan's call: NEW id `structure.click-depth-distribution` claiming CHECK-31, the old id keeps its data but its copy says discovery depth and CHECK-31 moves to the new one); checklist CHECK-31 Engine line updated; coverage re-pinned.

**Interfaces:** BFS from the crawl's seed origin root over the links table entirely in SQL (recursive CTE, `union` distinct semantics, depth = min hops, unreachable = null — null is the finding surface for orphans, consistent with links.orphan); memory contract: the CTE materializes per-depth frontiers in Postgres, never in JS.

- [ ] TDD (hand-computed BFS on a seeded graph incl. cycle, unreachable, self-link; the lavishalice shape — sitemap-only pages get null not 0) → full suite green → commit `feat: click depth measures what CHECK-31 always meant (P7-T4)`.

---

### Task 5: The guards + skill reconciliation

**Files:** Create `test/skills/identifier-guard.test.ts`; modify `skills/ariadne-*/SKILL.md` + `skills/ariadne-audit/checklist.md`.

**Interfaces:**
- The CI guard: extracts every backticked engine identifier from `skills/**` (rule ids, metric ids, tool names, field names, env vars — pattern-classified) and asserts each exists in the registry / tool list / serializer field sets / config keys. Four realized divergences (gate D-4/5/10/11) are the justifying evidence — cite them in the docblock. Unmatchable identifier classes are an explicit allowlist with reasons, not silent skips.
- Skill reconciliation: findings filename unified (`ariadne-findings.json` vs `findings.json` — pick one, all mentions agree); action-plan G4/E4 dead-gate interplay fixed (Phase 0 absent → E4's third condition must not auto-exclude — re-word the condition to require affirmative evidence); the 1e floor covers single-row site-wide checks (the CHECK-22 cut); the new surface (robots_get, filters, judged marker, click depth, renewable counts, new rules) reflected wherever the skills instruct the old shapes.

- [ ] Guard red-first against a seeded stale identifier → reconciliation → full suite green → commit `test: the skills cannot drift from the engine silently (P7-T5)`.

---

### Task 6: Gate — re-audit lavishalice.com + docs/gates/phase-7.md

**Files:** Create `docs/gates/phase-7.md`; deliverables under `audits/` (gitignored).

- Fresh crawl (settings above) → render → rules through the API; then the deliverable chain (findings + report + action plan) regenerated by a skills-only agent.
- **The gate is the delta**, measured: (1) on SSR pages, `renderable_word_count` within a stated tolerance of `rendered_word_count` (the diagnosis's two reproduction pages named explicitly); (2) `title.duplicate`/`meta-description.duplicate`/`h1.duplicate-text` fire with real numbers (the audit predicted the product-template shapes); (3) CHECK-31 answered from click depth with the sitemap-seed artefact gone (the 437-at-d0 number must move); (4) the identifier guard green; (5) politeness unchanged-or-better (blocks 0, spacing story recorded); (6) the report's "engine defect" section from the first audit re-checked item by item — each one fixed-here / still-open-with-reason.
- `docs/gates/phase-7.md` records all of it (provenance discipline), supersessions (phase-6 backlog items discharged), remaining backlog restated, CI placeholder.
- [ ] Run for real → record → full suite + typecheck green → commit `test: phase 7 gate — the second audit measures what the first one guessed (P7-T6)`.

---

## Self-Review (performed at authoring time)

- **Coverage vs the defect list:** render-measurement → T1; six missing numbers → T2 (titles/descriptions/H1/redirect-inlinks; image weight + CWV stay out of engine scope — browser/bytes territory, recorded in T6's gate doc as deliberate non-goals); robots-content/discoveredVia/fetchClass/legacyHosts/judged-marker → T3; depth → T4; skills guard + prose drift → T5; the re-audit proves it → T6. content.thin template-floor blindness → T1's renderable re-read + T2's duplicate rules jointly (the ~990-word shared template becomes visible as duplicated boilerplate).
- **Migration coordination:** 0010 is written ONCE in T1 and carries T2's `h1_text` (if needed — T1 verifies), T3's `rules_run_at`, T4's `click_depth`. The pre-flight scan confirms the full column list before T1 dispatches.
- **Ruleset bump:** exactly one 0.4.0→0.5.0, assigned by the pre-flight scan to the first verdict-changing task.
- **At-execution blanks:** copy text, hand-computed fixtures, T6's measured numbers, the tolerance for renderable≈rendered (set from the diagnosis's numbers at T6, stated not fudged).
- **Known risks:** markup-only suppression undercounts class-hidden chrome (stated limitation, the gate tolerance absorbs it — if the gate shows it's insufficient, that is a finding for a future CSS-aware pass, not a silent widening); the BFS CTE on 1.1M-link crawls needs an EXPLAIN at gate scale (T6 records it); re-crawling the client site is one more ~17-minute polite visit (owner-sanctioned site, proven settings).

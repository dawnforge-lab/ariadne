# Phase 8 — Full-Picture Audits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three owner directions (2026-08-29) made engine truth: agent-directed rendering of key templates with a symmetric measurement (no render-all — "a waste of resources"); client-supplied sitemap URLs ("some websites may not list sitemap in the robots.txt"); full-picture findings for client-billed audits ("more important is to have a full picture rather than snapshots") — plus the template-detection fix that makes the first direction work, gated by a third lavishalice.com audit.

**Owner decisions recorded:** render-all rejected; the near-duplicate threshold stays at strict-3 (the SF-90%-parity widening was explained and declined — "we don't need to change"; it remains a small config job the day a client asks); a third lavishalice crawl approved as the gate.

**Architecture:** The renderer serializes the post-JavaScript DOM and runs it through the SAME streaming analyzer as raw HTML — both sides measured by one instrument, so CSS-hidden chrome cancels and the diff isolates exactly what JavaScript changed (this dissolves Phase 7's 425-word constant without CSS evaluation). `crawl_render` gains an explicit `urls` mode the auditing agent drives from a new key-templates skill section. `crawl_start` gains `sitemapUrls` feeding discovery's existing `extraSitemaps` seam. Listing caps become per-crawl config with the storage following it. `derivePageType` collapses singleton cohorts so real templates emerge.

**Spec:** the phase-7 gate's Phase 8 backlog (docs/gates/phase-7.md §9) + the owner directions above. Evidence: audits/lavishalice.com-audit2/ (in-worktree, gitignored) + both prior gate docs.

## Global Constraints

- All ten hard rules bind. Notably: no DOM on the crawl hot path (the rendered-DOM analysis happens in the render pass, off it); rules read the database; politeness (agent-directed renders pace exactly like automatic ones; the third crawl uses the proven 2000ms/2-worker settings).
- `word_count`/`renderable_word_count`/existing evidence semantics unchanged — the rendered side gains NEW columns/evidence, never redefines old ones.
- `RULESET_VERSION` → `0.6.0` in the first verdict-changing commit (csr-dependent's comparison changes sides in T1 — T1 bumps; later tasks verify).
- Caps: raising/removing a cap NEVER removes the truncation note mechanism — an uncapped run simply never writes one; a capped run's note stays exact. Deterministic ordering everywhere regardless of cap size.
- Migrations via drizzle-kit only, consolidated: ONE migration 0011 written in T1 carrying every schema need of the phase (T1's rendered-evidence columns; T4 needs none — findingCap is config; verify T2/T3/T5 need none — config and derivation-internal; if a later task discovers a need, STOP and report NEEDS_CONTEXT).
- Skills changes ride with the tasks whose surface they document (the claiming-commit discipline); the identifier guard + shape tests are the net.
- Commits end with:
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Symmetric render measurement

**Files:** Modify `src/crawl/render/renderer.ts` (serialize + analyze), `src/db/schema.ts` (+migration 0011), `src/crawl/render/run-render.ts` (write path), `src/rules/query/render-diff.ts` (csr-dependent re-sided; nav/filters re-read), `src/rules/metric/render-metrics.ts` if shapes widen; tests throughout.

**Interfaces:**
- The renderer, after settle, captures `document.documentElement.outerHTML` (the post-JS DOM) and runs `analyzeHtml` (the SAME streaming analyzer — import it; it is pure) over it in the render worker. From that analysis it writes the NEW columns: `rendered_analyzer_word_count int`, `rendered_renderable_word_count int` (the honest pair — the analyzer's raw + renderable counts over the rendered DOM), `rendered_title text`, `rendered_h1_count int`, `rendered_canonical text` (nullable, capped consistently with raw columns). The EXISTING innerText-based `rendered_word_count`/`rendered_link_count`/nav/footer/filter counts keep their semantics (evidence stability; schema comments cross-reference the two measurement families and which rules read which).
- The rendered HTML itself is NOT stored in Postgres (size); it is written to a per-crawl directory `renders/<crawlId>/<urlHash>.html` (git-ignored, path recorded in the page row? — a `rendered_html_path text` column, nullable; the export/inspection story SF users expect; the gate doc records disk cost).
- `content.csr-dependent` re-sides: fires on `rendered_renderable_word_count >= 2 * greatest(renderable_word_count, 1) AND (rendered_renderable - renderable) >= 150` — both sides now the same instrument; docblock states why the 425-constant cancels (chrome markup present in both documents). Threshold arithmetic re-derived on fixtures. Old comparison retired from the rule (columns stay as evidence).
- Diff surface widens where cheap: `render.title-drift` is NOT added (YAGNI — note as future); the existing nav/filters rules re-read the analyzer-side counts IF that improves comparability (assess: nav counts already markup-vs-DOM-selector symmetric-ish per P5's design — decide with the comparability argument written down, don't churn for churn).
- `RULESET_VERSION` → `0.6.0` here. Fixture: a CSR page whose chrome exists in both documents (raw drawer + JS-added body text) with hand-computed counts proving the cancellation.

- [ ] TDD (serialization → analyzer round-trip on fixture pages incl. malformed DOM output; the cancellation arithmetic; csr fires on true CSR and stays silent on chrome-only; render failure paths unchanged) → migration 0011 → full suite green → commit `feat: both sides of the render diff read the same instrument (P8-T1)`.

---

### Task 2: Agent-directed rendering + the key-templates skill

**Files:** Modify `src/crawl/render/select.ts` + `run-render.ts` (explicit-urls mode), `src/api/service.ts`/`http.ts`/`mcp.ts` (`crawl_render` gains `urls?: string[]`), `skills/ariadne-crawl/SKILL.md` + `skills/ariadne-audit/SKILL.md` (the key-templates section); tests both transports + DB.

**Interfaces:**
- `renderCrawl(crawlId, {urls?})`: when `urls` present — each entry validated (url-policy, allowlist-family, EXISTS in this crawl's pages with fetch_class ok/200 — a URL not crawled is a 400 naming it, never a fetch), deduplicated, capped at `renderMaxPages`, promoted to `render_pending` via the existing selection machinery's upsert (the demote-unnamed semantics apply — an explicit list REPLACES the automatic selection for this pass, stated); the pass runs identically (pacing, earned spacing, guard conditions). `render.coverage` gains `selectionMode: "auto" | "explicit"` in its value (copy + column-coverage updated).
- Automatic mode unchanged and remains the default.
- The skill section (fresh prose, both files coordinated): identify the site's real templates — `metrics_get content.metrics-by-type` cohort sizes + URL-pattern reading (and T5's improved detection once it lands — the section survives both worlds by instructing the method, not the cohort count); render the home page + 2-3 representatives per real template + any suspicious one-offs; THEN `crawl_rules`; read the diff rules + the new symmetric columns. State the budget arithmetic (a 4-template site ≈ 10-15 renders) and the never-render-all rationale (the owner's, verbatim in spirit).

- [ ] TDD (explicit list happy path incl. render.coverage mode field; uncrawled-URL 400; policy refusal; replaces-automatic semantics; both transports) → full suite green → commit `feat: the agent names the pages worth a browser (P8-T2)`.

---

### Task 3: Client-supplied sitemap URLs

**Files:** Modify `src/api/service.ts` (`START_CRAWL_FIELDS` + validation), `src/crawl/loop.ts` (config → discovery), `src/crawl/discovery.ts` (the `extraSitemaps` seam — read its existing docblock incl. the deliberate no-speculative-/sitemap.xml refusal and HONOR it: supplied ≠ speculative); skills (`ariadne-crawl` prerequisites/start); tests.

**Interfaces:**
- `crawl_start` gains `sitemapUrls?: string[]` — each validated (url-policy; host within the allowlist-family of the seed, same posture as legacyHosts' gate), passed to discovery's `extraSitemaps`. Provenance: `sitemap_urls.source` (or the discovery evidence — read how source docs are recorded) distinguishes `robots-declared` vs `supplied`; `sitemap.structure`'s per-doc rows carry it if the shape allows without churn (assess; at minimum the discovery evidence records which sitemaps were supplied).
- The deliberate no-/sitemap.xml-probe stance stays (its docblock reasoning governs) — the skill documents the two paths: robots-declared automatically; not declared → the operator/client supplies the URL at crawl start.
- Config persisted (storableConfig — verify sitemapUrls survives, allowPrivate-strip untouched); echoed on crawl detail beside legacyHosts.

- [ ] TDD (supplied sitemap discovered + rules join it; supplied + declared merge/dedupe; off-family supplied URL 403; provenance recorded; echo on both transports) → full suite green → commit `feat: the client can hand the crawler its sitemap (P8-T3)`.

---

### Task 4: Full-picture caps

**Files:** Modify the cap plumbing: `src/rules/registry/` or wherever `URL_FINDING_CAP` lives + every listing rule that reads it (grep — the group rules, orphans, link rules, near-duplicate's pair cap), `src/rules/run.ts` (cap in the run options ← crawl config), `src/crawl/loop.ts`/`src/api/service.ts` (`findingCap` per-crawl config: number | "unlimited"); skills (the caps story + when to raise); tests.

**Interfaces:**
- `findingCap?: number | null` on crawl config (null = uncapped; default 200 — today's behaviour byte-identical when unset). Flows: config → runRules options → each listing rule's LIMIT + the pair-scan cap. The truncation-note MECHANISM unchanged: notes written exactly when a cap bites; uncapped runs never write one; the API's truncated/total/atLeast surfacing works untouched.
- Near-duplicate: `NEAR_DUPLICATE_PAIR_CAP` follows the same config (threshold stays 3 — owner decision recorded above).
- Memory honesty: the findings buffer already flushes in batches — verify an uncapped orphan listing (e.g. 5,000 rows) streams through it without an O(findings) array anywhere new; the run summary counts stay exact. Measure the uncapped cost on the 50k dev crawl (the two gate crawls are small; seed-scale if needed) — the number goes in the T6 gate doc (the billing story: "full picture costs X at 50k").
- Skills: the audit skill's caps prose updates (a billed audit sets findingCap null; the action-plan's export threshold reading adjusts — grep its 2,000-row switchover for consistency with uncapped listings).

- [ ] TDD (default unchanged — existing truncation tests green untouched; capped custom value; uncapped run lists all + writes no note; near-dup pair cap follows; config validation incl. wire) → full suite green → commit `feat: a billed audit gets the whole picture, not a snapshot (P8-T4)`.

---

### Task 5: Template inference — `derivePageType` collapses singletons

**Files:** Modify `src/crawl/parse/url-utils.ts` (`detectUrlTemplate`/`derivePageType` — read the current hyphen-parts rule), consumers' expectations (metrics-by-type, selection sampling, the harness pins — honest re-derivations); tests.

**Interfaces:**
- Second pass over the crawl's URL population (derivation-time, not parse-time — page_type is currently written at persist; assess: a crawl-wide inference needs the population, so it becomes a DERIVATION that rewrites page_type post-crawl (the field_presence group-UPDATE precedent) OR a smarter per-URL rule; the population approach is right — one honest design: group by first-N path segments, a cohort with ≥ MIN_COHORT (3) members keeps its template id; below it, collapse to the parent segment pattern (`/collections/:slug` style); the lavishalice acceptance test: 551 URLs → the four real templates + a small tail, NOT 196).
- `page_type` semantics documented as derived-at-judgement (pre-derivation reads see the parse-time value — assess who reads it between persist and derivation: the render selection! If selection runs pre-rules... selection reads page_type for sampling — on the gate flow selection runs before rules. Decide the ordering honestly: EITHER the derivation runs in BOTH places (idempotent, cheap) or selection tolerates parse-time types (it did fine post-T4-P7 with size-ordering). State the choice.)
- Every moved pin re-derived (metrics-by-type cohorts move on the fixture site; the harness's type counts).

- [ ] TDD (the lavishalice URL-shape corpus as a fixture list → 4 templates; collapse boundaries; idempotence; moved pins) → full suite green → commit `feat: four templates, not 196 — page types earn their names (P8-T5)`.

---

### Task 6: Gate — third lavishalice.com audit + docs/gates/phase-8.md

**Files:** Create `docs/gates/phase-8.md`; deliverables under `audits/lavishalice.com-audit3/`.

- Part A (operator): fresh crawl WITH `sitemapUrls` supplied explicitly (redundant with robots — that redundancy IS the test) and `findingCap: null`; proven politeness settings; then the agent-directed render flow per the skill (identify templates — T5 should now say ~4 — render home + representatives); rules; the delta measurements: csr-dependent's new comparison on the rendered set (the cancellation proven on real pages — rendered_renderable vs renderable deltas quoted); full listings (all 243+ orphans, the complete near-duplicate set — the uncapped count the second audit couldn't state); template count 196 → N; supplied-sitemap provenance visible; uncapped cost measured.
- Part B (skills-only agent): the full deliverable set from the reconciled skills — the key-templates section's first real exercise.
- Part C: `docs/gates/phase-8.md` — the three-audit delta table, every number measured, dispositions, the remaining backlog restated (what this phase deliberately did NOT do: render-all rejected, threshold kept strict — the owner's decisions recorded), CI placeholder.
- [ ] Run for real → record → full suite + typecheck green → commits per part-C precedent.

---

## Self-Review (performed at authoring time)

- **Owner directions covered:** key-template agent rendering → T1+T2 (the skill IS the ask's "probably needs a skill"); supplied sitemap → T3 (the existing extraSitemaps seam honored); full picture → T4; render-all explicitly rejected and recorded; threshold explicitly kept and recorded.
- **Backlog folds:** csr-comparability → T1 (the symmetric fix); chromeWords → mooted by T1 (recorded as such in T6); derivePageType → T5 (fourth sighting closed). NOT folded (stay recorded): structure.deep-page click-depth read; plan-pinning/EXPLAIN mechanism; one-scan-for-three; crawl-aging harness; h1 `<br>` merge; template-ELEMENTS ruling; the Talos /2 note.
- **Migration:** 0011 once, in T1 (rendered-analyzer columns + rendered_html_path). T2-T5 config/derivation only — T5 rewrites page_type IN PLACE (existing column). Confirmed no other schema need at authoring; NEEDS_CONTEXT protocol if wrong.
- **Ruleset:** one bump 0.5.0→0.6.0 in T1 (csr-dependent re-sides). T5 changes page_type VALUES (metric cohorts move) — that is data-shape not verdict-copy; assessed as not requiring a second bump but the T5 reviewer re-weighs against the version constant's own contract text.
- **At-execution blanks:** copy, fixture arithmetic, the uncapped-cost numbers, T6's delta.
- **Known risks:** running the analyzer inside the render worker adds CPU per render (bounded by the explicit/budgeted counts — measure at gate); rendered-HTML disk cost (measure; a retention note in the gate doc); T5's population-derivation ordering vs render selection (decided in-task with the argument written); the third real crawl is one more ~20-minute polite visit (owner-approved).

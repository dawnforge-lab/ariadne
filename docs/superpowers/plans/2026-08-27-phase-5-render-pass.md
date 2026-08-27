# Phase 5 — Render Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two-pass render mechanism (Playwright over a budgeted sample + suspects) that claims the last three unclaimed checks — CHECK-01, CHECK-02, CHECK-34 — plus CHECK-10's JS-redirect half, taking the registry to 47/47 claimed.

**Architecture:** Pass one is the existing HTTP crawl. Pass two re-renders a per-page-type sample plus every URL a suspicion filter trips, budget-capped at ≤5% of URLs, reusing the frontier with a `render_pending` state. Diff rules read stored raw-vs-rendered columns only. The phase opens with the hard-kill durability fix the build plan mandates "before the frontier's state machine grows a `render_pending` state".

**Tech Stack:** Node 22, TypeScript strict ESM, Playwright (chromium) as a new dependency, drizzle migration 0007, vitest, Postgres 16.

**Spec:** `docs/crawl-audit-engine-spec.md` §5 (rendering strategy) + `docs/crawl-audit-build-plan.md` §Phase 5 and §7 (hard-kill durability). Checklist authority: `~/.claude/skills/sf-audit/checklist.md` CHECK-01 (~line 185), CHECK-02 (~line 222), CHECK-34 (~line 983), CHECK-10 (JS redirects).

## Global Constraints

- Never write a rule that always passes; unrendered pages are "not audited", never "pass" (isAuditable pairing precedent).
- Never fetch inside a rule. Rules read the database.
- Never load the links table into memory. Every link question is SQL.
- Never build a DOM on the crawl hot path. The render pass is pass two, off the hot path — Playwright is allowed there by design; the *analyzer* additions in T2 stay streaming-tokenizer only.
- **url-policy runs on every URL the renderer is about to navigate to** — hard rule 5 applies to the render pass exactly as to the crawl.
- RAM O(concurrency), never O(URLs). Browser contexts are O(renderConcurrency). The 50k gate re-runs with render enabled and stays ≤512MB.
- No silent fallbacks. A failed render is a classified row (`render_error` set, `rendered=false`), never a skipped URL; a budget cut is disclosed in the `render.coverage` metric, never silent.
- Politeness: per-host delay applies to rendered navigations; third-party requests are blocked in the browser context (politeness + budget), same-origin subresources allowed.
- Render budget: ≤5% of crawled URLs (hard cap, configurable), total-cap wins over per-type sampling (the Phase 4 gate's 40,002-single-page-type pathology must not explode the sample).
- Copy: every new rule/metric id gets registry copy; explanations name every column of value shapes; copy column-coverage tests extended with the new ids.
- `RULESET_VERSION` → `0.4.0` in the claiming commit (verdict surface changes).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Hard-kill durability — flush-then-complete (the mandated Phase 5 opener)

**Files:** Modify `src/crawl/persist.ts` (PageWriter), `src/crawl/loop.ts` (~:646/:666), `src/crawl/frontier.ts` (batch completion); tests in `test/crawl/persist.test.ts` + `test/crawl/loop.test.ts`.

**Interfaces:**
- Consumes: `PageWriter.addPage(item, result, analysis)` (persist.ts:137), `completeUrl(db, crawlId, url)` (frontier.ts:180), the loop's per-URL success path (loop.ts:646 buffers, :666 completes).
- Produces: `completeUrls(db, crawlId, urls: string[])` (batch form, chunked under the 65,535-param limit); `PageWriter` records each buffered row's frontier URL and completes them **in the same transaction as `flushPages`** (page-row insert + frontier completion atomically). `addPage` no longer requires the loop to call `completeUrl` on success — loop.ts:666 is deleted; failure paths (`failUrl`) unchanged.

- [ ] Failing test: buffer N < batchSize pages, kill the writer without flush → frontier rows still `leased`/`pending`, never `done`; after `flush()` → page rows durable AND frontier rows `done`, atomically (assert both inside/after an injected mid-transaction failure: transaction aborts → neither the page rows nor the completions land).
- [ ] Implement: `flushPages` wraps insert + `completeUrls` in one `db.transaction`; other flushes (links/hreflang/sd) keep their existing semantics (they are additive evidence; the page row is the durability anchor).
- [ ] Crash-resume test: simulate hard kill (drop writer with a non-empty buffer, no flush), start a fresh loop over the same crawl → the lost URLs are re-leased and re-fetched (frontier not `done`), and the resumed crawl produces the same page rows (onConflict semantics unchanged).
- [ ] Full suite green → commit `fix: flush-then-complete — a hard kill can no longer strand done-marked frontier rows (P5 opener)`.

---

### Task 2: Analyzer captures + migration 0007 + ANALYZE fold

**Files:** Modify `src/crawl/parse/page-analyzer.ts`, `src/db/schema.ts` (+migration 0007 via `npm run db:generate`), `src/crawl/persist.ts` (column writes), `src/rules/run.ts` (ANALYZE); tests in `test/crawl/page-analyzer.test.ts`, parity oracle vs cheerio where the suite already does.

**Interfaces:**
- Produces on `PageAnalysis`: `navLinkCount: number`, `footerLinkCount: number` (anchors with `href` while inside `<nav>`/`<footer>` element depth > 0 — depth counters in the streaming tokenizer, incremented on open, decremented on close, anchors counted when the counter is positive; nested nav-in-footer counts for both, matching what `document.querySelectorAll('nav a[href]')` would report per CHECK-34); `frameworkMarkers: string[]` (subset of `["__NEXT_DATA__", "data-reactroot", "ng-app"]`: `__NEXT_DATA__` = a `<script id="__NEXT_DATA__">` open tag; the other two = attribute names seen on any open tag).
- Produces on `pages`: `nav_link_count int notnull default 0`, `footer_link_count int notnull default 0`, `framework_markers jsonb notnull default '[]'`, plus the render-side columns T4 writes: `rendered_nav_link_count int`, `rendered_footer_link_count int`, `rendered_filter_link_count int`, `rendered_redirect_url text`, `render_error text` (all nullable — null means "not rendered", the isAuditable gate). One migration 0007, additive.
- Produces in `run.ts`: `ANALYZE pages, links, sitemap_urls, url_params, hreflang, issues` executed once at the top of `runRules`, before the page phase — closes the Phase 4 gate's disclosed autovacuum-luck dependency. Loud: a failed ANALYZE throws.

- [ ] Failing tests: fixture HTML with nav/footer/nested anchors → exact counts; each framework marker detected; markers absent → `[]`; no-DOM check stays (htmlparser2 only).
- [ ] Migration 0007 → writers populate → ANALYZE call + a test asserting `runRules` executes it (spy/statement log) → full suite green → commit `feat: raw nav/footer/framework captures + ANALYZE before rules (P5-T1 groundwork)`.

---

### Task 3: Render selection + frontier `render_pending`

**Files:** Create `src/crawl/render/select.ts`; modify `src/crawl/frontier.ts` (state comment + lease filter), `src/crawl/loop.ts` (config); tests `test/crawl/render-select.test.ts` (DB).

**Interfaces:**
- Consumes: `pages`, `links` (SQL only), migration 0007 columns.
- Produces: `selectRenderSet(db, crawlId, cfg): Promise<{selected: string[]; budget: number; suspects: number; sampled: number; truncated: boolean}>` where cfg carries `renderBudgetPct: 5`, `renderMaxPages: 500`, `renderSamplePerType: 3` (defaults; all in `CrawlConfig` as optional with these defaults). Selection is one SQL statement set:
  - Suspects (any of): `word_count < 50 AND html_bytes > 51200`; zero outgoing links (`not exists` in links as source); `(title is null or title = '') AND html_bytes > 25600`; `jsonb_array_length(framework_markers) > 0`. Only `ok`-class 200 pages.
  - Sample: `row_number() over (partition by coalesce(nullif(page_type,''),'(untyped)') order by url) <= renderSamplePerType`.
  - Budget: `min(ceil(pages * renderBudgetPct/100), renderMaxPages)`. Union suspects-first (suspects ordered by url, then sample rows by url), cap at budget, `truncated` true when the union exceeded it. Deterministic: every ordering explicit.
- Produces: selected URLs re-enter `frontier` with `state='render_pending'` (upsert on the existing conflict target — a `done` row moves to `render_pending`; comment at schema.ts:291 gains the state). `leaseUrls` for the crawl pass must NOT lease `render_pending` rows (filter stays `state='pending'`) — a new `leaseRenderUrls` mirrors it for `render_pending`.

- [ ] Failing DB tests: each suspect trigger fires alone; a healthy page is not selected; per-type sample caps at 3; total cap wins with `truncated: true` and suspects preferred; re-run identity (same selection twice).
- [ ] Full suite green → commit `feat: render selection — suspects + per-type sample under a hard budget (P5-T1)`.

---

### Task 4: Playwright renderer

**Files:** Create `src/crawl/render/renderer.ts`, `src/crawl/render/run-render.ts` (the pass driver); modify `package.json` (playwright dep), `src/crawl/loop.ts` or a new export wiring `runRenderPass(db, crawlId, cfg)`; tests `test/crawl/renderer.test.ts` (against the local fixture server — real chromium).

**Interfaces:**
- Consumes: `leaseRenderUrls`, politeness governor (per-host delay before each navigation), `url-policy` (refuse before navigate; a refused URL is a classified `render_error`, not a skip), fixture site server.
- Produces per rendered page (written to the pages row): `rendered=true`, `rendered_word_count` (whitespace-split `document.body.innerText`), `rendered_link_count` (`a[href]` count), `rendered_nav_link_count` / `rendered_footer_link_count` (`nav a[href]` / `footer a[href]`), `rendered_filter_link_count` (anchors whose resolved href contains `?` or matches `/filter|facet|sort/i` — the same predicate T5's raw-side SQL uses, stated in both places), `rendered_redirect_url` (final `page.url()` when it differs from the fetched URL beyond `normalizeUrl` equality; else null). Render failure: `rendered=false`, `render_error=<classified message>` (timeout, navigation error, policy refusal), frontier row `done` either way — a failed render is evidence, not a retry loop.
- Mechanics: one browser, `renderConcurrency` contexts (default 4, config), route interception blocking requests whose origin differs from the crawl origin, navigation timeout 15s then `domcontentloaded` + a 3s settle, `crawls.render_pass_count` incremented per rendered page (single UPDATE at pass end with the count).

- [ ] Failing tests (fixture server): a CSR page (JS injects content) gets `rendered_word_count` > raw; a JS-redirect page records `rendered_redirect_url`; third-party request never leaves (route log); url-policy refusal classified; timeout classified; politeness delay observed between same-host renders (timestamps).
- [ ] Full suite green (chromium available locally) → commit `feat: playwright render pass — budgeted, polite, policy-gated (P5-T2)`.

---

### Task 5: Diff rules + render.coverage metric + coverage completion

**Files:** Create `src/rules/page/render-diff.ts` (or query kind where the data forces it — see below), `src/rules/query/render-redirect.ts`, `src/rules/metric/render-metrics.ts`; modify registry copy, `src/rules/registry/registry.ts` (delete `RENDER_CHECKS`), `test/rules/coverage.test.ts`, copy column-coverage tests; tests per rule file (DB).

**Interfaces (rules — all gated `rendered = true`; a page with `rendered` false/null is not audited by these):**
- `content.csr-dependent` — CHECK-01, critical, category content. Fires when `rendered_word_count >= 2 * greatest(word_count, 1) AND rendered_word_count - word_count >= 150`. Query kind (needs no joins but reads recomputed columns — follow the established queryFinding shape).
- `nav.js-only` — CHECK-34, critical, category technical. Fires when `(nav_link_count + footer_link_count) < 5 AND (rendered_nav_link_count + rendered_footer_link_count) >= 10 AND rendered >= 2 * (raw + 1)` (raw/rendered = the two sums).
- `filters.js-only` — CHECK-02, warning, category url. Fires when raw filter links = 0 (SQL over `links`: outgoing anchors from the page whose target contains `?` or matches `filter|facet|sort` case-insensitively — the T4 predicate, spelled identically) AND `rendered_filter_link_count >= 5`.
- `redirect.js` — CHECK-10, warning, category redirects. Fires when `rendered_redirect_url is not null` on a page whose HTTP fetch was a plain 200 (`fetch_class = 'ok'`) — an HTTP-level redirect is already claimed by the redirect rules; this is the JS-only case. Evidence includes both URLs.
- `render.coverage` — metric, CHECK-01 evidence, site scope: `{pagesCrawled, budget, selected, suspects, sampled, rendered, renderFailures, truncated}` — the quotability of the sampling story; written by reading pages + the selection function's recorded numbers (persist selection stats on the crawls row config or recompute in SQL — implementer documents the choice).
- Coverage: `RENDER_CHECKS` constant deleted (registry + tests); unclaimed pin becomes `expect(unclaimed).toEqual([])`; claimed 44 + 3 agent = 47; ruleset pin 74 → 79 = 27 page + 39 query + 10 metric + the above split as implemented (re-verify against the registry at execution — the kind split here is the authoring estimate: csr-dependent/nav.js-only/filters.js-only as query kind makes 74 → 78 = 26 + 41 + 11; pin whatever the registry truly holds, with the arithmetic shown). `RULESET_VERSION` → `0.4.0` in this commit.
- Every new id: copy entries + column-coverage test additions + fixture-fire obligation carried to T6.

- [ ] TDD with exact hand-computed threshold-boundary tests (each rule: one row just under, one just over; unrendered row never fires) → implement + copy → full suite green → commit `feat: render diff rules — 47/47 checks claimed (P5-T3, ruleset 0.4.0)`.

---

### Task 6: Fixture CSR pages + harness + CI chromium

**Files:** Modify `test/fixtures/` site (add CSR pages), `test/fixtures/harness.test.ts`, `.github/workflows/ci.yml`.

**Interfaces:**
- Fixture pages (served by the existing fixture server, JS delivered inline): `/render/csr-content` (raw ~30 words + `__NEXT_DATA__` script, JS injects ≥200 more words), `/render/js-nav` (raw: 0 nav anchors, JS builds a 12-link nav + footer), `/render/js-filters` (collection-typed page, raw grid with 0 filter links, JS adds 8 `?filter=` anchors), `/render/js-redirect` (200 page whose JS sets `location.href` to `/render/target`), `/render/healthy` (SSR page passing everything, rendered in the sample, fires nothing).
- Harness: runs crawl → `selectRenderSet` → `runRenderPass` → `runRules`; asserts each of the four diff rules fires on exactly its page (and not on `/render/healthy`), `render.coverage` site row pinned exactly (hand-derived from the fixture site's page count and the selection rules), every-rule-fires updated (no exemptions expected — argue any in the established SKIP paragraph style if one emerges).
- CI: `npx playwright install --with-deps chromium` step, cached (`~/.cache/ms-playwright` keyed on the playwright version).

- [ ] Failing harness assertions → fixture pages → green → commit `test: CSR fixture pages — every render rule fires on a real chromium render (P5-T4)`.

---

### Task 7: 50k gate with render + docs/gates/phase-5.md

**Files:** Modify `scripts/gate-rules.ts` (or create `scripts/gate-render.ts` following its conventions — implementer's call, documented), create `docs/gates/phase-5.md`.

- Gate run: 50k crawl → render selection + pass (against the synthetic site; budget math at 50k: min(2500, renderMaxPages 500) = 500 renders) → full rules. Gates: peak RSS ≤512MB (hard, exit non-zero); render count ≤5% of URLs (hard); wall times recorded not gated.
- `docs/gates/phase-5.md`: date, commit, all numbers measured from THIS run (the provenance discipline), render pass wall + per-render mean, browser peak RSS contribution, the four checks' answers from stored data on the gate crawl, coverage 47/47 + ruleset arithmetic + `0.4.0`, supersession notes (phase-4.md's RENDER_CHECKS pin and backlog items this phase discharged — ANALYZE — without editing phase-4.md), CI link placeholder, remaining backlog restated (streaming metric rows, hreflang.invalid-code streaming, CHECK-44 required set, derivePageType heuristics).
- [ ] Run for real → record → full suite + typecheck green → commit `test: phase 5 gate — render pass at 50k, 47/47 claimed, recorded`.

---

## Self-Review (performed at authoring time)

- **Spec coverage:** spec §5 two-pass strategy → T3+T4; suspicion filter (all four triggers verbatim from spec) → T2 captures + T3 SQL; `rendered_*` columns + diff → T2 schema + T4 writes + T5 rules; CHECK-01/02/34 + CHECK-10-JS → T5's four rules; build-plan P5-T1→T2/T3, P5-T2→T4, P5-T3→T5, gate→T7; hard-kill durability (build plan §7, "decide before render_pending") → T1. Backlog folds: ANALYZE → T2. Deliberately deferred: streaming metric rows, hreflang streaming, CHECK-44 required set, derivePageType (named in T7's gate doc).
- **Check arithmetic:** claimed 41 + CHECK-01/02/34 = 44; 44 + 3 AGENT (38/41/42) = 47; unclaimed []. CHECK-10 gains a rule on an already-claimed id (set union, fine). Ruleset count is pinned from the registry at T5 execution, not from this doc (Phase 4's authoring miscount is the precedent for why).
- **Type consistency:** `selectRenderSet` return consumed by T4's driver and T5's `render.coverage`; `rendered_filter_link_count` predicate spelled identically in T4 (browser) and T5 (SQL) with the cross-reference stated in both; migration 0007 columns named identically in T2 (producer) and T4/T5 (consumers); `completeUrls` batch form only consumed inside PageWriter.
- **Deliberate at-execution blanks:** rule copy text; harness hand-computed render.coverage values; T7's measured numbers; the page/query kind split for the three diff rules (registry truth wins, arithmetic shown either way).
- **Known risks named:** chromium in CI (cached install, minutes not tens of minutes); renderer flake (timeout classification is the containment); the 40k-cohort pathology capped by total-budget-wins; suspicion thresholds are first-calibration values — the gate doc records how many suspects the synthetic 50k actually trips so Phase 6 can recalibrate from data.

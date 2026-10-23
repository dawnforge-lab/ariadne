# Phase 24a: Crawling Throttling Platforms (Shopify) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shopify crawl runs to completion at the rate Shopify accepts. It recovers from back-off without oscillating, records how hard the site pushed back, and renders without unpaced bursts.

**Architecture:** Four build tasks and a gate, all on the existing politeness layer:
- `HostGate` gains a bounded recovery (two-strike lock) and per-host throttle counters, persisted with the spacing map.
- The counters are served as `crawl_status.throttle`.
- A platform profile, detected from response headers, caps concurrency and delay.
- The render pass inherits the crawl's earned spacing, paces every same-origin request, and shares the HTTP cache across renders, with cookies and storage cleared between them.
- One migration (0024). No ruleset bump: no rule verdict changes.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16 (drizzle-kit), Playwright Chromium, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-throttling-platforms-design.md`. It was approved by the owner on 2026-10-23, all three §6 decisions yes: the profile caps and never raises; recovery has a two-strike lock; the HTTP cache is shared with cookies and storage cleared. Read it first.

## Global Constraints

- CLAUDE.md hard rules 1–10. Rule 9 (politeness) is this phase's theme; rule 7 (no silent fallbacks) applies to every new state; rule 6 (memory O(concurrency)) applies to all per-host state, which is O(hosts) and must never grow per URL.
- Baseline: branch `worktree-phase-24a` off `main` @ the spec commit. 2,349 tests / 84 files green, tsc clean, migrations 0000–0023, ruleset 0.18.0, 114 rules.
- **Profile caps, never raises:** Shopify → `maxConcurrency := min(config, 1)`, `perHostDelayMs := max(config, 1000)`, `renderConcurrency := 1`, navigation timeout 15 s → 60 s.
- **Recovery:** `RECOVERY_STREAK = 50` consecutive clean responses (2xx/3xx/4xx except 429, no `Retry-After`) since the last escalation steps the host down one escalation level, never below its base. A host that escalates after having recovered is `recoveryLocked` for the rest of the crawl.
- **Throttle record per host:** `responses429`, `retryAfterSeen`, `escalations`, `recoveries`, `recoveryLocked`, `peakSpacingMs`, `finalSpacingMs`. It is crawl evidence, NOT a finding (Phase 16 owner ruling).
- **Detection:** response headers only. `powered-by: Shopify`, or any header whose name starts with `x-shopify-`. No body sniffing, no extra request.
- **Persistence:** new columns `crawls.platform text`, `crawls.platform_profile_jsonb jsonb` (both nullable; null = not detected or pre-0024). Migration 0024 via drizzle-kit only. `crawls.host_spacing_jsonb` keeps accepting the pre-24a shape `{host: ms}` on resume.
- **Client-facing text** (demo labels, any copy) is written by the orchestrator, never by an implementer.
- The suite leaves zero net crawl rows (house `createdCrawls` pattern). Kept dev-DB crawls are read-only.
- `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Review Focus

1. **Alternating 200/429 (the yellow.com.mt token-bucket shape):** the host recovers at most once, then locks. The spacing must never oscillate more than once. (Task 1 test.)
2. **Resuming a pre-24a crawl** whose `host_spacing_jsonb` is a plain `{host: ms}` map loads without error, and the earned spacing still binds. (Task 1 test.)
3. **A Shopify store whose CDN strips the Shopify headers** is not detected: `platform` stays null and the configured settings apply, visibly. Separately, a non-Shopify site is never profiled. (Task 3 tests.)
4. **Render isolation:** a cookie or localStorage value set while rendering page N is absent when page N+1 renders, while the HTTP cache still serves page N's assets. (Task 4 test, real Chromium.)
5. **Paced renders:** same-origin requests during a render never start closer together than the host spacing. A page that cannot finish within the profile's navigation budget is a classified `render_error`, not a dropped URL. (Task 4 tests.)

---

### Task 1: HostGate recovery and throttle counters

**Files:** `src/crawl/politeness.ts` (HostState, `report`, `spacingMs`, export of `RECOVERY_STREAK`, a `throttleRecord()` accessor, serialise and restore of per-host state); `src/crawl/loop.ts` (persistence of the richer state into `crawls.host_spacing_jsonb` wherever the per-host map is written today, and restore on resume); `src/db/schema.ts` (docblock for the jsonb shape only, no column change). Tests in `test/crawl/politeness.test.ts`, `test/crawl/loop.test.ts`.

**Interfaces produced:**
- `export const RECOVERY_STREAK = 50`.
- `HostGate.throttleRecord(): Record<string, HostThrottle>`, where `interface HostThrottle { responses429: number; retryAfterSeen: number; escalations: number; recoveries: number; recoveryLocked: boolean; peakSpacingMs: number; finalSpacingMs: number }`.
- `HostGate.restore(state: unknown)`, which accepts both the pre-24a `{host: ms}` map and the new shape `{host: {spacingMs, escalations, recoveries, recoveryLocked, counters…}}`. It throws on anything else (rule 7).

**Behaviour:**
- A clean response increments `cleanStreak`. Any escalation resets it.
- When `cleanStreak` reaches `RECOVERY_STREAK`, `escalations > 0` and the host is not `recoveryLocked`: `escalations -= 1`, `recoveries += 1`, `cleanStreak = 0`, `spacingGen += 1`.
- An escalation on a host with `recoveries > 0` sets `recoveryLocked = true`.
- The yellow.com.mt docblock section "## The ratchet" is rewritten to state the bounded recovery and the two-strike lock, and why.
- `highWaterMs` keeps the crawl-wide peak; the per-host peak goes into `peakSpacingMs`.

- [ ] Failing tests:
  - 2 × 429 then 50 × 200 → spacing halves once, `recoveries` 1.
  - Then one 429 → `recoveryLocked` true, and 500 × 200 → no further recovery.
  - Alternating 200/429 × 200 → `recoveries` ≤ 1 (Review Focus 1).
  - Recovery never goes below base.
  - Counters match the inputs exactly.
  - `restore` accepts the old map and the new shape, and throws on a string (Review Focus 2).
  - A loop test: a crawl that escalates and is then resumed restores the escalation state.
- [ ] Run → fail → implement → focused → full suite + tsc.
- [ ] Commit: `feat(politeness): bounded recovery from back-off with a two-strike lock; per-host throttle counters`.

### Task 2: Throttle record on the surface

**Files:** `src/api/service.ts` (`crawl_status.throttle`: the persisted per-host record, `null` for pre-24a crawls), `src/api/mcp.ts` (description), `src/demo/index.html` (one progress cell per host that pushed back; the orchestrator supplies the label in the dispatch), `docs/talos-surface.md`, `skills/ariadne-crawl/SKILL.md`. Tests in `test/api/*`, `test/demo/*`.

**Consumes:** Task 1's persisted record.

- [ ] Failing tests:
  - `crawl_status.throttle` equals the persisted record.
  - It is `null` for a crawl without one.
  - The demo cell renders only when `responses429 + escalations > 0`.
- [ ] Implement → full suite + tsc.
- [ ] Commit: `feat(api): crawl_status.throttle — how hard each host pushed back`.

### Task 3: Platform detection and the Shopify profile

**Files:**
- Create `src/crawl/platform.ts`, holding `detectPlatform(headers): "shopify" | null` and `PLATFORM_PROFILES` (a table with one row).
- Modify:
  - `src/crawl/host-probe.ts` and `src/crawl/loop.ts`: classify the first HTML response from the crawl's origin (a probe response if present, else the seed fetch). Apply the profile by clamping `CrawlWindow`'s max concurrency and the `HostGate` base delay. Record the time it was applied if workers had already started.
  - `src/crawl/politeness.ts`: `CrawlWindow.clampMax(n)` and `HostGate.raiseBase(ms)` if not present (`raiseHostFloor` exists; reuse it).
  - `src/db/schema.ts`: `crawls.platform`, `crawls.platform_profile_jsonb`, migration **0024**.
  - `src/api/service.ts`: the engine config `platformProfiles?: boolean` (default true; not an API input, the same closed-allowlist ruling as `maxBlockedUrls`), plus `crawl_status.platform` and `.platformProfile`.
  - `src/crawl/render/run-render.ts`: `renderConcurrency := 1` and navigation timeout 60 s when the crawl's profile says so.
- Tests: `test/crawl/platform.test.ts` (new), `test/crawl/loop.test.ts`, `test/api/*`.

**Interfaces produced:**
- `detectPlatform(headers: Headers | Record<string, string | string[] | undefined>): "shopify" | null`.
- `PLATFORM_PROFILES: Record<"shopify", { maxConcurrency: 1; minPerHostDelayMs: 1000; renderConcurrency: 1; navigationTimeoutMs: 60000 }>`.
- `platform_profile_jsonb` holds `{ platform, applied: { maxConcurrency, perHostDelayMs, renderConcurrency, navigationTimeoutMs }, appliedAt: ISO string, optedOut: boolean }`.

- [ ] Failing tests:
  - `detectPlatform` returns shopify on `powered-by: Shopify` (case-insensitive), on `x-shopify-stage`, and on `x-shopify-perf-experiments`; null on none.
  - A fixture origin that sends `powered-by: Shopify` → crawl_status shows platform shopify, applied concurrency 1, delay ≥ 1000, and at most 1 request in flight (count concurrent requests at the fixture server).
  - A caller config slower than the profile (delay 3000) stays 3000.
  - `platformProfiles: false` → no clamp, and `optedOut: true` is recorded.
  - A non-Shopify fixture → `platform` null, no clamp (Review Focus 3).
- [ ] `npm run db:generate` → 0024; `npm run db:migrate`.
- [ ] Implement → focused → full suite + tsc.
- [ ] Commit: `feat(crawl): platform profile — Shopify crawls at 1 thread, ≥1 s/host, detected from response headers`.

### Task 4: Render pass under the same pacing

**Files:** `src/crawl/render/renderer.ts` and `src/crawl/render/run-render.ts`; tests in `test/crawl/renderer.test.ts` (real Chromium) and `test/crawl/render-*.test.ts`.

**Consumes:** Task 1's `HostGate.restore` (to seed from `crawls.host_spacing_jsonb`); Task 3's profile (render concurrency and timeout).

**Behaviour:**
1. `PageRenderer` takes an optional seeded gate state. `run-render.ts` passes the crawl's persisted per-host state.
2. The route handler calls `await gate.acquire(host)` before `route.continue()` for every same-origin request it lets through (document, script, stylesheet, xhr, fetch). It reports each response's outcome into the gate (`page.on("response")` → `gate.report`), so a subresource 429 escalates the host and counts. Paint-only and third-party requests stay aborted and unpaced.
3. One `BrowserContext` per render worker, reused across URLs. Between URLs: `context.clearCookies()`, clear permissions, and clear origin storage (navigate a blank same-origin page and run `localStorage.clear(); sessionStorage.clear(); indexedDB` databases deleted, or use CDP `Storage.clearDataForOrigin` with `storageTypes: "cookies,local_storage,session_storage,indexeddb,service_workers,cache_storage"`). The HTTP disk cache is kept. Decide which method and argue it; CDP is preferred if it does not clear the HTTP cache.
4. Navigation timeout from the profile (60 s) when set. A render that times out reports `render_error: "timeout under pacing (<n> requests paced)"`.
5. The renderer's own `effectiveDelayMs` and its docblock are updated: the "residual burst" paragraph is replaced by the paced design.

- [ ] Failing tests (real Chromium against the fixture server):
  - A page with 6 same-origin scripts and spacing 300 ms → the fixture's request log shows consecutive same-origin request starts ≥ 300 ms apart (tolerance 20 ms) (Review Focus 5).
  - Two renders of pages sharing one script → the script is requested once (cache kept).
  - Page A sets a cookie and `localStorage.x`; page B, rendered next in the same worker, sees neither (Review Focus 4).
  - A page whose assets cannot all load inside a 2 s test timeout under pacing → `render_error` starting `timeout under pacing` (Review Focus 5).
  - A subresource 429 → the gate escalates and `responses429` is 1.
  - A seeded gate at 4000 ms → the first render waits on it.
- [ ] Implement → focused → full suite + tsc (renderer tests need Chromium; it is installed).
- [ ] Commit: `feat(render): every same-origin request paced by the crawl's earned spacing; HTTP cache shared, state cleared per page`.

### Task 5: Gate, docs, skills

**Files:** `docs/gates/phase-24a.md`, `docs/talos-surface.md` ("What Phase 24a changed here"), `skills/ariadne-crawl/SKILL.md`, and `docs/talos-integration.md` (the politeness obligation 4 paragraph gains the recovery and profile).

- [ ] **Gate run on lavishalice** (owner's reference site; `https://lavishalice.com/`): maxPages 600, render on, API defaults otherwise (concurrency 16 configured, so the profile must clamp it). Record:
  - platform and applied profile;
  - pages = 600 and `frontier_capped`;
  - the throttle record;
  - wall time vs `crawl_eda91d81`'s 20 m 44 s;
  - render count, errors, and same-origin render requests (from the gate's own counters or a log);
  - peak RSS;
  - one AriadneBot `curl` to `/` 60 s after the run, which must be 200.
  - If it is 429, the gate FAILS and records it. Do not retry in a loop.
- [ ] Keep or retune `RECOVERY_STREAK` from the throttle record and write the reason. A change re-runs Task 1's tests.
- [ ] Full suite + tsc + tree clean; numbers recorded (tests/files, migrations 0000–0024, ruleset 0.18.0 unchanged).
- [ ] Update the auto-memory handoff after the commit.
- [ ] Commit: `docs: phase-24a gate`. Integration on the owner's word (the last phase was a direct push to main).

## After 24a (outline, each its own plan)

- **Phase 24b, graph and international depth:**
  - hreflang from the HTTP `Link` header and sitemap `xhtml:link`, plus the hreflang checks SF has;
  - link-graph quality (dead ends, nofollow-only, anchors, localhost, high outlinks);
  - uncrawlable links;
  - rendered links stored;
  - sitemap protocol limits;
  - canonical hygiene;
  - pagination integrity.
- **Phase 25, signals and calibration:**
  - the priority axis;
  - external links;
  - mixed content;
  - pixel widths;
  - the black-box calibration;
  - mobile render;
  - the 50k memory measurement once yellow.com.mt allowlists us.

# Phase 13: The Closures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what two phases of honest ledgering left open: the suite's crawl-row leak (with the end-to-end robots-split test that waited on it), the all-unknown-crawl silence (the one owner-promotable judgement call — this plan promotes it), per-host earned spacing (migration 0015), and the two structural chores (the `ran|none` vocabulary, the registry-derived marker lists).

**Architecture:** Five tasks in dependency order. T1 fixes the leak at its sources and re-pins the figure, then writes the end-to-end robots-split test the old figure blocked (pointer 9's own sequencing note). T2 promotes pointer 1: `resources.all-unknown`, the third and last resource marker (ruleset 0.10.0). T3 is the phase's one schema event: migration 0015's per-host earned-spacing map, read at resume so a multi-host crawl stops paying the worst host's price everywhere. T4 does the two chores that make future markers and vocabularies cheaper. T5 gates on fixtures — no site contact.

**Tech Stack:** TypeScript strict/ESM, drizzle migration 0015, Postgres 16, vitest, both transports.

**Spec authority:** `docs/gates/phase-12.md` §10 (the nine pointers, with pointers 7 and 8 owner-ruled standing and NOT in scope); the guards and doctrines as they stand.

**Owner direction (2026-09-02):** "do the cleanup and ledger" — the §10 ledger is the scope. **This plan PROMOTES pointer 1** (the all-unknown marker — §10 calls it the one judgement call; the owner sees this promotion at plan presentation and can veto before T2 dispatches).

## Global Constraints

- CLAUDE.md hard rules 1–10. Baseline: branch `worktree-phase-13`, base `6f883a9` (main, Phases 0–12). **1,765 tests / 71 files green (~130s), tsc clean, migrations 0000–0014, ruleset 0.9.0, 93 rules, 83 checks.**
- The four kept crawl rows (three lavishalice + `crawl_f0fc5096`) are read-only; the ~2,900 leaked test rows are NOT (T1's sweep deletes them under the established delete-with-record rule).
- Migration 0015 is the phase's ONE schema event (T3). Ruleset bumps once, in T2: **0.9.0 → 0.10.0**.
- Every surface change: both transports, description pins both layers, grow-lists, citation-guard discipline. `DATABASE_URL` must be exported for the suite (a line this brief carries per the P12-T5 lesson).
- Conventional commits ending:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Stop the leak, sweep the residue, write the waiting test

**Files:** the leaking test files (find them — the leak is 33 rows/full run, measured five times; instrument or read the fixtures to name every leaker); a shared test helper if one is warranted; `test/crawl/` or `test/api/` for the new end-to-end case; `docs/talos-surface.md` §13's leak sentence.

**Steps:**
- [ ] **Step 1: name the leakers.** Count crawls before/after each suite FILE (or grep every `crawl_start`/`seedCrawl`/`runCrawl` site against its cleanup) until the 33 are attributed file by file. Record the table in your report.
- [ ] **Step 2: fix at the source** — each leaker tracks and deletes its crawls (the house `createdCrawls` pattern); a shared helper only if three-plus files want the same shape. NO global blanket teardown (a delete-matching-a-pattern teardown is the silent-fallback shape — rule 7; each file owns its rows).
- [ ] **Step 3: the one-time residue sweep** — delete the leaked historical rows (127.0.0.1/runner.example test hosts ONLY; the four kept lavishalice rows untouched, verified before AND after by fingerprint), with the before/after record (count, bytes) for the gate doc. The established delete-with-record rule (P10's crawl deletion is the precedent).
- [ ] **Step 4: re-pin the figure** — a full suite run now leaves ZERO rows (or the small honest number that remains, named); `talos-surface.md` §13's sentence updates to the new truth with the history (31 → 33 → now).
- [ ] **Step 5: the end-to-end robots-split test** (pointer 9) — run the real fetch pass against the two robots fixtures (forbidding + connection-resetting hosts), then assert the SERVED `robotsDenied`/`robotsUnreachable` counts off that same crawl through `crawl_status` — retiring phase-12.md §2.2's hand-made join. The test tracks its crawl (no new leak). Note in the gate doc that §2.2's ledgered seam is closed.
- [ ] Full suite + tsc green ×2 (the leak claim needs two runs); commit(s).

### Task 2: The last marker — `resources.all-unknown` (ruleset 0.10.0)

**Files:** `src/rules/query/resources.ts`; registry/copy; `skills/ariadne-audit/checklist.md`; the guards' lists (until T4 derives them, pay the three-edit toll one last time and say so).

**Interfaces:**
- `resources.all-unknown` (info): fires when the crawl asked (or tried) and EVERY resource row landed in an unknown class (`refused` / `robots_denied` / `robots_unreachable` / `fetch_error`) — zero `ok` rows with seen > 0 and zero unfetched rows. The six judging rules are silent on such a crawl with nothing to explain it (phase-12.md §10.1's exact shape). Evidence: the class census (per-class counts), the dominant class named. Copy voice: the crawl asked and the site (or its CDN posture) answered nothing usable — a limit of this crawl's evidence, not a clean bill; the discriminator (`crawl_status.resources`) named.
- Mutual exclusivity with BOTH siblings by construction (not-recorded: seen==0; not-fetched: unfetched==seen; all-unknown: decided==seen && ok==0) — one test drives all three boundaries.
- checkIds: the judging family's CHECK-48/49/50/51 (the marker guard forces the entries).
- **RULESET 0.9.0 → 0.10.0**, rationale naming the new rule (and any copy this task changes).
- The docblock/checklist window-statements from P12-T2's fix round UPDATE: the window is now closed — say so where it was stated (docblock, §5.3, the five checklist places).

**Steps:** red-first per boundary; partial-unknown crawls (some ok rows) still correctly silent (the judging rules' unknown-buckets carry those); coverage arithmetic honest (94 rules, query 54); suite + tsc; commit.

### Task 3: Migration 0015 — per-host earned spacing

**Files:** `src/db/schema.ts` + generated `drizzle/0015_*.sql`; `src/crawl/politeness.ts` (per-host export at close); `src/crawl/loop.ts` (write at close, read at resume); `src/crawl/render/run-render.ts` if renderPaceMs benefits (read it — decide, record); `src/api/service.ts` (crawl_status surfaces it if cheap — decide, record); tests.

**Interfaces:**
- `crawls.host_spacing_jsonb: jsonb` (nullable; null = pre-0015) — `{host: earnedMs}` written at crawl close from the gate's per-host high-water marks (a `maxSpacingMsByHost()` the gate must grow — per-host state already exists in `HostState`); the per-crawl `host_spacing_ms` column STAYS (the widest — the fallback for pre-0015 rows and the contract's existing consumer).
- Resume reads the map: each host re-enters ITS earned spacing (falling back to the crawl-wide value for hosts not in the map, then the config floor); the fold arithmetic keeps the T3-P12 pairings (config floor, robots, cap — all still win where they won).
- The three named-in-tree Phase-13-candidate comments update to the delivered truth.
- NO backfill (pre-0015 rows: the crawl-wide fallback is the honest degradation — say so on the column).

**Steps:** red-first (a two-host crawl earning different spacings resumes each at its own; a pre-0015-shaped row falls back to the wide value; the crown-test pattern extended one host); migration line-by-line + applied over the kept rows (null ×4, nothing else moved); suite + tsc; commit.

### Task 4: The two chores

**Files:** `src/rules/metric/render-metrics.ts` + consumers (the `ran|none` constants); `src/rules/registry/` + `test/skills/identifier-guard.test.ts` (the registry flag).

- **Pointer 3**: `RENDER_PASS_EVIDENCE = {ran: "ran", none: "none"}` (or the house const shape) — every literal site converted (the metric, the pins, any copy interpolation); the value strings unchanged (no wire change).
- **Pointer 4**: a `marker: true` flag (or `notMeasured: true`) on the rule definitions; the marker guard's `MARKERS` map DERIVES from the registry (the hand-written map deleted; the per-marker reason strings move onto the definitions); CHECK-83's family list either derives at test time (assert the checklist names every flagged rule) or stays prose with the guard asserting its completeness — implementer designs, argues, and the fourth marker (T2's) must cost ONE edit, proven by the diff shape.
- Suite + tsc; commit.

### Task 5: The gate — fixtures only

1. **The leak**: two full suite runs, zero (or the named honest number) rows left; the residue sweep's before/after record; the four kept rows fingerprinted unchanged through everything.
2. **The marker family complete**: three markers, three-way exclusivity test cited green; the closed-window statements verified updated everywhere the window was stated.
3. **0015 rehearsal**: kept rows null ×4; the two-host resume test green; the pre-0015 fallback proven.
4. **The chores hold**: the vocabulary grep (no bare ran/none literals); the derived marker list (the one-edit proof quoted).
5. Full suite + tsc + tree + kept rows; the end-to-end robots-split test cited as §2.2's closure.
Gate record: `docs/gates/phase-13.md`, provenance discipline absolute; CI placeholder (PR #12); Phase 14 pointers (whatever remains: pointers 7/8 standing as ruled; anything new).

## Explicitly out of scope

Tenancy (owner-ruled standing); wall-time designs (owner-ruled not-taken); any client-site crawling; Talos-side work.

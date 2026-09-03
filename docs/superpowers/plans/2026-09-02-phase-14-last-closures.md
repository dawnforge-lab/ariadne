# Phase 14: The Last Closures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last two engine-side residuals the ledger still carries — the partial-unknown marker gap (rule 1's final uncovered silence) and the synthetic-seed test-framing note — and record the one remaining behaviour pointer (`robots_unreachable` retry) as a decision rather than leaving it dangling. After this the `docs/gates/phase-13.md` §8 ledger has nothing left but the two owner-ruled standing items.

**Architecture:** Three tasks. T1 closes the partial-unknown window — the marker family's last gap, a fourth firing case for `resources.not-fetched` OR a fourth marker, decided in-task on the same honesty grammar the family already uses (ruleset 0.10.0 → 0.11.0 IF a new verdict lands; a widened existing rule is also a verdict change — the reviewer weighs which). T2 builds the two-host fixture that lets the P13-T3 resume test assert per-host divergence with two literally distinct gate hosts, retiring the synthetic crawl-wide seed. T3 is the gate + the recorded `robots_unreachable`-retry decision (proposed NOT-TAKEN — see below) + the honest note that the engine backlog is now clear.

**Tech Stack:** TypeScript strict/ESM, Postgres 16, vitest, both transports. No migration expected (T1 is a rule; T2 is a fixture) — if T1 needs one it is the phase's one schema event and the plan's no-migration default is overridden with the argument.

**Spec authority:** `docs/gates/phase-13.md` §8 (the five pointers; 4 and 5 owner-ruled standing, OUT of scope); the marker family's construction (three resource markers, the registry `marker?:string` flag, the bijection guard).

**Owner direction (2026-09-02):** "cleanup and phase 14 ledger" — the §8 ledger is the scope. **This plan PROPOSES a decision on pointer 2** (`robots_unreachable` retry): NOT taken. The owner sees it at plan presentation and rules at integration, the way the wall-time and tenancy decisions were handled.

**Proposed decision on pointer 2 (robots_unreachable retry) — NOT TAKEN, revisit on demand:** `fetchRobots` already retries with backoff *before* declaring a host unreachable, so an `unreachable` classification is not one flaky request — it is a host that stayed down across the robots fetch's own retries. Re-asking it later in the same crawl spends more requests on a host that just failed, for the chance it recovered mid-crawl; a fresh crawl re-asks cleanly. This is the same politeness-posture-toward-sites judgement as the wall-time question, and it should only be built if a real deployment shows unreachable-then-recovered hosts are common. T3 records the decision in the gate doc; if the owner vetoes, it becomes a Phase 15 task (a retry budget on the resource pass, its own politeness argument).

## Global Constraints

- CLAUDE.md hard rules 1–10 (rule 1 is T1's whole theme — a silence a reader could misread as clean). Baseline: branch `worktree-phase-14`, base `b74493e` (main, Phases 0–13). **1,787 tests / 71 files green (~107s), tsc clean, migrations 0000–0015, ruleset 0.10.0, 94 rules, 83 checks.**
- The four kept lavishalice crawl rows are read-only. The suite leaves zero net crawl rows (P13-T1) — every new test tracks its crawls (the house `createdCrawls` pattern); a task that reintroduces a leaker is a defect in that task.
- Ruleset bumps AT MOST once, in T1, and only if a verdict changes (a new marker, or a widened firing condition — both are verdict changes; the reviewer confirms the bump is earned). If T1 lands as pure evidence with no verdict change, 0.10.0 holds.
- Every surface/rule change: both transports where it surfaces, description pins both layers, the marker/citation/copy guards green, grow-lists honoured. `DATABASE_URL` exported for the suite.
- Conventional commits ending:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Close the partial-unknown window

**Files:** `src/rules/query/resources.ts`; registry/copy; `skills/ariadne-audit/checklist.md`; the guards' derived lists (the `marker?:string` flag makes a new marker one declaration — T4-P13's whole point; use it); tests.

**The gap (phase-13.md §8 pointer 1):** a partial pass carrying only `null` (unweighed) rows and decided-unknown rows — no `ok` row and no broken row — fires none of the three markers. `not-recorded` needs `seen==0`; `not-fetched` needs *every* row null; `all-unknown` needs *every* row a decided unknown; the judging rules' `unknownResources` buckets need an `ok` row to ride on, and there is none. Six rules go quiet with nothing to explain the silence — the §10.1-window shape, one layer in.

**The decision this task makes (argue it, record it):** either
- (a) **widen `resources.not-fetched`** — its "the crawl asked about none of them" premise already covers "no usable answer"; a mixed null+unknown pass with no ok/broken row is a pass that produced no judgeable resource, and `not-fetched`'s three reasons could gain a fourth ("mixed — some unasked, some only-unknown-answers"); OR
- (b) **a fourth marker** `resources.no-judgeable` (or similar) — if widening `not-fetched` blurs its clean "asked about NONE" meaning (a partial pass DID ask about some).

The implementer picks, arguing which keeps each marker's meaning sharp; the reviewer weighs. Whichever lands: mutual exclusivity with the other markers stays construction-level (one test drives every boundary, no crawl shape fires two); the judging rules stay silent on that shape (they cannot speak — that is the gap); the checklist entries update via the guard; the closure statements (docblock, §5.3, checklist) name the new coverage.

**Ruleset:** a new marker or a widened firing condition is a verdict change → **0.10.0 → 0.11.0**, rationale named. (If the implementer finds a way to close it with NO verdict change — unlikely — the reviewer confirms and 0.10.0 holds.)

**Steps:** red-first — construct the exact shape (a fixture crawl with only null + decided-unknown resource rows, no ok/broken); assert the chosen rule now fires with honest evidence and the other two markers do not; the full boundary matrix (all the P13 shapes plus this one) in one exclusivity test; coverage arithmetic honest; suite + tsc; commit.

### Task 2: The two-host fixture — retire the synthetic seed

**Files:** the fixture/harness that P13-T3's resume tests use (`test/crawl/loop.test.ts` + its fixture server); the resume test itself (assert per-host divergence with two real gate hosts).

**The note (phase-13.md §8 pointer 3):** the mid-crawl re-persist / per-host resume tests use a synthetic crawl-wide seed (`host_spacing_jsonb: {origin: N}`) standing in for a second host, because the fixture crawl is single-origin. A fixture crawl that genuinely visits two distinct gate hosts lets the test assert the divergence — host A resumes at its earned spacing, host B at its own, neither at the other's — without the stand-in.

**Steps:** extend the fixture to a two-host crawl (a second listener, the P11 asset-host pattern is the precedent — a crawl whose links cross to a second host so both get gate state); rewrite the resume test to earn different spacings on the two real hosts and assert each re-enters its own (the synthetic-seed test can stay as a unit-level companion or be replaced — implementer decides, records); the §3 gate-doc framing note (phase-13.md) is historical and NOT edited — this closes the pointer going forward. No ruleset/schema change. Suite + tsc; commit.

### Task 3: The gate + the recorded decision + the clear-ledger note

**Files:** `docs/gates/phase-14.md`; `docs/talos-surface.md` (a "What Phase 14 changed here" block if T1 surfaced anything; the marker count if T1 added one); no code beyond what T1/T2 shipped.

**Steps:**
- [ ] **The gate**, fixtures only: T1's new marker/coverage fires on its exact shape and the exclusivity matrix holds (cited green); T2's two-host resume asserts per-host divergence with real hosts (cited green); the four kept rows unchanged; the suite leaves zero net crawl rows (the P13-T1 discipline held — count before/after); full suite + tsc + tree.
- [ ] **The recorded decision** on `robots_unreachable` retry — NOT TAKEN with the argument (fetchRobots already retries pre-classification; re-asking spends requests on a just-failed host; revisit on demand), stated as PROPOSED-AND-UNVETOED until integration (the P12/P13 wording discipline: not "the owner's reasoning" until ruled).
- [ ] **The clear-ledger note:** phase-14.md §"What Phase 15 inherits" records that the engine-side ledger is now EMPTY of chores — only the two owner-ruled standing items (tenancy, wall-time) and the robots-retry decision remain, all revisit-on-demand. The honest statement that the crawl+audit engine has paid every debt it accrued through fourteen phases, and the next work is new direction (Talos-side build, new resource classes, new checks) rather than closure.
- [ ] CI placeholder (PR #13); commit.

## Explicitly out of scope

Tenancy and wall-time (owner-ruled standing); `robots_unreachable` retry (proposed not-taken); any client-site crawling; Talos-side work; any new audit direction (that is a fresh brainstorm, not a closure).

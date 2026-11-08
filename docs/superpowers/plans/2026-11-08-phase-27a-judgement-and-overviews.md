# Phase 27a: Judgement and overviews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every finding rule a default issue type and priority beside severity. Let an agent disable, retype or reprioritise rules per crawl, effective at read time, and override a set of thresholds, effective at the next rules run. Ship the Issues Overview and the Crawl Overview as JSON and CSV. Ruleset 0.23.0, two migrations, no new rules.

**Architecture:**
- **Type and priority are registry data.** One table, `src/rules/registry/triage.ts`, holds them. `defineRule` attaches them to every page and query rule, and they are never stored per finding.
- **A crawl's judgement block lives in a new `crawls.judgement_jsonb`.** It holds the disabled, retyped and reprioritised rules and the threshold overrides. `findingCap` is part of the block's API but stays stored where it is today, in `config_jsonb` (Deviation 1).
- **Rules get thresholds from a per-run `JudgementContext`.** It is passed down the call stack exactly as `RuleCaps` is, never module state.
- **The run stamps what it used.** Each rules run stamps the inputs it used (disabled set, threshold overrides, `findingCap`) in `crawls.rules_judged_with_jsonb`. Readers compare that stamp with the current block to report `judgementStale`.
- **Read surfaces apply the block at read time** through one loader, `src/api/judgement-view.ts`. The overviews are new bounded `GROUP BY` queries in `src/api/overview.ts`.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16, drizzle-orm + drizzle-kit, zod 4 (already a dependency), vitest, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md`, the "27a — Judgement and overviews" section and "Gate 27a" (owner-approved 2026-11-08). Read it before any task. 27b and 27c are later plans.

## Global Constraints

- **Rules:**
  - CLAUDE.md hard rules 1–10, and the user rule: no fallbacks.
  - **Rule 3:** every overview and every override filter is SQL. Nothing loads `issues`, `links` or `pages` into memory.
  - **Rule 7:** a malformed stored judgement block, or a stamp missing on a judged crawl, throws and names the crawl. It is never read as "no overrides".
- **Baseline:**
  - `main` @ `bc9ce32` (PR #24 merge), branch `worktree-phase-27` @ `cf85718` (design).
  - Ruleset 0.22.0, **188 rules**: 72 page / 102 query / 14 metric; 33 critical / 66 warning / 89 info; 16 markers.
  - Migrations 0000–0030. **122 files / 3,495 tests green** (`DATABASE_URL` set).
- **Rule counts do not change.** 27a adds no rule.
- **Ruleset 0.22.0 → 0.23.0** once, in Task 1. The version note is built up task by task (`// 0.23.0: Phase 27a, …`, items `(Tn)`), and its last item re-measures `rules_catalog` bytes, as 26c's did.
- **Migrations** (Deviation 2):
  - **`0031`** (schema, drizzle-kit generated via `npm run db:generate`) adds the nullable `crawls.judgement_jsonb` and `crawls.rules_judged_with_jsonb`.
  - **`0032`** (data, `drizzle-kit generate --custom`) backfills the stamp on every crawl with `rules_run_at` not null.
  - Both are in Task 2 and applied with `npm run db:migrate`. Never hand-apply SQL.
- **Exact vocabulary:**
  - `IssueType = "issue" | "warning" | "opportunity"`;
  - `Priority = "high" | "medium" | "low"`;
  - stale reasons `"overrides" | "thresholds" | "findingCap"`.
- **The overridable thresholds are exactly these 19.** The range is inclusive, the value an integer, and the default is the current constant in `src/rules/thresholds.ts`:

  | Name | Range | Name | Range |
  |---|---|---|---|
  | `TITLE_MIN` | 1–200 | `TITLE_MAX` | 1–300 |
  | `META_MIN` | 1–300 | `META_MAX` | 1–500 |
  | `H1_MAX` | 1–300 | `H2_MAX` | 1–300 |
  | `URL_MAX` | 20–2500 | `SLOW_MS` | 100–60000 |
  | `TITLE_PX_MIN` | 1–2000 | `TITLE_PX_MAX` | 1–2000 |
  | `META_PX_MIN` | 1–4000 | `META_PX_MAX` | 1–4000 |
  | `DEEP_DEPTH` | 1–100 | `THIN_WORDS` | 1–10000 |
  | `SOFT_404_WORDS` | 1–10000 | `IMAGE_WEIGHT_WARN` | 1000–100000000 |
  | `CHAIN_HOPS` | 1–9 | `HIGH_INTERNAL_OUTLINKS` | 1–100000 |
  | `HIGH_EXTERNAL_OUTLINKS` | 1–100000 | `UNAVAILABLE_AFTER_WARN_DAYS` | 0–3650 |

  On effective values (default merged with override), the minimum must be strictly below the maximum for each pair:
  - `TITLE_MIN` and `TITLE_MAX`;
  - `META_MIN` and `META_MAX`;
  - `TITLE_PX_MIN` and `TITLE_PX_MAX`;
  - `META_PX_MIN` and `META_PX_MAX`.

  `CHAIN_HOPS` stays below `MAX_REDIRECT_HOPS` (10), which the range guarantees.
- **Markers are `warning` / `low`.** `defineRule` refuses any other triage on a rule with `marker`. Metric rules have no `type` or `priority`, and `defineRule` refuses them.
- **Severity is never overridable.** It is refused in the block with a path-named validation error.
- **Error codes:**
  - A refusal over the API is the existing `ServiceError` `"VALIDATION"` (400), with the offending path in the message.
  - A refusal because rules are running for the crawl is `"CONFLICT"` (409).
  - Disabled-rule listings are `"CONFLICT"` (Deviation 3).
- **Commits:** conventional, at least one per task. Each ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
  ```
  The controller updates the Serena memory `roadmap` after each task's commit.
- **Environment:** `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne` (container `ariadne-pg`). Chromium is installed. `tsc --noEmit` stays clean, and the full suite runs with 0 skipped.

## Deviations from the spec text (owner to see in review)

1. **`findingCap` stays stored in `config_jsonb.findingCap`.** The block exposes it as `judgement.findingCap`, so get and set read and write that one location. Moving the bytes would mean a data migration and a second `CrawlConfig` change, for no behaviour difference. `crawl_start`'s top-level `findingCap` is unchanged. Giving it both ways with different values is refused.
2. **Two migrations, `0031` and `0032`, where the spec named one.** The backfill is data and goes in its own custom migration, as `0030` did in 26c. 27b's `control_request` column therefore becomes `0033`.
3. **`issue_urls` and `issue_inlinks` refuse a disabled rule (409, "rule X is disabled on this crawl").** The spec says the findings "disappear". For a single-rule call, a refusal cannot be mistaken for "fired on nothing", which an empty page can.
4. **`crawl_config_get` / `crawl_config_set` arrive in 27a, limited to the `judgement` part.** The spec puts them in 27b. Without them an agent could not set an override in 27a. 27b widens them to `crawl` fields and adds the schema tools; the tool names and routes do not change.
5. **Crawl Overview response-time buckets are fixed:** under 250 ms, 250–500, 500–1000, 1000–2000 and 2000+. A separate `overSlowMs` count uses the stamped `SLOW_MS`. The spec's "1000–`SLOW_MS`" bucket breaks when `SLOW_MS` is overridden below 1000.
6. **`crawl_compare` reads stored findings, unfiltered.** It gains a caveat code `judgement-overrides` when either side has disabled rules. Comparing engine output across crawls is its job, and the caveat says that the dashboards may differ.

## Review Focus

1. **Two rules runs of two crawls with different threshold overrides at the same moment.** Each judges with its own thresholds: the `RuleCaps` concurrency precedent (Task 3 test).
2. **An agent disables a rule, re-runs the rules, then re-enables it.** The findings come back without another run, and `site.health` stays stale until the next run (Task 5 test; gate round-trip).
3. **A stored judgement block that is malformed, or names a rule a later ruleset removed.**
   - Malformed: `readStoredJudgement` throws, naming the crawl (Task 2 test).
   - A removed rule's override: `loadJudgementView` turns that into `CONFLICT`, naming the rule, exactly as a stored finding of a removed rule does today (Task 5 test).
   - It is never read as "no overrides".
4. **A threshold override at a bound** (`SLOW_MS` 100, `THIN_WORDS` 10000) and **a cross-pair violation** (`TITLE_MIN` 70 with `TITLE_MAX` default 60). The first is accepted, the second refused with both paths named (Task 2 test).
5. **Issues Overview on a crawl judged under 0.22.0** (the stored lavishalice crawl). Counts per rule equal `issues_list`, a rule id the current ruleset lacks raises `CONFLICT` as `issues_list` does, and markers are present (Task 8 test; gate).

---

### Task 0 (controller, no code): baseline

- [ ] Record the baseline in the ledger: `npx tsc --noEmit` clean, and `npm test` gives 122 files / 3,495 tests, 0 skipped.
- [ ] Find the stored lavishalice crawl in the dev DB for the gate: the newest `finished` crawl with site `https://lavishalice.com/`, judged. Record its id.
- [ ] Copy the Screaming Frog Issues Overview export from the 26a workspace into this plan's SDD workspace as `sf-issues-overview.csv`. The source is `.claude/worktrees/phase-26a/.superpowers/sdd/2026-11-05-phase-26a-rules-over-existing-data/sf-run/run-2026-11-06T12-21-52-752Z/sf/issues_overview_report_all.csv`: 351 rows, with columns `Issue Name, Issue Type, Issue Priority, URLs, % of Total, Description, How To Fix, Help URL`. It is black-box output, never committed, and never read for implementation guidance beyond the type and priority of a named issue.

---

### Task 1: Triage table, registry fields, ruleset 0.23.0

**Files:**
- Create: `src/rules/registry/triage.ts`
- Create: `scripts/triage-vs-sf.ts`
- Modify: `src/rules/registry/types.ts`
- Modify: `src/rules/registry/registry.ts`, which covers `defineRule` (:929), `RULESET_VERSION` (:893) and the version note
- Test: `test/rules/triage.test.ts`
- Test: `test/rules/registry.test.ts`, for the ruleset pin

**Interfaces:**
- Produces:
  - `export type IssueType = "issue" | "warning" | "opportunity"` and `export type Priority = "high" | "medium" | "low"`, both in `types.ts`.
  - `RuleMeta` gains `type?: IssueType; priority?: Priority`. `PageRule` and `QueryRule` narrow them to required, and `MetricRule` to `?: undefined`.
  - `export const TRIAGE: Readonly<Record<string, { type: IssueType; priority: Priority; sfIssue?: string }>>` and `export function triageFor(ruleId: string): { type: IssueType; priority: Priority }` in `triage.ts`. `triageFor` throws on a miss, naming the rule, as `copyFor` does.
  - `defineRule` sets `type` and `priority` from `triageFor` on page and query rules. It throws if a metric rule has a `TRIAGE` row, or a marker rule's row is not `warning` / `low`.

- [ ] **Step 1: Write the failing tests** in `test/rules/triage.test.ts`:

```ts
const RULES = buildRegistry().all();
it("gives every page and query rule a type and priority", () => {
  for (const r of RULES.filter((r) => r.kind !== "metric")) {
    expect(["issue", "warning", "opportunity"], r.id).toContain(r.type);
    expect(["high", "medium", "low"], r.id).toContain(r.priority);
  }
});
it("gives metric rules neither, and has no row for them", () => {
  for (const r of RULES.filter((r) => r.kind === "metric")) {
    expect(r.type, r.id).toBeUndefined();
    expect(r.priority, r.id).toBeUndefined();
    expect(TRIAGE[r.id], r.id).toBeUndefined();
  }
});
it("has no row for a rule the registry lacks", () => {
  const ids = new Set(RULES.map((r) => r.id));
  expect(Object.keys(TRIAGE).filter((id) => !ids.has(id))).toEqual([]);
});
it("files every marker as warning / low", () => {
  for (const r of RULES.filter((r) => r.marker !== undefined)) {
    expect([r.type, r.priority], r.id).toEqual(["warning", "low"]);
  }
});
it("refuses a metric rule with a triage row and a marker with other triage", () => {
  // defineRule on a synthetic metric rule whose id is in TRIAGE → throws /metric/;
  // on a synthetic marker rule whose id maps to issue/high → throws /marker/.
});
```

Also update the ruleset pin in `test/rules/registry.test.ts` to `"0.23.0"`.

- [ ] **Step 2:** Run `npx vitest run test/rules/triage.test.ts test/rules/registry.test.ts`. Expect FAIL: `triage.ts` does not exist.

- [ ] **Step 3: Write `triage.ts`.**
  - **Module header:** carries the rubric, verbatim from the spec:
    - Issue means a defect to fix.
    - Warning means a human must check it, because it may be fine.
    - Opportunity means nothing is broken, but changing it would help.
    - Priority is the expected effect of the fix on the pages hit:
      - high: crawled, indexed or served correctly;
      - medium: how they rank or appear;
      - low: hygiene.
  - **One row per page and query rule (172 rows)**, filled in by this process:
    1. **Pick the SF reference.** For each rule, find the Screaming Frog issue it corresponds to in the SDD workspace's `sf-issues-overview.csv` (Task 0). The mapping names in `scripts/calibrate-sf.ts` `SF_FILTERS` and `docs/gates/phase-26a-calibration.md` are the starting point. When it maps, record `sfIssue` as SF's exact `Issue Name`, and take that issue's `Issue Type` and `Issue Priority`, lower-cased.
    2. **Rules with no SF counterpart** are assigned from the rubric.
    3. **Disagreeing with SF.** Where the rubric disagrees with SF on a mapped rule, SF's value wins unless the rule's own semantics differ. In that case keep `sfIssue`, set our value, and add a `// differs from SF: <reason>` comment on the row.
    4. **Markers** are `warning` / `low`, with no `sfIssue`.
    - Rows are ordered by rule id.

- [ ] **Step 4: Wire it in.**
  - Add the type fields, and the `defineRule` attachment and checks.
  - Bump `RULESET_VERSION` to `"0.23.0"`. Open the version note with `// 0.23.0: Phase 27a — (T1) type and priority on every finding rule (triage.ts).`

- [ ] **Step 5: Write `scripts/triage-vs-sf.ts <csv path>`.** It loads the registry and the CSV and prints a Markdown table to stdout, with columns `rule | sfIssue | SF type/priority | ours | agrees`. The rows are every rule with an `sfIssue`, then a count line ("N mapped, M agree, K differ, U unmapped").
  - It throws if an `sfIssue` names an issue absent from the CSV.
  - It reads only the CSV path given, and is never run in CI.
  - Run it once against the workspace CSV, and save the output to the workspace as `triage-vs-sf.md`. The gate (Task 10) commits that table.

- [ ] **Step 6:** Run `npx vitest run test/rules` and `npx tsc --noEmit`. Expect PASS. Fix any pinned ruleset strings the bump breaks (search for `0.22.0` in `test/`).

- [ ] **Step 7: Commit:** `feat(rules): issue type and priority per finding rule; ruleset 0.23.0 (27a T1)`.

---

### Task 2: The judgement block — schema, storage, stamp

**Files:**
- Create: `src/rules/judgement.ts`
- Modify: `src/db/schema.ts` (`crawls`: `judgement: jsonb("judgement_jsonb")` and `rulesJudgedWith: jsonb("rules_judged_with_jsonb")`, both nullable, with a comment each)
- Create: `drizzle/0031_*.sql` (generated) and `drizzle/0032_rules_judged_with_backfill.sql` (custom)
- Modify: `src/rules/run.ts`, which reads the block, resolves caps from it, and stamps
- Test: `test/rules/judgement.test.ts`
- Test: `test/db/migration-0032.test.ts`

**Interfaces:**
- Consumes: `IssueType`, `Priority` (Task 1); `Registry` (`src/rules/registry/registry.ts`).
- Produces, from `src/rules/judgement.ts`:
  - `export const OVERRIDABLE_THRESHOLDS: Readonly<Record<ThresholdName, { min: number; max: number; default: number }>>`, the 19 rows of the Global Constraints table, with `default` imported from `thresholds.ts`. `export type ThresholdName` is the union of those keys, and `export type Thresholds = Readonly<Record<ThresholdName, number>>`.
  - `export const DEFAULT_THRESHOLDS: Thresholds`.
  - `export interface RuleOverride { disabled?: true; type?: IssueType; priority?: Priority }`.
  - `export interface JudgementBlock { rules?: Readonly<Record<string, RuleOverride>>; thresholds?: Readonly<Partial<Record<ThresholdName, number>>>; findingCap?: number | null }`.
  - `export class JudgementError extends Error { constructor(readonly path: string, message: string) }`.
  - `export function parseJudgement(raw: unknown, registry: Registry): JudgementBlock`. This is zod 4, strict at every level.
    - **Refused:** unknown keys, `severity`, an unknown rule id, a metric rule id, an empty `RuleOverride`, `disabled: false` (absence means enabled), an out-of-range or non-integer threshold, a crossed pair, and a `findingCap` that is not a positive integer or null.
    - **Errors:** each one is thrown as `JudgementError` with a dotted path, for example `rules.title.too-long.severity` or `thresholds.TITLE_MIN`.
  - `export function effectiveThresholds(block: JudgementBlock | null): Thresholds`.
  - `export interface JudgedWith { disabledRules: string[]; thresholds: Partial<Record<ThresholdName, number>>; findingCap?: number | null }`. `disabledRules` is sorted ascending, and `findingCap` is absent when the engine default applies.
  - `export function judgedWithOf(block: JudgementBlock | null, findingCap: number | null | undefined): JudgedWith`.
  - `export type StaleReason = "overrides" | "thresholds" | "findingCap"`.
  - `export function staleReasons(current: JudgedWith, stamped: JudgedWith): StaleReason[]`. The reasons are sorted, and the result is empty when nothing differs. Retyping and reprioritising are not inputs.
  - `export function readStoredJudgement(raw: unknown, crawlId: string, registry: Registry): JudgementBlock | null`. Null stays null; anything else goes through `parseJudgement`, re-thrown with the crawl id.
  - `export function readStamp(raw: unknown, crawlId: string): JudgedWith`. It validates the stamp's shape and throws on null; callers only call it when `rules_run_at` is not null.
- Produces, in `run.ts`: `runRules` reads `crawls.judgement` and `crawls.config`, then:
  - **Caps:** they come from `opts.findingCap`, else from the stored `config.findingCap`, as today.
  - **Context:** it builds a `JudgementContext` (Task 3 uses it; in this task it is constructed and passed nowhere yet).
  - **Stamp:** in the same `update` that sets `rulesRunAt`, it writes `rulesJudgedWith = judgedWithOf(block, capUsed)`. The transaction that nulls `rules_run_at` at the top also nulls `rules_judged_with_jsonb`.

- [ ] **Step 1: Write the failing tests** (`test/rules/judgement.test.ts`), each one an `it` with these assertions:
  - `parseJudgement({rules: {"title.too-long": {disabled: true, priority: "low"}}, thresholds: {SLOW_MS: 100, THIN_WORDS: 10000}, findingCap: null})` round-trips.
  - Each of these throws `JudgementError` with the given `path`:
    - `{rules: {"title.too-long": {severity: "info"}}}` → `rules.title.too-long.severity`
    - `{rules: {"nope.rule": {disabled: true}}}` → `rules.nope.rule`
    - `{rules: {"site.health": {disabled: true}}}` → `rules.site.health` (metric)
    - `{rules: {"title.too-long": {}}}` → `rules.title.too-long`
    - `{rules: {"title.too-long": {disabled: false}}}` → `rules.title.too-long.disabled`
    - `{thresholds: {SLOW_MS: 99}}` → `thresholds.SLOW_MS`
    - `{thresholds: {SLOW_MS: 1.5}}` → `thresholds.SLOW_MS`
    - `{thresholds: {NEAR_DUPLICATE_HAMMING: 4}}` → `thresholds.NEAR_DUPLICATE_HAMMING`
    - `{thresholds: {TITLE_MIN: 70}}` → message names both `TITLE_MIN` and `TITLE_MAX`
    - `{findingCap: 0}` → `findingCap`
    - `{extra: 1}` → `extra`
  - `effectiveThresholds(null)` deep-equals `DEFAULT_THRESHOLDS`, and `DEFAULT_THRESHOLDS.SLOW_MS === SLOW_MS` (spot-check three names against the constants).
  - `staleReasons`:
    - identical inputs give `[]`;
    - a changed disabled set gives `["overrides"]`;
    - changed thresholds and `findingCap` give `["findingCap", "thresholds"]`;
    - `findingCap` absent versus `null` gives `["findingCap"]`.
  - `readStoredJudgement({rules: {"gone.rule": {disabled: true}}}, "crawl_x", reg)` throws a message containing `crawl_x` and `gone.rule`.
  - A runRules integration on a tiny seeded crawl (copy the setup of `test/rules/finding-cap.test.ts`):
    - after a run, `rules_judged_with_jsonb` equals `judgedWithOf(block, cap)`;
    - while `rules_run_at` is null at the start of a run, the stamp is null too (assert after a run that throws mid-way, using a registry with a throwing rule).

- [ ] **Step 2:** Run `npx vitest run test/rules/judgement.test.ts`. Expect FAIL.

- [ ] **Step 3: Implement `judgement.ts`** and the `run.ts` stamp.

- [ ] **Step 4: Migrations.**
  - **0031:** add the columns to `schema.ts` and run `npm run db:generate`.
  - **0032:** run `npx drizzle-kit generate --custom --name rules_judged_with_backfill`, and write:

```sql
UPDATE crawls
SET rules_judged_with_jsonb =
  jsonb_build_object('disabledRules', '[]'::jsonb, 'thresholds', '{}'::jsonb)
  || CASE WHEN config_jsonb ? 'findingCap'
          THEN jsonb_build_object('findingCap', config_jsonb->'findingCap')
          ELSE '{}'::jsonb END
WHERE rules_run_at IS NOT NULL AND rules_judged_with_jsonb IS NULL;
```

  - **The test:** `test/db/migration-0032.test.ts` follows `test/db/migration-0017.test.ts`'s pattern. It covers:
    - a judged crawl with `findingCap: 200` gets `{disabledRules: [], thresholds: {}, findingCap: 200}`;
    - a judged crawl with `findingCap: null` keeps `findingCap: null`;
    - a judged crawl with no key gets no `findingCap` key;
    - an unjudged crawl stays null.

- [ ] **Step 5:** Run `npm run db:migrate`, then `npx vitest run test/rules test/db` and `npx tsc --noEmit`. Expect PASS.

- [ ] **Step 6: Commit:** `feat(rules): per-crawl judgement block, run stamp, migrations 0031-0032 (27a T2)`.

---

### Task 3: Rules read thresholds from the run's context; `site.health` skips disabled rules

**Files:**
- Modify: `src/rules/registry/types.ts`, which adds `JudgementContext` and the `run` signatures
- Modify: `src/rules/run.ts`, which passes the context
- Modify: the threshold consumers:
  - `src/rules/page/on-page.ts`
  - `src/rules/page/pixel-width.ts`
  - `src/rules/page/technical.ts`
  - `src/rules/page/directives.ts`
  - `src/rules/query/link-graph.ts`
  - `src/rules/query/content.ts`
  - `src/rules/query/resources.ts`
  - `src/rules/query/redirects.ts`
  - `src/rules/query/link-hygiene.ts`
- Modify: `src/rules/metric/health-metrics.ts` (`site.health`)
- Test: `test/rules/thresholds-override.test.ts`
- Test: `test/rules/threshold-guard.test.ts`

**Interfaces:**
- Consumes: `Thresholds`, `DEFAULT_THRESHOLDS`, `effectiveThresholds` (Task 2).
- Produces, in `types.ts`:
  - `export interface JudgementContext { thresholds: Thresholds; disabledRules: ReadonlySet<string> }`.
  - `export const DEFAULT_JUDGEMENT: JudgementContext`, with default thresholds and an empty set.
  - `export function judgementOr(ctx: JudgementContext | undefined): JudgementContext`, mirroring `capsOr`.
  - The signatures become:
    - `PageRule.run(page: PageRecord, ctx?: JudgementContext)`
    - `QueryRule.run(db, crawlId, caps?: RuleCaps, ctx?: JudgementContext)`
    - `MetricRule.run(db, crawlId, ctx?: JudgementContext)`
  - `runRules` always passes the resolved context.

- [ ] **Step 1: Write the failing tests.**
  - **`test/rules/thresholds-override.test.ts`, page rules** (built with the page fixture helper the on-page tests use). It is table-driven, one row per page-rule threshold. Each row has a page that does NOT fire under defaults and DOES fire under the override, and the reverse for a lowering override.
    - `TITLE_MAX`: a 55-character title fires `title.too-long` with `{TITLE_MAX: 50}`, and not at defaults.
    - The same pattern covers:
      - `TITLE_MIN`, `META_MIN`, `META_MAX`, `H1_MAX`, `H2_MAX`, `URL_MAX`;
      - `TITLE_PX_MIN` / `MAX`, `META_PX_MIN` / `MAX`;
      - `SLOW_MS`, `THIN_WORDS` (on-page), `UNAVAILABLE_AFTER_WARN_DAYS`.
    - Every finding that carries a `threshold`-style evidence key carries the override's value.
  - **Query rules** (seeded crawl, as in each rule's own test file):
    - `DEEP_DEPTH`: a depth-4 page fires `structure.deep-page` with `{DEEP_DEPTH: 3}`.
    - `THIN_WORDS` (`content.thin`), `SOFT_404_WORDS`, `IMAGE_WEIGHT_WARN`, `CHAIN_HOPS`, `HIGH_INTERNAL_OUTLINKS` and `HIGH_EXTERNAL_OUTLINKS` each get one case the same way.
  - **Concurrency:** two `runRules` calls over two seeded crawls, started together with `Promise.all`, with `{TITLE_MAX: 50}` and `{TITLE_MAX: 70}` set as each crawl's stored block. Each crawl's `title.too-long` findings match its own threshold (copy the shape of the finding-cap concurrency test).
  - **`site.health`:** a crawl whose only findings come from `title.too-long`, with that rule disabled in the stored block. After `runRules`, `site.health`'s `urlsClean` counts those pages as clean, while the `issues` table still holds the `title.too-long` rows.
  - **`test/rules/threshold-guard.test.ts`:** reads every `.ts` under `src/rules/page`, `src/rules/query` and `src/rules/metric`. It asserts that no overridable threshold name (the keys of `OVERRIDABLE_THRESHOLDS`) appears except on an `export { … } from` re-export line. A rule that keeps importing the constant would silently ignore overrides.

- [ ] **Step 2:** Run `npx vitest run test/rules/thresholds-override.test.ts test/rules/threshold-guard.test.ts`. Expect FAIL.

- [ ] **Step 3: Implement.** Every consumer reads `judgementOr(ctx).thresholds.NAME`, and query rules take `ctx` as the fourth parameter. `site.health`'s `worst` CTE adds `and not (i.rule_id = any(${[...disabledRules]}::text[]))`. It uses the `= any(…::text[])` form with an explicit array cast, because drizzle spreads bare arrays (see the comment in `service.ts` `listIssues`). Pass an empty array as `'{}'::text[]`.

- [ ] **Step 4:** Run `npx vitest run test/rules` and `npx tsc --noEmit`. Expect PASS, with every existing rule test unchanged.

- [ ] **Step 5: Commit:** `feat(rules): thresholds and disabled set reach rules through JudgementContext (27a T3)`.

---

### Task 4: Copy rendered from the thresholds a crawl was judged with

**Files:**
- Modify: `src/rules/registry/copy/issue-copy.ts`, adding placeholders and a header note
- Modify: `src/rules/registry/copy/index.ts`
- Test: `test/rules/copy-render.test.ts`, plus the existing `test/rules/copy.test.ts`, which must stay green unchanged

**Interfaces:**
- Consumes: `Thresholds`, `DEFAULT_THRESHOLDS`, `ThresholdName` (Task 2).
- Produces:
  - `export function renderCopy(ruleId: string, thresholds: Thresholds): IssueCopy`. It substitutes `{NAME}` with `String(value)` and `{NAME:n}` with `value.toLocaleString("en-US")`, and throws on an unknown placeholder name or one left over.
  - `copyFor(ruleId)` becomes `renderCopy(ruleId, DEFAULT_THRESHOLDS)`.
  - `export const COPY_TEMPLATES: Record<string, IssueCopy>` holds the raw entries (today's `ISSUE_COPY`). `ISSUE_COPY` stays exported, as the default rendering, so existing imports keep working.

- [ ] **Step 1: Write the failing tests** (`copy-render.test.ts`):
  - **Defaults reproduce today's copy.** The default rendering of every entry equals the text committed before this task: capture today's `ISSUE_COPY` into `test/rules/__fixtures__/issue-copy-0.22.json` in this step, before editing the copy.
  - **Every placeholder in `COPY_TEMPLATES`** names a key of `OVERRIDABLE_THRESHOLDS`.
  - **Every numeric mention of an overridable threshold's default** in the 0.22 fixture is a placeholder in the template. Check each rule listed in `copy.test.ts`'s `THRESHOLD_IN_TITLE` whose number is an overridable threshold: `renderCopy(id, {...DEFAULT_THRESHOLDS, NAME: 7777}).title` contains `7777` (or `7,777` for `:n`).
  - **`renderCopy("title.too-long", {...DEFAULT_THRESHOLDS, TITLE_MAX: 50})`**: the explanation contains `50 characters` and not `60 characters`.
  - **`renderCopy` throws** on a template containing `{NOPE}`.

- [ ] **Step 2:** Run it. Expect FAIL.

- [ ] **Step 3: Convert the entries.** Change each entry quoting an overridable threshold to placeholders. Constants that are NOT overridable stay literal, still pinned by `copy.test.ts`.

- [ ] **Step 4:** Run `npx vitest run test/rules/copy-render.test.ts test/rules/copy.test.ts` and `npx tsc --noEmit`. Expect PASS.

- [ ] **Step 5: Commit:** `feat(rules): issue copy rendered from the judged thresholds (27a T4)`.

---

### Task 5: Read surfaces apply the judgement — issues, catalog, CSV, export

**Files:**
- Create: `src/api/judgement-view.ts`
- Modify: `src/api/service.ts`, covering `listIssues` (:3565), `listIssueUrls` (:3659), `listIssueInlinks` (:3785), `rulesCatalog` (:3400), `exportCrawl` (:4367) and `prepareCsvExport` (:4493)
- Modify: `src/api/csv.ts`, where the `issues` view gains `type` and `priority` columns after `severity` and the `issues` and `issue_urls` views exclude disabled rules
- Modify: `src/api/mcp.ts` and `src/api/http.ts`, but only where output schemas are declared
- Test: `test/api/judgement-surfaces.test.ts`, and update `test/api/csv.test.ts` and `test/api/surface-unchanged.test.ts` for the additive fields

**Interfaces:**
- Consumes: `readStoredJudgement`, `readStamp`, `judgedWithOf`, `staleReasons`, `effectiveThresholds` (Task 2); `renderCopy` (Task 4); `triageFor` (Task 1).
- Produces, in `judgement-view.ts`:
  - `export interface JudgementStale { stale: boolean; reasons: StaleReason[] }`. `stale` is `false` with `reasons` `[]` for an unjudged crawl.
  - `export interface JudgementView { block: JudgementBlock | null; disabledRules: string[]; typeOf(ruleId: string): { type: IssueType; overridden: boolean }; priorityOf(ruleId: string): { priority: Priority; overridden: boolean }; copyThresholds: Thresholds; judgementStale: JudgementStale }`.
    - `copyThresholds` is the stamp's thresholds over the defaults for a judged crawl, and the current block's for an unjudged one.
    - `typeOf` and `priorityOf` throw on a metric rule.
  - `export async function loadJudgementView(db: Db, crawlId: string, registry: Registry): Promise<JudgementView>`. It makes one `select` of `config`, `judgement`, `rules_judged_with` and `rules_run_at`.
    - A stored override naming a rule the registry lacks becomes `ServiceError("CONFLICT", …)`, naming the crawl and the rule, as `ruleFor` does for stored findings.
    - Any other malformed block propagates as the loud error `readStoredJudgement` threw.
- Response changes, all additive:
  - **`IssueGroup`** gains `type`, `priority`, and `typeOverridden?: true` / `priorityOverridden?: true`. Each flag is present only when true.
  - **`listIssues`** returns `Page<IssueGroup> & { disabledRules: string[]; judgementStale: JudgementStale }`.
  - **`listIssueUrls` / `listIssueInlinks`** throw `ServiceError("CONFLICT", "rule '<id>' is disabled on crawl '<crawlId>'; re-enable it with crawl_config_set to list its findings")` for a disabled rule.
  - **`CatalogRule`** gains `type?` and `priority?`, absent on metric rules. With a crawl named, it also gains `disabled?: true` and the override flags, and its copy is rendered with `copyThresholds`. `RulesCatalog` gains `judgementStale?: JudgementStale` and `thresholds?: Record<ThresholdName, number>` (the `copyThresholds`), only when a crawl is named.
  - **Exports:** the `issues` CSV adds the `type` and `priority` columns. The JSONL `issues` dataset excludes disabled rules, and its manifest gains `disabledRules`.

- [ ] **Step 1: Write the failing tests** (`judgement-surfaces.test.ts`). Seed a crawl with findings for `title.too-long`, `meta-description.missing` and one marker, and judge it with `runRules`. Then set `judgement_jsonb` directly in SQL (Task 6 adds the tool) to `{rules: {"title.too-long": {disabled: true}, "meta-description.missing": {priority: "low", type: "opportunity"}}}`.
  - `listIssues`:
    - has no `title.too-long` group, and `disabledRules` equals `["title.too-long"]`;
    - the `meta-description.missing` group has `priority: "low"`, `priorityOverridden: true`, `type: "opportunity"` and `typeOverridden: true`;
    - the marker group has `type: "warning"` and `priority: "low"`, with no override flags;
    - `judgementStale` equals `{stale: true, reasons: ["overrides"]}`.
  - `listIssueUrls(crawl, "title.too-long")` rejects with code `CONFLICT`, and the message names the rule.
  - A stored block `{rules: {"gone.rule": {disabled: true}}}`, written directly in SQL, makes `listIssues` reject with `CONFLICT` naming `gone.rule`.
  - `rulesCatalog({crawlId})`:
    - `title.too-long` has `disabled: true` and `fired.count` > 0. The stored findings are still counted, and the catalog says so beside `disabled`.
    - `site.health` has no `type`.
  - The CSV `issues` view has the header `ruleId,severity,type,priority,category,checkIds,url,title,evidence` and no `title.too-long` row.
  - **Re-enable and stale:** setting `judgement_jsonb` to null restores the `title.too-long` group immediately, and `judgementStale.stale` is false again (the stamp's disabled set was empty).
  - **Thresholds in the catalog:**
    - after storing `{thresholds: {TITLE_MAX: 50}}` without a re-run, `rulesCatalog({crawlId})`'s `title.too-long` explanation still says `60 characters`, with `judgementStale.reasons` `["thresholds"]`;
    - after `runRules` it says `50 characters` and is not stale.

- [ ] **Step 2:** Run it. Expect FAIL.

- [ ] **Step 3: Implement.** The disabled filter is SQL: `i.rule_id not in ${disabled}` when non-empty, with the same drizzle note as the existing `in` filter. `ruleFor`'s CONFLICT for unknown rule ids is unchanged.

- [ ] **Step 4:** Run `npx vitest run test/api` and `npx tsc --noEmit`. Expect PASS.

- [ ] **Step 5: Commit:** `feat(api): issues, catalog and exports apply the crawl's judgement (27a T5)`.

---

### Task 6: Setting the judgement; `judgementStale` on status, metrics and compare

**Files:**
- Modify: `src/api/service.ts`, covering `parseStartCrawlInput` / `START_CRAWL_FIELDS`, `startCrawl`, `getCrawl` (`CrawlDetail`), `listMetrics`, `metricTable` and `compareCrawls`, plus the new `getCrawlConfig` and `setCrawlJudgement`
- Modify: `src/api/mcp.ts`, which gets `crawl_start`'s `judgement` field and the new tools `crawl_config_get` and `crawl_config_set` in `TOOL_NAMES`
- Modify: `src/api/http.ts`, for `GET /crawls/:id/config` and `PATCH /crawls/:id/config`
- Test: `test/api/judgement-config.test.ts`, plus the mcp, http and surface tests as they pin tool lists and shapes

**Interfaces:**
- Consumes: `parseJudgement` and `JudgementError` (Task 2); `loadJudgementView` (Task 5).
- Produces:
  - **`StartCrawlInput.judgement?: unknown`.** It is parsed with `parseJudgement` and stored in `judgement_jsonb`.
    - Its `findingCap` is written to `config.findingCap`.
    - If both the top-level `findingCap` and `judgement.findingCap` are given and differ, the request is refused: `VALIDATION`, naming both.
    - A `JudgementError` maps to `ServiceError("VALIDATION", "<path>: <message>")`.
  - **`getCrawlConfig(crawlId)`** returns `{ crawlId: string; judgement: JudgementBlock; thresholds: Record<ThresholdName, { value: number; default: number; min: number; max: number; overridden: boolean }>; judgedWith: JudgedWith | null; judgementStale: JudgementStale }`.
    - `judgement` is the stored block with `findingCap` folded in from `config`, or `{}` when nothing is set.
    - `thresholds` shows the current block's values.
  - **`setCrawlJudgement(crawlId, patch: unknown)`** applies an RFC 7396 merge-patch of `patch.judgement` onto the stored block. A `null` removes a key, so `rules: {"x": null}` removes an override and `thresholds: {SLOW_MS: null}` removes one.
    - The merged result is validated with `parseJudgement` and stored.
    - It returns `getCrawlConfig`.
    - Refusals:
      - `CONFLICT` while `this.judging` holds the crawl: "rules are running for crawl …";
      - `VALIDATION` for any key other than `judgement` (in 27a: "only `judgement` can be set; crawl fields arrive in Phase 27b");
      - `NOT_FOUND` for an unknown crawl.
  - **`CrawlDetail`** gains `judgementStale: JudgementStale`. `findingCap` is unchanged.
  - **`listMetrics` / `metricTable`** responses gain `judgementStale`.
  - **`compareCrawls`** adds the caveat `{ code: "judgement-overrides", message }` when either side's stored block disables a rule. It names the crawl and the count, and does not affect `comparable`.
  - **MCP and HTTP:**
    - `crawl_config_get` ↔ `GET /crawls/:id/config`;
    - `crawl_config_set` ↔ `PATCH /crawls/:id/config`, with the body `{judgement: {...}}`.

- [ ] **Step 1: Write the failing tests** (`judgement-config.test.ts`), through the HTTP server, as `test/api/http.test.ts` does:
  - **Start and read back:** `POST /crawls` with `judgement: {thresholds: {SLOW_MS: 800}}` is accepted. `GET /crawls/:id/config` shows `thresholds.SLOW_MS` as `{value: 800, default: 1500, overridden: true}`.
  - **Refused at start:** `POST /crawls` with `findingCap: 100, judgement: {findingCap: 200}` gives 400, with a message naming both.
  - **Patch and remove:** `PATCH` with `{judgement: {rules: {"title.too-long": {disabled: true}}}}` returns the config with that override. `PATCH` with `{judgement: {rules: {"title.too-long": null}}}` removes it, and the stored block is `{}`, or `null`; the test pins `{}`.
  - **Refused patches:**
    - `PATCH {maxPages: 10}` → 400;
    - `PATCH {judgement: {rules: {"title.too-long": {severity: "info"}}}}` → 400 with the path `rules.title.too-long.severity`;
    - a PATCH while a rules run is in flight → 409 (hold the run with a registry containing a query rule that awaits a test-controlled promise, as the existing judging-lock test does).
  - **Stale flags:**
    - `crawl_status` carries `judgementStale` (false before any run, `{stale: true, reasons: ["thresholds"]}` after a judged crawl gets a threshold patch);
    - `metrics_get` carries the same flag.
  - **MCP:**
    - `crawl_config_get` and `crawl_config_set` are listed in `TOOL_NAMES`;
    - `crawl_config_set` over MCP gives the same refusal text as HTTP for the severity case.
  - **Compare:** a crawl with a disabled rule gives a `judgement-overrides` caveat.

- [ ] **Step 2:** Run it. Expect FAIL.

- [ ] **Step 3: Implement.** Write the merge-patch as a small pure function in `judgement-view.ts`, with its own unit cases:
  - nested merge;
  - null deletes;
  - arrays are not merged, because none are allowed.

- [ ] **Step 4:** Run `npx vitest run test/api` and `npx tsc --noEmit`. Expect PASS.

- [ ] **Step 5: Commit:** `feat(api): crawl_config_get/set for the judgement block; judgementStale on status and metrics (27a T6)`.

---

### Task 7: SQL indexability status

**Files:**
- Modify: `src/rules/helpers.ts`, which gets `INDEXABILITY_STATUS_SQL`
- Test: `test/rules/indexability-sql.test.ts`

**Interfaces:**
- Produces: `export const INDEXABILITY_STATUS_SQL = (alias: string): SQL`. It is a `CASE` expression returning the same `IndexabilityStatus` string `indexabilityOf` returns for a `pages` row, with `''` for indexable.

- [ ] **Step 1: Write the failing test.** Run the fixture crawl the harness uses (reuse the harness setup helper, or seed pages covering every status value in `IndexabilityStatus`). For every page, assert that `indexabilityOf(row).status` equals the SQL expression's value from `select … from pages p where p.id = …`. Also assert that every `IndexabilityStatus` member except `""` occurs at least once, so the parity is not vacuous.
- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3: Implement** the `CASE` in the same precedence order as `indexabilityOf`, and add a comment tying the two together.
- [ ] **Step 4:** Run it. Expect PASS.
- [ ] **Step 5: Commit:** `feat(rules): indexability status as SQL, pinned to indexabilityOf (27a T7)`.

---

### Task 8: Issues Overview

**Files:**
- Create: `src/api/overview.ts`
- Modify: `src/api/service.ts`, where `issuesOverview` delegates
- Modify: `src/api/mcp.ts`, which adds `issues_overview`
- Modify: `src/api/http.ts`, which adds `GET /crawls/:id/overview/issues`
- Modify: `src/api/csv.ts`, which adds the `issues_overview` view: a non-keyset aggregate, listed beside `metric_table` in the exception note
- Test: `test/api/issues-overview.test.ts`

**Interfaces:**
- Consumes: `loadJudgementView` (Task 5); `renderCopy` (Task 4).
- Produces:
  - `export interface IssuesOverviewRow { ruleId: string; title: string; type: IssueType; typeOverridden?: true; priority: Priority; priorityOverridden?: true; severity: Severity; category: RuleCategory; checkIds: string[]; urls: number; percentOfJudged: number | null; marker?: true }`.
  - `export interface IssuesOverview { crawlId: string; rulesetVersion: string; pagesJudged: number | null; rows: IssuesOverviewRow[]; disabledRules: string[]; judgementStale: JudgementStale }`.
  - `issuesOverview(crawlId: string, opts: { includeZero?: boolean }): Promise<IssuesOverview>`.
- **Semantics:**
  - **`urls`** counts distinct non-null `page_id`, plus 1 if the rule has any site-wide finding (`page_id` null).
  - **`pagesJudged`** is `site.health`'s Pages Judged (`urlsTotal`), read from the stored metric. It is null when the crawl was not judged or has no `site.health` row.
    - **`percentOfJudged`** is `round(urls / pagesJudged * 100, 1)`, or null when `pagesJudged` is null or 0.
  - **Refusals:** an unjudged crawl raises `CONFLICT` ("run crawl_rules first"). An unjudged crawl has no findings to summarise, and an empty overview would read as "clean".
  - **Rows:**
    - By default, only rules with at least one finding, disabled ones excluded.
    - `includeZero: true` adds every non-disabled page and query rule with `urls: 0`.
    - Metric rules never appear.
  - **Order:** type (`issue`, `warning`, `opportunity`), then priority (`high`, `medium`, `low`), then `urls` descending, then `ruleId` ascending.
  - **CSV view `issues_overview`:** the columns are `Issue Name,Issue Type,Issue Priority,Severity,URLs,% of Judged,Description,How To Fix,Rule Id,Check Ids`. `Issue Name` is the title, and the description and fix come from `renderCopy` with `copyThresholds`. Same rows and order.
  - **MCP `issues_overview`:** `{crawlId, includeZero?}` ↔ `GET /crawls/:id/overview/issues?includeZero=true`.

- [ ] **Step 1: Write the failing tests:**
  - On a judged seeded crawl, for every rule, a row's `urls` equals the distinct page count from `issue_urls` for that rule. For page-scoped rules this is the same as `issues_list.count`; assert on both for one page rule and one site-wide rule.
  - Ordering holds on a crafted set: two issue/high rules ordered by `urls`, then a warning/high rule.
  - A disabled rule is absent, and is named in `disabledRules`.
  - `includeZero` adds a zero row for a rule that did not fire, and never adds `site.health`.
  - An unjudged crawl raises `CONFLICT`.
  - The CSV header matches exactly, the row count matches the JSON, and the `% of Judged` cell is empty when null.
  - A seeded `issues` row for a rule id the registry lacks raises `CONFLICT`, as `issues_list` does (Review Focus 5).

- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3: Implement.** Use one `GROUP BY rule_id` query with `count(distinct page_id)` and `bool_or(page_id is null)`, with the disabled filter in SQL.
- [ ] **Step 4:** Run `npx vitest run test/api` and `npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(api): issues_overview (JSON + CSV) (27a T8)`.

---

### Task 9: Crawl Overview

**Files:**
- Modify: `src/api/overview.ts` and `src/api/service.ts` (`crawlOverview`)
- Modify: `src/api/mcp.ts` (`crawl_overview`) and `src/api/http.ts` (`GET /crawls/:id/overview/crawl`)
- Modify: `src/api/csv.ts`, which adds the `crawl_overview` view (non-keyset aggregate)
- Test: `test/api/crawl-overview.test.ts`

**Interfaces:**
- Consumes: `getCrawl` (`CrawlDetail`), `INDEXABILITY_STATUS_SQL` (Task 7), `loadJudgementView` (Task 5).
- Produces:
  - `export interface OverviewEntry { label: string; value: number; percent: number | null }`.
  - `export interface OverviewSection { id: string; entries: OverviewEntry[] }`.
  - `export interface CrawlOverview { crawlId: string; sections: OverviewSection[]; notMeasured: { id: string; reason: string }[]; judgementStale: JudgementStale }`.
  - `crawlOverview(crawlId): Promise<CrawlOverview>`.
- **Sections, in this order, with these ids.** Labels are the stored values unless named. `percent` is against the section's own total, rounded to 1 decimal, and null when the total is 0.
  1. **`urls`:** `Encountered`, `Fetched`, `Not fetched (frontier)`, `Blocked by robots.txt (stored)`, `Blocked by robots.txt (dropped)`. Each is taken from `getCrawl`'s own fields, so the overview and `crawl_status` cannot disagree; the gate checks they reconcile.
  2. **`fetch-class`:** one entry per `pages.fetch_class` value.
  3. **`status-class`:** `2xx`, `3xx`, `4xx`, `5xx`, `No response`. The last is `status_code` null.
  4. **`content`:** HTML pages by `page_type`, with null as `Unclassified`. Then non-HTML pages by content-type family (`application/pdf` → `PDF`, `image/*` → `Image`, `text/css` → `CSS`, JavaScript types → `JavaScript`, else `Other`). Then resources by kind (`Image`, `CSS`, `JavaScript`).
  5. **`indexability`:** `Indexable`, then one entry per `INDEXABILITY_STATUS_SQL` value.
  6. **`click-depth`:** `0` … `9`, `10+`, `Unreachable`, read from `pages.click_depth`. **Not measured** when `rules_run_at` is null, with the reason "click depth is derived by the rules run; run crawl_rules".
  7. **`discovery`:** one entry per `discovered_via`; then `In a sitemap` / `Not in a sitemap`, a join on `sitemap_urls.url_normalised = pages.url`.
  8. **`response-time`:** the fixed buckets from Deviation 5, then `Over SLOW_MS (<value> ms)` using `copyThresholds.SLOW_MS`.
  9. **`render`:** `Pages rendered`, plus `Render coverage` taken from the stored `render.coverage` metric's state. **Not measured** when the crawl never rendered (`render_pass_count = 0`), with the reason "no render pass ran".
  10. **`issues-grid`:** nine entries, `issue/high` … `opportunity/low`, counting finding rows after the disabled filter, with overridden type and priority applied. **Not measured** when unjudged.

  A section that is not measured is absent from `sections` and named in `notMeasured`. It is never zeros.
- **CSV view `crawl_overview`:** the columns are `Section,Label,Value,Percent`. One row per entry, in order, then one row per not-measured section with `Value` and `Percent` empty and `Label` = `Not measured: <reason>`.

- [ ] **Step 1: Write the failing tests:**
  - On the fixture crawl (judged, not rendered):
    - `urls.Fetched` equals `getCrawl().pagesCrawled`;
    - the `status-class` entries sum to the `pages` row count;
    - the `indexability` entries sum to the same;
    - `render` is in `notMeasured`.
  - On an unjudged crawl, `click-depth` and `issues-grid` are in `notMeasured`.
  - The `response-time` bucket edges: seeded pages at 249, 250, 999, 1000, 1999 and 2000 ms land in the right buckets. With a stamped `SLOW_MS` of 800, `Over SLOW_MS (800 ms)` counts the four pages at 999 ms or more.
  - The `issues-grid` reflects an override that retypes a rule.
  - The CSV header and rows match the JSON.

- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3: Implement.** Each section is one bounded `GROUP BY` query.
- [ ] **Step 4:** Run `npx vitest run test/api` and `npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(api): crawl_overview (JSON + CSV) (27a T9)`.

---

### Task 10: Surface docs, skills, and the gate

**Files:**
- Modify: `docs/talos-surface.md`:
  - **§4:** new entries for `issues_overview`, `crawl_overview`, `crawl_config_get` and `crawl_config_set`, with shapes regenerated from a live server as the doc's own method says. Plus the new fields on `issues_list`, `rules_catalog`, `crawl_status` and `metrics_get`.
  - **§5:** null versus zero for `percentOfJudged`, `pagesJudged` and `notMeasured`.
  - **§10:** rewrite "No prioritisation beyond rule severity" to say type and priority are rule defaults that the agent overrides per crawl. Fix "four command tools" to the real count (six with `crawl_config_set`).
  - **§12:** the two new CSV views.
- Modify: `docs/talos-integration.md` obligation 6, adding one sentence: engine type and priority are the rule's defaults, and the agent's per-crawl overrides are the judgement.
- Modify:
  - `skills/ariadne-audit/SKILL.md`: type and priority are the rule's opening bid beside severity, and disabling a rule is how "doesn't apply here" is recorded.
  - `skills/ariadne-action-plan/SKILL.md` and `skills/ariadne-report/SKILL.md`: engine priority is an input to their own site-level priority, not a replacement for it.
  - `skills/ariadne-crawl/SKILL.md`: the `judgement` field at `crawl_start`, and `crawl_config_get` / `crawl_config_set`.
- Create: `docs/gates/phase-27a.md`
- Modify: the `src/rules/registry/registry.ts` version note, with its last item re-measuring `rules_catalog` bytes.

- [ ] **Step 1: Docs and skills.** Run the identifier guard and the surface tests: `npx vitest run test/skills test/api`. Expect PASS.

- [ ] **Step 2: Gate run** (scripts in the SDD workspace, never committed). Against the stored lavishalice crawl from Task 0:
  - **(a) Re-judge** with `crawl_rules`.
  - **(b) Issues Overview against `issues_list`:** fetch `issues_overview` and check that `urls` equals `count` for every page-scoped rule, listing any site-wide rules separately.
  - **(c) Crawl Overview against `crawl_status`:** fetch `crawl_overview` and reconcile `urls` with `crawl_status`.
  - **(d) Read-time round trip:** `crawl_config_set` disables one rule that fired, retypes one and reprioritises one. Each is visible immediately in `issues_list`, `issues_overview`, `rules_catalog` and the `issues` CSV, and `judgementStale` is `["overrides"]`.
  - **(e) Threshold round trip:** set `SLOW_MS` to a value that changes `performance.slow-response`'s count.
    - Before the re-run, findings are unchanged and the reasons include `thresholds`.
    - After `crawl_rules`, the count changes, the copy names the new value, the stamp holds it, and nothing is stale.
  - **(f) Re-enable:** re-enabling the disabled rule brings its findings back with no run.
  - **(g) Cleanup:** remove every override and re-run, so the stored crawl is left as it was found.
  - Record each command and its output.

- [ ] **Step 3: Write `docs/gates/phase-27a.md`.**
  - Clause 1: `tsc` clean, plus the full-suite count with 0 skipped.
  - Clause 2: the triage table is complete (test name), with the `triage-vs-sf.md` table and every divergence with its reason.
  - Clause 3: the Issues Overview reconciliation.
  - Clause 4: the Crawl Overview reconciliation.
  - Clause 5: the override round trip, (d) to (f).
  - Then the deviations, as listed in this plan.

- [ ] **Step 4:** Run `npx tsc --noEmit` and `npm test`. Expect clean, with 0 skipped.

- [ ] **Step 5: Commit:** `docs(gate): phase 27a gate, surface docs and skills (27a T10)`.

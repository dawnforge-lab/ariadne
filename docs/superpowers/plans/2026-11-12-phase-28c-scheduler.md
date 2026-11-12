# Phase 28c — Scheduler, history, CI gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Crawls recur unattended: a schedule fires a crawl on a cron slot, then renders it if asked, then judges it, so two fired crawls can be compared.
- Exactly one scheduler leads at a time, and a brief two-leader overlap is harmless.
- Every crawl's lifecycle is readable as history.
- The 50k memory gate runs weekly in CI without anyone remembering it.
- Cloud workers keep no rendered documents.

**Architecture:**
- `crawl_events` is written by Postgres triggers on `crawls` and `jobs` for every lifecycle kind, and by the scheduler for the `schedule_*` kinds (call C1). No call site can forget an event.
- `schedules` and `schedule_credentials` store what a fire needs. A fire inserts the crawl through the same `insertCrawl` that `crawl_start` now uses, inside the scheduler's transaction.
- A `Scheduler` (`src/schedule/scheduler.ts`) holds `pg_try_advisory_lock` on a dedicated `pg.Client`. It ticks every 30 s and claims due schedules with `FOR UPDATE SKIP LOCKED`.
- **Chains:**
  - A scheduled crawl's close hook enqueues its first link (`render` or `rules`) in the close's transaction.
  - A chain executor runs `render` and `rules` jobs. It settles each one and enqueues the next link, or records `schedule_chain_failed`, in one transaction.
- The render and rules work moves out of `ApiService` into `runRenderLink` and `runRulesLink`. The synchronous API calls and the chain executor share them.
- `.github/workflows/gate.yml` runs `scripts/gate-rules.ts` at 50,000 pages. A new `--json-out` flag gives it an artifact.

**Tech Stack:**
- TypeScript strict, Node 22, drizzle + Postgres 16 (plpgsql triggers in a custom drizzle migration), vitest.
- New dependency `cron-parser` (MIT, the current major). Its licence is checked at install. It is a dependency, nothing is lifted, so there is no `THIRD_PARTY_NOTICES.md` entry.
- GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-11-phase-28-cloud-foundations-design.md`. The relevant parts:
- §28c items 14–17.
- §28b item 13 (rendered documents), which moved here by 28b deviation 2.
- Gates 28c.

The carries come from `docs/gates/phase-28b.md` "Open items for 28c and later".

## Calls I made (owner to check)

- **C1: events by trigger.**
  - `AFTER INSERT OR UPDATE OF status` triggers on `crawls` and on `jobs` write the lifecycle kinds.
  - The application writes only `schedule_fired`, `schedule_skipped` and `schedule_chain_failed`.
  - Why: the crawl status is written in about ten places (the loop's closes, pause, cancel, mark-failed, the reaper, the runner's pre-start pauses), and an event missed at one of them is invisible.
  - Cost if wrong: the trigger SQL duplicates the kind list, and a test pins the two lists together.
- **C2: a schedule stores the effective config.** It stores what `crawls.config` stores, plus the judgement block and the listed URLs, all produced by `crawl_start`'s own `planStart` at create and update time.
  - A fire does not re-plan. It re-checks only the allowlist and reads the credentials.
  - Why: workers have no `ServiceConfig.crawlDefaults`, and a fire that re-planned in a worker would plan differently from the API.
  - Cost if wrong: a later change to an operator default does not reach existing schedules until they are updated.
- **C3: the scheduler is opt-in in the library.**
  - `ServiceConfig.scheduler` defaults to off, like `crawlRunner`'s embedding default. `api:serve`, the stdio MCP entry and `worker:serve` turn it on, so every deployed process is a candidate, as the spec says.
  - Tests pass a lock key and an `onlyTenants` list of their own: a code-only test seam, as R11 did for the reaper.
- **C4: pins.**
  - A fired crawl takes the firing process's crawl pin: its own instance in in-process mode, the unpinned pool in `workers` mode and in a worker.
  - A chain link inherits its crawl job's pin.
  - So a stdio MCP that fires a schedule also runs its chain.
- **C5: a further skip reason, `credentials_unreadable`.** It applies when the schedule's own stored copy cannot be read at fire time. Nothing is fired without its credentials.
- **C6: `gate.yml` also runs on `pull_request` when `gate.yml` itself changes.** GitHub dispatches only workflows that exist on the default branch, so gate clause 3 can run on this PR only that way.
- **C7: `renderDocuments` is derived.** It is `"kept"` when any page of the crawl has a non-null `rendered_html_path`, and `"not kept"` otherwise. No new column is added.
- **C8: `crawl` in `schedule_update` replaces the config and the credentials together.** A body without credential fields removes them, just as a new `crawl_start` would carry none.
- **C9: events for `schedule_fired` and `schedule_skipped` carry `crawl_id` null and name the crawl in `detail`.** A fire's record outlives a deleted crawl.
  - `schedule_chain_failed` carries both ids.
  - Every lifecycle event carries `schedule_id` from `crawls.schedule_id`.

## Global Constraints

**Events.**
- **Table.** `crawl_events` has `id bigserial`, `tenant_id text not null`, `crawl_id` (nullable, references `crawls` on delete cascade), `schedule_id` (nullable, references `schedules` on delete cascade), `at timestamptz not null default now()`, `kind text not null` and `detail jsonb not null default '{}'`.
- **Kinds.** `queued`, `claimed`, `started`, `paused`, `resumed`, `cancelled`, `finished`, `failed`, `render_queued`, `render_started`, `render_finished`, `rules_queued`, `rules_started`, `rules_finished`, `worker_lost`, `schedule_fired`, `schedule_skipped`, `schedule_chain_failed`.
- **Detail.** Each kind's detail keys come from an allowlist (`EVENT_DETAIL_KEYS`):
  - `claimed`: `instanceId`, `role`
  - `paused`: `reason`
  - `resumed`: `auto`
  - `finished`: `pagesCrawled`
  - `failed`: `reason`
  - `*_finished`: `outcome`
  - `worker_lost`: none
  - `schedule_fired`: `crawlId`
  - `schedule_skipped`: `reason` (`overlap | not-allowed | credentials_unreadable`), `crawlId` (the holding crawl, on `overlap` only)
  - `schedule_chain_failed`: `link`, `reason`
  - every other kind: none
- **Mapping rules:**
  - A crawl paused with reason `worker_lost` writes kind `worker_lost`, not `paused`.
  - A transition `paused → queued` writes `resumed`, with `auto` true when `auto_resume_count` rose.
  - `queued → running` writes `started`.
  - A crawl job's `queued → running` writes `claimed`.
  - A render or rules job writes `*_queued` when inserted `queued`, `*_started` when it becomes or is inserted `running`, and `*_finished` when settled, with `outcome` being the job status.
  - Events are O(lifecycle), never O(URLs).
- **Never in `detail`:** a credential name or value, or a client-sent key.

**Schedules.**
- **`schedules` columns:** `id` (`sched_<uuid>`), `tenant_id`, `site_url`, `config jsonb` (`{config, judgement, listed}`, C2), `render jsonb` (null, or `{urls?: string[]}`), `cron text`, `timezone text`, `enabled bool`, `next_run_at timestamptz` (null while disabled), `last_crawl_id text` (references `crawls` on delete set null), `credential_generation int not null default 0`, `created_at` and `updated_at`.
- **`schedule_credentials`:** the same columns as `crawl_credentials`, keyed by `schedule_id` (cascade). The associated data is `` `schedule:${scheduleId}:${generation}` ``.
- **`crawls` gains:**
  - `schedule_id` (nullable, references `schedules` on delete set null).
  - `schedule_chain jsonb`: `{render: {urls?} | null}`, non-null exactly when a schedule fired the crawl.
- **Cron.**
  - Exactly five whitespace-separated fields. Six (seconds) is refused.
  - `timezone` is an IANA name, checked with `Intl.DateTimeFormat(undefined, {timeZone})`.
  - The next slot is computed by `cron-parser` in that zone.
  - An expression with no slot in the next 366 days is refused at create (Review Focus 1).

**Scheduler.**
- The lock key is `SCHEDULER_LOCK = 2_028_004_002`, held with `pg_try_advisory_lock` on a dedicated `pg.Client` whose `application_name` is `ariadne-scheduler:<instanceId>`.
- Leadership is attempted, and the leader ticks, every **30 s** (`Timing.scheduleEvery`, injectable).
- A fire, or a skip, advances `next_run_at` to the first slot strictly after `now()`, so missed slots fire once.
- **Skip reasons:** `overlap`, `not-allowed` and `credentials_unreadable` (C5).
  - `overlap`: a crawl with this `schedule_id` is `queued | running | paused`, or a `queued | running` job exists on one.

**Rendered documents.** A render with `renderHtmlDir: null` writes no file, and `rendered_html_path` stays null.
- A worker's chain render passes null.
- The stdio MCP process and the API's synchronous `crawl_render` keep passing their `renderDir`.

**CI gate.**
- `gate.yml` runs on `schedule` (weekly, `0 3 * * 1`), on `workflow_dispatch`, and on `pull_request` with `paths: [.github/workflows/gate.yml]` (C6).
- It uses a Postgres 16 service, runs `npm run db:migrate`, then `node --max-old-space-size=512 --import tsx scripts/gate-rules.ts --json-out gate.json` with `GATE_PAGES=50000`.
- `timeout-minutes: 120`.
- It fails when the script exits non-zero, which happens above 512 MB peak.
- It writes a `::warning::` annotation when the crawl phase's peak exceeds **290.2 MB**.
- It uploads `gate.json` with `if: always()`.

**Unchanged from 28b:** Migrations are generated with drizzle-kit (`0045` on), using `--custom` for the trigger SQL, and applied with `npm run db:migrate`. No fallbacks. Credential values never reach a log, an event, an error, a metric or a response. A foreign schedule answers exactly like a missing one (404 `NOT_FOUND`). `RULESET_VERSION` is unchanged; no rule changes.

**Checks.**
- `npx tsc --noEmit` and `npm test` pass at every commit, with `export DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`, the dev database.
- The gate database (`ariadne_gate28c`) is for the gate scripts only. The 50k data in a gate database makes the database-wide rules tests time out.
- `test/skills/identifier-guard.test.ts` passes, with line citations re-pointed only.

**Commit trailer**, on every commit:
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
```

## Review Focus

1. **A cron that never matches** (`0 0 30 2 *`, February 30th). `schedule_create` answers 400 `INVALID` naming `cron`, and nothing loops. Test in Task 3.
2. **A daylight-saving change.**
   - `30 1 * * *` in `Europe/London`: on 2026-03-29 (01:30 does not exist) and on 2026-10-25 (01:30 happens twice), the schedule fires once per day.
   - `next_run_at` is always strictly after the fire.
   - Test in Task 3 (the slot function) and Task 5 (one fire).
3. **The leader's connection is killed** (`pg_terminate_backend` on its pid).
   - The leader logs that it lost the lock and stops ticking.
   - Another candidate leads within one `scheduleEvery`.
   - No slot fires twice.
   - Test in Task 5.
4. **A schedule deleted while its fired crawl's chain is in flight.**
   - The chain runs to its end.
   - Its events carry `schedule_id` null.
   - No foreign-key error, and no orphan job.
   - Test in Task 6.
5. **A fired crawl queued behind another tenant's crawl of the same host.** It waits as `queued` (host exclusivity, 28b), and the next slot is skipped as `overlap`, not stacked. Test in Task 5.

---

### Task 0: Baseline

- [ ] **Step 1:** At the plan commit, run `npx tsc --noEmit` and `npm test` on the dev database, and record the counts in the ledger. Expected: 167 files and 4,520 tests, all passing.

### Task 1: Crawl events and `crawl_history`

**Files:**
- Create:
  - `src/events/events.ts`.
  - `drizzle/0045_*.sql` (table, generated).
  - `drizzle/0046_*.sql` (triggers, `drizzle-kit generate --custom --name crawl_events_triggers`).
  - `test/events/crawl-events.test.ts`.
- Modify:
  - `src/db/schema.ts` (`crawlEvents`).
  - `src/api/service.ts` (`crawlHistory`).
  - `src/api/mcp.ts` (`crawl_history`, added to `TOOL_NAMES`).
  - `src/api/http.ts` (`GET /crawls/:id/history`).
  - `test/api/tenant-isolation.test.ts` (scoped cases).
  - `test/api/no-key-echo.test.ts` (events).

**Interfaces:**
- Produces:
  - `EVENT_KINDS: readonly EventKind[]` and `EVENT_DETAIL_KEYS: Record<EventKind, readonly string[]>`.
  - `recordEvent(tx: Writer, e: {tenant: TenantId; crawlId: string | null; scheduleId: string | null; kind: "schedule_fired" | "schedule_skipped" | "schedule_chain_failed"; detail: Record<string, string | number | boolean>}): Promise<void>`. It throws on a detail key outside the allowlist.
  - `interface CrawlEvent { id: string; at: string; kind: EventKind; scheduleId: string | null; crawlId: string | null; detail: Record<string, unknown> }`.
  - `listEvents(db, where: {tenant; crawlId} | {tenant; scheduleId}, page: {limit; cursor}): Promise<Page<CrawlEvent>>`, oldest first, keyset on `id`, using the existing `parseLimit` and cursor conventions.
  - `ApiService.crawlHistory(tenant, crawlId, opts: {limit?; cursor?}): Promise<Page<CrawlEvent>>`.

- [ ] **Step 1: Write the failing tests.**
  - (a) An in-process crawl of the local fixture is paused by `crawl_pause`, resumed by `crawl_resume` and finished. `crawl_history` reads, in order: `queued, claimed, started, paused{reason:"request"}, resumed{auto:false}, claimed, started, finished{pagesCrawled:n}`. This is gate clause 2.
  - (b) `crawl_rules` on the finished crawl adds `rules_started` then `rules_finished{outcome:"done"}`.
  - (c) A reaper `worker_lost` pause, using the 28b reaper test helpers, writes `worker_lost` with no `paused` beside it. Its auto-requeue writes `resumed{auto:true}`.
  - (d) For every kind in `EVENT_KINDS`, the trigger SQL's kind set equals the TS set: read the trigger function's source from `pg_proc` and match each `'kind'` literal.
  - (e) Every event row written by (a) to (c) has detail keys within `EVENT_DETAIL_KEYS[kind]`.
  - (f) `recordEvent` with a key outside the allowlist throws, naming the kind and the key's position, never the key.
  - (g) The sentinel: `crawl_history` and `GET /crawls/:id/history` are scoped cases. A foreign crawl answers like a missing one.
  - (h) No-key-echo: a crawl started with credentials and unknown keys leaves no credential name, value or sent key in any `crawl_events.detail`.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.**
  - **Table.** Generate the table migration.
  - **Triggers.** Write the trigger functions (`ariadne_crawl_event()` on `crawls`, `ariadne_job_event()` on `jobs`) in the custom migration:
    - Kind and detail follow the Global Constraints mapping, with detail built only from the named columns.
    - `claimed.role` comes from `instances.role` of `NEW.claimed_by`.
    - `schedule_id` comes from `crawls.schedule_id`. It is added in Task 3, so this task writes null and Task 3 re-creates the function with it. Task 3's migration says so.
  - **Code.** Write `src/events/events.ts`, the service method, the tool and the route.
- [ ] **Step 4:** `npx tsc --noEmit`, the new and modified tests, the identifier guard, then `npm test`. All pass.
- [ ] **Step 5:** Commit `feat: crawl_events by trigger and crawl_history (28c T1)`.

### Task 2: The render and rules links, and no documents on workers

**Files:**
- Create:
  - `src/crawl/render/render-link.ts`.
  - `src/rules/rules-link.ts`.
  - `test/crawl/render-link.test.ts`.
- Modify:
  - `src/crawl/render/run-render.ts` (`renderHtmlDir: string | null`).
  - `src/crawl/render/renderer.ts` (no write when the dir is null).
  - `src/api/service.ts` (`renderUnderJob` and `judgeUnderJob` delegate; `CrawlDetail.renderDocuments`).

**Interfaces:**
- Produces:
  - `runRenderLink(db: Db, vault: CredentialVault, crawlId: string, opts: {urls?: string[]; sent?: CrawlCredentials; renderHtmlDir: string | null; allowPrivate: boolean; resolveAddress?: …; log: (l: string) => void; where: "crawl_render" | "chain"}): Promise<RenderPassSummary>`. It holds today's body of `renderUnderJob`: the config parse, `credentialsFor` (a stored copy, or `sent`), the robots delay, `checkRenderUrls`, `runRenderPass`, `mapRenderPassError`, and the credential write-back of `sent`. A chain never passes `sent`.
  - `runRulesLink(db: Db, crawlId: string, registry: Registry): Promise<RunSummary>`. It holds today's body of `judgeUnderJob`.
  - `CrawlDetail.renderDocuments: "kept" | "not kept"` (C7).
  - Both throw `ServiceError` exactly as the service methods do today, so every existing 409 and 404 is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - (a) `runRenderPass` with `renderHtmlDir: null` over the fixture renders, writes no directory, and leaves `rendered_html_path` null on every rendered page.
  - (b) `crawl_status` answers `renderDocuments: "not kept"` after that pass and `"kept"` after a pass with a directory.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.** Move the bodies, make `ApiService` delegate, and add the null directory and `renderDocuments`. Existing tests in `test/api/render*.test.ts` and `test/api/rules*.test.ts` pass unchanged; they are the proof that the move changed nothing.
- [ ] **Step 4:** `npx tsc --noEmit`, the render and rules API tests, the identifier guard, then `npm test`.
- [ ] **Step 5:** Commit `refactor: render and rules links shared by API and chains; no documents without a dir (28c T2)`.

### Task 3: Schedules storage, cron and the shared crawl insert

**Files:**
- Create:
  - `src/schedule/cron.ts`.
  - `src/schedule/store.ts`.
  - `src/crawl/insert-crawl.ts`.
  - `drizzle/0047_*.sql` (tables and columns).
  - `drizzle/0048_*.sql` (custom: re-creates `ariadne_crawl_event()` with `schedule_id`).
  - `test/schedule/cron.test.ts` and `test/schedule/store.test.ts`.
- Modify:
  - `src/db/schema.ts`.
  - `src/crawl/credential-vault.ts` (schedule rows).
  - `src/api/service.ts` (`startCrawl` uses `insertCrawl`).
  - `package.json` (`cron-parser`).

**Interfaces:**
- Produces:
  - `parseCron(cron: string, timezone: string): {ok: true} | {ok: false; field: "cron" | "timezone"; message: string}`.
  - `nextSlot(cron: string, timezone: string, after: Date): Date`. Strictly after `after`. It throws when no slot exists in 366 days.
  - `insertCrawl(tx: Tx, vault: CredentialVault, c: {tenant: TenantId; crawlId: string; config: StoredConfig; judgement: JudgementBlock | null /* storableBlock()'s output */; credentials?: CrawlCredentials; listed: string[] | null; pinnedTo?: string; scheduleId?: string; chain?: {render: {urls?: string[]} | null}}): Promise<void>`. It inserts the crawl row, the vault row, `list_urls` and the crawl job, exactly as `startCrawl` does today.
  - `CredentialVault`:
    - `writeSchedule(tx, tenant, scheduleId, creds): Promise<number>`
    - `readSchedule(scheduleId, executor?): Promise<CredentialRead>`
    - `removeSchedule(executor, scheduleId): Promise<void>`
    - The associated data is per the Global Constraints. `sweepExpired` never touches schedule rows.
  - `src/schedule/store.ts`: `ScheduleRow`, `insertSchedule`, `getSchedule(db, tenant, id)` (null when missing or foreign), `listSchedules`, `updateSchedule`, `deleteSchedule`. All are tenant-filtered in SQL.

- [ ] **Step 1: Write the failing tests.**
  - **cron:**
    - Five fields accepted; four and six refused.
    - `0 0 30 2 *` refused at `nextSlot` within 366 days.
    - `Europe/Londn` refused naming `timezone`.
    - The two DST dates of Review Focus 2 give one slot each, strictly after `after`.
  - **vault:**
    - Schedule round trip.
    - A schedule ciphertext copied onto a crawl row fails `auth-failed`, and the reverse too.
    - `sweepExpired` leaves schedule rows.
  - **store:** tenant B's `getSchedule` on tenant A's id is null.
  - **insertCrawl:** the existing `startCrawl` tests pass unchanged. A new test inserts with `scheduleId` and `chain` and reads them back.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.** Install `cron-parser` and record its licence in the report. Write the migrations, the vault methods, the store and `insertCrawl`. `startCrawl` calls `insertCrawl`.
- [ ] **Step 4:** `npx tsc --noEmit`, the new tests, `test/api/credential-vault.test.ts`, the identifier guard, then `npm test`.
- [ ] **Step 5:** Commit `feat: schedules storage, cron slots, schedule credentials, shared crawl insert (28c T3)`.

### Task 4: The schedule tools

**Files:**
- Modify:
  - `src/api/service.ts`.
  - `src/api/mcp.ts` (5 tools plus `schedule_history`).
  - `src/api/http.ts` (`POST/GET /schedules`, `GET/PATCH/DELETE /schedules/:id`, `GET /schedules/:id/history`).
  - `test/api/tenant-isolation.test.ts`.
- Create: `test/api/schedules.test.ts`.

**Interfaces:**
- Produces:
  - `ApiService`:
    - `createSchedule(tenant, raw): Promise<ScheduleOut>`
    - `listSchedules(tenant, {limit?; cursor?}): Promise<Page<ScheduleOut>>`
    - `getSchedule(tenant, id): Promise<ScheduleOut>`
    - `updateSchedule(tenant, id, raw): Promise<ScheduleOut>`
    - `deleteSchedule(tenant, id): Promise<{scheduleId; deleted: true}>`
    - `scheduleHistory(tenant, id, {limit?; cursor?}): Promise<Page<CrawlEvent>>`
  - The create body is `{crawl: <crawl_start body>, cron, timezone, enabled?: boolean (default true), render?: {urls?: string[]} | null}`, validated by a strict zod schema. The update body has the same keys, all optional; `crawl` replaces the config and the credentials together (C8).
  - `ScheduleOut`: `{scheduleId, siteUrl, cron, timezone, enabled, nextRunAt, lastCrawlId, render, credentials: <the shape: kinds and names only, as crawl_config_get shows>, createdAt, updatedAt}`.
  - `crawl` is planned by the existing `planStart`, so every refusal `crawl_start` gives (allowlist 403 `NOT_ALLOWED` included) is given here with its path prefixed `crawl.`.
- [ ] **Step 1: Write the failing tests.**
  - Create, then get, list, update (cron change recomputes `nextRunAt`; `enabled:false` nulls it) and delete.
  - A credentialed create stores a `schedule_credentials` row. `ScheduleOut` shows names only, and no value appears in any response.
  - A disallowed host gives 403.
  - Review Focus 1's cron gives 400 `INVALID` naming `cron`.
  - Unknown keys are named by position, never quoted (27d sentinel).
  - Tenant sentinel:
    - Every `/schedules/:id*` route and `schedule_get/update/delete/history` is a new scoped-schedule case. A foreign schedule answers exactly as a missing one, and changes nothing.
    - `POST /schedules`, `GET /schedules`, `schedule_create` and `schedule_list` go on the global lists. The list is asserted to hold only the caller's.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx tsc --noEmit`, the new tests, the sentinel, no-key-echo, the identifier guard, then `npm test`.
- [ ] **Step 5:** Commit `feat: schedule_* tools and routes, tenant-scoped (28c T4)`.

### Task 5: The scheduler

**Files:**
- Create:
  - `src/schedule/scheduler.ts`.
  - `src/schedule/fire.ts`.
  - `test/schedule/scheduler.test.ts`.
- Modify:
  - `src/worker/timing.ts` (`scheduleEvery: 30_000`).
  - `src/api/config.ts` (`ServiceConfig.scheduler?: boolean | SchedulerTestSeam`).
  - `src/api/service.ts` (starts and stops it).
  - `src/api/serve.ts`, `src/api/mcp-serve.ts` and `src/worker/serve.ts` (turn it on).
  - `src/worker/main.ts` (`StartWorkerOptions.scheduler`).

**Interfaces:**
- Produces:
  - `fireDue(db: Db, deps: FireDeps, now: Date): Promise<{fired: number; skipped: number}>`. In one transaction per schedule:
    1. Claim with `select … from schedules where enabled and next_run_at <= $now [and tenant_id = any($onlyTenants)] order by next_run_at for update skip locked limit 1`.
    2. Re-check `next_run_at <= now`.
    3. Apply the skip rules in this order: `overlap`, `not-allowed`, `credentials_unreadable`.
    4. Or fire: `insertCrawl` with `scheduleId`, `chain: {render: schedule.render}`, `pinnedTo: deps.pin`, and the credentials read from the schedule and re-encrypted under the crawl id. Set `last_crawl_id`.
    5. Record the event and set `next_run_at = nextSlot(…, now)`.
    6. Loop until no due schedule remains.
  - `interface FireDeps { vault: CredentialVault; hostAllowed: (host: string) => boolean; pin: string | null; log: (l: string) => void; onlyTenants?: readonly string[] }`.
  - `class Scheduler`:
    - Constructed as `(databaseUrl: string, db: Db, deps: FireDeps & {instanceId: string; timing: Timing; lockKey?: number})`.
    - `start(): void`, `stop(): Promise<void>`, `isLeader(): boolean`, `tickOnce(now?: Date): Promise<void>`.
    - Not leading: try the lock each `scheduleEvery`.
    - Leading: `fireDue` each `scheduleEvery`.
    - An error on the dedicated client: log `scheduler: lost the leader lock — <message>`, end the client, and become a candidate again on a fresh client at the next tick.
    - `stop()` unlocks and ends the client.
    - A failed `fireDue` is logged and retried at the next tick. It never ends the process.

- [ ] **Step 1: Write the failing tests.** Each uses its own `lockKey` and `onlyTenants`.
  - (a) Two `Scheduler`s on one key: exactly one `isLeader()`.
  - (b) A due schedule fires once:
    - one crawl with `schedule_id` and `schedule_chain`
    - a `schedule_fired{crawlId}` event
    - `next_run_at` advanced past `now`
  - (c) Missed slots: `next_run_at` three slots in the past gives one fire.
  - (d) Overlap: the last fired crawl is `paused` (request). The next slot writes `schedule_skipped{reason:"overlap", crawlId}` and no crawl.
  - (e) Not-allowed: `hostAllowed` false gives a `not-allowed` skip.
  - (f) `credentials_unreadable`: the schedule row was written under an unknown key, so the result is a skip and no crawl.
  - (g) Review Focus 3: `pg_terminate_backend` on the leader's pid. Within `2 × scheduleEvery` the other leads, and over a slot boundary exactly one fire is recorded.
  - (h) Review Focus 5: another tenant's running crawl of the same host leaves the fired crawl `queued`, and the following slot is an `overlap` skip.
  - (i) Two concurrent `fireDue` calls on one due schedule give one fire (SKIP LOCKED).
  - (j) Review Focus 2: a DST date gives one fire for that day.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.**
  - **API service.** It builds a `Scheduler` when `config.scheduler` is set, with `pin` = its crawl pin (C4).
  - **Worker.** `startWorker` builds one with `pin: null`.
  - **Entry points.** `api:serve`, the stdio MCP entry and `worker:serve` set it.
  - **Shutdown.** The scheduler is stopped first.
- [ ] **Step 4:** `npx tsc --noEmit`, the new tests, the worker serve and main tests, then `npm test`.
- [ ] **Step 5:** Commit `feat: the scheduler — one leader by advisory lock, fires and skips (28c T5)`.

### Task 6: Chains

**Files:**
- Create:
  - `src/worker/chain-job.ts`.
  - `test/worker/chain.test.ts`.
- Modify:
  - `src/worker/crawl-job.ts` (the close hook enqueues the first link).
  - `src/worker/main.ts` (`kinds: ["crawl","render","rules"]`, executor by kind).
  - `src/api/service.ts` (the in-process runner takes all three kinds, pinned).
  - `src/worker/runner.ts` (only if the execute dispatch needs it).

**Interfaces:**
- Consumes: Task 2's links, Task 3's `chain`, and Task 1's `recordEvent`.
- Produces:
  - `crawlJobCloseHook(jobId, pinnedTo: string | null)`. On a `finished` close of a crawl whose `schedule_chain` is non-null, in the same transaction, it enqueues `render` when `chain.render !== null`, and `rules` otherwise, with the job's pin.
  - `chainJobExecutor(deps: {db; vault; registry; renderHtmlDir: string | null; allowPrivate; log; logPrefix}): (job, signal) => Promise<void>`.
    - It runs the link.
    - On success it settles the job `done` in one transaction, and enqueues `rules` after a `render`.
    - On a throw it settles the job `failed` with the reason (`jobError`) and records `schedule_chain_failed{link, reason}` in one transaction (crawl id set, `schedule_id` = `crawls.schedule_id`).
    - The runner's own settle then finds the job settled and writes nothing.
  - **Worker render.** A worker's chain render passes `renderHtmlDir: null`. An in-process service's chain render passes its `renderDir`.

- [ ] **Step 1: Write the failing tests.**
  - **(a) Two fires, compared.** A schedule with `render: null` is fired twice over the fixture by `fireDue`, run by an in-process service. Each crawl ends with `rules_finished{outcome:"done"}`, and `compareCrawls` on the two is `comparable: true`.
  - **(b) Render chain:**
    - With `render: {}`, the chain is crawl → render → rules, and the events appear in that order.
    - On a worker, `rendered_html_path` is null and `renderDocuments` is `"not kept"`.
  - **(c) A failing render link.** Chromium is made to fail to launch with `executablePath` pointing at a missing file, through the existing launch-error test seam. The result is `schedule_chain_failed{link:"render"}`, no rules job, and the crawl `finished`.
  - **(d) Paused or cancelled crawls.** A crawl that closes `paused` or `cancelled` enqueues nothing and writes no `schedule_chain_failed`.
  - **(e) Review Focus 4.** The schedule is deleted after the fire. The chain completes, its events have `schedule_id` null, and no job is left `queued` or `running`.
  - **(f) Unscheduled crawls.** A crawl from `crawl_start` (no chain) enqueues nothing on finish.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx tsc --noEmit`, the new tests, `test/worker/*.test.ts`, then `npm test`.
- [ ] **Step 5:** Commit `feat: schedule chains — crawl, render if asked, rules (28c T6)`.

### Task 7: The 28b carries

**Files:** `src/worker/crawl-job.ts`, `test/worker/reaper.test.ts`, `test/worker/jobs.test.ts`, `docs/gates/phase-28b.md`.

- [ ] **Step 1: Write the failing tests.**
  - (a) Inject a failing `finishJob` after a pre-loop failure. The log line names the job and the crawl, and the error propagates.
  - (b) The 0043 and 0044 partial-index predicates, read from `pg_indexes`, contain `AUTO_RESUME_LIMIT`'s value and each of `SYSTEM_PAUSE_REASONS`.
  - (c) A real `reapOnce` takes a live runner's job; the runner's instance is made dead by back-dating its heartbeat. That runner's close then meets `paused worker_lost`, throws `JobLostError`, and writes nothing.
- [ ] **Step 2:** Run the tests. (a) fails; (b) and (c) may pass already, and the report says which.
- [ ] **Step 3: Implement.**
  - Log the failed `finishJob`.
  - Correct `docs/gates/phase-28b.md` "Dev database note": the extra row was a duplicate `0027` record (ids 28 and 29), and row 29 was deleted with the owner's OK on 2026-11-12. Row 44 is `0042`.
- [ ] **Step 4:** The tests, then `npm test`.
- [ ] **Step 5:** Commit `fix: 28b carries — finishJob failure logged, index literals pinned, reap-vs-live-close test (28c T7)`.

### Task 8: The 50k gate in CI

**Files:**
- Create: `.github/workflows/gate.yml`.
- Modify: `scripts/gate-rules.ts`.

**Interfaces:**
- Produces:
  - `--json-out <path>` writes `{node, pages, passed, failures: string[], peaks: {crawlBytes, renderBytes, rulesBytes, overallBytes}, durationsMs: {crawl, render, rules, inferPageTemplates}}`.
    - It is written on success and on failure (from the `finally`).
    - A missing path after the flag throws, as `--exclude` does.
  - A printed line: `inferPageTemplates   <ms> ms` (the 27d open item).

- [ ] **Step 1:** Run `GATE_PAGES=200 node --import tsx scripts/gate-rules.ts --json-out <scratch>/g.json`. It fails on the unknown flag.
- [ ] **Step 2: Implement** the flag and the timing line. Write `gate.yml` per the Global Constraints:
  - Playwright install as in `ci.yml`.
  - The warning step reads `peaks.crawlBytes` with `node -e` and compares it with `290.2 * 1024 * 1024`.
  - `actions/upload-artifact@v4`.
- [ ] **Step 3:** Re-run the 200-page smoke. `g.json` parses, and `passed: true`. Run `npx tsc --noEmit`.
- [ ] **Step 4:** Commit `ci: weekly 50k memory gate with a JSON artifact (28c T8)`.

### Task 9: Docs, the gate script and the gate record

**Files:**
- Create:
  - `scripts/gate-schedules.ts`.
  - `docs/gates/phase-28c.md`.
- Modify:
  - `docs/talos-surface.md`: the new tools and routes, `renderDocuments`, `crawl_history`, the schedule semantics and the skip reasons.
  - `docs/talos-integration.md`: the obligations touched, which are 7 (system pauses and schedules) and 8 (schedule credentials).
  - `docs/deploy.md`: the scheduler runs in every process, and `gate.yml`.
  - `README.md`.
  - The skills under `skills/` that list tools.
  - `CLAUDE.md`: if the phase pointer needs it.

- [ ] **Step 1: Write `scripts/gate-schedules.ts`.**
  - **Database.** It refuses any database other than `ariadne_gate28c`.
  - **Processes.** It spawns two worker children through `scripts/run-worker-trusted.ts`, with schedulers on and a `scheduleEvery` of 30 s, against a small fixture site of 20 pages. A crawl plus rules there finishes in under 30 s.
  - **Schedules.** It creates three:
    - **S1:** `* * * * *`, `render: null`.
    - **S2:** `* * * * *`. Its first crawl is paused by `crawl_pause` once it starts, so its next slot is an `overlap` skip.
    - **S3:** a host allowed by the script's API service but absent from the workers' `ARIADNE_ALLOWED_DOMAINS`, giving a `not-allowed` skip.
  - **The kill.**
    - Over 10 minutes, it finds the leader from `pg_stat_activity.application_name` joined to `pg_locks` on `SCHEDULER_LOCK`.
    - It `kill -9`s the leader once, at a moment when S1 has no crawl running.
    - It starts a replacement worker so that two candidates remain.
  - **Asserts:**
    - S1 has exactly 10 `schedule_fired` events.
    - Each fired crawl has `rules_finished{done}`.
    - `compareCrawls` on two fired crawls is `comparable: true`.
    - S2 has at least one `overlap` skip and S3 at least one `not-allowed` skip.
  - **Report.** It prints `GATE PASSED` only when every clause's failure list is empty. This is the 28b lesson: a clause with failures can never print PASS.
- [ ] **Step 2:** Create `ariadne_gate28c` and migrate it. Run the gate script and keep its log in the SDD workspace.
- [ ] **Step 3: Gate clause 3 (an outward action; the controller asks the owner first).**
  - Push the branch and open the PR.
  - `gate.yml` runs on the PR (C6).
  - Record the run URL and the artifact's peaks.
- [ ] **Step 4: Write the docs and `docs/gates/phase-28c.md`.**
  - The gate doc covers:
    - each clause with its evidence
    - the deviations
    - the rulings from the ledger, each with what it costs if wrong
    - the open items carried forward: long host holds, `prom-client` deprecation, and per-tenant allowlists
  - Run the identifier guard.
- [ ] **Step 5:** `npx tsc --noEmit` and `npm test`. Commit `docs: Phase 28c in the surface, the integration seam and the gate (28c T9)`.

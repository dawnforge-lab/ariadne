# Phase 28c gate: scheduler, history, CI gate

Date: 2026-11-12. Spec: `docs/superpowers/specs/2026-11-11-phase-28-cloud-foundations-design.md`
("Gates" 28c, items 13 to 17). Plan: `docs/superpowers/plans/2026-11-12-phase-28c-scheduler.md`.
Branch `worktree-phase-28c`, built on `cf1f311` (main) plus the plan (`23a12db`). Code under test:
`0d55e5b` (Task 8's commit, the last product change) plus `4f35379`, which adds the gate script
and a command-line scheduler switch to the trusted test worker. This task otherwise adds docs, a
skill section, one tool-description word (`src/api/mcp.ts`: `schedule_create`'s allowlist code
was written `NOT_ALLOWED`; the code is `FORBIDDEN`), one route line in `src/api/http.ts`'s header
comment, and the identifier guard's field sources for the two new answer shapes.

**Verdict: clause 1 does not pass as the gate script states it, because of one product defect;
everything the spec's clause 1 names passed; clause 2 passes; clause 3 is pending.**

- **Clause 1:** in two full runs, a one-minute schedule fired **exactly 10 times in its 10 slots**
  while the leader was `kill -9`'d. Another candidate led **29.3 s** later. Each fire ran crawl
  and then rules, the compare is `comparable: true`, and the overlap and not-allowed skips were
  recorded.
- **The defect:** the script also checks that `schedule_history` answers the schedule's own
  events only (spec item 16: "one schedule's fires and skips"). It does not. It also answers
  every lifecycle event of the crawls the schedule fired (`queued`, `claimed`, `started`,
  `paused`, and on a finished crawl `finished` and the `rules_*` kinds), because those carry the
  schedule's id and the history lists by that id. That is a defect in earlier tasks' code (see
  "The defect" below). It is reported and not fixed here, and the script prints `GATE FAILED`
  until it is fixed.
- **Clause 2:** passes, by test and in the live run.
- **Clause 3** is the PR's run of `gate.yml`, pending.

All runs used a database made for them, `ariadne_gate28c`, on the dev container (`create database
ariadne_gate28c`, then `npm run db:migrate`: 50 migrations applied, 50 journal entries). The
script refuses any other database, and also one with a queued or running job, an enabled
schedule, or the scheduler lock already held. The dev database `ariadne` was never connected to
by the gate. `ariadne_gate28c` is kept; dropping it waits for the owner's OK.

```
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne_gate28c \
  node --import tsx scripts/gate-schedules.ts --log-dir=<dir>      # clauses 1 and 2, ~15 min
npx vitest run test/events/crawl-events.test.ts                     # clause 2's tested proof
```

The full logs are kept outside the repository, in the SDD workspace
(`.superpowers/sdd/2026-11-12-phase-28c-scheduler/gate-schedules-run-{1,2,3}.log`, with every
worker's own output under `gate-run-{2,3}/`).

## How the gate runs

- **The candidates.** The API service runs in the gate process (`crawlRunner: "workers"`,
  `scheduler: false`), so it accepts and answers and is NOT a candidate. Two
  `scripts/run-worker-trusted.ts --scheduler --schedule-every-ms=30000` children are the two
  candidates. They run on the production clock: `scheduleEvery` 30 s, heartbeat 10 s, dead after
  60 s, reaper every 30 s. Each uses the production lock key (`SCHEDULER_LOCK`, 2028004002) and
  fires every tenant's due schedules, which is why the database must be the gate's own. The
  scheduler switch is a command-line flag, never an environment variable (pinned in
  `test/worker/serve.test.ts`, beside the process-trust pin).
- **The leader** is read from the database, never from a process's own account. It is the
  backend in `pg_stat_activity` named `ariadne-scheduler:<instanceId>` that holds the granted
  advisory lock in `pg_locks` (classid = key >> 32, objid = key & 0xffffffff, objsubid = 1, in
  this database): the same test the scheduler applies to its own session. It was sampled every
  second for the whole run.
- **The timeline.** A scheduler's first lock try is one `scheduleEvery` after it starts. So the
  schedules are created only once a leader is seen (about 28 s after the workers boot), and never
  within 5 s of a minute boundary, so that all three share their first slot T0.
- **The schedules**, each in a tenant of its own, all `* * * * *` in `UTC`, all `render: null`:
  - **S1** crawls a 20-page loopback site (127.0.0.1, 50 ms a page). One crawl plus its rules
    takes about 3 s.
  - **S2** crawls a 600-page site (127.0.0.2, 100 ms a page). Its first crawl is paused with
    `POST /crawls/:id/pause` once 3 pages are stored.
  - **S3** names 127.0.0.5. The API's allowlist admits that host; the workers' allowlist, which
    is 127.0.0.1 to .4 in code, does not.
- **The kill.** Once only: after S1's third fire has finished its rules, with no S1 crawl or
  chain link live (the overlap read's own predicate) and S1's next slot at least 15 s away. The
  leader's process gets SIGKILL. A third worker (C) is then started, so two candidates remain.
- **The window** is T0 to T0 + 10 min. A fire is counted by its `schedule_fired` event's time.
  A slot cannot fire before it is due (the claim's predicate), and every fire in the run came
  within 21 s of its slot, so the count over the window is the count over the ten slots. The
  schedules are disabled when the window closes; any crawl S1 fired after it would be left to
  settle.

## 1. Two candidates; a one-minute schedule fires exactly 10 times while the leader is killed

Run `60c153` (run 3, the run of the committed script). The window ran from 16:54:00 to
17:04:00 UTC.

| | |
|---|---|
| leader before the kill | worker A `instance_ad1f1efd…`, from 16:53:44 (about 30 s after the workers started) |
| kill -9 | 16:56:16.798, worker A (pid 3468101), after S1's 3rd fire; nothing of S1 live; next slot 16:57:00 |
| replacement | worker C `instance_7936d445…` ready 16:56:18.7 |
| takeover | worker B `instance_57314c63…` leads at 16:56:46.073, **29,275 ms** after the kill (bound: one `scheduleEvery` + 5 s = 35 s) |
| leader samples | 652, **0** with two leaders |
| S1 fires in the window | **10**, per minute `[1,1,1,1,1,1,1,1,1,1]` |
| fire lag after each slot (s) | 14.2, 14.2, 14.2, 16.1, 16.1, 16.1, 16.0, 16.1, 16.1, 16.1 |
| S1 skips in the window | **0** |
| fires before / after the kill | 3 / 7 |
| candidates at the end | B and C, both live |

The lag is the leader's own tick phase: its 30 s interval runs from its own start. It moved by
2 s when worker B took over at 16:56:46, which is its own phase, and the fire of the 16:57 slot
came at 16:57:16. No slot was missed and none fired twice. Worker A logged
`leading (advisory lock 2028004002)` at 16:53:44; worker B logged the same at 16:56:46.

Run `4b824b` (run 2, the same script before the 1d check was split) gave the same picture:

- 10 fires, one per minute.
- The lag was 18.6 to 20.6 s.
- The kill came at 16:42:22.5 after fire 3.
- Takeover took **28,775 ms**.
- There were 0 S1 skips and 0 two-leader samples in 647 samples.

**Each fire ran crawl and then rules.** For each of the ten crawls, `GET /crawls/:id` is
`finished` with 20 pages and `renderDocuments: "not kept"`. `GET /crawls/:id/history` reads
exactly `queued, claimed, started, finished, rules_queued, rules_started, rules_finished`, with
`rules_finished` `{outcome: "done"}` after `finished`. No `render_*` event appears (the schedule
says `render: null`), and no `schedule_chain_failed`. Every event carries S1's `scheduleId`.

**The compare.** `GET /compare?baseCrawlId=<1st fire>&headCrawlId=<10th fire>` answered
`comparable: true` with no caveats (`crawl_ec9322c9…` against `crawl_751d5684…`; run 2 also
compared its first and tenth fires with `comparable: true`).

**The skips**, read through `GET /schedules/:id/history`:

- **S2** fired once, at its first slot. Its crawl `crawl_e2a9f025…` was paused at 16:54:15 (pause
  reason `request`). Each of its next **9** slots was `schedule_skipped` `{reason: "overlap",
  crawlId: "crawl_e2a9f025…"}`.
- **S3** fired **0** times and recorded **10** `schedule_skipped` `{reason: "not-allowed"}`. Its
  host saw **0** requests. Each skip was also logged by the leader
  (`siteUrl is on '127.0.0.5', which is not in this process's crawl allowlist`).
- Every fire and skip event carries `crawlId` null at the top level and names the crawl in
  `detail` (call C9).

### The defect

**The one failure of clause 1d:**

> schedule_history answers 4 events of kinds other than the schedule's own (queued, claimed,
> started, paused): its fired crawls' lifecycle events

S2's history held 1 `schedule_fired`, 9 `schedule_skipped`, and the paused crawl's `queued`,
`claimed`, `started` and `paused`. A schedule whose crawls finish (S1) would also list
`finished` and the three `rules_*` events of every fire: O(fires × lifecycle) in what the spec
calls "one schedule's fires and skips".

The cause is in two places:

- `ApiService.scheduleHistory` (Task 4) calls `listEvents(db, {tenant, scheduleId}, …)`
  (Task 1), which filters on `crawl_events.schedule_id` alone.
- Since Ruling P3, every lifecycle event of a fired crawl carries that id.

The tool description (`schedule_history`: "kind is schedule_fired …, schedule_skipped …, or
schedule_chain_failed") and Ruling P2 ("fires and skips … only readable through
schedule_history") describe the intended answer. `test/api/schedules.test.ts`'s history test
inserts only skip rows, so nothing caught it.

The likely fix is a kind filter on the schedule branch of `listEvents`: the three application
kinds, `APP_EVENT_KINDS`, which include `schedule_chain_failed` with its crawl id. Add a test
that fires a real crawl. That is outside this task and is reported to the controller.
`docs/talos-surface.md` and the crawl skill say so beside the description until it lands.

## 2. `crawl_history` reads a crawl that was paused, resumed and finished

**Tested:** `test/events/crawl-events.test.ts:206`, "(a) reads queued, claimed, started,
paused{request}, resumed{auto:false}, claimed, started, finished{pagesCrawled} — gate clause 2".
It passed in the full suite below.

**Live, run `60c153`:** after the window, S2 was disabled. Its paused crawl was then resumed with
`POST /crawls/:id/resume` (202, `queuePosition` 1), and it finished on worker B. Its chain then
ran, because a resumed fired crawl that finishes still enqueues its rules. `GET
/crawls/crawl_e2a9f025…/history`:

```
16:54:14 queued
16:54:14 claimed        {role: worker, instanceId: instance_ad1f1efd…}   (worker A, later killed)
16:54:14 started
16:54:15 paused         {reason: request}
17:04:06 resumed        {auto: false}
17:04:06 claimed        {role: worker, instanceId: instance_57314c63…}   (worker B)
17:04:06 started
17:05:16 finished       {pagesCrawled: 600}
17:05:16 rules_queued
17:05:16 rules_started
17:05:18 rules_finished {outcome: done}
```

Run 2 read the same sequence: claimed first by the worker that was later killed, then by the
replacement worker C.

## 3. `gate.yml` runs green once, and its artifact holds the peaks

**Pending: runs on the PR via the `pull_request` trigger (call C6).** GitHub dispatches only
workflows that already exist on the default branch, so `workflow_dispatch` on this branch is not
possible until it merges. `gate.yml` therefore also runs on a pull request that changes
`gate.yml`, which this PR does.

- Run URL: _(pending; the controller fills it)_
- Result and the artifact's peaks (`crawlBytes`, `renderBytes`, `rulesBytes`, `overallBytes`)
  and durations: _(pending)_

Task 8 ran the script's 200-page smoke locally (`GATE_PAGES=200 … --json-out`). It wrote
`passed: true`, crawl peak 246.7 MB and `inferPageTemplates` 5 ms. That is not the gate.

## Suite and tsc

- `npx tsc --noEmit`: clean.
- `npm test` (dev database): **174 files, 4,672 tests, all passing** (566 s), on the tree this
  file is committed with. Baseline before 28c (P4): 167 files, 4,520 tests; 28c added 7 files
  and 152 tests.
- `test/skills/identifier-guard.test.ts`: 25 of 25. It first flagged two citations on the new
  surface text:
  - one quoted test-title fragment shorter than its 16-character minimum (lengthened);
  - three skill tokens. The schedule and event fields (`lastCrawlId`, `scheduleId`) were not in
    its field sources, so the guard now also reads `ScheduleOut` (`src/api/service.ts`) and
    `CrawlEvent` (`src/events/events.ts`). One token, `detail.auto`, was reworded.

## Deviations from the spec and the plan (owner to check)

1. **The stdio MCP server is not a scheduler candidate** (controller ruling, Task 5). The plan's
   C3 turned it on. The spec says "every API and worker process", and the candidates are
   `api:serve` and `worker:serve`. A local user runs `worker:serve` or `api:serve` for schedules
   to fire; `docs/deploy.md`, `docs/talos-surface.md`, the README and the crawl skill say so.
2. **A further skip reason, `credentials_unreadable`** (C5). Nothing fires without its
   credentials.
3. **Error codes as implemented:** 400 `VALIDATION` and 403 `FORBIDDEN`, where the plan wrote
   `INVALID` and `NOT_ALLOWED` (Task 4 ruling; no such codes exist).
4. **`crawl_events.schedule_id` is `ON DELETE SET NULL`, not cascade** (P2), and
   `schedule_delete` deletes the schedule's own fire and skip events itself. This matches
   Review Focus 4: a fired crawl's lifecycle outlives its schedule.
5. **`resumed.auto` means "requeued by the reaper"** (P5), not "`auto_resume_count` rose". A
   shutdown requeue does not spend the count (28b R17) but is automatic.
6. **Due schedules are claimed `FOR NO KEY UPDATE SKIP LOCKED`**, not `FOR UPDATE` (Task 5
   ruling).
7. **Clause 3 runs on the PR's `pull_request` trigger** (C6), not on `workflow_dispatch` on
   the branch, which GitHub does not allow before merge.
8. **Clause 1 runs with worker processes** (the trusted child), not `docker compose`, as in
   28b (deviation 3 there): the loopback fixture needs `allowPrivate`, which is code-only. The
   API in the gate is deliberately not a candidate, so that the two candidates are the two
   workers and the killed leader is a worker.
9. **A leader that loses its lock waits one tick before trying again** (Task 5 ruling). This
   makes the takeover go to the other candidate.

The calls the plan made for the owner (C1 to C9) stand as written in the plan and are not
repeated here. In short:

- C1: lifecycle events by trigger.
- C2: a schedule stores its planned config and is not re-planned at fire.
- C3: the scheduler is opt-in in the library.
- C4: pins.
- C6: `gate.yml` on `pull_request`.
- C7: `renderDocuments` is derived.
- C8: `crawl` replaces the credentials.
- C9: a fire or skip carries `crawl_id` null.

## Rulings

From the ledger (`.superpowers/sdd/2026-11-12-phase-28c-scheduler/progress.md`), each with
what it costs if wrong.

- **P1:** Task 1 created `crawl_events.schedule_id` as a plain column; Task 3's migration added
  the foreign key, because `schedules` did not exist before Task 3. Cost if wrong: nothing (one
  ALTER).
- **P2:** `schedule_id` is set null on a schedule delete, not cascaded. `deleteSchedule` deletes
  that schedule's events with `crawl_id` null (fires and skips) in its transaction, and the
  lifecycle and chain events of fired crawls stay with `schedule_id` null. Cost if wrong: a
  deleted schedule's fire records are gone. They were readable only through `schedule_history`,
  which answers 404 once the schedule is gone.
- **P3:** Task 3's migration re-creates both trigger functions (crawl and job) to fill
  `schedule_id` from `crawls.schedule_id`. Cost if wrong: job events of scheduled crawls lack
  `schedule_id`. (P3 is also why the defect in clause 1d shows: every fired crawl's lifecycle
  carries the id that `schedule_history` lists by.)
- **P4:** the Task 0 baseline is 167 files / 4,520 tests on `f3356ef`. Cost if wrong: a stale
  baseline count, caught by Task 1's full run.
- **P5:** `resumed.auto` is "requeued by the reaper", marked by
  `set_config('ariadne.event_source','reaper', true)` in the reaper's transaction. Cost if
  wrong: one `set_config` line in the reaper.
- **Task 1:** `claimed.role` stays null when the claimer has no `instances` row. The event
  records what is true, and a RAISE would abort the suite's deliberately unregistered pins.
  Cost if wrong: an unregistered production claimer shows role null instead of failing loudly.
- **Task 1:** `claimNextJob` takes `for key share of qc skip locked` on the crawl row, to keep
  the claimed event's foreign-key lock from deadlocking against `FOR UPDATE` holders. Cost if
  wrong: a crawl mid-cancel or mid-delete is skipped by one claim tick.
- **Task 2:** Task 2's full suite was covered by Task 3's full run. Cost if wrong: a Task 2
  regression is caught one task later.
- **Task 4:** the plan's 400 `INVALID` is this codebase's 400 `VALIDATION`; the allowlist
  refusal stays 403 `FORBIDDEN`, as at `crawl_start`. Cost if wrong: a code rename across
  transports later.
- **Task 5:** schedules are claimed `FOR NO KEY UPDATE SKIP LOCKED`, because a fired crawl's
  events take KEY SHARE on the schedule through the foreign key, which `FOR UPDATE` would block
  until the fire commits. Cost if wrong: none found.
- **Task 5:** a fire or skip that finds no cron slot left disables the schedule (`enabled`
  false, `next_run_at` null) in the same transaction and logs it loudly; there is no new event
  kind. Cost if wrong: the disable is visible only in the log and in `schedule_get`.
- **Task 5:** the stdio MCP process is not a scheduler candidate (deviation 1). Cost if wrong:
  local users must run `worker:serve` or `api:serve` for schedules to fire.
- **Task 5:** a leader that loses the lock pauses one tick (deviation 9). Correctness rests on
  the `SKIP LOCKED` claim. Cost if wrong: a lone `api:serve` re-leads after up to 60 s, and
  missed slots fire once.
- **Task 6:** the stranded pinned chain link stays a documented minor. No deployed process
  fires pinned crawls; the only route to it is a stdio-MCP `crawl_resume` of a fired crawl, and
  `crawl_rules` or `crawl_render` adopts the link. Cost if wrong: a schedule skips as `overlap`,
  visibly and naming the crawl, until an agent runs `crawl_rules`.
- **Task 9:** Step 3 (push, PR, the `gate.yml` run) is the controller's, after asking the owner.
  Cost if wrong: none (ordering only).

## Open items carried forward

- **Long host holds.** Nothing bounds how long a live crawl keeps a host from other tenants'
  crawls (28b). Schedules make it more likely: a weekly crawl of a big site holds the host for
  its whole run.
- **`prom-client@15.1.3` deprecation** ("replaced by @prometheus-io/client"), carried from
  28b, together with the thin counters module for the crawl hot path.
- **Per-tenant domain allowlists.** The allowlist is still one operator-set list, and now also
  the leader's, at every fire. A multi-tenant Talos needs each tenant's domains on it.
- **The `schedule_history` defect above.** It needs fixing before merge.
- **The zombie leader during a network partition** (Task 5, recommended before merge).
  Server-side TCP keepalive defaults to about 2 h, so a leader cut off by a partition keeps the
  advisory lock: nothing fires and nothing is logged. The fix is to set per-session keepalives
  on the scheduler client (`-c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c
  tcp_keepalives_count=3`).
- **The per-tenant cap does not count a chain's render and rules links** in the worker pool
  (Task 6), a fairness gap.
- **A chain link pinned to a dead instance** (Task 6) waits until an agent adopts it. The
  backlog fix is for the reaper to abandon queued render and rules jobs pinned to a dead
  instance and record `schedule_chain_failed`, or for the overlap read to check link liveness.
- **`gate-rules.ts` JSON** (Task 8, recommended in the final wave):
  - the `inferPageTemplates` figure is a rescan of the collapsed population (a lower bound),
    not the crawl's own first pass;
  - peaks for phases not reached read 0, not null;
  - there is no `isGate` field, so a smoke's `passed: true` reads like a gate pass;
  - the failing path was never run.
- **Smaller deferred minors from the reviews** (ledger, "minor (deferred)"):
  - Stale comments: `crawls.status` (trigger 0046 is a third reader); `crawl_history`'s
    description hand-lists pause reasons.
  - Duplicated helpers: `messageOf` and `isRecord` appear in several modules; the chain shape
    is defined twice.
  - Layering: the link modules and `src/schedule/store.ts` import upward from `src/api`.
  - Test-only seams: the `beforeRead` seam sits on `runRulesLink`'s exported signature; an
    empty `onlyTenants` is refused per tick, not at construction.
  - Over-refusal: `Etc/GMT±N` zones are refused.
  - `render.urls` are not checked at create (they are checked at fire, Task 6).
  - A no-op update bumps `updated_at`.
  - Shutdown: client `end()` calls are untimed in two places.
  - Tests:
    - `blockedOn` matches the lock SQL database-wide;
    - the scheduler tests take `SCHEDULER_LOCK` with a blocking lock, so a local `api:serve`
      on the dev database makes them wait 60 s;
    - the `reaper.test.ts` JobLostError assert is dead;
    - several tests simulate rather than exercise their race (chain test (d); test (e) without
      a delete during a running link);
    - `crawl-events.test.ts` re-creates the reaper helpers.
  - Logging: three log lines per link failure, and a misleading "could not be settled" when a
    crawl is deleted mid-link.
  - Residual 40P01 windows: synchronous rules adopting a dead holder's job against
    `crawl_delete`. Postgres fails one side loudly.

## What did not go as first written

- **Run 1 (`67f03e`) was stopped by hand, about two minutes in.** The script waited for S2's
  crawl to reach `crawls.pages_crawled >= 1` before pausing it. That column is written only when
  the crawl closes (the surface doc says so; the script did not), so the 200-page crawl finished
  before the trigger fired. The script now counts stored `pages` rows, refuses a first crawl
  that is already past `running`, and serves 600 pages.
  - Run 1 was interrupted with SIGINT at a moment no job was live. Its handler then killed the
    workers without disabling the schedules, so the three schedules of `67f03e` were disabled by
    hand on `ariadne_gate28c`
    (`update schedules set enabled = false, next_run_at = null where enabled`, 3 rows).
  - The handler now disables the run's schedules before it exits.
  - Run 1's rows stay in the database: 2 S1 fires, 2 S2 fires, 2 S3 not-allowed skips. The
    machinery already worked there: crawl and rules in about 3 s, with one leader throughout.
- **Run 2 (`4b824b`) failed clause 1d on a check that named the wrong property.** The check
  required every event in the two schedule histories to carry `crawl_id` null (C9), which
  failed. What it had found was the defect above: the histories hold the fired crawls' own
  events, whose `crawl_id` is set.
  - The check now states the two properties apart: fires and skips carry `crawl_id` null, which
    holds, and the history answers the schedule's own kinds only, which fails.
  - Run 3 is that script, unchanged since, and committed.
  - Every other clause passed in both run 2 and run 3.
- The JSON of each run is in its log and is not committed. It holds instance ids, tenants and
  run ids only; no secret is sent by this gate.

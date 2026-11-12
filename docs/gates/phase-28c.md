# Phase 28c gate: scheduler, history, CI gate

Date: 2026-11-12. Spec: `docs/superpowers/specs/2026-11-11-phase-28-cloud-foundations-design.md`
("Gates" 28c, items 13 to 17). Plan: `docs/superpowers/plans/2026-11-12-phase-28c-scheduler.md`.
Branch `worktree-phase-28c`, built on `cf1f311` (main) plus the plan (`23a12db`).

Code under test: `d1413f8`. That is Task 8's `0d55e5b` plus three commits from this task:

- `4f35379`: the gate script, and a command-line scheduler switch for the trusted test worker.
- `50049da`: docs and this record.
- `d1413f8`: the fix the gate's first full runs called for. `schedule_history` now reads the
  schedule's own events only; see "What did not go as first written".

This task otherwise touches no product code beyond docs, a skill section, one tool-description
word, one route line in a header comment and the identifier guard's field sources:

- The word is in `src/api/mcp.ts`: `schedule_create`'s allowlist code was written
  `NOT_ALLOWED`; the code is `FORBIDDEN`.
- The route line is in `src/api/http.ts`'s header comment.
- The guard gains the two new answer shapes.

**Verdict: all three clauses pass. Clauses 1 and 2 pass on the code (run `ca43a7`, `GATE
PASSED`). Clause 3 passes: `gate.yml` ran green on PR #31 with peak 293.9 MB against the 512 MB
limit. Its advisory warning fired above 290.2 MB on the runner. A local run on the same head
read 275.5 MB (§3).**

- **Clause 1:** a one-minute schedule fired **exactly 10 times in its 10 slots** while the leader
  was `kill -9`'d. Another candidate led **28.4 s** later. Each fire ran crawl and then rules,
  the compare between two fired crawls is `comparable: true`, and the overlap and not-allowed
  skips are recorded in `schedule_history`, which holds the schedules' own events only.
- **Clause 2:** passes, by test and in the live run.
- **After the final review's fix wave** clauses 1 and 2 were run again on `adb89e9` (run 5,
  `da8fd7`): `GATE PASSED`, takeover 30.2 s after the kill (see the end of this file).
- **What it took:** the gate printed `GATE FAILED` twice before this. The first full failing run
  found a real defect (`schedule_history` returned its fired crawls' lifecycle events), fixed in
  `d1413f8`. The record of those runs is kept at the end.

All runs used a database made for them, `ariadne_gate28c`, on the dev container (`create database
ariadne_gate28c`, then `npm run db:migrate`: 50 migrations applied, 50 journal entries). The
script refuses:

- any database other than `ariadne_gate28c`;
- one with a queued or running job, or an enabled schedule;
- one where the scheduler lock is already held.

The dev database `ariadne` was never connected to by the gate. `ariadne_gate28c` is kept;
dropping it waits for the owner's OK.

```
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne_gate28c \
  node --import tsx scripts/gate-schedules.ts --log-dir=<dir>      # clauses 1 and 2, ~15 min
npx vitest run test/events/crawl-events.test.ts                     # clause 2's tested proof
```

The full logs are kept outside the repository, in the SDD workspace:
`.superpowers/sdd/2026-11-12-phase-28c-scheduler/gate-schedules-run-{1,2,3,4}.log`, with every
worker's own output and the API's log under `gate-run-{2,3,4}/`.

## How the gate runs

- **The candidates.** The API service runs in the gate process (`crawlRunner: "workers"`,
  `scheduler: false`). It accepts and answers, and it is NOT a candidate.
  - Two `scripts/run-worker-trusted.ts --scheduler --schedule-every-ms=30000` children are the
    two candidates, on the production clock: `scheduleEvery` 30 s, heartbeat 10 s, dead after
    60 s, reaper every 30 s.
  - Each uses the production lock key (`SCHEDULER_LOCK`, 2028004002) and fires every tenant's due
    schedules. That is why the database must be the gate's own.
  - The scheduler switch is a command-line flag, never an environment variable (pinned in
    `test/worker/serve.test.ts`, beside the process-trust pin).
- **The leader** is read from the database, never from a process's own account. It is the
  backend in `pg_stat_activity` named `ariadne-scheduler:<instanceId>` that holds the granted
  advisory lock in `pg_locks` (classid = key >> 32, objid = key & 0xffffffff, objsubid = 1, in
  this database). That is the same test the scheduler applies to its own session. The gate
  samples it every second for the whole run.
- **The timeline.** A scheduler's first lock try is one `scheduleEvery` after it starts. So the
  schedules are created only once a leader is seen (about 30 s after the workers boot), and never
  within 5 s of a minute boundary, so that all three share their first slot, T0.
- **The schedules**, each in a tenant of its own, all `* * * * *` in `UTC`, all `render: null`:
  - **S1** crawls a 20-page loopback site (127.0.0.1, 50 ms a page). One crawl plus its rules
    takes about 3 s.
  - **S2** crawls a 600-page site (127.0.0.2, 100 ms a page). Its first crawl is paused with
    `POST /crawls/:id/pause` once 3 pages are stored.
  - **S3** names 127.0.0.5. The API's allowlist admits it; the workers' allowlist (127.0.0.1 to
    .4, in code) does not.
- **The kill** happens once only, when three conditions hold: S1's third fire has finished its
  rules; no S1 crawl or chain link is live (the overlap read's own predicate); and S1's next slot
  is at least 15 s away. The leader's process gets SIGKILL, and a third worker (C) is started so
  that two candidates remain.
- **The window** is T0 to T0 + 10 min. A fire is counted by its `schedule_fired` event's time.
  A slot cannot fire before it is due (the claim's predicate), and every fire came within 26 s of
  its slot, so the count over the window is the count over the ten slots. The schedules are
  disabled when the window closes.

## 1. Two candidates; a one-minute schedule fires exactly 10 times while the leader is killed

Run `ca43a7` (run 4, on `d1413f8`). The window ran from 17:21:00 to 17:31:00 UTC.

| | |
|---|---|
| leader before the kill | worker A `instance_141ef33a…`, from 17:20:24 (about 30 s after the workers started) |
| kill -9 | 17:23:28.327, worker A (pid 3546083), after S1's 3rd fire; nothing of S1 live; next slot 17:24:00 |
| replacement | worker C `instance_1bc26dbb…` |
| takeover | worker B `instance_97b8e9a3…` leads at 17:23:56.703, **28,376 ms** after the kill (bound: one `scheduleEvery` + 5 s = 35 s) |
| leader samples | 672, **0** with two leaders |
| S1 fires in the window | **10**, per minute `[1,1,1,1,1,1,1,1,1,1]` |
| fire lag after each slot (s) | 23.8, 23.8, 23.8, 25.8, 25.8, 25.8, 25.8, 25.8, 25.8, 25.8 |
| S1 skips in the window | **0** |
| fires before / after the kill | 3 / 7 |
| candidates at the end | B and C, both live |

**Why the lag looks like that.** The lag is the leader's own tick phase: its 30 s interval runs
from its own start. It moved by 2 s when worker B took over, and B fired the 17:24 slot at
17:24:25.8. No slot was missed and none fired twice.

**Runs 2 and 3**, on the code before the fix, gave the same picture for this part of the clause.
Each had 10 fires, one per minute, and 0 S1 skips. Takeover took **28,775 ms** and **29,275 ms**.
Neither saw a two-leader sample (647 and 652 samples). Over the three runs the takeover was 28.4
to 29.3 s.

**Each fire ran crawl and then rules.**

- For each of the ten crawls, `GET /crawls/:id` is `finished` with 20 pages and
  `renderDocuments: "not kept"`.
- `GET /crawls/:id/history` reads exactly `queued, claimed, started, finished, rules_queued,
  rules_started, rules_finished`, with `rules_finished` `{outcome: "done"}` after `finished`.
- No `render_*` event appears (the schedule says `render: null`), and no
  `schedule_chain_failed`.
- Every event carries S1's `scheduleId`.

**The compare.** `GET /compare?baseCrawlId=<1st fire>&headCrawlId=<10th fire>` answered
`comparable: true` with no caveats (`crawl_fc7a6941…` against `crawl_75561cf2…`).

**The skips**, read through `GET /schedules/:id/history`:

- **S2** fired once, at its first slot. Its crawl `crawl_8267e618…` was paused at 17:21:25 (reason
  `request`). Each of its next **9** slots was `schedule_skipped` `{reason: "overlap", crawlId:
  "crawl_8267e618…"}`.
- **S3** fired **0** times and recorded **10** `schedule_skipped` `{reason: "not-allowed"}`. Its
  host saw **0** requests. The leader also logged each skip (`siteUrl is on '127.0.0.5', which is
  not in this process's crawl allowlist`).
- Every fire and skip event carries `crawlId` null at the top level and names the crawl in
  `detail` (call C9).
- **The histories hold the schedules' own kinds only:** S2 has `{schedule_fired: 1,
  schedule_skipped: 9}`, and S3 has `{schedule_skipped: 10}`. S2's fired crawl's `queued`,
  `claimed`, `started` and `paused` are in its `crawl_history`, not here. Run 3 failed on exactly
  this check; see the end.

**The fix's test** is `test/worker/chain.test.ts`, "schedule_history answers the schedule's own
events only; the fired crawl's lifecycle stays in crawl_history". It fires a real crawl through
`fireDue` and runs it to its rules. The schedule's history must be exactly
`[schedule_fired]`, while `crawl_history` holds the seven lifecycle events. Chain test (c) now
also reads a `schedule_chain_failed` in the schedule's history. Both failed before `d1413f8`.

**Plan.** The read is still driven by the partial index `crawl_events_schedule` (`schedule_id,
id`). The kind is a filter on the rows it walks. On `ariadne_gate28c`, with sequential scans
disabled to show the index path at this table's small size (256 rows), S1's history scans 80
index rows to return its 10. That is about 7 lifecycle rows walked per fire, O(fires ×
lifecycle) rows read for O(fires) answered. A partial index on the three schedule kinds would
make it exact; it is an open item.

## 2. `crawl_history` reads a crawl that was paused, resumed and finished

**Tested:** `test/events/crawl-events.test.ts:206`, "(a) reads queued, claimed, started,
paused{request}, resumed{auto:false}, claimed, started, finished{pagesCrawled} — gate clause 2".
It passed in the full suite below.

**Live, run `ca43a7`:** after the window, S2 was disabled and its paused crawl resumed with
`POST /crawls/:id/resume` (202, `queuePosition` 1). It finished on worker B. Its chain then ran,
because a resumed fired crawl that finishes still enqueues its rules.
`GET /crawls/crawl_8267e618…/history`:

```
17:21:23 queued
17:21:24 claimed        {role: worker, instanceId: instance_141ef33a…}   (worker A, later killed)
17:21:24 started
17:21:25 paused         {reason: request}
17:31:05 resumed        {auto: false}
17:31:05 claimed        {role: worker, instanceId: instance_97b8e9a3…}   (worker B)
17:31:05 started
17:32:18 finished       {pagesCrawled: 600}
17:32:18 rules_queued
17:32:18 rules_started
17:32:20 rules_finished {outcome: done}
```

Runs 2 and 3 read the same sequence.

## 3. `gate.yml` runs green once, and its artifact holds the peaks

**Passes, on the PR via the `pull_request` trigger (call C6).** GitHub dispatches only
workflows that already exist on the default branch, so `workflow_dispatch` on this branch is not
possible until it merges. `gate.yml` therefore also runs on a pull request that changes
`gate.yml`, which this PR does.

- Run URL: https://github.com/dawnforge-lab/ariadne/actions/runs/43303512174 (PR #31, head
  `59f5055`, 2026-11-12, 15 min 44 s). Job `gate`: **success**. The `gate-json` artifact was
  uploaded.
- The artifact (Node v22.23.4) reads `isGate: true`, `passed: true` and `failures: []`.

  | phase | peak (bytes) | MiB | duration |
  |---|---|---|---|
  | crawl | 305,606,656 | 291.4 | 609.7 s |
  | render | 306,917,376 | 292.7 | 8.7 s |
  | rules | 308,158,464 | 293.9 | 277.0 s |
  | overall | 308,158,464 | 293.9 | |

  `inferPageTemplatesRescanMs`: 282. The browser's RSS (1,251.2 MB, 14 processes) is not gated.
- **The warning step fired: `crawl phase peak 291.4 MB exceeds 290.2 MB`.** This is the designed
  annotation, not a failure. The design (item 17) sets the warning at the last local bound
  "since runner hardware differs from the dev machine". The hard limit is 512 MB, 218 MB above
  this peak.
- **Is it the runner or the code?** The same command was run locally on the same head, `59f5055`
  (`ariadne_gate28c`, Node v22.23.2). It peaked at **275.5 MB**: crawl 275.5, render 275.5, rules
  269.7. The crawl took 1,035.6 s and rules 374.3 s, and the result was `GATE PASSED`. That
  matches the earlier local runs without `--exclude` (275.7 MB and 281.5 MB in 27d §5) and sits
  under 290.2 MB, so 28c added no crawl-phase memory. The runner crawled 1.7× faster and read
  16 MB higher. That is the hardware difference the design anticipated. The weekly artifacts are
  now the drift series to watch. Each week's run is compared with the earlier runner figures,
  not with a local one.

Task 8 ran the script's 200-page smoke locally (`GATE_PAGES=200 … --json-out`). It wrote
`passed: true`, crawl peak 246.7 MB and `inferPageTemplates` 5 ms. That is not the gate.

## Suite and tsc

- `npx tsc --noEmit`: clean.
- `npm test` (dev database): **174 files, 4,673 tests, all passing** (526 s), on the tree this
  file is committed with (the fix `d1413f8` and these docs). Baseline before 28c (P4): 167
  files, 4,520 tests. 28c added 7 files and 153 tests. Before the fix the count was 4,672 (566
  s); the fix adds one test.
- After the final review's fix wave (`adb89e9` plus this record): `npx tsc --noEmit` clean;
  `npx vitest run`: **174 files, 4,685 tests, all passing** (547 s). The wave adds 12 tests: 3
  for dead chain links (I1), 5 for `render.urls` at write time (I2), 2 for the scheduler's
  keepalives and holder log (I3), 1 for the schedule view (M2), 1 for the `renderDocuments`
  index (M3).
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
  `schedule_id`. (P3 is also why `schedule_history` must filter by kind: every fired crawl's
  lifecycle carries the id it lists by. Run 3 found the missing filter; `d1413f8` added it.)
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
- **Task 9:** `schedule_history` was fixed inside Task 9 (`d1413f8`, "What did not go as first
  written", run 3) rather than sent back to Tasks 1 and 4. Cost if wrong: Task 1's
  `listEvents` and Task 4's `scheduleHistory` changed outside their own reviews; Task 9's
  review covered the change.
- **Task 9:** after run 1 was interrupted, its 3 schedules were disabled on `ariadne_gate28c` by
  a direct `update schedules set enabled = false, next_run_at = null where enabled` (run 1,
  below). Cost if wrong: a hand edit of a scratch gate database, recorded here; the dev database
  was not touched, and the script's SIGINT handler now disables its own schedules.
- **Final review I1:** a render or rules link whose process stopped is not retried. The reaper
  abandons it — running, or queued for a stopped pin — and records `schedule_chain_failed`
  `{link, reason: "the process running it stopped" | "the process it was pinned to stopped"}`
  in the same transaction; a queued pinned CRAWL job stays for `crawl_resume`. Cost if wrong: a
  deploy whose grace period is shorter than a link loses that fire's judgement, visibly (the
  event in both histories; `docs/deploy.md` says to size the grace period).
- **Final review I2:** `render.urls` are checked at `schedule_create`/`schedule_update` as far as
  knowable (URL policy, allowlist, the planned `renderMaxPages`), and "a 200 page of this
  crawl" stays a strict fire-time check. Cost if wrong: one missing page costs that fire its
  rules, visibly (`schedule_chain_failed` `{link: "render"}` naming the page).

## Open items carried forward

- **Long host holds.** Nothing bounds how long a live crawl keeps a host from other tenants'
  crawls (28b). Schedules make it more likely: a weekly crawl of a big site holds the host for
  its whole run.
- **`prom-client@15.1.3` deprecation** ("replaced by @prometheus-io/client"), carried from
  28b, together with the thin counters module for the crawl hot path.
- **Per-tenant domain allowlists.** The allowlist is still one operator-set list, and now also
  the leader's, at every fire. A multi-tenant Talos needs each tenant's domains on it.
- **An exact index for `schedule_history`.** The read walks `crawl_events_schedule`
  (`schedule_id, id`) and filters by kind, so it reads about 7 lifecycle rows per fire to
  answer one (clause 1, "Plan"). A partial index on the three schedule kinds would make the
  read O(answer). It is not needed at today's sizes: a weekly schedule writes about 400 rows a
  year.
- **The zombie leader during a network partition** (Task 5): **fixed in the final wave**
  (I3). The scheduler's session sets `tcp_keepalives_idle=30`, `tcp_keepalives_interval=10`
  and `tcp_keepalives_count=3`, so the server ends a partitioned leader's session about a
  minute after its last traffic instead of after the ~2 h default; a failed try logs the
  holder's `application_name`. `idle_session_timeout` was not set: a leader's session is idle
  while a long `fireDue` runs on the pool.
- **The per-tenant cap does not count a chain's render and rules links** in the worker pool
  (Task 6), a fairness gap.
- **A chain link pinned to a dead instance** (Task 6): **fixed in the final wave where a reaper
  runs** (I1): the reaper abandons it and records `schedule_chain_failed`. An in-process
  deployment runs no reaper (R10), so there the link still waits for an agent's `crawl_rules`
  (or `crawl_render`), and `close()` logs it with that remedy (M7).
- **`gate-rules.ts` JSON** (Task 8): **fixed in the final wave** (I4). The re-run must retype
  nothing and is named `inferPageTemplatesRescanMs`; phases not reached read `null`; the JSON
  carries `isGate`; a failed write fails the run loudly while the cleanup still runs (exercised:
  a write to a missing directory exited 1 with `FAIL: writing --json-out …`).
- **A synchronous `crawl_render`/`crawl_rules` on a fired crawl whose process dies mid-call**
  records `schedule_chain_failed` too (final review I1 keys on the crawl's `schedule_chain`, not
  on how the job was made). Such a call is not a chain link, so the event's kind overstates it;
  its reason ("the process running it stopped") is still true. Telling the two apart needs a
  marker on the job row.
- **Schedule event retention.** Fire and skip rows grow with the slots and are deleted only with
  their schedule: a `* * * * *` schedule writes about 525,000 a year, a weekly one about 50.
  Nothing prunes them yet.
- **`ScheduleOut` does not expose the stored crawl config** (owner call). A caller sees
  `siteUrl`, the cron, `render` and the credential names, not the planned config a fire will
  insert; `crawl_config_get` on a fired crawl shows it after the fact.
- **Smaller deferred minors from the reviews** (ledger, "minor (deferred)"):
  - Stale comments: `crawls.status` (trigger 0046 is a third reader); `crawl_history`'s
    description hand-lists pause reasons.
  - Duplicated helpers: `messageOf` and `isRecord` appear in several modules; the chain shape
    is defined twice.
  - Layering: the link modules and `src/schedule/store.ts` import upward from `src/api`.
  - Test-only seams: the `beforeRead` seam sits on `runRulesLink`'s exported signature; an
    empty `onlyTenants` is refused per tick, not at construction.
  - Over-refusal: `Etc/GMT±N` zones are refused.
  - `render.urls` are not checked at create (they are checked at fire, Task 6). Fixed in the
    final wave (I2), except the fire-time "a 200 page of this crawl".
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
  required every event in the two schedule histories to carry `crawl_id` null (C9), and it
  failed. What it had actually found was a defect: the histories held the fired crawls' own
  lifecycle events, whose `crawl_id` is set.
  - The check was split into the two properties: fires and skips carry `crawl_id` null, and
    the history answers the schedule's own kinds only.
- **Run 3 (`60c153`, the committed script, on `50049da`) printed `GATE FAILED` on that second
  property:**

  > schedule_history answers 4 events of kinds other than the schedule's own (queued, claimed,
  > started, paused): its fired crawls' lifecycle events

  - The cause: `ApiService.scheduleHistory` (Task 4) read `listEvents(db, {tenant,
    scheduleId})` (Task 1), which filtered on `crawl_events.schedule_id` alone. Since Ruling P3,
    every lifecycle event of a fired crawl carries that id.
  - So S2's history held its fire, its 9 skips and its paused crawl's `queued`, `claimed`,
    `started` and `paused`. A schedule whose crawls finish would have listed `finished` and the
    `rules_*` events of every fire too.
  - The spec (item 16, "one schedule's fires and skips"), the tool description and Ruling P2's
    premise all describe the schedule's own events.
  - Why no test caught it: `test/api/schedules.test.ts`'s history test inserted only skip rows.
  - **Fixed in `d1413f8`** (controller ruling, in this task): `listEvents`' schedule form
    filters to `APP_EVENT_KINDS`, which also includes `schedule_chain_failed`, the schedule's
    own record of a failed link. The test is in clause 1, RED before the fix and GREEN after.
  - Run 4 (`ca43a7`) on the fix passed every clause.
  - Every other clause passed in runs 2 and 3 as well.
- **Run 5 (`da8fd7`, on `adb89e9`, the final-review fix wave) printed `GATE PASSED`.** It was
  re-run because the wave changed the scheduler's connection (server-side keepalives, the
  holder log) and the reaper's handling of chain links. `ariadne_gate28c` was migrated to 0050
  first. Clause 1a: 10 fires in the 10 slots, the leader `kill -9`'d after S1's third fire,
  another candidate leading **30.2 s** after the kill (the gate's own 1 s sampler; run 4 read
  28.4 s — a candidate tries every 30 s, so the takeover lands up to one period after the
  session ends, plus the try itself). Clauses 1b–1d and 2 passed. Each non-leading candidate
  logged the holder once, e.g. `scheduler instance_c508…: does not lead: the leader lock is
  held by the session 'ariadne-scheduler:instance_2e3c…' (backend pid 123709, advisory
  2028004002)`, and again only when the holder changed. Log:
  `.superpowers/sdd/2026-11-12-phase-28c-scheduler/gate-schedules-run-5.log`, workers under
  `gate-run-5/`.
- The JSON of each run is in its log and is not committed. It holds instance ids, tenants and
  run ids only; no secret is sent by this gate.

# Phase 28b gate: workers

Date: 2026-11-11. Spec: `docs/superpowers/specs/2026-11-11-phase-28-cloud-foundations-design.md`
("Gates 28b"). Plan: `docs/superpowers/plans/2026-11-11-phase-28b-workers.md`. Branch
`worktree-phase-28b`, built on `763465c` (main at `96edfd7`, the merged 28a, plus the plan).
Code under test: `83bd9ef` for the gate scripts' last code change (Task 7's last code commit
is `174e782`; this task adds scripts, docs, skills and one test-guard change, and a one-line
optional metrics token in `scripts/run-worker-trusted.ts`).

**Verdict: clauses 1 to 6 pass on the code, and the compose smoke passes.** Two things this
file cannot show: the PR's first CI run (including the docker job, which was never run here, no
GitHub in this environment), and anything about a production host. The first run of
`gate-workers.ts` printed a pass that was not one (see "What did not go as first written");
every number below is from the second run, after the fix.

All gate runs used a database made for them, `ariadne_gate28b`, on the dev container
(`create database`, then `npm run db:migrate`: 45 migrations applied, 45 journal entries). The
dev database `ariadne` was neither modified nor connected to by any gate script (both refuse it
by name). `ariadne_gate28b` is kept; dropping it waits for the owner's OK.

Commands, all with `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne_gate28b`:

```
node --import tsx scripts/gate-workers.ts          # clauses 1, 2, 3, 4, 5 (live half)
node --import tsx scripts/gate-worker.ts           # clause 6, 50,000 pages
node --import tsx scripts/explain-claim.ts         # the claim's plan, open item
bash scripts/compose-smoke.sh                      # the images boot, migrate, register
npx vitest run test/ops test/api/tenant-isolation.test.ts   # clause 5's tested half
```

Clauses 1 to 4 use worker PROCESSES, not `docker compose` (deviation 3 below): the API service
runs in the gate process (`crawlRunner: "workers"`), and two `scripts/run-worker-trusted.ts`
children claim the jobs, on the production clock (heartbeat 10 s, dead after 60 s, reaper every
30 s), against loopback fixture hosts `127.0.0.1` to `127.0.0.4` that the gate serves itself.
Host keys include the port, so each fixture server is its own host.

## 1. Four tenants, four hosts: each claimed once, two at a time

`gate-workers.ts` run `392327`. Four tenants each start one crawl of its own fixture host (a
finite 40-page tree, 150 ms a page, one request in flight per crawl). The `jobs` rows are the
events: each crawl has exactly one job row, `kind crawl`, `done`, and two workers claimed them.

| tenant | host | claimed (UTC) | finished | worker |
|---|---|---|---|---|
| g28b-392327-c1-t1 | 127.0.0.1 | 23:31:03.033 | 23:31:09.852 | A (`...4c62dd`) |
| g28b-392327-c1-t2 | 127.0.0.2 | 23:31:03.086 | 23:31:10.214 | B (`...2877ba`) |
| g28b-392327-c1-t3 | 127.0.0.3 | 23:31:09.862 | 23:31:16.698 | A |
| g28b-392327-c1-t4 | 127.0.0.4 | 23:31:10.228 | 23:31:17.062 | B |

Sampled every 50 ms the most crawl jobs running at once was **2**, and the overlap of the
claimed-to-finished intervals, from the rows alone, is **2** at most. Each crawl wrote exactly 40
`pages` rows (40 distinct URLs), and no fixture host ever saw two requests in flight.

## 2. A fifth crawl of an already-running host waits

Same run. Tenant `c2-first` starts a 120-page crawl of `127.0.0.1:<port>`; once it is fetching,
tenant `c2-fifth` starts a 10-page crawl of the **same host**. For the whole **19.6 s** the first
crawl ran, sampled every 100 ms (187 samples), the fifth crawl's job was `queued` in **187 of
187** samples **while a worker was idle in 187 of 187** (the wait is host exclusivity, not a
missing worker). The first job finished at 23:31:00.615 and the fifth was claimed at
23:31:00.621, 6 ms later, on the worker that had just freed the host; it finished with 10 pages.
The host saw **1** request in flight at most.

## 3. `kill -9` of a worker mid-crawl

Same run, two parts, each a 150-page, 150 ms-a-page crawl:

**3b, the clause as written** (paused `worker_lost`, leases released, a resume finishes
elsewhere). The crawl's `auto_resume_count` is set to 3 first, exactly where three earlier
`worker_lost` requeues would leave it, so the reaper's `paused (worker_lost)` is a state the gate
can hold and read; the automatic requeue is part 3a. The worker holding the crawl is killed with
SIGKILL.

- The crawl was `paused` with `pause_reason worker_lost` **79.6 s** after the kill (bound 90 s).
- At that moment `crawl_status.liveLeases` was **0** and **0** frontier rows were `leased`.
- It stayed `paused` for three more seconds (cap spent: not requeued), then `crawl_resume`
  answered **202** and the crawl finished on the **other** worker: jobs `abandoned` (the victim)
  then `done` (a live worker other than the victim; the replacement worker spawned before the
  resume was equally eligible, and the check requires only that, not that it be the survivor).
- **150 `pages` rows, 150 distinct URLs.** That alone proves nothing (the `pages_crawl_url` unique
  index makes it impossible to fail), so the real check is the fixture's own request count: the
  host served **151 page requests for 150 pages**, against an allowance of 150 plus **1** (one
  request is outstanding when a worker with `maxConcurrency` 1 is killed; that fetch is lost and
  redone). A page re-fetched after the kill would push the count past 151 and fail the clause.

**3a, the automatic requeue** (cap not spent; 151 page requests for 150 pages in the final run too). Killed the same way, the crawl was requeued by the
surviving worker's reaper with `auto_resume_count` 1, finished on the surviving worker
(jobs `abandoned` then `done`), **150 rows, 150 distinct URLs**, **85.4 s** after the kill. In this
run the poll (every 50 ms) did not catch the `paused (worker_lost)` state, because the reaper
requeues in the same tick; the first run of the script caught it (paused, `worker_lost`, 0
leased rows, 64 s after the kill). 3b is therefore the evidence for the paused state.

## 4. A credentialed crawl, and the unreadable copies

**4a, a kill and a finish elsewhere.** A 150-page crawl of a fixture host that answers 401 unless a
request carries all three credential kinds (a request header, HTTP Basic auth and a cookie) is
started with `requestHeaders`, `httpAuth` and `cookies`. Its worker was killed with SIGKILL
mid-crawl; the requeued crawl finished on another worker: jobs `abandoned` then `done`,
**150 pages rows, none other than status 200 / `ok`**, and the gated host answered **0** 401s
over the whole run (every request, including the second worker's, carried the values; 151
pages were served, the extra one is the page in flight at the kill). The stored copy decrypts
(with the gate's key, read through `CredentialVault`) to exactly the values that were sent.

**4c, the unreadable copies.** One tenant has a running crawl; two credentialed crawls of a
gated host queue behind it (one running crawl per tenant). One's row is rewritten to name key id
`gate-rotated-away` (an unknown key id), the other has one byte of its GCM tag flipped. The
blocker is paused; the workers claim both. Each is `paused` with `pause_reason
credentials_unreadable`, **0 pages rows**, the gated host saw **0 requests** (no fetch before the
check), and `POST /crawls/:id/resume` with no body answers **409 `CREDENTIALS_REQUIRED`** for
each.

**4b, the secret scan.** After all of the above the gate probed five values (the header value,
the user name, the password, the cookie value and the Basic header's base64 form) against:
every `text`, `varchar`, `json`, `jsonb`, array and `bytea` column of every table in the schema
(**18 tables, 161 columns, 805 probes**, `crawl_credentials.ciphertext` and `nonce` included,
as UTF-8 byte searches: a ciphertext cannot contain a value, and none does), the API's log, every
response text the gate's client read, every `/metrics` scrape, and the stdout and stderr of
all **five** worker processes the run started (two killed, three live at the end). **No hit.**
Six `crawl_credentials` rows exist in the database, so the scan did read the table that holds
the values. (The rows of the first, discarded run of the script are in the same database and
were scanned too, with their own values, which differ per run.)

## 5. `/healthz`, `/readyz`, `/metrics`

Live half, in the same run: on the API and on each live worker, `/healthz` **200**, `/readyz`
**200**, `/metrics` with no token **401**, with the API token **401**, with the metrics token
**200**; no label VALUE in any scrape carries a tenant id, a crawl id, a host, an address or a
URL, and the label names are the engine's own (`kind`, `status`, `fetch_class`, `role`,
`outcome`, the histogram's `le`) plus those prom-client's default Node process metrics add
(`version`, `major`, `minor`, `patch`, `space`, `type`). The `instances` table held **1 api and
2 worker** live rows for the processes this gate started.

Tested half: `test/ops/health.test.ts` runs on a scratch database it creates, migrates and
drops, and shows `/readyz` answering **503** with `schema behind: N of M migrations applied`
against a database one migration behind (a migration row removed in a rolled-back transaction),
and the fixed `database unreachable` body for a database that is down, with no host, port or
error text in the body; `test/ops/metrics.test.ts` is the metrics label test (no tenant, crawl id,
host or URL in any label value, every metric name exposed);
`test/api/tenant-isolation.test.ts` pins `PRE_AUTH_ROUTES` as exactly the three routes and
in the sentinel's global list, and every other route still 401/400.
Run on the final code: 3 files, **168 tests, all passing** (`test/ops/metrics.test.ts` 4, `test/ops/health.test.ts` 17, `test/api/tenant-isolation.test.ts` 147).

## 6. The 50,000-page crawl as a worker job

`scripts/gate-worker.ts`: the parent serves the 50k fixture (`startSiteServer(50_000)`), enqueues
the crawl through the API service in `workers` mode (so the stored config and the job are what a
Talos call produces; `maxConcurrency` 16, `perHostDelayMs` 0 by the fixture's `crawlDefaults`, as
`gate-crawl.ts`, budget 55,000 for headroom as there), spawns one `scripts/run-worker-trusted.ts`
under `node --max-old-space-size=512`, and reads that child's `VmRSS` from
`/proc/<pid>/status` every 2 s until the crawl is `finished`.

Result, `gate-worker.ts` with `GATE_PAGES` unset (the gate), crawl `crawl_653e56d0-7906-4bd4-8efa-21245336ef55`:

```
PHASE 28b GATE, CLAUSE 6 — 50,000 pages as a worker job, peak RSS must be <= 290.2 MB (hard limit 512 MB)
status          finished
jobs            [{"kind":"crawl","status":"done","claimed_by":"instance_ebdbbfa6-..."}]
pages crawled   50,000
pages rows      50,000 (50,000 distinct URLs)
elapsed         1021.0s
throughput      49.0 pages/sec
rss samples     511 every 2s
PEAK RSS        188.3 MB (sampled, at +1021s); kernel VmHWM 188.3 MB
GATE PASSED (clause 6)
```

**The worker peaked at 188.3 MB against the 290.2 MB bound** (hard limit 512 MB), sampled and by
the kernel's own high-water mark (they agree). The run held between about 170 and 178 MB through the
page crawl and reached its peak in the final sample, taken when the crawl row turned `finished`
(the close runs template inference over every page, `docs/talos-surface.md` §4.1c). It was run once, on the final code; no
environmental failure, so no re-run. A 500-page smoke of the same script (`GATE_PAGES=500`, labelled
"NOT the gate") ran first to exercise it: 500 pages, 157.0 MB.

The 290.2 MB figure is the crawl phase of `gate-rules.ts`'s peak, which one process runs with
crawl, render and rules together; the weekly `gate.yml` keeps running that script, the recorded
command, unchanged.

## Compose smoke

`bash scripts/compose-smoke.sh` (project `ariadne-smoke`, throwaway secrets, torn down on exit):

```
migrate: exited 0
api /readyz: 200
worker <id> /readyz: 200      (two workers)
instances (live): api=1 worker=2
workers stopped: no live worker instance, 0 running crawls
SMOKE PASS
```

The images boot (one image, two roles, built by the script), `migrate` exits 0, `/readyz` is 200 on
the API and on both workers, the `instances` table holds **exactly 1 api and 2 worker** live rows
(the API registers at boot, ruling R18), and after `compose stop worker` no worker row is live and no
crawl is `running`. The CI docker job that builds the same image was not run (no GitHub here).

## Suite and tsc

- `npx tsc --noEmit`: clean.
- `npm test` (`DATABASE_URL` on the dev database): **167 files, 4,517 tests, all passing** (508 s),
  run on the tree this file is committed with. Baseline before 28b (ruling R2): 161 files, 4,340
  tests; 28b added 6 files and 177 tests.
- `test/skills/identifier-guard.test.ts`: 25 of 25. It reported two things on the new prose, both
  fixed: a skill sentence that backticked a pause-reason value it cannot classify as an identifier
  (reworded), and `ARIADNE_CREDENTIALS_KEY`, which the engine reads through a named constant
  (`env[CREDENTIALS_KEY_VAR]`), a form the guard's `env["NAME"]` scan did not follow. The guard now
  also resolves `env[CONSTANT]` through `const CONSTANT = "NAME"` under `src/`.

## Deviations from the spec and the plan (owner to check)

1. **Cap on auto-resumes, and only `worker_lost` spends it.** A crawl is auto-resumed at most
   **3** times (`crawls.auto_resume_count`; an agent's `crawl_resume` resets it). The spec's "system
   pauses resume by themselves" has no cap, and a crawl that kills its worker every time would
   loop forever (Review Focus 1). As amended by ruling R17, a graceful `shutdown` pause is
   requeued without spending it: only `worker_lost` counts.
2. **Rendered documents (spec item 13) wait for 28c.** In 28b workers run only `crawl` jobs.
   `crawl_render` stays synchronous in the API process, which keeps writing documents as today.
   The "worker keeps no documents" rule and `crawl_status.renderDocuments` arrive with 28c's
   unattended render chains, the only render jobs a worker will run.
3. **Gate clauses 1 to 4 run with worker processes** (`scripts/run-worker-trusted.ts`), not inside
   `docker compose`. Crawling the loopback fixture needs `allowPrivate`, which is code-only by
   design, so a container started from env can never crawl it. The compose smoke proves the images
   boot, migrate and report ready, and that instances register and go stale. The trusted child
   runs the same `startWorker` code and differs only in the process-trust argument (and in a
   reaper confined to the gate's own instances, which a test or gate on a shared database needs).
4. **`ServiceConfig.crawlRunner` defaults to `"in-process"`.** The library, MCP stdio and every
   existing test keep today's behaviour, and `api:serve` sets `"workers"`. This is a default for an
   embedding mode, not a fallback for an error.
5. **`crawls.host_key` is a stored column**, backfilled from `site_url`, rather than computed in the
   claim SQL, so the claim's eligibility check stays an indexed lookup (ruling R8 puts the port in it).
6. **`queuePosition` is tenant-scoped, not global** (ruling R12, answering an automated security
   review). The spec called a global position acceptable ("reveals load, not identity").
7. **Clause 3 is shown on the cap-spent path as well as the automatic one** (see 3b): the spec's
   "within 90 s the crawl is `paused`" and "a resume finishes" describe a state the automatic
   requeue passes through in milliseconds, so the gate holds it by spending the cap first.
   Both paths are recorded.

## Rulings

Taken from the ledger (`.superpowers/sdd/2026-11-11-phase-28b-workers/progress.md`), each with
what it costs if wrong.

- **R1:** Task 5's `startWorker` serves a liveness-only `/healthz` on `httpPort`; Task 6 replaced
  it with the shared handlers (`/healthz`, `/readyz`, `/metrics`). Cost if wrong: none; Task 6 replaced it.
- **R2:** the Task 0 baseline is the 28a final runs at `fa2d562` (161 files / 4,340 tests, tsc
  clean, CI green on PR #29); `96edfd7` is that tree merged plus the plan. Cost if wrong: a
  pre-existing failure misattributed to Task 1; Task 1's full run catches it.
- **R3:** `sitemap.invalid` keys "evidence records a walk" on `truncation.docsFetched > 0`, not
  `sitemapsRead > 0` (a boolean that is also true on the robots refusal). Cost if wrong: a walk
  that attempted no document but read one from cache; none exists, `docsFetched` counts attempts.
- **R4:** `persistSitemap` skips the sweep when `robots.outcome === "unreachable"` (that run
  persists no entries; sweeping would delete the walk kept under 28a R5). Cost if wrong: none.
- **R5 (28b):** `crawl_resume` decrypts in the API process only to check the stored copy is
  readable (the values are discarded), because the spec's synchronous 409 `CREDENTIALS_REQUIRED`
  for a wrong or rotated key needs it. Extended: `crawl_config_set` also decrypts, to merge a
  partial patch. Cost if wrong: plaintext briefly in API memory on a resume or a patch (the API
  already held it before 28b).
- **R6:** the MCP tool descriptions and the config-schema secret note were rewritten, because
  "memory only" was false after Task 2. Cost if wrong: Task 8's wording may need to match (it does).
- **R7:** a credentialed crawl with no stored row is treated as unreadable (paused
  `credentials_unreadable`; a resume answers `CREDENTIALS_REQUIRED`), matching spec item 10's "a
  row deleted by retention". Cost if wrong: none.
- **R8:** `host_key` includes the port when the URL names a non-default one (`127.0.0.1:41234`),
  hostname only otherwise (migration 0042 recomputes). A different port is a different server in
  practice, real sites use default ports, and without it every parallel test suite on `127.0.0.1`
  would serialise. Cost if wrong: two crawls of one host on two explicit ports may run together.
- **R9:** the per-tenant cap applies to unpinned (worker-pool) claims only. Pinned crawl jobs exist
  only in in-process mode (library, tests, stdio MCP: one tenant by process trust) and keep
  today's one-at-a-time runner. Host exclusivity applies to every claim (hard rule 9). Cost if
  wrong: an in-process runner could exceed a tenant cap it has no use for.
- **R10 (revised):** liveness decides "held". A job counts as held only while its
  `claimed_by`/`pinned_to` instance is live (heartbeat within `deadAfter`); every runner heartbeats
  its instance and `close()` marks it stopped at once. A queued crawl whose job is pinned to a
  non-live instance reports `queuePosition` null and is not "held by this server": `crawl_mark_failed`
  works and `crawl_resume` adopts it. Reaping and auto-requeue run only in runners built with
  `reaper: true` (workers; `api:serve`), and auto-requeue takes only crawls whose last crawl job was
  unpinned. Cost if wrong: local in-process adoption is explicit (on resume), not automatic, and a
  local MCP crawl paused by shutdown is not auto-resumed (unchanged from 27b).
- **R11:** `reapOnce` takes a TEST ONLY `onlyInstances` confining abandon, pause and requeue to those
  instances' jobs, so reaper tests with tight timings on the shared test database never touch another
  suite's rows; production never passes it (the trusted child uses it). Cost if wrong: none in production.
- **R12:** `queuePosition` counts only the caller's own tenant's queued crawl jobs ahead
  (tenant-scoped), answering the automated security review of Task 3. Cost if wrong: an agent no
  longer sees global load.
- **R13:** the claim and the crawl's `queued -> running` compare-and-swap stay separate statements;
  races end in `ClaimLostError` and an abandoned job. This overrides the spec's "inside the same
  transaction" wording. Cost if wrong: none observed; the race is tested.
- **R14:** Task 4 was dispatched as two units, 4a (claim eligibility, `HOST_BUSY`, tenant-scoped
  position) and 4b (the reaper, the cap, the credential sweep, abort on heartbeat failure), because
  the task plus its carries was too large for one review surface. Cost if wrong: one extra review cycle.
- **R15:** in-process services (no reaper) run the credential retention sweep on their own timer
  (`reapEvery`), so retention holds for `mcp:serve` and library use too. Cost if wrong: none.
- **R16 (revised):** the allowlist is re-checked where the crawl is about to run. Every process that
  runs crawl jobs requires `ARIADNE_ALLOWED_DOMAINS`; when a runner claims a crawl job it re-checks
  `siteUrl`, `legacyHosts` and `sitemapUrls` against its own allowlist before the loop starts, and a
  refusal closes the crawl `paused` with the new pause reason `not_allowed` (never auto-requeued).
  Cost if wrong: an operator must set the allowlist on workers too (it is in `docs/deploy.md` and
  the README).
- **R17:** only `worker_lost` counts toward the auto-resume cap; a `shutdown` pause is requeued
  without spending it (a graceful stop is a deploy, not a crash; the cap exists for a crawl that
  kills its worker every time). This amends deviation 1. Cost if wrong: a crawl whose worker is
  SIGTERMed repeatedly for its own fault requeues indefinitely.
- **R18:** the API registers its `instances` row eagerly at boot in workers mode (spec item 8:
  every process heartbeats its instance row), so the smoke asserts exactly 1 api and 2 worker
  rows. Cost if wrong: one idle instance row per API process.
- **R19 (final review):**
  - **Rule:** `/readyz` treats "schema ahead" (more migrations applied than this code knows) as **ready** and logs it once per change in count. "Schema behind" stays 503.
  - **Why:** during a migrate-then-roll deploy, the old replicas would otherwise all turn unready at once, an outage the deploy causes itself. Migrations here are additive. `docs/deploy.md` states the order.
  - **Cost if wrong:** an old binary keeps serving against a newer schema that is not additive.

The final whole-branch review was run on Sonnet, because Opus was capped by a usage limit until 2026-11-14. It found 0 Critical issues and 1 Important one (R19), plus 7 minors. The fix wave is `98d41ed` (167 files / 4,519 tests, compose smoke PASS), and its re-review is clean.

The PR #30 `/code-review` ran with Opus bug reviewers. Both found the same issue independently, and a separate Opus validator confirmed it:

- **Bug:** `crawl_cancel` locked the crawl row `FOR NO KEY UPDATE`. That lock does not conflict with the `FOR KEY SHARE` a job insert takes through its foreign key.
- **Consequence:** a render or rules job inserted between the cancel's busy re-check and its commit went through. A render pass then ran over a crawl that was cancelled under it, and could write its credentials back onto the cancelled crawl.
- **Fix:** `lockCrawlRow` now uses `FOR UPDATE`, as `deleteCrawl` and `setCrawlConfig` already did. The regression test, in `test/worker/reaper.test.ts`, holds a render job's insert open and asserts that the cancel waits on the row lock and then refuses. It failed before the fix.
- **CLAUDE.md compliance:** both checks were clean.
- **Tests:** after the fix, `npm test` on the dev database passes: 167 files / 4,520 tests (508 s). On `ariadne_gate28b`, which holds the 50k gate crawl, the run takes about 1,100 s, and the database-wide rules tests time out at 60 s there. That is the database's size, not this change.

## Accepted behaviours

- A resumed walk with a transiently failed or time-limited sitemap document sweeps that document's
  earlier `sitemap_urls` entries. This is consistent with the replaced evidence, and
  `sitemap.invalid` reports the failure.
- A stalled-but-alive runner can write pages for up to one heartbeat after its job is reaped. Closes
  are ownership-guarded.
- After a lost-job abort, the loop epilogue (`writeNotFoundProbe`, `recordSpacing`,
  `inferPageTemplates`) can overlap a requeued run's start. It converges at the requeued run's end.

## Security tradeoffs surfaced to the owner

From the automated security reviews of Tasks 3, 4a and 6 and the ledger:

- `HOST_BUSY` reveals that some crawl holds a host, never whose.
- One tenant's long crawl makes other tenants' crawls of the same host wait. Nothing bounds a live
  host hold yet.
- The first review of Task 6 found `/readyz` (before auth) putting a raw database error in its 503
  body; it now returns fixed classified reasons and logs the detail (fixed in Task 6 round 1).
- The first review of Task 7 found the Dockerfile resolving `tsx` outside the lockfile; `tsx` is now a
  runtime dependency (fixed in Task 7 round 1).

## Open items for 28c and later

- **Bound or time-slice long host holds.** Nothing limits how long a live crawl keeps a host from
  other tenants.
- **The claim under a long ineligible head** (the 4a review's EXPLAIN item), run here, below.
- **`prom-client@15.1.3`** carries an npm deprecation notice ("replaced by
  @prometheus-io/client"). The choice is recorded (Apache-2.0, a dependency like `undici`, nothing
  lifted so no `THIRD_PARTY_NOTICES.md` entry); a migration is an open item. The crawl modules also
  import the whole metrics module (prom-client and the DB-reading gauges); a thin counters module
  would isolate the hot path.
- **The rendered-documents rule (spec item 13)** moves to 28c (deviation 2).
- Smaller carries from the reviews: a failed `finishJob` after a pre-loop failure leaves a job
  `running` (log it); the 0043 partial-index literals are not pinned to `AUTO_RESUME_LIMIT` and
  `SYSTEM_PAUSE_REASONS`; no test of a real `reapOnce` taking a live runner's job and then that runner's
  close meeting `paused worker_lost`; `ARIADNE_CREDENTIALS_RETENTION_DAYS` is read by the worker (listed
  in the README and `docs/deploy.md`).

### The claim's plan with 10,000 ineligible jobs at the head

`scripts/explain-claim.ts`, on `ariadne_gate28b`, in a transaction that is rolled back (0 rows left
behind; the script refuses any other database). The claim's statement, under the global advisory
lock the runner takes, with **10,000 queued jobs ahead of the one eligible job**, each time:

| the 10,000 are ineligible because | execution time | plan |
|---|---|---|
| their host is held by a running job (each its own tenant) | **56.9 ms**, 30,240 buffer hits | `jobs_claim_order` index scan returns all 10,001 queued rows in claim order; for each, an index probe of `crawls` by primary key and a filter against the `busy_hosts` CTE removes it |
| their tenant is at its cap (one tenant, each on its own host) | **8.5 ms**, 18,635 buffer hits | `jobs_claim_order` index scan with the tenant-cap filter removes the first 10,000 without touching `crawls`, then one probe |

Both stay index scans (no sequential scan of `jobs` or `crawls`; the eligibility CTEs read the
handful of running jobs through `jobs_running_by_instance` and `jobs_running_kind_tenant`). The cost
is linear in the length of the ineligible head, and it is paid with the global advisory lock held, so
every other runner's claim waits that long. At 10,000 it is under 60 ms; at 100,000 it would be
about half a second, which is the point at which the per-claim cost deserves a look (for example a
lateral scan per host, or a bounded candidate window). Not a defect at the sizes the engine runs at.

## Fix round 1 (review of the first record)

The review accepted the gate's honesty, the scan breadth, the worker-RSS sampling and the docs
against the code, and asked for five changes, all made in `scripts/gate-workers.ts`, the surface
doc and this file; `gate-workers.ts` was then re-run in full on `ariadne_gate28b` (run
**`b2c286`**, all clauses PASS; clause 6 and the smoke are unchanged code and were not re-run):

1. **"No duplicate pages" was true by construction.** Replaced by the fixture's request count
   against the page count plus a stated in-flight allowance (1) in 3a, 3b and 4a. Run `b2c286`:
   3b 151 requests / 150 pages, 3a 151 / 150, 4a 151 served / 150 pages, all within the allowance.
2. The surface doc's `/metrics` sentence now says what is true (no label carries a tenant, crawl id,
   host or URL; the engine's metrics use five names; the default Node metrics add theirs).
3. 3a now asserts what it saw (reason `worker_lost`, 0 leased rows, within 90 s) when its poll
   catches the paused state, and the script header and this file say it may miss it (it did, again,
   in `b2c286`) while 3b holds it (`b2c286`: paused `worker_lost` 77.6 s after the kill, 0 live
   leases, 0 leased frontier rows).
4. 3b's finish is on "a live worker other than the victim", worded so above.
5. The scan fails if the vault holds no row (it held 9 in `b2c286`).

Run `b2c286` evidence otherwise matches the numbers above (clause 2: queued every sample with a
worker idle; clause 1: max 2 running; 4a: 0 401s, values intact; 4c: both `credentials_unreadable`
and 409; 4b: 18 tables, 161 columns, 805 probes, 13 texts, no hit; clause 5: 200/200, 401/401/200,
1 api and 2 workers). The tables in sections 1 to 4 quote run `392327`; the new run's figures
differ only in timings and ids.

## Dev database note

The dev database's `drizzle.__drizzle_migrations` has one orphan row: id 44, hash prefix
981a5c9c7a02, left by an earlier regenerated migration. So `/readyz` on the dev database answers
503. Cleaning it up waits for the owner's OK. The gate uses `ariadne_gate28b`.

## What did not go as first written

- **The first run of `gate-workers.ts` printed `GATE PASSED` when it should not have.** Its
  `record` wrapper counted only a failure list of its own, and each clause kept a local list it
  returned inside its evidence, so a failing clause still printed `PASS`. The evidence showed it:
  clause 5 listed eighteen failures and was marked passing. The wrapper now fails a clause whose
  returned `failures` is non-empty. The failures themselves were my label-name allowlist being
  narrower than the property (prom-client's default Node metrics add `version`, `major`, `minor`,
  `patch`, `space` and `type`); the property that matters, no tenant, crawl, host or URL in any label
  value, held and is checked on the values. The allowlist was widened for those six names and the
  whole gate re-run from the start. The numbers in this file are that second run.
- **Clause 3a did not catch `paused (worker_lost)` in the second or third run** (it did in the first); see 3.
  Clause 3b exists because of that.
- The scripts print their progress and a JSON summary; the full JSON of the second run is not
  committed (it holds instance ids and a run id only, no secret), and the clauses above quote it.

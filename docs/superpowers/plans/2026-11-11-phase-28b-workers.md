# Phase 28b — Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Crawls outlive the process that accepted them. They queue in the database and any number of worker processes claim them.
- A dead worker's crawl is paused and resumed elsewhere.
- Credentials are stored encrypted, so a rerun needs nothing from Talos.
- Every process has health and metrics endpoints.
- One Docker image runs either role.

**Architecture:**
- A `jobs` table replaces `ApiService.waiting`, `running`, `judging` and `rendering`.
- A `JobRunner` (`src/worker/runner.ts`) claims crawl jobs with `FOR UPDATE SKIP LOCKED`. It runs them through the existing `resumeCrawl(…, {expectStatus: "queued"})`.
- An `instances` table carries heartbeats. Any live process reaps dead ones on a timer.
- Credentials move from the in-memory `CredentialStore` to an AES-256-GCM `crawl_credentials` table, written in the same transaction as the crawl change.
- The HTTP API serves health and metrics before auth.
- `src/worker/serve.ts` is the worker role.

**Tech Stack:**
- TypeScript strict, Node 22, drizzle + Postgres 16, vitest.
- `node:crypto` (AES-256-GCM).
- New dependency: `prom-client` (Apache-2.0).
- Docker (Debian slim + Playwright Chromium).

**Spec:** `docs/superpowers/specs/2026-11-11-phase-28-cloud-foundations-design.md`. The relevant parts are §28b items 6–13 (item 10 is as amended by the owner: "We could do encrypted credentials for reruns") and Gates 28b. The carries come from `docs/gates/phase-28a.md` "Open items".

## Global Constraints

**Jobs.** Columns: `id`, `tenant_id`, `crawl_id`, `kind` (`crawl | render | rules`), `status` (`queued | running | done | failed | abandoned`), `pinned_to`, `claimed_by`, `claimed_at`, `heartbeat_at`, `queued_at`, `finished_at`, `error`, `ruleset_version`, `extraction_version`.
- At most one `queued|running` job per crawl, enforced by a partial unique index.
- A runner claims only jobs whose `ruleset_version` and `extraction_version` equal its own.

**Timings** live in `src/worker/timing.ts`. Every one is injectable in tests.
- Heartbeat every **10 s**.
- An instance is dead after **60 s** without a heartbeat.
- The reaper ticks every **30 s**.
- Dead instance rows are deleted after **1 day**.

**Pause reasons** are `request | shutdown | worker_lost | credentials_unreadable`.
- The reaper auto-requeues `shutdown` and `worker_lost`, credentialed crawls included.
- It never requeues `request` or `credentials_unreadable`.

**Claim eligibility.**
- No `crawl` or `render` job is `running` for the same host key. The host key is the seed host, lower-cased, without a leading `www.`.
- The tenant has fewer than `ARIADNE_TENANT_MAX_RUNNING` (default 1) running `crawl` jobs.
- Claim order is `queued_at`, then `id`.

**Concurrency.** `ARIADNE_WORKER_CONCURRENCY` defaults to 1. The memory contract is per crawl (hard rule 6).

**Credentials.**
- **Cipher.** AES-256-GCM with a fresh random 12-byte nonce per write. The associated data is `` `${crawlId}:${generation}` ``.
- **Keys.** `ARIADNE_CREDENTIALS_KEY` is required by every process that runs or accepts crawls. Its format is `<id>:<base64 of 32 bytes>`.
- **Previous key.** `ARIADNE_CREDENTIALS_KEY_PREVIOUS` is optional, in the same format, and used to decrypt only.
- **Retention.** `ARIADNE_CREDENTIALS_RETENTION_DAYS` defaults to 30. If set, it must be a positive integer.
- **Failures.** A missing or malformed key is a boot error. An unreadable row pauses the crawl as `credentials_unreadable`, and resume or render then answers 409 `CREDENTIALS_REQUIRED`.

**Plaintext never leaves memory.** Credential values never appear in a column (only `ciphertext bytea` holds them, encrypted), a log, an error, a response, a metric or an export.

**Health and metrics.**
- `GET /healthz` answers `{status:"ok"}` with no auth and no database call.
- `GET /readyz` takes no auth. It answers 200 `{status:"ready"}` after a database round trip when the applied migration count equals the code's. Otherwise it answers 503 `{status:"not_ready", reason}`.
- `GET /metrics` takes the bearer `ARIADNE_METRICS_TOKEN`, which is separate from the API token. If that token is unset, the route answers 404 and the process logs one boot line.
- These three are the only routes served before the API bearer and tenant checks. They are listed in an exported `PRE_AUTH_ROUTES` that the 28a sentinel treats as its global list.

**Metric labels never carry** a tenant id, crawl id, host or URL.

**Process trust.** `allowPrivate` and `recheckMinGapMs` stay code-only (`ServiceConfig.crawlDefaults`). No environment variable sets them.

**Migrations.** Generated with drizzle-kit as `0038`, `0039` and `0040`, and applied with `npm run db:migrate`. Never hand-apply SQL. Containers never migrate at boot.

**Ruleset.**
- `RULESET_VERSION` becomes `0.25.1` only if Task 1's `sitemap.invalid` change alters output. Otherwise it is unchanged, and Task 1's report says which.
- Every other task leaves rules untouched.

**No fallbacks** (hard rule 7). A missing required env var is a boot error naming the variable.

**Citations.** `docs/talos-surface.md` cites tests by line, and `test/skills/identifier-guard.test.ts` checks them. Every task runs that guard test and re-points line numbers only.

**Checks.** `npx tsc --noEmit` and `npm test` pass at every commit. `export DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`.

**Commit trailer**, on every commit:
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
```

## Review Focus

1. **A crawl that kills its worker every time,** for example by running out of memory on one page.
   - Auto-requeue would loop forever. So `crawls.auto_resume_count` caps auto-resumes at **3** per crawl.
   - The fourth `worker_lost` leaves it `paused` with `auto_resume_count = 3`. An agent's `crawl_resume` resets the count.
   - Test in Task 4.
2. **Two reapers on two live processes.**
   - Each dead job is reaped exactly once.
   - No live instance's job is ever reaped, even when its heartbeat is 59 s old.
   - Test in Task 4.
3. **Pausing a crawl that is queued but not yet claimed** removes its job in the same transaction.
   - A runner that claims at that instant gets `ClaimLostError` and writes nothing.
   - The crawl is never both paused and running.
   - Test in Task 3.
4. **A credential key rotated past a row** (`key_id` unknown to both keys).
   - The crawl pauses `credentials_unreadable`.
   - No request goes out without its credentials.
   - Re-supplying the credentials on `crawl_resume` overwrites the row, and the crawl runs.
   - Test in Task 2.
5. **SIGTERM on a worker mid-crawl.**
   - The crawl closes `paused` (`shutdown`) and its job is `abandoned`.
   - The worker's queued jobs stay `queued`.
   - Within one reaper tick another runner has the crawl `running` again.
   - Test in Task 5.

---

### Task 0: Baseline

- [ ] **Step 1:** At the plan commit, run `npx tsc --noEmit` and `npm test`, and record the counts in the ledger. Expected: 161 files and 4,340 tests, all passing.

### Task 1: The 28a carries

**Files:**
- Create: `src/tenant.ts`. `TenantId`, `TENANT_PATTERN`, `parseTenant`, `LOCAL_TENANT` and `tenantExportDir` move here.
- Delete: `src/api/tenant.ts`, with every import updated. Do not leave a re-export shim.
- Create: `drizzle/0038_*.sql`, adding `sitemap_urls.seen_at timestamptz not null`, backfilled to the crawl's `started_at`.
- Modify:
  - `src/db/schema.ts`.
  - `src/crawl/loop.ts`: `persistSitemap` (~3499) and its call site (~1823).
  - `src/rules/query/sitemap.ts` (~226–233).
- Test: append to `test/crawl/loop-resume-staging.test.ts` and `test/rules/sitemap-entries-query.test.ts`.

**Interfaces:**
- Produces:
  - `import { TenantId, … } from "../tenant.js"` for both crawl and api code.
  - `persistSitemap(db, crawlId, discovery, signal, onBatch, walkStartedAt: Date): Promise<boolean>`.
    - It upserts each entry with `seen_at = walkStartedAt` (on conflict, update `seen_at`).
    - After the last batch it runs `delete from sitemap_urls where crawl_id = $1 and seen_at < $walkStartedAt`.
    - A stop between batches skips the delete, so an interrupted persist never removes rows.

- [ ] **Step 1: Write the failing tests.**
  - (a) A crawl is paused after its walk while the sitemap lists `/a` and `/b`. The fixture then lists only `/a`, and the crawl is resumed. After the resumed walk, `sitemap_urls` for the crawl holds only `/a`.
  - (b) A resumed persist that is stopped after its first batch leaves the earlier rows in place, so the count is not reduced.
  - (c) `sitemap.invalid` on a crawl whose discovery evidence holds `robots.outcome: "unreachable"` beside a kept earlier walk (`sitemapsRead > 0`) whose `truncation.failures` has one failed document reports that document.
  - (d) The same rule on a crawl whose only discovery was robots-unreachable (`sitemapsRead = 0`) returns no findings, as today.
- [ ] **Step 2:** Run the tests. (a), (b) and (c) fail.
- [ ] **Step 3: Implement.**
  - Move the tenant module.
  - Write migration 0038 with the backfill edited into the generated file.
  - `persistSitemap` takes `walkStartedAt` (the run's discovery start time) and does the post-persist sweep.
  - `sitemap.invalid` judges `truncation.failures` whenever the evidence records a walk (`sitemapsRead > 0`), whatever the current robots outcome.
  - Bump `RULESET_VERSION` to `0.25.1` and refresh copy fixtures only if the existing rule tests show changed output. The report states which.
- [ ] **Step 4:** `npx tsc --noEmit`, the two test files, `test/crawl/loop-stop-early.test.ts`, the identifier guard, then `npm test`. All pass.
- [ ] **Step 5:** Commit `fix: 28a carries — sitemap_urls swept after a whole re-walk, sitemap.invalid on kept evidence, tenant module (28b T1)`.

### Task 2: Encrypted credentials

**Files:**
- Create: `src/crawl/credential-vault.ts` and `drizzle/0039_*.sql` (`crawl_credentials`; `crawls.credential_generation int not null default 0`).
- Modify: `src/db/schema.ts`, `src/api/config.ts`, `src/api/service.ts`, `src/api/serve.ts`, `src/api/mcp-serve.ts`, `src/crawl/control.ts` (`PAUSE_REASONS` gains `credentials_unreadable`).
- Delete: `src/api/credential-store.ts`.
- Rewrite: `test/api/credential-store.test.ts` as `test/api/credential-vault.test.ts`. `test/api/credentials-restart.test.ts` now pins that a restart **keeps** credentials.
- Modify: every test that constructs `ApiService`, `createApiServer` or `createMcpServer` gains `credentialKeys: TEST_CREDENTIAL_KEYS`, exported from `test/helpers/credential-keys.ts`.

**Interfaces:**
- Produces:
  - `type CredentialKey = { id: string; key: Buffer }` and `type CredentialKeys = { current: CredentialKey; previous?: CredentialKey }`.
  - `parseCredentialKeys(env): CredentialKeys`. It throws a boot `Error` naming the variable. It never quotes the value.
  - `class CredentialVault`, constructed as `(db: Db, keys: CredentialKeys)`:
    - `write(tx, tenant: TenantId, crawlId: string, creds: CrawlCredentials): Promise<number>` writes the row inside the caller's transaction, bumps `crawls.credential_generation`, and returns the new generation.
    - `read(crawlId: string): Promise<CredentialRead>`.
    - `remove(tx | db, crawlId: string): Promise<void>`.
    - `sweepExpired(now: Date, retentionDays: number): Promise<number>` deletes rows of crawls finished more than `retentionDays` ago and returns the count.
  - `type CredentialRead = { kind: "none" } | { kind: "ok"; credentials: CrawlCredentials; generation: number } | { kind: "unreadable"; reason: "unknown-key" | "auth-failed" }`.
  - `ServiceConfig.credentialKeys: CredentialKeys` is required. `ServiceConfig.credentialRetentionDays?: number` defaults to 30.
  - `crawls.credential_generation`.
  - `crawl_credentials` columns: `crawl_id` (pk, references `crawls` on delete cascade), `tenant_id`, `generation`, `key_id`, `nonce bytea`, `ciphertext bytea` (GCM tag appended), `updated_at`.

- [ ] **Step 1: Write the failing tests.**
  - **Round trip.** `write` then `read` gives `ok` and the same values.
  - **Associated data:**
    - Copying a row's `nonce` and `ciphertext` onto another crawl's row gives `unreadable/auth-failed`.
    - Flipping one byte of the ciphertext gives `auth-failed`.
    - Re-writing bumps the generation, and an old generation's ciphertext replayed onto the row gives `auth-failed`.
  - **Keys:**
    - A row written under key `k1`, read by a vault whose `current` is `k2` and `previous` is `k1`, gives `ok`.
    - With only `k2` it gives `unknown-key`.
    - `parseCredentialKeys` refuses each of: unset, missing `:`, non-base64, a 31-byte key. Every message names `ARIADNE_CREDENTIALS_KEY` and excludes the value.
  - **Restart (service level):**
    - A crawl started with `requestHeaders` on server A is resumed on a fresh server B (same database and keys) with no credentials sent. It runs and the fixture sees the header.
    - Server B with a different key answers `crawl_resume` with 409 `CREDENTIALS_REQUIRED`.
    - A queued credentialed crawl whose row is unreadable is closed `paused` with `pause_reason = "credentials_unreadable"` before any request reaches the fixture.
  - **`crawl_config_set`.** Changing header values keeps the shape. The runner that claims the crawl next sends the new values. This is the 27d R17 same-shape window, now closed.
  - **Removal.** `crawl_cancel` and `crawl_delete` remove the row.
  - **Retention.** `sweepExpired` removes a row whose crawl finished 31 days ago and keeps one whose crawl finished 29 days ago.
  - **Secret scan.** The existing scan in `test/fixtures/scope-and-requests.test.ts` still passes. Extend it so the `ciphertext` bytes of every `crawl_credentials` row contain none of the secrets as UTF-8.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.**
  - Write the vault and the migration.
  - In `ApiService`, `startCrawl`, `resumeCrawl`, `renderCrawl` and `setCrawlConfig` write through the vault inside their existing transactions.
  - The stage/settle machinery and the `afterConfigWrite` seam's settle phase go away. Keep `afterConfigWrite("written")` only if a test still needs it, and say which in the report.
  - `credentialsFor` and `runQueued` read through the vault. `unreadable` maps to `CREDENTIALS_REQUIRED` on resume and render. In the runner it closes the crawl `queued → paused` with `credentials_unreadable`.
  - `serve.ts` and `mcp-serve.ts` call `parseCredentialKeys(process.env)` at boot.
- [ ] **Step 4:** `npx tsc --noEmit`, the credential test files, the secret scan, `test/api/no-key-echo.test.ts`, the identifier guard, then `npm test`. All pass.
- [ ] **Step 5:** Commit `feat(credentials): AES-256-GCM vault in the database replaces the in-memory store (28b T2)`.

### Task 3: Durable queue: jobs, instances, the claim

**Files:**
- Create:
  - `src/worker/jobs.ts`: enqueue, claim, finish and the busy guard.
  - `src/worker/instance.ts`: register and heartbeat.
  - `src/worker/runner.ts`: `JobRunner`.
  - `src/worker/timing.ts`.
  - `drizzle/0040_*.sql`: tables `jobs` and `instances`, plus `crawls.host_key text not null` (backfilled from `site_url`) and `crawls.auto_resume_count int not null default 0`.
- Modify:
  - `src/db/schema.ts`.
  - `src/crawl/loop.ts`: `runCrawl` writes `host_key`.
  - `src/api/service.ts`: remove `waiting`, `running`, `judging`, `rendering`, `pump`, `dropFromQueue`; `queuePosition` and every guard listed below.
  - `src/api/http.ts` and `src/api/mcp.ts`: `crawl_status` gains `job`.
- Test: `test/worker/jobs.test.ts`, `test/worker/runner.test.ts`.

**Interfaces:**
- Produces:
  - `type JobKind = "crawl" | "render" | "rules"`.
  - `type InstanceRole = "api" | "worker" | "all"`.
  - `enqueueJob(tx, {tenant, crawlId, kind, pinnedTo?: string}): Promise<string>`.
    - It writes `ruleset_version` and `extraction_version` from the running code.
    - A second `queued|running` job for the crawl raises `ServiceError("CONFLICT", …)`. The message is the same sentence the in-process guard used for that operation.
  - `claimNextJob(db, {instanceId, kinds: JobKind[], pinnedTo: string | null}): Promise<ClaimedJob | null>`.
    - It is one transaction: the `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`, version-matched.
    - Task 4 adds host and tenant eligibility.
  - `finishJob(db, jobId, outcome: "done" | "failed" | "abandoned", error?: string): Promise<void>`.
  - `withPinnedJob<T>(db, {tenant, crawlId, kind: "render" | "rules", instanceId}, run: () => Promise<T>): Promise<T>`.
    - It inserts a `running` job pinned to the instance (the unique index is the busy guard), runs, then finishes it `done` or `failed`.
    - It replaces the `judging` and `rendering` sets.
  - `registerInstance(db, role: InstanceRole): Promise<string>` and `heartbeat(db, instanceId, runningJobIds: string[]): Promise<void>`.
  - `class JobRunner`, constructed as `(db, opts: {instanceId; kinds; pinnedTo: string | null; concurrency: number; execute: (job: ClaimedJob, signal: AbortSignal) => Promise<void>; timing?: Partial<Timing>})`.
    - `start()`, `stop(): Promise<void>` (stops claiming, aborts running jobs, awaits them) and `runningJobIds(): string[]`.
  - `ApiService.queuePosition(crawlId): Promise<number | null>`, now async from SQL:
    - `0` when its crawl job is `running`;
    - `1 + the number of queued crawl jobs ahead of it` when queued;
    - `null` otherwise.
  - `crawl_status.job: {kind, status, claimedBy?: string} | null`.
  - `ServiceConfig.crawlRunner?: "in-process" | "workers"`.
    - The default is `"in-process"`: the service owns a `JobRunner` over crawl jobs, which is today's behaviour, and every existing test relies on it.
    - `"workers"` runs none. Task 5's `serve.ts` sets it.
- Consumes: Task 2's vault (`runQueued` becomes the runner's `execute` for `crawl` jobs).

- [ ] **Step 1: Write the failing tests.**
  - **Claims:**
    - Two `claimNextJob` calls racing over one queued job give exactly one claim.
    - A job whose `ruleset_version` differs from the code's is never claimed.
  - **Pause and cancel of an unclaimed crawl** (Review Focus 3):
    - `crawl_pause` of a queued, unclaimed crawl abandons its job in the same transaction as `queued → paused`. A claim racing it yields `ClaimLostError` with no row written.
    - `crawl_cancel` does the same.
  - **Busy guards:**
    - A second `crawl_rules` while one runs answers the same 409 sentence as before 28b.
    - `crawl_resume`, `crawl_cancel` and `crawl_delete` while rules run answer their existing 409s.
    - These are the existing `test/api/lifecycle.test.ts` and `crawl-delete.test.ts` cases. They stay unchanged and passing.
  - **Queue position:** three queued crawls report positions `1`, `2` and `3`, and the running one reports `0`.
  - **Restart:** a crawl enqueued on server A and never claimed, with A closed, is claimed and finished by server B on the same database. Before 28b it was stranded.
  - **Status:** `crawl_status.job` shows `{kind:"crawl", status:"running", claimedBy}` while the crawl runs.
- [ ] **Step 2:** Run the tests; the new ones fail.
- [ ] **Step 3: Implement.** Every in-process guard becomes a database fact:
  - `refuseWhileBusy` and `refuseWhileJudging` check for a `running` render or rules job.
  - `refuseWhileStarting` refuses when the crawl's job is claimed while the crawl is still `queued`.
  - `markCrawlFailed`'s "held by this server" becomes "has a `queued|running` job".
  - `close()` stops the service's runner. Shutdown semantics are unchanged, so a running crawl pauses `shutdown`.
  - Its queued jobs stay queued, and its log line says so.
- [ ] **Step 4:** `npx tsc --noEmit`, the new tests, `test/api` and `test/crawl/loop*.test.ts`, the identifier guard, then `npm test`. All pass.
- [ ] **Step 5:** Commit `feat(worker): crawls queue in the database and are claimed with SKIP LOCKED (28b T3)`.

### Task 4: Fair claims, reaping, system pauses that resume

**Files:**
- Create: `src/worker/reaper.ts`.
- Modify: `src/worker/jobs.ts` (eligibility), `src/worker/runner.ts` (heartbeat and reaper timers), `src/crawl/control.ts` (`PAUSE_REASONS` gains `worker_lost`), `src/crawl/loop.ts` (only if `closeCrawl` needs the new reason), `src/api/service.ts` (`resumeCrawl` resets `auto_resume_count`).
- Test: `test/worker/reaper.test.ts`, appended to `test/worker/jobs.test.ts`.

**Interfaces:**
- Consumes: Task 3's tables and `JobRunner`; Task 2's `CredentialVault.sweepExpired`.
- Produces:
  - `reapOnce(db, {now: Date, timing: Timing, vault: CredentialVault, retentionDays: number}): Promise<ReapSummary>`.
    - `ReapSummary = {abandonedJobs: number; pausedCrawls: number; requeuedCrawls: number; credentialsSwept: number; instancesDeleted: number}`.
  - `reapOnce` does all of this in one tick:
    1. **Abandon dead jobs.** Every `running` or pinned-`queued` job whose instance's `heartbeat_at < now − deadAfter` becomes `abandoned`, using `FOR UPDATE SKIP LOCKED`.
    2. **Pause their crawls.** A `crawl` job's crawl, if `running`, becomes `paused` with `pause_reason = "worker_lost"`. Its frontier leases are released with `releaseLeases(db, crawlId, null, {refundAttempt: true})`.
    3. **Requeue system pauses.** A crawl that is `paused` with reason `shutdown` or `worker_lost` and `auto_resume_count < 3` goes to `queued`. Its count goes up by one and a `crawl` job is enqueued. This is the same state change as `crawl_resume`, done by the engine.
    4. **Sweep expired credentials.**
    5. **Delete dead instances** older than `instanceRetention`.
  - `claimNextJob` eligibility, in SQL:
    - no `running` `crawl` or `render` job exists for a crawl with the same `host_key`;
    - the tenant has fewer than `maxRunningPerTenant` running `crawl` jobs.
    - `maxRunningPerTenant` comes from `ARIADNE_TENANT_MAX_RUNNING`, a positive integer that defaults to 1. It is read where the runner is built.
  - Synchronous `crawl_render` refuses with 409 `code: "HOST_BUSY"` when a `running` crawl job holds the host. `ServiceErrorCode` gains `HOST_BUSY`, mapped to 409.
  - `JobRunner` heartbeats its instance and its jobs every `heartbeat`, and calls `reapOnce` every `reapEvery`.

- [ ] **Step 1: Write the failing tests** (`timing` injected: heartbeat 50 ms, deadAfter 300 ms, reapEvery 100 ms).
  - **Reaping:**
    - A job whose instance stopped heartbeating is abandoned. Its crawl goes `paused` (`worker_lost`), then is requeued in the same tick, and another runner finishes it with no duplicate `pages` rows.
    - A job whose instance heartbeat is `deadAfter − 10 ms` old is untouched (Review Focus 2).
    - Two `reapOnce` calls in parallel over one dead job report `abandonedJobs` summing to 1.
  - **Auto-resume:**
    - A crawl reaped `worker_lost` four times stays `paused` the fourth time with `auto_resume_count = 3` (Review Focus 1).
    - `crawl_resume` resets the count to 0.
    - A crawl paused by `crawl_pause` (`request`) is never requeued.
    - A crawl paused `credentials_unreadable` is never requeued.
  - **Fair claims:**
    - With two crawls of `a.test` and one of `b.test` queued and two runners, `a.test`'s second crawl waits until the first finishes.
    - With `ARIADNE_TENANT_MAX_RUNNING = 1`, tenant `t1`'s second crawl waits while `t2`'s runs.
    - `crawl_render` on a crawl whose host has a running crawl job answers 409 `HOST_BUSY`.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the new tests, `test/worker`, `test/api/lifecycle.test.ts`, the identifier guard, then `npm test`. All pass.
- [ ] **Step 5:** Commit `feat(worker): host- and tenant-fair claims, a reaper, and system pauses that resume (28b T4)`.

### Task 5: Roles, entry points, graceful shutdown

**Files:**
- Create:
  - `src/worker/main.ts`: `startWorker`.
  - `src/worker/serve.ts`: the env entry point.
  - `scripts/run-worker-trusted.ts`: a test and gate child that calls `startWorker` with `processTrust: {allowPrivate: true}` in code.
- Modify: `package.json` (`worker:serve`), `src/api/serve.ts` (`crawlRunner: "workers"`, registers as role `api`), `src/api/mcp-serve.ts` (role `all`, runs every kind).
- Test: `test/worker/serve.test.ts`.

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `startWorker(opts: {db: Db; credentialKeys: CredentialKeys; concurrency: number; maxRunningPerTenant: number; httpPort: number; metricsToken: string | null; processTrust?: Pick<CrawlConfig, "allowPrivate" | "recheckMinGapMs">; timing?: Partial<Timing>}): Promise<RunningWorker>`.
    - It registers an instance with role `worker`, starts a `JobRunner` over `crawl` jobs with `pinnedTo: null`, and serves `/healthz`, `/readyz` and `/metrics` on `httpPort`. Task 6 supplies the handlers.
  - `RunningWorker = {instanceId: string; port: number; stop(): Promise<void>}`.
  - `src/worker/serve.ts` reads its environment:
    - required: `DATABASE_URL`, `ARIADNE_CREDENTIALS_KEY`, `ARIADNE_WORKER_HTTP_PORT`;
    - optional: `ARIADNE_WORKER_CONCURRENCY`, `ARIADNE_TENANT_MAX_RUNNING`, `ARIADNE_METRICS_TOKEN`, `ARIADNE_CREDENTIALS_KEY_PREVIOUS`.
    - It never reads a process-trust variable.
    - On SIGTERM or SIGINT it runs `stop()`: stop claiming, abort running crawls (the loop closes them `paused`/`shutdown`), mark their jobs `abandoned`, and leave queued jobs queued. Then it closes the database and exits 0.

- [ ] **Step 1: Write the failing tests.** Spawn real child processes of `scripts/run-worker-trusted.ts` against the fixture site.
  - **Two workers:** with 4 queued crawls of 4 loopback fixture hosts (`127.0.0.1` to `127.0.0.4`) across 4 tenants, every crawl finishes. `jobs` shows exactly one `claimed_by` per crawl job, split across both instances.
  - **SIGTERM** (Review Focus 5): sending it to the worker holding a running crawl closes the crawl `paused` (`shutdown`) and abandons its job. The other worker has it `running` again within one reaper tick.
  - **Boot errors:**
    - `src/worker/serve.ts` with `ARIADNE_WORKER_HTTP_PORT` unset exits non-zero, naming the variable.
    - With `ARIADNE_CREDENTIALS_KEY` unset, the same.
  - **Process trust:** `src/worker/serve.ts` given `ALLOW_PRIVATE=1` or any other spelling still refuses a loopback crawl. The variable is never read.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the new tests, `test/worker`, the identifier guard, then `npm test`. All pass.
- [ ] **Step 5:** Commit `feat(worker): worker:serve role, trusted test child, graceful shutdown (28b T5)`.

### Task 6: Health and metrics

**Files:**
- Create:
  - `src/ops/health.ts`: `healthz` and `readyz`.
  - `src/ops/metrics.ts`: the registry and the metric objects.
- Modify:
  - `package.json`: `prom-client`.
  - `src/api/http.ts`: export `PRE_AUTH_ROUTES` and serve them before the bearer check.
  - `src/worker/main.ts`: the worker's HTTP server uses the same handlers.
  - Instrumentation points: `src/crawl/fetch-page.ts` (fetch duration), the loop writer (pages fetched by fetch class), `src/crawl/politeness.ts` (host escalations), `src/worker/runner.ts` (claim wait, job duration, peak RSS).
  - `test/api/tenant-isolation.test.ts`: `GLOBAL_ROUTES` gains the three routes, and a new assertion proves they answer with neither token nor tenant.
- Test: `test/ops/health.test.ts`, `test/ops/metrics.test.ts`.

**Interfaces:**
- Produces:
  - `PRE_AUTH_ROUTES: ReadonlyArray<{method: "GET"; path: "/healthz" | "/readyz" | "/metrics"}>`. `routeSignatures()` includes them.
  - `readyz(db): Promise<{status: 200; body: {status:"ready"}} | {status: 503; body: {status:"not_ready"; reason: string}}>`. The applied count comes from `drizzle.__drizzle_migrations` and the code's count from `drizzle/meta/_journal.json` entries.
  - Metric names:
    - `ariadne_jobs` (gauge; labels `kind` and `status`; read from the database at scrape time);
    - `ariadne_job_claim_wait_seconds` (histogram);
    - `ariadne_job_duration_seconds` (histogram; labels `kind` and `outcome`);
    - `ariadne_pages_fetched_total` (counter; label `fetch_class`);
    - `ariadne_fetch_duration_seconds` (histogram);
    - `ariadne_host_escalations_total` (counter);
    - `ariadne_instances_alive` (gauge; label `role`);
    - `ariadne_crawl_peak_rss_bytes` (gauge);
    - plus `prom-client` default process metrics.

- [ ] **Step 1: Write the failing tests.**
  - **`/healthz`:** answers 200 `{status:"ok"}` with no `Authorization` and no tenant. It answers the same while the database is unreachable (a server built on a pool pointing at a closed port).
  - **`/readyz`:**
    - answers 200 on a migrated database;
    - answers 503 with a `reason` naming the count mismatch on a database whose `__drizzle_migrations` has one row removed (do this inside a rolled-back transaction or on a scratch database, never the dev database's real table);
    - answers 503 when the database is unreachable.
  - **`/metrics`:**
    - without a token answers 401;
    - with the API token instead of the metrics token answers 401;
    - with no `ARIADNE_METRICS_TOKEN` configured answers 404.
  - **No forbidden labels:** after a crawl, `/metrics` text contains every metric name above. No label value equals the crawl id, the tenant, the fixture host or any crawled URL; the test asserts against that forbidden list.
  - **Sentinel:** the three routes are in `GLOBAL_ROUTES`, and every other route still answers 401 without a token and 400 without a tenant.
  - **Worker:** the worker HTTP server answers all three the same way.
- [ ] **Step 2:** Run the tests; they fail.
- [ ] **Step 3: Implement.** Add `prom-client` to `THIRD_PARTY_NOTICES.md` only if its licence policy requires it for a dependency (nothing is lifted). The report says which.
- [ ] **Step 4:** Run the new tests, the tenant sentinel, the identifier guard, then `npm test`. All pass.
- [ ] **Step 5:** Commit `feat(ops): healthz, readyz and Prometheus metrics before auth (28b T6)`.

### Task 7: Image, compose, CI build

**Files:**
- Create:
  - `Dockerfile`.
  - `.dockerignore`.
  - `docker-compose.yml`, with services `postgres`, `migrate` (one-shot `npm run db:migrate`), `api` and `worker` (scale 2).
  - `docs/deploy.md`.
- Modify: `.github/workflows/ci.yml`, adding a `docker` job that builds the image on every PR and pushes nowhere.

**Image requirements:**
- `node:22-bookworm-slim`, `npm ci --omit=dev` plus `tsx` (the repo has no build step; the image runs `node --import tsx`), and `npx playwright install --with-deps chromium` (which brings `fonts-liberation`).
- A non-root `ariadne` user. The command picks the role: `api` runs `node --import tsx src/api/serve.ts`, `worker` runs `node --import tsx src/worker/serve.ts`, and `migrate` runs `npm run db:migrate`.
- `HEALTHCHECK` curls `/healthz` on the role's port.
- Chromium's sandbox must start as the non-root user. If it cannot under Docker's default seccomp profile:
  - the render pass fails loudly as it does today (`render_launch_error`);
  - `docs/deploy.md` and the compose file state the setting that makes it start (for example `security_opt`), with the reason;
  - `--no-sandbox` is never used.

- [ ] **Step 1: Write the verification script** `scripts/compose-smoke.sh`. It runs `docker compose up -d --build --scale worker=2` and waits for `migrate` to exit 0. Then it checks:
  - `/readyz` on the API and on both workers is 200;
  - `select role, count(*) from instances` shows 1 `api` and 2 `worker`;
  - `docker compose stop worker` leaves both workers' instance rows stale and marks no crawl `running`.

  Finally it runs `docker compose down -v`.
- [ ] **Step 2:** Run it. It fails before the files exist.
- [ ] **Step 3: Implement.** If building and running Docker is unavailable in this environment, report it rather than guessing, with what was verified.
- [ ] **Step 4:** Run the smoke script, then the CI job locally as far as possible (`docker build .`). Both pass.
- [ ] **Step 5:** Commit `build: one image, two roles; compose for local and the 28b gate (28b T7)`.

### Task 8: Docs, skills, gate

**Files:**
- Modify:
  - `docs/talos-surface.md`: a dated Phase 28b summary; `crawl_status.job`; the pause reasons; `CREDENTIALS_REQUIRED`'s new rarity; `HOST_BUSY`; the three pre-auth routes; the env vars.
  - `docs/talos-integration.md`:
    - Obligation 7 amended: system pauses resume by themselves, up to 3 auto-resumes; an agent's pause is never undone.
    - Obligation 8 rewritten: Talos is still the source of truth; Ariadne keeps an AES-256-GCM copy for reruns, under a key the database never holds; values never reach a log, response, metric or export.
    - The runtime requirements.
  - `skills/ariadne-crawl/SKILL.md`: `ARIADNE_CREDENTIALS_KEY` for local MCP.
  - `README.md`: env vars.
- Create: `scripts/gate-workers.ts`, `scripts/gate-worker.ts` (the 50k crawl as a job in a `run-worker-trusted` child), `docs/gates/phase-28b.md`.

- [ ] **Step 1: `scripts/gate-workers.ts`.** It takes a database URL. It runs the API service in-process with `crawlRunner: "workers"`, plus two `run-worker-trusted` children, then proves Gates 28b clauses 1–4 and prints a JSON summary:
  1. Four tenants × one crawl of four loopback fixture hosts are each claimed once, running two at a time.
  2. A fifth crawl of a host already running waits.
  3. `kill -9` of a worker mid-crawl gives `paused`/`worker_lost` within 90 s, with leases released. The crawl is requeued and finishes on the other worker with no duplicate `pages`.
  4. A credentialed crawl `kill -9`'d and finished elsewhere has its values intact. A secret scan of every table, both children's stderr and `/metrics` finds no plaintext. Unknown-key and flipped-tag rows each give `paused`/`credentials_unreadable` and a 409 on resume.
- [ ] **Step 2: `scripts/gate-worker.ts`.**
  - The parent starts `startSiteServer(50_000)` and inserts a `crawls` row plus a `crawl` job with the gate-crawl config.
  - It spawns `run-worker-trusted` (`--max-old-space-size=512`) and samples the child's `VmRSS` from `/proc/<pid>/status` every 2 s until the crawl is `finished`.
  - It prints the peak and fails above **290.2 MB**.
- [ ] **Step 3: Run the gates on a fresh database.**
  - Create `ariadne_gate28b` on the dev container, then run `npm run db:migrate` against it.
  - Run `gate-workers`, `gate-worker` and `scripts/compose-smoke.sh`.
  - Keep the database until merge. Drop it only with the owner's OK.
- [ ] **Step 4: Write `docs/gates/phase-28b.md`:**
  - clauses 1–6 with their evidence;
  - the plan's deviations, the rulings and the open items for 28c.
- [ ] **Step 5:** Run `npx tsc --noEmit`, `npm test` and the identifier guard. All pass.
- [ ] **Step 6:** Commit `docs: Phase 28b workers in the surface, the integration seam and the gate (28b T8)`.

## Deviations from the spec (owner to check)

1. **Cap on auto-resumes.** A crawl is auto-resumed at most **3** times (`crawls.auto_resume_count`; an agent's resume resets it). The spec's "system pauses resume by themselves" has no cap, and a crawl that kills its worker every time would loop forever (Review Focus 1).
2. **Rendered documents (spec item 13) wait for 28c.** In 28b workers run only `crawl` jobs. `crawl_render` stays synchronous in the API process, which keeps writing documents as today. The "worker keeps no documents" rule and `crawl_status.renderDocuments` arrive with 28c's unattended render chains, which are the only render jobs a worker will run.
3. **Gate clauses 1–4 run with worker processes** (`scripts/run-worker-trusted.ts`), not inside `docker compose`.
   - Crawling the loopback fixture needs `allowPrivate`, which is code-only by design, so a container started from env can never crawl it.
   - The compose smoke proves the images boot, migrate and report ready, and that instances register and go stale.
   - The trusted child runs the same `startWorker` code. It differs only in the process-trust argument.
4. **`ServiceConfig.crawlRunner` defaults to `"in-process"`.** The library, MCP stdio and every existing test keep today's behaviour, and `api:serve` sets `"workers"`. This is a default for an embedding mode, not a fallback for an error.
5. **`crawls.host_key` is a stored column**, backfilled from `site_url`, rather than computed in the claim SQL. The claim's eligibility check stays an indexed lookup.

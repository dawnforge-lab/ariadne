# Phase 27b: Lifecycle and the config schema — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent pause, cancel and delete a crawl, and read and change a crawl's settings through one published schema. A shutdown becomes a pause, `cancelled` comes to mean only "an agent cancelled it", and HTTP and MCP accept exactly the same fields.

**Architecture:**
- **Control goes through the database.**
  - A new `crawls.control_request` column (`pause | cancel`) is set by the command.
  - A `ControlWatcher` (`src/crawl/control.ts`) polls it once a second for the whole run and aborts the run's signal.
  - The loop already stops on that signal at batch boundaries, in the admit and claim waits, and in the recheck and resource passes. `fetchPage` now takes the signal too, so in-flight fetches are aborted.
  - One `UPDATE … CASE` at close turns "stopped" into `paused` (`pause_reason` `request` or `shutdown`) or `cancelled`.
- **The service owns the immediate cases.** These are a queued crawl and a paused crawl. The service also owns the in-process guards (rules runs and render passes) and delete.
- **One zod 4 schema** in `src/api/config-schema.ts` is the start body, the published JSON Schema (`z.toJSONSchema`, draft 2020-12), the per-field mutability, and the parser both transports use. It replaces `START_CRAWL_FIELDS`, `parseStartCrawlInput` and `mcp.ts`'s `crawlStartShape`.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16, drizzle-orm + drizzle-kit, zod 4.4 (already a dependency; `z.toJSONSchema`, `.meta()`, `z.partialRecord`), vitest, MCP SDK 1.30.

**Spec:** `docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md`, the sections "27b — Lifecycle and the config schema" and "Gate 27b", plus "Surface" and "Calls I made" 7, 8, 9, 16 and 17 (owner-approved 2026-11-08). Read them before any task. 27c is a later plan.

## Global Constraints

- **Rules:** CLAUDE.md hard rules 1–10, and the user rule "Do not create fallbacks, we want transparent errors that can be fixed not hiding them".
  - **Rule 7:**
    - A control or pause value this engine did not write throws and names the crawl.
    - A control poll that fails ends the run `failed` with that error. It is never treated as "no request".
    - An aborted fetch is never written as a row.
  - **Rule 9:** a pause or a config change never makes a resumed crawl faster than the spacing it earned (`host_spacing_jsonb` still wins).
- **Baseline:**
  - `main` @ `168826b` (PR #25 merge); branch `worktree-phase-27b` from it.
  - Ruleset 0.23.0, 188 rules (72 page / 102 query / 14 metric); migrations 0000–0033.
  - **136 files / 3,770 tests green** (`DATABASE_URL` set); 22 MCP tools, 6 of them command tools.
- **No rule, ruleset or `EXTRACTION_VERSION` change.** 27b touches no rule.
- **Migrations:** `0034` (schema, `npm run db:generate`) and `0035` (data, `npx drizzle-kit generate --custom --name cancelled_to_paused`), applied with `npm run db:migrate`. Never hand-apply SQL. 27c starts at `0036`.
- **Exact vocabulary:**
  - `ControlRequest = "pause" | "cancel"`;
  - `PauseReason = "request" | "shutdown"`;
  - `Mutability = "never" | "whenPaused" | "always"`;
  - crawl statuses `queued | running | paused | finished | failed | cancelled`.
- **Column contract** (in code, like migration 0017's: no DB check constraints, per the schema's precedent):
  - `pause_reason` is non-null exactly when `status = 'paused'`;
  - `cancelled_at` is non-null only when `status = 'cancelled'`;
  - `control_request` is non-null only when `status = 'running'`.
- **Timing constants:** `CONTROL_POLL_MS = 1000` (`src/crawl/control.ts`). Fetch deadline unchanged (`FETCH_TIMEOUT_MS`, 20 s).
- **Error codes** (existing `ServiceError`):
  - a bad field is `VALIDATION` (400) with the field path in the message;
  - the allowlist or URL policy is `FORBIDDEN` (403);
  - a lifecycle refusal (wrong status, live leases, a run in flight, a pending request) is `CONFLICT` (409), naming the status or the operation;
  - an unknown crawl is `NOT_FOUND`.
- **HTTP status of the control commands:** 200 when the change happened now, 202 when it was requested of a running crawl.
- **Command tools become 9:** `crawl_start`, `crawl_resume`, `crawl_render`, `crawl_rules`, `crawl_mark_failed`, `crawl_config_set`, `crawl_pause`, `crawl_cancel`, `crawl_delete`. MCP tools become 27.
- **Commits:** conventional, at least one per task. Each ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
  ```

## Deviations from the spec text (owner to see in review)

1. **Migrations are `0034` + `0035`, not `0032`.** The spec predates 27a's three migrations. As in 27a, the columns come first (generated) and the relabel second (custom).
2. **Discovery is not interrupted between sitemap documents.** A pause or cancel that arrives during the sitemap walk takes effect when the walk returns, at the first batch boundary.
   - Why: a walk cut part-way leaves `sitemap_urls`, memberships and staged alternates that the sitemap and hreflang rules would judge as the whole sitemap (rule 7).
   - Doing it honestly needs a "walk cut short" truncation reason threaded through the rules that read `discovery.truncation`. That is the same work as the owner-parked discovery-deadline item in the 26c backlog, so it is carried there.
   - The host probe (≤ 4 chains before discovery) is not interrupted either.
   - The gate measures the stop bound in the page phase.
3. **One polling mechanism.** The watcher polls on a 1 s interval for the whole run and delivers the request as an abort. The loop already checks that signal at every point the spec lists except discovery (Deviation 2). The spec's "polled at every batch boundary and in the waits" is therefore met by the signal check, with ≤ 1 s added latency.
4. **`neverFetched` is computed, not stored.** On a `cancelled` crawl it is `frontier.pending`. Cancel is final, so the frontier no longer moves.
5. **Cancel also applies to a paused crawl, immediately.** Pause, look, then cancel is the natural flow. Repeat and conflicting requests follow the table in Task 4.
6. **`DELETE /crawls/:id?confirm=<crawlId>`** carries the confirm as a query parameter, because DELETE bodies are poorly supported. MCP takes `{crawlId, confirm}`.
7. **The start body stays flat** (crawl fields + `judgement`), so the existing contract holds. `crawl_config_get`/`set` speak `{crawl, judgement}`.
8. **Operator-only stored fields** (`maxResources`, `maxResourceHosts`, `maxBlockedUrls`, `platformProfiles`) appear in `crawl_config_get.crawl` as `never`. They are not in the published schema, which is the wire's allowlist and never accepted them.
9. **`probeHosts` and `fetchResources` are `never`.** The spec lists neither field. Changing either mid-crawl would give one crawl two scopes.
10. **The judgement part keeps `parseJudgement` as its semantic check.** The schema publishes the block's shape (rule ids, thresholds with defaults and bounds) and calls `parseJudgement` in a refinement. A parity test pins the two together. Rewriting 27a's parser on zod would re-open 27a's reviewed error paths for no gain.
11. **An aborted fetch refunds its attempt.** The worker's shutdown release decrements `attempts` on every row it still holds. A URL paused three times does not reach the retry limit after one real failure.
12. **A request that lands after the last poll before a clean finish is overtaken by the finish.** The crawl closes `finished` and the request is cleared. `crawl_status` shows what happened.
13. **Defaults are published as the JSON Schema `default` annotation** (`.meta`), not as zod `.default()`. Operator defaults (`crawlDefaults`) sit between the engine's and the request's, so the parser must keep "absent" distinct from "given".
14. **The 50k pause gate runs `scripts/gate-rules.ts`**, the script that produced 26c's 293.7 MB, with a new `--pause-at-fraction` flag.
15. **`x-ariadne-secret` arrives with 27c's first secret field** (credentials). 27b has no secret field, and an annotation nothing carries would be untested.

## Review Focus

1. **A pause that lands in the epilogue** (recheck or resource pass) closes `paused` with that pass's work still owed. `crawl_resume` accepts it, and the resumed run finishes the pass. Test in Task 3.
2. **A paused crawl whose pacing was changed, then resumed,** runs with the new `maxConcurrency`/`perHostDelayMs` but never faster than the per-host spacing it earned. Test in Task 7.
3. **A queued crawl paused while it waits** is never started by the queue runner. This holds whether this process holds it or another one does. Test in Task 4.
4. **Delete removes only its own files.** A sibling crawl's exports and renders survive beside it. Test in Task 5.
5. **A shutdown with a request pending:**
   - with a pause pending, the crawl closes `paused` with reason `request`;
   - with a cancel pending, it closes `cancelled`.

   Test in Task 3.

---

### Task 0 (controller, no code): baseline

- [ ] On `worktree-phase-27b` @ `168826b`, run `npm ci` then `npm test`. Expected: 136 files / 3,770 tests, 0 skipped. If the renderer test "never predicts a URL twice…" flakes (known, pre-existing), re-run that file once and record it in the ledger.
- [ ] Record `npx tsc --noEmit` clean.

### Task 1: Lifecycle columns, the relabel, and what `crawl_status` reports

**Files:**
- Modify: `src/db/schema.ts` (crawls: three columns)
- Create: `drizzle/0034_*.sql` (generated), `drizzle/0035_cancelled_to_paused.sql` (custom)
- Create: `src/crawl/control.ts` (vocabulary + readers only in this task)
- Modify: `src/api/service.ts` (`CrawlDetail`, `crawlDetailOn`)
- Test: `test/db/migration-0035.test.ts`, `test/crawl/control.test.ts` (readers), `test/api/http.test.ts` (detail fields)

**Interfaces:**
- Produces:
  - `crawls.controlRequest: text("control_request")`, `crawls.pauseReason: text("pause_reason")` and `crawls.cancelledAt: timestamp("cancelled_at", { withTimezone: true })`, all nullable. Match the existing timestamp columns' options.
  - In `src/crawl/control.ts`:
    - `CONTROL_REQUESTS = ["pause", "cancel"] as const`, `type ControlRequest`;
    - `PAUSE_REASONS = ["request", "shutdown"] as const`, `type PauseReason`;
    - `readControlRequest(value: unknown, crawlId: string): ControlRequest | null`;
    - `readPauseReason(value: unknown, crawlId: string): PauseReason | null`. It throws `Error` naming the crawl and the value for anything else.
  - `CrawlDetail` gains:
    - `controlRequested: ControlRequest | null`;
    - `pauseReason: PauseReason | null`;
    - `cancelledAt: string | null` (ISO);
    - `neverFetched: number | null`: `frontier.pending` when the status is `cancelled`, else null.

- [ ] **Step 1: Write the failing tests.**
  - `migration-0035.test.ts`: follow `test/db/migration-0032.test.ts`'s pattern. Insert two crawls with status `cancelled` and one `finished`, apply the 0035 SQL file inside a transaction, and assert:
    - both cancelled rows are `paused` with `pause_reason = 'shutdown'` and `cancelled_at` null;
    - the finished row is untouched.
  - `control.test.ts`:
    - `readControlRequest(null, id)` is null, `"pause"` and `"cancel"` pass through, and `"stop"` throws with the crawl id in the message;
    - the same for `readPauseReason` with `"request"`, `"shutdown"` and `"later"`.
  - In `http.test.ts`, `GET /crawls/:id` on a crawl updated to `status = 'cancelled', cancelled_at = now()` answers `cancelledAt` as an ISO string, `neverFetched` equal to `frontier.pending`, `controlRequested: null` and `pauseReason: null`.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/db/migration-0035.test.ts test/crawl/control.test.ts`. Expected: FAIL, because the columns and the module do not exist yet.
- [ ] **Step 3: Implement.**
  - Add the columns.
  - `npm run db:generate`, giving 0034 with three `ADD COLUMN`s.
  - `npx drizzle-kit generate --custom --name cancelled_to_paused`. Its body is `update "crawls" set "status" = 'paused', "pause_reason" = 'shutdown' where "status" = 'cancelled';` with a header comment. Today no path writes `cancelled` except a shutdown abort (spec), so every existing row is a shutdown.
  - `npm run db:migrate`.
  - Write the readers and the detail fields. `crawlDetailOn` reads them off the row it already selects.
  - Update the `crawls.status` comment in `schema.ts` to the new six statuses.
- [ ] **Step 4: Run them.** Expected: PASS. Then `npx tsc --noEmit`, and run `test/api` and `test/db`. Some tests that pin `CrawlDetail` keys (for example `surface-unchanged.test.ts`) need the four new keys added. Change nothing else.
- [ ] **Step 5: Commit.** `feat(db): crawl lifecycle columns and the cancelled→paused relabel (27b T1)`

### Task 2: `fetchPage` takes the crawl's signal; a released lease refunds its attempt

**Files:**
- Modify: `src/crawl/fetch-page.ts`, `src/crawl/frontier.ts`
- Test: `test/crawl/fetch-page.test.ts`, `test/crawl/frontier.test.ts`

**Interfaces:**
- Produces:
  - In `fetch-page.ts`:
    - `FetchOpts.signal?: AbortSignal`;
    - `export class FetchAbortedError extends Error { readonly url: string }`.
    - When the signal is aborted before or during the request, `fetchPage` **rejects** with `FetchAbortedError`. It never resolves to a `FetchResult`, so an abort can never be written as a row.
    - The deadline keeps producing `fetchClass: "timeout"`.
    - Combine the two with `AbortSignal.any([deadline.signal, opts.signal])`, and tell them apart by which one fired.
  - In `frontier.ts`: `releaseLeases(db, crawlId, leaseId, opts: { refundAttempt?: boolean } = {}): Promise<number>`. With `refundAttempt`, each released row also gets `attempts = greatest(attempts - 1, 0)`.

- [ ] **Step 1: Write the failing tests.**
  - In `fetch-page.test.ts`, start a local `node:http` server whose `/stall` route accepts and never answers.
    - `fetchPage(stallUrl, {…, timeoutMs: 20_000, signal})` with `controller.abort()` after 100 ms rejects with `FetchAbortedError` within 1,000 ms, and `error.url === stallUrl`.
    - An already-aborted signal rejects without the server seeing a request.
    - The same route with `timeoutMs: 200` and no abort resolves with `fetchClass: "timeout"`.
  - In `frontier.test.ts`, lease 3 URLs (attempts become 1).
    - `releaseLeases(db, crawlId, workerId, { refundAttempt: true })` returns 3 and leaves them `pending` with `attempts = 0`.
    - Without the option, attempts stay 1.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/crawl/fetch-page.test.ts test/crawl/frontier.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. Clear the deadline timer on every path, and destroy the request on abort.
- [ ] **Step 4: Run them.** Expected: PASS. `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit.** `feat(crawl): fetchPage aborts on the crawl's signal; released leases refund the attempt (27b T2)`

### Task 3: The loop obeys pause and cancel; a shutdown is a pause

**Files:**
- Modify: `src/crawl/control.ts`, `src/crawl/loop.ts`, `src/api/serve.ts`, `src/api/mcp-serve.ts`, `src/demo/serve.ts` (log wording only)
- Test: `test/crawl/control.test.ts`, `test/crawl/loop.test.ts` (existing `cancelled` expectations become `paused`), `test/demo/serve.test.ts` if it pins the wording

**Interfaces:**
- Consumes: Task 1's columns and readers; Task 2's `FetchAbortedError` and `releaseLeases(…, { refundAttempt })`.
- Produces, in `src/crawl/control.ts`:
  - `CONTROL_POLL_MS = 1000`;
  - `type StopReason = { kind: "cancel" } | { kind: "pause"; reason: PauseReason }`;
  - `class ControlWatcher`:
    - constructor `(db: Db, crawlId: string, opts: { shutdown?: AbortSignal; pollMs?: number })`;
    - `readonly signal: AbortSignal`;
    - `start(): void`;
    - `stop(): Promise<void>`, which stops polling and awaits a poll in flight;
    - `stopReason(): StopReason | null`, with precedence cancel > pause request > pause shutdown;
    - `failure(): unknown | null`;
  - `setControlRequest(db: Db, crawlId: string, request: ControlRequest): Promise<boolean>`: `update … set control_request = $1 where id = $2 and status = 'running'`, returning whether a row was updated.
- Produces, in `src/crawl/loop.ts`:
  - `CrawlSummary.status: "finished" | "paused" | "cancelled" | "failed"` and `CrawlSummary.pauseReason: PauseReason | null`;
  - `ResumeOpts.expectStatus?: "queued"`;
  - `export class ClaimLostError extends Error { readonly crawlId: string; readonly status: string }`.

- [ ] **Step 1: Write the failing tests** in `control.test.ts`.
  - Use a local `node:http` site of 40 linked pages that each answer after 50 ms, plus `/stall`, linked from page 1, which never answers. Run with `allowPrivate: true`, `perHostDelayMs: 0` and `maxConcurrency: 4`.
  - **Pause and resume:**
    1. `runCrawl` with the abort controller never fired. Once `frontierCounts(...).done >= 5`, call `setControlRequest(db, id, "pause")`.
    2. The run resolves with `status: "paused"` and `pauseReason: "request"`. The row has `pause_reason = 'request'`, `control_request` null and `finished_at` set.
    3. Measure from the set to the `paused` row being visible. It is ≤ `CONTROL_POLL_MS + 2_000` while `/stall` is in flight; the abort reached it.
    4. No frontier row is `failed`, and no `pages` row exists for `/stall`. `/stall`'s frontier row is `pending` with `attempts = 0`.
    5. Flip a flag in the test server so `/stall` now answers 200 at once. `resumeCrawl(db, id, { config })` ends `finished`. Every one of the 41 URLs has a `pages` row, and none was written twice (`count(*) = count(distinct url)`).
  - **Cancel:**
    1. Same setup with `"cancel"`. The run resolves `cancelled` and the row has `cancelled_at` set.
    2. The summary has `resources: null` and `recheck: null`, and the 404 probe evidence reads `{ skipped: … }`.
    3. `inferPageTemplates` ran: `template_inference_jsonb` is non-null.
    4. `resumeCrawl(db, id)` rejects with a message containing `is cancelled` and `final`.
  - **Shutdown is a pause:**
    - the run's own `signal` aborted with no request → `paused` / `shutdown`;
    - a pause request then the signal (Review Focus 5) → `paused` / `request`;
    - a cancel request then the signal → `cancelled`.
  - **Epilogue pause (Review Focus 1):** a site with 5 pages and 30 image references, each answering after 300 ms. Set `"pause"` once the `resources` table has its first non-null `fetch_class`.
    1. The run closes `paused`, and some `resources` rows are still null.
    2. `resumeCrawl` closes `finished` with every resource row classified.
  - **Claim lost:** a crawl whose row is `paused`, resumed with `{ expectStatus: "queued" }`, rejects with `ClaimLostError` (`status: "paused"`), and the row is unchanged.
  - **Pause/resume equivalence (gate clause 1):** crawl the fixture site (`startFixtureApp(allFixtures())`) twice in fresh crawls.
    - Run A is uninterrupted.
    - Run B is paused once `done >= 10`, then resumed.
    - The sets `(url, fetch_class)` from `pages` are equal.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/crawl/control.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`ControlWatcher`:**
    - `start()` arms a `setInterval(pollMs)`. Each tick reads `control_request` through `readControlRequest`.
    - When the value is non-null, it records the reason and aborts its own controller.
    - The shutdown signal records `pause/shutdown` and aborts, unless a request is already recorded.
    - A poll that throws records `failure` and aborts.
    - `signal` is the watcher's controller signal.
  - **`execute`:**
    - Builds the watcher with `shutdown: signal`, starts it, and stops it in a `finally`.
    - Passes `watcher.signal` everywhere `signal` went before, and to `fetchPage` in `handleOne`.
    - Before any close in `runToCompletion`, if `watcher.failure()` is non-null, throws it. `execute`'s catch then closes `failed` with that reason.
  - **`handleOne`:** a `FetchAbortedError` returns `{ outcome: null, persisted: false }` and writes nothing.
  - **Shutdown release:** `releaseLeases(db, crawlId, workerId, { refundAttempt: true })`.
  - **`closeCrawl`** takes `outcome: "finished" | "stopped" | "failed"`.
    - `stopped` is one `UPDATE … RETURNING status, pause_reason`, so a cancel that lands while the loop winds down still wins:
      ```sql
      status = case when control_request = 'cancel' then 'cancelled' else 'paused' end,
      pause_reason = case when control_request = 'cancel' then null
                          when control_request = 'pause' then 'request'
                          else 'shutdown' end,
      cancelled_at = case when control_request = 'cancel' then now() else null end,
      control_request = null
      ```
      One exception to the CASE: when the watcher recorded `cancel` but the column was since cleared (impossible today), throw. Do not guess.
    - `finished` also sets `control_request = null` (Deviation 12).
    - `failed` also sets `control_request = null`.
  - **Notes:**
    - paused: `paused (<reason>); the frontier still holds <pending> pending URL(s)`;
    - cancelled: `cancelled; <pending> URL(s) were never fetched`.
  - **`resumeCrawl` (loop):**
    - Refuses a `cancelled` row with `Error("resumeCrawl: crawl <id> is cancelled, and a cancel is final")`.
    - With `expectStatus`, the claim is `where id = $1 and status = $2`. Zero rows throws `ClaimLostError` carrying the status read back.
    - The claim also clears `pause_reason`.
  - **Wording:** update the three entrypoints' shutdown log lines and the `close()` docblock to "paused (shutdown)". Update the `CrawlSummary.status` docblock.
- [ ] **Step 4: Run them.** Run `control.test.ts`, then `test/crawl/loop.test.ts`, `test/crawl/recheck.test.ts`, `test/crawl/fetch-resources.test.ts` and `test/demo`. Every expectation of `cancelled` after an abort becomes `paused` with `pauseReason: "shutdown"`. Change no other assertion. Then `npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `feat(crawl): pause and cancel through crawls.control_request; a shutdown is a pause (27b T3)`

### Task 4: `crawl_pause`, `crawl_cancel`, and resume, render and judge around them

**Files:**
- Modify: `src/api/service.ts`, `src/api/http.ts`, `src/api/mcp.ts`
- Test: `test/api/lifecycle.test.ts` (new), `test/api/mcp.test.ts`, `test/api/http.test.ts`

**Interfaces:**
- Consumes: `setControlRequest`, `ClaimLostError`, `ResumeOpts.expectStatus` (Task 3).
- Produces, in `ApiService`:
  - `pauseCrawl(crawlId: string): Promise<CrawlControlOut>`;
  - `cancelCrawl(crawlId: string): Promise<CrawlControlOut>`;
  - `export interface CrawlControlOut { crawlId: string; status: string; controlRequested: ControlRequest | null; immediate: boolean }`;
  - a private `rendering = new Set<string>()` beside `judging`;
  - a private `refuseWhileBusy(crawlId: string, operation: string): void`, which throws CONFLICT naming the operation and whichever of "rules are running" / "a render pass is running" holds.
- Routes and tools:
  - `POST /crawls/:id/pause` → `crawl_pause`;
  - `POST /crawls/:id/cancel` → `crawl_cancel`.
  - HTTP answers 200 when `immediate`, else 202.
  - Add both to `TOOL_NAMES`. The `crawl_status` and `crawl_resume` descriptions name `paused` and the cancel-is-final rule.

**The control table** (applied with a compare-and-swap on the status read):

| status (pending request) | pause | cancel |
|---|---|---|
| queued | → `paused` / `request`, immediate; removed from this process's queue | → `cancelled`, `cancelled_at`, immediate; removed from the queue |
| running (none) | set `pause`, 202 | set `cancel`, 202 |
| running (pause) | 202, no change | set `cancel` (cancel outranks pause), 202 |
| running (cancel) | 409 "a cancel is already pending" | 202, no change |
| paused | 409 "already paused" | → `cancelled`, `cancelled_at`, `pause_reason` null, immediate |
| finished / failed / cancelled | 409 naming the status | 409 naming the status |

Cancel refuses (409) while this process judges or renders the crawl (`refuseWhileBusy`). Pause cannot meet a run, because runs never start on `queued` or `running` crawls.

- [ ] **Step 1: Write the failing tests** in `lifecycle.test.ts`, over `createApiServer` with `crawlDefaults: { allowPrivate: true, perHostDelayMs: 0 }` and a slow `node:http` site.
  - **The table:** each row of the table above, as HTTP status code, body and resulting row. Queued crawls are made by starting two crawls. The second waits.
  - **Review Focus 3:**
    1. Pause the waiting crawl. When the first finishes, the second is still `paused`, has no frontier rows, and the log has no "starting" line for it.
    2. The same with an orphan queued row. Insert a `queued` crawl this server does not hold, pause it (immediate), then call the queue runner's path through `resumeCrawl` with `expectStatus`. The run is skipped and logged `left the queue state`, not failed.
  - **Resume:**
    - `crawl_resume` on a `cancelled` crawl is 409 with `cancelled` and `final` in the message;
    - on a `paused` crawl it is 202, and the row is `queued` with `pause_reason` null;
    - it is refused 409 while a rules run holds the crawl. Hold it by calling `runRulesForCrawl` and asserting on a second concurrent call; follow `judgement-config.test.ts`'s pattern for an in-flight run.
  - **Render guard:** a second `crawl_render` while one runs on the same paused crawl is 409 naming "a render pass is running". `crawl_cancel` during it is 409.
  - **Restart (gate clause 4):**
    1. Pause a running crawl and wait for `paused`.
    2. `close()` the server and construct a new `ApiService` on the same DB.
    3. The crawl is still `paused` with `queuePosition: null`, and nothing started it.
    4. `crawl_resume` then finishes it.
  - **`crawl_mark_failed`** on a running orphan with a pending `cancel` leaves `control_request` null.
  - **MCP:** `crawl_pause` and `crawl_cancel` return the same bodies as HTTP for one queued crawl.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/api/lifecycle.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Queue removal and the status CAS** happen in one synchronous step before the first `await`, as `pump` does.
  - **`runQueued`:**
    - Calls `resumeCrawl` with `expectStatus: "queued"`.
    - Re-reads the row's stored config at dequeue: `parseStoredConfig` + this process's `allowPrivate`. This replaces `entry.config`, so a config change made while queued (Task 7) applies.
    - A `ClaimLostError` is logged as `api: crawl <id> left the queue state ('<status>') before it ran; not started`, and the row is not touched.
  - **`renderCrawl`** claims `rendering` the way `runRulesForCrawl` claims `judging`: check and add in one synchronous step, delete in a `finally`.
  - **`resumeCrawl`:**
    - Refuses `cancelled` (409) before the policy checks.
    - Calls `refuseWhileBusy(crawlId, "crawl_resume")`.
    - Its CAS clears `pause_reason`.
    - Rewrite its "A CANCELLED CRAWL WITH WORK LEFT IS RESUMABLE" docblock paragraph. Paused crawls are resumable; cancelled ones are final.
  - **`markCrawlFailed`** also sets `control_request = null`.
- [ ] **Step 4: Run them.** Run `lifecycle.test.ts`, then `test/api`. Then `npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `feat(api): crawl_pause and crawl_cancel; resume refuses cancelled; render and rules guards (27b T4)`

### Task 5: `crawl_delete`

**Files:**
- Create: `src/api/crawl-delete.ts`
- Modify: `src/api/service.ts`, `src/api/http.ts`, `src/api/mcp.ts`
- Test: `test/api/crawl-delete.test.ts` (new)

**Interfaces:**
- Produces, in `src/api/crawl-delete.ts`:
  - `CRAWL_CHILD_TABLES`: the 13 tables with a `crawl_id`, as drizzle table objects with names, in this order:
    1. `issues`, `metrics`, `links`, `page_resources`, `structured_data`, `hreflang`, `url_params`;
    2. `sitemap_hreflang`, `sitemap_memberships`, `sitemap_urls`;
    3. `resources`, `pages`, `frontier`.
  - `deleteCrawlRows(tx, crawlId): Promise<Record<string, number>>`: one `delete … where crawl_id = $1` per child table, counting `rowCount` (a null `rowCount` throws), then the `crawls` row (exactly 1, else it throws).
- Produces, in `ApiService`: `deleteCrawl(crawlId: string, confirm: string | undefined): Promise<CrawlDeleted>`, with `interface CrawlDeleted { crawlId: string; rows: Record<string, number>; files: { renders: number; exports: number } }`. `rows` includes `crawls: 1`.
- Routes and tools: `DELETE /crawls/:id?confirm=<crawlId>` (200) and `crawl_delete` `{crawlId, confirm}`.

**Refusals** (checked in this order):
1. `confirm` missing or not equal to `crawlId`: VALIDATION, `confirm must repeat the crawl id`.
2. No such crawl: NOT_FOUND.
3. Status `queued` or `running`: CONFLICT naming it.
4. A pending `control_request`: CONFLICT.
5. `refuseWhileBusy(crawlId, "crawl_delete")`.
6. Live leases (`liveLeaseCount`, render leases included): CONFLICT naming the count.

**How the rows and files go:**
- The rows are deleted in one transaction that takes `select … for update` on the crawl row and re-checks the status.
- Files go **after** the commit:
  - `rm -r <renderDir>/<crawlId>/`, counting its files first;
  - every regular file in `exportDir` whose name starts with `` `${slug(crawlId)}-` ``.
- A file error after the commit throws an Error naming every path left on disk. The crawl rows are already gone, and the message says so. It is never swallowed.

- [ ] **Step 1: Write the failing tests.**
  - **Schema pin:** `CRAWL_CHILD_TABLES`' names equal `select table_name from information_schema.columns where column_name = 'crawl_id' and table_schema = 'public'`, minus `crawls`, as a set.
  - **Gate clause 3:**
    1. Crawl the fixture site through the API, judge it, export one CSV and one JSONL, and render 1 page into a temp `renderDir`.
    2. `DELETE` it.
    3. Every child table has 0 rows for it, checked by a query built from `information_schema`, not from the constant.
    4. `<renderDir>/<id>` is gone, and no file in `exportDir` starts with its slug.
    5. `rows` matches the counts taken just before.
  - **Review Focus 4:** a second crawl's export and render files survive, and its rows are untouched.
  - **Refusals:** each of the six, with nothing deleted, checked by row counts before and after.
  - **No soft-delete:** after delete, `GET /crawls/:id` is 404 and `crawl_list` omits it.
  - **A compared crawl:** a crawl used as `crawl_compare`'s base is deletable, and the comparison then answers 404 for it.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/api/crawl-delete.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. `slug` is the existing helper in `service.ts`. Export it for `crawl-delete.ts` rather than copying it.
- [ ] **Step 4: Run them.** Expected: PASS. Then `npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `feat(api): crawl_delete removes a crawl's rows and files, with a confirm echo (27b T5)`

### Task 6: One config schema: `config_schema`, `config_validate`, one parser for both transports

**Files:**
- Create: `src/api/config-schema.ts`
- Modify: `src/api/service.ts` (remove `START_CRAWL_FIELDS`, `parseStartCrawlInput`, `assertKind` for start; `startCrawl` uses the schema), `src/api/mcp.ts` (remove `crawlStartShape`; `crawl_start` uses the schema), `src/api/http.ts`
- Test: `test/api/config-schema.test.ts` (new), `test/api/transport-parity.test.ts` (new); move the start-body refusal cases from `test/api/http.test.ts`/`mcp.test.ts` into `config-schema.test.ts`

**Interfaces:**
- Consumes: `parseJudgement`, `OVERRIDABLE_THRESHOLDS`, `Registry`, `CRAWL_DEFAULTS`, the API's `maxPages` default of 500, `MIN_PER_HOST_DELAY_MS`, `MAX_SUPPLIED_SITEMAPS`.
- Produces, in `src/api/config-schema.ts`:
  - `type Mutability = "never" | "whenPaused" | "always"`;
  - `CRAWL_FIELDS`: one entry per wire field, `{ schema: ZodType, mutable: Exclude<Mutability, "always">, description: string, default?: unknown }`. The fields are exactly today's 14: `siteUrl`, `maxPages`, `maxDepth`, `userAgent`, `perHostDelayMs`, `maxConcurrency`, `probeHosts`, `legacyHosts`, `sitemapUrls`, `renderBudgetPct`, `renderMaxPages`, `renderSamplePerType`, `findingCap`, `fetchResources`.
    - `mutable` is:
      - `never`: `siteUrl`, `userAgent`, `probeHosts`, `legacyHosts`, `sitemapUrls`, `fetchResources`;
      - `whenPaused`: `maxPages`, `maxDepth`, `perHostDelayMs`, `maxConcurrency`, `renderBudgetPct`, `renderMaxPages`, `renderSamplePerType`;
      - `findingCap` is `always`, because it is the judgement's.
    - Descriptions move **verbatim** from `crawlStartShape`.
    - Bounds go in the schema with today's messages:
      - `perHostDelayMs ≥ MIN_PER_HOST_DELAY_MS`, carrying the existing politeness-floor sentence;
      - `maxPages`, `maxDepth` and `maxConcurrency` are integers ≥ 1;
      - `sitemapUrls.length ≤ MAX_SUPPLIED_SITEMAPS`;
      - `findingCap` is an integer ≥ 1 or null.
    - The render budgets keep `resolveRenderConfig` as their check, through the effective config. No second copy of their ranges.
  - `judgementSchema(registry: Registry)`: `z.strictObject({ rules?, thresholds?, findingCap? })`.
    - `rules` is `z.partialRecord(z.enum(<rule ids of page and query rules>), z.strictObject({ disabled: z.literal(true).optional(), type: z.enum(ISSUE_TYPES).optional(), priority: z.enum(PRIORITIES).optional() }))`.
    - `thresholds` has one key per `OVERRIDABLE_THRESHOLDS` name: an integer with `min`/`max` and `.meta({ default })`.
    - The whole block has `.superRefine` calling `parseJudgement`, mapping a `JudgementError` to an issue at `["judgement", ...path]` (Deviation 10).
  - `startBodySchema(registry: Registry)`: `z.strictObject({ ...CRAWL_FIELDS schemas with .meta({ description, default, "x-ariadne-mutable": mutable }), judgement: judgementSchema(registry).meta({ "x-ariadne-mutable": "always" }).optional() })`. Defaults are annotations only (Deviation 13).
  - `publishedSchema(registry: Registry): { schema: object; rulesetVersion: string }`: `z.toJSONSchema(startBodySchema(registry), { target: "draft-2020-12" })`.
  - `export interface ConfigError { path: string; code: ConfigErrorCode; message: string }` with `type ConfigErrorCode = "unknown_field" | "forbidden_field" | "invalid_type" | "out_of_range" | "invalid" | "not_allowed" | "url_policy"`. `not_allowed` and `url_policy` map to FORBIDDEN; the rest to VALIDATION.
  - `parseStartBody(raw: unknown, registry: Registry): { ok: true; value: StartCrawlInput } | { ok: false; errors: ConfigError[] }`. It checks, in order:
    1. not an object → `invalid`;
    2. `allowPrivate` / `recheckMinGapMs` present → `forbidden_field`, with today's two sentences verbatim;
    3. the schema.

    Zod issues map to today's message shapes: `unknown field '<key>' (accepted: <list>)` and `field '<key>' must be <expected>`.
- Produces, in `ApiService`:
  - `checkStartBody(raw: unknown): Promise<{ valid: boolean; errors: ConfigError[]; effective: (StoredConfig & { judgement: JudgementBlock | null }) | null }>`. It runs `parseStartBody`, then, if valid:
    - the allowlist (`not_allowed`);
    - `isUrlAllowed` on `siteUrl`, every `legacyHosts` origin and every `sitemapUrls` entry (`url_policy`). There is no DNS lookup;
    - `effectiveConfig` + `validateCrawlConfig` (`invalid`).
    - `effective` is `storableConfig(effective)` plus the parsed judgement, or null when invalid.
  - `startCrawl(raw: unknown)` now takes the raw body. It calls `checkStartBody` and throws `ServiceError` for `errors[0]` (code by the mapping, message as-is), then proceeds as today.
  - `configSchema()`: `publishedSchema(this.registry)`.
  - `validateConfig(raw)`: `checkStartBody(raw)`.
- Routes and tools:
  - `GET /config/schema` → `config_schema`;
  - `POST /config/validate` → `config_validate`. It is always 200 with `{valid, errors, effective}`; only a non-JSON body is 400.
  - MCP `crawl_start` registers `inputSchema: startBodySchema(registry)` and calls `service.startCrawl(args)`.

- [ ] **Step 1: Write the failing tests.**
  - **`config-schema.test.ts`:**
    - `publishedSchema` has `$schema` = `https://json-schema.org/draft/2020-12/schema`.
    - Every one of the 14 fields has `x-ariadne-mutable` matching the table, and `judgement` has `always`.
    - `maxPages.default === 500`, and `perHostDelayMs.minimum === 250`.
    - Every one of the 20 thresholds appears under `judgement.properties.thresholds.properties` with `minimum`, `maximum` and `default` equal to `OVERRIDABLE_THRESHOLDS`.
    - `judgement.properties.rules.propertyNames.enum` (or the zod-4 equivalent emitted for `partialRecord` keys; assert whichever zod emits, once, in this test) lists all 174 page and query rule ids and no metric id.
    - Every refusal case moved from `http.test.ts`/`mcp.test.ts` is asserted here against `parseStartBody`, by code and by the message phrase the old test pinned.
  - **`transport-parity.test.ts` (gate contract clause 1):**
    - Walk `publishedSchema`'s properties.
      - For each field, build one valid body (from `default`, or a fixture value) and one invalid body: wrong type, plus out-of-range where `minimum`/`maximum`/`maxItems` exist.
      - Add `{siteUrl, bogus: 1}`, `{siteUrl, allowPrivate: true}` and `{siteUrl, judgement: {rules: {"no.such-rule": {disabled: true}}}}`.
    - Drive each body through `POST /crawls` and MCP `crawl_start`. Both accept, or both refuse. A refusal's text contains the field's name on both.
    - Accepted crawls are cancelled immediately (queued → `cancelled`), so nothing is fetched.
  - **Validate/start agreement (gate contract clause 2):** for the same table plus:
    - a host off the allowlist;
    - a `legacyHosts` entry off it;
    - a `sitemapUrls` entry the URL policy refuses (`http://169.254.169.254/s.xml`);
    - `renderBudgetPct: 0`.

    `POST /config/validate` says `valid: false` exactly when `POST /crawls` refuses, and `errors[0].message` equals the refusal's message. Codes map as specified: 403 for `not_allowed`/`url_policy`, 400 otherwise. On valid bodies, `effective` equals what `crawl_config_get.crawl` then reports (Task 7) for the started crawl, judgement aside.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/api/config-schema.test.ts test/api/transport-parity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
  - Delete `START_CRAWL_FIELDS`, `parseStartCrawlInput`, the start half of `assertKind` and `crawlStartShape`. `RENDER_CRAWL_FIELDS` and the render parser stay; they are not crawl config.
  - Delete the test asserting `crawlStartShape` keys equal `START_CRAWL_FIELDS`. The schema is now the single source.
  - `http.ts` passes the raw body to `startCrawl`.
- [ ] **Step 4: Run them.** Run the two tests, then `test/api` and `test/skills` (the identifier guard; add `config_schema`/`config_validate` where the guard lists tools). Then `npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `feat(api): one zod config schema for both transports; config_schema and config_validate (27b T6)`

### Task 7: `crawl_config_get` shows the crawl part; `crawl_config_set` changes it while paused

**Files:**
- Modify: `src/api/service.ts` (`CrawlConfigOut`, `crawlConfigOf`, `setCrawlJudgement` → `setCrawlConfig`), `src/api/mcp.ts`, `src/api/http.ts`
- Test: `test/api/judgement-config.test.ts` (extend), `test/api/lifecycle.test.ts` (Review Focus 2)

**Interfaces:**
- Consumes: `CRAWL_FIELDS`, `Mutability` (Task 6); `refuseWhileBusy` (Task 4).
- Produces:
  - `CrawlConfigOut` gains:
    - `crawl: Record<string, unknown>`: the stored `config_jsonb` minus `findingCap`;
    - `mutability: Record<string, Mutability>`: every `crawl` key, plus `judgement: "always"`. Operator-only keys are `never` (Deviation 8).
  - `ApiService.setCrawlConfig(crawlId: string, patch: unknown): Promise<CrawlConfigOut>` replaces `setCrawlJudgement`. The body is `{ crawl?: object, judgement?: object }`, at least one present, and any other key is VALIDATION.

**Rules for `crawl`:**
- It is a shallow set of new values. A `null` is VALIDATION ("name the value you want; a crawl field has no unset").
- Each key is validated with that field's schema from `CRAWL_FIELDS` (same messages as start).
- A key not in `CRAWL_FIELDS` is `unknown field`, or `field '<k>' is set by the operator, not over the API` for an operator-only key.
- A `never` field is CONFLICT: `field '<k>' is never mutable after a crawl starts (mutability: never)`.
- A `whenPaused` field on a crawl not `queued` or `paused` is CONFLICT naming the status and the mutability.
- `maxPages` below `crawls.pages_crawled` is VALIDATION naming both numbers.
- `refuseWhileBusy(crawlId, "crawl_config_set")` applies whenever `crawl` is present. A `judgement`-only patch keeps 27a's rules-run refusal only.
- The merged config passes `validateCrawlConfig` (with this process's `allowPrivate`) before the write, which goes through `storableConfig`.
- `judgement` behaves exactly as in 27a, in the same transaction.

- [ ] **Step 1: Write the failing tests.**
  - `crawl_config_get` on a fresh crawl:
    - `crawl` has every stored key with the effective values (`maxPages: 500`, …);
    - `mutability.siteUrl === "never"`, `mutability.maxPages === "whenPaused"`, `mutability.judgement === "always"`;
    - `mutability.maxResources === "never"` when the operator set it through `crawlDefaults`.
  - `crawl_config_set`:
    - `{crawl: {maxPages: 900}}` on a paused crawl → stored and reported;
    - on a running crawl → 409 naming `running` and `whenPaused`;
    - `{crawl: {siteUrl: …}}` → 409 `never`;
    - `{crawl: {maxPages: <pages_crawled - 1>}}` → 400;
    - `{crawl: {perHostDelayMs: 100}}` → 400 with the floor sentence;
    - `{crawl: {maxPages: null}}` → 400;
    - `{crawl: {maxResources: 5}}` → 400 operator-only;
    - `{crawl: {maxPages: 900}, judgement: {rules: {"no.such": {disabled: true}}}}` → 400, and **nothing** is written (`maxPages` unchanged);
    - `{crawl: {maxPages: 900}}` while a render pass runs → 409 naming the render pass.
  - **A queued crawl's change applies:** start two crawls, set `maxPages: 3` on the waiting one, and it finishes with ≤ 3 pages.
  - **Review Focus 2:**
    1. A crawl on a site that answers 429 to its first 2 requests, so the gate earns spacing.
    2. Pause it, then `crawl_config_set {crawl: {perHostDelayMs: 250, maxConcurrency: 8}}`, then resume.
    3. The stored config has the new values, and the resumed run's first request gap to that host is ≥ the earned `host_spacing_jsonb` value, not 250 ms. Measure from the fixture server's request log.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/api/judgement-config.test.ts test/api/lifecycle.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Rename at every call site (MCP and HTTP).
  - Update the `crawl_config_set` tool description to name `crawl`, the mutability rule and the busy refusal.
  - Update the `crawl_config_get` description for `crawl`/`mutability`.
  - Remove the 27a refusal "crawl fields arrive in Phase 27b".
- [ ] **Step 4: Run them.** Run both test files and `test/api`, then `npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `feat(api): crawl_config_get/set cover the crawl part, mutable only while paused (27b T7)`

### Task 8: Surface docs, skills, and the gate

**Files:**
- Modify: `docs/talos-surface.md`, `docs/talos-integration.md`, `skills/ariadne-crawl/SKILL.md`, `skills/ariadne-audit/SKILL.md` and `skills/ariadne-audit/checklist.md` (wherever they say `cancelled` means a shutdown), `scripts/gate-rules.ts`
- Create: `docs/gates/phase-27b.md`

- [ ] **Step 1: Docs.**
  - **`talos-surface.md`:**
    - every new tool, route and response shape: `crawl_pause`, `crawl_cancel`, `crawl_delete`, `config_schema`, `config_validate`, and the extended `crawl_config_get`/`set`;
    - the control table from Task 4, and the 200/202 rule;
    - the new `crawl_status` fields;
    - the six statuses, and `cancelled` = final;
    - §9: delete, its refusals, the confirm echo, and tenancy ("until Phase 28's tenant key, anyone with the token who knows a crawl id can delete it, as for every per-crawl command");
    - §10: the command tools are now nine, listed.
  - **`talos-integration.md`:** shutdown = pause.
  - **The `ariadne-crawl` skill:** when to pause versus cancel, reading `controlRequested`, `config_validate` before `crawl_start`, and changing pacing only while paused.
  - **The `ariadne-audit` skill:** a `cancelled` crawl is judgeable but partial, and `neverFetched` says how much.
  - Run `npx vitest run test/skills`.
- [ ] **Step 2: The pause gate flag.**
  - `scripts/gate-rules.ts` gains `--pause-at-fraction <0..1>`. When set, a poller (2 s) waits for `done ≥ fraction × pages`, calls `setControlRequest(db, id, "pause")`, and awaits the run's `paused` summary.
  - It then prints `pause→paused <ms>` and calls `resumeCrawl(db, id, { config })` before render and rules, exactly as before.
  - Peak RSS is sampled across both runs, as today.
- [ ] **Step 3: Run the gate** (local fixture, loopback only, nothing external fetched).
  1. Create a dedicated database `ariadne_gate27b` and migrate it.
  2. Run `DATABASE_URL=…/ariadne_gate27b node --max-old-space-size=512 --import tsx scripts/gate-rules.ts --pause-at-fraction 0.4`.
  3. Expected: the crawl ends `finished` with 50,000 pages, and peak RSS is ≤ 512 MB and within 5% of 293.7 MB (≤ 308.4 MB).
  4. Drop the database afterwards.
- [ ] **Step 4: Write `docs/gates/phase-27b.md`**, one section per spec clause:
  - the full suite (files/tests, 0 skipped);
  - pause/resume equivalence (Task 3 test, with its URL and class counts);
  - the cancel bound (the measured ms against `CONTROL_POLL_MS` + settle, and 0 failed rows);
  - delete (zero rows across the `information_schema` table list, no files);
  - restart-paused;
  - the two contract checks;
  - the 50k run (peak, pause latency, wall time, commit).

  §"Deviations" lists Deviations 1–15 of this plan, plus anything the run adds. §"Carried to Phase 28" lists the in-process `judging`/`rendering` guards and the orphan-`running` crawl with a pending request (it stays until `crawl_mark_failed`).
- [ ] **Step 5: Run the full suite** (`npm test`, 0 skipped) and `npx tsc --noEmit`. Record both in the gate doc.
- [ ] **Step 6: Commit.** `docs(gate): Phase 27b — lifecycle and config schema gate, surface docs and skills (27b T8)`

# Phase 25: Evidence layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The crawl keeps the facts the check waves need: allowlisted response headers per page, the request headers it sent, per-row extraction and render version stamps, capped render console evidence, and an honest record of a render pass that failed to launch.

**Architecture:** Four build tasks and a gate:
- One migration (0025) adds every new column.
- The fetch layer captures allowlisted headers; the page writer stamps `extraction_version`.
- `execute()` stamps the crawl's request headers and engine version.
- `RenderTraffic` plus a pure collector capture console, exceptions and failed requests; the render writer stamps `render_version`.
- `runRenderPass` records launch failures on the crawl, and `render.coverage` reports them as `failed` (ruleset 0.19.0).
- No new rules, no new API/MCP/CSV fields.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16 (drizzle-kit), Playwright Chromium over CDP, vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-phase-25-evidence-layer-design.md` (owner-approved 2026-11-04, including the nine "my call" lines). Read it first. Roadmap: `docs/superpowers/specs/2026-11-04-roadmap-design.md`.

## Global Constraints

- CLAUDE.md hard rules 1–10. Rule 7 (no silent fallbacks) governs every null contract below; rule 6 (memory O(concurrency)) means nothing here accumulates across pages.
- **Environment first:** the dev Postgres container is not running on this machine (1,310 DB tests skip without it). Start it as CLAUDE.md says (`docker run -d --name ariadne-pg -p 5440:5432 …postgres:16`, or `docker start ariadne-pg` if it exists), then `npm run db:migrate`. A green suite means 0 skipped DB tests.
- Baseline: `main` @ `77a8b88`, 2,449 tests, `tsc` clean, migrations 0000–0024, ruleset 0.18.0, 114 rules.
- **One migration, 0025**, generated with `npm run db:generate` and applied with `npm run db:migrate`. Never hand-written SQL.
- **Header allowlist (exact):** `strict-transport-security`, `content-security-policy`, `content-security-policy-report-only`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, `permissions-policy`, `cache-control`, `expires`, `etag`, `last-modified`, `age`, `vary`, `content-type`, `content-language`, `content-encoding`, `x-robots-tag`, `link`, `server`, `x-powered-by`.
- **Header value cap:** 2,048 characters. **Render caps:** 20 entries per kind per page, 500 characters per message or URL.
- **Redacted request header names:** `authorization`, `cookie`, `proxy-authorization` → value `"[redacted]"`.
- `EXTRACTION_VERSION = 1`, `RENDER_CAPTURE_VERSION = 1`.
- **No surface change:** no new keys on `crawl_status`, `crawl_list`, the `pages` field allowlist (`PAGE_FIELDS`), CSV views or JSONL datasets. The one exception: `render.coverage`'s metric value gains `failed` and `renderLaunchError`.
- Ruleset 0.18.0 → **0.19.0**, for `render.coverage`'s new value only.
- The suite leaves zero net crawl rows (house `createdCrawls` pattern).
- `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`.
- Commits are conventional and end `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (CLAUDE.md).

## Review Focus

1. **A repeated allowlisted header** (two `link` headers) keeps both values in arrival order. A non-allowlisted header (`set-cookie`) never appears, not even as a key. (Task 1 test.)
2. **The cap boundary:** a 2,048-character value is stored whole and not listed as cut; a 2,049-character value is cut to 2,048 and listed in `truncated`. (Task 1 test.)
3. **A timeout during the body** stores the headers that arrived. A connect timeout stores null headers but still `extraction_version = 1`, so the null reads "no response", not "pre-25". (Task 1 test.)
4. **A console error our own blocking caused** (a page calling a function from a third-party script the renderer aborted) is recorded as a console error, with `blockedByRenderer.thirdParty ≥ 1`, and never as a failed request. (Task 3 test, real Chromium.)
5. **Launch fails, then a later pass launches:** `render_launch_error` clears and `render.coverage` reads `ran` again. (Task 4 test.)

---

### Task 1: Schema, response headers, extraction version

**Files:**
- Modify: `src/db/schema.ts` (all seven new columns, each with a docblock stating its null contract as the spec words it): `pages.response_headers jsonb`, `pages.extraction_version smallint`, `pages.render_version smallint`, `pages.render_console jsonb`, `crawls.request_headers jsonb`, `crawls.engine_version text`, `crawls.render_launch_error text`. All nullable, no defaults.
- Create: `drizzle/0025_*.sql` via `npm run db:generate`.
- Create: `src/crawl/versions.ts`.
- Create: `src/crawl/response-headers.ts`.
- Modify: `src/crawl/fetch-page.ts` (`FetchResult`, the success path near line 494, the catch path near line 598, `emptyResult`).
- Modify: `src/crawl/persist.ts` (`pageRow` near line 655; the robots-blocked literal near line 533).
- Modify: `src/rules/helpers.ts` (add `extractionCoverage`).
- Test: `test/crawl/response-headers.test.ts` (new), `test/crawl/fetch-page.test.ts`, `test/crawl/persist.test.ts`, `test/rules/extraction-coverage.test.ts` (new), `test/db/migration-0025.test.ts` (new, on the `migration-0016.test.ts` model).

**Interfaces:**
- Produces, in `src/crawl/versions.ts`: `export const EXTRACTION_VERSION = 1;` and `export const RENDER_CAPTURE_VERSION = 1;` (the second is consumed in Task 3).
- Produces, in `src/crawl/response-headers.ts`:
  - `export const RESPONSE_HEADER_ALLOWLIST: readonly string[]` (the 20 names, lower-case)
  - `export const RESPONSE_HEADER_VALUE_CAP = 2048`
  - `export interface StoredResponseHeaders { values: Record<string, string[]>; truncated: string[] }`
  - `export function captureResponseHeaders(headers: HeaderBag): StoredResponseHeaders`
- Produces: `FetchResult.responseHeaders: StoredResponseHeaders | null`.
- Produces, in `src/rules/helpers.ts`: `export async function extractionCoverage(db: Db, crawlId: string, minVersion: number): Promise<{ atOrAbove: number; below: number }>`. `below` counts rows with `extraction_version < minVersion` **or null**. Phase 26 rules consume it.

- [ ] **Step 1: Write the failing tests**
  - `response-headers.test.ts`:
    - "keeps only allowlisted headers, lower-cased": a bag with `Strict-Transport-Security`, `Set-Cookie` and `X-Custom` gives `values` with exactly `{"strict-transport-security": [...]}`.
    - "keeps every occurrence of a repeated header in order": `link: ["<a>; rel=x", "<b>; rel=y"]` gives both, in that order.
    - "cuts at 2,048 and says so": a 2,048-character CSP gives `truncated: []`; a 2,049-character one gives a value of length 2,048 and `truncated: ["content-security-policy"]`.
  - `fetch-page.test.ts`:
    - "stores allowlisted headers on a 404": `responseHeaders.values["content-type"]` is set.
    - "keeps headers that arrived before a body timeout": a fixture route that sends headers and then stalls past the deadline gives `fetchClass: "timeout"`, `statusCode: null`, `responseHeaders` not null.
    - "has no headers when nothing answered": a connect failure gives `fetchClass: "network_error"`, `responseHeaders: null`.
  - `persist.test.ts`:
    - "stamps extraction_version 1 on every row it writes, a robots-blocked row included".
    - "writes response_headers verbatim".
  - `test/crawl/recheck.test.ts`: "the recheck leaves response_headers as the first observation wrote them" (spec §1: the second observation writes no headers).
  - `extraction-coverage.test.ts`: a crawl with two rows at version 1 and one at null gives `extractionCoverage(db, id, 1)` = `{ atOrAbove: 2, below: 1 }`.
  - `migration-0025.test.ts`: the seven columns exist, are nullable, and pre-existing rows read null.
- [ ] **Step 2: Run them and see them fail**
  - Run: `npx vitest run test/crawl/response-headers.test.ts test/crawl/fetch-page.test.ts test/crawl/persist.test.ts test/rules/extraction-coverage.test.ts test/db/migration-0025.test.ts`
  - Expected: FAIL (missing module, missing columns, missing field).
- [ ] **Step 3: Implement**
  - Schema plus migration (generate, then migrate).
  - `captureResponseHeaders`. A value is an array when undici gave an array, otherwise a one-element array.
  - In `fetchPage`, hoist a `let received: HeaderBag | null = null` above the `request(...)` call and assign it once the response arrives. The success path and the catch path both set `responseHeaders` from it (`captureResponseHeaders(received)` or `null`). `emptyResult` takes it as a parameter. `statusCode` stays null on the catch path: the spec keeps headers only.
  - `pageRow` maps `responseHeaders` and stamps `extractionVersion: EXTRACTION_VERSION`.
  - The robots-blocked literal gets `responseHeaders: null`.
  - `settledResult` in `loop.ts` spreads `result`, so it needs no change; confirm with `tsc`.
- [ ] **Step 4: Run the same tests, then the full suite and `npx tsc --noEmit`.** Expected: all pass, 0 DB tests skipped.
- [ ] **Step 5: Commit:** `feat(crawl): allowlisted response headers and extraction version per page (migration 0025)`.

### Task 2: Crawl stamps — request headers and engine version

**Files:**
- Modify: `src/crawl/fetch-page.ts` (extract the header object at line 473 into an exported builder).
- Modify: `src/crawl/versions.ts` (engine version).
- Modify: `src/crawl/loop.ts` (`execute`, the function `runCrawl` and `resumeCrawl` share, near line 956).
- Test: `test/crawl/versions.test.ts` (new), `test/crawl/loop.test.ts`, `test/api/surface-unchanged.test.ts` (new).

**Interfaces:**
- Consumes: Task 1's columns.
- Produces:
  - `export function pageRequestHeaders(userAgent: string): Record<string, string>`, in `fetch-page.ts`. `fetchPage` must use it: one definition of what is sent.
  - `export function redactRequestHeaders(h: Record<string, string>): Record<string, string>`, in `versions.ts`.
  - `export function engineVersion(env?: NodeJS.ProcessEnv): string`, in `versions.ts`. It returns `"<package.json version>+<ARIADNE_GIT_SHA>"`, or `"<version>+sha-unknown"` when the variable is unset or empty. A missing sha is stated, never invented.

- [ ] **Step 1: Write the failing tests**
  - `versions.test.ts`:
    - "redacts authorization, cookie and proxy-authorization, case-insensitively, and leaves user-agent alone".
    - "names the sha, or says it is unknown": `engineVersion({ARIADNE_GIT_SHA: "abc123"})` gives `` `${pkg.version}+abc123` ``, and `engineVersion({})` gives `` `${pkg.version}+sha-unknown` ``, with `pkg` read from `package.json` in the test.
  - `loop.test.ts`:
    - "stamps request_headers and engine_version when a crawl runs": `request_headers` equals `redactRequestHeaders(pageRequestHeaders(ua))` for the crawl's UA.
    - "re-stamps engine_version on resume": run, overwrite the column, resume, and the column holds the current value again.
  - `surface-unchanged.test.ts`:
    - "crawl_status and crawl_list carry no request_headers, engine_version or render_launch_error key".
    - "the pages field allowlist has no response_headers, render_console, extraction_version or render_version".
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `execute()` runs one `update crawls set request_headers = …, engine_version = …` before discovery. Latest wins on resume (spec §3).
- [ ] **Step 4: Run the tests, the full suite and `tsc`.** Expected: green.
- [ ] **Step 5: Commit:** `feat(crawl): stamp request headers and engine version on the crawl`.

### Task 3: Render evidence and render version

**Files:**
- Create: `src/crawl/render/console-capture.ts`.
- Modify: `src/crawl/render/renderer.ts`: `RenderTraffic` (listeners in `start()` near line 765; `onResponse` near 1043; `onFailed` near 1131); `RenderResult`; `failure()`; the success return near line 1766; `writeRenderResult` near line 2011.
- Test: `test/crawl/console-capture.test.ts` (new), `test/crawl/renderer.test.ts` (a `/console-errors` route in its `startSite` server, a clean route, and the third-party script route in `startThirdParty`).

**Interfaces:**
- Consumes: `RENDER_CAPTURE_VERSION` (Task 1).
- Produces, in `console-capture.ts`:
  - `export const RENDER_CONSOLE_MAX_ENTRIES = 20`
  - `export const RENDER_CONSOLE_MAX_CHARS = 500`
  - `export interface RenderConsole { console: { level: "error" | "warning"; text: string; cut: boolean }[]; consoleTotal: number; exceptions: { text: string; cut: boolean }[]; exceptionsTotal: number; failedRequests: { url: string; status: number | null; reason: string; cut: boolean }[]; failedRequestsTotal: number; blockedByRenderer: { thirdParty: number; sameOriginAssets: number } }`
  - `export class RenderConsoleCollector { addConsole(level: "error" | "warning", text: string): void; addException(text: string): void; addFailedRequest(url: string, status: number | null, reason: string): void; snapshot(blocked: { thirdParty: number; sameOriginAssets: number }): RenderConsole }`
- Produces: `RenderResult.console: RenderConsole | null`.
  - null only on the `failure(..., NO_TRAFFIC)` paths, where the policy refused before a browser page opened.
  - Every render that opened a page carries a snapshot, failed renders included.
  - `blockedByRenderer` comes from the existing `blockedRequests` / `skippedPaintRequests` counts.

**What counts (spec §4):**
- A failed request is either:
  - an `onFailed` that passes the existing filter (sent by us, not cancelled, not `ERR_BLOCKED_BY_CLIENT` or `ERR_ABORTED`), or
  - an `onResponse` for a request we released (`inFlight` had it) with status ≥ 400, other than the top-level document. The document's status is the page's own, already on the row.
- Console messages come from `Runtime.consoleAPICalled` (types `error`, `warning`) and exceptions from `Runtime.exceptionThrown`. Enable `Runtime` in `start()`, or use Playwright's `console`/`pageerror`; implementer's choice.

- [ ] **Step 1: Write the failing tests**
  - `console-capture.test.ts`:
    - "keeps 20 per kind and counts all": 25 `addConsole` calls give 20 entries and `consoleTotal: 25`.
    - "cuts at 500 and marks it": a 501-character text gives `cut: true` and length 500.
  - `renderer.test.ts` (real Chromium):
    - "records a thrown error, a console.error and a missing same-origin script": `/console-errors` throws, logs, and loads `/missing.js` (404). Expect `exceptionsTotal ≥ 1`, a console entry at level `error`, and a `failedRequests` entry with `status: 404` and the script's URL.
    - "a blocked third-party script is a count, not a failure" (Review Focus 4): the same page loads a third-party script and then calls a function from it. Expect `blockedByRenderer.thirdParty ≥ 1`, no `failedRequests` entry for the third-party URL, and the resulting console error recorded.
    - "a clean page has zero counts": all totals 0, `console` not null.
    - "keeps what it captured when the render then fails": a route that logs an error and never settles, under a short navigation timeout, gives `rendered: false`, `error` set, `consoleTotal ≥ 1`.
  - `writeRenderResult` (in the existing `runRenderPass` describe):
    - "writes render_console and render_version 1".
    - "a pre-browser policy refusal writes render_version 1 with render_console null".
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** One collector per `RenderTraffic`. The writer adds `render_console = ${result.console}` and `render_version = ${RENDER_CAPTURE_VERSION}`. The console text is the site's own; no engine text enters the collector (Talos obligation 6).
- [ ] **Step 4: Run `npx vitest run test/crawl/console-capture.test.ts test/crawl/renderer.test.ts test/fixtures/harness.test.ts`, then the full suite and `tsc`.** Expected: green.
- [ ] **Step 5: Commit:** `feat(render): capture console errors, exceptions and failed requests per rendered page`.

### Task 4: Launch failure on the record; `render.coverage` says `failed`

**Files:**
- Modify: `src/crawl/render/run-render.ts` (around `mkdir` and `PageRenderer.launch`, lines 542–560).
- Modify: `src/rules/metric/render-metrics.ts` (`RENDER_PASS_EVIDENCE`, the read of the crawl row, the `renderPassEvidence` expression near line 340, the metric table column near line 373).
- Modify: `src/rules/registry/registry.ts` (`RULESET_VERSION = "0.19.0"` and changelog entry 8).
- Modify the docs that spell the vocabulary:
  - `skills/ariadne-audit/checklist.md` (around lines 297–299 and 457)
  - `skills/ariadne-audit/SKILL.md` (around line 155)
  - `skills/ariadne-crawl/SKILL.md` (around line 273)
  - `src/api/mcp.ts` (the tool description near line 1037)
- Test: `test/crawl/renderer.test.ts` (`runRenderPass` describe), the `render.coverage` tests under `test/rules/`, and any `test/skills/` test that pins the vocabulary.

**Interfaces:**
- Consumes: `crawls.render_launch_error` (Task 1).
- Produces:
  - `RENDER_PASS_EVIDENCE = { ran: "ran", none: "none", failed: "failed" }`.
  - The `render.coverage` site metric value gains `renderLaunchError: string | null`.
  - `export function describeLaunchFailure(error: unknown): string`, in `run-render.ts`.

**Behaviour:**
- Wrap the `mkdir` and the `PageRenderer.launch` call:
  - On error: `update crawls set render_launch_error = describeLaunchFailure(error)`, then rethrow the original error unchanged, so the API's 409 and 500 paths behave as today.
  - On a successful launch: set `render_launch_error = null`.
  - Rows stay `render_pending` (spec §5).
- `describeLaunchFailure` messages, all tenant-safe:
  - `UrlPolicyError` → `` `address refused: ${error.message} (${error.code})` ``. Its message is already bounded by the 24a redaction.
  - A failed `mkdir` → `"the render directory could not be created"`.
  - Anything else, including `HostGate.restore` throwing inside `launch` → `"the render browser could not be launched"`.
  - Raw error text never enters the column; it travels on the rethrown error to the log.
- `renderPassEvidence` is `failed` whenever `render_launch_error` is not null, and that check comes before the `ran` test.

- [ ] **Step 1: Write the failing tests**
  - "a browser that cannot launch leaves rows pending, records why, and coverage says failed": inject the launch failure through the existing test-fault seam, or a `PageRenderer.launch` spy. Expect `frontier.renderPending` equal to the selection size, `render_launch_error = "the render browser could not be launched"`, the `render.coverage` value `renderPassEvidence: "failed"`, and `renderLaunchError` equal to the column.
  - "a launch-time UrlPolicyError is recorded as an address refusal": the 24a 409 setup. Expect the column to start with `address refused:` and to contain no resolver text.
  - "a later pass that launches clears it" (Review Focus 5): fail once, then run a pass that launches. Expect the column null and `renderPassEvidence: "ran"`.
  - "ruleset is 0.19.0".
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement, including the four doc edits.** Client-facing wording in the skills and checklist is written by the orchestrator, not the implementer: leave a `TODO(orchestrator)` sentence in each spot. The orchestrator replaces them before the commit.
- [ ] **Step 4: Run the full suite and `tsc`.** Expected: green.
- [ ] **Step 5: Commit:** `fix(render): a pass that cannot launch is recorded on the crawl and reported as failed (ruleset 0.19.0)`.

### Task 5: Gate

**Files:** create `docs/gates/phase-25.md`, on the `docs/gates/phase-24a.md` layout.

- [ ] Clauses 1–4 (spec "Gate"): cite the test that pins each (Tasks 1–4).
- [ ] Clause 5 on lavishalice (owner-approved 2026-11-04):
  - Probe before the crawl: one AriadneBot `curl` to `https://lavishalice.com/`, retried once after its own `Retry-After` if 429. Record both answers.
  - The crawl: `{siteUrl: "https://lavishalice.com/", maxPages: 600, fetchResources: false}`, render pass on, run as in 24a's "The run".
  - Record:
    - `select avg(pg_column_size(response_headers)), max(pg_column_size(response_headers)), count(*) filter (where jsonb_array_length(response_headers->'truncated') > 0) from pages where crawl_id = …`
    - peak RSS, which must be ≤ 223.9 MB
    - wall time
    - render count and errors
    - the `render_console` totals across rendered rows
  - Probe after the crawl, the same way.
- [ ] Clause 6: full suite (0 skipped DB tests), `tsc`, tree clean. Record the counts: tests and files, migrations 0000–0025, ruleset 0.19.0, 114 rules.
- [ ] Mark the spec "Status: shipped, gate `docs/gates/phase-25.md`".
- [ ] Update the Serena `roadmap` memory and the auto-memory handoff after the commit.
- [ ] Commit: `docs: phase-25 gate`. Integrate on the owner's word.

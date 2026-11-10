# Phase 27d — Backlog Clearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay the known debts before Phase 28: deterministic CI, sitemap timing that survives
cold generation, a stop honoured in every phase, no client key ever echoed, the 27c leftovers,
template inference in SQL, and a clean dev database.

**Architecture:** No new subsystem. The changes are local to the modules that own each debt:
- `discovery.ts` gets a three-part document timing and a walk budget.
- The loop threads its `ControlWatcher` signal into the probe, discovery, recheck and resources.
- `src/api` gets one positional unknown-key message, used by every parser and MCP tool.
- The credential map becomes a small shape-keyed store.
- `inferPageTemplates` becomes one SQL statement.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16, drizzle, undici, Playwright
Chromium, zod 4, `@modelcontextprotocol/sdk` 1.30.0, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-phase-27d-backlog-design.md` (owner approved
2026-11-10, "Go ahead", including the "Calls I made" list and the triage recommendations).

## Global Constraints

- **Hard rules 1–10 in `CLAUDE.md` bind every task.** Most in play here:
  - rule 6: RAM O(concurrency), never O(URLs);
  - rule 7: no silent fallbacks;
  - rule 5: url-policy on every fetched URL.
- **No fallbacks.** Errors surface; a failed request is a classified row or a loud error.
- **Secrets.** Credential values never reach a stored column, a log, an error or a response.
  New in this phase: a key the client sent is never quoted in an error either.
- **Ruleset `0.25.0`** (`src/rules/registry/registry.ts:991` `RULESET_VERSION`), bumped once in
  Task 3. No migration is expected; if a task finds it needs one, it is `0037`.
- **Values, verbatim from the spec:**
  - sitemap timing: headers 60 s, body idle 30 s, document total 120 s;
  - walk total: 10 min;
  - stop target: `CONTROL_POLL_MS` (1 s) + 1 s;
  - 50k memory bound: 290.2 MB.
- **`docs/talos-surface.md` cites tests by line number.** When you edit a cited test file, keep
  existing line numbers stable or append new tests at the end of the file.
- **Tests need `DATABASE_URL` exported** (`postgresql://ariadne:ariadne@localhost:5440/ariadne`)
  and Chromium installed.
- **Shell.**
  - The worktree guard refuses `cd`, `$VAR` chains and compound commands built from runtime
    values, so run plain separate commands.
  - Never use `git stash`.
- **Commits.** Conventional, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
  ```
- **Serena memories** are updated after each commit (controller's job, not the implementer's).

## Review Focus

1. **A pause that lands between the end of discovery and the first lease.** It must close the
   crawl as promptly as one during discovery. Pinned in Task 4: the "pause right after discovery"
   test.
2. **A stop while a sitemap's rows are being flushed** (the document `Deadline` is paused then).
   The abort still wins, and the resumed walk's result equals an uninterrupted one. Pinned in
   Task 4: the "stop during flush" test.
3. **A redirecting sitemap.** Each hop answers in under 60 s but the hops together pass 120 s; it
   fails as "over 120 s in total". Pinned in Task 3.
4. **A sentinel key in a nested position.** A `judgement.rules` key with an invalid value, an
   unknown key inside `judgement.rules.<id>`, or a query parameter name. None of them comes back
   in any transport. Pinned in Task 6.
5. **A failed `crawl_config_set`** (the transaction rolls back after the new credentials were
   staged). It leaves the old credentials usable and the new ones gone. Pinned in Task 7.

## Deviations from the spec (rulings for the owner to see)

1. **Gate clause 4 tests use scaled timing.** They pass a smaller `sitemapTiming` / `walkBudgetMs`,
   so the suite does not sleep 40 s. A separate test pins the default constants to the spec values.
2. **List-mode `notMeasured` reasons are sentences**, like `crawl_overview`'s, not the literal
   `list-mode`. Each reason names why: no links followed, or no sitemap read.
3. **Loop resume test.** The recon thought `starts` was not reset at the resume; it is
   (`reset(...)` at `test/crawl/loop.test.ts:2341`). Only the slot-timing cause is fixed.
4. **"Excluded by scope" entries appear only on crawls whose config has `exclude` or `include`.**
   An unscoped crawl excludes nothing, so it shows no such entries.
5. **robots.txt keeps its 20 s per-document total.** The spec's new timing is for sitemap
   documents only.
6. **Credential header and cookie names that are valid tokens may still be quoted** (27c
   Rulings 27/M13). The sentinel test covers the positional cases 27c already handles and skips
   valid-token credential names.
7. **The `crawl.list-mode` marker's own evidence keeps `notMeasured: string[]`.** It is finding
   evidence, not a surface field.
8. **The prune script's targets are crawls whose `site_url` host is a loopback address or under a
   reserved TLD** (`.test`, `.example`, `.invalid`, `.localhost`, or exactly `localhost`). Dead
   `queued`/`running` rows among them are set to `cancelled` first, because `deleteCrawl` refuses
   live statuses.

---

### Task 0: Baseline and ledger

- [ ] **Step 1:** `npm ci` (the MCP stdio test spawns `node_modules/.bin/tsx`).
- [ ] **Step 2:** Run `npx tsc --noEmit` and `npm test`. Expected: tsc clean and
  **152 files / 4,062 tests**. A single failure of "never predicts a URL twice…" is the known
  flake, not a regression. Re-run that file once and note it.
- [ ] **Step 3:** Create the SDD ledger with the baseline numbers. No commit.

---

### Task 1: Renderer flake: diagnose, then test the contract

**Files:**
- Modify: `src/crawl/render/renderer.ts:1378-1394` (`RenderTestFaults.onRelease`), `:1059-1062`, `:1114`
- Modify: `test/crawl/renderer.test.ts:1304-1325` (the test body, in place; same line count or fewer
  plus appended helpers), the fixture routes near `:270-282` and `:519-523`

**Interfaces:**
- Produces: `onRelease?: (url: string, atMs: number, release: { predicted: boolean }) => void`.
  Existing callers that take two parameters keep compiling.

- [ ] **Step 1 (diagnose, no commit).**
  - Temporarily log `{n, paced, unpaced, cached}` per page in the existing test.
  - Run it 30 times while two CPU burners run (`node -e "for(;;){}"`, twice, backgrounded):
    `npx vitest run test/crawl/renderer.test.ts -t "never predicts a URL twice"`.
  - Record in the ledger which pattern the failures show:
    - **Mechanism A:** page 1 paced 3, the misprediction on page 2.
    - **Mechanism B:** page 1 normal, a later page paced 2 with cached 1.
  - Kill the burners and revert the logging.
- [ ] **Step 2:** In `release()`, pass `{ predicted }` to `onRelease`. `predicted` is true when the
  release came from the `isFresh` branch in `onPaused` (`:1059`), not from `pump()`. Thread it as a
  parameter of `release`.
- [ ] **Step 3: Rewrite the fixture and the test.** Add two fixture pages:
  - `/mispredict/prime`: script tag for `/volatile.js` only;
  - `/mispredict/fetch/:n`: only `fetch('/volatile.js', {cache:'no-store'})`.

  Rewrite the test:

```ts
it("never predicts a URL twice once a prediction for it was wrong", async () => {
  const releases: { url: string; predicted: boolean }[] = [];
  const renderer = await launch({ onRelease: (url, _at, r) => releases.push({ url, predicted: r.predicted }) });
  try {
    expect((await renderer.render(`${site.base}/mispredict/prime`)).error).toBeNull();
    let unpaced = 0;
    for (const n of [1, 2, 3]) {
      const result = await renderer.render(`${site.base}/mispredict/fetch/${n}`);
      expect(result.error).toBeNull();
      unpaced += result.unpacedNetworkRequests;
    }
    const volatile = releases.filter((r) => r.url.endsWith("/volatile.js"));
    // The script on the priming page (paced), then three fetches.
    expect(volatile.map((r) => r.predicted)).toEqual([false, true, false, false]);
    expect(unpaced).toBe(1);
  } finally {
    await renderer.close();
  }
});
```

  `launch` must accept test faults. If it does not, give it an optional `testFaults` parameter.
  If Step 1 showed mechanism B, the priming page plus fetch-only pages still removes it, because
  no later page loads the script. Record that in the ledger either way.
- [ ] **Step 4:** Run the file once, then the stress loop: 50 runs with both burners. Expected:
  50/50 pass.
- [ ] **Step 5:** Commit:
  `test(render): the misprediction test asserts the contract, not the page it lands on (27d)`.

---

### Task 2: Loop resume flake: measure the gate's slots

**Files:**
- Modify: `src/crawl/politeness.ts`: `HostGateOptions` gains `onGrant`; `acquire` (`:1022-1030`)
  calls it with `(host, startAt)`.
- Modify: `src/crawl/loop.ts`:
  - `runCrawl(db, config, signal?, testHooks?)` (`:772`);
  - `ResumeOpts.testHooks`;
  - `execute` → `runToCompletion` → `new HostGate({... onGrant: testHooks?.onGrant})` (`:1763`).
- Modify: `test/crawl/loop.test.ts`:
  - the storefront describe's `minGap`/`SLACK_MS` (`:2165-2174`);
  - the two tests that use them. Keep line numbers stable where possible.

**Interfaces:**
- Produces: `export interface LoopTestHooks { onGrant?: (host: string, slotAtMs: number) => void }`
  in `loop.ts`, documented "TEST ONLY — never wire it to an API field", like `RenderTestFaults`.

- [ ] **Step 1:** Change both storefront pacing tests to collect `slots: number[]` through
  `onGrant`, for the storefront host's page requests only. Assert
  `minSlotGap(slots) >= 1000`, an exact bound because slots are scheduled. `reset()` clears `slots` too, so the
  resume test measures the resumed run alone. Delete `SLACK_MS` and
  its wrong comment.
- [ ] **Step 2:** Run them. Expected: they fail to compile until the hook exists.
- [ ] **Step 3:** Implement the hook, threaded as listed above.
- [ ] **Step 4:** Run the storefront describe 50 times under the two CPU burners. Expected: 50/50.
- [ ] **Step 5:** Commit:
  `test(loop): pacing asserted on the gate's scheduled slots, not server arrival (27d)`.

---

### Task 3: Sitemap timing: headers, idle, document total, walk budget

**Files:**
- Modify: `src/crawl/discovery.ts`:
  - `:175` constants;
  - `Deadline` (`:604-647`);
  - `requestDoc` (`:687-760`);
  - `DiscoveryOpts.timeoutMs` (`:464`);
  - `DiscoveryTruncation` (`:296`);
  - the walk loop.
- Modify: `src/rules/query/hreflang-completeness.ts` (`:59-140`: reading and cut-short),
  `src/rules/query/hreflang.ts:800-820` (marker evidence and `reason`)
- Modify: `src/rules/registry/registry.ts:991` → `"0.25.0"`; the marker's copy in the registry
  copy file
- Modify: `src/crawl/host-probe.ts` only if it calls discovery's `timeoutMs`
- Test: `test/crawl/discovery.test.ts` (append), `test/rules/hreflang-completeness*.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export interface DocTiming { headersMs: number; idleMs: number; totalMs: number }
  export const SITEMAP_TIMING: DocTiming = { headersMs: 60_000, idleMs: 30_000, totalMs: 120_000 };
  export const ROBOTS_TIMING: DocTiming = { headersMs: 20_000, idleMs: 20_000, totalMs: 20_000 };
  export const DISCOVERY_WALK_BUDGET_MS = 600_000;
  // DiscoveryOpts: `timeoutMs` removed; added
  sitemapTiming?: DocTiming; robotsTiming?: DocTiming; walkBudgetMs?: number;
  // DiscoveryTruncation: added
  timeLimited: boolean;
  ```
- The failure reasons, exact strings with seconds computed from the timing in force:
  - `` `no headers within ${s} s` ``
  - `` `no data for ${s} s` ``
  - `` `over ${s} s in total` ``

  These replace `"timed out"` for sitemap and robots documents alike.

- [ ] **Step 1: Write the failing tests**, appended. Use fixture endpoints with controllable
  delays and scaled timing `{headersMs: 600, idleMs: 300, totalMs: 1200}`.
  - **Headers late but within limit:** headers after 450 ms → the document is read.
  - **Headers too late:** headers after 800 ms → failure reason `no headers within 0.6 s`.
    Seconds are printed with up to one decimal and without a trailing `.0`, so the defaults
    read `60 s`.
  - **Idle gap:** body sends half, goes silent 450 ms → `no data for 0.3 s`.
  - **Hops add up (Review Focus 3):** three redirect hops of 500 ms each → `over 1.2 s in total`.
  - **Flush time is free:** time spent in the sink's flush does not count toward `totalMs`. A
    sink that sleeps 1,500 ms per flush still reads a 3-chunk document.
  - **Walk budget:** `walkBudgetMs: 1000` over an index of 5 child sitemaps that take 400 ms each
    → `truncation.timeLimited === true`. The documents read before the budget keep their entries.
    The unread ones are not in `failures`.
  - **Defaults pinned:** `SITEMAP_TIMING` deep-equals `{headersMs: 60_000, idleMs: 30_000,
    totalMs: 120_000}`, and `DISCOVERY_WALK_BUDGET_MS === 600_000`.
  - **Rules (in the hreflang completeness tests):**
    - a crawl whose `discovery_jsonb.truncation.timeLimited` is true makes
      `sitemapHreflangCutShort` true;
    - `hreflang.declarations-incomplete` fires with `timeLimited: true` and `reason` naming
      `timeLimited`;
    - a pre-27d truncation without the key reads as false.
- [ ] **Step 2:** Run. Expected: FAIL (no `sitemapTiming` option, no `timeLimited`).
- [ ] **Step 3: Implement.**
  - **Timer handling.** `Deadline` becomes a per-document timer. It is created once per
    `requestDoc` call, not per hop, so `totalMs` spans hops. It keeps `pause`/`resume`. A separate
    header timer (`headersMs`, per hop) and undici's `bodyTimeout: idleMs` give the idle limit.
    Classify which limit fired so the reason is exact.
  - **Which timing applies.** Robots.txt requests use `robotsTiming ?? ROBOTS_TIMING`, sitemap
    documents use `sitemapTiming ?? SITEMAP_TIMING`.
  - **Walk budget.** `walkBudgetMs ?? DISCOVERY_WALK_BUDGET_MS` is wall-clock from the first
    sitemap request. It is checked before each document. A document in flight when the budget
    runs out is aborted and counted as cut short (`timeLimited`), not as a failure.
  - **Test callers.** Update the existing callers of `timeoutMs` in tests to `sitemapTiming` /
    `robotsTiming`.
- [ ] **Step 4:** Add `timeLimited` to the hreflang reading and the cut-short condition, beside
  `docLimited`/`depthLimited`, with the same missing-key handling. Add it to the marker's
  evidence and `reason`. Bump `RULESET_VERSION` to `0.25.0` and fix the tests that pin the
  version or the catalog size.
- [ ] **Step 5:** Run the discovery and hreflang test files, then `npx tsc --noEmit`. Expected:
  PASS, clean.
- [ ] **Step 6:** Commit:
  `feat(discovery): sitemap headers 60 s / idle 30 s / document 120 s, walk budget 10 min, timeLimited (27d)`.

---

### Task 4: A stop is honoured during the host probe and discovery

**Files:**
- Modify:
  - `src/crawl/host-probe.ts` (options gain `signal`, passed to every `fetchPage`);
  - `src/crawl/discovery.ts` (`DiscoveryOpts.signal`; every request and every pacing sleep honour
    it; it is checked between documents);
  - `src/crawl/loop.ts:1633-1696` (pass `watcher.signal`; close on abort).
- Test: `test/crawl/loop-stop-early.test.ts` (new)

**Interfaces:**
- Produces: `export class DiscoveryAbortedError extends Error` in `discovery.ts`, thrown by
  `discover` when `opts.signal` fires. `requestDoc` combines its timers with the caller's signal
  via `AbortSignal.any` and rethrows the caller's abort ahead of any classification. An abort is
  never a failed document.
- Consumes: Task 3's `DocTiming` and `walkBudgetMs`.

- [ ] **Step 1: Write the failing tests** in the new file. Use a fixture server with:
  - a host probe whose variants answer after 5 s;
  - a sitemap index whose children each answer after 3 s;
  - a flush-heavy sitemap (thousands of `<loc>`s).

  Each test writes `control_request` directly, as the 27b tests do, and measures from the write
  to the row's terminal status.
  - **Pause during the probe** → `paused` within 2,000 ms. `discovery_jsonb` is null and no
    frontier rows exist.
  - **Cancel during the probe** → `cancelled` within 2,000 ms, with the 27b never-ran wording on
    the status read.
  - **Pause during the sitemap walk** → `paused` within 2,000 ms. No `sitemap_urls` entries are
    enqueued into the frontier and no discovery evidence is written.
  - **Stop during flush (Review Focus 2):** pause while the flush-heavy document's rows are being
    written → `paused` within 2,000 ms.
  - **Resume equals uninterrupted:** after the pause, resume to the end. Its `discovery_jsonb`
    (minus timing-dependent keys, if any) and the set of `sitemap_urls` URLs equal those of a
    second, uninterrupted crawl of the same fixture.
  - **Pause right after discovery (Review Focus 1):** the pause lands in the window between
    discovery's return and the first lease (inject it from the sink's last flush) → `paused`
    within 2,000 ms, no page fetched.
- [ ] **Step 2:** Run. Expected: FAIL (timeouts: the stop waits for the probe and the walk).
- [ ] **Step 3: Implement.**
  - Pass `signal: watcher.signal` to `probeHostVariants` and `discover`.
  - On `FetchAbortedError` from the probe or `DiscoveryAbortedError` from discovery, close the
    crawl through the same stopped-close path the page loop uses when `aborted` is set. That
    means the watcher's requested status, the 404 probe recorded as skipped, and no discovery
    evidence and no enqueue.
  - After `discover` returns, check `watcher.signal.aborted` before writing evidence.
- [ ] **Step 4:** Run the new file, `test/crawl/loop.test.ts` and the 27b control tests. Expected:
  PASS.
- [ ] **Step 5:** Commit:
  `feat(loop): a pause or cancel stops the host probe and the sitemap walk (27d)`.

---

### Task 5: In-flight requests stop with the crawl (27b Ruling 4)

**Files:**
- Modify:
  - `src/crawl/recheck/recheck-server-errors.ts` (`recheckServerErrors`: pass `signal` to
    `fetchPage`; a `FetchAbortedError` returns without writing the row);
  - `src/crawl/resources/fetch-resources.ts` (`RequestOpts.signal`; `requestResource` throws
    `FetchAbortedError` if already aborted and combines its deadline with the signal via
    `AbortSignal.any`; `fetchCrawlResources` writes no row on an abort).
- Reference: `docs/gates/phase-27b-ruling4-inflight.patch`. It does not apply (27c credentials in
  the context); re-apply its intent by hand.
- Test: `test/crawl/loop-stop-early.test.ts` (append)

- [ ] **Step 1: Write the failing tests.**
  - **Recheck:** a fixture page answers 503 once, then hangs 15 s on recheck. Pause during the
    recheck pass → `paused` within 2,000 ms. The page's recheck columns stay null. A resume
    rechecks it.
  - **Resources:** a resource hangs 15 s. Pause during the resource pass → `paused` within
    2,000 ms. No `resources` row for it. A resume fetches it.
  - **Render, measurement only:** start `crawl_render` on a crawl whose page hangs in the
    browser for 15 s. Request a pause (if `crawl_pause` refuses while rendering, record the 27b
    refusal and skip). Record the stop latency in the ledger.
- [ ] **Step 2:** Run. Expected: the recheck and resource tests FAIL (about 15 s).
- [ ] **Step 3:** Implement the two passes as listed.
  - **Render.** If Step 1 measured more than 2,000 ms, abort the in-flight page the same way, in
    `src/crawl/render/run-render.ts:994-1000`: the page's render columns stay unwritten. Add the
    render test as a pass/fail test.
  - **Parked copy.** Delete `.superpowers/parked/phase-27b-ruling4-inflight.patch`, the
    git-ignored duplicate.
- [ ] **Step 4:** Run the file, the recheck tests and the resource tests. Expected: PASS.
- [ ] **Step 5:** Commit:
  `feat(crawl): a stop aborts the in-flight recheck and resource request (27b Ruling 4, 27d)`.

---

### Task 6: No error quotes a key the client sent

**Files:**
- Modify: `src/api/errors.ts` (helpers below)
- Modify, each site from the spec §4:
  - `src/api/config-schema.ts:636-637` (`unknownField`), `:832-835` (MCP `crawl_start` top level),
    `:894-900` (judgement nested keys);
  - `src/api/service.ts:396-399`, `:440-443`, `:4622-4627`;
  - `src/rules/judgement.ts:107-108`;
  - `src/api/http.ts:870-879` (`checkQuery`).
- Create: `src/api/mcp-input.ts`
- Modify: `src/api/mcp.ts` (26 `z.strictObject` input schemas → `strictInput`)
- Test: `test/api/no-key-echo.test.ts` (new); update the existing message assertions it breaks
  (e.g. `test/api/mcp.test.ts:826`)

**Interfaces:**
- Produces, in `src/api/errors.ts`:
  ```ts
  /** The accepted name closest to `sent` (case-insensitive Damerau-Levenshtein ≤ 2, ties → first in `accepted`), or null. */
  export function nearestAccepted(sent: string, accepted: readonly string[]): string | null;
  /** "<path> has an unknown field (key <position> in the order sent); did you mean '<nearest>'? Accepted: a, b, c" — the "did you mean" clause only when nearestAccepted is non-null; `<path>` is "body" at the top level. Never contains `sent`. */
  export function unknownKeyMessage(path: string, position: number, sent: string, accepted: readonly string[]): string;
  ```
  Positions are 1-based, in `Object.keys` order.
- Produces, in `src/api/mcp-input.ts`:
  `export function strictInput<T extends z.ZodRawShape>(shape: T): z.ZodObject<...>`. It is
  `z.strictObject(shape, { error })`, where `error` maps an `unrecognized_keys` issue to
  `unknownKeyMessage` (positions from `Object.keys(issue.input)`) and returns `undefined`
  otherwise.
- Record-keyed inputs whose keys name things (`judgement.rules`, `judgement.thresholds`) take
  `z.unknown()` values at the zod level. Their validation stays in our parser, which names keys
  by position. A record key never reaches a zod issue path.

- [ ] **Step 1: Write the failing test.** `const SENTINEL = "sk_live_27d_SENTINEL"`. For each case,
  assert the response body (HTTP: text; MCP: the whole JSON-RPC result or error) does not
  contain `SENTINEL`, and does contain `key 1 in the order sent` (or the case's position).
  - **HTTP** (`POST /crawls`, `POST /config/validate`, `POST /crawls/:id/resume`,
    `POST /crawls/:id/render`, `PATCH /crawls/:id/config`):
    - an unknown top-level key;
    - an unknown key inside `crawl`;
    - an unknown key inside `judgement.rules.<valid id>`;
    - SENTINEL as a `judgement.rules` key with a valid value;
    - SENTINEL as a `judgement.rules` key with an invalid value;
    - SENTINEL as a `judgement.thresholds` key.
  - **HTTP, query string:** `GET /crawls/:id/issues?SENTINEL=1` → no echo, positional.
  - **MCP** (`crawl_start`, `config_validate`, `crawl_config_set`, `crawl_resume`, `crawl_render`,
    and one read tool such as `issues_list`): the same nested cases.
  - **Near miss:** a near-miss key `requestHeaderz` on resume → message contains
    `did you mean 'requestHeaders'?`.
  - **Logs:** the service's log sink captured during the whole test contains no `SENTINEL`.
- [ ] **Step 2:** Run. Expected: FAIL at every site listed above.
- [ ] **Step 3:** Implement the helpers, then replace each site. Order:
  1. `unknownField`;
  2. the resume and render parsers;
  3. the `crawl_config_set` top level, which reports the first refused key's position and the
     count of others: `(and N more)`;
  4. judgement keys and rule ids, with "names no rule in ruleset 0.25.0" and the nearest rule id;
  5. `checkQuery`;
  6. MCP `strictInput` across `mcp.ts`.
- [ ] **Step 4:** Run `test/api` and `npx tsc --noEmit`. Fix assertions that pinned the old
  quoted wording; the new wording is the one in `unknownKeyMessage`. Expected: PASS.
- [ ] **Step 5:** Commit:
  `fix(api): unknown keys are named by position, never quoted, in every transport (27d)`.

---

### Task 7: Shape-keyed credential store (M9) and the repeated-header test (M6)

**Files:**
- Create: `src/api/credential-store.ts`
- Modify: `src/api/service.ts:2473` (the map becomes a `CredentialStore`), `:4655-4868`
  (`setCrawlConfig`), `:6725-6750` (`runQueued`), and every other `this.credentials` use
  (11 sites)
- Test: `test/api/credential-store.test.ts` (new); `test/crawl/renderer.test.ts` (append, M6)

**Interfaces:**
- Produces:
  ```ts
  export class CredentialStore {
    /** The entry held for `crawlId` whose shape is `shape` (sameShape), or undefined; a null shape → undefined. */
    get(crawlId: string, shape: CredentialShape | null): CrawlCredentials | undefined;
    set(crawlId: string, credentials: CrawlCredentials): void;   // replaces every entry
    delete(crawlId: string): void;
    /** Holds `next` beside the current entry; settle(true) keeps only `next` (or none if null), settle(false) drops `next`. */
    stage(crawlId: string, next: CrawlCredentials | null): (committed: boolean) => void;
  }
  ```

- [ ] **Step 1: Write the failing tests.**
  - **Store, unit:**
    - after `set(A)` and `stage(B)`, `get(id, shape(A))` is A and `get(id, shape(B))` is B;
    - `settle(true)` → only B;
    - `settle(false)` → only A (Review Focus 5);
    - `stage(null)` then `settle(true)` → none.
  - **Service:** a queued crawl with credentials of shape A; `crawl_config_set` to shape B; the
    queue runner dequeues **inside** the transaction window. Hold it there with a test-only
    `afterConfigWrite` seam on the service options, named and documented TEST ONLY. The crawl
    runs with B and does not fail with "needs credentials of another shape".
  - **Service, rollback:** make the config write throw; the crawl still holds A.
  - **M6 (renderer, appended):** a credentialed render of a page whose script sends
    `fetch('/echo', {headers: {'x-own': 'one', 'authorization': 'page-value'}})`, with
    `requestHeaders: {authorization: 'Bearer cred'}`. The fixture echo endpoint records the raw
    header lines. Assert exactly one `authorization: Bearer cred` line and one `x-own: one` line.
    If this fails, fix `mergedHeaders` (`renderer.ts:682-700`) in this task.
- [ ] **Step 2:** Run. Expected: the store tests fail (no module) and the race test fails with
  `CredentialsMissingError`. The M6 test is expected to pass.
- [ ] **Step 3:** Implement the store, then wire `setCrawlConfig` and `runQueued`:
  - stage before the transaction, settle on its outcome;
  - `runQueued` uses `get(crawlId, parsedConfig.credentialShape ?? null)`.
- [ ] **Step 4:** Run `test/api` and the renderer M6 test. Expected: PASS.
- [ ] **Step 5:** Commit:
  `fix(credentials): a queued crawl finds the credentials of the shape its row states (27c M9, 27d)`.

---

### Task 8: Overview counts excluded pages; one `notMeasured` shape; the route test

**Files:**
- Modify:
  - `src/api/overview.ts:286-359` (`CrawlOverviewDetail`, `urlsSection`);
  - `src/api/judgement-view.ts:74,233` (`notMeasured` type);
  - `src/rules/query/list-mode.ts:72-82` (reasons);
  - `src/api/service.ts`: `:5293`, `:5945`, `:1990`, `:2020`, `:2037`, `:6580`;
  - `src/api/overview.ts:68` (`issues_overview`);
  - `src/api/mcp.ts` output descriptions where they name the shape.
- Test: `test/api/crawl-overview.test.ts`, `test/api/issues-overview.test.ts`,
  `test/api/transport-parity.test.ts` (append in each)

**Interfaces:**
- Produces:
  - `export type NotMeasured = { id: string; reason: string }[]`, exported from `overview.ts` and
    used by every response that carries `notMeasured`;
  - `listModeNotMeasured` returns `NotMeasured` with these reasons:
    - `needsSpider`: `"a list crawl follows no links, so this rule's evidence was not gathered"`;
    - `needsSitemaps`: `"a list crawl read no sitemap, so this rule's evidence was not gathered"`.
- `CrawlOverviewDetail` gains `excluded: { recorded: number; dropped: number | null } | null`.
  It is null when the crawl's config has neither `exclude` nor `include`. `recorded` is the count
  of `fetch_class = 'excluded'` page rows; `dropped` is `crawls.excluded_dropped`.

- [ ] **Step 1: Write the failing tests.**
  - **Scoped crawl:** a scoped crawl with 2 stored excluded rows and `excluded_dropped = 5`.
    `urls` has `{label: "Excluded by scope (stored)", value: 2}`, with a percent of Encountered,
    and `{label: "Excluded by scope (dropped)", value: 5, percent: null}`. "Encountered" includes
    the 2.
  - **Unscoped crawl:** neither entry.
  - **List crawl listing:** `notMeasured` deep-equals objects with the reasons above, in
    `issues_list`, `issues_overview`, `metric_table` and `export_crawl` (JSON answer). The CSV
    shape of `crawl_overview` is unchanged.
  - **`export_crawl view=crawl_overview`:** the answer's `notMeasured` equals `crawl_overview`'s.
  - **Transport parity:** `GET /crawls/:id/overview/issues` deep-equals the MCP `issues_overview`
    result for the same crawl. Append it to the parity file.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Read `excluded` inside the overview's repeatable-read snapshot with
  the other detail reads (27a Ruling 14).
- [ ] **Step 4:** Run `test/api`, `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5:** Commit:
  `feat(api): crawl_overview counts scope-excluded URLs; notMeasured is {id, reason}[] everywhere (27d)`.

---

### Task 9: Template inference in one SQL statement (hard rule 6)

**Files:**
- Modify: `src/crawl/page-type.ts` (`inferPageTemplates`, `:260-330` and the retype batches;
  `familyOf` `:141-146` and `collapseTemplates` `:178-203` stay as the test oracle)
- Test: `test/crawl/page-templates.test.ts` (append)

**Interfaces:**
- `inferPageTemplates`'s signature and return value `{typesBefore, typesAfter, pagesRetyped}` are
  unchanged. `recordInference` runs in the same transaction.
- The SQL slug predicate, exactly matching `detectUrlTemplate`'s "segment left unchanged":
  a segment is a slug-family member when it is **not** `^[0-9]+$` and has **fewer than 2**
  hyphens. Use `[0-9]`, never `\d`. `filter(Boolean)` corresponds to
  `array_remove(string_to_array(page_type, '/'), '')`. A type joins a family only when
  `'/' || array_to_string(segs, '/') = page_type` and `cardinality(segs) >= 2`. Collapse when the
  family has ≥ 2 members and ≥ `MIN_COHORT` (3) paths.

- [ ] **Step 1: Write the failing tests** (appended).
  - **Parity:** for a fixture list of ≥ 40 types (digits, UUIDs, dates, 1/2/3-hyphen segments,
    trailing slash, `//`, client types like `product`, single-segment paths), the SQL result
    equals `collapseTemplates` applied to the same population.
  - **Memory:** a crawl with 40,002 singleton shapes retypes 40,002 pages. A heap sample taken
    inside the call (`process.memoryUsage().heapUsed` before and at a test hook after the
    statement) grows by less than 2 MB.
  - **Edges (Review Focus):**
    - zero typed pages → `{typesBefore: 0, typesAfter: 0, pagesRetyped: 0}`;
    - a second run retypes 0 (idempotent).
  - The existing 1,201-shape three-batch test keeps passing; its census is unchanged.
- [ ] **Step 2:** Run. Expected: the memory test FAILs (about 6 MB today).
- [ ] **Step 3:** Implement the data-modifying CTE: population → family → windowed counts →
  mapping → `UPDATE … FROM mapping` → counts in one round trip. The recon sketch is in the
  ledger's Task 9 notes. Remove `RETYPE_BATCH` and its docblock.
- [ ] **Step 4:** Run `test/crawl/page-templates.test.ts`, `test/crawl/page-type*.test.ts` and the
  harness. Expected: PASS, with the harness censuses unchanged.
- [ ] **Step 5:** Commit:
  `perf(page-type): template inference collapses in SQL; JS memory no longer grows with shapes (27d)`.

---

### Task 10: Triage mapping and the dev-database prune

**Files:**
- Modify: `src/rules/registry/triage.ts:196`: `"performance.slow-response"` gains
  `sfIssue: "PageSpeed: Document Request Latency"`.
- Create: `scripts/prune-test-crawls.ts`
- Test: the triage test that pins the mapped count (update 132 → 133 mapped and the agree/differ
  split as measured); `test/scripts/prune-test-crawls.test.ts` (new)

**Interfaces:**
- Produces: `export function isTestHost(siteUrl: string): boolean`. It is true for a loopback IP
  (`127.0.0.0/8`, `::1`), the hostname `localhost`, or a hostname ending in `.test`, `.example`,
  `.invalid` or `.localhost`, or equal to one of those labels.
- The script:
  - **Without `--confirm`:** prints one line per matching crawl (`id status site_url pages`) and
    the totals, and changes nothing.
  - **With `--confirm`:** sets matching `queued`/`running` rows to `cancelled` in one `UPDATE`,
    then deletes each matching crawl through `ApiService.deleteCrawl(id, id)`.
  - Exits non-zero on the first failure, naming the crawl.

- [ ] **Step 1: Write the failing tests.**
  - **`isTestHost`:**
    - true: `http://127.0.0.1:35807`, `http://www.localhost:42275/`, `http://seeded.example/`,
      `http://[::1]:8080/`;
    - false: `https://lavishalice.com/`, `https://www.hurtigruten.com/en/`,
      `https://example.com/`.
  - **Script against a test database:** seed one fixture-host crawl and one real-host crawl.
    - a dry run lists only the fixture one;
    - `--confirm` deletes it and its child rows and keeps the real one.
  - **Triage:** the `triage-vs-sf` count test reflects the new mapping.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Then run the dry run against the dev database
  (`npx tsx scripts/prune-test-crawls.ts`) and put its totals in the ledger. **Do not run
  `--confirm`. The controller asks the owner first.**
- [ ] **Step 5:** Commit:
  `chore: slow-response maps to SF Document Request Latency; prune script for test-host crawls (27d)`.

---

### Task 11: Surface docs, skills, gate

**Files:**
- Modify: `docs/talos-surface.md`:
  - `notMeasured` shape in §4.3, §4.3b, §4.5 and §5.7;
  - `urls` entries;
  - unknown-key wording;
  - `timeLimited`;
  - sitemap failure reasons;
  - stop latency in each phase;
  - remove the §13 known limit on excluded counts and the M9 note.
- Modify: `docs/talos-integration.md` if it names the stop behaviour; `skills/*/SKILL.md` that
  quote `notMeasured` or sitemap timeouts.
- Modify: `docs/gates/phase-27b.md:184` if it still points at the SDD workspace for the Ruling 4
  patch.
- Create: `docs/gates/phase-27d.md`

- [ ] **Step 1:** Update the docs and skills. Keep cited test line numbers valid: grep
  `talos-surface.md` for `test/…:<line>` citations into files this phase touched and fix each.
- [ ] **Step 2: Run the gate clauses and record each in `docs/gates/phase-27d.md`.**
  1. **Suite and types.** `npx tsc --noEmit`; `npm test` twice (files / tests / 0 failed). The
     two stress loops (Tasks 1–2), 50/50 each.
  2. **No echo.** The no-echo test file passes.
  3. **Stop latency.** The `loop-stop-early` file passes. Put the measured latencies in a table
     (probe, discovery, flush, post-discovery, recheck, resources, render).
  4. **Sitemap timing.** The Task 3 tests pass, and the defaults are pinned.
  5. **Memory.** Run the 50k `--exclude` gate on a fresh database `ariadne_gate27d`:
     `DATABASE_URL=…/ariadne_gate27d node --max-old-space-size=512 --import tsx scripts/gate-rules.ts --exclude '*/products/p1*'`.
     Expected: peak ≤ 290.2 MB.
  6. **Real site.** A Hurtigruten crawl of `https://www.hurtigruten.com/en/` that reads every
     locale sitemap. **Controller asks the owner before running it.** Record whether the CDN was
     cold.
- [ ] **Step 3:** Commit: `docs: Phase 27d surface, skills and gate record (27d)`.

---

## After the plan

- Final whole-branch review → one fix wave → PR → `/code-review` → the owner merges.
- After the merge:
  - delete the SDD workspace;
  - ask the owner before dropping `ariadne_gate27d`;
  - run the prune script with `--confirm` only on the owner's OK.

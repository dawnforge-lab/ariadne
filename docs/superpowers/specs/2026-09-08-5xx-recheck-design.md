# 5xx re-verification pass: design (Phase 17)

Date: 2026-09-08. Owner direction ("merge and do your recommendations"): a 5xx seen once during a crawl may be a transient blip rather than a broken page, and today `http.server-error` records it as a `critical` site issue for life. This discharges the follow-up the severity recalibration deliberately deferred (`docs/superpowers/specs/2026-09-08-severity-recalibration-design.md` §1 "The transient 5xx caveat").

The distinction the owner has already drawn stands and is the ground for everything below: a crawl refusal (401/403/429, challenge) is a fact about the CRAWL SYSTEM and is now an `info` marker (`src/rules/page/status.ts`, `crawl.blocked`). A 5xx is different: the SITE answered "server error", so it is a fact about the site. What is unknown after one observation is not whether it happened but whether it PERSISTS, and only a second observation can say.

---

## 1. What the pass is

At crawl end, after the frontier drains and the known-404 probe has run, every `pages` row whose `fetch_class` is `server_error` is fetched exactly ONCE more, through the same `HostGate` instance, the same user agent, the same 20 s deadline, with `url-policy` re-applied to the URL, after a minimum delay since that row's first observation. The second observation is written to new columns on `pages`. The first observation is not touched.

One request per already-broken page, on a site that is already telling us it is unwell. That budget is the whole reason the design can be unconditional.

---

## 2. Decision 1: where the recheck outcome lives

### 2.1 Columns on `pages`, not a separate table

**Decided: five new columns on `pages` plus two on `crawls`, migration 0016.**

The decisive argument is the rule contract. `PageRecord = typeof pages.$inferSelect` (`src/rules/registry/types.ts:5`) and a page rule's body receives that row and nothing else. `http.server-error` is a page rule (`src/rules/page/status.ts`) and must stay one: moving the recheck outcome into a side table would force it to become a query rule with SQL of its own, for a fact that is one-to-one with a page row. A side table would also need a unique index on `(crawl_id, page_id)` to say the thing a column says for free: at most one recheck per page per crawl.

Supporting reasons:

- **The memory contract is honoured by the PASS, not by the storage shape.** The set of 5xx pages is streamed from SQL with a keyset cursor, exactly as `fetchCrawlResources` streams its work list (`src/crawl/resources/fetch-resources.ts`, `cursor` over `workList`, `WORK_BATCH`). No array of 5xx URLs exists at any point. RAM stays O(1) for the pass: it is sequential (§4.3).
- **Nulls are free.** Only 5xx rows carry values; on a healthy crawl every recheck column is null on every row.
- **Precedent.** `resources` carries its fetch outcome as columns on the row the analyzer wrote rather than in a second table, for the same one-to-one reason.

### 2.2 The original `fetch_class` stays as first observed. Explicitly.

**Decided: the recheck NEVER writes `fetch_class`, `status_code`, `fetch_reason`, `content_type`, `redirect_url`, or any analysis column.**

1. **The census describes one moment.** `fetch_class` is read by `isAuditable` (`src/rules/helpers.ts`), by the partial duplicate indexes whose predicates spell `fetch_class = 'ok'`, by `blockedPages`, by `site.health`, by the render selection, and by the CSV views. Flipping one row to `ok` retroactively moves a page into cohorts it was never measured in.
2. **A flipped row would be an always-passes hole (hard rule 1).** The recheck does not analyze the body (§4.5), so a row flipped to `ok` would be an `ok` page with a null `word_count`, null `title`, no links and no simhash: silently exempt from most of the ruleset while looking healthy.
3. **Two observations are two facts (hard rule 7).** Overwriting the first with the second is the silent fallback the repository forbids.

### 2.3 The page columns

```
-- migration 0016, on `pages`

fetched_at           timestamptz  -- when the FIRST observation was taken.
                                  -- Written by PageWriter on EVERY row. Null only on
                                  -- rows written before 0016.

recheck_fetch_class  text         -- the SECOND observation, in the `FetchClass`
                                  -- vocabulary (src/crawl/fetch-page.ts).
                                  -- NULL = no second observation exists.

recheck_status_code  integer      -- the status the second observation got, or null
                                  -- when there was no response (timeout, refused).

recheck_reason       text         -- why, in the fetch layer's own words.
                                  -- `pages.fetch_reason`'s twin, and null on a
                                  -- recheck that simply worked.

recheck_at           timestamptz  -- when the pass SETTLED this row. Moves with
                                  -- recheck_fetch_class: both null or both non-null.
```

### 2.4 The null contract, stated once and enforced by a test

| `recheck_fetch_class` | `recheck_reason` | meaning |
|---|---|---|
| NULL | NULL | **NOBODY ASKED.** The pass never ran (a crawl written before 0016, a crawl that `failed` before the pass), or it was cancelled before reaching this row. Nothing was decided. |
| NULL | non-null | **THE PASS DECIDED NOT TO ASK, AND SAYS WHY.** One reason at launch: `recheck-cap` (§4.4). The `RESOURCE_CAP_REASON` doctrine. |
| non-null | either | **A SECOND OBSERVATION WAS TAKEN**, or a request was refused by our own policy or by robots, which is `disallowed` plus a reason: a refusal is a decided outcome, not an absence. |

A recheck that itself FAILS is never an absent value: `fetchPage` already classifies a timeout as `timeout` and a DNS/socket failure as `network_error`, and both are written here as the classes they are.

**The invariant to pin:** `recheck_at IS NULL` ⟺ `recheck_fetch_class IS NULL`. Asserted in `test/db/migration-0016.test.ts`.

### 2.5 The crawl columns

```
-- migration 0016, on `crawls`

recheck_pass_at     timestamptz  -- when a recheck pass COMPLETED over this crawl.
                                 -- NULL = no complete pass is on record (the
                                 -- `crawls.rules_run_at` precedent). NOT stamped
                                 -- when the pass was aborted.

recheck_pass_count  integer NOT NULL DEFAULT 0
                                 -- rows the LAST pass rechecked (the
                                 -- `render_pass_count` precedent, with its trap: a 0
                                 -- is "rechecked nothing", which a crawl nobody ever
                                 -- rechecked also reports; `recheck_pass_at` tells
                                 -- them apart).
```

`recheck_pass_at` exists for one reader the page columns cannot serve: CHECK-83 and `crawl_status` need "did a pass run over this crawl at all". On a crawl with zero 5xx rows the two answers differ (`recheck_pass_at` set, no page carries anything), and that difference is the honest distinction between "no server errors" and "nobody looked".

### 2.6 Why `fetched_at` is in this migration

The evidence must carry the GAP between the two observations, and a gap needs two timestamps. `pages` has none today (`resources.fetched_at` is the precedent this borrows).

Alternative considered and kept as the FALLBACK when `fetched_at` is null (a pre-0016 crawl resumed by a 0016 loop): a single sleep of `MIN_RECHECK_GAP_MS` at the top of the pass. It is sufficient, since every 5xx row was written before the loop drained, but it can only bound the gap, never report it. The finding's `gapSeconds` is then `null`, the honest answer rather than a computed number nobody measured.

### 2.7 What the API and MCP surface expose

**`pages_query` / `PAGE_FIELDS`** (`src/api/service.ts`) gains five keys: `fetchedAt`, `recheckFetchClass`, `recheckStatusCode`, `recheckReason`, `recheckAt`. That projection is documented as "deliberately slim" (`docs/talos-surface.md`), so the argument: the recheck is the only mechanism on this surface that turns a `critical` into a `warning`, and an agent that cannot see the second observation cannot check the engine's arithmetic before quoting it to a client. Tenant-safety is unchanged: every value is composed from the response and the URL policy, never from a stack trace or a local path.

**`crawl_status` / `CrawlDetail`** gains one block, counted LIVE off `pages` in ONE statement, on the `resourceCoverage` discipline:

```jsonc
"recheck": {
  "serverErrors": 3,     // pages whose FIRST fetch was 5xx: the denominator
  "confirmed":    2,     // rechecked, still 5xx
  "cleared":      1,     // rechecked, the site answered something that is not 5xx
  "inconclusive": 0,     // rechecked, no answer ABOUT THE PAGE
                         //   (timeout | network_error | blocked | disallowed)
  "pending":      0,     // not rechecked at all: nobody asked
  "capped":    false,    // at least one row carries recheck_reason = 'recheck-cap'
  "passAt": "2026-09-08T14:02:11.417Z"   // crawls.recheck_pass_at; null = no complete pass
}
```

`confirmed + cleared + inconclusive + pending == serverErrors`, always.

**NOT on `CrawlListItem`.** A listing row is not a coverage report.

**`docs/talos-surface.md`** gains: the `recheck` block in §4.2's `crawl_status` shape and its reading, the five fields in §4.6's `pages_query` projection, and a §5.7 entry in the null-versus-zero section.

**CSV `internal_urls`** (`src/api/csv.ts`) gains `recheckFetchClass`, `recheckStatus`, `recheckAt`: a list of server errors that cannot be sorted by "still broken" is the wrong list.

---

## 3. Decision 2: how the rule expresses confirmed vs transient

A page rule's severity is a single literal fixed at definition time (`src/rules/helpers.ts`, `pageRule`), so a rule that reports two severities is not representable. The split is a split into rules.

### 3.1 Two rules, and the invariant that makes them safe

```
http.server-error            critical   CHECK-12   category: crawl
http.server-error-transient  warning    CHECK-12   category: crawl
```

They are defined against one predicate and are **mutually exclusive and jointly exhaustive over `fetch_class = 'server_error'`**:

- `http.server-error-transient` fires when the recheck produced a **non-5xx ANSWER from the site**.
- `http.server-error` fires in **every other case**.

No 5xx page is ever silent and no 5xx page ever carries two findings. That is the hard-rule-1 guard for this pair, asserted by looping over the whole `FETCH_CLASSES` union in the unit test (§5.1).

"A non-5xx answer" is a named constant in `src/rules/page/status.ts`:

```ts
/**
 * The recheck classes that mean THE SITE ANSWERED, AND NOT WITH A 5xx.
 * Membership separates a transient blip from a confirmed outage, so every
 * exclusion is deliberate:
 *   server_error   - confirmed, not cleared.
 *   blocked        - an answer about our CRAWLER, not about the page (owner
 *                    ruling, crawl.blocked, ruleset 0.12.0); it clears nothing.
 *   timeout        - no answer at all.
 *   network_error  - no answer at all.
 *   disallowed     - no request was made (url-policy or robots, on recheck).
 */
const RECHECK_CLEARED: ReadonlySet<FetchClass> = new Set([
  "ok", "redirect", "client_error", "non_html", "too_large", "unsupported_encoding",
]);
```

### 3.2 The third state: rechecked-and-unknown, and never-rechecked, both stay critical

**Decided: NO third rule. No `http.server-error-unverified` marker. `http.server-error` keeps firing at `critical`, and its evidence says which state it is in.**

1. **The rubric forbids `info`.** `info` is "nothing on the site is asserted to be broken". A 5xx we observed and did not re-verify is a 5xx we observed.
2. **The marker contract forbids it.** A marker means "a check COULD NOT BE ANSWERED on this crawl". CHECK-12 WAS answered: the site returned a server error. Persistence is a qualifier on an answer, not an absence of one.
3. **The severity spec already ruled on the tie-break.** "Under-reporting a broken page is the worse mistake." A pass that did not run leaves us in the pre-pass state and must produce the pre-pass verdict.
4. **A marker earns its place by explaining a SILENCE, and there is none.** The page carries a `critical` finding whose evidence says `recheck: "not run"`.

So: **no marker rule, no change to CHECK-83's NOT MEASURED family list.** The unmeasured-ness is surfaced in the evidence blob, in `crawl_status.recheck.pending`, and in a new CHECK-83 question 6.

### 3.3 The evidence shapes

`http.server-error`:

```jsonc
{
  "statusCode": 503,
  "recheck": "not run",           // "not run" | "capped" | "confirmed" | "inconclusive"
  "recheckStatusCode": null,      // 503 when confirmed; null when there was no response
  "recheckFetchClass": null,      // "server_error" | "timeout" | "blocked" | "disallowed" | null
  "recheckReason": null,          // the fetch layer's sentence, when there is one
  "gapSeconds": null              // seconds between the two observations; null when
                                  // there was no second one, or fetched_at is null
}
```

`http.server-error-transient`:

```jsonc
{
  "statusCode": 500,              // what the crawl saw
  "recheckStatusCode": 200,       // what the second look got
  "recheckFetchClass": "ok",
  "gapSeconds": 94                // null only on a pre-0016 row with no fetched_at
}
```

`recheck` is a four-value string rather than a boolean because "we never asked", "a budget stopped us", "it is still broken" and "we asked and learned nothing" are four different sentences a report writer needs.

### 3.4 Copy

`http.server-error`'s explanation and howToFix are reworded to name the second observation and to say plainly that a finding whose `recheck` is `"not run"` has not been re-verified. New entry for `http.server-error-transient`: title along the lines of "Server error that cleared on re-check", explanation stating both observations and that an intermittent 5xx still costs crawl rate, howToFix pointing at the application/upstream logs for the window between the two timestamps.

### 3.5 Ruleset bump

`RULESET_VERSION` `0.12.0` → **`0.13.0`**, with a comment entry stating three grounds: one rule added (`http.server-error-transient`); one verdict MOVED (`http.server-error` no longer fires on a 5xx whose recheck cleared); copy on `http.server-error`. Migration story, stated in the comment: nothing is backfilled; an older crawl re-judged at 0.13.0 reports exactly what it reported at 0.12.0, with `recheck: "not run"` added to the evidence. No old crawl silently loses an Error.

Totals move from 27/23/45 over 95 rules to **27 critical / 24 warning / 45 info over 96 rules**.

### 3.6 Checklist

CHECK-12 names both rules with severities in the parenthetical form the drift test parses, describes the three recheck states, and states the ruling: **a 5xx whose recheck did not run is still an Error, and `crawl_status.recheck.pending` is what says so.**

CHECK-83 gains **question 6: "Was the 5xx evidence re-verified?"** reading the `recheck` block. The NOT MEASURED family list is **not touched**.

---

## 4. Decision 3: crawl-loop mechanics

### 4.1 Where it hooks in: INSERTION 3c, in the loop, before the resource pass

**Decided: a new INSERTION 3c in `runToCompletion`, between the known-404 probe (INSERTION 3) and the resource fetch pass (INSERTION 3b).**

1. **It is a PAGE-phase question.** The 404 probe sits after the loop because it is "one more request to the ORIGIN, and it belongs with the page phase it reasons about". Same here.
2. **Running after the resource pass would measure a server we have just spent an hour loading.** The owner's own stated confound is "site under our load". Asking the 5xx question BEFORE spending R requests on the origin's images keeps the second observation as close to a clean read as this engine can get.
3. **Not an endpoint, because time is the measurement.** A recheck run days later by an agent is measuring a DIFFERENT SITE while stamping its answer on a crawl whose findings claim to describe one moment.
4. **An endpoint would make it optional in practice**, and the recalibration the owner asked for would not land.

`CrawlSummary` gains `recheck: RecheckPassSummary | null`, null on a crawl that failed before it had pages and on a crawl cancelled before the pass (the `resources: null` precedent).

### 4.2 The minimum delay: 60 seconds

**Decided: `MIN_RECHECK_GAP_MS = 60_000`, and the effective per-row wait is `max(MIN_RECHECK_GAP_MS, gate.spacingMs(host))`.**

Three things produce a transient 5xx: a request-scoped error under momentary load (seconds); an upstream, pool or container restart, a deploy (**tens of seconds to about two minutes**, the case that matters); a rate limiter answering 503 (already handled by the gate's back-off). 30 s covers only the front of the second. 60 s is the smallest number that covers its common shape. 5 minutes delays every crawl with one 5xx for marginal gain and misreads what the finding claims: "still broken an hour later" is a re-crawl's claim, not a pass's.

**The wait is paid at most once, not per row.** The work list is walked oldest-first (`order by fetched_at asc nulls first`), each row's wait is `max(0, fetched_at + MIN_RECHECK_GAP_MS - now)` and monotonically decreasing. Total added wall time is bounded by 60 s. When `fetched_at` is null, the pass uses `passStart + MIN_RECHECK_GAP_MS`.

The wait must be abort-aware: sleep in ≤250 ms slices checking `signal.aborted`, never one 60-second `setTimeout`.

### 4.3 Concurrency: one at a time, no pool

**Decided: strictly sequential.** The work list is empty on a healthy site; a site with many 5xx rows is a site in trouble and the last thing to do is open concurrent sockets to it (hard rule 9, the yellow.com.mt incident); the whole set is normally one host, which the gate serialises anyway. The pass has no `CrawlWindow` and takes no `maxConcurrency`. It takes the loop's `HostGate` **instance**, never a new gate, exactly as `fetchCrawlResources` does.

### 4.4 The cap

**Decided: `MAX_RECHECKS = 500`.** More than 500 server errors is a site-wide outage, not a set of broken pages. Rows past the cap keep `recheck_fetch_class` null and are stamped `recheck_reason = 'recheck-cap'` in ONE statement at the end of the pass, the `RESOURCE_CAP_REASON` shape verbatim including its `&& !aborted` guard: a stop the CALLER made is not a budget running out.

### 4.5 What one recheck does

```
for each row, oldest first:
  if signal.aborted            -> return { aborted: true }        (row untouched)
  wait until fetched_at + max(MIN_RECHECK_GAP_MS, gate.spacingMs(host)), abort-aware
  if signal.aborted            -> return { aborted: true }
  if budget spent              -> break; the cap stamp handles the rest
  isUrlAllowed(url)            -> refused: recheck_fetch_class='disallowed' + reason
  discovery.robots.isAllowed   -> denied:  recheck_fetch_class='disallowed' + reason
  await gate.acquire(host)
  result = fetchPage(url, { userAgent, allowPrivate, timeoutMs: FETCH_TIMEOUT_MS })
  gate.report(host, { fetchClass, statusCode, retryAfterMs, url })
  write recheck_fetch_class / recheck_status_code / recheck_reason / recheck_at
  DISCARD result.body
```

- **`isUrlAllowed` explicitly, hard rule 5.** `fetchPage` re-checks internally ("belt and braces, not a substitute"), but the explicit call is the one that produces a CLASSIFIED ROW rather than a throw. The policy is DNS-dependent; a hostname vetted three hours ago may now resolve into RFC1918 space.
- **`gate.report` after every request**, so a 503 on recheck escalates that host for anything that follows, including the resource pass, which shares the gate.
- **The body is discarded.** Analyzing it would produce a half-analyzed page whose links go nowhere.
- **No retries.** ONE more fetch. A timeout on the recheck is a `timeout` row and the finding stays `critical`.

### 4.6 Cancel mid-recheck

Rows the pass never reached keep **both nulls**. The pass returns `{ aborted: true }`; the loop ORs it into `aborted` before `status = aborted ? "cancelled" : "finished"`, as it does for `resourcePass?.aborted`. `crawls.recheck_pass_at` is **not** stamped on an aborted pass; `recheck_pass_count` is stamped with what was actually done.

A resume re-runs the pass, and the work list makes that free: it is `fetch_class = 'server_error' AND recheck_fetch_class IS NULL`, so a resume asks exactly the rows the interrupted run never reached. A `recheck-cap` row is still null, so a resume picks it up and overwrites the reason.

### 4.7 Containment

**Not contained**, like the resource pass; unlike the 404 probe. The pass classifies every site-side failure into a row, so anything it throws is OUR defect or a failed write. It propagates, `execute` closes the row `failed`, and the operator finds out (hard rule 7).

### 4.8 The demo panel

`src/demo/index.html`'s live progress panel gains one line, shown only when `recheck.serverErrors > 0`:

> `re-checking 3 server errors: 2 confirmed, 1 cleared, 0 left`

reading `crawl_status.recheck` on the existing 2 s poll. This is why the counts are read live off `pages`: a poller must see `pending` fall while the pass runs.

---

## 5. Decision 4: tests

### 5.1 `test/rules/status.test.ts` (extend)

- Metadata: `statusRules` holds three ids; `http.server-error-transient` claims `["CHECK-12"]`, category `crawl`, severity `warning`, **no** `marker` flag.
- `http.server-error` fires on all shapes: recheck null + reason null; recheck null + reason `recheck-cap`; recheck `server_error`; `timeout`; `network_error`; `blocked`; `disallowed`. Evidence asserts the four-value `recheck` string per case.
- `http.server-error-transient` fires on `ok`, `redirect`, `client_error`, `non_html`, `too_large`, `unsupported_encoding`; evidence carries both status codes, the recheck class and `gapSeconds` (and `gapSeconds: null` when `fetchedAt` is null).
- **The exhaustiveness guard:** loop over the whole `FETCH_CLASSES` union plus `null`, and assert that a page with `fetchClass: 'server_error'` and that recheck class produces EXACTLY ONE finding across the two rules.
- Both silent on every non-5xx first observation.
- `mkPage` (`test/rules/mk-page.ts`) gains the five new columns with null defaults.

### 5.2 `test/rules/registry.test.ts`, `test/rules/checklist-severity.test.ts`, `test/rules/copy.test.ts`

Severity literals move to 27/24/45 over 96. The checklist drift test goes red until CHECK-12 names both rules with severities. `copy.test.ts` is free: `copyFor` throws at registry build for a rule without copy.

### 5.3 `test/crawl/recheck.test.ts` (NEW)

Its own small `node:http` server in the `test/db/migration-0013.test.ts` style, not the shared fixture app (§5.6). The pass takes test-only options for the two constants, `minGapMs` and `maxRechecks`, on the `robotsRetryBackoffMs` / `maxCountedBytes` precedent, so the suite never waits 60 s.

Routes, with a per-path request counter: `/flaky` (stateful: 503 first, 200 with HTML after); `/broken` (500 always); `/ok` (200 always).

Cases:

1. `/flaky` keeps `fetch_class = 'server_error'` and `status_code = 503` **unchanged**, and gains `recheck_fetch_class = 'ok'`, `recheck_status_code = 200`, non-null `recheck_at`.
2. `/broken` gains `recheck_fetch_class = 'server_error'`, `recheck_status_code = 500`.
3. `/ok` has null in all four recheck columns, and the server saw **exactly one** request for it.
4. `/flaky` was requested **exactly twice**.
5. Politeness: with `perHostDelayMs` above zero, the recheck request lands at least one spacing after the previous one, and `gate.report` was told about the recheck's class.
6. Cancel: a signal fired before the pass leaves both recheck columns null on every 5xx row, the summary says `aborted: true`, `crawls.recheck_pass_at` is null, and `CrawlSummary.status` is `cancelled`.
7. Cap: `maxRechecks: 1` leaves the second 5xx row with `recheck_fetch_class` null and `recheck_reason = 'recheck-cap'`, and `crawl_status.recheck.capped` is true.
8. Hard rule 5: a 5xx row whose `pages.url` is rewritten in the database to a policy-refused target comes back `recheck_fetch_class = 'disallowed'` with the policy's own reason, no request issued.
9. Resume: a pass interrupted after row 1 and re-run asks only row 2.

### 5.4 `test/db/migration-0016.test.ts` (NEW)

In the `migration-0013.test.ts` discipline, driven through a REAL crawl of a real fixture server:

- `fetched_at` is non-null on **every** page row, within the crawl's `started_at`…`finished_at` window;
- the four recheck columns are null on every non-5xx row;
- the 5xx row carries them, and `recheck_at IS NULL ⟺ recheck_fetch_class IS NULL` holds over the whole table;
- `fetch_class` on the flapping row is still `server_error` after the pass;
- `crawls.recheck_pass_at` and `recheck_pass_count` are stamped;
- cascade: `delete from crawls` removes the rows.

### 5.5 API and MCP shape

- `test/api/query.test.ts`: `GET /crawls/:id` carries the `recheck` block; the partition equality holds on a real crawl; `pages_query` returns the five new fields and **still nothing else** (the pinned "slim projection" case is updated deliberately).
- `test/api/mcp.test.ts`: `crawl_status` and `pages_query` mirrors.
- `test/demo/flow.test.ts`: the recheck counts reach the page through the proxy.
- `test/skills/identifier-guard.test.ts`: free once the skills name only real ids and fields.

### 5.6 `test/fixtures/harness.test.ts` (edit, deliberately minimal)

**Decided: do NOT add a flapping fixture to the shared fixture app.** `/status/server-error` is stateless 503, so it is rechecked once and confirmed, and its `expectedIssues` are unchanged. The harness gains two assertions only: `/status/server-error` carries `recheck_fetch_class = 'server_error'` and still fires `http.server-error` at `critical`; `http.server-error-transient` fired on **no** fixture.

---

## 6. What this does NOT do

- **Nothing but `server_error` rows is re-fetched.** Not 4xx (an answer). Not `timeout` or `network_error` (the loop already retried those up to `MAX_ATTEMPTS`). Not `blocked` (owner-ruled a crawl-system fact). Not `non_html`, `too_large`, `unsupported_encoding` (deterministic non-answers).
- **Politeness limits are untouched.** Same `HostGate` instance, same UA, same `FETCH_TIMEOUT_MS`. `MIN_RECHECK_GAP_MS` is a floor ON TOP of the spacing, never instead of it.
- **No rule fetches.** Hard rule 2.
- **The first observation is never mutated.** §2.2.
- **The recheck body is never analyzed and its links are never enqueued.** §4.5.
- **No off switch, no config field, no API endpoint.** If an off switch is ever added it must stamp every row it skips with a reason, on the `RESOURCE_OFF_REASON` model.
- **Nothing is backfilled.** Every pre-0016 crawl reports `recheck: "not run"` and keeps every Error it had.
- **No eleventh NOT MEASURED marker, and CHECK-83's family list is unchanged.** §3.2.

---

## 7. Tasks

### T1: migration 0016 and the two timestamps

Files: `src/db/schema.ts` (five columns on `pages`, two on `crawls`, with the null-contract comments of §2.4); `drizzle/0016_*.sql` + `drizzle/meta/*` (drizzle-kit generated, `npm run db:migrate`, never hand-applied); `src/crawl/persist.ts` (`fetchedAt` in `pageRow`).

Tests: `test/db/migration-0016.test.ts` (columns, `fetched_at` stamped by a real crawl, recheck columns null before any pass, cascade); the persist test (the writer stamps `fetched_at`).

### T2: the recheck pass and the loop wiring

Files: `src/crawl/recheck/recheck-server-errors.ts` (NEW: `recheckServerErrors(db, crawlId, opts): Promise<RecheckPassSummary>`, the cursor work list, `MIN_RECHECK_GAP_MS` / `MAX_RECHECKS` / `RECHECK_CAP_REASON` with their reasoning in the module header); `src/crawl/loop.ts` (INSERTION 3c, `CrawlSummary.recheck`, the `aborted` OR, the `recheck_pass_at` / `recheck_pass_count` writes).

Tests: `test/crawl/recheck.test.ts` (all nine cases of §5.3); the loop test (an aborted crawl leaves the columns null and closes `cancelled`); the pass half of `test/db/migration-0016.test.ts`.

### T3: the rule split, the copy, the ruleset bump, the checklist

Files: `src/rules/page/status.ts` (`RECHECK_CLEARED`, both rules, the exclusivity comment); `src/rules/registry/copy/issue-copy.ts`; `src/rules/registry/registry.ts` (`RULESET_VERSION` `0.13.0` plus its comment entry); `skills/ariadne-audit/checklist.md` (CHECK-12, CHECK-83 question 6).

Tests: `test/rules/status.test.ts`, `test/rules/registry.test.ts`, `test/rules/checklist-severity.test.ts`, `test/rules/copy.test.ts`, `test/rules/mk-page.ts`.

### T4: the surfaces

Files: `src/api/service.ts` (`CrawlDetail.recheck`, a `recheckCoverage` private on the `resourceCoverage` model, the `getCrawl` wiring, five keys in `PAGE_FIELDS`); `src/api/csv.ts` (`internal_urls`); `src/api/mcp.ts` (the `crawl_status` and `pages_query` tool descriptions); `src/demo/index.html` (the live line); `docs/talos-surface.md` (§4.2, §4.6, a §5.7 null-versus-zero entry, the `internal_urls` row).

Tests: `test/api/query.test.ts`, `test/api/mcp.test.ts`, `test/demo/flow.test.ts`, `test/skills/identifier-guard.test.ts`.

### T5: harness, gate doc, phase mechanics

Files: `test/fixtures/harness.test.ts` (the two assertions of §5.6); `docs/gates/phase-17.md`.

Gate: full suite green, `tsc` clean, migration 0016 applied by `npm run db:migrate`, ruleset 0.13.0 with 27/24/45 over 96, and one recorded crawl showing a `recheck` block with a non-zero `serverErrors` and its partition summing.

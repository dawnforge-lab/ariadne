# Phase 27d gate: the 27 backlog

Date: 2026-11-10. Spec: `docs/superpowers/specs/2026-11-10-phase-27d-backlog-design.md`
("Gate 27d"). Plan: `docs/superpowers/plans/2026-11-10-phase-27d-backlog.md`. Branch
`worktree-phase-27d`, built on `be367ce` (main) through plan commit `1f18860`. The code under
test is `491c23c` (Task 10's last fix); this gate adds only docs, skills and this file.

**Verdict: every clause passes on the code, one is open until the PR exists.** Clause 1's last
sentence, "the PR's first CI run is green", cannot be shown before the PR is opened; it is the
only open item (§1). The 50k `--exclude` gate peaked at **271.9 MB**, inside 290.2 MB (§5), the
Hurtigruten crawl read all 11 sitemaps with no failure (§6), and the two formerly flaky tests
passed 50 of 50 runs each under CPU stress (§1). No limit was raised (hard rule 6).

Ruleset **0.25.0** (bumped once, in Task 3), 189 rules (72 page / 103 query / 14 metric), no
new rule. No migration (still 0000–0036). 27 MCP tools / 27 HTTP routes, unchanged. What
changed on the surface: `docs/talos-surface.md` ("What Phase 27d changed here", §4.1, §4.1c,
§4.3, §4.3b, §5.7, §13).

## Gate clauses

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite and `tsc` clean; both formerly flaky tests pass 50 runs in a row under CPU stress; the PR's first CI run is green | **pass, CI open**: `tsc` clean; two full runs of 156 files / 4,159 tests, 0 failed; renderer misprediction test 50/50 and the four HostGate pacing tests 50/50 under 2 CPU burners. The PR's first CI run: after the PR is opened | §1 |
| 2 | the sentinel-key test passes on every parser, route and MCP tool | **pass**: `test/api/no-key-echo.test.ts` (16 tests passed) | §2 |
| 3 | a pause and a cancel during each phase close within 2 s; a crawl paused in discovery and resumed has the same discovery result as an uninterrupted one | **pass**: `test/crawl/loop-stop-early.test.ts` 19 tests passed; highest measured latency 1,047 ms. Render has no stop to time: a rendering crawl is `finished`, so pause and cancel answer 409 (pinned) | §3 |
| 4 | a sitemap with late headers is read; one silent mid-body fails "no data for N s"; a walk past its total stops with `timeLimited` and the marker fires | **pass** on scaled timing (Deviation 1), with the real defaults pinned by a test | §4 |
| 5 | the 50k `--exclude` gate within 290.2 MB; template inference shows no growth with the number of shapes | **pass**: **271.9 MB** peak (crawl 271.9, render 217.7, rules 265.1); inference is one SQL statement returning one row at 3 and at 40,002 shapes | §5 |
| 6 | a Hurtigruten crawl reads every locale sitemap | **pass** (owner OK 2026-11-10): `crawl_d5207a58-e431-44b7-8f56-9b095e8a1c8b`, 11 sitemaps read, 0 failed, `timeLimited` false, 600 pages, hreflang coverage 100% | §6 |

## 1. Clause 1: suite, types and the two flakes

`npx tsc --noEmit`: clean. `npm test`, run twice on `491c23c` with the docs edits in the tree
(Chromium installed, Postgres 16 on 5440):

| run | files | tests | failed | skipped |
|---|---|---|---|---|
| 1 | 156 | 4,159 | 0 | 0 |
| 2 | 156 | 4,159 | 0 | 0 |

The baseline at `1f18860` was 152 files / 4,062 tests; 27d adds the files
`test/api/credential-store.test.ts`, `test/api/no-key-echo.test.ts`,
`test/crawl/loop-stop-early.test.ts` and `test/scripts/prune-test-crawls.test.ts`.

**The two formerly flaky tests, 50 of 50 each under CPU stress** (two `for(;;){}` burners on
this machine; recorded in the task reports, not re-run for the gate):

- Task 1, `test/crawl/renderer.test.ts` "never predicts a URL twice once a prediction for it
  was wrong". Diagnosis over 30 runs: 29 passed and one failed with "expected 7 to be 8".
  The mechanism was that page 1 paced the fetch too (the script response had not been
  recorded when the fetch paused), so the single misprediction landed on page 2. The test
  now asserts the releases themselves (`predicted` per release, `[false, true, false, false]`)
  rather than a total, and the renderer reports whether a release was a prediction
  (`RenderTestFaults.onRelease`). 50/50.
- Task 2, the four `loop.test.ts` "platform profile" pacing tests that asserted
  `minGap() >= 1000 - SLACK_MS` on request arrival times. They now read the HostGate's own
  granted slots (`HostGateOptions.onGrant`, `LoopTestHooks`), which are the thing the gate
  promises, and no slack. 50/50 (`-t "platform profile"` x50).

Ruling R6 records what was left: three arrival-time checks keep `SLACK_MS`.

## 2. Clause 2: no echo

`test/api/no-key-echo.test.ts` sends a sentinel key through every parser, route and MCP tool
and nested position (the start body, `judgement.rules` with a bad value, an unknown key inside
`judgement.rules.<id>`, query parameter names, resume, render, `crawl_config_set`), on HTTP and
MCP, and asserts the sentinel appears in no response body, no MCP result and no log line, and
that the log assertion is not vacuous (it checks something was logged). It also pins the
message shape (`key N in the order sent`, `(and N more)`, `did you mean`) and, with 100,000
unknown keys in one body, one refusal in linear time (Ruling R11: under 5 s where the
quadratic version took minutes; about 0.3 s measured). Result: 16 tests passed, in both full runs.

## 3. Clause 3: stop latency

`test/crawl/loop-stop-early.test.ts` (19 tests passed, in both full runs). Every test measures from the `control_request`
write to the row's terminal status and asserts at most 2,000 ms (`CONTROL_POLL_MS + 1,000`),
no extra slack. Latency, measured, in ms:

| stop | latency | source |
|---|---|---|
| pause / cancel during the host probe | 995–1,026 / 995–1,019 (10 runs); worst 1,047 | Task 4 |
| pause / cancel during the sitemap walk | 978–1,016 | Task 4 |
| pause during a sitemap flush (rows being written) | 538–656 | Task 4 |
| pause while `sitemap_urls` is written (post-discovery) | 28–106 (one run 1,021) | Task 4 |
| pause while the frontier is seeded (post-discovery) | 484–652 | Task 4 |
| pause written as discovery returns / seen as it returns | 994–1,032 | Task 4 |
| pause during a resumed crawl's re-walk | 993–1,012 | Task 4 |
| pause during the 5xx recheck pass | **898** (was 15,030) | Task 5 |
| pause during the resource pass | **959** (was 15,069) | Task 5 |
| render pass | none: pause and cancel answer 409 (the crawl is `finished`); a test pins the refusal while a page is in the browser | Task 5 |

A fresh pass with `STOP_LATENCY_LOG` set, in the first full run (one sample each, ms): probe
pause 1,016 and cancel 1,004; walk pause 983 and cancel 1,002; flush 614; `sitemap_urls` 18;
frontier seeding 446; written as discovery returns 1,009; seen as it returns 1,011; re-walk
1,001; recheck 919; resources 978. All inside the ranges above and under the 2,000 ms bound.

The hook-placed stops (flush, `sitemap_urls`, frontier) read low because the test holds until
the poll has fired; the poll's phase against the write varies. The page-loop stop is 27b's
(806–932 ms small crawl; 5.3 s at 50k, `docs/gates/phase-27b.md` §7), unchanged.

Equivalence after a discovery stop: "pause during a mid-document flush" and the two
post-discovery seeding tests assert that the resumed crawl's `sitemap_urls`, hreflang staging
and frontier equal an uninterrupted crawl's (Rulings R8, R9). A 10,000-entry sitemap pins the
seeding stop at 2,000 ms or less.

## 4. Clause 4: sitemap timing

`test/crawl/discovery.test.ts`, describe "discover: sitemap timing and walk budget (27d)"
(from line 1313):

- "pins the defaults to the spec values": `SITEMAP_TIMING` is 60,000 / 30,000 / 120,000 ms
  (headers / idle / total), `ROBOTS_TIMING` 20,000 ms, `DISCOVERY_WALK_BUDGET_MS` 600,000.
- "reads a document whose headers are late but within the limit".
- "fails a document whose headers come too late, naming the headers limit" (`no headers
  within 0.9 s` at the scaled value).
- "fails a body that goes silent, naming the idle limit" (`no data for 0.3 s`).
- "adds the hops up: three 500 ms hops fail the 1.2 s total" (`over 1.2 s in total`; Review
  Focus 3).
- "does not count flush time toward the total, the idle limit or the headers limit".
- "stops a walk past its budget: entries read so far are kept, the rest is cut short, not
  failed" and "a walk inside its budget is not time limited".

The marker firing on `timeLimited` and `interrupted` is pinned in
`test/rules/hreflang-completeness-query.test.ts`, and its copy in
`test/rules/copy-render.test.ts` and `test/fixtures/harness.test.ts` (columns "Sitemap Time
Limit Reached" and "Sitemap Walk Interrupted"). Real-time confirmation is clause 6.

## 5. Clause 5: memory

A fresh database `ariadne_gate27d` (migrated with `npm run db:migrate`; to be dropped by the
controller after the merge, owner-approved). Command:

```
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne_gate27d \
  node --max-old-space-size=512 --import tsx scripts/gate-rules.ts --exclude '*/products/p1*'
```

Node v22.23.2, on `491c23c`. Log: `gate27d.log` in the SDD workspace.

| | 27d (this run) | 27c run 1 | 27c run 2 |
|---|---|---|---|
| crawl id | `crawl_8d97f0af-b67b-4caa-91b6-a4c734f9b873` | `crawl_09b9bae6-…` | `crawl_b434ee4a-…` |
| exclude census | 11,111 refused, 11,111 linked | same | same |
| crawl | `finished`, **38,889 pages**, failed 0; 823.9 s, 47.2 pages/s | 770.4 s | 774.2 s |
| `excluded` rows / dropped | **11,111** / 0; 0 fetched rows the pattern refuses | same | same |
| render pass | 7 rendered of budget 500, 0 failures, 8.9 s | 7 | 7 |
| rules pass | 50,000 pages scanned, 121,082 findings, 38 metric rows, 297.2 s | 121,082 | 121,082 |
| phase peaks | crawl 271.9 MB (+812 s), render 217.7, rules 265.1 | 278.9 / 280.0 / 281.5 | 274.4 / 275.7 / 275.7 |
| **peak RSS** | **271.9 MB** | 281.5 MB | 275.7 MB |

Bound 290.2 MB (27b's 276.4 plus 5%): **passed**, 18.3 MB under, and the lowest of the three
runs on the scoped gate. The same finding count (121,082) and metric rows as 27c: the
template-inference rewrite changed no verdict.

**Template inference** (`inferPageTemplates`, Task 9): one CTE, one data-modifying statement,
one row of three counts back, whatever the number of shapes. The structural test
(`test/crawl/page-templates.test.ts`, Ruling R5) runs it at 3 and at 40,002 singleton shapes and
asserts the statement texts are identical and at most one row returns, which is the
deterministic statement of "no JS memory growth with shapes" (a heap delta would be a new
flake). The 48-type parity test pins the same retyping as before. Before 27d the
population came back one row per type, 4.1 MB + 2.1 MB at the gate's 40,002 shapes.

**Close time (the ⚠️ from Task 9, measured as far as it can be).** The gate script reports no
inference timing, and none was added (no code change in this task). The crawl row's window from
the last page fetched to `finished_at` is **25.9 s** (17:39:18.493 to 17:39:44.392). That window
holds the 404/recheck/resource passes and the inference together, so it is an upper bound on
inference, not its time. It is not comparable to 27c, which never recorded it. At 40,002
shapes the planner needed `SET LOCAL enable_nestloop = off` (Ruling R13): with it the retype
join took 4.35 s in Task 9's EXPLAIN ANALYZE; without it, stale statistics at the crawl close
chose a quadratic nested loop and the first full run timed out at 120 s. The isolated
inference timing at 50k remains unmeasured (open item 3).

## 6. Clause 6: Hurtigruten (owner OK 2026-11-10)

Driver `crawl-hurtigruten.mts` in the SDD workspace (not in `scripts/`), run once, on the dev
database: `siteUrl https://www.hurtigruten.com/en/`, `sitemapUrls
[…/en/sitemaps/en/sitemap.xml]`, `maxPages 600`, `fetchResources false`, the default robots,
crawl-delay and governor (1 s spacing, 16 workers), the project's branded user agent
(`AriadneBot/0.1`), nothing personal sent. One crawl, followed by one rules run. Crawl
`crawl_d5207a58-e431-44b7-8f56-9b095e8a1c8b`.

| fact | value |
|---|---|
| status, pages | `finished`, 600 (599 at 200, one redirect), 0 failed |
| sitemaps read / failed | **11 / 0** (`docsFetched` 11, `failures []`, 10 locales + ja-jp as in 26c) |
| failure reasons | none, so the new wording was not exercised live |
| `timeLimited` / `interrupted` | false / absent (not stopped) |
| entry / oversize / doc / depth limits | all false, 0 |
| `sitemap_urls` | 5,472 (5,460 on 26c's crawl: the site grew by 12) |
| staged `sitemap_hreflang` | 61,479 rows, 5,472 URLs, 11 sitemap sources |
| `hreflang` rows by source | sitemap 6,707 on 599 pages; html 15 on one page (`/en`) |
| `hreflang.coverage` (site) | **100%** (599 of 599 indexable pages) |
| hreflang and sitemap findings | `hreflang.self-only` 3, `hreflang.unlinked-target` 12, `hreflang.alternates-not-crawled` 1, `sitemap.uncrawled` 200 (the 600-page cap), no `hreflang.declarations-incomplete` marker |
| rules | 3,176 findings over 600 pages |
| wall time | crawl 766 s (12:46), plus the rules run: 780 s in all |
| peak RSS | **202.4 MB** |

The hreflang findings match 26c's hand-checked set (3 / 12 / 1 true; 26c §5.2). `sitemap.uncrawled` (200 findings) is a consequence of the 600-page cap on a 5,472-URL
sitemap, as `hreflang.alternates-not-crawled` is; it was not hand-checked beyond that.

**Was the CDN cold?** Not measured per document: the crawl does not record a sitemap's
response time and no extra live request was made (a probe request would itself warm the
cache). The evidence is indirect. The walk plus the host probe and robots took **166 s**
(crawl start to the first page row: 17:46:35 to 17:49:21) for 11 documents behind a 1 s
spacing, which is far more than spacing alone costs (about 20 s), so several documents took
well over the old 20 s limit, as 26c's cold-cache finding predicts (about 33 s on a cold copy).
On 26c's first crawl that was 20 of 20 documents failing; with the 27d limits it was 11 of 11
read. That is the clause's point: the cold case is now read, and the fixture in clause 4
carries the exact 33 s case in scaled form. The log: `hurtigruten.log` in the SDD workspace.

## Rulings

Made by the controller during the build, with the cost if wrong. Owner to see.

- **R1.** New fixture routes and tests in files `docs/talos-surface.md` cites go at the end of
  the file, or the implementer fixes the citations in the same commit. Cost: stale citations,
  caught in Task 11 step 1 (which found none stale).
- **R2.** Task 6's rule-id message interpolates `RULESET_VERSION`, never the literal "0.25.0".
  Cost: none.
- **R3.** Plan line numbers are as of `1f18860`; code is located by symbol. Cost: none.
- **R4.** The body-idle limit is our own pausable timer (reset per chunk, paused with the
  document deadline during a flush), not undici's `bodyTimeout`, which is set to the document
  total as a backstop. Otherwise a long flush under backpressure would trip "no data" on our
  own inserts. Cost: one timer per document.
- **R5.** Task 9's memory test is structural (statement count and returned rows), not a heap
  delta. Cost: a regression that materialises rows in a second statement is still caught by
  the call-count assertion.
- **R6.** Task 2 kept `SLACK_MS` for three arrival-time checks in the storefront describe
  (robots, sitemap and redirect-hop timing), which are outside the gate's slot path. Cost:
  one of those could flake on CI; the first CI run would show it.
- **R7.** Every Task 3 timer test keeps at least 300 ms between a fixture delay and the
  limit it must or must not trip; the asserted reason text follows the scaled limit. Cost:
  tests a second or two slower.
- **R8.** A stop during a re-walk (the row already holds discovery evidence) sets
  `discovery_jsonb.truncation.interrupted = true`, which joins the hreflang "cut short"
  condition and the marker's evidence, reason, columns and copy; the next completed walk
  rewrites the evidence. Not nulling `discovery_jsonb` (the rules run would say the crawl
  "predates the discovery record", which is false) and no staging-generation scheme (it needs
  a migration). Cost: one more truncation flag on the surface.
- **R9.** The post-discovery sitemap-entry enqueue and `persistSitemap` check the stop signal
  between batches; a resume re-walks and re-enqueues to the same frontier (pinned on a
  10,000-entry sitemap, 2,000 ms or less). Cost if wrong: a large-site stop right after
  discovery takes seconds.
- **R10.** `interrupted` describes the staging, not the outcome: on a resume, once
  `sitemap_hreflang` was cleared, any exit before the re-walk's evidence is written (stop,
  failed poll, any error) marks the kept evidence before the error propagates. Cost: a resumed
  crawl that failed mid-walk shows the marker instead of being judged on partial staging.
- **R11.** The 100,000-key timing tests' bound went from 1,000 ms to 5,000 ms: the quadratic
  version takes minutes, and 1 s left a few-times margin over 0.3 s on a 2-core CI runner.
  Cost: a regression to 2–4 s parse time would pass.
- **R12.** Two Task 8 review findings (talos-surface prose still saying `notMeasured` is rule
  ids; no "Excluded by scope" entries documented) were assigned to Task 11, not a fix round.
  Both are done in this task.
- **R13.** `SET LOCAL enable_nestloop = off` inside `inferPageTemplates`' transaction
  (reverted at COMMIT/ROLLBACK). Reviewer confirmed by EXPLAIN that stale statistics at crawl
  close give a quadratic Nested Loop on the retype UPDATE and the setting gives a Hash Join with
  no other plan change. Cost: one planner override to remember if Postgres planning changes.
- **R14.** The `169.254.169.254` crawl stays in the dev database: link-local is outside the
  prune script's `isTestHost` scope (loopback and reserved TLDs) that the owner approved. Cost:
  one leftover test row.
- **R15.** For a matched, non-live crawl (no unexpired lease) the prune script's guarded
  UPDATE clears a pending `control_request` whatever the status, and sets `cancelled` only for
  `queued`/`running`. Found by the first `--confirm` run (below). Cost: none for test-host
  rows.

## Deviations from the plan and spec

1. **Clause 4 tests use scaled timing** (a smaller `sitemapTiming` / `walkBudgetMs`), so the
   suite does not sleep 40 s; a separate test pins the defaults to the spec values.
2. **List-mode `notMeasured` reasons are sentences**, like `crawl_overview`'s, not the literal
   `list-mode`.
3. **Loop resume test.** The recon thought `starts` was not reset at a resume; it is. Only the
   slot-timing cause was fixed.
4. **"Excluded by scope" entries appear only on crawls whose config has `exclude` or
   `include`**; an unscoped crawl excludes nothing.
5. **robots.txt keeps its 20 s per-document total**; the new timing is for sitemap documents.
6. **Credential header and cookie names that are valid tokens may still be quoted** (27c
   Rulings 27/M13); the sentinel test skips valid-token credential names.
7. **The `crawl.list-mode` marker's own evidence keeps `notMeasured: string[]`**: finding
   evidence, not a surface field.
8. **The prune script's targets** are crawls whose `site_url` host is loopback or under
   `.test`, `.example`, `.invalid`, `.localhost` (or exactly `localhost`). Dead `queued`/`running`
   rows among them are set `cancelled` first because `deleteCrawl` refuses live statuses; a
   crawl with an unexpired lease is skipped as live.
9. **`SLACK_MS` was not deleted** (Ruling R6).
10. **The plan's `docs/gates/phase-27b.md:184` pointer fix was not needed**: line 184 already
    named `docs/gates/phase-27b-ruling4-inflight.patch`. The stale parts of Ruling 4 and
    Deviation 16 of that gate got a dated note instead; history is not rewritten.
11. **The Ruling 4 patch did not apply** (27c credentials moved the code) and was re-applied
    by hand in Task 5; the patch file stays as the 27b record.
12. **Render stop: no fix.** A rendering crawl is `finished`, so there is no stop to speed up;
    the 409 is pinned instead.
13. **Spec clause 3's "page loop" row** is 27b's, not re-measured here.
14. **`docs/talos-surface.md`'s `test/api/transport-parity.test.ts` citations** shifted by
    three lines in Task 8 (`:350` to `:353`, `:379` to `:382`), fixed there.

## The dev database clean-up (Task 10)

`scripts/prune-test-crawls.ts` (dry run by default, `--confirm` to delete; skips any crawl with
an unexpired lease). Run with the owner's approval of 2026-11-10: the first `--confirm` run
deleted about 128 test crawls and then **stopped loudly** on a `failed` crawl
(`crawl_lifecycle_afaa2375…`) with a cancel `control_request` still pending, because
`deleteCrawl` refuses a pending request and the script cleared one only on queued/running rows.
That was fix round 3 (R15); the second run deleted the remaining 18 (3 cancelled first).
**146 test crawls pruned in all** (2,349 pages in the first dry run). The dev database now
holds **8 crawls**: lavishalice x5, hurtigruten x2 (26c's two) and `169.254.169.254` x1
(Ruling R14); the 27d gate crawl of §6 makes a third hurtigruten crawl, kept as evidence.
`ariadne_gate27d` is dropped by the controller after the merge (owner-approved).

## Docs and citations (Task 11)

Updated: `docs/talos-surface.md` (status line and a "What Phase 27d changed here" block;
unknown-key wording in §4.1 and the credentials paragraph; the stop table in §4.1c; the
marker's `timeLimited`/`interrupted` keys, columns and a "Sitemap timing" paragraph;
`notMeasured` as `{id, reason}` in §4.3, §4.5, §5.7 and the export answer; the two "Excluded by
scope" `urls` entries in §4.3b; §11's ruleset version; the §13 known limits for excluded counts
and the queued-crawl credential race, both removed), `docs/talos-integration.md` (obligation 7,
stop latency), `skills/ariadne-crawl/SKILL.md` (sitemap timing, stop latency),
`skills/ariadne-audit/SKILL.md` (`notMeasured` shape, the new truncation flags), and dated notes
in `docs/gates/phase-27b.md` (Ruling 4, Deviation 16) and `docs/gates/phase-26a.md` (the
renamed flaky test). Citations: every `test/...:<line>` in `docs/` (outside the frozen 27d spec and plan)
into a file 27d touched was checked against the file: all of `docs/talos-surface.md`'s point at
their `it(`/`describe(` line; the two Task 8 fixes stand; `docs/gates/phase-26a.md:523` named a
line of the rewritten flaky test and got the note above. The older gate docs (phase 9, 10, 12,
13, 14) cite assertion lines inside tests, not test headers, and are frozen records.

## Deferred minors

None blocks the gate. Per task (from the controller's ledger; the SDD workspace is deleted
after the merge):

- **T1:** `renderer.test.ts` `launch({testFaults:{onRelease…}})` line is about 140 characters;
  `RenderTestFaults.onRelease` docblock has "(predicted: …)" spliced mid-sentence.
- **T2:** `docs/gates/phase-26a.md:519-520` still names the deleted `minGap() >= 1000 -
  SLACK_MS`; `loop.test.ts:376` two type imports on one line, `:459` terse `void (…)`.
- **T3:** the idle timer is not reset on `readCapped` paths (robots bodies, 3xx/4xx drains); undici
  backstop and connect timeouts fall through to `describeError` (raw text), and `isTimeout` is a
  dead import in `discovery.ts`; the walk-budget test does not pin the in-flight abort;
  `DiscoveryTruncation.timeLimited` is typed required though pre-27d rows lack it;
  `docsFetched` counts a budget-aborted document, the crawl-delay sleep precedes the budget
  check, the budget clock starts before the first sleep; un-reindented try blocks, an import at
  the end of `discovery.test.ts`, the hop fixture comment still says "< headers 600".
- **T4:** staged `sitemap_memberships` from a stopped walk survive via `onConflictDoNothing`;
  a fresh crawl stopped during `persistSitemap` keeps partial `sitemap_urls` with discovery null;
  unindented try body in `runToCompletion`; a pre-existing case: robots unreachable on a resume
  deletes the staging and rewrites evidence with no walk, so absence rules run over empty staging.
- **T5:** `AbortSignal.any` per resource over the long-lived crawl signal (listener build-up
  unverified; the 50k gate peak is the check, and it passed); a render test comment overclaims
  `refuseWhileBusy` for the paused case.
- **T6:** `rules/judgement.ts` imports `api/errors.ts` helpers; accepted-key lists duplicated
  from schemas; "in the order sent" is untrue for integer-like keys (documented in the
  surface doc); `positionOf` is an `indexOf` scan, fine once per refusal.
- **T7:** the race test does not prove B's `x-extra` header reached the site;
  `runQueued` called directly logs "left the queue state"; `settle(true)` is skipped if a throw
  lands between commit and settle (theoretical).
- **T8:** `list-mode.ts` imports a type from `api/overview`; `overviewDetailOn` runs two
  queries; no test for a scoped crawl with `excluded_dropped` null.
- **T9 (recommend fixing in the final wave):** nothing pins the planner setting. Assert the
  structural test sees `set local enable_nestloop = off` before the collapse and put a wall-clock
  bound (under 30 s) on the 40,002-shape run so a quadratic plan fails by name, not by a 120 s
  timeout. The family predicate is evaluated 3x per row; the 40,002-shape test takes 11–12 s.
- **T10:** the prune script loads every crawl row and filters in JS; `beforeCancel` is a test
  seam on an exported option; a non-pending, non-live crawl with an unexpired lease aborts the
  run via `deleteCrawl`'s lease refusal instead of "live, skipped"; `siteUrl` printed verbatim
  (a `user:pass@` URL would echo, pre-existing).

## Open items carried to Phase 28

1. **The PR's first CI run** (clause 1's last sentence), after the PR is opened.
2. **The final-wave fixes above** (T9's planner pin and wall-clock bound first).
3. **Inference timing at 50k was not isolated.** The close window is 25.9 s; isolating
   `inferPageTemplates` needs a timing line in `scripts/gate-rules.ts`.
4. **Per-sitemap response time is not recorded**, so "was the CDN cold" is inferred from the
   walk's wall time. Recording each document's time in `discovery_jsonb.truncation` would make
   the next real-site gate answer it directly.
5. **Not done in 27d, by scope:** scan sharing, PDF hreflang and the HTTPS fixture; the 27a triage
   calls still open (see the spec).
6. **Phase 28's tenant key** is still the thing that guards `crawl_delete` (obligation 7).

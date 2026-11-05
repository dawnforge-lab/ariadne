# Phase 25 gate: evidence layer

Date: 2026-11-04. Spec: `docs/superpowers/specs/2026-11-04-phase-25-evidence-layer-design.md`
(Gate section). Plan: `docs/superpowers/plans/2026-11-04-phase-25-evidence-layer.md`. Branch
`worktree-phase-25`, built on `86f1518`, gate run on `caf9c40` (the code that merges; this
commit is docs only).

**Verdict: clauses 1–6 pass.** Peak RSS 229,256 kB (223.9 MB) is within the 512 MB
contract and no worse than 24a's 229,288 kB. Both AriadneBot probes answered 200, so
the lingering-429 question did not arise. The gate surfaced no defect in the code. It
did surface one thing worth an owner's eye: on lavishalice every rendered page records
one uncaught exception, and it is the renderer's own blocking showing through (§3).

## Gate clauses (spec "Gate")

| # | clause | result | where |
|---|---|---|---|
| 1 | every row with an HTTP answer holds exactly the allowlisted headers sent; an over-cap value is stored cut and marked; rows with no response are null | **pass** | §1 (test), §5 (live: 600 of 600 answered rows, 0 cut, 2 null) |
| 2 | `crawls.request_headers` and `engine_version` set; every row `extraction_version = 1` | **pass** | §1, §5 (602 of 602 rows at 1) |
| 3 | render fixture page that throws, logs an error and requests a missing same-origin script holds all three; a third-party script appears only in `blockedByRenderer`; a clean page holds zero counts | **pass** | §2 |
| 4 | forced launch failure (browser, and a launch-time `UrlPolicyError`) leaves rows `render_pending`, sets `render_launch_error`, `render.coverage` says `failed` with the reason; a later pass clears it | **pass** | §2 |
| 5 | lavishalice: bytes per row, values cut, peak RSS ≤ 223.9 MB, probe pair | **pass**: 1,225 B avg / 1,449 B max, 0 cut, 223.9 MB, probes 200 / 200 | §3–§5 |
| 6 | full suite and `tsc` green, migrations through drizzle-kit | **pass**: 92 files / 2,499 tests, 0 skipped | §7 |

## 1. Clauses 1–2, pinned by tests

All in `test/fixtures/harness.test.ts`, describe "the evidence layer on the fixture crawl
(Phase 25)", over the whole fixture crawl (real Chromium, real fixture server):

- "stores response headers on every row that has a status code" (clause 1: the
  allowlisted headers the fixture sent, rows with an answer),
- "never stores response headers on a disallowed row, robots-blocked or refused"
  (clause 1: rows with no response are null),
- "cuts a header value over the cap and names the header in truncated" (clause 1: the
  cut marker),
- "stamps the current extraction version on every row" (clause 2, `extraction_version`).

Clause 2's crawl-level half is `test/crawl/loop.test.ts`, describe "crawl stamps
(Phase 25)": "stamps request_headers and engine_version when a crawl runs" and
"re-stamps engine_version on resume". Unit coverage for the allowlist, the cap and the
cut marker is `test/crawl/response-headers.test.ts` (5 tests) and
`test/crawl/versions.test.ts` (2 tests).

## 2. Clauses 3–4, pinned by tests

All in `test/crawl/renderer.test.ts` (real Chromium against the fixture server):

Clause 3, describe "PageRenderer":

- "records a thrown error, a console.error and a missing same-origin script"
  (the three kinds, one page),
- "a blocked third-party script is a count, not a failure" (`blockedByRenderer` only),
- "a clean page has zero counts",
- with "never records the top-level document as a failed request, even when it is a
  404", "records a request the network failed with Chromium's net error and no status"
  and "records a failed console.assert at level error",
- the row writer: describe "runRenderPass" › "writes render_console and render_version
  1" and "a pre-browser policy refusal writes render_version 1 with render_console
  null".

Clause 4, describe "runRenderPass" › "a pass that cannot launch (Phase 25 T4)":

- "leaves rows pending, records why, and coverage says failed" (browser launch),
- "records a launch-time UrlPolicyError as an address refusal, with no resolver text"
  (the `UrlPolicyError` case),
- "a later pass that launches clears it",
- with "records an uncreatable render directory without the path" and "keeps the
  original launch error when recording it fails too".

The `render.coverage` copy for the new column is pinned in `test/rules/copy.test.ts`
(the "Render Launch Error" assertion). The harness keeps `render.coverage.renderLaunchError`
as the one column allowed to be empty on a clean crawl.

## 3. Clause 5: the lavishalice run

One Node process, the way the engine runs, as in 24a's "The run": the script calls
`ApiService.startCrawl`, polls `getCrawl` every 15 s, then `ApiService.renderCrawl`
and `ApiService.runRulesForCrawl`. RSS was sampled every 250 ms (`process.memoryUsage.rss()`)
and the whole process was wrapped in `/usr/bin/time -v`. The script, the probe script,
the log, `result.json` and `time.txt` are in
`.superpowers/sdd/2026-11-04-phase-25-evidence-layer/gate25/` (crawl.mts, probe.sh,
crawl.log, result.json, time.txt). They are outside the committed tree.

Request: `{siteUrl: "https://lavishalice.com/", maxPages: 600, fetchResources: false}`,
render pass on, everything else an API default. The Shopify profile applied unchanged.
The crawl ran exactly once, with no retry.

Crawl: **`crawl_11e15602-63c4-4aa4-8b94-fb3b65908f19`**, 17:17:00 → 17:32:33 UTC, the
render pass to 17:35:16, rules done 17:35:19 (2026-11-04). The row is kept in the dev
database as evidence.

**Probe pair** (`curl -A "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)" https://lavishalice.com/`,
retried once after its own `Retry-After` if 429):

| probe | time (UTC) | answer |
|---|---|---|
| before | 17:16:53, 7 s before the crawl | **200**, no retry needed |
| after | 17:35:23, 4 s after the rules finished, 7 s after the render pass's last request | **200**, no retry needed |

24a's after-probe was sent 61 s after the run and got 429, which was ruled inconclusive
because its before-probe was 429 too. This pair is a clean 200 / 200: nothing was
refused before and nothing was left behind after.

**Platform.** `crawls.platform` = `shopify`; `platform_profile_jsonb` applied
`{"maxConcurrency": 1, "perHostDelayMs": 1000, "renderConcurrency": 1, "navigationTimeoutMs": 60000}`
at 17:17:05, 5 s after the crawl started.

**Throttle record**, unchanged after the render pass: `{"responses429": 2, "retryAfterSeen": 0,
"escalations": 2, "recoveries": 1, "recoveryLocked": true, "peakSpacingMs": 2000,
"finalSpacingMs": 2000}`. The same 2 / 2 / 1 and lock as 24a: one descent, one re-trip,
no oscillation, no page lost. `frontier` ended `{pending 0, leased 0, done 600, failed
0}`.

**Pages.** 602 rows: 504 ok/200, 94 redirect/301, 1 client_error/404, 1 non_html/200 and
2 `disallowed` (robots; `/account` and a faceted `/collections/new-in?filter…` URL). The
crawl ended at the cap (`frontier_capped` true, `pages_crawled` 600).

### Size of `response_headers`

```sql
select count(*), count(response_headers), round(avg(pg_column_size(response_headers))),
       max(pg_column_size(response_headers)), min(pg_column_size(response_headers)),
       count(*) filter (where jsonb_array_length(response_headers->'truncated') > 0)
from pages where crawl_id = 'crawl_11e15602-63c4-4aa4-8b94-fb3b65908f19';
```

| | |
|---|---|
| rows | 602 (600 with headers, 2 null: the robots-disallowed rows that were never requested) |
| **average bytes per row** (over the 600 rows that have it) | **1,225** |
| **maximum** | **1,449** |
| minimum | 536 |
| rows with a non-empty `truncated` list | **0 (no value was cut)** |
| total for the crawl | about 735 kB (600 × 1,225), against a `pages` table of 27 MB for the whole dev database |

The 13 header names stored on this site, with their row counts: `link`,
`strict-transport-security`, `content-security-policy`, `x-content-type-options`,
`content-type`, `server`, `x-frame-options`, `vary` (600 each), `cache-control` (599),
`content-encoding` and `content-language` (506), `etag` (505), `x-robots-tag` (4). No
`set-cookie` was stored on any row (allowlist working). The 1,449-byte maximum is a page
with a long `link` header and a CSP; nothing came near the cap.

`crawls.request_headers` = `{"accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
"user-agent": "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)",
"accept-encoding": "gzip"}`; `engine_version` = `0.0.1+sha-unknown` (see §8);
`extraction_version` = 1 on all 602 rows; `render_launch_error` null.

### Peak RSS and wall time

| stage | peak RSS (sampled) |
|---|---|
| crawl + recheck (600 pages) | 223.2 MB (234,065,920 B) |
| render (21 pages, Chromium out of process) | 219.7 MB (230,412,288 B) |
| rules (602 pages scanned, 1,270 findings) | 223.9 MB (234,758,144 B) |
| **process peak, `time -v` Maximum resident set size** | **229,256 kB = 223.9 MB** |
| 24a's figure for the same request | 229,288 kB (223.9 MB) |

The gate asks for at most 223.9 MB: **met**, with 32 kB to spare against 24a, so there
is no measurable change from storing headers or console. The 250 ms sampler's own peak
was 234,758,144 B (223.88 MiB). Chromium's processes are not in the figure, as in 24a.

| | |
|---|---|
| crawl wall time | 15 m 33 s (933 s), against 24a's 15 m 36 s |
| crawl + render + rules, `time -v` elapsed | 18 m 20.8 s (24a: 18 m 36.6 s) |

### Render pass and `render_console`

`ApiService.renderCrawl` answered `{"rendered": 21, "failures": 0, "unrendered": 0,
"elapsedMs": 162733, "requests": {"paced": 62, "fromCache": 280, "unpacedNetwork": 0},
"unpinnedHosts": [], "selection": {"mode": "auto", "selected": 21, "budget": 30, ...}}`.
The rows agree: 21 rendered, 0 `render_error`, 21 with `render_version` 1 and a non-null
`render_console`. 24a's figures (21 renders, 60 paced, 280 cached, 0 unpaced) are
reproduced.

| `render_console` totals across the 21 rendered rows | |
|---|---|
| `consoleTotal` | 34 (all level `warning`; 21 pages carry at least one) |
| `exceptionsTotal` | 21 (one per page) |
| `failedRequestsTotal` | 0 |
| `blockedByRenderer.thirdParty` | 534 |
| `blockedByRenderer.sameOriginAssets` | 490 |

What those are, read from the rows:

- The 21 exceptions are all the same text, `Uncaught TypeError: Failed to fetch
  dynamically imported module: https://cdn.shopify.com/shopifycloud/shop-js/modules/v2/loader.init-shop-cart-sync.en.esm.js`.
  That is Shopify's third-party module, which the renderer blocks by design, so the
  page's own dynamic `import()` rejects. It is **the renderer's blocking showing up as
  a site exception**, the case the controller ruled on in Task 3 (the blocked
  third-party script lands in `exceptions` as an uncaught error and never as a failed
  request). It is a real finding about the evidence, not a defect in the capture: a
  Phase 30 rule reading `exceptions` on a Shopify site must treat this one message as
  render-induced noise. See §8.
- The 34 console messages are a site script's `Geo location API failed TypeError:
  Failed to fetch`, a warning with a stack, whose geo lookup is a third-party request
  the renderer also blocked. Same cause.
- `failedRequestsTotal` is 0: no same-origin request failed. The 490 same-origin assets
  the renderer declined (images, fonts, media) and the 534 third-party requests are
  counts only, as designed.

## 4. Memory

See the table under "Peak RSS and wall time". 223.9 MB is under the 512 MB contract and
equal to 24a. The 50k measurement is still owed (carried).

## 5. Clauses 1–2, live

On the gate crawl: all 600 rows that got an HTTP answer carry `response_headers` (504
ok, 94 redirects, the 404 and the non-HTML row each included); the 2 `disallowed` rows
are null; none was cut (`truncated` empty on all 600); `extraction_version` is 1 on all
602 rows; `crawls.request_headers` and `engine_version` are set.

## 6. Controller rulings made this phase (binding; full text in the SDD ledger)

- Task 1 `response-headers.ts` truncation: header values are latin1 from undici and
  llhttp rejects NUL, so jsonb-unsafe text is unreachable there. The same risk is
  reachable for console text, so Task 3 makes every stored string well-formed
  (`toWellFormed`), replaces U+0000 with a visible marker, and cuts on a code-point
  boundary.
- NUL marker is U+2400 (a visible, unambiguous mark vs literal "\u0000" text), set
  before capture version 1 shipped.
- The third-party-blocking error lands in `exceptions`, not `console` (intent: recorded
  as an error, never a failed request). Confirmed by the live run above.
- Browser Log-domain messages (CSP, mixed content, interventions) are not captured, so
  `render_console` stays site-authored. Worker and out-of-process-frame console is out
  of scope (third-party frames are blocked).
- A pre-browser policy refusal writes `render_version` 1 with `render_console` null.
- Task 4 skill, checklist and MCP wording is written by the implementer, with no TODO
  placeholders. `render.coverage` client copy was written by the controller.
- `blockedByRenderer.thirdParty` keeps one count; the docstring is corrected. Phase 30
  splits it with a `render_version` bump if a check needs it.
- `stackOf` and `AggregateError` logging stays a follow-up outside this branch.
- The flaky 24a pacing test was fixed in this branch (`caf9c40`): it asserts the gate's
  slot guarantee (release i at or after doc release + i × spacing − 5 ms), not pairwise
  gaps. Removing the acquire still fails it.
- The final whole-branch review (opus, `86f1518..4080635`) ran before this gate so the
  gate measures the code that merges. All its Important findings and minors 4–8 were
  fixed in the final wave (`4080635..caf9c40`).
- Task 4 review fix round 1: checklist wording, Chromium leak on a failed clear-update,
  masked launch error (now an `AggregateError`), the `docs/talos-surface.md`
  vocabulary.

## 7. Verification

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **92 files / 2,499 tests, 0 failed, 0 skipped** (144 s, 2026-11-04 on `caf9c40`) |
| `npx tsc --noEmit` | clean |
| `git status` | clean before this commit |
| migrations | **0000–0025** (26 files, applied with `npm run db:migrate`; 0025 adds `pages.response_headers`, `pages.extraction_version`, `pages.render_console`, `pages.render_version`, `crawls.request_headers`, `crawls.engine_version`, `crawls.render_launch_error`) |
| ruleset | **0.19.0** (`src/rules/registry/registry.ts`; was 0.18.0) |
| rules | **114**: 33 page / 67 query / 14 metric (counted from `buildRegistry()`) |

Baseline at branch point: 2,449 tests / 86 files, so the phase adds 50 tests and 6 files.

## 8. Ledger for what comes after Phase 25

### Observations from this gate

- **Shopify's blocked module shows up as an exception on every rendered page.** 21 of 21
  pages carry the same `exceptions` entry, caused by our own third-party blocking, and the
  geo-lookup warning has the same cause. Whoever writes the Phase 30 console rules should
  either filter exceptions and console entries whose text names a URL the renderer
  blocked, or the renderer should tag such entries at capture time (a `render_version`
  bump). Today the evidence is honest about what happened (the text names the blocked
  module) but a naive "page has JS errors" rule would flag every Shopify page. Not
  changed here; owner's call on which side fixes it.
- `engine_version` reads `0.0.1+sha-unknown` because `ARIADNE_GIT_SHA` is set nowhere.
  The value says so rather than inventing a sha. Phase 28 images set it.
- The 24a lingering-429 question is now answered for this run (200 / 200), but it is one
  run, against a live shop whose bucket state is unknown. It does not retire the 24a
  ruling that the Shopify floor stays 1000 ms.

### Deferred follow-ups (from the task and final reviews)

- Load-sensitive tests on `main` (pre-existing, they fail under parallel load, not on
  this branch's code): renderer "never predicts a URL twice once a prediction for it was
  wrong" (about 2 of 36 loaded runs), and the platform-profile pacing cases in
  `loop.test.ts` and `host-probe.test.ts`. They want a flake ticket.
- `stackOf` does not print `AggregateError` children, so a 500 log line lacks the inner
  errors (house-wide pattern).
- Minors: `response-headers.ts` slice can split a surrogate pair (unreachable: latin1);
  `truncated.includes` is O(n²) for n up to 20; the `/headers-then-stall` fixture leaves a
  socket open like `/hang`; the `render_launch_error` docblock says "never the raw
  error's message" where "never resolver or transport text" is accurate; the
  AggregateError message omits the original error's text (it is in `.errors[0]`);
  `versions.ts` reads `package.json` relative to `src/crawl` and would throw loudly under
  a `dist` layout; the surface-unchanged test hard-codes `exportDir` `/tmp`; the harness
  test pins Chromium's `net::ERR_EMPTY_RESPONSE` for the locked browser; flood
  efficiency (console text joined and sanitised before the cap check); `onFailed`
  network-level branch is tested only through the real browser case; commit `154e491` is
  red until `9d7b87b` (bisect only).
- Carried from earlier gates: the 50k memory measurement (yellow.com.mt allowlist), and
  `crawl_status.pagesCrawled` reading 0 while a crawl runs (24a observation; `frontier.done`
  is the live count).

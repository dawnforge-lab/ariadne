# Phase 27d — Clearing the backlog before Phase 28

Date: 2026-11-10. Predecessor gate: Phase 27c (`docs/gates/phase-27c.md`, merged in PR #27,
`be367ce`).

Status: design, awaiting owner review. Owner direction (2026-11-10): "let's clear the backlog
first", then "write the design and show it to me" (question round skipped). The scope below
is my call; the calls the owner should check are listed at the end.

## Intent

Phase 28 hands Ariadne to Talos: several workers, a scheduler, a 50k CI gate. Before that,
the debts we already know about should be paid, because each one gets more expensive once
more than one process runs the engine:

- **CI is not trustworthy.** Two timing tests fail on CI often enough that "re-run the failed
  job" has become routine (the renderer one has failed five merges in a row). A gate that is
  re-run until green proves nothing.
- **A real site loses its sitemaps.** Hurtigruten needs about 33 s to build a cold sitemap;
  discovery gives each document 20 s, so a first crawl loses every sitemap URL and all its
  hreflang.
- **A stop is not always a stop.** A pause or cancel is ignored while the host probe and the
  sitemap walk run, and an in-flight recheck or resource request finishes before the pass
  notices. An agent that asks a crawl to stop should see it stop.
- **Secrets can be echoed.** 27c made sure credential values never come back in an error. But
  the 27a/27b parsers still quote any unknown key they receive, so a secret pasted into the
  wrong place comes straight back in the 400.
- **Smaller surface debts** from 27c: a credential race on queued crawls, two shapes under one
  field name, an overview that does not count excluded pages, a route with no equality test.
- **One memory debt.** Template inference at crawl close still holds O(distinct URL shapes) in
  JS memory (hard rule 6 says O(concurrency)).

Success: CI goes green on the first run, every time; Hurtigruten's cold sitemaps are read; a
stop is honoured within about two seconds in every phase; no request ever gets one of its own
keys back in an error.

## Goals

### 1. Two flaky tests made deterministic (root cause, not retries)

**`renderer.test.ts` "never predicts a URL twice once a prediction for it was wrong"**
(`test/crawl/renderer.test.ts:1304-1325`, CI fails as `expected 7 to be 8`).

- What it counts: pages that fetch `/volatile.js` both as a script and with `fetch()`. The test
  expects the one misprediction on page 1, so 8 paced requests.
- Most likely cause: on page 1, Chromium's `Fetch.requestPaused` for the `fetch()` can arrive
  before `Network.responseReceived` for the script. The two events travel on separate channels
  with no ordering guarantee. Then the misprediction happens on page 2 instead, and the count is
  3 + 1 + 3 = 7 with `unpaced` still 1 — exactly the CI failure.
- The product holds its contract in every ordering ("a URL reaches the site unpaced at most once
  per context"). The test pins which page the misprediction lands on, which is not the contract.
- Fix:
  - First confirm the mechanism. Log `{paced, unpaced, cached}` per page under CPU load; a second
    candidate (Blink's memory cache serving the script on a later page) shows a different
    pattern.
  - Then rewrite the test around the contract. A test hook reports each release with whether it
    was predicted (today's `RenderTestFaults.onRelease` carries no flag). Restructure the fixture
    so "record" is ordered before "predict" by a page boundary: render a priming page (script
    only), then fetch-only pages. Assert exactly one predicted release of the URL that went to
    the network, and every later release of it paced.

**`loop.test.ts` "re-enters the recorded profile on a resume"** (`test/crawl/loop.test.ts:2322-2356`,
recorded failing as 982 vs ≥ 985).

- It measures gaps between request *arrivals at the server*. `HostGate` hands out scheduled
  slots, so if one request arrives 18 ms late and the next is on time, the gap reads 982 though
  the slots were right.
- The `SLACK_MS` comment names the wrong error source.
- `starts` is also not reset between the aborted run and the resume.
- Fix: measure slot times from the gate (the renderer suite already switched to slot timing for
  the same reason). Reset `starts` at the resume. Correct the comment.

Acceptance: each test passes 50 runs in a row under CPU stress locally (both cores saturated),
and the PR's CI is green on its first run.

### 2. Sitemap discovery waits long enough, but not forever

Today (`src/crawl/discovery.ts`):
- `DEFAULT_TIMEOUT_MS = 20_000` is a deadline per redirect hop covering connect, headers and body
  together. It is paused while rows flush.
- undici's `bodyTimeout` is the same 20 s, so a 20 s gap between chunks also aborts the read.
- There is no walk-wide time limit; the walk is bounded by count caps only. 300 documents ×
  6 hops × 20 s is the theoretical worst case.

New timing (my call on the values; the owner asked for "a value and whether it is idle or
total"):
- **Time to headers: 60 s.** This covers cold generation; Hurtigruten measured about 33 s.
- **Body idle: 30 s** with no bytes arriving.
- **Document total: 120 s** per document, all redirect hops included, flush pauses excluded.
- **Walk total: 10 minutes** of wall-clock for the whole discovery walk.
- When the walk total is hit, the walk stops and the crawl continues with what it read. A new
  truncation flag `timeLimited` joins the existing ones (`hreflangLimited`, `entryLimited`,
  `docLimited`, `depthLimited`).
- It counts as "cut short", so the four absence-based hreflang rules refuse and
  `hreflang.declarations-incomplete` fires with `timeLimited` in its evidence and `reason`.
- `sitemap.invalid` keeps reporting each document that timed out. Its text says which limit was
  hit ("no headers within 60 s", "no data for 30 s", "over 120 s in total").
- The values are constants in `discovery.ts`, not per-crawl config (non-goal below).

### 3. A stop is honoured in every phase

Target: a pause or cancel request closes the crawl within `CONTROL_POLL_MS` (1 s) plus 1 s,
whatever phase it is in.

- **Host probe and discovery.** The `ControlWatcher` already polls during them, but its signal
  never reaches `discover()` or the host probe. Pass it through to every request they make, and
  check it between sitemap documents.
  - When it fires, the loop closes the crawl without writing discovery evidence or enqueuing
    sitemap entries.
  - On resume, discovery runs again from scratch. It already does today.
  - Any rows the walk staged before the stop must not survive into the resumed walk's result. A
    resumed crawl's discovery result must equal an uninterrupted one's.
  - A cancel during discovery leaves a "never ran" crawl, with the 27b wording for that.
- **Recheck and resource passes (27b Ruling 4).**
  - Re-apply the parked patch (`docs/gates/phase-27b-ruling4-inflight.patch`). It no longer
    applies cleanly, because 27c added credentials to the same calls.
  - With it, the in-flight request is aborted, not awaited, and its row stays unwritten, so the
    resume fetches it again.
- **Render pass.** Measure first. If a stop during a render takes longer than the target, abort
  the in-flight page the same way.
- Delete `.superpowers/parked/phase-27b-ruling4-inflight.patch` (a git-ignored duplicate) once
  this lands.

### 4. No request ever gets its own keys back

The rule: an error may name a key the client sent by **position** ("key 3 in the order sent"),
and may name the **accepted** key it most likely meant ("did you mean `requestHeaders`?"). It
never quotes the sent key. This is the rule 27c's credential parser already follows
(`src/crawl/credentials.ts:200-218`).

Places that quote today (from the recon):
- `src/api/config-schema.ts:636` `unknownField`. It serves `crawl_start` / POST `/crawls`,
  `config_validate`, and `crawl_config_set`'s `crawl` part. The MCP `crawl_start` top-level error
  at `:832` joins every unknown key.
- `src/api/service.ts:396`, `:440`: the resume and render parsers.
- `src/api/service.ts:4622`: `crawl_config_set` top level, which lists every refused key.
- `src/api/config-schema.ts:897`, `src/rules/judgement.ts:107-108`: judgement-block keys and rule
  ids.
- `src/api/http.ts:870`: unknown query parameter names, on every route.
- MCP tools: the SDK rejects a `z.strictObject` input before our handler runs, with zod's issue
  JSON, which carries `"keys": ["<key>"]`. The tools need input schemas whose unknown-key refusal
  is ours. Whether that is a custom zod error or a passthrough schema checked in the handler is
  the builder's choice. Verify against the SDK's actual output.

Values are out of scope, except credentials, which 27c already covers. A URL in an error is the
URL the client asked about.

Test: a sentinel string sent as an unknown key at every parser, route and tool (nested keys
included) appears in no response body, no stored column and no log line.

### 5. 27c leftovers

- **Queued-crawl credential race (M9, 27c Ruling 17).**
  - The race: `crawl_config_set` commits a new credential shape, then updates the in-memory map
    (`service.ts:4854-4868`). A runner dequeuing in the gap reads the new row and the old map
    entry, and the crawl fails with "needs credentials of another shape".
  - Fix: the in-memory store keeps credentials keyed by crawl *and* shape. The new entry is added
    before the commit and the old one removed after it. The runner takes the entry matching the
    shape on the row it read. A rollback removes the new entry.
- **Repeated headers on a credentialed render (M6).** The recon judged this low risk. CDP hands us
  headers as an object, so a name appears once, and Chromium already joins duplicates. Close it
  with a test: a credentialed render of a page whose request carries a header we replace and one
  we don't. Each must reach the server as one line. If the test shows a loss, fix it.
- **`crawl_overview`'s `urls` section counts excluded pages.**
  - Add "Excluded by scope (stored)" and "Excluded by scope (dropped)" (`excluded_dropped`), the
    same way robots-blocked rows are counted.
  - Stored excluded rows join "Encountered", as stored robots-blocked rows do.
  - This removes the known limit at `docs/talos-surface.md` §13.
- **One shape for `notMeasured`.**
  - Today listings, `issues_overview` and exports carry `string[]` (rule ids), while
    `crawl_overview` carries `{id, reason}[]`.
  - `export_crawl view=crawl_overview` returns the string form while its CSV rows carry objects.
  - My call: `{id, reason}[]` everywhere. Listings give reason `list-mode`, the only reason they
    have today.
  - This breaks the listing shape, which is acceptable because no client consumes it yet (Talos
    integration is Phase 28/29).
- **A route-equality test for GET `/crawls/:id/overview/issues`** against `issues_overview`, in
  `test/api/transport-parity.test.ts`.

### 6. Template inference at crawl close in SQL (hard rule 6)

- `inferPageTemplates` (`src/crawl/page-type.ts`) still loads one row per distinct URL shape and
  builds the collapse mapping in JS: 4.1 MB + 2.1 MB at 40,002 shapes.
- Move the population, family and collapse steps into one data-modifying SQL statement, so JS
  memory is O(1).
- The SQL predicate duplicates `detectUrlTemplate`'s "is this segment a slug?" test. A parity test
  over shared fixtures pins the two together, and `collapseTemplates` stays as the test oracle.
- Idempotence, and the "client type spelled like a path" behaviour, must carry over exactly.

### 7. Dev database clean-up

- The dev database (954 MB) holds 154 crawls. Almost all are left by the test suite, which runs
  against the same database: `127.0.0.1:*`, `localhost:*`, `seeded.example`. That includes 11
  `running` and 8 `queued` crawls that will never run.
- A one-off script lists every crawl whose host is a loopback or fixture host. It shows the list,
  then deletes them through the 27b `crawl_delete` path (every child table) on `--confirm`.
- Real-site crawls (lavishalice, Hurtigruten) are kept, because the gates re-judge them.

## Non-goals

- **Cross-rule scan sharing** (several rules re-scanning the same rows). This is an engine
  change; it belongs with Phase 28's performance work.
- **Judging hreflang declared in a PDF's `Link` header (26c R16).**
  - Every declarer gate in the hreflang rules would need a second predicate, and the cluster
    rules would need a ruling on what "indexable" means for a PDF. That is a lot of surface for
    a rare case.
  - Today those alternates already count as return links; only the PDF's own set goes unjudged.
- **An HTTPS fixture for `social.image-insecure`.** The 26c gate judged that it costs more than it
  proves.
- **Per-crawl sitemap timing.** Constants until a client asks.
- **A separate test database.** Running the suite against its own database would stop residue
  coming back. It changes how every developer and CI runs tests, so it is its own decision; this
  phase only cleans up.
- The Phase 28 carries recorded in `docs/gates/phase-27c.md` (credentials across workers,
  re-admitting dropped excluded URLs, subdomain crawling).

## Surface changes (Talos-facing)

- Listings, `issues_overview` and exports: `notMeasured` becomes `{id, reason}[]`.
- `crawl_overview` `urls`: two new entries; "Encountered" includes stored excluded rows.
- Error wording for unknown keys, rule ids and query parameters: positional plus "did you mean".
- `discovery_jsonb.truncation` gains `timeLimited`. The `hreflang.declarations-incomplete`
  evidence gains `timeLimited`. `sitemap.invalid` reasons name the limit that was hit.
- `docs/talos-surface.md` and the skills are updated for each. Ruleset 0.25.0, because the marker
  evidence changes. No migration expected (`discovery_jsonb` is jsonb).

## Gate 27d

1. **Suite and types.** The full suite and `tsc` are clean. Both formerly flaky tests pass 50
   runs in a row under CPU stress. The PR's first CI run is green.
2. **No echo.** The sentinel-key test passes on every parser, route and MCP tool.
3. **Stop latency.** A fixture with slow endpoints sends a pause and a cancel during each of:
   host probe, discovery, page loop, recheck, resources, render. Each closes within 2 s. A crawl
   paused during discovery and then resumed has the same discovery result as an uninterrupted
   one.
4. **Sitemap timing.** Each fixture sitemap behaves as follows:
   - one that sends headers after 40 s is read;
   - one that goes silent for 35 s mid-body fails with "no data for 30 s";
   - a walk that would run past the walk total stops with `timeLimited`, and the marker fires.
5. **Memory.** The 50k `--exclude` gate stays within 27c's 290.2 MB bound. A heap sample during
   template inference shows no growth with the number of shapes.
6. **Real site (needs owner OK at gate time).** A Hurtigruten crawl reads every locale sitemap.
   If the CDN is warm, the fixture in clause 4 carries the 33 s case.

## Calls I made (owner to check)

1. **Scope.** Flakes, sitemap timing, stop latency, key echo, the 27c leftovers, SQL template
   inference and the DB clean-up are in. Scan sharing, PDF hreflang and the HTTPS fixture are out.
2. **Sitemap timing values.** Headers 60 s, body idle 30 s, document total 120 s, walk total
   10 min.
3. **`notMeasured`.** Objects everywhere (a breaking shape change for listings).
4. **Unknown keys.** Named by position with a "did you mean", never quoted. Query parameter
   names included.
5. **Pause during discovery.** Throws the walk away; the resume re-reads the sitemaps.
6. **Dev DB.** Delete loopback/fixture-host crawls only; keep every real-site crawl.

## Owner calls still open from 27a (triage values, `src/rules/registry/triage.ts`)

These are one line each. My recommendation is in brackets.

- `url.internal-search` and `url.parameter-pages-indexable` are warning/**high** where Screaming
  Frog says low. Ours list only the indexable cases, which are real index bloat. [keep high]
- `pagination.non-indexable-target`, `social.og-incomplete` and `social.x-incomplete` take the
  milder SF issue where the scopes differ. [keep]
- `schema.self-serving-reviews` is warning/**low**; the rubric could say medium. The cost is a
  lost rich result, not a penalty. [keep low]
- `performance.slow-response` has no SF mapping, though "PageSpeed: Document Request Latency" is
  its counterpart. [add the mapping; it changes no finding]

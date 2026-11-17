# Phase 29b gate: render-pass checks

Date: 2026-11-17. Spec: `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md`
(§29b and "Gates" 29b, clauses 1 to 3). Plan:
`docs/superpowers/plans/2026-11-17-phase-29b-render-checks.md` (Tasks 1–9). Branch
`worktree-phase-29b`, built on `4d31aee` (main after PR #32).

**Benchmark.** Web standards only. JavaScript errors and failed requests are what Chromium
reports. Image size is the file's own header against the box the browser lays it out in.
Accessibility is axe-core 4.14.0 run on a fixed subset of deterministic WCAG 2.2 A and AA rules.
The engine reports facts; the agent judges.

Code under test: `2c1f0a7`. That is Tasks 1–9, the final-review fix wave (`20d705d`, `ec03c6b`,
`82eab68`), the owner-directed PNG eXIf fix (`c99c81b`) and the memory diagnosis (`81d008a`,
`2c1f0a7`, §3.2).

**Verdict.**

- **Clause 1 passes.**
- **Clause 3 passes** for the three servers the clause names.
- **Clause 2 passes the 512 MB contract.** It exceeds the 290.2 MB local bound by 1.6 MB
  (291.8 MB). That excess waits for the owner's ruling (§3.3).

The full suite on `2c1f0a7` is 191 files and 5,154 tests, all green, and `npx tsc --noEmit` is
clean.

All gate runs used a database made for them, `ariadne_gate29b`, on the dev container
(`create database ariadne_gate29b`, then `npm run db:migrate`: 59 migrations). The gate never
connected to the dev database `ariadne`. `ariadne_gate29b` is kept until the owner's OK to drop
it.

## 1. Clause 1: the fixture site

`test/fixtures/pages/authored-p29b.ts` carries 32 pages, every one `exact: true`:

- **three console pages:**
  - a thrown exception (`render.js-exception`);
  - a `console.error` (`render.console-error`);
  - a failing same-origin script (`render.failed-request`);
- **five image pages:**
  - a PNG served at 4× its displayed size;
  - one at 1×;
  - a `srcset` image with `w` descriptors;
  - a CDN-host image;
  - a lazy image 5,000 px below the fold;
- **one page per accessibility rule:** 24 pages, one for each rule in the subset (§4).

`test/fixtures/harness.test.ts` ("the Phase 29b render checks on the fixture crawl") pins:

- **Rendering.** Every `/p29b/` page rendered at capture version 3, with its accessibility run
  `ran`.
- **Console rules.** Each fires on exactly its own page, with the browser's own wording.
- **Image rule.** `images.larger-than-displayed` fires on the 4× page (400% against the 200%
  default). It fires on the CDN page too, whose image is also wider than its box. It does not
  fire on the 1× page, the `srcset` page or the lazy page. The lazy image is counted as
  `lazyUnloaded`; it is never requested and never judged.
- **Accessibility rules.** Each accessibility page carries exactly one violation of its own rule,
  read from `render_a11y` (one row, one node). The console and image pages carry none.

**Measured-image share.** Over the five image pages it is **1.0**: 4 measured, 0 left without
dimensions, 0 broken, and the lazy image outside the denominator. The metric
`render.image-measurement` for the `/p29b/:slug` template reads **0.571** (4 / 7). That is
because the template also holds the three console pages, and each of them carries the shared SVG.
An SVG has no stored pixel size, so it counts as requested and unmeasured.

## 2. Clause 3: no more requests than before

The fixture harness compares the asset servers' request logs from the resource pass and from the
render pass:

- **Resource pass.** Each image file got exactly one Range GET.
- **Render pass.** It sent nothing to the site's asset server or to the CDN.
  - Measured images were answered with a stand-in built from the stored size.
  - The lazy image was never requested.
  - The unused 1600w `srcset` rendition was requested by nobody.

`test/crawl/fetch-resources.test.ts` ("request parity with the HEAD path (gate clause 3)") covers
the three servers the clause names:

| server | 29b requests | HEAD path before |
|---|---|---|
| honours Range | 1 | 1 |
| ignores Range | 1 | 1 |
| answers HEAD with no size | 1 | 2 |
| answers `bytes */*`, or 416 | 2 (the documented ceiling) | 1 |

The last row is outside the clause. It is the one-plain-GET retry for a server that cannot answer
the range. The test records it as the ceiling.

## 3. Clause 2: the 50k gate

`scripts/gate-rules.ts` runs crawl, render and rules over the 50,000-page fixture in one process.
The render pass selects 7 pages at concurrency 4. The fixture site serves its images as 404 on
purpose, and **0 404s** were served during every render phase. That shows the renderer's aborts
never reach the server.

### 3.1 Runs

| run | head | crawl | peaks (crawl / render / rules) | render | axe median / p95 | rules wall | findings | result |
|---|---|---|---|---|---|---|---|---|
| 1 | `c99c81b` | `crawl_d1781699-…` | 295.2 / 296.3 / 294.5 | 10.1 s | 308 / 377 ms | 446.0 s | 155,249 | passed |
| 2 | `c99c81b` | `crawl_23dc526a-…` | 280.1 / **298.1** / 298.1 | 11.2 s | 303 / 374 ms | 400.3 s | 155,249 | passed |
| 3, diagnostic | `81d008a` | `crawl_372a4b25-…` | 283.9 / 285.1 / 286.2 | 9.6 s | axe off | 418.1 s | — | not the gate |
| **4** | **`2c1f0a7`** | `crawl_0a87e287-…` | 282.6 / **291.8** / 291.8 | 9.7 s | 258 / 388 ms | 415.5 s | 155,249 | **GATE PASSED** |

All peaks are process RSS in MB. Browser RSS is about 1.14 GB across Chromium's processes. It is
not gated, as today.

- **Run 1** ran while a review agent was driving Chromium tests on the same machine. Its crawl
  peak of 295.2 MB is noise: run 2's crawl peak was back inside 29a's range of 276–284 MB.
- **Run 3** used `--no-accessibility` (§3.2). It prints `DIAGNOSTIC RUN` and can never print
  GATE PASSED.

The findings count is 400 below 29a's first build, as recorded in `phase-29a.md`. It is
unchanged from the 29a rework. The new 29b rules fire nothing on the 50k site:

- it has no console errors;
- its images are 404, so they are never sized;
- its 7 rendered pages carry no subset violation.

The logs and JSON are in `.superpowers/sdd/2026-11-17-phase-29b-render-checks/gate/`. That
directory is local scratch and is not committed.

### 3.2 The render phase's growth, diagnosed

Run 2 showed the render phase adding **+18.0 MB** over the crawl peak. In 29a the render phase
added at most +1.5 MB. The owner chose "diagnose first".

- **Attribution.** With axe off (run 3), the render phase grows **+1.2 MB**. So axe accounts for
  the rest.
- **Not axe's run.** A focused instrument isolated the cost. It rendered 40 pages at
  concurrency 4, with three repeats per mode. Sending axe's source without running it
  reproduced the whole cost. Running axe added nothing measurable.
- **The mechanism.**
  - axe-core 4.14.0 contains 14 characters outside Latin-1, so V8 holds its 652,119-character
    source as a two-byte string of about 1.3 MB.
  - The run expression was rebuilt for every page as a lazy concatenation. Playwright's pipe
    transport `JSON.stringify`s each CDP message, so every send first flattened that string into
    a fresh copy and then wrote the JSON text.
  - The total was about 2.5 MB of large-object garbage per page. A sampling heap profile put
    101.5 MB of a 106 MB difference at that one call site.
  - Everything returns to baseline after GC. It is O(concurrency), not O(URLs).
- **The fix (`2c1f0a7`).** The production expression is built once per process. That halves the
  per-send allocation to about 1.3 MB. A test asserts the allocation through the heap profiler,
  and it fails at 2.66 MB per call with the memo reverted.
- **Result.** Render-phase growth fell to **+9.2 MB** (run 4).
- **What remains.** One JSON text per page remains. Every render opens a fresh page, and no CDP
  script registration outlives a page: `Page.addScriptToEvaluateOnNewDocument` is per target,
  and a persisted `Runtime.compileScript` is per execution context. Playwright's
  `addInitScript` sends per page too, and in the main world.
- **Measured and rejected.**
  - Escaping the source to one byte before sending gained at most about 2 MB, which is within
    noise. It would also rewrite the pinned MPL text in transit.
  - Reusing pages across renders is an isolation redesign, out of scope.

### 3.3 Clause 2 against the bound

- **The contract.** The final peak, **291.8 MB**, passes the 512 MB contract with more than
  220 MB of headroom.
- **The local bound.** It exceeds the 290.2 MB local bound (27d, 28c, 29a) by **1.6 MB**.
- **What the excess is.** It is the per-page axe crossing, bounded by concurrency.
- **The caveat.** Run 4 is a single sample, and 29a's render phase alone ranged from 226 to
  283 MB across three runs.

**Owner ruling:** _pending. The choice is to re-baseline the local bound for the render pass with
accessibility, or to ask for one of the options in §3.2._

### 3.4 Per-page axe time

The median is **258–308 ms** and the p95 **374–388 ms** across the three gate runs, each over 7
renders. The lease carries `RENDER_AXE_ALLOWANCE_MS` (35 s) as its recovery timeout. The run
itself costs the times above.

## 4. The accessibility subset

There are 24 axe rules, listed in CHECK-89. Each one is deterministic: no `reviewOnFail`, and
enabled by default in the pinned axe. A test reads `axe._audit.rules` from the installed package
to enforce this.

`duplicate-id-aria` was in the design's list and was **dropped**:

- axe 4.14.0 marks it `reviewOnFail`, so a real failure comes back as `incomplete` and never as a
  violation;
- the rule could never fire, which hard rule 1 forbids;
- WCAG 2.2 removed SC 4.1.1, the criterion it tests.

## 5. What did not go as first written

- **206 is success.** The resource pass asks images with a Range GET, so a 206 is the success
  answer. `social.image-broken` and the other status comparisons treated only 200 as success.
  Fixed in Task 2.
- **Isolated world.** The `srcset` lookup, the image measurement and axe run in an isolated
  world, never the page's main world. A hostile page could otherwise stop the pass or feed it
  false answers. The renderer filters our own world's console and exceptions out of the site's
  evidence. It snapshots that evidence before axe runs.
- **CORS stand-ins.** An image with `crossorigin` broke on the first stand-ins. They now echo
  the request's Origin. A served image whose `naturalWidth` is 0 counts as `broken`, never as
  measured.
- **Orientation.** The image reader reports the displayed size:
  - JPEG EXIF orientation 5–8 swaps width and height;
  - AVIF `irot` 1 and 3 swap them;
  - a PNG `eXIf` chunk before IDAT swaps them (verified against Chromium; owner ruling, "Fix in
    29b");
  - WebP EXIF is not applied, because Chromium does not apply it.
- **Silent image family.** With `fetchResources: false`, or on a re-render of a crawl from
  before 29b, the image rule could not fire and nothing said so. `render.not-recorded` now names
  `images` in both cases.
- **Memory.** See §3.2.

## 6. PNG headers past 64 KiB

The resource pass reads the first 64 KiB. A PNG walk that reaches 64 KiB before IDAT without
having read an `eXIf` chunk records `header-beyond-limit`, never a guessed size.

A reviewer's local scan found:

- **0.08%** of 38,000 PNGs, and **0.5%** of a web-logo sample, carry more than 64 KiB before
  IDAT;
- the cause is Fireworks private chunks and C2PA `caBX` provenance, not ICC or XMP;
- **21%** of web logos carry `eXIf` before IDAT, which is why the orientation fix matters.

A lossless fix would be a chunk-hop Range GET, left for a later phase.

## 7. Owner rulings this phase

- Gate database `ariadne_gate29b`: "Yes, create and run".
- PNG eXIf orientation: "Fix in 29b".
- Gate memory: "Diagnose first". Diagnosed and halved (§3.2); the local bound is still pending
  (§3.3).

## 8. Open items

- **The local memory bound** (§3.3). It awaits the owner.
- **Square PNG past 64 KiB.** Its IHDR size is right whichever way it is rotated, so it could be
  reported losslessly instead of `header-beyond-limit`. Cheap.
- **Chunk-hop Range GET** for PNGs with more than 64 KiB before IDAT (§6).
- **Pre-existing, not 29b:**
  - **Measurement script in the main world.** The render pass's older `MEASURE_SCRIPT` runs in
    the page's main world, so a page that overrides `Array.prototype.push` can stop the pass.
  - **No cross-phase deadline.** A page that hangs has none.
- **Allocation churn.** `simhash64`, through `analyzeHtml`, allocates about 11.5 MB of garbage
  per analysed page. That shows in the render path and probably in the crawl. Nothing is
  retained, but it is the largest churn the profile showed.
- **`ariadne_gate29b` is kept** until the owner's OK to drop it.

# Phase 29d gate: the Phase 29 backlog

Date: 2026-11-25. Spec: `docs/superpowers/specs/2026-11-24-phase-29d-backlog-design.md`
("Gate 29d", five clauses). Plan: `docs/superpowers/plans/2026-11-24-phase-29d-backlog.md`
(Tasks 1–13, rulings R1–R8). Branch `worktree-phase-29d`, built on `12e832e` (main after
PR #35). The owner added Tasks 14–16 during the gate (§6).

**Benchmark.** Web standards only, as in 29a–29c. The engine reports facts and the agent
judges. PDFs are indexable unless their HTTP headers say otherwise (owner ruling, §7).

Code under test: `63a4312`. That covers Tasks 1–12, the final-review fix wave, Task 14 (PDFs in
the link-graph rules and site.health), Task 15 (verified Bing presets) and Task 16 (a
configured heap cap) with its fix round. The 50k runs in §3 used `676f8e2` and `45ede94`.
Nothing between those commits and `63a4312` touches the crawl, the rules or the derivations.
Task 16 changed only launchers, boot checks, gate scripts, docs and tests.

**Verdict: all five clauses pass.** One clause has an owner note: link derive passes its
60 s limit but misses the spec's 40 s target (§3.2).

On `63a4312` the full suite is 211 files and 5,500 tests, all green. `npx tsc --noEmit` is
clean. After the run, `ps` finds no node process running `src/worker/serve.ts` or
`src/api/serve.ts`. The suite's own guard false-flags a shell whose command line mentions the
path (§8).

All gate runs used a database made for them, `ariadne_gate29d`, on the dev container
(`create database ariadne_gate29d`, then `npm run db:migrate`: 62 migrations, 0000–0061). The
gate never connected to the dev database `ariadne`. `ariadne_gate29d` is dropped after the
merge (owner OK, §7).

## 1. Clause 1: suite and types

- **The suite and `tsc` are clean** on `63a4312`: 211 files and 5,500 tests.
- **No process is left behind.** Task 11's vitest `globalSetup` reaper
  (`test/setup/child-reaper.ts`) records each test-spawned child and kills any still alive at
  teardown. `assertNoStrayServe` fails the run if a `serve.ts` process outlives it.
- **`ps` after the run** finds no node process running `serve.ts`, so the 29a "leaked test
  workers" item is closed.

## 2. Clause 2: each goal has fixtures

The task tests are the evidence. Every fixture the spec names, by test title:

| Spec fixture | Test |
|---|---|
| Pagination pages typed `:id` beside slug posts, with no template finding | `test/crawl/page-templates.test.ts` "pagination keeps :id beside a slug type" |
| A block whose 60th reference is the only unresolved one gets a finding | `test/rules/schema-validation-query.test.ts` "29d: files a page whose only unresolved reference is the 60th"; `test/api/structured-data.test.ts` "counts the 60th reference and the 70 unresolved ones exactly; problemsCapped only past 50" |
| Microdata and RDFa with two types | `test/crawl/microdata.test.ts` "keeps every itemtype token"; `test/crawl/rdfa-types.test.ts` "two schema: tokens give both, schema_type is the first" |
| 60 blocks, 10 dropped | `test/api/structured-data.test.ts` "an extraction-5 page with 60 blocks lists blocksDropped 10 and nodesDropped 0; blocksAtCap follows blocksDropped" |
| A JSON-LD graph 7 deep | `test/crawl/analyzer-extensions.test.ts` "counts nodes past the depth cap" (5 nodes at depths 6 and 7 dropped and counted) |
| A PDF declaring hreflang with a missing return link | `test/rules/hreflang-pdf-query.test.ts` "a PDF that declares an alternate with no return link gets missing-return-link" |
| A robots.txt with a `Googlebot` group and a `*` group, crawled with each preset | `test/crawl/discovery.test.ts` "the googlebot-desktop preset is judged by the Googlebot group, read through the token" and "the default identity is judged by the * group"; `test/crawl/user-agents.test.ts` "each preset resolves to its strings and token" |
| A custom `Mozilla/` user-agent (400) | `test/api/user-agent-config.test.ts` "refuses a preset with a userAgent, and a Mozilla/ agent with no token, as a 400-class refusal"; `test/schedule/scheduler.test.ts` "a Mozilla/ userAgent with no token is refused: skipped identity_refused naming the field, the refusal logged, no crawl" |
| A square PNG past 64 KiB | `test/crawl/image-size.test.ts` "a square PNG past 64 KiB reports its IHDR size" |
| A 40×20 PNG with 100 KiB before IDAT, served with ranges | `test/crawl/fetch-resources.test.ts` "a 40x20 PNG with 100 KiB of chunks before IDAT is sized by one continuation, through the gate" |
| A JPEG with 100 KiB of APP segments | `test/crawl/fetch-resources.test.ts` "a JPEG with 100 KiB of APP segments is sized with two requests" |
| A page that overrides `Array.from` and `Array.prototype.filter` | `test/crawl/renderer.test.ts` "a page that overrides Array.from and Array.prototype.filter is measured" |
| A page that never finishes its scripts | `test/crawl/renderer.test.ts` "a page that never yields is stopped at the deadline" and "a pass carries on past a page that never yields, and completes (deadline)" |

## 3. Clause 3: the 50k gate

`scripts/gate-rules.ts` crawls, renders and judges the 50,000-page gate site in one process.

### 3.1 The runs, including the ones that do not count

| Run | Head | Command | Crawl | Peak RSS (crawl / render / rules) | Link derive | Click depth | Result |
|---|---|---|---|---|---|---|---|
| 1 | `676f8e2` | `npx tsx …`, **no heap flag** | `crawl_5487a14a-…` | 562.4 / 563.5 / 538.1 MB | 54.0 s | 13.8 s | over 512 MB; procedure error |
| main control | `12e832e` | `npx tsx …`, **no heap flag** | `crawl_622de3d8-…` | 372.4 / — / 520.4 MB | 60.6 s | 17.1 s | over 512 MB; procedure error |
| 3 | `676f8e2` | `npx tsx …`, no heap flag, heap sampler | — | 523.9 MB | 57.7 s | 14.2 s | diagnostic |
| 4 | `676f8e2` | `NODE_OPTIONS=--max-old-space-size=256` | — | 274.1 / 279.4 / 278.4 MB | 59.3 s | 17.1 s | diagnostic, passed |
| **5** | **`676f8e2`** | **`node --max-old-space-size=512 --import tsx …`** (procedure of record) | `crawl_6920d464-47f5-407d-9255-a027633fac06` | **282.9 / 293.3 / 293.3 MB** | **58.0 s** | **18.4 s** | **GATE PASSED** |
| **6** | **`45ede94`** | **`ARIADNE_HEAP_MB=384 node --max-old-space-size=384 --import tsx …`** (the shipped cap, §3.3) | `crawl_99ae13f4-47f7-4521-8f59-67e2f39d6ce2` | **292.8 / 292.9 / 289.1 MB** | **54.9 s** | **18.8 s** | **GATE PASSED** |

Runs 1 and 3 and the main control were launched with `npx tsx scripts/gate-rules.ts` and **no**
`--max-old-space-size`. That is not the gate procedure. Every gate record and
`.github/workflows/gate.yml` run it under the flag. These runs do not count, and they were
first misread as "main fails today too". They are kept here because they found something real
(§3.3).

Runs 5 and 6 found 155,249 findings and 48 metric rows at 83.6–84.0 pages/s. Of the time
limits, only the click-depth (30 s) and link-derive (60 s) limits are gated.

- **Peak within the 306.4 MB local bound and the 512 MB contract: passes.** 293.3 MB (run 5)
  and 292.9 MB (run 6).
- **Click depth ≤ 30 s: passes.** 18.4 s and 18.8 s, against 46.0 s in the 29c gate.
  Task 10's per-level `cd_frontier` table (R6) made the gain. The partial index it measured
  first gave 24.0 s.
- **Link derive ≤ 60 s: passes.** 58.0 s and 54.9 s (`deriveLinkCounts` 30.4 s and 29.9 s, plus
  `deriveLinkScore` 27.7 s and 25.0 s). See §3.2.

### 3.2 Link derive: passes, misses the target

The spec set a 40 s target. As built it says the 40 s target "is likely unmet" and that the
60 s clause "is an owner decision at the gate". It is unmet. The first judgement of a 50k crawl
takes 54.9–59.3 s across the four branch runs, against 51.7 s in the 29c gate.

Task 10 measured a shared resolved-target table (option C, 88–89 s) and a persisted
`links.target_page_id` (about 70 s for the UPDATE alone). Neither beat the shipped joins, so
`deriveLinkTargets` did not ship (spec goal 9 note). Most of the cost is `deriveLinkCounts`.

When the same crawl is re-judged, link derive takes 27–28 s (§4). Rows that are already right
are not rewritten, so most of the first-run cost is writing `pages`, not the joins.

The owner has asked whether the slow link work could move to a post-process step. That is the
recommended next phase (§8).

### 3.3 Memory without a heap cap

Runs 1 and 3 found that an **uncapped** process peaks at 524–563 MB, yet its live heap is
bounded. Run 3 sampled `process.memoryUsage()` every second. The heap floor after each major GC
stays flat at 75–108 MB through the whole crawl, so nothing grows with the URL count (hard
rule 6 holds). Between major GCs `heapUsed` swings to 350–380 MB. V8's default old-space limit
on this machine is 4,144 MB, and at the branch's allocation rate (about 84 pages/s) V8 lets
garbage build up before collecting. Under a 256 MB cap (run 4) the same run peaks at 279.4 MB,
with a heap maximum of 134.8 MB and identical findings and throughput.

Every recorded gate ran under `--max-old-space-size=512`, but **production did not**: the
Dockerfile, `docker-entrypoint.sh` and the npm serve scripts all started `node` with V8's
default. So the 512 MB contract had only been shown under a cap production did not use. The
owner chose a configured cap ("Let's do option A"), built as Task 16:

- `ARIADNE_HEAP_MB` is V8's old-space cap in MB, a required setting. The image sets
  `ENV ARIADNE_HEAP_MB=384`.
- The entrypoint and npm scripts start `node --max-old-space-size="$ARIADNE_HEAP_MB"`.
- The API, the worker, the stdio MCP server and the gate scripts refuse to start unless V8's
  `heap_size_limit` matches the configured cap. On Node 22.23.2 x64 that limit is the cap plus
  48 MB of young generation.
- `gate.yml` runs the 50k gate under the same 384 MB cap, so the gate measures what ships.
- Run 6 is that configuration, at 292.9 MB.

## 4. R7: derived values identical to a pre-change run

On crawl `crawl_99ae13f4-…` (first judged by run 6), in order:

1. The rules at `12e832e`, from a `git archive` tree, under main's gate procedure (512 cap,
   `GATE_CRAWL_ID`).
2. `scripts/gate-derived.ts --export`: 50,000 rows.
3. The rules at `63a4312` (384 cap).
4. Export again: 50,000 rows.
5. `--compare`:

```
compared 50,000 rows (a) with 50,000 rows (b)
derived values identical (integers exact, linkScoreRaw within 1e-9 relative)
```

**Passes.** Click depth, internal inlinks, internal and external outlinks, and both link score
columns agree on every page. Both rule runs found 155,249 findings. The fixture site serves no
PDF, so Task 14's widening of the link-graph rules to PDFs does not show here; its tests do
(`test/rules/pdf-link-graph.test.ts`). The crawl ends judged at ruleset 0.29.0.

Re-run timings are not gated: `isGate` is false when `GATE_CRAWL_ID` reuses a crawl. They were
link derive 28.1 s (main) and 27.3 s (head), and click depth 67.5 s (main) and 30.0 s (head).
Click depth at 30.0 s on the crawl's third judgement, against 18.4–18.8 s on a first one,
suggests it depends on table state (§8).

## 5. Clauses 4 and 5

### 5.1 Clause 4: `simhash64` allocates at least 5× less

The spec's ≥ 5× is pinned by `test/crawl/simhash.test.ts` "allocates at least 5x less than the
oracle". Measured with the test's own method:

- **Setup:** a 2,000-word text, 50 calls, and the sampling heap profiler with objects
  collected by minor and major GC included.
- **Result:** the pre-29d oracle allocates 11,870–11,886 KiB per call; the new `simhash64`
  allocates 93.2–94.4 KiB.
- **That is 125.8×, 127.4× and 127.3× less over three trials. Passes.**

This is V8-heap allocation. Typed-array backing stores sit outside it. The result matches 29b's
"about 11.5 MB of garbage per analysed page".

### 5.2 Clause 5: the real site

The spec named lavishalice.com, but 29a §2.2–2.5 shows the 16 pagination pages were on
**simpleerb.com**. The owner approved crawling simpleerb.com instead ("Yes").

`crawl_b3cf0a1f-7e3b-426a-b90c-ad19c15fce9c` was crawled at `676f8e2` through the API and a
worker, on the gate database:

- **Settings:** the AriadneBot UA, `maxPages` 1,000, default politeness (robots.txt, 1 s per
  host, no 429s) and `fetchResources: false`.
- **Result:** 762 pages, 0 failed, 3 robots-blocked. The rules at 0.29.0 found 3,525 findings
  (29a: 3,490 on 753 pages).

- **`schema.template-inconsistent`: 0 (29a: 16). Passes.** All 16 `/blog/<n>/` pages
  (`/blog/10/` …) were crawled. They are typed `/blog/:id` and no longer grouped with the
  `/blog/:slug` posts (Task 1).
- **Every other rule's count, explained.** The 29a database was dropped, so the like-for-like
  comparison runs main's rules and the branch's rules on **this** crawl. Main (`12e832e`)
  finds 3,523; the head finds 3,525. **The only per-rule difference is
  `pages.not-in-sitemap`, 47 → 49.** The two extra findings are the site's only PDFs,
  `/assets/terms/simpleERB_privacy_policy.pdf` and `/assets/terms/Terms_SimpleERB.pdf`. Both
  are 200, indexable and absent from the sitemap, which is Task 5a's ruling. Page typing and
  extraction 5 are stored at crawl time, so both rule runs share them. Against 29a's
  documented counts, `schema.empty-value` 187 → 189 and `schema.parse-error` 24 → 25 follow the
  site's 9 extra pages. `schema.unresolved-reference` stays 0.

## 6. What changed from the plan

- **Task 14 (owner, 2026-11-25): "Let's include pdfs in health checks, orphan, deep".** PDFs
  join `site.health` (with a new `urlsPdf` overlap column, "Of Which PDFs"), `links.orphan` and
  `structure.deep-page`. `links.only-from-non-indexable` and `links.anchors-generic-only` stay
  HTML-only.
- **Task 15 (owner, Bing's crawler page).** `bingbot` is replaced by `bingbot-desktop`
  (Bing's evergreen string) and `bingbot-mobile` (its Android string), both on
  `PRESET_CHROME_VERSION`. The short legacy string is not offered.
- **Task 16 (owner, "Let's do option A").** The heap cap of §3.3. Its review added the
  `ARIADNE_HEAP_MB` lines to the Talos-facing docs and the crawl skill, and an entrypoint
  success-path test.
- **R7's crawl.** The comparison used run 6's crawl, re-judged twice, rather than a separate
  crawl. No migration separates `12e832e` from the head, so this is as the plan allows.
- **Task 10.** `deriveLinkTargets` did not ship (§3.2); the click-depth frontier did.

## 7. Owner rulings this phase

- Plan: "Yesz go ahead".
- PDF indexability: "Pdf should be reported indexable unless http headers specify otherwise".
- Gate database and crawl: "Good to run the crawl and create the gate database".
- PDFs in the link rules: "Let's include pdfs in health checks, orphan, deep".
- Real site: simpleerb.com instead of lavishalice.com, "Yes".
- Heap cap: "Let's do option A".
- Gate close-out, 2026-11-26: "Yes to all points". That is: push the branch and open the PR
  for review; accept 60 s as the 29d link-derive bar, with the link work moved to a
  post-process step as the next phase; move the CI crawl-phase warning to 306.4 MB in this PR;
  drop `ariadne_gate29d` after the merge.

## 8. Open items

- **Link derive target (40 s) unmet; the owner accepted 60 s as the 29d bar (§7).** It took
  54.9–59.3 s on a first judgement at 50k; the limit is 60 s. The next phase moves the link
  work to a post-process step. On a re-judged crawl it took 27–28 s, so the first-run cost is mostly
  writing `pages`.
- **Click-depth time depends on table state.** It took 18.4–18.8 s on a first judgement and
  30.0 s on a third judgement of the same crawl. The `cd_frontier` temp tables are never
  `ANALYZE`d (Task 10 minor).
- **Done in this PR: CI's crawl-phase warning bound moved from 290.2 to 306.4 MB** (§7).
  `gate.yml` had warned above 27d's 290.2 MB; the owner re-baselined the local bound to
  306.4 MB in 29b, and run 6's crawl phase peaked at 292.8 MB. `scripts/gate-worker.ts`
  (the 28b worker gate, not run in CI) still fails above its own 290.2 MB.
- **`schema.unresolved-reference` loads each selected page's full id lists** in one result
  (up to 50 × 256 KiB per page). Keyset paging in `perPageFindings` is the follow-up.
- **Render discard path:** bound `context.close()` and relaunch on a timeout.
- **The fixture site serves no PDF**, so the 50k gate does not exercise Task 14's PDF link
  rules. Their tests do.
- **The stray-serve guard matches any command line containing `src/worker/serve.ts`.** It
  includes the shell that started the suite. Twice this phase it failed an otherwise green
  `npm test` (5,500 of 5,500 tests passed) because the invoking command mentioned the path.
  `ps` found no real serve process. Matching only `node` processes that run the file would fix
  it.
- **Small, parked:**
  - Task 14 N1–N3 are cosmetic.
  - The `0` placeholder for the parsed cap in `gate-workers.ts`/`gate-schedules.ts` cannot
    be reached before `main()`, and a child would still fail its own assertion loudly.
  - `entrypoint.test.ts` repeats the literal `384`.
- **Still open from 29a:** the greenpeople.co.uk re-crawl with a Shopify crawler signature, and
  validator.schema.org on the last three sample pages.
- **`ariadne_gate29d` is dropped after the merge** (owner OK, §7).

# Phase 29c gate: crawl analysis

Date: 2026-11-18. Spec: `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md`
(§29c and "Gates" 29c, four clauses). Plan:
`docs/superpowers/plans/2026-11-18-phase-29c-crawl-analysis.md` (Tasks 1–10, rulings R1–R12,
and the owner amendments of 2026-11-18). Branch `worktree-phase-29c`, built on `afddb44` (main
after PR #33).

**Benchmark.** Web standards only. Link counts and the link score are facts about the crawl's
own link graph. The link score is the share of internal link weight a page holds
(random-surfer model, damping 0.85), scaled 0 to 100. The diff reports what changed between two
crawls of one site. No rule judges a low score, and the diff claims no checklist id. The engine
reports facts; the agent judges.

Code under test: `88f94cd`. That is Tasks 1–9, the final-review fix wave (`9d229c1` to
`b036628`) and the owner amendments (`6e47c61`, `88f94cd`, §5).

**Verdict: all four clauses pass.**

The full suite on `88f94cd` is 199 files and 5,289 tests, all green, and `npx tsc --noEmit` is
clean.

All gate runs used a database made for them, `ariadne_gate29c`, on the dev container
(`create database ariadne_gate29c`, then `npm run db:migrate`: 61 migrations, 0000–0060). The
gate never connected to the dev database `ariadne`. `ariadne_gate29c` is kept until the owner's
OK to drop it.

## 1. Clause 1: the derive step at 50k, and memory

`scripts/gate-rules.ts` crawls, renders and judges the 50,000-page gate site in one process,
`GATE_PORT=45791` (the same port as run 2, so the two crawls share one origin and can be
diffed).

| Run | Crawl | Pages | `deriveLinkCounts` | `deriveLinkScore` | Link derive | Peak RSS |
|---|---|---|---|---|---|---|
| 1, plain (the gate) | `crawl_afad6d4d-76c2-43dc-a468-0caf8c7b83cf` | 50,000 | 24.6 s | 27.1 s | **51.7 s** | **300.3 MB** |
| 2, planted (`GATE_PLANT=1`, not the gate) | `crawl_acbce4a0-f681-4e2e-8f78-165fbb82128c` | 49,975 | 28.8 s | 29.3 s | 58.1 s | 292.7 MB |

- **Link derive ≤ 60 s: passes** at 51.7 s. The planted run, which is not the gate, took 58.1 s.
  **The margin is thin** (2–8 s); see §6.
- **Memory: passes.** Run 1 peaked at 300.3 MB (crawl 294.6, render 300.3, rules 300.3), under
  the 306.4 MB local bound set in 29b and the 512 MB contract. `GATE PASSED` printed.
- Run 1: 1,149,940 link rows; 155,249 findings, 48 metric rows; rules wall time 474.8 s, of which
  derivations 108.7 s (`deriveClickDepth` 46.0 s, the two link derivations 51.7 s).
- Every one of the 50,000 pages has a link score, and the raw scores sum to 1.0000000000000058.
- **Convergence at 50k.** Re-deriving the link score on both gate crawls afterwards (idempotent:
  the guarded write changed nothing) reports run 1: 50,000 nodes, 1,149,917 edges, 0 pages with
  no edges out, **converged after 10 iterations**; run 2: 49,925 nodes, 1,146,692 edges,
  converged after 11. The 20-iteration cap was not reached.

## 2. Clause 2: the link score matches hand-computed values

`test/rules/derive-link-score.test.ts` builds a five-page graph with six kept edges and six
noise links the filter must drop (a duplicate, a self-link, a link to a 404, a nofollow link,
an external link, a link to a redirect). Its expected raw scores are the exact solution of the
linear system (A 79080/241193, B 35713/241193, C 77380/241193, D 35713/241193,
E 13307/241193); the SQL matches each within 1e-6 after 18 iterations, the scores sum to 1
within 1e-9, and the 0–100 scores are A 100, B 55, C 99, D 55, E 0. The degenerate graphs (no
page, one page, no edges at all, two disconnected cycles) are pinned too, with no NaN or
division by zero. Green in the suite above.

## 3. Clause 3: the diff against known answers

The planted site (`GATE_PLANT=1`, R12) differs from the plain one in three index sets: 100 pages
retitled, 50 answering 410 and 25 removed (no link, no sitemap entry, 404).
`scripts/gate-diff.ts` diffs run 1 (base) against run 2 (head) and pages every asserted set to
its end through `listDiffUrls`:

| Field | Listed | Counted | Planted | |
|---|---|---|---|---|
| removed | 25 | 25 | 25 | exact |
| added | 0 | 0 | 0 | exact |
| title | 100 | 100 | 100 | exact |
| status, fetchClass, indexable | 50 each | 50 each | 50 | exact |
| metaDescription, h1, canonical, metaRobots, wordCount, schemaTypes | 0 | 0 | 0 | exact |

- `crawlDiff` answered in **2,394 ms**, the first `title` page in **293 ms** (limit 5,000 ms
  each). Common URLs 49,975.
- Recorded, not asserted: inlinks changed 0, clickDepth changed 0, linkScore changed 50 (the 410
  pages left the graph, so they are scored on one side only).
- Client RSS 224.4 MB. `GATE PASSED (29c clause 3)`.

## 4. Clause 4: a schedule pair diffs to nothing

`scripts/gate-schedules.ts` with `GATE_DB_NAME=ariadne_gate29c` (run `9b32c8`) re-ran the 28c
scheduler gate. Clause 1c now also diffs the first and the tenth fired crawl of the unchanged
20-page site: common 20, added 0, removed 0, and no field changed or not comparable. The other
28c clauses passed as before. `GATE PASSED (clauses 1 and 2)`.

## 5. What changed from the plan

- **Owner amendments (2026-11-18).** A page whose robots meta or `X-Robots-Tag` says `nofollow`
  or `none` passes no link score through its links: it stays in the graph, and its weight is
  shared evenly, as for a page with no links (R3 had left this open). And "every score equal"
  is now within a relative tolerance of 1e-9 instead of exact equality (R5), so float noise on a
  truly level graph cannot spread scores across 0–100. The task review found the first version
  of the nofollow test read the standard `max-image-preview:none` as `none`; it now strips the
  value directives first, and a SQL/JS parity test pins it against `robotsTokens`.
- **R4, the work tables.** The spec said "unlogged per-run work table, batched". The derivation
  uses `create temporary table … on commit drop` inside one transaction: never written to the
  write-ahead log, private to the session, dropped even on failure. Each iteration is a fixed
  number of set-based statements; two rank tables alternate.
- **Final-review fixes.** `links.anchors-generic-only` runs on spider crawls only;
  `crawl_overview` names `link-counts` as not measured on an unjudged crawl;
  `anchors_by_target`'s `genericShare` counts a source page only when every one of its links to
  the target is generic; each derivation writes `pages` once, skipping unchanged rows.
- **Gate tooling.** `GATE_PORT` (the plain and planted crawls must share an origin) and
  `GATE_DB_NAME` on `gate-schedules` were added; neither was in the plan.

## 6. Owner rulings this phase

- Plan: "yes go ahead".
- Equal scores: "We can do within small tolerance".
- Page-level nofollow: "Nofollow should not pass link score".
- Gate database `ariadne_gate29c`: "Go ahead".

## 7. Open items

- **Partly done in 29d (Task 10): click depth 46.0 → 18.4 s; link derive still 54.9–58.0 s,
  carried to `docs/gates/phase-29d.md` §8.** **Link-derive margin.** 51.7 s and 58.1 s against 60 s. `deriveClickDepth` (46.0 s) is the
  other large derivation. If the derive step grows, the first candidates are the per-iteration
  join of the 1.15M-row edge table and the inlink aggregate.
- **A crawl judged before ruleset 0.7.0** has no click depth; a diff against it would read every
  null depth as "unreachable" and count a change. No such crawl is kept.
- **Done in the 29c follow-ups (PR #35).** **Pre-existing, not 29c:** `SAYS_NOINDEX` / `NONE_DIRECTIVE` read `max-image-preview: none`
  (with a space) as `none`, so such a page is reported noindex. The same strip the nofollow test
  now does would fix it.
- **Done in the 29c follow-ups (PR #35).** **Diff across origins.** `crawl_diff` accepts two crawls of one site served from different
  origins (apex and www, http and https) and then joins on the exact URL, so every page would
  read as removed and added. A caveat for that case is not built.
- **`ariadne_gate29c` is kept** until the owner's OK to drop it.

# Phase 13 gate — the closures, and the stale-map hole the last one uncovered

Phase 13 had no discovery in its plan. Its scope was a list somebody else wrote:
the nine-pointer ledger in `docs/gates/phase-12.md` §10 — six chores, one
owner-promotable judgement call, and two decisions left standing. That makes it,
like Phase 12 before it, the easiest phase to describe and the easiest to do
badly: a phase that only closes debts has no natural moment where the engine
tells you something you did not ask it.

**It had one anyway, and it is the phase's real result.** Building the per-host
earned-spacing column (pointer 2) meant re-reading the spacing ratchet, and the
first cut wrote the per-host map only when the CRAWL-WIDE widest spacing moved.
A host that escalated its own spacing without ever becoming the crawl-wide widest
was therefore never written to the map; a hard kill before the crawl closed
persisted it stale-low, and a resume SEEDED that host at the stale value — so it
re-entered the site FASTER than it had earned, which is worse than the pre-0015
behaviour the column was meant to improve on. That is a hard-rule-9 defect, and
it was introduced by this phase's own T3 and caught in T3's review before it
merged (§3.1). It is fixed in the module that owns spacing, by a generation
counter that persists the map on ANY host's escalation, in its own commit.

The rest is the ledger, closed:

| phase-12 §10 | what it asked | Phase 13 |
|---|---|---|
| 1 | the all-unknown marker — the window §10.1 stated rather than closed | **closed** (T2) — `resources.all-unknown`, info, ruleset 0.10.0; the third and last marker of the family |
| 2 | a per-host earned-spacing column | **closed** (T3) — migration 0015, `crawls.host_spacing_jsonb` `{host: earnedMs}`; resume reads map → wide → config |
| 3 | a closed vocabulary for `renderPassEvidence`'s `ran`\|`none` | **closed** (T4) — `RENDER_PASS_EVIDENCE` named constant, no wire change |
| 4 | a registry flag deriving the marker lists | **closed** (T4) — `marker?: string` on `RuleMeta`; the hand-written `MARKERS` map deleted and derived |
| 5 | `robots_unreachable` rows are never retried | **STANDING — a pointer, unchanged behaviour** (§8, carried to Phase 14) |
| 6 | the crawl-row cleanup sweep | **closed** (T1) — leak fixed at source, dev DB swept to the four kept reference crawls |
| 7 | tenancy on `crawl_list` | **unchanged — owner-ruled standing** — §8 |
| 8 | the wall-time shortening designs | **not taken — owner-ruled standing** — §8 |
| 9 | the end-to-end robots-split test ledgered at §2.2 | **closed** (T1) — one case runs the real pass and asserts the served counts off that same crawl |

---

## What the gate is

**This gate is fixture-proven and made no contact with any client site.** That
was ruled before the phase started, and the reasoning is the same as Phase 12's:
nothing in Phase 13 changes what the crawler asks a site for. The third marker
reads a table; the per-host column records a number the ratchet already earned
and replays it on resume against work the site was already going to be asked
about; the vocabulary and flag are internal refactors with no wire change; the
sweep is dev-database hygiene. A phase that changes no politeness behaviour
toward a site does not earn the right to spend a site's bandwidth proving it.
Phase 11's gate crawl remains the last real-site measurement, and its four rows
are the kept crawls this document rehearses against.

Five clauses, each answered with a measurement taken for this document.

| | The plan asked | Answered |
|---|---|---|
| 1 | the leak fixed at source; two full suite runs leave zero net crawl rows; the four kept rows unchanged | §1 — 4 rows before and after each of two full runs; the second sweep recorded 3,110 → 28 → 4; the four kept rows fingerprint-identical, child counts included |
| 2 | the marker family complete; three-way exclusivity green; every window statement closed | §2 — three markers, one exclusivity test driving all three boundaries, and the §10.1 window closed in every living place it was stated |
| 3 | migration 0015 rehearsed; the kept rows' map null; the two-host resume proven; the pre-0015 fallback proven | §3 — `host_spacing_jsonb` null on all four kept rows; a per-host resume test and a mid-crawl re-persist test green; the null-map crawl-wide fallback green; the rule-9 write-cadence fix |
| 4 | the chores hold — the vocabulary grep clean, the one-edit proof, the wire-shape assertion | §4 — no bare `ran`/`none` literal outside the constant's own declaration; the marker set derived and enforced both directions; the new wire-shape assertion green |
| 5 | full suite green, tsc clean, tree clean, kept rows untouched | §5 — 1,787 / 71 twice, tsc clean, tree clean at each commit, the four kept rows byte-identical across both runs |

A gate that only records its passes teaches nothing, so this one also carries the
stale-map hole (§3.1), the honest red-first accounting against the task reports
(§6), and the pointers Phase 14 inherits (§8).

---

## 1. The leak, closed at source and measured to zero

Phase 12's gate measured the suite leaking **33 crawl rows per full run** and
ledgered the sweep as pointer 6. T1 attributed all 33 to a single file —
`test/crawl/fetch-resources.test.ts`, the one file in the suite that created
crawl rows and never deleted them (28 via `seedCrawl`, 5 via `runCrawl`) — and
fixed it at source by giving that file the house `createdCrawls` +
`afterAll` teardown every other row-creating file already had. The fix is not a
sweep of the symptom; it is the missing teardown, so the file is now born clean
and every future run stays clean.

**The residue swept, on the owner's word, in two moves.** The dev database held
3,110 crawl rows before the fix. The first sweep deleted the leaked test rows
down to 28. The controller then ruled the residual 24 (`*.example` / `localhost`
fixtures from earlier phases, before the `127.0.0.1` convention — plainly test
residue) deletable under the same delete-with-record class, and the second sweep
took **3,110 → 28 → 4**, leaving exactly the four kept `lavishalice.com`
reference crawls. `vacuum analyze` followed.

**Zero net rows, twice.** With the leak fixed, two full suite runs were taken for
this document, the crawl-row count read immediately before and after each:

| | before | after |
|---|---|---|
| full run 1 | 4 | 4 |
| full run 2 | 4 | 4 |

Rows are created and torn down within a run — a snapshot taken mid-run-2 showed
39 crawl rows in flight, all transient test rows around the kept four — and the
resting count returns to 4 every time. Zero is zero-on-green: a test that threw
mid-run could still leave a row (a pre-existing exposure `loop.test` shares, T1
review), which is why the measurement is the resting count between green runs.

### 1.1 The four kept crawls, fingerprinted

Read before the runs and unchanged after both:

| id | site | status | host_spacing_ms | host_spacing_jsonb | md5(id‖site‖status‖spacing‖map) |
|---|---|---|---|---|---|
| `crawl_02ff6f7a…` | lavishalice.com | finished | 2000 | null | `434ddb11dc3519ffec88d70c481472d8` |
| `crawl_2af4daf1…` | lavishalice.com | finished | 2000 | null | `d6d88622c1fe81c45799490613f3a4a9` |
| `crawl_3f3ab847…` | lavishalice.com | finished | 2000 | null | `e3b9a53c416fa525dfac0184eaf9a95b` |
| `crawl_f0fc5096…` | lavishalice.com | finished | 2000 | null | `ec286abc42a3938acd7dcd72e9b88e8b` |

Child-row counts, likewise stable:

| id | pages | links | issues | metrics | resources | page_resources |
|---|---|---|---|---|---|---|
| `02ff6f7a` | 551 | 35,145 | 17,659 | 85 | 0 | 0 |
| `2af4daf1` | 551 | 35,145 | 1,314 | 855 | 0 | 0 |
| `3f3ab847` | 551 | 35,145 | 1,326 | 1,023 | 0 | 0 |
| `f0fc5096` | 557 | 34,780 | 13,617 | 98 | 1,997 | 38,737 |

---

## 2. The marker family, complete

`resources.all-unknown` is the third and last resource-coverage marker. It fires
on a crawl where `seen > 0` and every resource row landed in a DECIDED UNKNOWN
class — `refused`, `robots_denied`, `robots_unreachable`, `fetch_error` — so no
row is `ok`, the four judging rules write nothing, and the `unknownResources`
counts that would explain the silence live on findings that do not exist. Its
evidence carries a per-class `census` and the `dominantClass`. It refines the
brief's shorthand (`decided == seen && ok == 0`): it also excludes `broken`
(4xx/5xx) rows, because those are `resources.broken`'s to speak to, and a crawl
of unknown-plus-broken correctly stays silent here rather than double-reporting.

**Three-way exclusivity, one test.** The three markers partition by construction
— `resources.not-recorded` (`seen == 0`), `resources.not-fetched` (every row
unfetched), `resources.all-unknown` (every row a decided unknown) — so no crawl
carries more than one. Pinned:
`test/rules/resources-query.test.ts:1057` "one test, all three boundaries: each
marker fires on its own and nowhere else", and its silence boundary
`test/rules/resources-query.test.ts:994` "is silent when a file answered 4xx/5xx
— resources.broken speaks, so the silence is not all-unknown".

**The §10.1 window, closed everywhere it was stated.** Phase 12 stated the
all-unknown window open in the rule docblock, `talos-surface.md` §5.3, and five
checklist entries; T2 closed all of them. A grep for the open form of the
statement ("no marker fires") over the living tree — `src/`, the checklist,
`talos-surface.md` — returns nothing. `docs/gates/phase-12.md` §10.1 still reads
"no marker fires": that is the frozen historical record, correct about its own
tree, and this cross-reference — not an edit — reconciles it. As of Phase 13 that
window is closed.

The ruleset moved to **0.10.0** for the marker (the one verdict-changing edit of
the phase; T1, T3, T4 add none). Coverage holds at 94 rules / 54 query, the 47
crawl-derived checks accounting 44 claimed / 3 agent / 0 unclaimed, unmoved.

---

## 3. Migration 0015, rehearsed

`crawls.host_spacing_jsonb` is a `{host: earnedMs}` map added by migration 0015,
recording each host's own high-water spacing so a resume re-enters each host at
ITS OWN earned width rather than the crawl-wide widest. `host_spacing_ms` stays
as the crawl-wide fallback: a host the map does not name — a URL discovered only
on the continuation, or a pre-0015 crawl whose map is null — falls back to it,
which is the polite direction, never a fabricated split. No backfill: a pre-0015
row's map is null and stays null (honest degradation).

**The kept rows' map is null on all four** — they predate 0015, and nothing
backfilled them (§1.1). Migration 0015 applied cleanly and `host_spacing_ms`
is untouched on every one.

**The resume paths, proven.** Pinned:

- `test/crawl/loop.test.ts:935` "resumes each host at its own earned spacing from
  the per-host map" — the per-host resume: a single mapped host seeded from its
  own recorded width rather than the crawl-wide value. (The multi-host divergence
  the map exists for is driven at the gate level — the fixture crawl is
  single-origin; see the synthetic-seed note in §8.3.)
- `test/crawl/loop.test.ts:964` "falls back to the crawl-wide spacing when the
  per-host map is null (pre-0015)" — the null-map fallback.
- `test/crawl/loop.test.ts:994` "re-persists a non-widest host's escalation
  mid-crawl, not only at close" — the rule-9 fix's own red-first test (§3.1).

A note carried from T3's re-review, so the prose here does not overclaim: the
mid-crawl re-persist test drives the divergence with a SYNTHETIC crawl-wide seed
(`host_spacing_ms` 10000 beside a `{origin: 40}` map) standing in for a second
host's prior contribution, not with two literally distinct gate-tracked hosts. It
exercises the exact `highWaterMs`-vs-`spacingMs(host)` divergence the hole lived
in; it is not a literal two-host crawl, and this document does not imply one.

### 3.1 The stale-map hole — the phase's surprise

T3's first cut gated the map write on the crawl-wide widest spacing moving
(`loop.ts`). A host that escalated its own spacing but never became the crawl-wide
widest was never written to the map. Reachability is narrow — a single-origin
crawl is safe (the origin is always widest), and resource third-party hosts are
absent from the main loop's snapshot — but a second main-loop gate host (a
`www`/apex/scheme variant) actively throttled while still below the origin's
spacing, plus a hard kill before close, hits it: the map persists that host
stale-low, and resume SEEDS it there (the crawl-wide fallback does NOT save it —
that only covers hosts ABSENT from the map), so it re-enters FASTER than earned.
Worse than pre-0015.

The fix (02a3cf5): a spacing-generation counter that bumps on ANY host's
escalation or base-raising, and the loop persists the map on a generation change
rather than only on a widest-move — restoring pre-0015's at-most-one-batch
staleness bound without defeating the per-host point (mapped hosts are still
seeded `max(configFloor, mapValue)`, never seed-at-max). The initial report's
concern-2 disposition and the `loop.ts` docblock had both claimed the wider
fallback saved the in-map-stale host; both were materially wrong and were
corrected in the fix commit. `renderPaceMs` stays crawl-wide by decision (the
render set is same-origin by construction) and `crawl_status` does not surface
the map (the crawl-wide `hostSpacingMs` already serves the poll; the map is
resume machinery) — both concurred at review.

---

## 4. The chores hold

**The `ran`\|`none` vocabulary.** `RENDER_PASS_EVIDENCE = { ran: "ran", none:
"none" } as const` is now the single named authority for the two wire values;
16 pins plus the MCP hint were converted. A grep for the bare literals over
`src/` finds them only in the constant's own declaration and its docblock in
`src/rules/metric/render-metrics.ts` (the one other `"none"` in `src/`, in a
`crawl-evidence.ts` docblock about `findingCap: "none"`, is a different
vocabulary). The value
strings are unchanged: this was literal → named, not a wire change.

**The wire-shape assertion (T4-review Minor 1, taken here).** Because every pin
now references the constant, a silent drift in either value would ship green —
the literal → named refactor removed the net that a hardcoded-literal fixture
gave. One dedicated assertion restores it:
`test/rules/render-metrics.test.ts:52` "pins the render-pass evidence wire shape
against hardcoded literals" — `expect(RENDER_PASS_EVIDENCE).toEqual({ ran: "ran",
none: "none" })`. Written red-first: flipping `ran` to `"FLIP"` failed with the
expected diff, then corrected to green. The value crosses the seam to Talos, so
it is worth one assertion nobody can refactor away.

**The registry-derived marker flag, and the one-edit proof.** The hand-written
`MARKERS` map is deleted; `marker?: string` on `RuleMeta` (presence is the flag,
value is the reason; `defineRule` rejects a present-but-empty flag, so both
degenerate states are unrepresentable) is the single source of truth, and the
guard derives its marker set from `marker !== undefined` over `buildRegistry()`.
Adding a hypothetical ninth marker costs exactly ONE edit — the flag on its
definition — and the guard, not hand-bookkeeping, enforces the rest, in both
directions:

- a flagged rule the checklist forgot → `test/skills/identifier-guard.test.ts:663`
  "every NOT MEASURED marker is named in the checklist entry of each check it
  claims" fails (`CHECK-NN does not name <id>`);
- a flagged rule CHECK-83's family list omits → `identifier-guard.test.ts:696`
  "CHECK-83's NOT MEASURED family list names exactly the flagged markers" fails
  (`these rules carry the marker flag, but CHECK-83's ... omits them`);
- an id CHECK-83 names that nobody flagged → the same test fails the other
  direction (`CHECK-83 names these ... but no rule carries the marker flag`).

The former three-edit toll (rule + map entry + checklist list), of which only the
map entry was ever enforced, becomes one declaration and two red tests. T4
CONVERTED T2's hand entries rather than dropping them: the marker set enumerates
exactly the eight flagged rules, each named in its checklist entry and in
CHECK-83's family list, none lost (T4 review, revert-verified both directions).

---

## 5. Verification

Run in this worktree, on the tree at the gate commit. `DATABASE_URL` was exported
for every measurement (`postgresql://ariadne:ariadne@localhost:5440/ariadne`) —
the suite's database tests fail closed without it, so it is a prerequisite, not a
convenience.

| | |
|---|---|
| Suite | **1,787 tests / 71 files, all passing** — two full runs for this document (**108.1 s, 107.5 s**). Baseline into this task was 1,786; the net +1 is §4's wire-shape assertion |
| Typecheck | `npx tsc --noEmit` clean |
| Migrations | 0000–**0015**; 0015 is the last, added by T3 |
| Ruleset | **0.10.0**, **94 rules** = 26 page + 54 query + 14 metric |
| Checklist | 83 checks; the coverage query green — 47 crawl-derived checks account as **44 claimed / 3 agent / 0 unclaimed**, unmoved by this phase |
| Guards | the identifier guard, the citation guard and its `src/` form, the marker guard (now derived), and the copy contracts — all green over every edit; §4's line-shift in `render-metrics.test.ts` staled one `talos-surface.md` citation (:520 → :528), caught by the citation guard and bumped |
| Tree | clean at each commit; no crawl data committed — the database holds it |
| Surface | 16 MCP tools / 16 HTTP routes, unchanged this phase |

**The kept crawls are untouched.** Fingerprinted before this task's suite runs
(§1.1), two full runs later, re-read: identical, including `host_spacing_jsonb`
null on all four and every child count.

### 5.1 The §2.2 robots-split closure

Pointer 9 — the end-to-end chain from a real fetch pass through to the served
`robotsDenied` / `robotsUnreachable` counts — is closed by
`test/crawl/fetch-resources.test.ts:917` "serves the two robots counts off a
crawl the real pass produced": one crawl, the real pass against a dead host and a
forbidding host plus one file on each side of the `ok`/`failed` line, then the
served census read back through `ApiService.getCrawl` — `robotsDenied: 1`,
`robotsUnreachable: 1`, both proven strict SUBSETS of `failed`. The hand-made
join §2.2 carried for the Phase 12 document is retired.

---

## 6. Red-first, honestly accounted

Against the task reports, not against a tidy retelling:

- **T1** — the leak fix is a teardown, not a behaviour change; its red-first is
  the attribution (33 rows, one file, measured serially) and the zero-per-run
  proof, not a failing assertion. The new §5.1 e2e test was born after the
  cleanup so its crawl is counted in the re-pinned figure.
- **T2** — red-first four ways: the missing-rule failures, the forced
  registry/coverage/copy pins, the version pin, and the marker guard naming
  CHECK-48/49/50/51 (the three-edit toll, paid one last time before T4 derived
  it away).
- **T3** — the migration and null-map were verified; the rule-9 fix's test
  (`loop.test.ts:994`) was red-first, RED at max-40 before the generation-counter
  fix and GREEN at ≥80 after.
- **T4** — the one-edit proof was revert-verified with scratch edits in both
  directions (flagged-unnamed → red; named-unflagged → red the other way).
- **T5** — the wire-shape assertion (§4) was written red-first: `ran` flipped to
  `"FLIP"`, seen to fail with the expected diff, then corrected.

---

## 7. Commits, in order

| commit | what |
|---|---|
| `a8cfae9` | T1 — fetch-resources owns its crawl rows; the robots split closes end to end |
| `55c8313` | T1 — the sweep record reads 3,110 → 28 → 4 (the second sweep) |
| `fca9981` | T2 — `resources.all-unknown`, the third marker, ruleset 0.10.0 |
| `b324528` | T3 — per-host earned spacing across a resume (migration 0015) |
| `02a3cf5` | T3 — persist per-host spacing on any host move, not just the widest (the §3.1 fix) |
| `beedda9` | T4 — named render-evidence vocab + registry-derived marker flag |
| (T5) | the two carried chores (§4's wire-shape assertion + `talos-surface.md`'s Phase 13 block) and this gate document |

---

## 8. What Phase 14 inherits

In the order they will be met.

1. **The partial-unknown crawl with no `ok` or broken row fires no marker**
   (T2 review, Minor 1 — a genuine residual, not a chore in scope here). A
   PARTIAL pass carrying only `null` (unweighed) and decided-unknown rows, and
   no `ok` or `broken` row, fires none of the three markers: the `unknownResources`
   buckets need an `ok` row to ride on, and there is none. The family's rule-1
   reason (silence a reader could misread as clean) makes closing it worth a
   future look — the same class the §10.1 window was, one layer in.
2. **`robots_unreachable` rows are never retried** (phase-12 §10 pointer 5,
   still standing). The pass's work list is the null `fetch_class` column and
   these rows carry a class, so only a fresh crawl re-asks. Unchanged behaviour
   — `robots_denied` was always treated this way — but the Phase 12 split made it
   visible. A pointer, at most.
3. **A test-framing note, not a defect** (T3 re-review). The mid-crawl re-persist
   test (§3) uses a synthetic crawl-wide seed standing in for a second host, not
   two literally distinct gate hosts. A future two-host fixture crawl would let
   the test assert the divergence without the stand-in.
4. **Tenancy on `crawl_list`** — unchanged, the stated posture, **owner-ruled
   standing** at Phase 12 integration and NOT reopened here.
5. **The wall-time shortening designs** — not taken, **owner-ruled standing**.
   The day an operator's "this site can take it" exists as an input on the
   surface, this re-opens with the data to settle it.

---

## 9. Integration

Push `worktree-phase-13`, open **PR #12** against `main`, link CI here when it is
green (CI placeholder — PR #12), and merge per owner (the last four phases:
merge-on-green). No Serena project is registered for Ariadne, so the auto-memory
handoff is the record, as every prior phase noted.

CI: _(PR #12 — link on push)_

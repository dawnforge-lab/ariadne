# Phase 14 gate — the last closures, and the empty ledger

Phase 14 had no discovery in its plan, and unlike Phase 13 it produced none. Its
scope was the residue of `docs/gates/phase-13.md` §8: one genuine gap the family
still carried (pointer 1, the partial-unknown crawl), one test-framing note
(pointer 3, the synthetic resume seed), one standing pointer to record
(pointer 2, `robots_unreachable` retry), and two owner-ruled standing items
left untouched (pointers 4 and 5). Two of those were built; the third is a
recorded decision; the last two stay standing. After this phase the engine-side
ledger is **empty of chores** — §8 says that plainly, and says what it means.

The phase-13 §8 pointers, resolved:

| phase-13 §8 | what it named | Phase 14 |
|---|---|---|
| 1 | the partial-unknown crawl fires no marker — a genuine residual | **closed** (T1) — `resources.partial-unknown`, info, ruleset 0.11.0; the fourth and last marker of the family |
| 2 | `robots_unreachable` rows are never retried | **not taken — owner-ruled standing** (§7; ruled at PR #13 integration, 2026-09-03, revisit-on-demand) |
| 3 | the mid-crawl re-persist test uses a synthetic crawl-wide seed, not two real hosts | **closed** (T2) — a two-host fixture crawl earns and resumes per-host spacing on two real gate hosts |
| 4 | tenancy on `crawl_list` | **unchanged — owner-ruled standing** (§8) |
| 5 | the wall-time shortening designs | **not taken — owner-ruled standing** (§8) |

---

## What the gate is

**This gate is fixture-proven and made no contact with any client site.** That
was ruled before the phase started, and the reasoning is Phase 12's and
Phase 13's unchanged: nothing in Phase 14 changes what the crawler asks a site
for. The fourth marker reads a table; the two-host resume test earns its spacing
against a local fixture server on two hostnames of one loopback listener and
replays it against work the fixture was already going to be asked about. A phase
that changes no politeness behaviour toward a real site does not earn the right
to spend a site's bandwidth proving it. Phase 11's gate crawl remains the last
real-site measurement, and its four rows are the kept crawls this document
rehearses against.

Three clauses, each answered with a measurement taken for this document.

| | The plan asked | Answered |
|---|---|---|
| 1 | T1's fourth marker fires on its exact shape; the four-marker partition holds total-and-disjoint; coverage unmoved | §1 — the firing test and the one exclusivity test over all four boundaries green; the partition ruled total+disjoint by T1's review; 95 rules / 55 query, the 47-check universe unmoved |
| 2 | T2's two-host resume: host A earns and resumes 80 ms, host B 160 ms, A holds 80 not 160 | §2 — the two-host test green: A 80, B 160, A resumes 80 (the anti-inheritance proof), from real 429 pushback |
| 3 | the four kept rows unchanged; the suite leaves zero net crawl rows; full suite + tsc | §3 — 4 rows before and after each of two full runs; the four kept rows fingerprint-identical, child counts included; 1,797 / 71 green twice, tsc clean |

The gate also carries the recorded `robots_unreachable` decision (§7) and the
clear-ledger note — what Phase 15 inherits, which is no chore at all (§8).

---

## 1. The fourth marker, and the partition closed

`resources.partial-unknown` (info, ruleset 0.11.0) is the fourth and last
resource-coverage marker. It fires on a PARTIAL pass: `seen > 0`, some rows
still `null` (the pass never reached them), the rest a DECIDED UNKNOWN class
(`refused`, `robots_denied`, `robots_unreachable`, `fetch_error`), and no `ok`
row and no broken (4xx/5xx) row — so the four judging rules write nothing and
the `unknownResources` counts that would explain the silence live on findings
that do not exist. Its evidence carries the same per-class `census` and
`dominantClass` as its all-unknown sibling, plus `resourcesUnfetched` — the
count of files the pass never reached — beside `resourcesSeen` and
`pagesCrawled`. This is the exact gap `docs/gates/phase-13.md` §8 pointer 1
named: the all-unknown marker excluded it (a null row means not every file was
reached), not-fetched excluded it (not every row is null), not-recorded excluded
it (rows exist), and the judging rules were silent for want of an `ok` row.

**It fires on its exact shape.** Pinned:
`test/rules/resources-query.test.ts:1119` "reports a mix of unasked and
decided-unknown rows, with the census, the unfetched count and the dominant
class" — a five-row crawl (two `robots_unreachable`, one `fetch_error`, two
unasked) yields one site finding with `resourcesSeen: 5`, `resourcesUnfetched:
2`, the per-class census `{refused: 0, robots_denied: 0, robots_unreachable: 2,
fetch_error: 1}` and `dominantClass: "robots_unreachable"`. Its silence
boundaries are pinned beside it: silent when one file came back `ok` (partial
coverage the judging rules carry), silent when one file answered 4xx/5xx
(`resources.broken` speaks), silent when every row is unasked (not-fetched's),
silent when every row is a decided unknown (all-unknown's), and silent on a
crawl that recorded nothing and on a normal completed pass.

**The four-marker partition is total and disjoint** — the exclusivity ruling.
One test drives every boundary:
`test/rules/resources-query.test.ts:1237` "one test, all four boundaries: each
marker fires on its own and nowhere else" seeds one crawl per marker
(`not-recorded` = no resource rows, `not-fetched` = every row unfetched,
`all-unknown` = every row a decided unknown, `partial-unknown` = the mix) and
asserts each marker fires on its own crawl and returns `[]` on the other three —
a 4×4 matrix, sixteen assertions. T1's review ruled the partition total and
disjoint by enumerating all sixteen `{ok, broken, unknown, null}`
presence-combinations: the silent space is exactly `O == 0 ∧ B == 0` (plus
`seen == 0`), which is four shapes, and the four markers biject onto them
(`seen == 0` with pages declaring references → not-recorded, all-null →
not-fetched, all-decided-unknown → all-unknown, the MIX → partial-unknown); no
shape fires two, and every shape
with an `ok` or broken row correctly fires no marker (the judging rules and
`resources.broken` carry it). The last rule-1 silence over `seen > 0` is closed.

**Coverage, measured now.** Ruleset **0.11.0**, **95 rules** = 26 page + 55
query + 14 metric (built from `buildRegistry()` for this document). The fourth
marker was the phase's one verdict-changing edit — a new id firing where nothing
fired, additive, never a widened condition on a rule already stamped into stored
findings. The 47-check crawl-derived universe is unmoved: 44 claimed / 3 agent
(`CHECK-38`, `CHECK-41`, `CHECK-42`) / 0 unclaimed, exactly as Phase 13 left it,
because the marker claims `CHECK-83` (the coverage check, outside the
crawl-derived 47) through the same bijection guard its three siblings do — one
declaration, the guard forcing the checklist entries. The marker flag now names
nine rules (five `-skipped` markers plus the four-strong resource family).

---

## 2. Two real gate hosts, each resuming its own spacing

Phase 13's §8 pointer 3 was a test-framing note: the mid-crawl re-persist test
drove the per-host divergence with a SYNTHETIC crawl-wide seed
(`host_spacing_ms` beside a one-host map) standing in for a second host's prior
contribution, not with two literally distinct gate hosts. T2 retired the
stand-in with a fixture crawl that visits two real gate hosts — the apex and
`www.` spellings of one loopback listener, which is the exact shape §3.1 of the
Phase 13 gate named and the only second-host shape the same-origin main loop
actually reaches (distinct ports key distinctly but are external to the loop's
same-origin boundary, so a cross-port link is never fetched).

Pinned: `test/crawl/loop.test.ts:1061` "earns two real hosts' distinct spacings
and resumes each at its own". The apex host is blocked once on its slow path
(one escalation: 40 → 80 ms); the `www` host twice (two: 40 → 80 → 160 ms). From
that real 429 pushback the crawl persists `hostSpacingJsonb[apex] == 80`,
`hostSpacingJsonb[www] == 160`, and the crawl-wide `hostSpacingMs == 160` (the
widest). The resume rebuilds the gate from the per-host map, and the assertion
that carries the phase is the divergence on the way back: the apex re-enters at
**80** while `www` re-enters at **160** — the apex holding 80 and **not**
inheriting the crawl-wide 160 is the anti-inheritance proof. T2's review made
the proof concrete: drop the seeding and the apex reads `undefined`, not 80, and
the assertion fails. The two earned numbers trace to `seed × 2^escalations`
(the 40 ms base is not the point; the ratchet doubling is), and the assertions are
strict `toBe`, stricter than the loop's looser sibling tests.

The two synthetic-seed unit tests from Phase 13 are KEPT as companions — the
map-round-trip and the mid-crawl re-persist each pin a distinct property (a
single mapped host seeded from its own width; a non-widest host's escalation
persisted mid-crawl, not only at close) that the two-host crawl does not
subsume. This gate does not re-edit §3 of the Phase 13 document, which is the
frozen historical framing of the stand-in.

**One thing the two-host resume proves and one it does not**, recorded so the
prose does not overclaim (T2 review). Run 1 finishes clean, so the resume
re-enters over an EMPTY frontier: it proves the per-host **seeding** path
deterministically — which is exactly what §3.1's stale-map bug was about, so it
is covered where it mattered — but it does not exercise a live re-fetch
escalating a host FURTHER on the resumed run. That is a disclosed gap, not a
defect, and it is not a chore (§8).

---

## 3. The kept rows, and zero net

`DATABASE_URL` was exported for every measurement
(`postgresql://ariadne:ariadne@localhost:5440/ariadne`) — the suite's database
tests fail closed without it, so it is a prerequisite, not a convenience. The
dev database is the four kept `lavishalice.com` reference crawls, read-only
across this phase.

### 3.1 The four kept crawls, fingerprinted

Read before this task's suite runs and unchanged after both:

| id | site | status | host_spacing_ms | host_spacing_jsonb | md5(id‖site‖status‖spacing‖map) |
|---|---|---|---|---|---|
| `crawl_02ff6f7a…` | lavishalice.com | finished | 2000 | null | `5a8770ca08b8806a6575af7f9faaa1ea` |
| `crawl_2af4daf1…` | lavishalice.com | finished | 2000 | null | `3482ef06a1a585415b806c5b0a278289` |
| `crawl_3f3ab847…` | lavishalice.com | finished | 2000 | null | `c78aa05ed36978a2c40a3e2569dc0889` |
| `crawl_f0fc5096…` | lavishalice.com | finished | 2000 | null | `adaf97910abc2781109a32297b5f7eda` |

Child-row counts, likewise stable and identical to the Phase 13 gate's §1.1:

| id | pages | links | issues | metrics | resources | page_resources |
|---|---|---|---|---|---|---|
| `02ff6f7a` | 551 | 35,145 | 17,659 | 85 | 0 | 0 |
| `2af4daf1` | 551 | 35,145 | 1,314 | 855 | 0 | 0 |
| `3f3ab847` | 551 | 35,145 | 1,326 | 1,023 | 0 | 0 |
| `f0fc5096` | 557 | 34,780 | 13,617 | 98 | 1,997 | 38,737 |

The `host_spacing_jsonb` fingerprint column is null on all four (they predate
migration 0015 and nothing backfills), so T2's per-host map work — which writes
that column on a live crawl — left every kept row untouched, as the identical
md5s before and after confirm.

### 3.2 Zero net rows, twice

The suite creates and tears down its own crawl rows within a run (the P13-T1
`createdCrawls` + `afterAll` discipline); the resting count between green runs is
the measurement. Read immediately before and after each of two full runs for
this document:

| | before | after |
|---|---|---|
| full run 1 | 4 | 4 |
| full run 2 | 4 | 4 |

Zero is zero-on-green: a test that threw mid-run could still leave a row (the
pre-existing `loop.test` exposure the Phase 13 gate noted), which is why the
measurement is the resting count between green runs. T2's two-host crawl tracks
its rows like every other row-creating test; it added no leak.

---

## 4. Verification

| | |
|---|---|
| Suite | **1,797 tests / 71 files, all passing** — two full runs for this document. Baseline into this phase was 1,787 (Phase 13's gate); the net +10 is T1's marker tests (+9) and T2's two-host test (+1) |
| Typecheck | `npx tsc --noEmit` clean |
| Migrations | 0000–**0015**; no migration added this phase — the fourth marker is a rule over existing columns |
| Ruleset | **0.11.0**, **95 rules** = 26 page + 55 query + 14 metric |
| Checklist | 83 checks; the coverage query green — the 47 crawl-derived checks account as **44 claimed / 3 agent / 0 unclaimed**, unmoved by this phase |
| Guards | the identifier guard, the citation guard and its `src/` form, the marker guard (derived; now nine markers), and the copy contracts — all green over every edit |
| Tree | clean at each commit; no crawl data committed — the database holds it |
| Surface | 16 MCP tools / 16 HTTP routes, unchanged this phase; `talos-surface.md`'s Status header bumped to Phase 14 / 0.11.0 with a "What Phase 14 changed here" block |

**The kept crawls are untouched.** Fingerprinted before this phase's suite runs
(§3.1), two full runs later, re-read: identical, including `host_spacing_jsonb`
null on all four and every child count.

---

## 5. Red-first, honestly accounted

Against the task reports, not a tidy retelling:

- **T1** — the marker was red-first: the firing test and the exclusivity
  matrix's fourth column fail before the rule exists, and the bijection guard
  named `CHECK-83`'s family list until the checklist entry was added. The
  version pin forced the 0.11.0 bump.
- **T2** — the anti-inheritance assertion is the red-first: with the per-host
  seeding removed the apex reads `undefined` and `toBe(80)` fails; the two 429
  escalations are driven by the real fixture server, not stubbed.
- **T3** (this gate) — no code beyond docs. The red-first here is the
  measurement discipline: the fingerprints and the zero-net counts were read
  from the live database, not asserted.

---

## 6. Commits, in order

| commit | what |
|---|---|
| `9009b30` | the Phase 14 plan — the last closures (BASE) |
| `2a15657` | T1 — `resources.partial-unknown`, the fourth marker, ruleset 0.11.0 |
| `94b3e8a` | T2 — earn per-host spacing on two real gate hosts, retiring the synthetic seed |
| (T3) | `talos-surface.md`'s Status header + Phase 14 block, and this gate document |

---

## 7. The recorded decision — `robots_unreachable` retry, NOT TAKEN (owner-ruled)

Phase 13 §8 pointer 2 carried this forward: a resource row classed
`robots_unreachable` is never retried within the crawl. The pass's work list is
the null `fetch_class` column, and these rows carry a class, so only a fresh
crawl re-asks. This phase records a decision and does not act on it.

**Owner-ruled at integration (PR #13, 2026-09-03): accepted — not taken,
revisit on demand.** This was recorded proposed-and-unvetoed through the phase
(the P12-T4 M-6 wording discipline: the argument below was the plan's proposal,
not "the owner's reasoning", until the owner ruled). The owner accepted the
proposal at integration, so it now stands as an owner-ruled decision, not a
Phase 15 reopen. It reopens only later, on demand.

**The proposal: do not add a retry.** The argument, on the engine's own terms:

1. **`fetchRobots` already retries before it declares unreachable.** An
   unreachable robots.txt from a 5xx, timeout, or network error (as opposed to
   an absent 4xx, which is normal) gets three tries with a short linear backoff
   before the crawl concludes the origin cannot tell us its rules; a URL the
   policy refused is classed unreachable immediately, on the first request,
   since asking again would only be rude (`src/crawl/discovery.ts`,
   `classifyRobotsFailure`). The resource-level `robots_unreachable` class
   inherits that verdict. A second retry layer at the resource pass re-asks a
   host that a backoff-bounded probe just failed to reach.
2. **Re-asking spends requests on a just-failed host.** That is the hard-rule-9
   direction we most want to avoid: a host that could not answer its robots.txt
   is precisely the host we should not hammer. The polite move is to leave it
   classed and let a human decide.
3. **A fresh crawl re-asks cleanly.** The row carries a class, so the next crawl
   of the site probes robots.txt from scratch — the retry a caller actually
   wants is a re-crawl, which the surface already offers, not an in-crawl loop.

This is the **same politeness-posture class as the wall-time designs** (§8): a
change that trades politeness for completeness, which only an operator's
explicit "this host can take it" should authorize. Until that input exists on
the surface, the decision stays as recorded: not taken, revisit on demand.

---

## 8. What Phase 15 inherits — the empty ledger

**The engine-side ledger is now empty of chores.** Fourteen phases accrued a
running backlog — leaks, missing markers, un-derived lists, a stale-map hole,
resume machinery — and every one of them has been paid. This is the honest
statement the closing phase exists to make: there is no engine chore left to do.

What remains is not a chore. Three items, all revisit-on-demand:

1. **`robots_unreachable` retry** — the decision recorded in §7, **not taken,
   owner-ruled standing** (accepted at PR #13 integration, 2026-09-03). It
   reopens only later, on demand.
2. **Tenancy on `crawl_list`** — unchanged, the stated pre-tenancy posture,
   **owner-ruled standing** since Phase 12 integration and not reopened here. It
   reopens the day Ariadne serves more than one Talos tenant from one token.
3. **The wall-time shortening designs** — not taken, **owner-ruled standing**.
   The day an operator's "this site can take it" exists as an input on the
   surface, this reopens with the data to settle it.

And one gap-note this phase surfaced but did not build, recorded so it is not
lost and so nobody mistakes it for a chore:

- **The two-host resume proves the seeding path, not a live re-fetch
  escalation** (§2). Run 1 finishes clean, so the resume re-enters over an empty
  frontier and proves the per-host **seeding** path — which is what §3.1's
  stale-map bug was about, so it is covered where it mattered — but not a host
  escalating FURTHER on the resumed run itself. A future two-host crawl that
  leaves work owed on resume would exercise it. Not a defect; a disclosed edge.

**So the next work is new direction, not closure.** The crawl+audit engine has
paid every debt it accrued through fourteen phases. What comes next — Talos-side
build against this surface, new resource classes, new checks, a wall-time input
if the owner wants one — is a fresh brainstorm, not another closure phase. A
phase that only closes debts is the easiest to describe; there are no more debts
to close.

---

## 9. Integration

Push `worktree-phase-14`, open **PR #13** against `main`, link CI here when it is
green (CI placeholder — PR #13), and merge per owner (the standing pattern of the
last five phases: merge-on-green). No Serena project is registered for Ariadne,
so the auto-memory handoff is the record, as every prior phase noted.

**CI: placeholder — PR #13** (link and run to be pasted here when green).

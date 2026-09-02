# Phase 12 gate — the owed debts, and the politeness bug the last one uncovered

Phase 12 had no discovery in it. Its scope was a list somebody else wrote: the
seven pointers in `docs/gates/phase-11.md` §14, four of them owed work and two of
them decisions. That makes it the easiest phase to describe and the easiest to do
badly, because a phase that only pays debts has no natural moment where the
engine tells you something you did not ask it.

**It had one anyway, and it is the phase's real result.** Building the fourth
item — a way to resume a crawl over the wire — meant reading `resumeCrawl`,
and `resumeCrawl` did not restore `crawls.host_spacing_ms`. A crawl that had been
slowed down because a host pushed back went back to the pace that host refused,
**and overwrote the record of the refusal on its way past** (§4.1). That is a
hard-rule-9 defect that had been in the tree since Phase 6 — since migration
0009 gave the ratchet a column and the RENDER pass learned to read it, while the
crawl pass that earned the number never did — invisible from `crawl_status`, and
nothing in this phase's plan was looking for it. It is fixed,
in the module that owns spacing, in its own commit, and it applies to every
caller of `resumeCrawl` and not only to the new tool.

The rest is the list, paid:

| phase-11 §14 | what it asked | Phase 12 |
|---|---|---|
| 1 | migration 0014, the cap-exceeded counter | **shipped** (T1) — `crawls.resource_refs_capped_pages`, nullable, no backfill |
| 2 | `robots_unreachable` as a class, and a served count | **shipped** (T1) — off `RobotsInfo.outcome`, never off the reason sentence |
| 3 | the 0.9.0 sibling marker | **shipped** (T2) — `resources.not-fetched`, with three reasons rather than the two the ledger foresaw |
| 4 | a way to resume a crawl over the wire | **shipped** (T3) — `crawl_resume`, both transports, six refusals |
| 5 | the wall-time question | **NOT TAKEN — owner-ruled at integration** — §7 |
| 6 | `render.coverage`'s selection fields on a crawl that rendered nothing | **shipped** (T4) — `renderPassEvidence` |
| 7 | tenancy on `crawl_list` | **unchanged — owner-ruled at integration** — §7 |

And three things the phase found while paying them, each of which is a defect
class this repository has met before: a docblock that proved a shape impossible
with a mechanism that does not exist (§3.2), a compare-and-swap whose result was
discarded (§4.4), and a resume that left a completed judgement standing over a
crawl that had since grown (§4.5).

---

## What the gate is

**This gate is fixture-proven and made no contact with any client site.** That
was ruled before the phase started, and the reasoning is worth keeping: nothing
in Phase 12 changes what the crawler asks a site for. The counter counts
something the analyzer already dropped, the robots split renames an outcome the
pass already reached, the marker reads a table, and the resume replays work the
site was already going to be asked about. A phase that changes no politeness
behaviour toward a site does not earn the right to spend a site's bandwidth
proving it. Phase 11's gate crawl is the last real-site measurement, and this
document rehearses against its rows rather than taking new ones.

Five clauses, each answered with a measurement taken for this document.

| | The plan asked | Answered |
|---|---|---|
| 1 | migration 0014 rehearsed over the kept crawl rows; the counter null on all four; the gate-crawl rows byte-stable | §1 — four rows, `resource_refs_capped_pages` null on every one, all six child counts equal to the phase-11 table figure for figure, both `robots_denied` rows intact and genuine |
| 2 | the robots split live on fixtures; the gate crawl's two forbade rows unchanged | §2 — a real pass against a dead host and a forbidding host writes the two classes apart; a fixture crawl serves `robotsDenied: 1, robotsUnreachable: 1`; the gate crawl serves `robotsDenied: 2, robotsUnreachable: 0` |
| 3 | the marker fires on fixtures with the right reason; the sibling boundary holds; a normal crawl carries neither | §3 — three reasons each on their own crawl, four silences, one exclusivity test driving both markers, and a throw narrowed to a shape no writer of ours produces |
| 4 | the killed-and-resumed crawl equals its control; the ratchet persists across the kill; every refusal exercised on both transports | §4 — one `toEqual` over pages, the whole resource census and the findings count; `hostSpacingMs ≥ 50` after a resume that read 0 before the fix; twelve HTTP and seven MCP cases |
| 5 | full suite green, tsc clean, tree clean, kept rows untouched, leak arithmetic stated | §11 — 1,765 / 71 four times, tsc clean, tree clean, the four kept rows byte-identical across two full runs, and the leak measured at **33 rows a run** |

A gate that only records its passes teaches nothing, so this one also carries
the politeness bug (§4.1), the three false statements the phase's own reviews
caught (§3.2, §4.4, §4.5), an honest accounting of which tests were really
written first (§6), and the window this phase stated rather than closed (§10).

---

## 1. Migration 0014, rehearsed over the crawls that must not move

`drizzle/0014_sleepy_jocasta.sql`, in full:

```sql
ALTER TABLE "crawls" ADD COLUMN "resource_refs_capped_pages" integer;
```

One statement, nullable, no `DEFAULT`, no `NOT NULL`, no index, no backfill, no
other table touched. **The absence of a backfill is a doctrine decision, not an
omission**: how many pages a finished crawl truncated is unknowable after the
fact — the analyzer dropped the references without counting them — and null is
this engine's word for "nobody counted". A zero there would be a measurement no
one took.

The DDL as Postgres holds it, read for this document:

```
 resource_refs_capped_pages | integer |  |  |
```

Nullable, no default, as written.

### 1.1 The four kept rows

The dev database holds **four** `lavishalice.com` crawl rows, not five: the
0.7.0 re-judge that audit 4 ran is `crawl_02ff6f7a` judged a second time and has
no row of its own. (The Phase 12 plan said five; T1 found the discrepancy and the
controller corrected the plan in `923614f`. It is recorded here because a gate
document that inherited the wrong count would keep it alive.)

| crawl | ruleset | status | pages | `host_spacing_ms` | `resource_refs_capped_pages` |
|---|---|---|---|---|---|
| `crawl_2af4daf1…` | 0.4.0 | finished | 551 | 2000 | **null** |
| `crawl_3f3ab847…` | 0.5.0 | finished | 551 | 2000 | **null** |
| `crawl_02ff6f7a…` | 0.6.0 | finished | 551 | 2000 | **null** |
| `crawl_f0fc5096…` | 0.8.0 | finished | 557 | 2000 | **null** |

**Null on all four, which is the correct answer and not a gap.** Each of these
crawls closed before the column existed, so nothing counted, so nothing is
stamped. Across the whole `crawls` table the column is non-null only on rows the
suite itself created since T1 — the number moves every run and is not a fact
about any operator.

### 1.2 The child counts, against the phase-11 table

Counted for this document, one `count(*)` per child table per crawl:

| crawl | pages | links | sitemap URLs | issues | metrics | resources |
|---|---|---|---|---|---|---|
| `crawl_2af4daf1…` | 551 | 35,145 | 438 | 1,314 | 855 | 0 |
| `crawl_3f3ab847…` | 551 | 35,145 | 438 | 1,326 | 1,023 | 0 |
| `crawl_02ff6f7a…` | 551 | 35,145 | 438 | 17,659 | 85 | 0 |
| `crawl_f0fc5096…` | 557 | 34,780 | 444 | 13,617 | 98 | 1,997 |

**Every figure equals `phase-11.md` §13's table** — that comparison is this
document's own, figure by figure. (§13 in turn recorded that its first three
rows matched the Phase 8 and Phase 10 gate documents; that chain is its
statement, not a second measurement here.) A migration, four feature commits and
four full suite runs later, the reference crawls hold exactly the rows they held.

The counts are the readable form; the check that was actually run is stronger. A
snapshot was taken of all four rows — `status`, `pages_crawled`,
`render_pass_count`, `ruleset_version`, `started_at`, `finished_at`,
`host_spacing_ms`, `rules_run_at`, the new column, the md5 of all six jsonb blobs
and all six child counts — then the full suite was run **twice**, then the same
snapshot was taken again and `diff`ed. **Identical**, byte for byte, including
every jsonb digest.

### 1.3 The two `robots_denied` rows are the ones history recorded

The one thing the robots split must not do is rewrite the past. The gate crawl's
two refusals, read now:

```
 robots_denied | robots.txt (lavishalice.com) disallows this URL | 1
 robots_denied | robots.txt (shop.app) disallows this URL        | 1
```

Both say **disallows this URL** — a robots.txt that was read and forbade us,
which is what `robots_denied` still means. Neither was rewritten, and the new
class was written going forward only, so the crawl's whole census is unchanged:
1,995 `ok`, 2 `robots_denied`, nothing else.

Served, through `crawl_status` on that same crawl (read read-only for this
document, no row written):

```json
{"seen":1997,"fetched":1995,"failed":2,"skipped":0,
 "robotsDenied":2,"robotsUnreachable":0,"capped":false}
```

`robotsUnreachable: 0` is the correct history: on 2026-09-02 at 01:46 the engine
could not have written that class, and both of these hosts answered their
robots.txt. Phase 11 had to do this split in SQL over `fetch_reason`
(`phase-11.md` §2.3); the same answer now comes off a served field.

**One honest note on comparing across the boundary.** `robots_denied` NARROWED
this phase: a row for a robots.txt we could not read used to land there and now
lands in `robots_unreachable`. `fetch_class` carries no ruleset stamp and no
re-judge repairs it, so a `robotsDenied` count from a Phase 11 crawl and one from
a Phase 12 crawl count different populations. `talos-surface.md`'s Phase 12
paragraph says so, and it says so because T4's reviewer caught the paragraph
claiming the opposite (§6).

---

## 2. The robots split, driven apart by a real pass

An unreachable `robots.txt` is a complete disallow (RFC 9309 §2.3.1.4), so
before this phase a CDN that was **down** and a CDN that **forbids us** landed in
one class and were distinguishable only by prose in `fetch_reason`. Phase 11
refused to count them apart by matching that prose — a reworded error string
would zero the count silently — and ledgered the fix: `RobotsInfo.outcome` is a
closed vocabulary already in hand at the deny site, so branch on the
discriminant.

That is what shipped. `admit()` returns the outcome alongside its reason and the
deny site branches on `outcome === "unreachable"`; the reason sentence is still
written per row and is still nobody's discriminator.

### 2.1 The fixture tests, run for this document

`test/crawl/fetch-resources.test.ts` builds real listeners: an assets host, a
third-party host whose robots.txt forbids `/nope/`, and a **dead** host that
resets every connection it takes. The pass is the real pass. Run fresh:

```
✓ robots.txt, per host, fetched once > refuses a disallowed third-party asset and never requests it 1079ms
✓ robots.txt, per host, fetched once > uses the crawl origin's already-loaded robots and asks it for nothing 23ms
✓ robots.txt, per host, fetched once > classes an unreachable third-party robots.txt apart from a forbidding one 31ms
✓ robots.txt, per host, fetched once > keeps `robots_denied` for a file the robots file actually forbade 36ms
✓ robots.txt, per host, fetched once > names the new class in the closed vocabulary the readers share 2ms
Tests  5 passed | 29 skipped (34)
```

The third and fourth are the split. The third asserts the dead host's file gets
`robots_unreachable` and NOT `robots_denied`, that the reason still contains
"unreachable", and — the part that matters most — that **every request that
host received was for `/robots.txt`**: a new class must not become a new
permission. The fourth puts a forbidden file and an unreachable file on **one
crawl** and asserts the two rows carry the two different classes.

### 2.2 The counts, served, on a crawl a real pass produced

That pass leaves its crawl in the dev database, and one of the rows it left —
two resource rows, one on each side of the split, which is the fourth case's own
shape — reads like this through `ApiService.getCrawl`, read for this document.
**That row is itself one of the 33 leftovers a full run leaves behind** (§11), so
the cleanup sweep ledgered at §10.6 would take this citation's re-readability
with it: the tests survive a sweep, this row does not.

```
crawl_res_116d3b7d-cf71-478c-80d3-83bc2630eae5
  resources: {"seen":2,"fetched":0,"failed":2,"skipped":0,
              "robotsDenied":1,"robotsUnreachable":1,"capped":false}
```

**One each, side by side, off a pass that really ran** — and the partition holds
on the same row: `fetched 0 + failed 2 + skipped 0 = seen 2`, with both robots
counts inside `failed`.

That is the property the served block had to keep, and it kept it **by
construction rather than by editing**: `failed`'s predicate is "non-null and not
`ok`", so a new class joined it without being named anywhere. A partition written
as an explicit list of classes would have silently dropped the new one. The
partition test asserts the arithmetic and now also the subset relation:

```
✓ GET /crawls/:id … > counts the resource census off the database, partitioned exactly
✓ crawl_status / crawl_list > answers the resource census and whether the crawl asked for it
```

both green, both transports, each on a fixture carrying a file on each side of
the split plus the zero-block case beside it.

**The seam in this clause, stated rather than left for a reader to find.** Those
two partition tests read their counts off **SEEDED** fixture rows —
`test/api/query.test.ts:637-638` builds `crawlF` with `seedCrawl` and inserts the
resource rows directly, and `mcp.test.ts`'s surface crawl is seeded the same way
— while the half that proves the CLASSES are written correctly is the real pass
in §2.1, on a different crawl. **No single automated test carries the chain from
a real pass through to a served count**; the join above was made by hand, for
this document, by reading `crawl_status` off a crawl §2.1's pass produced. That
is enough for a gate and it is not enough for a suite. **Ledgered: one case that
runs the real pass against the two robots hosts and then asserts the served
`robotsDenied` / `robotsUnreachable` off that same crawl** — one test, and the
clause stops resting on a hand-made join.

---

## 3. The marker's three reasons, and its boundary

`resources.not-recorded` fires when a crawl holds **no resource rows at all**. It
deliberately does not fire when the rows exist and were merely never asked about
— an operator's `fetchResources: false` — because that crawl DID record what it
saw. Phase 11 ruled that widening the existing marker would be a verdict change
and that the honest form is a SIBLING, on the `host.probe-skipped` model.

`resources.not-fetched` is that sibling. It fires when the crawl SAW resources
and DECIDED none of them, and it names WHY off the rows themselves:

```ts
export const NOT_FETCHED_REASON = {
  off: "fetch-off",
  notRun: "pass-not-run",
  cap: "budget-cap",
} as const;
```

The ledger foresaw two reasons. The third arrived through a review, and the story
is §3.2.

### 3.1 The three reasons and four silences, run for this document

```
✓ resources.not-fetched > reports the operator's off switch, with the reason and the two counts 29ms
✓ resources.not-fetched > reports a pass that never asked at all as the other reason 12ms
✓ resources.not-fetched > recognises a budget that claimed every row before anything was asked 12ms
✓ resources.not-fetched > is silent as soon as one row was decided, however many were not 12ms
✓ resources.not-fetched > is silent on a normal completed pass 11ms
✓ resources.not-fetched > is silent on a crawl that recorded no resources at all 7ms
✓ resources.not-fetched > refuses to guess when the unfetched rows are a mixture 13ms
Tests  7 passed | 27 skipped (34)
```

Reading the seven in order: `fetch-off` on a crawl whose every row carries
`RESOURCE_OFF_REASON`; `pass-not-run` on a crawl whose rows carry no reason at
all; `budget-cap` on a crawl whose every row carries `RESOURCE_CAP_REASON`; then
silence on a PARTIAL pass (one row decided is a pass that measured), silence on a
complete pass, silence on the sibling's own crawl, and a throw on a mixture.

**The exclusivity is arithmetic, and one test drives both markers:**

```
✓ the two markers are mutually exclusive by construction >
    the off-switch crawl gets the sibling, the pre-0013 crawl gets the original 35ms
```

Two crawls, four assertions: each marker fires on its own crawl and is silent on
the other's. They cannot both fire because one requires `resourcesSeen == 0` and
the other requires `resourcesSeen > 0`. That is not a rule anybody has to
maintain; it is a complement over one number.

The **not-recorded boundary** the plan asked about is the same test read from the
other side, and it also closed a window Phase 11 had pinned open: the reasoning
test `stays silent when the operator turned the pass off — its sibling speaks`
keeps its original assertions and now adds the two that say who does speak.

### 3.2 The throw, and the docblock that proved the wrong thing

The rule throws when the undecided rows carry a **mixture** of reasons. That is
a house rule — a failed rule run is a loud error, not an empty findings list —
and it is narrower than it was, for a reason worth the record.

As first shipped, the rule recognised two reasons and threw on anything else,
and its docblock argued that the wholly-capped crawl could not arise:

> A cap stamps `RESOURCE_CAP_REASON` only after the pass has asked about
> something (`admit` returns `capped` only once the budget is spent) …

**That mechanism does not exist.** The review checked it in the source rather
than accepting it: `admit()` caps on the number of HOSTS, never on the budget,
and writes its reason inline per row. The resource BUDGET is claimed at the top
of a batch — `if (budget < batch.length) { slice = batch.slice(0, budget);
cappedByResources = true; }` — **before any of that slice is asked about**. And
the closing cap-stamping `UPDATE` had no abort guard, contradicting its own
comment, so an abort landing inside a capped batch on a crawl with a small
`maxResources` stamped every undecided row `resource-cap`. The rule would then
have thrown with a message claiming the rows disagreed when they agreed
perfectly, and a throw inside a rule run makes the whole crawl unjudgeable.

Three fixes, in the three places the defect actually lived:

1. **The pass got the abort guard its own comment promised** —
   `if (cappedByResources && !aborted)`. Two documents already said an abort
   marks nothing; this is a defect against a written contract, not a new policy.
   Red first:
   ```
   ✓ a cancel stops the pass where it stands > marks nothing when the abort lands inside a capped batch 20ms
   ```
   (green now; its red run read
   `http://…/abort-2.png: expected 'resource-cap' to be null`, quoted from
   T2's report on `6bf59ef`.)
2. **The rule learned the third reason**, off `RESOURCE_CAP_REASON` — the pass's
   own constant, never a re-derived literal. The argument for keeping it after
   fix (1) removed the producer: the rule reads a TABLE, not a pass, and a rule
   that met the shape and threw would produce exactly the silence this marker
   exists to end.
3. **The docblock now names the three writers and what each really does**,
   instead of a mechanism that was never there.

The throw that remains says what it means: "the unfetched rows carry a mixture of
reasons — N say 'resource-fetch-off', N say 'resource-cap', N say nothing at all
… No writer of ours produces a mixture: each stamps every undecided row or none."

### 3.3 The bump, and the two grounds that earned it

`RULESET_VERSION` `0.8.0` → `0.9.0`, once, in T2's commit, with the comment
naming **both** grounds — because the constant stamps more than a verdict.
`rules_catalog` serves the COPY stamped with it, so text a client reads is part
of what a version identifies:

1. `resources.not-fetched` — a marker a crawl could not receive before, additive
   by construction, never a widened `resources.not-recorded`.
2. `resources.broken` and `resources.uncached`'s explanations, which T1 rewrote
   to name the `robots_unreachable` class. The verdicts did not move; what the
   ruleset SAYS did.

The second ground is there because T1's review caught T1's own reasoning for
holding the bump — "cannot change a verdict on any stored crawl" — as
incomplete, and made naming the copy clause a binding condition on T2. T4 later
added a third ground in the same comment (`render.coverage`'s new field and its
copy) without a second bump: **one bump per phase**, argued beside the pin in
`test/rules/registry.test.ts`.

The arithmetic, verified: **93 rules = 26 page + 53 query + 14 metric**, up one
from 92; the claimed-check universe unmoved at 47; unclaimed checks 0. The four
checklist entries CHECK-48/49/50/51 were forced by the marker guard, which went
red naming each one by name.

---

## 4. Resume, end to end

`resumeCrawl(db, crawlId, opts)` was never the gap. The API's queue runner has
called it for every crawl it starts since Phase 6 — the row exists before the
run, so a "start" is a resume of an empty frontier — and the loop tests have
covered continuation after an abort and after a hard kill since Phase 1. The gap
was reachability: nothing on either transport could ask for it, so a Talos-driven
deployment whose worker died had no move except re-crawling, which is the
expensive and impolite one.

So the task added no runner and no run path. The service method vets the request,
moves the row to `queued`, and pushes into the same FIFO `startCrawl` uses.

### 4.1 The finding: the ratchet did not survive a resume

**This is the phase's surprise and its most important fix.**

`runToCompletion` built its gate from the config and robots alone:

```ts
const gate = new HostGate({
  perHostDelayMs: config.perHostDelayMs,
  robotsCrawlDelaySec: discovery.robots.crawlDelaySec,
});
```

`crawls.host_spacing_ms` — the widest spacing the crawl's gate ever reached,
which is `max(perHostDelayMs, robots Crawl-delay)` on a crawl that never
escalated and something larger on one **a host pushed back against** — was never
read. And the next thing `runToCompletion` does is `recordSpacing()`, which writes
`gate.maxSpacingMs()` to that same column. So a resumed crawl did two wrong
things at once: it went back to hitting a host at the pace that host had already
refused (hard rule 9), and it **overwrote the evidence** with the configured
floor, so the regression was invisible from `crawl_status` too.

Phase 6 had already made this exact ruling for the RENDER pass —
`renderPaceMs(cfg.perHostDelayMs, crawls.host_spacing_ms)`, on the argument that
"`host_spacing_ms` is a finding, not a setting … a later pass over the same host
has no right to forget it". The crawl pass that EARNED the number never got the
same treatment.

Red run, quoted from T3's report on `d69f4cf`:

```
FAIL test/crawl/loop.test.ts > resumeCrawl >
     resumes at the spacing the crawl earned, not the one it was configured with
AssertionError: expected 0 to be greater than or equal to 250
```

Zero. Not "lower than it should be" — the gate was reporting no earned spacing at
all, because it had just written the floor over it.

The fix puts the policy in the module that owns spacing rather than at a call
site. `HostGateOptions` gains `earnedSpacingMs`, folded into the constructor's
existing max under the same 30-second cap:

```ts
this.delayMs = Math.min(
  maxDelayMs,
  Math.max(opts.perHostDelayMs, (opts.robotsCrawlDelaySec ?? 0) * 1000,
           opts.earnedSpacingMs ?? 0),
);
```

`runToCompletion` reads the column back through a `storedSpacingMs` helper that
**throws on a missing row** rather than returning null — a deleted row must not
be reported as "no spacing earned". On a fresh crawl the column is null and
nothing about `runCrawl` changes.

Committed separately as `d69f4cf`, ahead of the tool, because it is a behaviour
defect that predates and outlives `crawl_resume`: it applied to every caller of
`resumeCrawl`, including the gate scripts and the Phase 11 recovery run.

Green now, run for this document:

```
✓ test/crawl/loop.test.ts > resumeCrawl > resumes at the spacing the crawl earned, not the one it was configured with 1912ms
✓ test/crawl/politeness.test.ts > HostGate > folds the spacing an earlier run earned into the crawl's base 2ms
✓ test/crawl/politeness.test.ts > HostGate > refuses an earned spacing that is not a number of milliseconds 1ms
✓ test/crawl/politeness.test.ts > HostGate escalation > a success resets the streak's progress but not the spacing earned 1ms
```

**Two consequences, stated rather than discovered later.** The column is ONE
number for the whole crawl — the widest any host reached — so a resume applies
that width to every host it touches, including hosts that never pushed back: a
crawl whose CDN earned 8 s while the origin stayed at 1 s resumes with the origin
at 8 s. And the fold only RAISES, so a robots `Crawl-delay` the site has since
removed stays sticky across every resume of that crawl, and no config change can
lower spacing on a resume. Both fail in the polite direction; the escape is a
fresh crawl, which has no column to read. A per-host column is a Phase 13
candidate (§10).

### 4.2 The crown: killed, resumed by a different server, equal to its control

`test/api/http.test.ts` — "a killed crawl resumed over the wire reaches the
totals of a control that was never killed".

The fixture site exists for this test: the other API fixture sites reference no
files at all, so a kill against them could only leave FRONTIER work, which is
half of what a resume must finish. This one serves three pages carrying **24**
images, each answered after 120 ms, so the resource pass runs for seconds and can
genuinely be interrupted.

The shape, and every part of it is load-bearing:

- a **control** crawl of the same site, never interrupted;
- the same crawl started on a **second API server** on the same database;
- polled until `resources.fetched >= 1` with `seen == 24` asserted and
  `fetched < 24` asserted — so the kill window is PROVEN to be mid-pass rather
  than assumed;
- that server `close()`d — the graceful abort path, which is exactly what
  interrupted Phase 11's own gate crawl;
- the row asserted `cancelled` with `resources.skipped > 0` — the nulls an abort
  leaves are not a failure state, they are the questions nobody has answered;
- `host_spacing_ms` set to 50 on the killed row, because the fixture site never
  blocks and the column is the only record a ratchet has;
- and then **a different server** resumes it over the wire. The process that ran
  the crawl is gone. That is the property that matters.

The equality is one assertion — `expect(b).toEqual(a)` over pages, `pages` rows,
the whole resource census and the findings count after both crawls are judged —
and then each figure is named separately so a failure says which number moved:

```
pages 3   ·   resources.seen 24   ·   resources.fetched 24   ·   resources.skipped 0
findings > 0
```

The measured pair, recorded by T3 on `0bbfee5`:

```
control = {"pagesCrawled":3,"pages":3,
           "resources":{"seen":24,"fetched":24,"failed":0,"skipped":0,
                        "robotsDenied":0,"robotsUnreachable":0,"capped":false},
           "findings":23}
resumed = {…identical…}
```

The equality is not an equality of zeroes, and the assertions in the tree say so
by pinning the three counts that could have been.

**The ratchet across the kill** is asserted in the same test: after the resume,
`crawl_status.hostSpacingMs` must be **≥ 50**. Before `d69f4cf` it read 0.

The MCP half runs the same kill and resume against its own copy of the fixture,
asserts completion and the ratchet, and pins the answer shape
`{crawlId, status: "queued", queuePosition: 0}`. Run for this document:

```
✓ crawl_resume > finishes a crawl a server was killed in the middle of, and keeps its earned spacing 1568ms
✓ test/api/http.test.ts > POST /crawls/:id/resume > a killed crawl resumed over the wire reaches the totals of a control that was never killed 8241ms
```

### 4.3 The refusal taxonomy

Six refusals, in authority order, and the order is load-bearing: the free
in-process check runs first, then the allowlist, so a host nobody permitted is
refused before a DNS round trip is spent on it.

| refusal | code | proved by |
|---|---|---|
| no such crawl | 404 | `http.test.ts` "404s a crawl id nobody has"; `mcp.test.ts` "refuses a crawl id nobody has" |
| this server already holds it | 409 | both — a live crawl started and immediately resumed |
| a live worker holds unexpired leases | 409 | both — a seeded row with `leased_until` 60 s in the future |
| settled, nothing owed | 409 | both — the message names all three places it looked |
| … the off switch is not owed work | 409 | `http.test.ts` "does not read an off switch as resumable work, and says which it is" |
| … `render_pending` is the render pass's work | 409 | `http.test.ts` "names render_pending rows as the render pass's work, not a resume's" |
| the stored site has left the allowlist | 403 | both — the refusal names the host |
| the state changed under the call | 409 | `http.test.ts` — §4.4 |
| a body nobody asked for | 400 | `http.test.ts` |
| no bearer token | 401 | `http.test.ts` |

All nineteen cases, run for this document:

```
Test Files  1 passed (1)      test/api/http.test.ts  > POST /crawls/:id/resume
     Tests  12 passed | 91 skipped (103)
Test Files  1 passed (1)      test/api/mcp.test.ts   > crawl_resume
     Tests  7 passed | 95 skipped (102)
```

**What "owed work" means is not a second definition.** `leaseBatch`'s predicate
— `state = 'pending' or (state = 'leased' and leased_until < now())` — IS the
definition of resumable frontier work, and `owedWork` asks that predicate as a
question rather than inventing a parallel one. `render_pending` rows are not in
it, which is why they get their own refusal pointing at `crawl_render`: they look
like unfinished work to an operator and are not resumable by this path. The
resource pass's work list is `fetch_class is null`, which includes the rows of a
`fetchResources: false` crawl — so that count is zeroed when the pass is off, and
the refusal says which it is. Otherwise a resume would be accepted for work that
provably will not happen.

**One finding about the tests themselves, recorded because it is the kind that
turns a suite into decoration.** Two MCP refusal tests were originally seeded on
a host that was not on the allowlist, so they were refused by the FIRST check and
could never reach the guard they were written for. They passed, and they proved
nothing. A local `seedResumable` helper now seeds an allowlisted row with a
readable config, and each refusal test reaches its own refusal.

### 4.4 The compare-and-swap that was written and discarded

The service method swaps the crawl's status to `queued` conditioned on the status
it read. It did not read `rowCount`. On a zero-row update it pushed the entry,
pumped the queue, and answered `{status: "queued"}` about a row that said
something else entirely — this process would run a crawl another process may
already be running, and the caller would have been told it was accepted.

That is a silent no-op under hard rule 7, and it is precisely the trap the
`markCrawlFailed` comment the code itself cites was written to avoid. `rowCount`
is now read: `null` throws (an update that will not say how many rows it touched
leaves "did this server claim the crawl" unknown), and `0` is a 409 naming that
the crawl's state changed under the call and that nothing was queued.

**The test has to stand inside the window, and the obvious version cannot.**
Moving the row before the request does not fail the CAS: the method reads the
status it then conditions on, so a row that was already `failed` matches its own
swap and is accepted. The window that matters is strictly between the method's
SELECTs and its UPDATE, and no caller outside the process can stand there. So the
test builds a server over a `Proxy` of the real `Db` whose `execute` fires once
and then delegates — `owedWork`'s `execute` being the last statement inside that
window. Nothing is stubbed; the code under test is the real path.

```
✓ POST /crawls/:id/resume > 409s when the crawl's state changes under the call, rather than queueing anyway 68ms
```

Red first, quoted from T3's report on `4d6b0d8`: `expected 202 to be 409`.

The CAS also narrows — it does not close — the case where two Ariadne processes
resume the same orphaned `queued` crawl. The loser is now refused if it touches
the status; a process that never writes the status is not a shape this codebase
has. The residual is the pre-tenancy posture, which already carries the same risk
for `crawl_start`; `crawl_resume` does not widen it, it makes it easier to reach.
And the swap conditions on `status` only: it is not a general row lock, and
nobody should read it as one.

### 4.5 The stale judgement: the honesty seam a resume was leaving open

The crawl skill RECOMMENDS the sequence cancel → `crawl_rules` →
`crawl_resume` → finish. Before this fix, a resume left `rulesRunAt` standing.

That is a failure of the single most important sentence on the whole surface.
`talos-surface.md` §5: *empty is never a verdict; `crawl_status.rulesRunAt` is
the check.* A resumed crawl carrying a completed judgement stamp would serve
`findingsCount` beside a larger `pagesScanned` while the count described a
strictly smaller crawl — and `crawl_compare` inherits it silently, because it
believes both sides were judged.

`rulesRunAt: null` now joins the same `.set({status: "queued", finishedAt: null})`
that the resume already performed. `finishedAt`'s own stated argument covers it
exactly: the row must not say two things that cannot both be true. The findings
ROWS are deliberately left in place — they then read as a pass nobody completed,
a state the surface already documents and which `crawl_rules` overwrites on the
next judge.

```
✓ POST /crawls/:id/resume > unjudges a crawl it queues, so no timestamp outlives the pages it described 4316ms
```

Red first, quoted from T3's report on `4d6b0d8`:
`expected '2026-09-02T12:30:59.535Z' to be null`.

The test judges a `cancelled` crawl with owed work **through the surface** — so
the marker under test is the one a real pass writes — asserts null immediately
(there is no window in which a poller sees a queued crawl wearing a completed
judgement), and asserts null again after the resumed run settles, since only
`crawl_rules` ever sets it.

**What a resume costs, said on the surface rather than discovered.** A resume
re-reads discovery and re-probes hosts every time, deliberately: a crawl resumed
hours later must honour the rules as they are now, not as they were. The resource
budget is a per-run budget, so resuming a crawl that hit its cap re-grants the
whole budget — the tool description names the observable (`resources.capped`)
rather than the operator-configured knobs, because an agent does not have those
knobs and naming them would describe a control it cannot reach.

---

## 5. The honesty sweep

Two items that were not owed by §14 but belong to the same discipline.

### 5.1 `render.coverage` says whether a pass ran

Phase 11's audit read this row off a crawl that had never been opened in a
browser:

```
{pagesRendered: 0, selectionMode: "auto", selectionBudget: 28,
 selectionSampled: 18, selectionSelected: 18}
```

The four `selection*` numbers have no column — they are RECOMPUTED from the
crawl's rows — so they answer identically on a crawl rendered last week and on
one nobody has ever rendered. `selectionSelected: 18` reads as a record of
eighteen pages somebody chose, and it is not one. `pagesRendered: 0` cannot carry
the correction, because **a pass that ran and rendered nothing writes the same
zero**.

Two obvious fixes were rejected with reasons. A `render_selected_at` column would
answer outright, but it would be null for every crawl that exists today —
reintroducing the ambiguity on exactly the crawls a reader cares about — and a
migration 0015 in the honesty task would falsify three documents to fix one
field. Nulling the four numbers is worse: an agent deciding whether to SPEND a
render pass reads exactly those numbers, and blanking them spends the doctrine's
null on a question that does apply.

What shipped is one field, `renderPassEvidence: "ran" | "none"`, where every
disjunct of `"ran"` is something a render pass WROTE: a page row with
`rendered = true`, a page row with a `render_error`, a non-null
`render_urls_jsonb`, `render_pass_count > 0`, or **a frontier row still
`render_pending`** — the last being the only trace anywhere of a pass that
aborted before its first completed render.

`"none"` is a claim about our records and not about history, which is why the
value is `none` and not `false`. There is exactly one shape it gets wrong, and it
is stated in the module docblock, in the copy and in `talos-surface.md` §13: an
automatic pass that selected ZERO pages ran, promoted nothing, rendered nothing
and stamped 0, and is reported `none`. On that crawl the projection and the
record are the same zeroes, so nothing a reader takes from the row is false.

Read off the Phase 11 gate crawl, read-only, by T4 on `2d8556f`:

```
crawl_f0fc5096… → {"pagesCrawled":557,"renderPassEvidence":"none",
 "selectionMode":"auto","selectionBudget":28,"selectionSuspects":0,
 "selectionSampled":18,"selectionSelected":18,"selectionTruncated":false,
 "pagesRendered":0,"renderFailures":0}
```

Budget 28, sampled 18, selected 18 — `phase-11.md` §6.3's numbers verbatim, now
with the word that says what they are. That crawl still holds its 98 metric rows;
the rule was called directly and wrote nothing (§1.2's diff covers it).

Three documents had been calling `renderPassCount` "a boolean gate on whether a
render pass happened" — the audit checklist, the crawl skill, and `pages_query`'s
MCP description. All three were the same false claim, since 0 is ambiguous, and
all three now point at `renderPassEvidence`.

### 5.2 The citation guard's third form

`docs/talos-surface.md` is the document Talos codes against, and Phase 11 gave it
a guard: a citation must ANCHOR on an `it()`/`describe()` declaration line, ATTEST
it with a verbatim fragment of that test's own title, and IDENTIFY exactly one
test in the file. That covers the test citations. Phase 12 asked whether the same
treatment should extend to the document's `src/` references.

**The premise needed correcting first.** The document does not cite `src/` lines
at all: every source reference is a FILE reference with no line number. So the
rot the test guard exists to catch cannot occur there, and the question is what
SHOULD be checked rather than what needs repairing.

**And the anchor rule cannot simply be extended.** It rests on one fact about
test files — a citation names a DECLARATION whose title the document quotes
back, verbatim and uniquely. `src/` has no such thing: a line of `service.ts`
opens no named block and its neighbours are indistinguishable from it. The
nearest equivalent, quoting the line's own text, would pin the document to code
FORMATTING, so a rewrapped argument list would fail a guard meant to catch
drift from behaviour.

But "cannot carry that property" is not "carries none". Some references are
architectural claims no grep can settle; others are PINS in a fixed form —
"Pinned: `src/db/schema.ts`'s `resources.fetch_class` comment" — naming a file
AND an identifier inside it. So the third guard checks three properties:

1. **Existence** — the file is there. The only rot mode a line-less reference
   has.
2. **No line numbers** — a source citation carrying one is **refused outright**,
   because nothing here can check it: it would resolve forever, drift silently,
   and carry the confident look of a pin. Cite the file and name the artefact in
   words.
3. **Attestation where the document makes one** — an identifier quoted in the
   adjacent window must appear in the file, matched on the last dotted segment so
   `crawls.resource_refs_capped_pages` finds what Postgres spells.

**The guard is tested on its own input**, which the second guard is not: a
synthetic document with a missing file, a line number and an absent identifier
produces exactly three failures, and the pin form the document actually uses
produces none. Without that pair, a broken extractor and a clean document look
identical.

It caught its first drift inside its own commit: the sentence explaining the rule
used a literal line-numbered source citation as an example, and the suite went
red. The example is now described rather than shown.

```
✓ the surface document's src/ references name what they claim > names source files that exist, without line numbers, attesting what it pins
✓ … > fails a missing file, a line number and an identifier the file does not carry
✓ … > accepts the pin form the document actually uses
✓ … > reads something: the source-reference extraction is not silently empty
```

**Stated limit, in the guard's header:** it cannot read the sentence. A pin
naming a real identifier in a real file, beside a claim that comment does not
make, passes. What it removes is the class where the document is honest and the
pointer is wrong.

Across this phase the citation guard also did its ordinary work loudly. Inserting
a test above a citation moves it, and the guard said so every time:

| pass | citations re-anchored |
|---|---|
| T1 | 73 (and 0 more after its fix round) |
| T2 | 7, then 1 more in its fix round |
| T3 | 35, then 25 more in its fix round |
| T4 | 27, then 5 more in its fix round |
| **total** | **173** |

Every one was resolved by its quoted title fragment rather than by offset
arithmetic — the guard's own rule, applied mechanically. Two of T3's had landed
on the wrong test entirely, and the guard is what said so.

---

## 6. How this phase's tests were proved — the honest accounting

The watch item the controller carries from phase to phase is "which tasks were
red-first". The answer is in each task's own report, and the exceptions are named
rather than smoothed.

| task | proof style | evidence, and what is NOT claimed |
|---|---|---|
| T1 (the counter, the split) | **red-first, eight interfaces** | one red run per interface before the implementation: `expected undefined to be true` on the analyzer flag, `Cannot convert undefined or null to object` on migration 0014, `expected 2 to be 3` on the unknown bucket, and five more. **One exception, stated in the report:** the resume-arithmetic test was written AFTER the stamp existed — a property test over code the other cases already covered |
| T2 (the marker) | **red-first, four ways** | 11 failures all reading `no rule 'resources.not-fetched' in resourceRules`; the forced registry/coverage/copy pins; the version pin red as `expected '0.8.0' to be '0.9.0'`; and the marker guard red naming all four of CHECK-48/49/50/51 in one run, each as its own failure line. The fix round's abort guard was red-first too (`expected 'resource-cap' to be null`) |
| T3 (the wire) | **red-first, including the bug it found** | the ratchet red at `expected 0 to be greater than or equal to 250` before `d69f4cf`; both review items red before their fixes (`expected 202 to be 409`, `expected '…535Z' to be null`). **And an honest negative:** two MCP refusal tests as first written could not reach the guard they tested — found, named, fixed |
| T4 (the sweep) | **red-first per claim** | 11 of 19 tests in `render-metrics.test.ts` red before the metric existed; the third guard tested against a synthetic bad document. Its fix round added no test at all — every item was a stated fact that was not one |
| T5 (this document) | **measurement, not construction** | this task wrote no test and changed no behaviour. Every number here was either measured for this document or is attributed to a named report and commit |

**The distinction this phase leaned on, restated:** a test that goes red because
the module does not exist proves the file binds to the module. A test that goes
red because one guard was undone proves that test binds that guard. Neither
proves the assertion was typed before the line it checks. Where a task can only
claim the weaker thing, its report says so, and this table does not upgrade it.

---

## 7. The two plan-proposed decisions — PROPOSED, AND RULED AT INTEGRATION

**Ruling (owner, 2026-09-02, at Phase 12 integration): BOTH CONFIRMED.** The
wall-time designs stay not-taken (revisit on demand) and the tenancy posture
stays as stated. The section below is the record as it stood when the window
was open; the annotations in `phase-11.md` §14 now carry the ruling.

Two items on `phase-11.md` §14 are decisions rather than work, and their
provenance matters more than their content.

**They are the Phase 12 PLAN's proposals.** They were written into the plan,
carried through the phase, and annotated onto the §14 ledger by T4 — with the
owner's veto window OPEN. They are not the owner's reasoning and this document
does not present them as such. The window closes when the phase is presented at
integration; until then the honest word is *proposed and unvetoed*, and that is
the word the annotations use. (T4's first draft said "the owner's reasoning" for
both; its reviewer caught it as M-6. **A provenance document overstating
provenance is the same class of defect as every other item this phase fixed**,
and it is recorded here for the same reason.)

**Item 5 — the wall-time question: NOT TAKEN, revisit on demand.** Phase 11
measured the resource pass at 4.65× the wall clock of a page-only crawl and named
two honest ways to shorten it. Both are refused for now:

- *A separate, faster floor for HEAD-only asset requests* is a change to our
  politeness POSTURE, not a tuning knob. It asks a site's server for more
  requests per second than the crawl itself was willing to make, on the argument
  that a HEAD is cheaper — which is **our inference about their infrastructure
  and not their statement about it** (hard rule 9, and the yellow.com.mt incident
  in `docs/talos-integration.md`). The 4.65× was measured, priced, and accepted
  as the cost of asking politely.
- *Asking only about the files some rule would judge* narrows the census to
  today's rules and makes tomorrow's rule unanswerable over yesterday's crawl.
  That is the evidence-layer boundary this engine is built on.

Neither is refused forever: an operator who says "this site can take it" is a
different input from an engine that assumes it, and the day that input exists on
the surface the question re-opens with the data to settle it.

**Item 7 — tenancy on `crawl_list`: unchanged, and stated rather than closed.**
Nothing this phase narrowed it and nothing widened it. The posture is a
deployment fact — one tenant per deployment, `talos-surface.md` §9.3 — and the
phase that makes Ariadne multi-tenant is the phase that ends it. §4.4's residual
(two processes resuming one orphan) is a consequence of that same posture and is
recorded under it rather than presented as a new risk.

Both annotations live in `phase-11.md` §14. **Annotating a forward pointer list
is the sanctioned edit class**, and the precedent is `phase-8.md:825`, where item
7 is struck through and marked "CLOSED in the final-review fix wave". No measured
number in that document moves. (T4's first draft cited a Phase 10 strikethrough
that does not exist; its reviewer found it and the citation is now the real one.)

---

## 8. Watch items for CI

The two Phase 11 flakes are **still open**, and the sample is honestly small.

Checked for this document, `gh run list --branch main --limit 20`:

- **Every run on `main` in the repository's history is `success` — 12 of 12.**
- **The only run on `main` carrying Phase 11 is its own merge run** — run
  `33612036039`, 3m47s, 2026-09-02T09:03:33Z, success. Nothing has landed on
  `main` since, so that run is the whole post-Phase-11 sample.
- Neither watch item appeared in it.

**One data point is not a sweep**, so the accurate sentence is: *the two Phase 11
CI watch items have not recurred over one post-merge run on main, and the watch
stays open on that evidence rather than closing on it.* Phase 12's own PR run is
the next data point. Both carry forward unchanged:

1. **One unattributed full-suite failure (P11-T3).** 0 of 9 reproductions there,
   0 in this phase's runs. The plausible cause remains the probe harness —
   in-place source mutation under live vitest workers — which is a property of
   the method rather than of shipped code, but nothing proves it.
2. **`test/crawl/run.test.ts` timing (P11-T2).** The resource pass lengthened
   that file's harness; it retries 4×. It has not flaked in any run this phase,
   and CI on a slower machine is where it would say otherwise.

---

## 9. Carried minors, restated

Nothing here blocks integration; all of it would otherwise be lost.

| id | what | where it stands |
|---|---|---|
| T1 §8.2 | `resourceRefsCappedPages` counts pages the writer was HANDED, not rows inserted — it can legitimately exceed `pagesCrawled` | stated on all four served surfaces as an instruction: render it as a count, never as a ratio |
| T1 §8.3 | the analyzer flag means "at least one reference was dropped **unexamined**" — the cap check precedes the URL resolve, so a 2,001st reference duplicating the first raises it | deliberate and priced (a URL parse per reference on exactly the pathological pages the cap exists for); the copy on five surfaces says "references", not "files", and "MAY BE a floor" |
| T1 §8.6 | `crawls` now has three nullable columns whose null means "nobody counted" and nothing ties them together | each says so in its own comment; worth a type if a fourth arrives |
| T2 §7.4 | the marker guard's `MARKERS` list and CHECK-83's family list are both hand-enumerated | the seventh marker cost exactly the three edits P11-T4 predicted; the payment is recorded in the guard's own header as evidence for a registry flag (§10) |
| T2 §7.5 | `notAsked` duplicates in prose what `reason` says as a class | kept on the `host.probe-skipped` precedent: a reader meeting the finding in a listing should not have to look up what `budget-cap` means |
| T3 §6.4 | two API fixture files now carry a near-identical slow-asset site | duplication chosen because the suites deliberately share nothing; a third copy is the moment to extract |
| T3 (round 1) | the CAS conditions on `status` only | right scope — status is where crawl ownership is expressed — but it is not a general row lock |
| T4 §7.1 | two transport pins depend on describe order within their file | accepted: they fail loudly with a named message, the dependency is declared, and self-standing versions would each cost a real render pass |
| T4 §7.2 | `render_pass_count` is an unreachable disjunct today | kept and labelled: `crawl_status` SERVES that number, and two surfaces of one engine must not disagree about one crawl |
| P11 T1 M-4 | `resources.bytes` is an integer; a file over ~2.1 GB would overflow it | noted, unchanged; the counted-GET ceiling is 16 MiB |
| P11 | the docs citation guard | **widened** this phase to `src/` references (§5.2); P11-T4's M-6 closes |

---

## 10. What Phase 13 inherits

In the order they will be met.

1. **The all-unknown crawl — the marker/coverage window this phase STATED
   rather than closed.** A crawl whose every resource row is in an unknown class
   (`refused`, `robots_denied`, `robots_unreachable`, `fetch_error`) has decided
   rows, so no marker fires; and no `ok` row, so no judging rule finds anything.
   Six rules go quiet with nothing to explain the silence — exactly the shape
   `phase-11.md` §10.3 refused to accept one surface over. The discriminator
   exists (`crawl_status.resources`: `fetched` at zero with `failed` carrying the
   census) and is named in the rule's docblock, in `talos-surface.md` §5.3 and in
   five places in the checklist. **Closing it means another marker, which means
   another rule and another bump; this phase's bump was spent.**
   **Owner-promotable**: this is the one pointer here that is a judgement call
   rather than a chore.
2. **A per-host earned-spacing column** (§4.1). `crawls.host_spacing_ms` is one
   number for a whole crawl, so a resume widens every host to the worst host's
   spacing. Strictly the polite direction, and slower than it needs to be. Named
   in three places in the tree as a Phase 13 candidate (`host → earned ms`).
3. **A closed vocabulary for `renderPassEvidence`'s `ran` | `none`** (T4's M-4,
   deferred by its reviewer). The two values are string literals in a type; every
   other closed vocabulary on this surface is a named constant.
4. **A registry flag deriving the marker lists.** The marker guard's `MARKERS`
   map and CHECK-83's NOT MEASURED family list are hand-written, and only the
   first is enforced by anything. Two phases have now paid the three-edit toll
   and predicted it correctly, which is evidence, not a reason to keep it.
5. **`robots_unreachable` rows are never retried.** The pass's work list is the
   null `fetch_class` column and these rows have a class, so only a fresh crawl
   re-asks; a host down for one minute leaves a permanently-classified row on
   that crawl. This is unchanged behaviour — `robots_denied` was always treated
   this way, and `fetchRobots` already retries with backoff before declaring a
   host unreachable — but the split makes it VISIBLE for the first time. A
   pointer, at most, per T1's review.
6. **The crawl-row cleanup sweep** (§11). The suite leaves **33** crawl rows
   behind per full run — measured once for this document (2,708 → 2,741 across
   one full run, nothing else touching the database) and twice before it by
   T4's reviewer. A fact about the suite, not about any operator, and the sweep
   is not written.
7. **Tenancy on `crawl_list`** — unchanged, the stated posture, §7.
8. **The wall-time shortening designs** — not taken, revisit on demand, §7. The
   day an operator's "this site can take it" exists as an input on the surface,
   this re-opens with the data to settle it.
9. **The end-to-end robots-split test ledgered at §2.2.** No single automated
   case carries the chain from a real fetch pass through to the served
   `robotsDenied` / `robotsUnreachable` counts: the partition tests read seeded
   rows, the real pass runs on a different crawl, and §2.2's join between them
   was made by hand for this document. One case — run the pass against the two
   robots hosts, then assert the served counts off that same crawl — retires
   the hand-made join. **Not written here on purpose**: a new crawl-creating
   test moves the 33-rows-per-run figure §11 just pinned, so it belongs beside
   pointer 6's sweep.

---

## 11. Verification

Run in this worktree, on the tree at the gate commit.

| | |
|---|---|
| Suite | **1,765 tests / 71 files, all passing** — four full runs this task: **130.7 s, 133.8 s, 130.2 s, 138.0 s**. The last ran over the tree at the gate commit apart from this document itself, which nothing in the suite reads: gate documents are outside the citation guard's scope by design (`phase-11.md` §8.3) |
| Typecheck | `npx tsc --noEmit` clean |
| Migrations | 0000–**0014**; 0014 is the last, and no DDL changed after T1 |
| Ruleset | **0.9.0**, **93 rules** (92 at Phase 11) = 26 page + 53 query + 14 metric |
| Checklist | 83 checks; the coverage query green — the 47 crawl-derived checks account as **44 claimed / 3 agent / 0 unclaimed**, unmoved by this phase |
| Guards | the identifier guard, the citation guard, the citation guard's new `src/` form, the marker guard and the copy contracts — all green over every edit |
| Tree | clean at each commit; no crawl data committed — the database holds it |
| Surface | 16 MCP tools / 16 HTTP routes (15 each at Phase 11) |
| `rules_catalog` | **103,679 bytes** at 93 rows, re-measured for this document (T2 left the figure at 92 rows and handed the re-measurement here) |

**The kept crawls are untouched.** Snapshotted before this task's suite runs, two
full runs later, snapshotted again, `diff`ed: **identical**, including every
jsonb digest and all six child counts per crawl (§1.1, §1.2).

### The leak arithmetic, measured rather than quoted

The suite leaves crawl rows behind. The figure has now been wrong twice in this
repository's own documents, so this is the measurement and the story.

| | rows |
|---|---|
| `crawls` after this task's first full run | **2,708** |
| `crawls` after this task's second full run | **2,741** |
| **delta** | **33 per full run** |

Nothing else touched the database between those two counts.

**33 is the same figure T4's reviewer measured twice**, independently of this
one, and it corrects a number that travelled through three documents. The Phase
11 gate recorded **31 a run**. T1's review measured **192**, and 192 entered the
controller's ledger; T4 quoted the ledger into `talos-surface.md` §13 rather
than measuring; T4's reviewer measured 33, twice, and T4's fix round corrected
the living contract.

The corroboration, in numbers this document can check: `talos-surface.md` §13
records the dev table growing **139 → 1,585 across Phase 11**, which is 1,446
rows. At 33 a run that is about 44 full runs, which is what a phase of this size
costs. At 192 a run it would be **7.5 runs** — not a phase, not even a task. So
the honest history is **31 at Phase 11, 33 now**: Phase 12's Task 1 added
crawl-creating tests and moved it by TWO, not by 161. The 192 was wrong in the
ledger and wrong in the living contract until T4's fix round, and it is not
repeated here.

The sweep itself is still not written (§10.6).

### Commits, in order

| commit | what |
|---|---|
| `f88c826` | the plan |
| `fa2ff90` → `c60ed93` | T1 — migration 0014's counter, the robots split (incl. the controller's plan fix `923614f`) |
| `7d323cf` → `373c224` | T2 — `resources.not-fetched`, ruleset 0.9.0, the abort guard |
| `d69f4cf` | T3 — **the politeness fix**, alone, because it outlives the tool |
| `0bbfee5` → `4d6b0d8` | T3 — `crawl_resume` on the wire, the CAS, the unjudging |
| `2d8556f` → `0135579` | T4 — `renderPassEvidence`, the surface, the `src/` guard |
| *(this task)* | T5 — two stated facts the gate re-measured, and this document |

---

## 12. Integration

**CI: _(placeholder — PR #11, to be filled in when the run reports)_.**

Phase 12 opens PR #11 against `main`. The link, the run id, the duration and the
1,765/71 result belong here, and so does whether either §8 watch item appeared
on a fresh database with migration 0014 applied from nothing.

Merge per the owner's instruction at the time; the last two phases merged on
green.

The two decisions in §7 are presented at that moment, and **that is when their
veto window closes.** Until the owner speaks, they are the plan's proposals and
this document says so.

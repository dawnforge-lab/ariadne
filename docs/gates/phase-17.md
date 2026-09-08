# Phase 17 gate — the marker section, and the second look at a 5xx

Phase 15 handed over a short ledger and one new instrument: a page that points
the engine at a real site. Phase 16 recalibrated severity against it. Phase 17 is
what the owner ordered after reading a real crawl's results on that page — two
follow-ups, both about the same thing, **a finding must not claim more than the
evidence supports**:

- **(A) "Not checked on this crawl."** A NOT MEASURED marker is a fact about the
  crawl, not a defect in the site, and every one of them is `info` — so on a page
  that bands by severity alone they sat under Notices, where a reader counts them
  as things to fix. The rules catalog gains an additive `marker` flag and the
  demo page routes on it into a fourth section. Owner-ordered, built in
  `b2449aa`.
- **(B) The 5xx re-verification pass.** A 5xx seen once during a crawl was
  recorded as a `critical` site issue for life. The severity recalibration
  (`docs/superpowers/specs/2026-09-08-severity-recalibration-design.md` §1, "the
  transient 5xx caveat") deferred this deliberately, because the fix is not a
  severity edit — it is a **second observation**. Phase 17 takes one: migration
  0016, INSERTION 3c, and a rule split at ruleset 0.13.0.

The design is `docs/superpowers/specs/2026-09-08-5xx-recheck-design.md`,
owner-approved before implementation and committed ahead of it.

**What (B) is not**: it is not a severity edit, not an endpoint, and not
optional. A recheck run days later by an agent is measuring a **different site**
while stamping its answer on a crawl whose findings claim to describe one moment,
so the second observation is taken by the crawl that made the first — §3.

The spec's §7 T5 gate clauses, and where each is answered:

| | The spec asked | Answered |
|---|---|---|
| 1 | full suite green | §8 — **recorded 2026-09-08 after T4**: 77 files / 1,877 tests, 0 failures, 132.7 s (orchestrator's own run at d50c2ef, before the rebase onto main). The T5-close reds were the citation guard on a `docs/talos-surface.md` still being rewritten; T4 re-anchored all of them (§12.2) |
| 2 | `npx tsc --noEmit` clean | §8 — **clean**, whole tree |
| 3 | migration 0016 applied by `npm run db:migrate`, never hand-applied | §2 — `drizzle/0016_damp_ironclad.sql`, seven `ALTER TABLE`s; the dev database's journal holds 17 rows (0000–0016) and carries all seven columns |
| 4 | ruleset **0.13.0**, **27 critical / 24 warning / 45 info over 96 rules** | §4 — pinned by `test/rules/registry.test.ts` ("holds 27 critical, 24 warning and 45 info rules") and by `test/rules/coverage.test.ts`'s split (27 page + 55 query + 14 metric) |
| 5 | one recorded crawl showing a `recheck` block with a non-zero `serverErrors`, its partition summing | **recorded 2026-09-08**: `crawl_1580ccf0-c7b6-4668-9d8b-2bc82bd551ce`, `https://httpbin.org/status/503` through the demo proxy (max 5 pages, resources off). Polled every 10 s: `{serverErrors:1, pending:1}` from 10 s to 61 s, then at 71 s `finished` with `{serverErrors:1, confirmed:1, cleared:0, inconclusive:0, pending:0, capped:false, passAt:"2026-09-08T14:58:56.180Z"}` — partition 1+0+0+0 = 1. Rules at 0.13.0: `http.server-error` fired once with evidence `{statusCode:503, recheck:"confirmed", recheckFetchClass:"server_error", recheckStatusCode:503, recheckReason:null, gapSeconds:60}`; `http.server-error-transient` silent. First attempt against `https://httpstat.us/503` closed `failed` at 14 s because that host's robots.txt answers 502 — the robots-unreachable path, reported not hidden. The fixture proof of the same arithmetic is §6 |

---

## 1. (A) "Not checked on this crawl" — the catalog's additive marker

The registry has known which rules are markers since Phase 11: `RuleMeta.marker`
is a non-empty reason string, present on a marker and absent everywhere else,
and `defineRule` refuses a present-but-empty one. **The wire did not know.** A
consumer banding by severity alone files all ten markers under Notices, and the
only alternative was for the consumer to keep its own list of marker ids — a list
that goes stale the next time a marker is added.

So the flag is mirrored, additively:

- `CatalogRule.marker?: string` (`src/api/service.ts`, the `CatalogRule`
  interface) — **present only on a marker**, and then the registry's own reason
  string. Never `null`, never `""`, so `"marker" in rule` and a truthiness test
  agree.
- The catalog builder spreads it rather than assigning it
  (`...(rule.marker === undefined ? {} : { marker: rule.marker })`): assigning
  `marker: undefined` would put the key on all 96 rows and turn "is this a
  marker" into a truthiness question about a sometimes-absent value.
- Mirrored on `GET /rules` and in the MCP `rules_catalog` description
  (`src/api/mcp.ts`), because the two transports serve one catalog.

The page routes on exactly that flag and keeps no list of its own
(`src/demo/index.html`): a fourth `<div id="band-not-checked">` after the three
severity bands, rendered **always** — so "nothing was skipped" is a sentence on
the page rather than an absence a reader has to interpret. Each row reads
`Not measured: <reason>`, `textContent` only, and the page invents no priority:
the three bands remain engine severity and nothing else.

**Ten markers today** — `content.thin-skipped`, `h1.duplicate-skipped`,
`links.orphan-skipped`, `robots.check-skipped`, `host.probe-skipped`,
`resources.not-recorded`, `resources.not-fetched`, `resources.all-unknown`,
`resources.partial-unknown`, and the per-page `crawl.blocked` — and the
count is derived, never listed on the page.

**No eleventh marker was added by (B).** §4 says why that was a ruling and not an
omission.

---

## 2. Migration 0016 — the two observations

`drizzle/0016_damp_ironclad.sql`, generated by drizzle-kit and applied with
`npm run db:migrate`:

```sql
ALTER TABLE "crawls" ADD COLUMN "recheck_pass_at"    timestamp with time zone;
ALTER TABLE "crawls" ADD COLUMN "recheck_pass_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "pages"  ADD COLUMN "fetched_at"          timestamp with time zone;
ALTER TABLE "pages"  ADD COLUMN "recheck_fetch_class" text;
ALTER TABLE "pages"  ADD COLUMN "recheck_status_code" integer;
ALTER TABLE "pages"  ADD COLUMN "recheck_reason"      text;
ALTER TABLE "pages"  ADD COLUMN "recheck_at"          timestamp with time zone;
```

`src/db/schema.ts:558` (`fetchedAt`), `:591`–`:603` (the four recheck columns),
`:195`/`:208` (the two crawl columns).

**Columns on `pages`, not a side table**, and the decisive argument is the rule
contract: `PageRecord = typeof pages.$inferSelect`, and a page rule's body
receives that row and nothing else. `http.server-error` is a page rule and had to
stay one — a side table would have forced it to become a query rule with SQL of
its own, for a fact that is one-to-one with a page row, and would have needed a
unique index on `(crawl_id, page_id)` to say what a column says for free.

**The first observation is never rewritten** (§2.2 of the design). The pass
writes the four `recheck_*` columns and nothing else. Two reasons, either
sufficient:

1. `fetch_class` is the census every cohort in this engine is cut from —
   `isAuditable`, the partial duplicate indexes whose predicates spell
   `fetch_class = 'ok'`, `blockedPages`, `site.health`, the render selection, the
   CSV views. Flipping a row retroactively moves a page into cohorts it was never
   measured in.
2. A row flipped to `ok` would be an **always-passes hole** (hard rule 1): the
   recheck does not analyze the body, so it would be an `ok` page with a null
   `word_count`, no title, no links and no simhash — silently exempt from most of
   the ruleset while looking healthy.

**The null contract**, stated in the schema and enforced by test:

| `recheck_fetch_class` | `recheck_reason` | meaning |
|---|---|---|
| NULL | NULL | **nobody asked** — no pass covered this row |
| NULL | non-null | **the pass decided not to ask, and says why** (`recheck-cap`) |
| non-null | either | **a second observation was taken** — or a request was refused by our own policy or robots, which is `disallowed` plus a reason: a refusal is a decided outcome, not an absence |

The invariant `recheck_at IS NULL ⟺ recheck_fetch_class IS NULL` is asserted over
the whole table in `test/db/migration-0016.test.ts` ("holds recheck_at IS NULL
<=> recheck_fetch_class IS NULL over the table").

`fetched_at` is in this migration because **the evidence must carry the gap
between the two observations, and a gap needs two timestamps**. It is stamped by
`PageWriter` on the hot path (`src/crawl/persist.ts:642`), which is why the
migration test drives a real crawl rather than inserting rows: a hand-written row
would still pass with the stamp deleted.

`crawls.recheck_pass_at` beside a `NOT NULL DEFAULT 0` counter is the
`render_pass_count` pair with its trap intact: a `0` count reads the same on
"rechecked nothing" and "nobody looked", and the null time beside it is what
tells them apart. On a crawl with zero 5xx rows the two answers differ, and that
difference is the honest distinction between "no server errors" and "nobody
looked".

---

## 3. The pass — INSERTION 3c

`src/crawl/recheck/recheck-server-errors.ts`, hooked into `runToCompletion` at
`src/crawl/loop.ts:1441` — between the known-404 probe (INSERTION 3) and the
resource fetch pass (INSERTION 3b), and lettered like 3b for 3b's reason: the
markers are positional and INSERTION 4 is cited by name elsewhere.

**Why there, in one sentence each:**

- It is a **page-phase question** — one more request to the origin, about the
  pages we just fetched. The same argument that puts the 404 probe after the
  loop.
- **Before the resource pass**, because running after it would measure a server
  we have just spent an hour loading. "The site was under our load" is the
  confound this pass exists to rule out.
- **Not an endpoint, because time is the measurement** — and an endpoint would
  make it optional in practice, and the recalibration the owner asked for would
  not land.

**What one recheck does** (`recheckServerErrors`, `src/crawl/loop.ts:1475`):

```
for each row, oldest first (order by coalesce(fetched_at, '-infinity') asc, id asc):
  if signal.aborted            -> return { aborted: true }        (row untouched)
  wait until fetched_at + max(minGap, gate.spacingMs(host)), abort-aware
  if budget spent              -> break; the cap stamp handles the rest
  isUrlAllowed(url)            -> refused: recheck_fetch_class='disallowed' + reason
  robots.isAllowed             -> denied:  recheck_fetch_class='disallowed' + reason
  await gate.acquire(host); fetchPage(...); gate.report(host, ...)
  write the four columns; DISCARD the body
```

The walls, each load-bearing:

- **`isUrlAllowed` explicitly, on every URL, hard rule 5.** `fetchPage` re-checks
  internally — belt and braces, not a substitute — but the explicit call is the
  one that produces a **classified row** rather than a throw, and the policy is
  DNS-dependent: a hostname vetted three hours ago may now resolve into RFC1918
  space.
- **The SAME `HostGate` instance the page loop used**, never a new one, so a host
  that earned 8 s of spacing by refusing the page crawl is still at 8 s when we
  ask it again (hard rule 9). `gate.report` is told about every request, so a 503
  on recheck escalates that host for everything that follows — including the
  resource pass, which shares the gate.
- **Strictly sequential. No pool, no `CrawlWindow`, no `maxConcurrency`.** A site
  with many 5xx rows is a site in trouble, and the last thing to do is open
  concurrent sockets to it (the yellow.com.mt incident,
  `docs/talos-integration.md`).
- **RAM is O(1)** (hard rule 6): the work list is a keyset cursor over
  `WORK_BATCH = 200` rows; no array of 5xx URLs exists at any point.
- **The body is discarded and no links are enqueued.** Analyzing it would produce
  a half-analyzed page whose links go nowhere.
- **No retries.** One more fetch. A timeout on the recheck is a `timeout` row and
  the finding stays `critical`.
- **Not contained.** Every site-side failure is classified into a row, so
  anything this throws is our defect or a failed write, and there is no column in
  which to write "the recheck columns are missing because the writer broke". It
  propagates, `execute` closes the row `failed`, and the operator finds out (hard
  rule 7).

**The three constants** (`src/crawl/recheck/recheck-server-errors.ts:127`, `:130`,
`:138`):

| constant | value | why this number |
|---|---|---|
| `MIN_RECHECK_GAP_MS` | `60_000` | the case that matters is an upstream/pool/container restart or a deploy — tens of seconds to about two minutes. 30 s covers only the front of it; 5 minutes delays every crawl carrying one 5xx and misreads what the finding claims ("still broken an hour later" is a re-crawl's claim). **Paid at most once**, not per row: the walk is oldest-first and each row's wait is monotonically decreasing |
| `MAX_RECHECKS` | `500` | more than 500 server errors is a site-wide outage, not a set of broken pages |
| `RECHECK_CAP_REASON` | `'recheck-cap'` | the `RESOURCE_CAP_REASON` doctrine verbatim, `&& !aborted` guard included: a budget running out is a decision the pass made and every row says so; a stop the CALLER made decided nothing and its rows carry no reason at all |

The wait is abort-aware in ≤250 ms slices (`SLEEP_SLICE_MS`), never one 60-second
`setTimeout`: "we stopped" has to mean the next quarter-second.

**Resume is free.** The work list IS `fetch_class = 'server_error' AND
recheck_fetch_class IS NULL`, so an interrupted pass re-run asks exactly the rows
the first never reached, and a `recheck-cap` row is still null — a resume picks it
up and overwrites the reason.

`CrawlSummary.recheck: RecheckPassSummary | null` (`src/crawl/loop.ts:376`), null
on a crawl that failed before it had pages and on one cancelled before the pass
(the `resources: null` precedent). `confirmed + cleared + inconclusive ==
rechecked`, held by the compiler: `outcomeOf`'s switch is exhaustive over
`FetchClass` with no `undefined` in its declared return type, so a class added to
`FETCH_CLASSES` and not named there is a typecheck failure rather than a row that
silently counts as one of the three.

---

## 4. The rule split — ruleset 0.13.0

A page rule's severity is a single literal fixed at definition time, so a rule
that reports two severities is not representable. The split is a split into
rules (`src/rules/page/status.ts`):

```
http.server-error            critical   CHECK-12   category: crawl
http.server-error-transient  warning    CHECK-12   category: crawl
```

They are defined against **one predicate**, `recheckCleared(p)`
(`src/rules/page/status.ts:59`), written once and negated by the other — which
makes them **mutually exclusive and jointly exhaustive over
`fetch_class = 'server_error'` by construction**. No 5xx page is ever silent
(hard rule 1) and none ever carries two findings. `test/rules/status.test.ts`
asserts it by looping over the whole `FETCH_CLASSES` union **plus null** rather
than over a hand-listed sample.

"A non-5xx answer" is `RECHECK_CLEARED` (`:39`), typed on both sides on purpose:
members are `FetchClass` so a class renamed in `src/crawl/fetch-page.ts` stops
compiling here, while the declared type is `ReadonlySet<string>` because the
value looked up is a `text` column. Every exclusion is deliberate —
`server_error` is confirmed; `blocked` is an answer about our **crawler**, not
about the page (the Phase 16 `crawl.blocked` owner ruling), and clears nothing;
`timeout` and `network_error` are no answer at all; `disallowed` is no request.

**No third rule, and no marker for the unverified case** — ruled, not omitted:

1. A marker means a check **could not be answered**. CHECK-12 *was* answered: the
   site returned a server error. Persistence is a qualifier on an answer, not the
   absence of one.
2. The severity spec already ruled the tie-break: "under-reporting a broken page
   is the worse mistake". A pass that did not run leaves us in the pre-pass state
   and must produce the pre-pass verdict.
3. A marker earns its place by explaining a **silence**, and there is none: the
   page carries a `critical` finding whose evidence says `recheck: "not run"`.

The evidence carries a **four-value** `recheck` string — `"not run"`, `"capped"`,
`"confirmed"`, `"inconclusive"` — because those are four different sentences a
report writer needs, and `recheckState` (`:76`) keys `capped` on
`recheck_reason` being non-null rather than on its text, so a second cap reason
added later lands correctly without editing the vocabulary. `gapSeconds` (`:86`)
is null rather than zero when there was no second observation or no
`fetched_at`: a gap nobody measured is not a gap of nothing (hard rule 7).

**Ruleset `0.12.0` → `0.13.0`** (`src/rules/registry/registry.ts:149`), on three
grounds recorded in the version comment: one rule added; one verdict **moved**
(`http.server-error` no longer fires on a 5xx whose recheck cleared); copy on
`http.server-error`. **Nothing is backfilled** — an older crawl re-judged at
0.13.0 reports exactly what it reported at 0.12.0, with `recheck: "not run"`
added to the evidence. No old crawl silently loses an Error.

**Totals: 27 critical / 24 warning / 45 info over 96 rules** = 27 page + 55 query
+ 14 metric. Coverage is unmoved — both rules claim CHECK-12, which was already
claimed — so the 47 crawl-derived checks still account as 44 claimed / 3 agent /
0 unclaimed over 83 checks.

CHECK-12 in `skills/ariadne-audit/checklist.md` names both rules with severities
in the parenthetical form the drift test parses, describes the four recheck
states, and states the ruling in the words the report should use: **N confirmed,
M never re-verified**. CHECK-83 gains question 6 ("was the 5xx evidence
re-verified?"); its NOT MEASURED family list is untouched.

---

## 5. The surfaces

Owned by T4 and summarised here rather than re-derived:

- **`pages_query` / `PAGE_FIELDS`** gains `fetchedAt`, `recheckFetchClass`,
  `recheckStatusCode`, `recheckReason`, `recheckAt`. That projection is
  documented as "deliberately slim", and the argument for widening it is
  specific: the recheck is the only mechanism on this surface that turns a
  `critical` into a `warning`, and an agent that cannot see the second
  observation cannot check the engine's arithmetic before quoting it to a client.
- **`crawl_status` / `CrawlDetail`** gains one `recheck` block, counted **live**
  off `pages` in one statement on the `resourceCoverage` discipline:
  `serverErrors`, `confirmed`, `cleared`, `inconclusive`, `pending`, `capped`,
  `passAt`. Live because a poller must see `pending` fall while the pass runs,
  and because a resumed crawl's numbers are the table's rather than one run's.
  `confirmed + cleared + inconclusive + pending == serverErrors`, always. **Not
  on `CrawlListItem`** — a listing row is not a coverage report.
- **CSV `internal_urls`** gains `recheckFetchClass`, `recheckStatus`,
  `recheckAt`: a list of server errors that cannot be sorted by "still broken" is
  the wrong list.
- **`src/demo/index.html`** gains one live progress line, shown only when
  `recheck.serverErrors > 0`.
- **`docs/talos-surface.md`** gains the block in §4.2, the five fields in §4.6,
  and a §5.7 null-versus-zero entry.

---

## 6. The harness, and what the shared fixture deliberately is not

`test/fixtures/harness.test.ts` crawls the whole fixture site once and asserts
that **every registered rule fires on at least one fixture**, save the ids
`SKIP_HARNESS_CLAIMS` names and explains with a paragraph each.

`http.server-error-transient` joins that list, and it is the **only** entry there
because of what the fixture site deliberately **is not**. Provoking the rule
needs a **flapping** route — 503 to the crawl, 200 to the look a minute later —
and the design ruled that route out of the shared app (§5.6): this app serves one
site to one crawl that every other file in the suite reads, and a route whose
answer depends on how many times it has been asked would change what that crawl
sees depending on which pass ran first. The render pass, the resource pass and
the 404 probe all issue requests of their own.

So `/status/server-error` stays a **stateless 503**, and what the harness proves
is the confirmed half end to end through the real loop, plus the negative:

| assertion | what it pins |
|---|---|
| "re-asked the site's one server error and confirmed it" | `summary.recheck` is exactly `{ rechecked: 1, confirmed: 1, cleared: 0, inconclusive: 0, capped: false, aborted: false }`, and the partition sums |
| "wrote the second observation beside the first without touching it" | `fetch_class` still `server_error` and `status_code` still 503 — the assertion that catches the whole design going wrong at once — beside `recheck_fetch_class = 'server_error'`, `recheck_status_code = 503`, a non-null `recheck_at` and a null `recheck_reason` |
| "still reports the confirmed error as critical, and says it was re-verified" | `http.server-error` fired, its severity read from the **registry** rather than from a literal, and its evidence carries `recheck: "confirmed"` |
| "fired the transient rule on nothing at all" | **the negative that proves the split does not leak**: no fixture, no site-scoped finding. On a site whose only 5xx is confirmed, a transient finding would be a `warning` where a `critical` belongs |

The exemption list is asserted in both directions, as it always has been: an id
listed as unfireable that then fires must leave the list rather than sit there as
a stale excuse.

The transient half is covered end to end on servers that **can** flap:
`test/crawl/recheck.test.ts` (the pass's nine cases, §5.3 of the design) and
`test/db/migration-0016.test.ts` (the whole loop, `/flaky` 503-then-200).

**One stale number corrected while here**: the assertion's comment said "save the
nine `SKIP_HARNESS_CLAIMS` name", written when the list held nine and carried
through four phases of resource markers. It is fourteen, and the comment now says
so and says it was stale.

---

## 7. The wall-time finding: 60 real seconds inside three loop-driven tests

**Recorded honestly, because it was found by T2 and paid for by T5.**

`MIN_RECHECK_GAP_MS` is real wall time inside any test that drives `runCrawl`
over a fixture that serves a 5xx, and the pass's own test-only `minGapMs`
(`RecheckPassOpts`) cannot reach a crawl the loop runs. Three suites were
affected, and T2 landed with their timeouts raised to cover it and a note saying
T5 would fix the cause:

| file | what it drives | before |
|---|---|---|
| `test/db/migration-0016.test.ts` | a whole crawl of a 2×5xx fixture | hook timeout raised 60 s → 180 s |
| `test/crawl/fetch-resources.test.ts` | "hands the pass the window the page crawl settled at" — two 503s collapse the window | no explicit timeout → 120 s |
| `test/fixtures/harness.test.ts` | the whole fixture site, which carries `/status/server-error` | hook timeout raised 120 s → 180 s |

**The fix is a knob, on the `allowPrivate` precedent in every respect**:
`CrawlConfig.recheckMinGapMs?: number` (`src/crawl/loop.ts:148`), spread into the
pass's existing `minGapMs` at INSERTION 3c (`:1491`) so **absent stays absent**
and the pass's own default is the real 60 s.

What keeps it honest — the same three walls the escape hatch it copies has:

1. **Not persisted.** `storableConfig` strips it beside `allowPrivate`
   (`:636`), and `parseStoredConfig`'s closed field set does not read it back.
   Persisting a shortened gap would make the **weaker claim durable**: every
   resume of that crawl, months later, would re-ask its server errors a fifth of
   a second after seeing them and report the answer as if a minute had passed.
   Asserted by `test/crawl/loop.test.ts` ("strips the test-only recheck gap from
   the stored config, and never reads it back"), on the stored blob **and**
   through `parseStoredConfig` — two independent walls, either one going missing
   is the same defect.
2. **Not accepted over the API at any value.** `parseStartCrawlInput`'s field
   allowlist is closed, so a body carrying the key is refused by both transports
   today; it wants the **named** refusal `allowPrivate` gets, so the message says
   why rather than "unknown field". See §12.
3. **Range-checked at crawl start, not at crawl end.** `validateCrawlConfig`
   (`:858`) refuses a fractional or negative gap where `findingCap` is refused,
   rather than letting a `RangeError` surface from a pass that runs an hour in.
   It is refused, not clamped (hard rule 7).

**And the default is asserted as a number, not waited for.** Every case in
`test/crawl/recheck.test.ts` runs at `minGapMs: 50` and the three suites above at
200 ms, so nothing in the repository would notice if the default quietly became
50 too — except `test/crawl/recheck.test.ts`'s "keeps the real floor at 60
seconds and the real cap at 500 rows", which reads the exported constants.
Waiting a minute to observe a number a read gives for free proves nothing extra.

**Measured, in this worktree** (§8 carries the suite totals):

| | before the knob | after |
|---|---|---|
| the whole suite, wall | **209.0 s** | **125.7 s** |
| `test/fixtures/harness.test.ts`, the file | not measured on its own | **20.4 s** (35 tests) |
| `test/db/migration-0016.test.ts`, the file | not measured on its own | **1.7 s** (7 tests) |
| `test/crawl/fetch-resources.test.ts`, the window case | not measured on its own | **3.5 s** |

The two suite numbers are the honest pair: both are full `npx vitest run` wall
times in this worktree, the "before" taken with the three knob call-sites
commented out and **nothing else changed**. The per-file "before" column is left
blank rather than filled with an estimate — each of the three waits the gap
once, but the three run in parallel and no per-file number was taken.

**83 seconds off every full-suite run.** Less than the three serial minutes the
three files would suggest, because vitest runs them in parallel: the gap was
paid three times over but only about once in wall.

The knob is the whole of the change: **no politeness limit moved**, and the
production gap is the number it always was.

---

## 8. Verification

| | |
|---|---|
| Suite | **77 files / 1,877 tests, 0 failures, 132.7 s** (orchestrator's run after T4, d50c2ef). Measured at T5 close: 1,874 tests / 77 files, 1,871 passing, wall 141.6 s. The three reds are all `test/skills/identifier-guard.test.ts` and all one cause — `docs/talos-surface.md`'s `file:line` citations drifted while that document was being rewritten for the recheck block, plus two lines this task moved (§12.2). Baseline into the phase was 1,830 (`b2449aa`); the net is T2's pass cases, T3's rule cases, T4's surface cases and T5's six |
| Typecheck | `npx tsc --noEmit` — **clean**, whole tree, measured at T5 close |
| Migrations | 0000–**0016**; `drizzle/0016_damp_ironclad.sql`, drizzle-kit generated, applied with `npm run db:migrate`. The dev database's journal holds 17 rows and carries all seven columns (§2) |
| Ruleset | **0.13.0**, **96 rules** = 27 page + 55 query + 14 metric; **27 critical / 24 warning / 45 info** |
| Checklist | 83 checks; coverage unmoved — the 47 crawl-derived checks account as **44 claimed / 3 agent / 0 unclaimed**. CHECK-12 rewritten, CHECK-83 gains question 6 |
| Markers | **ten**, unchanged by this phase — (B) deliberately added none (§4), and (A) surfaces the ten that exist |
| Guards | the identifier guard, the citation guard and its `src/` form, the marker guard and the copy contracts — see §12 for the one citation this task's line shifts invalidated |
| Politeness | untouched. Same `HostGate` instance, same UA, same `FETCH_TIMEOUT_MS`; `MIN_RECHECK_GAP_MS` is a floor **on top of** the gate's spacing, never instead of it |
| Surface | 16 MCP tools / 16 HTTP routes — no route or tool added; the recheck rides on `crawl_status`, `pages_query`, `GET /rules` and the CSV export that already existed |

---

## 9. What the machine does NOT cover

Stated so nobody reads the green as wider than it is:

1. **No real site has been re-checked.** Every measurement above is against
   fixture servers on 127.0.0.1. Gate clause 5 exists precisely to close this,
   and it is the one clause a machine cannot answer: a transient 5xx on a real
   site is a thing that happens to you, not a thing you arrange. **[recorded at
   gate time]**
2. **The 60-second gap has never been waited out end to end in CI.** After §7 the
   three loop-driven suites run at 200 ms and the production number is asserted
   as a constant. What is machine-proven is that the pass waits **the gap it was
   given** (`test/db/migration-0016.test.ts` reads it back off the two
   timestamps) and that the constant is 60 s. That the loop passes the constant
   when nobody overrides it is proven by construction — the spread at
   `loop.ts:1491` — and by reading, not by a test that waits a minute.
3. **`MAX_RECHECKS = 500` is exercised at 1, not at 500.** The cap's behaviour is
   pinned with `maxRechecks: 1` over two rows. A crawl with 501 server errors has
   never been run, and would be a site-wide outage rather than a test.
4. **The transient rule has never fired on the shared fixture site**, by design
   (§6). It fires on its own servers, in two files, and the harness asserts the
   negative.
5. **The demo's fourth section and the live recheck line are smoke-and-reading
   covered, not browser covered.** `test/demo/flow.test.ts` pins that the data
   reaches the page through the proxy; that the section renders as intended was
   seen, not asserted — the Phase 15 §6 position on the demo page, unchanged.
6. **A pre-0016 crawl resumed by a 0016 loop** takes the documented fallback:
   `fetched_at` is null, the pass counts from its own start, and the finding's
   `gapSeconds` is null — the honest answer rather than a computed number nobody
   measured. That path is reasoned and typed; no test builds a genuinely
   pre-0016 row, because the migration is applied before any test runs.

---

## 10. Red-first, honestly accounted

- **T1** — the migration test was red first against a schema without the columns,
  and red again on `fetched_at` before `PageWriter` stamped it.
- **T2** — the nine pass cases are red against a module that did not exist
  (collection failure). The end-to-end half was the discovery: driving `runCrawl`
  made three suites wait a real minute, which T2 recorded in its commit message
  as T5's to fix rather than papering over.
- **T3** — the exhaustiveness guard is the red-first that matters: with one class
  moved between the two sets, a `server_error` page fires twice or not at all.
  The version pin and the checklist drift test both forced their edits.
- **T4** — the surfaces, in flight while this was written.
- **T5** (this document plus the harness and the knob) — the harness's "every
  registered rule fires" was **left red by T2 on purpose** and is what this task
  opened on; the knob's own red is `test/crawl/loop.test.ts`'s strip assertion,
  which fails against a `storableConfig` that does not know the field. The
  numbers in §7 were measured in this worktree, both ways, rather than copied
  from a task report — the "before" column cost a full suite run with the knob
  temporarily removed.

---

## 11. Commits, in order

| commit | what |
|---|---|
| `726d6b6` | base — Phase 15's gate §4 recorded (Phases 15+16 merged as PR #14) |
| `b2449aa` | **(A)** the demo's "Not checked on this crawl" section, keyed on the catalog's additive `marker`; the Phase 17 design committed ahead of its implementation |
| `1d1a91a` | T1 — migration 0016: `pages.fetched_at` + the four recheck columns, `crawls.recheck_pass_at` / `recheck_pass_count` |
| `caff3b1` | T3 — the rule split by re-check outcome, ruleset 0.13.0 (27/24/45 over 96) |
| `1f40548` | T2 — re-verify every 5xx page once at crawl end (INSERTION 3c) |
| (T4) | the surfaces — `crawl_status.recheck`, `pages_query`, the CSV columns, the demo line, `docs/talos-surface.md` |
| (T5) | the harness's two assertions and its exemption entry, the test-only gap knob, and this document |

---

## 12. What the next phase inherits

1. **`recheckMinGapMs` wants a named API refusal.** `parseStartCrawlInput`
   (`src/api/service.ts`) refuses it today only as an unknown field. It should be
   refused by name, beside `allowPrivate`'s "not accepted over the API at any
   value" — a caller sending it has read about the knob somewhere and needs to be
   told it is not an API field at all, at any value. **Recommended first item.**
2. **A merge chore for THIS phase, recorded here so it is not lost: two
   `docs/talos-surface.md` citations are off by a line shift.** T5's harness and
   fetch-resources edits moved two cited `it()` declarations, and the citation
   guard is red until the two numbers move with them —
   `fetch-resources.test.ts:1332` → `:1334` ("asks nobody anything when the
   operator turned resource fetching off"), `harness.test.ts:1811` → `:1841`
   ("the health rollup agrees with a page-by-page recount (P10-T2)"). The guard
   is doing exactly its job: a line number is not an identity, and it caught the
   drift the moment the lines moved. Mechanical, and T4's file to edit.
3. **`sendCsv`'s never-settling drain** (`src/api/http.ts`) — carried unchanged
   from Phase 15 §10 pointer 1, still the standing recommended candidate, still
   the owner's ordering to rule.
4. Carried forward unchanged and still **owner-ruled standing**: the
   `robots_unreachable` retry, tenancy on `crawl_list`, and the wall-time
   shortening designs.

And one thing this phase makes possible that nothing did before: **a report can
now say how long a server error lasted.** Whether that changes what a client is
told is the agent's judgement, and the evidence layer's job here is done.

---

## 13. Integration

**[recorded at merge]**

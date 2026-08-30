# Phase 9 gate — schema truth, and a silent zero found on the way

**Date:** 2026-08-30
**Code:** branch `worktree-phase-9`, base `01611f5` (main with Phases 0–8), plan
commit `74bc895`. The gate was demonstrated at **`b8ec554`** with ruleset
**0.7.0** and migrations 0000–**0012**. Six commits carry the phase:

| | |
|---|---|
| T1 migration 0012 — the ledgered trio | `052386b`, `39e6358` |
| T2 `structure.deep-page` reads `click_depth` | `0bcecd9`, `b0f4f26` |
| T3 `crawl_status.pagesScanned` | `eeb210a`, `b8ec554` |

plus the commit that carries this file.

**Every number in this document was measured while it was written** — `psql`
against the dev database on port 5440, one full `npm test` run, `npx tsc
--noEmit`, `npx vitest run` on two named files, a `tsx` script that reads the
API service, and `git`. **One exception, marked at the point of use:** the
before/after `EXPLAIN` pair in §2 is attributed to the Task 1 report, because
"before" required dropping an index inside a transaction and that measurement is
not repeated here. This gate re-measured the *after* plan itself and says so.

**This phase crawled nothing.** The owner scoped the gate as fixture-based with
no client-site crawl (§7), so the three lavishalice crawls appear here only as
**migration-rehearsal data that had to survive undamaged** — they were read, never
re-judged, never rewritten.

**Verdict: PASSED.** All five gate items are demonstrated below. Two things are
worth reading before the items:

- **A rule was silent for two real audits for a structural reason, and the reason
  is now measured rather than argued.** On the third
  lavishalice crawl the retired reading of `structure.deep-page` had a maximum
  discovery depth of **1** across all 551 rows — `depth > 5` was empty *by
  construction*, on a site with 356 unreachable indexable pages (§3.1).
- **The phase's surprise is a defect nobody was looking for**: a correlated
  subquery in a select list that rendered unqualified and counted zero, sitting
  one schema change away from making every judged crawl report
  `findingsCount: 0` — "this site is clean" (§6).

---

## What the gate is

The plan's five items, each answered with its measurement.

| | The plan asked | Answered |
|---|---|---|
| 1 | 0012 applied over the dev DB holding the three lavishalice crawls; the backfill verification queries pass; the crawls' rows survive | §1 — 551/551/551 pages, 1,314 / 1,326 / 17,658 findings, 35,145 links each, unchanged after a full suite ran over the same database |
| 2 | the `EXPLAIN` before/after on the uncapped `title.duplicate` lateral, both timings recorded | §2 — 19.027 ms → 0.843 ms wall and **0.338 → 0.009 ms per group** (attributed); the after-plan re-measured here at 1.385/1.416/1.666 ms with the lateral on `pages_dupe_title` |
| 3 | `structure.deep-page` fires on the fixture corpus, extending the fixture if it does not reach depth 6 | §3 — **no fixture change was needed**; `/deep/6` and `/deep/7` fire, and the harness's every-rule sweep is green with the rule *not* exempt |
| 4 | a judged fixture crawl's `crawl_status.pagesScanned` equals its run summary's, through the MCP transport | §4 — pinned on both transports, plus the live equality on real data through the service path: 551 / 1,326 |
| 5 | full suite green, tsc clean, tree clean after the suite | §5 — **1,440 tests / 63 files, 358.26 s**, tsc clean in 7.06 s, `git status --porcelain` empty |

---

## 1. Gate item 1 — the migration rehearsal, on real data

### 1.1 The three crawls, re-queried tonight

Counts taken **after** the full suite of §5 had run against the same database, so
they answer the question the gate actually asks — did anything this phase did, or
anything the suite does, disturb the reference rows:

| | `crawl_2af4daf1…` (audit 1) | `crawl_3f3ab847…` (audit 2) | `crawl_02ff6f7a…` (audit 3) |
|---|---|---|---|
| ruleset | 0.4.0 | 0.5.0 | 0.6.0 |
| **pages** | **551** | **551** | **551** |
| **findings** | **1,314** | **1,326** | **17,658** |
| metrics | 855 | 1,023 | 85 |
| links | 35,145 | 35,145 | 35,145 |
| `render_pass_count` | 28 | 28 | 14 |
| `render_urls_jsonb` | NULL | NULL | **14 elements** |
| `template_inference_jsonb` | NULL | NULL | NULL |

The pages, findings, metrics and links cells match `docs/gates/phase-8.md`'s
Leftovers table exactly, which is the control: the migration added two columns and
three indexes over these rows and rewrote nothing except the one backfilled value
it was written to move. The one row that reads differently is not a difference:
that table's "rows with render evidence" is **38** on audit 1, while
`render_pass_count` is **28** — because the column holds the *last* pass's count
and audit 1 ran two passes. That is defect **D-5**, still open, and it is worth
seeing beside a migration that gave two other facts columns of their own.

### 1.2 The backfill's two halves, verified as two facts

```sql
select count(*) from crawls where config_jsonb ? 'renderUrls';   -- 0
```

**Zero rows anywhere in the table** still carry the legacy key — not "zero
lavishalice rows": zero of all 106 crawl rows in the database. The key was copied
out and then removed, which is what returns `config_jsonb` to being exactly what
`storableConfig` wrote, with one writer again.

The other half, on the crawl that had an explicit list:

```sql
select jsonb_array_length(render_urls_jsonb)
from crawls where id = 'crawl_02ff6f7a-…';                        -- 14
```

**14 elements** — the fourteen URLs the Phase 8 agent-directed pass named
(`phase-8.md` §4). Across the whole table exactly **one** row has a non-null
`render_urls_jsonb`, and **zero** rows hold jsonb `'null'` in it
(`count(*) filter (where jsonb_typeof(render_urls_jsonb) = 'null')` = 0), which is
the property §1.4's amendment exists to guarantee.

The reader moved with the writer: `src/rules/metric/render-metrics.ts:104` now
selects `crawls.renderUrlsJsonb` beside the config, and `RENDER_URLS_KEY` has no
references left in `src/`.

### 1.3 All three template markers are NULL, and NULL is the honest answer

`template_inference_jsonb` is null on all three lavishalice crawls, and **that is
the specified outcome rather than a backfill that failed**. Their inference ran
before the column existed; the numbers it produced — famously 196 → 13 on audit 3
(`phase-8.md` §7.1) — exist in a log line and in that gate document, and nowhere
in a row. Reconstructing them from the log into a column would be a guess wearing
the clothes of a record, which is hard rule 7. NULL means *unknown*, and the
column's own comment says so.

The writer is not merely asserted to work: **15 crawl rows in this database carry
a non-null marker**, all of them written since 0012 by fixture crawls. So the
NULLs above are old-row NULLs, not dead-writer NULLs, and the two cases are
distinguishable by inspection — which is the whole ambiguity the Phase 8 gate's
§7.2 warning box was built to work around.

### 1.4 Migrations 0000–0012 applied

`drizzle.__drizzle_migrations` holds **13 rows**. The last is
`created_at = 1788037063360`, which is exactly the `when` field of
`0012_fast_unus` in `drizzle/meta/_journal.json`. The three indexes exist with the
predicate the rules need:

```
pages_dupe_title            btree (crawl_id, btrim(title), url)
  WHERE fetch_class = 'ok' AND status_code = 200 AND is_indexable = true AND title IS NOT NULL
pages_dupe_meta_description btree (crawl_id, btrim(meta_description), url)  WHERE … meta_description IS NOT NULL
pages_dupe_h1_text          btree (crawl_id, btrim(h1_text), url)           WHERE … h1_text IS NOT NULL
```

read back from `pg_indexes` (Postgres's own normalised spelling). The first three
conjuncts are `INDEXABLE`'s, from `src/rules/query/field-duplicates.ts`, which the
schema mirrors verbatim — and that mirroring is what lets the planner prove the
query's predicate implies the index's. Widen one without the other and the
planner silently stops using these indexes: a slow query, never an error. Both
files carry a comment pointing at the other.

### 1.5 The 0012 amendment, told straight

**The migration was applied and then edited.** `052386b` generated and applied
0012; `39e6358` added one conjunct to its backfill *in the same file*:

```sql
UPDATE crawls SET render_urls_jsonb = config_jsonb->'renderUrls'
WHERE config_jsonb ? 'renderUrls' AND config_jsonb->'renderUrls' IS NOT NULL
  AND jsonb_typeof(config_jsonb->'renderUrls') <> 'null';
```

**What motivated it (the Task 1 review's one IMPORTANT finding).** The retired
`jsonb_set` writer wrote `renderUrls: null` on **every automatic Phase 8 render
pass** — the common case, not the exotic one. `->` returns jsonb `null`, not SQL
NULL, so those rows satisfy `IS NOT NULL` and the unguarded backfill would have
copied jsonb `'null'` into the new column: a second spelling of the fact the
column's comment says SQL NULL means, on which `render_urls_jsonb is null`
answers wrongly and `jsonb_array_length` throws. This dev database escapes only
because its automatic-pass crawls predate that writer.

**Why editing an applied migration is safe here, measured rather than asserted.**
Drizzle's migrator compares timestamps, never hashes —
`node_modules/drizzle-orm/pg-core/dialect.js:62`:

```js
if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { … }
```

The hash column is written and never read back for comparison. The evidence that
this is not theory: the hash stored in row 13 is
`0764ee8b21c871233a422bd574690986e888182ec03bb1ce32f8ab956b6b70d9`, which is the
sha256 of `drizzle/0012_fast_unus.sql` **as it stood at `052386b`**; the file on
disk today hashes `51dd41800d316198170a66e67ad38c0afcd739c996350d7063f2924e6ef85cee`.
The two differ, the migrator does not care, and `npm run db:migrate` neither
re-runs 0012 nor errors.

**And the edit changed nothing here.** The added predicate matched zero rows in
this database — there are no jsonb-null `renderUrls` values in it at all — so the
applied version and the committed version are semantically identical *on this
data*. What the amendment buys is every other Phase-8-era database, where the
shape is the common one. It does not repair a database that already ran the first
form over such rows; it prevents the shape on databases that have not migrated
yet. That asymmetry is the honest cost of amending in place, and it was accepted
knowingly rather than discovered afterwards.

**One deliberate looseness:** the guard is `<> 'null'` and **not** `= 'array'`. A
value that is neither null nor a list of URLs is a config this engine cannot
read, and it is copied through so `render.coverage` refuses it out loud rather
than having a migration quietly drop it (hard rule 7). The alternative — a fresh
0013 — was rejected: it would spend a migration on a shape this database has never
held.

---

## 2. Gate item 2 — the index earns its row

### 2.1 The before/after, attributed

**These four numbers are the Task 1 report's**
(`.superpowers/sdd/2026-08-29-phase-9-schema-truth/task-1-report.md` §3, commit
`052386b`), measured on `crawl_02ff6f7a…` — 551 pages, 443 in the indexable
cohort, **5 duplicate title groups** — with "before" produced by
`begin; drop index pages_dupe_title; …; rollback;` so the reference data was never
at risk. Three runs each; the figures are the third, steady state:

| | before (index dropped) | after |
|---|---|---|
| **wall** | **19.027 ms** (runs 1–3: 43.715 / 22.410 / 19.027) | **0.843 ms** (1.364 / 0.887 / 0.843) |
| **per group, the sample lateral** | **0.338 ms** — bitmap heap scan + sort, 549 rows discarded per group | **0.009 ms** — index scan, no sort, nothing discarded (**~38×**) |
| shared buffers | **930** | **175** |
| JIT | fires (25 functions, 16.422 ms of pure overhead on a 257k-cost plan) | **does not fire** (estimate 4,048, below the threshold) |

The Task 1 **reviewer reproduced the after-plan independently on all three
duplicate shapes** — title, meta description and H1 — and recorded each lateral
hitting its own partial index at **0.006–0.009 ms per group**
(`.superpowers/sdd/2026-08-29-phase-9-schema-truth/progress.md`, Task 1 review
line). That is the number that matters, because it is the one multiplied by the
group count.

### 2.2 Re-measured tonight, after-plan only

The same uncapped query, run three times from a cold `psql` session against the
same crawl at gate time:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| Execution Time | 1.385 ms | 1.416 ms | 1.666 ms |
| Planning Time | 1.659 ms | 1.545 ms | 1.800 ms |
| total shared buffers | 180 | 180 | 180 |
| per-group aggregate | 0.016 ms | 0.012 ms | 0.015 ms |

with the lateral reading

```
->  Index Scan using pages_dupe_title on pages p2  (actual time=0.013..0.013 rows=2 loops=5)
      Index Cond: ((crawl_id = 'crawl_02ff6f7a-…') AND (btrim(title) = (btrim(p.title))))
```

and the group aggregate's cohort filter inside the partial index's `Recheck
Cond`, with no rows removed. These are slower than the task report's 0.843 ms and
that is expected rather than concerning: each run is a fresh backend (planning is
1.5–1.8 ms of the total and is excluded from the task report's figure), the
database has grown by a day of test crawls since, and its statistics were
re-`ANALYZE`d by the suite minutes earlier. **The mechanism — index
scan instead of bitmap-heap-plus-sort, no JIT, ~170–180 buffers — reproduces
exactly.**

### 2.3 The caveat, stated rather than buried

**551 pages with 5 duplicate groups is a small shape.** It demonstrates the plan
change and the per-group cost cleanly and it does **not** reproduce the
regression that motivated the index: the **10.4 ms per group at 20,000 pages** is
the *Phase 8* gate's measurement (`phase-8.md` §15, the Phase 9 migration ledger
row), taken on a different corpus and **not re-measured here**, because no 20k-page
crawl exists in this database. The plan-pinning / EXPLAIN test mechanism stays
backlogged, so this section is a report number and not a test.

What is proven here is the plan shape and the per-group cost; what is inherited is
the claim that per-group cost times an uncapped site's group count is the number
that hurt.

---

## 3. Gate item 3 — the silent rule speaks

### 3.1 Why it was silent, measured on the real crawl

Over `crawl_02ff6f7a…`, read-only, tonight:

| | |
|---|---|
| rows | 551 |
| indexable cohort (`ok`, 200, indexable) | 443 |
| **max discovery `depth`** | **1** |
| rows with `depth > 5` | **0** |
| **pages the retired page rule could have fired on** | **0** |
| indexable rows with NULL `click_depth` | **356** |
| max `click_depth` | 6 |
| **pages the query rule fires on** | **1** |

`discovered_via` on the same crawl: **sitemap 437, link 113, seed 1**. Every
sitemap URL is enqueued as a seed, so discovery depth measures *how the crawler
found a page*, and on a sitemap-led site it is 0 or 1 for almost everything. The
rule's threshold is 5. **`depth > 5` was not "empty because the site is flat"; it
was empty because it could not be anything else** — a rule that always passes,
which hard rule 1 forbids and which two consecutive audits recorded as a PASS and
then as a silence.

The one page the fixed rule names is exactly the shape the old reading could not
see:

```
https://lavishalice.com/collections/sequin-dresses   click_depth 6   depth 0   discovered_via sitemap
```

**The fix does not turn a silence into a flood, and that is worth saying plainly.**
One page fires. The 356 unreachable indexable pages are *excluded* — a page no
link path reaches has no depth to be past a threshold — and they remain the
business of `structure.click-depth-distribution`'s `nullCount` and, where nothing
links to them at all, of `links.orphan`. This measurement is the rule's SQL run by
hand over stored rows; **the crawl was not re-judged** and its 17,658 findings are
the 0.6.0 rows Phase 8 wrote.

### 3.2 The fixture needed no modification

The plan allowed extending the fixture if it did not reach depth 6. It did not
need to. The harness site's hub **is** the seed (`/`); it links `/deep/1`, each
rung links only the next, and **no rung is in the sitemap** — which is load-bearing,
because a listed URL is enqueued at depth 0 whatever links to it and would flatten
the chain. So a rung's click depth is its number, `/deep/6` and `/deep/7` are past
the threshold of 5, and `/deep/7`'s finding set is pinned *exactly*.

Run at gate time:

```
npx vitest run test/fixtures/harness.test.ts
  ✓ every fixture's expected issues fire on its path
  ✓ click depth is the walk the site publishes, and the sitemap-only pages have none
  ✓ every registered rule fires on at least one fixture
  Test Files 1 passed (1)   Tests 25 passed (25)   Duration 28.39s
```

The third of those is the strict form: it sweeps the registry and fails on any
rule that fired nowhere, with nine exemptions listed by name in
`SKIP_HARNESS_CLAIMS`. **`structure.deep-page` is not one of them**, so that test
passing *is* the statement that the rule speaks on the fixture corpus.

The rule's own suite, also run at gate time:

```
npx vitest run test/rules/link-graph-query.test.ts
  ✓ fires on the rung the link search puts past the threshold, and not on the one at it
  ✓ fires on a sitemap-discovered page whose discovery depth is shallow and click path long
  ✓ says nothing about a page the link graph never reaches — that is the orphan's finding
  ✓ is silent on a deep page that is not indexable, and not on the one beside it
  ✓ orders deepest first, caps the listing and reports the exact total
  ✓ reads only its own crawl
  ✓ the incomplete-crawl caveat › … (6 cases)
  Test Files 1 passed (1)   Tests 32 passed (32)   Duration 2.72s
```

The second case builds a seven-rung chain with every rung inserted at
`depth: 1, discoveredVia: "sitemap"` and then asserts the stored `depth` **is** 1
on every non-seed row — so the test states in its own assertions that the retired
reading would have said nothing.

### 3.3 Why it had to become a query rule

`deriveClickDepth` fills the column in the derivation phase, which runs **after**
the page cursor and **before** the query rules (`src/rules/run.ts`). A page rule
reading `click_depth` would see the previous run's value, or null on a crawl's
first judgement — a rule that always passes the first time it is asked. That is
hard rule 1, and it is the reason the move was a kind change and not a column
swap.

The move kept everything a coverage pin looks at: same id, same `CHECK-31`, same
`info` severity, same `technical` category. **The coverage numbers did not move** —
47 crawl-derived checks, 44 claimed, 3 agent, 0 unclaimed — which is the test of a
move rather than a deletion. The kind split did move, honestly and in the claiming
commit: 85 rules = **26 page + 47 query** + 12 metric, from 27 + 46 + 12.

### 3.4 The ruleset bump, and its rationale

**0.6.0 → 0.7.0**, in `0bcecd9`, with the reason in the constant's own comment:

> `0.7.0`: `structure.deep-page` moved to `click_depth` — a rule silent on real
> sites became reachable, so a re-judged crawl can change verdict.

That is the rule the plan set: `RULESET_VERSION` moves when a verdict a rule can
reach changes. Migration 0012 changed no verdict (indexes are plans; columns are
records) and stayed at 0.6.0; T2 changed reachability, which on a real site *is* a
verdict change, and paid for it.

### 3.5 The caveat design — an upper bound, not a gate

The implementer's first comment claimed an incomplete crawl only makes this rule's
answer *incomplete*. The review found it wrong in the direction that matters:
**a breadth-first search over a subgraph returns an upper bound on the true
shortest path.** A missing page removes routes and never adds one, so on a
truncated crawl the rule can report a page as buried when an uncrawled two-click
route serves it — a **false positive**, under copy that asserts "the shortest
route… from the home page" about the *site*.

The disposition was **caveat, not gate**:

- Every finding carries `caveat` with `incompleteCrawl` (reusing this file's own
  `skipReason()`, so the two link-graph rules cannot disagree about what
  "incomplete" means) and/or `failedPages` (the same key and number
  `links.orphan` reports).
- A full refusal in `links.orphan`'s style was **rejected**: an orphan verdict on
  an incomplete crawl is unsound about every page it names, while a depth verdict
  is right about most and overstated about some — dropping the listing to avoid
  the some would hide the most, which is hard rule 7.
- A `structure.deep-page-skipped` twin was **rejected** too: its condition is
  unreachable inside `runRules`, so it would be hard rule 1 inverted — a rule that
  can never fire.

Six tests hold that shape, including one that pins the asymmetry directly: on a
crawl where `links.orphan` refuses and `links.orphan-skipped` fires,
`structure.deep-page` still answers, with its caveat. A future "make them
consistent" edit has to argue with a test.

---

## 4. Gate item 4 — the contract holds end to end

`crawl_status.pagesScanned` is **derived, not stored** — a scalar subquery in the
same statement as `rulesRunAt` and `findingsCount`, so all three come from one
snapshot. The config doctrine forbids a column for a derivable value, and the
single-statement invariant is Phase 7's: a resumed crawl adds `pages` rows, and
two reads could pair a marker from before the resume with a count from after it.

**Pinned on both transports** (both files green in §5's run):

- `test/api/mcp.test.ts` — *"`crawl_rules` › judges the finished crawl, answers
  with the run summary, and marks it judged"*: the unjudged crawl already answers
  `pagesScanned`; after the run, `crawl_status`'s `pagesScanned` **equals the run
  summary's**; and before equals after, because `pages` rows are immutable once the
  crawl has stopped.
- `test/api/http.test.ts` — *"`POST /crawls/:id/rules` › runs the rules over the
  finished crawl and returns the summary"*: the same two equalities on the HTTP
  transport.
- `test/api/query.test.ts` — the statement-level pin: the statement that touches
  `issues` also names `pages`, and **both correlations are fully qualified**
  (`"issues"."crawl_id" = "crawls"."id"`, `"pages"."crawl_id" = "crawls"."id"`).
  That pin exists because of §6.

**The live equality on real data, through the service path.** Not SQL: a `tsx`
script constructed an `ApiService` over the dev database and called
`getCrawl` — the same method both transports call:

| crawl | `pagesScanned` | `findingsCount` | `pagesCrawled` | `rulesRunAt` |
|---|---|---|---|---|
| `crawl_2af4daf1…` | **551** | 1,314 | 551 | null |
| `crawl_3f3ab847…` | **551** | **1,326** | 551 | 2026-08-28T21:55:35.006Z |
| `crawl_02ff6f7a…` | **551** | 17,658 | 551 | 2026-08-29T15:43:54.879Z |

**551 / 1,326** on audit 2 is the pair the audit skill's retired caveat used to
quote from a run summary. The first row is the other half of the contract: a crawl
with **no** judgement marker still answers `pagesScanned`, because the field
describes the crawl and not a run. That is what let the skill's `crawl.rulesRun`
block lose all three defensive caveats:

- *"The summary is the only route to `pagesScanned`; it is not on `crawl_status`."*
- *"It is `null` when you audited a crawl somebody else judged, and that is the
  correct value, not a hole."*
- the whole null-plus-caveat apparatus that made an auditor sum 21 rules' counts to
  prove 1,326.

All three were quote-and-replaced, in `ariadne-audit`, `ariadne-report` and
`ariadne-action-plan` (the third was found by review — the brief named the report
skill and the action plan restated the contract too). `"rulesRun": null` survives
for exactly one case: a crawl whose `rulesRunAt` is null, which is the refusal case
anyway.

**The equality's ground is a docstring, not a test**, and that is recorded as a
residual (§9). The page cursor selects on `crawl_id` alone with no filter and no
cap, and `pages` rows are immutable after the crawl stops — so the count *is* the
run's number. A future cursor filter would break the equality silently; the
docstring says what such a change owes.

---

## 5. Gate item 5 — the suite, the typecheck and the tree

Run at gate time on `b8ec554`, with `DATABASE_URL` pointing at the dev database:

| | |
|---|---|
| `npm test` | **1,440 tests passed / 63 files passed**, **358.26 s** wall (tests 657.71 s across workers, collect 36.31 s) |
| `npx tsc --noEmit` | **clean, 7.06 s** |
| `git status --porcelain` after the suite | **empty** |
| Ruleset | **0.7.0**; migrations 0000–**0012** |
| Rules registered | **85 = 26 page + 47 query + 12 metric** |
| Checklist coverage | 47 crawl-derived checks: **44 claimed, 3 agent, 0 unclaimed** — unchanged |

The suite grew 1,424 → 1,440 across the phase: +6 migration-0012 tests, +6
deep-page database tests and +6 caveat tests, +1 "no page rule reads discovery
depth" claim, +1 `pagesScanned`-on-an-unjudged-crawl test, −4 moved page-rule
tests, plus assertions added inside existing tests. File count 62 → 63 (the new
`test/db/migration-0012.test.ts`).

**A note for whoever runs this next:** `npm test` requires `DATABASE_URL` in the
environment. Without it 38 files fail in 23 s with
`DATABASE_URL must be set for db tests (no fallback)` — the rule-7 refusal working
exactly as designed, and not a broken tree.

---

## 6. The silent zero

The phase's surprise, found while extending a statement that was not suspected of
anything.

**A column interpolated into a `sql` template inside a select list renders
unqualified.** So

```ts
sql`(select count(*)::int from ${pages} where ${pages.crawlId} = ${crawls.id})`
```

came out as `where "crawl_id" = "id"` — and Postgres resolves **both** names in the
inner scope, against `pages.id`. The correlated subquery correlated with nothing.
Demonstrated directly against the reference data:

```sql
select id,
       (select count(*)::int from pages where crawl_id = id)           as broken,   -- 0
       (select count(*)::int from pages p where p.crawl_id = crawls.id) as correct  -- 551
from crawls where id = 'crawl_3f3ab847-…';
```

**The pre-existing `findingsCount` subquery was written the same way and was
correct only by accident.** `issues` has no `id` column — its identity is the
`issues_dedupe` unique index over `(crawl_id, rule_id, dedupe_key)` — so `"id"` had
nothing to bind to in the inner scope and fell out to `crawls.id`. **Add an `id`
column to `issues` and every judged crawl would begin reporting
`findingsCount: 0`: silently, with no error, reading as "the site is clean"** —
precisely the sentence the single-snapshot invariant exists to prevent. Latent,
not live: the shipped output was always correct.

Both subqueries are now built through the query builder, where `eq()` renders
`"pages"."crawl_id" = "crawls"."id"`, and the statement-level test in
`test/api/query.test.ts` pins both qualifications so the accident cannot come
back.

**The sweep is closed, and it needed no follow-up task.** The Task 3 reviewer
searched `src/` for the construct and found that **the fixed pair is the only
correlated-subquery-in-a-projection in the codebase** — every other raw subquery
binds a JS parameter or an explicit alias. No Phase 10 item is owed.

---

## 7. Owner decisions, recorded

Given 2026-08-29, carried into the plan's header, and honoured:

| Decision | How it shows up in this gate |
|---|---|
| **Scope is items 1–3 ONLY** of the proposed Phase 9 — the migration trio, the deep-page fix, `pagesScanned` | Three tasks, six commits, one schema event. Nothing else was taken; §8 lists what was refused. |
| **The gate is fixture-based** | §3 is demonstrated on the harness site and the rule's own suite; §5 is the whole suite. |
| **No client-site crawl this phase** | None was run. The three lavishalice crawls were read as migration-rehearsal data and never re-judged (§1, §3.1). |
| Plan approved verbatim | Executed task-by-task with review after each; two of the three tasks needed one fix round each. |

Two rulings made during execution, recorded because they shaped what is above:

- **Amend migration 0012 in place** rather than spend an 0013 on a shape this
  database has never held (§1.5). The three disclosure obligations that came with
  the ruling — timestamp-not-hash, zero rows matched here, `<> 'null'` chosen over
  `= 'array'` — are all discharged in the commit message and again here.
- **The `elapsedMs` correction rode along** in T3: `crawl_rules`'s MCP description
  documented a field `RunSummary` does not have and omitted two it does. Accepted
  on gate-record grounds — `phase-6.md` D-4 was recorded "Skill-fixed" when only
  the skill half ever was — **conditioned on the description being pinned**, which
  it now is, against the live summary's own keys plus a negative pin that
  `elapsedMs` appears nowhere.

---

## 8. Explicitly out of scope (owner's word, 2026-08-29)

Restated from the plan, unchanged, so nobody reads this gate as having taken them:

- **thin-floor per-template chrome calibration**;
- **a `content.csr-dependent`-firing fixture site**;
- **a no-sitemap fixture** proving a supplied sitemap cannot hide `sitemap.missing`;
- **CHECK-44's pages-considered count** for a silent rule;
- **everything in `phase-8.md` §15 item 8's carried list**.

All stay ledgered for Phase 10. They are not failures of this gate; they are work
the owner deferred.

---

## 9. Honest residuals, and the Phase 10 ledger

### 9.1 Two discrepancies found while writing this record

Both are findings, recorded rather than smoothed over.

1. **The two-audit silence is about two different numbers, and the ledger
   conflates them.** The SDD ledger and the task brief describe "356
   sitemap-discovered pages at discovery depth 1". Measured tonight (§3.1), the
   real shape is: **437** pages discovered via sitemap, **max discovery depth 1**
   across the whole crawl, and **356** indexable pages with a NULL `click_depth`
   (`phase-7.md` §4.4's number, which is unreachability, not depth). The silence
   was caused by the first two facts; the 356 is what the *distribution* metric
   found, and those 356 pages are precisely the ones the fixed rule still does
   **not** report. The rule's own docblock carries the loose phrasing too
   ("356 sitemap-discovered pages") — accurate enough as history, imprecise as
   arithmetic. Left as-is; named here so the next reader is not misled.
2. **The test-crawl leak in the dev database is larger than the ledger's "two".**
   The Task 1 review noted "two leaked one-page test crawls". Tonight the database
   holds **106 crawl rows: 3 lavishalice, and 103 test residue**, including 37
   finished one-page `127.0.0.1` crawls and 51 rows stuck in `running` on
   `https://runner.example`. This full-suite run left **exactly one** new row
   behind — `crawl_75ae3c13…`, whose stored config is
   `{maxPages: 1, findingCap: null}`. *(Correction, final review: the leaker
   is `test/api/mcp.test.ts` — its findingCap-null test never pushed the crawl
   id to `createdCrawls`, while `http.test.ts`'s helper tracks and deletes
   every id; proven by isolated runs, +1 for mcp alone, +0 for http alone.
   The original attribution to `test/api/http.test.ts:684` matched the config
   shape, which both tests share. Fixed at source in the final-review fix
   wave.)* So the pattern was **one leaked row per suite run**, accumulated over
   dozens of runs, plus an older family from the runner tests that never reach a
   terminal status. Pre-existing test hygiene, not this phase's doing, and it costs
   something real: `test/rules/run.test.ts` is the suite's long pole and its cost
   grows with what other files leave in `pages` and `links`.

### 9.2 Deferred minors, by task

Recorded at review time, deliberately not taken, restated so they do not go quiet.

| Task | Minor | Disposition |
|---|---|---|
| T1 | **0-row `UPDATE` unchecked** on both new writers (`render_urls_jsonb`, `template_inference_jsonb`) | **Carried.** A pre-existing pattern shared by `renderPassCount` — a rule-7-theme note, not a regression this phase introduced. |
| T1 | the task report's `is_indexable` vs `(is_indexable = true)` `indexdef` nit | **Carried**, report prose only; the live definitions in §1.4 are the record. |
| T2 | **home-page-vs-seed imprecision** in the copy and the `click-depth.ts` docblock (the BFS starts at the seed; the copy says "home page") | **Carried** — house convention, shared by the checklist. |
| T2 | pre-derivation-crawl silence (a crawl judged before `click_depth` existed reads as a site with no buried pages) | **RULED CLOSED.** Versioning is the answer: inside one `runRules` the derivation always precedes the rule, so the case cannot arise on a fresh run, and a skipped twin would be a rule that can never fire. |
| T3 | **the equality is documented, not tested** — a future page-cursor filter would diverge from `pagesScanned` silently | **Accepted.** A guard needs a fixture whose pages differ under the hypothetical filter; none exists. The docstring states what such a change owes. |
| T3 | report/action-plan behaviour under the rewritten contract is untested (the skills are prose; only the identifier guard and the shape equalities check them) | **Carried.** The next deliverable run is where the rewritten `rulesRun` block is actually exercised. |
| T2 | the identifier guard rejected `caveat.incompleteCrawl` in backticks in checklist prose (a dotted backticked token reads as a findings-file path) | **Reworded, guard behaving as designed.** The ergonomics item is below. |

### 9.3 Carried into Phase 10

1. **`MAX_CLICK_DEPTH = 50` nulls are invisible to both link-graph rules**, and
   `summary.derived.capped` — the flag that says the search hit the cap — is not
   exposed through the API. A page past 50 clicks is null for a third reason, and
   no surface distinguishes it from an orphan or an island.
2. **An all-null-`click_depth` hardening**: throw when a crawl has pages and
   *every* `click_depth` is null, as a derivation-never-ran detector. Proposed by
   the T2 reviewer, not built.
3. **`skills/ariadne-audit/checklist.md`:170** enumerates the `crawl_rules`
   summary as `{pagesScanned, findings, byRule, byMetric}` — missing `derived` and
   `metrics`; **:2316–2318** lists `crawl_status`'s pre-flight fields without
   `pagesScanned`. Incomplete rather than false, and the checklist is the imported
   living authority — a deliberate edit, not a ride-along.
4. **Identifier-guard filename ergonomics** (carried from Phase 8): a backticked
   dotted token is classified as a findings-file path, so legitimate field
   references like `caveat.incompleteCrawl` cannot be written in backticks in
   skill prose.
5. **The 0-row `UPDATE` pattern** on the two new writers, above.
6. **The dev-database test-crawl leak** (§9.1 item 2), including the `running` rows
   that no test ever finishes.

### 9.4 Phase 8 §15 items NOT taken this phase, and still open

By the owner's scoping decision (§7, §8), these remain exactly as `phase-8.md`
left them — restated here so the ledger stays visible:

- **The thin floor on unrendered pages** (§2.3 there): 537 pages still carry ~425
  words of class-hidden chrome in the number every thin rule reads, and the caveat
  travels with every thin number.
- **A site that fires `content.csr-dependent`** — reachable, never yet fired
  outside the fixture.
- **A no-sitemap fixture**, to prove supplying one cannot hide `sitemap.missing`.
- **CHECK-44 / D-8 pages-considered** for a silent rule: "complete markup
  everywhere" is still indistinguishable from "no markup anywhere".
- **Item 8's whole carried list**: the politeness event log (C-2, untested for the
  third crawl running); render-pass `blockedRequests` evidence (C-5); the
  scoped-run field (D-7); `renderPassCount`'s name (D-5); streaming metric rows;
  `hreflang.invalid-code` streaming; the browser tree's own bound; a report-numbers
  checker; the two remaining Phase 6 item-17 tasks; the `<br>`-merged `h1_text`;
  the template-ELEMENTS ruling; the plan-pinning / EXPLAIN mechanism;
  one-scan-for-three; the crawl-aging harness; the Talos `/2` note.

**Two of Phase 8's ledger rows closed here**, and it is worth naming which: §15
backlog item 1 (`structure.deep-page` reads discovery depth) and item 6
(`crawl_status.pagesScanned`, which retires `crawl.rulesRun`'s three defensive
caveats), plus all three rows of the Phase 9 migration ledger — the group-lateral
functional indexes, the render-selection column and the collapsed-marker column,
paid in one migration as that ledger asked.

---

## Machine

| | |
|---|---|
| CPU | Intel Core i5-6500 @ 3.20 GHz, 4 cores (no SMT) |
| RAM | 32 GB |
| Kernel | Linux 6.8.0-138-generic |
| Node | v22.23.2 |
| TypeScript | 5.9.3 |
| Postgres | 16, Docker container `ariadne-pg` on port 5440 |
| Suite | **1,440 tests, 63 files, 358.26 s wall** |
| `tsc --noEmit` | clean, 7.06 s |

## CI

Unchanged by this phase: `ubuntu-latest`, a health-checked `postgres:16` service,
Node 22, a cached `npx playwright install --with-deps chromium` keyed on the
locked Playwright version, then `npm ci` → `npx tsc --noEmit` → `npm run
db:migrate` → `npm test`, on push to `main` and every pull request.

**PR #8 opened against `main` on the owner's word**
(https://github.com/dawnforge-lab/ariadne/pull/8), on the Phase 7 and Phase 8
precedent (push, PR, CI link filled into this section, merge on the owner's
word).

**First CI run: GREEN, first try** —
https://github.com/dawnforge-lab/ariadne/actions/runs/33308036352 (3m57s,
1440/1440 across 63 files). Worth naming after Phase 8's lesson (its first run
caught a real planner-dependent lease defect): this run exercised the two
things the gate could not — **migration 0012 applied to an empty database**,
where the backfill's two `UPDATE`s match zero rows for a different reason than
they do here, and the three partial expression indexes created and used under
CI's fresh table statistics. Both held. The gate itself is not part of CI and
cannot be — it reads a third party's crawl data.

## Commit inventory

`74bc895..b8ec554`, seven commits including the plan:

| Commit | Role |
|---|---|
| `74bc895` | `docs:` the Phase 9 plan — the three tasks, the gate, the out-of-scope list |
| `052386b` | `feat:` migration 0012 — two `crawls` columns and three partial `btrim` indexes, the backfill, the writers and readers moved off `config_jsonb`, `RENDER_URLS_KEY` deleted (13 files, +2,206/−92) |
| `39e6358` | `fix:` the `jsonb_typeof` guard on the applied migration (§1.5), full-column-list index pins, a self-standing overwrite test, overwrite semantics in the column comment (3 files, +46/−10) |
| `0bcecd9` | `fix:` `structure.deep-page` becomes a query rule over `click_depth`; copy rewritten; ruleset 0.6.0 → 0.7.0; checklist and spec corrected (12 files, +477/−171) |
| `b0f4f26` | `fix:` the upper-bound truth and the per-finding caveat (`incompleteCrawl` / `failedPages`); `completeness()` gains a rule id; the orphan overclaim corrected in two places (5 files, +781/−555) |
| `eeb210a` | `feat:` `crawl_status.pagesScanned` as a third scalar in the one-snapshot statement; the silent-zero fix (§6); the audit skill's `rulesRun` contract rewritten; `phase-8.md`'s stale minors row closed (9 files, +208/−60) |
| `b8ec554` | `fix:` the action plan's copy of the retired caveat; a pin on the `crawl_rules` description (5 files, +37/−10) |

plus the commit carrying this file.

## Leftovers

**The three lavishalice crawls stay in the dev database**, unchanged and
unre-judged — every figure in §1, §2 and §3.1 was re-queried from their rows while
this file was written. Their two standing warnings are unchanged: `crawl_2af4daf1`
is not row-comparable to anything judged by ruleset 0.5.0 or later, and
`crawl_3f3ab847` is not row-comparable to `crawl_02ff6f7a` on any
`page_type`-scoped metric.

**A third warning joins them from this phase:** all three were judged under
rulesets that read *discovery* depth for CHECK-31. Their stored findings therefore
contain no `structure.deep-page` row, and re-judging any of them under 0.7.0 would
add one (§3.1) — the verdict change the version bump exists to make traceable.

The database also holds 103 rows of test residue (§9.1 item 2). Deleting any crawl
cascades:

```sql
delete from crawls where id = 'crawl_02ff6f7a-203c-4771-805c-feede04aed11';
```

# Phase 10 gate — the Talos surface, and what it is honest about

**Date:** 2026-09-01
**Code:** branch `worktree-phase-10-talos-surface`, base `dbd9c10` (the plan
commit, on `main` at `7144b6b` — PR #8 was merged before execution started, so
this phase is not stacked). The gate is demonstrated at **`f029f38`** with
ruleset **0.7.0** and migrations 0000–**0012** — no migration was spent this
phase (§3.6). Nine commits carry it:

| | |
|---|---|
| T1 `rules_catalog` | `72a60d6`, `399c082` |
| T2 `site.health` | `34b3151`, `0a46a29` |
| T3 `crawl_compare` / `compare_urls` / the site filter | `e7a246c`, `4c212aa` |
| T4 CSV exports | `1b6b57e`, `5f6be5c` |
| T5 the contract document + the tenant-safety sweep | `f029f38` |

plus `75a26d2` (a controller-owned skills-copy commit that landed mid-phase, see
§9) and the commit carrying this file.

**Every number in this document was measured while it was written** — `psql`
against the dev database on port 5440, two throwaway `tsx` scripts driving a
real `ApiService` and a real MCP client over the in-memory transport (both
deleted; nothing was written to the database by either), one full `npm test`, one
`npx tsc --noEmit`, one scoped `npx vitest run`, a Python `csv` re-parse of six
exported files, and `git`. **The exceptions are named at the point of use** and
there are five: T3's `EXPLAIN` timings (§3.6), T4's paired RSS runs (§4.3), the
mutation tables of T2 and T3 (§8.2), and the *before* half of the deletion
record (§7), which was measured by the controller at the moment of deletion and
cannot be measured again. Each is attributed where it is used.

**No site was crawled this phase.** The three `lavishalice.com` crawls are
reference data: read, never re-judged, never rewritten. `crawl_02ff6f7a`'s
`rules_run_at` is unchanged at `2026-09-01T08:51:55.386Z` — the stamp Phase 9
left.

**Verdict: PASSED.** All five gate items are demonstrated below. Three things to
read before them:

- **The plan's gate text was wrong in two places and the measurements
  supersede it**, both discovered by the tasks and both recorded here: the
  health buckets partition **443 auditable pages with 108 accounted for beside
  them**, not 551 (§2.1); and `crawl_2af4daf1` is **unjudged**, so it is the
  refusal demo and not half of the compare pair — the three crawls' findings are
  stamped 0.4.0 / 0.5.0 / 0.7.0, not "0.6.0 twice" (§3.1).
- **The phase's most useful negative result** is that nineteen of twenty-two
  rules reproduce to the URL across a re-crawl, a ruleset change and a re-judge
  (§3.3). Without that control, the three rules that moved would be noise.
- **The sweep found one real thing** and it was the kind a doc-writing task is
  supposed to find: a payload string citing one of this repository's own
  documents at a tenant (§6).

---

## What the gate is

The five items from `docs/superpowers/plans/2026-09-01-phase-10-talos-surface.md`,
measured fresh:

1. `rules_catalog` over a judged crawl — every rule, counts summing to
   `findingsCount`, and null-versus-zero demonstrated on an unjudged one.
2. `site.health` on the real crawl at 0.7.0 — the buckets partition the census,
   with the ratio documented.
3. The real comparison — `comparable: false` with both versions named and the
   counts present; the unjudged crawl refused; the deep-page finding appearing
   as `new`.
4. The six CSV views exported from the real crawl — row counts equal to the
   sources, RSS recorded, the injection guard demonstrated.
5. Full suite green, `tsc` clean, tree clean, dev-database crawl count
   unchanged.

---

## 1. Item 1 — `rules_catalog`: the checklist, and the three states of a count

Measured through the real MCP transport (a client over the SDK's in-memory
transport, against the dev database) and through `ApiService` directly.

### 1.1 The skeleton

```
rules_catalog {}            → 86 rules, rulesetVersion "0.7.0"
                              no `fired` key on any row
                              88,664 bytes of JSON (≈87 KB)
```

86 = 26 page + 47 query + 13 metric, pinned exactly in
`test/rules/coverage.test.ts:167`. The size is why the tool description tells an
agent that this is not a small answer and points at `issues_list` instead.

### 1.2 The judged projection, summing to `findingsCount`

`crawl_02ff6f7a` (judged 2026-09-01 at ruleset 0.7.0, uncapped):

```
86 rules, 22 with a non-zero count, counts summing to 17,659
select count(*) from issues where crawl_id = 'crawl_02ff6f7a…'  →  17,659
```

The sum equals the crawl's `findingsCount` exactly. 13 of the 86 rows carry
`{"count": 0, "measuresOnly": true}` — every metric rule, whose zero is
structural rather than a verdict — and the rest of the zeros are real cleans.

`crawl_3f3ab847` (judged at 0.5.0 under the default 200 cap):

```
86 rules, counts summing to 1,326  (= its findingsCount)
atLeast: true on exactly two rows —
  content.near-duplicate  {count: 500, atLeast: true}
  links.orphan            {count: 200, atLeast: true}
```

Those are the two rules the cap cut, and the flag says the count is a floor. **A
catalog count is rows written, never cases that exist** — the sentence the
contract document carries (`docs/talos-surface.md` §5.1) because the Phase 6 D-1
incident was an auditor quoting a floor as a fact.

### 1.3 Null versus zero, on real data

`crawl_2af4daf1` has `rules_run_at` null **and holds 1,314 issue rows** — the
coherent prefix a rules pass that did not complete leaves behind:

```
rules_catalog {crawlId: "crawl_2af4daf1…"}  →  86 rules, "fired": null on all 86
select count(*) from issues where crawl_id = 'crawl_2af4daf1…'  →  1,314
```

Not one of those 1,314 rows is reported as a count. That is the distinction the
whole surface turns on: rows on disk are not a judgement, and only
`rules_run_at` says a pass completed.

The third state is the absent key (§1.1). Refusals: an unknown crawl id is
`404 no such crawl 'crawl_nope'`, never the skeleton with a silently dropped
argument.

**Pinned:** `test/api/query.test.ts:1451`, `:1493`, `:1517`, `:1543`, `:1560`,
`:1599`; `test/api/mcp.test.ts:1167`, `:1249`. No test hardcodes 85 or 86 — the
counts are derived from `buildRegistry()`, which is why Task 2's new rule
changed no Task 1 test.

**ITEM 1: PASS.**

---

## 2. Item 2 — `site.health`: the rollup, and the plan's arithmetic corrected

### 2.1 The measurement, and what the plan got wrong

The rule was called directly against the reference crawls — read-only, its own
single grouped statement, nothing written:

| crawl | findings ruleset | urlsTotal | critical | warning-only | info-only | clean | cleanRatio | pagesNotAuditable |
|---|---|---|---|---|---|---|---|---|
| `crawl_02ff6f7a` | 0.7.0 | 443 | 0 | 400 | 32 | 11 | **0.0248** | 108 |
| `crawl_3f3ab847` | 0.5.0 | 443 | 0 | 313 | 99 | 31 | 0.0700 | 108 |
| `crawl_2af4daf1` | 0.4.0 (unjudged) | 443 | 0 | 299 | 109 | 35 | 0.0790 | 108 |

```
443 + 108 = 551 = select count(*) from pages where crawl_id = 'crawl_02ff6f7a…'
0 + 400 + 32 + 11 = 443                (the four buckets partition the census)
```

**The plan's gate line said "buckets partition 551". It is wrong and this
supersedes it.** The census is the *auditable* pages — fetched OK, 200, HTML —
which is 443; the other 108 decompose, re-queried tonight, into **97 × 404,
10 × 301 and one non-HTML 200**. Task 2 discovered this while measuring and added a seventh column,
`pagesNotAuditable`, rather than letting 108 pages disappear beside a gauge.
Talos is unaffected: an added key, no changed semantics.

**`pagesNotAuditable` lumps unlike things into one number on purpose.** It is a
remainder, not a taxonomy; which kinds those 108 are is a `pages_query`
question. One of them — a non-HTML 200 — is counted by **no other table at
all**, which is the other reason the column exists.

**`urlsWithCritical: 0` is structural, not flattering.** Only render-pass rules
carry `critical` severity and these crawls had no render pass, so that bucket can
barely be populated. Recorded here so nobody reads a zero there as "nothing
serious found".

**`cleanRatio` is a convenience and the four counts are the authority** — at
50,000 pages, four decimal places round one clean page to `0.0000`. The copy
says so, pinned by `test/rules/copy.test.ts:899`.

### 2.2 The row is not in the `metrics` table, and that is the point

`metrics_get {crawlId: "crawl_02ff6f7a…", metricId: "site.health"}` answers
`{"items": [], "nextCursor": null}`. The reference crawls were judged **before
this family existed**, so nothing wrote a row.

**An absent metric family is not a zero gauge.** It is the metric surface's
version of the catalog's null-versus-zero, and it is the residue of holding
`RULESET_VERSION` at 0.7.0 (which was the right call — `metrics` rows carry no
version column, so a bump would have claimed a verdict change that did not
happen). The contract document states it as a rule for consumers
(`docs/talos-surface.md` §5.2): read `rulesRunAt` first, then read absence as
"not measured".

The surface itself is exercised end to end where a rules pass really runs: the
fixture harness recomputes the rollup **page by page in JavaScript** from its own
maps and asserts it equals the metric's single grouped answer
(`test/fixtures/harness.test.ts:1707`).

### 2.3 The check id is a filing, and it is temporary

`site.health` carries `CHECK-32`. No check in `skills/ariadne-audit/checklist.md`
asks for a site-wide severity rollup — the closest statement in the file is
Evaluation Principle 2, which forbids answering a check from a crawl summary.
The id says **where the row is filed, not what it answers**, and the metric's
own `explanation` — the one string that travels to every consumer — says so.

This is an **explicitly temporary bridge**, ledgered with a Phase 11 handoff
(§11). It buys no coverage credit: CHECK-32 already had three claimants
(`links.orphan`, `links.orphan-skipped`, `structure.depth-distribution`),
`issues_list checkId=CHECK-32` resolves to the finding rules alone, and an agent
walking that check never meets this table.

**Pinned:** `test/rules/health-metrics.test.ts` (13 tests), `test/rules/copy.test.ts:851`,
`:884`, `:899`, `:917`, `:931` (including "grades nothing", asserted in both
directions).

**ITEM 2: PASS**, with the plan's arithmetic corrected in public.

---

## 3. Item 3 — the real comparison

### 3.1 The crawls, as they actually are

The plan and the Task 3 brief described these crawls wrongly; Task 3's
implementer verified rather than trusted, and the reviewer re-derived it from
SQL. Re-queried tonight:

| crawl | `crawls.ruleset_version` | findings' stamp | `rules_run_at` | findings |
|---|---|---|---|---|
| `crawl_2af4daf1` | 0.4.0 | 0.4.0 | **null** | 1,314 |
| `crawl_3f3ab847` | 0.5.0 | 0.5.0 | 2026-08-28T21:55:35Z | 1,326 |
| `crawl_02ff6f7a` | **0.6.0** | **0.7.0** | 2026-09-01T08:51:55Z | 17,659 |

Two consequences the surface is built on: `crawl_2af4daf1` **cannot** be half of
a comparison (it is the refusal demo), and a crawl's own `ruleset_version` is not
what judged it — `crawl_02ff6f7a` was crawled under 0.6.0 and re-judged under
0.7.0, which is why `crawl_compare` reads the version off the **findings**.

### 3.2 The comparison, run tonight

`crawl_3f3ab847` (base, 0.5.0, capped 200) → `crawl_02ff6f7a` (head, 0.7.0,
uncapped):

```
comparable: false
caveats:    ruleset-mismatch, finding-cap-differs      (both, not one)
base:  rulesetVersions ["0.5.0"], findingCap 200,  findingsCount 1326
head:  rulesetVersions ["0.7.0"], findingCap null, findingsCount 17659
rules: 22
```

Both caveats fire. That is the widening Task 3 argued for and the review upheld:
`comparable = rulesetsAgree AND capsAgree`. The narrow reading would have handed
Talos `comparable: true` over 43 "new" orphans that are an artefact of the base
crawl's cap.

### 3.3 All 22 rows, and the three that moved

| rule | sev | baseCount | headCount | baseUrls | headUrls | new | resolved | persisting | baseTrunc |
|---|---|---|---|---|---|---|---|---|---|
| `content.exact-duplicate` | warning | 2 | 2 | 2 | 2 | 0 | 0 | 2 | |
| `content.near-duplicate` | warning | 500 | 16789 | 186 | 281 | **95** | 0 | 186 | **yes** |
| `content.placeholder` | warning | 3 | 3 | 3 | 3 | 0 | 0 | 3 | |
| `h1.duplicate-text` | warning | 4 | 4 | 4 | 4 | 0 | 0 | 4 | |
| `headings.h1-missing` | warning | 19 | 19 | 19 | 19 | 0 | 0 | 19 | |
| `hreflang.missing-return-link` | warning | 2 | 2 | 2 | 2 | 0 | 0 | 2 | |
| `links.broken-internal` | warning | 97 | 97 | 97 | 97 | 0 | 0 | 97 | |
| `links.orphan` | warning | 200 | 243 | 200 | 243 | **43** | 0 | 200 | **yes** |
| `meta-description.duplicate` | warning | 3 | 3 | 3 | 3 | 0 | 0 | 3 | |
| `meta-description.missing` | warning | 107 | 107 | 107 | 107 | 0 | 0 | 107 | |
| `title.duplicate` | warning | 5 | 5 | 5 | 5 | 0 | 0 | 5 | |
| `canonical.points-elsewhere` | info | 2 | 2 | 2 | 2 | 0 | 0 | 2 | |
| `headings.h1-multiple` | info | 1 | 1 | 1 | 1 | 0 | 0 | 1 | |
| `headings.level-skip` | info | 9 | 9 | 9 | 9 | 0 | 0 | 9 | |
| `images.missing-alt` | info | 4 | 4 | 4 | 4 | 0 | 0 | 4 | |
| `images.missing-dimensions` | info | 11 | 11 | 11 | 11 | 0 | 0 | 11 | |
| `meta-description.too-long` | info | 240 | 240 | 240 | 240 | 0 | 0 | 240 | |
| `meta-description.too-short` | info | 8 | 8 | 8 | 8 | 0 | 0 | 8 | |
| `pages.not-in-sitemap` | info | 6 | 6 | 6 | 6 | 0 | 0 | 6 | |
| **`structure.deep-page`** | info | **0** | **1** | **0** | **1** | **1** | 0 | 0 | |
| `title.too-long` | info | 61 | 61 | 61 | 61 | 0 | 0 | 61 | |
| `title.too-short` | info | 42 | 42 | 42 | 42 | 0 | 0 | 42 | |

- **`structure.deep-page` 0 → 1 as `new`** — the gate's named case, and the rule
  `docs/gates/phase-8.md` §11 recorded as silent for two audits running. Its
  drill-down was walked tonight: `compare_urls {ruleId: "structure.deep-page",
  set: "new"}` returns exactly `https://lavishalice.com/collections/sequin-dresses`
  with `nextCursor: null`.
- **`links.orphan` +43 and `content.near-duplicate` +95 are cap artefacts, and
  the payload says so without a reader having to know the history**:
  `baseTruncated: true` on both rows, the caps on the sides, and the
  `finding-cap-differs` caveat spelling out the reading.
- **Zero `resolved` anywhere.** Nothing was fixed between the two crawls. The
  site did not change; the engine's cap and ruleset did.
- **Both invariants hold on all 22 rows** — `headUrls == new + persisting` and
  `baseUrls == resolved + persisting` — checked tonight by the verification
  script rather than by the API.

`content.near-duplicate`'s 16,789 rows over 281 URLs is the per-URL collapse in
one line: 33× the rows, 1.5× the URLs. The comparison is over URLs, and the
contract document says so where Talos will read it.

### 3.4 The refusal, run tonight

```
crawl_compare {base: crawl_2af4daf1…, head: crawl_02ff6f7a…}
→ "'crawl_2af4daf1…' has never been judged (rulesRunAt is null), so there is
   nothing to compare — run the rules over it first. Findings already in the
   table belong to a pass that did not complete"

crawl_compare {base: crawl_02ff6f7a…, head: crawl_02ff6f7a…}
→ "…a crawl compared with itself reports every rule as persisting and every
   change as zero, which is not a fact about the site"
```

Had the unjudged crawl been diffable, its 1,314 rows would have made the head
crawl's entire findings list read as `new`.

**The self-compare refusal has a UI consequence** and it is in the contract
document: a compare screen that defaults both pickers to the newest crawl gets a
400 on first render. Talos should default the two sides to different crawls.

### 3.5 The site filter

`crawl_list {siteUrl: "https://www.lavishalice.com/deep?a=1"}` returns exactly
the three lavishalice crawls — apex ↔ `www`, either scheme, any path, through
the crawler's own `hostnameSpellings`.

### 3.6 No migration was spent

**Attributed to the Task 3 report** (not re-measured tonight): the summary
statement plans at 42.8 ms with the two side scans as the whole cost, the worst
drill-down page at 12.9 ms, and the site filter at 1.1 ms. The one optimisation
taken was removing a `distinct` aggregate that sorted the 17,659-row side —
143 ms → 41.8 ms, 3.4×, and the term that went away is the one that would have
spilled to disk on a 50k crawl. The only candidate index would have been written
on every findings insert to save ~10 ms on a 40 ms read. **Migration 0013 is not
spent; migrations remain 0000–0012.**

**ITEM 3: PASS.**

---

## 4. Item 4 — the six CSV views

### 4.1 Exported tonight from `crawl_02ff6f7a`

| view | rows | bytes | ms | source, counted independently in SQL |
|---|---|---|---|---|
| `issues` | 17,659 | 5,315,760 | 330 | `issues` for the crawl = **17,659** |
| `issue_urls` (`links.orphan`) | 243 | 29,521 | 5 | that rule's rows = **243** |
| `internal_urls` | 551 | 71,899 | 11 | `pages` = **551** |
| `links_to_4xx` | 99 | 15,076 | 10 | internal links to a `client_error` page = **99** |
| `anchor_texts` | 35,145 | 4,664,393 | 884 | `links` from the crawl's pages = **35,145** |
| `redirects` | 10 | 2,034 | 15 | pages with a 3xx status = **10** |

**Every row count equals its source exactly.**

### 4.2 Re-parsed independently

All six files were written to disk and re-read with **Python's `csv` module** —
not with the writer that produced them:

```
anchor_texts    35,145 rows  3 cols  uniform  3 quoted lines
internal_urls      551 rows  7 cols  uniform  14 quoted lines
issue_urls         243 rows  3 cols  uniform
issues          17,659 rows  7 cols  uniform  189 quoted lines
links_to_4xx        99 rows  4 cols  uniform
redirects           10 rows  4 cols  uniform
```

Uniform column count per file, exact row counts, quoted cells round-tripping.
Zero guarded cells on this crawl — the site publishes no hostile string, which
is why the injection guard is demonstrated on the fixture instead (§4.4).

### 4.3 Memory

RSS sampled every 5 ms across each export, in one process, in the order above:

| view | rows | RSS before | peak | growth |
|---|---|---|---|---|
| `issues` | 17,659 | 213.3 MB | 220.2 MB | 6.8 MB |
| `anchor_texts` | 35,145 | 220.2 MB | 220.3 MB | **0.1 MB** |
| the other four | — | 220.2 MB | 220.3 MB | 0.0 MB |

**The first view measured in a process absorbs its first-touch allocation**,
which is exactly what Task 4 disclosed when its two runs disagreed on
`anchor_texts` (2.5 MB then 8.8 MB — *attributed to the T4 report*). Tonight the
order was reversed and so was the asymmetry: `issues` went first and paid the
6.8 MB, `anchor_texts` produced **4.7 MB of file for 0.1 MB of growth**. The
invariant, in both orderings and both reports: growth is a few MB whatever the
row count, and for one view the output file is larger than all the RSS growth
that produced it — arithmetic that is impossible if rows were materialised.
`EXPORT_BATCH` is 500; the memory is O(batch).

### 4.4 The injection guard, on the fixture

Run tonight, `test/api/query.test.ts:1889` ("never lets a crawled string become a
formula"): a fixture page whose title is `=SUM(1+1)` and a link whose anchor is
`=cmd|' /C calc'!A0` come back as `'=SUM(1+1)` in the parsed cell, with the raw
bytes asserted to carry `,'=SUM(1+1)` and **not** `,=SUM(1+1)`. The guard looks
past leading whitespace and guards the original bytes.

### 4.5 What the files mean, restated because a correct file can be misread

- `links_to_4xx` is **internal links only** — the status comes from the target's
  own crawled row, so an **external 4xx is absent from the file rather than
  clean**.
- `redirects` is **one row per redirecting page**, not per chain: `a → b → c` is
  two rows.
- The `evidence` cell is a **bounded summary** (12 leaves / 120 chars per value /
  500 per cell, dropped leaves counted as `+N more`), not the evidence; the full
  blob is on `issues_list` / `issue_urls`.

All three are now in the tool description as well as the contract document,
because an agent quoting the file would otherwise misreport a site from a file
that is itself correct.

### 4.6 The tear, not the truncation

Everything refusable is refused **before the first byte** — including the case
Task 4's review found, a crawl holding a retired rule id, which used to throw
inside the row generator after the header. After the header there is no status
left to send, so a mid-stream failure destroys the connection. That path is
tested and non-vacuously so: swapping `res.destroy()` for `res.end()` fails with
the four-line CSV printed in the assertion message
(`test/api/http.test.ts:1363`).

**ITEM 4: PASS.**

---

## 5. Item 5 — the suite, the typecheck, the tree, the database

```
npm test          →  1568 passed, 65 files, 0 failed          (100.05 s wall)
npx tsc --noEmit  →  clean                                     (7.3 s)
git status        →  clean at f029f38
select count(*) from crawls  →  139
```

Baseline at the start of this task was 1,563 / 65; this task added five tests
(three cross-transport, two tenant-safety). The dev database's crawl count is
**139 before and after** — the leak fix holds, and no gate script wrote a row.

**The suite wall time fell from ~400 s to ~100 s during this phase**, and the
reason is the owner's deletion in §7, not anything about the tests.

**ITEM 5: PASS.**

---

## 6. The tenant-safety sweep (obligation 6)

Every response shape and every error body added by T1–T4 was read and grepped
for internals: stack frames, absolute paths, repository documents, connection
strings, internal hostnames, and anything derived from a caught error's message.

**One finding, fixed in `f029f38`.** The `ruleset-mismatch` caveat said:

> …The rows are NOT row-comparable in the sense **docs/gates/phase-8.md §7.2**
> sets out; read each side as its own report

A caveat is a **payload string**: a Talos dashboard renders it to a tenant who
has no such file and learns from it only that this engine keeps documents
somewhere. The message now makes the claim in its own words; the citation moved
into the code comment beside it, where a reader can follow it. The test that
pinned the citation now pins the meaning.

**Two postures recorded rather than changed**, both pre-existing and both in the
contract document (§9 there):

1. **`export_crawl`'s file-writing mode answers with an absolute server path.**
   That is the answer to a tool whose job is to write a file, and its audience is
   an operator. A tenant-facing Talos surface should use the HTTP CSV stream,
   which returns bytes and no path.
2. **`pages_query.renderError`** is the only field whose text originates in our
   browser rather than on the site. It is the first line of the error, never a
   stack, but it is a diagnostic string and not client copy.

**And one obligation that is NOT met, stated as a posture rather than left to be
discovered:** there is **no tenancy isolation on crawl listing**. `crawl_list`
without a `siteUrl` returns every crawl this engine holds — other tenants'
`siteUrl`s included — to any caller with the token. Every *per-crawl* read is
scoped by id (obligation 3 holds there); the listing is scoped by nothing.
Today's mitigation is deployment: one Ariadne per tenant, or a Talos-side proxy
that always passes `siteUrl`. A per-caller scope is a real change to this
surface and it was not in this phase.

**The sweep is now two standing guards** rather than something somebody did once:

- `test/api/query.test.ts:2640` walks fourteen live answers (eight of them
  refusals) and `:2675` walks four CSV exports, failing on any stack frame,
  absolute path, repository document, connection string or private host. It fails
  on the caveat above when the fix is reverted — demonstrated.
- `test/api/mcp.test.ts:1915` / `:1931` / `:1988` — the cross-transport
  equality the T1 review asked for (Finding B): twelve (tool, route) pairs
  compared `toEqual` over the wire, five refusals compared sentence-for-sentence
  and status-for-status, and the streamed CSV asserted byte-identical to the file
  the tool writes. Three transport-level mutations, three kills (a field added to
  a route's body, a `code` added to the HTTP error body, a truncated stream).

---

## 7. The dev database, and one deletion — recorded

Task 3 found that a single abandoned crawl (`crawl_8884258e`, a 2026-08-27
scale-test against a fixture server that is long gone, `status: running`,
`pages_crawled: 0`, zero issues and zero metrics) held **757,923 links — 85% of
the whole `links` table** — and was distorting every `ANALYZE` the rule runner
ran, which is what made a full suite take tens of minutes.

**The owner approved deleting it. The controller executed it.** The record:

| | crawls | links | pages | database |
|---|---|---|---|---|
| before *(controller's measurement at deletion)* | 140 | 893,160 | 38,673 | 954 MB |
| after *(controller)* | 139 | 135,237 | 5,727 | 948 MB |
| **tonight** | **139** | **135,237** | **5,727** | 954 MB |

One row deleted, every foreign key cascading, then `VACUUM ANALYZE` on `links`,
`pages` and `frontier`. Heap space is reusable rather than returned to the OS —
deliberate, no `VACUUM FULL`, which is also why the file size has climbed back
to 954 MB tonight while holding a twentieth of the rows: the phase's test runs
wrote and deleted their fixtures into the space the deletion freed.

No test referenced the deleted crawl, and the suite wall fell from ~400 s to
112.6 s immediately afterwards.

**Consequence for every measurement after it:** T4's export RSS and this gate's
numbers run on honest table statistics for the first time. The rule that came
out of it, and that this phase applied: **delete with a record, or do not
delete.**

---

## 8. Practices worth naming before they become habit

### 8.1 Tests written after the implementation, two tasks running

**A correction first, because the ledger's own note is wrong.** The phase ledger
records the pattern as running in T2, T3 *and* T4. The reports say otherwise:
T2 and T3 each open their evidence section with "the implementation was written
before the tests in this session", while **T4 quotes genuine pre-implementation
red runs** (`Cannot find module '../../src/api/csv.js'`; 11 HTTP tests failing
with `unknown query parameter 'format'`; 4 MCP tests failing on the SDK's schema
validator), as T1 did. So it is **two tasks, not three**.

Where the red run was missing, each guard was proved to bite by **mutation**
instead — 7 mutations in T2, 13 in T3 plus 4 in its fix round — and each
reviewer weighed the substitute and accepted it on the evidence. T4's fix round
added two revert demonstrations of the same kind (the pre-header refusal, and
`res.destroy()` swapped for `res.end()` printing the four-line CSV).

**Naming it here because two in a row is a pattern and not an incident.**
Mutation testing after the fact answers "does this test bite", which is the
property that matters most — but it does not answer "was this test written to a
specification, or to the code that already exists". The two failures a red-first
run catches and a mutation run does not are the assertion that encodes a bug as
intended behaviour, and the requirement nobody implemented and therefore nobody
tested. T1, T4 and T5 were red-first (T5's two guards were each demonstrated
failing against the un-fixed code before they were kept). The next phase should
default back to red-first and treat mutation as the fallback it was used as
here.

### 8.2 A mutation table is a claim like any other

T3's review noted that the per-row failure counts in the T3 mutation table were
not all independently verified — one row's count is a derivation rather than an
observation. T2's report carried a correction of the same shape: a mutation
reported as failing one test fails **two** suite-wide, because the report's runs
were scoped to one file. Both corrections are in the reports, dated and inline.
The lesson is small and worth keeping: **say which scope a mutation run had**,
because a scoped run reported as a suite-wide one overstates the guard.

---

## 9. Owner decisions, recorded

1. **The Talos-integration read surface is in scope; change tracking is in
   scope; resource fetching is APPROVED and deferred to Phase 11** with its own
   plan and gate (2026-09-01, in the plan).
2. **Health is ingredients plus a documented ratio, with NO labels.** Held
   everywhere: no grade, no score, no threshold, in the row or in the copy, and a
   copy test asserts it in both directions.
3. **Ariadne streams CSV**; the dashboard downloads bytes.
4. **The agent audit flow is untouched this phase.** This is what kept the
   checklist closed to a new check for `site.health` (§2.3).
5. **Mid-phase (2026-09-01): the action-plan workbook is not a standard
   deliverable.** Two consumption modes — an agent conversationally, and the
   Talos web surface (issues split by priority and severity, exports on request).
   Landed as `75a26d2`, skills prose only. It also made the parked CHECK-40
   G-gate question moot: nothing urgent can be cut from a web view that shows
   everything.
6. **Delete the abandoned crawl, with a record** (§7).

---

## 10. Honest residuals

### 10.1 Carried minors, by task

| From | Item | Status |
|---|---|---|
| T1 | per-request re-sort of the registry-derived ordered list | deferred |
| T1 | empty-string `crawlId` → 404 `no such crawl ''` | noted, no action (transparent) |
| T2 | `pagesNotAuditable` lumps unlike things | documented (§2.1, contract §6) |
| T2 | an absent metric family is not a zero gauge | documented (§2.2, contract §5.2) |
| T2 | `urlsWithCritical` structurally near-empty | documented (§2.1) |
| T3 | the `pageUrl`-evidence guard is runtime-scoped; a never-firing rule is not covered by it | disclosed in the test's own comment |
| T3 | near-duplicate URLs are pair representatives | documented (contract §7.1) |
| T3 | `crawls` has no index on the site URL — a sequential scan (1.1 ms over the 153 rows the table held when T3 measured it; 139 today) | recorded, not built — no measurement earns it |
| T4 | the hostile-title fixture is seeded rather than crawled | noted, no action (file convention; the parser suite covers the crawl half) |
| T4 | the uniform injection guard would render a negative number as `'-3` | deliberate trade, documented in the module header |
| T4 | evidence caps (12 / 120 / 500) are judgement calls | exported constants, asserted against rather than hardcoded |

### 10.2 Two things this gate could not demonstrate

- **`ruleset-mixed` and `severity-changed` are not exercised by real data.** No
  crawl in the dev database holds findings from two ruleset versions, and no rule
  moved severity between the reference crawls. Both have behavioural fixture
  tests (`test/api/query.test.ts:2360`, `:2307`); neither has been seen in the
  wild.
- **A 50k-page crawl.** Every memory claim here is structural (keyset cursors,
  O(batch) reads, at most one row per rule crossing into the process) plus a
  551-page measurement. The Phase 6 gate's 50k crawl remains the last real
  measurement of the memory contract.

---

## 11. Phase 11 pointers

1. **Resource fetching** (owner-approved, own plan and own gate): a resources
   table and page↔resource edges, HEAD-first fetching under the **same per-host
   politeness budget as pages** (one host queue, not two), size/status/
   content-type recorded, byte caps, dedup by URL across pages — and the
   Ahrefs-parity rules it unlocks (image weight, broken resources, page weight).
   It needs its own real-site gate. Until then, `docs/talos-surface.md` §10 says
   plainly that an absent resource finding means *not measured*.
2. **The `CHECK-32` bridge** (§2.3): the eventual home for `site.health` is an
   **owner-designed** checklist check about the engine's own coverage — evidence
   completeness — not a health rollup. Moving the claim is one line in
   `src/rules/metric/health-metrics.ts`, and the module header names both places
   the id is written.
3. **Identifier-guard ergonomics.** `test/skills/identifier-guard` scans
   `skills/**` for tool and rule names. It does not scan `docs/**`, so
   `docs/talos-surface.md` — which now names every tool and several rule ids — is
   held only by the citations in it and by review. Widening the guard to the
   contract document is a small, cheap piece of Phase 11 hygiene.
4. **Tenancy.** §6's third posture is the one a multi-tenant Talos deployment
   will meet first. Scoping the listing is a schema question (a tenant key on the
   crawl row) as much as an API one, and it should be decided before Ariadne
   serves two tenants from one process.

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
| Suite | **1,568 tests, 65 files, 100.05 s wall** |
| `tsc --noEmit` | clean, 7.3 s |

## CI

Unchanged by this phase: `ubuntu-latest`, a health-checked `postgres:16`
service, Node 22, a cached `npx playwright install --with-deps chromium` keyed
on the locked Playwright version, then `npm ci` → `npx tsc --noEmit` →
`npm run db:migrate` → `npm test`, on push to `main` and every pull request.

**PR #9 will be opened against `main` on the owner's word**, on the Phase 7, 8
and 9 precedent (push, PR, the CI run linked into this section, merge on the
owner's word). *This section is a placeholder until that run exists; the gate
above stands on the local measurements.*

The gate itself is not part of CI and cannot be — it reads a third party's crawl
data.

## Commit inventory

`dbd9c10..f029f38`, eleven commits including the plan:

| Commit | Role |
|---|---|
| `dbd9c10` | `docs:` the Phase 10 plan — five tasks, the gate, the out-of-scope list |
| `75a26d2` | `docs:` the action plan becomes an on-request deliverable (controller-owned, skills prose only) |
| `72a60d6` | `feat(api):` `rules_catalog` on both transports — the fired state, one grouped query, the three states of a count |
| `399c082` | `fix(api):` `measuresOnly` on a metric row, the route-table clauses, an honest size statement |
| `34b3151` | `feat(rules):` `site.health` — the census, the four buckets, the ratio, `pagesNotAuditable` |
| `0a46a29` | `fix(rules):` the caveats reach the consumer — the filing disclaimer, the open remainder, counts-are-the-authority |
| `e7a246c` | `feat(api):` `crawl_compare`, `compare_urls`, the site-scoped `crawl_list` |
| `4c212aa` | `fix(api):` the inverted `set` gloss, the unstamped-sides guard, the mixed-ruleset test, the provenance paragraph, the `pageUrl` guard |
| `1b6b57e` | `feat(api):` CSV exports — six views, keyset-streamed, RFC 4180 with the injection guard |
| `5f6be5c` | `fix(api):` the refusal moves before the header; the tear pinned against `end()` |
| `f029f38` | `docs:` the contract document, the tenant-safety sweep and its two standing guards |

plus the commit carrying this file.

## Leftovers

**The three lavishalice crawls stay in the dev database**, unchanged and
unre-judged — every figure in §1–§4 was re-derived from their rows tonight. Their
standing warnings from Phase 8 and 9 are unchanged, and Phase 10 adds one that is
now machine-readable rather than folklore: **`crawl_3f3ab847` and
`crawl_02ff6f7a` are not row-comparable**, and asking the engine says so —
`comparable: false` with `ruleset-mismatch` and `finding-cap-differs`.

`crawl_2af4daf1` remains the unjudged crawl with 1,314 rows on disk. It is worth
keeping exactly as it is: it is the only real-data demonstration this repository
has of the state that makes "no findings" and "nobody looked" different sentences.

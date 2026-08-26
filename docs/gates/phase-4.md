# Phase 4 gate — ten metric rules, quotable, and the whole pipeline at 50k

**Date:** 2026-08-26
**Code:** branch `worktree-phase-4-metrics` at `e5853f1` (the last coverage
commit), plus the commit that adds `scripts/gate-rules.ts` and this file. **Every
number below was measured on exactly that tree, in the run whose output is
quoted verbatim** — the gate script is new code, but it only starts the fixture,
calls `runCrawl` and `runRules`, and reads a stopwatch. Nothing here is carried
over from an earlier session's claim; that is the provenance lesson Phase 3's
gate doc paid for and this one obeys without exception.
**Verdict:** PASSED. The build plan's Phase 4 gate — *"each metric renders as a
table an agent can quote directly, with no post-processing needed to answer the
checklist's `Record:` lines"* — is mechanised in the fixture harness. The
standing 512MB contract, extended for the first time to the **whole** pipeline
(crawl *and* rules in one process over 50,000 pages), holds at **387.4 MB**.

**10 metric rules** join the 64 Phase 3 left, taking the ruleset to **74**. The
coverage pin falls from **7 unclaimed to 3** — the render three, and nothing
else. The full suite is **878 tests across 48 files, green**, with
`tsc --noEmit` clean.

## How to reproduce

```bash
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm run db:migrate
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne \
  node --max-old-space-size=512 --import tsx scripts/gate-rules.ts
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm test
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npx tsc --noEmit
```

`scripts/gate-rules.ts` serves the same deterministic 50,000-URL site Phase 1
used (`test/gate/site-server.ts`), crawls it with Phase 1's gate config —
`maxConcurrency: 16`, `perHostDelayMs: 0` (the fixture's own robots.txt says
`Crawl-delay: 0`), `probeHosts` left at its default (on), `allowPrivate: true`
for the loopback fixture, and `maxPages` given 10% headroom so the *site* ends
the crawl (Phase 1 finding 3) — and then runs the real `runRules` over the crawl
it just wrote. `GATE_PAGES=<n>` runs a smaller version for development and is
labelled loudly as not the gate; `GATE_CRAWL_ID=<id>` runs the rule pass alone
over a stored crawl and is labelled the same way, because without the crawl in
the same process there is no whole-pipeline peak to report.

**The fixture web server is closed the moment the crawl ends**, before the rule
pass starts. Hard rule 2 says a rule never fetches; on this run a rule that
tried would have got a connection refused rather than a page.

## The gate run

```
PHASE 4 GATE — full pipeline over 50,000 pages, peak RSS must stay under 512MB
node v22.23.2, flags --max-old-space-size=512 --import tsx
ruleset         74 rules — 26 page, 38 query, 10 metric
fixture site    50,000 URLs, crawl budget 55,000

— crawl phase —
crawl id        crawl_bbc5123b-bdb2-4777-beef-702a0c2cd4d2
status          finished
pages crawled   50,000
frontier        pending 0, leased 0, done 50000, failed 0
elapsed         666.6s
throughput      75.0 pages/sec
peak RSS        184.4 MB (at +604s)
fixture         closed — the rule pass has no site to fetch from
pages rows      50,000
links rows      1,149,940

— rules phase —
pages scanned   50,000
findings        5,346
metric rows     200,022
wall total      87.8s
  page rules    3.4s  (3.8%)
  derivations   5.3s  (6.1%)
  query rules   45.7s  (52.1%)
  metric rules  33.3s  (38.0%)
  unaccounted   0.0s
peak RSS        387.4 MB (at +78s)
issues rows     5,346
metrics rows    200,022

PEAK RSS        387.4 MB across both phases (at +745s), contract 512 MB

GATE PASSED
```

### The crawl half, against Phase 1

| | Phase 1 (2026-08-25) | Phase 4 (this run) |
|---|---|---|
| Pages crawled | 50,000 of 50,000 | 50,000 of 50,000 |
| Links written | 1,149,940 | **1,149,940** — identical, to the row |
| Elapsed | 825.3s | 666.6s |
| Throughput | 60.6 pages/sec | 75.0 pages/sec |
| Peak RSS | 169.5 MB | **184.4 MB** |

The crawl costs **14.9 MB more** than it did in Phase 1 (+8.8%, still 36% of the
contract). That is not drift in the memory contract — it is the crawler having
grown since: the discovery, host-probe and not-found-probe evidence blobs on the
`crawls` row (Phase 3, migrations `0003`–`0005`) and the two normalised URL
columns (Phase 4 Task 1, migration `0006`) are all written by this crawl and
were not written by Phase 1's. RAM is still O(concurrency): the fixture, the
config and the concurrency are unchanged and 748 MB of HTML still passes through
a process that peaks under 200 MB. Throughput is a fact about this machine on
this afternoon and should not be read as a capability claim in either direction.

### The rules half — the first measurement at scale

**Wall time is recorded, not gated.** This is the first end-to-end rule pass at
50k, so it sets the baseline rather than testing one. Only peak RSS is gated.

| phase | wall | share | what it covers |
|---|---|---|---|
| page rules | 3.4s | 3.8% | 26 page rules × 50,000 pages, plus the page cursor's 100 selects and the issue flushes between batches |
| derivations | 5.3s | 6.1% | `deriveUrlParams` + `deriveFieldPresence` (plus the loop's final empty page select and its last flush — two round trips inside a figure made of two full-table passes) |
| query rules | 45.7s | 52.1% | 38 query rules, exact |
| metric rules | 33.3s | 38.0% | 10 metric rules, exact |
| **total** | **87.8s** | | the runner's preamble accounts for the 0.0s residual |

How the phases were timed: the gate script hands `runRules` the **real
registry** with each rule's `run` wrapped in a stopwatch and each phase's first
`byKind` call timestamped. Nothing in `src/` gained a hook for this — the
pipeline under measurement is the pipeline that ships. The wrapper's cost is two
`performance.now()` calls per rule invocation, 1.3M of them in the page phase,
tens of milliseconds in total.

**RSS sampling** is Phase 1's, unchanged: `process.memoryUsage.rss()` every 2s
inside the process, plus a reading taken at each phase boundary so a phase peak
is never the neighbouring phase's. The process peak (387.4 MB, at +745s) landed
**inside the metric phase** — 78s into an 87.8s rule pass whose metric phase
began at 54.4s.

```
— slowest 12 rules —
18.45s          hreflang.missing-return-link (query)
18.32s          hreflang.non-indexable-target (query)
10.90s          inlinks.sources-by-type (metric)
3.85s           inlinks.distribution (metric)
3.09s           inlinks.extremes (metric)
2.21s           canonical.non-indexable-target (query)
2.07s           canonical.non-200-target (query)
1.48s           content.template-similarity (metric)
1.28s           content.metrics-by-type (metric)
0.75s           structure.depth-distribution (metric)
0.70s           pages.not-in-sitemap (query)
0.67s           robots.blocks-sitemap-urls (query)
```

The two hreflang join rules are 80% of the query phase between them: this
fixture publishes two alternates on every page, so they join a 100,000-row
`hreflang` table against 50,000 pages twice over. Everything below rank 12 is
under 0.6s.

### Repeatability

The same rule pass was run a second time over the stored crawl
(`GATE_CRAWL_ID=…`, labelled not-the-gate): **89.9s** wall (page 3.0s,
derivations 5.0s, query 44.8s, metric 37.0s), peak RSS **357.2 MB**, and
**identical** results — 5,346 findings, 200,022 metric rows, the same slowest
twelve in the same order but for one swap inside the two canonical rules that
are 0.3s apart. That is the runner's re-run contract observed rather than
asserted: `issues` absorbed the repeat through `issues_dedupe`, and each metric
rule's delete-then-insert produced its row set again to the row.

## Phase 3's mandated re-measures, at 50k

Phase 3's gate doc carried three duplicate-detection timings from a 5,000-page
synthetic corpus and asked, in as many words, for them to be re-measured here
before anyone assumed the 50k rule pass was free. Measured:

| | Phase 3 (5k corpus, Task 7) | Phase 4 (50k, this run) |
|---|---|---|
| `content.near-duplicate`, as the rule runs it | 0.11s healthy / 521ms band-skew | **0.06s** (rank 24 of 74) |
| the same banding join **uncapped** | not measured | **23.6s, 481,745 pairs** |
| `content.template-similarity` | not measured at scale | **1.48s** |

**0.06s is the cap doing its job, not the join being cheap.** The rule's query
carries `limit ${NEAR_DUPLICATE_PAIR_CAP + 1}` — 501 — and on this fixture it
finds its 501 rows almost immediately, reports 500 pairs and stops. To measure
what the join actually costs when nothing stops it, the identical predicate was
run over the same crawl as a `count(*)` (psql, `\timing`, same
`AUDITABLE`/hamming/band clauses): **481,745 pairs in 23.590s**. The rule's own
header predicted the shape of this ("a site with a thousand templated
near-identical pages has half a million pairs"); the number is now measured
rather than reasoned. The worst case the cap does *not* rescue — a site with
just under 500 near-duplicate pairs, where the `LIMIT` never fires and the full
join runs anyway — was not exercised by this run and remains the number to
watch.

One caveat the rule's header raised did **not** bite here, and the reason is
luck rather than design: expression indexes have no statistics until the table
is ANALYZEd, and this pipeline never issues one. Autovacuum happened to analyze
`pages` at 21:35:40, mid-crawl, about two minutes before the rule pass started
(`pg_stat_user_tables.last_autoanalyze`). So the planner had statistics without
anyone asking for them. A faster machine, or a crawl that finished inside
autovacuum's naptime, would have run these joins against a table the planner
could not cost. **An explicit `ANALYZE` between the crawl and the rule pass is
carried to Phase 5's backlog**, and 0.06s must not be read as evidence that the
question is closed.

`content.template-similarity` — the rule flagged as linear in the number of page
types, because it samples up to 200 pairs *per type* — cost **1.48s** and
emitted **one row**. It emits a row only for a type with at least two
fingerprinted pages, and on this fixture exactly one type qualifies. Which is a
finding of its own:

## The surprise at scale: 40,002 page types on a 50,000-page site

`derivePageType` reads `/blog/17` as `/blog/:id` — a numeric segment is an id —
but `/products/p17` is a segment it cannot read that way, so **every product
page became its own cohort**. Measured on the crawl:
`count(distinct page_type) = 40,002` — **40,000 product singletons**, plus
`/blog/:id` (9,999 pages) and `/` (1). Two cohorts hold 10,000 pages between
them and forty thousand hold one page each.

That is a property of the Phase 1 fixture's URL scheme, not a defect the metric
rules introduced — and it turned this gate into a much harder test than it was
designed to be. Four of the ten metric rules emit one row per cohort:

```
— metric rows per metric rule —
40003           content.metrics-by-type
    1           content.template-similarity
40003           hreflang.coverage
40003           inlinks.distribution
    1           inlinks.extremes
40002           inlinks.sources-by-type
    1           redirect.volume
    4           sitemap.structure
40003           structure.depth-distribution
    1           url.param-volumes
```

200,022 `metrics` rows for one crawl, where a real site's templates would
produce a few dozen. (40,003 is the 40,002 cohorts plus the rule's own `site`
row; `inlinks.sources-by-type` has no site row and stops at 40,002.) Two
consequences worth stating plainly:

1. **The metric phase is where the memory went.** A metric rule returns its
   whole row set to the runner, which validates it as a set and then inserts in
   batches of 500 — so RAM in that phase is O(rows a metric emits), not
   O(batch). At 40,003 rows × four rules that is what took the process from the
   crawl's 184 MB to 387 MB. It is inside the contract with 125 MB to spare, and
   this is the pathological case rather than the ordinary one, but the shape is
   now known and measured: **carried to Phase 5's backlog as "a metric rule that
   emits one row per cohort holds every row before the first insert"**. The fix,
   if a real site ever needs it, is a streaming return rather than an array.
2. **`content.template-similarity`'s per-type sampling was the flagged risk and
   it did not fire**, because 39,999 of the 40,002 cohorts hold a single page
   and a single page has no pair. The linear-in-type-count cost is therefore
   still not measured against a site with *many populated* types. Recorded as
   what it is: a risk that this fixture cannot provoke.

## The Phase 4 gate proper — quotability, asserted

The build plan's gate is about whether an agent can read a metric row and answer
a checklist `Record:` line without post-processing. That is not a thing a wall
clock can settle, so it lives in `test/fixtures/harness.test.ts`, on the same
one-crawl-one-rule-run harness Phases 2 and 3 used, in two assertions:

| assertion | status |
|---|---|
| **Every metric rule wrote its table for this crawl** — the ten ids pinned as an exact set, and that set asserted equal to `registry.byKind("metric")`'s. A metric added without a fixture that provokes it fails here; there is no exemption paragraph, because all ten fire. | PASS |
| **The three quotable site metrics carry the numbers this site actually has** — `inlinks.distribution` (count/min/p25/median/p75/p95/max/mean), `hreflang.coverage` (pages with hreflang, indexable pages, coverage %) and `sitemap.structure` (docs, total URLs, oversized skipped, cap breaches, entry cap) pinned **exactly**, each figure hand-derived from the fixture collection — the pages it serves, the anchors it renders, the sitemap it publishes — rather than copied from what the SQL returned. `sitemap.structure`'s per-document row is pinned as an exact key set beside its site row. | PASS |

Hand-derived is the load-bearing word: a pin copied from the query's own output
asserts only that the query is deterministic. The harness also re-reads two of
the inputs from different tables (`hreflangByPath.size`, the cohort count out of
`pageByPath`), so a fixture that stopped declaring hreflang fails as a
disagreement between two readings rather than as an unexplained number.

## Coverage — 41 claimed, 3 agent, 3 render

| | count | ids |
|---|---|---|
| Crawl-derived universe (`CRAWL_CHECK_IDS`) | 47 | checklist Pre-Crawl + sections 1–11 |
| Claimed at the end of Phase 3 | 37 | |
| **Newly claimed this phase** | **+4** | CHECK-08 (`sitemap.structure`), CHECK-29 (`url.param-volumes`), CHECK-33 and CHECK-33b (the link-graph metrics) |
| **Claimed total** | **41** | |
| `AGENT_CHECKS` — judgement, never a rule | 3 | 38, 41, 42 |
| **Unclaimed — the render three** | **3** | 01, 02, 34 (→ Phase 5) |

`41 + 3 + 3 = 47`, asserted as arithmetic in `test/rules/coverage.test.ts`, with
the pin itself asserted against the `RENDER_CHECKS` **constant** rather than a
re-typed literal. `METRIC_PENDING_CHECKS` — Phase 3's second annotation, holding
08, 29, 33 and 33b — was **deleted** rather than left empty: an annotation with
nothing to annotate is a reason nobody needs.

**CHECK-38 is the one place a metric touches an AGENT check.** A metric produces
no findings and passes nothing, so it may supply *evidence* for a judgement it
does not make — but that door is a named allowlist, not a blanket exemption.
`AGENT_CHECK_EVIDENCE` in the coverage test lists `content.metrics-by-type` and
`content.template-similarity` under CHECK-38, and lists CHECK-41 and CHECK-42
with **empty** arrays, so a metric that started claiming either fails. Every
allowlisted claimant must be of kind `metric`, and CHECK-38 must still count as
an AGENT check rather than a claimed one — both asserted.

### The ruleset — 74 rules (`RULESET_VERSION` 0.2.0)

| kind | count | change this phase |
|---|---|---|
| `page` | 26 | unchanged |
| `query` | 38 | unchanged |
| `metric` | 10 | **+10**: `inlinks.{distribution,extremes,sources-by-type}`, `structure.depth-distribution`, `content.{metrics-by-type,template-similarity}`, `hreflang.coverage`, `url.param-volumes`, `redirect.volume`, `sitemap.structure` |

## Two dispositions this gate records

**CHECK-08 is claimed by `sitemap.structure`, a `metric` rule — confirmed.** The
checklist's CHECK-08 asks for the sitemap's *shape*: how many documents, how
many URLs, whether any document breaches the 50,000-URL limit. Every one of
those is a number about the site rather than a fault on a page, which is exactly
what the metric kind is for; the sitemap *faults* (invalid, non-200, redirected,
non-indexable, uncrawled) stayed with Phase 3's query rules. The rule writes one
`site` row and one `sitemap_doc`-scoped row per document — a scope added this
phase rather than filing a sitemap URL under `page_type`, where every reader
expects a template name.

**CHECK-44's Product profile was widened**, per the checklist's own field lists
(`~/.claude/skills/sf-audit/checklist.md` lines 1334-1364, fields at 1341-1351).
`SCHEMA_PROFILES.Product.recommended` now carries `offers.priceCurrency` and
`offers.availability` — read from *inside* the offer by predicate, because a
top-level `priceCurrency` is not where correct markup puts one — `gtin`
(accepting any of `gtin`/`gtin8`/`gtin12`/`gtin13`/`gtin14`/`ean`, since a
product with a `gtin13` has a GTIN), `mpn`, and `color`, `material`, `size`.

**Named backlog, deliberately not done here:** the checklist calls
`description`, `sku` and `brand` **required** (line 1342) and also names `url`,
which this profile does not carry at all. They remain *recommended* (and `url`
absent). Moving a field into `required` changes which pages get a finding and at
what severity — a ruleset change with a client-visible verdict behind it, not a
profile widening — so it is carried rather than smuggled in beside this one. The
delta is recorded here for the same reason Phase 3 recorded its narrower
profile: so nobody reads "CHECK-44: claimed" as more than it says.

## Supersessions — what this phase changes about Phase 3's record

`docs/gates/phase-3.md` is immutable; it records what was true when it was
written. Two of its disclosures are no longer current, and this is where that is
said:

1. **Its CHECK-44 disclosure** ("claimed by a deliberately narrower profile than
   the checklist enumerates", listing `offers.priceCurrency`, `offers.availability`
   and the product identifiers among the missing) is **superseded** by the
   widening above. What remains outstanding is smaller and is named above:
   `description`/`sku`/`brand` still recommended rather than required, and `url`
   still unprofiled.
2. **Every mention of `METRIC_PENDING_CHECKS`** — the gate-amendment table, the
   coverage pin of 7, the equality assertion quoted as
   `[...RENDER_CHECKS, ...METRIC_PENDING_CHECKS]` — is **superseded**: the
   constant no longer exists, the four checks it held are claimed, and the
   assertion is now `unclaimed === RENDER_CHECKS`. Phase 3's "carried forward"
   item 1 is thereby half discharged; its item 2 (the crawl-layer normalisation
   seam) was already marked CLOSED in place by Task 1's migration `0006`.

Phase 3's item 4 — **a hard kill still loses buffered rows** — is carried
forward unchanged, and unexercised by this gate.

## Machine

| | |
|---|---|
| CPU | Intel Core i5-6500 @ 3.20GHz, 4 cores (no SMT) |
| RAM | 32 GB |
| Kernel | Linux 6.8.0-138-generic |
| Node | v22.23.2 |
| Postgres | 16.15, Docker container `ariadne-pg` on port 5440 |
| Suite | 878 tests, 48 files, 28.0s wall |
| `tsc --noEmit` | clean |

The crawler, the fixture web server and Postgres shared four cores, as in
Phase 1. Memory is the figure the gate is about, and it is not sensitive to
that.

## CI

`.github/workflows/ci.yml` is unchanged: `ubuntu-latest`, a health-checked
`postgres:16` service, Node 22, then `npm ci` → `npx tsc --noEmit` →
`npm run db:migrate` → `npm test`. Its triggers are push to `main` and every
pull request. **First CI run on this branch: pending the first pull request.**
The gate script is not part of CI and is not meant to be — it takes twelve
minutes and wants a machine, not a runner.

## Leftovers

The run leaves its rows in the dev database under crawl id
`crawl_bbc5123b-bdb2-4777-beef-702a0c2cd4d2`, so every figure above can be
re-queried. `delete from crawls where id = '…'` cascades.

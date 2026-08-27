# Phase 1 gate — 50,000 pages under 512MB, with resume

**Date:** 2026-08-25
**Code:** branch `worktree-phase-0-1-foundation` at `938e47b`, plus the two
commits this gate produced — `31a88d3` (the `enqueueUrls` chunking fix, without
which the crawl could not start) and the commit that adds this file and the gate
harness. Both runs below were made with exactly that code.
**Verdict:** PASSED. **Peak RSS 169.5 MB** against a 512 MB contract, on a
50,000-page crawl; a crawl stopped at 40% resumed and finished with exactly
50,000 pages and no page fetched twice.

The build plan asks for the figure, not the pass/fail, so everything below is
the run's own output.

## How to reproduce

```bash
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne \
  node --max-old-space-size=512 --import tsx scripts/gate-crawl.ts
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne \
  node --max-old-space-size=512 --import tsx scripts/gate-resume.ts
```

Both scripts serve their own site from `test/gate/site-server.ts` — a
deterministic 50,000-URL shop-and-blog on loopback, ~15KB per page, 20 internal
links per page plus a site-wide nav, two hreflang alternates, a JSON-LD
`Product` block on product pages, and a three-shard sitemap index declaring
every URL. Nothing about it is stateful: every byte of every response is a pure
function of the request path, so the fixture's own memory is O(1) and a killed
run resumes against byte-identical pages. `GATE_PAGES=<n>` runs a smaller
version of either script for development; anything other than 50,000 is
labelled loudly as not the gate.

`allowPrivate: true` is the sanctioned use of that flag: the site is 127.0.0.1.

## Gate 1 — memory

```
PHASE 1 GATE — 50,000 pages, peak RSS must stay under 512MB
node v22.23.2, flags --max-old-space-size=512 --import tsx
fixture site    50,000 URLs, crawl budget 55,000

crawl id        crawl_db11d3d2-8532-4276-8f3c-e2159d869f97
status          finished
pages crawled   50,000
pages rows      50,000
links rows      1,149,940
frontier        pending 0, leased 0, done 50000, failed 0
writer          pages 50000, links 1149940, hreflang 100000, structured data 40000
sitemap entries 50,000
elapsed         825.3s
throughput      60.6 pages/sec
PEAK RSS        169.5 MB (at +721s)

GATE PASSED
```

| | |
|---|---|
| Peak RSS | **169.5 MB** (33% of the 512 MB contract) |
| Pages crawled | 50,000 of 50,000 |
| Links written | 1,149,940 (23.0 per page) |
| Elapsed | 825.3s (13m 45s) |
| Throughput | 60.6 pages/sec |
| HTML fetched | 783,899,244 bytes (748 MB), 15,678 bytes/page average |
| Per page | 1,599 words, 91 ms average response time, all 50,000 indexable |

RSS was sampled every 2s inside the process. The peak — 169.5 MB — was recorded
at +721s, but the level was reached far earlier: an external `ps` at +219s
(about 12,000 pages in) already read 169.6 MB, and the 600-page development runs
of the same script peaked at 159.5–162.0 MB. So the working set is flat in the
number of URLs and set by concurrency: between 600 pages and 50,000 pages —
two orders of magnitude, and 748 MB of HTML through the process — it moved by
about 8 MB.

That is the memory contract behaving as designed (RAM O(concurrency), not
O(URLs)): the frontier is 50,000 rows in Postgres rather than a visited-set in
the heap, the writer's buffers are capped at 100 rows per table, and nothing in
the loop is keyed by URL. No heap snapshot was needed.

## Gate 2 — resume

```
PHASE 1 RESUME GATE — 50,000 pages, first run stopped at ~20,000
node v22.23.2, flags --max-old-space-size=512 --import tsx
crawl id        crawl_c20d8692-e854-4521-8477-b20393dc6453

run 1 status    cancelled (aborted by the caller; the frontier still holds pending URLs)
run 1 pages     20,018 (abort requested at 20,000 done)
run 1 rows      20,018 in pages
frontier        pending 29,982, leased 0, done 20,018, failed 0
run 1 elapsed   353.1s

run 2 status    finished
run 2 pages     29,982 (this run)
total pages     50,000
frontier        pending 0, leased 0, done 50,000, failed 0
pages rows      50,000 (50,000 distinct URLs)
links rows      1,149,940
run 2 elapsed   461.4s
peak RSS        190.0 MB (across both runs)

RESUME GATE PASSED
```

| | |
|---|---|
| Kill point | abort signalled once the frontier reported 20,000 done; run 1 ended at 20,018 pages (the 16 URLs already leased finished their attempt) |
| Left to resume | 29,982 pending, 0 leased — a graceful stop releases its own leases |
| Run 2 | 29,982 pages, ending `finished` with the frontier drained |
| Total | 50,000 frontier `done`, **50,000 `pages` rows over 50,000 distinct URLs** |
| Links | 1,149,940 — identical to the uninterrupted run, to the row |
| Peak RSS | 190.0 MB across both runs in one process |

`20,018 + 29,982 = 50,000` with no double-count is the assertion that matters:
the resume re-seeded and re-walked the sitemap (discovery runs again, because
robots rules must be honoured as they are *now*) and every one of those 20,018
already-done URLs was dropped by the frontier's `(crawl_id, url)` conflict
rather than fetched a second time. The link count matching the uninterrupted
run exactly is the same fact from the other side.

`reclaimLeases: true` was passed, because that is what an operator resuming a
crashed worker must pass — rows a dead worker holds are otherwise unleasable
until their deadline expires. Here it found nothing to reclaim (0 leased after
the abort), which is the correct outcome for a *graceful* stop and is why the
leased count is printed: it is what tells the two cases apart.

## Machine

| | |
|---|---|
| CPU | Intel Core i5-6500 @ 3.20GHz, 4 cores (no SMT) |
| RAM | 32 GB |
| Kernel | Linux 6.8.0-138-generic |
| Node | v22.23.2 |
| Postgres | 16.15, Docker container `ariadne-pg` on port 5440 |

Throughput is a number about *this* machine and should not be read as a
capability claim. The crawler, the fixture web server and Postgres all shared
four cores, alongside the desktop's usual load (a Docker Desktop VM, Chrome, an
unrelated dev server). Memory is the figure the gate is about, and it is not
sensitive to any of that.

## Findings from running the gate

Two defects and one wrinkle surfaced. The first was fixed here because the gate
could not run without it; the others are recorded rather than fixed under a
gate.

**1. `enqueueUrls` could not insert a sitemap (fixed).** The frontier's enqueue
built one `INSERT` per call. Postgres binds parameters with a 16-bit count, so a
statement carries at most 65,535 of them, and a frontier row spends four — a
hard wall at 16,383 rows. Well below that, drizzle overflowed the call stack
assembling the statement (~30k rows: `Maximum call stack size exceeded`, which
reads like a crawler bug rather than a batch-size one). The crawl loop enqueues
a whole sitemap in a single call, so **any site with a sitemap over ~16k URLs
failed on its first enqueue** — this fixture at the first attempt. `enqueueUrls`
now inserts in chunks of 1,000 rows, with a regression test at 20,000 URLs
(`test/crawl/frontier.test.ts`).

**2. A hard kill loses buffered rows (fixed in Phase 5, task 1 for `pages`
only: `links`, `hreflang` and `structured_data` still lose up to one leased
batch, now unrecoverably, since the page they hang off is marked `done` and no
resume re-fetches it — see build plan §7. The record of the defect as Phase 1
shipped it follows).** The loop marks
a frontier row `done` as soon as `PageWriter.addPage` has *buffered* its page
row — the insert happens when the buffer reaches 100. A process killed outright
(SIGKILL, OOM, power) therefore loses up to `batchSize - 1` rows per table while
the frontier records those URLs as finished, so a resume will not re-fetch them.
The graceful paths are all safe: an abort, an error and a normal finish all run
`writer.flush()` before returning. The resume gate models a stop, not a kill,
so it does not exercise this. Worth a decision in a later phase — completing a
frontier row only after its page row is durable would close it.

**3. A crawl budgeted at exactly the site's size stops one page short.** The
loop reserves a frontier slot per candidate URL and returns the slot only after
the insert reports the `(crawl_id, url)` conflict dropped the row. Seeding
reserves `maxPages` slots but inserts one row fewer, because the sitemap
declares `/` and the seed already enqueued it, so the frontier settles at
`maxPages - 1`. Filling that last slot then needs a page whose *first* link is
not yet in the frontier — and every page starts with the same site-wide nav,
whose targets are always known — so it is never filled. Measured twice at 600
pages: 599 crawled. This costs a real crawl nothing (a budget stopping at 49,999
of 50,000 is a budget doing its job), but the gate asserts an exact count, so
both scripts give `maxPages` 10% headroom over the fixture's size and let the
*site* end the crawl. See the comment on `budgetHeadroom` in
`scripts/gate-crawl.ts`.

## Leftovers

Both runs leave their rows in the dev database, identified by the crawl ids
above, so the evidence can be re-queried. `delete from crawls where id = '…'`
cascades to every child table.

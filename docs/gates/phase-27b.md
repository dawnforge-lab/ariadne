# Phase 27b gate: lifecycle and the config schema

Date: 2026-11-09. Spec: `docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md`
(the "27b — Lifecycle and the config schema" section and "Gate 27b"). Plan:
`docs/superpowers/plans/2026-11-08-phase-27b-lifecycle-and-config-schema.md`. Branch
`worktree-phase-27b`, built on `168826b` (PR #25's merge). Figures below were measured on
the code of `fbc5841` (Task 7's last commit) plus the gate script's
`--pause-at-fraction` flag (`30fc6a9`, extended in `ff1d194` to sample the status flip,
and tidied in `80025f8`, which also rewords the `crawl_pause` description). The 50k
numbers in §7 are from the run on `ff1d194`; the later script commit only removes a
sampler line that could not measure what it claimed (§7). The full suite ran on the
commit named in §1.

**Verdict: clauses 1 to 6 and the memory limit of clause 7 pass. One spec sentence was
NOT demonstrated at 50k scale (§7), and Ruling 10 settles it.**

The spec says the status change happens within one poll interval plus the abort settle
time. On the fixture crawls it does (806 to 932 ms). On the 50k gate crawl the status
flipped `paused` **5.3 s** after the request, against a 1 s poll. Ruling 10 restates the
bound at scale as one poll interval plus wind-down plus the close the spec mandates
(template inference, then `closeCrawl`), recorded as Deviation 17.

Ruleset 0.23.0, 188 rules (72 page / 102 query / 14 metric), no rule, ruleset or
`EXTRACTION_VERSION` change; migrations 0034 (columns) and 0035 (the `cancelled` to
`paused` relabel). The 50k crawl, paused at 40% and resumed, peaked at **276.4 MB** in
run 2 and **285.2 MB** in run 1 (limit 512 MB; within 5% of 26c's 293.7 MB means at most
308.4 MB). Both runs pass.

## Gate clauses

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite green, 0 skipped; `tsc` clean | **pass**: 142 files / 3,858 tests, 0 failed, 0 skipped; `tsc` clean | §1 |
| 2 | a paused-and-resumed crawl ends with the uninterrupted crawl's page URLs and fetch classes | **pass**: 167 URLs, identical sets | §2 |
| 3 | a cancel reaches `cancelled` within the bound; no failed row from the abort | **pass**: 806 ms against 1,000 ms + settle; 0 failed rows | §3 |
| 4 | a delete leaves zero rows in every `crawl_id` table and no files | **pass**: 14 tables, 0 rows each; no render or export file | §4 |
| 5 | a paused crawl survives a restart still paused | **pass** | §5 |
| 6 | both transports accept and refuse the same fields; `config_validate` and `crawl_start` agree on every refusal | **pass** | §6 |
| 7 | the 50k gate with one pause and one resume: at most 512 MB, within 5% of 293.7 MB | **pass on memory**: 276.4 MB (second run; first run 285.2 MB), 50,000 pages `finished`. **Finding**: the pause's status flip took 5.3 s in run 2 (run 1 measured 5.55 s to the summary), not about 1 s | §7 |

## 1. Clause 1: suite and types

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **142 files / 3,858 tests, 0 failed, 0 skipped** (317.4 s), run on commit **`6251dc3`** (the last code commit; the docs commit after it changes no code). The known `renderer.test.ts` flake did not appear. An earlier run on `80025f8` failed one test (the `crawl_pause` description lost its "poll crawl_status" wording), fixed in `6251dc3` |
| `npx tsc --noEmit` | clean |
| baseline at the branch point (`168826b`) | 136 files / 3,770 tests |
| phase delta | +6 files, +88 tests |
| MCP tools / HTTP routes | 27 / 27 (22 before); command tools 9 (`crawl_pause`, `crawl_cancel`, `crawl_delete` new), read tools `config_schema` and `config_validate` new |
| skills and surface guard | `npx vitest run test/skills`: 25 of 25, including the citations of `docs/talos-surface.md` |

## 2. Clause 2: pause and resume equivalence

`test/crawl/control.test.ts`, "a crawl paused once done >= 10 and resumed ends with the
uninterrupted crawl's pages and fetch classes", on the whole fixture site (the harness's
`allFixtures()`). An uninterrupted crawl A and a crawl B paused once ten URLs were done
(`setControlRequest(db, id, "pause")`, then `resumeCrawl`). B was paused with 28 pages
written, closed `paused` with `pauseReason: "request"` and a non-empty frontier, and the
resume ended `finished`.

Both crawls hold **167 URLs**, the sorted `url + fetchClass` lists are equal, and the
classes are `ok` 155, `redirect` 4, and one each of `blocked`, `client_error`,
`disallowed`, `network_error`, `non_html`, `server_error`, `too_large` and
`unsupported_encoding`. Beside it, `a pause under a long per-host spacing (Ruling 2)`
paused a 2,000 ms-spaced crawl in 932 ms (7,944 ms before the host wait became
interruptible).

## 3. Clause 3: the cancel bound

`test/crawl/control.test.ts`, "cancels within one poll interval, skips the epilogue
passes, still infers templates, and is final": a crawl stalled on a slow URL, cancel
requested through `setControlRequest`. **The row read `cancelled` in 806 ms** against the
bound `CONTROL_POLL_MS` (1,000 ms) plus abort settle (the test allows +2,000 ms). Pause
measured 825 ms the same way. The frontier holds **0 `failed` rows** (the aborted fetch is
returned to `pending` and its attempt refunded), `cancelled_at` is set, `pause_reason` and
`control_request` are null, the 404 probe is recorded as skipped, `resumeCrawl` is refused
(`is cancelled ... final`), and the template inference still ran.

## 4. Clause 4: delete

`test/api/crawl-delete.test.ts`, "removes every row and file of one crawl and leaves a
second untouched": a full crawl with a render pass and three exports is deleted with
`DELETE /crawls/:id?confirm=<id>`. `CRAWL_CHILD_TABLES` (13 tables plus `crawls`, 14) is
pinned to `information_schema` by "is exactly the tables with a crawl_id column", and the
test counts rows in every one of them by a query built from that list: **0 rows in all 14**
after the delete, `readdir` of the crawl's render directory is `ENOENT`, no export file
remains, `GET /crawls/:id` is 404, the crawl is absent from `crawl_list` and `crawl_compare`,
and the sibling crawl's rows, renders and exports are byte-identical to before. The
refusals (confirm, queued or running, pending request, in-process render or rules, live
lease) are pinned in the same file.

## 5. Clause 5: restart while paused

`test/api/lifecycle.test.ts`, "a paused crawl stays paused across a restart, nothing
starts it, and crawl_resume finishes it": pause a running crawl, close the server, build a
new `ApiService` on the same database. The crawl is `paused`, `queuePosition` null, the
new server's log has no line naming it, and `crawl_resume` then finishes it.

## 6. Clause 6: the two contract checks

`test/api/transport-parity.test.ts`:
- "walks the published schema and drives every body through POST /crawls and crawl_start":
  every field of the JSON Schema is driven with accepted and refused values through both
  transports, which agree on accept or refuse and on the field named.
- "answers valid: false exactly when POST /crawls refuses, with its message and status":
  `config_validate` and `crawl_start` agree on every refusal case, the first error being
  the one `crawl_start` answers with.

## 7. Clause 7: the 50k memory gate with a pause and a resume

Command (dedicated database `ariadne_gate27b`, migrated with `npm run db:migrate`, dropped
afterwards; the fixture is the loopback `test/gate/site-server.ts`, nothing external was
fetched):

```
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne_gate27b \
  node --max-old-space-size=512 --import tsx scripts/gate-rules.ts --pause-at-fraction 0.4
```

Node v22.23.2. The gate was run twice. Run 1 (`30fc6a9`) measured the interval from the
request to the run's summary. Review found that interval was the wrong one for the spec's
bound, so `ff1d194` made the script sample `crawls.status` every 100 ms after the request,
and run 2 is the same command on it (fresh database, dropped afterwards).

| | run 1 (`30fc6a9`) | run 2 (`ff1d194`) |
|---|---|---|
| pause requested | at 20,034 done, 20,072 pages written | at 20,066 done, 20,088 pages written |
| request to **status read `paused`** (the spec's interval) | not sampled | **5,294 ms** (100 ms sampling) |
| request to the run's summary | 5,550 ms | 5,294 ms |
| status flip to summary | not sampled | 0 ms |
| resume | `resumeCrawl(db, id, { config })`, `finished` | same |
| crawl | `finished`, **50,000 pages**, failed 0; 989.4 s (both runs), 50.5 pages/s | same; 983.9 s, 50.8 pages/s |
| render pass | 7 rendered, 0 failures, 9.5 s | 7 rendered, 0 failures, 9.6 s |
| rules pass | 155,449 findings, 38 metric rows, 366.5 s | same findings and rows, 365.1 s |
| **peak RSS, every phase** | **285.2 MB** (at +420 s) | **276.4 MB** (at +415 s); crawl 276.4, render 273.7, rules 273.9 |
| wall time, three phases | about 1,370 s | about 1,360 s (983.9 + 9.6 + 365.1 s, plus setup) |
| browser RSS (not gated, an upper bound) | 1,127.4 MB | 1,127.6 MB over 14 processes |

Both runs are at most 512 MB and at most 308.4 MB (5% over 26c's 293.7 MB); run 2 is 17.3 MB
under 26c. `--pause-at-fraction` samples RSS across both runs of the crawl phase, as the
unflagged gate does.

**Which interval is the spec's.** The spec's bound is on the status change, "within one poll
interval plus the abort settle time". That is request to status flip: **5,294 ms** at 50k.
The sampler read the flip and the run's summary in the same 100 ms sample (flip to summary
0 ms). `summaryMs` is taken after the watcher is awaited, so that shows only that flip to
summary is under about 100 ms, the sampler's resolution; it does not show that `summarise`
costs nothing. Run 1's 5,550 ms to the summary (no flip sampled) is within run-to-run
spread of run 2's 5,294 ms.

**The finding.** 5.3 s is materially above the poll interval (1 s) plus a few seconds of
settle, and this gate cannot say where the other 4.3 s go. What is known from the code:
`loop.ts` runs the whole-crawl `inferPageTemplates` BEFORE `closeCrawl`, and `closeCrawl`
is what flips the status and writes the inference result in one UPDATE. So the 5.3 s holds
the poll wait, the abort and the draining of in-flight fetches and the writer's backlog,
AND the template inference over 20,088 pages, in an order the sampler cannot see. A first
attempt to split them by sampling `template_inference_jsonb` read it non-null in the same
sample as the status flip, which is what a column written in the closing UPDATE does, so
that sampler was dropped (`80025f8`) and no split is claimed. To decompose it, time
`inferPageTemplates` over a stored 20k-page crawl, or instrument the loop's close path;
neither was done here. The fixture crawls (28 pages) cannot show it: inference over 28
pages is negligible. Ruling 10 settles it: the bound at scale is one poll interval plus
wind-down plus the close the spec itself mandates (template inference, then `closeCrawl`),
and inference stays on a pause and before the flip. The stop-latency text in the
`crawl_pause` description, in `docs/talos-surface.md` §4.1c and in the `ariadne-crawl`
skill states the measured figure instead of promising a second.

## Rulings

1. **T6's start/validate agreement test asserts `effective` equals the started crawl's
   stored `config_jsonb`**, and T7 adds that `crawl_config_get.crawl` equals the same stored
   config. Costs nothing if wrong: the equality chain is the same.
2. **`HostGate.acquire` takes an optional `AbortSignal`**, and an abort wakes a waiting
   acquire, whose claimed slot is not handed back. A stopped crawl's gate has slightly
   advanced slots, which a resume never sees (it builds a fresh gate from
   `host_spacing_jsonb`). If wrong, a stop under a long spacing waits out the slot (7.9 s
   at 2 s x 4; minutes under a `Crawl-delay`).
3. **With `expectStatus`, any existing row whose status differs, `cancelled` included,
   throws `ClaimLostError`**, and a missing row stays a plain `Error`. If wrong, the queue
   runner logs a vanished row as a failure rather than skipping it.
4. **The recheck and resource passes keep their contract** (see Deviation 16): in-flight
   abort applies to the page crawl only. If wrong, nothing is lost but a stop during those
   passes can take up to one fetch deadline (20 s); the alternative is parked as
   `docs/gates/phase-27b-ruling4-inflight.patch` (committed in 27c).
   *Note, 2026-11-10: Phase 27d implemented the alternative. The recheck and resource
   passes now abort the in-flight request on a stop (`docs/gates/phase-27d.md` §3). The
   text above is the record of 27b and is left as it was.*
5. **`crawl_resume` refuses (409) while `control_request` is non-null**, naming the request
   and pointing at `crawl_mark_failed` for a crawl whose worker is gone. If wrong, an orphan
   with a pending request needs two calls (mark failed, then resume), where the alternative
   would carry a request into a queued row or drop an agent's cancel.
6. **A `paused` crawl is always resumable**: the owed-work check applies only to `finished`
   and `failed` rows, because a paused crawl may owe work no row counts. A stop skips
   whatever epilogue work had not started (the order is probe → recheck → resources): the
   404 probe if the stop came during the page crawl; otherwise the rest of the recheck and
   the resource pass. If wrong, a resume of a paused crawl whose only owed work is the probe
   re-runs discovery and the host probe (a few requests, rule-9-paced).
7. **MCP `config_validate` takes `{config: <start body>}`** while `POST /config/validate`
   takes the body itself. With the start schema as the tool's input schema the SDK would
   refuse a bad body before the tool could answer `valid: false`, defeating a dry run. If
   wrong, one wrapper key differs between the transports for this one tool (documented in
   `docs/talos-surface.md` §4.1b).
8. **A schema-level `crawl_start` refusal over MCP is the SDK's plain-text "Input validation
   error"** rather than `{error}` JSON, as it already was. Parity is accept or refuse plus the
   field name. If wrong, an MCP client reads two refusal shapes (documented in §4.1).
9. **The `HostGate.restore` zero-base gap is parked to the backlog**, outside 27b. A crawl
   whose operator base spacing is 0 ms resumes at about half its earned spacing until the
   ratchet re-escalates; it is unreachable over the wire (the `perHostDelayMs` floor of
   250 ms keeps the base at 250 or more, where the earned spacing is restored correctly).
   If wrong, an operator-configured 0 ms crawl resumed after earning spacing is briefly
   faster than it earned (rule 9). The gate script's crawl is exactly such a crawl (base 0
   on the loopback fixture) and is unaffected, because the fixture never escalates.
10. **The stop bound at scale is one poll interval plus wind-down plus the close the spec
    itself mandates** (template inference, then `closeCrawl`, which flips the status).
    Inference stays on pause and cancel, and stays before the flip: the spec says a
    stopped crawl "closes the same way an interrupted crawl does today: template
    inference and closeCrawl run", paused crawls are judged and rendered (they need
    collapsed page types), and a reader who sees the status must see the inference marker
    (the loop's own contract). Recorded as Deviation 17 with the measured 5.3 s at 20k
    pages. If wrong, an agent polling a deep crawl sees the status change about 5 s after
    its request instead of about 1 s.
11. **`crawl_rules` refuses (409) a crawl with no discovery evidence** (`crawls.discovery`
    null: it never ran, because it was paused or cancelled while still queued), naming the
    crawl and saying it never ran, as the render driver refuses a crawl that "never
    completed discovery". On such a crawl cancelled, `neverFetched` is null, not 0: the
    count is unknown. Before this ruling a never-ran crawl's `crawl_rules` answered 500 (a
    rule threw on the missing robots evidence) and its `neverFetched` said 0. If wrong, an
    agent cannot judge an empty never-ran crawl, which has nothing to judge anyway.
12. **`crawl_config_set` accepts a `never` or operator-only key whose value deep-equals the
    stored value as "no change"** (not written, not refused), and every `never` check runs
    before the status checks, so the refusal does not depend on key order. Get, edit, set
    with the whole `crawl` object is what a reasonable agent does. If wrong, a no-op key is
    silently accepted rather than refused.

## Deviations

From the spec text (owner to see in review):

1. **Migrations are `0034` + `0035`, not `0032`.** The spec predates 27a's three
   migrations.
2. **Discovery is not interrupted between sitemap documents.** A stop that arrives during
   the sitemap walk or the host probe takes effect when it returns. A walk cut part-way
   would leave `sitemap_urls`, memberships and staged alternates that the sitemap and
   hreflang rules would judge as the whole sitemap (rule 7); doing it honestly needs a "walk
   cut short" truncation reason, the same work as the owner-parked discovery-deadline item.
3. **One polling mechanism.** The watcher polls every second for the whole run and delivers
   the request as an abort; the loop already checks that signal at every point the spec
   lists except discovery.
4. **`neverFetched` is computed, not stored**: on a `cancelled` crawl it is `frontier.pending`.
5. **Cancel also applies to a paused crawl, immediately.**
6. **`DELETE /crawls/:id?confirm=<crawlId>`** carries the confirm as a query parameter,
   because DELETE bodies are poorly supported. MCP takes `{crawlId, confirm}`.
7. **The start body stays flat** (crawl fields plus `judgement`); `crawl_config_get` and
   `crawl_config_set` speak `{crawl, judgement}`.
8. **Operator-only stored fields** (`maxResources`, `maxResourceHosts`, `maxBlockedUrls`,
   `platformProfiles`) appear in `crawl_config_get.crawl` as `never`, and are not in the
   published schema.
9. **`probeHosts` and `fetchResources` are `never`.** Changing either mid-crawl would give one
   crawl two scopes.
10. **The judgement part keeps `parseJudgement` as its semantic check**; the schema publishes
    the block's shape and calls it in a refinement, and a parity test pins the two.
11. **An aborted fetch refunds its attempt**: the shutdown release decrements `attempts` on
    every row it still holds.
12. **A request that lands after the last poll before a clean finish is overtaken by the
    finish**: the crawl closes `finished` and the request is cleared.
13. **Defaults are published as the JSON Schema `default` annotation**, not as zod
    `.default()`, because operator defaults sit between the engine's and the request's.
14. **The 50k pause gate runs `scripts/gate-rules.ts`**, the script that produced 26c's
    293.7 MB, with a new `--pause-at-fraction` flag.
15. **`x-ariadne-secret` arrives with 27c's first secret field.**
16. **In-flight abort applies to the page crawl only** (Ruling 4, revised). The recheck and
    resource passes keep their contract (no new request after a stop; the one in flight
    settles and is recorded), so a stop during them can take up to one fetch deadline, 20 s.
    Discovery is not interrupted either (Deviation 2).
    *Note, 2026-11-10: superseded by Phase 27d. Discovery (the host probe, the sitemap walk,
    the post-discovery seeding), the recheck pass and the resource pass are all stopped
    within about 1 s (bound 2 s); see `docs/gates/phase-27d.md` §3. Deviation 2 stays the
    27b record.*

Added by the gate run:

17. **The spec's stop bound was not demonstrated at 50k pages** (§7). Request to status flip
    measured **5,294 ms** at 50k (20,066 URLs done), against 806 to 932 ms on the fixture
    crawls and a 1 s poll. The flip happens in `closeCrawl`, after the loop's whole-crawl
    template inference, so the interval includes that inference, whose share is not
    measured. `crawl_pause`'s description and `docs/talos-surface.md` §4.1c state the
    measured figure and no longer promise "about a second". Ruled by Ruling 10: the bound
    at scale is one poll interval plus wind-down plus the close the spec mandates.

## Carried to Phase 28

- **The in-process `judging` and `rendering` guards.** `refuseWhileBusy` reads sets held in
  this server's memory, so a second process cannot see a render pass or rules run in the
  first. Phase 28's multi-process work needs a database-held claim.
- **An orphan `running` crawl with a pending request** (its worker died with a pause or
  cancel recorded): it stays `running` with the request set until `crawl_mark_failed`
  clears both (Ruling 5). No process reaps it.
- The tenant key: until then anyone with the token who knows a crawl id can delete it
  (`docs/talos-surface.md` §9.5).
- The `HostGate.restore` zero-base gap (Ruling 9).

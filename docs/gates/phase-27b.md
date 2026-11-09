# Phase 27b gate: lifecycle and the config schema

Date: 2026-11-09. Spec: `docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md`
(the "27b — Lifecycle and the config schema" section and "Gate 27b"). Plan:
`docs/superpowers/plans/2026-11-08-phase-27b-lifecycle-and-config-schema.md`. Branch
`worktree-phase-27b`, built on `168826b` (PR #25's merge). Figures below were measured on
the code of `fbc5841` (Task 7's last commit) plus `30fc6a9` (the gate script's
`--pause-at-fraction` flag) and this task's documentation commit, which changes no
behaviour (its one test edit adds a `console.log` of the equivalence counts).

**Verdict: all gate clauses pass.** Ruleset 0.23.0, 188 rules (72 page / 102 query / 14
metric), no rule, ruleset or `EXTRACTION_VERSION` change; migrations 0034 (columns) and
0035 (the `cancelled` to `paused` relabel). The 50k crawl, paused at 40% and resumed,
peaked at **285.2 MB** (limit 512 MB; within 5% of 26c's 293.7 MB means at most 308.4 MB).

## Gate clauses

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite green, 0 skipped; `tsc` clean | **pass**: 142 files / 3,858 tests, 0 failed, 0 skipped; `tsc` clean | §1 |
| 2 | a paused-and-resumed crawl ends with the uninterrupted crawl's page URLs and fetch classes | **pass**: 167 URLs, identical sets | §2 |
| 3 | a cancel reaches `cancelled` within the bound; no failed row from the abort | **pass**: 806 ms against 1,000 ms + settle; 0 failed rows | §3 |
| 4 | a delete leaves zero rows in every `crawl_id` table and no files | **pass**: 14 tables, 0 rows each; no render or export file | §4 |
| 5 | a paused crawl survives a restart still paused | **pass** | §5 |
| 6 | both transports accept and refuse the same fields; `config_validate` and `crawl_start` agree on every refusal | **pass** | §6 |
| 7 | the 50k gate with one pause and one resume: at most 512 MB, within 5% of 293.7 MB | **pass**: 285.2 MB, 50,000 pages `finished` | §7 |

## 1. Clause 1: suite and types

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **142 files / 3,858 tests, 0 failed, 0 skipped** (337.8 s, 2026-11-09 03:45 UTC). The known `renderer.test.ts` flake did not appear |
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

Commit `30fc6a9` plus the 27b surface code of `fbc5841`; Node v22.23.2.

| | |
|---|---|
| pause requested | at 20,034 URLs done (`setControlRequest`, fraction 0.4), 20,072 pages written |
| **pause latency** (request recorded to the run's `paused` summary) | **5,550 ms** (see the note below) |
| resume | `resumeCrawl(db, id, { config })`, ending `finished` |
| crawl | `finished`, **50,000 pages**, frontier done 50,000, failed 0; 989.4 s (both runs), 50.5 pages/s |
| render pass | 7 selected, 7 rendered, 0 failures, 9.5 s |
| rules pass | 50,000 pages scanned, 155,449 findings, 38 metric rows, wall 366.5 s |
| **peak RSS, every phase** | **285.2 MB** (at +420 s); crawl 285.2, render 279.0, rules 279.0 |
| against the limits | 512 MB: pass. 308.4 MB (5% over 26c's 293.7 MB): pass, and 8.5 MB under 26c |
| browser RSS (not gated, an upper bound) | 1,127.4 MB over 14 processes |
| wall time | about 1,370 s for the three phases (989.4 + 9.5 + 366.5 s, plus setup) |

**The pause latency is not the 1 s of the small fixture, and the doc says so.** The gate
measured 5.55 s from the recorded request to the run's summary, against 806 to 932 ms on
the fixture crawls. The poll interval is the same 1,000 ms; the rest is the wind-down of a
16-worker crawl that is 20,000 pages deep: in-flight fetches abort, the writer drains the
pages it already holds, and the close summarises 20,072 pages (frontier counts, template
inference input). The spec's bound (one poll interval plus the abort settle) is met by the
page crawl on the fixture, and the settle at 50k scale is 4.5 s on this machine. It is
recorded, not gated. `--pause-at-fraction` samples RSS across both runs of the crawl phase,
as the unflagged gate does.

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
   `task-3-ruling4-inflight.patch` in the SDD workspace.
5. **`crawl_resume` refuses (409) while `control_request` is non-null**, naming the request
   and pointing at `crawl_mark_failed` for a crawl whose worker is gone. If wrong, an orphan
   with a pending request needs two calls (mark failed, then resume), where the alternative
   would carry a request into a queued row or drop an agent's cancel.
6. **A `paused` crawl is always resumable**: the owed-work check applies only to `finished`
   and `failed` rows, because every pause skips the 404 probe (and perhaps the recheck or
   resource passes). If wrong, a resume of a paused crawl whose only owed work is the probe
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

Added by the gate run:

17. **The measured pause latency at 50k pages is 5.55 s, not about 1 s** (§7): the poll is
    1 s, the rest is the wind-down of a deep 16-worker crawl. The documentation of
    `crawl_pause` still says "about a second" for the page crawl on a small site; the
    talos-surface §4.1c states the three exceptions it knows (discovery, epilogue passes) and
    this gate records the scale one.

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

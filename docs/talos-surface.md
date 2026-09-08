# The Ariadne surface Talos codes against

**Status:** the contract as of Phase 16 (ruleset 0.12.0, migrations 0000–0015,
16 MCP tools / 16 HTTP routes). `docs/talos-integration.md` says *why* the seam
exists and what obligations bind it; this document says *what the seam is*.

**What Phase 16 changed here**, so a reader of the Phase 14 version knows where
to look: **no served field or shape changed; 29 rules changed severity.**
`RULESET_VERSION` is 0.12.0. 23 rules moved `warning` → `critical`, 5
`info` → `warning`, and `crawl.blocked` became a NOT MEASURED marker at `info`
(its copy reworded to match; 27 / 23 / 45 after), so `rules_catalog` and every
`issues`/`crawl_issues` row judged at 0.12.0 carry the new bands, and
`site.health`'s `urlsCritical` means more than it did — §11 has the full
account. Phase 15 (the local demo page) touched nothing Talos codes against.

**What Phase 14 changed here**, so a reader of the Phase 13 version knows where
to look: **one shape was added and no served field changed.**
`resources.partial-unknown` is a fourth resource-coverage marker (info) — the
last of the family, for a PARTIAL pass where some recorded rows are still `null`
(never asked about) and the rest a decided unknown class (`refused`,
`robots_denied`, `robots_unreachable`, `fetch_error`), with no `ok` row and no
broken row, so the four judging rules write nothing and the silence would
otherwise go unexplained (§5.3). It closes the window `docs/gates/phase-13.md`
§8 pointer 1 named — the same class the all-unknown window was, one layer in.
The four markers — `resources.not-recorded` (`seen == 0`),
`resources.not-fetched` (every row unfetched), `resources.all-unknown` (every
row a decided unknown), `resources.partial-unknown` (the mix of null and
decided-unknown) — are mutually exclusive by construction and together partition
the "no `ok`, no broken, silent" space exactly: `resources.not-recorded` covers
`seen == 0`, and the other three split `seen > 0` into all-null,
all-decided-unknown, and the mix — so no crawl carries more than one. The ruleset moved to **0.11.0** for it (§11). Everything
else in Phase 14 was internal and never reached the seam: the per-host resume
now earns its spacing on two real gate hosts rather than a synthetic seed — the
same resume machinery §4.1a already documents, with no served field added,
removed, or retyped — and the phase closed the last of the engine-side ledger.

**What Phase 13 changed here**, so a reader of the Phase 12 version knows where
to look: **one shape was added and no served field changed.**
`resources.all-unknown` is a new resource-coverage marker (info) — the third of
the family, for a crawl where every recorded file landed in an UNKNOWN class
(`refused`, `robots_denied`, `robots_unreachable`, `fetch_error`) so no row is
`ok`, the four judging rules write nothing, and the silence would otherwise go
unexplained (§5.3). It completes the marker family: the three markers —
`resources.not-recorded` (`seen == 0`), `resources.not-fetched` (every row
unfetched), `resources.all-unknown` (every row a decided unknown) — are mutually
exclusive by construction, and the window Phase 12 stated open — an all-unknown
crawl that carried no marker at all — is now closed. The ruleset moved to **0.10.0** for it
(§11). Resume gained a per-host memory: `crawls.host_spacing_jsonb`
(`{host: earnedMs}`, migration 0015) records each host's earned spacing so a
resume re-enters each host at ITS OWN width rather than the crawl-wide widest,
with `host_spacing_ms` staying as the fallback for a host the map does not name —
a URL discovered only on the continuation, or a pre-0015 crawl whose map is null
(§4.1a, §8). This is resume machinery, not a new surface field: `crawl_status`
still serves the crawl-wide `hostSpacingMs`, and no served tool or route field
was added, removed, or retyped. `renderPassEvidence`'s two values are unchanged —
Phase 13 named them behind the wire (`RENDER_PASS_EVIDENCE.ran`/`.none`) and
pinned the shape against hardcoded literals, but the strings a consumer reads
(`"ran"`/`"none"`) are exactly what Phase 12 wrote (§4.5). Everything else in
Phase 13 was internal and never reaches the seam: the dev-database test residue
was swept back to the four reference crawls and the leak fixed at its source, and
the registry's NOT-MEASURED marker set is now derived from a per-rule flag rather
than a hand-written list.

**What Phase 12 changed here**, so a reader of the Phase 11 version knows where
to look: **`crawl_resume` is new** — the sixteenth tool and route, the way to
finish a crawl whose worker died without re-crawling the site (§4.1a), and with
it the crawl's earned per-host spacing now SURVIVES a resume rather than
resetting to the configured floor (§8); `crawl_status` gained
`resourceRefsCappedPages`, the count of pages whose resource references hit the
per-page cap, and the doctrine gained its null (§5.4); `resources.fetchClass`
gained `robots_unreachable`, splitting "the site forbade this file" from "we
could not read the site's robots.txt to find out" (§5.3, and the `resources` CSV
view); `resources.not-fetched` is a new NOT MEASURED marker for a crawl that
recorded its files and asked about none of them (§5.3), and the ruleset moved to
**0.9.0** for it (§11); and `render.coverage` gained `renderPassEvidence`, which
says whether a render pass ran at all — its selection numbers are recomputed, so
until now a crawl nobody rendered answered them exactly like one that was
(§4.5). No field was removed and no field changed TYPE — but one value NARROWED,
and a consumer comparing across the phase boundary has to know it:
`robots_denied` used to hold both "the site's robots.txt forbade this file" and
"we could not read the site's robots.txt", and from Phase 12 the second is
`robots_unreachable`. `fetch_class` carries no ruleset stamp, so §11's
comparability machinery says nothing about it: **a `robotsDenied` count from a
Phase 11 crawl and one from a Phase 12 crawl are counts of different
populations**, and no re-judge changes that — the class is written by the fetch
pass, not by a rule.

**What Phase 11 changed here**, kept for a reader coming from the Phase 10
version: `crawl_start` gained `fetchResources`; `crawl_status` gained
`fetchResources` and a `resources` block (§4.2); `export_crawl` gained a
`resources` CSV view (§12); the null-versus-zero doctrine gained a citizen whose
marker is a column rather than `rulesRunAt` (§5.3); `site.health` re-filed from
`CHECK-32` to `CHECK-83` (§6); and §10's "no resource fetching" entry is retired
in favour of what is and is not fetched.

## How this document was produced, and how to trust it

Every shape below was **regenerated from a live server** — an MCP client over
the SDK's in-memory transport, against the dev database's three
`lavishalice.com` reference crawls and against the test fixtures — and then
matched against the test that pins it. Nothing here was copied from a type
declaration by hand. The Phase 10 shapes were regenerated on 2026-09-01, the
Phase 11 additions (§4.2's `resources` block, §12's `resources` view) on
2026-09-02, and the Phase 12 additions (§4.1a's `crawl_resume`, §5.4's
`resourceRefsCappedPages`, §5.3's `robots_unreachable`, §4.5's
`renderPassEvidence`) on 2026-09-02, each read back through the transport suite
that now pins it — an MCP client over the in-memory transport and the HTTP
routes beside it, against real crawls of the fixture site rather than against a
type declaration.

Each section names the tests that hold it. A shape claim in this file with no
test beside it is a claim nobody is defending; if you find one, that is a
defect in this document.

**How a citation is written, and why it is written that way.** Every one is a
`file:line` naming the line an `it()` or a `describe()` opens, followed by a
VERBATIM fragment of that test's own title in quotes. The form is checked on
every run of the suite by `test/skills/identifier-guard.test.ts`: the line must
open a test, the quoted words must read out of that test's title, and the
fragment must fit exactly one title in the file. Phase 11 wrote that guard
because the Phase 10 edition of this document had 46 citations that had drifted
onto other lines as tests were inserted above them, and five of those survived
two hand-repair passes — each one pointing at real code that was not the code
its sentence described. Resolving is not the property that matters; naming the
right test is.

**A `src/` reference is written differently, and checked differently** (P12-T4).
No line number: a line of source declares no name a document can quote back, so
a source citation with a line on it would resolve forever while drifting
silently — the guard refuses one, and this paragraph cannot show you an example
because writing one would fail the suite. What it checks instead is that the
file exists and that an identifier the document quotes off it
(`src/db/schema.ts`'s `crawls.resource_refs_capped_pages` comment) is actually
in that file. The argument for the split is in the guard's own header.

Two properties make the double-transport claim below cheap to trust:

- **One service, two transports.** `src/api/service.ts` holds every query,
  refusal and vocabulary; `http.ts` and `mcp.ts` do routing and serialisation
  and nothing else.
- **The equality is tested, not argued.** `test/api/mcp.test.ts:2455`
  ("answers the same JSON for the same question, route by tool") calls thirteen
  (tool, route) pairs over the wire against one database and asserts the two
  answers are `toEqual`. `test/api/mcp.test.ts:2476` ("refuses in the same
  words, whichever transport asked") does the same for five refusals — the same
  sentence and the mapped status. `test/api/mcp.test.ts:2533` ("streams the
  bytes the other transport writes to a file") and `test/api/mcp.test.ts:2555`
  ("streams the resources view byte for byte") assert the CSV a route streams is
  byte-identical to the file the tool writes, for the `issues` and `resources`
  views.

  **What that equality does NOT cover**, stated so nobody reads more into it
  than it says: the five **command** tools — `crawl_start`, `crawl_resume`,
  `crawl_mark_failed`, `crawl_render`, `crawl_rules` — are excluded, because each
  one *changes* the database and a second identical call would be answering a
  different question (their own transport suites cover them, and for
  `crawl_resume` the second call is a refusal by design: the crawl the first one
  queued is now held by the server). And it compares **first pages only**:
  cursor behaviour is pinned per transport, by walks that page a listing to a
  null cursor, but page two is not compared across the two.

---

## 1. Transports, auth and trust

| | HTTP | MCP |
|---|---|---|
| Where | `node:http`, one port (`ARIADNE_API_PORT`) | stdio |
| Who may call | anyone with the bearer token | the process that started this one |
| Auth | `Authorization: Bearer <token>`, checked **before routing** | none, deliberately |
| Errors | status code + `{error}` | `isError: true` + one text block of `{error}` |
| Bulk data | `GET …/export` streams `text/csv` | `export_crawl` writes a file, answers with its path |

- The token is `ARIADNE_API_TOKEN`, minimum 16 characters, compared in constant
  time over SHA-256 digests (`src/api/auth.ts`). The server refuses to boot
  without one (`test/api/http.test.ts:2112` "refuses to produce a config without
  a token").
- **The token is checked before routing**, so an unauthenticated caller cannot
  map the surface: an unknown path answers 401, not 404
  (`test/api/http.test.ts:449` "checks the token before routing"). Every refusal
  names *which* thing was wrong — missing header, wrong scheme, wrong token.
- **MCP asks for no credential** and that is a posture, not an omission: an
  stdio client either started this process or was handed its pipes
  (`test/api/mcp.test.ts:2659` "asks for no bearer token: an stdio client is the
  process that started this one"). If Ariadne's MCP server is ever mounted on a
  network transport, that argument dies with the change and a credential has to
  arrive with it.
- **The domain allowlist binds both transports** (`ARIADNE_ALLOWED_DOMAINS`,
  exact host or `*.example.com`). An empty allowlist refuses every crawl
  trigger and still answers every query — the read-only posture a Talos
  deployment can run for reporting-only tenants
  (`test/api/mcp.test.ts:940` "refuses every crawl when the allowlist is empty",
  `test/api/http.test.ts:849` "refuses every crawl when the allowlist is empty,
  but still answers queries").
- **`ServiceConfig.allowAnyPublicHost` is a second code-only process-trust seam**
  (the first is `crawlDefaults`), and a Talos reader who finds the field in
  `src/api/config.ts` should read this rather than conclude the allowlist is
  optional. It accepts any host at the crawl-trigger allowlist gate and nothing
  else: it is never wired to env or to the wire (`loadApiConfig` does not read
  it, no request or tool field maps to it —
  `test/api/open-posture.test.ts:284` "loadApiConfig can never set the posture
  from the environment"), and `api:serve` and `mcp:serve` never set it. Its only
  setter is the local demo surface added in Phase 15: the `npm run demo`
  entrypoint `src/demo/serve.ts`, which binds `127.0.0.1`, and the server factory
  it constructs, `src/demo/server.ts`'s `createDemoServer`, which is where the
  assignment lives. `isUrlAllowed` still runs on every URL with `allowPrivate`
  sourced from `crawlDefaults` alone, so loopback and RFC1918 targets stay
  refused under the posture, with the policy's own reason rather than the
  allowlist's (`test/api/open-posture.test.ts:242` "the posture does not touch
  url-policy: loopback is refused with the policy's own reason"). Nothing
  tenant-visible changes: a deployment that does not set it in code — which is
  every deployment Talos talks to — behaves exactly as the allowlist rows above
  describe.

### Error bodies

| Situation | HTTP | MCP |
|---|---|---|
| Bad argument, bad value, unknown filter, compare of an unjudged crawl (§7.5) | 400 `{error}` | tool error `{error}` |
| Allowlist / URL policy refusal | 403 `{error}` | tool error `{error}` |
| No such crawl / rule / route | 404 `{error}` | tool error `{error}` |
| The row's own state forbids it (still running, retired rule id, unreadable stored evidence) | 409 `{error}` | tool error `{error}` |
| A defect of ours | 500 `{error: "internal error", correlationId}` | `{error: "internal error", correlationId}` |

`correlationId` is a UUID; the stack goes to the server log under that id and
nowhere else (`test/api/mcp.test.ts:2582` "turns an unexpected throw into a tool
error with a correlation id", `test/api/http.test.ts:2055` "turns an unexpected
throw into a 500 with a correlation id").

---

## 2. Conventions

**Pagination.** Every listing answers `{items, nextCursor}`. Pass `nextCursor`
back as `cursor` **with the same filters**; `nextCursor: null` means the listing
ended. `limit` defaults to 50 and is capped at 200 — a limit outside the
contract is refused, never clamped (`PAGE_SIZE_DEFAULT` / `PAGE_SIZE_MAX`,
`test/api/mcp.test.ts:1126` "refuses a limit outside the contract rather than
clamping it").

**Closed vocabularies.** Every query parameter, body field and tool argument is
on a closed list. `?serverity=critical` is a 400 naming both the typo and the
accepted set, never an unfiltered listing with a 200 on it
(`test/api/query.test.ts:2966` "refuses a typo'd filter instead of answering the
question nobody asked"). MCP argument typos are refused by the SDK's schema
validator before the handler runs (`test/api/mcp.test.ts:789` "refuses an
argument nobody allowed, naming it").

**Not paginated, on purpose:** `rules_catalog` and `crawl_compare`. Both are
bounded by the **ruleset** (95 rows at 0.12.0) rather than by the crawl. The catalog is
~101 KB (**103,679 bytes**, re-measured 2026-09-02 by the Phase 12 gate over all
93 rows of ruleset 0.9.0, by serialising what `rulesCatalog` answers with no
crawl id — the earlier 100,645 was measured at 92 rows, before
`resources.not-fetched` had copy of its own) because it carries every rule's full
copy — the tool description says so, and points an agent that only wants what
fired at `issues_list` instead.

**Timestamps** are ISO-8601 UTC strings. **Ids** are `crawl_<uuid>`; a caller
never constructs one.

**Empty is never a verdict.** An empty findings or metrics answer means "nothing
found" only on a crawl that was judged; `crawl_status.rulesRunAt` is the check.
This is the single most important sentence in this document and §5 is about
nothing else.

---

## 3. The order of operations

```
crawl_start ──▶ crawl_status (poll until status ∉ {queued, running})
                    │
                    ├─▶ crawl_resume   (only if it stopped with work owed: the SAME crawl continuing)
                    │
                    ├─▶ crawl_render   (optional; before the rules, if rendered evidence should be judged)
                    │
                    └─▶ crawl_rules    (writes findings + metrics; refused while the crawl moves)
                            │
                            └─▶ issues_list · issue_urls · metrics_get · pages_query · robots_get
                                rules_catalog (with crawlId) · export_crawl
                                crawl_compare · compare_urls (two judged crawls of one site)
```

One crawl runs at a time per server process; `crawl_start` answers
`{crawlId, status: "queued", queuePosition}` immediately. There are **no
webhooks**: polling `crawl_status` is the contract until Talos asks otherwise.

---

## 4. The tools, route by route

`crawlId` is required everywhere it appears unless the table says otherwise.

| MCP tool | HTTP | Arguments |
|---|---|---|
| `crawl_start` | `POST /crawls` | `siteUrl` (required), `maxPages`, `maxDepth`, `userAgent`, `perHostDelayMs`, `maxConcurrency`, `probeHosts`, `legacyHosts[]`, `sitemapUrls[]`, `renderBudgetPct`, `renderMaxPages`, `renderSamplePerType`, `findingCap`, `fetchResources` |
| `crawl_status` | `GET /crawls/:id` | — |
| `crawl_list` | `GET /crawls` | `siteUrl`, `limit`, `cursor` |
| `crawl_resume` | `POST /crawls/:id/resume` | — |
| `crawl_mark_failed` | `POST /crawls/:id/fail` | — |
| `crawl_render` | `POST /crawls/:id/render` | `urls[]` (optional; replaces the automatic selection) |
| `crawl_rules` | `POST /crawls/:id/rules` | — |
| `robots_get` | `GET /crawls/:id/robots` | — |
| `issues_list` | `GET /crawls/:id/issues` | `severity`, `checkId`, `ruleId`, `category`, `pageType`, `limit`, `cursor` |
| `issue_urls` | `GET /crawls/:id/issues/:ruleId/urls` | `ruleId` (required), `limit`, `cursor` |
| `metrics_get` | `GET /crawls/:id/metrics` | `metricId`, `scope`, `scopeValue`, `limit`, `cursor` |
| `pages_query` | `GET /crawls/:id/pages` | `pageType`, `statusCode`, `indexable`, `rendered`, `fetchClass`, `discoveredVia`, `limit`, `cursor` |
| `rules_catalog` | `GET /rules` | `crawlId` (**optional** — the only tool where it is) |
| `crawl_compare` | `GET /compare` | `baseCrawlId`, `headCrawlId` (both required) |
| `compare_urls` | `GET /compare/urls` | `baseCrawlId`, `headCrawlId`, `ruleId`, `set` (all required), `limit`, `cursor` |
| `export_crawl` | `GET /crawls/:id/export` | `format` (`jsonl.gz` \| `csv`), `dataset` (jsonl.gz only), `view` + `ruleId` (csv only) |

Pinned: the tool list and every schema — `test/api/mcp.test.ts:619`
("advertises exactly the sixteen tools of the agent surface"),
`test/api/mcp.test.ts:645` ("closes every input schema and describes every
field"), `test/api/mcp.test.ts:677` ("names every member of the closed
vocabulary each field enumerates"), `test/api/mcp.test.ts:706` ("advertises
exactly the crawl-start fields the service accepts"). Each tool's field set is
asserted against the service's own
`START_CRAWL_FIELDS` / `RENDER_CRAWL_FIELDS` tables, so an HTTP field the agent
surface cannot see fails the suite.

### 4.1 `crawl_start` → `{crawlId, status, queuePosition}`

`status` is always `queued` at acceptance. Refusals: a host off the allowlist
(403, naming it), a legacy host or supplied sitemap off the allowlist (403), a
`siteUrl` that is not http(s) (400), `perHostDelayMs` under the floor (400,
naming the floor), `allowPrivate` at any value (400 — it is not a wire field),
an unknown field (400, naming it).

### 4.1a `crawl_resume` → `{crawlId, status, queuePosition}`

The same answer shape as `crawl_start`, because **it is the same crawl
continuing**: same id, same row, same frontier, and no page already on record is
fetched again. `status` is `queued` at acceptance and `crawl_status` is polled
from there exactly as after a start.

It exists because of §5 of `docs/gates/phase-11.md`. The gate crawl's session
harness stopped the API server 40 minutes into the resource pass; the engine
closed the row `cancelled` with 786 files honestly unasked, and finishing them
took a script with a database handle — a move a Talos-driven deployment does not
have. The engine could always resume; the wire could not ask it to.

**Trust posture is `crawl_start`'s, re-applied to the STORED site.** The caller
names an id and nothing else, so the allowlist and the URL policy are re-checked
against `crawls.site_url`, and `legacyHosts` / `sitemapUrls` are re-checked too
because a resume re-runs discovery and the host probe. A crawl accepted last
month is not standing permission: a site that has left the allowlist is a 403
naming the host. Pacing comes from the crawl's own stored config, never from this
server's current defaults.

**The politeness ratchet survives, and it WIDENS.** `crawls.host_spacing_ms`
above the crawl's base is a finding — a host refused us and the engine backed off
— so the resumed run's gate is built with it and a crawl that reached 8s resumes
at 8s. Until Phase 12 it did not: the gate came up at the configured floor and
the first spacing write put that floor back over the evidence, which made the
regression invisible from `crawl_status` as well as rude to the site
(`test/crawl/loop.test.ts:986` "resumes at the spacing the crawl earned, not the
one it was configured with").

Two things that column is not, because a reader will otherwise assume both:

- **It is the crawl-wide fallback, not the per-host truth.** It is one number for
  the whole crawl — the widest spacing any host reached — so on its own it would
  apply that width to *every* host a resume touches, including ones that never
  pushed back. Since Phase 13 (migration 0015) the per-host truth lives beside it
  in `crawls.host_spacing_jsonb` (`{host: earnedMs}`): each host re-enters ITS OWN
  earned spacing, so a crawl whose CDN earned 8s while the origin stayed at 1s
  resumes the CDN at 8s and the origin at 1s. `host_spacing_ms` stays as the
  fallback a host the map does not name falls back to — a URL discovered only on
  the continuation, or a pre-0015 crawl whose map is null — which is the polite
  direction, never a fabricated split. The 30s cap still bounds both.
- **It is not only earned.** The loop writes the spacing once before its first
  fetch, so a crawl that never escalated still stores `max(perHostDelayMs, robots
  Crawl-delay)`. Consequences: a `Crawl-delay` the site has *since removed* stays
  sticky across every resume of that crawl, and a resume can never *lower* a
  crawl's spacing by config change, because the fold only ever raises. Both fail
  in the safe direction; a caller who needs the lower pace starts a new crawl,
  which has no column to read.

**A resume can cost more than "the remainder".** The engine's resource-fetch caps
(operator-configured; not wire fields) are budgets **per run**, not per crawl, so
resuming a crawl whose resource pass hit its cap grants the whole budget again
and may weigh a budget's worth of further files. That is legitimate work — those
files were seen and never asked about — but it is a second round of requests to
somebody's servers, and the `resources` block's `capped` flag is how to know
beforehand which crawls this applies to.

**It unjudges the crawl.** `rules_run_at` is cleared in the same statement that
queues the row, because the crawl is about to grow: a timestamp left standing
would claim a completed rules pass describes pages that did not exist when it
ran, `findingsCount` would sit beside a larger `pagesScanned`, and
`crawl_compare` would inherit the staleness believing both sides were judged —
against §2's "empty is never a verdict", which rests entirely on that field.
Findings rows are left in place and then read exactly as a run that died
part-way, which §5 already covers. Re-run `crawl_rules` after the resumed crawl
finishes (`test/api/http.test.ts:1288` "unjudges a crawl it queues, so no
timestamp outlives the pages it described").

Refusals, each naming which one fired: no such crawl (404); this server already
holds it (409); an unexpired lease says a worker is still on it (409, naming the
count — `leased_until` is the frontier's own live-worker detector); a settled
crawl with nothing owed (409, naming what was counted — pending frontier rows,
expired leases, unasked resource rows); the allowlist (403, naming the host); and
the row changing state under the call (409 — see the race below).

**A `cancelled` crawl WITH work left is resumable, and that is a ruling.** The
abort path decides nothing on its way out: URLs never leased stay pending,
resource rows never reached stay null with no reason, and the 404 probe and the
resource pass are skipped rather than recorded as having found nothing. So what
an abort leaves is exactly the set of questions nobody has answered, and an
operator who changes their mind is the ordinary case. `failed` is here on the
same terms. A caller who wants the crawl dead rather than continued still has
`crawl_mark_failed`.

**Pages waiting on the render pass are NOT resumable work.** `render_pending`
rows are already-crawled pages the selection promoted and the crawl loop never
leases them; the refusal names them and points at `crawl_render`
(`test/api/http.test.ts:1398` "names render_pending rows as the render pass's
work, not a resume's"). Neither are the null `fetch_class` rows of a crawl
configured with `fetchResources: false` — those carry the operator's decision,
and a resume would not ask about them
(`test/api/http.test.ts:1375` "does not read an off switch as resumable work").

**The honest race.** The two liveness checks are a snapshot: a lease can expire
between the count and the enqueue, and a worker this server cannot see can take a
fresh one just after. The claim itself is a **compare-and-swap** on the status
the call read, and its row count is *read*: zero rows means something else moved
the crawl in between, and the answer is a 409 rather than a queued crawl whose
row says something else — the silent no-op hard rule 7 forbids. That narrows the
double-accept race as far as it goes without a lock (of two callers past the
guards, only the one whose UPDATE lands first is accepted), and it cannot close
the window against a process that never touches the status
(`test/api/http.test.ts:1317` "409s when the crawl's state changes under the
call, rather than queueing anyway").

For the remainder, the guard is not the safety mechanism — `leaseBatch` is.
Two workers leasing at the same instant get disjoint batches (`for update skip
locked` over a materialized CTE), and a page row lands in the transaction that
moves its frontier row to `done`, so the worst case is two workers dividing one
frontier: slower each, twice the politeness pressure, every page still written
once. This is also why a resume never reclaims leases — that would hand a live
worker's URLs to a second one.

**What it does not report.** Nothing about what the resumed run found.
`crawl_status`, reading the database, remains the truth: on the gate crawl the
resumed pass's own summary said 784 resources and `crawl_status` said 1,995
across 11 hosts, and both were true — one describes a process, the other the
crawl (§5.3, and `docs/gates/phase-11.md` §5).

Proven end to end, not argued: a real fixture crawl killed in the middle of its
resource pass by stopping the server that ran it, resumed over the wire by a
different server, reaches the totals of a control crawl that was never killed —
3 pages, 24 resources seen and weighed, 0 unasked, 23 findings, on both
(`test/api/http.test.ts:1213` "a killed crawl resumed over the wire reaches the
totals of a control that was never killed"; the MCP half is
`test/api/mcp.test.ts:1438` "finishes a crawl a server was killed in the middle
of, and keeps its earned spacing").

### 4.2 `crawl_status` → the crawl in full

The live answer for `crawl_02ff6f7a`, pasted as it came back (2026-09-02) —
nothing here is elided or tidied:

```json
{"crawlId":"crawl_02ff6f7a-203c-4771-805c-feede04aed11",
 "siteUrl":"https://lavishalice.com/","status":"finished",
 "startedAt":"2026-08-29T15:21:44.994Z","finishedAt":"2026-08-29T15:40:16.915Z",
 "pagesCrawled":551,"pagesTotal":null,"renderPassCount":14,
 "rulesetVersion":"0.6.0",
 "frontier":{"pending":0,"leased":0,"done":551,"failed":0,"renderPending":0},
 "queuePosition":null,"liveLeases":0,"blockedPages":0,"hostSpacingMs":2000,
 "legacyHosts":[],"sitemapUrls":["https://lavishalice.com/sitemap.xml"],
 "findingCap":null,"rulesRunAt":"2026-09-01T08:51:55.386Z",
 "findingsCount":17659,"pagesScanned":551,"fetchResources":true,
 "resourceRefsCappedPages":null,
 "resources":{"seen":0,"fetched":0,"failed":0,"skipped":0,
              "robotsDenied":0,"robotsUnreachable":0,"capped":false}}
```

Read as a Talos dashboard: `blockedPages` and `hostSpacingMs` are the
politeness pair (§8) — this crawl was configured at `perHostDelayMs: 2000` and
finished at a spacing of 2000 with zero blocks, which is the shape of a crawl
that never had to back off; `rulesRunAt` + `findingsCount` are the judged-state
pair (§5); `findingCap` is **resolved** — an absent config key reports the
engine's default `200`, not `null`. `rulesetVersion` here is the ruleset at
CRAWL time, which is not necessarily the one that judged it (§7):
`renderPassCount: 14` pages were rendered under 0.6.0 and every finding on this
crawl was written under 0.7.0.

**The `resources` block, and the trap this paste happens to demonstrate.** This
crawl ran before migration 0013, so every number is `0` and `fetchResources`
resolves to `true` — nobody turned the pass off; there was no pass. **Seven
zeroes here are not "this site references no files."** The finding that says
which it is, is `resources.not-recorded` (§5.3).

- `seen` — distinct files the SERVED HTML points at, images, stylesheets and
  scripts. Recorded even when `fetchResources` is false; a file a script injects
  at runtime is not in it at all.
- `fetched` — a server answered about the file.
- `failed` — a server could not: a 4xx or 5xx, a request that failed, a URL our
  own policy refused, a file robots.txt put out of reach. **A count of files that
  could not be weighed, not a count of broken files** — `resources.broken` is the
  rule that judges that.
- `skipped` — **seen, not asked**: the pass has not run, was interrupted, hit a
  cap, or was turned off. Each row carries a `fetchReason` saying which, on the
  `resources` CSV view (§12).
- `robotsDenied` — the part of `failed` a robots.txt we READ caused: the host
  served its rules and they forbid us.
- `robotsUnreachable` — the part of `failed` caused by a host that **could not
  tell us its rules**: robots.txt answered 5xx, timed out, failed at the network,
  or sat at a URL our own policy refused. RFC 9309 §2.3.1.4 makes that a complete
  disallow, so the BEHAVIOUR is identical to the line above (no request was made
  either way) and the FACT is not: this is usually a third party's CDN briefly
  down, not a policy the client chose. Until this split the two were one count
  and only the per-row `fetchReason` told them apart; the split is taken off the
  crawl's `RobotsInfo.outcome` — a closed vocabulary — and never off the reason
  sentence, because a count built by matching prose goes silently to zero the day
  somebody rewords an error message. **A crawl run before the split has every
  robots refusal in `robotsDenied`**; nothing was rewritten.
- `capped` — a resource budget (`maxResources` / `maxResourceHosts`) stopped the
  pass short of at least one file. **One flag for both caps**, because the row
  records one reason whichever cap it was; the in-run split lives on the crawl
  loop's own summary and never reaches the wire. Those budgets are **per run,
  not per crawl** (§4.1a): a resume grants the whole budget again, so a crawl's
  lifetime total can exceed `maxResources`.

`fetched + failed + skipped == seen`, on every crawl. Those three are read in ONE
statement so that stays true while a pass is writing rows underneath a poller.
`robotsDenied` and `robotsUnreachable` are **subsets of `failed`** and are not
terms in that sum — adding the second one moved no arithmetic.

**`resourceRefsCappedPages` sits outside the block**, and the placement is the
contract: it counts **pages**, not files, and it is a number the crawl STAMPED at
close rather than one counted live off the table. It is how many of this crawl's
pages carried more resource **references** than the analyzer's cap keeps — 2,000
per page, the rest turned away. On those pages **`resources.seen` may be a
floor**: some of the turned-away references would have been files nobody
recorded, so a count over the census may be a count over a sample of that page's
references. Read §5.4 before quoting it — the field claims references turned
away, not files lost, and `null` is not `0`.

**`fetchResources` is the denominator for all of it** — resolved like
`findingCap`, so an absent key reports the default `true`. `false` beside
`fetched: 0` is an operator's decision (a client who asked us not to touch their
CDN, a re-crawl that only needs the page census); `true` beside the same zero is
a pass that has not run or could not finish. A stored value that is not a boolean
is a **409**, never a guess: `"false"` is truthy.

Pinned: `test/api/query.test.ts:1393` "the fields an audit checks itself against"
(10 tests over the whole block — the marker, the live findings count,
`pagesScanned`, the one-statement read), `test/api/query.test.ts:1506` "counts
the resource census off the database, partitioned exactly",
`test/api/query.test.ts:1548` "answers the block on a crawl that holds no
resource rows at all", `test/api/query.test.ts:1567` "reports the cap-exceeded
page count a crawl stamped, and null when none did",
`test/api/query.test.ts:1594` "echoes whether the crawl
asked about its files", `test/api/query.test.ts:1612` "409s a stored
fetchResources that is not a boolean"; over the agent transport,
`test/api/mcp.test.ts:1023` "answers the resource census and whether the crawl
asked for it" and `test/api/mcp.test.ts:1053` "tells an agent what the resource
numbers mean, and what they do not". The robots split itself is
`test/crawl/fetch-resources.test.ts:860` "classes an unreachable third-party
robots.txt apart from a forbidding one" and
`test/crawl/fetch-resources.test.ts:878` "keeps `robots_denied` for a file the
robots file actually forbade". Shape regenerated live from `crawl_02ff6f7a`
(2026-09-02, after migration 0014).

### 4.3 `issues_list` → `{items: IssueGroup[], nextCursor}`

```json
{"ruleId":"links.orphan","checkIds":["CHECK-32"],"severity":"warning",
 "category":"links","title":"Page has no internal links pointing to it",
 "count":243,"sampleUrls":["…","…"]}
```

`truncated: true` plus `total` **or** `atLeast` appears when that rule capped
its listing; **their absence means the count is the whole number**. `count` is
the rows the rule wrote — under a `pageType` filter it is legitimately smaller
than the note's own `reported`. `sampleUrls` is at most 5 and is a sample, never
a slice: `issue_urls` is the slice.

Pinned: `test/api/query.test.ts:838` "groups by rule, orders by severity then
rule id", `test/api/query.test.ts:981` "says so when a rule's listing was capped"
(the capped shape); `test/api/mcp.test.ts:1587` "groups findings by rule, orders
them by severity" and `test/api/mcp.test.ts:1601` "carries a capped rule's real
magnitude".

### 4.4 `issue_urls` → `{items: [{url, evidence}], nextCursor}`

`url` is `null` for a site-wide finding. `evidence` is the rule's stored
`details_jsonb` **verbatim** — it always carries the rule's own `pageUrl` key.
Pinned: `test/api/query.test.ts:1043` "returns the URL slice with the evidence as
stored", `test/api/query.test.ts:1059` "never leaks a column the projection did
not name", `test/api/query.test.ts:1067` "carries a finding with no page as a
null url".

### 4.5 `metrics_get` → `{items: MetricRow[], nextCursor}`

`{metricId, scope, scopeValue, value, title, explanation, checkIds, category}`.
`value` is the metric's own object — its shape belongs to the metric, and the
copy travels with it. Scopes: `site | page_type | rule`. See §6 for
`site.health` and for the absent-family trap.
Pinned: `test/api/query.test.ts:1101` "returns the stored value with the
registry's copy joined", `test/api/mcp.test.ts:1991` "answers the measured
numbers with their copy joined".

**One field inside one metric's value that this contract does pin, because it
governs how the rest of that value is read** (P12-T4): `render.coverage`'s
`renderPassEvidence`, `"ran"` or `"none"`. The four `selection*` numbers beside
it are RECOMPUTED from the crawl's own columns — the render selection has no
table of its own — so before this field a crawl nobody had ever rendered
answered `selectionSelected: 18` exactly as a crawl rendered last week does, and
`pagesRendered: 0` was the only thing saying otherwise. It is not enough: a pass
that ran and rendered nothing writes the same zero. `"ran"` means something on
this crawl was written by a render pass — a rendered page, a `render_error`, a
named URL list, the pass's stamped count, or a page still queued for a browser.
`"none"` means none of that is there, so the selection numbers are what a pass
WOULD choose and no absence of rendered evidence is a fact about the site. Read
it before quoting any JavaScript finding. Pinned:
`test/api/mcp.test.ts:1298` "says over the wire whether a render pass ran, not
just how many pages it left", `test/api/http.test.ts:1715` "serves
renderPassEvidence none beside the selection a pass would make",
`test/rules/render-metrics.test.ts:528` "answers none on a crawl nobody
rendered, and still reports what a pass would choose".

### 4.6 `pages_query` → `{items: PageRow[], nextCursor}`

```
url, statusCode, fetchClass, fetchReason, pageType, indexable, depth,
clickDepth, discoveredVia, wordCount, renderableWordCount, rendered,
renderedWordCount, renderedRenderableWordCount, renderError
```

Deliberately slim: `pages` has sixty columns and an endpoint that returned them
would be an export in listing clothes (obligation 1). `clickDepth: null` means
*unreachable*, never zero. `renderError` is why an **attempted** render produced
nothing; null there is not "it worked".

**No per-page resource rollup here, and that is a decision rather than an
omission** (P11-T4). A file count or a byte sum per page would be cheap enough to
compute — the edge table is indexed by page — and it would still be wrong to put
here: it is an aggregate of ANOTHER table on a listing whose whole discipline is
one row per page of that page's own columns, and a bare number could not carry
the two bounds every weight figure needs (the `src`+`srcset` ceiling, the
unweighed-file floor). Per template it is `metrics_get` with
`metricId: "page.weight"`, which states both; per file it is the `resources` CSV
view (§12), which carries `referencingPages`.
Pinned: `test/api/query.test.ts:1159` "returns a slim projection and nothing
else", `test/api/query.test.ts:1240` "carries both word counts, so the number a
reader quotes is the one they can see", `test/api/mcp.test.ts:2014` "answers the
crawled pages, slim and ordered by URL".

### 4.7 `robots_get` → the robots.txt this crawl obeyed

`{crawlId, robotsUrl, outcome, raw, truncated, crawlDelaySec, note,
sitemapSources[], suppliedSitemaps[], userAgent}`. It is **stored evidence, never
a re-fetch**: the file as the crawl read it, which is the only honest answer to
"what did this crawl obey". `outcome ∈ read | absent | unreachable`, and
`unreachable` is not "there are no rules" (RFC 9309 §2.3.1.4).
Pinned: `test/api/query.test.ts:1288` "answers with the robots.txt the crawl
read, and the metadata that makes it readable", `test/api/mcp.test.ts:2092`
"answers with the robots.txt the crawl read, verbatim".

### 4.8 `crawl_list` → `{items: CrawlListItem[], nextCursor}`

`{crawlId, siteUrl, status, startedAt, finishedAt, pagesCrawled,
renderPassCount}`, newest first.

`siteUrl` narrows the listing to **one site family**: apex ↔ `www`, either
scheme, any port, any path — `https://www.example.com/deep?a=1` finds a crawl
seeded as `http://example.com/`. It is the engine's one definition of "the same
site" (`hostnameSpellings`), the same one the cross-site compare refusal uses.
A `siteUrl` that is not an http(s) URL is **refused by name and never read as
"no filter"** — a dropped filter would answer with every crawl the engine holds.
Pinned: `test/api/query.test.ts:2369` "narrows the listing to one site, and
leaves the other site's crawls out", `test/api/query.test.ts:2375` "matches the
apex and www spellings, both schemes", `test/api/query.test.ts:2389` "refuses a
siteUrl that is not an http(s) URL rather than dropping the filter";
`test/api/mcp.test.ts:1886` "narrows crawl_list to one site".

**Pre-tenancy posture, stated plainly (see §9).** Without `siteUrl`, this
listing returns every crawl the engine holds, including other tenants'
`siteUrl`s, to any caller holding the token.

---

## 5. Null versus zero — the surface's one hard rule, at both ends

An empty answer and a zero are different sentences, and Ariadne spells them
differently everywhere. A dashboard that collapses them paints a clean site over
one nobody has examined.

The doctrine has six spellings on this surface, and this section carries four
of them: the catalog's `fired: null` (§5.1), the metrics' absent family (§5.2),
the resources' `fetchClass` null (§5.3), `resourceRefsCappedPages: null` (§5.4),
the compare's outright 400 for an unjudged crawl (§7.5), and
`render.coverage`'s `renderPassEvidence: "none"` (§4.5, §13). The catalog's, the
metrics' and the compare's are faces of one rule, keyed by the same marker
(`rulesRunAt`); `fetchClass` and `resourceRefsCappedPages` are each keyed by a
column. The sixth is the odd one and is counted anyway: it is a STRING, not a
null — the metric's numbers are all present and non-null — but it says the one
thing the others say, that nobody measured, so a dashboard that reads it as a
label rather than as a not-measured marker paints exactly the clean site this
rule exists to prevent. The converse
matters just as much: `issues_list`, `metrics_get` and the exports serve
whatever rows exist even on a crawl whose judgement never completed — a
partial pass's rows are real rows, and **only `rulesRunAt` says whether they
are a finished judgement**. Read the marker before quoting any count as the
site's.

### 5.1 `rules_catalog` — three states of `fired`

```json
{"rulesetVersion":"0.7.0","rules":[{"id":"links.orphan","kind":"query",
 "severity":"warning","category":"links","checkIds":["CHECK-32"],
 "title":"…","explanation":"…","howToFix":"…","fired":{"count":243}}]}
```

| state | spelling | what it means |
|---|---|---|
| no crawl named | the `fired` key is **absent** | the checklist skeleton: what the engine *can* look for |
| crawl named, never judged | `"fired": null` | nothing is known about this rule on this site |
| crawl named, judged | `"fired": {"count": N}` | the rule ran; **`count: 0` is a measurement** |

Two flags ride beside a count:

- **`atLeast: true`** — the rule capped its listing, so `count` is a floor.
  Render it as "243 or more", never as "243". The magnitude lives on
  `issues_list` (`truncated` + `total`|`atLeast`), deliberately not here: two
  subtly different numbers on 86 checklist rows would be two sources of truth.
- **`measuresOnly: true`** — the rule's `kind` is `metric`. It **measures rather
  than finds: it writes no issues**, so its `count` is 0 on every judged crawl,
  structurally, whatever the site is like. Without this flag a metric rule's
  `{count: 0}` is byte-identical to a genuine clean check, and a dashboard would
  render "passed" against a rule that never had a verdict to give. Its numbers
  are in `metrics_get`.

**The counts sum to `crawl_status.findingsCount`.** Verified live on
`crawl_02ff6f7a`: 86 rules, 22 fired, counts summing to 17,659 = its
`findingsCount`. On the capped `crawl_3f3ab847`: sum 1,326, with `atLeast: true`
on exactly `content.near-duplicate` (500) and `links.orphan` (200).

**A catalog total counts ROWS WRITTEN, not cases that exist.** Under a finding
cap the two differ by construction, which is what `atLeast` is for. Quoting a
catalog count to a client as "the number of orphans on this site" is the Phase 6
D-1 incident recurring in a new place.

Pinned: `test/api/query.test.ts:1649` "answers the whole ruleset with its
client-facing copy and no fired state", `test/api/query.test.ts:1691` "joins a
judged crawl's fired state, and counts a clean rule as zero",
`test/api/query.test.ts:1715` "marks a metric rule's structural zero apart from a
real clean", `test/api/query.test.ts:1741` "says fired null on a crawl nobody has
judged, however many rows it holds", `test/api/query.test.ts:1758` "marks a
capped rule's count as a floor, agreeing with issues_list",
`test/api/query.test.ts:1797` "reads the marker and the counts from one
statement"; `test/api/mcp.test.ts:1707` "joins a judged crawl's fired state, zero
included, summing to findingsCount" and `test/api/mcp.test.ts:1770` "names every
field it actually answers with".

### 5.2 `metrics_get` — an absent family is not a zero gauge

The metrics listing answers with **the rows a rules pass wrote**. A metric
family that is missing from the answer has not measured zero: nobody ran it, or
it ran under an older ruleset that did not have it. `site.health` is exactly
this case on the reference crawls — they were judged before the family existed,
so `metrics_get(metricId: "site.health")` on them returns `{items: [], nextCursor: null}`,
which is *not* "this site has no health".

The rule for a consumer is the catalog's rule, one surface over: **read
`rulesRunAt` first, then read absence as "not measured" and a number as a
measurement.** A gauge drawn from an absent family is a gauge drawn from
nothing.

### 5.3 `fetchClass` null — seen, not asked

The doctrine's newest citizen, and the first one whose marker is a COLUMN rather
than `rulesRunAt`. A `resources` row with a null `fetch_class` — an empty
`fetchClass` cell in the CSV, a unit of `crawl_status.resources.skipped` — means
**the analyzer found this reference and nothing ever asked the server about it**.
It is not "the fetch failed", which is `fetch_error`, and it is not "the file is
fine", which is `ok`.

Four different sentences live under that one null, and the row's `fetchReason`
is what separates them:

| `fetchReason` | what happened |
|---|---|
| `resource-cap` | a resource budget (per run, not per crawl — §4.1a) stopped the pass short of this row |
| `resource-fetch-off` | the crawl was started with `fetchResources: false` |
| *(empty)* | the pass was interrupted, or has not run over this crawl at all |
| *(empty, and no rows exist)* | the crawl predates migration 0013 |

**One combination collapses two of those rows, and `crawl_status` is the
discriminator.** A crawl started with `fetchResources: false` that was then
CANCELLED before its pass slot leaves its rows null with an empty reason, exactly
as an interrupted pass does — the stamp is written where the pass would have run,
and an abort skips it, deliberately, because a cancelled crawl decided nothing
about anything. `fetchResources: false` on the crawl detail is what separates the
two, which is the other reason the echo is on the shape: on that one crawl the
rows cannot say it and only the config can.

**Two consequences a consumer must plan for.**

1. **A silent resource rule is not a clean site.** `resources.broken`,
   `images.oversized`, `images.legacy-format` and `resources.uncached` all gate
   on a non-null class, so on a crawl that asked about nothing every one of them
   is silent. TWO NOT MEASURED markers cover that silence, and no crawl can carry
   both. `resources.not-recorded` (info) fires when the crawl holds no resource
   rows AT ALL; it deliberately does not fire when the rows exist and are merely
   unasked, because in that case the crawl DID record what it saw. That second
   case is `resources.not-fetched` (info), the sibling added in Phase 12
   (ruleset 0.9.0): the rows exist, not one of them was put to a server, and the
   finding's evidence says which of three reasons applies — `reason:
   "fetch-off"` for an operator's `fetchResources: false`, `reason:
   "pass-not-run"` for a pass that sent no request at all, `reason: "budget-cap"`
   for a `maxResources` that claimed every row before anything was asked —
   beside `resourcesSeen` and `resourcesSkipped`, which are equal. A PARTIAL pass
   gets neither marker: something was measured, and the judging rules carry
   `unknownResources` on the findings they write. Both marker cases are also
   legible on `crawl_status`: `fetchResources: false`, or `skipped` equal to
   `seen`. **Read the coverage block before quoting any resource finding, or the
   absence of one.**

   **A third case, and since Phase 13 it has its own marker:** a crawl where
   every file landed in an UNKNOWN class (`refused`, `robots_denied`,
   `robots_unreachable`, `fetch_error`). Rows were decided, so neither
   `resources.not-recorded` nor `resources.not-fetched` fires; no row is `ok`, so
   the four judging rules write nothing and the `unknownResources` counts that
   would explain the silence live on findings that do not exist. That silence is
   what `resources.all-unknown` (info, ruleset 0.10.0) reports: its evidence
   carries a per-class `census` (a count for each of the four unknown classes)
   and the `dominantClass`, beside `resourcesSeen` and `pagesCrawled`.

   **A fourth case, and since Phase 14 it has its own marker:** a PARTIAL pass —
   some rows still `null` (never asked about), the rest a decided unknown class —
   with no `ok` row and no broken row. The all-unknown marker excludes it (a null
   row means not every file was reached), not-fetched excludes it (not every row
   is null), not-recorded excludes it (rows exist), and the judging rules are
   silent for want of an `ok` row: the exact gap phase-13.md §8 pointer 1 named,
   one layer in. `resources.partial-unknown` (info, ruleset 0.11.0) now reports
   it, carrying the same per-class `census` and `dominantClass` as its sibling
   plus `resourcesUnfetched` — the count of files the pass never reached — beside
   `resourcesSeen` and `pagesCrawled`. The FOUR markers are mutually exclusive by
   construction — `seen == 0`, every row unfetched, every row a decided unknown,
   and the mix of null-and-decided-unknown — so no crawl carries more than one,
   and together they partition the "no `ok`, no broken, silent" space exactly:
   `resources.not-recorded` takes `seen == 0` (and only when the pages declared
   at least one fetchable reference), and the other three partition `seen > 0`.
   The discriminator on this block is unchanged: `fetched` at
   zero with `failed` carrying the census (and `skipped` non-zero for the partial
   case). **Read the coverage block before quoting any resource finding, or the
   absence of one.**
2. **`fetch_class` null is per FILE, so a page's weight can be a floor.** The
   `page.weight` metric flags `atLeast: true` on any row that references a file
   nobody weighed, and reports the referenced-and-weighed pair beside it.

Pinned: `src/db/schema.ts`'s `resources.fetch_class` comment (the column says
this); `test/api/query.test.ts:2089` "writes one row per referenced file, with
the class that makes an empty status readable" (all four spellings in the CSV);
`test/crawl/fetch-resources.test.ts:1327` "asks nobody anything when the operator
turned resource fetching off".

### 5.4 `resourceRefsCappedPages` null — nobody counted

The doctrine's second column-keyed spelling, and the one whose zero is the most
tempting thing to invent. The field counts **pages that carried more resource
references than the analyzer's cap keeps**: 2,000 per page, the rest turned away.

**References turned away, not files lost** — the claim is deliberately the weaker
one. Past the cap the analyzer stops resolving, so it cannot know whether a
turned-away reference was a new URL or a repeat of one it already holds. A page
whose 2,001st reference duplicates its first is counted here and lost no file at
all. That is the price of taking the signal where the cap is enforced instead of
resolving past it, which on the pages this cap exists for would be a URL parse
per reference, and it is a price paid in the direction of over-reporting rather
than silence.

- **`null` means nobody counted**, three ways. A crawl written before the counter
  existed (migration 0014); a crawl still running; and **a crawl whose process
  died before its first close and was later resumed** — the first run's pages
  went uncounted with the process that read them, and the resume adds to a null
  rather than replacing it, so that crawl reads `null` for ever. It is not a
  number the resume can repair, and a partial count presented as a whole one
  would be worse than the null. **Nothing was backfilled**, and nothing honestly
  could be: the edge table cannot tell a page that hit the cap from a page that
  happens to reference exactly that many distinct files. Every crawl in the
  reference database reads `null` today, the paste in §4.2 included.
- **`0` means the analyzer read every page of that crawl and none of them lost a
  reference.** A measurement.
- **A number means `resources.seen` MAY BE a floor on that many pages.** Some of
  the turned-away references would have been files nobody recorded, so counts
  derived from the census — broken files, uncached files, page weight — may be
  counts over a sample of those pages' references. Which pages, and whether any
  file was really lost, are both unanswerable from any surface. It is a cap, not
  a fault: the scalar page counters (`imagesTotal` and its siblings) are uncapped
  and stay exact, so nothing else on the page moved.
- **It is not a numerator over `pagesCrawled`.** This counts the analyses handed
  to the page writer; `pagesCrawled` is the crawl loop's own count off the
  frontier's settled rows. A crawl that analysed one URL twice — a redirect
  target also reached under its own row, whose second `pages` insert the unique
  index drops — can legitimately report more capped pages than pages crawled.
  Render it as a count, never as a percentage.

The count is carried rather than derived, and the reason is measured rather than
asserted: deriving it from the edge table costs a scan of every reference the
crawl holds — 73 ms and 67 ms over a 500,000-edge crawl, against a `crawl_status`
whose other reads are ≤ 3 ms and which a dashboard hits on every paint. The
analyzer flags the page, the page writer counts the flagged pages, and the crawl
loop stamps the total at close.

Pinned: `src/db/schema.ts`'s `crawls.resource_refs_capped_pages` comment;
`test/db/migration-0014.test.ts:232` "leaves the column null on a row no crawl
loop ever closed"; `test/db/migration-0014.test.ts:210` "stamps 0 on a crawl that
lost nothing — a measurement, not a silence";
`test/api/query.test.ts:1567` "reports the cap-exceeded page count a crawl
stamped, and null when none did".

---

## 6. `site.health` — the rollup, and everything it is not

One row per crawl, `scope: "site"`:

```json
{"urlsTotal":443,"urlsWithCritical":0,"urlsWithWarningOnly":400,
 "urlsWithInfoOnly":32,"urlsClean":11,"cleanRatio":0.0248,"pagesNotAuditable":108}
```

(Measured fresh on `crawl_02ff6f7a`, 2026-09-01.)

- **The census is `fetch_class = 'ok' AND status_code = 200` with HTML** —
  "pages the crawler fetched OK that answered 200 with HTML". It is neither the
  crawl's page count nor the other metrics' cohort: a `noindex` 200 page is
  still judged, so it is in.
- **The four buckets partition `urlsTotal` exactly.** A page is counted once, at
  the worst severity it carries. Site-level findings (no `page_id`) reach no
  bucket at all — a site-wide fault is not a share of the pages.
- **`pagesNotAuditable` is everything else, lumped: redirects, 4xx, 5xx, failed
  or refused fetches, non-HTML 200s, any other status.** One number for several
  unlike things, on purpose — it is a *remainder*, and its job is to stop 108
  pages vanishing silently beside a gauge. `urlsTotal + pagesNotAuditable` is
  the crawl's page count (443 + 108 = 551). Which kinds those are is a
  `pages_query` question; a non-HTML 200 is counted by no other table at all.
- **The four counts are the authority; `cleanRatio` is a convenience.** Four
  decimal places collapse at scale: 1 clean page in 50,000 rounds to `0.0000`
  and 49,999 in 50,000 to `1.0000`. Work percentages out from the counts.
- **`cleanRatio` counts pages with no reported finding.** Under a finding cap
  the listing rules stop writing rows, so pages past the cap are counted clean:
  on a capped run the ratio is a **floor of what is known**, not a fact about
  the site.
- **`cleanRatio` is `null` over an empty census** — nothing was measured, and
  both 0 and 1 would be claims about a site with no auditable pages.
- **`urlsWithCritical` is structurally near-empty today**, and the reference
  crawl's 0 is honest rather than flattering. Exactly three rules carry
  `critical` severity, and none of them can readily fill this bucket:
  `content.csr-dependent` and `nav.js-only` judge only pages the render pass
  actually rendered — that crawl rendered **14 of its 551 pages**, about 3% of
  the census, and neither rule fired on any of them — while `redirect.loop`
  fires on redirecting pages, which are **outside the auditable census by
  definition** (they are part of `pagesNotAuditable`), so its criticals can
  never enter a bucket at all. Do not read `urlsWithCritical: 0` as "nothing
  serious was found": read it as "almost nothing here is eligible to be
  critical".

**The check id, and the bridge that is now retired.** `site.health` carries
**`CHECK-83` "Engine coverage and evidence completeness"** — the check the audit
answers first, and the check this table is about: how far the judgement reached
over the pages the crawl could judge, and how many it could not judge at all.

It carried `CHECK-32` for one phase. That was a **filing** decision, made
because the checklist then had no coverage check and CHECK-32 was where a
partition of the page census lived; the Phase 10 review ruled it explicitly
temporary and ledgered the handoff, and Phase 11 discharged it. The metric's own
`explanation` moved with it: where it used to disclaim the id entirely, it now
says which check the row is evidence for — and keeps the sentence that has not
changed, that **no verdict on any other check may be reached from a crawl
summary** (the checklist's Evaluation Principle 2). Anything grouping rules by
check should render this table under coverage, not beside a finding about the
site.

A crawl judged under 0.7.0 has rows written while the id was `CHECK-32`; copy
and check ids are joined at read time, so such a crawl is described by today's
filing (§7.3).

**No grades, no labels, no thresholds** — here or anywhere else (§10). The row
is ingredients; the judgement is the consumer's.

Pinned: `test/rules/health-metrics.test.ts` (13 tests) —
`test/rules/health-metrics.test.ts:45` "carrying the engine-coverage check it is
evidence for", `test/rules/health-metrics.test.ts:208` "partitions the census
exactly", `test/rules/health-metrics.test.ts:239` "answers an empty census with a
null ratio", `test/rules/health-metrics.test.ts:260` "lets no site-level finding
poison a page bucket", `test/rules/health-metrics.test.ts:282` "keeps the pages
it cannot judge out of the buckets", `test/rules/health-metrics.test.ts:446`
"buckets the findings the capped run wrote, and no others"; the copy contracts —
`test/rules/copy.test.ts:945` "names every column, and says the ratio is of
reported findings", `test/rules/copy.test.ts:978` "remainder is open-ended and
names the case nothing else counts", `test/rules/copy.test.ts:993` "says the
counts are the authority, not the ratio", `test/rules/copy.test.ts:1019` "tells
its consumer which check it is evidence for" (which also asserts that the retired
filing disclaimer is GONE rather than merely superseded),
`test/rules/copy.test.ts:1046` "grades nothing: no score, no label, no threshold";
`test/rules/coverage.test.ts:326` "site.health is filed under the
engine-coverage check, and CHECK-32 lost no claimant" (the re-file in both
directions, and CHECK-83 outside the crawl-derived universe);
`test/fixtures/harness.test.ts:1806` "the health rollup agrees with a
page-by-page recount" — an independent recount in JavaScript over the end-to-end
fixture crawl.

---

## 7. Comparing two crawls

`crawl_compare` answers `{base, head, comparable, caveats, rules}`; the URLs
behind any count come from `compare_urls`, paginated. The summary carries counts
only — obligation 1's shape.

```json
{"base":{"crawlId":"crawl_3f3ab847…","siteUrl":"https://lavishalice.com/",
         "rulesRunAt":"2026-08-28T21:55:35.006Z","rulesetVersions":["0.5.0"],
         "findingCap":200,"findingsCount":1326},
 "head":{"crawlId":"crawl_02ff6f7a…","siteUrl":"https://lavishalice.com/",
         "rulesRunAt":"2026-09-01T08:51:55.386Z","rulesetVersions":["0.7.0"],
         "findingCap":null,"findingsCount":17659},
 "comparable":false,
 "caveats":[{"code":"ruleset-mismatch","message":"…"},
            {"code":"finding-cap-differs","message":"…"}],
 "rules":[{"ruleId":"links.orphan","severity":"warning","category":"links",
           "checkIds":["CHECK-32"],"title":"…",
           "baseCount":200,"headCount":243,"baseUrls":200,"headUrls":243,
           "new":43,"resolved":0,"persisting":200,
           "baseTruncated":true,"headTruncated":false}]}
```

### 7.1 What "the same finding" means

The join is **`(rule id, page URL)`**, read from the finding's own
`details_jsonb->>'pageUrl'`. It is not `dedupe_key`, which is whatever a rule
chose to make its findings distinct *within one crawl* and takes at least four
incompatible shapes — a content hash moves when the site edits a word, and a
`dedupe_key` diff would report "one resolved, one new" for a page that did not
change.

**The cost, stated because a consumer must state it too: a rule that fires more
than once on a page collapses to per-URL presence.** On the reference crawl the
comparison sees 281 near-duplicate URLs, not 16,789 rows, and a page that went
from two near-duplicate partners to fifty is `persisting`, not `new`. So every
row carries four counts:

- `baseCount` / `headCount` — finding ROWS, the numbers `issues_list` reports;
- `baseUrls` / `headUrls` — the distinct URLs the diff is actually over.

The two invariants a consumer may rely on, asserted on every row of both the
fixture and the real comparison:

```
headUrls == new + persisting        baseUrls == resolved + persisting
```

**Near-duplicate URLs are pair representatives.** `content.near-duplicate` finds
a *pair* of similar pages and files the finding against one of them; the URL in
this diff is that representative, not "the duplicate". A pair whose
representative changed reads as one `new` and one `resolved` even though the
site's duplication is unchanged.

Site-wide findings (no page) compare by **rule presence**: the key is the empty
string and the drill-down returns `url: null`.

### 7.2 `comparable` is a conjunction, and the codes are the discriminator

```
comparable = rulesetsAgree AND capsAgree
```

Both halves matter and they are never conflated: the reference pair differs in
**both**, and `caveats` carries `ruleset-mismatch` **and** `finding-cap-differs`
as two entries. The narrow reading (ruleset only) would have handed Talos
`comparable: true` over 43 "new" orphans that are an artefact of the base
crawl's 200-row cap.

| code | when |
|---|---|
| `ruleset-mismatch` | the sides' findings carry different single versions |
| `ruleset-unrecorded` | a judged side wrote no findings, or its rows predate the ruleset stamp |
| `ruleset-mixed` | one side holds findings from more than one version |
| `finding-cap-differs` | the two ran under different effective caps |
| `severity-changed` | a rule is recorded at different severities on the two sides |

**Switch on the `code`, quote the `message`.** A UI that parses the sentence
will break; a UI that renders only the code loses the reason.

**`comparable: true` is the weaker claim it sounds.** It says the two stamps
agree — not that the numbers mean the same thing. Engine behaviour has changed
under one held version before (Phase 8's `page_type` incident: 938 metric rows
vanished with no version number explaining it).

**Grey per ROW, not per column.** `comparable: false` is a statement about the
run, never a refusal — the counts come back either way. Which rules the cap
actually cut is `baseTruncated` / `headTruncated` on the row. Greying the whole
Change column throws away nineteen honest rows to caveat three.

**`ruleset-unrecorded` includes the "everything was fixed" case.** A judged side
that wrote **no findings at all** has nothing stamped with a ruleset, so the
engine cannot check the two sides against each other. That is the same code a
site with pre-stamp rows raises, and it is the one a genuinely clean re-crawl
will hit: `comparable: false` there does not mean the comparison is wrong, it
means the ruleset that judged the clean side is not on record. Read
`findingsCount: 0` on that side beside its `rulesRunAt` before concluding
anything.

### 7.3 Where a row's fields come from — the asymmetry

`severity` is read off the **rows** (the head's reading, or the base's for a
rule that fired only there). `category`, `checkIds` and `title` are the
**current ruleset's copy**, joined at read time — exactly as `issues_list` and
`rules_catalog` join it. Across two rulesets that asymmetry is visible: both
sides are labelled with today's words even where the older side's rule was
titled or filed differently when it ran. **The counts are each crawl's own; the
words beside them are today's.**

`rulesetVersions` is read off the FINDINGS' stamp, not off
`crawls.ruleset_version` — the two genuinely disagree (`crawl_02ff6f7a` was
crawled under 0.6.0 and re-judged under 0.7.0), and a comparison is about the
findings.

### 7.4 `compare_urls`

`{baseCrawlId, headCrawlId, ruleId, set, limit?, cursor?}` →
`{items: [{url}], nextCursor}`. `set ∈ new | resolved | persisting`:

- `new` — URLs only the **head** has;
- `resolved` — URLs only the **base** had;
- `persisting` — URLs both carry.

Which crawl is base and which is head is the whole meaning of the answer.
The drill-down runs the **identical pre-flight** as the summary, so it cannot
answer a question the summary refuses.

### 7.5 Refusals, in this order

1. **the same crawl on both sides** → 400;
2. **either crawl unknown** → 404, naming it (or both);
3. **different sites** → 400, naming both hosts;
4. **either crawl unjudged** → 400, naming which.

**3 before 4 is deliberate and tested.** A caller who names another tenant's
crawl learns that it is another site and *nothing else* — not whether it has
been judged, which is a fact about that tenant's work (obligation 6).

A `crawls.site_url` that is not a URL is a **409** ("whether they are the same
site cannot be decided"), never "different sites".

**The self-compare 400 has a UI consequence Talos should design for.** A compare
screen that defaults both pickers to the newest crawl refuses on first render.
Default the two sides to *different* crawls, or hold the request until the user
has chosen a second one — the refusal is right (a crawl diffed against itself
reports every rule `persisting` and every change zero, which a dashboard would
paint as "nothing changed on this site") and it is not an error state worth
showing a user.

Pinned: the whole `GET /compare` and `GET /compare/urls` blocks of
`test/api/query.test.ts` — the arithmetic, the per-URL collapse, every caveat and
every refusal — of which `test/api/query.test.ts:2438` "answers both sides,
comparable, and the rules in issues_list's order" is the answer itself and
`test/api/query.test.ts:2852` "makes the same refusals as the summary" is the
drill-down inheriting the summary's refusals; over the agent transport,
`test/api/mcp.test.ts:1833` "answers the counts and the caveat when the two
rulesets differ" and `test/api/mcp.test.ts:1898` "names every field it answers
with, and both caveat codes it produced".

**Measured, not fixtured** (2026-09-01, `crawl_3f3ab847` → `crawl_02ff6f7a`):
22 rules, `comparable: false` with both caveats, both invariants true on all 22
rows, nineteen rules reproducing to the URL, `structure.deep-page` 0 → 1 as
`new`, and the two cap-artefact rows flagged `baseTruncated: true`.

---

## 8. Crawling politely, and the knobs a Talos crawl sets

Obligation 4 in `docs/talos-integration.md` is the history; these are the
controls.

| knob | default | notes |
|---|---|---|
| `userAgent` | `AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)` | **Set it.** A Talos-driven crawl should present Talos's identity, and the UA is what a client allowlists in their WAF. |
| `perHostDelayMs` | 1000 | Floor **250** for anything that arrives over the wire — refused below it, never clamped. Genuinely polite is 1000–2000; the crawl skill recommends 2000 on anything Cloudflare-fronted. |
| `maxConcurrency` | 16 | The window, not the rate: the per-host delay and the governor bind first. |
| `maxPages` | 500 (API default) | A first look at a site. Say so when you want more. |
| `maxDepth` | 10 | |
| `probeHosts` / `legacyHosts[]` | probe on / none | Extra hosts are allowlist-checked at accept time, not mid-crawl. |
| `sitemapUrls[]` | none | At most 50 root documents; echoed on `crawl_status` and in `robots_get`. |
| `renderBudgetPct` / `renderMaxPages` / `renderSamplePerType` | 5% / 500 / 3 | The render pass's budget. |
| `findingCap` | 200 | `null` = uncapped, which is what a billed audit wants. It changes what every count in §5 and §7 means. |

Not settable over the wire at any value: `allowPrivate` (refused by name, on
both transports).

**What the engine does on its own:** robots.txt `Crawl-delay` is honoured
alongside the configured delay; a `blocked` answer halves the concurrency
window; a refusal that NAMES a rate (429, or anything carrying `Retry-After`)
doubles that host's spacing for the life of the crawl, capped at 30s; a refusal
that names no rate escalates only after three refusals across two URLs. A
blocked URL is retried up to three times under the widened spacing and then
settles as a classified row.

**Both halves are on `crawl_status`:** `blockedPages` (what the site did) and
`hostSpacingMs` (what the engine did about it). Rising `blockedPages` with
spacing pinned at 30s is where an operator decides; it is never a reason to
push harder.

---

## 9. Tenant safety — what a response can never carry

Obligation 6, as a checked property rather than a promise:

- No stack frame, no filesystem path, no repository document, no connection
  string, no private host, in any answer or any refusal. Pinned as a standing
  guard over live answers and over the CSV bytes:
  `test/api/query.test.ts:2910` "carries no path, no document and no stack in any
  answer this phase added" and `test/api/query.test.ts:2953` "holds for the CSV
  bytes, which are a response like any other".
- Refusals name **the caller's own words** — the ids they supplied, the field
  they misspelled, the accepted vocabulary — plus, for a cross-site compare, the
  two hostnames the caller asked about.
- Anything unexpected becomes `{error: "internal error", correlationId}` at both
  transports.
- Rule `evidence` is built from crawled rows by the registry's own discipline;
  the wrapper around it is a closed shape.

Three postures a Talos integrator should know about rather than discover:

1. **`export_crawl`'s file-writing mode answers with an absolute server path.**
   That is the answer to a tool whose job is to write a file, and the audience
   is an operator, not a tenant. **A tenant-facing Talos surface should use the
   HTTP CSV stream** (`GET …/export?format=csv&view=…`), which returns bytes and
   no path. Do not render the `path` field to a tenant.
2. **`pages_query.renderError`** is the only field whose text originates in our
   browser rather than on the site. It is capped to the first line of the error
   and carries no stack, but treat it as a diagnostic string rather than client
   copy.
3. **There is no tenancy isolation on crawl listing yet.** `crawl_list` without
   a `siteUrl` returns every crawl this engine holds — including other tenants'
   `siteUrl`s — to any caller with the token. The crawl row is the isolation
   unit (obligation 3) and every *per-crawl* read is scoped by id, but the
   listing is not scoped by anything. **Today's mitigation is deployment:** one
   Ariadne per tenant, or a Talos-side proxy that always passes `siteUrl` and
   never forwards an unfiltered listing. A per-caller scope is a real change to
   this surface (a tenant key on the crawl row, and a filter on every listing)
   and it is not in Phase 10.

---

## 10. What Ariadne will not do

- **No grades, scores, labels or thresholds.** `site.health` ships counts and a
  ratio and says in its own copy that it grades nothing; a copy test asserts the
  judgement vocabulary appears nowhere in it. Severity-in-context is the
  consuming agent's job.
- **No revenue or business judgement.** The engine has no idea what a page is
  worth. It measures.
- **No prioritisation beyond rule severity.** The priority split a dashboard
  renders is engine severity, which is a property of the rule, not of this site.
- **No resource fetching beyond images, CSS and JS.** Those three are fetched
  since Phase 11 — HEAD first, metadata only, under the page crawl's own
  politeness. Fonts, media, favicons and anything a stylesheet's own `@import`
  or `url()` names are NOT, and neither is anything JavaScript injects at
  runtime: only the SERVED HTML's references are seen at all. **No bodies are
  stored and no image is decoded**, so nothing here says whether an image is
  over-compressed or larger than the box it is displayed in.
- **No resource fetching at all when the operator says so.** `fetchResources:
  false` at `crawl_start` means the pass never runs; the references are still
  recorded, every one of them stays unasked, and `crawl_status` says which
  (§4.2, §5.3). An absent resource finding on such a crawl means *not measured*.
- **No model names, no narrative, no recommendations beyond the rule's own
  `howToFix` copy.**
- **No webhooks, no scheduling, no cron.** `crawl_status` polling is the
  contract.
- **No tenancy isolation on listing** (§9.3) and no per-tenant credentials: one
  bearer token per server.
- **No writes from a read surface.** Every query path runs read-only; the four
  command tools are the only things that change anything.

---

## 11. Versioning, and what a ruleset change does to a served crawl

`RULESET_VERSION` (**0.12.0** as of Phase 16) stamps **judgement**: bump it when
a rule's verdict or copy changes. Adding a rule or a metric family adds rows
without changing a verdict — `metrics` rows carry no version column at all —
which is the argument Phase 10 held 0.7.0 on.

**Phase 11 bumped to 0.8.0, once.** Two things in the phase each require it on
the rule's own terms: six rules writing verdicts a page or a site could not
receive before, and `site.health`'s re-filing with the copy change that came
with it (§6) — copy is what the rule names beside verdicts, so that change
would have earned the bump on its own. One number rather than two, because the
phase ships as one change and the version is what a consumer compares crawls by
(§7.2): two stamps inside it would make `crawl_compare` raise
`ruleset-mismatch` between crawls that differ by nothing a consumer cares
about.

**Phase 12 bumped to 0.9.0, once, on three grounds.** First, a FINDING a crawl
could not receive before: `resources.not-fetched`, the sibling marker of §5.3.
That is not the Phase 10 case above — a metric adds rows to a table with no
version column at all, while a finding rule stamps this constant onto every row
it writes, and a crawl re-judged at 0.9.0 carries a marker it did not carry at
0.8.0. It is ADDITIVE all the same, which is the distinction the Phase 11 gate
drew (§10.3): a new id firing where nothing fired, never a widened condition on a
rule already stamped into stored findings. Second, the `resources.broken` and
`resources.uncached` explanations, which now name the `robots_unreachable` class
— copy is served from the catalogue stamped with this constant, so that ground
would have earned the bump on its own, exactly as `site.health`'s did in
Phase 11. Third, `render.coverage` gained a column (`renderPassEvidence`, §4.5)
and the explanation served with it gained the sentence that reads it: the same
copy ground as the second, on the metric an auditor reads before quoting any
JavaScript finding. One number covers all three — the phase ships as one change,
and two stamps inside it would make `crawl_compare` raise `ruleset-mismatch`
between crawls that differ by nothing a consumer cares about.

**Phase 13 bumped to 0.10.0 and Phase 14 to 0.11.0, each once, each on the same
additive ground.** `resources.all-unknown` (Phase 13) and
`resources.partial-unknown` (Phase 14) are the third and fourth sibling markers
of §5.3 — new ids firing where nothing fired, never a widened condition on a
rule already stamped into stored findings, exactly the distinction Phase 12
drew. Together they complete the marker family's partition of the silent space
(a crawl whose resources yielded no judgeable answer now carries exactly one
marker naming why, whatever the mix of unasked and unknown-answer rows). No
other rule's verdict or copy moved in either phase.

**Phase 16 bumped to 0.12.0 on a different ground: severity, and only
severity.** 29 of the 95 rules changed band (23 `warning` → `critical`, 5
`info` → `warning`, `crawl.blocked` `warning` → `info` as the tenth NOT
MEASURED marker; 27 / 23 / 45 after), recalibrated against the written
rubric in `docs/superpowers/specs/2026-09-08-severity-recalibration-design.md`.
No rule was added, retired or rescoped, one copy entry (`crawl.blocked`) was
reworded to say it is a crawl outcome, and no finding's existence
or evidence changed — the same crawl re-judged at 0.12.0 yields the identical
finding set with those rows' `severity` moved. It is still a bump because
severity is judgement: crawls judged either side of it are not row-comparable
on severity, `crawl_compare` raises `ruleset-mismatch` between them as it
should, and `site.health`'s `urlsCritical` changes meaning (from "mechanically
broken" to "carrying a first-fix SEO defect"), so a health gauge drawn from it
must show the ruleset version beside the number. Stored findings keep the
severity their ruleset stamped; nothing is backfilled.

Three consequences a consumer must plan for:

1. **Retiring a rule requires re-judging every crawl you still serve.** A crawl
   holding rows for a rule id the current ruleset does not define is a **409**
   on `issues_list`, `issue_urls`, `rules_catalog`, `crawl_compare` and the CSV
   `issues` view — consistently, and loudly, because the alternative is a row
   with no copy or a silently dropped count that breaks the sum in §5.1. A
   dashboard hits `rules_catalog` on **every paint**, so the day a rule is
   retired, every un-re-judged crawl's page turns into a 409. The fix is a
   re-judge (`crawl_rules`), and the refusal says so.
2. **A malformed truncation note is a 500, not a dropped field.** If a rule
   writes a note naming neither `total` nor `atLeast`, the issues surface fails
   loudly rather than answering with a bare `count` a reader would take as the
   total (`test/api/query.test.ts:1018` "500s a truncation note it cannot read
   rather than dropping it"). Same family of decision as the 409: the
   engine refuses to answer rather than answer wrongly.
3. **Copy is always today's.** Every surface joins titles, explanations and
   `howToFix` from the current registry at read time; nothing is stored twice.
   A crawl judged under an older ruleset is *described* by today's words (§7.3).

---

## 12. CSV exports — the dashboard's download

`GET /crawls/:id/export?format=csv&view=<view>` streams `text/csv; charset=utf-8`,
chunked, with no `Content-Length` and a `Content-Disposition` filename. The MCP
tool writes the same bytes to a file under the server's export directory and
answers `{format, view, ruleId?, path, rows, bytes}`. `rows` counts **data
rows**; the header is always written and never counted.

| view | columns | one row is | measured on `crawl_02ff6f7a` |
|---|---|---|---|
| `issues` | ruleId, severity, category, checkIds, url, title, evidence | one finding | 17,659 rows / 5,315,760 B |
| `issue_urls` (needs `ruleId`) | ruleId, url, evidence | one finding of one rule | 243 rows (`links.orphan`) |
| `internal_urls` | url, status, fetchClass, indexable, clickDepth, pageType, title | one crawled page | 551 rows |
| `links_to_4xx` | source, target, status, anchorText | one internal link to a 4xx page | 99 rows |
| `anchor_texts` | source, target, text | one link, internal or external | 35,145 rows / 4,664,393 B |
| `redirects` | source, chain, target, hops | one **redirecting page** | 10 rows |
| `resources` | url, kind, fetchClass, status, bytes, bytesSource, contentType, cacheControl, fetchReason, referencingPages | one **file** the served HTML points at | 0 rows (this crawl predates the pass) |

Semantics a consumer must repeat to its own users:

- **`links_to_4xx` is INTERNAL links only.** The status comes from the target's
  own crawled row, and an external target is never fetched — so **an external
  4xx is absent from this file rather than clean**. "No broken links" is not
  what an empty file says.
- **`redirects` is one row per redirecting page, not per chain.** `a → b → c` is
  two rows and `c` appears in both; `hops` counts from the row's own source. The
  row count is how many URLs redirect, never how many chains there are.
- **`resources` is one row per FILE, off the SERVED HTML.** An image four
  hundred pages carry is one row with `referencingPages: 400`, not four hundred
  rows — the file is the unit of work, and the fix is made once. Two absences
  follow, on exactly the `links_to_4xx` pattern: a file that JAVASCRIPT injects
  at runtime was never in the served HTML and is **absent from this file rather
  than clean**, so an empty export says "the server sent no references" and never
  "this site loads no assets"; and fonts, media, favicons and anything a
  stylesheet's own `@import` names are out of scope entirely.
- **In `resources`, read `fetchClass` before `status`.** An empty `status` cell
  has five meanings and only one of them is a fault: never asked, refused by our
  own URL policy, forbidden by a robots.txt we read (`robots_denied`), blocked
  because the host's robots.txt was unreachable (`robots_unreachable` — a complete
  disallow all the same), or asked with no answer. `fetchClass` is the
  discriminator (empty = seen, not asked — §5.3) and `fetchReason` is the
  sentence. `bytesSource` rides beside `bytes` for the
  smaller version of the same point: `header` is the server's claim and `counted`
  is our measurement, and a weight built from both without saying so has two
  provenances in one number.
- **The `evidence` cell is a bounded summary, not the evidence.** It is
  flattened to `key=value; key=value` (dotted paths, sorted keys, `|` for a
  scalar list) and capped at 12 leaves / 120 chars per value / 500 chars per
  cell, with dropped leaves counted as `+N more`. The full blob is on
  `issues_list` / `issue_urls`, and the description says so.
- **`|` is the list separator everywhere** in these files (`checkIds`, redirect
  chains, scalar arrays) so a comma never makes a list unsplittable.
- **Formula injection is guarded uniformly:** a cell whose first non-whitespace
  character is `= + - @` is written with a leading apostrophe, before RFC 4180
  quoting. The trade is deliberate — a negative number would render `'-3`; no
  column in these seven views emits one. It is not a text-column guard: a
  `Cache-Control` header is the server's own string and lands in a cell exactly
  as a page title does, which is what `test/api/query.test.ts:2130` "never lets a
  crawled string become a formula" asserts.
- **No BOM**, `\r\n` line endings, RFC 4180 quoting. Excel on a non-UTF-8
  Windows locale may mangle accents on a double-click; every parser and pipeline
  reads the first header cell correctly, which is the trade that was chosen.
- **Every refusal happens before the first byte** — bad view, bad format, wrong
  vocabulary, unknown crawl, a crawl holding a retired rule id. After the header
  there is no status left to send, so a mid-stream failure **destroys the
  connection** and logs under a correlation id: a short CSV that looks complete
  is the silent failure hard rule 7 forbids.
- **Memory is O(batch), not O(rows):** keyset cursors, 500 rows a read. The
  35,145-row anchor export grew RSS by 0.1 MB while producing 4.7 MB of file
  (measured 2026-09-01; the first view measured in a process absorbs its
  first-touch allocation, which is why `issues` shows ~2–7 MB depending on
  ordering).

Pinned: `test/api/csv.test.ts` (25 unit tests: the writer, the guard, the
flattening, the SQL keyset pins, and the seven-view vocabulary);
`test/api/query.test.ts:1999` "writes each view's header, always, and the row a
caller came for", `test/api/query.test.ts:2089` "writes one row per referenced
file, with the class that makes an empty status readable" (the four unfetched
spellings), `test/api/query.test.ts:2130` "never lets a crawled string become a
formula" (including a hostile `Cache-Control`), `test/api/query.test.ts:2151`
"quotes a cell holding a comma, a quote or a newline",
`test/api/query.test.ts:2164` "exports exactly as many rows as the source holds"
(for `resources`, against BOTH of its tables: one row per file, and the
referencing counts summing to the edge table), `test/api/query.test.ts:2213`
"reads every view through a cursor that can be walked one row at a time",
`test/api/query.test.ts:2248` "refuses a view, a format or a rule it cannot
answer", `test/api/query.test.ts:2318` "refuses a crawl holding a retired rule's
findings BEFORE the header", `test/api/http.test.ts:1931` "tears the response
when a CSV export fails mid-stream, rather than truncating the file";
`test/api/mcp.test.ts:760` "describes the shape of the CSV it writes, not just
that it writes one" and `test/api/mcp.test.ts:2555` "streams the resources view
byte for byte, as it writes it".

---

## 13. Known limits

- Resource fetching covers images, CSS and JS only, from the SERVED HTML, and
  stores metadata rather than bodies (§10). Nothing decodes an image, so no
  surface says whether one is over-compressed or oversized for its box.
- **The per-page reference cap is counted, but WHICH pages is not — and neither
  is whether any file was actually lost.** The analyzer records at most 2,000
  resource references per page and turns the rest away.
  `crawl_status.resourceRefsCappedPages` is how many pages that happened to
  (§5.4), so `resources.seen` MAY BE a floor on that many pages. Two things no
  surface answers: which pages they were, and whether a turned-away reference was
  a file this crawl never recorded or a repeat of one it already had — past the
  cap the analyzer stops resolving, so the signal is honestly "a reference was
  dropped unexamined" and nothing stronger. The reason for both silences is the
  measurement that shaped the whole design: deriving anything per page from the
  edge table costs a scan of every reference the crawl holds — 73 ms over a
  500,000-edge crawl, against a polling endpoint whose other reads are ≤ 3 ms
  (measured 2026-09-02 on a synthetic crawl, since deleted). The COUNT is
  affordable because nothing derives it: the analyzer flags the page, the writer
  counts, the crawl loop stamps a column at close.

  **The cheap indicator was considered and rejected as unsound**, for the record,
  since it looks obvious: comparing `pages.images_total` against a page's counted
  image edges needs no scan of the edge table at all. It does not work, and not
  marginally — `images_total` counts every `<img>` ELEMENT while the extraction
  emits a DISTINCT-URL set, so any page that reuses one image (a logo in a grid,
  a placeholder, a repeated icon) has more elements than edges with nothing
  truncated. The comparison would fire on ordinary pages and stay silent on a
  truncated page whose references happen to be distinct. That is why the signal is
  the analyzer's own, taken where the cap is enforced, and not an inference drawn
  from stored rows afterwards.
- **`resources.uncached` reads two headers only** — `Cache-Control` and
  `Expires`. No ETag, no `Age`, no `Last-Modified`, and no CDN edge policy. And
  the HTML documents' OWN cache headers are not stored at all: `resources` covers
  assets, `pages` has no such column.
- `page.weight` is a range rather than a number, and both bounds are stated in
  its copy: a CEILING (an `<img>` offering both `src` and `srcset` contributes
  both files while a browser downloads one) and a FLOOR (any referenced file that
  went unweighed adds nothing to the sum).
- **`renderPassEvidence: "none"` is a claim about our records, not about
  history** (§4.5). Every value of `"ran"` is something a pass WROTE, so `"none"`
  gets exactly one shape wrong: an automatic pass that selected ZERO pages
  promotes no frontier row, renders nothing, fails nothing and stamps 0 — it
  leaves no trace to find. On such a crawl the numbers beside `"none"` are the
  same zeroes the pass itself would have reported, so nothing a reader takes from
  the row is false; the field is named for the evidence rather than for the past
  because that is the claim it can support.
- `urlsWithCritical` stays near-empty until a crawl renders a large share of its
  pages: two of the three `critical` rules judge only rendered pages, and the
  third fires outside the census (§6).
- No index on `crawls.site_url`: the site filter is a sequential scan — 1.1 ms
  over the 153 rows the dev table held when it was measured. **Do not read the
  dev table's row count as an operator's number**: it grew from 139 to 1,585
  across Phase 11 alone, and the growth was the SUITE, not a user — every full
  run left its fixture crawls behind (`127.0.0.1:<port>`, `runner.example`).
  **31 rows a run at Phase 11, 33 at Phase 12, ZERO now** (P13-T1, measured
  across two consecutive full runs). All 33 were ONE file —
  `test/crawl/fetch-resources.test.ts`, the only crawl-creating file in the
  suite that never deleted what it made: 28 rows it seeded and 5 the crawl loop
  created for it. It now tracks and deletes them the way every other
  crawl-creating file in the suite already did, and the historical residue was
  swept once with a record: **3,110 crawl rows → 28 → 4** (the byte figures are
  VACUUM-dependent and point-in-time, ~1,060 MB → ~1,050 MB; the row counts are
  the record),
  the four real `lavishalice.com` crawls verified byte-identical throughout. The
  first sweep took the two leaking host families (`127.0.0.1:<port>`,
  `runner.example`) to 28; a second, on the owner's word at T1 review, took the
  24 older `*.example` / `localhost` fixture rows from tests that had already
  stopped leaking — leaving exactly the four kept crawls.
  At a hundred thousand crawls the filter wants an expression index on the
  hostname; at this size it is still a scan of a small table.
- The comparison's identity collapses multi-finding rules to per-URL presence
  (§7.1). Nothing on the surface can un-collapse it; `issues_list` counts are
  the row-level truth.
- No tenancy isolation on listing (§9.3).

## Cross-references

- `docs/talos-integration.md` — why the seam exists, the six obligations, and
  what Talos must eventually do.
- `docs/gates/phase-10.md` and `docs/gates/phase-11.md` — the measurements
  behind this file's Phase 10 and Phase 11 numbers; each number here also names
  the test or the measurement it came from directly.
- `skills/ariadne-audit/checklist.md` — the checks the rules trace to.

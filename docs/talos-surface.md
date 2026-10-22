# The Ariadne surface Talos codes against

**Status:** the contract as of Phase 23 (ruleset 0.18.0, migrations 0000–0023,
18 MCP tools / 18 HTTP routes; every column label in this document is served
under the ruleset version the engine reports — `rules_catalog`'s
`rulesetVersion`, which the metric-table pass moves).
`docs/talos-integration.md` says *why* the seam exists and what obligations bind
it; this document says *what the seam is*.

**What Phase 23 changed here: proven behaviour.** Ruleset 0.18.0, migrations
0020–0022, and no tool or route added: 14 rules joined (114 rows in
`rules_catalog`, 13 of them markers), and the changes to what a served crawl
carries are ADDITIVE except where a verdict moved (§11).
- **New rules.** `http.no-response`, `http.no-response-transient` and
  `page.html-too-large` (CHECK-12); `crawl.unreadable-encoding` (CHECK-05, a
  marker); `robots.blocks-internal-urls` (CHECK-03); `headings.h1-too-long`
  (CHECK-37) and `url.too-long` (CHECK-28); `head.directives-outside-head`
  (CHECK-18/04/24) and `head.tags-outside-head` (CHECK-35/36); and the five
  `render.*-changed` rules, raw versus rendered noindex, canonical, title,
  meta description and H1 (CHECK-01 plus the element's own). Thresholds moved
  with them: titles under 30 characters are `title.too-short` and meta
  descriptions over 155 characters are `meta-description.too-long`.
- **The recheck pass widened.** It re-asks `timeout` and `network_error` pages
  too, walked after every 5xx under its own cap of 100 rows and a per-host
  breaker (3 consecutive no-response rechecks on a host, the rest of its rows
  are not asked). `crawl_status.recheck.noResponse` is the new block
  `{pages, confirmed, answered, inconclusive, pending}` (§4.2).
- **The body cap is 2 MiB.** A 2xx HTML page over it is classed `too_large`,
  not analysed, and reported by `page.html-too-large`.
- **Robots-disallowed internal URLs are recorded, not dropped.** They are
  written as `disallowed` rows against their own budget, the crawl config's
  `maxBlockedUrls` (default `maxPages`) — **an engine field, not an input
  `crawl_start` accepts**, so every API crawl takes the default.
  `crawl_status.robotsBlocked` is `{recorded, dropped}` (`dropped` null on a
  crawl from before migration 0020), and `issue_inlinks` now answers for
  `robots.blocks-internal-urls` as well (§4.4a).
- **Pagination.** `title.duplicate`, `meta-description.duplicate` and
  `h1.duplicate-text` leave out pages 2+ of a series (judged pages with
  `rel=prev`); each group carries `paginationExcluded` and `site.health` gains
  `urlsPaginated`, which is not a partition member.
- **Migrations.** 0020 `crawls.robots_blocked_dropped`; 0021 the head-position
  columns on `pages` (`head_closed_by`, the outside-head flags); 0022 the
  rendered robots, description, H1 and `rendered_tags_read` columns. A crawl
  rendered before 0.18.0 has no rendered values for those three, so the
  `render.*-changed` rules for them are not measured on it rather than clean.

**What Phase 20 changed here: a finding is a TABLE, not a URL beside a blob.**
Every change is ADDITIVE on the JSON surfaces and no field changed type.
`issue_urls` rows gain `address` (the same string as `url`, which stays for one
release), `statusCode`, `indexability` and `indexabilityStatus` — the four
standard columns Screaming Frog's per-issue exports lead with — and the response
gains `columns`, the header its rows are printed under (§4.4). Every rule that
FINDS declares its own columns after those four, and `rules_catalog` serves them
(§5.1). **`issue_inlinks` is new** — the seventeenth tool and route, the links
that point at what the two link rules found, for the reason those rules report
the target and the fix is made in the source (§4.4a). The CSV half moves with
them: `issue_urls` is now the rule's own table with its labels as the header and
a trailing `Truncated` column, named `crawl_<uuid>-<ruleId>.csv`; `links_to_4xx`'s
columns are re-headed to the inlinks vocabulary and `links_to_5xx` joins it
(§12). **The one breaking change is in the CSV, not the JSON**: a consumer
parsing `issue_urls` or `links_to_4xx` by column POSITION or by lower-case
header name has to be updated.

**What Phase 21 changed here: a metric is a TABLE, not a jsonb blob.** Purely
ADDITIVE: no served field changed type and `metrics_get` is untouched. A new
tool and route, `metric_table` (§4.4b), serve one metric's rows shaped by the
metric's own declaration — a header of labelled columns, one row per template,
per measure, per list element or per map entry, with the site-level scalars as a
`summary` above them. `rules_catalog` gains `table` on metric rules, the mirror
of the `columns` it already serves on rules that find (§5.1), and the CSV gains
a ninth view, `metric_table`, named `crawl_<uuid>-<metricId>.csv` (§12). The
labels are client-facing copy, which is what moves the ruleset version.

**What Phase 19 changed here: the ruleset is 0.14.0 and the words are for
clients.** No served field or shape changed. Four rules joined (100 rows in
`rules_catalog`, two of them markers, so `marker` now appears on twelve rows),
two verdicts moved (duplicates and hreflang respect the canonical), one
measurement changed (near-duplicate on the main-content fingerprint, migration
0018, with 0019's band indexes behind it), and every `title` / `explanation` /
`howToFix` / `marker` string passed a rubric that bans engine vocabulary — an
agent pasting catalog copy into a tenant-facing report no longer has to
translate it. §11 has the account.

**What Phase 18 changed here: `crawl_status` says why a failed crawl failed.**
One field was ADDED to the crawl detail and nothing changed type.
`failureReason` is one sentence on a `failed` crawl and `null` on every other
one (migration 0017, §4.2), and it exists because `status: "failed"` on its own
was a dead end: the Phase 17 gate pointed a crawl at a host whose robots.txt
answered 502, watched it close in fourteen seconds, and found the explanation
only in the engine's own process log — the one place a consumer driving this
engine over a network cannot read. Its null joins the doctrine as a case with a
history rather than a state (§5.6), and it is a diagnostic string rather than
client copy (§9). It is **not** on `CrawlListItem`: a listing row says a crawl
failed, and the crawl is where the reason lives.

**What Phase 17 changed here**, so a reader of the Phase 16 version knows where
to look: **one field was ADDED to the rules catalog and nothing changed type.**
Every `rules_catalog` / `GET /rules` row for a NOT MEASURED marker now carries
`marker`, the registry's own reason string for that marker; every other row
carries no `marker` key at all (never `null`, never `""`). Ten of the 45 `info`
rules are markers, and until now the wire said nothing about which — a consumer
banding by severity filed "this check could not be answered" beside "this check
found something small", and the only way to tell them apart was a hard-coded
list that goes stale the next time a marker is added (§5.1).

**And then Phase 17 added the 5xx RE-VERIFICATION pass, which is additive on the
wire and moves one verdict.** Every page whose first fetch ended `server_error`
is now asked exactly once more at the end of the crawl — same gate, same user
agent, same URL policy, at least 60 seconds after the first look — because a 5xx
seen once may be a blip rather than a broken page, and only a second observation
can say which. Nothing about the first observation is rewritten: `fetchClass`,
`statusCode` and every analysis column stay as first observed, and the second
lands in five new `pages` columns (migration 0016). What a consumer gains:
`crawl_status` gains a `recheck` block whose four counts partition the crawl's
5xx pages (§4.2); `pages_query` gains `fetchedAt`, `recheckFetchClass`,
`recheckStatusCode`, `recheckReason` and `recheckAt` (§4.6); the `internal_urls`
CSV gains three columns (§12); and the doctrine gains a null whose zero is a
measurement (§5.5). What MOVES: `http.server-error-transient` is a new
`warning` rule, and `http.server-error` (`critical`) no longer fires on a 5xx
whose recheck got a non-5xx answer from the site — the two are mutually
exclusive and jointly exhaustive over `fetch_class = 'server_error'`, so no page
gains or loses a finding, one class of page changes which finding it carries.
The ruleset moved to **0.13.0** for it (§11), and **nothing is backfilled**: an
older crawl re-judged at 0.13.0 reports exactly what it reported at 0.12.0, with
`recheck: "not run"` added to the evidence.

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
- **The equality is tested, not argued.** `test/api/mcp.test.ts:2678`
  ("answers the same JSON for the same question, route by tool") calls thirteen
  (tool, route) pairs over the wire against one database and asserts the two
  answers are `toEqual`. `test/api/mcp.test.ts:2699` ("refuses in the same
  words, whichever transport asked") does the same for five refusals — the same
  sentence and the mapped status. `test/api/mcp.test.ts:2756` ("streams the
  bytes the other transport writes to a file") and `test/api/mcp.test.ts:2778`
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
  without one (`test/api/http.test.ts:2120` "refuses to produce a config without
  a token").
- **The token is checked before routing**, so an unauthenticated caller cannot
  map the surface: an unknown path answers 401, not 404
  (`test/api/http.test.ts:449` "checks the token before routing"). Every refusal
  names *which* thing was wrong — missing header, wrong scheme, wrong token.
- **MCP asks for no credential** and that is a posture, not an omission: an
  stdio client either started this process or was handed its pipes
  (`test/api/mcp.test.ts:2882` "asks for no bearer token: an stdio client is the
  process that started this one"). If Ariadne's MCP server is ever mounted on a
  network transport, that argument dies with the change and a credential has to
  arrive with it.
- **The domain allowlist binds both transports** (`ARIADNE_ALLOWED_DOMAINS`,
  exact host or `*.example.com`). An empty allowlist refuses every crawl
  trigger and still answers every query — the read-only posture a Talos
  deployment can run for reporting-only tenants
  (`test/api/mcp.test.ts:956` "refuses every crawl when the allowlist is empty",
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
nowhere else (`test/api/mcp.test.ts:2805` "turns an unexpected throw into a tool
error with a correlation id", `test/api/http.test.ts:2063` "turns an unexpected
throw into a 500 with a correlation id").

---

## 2. Conventions

**Pagination.** Every listing answers `{items, nextCursor}`. Pass `nextCursor`
back as `cursor` **with the same filters**; `nextCursor: null` means the listing
ended. The two REPORT listings — `issue_urls` and `issue_inlinks` — carry one
field more, `columns`, the header their rows are printed under (§4.4). It is
served with every page rather than only the first, so a paging client keeps no
state. `limit` defaults to 50 and is capped at 200 — a limit outside the
contract is refused, never clamped (`PAGE_SIZE_DEFAULT` / `PAGE_SIZE_MAX`,
`test/api/mcp.test.ts:1226` "refuses a limit outside the contract rather than
clamping it").

**Closed vocabularies.** Every query parameter, body field and tool argument is
on a closed list. `?serverity=critical` is a 400 naming both the typo and the
accepted set, never an unfiltered listing with a 200 on it
(`test/api/query.test.ts:3993` "refuses a typo'd filter instead of answering the
question nobody asked"). MCP argument typos are refused by the SDK's schema
validator before the handler runs (`test/api/mcp.test.ts:805` "refuses an
argument nobody allowed, naming it").

**Not paginated, on purpose:** `rules_catalog` and `crawl_compare`. Both are
bounded by the **ruleset** (114 rows at 0.18.0) rather than by the crawl. The
catalog is ~113 KB (**115,443 bytes**, re-measured 2026-10-22 at the end of
Phase 23 over all 114 rows of ruleset 0.18.0 — 13 markers at 2,020 bytes
JSON-serialised and the fourteen tables at 5,166, measured one way for this
figure and so not subtractable from the series below; the 101,010 before it was
measured 2026-09-23 at the end of Phase 22 over all 100 rows of ruleset 0.17.0 — by serialising what
`rulesCatalog` answers with no crawl id — of which **1,813 bytes** are the
`marker` strings on the twelve markers and **5,098 bytes** are the `table`
declarations on the fourteen metric rules. Phase 22 added 2,013 bytes and no
rows: the judged cohort's sentence in the moved rules' copy, and the 116 bytes
`site.health`'s two new columns add to its `table` declaration. The 98,997
before it was measured 2026-09-11 at the end of Phase 21 over 100 rows of
0.16.0 — 1,813 bytes of markers and 4,982 of tables, the whole of what that
phase added, since no copy moved. The 93,778 before it was measured 2026-09-10
at the end of Phase 20 over 100 rows of 0.15.0 (a figure that does not reproduce to the
byte under this measurement, by about a hundred bytes, so treat the series as
sizes rather than as a subtractable ledger), and **it had SHRUNK by 31,241
bytes** across that phase even though
every rule that finds gained a `columns` array: the copy rewrite traded long
explanatory prose for the SEO-tool register, and the register is shorter than
the essay it replaced. The 125,019 before that was
measured 2026-09-09 at the end of Phase 19, over 100 rows of 0.14.0 whose copy
pass had lengthened many entries; 111,419 bytes at 96 rows of 0.13.0; the
109,949 before that was measured earlier in the same phase,
at 95 rows of 0.12.0 and before `http.server-error` was split in two; the
103,679 before that at 93 rows of ruleset 0.9.0, and the 100,645 before it at 92
rows, before `resources.not-fetched` had copy of its own) because it carries
every rule's full copy — the tool description says so, and points an agent that
only wants what fired at `issues_list` instead.

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
| `issue_inlinks` | `GET /crawls/:id/issues/:ruleId/inlinks` | `ruleId` (required — **only** `links.broken-internal`, `links.to-server-error` or `robots.blocks-internal-urls`), `limit`, `cursor` |
| `metrics_get` | `GET /crawls/:id/metrics` | `metricId`, `scope`, `scopeValue`, `limit`, `cursor` |
| `metric_table` | `GET /crawls/:id/metrics/:metricId` | `metricId` (required) |
| `pages_query` | `GET /crawls/:id/pages` | `pageType`, `statusCode`, `indexable`, `rendered`, `fetchClass`, `discoveredVia`, `limit`, `cursor` |
| `rules_catalog` | `GET /rules` | `crawlId` (**optional** — the only tool where it is) |
| `crawl_compare` | `GET /compare` | `baseCrawlId`, `headCrawlId` (both required) |
| `compare_urls` | `GET /compare/urls` | `baseCrawlId`, `headCrawlId`, `ruleId`, `set` (all required), `limit`, `cursor` |
| `export_crawl` | `GET /crawls/:id/export` | `format` (`jsonl.gz` \| `csv`), `dataset` (jsonl.gz only), `view` + `ruleId` \| `metricId` (csv only) |

Pinned: the tool list and every schema — `test/api/mcp.test.ts:634`
("advertises exactly the eighteen tools of the agent surface"),
`test/api/mcp.test.ts:661` ("closes every input schema and describes every
field"), `test/api/mcp.test.ts:693` ("names every member of the closed
vocabulary each field enumerates"), `test/api/mcp.test.ts:722` ("advertises
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
(`test/crawl/loop.test.ts:1557` "resumes at the spacing the crawl earned, not the
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
finishes (`test/api/http.test.ts:1296` "unjudges a crawl it queues, so no
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
(`test/api/http.test.ts:1406` "names render_pending rows as the render pass's
work, not a resume's"). Neither are the null `fetch_class` rows of a crawl
configured with `fetchResources: false` — those carry the operator's decision,
and a resume would not ask about them
(`test/api/http.test.ts:1383` "does not read an off switch as resumable work").

**The honest race.** The two liveness checks are a snapshot: a lease can expire
between the count and the enqueue, and a worker this server cannot see can take a
fresh one just after. The claim itself is a **compare-and-swap** on the status
the call read, and its row count is *read*: zero rows means something else moved
the crawl in between, and the answer is a 409 rather than a queued crawl whose
row says something else — the silent no-op hard rule 7 forbids. That narrows the
double-accept race as far as it goes without a lock (of two callers past the
guards, only the one whose UPDATE lands first is accepted), and it cannot close
the window against a process that never touches the status
(`test/api/http.test.ts:1325` "409s when the crawl's state changes under the
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
(`test/api/http.test.ts:1221` "a killed crawl resumed over the wire reaches the
totals of a control that was never killed"; the MCP half is
`test/api/mcp.test.ts:1538` "finishes a crawl a server was killed in the middle
of, and keeps its earned spacing").

### 4.2 `crawl_status` → the crawl in full

The live answer for `crawl_02ff6f7a`, pasted as it came back (2026-09-02) —
nothing here is elided or tidied:

```json
{"crawlId":"crawl_02ff6f7a-203c-4771-805c-feede04aed11",
 "siteUrl":"https://lavishalice.com/","status":"finished",
 "startedAt":"2026-08-29T15:21:44.994Z","finishedAt":"2026-08-29T15:40:16.915Z",
 "pagesCrawled":551,"pagesTotal":null,"renderPassCount":14,
 "rulesetVersion":"0.6.0","failureReason":null,
 "frontier":{"pending":0,"leased":0,"done":551,"failed":0,"renderPending":0},
 "queuePosition":null,"liveLeases":0,"blockedPages":0,"hostSpacingMs":2000,
 "robotsBlocked":{"recorded":0,"dropped":null},
 "legacyHosts":[],"sitemapUrls":["https://lavishalice.com/sitemap.xml"],
 "findingCap":null,"rulesRunAt":"2026-09-01T08:51:55.386Z",
 "findingsCount":17659,"pagesScanned":551,"fetchResources":true,
 "resourceRefsCappedPages":null,
 "resources":{"seen":0,"fetched":0,"failed":0,"skipped":0,
              "robotsDenied":0,"robotsUnreachable":0,"capped":false},
 "recheck":{"serverErrors":0,"confirmed":0,"cleared":0,"inconclusive":0,
            "pending":0,
            "noResponse":{"pages":0,"confirmed":0,"answered":0,
                          "inconclusive":0,"pending":0},
            "capped":false,"passAt":null}}
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

**`failureReason` — why a `failed` crawl failed.** One sentence, and `null` on
every crawl that is not `failed` (as here). It is the field that turns `status:
"failed"` from a dead end into something a caller can act on, and the three
writers produce three recognisable shapes:

- **the crawl was REFUSED before it began** — the loop's own classified
  sentence, `robots.txt unreachable after 3 attempts (HTTP 502): complete
  disallow`. RFC 9309 §2.3.1.4 makes an unreadable robots.txt a complete
  disallow, so this is not a crawl to retry harder against: nothing changes
  until that host serves its rules;
- **something threw inside the run** — the FIRST LINE of what threw, and only
  the first line;
- **an operator retired an orphan** with `crawl_mark_failed` — `marked failed by
  an operator: no worker held it`, a fixed sentence, because nothing threw.

**`null` on a `failed` crawl is not "it failed for no reason"** — it is a row
this engine closed before migration 0017 existed. §5.6 is that reading in full.
Do not render it as client copy: it is a diagnostic string, on the `renderError`
precedent (§9).

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

**The `recheck` block, and the second trap this paste demonstrates.** Every page
whose FIRST fetch ended `server_error` is asked exactly once more at the end of
the crawl — same politeness gate, same user agent, `url-policy` re-applied, at
least 60 seconds after the first look — because a 5xx seen once may be a blip
rather than a broken page. This crawl ran before the pass existed, so its seven
values are the "nobody looked" shape, and the two zeroes at the top say
different things: `serverErrors: 0` here is a real count of this crawl's 5xx
pages, while `passAt: null` says no complete pass is on record. Read them
together.

- `serverErrors` — pages whose first fetch was 5xx: **the denominator**, and the
  only number here that is about the crawl rather than about the pass.
- `confirmed` — asked again, 5xx again. Still broken.
- `cleared` — asked again, and the site answered something that is **not** a 5xx.
  The transient case, and the only mechanism on this surface that moves a page
  from a `critical` finding to a `warning` one: these pages carry
  `http.server-error-transient` instead of `http.server-error`.
- `inconclusive` — asked again, and no answer ABOUT THE PAGE came back: a
  timeout, a network error, a block (which is an answer about our crawler, not
  about the page), or a URL our own policy or the site's robots.txt refused on
  the second look. A decided outcome rather than an absence, and the finding
  stays `critical`.
- `pending` — **not asked at all.** A crawl older than the pass, a crawl that
  failed or was cancelled before it reached the row, a pass still running, or a
  row the budget stopped short of.
- `noResponse` — since ruleset 0.18.0 (Phase 23), the same pass over the pages
  whose first fetch got **no HTTP response at all** (`timeout`,
  `network_error`), in its own block because its partition differs: `pages` is
  its denominator, `confirmed` is still no response, `answered` is ANY HTTP
  answer on the second look — a 5xx or a block included, because the URL
  responded — and moves the page from `http.no-response` (critical) to
  `http.no-response-transient` (warning), `inconclusive` is a second look our
  policy or robots.txt refused, and `pending` is not asked.
  `confirmed + answered + inconclusive + pending == pages`. These rows are in
  none of the five 5xx numbers.
- `capped` — one of the pass's two budgets stopped it short of at least one row:
  500 rows for the 5xx (walked first, exactly as before Phase 23) or 100 for the
  no-response rows (walked after every 5xx). More than 500 server errors is a
  site-wide outage, not a set of broken pages. Those rows are counted in the
  `pending` of their block, because nothing about them was decided. The
  no-response walk also has a per-host breaker: after 3 consecutive rechecks on
  one host that still get no response, that host's remaining no-response rows
  are stamped `host-unresponsive` and not requested — they are counted in
  `noResponse.pending`, do not set `capped`, and their findings read
  `recheck: "capped"` — which bounds the walk to about 100 × (20 s timeout + up
  to 30 s spacing) in the worst case.
- `passAt` — when a COMPLETE pass finished over this crawl (`crawls.recheck_pass_at`).
  Null means none is on record: never run, running now, or aborted part-way. An
  aborted pass keeps the rows it settled and stamps no time.

`confirmed + cleared + inconclusive + pending == serverErrors`, on every crawl,
and the four are read in ONE statement so that stays true while the pass settles
rows underneath a poller — which is what lets a progress panel watch `pending`
fall. `capped` is a flag over the same rows, not a term in the sum.

**A `pending` row does not make CHECK-12 unanswered.** The site returned a
server error and that is an answer; what is unknown is whether it persists. The
page keeps its `critical` finding, and its evidence carries
`recheck: "not run"` so a report writer can say which it is (§5.5).

Pinned: `test/api/query.test.ts:2032` "the fields an audit checks itself against"
(15 tests over the whole block — the marker, the live findings count,
`pagesScanned`, the one-statement read, the four the recheck block added, and
the no-response partition Phase 23 added),
`test/api/query.test.ts:2145` "counts
the resource census off the database, partitioned exactly",
`test/api/query.test.ts:2187` "answers the block on a crawl that holds no
resource rows at all", `test/api/query.test.ts:2379` "reports the cap-exceeded
page count a crawl stamped, and null when none did",
`test/api/query.test.ts:2406` "echoes whether the crawl
asked about its files", `test/api/query.test.ts:2424` "409s a stored
fetchResources that is not a boolean"; over the agent transport,
`test/api/mcp.test.ts:1039` "answers the resource census and whether the crawl
asked for it" and `test/api/mcp.test.ts:1128` "tells an agent what the resource
numbers mean, and what they do not". The recheck block:
`test/api/query.test.ts:2198` "partitions the crawl's server errors by what the
second look found" (the arithmetic, over a fixture holding one row of every
outcome), `test/api/query.test.ts:2243` "counts as cleared exactly the classes
http.server-error-transient fires on" (the surface and the rule read ONE set,
imported, never two lists), `test/api/query.test.ts:2323` "tells a crawl with no
server errors apart from a crawl nobody rechecked",
`test/api/query.test.ts:2359` "keeps the recheck block off the crawl listing";
over the agent transport, `test/api/mcp.test.ts:1069` "answers the recheck
coverage, and keeps its two zeroes apart" (which also reads the block off a
crawl the suite really ran). The robots split itself is
`test/crawl/fetch-resources.test.ts:861` "classes an unreachable third-party
robots.txt apart from a forbidding one" and
`test/crawl/fetch-resources.test.ts:879` "keeps `robots_denied` for a file the
robots file actually forbade". Shape regenerated live from `crawl_02ff6f7a`
(2026-09-08, after migration 0016 — the `recheck` block above is that crawl's
own answer, not an invented example).

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

Pinned: `test/api/query.test.ts:1051` "groups by rule, orders by severity then
rule id", `test/api/query.test.ts:1194` "says so when a rule's listing was capped"
(the capped shape); `test/api/mcp.test.ts:1687` "groups findings by rule, orders
them by severity" and `test/api/mcp.test.ts:1701` "carries a capped rule's real
magnitude".

### 4.4 `issue_urls` → `{columns, items, nextCursor}` — one rule as a table

Every finding row is a REPORT ROW, not a URL beside a blob (Phase 20). The
response carries the header and the rows:

```json
{"columns":[{"key":"address","label":"Address"},
            {"key":"statusCode","label":"Status Code"},
            {"key":"indexability","label":"Indexability"},
            {"key":"indexabilityStatus","label":"Indexability Status"},
            {"key":"discoveredVia","label":"Discovered Via"},
            {"key":"inSitemap","label":"In Sitemap"},
            {"key":"caveat","label":"Caveat","optional":true}],
 "items":[{"url":"https://site/x","address":"https://site/x","statusCode":200,
           "indexability":"Indexable","indexabilityStatus":"",
           "evidence":{"pageUrl":"https://site/x","discoveredVia":"sitemap",
                       "inSitemap":true}}],
 "nextCursor":null}
```

**How to render it.** `columns` is the header, in order. A column whose `key` is
one of the four standard ones is read off the ITEM; every other column's `key`
is read off `item.evidence`. `optional: true` marks a key the rule writes only
sometimes, so that cell is blank by design. Array values are printed
comma-joined. The same list is on `rules_catalog` (§5.1), so a table can be laid
out before its rows are asked for, and it is repeated on every page of the
cursor so a paging client keeps no state.

**The four standard columns**, derived from the `pages` row the finding names —
never from the evidence, and computed by one helper (`indexabilityOf`,
`src/rules/helpers.ts`) that the JSON listing, the CSV export and the demo all
read:

| `fetch_class` (and status) | `indexability` | `indexabilityStatus` |
|---|---|---|
| `redirect` | Non-Indexable | `Redirected` |
| `client_error` | Non-Indexable | `Client Error` |
| `server_error` | Non-Indexable | `Server Error` |
| `blocked` (any status, or none) | Non-Indexable | `Blocked by bot protection` |
| `disallowed` | Non-Indexable | `Blocked by robots.txt` |
| `timeout`, `network_error` | Non-Indexable | `No Response` |
| `non_html`, `too_large`, `unsupported_encoding` | Non-Indexable | `Not HTML` |
| `ok`, status ≠ 200 | Non-Indexable | `Not HTML` |
| `ok` 200 + noindex on either robots channel | Non-Indexable | `Noindex` |
| `ok` 200 + a canonical naming another URL | Non-Indexable | `Canonicalised` |
| `ok` 200, otherwise | Indexable | `""` |

The order is the order in the table, most decisive first: a redirect is never
indexed whatever its HTML says, and a 200's own directives only matter once
there is a 200. Three groupings are decisions rather than readings and are
stated so a consumer does not re-derive them differently: **a `blocked` page
carries its own status whatever the wire said** (the site refused *this client* —
never `No Response`, because there was an answer, and never `Blocked by
robots.txt`, because robots.txt said nothing; and not the status code's word
either, because a challenge is routinely served with a 200 and `Status Code: 200
| Indexability Status: Client Error` contradicts itself — the status code is its
own column and `crawl.blocked`'s `fetchReason` names the mechanism); **`too_large` and
`unsupported_encoding` join
`non_html`** (the response arrived and produced no HTML this engine could read,
so there is nothing to judge from — `fetchClass` on `pages_query` is where a
reader finds out which of the three it was); and an **indexable row's status is
the empty string**, not a word.

**`statusCode`, `indexability` and `indexabilityStatus` are all `null` when the
crawl has no `pages` row for the URL.** That is two situations: a site-wide
finding, which names no URL at all (`address` is null beside them); and a
finding that names a URL the crawl never made a page row for — a probed host
variant (`host.http-serves-200`), a sitemap URL the frontier never reached
(`sitemap.uncrawled`), a URL robots.txt kept out (`robots.blocks-sitemap-urls`).
**Null there means nobody fetched it, never that it was fine** (§5).

**`url` is `address` under its old name.** Byte for byte the same string, kept
for one release so no client reading this listing today breaks. It goes away at
the next surface-breaking change; code against `address`.

**`evidence` is still the rule's stored `details_jsonb` verbatim**, including
its own `pageUrl` key. It is deliberately NOT flattened into the row: nine
rules record a `statusCode` of their own, and flattening would let one of them
replace a column derived from the page row.

Pinned: `test/api/query.test.ts:1256` "returns the URL slice with the evidence as
stored", `test/api/query.test.ts:1437` "never leaks a column the projection did
not name", `test/api/query.test.ts:1445` "carries a finding with no page as a
null url", `test/rules/helpers.test.ts:692` "maps each fetch class to the status
a reader acts on", `test/rules/helpers.test.ts:712` "names a block a block,
whatever status the challenge was served with",
`test/fixtures/harness.test.ts:1130` "declares a column for every evidence key it
writes, and writes every column it declares",
`test/rules/registry.test.ts:733` "finds one defining file per rule, and the key
spelled inside it".

### 4.4a `issue_inlinks` → `{columns, items, nextCursor}` — the links that point at it

For **`links.broken-internal`, `links.to-server-error` and (Phase 23)
`robots.blocks-internal-urls` only**. Those three rules report the TARGET — one
dead or robots-blocked URL linked from two hundred pages is one thing to fix,
and two hundred findings would bury it — while the fix is made in the SOURCE
page's markup (or, for a block, in robots.txt), and a link rule's
`sampleSources` is a sample of ten. This is the list. On a
`robots.blocks-internal-urls` row `statusCode` is always `null`: the
destination was never requested.

```json
{"columns":[{"key":"source","label":"Source"},
            {"key":"destination","label":"Destination"},
            {"key":"anchor","label":"Anchor"},
            {"key":"statusCode","label":"Status Code"}],
 "items":[{"source":"https://site/a","destination":"https://site/gone",
           "anchor":"Broken, right?","statusCode":404}],
 "nextCursor":null}
```

`anchor` is `null` for a link with no anchor text at all — an image link, a bare
`<a>` — which is a finding in itself. `statusCode` is the DESTINATION's own
crawled status.

**Any other rule is refused with a 404** naming the two that have a report, never
answered with an empty page: an empty page here would read as "nothing links to
it". **Internal links only**, and that is the join rather than a filter — an
external target is never fetched, so this engine has no status for it and will
not invent one.

It reads the `links` table, not the findings, so it answers before `crawl_rules`
has ever run, and a rule that CAPPED its findings still gets a complete report
here — which is also the one place the two reports do not line up: **on a capped
run this report can name a `destination` that has no row in `/urls`**, because
the rule's listing stopped before reaching it. The same rows are the
`links_to_4xx` / `links_to_5xx` CSV views (§12), in the same four columns and
the same order.

### 4.4b `metric_table` → one metric as a table

**`GET /crawls/:id/metrics/:metricId`** (MCP: `metric_table`). `metrics_get`
(§4.5) serves a metric's stored `value` verbatim, which is what an agent quoting
a number wants and is unusable as a table: the object's shape belongs to the
metric, and the fourteen metrics write four different shapes. This is the same
numbers with the engine's own header on them, shaped SERVER-SIDE from the rule's
declaration so the JSON, the CSV and a UI cannot disagree about what a column is
called.

```json
{"metricId":"site.health","title":"Site: Health rollup",
 "explanation":"…","howToFix":"…",
 "summary":[],
 "columns":[{"key":"scope","label":"Scope"},
            {"key":"urlsTotal","label":"Pages Judged"},
            {"key":"cleanRatio","label":"Clean Ratio"}],
 "rows":[{"scope":"Site","urlsTotal":435,"cleanRatio":0}]}
```

**How to render it.** `columns` is the header, in order; a row is drawn by
walking it and reading `row[column.key]` — nothing else is on a row. Where the
rows are per scope the FIRST column is the row's own identity: its cell is the
template name, the sitemap document's URL, or `Site` for the row covering the
whole crawl, and its label says which kind of row the table holds (`Template`,
`Sitemap`, or `Scope` where the site is the only row). `(untyped)` — the pages
the crawler could not type — and `(other)` — the templates past a rollup cap —
are real cohorts and print as they are.

`summary` is `[{key, label, value}]`: the site-level scalars that belong ABOVE
the table rather than in it (`url.param-volumes`' counts of the whole site's
parameters, which would otherwise repeat on every parameter row). Empty on the
twelve metrics that have none.

**The four shapers**, one sentence each — a metric declares exactly one, and
which one is visible in the header rather than in the payload:

- **`perScope`** — one row per stored row, site first and the rest in
  scope-value order, each column a path into that row's value
  (`site.health`, `inlinks.distribution`, `redirect.volume`, `render.coverage`,
  `sitemap.structure`, `hreflang.coverage`, `content.template-similarity`, the
  two depth distributions).
- **`perScopeMeasure`** — one row per stored row × MEASURE, with the measure's
  name in its own column and the statistics of that measure after it, so a
  template's word count and renderable word count are two rows under one header
  (`content.metrics-by-type`, `page.weight`).
- **`expandList`** — the rows are the ELEMENTS of a list the site row carries,
  and the site row's remaining scalars become the `summary`
  (`url.param-volumes`; `inlinks.extremes`, which merges its two lists into one
  table and tags each row `Most linked` or `Least linked`).
- **`expandMap`** — one row per stored row × ENTRY of a map whose keys are the
  site's own data, which is why they cannot be columns: used once, by
  `inlinks.sources-by-type`, whose rows are destination template / source
  template / links, ordered by the count descending.

**A null cell is a value this metric did not write for that row — an empty cell,
never a zero** (§5, at table level). `sitemap.structure` is the table where that
is load-bearing: its site row counts the documents and its per-document rows
count their own entries, under one set of headings, so the three site-only
columns are null on every document row by design. Numbers cross as numbers (the
client formats), percentages as numbers under a label ending `(%)`, booleans as
`true`/`false`.

**`note` is present exactly when `rows` is empty**, and says which empty it is:
a judged crawl whose metric measured nothing, or a metric whose rows hold an
empty list. The two answers that are NOT an empty table are refusals, both
404: a `metricId` this ruleset does not define (the metric is the RESOURCE here,
where on `metrics_get` it is a filter and a 400), and **a crawl no rules pass
has ever completed over** — metrics are written by `crawl_rules`, and "nobody
has looked" is never served as "there is nothing here".

**The header is on the catalog too.** `rules_catalog` carries
`table: {columns: [{key,label}], summary: [{key,label}], order?}` on every metric
rule and on no other, exactly as it carries `columns` on every rule that finds
and on no metric — the two fields are never both present and never both absent.
Both come from the rule's own declaration through one function, so a header
drawn from the catalog and one drawn from the rows are the same list.

**And so is the order of the section.** `order` is the metric's place among the
metric tables — lower first, ties by rule id, absent sorting after every table
that declares one. It is a decision about what a client reads and in what order,
so it is declared beside the labels rather than derived from the alphabet:
ordering the metrics by id put `site.health`, the census every other table is a
part of, tenth of fourteen. `rules_catalog` already returns the metric rules in
that order, as one contiguous block after the rules that find (§5.1), so a
client that lays the section out by filtering `kind === "metric"` and keeping
the order it was given — which is what the demo does — needs `order` only if it
sorts for itself.

**The CSV** is `view=metric_table` with a `metricId` (§12): the header is the
same LABELS, one row per table row, and **the summary scalars lead every row as
extra columns** — a CSV has one rectangle and no place above it, and dropping
them would hand a client a file saying "`_pos` appears on 47 URLs" while losing
"this site has 5 parameters on 61 URLs". The file is named
`crawl_<uuid>-<metricId>.csv`.

Pinned: `test/api/query.test.ts:1555` "serves the metric's copy, its header and
one row per scope", `test/api/query.test.ts:1631` "puts both sitemap scopes in
one table, with the site-only cells empty",
`test/api/query.test.ts:1682` "says which kind of empty a rowless table is, and
refuses the two that are not", `test/api/query.test.ts:1718` "serves the same
header on the catalog, and only on metric rules",
`test/api/mcp.test.ts:2120` "answers one metric's table: the copy, the header,
and one row per scope",
`test/rules/metric-table.test.ts:351` "gives every metric rule a table whose
columns are the catalog's",
`test/fixtures/harness.test.ts:1947` "renders every metric's table, with no
empty column and no unmapped key".

### 4.5 `metrics_get` → `{items: MetricRow[], nextCursor}`

`{metricId, scope, scopeValue, value, title, explanation, checkIds, category}`.
`value` is the metric's own object — its shape belongs to the metric, and the
copy travels with it. Scopes: `site | page_type | sitemap_doc` (`rule` was never
one — corrected in P21-T1, beside §4.4b). See §6 for
`site.health` and for the absent-family trap.
Pinned: `test/api/query.test.ts:1479` "returns the stored value with the
registry's copy joined", `test/api/mcp.test.ts:2091` "answers the measured
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
`test/api/mcp.test.ts:1398` "says over the wire whether a render pass ran, not
just how many pages it left", `test/api/http.test.ts:1723` "serves
renderPassEvidence none beside the selection a pass would make",
`test/rules/render-metrics.test.ts:528` "answers none on a crawl nobody
rendered, and still reports what a pass would choose".

### 4.6 `pages_query` → `{items: PageRow[], nextCursor}`

```
url, statusCode, fetchClass, fetchReason, pageType, indexable, depth,
clickDepth, discoveredVia, wordCount, renderableWordCount, rendered,
renderedWordCount, renderedRenderableWordCount, renderError,
fetchedAt, recheckFetchClass, recheckStatusCode, recheckReason, recheckAt
```

Deliberately slim: `pages` has sixty columns and an endpoint that returned them
would be an export in listing clothes (obligation 1). `clickDepth: null` means
*unreachable*, never zero. `renderError` is why an **attempted** render produced
nothing; null there is not "it worked".

**The last five are the two observations, and they were added to a projection
this document calls deliberately slim — so the argument, rather than the fact.**
`fetchedAt` is when the crawl fetched the page; the four `recheck*` fields are
the 5xx re-verification pass's second look (§4.2). They are here because the
recheck is the only mechanism on this surface that turns a `critical` into a
`warning`, and a consumer that cannot see the second observation cannot check
the engine's arithmetic before quoting it to a client. Tenant safety is
unchanged: every value is composed from the response and the URL policy, exactly
as `fetchReason` is, never from a stack trace or a local path (§9).

- `recheckFetchClass` **null means nobody asked**, and never "it was fine". The
  pass only ever asks about a row whose first fetch was `server_error`, so null
  is what every healthy page of every crawl carries. `server_error` again is a
  confirmed outage; any other ANSWER from the site (`ok`, `redirect`,
  `client_error`, `non_html`, `too_large`, `unsupported_encoding`) is the
  transient case; `timeout`, `network_error`, `blocked` and `disallowed` are the
  second look learning nothing, and the finding stays `critical`.
- `recheckReason` with a **null** class is the pass declining to ask and saying
  why (`recheck-cap`, its 500-row budget) — a different fact from both nulls
  together, which is "nobody asked" (§5.5).
- `recheckAt` is null exactly when `recheckFetchClass` is; the invariant holds
  over the whole table. `recheckAt` minus `fetchedAt` is the gap the site had to
  recover in, and it is why `fetchedAt` is on the wire at all.
- Both timestamps are serialised as ISO instants, like every other time this
  surface publishes.

**No per-page resource rollup here, and that is a decision rather than an
omission** (P11-T4). A file count or a byte sum per page would be cheap enough to
compute — the edge table is indexed by page — and it would still be wrong to put
here: it is an aggregate of ANOTHER table on a listing whose whole discipline is
one row per page of that page's own columns, and a bare number could not carry
the two bounds every weight figure needs (the `src`+`srcset` ceiling, the
unweighed-file floor). Per template it is `metrics_get` with
`metricId: "page.weight"`, which states both; per file it is the `resources` CSV
view (§12), which carries `referencingPages`.
Pinned: `test/api/query.test.ts:1738` "returns a slim projection and nothing
else" (the widened projection, pinned as a whole set),
`test/api/query.test.ts:1776` "carries both observations, and never lets the
second rewrite the first", `test/api/mcp.test.ts:2243` "names every field of the
row it answers with, in its own description", `test/api/query.test.ts:1879` "carries both word counts, so the number a
reader quotes is the one they can see", `test/api/mcp.test.ts:2177` "answers the
crawled pages, slim and ordered by URL".

### 4.7 `robots_get` → the robots.txt this crawl obeyed

`{crawlId, robotsUrl, outcome, raw, truncated, crawlDelaySec, note,
sitemapSources[], suppliedSitemaps[], userAgent}`. It is **stored evidence, never
a re-fetch**: the file as the crawl read it, which is the only honest answer to
"what did this crawl obey". `outcome ∈ read | absent | unreachable`, and
`unreachable` is not "there are no rules" (RFC 9309 §2.3.1.4).
Pinned: `test/api/query.test.ts:1927` "answers with the robots.txt the crawl
read, and the metadata that makes it readable", `test/api/mcp.test.ts:2280`
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
Pinned: `test/api/query.test.ts:3362` "narrows the listing to one site, and
leaves the other site's crawls out", `test/api/query.test.ts:3368` "matches the
apex and www spellings, both schemes", `test/api/query.test.ts:3382` "refuses a
siteUrl that is not an http(s) URL rather than dropping the filter";
`test/api/mcp.test.ts:1986` "narrows crawl_list to one site".

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

### 5.1 `rules_catalog` — three states of `fired`, and the `marker` flag

```json
{"rulesetVersion":"0.7.0","rules":[{"id":"links.orphan","kind":"query",
 "severity":"warning","category":"links","checkIds":["CHECK-32"],
 "title":"…","explanation":"…","howToFix":"…","fired":{"count":243}}]}
```

Every rule that FINDS carries `columns` as well — its report, column by column,
`[{key, label, optional?}]`, the four standard ones first and then its own. It
is the same list `issue_urls` serves beside its rows (§4.4), from the same
function, so a table laid out from the catalog and one laid out from the listing
cannot disagree. **A metric rule has no `columns`**, for the reason it has
`measuresOnly`: it writes no finding rows. It carries **`table`** instead —
`{columns: [{key,label}], summary: [{key,label}], order?}`, the header of that
metric's own table, the labels above it and the metric's place in the metric
section, the same lists `metric_table` serves beside its rows (§4.4b). The two
fields are never both present and never both absent.

**The order of the rows in this answer is two orders.** The rules that FIND come
first, by severity then rule id — the order `issues_list` returns its groups in,
so a UI that draws both puts the same rule in the same place twice. The METRIC
rules follow them as one contiguous block, by their declared `table.order` then
by id (Phase 21); no other listing has an opinion about where a metric goes,
because a metric writes no finding row and never appears in `issues_list`.
Pinned: `test/api/query.test.ts:4194` "leads the metric section with the site
census, then the declared sequence".

A NOT MEASURED marker's row carries one field more — `marker`, the reason
(Phase 17; the key is on markers and on nothing else):

```json
{"id":"resources.not-fetched","kind":"query","severity":"info",
 "category":"technical","checkIds":["CHECK-48","CHECK-49","CHECK-50","CHECK-51"],
 "title":"…","explanation":"…","howToFix":"…",
 "marker":"a crawl that recorded its resources and asked about none (P12-T2)",
 "fired":{"count":1}}
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

**`marker` is a third flag, and it is not about the count — it is about the
rule.** Present, as a non-empty string, on a NOT MEASURED marker and on no other
row: the key is simply absent elsewhere, never `null` and never `""`, so
`"marker" in rule` and a truthiness test agree. The value is the registry's own
reason — the crawl condition whose silence that marker explains ("a robots.txt
the crawl could not read", "a crawl started with host probing off") — and it is
the same string `RuleMeta.marker` carries, mirrored rather than restated.

A marker's findings say a check **could not be answered on this crawl**: they
are facts about the crawl, not defects in the site (§5.3 tells the resource
family's version of the same story, and CHECK-83 lists the whole family). Ten of
the ruleset's 45 `info` rules are markers, so **severity cannot separate them**:
a consumer that bands by severity alone files "we could not look" under the same
heading as "we looked and found something small". Read this field. Do not keep a
list of marker ids of your own — that list goes stale the next time a marker is
added, which is exactly what happened to the engine's own hand-written map
before the flag replaced it. `src/demo/index.html` is the worked example: it
routes any group whose catalog row carries `marker` out of the severity bands
into a fourth section, "Not checked on this crawl".

**The counts sum to `crawl_status.findingsCount`.** Verified live on
`crawl_02ff6f7a`: 86 rules, 22 fired, counts summing to 17,659 = its
`findingsCount`. On the capped `crawl_3f3ab847`: sum 1,326, with `atLeast: true`
on exactly `content.near-duplicate` (500) and `links.orphan` (200).

**A catalog total counts ROWS WRITTEN, not cases that exist.** Under a finding
cap the two differ by construction, which is what `atLeast` is for. Quoting a
catalog count to a client as "the number of orphans on this site" is the Phase 6
D-1 incident recurring in a new place.

Pinned: `test/api/query.test.ts:2461` "answers the whole ruleset with its
client-facing copy and no fired state", `test/api/query.test.ts:2541` "joins a
judged crawl's fired state, and counts a clean rule as zero",
`test/api/query.test.ts:2565` "marks a metric rule's structural zero apart from a
real clean", `test/api/query.test.ts:2591` "says fired null on a crawl nobody has
judged, however many rows it holds", `test/api/query.test.ts:2608` "marks a
capped rule's count as a floor, agreeing with issues_list",
`test/api/query.test.ts:2647` "reads the marker and the counts from one
statement", `test/api/query.test.ts:2503` "carries the registry's marker on every
NOT MEASURED marker, and on no other rule"; `test/api/mcp.test.ts:1807` "joins a
judged crawl's fired state, zero included, summing to findingsCount" and
`test/api/mcp.test.ts:1870` "names every field it actually answers with".

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

   **Since Phase 17 none of these four has to be recognised by id.** Each one's
   `rules_catalog` row carries `marker` with the reason it exists, and so does
   every marker outside this family — `crawl.blocked`, `links.orphan-skipped`,
   `robots.check-skipped`, `host.probe-skipped`, `h1.duplicate-skipped`,
   `content.thin-skipped` (§5.1). A consumer sorting findings into "the site's
   problems" and "what this crawl could not answer" reads that field; the id
   list above is prose for a human, not a switch statement for a client.
2. **`fetch_class` null is per FILE, so a page's weight can be a floor.** The
   `page.weight` metric flags `atLeast: true` on any row that references a file
   nobody weighed, and reports the referenced-and-weighed pair beside it.

Pinned: `src/db/schema.ts`'s `resources.fetch_class` comment (the column says
this); `test/api/query.test.ts:2990` "writes one row per referenced file, with
the class that makes an empty status readable" (all four spellings in the CSV);
`test/crawl/fetch-resources.test.ts:1335` "asks nobody anything when the operator
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
`test/api/query.test.ts:2379` "reports the cap-exceeded page count a crawl
stamped, and null when none did".

### 5.5 `recheckFetchClass` null — nobody asked about this page

The newest citizen of the doctrine, and the one whose null is easiest to read as
good news. `pages.recheck_fetch_class` is the SECOND observation of a page whose
FIRST fetch ended `server_error`, and the pass that writes it asks about no other
page — so **null there is "nobody asked", never "the page is fine"**. On a
healthy crawl every page in the table carries it.

The column's partner is `recheck_reason`, and the pair spells three sentences:

| `recheckFetchClass` | `recheckReason` | what it says |
|---|---|---|
| null | null | **Nobody asked.** No pass ran over this crawl (it predates migration 0016, or it failed or was cancelled first), or a pass ran and never reached this row. Nothing was decided. |
| null | non-null | **The pass declined to ask, and says why.** One reason at launch: `recheck-cap`, its 500-row budget — the `resource-cap` doctrine one table along (§5.3). |
| non-null | either | **A second observation exists.** Including the refusals: a URL our own policy or the site's robots.txt turned down on the second look is `disallowed` plus a reason, because a refusal is a decided outcome and not an absence. |

A recheck that itself FAILS is never a null: a timeout is `timeout` and a
socket failure is `network_error`, written as the classes they are. `recheckAt`
moves with the class — null exactly when it is null — and that invariant holds
over the whole table.

**At the crawl level the same null is `recheck.passAt`, and its zero is a
measurement.** `serverErrors: 0` counts this crawl's 5xx pages and means the
crawl saw none; `passAt: null` means no complete pass is on record. A crawl with
`pending` equal to `serverErrors` beside a null `passAt` is one nobody looked at
twice — those pages keep their `critical` `http.server-error` findings, and the
evidence blob carries `recheck: "not run"` (one of `"not run"`, `"capped"`,
`"confirmed"`, `"inconclusive"`) so a report can say which state it is in rather
than implying a re-verification that never happened.

Pinned: `src/db/schema.ts`'s `pages.recheck_fetch_class` comment (the null
contract, stated at the column); `test/api/query.test.ts:1776` "carries both
observations, and never lets the second rewrite the first" (the three nulls,
told apart row by row, and the `recheckAt` invariant over every row of a
listing); `test/api/query.test.ts:2323` "tells a crawl with no server errors
apart from a crawl nobody rechecked" (the two zeroes, at the crawl level).

### 5.6 `failureReason` null — either nothing failed, or nobody could say

The doctrine's other shape. Every null above is "nobody measured"; this one is
two sentences that share a value, and `status` is the only thing that tells them
apart:

| `status` | `failureReason` | what it says |
|---|---|---|
| anything but `failed` | null | **Nothing failed.** The correct and only answer — the column belongs to `failed` rows, and a crawl that finished, was cancelled, or is still running carries no reason by construction. |
| `failed` | non-null | **The engine's own sentence for why**, from one of the three writers in §4.2. |
| `failed` | null | **The engine recorded no reason.** A row this engine closed BEFORE migration 0017 existed, when `status` was the whole story. Not "it failed for no reason", and not a row to re-run in the hope of a better answer — the crawl is over and the explanation was never written down. |

The contract is an IMPLICATION and not an equivalence: `failure_reason IS NOT
NULL` ⟹ `status = 'failed'`, enforced at every writer, and the converse
deliberately left open so the third row above stays representable. A consumer
that renders the third row as the second is telling an operator the engine gave
an answer it never gave.

**There is no backfill and there will not be one.** The dead run's reason lived
in a process that is gone; inventing one now would be a fabricated fact in a
field a reader takes for a recorded one (hard rule 7).

Pinned: `src/db/schema.ts`'s `crawls.failure_reason` comment (the contract,
stated at the column); `test/db/migration-0017.test.ts:318` "holds
failure_reason IS NOT NULL => status = 'failed' over the table" (the implication
itself, asked as SQL over the whole table, with a real crawl on each side of it);
`test/db/migration-0017.test.ts:205` "closes the robots-502 crawl failed, with a
reason naming robots and the status" (a real crawl of a real host whose
robots.txt answers 502); `test/db/migration-0017.test.ts:258` "clears the
sentence when the failed crawl is resumed" (the implication over a RESUME, which
is the one move that changes the status without closing the crawl — the fixture
holds the robots request so the row is read mid-run);
`test/api/mcp.test.ts:3033` "clears the failure sentence of the crawl a resume
accepts" (the same, over the queue's own writer and on the wire);
`test/api/query.test.ts:4137` "tells a pre-0017 failed
crawl apart from a crawl that did not fail" (the two nulls, on the wire).

---

## 6. `site.health` — the rollup, and everything it is not

One row per crawl, `scope: "site"`:

```json
{"urlsTotal":441,"urlsWithCritical":0,"urlsWithWarningOnly":398,
 "urlsWithInfoOnly":32,"urlsClean":11,"cleanRatio":0.0249,"pagesNotAuditable":108,
 "urlsCanonicalised":2,"urlsNoindex":0}
```

(The row ruleset 0.17.0's own statement produces on `crawl_02ff6f7a`,
re-measured 2026-09-23 over that crawl's 551 pages and its stored findings. The
pre-0.17.0 printing of the same crawl read `urlsTotal` 443 with no trailing
columns at all: the two pages that canonicalise elsewhere were judged then and
are set aside now, which is the whole of the difference — 441 + 2 + 0 + 108.
A crawl judged before 0.17.0 carries no such keys at all, and the table prints
an empty cell rather than a nought nobody counted.)

- **The census is THE JUDGED PAGE: `fetch_class = 'ok' AND status_code = 200 AND
  is_indexable AND NOT canonicalised elsewhere`** — the cohort the ruleset
  reports defects on as a page's own (§5.x, `isJudged`/`JUDGED` in
  src/rules/helpers.ts). It is the same cohort every other metric measures and
  it is not the crawl's page count. Before 0.17.0 it was fetched-OK 200s
  including noindexed and canonicalised pages, because the rules judged those
  too; the rules stopped, and this moved with them.
- **`urlsCanonicalised` and `urlsNoindex` are the fetched, 200-answering URLs
  the cohort sets aside**, so that a crawl reporting far fewer findings than the
  last one can say how many pages it stopped judging and why. They are disjoint,
  **noindex taking precedence**: a page that both noindexes itself and defers to
  another URL is counted once, under the noindex. (One vocabulary across the
  surface — that is the order the per-row `Indexability Status` column uses, and
  the one `sitemap.non-indexable`'s `reason` uses. A noindex is the page's own
  explicit instruction to stay out of the index; a canonical is a hint about
  which URL to prefer, and search engines treat the explicit directive as the
  stronger signal, so such a page reads `Noindex` in every one of the three
  places. The three are equivalent by construction rather than textually
  identical: this table tests the stamped `is_indexable`, the other two ask
  `hasNoindex` of the two robots channels — and the stamp is written from those
  same two channels, with `indexabilityOf` throwing if a row ever disagrees.)
- **The four buckets partition `urlsTotal` exactly.** A page is counted once, at
  the worst severity it carries. Site-level findings (no `page_id`) reach no
  bucket at all — a site-wide fault is not a share of the pages.
- **`pagesNotAuditable` is everything else, lumped: redirects, 4xx, 5xx, failed
  or refused fetches, non-HTML 200s, any other status.** One number for several
  unlike things, on purpose — it is a *remainder*, and its job is to stop 108
  pages vanishing silently beside a gauge. **`urlsTotal + urlsCanonicalised +
  urlsNoindex + pagesNotAuditable` is the crawl's page count** (441 + 2 + 0 +
  108 = 551), asserted by the rule itself, by its unit test and end to end in
  the fixture harness. Which kinds those are is a
  `pages_query` question; a non-HTML 200 is counted by no other table at all.
- **The four counts are the authority; `cleanRatio` is a convenience.** Four
  decimal places collapse at scale: 1 clean page in 50,000 rounds to `0.0000`
  and 49,999 in 50,000 to `1.0000`. Work percentages out from the counts.
- **`cleanRatio` counts pages with no reported finding.** Under a finding cap
  the listing rules stop writing rows, so pages past the cap are counted clean:
  on a capped run the ratio is a **floor of what is known**, not a fact about
  the site.
- **`cleanRatio` is `null` over an empty census** — nothing was measured, and
  both 0 and 1 would be claims about a site with no judged pages.
- **`urlsWithCritical` is structurally near-empty today**, and the reference
  crawl's 0 is honest rather than flattering. Exactly three rules carry
  `critical` severity, and none of them can readily fill this bucket:
  `content.csr-dependent` and `nav.js-only` judge only pages the render pass
  actually rendered — that crawl rendered **14 of its 551 pages**, about 3% of
  the census, and neither rule fired on any of them — while `redirect.loop`
  fires on redirecting pages, which are **outside the judged census by
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

Pinned: `test/rules/health-metrics.test.ts` (16 tests) —
`test/rules/health-metrics.test.ts:45` "carrying the engine-coverage check it is
evidence for", `test/rules/health-metrics.test.ts:219` "partitions the census
exactly", `test/rules/health-metrics.test.ts:253` "answers an empty census with a
null ratio", `test/rules/health-metrics.test.ts:277` "lets no site-level finding
poison a page bucket", `test/rules/health-metrics.test.ts:302` "keeps the pages
it cannot judge out of the buckets", `test/rules/health-metrics.test.ts:351`
"sets a noindex 200 aside in its own column rather than in a bucket",
`test/rules/health-metrics.test.ts:390` "counts a page that both noindexes and
canonicalises under noindex", `test/rules/health-metrics.test.ts:412`
"partitions every fetched URL over the four columns",
`test/rules/health-metrics.test.ts:564`
"buckets the findings the capped run wrote, and no others"; the copy contracts —
`test/rules/copy.test.ts:1316` "names every column and the population they
are over", `test/rules/copy.test.ts:1341` "says the counts are the authority, not the
ratio", `test/rules/copy.test.ts:1358` "grades nothing: no score, no label, no
threshold";
`test/rules/coverage.test.ts:413` "site.health is filed under the
engine-coverage check, and CHECK-32 lost no claimant" (the re-file in both
directions, and CHECK-83 outside the crawl-derived universe);
`test/fixtures/harness.test.ts:2490` "the health rollup agrees with a
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
than once on a page collapses to per-URL presence.** `images.oversized` files one
finding per IMAGE, so on the reference crawl the comparison sees its 157 URLs,
not its 833 rows, and a page that went from one oversized image to nine is
`persisting`, not `new`. (This paragraph's example was `content.near-duplicate`
while that rule reported PAIRS; §11 below is what changed it.) So every row
carries four counts:

- `baseCount` / `headCount` — finding ROWS, the numbers `issues_list` reports;
- `baseUrls` / `headUrls` — the distinct URLs the diff is actually over.

The two invariants a consumer may rely on, asserted on every row of both the
fixture and the real comparison:

```
headUrls == new + persisting        baseUrls == resolved + persisting
```

**Near-duplicate URLs are pages, one row each** (Phase 19 §11). `content.near-
duplicate` files one finding against every page that has at least one
near-duplicate, carrying the count and the closest few — so the URL in this diff
is the page itself, and a page that went from two near-duplicate partners to
fifty is `persisting` rather than `new`. (Before §11 the rule reported PAIRS and
filed each against one of the two, so the diff's URL was a representative and a
cluster could churn between `new` and `resolved` without the site changing. It
cannot now: a page is its own representative.)

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
every refusal — of which `test/api/query.test.ts:3431` "answers both sides,
comparable, and the rules in issues_list's order" is the answer itself and
`test/api/query.test.ts:3845` "makes the same refusals as the summary" is the
drill-down inheriting the summary's refusals; over the agent transport,
`test/api/mcp.test.ts:1933` "answers the counts and the caveat when the two
rulesets differ" and `test/api/mcp.test.ts:1998` "names every field it answers
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
  `test/api/query.test.ts:3903` "carries no path, no document and no stack in any
  answer this phase added" and `test/api/query.test.ts:3946` "holds for the CSV
  bytes, which are a response like any other".
- Refusals name **the caller's own words** — the ids they supplied, the field
  they misspelled, the accepted vocabulary — plus, for a cross-site compare, the
  two hostnames the caller asked about.
- Anything unexpected becomes `{error: "internal error", correlationId}` at both
  transports.
- Rule `evidence` is built from crawled rows by the registry's own discipline;
  the wrapper around it is a closed shape.

Four postures a Talos integrator should know about rather than discover:

1. **`export_crawl`'s file-writing mode answers with an absolute server path.**
   That is the answer to a tool whose job is to write a file, and the audience
   is an operator, not a tenant. **A tenant-facing Talos surface should use the
   HTTP CSV stream** (`GET …/export?format=csv&view=…`), which returns bytes and
   no path. Do not render the `path` field to a tenant.
2. **`pages_query.renderError`** is the only field whose text originates in our
   browser rather than on the site. It is capped to the first line of the error
   and carries no stack, but treat it as a diagnostic string rather than client
   copy.
3. **`crawl_status.failureReason` is the second field of that kind**, and reads
   the same way. Two of its three writers produce text this engine composed —
   the classified robots sentence and the operator's fixed one — and the third
   is the FIRST LINE of whatever threw inside the run, capped and stack-free by
   the same rule `renderError` follows. The crawl loop's own throws name crawl
   ids, URLs and counts rather than paths, but a failure that originates BELOW
   the loop (a database or socket error, say) carries whatever the runtime put
   in its message, which can include a host and port this engine connects to —
   **and an absolute path on this server.** Node's own errors carry the path
   they were about: a Postgres unix socket (`connect ENOENT
   /var/run/postgresql/.s.PGSQL.5432`), a CA bundle or a module the runtime
   could not read (`ENOENT`, `EACCES`), a disk that filled (`ENOSPC`). Every
   one of them arrives in `error.message`, which is what this column holds.
   **Show it to an operator, log it, quote it in a handover — do not paste it
   into a tenant-facing report.** A crawl's `siteUrl` is the tenant's own; this
   sentence is the engine's.
4. **There is no tenancy isolation on crawl listing yet.** `crawl_list` without
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

`RULESET_VERSION` (**0.18.0** as of Phase 23) stamps **judgement**: bump it when
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

**Phase 23 bumped to 0.18.0 because verdicts and thresholds MOVE.** Fourteen
rules joined (see the top of this document), and existing ones changed what
they say: `title.too-short` fires under 30 characters, `meta-description.too-long`
over 155, the three field-duplicate rules leave out rel=prev pages, and a 5xx or
no-response finding now depends on the widened second look. A crawl re-judged
at 0.18.0 can GAIN findings from the new rules and LOSE duplicate findings on
paginated pages; nothing is backfilled, and the rendered-value rules cannot
fire on a crawl rendered before it.

**Phase 22 bumped to 0.17.0 because verdicts MOVE on 26 rules.**
A page defect is now reported only on a JUDGED page — fetched OK, 200,
indexable, not canonicalised to another URL — and the metrics count the same
cohort; a noindexed or canonicalised page carries no title, heading, image,
thin-content, orphan, depth, sitemap-absence or structured-data finding,
because the defect belongs to the URL it defers to. The rules whose subject is
the canonical, the directive, the response code, the sitemap entry, the file
or the rendered template keep fetched-OK on purpose. The three field-duplicate
rules and near-duplicate count reciprocal hreflang alternates as one page
(`alternatesCollapsed` says how many were folded in); exact-duplicate does
not. `sitemap.non-indexable` gains the canonicalised case (`reason`).
`site.health` gains `urlsCanonicalised` and `urlsNoindex`, so the pages set
aside are counted, never silent. Nothing is backfilled: a crawl re-judged at
0.17.0 loses the findings on its set-aside pages and keeps every other.

**Phase 21 bumped to 0.16.0 on one ground: labels.** Every metric rule now
declares its table (§4.4b) — the shaper that turns its stored rows into rows,
and a heading over every column and every summary scalar. No stored value,
predicate or copy moves; a crawl re-judged at 0.16.0 writes byte-identical
`metrics` rows. The headings are client-facing text served by `rules_catalog`
and printed by `metric_table`, so what the ruleset says about a site changed
exactly as 0.15.0's column headings changed it for the finding rules. The same
declaration carries `table.order` (§5.1) — where each metric sits in the metric
section — which is presentation rather than a sentence and rides on this bump
rather than earning one of its own.

**Phase 20 bumped to 0.15.0 on three grounds, none of which moves a verdict.**
Every rule's client-facing copy was rewritten by hand in the register of an SEO
tool (`Area: Condition` titles, one to three sentences, an imperative fix, one
sentence per marker reason); every rule that finds declares `columns`, served
by `rules_catalog` and beside every listing's four standard columns (§4.4);
and `crawl.blocked` gains `fetchReason`. An older crawl re-judged at 0.15.0
reports the same rows under the new headings; nothing is backfilled and no
count changes.

**Phase 19 bumped to 0.14.0 on four grounds: two verdicts MOVE, one measurement
CHANGES, four rules are added, and copy changes on 26.** The moves: the two
duplicate rules and every hreflang rule now ignore a page canonicalised
elsewhere (as declarer and as target), because on a real crawl the only
"duplicates" and the only missing hreflang return links were parameter
variants each canonicalised to the base. The measurement: `content.near-
duplicate` compares pages on `main_simhash` (migration 0018, the fingerprint of
the main content — inside `<main>`, else the body, and in both cases minus
nav/header/footer/aside) with both pages at least 50 words of their own, because
the whole-text fingerprint was dominated by ~900 words of chrome on every page; a
crawl with no main-content fingerprint gets `content.near-duplicate-skipped`
(marker) rather than a silent pass. The §11 amendment, taken at gate time after a
re-crawl, adds two more facts to the same version: that rule now reports one
finding per PAGE (`{mainWords, nearDuplicates, closest}`, up to five closest,
capped by pages with an exact total — so the 500-pair budget and the
100,000-pair scan ceiling are gone and `findingCap` governs one listing budget;
`nearDuplicates` itself is exact to 200 and a stated floor above it,
`nearDuplicatesAtLeast: true`, which is what keeps the rule's wall time off the
square of the site on a degenerate cohort — 16.5 s where the exact count took
101.9 s over 5,000 identical fingerprints, 98.7 s against 950.1 s over 20,000),
and `content.thin` fires on `main_word_count < 150` — the words a page has of
its own — as a QUERY rule rather than a page rule, with `content.thin-skipped`
site-scoped beside it, because the column's null means "no main content at all"
on a 0018 crawl and "never measured" on an older one and only the crawl's census
tells those apart. The ruleset split is 25 page / 61 query / 14 metric over the
same 100 rules. Added: `links.to-server-error` (critical, the 5xx half of
CHECK-11), `hreflang.missing-self-reference` (warning), and the markers
`hreflang.alternates-not-crawled` and `content.near-duplicate-skipped` (info).
Copy: 26 entries and all twelve marker reasons, under a rubric test that bans
engine vocabulary from every client-facing string (§5.1's `marker` reasons
included). **Nothing is backfilled**: an older crawl re-judged at 0.14.0 loses
the canonical-variant duplicates (they were never duplicates), gains the two
markers where they apply, and keeps every other finding; the near-duplicate
count on a pre-0018 crawl is not comparable across the boundary because the
rule cannot run there at all — the marker is what says so.

**Phase 17 bumped to 0.13.0 on three grounds, and one of them MOVES a verdict.**
First, a rule added: `http.server-error-transient` (`warning`), which fires on a
5xx page whose second observation got a non-5xx answer from the site. Second,
that same page no longer fires `http.server-error` (`critical`) — the pair is
defined against one predicate and its negation, so they are mutually exclusive
and jointly exhaustive over `fetch_class = 'server_error'`: no 5xx page is ever
silent and none carries two findings. This is not the additive case Phases 12–14
drew; it is a verdict moving between two ids, which is exactly what the constant
exists to stamp. Third, `http.server-error`'s copy now names the second
observation and says plainly that a finding whose `recheck` is `"not run"` has
not been re-verified. **Nothing is backfilled**: no crawl re-judged at 0.13.0
loses an Error it had, because the recheck columns are null on every pre-0016
row and a null recheck fires the critical rule exactly as before. Totals moved
from 27 / 23 / 45 over 95 rules to **27 critical / 24 warning / 45 info over 96
rules**.

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
   total (`test/api/query.test.ts:1231` "500s a truncation note it cannot read
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
| `issue_urls` (needs `ruleId`) | **the rule's own** — `rules_catalog`'s `columns` labels, then `Truncated` | one finding of one rule | 243 rows (`links.orphan`) |
| `internal_urls` | url, status, fetchClass, indexable, clickDepth, pageType, title, recheckFetchClass, recheckStatus, recheckAt | one crawled page | 551 rows |
| `links_to_4xx` | Source, Destination, Anchor, Status Code | one internal link to a 4xx page | 99 rows |
| `links_to_5xx` | Source, Destination, Anchor, Status Code | one internal link to a 5xx page | — (added P20-T1) |
| `anchor_texts` | source, target, text | one link, internal or external | 35,145 rows / 4,664,393 B |
| `redirects` | source, chain, target, hops | one **redirecting page** | 10 rows |
| `resources` | url, kind, fetchClass, status, bytes, bytesSource, contentType, cacheControl, fetchReason, referencingPages | one **file** the served HTML points at | 0 rows (this crawl predates the pass) |
| `metric_table` (needs `metricId`) | **the metric's own** — its `summary` labels, then its `columns` labels | one row of one metric's table | 40 rows (`inlinks.extremes`) |

Semantics a consumer must repeat to its own users:

- **The `issue_urls` file is THE RULE'S OWN TABLE** (Phase 20). Its header is
  the labels of that rule's columns — the four standard ones (`Address`,
  `Status Code`, `Indexability`, `Indexability Status`) and then whatever the
  rule declares, exactly as `rules_catalog` and the JSON listing report them —
  with one cell per column, an array cell comma-joined, and a structured value
  flattened to its bounded `path=value` leaves. **The last column is always
  `Truncated`** and is filled only on the one row carrying a cap note: a table
  has nowhere else to put it, and a capped export that looked complete is the
  silent failure hard rule 7 forbids. The file is named for the rule —
  `crawl_<uuid>-<ruleId>.csv`, the WHOLE crawl id and not an abbreviation of it
  — and not for the view.
- **The `metric_table` file is THE METRIC'S OWN TABLE** (Phase 21), the
  `issue_urls` convention one kind of rule along: its header is the labels of
  that metric's columns, shaped by the same function the JSON route uses, and it
  is named for the metric — `crawl_<uuid>-<metricId>.csv` — rather than for the
  view. **The metric's summary scalars are extra LEADING columns repeated on
  every row**: a spreadsheet has nowhere above the rectangle to put them, and a
  file that dropped them would state a parameter's 47 URLs while losing the
  site's own totals. An empty cell is a null, as everywhere else in these files.
  It is the one view that is not a keyset read of a table — its rows are one
  metric's stored rows transformed, and what bounds it is the metric's own caps
  rather than a cursor.
- **`links_to_4xx` and `links_to_5xx` are INTERNAL links only.** The status
  comes from the target's own crawled row, and an external target is never
  fetched — so **an external 4xx is absent from this file rather than clean**.
  "No broken links" is not what an empty file says. They are two files for the
  reason `links.broken-internal` and `links.to-server-error` are two rules: a
  404 is fixed by editing or restoring the URL and a 502 by reading the server's
  logs. Their four columns are the `issue_inlinks` route's (§4.4a), in the same
  order and under the same headings, so a client with both open translates
  nothing.
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
- **In `internal_urls`, the last three columns are the SECOND observation.** A
  list of server errors that cannot be sorted by "still broken" is the wrong
  list, which is why they are here: `recheckFetchClass` is what the 5xx
  re-verification pass got on its second look, `recheckStatus` the status that
  came with it, and `recheckAt` when the row was settled (an ISO instant, so a
  spreadsheet sorts it). **All three are empty on every page nobody re-asked
  about** — which is every page whose first fetch was not a `server_error`, not
  a page that came back clean. `fetchClass` beside them is still the first
  observation and is never rewritten (§4.2, §5.5).
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
  column in these nine views emits one (a metric's cells are counts, bytes,
  distances and percentages, none of which go below zero). It is not a text-column guard: a
  `Cache-Control` header is the server's own string and lands in a cell exactly
  as a page title does, which is what `test/api/query.test.ts:3031` "never lets a
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

Pinned: `test/api/csv.test.ts` (the writer, the guard, the
flattening, the SQL keyset pins, and the eight-view vocabulary — including
`test/api/csv.test.ts:235` "heads the issue_urls view with the rule's own
columns, in the rule's own order");
`test/api/query.test.ts:2849` "writes each view's header, always, and the row a
caller came for" (including the three recheck columns, empty on a page nobody
re-asked about and filled on one that was), `test/api/query.test.ts:2990` "writes one row per referenced
file, with the class that makes an empty status readable" (the four unfetched
spellings), `test/api/query.test.ts:3031` "never lets a crawled string become a
formula" (including a hostile `Cache-Control`), `test/api/query.test.ts:3052`
"quotes a cell holding a comma, a quote or a newline",
`test/api/query.test.ts:3151` "exports exactly as many rows as the source holds"
(for `resources`, against BOTH of its tables: one row per file, and the
referencing counts summing to the edge table), `test/api/query.test.ts:3206`
"reads every view through a cursor that can be walked one row at a time",
`test/api/query.test.ts:3241` "refuses a view, a format or a rule it cannot
answer", `test/api/query.test.ts:3311` "refuses a crawl holding a retired rule's
findings BEFORE the header", `test/api/http.test.ts:1939` "tears the response
when a CSV export fails mid-stream, rather than truncating the file";
`test/api/mcp.test.ts:776` "describes the shape of the CSV it writes, not just
that it writes one" and `test/api/mcp.test.ts:2778` "streams the resources view
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

# The Ariadne surface Talos codes against

**Status:** the contract as of Phase 11 (ruleset 0.8.0, migrations 0000–0013,
15 MCP tools / 15 HTTP routes). `docs/talos-integration.md` says *why* the seam
exists and what obligations bind it; this document says *what the seam is*.

**What Phase 11 changed here**, so a reader of the Phase 10 version knows where
to look: `crawl_start` gained `fetchResources`; `crawl_status` gained
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
declaration by hand. The Phase 10 shapes were regenerated on 2026-09-01 and the
Phase 11 additions (§4.2's `resources` block, §12's `resources` view) on
2026-09-02.

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

Two properties make the double-transport claim below cheap to trust:

- **One service, two transports.** `src/api/service.ts` holds every query,
  refusal and vocabulary; `http.ts` and `mcp.ts` do routing and serialisation
  and nothing else.
- **The equality is tested, not argued.** `test/api/mcp.test.ts:2109`
  ("answers the same JSON for the same question, route by tool") calls thirteen
  (tool, route) pairs over the wire against one database and asserts the two
  answers are `toEqual`. `test/api/mcp.test.ts:2130` ("refuses in the same
  words, whichever transport asked") does the same for five refusals — the same
  sentence and the mapped status. `test/api/mcp.test.ts:2187` ("streams the
  bytes the other transport writes to a file") and `test/api/mcp.test.ts:2209`
  ("streams the resources view byte for byte") assert the CSV a route streams is
  byte-identical to the file the tool writes, for the `issues` and `resources`
  views.

  **What that equality does NOT cover**, stated so nobody reads more into it
  than it says: the four **command** tools — `crawl_start`, `crawl_mark_failed`,
  `crawl_render`, `crawl_rules` — are excluded, because each one *changes* the
  database and a second identical call would be answering a different question
  (their own transport suites cover them). And it compares **first pages only**:
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
  without one (`test/api/http.test.ts:1593` "refuses to produce a config without
  a token").
- **The token is checked before routing**, so an unauthenticated caller cannot
  map the surface: an unknown path answers 401, not 404
  (`test/api/http.test.ts:392` "checks the token before routing"). Every refusal
  names *which* thing was wrong — missing header, wrong scheme, wrong token.
- **MCP asks for no credential** and that is a posture, not an omission: an
  stdio client either started this process or was handed its pipes
  (`test/api/mcp.test.ts:2313` "asks for no bearer token: an stdio client is the
  process that started this one"). If Ariadne's MCP server is ever mounted on a
  network transport, that argument dies with the change and a credential has to
  arrive with it.
- **The domain allowlist binds both transports** (`ARIADNE_ALLOWED_DOMAINS`,
  exact host or `*.example.com`). An empty allowlist refuses every crawl
  trigger and still answers every query — the read-only posture a Talos
  deployment can run for reporting-only tenants
  (`test/api/mcp.test.ts:885` "refuses every crawl when the allowlist is empty",
  `test/api/http.test.ts:792` "refuses every crawl when the allowlist is empty,
  but still answers queries").

### Error bodies

| Situation | HTTP | MCP |
|---|---|---|
| Bad argument, bad value, unknown filter, compare of an unjudged crawl (§7.5) | 400 `{error}` | tool error `{error}` |
| Allowlist / URL policy refusal | 403 `{error}` | tool error `{error}` |
| No such crawl / rule / route | 404 `{error}` | tool error `{error}` |
| The row's own state forbids it (still running, retired rule id, unreadable stored evidence) | 409 `{error}` | tool error `{error}` |
| A defect of ours | 500 `{error: "internal error", correlationId}` | `{error: "internal error", correlationId}` |

`correlationId` is a UUID; the stack goes to the server log under that id and
nowhere else (`test/api/mcp.test.ts:2236` "turns an unexpected throw into a tool
error with a correlation id", `test/api/http.test.ts:1536` "turns an unexpected
throw into a 500 with a correlation id").

---

## 2. Conventions

**Pagination.** Every listing answers `{items, nextCursor}`. Pass `nextCursor`
back as `cursor` **with the same filters**; `nextCursor: null` means the listing
ended. `limit` defaults to 50 and is capped at 200 — a limit outside the
contract is refused, never clamped (`PAGE_SIZE_DEFAULT` / `PAGE_SIZE_MAX`,
`test/api/mcp.test.ts:1062` "refuses a limit outside the contract rather than
clamping it").

**Closed vocabularies.** Every query parameter, body field and tool argument is
on a closed list. `?serverity=critical` is a 400 naming both the typo and the
accepted set, never an unfiltered listing with a 200 on it
(`test/api/query.test.ts:2966` "refuses a typo'd filter instead of answering the
question nobody asked"). MCP argument typos are refused by the SDK's schema
validator before the handler runs (`test/api/mcp.test.ts:734` "refuses an
argument nobody allowed, naming it").

**Not paginated, on purpose:** `rules_catalog` and `crawl_compare`. Both are
bounded by the **ruleset** (93 rows) rather than by the crawl. The catalog is
~98 KB (100,645 bytes, measured 2026-09-02 over the 92 rows of ruleset 0.8.0;
`resources.not-fetched` adds its own copy to that) because it carries every
rule's full copy — the tool description says so, and points an agent that only
wants what fired at `issues_list` instead.

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

Pinned: the tool list and every schema — `test/api/mcp.test.ts:565`
("advertises exactly the fifteen tools of the agent surface"),
`test/api/mcp.test.ts:590` ("closes every input schema and describes every
field"), `test/api/mcp.test.ts:622` ("names every member of the closed
vocabulary each field enumerates"), `test/api/mcp.test.ts:651` ("advertises
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
- `capped` — a per-crawl budget (`maxResources` / `maxResourceHosts`) stopped the
  pass short of at least one file. **One flag for both caps**, because the row
  records one reason whichever cap it was; the in-run split lives on the crawl
  loop's own summary and never reaches the wire.

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
`test/api/mcp.test.ts:968` "answers the resource census and whether the crawl
asked for it" and `test/api/mcp.test.ts:998` "tells an agent what the resource
numbers mean, and what they do not". The robots split itself is
`test/crawl/fetch-resources.test.ts:828` "classes an unreachable third-party
robots.txt apart from a forbidding one" and
`test/crawl/fetch-resources.test.ts:846` "keeps `robots_denied` for a file the
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
(the capped shape); `test/api/mcp.test.ts:1241` "groups findings by rule, orders
them by severity" and `test/api/mcp.test.ts:1255` "carries a capped rule's real
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
registry's copy joined", `test/api/mcp.test.ts:1645` "answers the measured
numbers with their copy joined".

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
reader quotes is the one they can see", `test/api/mcp.test.ts:1668` "answers the
crawled pages, slim and ordered by URL".

### 4.7 `robots_get` → the robots.txt this crawl obeyed

`{crawlId, robotsUrl, outcome, raw, truncated, crawlDelaySec, note,
sitemapSources[], suppliedSitemaps[], userAgent}`. It is **stored evidence, never
a re-fetch**: the file as the crawl read it, which is the only honest answer to
"what did this crawl obey". `outcome ∈ read | absent | unreachable`, and
`unreachable` is not "there are no rules" (RFC 9309 §2.3.1.4).
Pinned: `test/api/query.test.ts:1288` "answers with the robots.txt the crawl
read, and the metadata that makes it readable", `test/api/mcp.test.ts:1746`
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
`test/api/mcp.test.ts:1540` "narrows crawl_list to one site".

**Pre-tenancy posture, stated plainly (see §9).** Without `siteUrl`, this
listing returns every crawl the engine holds, including other tenants'
`siteUrl`s, to any caller holding the token.

---

## 5. Null versus zero — the surface's one hard rule, at both ends

An empty answer and a zero are different sentences, and Ariadne spells them
differently everywhere. A dashboard that collapses them paints a clean site over
one nobody has examined.

The doctrine has five spellings on this surface, and this section carries four
of them: the catalog's `fired: null` (§5.1), the metrics' absent family (§5.2),
the resources' `fetchClass` null (§5.3), `resourceRefsCappedPages: null` (§5.4),
and the compare's outright 400 for an unjudged crawl (§7.5). The first two and
the last are faces of one rule, keyed by the same marker (`rulesRunAt`); the
third and fourth are each keyed by a column. The converse
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
statement"; `test/api/mcp.test.ts:1361` "joins a judged crawl's fired state, zero
included, summing to findingsCount" and `test/api/mcp.test.ts:1424` "names every
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
| `resource-cap` | a per-crawl budget stopped the pass short of this row |
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
   finding's evidence says which of the two reasons applies — `reason:
   "fetch-off"` for an operator's `fetchResources: false`, `reason:
   "pass-not-run"` for a pass that sent no request at all — beside
   `resourcesSeen` and `resourcesSkipped`, which are equal. A PARTIAL pass gets
   neither marker: something was measured, and the judging rules report it with
   their `unknownResources` counts. Both cases are also legible on
   `crawl_status`: `fetchResources: false`, or `skipped` equal to `seen`.
   **Read the coverage block before quoting any resource finding, or the absence
   of one.**
2. **`fetch_class` null is per FILE, so a page's weight can be a floor.** The
   `page.weight` metric flags `atLeast: true` on any row that references a file
   nobody weighed, and reports the referenced-and-weighed pair beside it.

Pinned: `src/db/schema.ts`'s `resources.fetch_class` comment (the column says
this); `test/api/query.test.ts:2089` "writes one row per referenced file, with
the class that makes an empty status readable" (all four spellings in the CSV);
`test/crawl/fetch-resources.test.ts:1179` "asks nobody anything when the operator
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
`test/rules/copy.test.ts:906` "names every column, and says the ratio is of
reported findings", `test/rules/copy.test.ts:939` "remainder is open-ended and
names the case nothing else counts", `test/rules/copy.test.ts:954` "says the
counts are the authority, not the ratio", `test/rules/copy.test.ts:980` "tells
its consumer which check it is evidence for" (which also asserts that the retired
filing disclaimer is GONE rather than merely superseded),
`test/rules/copy.test.ts:1007` "grades nothing: no score, no label, no threshold";
`test/rules/coverage.test.ts:276` "site.health is filed under the
engine-coverage check, and CHECK-32 lost no claimant" (the re-file in both
directions, and CHECK-83 outside the crawl-derived universe);
`test/fixtures/harness.test.ts:1779` "the health rollup agrees with a
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
`test/api/mcp.test.ts:1487` "answers the counts and the caveat when the two
rulesets differ" and `test/api/mcp.test.ts:1552` "names every field it answers
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

`RULESET_VERSION` (0.9.0) stamps **judgement**: bump it when a rule's verdict or
copy changes. Adding a rule or a metric family adds rows without changing a
verdict — `metrics` rows carry no version column at all — which is the argument
Phase 10 held 0.7.0 on.

**Phase 11 bumped to 0.8.0, once.** Two things in the phase each require it on
the rule's own terms: six rules writing verdicts a page or a site could not
receive before, and `site.health`'s re-filing with the copy change that came
with it (§6) — copy is what the rule names beside verdicts, so that change
would have earned the bump on its own. One number rather than two, because the
phase ships as one change and the version is what a consumer compares crawls by
(§7.2): two stamps inside it would make `crawl_compare` raise
`ruleset-mismatch` between crawls that differ by nothing a consumer cares
about.

**Phase 12 bumped to 0.9.0, once, on two grounds.** First, a FINDING a crawl
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
Phase 11.

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
findings BEFORE the header", `test/api/http.test.ts:1412` "tears the response
when a CSV export fails mid-stream, rather than truncating the file";
`test/api/mcp.test.ts:705` "describes the shape of the CSV it writes, not just
that it writes one" and `test/api/mcp.test.ts:2209` "streams the resources view
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
- `urlsWithCritical` stays near-empty until a crawl renders a large share of its
  pages: two of the three `critical` rules judge only rendered pages, and the
  third fires outside the census (§6).
- No index on `crawls.site_url`: the site filter is a sequential scan — 1.1 ms
  over the 153 rows the dev table held when it was measured. **Do not read the
  dev table's row count as an operator's number**: it grew from 139 to 1,585
  across Phase 11 alone, and the growth is the SUITE, not a user — every full run
  leaves its fixture crawls behind (`127.0.0.1:<port>`, `runner.example`), **31
  rows a run**, against four real `lavishalice.com` crawls in the whole table.
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

# The Ariadne surface Talos codes against

**Status:** the contract as of Phase 28b (ruleset 0.25.1, migrations 0000–0044,
27 MCP tools / 27 HTTP routes; every column label in this document is served
under the ruleset version the engine reports — `rules_catalog`'s
`rulesetVersion`, which the metric-table pass moves).
`docs/talos-integration.md` says *why* the seam exists and what obligations bind
it; this document says *what the seam is*.

**What Phase 28b changed here (2026-11-11): crawls run on worker processes, and a
crawl's credentials survive a restart.** Ruleset **0.25.1** (`sitemap.invalid` now
judges an earlier, kept walk's failures), migrations 0038–0044, no tool or route added
(27 MCP tools / 27 HTTP routes); three operational endpoints, not tools, answer
before authentication. Gate evidence: `docs/gates/phase-28b.md`. The agent-facing
contract moves in these ways, none of them a new call:

- **A crawl start queues in the database and any worker claims it.** `api:serve` no
  longer runs crawls: it accepts and answers, and `worker:serve` processes claim the
  `crawl` jobs (`SELECT … FOR UPDATE SKIP LOCKED`). A crawl waits when its host is
  already being fetched by another crawl, whoever's it is (one site, one fetcher; hard
  rule 9), and when its tenant already has its cap of running crawls
  (`ARIADNE_TENANT_MAX_RUNNING`, default 1). **One tenant's long crawl therefore
  delays another tenant's crawl of the same host**, and nothing yet bounds a live host
  hold (an open item in the gate record).
- **`crawl_status.job` is `{kind, status, claimedBy?}` or null.** `kind` is `crawl`,
  `render` or `rules`; `status` is `queued | running | done | failed | abandoned`;
  `claimedBy` is the instance id once a runner has the job. It is the engine's
  bookkeeping behind `status` and never replaces it. A crawl no job ever ran has null.
- **`queuePosition` is tenant-scoped.** `0` means running (the crawl is starting), `1 + n`
  means n of the CALLER's tenant's queued crawls are ahead, and **null means not
  positioned**: a crawl that is not queued, a queued crawl with no live crawl job, a job
  another engine version's runner alone could claim (a rolling deploy), and a job pinned
  to an instance that is no longer live. It is an order among your own crawls, not a
  promise of when anything starts and not a view of anyone else's load.
- **`pauseReason` has five values**: `request | shutdown | worker_lost |
  credentials_unreadable | not_allowed`. `request` is an agent's `crawl_pause` and is
  never undone by the engine. `shutdown` is a worker told to stop (a deploy, SIGTERM);
  `worker_lost` is a worker that stopped heartbeating (a crash, `kill -9`, a lost
  host): the reaper pauses the crawl, releases its leases and abandons its job.
  `credentials_unreadable` is a runner that found the stored copy of the crawl's
  credentials unreadable before any request. `not_allowed` is a runner whose own
  allowlist no longer admits the crawl's `siteUrl`, `legacyHosts` or `sitemapUrls`.
- **System pauses resume by themselves, up to a cap.** For a crawl run by the worker
  pool, `shutdown` is always requeued (a graceful stop is a deploy, and spends nothing)
  and `worker_lost` is requeued up to **3 times in a row** (`crawls.auto_resume_count`,
  which only `worker_lost` spends and which an agent's `crawl_resume` resets to 0); a
  fourth stays `paused`/`worker_lost` for an agent. `request`, `credentials_unreadable`
  and `not_allowed` are never requeued. A crawl accepted by a LOCAL process (the stdio
  MCP server, the library) is never auto-requeued: if that process dies the crawl reads
  `queuePosition: null`, `crawl_mark_failed` works on it and `crawl_resume` adopts it
  (it runs on the process that resumed it).
- **Credentials are stored, encrypted.** The values of `requestHeaders`, `httpAuth` and
  `cookies` are kept as AES-256-GCM ciphertext in `crawl_credentials`, under a key the
  database never holds (`ARIADNE_CREDENTIALS_KEY`, on every process that accepts or runs
  crawls). A restart, a deploy, a crawl another process picks up and a render on a
  finished crawl all run with the stored copy, so Talos no longer re-sends them. They are
  deleted on `crawl_cancel`, on `crawl_delete`, when `crawl_config_set` removes the last
  kind, and 30 days after the crawl settles (`ARIADNE_CREDENTIALS_RETENTION_DAYS`).
  **`CREDENTIALS_REQUIRED` (409) now answers only when the stored copy is unreadable**:
  the key was rotated past it, retention removed it, or the row was tampered with. A
  QUEUED crawl in that state is paused `credentials_unreadable` by its runner, with no
  request sent; re-supply the values on `crawl_resume` (or `crawl_config_set` while it is
  paused) and it runs. Values still never reach a response, a log line, a metric or an
  export (the secret scan in the gate record). `crawl_resume` and `crawl_config_set`
  decrypt in the API process, only to check the copy is readable or to merge a partial
  patch; the values are discarded after the call.
- **`HOST_BUSY` (409).** A synchronous `crawl_render` refuses while another crawl's job
  (crawl or render) holds the same host key, which is the host plus its port when the URL
  names a non-default one. The sentence names the caller's crawl and that host only. It
  reveals that some crawl holds the host, never whose. Render and rules on one crawl now
  refuse each other (one live job per crawl), and `crawl_render` on a queued or running
  crawl answers 409 before it answers a 400 for a malformed `urls` list.
- **`crawl_delete`'s `rows` gains `crawl_credentials` and `jobs`.**
- **Three endpoints answer before the bearer and tenant checks**, listed in
  `PRE_AUTH_ROUTES` (`src/api/http.ts`) and in the tenant sentinel: `GET /healthz`
  (liveness, 200), `GET /readyz` (200 when the database is reachable and its migrations
  are the ones the code expects or more, since an older replica runs against a newer
  additive schema during a deploy; otherwise 503 with a FIXED reason such as "database
  unreachable" or "schema behind", never an error message) and `GET /metrics`
  (Prometheus; its own bearer, `ARIADNE_METRICS_TOKEN`, which must differ from the API
  token and opens nothing else; unset means 404, never served open). No metric label
  ever carries a tenant, crawl id, host or URL: the engine's own metrics use only
  `kind`, `status`, `fetch_class`, `role` and `outcome`, and the default Node process
  metrics add their own (`le`, `quantile`, `version`, `major`, `minor`, `patch`,
  `space`, `type`). A worker serves the same three on
  `ARIADNE_WORKER_HTTP_PORT`.
- **Environment.** API: `ARIADNE_API_TOKEN`, `ARIADNE_API_PORT`, `ARIADNE_API_HOST`,
  `ARIADNE_ALLOWED_DOMAINS`, `ARIADNE_CREDENTIALS_KEY` (required),
  `ARIADNE_CREDENTIALS_KEY_PREVIOUS`, `ARIADNE_CREDENTIALS_RETENTION_DAYS`,
  `ARIADNE_METRICS_TOKEN`, `ARIADNE_EXPORT_DIR`, `ARIADNE_RENDER_DIR`,
  `ARIADNE_GIT_SHA`. Worker (`npm run worker:serve`, run beside the API): `DATABASE_URL`,
  `ARIADNE_CREDENTIALS_KEY`, `ARIADNE_WORKER_HTTP_PORT` and `ARIADNE_ALLOWED_DOMAINS`
  required (**a worker re-checks every crawl it claims against its OWN allowlist**, so a
  host removed from it pauses the crawl `not_allowed` before any fetch; an empty list
  refuses every crawl); `ARIADNE_WORKER_CONCURRENCY` (default 1),
  `ARIADNE_TENANT_MAX_RUNNING` (default 1), `ARIADNE_METRICS_TOKEN`,
  `ARIADNE_CREDENTIALS_KEY_PREVIOUS`, `ARIADNE_CREDENTIALS_RETENTION_DAYS` optional.
  Local stdio MCP needs `ARIADNE_TENANT` and `ARIADNE_CREDENTIALS_KEY`; the demo and the
  prune script need `ARIADNE_CREDENTIALS_KEY` too. Process trust (`allowPrivate`) is
  still code-only and no variable reaches it.
- **Pinned** by `test/worker/runner.test.ts`, `test/worker/reaper.test.ts`,
  `test/worker/serve.test.ts`, `test/api/credential-vault.test.ts`,
  `test/api/credentials-restart.test.ts`, `test/ops/health.test.ts`,
  `test/ops/metrics.test.ts` and `test/api/tenant-isolation.test.ts`.
- **Not in 28b**: rendered documents stay synchronous in the API process, which keeps
  writing them as today; the rule that a worker keeps no documents arrives with 28c's
  unattended render chains (`docs/gates/phase-28b.md`, deviation 2).

**What Phase 28a changed here (2026-11-11): every request names its tenant. Talos must
send the header before it upgrades.** No tool or route is added (27 / 27) and the
ruleset is unchanged; migration 0037 adds `crawls.tenant_id`. The gate evidence is
`docs/gates/phase-28a.md`.

- **HTTP needs a second header.** Every request carries `Authorization: Bearer <token>`
  AND `X-Ariadne-Tenant: <tenant>`, and a caller that sends only the bearer is refused.
  The order is bearer (401), then tenant (400 `TENANT_REQUIRED` for a missing or empty
  header, 400 `INVALID_TENANT` for a value that is not `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`),
  then routing. The value is opaque and case-sensitive; Talos sends its user id as a
  string. An error never quotes the value. Stdio MCP reads `ARIADNE_TENANT` once at boot
  and refuses to start without it (there is no default).
- **A foreign crawl is a missing crawl.** Every crawl-facing route and tool resolves the
  crawl by (id, tenant). Another tenant's crawl answers 404 `NOT_FOUND`, `no such crawl
  '<id>'`, byte for byte what an id that never existed answers, including while that
  crawl is busy, and `crawl_compare` / `compare_urls` never name the other site's host.
  `crawl_list` lists only the caller's crawls; `crawl_start` creates for the caller.
  `config_schema`, `config_validate` and the no-`crawlId` form of `rules_catalog` are
  global. `queuePosition` (since 28b) counts only the caller's own queued crawls ahead:
  another tenant's backlog is never visible in it.
- **Exports sit under the tenant.** `export_crawl` writes `<exportDir>/<tenant>/…`, and
  `crawl_delete` looks there. Exports written before 28a at `<exportDir>/<file>` are no
  longer found: the operator moves them once (`mkdir -p <exportDir>/local && mv
  <exportDir>/<crawl files> <exportDir>/local/`).
- **Pinned** by `test/api/tenant-isolation.test.ts`, which enumerates every route and tool
  and fails on one that is neither scoped nor on the global list, and by
  `test/api/tenancy.test.ts`.
- Two 27d carries landed with it: a sitemap re-walk on resume clears its memberships and
  hreflang staging only when a walk replaces them
  (`test/crawl/loop-resume-staging.test.ts`), and a programmer error in `fetchPage` is
  never hidden by an abort (`test/crawl/fetch-page.test.ts`).

**What Phase 27c changed here: a crawl can be a list, it can be fenced by URL
patterns, and it can carry credentials.** Ruleset 0.24.0, 189 rules (72 page / 103
query / 14 metric), one new marker. Migration 0036: the `list_urls` table (a list
crawl's URLs, keyed `(crawl_id, position)`, removed by `crawl_delete` with the rest),
`frontier.redirect_hops`, `crawls.excluded_dropped` and `crawls.scope_changed_at`. No
tool or route is added (27 / 27); every change is a new field, value or refusal on an
existing one. The gate evidence is `docs/gates/phase-27c.md`.

**What Phase 27d changed here: nothing new to call, a good deal to know.** Ruleset
0.25.0, no migration, still 27 tools / 27 routes. The gate evidence is
`docs/gates/phase-27d.md`.

- **A slow sitemap is waited for, and a stop is honoured.** A sitemap document gets
  60 s for its headers, 30 s of silence mid-body and 120 s in total across every
  redirect hop; the whole walk is capped at 10 min. A walk the cap cut records
  `discovery.truncation.timeLimited`. A pause or cancel lands within about a second
  (bound 2 s) in the host probe, the sitemap walk, the post-discovery seeding, the
  known-404 probe, the recheck pass and the resource pass, a third-party host's
  robots.txt read included (§4.1c).
- **`hreflang.declarations-incomplete` has two new causes**, `timeLimited` and
  `interrupted` (a resumed crawl whose sitemap re-walk was cut by any exit), each an
  evidence key, a column and a sentence (the Phase 26c block below, and "Sitemap timing" there).
- **An unknown key is named by position, never quoted**, on every route, every query
  string and every tool: "key N in the order sent", the rest counted, a "did you
  mean" where one name is close (§4.1).
- **`notMeasured` is `[{id, reason}]` everywhere** it is carried (§4.3), and the
  `crawl_overview` `urls` section gains two "Excluded by scope" entries on a crawl
  that has `exclude` or `include` (§4.3b).
- **Two 27c known limits are gone**: a `crawl_config_set` on a queued crawl can no
  longer hand its runner the new credential shape with the old values, and
  `crawl_overview` now counts the `excluded` rows (§13).
- `performance.slow-response` now maps to Screaming Frog's `PageSpeed: Document
  Request Latency`. `scripts/prune-test-crawls.ts` removes test-host crawls from a
  development database (dry run by default; an operator tool, not part of the surface); `--confirm` refuses while any other session is connected to the database.
- **Nine `crawl_start` fields** (§4.1), all in `config_schema` with their bounds:

  | field | default | bounds | mutability | secret |
  |---|---|---|---|---|
  | `mode` | `spider` | `spider` \| `list` | `never` | |
  | `urls` | — | 1–10,000 URLs; `mode: "list"` only, and required there | `never` | |
  | `exclude` | `[]` | up to 100 patterns of up to 512 characters | `whenPaused` | |
  | `include` | `[]` | as `exclude` | `whenPaused` | |
  | `requestHeaders` | — | up to 20 `{name: value}`; a value at most 1,024 bytes | `whenPaused` | yes |
  | `httpAuth` | — | `{username, password}`, Basic, each at most 1,024 bytes | `whenPaused` | yes |
  | `cookies` | — | up to 50 `{name, value}`, sent as one `Cookie` header | `whenPaused` | yes |
  | `maxRedirectHops` | 10 | integer 1–20 | `whenPaused` | |
  | `maxUrlLength` | 2,500 | integer 256–2,500 | `never` | |

  The three secret fields carry `x-ariadne-secret: true` in the published schema.
- **List mode** (`mode: "list"`, `urls`). The crawl fetches exactly the listed URLs at
  depth 0 (`discoveredVia: "list"`), follows each one's redirects to a classified row
  within `maxRedirectHops`, records links without following them, reads robots.txt
  and obeys it, and reads no sitemap unless `sitemapUrls` is given (given, it walks
  the sitemaps robots.txt declares as well as the named ones, and queues none of
  their entries; `sitemapUrls: []` on a list crawl is refused as a contradiction).
  "Exactly the listed URLs" is the page crawl: the crawl also runs the host probe
  (the site root on up to four spellings, Ruling 2 of the 27c gate; `probeHosts:
  false` turns it off) and the known-404 probe (one random path), and the 5xx
  recheck, the resource pass and the render pass run as configured.
  Each listed URL is normalised, passes the URL policy at the crawl's
  `maxUrlLength`, must be in `siteUrl`'s site
  family (`isSameOrigin`: its host or the `www`/apex twin, `http` or `https`) and must
  pass `exclude`/`include`; a list spanning sites is refused, not split. The allowlist
  is checked on `siteUrl`, not on each listed URL: the list's boundary is the one a
  spider crawl of the same seed already has (it fetches the `www` twin too). Two
  spellings of one URL are collapsed and counted: the accepted answer and
  `config_validate`'s `effective` carry `listUrlCount` (distinct) and
  `listDuplicates`; the URLs themselves are never echoed back. `maxPages` defaults to
  twice the distinct list (room for one redirect target each), and an explicit value
  below the list is refused. The resource and render passes work as in spider mode.
- **`crawl.list-mode`** (info, CHECK-83, a NOT MEASURED marker) fires on every list
  crawl and on no spider crawl, one site finding with `{notMeasured,
  partiallyMeasured, sitemapsRead}`. Rules that need the whole site (`needsSpider`,
  18: the link graph, click depth, orphans, sitemap coverage, unlinked canonical and
  hreflang targets) do not run on a list crawl, and those that need a sitemap read
  (`needsSitemaps`, 13) do not run when none was read; `notMeasured` names every one
  of them. `partiallyMeasured` names the 11 `listPartial` rules (broken and 5xx link
  targets, canonical, hreflang and pagination targets): they run, but judge only the
  targets the list fetched, so their silence about any other URL is not a clean
  result. `links.broken-internal` also reports a listed URL that answered 4xx with no
  inlink (`inlinks: 0`, the optional column `listed`), which no other rule would.
- **Scope** (`exclude`, `include`). A pattern matches the whole normalised URL, `*`
  is any run of characters and nothing else is special, and the match is
  linear-time (no regular expressions). Exclude wins; a non-empty `include` refuses
  what matches none. Checked at admission for every link, sitemap entry and redirect
  target, after the URL policy and before robots. A refused URL is a `pages` row of
  the new fetch class **`excluded`** (`indexabilityStatus` `Excluded by crawl
  settings`), never fetched, whose `fetchReason` is `crawl scope: matches exclude
  pattern '<p>'` or `crawl scope: matches no include pattern`. A URL longer than a
  `maxUrlLength` below 2,500 is an `excluded` row too, reason `crawl scope: longer
  than maxUrlLength (<n> characters; the limit is <limit>)`. `excluded` rows share
  the robots-blocked budget (`maxBlockedUrls`, default `maxPages`); past it they are
  counted in `crawl_status.excludedDropped` (§4.2). A refused sitemap entry is
  skipped, not written. Every rule treats an `excluded` row as it treats a
  `disallowed` one (not judged, not a broken link), and the rules that report a
  sitemap, pagination or hreflang URL as "not crawled" leave out the same-origin
  URLs the crawl's current scope refuses. Refused at start and by
  `crawl_config_set`, as a pattern that could never match: one with no leading `*`
  whose literal start is not `http://` or `https://` (`/cart*`: **a path rule needs
  its leading `*`**, `*/cart*`), one whose host is not the site's, and one naming a
  scheme admission never admits for the site (`http://…` on an `https` site; the
  check asks `isSameOrigin(<pattern origin>, siteUrl)`, the one direction admission
  asks). Refused at start: a seed the scope refuses, and a listed URL the scope
  refuses.
- **Scope changes while paused.** `crawl_config_set` takes `exclude`/`include` on a
  queued or paused crawl and stamps `scopeChangedAt`. The next run re-files before
  its first lease, both ways: pending URLs the new lists refuse become `excluded`
  rows (past the budget, counted in `excludedDropped`), and `excluded` rows the new
  lists admit go back to the frontier within the `maxPages` room (beyond it the row
  is deleted and `crawls.frontier_capped` is stamped, which `links.orphan-skipped`
  reads as a capped crawl). Pages already fetched stay.
- **Credentials** (`requestHeaders`, `httpAuth`, `cookies`), §4.1 and §4.1a. Sent
  only to the site family, robots.txt and sitemaps included, and never to another
  host (a CDN resource, a cross-host redirect hop, the render pass's third-party
  requests); an `https` site never sends them over `http`, while an `http`-only site
  sends them on its own `http` URLs. Refused header names: `host`, `user-agent`,
  `accept`, `accept-encoding`, `content-length`, `connection`, `transfer-encoding`,
  `te`, `upgrade`, `expect`, `keep-alive`, `cookie` (use `cookies`), `authorization`
  (use `httpAuth`), and any name starting `proxy-` or `sec-` (the Fetch standard's
  forbidden prefixes; `sec-*` names such as `sec-ch-ua` are the browser's own) — 13
  names and two prefixes. A refusal names a header or cookie name that is an HTTP
  token; one that is not, and an unknown key, it names by position only
  (`requestHeaders entry 2`, `cookies[0].name`, `httpAuth has an unknown field (key
  3 in the order sent; …)`), so a value pasted into a name is never echoed. `Set-Cookie` from
  the site is ignored. **Their values were held only in this server's memory in 27c;
  since Phase 28b they are stored encrypted** (the Phase 28b summary above): never in
  `config_jsonb`, a log line, an error, a metric or a response, and deleted on
  `crawl_cancel` and `crawl_delete`. What `config_jsonb` holds is which kinds were given
  and the header and cookie names, shown by `crawl_config_get` with every value
  `"[redacted]"` (§4.9). **When the stored copy is unreadable** (key rotated past it,
  retention expired, tampering; formerly after every restart) a crawl that needs them is
  refused by `crawl_resume` and `crawl_render` with **`CREDENTIALS_REQUIRED` (409)** until
  they are sent again on that call, of exactly the stored kinds and names; a crawl that
  needed them never runs without them. `crawl_config_set` takes them too while the crawl is queued or
  paused, and a patch that replaces one kind after a restart must send the other
  kinds the crawl needs in the same call, or it is `CREDENTIALS_REQUIRED` as well.
  Credentials cannot be added on `crawl_resume` or `crawl_render` to a crawl that
  started without any (400, pointing at `crawl_config_set` while paused), so a
  finished crawl that ran without them cannot be rendered with them. `httpAuth:
  null` in `crawl_config_set` removes Basic auth, as an empty `requestHeaders` or
  `cookies` removes that kind. They cannot change the user agent, the delay floor
  or robots. A gated URL fetched without its credential is the classified row the
  site answered: a 401 or 403 is `blocked`, retried under back-off like any other
  refusal.
- **`maxRedirectHops`**: a chain longer than the cap ends on the last hop fetched,
  whose `fetchReason` says `redirect not followed: this URL is <n> redirects into its
  chain and maxRedirectHops is <cap>`; the next target is not fetched.
- **Every refusal body gains `code`** (§1): `{error, code}` over HTTP and the same
  two keys in MCP's JSON error, `code` one of `VALIDATION`, `FORBIDDEN`,
  `NOT_FOUND`, `CONFLICT`, `CREDENTIALS_REQUIRED`. Additive.
- **A 1 MiB body cap on five routes**: `POST /crawls`, `POST /config/validate`,
  `POST /crawls/:id/resume`, `POST /crawls/:id/render` and `PATCH
  /crawls/:id/config` (a 10,000-URL list, or a maximal credential set of about 74
  KB re-supplied after a restart). Every other route keeps 64 KiB. Over the cap is a
  413.
- **`crawl_config_get.crawl` gains** `listUrlCount` and `listDuplicates` (a list
  crawl), the three credential fields redacted, and `scopeChangedAt` on every crawl.
  It no longer equals `config_validate`'s `effective` for a crawl with credentials
  (§4.9).

**What Phase 27b changed here: a crawl can be paused, cancelled and deleted, and
the crawl's own settings have one schema.** Migrations 0034 (`crawls.control_request`,
`pause_reason`, `cancelled_at`) and 0035 (every crawl a shutdown had closed
`cancelled` becomes `paused`/`shutdown`). No rule moves. Five tools and five routes
are new, and the command tools are nine (§10):
- **`crawl_pause`, `crawl_cancel`, `crawl_delete`** (§4.1c): the control table, the
  200/202 rule, and the confirm echo on a delete. Two statuses are new, `paused`
  (resumable) and `cancelled` (final), so a crawl is `queued | running | paused |
  finished | failed | cancelled`. A server shutdown is a pause (`pauseReason:
  "shutdown"`), no longer a `cancelled`.
- **`config_schema` and `config_validate`** (§4.1b): the `crawl_start` body as JSON
  Schema, and a dry run of it. One zod schema serves both transports, so a body
  that fits one fits the other.
- **`crawl_config_get` / `crawl_config_set` cover the crawl's own fields** (§4.9):
  `{crawl, judgement}`, with a per-field `mutability`; pacing and budgets change
  only while the crawl is queued or paused.
- **`crawl_status` gains `controlRequested`, `pauseReason`, `cancelledAt` and
  `neverFetched`** (§4.2).

**What Phase 27a changed here: every finding rule has a type and a priority, a
crawl has a judgement an agent can change, and two overviews.** Ruleset 0.23.0,
migrations 0031 (the nullable `crawls.judgement_jsonb` and
`crawls.rules_judged_with_jsonb`), 0032 (it backfills the run stamp on every
crawl already judged) and 0033 (it rewrites every stamp's thresholds to the
effective values its run used). No rule is added, removed or re-worded at the defaults;
no finding moves. Four tools and four routes are new:
- **`type` and `priority` beside `severity`.** Every page and query rule (174 of
  the 188) carries `type` (`issue` | `warning` | `opportunity`) and `priority`
  (`high` | `medium` | `low`): the rule's DEFAULT reading of what a finding is
  and what fixing it is worth, referenced against Screaming Frog's Issue Type and
  Issue Priority where a rule maps to an SF issue (`docs/gates/phase-27a.md` lists
  every divergence). Metric rules have neither. NOT MEASURED markers are always
  `warning` / `low`. Neither is stored per finding: both are joined from the
  registry, plus the crawl's overrides, when a surface reads them. They appear
  on `issues_list` (§4.3), `issues_overview` (§4.3a), `rules_catalog` (§5.1),
  the `issues` CSV view (§12) and every row of the `issues` JSONL dataset
  (`export_crawl`, the same reading as the CSV view's columns).
- **The judgement block** (`crawl_config_get` / `crawl_config_set`, §4.9, and
  `crawl_start`'s `judgement` argument, §4.1): per crawl, an agent can disable,
  retype or reprioritise a rule, override 20 allowlisted thresholds, and set
  `findingCap`. Rule overrides act on what is READ, at once: a disabled rule's
  findings stay stored and leave every findings listing, CSV view and export,
  each of which names it in `disabledRules`. Thresholds and `findingCap` change
  what a rules run PRODUCES, so they act at the next `crawl_rules`. Severity is
  never overridable.
- **`judgementStale`** (`{stale, reasons}`, reasons `overrides` | `thresholds` |
  `findingCap`) rides `crawl_status`, `issues_list`, `issues_overview`,
  `crawl_overview`, `metrics_get`, `metric_table`, `rules_catalog` (with a crawl
  id) and `crawl_config_get`. It is true when the crawl's judgement differs from
  the one its last rules run used (the stamp). Retyping and reprioritising are
  not part of it, because they change nothing stored.
- **Issue copy follows the stamp.** A title, explanation or fix that names a
  threshold quotes the value the crawl's findings were judged with: after a
  `SLOW_MS` override of 500 and a re-run, `performance.slow-response` reads
  "Response time over 500 ms". At the defaults every entry is byte for byte the
  0.22.0 text.
- **Two overviews:** `issues_overview` (§4.3a: one row per rule, Screaming
  Frog's Issues tab with our axes) and `crawl_overview` (§4.3b: sectioned counts
  that describe the crawl), each also a CSV view (§12).
- **More 409s, each repairable.** A crawl whose STORED judgement overrides a rule
  the current ruleset does not define is refused with 409 on every surface that
  reads the judgement (`crawl_status`, `crawl_config_get`, `issues_list`, the two
  overviews, `issue_urls`, `issue_inlinks`, `metrics_get`, `metric_table`,
  `rules_catalog` with a crawl id, `crawl_compare`, the `issues` JSONL dataset
  and the `issues`, `issue_urls` and two overview CSV views), naming the rule; `crawl_config_set` with `{judgement: {rules: {<id>: null}}}` is the repair, and is
  the one surface that accepts the crawl in that state. `issue_urls` and
  `issue_inlinks` of a disabled rule are a 409 too (§4.4).
- `crawl_compare` gains the caveat code `judgement-overrides` (§7.2).

**What Phase 26c changed here: six rule ids, every hreflang source, one CSV
column, and a re-crawl.** Ruleset 0.22.0, migration 0029 (the nullable
`links.name_hint` / `name_hint_source`, `resources.share_image`,
`pages.overlong_urls`, and the tables `sitemap_memberships` and
`sitemap_hreflang`) and migration 0030 (it backfills `resources.share_image` on
older crawls), extraction version 3. No tool, route or response field is added;
the one addition is the `shareImage` column on the `resources` CSV view (§12).
`rules_catalog` now answers 188 rows (72 page, 102 query, 14 metric; 16 of them
markers), and the finding rules split 33 critical / 66 warning / 75 info (89
info counting the fourteen metric rules). The new ids:
- `url.reference-too-long` (warning, CHECK-28, category `url`): the page
  carries a link, file or hreflang target whose address is over 2,500
  characters, too long to index. Such an address is counted, not stored, so it
  is in no `links`, `resources` or `hreflang` row; the evidence is the counts
  `{links, resources, hreflang, max}`. A supplied or redirected-to URL that long
  is refused before any fetch with the reason `too_long`.
- `social.image-insecure` (info, CHECK-87): an `https:` page whose `og:image` is
  `http:` and whose `og:image:secure_url` is absent or not `https:`. No browser
  loads a share image, so this is a share-preview finding, not mixed content.
- `sitemap.oversized` (warning, CHECK-08): a sitemap over the protocol's 50 MB
  uncompressed. The URLs read before the limit are kept and crawled; the
  finding names the document with `{sitemapUrl, bytesRead, urlsKept, max}`,
  and `sitemap.invalid` no longer reports it.
- `sitemap.url-in-multiple` (info, CHECK-08): a URL listed in more than one
  sitemap document (`{url, sitemaps, count}`; a repeat inside one document is
  not a second listing). It is crawled once.
- `hreflang.source-conflict` (warning, CHECK-24): one language code whose
  target differs between two of a page's sources (`{code, bySource,
  conflictingCodes, onlyIn, onlyInTruncated?}`). A code one source lists and
  another omits is not a conflict, because search engines union the sources;
  those codes are listed under `onlyIn`.
- `hreflang.declarations-incomplete` (info, CHECK-24, a NOT MEASURED marker;
  added in the PR #24 review): hreflang declarations this crawl did not read in
  full. One site finding, `{reason, hreflangLimited, entryLimited, docLimited,
  depthLimited, timeLimited, interrupted, sitemapDocsFailed, sitemapDocsOversized,
  alternatesCapped, possiblyCappedPages}`; `reason` is a sentence per trigger that
  fired, and names nothing that did not. When the sitemap walk was cut short (a
  staging, entry, document or depth limit, the walk's time budget (`timeLimited`,
  Phase 27d), a resumed crawl's re-walk cut by a stop or a failure (`interrupted`,
  Phase 27d), or a sitemap over 50 MB),
  `hreflang.missing-return-link`, `hreflang.missing-self-reference`,
  `hreflang.missing-x-default` and `hreflang.self-only` answer nothing on that
  crawl and this marker speaks for them; a sitemap that could not be read, or a
  sitemap `<url>` with alternates past 200 (`alternatesCapped`), fires it
  without silencing them. A page whose declarations may have filled the
  200-pair cap in one source — stored HTML or header rows plus its over-long
  hreflang targets, or 200 staged sitemap alternates — (`possiblyCappedPages`,
  on any crawl, any status) is never judged by those rules as missing a
  self-reference, x-default or alternate, nor reported as not returning a link.
  The nine keys after `reason` are `null` on a crawl from before Phase 26c; since
  27d, `timeLimited` and `interrupted` read `false` on a crawl whose evidence predates
  them. The marker's finding table (`issue_urls`, the CSV) gains the columns
  `Sitemap Time Limit Reached` and `Sitemap Walk Interrupted`.

  **Sitemap timing (Phase 27d).** A sitemap document is given 60 s to send its
  headers, 30 s of silence between body chunks (a stall, not a slow transfer), and 120 s
  in total counted across every redirect hop (`SITEMAP_TIMING`); time spent flushing
  the entries already read does not count against it. The whole walk has a 10 min
  budget (`DISCOVERY_WALK_BUDGET_MS`). `robots.txt` keeps its own 20 s
  (`ROBOTS_TIMING`). A document that fails says which limit in its `reason`, in the
  `sitemap.structure` `Failures` column and the sitemap findings that read it: `no
  headers within 60 s`, `no data for 30 s` or `over 120 s in total` (before 27d every
  one read "timed out"; Hurtigruten's cold sitemaps take about 33 s). A walk the
  budget cut records `discovery_jsonb.truncation.timeLimited: true`: the entries read so
  far are kept and the unread documents are cut short, not failed, so they are in no
  `Failures` row. A pause or cancel during the walk is not a failure and not
  `timeLimited`; it drops what the walk learned, and a resume re-walks.
  `interrupted` marks the one case where a re-walk's evidence is stale: a resumed
  crawl cleared its staged sitemap rows, and then any exit (stop, failed poll, error,
  or the process dying) came before the walk's evidence was rewritten. The mark is
  written before the rows are cleared, so no exit can skip it. The next completed walk
  rewrites the evidence and clears it.

What changed under existing ids. **Hreflang is read from all three sources**: the
page's HTML, its HTTP `Link` header (read whole at fetch, on every classified
response) and the `xhtml:link` alternates of its sitemap entry. Every hreflang
rule judges the union of a declaring page's sources, and judges a declaring page
only when it was fetched OK as HTML with a 200. A `Link` header on a non-HTML
response (a PDF) is recorded, `source = 'header'`, and counts as that file's
return link when an HTML page names it; the file's own declaration set is not
judged, so a PDF's missing self-reference, invalid code or source conflict is no
finding (a known limit, not a pass). The eight that list a declaration carry
`sources` in their evidence (`html`, `header`, `sitemap`); `hreflang.multiple-entries` counts targets within
ONE source, so a disagreement between sources is `source-conflict`'s finding and
never both. **Sitemaps are streamed** to the 50 MB limit (a 10–50 MB sitemap was
dropped before and is read whole now), and every listing is recorded:
`sitemap.over-50k-urls` is now an exact count, and `sitemap.structure` gains
`totalMemberships`, `docCountsExact`, `membershipLimited`, `hreflangLimited`,
`overlongLocsSkipped` and `alternatesCapped` (sitemap alternates past 200 in one
`<url>`, read and not recorded) on its site row. `sitemap.url-too-long` adds one site
finding `{skipped, max}` counting the sitemap addresses that were never stored:
`<loc>`s and alternate targets over 2,500 characters, and listings whose URL and
sitemap URL together are over that. `social.image-broken` gains the problem `too-long`. The two links rules
read a link's wider name ("Links" under Phase 26b below).

**The re-crawl.** `url.reference-too-long`, `social.image-insecure`,
`hreflang.source-conflict`, `links.no-anchor-text` and `links.aria-label-only` read
facts recorded from extraction version 3; `sitemap.oversized`,
`sitemap.url-in-multiple`, `sitemap.over-50k-urls` and `source-conflict` read the
sitemap facts a 26c discovery records. On a crawl without either, the marker
`extraction.not-recorded` fires once with `requiredVersion: 3` and
`sitemapFactsRecorded`, and those rules are silent (it now claims CHECK-08 and
CHECK-28 as well). A crawl judged before 0.22.0 and re-judged gains that marker,
not clean results (§11).

**What Phase 26b changed here: twenty-eight rule ids, which need a re-crawl.**
Ruleset 0.21.0, migrations 0026, 0027 and 0028 (fifteen nullable `pages` columns, four
of them widened to integer by 0027, and the nullable `links.aria_label` from 0028), and
no tool, route or field added. The ids arrive
through the listings that already exist, as Phase 26a's did, each with its own copy
and `columns`. `rules_catalog` now answers 182 rows (70 page, 98 query, 14 metric; 15
of them markers), and the finding rules split 33 critical / 63 warning / 72 info (86
info counting the fourteen metric rules). The owner calls of 2026-11-07, made on the
unreleased 0.21.0, account for two of the ids and one severity: see "Links" and
"Document structure" below. Unlike 26a's rules, these read page facts
the crawler records only from this phase on (extraction version 2), so `crawl_rules`
over an older crawl does NOT produce them. On any crawl with a page written before the
change, the NOT MEASURED marker `extraction.not-recorded` (info, the fifteenth marker)
fires once with `pagesNotRecorded` and `pagesRecorded`, and the 24 rules it covers are
silent; a re-crawl is the remedy (§11). Three rules read columns every crawl has
(`title.same-as-h1`, `h2.missing`, `social.og-duplicate`) and judge old crawls too.
By family:
- **Social sharing tags** (CHECK-87, new): `social.og-incomplete`,
  `social.x-incomplete`, `social.og-multiple`, `social.og-url-mismatch` and
  `social.og-duplicate` (info), and `social.image-broken` (warning). A share image
  is stored as a `resources` row with no page reference, because no page loads it: it
  is counted in `crawl_status.resources` and listed on the `resources` CSV view with
  `shareImage` `true` and `referencingPages` 0, and it never counts toward page weight, mixed content or
  `resources.broken`. On a `fetchResources: false` crawl `social.image-broken` judges
  only relative or malformed addresses and `resources.not-fetched` speaks for the rest.
- **Headings and titles** (CHECK-35, CHECK-36, CHECK-37): `title.multiple` and
  `meta-description.multiple` (warning), `title.same-as-h1`, `h2.missing`,
  `h2.too-long` and `h2.duplicate` (info).
- **Directives, refresh and language** (CHECK-04, CHECK-10, CHECK-25):
  `directives.bot-conflict` and `redirect.meta-refresh` (warning),
  `hreflang.html-lang-mismatch` (info; primary language subtag only, `x-default`
  never compared). On a re-crawled page the stored robots value joins EVERY
  `<meta name="robots">`, so a `noindex` in a second robots meta now makes the page
  non-indexable for every rule and for `pages_query`'s `indexable`.
- **Links** (CHECK-34, CHECK-86): `links.uncrawlable` and `links.no-anchor-text`
  (warning; an internal link with no text, no image alt and no `aria-label`: nothing
  names it), `links.empty-href`, `links.unsafe-target-blank` (a `target=_blank` link
  to ANOTHER origin, a subdomain or `www.` variant included, without `noopener` or
  `noreferrer`; same-origin links are not counted) and `links.aria-label-only` (info;
  an internal link with an empty anchor named only by its `aria-label`). A stored
  anchor now includes the alt of an image inside the link, and each link row records
  its trimmed `aria-label` (never folded into the anchor). Phase 26c (ruleset 0.22.0,
  migration 0029, extraction version 3) widens both: a link row with no anchor text
  and no `aria-label` records a wider name in `links.name_hint` /
  `name_hint_source` (its `aria-labelledby` id list, unresolved; else an `aria-label`
  inside it; else an icon's `<svg><title>`; else its `title`), so
  `links.no-anchor-text` needs that absent too, and `links.aria-label-only`, now
  titled "Links: Named Only by Attributes", fires on either and carries
  `names: {source, value}[]` in place of `labels`. Both need extraction version 3:
  on an older crawl `extraction.not-recorded` speaks and they are silent.
- **Forms, images and pagination** (CHECK-85, CHECK-49, CHECK-22):
  `security.form-insecure` (warning; CHECK-85's title widens to "Mixed content and
  insecure forms"), `images.empty-alt`, `images.alt-too-long` (over 100 characters)
  and `pagination.multiple` (info). `security.mixed-content` also counts `http:`
  iframes and media on a re-crawled page and gains optional `byKind` evidence;
  `images.missing-alt` gains an optional `sample`.
- **Document structure** (CHECK-18, CHECK-04, CHECK-24, and CHECK-88, new):
  `html.head-closed-early` (warning; the element or text that ended the head while
  head tags followed, with those tags in `lost`), `html.head-closed-early-harmless`
  (info; the same early close with no head tag after it, such as a tracking pixel's
  `<noscript><img>` last in the head) and `html.structure-invalid` (info; not exactly
  one `<head>` and one `<body>` tag, or the head after the body). A page that leaves out the
  optional `<head>`/`<body>` tags is valid HTML and is still listed, and the copy
  says so rather than calling it broken. `head.directives-outside-head` and
  `head.tags-outside-head` gain optional `headClosedEarly` evidence, present when an
  early close lost head tags. A version-2 crawl written before the owner calls of
  2026-11-07 has early closes with no `lost` list; the four rules that read it fail
  loudly on such a row and ask for a re-crawl.

Two engine changes ride with it and are visible in served values. Every string the
crawler stores from a page, and the site text a crawl row keeps (robots.txt), is made
storable first (`src/crawl/storable-text.ts`): a U+0000 is served as U+2400 (`␀`) and
a lone surrogate as U+FFFD, where before the page's insert failed and the crawl with
it. A JSON-LD block nested deeper than 64 levels is counted as a parse error rather
than stored.

**What Phase 26a changed here: forty rule ids, and nothing else.** Ruleset
0.20.0, no migration, no tool, route or field added. The new ids arrive through
the listings that already exist — `issues_list`, `issue_urls`, `rules_catalog`,
`crawl_compare` and the CSV `issues` view — each with its own copy and `columns`,
so a client that renders those generically needs no change. `rules_catalog` now
answers 154 rows (49 page, 91 query, 14 metric; 14 of them markers), and the
finding rules split 33 critical / 54 warning / 53 info. Every new rule reads
columns the crawl already stored, so `crawl_rules` over an existing crawl
produces them without a re-crawl (§11). By family:
- **Security** (CHECK-84, CHECK-14, CHECK-85): `security.hsts-missing`
  (warning), `security.headers-missing` (info; the Missing Headers column names
  which), `security.http-url` (warning, `category` `host`) and
  `security.mixed-content` (warning). All four need a site crawled over HTTPS:
  `security.http-url` reports its HTTPS pages that link to an `http:` URL on the
  site's own host, and the other three judge its HTTPS pages' headers and
  resources. The two header
  rules read the response headers Phase 25 stores, so on a crawl any of whose
  pages predates migration 0025 they write nothing and the NOT MEASURED marker
  `security.headers-not-recorded` (info) fires instead — the fourteenth marker
  (§5.1).
- **Served types** (CHECK-51): `resources.bad-content-type` (info), a stylesheet,
  script or image answering 200 with a type that contradicts it. It reads the
  resource pass, so on a `fetchResources: false` crawl it is silent and
  `resources.not-fetched` says why (§5.3).
- **Directives** (CHECK-04): `indexability.nofollow`, `directives.restrictive`
  and `directives.unavailable-after` (all warning). An `unavailable_after` date is
  judged against the page's own fetch time, so a re-judge gives the same answer.
- **Canonicals** (CHECK-16, CHECK-17, CHECK-19): `canonical.relative` (info),
  `canonical.fragment` (warning), `canonical.chain` (warning; a revisit is
  reported as `loop`) and `canonical.unlinked` (info).
- **Hreflang** (CHECK-24): `hreflang.inconsistent-return-code` and
  `hreflang.multiple-entries` (warning), `hreflang.self-only` and
  `hreflang.unlinked-target` (info).
- **Pagination** (CHECK-22, CHECK-23): `pagination.non-indexable-target` and
  `pagination.loop` (warning), `pagination.sequence-error` (info).
- **Links** (CHECK-32, CHECK-33, CHECK-86): `links.internal-nofollow`,
  `links.only-from-non-indexable` and `links.localhost` (warning),
  `links.non-descriptive-anchor` and `links.high-outlinks` (info). `links.localhost`
  judges external links only, so a site crawled on a private address does not report
  itself. The outlink limits are 1,000 distinct internal or 10 distinct external
  targets.
- **URL shape** (CHECK-30, CHECK-67), on the path of the page's own URL:
  `url.uppercase`, `url.underscores` and `url.non-ascii` (info), `url.spaces`,
  `url.multiple-slashes` and `url.repetitive-path` (warning), and
  `url.internal-search` (warning, an indexable internal search result).
- **Sitemap entries** (CHECK-07, CHECK-08): `sitemap.over-50k-urls` (warning; the
  count was a lower bound at 0.20.0, because a URL listed in two documents was
  stored once, and is exact from 0.22.0 on a crawl that recorded its listings),
  `sitemap.url-too-long` (info), `sitemap.cross-host-loc` (warning; silent for a
  document on another host that lists the crawled site's own URLs, a cross-submission)
  and `sitemap.lastmod-invalid` (info; `future` means dated after the crawl ended, so
  already in the future when the sitemap was read, and a value stamped while the
  crawl ran is not judged).
  CHECK-08 is no longer metric-only, so `issues_list` with `checkId: "CHECK-08"`
  now answers rather than being refused; CHECK-33 is no longer metric-only either
  (`links.internal-nofollow` and `links.high-outlinks` claim it), so `checkId:
  "CHECK-33"` answers too.
- **Pixel width** (CHECK-35, CHECK-36), beside the character rules rather than
  replacing them: `title.pixel-too-long` (warning), `title.pixel-too-short`
  (info), `meta-description.pixel-too-long` (warning) and
  `meta-description.pixel-too-short` (info). A value holding a character outside
  the measured glyph table is not pixel-judged, and the character rules still
  apply to it.

**What Phase 24a changed here: `crawl_status.platform` and
`crawl_status.platformProfile`.** Two fields, additive, migration 0024, no tool
or route added. `platform` is the platform the site's own response headers named
(`"shopify"` today: `powered-by: Shopify`, or any `x-shopify-*` header), read off
the first `ok` HTML response from the crawl's origin — the host probe's, or the
seed fetch's when the probe is off. Headers only: no body sniffing, no extra
request. `null` means no platform was named (the headers named none, which
includes a Shopify store whose CDN strips those headers; no page answered `ok`;
or a pre-0024 crawl), and the crawl ran at its configured settings.
`platformProfile` is `null` exactly when `platform` is; otherwise
`{platform, applied, appliedAt, optedOut}`. `applied` is
`{maxConcurrency, perHostDelayMs, renderConcurrency, navigationTimeoutMs}`, the
values in force after the clamp. A profile only ever slows a crawl down: Shopify
is `maxConcurrency = min(config, 1)`, `perHostDelayMs = max(config, 1000)`, one
render browser, and a render navigation budget of at least 60 s. `appliedAt` is when it took
effect: before the first worker when the probe named the platform, mid-crawl
when the seed fetch did (requests already in flight finished at the old
settings). `optedOut: true` with `applied: null` and `appliedAt: null` means the
operator turned profiles off for this crawl (engine config `platformProfiles:
false`, which is not a `crawl_start` field) and nothing was clamped. Pacing that
changed with it, for every crawl: the sitemap walk now waits
`max(perHostDelayMs, robots Crawl-delay)` between documents (before 24a only the
robots number was honoured, so a site with no `Crawl-delay` had its shards read
back-to-back). When the probe has already named the platform, that delay is the
profile's floor.

**Also Phase 24a: `crawl_status.throttle`.** One field, additive, no
tool or route added. `throttle` is the per-host record of how hard each host pushed
back, keyed by host: `{responses429, retryAfterSeen, escalations, recoveries,
recoveryLocked, peakSpacingMs, finalSpacingMs}`. `escalations` is cumulative and
never decremented; the level in force is `escalations - recoveries`.
`finalSpacingMs` is the spacing in force for that host when the record was last
written, and `peakSpacingMs` the widest it was ever crawled at. Every host the crawl
touched is in the record, including hosts whose counters are all zero. It is crawl
evidence, not a finding (the Phase 16 ruling): no rule reads it and nothing in
`issues` is raised from it. `throttle` is `null` only when no record was ever stored: the column is null (a
pre-24a crawl, or one that failed before its first write) or holds a pre-24a
`{host: ms}` map. It is `{}` when a 24a crawl touched no host. It is never a
record of zeros. `hostSpacingMs` keeps its meaning (the widest spacing any host reached)
but is no longer monotonic over a crawl, because a host that stops pushing back
can step back down. The way down is bounded: after `RECOVERY_STREAK` (50) clean
answers in a row (a 2xx, 3xx or 4xx other than 429, with no `Retry-After`, and not a
401/403/challenge refusal), a host steps down one escalation level and its spacing
halves, never below its base. A host that escalates again after any recovery is
`recoveryLocked` for the rest of the crawl and only goes up from there, so a host's
spacing turns from falling to rising at most once per crawl. The whole state
(level, recoveries, lock, counters) is persisted in `host_spacing_jsonb`, so a resume
is not a second try.

**Also Phase 24a: the render pass is paced like the crawl, and `crawl_render` answers
`requests`.** One field, additive, no tool or route added. The render pass's host gate
is seeded from the crawl's per-host state (`host_spacing_jsonb`): each host re-enters
at the spacing, back-off level, recovery count and lock the crawl left it at, with the
crawl-wide `hostSpacingMs` used only for a host the per-host map does not name. The
gate is keyed by each request's OWN host, not the origin's: a crawl started on the apex
that crawled `www.` has its earned state under `www.`, and a render of `www.` pages
paces at that state and records its 429s in the `www.` entry. Every
same-origin request the browser makes that reaches the network waits for that gate:
documents, redirect hops, scripts, stylesheets, xhr/fetch, same-origin iframes and
worker scripts. Before 24a only the documents were paced. Paint-only requests (images,
media, fonts) and third-party requests are still aborted, so they are never sent, paced
or counted. Popups, service workers, shared workers and prerendering are disabled.
Every connection goes through a local proxy that drops it, except `http(s)://` to the
crawl's origin at its exact port (pinned even when it is the default 443 or 80). The
exemption covers every spelling the crawl treats as its own origin: the `www.` and
apex hostnames, and https:443 beside an http:80 origin. Each hostname is resolved and
approved by url-policy once, at launch, and the browser is pinned to that address for
the whole pass (`--host-resolver-rules`), so a DNS answer that changes mid-pass cannot
redirect it. If a name has several A records, the first approved IPv4 is used. Every
other name resolves to nothing. If the crawl's own hostname does not resolve, or has
any answer in blocked address space, the pass refuses to start. `crawl_render` then
answers 409 (HTTP) or a tool error (MCP), and the message reads `the render pass could
not start: <reason> (CRAWL_TARGET_BLOCKED | DNS_RESOLUTION_FAILED)`. What `<reason>`
says is bounded, on both transports and in `unpinnedHosts[].reason` alike. A refused
answer keeps the host, the address and the range it fell in — `<host> resolves into
blocked address space (<address>: <range>)` — deliberately: the address is public DNS
data about the caller's own site, the same sentence the crawl's blocked-fetch rows
carry, and the one thing a caller needs to see which record is wrong. A name with no
record says `<host> has no A or AAAA record`. A name the resolver could not look up
says only `<host> could not be resolved; detail logged under <correlationId>`: the
resolver's own message (the DoH transport error, its HTTP status, the DNS rcode)
describes Ariadne's resolver path, not the site, and goes to the server log under that
id, the way a 500's stack does (obligation 6). The rows the selection put in
`render_pending` stay there, as any launch failure leaves them, and a later pass
re-selects. If only the other spelling fails, the pass runs without it.
`crawl_render`'s `unpinnedHosts: [{host, reason}]` names it (a resolver failure there
is logged under the crawl id, without a correlation id in the answer), and a page on
it fails as `renderError: "policy refusal: <host> was not approved for this pass (…)"`.
That covers WebSockets to any host, the origin included, and anything the interception
cannot see, so no request reaches another host even if interception fails.
Interception is fail-closed: when a render ends or one of our protocol commands
fails, every request still paused is failed, never released. Script execution is
switched off before the page closes, so `pagehide` handlers and timers cannot send
anything. One same-origin request cannot be stopped in this Chromium build: a
speculation-rules prefetch. It is counted in `unpacedNetwork`, reported to the gate,
and given a slot after the fact. Every answer is reported into the gate, so a
subresource 429 escalates the host. That includes an answer that arrives after its
render ended, for a request released before the end: the request was on the wire, and
its 429 is the site speaking. The gate's state is written back to
`host_spacing_jsonb` and `host_spacing_ms` after every render that moved a host's
spacing and once at the end of the pass, as a compare-and-set against the value last
read. A record that changed under the pass makes the pass fail rather than overwrite
it. So `crawl_status.throttle` includes the render's own 429s, and the next pass
inherits its escalations. That write happens only over a 24a record: a null column or
a pre-24a `{host: ms}` map is left alone and `throttle` stays `null`, because a record
written then would present render counts as the crawl's. One browser context per
render worker is reused across URLs, so the HTTP cache survives. Cookies, permissions
and the origin's storage (`Storage.clearDataForOrigin`: cookies, local storage, IndexedDB,
WebSQL, file systems, service workers, Cache API, shared storage, storage buckets) are
cleared after the page is closed, through a blank page of the same context, and again
before the next navigation. `sessionStorage` dies with the page. A request the cache is
predicted to answer is not paced. A prediction needs an earlier explicit `max-age` and a
`Vary` that is absent or exactly `Accept-Encoding`. `crawl_render`'s
answer gains `requests: {paced, fromCache, unpacedNetwork}`, summed over the pass.
`paced` counts requests that waited for a slot, documents included. `fromCache` counts
responses the HTTP cache served. `unpacedNetwork` counts same-origin requests that
reached the site without a slot. There are two kinds: a predicted cache hit that went to
the network anyway, after which that URL is never predicted again in that context, so it
happens at most once per URL per worker; and a speculation-rules prefetch. A render that runs out
of navigation budget is `renderError: "timeout under pacing (<n> requests paced):
navigation did not reach domcontentloaded within <ms>ms"`. Before 24a it started
`timeout: …`. Because every same-origin request waits, the navigation budget of EVERY
render pass grows with the spacing: `min(120 s, max(configured, 15 s + 30 × spacing))`,
where the spacing is the widest in force when the pass starts (configured delay,
profile floor, robots `Crawl-delay`, and what the crawl earned, per host and
crawl-wide). That is 45 s at the default 1 s spacing and the 120 s cap from 3.5 s up;
a profile's own budget (Shopify 60 s) still applies when it is larger, and the cap
never lowers a caller's own larger setting. The render lease is derived from it as
(2 × renderConcurrency + 1) × 30 s + navigation budget + settle + 30 s: 348 s at the
defaults (four workers, 45 s), 423 s at the cap, 183 s under the Shopify profile at
1 s, replacing a fixed 120 s.

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
was added, removed, or retyped. `renderPassEvidence`'s values `"ran"` and `"none"` were unchanged —
Phase 13 named them behind the wire (`RENDER_PASS_EVIDENCE.ran`/`.none`) and
pinned the shape against hardcoded literals, and the strings a consumer reads
were exactly what Phase 12 wrote (§4.5). Phase 25 later added a third, `"failed"`
(§4.5). Everything else in
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
type declaration. The Phase 27a additions (§4.1's `judgement`, §4.3's and §5.1's
`type` / `priority` / `disabledRules`, §4.3a `issues_overview`, §4.3b
`crawl_overview`, §4.9 `crawl_config_get` / `crawl_config_set`, `judgementStale`
wherever it rides, §5.7 and §12's two views) were regenerated on 2026-11-08 the
same way — an MCP client over the in-memory transport — against the dev
database's lavishalice crawl `crawl_4dd32709-56c9-4a62-9af4-7a843f76ff6c`
(ruleset 0.23.0, re-judged for the Phase 27a gate, `docs/gates/phase-27a.md`),
whose answers are quoted below as they came back.

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
- **The equality is tested, not argued.** `test/api/mcp.test.ts:2757`
  ("answers the same JSON for the same question, route by tool") calls thirteen
  (tool, route) pairs over the wire against one database and asserts the two
  answers are `toEqual`. `test/api/mcp.test.ts:2778` ("refuses in the same
  words, whichever transport asked") does the same for five refusals — the same
  sentence and the mapped status. `test/api/mcp.test.ts:2836` ("streams the
  bytes the other transport writes to a file") and `test/api/mcp.test.ts:2862`
  ("streams the resources view byte for byte") assert the CSV a route streams is
  byte-identical to the file the tool writes, for the `issues` and `resources`
  views.

  **What that equality does NOT cover**, stated so nobody reads more into it
  than it says: the six **command** tools — `crawl_start`, `crawl_resume`,
  `crawl_mark_failed`, `crawl_render`, `crawl_rules`, `crawl_config_set` — are
  excluded, because each
  one *changes* the database and a second identical call would be answering a
  different question (their own transport suites cover them, and for
  `crawl_resume` the second call is a refusal by design: the crawl the first one
  queued is now held by the server). And it compares **first pages only**:
  cursor behaviour is pinned per transport, by walks that page a listing to a
  null cursor, but page two is not compared across the two. The three read
  tools Phase 27a added are not among the thirteen pairs; each has its own
  route-equals-tool test instead (`test/api/judgement-config.test.ts:657`
  "crawl_config_get answers what GET /crawls/:id/config answers",
  `test/api/crawl-overview.test.ts:473` "serves the same answer at GET
  /crawls/:id/overview/crawl"). `GET /crawls/:id/overview/issues` has no
  route test of its own: it is the same service call as the tool, and the
  Phase 27a gate compared the two live, with and without `includeZero`, and
  found them equal (`docs/gates/phase-27a.md` §3).

---

## 1. Transports, auth and trust

| | HTTP | MCP |
|---|---|---|
| Where | `node:http`, one port (`ARIADNE_API_PORT`) | stdio |
| Who may call | anyone with the bearer token, naming a tenant | the process that started this one, as its one tenant |
| Auth | `Authorization: Bearer <token>`, checked **before routing**, then `X-Ariadne-Tenant: <tenant>` (Phase 28a) | none, deliberately; `ARIADNE_TENANT` required at boot |
| Errors | status code + `{error, code}` (since 27c; `code` on every `ServiceError`) | `isError: true` + one text block of `{error, code}` |
| Bulk data | `GET …/export` streams `text/csv` | `export_crawl` writes a file, answers with its path |

- The token is `ARIADNE_API_TOKEN`, minimum 16 characters, compared in constant
  time over SHA-256 digests (`src/api/auth.ts`). The server refuses to boot
  without one (`test/api/http.test.ts:2172` "refuses to produce a config without
  a token").
- **The token is checked before routing**, so an unauthenticated caller cannot
  map the surface: an unknown path answers 401, not 404
  (`test/api/http.test.ts:495` "checks the token before routing"). Every refusal
  names *which* thing was wrong — missing header, wrong scheme, wrong token.
- **MCP asks for no credential** and that is a posture, not an omission: an
  stdio client either started this process or was handed its pipes
  (`test/api/mcp.test.ts:3016` "asks for no bearer token: an stdio client is the
  process that started this one"). If Ariadne's MCP server is ever mounted on a
  network transport, that argument dies with the change and a credential has to
  arrive with it.
- **Tenancy (Phase 28a).** A request names its tenant in `X-Ariadne-Tenant`, checked
  right after the token and before routing: missing or empty is 400 `TENANT_REQUIRED`, a
  value outside `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` is 400 `INVALID_TENANT`, and neither
  quotes the value. The token proves the caller is Talos; the header says which tenant
  Talos acts for. Example: `curl -H "Authorization: Bearer $ARIADNE_API_TOKEN" -H
  "X-Ariadne-Tenant: 42" $ARIADNE/crawls`. A crawl of another tenant answers as a crawl
  that does not exist (404 `NOT_FOUND`). Stdio MCP is one tenant by process trust,
  `ARIADNE_TENANT`, required at boot. Pinned by `test/api/tenant-isolation.test.ts` and
  `test/api/tenancy.test.ts`.
- **The domain allowlist binds both transports** (`ARIADNE_ALLOWED_DOMAINS`,
  exact host or `*.example.com`). An empty allowlist refuses every crawl
  trigger and still answers every query — the read-only posture a Talos
  deployment can run for reporting-only tenants
  (`test/api/mcp.test.ts:949` "refuses every crawl when the allowlist is empty",
  `test/api/http.test.ts:823` "refuses every crawl when the allowlist is empty,
  but still answers queries").
- **`ServiceConfig.allowAnyPublicHost` is a second code-only process-trust seam**
  (the first is `crawlDefaults`), and a Talos reader who finds the field in
  `src/api/config.ts` should read this rather than conclude the allowlist is
  optional. It accepts any host at the crawl-trigger allowlist gate and nothing
  else: it is never wired to env or to the wire (`loadApiConfig` does not read
  it, no request or tool field maps to it —
  `test/api/open-posture.test.ts:290` "loadApiConfig can never set the posture
  from the environment"), and `api:serve` and `mcp:serve` never set it. Its only
  setter is the local demo surface added in Phase 15: the `npm run demo`
  entrypoint `src/demo/serve.ts`, which binds `127.0.0.1`, and the server factory
  it constructs, `src/demo/server.ts`'s `createDemoServer`, which is where the
  assignment lives. `isUrlAllowed` still runs on every URL with `allowPrivate`
  sourced from `crawlDefaults` alone, so loopback and RFC1918 targets stay
  refused under the posture, with the policy's own reason rather than the
  allowlist's (`test/api/open-posture.test.ts:248` "the posture does not touch
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
| The row's own state forbids it (still running, retired rule id, unreadable stored evidence; since Phase 27a also: a rule the crawl's judgement disables, asked for by `issue_urls` / `issue_inlinks`; a stored judgement that overrides a retired rule; `crawl_config_set` while the crawl's rules run; `issues_overview` on an unjudged crawl) | 409 `{error}` | tool error `{error}` |
| The crawl needs credentials this server does not hold (Phase 27c: after a restart; `crawl_resume`, `crawl_render`, a credential patch to `crawl_config_set`) | 409 `{error, code: "CREDENTIALS_REQUIRED"}` | tool error, same body |
| `crawl_render` while another crawl or render pass fetches the same site — the same host and port, whoever's crawl it is (Phase 28b; the sentence names the caller's crawl and that host only) | 409 `{error, code: "HOST_BUSY"}` | tool error, same body |
| A body over the route's cap (64 KiB; 1 MiB on `POST /crawls`, `POST /config/validate`, `POST /crawls/:id/resume`, `POST /crawls/:id/render`, `PATCH /crawls/:id/config`) | 413 `{error}` (no `code`: the transport's own refusal) | n/a (stdio) |
| A defect of ours | 500 `{error: "internal error", correlationId}` | `{error: "internal error", correlationId}` |

**Phase 28a adds two 400 codes**, `TENANT_REQUIRED` and `INVALID_TENANT`, both from the
transport's tenant check (HTTP only; stdio fails at boot instead). **Phase 28b adds
`HOST_BUSY` (409)**: one site is fetched by one crawl or render pass at a time across
every tenant (hard rule 9), so a synchronous `crawl_render` refuses rather than wait;
a crawl start waits in the queue instead.

**`code` (Phase 27c, additive).** Every refusal the service raises carries `code` beside
the sentence: `VALIDATION` (400), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409)
and `CREDENTIALS_REQUIRED` (409). The table above shows `{error}` where the code is the
one the status already implies; read `code` to tell `CREDENTIALS_REQUIRED` from any other
409 without parsing the sentence. The transport's own refusals (401, an unknown route's
404, 405, 413, malformed JSON) and the 500 carry no `code`, and neither does an MCP
schema refusal (the SDK's plain-text "Input validation error", §4.1). Pinned:
`test/api/credentials-restart.test.ts:347` "answers crawl_resume and crawl_render 409
CREDENTIALS_REQUIRED and writes nothing".

`correlationId` is a UUID; the stack goes to the server log under that id and
nowhere else (`test/api/mcp.test.ts:2889` "turns an unexpected throw into a tool
error with a correlation id", `test/api/http.test.ts:2115` "turns an unexpected
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
`test/api/mcp.test.ts:1219` "refuses a limit outside the contract rather than
clamping it").

**Closed vocabularies.** Every query parameter, body field and tool argument is
on a closed list. `?serverity=critical` is a 400 naming both the typo and the
accepted set, never an unfiltered listing with a 200 on it
(`test/api/query.test.ts:4071` "refuses a typo'd filter instead of answering the
question nobody asked"). MCP argument typos are refused by the SDK's schema
validator before the handler runs (`test/api/mcp.test.ts:831` "refuses an
argument nobody allowed, naming it").

**Not paginated, on purpose:** `rules_catalog`, `crawl_compare` and (Phase 27a)
`issues_overview`. All three are bounded by the **ruleset** (188 rows at 0.23.0,
174 of them finding rules) rather than by the crawl; `crawl_overview` is bounded
by its ten sections and the crawl's page types. The
catalog is ~196 KB (**200,260 bytes**, measured 2026-11-08 at the end of Phase
27a over all 188 rows of ruleset 0.23.0 the same way, with no crawl id — 16
markers at 2,487 bytes and the fourteen tables at 5,620; the 6,074 bytes over the
194,186 before it are `type` and `priority` on the 174 finding rules, and the
same measurement over the 0.22.0 code reproduces the 194,186 to the byte; a
catalog read WITH a crawl id is larger again by its `fired`, `thresholds`,
`judgementStale` and override fields; the 194,186 was measured 2026-11-08 after
the PR #24 review's R23 follow-up over all 188 rows of ruleset 0.22.0 by serialising what
`rulesCatalog` answers with no crawl id — 16 markers at 2,487 bytes, the
`marker` values JSON-serialised as one array, and the fourteen tables at 5,620
the same way; the 74 bytes over the 194,112 before it are the marker's `reason`
column and its rewritten marker sentence and fix copy, and the same
measurement over the code before it reproduces the 194,112 to the byte; the
194,112 was measured the same day after the review's R22 fix, 16 markers at
2,568 bytes; the 2,200 bytes over the 191,912 before that are the one new marker's row, its
copy and its reason; the 191,912 was measured the same day after Phase 26c Task
12a over all 187 rows, 15 markers at 2,286 bytes and the tables at 5,620;
the 163 bytes over the 191,749 before it are that task's `sitemap.structure`
copy (161) and column label (2); the 191,749 was measured the same day after
the Phase 26c final review (tables 5,618), `sitemap.structure`'s six new
columns among them, and the same measurement over the
pre-review code reproduces its 191,474 (tables 5,559) to the byte; the 191,474
before it was measured 2026-11-07 at the end of Phase 26c, and the same
measurement over the Phase 26b code reproduces its 183,585 to the byte; the
183,585 before it was re-measured
2026-11-07 after the owner calls
over all 182 rows of ruleset 0.21.0 the same way — 15 markers at 2,274 bytes and
the fourteen tables at 5,239; the 180,545 before it was measured the same day at the end
of Phase 26b over the 180 rows before the owner calls, the same way; the 154,237 before it was measured 2026-11-05 at the end of
Phase 26a over all 154 rows of ruleset 0.20.0 the same way — 14 markers at 2,157
bytes and the fourteen tables at 5,239; the
115,443 before it was measured 2026-10-22 at the end of
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
config_validate ──▶ crawl_start ──▶ crawl_status (poll until status ∉ {queued, running})
                    │
                    ├─▶ crawl_pause · crawl_cancel (a request while running: poll crawl_status
                    │                     for the status to change; §4.1c)
                    │
                    ├─▶ crawl_resume   (only if it stopped with work owed, or paused: the SAME crawl continuing)
                    │
                    ├─▶ crawl_delete   (a closed or paused crawl, with the confirm echo; §4.1c)
                    │
                    ├─▶ crawl_render   (optional; before the rules, if rendered evidence should be judged)
                    │
                    ├─▶ crawl_config_get · crawl_config_set (any time but during a rules run:
                    │                     the judgement block — rule overrides act on reads at
                    │                     once, thresholds and findingCap at the next crawl_rules)
                    │
                    └─▶ crawl_rules    (writes findings + metrics; refused while the crawl moves)
                            │
                            └─▶ issues_list · issues_overview · issue_urls · metrics_get
                                crawl_overview (also before the rules: what it cannot measure is named)
                                pages_query · robots_get · rules_catalog (with crawlId) · export_crawl
                                crawl_compare · compare_urls (two judged crawls of one site)
```

Crawls run on worker processes (Phase 28b): a worker runs `ARIADNE_WORKER_CONCURRENCY`
at once (default 1), never two crawls of one host at once and never more than
`ARIADNE_TENANT_MAX_RUNNING` of one tenant's (default 1); a crawl accepted by a local
stdio or library process runs there, one at a time. `crawl_start` answers
`{crawlId, status: "queued", queuePosition}` immediately. There are **no
webhooks**: polling `crawl_status` is the contract until Talos asks otherwise.

---

## 4. The tools, route by route

`crawlId` is required everywhere it appears unless the table says otherwise.

| MCP tool | HTTP | Arguments |
|---|---|---|
| `crawl_start` | `POST /crawls` | `siteUrl` (required), `maxPages`, `maxDepth`, `userAgent`, `perHostDelayMs`, `maxConcurrency`, `probeHosts`, `legacyHosts[]`, `sitemapUrls[]`, `renderBudgetPct`, `renderMaxPages`, `renderSamplePerType`, `findingCap`, `fetchResources`, `judgement` (the block `crawl_config_set` changes later, §4.9); since 27c `mode`, `urls[]`, `exclude[]`, `include[]`, `requestHeaders`, `httpAuth`, `cookies`, `maxRedirectHops`, `maxUrlLength` (§4.1) |
| `crawl_status` | `GET /crawls/:id` | — |
| `crawl_list` | `GET /crawls` | `siteUrl`, `limit`, `cursor` |
| `crawl_resume` | `POST /crawls/:id/resume` | `requestHeaders`, `httpAuth`, `cookies` (optional: the crawl's credentials, re-supplied after a restart, §4.1a). A paused crawl resumes; a cancelled one is final and refused |
| `crawl_pause` | `POST /crawls/:id/pause` | — (queued: paused now, 200; running: requested of the loop, 202) |
| `crawl_cancel` | `POST /crawls/:id/cancel` | — (final; queued or paused: cancelled now, 200; running: requested, 202) |
| `crawl_delete` | `DELETE /crawls/:id?confirm=<crawlId>` | `confirm` (required; must repeat `crawlId`). Hard delete of every row and the render and export files; 409 while queued or running |
| `crawl_mark_failed` | `POST /crawls/:id/fail` | — |
| `crawl_render` | `POST /crawls/:id/render` | `urls[]` (optional; replaces the automatic selection); `requestHeaders`, `httpAuth`, `cookies` (optional, as on `crawl_resume`) |
| `crawl_rules` | `POST /crawls/:id/rules` | — |
| `crawl_config_get` | `GET /crawls/:id/config` | — (`crawl` and its `mutability`, the judgement block, every overridable threshold, the last run's stamp and `judgementStale`, §4.9) |
| `crawl_config_set` | `PATCH /crawls/:id/config` | `crawl` and/or `judgement` (at least one; `crawl` is new values for the whenPaused fields, `judgement` an RFC 7396 merge-patch of the block, except `findingCap: null`, which is uncapped, §4.9) |
| `config_schema` | `GET /config/schema` | — (the `crawl_start` body as JSON Schema draft 2020-12, and the `rulesetVersion` it names rules from, §4.1b) |
| `config_validate` | `POST /config/validate` | `config` over MCP (the `crawl_start` arguments to check); the body itself over HTTP. Always 200 with `{valid, errors, effective}`, §4.1b |
| `robots_get` | `GET /crawls/:id/robots` | — |
| `issues_list` | `GET /crawls/:id/issues` | `severity`, `checkId`, `ruleId`, `category`, `pageType`, `limit`, `cursor` |
| `issues_overview` | `GET /crawls/:id/overview/issues` | `includeZero` (one row per rule with the crawl's judgement applied; also `view=issues_overview` on `export_crawl`) |
| `crawl_overview` | `GET /crawls/:id/overview/crawl` | — (sectioned counts that describe the crawl; what it could not measure is named in `notMeasured`, never zero; also `view=crawl_overview` on `export_crawl`) |
| `issue_urls` | `GET /crawls/:id/issues/:ruleId/urls` | `ruleId` (required), `limit`, `cursor` |
| `issue_inlinks` | `GET /crawls/:id/issues/:ruleId/inlinks` | `ruleId` (required — **only** `links.broken-internal`, `links.to-server-error` or `robots.blocks-internal-urls`), `limit`, `cursor` |
| `metrics_get` | `GET /crawls/:id/metrics` | `metricId`, `scope`, `scopeValue`, `limit`, `cursor` |
| `metric_table` | `GET /crawls/:id/metrics/:metricId` | `metricId` (required) |
| `pages_query` | `GET /crawls/:id/pages` | `pageType`, `statusCode`, `indexable`, `rendered`, `fetchClass`, `discoveredVia`, `limit`, `cursor` |
| `rules_catalog` | `GET /rules` | `crawlId` (**optional** — the only tool where it is) |
| `crawl_compare` | `GET /compare` | `baseCrawlId`, `headCrawlId` (both required) |
| `compare_urls` | `GET /compare/urls` | `baseCrawlId`, `headCrawlId`, `ruleId`, `set` (all required), `limit`, `cursor` |
| `export_crawl` | `GET /crawls/:id/export` | `format` (`jsonl.gz` \| `csv`), `dataset` (jsonl.gz only), `view` + `ruleId` \| `metricId` (csv only) |

Pinned: the tool list and every schema — `test/api/mcp.test.ts:673`
("advertises exactly the twenty-eight tools of the agent surface"),
`test/api/mcp.test.ts:700` ("closes every input schema and describes every
field"), `test/api/mcp.test.ts:732` ("names every member of the closed
vocabulary each field enumerates"). `crawl_start`'s field set is not a second
declaration to keep in step: its input schema IS the crawl-start body schema
(`src/api/config-schema.ts`), and a test walks that schema's published form and
drives every field through both transports
(`test/api/transport-parity.test.ts:368` "walks the published schema and drives
every body through POST /crawls and crawl_start"). `crawl_render`'s is asserted
against the service's own `RENDER_CRAWL_FIELDS` table.

### 4.1 `crawl_start` → `{crawlId, status, queuePosition, listUrlCount?, listDuplicates?}`

`status` is always `queued` at acceptance. Refusals: a host off the allowlist
(403, naming it), a legacy host or supplied sitemap off the allowlist (403), a
`siteUrl` that is not http(s) (400), `perHostDelayMs` under the floor (400,
naming the floor), `allowPrivate` at any value (400 — it is not a wire field),
an unknown field (400, naming it **by position**, below). **A body with several faults gets the schema's
400 before the allowlist's 403** (since 27b the schema runs first, so a body that
is both off-allowlist and malformed is a 400 naming the malformed field; fix it and
the 403 follows). The body is parsed by ONE schema for both
transports (§4.1b): over MCP a body that does not fit it is refused by the SDK
before the tool runs, in the schema's own words with the path appended, rather
than as `{error}` JSON. `config_validate` answers every one of these without
starting anything, with the same first message
(`test/api/transport-parity.test.ts:397` "answers valid: false exactly when POST
/crawls refuses"). The body refusals themselves are pinned in
`test/api/config-schema.test.ts:241` ("refuses a perHostDelayMs under the
politeness floor rather than raising it").

**An unknown key is named by its position, never quoted** (Phase 27d). A key can be a
secret pasted into the wrong place, so no refusal hands back what the client sent. The
message names the FIRST unknown key in an object by its place among the keys as sent
(`body has an unknown field (key 3 in the order sent)`), counts the rest
(`(and 4 more)`), and, when one accepted name is close to what was sent, suggests it
(`; did you mean 'maxPages'?`), then lists the accepted names. That covers `POST
/crawls`, `config_validate`, `crawl_resume`, `crawl_render`, `PATCH /crawls/:id/config`,
every route's query string (`unknown query parameter (key 1 in the order sent)`) and
every MCP tool's arguments. `crawl_start` and `config_validate` answer ONE
`unknown_field` error per object, not one per key, so a body of a hundred thousand
unknown keys is one short refusal, read in linear time. Rule ids in `judgement` are
positional too, with the ruleset version (`key 2 in the order sent names no rule in
ruleset 0.25.1`). Two things are still named: a credential header or cookie name that
is a valid HTTP token (27c), and a rule id already **stored** in a crawl's judgement
that the ruleset no longer has, because that is the repair path (`crawl_config_set`,
§4.9). "In the order sent" is `Object.keys` order, so an integer-like key counts first.
Pinned by `test/api/no-key-echo.test.ts`, which sends a sentinel key through every
transport and nested position and asserts it appears in no response and no log line.

**`judgement`** (Phase 27a) sets how the crawl is judged from its first rules
run: the block §4.9 describes, `{rules?, thresholds?, findingCap?}`. It is
checked against the ruleset before the crawl is accepted, and a block the
ruleset cannot apply is a 400 naming the path, exactly as `crawl_config_set`
refuses it. `judgement.findingCap` is the top-level `findingCap` by another
name and is stored in the same place: given in both places they must agree,
or the start is refused naming both (`test/api/judgement-config.test.ts:278`
"is accepted, stored, and read back by GET /crawls/:id/config",
`test/api/judgement-config.test.ts:352` "refuses findingCap at both levels when
they disagree, naming both"; over MCP, `test/api/judgement-config.test.ts:673`
"crawl_start takes the judgement field").

**List mode, scope and credentials (Phase 27c).** The fields, their bounds and what
each does are in the Phase 27c summary at the top of this document; this is what
`crawl_start` refuses for them, all before a row exists, and all answered the same by
`config_validate`:
- `mode: "list"` without `urls`, or `urls` without `mode: "list"` (400);
  `sitemapUrls: []` on a list crawl (400: "read no sitemap" is to omit the key); more
  than 10,000 URLs (400; the list is never trimmed, split it across crawls); a listed
  URL outside `siteUrl`'s site family (400), one the URL policy refuses (403), one
  `exclude`/`include` refuses (400: listing and excluding a URL is a contradiction to
  fix); an explicit `maxPages` below the distinct list (400);
- a pattern that can never match: one with no leading `*` whose literal start is not
  `http://` or `https://` (a path rule needs its `*`), one whose scheme and host name
  an origin admission never admits for the site (another host, or `http://` on an
  `https` site), an upper-case scheme or host; an empty pattern, more than 100
  patterns or one over 512 characters (400); a spider seed the scope refuses (400: an
  empty crawl is not an answer);
- a refused header name (the 13 names, or a `proxy-` or `sec-` prefix), a header or
  cookie name that is not an HTTP token, a header
  value with CR, LF or another control character but tab, or a character above
  U+00FF, a value over 1,024 bytes, a header name given twice (case-insensitive) or a
  cookie name given twice, a cookie value with `;`, `,` or whitespace, a username
  holding `:`, more than 20 headers or 50 cookies (400). **No refusal quotes a value**: the
  message names the field and the header or cookie name only — and a name that is not
  a token, or an unknown key, only by its position, never quoted (pinned:
  `test/api/scope-start.test.ts:555` "is never echoed: each refusal names the position,
  on HTTP and MCP, start, validate, set and resume").

A list crawl's answer adds `listUrlCount` (distinct URLs) and `listDuplicates` (how
many were collapsed as another's spelling); a spider crawl's has neither. Pinned:
`test/api/scope-start.test.ts:295` "refuses an off-site URL, an excluded listed URL,
an excluded seed, a typo'd host and maxPages below the list",
`test/api/scope-start.test.ts:391` "collapses two spellings of one URL, counts it, and
stores the distinct URLs in order", `test/api/scope-start.test.ts:254` "413s a 1.5 MiB
body to POST /crawls, and accepts 900 KiB carrying 10,000 URLs",
`test/api/scope-start.test.ts:413` "refuses an invalid credential set with a body that
quotes no secret, on both transports" and `test/api/scope-start.test.ts:447` "accepts
a valid set and shows no value in crawl_status, effective, crawl_config_get, the row
or the log". The crawl side: `test/crawl/list-mode.test.ts:181` "fetches every listed
URL at depth 0 and follows redirects but no link", `test/crawl/scope-admission.test.ts:245`
"writes an excluded row for a URL an exclude pattern matches, never requests it, and
stamps excluded_dropped 0", `test/crawl/credentials.test.ts:424` "sends none of them to
another host: a resource, its robots.txt, a legacy host's probe, a redirect hop", and
the secret scan, `test/fixtures/scope-and-requests.test.ts:339` "after a crawl with all
three credential kinds and a render pass, no secret is in any stored column or the
log".

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
(`test/crawl/loop.test.ts:1591` "resumes at the spacing the crawl earned, not the
one it was configured with").

Two things that column is not, because a reader will otherwise assume both:

- **It is the crawl-wide fallback, not the per-host truth.** It is one number for
  the whole crawl — the widest spacing any host reached — so on its own it would
  apply that width to *every* host a resume touches, including ones that never
  pushed back. Since Phase 13 (migration 0015) the per-host truth lives beside it
  in `crawls.host_spacing_jsonb` (`{host: earnedMs}` before Phase 24a; since then each
  host's whole ratchet state, `HostGate.snapshot()`): each host re-enters ITS OWN
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
finishes (`test/api/http.test.ts:1283` "unjudges a crawl it queues, so no
timestamp outlives the pages it described").

Refusals, each naming which one fired: no such crawl (404); this server already
holds it (409); an unexpired lease says a worker is still on it (409, naming the
count — `leased_until` is the frontier's own live-worker detector); a settled
crawl with nothing owed (409, naming what was counted — pending frontier rows,
expired leases, unasked resource rows); the allowlist (403, naming the host); and
the row changing state under the call (409 — see the race below).

**Credentials and scope on a resume (Phase 27c).** A crawl started with
`requestHeaders`, `httpAuth` or `cookies` resumes with the stored values (since Phase 28b they survive a restart).
If the stored copy is unreadable, the resume is refused **409 `CREDENTIALS_REQUIRED`**,
naming the kinds and the header and cookie names it needs, until the same call sends
them (`{requestHeaders?, httpAuth?, cookies?}` in the body; over MCP beside `crawlId`).
What is sent must be exactly the stored kinds and names, or it is a 400 naming both
shapes (names only); a crawl that started without credentials cannot gain them here
(400, pointing at `crawl_config_set` while paused). Nothing is written by a refused
resume, and the values sent are never logged or answered (a resume that sends them
replaces the stored copy only once it is accepted, and an agent's resume resets the
auto-resume count). `crawl_render` takes the same three fields on the same terms, and
stores what it was sent only once the render is accepted, so a refused render leaves the
stored values as they were. A
resume also re-applies the crawl's current `exclude`/`include` before its first lease,
both ways (the Phase 27c summary at the top). Pinned:
`test/api/credentials-restart.test.ts:347` "answers crawl_resume and crawl_render 409
CREDENTIALS_REQUIRED and writes nothing; resumed with them, it finishes",
`test/api/credentials-restart.test.ts:632` "a maximal credential set is re-supplied
over HTTP after a restart (1 MiB cap); a 64 KiB route still 413s",
`test/api/credentials-restart.test.ts:667` "a refused render leaves the stored
credentials as they were", `test/crawl/scope-admission.test.ts:376` "re-files pending
URLs a changed scope refuses as excluded rows before any lease, leaving fetched ones
alone" and `test/crawl/scope-admission.test.ts:681` "re-admits an excluded URL the
cleared scope admits, and fetches it to an ok row".

**A `paused` crawl is always resumable, and a `cancelled` one never is** (Phase 27b
rulings 5 and 6). The stop path decides nothing on its way out: URLs never leased
stay pending, resource rows never reached stay null with no reason, and a stop
skips whatever epilogue work had not started (the order is probe → recheck →
resources): the 404 probe if the stop came during the page crawl or the probe
itself; otherwise the rest of the 5xx recheck and the resource pass. Skipped work is never recorded as
having found nothing. So what a pause leaves is exactly the set of questions nobody
has answered, and the owed-work check below applies only to a `finished` or `failed`
row (a paused crawl may owe work its stop skipped that no row counts). A `cancelled` crawl is
refused with a 409 naming `cancelled` and `final`: a cancel is a decision, and
`crawl_start` is how to crawl the site again. A resume is also refused (409) while
a pause or cancel is still pending on the row, because carrying the request into a
queued crawl would drop an agent's cancel or stop the resumed run at once; for a
crawl whose worker is gone, `crawl_mark_failed` clears the request and the resume
follows. A caller who wants a crawl dead and not continued uses `crawl_cancel`;
`crawl_mark_failed` is for an orphan whose worker is gone.

**Pages waiting on the render pass are NOT resumable work.** `render_pending`
rows are already-crawled pages the selection promoted and the crawl loop never
leases them; the refusal names them and points at `crawl_render`
(`test/api/http.test.ts:1397` "names render_pending rows as the render pass's
work, not a resume's"). Neither are the null `fetch_class` rows of a crawl
configured with `fetchResources: false` — those carry the operator's decision,
and a resume would not ask about them
(`test/api/http.test.ts:1374` "does not read an off switch as resumable work").

**The honest race.** The two liveness checks are a snapshot: a lease can expire
between the count and the enqueue, and a worker this server cannot see can take a
fresh one just after. The claim itself is a **compare-and-swap** on the status
the call read, and its row count is *read*: zero rows means something else moved
the crawl in between, and the answer is a 409 rather than a queued crawl whose
row says something else — the silent no-op hard rule 7 forbids. That narrows the
double-accept race as far as it goes without a lock (of two callers past the
guards, only the one whose UPDATE lands first is accepted), and it cannot close
the window against a process that never touches the status
(`test/api/http.test.ts:1316` "409s when the crawl's state changes under the
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
(`test/api/http.test.ts:1198` "a killed crawl resumed over the wire reaches the
totals of a control that was never killed"; the MCP half is
`test/api/mcp.test.ts:1614` "finishes a crawl a server was killed in the middle
of, and keeps its earned spacing").

### 4.1c `crawl_pause` / `crawl_cancel` / `crawl_delete` → stopping a crawl

`crawl_pause` and `crawl_cancel` take `{crawlId}` (`POST /crawls/:id/pause`,
`POST /crawls/:id/cancel`) and answer `{crawlId, status, controlRequested,
immediate}`. **HTTP 200 when the change happened now (`immediate: true`), 202 when
it was requested of a running crawl (`immediate: false`, `status: "running"`,
`controlRequested` the request).** A 202 is a request, not an outcome: poll
`crawl_status` until `status` changes. A crawl that finishes before its next poll
closes `finished` and the request is cleared.

| status (pending request) | pause | cancel |
|---|---|---|
| queued | paused (`pauseReason` `request`), immediate; removed from this process's queue | cancelled (`cancelledAt` set), immediate; removed from the queue |
| running (none) | request `pause`, 202 | request `cancel`, 202 |
| running (pause) | 202, no change | request `cancel` (a cancel outranks a pause), 202 |
| running (cancel) | 409 "a cancel is already pending" | 202, no change |
| paused | 409 "already paused" | cancelled, `pauseReason` cleared, immediate |
| finished / failed / cancelled | 409 naming the status | 409 naming the status |

A cancel is also refused (409) while this server runs a render pass or a rules run
over the crawl; neither can be interrupted, so wait for it to answer. A pause
cannot meet one, because those runs never start on a `queued` or `running` crawl.

**How fast a stop lands.** The loop reads the request once a second
(`CONTROL_POLL_MS`) and, since Phase 27d, a stop is honoured in every phase of the
crawl within about a second (bound 2 s on an idle machine):

| phase | what a stop does |
|---|---|
| host probe | the probe's requests are aborted; the crawl closes at once |
| sitemap walk | the in-flight document is aborted, including while its rows are being flushed; what the walk had learned is dropped and a resume re-walks |
| post-discovery seeding | the sitemap-entry enqueue and the `sitemap_urls` write check the request between batches; the frontier is partial and a resume re-enqueues to the same set |
| page crawl | in-flight page fetches go back to the frontier and are never written as failures (an aborted fetch refunds its attempt) |
| known-404 probe | the probe's request (or its wait for a slot) is aborted; the probe is recorded as not run (`skipped`, "crawl stopped … before the known-404 probe") and the recheck and resource passes are skipped; a resume probes |
| 5xx recheck, resource pass | the in-flight request is aborted and its row left unwritten, so a resume asks it again; in the resource pass that includes a third-party asset host's robots.txt read, which a resume reads again |
| render pass | none to land: a crawl that renders is already `finished`, so `crawl_pause` and `crawl_cancel` answer 409, as before (27b) |

On a deep crawl the status flip waits for the close, which runs template inference over
every page: the 50k-page gate crawl (16 workers, 20,000 pages done) flipped `paused`
**5.3 s** after the request (`docs/gates/phase-27b.md` §7). Poll `crawl_status`; do
not assume one second. A **cancel during discovery** leaves a crawl that never ran
(below); a **pause during discovery** keeps whatever the evidence held. A stop that
lands in the walk of a **resumed** crawl, after the staged sitemap rows were cleared
for the re-walk, marks the evidence it keeps `truncation.interrupted` (the 26c block's `hreflang.declarations-incomplete`), because
the staged hreflang is now partial.

**What a stop keeps.** A pause keeps the frontier, the per-host spacing the crawl
earned and its throttle record; it survives a server restart, and nothing starts the
crawl but `crawl_resume`. A paused crawl that has run can be rendered and judged
(looking at partial results is a reason to pause). A cancel keeps the pages crawled,
which stay judgeable and exportable. A stop skips whatever epilogue work had not
started: the 404 probe if it came during the page crawl or the probe itself; otherwise the rest of the
5xx recheck and the resource pass (a request in flight is aborted, not awaited). The skipped checks read as not measured, never as
a pass. `crawl_status.neverFetched` says how many URLs the crawl never asked for.

**A crawl paused or cancelled while still queued never ran** (Phase 27b ruling 11).
It has no discovery evidence and nothing to judge: `crawl_rules` refuses it (409,
naming the crawl and saying it never ran), as `crawl_render` refuses a crawl that
never completed discovery. Its `neverFetched` is null, not 0: nothing was seen, so
the count is unknown.

**`crawl_delete`** takes `{crawlId, confirm}` (`DELETE /crawls/:id?confirm=<crawlId>`;
the confirm is a query parameter because DELETE bodies are poorly supported) and
answers `{crawlId, rows, files}`: the rows removed per table (`crawls: 1`
included; since Phase 28b `crawl_credentials` and `jobs` appear too) and `{renders, exports}`, the files removed from this server. **There is no
undo and no soft delete.** `confirm` must repeat `crawlId` exactly (400 otherwise).
Refused (409), each naming what holds the crawl: a `queued` or `running` crawl (pause or
cancel it and wait until it stops), a crawl with a pause or cancel pending, a crawl this
server renders or judges, and a crawl a worker still holds leases on. An unknown crawl is
404. It removes only this crawl's own files: a sibling crawl's exports and renders
survive. A file that cannot be removed is thrown with the paths left on disk, not
swallowed.

### 4.1b `config_schema` / `config_validate` → what a crawl accepts, and a dry run

`config_schema` answers `{schema, rulesetVersion}`: the `crawl_start` body as
JSON Schema **draft 2020-12**, generated from the one zod schema both transports
parse with. Every field carries its `description`, its `default` where the
engine has one, and `x-ariadne-mutable` — `never` (`siteUrl`, `userAgent`,
`probeHosts`, `legacyHosts`, `sitemapUrls`, `fetchResources`), `whenPaused`
(`maxPages`, `maxDepth`, `perHostDelayMs`, `maxConcurrency`, the three render
budgets) or `always` (`findingCap` and `judgement`). `judgement.rules` lists
every page and query rule id as `propertyNames.enum` (zod's spelling of a
partial record over an enum; no metric id), and `judgement.thresholds` has one
property per overridable threshold with its `minimum`, `maximum` and `default`
(`test/api/config-schema.test.ts:116` "publishes every overridable threshold with
its bounds and default"). A `default` is the ENGINE's: the operator's
`crawlDefaults` sit over it, so `config_validate`'s `effective` is the answer
to "what would this crawl run with".

`config_validate` is a dry run of `crawl_start`: always 200 with `{valid,
errors: [{path, code, message}], effective}` — only a body that is not JSON is
a 400. `code` is `unknown_field | forbidden_field | invalid_type | out_of_range
| invalid | not_allowed | url_policy`; the last two are the allowlist and the
URL policy (403 at `crawl_start`), every other one is a 400 there. It runs the
same checks `crawl_start` does, allowlist and URL policy on `siteUrl`, every
`legacyHosts` origin and every `sitemapUrls` entry included, with **no DNS
lookup**. `errors[0]` is the refusal `crawl_start` would answer with, in the
same words; `effective`, on a valid body, is exactly what the crawl would store
in `config_jsonb` plus the parsed `judgement` (null when none was given), and
is null on an invalid one (`test/api/transport-parity.test.ts:397` "answers
valid: false exactly when POST /crawls refuses").

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

Since Phase 24a the answer carries three more fields, after `hostSpacingMs`:
`throttle`, `platform` and `platformProfile` (above, "What Phase 24a changed here").
`crawl_02ff6f7a` predates them. The 24a gate crawl's live answer for them
(`crawl_6fbf187a-9f17-4d15-9d0b-b4035a5c9234`, lavishalice, read 2026-10-24), as it
came back:

```json
{"hostSpacingMs":2000,
 "throttle":{"lavishalice.com":{"responses429":2,"retryAfterSeen":0,
             "escalations":2,"recoveries":1,"recoveryLocked":true,
             "peakSpacingMs":2000,"finalSpacingMs":2000}},
 "platform":"shopify",
 "platformProfile":{"platform":"shopify",
                    "applied":{"maxConcurrency":1,"perHostDelayMs":1000,
                               "renderConcurrency":1,"navigationTimeoutMs":60000},
                    "appliedAt":"2026-10-23T21:08:29.024Z","optedOut":false}}
```

Read: the Shopify profile clamped the crawl to one request at a time at 1 s; the host
pushed back twice, stepped down once after a clean run, then escalated again and is
locked at 2 s for the rest of the crawl.

Read as a Talos dashboard: `blockedPages` and `hostSpacingMs` are the
politeness pair (§8) — this crawl was configured at `perHostDelayMs: 2000` and
finished at a spacing of 2000 with zero blocks, which is the shape of a crawl
that never had to back off; `rulesRunAt` + `findingsCount` are the judged-state
pair (§5); `findingCap` is **resolved** — an absent config key reports the
engine's default `200`, not `null`. `rulesetVersion` here is the ruleset at
CRAWL time, which is not necessarily the one that judged it (§7):
`renderPassCount: 14` pages were rendered under 0.6.0 and every finding on this
crawl was written under 0.7.0.

**`judgementStale`** (Phase 27a) sits after `rulesRunAt`: `{stale, reasons}`,
reasons from `overrides` (the disabled set), `thresholds` and `findingCap`. It
compares the crawl's CURRENT judgement block (§4.9) with the stamp its last
completed rules run wrote of what it used, so `stale: true` means the stored
findings and metrics were produced under settings that have since changed;
re-running `crawl_rules` clears it. Never stale on a crawl nobody has judged.
Retyping and reprioritising are not part of it: they change nothing stored. The
gate crawl's answer after `title.same-as-h1` was disabled and before the rules
re-ran, as it came back:

```json
{"judgementStale":{"stale":true,"reasons":["overrides"]}}
```

and after a `SLOW_MS` override on top of that, `{"stale":true,"reasons":["overrides","thresholds"]}`.
A crawl whose stored judgement overrides a rule this ruleset does not define is a
**409** here, naming the rule, as on every surface that reads the judgement;
`crawl_config_set` removing that override is the repair (§4.9). A judged crawl
with no stamp, or with a stamp whose `thresholds` lack any of the 20 names or
hold a value outside its range, is a 500 (the server log names the crawl under
the correlation id), never "not stale" (hard rule 7). Pinned:
`test/api/judgement-config.test.ts:599` "judgementStale on crawl_status,
metrics_get and metric_table" (three tests), `test/api/judgement-config.test.ts:477`
"can repair a stored override naming a rule the ruleset no longer has".

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
  scripts, and since Phase 26b its first `og:image` and first `twitter:image`, the
  two share images judged (no page loads those; `shareImage` `true` and
  `referencingPages` 0 on the CSV view). Share images are counted here, and in
  `fetched` / `failed` / `skipped`, because the resource pass fetches them like
  any page file. Recorded
  even when `fetchResources` is false; a file a script injects at runtime is not in
  it at all.
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

Pinned: `test/api/query.test.ts:2088` "the fields an audit checks itself against"
(15 tests over the whole block — the marker, the live findings count,
`pagesScanned`, the one-statement read, the four the recheck block added, and
the no-response partition Phase 23 added),
`test/api/query.test.ts:2201` "counts
the resource census off the database, partitioned exactly",
`test/api/query.test.ts:2243` "answers the block on a crawl that holds no
resource rows at all", `test/api/query.test.ts:2435` "reports the cap-exceeded
page count a crawl stamped, and null when none did",
`test/api/query.test.ts:2462` "echoes whether the crawl
asked about its files", `test/api/query.test.ts:2480` "409s a stored
fetchResources that is not a boolean"; over the agent transport,
`test/api/mcp.test.ts:1032` "answers the resource census and whether the crawl
asked for it" and `test/api/mcp.test.ts:1121` "tells an agent what the resource
numbers mean, and what they do not". The recheck block:
`test/api/query.test.ts:2254` "partitions the crawl's server errors by what the
second look found" (the arithmetic, over a fixture holding one row of every
outcome), `test/api/query.test.ts:2299` "counts as cleared exactly the classes
http.server-error-transient fires on" (the surface and the rule read ONE set,
imported, never two lists), `test/api/query.test.ts:2379` "tells a crawl with no
server errors apart from a crawl nobody rechecked",
`test/api/query.test.ts:2415` "keeps the recheck block off the crawl listing";
over the agent transport, `test/api/mcp.test.ts:1062` "answers the recheck
coverage, and keeps its two zeroes apart" (which also reads the block off a
crawl the suite really ran). The robots split itself is
`test/crawl/fetch-resources.test.ts:865` "classes an unreachable third-party
robots.txt apart from a forbidding one" and
`test/crawl/fetch-resources.test.ts:883` "keeps `robots_denied` for a file the
robots file actually forbade". Shape regenerated live from `crawl_02ff6f7a`
(2026-09-08, after migration 0016 — the `recheck` block above is that crawl's
own answer, not an invented example).

**Lifecycle fields (Phase 27b)**, beside `status`, null unless stated:
- **`controlRequested`** is `pause` or `cancel` while a request waits on a `running`
  crawl, and null otherwise. Do not call `crawl_resume` while it is set.
- **`pauseReason`** is `request` (an agent's `crawl_pause`), `shutdown` (a runner
  stopped mid-run), and since Phase 28b `worker_lost` (a worker stopped heartbeating),
  `credentials_unreadable` and `not_allowed` (see the Phase 28b summary) on a `paused`
  crawl, and null otherwise.
- **`job`** (Phase 28b) is `{kind, status, claimedBy?}` of the crawl's latest job, or null
  when no job ever ran; `queuePosition` is tenant-scoped (null means not positioned).
- **`cancelledAt`** is the time of the cancel on a `cancelled` crawl.
- **`neverFetched`** is the frontier's `pending` count on a `cancelled` crawl: the URLs
  it never asked for. It is computed, not stored (a cancel is final, so the frontier no
  longer moves); null on every other status, so "0 never fetched" and "not cancelled" are
  different answers. Null too on a crawl cancelled before it ran (cancelled while
  queued: no discovery evidence): nothing was seen, so the count is unknown, not 0.
- **`status`** is one of `queued | running | paused | finished | failed | cancelled`.
  `finished`, `failed` and `cancelled` are closed; only `cancelled` is final.

**`excludedDropped` (Phase 27c)**, beside `robotsBlocked`: discoveries the crawl's
scope (`exclude`/`include`, or a `maxUrlLength` below 2,500) turned away after the
never-requested budget was full. The budget is the one robots-blocked rows spend
(`maxBlockedUrls`, default `maxPages`), and below it every refused URL is a `pages` row
of fetch class `excluded`, read with `pages_query` (`fetchClass: "excluded"`). Like
`robotsBlocked.dropped` it counts DISCOVERIES, not distinct URLs. Zero is a
measurement; null is a crawl written before migration 0036, where nobody counted.
`crawl_status` carries no credential, value or name.

### 4.3 `issues_list` → `{items: IssueGroup[], nextCursor, disabledRules, notMeasured, judgementStale}`

The gate crawl's first group, as it came back (2026-11-08, ruleset 0.23.0):

```json
{"ruleId":"content.placeholder","checkIds":["CHECK-40"],"severity":"critical",
 "type":"warning","priority":"high","category":"content",
 "title":"Content: Lorem ipsum placeholder text","count":1,
 "sampleUrls":["https://lavishalice.com/pages/editorial"]}
```

`truncated: true` plus `total` **or** `atLeast` appears when that rule capped
its listing; **their absence means the count is the whole number**. `count` is
the rows the rule wrote — under a `pageType` filter it is legitimately smaller
than the note's own `reported`. `sampleUrls` is at most 5 and is a sample, never
a slice: `issue_urls` is the slice.

**`type` and `priority` (Phase 27a) are the crawl's, after its overrides.** With
no override they are the rule's registry defaults. Where the crawl's judgement
sets one, the group says so with `typeOverridden: true` /
`priorityOverridden: true`; the key is absent otherwise, never `false`. On the
gate crawl, after `crawl_config_set` retyped `images.empty-alt` to `issue` and
reprioritised `meta-description.too-long` to `medium`, the two groups came back
with `"type":"issue","typeOverridden":true` and
`"priority":"medium","priorityOverridden":true`, their counts (446, 312)
unchanged and no rules run between. **The order is still severity, then rule
id**: an override moves no group here (`issues_overview`, §4.3a, is the listing
ordered by type and priority).

**`disabledRules`** names every rule the crawl's judgement disables, on every
page of the listing, `[]` when none. A disabled rule still ran and its findings
are stored, but its group is left out. The filter is SQL, so `count`,
`nextCursor` and the other groups are exactly what they would be had the rule
never fired. This field is how a reader tells "filtered out" from "did not
fire". **`judgementStale`** is `crawl_status`'s flag (§4.2), carried on the
listing so a dashboard drawing it needs no second call. Pinned:
`test/api/judgement-surfaces.test.ts:143` "issues_list drops the disabled rule,
names it, and carries the overrides".

**`notMeasured` (27c final wave; `{id, reason}` since 27d)** sits beside `disabledRules`
on every listing that carries it — `issues_list`, `issues_overview`, the `issues`
export and the CSV views that read findings — and on `metrics_get`: **`[{id, reason}]`**,
the rules the stored rules run left out because this is a **list crawl** (decided by
the same registry flags as the `crawl.list-mode` marker, the crawl's mode and its
stored `sitemapsRead`), sorted by id. The `reason` is a sentence, as in
`crawl_overview`'s: `a list crawl follows no links, so this rule's evidence was not
gathered` for a rule that needs the link graph, and `a list crawl read no sitemap, so
this rule's evidence was not gathered` for a sitemap rule on a list crawl that read none.
The marker's OWN `notMeasured` evidence stays a plain list of rule ids (it is finding
evidence, not a surface field). A listing filtered to one of them
is empty because **nobody measured it, not because the site is clean** (hard
rule 1). `[]` on a spider crawl and on a crawl no rules run has judged. Mirroring
a disabled rule: `issues_overview` never makes one a zero row, `issue_urls` (and
the `issue_urls` CSV view) of one is refused 409 naming `crawl.list-mode`, and
`metric_table` of a skipped metric says in its `note` that it was not measured (its
JSON carries no `notMeasured`). The MCP answer of an `export_csv` over a findings view
carries the same `{id, reason}` list. Before 27d every one of these was a bare list of ids.
Pinned: `test/api/scope-start.test.ts:595` "issues_list and metrics_get name a
skipped rule in notMeasured, on HTTP and MCP, and never read it as clean".

Pinned: `test/api/query.test.ts:1087` "groups by rule, orders by severity then
rule id", `test/api/query.test.ts:1230` "says so when a rule's listing was capped"
(the capped shape); `test/api/mcp.test.ts:1763` "groups findings by rule, orders
them by severity" and `test/api/mcp.test.ts:1777` "carries a capped rule's real
magnitude".

### 4.3a `issues_overview` → one row per rule, with the judgement applied

`GET /crawls/:id/overview/issues` (`?includeZero=true`). Screaming Frog's Issues
tab with our axes, and the one listing ordered by what the agent's judgement says
matters: **type** (issue, warning, opportunity), then **priority** (high, medium,
low), then `urls` descending, then `ruleId`. The gate crawl's header and two of
its 46 rows, as they came back (2026-11-08):

```json
{"crawlId":"crawl_4dd32709-56c9-4a62-9af4-7a843f76ff6c","rulesetVersion":"0.23.0",
 "pagesJudged":446,
 "rows":[{"ruleId":"hreflang.non-indexable-target",
          "title":"Hreflang: Alternate points to a redirect or noindex URL",
          "type":"issue","priority":"high","severity":"critical",
          "category":"hreflang","checkIds":["CHECK-26"],
          "urls":4,"percentOfJudged":0.9},
         "…",
         {"ruleId":"extraction.not-recorded",
          "title":"Crawl: Page or sitemap facts not recorded on this crawl",
          "type":"warning","priority":"low","severity":"info","category":"crawl",
          "checkIds":["CHECK-04","CHECK-08","…"],
          "urls":1,"percentOfJudged":0.2,"marker":true},
         "…"],
 "disabledRules":[],"judgementStale":{"stale":false,"reasons":[]}}
```

- **`urls` is the number of distinct URLs `issue_urls` lists for the rule**, and
  a finding that names no URL counts as ONE site-wide entry (Phase 27a ruling 9,
  `docs/gates/phase-27a.md` §6). It is not `issues_list`'s `count`, which counts
  FINDINGS: a rule that fires more than once on a URL has more findings than
  URLs. On the gate crawl the two agree for all 46 rules. On a capped rule both
  stop at what the rule wrote.
- **`pagesJudged`** is `site.health`'s Pages Judged (`urlsTotal`) as the last
  rules run stored it, and **`percentOfJudged`** is `urls` over it, to one
  decimal place. §5.7 says when each is `null`. **It can exceed 100** for a
  site-wide rule whose URLs are not judged pages: `sitemap.uncrawled` lists
  sitemap URLs the crawl never fetched, so its `urls` is not a subset of Pages
  Judged. Read it as a ratio, not a share, on such rules.
- `typeOverridden`, `priorityOverridden` and `marker` behave as on the listings:
  present (`true`) or absent. A marker that fired is always a row, because "not
  measured" has to stay visible. Severity is the stored reading and is never
  overridable.
- **Rows included:** the rules that fired. `includeZero` adds every ENABLED page
  and query rule that ran and found nothing, at `urls: 0` (174 rows on the gate
  crawl, 128 of them zero). A rule the judgement disables is never a row, zero
  or not, and is named in `disabledRules`; a rule a list crawl did not measure is
  never a row either, and is named in `notMeasured` (§4.3). Metric rules never
  appear.
- **Not paginated:** at most one row per finding rule (174). It is an aggregate
  rather than an export, which is how it meets obligation 1. It is one
  `GROUP BY rule_id` plus the stored `site.health` row, read with the judgement
  inside one repeatable-read snapshot (ruling 14), so a concurrent `crawl_rules`
  cannot make it disagree with itself.
- **Refused (409):** an unjudged crawl, because an empty overview would read as
  a clean site; a crawl holding findings of a rule this ruleset lacks, as
  `issues_list` refuses it; a stored judgement overriding such a rule (§4.2).

Pinned: `test/api/issues-overview.test.ts:159` "issues_overview rows" (8 tests:
the distinct-URL count against `issue_urls` for every rule, a site-wide rule's
URLs, the ordering, the disabled rule, `includeZero`) and
`test/api/issues-overview.test.ts:261` "issues_overview refusals" (4 tests,
including the null `pagesJudged`).

### 4.3b `crawl_overview` → counts that describe the crawl

`GET /crawls/:id/overview/crawl`. Screaming Frog's crawl overview panel, built
from what the engine stores: `{crawlId, sections, notMeasured, judgementStale}`,
each section `{id, entries: [{label, value, percent}]}`, and `percent` the
entry's value over its section's total to one decimal place (null when that
total is 0). It describes the CRAWL, not the site's quality, so it is
**answered on an unjudged crawl too**; what that crawl cannot measure is named,
never zero. The gate crawl's `urls` section, as it came back (2026-11-08):

```json
{"id":"urls","entries":[{"label":"Encountered","value":602,"percent":100},
 {"label":"Fetched","value":600,"percent":99.7},
 {"label":"Not fetched (frontier)","value":0,"percent":0},
 {"label":"Blocked by robots.txt (stored)","value":2,"percent":0.3},
 {"label":"Blocked by robots.txt (dropped)","value":0,"percent":null}]}
```

Its ten sections, in this order: `urls`, `fetch-class`, `status-class`,
`content`, `indexability`, `click-depth`, `discovery`, `response-time`,
`render`, `issues-grid`.

- **`urls` is `crawl_status`'s own fields** (ruling 10), read through the same
  function inside the overview's snapshot. Encountered is every frontier row
  (`pending + leased + done + failed + renderPending`) plus
  `robotsBlocked.recorded`, because a robots-blocked URL is a `pages` row and
  never a frontier row. Fetched is `pagesCrawled`. Not fetched (frontier) is
  `pending + leased`. The two Blocked entries are `robotsBlocked.recorded` and
  `robotsBlocked.dropped`. Percents are against Encountered, except the dropped
  count: it counts DISCOVERIES turned away, is not a subset of Encountered, and
  has a null percent. **The entries are not a partition and are never asserted
  to sum**, because a resume reseeds `pagesCrawled`.
  **Excluded by scope (Phase 27d), only on a crawl whose config has `exclude` or
  `include`** (an unscoped crawl excludes nothing and shows neither entry):
  `Excluded by scope (stored)` is the crawl's stored `excluded` rows, which are
  `pages` rows like the robots-blocked ones, so they are INCLUDED in Encountered and
  carry a percent of it; `Excluded by scope (dropped)` is `crawl_status.excludedDropped`,
  the discoveries turned away past the stored-row budget, a count of discoveries, not
  a subset of Encountered, with a null percent. The dropped entry is left out (not
  zero) on a crawl whose counter is null. The stored rows are also in the `fetch-class`
  and `indexability` partitions below (`excluded`, `Excluded by crawl settings`). Before
  27d this section did not count them at all, and a scoped crawl's Encountered read
  low. Pinned in `test/api/crawl-overview.test.ts` (the scoped-crawl cases).
- `fetch-class`, `status-class`, `indexability`, `click-depth`, `discovery` and
  `response-time` are each a partition of the crawl's `pages` rows (each summed
  to the gate crawl's 602), with percents against that count. `status-class` is
  `2xx` to `5xx` and `No response`, plus `Other status` only when a code outside
  200–599 was stored. `indexability` is `Indexable`, then each non-indexable
  reason as `issue_urls` spells it; its Canonicalised reason uses the SQL rules'
  canonical predicate, which counts a page whose canonical is relative,
  non-ASCII or has dot segments as Indexable (ruling 8: the overview agrees with
  what the rules judge). `click-depth` is `0`–`9`, `10+` and `Unreachable`.
  **It counts EVERY `pages` row**, like the other partitions, so `Unreachable`
  (a null `click_depth`) includes redirects, error pages and robots-blocked rows,
  not only orphaned HTML. That is a different population from the metric
  `structure.click-depth-distribution`, which counts the judged cohort (fetched OK,
  200, indexable, not canonicalised elsewhere; §6), so the two do not agree
  bucket for bucket; read the metric when the question is
  how deep the judged pages sit.
  `discovery` is one entry per `discovered_via`, then `In a sitemap` /
  `Not in a sitemap`.
- **`response-time` buckets are fixed** (Deviation 5): `Under 250 ms`,
  `250–500 ms`, `500–1000 ms`, `1000–2000 ms`, `2000+ ms`, each `[lo, hi)`, and
  `No response time`. Then `Over SLOW_MS (<n> ms)` counts the pages strictly over
  the crawl's stamped `SLOW_MS`, across ALL pages, so it can exceed
  `performance.slow-response`, which judges only indexable, self-canonical pages
  (on the gate crawl at `SLOW_MS` 500: 6 pages over, 4 findings).
- `content` is `HTML: <page type>` over the `ok` pages, `Non-HTML: PDF | Image |
  CSS | JavaScript | Other` over the `non_html` ones, and `Resource: Image | CSS |
  JavaScript` over the `resources` rows, **each percent against its own group's
  subtotal** (ruling 13). `too_large` and `unsupported_encoding` pages are in
  neither page group, because no body was read.
- `render` is `Pages rendered` (counted live) and `Render coverage (<ran | none |
  failed>)` from the stored `render.coverage` metric (ruling 12).
- `issues-grid` is the stored findings by `type/priority` (`issue/high` to
  `opportunity/low`), **after the crawl's overrides, with the disabled rules'
  findings left out**. On the gate crawl it summed to `findingsCount` (3,202).
  With `title.same-as-h1` disabled it summed to 2,864, and a retype moved
  `images.empty-alt`'s 446 findings from `warning/low` to `issue/low` with no
  run.

**`notMeasured`** is `[{id, reason}]`. It names a whole section the crawl could
not measure (`click-depth` and `issues-grid` on a crawl no rules run has
judged, `render` on a crawl that never rendered), and MAY name one entry of a
measured section (`render-coverage` on a rendered crawl not yet judged,
`robots-blocked-dropped` on a crawl that predates the counter). The dev
database's unjudged crawl from before migration 0020, `crawl_a696e51a`, came
back with `click-depth`, `issues-grid`, `render` and `robots-blocked-dropped`
named, and those sections and that entry absent rather than written as zeros
(§5.7).

Pinned: `test/api/crawl-overview.test.ts:247` "crawl_overview on a judged,
unrendered crawl" (9 tests, among them `test/api/crawl-overview.test.ts:266`
"takes every urls entry from the crawl_status field it names"),
`test/api/crawl-overview.test.ts:418` "crawl_overview on other crawls" (7 tests:
the unjudged, rendered and pre-0020 crawls, and the route), and
`test/api/crawl-overview.test.ts:507` "the overviews read the judgement inside
their snapshot".

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
| `excluded` (Phase 27c: the crawl's own scope refused it, never requested) | Non-Indexable | `Excluded by crawl settings` |
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

Pinned: `test/api/query.test.ts:1292` "returns the URL slice with the evidence as
stored", `test/api/query.test.ts:1473` "never leaks a column the projection did
not name", `test/api/query.test.ts:1481` "carries a finding with no page as a
null url", `test/rules/helpers.test.ts:697` "maps each fetch class to the status
a reader acts on", `test/rules/helpers.test.ts:717` "names a block a block,
whatever status the challenge was served with",
`test/fixtures/harness.test.ts:1293` "declares a column for every evidence key it
writes, and writes every column it declares",
`test/rules/registry.test.ts:776` "finds one defining file per rule, and the key
spelled inside it".

**A rule the crawl's judgement disables is refused, 409** (Deviation 3), and so
is its `issue_urls` CSV view, before the first byte: the findings are stored,
and an empty page here would read as "this rule found nothing". The gate crawl
answered `rule 'title.same-as-h1' is disabled on crawl
'crawl_4dd32709-56c9-4a62-9af4-7a843f76ff6c'; re-enable it with crawl_config_set
to list its findings`. `issue_inlinks` refuses a disabled rule the same way.
**A rule a list crawl did not measure** (`notMeasured`, §4.3) is refused 409 by
`issue_urls` and its CSV view on the same terms, naming `crawl.list-mode`: an
empty page would read as "clean" where nobody looked (27c final wave).
Pinned: `test/api/judgement-surfaces.test.ts:169` "issue_urls and issue_inlinks
refuse a disabled rule with CONFLICT naming it",
`test/api/judgement-surfaces.test.ts:224` "the issue_urls CSV of a disabled
rule is refused before a byte".

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
count their own entries, under one set of headings, so the eight site-only
columns (three until Phase 26c added five) are null on every document row by
design, and the three cap columns are null on the site row of a crawl whose
discovery predates 26c. Numbers cross as numbers (the
client formats), percentages as numbers under a label ending `(%)`, booleans as
`true`/`false`.

**`note` is present exactly when `rows` is empty**, and says which empty it is:
a judged crawl whose metric measured nothing, a metric a list crawl did not
measure (it says so, naming `crawl.list-mode`, since the 27c final wave), or a
metric whose rows hold an empty list. The two answers that are NOT an empty table are refusals, both
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

Pinned: `test/api/query.test.ts:1591` "serves the metric's copy, its header and
one row per scope", `test/api/query.test.ts:1667` "puts both sitemap scopes in
one table, with the site-only cells empty",
`test/api/query.test.ts:1738` "says which kind of empty a rowless table is, and
refuses the two that are not", `test/api/query.test.ts:1774` "serves the same
header on the catalog, and only on metric rules",
`test/api/mcp.test.ts:2196` "answers one metric's table: the copy, the header,
and one row per scope",
`test/rules/metric-table.test.ts:377` "gives every metric rule a table whose
columns are the catalog's",
`test/fixtures/harness.test.ts:2389` "renders every metric's table, with no
empty column and no unmapped key".

**`judgementStale`** (Phase 27a) is the answer's last key, `crawl_status`'s flag
(§4.2): the table is what the last rules run stored, so a stale judgement means
these numbers predate the crawl's current settings. The gate crawl's
`site.health` table came back with `"judgementStale":{"stale":false,"reasons":[]}`
after its re-judge. Pinned with `metrics_get`'s below.

### 4.5 `metrics_get` → `{items: MetricRow[], nextCursor, notMeasured, judgementStale}`

`{metricId, scope, scopeValue, value, title, explanation, checkIds, category}`
per row, and since Phase 27a `judgementStale` beside `items` and `nextCursor`
(`crawl_status`'s flag, §4.2). Since the 27c final wave, `notMeasured` (§4.3):
the metrics (and rules) a list crawl's rules run left out, as `{id, reason}`, so an
empty page for one reads "not measured", never "nothing to measure". A metric is a measurement the last rules run
stored, and `site.health` counted only the findings of the rules that run left
enabled, so a stale judgement means these numbers predate the crawl's current
settings: a rule disabled since is still in `site.health`'s counts, and a rule
re-enabled since is still out of them, until `crawl_rules` re-runs
(`test/api/judgement-config.test.ts:726` "brings the group back at once while
site.health keeps the disabled run's value"; the flag itself,
`test/api/judgement-config.test.ts:599` "judgementStale on crawl_status,
metrics_get and metric_table").
`value` is the metric's own object — its shape belongs to the metric, and the
copy travels with it. Scopes: `site | page_type | sitemap_doc` (`rule` was never
one — corrected in P21-T1, beside §4.4b). See §6 for
`site.health` and for the absent-family trap.
Pinned: `test/api/query.test.ts:1515` "returns the stored value with the
registry's copy joined", `test/api/mcp.test.ts:2167` "answers the measured
numbers with their copy joined".

**One field inside one metric's value that this contract does pin, because it
governs how the rest of that value is read** (P12-T4): `render.coverage`'s
`renderPassEvidence`, `"ran"`, `"none"` or `"failed"`. The four `selection*` numbers beside
it are RECOMPUTED from the crawl's own columns — the render selection has no
table of its own — so before this field a crawl nobody had ever rendered
answered `selectionSelected: 18` exactly as a crawl rendered last week does, and
`pagesRendered: 0` was the only thing saying otherwise. It is not enough: a pass
that ran and rendered nothing writes the same zero. `"ran"` means something on
this crawl was written by a render pass — a rendered page, a `render_error`, a
named URL list, the pass's stamped count, or a page still queued for a browser.
`"none"` means none of that is there, so the selection numbers are what a pass
WOULD choose and no absence of rendered evidence is a fact about the site.
`"failed"` (Phase 25, ruleset 0.19.0) means the LAST render pass was asked for
and could not start: `renderLaunchError`, a sibling key in the same
`render.coverage` value, is a classified sentence (never raw resolver or
transport text, a stack or a path) or null, the pages it selected stay pending
and a later pass retries them. Rows an EARLIER pass rendered (`pagesRendered` or
`renderFailures` above 0) remain that pass's evidence and its findings stand;
NOT MEASURED applies only to what no pass rendered, and to the whole check only
when both counts are 0. `"failed"` is neither "rendered" nor "no render
needed". `"failed"` takes precedence over `"ran"`; the closed vocabulary is
`ran`, `none`, `failed`. Read it before quoting any JavaScript finding. Pinned:
`test/api/mcp.test.ts:1472` "says over the wire whether a render pass ran, not
just how many pages it left", `test/api/http.test.ts:1775` "serves
renderPassEvidence none beside the selection a pass would make",
`test/rules/render-metrics.test.ts:536` "answers none on a crawl nobody
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
Pinned: `test/api/query.test.ts:1794` "returns a slim projection and nothing
else" (the widened projection, pinned as a whole set),
`test/api/query.test.ts:1832` "carries both observations, and never lets the
second rewrite the first", `test/api/mcp.test.ts:2319` "names every field of the
row it answers with, in its own description", `test/api/query.test.ts:1935` "carries both word counts, so the number a
reader quotes is the one they can see", `test/api/mcp.test.ts:2253` "answers the
crawled pages, slim and ordered by URL".

### 4.7 `robots_get` → the robots.txt this crawl obeyed

`{crawlId, robotsUrl, outcome, raw, truncated, crawlDelaySec, note,
sitemapSources[], suppliedSitemaps[], userAgent}`. It is **stored evidence, never
a re-fetch**: the file as the crawl read it, which is the only honest answer to
"what did this crawl obey". `outcome ∈ read | absent | unreachable`, and
`unreachable` is not "there are no rules" (RFC 9309 §2.3.1.4).
Pinned: `test/api/query.test.ts:1983` "answers with the robots.txt the crawl
read, and the metadata that makes it readable", `test/api/mcp.test.ts:2356`
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
Pinned: `test/api/query.test.ts:3434` "narrows the listing to one site, and
leaves the other site's crawls out", `test/api/query.test.ts:3440` "matches the
apex and www spellings, both schemes", `test/api/query.test.ts:3454` "refuses a
siteUrl that is not an http(s) URL rather than dropping the filter";
`test/api/mcp.test.ts:2062` "narrows crawl_list to one site".

**Pre-tenancy posture, stated plainly (see §9).** Without `siteUrl`, this
listing returns every crawl the engine holds, including other tenants'
`siteUrl`s, to any caller holding the token.

### 4.9 `crawl_config_get` / `crawl_config_set` → the crawl's settings and judgement

`GET /crawls/:id/config` and `PATCH /crawls/:id/config` (Phase 27a, widened in 27b
from the `judgement` part to the crawl's own fields under the same names and routes).
Both answer `{crawlId, crawl, mutability, judgement, thresholds, judgedWith,
judgementStale}`; the paragraphs below describe the judgement half, and the **crawl
half** follows them. The gate crawl,
as it came back after its last re-judge (2026-11-08, after migration 0033; 18 of
the 20 thresholds elided in `thresholds`, every one has the same five keys, and 16
of the 20 in `judgedWith.thresholds`, which always holds all 20):

```json
{"crawlId":"crawl_4dd32709-56c9-4a62-9af4-7a843f76ff6c","judgement":{},
 "thresholds":{"TITLE_MIN":{"value":30,"default":30,"min":1,"max":200,"overridden":false},
               "SLOW_MS":{"value":1500,"default":1500,"min":100,"max":60000,"overridden":false},
               "…":"…"},
 "judgedWith":{"disabledRules":[],
               "thresholds":{"TITLE_MIN":30,"TITLE_MAX":60,"SLOW_MS":1500,
                             "UNAVAILABLE_AFTER_WARN_DAYS":30,"…":"…"}},
 "judgementStale":{"stale":false,"reasons":[]}}
```

- **`judgement`** is the crawl's block, `{}` when nothing is set:
  `{rules?: {[ruleId]: {disabled?: true, type?, priority?}}, thresholds?:
  {[name]: number}, findingCap?: number | null}`. `findingCap` appears when the
  crawl's config sets one (`null` is uncapped) and is absent when the default of
  200 applies. It is stored where it always was, `config_jsonb.findingCap`
  (Deviation 1), so `crawl_status.findingCap`, `crawl_start`'s top-level key and
  this block read and write one value.
- **`thresholds`** lists ALL 20 overridable thresholds as `{value, default, min,
  max, overridden}`: `value` is what the NEXT rules run will use, `overridden` is
  true where the block sets it, and `min` / `max` are the inclusive bounds. The
  names: `TITLE_MIN`, `TITLE_MAX`, `META_MIN`, `META_MAX`, `H1_MAX`, `H2_MAX`,
  `URL_MAX`, `SLOW_MS`, `TITLE_PX_MIN`, `TITLE_PX_MAX`, `META_PX_MIN`,
  `META_PX_MAX`, `DEEP_DEPTH`, `THIN_WORDS`, `SOFT_404_WORDS`,
  `IMAGE_WEIGHT_WARN`, `CHAIN_HOPS`, `HIGH_INTERNAL_OUTLINKS`,
  `HIGH_EXTERNAL_OUTLINKS`, `UNAVAILABLE_AFTER_WARN_DAYS` (20, not the 19 the
  plan's prose counted: ruling 5). Extraction-time limits, similarity distances,
  render heuristics, walk bounds and protocol limits are engine internals and
  are not overridable.
- **`judgedWith`** is the stamp the last completed rules run wrote of what it
  used, `{disabledRules, thresholds, findingCap?}`, or `null` on a crawl nobody
  has judged. Its `thresholds` holds ALL 20 names at the EFFECTIVE values that
  run used (its override, else the default then in force), not only the
  overrides, so it stays true when a later ruleset moves a default: the copy is
  rendered from these values, and a moved default reads stale `thresholds`. **`judgementStale`** compares it with the
  current block (§4.2).

**`crawl_config_set` takes `{crawl?, judgement?: <merge-patch>}` (at least one); its
`judgement` is an RFC 7396 merge-patch of the stored block,** and answers what `crawl_config_get` would
answer next. Objects merge key by key and `null` REMOVES a key:
`{rules: {"title.too-long": null}}` drops that rule's override,
`{thresholds: {SLOW_MS: null}}` returns `SLOW_MS` to its default, and
`{rules: null, thresholds: null}` clears every override (the stored block is
then `{}`). **`findingCap` is the one exception (ruling 7): `findingCap: null`
means UNCAPPED, exactly as at `crawl_start`, and is NOT a removal.** Reading
null as "remove the key" would turn an agent's "make this a billed, uncapped
audit" into the default cap of 200 without a word. To return to the default,
send `200`, which judges exactly as an absent key does and is not stale against
a default-cap run. The gate crawl's answer to `{judgement: {thresholds:
{SLOW_MS: 500}}}`, sent on top of three rule overrides, began:

```json
{"judgement":{"rules":{"images.empty-alt":{"type":"issue"},
                       "title.same-as-h1":{"disabled":true},
                       "meta-description.too-long":{"priority":"medium"}},
              "thresholds":{"SLOW_MS":500}},
 "thresholds":{"SLOW_MS":{"value":500,"default":1500,"min":100,"max":60000,"overridden":true},"…":"…"},
 "judgedWith":{"disabledRules":[],"thresholds":{"SLOW_MS":1500,"…":"…"}},
 "judgementStale":{"stale":true,"reasons":["overrides","thresholds"]}}
```

**When a change takes effect.** Rule overrides act on what is READ, at once:
`disabled` takes the rule's findings out of `issues_list`, `issues_overview`,
the `crawl_overview` issues grid, the `issues` CSV view and the `issues` JSONL
dataset, makes `issue_urls` / `issue_inlinks` refuse it, and marks it
`disabled: true` in `rules_catalog`. Removing the override brings every finding
back with no run, because a rules run executes every rule, disabled ones
included, and stores all their findings. `type` and `priority` change the value
every surface serves, with the `…Overridden` flag. **Thresholds and `findingCap`
change what a rules run PRODUCES, so they act at the next `crawl_rules`**: until
then the stored findings and their copy are the old run's, and
`judgementStale` says so. `site.health` is the one stored aggregate a rule
override reaches: it counted the findings of the rules enabled at the last run,
and stays that run's number (and `stale` stays true, reason `overrides`) until
the rules re-run.

**Refused, each by name, and nothing is written when a change is refused** (as
the gate crawl answered them, 2026-11-08):
- severity, at any path: `rules.title.too-long.severity: severity cannot be
  overridden: it is the engine's fact about the rule; change its priority or
  disable it instead` (400);
- a cross-pair violation on EFFECTIVE values: `thresholds.TITLE_MIN:
  thresholds.TITLE_MIN (70) must be strictly below thresholds.TITLE_MAX (60, the
  default)` (400); the pairs are `TITLE_MIN`/`TITLE_MAX`, `META_MIN`/`META_MAX`,
  `TITLE_PX_MIN`/`TITLE_PX_MAX`, `META_PX_MIN`/`META_PX_MAX`;
- a threshold out of its bounds or not an integer: `thresholds.SLOW_MS: Too
  small: expected number to be >=100` (400);
- a metric rule: `rules.site.health: 'site.health' is a metric rule; it
  produces no findings, so it cannot be disabled, retyped or reprioritised`
  (400);
- a rule id the ruleset does not define: `rules.no.such-rule: no rule
  'no.such-rule' in ruleset` (400: the REQUEST is wrong, so it is not a 409);
- a body with neither `crawl` nor `judgement`, a key beside those two, and a null or
  non-object `judgement` or `crawl` (400);
- an override emptied by the merge, such as `{rules: {x: {disabled: null}}}` on
  `{x: {disabled: true}}` (400: send `{x: null}` to remove it);
- **any change while `crawl_rules` is running over the crawl: 409**, `rules are
  running for crawl <id>: …`. Wait for the run to answer, then set it again.

**The crawl half (Phase 27b).** `crawl_config_get.crawl` is every setting the crawl
was stored with, at its effective value (`findingCap` lives in `judgement`, not here).
At start it equals what `config_validate` answered as `effective` for the body that
started it, minus `findingCap` and `judgement`, **with two Phase 27c departures**:
on a crawl started with credentials, `effective` carries `credentialShape` (the kinds
and names) where `crawl` shows the three credential fields themselves with every value
`"[redacted]"` (`requestHeaders: {<name>: "[redacted]"}`, `httpAuth: "[redacted]"`,
`cookies: [{name, value: "[redacted]"}]`, each present only when the crawl was given
it); and every crawl's `crawl` adds `scopeChangedAt` (ISO, or null until
`crawl_config_set` changes `exclude` or `include`). A list crawl's `crawl` also
carries `listUrlCount` and `listDuplicates`, as `effective` did; the URLs are never
shown. It diverges from `effective` after a `crawl_config_set`.
`mutability` says, per `crawl` key, when it can change: **`never`** (`siteUrl`,
`userAgent`, `probeHosts`, `legacyHosts`, `sitemapUrls`, `fetchResources`, since 27c
`mode`, `urls` and `maxUrlLength`, the reported facts `listUrlCount`,
`listDuplicates` and `scopeChangedAt`, and the operator-only stored budgets
`maxResources`, `maxResourceHosts`, `maxBlockedUrls` and `platformProfiles`, which are
reported but not in the published schema), **`whenPaused`** (`maxPages`, `maxDepth`,
`perHostDelayMs`, `maxConcurrency`, `renderBudgetPct`, `renderMaxPages`,
`renderSamplePerType`, and since 27c `exclude`, `include`, `maxRedirectHops`,
`requestHeaders`, `httpAuth` and `cookies`; accepted while the crawl is `queued` or
`paused`, so pause a running crawl, set, then `crawl_resume`) or **`always`**
(`judgement`). A credential sent back as `"[redacted]"` is "no change", like any field
sent with the value `crawl_config_get` shows; a partial redaction is refused. A
credential sent with values replaces that kind whole in the encrypted store (the
row stores only the new kinds and names), and an empty `requestHeaders` or `cookies`, or
`httpAuth: null` (the one `null` a crawl field accepts), drops it. A changed `exclude`
or `include` is checked as `crawl_start` checks it and stamps `scopeChangedAt`; the
resumed run applies it (§4.1a). `crawl_config_set`'s `crawl` is a set of NEW VALUES, each validated as
`crawl_start` validates it; `null` is refused (a crawl field has no unset). A `never`
or operator-only key sent with the value already stored is "no change" — not written,
not refused (Phase 27b ruling 12) — so get, edit one field, set the whole `crawl`
object back works. Refused, nothing written, `crawl` and `judgement` alike: a changed
`never` field (409, naming it; checked before any status check, so the refusal does
not depend on key order), a changed operator-only field (400), a change while the
crawl is `running` or closed (409 naming the status), a change to a `queued` crawl
this server has already taken off its queue (409: it is starting now and has read its
config; pause it first), `maxPages` below the pages already crawled or, on a list
crawl, below its distinct list (400, the start's wording; pinned:
`test/api/lifecycle.test.ts:1166` "refuses maxPages below the distinct list, as a start
does"), `perHostDelayMs` under the politeness floor (400), and any change while a
render pass or `crawl_rules`
runs over the crawl (409).
**A resumed crawl never runs faster than the spacing it earned** (hard rule 9): the
per-host record still wins over a lowered `perHostDelayMs`.

**The repair route.** A crawl whose STORED block overrides a rule this ruleset
does not define (a rule removed by a later release) is a 409 on every surface
that reads the judgement, `crawl_config_get` included, naming the rule (§4.2),
and on `crawl_rules` too, with the same text. The `crawl_rules` refusal comes
AFTER the run takes its in-process claim on the crawl (since 27b's final review the
claim is the first step, so a command arriving meanwhile meets the hold; this
sentence was corrected in 27c), and still before it touches a finding or the stamp.
`crawl_config_set` is the one surface that accepts the crawl in that state, so
that `{judgement: {rules: {<id>: null}}}` can remove the override. A patch that
leaves such an override in place is refused (400), naming its path.

Pinned: `test/api/judgement-config.test.ts:383` "crawl_config_set — PATCH
/crawls/:id/config" (12 tests: merge, removal, severity, unknown rule, repair,
`crawl_rules` refusing a removed rule's override, the 409 while the rules run), `test/api/judgement-config.test.ts:563`
"findingCap through crawl_config_set" (4 tests, including
`test/api/judgement-config.test.ts:575` "null is uncapped, as at crawl_start —
never a silent return to the default"), over MCP `test/api/judgement-config.test.ts:657`
"crawl_config_get answers what GET /crawls/:id/config answers" and
`test/api/judgement-config.test.ts:663` "crawl_config_set refuses severity with
the HTTP route's text", `test/api/judgement-config.test.ts:726` "brings the group
back at once while site.health keeps the disabled run's value",
`test/api/judgement-surfaces.test.ts:319` "re-enabling brings the findings back
at once, and the judgement is no longer stale" and
`test/api/judgement-surfaces.test.ts:332` "quotes the stamped value until the
rules re-run, and reports the staleness".

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

Phase 27a adds two spellings, both in §5.7: the Issues Overview's `null`
`pagesJudged` and `percentOfJudged`, and the Crawl Overview's `notMeasured`,
which names a section or an entry instead of writing zeros.

### 5.1 `rules_catalog` — three states of `fired`, and the `marker` flag

```json
{"rulesetVersion":"0.7.0","rules":[{"id":"links.orphan","kind":"query",
 "severity":"warning","category":"links","checkIds":["CHECK-32"],
 "title":"…","explanation":"…","howToFix":"…","fired":{"count":243}}]}
```

Since Phase 27a every rule that FINDS also carries `type` and `priority` (the
registry's defaults; a metric rule has neither key), so the catalog with no
crawl id is the triage table itself. **With a `crawlId` the crawl's judgement is
applied as well:** `type` and `priority` are that crawl's, with
`typeOverridden: true` / `priorityOverridden: true` where its judgement sets the
value; **`disabled: true`** marks a rule the judgement disables, which is still
listed, and whose `fired.count` still counts its stored findings (338 for the
gate crawl's disabled `title.same-as-h1`), while every findings listing and
export leaves them out; the answer gains `thresholds` (the 20 values, by name,
the crawl's findings were judged with) and `judgementStale`; and the copy is
rendered from those thresholds, so an override shows in the text only after
`crawl_rules` re-runs (the gate crawl's `performance.slow-response` title read
"Response time over 1500 ms" with `SLOW_MS: 500` set and stale, and "over 500
ms" after the re-run). Pinned: `test/api/judgement-surfaces.test.ts:186`
"rules_catalog keeps the disabled rule, flags it, and still counts its stored
findings", `test/api/judgement-surfaces.test.ts:355` "without a crawl the
catalog is the default rendering, with type and priority and no judgement
fields".

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
Pinned: `test/api/query.test.ts:4275` "leads the metric section with the site
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

Pinned: `test/api/query.test.ts:2517` "answers the whole ruleset with its
client-facing copy and no fired state", `test/api/query.test.ts:2597` "joins a
judged crawl's fired state, and counts a clean rule as zero",
`test/api/query.test.ts:2621` "marks a metric rule's structural zero apart from a
real clean", `test/api/query.test.ts:2647` "says fired null on a crawl nobody has
judged, however many rows it holds", `test/api/query.test.ts:2664` "marks a
capped rule's count as a floor, agreeing with issues_list",
`test/api/query.test.ts:2703` "reads the marker and the counts from one
statement", `test/api/query.test.ts:2559` "carries the registry's marker on every
NOT MEASURED marker, and on no other rule"; `test/api/mcp.test.ts:1883` "joins a
judged crawl's fired state, zero included, summing to findingsCount" and
`test/api/mcp.test.ts:1946` "names every field it actually answers with".

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
this); `test/api/query.test.ts:3055` "writes one row per referenced file, with
the class that makes an empty status readable" (all four spellings in the CSV);
`test/crawl/fetch-resources.test.ts:1339` "asks nobody anything when the operator
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
`test/db/migration-0014.test.ts:234` "leaves the column null on a row no crawl
loop ever closed"; `test/db/migration-0014.test.ts:212` "stamps 0 on a crawl that
lost nothing — a measurement, not a silence";
`test/api/query.test.ts:2435` "reports the cap-exceeded page count a crawl
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
contract, stated at the column); `test/api/query.test.ts:1832` "carries both
observations, and never lets the second rewrite the first" (the three nulls,
told apart row by row, and the `recheckAt` invariant over every row of a
listing); `test/api/query.test.ts:2379` "tells a crawl with no server errors
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
stated at the column); `test/db/migration-0017.test.ts:319` "holds
failure_reason IS NOT NULL => status = 'failed' over the table" (the implication
itself, asked as SQL over the whole table, with a real crawl on each side of it);
`test/db/migration-0017.test.ts:206` "closes the robots-502 crawl failed, with a
reason naming robots and the status" (a real crawl of a real host whose
robots.txt answers 502); `test/db/migration-0017.test.ts:259` "clears the
sentence when the failed crawl is resumed" (the implication over a RESUME, which
is the one move that changes the status without closing the crawl — the fixture
holds the robots request so the row is read mid-run);
`test/api/mcp.test.ts:3167` "clears the failure sentence of the crawl a resume
accepts" (the same, over the queue's own writer and on the wire);
`test/api/query.test.ts:4218` "tells a pre-0017 failed
crawl apart from a crawl that did not fail" (the two nulls, on the wire).

### 5.7 The overviews: `pagesJudged`, `percentOfJudged` and `notMeasured`

Phase 27a's two overviews keep the doctrine, and each has its own spelling of it.

**`issues_overview`: `pagesJudged` and `percentOfJudged`.**

| answer | spelling | what it means |
|---|---|---|
| a number | `"pagesJudged": 446` | `site.health`'s Pages Judged, as the last rules run stored it; each row's `percentOfJudged` is `urls` over it, to one decimal |
| zero | `"pagesJudged": 0` | a measurement: the run judged no page. Every `percentOfJudged` is `null`, because there is nothing to be a percentage of, never `0` |
| null | `"pagesJudged": null` | the crawl has no `site.health` row: judged by a ruleset before the family existed, or its metric rows are gone. Every `percentOfJudged` is `null`; `urls` still counts |

A `site.health` row that is there and cannot be read (a `urlsTotal` that is not
a number) is a loud error, never `null` (hard rule 7). And the overview of a
crawl nobody has judged is not an empty `rows`: it is **refused** (409), because
an empty overview reads as a clean site. In the CSV view a `null`
`percentOfJudged` is an empty `% of Judged` cell. Pinned:
`test/api/issues-overview.test.ts:277` "answers pagesJudged null (and
percentOfJudged null) with no site.health row",
`test/api/issues-overview.test.ts:285` "throws on a malformed site.health row
rather than reading it as null", `test/api/issues-overview.test.ts:262` "refuses
an unjudged crawl with CONFLICT", `test/api/issues-overview.test.ts:309` "writes
an empty % of Judged cell when pagesJudged is null".

**`crawl_overview`: `notMeasured`.** (The listings' `notMeasured`, §4.3, has the same
`{id, reason}` shape.) A section the crawl could not measure is
ABSENT from `sections` and named in `notMeasured` as `{id, reason}`; an entry
of a measured section can be named the same way. Never a section of zeros. The
reasons, verbatim (`NOT_MEASURED_REASONS` in `src/api/overview.ts`):

| id | names | reason |
|---|---|---|
| `click-depth` | the section, on a crawl no rules run has judged | `click depth is derived by the rules run; run crawl_rules` |
| `issues-grid` | the section, on a crawl no rules run has judged | `no rules run has judged this crawl; run crawl_rules` |
| `render` | the section, on a crawl that never rendered | `no render pass ran` |
| `render-coverage` | the `Render coverage` entry, on a rendered crawl not yet judged | `render coverage is a rules-run metric; run crawl_rules` |
| `robots-blocked-dropped` | the `urls` section's dropped entry, on a crawl before migration 0020 | `the robots-blocked overflow was not counted on this crawl (it predates migration 0020)` |

Three things in a measured section look like gaps and are not: a `0` entry is a
count (the gate crawl's `5xx: 0`); `Unreachable` in `click-depth` is a
measurement (pages no internal link reaches); and the dropped entry's `null`
percent means "not a share of Encountered", not "not measured". In the CSV view
each `notMeasured` item is a row after the entries, `<id>,Not measured:
<reason>,,` with empty Value and Percent cells. Pinned:
`test/api/crawl-overview.test.ts:248` "lists the measured sections in order and
names render as not measured", `test/api/crawl-overview.test.ts:441` "names
render coverage as not measured on a rendered crawl no rules run judged",
`test/api/crawl-overview.test.ts:452` "names an uncounted robots overflow
(pre-0020 crawl) instead of writing 0", `test/api/crawl-overview.test.ts:545`
"crawl_overview names issues-grid and click-depth as not measured, never zeros",
`test/api/crawl-overview.test.ts:566` "has the exact header and one row per JSON
entry, then the not-measured rows".

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
- **It counts the findings of the rules ENABLED when the rules ran** (Phase
  27a). A rule the crawl's judgement disables still runs and its findings are
  stored, but `site.health` skips them, and it is the one stored aggregate a
  rule override reaches. So it is that run's number until `crawl_rules` runs
  again: disable a rule and the buckets still count it, re-enable one disabled
  at the run and they still leave it out, and `judgementStale` reads `overrides`
  in between (§4.2). Retyping and reprioritising never touch it: the buckets are
  by severity, which is not overridable. `urlsTotal` is the Issues Overview's
  `pagesJudged` (§4.3a).
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
`test/rules/health-metrics.test.ts:47` "carrying the engine-coverage check it is
evidence for", `test/rules/health-metrics.test.ts:221` "partitions the census
exactly", `test/rules/health-metrics.test.ts:255` "answers an empty census with a
null ratio", `test/rules/health-metrics.test.ts:279` "lets no site-level finding
poison a page bucket", `test/rules/health-metrics.test.ts:304` "keeps the pages
it cannot judge out of the buckets", `test/rules/health-metrics.test.ts:353`
"sets a noindex 200 aside in its own column rather than in a bucket",
`test/rules/health-metrics.test.ts:392` "counts a page that both noindexes and
canonicalises under noindex", `test/rules/health-metrics.test.ts:414`
"partitions every fetched URL over the four columns",
`test/rules/health-metrics.test.ts:567`
"buckets the findings the capped run wrote, and no others"; the copy contracts —
`test/rules/copy.test.ts:1524` "names every column and the population they
are over", `test/rules/copy.test.ts:1549` "says the counts are the authority, not the
ratio", `test/rules/copy.test.ts:1566` "grades nothing: no score, no label, no
threshold";
`test/rules/coverage.test.ts:614` "site.health is filed under the
engine-coverage check, and CHECK-32 lost no claimant" (the re-file in both
directions, and CHECK-83 outside the crawl-derived universe);
`test/fixtures/harness.test.ts:3282` "the health rollup agrees with a
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
| `judgement-overrides` | a side's judgement (Phase 27a, §4.9) disables rules; the message names the crawl and the rules. Their stored findings ARE counted in the comparison, while that crawl's `issues_list` leaves them out. It does not change `comparable` (Deviation 6) |

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
site cannot be decided"), never "different sites". So is a side whose stored
judgement overrides a rule this ruleset does not define (Phase 27a, §4.2), naming
the crawl and the rule; `crawl_config_set` on that crawl is the repair. Pinned
for the caveat: `test/api/judgement-config.test.ts:686` "adds a
judgement-overrides caveat naming the crawl and the count".

**The self-compare 400 has a UI consequence Talos should design for.** A compare
screen that defaults both pickers to the newest crawl refuses on first render.
Default the two sides to *different* crawls, or hold the request until the user
has chosen a second one — the refusal is right (a crawl diffed against itself
reports every rule `persisting` and every change zero, which a dashboard would
paint as "nothing changed on this site") and it is not an error state worth
showing a user.

Pinned: the whole `GET /compare` and `GET /compare/urls` blocks of
`test/api/query.test.ts` — the arithmetic, the per-URL collapse, every caveat and
every refusal — of which `test/api/query.test.ts:3503` "answers both sides,
comparable, and the rules in issues_list's order" is the answer itself and
`test/api/query.test.ts:3917` "makes the same refusals as the summary" is the
drill-down inheriting the summary's refusals; over the agent transport,
`test/api/mcp.test.ts:2009` "answers the counts and the caveat when the two
rulesets differ" and `test/api/mcp.test.ts:2074` "names every field it answers
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
| `findingCap` | 200 | `null` = uncapped, which is what a billed audit wants. It changes what every count in §5 and §7 means. Since Phase 27a it can also be changed after the crawl, through `crawl_config_set`'s `judgement.findingCap` (null = uncapped there too), and takes effect at the next `crawl_rules` (§4.9). |
| `judgement` | none | Rule overrides, threshold overrides and `findingCap` from the first rules run (§4.1, §4.9). Not a politeness knob: it changes how the crawl is judged, never what is fetched. |

Not settable over the wire at any value: `allowPrivate` (refused by name, on
both transports).

**What the engine does on its own:** robots.txt `Crawl-delay` is honoured
alongside the configured delay; a `blocked` answer halves the concurrency
window; a refusal that NAMES a rate (429, or anything carrying `Retry-After`)
doubles that host's spacing, capped at 30s; a refusal that names no rate
escalates only after three refusals across two URLs. Since Phase 24a a host that
then answers 50 times cleanly in a row steps down one level, and a host that
escalates again after recovering is locked at its spacing for the rest of the
crawl (`crawl_status.throttle` records 429s, escalations, recoveries and the lock
per host). A site whose own headers name a platform gets that platform's profile
before the first worker starts: Shopify runs at one request in flight and at least
1000 ms per host, one render browser and a render budget of at least 60 s, whatever
`maxConcurrency` asked for (`crawl_status.platformProfile` records what was
applied). The render pass inherits the crawl's per-host spacing and paces every
same-origin request through the same gate. A
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
  `test/api/query.test.ts:3981` "carries no path, no document and no stack in any
  answer this phase added" and `test/api/query.test.ts:4024` "holds for the CSV
  bytes, which are a response like any other".
- Refusals name **the caller's own words** — the ids they supplied, the field
  they misspelled, the accepted vocabulary — plus, for a cross-site compare, the
  two hostnames the caller asked about.
- Anything unexpected becomes `{error: "internal error", correlationId}` at both
  transports.
- Rule `evidence` is built from crawled rows by the registry's own discipline;
  the wrapper around it is a closed shape.

Six postures a Talos integrator should know about rather than discover:

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
4. **Crawl listing is tenant-scoped (met in Phase 28a).** `crawl_list` returns only the
   caller's crawls, whatever `siteUrl` is or is not passed, and every per-crawl read and
   command resolves the crawl by (id, tenant). Retired: the deployment mitigation (one
   Ariadne per tenant, or a proxy that forces `siteUrl`). Pinned by
   `test/api/tenant-isolation.test.ts`.
5. **`crawl_delete` is hard, and its only guard is the confirm echo.** It removes the
   crawl's rows and its render and export files with no undo and no soft delete, and
   it refuses a queued or running crawl, a pending request, a crawl in use in this
   server, and live leases (§4.1c). **Met in Phase 28a:** a crawl of another tenant
   answers 404, so a caller can delete only its own crawls; the confirm echo remains
   the guard against a mistaken delete.
6. **A crawl's credentials never come back** (Phase 27c). `requestHeaders`,
   `httpAuth` and `cookies` values are stored only as AES-256-GCM ciphertext (Phase 28b;
   before it, in memory) and appear in no readable stored column, log line, metric, error message or response: refusals name the field and
   a header or cookie NAME, never a value; `crawl_config_get` shows `"[redacted]"`;
   the stored request-header evidence redacts the custom header names as it already
   redacted `authorization` and `cookie`. The names themselves are stored and shown,
   so do not put a secret in a header or cookie NAME. Pinned by the secret scan,
   `test/fixtures/scope-and-requests.test.ts:339` "after a crawl with all three
   credential kinds and a render pass, no secret is in any stored column or the log",
   which reads every text and jsonb column of every crawl-scoped table.

---

## 10. What Ariadne will not do

- **No grades, scores, labels or thresholds.** `site.health` ships counts and a
  ratio and says in its own copy that it grades nothing; a copy test asserts the
  judgement vocabulary appears nowhere in it. Severity-in-context is the
  consuming agent's job.
- **No revenue or business judgement.** The engine has no idea what a page is
  worth. It measures.
- **No prioritisation of THIS site on the engine's own authority.** Since Phase
  27a every finding rule carries a `type` and a `priority` beside its severity,
  and they are the RULE's defaults: the engine's opening bid on what such a
  finding usually is and what fixing it is usually worth, referenced against
  Screaming Frog's Issue Type and Issue Priority. They are properties of the
  rule, not of this site. The agent overrides them per crawl (`crawl_config_set`,
  §4.9), and the agent's overrides are the judgement; a dashboard should render
  the served values, which already carry them, and may show the
  `…Overridden` flags as "set by the agent". Severity stays the engine's fact
  and is never overridable. Nothing ranks one site's findings against business
  value, traffic or revenue: that is the consumer's call.
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
- **No plaintext credentials, no login flows, no robots override** (Phase 27c, 28b). Basic
  auth, cookies and custom headers are kept encrypted for the crawl (28b; re-supplied
  only when the stored copy is unreadable); there is no form login, no JavaScript-driven login and no session
  refresh. No credential, header or cookie changes the user agent, the delay floor
  or robots.txt. No regular expressions in scope patterns, and no proxies.
- **No per-tenant tokens** (Phase 28a): one bearer token per server proves the caller
  is Talos, and the tenant header says whom it acts for; tenancy is a key, not an
  identity system.
- **No writes from a read surface.** Every query path runs read-only; the nine
  command tools (`crawl_start`, `crawl_resume`, `crawl_render`, `crawl_rules`,
  `crawl_mark_failed`, `crawl_config_set`, `crawl_pause`, `crawl_cancel`,
  `crawl_delete`) are the only things that change anything. `config_schema` and
  `config_validate` read, and a dry run starts nothing.

---

## 11. Versioning, and what a ruleset change does to a served crawl

`RULESET_VERSION` (**0.25.1** as of Phase 28b) stamps **judgement**: bump it when
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

**Phase 27a bumped to 0.23.0, once, on the client-facing-copy ground: no verdict
moves.** Every finding rule gained a `type` and a `priority` (§4.3), which is
client-facing judgement served beside every finding, and issue copy became a
template rendered from the thresholds a crawl was judged with (§5.1): at the
default thresholds every title, explanation and fix is byte for byte the 0.22.0
text. No rule was added or removed and no finding, severity or metric moved.
Re-judging the stored lavishalice crawl under 0.23.0 (`docs/gates/phase-27a.md`)
wrote the same 3,202 findings over the same 46 rules, rule by rule, as the stored
run it replaced.
A crawl compared across the boundary raises `ruleset-mismatch` all the same,
because the stamp is the version; the counts beside it do not move for this
reason. Migrations 0031 and 0032 add the judgement block and the run stamp
(0032 backfills the stamp on every crawl judged before them, as "no overrides,
the cap it was judged with"), and 0033 rewrites every stamp's thresholds to the
20 effective values (the 0.22.0 / 0.23.0 defaults under its overrides), so an
old judged crawl reads `judgementStale` false, not an error.

**Phase 26c bumped to 0.22.0, once: six ids, every hreflang rule widened to
three sources, and a re-crawl attached.** The ids and the widened readings are
listed at the top of this document; no existing rule's severity moved. The
sixth id, the marker `hreflang.declarations-incomplete`, came with the PR #24
review under the same, unreleased version: from it on, the four absence-based
hreflang rules answer nothing on a crawl whose sitemap walk was cut short, and
skip a set at the 200-pair limit, so a crawl re-judged at 0.22.0 can lose
findings it had before the review as well as gain the marker. The phase
also moves `EXTRACTION_VERSION` to 3 (migration 0029), and its discovery records
every sitemap listing and alternate (`discovery.sitemapFacts`), so the marker
`extraction.not-recorded` now fires on any crawl with a page below version 3 or
without those facts — every crawl written before 26c, including a 26b one — with
`requiredVersion: 3` and `sitemapFactsRecorded`. The v3 and sitemap-fact rules
are silent on such a crawl rather than clean. Rules that read only older facts
judge it as before, with two differences: `sitemap.over-50k-urls` now refuses a
crawl without listings (the marker speaks) where it used to give a lower bound,
and the hreflang integrity rules read a code case- and separator-blind (`en_GB`
and `en-gb` are one code), with `sources` added to their evidence.
Migration 0030 backfills `resources.share_image` on older crawls, so the
resource rules judge them exactly as 0.21.0 did. A crawl compared across the
boundary differs because there is more to see, and `crawl_compare` raises
`ruleset-mismatch` across it.

**Phase 26b bumped to 0.21.0, once: new ids, three widened readings, and a
re-crawl attached.** Twenty-eight ids joined (listed by family at the top of this document)
and no existing rule's severity moved. Unlike 26a, 24 of the new rules read page
facts the crawler records only from this phase on (`EXTRACTION_VERSION` 2,
migrations 0026, 0027 and 0028), so re-judging an old crawl does not produce them: the
marker `extraction.not-recorded` fires instead, once per crawl, and those checks
read NOT MEASURED, never clean. Query rules refuse a crawl with any page below
version 2 as a whole; page rules are silent on a page row whose new columns are
null. Re-judging the Phase 25 gate crawl (lavishalice.com, 602 rows, all version 1;
`docs/gates/phase-26b.md`) left all 1,907 findings of the older rules
identical in rule, page, severity, key and evidence (only the `ruleset_version`
stamp moved) and every metric row identical, and added 572 findings: the marker
(`pagesNotRecorded` 602, `pagesRecorded` 0) and the three rules that read columns
every crawl has (`title.same-as-h1` 335, `h2.missing` 233, `social.og-duplicate`
3). Three changes reach rules that existed before, and only on a re-crawled page.
First, the stored robots value joins every `<meta name="robots">`, so a `noindex`
in a second robots meta now makes a page non-indexable and moves every rule and
metric that reads indexability. Second, `security.mixed-content` also counts
`http:` iframes and media, and `images.missing-alt`,
`head.directives-outside-head` and `head.tags-outside-head` gain optional
evidence. Third, share images become `resources` rows with no page reference, and
every resource rule, metric and NOT MEASURED marker judges only files a page
loads, so a share image never moves page weight or `resources.broken`. A crawl
compared across the boundary therefore differs because there is more to see, and
`crawl_compare` raises `ruleset-mismatch` across it.

**Phase 26a bumped to 0.20.0, once, on the additive ground.** Forty ids joined
(listed by family at the top of this document), and no existing rule's verdict,
severity or copy moved. Phase 25's bump to 0.19.0 was the `failed` value of
`render.coverage` (§4.5). The new rules read only what a crawl already stores
(stored response headers, robots values, canonicals, hreflang rows, links,
sitemap entries, titles and descriptions), so `crawl_rules` over an existing
crawl writes them with no re-crawl. Re-judging the Phase 25 gate crawl
(lavishalice.com, 602 rows, `docs/gates/phase-26a.md`) left all 1,270
findings of the older rules byte-identical, added 635 findings from nine of
the new ids, and changed exactly one metric row. That row is `site.health`:
its partition counts findings, so pages moved between `urlsWithInfoOnly` and
`urlsWithWarningOnly` as the new warnings landed. A health gauge compared across
the boundary moves because there is more to see, not because the site changed,
which is the reason `crawl_compare` raises `ruleset-mismatch` across it. Three
cases need a consumer's attention. First, the two security-header rules refuse a
crawl with any page written before migration 0025 and fire
`security.headers-not-recorded` instead, so an old crawl re-judged at 0.20.0
gains a marker there, not a clean result. Second, `issues_list` with
`checkId: "CHECK-08"` was refused as metric-only before 0.20.0 and answers
now, because `sitemap.over-50k-urls` claims it. Third, `checkId: "CHECK-33"`
changed the same way, because `links.internal-nofollow` and
`links.high-outlinks` claim it.

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
   total (`test/api/query.test.ts:1267` "500s a truncation note it cannot read
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
answers `{format, view, ruleId?, metricId?, path, rows, bytes, disabledRules?, notMeasured?}`
(`notMeasured` as `{id, reason}[]`, §4.3).
`rows` counts **data rows**; the header is always written and never counted.
`disabledRules` is on the answer of the four views that read findings
(`issues`, `issue_urls`, `issues_overview`, `crawl_overview`), with `notMeasured`
(§4.3: what a list crawl did not measure, with a reason each) beside it, and both are absent on the
rest.

| view | columns | one row is | measured on `crawl_02ff6f7a` |
|---|---|---|---|
| `issues` | ruleId, severity, type, priority, category, checkIds, url, title, evidence | one finding | 17,659 rows / 5,315,760 B |
| `issue_urls` (needs `ruleId`) | **the rule's own** — `rules_catalog`'s `columns` labels, then `Truncated` | one finding of one rule | 243 rows (`links.orphan`) |
| `internal_urls` | url, status, fetchClass, indexable, clickDepth, pageType, title, recheckFetchClass, recheckStatus, recheckAt | one crawled page | 551 rows |
| `links_to_4xx` | Source, Destination, Anchor, Status Code | one internal link to a 4xx page | 99 rows |
| `links_to_5xx` | Source, Destination, Anchor, Status Code | one internal link to a 5xx page | — (added P20-T1) |
| `anchor_texts` | source, target, text | one link, internal or external | 35,145 rows / 4,664,393 B |
| `redirects` | source, chain, target, hops | one **redirecting page** | 10 rows |
| `resources` | url, kind, shareImage, fetchClass, status, bytes, bytesSource, contentType, cacheControl, fetchReason, referencingPages | one **file** the served HTML points at | 0 rows (this crawl predates the pass) |
| `metric_table` (needs `metricId`) | **the metric's own** — its `summary` labels, then its `columns` labels | one row of one metric's table | 40 rows (`inlinks.extremes`) |
| `issues_overview` (Phase 27a) | Issue Name, Issue Type, Issue Priority, Severity, URLs, % of Judged, Description, How To Fix, Rule Id, Check Ids | one rule, as `issues_overview` (§4.3a) answers it | 46 rows / 27,040 B on the gate crawl `crawl_4dd32709` |
| `crawl_overview` (Phase 27a) | Section, Label, Value, Percent | one entry of one `crawl_overview` section (§4.3b), then one row per `notMeasured` item | 75 rows / 2,332 B on the gate crawl `crawl_4dd32709` |

Semantics a consumer must repeat to its own users:

- **The crawl's judgement is applied (Phase 27a).** The `issues` view's `type`
  and `priority` columns are the crawl's, after its overrides, and a rule the
  judgement disables has no rows in it. The MCP `export_crawl` answer names
  those rules in `disabledRules`, as the `issues` JSONL dataset's does, for the
  `issues`, `issue_urls`, `issues_overview` and `crawl_overview` views (the
  last leaves them out of its issues grid). The HTTP route streams the file and
  carries no metadata headers beyond `Content-Type` / `Content-Disposition`, so
  a dashboard downloading over HTTP reads the disabled set from
  `crawl_config_get` (`GET /crawls/:id/config`, its `judgement.rules`) or from
  the JSON listing's `disabledRules` (`GET /crawls/:id/issues`, §4.3). The
  `issue_urls` view of a disabled rule is refused before the first byte (409). On the gate crawl,
  with `title.same-as-h1` disabled, the `issues` view held 2,864 rows, its
  3,202 findings less that rule's 338
  (`test/api/judgement-surfaces.test.ts:213` "the issues CSV carries type and
  priority and leaves out the disabled rule").
- **`issues_overview` is the Issues Overview as a sheet** (Phase 27a): the
  JSON's rows in the JSON's order, with `Issue Name` the rule's title and
  `Description` / `How To Fix` its copy, rendered from the thresholds the crawl
  was judged with; the JSON carries no copy beyond the title. A `null`
  `percentOfJudged` is an empty `% of Judged` cell (§5.7). It is the rules that
  fired: the view takes no `includeZero`. Like the JSON, it is refused on an
  unjudged crawl, before the first byte. It is named
  `crawl_<uuid>-issues_overview.csv`.
- **`crawl_overview` is the Crawl Overview as a sheet** (Phase 27a): one row per
  entry, section by section in the JSON's order, then one row per `notMeasured`
  item, written `<id>,Not measured: <reason>,,` with empty Value and Percent
  cells, so a sheet never shows a not-measured section as zeros. It is answered
  on an unjudged crawl too. Both overview views, like `metric_table`, are not a
  keyset read of a table: each is one bounded aggregate, written whole.

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
  rows — the file is the unit of work, and the fix is made once. A share image
  (`og:image`, `twitter:image`) is a row with `shareImage: true` and
  `referencingPages: 0`, because the tag names it and no page loads it (Phase
  26b; the `shareImage` column is Phase 26c). A file that is both a share image
  and a page asset carries `shareImage: true` and its page count. Two absences
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
  column in these eleven views emits one (a metric's cells are counts, bytes,
  distances and percentages, none of which go below zero). It is not a text-column guard: a
  `Cache-Control` header is the server's own string and lands in a cell exactly
  as a page title does, which is what `test/api/query.test.ts:3096` "never lets a
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
flattening, the SQL keyset pins, and the view vocabulary — including
`test/api/csv.test.ts:248` "heads the issue_urls view with the rule's own
columns, in the rule's own order");
`test/api/query.test.ts:2910` "writes each view's header, always, and the row a
caller came for" (including the three recheck columns, empty on a page nobody
re-asked about and filled on one that was), `test/api/query.test.ts:3055` "writes one row per referenced
file, with the class that makes an empty status readable" (the four unfetched
spellings), `test/api/query.test.ts:3096` "never lets a crawled string become a
formula" (including a hostile `Cache-Control`), `test/api/query.test.ts:3117`
"quotes a cell holding a comma, a quote or a newline",
`test/api/query.test.ts:3218` "exports exactly as many rows as the source holds"
(for `resources`, against BOTH of its tables: one row per file, and the
referencing counts summing to the edge table), `test/api/query.test.ts:3273`
"reads every view through a cursor that can be walked one row at a time",
`test/api/query.test.ts:3308` "refuses a view, a format or a rule it cannot
answer", `test/api/query.test.ts:3383` "refuses a crawl holding a retired rule's
findings BEFORE the header", `test/api/http.test.ts:1991` "tears the response
when a CSV export fails mid-stream, rather than truncating the file";
`test/api/mcp.test.ts:802` "describes the shape of the CSV it writes, not just
that it writes one" and `test/api/mcp.test.ts:2862` "streams the resources view
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
- A re-walk on resume never clears `sitemap_urls` (a URL dropped from a changed site
  stays a sitemap entry); carried to Phase 28b.
- `crawl_config_set`'s "rules are running" refusal (§4.9) sees only the rules
  runs of ITS OWN server process, as `crawl_rules`' own "already being judged"
  refusal does. A run started by another process can read the block a moment
  before a change lands; it stamps the block it read, so `judgementStale` still
  tells the truth afterwards, and the next run picks the change up.
- A stored judgement block and stamp are validated against the CURRENT
  ruleset's allowlist and ranges when read. A later release that narrows a
  threshold's range or removes a rule makes an older crawl's block refuse to
  load (409 for a removed rule, repairable with `crawl_config_set`; a loud error
  otherwise), never silently "no overrides". The stamp holds every overridable
  threshold by name, so a release that adds one to the allowlist must rewrite
  the stored stamps with the value those runs used, as migration 0033 did;
  until then such a stamp is a loud error, never "judged with the new default".
- **Credentials are stored, encrypted, under a key every process must hold** (Phase 28b;
  in 27c they lived in ONE process's memory). A process holding another key cannot read
  the copy, so the crawl is `CREDENTIALS_REQUIRED` there; a rotation that keeps the old
  key as `ARIADNE_CREDENTIALS_KEY_PREVIOUS` reads it and re-encrypts at the next write.
  Talos, which holds the secrets, can always re-supply them. (Until 27d a `crawl_config_set`
  that replaced a queued crawl's credentials in the instant a runner dequeued it could
  leave the runner with the new shape and the old values; the store is now keyed by
  shape, a runner reads the values of the shape its row states, and a failed
  `crawl_config_set` leaves the old credentials usable and the new ones gone. The
  known limit is removed.)
- **A list crawl measures the listed pages, not the site.** `crawl.list-mode` names
  the 18 site-wide rules that did not run (plus the 13 sitemap rules when no sitemap
  was read) and the 11 target rules judged only against what the list fetched; their
  silence on a list crawl is "not measured", never "clean".
- **`excludedDropped` counts discoveries under the scope that refused them.** A URL
  turned away past the budget is a count, not a row, so widening the scope later
  cannot re-admit it; only an `excluded` row can be re-admitted.

## Cross-references

- `docs/talos-integration.md` — why the seam exists, the nine obligations, and
  what Talos must eventually do.
- `docs/gates/phase-10.md` and `docs/gates/phase-11.md` — the measurements
  behind this file's Phase 10 and Phase 11 numbers; each number here also names
  the test or the measurement it came from directly.
- `docs/gates/phase-28b.md` — the Phase 28b gate: workers killed with `kill -9`, the
  encrypted credentials and their secret scan, the health endpoints and the 50k crawl as
  a worker job.
- `docs/gates/phase-28a.md` — the Phase 28a gate: the tenant sentinel, the backfill
  on the dev database and the carried loop fixes.
- `docs/gates/phase-27a.md` — the Phase 27a gate: the overviews reconciled with
  `issues_list`, `issue_urls` and `crawl_status` on the stored lavishalice crawl,
  the override round trip, and every rule whose type or priority differs from
  Screaming Frog's.
- `skills/ariadne-audit/checklist.md` — the checks the rules trace to.

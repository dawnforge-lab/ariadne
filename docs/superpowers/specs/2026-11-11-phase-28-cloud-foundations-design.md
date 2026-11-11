# Phase 28 — Cloud foundations

Date: 2026-11-11. Predecessor gate: Phase 27d (`docs/gates/phase-27d.md`, merged in PR #28,
`c87552e`).

Status: design, awaiting owner review. A fresh builder read it once; its seven questions are answered in place (render/rules stay synchronous, system pauses resume, schedule chains, the worker gate harness, queued pinned jobs, host footprint, version skew). Owner direction (2026-11-11): "let's start 28", then
"Skip the questions". The scope comes from the roadmap
(`docs/superpowers/specs/2026-11-04-roadmap-design.md`, Phase 28) and the Talos seam
(`docs/talos-integration.md`). Where neither settles a point, the call is mine, and those calls
are listed at the end for the owner to check.

## Intent

Today Ariadne is one process. It holds the queue in memory and runs one crawl at a time. Any
caller with the token can see every crawl it has ever run. That is fine on a laptop, but it is
not something Talos can put in front of tenants. Phase 28 makes the engine something that can be
deployed:

- **Tenants cannot see each other.** `crawl_list` returns every crawl to any caller holding the
  token (`docs/talos-surface.md` §9, posture 4). Anyone who knows a crawl id can read or delete
  it (posture 5). Talos is multi-tenant, so this is the one Talos obligation still unmet.
- **Crawls outlive the process that accepted them.** The queue lives in a JS array.
  Queued rows left by a dead process are never picked up again. A process that dies while a
  crawl is `running` leaves it `running` for good. The `judging` and `rendering` guards are
  in-process Sets.
- **More than one process can do the work.** Roadmap decision 5 asks for Talos's shape: separate
  API and worker containers over one Postgres, workers claiming work with `FOR UPDATE SKIP
  LOCKED`.
- **An operator can see the engine working.** There is no health endpoint and no metrics
  today. The 50k memory gate runs only when someone remembers to run it.
- **Crawls recur.** An audit client gets re-crawled on a cadence, and the comparison between
  crawls is where most of the value lies (`crawl_compare`). Nothing can start a crawl unattended
  today.

Success looks like this. Two worker containers and one API container share a database. Crawls
for four tenants queue, get claimed once each, and run side by side, with no tenant able to see
another's. Killing a worker mid-crawl gives a paused crawl that resumes on the other worker.
A weekly schedule fires exactly once per slot while one of two schedulers is killed. The 50k
gate runs every week in CI without anyone remembering it.

## What Talos looks like (so "mirror Talos" means something)

From a read of the Talos repo (`/home/eugen-dev/Documents/Workflows/talos`, `main`, which
contains `feat/talos-rewrite`):

- **Images:** one image (Python + Playwright Chromium), started either as the API
  (`uvicorn`) or as the worker (`python -m worker`). Postgres 16 is external and comes in
  through `DATABASE_URL`. Railway is the intended host. There is no CI workflow and no
  registry push; images are built by hand.
- **Queue:** a `jobs` table. A job is claimed with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`.
  The worker writes a 10 s heartbeat, and a job counts as "stalled" after 60 s. Orphans are
  re-queued only at worker boot, and there is no SIGTERM handling.
- **Tenancy:** the tenant is the user (`users.id`, a BIGINT). It is enforced in application
  queries, never by row-level security. A resource owned by someone else answers 404, never 403.
- **Health:** `GET /api/v1/health` is liveness only, with no database call. There is no readiness
  endpoint, no Prometheus and no scheduler.
- **Ariadne:** Talos expects to call Ariadne with "an admin-managed bearer token". How the
  tenant is passed, and whether Ariadne runs as a sidecar or a shared service, is undecided on
  the Talos side.

So "mirror Talos" means: the same image-and-roles split, the same `SKIP LOCKED` claim, the same
404-for-foreign convention, and the same liveness-without-database health check. Talos has
gaps Ariadne fills for itself: no lease reaping while a worker is alive, no graceful shutdown,
no readiness check, no metrics and no scheduler.

## Goals

The phase splits into three, like Phase 27. Each part has its own plan and gate, and each one
merges before the next is planned.

### 28a — Tenancy

1. **A tenant key on the crawl.** `crawls.tenant_id text not null`, plus an index on
   `(tenant_id, created_at desc)`. The value is opaque to Ariadne. It must match
   `^[A-Za-z0-9._:-]{1,64}$`, and any other value is refused with 400 `code: "INVALID_TENANT"`.
   Talos sends its user id as a string. Existing rows are backfilled to `local` by the migration.
   The key goes on `crawls` and on the new tables of 28b and 28c (`jobs`, `schedules`,
   `crawl_events`). It does **not** go on the 14 crawl-child tables. Every one of them is
   reached only through a `crawl_id` that has already been checked against the tenant, and a
   column on `pages` and `links` would add bytes per row to the 50k gate for nothing (my call;
   the roadmap says "on every row").
2. **The tenant travels with the request.**
   - **HTTP:** every request carries the bearer token and a required `X-Ariadne-Tenant` header.
     A missing header is 400 `code: "TENANT_REQUIRED"`, sent before routing, the way a missing
     token is 401 today.
   - **MCP over stdio:** `ARIADNE_TENANT` is required at boot. A local agent is one tenant, by
     process trust.
   - The token still proves the caller is Talos, and the header says which tenant Talos is
     acting for. Ariadne keeps no per-tenant tokens, because tenancy is a key, not an identity
     system (roadmap decision 4).
3. **Every read and command is scoped.**
   - Every per-crawl route and tool resolves the crawl by `(id, tenant)`. A crawl belonging to
     another tenant answers exactly like a crawl that does not exist: the same status, `code`,
     body and timing class. This is Talos's 404 convention, and it means the answer is no
     oracle for whether an id exists.
   - `crawl_list` lists only the caller's crawls. `crawl_compare` and `compare_urls` require
     both crawls to belong to the caller. `rules_catalog?crawlId=` is scoped.
   - Export files go under `<exportDir>/<tenant>/<crawlId>/`.
   - `queuePosition` stays a position in the global queue (my call: it reveals load, not
     identity).
4. **A test that keeps it scoped.** A sentinel test enumerates every HTTP route in
   `src/api/http.ts` and every MCP tool in `src/api/mcp.ts`. Each one must be either
   tenant-scoped, which the test proves by calling it with tenant B on tenant A's crawl, or in
   an explicit global list (`config_schema`, `config_validate`, `rules_catalog` with no
   crawl, the health and metrics endpoints). A route added later without scoping fails CI.
5. **Talos-surface.** §9 postures 4 and 5 are retired. Every example gains the header, and
   `docs/talos-integration.md` gains obligation 9 (tenancy).

### 28b — Workers

6. **A durable queue.** A new `jobs` table replaces `waiting[]`, `running`, `judging` and
   `rendering`.
   - **Columns:** `id`, `tenant_id`, `crawl_id`, `kind` (`crawl | render | rules`), `status`
     (`queued | running | done | failed | abandoned`), `pinned_to` (instance id or null),
     `claimed_by`, `claimed_at`, `heartbeat_at`, `queued_at`, `finished_at`, `error`.
   - A crawl start or resume enqueues a `crawl` job. `crawl_render` and `crawl_rules` **stay
     synchronous**, as today: the API process that receives the call writes a `render` or
     `rules` job pinned to itself, runs it, and answers with the same summary and the same
     409s. The job row exists so the busy guard and reaping are database facts. Talos's
     contract for these two calls does not change. The only unattended render and rules jobs
     are a schedule's (item 14), and those are unpinned and claimable by any runner.
   - **Version skew.** Every job records the `RULESET_VERSION` and `EXTRACTION_VERSION` of the
     process that enqueued it, and a runner claims only jobs whose versions equal its own. On a
     rolling deploy, old runners drain the old jobs and never judge with a stale ruleset.
   - The agent-facing crawl `status` (`queued/running/paused/…`) is unchanged. The job is the
     engine's bookkeeping behind it, and `crawl_status` gains `job: {kind, status, claimedBy?}`.
   - A partial unique index allows at most one `queued|running` job per crawl. This replaces
     the in-process `refuseWhileBusy` sets with a database fact, and is the 27b carry
     (`docs/gates/phase-27b.md:290`).
7. **Claiming.**
   - A runner claims with one statement: an `UPDATE jobs … WHERE id = (SELECT … WHERE status =
     'queued' AND <eligible> ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`. A
     `crawl` job then does the existing compare-and-swap on `crawls.status` (`queued →
     running`, `ClaimLostError`) inside the same transaction.
   - **Eligible means** the job is not pinned elsewhere, the tenant is below its cap, and the
     host is free:
     - **Host exclusivity.** No `crawl` or `render` job for the same host is `running` for
       any tenant. Two crawls of one site at once would each obey their own `HostGate` and
       together break hard rule 9. Today this cannot happen only because there is one
       process. A crawl's footprint is its seed host ± `www`, because that is the only host
       family the frontier admits. Hosts named in `sitemapUrls` and `legacyHosts` see a
       handful of discovery requests, not a crawl, and are not part of the footprint.
       Synchronous render calls refuse with 409 `code: "HOST_BUSY"` when the host is held.
     - **Per-tenant cap.** `ARIADNE_TENANT_MAX_RUNNING` (default 1) running `crawl` jobs per
       tenant, so one tenant's backlog cannot starve the rest. Claim order within that is
       `queued_at`.
   - A runner's concurrency is `ARIADNE_WORKER_CONCURRENCY` (default 1). The memory contract
     is per crawl, so a worker's budget is concurrency × the gate bound (hard rule 6 unchanged).
8. **Instances, heartbeats, reaping.**
   - A new `instances` table holds `id` (uuid generated at boot), `role`, `hostname`, `pid`,
     `version` (`ARIADNE_GIT_SHA`), `started_at` and `heartbeat_at`.
   - Every process heartbeats its instance row and its running jobs every 10 s.
   - Any live instance reaps on a 30 s tick. The reaper uses `SKIP LOCKED` so two reapers never
     reap one job.
   - **Reaped jobs.** A job whose instance has missed heartbeats for 60 s is `abandoned`:
     - A `crawl` job's crawl is closed `paused` with a new `pause_reason: "worker_lost"`, and
       its frontier leases are released (`releaseLeases`, refund semantics as 27b). The crawl
       resumes like any paused crawl, on whichever runner claims the resume.
     - A `render` or `rules` job is abandoned, and the crawl answers as it did before the
       call, because a re-run is the caller's to ask for.
   - **System pauses resume by themselves.** The reaper re-queues a crawl paused by
     `shutdown` or `worker_lost`, keeping the same id, pages and earned spacing. Credentialed
     crawls are included, because their values are now stored encrypted (item 10). In
     containers every deploy is a shutdown, so without this, each deploy would stop every crawl
     until Talos noticed. An agent's pause is never undone. This reverses part of obligation 7
     ("a restart starts none of them"), so it is an owner call (listed below).
   - This replaces "a dead process leaves the crawl `running` forever" and the 27b carry
     "orphan running crawls with a pending request are not reaped".
   - Dead instance rows older than a day are deleted.
9. **Roles and entry points.**
   - `src/worker/serve.ts` (`npm run worker:serve`) runs a claim loop over unpinned jobs and
     has no API.
   - `src/api/serve.ts` serves HTTP and runs only the synchronous `render` and `rules` jobs it
     pinned to itself (item 6). It runs no crawls.
   - `src/api/mcp-serve.ts` (stdio, local) claims every job: a local agent has no workers, so
     the one process is everything, as today.
   - Shutdown (SIGTERM/SIGINT) stops claiming, then pauses running crawls exactly as today
     (`pause_reason: "shutdown"`) and marks its jobs `abandoned`. Queued jobs stay queued for
     another runner. That is the change from today, where they were stranded.
10. **Credentials are stored encrypted, for reruns** (owner, 2026-11-11: "We could do
   encrypted credentials for reruns"). This replaces obligation 8's "memory only, encrypted or
   not". Talos stays the source of truth for the values. Ariadne keeps an encrypted copy so
   that a crawl can be rerun without Talos: a resume after a deploy, a dead worker's crawl
   picked up elsewhere, a render or rules run later, or a scheduled re-crawl.
   - **Storage.** A new table `crawl_credentials` holds `crawl_id` (primary key, cascade on
     delete), `tenant_id`, `generation`, `key_id`, `nonce` and `ciphertext`.
     - `ciphertext` is AES-256-GCM (`node:crypto`, no new dependency) over the same JSON the
       in-memory store holds today. The nonce is a fresh random 12 bytes per write.
     - The associated data is `crawl_id` + `generation`, so a ciphertext copied onto another
       crawl's row, or an older generation replayed, fails authentication.
     - Schedules get the same shape in `schedule_credentials` (28c).
   - **Key.**
     - `ARIADNE_CREDENTIALS_KEY` holds 32 bytes, base64, with an id (`<id>:<base64>`). It is
       required at boot by every process that runs or accepts crawls. A missing or malformed
       key is a boot error, never a mode that silently refuses credentials.
     - `ARIADNE_CREDENTIALS_KEY_PREVIOUS` (optional, same format) decrypts rows written under
       the previous id. Rows are re-encrypted under the current key when next written, which
       is enough for one rotation step. A bulk re-encrypt script is a later item.
     - The key lives in the platform's secret store, never in the database.
   - **Decryption.** Only the runner decrypts, right before the crawl, render or rules job
     needs the values, and it holds them in memory for that job only.
     - The values never appear in a response, log, event, error, metric or export, which
       is the rest of obligation 8 unchanged.
     - `crawl_config_get` still shows kinds and names only.
   - **Writes.**
     - `crawl_start`, `crawl_resume`, `crawl_render` and `crawl_config_set` write the row inside
       the same transaction as the crawl change.
     - Each write bumps `generation`, so the runner always reads the values that match the
       config it claimed. The in-memory `CredentialStore` and its stage/settle window go away,
       which closes the 27d R17 same-shape carry for good.
     - A call that re-supplies credentials overwrites the row, exactly as it replaces them in
       memory today.
   - **Lifetime.**
     - The row is deleted on `crawl_cancel` and `crawl_delete`, and when a `crawl_config_set`
       removes the credentials.
     - The row stays while the crawl is `queued`, `running`, `paused` or `finished`. A
       finished crawl still needs it for a later `crawl_render`.
     - It is also deleted **30 days after the crawl finishes**, by the reaper's tick (my call;
       Talos can re-supply after that).
     - The 30 days is `ARIADNE_CREDENTIALS_RETENTION_DAYS`, which must be set to a positive
       integer if it is set at all.
   - **When the values cannot be read.** This covers an unknown `key_id` (the key was rotated
     past it), a failed authentication tag, or a row deleted by retention.
     - The job does not run. The crawl stays or becomes `paused` with `pause_reason:
       "credentials_unreadable"`, the reason is logged without any value, and resume and render
       answer 409 `CREDENTIALS_REQUIRED` until Talos sends the values again.
     - `CREDENTIALS_REQUIRED` keeps its meaning ("send them on this call") and its Talos
       handling. It just becomes rare.
   - **Consequence for runners.** Any worker runs a credentialed crawl, so there is no
     pinning for credentials and no crawl runs on the API container.
   - **What it costs.** Someone holding both a database dump and the key reads the values. The
     key never sits beside the data, and the gate's secret scan still proves that no plaintext
     value is anywhere in the database, the logs or the metrics.
11. **Health and metrics.**
   - **Health:**
     - `GET /healthz` is liveness: no auth, no database call, `{status:"ok"}`. This mirrors Talos.
     - `GET /readyz` takes no auth. It answers 200 when a database round trip succeeds and the
       applied migration count equals the code's; otherwise 503 with a `reason`.
   - **Metrics:**
     - `GET /metrics` serves Prometheus text through `prom-client` (Apache-2.0; licence noted
       in `THIRD_PARTY_NOTICES.md` only if anything is lifted, which nothing is).
     - It is guarded by `ARIADNE_METRICS_TOKEN` (bearer, separate from the API token, so a
       scraper never holds a crawl-starting credential). An unset token disables the
       endpoint with a 404 and a boot log line. It is not open.
     - The worker serves the same three endpoints on `ARIADNE_WORKER_HTTP_PORT`.
   - **Metric set:**
     - Process defaults, including RSS.
     - `ariadne_jobs` (gauge by kind/status, read from the database at scrape time).
     - `ariadne_job_claim_wait_seconds` (histogram).
     - `ariadne_job_duration_seconds` (histogram by kind/outcome).
     - `ariadne_pages_fetched_total` (counter by fetch class).
     - `ariadne_fetch_duration_seconds` (histogram).
     - `ariadne_host_escalations_total`.
     - `ariadne_instances_alive` (gauge by role).
     - `ariadne_crawl_peak_rss_bytes` (gauge, the last finished crawl's peak on this
       instance).
   - **No label ever carries a tenant id, crawl id, host or URL.** That rule protects tenants
     and cardinality, and a test pins it against a forbidden list.
12. **Images.**
   - One `Dockerfile` (Node 22 on Debian slim, `npm ci --omit=dev`, Playwright Chromium with its
     system dependencies, `fonts-liberation`) and one image with two roles: `api` and `worker`
     are just different commands. This mirrors Talos.
   - The image runs as a non-root user. Chromium's sandbox must work in it. If the sandbox
     cannot start, the render pass fails loudly as it does today (`render_launch_error`). It is
     never quietly launched with `--no-sandbox`.
   - Migrations are a separate one-shot command (`migrate`) run as a release step, never at
     boot, so that two booting containers do not race. `readyz` reports a schema that is
     behind.
   - A `docker-compose.yml` runs Postgres, migrate, one API and two workers for local use and
     for the 28b gate.
   - CI builds the image on every PR. Publishing to a registry waits for a deploy target (my
     call, an outward action, the owner decides when).
13. **Disk outputs on a cloud worker.**
   - The render pass writes each rendered document to `<renderDir>/<crawlId>/` and records the
     path in `pages.rendered_html_path`. Only a human ever reads it.
   - On a worker container that disk is ephemeral and unreachable from the API. It also
     contradicts the 2026-11-05 ruling that Ariadne keeps no rendered HTML.
   - So the worker role does not write them: the column stays null, and `crawl_status`
     gains `renderDocuments: "kept" | "not kept"`.
   - The stdio MCP process and the API's synchronous `crawl_render` keep writing them, so local audits are
     unchanged.
   - Exports stay on the API's disk (written and served by the same process). Phase 28 runs
     **one API replica**. Several would need a shared blob store, which is roadmap decision 5's
     S3 item, deferred until something needs it.

### 28c — Scheduler, history, CI gate

14. **Schedules.**
   - **Table `schedules`:** `id`, `tenant_id`, `site_url`, `config_jsonb` (the same start
     config `crawl_start` takes, validated by the same schema), `cron` (five fields), `timezone`
     (IANA), `enabled`, `next_run_at`, `last_crawl_id`, `created_at`, `updated_at`.
   - **A fire is a chain: crawl, then render if asked, then rules.** `crawl_compare` needs
     two judged crawls, so a schedule that only crawled would leave nothing to compare until
     someone called `crawl_rules`.
     - The schedule carries `render` (the same optional parameters `crawl_render` takes, or
       null).
     - When a scheduled crawl finishes, the engine enqueues the next link as an unpinned job.
     - A link that fails ends the chain with a `schedule_chain_failed` event (link, reason).
       The crawl keeps whatever it already has.
     - A crawl that ends `paused` or `cancelled` ends the chain silently, because the pause
       or cancel is already its own event.
   - **Credentialed schedules are allowed.** `schedule_create` and `schedule_update` take the
     same credentials `crawl_start` does. They are stored encrypted in `schedule_credentials`
     (item 10) and copied, re-encrypted under the new crawl's id, into each fired crawl. They
     are deleted with the schedule. Retention does not apply to a schedule's own copy while
     the schedule exists.
   - **Tools and routes:** `schedule_create`, `schedule_list`, `schedule_get`, `schedule_update`
     and `schedule_delete`, on MCP and HTTP. All are tenant-scoped, and creation checks the
     domain allowlist exactly like `crawl_start`.
   - The cron parser is a small MIT dependency (`cron-parser`) or our own five-field parser.
     That is the builder's call.
15. **One scheduler at a time, safe if two run.**
   - Every API and worker process is a candidate. The leader holds
     `pg_try_advisory_lock(<ariadne-scheduler key>)` on a **dedicated** connection, outside the
     pool, so a pooled statement cannot drop it. That was the reason advisory locks were
     rejected for rules runs, and it does not apply to one held session.
   - The leader ticks every 30 s. It claims due schedules with `SKIP LOCKED`, which also makes
     a brief two-leader overlap harmless. For each one it either enqueues a crawl through the
     same path as `crawl_start`, or skips.
   - **Skip rules:**
     - The previous crawl, or its chain, is still queued, running or paused: skip with reason
       `overlap`. A schedule never stacks crawls. A deploy cannot strand the schedule, because a
       paused scheduled crawl resumes by itself (item 8). Only an
       agent's pause holds it, which is deliberate.
     - The host is no longer allowlisted: skip with reason `not-allowed`. This is checked at
       fire time as well as at creation.
     - After downtime, a schedule that missed several slots fires once, not once per slot.
   - `next_run_at` then advances to the next slot after `now()`.
   - If the leader dies, its session ends, the lock frees, and another candidate takes it on
     its next attempt (every 30 s).
16. **Crawl history events.**
   - **Table `crawl_events`:** `id` bigserial, `tenant_id`, `crawl_id` (nullable, cascade on
     delete), `schedule_id` (nullable), `at`, `kind`, `detail_jsonb`.
   - **Kinds:** `queued`, `claimed` (instance and role), `started`, `paused` (reason),
     `resumed`, `cancelled`, `finished`, `failed` (reason), `render_queued/started/finished`,
     `rules_queued/started/finished`, `worker_lost`, `schedule_fired`, `schedule_skipped`
     (reason).
   - Events are O(lifecycle) per crawl, never O(URLs).
   - `detail` is built from an allowlist per kind, so no credential name or value and no
     client-sent key can ever land there. The 27d no-key-echo sentinel extends over it.
   - **Tools:** `crawl_history` (one crawl, paginated, oldest first) and `schedule_history`
     (one schedule's fires and skips). Both are tenant-scoped.
17. **The 50k gate in CI.**
   - A new workflow `.github/workflows/gate.yml` runs on a weekly cron and on
     `workflow_dispatch`. It uses a Postgres 16 service, migrates, and runs `scripts/gate-rules.ts`
     at 50,000 pages, the same command the gate docs record. The timeout is 120 min.
   - **Fails** above 512 MB peak RSS (hard rule 6's limit).
   - **Warns** (a job annotation, not a failure) above the last recorded bound (290.2 MB), since
     runner hardware differs from the dev machine.
   - The gate JSON (peaks per phase, durations) is uploaded as an artifact, so a slow drift is
     visible week to week.
   - The 27d open item rides along: `gate-rules.ts` prints a timing line for `inferPageTemplates`.

### Carried from 27d (R17 and the parked minors), placed where they fit

- **Same-shape credential window:** closed by 28b item 10. The values move into the same
  transaction as the config, so there is no window.
- **`sitemap_memberships` staging across a changed site:**
  - **Problem:** a stopped walk's memberships survive through `onConflictDoNothing`, which
    equals a whole walk's only while the site is unchanged.
  - **Fix:** a resumed re-walk clears the crawl's memberships when it clears the hreflang
    staging, under the same write-ahead interrupted mark (R8/R10/F4).
  - **Placement:** 28a, as a standalone task, because it touches the loop and not the new
    tables.
- **robots.txt unreachable on a resume:**
  - **Problem:** the hreflang staging is deleted and the evidence is rewritten with no walk.
  - **Fix:** when robots cannot be read on a resume, the staging and evidence from the earlier
    walk stay exactly as they were, and the crawl's robots outcome is recorded as today. The
    absence rules then judge what was actually read, marked `interrupted` if that walk was
    cut. In 28a.
- **`fetch-page.ts` abort order:** check `isProgrammerError` before the abort, as F3 did for
  resources. In 28a.
- **`jsonb_set` on legacy evidence without a `truncation` object:** set the whole object
  (`create_missing` on the parent path) so the mark lands. In 28a.

### Housekeeping

- `CLAUDE.md` points at `/home/eugen-dev/Workflows/talos`. The repository is at
  `/home/eugen-dev/Documents/Workflows/talos`, and the same stale path is in
  `docs/talos-integration.md`. Both get fixed in 28a.

## Non-goals

- **Row-level security.** Talos enforces tenancy in queries, and so does Ariadne. The sentinel
  test is the guard.
- **Per-tenant domain allowlists.** The allowlist stays one operator-set list. A multi-tenant
  Talos needs each tenant's domains on it, which is an operator chore. A per-tenant list is a
  real surface change for later (open item).
- **Several API replicas, and a blob store.** These wait until exports or something else need
  to be shared between processes.
- **Image publishing and a deploy target.** CI builds the image; nobody pushes it yet.
- **Structured JSON logs and tracing.** Logs stay free-text lines on stderr, which any
  platform collects.
- **Screenshots** (still undecided) and every Phase 29 integration. 29 needs 28a's tenant key
  and nothing else from this phase.
- **Cross-rule scan sharing, PDF header hreflang, an https fixture, a test database split.**
  All still on the backlog.

## Constraints

- Hard rules 1–10 hold. Rule 6 is per crawl: a worker running N crawls is budgeted N ×, and
  the default N is 1.
- Every new table is created by a drizzle migration. 0037 and up are applied with `npm run
  db:migrate`, never by hand.
- No fallbacks:
  - A missing tenant header, tenant env, metrics token, worker port or schema version is a
    loud refusal or a boot error, never a default tenant or an open endpoint.
  - The `local` backfill is a migration, not a default.
- Credential values never reach a log, an event, an error, a metric or a response. They
  reach the database only as AES-256-GCM ciphertext under a key the database never holds
  (obligation 8 as amended by the owner).
- A foreign crawl answers like a missing crawl in every respect.

## Surface changes (Talos-facing)

- `X-Ariadne-Tenant` is required on every HTTP request.
- 404 replaces any other answer for a crawl outside the tenant.
- `crawl_status` gains `job` and `renderDocuments`. `pause_reason` gains `worker_lost` and
  `credentials_unreadable`.
- Credentials are stored encrypted for reruns (obligation 8 rewritten). Talos's calls do
  not change. `CREDENTIALS_REQUIRED` keeps its code and handling and now appears only when the
  stored copy cannot be read (key rotated past it, retention expired, tampering).
- Credentialed schedules are accepted.
- New tools and routes: `schedule_*` (5), `crawl_history`, `schedule_history`, plus `/healthz`,
  `/readyz` and `/metrics`.
- `queuePosition` is now computed from the jobs table (same meaning).
- `docs/talos-surface.md` and `docs/talos-integration.md` are updated in each sub-phase's last
  task. Talos must start sending the header before it upgrades to 28a.

## Gates

**28a.**
1. The sentinel test covers every route and tool. Tenant B gets 404 on each of tenant A's
   crawls, and `crawl_list` returns only the caller's crawls.
2. The backfill leaves existing dev crawls readable as tenant `local`.
3. The four carried loop fixes each have a failing-first test.
4. Suite and tsc clean.

**28b.**
1. On `docker compose up` (Postgres, migrate, API, two workers), 4 tenants × 1 crawl of 4
   fixture hosts are each claimed exactly once (events prove it) and run two at a time.
2. A fifth crawl of an already-running host waits until that host is free.
3. A worker is killed with `kill -9` mid-crawl. Within 90 s the crawl is `paused`
   (`worker_lost`), its leases are released, and a resume finishes on the other worker with no
   duplicate `pages` rows.
4. A credentialed crawl is paused by a `kill -9` of its worker and finishes on the other
   worker with its values intact. A secret scan of every table (ciphertext excepted, by
   construction), the events, both processes' logs and `/metrics` finds no plaintext value.
   A row encrypted under an unknown key id, and a row with a flipped tag byte, each give
   `paused` (`credentials_unreadable`) and a 409 `CREDENTIALS_REQUIRED` on resume.
5. `/healthz`, `/readyz` and `/metrics` answer per spec. `readyz` answers 503 against a database
   one migration behind, and the metrics label test passes.
6. The 50k crawl runs as a `crawl` job in a `worker:serve` process, using a new harness that
   enqueues the job against the in-process fixture site and samples the worker's RSS. It
   peaks at ≤ 290.2 MB, which is comparable with the crawl phase of `gate-rules.ts`. The weekly
   `gate.yml` keeps running `gate-rules.ts` (crawl, render and rules in one process, the
   recorded command).

**28c.**
1. Two processes are scheduler candidates. A one-minute schedule over 10 minutes fires exactly
   10 times while the leader is killed once. Each fire runs crawl and then rules, and the
   compare between two fired crawls is `comparable`. An overlap and a not-allowed skip are
   recorded.
2. `crawl_history` reads the lifecycle of a crawl that was paused, resumed and finished.
3. `gate.yml` runs green once via `workflow_dispatch` on the branch, and its artifact holds the
   peaks.

## Calls I made (owner to check)

1. **Encrypted credentials** (owner direction; item 10). My calls inside it:
   - AES-256-GCM with the key in `ARIADNE_CREDENTIALS_KEY`.
   - The associated data binds each ciphertext to its crawl and generation.
   - Retention is 30 days after the crawl finishes.
   - Values that cannot be read pause the crawl as `credentials_unreadable` instead of
     failing it.
2. **System-paused crawls resume by themselves** (item 8), credentialed ones included. This reverses part
   of obligation 7. Without it, every deploy stops every crawl until Talos calls
   `crawl_resume`, and a schedule whose crawl a deploy paused would skip forever.
3. **`crawl_render` and `crawl_rules` stay synchronous** and run in the API process that
   received the call (item 6), so their contract does not change. Workers run crawls, and
   run render and rules only as a schedule's chain.
4. **A scheduled fire runs crawl, then render if asked, then rules** (item 14), so that fired
   crawls can be compared.
5. **The tenant key goes on `crawls` and the new tables, not on every child table** (item 1).
6. **The tenant travels as a header beside the one service token** (item 2), not as
   per-tenant tokens.
7. **One running crawl per host across all tenants** (item 7), plus a per-tenant cap that
   defaults to 1.
8. **Cloud workers keep no rendered documents** (item 13). This follows the no-HTML-store
   ruling; local runs keep them.
9. **One API replica in Phase 28.** No blob store, and no image publishing.
10. **The CI gate fails at 512 MB and only warns above 290.2 MB** (item 17).
11. **Split 28a → 28b → 28c**, each with its own plan, gate and PR.

## Open items (not decided here)

- **Per-tenant domain allowlists.** Needed before Talos onboards many tenants; it is a surface
  change.
- **Where Ariadne runs for Talos** (sidecar per Talos deployment or one shared service). Talos
  has not decided, and nothing in this design depends on it.
- **Registry publishing and the first deploy target** (Railway, as Talos intends).

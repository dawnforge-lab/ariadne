# Ariadne ↔ Talos: the seam

Decision (2026-08-25, owner): Ariadne is a **standalone** engine with a
**Talos-ready seam**. It serves the sf-* audit skill workflow from day one, and
is designed so the Talos SEO agent can consume it later without either codebase
absorbing the other.

## The two systems

| | Talos | Ariadne |
|---|---|---|
| What | Multi-tenant SEO SaaS (keyword research, interlinking, redirects, content, ecommerce content, conversational SEO agent) | Site crawl + audit evidence engine |
| Where | `/home/eugen-dev/Documents/Workflows/talos`, branch `feat/talos-rewrite` | this repo |
| Stack | Python 3.13 / FastAPI / Next.js 16 / Postgres | TypeScript / Node 22 / Postgres |
| Crawling today | Per-URL pipeline crawls (crawl4ai/httpx) + the agent's single-page `crawl` tool with DNS-pinned SSRF guard | Site-wide frontier crawl (to be built) |

No code is shared in either direction. The seam is a network API.

**The seam itself is written down.** `docs/talos-surface.md` is the contract
Talos codes against as of Phase 10: every tool and route, the response shapes
(regenerated from a live server and cited to the test that pins each one), the
pagination and refusal conventions, the null-versus-zero semantics at both the
catalog and the metric surface, the comparison's `comparable` rule, the CSV
views, the politeness knobs a Talos-driven crawl sets, and the explicit list of
what Ariadne will not do. This file stays the WHY and the obligations; that one
is the WHAT. A change to the API surface, auth or politeness updates both.

## Why this exists from Talos's point of view

Talos's SEO agent (contract §F22, commit `d55ca41` + hardening `e012ea5`) has a
`crawl` tool that fetches and analyses **single pages**. Its roadmap item
"deepen the agent's crawl capability — richer site-wide crawl understanding"
is expected to be satisfied by **calling Ariadne**, not by growing a second
crawler inside Talos. The intended shape:

- Talos agent gains tools like `site_crawl_start`, `site_crawl_status`,
  `site_audit_issues`, `site_audit_metrics` that call Ariadne's API.
- Ariadne runs the crawl unattended and holds the evidence; the Talos agent
  queries filtered, paginated slices and narrates.

## Design obligations on Ariadne (checked before changing API/auth/politeness)

1. **Programmatic trigger surface.** Crawls must be startable and monitorable
   via API (and MCP), not only CLI — Phase 6 of the build plan. Responses
   filtered and paginated; never a full export inline (a chat agent consumes
   these).
2. **Domain allowlist + token auth on crawl triggers.** An unattended agent
   must not be able to point the crawler at arbitrary hosts. Bearer-token auth
   from day one of the API so a Talos deployment can hold a credential.
3. **Multi-crawl capability.** One engine instance must queue or run crawls for
   more than one site — Talos is multi-tenant. Crawl rows are the isolation
   unit; nothing may assume "the one current crawl".
4. **Politeness parity with Talos's incident history.** Talos learned on
   yellow.com.mt (2026-08-16) that WAFs run token buckets (~9 req/min there) —
   fixed per-host delay honoured alongside adaptive concurrency, branded UA
   (Talos crawls as TalosBot; Ariadne default `AriadneBot`, configurable so a
   Talos-driven crawl can present Talos's identity), back-off on 403/429.
   Met as of Phase 6 Task 6b: a `blocked` answer halves the concurrency window,
   and a refusal that NAMES A RATE (a 429, or anything carrying `Retry-After`)
   also DOUBLES that host's spacing — capped at 30s (until Phase 24a, for the
   life of the crawl; see below). A refusal that names no rate (401/403/challenge/bare 503)
   escalates only once the host has refused three times running across at least
   two different URLs, so one permanently forbidden path cannot tax a whole
   crawl. `Retry-After` is honoured as a floor on the host's next slot (capped
   the same way — a hostile header cannot park a crawl), and a blocked URL is
   retried up to three times under the widened spacing before it settles as a
   classified row whose `fetch_reason` names the spacing reached. Both halves
   are on `crawl_status` — `blockedPages` and `hostSpacingMs` — so a driving
   agent can read what the site did and what the engine did about it.
   Phase 24a bounded the ratchet and added a platform profile. Recovery: 50
   clean answers in a row step a host down one level (spacing halves, never
   below base); a host that escalates again after recovering is locked for the
   rest of the crawl, so the spacing turns from falling to rising at most once
   per host per crawl and a token bucket that re-empties gets one retry, not an
   oscillation. The per-host record (429s, `Retry-After`s, escalations,
   recoveries, lock, peak and final spacing) is persisted with the spacing and
   served as `crawl_status.throttle` — crawl evidence, never a finding. Profile:
   a site whose own response headers name Shopify is crawled at one request in
   flight and at least 1000 ms per host (the owner's Screaming Frog setting),
   with one render browser and a 60 s render budget; the profile only ever
   slows a crawl down and is recorded as `crawl_status.platformProfile`. The
   render pass is paced too: seeded with the crawl's per-host state, every
   same-origin browser request waits for the same gate, the HTTP cache is
   shared across renders, and its 429s escalate the host and are written back
   to the record. The lavishalice evidence is in `docs/gates/phase-24a.md`.
5. **SSRF policy equivalence.** Talos pins DNS resolution on every hop
   (`api/urlguard.py: pin_outbound_url/pinned_get`). Ariadne's absorbed
   `url-policy` must maintain the same properties: every hop revalidated,
   private/reserved ranges refused, mixed DNS answers refused. If Ariadne ever
   accepts URLs from Talos tenants (it will, transitively), it inherits
   tenant-grade SSRF exposure.
6. **No model names / no judgement in the engine.** Ariadne emits facts with
   client-facing copy (`title`, `explanation`, `howToFix`). Severity-in-context
   and narrative belong to the consuming agent — for Talos that agent is
   tenant-facing, so engine output must already be tenant-safe (no internal
   hostnames, no stack traces in `evidence`). Since Phase 27a the engine's
   `type` and `priority` on each finding rule are the rule's defaults, and the
   agent's per-crawl overrides (`crawl_config_set`) are the judgement.

7. **A stop is a pause, and only an agent's cancel is final.** Since Phase 27b a
   server shutdown leaves its running crawls `paused` (reason `shutdown`) and a restart
   starts none of them: Talos resumes a paused crawl with `crawl_resume`, same id, same
   pages, same earned spacing. `cancelled` now means one thing, an agent's
   `crawl_cancel`, and it is final. Since Phase 27d a stop lands within about a second in
   every phase (host probe, sitemap walk, seeding, page crawl, 404 probe, recheck, resource pass),
   so Talos need not budget a fetch deadline for it. A pause or cancel never makes a crawl faster than
   the spacing it earned (obligation 4), and `crawl_delete` is the one call that
   destroys a crawl, guarded by its confirm echo and, since Phase 28a, by the tenant key
   (`docs/talos-surface.md` §4.1c and §9).

   **Amended in Phase 28b: system pauses resume by themselves, an agent's pause is never
   undone.** Crawls run on worker processes, and a worker that is told to stop
   (`shutdown`, a deploy) or that stops heartbeating (`worker_lost`, a crash or a lost
   host) leaves its crawl `paused` with its leases released and its job abandoned; the
   reaper then requeues it and another worker continues the same crawl. `shutdown` is
   always requeued; `worker_lost` up to **3 times in a row** (only `worker_lost` spends
   the count, and an agent's `crawl_resume` resets it), after which it waits for an agent,
   so a crawl that kills its worker every time cannot loop forever. A pause an agent asked
   for (`request`), a crawl whose stored credentials are unreadable
   (`credentials_unreadable`) and one a worker's own allowlist no longer admits
   (`not_allowed`) are never requeued. A crawl run by a local stdio or library process is
   never requeued by anyone: if that process dies the crawl reads `queuePosition: null`,
   and `crawl_mark_failed` or `crawl_resume` is Talos's to call. So Talos must treat
   `paused` as possibly transient: poll `crawl_status` and read `pauseReason` before it
   decides a human or an agent has to act (`docs/talos-surface.md`, the Phase 28b
   summary).
8. **Talos is still the source of truth for a crawl's credentials; Ariadne keeps an
   encrypted copy for reruns.** Since Phase 27c a crawl can carry custom request
   headers, HTTP Basic auth and cookies (staging sites, pre-issued sessions). Since
   Phase 28b Ariadne stores their values as **AES-256-GCM ciphertext** in
   `crawl_credentials`, under a key (`ARIADNE_CREDENTIALS_KEY`, held by every process
   that accepts or runs crawls) that **the database never holds**, so a restart, a
   deploy or a crawl another worker picks up runs with the stored copy and Talos need
   not re-send it. The associated data binds each ciphertext to its crawl and write, so
   a row copied to another crawl or replayed fails authentication. The values never
   reach a log line, an error, a response, a metric or an export, and the plaintext is
   never in a stored column; the gate's secret scan of every table, both workers' logs,
   the API's log and `/metrics` is the evidence (`docs/gates/phase-28b.md`, clause 4).
   Ariadne stores which kinds were given and the header and cookie names, and deletes
   the values on `crawl_cancel`, on `crawl_delete`, when `crawl_config_set` removes the
   last kind, and 30 days after the crawl settles (`ARIADNE_CREDENTIALS_RETENTION_DAYS`).
   **`CREDENTIALS_REQUIRED` (409, `code: "CREDENTIALS_REQUIRED"`) is now rare**: it
   answers only when the stored copy is unreadable (the key was rotated past it,
   retention removed it, or the row was tampered with) on `crawl_resume`,
   `crawl_render` and a credential patch to `crawl_config_set`, and a QUEUED crawl in
   that state is paused `credentials_unreadable` by its runner before any request. Talos
   then re-sends the values on the call, of exactly the stored kinds and names. A crawl
   that needed credentials never runs without them, so a rotation never turns a gated
   site into a crawl of 401 rows. The secret store therefore remains Talos's
   (tenant-scoped, like model keys) and Talos must keep being able to re-supply them;
   match on `code`, not on the sentence. `crawl_resume` and `crawl_config_set` decrypt in
   the API process only to check the copy or merge a partial patch, and discard the
   values. The values are sent only to the crawl's own site family, never to another
   host, and cannot change the user agent, the delay floor or robots (obligation 4). A
   key is rotated by deploying the new one as `ARIADNE_CREDENTIALS_KEY` with the old as
   `ARIADNE_CREDENTIALS_KEY_PREVIOUS`; a write re-encrypts under the new key. The surface
   is `docs/talos-surface.md`'s Phase 28b and 27c summaries, §1 and §4.1a.

9. **Tenancy: Talos names the tenant on every call, and a foreign crawl is a missing
   crawl.** Since Phase 28a every HTTP request carries `X-Ariadne-Tenant` beside the
   bearer token (400 `TENANT_REQUIRED` / `INVALID_TENANT` otherwise), and the stdio
   server takes `ARIADNE_TENANT` at boot. Talos passes its user id as a string. The value
   is opaque to Ariadne, matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` and is
   case-sensitive. Every crawl-facing route and tool resolves the crawl by (id, tenant),
   and another tenant's crawl answers 404 `NOT_FOUND` exactly as an unknown id does, so
   the answer is no oracle for whether an id exists. Talos must start sending the header
   before it upgrades to 28a. Pinned by `test/api/tenant-isolation.test.ts`; the surface
   is `docs/talos-surface.md`'s Phase 28a summary and §1.

## What Talos must eventually do (not Ariadne's job, recorded so it isn't lost)

- Add agent tools wrapping Ariadne's API (mirroring the sf-skill vocabulary).
- Decide deployment topology (Ariadne as a sidecar service vs shared instance)
  and credential management (admin-managed, like model keys).
- Hold each tenant's crawl credentials (headers, Basic auth, cookies) and re-supply
  them on `CREDENTIALS_REQUIRED` (obligation 8): Ariadne keeps only an encrypted copy for
  reruns, and a rotated key or an expired retention makes it unreadable.
- Run `worker:serve` beside `api:serve`, give both the same database and credentials
  key, and give every worker the crawl allowlist (below).
- Update `docs/talos/api-contract.md` if any tenant-visible surface changes.

## Runtime requirements

- **Postgres 16 or newer.** `sitemap.lastmod-invalid` (ruleset 0.20.0) calls
  `pg_input_is_valid`, which Postgres added in 16. On an older server that rule
  errors loudly rather than reporting nothing, so a deployment, a sidecar or a
  shared instance must run 16+. The dev container and CI already do.
- **Node 22**, and **Chromium** wherever a crawl's render pass runs. Since Phase 28b the
  render pass still runs synchronously in the API process, so the API image carries
  Chromium; the worker image is the same image.
- **Workers (Phase 28b).** `api:serve` accepts and answers and runs no crawl;
  `npm run worker:serve` claims and runs them, and at least one must be running for a
  crawl to start. Both processes need `DATABASE_URL` and `ARIADNE_CREDENTIALS_KEY`
  (`<id>:<base64 of 32 bytes>`; the key is required, and a missing or malformed one is a
  boot error). A worker also needs `ARIADNE_WORKER_HTTP_PORT` (health and metrics) and
  `ARIADNE_ALLOWED_DOMAINS`: **a worker re-checks every crawl it claims against its own
  allowlist**, so set it to the API's. Tunables: `ARIADNE_WORKER_CONCURRENCY` (default
  1), `ARIADNE_TENANT_MAX_RUNNING` (default 1), `ARIADNE_CREDENTIALS_RETENTION_DAYS`
  (default 30), `ARIADNE_CREDENTIALS_KEY_PREVIOUS` for a rotation, `ARIADNE_METRICS_TOKEN`
  (must differ from `ARIADNE_API_TOKEN`; unset makes `/metrics` a 404). `/healthz`,
  `/readyz` and `/metrics` answer before authentication on the API and each worker; point
  the orchestrator's probes at them. `docs/deploy.md` has the image and compose layout and
  `docs/gates/phase-28b.md` the measured behaviour, including that a worker's 50,000-page
  crawl peaked at 188.3 MB against a 290.2 MB bound.

## Cross-references

- The surface contract: `docs/talos-surface.md`. Obligation 9 (tenancy) is met as of
  Phase 28a: the listing and every per-crawl read are scoped by the tenant header
  (`docs/gates/phase-28a.md`). Obligations 7 and 8 were amended in Phase 28b (workers,
  auto-resume, encrypted credentials; `docs/gates/phase-28b.md`).
- Talos repo pointer to this project: `docs/talos/crawler-engine.md` in the
  talos repo (`github.com/dawnforge-lab/talos`, local `/home/eugen-dev/Documents/Workflows/talos`).
- Talos deep history: serena memory `talos-rewrite-status` in the talos
  repo (`.serena/memories/`).
- The audit checklist both systems serve: `skills/ariadne-audit/checklist.md`
  (82 checks; the 47 crawl-derived ones are Ariadne's scope). It moved in-repo in
  Phase 6 and is the living authority; the sf-audit original it was imported from is
  frozen source, recorded in the file's provenance header.

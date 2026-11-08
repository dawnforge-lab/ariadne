# Ariadne ↔ Talos: the seam

Decision (2026-08-25, owner): Ariadne is a **standalone** engine with a
**Talos-ready seam**. It serves the sf-* audit skill workflow from day one, and
is designed so the Talos SEO agent can consume it later without either codebase
absorbing the other.

## The two systems

| | Talos | Ariadne |
|---|---|---|
| What | Multi-tenant SEO SaaS (keyword research, interlinking, redirects, content, ecommerce content, conversational SEO agent) | Site crawl + audit evidence engine |
| Where | `/home/eugen-dev/Workflows/talos`, branch `feat/talos-rewrite` | this repo |
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

## What Talos must eventually do (not Ariadne's job, recorded so it isn't lost)

- Add agent tools wrapping Ariadne's API (mirroring the sf-skill vocabulary).
- Decide deployment topology (Ariadne as a sidecar service vs shared instance)
  and credential management (admin-managed, like model keys).
- Update `docs/talos/api-contract.md` if any tenant-visible surface changes.

## Runtime requirements

- **Postgres 16 or newer.** `sitemap.lastmod-invalid` (ruleset 0.20.0) calls
  `pg_input_is_valid`, which Postgres added in 16. On an older server that rule
  errors loudly rather than reporting nothing, so a deployment, a sidecar or a
  shared instance must run 16+. The dev container and CI already do.
- **Node 22**, and **Chromium** wherever a crawl's render pass runs.

## Cross-references

- The surface contract: `docs/talos-surface.md` (Phase 10). Its §9 records the
  one obligation that is NOT met yet — there is no tenancy isolation on crawl
  listing: `crawl_list` without a `siteUrl` returns every crawl this engine
  holds, other tenants' site URLs included, to any caller with the token.
  Obligation 3 (the crawl row as the isolation unit) holds for every per-crawl
  read; the listing is not scoped, and today's mitigation is deployment.
- Talos repo pointer to this project: `docs/talos/crawler-engine.md` in the
  talos repo (`github.com/dawnforge-lab/talos`, local `/home/eugen-dev/Workflows/talos`).
- Talos deep history: serena memory `talos-rewrite-status` in the talos
  repo (`.serena/memories/`).
- The audit checklist both systems serve: `skills/ariadne-audit/checklist.md`
  (82 checks; the 47 crawl-derived ones are Ariadne's scope). It moved in-repo in
  Phase 6 and is the living authority; the sf-audit original it was imported from is
  frozen source, recorded in the file's provenance header.

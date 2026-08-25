# Ariadne ↔ Talos: the seam

Decision (2026-08-25, owner): Ariadne is a **standalone** engine with a
**Talos-ready seam**. It serves the sf-* audit skill workflow from day one, and
is designed so the Talos SEO agent can consume it later without either codebase
absorbing the other.

## The two systems

| | Talos | Ariadne |
|---|---|---|
| What | Multi-tenant SEO SaaS (keyword research, interlinking, redirects, content, ecommerce content, conversational SEO agent) | Site crawl + audit evidence engine |
| Where | `/home/eugen-dev/Workflows/archimedes`, branch `feat/talos-rewrite` | this repo |
| Stack | Python 3.13 / FastAPI / Next.js 16 / Postgres | TypeScript / Node 22 / Postgres |
| Crawling today | Per-URL pipeline crawls (crawl4ai/httpx) + the agent's single-page `crawl` tool with DNS-pinned SSRF guard | Site-wide frontier crawl (to be built) |

No code is shared in either direction. The seam is a network API.

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
   hostnames, no stack traces in `evidence`).

## What Talos must eventually do (not Ariadne's job, recorded so it isn't lost)

- Add agent tools wrapping Ariadne's API (mirroring the sf-skill vocabulary).
- Decide deployment topology (Ariadne as a sidecar service vs shared instance)
  and credential management (admin-managed, like model keys).
- Update `docs/talos/api-contract.md` if any tenant-visible surface changes.

## Cross-references

- Talos repo pointer to this project: `docs/talos/crawler-engine.md` in the
  archimedes repo.
- Talos deep history: serena memory `talos-rewrite-status` in the archimedes
  repo (`.serena/memories/`).
- The audit checklist both systems serve: `~/.claude/skills/sf-audit/checklist.md`
  (82 checks; the 47 crawl-derived ones are Ariadne's scope).

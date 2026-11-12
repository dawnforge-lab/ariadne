# Ariadne

Backend crawl and audit engine for SEO audits. Named for the thread through the
labyrinth — which is what a crawl frontier is.

Ariadne crawls a site politely, extracts evidence into Postgres, runs a
deterministic rule engine against it, and exposes the results to an AI agent
that writes the audit narrative. It is **not** a Screaming Frog clone: the
engine produces facts (this URL 404s, these 340 URLs share a title, inlinks
median is 4); the agent supplies judgement (severity in context, root cause,
opportunity). Neither side does the other's job.

**Status: implemented through Phase 24a** (each phase's gate evidence is in
`docs/gates/`). What comes next is in the roadmap below.

## Documents — read in this order

| Doc | What it is |
|---|---|
| `docs/crawl-audit-engine-spec.md` | Design: architecture, data contract, rule engine contract, rule map for the crawl-derived checks, rendering strategy, validation approach. |
| `docs/crawl-audit-build-plan.md` | Provenance and phasing: what gets lifted from where (licences verified), the original phases with gates, guardrails. |
| `docs/superpowers/specs/2026-11-04-roadmap-design.md` | The roadmap from Phase 25 on: audit-check parity, agent control plane, cloud foundations, integrations. |
| `docs/talos-integration.md` | The seam to Talos — how the Talos SEO agent will consume this engine, and the design obligations that keep the seam open. |
| `docs/talos-surface.md` | The API/MCP surface contract as Talos sees it. |
| `docs/superpowers/plans/`, `docs/superpowers/specs/` | One plan per phase, and the design specs behind them. |
| `docs/gates/` | Each phase's gate run: the evidence that it closed. |

## What it serves

1. **The sf-* audit skill workflow** (primary, day one): the `sf-audit`
   checklist (sections Pre-Crawl and 1–11, 47 checks) evaluated without
   Screaming Frog, feeding the existing `sf-report` / `sf-action-plan` /
   presentation skills unchanged.
2. **Talos** (designed-for, later): the Talos SEO agent's site-wide crawl
   capability is expected to be satisfied by calling Ariadne's API/MCP surface
   rather than by deepening Talos's own single-page crawl tool. See
   `docs/talos-integration.md`.

## Stack

TypeScript (Node 22), no crawl framework — own loop over a Postgres frontier.
Dependencies kept deliberately small: `undici`, `htmlparser2`, `robots-parser`,
`fast-xml-parser`, `playwright` (render pass only), `pg` + `drizzle-orm`, and
`@modelcontextprotocol/sdk` + `zod` (agent surface only — the MCP transport and
its tool schemas). `cheerio` in devDependencies only, as a parity oracle in
tests.

Two transports, one service layer: `npm run api:serve` (HTTP, bearer-token
trust) and `npm run mcp:serve` (MCP over stdio, process trust). The crawl
domain allowlist binds both. Every request names its tenant
(`X-Ariadne-Tenant` over HTTP, `ARIADNE_TENANT` at boot over stdio).

Crawls run on worker processes (Phase 28b): `api:serve` accepts and answers, and
`npm run worker:serve` claims the jobs from Postgres (`docs/deploy.md` has the image and
compose layout). Environment:

| process | required | optional |
|---|---|---|
| `api:serve` | `DATABASE_URL`, `ARIADNE_API_TOKEN`, `ARIADNE_CREDENTIALS_KEY` | `ARIADNE_API_PORT`, `ARIADNE_API_HOST`, `ARIADNE_ALLOWED_DOMAINS`, `ARIADNE_CREDENTIALS_KEY_PREVIOUS`, `ARIADNE_CREDENTIALS_RETENTION_DAYS`, `ARIADNE_METRICS_TOKEN`, `ARIADNE_EXPORT_DIR`, `ARIADNE_RENDER_DIR`, `ARIADNE_GIT_SHA` |
| `worker:serve` | `DATABASE_URL`, `ARIADNE_CREDENTIALS_KEY`, `ARIADNE_WORKER_HTTP_PORT`, `ARIADNE_ALLOWED_DOMAINS` | `ARIADNE_WORKER_CONCURRENCY` (1), `ARIADNE_TENANT_MAX_RUNNING` (1), `ARIADNE_METRICS_TOKEN`, `ARIADNE_CREDENTIALS_KEY_PREVIOUS`, `ARIADNE_CREDENTIALS_RETENTION_DAYS` |
| `mcp:serve` (stdio) | `DATABASE_URL`, `ARIADNE_TENANT`, `ARIADNE_CREDENTIALS_KEY` | `ARIADNE_ALLOWED_DOMAINS`, `ARIADNE_EXPORT_DIR`, `ARIADNE_RENDER_DIR` |
| `npm run demo`, `scripts/prune-test-crawls.ts` | `ARIADNE_CREDENTIALS_KEY` | |

`ARIADNE_CREDENTIALS_KEY` is `<id>:<base64 of 32 bytes>`, the AES-256-GCM key a crawl's
credentials are stored under; the database never holds it. `/healthz`, `/readyz` and
`/metrics` answer before authentication on the API and each worker.

Hard memory contract: RAM is O(concurrency), not O(URLs). 50k pages under
512MB is the Phase 1 gate; 1M under 512MB is the target.

## Licences

Small, read-and-owned lifts from MIT sources (OpenSEO, SEOnaut fixtures/copy) —
see `docs/crawl-audit-build-plan.md` §1–3 and `THIRD_PARTY_NOTICES.md`
(created in Phase 0). GPL/AGPL sources are not read for implementation
guidance, per the tainting rule.

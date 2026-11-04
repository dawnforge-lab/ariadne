# CLAUDE.md — Ariadne

This file tells Claude Code how to work in this repository.

## What this is

Ariadne is a backend crawl and audit engine: a polite TypeScript crawler over a
Postgres frontier, a deterministic rule engine (page / query / metric rules),
and an agent-facing surface. The evidence layer produces facts; the agent
produces judgement. Full design in `docs/crawl-audit-engine-spec.md`; phasing
and provenance in `docs/crawl-audit-build-plan.md`.

**Session start:** read `docs/crawl-audit-engine-spec.md` and
`docs/crawl-audit-build-plan.md` before writing code. Phases 0–24a are shipped
(gate evidence in `docs/gates/`). The order from Phase 25 on is
`docs/superpowers/specs/2026-11-04-roadmap-design.md`; the active phase is the
newest plan in `docs/superpowers/plans/`. Each phase gets its own design and
plan when its predecessor's gate is green — do not start a phase whose
predecessor's gate has not been demonstrated.

## Relationship to Talos

Talos (`/home/eugen-dev/Workflows/talos`, branch `feat/talos-rewrite`) is
the multi-tenant SEO SaaS. Ariadne is standalone but **Talos-ready**: the
Talos SEO agent will eventually drive site-wide crawls through Ariadne's
API/MCP surface instead of its own crawl tool. `docs/talos-integration.md`
lists the design obligations that keep that seam open — check it before
changing the API surface, auth, or politeness behaviour. No code is shared in
either direction; the seam is the network API only.

## Environment

- **Node 22**, npm, TypeScript strict, ESM (`"type": "module"`).
- **Postgres 16** dev container:
  `docker run -d --name ariadne-pg -p 5440:5432 -e POSTGRES_USER=ariadne -e POSTGRES_PASSWORD=ariadne -e POSTGRES_DB=ariadne postgres:16`
  (port 5440 — 5432 and 5439 are taken on this machine by other projects).
- `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`
- **Chromium** for the render pass: `npx playwright install chromium`, once per
  machine. Without it `test/crawl/renderer.test.ts` AND
  `test/fixtures/harness.test.ts` fail at launch — both drive a real browser
  against a real fixture server, deliberately (no stub). The harness renders the
  whole fixture site, so the browser is now a prerequisite for the end-to-end
  suite and not just for the renderer's own tests. CI installs it with
  `npx playwright install --with-deps chromium`, cached on the locked
  Playwright version (`.github/workflows/ci.yml`).
- Tests: `npm test` (vitest). Typecheck: `npx tsc --noEmit`. Both must stay clean.
- Migrations: drizzle-kit, applied with `npm run db:migrate`. Never hand-apply SQL.

## Hard rules (from the build plan — violations are defects)

1. **Never write a rule that always passes.** If the data is missing, mark the
   check `AGENT` in the registry or leave it unclaimed and let CI say so.
2. **Never fetch inside a rule.** Rules read the database.
3. **Never load the `links` table into memory.** Every link question is SQL.
4. **Never build a DOM on the hot path.** Streaming tokenizer (`htmlparser2`)
   only. `cheerio` lives in devDependencies as a test parity oracle.
5. **Never skip `url-policy`** on any URL the crawler is about to fetch —
   discovered, redirected-to, or supplied by a client/agent.
6. **The memory contract is a hard requirement.** RAM O(concurrency), never
   O(URLs). If the 50k gate crawl peaks above 512MB, find the unbounded
   structure with a heap snapshot; do not raise the limit.
7. **No silent fallbacks.** Errors surface transparently — a failed fetch is a
   classified row, not a skipped URL; a failed rule run is a loud error, not an
   empty findings list.
8. **Licence hygiene.** Lifted files carry a provenance header (source, sha,
   changes) and an entry in `THIRD_PARTY_NOTICES.md`. Never read GPL/AGPL
   sources for implementation guidance. Never depend on unlicensed repos.
9. **Politeness.** Per-host delay + robots `crawl-delay` honoured, branded UA,
   adaptive back-off on blocks. We crawl client sites with permission; being
   throttled by a WAF is our bug, not theirs (see the yellow.com.mt incident in
   `docs/talos-integration.md`).
10. **Rules carry `checkIds`** tracing to the audit checklist, which lives in this
    repository at `skills/ariadne-audit/checklist.md` and is the living authority;
    coverage is a CI query. It was imported once from the frozen sf-audit original
    (`~/.claude/skills/sf-audit/checklist.md`) — the file's provenance header records
    the source sha and what changed. Fix a check in-repo; never re-import.

## Pinned upstream shas

- OpenSEO (`every-app/open-seo`, MIT): `c469a48ae90ab58413b198fe3d1ac1aa90a9b070` (2026-08-24)
- SEOnaut (`StJudeWasHere/seonaut`, MIT): `880b312c28fab8b0bf7fe4f9449dc4746dbb82ff` (2026-05-23)

Lift from these shas exactly; the provenance headers record them. Upstream is
one-time source material, never a sync target.

## Layout (target)

```
src/crawl/          fetch, discovery, frontier, loop, politeness governor
src/crawl/parse/    streaming page analyzer (absorbed from OpenSEO, extended)
src/rules/{page,query,metric}/   the rule implementations
src/rules/registry/ types, defineRule validation, copy (titles/explanations/fixes)
src/db/             drizzle schema + migrations
src/report/         issue/metric shaping for sf-report / sf-action-plan
test/fixtures/      fixture site pages (badseo content + our own)
```

## Commits

Conventional, small, after each green test cycle. End commit messages with:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

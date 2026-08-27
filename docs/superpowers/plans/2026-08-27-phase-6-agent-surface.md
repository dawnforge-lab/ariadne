# Phase 6 — Agent Surface + Native Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The programmatic surface (HTTP API + MCP server) designed from Ariadne's native shapes, and a fresh in-repo skill family (`skills/ariadne-*`) that consumes it — replacing, not replicating, the SF-shaped workflow. Gate: an agent completes checklist sections 1–11 against a real site using only these tools.

**Architecture:** A service layer over the existing db/rules modules exposes crawls/issues/metrics/pages as filtered, paginated, tenant-safe queries. One HTTP server (node:http, bearer-token auth, domain allowlist) and one MCP server (stdio) share that layer. Skills are markdown in `skills/`, versioned with the engine; the audit checklist moves in-repo as the living authority (the sf-audit original stays frozen as provenance). The phase opens with build-plan §7's pre-real-crawl hardening — the gate crawls a real site, so the open-internet gaps carried since Phase 1 come due first.

**Owner direction (2026-08-27):** skills live in-repo for maintainability; the sf-* family in `~/.claude/skills/` stays untouched — reference/examples only, no use in Ariadne; skills are written fresh for what Ariadne needs now or later.

**Tech Stack:** Node 22 TS strict ESM; node:http (no server framework unless a task argues one and the controller rules); `@modelcontextprotocol/sdk` for the MCP server; undici (existing); vitest.

**Spec:** `docs/crawl-audit-engine-spec.md` §7 (build order 6), `docs/crawl-audit-build-plan.md` §Phase 6 + §7 (pre-real-crawl checklist, verbatim items below), `docs/talos-integration.md` (seam obligations 1–6 — binding on every API/auth/politeness decision).

## Global Constraints

- **Talos seam obligations bind the surface** (talos-integration.md): programmatic trigger + status via API and MCP; responses filtered and paginated, never a full export inline; bearer-token auth + domain allowlist on crawl triggers from day one; multi-crawl capability (crawl rows are the isolation unit — nothing assumes "the one current crawl"); tenant-safe output (facts + copy, no judgement, no internal hostnames, no stack traces in evidence).
- All ten hard rules continue to bind; notably no silent fallbacks (an unauthorized request is a 401 with a body, a disallowed domain is a 403 naming the allowlist, a bad cursor is a 400 — never an empty 200) and politeness (the §7 items exist because rule 9 meets the open internet).
- The engine emits no judgement: severity ranking, narrative, and "impact" filtering belong to the skills/agent.
- Skills are fresh: no text copied from sf-* files beyond the checklist content (which is ours — the 47 check ids trace to it) and cite-worthy structural ideas noted as such. The checklist import carries a provenance header (source path, date) per hard rule 8.
- CLAUDE.md hard rule 10's checklist pointer updates to the in-repo path in the same commit that lands the in-repo checklist.
- Pagination: cursor-based (`{items, nextCursor}`), default page size 50, max 200. Deterministic order on every listing (id or url tiebreak).
- `npm test` + `npx tsc --noEmit` clean at every commit. Conventional commits ending:
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Pre-real-crawl hardening (build-plan §7, verbatim — the phase opener)

**Files:** Modify `src/crawl/fetch-page.ts`, `src/crawl/loop.ts` (agent/dispatcher construction, config persistence), `src/crawl/url-policy.ts`, tests per file (+ a real-site robots verification note in the report, not CI).

**Interfaces:** Five items, each its own red/green cycle within one task:
1. `accept-encoding: gzip` on page fetches with a cap on **decompressed** bytes as well as wire bytes (discovery already caps decompressed sitemap bytes — mirror that constant discipline; oversize → classified fetch failure, not a truncated page row).
2. Per-origin connection cap on the undici agent (`connections` per origin at the Agent/Pool level) so politeness is not paced by the host gate alone.
3. `allowPrivate` must not survive into persisted crawl config: strip it when the config is stored; a resume requires explicit re-assertion rather than replaying it from the row (a resumed crawl silently keeping a test-only escape hatch is the silent fallback this project forbids).
4. Robots origin-variant behaviour (`RobotsInfo.isAllowed` www/apex rewrite): add a second fixture-style test against a live-shaped variant matrix; actual real-site verification is recorded at the Task 7 gate.
5. 6to4 (`2002::/16`) and Teredo (`2001::/32`) excluded from url-policy's IPv6 global-unicast allowlist (both embed an IPv4 address the `2000::/3` allowlist waves through — extract and evaluate the embedded IPv4 against the private/reserved refusals).

- [ ] TDD each item (oversize-decompressed refusal; socket-count observation; persisted-config strip + resume re-assertion; variant matrix; both IPv6 embeddings refused with the embedded-IPv4 reason) → full suite green → commit `fix: pre-real-crawl hardening — gzip caps, socket caps, allowPrivate strip, 6to4/Teredo (P6 opener, build-plan §7)`.

---

### Task 2: Service layer + HTTP API core (auth, allowlist, crawl lifecycle)

**Files:** Create `src/api/service.ts` (the query/command layer both servers share), `src/api/http.ts` (node:http server + router), `src/api/auth.ts`, `src/api/config.ts`; modify `package.json` (scripts: `api:serve`); tests `test/api/http.test.ts` (real server on an ephemeral port).

**Interfaces:**
- Config (env or file): `ARIADNE_API_TOKEN` (required to start — refusing to boot tokenless is the no-silent-fallback posture), `ARIADNE_ALLOWED_DOMAINS` (comma list; exact-host or `*.example.com` suffix match; empty list = crawl triggers refused, queries still allowed).
- Auth: `Authorization: Bearer <token>` on every route; 401 JSON body on failure.
- Crawl lifecycle: `POST /crawls` {siteUrl, config overrides} → allowlist check (403 naming the rejected host) → url-policy check → creates the crawl row and starts the crawl loop in-process (queued FIFO if one is running — multi-crawl obligation: the queue is crawl-row-backed, no singleton state); `GET /crawls` (paginated list); `GET /crawls/:id` (status, counts, render_pass_count, timings); `POST /crawls/:id/fail` — the `markCrawlFailed` surface from the Phase 5 backlog: allowed only on `status='running'` rows whose leases are all expired (else 409), sets `failed`; `POST /crawls/:id/render` (runs selection + render pass; the driver's own three-condition guard surfaces as 409s); `POST /crawls/:id/rules` (runs runRules; returns the summary).
- `allowPrivate` is NOT accepted over the API at all (400 if present) — test-only, per Task 1's strip.
- Service layer functions are the only place SQL lives; http.ts does routing/serialization only. Every handler error → JSON `{error}` with the right status; unexpected errors → 500 with a correlation id, stack to server log only (tenant-safe).

- [ ] TDD against a live server instance (auth refusals, allowlist accept/reject/suffix cases, crawl start against the fixture site, queue behaviour with two starts, markCrawlFailed on expired-lease crawl + 409 on live one, allowPrivate 400) → commit `feat: HTTP API — token auth, domain allowlist, crawl lifecycle with queue (P6-T1)`.

---

### Task 3: Query endpoints — issues, metrics, pages (filtered, paginated, tenant-safe)

**Files:** Extend `src/api/service.ts` + `src/api/http.ts`; tests extend `test/api/http.test.ts` (or a second file, DB-seeded).

**Interfaces:**
- `GET /crawls/:id/issues` — filters: `severity`, `checkId`, `ruleId`, `category`, `pageType`; returns grouped-by-rule summaries `{ruleId, checkIds, severity, category, title, count, sampleUrls[≤5]}` (the agent's triage view), paginated, ordered severity desc then ruleId.
- `GET /crawls/:id/issues/:ruleId/urls` — the URL-level slice for one rule: `{url, evidence}` rows, paginated (the sf-action-plan tab feed), evidence passed through as stored (already tenant-safe copy per registry discipline — verify no field leaks internals; the serializer allowlists fields rather than spreading rows).
- `GET /crawls/:id/metrics` — filters: `metricId`, `scope`, `scopeValue`; value jsonb passed through with title/explanation copy joined from the registry (the quotable table).
- `GET /crawls/:id/pages` — filters: `pageType`, `statusCode`, `indexable`, `rendered`; slim projection (url, status, type, indexability, depth, word_count, rendered flags), paginated.
- `GET /crawls/:id/export` — streams a gzipped JSONL file to disk under an exports dir and returns `{path, rows}` — never inline (obligation: a chat agent consumes these; the file is for humans/pipelines).
- Copy joined from the registry at read time (single source; no copy duplication into API code).

- [ ] TDD with a seeded crawl (filter matrix, pagination determinism incl. cursor round-trip, field-allowlist serialization proven — a row with an injected extra column does not leak, export file shape) → commit `feat: query surface — issues/metrics/pages, filtered and paginated (P6-T2)`.

---

### Task 4: MCP server

**Files:** Create `src/api/mcp.ts`; modify `package.json` (dep `@modelcontextprotocol/sdk`, script `mcp:serve`); tests `test/api/mcp.test.ts` (in-process client transport).

**Interfaces:** Tools mapping 1:1 onto the service layer (NOT onto the HTTP routes — same layer, second transport): `crawl_start`, `crawl_status`, `crawl_list`, `crawl_render`, `crawl_rules`, `crawl_mark_failed`, `issues_list`, `issue_urls`, `metrics_get`, `pages_query`, `export_crawl`. Same allowlist + the token concept adapted to MCP (the server process holds the DB; MCP callers are local/stdio — document the trust model: MCP transport is process-trust, HTTP is token-trust; the allowlist binds BOTH). Tool descriptions written for an agent consumer (what the tool answers, filter names, pagination contract); every tool returns compact JSON, no prose. Errors are MCP tool errors carrying the same `{error}` shapes.

- [ ] TDD via the SDK's in-memory client (each tool happy path + one refusal each; pagination pass-through; allowlist enforcement on crawl_start) → commit `feat: MCP server over the service layer (P6-T3)`.

---

### Task 5: skills/ariadne-crawl + skills/ariadne-audit + the in-repo checklist

**Files:** Create `skills/ariadne-crawl/SKILL.md`, `skills/ariadne-audit/SKILL.md`, `skills/ariadne-audit/checklist.md` (imported), `skills/README.md` (what lives here, how to install into `~/.claude/skills/`); modify `CLAUDE.md` (hard rule 10 pointer → `skills/ariadne-audit/checklist.md`; keep the provenance note).

**Interfaces:**
- `checklist.md`: imported from `~/.claude/skills/sf-audit/checklist.md` with a provenance header (source path, import date, sha of source content); content edits in the same commit ONLY where a check's "how" changed owner (e.g. CHECK-01/02/34 now say "answered by the engine's render pass — quote `issues_list`/`metrics_get`", not DevTools steps; SF CLI export commands throughout become the equivalent Ariadne tool calls or are marked engine-covered). Every CHECK id and its Record:/Evaluate: semantics stay stable — the registry's checkIds trace here.
- `ariadne-crawl/SKILL.md`: start/monitor a crawl through the MCP tools (or HTTP), politeness expectations, allowlist prerequisite, when to run render + rules, how to read crawl_status. Fresh text.
- `ariadne-audit/SKILL.md`: the orchestrator, fresh. Structure: Phase 0 analytics context (GSC/GA4/Ahrefs — CHECK-71–81, unchanged in spirit, no SF anywhere); Phase 1 crawl via ariadne-crawl (or locate an existing crawl id); Phase 2 engine-answered checks — walk the checklist's crawl-derived 47 by querying `issues_list` grouped by checkId + `metrics_get` for the Record: lines (the metrics were built to be quotable — this is where that lands); Phase 3 agent checks (38/41/42) and the remaining DevTools/visual checks; Phase 4 findings assembly (per-check verdict + evidence references, the input shape ariadne-report/action-plan consume — define it here explicitly as JSON the agent writes to a findings file).
- The skill never re-derives what the engine asserts: a check the registry claims is answered by quoting engine output, full stop (the skill-side equivalent of "never write a rule that always passes" is "never re-judge a claimed check by eyeball").

- [ ] Write both skills + import; self-review pass for placeholder-free completeness; the repo's own docs build (none) — verification is review-based + a dry-run transcript in the report (walk sections 1–2 against the fixture-site crawl using only tool calls) → commit `feat: ariadne-crawl + ariadne-audit skills — the checklist comes home (P6-T4)`.

---

### Task 6: skills/ariadne-report + skills/ariadne-action-plan

**Files:** Create `skills/ariadne-report/SKILL.md`, `skills/ariadne-action-plan/SKILL.md`.

**Interfaces:**
- `ariadne-report`: consumes the findings shape from ariadne-audit Phase 4 + direct `metrics_get` quotes; structure: exec summary, per-section findings with severity-in-context (the judgement layer lives HERE, not in the engine), metric tables quoted verbatim, prioritised recommendations. Fresh text; deliverable is markdown.
- `ariadne-action-plan`: Excel via openpyxl (as before — that part of the old design is workflow, not SF); tabs fed from `issues_list` + `issue_urls` (the per-rule URL slice IS the tab body: url, evidence columns flattened); impact filtering is the skill's judgement (severity + counts + metrics context), explicitly NOT an engine field; split-by-who-does-the-work retained as a structuring principle (it's a good idea and it's ours to keep — note it as inspired-by in a comment, no text copied).
- Both skills state their prerequisite chain (audit findings file + reachable API/MCP) and fail loudly when it's missing.

- [ ] Write both; self-review; dry-run one tab + one report section from the fixture crawl in the report → commit `feat: ariadne-report + ariadne-action-plan skills (P6-T5)`.

---

### Task 7: Real-site gate + docs/gates/phase-6.md

**Files:** Create `docs/gates/phase-6.md`; gate artifacts under an exports/ dir (git-ignored).

- The gate (build plan): **an agent completes checklist sections 1–11 against a real site using only these tools.** Mechanics: the controller supplies the site (owner names it at execution — permission required; politeness config per the site's scale); crawl via the API; render + rules; then a fresh agent session (the gate's honesty: it gets ONLY the ariadne-* skills and MCP tools, no repo access) walks sections 1–11 and produces the findings file; the transcript is the gate evidence.
- `docs/gates/phase-6.md` records: date, commit, the site (or an anonymised handle if the owner prefers), crawl numbers (pages, wall, RSS — the first real-site numbers in the project), politeness observations (per-host pacing honoured, any 403/429 and the back-off behaviour), robots-variant verification result (Task 1 item 4's real-site half), sections 1–11 outcome check-by-check (answered-by-engine / agent-judged / blocked-and-why), API/MCP call counts (the pagination story at real scale), supersessions + remaining backlog, CI link placeholder.
- [ ] Run for real → record → full suite + typecheck green → commit `test: phase 6 gate — a real site audited end-to-end through the agent surface`.

---

## Self-Review (performed at authoring time)

- **Spec coverage:** build plan P6-T1 (MCP tools mirroring skill vocabulary) → superseded by owner direction 2026-08-27: native surface + fresh skills (T2–T6); P6-T2 (domain allowlist) → T2; P6-T3 (filtered/paginated, no full export inline) → T3; gate → T7. Build-plan §7 pre-real-crawl items → T1 verbatim. Phase 7's report shaping largely collapses into T6 (noted for the owner: Phase 7 may reduce to presentation/roadmap skills if wanted later — fresh, when needed). Talos obligations 1–6 mapped: 1→T2/T4, 2→T2, 3→T2 queue, 4→T1+T7 observations, 5→T1 item 5 (and url-policy already), 6→T3 serialization allowlist.
- **Backlog folds:** markCrawlFailed → T2 (with the expired-lease guard). NOT folded (stay recorded): browser-tree bound decision (needs its own measurement argument), streaming metric rows, hreflang streaming, CHECK-44 required set, derivePageType heuristics, resolved-render-config persistence, spacing-test warm-up flake — T7's gate doc restates them.
- **Placeholder scan:** the real site's name is a deliberate at-execution blank (owner supplies; permission gate). Skill text is authored at execution by design (the tasks specify structure + constraints, not prose). No TBDs otherwise.
- **Type consistency:** service layer produced in T2 consumed by T3 (extension) and T4 (second transport); findings-file shape defined in T5 consumed by T6; checklist path changed in T5 is referenced by CLAUDE.md in the same commit.
- **Known risks named:** in-process crawl execution under an HTTP server changes the process lifecycle (a crawl outliving a request — the queue design must be crash-honest: a killed server leaves status='running', which markCrawlFailed + the P5 guard already handle); MCP SDK is a new dependency (licence-check on lift, MIT expected); the real-site gate depends on external permission and site behaviour — politeness incidents are findings, not failures, unless caused by our config.

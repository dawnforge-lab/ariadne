# Phase 11: Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the crawler to see the site's resources — images, CSS, JS — the way it already sees pages: discovered from markup, fetched under the same politeness discipline, classified honestly, and turned into the Ahrefs-parity issues (oversized images, broken resources, page weight) plus the surfaces Talos renders them on. Metadata only; no bodies stored.

**Architecture:** Four moving parts in dependency order. (1) The streaming analyzer emits per-page resource references (it currently only counts images); a `resources` table (one row per distinct URL per crawl) and `page_resources` edge table land in migration 0013. (2) A resource fetch pass runs after the page crawl under the SAME politeness governor — HEAD-first with a counted-and-discarded GET fallback, per-host queues (third-party asset hosts get their own queues at the same conservative spacing), url-policy on every URL (hard rule 5), robots honoured per host. (3) New rules read the table (never fetch — hard rule 2). (4) The surfaces carry it: catalog/issues automatically via the registry, a resources CSV view, crawl_status counts, the contract doc. The CHECK-32 temporary bridge is retired by the owner-designed engine-coverage check this plan proposes.

**Tech Stack:** TypeScript strict/ESM, htmlparser2 (streaming — no DOM, hard rule 4), undici, drizzle migration 0013, Postgres 16, vitest.

**Spec authority:** `docs/talos-integration.md` obligations (esp. 4 politeness, 5 SSRF); `docs/gates/phase-10.md` §Phase-11 ledger (the CHECK-32 handoff, the carried minors); `skills/ariadne-audit/checklist.md` CHECK-48/49/50 (whose "not measured — browser work" sentences this phase partially retires, updated in-repo as the living authority, rule 10).

**Owner decisions (2026-09-01, verbatim in substance):**
1. Resource classes: **images + CSS + JS** (fonts/media/favicons wait).
2. Storage: **metadata only** — status, content-type, bytes, timing, cache headers; no bodies, no image decoding.
3. Gate: **fixture + one sanctioned lavishalice.com re-crawl WITH resource fetching** at the proven polite settings; audit 5 rides on it.
4. (Standing from Phase 10) two consumption modes; the web surface renders these issues; the agent audit reads them through the same tools.

## Global Constraints

- CLAUDE.md hard rules 1–10 bind every task. The sharp ones here: **rule 5** — url-policy on EVERY resource URL before any fetch (tenant-grade SSRF posture, obligation 5); **rule 2** — rules read the database, the fetch pass is the only fetcher; **rule 6** — RAM O(concurrency): the resource pipeline streams, dedup happens in SQL (upsert), never a Set of URLs in memory; **rule 9** — politeness: resource fetches share the per-host spacing machinery pages use, and a third-party asset host is a guest's host — same conservative defaults, adaptive back-off, branded UA.
- Baseline: branch `worktree-phase-11`, base `926696e` (main, Phases 0–10). **1568 tests / 65 files green (~100s), tsc clean, migrations 0000–0012, ruleset 0.7.0.**
- The dev DB's three lavishalice crawls remain read-only reference data. The gate's NEW crawl is a fourth, owner-sanctioned, at the proven settings (2000ms/2 workers) — resource fetching must not multiply the load on the client site beyond what the plan's budget argues (T2 states the arithmetic: resource HEADs interleave into the same host queue, so wall time grows but request rate per host does not).
- Ruleset bumps once, in T3 (new rules with new verdicts): **0.7.0 → 0.8.0**.
- Migration 0013 is this phase's ONE schema event (T1). Nothing else touches schema.
- Every new/changed API surface: both transports, description pins (tool AND inputSchema field level), added to the internals sweep's path list and the cross-transport pair list (both hand-enumerated lists carry grow-with-the-surface obligations — honour them).
- Conventional commits ending:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: See and remember — analyzer refs, migration 0013, persistence

**Files:**
- Modify: `src/crawl/parse/page-analyzer.ts` (emit resource refs), its type exports
- Modify: `src/db/schema.ts`; Create: `drizzle/0013_*.sql` (generated)
- Modify: the page persistence path (`src/crawl/persist.ts` or wherever PageWriter lives — implementer locates) to upsert resources + edges
- Test: analyzer suite, `test/crawl/persist.test.ts`, new migration test

**Interfaces:**
- Produces: `AnalyzedPage.resourceRefs: {url: string, kind: "image"|"css"|"js"}[]` (absolute URLs resolved against the page's base — reuse the existing link-resolution helper; srcset parsed, FIRST candidate only, documented); `resources` table `{crawl_id, url (unique per crawl), kind, fetch_class (null until fetched), status_code, content_type, bytes, cache_control, fetched_at, fetch_ms, fetch_reason}`; `page_resources` `{crawl_id, page_id, resource_url-ref}` edges. FK cascade from crawls like every sibling table.
- Extraction sources (closed list, documented): `<img src>`, `<img srcset>` (first candidate), `<source src/srcset>` inside `<picture>`, `<script src>`, `<link rel="stylesheet" href>`. NOT: inline styles' url(), CSS @import (needs body parsing — out of scope with metadata-only), `preload`/`prefetch` hints, favicons, fonts, video/audio (owner scope).
- Dedup is the TABLE's (unique index on crawl_id+url, upsert `on conflict do nothing`); the edge table carries the per-page fan-out. Rule 6: the analyzer emits refs per page and the writer batches them with the page — nothing accumulates across pages.

**Steps:**
- [ ] **Step 1: failing analyzer tests** — a fixture page with img/srcset/picture/script/link-stylesheet yields exactly the expected refs with resolved absolute URLs; data: URIs, javascript:, and fragment-only refs are DROPPED (with a test); a page with 200 images emits 200 refs without the counters changing (imagesTotal untouched — the counters' provenance comment says why both exist).
- [ ] **Step 2: schema + migration** — generate 0013, review line-by-line (the Phase 9/10 discipline); apply to dev DB; verify the three reference crawls gained empty tables and nothing else changed.
- [ ] **Step 3: failing persistence tests** — a crawled fixture page's refs land as resource rows (unfetched: fetch_class null) + edges; two pages sharing an image produce ONE resource row and TWO edges; the crawl-delete cascade covers both tables.
- [ ] **Step 4: implement; full suite + tsc green; commit.** No fetching in this task — `fetch_class null` means "seen, not yet asked" and that meaning is written on the column (the null-vs-zero doctrine's newest citizen).

### Task 2: Ask politely — the resource fetch pass

**Files:**
- Create: `src/crawl/resources/fetch-resources.ts` (the pass)
- Modify: `src/crawl/loop.ts` (invoke after page crawl, before template inference), `src/crawl/fetch-page.ts` ONLY if a helper is genuinely shareable (do not fork the politeness machinery — reuse the governor)
- Test: new suite driving the real fixture server

**Interfaces:**
- Consumes: unfetched `resources` rows; the crawl's politeness state (`hostSpacingMs` ratchet, the per-host gate) — the SAME governor instance/machinery pages used, so a host that earned 30s spacing keeps it for its resources.
- Produces: fetched metadata on each row; `fetch_class` classified with the page vocabulary (`ok`/`client_error`/`server_error`/`fetch_error`/`refused`) + `robots_denied`; crawl_status gains `resources: {seen, fetched, failed, skipped}`.
- Behaviour (each a test):
  1. **url-policy on every URL** before any network (rule 5): private/reserved refused → `refused` with the reason, never fetched.
  2. **HEAD first; on 405/501 or a HEAD without content-length, ONE GET with the body counted and discarded** (streamed to a counter, never buffered — rule 6); bytes from content-length or the count, `bytes_source` recorded (header vs counted).
  3. **Per-host queues at the crawl's spacing** — same-origin resources join the page host's queue; a third-party asset host gets its own queue at the crawl's configured delay (never faster), the adaptive ratchet applying per host. The politeness arithmetic goes in the module header: request RATE per host is unchanged from the page crawl's; only wall time grows.
  4. **robots.txt honoured per host**: the crawl origin's robots is already loaded; a third-party host's robots is fetched once (itself politely) and cached for the crawl; disallowed → `robots_denied`, no fetch. (Googlebot respects robots for assets; so do we.)
  5. **Caps**: `maxResources` per crawl (config, default 10_000) and `maxResourceHosts` (default 20) — beyond either, rows stay unfetched with `fetch_reason: "resource-cap"` and crawl_status says so (a cap is loud, never silent — rule 7).
  6. A dead host (3 consecutive fetch_errors) parks its remaining queue as `fetch_error` with the reason — no unbounded retries.
- The pass is resumable the frontier's way: an interrupted pass leaves nulls, a re-run asks only nulls (idempotent; test).

**Steps:** red-first per behaviour above against the fixture server (which gains a static assets directory + a third-party-host simulation via a second listener); then loop.ts wiring (order argued in the docblock: after pages so the ref set is complete, before inference so wall-time reporting includes it); suite + tsc; commit.

### Task 3: Judge — the rules, the metric, the checklist

**Files:**
- Create: `src/rules/query/resources.ts`; Modify: `src/rules/metric/` (page-weight metric), registry copy, `src/rules/registry/registry.ts` (0.8.0)
- Modify: `skills/ariadne-audit/checklist.md` (CHECK-48/49/50 engine lines — the living authority learns what is now measured)
- Test: rules suite + copy contracts

**Interfaces (each rule reads the DB only — rule 2):**
- `resources.broken` (warning, CHECK-49 for images / CHECK-48 for js+css — implementer verifies the honest checkId split against the checklist text and records it): a page references a resource whose fetch_class is client_error/server_error; per-page findings with the resource URLs in evidence; capped listing with exact totals (the house shape).
- `images.oversized` (warning, CHECK-49): image resources over `IMAGE_WEIGHT_WARN = 100_000` bytes (the checklist's own 100KB line), per-resource findings carrying bytes + the referencing page count; threshold exported, copy states it.
- `images.legacy-format` (info, CHECK-49): content-type png/jpeg above the same weight threshold where webp/avif would help — copy careful: a format is a choice, not a defect; info only.
- `page.weight` metric family (CHECK-50 partial): per page-type and site scope — page HTML bytes + sum of its resources' bytes (edges joined in SQL; unfetched resources make the row carry `atLeast: true` — a floor, stated).
- `resources.uncached` (info, CHECK-50 partial): fetched-ok resources with no cache-control/expires — count + samples.
- Every "not measured — browser work" sentence in CHECK-48/49/50 that is now false gets updated in the SAME commit as the rule that falsifies it (rule 10; the checklist's provenance header discipline).
- **RULESET 0.7.0 → 0.8.0** in this task (new rules = new verdicts), rationale comment per house pattern.

**Steps:** red-first per rule with fixture crawls carrying known resource shapes; the null-vs-unfetched boundary tested per rule (an unfetched resource is never "broken" — it is unknown, and the rule's evidence says which); suite + tsc; commit.

### Task 4: Show — surfaces, contract, and the engine-coverage check

**Files:**
- Modify: `src/api/service.ts` (+ transports): crawl_status resources block; `export_crawl` gains a `resources` CSV view (url, kind, status, bytes, contentType, cacheControl, referencingPages); pages_query per-page resource rollup ONLY if cheap (implementer decides, records)
- Modify: `docs/talos-surface.md` (new surfaces + the doctrine's new citizen: fetch_class null = seen-not-asked), sweep path list + pair list (grow-with-surface obligations)
- Modify: `skills/ariadne-audit/checklist.md` (**the owner-designed check this plan proposes — approved with this plan**): **CHECK-83 "Engine coverage and evidence completeness"** — did the crawl finish or cap; did the rules run and when (rulesRunAt/ruleset); what was truncated (findingCap, truncation notes); render coverage (selectionMode, seats); resource coverage (seen/fetched/capped). Engine-served from crawl_status + the caveat surfaces; the audit answers it FIRST because every later check's confidence hangs on it. **`site.health` re-files from CHECK-32 to CHECK-83** — the Phase 10 temporary bridge retired exactly as ledgered.
- Test: transport suites, description pins, the sweep/pair lists extended

**Steps:** red-first; the CHECK-32→CHECK-83 re-file moves the T2-P10 disclaimers to a plain statement (the bridge paragraphs come OUT — the honest label is now the real label); suite + tsc; commit.

### Task 5: Prove — docs guard, the gate crawl, audit 5

**Files:**
- Modify: `test/skills/identifier-guard.test.ts` (extend to `docs/talos-surface.md` + gate docs' file:line citations — the Phase 10 parked hygiene item, closing it)
- Create: `docs/gates/phase-11.md`
- Deliverables: `audits/lavishalice.com-audit5/` (at the main checkout root)

**Steps:**
- [ ] **Step 1: the docs citation guard** — the T5-P10 throwaway verification script becomes a test: every `file:line` citation in talos-surface.md resolves to a matching test line. Red-first by breaking one citation.
- [ ] **Step 2: the gate crawl** (owner-sanctioned herewith): lavishalice.com, proven settings (2000ms delay / 2 workers / maxPages 3000 / findingCap null / supplied sitemap), resource fetching ON with default caps. Politeness evidence recorded: per-host request timelines, hostSpacingMs, blockedPages (expect 0), the third-party host census (Shopify CDN hosts) with their spacing. Then rules at 0.8.0.
- [ ] **Step 3: audit 5** — skills-only, into audit5/, exercising the new checks live (CHECK-49 with real image weights, CHECK-83 first-ever answer, the resources CSV view) + delta vs audit 4.
- [ ] **Step 4: docs/gates/phase-11.md** — provenance discipline absolute; the politeness story is the headline (a crawler that grew resource fetching and stayed polite is the phase's claim); CI placeholder; the carried minors restated.

---

## Gate (owner-approved shape)

1. Fixture: every T1-T3 behaviour red-first tested; the fixture site serves assets incl. a second-host listener.
2. **The real crawl**: zero blocks, spacing evidence per host (including CDN hosts), resource census complete or loudly capped.
3. Audit 5 delivered with the new checks answered live; CHECK-83 answered first.
4. Full suite green, tsc clean, migrations 0000–0013, tree clean, reference crawls untouched (the gate crawl is a NEW row).

## Explicitly out of scope

Fonts/media/favicons; CSS body parsing (@import, url()); image dimension decoding; storing bodies; render-blocking analysis (stays DevTools in CHECK-48); tenancy on crawl_list (pre-tenancy posture stands); Talos-side UI.

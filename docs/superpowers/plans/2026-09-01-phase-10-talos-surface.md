# Phase 10: Talos Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ariadne's API serve an Ahrefs-Site-Audit-style dashboard (visual checklist, categorised issues, health rollup, cross-crawl change tracking, spreadsheet downloads) so Talos can build its Site Audit UI entirely on the network seam — without touching the agent-audit product, the database, or the crawler's behaviour.

**Architecture:** Four read surfaces added to the existing API/MCP pair (rule catalog, health-rollup metric, crawl comparison, CSV streaming exports) plus the written contract Talos codes against. Everything reads existing tables; no crawler change, no migration unless T3's site-scoped listing needs an index (it gets the decision, not the assumption). Resource fetching (owner-approved) is **Phase 11** — a crawler extension with its own politeness design and its own gate; its plan is written when this phase's gate is green.

**Tech Stack:** TypeScript strict/ESM, node:http + @modelcontextprotocol/sdk (both transports get every surface), drizzle/Postgres 16, vitest.

**Spec:** `docs/talos-integration.md` (the six design obligations bind every task — notably #1 filtered/paginated never-full-inline, #2 auth, #3 multi-crawl, #6 tenant-safe no-judgement output) and the Ahrefs Site Audit reference screenshot supplied by the owner 2026-09-01 (overview: health score gauge, issues distribution errors/warnings/notices, crawl-status donuts, top-issues table with Change/Added/New/Removed, status-by-depth chart, bulk-export block).

**Owner decisions (2026-09-01, verbatim in substance):**
1. Cross-crawl change tracking (Added/New/Removed) **IN scope** this phase.
2. Resource fetching (images/CSS/JS) **APPROVED — deferred to Phase 11** as its own crawler-extension phase (this plan's split, presented with the plan).
3. Health score: **Ariadne emits ingredients + documented ratio**; Talos owns the gauge, thresholds, and labels — no judgement in the engine.
4. Spreadsheet exports: **Ariadne streams CSV**; Talos proxies the download.
5. The agent audit stays a separate product; nothing in this phase changes the skills or the audit flow.

## Global Constraints

- CLAUDE.md hard rules 1–10; notably rule 3 (never load the links table into memory — the CSV streams and the compare must be cursor/stream SQL), rule 7 (no silent fallbacks), and obligation 6 (tenant-safe: no internal hostnames, paths, or stack traces in any new response).
- Baseline: branch `worktree-phase-9` HEAD `d7adc90` (**stacked on unmerged PR #8**, same precedent as Phase 8 on #6 — fast-forward stack, nothing rebases; if the owner says "merge" for #8 mid-phase, nothing changes here). **1440 tests / 63 files green, tsc clean, migrations 0000–0012, ruleset 0.7.0.**
- New worktree off this branch: `phase-10-talos-surface`.
- `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`; the three lavishalice crawls are reference data — T3's gate demo READS two of them, nothing writes them (the audit-4 re-judge at 0.7.0 is part of the data's story now: `crawl_02ff6f7a` findings are 0.7.0, the other two are 0.6.0 — the compare surface must handle exactly this honestly).
- Every new surface lands on BOTH transports with the same shape, is bearer-authed like its neighbours, paginated/filtered per obligation 1, and carries an MCP description accurate against the live shape **with a description pin test** (the Phase 9 lesson: unfenced descriptions rot).
- `RULESET_VERSION` stays 0.7.0 — nothing here changes what a rule sees or says.
- Conventional commits ending:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `rules_catalog` — the checklist the UI renders

**Files:**
- Modify: `src/api/service.ts` (catalog reader), `src/api/mcp.ts` + `src/api/http.ts` (both transports)
- Test: `test/api/` (both transport suites), description pin

**Interfaces:**
- Produces: `rules_catalog {crawlId?}` → `{ rulesetVersion, rules: [{id, kind, severity, category, checkIds, title, explanation, howToFix, fired?: {count, atLeast?} | null}] }`. Without `crawlId`: the static registry (85 rules, all copy) — what Talos renders as the checklist skeleton. With `crawlId`: each rule additionally carries its fired state for that crawl — `fired: {count}` (0 is a real value: ran and found nothing), or `fired: null` when the crawl has never been judged (`rulesRunAt` null), so "clean" and "never measured" cannot be conflated (hard rule 7's UI-facing form).
- Consumes: the registry (`buildRegistry()`), issue-copy, `issues_list`'s existing count query shape.

**Steps:**
- [ ] **Step 1: failing tests** (both transports): (a) no-crawlId returns all 85 rules with non-empty title/explanation/howToFix, severity ∈ {critical,warning,info}, kind ∈ {page,query,metric}, every rule carries ≥1 checkId; (b) with a judged fixture crawl: a rule that fired carries its exact count, a rule that did not fire carries `fired: {count: 0}`, and the counts sum to `crawl_status.findingsCount`; (c) with an unjudged crawl: every `fired` is null; (d) truncation surfacing: a rule whose findings carry a truncation note reports `atLeast: true` beside the count (reuse the issues_list mechanics — do not re-derive).
- [ ] **Step 2: implement.** One registry walk joined against a single grouped count query (`select rule_id, count(*) from issues where crawl_id group by rule_id`) — never one query per rule. Copy comes from the same source `issues_list` uses so the two surfaces cannot drift.
- [ ] **Step 3: MCP description** states the null-vs-zero distinction explicitly (an agent and a UI both read it); description pin test in the same commit.
- [ ] **Step 4: suite + tsc green; commit.**

### Task 2: the health rollup — `site.health` metric family

**Files:**
- Modify: `src/rules/metric/` (new metric, registered), `src/rules/registry/` copy if metric copy lives there
- Test: `test/rules/` metric suite

**Interfaces:**
- Produces: metric family `site.health`, site-scope rows: `{urlsTotal, urlsWithCritical, urlsWithWarningOnly, urlsWithInfoOnly, urlsClean, cleanRatio}` where the four buckets partition `urlsTotal` (each page counted once at its worst severity, over auditable pages), and `cleanRatio = urlsClean / urlsTotal` (4 decimal places, DOCUMENTED as `pages carrying no finding of any severity / auditable pages` in the metric's copy). No grade, no label, no threshold — obligation 6; Talos draws the gauge.
- Consumes: `issues` (page_id join) + `pages`; runs in the metric phase like its 12 siblings, so it recomputes with every judgement and is versioned by the same `rulesRunAt`.

**Steps:**
- [ ] **Step 1: failing tests**: (a) a fixture where one page carries a critical + a warning counts once, in the critical bucket; (b) buckets partition exactly (sum equals urlsTotal); (c) a crawl with zero findings: urlsClean == urlsTotal, ratio 1.0000; (d) findings whose `page_id` is null (site-level findings, e.g. sitemap rules) do NOT poison a page into a bucket — assert a fixture site-level finding leaves urlsClean untouched; (e) the ratio survives `findingCap`: a capped run must compute the buckets from the SAME capped findings it wrote (the metric describes the judgement that exists, not a hypothetical uncapped one — and its copy must SAY the ratio is of reported findings, so a capped run's ratio is explicitly a floor-of-knowledge, not a site truth).
- [ ] **Step 2: implement** as one grouped SQL pass (worst-severity per page via `min` over an ordered severity mapping — no per-page iteration). This is metric rule #13; the 85-rule count moves to 86 and the per-kind pin 12→13 — move both honestly, and the coverage suite's claim arithmetic with them. If the checklist has no check for a health rollup, register the metric with the nearest structural check id it genuinely serves or leave it checkId-carrying per rule 10 — the implementer verifies against `skills/ariadne-audit/checklist.md` and records which.
- [ ] **Step 3: expose**: confirm it flows through `metrics_get` unmodified (metric families are generic there); add the family to the MCP description's family list if that list is enumerated (with pin).
- [ ] **Step 4: suite + tsc green; commit** (ruleset stays 0.7.0: a NEW metric adds rows, changes no existing verdict — same argument as Phase 8's T1; the reviewer re-weighs against RULESET_VERSION's contract text and the ledger records the outcome).

### Task 3: `crawl_compare` + site-scoped history

**Files:**
- Modify: `src/api/service.ts`, `src/api/mcp.ts`, `src/api/http.ts`
- Test: both transport suites

**Interfaces:**
- Produces:
  - `crawl_list {siteUrl?}` — verify the existing tool's filter surface; add a site filter if absent (normalised-host match, the same family posture `checkAddedHosts` uses). This is the "project history" the UI's date picker needs.
  - `crawl_compare {baseCrawlId, headCrawlId}` → `{ base: {crawlId, rulesetVersion(s), rulesRunAt}, head: {…}, comparable: boolean, caveats: [...], rules: [{ruleId, severity, category, baseCount, headCount, new, resolved, persisting}] }` plus `compare_urls {baseCrawlId, headCrawlId, ruleId, set: "new"|"resolved"|"persisting", cursor?}` for the paginated URL drill-down.
- Refusals and honesty (each a test):
  - different sites → 400 naming both hosts (never a cross-tenant diff);
  - either crawl unjudged → 400 naming which (`rulesRunAt` null — there is nothing to compare);
  - **ruleset mismatch → NOT a refusal**: `comparable: false` with a caveat naming both versions and the not-row-comparable precedent — counts still returned (Talos may grey the Change column; the engine states the caveat, the consumer decides). This is live in the dev data TODAY: `crawl_2af4daf1` (0.6.0 findings) vs `crawl_02ff6f7a` (0.7.0) is the gate demo.
- Identity: a finding exists in a crawl for compare purposes as `(rule_id, url)` via the finding's page URL (`dedupe_key` is crawl-scoped and may embed non-URL discriminators — the implementer verifies `dedupe_key`'s actual shapes and DOCUMENTS why URL-identity is the honest cross-crawl join, including what it means for multi-finding-per-page rules: they collapse to per-URL presence for the diff, stated in the tool description). Site-level findings (null page) compare by rule presence with `url: null`.
- All set arithmetic in SQL (`except`/`intersect` over indexed selects) — rule 3; `new`/`resolved`/`persisting` counts on the summary, URLs only through the paginated drill-down (obligation 1).

**Steps:**
- [ ] **Step 1: failing tests** covering the three refusal/caveat behaviours, a fixture pair with known added/resolved/persisting sets (build two small judged crawls of the same fixture site with a deliberate difference), pagination of `compare_urls` to a null cursor, and the cross-severity case (a rule whose severity changed between rulesets reports the HEAD severity with a caveat line).
- [ ] **Step 2: implement**; `EXPLAIN` the set queries against the two real 551-page crawls and record cost in the report (17k-finding side must not regress the API worker; if a supporting index is genuinely needed, that is this phase's ONE migration and the plan's no-migration default is overridden with the measurement in the ledger — decision recorded, not assumed).
- [ ] **Step 3: MCP descriptions + pins; suite + tsc green; commit.**

### Task 4: CSV streaming exports

**Files:**
- Modify: `src/api/service.ts` (export views), `src/api/http.ts` (streaming responses), `src/api/mcp.ts` (file-writing variant via the existing `export_crawl` pattern)
- Test: both transport suites

**Interfaces:**
- Produces: `export_crawl` gains `format: "csv"` and a `view` parameter: `issues` (ruleId, severity, category, checkIds, url, title, one evidence-summary column — flattened deterministically, never raw JSON blobs in cells), `issue_urls {ruleId}`, `internal_urls` (url, status, fetchClass, indexable, clickDepth, pageType, title), `links_to_4xx` (source, target, status, anchorText), `anchor_texts` (source, target, text), `redirects` (source, chain, target, hops). HTTP: `Content-Type: text/csv`, streamed row-by-row from a keyset cursor — memory O(1) in rows (rule 3 for links-derived views). MCP: writes the file under the export dir (the existing `export_crawl` contract) and returns path + row count.
- CSV discipline: RFC-4180 quoting, header row always, UTF-8, injection-safe (cells starting with `= + - @` prefixed with `'` — these files open in Excel at a client's desk; a crawled page's title is attacker-controlled text). This is a test, not a hope.

**Steps:**
- [ ] **Step 1: failing tests**: (a) each view's header + a known row against a fixture crawl; (b) the injection case (a fixture page whose title starts with `=SUM(`); (c) quoting (title containing comma, quote, newline); (d) the links-derived views stream — pin memory behaviour structurally (keyset cursor present, no `.rows` full materialisation on the hot path) and run one big-view export against the real 35,145-link crawl, recording RSS in the report; (e) row counts equal the source counts (`issues` view rows == findingsCount).
- [ ] **Step 2: implement** all views through one shared CSV writer (quoting/injection logic exists once).
- [ ] **Step 3: MCP description + pins; suite + tsc green; commit.**

### Task 5: the contract document + tenant-safety sweep + gate

**Files:**
- Create: `docs/talos-surface.md` (the contract Talos codes against)
- Modify: `docs/talos-integration.md` (cross-reference), gate doc `docs/gates/phase-10.md`
- Test: none new beyond what the sweep forces

**Steps:**
- [ ] **Step 1: the contract doc** — every tool Talos will call (the 12 existing + this phase's additions), request/response shapes as they ACTUALLY are (generated claims verified against the transport tests, not hand-copied), auth, pagination conventions, the null-vs-zero and comparable-false semantics, the UA/politeness knobs a Talos-driven crawl sets (branded UA per obligation 4), and an explicit "what Ariadne will not do" list (no grades/labels, no revenue judgement, no resource fetching until Phase 11). Cross-referenced from `docs/talos-integration.md`.
- [ ] **Step 2: tenant-safety sweep** (obligation 6) over every NEW response shape: grep-audit for stack traces, absolute paths, internal hostnames in error copy and evidence; each new 4xx/5xx's body reviewed. Findings fixed in this task.
- [ ] **Step 3: the gate** (fixture + real data, no site contact):
  1. `rules_catalog` over a judged fixture crawl: 86 rules, counts sum to findingsCount, null-vs-zero demonstrated on an unjudged crawl.
  2. `site.health` on the re-judged real crawl (`crawl_02ff6f7a` at 0.7.0): buckets partition 551, ratio documented — numbers in the gate doc measured fresh.
  3. **The real compare**: `crawl_2af4daf1` (0.6.0) vs `crawl_02ff6f7a` (0.7.0) — `comparable: false` with both versions named, counts present; and `crawl_3f3ab847` vs `crawl_02ff6f7a` likewise (it is the SAME site crawled twice at different judgements — whatever it honestly shows, the gate records). The deep-page finding must appear as `new` in any 0.6.0→0.7.0 head where it fired.
  4. CSV: the six views exported from the real crawl; the 17,659-row issues view and the 35,145-row anchor view open clean (row counts equal sources; RSS recorded; injection guard demonstrated on the fixture).
  5. Full suite green, tsc clean, tree clean, dev DB crawl count unchanged (the leak fix holds).
- [ ] **Step 4: gate doc + commit; CI placeholder per the standing pattern (PR #9 after integration word).**

---

## Phase 11 preview (owner-approved, NOT this plan)

Resource fetching (images/CSS/JS): a crawler extension with its own plan once this gate is green — resources table + page↔resource edges, HEAD-first fetching under the SAME per-host politeness budget as pages (one host queue, not two), size/status/content-type recording, byte caps, dedup by URL across pages, and the Ahrefs-parity rules it unlocks (image size, broken resources, large page weight). It needs its own real-site gate; scope and politeness arguments belong in its own document.

## Explicitly out of scope (this phase)

Talos-side UI, tools, deployment topology, credential management (recorded in talos-integration.md §"What Talos must eventually do"); resource fetching (Phase 11); scheduling/cron crawls; webhooks (crawl_status polling is the contract until Talos asks otherwise); any change to skills or the agent-audit flow.

# Phase 28a — Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every crawl belongs to a tenant. Every HTTP request and every stdio MCP process names one, and a crawl outside the caller's tenant answers exactly like a crawl that does not exist. The four loop and fetch debts carried from 27d are paid.

**Architecture:** A `tenant_id` column on `crawls` (migration 0037, existing rows backfilled to `local`). A branded `TenantId` type is parsed once per HTTP request (an `X-Ariadne-Tenant` header, checked after the bearer token and before routing) or once per stdio MCP process (`ARIADNE_TENANT`). Every crawl-facing public `ApiService` method takes the tenant as its **first parameter**, so the compiler finds every call site, and resolves its crawl with `(id, tenant)` through the two existing private helpers (`assertCrawl`, `crawlRow`). A sentinel test enumerates every HTTP route and MCP tool and proves each one is scoped or explicitly global.

**Tech Stack:** TypeScript strict / Node 22 / drizzle + Postgres 16 / vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-11-phase-28-cloud-foundations-design.md` (§28a goals 1–5, "Carried from 27d", "Housekeeping", Gates 28a). Owner approved 2026-11-11 ("Looks good, go ahead").

## Global Constraints

- **Tenant format:** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` (1–64 characters, opaque, case-sensitive; `acme` and `Acme` are two tenants). *Deviation 1:* the spec's `^[A-Za-z0-9._:-]{1,64}$` admits `.` and `..`, and export files go under `<exportDir>/<tenant>/`, so the first character must be alphanumeric.
- **New error codes**, added to `ServiceErrorCode` and mapped to HTTP 400 in `STATUS_FOR`:
  - `TENANT_REQUIRED`: the header is missing or empty.
  - `INVALID_TENANT`: the value fails the format.
  - The message never quotes the value sent. It states the rule (the 27d no-echo discipline).
- **Order on HTTP:** bearer check (401) → tenant check (400) → routing. An unauthenticated caller learns nothing about tenants.
- **A foreign crawl answers like a missing one:** the same status (404), the same `code` (`NOT_FOUND`) and the same message template (`no such crawl '<id>'`), built by the same code path.
- **The `local` backfill is migration SQL, not a default.**
  - `crawls.tenant_id` is `text not null` with **no** column default.
  - `runCrawl` and every insert pass a tenant explicitly.
  - `ARIADNE_TENANT` has no default: unset or invalid is a boot error.
- **Migrations** are generated with drizzle-kit (`0037_*`) and applied with `npm run db:migrate`; never hand-apply SQL.
- **The ruleset is unchanged** (`RULESET_VERSION` stays `0.25.0`; no rule is touched).
- `npx tsc --noEmit` and `npm test` are clean at every commit. `DATABASE_URL` is exported for tests.
- **Commit trailer**, on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
  ```

## Review Focus

1. **A duplicated `X-Ariadne-Tenant` header.** Node joins two headers as `a, b`, which fails the format, so the answer is 400 `INVALID_TENANT` and never the first value. Test in Task 2.
2. **A request with neither a token nor a tenant** answers 401, not 400. The tenant check never runs before auth. Test in Task 2.
3. **An export written for tenant A is reachable and deletable only through A.**
   - The file lives under `<exportDir>/A/`.
   - `crawl_delete` by A removes it.
   - Tenant B's delete of the same id is a 404 and removes nothing.
   - Test in Task 2.
4. **`crawl_compare` with one own crawl and one foreign crawl** answers the 404 for the foreign id. It must be byte-identical to the answer for a random missing id, so it does not reveal the other site's host the way today's "different sites" refusal would. Test in Task 3.
5. **An invalid `ARIADNE_TENANT` at MCP boot** throws an error that states the rule without the value. A tenant with a leading `.` is refused. Test in Task 2.

---

### Task 0: Baseline

- [ ] **Step 1:** At `f6edf3a`, run `npx tsc --noEmit` and `npm test`. Record the file and test counts in the ledger. Expected: 156 files / 4,168 tests, all passing.

### Task 1: Tenant type, column and engine entry

**Files:**
- Create: `src/api/tenant.ts`
- Create: `drizzle/0037_*.sql` (drizzle-kit, then the backfill edited into the generated file, following `drizzle/0032_*`)
- Modify: `src/db/schema.ts` (`crawls`), `src/api/errors.ts`, `src/api/http.ts` (`STATUS_FOR` only), `src/crawl/loop.ts` (`runCrawl`)
- Modify: every direct `db.insert(crawls)` and every `runCrawl(` call in `src/`, `scripts/` and `test/` (74 test files and 41 `runCrawl` callers at planning time; `grep -rln "insert(crawls)"`)
- Test: `test/api/tenant.test.ts`, `test/db/migration-0037.test.ts`

**Interfaces:**
- Produces:
  - `export type TenantId = string & { readonly __tenant: unique symbol }`
  - `export const TENANT_PATTERN: RegExp`
  - `export function parseTenant(raw: string | undefined): TenantId`
    - `undefined` or `""` throws `ServiceError("TENANT_REQUIRED", …)`.
    - A value that fails the pattern throws `ServiceError("INVALID_TENANT", …)`.
    - It does **not** trim, because a value with whitespace fails the pattern.
  - `export const LOCAL_TENANT: TenantId` (`"local"`, the backfill value, used by scripts and tests).
  - `crawls.tenantId` (`tenant_id text not null`).
  - Index `crawls_tenant_started` on `(tenant_id, started_at desc, id desc)` (the order `listCrawls` pages by).
  - `runCrawl(db, tenant: TenantId, config, signal?, testHooks?)`: the tenant is the new second parameter.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests.**
  - `test/api/tenant.test.ts`:
    - `parseTenant` accepts `"local"`, `"42"`, `"org:7.a-b_c"` and a 64-character value.
    - It rejects each of the following, and every message excludes the value sent:
      - `undefined` and `""` (`TENANT_REQUIRED`);
      - `" acme"`, `"."`, `".."`, `"-x"`, `"a/b"`, `"a, b"`, a 65-character value, `"é"` (`INVALID_TENANT`).
    - `parseTenant("Acme") !== parseTenant("acme")`.
  - `test/db/migration-0037.test.ts`, written the way `test/db/migration-0032.test.ts` is:
    - Apply up to 0036 and insert two crawls without a tenant.
    - Apply 0037; both rows read `tenant_id = 'local'`.
    - An insert without `tenant_id` now fails with a not-null violation.
- [ ] **Step 2:** Run both files; they fail (no module, no column).
- [ ] **Step 3: Implement.**
  - Write `tenant.ts` and the error codes. `STATUS_FOR` gets `TENANT_REQUIRED: 400` and `INVALID_TENANT: 400`.
  - Add the schema column and index.
  - Generate 0037 and edit the backfill in: add the column nullable, `update crawls set tenant_id = 'local'`, then `set not null`.
  - `runCrawl` writes `tenantId: tenant`.
  - **The mechanical sweep:** every test or script insert of a `crawls` row gains `tenantId: LOCAL_TENANT`, and every `runCrawl(db, config…)` becomes `runCrawl(db, LOCAL_TENANT, config…)`. The `ApiService.startCrawl` insert gets `tenantId: LOCAL_TENANT` **as a placeholder that Task 2 replaces**, with a `// Task 2:` comment, so this commit compiles.
- [ ] **Step 4:** Run `npx tsc --noEmit`, `npm run db:migrate` on the dev DB, then `npm test`. All pass.
- [ ] **Step 5:** Commit `feat(db): tenant key on crawls, backfilled to local (28a T1)`.

### Task 2: Every service method and both transports scoped

**Files:**
- Modify: `src/api/service.ts`, `src/api/http.ts`, `src/api/mcp.ts`, `src/api/config.ts` (`loadMcpConfig`), `src/api/mcp-serve.ts`, `src/api/crawl-delete.ts`, `scripts/prune-test-crawls.ts`
- Modify: every test that calls `ApiService` methods directly (`grep -rn "new ApiService" test`), every HTTP test helper that sets `authorization` (17 files under `test/api`, `test/crawl`, `test/fixtures`; `grep -rln "Bearer" test`), and every `createMcpServer({… config})` in tests (gains `tenant`)
- Test: `test/api/tenancy.test.ts`

**Interfaces:**
- Consumes: `TenantId`, `parseTenant`, `LOCAL_TENANT` (Task 1).
- Produces:
  - **Every crawl-facing public method of `ApiService` takes `tenant: TenantId` first**: `startCrawl`, `listCrawls`, `getCrawl`, `getRobots`, `markCrawlFailed`, `pauseCrawl`, `cancelCrawl`, `deleteCrawl`, `resumeCrawl`, `renderCrawl`, `runRulesForCrawl`, `getCrawlConfig`, `setCrawlConfig`, `rulesCatalog`, `listIssues`, `issuesOverview`, `crawlOverview`, `listIssueUrls`, `listIssueInlinks`, `compareCrawls`, `listCompareUrls`, `listMetrics`, `metricTable`, `listPages`, `exportCrawl` and `prepareCsvExport`.
  - The global methods stay tenant-free: `configSchema`, `validateConfig`, `checkStartBody`, `close`.
  - `private assertCrawl(tenant: TenantId, crawlId: string)` and `private crawlRow(tenant: TenantId, crawlId: string)` match on `id` **and** `tenant_id`, and throw the existing `NOT_FOUND` either way.
  - `RequestCtx` gains `tenant: TenantId`.
  - `ApiServerConfig` is unchanged. `McpServerConfig` and `LoadedMcpConfig` gain `tenant: TenantId`.
  - Export files go to `<exportDir>/<tenant>/<filename>`, keeping the containment check against `<exportDir>/<tenant>`.
  - `deleteCrawlFiles(crawlId, slug, renderDir, exportDir, tenant)` looks for exports under the tenant directory.

- [ ] **Step 1: Write the failing tests** in `test/api/tenancy.test.ts`, over HTTP:
  - With a valid token and no header: 400 `{code:"TENANT_REQUIRED"}`.
  - With a header of `" "` (a single space): 400 `TENANT_REQUIRED`. Node trims OWS, so the value is empty.
  - With the header twice (`acme` and `beta`): 400 `INVALID_TENANT`, and the body contains neither `acme` nor `beta`.
  - With no token and no header: 401.
  - `POST /crawls` as `acme`, then `GET /crawls` as `beta`: its id is absent. As `acme`: present.
  - `GET /crawls/:id` as `beta` deep-equals `GET /crawls/crawl_<random uuid>` as `beta`, with the id substituted.
  - An `export_crawl` file for `acme` lands under `<exportDir>/acme/`.
  - `DELETE /crawls/:id?confirm=` as `beta` gives 404, and the file still exists. As `acme` the file is removed.
  - Over MCP: `loadMcpConfig({DATABASE_URL, ARIADNE_TENANT: ".x"})` throws, and the message excludes `.x`. With `ARIADNE_TENANT` unset it throws naming `ARIADNE_TENANT`.
  - `crawl_list` from a server built with tenant `acme` lists only `acme`'s crawls.
  - The startCrawl row's `tenant_id` equals the caller's tenant (read from the DB).
- [ ] **Step 2:** Run it; it fails.
- [ ] **Step 3: Implement.**
  - The tenant parameter on each method listed above. The method's first database read goes through `assertCrawl` or `crawlRow` with the tenant.
  - `startCrawl` stores the caller's tenant, replacing the Task 1 placeholder.
  - `listCrawls` filters `tenant_id`.
  - `compareCrawls` and `listCompareUrls` resolve **both** ids with the tenant **before** any cross-crawl check, so a foreign id never reaches the "different sites" refusal.
  - `rulesCatalog(tenant, {crawlId})` scopes only when `crawlId` is given.
  - `http.ts handle()`: `parseTenant(req.headers["x-ariadne-tenant"])` right after `checkBearer`. A `ServiceError` there is sent as `{error, code}` with its status, and the body is drained the way the 401 drains it.
  - `loadMcpConfig` requires `ARIADNE_TENANT` through `parseTenant`, rethrown as a plain boot `Error` naming the variable and the rule.
  - `createMcpServer` passes `config.tenant` to every call.
  - The prune script reads each crawl's `tenant_id` and acts with it.
  - The mechanical test sweep:
    - HTTP helpers send `x-ariadne-tenant: local`.
    - Direct service calls pass `LOCAL_TENANT`.
    - MCP test configs carry `tenant: LOCAL_TENANT`.
- [ ] **Step 4:** `npx tsc --noEmit` and `npm test` both pass.
- [ ] **Step 5:** Commit `feat(api): every route and tool scoped by tenant (28a T2)`.

### Task 3: Sentinel — no route or tool left unscoped

**Files:**
- Modify: `src/api/http.ts`. Export `routeSignatures(): ReadonlyArray<{ method: string; path: string }>` from `buildRoutes()`, with params rendered as `:id` and `:ruleId` and so on.
- Test: `test/api/tenant-isolation.test.ts`

**Interfaces:**
- Consumes: Task 2's scoped service; `TOOL_NAMES` (`src/api/mcp.ts`); `routeSignatures()`.
- Produces: the constants `GLOBAL_ROUTES`, `GLOBAL_TOOLS` and `SCOPED_CASES`, inside the test file only.

- [ ] **Step 1: Write the test.**
  - **Fixtures:** tenant `acme` owns a finished, judged crawl with findings, metrics and pages. Insert it through the existing fixture-crawl helpers the API tests use, then run `runRulesForCrawl(acme, id)`. Use a second `acme` crawl of the same site for compare.
  - `SCOPED_CASES` maps every `METHOD /path` and every tool name to a request builder `(crawlId, otherCrawlId?) => request`.
  - **Assertion 1, coverage:** the union of `SCOPED_CASES`, `GLOBAL_ROUTES` and `GLOBAL_TOOLS` keys equals every `routeSignatures()` entry plus every `TOOL_NAMES` entry. A missing name fails with that name.
  - **Assertion 2, global entries.** These are the only globals:
    - `GLOBAL_ROUTES`: `GET /config/schema`, `POST /config/validate`, `POST /crawls` (creates for the caller), `GET /crawls` (listing, asserted separately), `GET /rules` (without `crawlId`).
    - `GLOBAL_TOOLS`: `config_schema`, `config_validate`, `crawl_start`, `crawl_list`.
    - `rules_catalog` is scoped through its `crawlId` case.
  - **Assertion 3, foreign equals missing:** each scoped case, as `beta` on `acme`'s crawl, gives a status and body equal to the same case as `beta` on `crawl_<random uuid>`, with the id substituted. Over HTTP the status is 404. Over MCP it is the tool error `{code:"NOT_FOUND"}`.
  - **Compare cases** run three ways:
    - (`acme` own, `acme` other) as `beta`;
    - (`beta` own, `acme`'s) as `beta`;
    - (`acme`'s, `beta` own) as `beta`.
    - Each answers the foreign-id 404, and the body never contains `acme`'s site host.
  - **Assertion 4, nothing changed:** after every refused case, `acme`'s crawl row and its counts (`pages`, `issues`, `findingsCount`, `status`, `control_request`) are unchanged, so a refused command wrote nothing.
- [ ] **Step 2:** Run it. Expected: PASS if Task 2 is complete. To prove the sentinel bites, temporarily delete the tenant filter from `crawlRow`, confirm the failure names a route, then restore it. Record this in the report rather than committing it.
- [ ] **Step 3:** Commit `test(api): tenant sentinel over every route and tool (28a T3)`.

### Task 4: Re-walk staging cleared only when a walk replaces it (27d R17 carries)

**Files:**
- Modify: `src/crawl/loop.ts`: the block before `discover(...)` around `markEvidenceInterrupted` and the `sitemapHreflang` delete (~1735–1757), `SitemapRowSink` (~3472–3540), and the robots-unreachable branch (~1810–1830).
- Test: `test/crawl/loop-resume-staging.test.ts`

**Interfaces:**
- Produces:
  - `SitemapRowSink.prepare(): Promise<void>` is idempotent. **On its first call** it writes the interrupted mark (`markEvidenceInterrupted`), then deletes the crawl's `sitemap_hreflang` **and `sitemap_memberships`** rows.
  - The sink calls it before its first insert.
  - `execute` calls it after `discover` returns, **unless** `discovery.robots.outcome === "unreachable"`. That covers a completed walk that flushed nothing.
- Consumes: the existing `markEvidenceInterrupted` (fixed in Task 5) and `discoveryEvidence`.

- [ ] **Step 1: Write failing tests** against the fixture site with a mutable sitemap.
  - (a) **A changed site:**
    - A crawl is paused after its walk while the sitemap lists `/a`, `/b`.
    - The fixture then lists only `/a`, and the crawl is resumed.
    - After the resumed walk, `sitemap_memberships` for the crawl holds `/a` only. Today it holds `/a` and `/b`.
  - (b) **robots unreachable on a resume:**
    - A finished-walk crawl has hreflang staging and evidence E.
    - It is resumed while the fixture's `robots.txt` answers 503 throughout.
    - Afterwards `sitemap_hreflang` and `sitemap_memberships` row counts equal those before the resume.
    - `discovery` keeps E's `sitemaps` and `truncation` keys unchanged (no `interrupted` mark), and its `robots` key is the new unreachable outcome. The crawl closes `failed` with the robots note as today.
  - (c) **A stop during the walk** still leaves `truncation.interrupted: true` (the existing R8/R10 tests in `test/crawl/loop-stop-early.test.ts` stay unchanged and passing).
- [ ] **Step 2:** Run (a) and (b); they fail.
- [ ] **Step 3: Implement** `prepare()` and move the pre-walk mark and delete into it.
  - On the robots-unreachable path of a crawl that already has evidence, write `discovery = discovery || jsonb_build_object('robots', <new robots evidence>)`, a merge that keeps the walk's keys.
  - A crawl with no prior evidence writes the whole evidence as today.
- [ ] **Step 4:** Run the new file and `test/crawl/loop-stop-early.test.ts`; both pass.
- [ ] **Step 5:** Commit `fix(loop): a re-walk clears memberships and staging only when it replaces them (28a T4)`.

### Task 5: Two small 27d minors

**Files:**
- Modify: `src/crawl/fetch-page.ts` (catch at ~723–729) and `src/crawl/loop.ts` (`markEvidenceInterrupted`, ~3061)
- Test: append to `test/crawl/fetch-page.test.ts` and to `test/crawl/loop-resume-staging.test.ts`

- [ ] **Step 1: Write failing tests.**
  - A `fetchPage` whose injected fetch throws a `TypeError` (a programmer error, as `isProgrammerError` defines it) *after* the caller's signal has aborted rejects with that `TypeError`, not `FetchAbortedError`. This mirrors 27d F3's resources test.
  - `markEvidenceInterrupted` on a row whose `discovery` has no `truncation` key (insert one by hand) leaves `discovery->'truncation'->>'interrupted' = 'true'`.
- [ ] **Step 2:** Run them; both fail.
- [ ] **Step 3: Implement.**
  - Move `if (isProgrammerError(error)) throw error;` above the abort check.
  - Make the update `jsonb_set(discovery, '{truncation}', coalesce(discovery->'truncation', '{}'::jsonb) || '{"interrupted": true}'::jsonb)`.
- [ ] **Step 4:** Run both files; they pass.
- [ ] **Step 5:** Commit `fix(crawl): programmer errors beat aborts in fetchPage; interrupted mark on legacy evidence (28a T5)`.

### Task 6: Docs, skills, gate

**Files:**
- Modify:
  - `docs/talos-surface.md`: §1 auth, every request example, the §9 postures, and the §10/§13 "No tenancy isolation" lines.
  - `docs/talos-integration.md`: new obligation 9 (tenancy), the cross-reference paragraph, and the Talos path.
  - `CLAUDE.md`: the Talos path.
  - `skills/ariadne-crawl/SKILL.md` and `skills/ariadne-audit/SKILL.md`: MCP setup gains `ARIADNE_TENANT`.
  - `README.md`, if it lists env vars.
- Create: `docs/gates/phase-28a.md`.

- [ ] **Step 1: talos-surface.**
  - Every HTTP example gains `-H 'X-Ariadne-Tenant: <tenant>'`.
  - Document the two codes, the auth-then-tenant order and the foreign-equals-missing rule.
  - Postures 4 and 5 become "met in Phase 28a" with the sentinel test's path.
  - Add a dated "Phase 28a" summary: Talos must send the header before upgrading.
  - Don't renumber existing citations.
- [ ] **Step 2: talos-integration.**
  - Obligation 9: Talos passes its tenant (its user id as a string) on every call, and Ariadne answers a foreign crawl as missing.
  - Fix `/home/eugen-dev/Workflows/talos` to `/home/eugen-dev/Documents/Workflows/talos` there and in `CLAUDE.md`.
- [ ] **Step 3: Gate doc `docs/gates/phase-28a.md`**, with clauses 1–4 of the spec's Gate 28a and evidence for each:
  1. The sentinel test's path and case count.
  2. The dev DB after `npm run db:migrate`: the crawl count before and after, all `tenant_id = 'local'`, and `crawl_list` over stdio MCP with `ARIADNE_TENANT=local` lists them.
  3. The Task 4/5 tests' failing-first runs.
  4. Suite and tsc counts.

  Also record Deviation 1 (the tenant pattern's first character) and any rulings from the ledger.
- [ ] **Step 4:** Run `npx tsc --noEmit` and `npm test`; both pass.
- [ ] **Step 5:** Commit `docs: Phase 28a tenancy in the surface, the integration seam and the gate (28a T6)`.

## Deviations from the spec (owner to check)

1. **Tenant pattern.** It is `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, so `.` and `..` can never name an export directory.
2. **`runCrawl` takes the tenant explicitly** (second parameter), and tests and scripts use `LOCAL_TENANT`. The spec names no engine-level entry. A column default would contradict "the backfill is a migration, not a default".
3. **"Same timing class" is not measured.** Foreign and missing go through one query with one predicate, which is the guarantee. A timing test would be flaky by nature.
4. **Render files stay at `<renderDir>/<crawlId>/`.** The spec moves only exports under the tenant. Render documents are an operator artifact that 28b drops from workers.

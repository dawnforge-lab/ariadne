# Phase 28a gate: tenancy

Date: 2026-11-11. Spec: `docs/superpowers/specs/2026-11-11-phase-28-cloud-foundations-design.md`
("Gate 28a"). Plan: `docs/superpowers/plans/2026-11-11-phase-28a-tenancy.md`. Branch
`worktree-phase-28`, built on `767c6c5` (main plus the design and plan docs). Code under test:
`99aaaf7` (Task 5's last commit); this gate adds only docs, skills and this file.

**Verdict: all four clauses pass on the code.** The PR's first CI run is the one thing this
file cannot show.

## 1. The sentinel test covers every route and tool

`test/api/tenant-isolation.test.ts` enumerates `routeSignatures()` (`src/api/http.ts`) and
`TOOL_NAMES` (`src/api/mcp.ts`). Each must be in the scoped cases, which the test proves by
asking with tenant B for tenant A's crawl and requiring the answer to equal a missing crawl's
(404 `NOT_FOUND`, `no such crawl '<id>'`), or on an explicit global list; a route or tool in
neither fails the coverage check. **113 cases, all passing.** The cases also cover refused
commands changing nothing, a foreign crawl that is busy (rendering, judging, config-busy)
answering as missing, and `crawl_compare` / `compare_urls` never naming the other site's host.
`crawl_list` returning only the caller's crawls is in `test/api/tenancy.test.ts`, which also
pins the header order (bearer 401, then 400 `TENANT_REQUIRED` / `INVALID_TENANT`, then
routing) and the stdio boot refusal without `ARIADNE_TENANT`.
Mutation check (Task 3): breaking `crawlRow`'s tenant predicate failed 12 cases.

## 2. The backfill leaves existing dev crawls readable as `local`

Migration `0037_crawls_tenant_id.sql` adds the column nullable, sets every existing row to
`local`, then sets it `not null` (no default) and creates
`crawls_tenant_started (tenant_id, started_at desc, id desc)`. It was applied to the dev
database in Task 1 with `npm run db:migrate`.

```
$ docker exec ariadne-pg psql -U ariadne -d ariadne -Atc "select count(*), count(*) filter (where tenant_id='local'), count(distinct tenant_id) from crawls"
9|9|1
```

Before = 9 (8 left by the Phase 27d prune plus the 27d Hurtigruten gate crawl
`crawl_d5207a58-e431-44b7-8f56-9b095e8a1c8b`, 2026-11-10); after = 9, all nine
`tenant_id = 'local'`, one distinct tenant. The migration only adds a column and updates it,
so the crawl count is unchanged by it (the table is never deleted from). `crawl_list` over a
real stdio MCP server (`src/api/mcp-serve.ts` as a child process, driven by the SDK's stdio
client, run from a scratch script that is not committed), `DATABASE_URL` on the dev database:

```
ARIADNE_TENANT=local  -> crawl_list isError=false, 9 crawls listed
ARIADNE_TENANT=other  -> crawl_list isError=false, 0 crawls listed
```

No dev data was modified. The committed, reproducible proofs: the stdio spawn of
`mcp-serve.ts` with `ARIADNE_TENANT` set is `test/api/mcp.test.ts:2916`, and that
`crawl_list` lists only the server's tenant's crawls is the test in `test/api/tenancy.test.ts`
named "crawl_list lists only the server's tenant's crawls".

## 3. The carried loop fixes have failing-first tests

Both are 27d carries, paid in this phase.

- **T4, `SitemapRowSink.prepare()`** (`test/crawl/loop-resume-staging.test.ts`): a re-walk on
  resume clears memberships and hreflang staging only when a walk replaces them, and a
  robots-unreachable resume keeps staging and replaces only `robots` and `sitemapSources` in
  the evidence (ruling R5). Failing first, before the `loop.ts` change:
  `(a) expected [ '/a', '/b' ] to deeply equal [ '/a' ]`,
  `(b) expected { memberships: 2, hreflang: 0 } to deeply equal { memberships: 2, hreflang: 2 }`,
  `(d) expected { memberships: 2, hreflang: 0 } to deeply equal { memberships: 0, hreflang: 0 }`,
  3 failed. Removing `sitemapSources` from the merge failed the R5 test
  (`expected [ Array(1) ] to deeply equal []`).
- **T5, programmer error beats abort and the interrupted mark lands on legacy evidence**
  (`test/crawl/fetch-page.test.ts`, `test/crawl/loop-resume-staging.test.ts`): failing first,
  `expected FetchAbortedError ... to not be an instance of FetchAbortedError`, and on legacy
  discovery with no `truncation`, `Cannot read properties of undefined (reading
  'interrupted')`. Now `markEvidenceInterrupted` creates the parent path.

## 4. Suite and tsc

- `npx tsc --noEmit`: clean.
- `npm test`: 161 files, 4,340 tests, all passing (460 s); 28a added 5 files and 172 tests over the baseline.
- Baseline before 28a: 156 files, 4,168 tests (ruling R2).

## Deviations from the spec (owner to check)

1. **Tenant pattern.** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, not the spec's
   `^[A-Za-z0-9._:-]{1,64}$`: the first character is alphanumeric so `.` and `..` can never
   name an export directory.
2. **`runCrawl` takes the tenant explicitly** (second parameter); tests and scripts use
   `LOCAL_TENANT`. The spec names no engine-level entry, and a column default would contradict
   "the backfill is a migration, not a default".
3. **"Same timing class" is not measured.** Foreign and missing go through one query with one
   predicate, which is the guarantee; a timing test would be flaky.
4. **Render files stay at `<renderDir>/<crawlId>/`.** The spec moves only exports under the
   tenant; render documents are an operator artifact that 28b drops from workers.
5. **Exports are flat files, not a per-crawl directory.** They are
   `<exportDir>/<tenant>/<slug>-<dataset>…`, not the spec's `<exportDir>/<tenant>/<crawlId>/`.
   The isolation is the same (a direct-child containment check under the tenant directory),
   and `crawl_delete` finds a crawl's exports by its slug.

## Rulings

- **R1:** `GET /rules` and `rules_catalog` sit in the scoped cases (exercised with
  `crawlId`), not the global lists; without a `crawlId` their answer is global by design.
- **R2:** the Task 0 baseline is taken from the `0cf1c91` runs (156 / 4,168, tsc clean, CI
  green); `0cf1c91..767c6c5` is docs only.
- **R3:** `prepare()` runs on every flush (including an empty first flush) and on a
  robots-unreachable resume with no prior evidence; both keep the write-ahead invariant.
- **R5:** on the robots-unreachable merge the robots-derived keys come from this read:
  `robots` and `sitemapSources` (emptied) are replaced and every other walk key stays.

## Operator action: move pre-28a exports

Exports now go under `<exportDir>/<tenant>/`. A file written before 28a sits at
`<exportDir>/<file>` and `crawl_delete` no longer finds it. Once, per deployment:

```
mkdir -p <exportDir>/local && mv <exportDir>/<crawl files> <exportDir>/local/
```

`exportDir` is `ARIADNE_EXPORT_DIR`, default `exports/`.

## Open items

- **R4:** a re-walk never clears `sitemap_urls`, so a URL dropped from a changed site stays a
  sitemap entry and sitemap rules on a resumed crawl of that site can count it. Carried to
  the 28b plan.
- **`sitemap.invalid` with an unreachable robots.txt** (`src/rules/query/sitemap.ts`, the
  `unreachable` branch, ~229-233) returns `[]` because "those documents were never opened".
  Since ruling R5 a resumed crawl's merged evidence can keep an earlier walk's real
  `truncation.failures` beside an `unreachable` outcome. The output is unchanged from pre-28a,
  but the rule should refuse explicitly or judge the kept failures. Carried to 28b.
- **The HTTP tenant check runs before routing for every request.** 28b's `/healthz`,
  `/readyz` and `/metrics` therefore need an explicit pre-tenant exemption, and that exemption
  must be the sentinel test's global list, not an ad-hoc bypass. Carried to 28b.
- **Talos must send `X-Ariadne-Tenant` before it upgrades to 28a**
  (`docs/talos-integration.md` obligation 9).
- The PR's first CI run is green: not yet shown.

# Phase 27c: Crawl scope and requests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent point a crawl at a list of URLs, fence a crawl off from parts of a site with URL patterns, crawl a site behind Basic auth, cookies or headers without the secrets ever being stored, and cap redirect chains and URL length. Close the six items 27b parked.

**Architecture:**
- **Admission is the one gate for what a crawl may fetch.** `enqueue` in `src/crawl/loop.ts` already runs url-policy and then robots for every seed, link, sitemap and redirect target. 27c inserts the scope check (`src/crawl/url-scope.ts`, a linear-time anchored `*` matcher with an SQL `LIKE` twin) between the two. A refused URL becomes a `pages` row of the new fetch class `excluded`, under the robots-blocked budget, the way `disallowed` rows are written today.
- **A list crawl is a spider crawl with a different seed and no link following.** The list lives in a new `list_urls` table, written when the crawl is accepted and read in chunks by the loop. It is not in `config_jsonb`, which every get, resume and render reads back. The rules runner skips rules flagged `needsSpider` (and `needsSitemaps` when no sitemap was read) on a list crawl, and one marker, `crawl.list-mode`, names them.
- **Secrets live in one process map and nowhere else.** The API holds `CrawlCredentials` per crawl in memory, hands them to the loop and the render pass as a non-stored config field (the `allowPrivate` precedent), and stores only their shape (which fields, which names). One function, `credentialHeadersFor(url, …)`, decides per request whether they go out: only to the crawl's own site family.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16, drizzle-orm + drizzle-kit, zod 4, undici, Playwright (CDP `Fetch` domain), vitest, MCP SDK 1.30.

**Spec:** `docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md`: the sections "27c — Crawl scope and requests" and "Gate 27c", plus "Surface", "Non-goals" and "Calls I made" 10–13 and 18 (owner-approved 2026-11-08). Read them before any task. 27b shipped in PR #26 (`c8315e5`); its gate doc is `docs/gates/phase-27b.md`.

## Global Constraints

- **Rules:** CLAUDE.md hard rules 1–10, and the user rule "Do not create fallbacks, we want transparent errors that can be fixed not hiding them".
  - **Rule 1:** on a list crawl, a rule that needs the whole site does not run, and the marker says so. Its silence never reads "clean".
  - **Rule 5:** url-policy runs on every listed URL, every pattern-admitted URL and every redirect target, before the scope check.
  - **Rule 6:** no structure grows with the number of URLs. The list is read in chunks; the re-filter on resume is one SQL statement; the excluded budget is a counter.
  - **Rule 7:** a refused URL is a row or a count, never a silence. A crawl that needs credentials and has none is refused, never run unauthenticated.
  - **Rule 9:** credentials, headers and cookies cannot change the user agent, the delay floor or robots. Robots is read and obeyed on a list crawl.
- **Baseline:** `main` @ `c8315e5` (PR #26 merge); branch `worktree-phase-27c` from it. Ruleset 0.23.0, 188 rules (72 page / 102 query / 14 metric); migrations 0000–0035; **142 files / 3,874 tests green** (`DATABASE_URL` set); 27 MCP tools, 9 of them command tools.
- **Ruleset 0.24.0**, one new rule (`crawl.list-mode`, a marker): 189 rules (72 / 103 / 14). `EXTRACTION_VERSION` unchanged.
- **Migration `0036`** (schema, `npm run db:generate`), applied with `npm run db:migrate`. Never hand-apply SQL. No data migration.
- **Exact values:**
  - `LIST_MAX_URLS = 10_000`; `LARGE_BODY_BYTES = 1024 * 1024` for `POST /crawls` and `POST /config/validate` only; every other route keeps `MAX_BODY_BYTES` (64 KiB).
  - `MAX_SCOPE_PATTERNS = 100`; `MAX_PATTERN_LENGTH = 512`.
  - `MAX_REQUEST_HEADERS = 20`; `MAX_CREDENTIAL_VALUE_BYTES = 1024` (header values, cookie values, username, password); `MAX_COOKIES = 50`.
  - Refused header names (case-insensitive): `host`, `user-agent`, `accept`, `accept-encoding`, `content-length`, `connection`, `transfer-encoding`, `te`, `upgrade`, `cookie`, `authorization`, and any name starting `proxy-`.
  - `maxRedirectHops`: default 10, integer 1–20. `maxUrlLength`: default 2,500 (`INDEXED_URL_MAX`), integer 256–2,500.
- **Vocabulary:**
  - `CrawlMode = "spider" | "list"`;
  - fetch class `excluded` (appended to `FETCH_CLASSES`); discovery kind `list` (appended to `DISCOVERED_VIA`);
  - `IndexabilityStatus` gains `"Excluded by crawl settings"`;
  - `ServiceErrorCode` gains `"CREDENTIALS_REQUIRED"` (HTTP 409).
- **Mutability:** `mode`, `urls`, `maxUrlLength` are `never`; `exclude`, `include`, `maxRedirectHops`, `requestHeaders`, `httpAuth`, `cookies` are `whenPaused`. The three credential fields carry `x-ariadne-secret: true` in the published schema.
- **Docs cite tests** by title fragment (`test/skills/identifier-guard.test.ts` enforces it). Append new tests at the END of existing test files, and run `npx vitest run test/skills` after any doc edit.
- **Commits:** conventional, at least one per task. Each ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
  ```

## Deviations from the spec text (owner to see in review)

1. **Migration `0036`, not `0033`.** The spec predates 27a's and 27b's migrations.
2. **The list is stored in a `list_urls` table, not in `config_jsonb`.** 10,000 URLs is up to ~1 MiB, and `config_jsonb` is read on every `crawl_config_get`, resume and render. `crawl_config_get` and `config_validate`'s `effective` show `listUrlCount`, not the URLs. `crawl_delete` removes the table's rows with the rest.
3. **Duplicates in a list are collapsed after normalisation, and counted.** The accepted response and `effective` carry `listUrlCount` (distinct) and `listDuplicates` (collapsed). Refusing a list for a repeated URL would fail spreadsheets an agent was handed; collapsing silently would hide it.
4. **A list crawl's `maxPages` defaults to twice the list** (room for one redirect target per listed URL), replacing only the API's 500 default; a request or operator value still wins. An explicit `maxPages` below the distinct list size is refused (`VALIDATION`), because a listed URL that is never fetched would break "every listed URL ends in a classified row".
5. **A listed URL that `exclude`/`include` refuses is a `VALIDATION` error at start**, like an excluded seed. Listing and excluding the same URL is a contradiction to fix, not a row to write.
6. **A second registry flag, `needsSitemaps`.** The spec says a list crawl reads no sitemap unless `sitemapUrls` is given. Without a sitemap read, `sitemap.invalid`, `robots.blocks-sitemap-urls` and their siblings would be silent about sitemaps the site declares, which reads "clean" (rule 1). Rules flagged `needsSitemaps` skip on a list crawl that read no sitemap, and `crawl.list-mode` names them too. With `sitemapUrls` given, discovery walks the declared and the supplied sitemaps exactly as a spider crawl does, and only the entries' enqueue is skipped.
7. **On a list crawl, `links.broken-internal` also reports a listed 4xx URL with no inlinks** (`inlinks: 0`, new optional column `listed`). Today the rule reports the link, and 4xx has no page rule, so a listed 404 would otherwise be reported by nothing. 5xx already has `http.server-error`.
8. **Excluded sitemap entries are not written as rows** (the robots-blocked precedent: they are already in `sitemap_urls`, and writing them would spend the budget before the first link). Rules that report a sitemap, pagination or hreflang URL as "not crawled" leave out URLs the crawl's CURRENT scope refuses, read through the SQL form of the patterns (`scopeRefusesSql`). The reason: the agent fenced them off, so "not crawled" is our decision, not the site's defect.
9. **Credentials stay in the API process's map until the crawl is deleted or cancelled**, not until it finishes: `crawl_render` on a finished crawl needs them. After a restart the map is empty and `CREDENTIALS_REQUIRED` applies.
10. **Every `ServiceError` body gains `code`** (`{error, code}` over HTTP, the same two keys in MCP's JSON error). Additive. It is how an agent tells `CREDENTIALS_REQUIRED` from any other 409 without parsing a sentence.
11. **`maxUrlLength` is `never`.** Changing it mid-crawl would need the same re-filter the scope lists get, for a field nobody changes after start.
12. **The redirect cap is per chain, counted on the frontier row** (`frontier.redirect_hops`). A redirect target inherits its source's count plus one. The redirect row whose target would exceed the cap carries the reason, and the target is not queued. A target already in the frontier keeps its own count.

## Review Focus

1. **A crawl resumed after a restart, without credentials, must never write a 401 row.** `crawl_resume` refuses with `CREDENTIALS_REQUIRED`, and the loop itself refuses a stored credential shape with no values. Tests in Tasks 5 and 9.
2. **A redirect from the site to another host does not carry the credentials, and neither does the hop back.** Each request decides by its own URL. Test in Task 10.
3. **A scope list changed while paused** re-files unfetched frontier rows as `excluded` before the first lease, and a URL fetched before the change keeps its row. Test in Task 4.
4. **A listed URL that robots.txt disallows** ends as a `disallowed` row, not a fetch and not a gap. Test in Task 6.
5. **The secret values appear in no column of any crawl-scoped table, no log line and no response**, including `config_validate`'s `effective`, a refusal message about a bad header value, and `crawl_config_get`. Tests in Tasks 8 and 10.

---

### Task 0 (controller, no code): baseline

- [ ] On `worktree-phase-27c` @ `c8315e5`, run `npm ci` then `npm test`. Expected: 142 files / 3,874 tests, 0 skipped. If the renderer test "never predicts a URL twice…" flakes (known, pre-existing), re-run that file once and record it in the ledger.
- [ ] Record `npx tsc --noEmit` clean.

### Task 1: Schema 0036 and the new vocabulary

**Files:**
- Modify: `src/db/schema.ts`, `src/crawl/fetch-page.ts` (`FETCH_CLASSES`), `src/crawl/frontier.ts` (`DISCOVERED_VIA`, `EnqueueItem`, `LeasedUrl`, `enqueueUrls`, `leaseBatch`), `src/rules/helpers.ts`, `src/crawl/recheck/recheck-server-errors.ts`, `src/api/crawl-delete.ts`, `src/api/service.ts` (`CrawlDetail`)
- Create: `drizzle/0036_*.sql` (generated)
- Test: `test/db/schema-0036.test.ts` (new), `test/rules/helpers.test.ts`, `test/crawl/frontier.test.ts`, `test/api/crawl-delete.test.ts`, `test/api/http.test.ts`

**Interfaces:**
- Produces:
  - `frontier.redirectHops: integer("redirect_hops").notNull().default(0)`.
  - `crawls.excludedDropped: integer("excluded_dropped")` (nullable, `robots_blocked_dropped`'s null semantics) and `crawls.scopeChangedAt: timestamp("scope_changed_at", { withTimezone: true })` (nullable).
  - `listUrls = pgTable("list_urls", { crawlId (fk crawls, cascade), position: integer not null, url: text not null }, PK (crawl_id, position))`.
  - `"excluded"` last in `FETCH_CLASSES`; `"list"` last in `DISCOVERED_VIA`.
  - `EnqueueItem.redirectHops?: number` (absent = 0) and `LeasedUrl.redirectHops: number`.
  - In `src/rules/helpers.ts`: `IndexabilityStatus` gains `"Excluded by crawl settings"`; `indexabilityOf` and `INDEXABILITY_STATUS_SQL` map `excluded` to it; `NEVER_REQUESTED(alias): SQL` = `ROBOTS_BLOCKED(alias) or alias.fetch_class = 'excluded'`.
  - `CRAWL_CHILD_TABLES` gains `listUrls`.
  - `CrawlDetail.excludedDropped: number | null`.

- [ ] **Step 1: Write the failing tests.**
  - `schema-0036.test.ts`: the three crawl/frontier columns exist with the stated nullability and default; `list_urls` has PK `(crawl_id, position)` and cascades on crawl delete.
  - `helpers.test.ts` (append): `indexabilityOf({fetchClass: "excluded", …})` is Non-Indexable / "Excluded by crawl settings", and the SQL twin agrees on an inserted `excluded` row (extend the existing parity test's row set).
  - `frontier.test.ts` (append): an item enqueued with `redirectHops: 3` is leased with `redirectHops: 3`; one enqueued without it is leased with 0.
  - `crawl-delete.test.ts`: the `information_schema` pin passes with `list_urls` listed, and a delete removes a crawl's `list_urls` rows and not a sibling's.
  - `http.test.ts` (append): `GET /crawls/:id` carries `excludedDropped`.
- [ ] **Step 2: Run them.** `npx vitest run test/db/schema-0036.test.ts test/rules/helpers.test.ts test/crawl/frontier.test.ts test/api/crawl-delete.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the columns and table, `npm run db:generate`, `npm run db:migrate`. Add `excluded` to every exhaustive `fetch_class` switch the compiler or a `default: throw` reaches (`indexabilityOf`, the recheck pass's two switches: an `excluded` row is never a recheck candidate, so each switch gets an `excluded` case beside its `disallowed` one, behaving the same way). Update the `pages.fetch_class` and `discovered_via` comments in `schema.ts`.
- [ ] **Step 4: Run them**, then `npx tsc --noEmit` and `npx vitest run test/rules test/api test/db`. Tests that pin `FETCH_CLASSES`, `DISCOVERED_VIA` or `CrawlDetail` keys gain the new values; change nothing else.
- [ ] **Step 5: Commit.** `feat(db): list_urls, redirect hops, excluded fetch class and the scope columns (27c T1)`

### Task 2: The scope matcher and its SQL twin

**Files:**
- Create: `src/crawl/url-scope.ts`
- Test: `test/crawl/url-scope.test.ts`

**Interfaces:**
- Produces, in `src/crawl/url-scope.ts`:
  - `interface CrawlScope { exclude: readonly string[]; include: readonly string[] }`.
  - `matchesPattern(pattern: string, url: string): boolean`: anchored at both ends, `*` matches any run (including empty), every other character literal, case-sensitive. Linear time: the greedy two-pointer wildcard algorithm with one backtrack point, never a RegExp.
  - `scopeVerdict(url: string, scope: CrawlScope): { admitted: true } | { admitted: false; reason: string }`. Exclude first; then a non-empty `include` that nothing matches.
  - `EXCLUDED_REASON_PREFIX = "crawl scope: "`; reasons are `crawl scope: matches exclude pattern '<p>'` and `crawl scope: matches no include pattern`.
  - `patternToLike(pattern: string): string`: `%` for `*`, and `\`, `%`, `_` escaped with `\` (Postgres `LIKE … ESCAPE '\'`).
  - `scopeRefusesSql(urlExpr: SQL, scope: CrawlScope): SQL`: true where `scopeVerdict` would refuse. `false` for an empty scope.
  - `patternFamilyError(pattern: string, siteUrl: string): string | null`: a message when the pattern's literal prefix up to the first `*` names a scheme and host (it contains `://` and a following `/` or ends) that `isSameOrigin` rejects for `siteUrl`; null otherwise (a pattern starting with `*` is never refused here).

- [ ] **Step 1: Write the failing tests.**
  - `matchesPattern`: `*/blog/*` matches `https://ex.com/blog/a` and not `https://ex.com/blogs`; `https://ex.com/*` matches the root and not `https://shop.ex.com/`; `*` matches everything; a pattern with no `*` matches only itself; `a*b*c` against `aXbYc` true and `aXbY` false.
  - **Linear time:** `matchesPattern("*a*a*a*a*a*a*a*a*b", "a".repeat(5000))` returns false in under 50 ms.
  - `scopeVerdict`: exclude wins over a matching include; an empty include admits everything not excluded; the two reason strings exactly.
  - **Parity, the load-bearing test:** for a table of at least 30 (pattern, url) pairs, including `%`, `_`, `\` and `*` in the pattern and the URL, insert the URLs into a temp table and assert `select url from t where url like <patternToLike(p)> escape '\'` returns exactly the URLs `matchesPattern` accepts. Then `scopeRefusesSql` against `scopeVerdict` over the same rows with a two-pattern scope.
  - `patternFamilyError("https://typo.example/*", "https://ex.com/")` is a message naming the host; `https://www.ex.com/*` and `*/blog/*` are null.
- [ ] **Step 2: Run.** `npx vitest run test/crawl/url-scope.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(crawl): anchored wildcard scope patterns with an SQL LIKE twin (27c T2)`

### Task 3: Rules treat `excluded` as never requested

**Files:**
- Modify: every reader of `ROBOTS_BLOCKED` or of a `fetch_class` literal in `src/rules/` (`grep -rn "ROBOTS_BLOCKED\|fetch_class" src/rules`), and the "not crawled" rules named below
- Test: the existing test file of each rule changed (append), `test/rules/excluded-rows.test.ts` (new)

**Interfaces:**
- Consumes: `NEVER_REQUESTED` (T1); `scopeRefusesSql`, `CrawlScope` (T2).
- Produces: `storedScope(db: Db, crawlId: string): Promise<CrawlScope>` in `src/rules/query/crawl-evidence.ts`, reading `exclude`/`include` off `config_jsonb` (absent = empty lists; any other shape throws naming the crawl).

- [ ] **Step 1: Write the failing tests** in `excluded-rows.test.ts`, on a crawl built with the existing row helpers (`mkPage` and friends):
  - an `excluded` page row linked from an `ok` page is not reported by `links.broken-internal`, `links.to-server-error`, `links.orphan`, `canonical.non-200-target` or `hreflang.non-indexable-target` (point one canonical and one hreflang at it);
  - it is not counted in `redirect.volume`'s denominator, `render.coverage`'s `pagesCrawled`, or `site.health`'s pages;
  - **not crawled because fenced off:** with `config_jsonb.exclude = ["*/private/*"]`, a sitemap entry, a `rel=next` target and an hreflang alternate under `/private/` with no page row are not reported by `sitemap.uncrawled`, `pagination.next-target-uncrawled` or `hreflang.alternates-not-crawled`; the same three URLs outside the pattern still are.
- [ ] **Step 2: Run.** Expected: FAIL where a reader treats `excluded` as a fetched page.
- [ ] **Step 3: Implement.** For each reader: where it excludes `ROBOTS_BLOCKED` to mean "never requested", use `NEVER_REQUESTED`; where it compares a class literal, decide per rule and add a one-line comment saying why. The three "not crawled" rules add `and not ${scopeRefusesSql(…, scope)}`. Record each changed rule in the task report with the reason.
- [ ] **Step 4: Run** `npx vitest run test/rules` and `test/fixtures/harness.test.ts`. Expected: PASS, with no finding count on the fixture site changed (it has no `excluded` row yet).
- [ ] **Step 5: Commit.** `fix(rules): excluded rows are never-requested, and fenced-off URLs are not "uncrawled" (27c T3)`

### Task 4: Admission — scope, URL length, redirect cap, and the re-filter on resume

**Files:**
- Modify: `src/crawl/loop.ts` (`CrawlConfig`, `CRAWL_DEFAULTS`, `validateCrawlConfig`, `storableConfig`, `parseStoredConfig`, `enqueue`, `handleOne`, run start), `src/crawl/persist.ts` (`insertExcluded`), `src/crawl/url-policy.ts` (`UrlPolicyOpts.maxUrlLength`)
- Test: `test/crawl/scope-admission.test.ts` (new), `test/crawl/url-policy.test.ts` (append)

**Interfaces:**
- Consumes: T1 columns, `scopeVerdict`, `patternToLike` (T2).
- Produces:
  - `CrawlConfig` gains `exclude?: string[]`, `include?: string[]`, `maxRedirectHops?: number`, `maxUrlLength?: number`, all stored. `CRAWL_DEFAULTS.maxRedirectHops = 10`, `CRAWL_DEFAULTS.maxUrlLength = 2500`. `validateCrawlConfig` checks the ranges in Global Constraints.
  - `UrlPolicyOpts.maxUrlLength?: number`: `isUrlAllowed` refuses a longer URL with the existing `too_long (<n> characters; the limit is <limit>)` reason, `limit = min(maxUrlLength, INDEXED_URL_MAX)`. Every `isUrlAllowed` and `fetchPage` call the loop makes passes it.
  - `PageWriter.insertExcluded(rows: ReadonlyArray<{ item: PageWriterItem; reason: string }>): Promise<number>`, `insertRobotsBlocked`'s twin writing `fetch_class = 'excluded'`.
  - `refileOutOfScope(db: Db, crawlId: string, scope: CrawlScope, budget: number): Promise<{ refiled: number; dropped: number }>` in `src/crawl/loop.ts` (exported for the test).

- [ ] **Step 1: Write the failing tests** in `scope-admission.test.ts`, driving `runCrawl`/`resumeCrawl` over a small `node:http` fixture (the `test/crawl/loop.test.ts` pattern, `allowPrivate: true`, `perHostDelayMs: 0`):
  - with `exclude: ["*/b*"]`, a page linking `/a` and `/b1` gives an `ok` row for `/a` and an `excluded` row for `/b1` whose `fetch_reason` is `crawl scope: matches exclude pattern '*/b*'`, and the server log shows no request for `/b1`;
  - with `include: ["*/keep/*"]`, a link to `/other` is `excluded` with `crawl scope: matches no include pattern`, and the seed itself is admitted (validation of the seed is the API's, Task 8);
  - excluded and robots-blocked rows share `maxBlockedUrls`: with budget 2, one blocked and two excluded links give two rows and `excluded_dropped + robots_blocked_dropped = 1`; a fresh crawl stamps `excluded_dropped = 0`;
  - a URL robots.txt disallows AND an exclude pattern matches is `excluded` (scope is checked before robots);
  - **redirect cap:** a chain `/r/0 → /r/1 → … → /r/12 → /end` with `maxRedirectHops: 10` gives rows `/r/0`–`/r/10`, none for `/r/11`, and `/r/10`'s `fetch_reason` names `maxRedirectHops is 10`; with the default and a 3-hop chain, every hop and the target are rows;
  - **URL length:** with `maxUrlLength: 300`, a 400-character link is never requested and has no frontier row;
  - **re-filter on resume:** pause a crawl (the `test/crawl/control.test.ts` request helper) with `/x/1` and `/x/2` pending, set `config_jsonb.exclude = ["*/x/*"]`, resume: both become `excluded` rows before any lease, nothing under `/x/` is requested, and a `/x/0` fetched before the pause keeps its `ok` row.
  - `url-policy.test.ts` (append): `maxUrlLength: 300` refuses 301 characters with the `too_long` reason naming 300; absent keeps 2,500.
- [ ] **Step 2: Run.** `npx vitest run test/crawl/scope-admission.test.ts test/crawl/url-policy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `enqueue`, after `isUrlAllowed` and before robots: refused URLs go to a per-call `excluded` map when `recordsBlocked`, else are skipped (Deviation 8), and are recorded after the frontier insert by a `recordExcluded` that shares `recordRobotsBlocked`'s budget counter and reservation discipline, overflowing into `excluded_dropped`.
  - In `handleOne`, a redirect target is queued with `redirectHops: item.redirectHops + 1` only when that is `≤ config.maxRedirectHops`; otherwise the redirect row is written with the cap reason appended to `disallowedReason` (the `settledResult` path) and nothing is queued.
  - `refileOutOfScope`: one `INSERT INTO pages … SELECT … FROM frontier WHERE state = 'pending' AND <scope LIKE>` limited by the remaining budget, the rest counted, then one `DELETE FROM frontier` of the same predicate — in one transaction, before the first lease, on every start whose stored scope is non-empty.
- [ ] **Step 4: Run** the tests, `npx tsc --noEmit`, and `npx vitest run test/crawl`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(crawl): scope admission, excluded rows, the redirect cap and the resume re-filter (27c T4)`

### Task 5: Credentials on the wire — only to the site's own hosts

**Files:**
- Create: `src/crawl/credentials.ts`
- Modify: `src/crawl/loop.ts` (`CrawlConfig`, `storableConfig`, `parseStoredConfig`, the run's start check, `request_headers` evidence), `src/crawl/fetch-page.ts`, `src/crawl/discovery.ts`, `src/crawl/host-probe.ts`, `src/crawl/resources/fetch-resources.ts`, `src/crawl/recheck/recheck-server-errors.ts`, `src/crawl/render/run-render.ts`, `src/crawl/render/renderer.ts`, `src/crawl/versions.ts`
- Test: `test/crawl/credentials.test.ts` (new), `test/crawl/renderer.test.ts` (append), `test/crawl/versions.test.ts` (append)

**Interfaces:**
- Produces, in `src/crawl/credentials.ts`:
  - `interface CrawlCredentials { requestHeaders?: Readonly<Record<string, string>>; httpAuth?: { username: string; password: string }; cookies?: ReadonlyArray<{ name: string; value: string }> }`.
  - `interface CredentialShape { requestHeaderNames: string[]; httpAuth: boolean; cookieNames: string[] }` — what is stored.
  - `shapeOf(c: CrawlCredentials): CredentialShape | null` (null when nothing was supplied); `sameShape(a, b): boolean`.
  - `credentialHeadersFor(url: string, siteUrl: string, c: CrawlCredentials | undefined): Record<string, string>`: `{}` unless `isSameOrigin(url, siteUrl)`; else the custom headers, `authorization: Basic <base64(username:password)>`, and one `cookie: n1=v1; n2=v2`.
  - `credentialError(c: unknown, path: string): string | null`: the field rules in Global Constraints (header name an RFC 9110 token and not refused; value ≤ 1 KiB, no CR/LF/NUL; username without `:`; cookie name a token, value ≤ 1 KiB without `;`, `,`, whitespace or controls). The message names the field and the header or cookie NAME, never a value.
- `CrawlConfig` gains `credentials?: CrawlCredentials` (never stored: `storableConfig` strips it beside `allowPrivate`, and its docblock says so) and `credentialShape?: CredentialShape` (stored).
- The loop refuses to start a crawl whose `credentialShape` is set and whose `credentials` are absent or of another shape: it throws `CredentialsMissingError` (exported, names the crawl and the field names), before discovery.
- Every request builder named above takes `credentials?: { siteUrl: string; values: CrawlCredentials }` in its options and merges `credentialHeadersFor(<that request's own URL>, …)` into the headers of each request, including each manual redirect hop.
- `redactRequestHeaders(h, extraNames?: Iterable<string>)` redacts the custom names too; the crawl row's `request_headers` evidence passes the shape's header names.
- The renderer releases a same-family request with `Fetch.continueRequest({ requestId, headers })`, where `headers` is the paused request's own headers merged with `credentialHeadersFor`, as an array of `{name, value}`.

- [ ] **Step 1: Write the failing tests** in `credentials.test.ts`:
  - `credentialHeadersFor` on `https://www.ex.com/a` for site `https://ex.com/` returns the three kinds; on `https://cdn.other.com/a` returns `{}`;
  - `credentialError`: each refused header name (one test per name, plus `Proxy-Authorization`), a value with `\r\n`, 21 headers, 51 cookies, a username with `:`, and that no returned message contains the offending VALUE;
  - over a two-host fixture (`127.0.0.1` and `localhost`, the `listenByName` precedent): a crawl with all three kinds sends them on the page fetch, robots.txt, the sitemap and a same-host resource, and the `localhost` resource and a redirect hop to `localhost` arrive without any of them (assert on the server's recorded request headers);
  - `Set-Cookie` from page 1 is not sent on page 2;
  - `runCrawl` with `credentialShape` set and no `credentials` throws `CredentialsMissingError` and makes no request.
  - `renderer.test.ts` (append): a render of a same-origin page with a cookie and a header sends both on the document and on a same-origin script, and a third-party request is still blocked.
  - `versions.test.ts` (append): `redactRequestHeaders({ "x-tenant": "s3cret" }, ["X-Tenant"])` is `"[redacted]"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npx vitest run test/crawl`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(crawl): credentials go only to the site's own hosts, and are never stored (27c T5)`

### Task 6: List mode in the loop

**Files:**
- Modify: `src/crawl/loop.ts` (`CrawlConfig.mode`, run start, `handleOne`), `src/crawl/discovery.ts` (an option to walk no sitemap)
- Test: `test/crawl/list-mode.test.ts` (new)

**Interfaces:**
- Consumes: `listUrls` (T1), admission (T4).
- Produces:
  - `CrawlConfig.mode?: CrawlMode` (absent = `spider`, stored) and `export type CrawlMode = "spider" | "list"` from `src/crawl/loop.ts`.
  - `CrawlConfig.listUrlCount?: number`, stored, required when `mode` is `list` (`validateCrawlConfig`).
  - Discovery option `walkSitemaps: boolean` (default true). False walks no sitemap document and records the declared sources as declared.
  - `CrawlSummary.sitemapsRead: boolean`, also stored on `discovery_jsonb` as `sitemapsRead` (absent on older rows = true).

- [ ] **Step 1: Write the failing tests** in `list-mode.test.ts` (fixture server, the loop-test pattern):
  - a list of four URLs (one 200 linking `/unlisted`, one 404, one redirect to a 200, one robots-disallowed) with `maxPages: 8`: rows for all four (`ok`, `client_error`, `redirect`, `disallowed`) at depth 0 with `discovered_via = 'list'`, a row for the redirect target, no row and no request for `/unlisted`, the `links` row to `/unlisted` present;
  - `siteUrl` not in the list is not requested (robots.txt is);
  - without `sitemapUrls`, no sitemap document is requested and `sitemapsRead` is false; with `sitemapUrls`, the declared and supplied sitemaps are walked, `sitemap_urls` is filled, and no sitemap entry is queued;
  - `validateCrawlConfig` refuses `mode: "list"` without `listUrlCount`;
  - a list crawl paused after two fetches and resumed fetches the remaining listed URLs once each (no listed URL is fetched twice).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** At start, a list crawl reads `list_urls` by `position` in chunks of `ENQUEUE_LOOKUP_CHUNK` and calls `enqueue(chunk, 0, "list")` instead of the seed; `handleOne` follows no link in list mode (redirects still); discovery runs with `walkSitemaps: config.sitemapUrls !== undefined`, and the sitemap-entry enqueue is skipped.
- [ ] **Step 4: Run** the tests and `npx vitest run test/crawl`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(crawl): list mode fetches the listed URLs and follows no link (27c T6)`

### Task 7: The rules on a list crawl, and `crawl.list-mode`

**Files:**
- Modify: `src/rules/registry/types.ts` (`RuleMeta`), `src/rules/registry/registry.ts` (`RULESET_VERSION = "0.24.0"`), `src/rules/registry/triage.ts`, `src/rules/run.ts`, `src/rules/query/link-targets.ts`, the flagged rules' modules, `src/rules/registry/copy/issue-copy.ts`, `skills/ariadne-audit/checklist.md`
- Create: `src/rules/query/list-mode.ts`
- Test: `test/rules/list-mode.test.ts` (new), `test/rules/link-targets.test.ts` (append), `test/skills/identifier-guard.test.ts` (unchanged; must stay green)

**Interfaces:**
- Produces:
  - `RuleMeta.needsSpider?: true` and `RuleMeta.needsSitemaps?: true`, refused by `defineRule` on a marker rule.
  - **`needsSpider`:** `links.orphan`, `links.orphan-skipped`, `structure.deep-page`, `links.only-from-non-indexable`, `canonical.unlinked`, `hreflang.unlinked-target`, `pagination.next-not-linked`, `pagination.next-target-uncrawled`, `sitemap.uncrawled`, `pages.not-in-sitemap`, `schema.none-on-site`, `schema.breadcrumb-absent`, `inlinks.distribution`, `inlinks.extremes`, `inlinks.sources-by-type`, `structure.depth-distribution`, `structure.click-depth-distribution`.
  - **`needsSitemaps`:** `sitemap.invalid`, `sitemap.non-200`, `sitemap.redirected`, `sitemap.non-indexable`, `sitemap.over-50k-urls`, `sitemap.url-too-long`, `sitemap.oversized`, `sitemap.url-in-multiple`, `sitemap.cross-host-loc`, `sitemap.lastmod-invalid`, `robots.blocks-sitemap-urls`, `hreflang.source-conflict`, `sitemap.structure`.
  - A rule the implementer finds whose answer on a list crawl depends on the unfetched part of the site, and is not listed, is flagged too and named in the report; the reviewer checks each addition.
  - `crawl.list-mode`: a query rule, `severity: "info"`, `checkIds: ["CHECK-83"]`, `marker` set, triage `MARKER`, category matching `links.orphan-skipped`'s; one finding per list crawl, `pageId` null, evidence `{ notMeasured: string[] (sorted rule ids), sitemapsRead: boolean }`, columns `notMeasured`, `sitemapsRead`. It fires on nothing else.
  - `runRules` reads the crawl's `mode` and `discovery_jsonb.sitemapsRead` once; on a list crawl it does not run a `needsSpider` rule, nor a `needsSitemaps` rule when no sitemap was read, and it deletes nothing those rules wrote on an earlier run (there is none: a crawl's mode never changes).
  - `links.broken-internal` on a list crawl also reports a `client_error` row with `discovered_via = 'list'` and no inlink, with `inlinks: 0` and the optional column `listed: true` (Deviation 7).

- [ ] **Step 1: Write the failing tests** in `list-mode.test.ts`, on rows built with the helpers and `config_jsonb.mode = "list"`:
  - none of the `needsSpider` rules writes a finding or metric, and `crawl.list-mode`'s `notMeasured` lists exactly the flagged rules (both sets when `sitemapsRead` is false; `needsSpider` only when true);
  - a listed page with a duplicate title of another listed page is reported by `title.duplicate`;
  - on a spider crawl, `crawl.list-mode` writes nothing and every flagged rule runs;
  - `link-targets.test.ts` (append): a listed 404 with no inlink is reported on a list crawl and not on a spider crawl.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Bump the ruleset; add the triage row, the copy entry, the checklist lines (CHECK-83's NOT MEASURED family list, and the marker described in CHECK-83's entry); run `npx vitest run test/skills`.
- [ ] **Step 4: Run** `npx vitest run test/rules test/skills test/fixtures/harness.test.ts`. Expected: PASS; the harness's rule count is 189 and no fixture finding changes (the harness crawl is a spider crawl).
- [ ] **Step 5: Commit.** `feat(rules): list crawls skip site-wide rules, and crawl.list-mode says which (27c T7, ruleset 0.24.0)`

### Task 8: The API — new fields, validation and start

**Files:**
- Modify: `src/api/config-schema.ts`, `src/api/service.ts` (`StartCrawlInput`, `checkStartBody`, `startCrawl`, `effectiveConfig`, the credentials map), `src/api/http.ts` (body cap per route, error body `code`), `src/api/mcp.ts` (error body `code`), `src/api/errors.ts`
- Test: `test/api/config-schema.test.ts` (append), `test/api/scope-start.test.ts` (new), `test/api/transport-parity.test.ts` (append), `test/api/http.test.ts` (append)

**Interfaces:**
- Consumes: `credentialError`, `shapeOf` (T5); `patternFamilyError`, `scopeVerdict` (T2); `CrawlMode` (T6).
- Produces:
  - `CRAWL_FIELDS` gains `mode`, `urls`, `exclude`, `include`, `requestHeaders`, `httpAuth`, `cookies`, `maxRedirectHops`, `maxUrlLength`, with the mutability and defaults in Global Constraints; `onTheWire` publishes `x-ariadne-secret: true` for the three credential fields (a `CrawlField.secret?: true`).
  - `checkStartBody` adds, each as a `ConfigError` with its path:
    - `mode: "list"` requires `urls` (1 to `LIST_MAX_URLS`), and `urls` without `mode: "list"` is refused;
    - each listed URL normalises, passes url-policy (`url_policy`, FORBIDDEN) and `isSameOrigin` with `siteUrl` (`invalid`, naming the URL and saying lists that span sites are refused);
    - Deviations 4 and 5;
    - each pattern: length, count, `patternFamilyError`; the seed refused by the scope (`invalid`, naming the pattern);
    - `credentialError` for each credential field.
  - `effective` (and so `config_validate`) carries `mode`, `listUrlCount`, `listDuplicates`, the scope lists, the two limits and `credentialShape`; never `urls` and never a secret value.
  - `startCrawl` inserts the `crawls` row and the distinct listed URLs (`position` from 0, in list order) in one transaction, and keeps `credentials` in `ApiService.credentials: Map<string, CrawlCredentials>`; `runQueued` passes `credentials` from the map into the loop's config (the `processTrustConfig` precedent).
  - `ServiceError` bodies are `{ error, code }` on both transports; `STATUS_FOR.CREDENTIALS_REQUIRED = 409`.

- [ ] **Step 1: Write the failing tests.**
  - `config-schema.test.ts` (append): the published schema lists the nine fields with their `x-ariadne-mutable`, and exactly the three credential fields carry `x-ariadne-secret: true`.
  - `scope-start.test.ts`:
    - a list of 10,001 URLs is refused; a body of 1.5 MiB to `POST /crawls` gets 413 and one of 900 KiB with 10,000 URLs is accepted; `POST /crawls/:id/rules` with a 100 KiB body still gets 413;
    - a listed URL on another site, an excluded listed URL, an excluded seed, a pattern naming `typo.example`, and `maxPages` below the list are each refused with the path and the stated code;
    - a list with two spellings of one URL is accepted with `listUrlCount` 1 less than its length and `listDuplicates: 1`, and `list_urls` holds the distinct URLs in order;
    - **the secret never leaves:** a start with all three credential kinds, one of them invalid (a header value with `\n`), gives a refusal whose body contains no secret value; a valid one gives `crawl_status`, `config_validate`'s `effective`, `GET /crawls/:id/config` and the `crawls` row's `config_jsonb` none of which contain any secret value, and `config_jsonb.credentialShape` names the fields.
  - `transport-parity.test.ts` (append): the same list body is accepted by both transports with equal `effective`.
  - `http.test.ts` (append): a 409 body carries `code: "CONFLICT"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/api test/skills` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(api): list, scope, credential and limit fields on one schema; secrets kept in memory (27c T8)`

### Task 9: The API — config get/set, resume and render with credentials

**Files:**
- Modify: `src/api/service.ts` (`getCrawlConfig`, `setCrawlConfig`, `resumeCrawl`, `renderCrawl`, `cancelCrawl`, `deleteCrawl`), `src/api/http.ts`, `src/api/mcp.ts`
- Test: `test/api/lifecycle.test.ts` (append), `test/api/judgement-config.test.ts` (append), `test/api/credentials-restart.test.ts` (new)

**Interfaces:**
- Produces:
  - `crawl_config_get.crawl` shows `httpAuth: "[redacted]"`, `requestHeaders: { <name>: "[redacted]" }`, `cookies: [{ name, value: "[redacted]" }]` when supplied, `listUrlCount` for a list crawl, and `scopeChangedAt` (ISO or null).
  - `crawl_config_set` on a queued or paused crawl accepts `exclude`, `include` (stamping `scope_changed_at`), `maxRedirectHops`, and the three credential fields (replacing the map entry and the stored shape). A `whenPaused` key sent with its current value on a running crawl is accepted as no change, Ruling 12's rule extended (27b parked item). A `[redacted]` value sent back is "no change" for that field.
  - `crawl_resume` and `crawl_render` accept optional `requestHeaders`, `httpAuth`, `cookies` (HTTP body; MCP input), validated by `credentialError`. When the stored shape is set and the map has no entry (and none was sent), they refuse `CREDENTIALS_REQUIRED` naming the fields; credentials of another shape are `VALIDATION`.
  - `cancelCrawl` and `deleteCrawl` remove the map entry (Deviation 9).
  - `mcp.ts` `crawl_status` text says `neverFetched` is null for a crawl cancelled before it ran (27b parked item).

- [ ] **Step 1: Write the failing tests.**
  - `credentials-restart.test.ts`: start a crawl with `httpAuth` against a fixture area that answers 401 without it; pause it; close the `ApiService` and build a new one on the same database (the restart); `crawl_resume` without credentials is 409 `CREDENTIALS_REQUIRED` and the crawl writes no row; `crawl_render` likewise; `crawl_resume` with them runs to `finished` with no `client_error` row under the auth area.
  - `lifecycle.test.ts` (append): `exclude` set on a paused crawl stamps `scopeChangedAt` and the resumed run re-files (T4's behaviour, through the API); `exclude` on a running crawl is 409; `mode` and `urls` are `never`.
  - `judgement-config.test.ts` (append): the whole `crawl` object from `crawl_config_get` with `[redacted]` values sent back on a paused crawl, `maxPages` changed, is 200 and changes only `maxPages`; the same echo on a running crawl, `maxPages` unchanged, is 200.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/api` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(api): credentials re-supplied on resume and render; scope lists change while paused (27c T9)`

### Task 10: The fixture site and the end-to-end proofs

**Files:**
- Modify: `test/fixtures/app.ts` (new areas, NOT linked from the hub and not in any sitemap, so the harness's counts stay as they are)
- Test: `test/fixtures/scope-and-requests.test.ts` (new)

**Interfaces:**
- Produces: on the fixture server, `/auth/*` (Basic `ariadne:fixture`, else 401), `/cookie-gated` (200 with `session=ok`, else 403), `/header-gated` (200 with `x-fixture-key: k1`, else 403), `/chain/0` … `/chain/12` → `/chain/end` (301 each), and `/auth/to-legacy` (a 302 to the same path on `legacyBase`).

- [ ] **Step 1: Write the tests** (through the API, `crawlDefaults: { allowPrivate: true, perHostDelayMs: 0 }`):
  - **positive and negative per gate:** a list crawl of the three gated URLs with credentials gives three `ok` rows; without them, `client_error` rows (401/403);
  - **no crossing:** `/auth/to-legacy`'s target on `localhost` is requested without `authorization`, `cookie` or the custom header (server-side record);
  - **redirect cap:** a list crawl of `/chain/0` gives rows to `/chain/10` and the cap reason; with `maxRedirectHops: 20`, rows to `/chain/end`;
  - **list crawl of the fixture site:** list the hub's own links; every listed URL has a row, `crawl.list-mode` names the flagged rules, and no `needsSpider` rule has a finding;
  - **the secret scan:** after a crawl with all three credential kinds and a render pass, every `text`, `varchar` and `jsonb` column of every table in `CRAWL_CHILD_TABLES` plus `crawls` (enumerated from `information_schema`, not listed by hand) contains none of the secret values, and neither does the captured server log.
- [ ] **Step 2: Run.** `npx vitest run test/fixtures/scope-and-requests.test.ts test/fixtures/harness.test.ts`. Expected: PASS (the earlier tasks built the behaviour; a failure here is a defect to fix in its own task's code, with a test there).
- [ ] **Step 3: Commit.** `test(fixtures): gated areas, a 12-hop chain and the secret scan (27c T10)`

### Task 11: 27b carry-overs in code

**Files:**
- Modify: `src/crawl/politeness.ts` (`HostGate.restore`), `src/api/service.ts` (the `crawl_rules` "never ran" refusal, `renderCrawl` docblock), `scripts/gate-rules.ts` (sampler)
- Test: `test/crawl/politeness.test.ts` (append), `test/api/lifecycle.test.ts` (append)

- [ ] **Step 1: Write the failing tests.**
  - `politeness.test.ts`: a gate built with base 0 that escalated a host to spacing S, snapshotted and restored into a new gate with base 0, gives `spacingMs(host) >= S` (Ruling 9: a resume is never faster than the spacing it earned).
  - `lifecycle.test.ts`: `crawl_rules` on a legacy-shaped crawl (`discovery` null, pages present) is 409 with a message that does not claim the crawl never ran, and the never-ran message is unchanged for a crawl with no pages.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `restore` keeps the earned spacing when the stored base is 0 (the stored `spacingMs` is a floor for the restored host), without changing the restore of any non-zero base (the existing restore tests stay green).
  - The "never ran" wording becomes conditional on the page count.
  - The `renderCrawl` docblock says a crawl already rendering is refused 409 before a malformed `urls` list is refused 400 (claim first, 27b I3).
  - `gate-rules.ts`: when the run ends, the sampler takes one final status read before deciding the flip was never observed.
- [ ] **Step 4: Run** `npx vitest run test/crawl/politeness.test.ts test/api/lifecycle.test.ts` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** `fix: 27b carry-overs — restored zero-base spacing, never-ran wording, render refusal order, gate sampler (27c T11)`

### Task 12: Docs, skills and the gate

**Files:**
- Modify: `docs/talos-surface.md`, `docs/talos-integration.md`, `skills/ariadne-crawl/SKILL.md`, `skills/ariadne-audit/SKILL.md`, `docs/gates/phase-27b.md` (line 184), `scripts/gate-rules.ts` (`--exclude`)
- Create: `docs/gates/phase-27c.md`, `docs/gates/phase-27b-ruling4-inflight.patch` (copied from `.superpowers/parked/phase-27b-ruling4-inflight.patch`)

- [ ] **Step 1: Surface docs and skills.**
  - `talos-surface.md`: every new field, its mutability and secret marking; list mode and `crawl.list-mode`; the `excluded` class and `excludedDropped`; `CREDENTIALS_REQUIRED` and the error body's `code`; the 1 MiB routes; the 27b parked sentence near §2230 (rules' stale-override refusal now comes after the claim).
  - `talos-integration.md`: credentials are memory-only and re-supplied after a restart; Talos holds them.
  - `ariadne-crawl`: list mode, scope patterns, credentials and the restart rule. `ariadne-audit`: `crawl.list-mode` and reading `excluded` rows.
  - `docs/gates/phase-27b.md:184` points at `docs/gates/phase-27b-ruling4-inflight.patch`.
  - Run `npx vitest run test/skills`.
- [ ] **Step 2: The 50k gate with a scope.** Add `--exclude <pattern>` (repeatable) to `scripts/gate-rules.ts`, then run `node --max-old-space-size=512 --import tsx scripts/gate-rules.ts --exclude '*/p/1*'`. Pass: peak ≤ 512 MB and within 5% of 27b's 276.4 MB (≤ 290.2 MB); the excluded census equals the count of generated URLs the pattern matches, up to the budget, with the overflow in `excluded_dropped`.
- [ ] **Step 3: The live list crawl.** Ask the owner before crawling. With their OK, a list crawl of about 50 lavishalice URLs at the production pacing; review every finding for false positives and record the crawl id.
- [ ] **Step 4: Gate doc.** `docs/gates/phase-27c.md`: each Gate 27c clause with its evidence, the suite count (0 skipped), these Deviations and every ruling made during execution.
- [ ] **Step 5: Run** `npm test` and `npx tsc --noEmit`. Expected: all green, 0 skipped.
- [ ] **Step 6: Commit.** `docs(gate): Phase 27c — scope and requests gate, surface docs and skills (27c T12)`
